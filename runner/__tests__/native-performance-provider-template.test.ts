const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildIosNativePerformanceEvidence,
  classifyNativePerformanceComparisonReadiness,
  parseAndroidFramestatsSummary,
} = require('../../core/native-performance');
const { initProject } = require('../init-project');

type TestContext = import('node:test').TestContext;

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildComparisonContract(durationMs = 10000) {
  return {
    comparisonMetrics: [
      {
        aggregation: 'p95',
        budget: {
          operator: 'at-most',
          threshold: 20,
        },
        direction: 'lower-is-better',
        id: 'frame-p95',
        sample: 'p95FrameMs',
        surface: 'frames',
        tolerance: {
          absolute: 1,
          relative: 0.05,
        },
        unit: 'ms',
      },
    ],
    comparisonPolicy: {
      environment: [
        {
          name: 'device-class',
          value: 'simulator',
        },
        {
          name: 'thermal-state',
          value: 'nominal',
        },
      ],
      policyId: 'release-native-baseline-v1',
      providerVersion: '1.0.0',
      target: {
        buildMode: 'release',
        family: 'ios-simulator-app',
      },
      window: {
        definitionId: 'active-window',
        durationMs,
        kind: 'bounded-duration',
        phase: 'activeLoop',
      },
    },
  };
}

function buildComparisonContext({
  artifactPath,
  platform,
  providerId,
  runDir,
  runId,
  scenarioId,
}: {
  artifactPath: string;
  platform: 'android' | 'ios';
  providerId: string;
  runDir: string;
  runId: string;
  scenarioId: string;
}) {
  return {
    artifactPath,
    evidencePathExists: (runRelativePath: string) => fs.existsSync(path.join(runDir, runRelativePath)),
    expectedPlatform: platform,
    expectedProviderId: providerId,
    expectedRunId: runId,
    expectedScenarioId: scenarioId,
    readEvidenceJson: (runRelativePath: string) => JSON.parse(fs.readFileSync(path.join(runDir, runRelativePath), 'utf8')),
    readEvidenceSha256: (runRelativePath: string) => sha256(fs.readFileSync(path.join(runDir, runRelativePath))),
  };
}

function buildNativePerformanceRequestRecord(platform: 'android' | 'ios') {
  return platform === 'ios'
    ? {
        activeLoopWindow: {
          exactMatchRequired: true,
          phase: 'activeLoop',
          runnerActiveLoopPath: 'raw/runner-active-loop-window.json',
          status: 'pending',
        },
        platform,
        requestedAppId: 'com.example.ios',
        requestedTargetId: 'SIM-UDID-123',
        runId: 'run-1',
        runnerId: 'ios-simctl-profile-runner',
        scenarioId: 'native-capture',
        schemaVersion: '1.0.0',
        target: {
          appId: 'com.example.ios',
          bundleId: 'com.example.ios',
          targetId: 'SIM-UDID-123',
          udid: 'SIM-UDID-123',
        },
      }
    : {
        activeLoopWindow: {
          exactMatchRequired: true,
          phase: 'activeLoop',
          runnerActiveLoopPath: 'raw/runner-active-loop-window.json',
          status: 'pending',
        },
        platform,
        requestedAppId: 'com.example.app',
        requestedTargetId: 'emulator-5554',
        runId: 'run-1',
        runnerId: 'android-adb-profile-runner',
        scenarioId: 'native-capture',
        schemaVersion: '1.0.0',
        target: {
          appId: 'com.example.app',
          packageName: 'com.example.app',
          serial: 'emulator-5554',
          targetId: 'emulator-5554',
        },
      };
}

async function writeNativePerformanceRequest({
  platform,
  record,
  runDir,
  text,
}: {
  platform: 'android' | 'ios';
  record?: Record<string, unknown>;
  runDir: string;
  text?: string;
}) {
  const requestPath = path.join(runDir, 'raw', 'native-performance-request.json');
  await fsp.mkdir(path.dirname(requestPath), { recursive: true });
  const nextContents = typeof text === 'string'
    ? text
    : `${JSON.stringify(record ?? buildNativePerformanceRequestRecord(platform), null, 2)}\n`;
  await fsp.writeFile(requestPath, nextContents, 'utf8');
  return requestPath;
}

async function stageRunnerLifecycleCommandRecords({
  providerId,
  runDir,
  sourceCommands,
  windowEndedAt,
  windowStartedAt,
}: {
  providerId: string;
  runDir: string;
  sourceCommands: Array<Record<string, unknown>>;
  windowEndedAt: string;
  windowStartedAt: string;
}) {
  const lifecycleCommands = sourceCommands.filter((sourceCommand) => (
    typeof sourceCommand.recordPath === 'string' &&
    sourceCommand.recordPath.startsWith('raw/provider-commands/')
  ));
  const windowStartedAtMs = Date.parse(windowStartedAt);
  const windowEndedAtMs = Date.parse(windowEndedAt);
  assert.equal(Number.isFinite(windowStartedAtMs), true);
  assert.equal(Number.isFinite(windowEndedAtMs), true);
  assert.equal(windowEndedAtMs > windowStartedAtMs, true);

  for (const [index, sourceCommand] of lifecycleCommands.entries()) {
    assert.equal(typeof sourceCommand.command, 'string');
    assert.ok(Array.isArray(sourceCommand.args));
    assert.equal(typeof sourceCommand.recordPath, 'string');
    assert.equal(typeof sourceCommand.startedRecordPath, 'string');
    assert.equal(typeof sourceCommand.stdoutPath, 'string');
    assert.equal(typeof sourceCommand.stderrPath, 'string');
    assert.equal(typeof sourceCommand.phase, 'string');

    const commandId = typeof sourceCommand.commandId === 'string'
      ? sourceCommand.commandId
      : String(sourceCommand.sourceId);
    const stdout = `${commandId} stdout\n`;
    const stderr = `${commandId} stderr\n`;
    const stdoutSha256 = sha256(stdout);
    const stderrSha256 = sha256(stderr);
    let startedAtMs = windowEndedAtMs + ((index + 1) * 100);
    let endedAtMs = startedAtMs + 50;
    if (sourceCommand.phase === 'startWindow') {
      startedAtMs = windowStartedAtMs - 150;
      endedAtMs = windowStartedAtMs - 50;
    } else if (sourceCommand.phase === 'stopWindow') {
      startedAtMs = windowEndedAtMs + 50;
      endedAtMs = windowEndedAtMs + 150;
    } else if (sourceCommand.phase === 'afterCapture') {
      startedAtMs = windowEndedAtMs + 200;
      endedAtMs = windowEndedAtMs + 300;
    } else if (sourceCommand.phase === 'finalize') {
      startedAtMs = windowEndedAtMs + 350;
      endedAtMs = windowEndedAtMs + 450;
    }
    const startedAt = new Date(startedAtMs).toISOString();
    const endedAt = new Date(endedAtMs).toISOString();

    const stdoutPath = path.join(runDir, sourceCommand.stdoutPath);
    const stderrPath = path.join(runDir, sourceCommand.stderrPath);
    const startedRecordPath = path.join(runDir, sourceCommand.startedRecordPath);
    const completedRecordPath = path.join(runDir, sourceCommand.recordPath);

    await fsp.mkdir(path.dirname(completedRecordPath), { recursive: true });
    await fsp.writeFile(stdoutPath, stdout, 'utf8');
    await fsp.writeFile(stderrPath, stderr, 'utf8');
    await fsp.writeFile(
      startedRecordPath,
      `${JSON.stringify({
        args: sourceCommand.args,
        command: sourceCommand.command,
        outputs: Array.isArray(sourceCommand.outputs) ? sourceCommand.outputs : [],
        phase: sourceCommand.phase,
        providerId,
        ...(typeof sourceCommand.requestPath === 'string' ? { requestPath: sourceCommand.requestPath } : {}),
        ...(typeof sourceCommand.requestSha256 === 'string' ? { requestSha256: sourceCommand.requestSha256 } : {}),
        startedAt,
        startedRecordPath: sourceCommand.startedRecordPath,
        status: 'started',
        stderrPath: sourceCommand.stderrPath,
        stdoutPath: sourceCommand.stdoutPath,
      })}\n`,
      'utf8',
    );

    const completedRecord: Record<string, unknown> = {
      args: sourceCommand.args,
      command: sourceCommand.command,
      endedAt,
      exitCode: 0,
      outputs: Array.isArray(sourceCommand.outputs)
        ? sourceCommand.outputs.map((output) => ({
            ...output,
            status: 'captured',
            stale: false,
          }))
        : [],
      phase: sourceCommand.phase,
      providerId,
      ...(typeof sourceCommand.requestPath === 'string' ? { requestPath: sourceCommand.requestPath } : {}),
      ...(typeof sourceCommand.requestSha256 === 'string' ? { requestSha256: sourceCommand.requestSha256 } : {}),
      startedAt,
      startedRecordPath: sourceCommand.startedRecordPath,
      status: 'completed',
      stderrPath: sourceCommand.stderrPath,
      stderrSha256,
      stdoutPath: sourceCommand.stdoutPath,
      stdoutSha256,
    };
    if (typeof sourceCommand.outputPath === 'string') {
      completedRecord.outputPath = sourceCommand.outputPath;
      completedRecord.outputSha256 = sha256(await fsp.readFile(path.join(runDir, sourceCommand.outputPath)));
    }
    await fsp.writeFile(completedRecordPath, `${JSON.stringify(completedRecord)}\n`, 'utf8');
  }
}

