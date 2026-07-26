import {
  buildProfileCommandDependencyGate,
  compareProfileCommands,
  doesProfileCommandMatchDependencyGate,
  type ProfileCommandDependencyGate,
  type ProfileSessionObservedEvent,
  type ProfileSessionOrderedCommand,
} from './profile-session-command-ordering';

type DependencyTimeoutHandle = unknown;

type ActiveDependencyGate<Command extends ProfileSessionOrderedCommand> = {
  command: Command;
  deadlineAtMs: number;
  gate: ProfileCommandDependencyGate;
  timeoutHandle: DependencyTimeoutHandle | null;
  token: object;
};

export type ProfileCommandDependencyController<Command extends ProfileSessionOrderedCommand> = {
  clear: () => void;
  getGate: () => ProfileCommandDependencyGate | null;
  install: (options: {
    command: Command;
    observedEvents: readonly ProfileSessionObservedEvent[];
    onTimeout: (gate: ProfileCommandDependencyGate) => void;
  }) => ProfileCommandDependencyGate | null;
  release: (
    command: Command,
    observedEvents: readonly ProfileSessionObservedEvent[],
  ) => boolean;
  suspend: () => void;
};

export type ProfileSessionDependencyMilestoneFacts = {
  observe: (event: ProfileSessionObservedEvent) => void;
  reset: () => void;
  snapshot: () => readonly ProfileSessionObservedEvent[];
};

export type ProfileSessionProcessedCommandIds = {
  has: (id: string) => boolean;
  mark: (id: string) => void;
  reset: () => void;
};

export type RecoveredProfileCommandLifecycle = {
  delivered: Map<string, number>;
  terminal: Set<string>;
};

export type ProfileSessionLifecycleController = {
  capture: () => number;
  invalidate: () => number;
  isCurrent: (generation: number) => boolean;
};

export type ProfileCommandScheduleToken = {
  lifecycleGeneration: number;
  scheduleGeneration: number;
};

export type ProfileCommandScheduleController = {
  captureNext: () => ProfileCommandScheduleToken;
  invalidate: () => void;
  isCurrent: (token: ProfileCommandScheduleToken) => boolean;
};

function dependencyMilestoneFactKey(event: ProfileSessionObservedEvent): string {
  return JSON.stringify([
    event.scenario,
    event.runId,
    event.queueId ?? null,
    event.sequence ?? null,
    event.event,
  ]);
}

/**
 * Retains one compact fact per session-owned milestone identity.
 *
 * The set is intentionally not evicted within an active session: an arbitrary
 * fact cap would reintroduce the dependency correctness loss this index avoids.
 * Growth follows unique scenario/run/queue/milestone vocabulary, not raw event
 * volume, and the whole set is reset at the logical session boundary.
 */
export function createProfileSessionDependencyMilestoneFacts(): ProfileSessionDependencyMilestoneFacts {
  const facts = new Map<string, ProfileSessionObservedEvent>();

  return {
    observe: (event) => {
      const key = dependencyMilestoneFactKey(event);
      if (facts.has(key)) {
        return;
      }
      facts.set(key, {
        event: event.event,
        runId: event.runId,
        scenario: event.scenario,
        timestamp: event.timestamp,
        ...(typeof event.queueId === 'string' ? { queueId: event.queueId } : {}),
        ...(typeof event.sequence === 'number' ? { sequence: event.sequence } : {}),
      });
    },
    reset: () => {
      facts.clear();
    },
    snapshot: () => [...facts.values()],
  };
}

export function appendBoundedProfileEventHistory<Event>(
  history: Event[],
  event: Event,
  limit: number,
): void {
  history.push(event);
  while (history.length > limit) {
    history.shift();
  }
}

export function appendCompleteProfileSessionHistory<Entry>(history: Entry[], entry: Entry): void {
  history.push(entry);
}

export function createProfileSessionProcessedCommandIds(): ProfileSessionProcessedCommandIds {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    mark: (id) => {
      ids.add(id);
    },
    reset: () => {
      ids.clear();
    },
  };
}

