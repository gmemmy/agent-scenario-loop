import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { Linking, NativeModules, Platform } from 'react-native';
import * as ExpoLinking from 'expo-linking';
import {
  buildProfileCommandDependencyGate,
  buildProfileCommandMilestoneGate,
  compareProfileCommands,
  doesProfileCommandMatchDependencyGate,
  doesProfileEventReleaseCommandGate,
  hasObservedProfileCommandDependencies,
  hasObservedProfileCommandMilestone,
  resolveProfileCommandCadenceOutcome,
  resolveProfileCommandDependencyTimeoutOutcome,
  resolveProfileCommandMilestoneTimeoutOutcome,
  resolveProfileCommandQueueBlocker,
  resolveProfileCommandSettleOutcome,
  resolveRemainingProfileCommandSettleMs,
  takeNextProfileCommand,
  type ProfileCommandMilestoneGate as BaseProfileCommandMilestoneGate,
} from './profile-session-command-ordering';
import {
  createProfileCommandDependencyController,
  createProfileCommandScheduleController,
  createProfileSessionLifecycleController,
  readProfileSessionLifecycleValue,
  resolveDependencyTimeoutQueueTransition,
  resolveProfileCommandFailFastQueueTransition,
  runProfileSessionBootstrapSequence,
} from './profile-session-dependency-controller';
import { PROFILE_SESSION_STORAGE_KEYS as PROFILE_SESSION_STORAGE_KEY_VALUES } from './profile-session-storage';

export type ProfileSessionState = {
  active: boolean;
  scenario: string | null;
  runId: string | null;
  startedAt: number | null;
};

export type ProfileSessionCommand = {
  id: string;
  commandId?: string;
  dependsOnMilestones?: string[];
  scenario?: string;
  runId?: string;
  command: string;
  queueId?: string;
  sequence?: number;
  stopOnFailure?: boolean;
  source?: 'deeplink' | 'storage';
  timestamp: number;
  waitForMilestone?: string;
  waitMs?: number;
  waitTimeoutMs?: number;
};

export type ProfileSignalKind = 'js' | 'memory' | 'network';
export type ProfileEventPhase =
  | 'intent'
  | 'navigation'
  | 'domain'
  | 'query'
  | 'network'
  | 'render'
  | 'native'
  | 'visual'
  | 'completion';
export type ProfileEventStatus = 'started' | 'completed' | 'failed' | 'skipped' | 'observed';

export type ProfileEventMetadata = {
  flowId?: string;
  owner?: string;
  phase?: ProfileEventPhase;
  status?: ProfileEventStatus;
  route?: string;
  atMs?: number;
  [key: string]: unknown;
};

export type ProfileSignalMetadata = {
  flowId?: string;
  owner?: string;
  route?: string;
  [key: string]: unknown;
};

type StoredProfileEvent = {
  scenario: string;
  runId: string;
  event: string;
  timestamp: number;
  [key: string]: unknown;
};

type StoredProfileSessionEntry = {
  kind: 'start' | 'stop' | 'command';
  scenario: string;
  runId: string;
  timestamp: number;
  helperVersion?: string;
  atMs?: number;
  startedAt?: number;
  stoppedAt?: number;
  command?: string;
  commandId?: string;
  dependsOnMilestones?: string[];
  id?: string;
  queueId?: string;
  reason?: string;
  result?: string;
  sequence?: number;
  source?: 'deeplink' | 'storage';
  status?: 'received' | 'queued' | 'delivered' | 'completed' | 'skipped';
  stopOnFailure?: boolean;
  continuationReason?: string;
  missingDependencies?: string[];
  waitForMilestone?: string;
  minimumSettleMs?: number;
  plannedSettleMs?: number;
  maxReadinessWaitMs?: number;
  readinessWaitMs?: number;
  actualWaitMs?: number;
  settleOverlapSavedMs?: number;
  timeoutAvoided?: boolean;
  waitMs?: number;
  waitTimeoutMs?: number;
};

type StoredProfileSignals = Record<ProfileSignalKind, Record<string, unknown>>;
type ProfileCommandMilestoneGate = BaseProfileCommandMilestoneGate & {
  command: ProfileSessionCommand;
  commandReleasedAtMs: number;
  timeoutId?: ReturnType<typeof setTimeout>;
};
type ProfileCommandCadenceObservation =
  | {
      kind: 'readiness';
      command: ProfileSessionCommand;
      commandReleasedAtMs: number;
      readinessObservedAtMs: number;
    }
  | {
      kind: 'settle-only';
      command: ProfileSessionCommand;
      commandReleasedAtMs: number;
    };
type ProfileCommandClearStoragePolicy = 'preserve-storage' | 'remove-storage';
type ProfileCommandDispatchOutcome = 'dispatched' | 'queued' | 'skipped';

export const PROFILE_SESSION_HELPER_VERSION = '1.1.0';
const PROFILE_SESSION_DEFAULT_STOP_ON_FAILURE = true;

const INITIAL_STATE: ProfileSessionState = {
  active: false,
  scenario: null,
  runId: null,
  startedAt: null,
};

const PROFILE_EVENT_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES.event;
const PROFILE_SIGNAL_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES.signal;
const PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES.session;
const PROFILE_COMMAND_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES.command;
const PROFILE_SESSION_ENTRIES_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES.sessionEntries;
const PROFILE_STORAGE_POLL_INTERVAL_MS = 350;
const PROFILE_SESSION_MAX_AGE_MS = 2 * 60 * 60_000;
const PROFILE_COMMAND_DUPLICATE_WINDOW_MS = 750;
const PROCESSED_PROFILE_COMMAND_ID_LIMIT = 120;
const MAX_STORED_PROFILE_EVENTS = 300;
const MAX_STORED_PROFILE_SESSION_ENTRIES = 120;

export const PROFILE_SESSION_STORAGE_KEYS = Object.freeze({
  command: PROFILE_COMMAND_STORAGE_KEY,
  event: PROFILE_EVENT_STORAGE_KEY,
  session: PROFILE_SESSION_STORAGE_KEY,
  sessionEntries: PROFILE_SESSION_ENTRIES_STORAGE_KEY,
  signal: PROFILE_SIGNAL_STORAGE_KEY,
});

