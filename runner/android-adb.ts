#!/usr/bin/env node

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  adb?: string | boolean;
  'capture-logcat'?: string | boolean;
  'clear-logcat'?: string | boolean;
  launch?: string | boolean;
  'logcat-lines'?: string | boolean;
  out?: string | boolean;
  package?: string | boolean;
  'run-id'?: string | boolean;
  serial?: string | boolean;
  'wait-ms'?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};

type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;
type ExecFileError = Error & {
  code?: number;
};

type AndroidDevice = {
  serial: string;
  state: string;
  description: string;
};

type AndroidPreflightResult = {
  agentSummary: string;
  device: AndroidDevice | null;
  health: Record<string, unknown>;
  metadata: Record<string, unknown>;
  raw: Record<string, string>;
  runDir: string;
  verdict: Record<string, unknown>;
};

type AndroidPreflightOptions = {
  adbPath?: string;
  captureLogcat?: boolean;
  clearLogcat?: boolean;
  delay?: (ms: number) => Promise<void>;
  executor?: CommandExecutor;
  launch?: boolean;
  logcatLines?: number;
  outputDir?: string;
  packageName?: string | null;
  runId?: string;
  serial?: string | null;
  waitMs?: number;
};

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-android-adb [--adb <path>] [--serial <device>] [--package <name>] [--run-id <id>] [--out <dir>]',
    '',
    'Checks adb/device readiness and writes health.json, verdict.json, agent-summary.md, and raw adb evidence.',
    'Use --capture-logcat [--logcat-lines <count>] to attach a bounded adb logcat snapshot under raw/adb-logcat.txt.',
    'Use --clear-logcat --launch --wait-ms <ms> with --package <name> to capture a bounded app launch window.',
  ], output);
}

/**
 * Parses `--key value` arguments for the Android adb preflight CLI.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      continue;
    }
    if (!token || !token.startsWith('--')) {
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
 * Creates a short random run id for Android preflight runs.
 *
 * @returns {string}
 */
function createRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Parses a positive integer CLI value, falling back when absent or invalid.
 *
 * @param {string | boolean | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInteger(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Runs a command and captures stdout, stderr, and exit code without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<CommandResult>}
 */
function execFileCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, (error: ExecFileError | null, stdout: string, stderr: string) => {
      resolve({
        command,
        args,
        exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stderr,
        stdout,
      });
    });
  });
}

/**
 * Waits for the requested capture window.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Parses `adb devices -l` output into device rows.
 *
 * @param {string} output
 * @returns {AndroidDevice[]}
 */
function parseAdbDevices(output: string): AndroidDevice[] {
  return String(output)
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = '', state = '', ...rest] = line.split(/\s+/u);
      return {
        serial,
        state,
        description: rest.join(' '),
      };
    })
    .filter((device) => device.serial.length > 0);
}

/**
 * Selects an Android device by explicit serial or first online device.
 *
 * @param {AndroidDevice[]} devices
 * @param {string | null | undefined} serial
 * @returns {AndroidDevice | null}
 */
function selectDevice(devices: AndroidDevice[], serial?: string | null): AndroidDevice | null {
  if (serial) {
    return devices.find((device) => device.serial === serial) ?? null;
  }

  return devices.find((device) => device.state === 'device') ?? null;
}

/**
 * Builds a runner health artifact from adb preflight checks.
 *
 * @param {{runId: string, checks: Record<string, unknown>[]}} options
 * @returns {Record<string, unknown>}
 */
