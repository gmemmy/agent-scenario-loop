#!/usr/bin/env node

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildAndroidNativePerformanceEvidence,
  buildIosNativePerformanceEvidence,
  parseIosMetricKitSummaryText,
  parseIosXctraceSummaryText,
} = require('agent-scenario-loop');

/**
 * Parses simple `--key value` CLI arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

/**
 * Reads a required string CLI argument.
 *
 * @param {Record<string, string | boolean>} args
 * @param {string} key
 * @returns {string}
 */
function requireStringArg(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${key} value.`);
  }
  return value;
}

function optionalStringArg(args, key, envKey) {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  const envValue = process.env[envKey];
  return typeof envValue === 'string' && envValue.length > 0 ? envValue : undefined;
}

function parsePositiveInteger(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStrictPositiveInteger(value, fallback, label) {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function toRunRelativePath(runDir, value) {
  const relativePath = path.relative(runDir, value);
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Native-performance provider output must remain inside --run-dir: ${value}`);
  }
  return toPortablePath(relativePath);
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const maxBufferBytes = 8 * 1024 * 1024;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let terminationRequested = false;
    let errorCode = null;
    let errorMessage = null;
    let forceKillTimer = null;
    let forceSettleTimer = null;
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function killChildTree(signal) {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child when the process group is already gone.
        }
      }
      child.kill(signal);
    }

    function finish(exitCode, signal) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
      }
      resolve({
        args,
        command,
        errorCode,
        errorMessage,
        exitCode: timedOut ? 124 : exitCode,
        signal,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut,
      });
    }

    function terminate() {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      killChildTree('SIGTERM');
      forceKillTimer = setTimeout(() => {
        killChildTree('SIGKILL');
        forceSettleTimer = setTimeout(() => {
          finish(timedOut ? 124 : 1, 'SIGKILL');
        }, 100);
        forceSettleTimer.unref();
      }, 1_000);
      forceKillTimer.unref();
    }

    function captureChunk(chunks, byteCount, chunk, streamName) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = Math.max(maxBufferBytes - byteCount, 0);
      if (remainingBytes > 0) {
        chunks.push(buffer.subarray(0, remainingBytes));
      }
      const nextByteCount = byteCount + buffer.length;
      if (nextByteCount > maxBufferBytes && !errorCode) {
        errorCode = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        errorMessage = `${streamName} exceeded the ${maxBufferBytes} byte provider command buffer.`;
        terminate();
      }
      return nextByteCount;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes = captureChunk(stdoutChunks, stdoutBytes, chunk, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = captureChunk(stderrChunks, stderrBytes, chunk, 'stderr');
    });
    child.on('error', (error) => {
      errorCode = error.code ?? 'UNKNOWN';
      errorMessage = error.message;
      finish(1, error.signal ?? null);
    });
    child.on('close', (exitCode, signal) => {
      const normalizedExitCode = typeof exitCode === 'number' ? exitCode : 1;
      finish(normalizedExitCode, signal);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
  });
}

function commandSucceeded(result) {
  return !result.timedOut && !result.errorCode && result.exitCode === 0;
}

function commandStatus(result) {
  if (result.timedOut) {
    return 'timeout';
  }
  if (!commandSucceeded(result)) {
    return 'failed';
  }
  return result.stdout.trim().length > 0 ? 'captured' : 'partial';
}

function writeTextArtifact(outPath, value) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, value, 'utf8');
}

function writeCommandArtifacts({ captureDir, id, result, runDir }) {
  const stdoutPath = path.join(captureDir, `${id}.stdout.txt`);
  const stderrPath = path.join(captureDir, `${id}.stderr.txt`);
  const recordPath = path.join(captureDir, `${id}.command.json`);
  writeTextArtifact(stdoutPath, result.stdout);
  writeTextArtifact(stderrPath, result.stderr);
  writeJsonArtifact(recordPath, {
    args: runDir
      ? result.args.map((arg) => normalizeCommandArgForEvidence(runDir, arg))
      : result.args,
    command: runDir ? path.basename(result.command) : result.command,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    exitCode: result.exitCode,
    signal: result.signal,
    status: commandStatus(result),
    stderrPath: path.basename(stderrPath),
    stdoutPath: path.basename(stdoutPath),
    timedOut: result.timedOut,
  });
  return { recordPath, stderrPath, stdoutPath };
}

function buildCapturedSource({ dataClasses, id, result, runDir, stdoutPath, toolName }) {
  const status = commandStatus(result);
  let reason;
  if (result.timedOut) {
    reason = 'The provider command exceeded its bounded timeout.';
  } else if (!commandSucceeded(result)) {
    reason = result.errorMessage
      ? `The provider command failed: ${result.errorMessage}`
      : `The provider command exited with status ${result.exitCode}.`;
  } else {
    reason = 'The provider command exited successfully but produced no stdout evidence.';
  }
  return {
    sourceId: id,
    status,
    tool: {
      name: toolName,
      command: ['adb', ...result.args].join(' '),
    },
    dataClasses,
    path: toRunRelativePath(runDir, stdoutPath),
    ...(status === 'captured'
      ? {}
      : {
          reason,
          nextAction: `Inspect the preserved command record and stderr, repair ${toolName}, then rerun the provider capture.`,
        }),
  };
}