async function assertCommandRecordsDoNotPersistResolvedPaths({
  runDir,
  sourceCommands,
}: {
  runDir: string;
  sourceCommands: Array<Record<string, unknown>>;
}) {
  for (const sourceCommand of sourceCommands) {
    if (typeof sourceCommand.recordPath === 'string') {
      const completedRecordPath = path.join(runDir, sourceCommand.recordPath);
      if (fs.existsSync(completedRecordPath)) {
        const completedRecord = JSON.parse(await fsp.readFile(completedRecordPath, 'utf8'));
        for (const output of completedRecord.outputs ?? []) {
          assert.equal(output.resolvedPath, undefined);
        }
      }
    }
    if (typeof sourceCommand.startedRecordPath === 'string') {
      const startedRecordPath = path.join(runDir, sourceCommand.startedRecordPath);
      if (fs.existsSync(startedRecordPath)) {
        const startedRecord = JSON.parse(await fsp.readFile(startedRecordPath, 'utf8'));
        for (const output of startedRecord.outputs ?? []) {
          assert.equal(output.resolvedPath, undefined);
        }
      }
    }
  }
}

const ROOT = path.join(__dirname, '..', '..', '..');

function execFileResult(command: string, args: string[], options: Record<string, unknown>): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve) => {
    execFile(command, args, options, (error: NodeJS.ErrnoException & {code?: number} | null, stdout: string, stderr: string) => {
      let exitCode = 0;
      if (error) {
        exitCode = typeof error.code === 'number' ? error.code : 1;
      }
      resolve({
        exitCode,
        stderr,
        stdout,
      });
    });
  });
}