let profileSessionState: ProfileSessionState = INITIAL_STATE;
let profileStorageWriteChain = Promise.resolve();
const listeners = new Set<() => void>();
const profileCommandListeners = new Set<(command: ProfileSessionCommand) => void>();
const profileCommandTargetHandlers = new Map<string, (command: ProfileSessionCommand) => void>();
const pendingProfileCommands: ProfileSessionCommand[] = [];
const sequencedProfileCommands: ProfileSessionCommand[] = [];
const observedProfileEvents: StoredProfileEvent[] = [];
const processedProfileCommandIds = new Set<string>();
let lastProfileCommandSignature: string | null = null;
let lastProfileCommandTimestamp = 0;
let profileCommandMilestoneGate: ProfileCommandMilestoneGate | null = null;
const profileCommandDependencyController = createProfileCommandDependencyController<ProfileSessionCommand>();
const profileSessionLifecycleController = createProfileSessionLifecycleController();
const profileCommandScheduleController = createProfileCommandScheduleController(
  profileSessionLifecycleController,
);
let profileCommandProcessingScheduled = false;
let profileCommandProcessingTimeoutId: ReturnType<typeof setTimeout> | null = null;
let profileCommandProcessingAvailableAt = 0;
let profileCommandCadenceObservation: ProfileCommandCadenceObservation | null = null;

function writeProfileLog(line: string) {
  if (Platform.OS === 'ios') {
    const profileLogger = (
      NativeModules as typeof NativeModules & {
        ProfileLogger?: { log?: (message: string) => void };
      }
    ).ProfileLogger;

    if (typeof profileLogger?.log === 'function') {
      try {
        profileLogger.log(line);
        return;
      } catch {
        // Fall back to JS logging if the native bridge is unavailable.
      }
    }
  }

  const nativeLoggingHook = (
    globalThis as typeof globalThis & {
      nativeLoggingHook?: ((message: string, level: number) => void) | undefined;
    }
  ).nativeLoggingHook;

  if (typeof nativeLoggingHook === 'function') {
    try {
      nativeLoggingHook(line, 0);
      return;
    } catch {
      // Fall back to console output if the native hook is unavailable.
    }
  }

  console.info(line);
}

function buildLogLine(kind: 'profile-session' | 'profile-event', payload: Record<string, unknown>) {
  return [
    `[${kind}]`,
    ...Object.entries(payload).map(([key, value]) => `${key}=${String(value)}`),
  ].join(' ');
}

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function queueProfileStorageMutation(mutation: () => Promise<void>) {
  profileStorageWriteChain = profileStorageWriteChain.then(mutation).catch(() => {});
}

async function readStoredJson<Value>(key: string, fallback: Value): Promise<Value> {
  try {
    const value = await AsyncStorage.getItem(key);
    if (!value) {
      return fallback;
    }

    return JSON.parse(value) as Value;
  } catch {
    return fallback;
  }
}

