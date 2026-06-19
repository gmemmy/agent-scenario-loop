import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';
import { Linking, NativeModules, Platform } from 'react-native';
import * as ExpoLinking from 'expo-linking';

export type ProfileSessionState = {
  active: boolean;
  scenario: string | null;
  runId: string | null;
  startedAt: number | null;
};

export type ProfileSessionCommand = {
  id: string;
  scenario?: string;
  runId?: string;
  command: string;
  queueId?: string;
  sequence?: number;
  source?: 'deeplink' | 'storage';
  timestamp: number;
  waitForMilestone?: string;
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

type ProfileEventMetadata = {
  flowId?: string;
  owner?: string;
  phase?: ProfileEventPhase;
  status?: ProfileEventStatus;
  route?: string;
  atMs?: number;
  [key: string]: unknown;
};

type ProfileSignalMetadata = {
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
  startedAt?: number;
  stoppedAt?: number;
  command?: string;
  id?: string;
};

type StoredProfileSignals = Record<ProfileSignalKind, Record<string, unknown>>;

const INITIAL_STATE: ProfileSessionState = {
  active: false,
  scenario: null,
  runId: null,
  startedAt: null,
};

const STORAGE_PREFIX = 'agent-scenario-loop';
const PROFILE_STORAGE_SCHEMA = '1';
const PROFILE_EVENT_STORAGE_KEY = `${STORAGE_PREFIX}.profile-events.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_SIGNAL_STORAGE_KEY = `${STORAGE_PREFIX}.profile-signals.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_SESSION_STORAGE_KEY = `${STORAGE_PREFIX}.profile-session.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_COMMAND_STORAGE_KEY = `${STORAGE_PREFIX}.profile-commands.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_SESSION_ENTRIES_STORAGE_KEY = `${STORAGE_PREFIX}.profile-session-entries.${PROFILE_STORAGE_SCHEMA}`;
const PROFILE_STORAGE_POLL_INTERVAL_MS = 350;
const PROFILE_SESSION_MAX_AGE_MS = 2 * 60 * 60_000;
const PROFILE_COMMAND_DUPLICATE_WINDOW_MS = 750;
const PROCESSED_PROFILE_COMMAND_ID_LIMIT = 120;
const MAX_STORED_PROFILE_EVENTS = 300;
const MAX_STORED_PROFILE_SESSION_ENTRIES = 120;

let profileSessionState: ProfileSessionState = INITIAL_STATE;
let profileStorageWriteChain = Promise.resolve();
const listeners = new Set<() => void>();
const profileCommandListeners = new Set<(command: ProfileSessionCommand) => void>();
const profileCommandTargetHandlers = new Map<string, () => void>();
const pendingProfileCommands: ProfileSessionCommand[] = [];
const processedProfileCommandIds = new Set<string>();
let lastProfileCommandSignature: string | null = null;
let lastProfileCommandTimestamp = 0;

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
  queueProfileStorageMutation(async () => {
    await Promise.all([
      AsyncStorage.removeItem(PROFILE_EVENT_STORAGE_KEY),
      AsyncStorage.removeItem(PROFILE_SIGNAL_STORAGE_KEY),
      AsyncStorage.removeItem(PROFILE_SESSION_ENTRIES_STORAGE_KEY),
    ]);
  });
}

function clearPendingProfileCommands() {
  pendingProfileCommands.length = 0;
  queueProfileStorageMutation(async () => {
    await AsyncStorage.removeItem(PROFILE_COMMAND_STORAGE_KEY);
  });
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
  return typeof session?.startedAt === 'number' && Number.isFinite(session.startedAt)
    ? session.startedAt
    : null;
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
  writeProfileLog(buildLogLine('profile-session', { kind, ...payload }));

  const scenario = typeof payload.scenario === 'string' ? payload.scenario : null;
  const runId = typeof payload.runId === 'string' ? payload.runId : null;
  if (!scenario || !runId) {
    return;
  }

  const timestamp = Date.now();
  const entry: StoredProfileSessionEntry = {
    kind,
    scenario,
    runId,
    timestamp,
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
  }

  appendStoredProfileSessionEntry(entry);
}

function getProfileSessionRoute(url: string): {
  action: 'start' | 'stop' | 'command';
  scenario?: string;
  runId?: string;
  command?: string;
  queueId?: string;
  sequence?: number;
  waitForMilestone?: string;
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

  return { action, scenario, runId, command, queueId, sequence, waitForMilestone, waitTimeoutMs };
}

function queuePendingProfileCommand(command: ProfileSessionCommand) {
  pendingProfileCommands.push(command);
  queueProfileStorageMutation(async () => {
    await writeStoredJson(PROFILE_COMMAND_STORAGE_KEY, pendingProfileCommands);
  });
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

  handler();
  return true;
}