async function captureAndroidAdbEvidence({ args, outPath, runId, scenarioId }) {
  const appId = optionalStringArg(args, 'app', 'ASL_ANDROID_APP_ID');
  const deviceId = optionalStringArg(args, 'device', 'ASL_ANDROID_SERIAL');
  if (!appId || !deviceId) {
    throw new Error('Android adb capture requires --app/ASL_ANDROID_APP_ID and --device/ASL_ANDROID_SERIAL.');
  }

  const adbPath = optionalStringArg(args, 'adb', 'ASL_ADB_PATH') ?? 'adb';
  const runDir = optionalStringArg(args, 'run-dir', 'ASL_RUN_DIR');
  if (!runDir) {
    throw new Error('Android adb capture requires --run-dir so evidence paths can remain durable and run-relative.');
  }
  toRunRelativePath(runDir, outPath);
  const timeoutMs = parsePositiveInteger(
    optionalStringArg(args, 'command-timeout-ms', 'ASL_NATIVE_PERFORMANCE_COMMAND_TIMEOUT_MS'),
    10_000,
  );
  const captureDir = path.join(path.dirname(outPath), 'android-adb');
  fs.mkdirSync(captureDir, { recursive: true });

  const definitions = [
    { id: 'target-serial', args: ['-s', deviceId, 'get-serialno'] },
    { id: 'target-package', args: ['-s', deviceId, 'shell', 'pm', 'path', appId] },
    { id: 'gfxinfo', args: ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', appId] },
    { id: 'framestats', args: ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', appId, 'framestats'] },
    { id: 'meminfo', args: ['-s', deviceId, 'shell', 'dumpsys', 'meminfo', appId] },
  ];
  const captures = new Map();
  for (const definition of definitions) {
    const result = await runCommand(adbPath, definition.args, timeoutMs);
    captures.set(definition.id, {
      result,
      paths: writeCommandArtifacts({ captureDir, id: definition.id, result, runDir }),
    });
  }

  const serialCapture = captures.get('target-serial');
  const packageCapture = captures.get('target-package');
  const observedDeviceId = commandSucceeded(serialCapture.result) ? serialCapture.result.stdout.trim() : '';
  const serialMatches = observedDeviceId === deviceId;
  const packageMatches = commandSucceeded(packageCapture.result) && packageCapture.result.stdout.split(/\r?\n/u).some((line) => line.startsWith('package:'));
  let targetProofStatus = 'unverified';
  if (serialMatches && packageMatches) {
    targetProofStatus = 'verified';
  } else if (observedDeviceId && observedDeviceId !== deviceId) {
    targetProofStatus = 'mismatch';
  }
  const targetProofPath = path.join(captureDir, 'target-binding.json');
  writeJsonArtifact(targetProofPath, {
    appId,
    capturedAt: new Date().toISOString(),
    deviceId,
    packageCommand: packageCapture.result.args,
    packageMatched: packageMatches,
    observedDeviceId: observedDeviceId || null,
    platform: 'android',
    serialCommand: serialCapture.result.args,
    serialMatched: serialMatches,
    sourceCommands: ['gfxinfo', 'framestats', 'meminfo'].map((sourceId) => ({
      args: captures.get(sourceId).result.args,
      exitCode: captures.get(sourceId).result.exitCode,
      sourceId,
      status: commandStatus(captures.get(sourceId).result),
    })),
    status: targetProofStatus,
  });
  const targetEvidencePath = toRunRelativePath(runDir, targetProofPath);

  const sourceDefinitions = [
    { id: 'gfxinfo', dataClasses: ['frames', 'jank', 'render'], toolName: 'adb dumpsys gfxinfo' },
    { id: 'framestats', dataClasses: ['frames', 'jank'], toolName: 'adb dumpsys gfxinfo framestats' },
    { id: 'meminfo', dataClasses: ['memory'], toolName: 'adb dumpsys meminfo' },
  ];
  const diagnosticSources = sourceDefinitions.map((definition) => {
    const capture = captures.get(definition.id);
    return buildCapturedSource({
      ...definition,
      result: capture.result,
      runDir,
      stdoutPath: capture.paths.stdoutPath,
    });
  });
  const sourceCapture = Object.fromEntries(sourceDefinitions.map(({ id }) => [id, captures.get(id)]));
  const commandFailed = Array.from(captures.values()).some(({ result }) => !commandSucceeded(result));
  const sourceOutputMissing = sourceDefinitions.some(({ id }) => captures.get(id).result.stdout.trim().length === 0);
  const captureFailed = commandFailed || sourceOutputMissing || !serialMatches || !packageMatches;
  const attachments = sourceDefinitions.map(({ id }) => {
    const stdoutPath = sourceCapture[id].paths.stdoutPath;
    return {
      kind: `raw-${id}`,
      path: toRunRelativePath(runDir, stdoutPath),
      sizeBytes: fs.statSync(stdoutPath).size,
    };
  });
  attachments.push({
    kind: 'android-target-binding',
    path: targetEvidencePath,
    sizeBytes: fs.statSync(targetProofPath).size,
  });

  let targetBinding;
  if (serialMatches && packageMatches) {
    targetBinding = {
      status: 'verified',
      appId,
      deviceId,
      source: 'provider adb target verification',
      candidateTargets: [{
        appId,
        bindingStatus: 'observed',
        deviceId,
        evidencePath: targetEvidencePath,
        platform: 'android',
        source: 'adb get-serialno and package-scoped command verification',
      }],
    };
  } else if (observedDeviceId && observedDeviceId !== deviceId) {
    targetBinding = {
      status: 'mismatch',
      appId,
      deviceId,
      source: 'provider adb target verification',
      reason: `adb observed device ${observedDeviceId}, but the provider requested ${deviceId}.`,
      candidateTargets: [
        {
          appId,
          bindingStatus: 'expected',
          deviceId,
          evidencePath: targetEvidencePath,
          platform: 'android',
          source: 'provider request',
        },
        {
          ...(packageMatches ? { appId } : {}),
          bindingStatus: 'observed',
          deviceId: observedDeviceId,
          evidencePath: targetEvidencePath,
          platform: 'android',
          source: 'adb get-serialno',
        },
      ],
    };
  } else {
    targetBinding = {
      status: 'unverified',
      appId,
      deviceId,
      source: 'provider adb target verification',
      reason: 'The provider could not verify both the requested adb serial and installed package.',
    };
  }

  const evidence = buildAndroidNativePerformanceEvidence({
    appId,
    attachments,
    capturedAt: new Date().toISOString(),
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Comparable Android native-performance measurement.',
      reason: 'The provider captured after-capture diagnostics without a bounded native measurement window.',
      supportingEvidence: diagnosticSources.filter((source) => source.status === 'captured').map((source) => source.sourceId),
      missingEvidence: ['bounded native measurement window', 'comparable baseline'],
      nextAction: 'Add provider-owned start/stop window capture before using these diagnostics for comparison.',
    },
    comparability: {
      status: 'diagnostic-only',
      reason: 'After-capture adb summaries are not bound to a provider-owned start/stop measurement window.',
      policy: 'Use this evidence for diagnosis only; do not select it as a comparison baseline.',
    },
    completenessStatus: 'partial',
    deviceId,
    diagnosticSources,
    framestatsText: commandSucceeded(sourceCapture.framestats.result) ? sourceCapture.framestats.result.stdout : undefined,
    gfxinfoText: commandSucceeded(sourceCapture.gfxinfo.result) ? sourceCapture.gfxinfo.result.stdout : undefined,
    meminfoText: commandSucceeded(sourceCapture.meminfo.result) ? sourceCapture.meminfo.result.stdout : undefined,
    providerId: 'example-evidence-provider',
    runId,
    scenarioId,
    targetBinding,
  });
  writeJsonArtifact(outPath, evidence);
  if (captureFailed) {
    process.exitCode = 1;
  }
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && typeof match[1] === 'string' && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}

function parseDurationMs(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const isoMatch = /^PT([\d.]+)S$/iu.exec(trimmed);
  if (isoMatch) {
    const seconds = Number.parseFloat(isoMatch[1]);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const durationMatch = /^([\d.]+)\s*(ms|s|sec|secs|seconds?)?$/iu.exec(trimmed);
  if (!durationMatch) {
    return undefined;
  }
  const numeric = Number.parseFloat(durationMatch[1]);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  const unit = durationMatch[2]?.toLowerCase() ?? 'ms';
  if (unit === 'ms') {
    return Math.round(numeric);
  }
  return Math.round(numeric * 1000);
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsedMs = Date.parse(value.trim());
  if (!Number.isFinite(parsedMs)) {
    return undefined;
  }
  return new Date(parsedMs).toISOString();
}

function parseXctraceTocSummary(tocText) {
  const startAt = parseIsoTimestamp(firstMatch(tocText, [
    /<start[-_ ](?:date|time)?[^>]*>([^<]+)<\/start[-_ ](?:date|time)?>/iu,
    /\bstart(?:Date|Time)?\s*=\s*"([^"]+)"/iu,
  ]));
  const endAt = parseIsoTimestamp(firstMatch(tocText, [
    /<end[-_ ](?:date|time)?[^>]*>([^<]+)<\/end[-_ ](?:date|time)?>/iu,
    /\bend(?:Date|Time)?\s*=\s*"([^"]+)"/iu,
  ]));
  const durationElement = firstMatch(tocText, [/<duration[^>]*>([^<]+)<\/duration>/iu]);
  const durationFromElement = durationElement ? parseDurationMs(`${durationElement}s`) : undefined;
  const durationFromAttribute = parseDurationMs(firstMatch(tocText, [
    /\bdurationMs\s*=\s*"([^"]+)"/iu,
    /<trace-window[^>]*\bduration\s*=\s*"([^"]+)"/iu,
  ]));
  const startMs = startAt ? Date.parse(startAt) : undefined;
  const endMs = endAt ? Date.parse(endAt) : undefined;
  let durationMs = durationFromElement ?? durationFromAttribute;
  if (durationMs === undefined && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    durationMs = Math.round(endMs - startMs);
  }

  const processPid = Number.parseInt(firstMatch(tocText, [
    /<(?:target-process|process)[^>]*\bpid\s*=\s*"(\d+)"/iu,
    /\bprocessPid\s*=\s*"(\d+)"/iu,
    /<pid[^>]*>(\d+)<\/pid>/iu,
  ]) ?? '', 10);
  const parsedPid = Number.isSafeInteger(processPid) && processPid > 0 ? processPid : undefined;

  return {
    startAt,
    endAt,
    durationMs,
    windowStartMs: durationMs !== undefined ? 0 : undefined,
    windowEndMs: durationMs,
    toolVersion: firstMatch(tocText, [
      /<instruments-version[^>]*>([^<]+)<\/instruments-version>/iu,
      /<(?:instruments|tool)[^>]*\bversion\s*=\s*"([^"]+)"/iu,
      /\btoolVersion\s*=\s*"([^"]+)"/iu,
    ]),
    template: firstMatch(tocText, [
      /<template-name[^>]*>([^<]+)<\/template-name>/iu,
      /<(?:trace-template|template)[^>]*\bname\s*=\s*"([^"]+)"/iu,
      /\btemplate(?:Name)?\s*=\s*"([^"]+)"/iu,
    ]),
    endReason: firstMatch(tocText, [
      /<(?:trace-window|recording)[^>]*\bend(?:-reason|Reason)\s*=\s*"([^"]+)"/iu,
      /<end-reason[^>]*>([^<]+)<\/end-reason>/iu,
    ]),
    deviceId: firstMatch(tocText, [
      /<(?:target-device|device)[^>]*\b(?:udid|uuid|identifier|device-id)\s*=\s*"([^"]+)"/iu,
      /\bdevice(?:Udid|Id|Identifier)\s*=\s*"([^"]+)"/iu,
    ]),
    devicePlatform: firstMatch(tocText, [
      /<(?:target-device|device)[^>]*\bplatform\s*=\s*"([^"]+)"/iu,
      /\bdevicePlatform\s*=\s*"([^"]+)"/iu,
    ]),
    processPid: parsedPid,
    processName: firstMatch(tocText, [
      /<(?:target-process|process)[^>]*\bname\s*=\s*"([^"]+)"/iu,
      /\bprocessName\s*=\s*"([^"]+)"/iu,
    ]),
  };
}