async function writeStoredJson(key: string, value: unknown) {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

function appendStoredProfileSessionEntry(entry: StoredProfileSessionEntry) {
  queueProfileStorageMutation(async () => {
    const currentEntries = await readStoredJson<StoredProfileSessionEntry[]>(
      PROFILE_SESSION_ENTRIES_STORAGE_KEY,
      [],
    );
    const nextEntries = [...currentEntries, entry].slice(-MAX_STORED_PROFILE_SESSION_ENTRIES);
    await writeStoredJson(PROFILE_SESSION_ENTRIES_STORAGE_KEY, nextEntries);
  });
}

function appendStoredProfileEvent(event: StoredProfileEvent) {
  queueProfileStorageMutation(async () => {
    const currentEvents = await readStoredJson<StoredProfileEvent[]>(PROFILE_EVENT_STORAGE_KEY, []);
    const nextEvents = [...currentEvents, event].slice(-MAX_STORED_PROFILE_EVENTS);
    await writeStoredJson(PROFILE_EVENT_STORAGE_KEY, nextEvents);
  });
}

function resetStoredProfileArtifacts() {
  observedProfileEvents.length = 0;
  queueProfileStorageMutation(async () => {
    await Promise.all([
      AsyncStorage.removeItem(PROFILE_EVENT_STORAGE_KEY),
      AsyncStorage.removeItem(PROFILE_SIGNAL_STORAGE_KEY),
      AsyncStorage.removeItem(PROFILE_SESSION_ENTRIES_STORAGE_KEY),
    ]);
  });
}

function clearPendingProfileCommands(storagePolicy: ProfileCommandClearStoragePolicy = 'remove-storage') {
  pendingProfileCommands.length = 0;
  sequencedProfileCommands.length = 0;
  clearProfileCommandMilestoneGate();
  clearProfileCommandDependencyGate();
  clearProfileCommandProcessingSchedule();
  if (storagePolicy === 'preserve-storage') {
    return;
  }
  queueProfileStorageMutation(async () => {
    await AsyncStorage.removeItem(PROFILE_COMMAND_STORAGE_KEY);
  });
}

function suspendProfileCommandQueueForBootstrapUnmount() {
  const blockedCommand = sequencedProfileCommands[0];
  pendingProfileCommands.length = 0;
  sequencedProfileCommands.length = 0;
  clearProfileCommandMilestoneGate();
  clearProfileCommandProcessingSchedule();
  if (blockedCommand?.source === 'storage') {
    profileCommandDependencyController.suspend();
  } else {
    clearProfileCommandDependencyGate();
  }
}

/**
 * Clears command replay guards when a scenario session boundary changes.
 */
function clearProfileCommandDedupe() {
  lastProfileCommandSignature = null;
  lastProfileCommandTimestamp = 0;
  processedProfileCommandIds.clear();
}

function setProfileSessionState(nextState: ProfileSessionState) {
  profileSessionState = nextState;
  queueProfileStorageMutation(async () => {
    if (!nextState.active || !nextState.scenario || !nextState.runId) {
      await AsyncStorage.removeItem(PROFILE_SESSION_STORAGE_KEY);
      return;
    }

    await writeStoredJson(PROFILE_SESSION_STORAGE_KEY, nextState);
  });
  notifyListeners();
}

/**
 * Returns the numeric start time for a profile session when one is available.
 *
 * @param {ProfileSessionState | null} session
 * @returns {number | null}
 */
function readProfileSessionStartedAt(session: ProfileSessionState | null): number | null {
  if (typeof session?.startedAt !== 'number' || !Number.isFinite(session.startedAt)) {
    return null;
  }

  return session.startedAt;
}

function resolveProfileSessionElapsedAtMs(
  timestamp: number,
  explicitAtMs: unknown,
  sessionStartedAt: number | null | undefined,
): number | undefined {
  if (typeof explicitAtMs === 'number' && Number.isFinite(explicitAtMs)) {
    return explicitAtMs;
  }

  if (typeof sessionStartedAt !== 'number' || !Number.isFinite(sessionStartedAt)) {
    return undefined;
  }

  return Math.max(0, timestamp - sessionStartedAt);
}

/**
 * Guards the in-memory session from older AsyncStorage snapshots.
 *
 * @param {ProfileSessionState} storedSession
 * @returns {boolean}
 */
function shouldApplyStoredProfileSession(storedSession: ProfileSessionState): boolean {
  if (!profileSessionState.active || !profileSessionState.scenario || !profileSessionState.runId) {
    return true;
  }

  if (
    profileSessionState.scenario === storedSession.scenario &&
    profileSessionState.runId === storedSession.runId
  ) {
    return false;
  }

  const storedStartedAt = readProfileSessionStartedAt(storedSession);
  const activeStartedAt = readProfileSessionStartedAt(profileSessionState);
  return storedStartedAt !== null && activeStartedAt !== null && storedStartedAt > activeStartedAt;
}

/**
 * Returns true when a stored session is fresh enough to revive after app startup.
 *
 * @param {Pick<ProfileSessionState, 'active' | 'startedAt'>} session
 * @param {number} [now]
 * @returns {boolean}
 */
export function isProfileSessionFresh(
  session: Pick<ProfileSessionState, 'active' | 'startedAt'>,
  now = Date.now(),
): boolean {
  if (!session.active) {
    return false;
  }
  if (typeof session.startedAt !== 'number' || !Number.isFinite(session.startedAt)) {
    return false;
  }
  return now - session.startedAt <= PROFILE_SESSION_MAX_AGE_MS;
}

function logProfileSession(kind: 'start' | 'stop' | 'command', payload: Record<string, unknown>) {
  const timestamp = Date.now();
  const sessionStartedAt = readProfileSessionStartedAt(profileSessionState);
  const atMs = resolveProfileSessionElapsedAtMs(timestamp, payload.atMs, sessionStartedAt);
  const logPayload = {
    kind,
    ...payload,
    helperVersion: PROFILE_SESSION_HELPER_VERSION,
    timestamp,
    ...(atMs !== undefined ? { atMs } : {}),
  };
  writeProfileLog(buildLogLine('profile-session', logPayload));

  const scenario = typeof payload.scenario === 'string' ? payload.scenario : null;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!scenario || !runId) {
    return;
  }

  const entry: StoredProfileSessionEntry = {
    kind,
    scenario,
    runId,
    timestamp,
    helperVersion: PROFILE_SESSION_HELPER_VERSION,
    ...(atMs !== undefined ? { atMs } : {}),
  };

  if (kind === 'start' && typeof payload.startedAt === 'number') {
    entry.startedAt = payload.startedAt;
  }

  if (kind === 'stop' && typeof payload.stoppedAt === 'number') {
    entry.stoppedAt = payload.stoppedAt;
  }

  if (kind === 'command') {
    if (typeof payload.command === 'string') {
      entry.command = payload.command;
    }
    if (typeof payload.id === 'string') {
      entry.id = payload.id;
    }
    if (typeof payload.commandId === 'string') {
      entry.commandId = payload.commandId;
    } else if (typeof payload.id === 'string') {
      entry.commandId = payload.id;
    }
    if (Array.isArray(payload.dependsOnMilestones)) {
      const dependsOnMilestones = payload.dependsOnMilestones.filter((milestone) => (
        typeof milestone === 'string' && milestone.length > 0
      ));
      if (dependsOnMilestones.length > 0) {
        entry.dependsOnMilestones = dependsOnMilestones;
      }
    }
    if (typeof payload.queueId === 'string') {
      entry.queueId = payload.queueId;
    }
    if (typeof payload.sequence === 'number') {
      entry.sequence = payload.sequence;
    }
    if (payload.source === 'deeplink' || payload.source === 'storage') {
      entry.source = payload.source;
    }
    if (
      payload.status === 'received' ||
      payload.status === 'queued' ||
      payload.status === 'delivered' ||
      payload.status === 'completed' ||
      payload.status === 'skipped'
    ) {
      entry.status = payload.status;
    }
    if (typeof payload.stopOnFailure === 'boolean') {
      entry.stopOnFailure = payload.stopOnFailure;
    }
    if (typeof payload.continuationReason === 'string') {
      entry.continuationReason = payload.continuationReason;
    }
    if (Array.isArray(payload.missingDependencies)) {
      const missingDependencies = payload.missingDependencies.filter((milestone) => (
        typeof milestone === 'string' && milestone.length > 0
      ));
      if (missingDependencies.length > 0) {
        entry.missingDependencies = missingDependencies;
      }
    }
    if (typeof payload.reason === 'string') {
      entry.reason = payload.reason;
    }
    if (typeof payload.result === 'string') {
      entry.result = payload.result;
    }
    if (typeof payload.waitForMilestone === 'string') {
      entry.waitForMilestone = payload.waitForMilestone;
    }
    if (typeof payload.minimumSettleMs === 'number') {
      entry.minimumSettleMs = payload.minimumSettleMs;
    }
    if (typeof payload.plannedSettleMs === 'number') {
      entry.plannedSettleMs = payload.plannedSettleMs;
    }
    if (typeof payload.maxReadinessWaitMs === 'number') {
      entry.maxReadinessWaitMs = payload.maxReadinessWaitMs;
    }
    if (typeof payload.readinessWaitMs === 'number') {
      entry.readinessWaitMs = payload.readinessWaitMs;
    }
    if (typeof payload.actualWaitMs === 'number') {
      entry.actualWaitMs = payload.actualWaitMs;
    }
    if (typeof payload.settleOverlapSavedMs === 'number') {
      entry.settleOverlapSavedMs = payload.settleOverlapSavedMs;
    }
    if (typeof payload.timeoutAvoided === 'boolean') {
      entry.timeoutAvoided = payload.timeoutAvoided;
    }
    if (typeof payload.waitMs === 'number') {
      entry.waitMs = payload.waitMs;
    }
    if (typeof payload.waitTimeoutMs === 'number') {
      entry.waitTimeoutMs = payload.waitTimeoutMs;
    }
  }

  appendStoredProfileSessionEntry(entry);
}