function buildAndroidHealth({ runId, checks }: { runId: string; checks: Record<string, unknown>[] }): Record<string, unknown> {
  const failed = checks.some((check) => check.status === 'failed');
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'android-adb-preflight',
      flowId: 'android-adb-preflight',
      runId,
      healthStatus: failed ? 'failed' : 'passed',
      checks,
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Builds a verdict artifact for adb preflight readiness.
 *
 * @param {{runId: string, health: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildAndroidVerdict({ runId, health }: { runId: string; health: Record<string, unknown> }): Record<string, unknown> {
  const passed = health.healthStatus === 'passed';
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'android-adb-preflight',
      flowId: 'android-adb-preflight',
      runId,
      healthStatus: health.healthStatus,
      verdictStatus: passed ? 'not_evaluated' : 'inconclusive',
      budgetChecks: [],
      summary: passed
        ? 'Android adb preflight passed; no product budget has been evaluated.'
        : 'Android adb preflight failed; runtime scenario execution is not ready.',
    },
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
}

/**
 * Runs Android adb readiness checks and writes the preflight artifact set.
 *
 * @param {AndroidPreflightOptions} options
 * @returns {Promise<AndroidPreflightResult>}
 */
async function runAndroidAdbPreflight({
  adbPath = 'adb',
  captureLogcat = false,
  clearLogcat = false,
  delay: wait = delay,
  executor = execFileCommand,
  launch = false,
  logcatLines = 1000,
  outputDir = path.resolve('artifacts/android-adb-preflight'),
  packageName = null,
  runId = createRunId(),
  serial = null,
  waitMs = 0,
}: AndroidPreflightOptions = {}): Promise<AndroidPreflightResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  await fsp.mkdir(rawDir, { recursive: true });

  const raw: Record<string, string> = {};
  const checks: Record<string, unknown>[] = [];
  const version = await executor(adbPath, ['version']);
  raw['adb-version.txt'] = [version.stdout, version.stderr].filter(Boolean).join('\n');
  checks.push({
    name: 'adb_available',
    status: version.exitCode === 0 ? 'passed' : 'failed',
    source: 'runner',
    code: version.exitCode === 0 ? 'adb_available' : 'adb_unavailable',
    message: version.exitCode === 0 ? 'adb command is available.' : 'adb command could not be executed.',
  });

  const devicesOutput = version.exitCode === 0
    ? await executor(adbPath, ['devices', '-l'])
    : {
        command: adbPath,
        args: ['devices', '-l'],
        exitCode: 1,
        stderr: 'adb unavailable',
        stdout: '',
      };
  raw['adb-devices.txt'] = [devicesOutput.stdout, devicesOutput.stderr].filter(Boolean).join('\n');
  const devices = parseAdbDevices(devicesOutput.stdout);
  const device = selectDevice(devices, serial);
  checks.push({
    name: 'android_device_connected',
    status: device && device.state === 'device' ? 'passed' : 'failed',
    source: 'runner',
    code: device && device.state === 'device' ? 'android_device_connected' : 'android_device_missing',
    message: device && device.state === 'device'
      ? `Selected Android device ${device.serial}.`
      : serial
        ? `No online Android device matched serial ${serial}.`
        : 'No online Android device was found.',
  });

  const metadata: Record<string, unknown> = {
    adbPath,
    captureLogcat,
    clearLogcat,
    devices,
    launch,
    logcatLines,
    selectedDevice: device,
    packageName,
    waitMs,
  };

  if (device && device.state === 'device') {
    const shellPrefix = ['-s', device.serial, 'shell'];
    const [model, release, sdk] = await Promise.all([
      executor(adbPath, [...shellPrefix, 'getprop', 'ro.product.model']),
      executor(adbPath, [...shellPrefix, 'getprop', 'ro.build.version.release']),
      executor(adbPath, [...shellPrefix, 'getprop', 'ro.build.version.sdk']),
    ]);
    metadata.deviceProperties = {
      model: model.stdout.trim(),
      release: release.stdout.trim(),
      sdk: sdk.stdout.trim(),
    };
    raw['adb-device-properties.txt'] = [
      `model=${model.stdout.trim()}`,
      `release=${release.stdout.trim()}`,
      `sdk=${sdk.stdout.trim()}`,
    ].join('\n');

    if (packageName) {
      const packageCheck = await executor(adbPath, [...shellPrefix, 'pm', 'path', packageName]);
      raw['adb-package.txt'] = [packageCheck.stdout, packageCheck.stderr].filter(Boolean).join('\n');
      checks.push({
        name: 'android_package_installed',
        status: packageCheck.exitCode === 0 && packageCheck.stdout.includes('package:') ? 'passed' : 'failed',
        source: 'runner',
        code: packageCheck.exitCode === 0 && packageCheck.stdout.includes('package:')
          ? 'android_package_installed'
          : 'android_package_missing',
        message: packageCheck.exitCode === 0 && packageCheck.stdout.includes('package:')
          ? `Package ${packageName} is installed.`
          : `Package ${packageName} is not installed on ${device.serial}.`,
      });
    }

    if (clearLogcat) {
      const clear = await executor(adbPath, ['-s', device.serial, 'logcat', '-c']);
      raw['adb-logcat-clear.txt'] = [clear.stdout, clear.stderr].filter(Boolean).join('\n');
      checks.push({
        name: 'android_logcat_cleared',
        status: clear.exitCode === 0 ? 'passed' : 'failed',
        source: 'runner',
        code: clear.exitCode === 0 ? 'android_logcat_cleared' : 'android_logcat_clear_failed',
        message: clear.exitCode === 0 ? 'Cleared adb logcat before capture.' : 'adb logcat clear failed.',
      });
      metadata.logcatClear = {
        args: clear.args,
        exitCode: clear.exitCode,
        rawPath: 'raw/adb-logcat-clear.txt',
      };
    }

    if (launch) {
      if (!packageName) {
        checks.push({
          name: 'android_package_launched',
          status: 'failed',
          source: 'runner',
          code: 'android_launch_missing_package',
          message: 'Package launch was requested, but --package was not provided.',
        });
      } else {
        const launchResult = await executor(adbPath, [
          '-s',
          device.serial,
          'shell',
          'monkey',
          '-p',
          packageName,
          '-c',
          'android.intent.category.LAUNCHER',
          '1',
        ]);
        raw['adb-launch.txt'] = [launchResult.stdout, launchResult.stderr].filter(Boolean).join('\n');
        checks.push({
          name: 'android_package_launched',
          status: launchResult.exitCode === 0 ? 'passed' : 'failed',
          source: 'runner',
          code: launchResult.exitCode === 0 ? 'android_package_launched' : 'android_package_launch_failed',
          message: launchResult.exitCode === 0
            ? `Launched package ${packageName}.`
            : `Failed to launch package ${packageName}.`,
        });
        metadata.launchResult = {
          args: launchResult.args,
          exitCode: launchResult.exitCode,
          rawPath: 'raw/adb-launch.txt',
        };
      }
    }

    if (waitMs > 0 && captureLogcat) {
      await wait(waitMs);
      checks.push({
        name: 'android_capture_window_waited',
        status: 'passed',
        source: 'runner',
        code: 'android_capture_window_waited',
        message: `Waited ${waitMs}ms before capturing adb logcat.`,
      });
    }

    if (captureLogcat) {
      const logcat = await executor(adbPath, [
        '-s',
        device.serial,
        'logcat',
        '-d',
        '-v',
        'time',
        '-t',
        String(logcatLines),
      ]);
      raw['adb-logcat.txt'] = [logcat.stdout, logcat.stderr].filter(Boolean).join('\n');
      checks.push({
        name: 'android_logcat_captured',
        status: logcat.exitCode === 0 ? 'passed' : 'failed',
        source: 'runner',
        code: logcat.exitCode === 0 ? 'android_logcat_captured' : 'android_logcat_failed',
        message: logcat.exitCode === 0
          ? `Captured the last ${logcatLines} adb logcat lines.`
          : 'adb logcat capture failed.',
      });
      metadata.logcat = {
        args: logcat.args,
        exitCode: logcat.exitCode,
        rawPath: 'raw/adb-logcat.txt',
      };
    }
  } else {
    if (clearLogcat || launch) {
      checks.push({
        name: 'android_capture_window_started',
        status: 'failed',
        source: 'runner',
        code: 'android_capture_window_no_device',
        message: 'Android capture window setup was requested, but no online Android device was selected.',
      });
    }

    if (captureLogcat) {
      checks.push({
        name: 'android_logcat_captured',
        status: 'failed',
        source: 'runner',
        code: 'android_logcat_no_device',
        message: 'adb logcat capture was requested, but no online Android device was selected.',
      });
    }
  }

  const health = buildAndroidHealth({ runId, checks });
  const verdict = buildAndroidVerdict({ runId, health });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });

  await Promise.all(
    Object.entries(raw).map(([fileName, content]) =>
      fsp.writeFile(path.join(rawDir, fileName), `${content.trimEnd()}\n`, 'utf8'),
    ),
  );
  await fsp.writeFile(path.join(rawDir, 'android-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await writeJsonArtifact({
    filePath: layout.health,
    value: health,
    schema: SCHEMAS.health,
    label: 'Health artifact',
  });
  await writeJsonArtifact({
    filePath: layout.verdict,
    value: verdict,
    schema: SCHEMAS.verdict,
    label: 'Verdict artifact',
  });
  await writeTextArtifact({
    filePath: layout.agentSummary,
    content: agentSummary,
  });

  return {
    agentSummary,
    device,
    health,
    metadata,
    raw,
    runDir,
    verdict,
  };
}

/**
 * Runs the android-adb preflight CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const args = parseArgs(argv);
  const result = await runAndroidAdbPreflight({
    ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
    captureLogcat: args['capture-logcat'] === true || args['capture-logcat'] === 'true',
    clearLogcat: args['clear-logcat'] === true || args['clear-logcat'] === 'true',
    launch: args.launch === true || args.launch === 'true',
    logcatLines: parsePositiveInteger(args['logcat-lines'], 1000),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    ...(typeof args.package === 'string' ? { packageName: args.package } : {}),
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    waitMs: parsePositiveInteger(args['wait-ms'], 0),
  });
  process.stdout.write(`${result.runDir}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildAndroidHealth,
  buildAndroidVerdict,
  execFileCommand,
  main,
  parseAdbDevices,
  parseArgs,
  parsePositiveInteger,
  runAndroidAdbPreflight,
  selectDevice,
  usage,
};

export type {
  AndroidDevice,
  AndroidPreflightOptions,
  AndroidPreflightResult,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
