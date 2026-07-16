#!/usr/bin/env node

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { PROFILE_STORAGE_RESET_KEYS, PROFILE_SESSION_STORAGE_KEYS } = require('../profile-session-storage');
const { hasHelpFlag, writeUsage } = require('./cli');
const {
  createIosSimctlDriver,
  formatIosSimctlRawOutput,
} = require('./ios-simctl-driver');

type CliArgs = {
  bundle?: string | boolean;
  'command-timeout-ms'?: string | boolean;
  'collect-profile-storage'?: string | boolean;
  device?: string | boolean;
  'diagnostic-reports-dir'?: string | boolean;
  launch?: string | boolean;
  'log-last'?: string | boolean;
  'profile-command-storage-key'?: string | boolean;
  'profile-event-storage-key'?: string | boolean;
  out?: string | boolean;
  'profile-session-entries-storage-key'?: string | boolean;
  'profile-session-start-wait-ms'?: string | boolean;
  'profile-session-storage'?: string | boolean;
  'profile-session-storage-key'?: string | boolean;
  'profile-signal-storage-key'?: string | boolean;
  record?: string | boolean;
  'run-id'?: string | boolean;
  screenshot?: string | boolean;
  'screenshot-display'?: string | boolean;
  'screenshot-mask'?: string | boolean;
  'screenshot-type'?: string | boolean;
  'terminate-before-launch'?: string | boolean;
  video?: string | boolean;
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
  killed?: boolean;
  signal?: NodeJS.Signals | string;
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
  commandId?: string;
  dependsOnMilestones?: string[];
  id?: string;
  label?: string;
  queueId?: string;
  sequence?: number;
  timestamp?: number;
  waitForMilestone?: string;
  waitMs?: number;
  waitTimeoutMs?: number;
};
type IosProfileSessionStorageSeed = {
  commands?: IosProfileSessionStorageCommand[];
  scenario: string;
  runId: string;
  startedAt?: number;
};
type ProfileStorageKeys = {
  command: string;
  event: string;
  session: string;
  sessionEntries: string;
  signal: string;
};
type IosSimctlCaptureOptions = {
  bundleId?: string | null;
  captureWatchdogMs?: number;
  commandTimeoutMs?: number;
  collectProfileStorage?: boolean;
  conflictingBundleIds?: string[];
  deepLinks?: IosSimctlDeepLink[];
  delay?: (ms: number) => Promise<void>;
  device?: string | null;
  diagnosticReportsDir?: string | null;
  executor?: CommandExecutor;
  launch?: boolean;
  logLast?: string;
  outputDir?: string;
  profileSessionStorage?: IosProfileSessionStorageSeed | null;
  profileSessionStartWaitMs?: number;
  profileStorageKeys?: Partial<ProfileStorageKeys>;
  runId?: string;
  record?: boolean;
  recorderFactory?: import('./ios-simctl-driver').IosSimctlRecorderFactory;
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
    video: string | null;
  };
  metadata: Record<string, unknown>;
  raw: Record<string, string>;
  runDir: string;
  simulator: IosSimulator | null;
  verdict: Record<string, unknown>;
};
type IosVideoFinalizeResult = Awaited<ReturnType<import('./ios-simctl-driver').IosSimctlRecording['stop']>>;
type AsyncStorageManifest = Record<string, string | null>;
type NextActionHint = {
  nextAction: string;
  nextActionCode: string;
};
type IosTargetForegroundFailure = NextActionHint & {
  devClientDeepLinkLabel?: string | null;
  devClientDeepLinkRawPath?: string | null;
  devClientDeepLinkUrl?: string | null;
  failureClass?: 'dev_client_foreground_mismatch';
};
type SimulatorLaunchEnvironmentProbe = {
  clean: boolean;
  metadata: Record<string, unknown>;
  raw: Record<string, string>;
};
type HostDiagnosticReportProbe = {
  metadata: Record<string, unknown>;
  raw: Record<string, string>;
};
type IosSimctlCaptureWatchdogBudget = {
  ceilingMs: number;
  commandBudgetMs: number;
  commandUnits: number;
  declaredWaitMs: number;
  floorMs: number;
  perCommandOverheadMs: number;
  source: 'derived' | 'override';
  timeoutMs: number;
};
type IosSimctlCaptureWatchdogError = Error & {
  code: 'ios_simctl_runner_liveness_timeout';
  watchdog: IosSimctlCaptureWatchdogBudget;
};
type IosSimctlCapturePhase = {
  details?: Record<string, unknown>;
  name: string;
  startedAt: string;
};
type ProfileSessionStartObservation = {
  eventCount: number;
  observed: boolean;
  sessionEntryCount: number;
};
type ProfileSessionStartWait = ProfileSessionStartObservation & {
  completed: boolean;
  elapsedMs: number;
  pollCount: number;
  timeoutMs: number;
};
type ProfileSessionStartRepairAttempt = {
  completed: boolean;
  elapsedMs: number | null;
  exitCode: number;
  label: string;
  rawPath: string;
  reason: ProfileSessionStartFailureClass;
  timeoutMs: number;
  url: string;
};
type ProfileSessionStartForegroundProbe = {
  appInfoCaptured: boolean;
  applicationState: string | null;
  rawPath: string;
  targetForeground: boolean | null;
};
type ProfileSessionStartFailureClass =
  | 'dev_client_bundle_or_command_channel_not_ready'
  | 'dev_client_not_foreground'
  | 'dev_client_shell_foreground_no_js_app'
  | 'ios_profile_session_start_missing'
  | 'profile_command_channel_missing';
type ProfileSessionStartReadinessDetail =
  | 'dev_client_foreground_command_channel_missing'
  | 'dev_client_not_foreground'
  | 'dev_client_foreground_unknown'
  | 'profile_session_start_missing_without_dev_client';
type ProfileSessionStartWaitCheckInput = {
  readiness?: ProfileSessionStartReadinessContext;
  runId: string;
  scenario: string;
  startWait: ProfileSessionStartWait;
};
type ProfileSessionStartReadinessContext = {
  commandCount: number;
  devClientDeepLinkOpened: boolean;
  expectedEvidence: 'profile-session-start-or-profile-events';
  failureClass: ProfileSessionStartFailureClass;
  foregroundProbe: ProfileSessionStartForegroundProbe | null;
  lastDeepLinkLabel: string | null;
  lastDeepLinkUrl: string | null;
  pendingPhase: string;
  profileCommandStorageKey: string;
  profileEventStorageKey: string;
  profileSessionStartRepair: ProfileSessionStartRepairAttempt | null;
  profileSessionEntriesStorageKey: string;
  profileSessionStorageKey: string;
  readinessDetail: ProfileSessionStartReadinessDetail;
  seedRawPath: string | null;
  waitRawPath: string;
};

const DEFAULT_PROFILE_STORAGE_KEYS: ProfileStorageKeys = {
  command: PROFILE_SESSION_STORAGE_KEYS.command,
  event: PROFILE_SESSION_STORAGE_KEYS.event,
  session: PROFILE_SESSION_STORAGE_KEYS.session,
  sessionEntries: PROFILE_SESSION_STORAGE_KEYS.sessionEntries,
  signal: PROFILE_SESSION_STORAGE_KEYS.signal,
};
const DEFAULT_IOS_SIMCTL_COMMAND_TIMEOUT_MS = 60000;
const MAX_IOS_SIMCTL_COMMAND_TIMEOUT_MS = 2_147_483_647;
const IOS_SIMCTL_CAPTURE_WATCHDOG_FLOOR_MS = 15000;
const IOS_SIMCTL_CAPTURE_WATCHDOG_CEILING_MS = 120000;
const IOS_SIMCTL_CAPTURE_COMMAND_OVERHEAD_MS = 3000;
const IOS_SIMCTL_CAPTURE_COMMAND_OVERHEAD_CEILING_MS = 45000;
const DEFAULT_IOS_PROFILE_SESSION_START_WAIT_MS = 10000;
const IOS_PROFILE_SESSION_START_POLL_MS = 250;
const SCREENSHOT_EXTENSIONS = new Set(['bmp', 'gif', 'jpeg', 'png', 'tiff']);
const SIMULATOR_LAUNCH_ENV_KEYS = [
  'DYLD_INSERT_LIBRARIES',
  'NATIVE_DEVTOOLS_IOS_CDP_SOCKET',
];
const HOST_DIAGNOSTIC_REPORT_MAX_AGE_MS = 10 * 60 * 1000;
const HOST_DIAGNOSTIC_REPORT_SEARCH_LIMIT = 25;

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
 * Resolves app-owned AsyncStorage keys for profile-session control and evidence.
 *
 * @param {Partial<ProfileStorageKeys> | undefined} overrides
 * @returns {ProfileStorageKeys}
 */
function resolveProfileStorageKeys(overrides?: Partial<ProfileStorageKeys>): ProfileStorageKeys {
  return {
    command: overrides?.command || DEFAULT_PROFILE_STORAGE_KEYS.command,
    event: overrides?.event || DEFAULT_PROFILE_STORAGE_KEYS.event,
    session: overrides?.session || DEFAULT_PROFILE_STORAGE_KEYS.session,
    sessionEntries: overrides?.sessionEntries || DEFAULT_PROFILE_STORAGE_KEYS.sessionEntries,
    signal: overrides?.signal || DEFAULT_PROFILE_STORAGE_KEYS.signal,
  };
}

/**
 * Resolves the default macOS host crash-report directory used by Simulator apps.
 *
 * @returns {string}
 */
function defaultDiagnosticReportsDir(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
}

/**
 * Builds a short raw evidence filename for an attached host diagnostic report.
 *
 * @param {string} bundleId
 * @returns {string}
 */
function hostDiagnosticReportRawFileName(bundleId: string): string {
  return `ios-host-diagnostic-report-${rawBundleIdSuffix(bundleId)}.ips`;
}

/**
 * Searches recent macOS host crash reports for the launched iOS bundle id.
 *
 * @param {{bundleId: string, diagnosticReportsDir?: string | null}} options
 * @returns {Promise<HostDiagnosticReportProbe>}
 */