function getProfileSessionRoute(url: string): {
  action: 'start' | 'stop' | 'command';
  scenario?: string;
  runId?: string;
  command?: string;
  commandId?: string;
  dependsOnMilestones?: string[];
  queueId?: string;
  sequence?: number;
  stopOnFailure?: boolean;
  waitForMilestone?: string;
  waitMs?: number;
  waitTimeoutMs?: number;
} | null {
  const parsed = ExpoLinking.parse(url);
  const segments = [parsed.hostname, parsed.path]
    .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
    .flatMap((segment) => segment.split('/').filter(Boolean));

  if (segments[0] !== 'profile-session') {
    return null;
  }

  const action = segments[1];
  if (action !== 'start' && action !== 'stop' && action !== 'command') {
    return null;
  }

  const scenario =
    typeof parsed.queryParams?.scenario === 'string' ? parsed.queryParams.scenario : undefined;
  const runId =
    typeof parsed.queryParams?.runId === 'string' ? parsed.queryParams.runId : undefined;
  const command =
    typeof parsed.queryParams?.command === 'string' ? parsed.queryParams.command : undefined;
  const commandId =
    typeof parsed.queryParams?.commandId === 'string' ? parsed.queryParams.commandId : undefined;
  const sequence =
    typeof parsed.queryParams?.sequence === 'string' && Number.isInteger(Number(parsed.queryParams.sequence))
      ? Number(parsed.queryParams.sequence)
      : undefined;
  const queueId =
    typeof parsed.queryParams?.queueId === 'string' ? parsed.queryParams.queueId : undefined;
  const waitForMilestone =
    typeof parsed.queryParams?.waitForMilestone === 'string' ? parsed.queryParams.waitForMilestone : undefined;
  const waitTimeoutMs =
    typeof parsed.queryParams?.waitTimeoutMs === 'string' && Number.isInteger(Number(parsed.queryParams.waitTimeoutMs))
      ? Number(parsed.queryParams.waitTimeoutMs)
      : undefined;
  const waitMs =
    typeof parsed.queryParams?.waitMs === 'string' && Number.isInteger(Number(parsed.queryParams.waitMs))
      ? Number(parsed.queryParams.waitMs)
      : undefined;
  const dependsOnMilestones = (
    Array.isArray(parsed.queryParams?.dependsOnMilestones)
      ? parsed.queryParams.dependsOnMilestones
      : (typeof parsed.queryParams?.dependsOnMilestones === 'string'
          ? parsed.queryParams.dependsOnMilestones.split(',')
          : [])
  ).filter((milestone): milestone is string => typeof milestone === 'string' && milestone.length > 0);
  const stopOnFailure =
    parsed.queryParams?.stopOnFailure === 'true'
      ? true
      : parsed.queryParams?.stopOnFailure === 'false'
        ? false
        : undefined;

  return {
    action,
    scenario,
    runId,
    command,
    commandId,
    ...(dependsOnMilestones.length > 0 ? { dependsOnMilestones } : {}),
    queueId,
    sequence,
    stopOnFailure,
    waitForMilestone,
    waitMs,
    waitTimeoutMs,
  };
}

function persistPendingProfileCommands() {
  const commands = [...pendingProfileCommands];
  queueProfileStorageMutation(async () => {
    if (commands.length === 0) {
      await AsyncStorage.removeItem(PROFILE_COMMAND_STORAGE_KEY);
      return;
    }
    await writeStoredJson(PROFILE_COMMAND_STORAGE_KEY, commands);
  });
}

function queuePendingProfileCommand(command: ProfileSessionCommand) {
  pendingProfileCommands.push(command);
  persistPendingProfileCommands();
}

function takeNextPendingProfileCommand(): ProfileSessionCommand | undefined {
  const transition = takeNextProfileCommand(pendingProfileCommands);
  pendingProfileCommands.length = 0;
  pendingProfileCommands.push(...transition.remainingCommands);
  persistPendingProfileCommands();
  return transition.command ?? undefined;
}

function restorePendingProfileCommand(command: ProfileSessionCommand) {
  pendingProfileCommands.unshift(command);
  persistPendingProfileCommands();
}

/**
 * Resolves the semantic target id for runner commands that activate app-owned controls.
 */
function getProfileCommandTargetId(command: string): string | null {
  if (!command.startsWith('activate-target:')) {
    return null;
  }

  const targetId = command.slice('activate-target:'.length);
  return targetId.length > 0 ? targetId : null;
}

function dispatchProfileCommandTarget(command: ProfileSessionCommand) {
  const targetId = getProfileCommandTargetId(command.command);
  if (!targetId) {
    return false;
  }

  const handler = profileCommandTargetHandlers.get(targetId);
  if (!handler) {
    return false;
  }

  handler(command);
  return true;
}

function dispatchProfileCommand(command: ProfileSessionCommand): boolean {
  const targetDispatched = dispatchProfileCommandTarget(command);
  if (targetDispatched) {
    logProfileSession('command', {
      ...command,
      status: 'delivered',
      result: 'target-dispatched',
      stopOnFailure: resolveProfileCommandStopOnFailure(command.stopOnFailure),
    });
    return true;
  }

  if (profileCommandListeners.size === 0) {
    return false;
  }

  for (const listener of profileCommandListeners) {
    listener(command);
  }
  logProfileSession('command', {
    ...command,
    status: 'delivered',
    result: 'listener-notified',
    stopOnFailure: resolveProfileCommandStopOnFailure(command.stopOnFailure),
  });
  return true;
}

/**
 * Builds a stable key for duplicate command suppression across delivery lanes.
 */
function getProfileCommandSignature(command: ProfileSessionCommand): string {
  return [
    command.scenario ?? '',
    command.runId ?? '',
    command.queueId ?? '',
    command.commandId ?? command.id,
    typeof command.sequence === 'number' ? String(command.sequence) : '',
    command.command,
  ].join('|');
}

/**
 * Detects duplicate runner commands delivered repeatedly during one short native handoff window.
 */
function shouldSkipProfileCommandForDuplicateWindow(
  command: ProfileSessionCommand,
  commandTimestamp: number,
): boolean {
  if (command.source === 'storage') {
    return false;
  }

  const signature = getProfileCommandSignature(command);
  return (
    signature === lastProfileCommandSignature &&
    commandTimestamp - lastProfileCommandTimestamp >= 0 &&
    commandTimestamp - lastProfileCommandTimestamp <= PROFILE_COMMAND_DUPLICATE_WINDOW_MS
  );
}

/**
 * Returns true when a stored command id has already been replayed into the app.
 */
function hasProcessedProfileCommandId(command: ProfileSessionCommand): boolean {
  return command.id.length > 0 && processedProfileCommandIds.has(command.id);
}

/**
 * Records a stored command id while keeping the replay cache bounded.
 */
function markProfileCommandIdProcessed(command: ProfileSessionCommand) {
  if (!command.id) {
    return;
  }

  processedProfileCommandIds.add(command.id);
  while (processedProfileCommandIds.size > PROCESSED_PROFILE_COMMAND_ID_LIMIT) {
    const oldestId = processedProfileCommandIds.keys().next().value;
    if (typeof oldestId !== 'string') {
      break;
    }
    processedProfileCommandIds.delete(oldestId);
  }
}

function shouldQueueProfileCommand(command: ProfileSessionCommand): boolean {
  return !hasProcessedProfileCommandId(command) &&
    !sequencedProfileCommands.some((queuedCommand) => queuedCommand.id === command.id);
}

function clearProfileCommandMilestoneGate() {
  if (profileCommandMilestoneGate?.timeoutId) {
    clearTimeout(profileCommandMilestoneGate.timeoutId);
  }
  profileCommandMilestoneGate = null;
}

function clearProfileCommandDependencyGate() {
  profileCommandDependencyController.clear();
}

function clearProfileCommandProcessingSchedule() {
  profileCommandScheduleController.invalidate();
  if (profileCommandProcessingTimeoutId) {
    clearTimeout(profileCommandProcessingTimeoutId);
  }
  profileCommandProcessingTimeoutId = null;
  profileCommandProcessingScheduled = false;
  profileCommandProcessingAvailableAt = 0;
  profileCommandCadenceObservation = null;
}

