export type ProfileSessionOrderedCommand = {
  id: string;
  commandId?: string;
  dependsOnMilestones?: string[];
  scenario?: string;
  runId?: string;
  queueId?: string;
  sequence?: number;
  timestamp: number;
  waitForMilestone?: string;
  waitMs?: number;
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
  waitMs?: number;
};

export function compareProfileCommands(
  left: ProfileSessionOrderedCommand,
  right: ProfileSessionOrderedCommand,
): number {
  const leftSequence = typeof left.sequence === 'number' ? left.sequence : Number.POSITIVE_INFINITY;
  const rightSequence = typeof right.sequence === 'number' ? right.sequence : Number.POSITIVE_INFINITY;
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return left.timestamp - right.timestamp;
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
    ...(typeof command.waitMs === 'number' && command.waitMs > 0 ? { waitMs: command.waitMs } : {}),
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

function optionalStringScopeMatches(expected: string | undefined, actual: string | undefined): boolean {
  return typeof expected !== 'string' || typeof actual !== 'string' || expected === actual;
}

function optionalNumberScopeMatches(expected: number | undefined, actual: number | undefined): boolean {
  return typeof expected !== 'number' || typeof actual !== 'number' || expected === actual;
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

function doesProfileEventMatchCommandDependency(
  command: ProfileSessionOrderedCommand,
  eventPayload: ProfileSessionObservedEvent,
): boolean {
  return (
    optionalStringScopeMatches(command.runId, eventPayload.runId) &&
    optionalStringScopeMatches(command.scenario, eventPayload.scenario) &&
    optionalStringScopeMatches(command.queueId, eventPayload.queueId)
  );
}

export function hasObservedProfileCommandDependencies(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): boolean {
  const dependencies = readProfileCommandDependencies(command);
  if (dependencies.length === 0) {
    return true;
  }

  return dependencies.every((milestone) => (
    observedEvents.some((eventPayload) => (
      eventPayload.event === milestone &&
      doesProfileEventMatchCommandDependency(command, eventPayload)
    ))
  ));
}
