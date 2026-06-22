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

export declare function compareProfileCommands(
  left: ProfileSessionOrderedCommand,
  right: ProfileSessionOrderedCommand,
): number;

export declare function buildProfileCommandMilestoneGate(
  command: ProfileSessionOrderedCommand,
): ProfileCommandMilestoneGate | null;

export declare function doesProfileEventReleaseCommandGate(
  gate: ProfileCommandMilestoneGate,
  eventPayload: ProfileSessionObservedEvent,
): boolean;

export declare function hasObservedProfileCommandMilestone(
  command: ProfileSessionOrderedCommand,
  observedEvents: readonly ProfileSessionObservedEvent[],
): boolean;