function resolveProfileCommandStopOnFailure(value: unknown): boolean {
  return typeof value === 'boolean' ? value : PROFILE_SESSION_DEFAULT_STOP_ON_FAILURE;
}

function installProfileCommandWait(
  command: ProfileSessionCommand,
  gate: BaseProfileCommandMilestoneGate | null,
  commandReleasedAtMs: number,
) {
  profileCommandMilestoneGate = gate
    ? { ...gate, command, commandReleasedAtMs }
    : null;
  startProfileCommandMilestoneTimeout(command);
}

function scheduleProfileCommandSettle(
  command: ProfileSessionCommand,
  commandReleasedAtMs: number,
) {
  profileCommandCadenceObservation = typeof command.waitForMilestone === 'string'
    ? {
        kind: 'readiness',
        command,
        commandReleasedAtMs,
        readinessObservedAtMs: commandReleasedAtMs,
      }
    : {
        kind: 'settle-only',
        command,
        commandReleasedAtMs,
      };
  scheduleProfileCommandProcessing(
    typeof command.waitMs === 'number' && command.waitMs > 0
      ? command.waitMs
      : 0,
  );
}

function logProfileCommandCadenceObservation(
  observation: ProfileCommandCadenceObservation,
  continuationObservedAtMs: number,
) {
  const outcome = observation.kind === 'readiness'
    ? resolveProfileCommandCadenceOutcome({
        minimumSettleMs: observation.command.waitMs,
        commandReleasedAtMs: observation.commandReleasedAtMs,
        readinessObservedAtMs: observation.readinessObservedAtMs,
        continuationObservedAtMs,
        maxReadinessWaitMs: observation.command.waitTimeoutMs,
      })
    : resolveProfileCommandSettleOutcome({
        minimumSettleMs: observation.command.waitMs,
        commandReleasedAtMs: observation.commandReleasedAtMs,
        continuationObservedAtMs,
      });

  logProfileSession('command', {
    ...observation.command,
    status: 'completed',
    result: 'cadence-settled',
    continuationReason: outcome.reason,
    stopOnFailure: resolveProfileCommandStopOnFailure(observation.command.stopOnFailure),
    minimumSettleMs: outcome.telemetry.minimumSettleMs,
    plannedSettleMs: outcome.telemetry.minimumSettleMs,
    ...(typeof outcome.telemetry.maxReadinessWaitMs === 'number'
      ? { maxReadinessWaitMs: outcome.telemetry.maxReadinessWaitMs }
      : {}),
    readinessWaitMs: outcome.telemetry.readinessWaitMs,
    actualWaitMs: outcome.telemetry.actualWaitMs,
    settleOverlapSavedMs: outcome.telemetry.settleOverlapSavedMs,
    ...(typeof outcome.telemetry.timeoutAvoided === 'boolean'
      ? { timeoutAvoided: outcome.telemetry.timeoutAvoided }
      : {}),
  });
}

function startProfileCommandMilestoneTimeout(command: ProfileSessionCommand) {
  if (
    !profileCommandMilestoneGate ||
    typeof command.waitTimeoutMs !== 'number' ||
    command.waitTimeoutMs <= 0
  ) {
    return;
  }

  const scheduledGate = profileCommandMilestoneGate;
  const lifecycleGeneration = profileSessionLifecycleController.capture();
  profileCommandMilestoneGate.timeoutId = setTimeout(() => {
    if (
      !profileSessionLifecycleController.isCurrent(lifecycleGeneration) ||
      profileCommandMilestoneGate !== scheduledGate
    ) {
      return;
    }

    const timeoutAtMs = Date.now();
    const timeoutOutcome = resolveProfileCommandMilestoneTimeoutOutcome({
      commandReleasedAtMs: profileCommandMilestoneGate.commandReleasedAtMs,
      timeoutObservedAtMs: timeoutAtMs,
      minimumSettleMs: profileCommandMilestoneGate.waitMs,
      maxReadinessWaitMs: profileCommandMilestoneGate.waitTimeoutMs,
      stopOnFailure: resolveProfileCommandStopOnFailure(profileCommandMilestoneGate.stopOnFailure),
    });

    logProfileSession('command', {
      ...command,
      status: 'skipped',
      reason: 'wait-for-milestone-timeout',
      continuationReason: timeoutOutcome.reason,
      minimumSettleMs: timeoutOutcome.telemetry.minimumSettleMs,
      plannedSettleMs: timeoutOutcome.telemetry.minimumSettleMs,
      maxReadinessWaitMs: timeoutOutcome.telemetry.maxReadinessWaitMs,
      readinessWaitMs: timeoutOutcome.telemetry.readinessWaitMs,
      actualWaitMs: timeoutOutcome.telemetry.actualWaitMs,
      settleOverlapSavedMs: timeoutOutcome.telemetry.settleOverlapSavedMs,
      timeoutAvoided: timeoutOutcome.telemetry.timeoutAvoided,
    });

    const queueTransition = resolveProfileCommandFailFastQueueTransition({
      blockedCommand: command,
      pendingCommands: pendingProfileCommands,
      sequencedCommands: sequencedProfileCommands,
      stopOnFailure: timeoutOutcome.kind === 'terminal',
    });
    clearProfileCommandMilestoneGate();
    pendingProfileCommands.length = 0;
    pendingProfileCommands.push(...queueTransition.pendingCommands);
    sequencedProfileCommands.length = 0;
    sequencedProfileCommands.push(...queueTransition.sequencedCommands);

    if (timeoutOutcome.kind === 'terminal') {
      for (const remainingCommand of queueTransition.skippedCommands) {
        if (!remainingCommand) {
          continue;
        }
        logProfileSession('command', {
          ...remainingCommand,
          status: 'skipped',
          reason: 'prior-command-failure',
          continuationReason: 'milestone-timeout-stop',
        });
        markProfileCommandIdProcessed(remainingCommand);
      }
      clearProfileCommandProcessingSchedule();
      persistPendingProfileCommands();
      processSequencedProfileCommands();
      return;
    }

    processSequencedProfileCommands();
  }, command.waitTimeoutMs);
}

