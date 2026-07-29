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

export const PROFILE_SESSION_HELPER_VERSION: '1.1.0';
export const PROFILE_SESSION_HELPER_PAYLOAD_ID: 'agent-scenario-loop/profile-session-helper@1.1.0+setup-unscoped-milestones';
export const PROFILE_SESSION_HELPER_PAYLOAD_SHA256: 'b7421a84e8e39346702af2e7017a99ba492ced00de47446780e42a93146db275';

export function isProfileSessionFresh(
  session: Pick<ProfileSessionState, 'active' | 'startedAt'>,
  now?: number,
): boolean;

export function startProfileSession(params: { scenario: string; runId: string; startedAt?: number }): void;

export function stopProfileSession(): void;

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