async function inspectHostDiagnosticReport({
  bundleId,
  diagnosticReportsDir,
}: {
  bundleId: string;
  diagnosticReportsDir?: string | null;
}): Promise<HostDiagnosticReportProbe> {
  const reportsDir = diagnosticReportsDir || defaultDiagnosticReportsDir();
  const searchRawFileName = 'ios-host-diagnostic-report-search.txt';
  const reportRawFileName = hostDiagnosticReportRawFileName(bundleId);
  const startedAt = Date.now();
  const lines = [
    `searchDir=${reportsDir}`,
    `bundleId=${bundleId}`,
    `maxAgeMs=${HOST_DIAGNOSTIC_REPORT_MAX_AGE_MS}`,
    `limit=${HOST_DIAGNOSTIC_REPORT_SEARCH_LIMIT}`,
  ];

  try {
    const entries: import('node:fs').Dirent[] = await fsp.readdir(reportsDir, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ips'))
        .map(async (entry) => {
          const filePath = path.join(reportsDir, entry.name);
          const stat = await fsp.stat(filePath);
          return { filePath, modifiedAtMs: stat.mtimeMs, name: entry.name };
        }),
    );
    const recentCandidates = candidates
      .filter((candidate) => startedAt - candidate.modifiedAtMs <= HOST_DIAGNOSTIC_REPORT_MAX_AGE_MS)
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
      .slice(0, HOST_DIAGNOSTIC_REPORT_SEARCH_LIMIT);

    lines.push(`candidateCount=${candidates.length}`);
    lines.push(`recentCandidateCount=${recentCandidates.length}`);

    for (const candidate of recentCandidates) {
      lines.push(`checked=${candidate.name}`);
      const content = await fsp.readFile(candidate.filePath, 'utf8');
      if (!content.includes(`"bundleID":"${bundleId}"`) && !content.includes(`"bundleID" : "${bundleId}"`)) {
        continue;
      }

      lines.push(`matched=${candidate.filePath}`);
      return {
        metadata: {
          matched: true,
          modifiedAt: new Date(candidate.modifiedAtMs).toISOString(),
          rawPath: `raw/${reportRawFileName}`,
          reportPath: candidate.filePath,
          searchRawPath: `raw/${searchRawFileName}`,
        },
        raw: {
          [reportRawFileName]: content,
          [searchRawFileName]: lines.join('\n'),
        },
      };
    }

    lines.push('matched=');
    return {
      metadata: {
        matched: false,
        reportPath: null,
        searchRawPath: `raw/${searchRawFileName}`,
      },
      raw: {
        [searchRawFileName]: lines.join('\n'),
      },
    };
  } catch (error) {
    lines.push(`error=${error instanceof Error ? error.message : String(error)}`);
    return {
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        matched: false,
        reportPath: null,
        searchRawPath: `raw/${searchRawFileName}`,
      },
      raw: {
        [searchRawFileName]: lines.join('\n'),
      },
    };
  }
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
    'Use --record (or --video) to capture bounded simulator video into captures/ios-recording.mp4 when output validates.',
    'Use --screenshot-type, --screenshot-display, or --screenshot-mask to pass supported simctl screenshot options.',
    'Use --profile-session-storage <scenario> with --bundle <id> to seed the app profile session before launch.',
    'Use --profile-session-start-wait-ms <ms> to bound how long storage-backed captures wait for same-run app evidence after launch/deep-link setup.',
    'Use --profile-session-storage-key, --profile-command-storage-key, --profile-event-storage-key, --profile-signal-storage-key, and --profile-session-entries-storage-key to target app-owned AsyncStorage keys.',
    'Use --collect-profile-storage with --bundle <id> to collect stored profile events after the capture window.',
    'Use --command-timeout-ms <ms> to bound each xcrun/simctl subprocess; the default is 60000.',
    'Use --diagnostic-reports-dir <path> when host crash reports live outside ~/Library/Logs/DiagnosticReports.',
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

function normalizeCommandTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_IOS_SIMCTL_COMMAND_TIMEOUT_MS;
  }

  const bounded = Math.max(1, Math.ceil(timeoutMs));
  return Math.min(bounded, MAX_IOS_SIMCTL_COMMAND_TIMEOUT_MS);
}

/**
 * Sums only positive finite durations.
 *
 * @param {Array<number | undefined>} values
 * @returns {number}
 */
function sumPositiveDurations(values: Array<number | undefined>): number {
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      total += value;
    }
  }
  return total;
}

/**
 * Derives a whole-capture watchdog for iOS simctl capture publication.
 *
 * @param {IosSimctlCaptureOptions & {commandTimeoutMs: number}} options
 * @returns {IosSimctlCaptureWatchdogBudget}
 */
function deriveIosSimctlCaptureWatchdogBudget({
  bundleId = null,
  captureWatchdogMs,
  collectProfileStorage = false,
  commandTimeoutMs,
  conflictingBundleIds = [],
  deepLinks = [],
  launch = false,
  profileSessionStorage = null,
  profileSessionStartWaitMs = 0,
  record = false,
  screenshot = false,
  terminateBeforeLaunch = false,
  waitMs = 0,
}: IosSimctlCaptureOptions & { commandTimeoutMs: number }): IosSimctlCaptureWatchdogBudget {
  if (typeof captureWatchdogMs === 'number' && Number.isFinite(captureWatchdogMs) && captureWatchdogMs > 0) {
    return {
      ceilingMs: IOS_SIMCTL_CAPTURE_WATCHDOG_CEILING_MS,
      commandBudgetMs: 0,
      commandUnits: 0,
      declaredWaitMs: captureWatchdogMs,
      floorMs: IOS_SIMCTL_CAPTURE_WATCHDOG_FLOOR_MS,
      perCommandOverheadMs: 0,
      source: 'override',
      timeoutMs: Math.ceil(captureWatchdogMs),
    };
  }

  const canRepairDevClientReadiness = Boolean(
    profileSessionStorage &&
    deepLinks.some((deepLink) => (
      deepLink.label === 'ios-dev-client-url' || deepLink.url.includes('expo-development-client')
    )),
  );
  const declaredWaitMs = sumPositiveDurations([
    waitMs,
    profileSessionStorage ? profileSessionStartWaitMs : 0,
    canRepairDevClientReadiness ? profileSessionStartWaitMs : 0,
    ...deepLinks.map((deepLink) => deepLink.waitMs),
  ]);
  const commandUnits = 4 +
    (bundleId ? 1 : 0) +
    conflictingBundleIds.length +
    (collectProfileStorage || profileSessionStorage ? 1 : 0) +
    (terminateBeforeLaunch ? 1 : 0) +
    (profileSessionStorage ? 1 : 0) +
    (launch ? 3 : 0) +
    deepLinks.length +
    (canRepairDevClientReadiness ? 1 : 0) +
    (screenshot ? 1 : 0) +
    (record ? 1 : 0);
  const perCommandOverheadMs = Math.min(commandTimeoutMs, IOS_SIMCTL_CAPTURE_COMMAND_OVERHEAD_MS);
  const commandBudgetMs = Math.min(
    commandUnits * perCommandOverheadMs,
    IOS_SIMCTL_CAPTURE_COMMAND_OVERHEAD_CEILING_MS,
  );
  const bufferedBudgetMs = commandBudgetMs + declaredWaitMs + 5000;
  const floorBoundedBudgetMs = Math.max(IOS_SIMCTL_CAPTURE_WATCHDOG_FLOOR_MS, bufferedBudgetMs);
  const timeoutMs = Math.max(
    Math.min(IOS_SIMCTL_CAPTURE_WATCHDOG_CEILING_MS, floorBoundedBudgetMs),
    bufferedBudgetMs,
  );
  return {
    ceilingMs: IOS_SIMCTL_CAPTURE_WATCHDOG_CEILING_MS,
    commandBudgetMs,
    commandUnits,
    declaredWaitMs,
    floorMs: IOS_SIMCTL_CAPTURE_WATCHDOG_FLOOR_MS,
    perCommandOverheadMs,
    source: 'derived',
    timeoutMs,
  };
}

/**
 * Creates the classified whole-capture watchdog error.
 *
 * @param {IosSimctlCaptureWatchdogBudget} watchdog
 * @returns {IosSimctlCaptureWatchdogError}
 */
function createIosSimctlCaptureWatchdogError(
  watchdog: IosSimctlCaptureWatchdogBudget,
): IosSimctlCaptureWatchdogError {
  const error = new Error(`iOS simctl capture did not complete within ${watchdog.timeoutMs}ms.`);
  return Object.assign(error, {
    code: 'ios_simctl_runner_liveness_timeout' as const,
    watchdog,
  });
}

/**
 * Checks whether an error came from the iOS simctl capture watchdog.
 *
 * @param {unknown} error
 * @returns {error is IosSimctlCaptureWatchdogError}
 */
function isIosSimctlCaptureWatchdogError(error: unknown): error is IosSimctlCaptureWatchdogError {
  return error instanceof Error &&
    (error as Partial<IosSimctlCaptureWatchdogError>).code === 'ios_simctl_runner_liveness_timeout';
}

/**
 * Runs the mutable iOS capture body with a whole-capture timeout.
 *
 * @param {{body: () => Promise<void>, watchdog: IosSimctlCaptureWatchdogBudget}} options
 * @returns {Promise<void>}
 */
async function runIosSimctlCaptureBodyWithWatchdog({
  body,
  watchdog,
}: {
  body: () => Promise<void>;
  watchdog: IosSimctlCaptureWatchdogBudget;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      body(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createIosSimctlCaptureWatchdogError(watchdog)), watchdog.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Normalizes a runner failure for raw artifact publication.
 *
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
function normalizeIosRunnerFailure(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack ?? '',
    };
  }

  return {
    message: String(error),
    name: 'UnknownError',
    stack: '',
  };
}

/**
 * Builds scalar health metadata for iOS runner liveness failures.
 *
 * @param {{currentPhase: IosSimctlCapturePhase, profileSessionStorage?: IosProfileSessionStorageSeed | null, rawPath: string, watchdog: IosSimctlCaptureWatchdogBudget}} options
 * @returns {Record<string, string | number | boolean | null>}
 */
function buildIosSimctlLivenessMetadata({
  currentPhase,
  profileSessionStorage,
  rawPath,
  watchdog,
}: {
  currentPhase: IosSimctlCapturePhase;
  profileSessionStorage?: IosProfileSessionStorageSeed | null;
  rawPath: string;
  watchdog: IosSimctlCaptureWatchdogBudget;
}): Record<string, string | number | boolean | null> {
  const metadata: Record<string, string | number | boolean | null> = {
    pendingPhase: currentPhase.name,
    pendingPhaseStartedAt: currentPhase.startedAt,
    rawPath,
    watchdogCommandBudgetMs: watchdog.commandBudgetMs,
    watchdogCommandUnits: watchdog.commandUnits,
    watchdogDeclaredWaitMs: watchdog.declaredWaitMs,
    watchdogSource: watchdog.source,
    watchdogTimeoutMs: watchdog.timeoutMs,
  };

  if (currentPhase.details && Object.keys(currentPhase.details).length > 0) {
    metadata.pendingPhaseDetails = JSON.stringify(currentPhase.details);
  }

  if (profileSessionStorage) {
    const commands = Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands : [];
    metadata.expectedEvidence = 'profile-session-start-or-profile-events';
    metadata.profileSessionCommandCount = commands.length;
    metadata.profileSessionRunId = profileSessionStorage.runId;
    metadata.profileSessionScenario = profileSessionStorage.scenario;
  }

  return metadata;
}

/**
 * Formats an iOS runner failure raw artifact.
 *
 * @param {Record<string, unknown>} failure
 * @returns {string}
 */
function formatIosRunnerFailureRaw(failure: Record<string, unknown>): string {
  return Object.entries(failure)
    .map(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return `${key}: ${JSON.stringify(value)}`;
      }
      if (Array.isArray(value)) {
        return `${key}: ${value.join(' ')}`;
      }
      return `${key}: ${String(value)}`;
    })
    .join('\n');
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
 * @returns {'crash' | 'exit' | null}
 */
