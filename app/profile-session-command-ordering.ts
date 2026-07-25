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

export type ProfileCommandDependencyGate = {
  commandId?: string;
  commandTimestamp: number;
  id: string;
  missingDependencies: string[];
  queueId?: string;
  runId?: string;
  scenario?: string;
  sequence?: number;
  stopOnFailure?: boolean;
  waitTimeoutMs: number;
};

export type ProfileCommandDependencyTimeoutOutcome = {
  kind: 'terminal' | 'continue';
  reason: 'dependency-timeout-stop' | 'dependency-timeout-continue';
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

const DEFAULT_PROFILE_COMMAND_MILESTONE_TIMEOUT_MS = 30000;

export function resolveProfileCommandWaitTimeoutMs(waitTimeoutMs: unknown): number {
  return typeof waitTimeoutMs === 'number' && Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0
    ? waitTimeoutMs
    : DEFAULT_PROFILE_COMMAND_MILESTONE_TIMEOUT_MS;
}

export function resolveProfileCommandQueueBlocker(options: {
  hasActiveGate: boolean;
  processingScheduled: boolean;
  remainingSettleMs: number;
}): ProfileCommandQueueBlocker {
  if (options.processingScheduled) {
    return 'scheduled-settle';
  }
  if (options.remainingSettleMs > 0) {
    return 'remaining-settle';
  }
  return options.hasActiveGate ? 'active-readiness-gate' : null;
}

export function takeNextProfileCommand<Command>(
  commands: readonly Command[],
): ProfileCommandPendingTransition<Command> {
  const command = commands[0] ?? null;
  return {
    command,
    remainingCommands: command ? commands.slice(1) : [],
  };
}

export function resolveProfileCommandTimeoutQueueTransition<Command>(options: {
  activeGateId: string;
  pendingCommands: readonly Command[];
  sequencedCommands: readonly Command[];
  stopOnFailure: boolean;
}): ProfileCommandTimeoutQueueTransition<Command> {
  if (!options.stopOnFailure) {
    return {
      activeGateId: null,
      pendingCommands: [...options.pendingCommands],
      sequencedCommands: [...options.sequencedCommands],
      skippedCommands: [],
    };
  }

  return {
    activeGateId: null,
    pendingCommands: [],
    sequencedCommands: [],
    skippedCommands: [...options.pendingCommands, ...options.sequencedCommands],
  };
}

export function compareProfileCommands(
  left: ProfileSessionOrderedCommand,
  right: ProfileSessionOrderedCommand,
): number {
  const leftSequence = typeof left.sequence === 'number' ? left.sequence : Number.POSITIVE_INFINITY;
  const rightSequence = typeof right.sequence === 'number' ? right.sequence : Number.POSITIVE_INFINITY;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

export function buildProfileCommandMilestoneGate(
  command: ProfileSessionOrderedCommand,
): ProfileCommandMilestoneGate | null {
  if (typeof command.waitForMilestone !== 'string' || command.waitForMilestone.length === 0) {
    return null;
  }

  return {
    id: command.id,
    milestone: command.waitForMilestone,
    ...(typeof command.commandId === 'string' ? { commandId: command.commandId } : {}),
    ...(typeof command.queueId === 'string' ? { queueId: command.queueId } : {}),
    ...(typeof command.runId === 'string' ? { runId: command.runId } : {}),
    ...(typeof command.scenario === 'string' ? { scenario: command.scenario } : {}),
    ...(typeof command.sequence === 'number' ? { sequence: command.sequence } : {}),
    ...(typeof command.stopOnFailure === 'boolean' ? { stopOnFailure: command.stopOnFailure } : {}),
    ...(typeof command.waitMs === 'number' && command.waitMs > 0 ? { waitMs: command.waitMs } : {}),
    waitTimeoutMs: resolveProfileCommandWaitTimeoutMs(command.waitTimeoutMs),
  };
}

/**
 * Resolves the cadence still owed after a readiness milestone arrives.
 *
 * Cadence is a minimum settle window measured from command release. Readiness
 * and cadence therefore overlap instead of becoming two consecutive waits.
 */
export function resolveRemainingProfileCommandSettleMs(
  minimumSettleMs: number | undefined,
  commandReleasedAtMs: number,
  readinessObservedAtMs: number,
): number {
  if (
    typeof minimumSettleMs !== 'number' ||
    !Number.isFinite(minimumSettleMs) ||
    minimumSettleMs <= 0
  ) {
    return 0;
  }

  if (!Number.isFinite(commandReleasedAtMs) || !Number.isFinite(readinessObservedAtMs)) {
    return minimumSettleMs;
  }

  const readinessWaitMs = Math.max(0, readinessObservedAtMs - commandReleasedAtMs);
  return Math.max(0, minimumSettleMs - readinessWaitMs);
}

export function resolveProfileCommandCadenceOutcome({
  minimumSettleMs,
  commandReleasedAtMs,
  readinessObservedAtMs,
  continuationObservedAtMs,
  maxReadinessWaitMs,
}: {
  minimumSettleMs: number | undefined;
  commandReleasedAtMs: number;
  readinessObservedAtMs: number;
  continuationObservedAtMs?: number;
  maxReadinessWaitMs?: number;
}): Extract<ProfileCommandCadenceOutcome, { kind: 'continue' }> {
  const minimumSettle = (
    typeof minimumSettleMs === 'number' &&
    Number.isFinite(minimumSettleMs) &&
    minimumSettleMs > 0
  ) ? minimumSettleMs : 0;
  const readinessWaitMs = (
    Number.isFinite(commandReleasedAtMs) &&
    Number.isFinite(readinessObservedAtMs)
  )
    ? Math.max(0, readinessObservedAtMs - commandReleasedAtMs)
    : 0;
  const remainingSettleMs = Math.max(0, minimumSettle - readinessWaitMs);
  const minimumContinuationAtMs = commandReleasedAtMs + readinessWaitMs + remainingSettleMs;
  const actualWaitMs = (
    typeof continuationObservedAtMs === 'number' &&
    Number.isFinite(continuationObservedAtMs) &&
    Number.isFinite(commandReleasedAtMs)
  )
    ? Math.max(0, continuationObservedAtMs - commandReleasedAtMs)
    : Math.max(0, minimumContinuationAtMs - commandReleasedAtMs);
  const settleOverlapSavedMs = Math.min(minimumSettle, readinessWaitMs);
  const timeoutLimitMs = (
    typeof maxReadinessWaitMs === 'number' &&
    Number.isFinite(maxReadinessWaitMs) &&
    maxReadinessWaitMs > 0
  ) ? maxReadinessWaitMs : undefined;

  return {
    kind: 'continue',
    reason: remainingSettleMs > 0
      ? 'readiness-released-before-settle-complete'
      : 'readiness-and-settle-satisfied',
    remainingSettleMs,
    telemetry: {
      actualWaitMs,
      minimumSettleMs: minimumSettle,
      readinessWaitMs,
      settleOverlapSavedMs,
      ...(typeof timeoutLimitMs === 'number'
        ? {
            maxReadinessWaitMs: timeoutLimitMs,
            timeoutAvoided: readinessWaitMs <= timeoutLimitMs,
          }
        : {}),
    },
  };
}

export function resolveProfileCommandSettleOutcome({
  minimumSettleMs,
  commandReleasedAtMs,
  continuationObservedAtMs,
}: {
  minimumSettleMs: number | undefined;
  commandReleasedAtMs: number;
  continuationObservedAtMs: number;
}): Extract<ProfileCommandCadenceOutcome, { kind: 'continue' }> {
  const minimumSettle = (
    typeof minimumSettleMs === 'number' &&
    Number.isFinite(minimumSettleMs) &&
    minimumSettleMs > 0
  ) ? minimumSettleMs : 0;
  const actualWaitMs = (
    Number.isFinite(commandReleasedAtMs) &&
    Number.isFinite(continuationObservedAtMs)
  )
    ? Math.max(0, continuationObservedAtMs - commandReleasedAtMs)
    : minimumSettle;

  return {
    kind: 'continue',
    reason: 'minimum-settle-satisfied',
    remainingSettleMs: 0,
    telemetry: {
      actualWaitMs,
      minimumSettleMs: minimumSettle,
      readinessWaitMs: 0,
      settleOverlapSavedMs: 0,
    },
  };
}

export function resolveProfileCommandMilestoneTimeoutOutcome({
  commandReleasedAtMs,
  timeoutObservedAtMs,
  minimumSettleMs,
  maxReadinessWaitMs,
  stopOnFailure,
}: {
  commandReleasedAtMs: number;
  timeoutObservedAtMs: number;
  minimumSettleMs: number | undefined;
  maxReadinessWaitMs?: number;
  stopOnFailure?: boolean;
}): Extract<ProfileCommandCadenceOutcome, { reason: 'milestone-timeout-stop' | 'milestone-timeout-continue' }> {
  const minimumSettle = (
    typeof minimumSettleMs === 'number' &&
    Number.isFinite(minimumSettleMs) &&
    minimumSettleMs > 0
  ) ? minimumSettleMs : 0;
  const timeoutLimitMs = (
    typeof maxReadinessWaitMs === 'number' &&
    Number.isFinite(maxReadinessWaitMs) &&
    maxReadinessWaitMs > 0
  ) ? maxReadinessWaitMs : DEFAULT_PROFILE_COMMAND_MILESTONE_TIMEOUT_MS;
  const readinessWaitMs = (
    Number.isFinite(commandReleasedAtMs) &&
    Number.isFinite(timeoutObservedAtMs)
  )
    ? Math.max(0, timeoutObservedAtMs - commandReleasedAtMs)
    : timeoutLimitMs;

  return {
    kind: stopOnFailure === false ? 'continue' : 'terminal',
    reason: stopOnFailure === false ? 'milestone-timeout-continue' : 'milestone-timeout-stop',
    telemetry: {
      actualWaitMs: readinessWaitMs,
      maxReadinessWaitMs: timeoutLimitMs,
      minimumSettleMs: minimumSettle,
      readinessWaitMs,
      settleOverlapSavedMs: Math.min(minimumSettle, readinessWaitMs),
      timeoutAvoided: false,
    },
  };
}

function optionalStringScopeMatches(expected: string | undefined, actual: string | undefined): boolean {
  return typeof expected !== 'string' || expected === actual;
}

function optionalNumberScopeMatches(expected: number | undefined, actual: number | undefined): boolean {
  return typeof expected !== 'number' || expected === actual;
}

function optionalQueueIdentityMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected === actual;
}

function doesProfileEventMatchCommandScope(
  command: ProfileCommandMilestoneGate | ProfileSessionOrderedCommand,
  eventPayload: ProfileSessionObservedEvent,
): boolean {
  return (
    optionalStringScopeMatches(command.runId, eventPayload.runId) &&
    optionalStringScopeMatches(command.scenario, eventPayload.scenario) &&
    optionalStringScopeMatches(command.queueId, eventPayload.queueId) &&
    optionalNumberScopeMatches(command.sequence, eventPayload.sequence)
  );
}

export function doesProfileEventReleaseCommandGate(
  gate: ProfileCommandMilestoneGate,
  eventPayload: ProfileSessionObservedEvent,
): boolean {
  if (gate.milestone !== eventPayload.event) {
    return false;
  }
  return doesProfileEventMatchCommandScope(gate, eventPayload);
}

export function hasObservedProfileCommandMilestone(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): boolean {
  if (typeof command.waitForMilestone !== 'string' || command.waitForMilestone.length === 0) {
    return false;
  }
  if (typeof command.sequence === 'number' && command.sequence > 1) {
    return false;
  }

  return observedEvents.some((eventPayload) => (
    eventPayload.event === command.waitForMilestone &&
    doesProfileEventMatchCommandScope(command, eventPayload)
  ));
}

function readProfileCommandDependencies(command: ProfileSessionOrderedCommand): string[] {
  if (!Array.isArray(command.dependsOnMilestones)) {
    return [];
  }

  return command.dependsOnMilestones.filter((milestone) => (
    typeof milestone === 'string' && milestone.length > 0
  ));
}

export function resolveMissingProfileCommandDependencies(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): string[] {
  return readProfileCommandDependencies(command).filter((milestone) => (
    !observedEvents.some((eventPayload) => (
      eventPayload.event === milestone &&
      doesProfileEventMatchCommandDependency(command, eventPayload)
    ))
  ));
}

export function buildProfileCommandDependencyGate(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): ProfileCommandDependencyGate | null {
  const missingDependencies = resolveMissingProfileCommandDependencies(command, observedEvents);
  if (missingDependencies.length === 0) {
    return null;
  }

  return {
    id: command.id,
    commandTimestamp: command.timestamp,
    missingDependencies,
    ...(typeof command.commandId === 'string' ? { commandId: command.commandId } : {}),
    ...(typeof command.queueId === 'string' ? { queueId: command.queueId } : {}),
    ...(typeof command.runId === 'string' ? { runId: command.runId } : {}),
    ...(typeof command.scenario === 'string' ? { scenario: command.scenario } : {}),
    ...(typeof command.sequence === 'number' ? { sequence: command.sequence } : {}),
    ...(typeof command.stopOnFailure === 'boolean' ? { stopOnFailure: command.stopOnFailure } : {}),
    waitTimeoutMs: resolveProfileCommandWaitTimeoutMs(command.waitTimeoutMs),
  };
}

export function doesProfileCommandMatchDependencyGate(
  gate: ProfileCommandDependencyGate,
  command: ProfileSessionOrderedCommand,
): boolean {
  return gate.id === command.id &&
    gate.commandTimestamp === command.timestamp &&
    gate.commandId === command.commandId &&
    gate.runId === command.runId &&
    gate.scenario === command.scenario &&
    gate.queueId === command.queueId &&
    gate.sequence === command.sequence;
}

export function resolveProfileCommandDependencyTimeoutOutcome(
  stopOnFailure: boolean | undefined,
): ProfileCommandDependencyTimeoutOutcome {
  return stopOnFailure === false
    ? { kind: 'continue', reason: 'dependency-timeout-continue' }
    : { kind: 'terminal', reason: 'dependency-timeout-stop' };
}

function doesProfileEventMatchCommandDependency(
  command: ProfileSessionOrderedCommand,
  eventPayload: ProfileSessionObservedEvent,
): boolean {
  return (
    optionalStringScopeMatches(command.runId, eventPayload.runId) &&
    optionalStringScopeMatches(command.scenario, eventPayload.scenario) &&
    optionalQueueIdentityMatches(command.queueId, eventPayload.queueId)
  );
}

export function hasObservedProfileCommandDependencies(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): boolean {
  return resolveMissingProfileCommandDependencies(command, observedEvents).length === 0;
}