function readBootedDeviceObservation(devicesJsonText, requestedDeviceId) {
  try {
    const parsed = JSON.parse(devicesJsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed' };
    }
    const runtimes = parsed.devices;
    if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) {
      return { status: 'failed' };
    }
    for (const [runtime, devices] of Object.entries(runtimes)) {
      if (!Array.isArray(devices)) {
        continue;
      }
      for (const entry of devices) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        if (entry.udid === requestedDeviceId) {
          return {
            status: 'observed',
            matchesRequestedDevice: entry.state === 'Booted',
            state: typeof entry.state === 'string' ? entry.state : null,
            name: typeof entry.name === 'string' ? entry.name : null,
            runtime,
          };
        }
      }
    }
  } catch {
    return { status: 'failed' };
  }
  return { status: 'missing' };
}

function readLaunchctlProcessObservation(launchctlText, bundleId) {
  for (const line of launchctlText.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 3) {
      continue;
    }
    const label = tokens[tokens.length - 1];
    const labelMatchesBundle = label === bundleId || label.includes(`:${bundleId}[`);
    if (!labelMatchesBundle) {
      continue;
    }
    const pid = Number.parseInt(tokens[0], 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      return { status: 'observed', pid, label };
    }
  }
  return { status: 'missing' };
}

function buildTraceBundleInventory(traceBundlePath) {
  if (!fs.existsSync(traceBundlePath)) {
    return {
      exists: false,
      files: [],
      kind: 'xctrace-trace-bundle-inventory',
      traceBundle: path.basename(traceBundlePath),
      fileCount: 0,
      totalSizeBytes: 0,
    };
  }
  if (!fs.statSync(traceBundlePath).isDirectory()) {
    return {
      exists: true,
      files: [],
      kind: 'xctrace-trace-bundle-inventory',
      traceBundle: path.basename(traceBundlePath),
      fileCount: 0,
      totalSizeBytes: 0,
      reason: 'Expected a directory-backed .trace bundle.',
    };
  }

  const files = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDir = pending.pop();
    const absoluteDir = path.join(traceBundlePath, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      const absolutePath = path.join(traceBundlePath, relativePath);
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        path: toPortablePath(relativePath),
        sizeBytes: fs.statSync(absolutePath).size,
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const totalSizeBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    exists: true,
    files,
    kind: 'xctrace-trace-bundle-inventory',
    traceBundle: path.basename(traceBundlePath),
    fileCount: files.length,
    totalSizeBytes,
  };
}