function classifyIosAppLifecycleInstability(output: string): 'crash' | 'exit' | null {
  for (const line of String(output).split(/\r?\n/u)) {
    if (/xpcservice<com\.apple\.WebKit|Browser Engine helper|WebContent|WebKit\.Networking|WebKit\.GPU/iu.test(line)) {
      continue;
    }
    if (/\bSIG[A-Z0-9_]+\b|[Ss]egmentation fault|EXC_[A-Z_]+|scene-creation-failed/u.test(line)) {
      return 'crash';
    }
    if (/Process exited|exited with context|termination reported by launchd/iu.test(line)) {
      return 'exit';
    }
  }
  return null;
}

/**
 * Reads the current target application state from `simctl appinfo` output.
 *
 * @param {string} output
 * @returns {string | null}
 */
function parseIosAppInfoApplicationState(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const state = (parsed as Record<string, unknown>).ApplicationState;
      return typeof state === 'string' && state.trim().length > 0 ? state.trim() : null;
    }
  } catch {
    // simctl appinfo has emitted plist-like text on some Xcode versions.
  }

  const match = /ApplicationState\s*["'=:\s]+\s*"?([A-Za-z]+)"?/u.exec(trimmed);
  return match?.[1] ?? null;
}

/**
 * Reports whether a parsed iOS application state still owns the foreground surface.
 *
 * @param {string | null} state
 * @returns {boolean}
 */
function isIosAppInfoForegroundState(state: string | null): boolean {
  return state === 'ForegroundRunning' || state === 'ForegroundSuspended';
}

function profileSessionStartTargetForeground({
  appInfoCaptured,
  applicationState,
}: {
  appInfoCaptured: boolean;
  applicationState: string | null;
}): boolean | null {
  if (!appInfoCaptured || !applicationState) {
    return null;
  }

  return isIosAppInfoForegroundState(applicationState);
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
  profileStorageKeys = DEFAULT_PROFILE_STORAGE_KEYS,
  runId,
  scenario,
  startedAt = Date.now(),
}: {
  bundleId: string;
  commands?: IosProfileSessionStorageCommand[];
  dataContainer: string;
  profileStorageKeys?: ProfileStorageKeys;
  runId: string;
  scenario: string;
  startedAt?: number;
}): Promise<{commands: Record<string, unknown>[]; manifestPath: string; storageDir: string; session: Record<string, unknown>}> {
  const storageDir = resolveAsyncStorageDirectory({ bundleId, dataContainer });
  const manifest = readAsyncStorageManifestSync(storageDir);
  const resetKeys = [
    profileStorageKeys.event,
    profileStorageKeys.signal,
    profileStorageKeys.command,
    profileStorageKeys.sessionEntries,
  ];
  for (const key of resetKeys) {
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
    ...(typeof profileCommand.commandId === 'string' ? { commandId: profileCommand.commandId } : {}),
    ...(Array.isArray(profileCommand.dependsOnMilestones) && profileCommand.dependsOnMilestones.length > 0
      ? { dependsOnMilestones: profileCommand.dependsOnMilestones }
      : {}),
    ...(typeof profileCommand.label === 'string' ? { label: profileCommand.label } : {}),
    ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
    ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
    timestamp: typeof profileCommand.timestamp === 'number' ? profileCommand.timestamp : startedAt + index + 1,
    ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
    ...(typeof profileCommand.waitMs === 'number' ? { waitMs: profileCommand.waitMs } : {}),
    ...(typeof profileCommand.waitTimeoutMs === 'number' ? { waitTimeoutMs: profileCommand.waitTimeoutMs } : {}),
  }));
  manifest[profileStorageKeys.session] = JSON.stringify(session);
  if (queuedCommands.length > 0) {
    manifest[profileStorageKeys.command] = JSON.stringify(queuedCommands);
  }
  await removeAsyncStorageSpillFiles({
    keys: [profileStorageKeys.session, ...resetKeys],
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

function filterProfileRecordsForRun(
  records: unknown,
  runId: string,
): Record<string, unknown>[] {
  if (!Array.isArray(records)) {
    return [];
  }

  return records.filter((record): record is Record<string, unknown> => (
    Boolean(record) &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    (record as Record<string, unknown>).runId === runId
  ));
}

function hasProfileSessionStart(entries: Record<string, unknown>[]): boolean {
  return entries.some((entry) => (
    entry.kind === 'start' ||
    entry.type === 'start' ||
    entry.status === 'started' ||
    entry.event === 'profile_session_started'
  ));
}

function observeStoredProfileSessionStart({
  bundleId,
  dataContainer,
  profileStorageKeys,
  runId,
}: {
  bundleId: string;
  dataContainer: string;
  profileStorageKeys: ProfileStorageKeys;
  runId: string;
}): ProfileSessionStartObservation {
  const storedEvents = readProfileStorageJson({
    bundleId,
    dataContainer,
    fallback: [],
    key: profileStorageKeys.event,
  });
  const storedEntries = readProfileStorageJson({
    bundleId,
    dataContainer,
    fallback: [],
    key: profileStorageKeys.sessionEntries,
  });
  const events = filterProfileRecordsForRun(storedEvents, runId);
  const sessionEntries = filterProfileRecordsForRun(storedEntries, runId);
  return {
    eventCount: events.length,
    observed: hasProfileSessionStart(sessionEntries) || events.length > 0,
    sessionEntryCount: sessionEntries.length,
  };
}

async function waitForStoredProfileSessionStart({
  bundleId,
  dataContainer,
  profileStorageKeys,
  runId,
  timeoutMs,
  wait,
}: {
  bundleId: string;
  dataContainer: string;
  profileStorageKeys: ProfileStorageKeys;
  runId: string;
  timeoutMs: number;
  wait: (ms: number) => Promise<void>;
}): Promise<ProfileSessionStartWait> {
  const startedAt = Date.now();
  let pollCount = 0;
  let latest = observeStoredProfileSessionStart({
    bundleId,
    dataContainer,
    profileStorageKeys,
    runId,
  });

  while (!latest.observed && Date.now() - startedAt < timeoutMs) {
    pollCount += 1;
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await wait(Math.min(IOS_PROFILE_SESSION_START_POLL_MS, remainingMs));
    latest = observeStoredProfileSessionStart({
      bundleId,
      dataContainer,
      profileStorageKeys,
      runId,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  return {
    ...latest,
    completed: latest.observed,
    elapsedMs,
    pollCount,
    timeoutMs,
  };
}

function buildProfileSessionStartWaitCheck({
  readiness,
  runId,
  scenario,
  startWait,
}: ProfileSessionStartWaitCheckInput): Record<string, unknown> {
  if (startWait.completed) {
    return {
      name: 'ios_profile_session_start_wait',
      status: 'passed',
      source: 'runner',
      code: 'ios_profile_session_start_observed',
      message: `Observed same-run iOS profile-session app evidence for ${scenario}/${runId}.`,
    };
  }

  const nextAction = profileSessionStartNextAction(readiness?.failureClass ?? 'ios_profile_session_start_missing');
  const metadata: Record<string, string | number | boolean | null> = {
    ...nextActionHint(nextAction.code, nextAction.message),
    nextActionOwner: 'runtime_environment',
  };
  if (readiness) {
    Object.assign(metadata, {
      commandCount: readiness.commandCount,
      devClientDeepLinkOpened: readiness.devClientDeepLinkOpened,
      expectedEvidence: readiness.expectedEvidence,
      failureClass: readiness.failureClass,
      foregroundAppInfoCaptured: readiness.foregroundProbe?.appInfoCaptured ?? null,
      foregroundApplicationState: readiness.foregroundProbe?.applicationState ?? null,
      foregroundRawPath: readiness.foregroundProbe?.rawPath ?? null,
      foregroundTargetOwned: readiness.foregroundProbe?.targetForeground ?? null,
      lastDeepLinkLabel: readiness.lastDeepLinkLabel,
      lastDeepLinkUrl: readiness.lastDeepLinkUrl,
      pendingPhase: readiness.pendingPhase,
      profileCommandStorageKey: readiness.profileCommandStorageKey,
      profileEventStorageKey: readiness.profileEventStorageKey,
      profileSessionSeeded: readiness.seedRawPath !== null,
      profileSessionSeedRawPath: readiness.seedRawPath,
      profileSessionStartRepairCompleted: readiness.profileSessionStartRepair?.completed ?? null,
      profileSessionStartRepairRawPath: readiness.profileSessionStartRepair?.rawPath ?? null,
      profileSessionStartRepairReason: readiness.profileSessionStartRepair?.reason ?? null,
      profileSessionEntriesStorageKey: readiness.profileSessionEntriesStorageKey,
      profileSessionStorageKey: readiness.profileSessionStorageKey,
      readinessDetail: readiness.readinessDetail,
      readinessRawPath: 'raw/ios-profile-session-readiness.json',
    });
  }

  return {
    name: 'ios_profile_session_start_wait',
    status: 'failed',
    source: 'runner',
    code: 'ios_profile_session_start_wait_exhausted',
    message: `No same-run iOS profile-session app evidence appeared within ${startWait.timeoutMs}ms for ${scenario}/${runId}.`,
    metadata,
  };
}

function resolveExecFileExitCode(error: ExecFileError | null): number {
  if (!error) {
    return 0;
  }

  if (typeof error.code === 'number') {
    return error.code;
  }

  return 1;
}

/**
 * Runs a command with a timeout and captures stdout, stderr, and exit code without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<CommandResult>}
 */
function execFileCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_IOS_SIMCTL_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const timeout = normalizeCommandTimeoutMs(timeoutMs);
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', timeout }, (error: ExecFileError | null, stdout: string, stderr: string) => {
      const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');
      const timeoutMessage = timedOut ? `Command timed out after ${timeout}ms.` : '';
      resolve({
        command,
        args,
        exitCode: resolveExecFileExitCode(error),
        stderr: [stderr.trimEnd(), timeoutMessage].filter(Boolean).join('\n'),
        stdout,
      });
    });
  });
}

/**
 * Runs a command with the default iOS simctl timeout.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<CommandResult>}
 */
