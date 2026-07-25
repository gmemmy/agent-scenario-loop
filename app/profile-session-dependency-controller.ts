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