/**
 * Builds a stable key for duplicate command suppression across delivery lanes.
 */
function getProfileCommandSignature(command: ProfileSessionCommand): string {
  return [
    command.scenario ?? '',
    command.runId ?? '',
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

function notifyProfileCommandListeners(command: ProfileSessionCommand) {
  const commandTimestamp = Number.isFinite(command.timestamp) ? command.timestamp : Date.now();
  if (shouldSkipProfileCommandForDuplicateWindow(command, commandTimestamp)) {
    logProfileSession('command', {
      ...command,
      status: 'skipped',
      reason: 'duplicate-command-window',
    });
    return;
  }

  lastProfileCommandSignature = getProfileCommandSignature(command);
  lastProfileCommandTimestamp = commandTimestamp;

  const targetDispatched = dispatchProfileCommandTarget(command);
  if (targetDispatched) {
    return;
  }

  if (profileCommandListeners.size === 0) {
    queuePendingProfileCommand(command);
    return;
  }

  for (const listener of profileCommandListeners) {
    listener(command);
  }
}

function flushPendingProfileCommands(listener: (command: ProfileSessionCommand) => void) {
  if (pendingProfileCommands.length === 0) {
    return;
  }

  const queuedCommands = [...pendingProfileCommands];
  clearPendingProfileCommands();

  for (const command of queuedCommands) {
    listener(command);
  }
}

function startProfileSessionInternal(nextState: ProfileSessionState) {
  clearPendingProfileCommands();
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
      setProfileSessionState({
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
      ...(route.queueId ? { queueId: route.queueId } : {}),
      ...(typeof route.sequence === 'number' ? { sequence: route.sequence } : {}),
      source: 'deeplink' as const,
      timestamp,
      ...(route.waitForMilestone ? { waitForMilestone: route.waitForMilestone } : {}),
      ...(typeof route.waitTimeoutMs === 'number' ? { waitTimeoutMs: route.waitTimeoutMs } : {}),
    };
    logProfileSession('command', command);
    notifyProfileCommandListeners(command);
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
  const atMs =
    typeof metadata?.atMs === 'number' && Number.isFinite(metadata.atMs)
      ? metadata.atMs
      : typeof session.startedAt === 'number' && Number.isFinite(session.startedAt)
        ? Math.max(0, timestamp - session.startedAt)
        : undefined;

  const eventPayload: StoredProfileEvent = {
    scenario: session.scenario,
    runId: session.runId,
    event,
    timestamp,
    ...(atMs !== undefined ? { atMs } : {}),
    ...(metadata ?? {}),
  };

  writeProfileLog(buildLogLine('profile-event', eventPayload));
  appendStoredProfileEvent(eventPayload);
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
  flushPendingProfileCommands(listener);
  return () => {
    profileCommandListeners.delete(listener);
  };
}

/**
 * Registers a named command target for `activate-target:<targetId>` commands.
 */
export function registerProfileCommandTargetHandler(targetId: string, handler: () => void): () => void {
  profileCommandTargetHandlers.set(targetId, handler);
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
      const [storedSession, storedCommands] = await Promise.all([
        readStoredJson<ProfileSessionState | null>(PROFILE_SESSION_STORAGE_KEY, null),
        readStoredJson<ProfileSessionCommand[]>(PROFILE_COMMAND_STORAGE_KEY, []),
      ]);

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
          startProfileSessionInternal({
            active: true,
            scenario: storedSession.scenario,
            runId: storedSession.runId,
            startedAt:
              typeof storedSession.startedAt === 'number' ? storedSession.startedAt : Date.now(),
          });
        }
      } else if (profileSessionState.active) {
        stopProfileSessionInternal();
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

      clearPendingProfileCommands();
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
          command.runId !== activeSession.runId ||
          (typeof activeSession.startedAt === 'number' && command.timestamp < activeSession.startedAt)
        ) {
          continue;
        }

        const storageCommand = {
          ...command,
          source: 'storage' as const,
        };

        if (hasProcessedProfileCommandId(storageCommand)) {
          continue;
        }

        markProfileCommandIdProcessed(storageCommand);
        logProfileSession('command', storageCommand);
        notifyProfileCommandListeners(storageCommand);
      }
    };

    syncStoredProfileState()
      .catch(() => {})
      .finally(() => {
        Linking.getInitialURL()
          .then((url) => {
            if (isMounted) {
              applyProfileSessionUrl(url);
            }
          })
          .catch(() => {});
      });

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
      subscription.remove();
      clearInterval(storagePollInterval);
    };
  }, []);
}