/**
 * Reconstructs the durable command boundary after a module reload.
 *
 * A received-only command remains replayable because dispatch may not have
 * happened. A delivered command resumes only its pending wait/settle phase,
 * while completed and skipped commands are terminal.
 */
export function recoverProfileCommandLifecycle(
  entries: readonly {
    id?: string;
    status?: 'received' | 'queued' | 'delivered' | 'completed' | 'skipped';
    timestamp: number;
  }[],
): RecoveredProfileCommandLifecycle {
  const delivered = new Map<string, number>();
  const terminal = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      continue;
    }
    if (entry.status === 'delivered' && !terminal.has(entry.id)) {
      delivered.set(entry.id, entry.timestamp);
      continue;
    }
    if (entry.status === 'completed' || entry.status === 'skipped') {
      terminal.add(entry.id);
      delivered.delete(entry.id);
    }
  }
  return { delivered, terminal };
}

export function createProfileSessionLifecycleController(): ProfileSessionLifecycleController {
  let generation = 0;
  return {
    capture: () => generation,
    invalidate: () => {
      generation += 1;
      return generation;
    },
    isCurrent: (candidate) => candidate === generation,
  };
}

export function createProfileCommandScheduleController(
  lifecycle: ProfileSessionLifecycleController,
): ProfileCommandScheduleController {
  let scheduleGeneration = 0;
  return {
    captureNext: () => ({
      lifecycleGeneration: lifecycle.capture(),
      scheduleGeneration: ++scheduleGeneration,
    }),
    invalidate: () => {
      scheduleGeneration += 1;
    },
    isCurrent: (token) => (
      lifecycle.isCurrent(token.lifecycleGeneration) &&
      token.scheduleGeneration === scheduleGeneration
    ),
  };
}

export async function readProfileSessionLifecycleValue<Value>({
  generation,
  isActive,
  lifecycle,
  read,
}: {
  generation: number;
  isActive: () => boolean;
  lifecycle: ProfileSessionLifecycleController;
  read: () => Promise<Value>;
}): Promise<{ current: true; value: Value } | { current: false }> {
  const value = await read();
  if (!isActive() || !lifecycle.isCurrent(generation)) {
    return { current: false };
  }
  return { current: true, value };
}

export async function applyProfileSessionLifecycleValue<Value>({
  apply,
  isActive,
  lifecycle,
  read,
}: {
  apply: (value: Value) => void;
  isActive: () => boolean;
  lifecycle: ProfileSessionLifecycleController;
  read: () => Promise<Value>;
}): Promise<boolean> {
  const generation = lifecycle.capture();
  const result = await readProfileSessionLifecycleValue({
    generation,
    isActive,
    lifecycle,
    read,
  });
  if (!result.current) {
    return false;
  }
  apply(result.value);
  return true;
}

export async function runProfileSessionBootstrapSequence<Value>({
  applyInitialValue,
  isActive,
  lifecycle,
  readInitialValue,
  synchronizeStorage,
}: {
  applyInitialValue: (value: Value) => void;
  isActive: () => boolean;
  lifecycle: ProfileSessionLifecycleController;
  readInitialValue: () => Promise<Value>;
  synchronizeStorage: () => Promise<void>;
}): Promise<boolean> {
  try {
    await synchronizeStorage();
  } catch {
    // Initial-link handling remains available when storage synchronization fails.
  }
  return applyProfileSessionLifecycleValue({
    apply: applyInitialValue,
    isActive,
    lifecycle,
    read: readInitialValue,
  });
}

export type ProfileCommandQueueTransition<Command> = {
  pendingCommands: Command[];
  sequencedCommands: Command[];
  skippedCommands: Command[];
};

function sameLogicalQueue(
  left: ProfileSessionOrderedCommand,
  right: ProfileSessionOrderedCommand,
): boolean {
  return left.scenario === right.scenario &&
    left.runId === right.runId &&
    left.queueId === right.queueId;
}