function installProfileCommandDependencyGate(command: ProfileSessionCommand) {
  profileCommandDependencyController.install({
    command,
    observedEvents: observedProfileEvents,
    onTimeout: (gate) => {
      const currentCommand = sequencedProfileCommands[0];
      if (
        !currentCommand ||
        !doesProfileCommandMatchDependencyGate(gate, currentCommand)
      ) {
        return;
      }

      const currentGate = buildProfileCommandDependencyGate(currentCommand, observedProfileEvents);
      if (!currentGate) {
        clearProfileCommandDependencyGate();
        processSequencedProfileCommands();
        return;
      }

      const timeoutOutcome = resolveProfileCommandDependencyTimeoutOutcome(
        resolveProfileCommandStopOnFailure(currentCommand.stopOnFailure),
      );
      sequencedProfileCommands.shift();
      markProfileCommandIdProcessed(currentCommand);
      logProfileSession('command', {
        ...currentCommand,
        status: 'skipped',
        reason: 'dependency-milestone-timeout',
        continuationReason: timeoutOutcome.reason,
        missingDependencies: currentGate.missingDependencies,
        stopOnFailure: timeoutOutcome.kind === 'terminal',
        waitTimeoutMs: currentGate.waitTimeoutMs,
      });

      const queueTransition = resolveDependencyTimeoutQueueTransition({
        blockedCommand: currentCommand,
        pendingCommands: pendingProfileCommands,
        sequencedCommands: sequencedProfileCommands,
        stopOnFailure: timeoutOutcome.kind === 'terminal',
      });
      clearProfileCommandDependencyGate();
      pendingProfileCommands.length = 0;
      pendingProfileCommands.push(...queueTransition.pendingCommands);
      sequencedProfileCommands.length = 0;
      sequencedProfileCommands.push(...queueTransition.sequencedCommands);

      if (timeoutOutcome.kind === 'terminal') {
        for (const remainingCommand of queueTransition.skippedCommands) {
          if (!remainingCommand) {
            continue;
          }
          logProfileSession('command', {
            ...remainingCommand,
            status: 'skipped',
            reason: 'prior-command-failure',
            continuationReason: 'dependency-timeout-stop',
          });
          markProfileCommandIdProcessed(remainingCommand);
        }
        clearProfileCommandProcessingSchedule();
        persistPendingProfileCommands();
        processSequencedProfileCommands();
        return;
      }

      processSequencedProfileCommands();
    },
  });
}

function scheduleProfileCommandProcessing(waitMs = 0) {
  const scheduleToken = profileCommandScheduleController.captureNext();
  const availableAt = waitMs > 0 ? Date.now() + waitMs : 0;
  if (availableAt > profileCommandProcessingAvailableAt) {
    profileCommandProcessingAvailableAt = availableAt;
  }

  const delayMs = Math.max(0, profileCommandProcessingAvailableAt - Date.now());
  if (profileCommandProcessingTimeoutId) {
    clearTimeout(profileCommandProcessingTimeoutId);
    profileCommandProcessingTimeoutId = null;
  }

  profileCommandProcessingScheduled = true;
  const run = () => {
    if (!profileCommandScheduleController.isCurrent(scheduleToken)) {
      return;
    }
    profileCommandProcessingTimeoutId = null;
    const remainingMs = Math.max(0, profileCommandProcessingAvailableAt - Date.now());
    if (remainingMs > 0) {
      profileCommandProcessingScheduled = false;
      scheduleProfileCommandProcessing(remainingMs);
      return;
    }
    profileCommandProcessingAvailableAt = 0;
    profileCommandProcessingScheduled = false;
    const cadenceObservation = profileCommandCadenceObservation;
    profileCommandCadenceObservation = null;
    if (cadenceObservation) {
      logProfileCommandCadenceObservation(cadenceObservation, Date.now());
    }
    processSequencedProfileCommands();
  };

  if (delayMs > 0) {
    profileCommandProcessingTimeoutId = setTimeout(run, delayMs);
    return;
  }

  if (typeof queueMicrotask === 'function') {
    queueMicrotask(run);
    return;
  }

  Promise.resolve().then(run);
}

function notifyProfileCommandListeners(command: ProfileSessionCommand): ProfileCommandDispatchOutcome {
  const commandTimestamp = Number.isFinite(command.timestamp) ? command.timestamp : Date.now();
  if (shouldSkipProfileCommandForDuplicateWindow(command, commandTimestamp)) {
    logProfileSession('command', {
      ...command,
      status: 'skipped',
      reason: 'duplicate-command-window',
      stopOnFailure: resolveProfileCommandStopOnFailure(command.stopOnFailure),
    });
    return 'skipped';
  }

  lastProfileCommandSignature = getProfileCommandSignature(command);
  lastProfileCommandTimestamp = commandTimestamp;

  if (dispatchProfileCommand(command)) {
    return 'dispatched';
  }

  queuePendingProfileCommand(command);
  logProfileSession('command', {
    ...command,
    status: 'queued',
    reason: 'no-command-listener',
    stopOnFailure: resolveProfileCommandStopOnFailure(command.stopOnFailure),
  });
  return 'queued';
}

function processSequencedProfileCommands() {
  const remainingMs = Math.max(0, profileCommandProcessingAvailableAt - Date.now());
  const queueBlocker = resolveProfileCommandQueueBlocker({
    hasActiveGate: profileCommandMilestoneGate !== null,
    processingScheduled: profileCommandProcessingScheduled,
    remainingSettleMs: remainingMs,
  });
  switch (queueBlocker) {
    case 'remaining-settle':
      scheduleProfileCommandProcessing(remainingMs);
      return;
    case 'active-readiness-gate':
    case 'scheduled-settle':
      return;
    case null:
      break;
  }
  if (pendingProfileCommands.length > 0) {
    clearProfileCommandDependencyGate();
    flushPendingProfileCommands();
    return;
  }

  while (sequencedProfileCommands.length > 0) {
    const command = sequencedProfileCommands[0];
    if (!command || hasProcessedProfileCommandId(command)) {
      sequencedProfileCommands.shift();
      continue;
    }

    if (!hasObservedProfileCommandDependencies(command, observedProfileEvents)) {
      installProfileCommandDependencyGate(command);
      return;
    }
    clearProfileCommandDependencyGate();

    sequencedProfileCommands.shift();
    markProfileCommandIdProcessed(command);
    const nextGate = hasObservedProfileCommandMilestone(command, observedProfileEvents)
      ? null
      : buildProfileCommandMilestoneGate(command);
    const resolvedCommand = nextGate && (
      typeof command.waitTimeoutMs !== 'number' || command.waitTimeoutMs <= 0
    )
      ? { ...command, waitTimeoutMs: nextGate.waitTimeoutMs }
      : command;
    logProfileSession('command', {
      ...resolvedCommand,
      status: 'received',
      stopOnFailure: resolveProfileCommandStopOnFailure(resolvedCommand.stopOnFailure),
      ...(typeof resolvedCommand.waitMs === 'number' && resolvedCommand.waitMs > 0
        ? {
            minimumSettleMs: resolvedCommand.waitMs,
            plannedSettleMs: resolvedCommand.waitMs,
          }
        : {}),
      ...(typeof resolvedCommand.waitTimeoutMs === 'number' && resolvedCommand.waitTimeoutMs > 0
        ? { maxReadinessWaitMs: resolvedCommand.waitTimeoutMs }
        : {}),
    });
    const commandReleasedAtMs = Date.now();
    installProfileCommandWait(resolvedCommand, nextGate, commandReleasedAtMs);
    const dispatchOutcome = notifyProfileCommandListeners(resolvedCommand);

    if (dispatchOutcome === 'skipped') {
      clearProfileCommandMilestoneGate();
      continue;
    }

    if (dispatchOutcome === 'queued') {
      clearProfileCommandMilestoneGate();
      return;
    }

    if (nextGate) {
      return;
    }
    scheduleProfileCommandSettle(resolvedCommand, commandReleasedAtMs);
    return;
  }
}