async function createGeneratedProvider(t: TestContext, providerId = 'example-evidence-provider'): Promise<{
  fakeAdbPath: string;
  fakeXcrunPath: string;
  providerId: string;
  runDir: string;
  scriptPath: string;
  targetDir: string;
}> {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-provider-template-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });
  await initProject({ outDir: targetDir, packageRoot: ROOT, scenarioId: 'Native Capture' });
  await fsp.mkdir(path.join(targetDir, 'node_modules'), { recursive: true });
  await fsp.symlink(ROOT, path.join(targetDir, 'node_modules', 'agent-scenario-loop'), 'dir');
  const fakeAdbPath = path.join(targetDir, 'fake-adb');
  await fsp.writeFile(fakeAdbPath, `#!/bin/sh
command="$*"
if [ -n "$FAKE_ADB_LOG" ]; then printf '%s\\n' "$command" >> "$FAKE_ADB_LOG"; fi
source=unknown
case "$command" in
  *" framestats") source=framestats ;;
  *" meminfo "*) source=meminfo ;;
  *" gfxinfo "*) source=gfxinfo ;;
  *" get-serialno") source=target-serial ;;
  *" pm path "*) source=target-package ;;
esac
if [ "$FAKE_ADB_TIMEOUT" = "$source" ]; then sleep 2; fi
if [ "$FAKE_ADB_IGNORE_TERM" = "$source" ]; then trap '' TERM; while :; do :; done; fi
if [ "$FAKE_ADB_OVERFLOW" = "$source" ]; then
  trap 'exit 0' TERM
  if [ "$source" = target-serial ]; then printf 'emulator-5554\\n'; fi
  if [ "$source" = target-package ]; then printf 'package:/data/app/com.example.app/base.apk\\n'; fi
  if [ "$source" = framestats ]; then printf '%s\\n' '---PROFILEDATA---' 'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted' '0,1000000000,1000000000,0,0,0,0,0,0,0,0,0,0,1010000000,0,0,0' '---PROFILEDATA---'; fi
  while :; do printf '0123456789abcdef'; done
fi
if [ "$FAKE_ADB_FAIL" = "$source" ]; then printf 'forced %s failure\\n' "$source" >&2; exit 7; fi
if [ "$FAKE_ADB_EMPTY" = "$source" ]; then exit 0; fi
serial=emulator-5554
if [ -n "$FAKE_ADB_SERIAL" ]; then serial="$FAKE_ADB_SERIAL"; fi
if [ "$source" = target-serial ]; then printf '%s\\n' "$serial"; fi
if [ "$source" = target-package ]; then printf 'package:/data/app/com.example.app/base.apk\\n'; fi
if [ "$source" = gfxinfo ]; then printf 'Total frames rendered: 120\\nJanky frames: 6 (5.00%%)\\n50th percentile: 8ms\\n95th percentile: 18ms\\n'; fi
if [ "$source" = framestats ]; then printf '%s\\n' '---PROFILEDATA---' 'Flags,IntendedVsync,Vsync,FrameCompleted' '0,1000000,1000000,17000000' '---PROFILEDATA---'; fi
if [ "$source" = meminfo ]; then printf 'TOTAL PSS: 180000 KB\\nNative Heap: 42000 KB\\n'; fi
`, 'utf8');
  await fsp.chmod(fakeAdbPath, 0o755);
  const fakeXcrunPath = path.join(targetDir, 'fake-xcrun');
  await fsp.writeFile(fakeXcrunPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (process.env.FAKE_XCRUN_LOG) {
  fs.appendFileSync(process.env.FAKE_XCRUN_LOG, \`\${JSON.stringify(args)}\\n\`);
}

function failIfNeeded(stepId) {
  if (process.env.FAKE_XCRUN_FAIL === stepId) {
    process.stderr.write(\`forced \${stepId} failure\\n\`);
    process.exit(9);
  }
}

if (args[0] === 'simctl' && args[1] === 'list' && args[2] === 'devices' && args[3] === '--json') {
  failIfNeeded('simctl-list-devices');
  const udid = process.env.FAKE_IOS_UDID || 'SIM-UDID-123';
  const state = process.env.FAKE_SIMCTL_STATE || 'Booted';
  process.stdout.write(JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ name: 'iPhone 16', state, udid }],
    },
  }));
  process.exit(0);
}

if (args[0] === 'simctl' && args[1] === 'get_app_container') {
  failIfNeeded('simctl-get-app-container');
  process.stdout.write('/tmp/fake-container');
  process.exit(0);
}

if (args[0] === 'simctl' && args[1] === 'spawn' && args[3] === 'launchctl' && args[4] === 'list') {
  failIfNeeded('simctl-launchctl-list');
  const pid = process.env.FAKE_SIMCTL_PID || '4242';
  const label = process.env.FAKE_SIMCTL_LABEL || 'UIKitApplication:com.example.ios[FAKE-INSTANCE]';
  process.stdout.write(\`PID\\tStatus\\tLabel\\n\${pid}\\t0\\t\${label}\\n\`);
  process.exit(0);
}

if (args[0] === 'xctrace' && args[1] === 'record') {
  failIfNeeded('xctrace-record');
  const outputIndex = args.indexOf('--output');
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    const tracePath = args[outputIndex + 1];
    fs.mkdirSync(tracePath, { recursive: true });
    fs.writeFileSync(path.join(tracePath, 'tracev3.data'), 'trace-data', 'utf8');
  }
  process.exit(0);
}

if (args[0] === 'xctrace' && args[1] === 'export' && args.includes('--toc')) {
  failIfNeeded('xctrace-export-toc');
  const recordedDevice = process.env.FAKE_XCRUN_RECORDED_DEVICE || (process.env.FAKE_IOS_UDID || 'SIM-UDID-123');
  const recordedPid = process.env.FAKE_XCRUN_RECORDED_PID || (process.env.FAKE_SIMCTL_PID || '4242');
  const processName = process.env.FAKE_XCRUN_PROCESS_NAME || 'ExampleApp';
  const endAt = process.env.FAKE_XCRUN_END_AT || '2026-07-13T18:47:10.000Z';
  const duration = process.env.FAKE_XCRUN_DURATION || '10.000000';
  const xml = [
    '<trace-toc>',
    '  <run number="1">',
    '    <info>',
    '      <target>',
    \`        <device platform="iOS Simulator" name="iPhone 16" uuid="\${recordedDevice}"/>\`,
    \`        <process name="\${processName}" pid="\${recordedPid}"/>\`,
    '      </target>',
    '      <summary>',
    '        <start-date>2026-07-13T18:47:00.000Z</start-date>',
    \`        <end-date>\${endAt}</end-date>\`,
    \`        <duration>\${duration}</duration>\`,
    '        <end-reason>Time limit reached</end-reason>',
    '        <instruments-version>16.0 (27A5209h)</instruments-version>',
    '        <template-name>Time Profiler</template-name>',
    '        <time-limit>10 seconds</time-limit>',
    '      </summary>',
    '    </info>',
    '  </run>',
    '</trace-toc>',
    '',
  ].join('\\n');
  process.stdout.write(xml);
  process.exit(0);
}

process.stderr.write(\`unsupported fake-xcrun command: \${args.join(' ')}\\n\`);
process.exit(2);
`, 'utf8');
  await fsp.chmod(fakeXcrunPath, 0o755);
  const runDir = path.join(targetDir, 'artifacts', 'run-1');
  await fsp.mkdir(path.join(runDir, 'raw', 'providers', providerId), { recursive: true });
  return {
    fakeAdbPath,
    fakeXcrunPath,
    providerId,
    runDir,
    scriptPath: path.join(targetDir, 'scripts', 'asl-capture-native-performance-provider.mjs'),
    targetDir,
  };
}

async function stageNativePerformanceRequestFixture({
  platform,
  runDir,
}: {
  platform: 'android' | 'ios';
  runDir: string;
}): Promise<{path: string; sha256: string}> {
  const requestPath = path.join(runDir, 'raw', 'native-performance-request.json');
  const record = platform === 'ios'
    ? {
        activeLoopWindow: {
          exactMatchRequired: true,
          phase: 'activeLoop',
          runnerActiveLoopPath: 'raw/runner-active-loop-window.json',
          status: 'pending',
        },
        platform,
        requestedAppId: 'com.example.ios',
        requestedTargetId: 'SIM-UDID-123',
        runId: 'run-1',
        runnerId: 'ios-simctl-profile-runner',
        scenarioId: 'native-capture',
        schemaVersion: '1.0.0',
        target: {
          appId: 'com.example.ios',
          bundleId: 'com.example.ios',
          targetId: 'SIM-UDID-123',
          udid: 'SIM-UDID-123',
        },
      }
    : {
        activeLoopWindow: {
          exactMatchRequired: true,
          phase: 'activeLoop',
          runnerActiveLoopPath: 'raw/runner-active-loop-window.json',
          status: 'pending',
        },
        platform,
        requestedAppId: 'com.example.app',
        requestedTargetId: 'emulator-5554',
        runId: 'run-1',
        runnerId: 'android-adb-profile-runner',
        scenarioId: 'native-capture',
        schemaVersion: '1.0.0',
        target: {
          appId: 'com.example.app',
          packageName: 'com.example.app',
          serial: 'emulator-5554',
          targetId: 'emulator-5554',
          udid: 'emulator-5554',
        },
      };
  const fileContents = `${JSON.stringify(record, null, 2)}\n`;
  await fsp.mkdir(path.dirname(requestPath), { recursive: true });
  await fsp.writeFile(requestPath, fileContents, 'utf8');
  return {
    path: requestPath,
    sha256: sha256(fileContents),
  };
}

function providerArgs(options: {fakeAdbPath: string; providerId: string; runDir: string; scriptPath: string}, extra: string[] = []): string[] {
  return [
    options.scriptPath,
    '--platform', 'android',
    '--scenario', 'native-capture',
    '--run-id', 'run-1',
    '--out', path.join(options.runDir, 'raw', 'providers', options.providerId, 'native-performance.json'),
    '--run-dir', options.runDir,
    '--adb', options.fakeAdbPath,
    '--app', 'com.example.app',
    '--device', 'emulator-5554',
    ...extra,
  ];
}

function iosProviderArgs(options: {fakeXcrunPath: string; providerId: string; runDir: string; scriptPath: string}, extra: string[] = []): string[] {
  return [
    options.scriptPath,
    '--platform', 'ios',
    '--scenario', 'native-capture',
    '--run-id', 'run-1',
    '--out', path.join(options.runDir, 'raw', 'providers', options.providerId, 'native-performance.json'),
    '--run-dir', options.runDir,
    '--xcrun', options.fakeXcrunPath,
    '--bundle', 'com.example.ios',
    '--device', 'SIM-UDID-123',
    ...extra,
  ];
}

function iosLifecycleArgs(
  options: {fakeXcrunPath: string; providerId: string; runDir: string; scriptPath: string},
  action: 'start-window' | 'stop-window' | 'normalize' | 'finalize',
  extra: string[] = [],
): string[] {
  const providerDir = path.join(options.runDir, 'raw', 'providers', options.providerId);
  const requestPath = path.join(options.runDir, 'raw', 'native-performance-request.json');
  const args = [
    options.scriptPath,
    action,
    '--platform', 'ios',
    '--scenario', 'native-capture',
    '--run-id', 'run-1',
    '--run-dir', options.runDir,
    '--provider-id', options.providerId,
    '--provider-dir', providerDir,
    '--request', requestPath,
    '--target-binding', path.join(providerDir, 'target-binding.json'),
    '--xcrun', options.fakeXcrunPath,
    '--bundle', 'com.example.ios',
    '--device', 'SIM-UDID-123',
  ];
  if (fs.existsSync(requestPath)) {
    args.push('--request-sha256', sha256(fs.readFileSync(requestPath)));
  }
  if (action === 'normalize') {
    args.push('--out', path.join(providerDir, 'native-performance.json'));
  }
  args.push(...extra);
  return args;
}

function androidLifecycleArgs(
  options: {fakeAdbPath: string; providerId: string; runDir: string; scriptPath: string},
  action: 'start-window' | 'stop-window' | 'normalize' | 'finalize',
  extra: string[] = [],
): string[] {
  const providerDir = path.join(options.runDir, 'raw', 'providers', options.providerId);
  const requestPath = path.join(options.runDir, 'raw', 'native-performance-request.json');
  const args = [
    options.scriptPath,
    action,
    '--platform', 'android',
    '--scenario', 'native-capture',
    '--run-id', 'run-1',
    '--run-dir', options.runDir,
    '--provider-id', options.providerId,
    '--provider-dir', providerDir,
    '--request', requestPath,
    '--target-binding', path.join(providerDir, 'target-binding.json'),
    '--adb', options.fakeAdbPath,
    '--app', 'com.example.app',
    '--device', 'emulator-5554',
  ];
  if (fs.existsSync(requestPath)) {
    args.push('--request-sha256', sha256(fs.readFileSync(requestPath)));
  }
  if (action === 'normalize') {
    args.push('--out', path.join(providerDir, 'native-performance.json'));
  }
  args.push(...extra);
  return args;
}

function withoutRequestArg(args: string[]): string[] {
  const nextArgs = [...args];
  for (const optionName of ['--request', '--request-sha256']) {
    const optionIndex = nextArgs.indexOf(optionName);
    if (optionIndex !== -1) {
      nextArgs.splice(optionIndex, 2);
    }
  }
  return nextArgs;
}

function withoutRequestShaArg(args: string[]): string[] {
  const nextArgs = [...args];
  const optionIndex = nextArgs.indexOf('--request-sha256');
  if (optionIndex !== -1) {
    nextArgs.splice(optionIndex, 2);
  }
  return nextArgs;
}

function providerArtifactPaths(provider: {providerId: string; runDir: string}) {
  const providerDir = path.join(provider.runDir, 'raw', 'providers', provider.providerId);
  return {
    evidencePath: path.join(providerDir, 'native-performance.json'),
    providerDir,
    targetBindingPath: path.join(providerDir, 'target-binding.json'),
  };
}

async function assertRequestGuardFailure({
  args,
  cwd,
  env,
  provider,
  stderrPattern,
}: {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  provider: {providerId: string; runDir: string};
  stderrPattern: RegExp;
}) {
  const { evidencePath, targetBindingPath } = providerArtifactPaths(provider);
  const result = await execFileResult(process.execPath, args, { cwd, env });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, stderrPattern);
  assert.equal(fs.existsSync(targetBindingPath), false);
  assert.equal(fs.existsSync(evidencePath), false);
}