function normalizeCommandArgForEvidence(runDir, arg) {
  if (!path.isAbsolute(arg)) {
    return arg;
  }
  try {
    return toRunRelativePath(runDir, arg);
  } catch {
    return path.basename(arg);
  }
}

function buildIosDiagnosticSource({ commandResults, dataClasses, path: sourcePath, reason, runDir, sourceId, status, toolName }) {
  const command = commandResults
    .map((result) => [
      path.basename(result.command),
      ...result.args.map((arg) => normalizeCommandArgForEvidence(runDir, arg)),
    ].join(' '))
    .join(' / ');
  return {
    sourceId,
    status,
    tool: {
      name: toolName,
      command,
    },
    dataClasses,
    ...(sourcePath
      ? { path: toRunRelativePath(runDir, sourcePath) }
      : {}),
    ...(status === 'captured'
      ? {}
      : {
          reason,
          nextAction: 'Inspect provider command records, repair simctl/xctrace capture, and rerun the provider.',
        }),
  };
}

function combinedCommandStatus(results, evidenceValid) {
  if (results.some((result) => result.timedOut)) {
    return 'timeout';
  }
  if (results.some((result) => !commandSucceeded(result))) {
    return 'failed';
  }
  return evidenceValid ? 'captured' : 'partial';
}