function enqueueSequencedProfileCommands(commands: ProfileSessionCommand[]) {
  const nextCommands = commands.filter(shouldQueueProfileCommand);
  if (nextCommands.length > 0) {
    sequencedProfileCommands.push(...nextCommands);
    sequencedProfileCommands.sort(compareProfileCommands);
  }
  processSequencedProfileCommands();
}

function releaseProfileCommandMilestoneGate(eventPayload: StoredProfileEvent) {
  if (
    !profileCommandMilestoneGate ||
    !doesProfileEventReleaseCommandGate(profileCommandMilestoneGate, eventPayload)
  ) {
    return;
  }

  const readinessObservedAtMs = Date.now();
  const remainingSettleMs = resolveRemainingProfileCommandSettleMs(
    profileCommandMilestoneGate.waitMs,
    profileCommandMilestoneGate.commandReleasedAtMs,
    readinessObservedAtMs,
  );
  profileCommandCadenceObservation = {
    kind: 'readiness',
    command: profileCommandMilestoneGate.command,
    commandReleasedAtMs: profileCommandMilestoneGate.commandReleasedAtMs,
    readinessObservedAtMs,
  };
  clearProfileCommandMilestoneGate();
  scheduleProfileCommandProcessing(remainingSettleMs);
}

function releaseProfileCommandDependencyGate() {
  const command = sequencedProfileCommands[0];
  if (!command || !profileCommandDependencyController.release(command, observedProfileEvents)) {
    return;
  }
  processSequencedProfileCommands();
}

function flushPendingProfileCommands() {
  if (pendingProfileCommands.length === 0) {
    return;
  }

  const command = takeNextPendingProfileCommand();
  if (!command) {
    return;
  }

  const nextGate = hasObservedProfileCommandMilestone(command, observedProfileEvents)
    ? null
    : buildProfileCommandMilestoneGate(command);
  const commandReleasedAtMs = Date.now();
  installProfileCommandWait(command, nextGate, commandReleasedAtMs);
  if (!dispatchProfileCommand(command)) {
    clearProfileCommandMilestoneGate();
    restorePendingProfileCommand(command);
    return;
  }
  if (nextGate) {
    return;
  }
  scheduleProfileCommandSettle(command, commandReleasedAtMs);
}

function startProfileSessionInternal(
  nextState: ProfileSessionState,
  options?: { commandStoragePolicy?: ProfileCommandClearStoragePolicy },
) {
  profileSessionLifecycleController.invalidate();
  clearPendingProfileCommands(options?.commandStoragePolicy ?? 'remove-storage');
  clearProfileCommandDedupe();
  resetStoredProfileArtifacts();
  setProfileSessionState(nextState);
  logProfileSession('start', {
    scenario: nextState.scenario ?? 'unknown',
    runId: nextState.runId ?? 'unknown',
    startedAt: nextState.startedAt ?? Date.now(),
  });
}

function stopProfileSessionInternal() {
  profileSessionLifecycleController.invalidate();
  const previousState = profileSessionState;
  clearPendingProfileCommands();
  clearProfileCommandDedupe();
  setProfileSessionState(INITIAL_STATE);
  logProfileSession('stop', {
    scenario: previousState.scenario ?? 'unknown',
    runId: previousState.runId ?? 'unknown',
    stoppedAt: Date.now(),
  });
}

/**
 * Starts a profile session from app code or a parsed control URL.
 */
export function startProfileSession(params: { scenario: string; runId: string; startedAt?: number }): void {
  startProfileSessionInternal({
    active: true,
    scenario: params.scenario,
    runId: params.runId,
    startedAt: params.startedAt ?? Date.now(),
  });
}

/**
 * Stops the active profile session and clears pending runner commands.
 */
export function stopProfileSession(): void {
  stopProfileSessionInternal();
}

/**
 * Applies one profile-session deep link to the in-app control plane.
 */
export function applyProfileSessionUrl(url: string | null | undefined): boolean {
  if (!url) {
    return false;
  }

  const route = getProfileSessionRoute(url);
  if (!route) {
    return false;
  }

  if (route.action === 'command' && route.command) {
    const timestamp = Date.now();
    if (
      route.scenario &&
      route.runId &&
      (!profileSessionState.active ||
        profileSessionState.scenario !== route.scenario ||
        profileSessionState.runId !== route.runId)
    ) {
      startProfileSessionInternal({
        active: true,
        scenario: route.scenario,
        runId: route.runId,
        startedAt: timestamp,
      });
    }

    const command = {
      id: `${timestamp}-${route.scenario ?? 'profile'}-${route.command}`,
      scenario: route.scenario,
      runId: route.runId,
      command: route.command,
      ...(route.commandId ? { commandId: route.commandId } : {}),
      ...(Array.isArray(route.dependsOnMilestones) && route.dependsOnMilestones.length > 0
        ? { dependsOnMilestones: route.dependsOnMilestones }
        : {}),
      ...(route.queueId ? { queueId: route.queueId } : {}),
      ...(typeof route.sequence === 'number' ? { sequence: route.sequence } : {}),
      stopOnFailure: resolveProfileCommandStopOnFailure(route.stopOnFailure),
      source: 'deeplink' as const,
      timestamp,
      ...(route.waitForMilestone ? { waitForMilestone: route.waitForMilestone } : {}),
      ...(typeof route.waitMs === 'number' ? { waitMs: route.waitMs } : {}),
      ...(typeof route.waitTimeoutMs === 'number' ? { waitTimeoutMs: route.waitTimeoutMs } : {}),
    };
    enqueueSequencedProfileCommands([command]);
    return true;
  }

  if (route.action === 'start' && route.scenario && route.runId) {
    startProfileSession({
      scenario: route.scenario,
      runId: route.runId,
    });
    return true;
  }

  stopProfileSession();
  return true;
}

/**
 * Emits one app-owned truth event for the active profile session.
 */
export function emitProfileEvent(event: string, metadata?: ProfileEventMetadata): void {
  const session = profileSessionState;
  if (!session.active || !session.scenario || !session.runId) {
    return;
  }

  const timestamp = Date.now();
  const atMs = resolveProfileSessionElapsedAtMs(timestamp, metadata?.atMs, session.startedAt);

  const eventPayload: StoredProfileEvent = {
    scenario: session.scenario,
    runId: session.runId,
    event,
    timestamp,
    ...(atMs !== undefined ? { atMs } : {}),
    ...(metadata ?? {}),
    helperVersion: PROFILE_SESSION_HELPER_VERSION,
  };

  writeProfileLog(buildLogLine('profile-event', eventPayload));
  observedProfileEvents.push(eventPayload);
  while (observedProfileEvents.length > MAX_STORED_PROFILE_EVENTS) {
    observedProfileEvents.shift();
  }
  appendStoredProfileEvent(eventPayload);
  releaseProfileCommandDependencyGate();
  releaseProfileCommandMilestoneGate(eventPayload);
  scheduleProfileCommandProcessing();
}

