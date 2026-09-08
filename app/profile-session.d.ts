export type ProfileSessionState = {
  active: boolean;
  scenario: string | null;
  runId: string | null;
  startedAt: number | null;
};

export type ProfileSessionStopResult =
  | { kind: 'already-stopped' }
  | { kind: 'rejected'; reason: 'owner-mismatch' }
  | { kind: 'stop-requested'; runId: string; scenario: string };

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
  unscopedMilestones?: string[];
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

export declare const PROFILE_SESSION_STORAGE_KEYS: Readonly<{
  command: string;
  event: string;
  session: string;
  sessionEntries: string;
  signal: string;
}>;

export const PROFILE_SESSION_HELPER_VERSION: '1.2.0';
export const PROFILE_SESSION_HELPER_PAYLOAD_ID: 'agent-scenario-loop/profile-session-helper@1.2.0+idempotent-owned-stop';
export const PROFILE_SESSION_HELPER_PAYLOAD_SHA256: '2ba19944de0d94271a27a99c4188e8567dce0d67b3e0df5ddb5f311108ce8178';

export function isProfileSessionFresh(
  session: Pick<ProfileSessionState, 'active' | 'startedAt'>,
  now?: number,
): boolean;

export function startProfileSession(params: { scenario: string; runId: string; startedAt?: number }): void;

/**
 * Stops a profile session.
 * The no-argument form is compatibility-only and stops the current active
 * in-process session; it does not identify the caller and can stop a newer
 * current session. Delayed, asynchronous, or out-of-band callers must retain
 * and pass `{ scenario, runId }`. Mismatched owners are rejected without
 * mutation; terminal replay is already-stopped.
 */
export function stopProfileSession(
  expectedOwner?: { runId: string; scenario: string },
): ProfileSessionStopResult;

export function applyProfileSessionUrl(url: string | null | undefined): boolean;

export function emitProfileEvent(event: string, metadata?: ProfileEventMetadata): void;

export function storeProfileSignal(
  kind: ProfileSignalKind,
  name: string,
  value: unknown,
  metadata?: ProfileSignalMetadata,
): boolean;

export function useProfileSession(): ProfileSessionState;

export function subscribeToProfileCommands(listener: (command: ProfileSessionCommand) => void): () => void;

export function registerProfileCommandTargetHandler(
  targetId: string,
  handler: (command: ProfileSessionCommand) => void,
): () => void;

export function useProfileSessionBootstrap(): void;
