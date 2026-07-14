export type ProfileSessionOrderedCommand = {
  id: string;
  commandId?: string;
  dependsOnMilestones?: string[];
  scenario?: string;
  runId?: string;
  queueId?: string;
  sequence?: number;
  stopOnFailure?: boolean;
  timestamp: number;
  waitForMilestone?: string;
  waitMs?: number;
  waitTimeoutMs?: number;
};

export type ProfileSessionObservedEvent = {
  scenario: string;
  runId: string;
  event: string;
  queueId?: string;
  sequence?: number;
  timestamp: number;
};

export type ProfileCommandMilestoneGate = {
  commandId?: string;
  id: string;
  milestone: string;
  queueId?: string;
  runId?: string;
  scenario?: string;
  sequence?: number;
  stopOnFailure?: boolean;
  waitMs?: number;
  waitTimeoutMs?: number;
};

export type ProfileCommandCadenceTelemetry = {
  actualWaitMs: number;
  maxReadinessWaitMs?: number;
  minimumSettleMs: number;
  readinessWaitMs: number;
  settleOverlapSavedMs: number;
  timeoutAvoided?: boolean;
};

export type ProfileCommandCadenceOutcome =
  | {
      kind: 'continue';
      reason:
        | 'minimum-settle-satisfied'
        | 'readiness-and-settle-satisfied'
        | 'readiness-released-before-settle-complete';
      remainingSettleMs: number;
      telemetry: ProfileCommandCadenceTelemetry;
    }
  | {
      kind: 'terminal' | 'continue';
      reason: 'milestone-timeout-stop' | 'milestone-timeout-continue';
      telemetry: ProfileCommandCadenceTelemetry;
    };

export type ProfileCommandPendingTransition<Command> = {
  command: Command | null;
  remainingCommands: Command[];
};

export type ProfileCommandTimeoutQueueTransition<Command> = {
  activeGateId: null;
  pendingCommands: Command[];
  sequencedCommands: Command[];
  skippedCommands: Command[];
};

export type ProfileCommandQueueBlocker =
  | 'active-readiness-gate'
  | 'remaining-settle'
  | 'scheduled-settle'
  | null;

export declare function resolveProfileCommandQueueBlocker(options: {
  hasActiveGate: boolean;
  processingScheduled: boolean;
  remainingSettleMs: number;
}): ProfileCommandQueueBlocker;

export declare function takeNextProfileCommand<Command>(
  commands: readonly Command[],
): ProfileCommandPendingTransition<Command>;

export declare function resolveProfileCommandTimeoutQueueTransition<Command>(options: {
  activeGateId: string;
  pendingCommands: readonly Command[];
  sequencedCommands: readonly Command[];
  stopOnFailure: boolean;
}): ProfileCommandTimeoutQueueTransition<Command>;

export declare function compareProfileCommands(
  left: ProfileSessionOrderedCommand,
  right: ProfileSessionOrderedCommand,
): number;

export declare function buildProfileCommandMilestoneGate(
  command: ProfileSessionOrderedCommand,
): ProfileCommandMilestoneGate | null;

export declare function resolveRemainingProfileCommandSettleMs(
  minimumSettleMs: number | undefined,
  commandReleasedAtMs: number,
  readinessObservedAtMs: number,
): number;

export declare function resolveProfileCommandCadenceOutcome(options: {
  minimumSettleMs: number | undefined;
  commandReleasedAtMs: number;
  readinessObservedAtMs: number;
  continuationObservedAtMs?: number;
  maxReadinessWaitMs?: number;
}): Extract<ProfileCommandCadenceOutcome, { kind: 'continue' }>;

export declare function resolveProfileCommandSettleOutcome(options: {
  minimumSettleMs: number | undefined;
  commandReleasedAtMs: number;
  continuationObservedAtMs: number;
}): Extract<ProfileCommandCadenceOutcome, { kind: 'continue' }>;

export declare function resolveProfileCommandMilestoneTimeoutOutcome(options: {
  commandReleasedAtMs: number;
  timeoutObservedAtMs: number;
  minimumSettleMs: number | undefined;
  maxReadinessWaitMs?: number;
  stopOnFailure?: boolean;
}): Extract<ProfileCommandCadenceOutcome, { reason: 'milestone-timeout-stop' | 'milestone-timeout-continue' }>;

export declare function doesProfileEventReleaseCommandGate(
  gate: ProfileCommandMilestoneGate,
  eventPayload: ProfileSessionObservedEvent,
): boolean;

export declare function hasObservedProfileCommandMilestone(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): boolean;

export declare function hasObservedProfileCommandDependencies(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): boolean;