async function captureIosXctraceEvidence({ args, outPath, runId, scenarioId }) {
  const bundleId = optionalStringArg(args, 'bundle', 'ASL_IOS_APP_ID');
  const deviceId = optionalStringArg(args, 'device', 'ASL_IOS_UDID');
  if (!bundleId || !deviceId) {
    throw new Error('iOS xctrace capture requires --bundle/ASL_IOS_APP_ID and --device/ASL_IOS_UDID.');
  }

  const runDir = optionalStringArg(args, 'run-dir', 'ASL_RUN_DIR');
  if (!runDir) {
    throw new Error('iOS xctrace capture requires --run-dir so evidence paths can remain durable and run-relative.');
  }
  toRunRelativePath(runDir, outPath);
  const xcrunPath = optionalStringArg(args, 'xcrun', 'ASL_XCRUN_PATH') ?? 'xcrun';
  const captureDurationSeconds = parseStrictPositiveInteger(
    optionalStringArg(args, 'ios-capture-duration-seconds', 'ASL_NATIVE_PERFORMANCE_IOS_CAPTURE_DURATION_SECONDS'),
    10,
    '--ios-capture-duration-seconds/ASL_NATIVE_PERFORMANCE_IOS_CAPTURE_DURATION_SECONDS',
  );
  const timeoutValue = optionalStringArg(args, 'ios-command-timeout-ms', 'ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS');
  const timeoutMs = parseStrictPositiveInteger(
    timeoutValue,
    (captureDurationSeconds * 1_000) + 30_000,
    '--ios-command-timeout-ms/ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS',
  );
  const xctraceTemplate = optionalStringArg(args, 'ios-xctrace-template', 'ASL_NATIVE_PERFORMANCE_IOS_XCTRACE_TEMPLATE') ?? 'Time Profiler';
  const captureDir = path.join(path.dirname(outPath), 'ios-xctrace');
  fs.mkdirSync(captureDir, { recursive: true });
  const traceBundlePath = path.join(captureDir, 'capture.trace');

  const captures = new Map();
  const preflightDefinitions = [
    { id: 'simctl-list-devices', args: ['simctl', 'list', 'devices', '--json'] },
    { id: 'simctl-get-app-container', args: ['simctl', 'get_app_container', deviceId, bundleId, 'app'] },
    { id: 'simctl-launchctl-list', args: ['simctl', 'spawn', deviceId, 'launchctl', 'list'] },
  ];
  for (const definition of preflightDefinitions) {
    const result = await runCommand(xcrunPath, definition.args, timeoutMs);
    captures.set(definition.id, {
      result,
      paths: writeCommandArtifacts({ captureDir, id: definition.id, result, runDir }),
    });
  }

  const bootedDeviceCapture = captures.get('simctl-list-devices').result;
  const appContainerCapture = captures.get('simctl-get-app-container').result;
  const launchctlCapture = captures.get('simctl-launchctl-list').result;
  const bootedDeviceObservation = commandSucceeded(bootedDeviceCapture)
    ? readBootedDeviceObservation(bootedDeviceCapture.stdout, deviceId)
    : { status: 'failed' };
  const appContainerAvailable = commandSucceeded(appContainerCapture) && appContainerCapture.stdout.trim().length > 0;
  const launchctlProcess = commandSucceeded(launchctlCapture)
    ? readLaunchctlProcessObservation(launchctlCapture.stdout, bundleId)
    : { status: 'failed' };
  const requestedPid = launchctlProcess.status === 'observed' ? launchctlProcess.pid : 0;

  const recordArgs = [
    'xctrace',
    'record',
    '--template',
    xctraceTemplate,
    '--device',
    deviceId,
    '--attach',
    String(requestedPid),
    '--time-limit',
    `${captureDurationSeconds}s`,
    '--output',
    traceBundlePath,
    '--no-prompt',
  ];
  const recordResult = await runCommand(xcrunPath, recordArgs, timeoutMs);
  captures.set('xctrace-record', {
    result: recordResult,
    paths: writeCommandArtifacts({ captureDir, id: 'xctrace-record', result: recordResult, runDir }),
  });

  const exportArgs = ['xctrace', 'export', '--input', traceBundlePath, '--toc'];
  const exportResult = await runCommand(xcrunPath, exportArgs, timeoutMs);
  captures.set('xctrace-export-toc', {
    result: exportResult,
    paths: writeCommandArtifacts({ captureDir, id: 'xctrace-export-toc', result: exportResult, runDir }),
  });

  const tocPath = path.join(captureDir, 'xctrace-toc.xml');
  writeTextArtifact(tocPath, exportResult.stdout);
  const traceInventoryPath = path.join(captureDir, 'trace-bundle-inventory.json');
  const traceInventory = {
    ...buildTraceBundleInventory(traceBundlePath),
    traceBundlePath: toRunRelativePath(runDir, traceBundlePath),
  };
  writeJsonArtifact(traceInventoryPath, traceInventory);

  const tocSummary = commandSucceeded(exportResult) && exportResult.stdout.trim().length > 0
    ? parseXctraceTocSummary(exportResult.stdout)
    : {};
  const tocVerified = Boolean(
    tocSummary.startAt
      && tocSummary.endAt
      && tocSummary.durationMs !== undefined
      && tocSummary.template
      && tocSummary.toolVersion
      && tocSummary.endReason
      && tocSummary.deviceId
      && tocSummary.processPid !== undefined
      && tocSummary.processName,
  );
  const startMs = tocSummary.startAt ? Date.parse(tocSummary.startAt) : Number.NaN;
  const endMs = tocSummary.endAt ? Date.parse(tocSummary.endAt) : Number.NaN;
  const elapsedMs = endMs - startMs;
  const durationToleranceMs = Math.max(1, elapsedMs * 0.01);
  const requestedDurationMs = captureDurationSeconds * 1_000;
  const captureLimitToleranceMs = Math.max(2_000, requestedDurationMs * 0.1);
  const windowVerified = tocVerified
    && Number.isFinite(elapsedMs)
    && elapsedMs > 0
    && tocSummary.durationMs > 0
    && tocSummary.durationMs <= requestedDurationMs + captureLimitToleranceMs
    && Math.abs(tocSummary.durationMs - elapsedMs) <= durationToleranceMs;
  const observedDeviceId = typeof tocSummary.deviceId === 'string' ? tocSummary.deviceId : null;
  const observedPid = Number.isSafeInteger(tocSummary.processPid) ? tocSummary.processPid : null;
  const observedProcessName = typeof tocSummary.processName === 'string' ? tocSummary.processName : null;
  const recordedSimulator = typeof tocSummary.devicePlatform === 'string' && /simulator/iu.test(tocSummary.devicePlatform);
  const deviceMismatch = observedDeviceId && observedDeviceId !== deviceId;
  const pidMismatch = launchctlProcess.status === 'observed'
    && observedPid !== null
    && observedPid !== requestedPid;

  let targetStatus = 'unverified';
  if (
    commandSucceeded(recordResult)
    && commandSucceeded(exportResult)
    && bootedDeviceObservation.status === 'observed'
    && bootedDeviceObservation.matchesRequestedDevice === true
    && appContainerAvailable
    && launchctlProcess.status === 'observed'
    && windowVerified
    && recordedSimulator
    && !deviceMismatch
    && !pidMismatch
  ) {
    targetStatus = 'verified';
  } else if (deviceMismatch || pidMismatch) {
    targetStatus = 'mismatch';
  }

  const targetProofPath = path.join(captureDir, 'target-binding.json');
  writeJsonArtifact(targetProofPath, {
    appId: bundleId,
    bundleId,
    capturedAt: new Date().toISOString(),
    requestedDeviceId: deviceId,
    requestedPid,
    observedDevice: bootedDeviceObservation,
    observedAppContainerName: appContainerAvailable ? path.basename(appContainerCapture.stdout.trim()) : null,
    observedLaunchctlProcess: launchctlProcess,
    recordedDeviceId: observedDeviceId,
    recordedDevicePlatform: tocSummary.devicePlatform ?? null,
    recordedProcessName: observedProcessName,
    recordedProcessPid: observedPid,
    status: targetStatus,
    template: tocSummary.template ?? null,
    toolVersion: tocSummary.toolVersion ?? null,
    endReason: tocSummary.endReason ?? null,
    sourceCommands: [
      'simctl-list-devices',
      'simctl-get-app-container',
      'simctl-launchctl-list',
      'xctrace-record',
      'xctrace-export-toc',
    ].map((sourceId) => ({
      sourceId,
      args: captures.get(sourceId).result.args.map((arg) => normalizeCommandArgForEvidence(runDir, arg)),
      exitCode: captures.get(sourceId).result.exitCode,
      status: commandStatus(captures.get(sourceId).result),
    })),
    tocVerified,
    windowVerified,
    traceBundleObserved: traceInventory.exists && traceInventory.fileCount > 0,
  });

  const attachmentEntries = [
    { kind: 'xctrace-export', path: tocPath },
    { kind: 'ios-target-binding', path: targetProofPath },
    { kind: 'xctrace-trace-bundle-inventory', path: traceInventoryPath },
  ];
  const attachments = attachmentEntries.map((entry) => ({
    kind: entry.kind,
    path: toRunRelativePath(runDir, entry.path),
    sizeBytes: fs.statSync(entry.path).size,
  }));

  const xctraceCaptured = commandSucceeded(recordResult)
    && commandSucceeded(exportResult)
    && windowVerified
    && recordedSimulator
    && traceInventory.exists
    && traceInventory.fileCount > 0;
  const simctlCaptured = commandSucceeded(bootedDeviceCapture)
    && commandSucceeded(appContainerCapture)
    && commandSucceeded(launchctlCapture)
    && bootedDeviceObservation.status === 'observed'
    && bootedDeviceObservation.matchesRequestedDevice === true
    && appContainerAvailable
    && launchctlProcess.status === 'observed';

  const diagnosticSources = [
    buildIosDiagnosticSource({
      commandResults: [recordResult, exportResult],
      dataClasses: ['cpu', 'thread-scheduling', 'native-trace'],
      path: tocPath,
      reason: tocVerified
        ? 'The provider captured xctrace output but did not verify full target/window binding.'
        : 'The provider could not verify bounded xctrace TOC facts for target/window evidence.',
      runDir,
      sourceId: 'xctrace',
      status: combinedCommandStatus([recordResult, exportResult], xctraceCaptured),
      toolName: 'xctrace',
    }),
    buildIosDiagnosticSource({
      commandResults: [bootedDeviceCapture, appContainerCapture, launchctlCapture],
      dataClasses: ['unknown'],
      path: targetProofPath,
      reason: 'The provider could not verify the requested simulator, installed app container, and launchctl process binding.',
      runDir,
      sourceId: 'simctl',
      status: combinedCommandStatus([bootedDeviceCapture, appContainerCapture, launchctlCapture], simctlCaptured),
      toolName: 'xcrun simctl',
    }),
  ];

  let targetBinding;
  const targetEvidencePath = toRunRelativePath(runDir, targetProofPath);
  if (targetStatus === 'verified') {
    targetBinding = {
      status: 'verified',
      appId: bundleId,
      deviceId,
      source: 'provider simctl/xctrace target verification',
      candidateTargets: [{
        appId: bundleId,
        bindingStatus: 'observed',
        deviceId,
        evidencePath: targetEvidencePath,
        platform: 'ios',
        source: 'simctl launchctl list plus xctrace TOC verification',
      }],
    };
  } else if (targetStatus === 'mismatch') {
    targetBinding = {
      status: 'mismatch',
      appId: bundleId,
      deviceId,
      source: 'provider simctl/xctrace target verification',
      reason: 'xctrace recorded a device or pid that does not match the requested simulator launchctl target.',
      candidateTargets: [
        {
          appId: bundleId,
          bindingStatus: 'expected',
          deviceId,
          evidencePath: targetEvidencePath,
          platform: 'ios',
          source: 'provider request',
        },
        {
          bindingStatus: 'observed',
          ...(observedDeviceId ? { deviceId: observedDeviceId } : {}),
          evidencePath: targetEvidencePath,
          platform: 'ios',
          source: 'xctrace TOC',
        },
      ],
    };
  } else {
    targetBinding = {
      status: 'unverified',
      appId: bundleId,
      deviceId,
      source: 'provider simctl/xctrace target verification',
      reason: 'The provider could not verify all requested simulator/app/process/xctrace binding surfaces.',
    };
  }

  const allCommandsSucceeded = Array.from(captures.values()).every(({ result }) => commandSucceeded(result));
  const captureSucceeded = allCommandsSucceeded && xctraceCaptured && simctlCaptured && targetStatus === 'verified';
  const evidence = buildIosNativePerformanceEvidence({
    appId: bundleId,
    attachments,
    bundleId,
    captureMode: 'session',
    capturedAt: tocSummary.startAt ?? new Date().toISOString(),
    claimSufficiency: captureSucceeded
      ? {
          status: 'sufficient-for-diagnosis',
          claim: 'iOS simulator native-performance diagnosis from bounded xctrace capture.',
          reason: 'The provider verified simulator/app/process/window ownership but did not export structured comparison metrics.',
          supportingEvidence: ['xctrace', 'simctl', 'targetBinding'],
          missingEvidence: ['structured performance sample suitable for comparison baselines'],
          nextAction: 'Export structured xctrace performance samples before making comparison or release claims.',
        }
      : {
          status: 'insufficient-for-claim',
          claim: 'iOS simulator native-performance diagnosis from bounded xctrace capture.',
          reason: 'One or more bounded simctl/xctrace capture, export, or binding verification steps failed or remained unverified.',
          supportingEvidence: ['xctrace-toc', 'target-binding'],
          missingEvidence: ['verified simulator/app/process binding', 'verified bounded xctrace TOC metadata'],
          nextAction: 'Repair the failed step, rerun capture, and inspect preserved command records and raw outputs.',
        },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Trace-window metadata and target proof alone do not provide structured comparable native-performance samples.',
      policy: 'Use this capture for diagnosis and target/window trust checks, not baseline comparison selection.',
    },
    completenessStatus: captureSucceeded ? 'complete' : 'partial',
    deviceId,
    diagnosticSources,
    lifecycle: xctraceCaptured
      ? {
          durationMs: tocSummary.durationMs,
          endedAt: tocSummary.endAt,
          perturbsTiming: true,
          phase: 'afterCapture',
          startedAt: tocSummary.startAt,
        }
      : {
          perturbsTiming: true,
          phase: 'afterCapture',
        },
    providerId: 'example-evidence-provider',
    runId,
    scenarioId,
    targetBinding,
    xctraceSummary: xctraceCaptured
      ? {
          durationMs: tocSummary.durationMs,
          traceId: `${runId}-xctrace`,
          windowEndMs: tocSummary.windowEndMs,
          windowStartMs: tocSummary.windowStartMs,
        }
      : undefined,
  });
  writeJsonArtifact(outPath, evidence);
  if (!captureSucceeded) {
    process.exitCode = 1;
  }
}