test('generated provider keeps Android adb capture opt-in', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'adb-commands.jsonl');
  const result = await execFileResult(process.execPath, providerArgs(provider), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_LOG: commandLog },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(commandLog), false);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.providerId, 'example-evidence-provider');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.comparability.status, 'diagnostic-only');
});

test('generated provider emits the configured provider identity from its runner-owned output path', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t, 'configured-native-provider');
  const result = await execFileResult(process.execPath, providerArgs(provider), {
    cwd: provider.targetDir,
    env: process.env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const evidencePath = path.join(provider.runDir, 'raw', 'providers', provider.providerId, 'native-performance.json');
  const evidence = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
  assert.equal(evidence.providerId, provider.providerId);
});

test('generated provider rejects an invalid provider identity before writing evidence', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t, 'Invalid Provider');
  const evidencePath = path.join(provider.runDir, 'raw', 'providers', provider.providerId, 'native-performance.json');
  const result = await execFileResult(process.execPath, providerArgs(provider), {
    cwd: provider.targetDir,
    env: process.env,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /provider identity "Invalid Provider" is invalid/u);
  assert.equal(fs.existsSync(evidencePath), false);
});

test('generated provider rejects an output path with no provider identity directory', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const evidencePath = path.join(provider.runDir, 'raw', 'providers', 'native-performance.json');
  const args = providerArgs(provider);
  args[args.indexOf('--out') + 1] = evidencePath;
  const result = await execFileResult(process.execPath, args, {
    cwd: provider.targetDir,
    env: process.env,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /missing its provider identity directory/u);
  assert.equal(fs.existsSync(evidencePath), false);
});

test('generated provider keeps iOS xctrace capture opt-in', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'xcrun-commands.jsonl');
  const result = await execFileResult(process.execPath, iosProviderArgs(provider), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_XCRUN_LOG: commandLog },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(commandLog), false);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.comparability.status, 'diagnostic-only');
});

test('generated provider rejects a mutated iOS native-performance request hash', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const stagedRequest = await stageNativePerformanceRequestFixture({ platform: 'ios', runDir: provider.runDir });
  const env = { ...process.env, ASL_NATIVE_PERFORMANCE_IOS_CAPTURE: '1' };
  const lifecycleArgs = (action: 'start-window' | 'stop-window') => iosLifecycleArgs(provider, action, [
    '--request', stagedRequest.path,
    '--request-sha256', stagedRequest.sha256,
  ]);

  let result = await execFileResult(process.execPath, lifecycleArgs('start-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  await fsp.writeFile(
    stagedRequest.path,
    `${JSON.stringify({ tampered: true }, null, 2)}\n`,
    'utf8',
  );

  result = await execFileResult(process.execPath, lifecycleArgs('stop-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /request hash mismatch/u);
});

test('generated provider rejects an iOS native-performance request without a hash binding', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const stagedRequest = await stageNativePerformanceRequestFixture({ platform: 'ios', runDir: provider.runDir });
  const result = await execFileResult(process.execPath, withoutRequestShaArg(iosLifecycleArgs(provider, 'start-window', [
    '--request', stagedRequest.path,
  ])), {
    cwd: provider.targetDir,
    env: { ...process.env, ASL_NATIVE_PERFORMANCE_IOS_CAPTURE: '1' },
  });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /requires a matching sha256/u);
});

