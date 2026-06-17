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
const {
  buildAndroidScrollCoordinatesFromBounds,
  createAndroidAdbDriver,
  formatAndroidAdbRawOutput,
  quoteAndroidShellArg,
  resolveAndroidSelectorFromUiTree,
} = require('./android-adb-driver');

type CliArgs = {
  adb?: string | boolean;
  'capture-logcat'?: string | boolean;
  'clear-logcat'?: string | boolean;
  launch?: string | boolean;
  'logcat-lines'?: string | boolean;
  out?: string | boolean;
  package?: string | boolean;
  'react-native-debug-host'?: string | boolean;
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

type AndroidDeepLinkCommand = {
  label?: string;
  url: string;
  waitMs?: number;
};

type AndroidAdbDriverStep = {
  captureFileName?: string;
  driverAction: 'assertVisible' | 'inspectTree' | 'readLogs' | 'record' | 'screenshot' | 'scroll' | 'tap';
  durationMs?: number;
  durationSeconds?: number;
  endX?: number;
  endY?: number;
  lines?: number;
  rawFileName?: string;
  remotePath?: string;
  required?: boolean;
  selector?: import('./android-adb-driver').AndroidSelector;
  stepId?: string;
  startX?: number;
  startY?: number;
  waitMs?: number;
  x?: number;
  y?: number;
};

type AndroidSelectorResolutionMetadata = {
  bounds?: import('./android-adb-driver').AndroidAdbBounds;
  driverAction: AndroidAdbDriverStep['driverAction'];
  rawPath: string;
  selector?: import('./android-adb-driver').AndroidSelector;
  status: 'failed' | 'passed';
  stepId?: string;
};

type AndroidPreflightOptions = {
  adbPath?: string;
  captureLogcat?: boolean;
  clearLogcat?: boolean;
  deepLinks?: AndroidDeepLinkCommand[];
  delay?: (ms: number) => Promise<void>;
  driverSteps?: AndroidAdbDriverStep[];
  executor?: CommandExecutor;
  launch?: boolean;
  logcatLines?: number;
  outputDir?: string;
  packageName?: string | null;
  reactNativeDebugHost?: string | null;
  runId?: string;
  serial?: string | null;
  waitMs?: number;
};
type NextActionHint = {
  nextAction: string;
  nextActionCode: string;
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
    'Use --react-native-debug-host <host:port> with --package <name> to set the app debug server and adb reverse for React Native dev builds.',
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
 * Creates scalar health-check metadata for an agent-readable next action.
 *
 * @param {string} nextActionCode
 * @param {string} nextAction
 * @returns {NextActionHint}
 */
function nextActionHint(nextActionCode: string, nextAction: string): NextActionHint {
  return {
    nextAction,
    nextActionCode,
  };
}

/**
 * Reads the TCP port from a React Native debug server host string.
 *
 * @param {string} debugHost
 * @returns {number | null}
 */
function parseReactNativeDebugHostPort(debugHost: string): number | null {
  if (debugHost.includes('://')) {
    return null;
  }

  const match = /:(?<port>\d+)$/u.exec(debugHost);
  const port = match?.groups?.port ? Number(match.groups.port) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/**
 * Escapes text for the Android shared preference XML file.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeAndroidPreferenceXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/**
 * Builds a device-side shell command that writes React Native debug host preferences.
 *
 * @param {{debugHost: string, packageName: string}} options
 * @returns {string}
 */
function buildReactNativeDebugHostPreferenceCommand({
  debugHost,
  packageName,
}: {
  debugHost: string;
  packageName: string;
}): string {
  const preferenceFile = `shared_prefs/${packageName}_preferences.xml`;
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>',
    '<map>',
    `    <string name="debug_http_host">${escapeAndroidPreferenceXml(debugHost)}</string>`,
    '</map>',
  ];

  return [
    `cd ${quoteAndroidShellArg(`/data/data/${packageName}`)}`,
    'mkdir -p shared_prefs',
    [
      `printf ${quoteAndroidShellArg('%s\\n')}`,
      ...lines.map((line) => quoteAndroidShellArg(line)),
      `> ${quoteAndroidShellArg(preferenceFile)}`,
    ].join(' '),
  ].join(' && ');
}

/**
 * Combines one adb command result into raw evidence text.
 *
 * @param {CommandResult} result
 * @returns {string}
 */
function formatAndroidCommandRawOutput(result: CommandResult): string {
  return [
    `$ adb ${result.args.join(' ')}`,
    `exitCode=${result.exitCode}`,
    result.stdout,
    result.stderr,
  ].filter(Boolean).join('\n');
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
 * Builds the driver steps for this adb capture window.
 *
 * @param {{captureLogcat: boolean, driverSteps: AndroidAdbDriverStep[], logcatLines: number, waitMs: number}} options
 * @returns {AndroidAdbDriverStep[]}
 */
function resolveAndroidAdbDriverSteps({
  captureLogcat,
  driverSteps,
  logcatLines,
  waitMs,
}: {
  captureLogcat: boolean;
  driverSteps: AndroidAdbDriverStep[];
  logcatLines: number;
  waitMs: number;
}): AndroidAdbDriverStep[] {
  if (driverSteps.length > 0) {
    let readLogsIndex = 0;
    return driverSteps.map((step, index) => {
      const actionIndex = index + 1;
      if (step.driverAction === 'readLogs') {
        readLogsIndex += 1;
      }

      return {
        ...step,
        ...(step.driverAction === 'readLogs' ? { lines: step.lines ?? logcatLines } : {}),
        rawFileName: step.rawFileName ?? defaultAndroidAdbRawFileName({
          driverAction: step.driverAction,
          index: actionIndex,
          readLogsIndex,
        }),
        ...(step.driverAction === 'record'
          ? {
              captureFileName: step.captureFileName ?? defaultAndroidAdbCaptureFileName({
                driverAction: step.driverAction,
                index: actionIndex,
              }),
            }
          : {}),
        required: step.required !== false,
      };
    });
  }

  return captureLogcat
    ? [{
        driverAction: 'readLogs',
        lines: logcatLines,
        rawFileName: 'adb-logcat.txt',
        required: true,
        ...(waitMs > 0 ? { waitMs } : {}),
      }]
    : [];
}

/**
 * Returns the default raw evidence filename for one adb driver action.
 *
 * @param {{driverAction: AndroidAdbDriverStep['driverAction'], index: number, readLogsIndex: number}} options
 * @returns {string}
 */
function defaultAndroidAdbRawFileName({
  driverAction,
  index,
  readLogsIndex,
}: {
  driverAction: AndroidAdbDriverStep['driverAction'];
  index: number;
  readLogsIndex: number;
}): string {
  if (driverAction === 'readLogs') {
    return readLogsIndex === 1 ? 'adb-logcat.txt' : `adb-logcat-${readLogsIndex}.txt`;
  }

  const suffix = index === 1 ? '' : `-${index}`;
  if (driverAction === 'inspectTree') {
    return `adb-ui-tree${suffix}.xml`;
  }
  if (driverAction === 'assertVisible') {
    return `adb-assert-visible${suffix}.xml`;
  }
  if (driverAction === 'screenshot') {
    return `adb-screenshot${suffix}.png`;
  }

  return `adb-${driverAction}${suffix}.txt`;
}

/**
 * Returns the default capture filename for one adb driver action.
 *
 * @param {{driverAction: AndroidAdbDriverStep['driverAction'], index: number}} options
 * @returns {string}
 */
function defaultAndroidAdbCaptureFileName({
  driverAction,
  index,
}: {
  driverAction: AndroidAdbDriverStep['driverAction'];
  index: number;
}): string {
  const suffix = index === 1 ? '' : `-${index}`;
  if (driverAction === 'record') {
    return `adb-record${suffix}.mp4`;
  }

  return `adb-${driverAction}${suffix}`;
}

/**
 * Builds a stable health code suffix for an adb driver action.
 *
 * @param {AndroidAdbDriverStep['driverAction']} driverAction
 * @returns {string}
 */
function androidDriverActionCode(driverAction: AndroidAdbDriverStep['driverAction']): string {
  return driverAction.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Returns whether a driver step can derive missing coordinates from a selector.
 *
 * @param {AndroidAdbDriverStep} driverStep
 * @returns {boolean}
 */
function needsAndroidSelectorResolution(driverStep: AndroidAdbDriverStep): boolean {
  if (!driverStep.selector) {
    return false;
  }

  if (driverStep.driverAction === 'tap') {
    return typeof driverStep.x !== 'number' || typeof driverStep.y !== 'number';
  }

  return driverStep.driverAction === 'scroll' && (
    typeof driverStep.startX !== 'number' ||
    typeof driverStep.startY !== 'number' ||
    typeof driverStep.endX !== 'number' ||
    typeof driverStep.endY !== 'number'
  );
}

/**
 * Applies a resolved selector to one tap or scroll driver step.
 *
 * @param {{driverStep: AndroidAdbDriverStep, resolution: import('./android-adb-driver').AndroidSelectorResolution}} options
 * @returns {AndroidAdbDriverStep}
 */
function applyAndroidSelectorResolution({
  driverStep,
  resolution,
}: {
  driverStep: AndroidAdbDriverStep;
  resolution: import('./android-adb-driver').AndroidSelectorResolution;
}): AndroidAdbDriverStep {
  if (driverStep.driverAction === 'tap') {
    return {
      ...driverStep,
      x: driverStep.x ?? resolution.centerX,
      y: driverStep.y ?? resolution.centerY,
    };
  }

  if (driverStep.driverAction === 'scroll') {
    const coordinates = buildAndroidScrollCoordinatesFromBounds(resolution.bounds);
    return {
      ...driverStep,
      endX: driverStep.endX ?? coordinates.endX,
      endY: driverStep.endY ?? coordinates.endY,
      startX: driverStep.startX ?? coordinates.startX,
      startY: driverStep.startY ?? coordinates.startY,
    };
  }

  return driverStep;
}

/**
 * Converts a selector into scalar health-check metadata fields.
 *
 * @param {import('./android-adb-driver').AndroidSelector | undefined} selector
 * @returns {Record<string, string>}
 */
function buildAndroidSelectorHealthMetadata(
  selector: import('./android-adb-driver').AndroidSelector | undefined,
): Record<string, string> {
  if (!selector) {
    return {};
  }

  return {
    selectorKind: selector.kind,
    selectorValue: selector.value,
    ...(selector.match ? { selectorMatch: selector.match } : {}),
  };
}

/**
 * Runs one normalized adb driver step through the Android driver adapter.
 *
 * @param {{driver: import('./android-adb-driver').AndroidAdbDriver, driverStep: AndroidAdbDriverStep, logcatLines: number}} options
 * @returns {Promise<import('./android-adb-driver').AndroidAdbCommandResult>}
 */
async function runAndroidAdbDriverStep({
  capturesDir,
  driver,
  driverStep,
  logcatLines,
}: {
  capturesDir: string;
  driver: import('./android-adb-driver').AndroidAdbDriver;
  driverStep: AndroidAdbDriverStep;
  logcatLines: number;
}): Promise<import('./android-adb-driver').AndroidAdbCommandResult> {
  if (driverStep.driverAction === 'readLogs') {
    return driver.readLogs({
      lines: driverStep.lines ?? logcatLines,
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }

  if (driverStep.driverAction === 'inspectTree') {
    return driver.inspectTree({
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }

  if (driverStep.driverAction === 'assertVisible') {
    if (!driverStep.selector) {
      return {
        action: 'assertVisible',
        args: [],
        command: 'adb',
        exitCode: 1,
        rawFileName: driverStep.rawFileName ?? 'adb-assert-visible.xml',
        stderr: 'assertVisible driver action requires a selector.',
        stdout: '',
      };
    }

    return driver.assertVisible({
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
      selector: driverStep.selector,
    });
  }

  if (driverStep.driverAction === 'record') {
    const captureFileName = driverStep.captureFileName ?? 'adb-record.mp4';
    return driver.record({
      ...(typeof driverStep.durationSeconds === 'number' ? { durationSeconds: driverStep.durationSeconds } : {}),
      outputPath: path.join(capturesDir, captureFileName),
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
      ...(typeof driverStep.remotePath === 'string' ? { remotePath: driverStep.remotePath } : {}),
    });
  }

  if (driverStep.driverAction === 'screenshot') {
    return driver.screenshot({
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }

  if (driverStep.driverAction === 'scroll') {
    if (
      typeof driverStep.startX !== 'number' ||
      typeof driverStep.startY !== 'number' ||
      typeof driverStep.endX !== 'number' ||
      typeof driverStep.endY !== 'number'
    ) {
      return {
        action: 'scroll',
        args: [],
        command: 'adb',
        exitCode: 1,
        rawFileName: driverStep.rawFileName ?? 'adb-scroll.txt',
        stderr: 'scroll driver action requires startX, startY, endX, and endY.',
        stdout: '',
      };
    }

    return driver.scroll({
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      endX: driverStep.endX,
      endY: driverStep.endY,
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
      startX: driverStep.startX,
      startY: driverStep.startY,
    });
  }

  if (typeof driverStep.x !== 'number' || typeof driverStep.y !== 'number') {
    return {
      action: 'tap',
      args: [],
      command: 'adb',
      exitCode: 1,
      rawFileName: driverStep.rawFileName ?? 'adb-tap.txt',
      stderr: 'tap driver action requires x and y.',
      stdout: '',
    };
  }

  return driver.tap({
    ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
    x: driverStep.x,
    y: driverStep.y,
  });
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
  deepLinks = [],
  delay: wait = delay,
  driverSteps = [],
  executor = execFileCommand,
  launch = false,
  logcatLines = 1000,
  outputDir = path.resolve('artifacts/android-adb-preflight'),
  packageName = null,
  reactNativeDebugHost = null,
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
  const adbAvailable = version.exitCode === 0;
  raw['adb-version.txt'] = [version.stdout, version.stderr].filter(Boolean).join('\n');
  checks.push({
    name: 'adb_available',
    status: adbAvailable ? 'passed' : 'failed',
    source: 'runner',
    code: adbAvailable ? 'adb_available' : 'adb_unavailable',
    message: adbAvailable ? 'adb command is available.' : 'adb command could not be executed.',
    ...(!adbAvailable
      ? {
          metadata: nextActionHint(
            'fix_adb_command',
            'Install Android platform-tools or pass --adb with a working adb binary, then rerun the capture.',
          ),
        }
      : {}),
  });

  const devicesOutput = adbAvailable
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
  const deviceOnline = Boolean(device && device.state === 'device');
  checks.push({
    name: 'android_device_connected',
    status: deviceOnline ? 'passed' : 'failed',
    source: 'runner',
    code: deviceOnline ? 'android_device_connected' : 'android_device_missing',
    message: deviceOnline && device
      ? `Selected Android device ${device.serial}.`
      : serial
        ? `No online Android device matched serial ${serial}.`
        : 'No online Android device was found.',
    ...(!deviceOnline
      ? {
          metadata: nextActionHint(
            'select_android_device',
            'Start or unlock an Android emulator/device, confirm it appears as `device` in adb devices -l, or pass --serial for the intended device.',
          ),
        }
      : {}),
  });

  const metadata: Record<string, unknown> = {
    adbPath,
    captureLogcat,
    clearLogcat,
    deepLinks,
    devices,
    driverSteps,
    launch,
    logcatLines,
    selectedDevice: device,
    packageName,
    reactNativeDebugHost,
    waitMs,
  };
  const resolvedDriverSteps = resolveAndroidAdbDriverSteps({
    captureLogcat,
    driverSteps,
    logcatLines,
    waitMs,
  });

  if (device && device.state === 'device') {
    const shellPrefix = ['-s', device.serial, 'shell'];
    const driver = createAndroidAdbDriver({
      adbPath,
      deviceSerial: device.serial,
      executor,
    });
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

    let selectedPackageInstalled = false;
    if (packageName) {
      const packageCheck = await executor(adbPath, [...shellPrefix, 'pm', 'path', packageName]);
      raw['adb-package.txt'] = [packageCheck.stdout, packageCheck.stderr].filter(Boolean).join('\n');
      const packageInstalled = packageCheck.exitCode === 0 && packageCheck.stdout.includes('package:');
      selectedPackageInstalled = packageInstalled;
      checks.push({
        name: 'android_package_installed',
        status: packageInstalled ? 'passed' : 'failed',
        source: 'runner',
        code: packageInstalled
          ? 'android_package_installed'
          : 'android_package_missing',
        message: packageInstalled
          ? `Package ${packageName} is installed.`
          : `Package ${packageName} is not installed on ${device.serial}.`,
        ...(!packageInstalled
          ? {
              metadata: nextActionHint(
                'install_android_package',
                'Build and install the app on the selected device, or rerun with --package set to the installed application id.',
              ),
            }
          : {}),
      });
    }

    if (reactNativeDebugHost) {
      const reactNativeDebugPort = parseReactNativeDebugHostPort(reactNativeDebugHost);
      if (!packageName) {
        checks.push({
          name: 'android_react_native_debug_host_configured',
          status: 'failed',
          source: 'runner',
          code: 'android_react_native_debug_host_missing_package',
          message: 'React Native debug host setup was requested, but --package was not provided.',
          metadata: nextActionHint(
            'provide_android_package',
            'Rerun with --package set to the installed Android application id when --react-native-debug-host is enabled.',
          ),
        });
      } else if (!selectedPackageInstalled) {
        checks.push({
          name: 'android_react_native_debug_host_configured',
          status: 'failed',
          source: 'runner',
          code: 'android_react_native_debug_host_package_missing',
          message: `React Native debug host setup requires installed package ${packageName}.`,
          metadata: nextActionHint(
            'install_android_package',
            'Build and install the app on the selected device before configuring the React Native debug host.',
          ),
        });
      } else if (!reactNativeDebugPort) {
        checks.push({
          name: 'android_react_native_debug_host_configured',
          status: 'failed',
          source: 'runner',
          code: 'android_react_native_debug_host_invalid',
          message: `React Native debug host ${reactNativeDebugHost} must be a host:port value without a URL scheme.`,
          metadata: nextActionHint(
            'fix_react_native_debug_host',
            'Pass a React Native debug host such as localhost:8097, not a full http:// URL.',
          ),
        });
      } else {
        const reverseResult = await executor(adbPath, [
          '-s',
          device.serial,
          'reverse',
          `tcp:${reactNativeDebugPort}`,
          `tcp:${reactNativeDebugPort}`,
        ]);
        const preferenceCommand = buildReactNativeDebugHostPreferenceCommand({
          debugHost: reactNativeDebugHost,
          packageName,
        });
        const preferenceResult = await executor(adbPath, [
          '-s',
          device.serial,
          'shell',
          'run-as',
          packageName,
          'sh',
          '-c',
          quoteAndroidShellArg(preferenceCommand),
        ]);
        const reversePassed = reverseResult.exitCode === 0;
        const preferencePassed = preferenceResult.exitCode === 0;
        raw['adb-react-native-reverse.txt'] = formatAndroidCommandRawOutput(reverseResult);
        raw['adb-react-native-debug-host.txt'] = formatAndroidCommandRawOutput(preferenceResult);
        checks.push({
          name: 'android_react_native_reverse_configured',
          status: reversePassed ? 'passed' : 'failed',
          source: 'runner',
          code: reversePassed
            ? 'android_react_native_reverse_configured'
            : 'android_react_native_reverse_failed',
          message: reversePassed
            ? `Configured adb reverse for React Native debug port ${reactNativeDebugPort}.`
            : `Failed to configure adb reverse for React Native debug port ${reactNativeDebugPort}.`,
          ...(!reversePassed
            ? {
                metadata: nextActionHint(
                  'inspect_android_react_native_reverse',
                  'Inspect raw/adb-react-native-reverse.txt, confirm the selected device supports adb reverse, then rerun the capture.',
                ),
              }
            : {}),
        });
        checks.push({
          name: 'android_react_native_debug_host_configured',
          status: preferencePassed ? 'passed' : 'failed',
          source: 'runner',
          code: preferencePassed
            ? 'android_react_native_debug_host_configured'
            : 'android_react_native_debug_host_failed',
          message: preferencePassed
            ? `Configured React Native debug host ${reactNativeDebugHost} for ${packageName}.`
            : `Failed to configure React Native debug host ${reactNativeDebugHost} for ${packageName}.`,
          ...(!preferencePassed
            ? {
                metadata: nextActionHint(
                  'inspect_android_react_native_debug_host',
                  'Inspect raw/adb-react-native-debug-host.txt, confirm the app is debuggable and run-as works for the package, then rerun the capture.',
                ),
              }
            : {}),
        });
        metadata.reactNativeDebugHostSetup = {
          debugHost: reactNativeDebugHost,
          port: reactNativeDebugPort,
          preferenceRawPath: 'raw/adb-react-native-debug-host.txt',
          reverseRawPath: 'raw/adb-react-native-reverse.txt',
        };
      }
    }

    if (clearLogcat) {
      const clear = await driver.clearLogs();
      const logcatCleared = clear.exitCode === 0;
      raw[clear.rawFileName] = formatAndroidAdbRawOutput(clear);
      checks.push({
        name: 'android_logcat_cleared',
        status: logcatCleared ? 'passed' : 'failed',
        source: 'runner',
        code: logcatCleared ? 'android_logcat_cleared' : 'android_logcat_clear_failed',
        message: logcatCleared ? 'Cleared adb logcat before capture.' : 'adb logcat clear failed.',
        ...(!logcatCleared
          ? {
              metadata: nextActionHint(
                'inspect_adb_logcat_clear',
                `Inspect raw/${clear.rawFileName}, confirm the selected device allows logcat access, then rerun the capture.`,
              ),
            }
          : {}),
      });
      metadata.logcatClear = {
        args: clear.args,
        exitCode: clear.exitCode,
        rawPath: `raw/${clear.rawFileName}`,
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
          metadata: nextActionHint(
            'provide_android_package',
            'Rerun with --package set to the installed Android application id when --launch is enabled.',
          ),
        });
      } else {
        const launchResult = await driver.launchPackage(packageName);
        const launchPassed = launchResult.exitCode === 0;
        raw[launchResult.rawFileName] = formatAndroidAdbRawOutput(launchResult);
        checks.push({
          name: 'android_package_launched',
          status: launchPassed ? 'passed' : 'failed',
          source: 'runner',
          code: launchPassed ? 'android_package_launched' : 'android_package_launch_failed',
          message: launchPassed
            ? `Launched package ${packageName}.`
            : `Failed to launch package ${packageName}.`,
          ...(!launchPassed
            ? {
                metadata: nextActionHint(
                  'inspect_android_launch',
                  `Inspect raw/${launchResult.rawFileName}, verify the package has a launcher activity, and confirm the app can open manually on the device.`,
                ),
              }
            : {}),
        });
        metadata.launchResult = {
          args: launchResult.args,
          exitCode: launchResult.exitCode,
          rawPath: `raw/${launchResult.rawFileName}`,
        };
      }
    }

    for (const [index, deepLink] of deepLinks.entries()) {
      const rawFileName = `adb-deep-link-${index + 1}.txt`;
      const deepLinkResult = await driver.openDeepLink({
        packageName,
        rawFileName,
        url: deepLink.url,
      });
      const deepLinkOpened = deepLinkResult.exitCode === 0;
      raw[deepLinkResult.rawFileName] = formatAndroidAdbRawOutput(deepLinkResult);
      checks.push({
        name: 'android_deep_link_opened',
        status: deepLinkOpened ? 'passed' : 'failed',
        source: 'runner',
        code: deepLinkOpened ? 'android_deep_link_opened' : 'android_deep_link_failed',
        message: deepLinkOpened
          ? `Opened Android deep link ${deepLink.label ?? index + 1}.`
          : `Failed to open Android deep link ${deepLink.label ?? index + 1}.`,
        ...(!deepLinkOpened
          ? {
              metadata: nextActionHint(
                'inspect_android_deep_link',
                `Inspect raw/${deepLinkResult.rawFileName}, verify the app scheme/intent filter, and rerun with --package if the intent must target one app.`,
              ),
            }
          : {}),
      });

      if (deepLink.waitMs && deepLink.waitMs > 0) {
        await wait(deepLink.waitMs);
        checks.push({
          name: 'android_deep_link_waited',
          status: 'passed',
          source: 'runner',
          code: 'android_deep_link_waited',
          message: `Waited ${deepLink.waitMs}ms after Android deep link ${deepLink.label ?? index + 1}.`,
        });
      }
    }

    const driverActionMetadata: Record<string, unknown>[] = [];
    const logcatMetadata: Record<string, unknown>[] = [];
    const selectorResolutionMetadata: AndroidSelectorResolutionMetadata[] = [];
    for (const [index, driverStep] of resolvedDriverSteps.entries()) {
      if (driverStep.waitMs && driverStep.waitMs > 0) {
        await wait(driverStep.waitMs);
        checks.push({
          name: 'android_capture_window_waited',
          status: 'passed',
          source: 'runner',
          code: 'android_capture_window_waited',
          message: `Waited ${driverStep.waitMs}ms before running adb driver action ${driverStep.driverAction}.`,
          metadata: {
            driverAction: driverStep.driverAction,
            ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
          },
        });
      }

      let executableDriverStep = driverStep;
      if (needsAndroidSelectorResolution(driverStep)) {
        const selectorRawFileName = `adb-selector-tree-${index + 1}.xml`;
        const treeResult = await driver.inspectTree({ rawFileName: selectorRawFileName });
        raw[treeResult.rawFileName] = formatAndroidAdbRawOutput(treeResult);
        const resolution = treeResult.exitCode === 0 && driverStep.selector
          ? resolveAndroidSelectorFromUiTree({
              selector: driverStep.selector,
              uiTreeXml: treeResult.stdout,
            })
          : null;
        const resolved = Boolean(resolution);
        if (resolution) {
          executableDriverStep = applyAndroidSelectorResolution({
            driverStep,
            resolution,
          });
        }
        checks.push({
          name: 'android_selector_resolved',
          status: resolved ? 'passed' : driverStep.required === false ? 'warning' : 'failed',
          source: 'runner',
          code: resolved ? 'android_selector_resolved' : 'android_selector_resolution_failed',
          message: resolved
            ? `Resolved Android selector for adb driver action ${driverStep.driverAction}.`
            : `Failed to resolve Android selector for adb driver action ${driverStep.driverAction}.`,
          metadata: {
            driverAction: driverStep.driverAction,
            ...buildAndroidSelectorHealthMetadata(driverStep.selector),
            ...(!resolved
              ? nextActionHint(
                  'fix_android_selector',
                  `Inspect raw/${treeResult.rawFileName}, update the scenario selector, or provide explicit adb coordinates for this driver action.`,
                )
              : {}),
            ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
          },
        });
        selectorResolutionMetadata.push({
          ...(resolution ? { bounds: resolution.bounds } : {}),
          driverAction: driverStep.driverAction,
          rawPath: `raw/${treeResult.rawFileName}`,
          ...(driverStep.selector ? { selector: driverStep.selector } : {}),
          status: resolved ? 'passed' : 'failed',
          ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
        });
      }

      const driverResult = await runAndroidAdbDriverStep({
        capturesDir: layout.captures,
        driver,
        driverStep: executableDriverStep,
        logcatLines,
      });
      raw[driverResult.rawFileName] = formatAndroidAdbRawOutput(driverResult);
      const failed = driverResult.exitCode !== 0;
      const codeSuffix = androidDriverActionCode(driverStep.driverAction);
      const isReadLogs = driverStep.driverAction === 'readLogs';
      checks.push({
        name: isReadLogs ? 'android_logcat_captured' : `android_${codeSuffix}`,
        status: failed && driverStep.required === false ? 'warning' : failed ? 'failed' : 'passed',
        source: 'runner',
        code: isReadLogs
          ? driverResult.exitCode === 0 ? 'android_logcat_captured' : 'android_logcat_failed'
          : driverResult.exitCode === 0 ? `android_${codeSuffix}_completed` : `android_${codeSuffix}_failed`,
        message: isReadLogs
          ? driverResult.exitCode === 0
            ? `Captured the last ${driverStep.lines ?? logcatLines} adb logcat lines.`
            : 'adb logcat capture failed.'
          : driverResult.exitCode === 0
            ? `Completed adb driver action ${driverStep.driverAction}.`
            : `adb driver action ${driverStep.driverAction} failed.`,
        metadata: {
          driverAction: executableDriverStep.driverAction,
          ...buildAndroidSelectorHealthMetadata(executableDriverStep.selector),
          ...(failed
            ? nextActionHint(
                isReadLogs ? 'inspect_android_logcat_capture' : 'inspect_android_driver_action',
                isReadLogs
                  ? `Inspect raw/${driverResult.rawFileName}, confirm adb logcat access for the selected device, and rerun the capture.`
                  : `Inspect raw/${driverResult.rawFileName}, confirm the device is interactive and the action metadata is valid, then rerun the capture.`,
              )
            : {}),
          ...(executableDriverStep.stepId ? { stepId: executableDriverStep.stepId } : {}),
        },
      });
      const actionMetadata = {
        args: driverResult.args,
        driverAction: executableDriverStep.driverAction,
        exitCode: driverResult.exitCode,
        ...(driverResult.capturePath
          ? { capturePath: `captures/${path.basename(driverResult.capturePath)}` }
          : {}),
        rawPath: `raw/${driverResult.rawFileName}`,
        ...(executableDriverStep.selector ? { selector: executableDriverStep.selector } : {}),
        ...(executableDriverStep.stepId ? { stepId: executableDriverStep.stepId } : {}),
      };
      driverActionMetadata.push(actionMetadata);
      if (executableDriverStep.driverAction === 'readLogs') {
        logcatMetadata.push(actionMetadata);
      }
    }
    if (selectorResolutionMetadata.length > 0) {
      metadata.selectorResolutions = selectorResolutionMetadata;
    }
    if (driverActionMetadata.length > 0) {
      metadata.driverActions = driverActionMetadata;
    }
    if (logcatMetadata.length === 1) {
      metadata.logcat = logcatMetadata[0];
    } else if (logcatMetadata.length > 1) {
      metadata.logcat = logcatMetadata;
    }
  } else {
    if (clearLogcat || launch) {
      checks.push({
        name: 'android_capture_window_started',
        status: 'failed',
        source: 'runner',
        code: 'android_capture_window_no_device',
        message: 'Android capture window setup was requested, but no online Android device was selected.',
        metadata: nextActionHint(
          'select_android_device',
          'Start or unlock an Android emulator/device, confirm it appears as `device` in adb devices -l, then rerun the capture.',
        ),
      });
    }

    if (resolvedDriverSteps.some((step) => step.driverAction === 'readLogs')) {
      checks.push({
        name: 'android_logcat_captured',
        status: 'failed',
        source: 'runner',
        code: 'android_logcat_no_device',
        message: 'adb logcat capture was requested, but no online Android device was selected.',
        metadata: nextActionHint(
          'select_android_device',
          'Start or unlock an Android emulator/device before requesting logcat capture.',
        ),
      });
    }

    if (resolvedDriverSteps.some((step) => step.driverAction !== 'readLogs')) {
      checks.push({
        name: 'android_driver_actions_completed',
        status: 'failed',
        source: 'runner',
        code: 'android_driver_actions_no_device',
        message: 'adb driver actions were requested, but no online Android device was selected.',
        metadata: nextActionHint(
          'select_android_device',
          'Start or unlock an Android emulator/device before running adb driver actions.',
        ),
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
    ...(typeof args['react-native-debug-host'] === 'string'
      ? { reactNativeDebugHost: args['react-native-debug-host'] }
      : {}),
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    waitMs: parsePositiveInteger(args['wait-ms'], 0),
  });
  process.stdout.write(`${result.runDir}\n`);
  if (result.health.healthStatus !== 'passed') {
    process.exitCode = 1;
  }
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
  buildReactNativeDebugHostPreferenceCommand,
  escapeAndroidPreferenceXml,
  execFileCommand,
  main,
  parseAdbDevices,
  parseArgs,
  parsePositiveInteger,
  parseReactNativeDebugHostPort,
  resolveAndroidAdbDriverSteps,
  applyAndroidSelectorResolution,
  buildAndroidSelectorHealthMetadata,
  needsAndroidSelectorResolution,
  runAndroidAdbDriverStep,
  runAndroidAdbPreflight,
  selectDevice,
  usage,
};

export type {
  AndroidDevice,
  AndroidAdbDriverStep,
  AndroidDeepLinkCommand,
  AndroidPreflightOptions,
  AndroidPreflightResult,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