/**
 * Writes a formatted JSON artifact.
 *
 * @param {string} outPath
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function writeJsonArtifact(outPath, payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Returns the schema platform value used by scaffold evidence.
 *
 * @param {string} platform
 * @returns {'android' | 'ios' | 'unknown'}
 */
function normalizePlatform(platform) {
  if (platform === 'android' || platform === 'ios') {
    return platform;
  }
  return 'unknown';
}

/**
 * Builds a source inventory entry for a platform-native diagnostic lane.
 *
 * @param {string} sourceId
 * @param {string} toolName
 * @param {string[]} dataClasses
 * @param {string} nextAction
 * @returns {Record<string, unknown>}
 */
function buildUnverifiedSource(sourceId, toolName, dataClasses, nextAction) {
  return {
    sourceId,
    status: 'unverified',
    tool: {
      name: toolName,
    },
    dataClasses,
    reason: 'This scaffold provider did not execute the native diagnostic source.',
    nextAction,
  };
}

/**
 * Builds platform-specific native diagnostic source inventory.
 *
 * @param {'android' | 'ios' | 'unknown'} platform
 * @returns {Record<string, unknown>[]}
 */
function buildDiagnosticSources(platform) {
  if (platform === 'android') {
    return [
      buildUnverifiedSource('gfxinfo', 'adb dumpsys gfxinfo', ['frames', 'jank', 'render'], 'Capture and parse gfxinfo or framestats output for Android frame evidence.'),
      buildUnverifiedSource('framestats', 'adb dumpsys gfxinfo framestats', ['frames', 'jank'], 'Capture and parse Android framestats for frame deadline and jank evidence.'),
      buildUnverifiedSource('meminfo', 'adb dumpsys meminfo', ['memory'], 'Capture and parse meminfo output for Android native memory evidence.'),
      buildUnverifiedSource('perfetto', 'perfetto', ['frames', 'jank', 'cpu', 'thread-scheduling', 'native-trace'], 'Capture a bounded Perfetto trace and attach the raw trace plus a structured summary.'),
      buildUnverifiedSource('trace-processor', 'trace_processor_shell', ['frames', 'jank', 'cpu', 'thread-scheduling'], 'Summarize Perfetto trace data with trace-processor SQL before making comparable claims.'),
      buildUnverifiedSource('logcat-render', 'adb logcat', ['render'], 'Preserve render or runtime markers from logcat when they explain the native-performance run.'),
    ];
  }

  if (platform === 'ios') {
    return [
      buildUnverifiedSource('instruments', 'Instruments', ['frames', 'jank', 'cpu', 'memory', 'native-trace'], 'Capture an Instruments trace or exported summary for iOS native performance evidence.'),
      buildUnverifiedSource('xctrace', 'xctrace', ['cpu', 'thread-scheduling', 'memory', 'native-trace'], 'Run a bounded xctrace capture/export and attach raw trace references plus structured metrics.'),
      buildUnverifiedSource('metrickit', 'MetricKit', ['frames', 'jank', 'cpu', 'memory', 'thermal', 'battery'], 'Ingest MetricKit payloads only when app/build/run identity and time window are bound.'),
      buildUnverifiedSource('simctl', 'xcrun simctl', ['render', 'memory', 'cpu'], 'Use simctl-derived logs or process state as diagnostic evidence, not as comparable native performance by itself.'),
    ];
  }

  return [
    buildUnverifiedSource('custom', 'project-local native diagnostics', ['unknown'], 'Replace this scaffold with a platform-specific native-performance capture provider.'),
  ];
}

