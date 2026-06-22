export type ProfileSessionOrderedCommand = {
  id: string;
  commandId?: string;
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

export function doesProfileEventReleaseCommandGate(
  gate: ProfileCommandMilestoneGate,
  eventPayload: ProfileSessionObservedEvent,
): boolean {
  if (gate.milestone !== eventPayload.event) {
    return false;
  }
  if (gate.runId && gate.runId !== eventPayload.runId) {
    return false;
  }
  if (gate.scenario && gate.scenario !== eventPayload.scenario) {
    return false;
  }

  return true;
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
    (!command.runId || eventPayload.runId === command.runId) &&
    (!command.scenario || eventPayload.scenario === command.scenario)
  ));
}