test('generated provider captures bounded iOS xctrace diagnostics with verified target and trace window evidence', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'xcrun-commands.jsonl');
  const result = await execFileResult(process.execPath, iosProviderArgs(provider), {
    cwd: provider.targetDir,
    env: { ...process.env, ASL_NATIVE_PERFORMANCE_IOS_CAPTURE: '1', FAKE_XCRUN_LOG: commandLog },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const evidencePath = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json');
  const evidence = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
  assert.equal(evidence.completenessStatus, 'complete');
  assert.equal(evidence.targetBinding.status, 'verified');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.captureMode, 'session');
  assert.equal(evidence.lifecycle.phase, 'afterCapture');
  assert.equal(evidence.lifecycle.perturbsTiming, true);
  assert.equal(evidence.lifecycle.startedAt, '2026-07-13T18:47:00.000Z');
  assert.equal(evidence.lifecycle.endedAt, '2026-07-13T18:47:10.000Z');
  assert.equal(evidence.lifecycle.durationMs, 10000);
  assert.equal(evidence.traces[0].durationMs, 10000);
  assert.equal(evidence.traces[0].windowStartMs, 0);
  assert.equal(evidence.traces[0].windowEndMs, 10000);
  for (const attachment of evidence.attachments) {
    assert.equal(path.isAbsolute(attachment.path), false);
    assert.equal(fs.existsSync(path.join(provider.runDir, attachment.path)), true, attachment.path);
  }
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, evidence.targetBinding.candidateTargets[0].evidencePath), 'utf8'));
  assert.equal(targetProof.tocVerified, true);
  assert.equal(targetProof.windowVerified, true);
  assert.equal(targetProof.recordedDeviceId, 'SIM-UDID-123');
  assert.equal(targetProof.recordedDevicePlatform, 'iOS Simulator');
  assert.equal(targetProof.recordedProcessPid, 4242);
  assert.equal(targetProof.observedAppContainerName, 'fake-container');
  assert.equal(targetProof.template, 'Time Profiler');
  assert.equal(targetProof.toolVersion, '16.0 (27A5209h)');
  assert.equal(targetProof.endReason, 'Time limit reached');
  const traceInventoryAttachment = evidence.attachments.find((attachment: Record<string, unknown>) => attachment.kind === 'xctrace-trace-bundle-inventory');
  const traceInventory = JSON.parse(await fsp.readFile(path.join(provider.runDir, traceInventoryAttachment.path), 'utf8'));
  assert.equal(path.isAbsolute(traceInventory.traceBundlePath), false);
  assert.equal(traceInventory.exists, true);
  assert.equal(traceInventory.fileCount, 1);
  assert.equal(traceInventory.files[0].path, 'tracev3.data');
  for (const source of evidence.diagnosticSources.filter((entry: Record<string, unknown>) => entry.sourceId === 'xctrace' || entry.sourceId === 'simctl')) {
    assert.equal(typeof source.tool.command, 'string');
    assert.equal(source.tool.command.includes(provider.targetDir), false);
    assert.equal(source.tool.command.includes(provider.runDir), false);
  }
  for (const sourceCommand of targetProof.sourceCommands) {
    for (const arg of sourceCommand.args) {
      assert.equal(typeof arg === 'string' && arg.includes(provider.runDir), false);
      assert.equal(typeof arg === 'string' && path.isAbsolute(arg), false);
    }
  }
  for (const recordName of ['xctrace-record.command.json', 'xctrace-export-toc.command.json']) {
    const commandRecord = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'ios-xctrace', recordName), 'utf8'));
    assert.equal(path.isAbsolute(commandRecord.command), false);
    for (const arg of commandRecord.args) {
      assert.equal(typeof arg === 'string' && path.isAbsolute(arg), false);
      assert.equal(typeof arg === 'string' && arg.includes(provider.runDir), false);
    }
  }
  const commands = (await fsp.readFile(commandLog, 'utf8')).trim().split('\n').map((line: string) => JSON.parse(line));
  assert.equal(commands.length, 5);
  assert.deepEqual(commands[0], ['simctl', 'list', 'devices', '--json']);
  assert.deepEqual(commands[1], ['simctl', 'get_app_container', 'SIM-UDID-123', 'com.example.ios', 'app']);
  assert.deepEqual(commands[2], ['simctl', 'spawn', 'SIM-UDID-123', 'launchctl', 'list']);
  assert.deepEqual(commands[3], [
    'xctrace',
    'record',
    '--template',
    'Time Profiler',
    '--device',
    'SIM-UDID-123',
    '--attach',
    '4242',
    '--time-limit',
    '10s',
    '--output',
    path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'ios-xctrace', 'capture.trace'),
    '--no-prompt',
  ]);
  assert.deepEqual(commands[4], [
    'xctrace',
    'export',
    '--input',
    path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'ios-xctrace', 'capture.trace'),
    '--toc',
  ]);
});

test('generated provider keeps iOS target binding immutable after finalize', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'xcrun-commands.jsonl');
  const env = { ...process.env, ASL_NATIVE_PERFORMANCE_IOS_CAPTURE: '1', FAKE_XCRUN_LOG: commandLog };
  const targetProofPath = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json');
  await writeNativePerformanceRequest({ platform: 'ios', runDir: provider.runDir });
  let result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'start-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(targetProofPath), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'stop-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(targetProofPath), false);
  result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'normalize'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  const normalizedTargetProof = JSON.parse(await fsp.readFile(targetProofPath, 'utf8'));
  assert.equal(normalizedTargetProof.window.phase, 'activeLoop');
  assert.ok(normalizedTargetProof.window.durationMs > 0);
  assert.deepEqual(
    normalizedTargetProof.sourceCommands.map((command: Record<string, unknown>) => command.commandId ?? command.sourceId),
    [
      'start-native-window',
      'stop-native-window',
      'capture-native-performance',
      'simctl-list-devices',
      'simctl-get-app-container',
      'simctl-launchctl-list',
      'xctrace-record',
      'xctrace-export-toc',
    ],
  );
  const normalizeCommand = normalizedTargetProof.sourceCommands.find(
    (command: Record<string, unknown>) => command.commandId === 'capture-native-performance',
  );
  const startWindowCommand = normalizedTargetProof.sourceCommands.find(
    (command: Record<string, unknown>) => command.commandId === 'start-native-window',
  );
  const stopWindowCommand = normalizedTargetProof.sourceCommands.find(
    (command: Record<string, unknown>) => command.commandId === 'stop-native-window',
  );
  assert.equal(startWindowCommand.status, 'completed');
  assert.equal(startWindowCommand.outputPath, undefined);
  assert.equal(stopWindowCommand.status, 'completed');
  assert.equal(stopWindowCommand.outputPath, undefined);
  assert.equal(normalizeCommand.status, 'completed');
  assert.equal(normalizeCommand.outputPath, 'raw/providers/example-evidence-provider/target-binding.json');
  assert.equal(normalizedTargetProof.status, 'verified');
  assert.equal(normalizedTargetProof.recordedProcessPid, 4242);
  assert.equal(normalizedTargetProof.recordedProcessName, 'ExampleApp');
  assert.equal(normalizedTargetProof.recordedDeviceId, 'SIM-UDID-123');
  await assertCommandRecordsDoNotPersistResolvedPaths({
    runDir: provider.runDir,
    sourceCommands: normalizedTargetProof.sourceCommands,
  });
  const normalizedTargetProofHash = sha256(await fsp.readFile(targetProofPath));

  result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'finalize'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  const finalizedTargetProof = JSON.parse(await fsp.readFile(targetProofPath, 'utf8'));
  assert.equal(finalizedTargetProof.window.phase, 'activeLoop');
  assert.equal(finalizedTargetProof.status, 'verified');
  assert.equal(finalizedTargetProof.recordedProcessPid, 4242);
  assert.equal(finalizedTargetProof.recordedProcessName, 'ExampleApp');
  assert.equal(sha256(await fsp.readFile(targetProofPath)), normalizedTargetProofHash);
  assert.deepEqual(finalizedTargetProof.sourceCommands, normalizedTargetProof.sourceCommands);
});