/**
 * Stores one app-owned measurement signal for the active profile session.
 */
export function storeProfileSignal(
  kind: ProfileSignalKind,
  name: string,
  value: unknown,
  metadata?: ProfileSignalMetadata,
): boolean {
  const session = profileSessionState;
  if (!session.active || !session.scenario || !session.runId || !name) {
    return false;
  }

  queueProfileStorageMutation(async () => {
    const currentSignals = await readStoredJson<StoredProfileSignals>(PROFILE_SIGNAL_STORAGE_KEY, {
      js: {},
      memory: {},
      network: {},
    });
    const nextSignals: StoredProfileSignals = {
      ...currentSignals,
      [kind]: {
        ...(currentSignals[kind] ?? {}),
        [name]: {
          scenario: session.scenario,
          runId: session.runId,
          capturedAt: Date.now(),
          ...(metadata ?? {}),
          value,
        },
      },
    };
    await writeStoredJson(PROFILE_SIGNAL_STORAGE_KEY, nextSignals);
  });

  return true;
}

/**
 * Subscribes React components to the current profile session state.
 */
export function useProfileSession(): ProfileSessionState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => profileSessionState,
    () => profileSessionState,
  );
}

/**
 * Subscribes to runner commands delivered through profile-session deep links.
 */
export function subscribeToProfileCommands(listener: (command: ProfileSessionCommand) => void): () => void {
  profileCommandListeners.add(listener);
  processSequencedProfileCommands();
  return () => {
    profileCommandListeners.delete(listener);
  };
}

/**
 * Registers a named command target for `activate-target:<targetId>` commands.
 */
export function registerProfileCommandTargetHandler(
  targetId: string,
  handler: (command: ProfileSessionCommand) => void,
): () => void {
  profileCommandTargetHandlers.set(targetId, handler);
  processSequencedProfileCommands();
  return () => {
    const currentHandler = profileCommandTargetHandlers.get(targetId);
    if (currentHandler === handler) {
      profileCommandTargetHandlers.delete(targetId);
    }
  };
}

/**
 * Boots the profile-session deep-link and storage bridge near the app root.
 */
export function useProfileSessionBootstrap(): void {
  useEffect(() => {
    let isMounted = true;

    const syncStoredProfileState = async () => {
      let lifecycleGeneration = profileSessionLifecycleController.capture();
      const storedSessionRead = await readProfileSessionLifecycleValue({
        generation: lifecycleGeneration,
        isActive: () => isMounted,
        lifecycle: profileSessionLifecycleController,
        read: () => readStoredJson<ProfileSessionState | null>(PROFILE_SESSION_STORAGE_KEY, null),
      });
      if (!storedSessionRead.current) {
        return;
      }
      const storedSession = storedSessionRead.value;
      const storedCommandsRead = await readProfileSessionLifecycleValue({
        generation: lifecycleGeneration,
        isActive: () => isMounted,
        lifecycle: profileSessionLifecycleController,
        read: () => readStoredJson<ProfileSessionCommand[]>(PROFILE_COMMAND_STORAGE_KEY, []),
      });
      if (!storedCommandsRead.current) {
        return;
      }
      const storedCommands = storedCommandsRead.value;

      if (
        storedSession &&
        storedSession.active &&
        typeof storedSession.scenario === 'string' &&
        typeof storedSession.runId === 'string'
      ) {
        if (!isProfileSessionFresh(storedSession)) {
          stopProfileSessionInternal();
          return;
        }

        const shouldStartFromStorage =
          shouldApplyStoredProfileSession(storedSession) &&
          (!profileSessionState.active ||
            profileSessionState.scenario !== storedSession.scenario ||
            profileSessionState.runId !== storedSession.runId);

        if (shouldStartFromStorage) {
          startProfileSessionInternal(
            {
              active: true,
              scenario: storedSession.scenario,
              runId: storedSession.runId,
              startedAt:
                typeof storedSession.startedAt === 'number' ? storedSession.startedAt : Date.now(),
            },
            { commandStoragePolicy: 'preserve-storage' },
          );
          lifecycleGeneration = profileSessionLifecycleController.capture();
        }
      } else if (profileSessionState.active) {
        stopProfileSessionInternal();
        return;
      }

      if (!Array.isArray(storedCommands) || storedCommands.length === 0) {
        return;
      }

      const activeSession =
        storedSession &&
        storedSession.active &&
        typeof storedSession.scenario === 'string' &&
        typeof storedSession.runId === 'string'
          ? storedSession
          : null;
      if (!activeSession) {
        return;
      }

      const nextCommands: ProfileSessionCommand[] = [];
      for (const command of storedCommands) {
        if (
          !command ||
          typeof command.id !== 'string' ||
          typeof command.command !== 'string' ||
          typeof command.timestamp !== 'number'
        ) {
          continue;
        }

        if (
          command.scenario !== activeSession.scenario ||
          command.runId !== activeSession.runId
        ) {
          continue;
        }

        const storageCommand = {
          ...command,
          stopOnFailure: resolveProfileCommandStopOnFailure(command.stopOnFailure),
          source: 'storage' as const,
        };

        if (hasProcessedProfileCommandId(storageCommand)) {
          continue;
        }

        nextCommands.push(storageCommand);
      }

      if (
        !isMounted ||
        !profileSessionLifecycleController.isCurrent(lifecycleGeneration) ||
        profileSessionState.scenario !== activeSession.scenario ||
        profileSessionState.runId !== activeSession.runId
      ) {
        return;
      }
      enqueueSequencedProfileCommands(nextCommands);
    };

    runProfileSessionBootstrapSequence({
      applyInitialValue: applyProfileSessionUrl,
      isActive: () => isMounted,
      lifecycle: profileSessionLifecycleController,
      readInitialValue: () => Linking.getInitialURL(),
      synchronizeStorage: syncStoredProfileState,
    }).catch(() => {});

    const subscription = Linking.addEventListener('url', ({ url }) => {
      applyProfileSessionUrl(url);
    });

    const storagePollInterval = setInterval(() => {
      if (isMounted) {
        syncStoredProfileState().catch(() => {});
      }
    }, PROFILE_STORAGE_POLL_INTERVAL_MS);

    return () => {
      isMounted = false;
      profileSessionLifecycleController.invalidate();
      subscription.remove();
      clearInterval(storagePollInterval);
      suspendProfileCommandQueueForBootstrapUnmount();
    };
  }, []);
}
