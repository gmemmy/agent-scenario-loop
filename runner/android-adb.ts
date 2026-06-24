#!/usr/bin/env node

const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { isAndroidAdbPressKey } = require('../core/android-adb-press-keys') as typeof import('../core/android-adb-press-keys');
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
  'command-timeout-ms'?: string | boolean;
  launch?: string | boolean;
  'android-dev-client-url'?: string | boolean;
  'android-dev-client-wait-ms'?: string | boolean;
  'android-dev-client-ready-pattern'?: string | boolean;
  'android-dev-client-ready-quiet-ms'?: string | boolean;
  'android-dev-client-ready-timeout-ms'?: string | boolean;
  'android-profile-session-storage'?: string | boolean;
  'android-profile-session-storage-key'?: string | boolean;
  'android-profile-command-storage-key'?: string | boolean;
  'launch-wait-ms'?: string | boolean;
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
  stdoutBuffer?: Uint8Array;
};
type CommandExecutorOptions = {
  encoding?: 'buffer' | 'utf8';
};

type CommandExecutor = (command: string, args: string[], options?: CommandExecutorOptions) => Promise<CommandResult>;
type ExecFileError = Error & {
  code?: number;
  killed?: boolean;
  signal?: string | null;
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
  raw: Record<string, string | Uint8Array>;
  runDir: string;
  verdict: Record<string, unknown>;
};

type AndroidDeepLinkCommand = {
  label?: string;
  readyLogPattern?: string;
  readyLogQuietMs?: number;
  readyLogTimeoutMs?: number;
  url: string;
  waitMs?: number;
};

type AndroidAsyncStorageWrite = {
  clearKeys?: string[];
  key: string;
  label?: string;
  value: string;
  waitMs?: number;
};

type AndroidAdbDriverStep = {
  captureFileName?: string;
  driverAction: 'assertVisible' | 'inspectTree' | 'longPress' | 'pressKey' | 'readLogs' | 'record' | 'screenshot' | 'scroll' | 'swipe' | 'tap';
  durationMs?: number;
  durationSeconds?: number;
  endX?: number;
  endY?: number;
  key?: string;
  lines?: number;
  rawFileName?: string;
  remotePath?: string;
  required?: boolean;
  selector?: import('./android-adb-driver').AndroidSelector;
  stepId?: string;
  startX?: number;
  startY?: number;
  timeoutMs?: number;
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
  captureWatchdogMs?: number;
  clearLogcat?: boolean;
  commandTimeoutMs?: number;
  deepLinks?: AndroidDeepLinkCommand[];
  delay?: (ms: number) => Promise<void>;
  driverSteps?: AndroidAdbDriverStep[];
  executor?: CommandExecutor;
  launch?: boolean;
  launchWaitMs?: number;
  logcatLines?: number;
  outputDir?: string;
  packageName?: string | null;
  reactNativeDebugHost?: string | null;
  runId?: string;
  serial?: string | null;
  startupDeepLinks?: AndroidDeepLinkCommand[];
  storageWrites?: AndroidAsyncStorageWrite[];
  waitMs?: number;
};
type AndroidProfileSessionCompletionExpectation = {
  expectedCommandCount: number;
  runId: string;
  scenario: string;
  source: 'deeplink' | 'storage';
};
type AndroidProfileSessionObservationWait = {
  completed: boolean;
  elapsedMs: number;
  expectedCommandCount: number;
  initialObservation?: {
    completed: boolean;
    milestoneBackedSequences: number[];
    observedTerminalCommands: number;
    rawPath: string;
    started: boolean;
    terminalSequences: number[];
  };
  milestoneBackedSequences: number[];
  observedTerminalCommands: number;
  pollCount: number;
  rawPath: string;
  reconciledFromFinalLog?: boolean;
  reconciledRawPath?: string;
  started: boolean;
  terminalSequences: number[];
};
type NextActionHint = {
  nextAction: string;
  nextActionCode: string;
};
type AndroidPreservedSidecarEvidence = {
  byteCount: number;
  kind: 'logs' | 'profileSessionLog' | 'screenshot';
  path: string;
};

type AndroidStartupReadinessFailure = NextActionHint & {
  evidencePattern?: string;
  failureClass: 'dev_client_reload_limbo' | 'readiness_log_missing';
};

type AndroidAppLifecycleScan = {
  crashed: boolean;
  evidence: string[];
};
type AndroidForegroundScan = {
  captured: boolean;
  foregroundPackage: string | null;
  targetForeground: boolean | null;
};

const ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER = '__ASL_ANDROID_DEVICE_EPOCH_MS__';
const DEFAULT_ADB_COMMAND_TIMEOUT_MS = 30000;
const ANDROID_ADB_CAPTURE_WATCHDOG_FLOOR_MS = 15000;
const ANDROID_ADB_CAPTURE_WATCHDOG_CEILING_MS = 120000;
const ANDROID_ADB_CAPTURE_COMMAND_OVERHEAD_MS = 3000;
const ANDROID_PROFILE_SESSION_EARLY_POLL_MS = 1000;
const ANDROID_ASSERT_VISIBLE_POLL_MS = 500;
const ANDROID_PROFILE_SESSION_TERMINAL_COMMAND_STATUSES = new Set([
  'cancelled',
  'completed',
  'failed',
  'skipped',
  'timeout',
  'timed-out',
]);
const ANDROID_PROFILE_SESSION_LOGCAT_LINES_MIN = 10000;
const ANDROID_ADB_CAPTURE_COMMAND_OVERHEAD_CEILING_MS = 45000;

/**
 * Replaces Android device-clock placeholders in JSON payload strings.
 *
 * @param {string} value
 * @param {number} epochMs
 * @returns {string}
 */