function execFileCommand(command: string, args: string[]): Promise<CommandResult> {
  return execFileCommandWithTimeout(command, args, DEFAULT_IOS_SIMCTL_COMMAND_TIMEOUT_MS);
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

function iosVideoCheckStatus({
  hasValidCapture,
  result,
}: {
  hasValidCapture: boolean;
  result: IosVideoFinalizeResult;
}): 'failed' | 'partial' | 'passed' {
  if (result.state === 'finalized' && hasValidCapture) {
    return 'passed';
  }
  if (hasValidCapture) {
    return 'partial';
  }
  return 'failed';
}

function iosVideoCheckCode({
  hasValidCapture,
  result,
  status,
}: {
  hasValidCapture: boolean;
  result: IosVideoFinalizeResult;
  status: 'failed' | 'partial' | 'passed';
}): string {
  if (status === 'passed') {
    return 'ios_video_captured';
  }
  if (result.cleanup.orphaned) {
    return 'ios_video_cleanup_orphaned';
  }
  if (result.state === 'timed_out') {
    return 'ios_video_finalize_timeout';
  }
  if (result.validation.reason === 'missing') {
    return 'ios_video_output_missing';
  }
  if (result.validation.reason === 'zero-bytes') {
    return 'ios_video_output_empty';
  }
  if (result.validation.reason !== 'valid') {
    return 'ios_video_output_invalid';
  }
  if (result.state === 'cancelled') {
    return hasValidCapture ? 'ios_video_cancelled_partial' : 'ios_video_cancelled';
  }
  return status === 'partial' ? `ios_video_${result.state}_partial` : `ios_video_${result.state}`;
}

function iosVideoCheckMessage({
  result,
  status,
}: {
  result: IosVideoFinalizeResult;
  status: 'failed' | 'partial' | 'passed';
}): string {
  if (status === 'passed') {
    return 'Captured bounded iOS simulator video.';
  }
  if (status === 'partial') {
    return `iOS simulator video ended with ${result.state} and preserved validated partial evidence.`;
  }
  if (result.cleanup.orphaned) {
    return 'iOS simulator video recorder did not exit cleanly after bounded cleanup.';
  }
  if (result.validation.reason === 'missing') {
    return 'iOS simulator video recording completed without creating an output file.';
  }
  if (result.validation.reason === 'zero-bytes') {
    return 'iOS simulator video recording produced an empty output file.';
  }
  if (result.validation.reason !== 'valid') {
    return `iOS simulator video output was invalid (${result.validation.reason}).`;
  }
  return `iOS simulator video ended with ${result.state} evidence.`;
}

function iosVideoCheckMetadata({
  rawFileName,
  result,
  status,
}: {
  rawFileName: string;
  result: IosVideoFinalizeResult;
  status: 'failed' | 'partial' | 'passed';
}): Record<string, unknown> | null {
  if (status === 'passed') {
    return null;
  }

  const actionHint = result.cleanup.orphaned
    ? nextActionHint(
        'inspect_ios_video_cleanup',
        `Inspect raw/${rawFileName} for signal escalation and confirm no orphaned simulator recorder process remains before trusting video evidence.`,
      )
    : result.validation.reason === 'valid'
      ? nextActionHint(
          'inspect_ios_video',
          `Inspect raw/${rawFileName} and the captures directory before trusting video evidence.`,
        )
      : nextActionHint(
          'inspect_ios_video_output',
          `Inspect raw/${rawFileName} and the generated captures directory to diagnose invalid or missing video output.`,
        );
  return {
    ...actionHint,
    cleanupOrphaned: result.cleanup.orphaned,
    cleanupSignals: result.cleanup.signals.join(',') || 'none',
    validationReason: result.validation.reason,
  };
}

function iosAppLifecycleStatus({
  appLifecycleAmbiguousExit,
  appLifecycleCaptured,
  appLifecycleCrashed,
}: {
  appLifecycleAmbiguousExit: boolean;
  appLifecycleCaptured: boolean;
  appLifecycleCrashed: boolean;
}): 'failed' | 'passed' | 'warning' {
  if (!appLifecycleCaptured) {
    return 'warning';
  }

  if (appLifecycleCrashed) {
    return 'failed';
  }

  if (appLifecycleAmbiguousExit) {
    return 'warning';
  }

  return 'passed';
}

function iosAppLifecycleCode({
  appLifecycleAmbiguousExit,
  appLifecycleCaptured,
  appLifecycleCrashed,
}: {
  appLifecycleAmbiguousExit: boolean;
  appLifecycleCaptured: boolean;
  appLifecycleCrashed: boolean;
}): string {
  if (!appLifecycleCaptured) {
    return 'ios_app_lifecycle_log_unavailable';
  }

  if (appLifecycleCrashed) {
    return 'ios_app_exited_during_capture';
  }

  if (appLifecycleAmbiguousExit) {
    return 'ios_app_lifecycle_exit_unconfirmed';
  }

  return 'ios_app_lifecycle_stable';
}

function iosAppLifecycleMessage({
  appLifecycleAmbiguousExit,
  appLifecycleCaptured,
  appLifecycleCrashed,
  bundleId,
}: {
  appLifecycleAmbiguousExit: boolean;
  appLifecycleCaptured: boolean;
  appLifecycleCrashed: boolean;
  bundleId: string;
}): string {
  if (!appLifecycleCaptured) {
    return 'Could not inspect the launched iOS app lifecycle log.';
  }

  if (appLifecycleCrashed) {
    return `App ${bundleId} exited during the simulator capture window.`;
  }

  if (appLifecycleAmbiguousExit) {
    return `Simulator logs mentioned an app exit for ${bundleId}, but no matching host crash report was found.`;
  }

  return `No native app exit was found for ${bundleId} during the simulator capture window.`;
}

function iosAppLifecycleMetadata({
  appLifecycleAmbiguousExit,
  appLifecycleCaptured,
  appLifecycleCrashed,
  appLifecycleRawFileName,
  hostDiagnosticReport,
}: {
  appLifecycleAmbiguousExit: boolean;
  appLifecycleCaptured: boolean;
  appLifecycleCrashed: boolean;
  appLifecycleRawFileName: string;
  hostDiagnosticReport: HostDiagnosticReportProbe | null;
}): {metadata: NextActionHint} | Record<string, never> {
  if (!appLifecycleCaptured) {
    return {
      metadata: nextActionHint(
        'inspect_ios_app_lifecycle',
        `Inspect raw/${appLifecycleRawFileName}, confirm xcrun simctl log access works for the selected simulator, then rerun the capture.`,
      ),
    };
  }

  if (!appLifecycleCrashed && !appLifecycleAmbiguousExit) {
    return {};
  }

  let nextActionCode = 'confirm_ios_app_lifecycle';
  let nextAction = `Inspect raw/${appLifecycleRawFileName}, raw/ios-host-diagnostic-report-search.txt, and simulator UI/process evidence before treating this as an app crash.`;
  if (appLifecycleCrashed) {
    nextActionCode = 'inspect_ios_app_crash';
    if (hostDiagnosticReport?.metadata?.matched) {
      nextAction = `Inspect raw/${appLifecycleRawFileName} and ${hostDiagnosticReport.metadata.rawPath}; do not trust timing or profile evidence until the app remains foregrounded.`;
    }
  }
  return {
    metadata: nextActionHint(nextActionCode, nextAction),
  };
}

function iosTargetForegroundStatus({
  appInfoCaptured,
  applicationState,
  targetForeground,
}: {
  appInfoCaptured: boolean;
  applicationState: string | null;
  targetForeground: boolean;
}): 'failed' | 'passed' | 'warning' {
  if (!appInfoCaptured || !applicationState) {
    return 'warning';
  }

  if (targetForeground) {
    return 'passed';
  }

  return 'failed';
}

function iosTargetForegroundCode({
  appInfoCaptured,
  applicationState,
  targetForeground,
}: {
  appInfoCaptured: boolean;
  applicationState: string | null;
  targetForeground: boolean;
}): string {
  if (!appInfoCaptured) {
    return 'ios_target_app_info_unavailable';
  }

  if (targetForeground) {
    return 'ios_target_app_foreground';
  }

  if (applicationState) {
    return 'ios_target_app_backgrounded';
  }

  return 'ios_target_app_state_unknown';
}

function iosTargetForegroundMessage({
  appInfoCaptured,
  applicationState,
  bundleId,
  targetForeground,
}: {
  appInfoCaptured: boolean;
  applicationState: string | null;
  bundleId: string;
  targetForeground: boolean;
}): string {
  if (!appInfoCaptured) {
    return `Could not inspect foreground state for ${bundleId}.`;
  }

  if (targetForeground) {
    return `Target app ${bundleId} remained foreground-owned after capture.`;
  }

  if (applicationState) {
    return `Target app ${bundleId} was ${applicationState} after capture.`;
  }

  return `Target app ${bundleId} foreground state was not reported by simctl appinfo.`;
}

function iosTargetForegroundMetadata({
  appInfoCaptured,
  applicationState,
  bundleId,
  devClientDeepLink,
  devClientDeepLinkOpened,
  rawFileName,
  targetForeground,
}: {
  appInfoCaptured: boolean;
  applicationState: string | null;
  bundleId: string;
  devClientDeepLink: {label: string | null; rawPath: string | null; url: string | null} | null;
  devClientDeepLinkOpened: boolean;
  rawFileName: string;
  targetForeground: boolean;
}): {metadata: IosTargetForegroundFailure} | Record<string, never> {
  if (!appInfoCaptured) {
    return {
      metadata: nextActionHint(
        'inspect_ios_app_info',
        `Inspect raw/${rawFileName}; if simctl appinfo is unavailable on this Xcode, use a host runner that can prove target foreground ownership before trusting screenshot evidence.`,
      ),
    };
  }

  if (targetForeground) {
    return {};
  }

  if (applicationState) {
    if (devClientDeepLinkOpened) {
      return {
        metadata: {
          ...nextActionHint(
            'reload_ios_dev_client_url',
            `The target app reported ${applicationState} after an iOS dev-client URL was opened. Inspect raw/${rawFileName}, restart Metro from the consuming app worktree if needed, reopen the dev-client URL, and rerun before trusting profile-session or screenshot evidence.`,
          ),
          devClientDeepLinkLabel: devClientDeepLink?.label ?? null,
          devClientDeepLinkRawPath: devClientDeepLink?.rawPath ?? null,
          devClientDeepLinkUrl: devClientDeepLink?.url ?? null,
          failureClass: 'dev_client_foreground_mismatch',
        },
      };
    }

    return {
      metadata: nextActionHint(
        'restore_ios_target_foreground',
        `The target app reported ${applicationState}. Inspect raw/${rawFileName}, confirm the selected bundle and dev-client URL, and rerun on a simulator where ${bundleId} owns the foreground surface.`,
      ),
    };
  }

  return {
    metadata: nextActionHint(
      'confirm_ios_target_foreground',
      `Inspect raw/${rawFileName} and simulator UI evidence; this Xcode/simulator did not report ApplicationState.`,
    ),
  };
}

/**
 * Reports whether a successfully opened deep link targeted an Expo dev-client URL.
 *
 * @param {Array<{exitCode?: unknown, label?: unknown, url?: unknown}>} results
 * @returns {boolean}
 */
function hasOpenedIosDevClientDeepLink(results: Array<{exitCode?: unknown; label?: unknown; url?: unknown}>): boolean {
  return results.some((result) => {
    if (result.exitCode !== 0) {
      return false;
    }
    const label = typeof result.label === 'string' ? result.label : '';
    const url = typeof result.url === 'string' ? result.url : '';
    return label === 'ios-dev-client-url' || url.includes('expo-development-client');
  });
}

/**
 * Returns the last successfully opened deep link in a capture attempt.
 *
 * @param {Array<{exitCode?: unknown, label?: unknown, rawPath?: unknown, url?: unknown}>} results
 * @returns {{label: string | null, rawPath: string | null, url: string | null} | null}
 */
function lastOpenedDeepLink(
  results: Array<{exitCode?: unknown; label?: unknown; rawPath?: unknown; url?: unknown}>,
): {label: string | null; rawPath: string | null; url: string | null} | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result || result.exitCode !== 0) {
      continue;
    }
    return {
      label: typeof result.label === 'string' ? result.label : null,
      rawPath: typeof result.rawPath === 'string' ? result.rawPath : null,
      url: typeof result.url === 'string' ? result.url : null,
    };
  }
  return null;
}