test('generated provider iOS after-capture xctrace output stays diagnostic-only after finalize', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const env = { ...process.env, ASL_NATIVE_PERFORMANCE_IOS_CAPTURE: '1' };
  await writeNativePerformanceRequest({ platform: 'ios', runDir: provider.runDir });

  let result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'start-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  await new Promise((resolve) => setTimeout(resolve, 20));
  result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'stop-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'normalize'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  result = await execFileResult(process.execPath, iosLifecycleArgs(provider, 'finalize'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  const artifactPath = 'raw/providers/example-evidence-provider/native-performance.json';
  const targetBindingPath = 'raw/providers/example-evidence-provider/target-binding.json';
  const generatedEvidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, artifactPath), 'utf8'));
  const targetBinding = JSON.parse(await fsp.readFile(path.join(provider.runDir, targetBindingPath), 'utf8'));
  assert.equal(targetBinding.captureArtifacts, undefined);
  const sourceCommands = targetBinding.sourceCommands as Array<Record<string, unknown>>;
  await stageRunnerLifecycleCommandRecords({
    providerId: provider.providerId,
    runDir: provider.runDir,
    sourceCommands,
    windowEndedAt: targetBinding.window.endedAt,
    windowStartedAt: targetBinding.window.startedAt,
  });
  const comparableTargetBinding = targetBinding.status === 'verified'
    ? {
        status: 'verified',
        appId: 'com.example.ios',
        deviceId: 'SIM-UDID-123',
        source: 'provider simctl/xctrace target verification',
        candidateTargets: [{
          appId: 'com.example.ios',
          bindingStatus: 'observed',
          deviceId: 'SIM-UDID-123',
          evidencePath: targetBindingPath,
          platform: 'ios',
          source: 'simctl launchctl list plus xctrace TOC verification',
        }],
      }
    : targetBinding;

  const comparableEvidence = buildIosNativePerformanceEvidence({
    appId: 'com.example.ios',
    attachments: generatedEvidence.attachments,
    bundleId: 'com.example.ios',
    captureMode: 'session',
    capturedAt: targetBinding.window.startedAt,
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      claim: 'ios-native-frame-budget',
      reason: 'The provider captured a verified active-loop xctrace window and exported structured comparison samples from that same trace.',
      supportingEvidence: ['xctrace', 'simctl', 'targetBinding', 'structured-xctrace-samples'],
    },
    comparability: {
      status: 'comparable',
      policy: 'release-native-baseline-v1',
      reason: 'The structured samples, verified target binding, and active-loop window satisfy the shared native comparison policy.',
    },
    ...buildComparisonContract(targetBinding.window.durationMs),
    completenessStatus: 'complete',
    deviceId: 'SIM-UDID-123',
    diagnosticSources: generatedEvidence.diagnosticSources,
    lifecycle: {
      durationMs: targetBinding.window.durationMs,
      endedAt: targetBinding.window.endedAt,
      perturbsTiming: true,
      phase: 'activeLoop',
      startedAt: targetBinding.window.startedAt,
    },
    providerId: provider.providerId,
    runId: 'run-1',
    scenarioId: 'native-capture',
    targetBinding: JSON.parse(JSON.stringify(comparableTargetBinding)),
    xctraceSummary: {
      durationMs: targetBinding.window.durationMs,
      frameCount: 720,
      p95FrameMs: 18,
      traceId: 'ios-active-window-trace',
      windowEndMs: targetBinding.window.durationMs,
      windowStartMs: 0,
    },
  });
  await fsp.writeFile(path.join(provider.runDir, artifactPath), `${JSON.stringify(comparableEvidence)}\n`, 'utf8');

  const context = buildComparisonContext({
    artifactPath,
    platform: 'ios',
    providerId: provider.providerId,
    runDir: provider.runDir,
    runId: 'run-1',
    scenarioId: 'native-capture',
  });

  assert.deepEqual(classifyNativePerformanceComparisonReadiness(comparableEvidence, context), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });
});