/**
 * Returns the top-level evidence kind for a scaffolded platform.
 *
 * @param {'android' | 'ios' | 'unknown'} platform
 * @returns {string}
 */
function getEvidenceKind(platform) {
  if (platform === 'unknown') {
    return 'unknown';
  }
  return 'mixed';
}

/**
 * Returns the platform-specific scaffold summary.
 *
 * @param {'android' | 'ios' | 'unknown'} platform
 * @returns {string}
 */
function getSummary(platform) {
  if (platform === 'android') {
    return 'Scaffold Android native-performance evidence. Replace with Perfetto, trace-processor, gfxinfo, framestats, meminfo, or logcat-derived summaries before making performance claims.';
  }

  if (platform === 'ios') {
    return 'Scaffold iOS native-performance evidence. Replace with Instruments, xctrace, MetricKit, simctl-derived summaries, or equivalent project-local output before making performance claims.';
  }

  return 'Scaffold native-performance evidence. Replace with platform-native diagnostics before making performance claims.';
}

/**
 * Reads an optional text artifact path.
 *
 * @param {Record<string, string | boolean>} args
 * @param {string} key
 * @returns {string | undefined}
 */
function readOptionalText(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || !fs.existsSync(value)) {
    return undefined;
  }
  return fs.readFileSync(value, 'utf8');
}