/**
 * Returns the last successfully opened iOS development-client URL.
 *
 * @param {Array<{exitCode?: unknown, label?: unknown, rawPath?: unknown, url?: unknown}>} results
 * @returns {{label: string | null, rawPath: string | null, url: string} | null}
 */
function lastOpenedIosDevClientDeepLink(
  results: Array<{exitCode?: unknown; label?: unknown; rawPath?: unknown; url?: unknown}>,
): {label: string | null; rawPath: string | null; url: string} | null {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result || result.exitCode !== 0) {
      continue;
    }
    const label = typeof result.label === 'string' ? result.label : '';
    const url = typeof result.url === 'string' ? result.url : '';
    if (label !== 'ios-dev-client-url' && !url.includes('expo-development-client')) {
      continue;
    }
    return {
      label: label || null,
      rawPath: typeof result.rawPath === 'string' ? result.rawPath : null,
      url,
    };
  }
  return null;
}

/**
 * Reports whether reopening the configured dev-client URL can reasonably repair readiness.
 *
 * @param {ProfileSessionStartFailureClass} failureClass
 * @returns {boolean}
 */
function shouldRetryIosDevClientForProfileSessionStart(failureClass: ProfileSessionStartFailureClass): boolean {
  switch (failureClass) {
    case 'dev_client_bundle_or_command_channel_not_ready':
    case 'dev_client_not_foreground':
    case 'dev_client_shell_foreground_no_js_app':
      return true;
    case 'ios_profile_session_start_missing':
    case 'profile_command_channel_missing':
      return false;
  }
}

/**
 * Builds diagnostic context for iOS profile-session startup readiness.
 *
 * @param {{currentPhase: IosSimctlCapturePhase, deepLinkResults: Record<string, unknown>[], profileSessionStorage: IosProfileSessionStorageSeed, profileStorageKeys: ProfileStorageKeys, seedRawPath: string | null}} options
 * @returns {ProfileSessionStartReadinessContext}
 */
function buildProfileSessionStartReadinessContext({
  currentPhase,
  deepLinkResults,
  foregroundProbe,
  profileSessionStartRepair,
  profileSessionStorage,
  profileStorageKeys,
  seedRawPath,
}: {
  currentPhase: IosSimctlCapturePhase;
  deepLinkResults: Record<string, unknown>[];
  foregroundProbe: ProfileSessionStartForegroundProbe | null;
  profileSessionStartRepair: ProfileSessionStartRepairAttempt | null;
  profileSessionStorage: IosProfileSessionStorageSeed;
  profileStorageKeys: ProfileStorageKeys;
  seedRawPath: string | null;
}): ProfileSessionStartReadinessContext {
  const lastDeepLink = lastOpenedDeepLink(deepLinkResults);
  const commands = Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands : [];
  const devClientDeepLinkOpened = hasOpenedIosDevClientDeepLink(deepLinkResults);
  return {
    commandCount: commands.length,
    devClientDeepLinkOpened,
    expectedEvidence: 'profile-session-start-or-profile-events',
    failureClass: profileSessionStartFailureClass({ commandCount: commands.length, devClientDeepLinkOpened, foregroundProbe }),
    foregroundProbe,
    lastDeepLinkLabel: lastDeepLink?.label ?? null,
    lastDeepLinkUrl: lastDeepLink?.url ?? null,
    pendingPhase: currentPhase.name,
    profileCommandStorageKey: profileStorageKeys.command,
    profileEventStorageKey: profileStorageKeys.event,
    profileSessionStartRepair,
    profileSessionEntriesStorageKey: profileStorageKeys.sessionEntries,
    profileSessionStorageKey: profileStorageKeys.session,
    readinessDetail: profileSessionStartReadinessDetail({ devClientDeepLinkOpened, foregroundProbe }),
    seedRawPath,
    waitRawPath: 'raw/ios-profile-session-start-wait.json',
  };
}

/**
 * Classifies the missing-start owner shape for storage-backed iOS profile sessions.
 *
 * @param {{commandCount: number, devClientDeepLinkOpened: boolean, foregroundProbe: ProfileSessionStartForegroundProbe | null}} options
 * @returns {ProfileSessionStartFailureClass}
 */
function profileSessionStartFailureClass({
  commandCount,
  devClientDeepLinkOpened,
  foregroundProbe,
}: {
  commandCount: number;
  devClientDeepLinkOpened: boolean;
  foregroundProbe: ProfileSessionStartForegroundProbe | null;
}): ProfileSessionStartFailureClass {
  if (!devClientDeepLinkOpened) {
    return 'ios_profile_session_start_missing';
  }

  if (!foregroundProbe?.appInfoCaptured || foregroundProbe.targetForeground === null) {
    return 'dev_client_bundle_or_command_channel_not_ready';
  }

  if (foregroundProbe.targetForeground === false) {
    return 'dev_client_not_foreground';
  }

  if (commandCount === 0) {
    return 'dev_client_shell_foreground_no_js_app';
  }

  return 'profile_command_channel_missing';
}

/**
 * Returns a product-neutral next action for iOS profile-session start failures.
 *
 * @param {ProfileSessionStartFailureClass} failureClass
 * @returns {{code: string, message: string}}
 */
function profileSessionStartNextAction(failureClass: ProfileSessionStartFailureClass): { code: string; message: string } {
  switch (failureClass) {
    case 'dev_client_not_foreground':
      return {
        code: 'reload_ios_dev_client_url',
        message:
          'Open an explicit iOS development-client URL and confirm the target app owns the foreground surface before rerunning.',
      };
    case 'dev_client_shell_foreground_no_js_app':
      return {
        code: 'fix_ios_dev_client_bundle_surface',
        message:
          'Confirm Metro is serving the intended app bundle, clear stale development-client server state if needed, and reload the explicit dev-client URL.',
      };
    case 'profile_command_channel_missing':
      return {
        code: 'fix_ios_profile_command_channel',
        message:
          'Confirm the app has adopted the profile-session helper and starts the command channel after the JavaScript bundle loads.',
      };
    case 'dev_client_bundle_or_command_channel_not_ready':
      return {
        code: 'fix_ios_dev_client_bundle_or_command_channel',
        message:
          'Confirm the iOS development client loaded the intended app bundle and that the app can start the scenario command channel before rerunning.',
      };
    case 'ios_profile_session_start_missing':
      return {
        code: 'fix_ios_profile_session_start',
        message:
          'Confirm the iOS app can load the configured scenario session and emit same-run profile-session evidence before rerunning.',
      };
  }
}

/**
 * Refines iOS missing-start readiness so agents can tell foreground bundle
 * ownership apart from a missing app command channel.
 *
 * @param {{devClientDeepLinkOpened: boolean, foregroundProbe: ProfileSessionStartForegroundProbe | null}} options
 * @returns {ProfileSessionStartReadinessDetail}
 */
function profileSessionStartReadinessDetail({
  devClientDeepLinkOpened,
  foregroundProbe,
}: {
  devClientDeepLinkOpened: boolean;
  foregroundProbe: ProfileSessionStartForegroundProbe | null;
}): ProfileSessionStartReadinessDetail {
  if (!devClientDeepLinkOpened) {
    return 'profile_session_start_missing_without_dev_client';
  }

  if (!foregroundProbe?.appInfoCaptured || foregroundProbe.targetForeground === null) {
    return 'dev_client_foreground_unknown';
  }

  if (foregroundProbe.targetForeground === false) {
    return 'dev_client_not_foreground';
  }

  return 'dev_client_foreground_command_channel_missing';
}

/**
 * Captures target foreground state when iOS profile-session startup never appears.
 *
 * @param {{bundleId: string, deviceUdid: string, executor: CommandExecutor, xcrunPath: string}} options
 * @returns {Promise<{probe: ProfileSessionStartForegroundProbe, rawContent: string}>}
 */
async function inspectProfileSessionStartForeground({
  bundleId,
  deviceUdid,
  executor,
  xcrunPath,
}: {
  bundleId: string;
  deviceUdid: string;
  executor: CommandExecutor;
  xcrunPath: string;
}): Promise<{probe: ProfileSessionStartForegroundProbe; rawContent: string}> {
  const result = await executor(xcrunPath, ['simctl', 'appinfo', deviceUdid, bundleId]);
  const rawContent = formatIosSimctlRawOutput(result);
  const applicationState = parseIosAppInfoApplicationState(rawContent);
  const appInfoCaptured = result.exitCode === 0;
  return {
    probe: {
      appInfoCaptured,
      applicationState,
      rawPath: 'raw/ios-profile-session-start-app-info.txt',
      targetForeground: profileSessionStartTargetForeground({ appInfoCaptured, applicationState }),
    },
    rawContent,
  };
}

/**
 * Creates a raw artifact filename for a simulator launch environment key.
 *
 * @param {string} key
 * @returns {string}
 */
function launchEnvironmentRawFileName(key: string): string {
  return `ios-launch-env-${key.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}.txt`;
}

/**
 * Reports whether the requested capture path can mutate simulator app lifecycle.
 *
 * @param {{deepLinks: IosSimctlDeepLink[], launch: boolean, profileSessionStorage: IosProfileSessionStorageSeed | null, record: boolean, terminateBeforeLaunch: boolean}} options
 * @returns {boolean}
 */
function mutatesSimulatorLifecycle({
  deepLinks,
  launch,
  profileSessionStorage,
  record,
  terminateBeforeLaunch,
}: {
  deepLinks: IosSimctlDeepLink[];
  launch: boolean;
  profileSessionStorage: IosProfileSessionStorageSeed | null;
  record: boolean;
  terminateBeforeLaunch: boolean;
}): boolean {
  return launch || terminateBeforeLaunch || Boolean(profileSessionStorage) || record || deepLinks.length > 0;
}

/**
 * Reads simulator launch environment values that can silently inject runner behavior.
 *
 * @param {{deviceUdid: string, executor: CommandExecutor, xcrunPath: string}} options
 * @returns {Promise<SimulatorLaunchEnvironmentProbe>}
 */