function resolveAndroidDeviceEpochPlaceholders(value: string, epochMs: number): string {
  return value
    .replace(
      new RegExp(`"${ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\+(\\d+)"`, 'gu'),
      (_match: string, offset: string) => String(epochMs + Number(offset)),
    )
    .replace(
      new RegExp(`"${ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'gu'),
      String(epochMs),
    )
    .replaceAll(ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER, String(epochMs));
}

/**
 * Reads one scalar string from a JSON-ish storage payload or log line.
 *
 * Android storage values can contain ASL's unquoted device-clock placeholder,
 * so this intentionally supports both JSON field syntax and flat log syntax.
 *
 * @param {string} text
 * @param {string} field
 * @returns {string | null}
 */
function readProfileSessionScalar(text: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const jsonMatch = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, 'u').exec(text);
  if (jsonMatch?.[1]) {
    return jsonMatch[1];
  }

  const flatMatch = new RegExp(`(?:^|\\s)${escaped}=([^\\s,"}]+)`, 'u').exec(text);
  return flatMatch?.[1] ?? null;
}

/**
 * Reads profile-session command count from one storage value.
 *
 * @param {string} value
 * @returns {number}
 */
function readStoredProfileCommandCount(value: string): number {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => (
      entry && typeof entry === 'object' && typeof entry.command === 'string'
    )).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolves the profile-session run identity and expected command count.
 *
 * @param {{deepLinks: AndroidDeepLinkCommand[], storageWrites: AndroidAsyncStorageWrite[]}} options
 * @returns {AndroidProfileSessionCompletionExpectation | null}
 */
function resolveProfileSessionCompletionExpectation({
  deepLinks,
  storageWrites,
}: {
  deepLinks: AndroidDeepLinkCommand[];
  storageWrites: AndroidAsyncStorageWrite[];
}): AndroidProfileSessionCompletionExpectation | null {
  const sessionWrite = storageWrites.find((write) => (
    readProfileSessionScalar(write.value, 'runId') &&
    readProfileSessionScalar(write.value, 'scenario') &&
    !Array.isArray(safeJsonParse(write.value))
  ));
  const commandWrite = storageWrites.find((write) => readStoredProfileCommandCount(write.value) > 0);
  if (sessionWrite) {
    const runId = readProfileSessionScalar(sessionWrite.value, 'runId');
    const scenario = readProfileSessionScalar(sessionWrite.value, 'scenario');
    if (runId && scenario) {
      return {
        expectedCommandCount: commandWrite ? readStoredProfileCommandCount(commandWrite.value) : 0,
        runId,
        scenario,
        source: 'storage',
      };
    }
  }

  const startLink = deepLinks.find((deepLink) => deepLink.url.includes('/profile-session/start'));
  const commandLinks = deepLinks.filter((deepLink) => deepLink.url.includes('/profile-session/command'));
  if (startLink) {
    try {
      const parsed = new URL(startLink.url);
      const runId = parsed.searchParams.get('runId');
      const scenario = parsed.searchParams.get('scenario');
      if (runId && scenario) {
        return {
          expectedCommandCount: commandLinks.length,
          runId,
          scenario,
          source: 'deeplink',
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Returns a sidecar evidence kind for raw artifacts that are still useful when
 * Android health fails.
 *
 * @param {string} fileName
 * @returns {AndroidPreservedSidecarEvidence['kind'] | null}
 */
function classifyAndroidPreservedRawEvidence(fileName: string): AndroidPreservedSidecarEvidence['kind'] | null {
  if (/^adb-profile-session-early-log-\d+\.txt$/u.test(fileName)) {
    return 'profileSessionLog';
  }

  if (/^adb-screenshot(?:-\d+)?\.png$/u.test(fileName)) {
    return 'screenshot';
  }

  if (/^adb-logcat(?:-\d+)?\.txt$/u.test(fileName) || fileName === 'adb-app-lifecycle-log.txt') {
    return 'logs';
  }

  return null;
}

/**
 * Returns the number of bytes that will be written for one raw artifact.
 *
 * @param {string | Uint8Array} content
 * @returns {number}
 */
function rawEvidenceByteCount(content: string | Uint8Array): number {
  if (content instanceof Uint8Array) {
    return content.byteLength;
  }

  return Buffer.byteLength(content, 'utf8');
}

/**
 * Collects raw sidecar artifacts that agents can still use for diagnosis after
 * health failure.
 *
 * @param {Record<string, string | Uint8Array>} raw
 * @returns {AndroidPreservedSidecarEvidence[]}
 */
function collectAndroidPreservedSidecarEvidence(
  raw: Record<string, string | Uint8Array>,
): AndroidPreservedSidecarEvidence[] {
  const preserved: AndroidPreservedSidecarEvidence[] = [];
  for (const [fileName, content] of Object.entries(raw)) {
    const kind = classifyAndroidPreservedRawEvidence(fileName);
    if (!kind) {
      continue;
    }

    const byteCount = rawEvidenceByteCount(content);
    if (byteCount <= 0) {
      continue;
    }

    preserved.push({
      byteCount,
      kind,
      path: `raw/${fileName}`,
    });
  }

  return preserved;
}

/**
 * Builds the health check that indexes preserved sidecar evidence in failed runs.
 *
 * @param {AndroidPreservedSidecarEvidence[]} entries
 * @returns {Record<string, unknown>}
 */
function buildAndroidPreservedSidecarEvidenceCheck(
  entries: AndroidPreservedSidecarEvidence[],
): Record<string, unknown> {
  const capturedKinds = Array.from(new Set(entries.map((entry) => entry.kind))).join(',');
  const capturedPaths = entries.map((entry) => entry.path).join(',');
  return {
    name: 'partial_sidecar_evidence_preserved',
    status: 'partial',
    source: 'runner',
    code: 'partial_sidecar_evidence_preserved',
    message: 'Android sidecar health failed, but raw sidecar evidence was preserved for diagnosis.',
    metadata: {
      capturedKinds,
      capturedPaths,
      evidenceCount: entries.length,
      ...nextActionHint(
        'use_preserved_sidecar_evidence_for_diagnosis',
        'Use preserved sidecar evidence for owner classification only; rerun before making product or performance claims.',
      ),
    },
  };
}

/**
 * Parses JSON without throwing.
 *
 * @param {string} value
 * @returns {unknown}
 */
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Returns true when one profile-session log line belongs to the expected run.
 *
 * @param {{expectation: AndroidProfileSessionCompletionExpectation, line: string}} options
 * @returns {boolean}
 */
function isExpectedProfileSessionLine({
  expectation,
  line,
}: {
  expectation: AndroidProfileSessionCompletionExpectation;
  line: string;
}): boolean {
  return line.includes('[profile-session]') &&
    readProfileSessionScalar(line, 'runId') === expectation.runId &&
    readProfileSessionScalar(line, 'scenario') === expectation.scenario;
}

/**
 * Returns true when one profile-event log line belongs to the expected run.
 *
 * @param {{expectation: AndroidProfileSessionCompletionExpectation, line: string}} options
 * @returns {boolean}
 */
function isExpectedProfileEventLine({
  expectation,
  line,
}: {
  expectation: AndroidProfileSessionCompletionExpectation;
  line: string;
}): boolean {
  return line.includes('[profile-event]') &&
    readProfileSessionScalar(line, 'runId') === expectation.runId &&
    readProfileSessionScalar(line, 'scenario') === expectation.scenario;
}

/**
 * Checks whether a logcat snapshot proves the profile-session command queue reached terminal status.
 *
 * @param {{expectation: AndroidProfileSessionCompletionExpectation, logText: string}} options
 * @returns {{complete: boolean, milestoneBackedSequences: number[], observedTerminalCommands: number, started: boolean, terminalSequences: number[]}}
 */
function inspectProfileSessionCompletion({
  expectation,
  logText,
}: {
  expectation: AndroidProfileSessionCompletionExpectation;
  logText: string;
}): {
  complete: boolean;
  milestoneBackedSequences: number[];
  observedTerminalCommands: number;
  started: boolean;
  terminalSequences: number[];
} {
  const deliveredMilestoneSequences = new Map<number, string>();
  const milestoneBackedSequences = new Set<number>();
  const terminalSequences = new Set<number>();
  let started = false;

  for (const line of logText.split(/\r?\n/u)) {
    if (isExpectedProfileEventLine({ expectation, line })) {
      const event = readProfileSessionScalar(line, 'event');
      if (typeof event === 'string') {
        for (const [sequence, milestone] of deliveredMilestoneSequences.entries()) {
          if (milestone === event) {
            milestoneBackedSequences.add(sequence);
            terminalSequences.add(sequence);
          }
        }
      }
      continue;
    }

    if (!isExpectedProfileSessionLine({ expectation, line })) {
      continue;
    }
    if (readProfileSessionScalar(line, 'kind') === 'start') {
      started = true;
      continue;
    }
    if (readProfileSessionScalar(line, 'kind') !== 'command') {
      continue;
    }
    const sequence = Number(readProfileSessionScalar(line, 'sequence'));
    const status = readProfileSessionScalar(line, 'status');
    const waitForMilestone = readProfileSessionScalar(line, 'waitForMilestone');
    if (
      Number.isInteger(sequence) &&
      sequence > 0 &&
      sequence <= expectation.expectedCommandCount &&
      typeof status === 'string' &&
      ANDROID_PROFILE_SESSION_TERMINAL_COMMAND_STATUSES.has(status)
    ) {
      terminalSequences.add(sequence);
      continue;
    }

    if (
      Number.isInteger(sequence) &&
      sequence > 0 &&
      sequence <= expectation.expectedCommandCount &&
      status === 'delivered' &&
      typeof waitForMilestone === 'string'
    ) {
      deliveredMilestoneSequences.set(sequence, waitForMilestone);
    }
  }

  return {
    complete: started && terminalSequences.size >= expectation.expectedCommandCount,
    milestoneBackedSequences: Array.from(milestoneBackedSequences).sort((left, right) => left - right),
    observedTerminalCommands: terminalSequences.size,
    started,
    terminalSequences: Array.from(terminalSequences).sort((left, right) => left - right),
  };
}
const ANDROID_READY_LOG_POLL_MS = 1000;

/**
 * Builds public health-check metadata for a profile-session observation wait.
 *
 * @param {{expectation: AndroidProfileSessionCompletionExpectation, inspection: ReturnType<typeof inspectProfileSessionCompletion>, rawPath: string, wait: {completed: boolean, elapsedMs: number, pollCount: number}}} options
 * @returns {AndroidProfileSessionObservationWait}
 */
function buildAndroidProfileSessionObservationWait({
  expectation,
  inspection,
  rawPath,
  wait,
}: {
  expectation: AndroidProfileSessionCompletionExpectation;
  inspection: ReturnType<typeof inspectProfileSessionCompletion>;
  rawPath: string;
  wait: {completed: boolean; elapsedMs: number; pollCount: number};
}): AndroidProfileSessionObservationWait {
  return {
    completed: wait.completed,
    elapsedMs: wait.elapsedMs,
    expectedCommandCount: expectation.expectedCommandCount,
    milestoneBackedSequences: inspection.milestoneBackedSequences,
    observedTerminalCommands: inspection.observedTerminalCommands,
    pollCount: wait.pollCount,
    rawPath,
    started: inspection.started,
    terminalSequences: inspection.terminalSequences,
  };
}

function buildAndroidProfileSessionInitialObservation(
  observation: AndroidProfileSessionObservationWait,
): NonNullable<AndroidProfileSessionObservationWait['initialObservation']> {
  return {
    completed: observation.completed,
    milestoneBackedSequences: observation.milestoneBackedSequences,
    observedTerminalCommands: observation.observedTerminalCommands,
    rawPath: observation.rawPath,
    started: observation.started,
    terminalSequences: observation.terminalSequences,
  };
}

function buildReconciledAndroidProfileSessionObservation({
  finalRawPath,
  inspection,
  observation,
}: {
  finalRawPath: string;
  inspection: ReturnType<typeof inspectProfileSessionCompletion>;
  observation: AndroidProfileSessionObservationWait;
}): AndroidProfileSessionObservationWait {
  return {
    ...observation,
    completed: true,
    initialObservation: buildAndroidProfileSessionInitialObservation(observation),
    milestoneBackedSequences: inspection.milestoneBackedSequences,
    observedTerminalCommands: inspection.observedTerminalCommands,
    reconciledFromFinalLog: true,
    reconciledRawPath: finalRawPath,
    started: inspection.started,
    terminalSequences: inspection.terminalSequences,
  };
}

function buildAndroidProfileSessionReconciliationMetadata(
  observation: AndroidProfileSessionObservationWait,
): Record<string, unknown> {
  if (!observation.reconciledFromFinalLog) {
    return {};
  }

  return {
    initialObservedTerminalCommands: observation.initialObservation?.observedTerminalCommands ?? 0,
    initialRawPath: observation.initialObservation?.rawPath ?? observation.rawPath,
    initialStarted: observation.initialObservation?.started ?? false,
    reconciledFromFinalLog: true,
    reconciledRawPath: observation.reconciledRawPath ?? observation.rawPath,
  };
}

/**
 * Builds the sidecar health check for profile-session start or command completion evidence.
 *
 * @param {{expectation: AndroidProfileSessionCompletionExpectation, observation: AndroidProfileSessionObservationWait, timeoutMs: number}} options
 * @returns {Record<string, unknown>}
 */
function buildAndroidProfileSessionObservationCheck({
  expectation,
  observation,
  timeoutMs,
}: {
  expectation: AndroidProfileSessionCompletionExpectation;
  observation: AndroidProfileSessionObservationWait;
  timeoutMs: number;
}): Record<string, unknown> {
  const isStartOnly = expectation.expectedCommandCount === 0;
  const missingNextActionCode = isStartOnly
    ? 'inspect_android_profile_session_start'
    : 'inspect_android_profile_session_completion';
  const missingNextAction = isStartOnly
    ? `Inspect ${observation.rawPath} and app startup logs to confirm the storage-backed profile-session seed was processed by the app.`
    : `Inspect ${observation.rawPath}, command queue storage, and app truth events to determine why profile-session commands did not reach terminal status.`;
  const missingMetadata = observation.completed
    ? {}
    : nextActionHint(missingNextActionCode, missingNextAction);
  const metadata = {
    elapsedMs: observation.elapsedMs,
    expectedCommandCount: observation.expectedCommandCount,
    milestoneBackedSequences: observation.milestoneBackedSequences.join(','),
    observedTerminalCommands: observation.observedTerminalCommands,
    pollCount: observation.pollCount,
    rawPath: observation.rawPath,
    runId: expectation.runId,
    scenario: expectation.scenario,
    source: expectation.source,
    started: observation.started,
    terminalSequences: observation.terminalSequences.join(','),
    ...buildAndroidProfileSessionReconciliationMetadata(observation),
    ...missingMetadata,
  };

  if (isStartOnly) {
    let code = 'android_profile_session_start_wait_exhausted';
    let message = `Same-run profile-session start was not observed before the ${timeoutMs}ms capture window elapsed.`;
    if (observation.reconciledFromFinalLog) {
      code = 'android_profile_session_start_reconciled_from_final_log';
      message = `The early start wait exhausted, but final logcat evidence in ${observation.reconciledRawPath ?? observation.rawPath} contained the same-run profile-session start.`;
    } else if (observation.completed) {
      code = 'android_profile_session_start_observed';
      message = `Observed same-run profile-session start after ${observation.elapsedMs}ms; proceeding to final logcat capture.`;
    }
    return {
      name: 'android_profile_session_start_wait',
      status: observation.completed ? 'passed' : 'warning',
      source: 'runner',
      code,
      message,
      metadata,
    };
  }

  if (!observation.started) {
    return {
      name: 'android_profile_session_completion_wait',
      status: 'failed',
      source: 'runner',
      code: 'android_profile_session_start_missing',
      message: `No matching app-side profile-session start was observed before the ${timeoutMs}ms capture window elapsed.`,
      metadata: {
        ...metadata,
        ...nextActionHint(
          'inspect_android_profile_session_start',
          `Inspect ${observation.rawPath}, confirm the app consumed the seeded profile-session storage for this run id, and rerun before trusting scenario evidence.`,
        ),
      },
    };
  }

  let code = 'android_profile_session_completion_wait_exhausted';
  let message = `Profile-session command evidence was not terminal before the ${timeoutMs}ms capture window elapsed.`;
  if (observation.reconciledFromFinalLog) {
    code = 'android_profile_session_completion_reconciled_from_final_log';
    message = `The early completion wait exhausted, but final logcat evidence in ${observation.reconciledRawPath ?? observation.rawPath} contained terminal same-run profile-session commands.`;
  } else if (observation.completed) {
    code = 'android_profile_session_completion_observed';
    message = `Observed terminal profile-session command evidence after ${observation.elapsedMs}ms; proceeding to final logcat capture.`;
  }
  return {
    name: 'android_profile_session_completion_wait',
    status: observation.completed ? 'passed' : 'warning',
    source: 'runner',
    code,
    message,
    metadata,
  };
}

function isAndroidProfileSessionObservationWait(value: unknown): value is AndroidProfileSessionObservationWait {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.completed === 'boolean' &&
    typeof candidate.expectedCommandCount === 'number' &&
    typeof candidate.observedTerminalCommands === 'number' &&
    typeof candidate.rawPath === 'string' &&
    typeof candidate.started === 'boolean' &&
    Array.isArray(candidate.milestoneBackedSequences) &&
    Array.isArray(candidate.terminalSequences);
}

function collectAndroidProfileSessionFinalLogCandidates(
  raw: Record<string, string | Uint8Array>,
): Array<{logText: string; rawPath: string}> {
  return Object.entries(raw)
    .filter(([fileName, content]) => (
      classifyAndroidPreservedRawEvidence(fileName) === 'logs' &&
      typeof content === 'string' &&
      content.length > 0
    ))
    .map(([fileName, content]) => ({
      logText: String(content),
      rawPath: `raw/${fileName}`,
    }));
}

function findAndroidProfileSessionObservationCheckIndex({
  checks,
  expectation,
}: {
  checks: Array<Record<string, unknown>>;
  expectation: AndroidProfileSessionCompletionExpectation;
}): number {
  const checkName = expectation.expectedCommandCount === 0
    ? 'android_profile_session_start_wait'
    : 'android_profile_session_completion_wait';
  return checks.findIndex((check) => check.name === checkName);
}

function shouldReconcileAndroidProfileSessionObservation({
  expectation,
  inspection,
}: {
  expectation: AndroidProfileSessionCompletionExpectation;
  inspection: ReturnType<typeof inspectProfileSessionCompletion>;
}): boolean {
  if (expectation.expectedCommandCount === 0) {
    return inspection.started;
  }

  return inspection.complete;
}

function reconcileAndroidProfileSessionObservationFromFinalLogs({
  checks,
  expectation,
  metadata,
  raw,
}: {
  checks: Array<Record<string, unknown>>;
  expectation: AndroidProfileSessionCompletionExpectation | null;
  metadata: Record<string, unknown>;
  raw: Record<string, string | Uint8Array>;
}): void {
  if (!expectation) {
    return;
  }

  const metadataKey = expectation.expectedCommandCount === 0
    ? 'profileSessionStartWait'
    : 'profileSessionCompletionWait';
  const observation = metadata[metadataKey];
  if (!isAndroidProfileSessionObservationWait(observation) || observation.completed) {
    return;
  }

  for (const candidate of collectAndroidProfileSessionFinalLogCandidates(raw)) {
    const inspection = inspectProfileSessionCompletion({
      expectation,
      logText: candidate.logText,
    });
    if (!shouldReconcileAndroidProfileSessionObservation({ expectation, inspection })) {
      continue;
    }

    const reconciledObservation = buildReconciledAndroidProfileSessionObservation({
      finalRawPath: candidate.rawPath,
      inspection,
      observation,
    });
    metadata[metadataKey] = reconciledObservation;
    const checkIndex = findAndroidProfileSessionObservationCheckIndex({ checks, expectation });
    if (checkIndex >= 0) {
      checks[checkIndex] = buildAndroidProfileSessionObservationCheck({
        expectation,
        observation: reconciledObservation,
        timeoutMs: observation.elapsedMs,
      });
    }
    return;
  }
}

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
    'Use --command-timeout-ms <ms> to bound each adb invocation.',
    'Use --capture-logcat [--logcat-lines <count>] to attach a bounded adb logcat snapshot under raw/adb-logcat.txt.',
    'Use --clear-logcat --launch [--launch-wait-ms <ms>] --wait-ms <ms> with --package <name> to capture a bounded app launch window.',
    'Use --react-native-debug-host <host:port> with --package <name> to set the app debug server and adb reverse for React Native dev builds.',
    'Use --android-dev-client-url <url> [--android-dev-client-wait-ms <ms>] [--android-dev-client-ready-pattern <pattern>] to open an Expo dev-client session before scenario deep links.',
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
function execFileCommand(
  command: string,
  args: string[],
  options: CommandExecutorOptions = {},
): Promise<CommandResult> {
  return execFileCommandWithTimeout(command, args, DEFAULT_ADB_COMMAND_TIMEOUT_MS, options);
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

function resolveStdoutBuffer(
  stdout: string | Buffer,
  options: CommandExecutorOptions,
): Pick<CommandResult, 'stdoutBuffer'> {
  if (options.encoding !== 'buffer') {
    return {};
  }

  if (Buffer.isBuffer(stdout)) {
    return {
      stdoutBuffer: stdout,
    };
  }

  return {
    stdoutBuffer: Buffer.from(stdout, 'utf8'),
  };
}

/**
 * Runs a command with a bounded timeout and captures stdout, stderr, and exit code without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<CommandResult>}
 */
function execFileCommandWithTimeout(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_ADB_COMMAND_TIMEOUT_MS,
  options: CommandExecutorOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: options.encoding === 'buffer' ? 'buffer' : 'utf8', timeout: timeoutMs }, (
      error: ExecFileError | null,
      stdout: string | Buffer,
      stderr: string | Buffer,
    ) => {
      const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');
      const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
      const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
      resolve({
        command,
        args,
        exitCode: resolveExecFileExitCode(error),
        stderr: [stderrText, timedOut ? `adb command timed out after ${timeoutMs}ms.` : ''].filter(Boolean).join('\n'),
        stdout: stdoutText,
        ...resolveStdoutBuffer(stdout, options),
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

function buildAndroidAppLifecycleHealthCheck({
  lifecycleLogExitCode,
  lifecycleLogRawFileName,
  lifecyclePackageName,
  pidofAfterCaptureRawPath,
  runningAfterCapture,
  scan,
}: {
  lifecycleLogExitCode: number;
  lifecycleLogRawFileName: string;
  lifecyclePackageName: string;
  pidofAfterCaptureRawPath: string;
  runningAfterCapture: boolean;
  scan: AndroidAppLifecycleScan;
}): Record<string, unknown> {
  const check = {
    name: 'android_app_lifecycle_stable',
    source: 'runner',
  };

  if (!runningAfterCapture) {
    return {
      ...check,
      code: 'android_app_exited_during_capture',
      message: `Package ${lifecyclePackageName} was not running after evidence capture.`,
      metadata: nextActionHint(
        'inspect_android_app_crash',
        `Inspect raw/${lifecycleLogRawFileName} and ${pidofAfterCaptureRawPath}; scenario timing evidence is not trustworthy until the app stays alive.`,
      ),
      status: 'failed',
    };
  }

  if (scan.crashed) {
    return {
      ...check,
      code: 'android_app_crashed_during_capture',
      message: `Package ${lifecyclePackageName} emitted crash evidence during capture.`,
      metadata: nextActionHint(
        'inspect_android_app_crash',
        `Inspect raw/${lifecycleLogRawFileName} and ${pidofAfterCaptureRawPath}; scenario timing evidence is not trustworthy until the app stays alive.`,
      ),
      status: 'failed',
    };
  }

  if (lifecycleLogExitCode === 0) {
    return {
      ...check,
      code: 'android_app_lifecycle_stable',
      message: `Package ${lifecyclePackageName} remained running with no crash evidence in the bounded log window.`,
      status: 'passed',
    };
  }

  return {
    ...check,
    code: 'android_app_lifecycle_log_unavailable',
    message: `Could not read Android lifecycle logs for package ${lifecyclePackageName}.`,
    metadata: nextActionHint(
      'inspect_android_lifecycle_log',
      `Inspect raw/${lifecycleLogRawFileName}; lifecycle log capture failed but the app process was still running.`,
    ),
    status: 'warning',
  };
}

function buildAndroidForegroundHealthCheck({
  foregroundRawPath,
  foregroundScan,
  lifecyclePackageName,
}: {
  foregroundRawPath: string;
  foregroundScan: AndroidForegroundScan;
  lifecyclePackageName: string;
}): Record<string, unknown> {
  const check = {
    name: 'android_target_app_foreground',
    source: 'runner',
  };

  if (foregroundScan.targetForeground === false) {
    return {
      ...check,
      code: 'android_target_app_not_foreground',
      message: `Foreground Android window belongs to ${foregroundScan.foregroundPackage}, not ${lifecyclePackageName}.`,
      metadata: nextActionHint(
        'restore_android_target_foreground',
        `Inspect ${foregroundRawPath}, confirm the selected package and dev-client URL, and rerun when ${lifecyclePackageName} owns the foreground surface.`,
      ),
      status: 'failed',
    };
  }

  if (foregroundScan.targetForeground === true) {
    return {
      ...check,
      code: 'android_target_app_foreground',
      message: `Target package ${lifecyclePackageName} owns the Android foreground window after capture.`,
      metadata: {
        rawPath: foregroundRawPath,
      },
      status: 'passed',
    };
  }

  return {
    ...check,
    code: 'android_target_app_foreground_unverified',
    message: `Could not verify Android foreground ownership for ${lifecyclePackageName}.`,
    metadata: nextActionHint(
      'confirm_android_target_foreground',
      `Inspect ${foregroundRawPath}; if this Android image cannot expose foreground state, use a host runner that can prove target foreground ownership before trusting UI or timing evidence.`,
    ),
    status: 'warning',
  };
}

/**
 * Detects adb daemon/socket failures that are distinct from a genuinely missing device.
 *
 * @param {CommandResult} result
 * @returns {boolean}
 */
function isAdbDaemonUnavailable(result: CommandResult): boolean {
  if (result.exitCode === 0) {
    return false;
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes('cannot connect to daemon') ||
    output.includes('failed to check server version') ||
    output.includes('could not install *smartsocket* listener') ||
    output.includes('adb server didn') ||
    output.includes('adb command timed out')
  );
}

/**
 * Builds the health check details for device selection failures.
 *
 * @param {{devicesOutput: CommandResult, serial?: string | null}} options
 * @returns {{code: string, message: string, metadata: NextActionHint}}
 */
function buildAndroidDeviceFailure({
  devicesOutput,
  serial,
}: {
  devicesOutput: CommandResult;
  serial?: string | null;
}): {code: string; message: string; metadata: NextActionHint} {
  if (isAdbDaemonUnavailable(devicesOutput)) {
    return {
      code: 'adb_daemon_unreachable',
      message: 'adb devices could not reach or start the adb daemon.',
      metadata: nextActionHint(
        'rerun_with_adb_daemon_access',
        'Start the adb daemon from a host shell or rerun the live proof with host adb daemon access, then confirm `adb devices -l` lists the target device as `device`.',
      ),
    };
  }

  return {
    code: 'android_device_missing',
    message: serial
      ? `No online Android device matched serial ${serial}.`
      : 'No online Android device was found.',
    metadata: nextActionHint(
      'select_android_device',
      'Start or unlock an Android emulator/device, confirm it appears as `device` in adb devices -l, or pass --serial for the intended device.',
    ),
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
 * Escapes a string for insertion as a SQLite string literal.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeSqliteString(value: string): string {
  return value.replace(/'/gu, "''");
}

/**
 * Builds SQL that updates React Native AsyncStorage's Android RKStorage table.
 *
 * @param {{clearKeys?: string[], key: string, value: string}} options
 * @returns {string}
 */
function buildAndroidAsyncStorageWriteSql({
  clearKeys = [],
  key,
  value,
}: {
  clearKeys?: string[];
  key: string;
  value: string;
}): string {
  return [
    'PRAGMA busy_timeout=5000;',
    ...clearKeys.map((clearKey) => (
      `DELETE FROM catalystLocalStorage WHERE key='${escapeSqliteString(clearKey)}';`
    )),
    `INSERT OR REPLACE INTO catalystLocalStorage (key,value) VALUES ('${escapeSqliteString(key)}','${escapeSqliteString(value)}');`,
  ].join('\n');
}

/**
 * Builds a package-scoped command for writing one Android AsyncStorage value.
 *
 * @param {{packageName: string, write: AndroidAsyncStorageWrite}} options
 * @returns {string}
 */
function buildAndroidAsyncStorageWriteCommand({
  packageName,
  write,
}: {
  packageName: string;
  write: AndroidAsyncStorageWrite;
}): string {
  const sql = buildAndroidAsyncStorageWriteSql({
    ...(write.clearKeys ? { clearKeys: write.clearKeys } : {}),
    key: write.key,
    value: write.value,
  });
  return [
    'run-as',
    quoteAndroidShellArg(packageName),
    'sqlite3',
    quoteAndroidShellArg('databases/RKStorage'),
    quoteAndroidShellArg(sql),
  ].join(' ');
}

/**
 * Reads the selected device clock as epoch milliseconds for app-side timing.
 *
 * @param {{adbPath: string, deviceSerial: string, executor: CommandExecutor}} options
 * @returns {Promise<CommandResult & {epochMs: number | null}>}
 */
async function readAndroidDeviceEpochMs({
  adbPath,
  deviceSerial,
  executor,
}: {
  adbPath: string;
  deviceSerial: string;
  executor: CommandExecutor;
}): Promise<CommandResult & {epochMs: number | null}> {
  const result = await executor(adbPath, ['-s', deviceSerial, 'shell', 'date', '+%s']);
  const seconds = Number(result.stdout.trim());
  const epochMs = result.exitCode === 0 && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : null;

  return {
    ...result,
    epochMs,
  };
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
 * Parses Android `pidof` output into stable process ids.
 *
 * @param {string} output
 * @returns {string[]}
 */
function parseAndroidPidofOutput(output: string): string[] {
  return String(output)
    .trim()
    .split(/\s+/u)
    .filter((pid) => /^\d+$/u.test(pid));
}

/**
 * Escapes text so it can be embedded in a regular expression.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Finds crash-like Android logcat windows for one app process.
 *
 * Android crash logs often split the signal line from the `Process:` line, so
 * this scans a small neighborhood around each crash marker before deciding it
 * belongs to the launched app.
 *
 * @param {{logText: string, packageName: string, pids?: string[]}} options
 * @returns {AndroidAppLifecycleScan}
 */
function scanAndroidAppLifecycleLog({
  logText,
  packageName,
  pids = [],
}: {
  logText: string;
  packageName: string;
  pids?: string[];
}): AndroidAppLifecycleScan {
  const lines = String(logText).split(/\r?\n/u);
  const packagePattern = new RegExp(escapeRegExp(packageName), 'u');
  const pidPatterns = pids.map((pid) => new RegExp(`\\b${escapeRegExp(pid)}\\b`, 'u'));
  const crashPattern = /\b(FATAL EXCEPTION|Fatal signal|SIGSEGV|SIGABRT|ANR in|Force finishing activity|has died|Process .* died)\b/iu;
  const evidence = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!crashPattern.test(line)) {
      continue;
    }

    const windowStart = Math.max(0, index - 3);
    const windowEnd = Math.min(lines.length, index + 4);
    const windowLines = lines.slice(windowStart, windowEnd);
    const windowText = windowLines.join('\n');
    const belongsToApp = packagePattern.test(windowText)
      || pidPatterns.some((pattern) => pattern.test(windowText));

    if (belongsToApp) {
      for (const evidenceLine of windowLines) {
        if (evidenceLine.trim()) {
          evidence.add(evidenceLine);
        }
      }
    }
  }

  return {
    crashed: evidence.size > 0,
    evidence: Array.from(evidence),
  };
}

/**
 * Reads the package currently owning the Android foreground window from dumpsys output.
 *
 * @param {{output: string, packageName: string}} options
 * @returns {AndroidForegroundScan}
 */
function scanAndroidForegroundWindow({
  output,
  packageName,
}: {
  output: string;
  packageName: string;
}): AndroidForegroundScan {
  const text = String(output);
  const focusMatch = /mCurrentFocus=Window\{[^}]*\s(?<component>[A-Za-z0-9_.]+)\/[^\s}]+/u.exec(text)
    ?? /mFocusedApp=ActivityRecord\{[^}]*\s(?<component>[A-Za-z0-9_.]+)\/[^\s}]+/u.exec(text)
    ?? /topResumedActivity=ActivityRecord\{[^}]*\s(?<component>[A-Za-z0-9_.]+)\/[^\s}]+/u.exec(text);
  const foregroundPackage = focusMatch?.groups?.component ?? null;
  return {
    captured: text.trim().length > 0,
    foregroundPackage,
    targetForeground: foregroundPackage ? foregroundPackage === packageName : null,
  };
}

/**
 * Counts readiness markers in a bounded Android logcat snapshot.
 *
 * @param {{logText: string, pattern: string}} options
 * @returns {number}
 */
function countAndroidReadyLogMatches({
  logText,
  pattern,
}: {
  logText: string;
  pattern: string;
}): number {
  try {
    return Array.from(String(logText).matchAll(new RegExp(pattern, 'gu'))).length;
  } catch {
    return String(logText).split(pattern).length - 1;
  }
}

const ANDROID_DEV_CLIENT_RELOAD_LIMBO_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'expo-loading-bundle', pattern: /\b(Loading|Downloading|Bundling) (JavaScript )?bundle\b/iu },
  { label: 'metro-connectivity', pattern: /\b(Could not connect to development server|Unable to load script)\b/iu },
  { label: 'metro-bundle-error', pattern: /\b(Failed to load bundle|Error loading bundle|Development server returned response error)\b/iu },
  { label: 'missing-bundle-url', pattern: /\bNo bundle URL present\b/iu },
];

/**
 * Classifies an Android startup readiness timeout for agent next-action routing.
 *
 * @param {{logText: string, rawFileName: string}} options
 * @returns {AndroidStartupReadinessFailure}
 */
function classifyAndroidStartupReadinessFailure({
  logText,
  rawFileName,
}: {
  logText: string;
  rawFileName: string;
}): AndroidStartupReadinessFailure {
  const readyLogPath = `raw/${rawFileName}`;
  for (const candidate of ANDROID_DEV_CLIENT_RELOAD_LIMBO_PATTERNS) {
    if (candidate.pattern.test(logText)) {
      return {
        ...nextActionHint(
          'restart_metro_and_reload_dev_client',
          `Inspect ${readyLogPath}, restart Metro from the app worktree, reopen the dev-client URL, wait for the expected bundle readiness marker, then rerun before delivering profile-session control.`,
        ),
        evidencePattern: candidate.label,
        failureClass: 'dev_client_reload_limbo',
      };
    }
  }

  return {
    ...nextActionHint(
      'inspect_android_startup_deep_link_ready_log',
      `Inspect ${readyLogPath}, confirm the dev-client loaded the expected app bundle, and increase the ready timeout only if the app is still making progress.`,
    ),
    failureClass: 'readiness_log_missing',
  };
}

/**
 * Waits until a startup deep link has produced an expected Android log marker.
 *
 * @param {{driver: import('./android-adb-driver').AndroidAdbDriver, logcatLines: number, pattern: string, quietMs: number, rawFileName: string, timeoutMs: number, wait: (ms: number) => Promise<void>}} options
 * @returns {Promise<{ready: boolean, result: import('./android-adb-driver').AndroidAdbCommandResult}>}
 */
async function waitForAndroidReadyLog({
  driver,
  logcatLines,
  pattern,
  quietMs,
  rawFileName,
  timeoutMs,
  wait,
}: {
  driver: import('./android-adb-driver').AndroidAdbDriver;
  logcatLines: number;
  pattern: string;
  quietMs: number;
  rawFileName: string;
  timeoutMs: number;
  wait: (ms: number) => Promise<void>;
}): Promise<{ready: boolean; result: import('./android-adb-driver').AndroidAdbCommandResult}> {
  const deadline = Date.now() + timeoutMs;
  let lastMatchCount = -1;
  let lastChangeAt = Date.now();
  let result = await driver.readLogs({ lines: logcatLines, rawFileName });

  for (;;) {
    const matchCount = countAndroidReadyLogMatches({
      logText: `${result.stdout}\n${result.stderr}`,
      pattern,
    });
    if (matchCount !== lastMatchCount) {
      lastMatchCount = matchCount;
      lastChangeAt = Date.now();
    }

    const ready = matchCount > 0 && Date.now() - lastChangeAt >= quietMs;
    if (ready || Date.now() >= deadline) {
      return { ready, result };
    }

    await wait(ANDROID_READY_LOG_POLL_MS);
    result = await driver.readLogs({ lines: logcatLines, rawFileName });
  }
}

/**
 * Waits until profile-session command evidence is terminal or the capture window expires.
 *
 * This lets storage-backed profile captures finalize as soon as the app has
 * emitted same-run command completion evidence, while preserving the original
 * wait budget when the app is still missing evidence.
 *
 * @param {{driver: import('./android-adb-driver').AndroidAdbDriver, expectation: AndroidProfileSessionCompletionExpectation, logcatLines: number, rawFileName: string, timeoutMs: number, wait: (ms: number) => Promise<void>}} options
 * @returns {Promise<{completed: boolean, elapsedMs: number, inspection: ReturnType<typeof inspectProfileSessionCompletion>, pollCount: number, result: import('./android-adb-driver').AndroidAdbCommandResult}>}
 */
async function waitForAndroidProfileSessionCompletion({
  driver,
  expectation,
  logcatLines,
  rawFileName,
  timeoutMs,
  wait,
}: {
  driver: import('./android-adb-driver').AndroidAdbDriver;
  expectation: AndroidProfileSessionCompletionExpectation;
  logcatLines: number;
  rawFileName: string;
  timeoutMs: number;
  wait: (ms: number) => Promise<void>;
}): Promise<{
  completed: boolean;
  elapsedMs: number;
  inspection: ReturnType<typeof inspectProfileSessionCompletion>;
  pollCount: number;
  result: import('./android-adb-driver').AndroidAdbCommandResult;
}> {
  const startedAt = Date.now();
  let elapsedBudgetMs = 0;
  let pollCount = 0;
  let result = await driver.readLogs({ lines: logcatLines, rawFileName });
  pollCount += 1;
  let inspection = inspectProfileSessionCompletion({
    expectation,
    logText: `${result.stdout}\n${result.stderr}`,
  });

  while (!inspection.complete && elapsedBudgetMs < timeoutMs) {
    const remainingMs = timeoutMs - elapsedBudgetMs;
    const waitMs = Math.min(ANDROID_PROFILE_SESSION_EARLY_POLL_MS, Math.max(0, remainingMs));
    await wait(waitMs);
    elapsedBudgetMs += waitMs;
    result = await driver.readLogs({ lines: logcatLines, rawFileName });
    pollCount += 1;
    inspection = inspectProfileSessionCompletion({
      expectation,
      logText: `${result.stdout}\n${result.stderr}`,
    });
  }

  return {
    completed: inspection.complete,
    elapsedMs: inspection.complete ? Date.now() - startedAt : timeoutMs,
    inspection,
    pollCount,
    result,
  };
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
 * Converts an unexpected runner failure into artifact-safe metadata.
 *
 * @param {unknown} error
 * @returns {Record<string, unknown>}
 */
function normalizeAndroidRunnerFailure(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).filter(([, value]) => (
        value === null ||
        ['boolean', 'number', 'string'].includes(typeof value) ||
        Array.isArray(value)
      )),
    );
  }

  return {
    message: String(error),
  };
}

/**
 * Formats unexpected runner failure metadata as a raw transcript.
 *
 * @param {Record<string, unknown>} failure
 * @returns {string}
 */
function formatAndroidRunnerFailureRaw(failure: Record<string, unknown>): string {
  return Object.entries(failure)
    .map(([key, value]) => {
      const formatted = value && typeof value === 'object' && !Array.isArray(value)
        ? JSON.stringify(value)
        : Array.isArray(value)
          ? value.join(' ')
          : String(value);
      return `${key}: ${formatted}`;
    })
    .join('\n');
}

type AndroidAdbCaptureWatchdogBudget = {
  ceilingMs: number;
  commandBudgetMs: number;
  commandUnits: number;
  declaredWaitMs: number;
  floorMs: number;
  perCommandOverheadMs: number;
  source: 'derived' | 'override';
  timeoutMs: number;
};

type AndroidAdbCaptureWatchdogError = Error & {
  code: 'android_adb_runner_liveness_timeout';
  watchdog: AndroidAdbCaptureWatchdogBudget;
};

/**
 * Sums only positive integer-ish durations.
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
 * Derives a whole-capture adb watchdog from declared runner waits and command bounds.
 *
 * @param {AndroidPreflightOptions & {commandTimeoutMs: number}} options
 * @returns {AndroidAdbCaptureWatchdogBudget}
 */
function deriveAndroidAdbCaptureWatchdogBudget({
  captureLogcat = false,
  captureWatchdogMs,
  clearLogcat = false,
  commandTimeoutMs,
  deepLinks = [],
  driverSteps = [],
  launch = false,
  launchWaitMs = 0,
  packageName = null,
  reactNativeDebugHost = null,
  startupDeepLinks = [],
  storageWrites = [],
  waitMs = 0,
}: AndroidPreflightOptions & { commandTimeoutMs: number }): AndroidAdbCaptureWatchdogBudget {
  if (typeof captureWatchdogMs === 'number' && Number.isFinite(captureWatchdogMs) && captureWatchdogMs > 0) {
    return {
      ceilingMs: ANDROID_ADB_CAPTURE_WATCHDOG_CEILING_MS,
      commandBudgetMs: 0,
      commandUnits: 0,
      declaredWaitMs: captureWatchdogMs,
      floorMs: ANDROID_ADB_CAPTURE_WATCHDOG_FLOOR_MS,
      perCommandOverheadMs: 0,
      source: 'override',
      timeoutMs: Math.ceil(captureWatchdogMs),
    };
  }

  const resolvedDriverSteps = resolveAndroidAdbDriverSteps({
    captureLogcat,
    driverSteps,
    logcatLines: 1,
    waitMs,
  });
  const declaredWaitMs = sumPositiveDurations([
    launchWaitMs,
    ...startupDeepLinks.map((deepLink) => deepLink.waitMs),
    ...startupDeepLinks.map((deepLink) => deepLink.readyLogTimeoutMs),
    ...storageWrites.map((write) => write.waitMs),
    ...deepLinks.map((deepLink) => deepLink.waitMs),
    ...resolvedDriverSteps.map((step) => step.waitMs),
    ...resolvedDriverSteps.map((step) => step.timeoutMs),
    ...resolvedDriverSteps.map((step) => step.durationMs),
    ...resolvedDriverSteps.map((step) => (
      typeof step.durationSeconds === 'number' ? step.durationSeconds * 1000 : undefined
    )),
  ]);
  const startupReadyPolls = startupDeepLinks.filter((deepLink) => deepLink.readyLogPattern).length;
  const storageClockReads = storageWrites.filter((write) => write.value.includes(ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER)).length;
  const selectorInspections = resolvedDriverSteps.filter((step) => needsAndroidSelectorResolution(step)).length;
  const lifecycleChecks = packageName && (launch || deepLinks.length > 0) ? 2 : 0;
  const commandUnits = 6 +
    (packageName ? 1 : 0) +
    (reactNativeDebugHost ? 2 : 0) +
    (clearLogcat ? 1 : 0) +
    (launch ? 2 : 0) +
    startupDeepLinks.length +
    startupReadyPolls +
    storageWrites.length +
    storageClockReads +
    deepLinks.length +
    (packageName ? deepLinks.length : 0) +
    resolvedDriverSteps.length +
    selectorInspections +
    lifecycleChecks;
  const perCommandOverheadMs = Math.min(commandTimeoutMs, ANDROID_ADB_CAPTURE_COMMAND_OVERHEAD_MS);
  const commandBudgetMs = Math.min(
    commandUnits * perCommandOverheadMs,
    ANDROID_ADB_CAPTURE_COMMAND_OVERHEAD_CEILING_MS,
  );
  const bufferedBudgetMs = commandBudgetMs + declaredWaitMs + 5000;
  const ceilingMs = Math.max(ANDROID_ADB_CAPTURE_WATCHDOG_CEILING_MS, bufferedBudgetMs);
  return {
    ceilingMs,
    commandBudgetMs,
    commandUnits,
    declaredWaitMs,
    floorMs: ANDROID_ADB_CAPTURE_WATCHDOG_FLOOR_MS,
    perCommandOverheadMs,
    source: 'derived',
    timeoutMs: Math.min(
      ceilingMs,
      Math.max(ANDROID_ADB_CAPTURE_WATCHDOG_FLOOR_MS, bufferedBudgetMs),
    ),
  };
}

/**
 * Builds the immediate raw checkpoint written before the first adb call.
 *
 * @param {{adbPath: string, captureWatchdog: AndroidAdbCaptureWatchdogBudget, commandTimeoutMs: number, deadlineEpochMs: number, metadata: Record<string, unknown>, runId: string, startedAt: string}} options
 * @returns {Record<string, unknown>}
 */
function buildAndroidAdbCaptureStartedCheckpoint({
  adbPath,
  captureWatchdog,
  commandTimeoutMs,
  deadlineEpochMs,
  metadata,
  runId,
  startedAt,
}: {
  adbPath: string;
  captureWatchdog: AndroidAdbCaptureWatchdogBudget;
  commandTimeoutMs: number;
  deadlineEpochMs: number;
  metadata: Record<string, unknown>;
  runId: string;
  startedAt: string;
}): Record<string, unknown> {
  return {
    status: 'started',
    message: 'Android adb capture started and the whole-capture watchdog deadline was derived.',
    runId,
    adbPath,
    commandTimeoutMs,
    startedAt,
    watchdog: {
      ...captureWatchdog,
      armed: true,
      deadlineEpochMs,
      deadlineIso: new Date(deadlineEpochMs).toISOString(),
    },
    selectedInputs: {
      captureLogcat: metadata.captureLogcat,
      clearLogcat: metadata.clearLogcat,
      deepLinks: metadata.deepLinks,
      driverSteps: metadata.driverSteps,
      launch: metadata.launch,
      logcatLines: metadata.logcatLines,
      packageName: metadata.packageName,
      reactNativeDebugHost: metadata.reactNativeDebugHost,
      startupDeepLinks: metadata.startupDeepLinks,
      storageWrites: metadata.storageWrites,
      waitMs: metadata.waitMs,
    },
  };
}

/**
 * Creates the classified whole-capture watchdog error.
 *
 * @param {AndroidAdbCaptureWatchdogBudget} watchdog
 * @returns {AndroidAdbCaptureWatchdogError}
 */
function createAndroidAdbCaptureWatchdogError(
  watchdog: AndroidAdbCaptureWatchdogBudget,
): AndroidAdbCaptureWatchdogError {
  const error = new Error(`Android adb capture did not complete within ${watchdog.timeoutMs}ms.`);
  return Object.assign(error, {
    code: 'android_adb_runner_liveness_timeout' as const,
    watchdog,
  });
}

/**
 * Checks whether an error came from the capture watchdog.
 *
 * @param {unknown} error
 * @returns {error is AndroidAdbCaptureWatchdogError}
 */
function isAndroidAdbCaptureWatchdogError(error: unknown): error is AndroidAdbCaptureWatchdogError {
  return error instanceof Error &&
    (error as Partial<AndroidAdbCaptureWatchdogError>).code === 'android_adb_runner_liveness_timeout';
}

/**
 * Runs the mutable capture body with a single whole-capture timeout.
 *
 * @param {{body: () => Promise<void>, watchdog: AndroidAdbCaptureWatchdogBudget}} options
 * @returns {Promise<void>}
 */
async function runAndroidAdbCaptureBodyWithWatchdog({
  body,
  watchdog,
}: {
  body: () => Promise<void>;
  watchdog: AndroidAdbCaptureWatchdogBudget;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      body(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createAndroidAdbCaptureWatchdogError(watchdog)), watchdog.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Writes the Android adb artifact set.
 *
 * @param {{agentSummary: string, health: Record<string, unknown>, layout: ReturnType<typeof createArtifactLayout>, metadata: Record<string, unknown>, raw: Record<string, string | Uint8Array>, rawDir: string, verdict: Record<string, unknown>}} options
 * @returns {Promise<void>}
 */
async function writeAndroidAdbArtifacts({
  agentSummary,
  health,
  layout,
  metadata,
  raw,
  rawDir,
  verdict,
}: {
  agentSummary: string;
  health: Record<string, unknown>;
  layout: ReturnType<typeof createArtifactLayout>;
  metadata: Record<string, unknown>;
  raw: Record<string, string | Uint8Array>;
  rawDir: string;
  verdict: Record<string, unknown>;
}): Promise<void> {
  await Promise.all(
    Object.entries(raw).map(([fileName, content]) => (
      content instanceof Uint8Array
        ? fsp.writeFile(path.join(rawDir, fileName), content)
        : fsp.writeFile(path.join(rawDir, fileName), `${content.trimEnd()}\n`, 'utf8')
    )),
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
    const resolved = driverSteps.map((step, index) => {
      const actionIndex = index + 1;
      if (step.driverAction === 'readLogs') {
        readLogsIndex += 1;
      }

      return {
        ...step,
        ...resolveReadLogsDriverStepDefaults(step, logcatLines),
        rawFileName: step.rawFileName ?? defaultAndroidAdbRawFileName({
          driverAction: step.driverAction,
          index: actionIndex,
          readLogsIndex,
        }),
        ...resolveRecordDriverStepDefaults(step, actionIndex),
        required: step.required !== false,
      };
    });
    if (captureLogcat && readLogsIndex === 0) {
      resolved.push({
        driverAction: 'readLogs',
        lines: logcatLines,
        rawFileName: 'adb-logcat.txt',
        required: true,
        ...(waitMs > 0 ? { waitMs } : {}),
      });
    }
    return resolved;
  }

  if (!captureLogcat) {
    return [];
  }

  return [{
    driverAction: 'readLogs',
    lines: logcatLines,
    rawFileName: 'adb-logcat.txt',
    required: true,
    ...(waitMs > 0 ? { waitMs } : {}),
  }];
}

function resolveReadLogsDriverStepDefaults(
  step: AndroidAdbDriverStep,
  logcatLines: number,
): Partial<AndroidAdbDriverStep> {
  if (step.driverAction !== 'readLogs') {
    return {};
  }

  return {
    lines: step.lines ?? logcatLines,
  };
}

function resolveRecordDriverStepDefaults(
  step: AndroidAdbDriverStep,
  actionIndex: number,
): Partial<AndroidAdbDriverStep> {
  if (step.driverAction !== 'record') {
    return {};
  }

  return {
    captureFileName: step.captureFileName ?? defaultAndroidAdbCaptureFileName({
      driverAction: step.driverAction,
      index: actionIndex,
    }),
  };
}

function buildAndroidDeviceConnectedCheck({
  device,
  deviceFailure,
  deviceOnline,
}: {
  device: AndroidDevice | null;
  deviceFailure: ReturnType<typeof buildAndroidDeviceFailure> | null;
  deviceOnline: boolean;
}): Record<string, unknown> {
  if (deviceOnline && device) {
    return {
      name: 'android_device_connected',
      status: 'passed',
      source: 'runner',
      code: 'android_device_connected',
      message: `Selected Android device ${device.serial}.`,
    };
  }

  return {
    name: 'android_device_connected',
    status: 'failed',
    source: 'runner',
    code: deviceFailure?.code,
    message: deviceFailure?.message,
    metadata: deviceFailure?.metadata,
  };
}

function resolveAndroidSelectorResolutionStatus({
  required,
  resolved,
}: {
  required: boolean;
  resolved: boolean;
}): 'failed' | 'passed' | 'warning' {
  if (resolved) {
    return 'passed';
  }

  if (!required) {
    return 'warning';
  }

  return 'failed';
}

function buildAndroidSelectorResolutionCheck({
  driverStep,
  rawFileName,
  resolved,
}: {
  driverStep: AndroidAdbDriverStep;
  rawFileName: string;
  resolved: boolean;
}): Record<string, unknown> {
  const required = driverStep.required !== false;

  return {
    name: 'android_selector_resolved',
    status: resolveAndroidSelectorResolutionStatus({ required, resolved }),
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
            `Inspect raw/${rawFileName}, update the scenario selector, or provide explicit adb coordinates for this driver action.`,
          )
        : {}),
      ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
    },
  };
}

function resolveAndroidDriverActionStatus({
  failed,
  required,
}: {
  failed: boolean;
  required: boolean;
}): 'failed' | 'passed' | 'warning' {
  if (!failed) {
    return 'passed';
  }

  if (!required) {
    return 'warning';
  }

  return 'failed';
}

function resolveAndroidDriverActionCode({
  codeSuffix,
  isReadLogs,
  succeeded,
}: {
  codeSuffix: string;
  isReadLogs: boolean;
  succeeded: boolean;
}): string {
  if (isReadLogs && succeeded) {
    return 'android_logcat_captured';
  }

  if (isReadLogs) {
    return 'android_logcat_failed';
  }

  if (succeeded) {
    return `android_${codeSuffix}_completed`;
  }

  return `android_${codeSuffix}_failed`;
}

function resolveAndroidDriverActionMessage({
  driverAction,
  isReadLogs,
  lines,
  succeeded,
}: {
  driverAction: AndroidAdbDriverStep['driverAction'];
  isReadLogs: boolean;
  lines: number;
  succeeded: boolean;
}): string {
  if (isReadLogs && succeeded) {
    return `Captured the last ${lines} adb logcat lines.`;
  }

  if (isReadLogs) {
    return 'adb logcat capture failed.';
  }

  if (succeeded) {
    return `Completed adb driver action ${driverAction}.`;
  }

  return `adb driver action ${driverAction} failed.`;
}

function buildAndroidDriverActionCheck({
  codeSuffix,
  driverResult,
  driverStep,
  isReadLogs,
  logcatLines,
}: {
  codeSuffix: string;
  driverResult: import('./android-adb-driver').AndroidAdbCommandResult;
  driverStep: AndroidAdbDriverStep;
  isReadLogs: boolean;
  logcatLines: number;
}): Record<string, unknown> {
  const failed = driverResult.exitCode !== 0;
  const succeeded = !failed;
  const required = driverStep.required !== false;
  const lines = driverStep.lines ?? logcatLines;

  return {
    name: isReadLogs ? 'android_logcat_captured' : `android_${codeSuffix}`,
    status: resolveAndroidDriverActionStatus({ failed, required }),
    source: 'runner',
    code: resolveAndroidDriverActionCode({ codeSuffix, isReadLogs, succeeded }),
    message: resolveAndroidDriverActionMessage({
      driverAction: driverStep.driverAction,
      isReadLogs,
      lines,
      succeeded,
    }),
    metadata: {
      driverAction: driverStep.driverAction,
      ...buildAndroidSelectorHealthMetadata(driverStep.selector),
      ...(failed ? buildAndroidDriverFailureMetadata({ driverResult, isReadLogs }) : {}),
      ...(typeof driverResult.elapsedMs === 'number' ? { elapsedMs: driverResult.elapsedMs } : {}),
      ...(typeof driverResult.pollCount === 'number' ? { pollCount: driverResult.pollCount } : {}),
      ...(driverResult.timedOut ? { timedOut: true } : {}),
      ...(typeof driverResult.timeoutMs === 'number' ? { timeoutMs: driverResult.timeoutMs } : {}),
      ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
    },
  };
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

  if (driverStep.driverAction === 'tap' || driverStep.driverAction === 'longPress') {
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
 * Applies a resolved selector to one coordinate-backed driver step.
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
  if (driverStep.driverAction === 'tap' || driverStep.driverAction === 'longPress') {
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
 * Returns a compact single-line adb driver failure preview.
 *
 * @param {import('./android-adb-driver').AndroidAdbCommandResult} driverResult
 * @returns {string | null}
 */
function previewAndroidDriverFailure(
  driverResult: import('./android-adb-driver').AndroidAdbCommandResult,
): string | null {
  const preview = [driverResult.stderr, driverResult.stdout]
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/gu, ' ')
    .trim();
  return preview ? preview.slice(0, 500) : null;
}

/**
 * Builds next-action metadata for failed adb driver steps.
 *
 * @param {{driverResult: import('./android-adb-driver').AndroidAdbCommandResult, isReadLogs: boolean}} options
 * @returns {Record<string, string>}
 */
function buildAndroidDriverFailureMetadata({
  driverResult,
  isReadLogs,
}: {
  driverResult: import('./android-adb-driver').AndroidAdbCommandResult;
  isReadLogs: boolean;
}): Record<string, string> {
  const failurePreview = previewAndroidDriverFailure(driverResult);
  const diagnostic = `${driverResult.stderr}\n${driverResult.stdout}`;
  const uiAutomationBusy = /uiautomationservice|uiautomator|already registered|\/sdcard\/agent-scenario-loop-ui\.xml|killed/iu
    .test(diagnostic);
  const metadata = uiAutomationBusy
    ? nextActionHint(
      'reset_android_uiautomator',
      'Android UIAutomator could not provide a UI tree, likely because another automation session owns the service. Close or reset competing UI automation sessions, then rerun the capture before treating this as an app or selector failure.',
    )
    : nextActionHint(
      isReadLogs ? 'inspect_android_logcat_capture' : 'inspect_android_driver_action',
      isReadLogs
        ? `Inspect raw/${driverResult.rawFileName}, confirm adb logcat access for the selected device, and rerun the capture.`
        : `Inspect raw/${driverResult.rawFileName}, confirm the device is interactive and the action metadata is valid, then rerun the capture.`,
    );
  return {
    ...metadata,
    ...(failurePreview ? { failurePreview } : {}),
  };
}

/**
 * Polls Android UIAutomator until a selector becomes visible or the declared
 * assertion timeout expires.
 *
 * @param {{driver: import('./android-adb-driver').AndroidAdbDriver, driverStep: AndroidAdbDriverStep, wait: (ms: number) => Promise<void>}} options
 * @returns {Promise<import('./android-adb-driver').AndroidAdbCommandResult>}
 */
async function pollAndroidAssertVisible({
  driver,
  driverStep,
  wait,
}: {
  driver: import('./android-adb-driver').AndroidAdbDriver;
  driverStep: AndroidAdbDriverStep;
  wait: (ms: number) => Promise<void>;
}): Promise<import('./android-adb-driver').AndroidAdbCommandResult> {
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

  const rawFileName = driverStep.rawFileName ?? 'adb-assert-visible.xml';
  let timeoutMs = 0;
  if (typeof driverStep.timeoutMs === 'number' && driverStep.timeoutMs > 0) {
    timeoutMs = driverStep.timeoutMs;
  }
  let elapsedMs = 0;
  let pollCount = 1;
  let result = await driver.assertVisible({
    rawFileName,
    selector: driverStep.selector,
  });

  while (result.exitCode !== 0 && elapsedMs < timeoutMs) {
    const waitMs = Math.min(ANDROID_ASSERT_VISIBLE_POLL_MS, timeoutMs - elapsedMs);
    await wait(waitMs);
    elapsedMs += waitMs;
    pollCount += 1;
    result = await driver.assertVisible({
      rawFileName,
      selector: driverStep.selector,
    });
  }

  const timedOut = result.exitCode !== 0 && timeoutMs > 0 && elapsedMs >= timeoutMs;
  const pollResult = {
    ...result,
    elapsedMs,
    pollCount,
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
  };

  if (!timedOut) {
    return pollResult;
  }

  return {
    ...pollResult,
    stderr: [
      result.stderr,
      `assertVisible did not pass before the ${timeoutMs}ms timeout after ${pollCount} UIAutomator attempts.`,
    ].filter(Boolean).join('\n'),
    timedOut: true,
  };
}

/**
 * Runs one normalized adb driver step through the Android driver adapter.
 *
 * @param {{driver: import('./android-adb-driver').AndroidAdbDriver, driverStep: AndroidAdbDriverStep, logcatLines: number, wait?: (ms: number) => Promise<void>}} options
 * @returns {Promise<import('./android-adb-driver').AndroidAdbCommandResult>}
 */
async function runAndroidAdbDriverStep({
  capturesDir,
  driver,
  driverStep,
  logcatLines,
  wait = delay,
}: {
  capturesDir: string;
  driver: import('./android-adb-driver').AndroidAdbDriver;
  driverStep: AndroidAdbDriverStep;
  logcatLines: number;
  wait?: (ms: number) => Promise<void>;
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
    return pollAndroidAssertVisible({ driver, driverStep, wait });
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

  if (driverStep.driverAction === 'swipe') {
    if (
      typeof driverStep.startX !== 'number' ||
      typeof driverStep.startY !== 'number' ||
      typeof driverStep.endX !== 'number' ||
      typeof driverStep.endY !== 'number'
    ) {
      return {
        action: 'swipe',
        args: [],
        command: 'adb',
        exitCode: 1,
        rawFileName: driverStep.rawFileName ?? 'adb-swipe.txt',
        stderr: 'swipe driver action requires startX, startY, endX, and endY.',
        stdout: '',
      };
    }

    return driver.swipe({
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      endX: driverStep.endX,
      endY: driverStep.endY,
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
      startX: driverStep.startX,
      startY: driverStep.startY,
    });
  }

  if (driverStep.driverAction === 'longPress') {
    if (typeof driverStep.x !== 'number' || typeof driverStep.y !== 'number') {
      return {
        action: 'longPress',
        args: [],
        command: 'adb',
        exitCode: 1,
        rawFileName: driverStep.rawFileName ?? 'adb-longPress.txt',
        stderr: 'longPress driver action requires x and y.',
        stdout: '',
      };
    }

    return driver.longPress({
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
      x: driverStep.x,
      y: driverStep.y,
    });
  }

  if (driverStep.driverAction === 'pressKey') {
    if (!isAndroidAdbPressKey(driverStep.key)) {
      return {
        action: 'pressKey',
        args: [],
        command: 'adb',
        exitCode: 1,
        rawFileName: driverStep.rawFileName ?? 'adb-pressKey.txt',
        stderr: 'pressKey driver action requires a supported key.',
        stdout: '',
      };
    }

    return driver.pressKey({
      key: driverStep.key,
      ...(typeof driverStep.rawFileName === 'string' ? { rawFileName: driverStep.rawFileName } : {}),
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
  captureWatchdogMs: captureWatchdogMsOverride,
  clearLogcat = false,
  commandTimeoutMs = DEFAULT_ADB_COMMAND_TIMEOUT_MS,
  deepLinks = [],
  delay: wait = delay,
  driverSteps = [],
  executor = (command, args, options) => execFileCommandWithTimeout(command, args, commandTimeoutMs, options),
  launch = false,
  launchWaitMs = 0,
  logcatLines = 1000,
  outputDir = path.resolve('artifacts/android-adb-preflight'),
  packageName = null,
  reactNativeDebugHost = null,
  runId = createRunId(),
  serial = null,
  startupDeepLinks = [],
  storageWrites = [],
  waitMs = 0,
}: AndroidPreflightOptions = {}): Promise<AndroidPreflightResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  await fsp.mkdir(rawDir, { recursive: true });

  const raw: Record<string, string | Uint8Array> = {};
  const checks: Record<string, unknown>[] = [];
  let device: AndroidDevice | null = null;
  const captureWatchdog = deriveAndroidAdbCaptureWatchdogBudget({
    captureLogcat,
    ...(typeof captureWatchdogMsOverride === 'number' ? { captureWatchdogMs: captureWatchdogMsOverride } : {}),
    clearLogcat,
    commandTimeoutMs,
    deepLinks,
    driverSteps,
    launch,
    launchWaitMs,
    packageName,
    reactNativeDebugHost,
    startupDeepLinks,
    storageWrites,
    waitMs,
  });
  const metadata: Record<string, unknown> = {
    adbPath,
    captureLogcat,
    captureWatchdog,
    clearLogcat,
    commandTimeoutMs,
    deepLinks,
    driverSteps,
    launch,
    logcatLines,
    packageName,
    reactNativeDebugHost,
    startupDeepLinks,
    storageWrites: storageWrites.map((write) => ({
      clearKeys: write.clearKeys,
      key: write.key,
      label: write.label,
      waitMs: write.waitMs,
    })),
    waitMs,
  };
  const captureStartedAt = new Date();
  const captureDeadlineEpochMs = captureStartedAt.getTime() + captureWatchdog.timeoutMs;
  const captureStartedCheckpoint = buildAndroidAdbCaptureStartedCheckpoint({
    adbPath,
    captureWatchdog,
    commandTimeoutMs,
    deadlineEpochMs: captureDeadlineEpochMs,
    metadata,
    runId,
    startedAt: captureStartedAt.toISOString(),
  });
  const captureStartedRawFileName = 'adb-capture-started.json';
  raw[captureStartedRawFileName] = JSON.stringify(captureStartedCheckpoint, null, 2);
  metadata.captureStarted = {
    rawPath: `raw/${captureStartedRawFileName}`,
    startedAt: captureStartedCheckpoint.startedAt,
    watchdog: captureStartedCheckpoint.watchdog,
  };
  await fsp.writeFile(
    path.join(rawDir, captureStartedRawFileName),
    `${JSON.stringify(captureStartedCheckpoint, null, 2)}\n`,
    'utf8',
  );
  const profileSessionCompletionExpectation = resolveProfileSessionCompletionExpectation({
    deepLinks,
    storageWrites,
  });
  if (profileSessionCompletionExpectation) {
    metadata.profileSessionCompletionExpectation = profileSessionCompletionExpectation;
  }

  const runCaptureBody = async (): Promise<void> => {
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
    metadata.devices = devices;
    device = selectDevice(devices, serial);
    metadata.selectedDevice = device;
    const deviceOnline = Boolean(device && device.state === 'device');
    const deviceFailure = !deviceOnline
      ? buildAndroidDeviceFailure({ devicesOutput, serial })
      : null;
    checks.push(buildAndroidDeviceConnectedCheck({ device, deviceFailure, deviceOnline }));

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

      const appLifecycleMetadata: Record<string, unknown> = {};
      let lifecyclePackageName: string | null = null;
      let knownLifecyclePids: string[] = [];

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
          if (launchPassed && launchWaitMs > 0) {
            await wait(launchWaitMs);
            checks.push({
              name: 'android_launch_waited',
              status: 'passed',
              source: 'runner',
              code: 'android_launch_waited',
              message: `Waited ${launchWaitMs}ms after Android package launch.`,
            });
            metadata.launchWaitMs = launchWaitMs;
          }
          if (launchPassed) {
            lifecyclePackageName = packageName;
            const pidofAfterLaunch = await executor(adbPath, [
              '-s',
              device.serial,
              'shell',
              'pidof',
              packageName,
            ]);
            const rawPath = 'raw/adb-app-pidof-after-launch.txt';
            raw['adb-app-pidof-after-launch.txt'] = formatAndroidCommandRawOutput(pidofAfterLaunch);
            const afterLaunchPids = parseAndroidPidofOutput(pidofAfterLaunch.stdout);
            knownLifecyclePids = afterLaunchPids;
            const runningAfterLaunch = pidofAfterLaunch.exitCode === 0 && afterLaunchPids.length > 0;
            checks.push({
              name: 'android_app_process_running_after_launch',
              status: runningAfterLaunch ? 'passed' : 'failed',
              source: 'runner',
              code: runningAfterLaunch
                ? 'android_app_process_running_after_launch'
                : 'android_app_not_running_after_launch',
              message: runningAfterLaunch
                ? `Package ${packageName} is running after launch with PID ${afterLaunchPids.join(', ')}.`
                : `Package ${packageName} is not running after launch.`,
              ...(!runningAfterLaunch
                ? {
                    metadata: nextActionHint(
                      'inspect_android_app_launch',
                      `Inspect ${rawPath} and the app's device logs to find why the launched process exited before evidence capture.`,
                    ),
                  }
                : {}),
            });
            Object.assign(appLifecycleMetadata, {
              afterLaunchPids,
              afterLaunchRawPath: rawPath,
            });
          }
        }
      }

      let startupReady = true;

      for (const [index, deepLink] of startupDeepLinks.entries()) {
        const rawFileName = `adb-startup-deep-link-${index + 1}.txt`;
        const deepLinkResult = await driver.openDeepLink({
          packageName,
          rawFileName,
          url: deepLink.url,
        });
        const deepLinkOpened = deepLinkResult.exitCode === 0;
        if (!deepLinkOpened) {
          startupReady = false;
        }
        raw[deepLinkResult.rawFileName] = formatAndroidAdbRawOutput(deepLinkResult);
        checks.push({
          name: 'android_startup_deep_link_opened',
          status: deepLinkOpened ? 'passed' : 'failed',
          source: 'runner',
          code: deepLinkOpened ? 'android_startup_deep_link_opened' : 'android_startup_deep_link_failed',
          message: deepLinkOpened
            ? `Opened Android startup deep link ${deepLink.label ?? index + 1}.`
            : `Failed to open Android startup deep link ${deepLink.label ?? index + 1}.`,
          ...(!deepLinkOpened
            ? {
                metadata: nextActionHint(
                  'inspect_android_startup_deep_link',
                  `Inspect raw/${deepLinkResult.rawFileName}, verify the dev-client URL and package intent filter, then rerun the capture.`,
                ),
              }
            : {}),
        });

        if (deepLink.waitMs && deepLink.waitMs > 0) {
          await wait(deepLink.waitMs);
          checks.push({
            name: 'android_startup_deep_link_waited',
            status: 'passed',
            source: 'runner',
            code: 'android_startup_deep_link_waited',
            message: `Waited ${deepLink.waitMs}ms after Android startup deep link ${deepLink.label ?? index + 1}.`,
          });
        }

        if (deepLink.readyLogPattern) {
          const rawFileName = `adb-startup-deep-link-${index + 1}-ready-log.txt`;
          const readyLog = await waitForAndroidReadyLog({
            driver,
            logcatLines,
            pattern: deepLink.readyLogPattern,
            quietMs: deepLink.readyLogQuietMs ?? 0,
            rawFileName,
            timeoutMs: deepLink.readyLogTimeoutMs ?? 60000,
            wait,
          });
          if (!readyLog.ready) {
            startupReady = false;
          }
          raw[rawFileName] = formatAndroidAdbRawOutput(readyLog.result);
          const readinessFailure = classifyAndroidStartupReadinessFailure({
            logText: `${readyLog.result.stdout}\n${readyLog.result.stderr}`,
            rawFileName,
          });
          checks.push({
            name: 'android_startup_deep_link_ready',
            status: readyLog.ready ? 'passed' : 'failed',
            source: 'runner',
            code: readyLog.ready
              ? 'android_startup_deep_link_ready'
              : 'android_startup_deep_link_not_ready',
            message: readyLog.ready
              ? `Android startup deep link ${deepLink.label ?? index + 1} emitted readiness log evidence.`
              : `Android startup deep link ${deepLink.label ?? index + 1} did not emit readiness log evidence before timeout.`,
            ...(!readyLog.ready
              ? {
                  metadata: readinessFailure,
                }
              : {}),
          });
        }
      }

      if (!startupReady && (storageWrites.length > 0 || deepLinks.length > 0)) {
        checks.push({
          name: 'android_startup_ready_for_control',
          status: 'failed',
          source: 'runner',
          code: 'android_startup_not_ready_for_control',
          message: 'Android startup readiness failed before profile-session control was delivered.',
          metadata: nextActionHint(
            'verify_android_startup_readiness',
            'Inspect startup deep-link and ready-log artifacts, confirm the app loaded the expected bundle, then rerun before delivering profile-session storage or command deep links.',
          ),
        });
      }

      for (const [index, write] of storageWrites.entries()) {
        const rawFileName = `adb-async-storage-write-${index + 1}.txt`;
        if (!startupReady) {
          checks.push({
            name: 'android_async_storage_written',
            status: 'failed',
            source: 'runner',
            code: 'android_async_storage_skipped_startup_not_ready',
            message: `Skipped Android AsyncStorage value ${write.label ?? index + 1} because startup readiness failed.`,
            metadata: nextActionHint(
              'verify_android_startup_readiness',
              'Rerun after Android startup readiness passes; ASL will not write profile-session storage into an app that has not proven bundle readiness.',
            ),
          });
          continue;
        }

        if (!packageName) {
          checks.push({
            name: 'android_async_storage_written',
            status: 'failed',
            source: 'runner',
            code: 'android_async_storage_missing_package',
            message: 'Android AsyncStorage write was requested, but --package was not provided.',
            metadata: nextActionHint(
              'provide_android_package',
              'Rerun with --package set to the installed Android application id when Android AsyncStorage profile-session storage is enabled.',
            ),
          });
          continue;
        }

        let resolvedWrite = write;
        if (write.value.includes(ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER)) {
          const deviceEpoch = await readAndroidDeviceEpochMs({
            adbPath,
            deviceSerial: device.serial,
            executor,
          });
          raw['adb-device-epoch-ms.txt'] = formatAndroidCommandRawOutput(deviceEpoch);
          const deviceClockRead = typeof deviceEpoch.epochMs === 'number';
          checks.push({
            name: 'android_device_clock_read',
            status: deviceClockRead ? 'passed' : 'failed',
            source: 'runner',
            code: deviceClockRead ? 'android_device_clock_read' : 'android_device_clock_unavailable',
            message: deviceClockRead
              ? `Read Android device clock as ${deviceEpoch.epochMs}ms since epoch.`
              : 'Failed to read Android device clock for AsyncStorage timing evidence.',
            ...(!deviceClockRead
              ? {
                  metadata: nextActionHint(
                    'inspect_android_device_clock',
                    'Inspect raw/adb-device-epoch-ms.txt and confirm the selected Android device supports `adb shell date +%s` before using storage-backed timing evidence.',
                  ),
                }
              : {}),
          });
          if (!deviceClockRead || deviceEpoch.epochMs === null) {
            continue;
          }

          resolvedWrite = {
            ...write,
            value: resolveAndroidDeviceEpochPlaceholders(write.value, deviceEpoch.epochMs),
          };
        }

        const writeResult = await executor(adbPath, [
          '-s',
          device.serial,
          'shell',
          buildAndroidAsyncStorageWriteCommand({ packageName, write: resolvedWrite }),
        ]);
        const writePassed = writeResult.exitCode === 0;
        raw[rawFileName] = formatAndroidCommandRawOutput(writeResult);
        checks.push({
          name: 'android_async_storage_written',
          status: writePassed ? 'passed' : 'failed',
          source: 'runner',
          code: writePassed ? 'android_async_storage_written' : 'android_async_storage_write_failed',
          message: writePassed
            ? `Wrote Android AsyncStorage value ${write.label ?? index + 1}.`
            : `Failed to write Android AsyncStorage value ${write.label ?? index + 1}.`,
          ...(!writePassed
            ? {
                metadata: nextActionHint(
                  'inspect_android_async_storage_write',
                  `Inspect raw/${rawFileName}, confirm the app is debuggable and sqlite3 can access RKStorage through run-as, then rerun the capture.`,
                ),
              }
            : {}),
        });

        if (write.waitMs && write.waitMs > 0) {
          await wait(write.waitMs);
          checks.push({
            name: 'android_async_storage_waited',
            status: 'passed',
            source: 'runner',
            code: 'android_async_storage_waited',
            message: `Waited ${write.waitMs}ms after Android AsyncStorage write ${write.label ?? index + 1}.`,
          });
        }
      }

      for (const [index, deepLink] of deepLinks.entries()) {
        const rawFileName = `adb-deep-link-${index + 1}.txt`;
        if (!startupReady) {
          checks.push({
            name: 'android_deep_link_opened',
            status: 'failed',
            source: 'runner',
            code: 'android_deep_link_skipped_startup_not_ready',
            message: `Skipped Android deep link ${deepLink.label ?? index + 1} because startup readiness failed.`,
            metadata: nextActionHint(
              'verify_android_startup_readiness',
              'Rerun after Android startup readiness passes; ASL will not deliver profile-session command deep links into an app that has not proven bundle readiness.',
            ),
          });
          continue;
        }

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

        if (deepLinkOpened && packageName && !lifecyclePackageName) {
          lifecyclePackageName = packageName;
          const pidofAfterDeepLink = await executor(adbPath, [
            '-s',
            device.serial,
            'shell',
            'pidof',
            packageName,
          ]);
          const rawPath = 'raw/adb-app-pidof-after-deep-link.txt';
          raw['adb-app-pidof-after-deep-link.txt'] = formatAndroidCommandRawOutput(pidofAfterDeepLink);
          const afterDeepLinkPids = parseAndroidPidofOutput(pidofAfterDeepLink.stdout);
          knownLifecyclePids = afterDeepLinkPids;
          const runningAfterDeepLink = pidofAfterDeepLink.exitCode === 0 && afterDeepLinkPids.length > 0;
          checks.push({
            name: 'android_app_process_running_after_deep_link',
            status: runningAfterDeepLink ? 'passed' : 'failed',
            source: 'runner',
            code: runningAfterDeepLink
              ? 'android_app_process_running_after_deep_link'
              : 'android_app_not_running_after_deep_link',
            message: runningAfterDeepLink
              ? `Package ${packageName} is running after deep link with PID ${afterDeepLinkPids.join(', ')}.`
              : `Package ${packageName} is not running after opening the deep link.`,
            ...(!runningAfterDeepLink
              ? {
                  metadata: nextActionHint(
                    'inspect_android_deep_link_launch',
                    `Inspect ${rawPath} and the app's device logs to find why the package-targeted deep link did not leave the app process running.`,
                  ),
                }
              : {}),
          });
          Object.assign(appLifecycleMetadata, {
            afterDeepLinkPids,
            afterDeepLinkRawPath: rawPath,
          });
        }
      }

      const driverActionMetadata: Record<string, unknown>[] = [];
      const logcatMetadata: Record<string, unknown>[] = [];
      const selectorResolutionMetadata: AndroidSelectorResolutionMetadata[] = [];
      for (const [index, driverStep] of resolvedDriverSteps.entries()) {
        const profileSessionLogcatLines = profileSessionCompletionExpectation?.source === 'storage' &&
          driverStep.driverAction === 'readLogs'
          ? Math.max(driverStep.lines ?? logcatLines, ANDROID_PROFILE_SESSION_LOGCAT_LINES_MIN)
          : driverStep.lines ?? logcatLines;
        let executableDriverStep = profileSessionCompletionExpectation?.source === 'storage' &&
          driverStep.driverAction === 'readLogs' &&
          profileSessionLogcatLines !== (driverStep.lines ?? logcatLines)
          ? { ...driverStep, lines: profileSessionLogcatLines }
          : driverStep;
        if (driverStep.waitMs && driverStep.waitMs > 0) {
          if (
            driverStep.driverAction === 'readLogs' &&
            profileSessionCompletionExpectation?.source === 'storage'
          ) {
            const rawFileName = `adb-profile-session-early-log-${index + 1}.txt`;
            const earlyCompletion = await waitForAndroidProfileSessionCompletion({
              driver,
              expectation: profileSessionCompletionExpectation,
              logcatLines: profileSessionLogcatLines,
              rawFileName,
              timeoutMs: driverStep.waitMs,
              wait,
            });
            const rawPath = `raw/${rawFileName}`;
            const observation = buildAndroidProfileSessionObservationWait({
              expectation: profileSessionCompletionExpectation,
              inspection: earlyCompletion.inspection,
              rawPath,
              wait: {
                completed: earlyCompletion.completed,
                elapsedMs: earlyCompletion.elapsedMs,
                pollCount: earlyCompletion.pollCount,
              },
            });
            raw[rawFileName] = formatAndroidAdbRawOutput(earlyCompletion.result);
            checks.push(buildAndroidProfileSessionObservationCheck({
              expectation: profileSessionCompletionExpectation,
              observation,
              timeoutMs: driverStep.waitMs,
            }));
            if (profileSessionCompletionExpectation.expectedCommandCount === 0) {
              metadata.profileSessionStartWait = observation;
            } else {
              metadata.profileSessionCompletionWait = observation;
            }
          } else {
            await wait(driverStep.waitMs);
          }
          checks.push({
            name: 'android_capture_window_waited',
            status: 'passed',
            source: 'runner',
            code: 'android_capture_window_waited',
            message: `Waited up to ${driverStep.waitMs}ms before running adb driver action ${driverStep.driverAction}.`,
            metadata: {
              driverAction: driverStep.driverAction,
              ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
            },
          });
        }

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
          checks.push(buildAndroidSelectorResolutionCheck({
            driverStep,
            rawFileName: treeResult.rawFileName,
            resolved,
          }));
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
          wait,
        });
        raw[driverResult.rawFileName] = formatAndroidAdbRawOutput(driverResult);
        const codeSuffix = androidDriverActionCode(driverStep.driverAction);
        const isReadLogs = driverStep.driverAction === 'readLogs';
        checks.push(buildAndroidDriverActionCheck({
          codeSuffix,
          driverResult,
          driverStep: executableDriverStep,
          isReadLogs,
          logcatLines,
        }));
        const actionMetadata = {
          args: driverResult.args,
          driverAction: executableDriverStep.driverAction,
          ...(typeof driverResult.elapsedMs === 'number' ? { elapsedMs: driverResult.elapsedMs } : {}),
          exitCode: driverResult.exitCode,
          ...(driverResult.capturePath
            ? { capturePath: `captures/${path.basename(driverResult.capturePath)}` }
            : {}),
          ...(typeof driverResult.pollCount === 'number' ? { pollCount: driverResult.pollCount } : {}),
          rawPath: `raw/${driverResult.rawFileName}`,
          ...(executableDriverStep.selector ? { selector: executableDriverStep.selector } : {}),
          ...(executableDriverStep.stepId ? { stepId: executableDriverStep.stepId } : {}),
          ...(driverResult.timedOut ? { timedOut: true } : {}),
          ...(typeof driverResult.timeoutMs === 'number' ? { timeoutMs: driverResult.timeoutMs } : {}),
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

      if (lifecyclePackageName) {
        const pidofAfterCapture = await executor(adbPath, [
          '-s',
          device.serial,
          'shell',
          'pidof',
          lifecyclePackageName,
        ]);
        const pidofAfterCaptureRawPath = 'raw/adb-app-pidof-after-capture.txt';
        raw['adb-app-pidof-after-capture.txt'] = formatAndroidCommandRawOutput(pidofAfterCapture);
        const afterCapturePids = parseAndroidPidofOutput(pidofAfterCapture.stdout);
        const foregroundAfterCapture = await executor(adbPath, [
          '-s',
          device.serial,
          'shell',
          'dumpsys',
          'window',
        ]);
        const foregroundAfterCaptureRawPath = 'raw/adb-window-foreground-after-capture.txt';
        raw['adb-window-foreground-after-capture.txt'] = formatAndroidCommandRawOutput(foregroundAfterCapture);
        const foregroundScan = foregroundAfterCapture.exitCode === 0
          ? scanAndroidForegroundWindow({
              output: `${foregroundAfterCapture.stdout}\n${foregroundAfterCapture.stderr}`,
              packageName: lifecyclePackageName,
            })
          : {
              captured: false,
              foregroundPackage: null,
              targetForeground: null,
            };
        const lifecycleLogLines = Math.max(logcatLines, 200);
        const lifecycleLog = await driver.readLogs({
          lines: lifecycleLogLines,
          rawFileName: 'adb-app-lifecycle-log.txt',
        });
        raw[lifecycleLog.rawFileName] = formatAndroidAdbRawOutput(lifecycleLog);
        const allKnownPids = Array.from(new Set([...knownLifecyclePids, ...afterCapturePids]));
        const scan = lifecycleLog.exitCode === 0
          ? scanAndroidAppLifecycleLog({
              logText: `${lifecycleLog.stdout}\n${lifecycleLog.stderr}`,
              packageName: lifecyclePackageName,
              pids: allKnownPids,
            })
          : { crashed: false, evidence: [] };
        const runningAfterCapture = pidofAfterCapture.exitCode === 0 && afterCapturePids.length > 0;
        checks.push(buildAndroidAppLifecycleHealthCheck({
          lifecycleLogExitCode: lifecycleLog.exitCode,
          lifecycleLogRawFileName: lifecycleLog.rawFileName,
          lifecyclePackageName,
          pidofAfterCaptureRawPath,
          runningAfterCapture,
          scan,
        }));
        checks.push(buildAndroidForegroundHealthCheck({
          foregroundRawPath: foregroundAfterCaptureRawPath,
          foregroundScan,
          lifecyclePackageName,
        }));
        metadata.appLifecycle = {
          ...appLifecycleMetadata,
          afterCapturePids,
          afterCaptureRawPath: pidofAfterCaptureRawPath,
          crashEvidence: scan.evidence,
          foreground: {
            foregroundPackage: foregroundScan.foregroundPackage,
            rawPath: foregroundAfterCaptureRawPath,
            targetForeground: foregroundScan.targetForeground,
          },
          lifecycleLogLines,
          lifecycleLogRawPath: `raw/${lifecycleLog.rawFileName}`,
          packageName: lifecyclePackageName,
        };
      }
    } else {
      if (clearLogcat || launch || startupDeepLinks.length > 0 || storageWrites.length > 0) {
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
  };

  try {
    await runAndroidAdbCaptureBodyWithWatchdog({
      body: runCaptureBody,
      watchdog: captureWatchdog,
    });
  } catch (error: unknown) {
    const timedOut = isAndroidAdbCaptureWatchdogError(error);
    const failure = {
      ...normalizeAndroidRunnerFailure(error),
      ...(timedOut
        ? {
            code: error.code,
            watchdog: error.watchdog,
          }
        : {}),
    };
    const rawFileName = timedOut ? 'adb-runner-watchdog-timeout.txt' : 'adb-runner-failure.txt';
    raw[rawFileName] = formatAndroidRunnerFailureRaw(failure);
    metadata.runnerFailure = {
      ...failure,
      rawPath: `raw/${rawFileName}`,
      collectedRawArtifacts: Object.keys(raw).map((fileName) => `raw/${fileName}`),
    };
    checks.push({
      name: 'android_adb_capture_liveness',
      status: 'failed',
      source: 'runner',
      code: timedOut ? 'android_adb_runner_liveness_timeout' : 'android_adb_runner_liveness_failure',
      message: timedOut
        ? `Android adb capture did not complete before the ${captureWatchdog.timeoutMs}ms watchdog deadline.`
        : 'Android adb capture stopped before normal artifact finalization.',
      metadata: {
        ...nextActionHint(
          timedOut ? 'inspect_android_adb_runner_timeout' : 'inspect_android_adb_runner_failure',
          timedOut
            ? `Inspect raw/${rawFileName}, raw/android-metadata.json, and the last collected raw adb artifact to identify the command or declared wait that exceeded the whole-capture watchdog.`
            : `Inspect raw/${rawFileName} and raw/android-metadata.json to determine which adb or runner step stopped before finalization, then rerun with a bounded command timeout if the host command stalled.`,
        ),
        rawPath: `raw/${rawFileName}`,
      },
    });
  }

  reconcileAndroidProfileSessionObservationFromFinalLogs({
    checks,
    expectation: profileSessionCompletionExpectation,
    metadata,
    raw,
  });

  const failedBeforePreservation = checks.some((check) => check.status === 'failed');
  const preservedSidecarEvidence = collectAndroidPreservedSidecarEvidence(raw);
  if (failedBeforePreservation && preservedSidecarEvidence.length > 0) {
    checks.push(buildAndroidPreservedSidecarEvidenceCheck(preservedSidecarEvidence));
    metadata.preservedSidecarEvidence = preservedSidecarEvidence;
  }

  const health = buildAndroidHealth({ runId, checks });
  const verdict = buildAndroidVerdict({ runId, health });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });

  await writeAndroidAdbArtifacts({
    agentSummary,
    health,
    layout,
    metadata,
    raw,
    rawDir,
    verdict,
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
    commandTimeoutMs: parsePositiveInteger(args['command-timeout-ms'], DEFAULT_ADB_COMMAND_TIMEOUT_MS),
    launch: args.launch === true || args.launch === 'true',
    launchWaitMs: parsePositiveInteger(args['launch-wait-ms'], 0),
    logcatLines: parsePositiveInteger(args['logcat-lines'], 1000),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    ...(typeof args.package === 'string' ? { packageName: args.package } : {}),
    ...(typeof args['react-native-debug-host'] === 'string'
      ? { reactNativeDebugHost: args['react-native-debug-host'] }
      : {}),
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    ...(typeof args['android-dev-client-url'] === 'string'
      ? {
          startupDeepLinks: [{
            label: 'android-dev-client-url',
            ...(typeof args['android-dev-client-ready-pattern'] === 'string'
              ? { readyLogPattern: args['android-dev-client-ready-pattern'] }
              : {}),
            readyLogQuietMs: parsePositiveInteger(args['android-dev-client-ready-quiet-ms'], 0),
            readyLogTimeoutMs: parsePositiveInteger(args['android-dev-client-ready-timeout-ms'], 60000),
            url: args['android-dev-client-url'],
            waitMs: parsePositiveInteger(args['android-dev-client-wait-ms'], 1000),
          }],
        }
      : {}),
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
  ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER,
  buildAndroidHealth,
  buildAndroidVerdict,
  buildReactNativeDebugHostPreferenceCommand,
  deriveAndroidAdbCaptureWatchdogBudget,
  escapeAndroidPreferenceXml,
  execFileCommand,
  execFileCommandWithTimeout,
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
  AndroidAsyncStorageWrite,
  AndroidDeepLinkCommand,
  AndroidPreflightOptions,
  AndroidPreflightResult,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