test('generated provider keeps Android target binding immutable after finalize', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'adb-commands.jsonl');
  const env = { ...process.env, ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE: '1', FAKE_ADB_LOG: commandLog };
  const targetProofPath = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json');
  await writeNativePerformanceRequest({ platform: 'android', runDir: provider.runDir });
  let result = await execFileResult(process.execPath, androidLifecycleArgs(provider, 'start-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(targetProofPath), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  result = await execFileResult(process.execPath, androidLifecycleArgs(provider, 'stop-window'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(targetProofPath), false);
  result = await execFileResult(process.execPath, androidLifecycleArgs(provider, 'normalize'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  const normalizedTargetProof = JSON.parse(await fsp.readFile(targetProofPath, 'utf8'));
  assert.equal(normalizedTargetProof.window.phase, 'activeLoop');
  assert.deepEqual(
    normalizedTargetProof.sourceCommands.map((command: Record<string, unknown>) => command.commandId ?? command.sourceId),
    [
      'start-native-window',
      'stop-native-window',
      'capture-native-performance',
      'target-serial',
      'target-package',
      'gfxinfo',
      'framestats',
      'meminfo',
    ],
  );
  const startWindowCommand = normalizedTargetProof.sourceCommands.find(
    (command: Record<string, unknown>) => command.commandId === 'start-native-window',
  );
  const stopWindowCommand = normalizedTargetProof.sourceCommands.find(
    (command: Record<string, unknown>) => command.commandId === 'stop-native-window',
  );
  const normalizeCommand = normalizedTargetProof.sourceCommands.find(
    (command: Record<string, unknown>) => command.commandId === 'capture-native-performance',
  );
  assert.equal(startWindowCommand.status, 'completed');
  assert.equal(startWindowCommand.outputPath, undefined);
  assert.equal(stopWindowCommand.status, 'completed');
  assert.equal(stopWindowCommand.outputPath, undefined);
  assert.equal(normalizeCommand.status, 'completed');
  assert.equal(normalizeCommand.outputPath, 'raw/providers/example-evidence-provider/target-binding.json');
  await assertCommandRecordsDoNotPersistResolvedPaths({
    runDir: provider.runDir,
    sourceCommands: normalizedTargetProof.sourceCommands,
  });
  const normalizedTargetProofHash = sha256(await fsp.readFile(targetProofPath));

  result = await execFileResult(process.execPath, androidLifecycleArgs(provider, 'finalize'), {
    cwd: provider.targetDir,
    env,
  });
  assert.equal(result.exitCode, 0, result.stderr);

  const finalizedTargetProof = JSON.parse(await fsp.readFile(targetProofPath, 'utf8'));
  assert.equal(finalizedTargetProof.window.phase, 'activeLoop');
  assert.equal(finalizedTargetProof.status, 'unverified');
  assert.equal(sha256(await fsp.readFile(targetProofPath)), normalizedTargetProofHash);
  assert.deepEqual(finalizedTargetProof.sourceCommands, normalizedTargetProof.sourceCommands);
});

test('generated provider captures Android adb diagnostics with bounded commands and durable target proof', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'adb-commands.jsonl');
  const result = await execFileResult(process.execPath, providerArgs(provider), {
    cwd: provider.targetDir,
    env: { ...process.env, ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE: '1', FAKE_ADB_LOG: commandLog },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const evidencePath = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json');
  const evidence = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.targetBinding.candidateTargets, undefined);
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json'), 'utf8'));
  assert.deepEqual(targetProof.sourceCommands.map((command: Record<string, unknown>) => command.sourceId), ['target-serial', 'target-package', 'gfxinfo', 'framestats', 'meminfo']);
  assert.equal(targetProof.status, 'unverified');
  assert.equal(targetProof.requestedAppId, 'com.example.app');
  assert.equal(targetProof.requestedTargetId, 'emulator-5554');
  assert.equal(targetProof.window.phase, 'afterCapture');
  assert.equal(typeof targetProof.sourceCommands[0].recordPath, 'string');
  assert.equal(typeof targetProof.sourceCommands[0].stdoutSha256, 'string');
  assert.equal(typeof targetProof.sourceCommands[0].stderrSha256, 'string');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.frames.total, 120);
  assert.equal(evidence.memory.totalPssKb, 180000);
  for (const attachment of evidence.attachments) {
    assert.equal(path.isAbsolute(attachment.path), false);
    assert.equal(fs.existsSync(path.join(provider.runDir, attachment.path)), true, attachment.path);
  }
  const commands = (await fsp.readFile(commandLog, 'utf8')).trim().split('\n').map((line: string) => line.split(' '));
  assert.equal(commands.length, 5);
  assert.deepEqual(commands[0], ['-s', 'emulator-5554', 'get-serialno']);
  assert.deepEqual(commands[2], ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo', 'com.example.app']);
  assert.deepEqual(commands[3], ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'framestats']);
  assert.deepEqual(commands[4], ['-s', 'emulator-5554', 'shell', 'dumpsys', 'meminfo', 'com.example.app']);
});

test('generated provider preserves partial Android evidence and exits nonzero after a source failure', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_FAIL: 'meminfo' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'gfxinfo').status, 'captured');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'failed');
  assert.equal(evidence.frames.total, 120);
  assert.equal(evidence.memory, undefined);
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(fs.existsSync(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'meminfo.command.json')), true);
});

test('generated provider classifies Android adb command timeout and continues remaining capture', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, [
    '--capture-android-adb',
    '--command-timeout-ms', '1000',
  ]), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_TIMEOUT: 'framestats' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'framestats').status, 'timeout');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'captured');
});

test('generated provider rejects an empty successful Android diagnostic as partial evidence', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_EMPTY: 'meminfo' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  const meminfo = evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo');
  assert.equal(meminfo.status, 'partial');
  assert.match(meminfo.reason, /produced no stdout evidence/u);
  assert.equal(evidence.memory, undefined);
  const commandRecord = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'meminfo.command.json'), 'utf8'));
  assert.equal(commandRecord.status, 'partial');
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json'), 'utf8'));
  assert.equal(targetProof.sourceCommands.find((command: Record<string, unknown>) => command.sourceId === 'meminfo').status, 'partial');
});

test('generated provider escalates a resistant Android command and continues capture', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const startedAt = Date.now();
  const result = await execFileResult(process.execPath, providerArgs(provider, [
    '--capture-android-adb',
    '--command-timeout-ms', '1000',
  ]), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_IGNORE_TERM: 'framestats' },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - startedAt < 5_000, 'resistant command should be force-killed inside the bounded provider run');
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'framestats').status, 'timeout');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'captured');
  const commandRecord = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'framestats.command.json'), 'utf8'));
  assert.equal(commandRecord.timedOut, true);
  assert.equal(commandRecord.signal, 'SIGKILL');
});

test('generated provider preserves host execution errors for every attempted Android source', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const args = providerArgs(provider, ['--capture-android-adb']);
  const adbIndex = args.indexOf('--adb');
  args[adbIndex + 1] = path.join(provider.targetDir, 'missing-adb');
  const result = await execFileResult(process.execPath, args, {
    cwd: provider.targetDir,
    env: process.env,
  });
  assert.equal(result.exitCode, 1);
  const captureDir = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb');
  const records = await Promise.all(['target-serial', 'target-package', 'gfxinfo', 'framestats', 'meminfo'].map(async (sourceId) => (
    JSON.parse(await fsp.readFile(path.join(captureDir, `${sourceId}.command.json`), 'utf8'))
  )));
  assert.equal(records.length, 5);
  for (const record of records) {
    assert.equal(record.status, 'failed');
    assert.equal(record.errorCode, 'ENOENT');
    assert.match(record.errorMessage, /missing-adb/u);
  }
});

test('generated provider rejects truncated Android output even when the terminated command exits cleanly', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_OVERFLOW: 'framestats' },
  });
  assert.equal(result.exitCode, 1);
  const captureDir = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb');
  const commandRecord = JSON.parse(await fsp.readFile(path.join(captureDir, 'framestats.command.json'), 'utf8'));
  assert.equal(commandRecord.exitCode, 0);
  assert.equal(commandRecord.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.equal(commandRecord.status, 'failed');
  const truncatedStdout = await fsp.readFile(path.join(captureDir, 'framestats.stdout.txt'), 'utf8');
  assert.equal(parseAndroidFramestatsSummary(truncatedStdout).frameCount, 1, 'fixture must contain parseable framestats before overflow');
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'framestats').status, 'failed');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'captured');
  assert.equal(evidence.frames.frameCount, undefined, 'truncated framestats must not contribute parsed metrics');
  assert.equal(evidence.frames.p50FrameMs, undefined, 'truncated framestats must not contribute frame timing');
});

test('generated provider does not verify target binding from truncated zero-exit target output', async (t: TestContext) => {
  for (const sourceId of ['target-serial', 'target-package']) {
    const provider = await createGeneratedProvider(t);
    const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
      cwd: provider.targetDir,
      env: { ...process.env, FAKE_ADB_OVERFLOW: sourceId },
    });
    assert.equal(result.exitCode, 1);
    const captureDir = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb');
    const commandRecord = JSON.parse(await fsp.readFile(path.join(captureDir, `${sourceId}.command.json`), 'utf8'));
    assert.equal(commandRecord.exitCode, 0);
    assert.equal(commandRecord.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.equal(commandRecord.status, 'failed');
    const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
    assert.equal(evidence.targetBinding.status, 'unverified', sourceId);
  }
});