async function inspectSimulatorLaunchEnvironment({
  deviceUdid,
  executor,
  xcrunPath,
}: {
  deviceUdid: string;
  executor: CommandExecutor;
  xcrunPath: string;
}): Promise<SimulatorLaunchEnvironmentProbe> {
  const values: Record<string, Record<string, unknown>> = {};
  const raw: Record<string, string> = {};

  for (const key of SIMULATOR_LAUNCH_ENV_KEYS) {
    const result = await executor(xcrunPath, ['simctl', 'spawn', deviceUdid, 'launchctl', 'getenv', key]);
    const rawFileName = launchEnvironmentRawFileName(key);
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    raw[rawFileName] = output;
    values[key] = {
      args: result.args,
      exitCode: result.exitCode,
      rawPath: `raw/${rawFileName}`,
      value: result.exitCode === 0 ? result.stdout.trim() : null,
    };
  }

  return {
    clean: Object.values(values).every((entry) => (
      entry.exitCode !== 0 || typeof entry.value !== 'string' || entry.value.length === 0
    )),
    metadata: values,
    raw,
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
  const partial = checks.some((check) => check.status === 'partial');
  const healthStatus = failed ? 'failed' : partial ? 'partial' : 'passed';
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'ios-simctl-capture',
      flowId: 'ios-simctl-capture',
      runId,
      healthStatus,
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
async function runIosSimctlCapture(options: IosSimctlCaptureOptions = {}): Promise<IosSimctlCaptureResult> {
  const {
    bundleId = null,
    captureWatchdogMs: captureWatchdogMsOverride,
    commandTimeoutMs: requestedCommandTimeoutMs = DEFAULT_IOS_SIMCTL_COMMAND_TIMEOUT_MS,
    collectProfileStorage = false,
    conflictingBundleIds = [],
    deepLinks = [],
    delay: wait = delay,
    device = null,
    diagnosticReportsDir = null,
    executor: providedExecutor,
    launch = false,
    logLast = '2m',
    outputDir = path.resolve('artifacts/ios-simctl-capture'),
    profileSessionStorage = null,
    profileSessionStartWaitMs = profileSessionStorage ? DEFAULT_IOS_PROFILE_SESSION_START_WAIT_MS : 0,
    profileStorageKeys: profileStorageKeyOverrides,
    runId = createRunId(),
    record = false,
    recorderFactory,
    screenshot = false,
    screenshotDisplay,
    screenshotMask,
    screenshotType,
    terminateBeforeLaunch = false,
    waitMs = 0,
    xcrunPath = 'xcrun',
  } = options;
  const commandTimeoutMs = normalizeCommandTimeoutMs(requestedCommandTimeoutMs);
  const executor: CommandExecutor = providedExecutor
    ? providedExecutor
    : ((command, args) => execFileCommandWithTimeout(command, args, commandTimeoutMs));
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  await fsp.mkdir(rawDir, { recursive: true });
  const profileStorageKeys = resolveProfileStorageKeys(profileStorageKeyOverrides);

  const raw: Record<string, string> = {};
  const captures: { screenshot: string | null; video: string | null } = {
    screenshot: null,
    video: null,
  };
  const checks: Record<string, unknown>[] = [];
  const deepLinkResults: Record<string, unknown>[] = [];
  let profileSessionStartReady = true;
  let simulator: IosSimulator | null = null;
  let currentPhase: IosSimctlCapturePhase = {
    name: 'initializing',
    startedAt: new Date().toISOString(),
  };
  const setCurrentPhase = (name: string, details?: Record<string, unknown>): void => {
    currentPhase = {
      ...(details ? { details } : {}),
      name,
      startedAt: new Date().toISOString(),
    };
    metadata.currentPhase = currentPhase;
  };
  const captureStartedRawFileName = 'ios-simctl-capture-started.json';
  const captureStartedAt = new Date();
  const captureWatchdog = deriveIosSimctlCaptureWatchdogBudget({
    bundleId,
    ...(typeof captureWatchdogMsOverride === 'number' ? { captureWatchdogMs: captureWatchdogMsOverride } : {}),
    collectProfileStorage,
    commandTimeoutMs,
    conflictingBundleIds,
    deepLinks,
    launch,
    profileSessionStorage,
    profileSessionStartWaitMs,
    record,
    screenshot,
    terminateBeforeLaunch,
    waitMs,
  });
  const captureDeadlineEpochMs = captureStartedAt.getTime() + captureWatchdog.timeoutMs;
  const captureStartedCheckpoint = {
    status: 'started',
    message: 'iOS simctl capture started and the whole-capture watchdog deadline was derived.',
    runId,
    commandTimeoutMs,
    startedAt: captureStartedAt.toISOString(),
    watchdog: {
      ...captureWatchdog,
      armed: true,
      deadlineEpochMs: captureDeadlineEpochMs,
      deadlineIso: new Date(captureDeadlineEpochMs).toISOString(),
    },
    selectedInputs: {
      bundleId,
      collectProfileStorage,
      deepLinks,
      device: device || 'booted',
      launch,
      logLast,
      profileSessionStorage: profileSessionStorage
        ? {
            commandCount: Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands.length : 0,
            runId: profileSessionStorage.runId,
            scenario: profileSessionStorage.scenario,
          }
        : null,
      record,
      screenshot,
      terminateBeforeLaunch,
      waitMs,
      xcrunPath,
    },
  };
  raw[captureStartedRawFileName] = JSON.stringify(captureStartedCheckpoint, null, 2);
  await fsp.writeFile(
    path.join(rawDir, captureStartedRawFileName),
    `${JSON.stringify(captureStartedCheckpoint, null, 2)}\n`,
    'utf8',
  );
  const selectedDevice = device || 'booted';
  const metadata: Record<string, unknown> = {
    bundleId,
    captureStarted: {
      rawPath: `raw/${captureStartedRawFileName}`,
      startedAt: captureStartedCheckpoint.startedAt,
    },
    captureWatchdog: {
      ...captureWatchdog,
      armed: true,
      deadlineEpochMs: captureDeadlineEpochMs,
      deadlineIso: new Date(captureDeadlineEpochMs).toISOString(),
    },
    commandTimeoutMs,
    collectProfileStorage,
    conflictingBundleIds: [],
    deepLinks,
    deepLinkResults,
    diagnosticReportsDir: diagnosticReportsDir || defaultDiagnosticReportsDir(),
    launch,
    logLast,
    profileStorageKeys,
    profileSessionStorage: profileSessionStorage
      ? {
          commandCount: Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands.length : 0,
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
          startedAt: profileSessionStorage.startedAt ?? null,
          startWaitMs: profileSessionStartWaitMs,
        }
      : null,
    record,
    screenshot,
    selectedDevice,
    selectedSimulator: null,
    terminateBeforeLaunch,
    waitMs,
    xcrunPath,
  };
  metadata.currentPhase = currentPhase;
  let activeRecording: import('./ios-simctl-driver').IosSimctlRecording | null = null;
  const finalizeRecording = async (reason: 'cancelled' | 'completed'): Promise<void> => {
    if (!activeRecording) return;
    setCurrentPhase('finalizing_video', { reason });
    const result = await activeRecording.stop(reason);
    raw[result.rawFileName] = `${JSON.stringify({ stderr: result.stderr, stdout: result.stdout }, null, 2)}\n`;
    const relativeCapturePath = result.validation.valid && result.capturePath && fs.existsSync(result.capturePath)
      ? `captures/${path.basename(result.capturePath)}`
      : null;
    if (relativeCapturePath) captures.video = relativeCapturePath;
    const hasValidCapture = Boolean(relativeCapturePath);
    const videoCheckStatus = iosVideoCheckStatus({ hasValidCapture, result });
    const videoCheckMetadata = iosVideoCheckMetadata({
      rawFileName: result.rawFileName,
      result,
      status: videoCheckStatus,
    });
    checks.push({
      name: 'ios_video_captured',
      status: videoCheckStatus,
      source: 'runner',
      code: iosVideoCheckCode({ hasValidCapture, result, status: videoCheckStatus }),
      message: iosVideoCheckMessage({ result, status: videoCheckStatus }),
      ...(videoCheckMetadata ? { metadata: videoCheckMetadata } : {}),
    });
    metadata.video = {
      args: result.args.map((arg) => path.isAbsolute(arg) ? `captures/${path.basename(arg)}` : arg),
      capturePath: relativeCapturePath,
      cleanup: result.cleanup,
      exitCode: result.exitCode,
      rawPath: `raw/${result.rawFileName}`,
      signal: result.signal ?? null,
      state: result.state,
      timeline: result.timeline,
      validation: result.validation,
    };
    activeRecording = null;
  };
  const runCaptureBody = async (): Promise<void> => {
    setCurrentPhase('listing_simulators', { device: selectedDevice });
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
    simulator = simctlAvailable ? selectSimulator(simulators, device) : null;
    const simulatorBooted = Boolean(simulator && simulator.state === 'Booted');
    metadata.selectedSimulator = simulator;
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

    if (simulator && simulator.state === 'Booted') {
      setCurrentPhase('checking_launch_environment', { device: simulator.udid });
      const launchEnvironmentNeedsCleanState = mutatesSimulatorLifecycle({
        deepLinks,
        launch,
        profileSessionStorage,
        record,
        terminateBeforeLaunch,
      });
      const launchEnvironment = await inspectSimulatorLaunchEnvironment({
        deviceUdid: simulator.udid,
        executor,
        xcrunPath,
      });
      Object.assign(raw, launchEnvironment.raw);
      const launchEnvironmentProbeAvailable = Object.values(launchEnvironment.metadata).some((entry) => (
        typeof entry === 'object'
          && entry !== null
          && (entry as { exitCode?: unknown }).exitCode === 0
      ));
      const launchEnvironmentCleanEnough = launchEnvironment.clean || !launchEnvironmentNeedsCleanState;
      let launchEnvironmentStatus: 'failed' | 'passed' | 'warning' = 'warning';
      let launchEnvironmentCode = 'ios_simulator_launch_environment_unavailable';
      let launchEnvironmentMessage = 'Could not inspect simulator launch environment.';
      if (launchEnvironmentProbeAvailable && launchEnvironmentCleanEnough) {
        launchEnvironmentStatus = 'passed';
        launchEnvironmentCode = 'ios_simulator_launch_environment_clean';
        launchEnvironmentMessage = 'Simulator launch environment has no known hidden runner injection for this capture mode.';
      } else if (launchEnvironmentProbeAvailable) {
        launchEnvironmentStatus = 'failed';
        launchEnvironmentCode = 'ios_simulator_launch_environment_contaminated';
        launchEnvironmentMessage = 'Simulator launch environment contains hidden runner injection that can contaminate simctl proof.';
      }
      checks.push({
        name: 'ios_simulator_launch_environment_clean',
        status: launchEnvironmentStatus,
        source: 'runner',
        code: launchEnvironmentCode,
        message: launchEnvironmentMessage,
        ...(launchEnvironmentProbeAvailable && !launchEnvironmentCleanEnough
          ? {
              metadata: nextActionHint(
                'clear_ios_simulator_launch_environment',
                `Clear ${SIMULATOR_LAUNCH_ENV_KEYS.join(' and ')} for the selected simulator, or use the runner that owns that injected environment instead of simctl proof.`,
              ),
            }
          : {}),
      });
      metadata.launchEnvironment = launchEnvironment.metadata;
      const driver = createIosSimctlDriver({
        deviceUdid: simulator.udid,
        executor,
        ...(recorderFactory ? { recorderFactory } : {}),
        xcrunPath,
      });
      let dataContainerPath: string | null = null;
      let hasInstalledConflictingBundle = false;
      let launchedAppPid: string | null = null;
      const lifecycleMutationBlocked = launchEnvironmentProbeAvailable && !launchEnvironmentCleanEnough;
      if (bundleId) {
        setCurrentPhase('checking_app_installation', { bundleId, device: simulator.udid });
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
          setCurrentPhase('resolving_app_data_container', { bundleId, device: simulator.udid });
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

      if (terminateBeforeLaunch && !hasInstalledConflictingBundle && !lifecycleMutationBlocked) {
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
          setCurrentPhase('terminating_app', { bundleId, device: simulator.udid });
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

      if (profileSessionStorage && !hasInstalledConflictingBundle && !lifecycleMutationBlocked) {
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
          setCurrentPhase('seeding_profile_session_storage', {
            commandCount: Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands.length : 0,
            runId: profileSessionStorage.runId,
            scenario: profileSessionStorage.scenario,
          });
          const seeded = await seedProfileSessionStorage({
            bundleId,
            ...(Array.isArray(profileSessionStorage.commands)
              ? { commands: profileSessionStorage.commands }
              : {}),
            dataContainer: dataContainerPath,
            profileStorageKeys,
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

      if (record && !hasInstalledConflictingBundle && !lifecycleMutationBlocked) {
        setCurrentPhase('starting_video', { device: simulator.udid, waitMs });
        const recording = await driver.startRecording({
          outputPath: path.join(layout.captures, 'ios-recording.mp4'),
        });
        activeRecording = recording;
        if (recording.state !== 'active') await finalizeRecording('completed');
      }

      if (launch && !hasInstalledConflictingBundle && !lifecycleMutationBlocked) {
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
          setCurrentPhase('launching_app', { bundleId, device: simulator.udid });
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

      for (const [index, deepLink] of (hasInstalledConflictingBundle || lifecycleMutationBlocked ? [] : deepLinks).entries()) {
        setCurrentPhase('opening_deep_link', {
          label: deepLink.label ?? index + 1,
          url: deepLink.url,
        });
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
          setCurrentPhase('waiting_after_deep_link', {
            label: deepLink.label ?? index + 1,
            waitMs: deepLink.waitMs,
          });
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
      if (profileSessionStorage && bundleId && dataContainerPath && profileSessionStartWaitMs > 0) {
        setCurrentPhase('waiting_for_profile_session_start', {
          commandCount: Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands.length : 0,
          devClientDeepLinkOpened: hasOpenedIosDevClientDeepLink(deepLinkResults),
          expectedEvidence: 'profile-session-start-or-profile-events',
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
          timeoutMs: profileSessionStartWaitMs,
        });
        let profileSessionStartPhase = currentPhase;
        let startWait = await waitForStoredProfileSessionStart({
          bundleId,
          dataContainer: dataContainerPath,
          profileStorageKeys,
          runId: profileSessionStorage.runId,
          timeoutMs: profileSessionStartWaitMs,
          wait,
        });
        let profileSessionStartRepair: ProfileSessionStartRepairAttempt | null = null;
        raw['ios-profile-session-start-wait.json'] = JSON.stringify(startWait, null, 2);
        let foregroundProbe: ProfileSessionStartForegroundProbe | null = null;
        if (!startWait.completed) {
          setCurrentPhase('inspecting_profile_session_start_foreground', {
            bundleId,
            runId: profileSessionStorage.runId,
            scenario: profileSessionStorage.scenario,
          });
          const startForeground = await inspectProfileSessionStartForeground({
            bundleId,
            deviceUdid: simulator.udid,
            executor,
            xcrunPath,
          });
          foregroundProbe = startForeground.probe;
          raw['ios-profile-session-start-app-info.txt'] = startForeground.rawContent;
          const initialReadiness = buildProfileSessionStartReadinessContext({
            currentPhase: profileSessionStartPhase,
            deepLinkResults,
            foregroundProbe,
            profileSessionStartRepair,
            profileSessionStorage,
            profileStorageKeys,
            seedRawPath: raw['ios-profile-session-seed.json'] ? 'raw/ios-profile-session-seed.json' : null,
          });
          const retryDeepLink = shouldRetryIosDevClientForProfileSessionStart(initialReadiness.failureClass)
            ? lastOpenedIosDevClientDeepLink(deepLinkResults)
            : null;
          if (retryDeepLink) {
            setCurrentPhase('reopening_dev_client_for_profile_session_start', {
              reason: initialReadiness.failureClass,
              runId: profileSessionStorage.runId,
              scenario: profileSessionStorage.scenario,
              url: retryDeepLink.url,
            });
            const retryRawFileName = 'ios-dev-client-readiness-retry-1.txt';
            const retryOpenResult = await driver.openDeepLink({
              rawFileName: retryRawFileName,
              url: retryDeepLink.url,
            });
            const retryOpened = retryOpenResult.exitCode === 0;
            raw[retryOpenResult.rawFileName] = formatIosSimctlRawOutput(retryOpenResult);
            deepLinkResults.push({
              args: retryOpenResult.args,
              exitCode: retryOpenResult.exitCode,
              label: 'ios-dev-client-readiness-retry',
              rawPath: `raw/${retryOpenResult.rawFileName}`,
              url: retryDeepLink.url,
              waitMs: 0,
            });
            checks.push({
              name: 'ios_dev_client_readiness_repair_opened',
              status: retryOpened ? 'passed' : 'failed',
              source: 'runner',
              code: retryOpened ? 'ios_dev_client_readiness_repair_opened' : 'ios_dev_client_readiness_repair_failed',
              message: retryOpened
                ? 'Reopened the configured iOS development-client URL after missing same-run profile-session evidence.'
                : 'Failed to reopen the configured iOS development-client URL after missing same-run profile-session evidence.',
              ...(!retryOpened
                ? {
                    metadata: nextActionHint(
                      'reload_ios_dev_client_url',
                      `Inspect raw/${retryOpenResult.rawFileName}, verify the app URL scheme, and confirm the dev client can load the configured bundle URL.`,
                    ),
                  }
                : {}),
            });
            profileSessionStartRepair = {
              completed: false,
              elapsedMs: null,
              exitCode: retryOpenResult.exitCode,
              label: 'ios-dev-client-readiness-retry',
              rawPath: `raw/${retryOpenResult.rawFileName}`,
              reason: initialReadiness.failureClass,
              timeoutMs: profileSessionStartWaitMs,
              url: retryDeepLink.url,
            };
            if (retryOpened) {
              setCurrentPhase('waiting_for_profile_session_start_after_dev_client_repair', {
                commandCount: Array.isArray(profileSessionStorage.commands) ? profileSessionStorage.commands.length : 0,
                expectedEvidence: 'profile-session-start-or-profile-events',
                repairReason: initialReadiness.failureClass,
                runId: profileSessionStorage.runId,
                scenario: profileSessionStorage.scenario,
                timeoutMs: profileSessionStartWaitMs,
              });
              profileSessionStartPhase = currentPhase;
              startWait = await waitForStoredProfileSessionStart({
                bundleId,
                dataContainer: dataContainerPath,
                profileStorageKeys,
                runId: profileSessionStorage.runId,
                timeoutMs: profileSessionStartWaitMs,
                wait,
              });
              raw['ios-profile-session-start-wait-retry-1.json'] = JSON.stringify(startWait, null, 2);
              raw['ios-profile-session-start-wait.json'] = JSON.stringify(startWait, null, 2);
              profileSessionStartRepair = {
                ...profileSessionStartRepair,
                completed: startWait.completed,
                elapsedMs: startWait.elapsedMs,
              };
              if (!startWait.completed) {
                setCurrentPhase('inspecting_profile_session_start_foreground_after_dev_client_repair', {
                  bundleId,
                  runId: profileSessionStorage.runId,
                  scenario: profileSessionStorage.scenario,
                });
                const retryForeground = await inspectProfileSessionStartForeground({
                  bundleId,
                  deviceUdid: simulator.udid,
                  executor,
                  xcrunPath,
                });
                foregroundProbe = {
                  ...retryForeground.probe,
                  rawPath: 'raw/ios-profile-session-start-app-info-retry-1.txt',
                };
                raw['ios-profile-session-start-app-info-retry-1.txt'] = retryForeground.rawContent;
              }
            }
          }
        }
        setCurrentPhase('classifying_profile_session_start_readiness', {
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
        });
        const readiness = buildProfileSessionStartReadinessContext({
          currentPhase: profileSessionStartPhase,
          deepLinkResults,
          foregroundProbe,
          profileSessionStartRepair,
          profileSessionStorage,
          profileStorageKeys,
          seedRawPath: raw['ios-profile-session-seed.json'] ? 'raw/ios-profile-session-seed.json' : null,
        });
        raw['ios-profile-session-readiness.json'] = JSON.stringify(readiness, null, 2);
        metadata.profileSessionStartWait = {
          ...startWait,
          rawPath: 'raw/ios-profile-session-start-wait.json',
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
        };
        metadata.profileSessionReadiness = {
          ...readiness,
          rawPath: 'raw/ios-profile-session-readiness.json',
        };
        metadata.profileSessionStartRepair = profileSessionStartRepair;
        checks.push(buildProfileSessionStartWaitCheck({
          readiness,
          runId: profileSessionStorage.runId,
          scenario: profileSessionStorage.scenario,
          startWait,
        }));
        profileSessionStartReady = startWait.completed;
      }
      if (activeRecording && profileSessionStartReady && waitMs > 0) {
        setCurrentPhase('waiting_for_capture_window', { recording: true, waitMs });
        await wait(waitMs);
        checks.push({
          name: 'ios_capture_window_waited',
          status: 'passed',
          source: 'runner',
          code: 'ios_capture_window_waited',
          message: `Waited ${waitMs}ms while recording bounded iOS simulator video evidence.`,
        });
        await finalizeRecording('completed');
      } else if (activeRecording) {
        await finalizeRecording('cancelled');
      } else if (waitMs > 0 && profileSessionStartReady) {
        setCurrentPhase('waiting_for_capture_window', { waitMs });
        await wait(waitMs);
        checks.push({
          name: 'ios_capture_window_waited',
          status: 'passed',
          source: 'runner',
          code: 'ios_capture_window_waited',
          message: `Waited ${waitMs}ms before capturing iOS simulator logs.`,
        });
      } else if (record && !profileSessionStartReady && !metadata.video) {
        metadata.video = {
          capturePath: null,
          skipReason: 'profile_session_start_unready',
          state: 'failed',
        };
        checks.push({
          name: 'ios_video_captured',
          status: 'failed',
          source: 'runner',
          code: 'ios_video_skipped_profile_session_start_unready',
          message: 'Skipped iOS simulator video capture because profile-session start evidence was not ready.',
          metadata: nextActionHint(
            'repair_ios_profile_session_start',
            'Repair profile-session start readiness before requesting bounded iOS simulator video capture.',
          ),
        });
      }

      if (launch && bundleId && !hasInstalledConflictingBundle) {
        setCurrentPhase('capturing_app_lifecycle', { bundleId, logLast });
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
        const appLifecycleInstability = appLifecycleCaptured
          ? classifyIosAppLifecycleInstability(appLifecycleOutput)
          : null;
        raw[appLifecycleRawFileName] = appLifecycleOutput;
        const hostDiagnosticReport = appLifecycleInstability
          ? await inspectHostDiagnosticReport({ bundleId, diagnosticReportsDir })
          : null;
        const appLifecycleCrashed = appLifecycleInstability === 'crash' || Boolean(hostDiagnosticReport?.metadata?.matched);
        const appLifecycleAmbiguousExit = appLifecycleInstability === 'exit' && !hostDiagnosticReport?.metadata?.matched;
        if (hostDiagnosticReport) {
          Object.assign(raw, hostDiagnosticReport.raw);
        }
        checks.push({
          name: 'ios_app_lifecycle_stable',
          status: iosAppLifecycleStatus({
            appLifecycleAmbiguousExit,
            appLifecycleCaptured,
            appLifecycleCrashed,
          }),
          source: 'runner',
          code: iosAppLifecycleCode({
            appLifecycleAmbiguousExit,
            appLifecycleCaptured,
            appLifecycleCrashed,
          }),
          message: iosAppLifecycleMessage({
            appLifecycleAmbiguousExit,
            appLifecycleCaptured,
            appLifecycleCrashed,
            bundleId,
          }),
          ...iosAppLifecycleMetadata({
            appLifecycleAmbiguousExit,
            appLifecycleCaptured,
            appLifecycleCrashed,
            appLifecycleRawFileName,
            hostDiagnosticReport,
          }),
        });
        metadata.appLifecycle = {
          args: appLifecycleLog.args,
          exitCode: appLifecycleLog.exitCode,
          pid: launchedAppPid,
          rawPath: `raw/${appLifecycleRawFileName}`,
          ...(hostDiagnosticReport ? { hostDiagnosticReport: hostDiagnosticReport.metadata } : {}),
        };
        if (appLifecycleInstability) {
          checks.push({
            name: 'ios_host_diagnostic_report_attached',
            status: hostDiagnosticReport?.metadata?.matched ? 'passed' : 'warning',
            source: 'runner',
            code: hostDiagnosticReport?.metadata?.matched
              ? 'ios_host_diagnostic_report_attached'
              : 'ios_host_diagnostic_report_missing',
            message: hostDiagnosticReport?.metadata?.matched
              ? 'Attached the latest matching host DiagnosticReports crash file.'
              : 'Could not find a recent matching host DiagnosticReports crash file.',
            ...(!hostDiagnosticReport?.metadata?.matched
              ? {
                  metadata: nextActionHint(
                    'inspect_host_diagnostic_reports',
                    'Inspect raw/ios-host-diagnostic-report-search.txt and the host DiagnosticReports directory; Simulator may write the crash report after this capture window.',
                  ),
                }
            : {}),
          });
        }

        const appInfoResult = await driver.appInfo(bundleId);
        const appInfoOutput = formatIosSimctlRawOutput(appInfoResult);
        const applicationState = parseIosAppInfoApplicationState(appInfoOutput);
        const appInfoCaptured = appInfoResult.exitCode === 0;
        const targetForeground = appInfoCaptured && isIosAppInfoForegroundState(applicationState);
        raw[appInfoResult.rawFileName] = appInfoOutput;
        checks.push({
          name: 'ios_target_app_foreground',
          status: iosTargetForegroundStatus({
            appInfoCaptured,
            applicationState,
            targetForeground,
          }),
          source: 'runner',
          code: iosTargetForegroundCode({
            appInfoCaptured,
            applicationState,
            targetForeground,
          }),
          message: iosTargetForegroundMessage({
            appInfoCaptured,
            applicationState,
            bundleId,
            targetForeground,
          }),
          ...iosTargetForegroundMetadata({
            appInfoCaptured,
            applicationState,
            bundleId,
            devClientDeepLink: lastOpenedDeepLink(deepLinkResults),
            devClientDeepLinkOpened: hasOpenedIosDevClientDeepLink(deepLinkResults),
            rawFileName: appInfoResult.rawFileName,
            targetForeground,
          }),
        });
        metadata.appInfo = {
          applicationState,
          args: appInfoResult.args,
          exitCode: appInfoResult.exitCode,
          rawPath: `raw/${appInfoResult.rawFileName}`,
        };
      }

      if (activeRecording) await finalizeRecording('completed');

      if (screenshot) {
        setCurrentPhase('capturing_screenshot', { bundleId, device: simulator.udid });
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

      setCurrentPhase('capturing_logs', { logLast });
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
            setCurrentPhase('collecting_profile_storage', {
              runId: profileSessionStorage?.runId ?? null,
              scenario: profileSessionStorage?.scenario ?? null,
            });
            const storedEvents = readProfileStorageJson({
              bundleId,
              dataContainer: dataContainerPath,
              fallback: [],
              key: profileStorageKeys.event,
            });
            const storedEntries = readProfileStorageJson({
              bundleId,
              dataContainer: dataContainerPath,
              fallback: [],
              key: profileStorageKeys.sessionEntries,
            });
            const events = Array.isArray(storedEvents)
              ? storedEvents.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === 'object' && !Array.isArray(event))
              : [];
            const sessionEntries = Array.isArray(storedEntries)
              ? storedEntries.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
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
              sessionEntryCount: sessionEntries.length,
              sessionEntriesRawPath: 'raw/ios-profile-session-entries.json',
            };
            if (profileSessionStorage) {
              const startObservation = observeStoredProfileSessionStart({
                bundleId,
                dataContainer: dataContainerPath,
                profileStorageKeys,
                runId: profileSessionStorage.runId,
              });
              const startObserved = startObservation.observed;
              checks.push({
                name: 'ios_profile_session_start_observed',
                status: startObserved ? 'passed' : 'warning',
                source: 'runner',
                code: startObserved
                  ? 'ios_profile_session_start_observed'
                  : 'ios_profile_session_start_missing',
                message: startObserved
                  ? `Observed same-run iOS profile-session app evidence for ${profileSessionStorage.scenario}/${profileSessionStorage.runId}.`
                  : `No same-run iOS profile-session app evidence was observed for ${profileSessionStorage.scenario}/${profileSessionStorage.runId}.`,
                ...(!startObserved
                  ? {
                      metadata: nextActionHint(
                        'fix_ios_dev_client_bundle_or_command_channel',
                        'Confirm the iOS development client loaded the intended app bundle and that the app can start the scenario command channel before rerunning.',
                      ),
                    }
                  : {}),
              });
              metadata.profileSessionStartObservation = {
                ...startObservation,
                runId: profileSessionStorage.runId,
                scenario: profileSessionStorage.scenario,
              };
            }
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
      setCurrentPhase('finalizing_artifacts', { rawArtifactCount: Object.keys(raw).length });
    } else if (launch || terminateBeforeLaunch || profileSessionStorage || collectProfileStorage || record || deepLinks.length > 0) {
      checks.push({
        name: 'ios_capture_window_started',
        status: 'failed',
        source: 'runner',
        code: 'ios_capture_window_no_simulator',
        message: 'iOS capture window setup was requested, but no booted simulator was selected.',
        metadata: nextActionHint(
          'boot_ios_simulator',
          'Boot an iOS simulator or pass --device with a booted simulator UDID before requesting launch, storage, deep-link, or video capture.',
        ),
      });
    }
  };

  try {
    await runIosSimctlCaptureBodyWithWatchdog({
      body: runCaptureBody,
      watchdog: captureWatchdog,
    });
  } catch (error: unknown) {
    await finalizeRecording('cancelled');
    const timedOut = isIosSimctlCaptureWatchdogError(error);
    const failure = normalizeIosRunnerFailure(error);
    if (timedOut) {
      failure.code = error.code;
      failure.watchdog = error.watchdog;
    }

    let rawFileName = 'ios-simctl-runner-failure.txt';
    let livenessCode = 'ios_simctl_runner_liveness_failure';
    let livenessMessage = 'iOS simctl capture stopped before normal artifact finalization.';
    let nextActionCode = 'inspect_ios_simctl_runner_failure';
    let nextAction = `Inspect raw/${rawFileName} and raw/ios-metadata.json to determine which simctl or runner step stopped before finalization, then rerun with a bounded command timeout if the host command stalled.`;
    if (timedOut) {
      rawFileName = 'ios-simctl-runner-watchdog-timeout.txt';
      livenessCode = 'ios_simctl_runner_liveness_timeout';
      livenessMessage = `iOS simctl capture did not complete before the ${captureWatchdog.timeoutMs}ms watchdog deadline.`;
      nextActionCode = 'inspect_ios_simctl_runner_timeout';
      nextAction = `Inspect raw/${rawFileName}, raw/ios-metadata.json, and currentPhase to identify the command, wait, or profile-session expectation that exceeded the whole-capture watchdog.`;
    }

    raw[rawFileName] = formatIosRunnerFailureRaw(failure);
    metadata.runnerFailure = {
      ...failure,
      currentPhase,
      rawPath: `raw/${rawFileName}`,
      collectedRawArtifacts: Object.keys(raw).map((fileName) => `raw/${fileName}`),
    };
    checks.push({
      name: 'ios_simctl_capture_liveness',
      status: 'failed',
      source: 'runner',
      code: livenessCode,
      message: livenessMessage,
      metadata: {
        ...buildIosSimctlLivenessMetadata({
          currentPhase,
          profileSessionStorage,
          rawPath: `raw/${rawFileName}`,
          watchdog: captureWatchdog,
        }),
        ...nextActionHint(nextActionCode, nextAction),
      },
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
  const profileSessionStartWaitMs = parsePositiveInteger(
    args['profile-session-start-wait-ms'],
    DEFAULT_IOS_PROFILE_SESSION_START_WAIT_MS,
  );
  const profileStorageKeys = resolveProfileStorageKeys({
    ...(typeof args['profile-command-storage-key'] === 'string' ? { command: args['profile-command-storage-key'] } : {}),
    ...(typeof args['profile-event-storage-key'] === 'string' ? { event: args['profile-event-storage-key'] } : {}),
    ...(typeof args['profile-session-storage-key'] === 'string' ? { session: args['profile-session-storage-key'] } : {}),
    ...(typeof args['profile-session-entries-storage-key'] === 'string' ? { sessionEntries: args['profile-session-entries-storage-key'] } : {}),
    ...(typeof args['profile-signal-storage-key'] === 'string' ? { signal: args['profile-signal-storage-key'] } : {}),
  });
  const result = await runIosSimctlCapture({
    ...(typeof args.bundle === 'string' ? { bundleId: args.bundle } : {}),
    commandTimeoutMs: parsePositiveInteger(args['command-timeout-ms'], DEFAULT_IOS_SIMCTL_COMMAND_TIMEOUT_MS),
    collectProfileStorage: profileSessionStorageEnabled ||
      args['collect-profile-storage'] === true ||
      args['collect-profile-storage'] === 'true',
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    ...(typeof args['diagnostic-reports-dir'] === 'string'
      ? { diagnosticReportsDir: args['diagnostic-reports-dir'] }
      : {}),
    launch: args.launch === true || args.launch === 'true',
    ...(typeof args['log-last'] === 'string' ? { logLast: args['log-last'] } : {}),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    profileStorageKeys,
    ...(profileSessionStorageEnabled && typeof args['profile-session-storage'] === 'string'
      ? {
          profileSessionStorage: {
            runId,
            scenario: args['profile-session-storage'],
          },
          profileSessionStartWaitMs,
        }
      : {}),
    record: args.record === true || args.record === 'true' || args.video === true || args.video === 'true',
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
  deriveIosSimctlCaptureWatchdogBudget,
  execFileCommand,
  execFileCommandWithTimeout,
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
