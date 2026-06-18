#!/usr/bin/env node

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');
const {
  createIosSimctlDriver,
  formatIosSimctlRawOutput,
} = require('./ios-simctl-driver');

type CliArgs = {
  bundle?: string | boolean;
  'collect-profile-storage'?: string | boolean;
  device?: string | boolean;
  launch?: string | boolean;
  'log-last'?: string | boolean;
  out?: string | boolean;
  'profile-session-storage'?: string | boolean;
  'run-id'?: string | boolean;
  screenshot?: string | boolean;
  'screenshot-display'?: string | boolean;
  'screenshot-mask'?: string | boolean;
  'screenshot-type'?: string | boolean;
  'terminate-before-launch'?: string | boolean;
  'wait-ms'?: string | boolean;
  xcrun?: string | boolean;
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
type IosSimulator = {
  name: string;
  state: string;
  udid: string;
};
type IosSimctlDeepLink = {
  label?: string;
  url: string;
  waitMs?: number;
};
type IosProfileSessionStorageCommand = {
  command: string;
  id?: string;
  label?: string;
  timestamp?: number;
};
type IosProfileSessionStorageSeed = {
  commands?: IosProfileSessionStorageCommand[];
  scenario: string;
  runId: string;
  startedAt?: number;
};
type IosSimctlCaptureOptions = {
  bundleId?: string | null;
  collectProfileStorage?: boolean;
  conflictingBundleIds?: string[];
  deepLinks?: IosSimctlDeepLink[];
  delay?: (ms: number) => Promise<void>;
  device?: string | null;
  executor?: CommandExecutor;
  launch?: boolean;
  logLast?: string;
  outputDir?: string;
  profileSessionStorage?: IosProfileSessionStorageSeed | null;
  runId?: string;
  screenshot?: boolean;
  screenshotDisplay?: string;
  screenshotMask?: string;
  screenshotType?: string;
  terminateBeforeLaunch?: boolean;
  waitMs?: number;
  xcrunPath?: string;
};
type IosSimctlCaptureResult = {
  agentSummary: string;
  health: Record<string, unknown>;
  captures: {
    screenshot: string | null;
  };
  metadata: Record<string, unknown>;
  raw: Record<string, string>;
  runDir: string;
  simulator: IosSimulator | null;
  verdict: Record<string, unknown>;
};
type AsyncStorageManifest = Record<string, string | null>;
type NextActionHint = {
  nextAction: string;
  nextActionCode: string;
};

const PROFILE_STORAGE_PREFIX = 'agent-scenario-loop';
const PROFILE_STORAGE_SCHEMA = '1';
const PROFILE_EVENT_STORAGE_KEY = `${PROFILE_STORAGE_PREFIX}.profile-events.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_SIGNAL_STORAGE_KEY = `${PROFILE_STORAGE_PREFIX}.profile-signals.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_SESSION_STORAGE_KEY = `${PROFILE_STORAGE_PREFIX}.profile-session.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_COMMAND_STORAGE_KEY = `${PROFILE_STORAGE_PREFIX}.profile-commands.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_SESSION_ENTRIES_STORAGE_KEY = `${PROFILE_STORAGE_PREFIX}.profile-session-entries.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_STORAGE_RESET_KEYS = [
  PROFILE_EVENT_STORAGE_KEY,
  PROFILE_SIGNAL_STORAGE_KEY,
  PROFILE_COMMAND_STORAGE_KEY,
  PROFILE_SESSION_ENTRIES_STORAGE_KEY,
];
const SCREENSHOT_EXTENSIONS = new Set(['bmp', 'gif', 'jpeg', 'png', 'tiff']);

/**
 * Builds a filesystem-safe raw artifact suffix for a bundle identifier.
 *
 * @param {string} bundleId
 * @returns {string}
 */
function rawBundleIdSuffix(bundleId: string): string {
  return bundleId.replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 80) || 'bundle';
}

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-ios-simctl [--xcrun <path>] [--device <udid|booted>] [--bundle <id>] [--run-id <id>] [--out <dir>]',
    '',
    'Checks iOS simulator readiness and writes health.json, verdict.json, agent-summary.md, and raw simctl evidence.',
    'Use --launch with --bundle <id> to launch the app before capturing a bounded simulator log window.',
    'Use --screenshot to save a simulator screenshot into captures/ios-screenshot.png.',
    'Use --screenshot-type, --screenshot-display, or --screenshot-mask to pass supported simctl screenshot options.',
    'Use --profile-session-storage <scenario> with --bundle <id> to seed the app profile session before launch.',
    'Use --collect-profile-storage with --bundle <id> to collect stored profile events after the capture window.',
  ], output);
}

/**
 * Resolves the capture filename for the selected simctl screenshot type.
 *
 * @param {string | undefined} screenshotType
 * @returns {string}
 */
function screenshotCaptureFileName(screenshotType: string | undefined): string {
  const normalized = screenshotType?.toLowerCase();
  const extension = normalized && SCREENSHOT_EXTENSIONS.has(normalized) ? normalized : 'png';
  return `ios-screenshot.${extension}`;
}

/**
 * Parses `--key value` arguments for the iOS simctl capture CLI.
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
 * Reads the process id from `simctl launch` output.
 *
 * @param {string} output
 * @returns {string | null}
 */
function parseSimctlLaunchPid(output: string): string | null {
  const match = /:\s*(?<pid>\d+)\s*$/u.exec(output.trim());
  return match?.groups?.pid ?? null;
}

/**
 * Escapes a value for a CoreSimulator log predicate string literal.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeLogPredicateString(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
}

/**
 * Builds a simulator log predicate for the launched app lifecycle.
 *
 * @param {{bundleId: string, pid?: string | null}} options
 * @returns {string}
 */
function buildIosAppLifecycleLogPredicate({
  bundleId,
  pid = null,
}: {
  bundleId: string;
  pid?: string | null;
}): string {
  const bundlePredicate = `eventMessage CONTAINS "${escapeLogPredicateString(bundleId)}"`;
  return pid
    ? `${bundlePredicate} AND eventMessage CONTAINS "${escapeLogPredicateString(pid)}"`
    : bundlePredicate;
}

/**
 * Detects native app exits that invalidate simulator capture evidence.
 *
 * @param {string} output
 * @returns {boolean}
 */
function iosAppLifecycleLogHasCrash(output: string): boolean {
  return /Process exited|exited with context|SIG[A-Z]+|Segmentation fault|EXC_BAD_ACCESS|scene-creation-failed/iu.test(output);
}

/**
 * Normalizes configured sibling bundle ids, excluding the selected target bundle.
 *
 * @param {{bundleId: string | null, conflictingBundleIds: string[]}} options
 * @returns {string[]}
 */
function normalizeConflictingBundleIds({
  bundleId,
  conflictingBundleIds,
}: {
  bundleId: string | null;
  conflictingBundleIds: string[];
}): string[] {
  const ids = new Set<string>();
  for (const candidate of conflictingBundleIds) {
    const normalized = typeof candidate === 'string' ? candidate.trim() : '';
    if (normalized.length === 0 || normalized === bundleId) {
      continue;
    }
    ids.add(normalized);
  }

  return [...ids].sort();
}

/**
 * Creates a short random run id for iOS simulator capture runs.
 *
 * @returns {string}
 */
function createRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Resolves React Native AsyncStorage's iOS storage directory for an app data container.
 *
 * @param {{dataContainer: string, bundleId: string}} options
 * @returns {string}
 */
function resolveAsyncStorageDirectory({
  bundleId,
  dataContainer,
}: {
  bundleId: string;
  dataContainer: string;
}): string {
  return path.join(dataContainer, 'Library', 'Application Support', bundleId, 'RCTAsyncLocalStorage_V1');
}

/**
 * Returns the native iOS AsyncStorage spill-file name for a key.
 *
 * @param {string} key
 * @returns {string}
 */
function asyncStorageFileNameForKey(key: string): string {
  return crypto.createHash('md5').update(key).digest('hex');
}

/**
 * Reads the native iOS AsyncStorage manifest when it exists.
 *
 * @param {string} storageDir
 * @returns {AsyncStorageManifest}
 */
function readAsyncStorageManifestSync(storageDir: string): AsyncStorageManifest {
  const manifestPath = path.join(storageDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AsyncStorageManifest;
}

/**
 * Writes the native iOS AsyncStorage manifest with stable formatting.
 *
 * @param {{manifest: AsyncStorageManifest, storageDir: string}} options
 * @returns {Promise<void>}
 */
async function writeAsyncStorageManifest({
  manifest,
  storageDir,
}: {
  manifest: AsyncStorageManifest;
  storageDir: string;
}): Promise<void> {
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
}

/**
 * Reads one native iOS AsyncStorage value from an inline manifest or spill file.
 *
 * @param {{key: string, storageDir: string}} options
 * @returns {string | null}
 */
function readAsyncStorageValueSync({
  key,
  storageDir,
}: {
  key: string;
  storageDir: string;
}): string | null {
  const manifest = readAsyncStorageManifestSync(storageDir);
  const value = manifest[key];
  if (typeof value === 'string') {
    return value;
  }

  if (value !== null) {
    return null;
  }

  const spillPath = path.join(storageDir, asyncStorageFileNameForKey(key));
  return fs.existsSync(spillPath) ? fs.readFileSync(spillPath, 'utf8') : null;
}

/**
 * Removes stale native iOS AsyncStorage spill files for keys the runner resets.
 *
 * @param {{keys: string[], storageDir: string}} options
 * @returns {Promise<void>}
 */
async function removeAsyncStorageSpillFiles({
  keys,
  storageDir,
}: {
  keys: string[];
  storageDir: string;
}): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      fsp.rm(path.join(storageDir, asyncStorageFileNameForKey(key)), { force: true }),
    ),
  );
}

/**
 * Seeds the app profile-session AsyncStorage key before launching the iOS app.
 *
 * @param {{bundleId: string, commands?: IosProfileSessionStorageCommand[], dataContainer: string, runId: string, scenario: string, startedAt?: number}} options
 * @returns {Promise<{manifestPath: string, storageDir: string, session: Record<string, unknown>}>}
 */
async function seedProfileSessionStorage({
  bundleId,
  commands = [],
  dataContainer,
  runId,
  scenario,
  startedAt = Date.now(),
}: {
  bundleId: string;
  commands?: IosProfileSessionStorageCommand[];
  dataContainer: string;
  runId: string;
  scenario: string;
  startedAt?: number;
}): Promise<{commands: Record<string, unknown>[]; manifestPath: string; storageDir: string; session: Record<string, unknown>}> {
  const storageDir = resolveAsyncStorageDirectory({ bundleId, dataContainer });
  const manifest = readAsyncStorageManifestSync(storageDir);
  for (const key of PROFILE_STORAGE_RESET_KEYS) {
    delete manifest[key];
  }

  const session = {
    active: true,
    scenario,
    runId,
    startedAt,
  };
  const queuedCommands = commands.map((profileCommand, index) => ({
    id: profileCommand.id ?? `ios-storage-command-${index + 1}-${profileCommand.command}`,
    scenario,
    runId,
    command: profileCommand.command,
    timestamp: typeof profileCommand.timestamp === 'number' ? profileCommand.timestamp : startedAt + index + 1,
  }));
  manifest[PROFILE_SESSION_STORAGE_KEY] = JSON.stringify(session);
  if (queuedCommands.length > 0) {
    manifest[PROFILE_COMMAND_STORAGE_KEY] = JSON.stringify(queuedCommands);
  }
  await removeAsyncStorageSpillFiles({
    keys: [PROFILE_SESSION_STORAGE_KEY, ...PROFILE_STORAGE_RESET_KEYS],
    storageDir,
  });
  await writeAsyncStorageManifest({ manifest, storageDir });

  return {
    commands: queuedCommands,
    manifestPath: path.join(storageDir, 'manifest.json'),
    session,
    storageDir,
  };
}

/**
 * Reads JSON stored by the app profile-session AsyncStorage bridge.
 *
 * @param {{bundleId: string, dataContainer: string, key: string, fallback: unknown}} options
 * @returns {unknown}
 */
function readProfileStorageJson({
  bundleId,
  dataContainer,
  fallback,
  key,
}: {
  bundleId: string;
  dataContainer: string;
  fallback: unknown;
  key: string;
}): unknown {
  const storageDir = resolveAsyncStorageDirectory({ bundleId, dataContainer });
  const rawValue = readAsyncStorageValueSync({ key, storageDir });
  if (!rawValue) {
    return fallback;
  }

  return JSON.parse(rawValue);
}

/**
 * Formats stored profile events as the canonical profile-event log payload.
 *
 * @param {Record<string, unknown>[]} events
 * @returns {string}
 */
function formatStoredProfileEventLog(events: Record<string, unknown>[]): string {
  return events
    .map((event) => {
      const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
        ? new Date(event.timestamp).toISOString()
        : new Date(0).toISOString();
      return `${timestamp} ios-simctl [profile-event] ${JSON.stringify(event)}`;
    })
    .join('\n');
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
    execFile(command, args, { encoding: 'utf8' }, (error: ExecFileError | null, stdout: string, stderr: string) => {
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
 * Parses `xcrun simctl list devices` output into simulator rows.
 *
 * @param {string} output
 * @returns {IosSimulator[]}
 */
function parseSimctlDevices(output: string): IosSimulator[] {
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => {
      const match = /^(?<name>.+) \((?<udid>[0-9A-F-]+)\) \((?<state>[^)]+)\)$/u.exec(line);
      if (!match?.groups) {
        return null;
      }

      return {
        name: match.groups.name,
        state: match.groups.state,
        udid: match.groups.udid,
      };
    })
    .filter((simulator): simulator is IosSimulator => Boolean(simulator));
}

/**
 * Selects a simulator by explicit UDID or the first booted simulator.
 *
 * @param {IosSimulator[]} simulators
 * @param {string | null | undefined} device
 * @returns {IosSimulator | null}
 */
function selectSimulator(simulators: IosSimulator[], device?: string | null): IosSimulator | null {
  if (device && device !== 'booted') {
    return simulators.find((simulator) => simulator.udid === device) ?? null;
  }

  return simulators.find((simulator) => simulator.state === 'Booted') ?? null;
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
 * Builds a health artifact from iOS simulator capture checks.
 *
 * @param {{runId: string, checks: Record<string, unknown>[]}} options
 * @returns {Record<string, unknown>}
 */
function buildIosSimctlHealth({ runId, checks }: { runId: string; checks: Record<string, unknown>[] }): Record<string, unknown> {
  const failed = checks.some((check) => check.status === 'failed');
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'ios-simctl-capture',
      flowId: 'ios-simctl-capture',
      runId,
      healthStatus: failed ? 'failed' : 'passed',
      checks,
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Builds a verdict artifact for iOS simulator capture readiness.
 *
 * @param {{runId: string, health: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildIosSimctlVerdict({ runId, health }: { runId: string; health: Record<string, unknown> }): Record<string, unknown> {
  const passed = health.healthStatus === 'passed';
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'ios-simctl-capture',
      flowId: 'ios-simctl-capture',
      runId,
      healthStatus: health.healthStatus,
      verdictStatus: passed ? 'not_evaluated' : 'inconclusive',
      budgetChecks: [],
      summary: passed
        ? 'iOS simctl capture passed; no product budget has been evaluated.'
        : 'iOS simctl capture failed; runtime scenario execution is not ready.',
    },
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
}

/**
 * Runs iOS simulator readiness checks and writes raw simctl evidence.
 *
 * @param {IosSimctlCaptureOptions} options
 * @returns {Promise<IosSimctlCaptureResult>}
 */
async function runIosSimctlCapture({
  bundleId = null,
  collectProfileStorage = false,
  conflictingBundleIds = [],
  deepLinks = [],
  delay: wait = delay,
  device = null,
  executor = execFileCommand,
  launch = false,
  logLast = '2m',
  outputDir = path.resolve('artifacts/ios-simctl-capture'),
  profileSessionStorage = null,
  runId = createRunId(),
  screenshot = false,
  screenshotDisplay,
  screenshotMask,
  screenshotType,
  terminateBeforeLaunch = false,
  waitMs = 0,
  xcrunPath = 'xcrun',
}: IosSimctlCaptureOptions = {}): Promise<IosSimctlCaptureResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  await fsp.mkdir(rawDir, { recursive: true });

  const raw: Record<string, string> = {};
  const captures: { screenshot: string | null } = {
    screenshot: null,
  };
  const checks: Record<string, unknown>[] = [];
  const deepLinkResults: Record<string, unknown>[] = [];
  const devicesOutput = await executor(xcrunPath, ['simctl', 'list', 'devices']);
  const simctlAvailable = devicesOutput.exitCode === 0;
  raw['ios-simctl-devices.txt'] = [devicesOutput.stdout, devicesOutput.stderr].filter(Boolean).join('\n');
  checks.push({
    name: 'ios_simctl_available',
    status: simctlAvailable ? 'passed' : 'failed',
    source: 'runner',
    code: simctlAvailable ? 'ios_simctl_available' : 'ios_simctl_unavailable',
    message: simctlAvailable ? 'simctl device listing succeeded.' : 'simctl device listing failed.',
    ...(!simctlAvailable
      ? {
          metadata: nextActionHint(
            'fix_xcrun_simctl',
            'Select a working Xcode with xcode-select, finish any first-launch setup, or pass --xcrun with a working xcrun binary. If direct xcrun works but the Node runner fails from an agent sandbox, rerun with simulator/CoreSimulator access outside the sandbox.',
          ),
        }
      : {}),
  });

  const simulators = parseSimctlDevices(devicesOutput.stdout);
  const simulator = simctlAvailable ? selectSimulator(simulators, device) : null;
  const selectedDevice = device || 'booted';
  const simulatorBooted = Boolean(simulator && simulator.state === 'Booted');
  checks.push({
    name: 'ios_simulator_booted',
    status: simulatorBooted ? 'passed' : 'failed',
    source: 'runner',
    code: simulatorBooted ? 'ios_simulator_booted' : 'ios_simulator_missing',
    message: simulatorBooted && simulator
      ? `Selected iOS simulator ${simulator.name} (${simulator.udid}).`
      : device
        ? `No booted iOS simulator matched ${device}.`
        : 'No booted iOS simulator was found.',
    ...(!simulatorBooted
      ? {
          metadata: nextActionHint(
            'boot_ios_simulator',
            'Boot an iOS simulator, install the required simulator runtime if needed, or pass --device with a booted simulator UDID.',
          ),
        }
      : {}),
  });

  const metadata: Record<string, unknown> = {
    bundleId,
    collectProfileStorage,
    conflictingBundleIds: [],
    deepLinks,
    deepLinkResults,
    launch,
    logLast,
    profileSessionStorage: profileSessionStorage
      ? {
          commandCount: Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands.length : 0,
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
          startedAt: profileSessionStorage.startedAt ?? null,
        }
      : null,
    screenshot,
    selectedDevice,
    selectedSimulator: simulator,
    terminateBeforeLaunch,
    waitMs,
    xcrunPath,
  };

  if (simulator && simulator.state === 'Booted') {
    const driver = createIosSimctlDriver({
      deviceUdid: simulator.udid,
      executor,
      xcrunPath,
    });
    let dataContainerPath: string | null = null;
    let hasInstalledConflictingBundle = false;
    let launchedAppPid: string | null = null;
    if (bundleId) {
      const appContainer = await executor(xcrunPath, ['simctl', 'get_app_container', simulator.udid, bundleId, 'app']);
      raw['ios-app-container.txt'] = [appContainer.stdout, appContainer.stderr].filter(Boolean).join('\n');
      const appInstalled = appContainer.exitCode === 0 && appContainer.stdout.trim().length > 0;
      checks.push({
        name: 'ios_app_installed',
        status: appInstalled ? 'passed' : 'failed',
        source: 'runner',
        code: appInstalled
          ? 'ios_app_installed'
          : 'ios_app_missing',
        message: appInstalled
          ? `App ${bundleId} is installed.`
          : `App ${bundleId} is not installed on ${simulator.udid}.`,
        ...(!appInstalled
          ? {
              metadata: nextActionHint(
                'install_ios_app',
                'Build and install the app on the selected simulator, or rerun with --bundle set to the installed bundle id.',
              ),
            }
          : {}),
      });
      metadata.appContainer = {
        rawPath: 'raw/ios-app-container.txt',
      };

      const checkedConflictingBundleIds = normalizeConflictingBundleIds({
        bundleId,
        conflictingBundleIds,
      });
      if (checkedConflictingBundleIds.length > 0) {
        const installedConflictingBundleIds: string[] = [];
        const conflictChecks: Array<{ bundleId: string; rawPath: string; installed: boolean }> = [];
        for (const [index, conflictingBundleId] of checkedConflictingBundleIds.entries()) {
          const rawFileName = `ios-conflicting-bundle-${index + 1}-${rawBundleIdSuffix(conflictingBundleId)}.txt`;
          const conflictContainer = await executor(xcrunPath, [
            'simctl',
            'get_app_container',
            simulator.udid,
            conflictingBundleId,
            'app',
          ]);
          raw[rawFileName] = [conflictContainer.stdout, conflictContainer.stderr].filter(Boolean).join('\n');
          const installed = conflictContainer.exitCode === 0 && conflictContainer.stdout.trim().length > 0;
          if (installed) {
            installedConflictingBundleIds.push(conflictingBundleId);
          }
          conflictChecks.push({
            bundleId: conflictingBundleId,
            installed,
            rawPath: `raw/${rawFileName}`,
          });
        }

        hasInstalledConflictingBundle = installedConflictingBundleIds.length > 0;
        checks.push({
          name: 'ios_conflicting_bundles_absent',
          status: hasInstalledConflictingBundle ? 'failed' : 'passed',
          source: 'runner',
          code: hasInstalledConflictingBundle
            ? 'ios_conflicting_bundles_installed'
            : 'ios_conflicting_bundles_absent',
          message: hasInstalledConflictingBundle
            ? `Conflicting iOS bundle id(s) are installed on ${simulator.udid}: ${installedConflictingBundleIds.join(', ')}.`
            : 'No configured conflicting iOS bundle ids are installed on the selected simulator.',
          ...(hasInstalledConflictingBundle
            ? {
                metadata: nextActionHint(
                  'uninstall_ios_conflicting_bundles',
                  'Uninstall the conflicting app variant(s) from the selected simulator, or use a clean simulator dedicated to the target bundle before trusting launch, deep-link, or profile-session evidence.',
                ),
              }
            : {}),
        });
        metadata.conflictingBundleIds = {
          checked: conflictChecks,
          installed: installedConflictingBundleIds,
        };
      }

      if (collectProfileStorage || profileSessionStorage) {
        const dataContainer = await executor(xcrunPath, [
          'simctl',
          'get_app_container',
          simulator.udid,
          bundleId,
          'data',
        ]);
        raw['ios-data-container.txt'] = [dataContainer.stdout, dataContainer.stderr].filter(Boolean).join('\n');
        dataContainerPath = dataContainer.exitCode === 0 && dataContainer.stdout.trim().length > 0
          ? dataContainer.stdout.trim()
          : null;
        checks.push({
          name: 'ios_data_container_available',
          status: dataContainerPath ? 'passed' : 'failed',
          source: 'runner',
          code: dataContainerPath ? 'ios_data_container_available' : 'ios_data_container_missing',
          message: dataContainerPath
            ? `App data container for ${bundleId} is available.`
            : `App data container for ${bundleId} was not available.`,
          ...(!dataContainerPath
            ? {
                metadata: nextActionHint(
                  'inspect_ios_data_container',
                  'Confirm the app is installed and has launched at least once so simctl can resolve its data container.',
                ),
              }
            : {}),
        });
        metadata.dataContainer = {
          rawPath: 'raw/ios-data-container.txt',
        };
      }
    }

    if (terminateBeforeLaunch && !hasInstalledConflictingBundle) {
      if (!bundleId) {
        checks.push({
          name: 'ios_app_terminated',
          status: 'failed',
          source: 'runner',
          code: 'ios_terminate_missing_bundle',
          message: 'App termination was requested, but no bundle id was provided.',
          metadata: nextActionHint(
            'provide_ios_bundle',
            'Rerun with --bundle set to the installed iOS bundle id when termination is requested.',
          ),
        });
      } else {
        const terminateResult = await driver.terminateBundle(bundleId);
        raw[terminateResult.rawFileName] = formatIosSimctlRawOutput(terminateResult);
        const terminateOutput = `${terminateResult.stdout}\n${terminateResult.stderr}`;
        const notRunning = /not running|No such process|found nothing to terminate|The operation couldn't be completed/iu.test(terminateOutput);
        const terminatePassed = terminateResult.exitCode === 0 || notRunning;
        checks.push({
          name: 'ios_app_terminated',
          status: terminatePassed ? 'passed' : 'failed',
          source: 'runner',
          code: terminatePassed ? 'ios_app_terminated' : 'ios_app_terminate_failed',
          message: terminatePassed
            ? `Terminated app ${bundleId} before capture.`
            : `Failed to terminate app ${bundleId} before capture.`,
          ...(!terminatePassed
            ? {
                metadata: nextActionHint(
                  'inspect_ios_terminate',
                  'Inspect raw/ios-terminate.txt, confirm the bundle id is installed on the selected simulator, then rerun.',
                ),
              }
            : {}),
        });
        metadata.terminateResult = {
          args: terminateResult.args,
          exitCode: terminateResult.exitCode,
          rawPath: 'raw/ios-terminate.txt',
        };
      }
    }

    if (profileSessionStorage && !hasInstalledConflictingBundle) {
      if (!bundleId || !dataContainerPath) {
        checks.push({
          name: 'ios_profile_session_seeded',
          status: 'failed',
          source: 'runner',
          code: 'ios_profile_session_seed_missing_container',
          message: 'Profile-session storage seeding needs both bundle id and app data container.',
          metadata: nextActionHint(
            'fix_ios_profile_session_storage',
            'Provide --bundle, install and launch the app once, then rerun so the native AsyncStorage container exists.',
          ),
        });
      } else {
        const seeded = await seedProfileSessionStorage({
          bundleId,
          ...(Array.isArray(profileSessionStorage.commands)
            ? { commands: profileSessionStorage.commands }
            : {}),
          dataContainer: dataContainerPath,
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
          ...(typeof profileSessionStorage.startedAt === 'number'
            ? { startedAt: profileSessionStorage.startedAt }
            : {}),
        });
        raw['ios-profile-session-seed.json'] = JSON.stringify({
          commands: seeded.commands,
          session: seeded.session,
        }, null, 2);
        checks.push({
          name: 'ios_profile_session_seeded',
          status: 'passed',
          source: 'runner',
          code: 'ios_profile_session_seeded',
          message: `Seeded profile session ${profileSessionStorage.scenario}/${profileSessionStorage.runId} into app storage.`,
        });
        metadata.profileSessionSeed = {
          commandCount: seeded.commands.length,
          rawPath: 'raw/ios-profile-session-seed.json',
        };
      }
    }

    if (launch && !hasInstalledConflictingBundle) {
      if (!bundleId) {
        checks.push({
          name: 'ios_app_launched',
          status: 'failed',
          source: 'runner',
          code: 'ios_launch_missing_bundle',
          message: 'App launch was requested, but no bundle id was provided.',
          metadata: nextActionHint(
            'provide_ios_bundle',
            'Rerun with --bundle set to the installed iOS bundle id when --launch is enabled.',
          ),
        });
      } else {
        const launchResult = await driver.launchBundle(bundleId);
        const launchPassed = launchResult.exitCode === 0;
        launchedAppPid = launchPassed ? parseSimctlLaunchPid(launchResult.stdout) : null;
        raw[launchResult.rawFileName] = formatIosSimctlRawOutput(launchResult);
        checks.push({
          name: 'ios_app_launched',
          status: launchPassed ? 'passed' : 'failed',
          source: 'runner',
          code: launchPassed ? 'ios_app_launched' : 'ios_app_launch_failed',
          message: launchPassed ? `Launched app ${bundleId}.` : `Failed to launch app ${bundleId}.`,
          ...(!launchPassed
            ? {
                metadata: nextActionHint(
                  'inspect_ios_launch',
                  'Inspect raw/ios-launch.txt, confirm the bundle id and simulator runtime are valid, and verify the app opens manually.',
                ),
              }
            : {}),
        });
        metadata.launchResult = {
          args: launchResult.args,
          exitCode: launchResult.exitCode,
          pid: launchedAppPid,
          rawPath: 'raw/ios-launch.txt',
        };
      }
    }

    for (const [index, deepLink] of (hasInstalledConflictingBundle ? [] : deepLinks).entries()) {
      const rawFileName = `ios-deep-link-${index + 1}.txt`;
      const deepLinkResult = await driver.openDeepLink({ rawFileName, url: deepLink.url });
      const deepLinkOpened = deepLinkResult.exitCode === 0;
      raw[deepLinkResult.rawFileName] = formatIosSimctlRawOutput(deepLinkResult);
      deepLinkResults.push({
        args: deepLinkResult.args,
        exitCode: deepLinkResult.exitCode,
        label: deepLink.label ?? null,
        rawPath: `raw/${deepLinkResult.rawFileName}`,
        url: deepLink.url,
        waitMs: deepLink.waitMs ?? 0,
      });
      checks.push({
        name: 'ios_deep_link_opened',
        status: deepLinkOpened ? 'passed' : 'failed',
        source: 'runner',
        code: deepLinkOpened ? 'ios_deep_link_opened' : 'ios_deep_link_failed',
        message: deepLinkOpened
          ? `Opened iOS deep link ${deepLink.label ?? index + 1}.`
          : `Failed to open iOS deep link ${deepLink.label ?? index + 1}.`,
        ...(!deepLinkOpened
          ? {
              metadata: nextActionHint(
                'inspect_ios_deep_link',
                `Inspect raw/${deepLinkResult.rawFileName}, verify the app URL scheme, and confirm the app is installed on the selected simulator.`,
              ),
            }
          : {}),
      });

      if (deepLink.waitMs && deepLink.waitMs > 0) {
        await wait(deepLink.waitMs);
        checks.push({
          name: 'ios_deep_link_waited',
          status: 'passed',
          source: 'runner',
          code: 'ios_deep_link_waited',
          message: `Waited ${deepLink.waitMs}ms after iOS deep link ${deepLink.label ?? index + 1}.`,
        });
      }
    }
    if (waitMs > 0) {
      await wait(waitMs);
      checks.push({
        name: 'ios_capture_window_waited',
        status: 'passed',
        source: 'runner',
        code: 'ios_capture_window_waited',
        message: `Waited ${waitMs}ms before capturing iOS simulator logs.`,
      });
    }

    if (launch && bundleId && !hasInstalledConflictingBundle) {
      const appLifecycleLog = await executor(xcrunPath, [
        'simctl',
        'spawn',
        simulator.udid,
        'log',
        'show',
        '--style',
        'compact',
        '--last',
        logLast,
        '--predicate',
        buildIosAppLifecycleLogPredicate({
          bundleId,
          pid: launchedAppPid,
        }),
      ]);
      const appLifecycleRawFileName = 'ios-app-lifecycle-log.txt';
      const appLifecycleOutput = [appLifecycleLog.stdout, appLifecycleLog.stderr].filter(Boolean).join('\n');
      const appLifecycleCaptured = appLifecycleLog.exitCode === 0;
      const appLifecycleCrashed = appLifecycleCaptured && iosAppLifecycleLogHasCrash(appLifecycleOutput);
      raw[appLifecycleRawFileName] = appLifecycleOutput;
      checks.push({
        name: 'ios_app_lifecycle_stable',
        status: !appLifecycleCaptured ? 'warning' : appLifecycleCrashed ? 'failed' : 'passed',
        source: 'runner',
        code: !appLifecycleCaptured
          ? 'ios_app_lifecycle_log_unavailable'
          : appLifecycleCrashed
            ? 'ios_app_exited_during_capture'
            : 'ios_app_lifecycle_stable',
        message: !appLifecycleCaptured
          ? 'Could not inspect the launched iOS app lifecycle log.'
          : appLifecycleCrashed
            ? `App ${bundleId} exited during the simulator capture window.`
            : `No native app exit was found for ${bundleId} during the simulator capture window.`,
        ...(!appLifecycleCaptured
          ? {
              metadata: nextActionHint(
                'inspect_ios_app_lifecycle',
                `Inspect raw/${appLifecycleRawFileName}, confirm xcrun simctl log access works for the selected simulator, then rerun the capture.`,
              ),
            }
          : appLifecycleCrashed
            ? {
                metadata: nextActionHint(
                  'inspect_ios_app_crash',
                  `Inspect raw/${appLifecycleRawFileName} and the latest host DiagnosticReports crash file for ${bundleId}; do not trust timing or profile evidence until the app remains foregrounded.`,
                ),
              }
            : {}),
      });
      metadata.appLifecycle = {
        args: appLifecycleLog.args,
        exitCode: appLifecycleLog.exitCode,
        pid: launchedAppPid,
        rawPath: `raw/${appLifecycleRawFileName}`,
      };
    }

    if (screenshot) {
      await fsp.mkdir(layout.captures, { recursive: true });
      const screenshotFileName = screenshotCaptureFileName(screenshotType);
      const screenshotPath = path.join(layout.captures, screenshotFileName);
      const screenshotResult = await driver.screenshot({
        outputPath: screenshotPath,
        ...(screenshotDisplay ? { display: screenshotDisplay } : {}),
        ...(screenshotMask ? { mask: screenshotMask } : {}),
        ...(screenshotType ? { imageType: screenshotType } : {}),
      });
      raw[screenshotResult.rawFileName] = formatIosSimctlRawOutput(screenshotResult);
      const screenshotCaptured = screenshotResult.exitCode === 0 && fs.existsSync(screenshotPath);
      if (screenshotCaptured) {
        captures.screenshot = `captures/${screenshotFileName}`;
      }
      checks.push({
        name: 'ios_screenshot_captured',
        status: screenshotCaptured ? 'passed' : 'failed',
        source: 'runner',
        code: screenshotCaptured ? 'ios_screenshot_captured' : 'ios_screenshot_failed',
        message: screenshotCaptured ? 'Captured iOS simulator screenshot.' : 'iOS simulator screenshot capture failed.',
        ...(!screenshotCaptured
          ? {
              metadata: nextActionHint(
                'inspect_ios_screenshot',
                `Inspect raw/${screenshotResult.rawFileName}, confirm the simulator window is available, then rerun the screenshot capture.`,
              ),
            }
          : {}),
      });
      metadata.screenshot = {
        args: screenshotResult.args,
        capturePath: captures.screenshot,
        exitCode: screenshotResult.exitCode,
        options: {
          ...(screenshotDisplay ? { display: screenshotDisplay } : {}),
          ...(screenshotMask ? { mask: screenshotMask } : {}),
          ...(screenshotType ? { type: screenshotType } : {}),
        },
        rawPath: `raw/${screenshotResult.rawFileName}`,
      };
    }

    const log = await driver.readLogs({ last: logLast });
    const logsCaptured = log.exitCode === 0;
    raw[log.rawFileName] = formatIosSimctlRawOutput(log);
    checks.push({
      name: 'ios_logs_captured',
      status: logsCaptured ? 'passed' : 'failed',
      source: 'runner',
      code: logsCaptured ? 'ios_logs_captured' : 'ios_logs_failed',
      message: logsCaptured ? `Captured iOS simulator logs from the last ${logLast}.` : 'iOS simulator log capture failed.',
      ...(!logsCaptured
        ? {
            metadata: nextActionHint(
              'inspect_ios_logs',
              `Inspect raw/${log.rawFileName}, confirm xcrun simctl log access works for the selected simulator, then rerun the capture.`,
            ),
          }
        : {}),
    });
    metadata.logs = {
      args: log.args,
      exitCode: log.exitCode,
      rawPath: `raw/${log.rawFileName}`,
    };

    if (collectProfileStorage) {
      if (!bundleId || !dataContainerPath) {
        checks.push({
          name: 'ios_profile_storage_collected',
          status: 'failed',
          source: 'runner',
          code: 'ios_profile_storage_missing_container',
          message: 'Profile storage collection needs both bundle id and app data container.',
          metadata: nextActionHint(
            'fix_ios_profile_storage',
            'Provide --bundle, install and launch the app once, then rerun profile storage collection.',
          ),
        });
      } else {
        try {
          const storedEvents = readProfileStorageJson({
            bundleId,
            dataContainer: dataContainerPath,
            fallback: [],
            key: PROFILE_EVENT_STORAGE_KEY,
          });
          const storedEntries = readProfileStorageJson({
            bundleId,
            dataContainer: dataContainerPath,
            fallback: [],
            key: PROFILE_SESSION_ENTRIES_STORAGE_KEY,
          });
          const events = Array.isArray(storedEvents)
            ? storedEvents.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === 'object' && !Array.isArray(event))
            : [];
          raw['ios-profile-events.json'] = JSON.stringify(events, null, 2);
          raw['ios-profile-events.log'] = formatStoredProfileEventLog(events);
          raw['ios-profile-session-entries.json'] = JSON.stringify(storedEntries, null, 2);
          checks.push({
            name: 'ios_profile_storage_collected',
            status: 'passed',
            source: 'runner',
            code: 'ios_profile_storage_collected',
            message: `Collected ${events.length} stored profile event${events.length === 1 ? '' : 's'} from app storage.`,
          });
          metadata.profileStorage = {
            eventCount: events.length,
            eventsRawPath: 'raw/ios-profile-events.json',
            logRawPath: 'raw/ios-profile-events.log',
            sessionEntriesRawPath: 'raw/ios-profile-session-entries.json',
          };
        } catch (error) {
          raw['ios-profile-storage-error.txt'] = error instanceof Error ? error.message : String(error);
          checks.push({
            name: 'ios_profile_storage_collected',
            status: 'failed',
            source: 'runner',
            code: 'ios_profile_storage_collect_failed',
            message: 'Failed to collect stored profile events from app storage.',
            metadata: nextActionHint(
              'inspect_ios_profile_storage',
              'Inspect raw/ios-profile-storage-error.txt and confirm the app writes profile events to the expected AsyncStorage keys.',
            ),
          });
        }
      }
    }
  } else if (launch || terminateBeforeLaunch || profileSessionStorage || collectProfileStorage || deepLinks.length > 0) {
    checks.push({
      name: 'ios_capture_window_started',
      status: 'failed',
      source: 'runner',
      code: 'ios_capture_window_no_simulator',
      message: 'iOS capture window setup was requested, but no booted simulator was selected.',
      metadata: nextActionHint(
        'boot_ios_simulator',
        'Boot an iOS simulator or pass --device with a booted simulator UDID before requesting launch, storage, or deep-link capture.',
      ),
    });
  }

  const health = buildIosSimctlHealth({ runId, checks });
  const verdict = buildIosSimctlVerdict({ runId, health });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });

  await Promise.all(
    Object.entries(raw).map(([fileName, content]) =>
      fsp.writeFile(path.join(rawDir, fileName), `${content.trimEnd()}\n`, 'utf8'),
    ),
  );
  await fsp.writeFile(path.join(rawDir, 'ios-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
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
    captures,
    health,
    metadata,
    raw,
    runDir,
    simulator,
    verdict,
  };
}

/**
 * Runs the ios-simctl capture CLI.
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
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const profileSessionStorageEnabled = typeof args['profile-session-storage'] === 'string';
  const result = await runIosSimctlCapture({
    ...(typeof args.bundle === 'string' ? { bundleId: args.bundle } : {}),
    collectProfileStorage: profileSessionStorageEnabled ||
      args['collect-profile-storage'] === true ||
      args['collect-profile-storage'] === 'true',
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    launch: args.launch === true || args.launch === 'true',
    ...(typeof args['log-last'] === 'string' ? { logLast: args['log-last'] } : {}),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    ...(profileSessionStorageEnabled && typeof args['profile-session-storage'] === 'string'
      ? {
          profileSessionStorage: {
            runId,
            scenario: args['profile-session-storage'],
          },
        }
      : {}),
    runId,
    screenshot: args.screenshot === true || args.screenshot === 'true',
    ...(typeof args['screenshot-display'] === 'string' ? { screenshotDisplay: args['screenshot-display'] } : {}),
    ...(typeof args['screenshot-mask'] === 'string' ? { screenshotMask: args['screenshot-mask'] } : {}),
    ...(typeof args['screenshot-type'] === 'string' ? { screenshotType: args['screenshot-type'] } : {}),
    terminateBeforeLaunch: args['terminate-before-launch'] === true || args['terminate-before-launch'] === 'true',
    waitMs: parsePositiveInteger(args['wait-ms'], 0),
    ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
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
  buildIosSimctlHealth,
  buildIosSimctlVerdict,
  asyncStorageFileNameForKey,
  execFileCommand,
  formatStoredProfileEventLog,
  main,
  parseArgs,
  parsePositiveInteger,
  parseSimctlDevices,
  normalizeConflictingBundleIds,
  readAsyncStorageValueSync,
  readProfileStorageJson,
  resolveAsyncStorageDirectory,
  runIosSimctlCapture,
  seedProfileSessionStorage,
  selectSimulator,
  usage,
};

export type {
  CliArgs,
  CommandExecutor,
  CommandResult,
  IosSimctlCaptureOptions,
  IosSimctlCaptureResult,
  IosSimctlDeepLink,
  IosProfileSessionStorageSeed,
  IosSimulator,
};