test('generated provider classifies an observed Android serial difference as target mismatch', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_SERIAL: 'emulator-5556' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'mismatch');
  assert.deepEqual(evidence.targetBinding.candidateTargets.map((candidate: Record<string, unknown>) => candidate.bindingStatus), ['expected', 'observed']);
  assert.equal(evidence.targetBinding.candidateTargets[1].deviceId, 'emulator-5556');
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, evidence.targetBinding.candidateTargets[1].evidencePath), 'utf8'));
  assert.equal(targetProof.status, 'mismatch');
  assert.equal(targetProof.observedDeviceId, 'emulator-5556');
});

test('generated provider lifecycle actions fail closed when the runner request is missing', async (t: TestContext) => {
  for (const platform of ['android', 'ios'] as const) {
    const provider = await createGeneratedProvider(t);
    await assertRequestGuardFailure({
      args: platform === 'android'
        ? androidLifecycleArgs(provider, 'start-window')
        : iosLifecycleArgs(provider, 'start-window'),
      cwd: provider.targetDir,
      env: process.env,
      provider,
      stderrPattern: /native-performance request/i,
    });
  }
});

test('generated provider lifecycle actions fail closed when the runner request is malformed', async (t: TestContext) => {
  for (const platform of ['android', 'ios'] as const) {
    const provider = await createGeneratedProvider(t);
    await writeNativePerformanceRequest({
      platform,
      runDir: provider.runDir,
      text: '{"kind":"nativePerformanceRequest"\n',
    });
    await assertRequestGuardFailure({
      args: platform === 'android'
        ? androidLifecycleArgs(provider, 'start-window')
        : iosLifecycleArgs(provider, 'start-window'),
      cwd: provider.targetDir,
      env: process.env,
      provider,
      stderrPattern: /missing or invalid/i,
    });
  }
});

test('generated provider lifecycle actions fail closed when the runner request platform is wrong', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  await writeNativePerformanceRequest({
    platform: 'android',
    runDir: provider.runDir,
  });
  await assertRequestGuardFailure({
    args: iosLifecycleArgs(provider, 'start-window'),
    cwd: provider.targetDir,
    env: process.env,
    provider,
    stderrPattern: /platform mismatch/i,
  });
});

test('generated provider lifecycle actions fail closed when the runner request carries a mismatched iOS identity', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  await writeNativePerformanceRequest({
    platform: 'ios',
    record: {
      ...buildNativePerformanceRequestRecord('ios'),
      target: {
        appId: 'com.example.ios',
        bundleId: 'com.example.other',
        targetId: 'SIM-UDID-123',
        udid: 'SIM-UDID-999',
      },
    },
    runDir: provider.runDir,
  });
  await assertRequestGuardFailure({
    args: iosLifecycleArgs(provider, 'start-window'),
    cwd: provider.targetDir,
    env: process.env,
    provider,
    stderrPattern: /iOS target does not match/i,
  });
});

test('generated provider lifecycle actions fail closed when the runner request carries a mismatched Android identity', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  await writeNativePerformanceRequest({
    platform: 'android',
    record: {
      ...buildNativePerformanceRequestRecord('android'),
      target: {
        appId: 'com.example.app',
        packageName: 'com.example.other',
        serial: 'emulator-5556',
        targetId: 'emulator-5554',
      },
    },
    runDir: provider.runDir,
  });
  await assertRequestGuardFailure({
    args: androidLifecycleArgs(provider, 'start-window'),
    cwd: provider.targetDir,
    env: process.env,
    provider,
    stderrPattern: /Android target does not match/i,
  });
});

test('generated provider live normalize actions require the staged request before managed capture begins', async (t: TestContext) => {
  const iosProvider = await createGeneratedProvider(t);
  await assertRequestGuardFailure({
    args: withoutRequestArg(iosLifecycleArgs(iosProvider, 'normalize')),
    cwd: iosProvider.targetDir,
    env: { ...process.env, ASL_NATIVE_PERFORMANCE_IOS_CAPTURE: '1' },
    provider: iosProvider,
    stderrPattern: /native-performance request/i,
  });

  const androidProvider = await createGeneratedProvider(t);
  await assertRequestGuardFailure({
    args: withoutRequestArg(androidLifecycleArgs(androidProvider, 'normalize')),
    cwd: androidProvider.targetDir,
    env: { ...process.env, ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE: '1' },
    provider: androidProvider,
    stderrPattern: /native-performance request/i,
  });
});

test('generated provider preserves partial iOS xctrace evidence and exits nonzero after TOC export failure', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, iosProviderArgs(provider, ['--capture-ios-xctrace']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_XCRUN_FAIL: 'xctrace-export-toc' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.completenessStatus, 'partial');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'xctrace').status, 'failed');
  assert.equal(fs.existsSync(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'ios-xctrace', 'xctrace-export-toc.command.json')), true);
  assert.equal(fs.existsSync(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'ios-xctrace', 'trace-bundle-inventory.json')), true);
});

test('generated provider rejects contradictory iOS xctrace duration metadata', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, iosProviderArgs(provider, ['--capture-ios-xctrace']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_XCRUN_DURATION: '1.000000' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.completenessStatus, 'partial');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.traces, undefined);
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json'), 'utf8'));
  assert.equal(targetProof.tocVerified, true);
  assert.equal(targetProof.windowVerified, false);
});

test('generated provider rejects an iOS xctrace window longer than the requested capture limit', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, iosProviderArgs(provider, ['--capture-ios-xctrace']), {
    cwd: provider.targetDir,
    env: {
      ...process.env,
      FAKE_XCRUN_DURATION: '30.000000',
      FAKE_XCRUN_END_AT: '2026-07-13T18:47:30.000Z',
    },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.traces, undefined);
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json'), 'utf8'));
  assert.equal(targetProof.tocVerified, true);
  assert.equal(targetProof.windowVerified, false);
});

test('generated provider keeps iOS xctrace target unverified when no expected app pid was observed', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, iosProviderArgs(provider, ['--capture-ios-xctrace']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_SIMCTL_LABEL: 'UIKitApplication:com.example.other[FAKE-INSTANCE]' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.targetBinding.candidateTargets, undefined);
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'target-binding.json'), 'utf8'));
  assert.equal(targetProof.requestedPid, 0);
  assert.equal(targetProof.status, 'unverified');
});

test('generated provider classifies iOS xctrace target mismatch and preserves expected versus observed target evidence', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, iosProviderArgs(provider, ['--capture-ios-xctrace']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_XCRUN_RECORDED_DEVICE: 'SIM-OTHER-999' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'mismatch');
  assert.deepEqual(evidence.targetBinding.candidateTargets.map((candidate: Record<string, unknown>) => candidate.bindingStatus), ['expected', 'observed']);
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, evidence.targetBinding.candidateTargets[0].evidencePath), 'utf8'));
  assert.equal(targetProof.status, 'mismatch');
  assert.equal(targetProof.recordedDeviceId, 'SIM-OTHER-999');
});