export function resolveProfileCommandFailFastQueueTransition<Command extends ProfileSessionOrderedCommand>({
  blockedCommand,
  pendingCommands,
  sequencedCommands,
  stopOnFailure,
}: {
  blockedCommand: Command;
  pendingCommands: readonly Command[];
  sequencedCommands: readonly Command[];
  stopOnFailure: boolean;
}): ProfileCommandQueueTransition<Command> {
  if (!stopOnFailure) {
    return {
      pendingCommands: [...pendingCommands],
      sequencedCommands: [...sequencedCommands],
      skippedCommands: [],
    };
  }

  const retainedPendingCommands: Command[] = [];
  const retainedSequencedCommands: Command[] = [];
  const skippedCommands: Command[] = [];
  for (const command of pendingCommands) {
    if (
      sameLogicalQueue(blockedCommand, command) &&
      compareProfileCommands(command, blockedCommand) > 0
    ) {
      skippedCommands.push(command);
    } else {
      retainedPendingCommands.push(command);
    }
  }
  for (const command of sequencedCommands) {
    if (
      sameLogicalQueue(blockedCommand, command) &&
      compareProfileCommands(command, blockedCommand) > 0
    ) {
      skippedCommands.push(command);
    } else {
      retainedSequencedCommands.push(command);
    }
  }

  return {
    pendingCommands: retainedPendingCommands,
    sequencedCommands: retainedSequencedCommands,
    skippedCommands,
  };
}

export const resolveDependencyTimeoutQueueTransition = resolveProfileCommandFailFastQueueTransition;

export function createProfileCommandDependencyController<Command extends ProfileSessionOrderedCommand>({
  cancelTimeout = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now = () => Date.now(),
  scheduleTimeout = (callback, waitMs) => setTimeout(callback, waitMs),
}: {
  cancelTimeout?: (handle: DependencyTimeoutHandle) => void;
  now?: () => number;
  scheduleTimeout?: (callback: () => void, waitMs: number) => DependencyTimeoutHandle;
} = {}): ProfileCommandDependencyController<Command> {
  let active: ActiveDependencyGate<Command> | null = null;

  const cancelActiveTimeout = (): void => {
    if (active?.timeoutHandle !== null && active?.timeoutHandle !== undefined) {
      cancelTimeout(active.timeoutHandle);
      active.timeoutHandle = null;
    }
    if (active) {
      active.token = {};
    }
  };

  const clear = (): void => {
    cancelActiveTimeout();
    active = null;
  };

  const arm = (
    target: ActiveDependencyGate<Command>,
    onTimeout: (gate: ProfileCommandDependencyGate) => void,
  ): void => {
    cancelActiveTimeout();
    const waitMs = Math.max(0, target.deadlineAtMs - now());
    const token = {};
    target.token = token;
    target.timeoutHandle = scheduleTimeout(() => {
      if (active !== target || active.token !== token) {
        return;
      }
      target.timeoutHandle = null;
      onTimeout(target.gate);
    }, waitMs);
  };

  return {
    clear,
    getGate: () => active?.gate ?? null,
    install: ({ command, observedEvents, onTimeout }) => {
      const nextGate = buildProfileCommandDependencyGate(command, observedEvents);
      if (!nextGate) {
        clear();
        return null;
      }

      if (active && doesProfileCommandMatchDependencyGate(active.gate, command)) {
        active.command = command;
        active.gate = nextGate;
        if (active.timeoutHandle === null) {
          arm(active, onTimeout);
        }
        return active.gate;
      }

      clear();
      const target: ActiveDependencyGate<Command> = {
        command,
        deadlineAtMs: now() + nextGate.waitTimeoutMs,
        gate: nextGate,
        timeoutHandle: null,
        token: {},
      };
      active = target;
      arm(target, onTimeout);
      return target.gate;
    },
    release: (command, observedEvents) => {
      if (
        !active ||
        !doesProfileCommandMatchDependencyGate(active.gate, command) ||
        buildProfileCommandDependencyGate(command, observedEvents)
      ) {
        return false;
      }
      clear();
      return true;
    },
    suspend: () => {
      cancelActiveTimeout();
    },
  };
}