/**
 * Reads an optional JSON object artifact path.
 *
 * @param {Record<string, string | boolean>} args
 * @param {string} key
 * @returns {Record<string, unknown> | undefined}
 */
function readOptionalJsonObject(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || !fs.existsSync(value)) {
    return undefined;
  }

  const parsed = JSON.parse(fs.readFileSync(value, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected --${key} to point at a JSON object.`);
  }
  return parsed;
}

/**
 * Builds optional raw attachment metadata for provider-owned text captures.
 *
 * @param {Record<string, string | boolean>} args
 * @returns {Array<{kind: string, path: string, sizeBytes: number}>}
 */
function buildNativePerformanceAttachments(args) {
  const attachments = [];
  for (const entry of [
    { arg: 'gfxinfo', kind: 'raw-gfxinfo' },
    { arg: 'framestats', kind: 'raw-framestats' },
    { arg: 'meminfo', kind: 'raw-meminfo' },
    { arg: 'trace-processor-summary', kind: 'trace-processor-summary' },
    { arg: 'xctrace-summary', kind: 'xctrace-summary' },
    { arg: 'metrickit-summary', kind: 'metrickit-summary' },
  ]) {
    const value = args[entry.arg];
    if (typeof value !== 'string' || value.length === 0 || !fs.existsSync(value)) {
      continue;
    }
    attachments.push({
      kind: entry.kind,
      path: value,
      sizeBytes: fs.statSync(value).size,
    });
  }
  return attachments;
}

/**
 * Writes deterministic scaffold native-performance evidence for uncaptured lanes.
 *
 * @param {{outPath: string, platform: string, runId: string, scenarioId: string}} options
 * @returns {void}
 */
function writeNativePerformanceScaffold({
  outPath,
  platform,
  runId,
  scenarioId,
}) {
  const normalizedPlatform = normalizePlatform(platform);
  const diagnosticSources = buildDiagnosticSources(normalizedPlatform);
  writeJsonArtifact(outPath, {
    schemaVersion: '1.0.0',
    providerId: 'example-evidence-provider',
    platform: normalizedPlatform,
    runId,
    scenarioId,
    tool: {
      name: 'agent-scenario-loop scaffold native performance provider',
      version: '1.0.0',
      command: 'scripts/asl-capture-native-performance-provider.mjs',
    },
    capturedAt: new Date(0).toISOString(),
    captureMode: 'afterCapture',
    clockDomain: 'host',
    completenessStatus: 'partial',
    comparability: {
      status: 'diagnostic-only',
      reason: 'Scaffold evidence is collected after the profile window and does not verify native metric comparability.',
      policy: 'Replace this scaffold with project-local native diagnostics before making performance claims.',
    },
    dataClasses: ['frames', 'memory', 'render'],
    diagnosticSources,
    evidenceKind: getEvidenceKind(normalizedPlatform),
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding: {
      status: 'unverified',
      reason: 'Replace this scaffold provider with a platform-native capture that verifies device and app binding.',
    },
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Native performance release or optimization claim.',
      reason: 'The scaffold records expected source lanes but does not capture verified native evidence.',
      supportingEvidence: ['diagnosticSources'],
      missingEvidence: ['verified target binding', 'captured native diagnostic source', 'comparable baseline'],
      nextAction: 'Implement the platform source capture listed in diagnosticSources and rerun before making native-performance claims.',
    },
    frames: {
      total: null,
      janky: null,
      p50Ms: null,
      p95Ms: null,
    },
    memory: {
      totalPssKb: null,
      nativeHeapKb: null,
    },
    summary: getSummary(normalizedPlatform),
  });
}

/**
 * Runs the provider script.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = requireStringArg(args, 'platform');
  const outPath = requireStringArg(args, 'out');
  const runId = requireStringArg(args, 'run-id');
  const scenarioId = requireStringArg(args, 'scenario');
  if (platform === 'android') {
    const liveAdbCapture = args['capture-android-adb'] === true || process.env.ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE === '1';
    if (liveAdbCapture) {
      await captureAndroidAdbEvidence({ args, outPath, runId, scenarioId });
      return;
    }
    writeJsonArtifact(outPath, buildAndroidNativePerformanceEvidence({
      appId: typeof args.app === 'string' ? args.app : undefined,
      attachments: buildNativePerformanceAttachments(args),
      deviceId: typeof args.device === 'string' ? args.device : undefined,
      framestatsText: readOptionalText(args, 'framestats'),
      gfxinfoText: readOptionalText(args, 'gfxinfo'),
      meminfoText: readOptionalText(args, 'meminfo'),
      providerId: 'example-evidence-provider',
      runId,
      scenarioId,
      traceProcessorSummary: readOptionalJsonObject(args, 'trace-processor-summary'),
    }));
    return;
  }

  if (platform === 'ios') {
    const liveXctraceCapture = args['capture-ios-xctrace'] === true || process.env.ASL_NATIVE_PERFORMANCE_IOS_CAPTURE === '1';
    if (liveXctraceCapture) {
      await captureIosXctraceEvidence({ args, outPath, runId, scenarioId });
      return;
    }
    const metricKitText = readOptionalText(args, 'metrickit-summary');
    const xctraceText = readOptionalText(args, 'xctrace-summary');
    writeJsonArtifact(outPath, buildIosNativePerformanceEvidence({
      appId: typeof args.app === 'string' ? args.app : undefined,
      attachments: buildNativePerformanceAttachments(args),
      bundleId: typeof args.bundle === 'string' ? args.bundle : undefined,
      deviceId: typeof args.device === 'string' ? args.device : undefined,
      metricKitSummary: metricKitText ? parseIosMetricKitSummaryText(metricKitText) : undefined,
      providerId: 'example-evidence-provider',
      runId,
      scenarioId,
      xctraceSummary: xctraceText ? parseIosXctraceSummaryText(xctraceText) : undefined,
    }));
    return;
  }

  writeNativePerformanceScaffold({
    outPath,
    platform,
    runId,
    scenarioId,
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
