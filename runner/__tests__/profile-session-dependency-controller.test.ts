import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendBoundedProfileEventHistory,
  appendCompleteProfileSessionHistory,
  createProfileSessionDependencyMilestoneFacts,
  createProfileCommandDependencyController,
  createProfileCommandScheduleController,
  createProfileSessionLifecycleController,
  createProfileSessionProcessedCommandIds,
  readProfileSessionLifecycleValue,
  recoverProfileCommandLifecycle,
  resolveDependencyTimeoutQueueTransition,
  resolveProfileCommandFailFastQueueTransition,
  runProfileSessionBootstrapSequence,
} from '../../app/profile-session-dependency-controller';

test('reload recovery separates replayable, delivered, and terminal command boundaries', () => {
  const lifecycle = recoverProfileCommandLifecycle([
    { id: 'received-only', status: 'received', timestamp: 1 },
    { id: 'queued-only', status: 'queued', timestamp: 2 },
    { id: 'delivered', status: 'delivered', timestamp: 3 },
    { id: 'completed', status: 'delivered', timestamp: 4 },
    { id: 'completed', status: 'completed', timestamp: 5 },
    { id: 'skipped', status: 'skipped', timestamp: 6 },
  ]);

  assert.deepEqual([...lifecycle.delivered], [['delivered', 3]]);
  assert.deepEqual([...lifecycle.terminal].sort(), ['completed', 'skipped']);
  assert.equal(lifecycle.delivered.has('received-only'), false);
  assert.equal(lifecycle.delivered.has('queued-only'), false);
});

type TestCommand = {
  commandId: string;
  dependsOnMilestones: string[];
  id: string;
  queueId: string;
  runId: string;
  scenario: string;
  sequence: number;
  stopOnFailure: boolean;
  timestamp: number;
  waitTimeoutMs: number;
};

function command(overrides: Partial<TestCommand> = {}): TestCommand {
  return {
    commandId: 'blocked',
    dependsOnMilestones: ['viewer_ready'],
    id: 'command-1',
    queueId: 'queue-a',
    runId: 'run-a',
    scenario: 'gallery',
    sequence: 1,
    stopOnFailure: true,
    timestamp: 100,
    waitTimeoutMs: 100,
    ...overrides,
  };
}

function matchingEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: 'viewer_ready',
    queueId: 'queue-a',
    runId: 'run-a',
    scenario: 'gallery',
    timestamp: 150,
    ...overrides,
  };
}

function createFakeScheduler() {
  let now = 1_000;
  const tasks: Array<{ callback: () => void; cancelled: boolean; waitMs: number }> = [];
  return {
    advance: (waitMs: number) => {
      now += waitMs;
    },
    controller: createProfileCommandDependencyController<TestCommand>({
      cancelTimeout: (handle: unknown) => {
        const task = tasks[handle as number];
        if (task) {
          task.cancelled = true;
        }
      },
      now: () => now,
      scheduleTimeout: (callback: () => void, waitMs: number) => {
        tasks.push({ callback, cancelled: false, waitMs });
        return tasks.length - 1;
      },
    }),
    tasks,
  };
}

test('dependency controller expires an actual bounded timer', async () => {
  const controller = createProfileCommandDependencyController<TestCommand>();
  const timedOut = new Promise<string>((resolve) => {
    controller.install({
      command: command({ waitTimeoutMs: 1 }),
      observedEvents: [],
      onTimeout: (gate: { id: string }) => resolve(gate.id),
    });
  });
  assert.equal(await timedOut, 'command-1');
  controller.clear();
});

test('dependency controller releases only from exact queue and run evidence', () => {
  const { controller, tasks } = createFakeScheduler();
  let timeoutCount = 0;
  const blocked = command();
  controller.install({
    command: blocked,
    observedEvents: [],
    onTimeout: () => {
      timeoutCount += 1;
    },
  });
  assert.equal(controller.release(blocked, [matchingEvent({ queueId: 'queue-b' })]), false);
  assert.equal(controller.release(blocked, [matchingEvent({ runId: 'run-b' })]), false);
  assert.equal(controller.release(blocked, [matchingEvent()]), true);
  assert.equal(tasks[0]?.cancelled, true);
  tasks[0]?.callback();
  assert.equal(timeoutCount, 0, 'a released stale timer cannot mutate queue state');
});

test('dependency milestone facts outlive bounded diagnostic history without retaining duplicates', () => {
  const facts = createProfileSessionDependencyMilestoneFacts();
  const diagnosticHistory: Array<ReturnType<typeof matchingEvent>> = [];
  const storedTruth: Array<ReturnType<typeof matchingEvent>> = [];
  const earlyMilestone = matchingEvent({ event: 'gallery_ready', timestamp: 1 });
  facts.observe(earlyMilestone);
  appendBoundedProfileEventHistory(diagnosticHistory, earlyMilestone, 300);
  appendCompleteProfileSessionHistory(storedTruth, earlyMilestone);

  const noisyVocabulary = [
    'gallery_progress',
    'gallery_buffering',
    'gallery_playing',
    'gallery_settled',
    'gallery_frame',
  ];
  for (let index = 0; index < 350; index += 1) {
    const noisyEvent = matchingEvent({
      event: noisyVocabulary[index % noisyVocabulary.length],
      timestamp: index + 2,
    });
    facts.observe(noisyEvent);
    appendBoundedProfileEventHistory(diagnosticHistory, noisyEvent, 300);
    appendCompleteProfileSessionHistory(storedTruth, noisyEvent);
  }
  facts.observe(matchingEvent({ event: 'gallery_ready', timestamp: 999 }));

  const laterCommand = command({
    dependsOnMilestones: ['gallery_ready'],
    id: 'later-command',
    sequence: 29,
    timestamp: 1_000,
  });
  assert.equal(diagnosticHistory.length, 300);
  assert.equal(storedTruth.length, 351);
  assert.equal(storedTruth[0]?.event, 'gallery_ready');
  assert.equal(diagnosticHistory.some((event) => event.event === 'gallery_ready'), false);
  assert.equal(facts.snapshot().filter((event) => event.event === 'gallery_ready').length, 1);
  assert.equal(facts.snapshot().length, noisyVocabulary.length + 1);

  const { controller } = createFakeScheduler();
  assert.equal(controller.install({
    command: laterCommand,
    observedEvents: facts.snapshot(),
    onTimeout: () => assert.fail('durable dependency fact must prevent a gate'),
  }), null);
});

test('processed storage command identity remains exact beyond the former replay window', () => {
  const processed = createProfileSessionProcessedCommandIds();
  const delivered: string[] = [];
  const poll = (ids: readonly string[]) => {
    for (const id of ids) {
      if (processed.has(id)) {
        continue;
      }
      processed.mark(id);
      delivered.push(id);
    }
  };
  const commands = Array.from({ length: 150 }, (_, index) => `command-${index + 1}`);
  poll(commands);
  poll(commands);
  poll(commands.slice(0, 30));
  assert.deepEqual(delivered, commands);

  processed.reset();
  poll([commands[0] ?? 'command-1']);
  assert.equal(delivered.length, 151, 'a logical replacement resets exactly-once identity');
});

test('complete session history preserves start and every terminal command beyond 120 rows', () => {
  const entries: Array<{ kind: 'start' | 'command'; sequence?: number; status?: 'completed' }> = [];
  appendCompleteProfileSessionHistory(entries, { kind: 'start' });
  for (let sequence = 1; sequence <= 140; sequence += 1) {
    appendCompleteProfileSessionHistory(entries, {
      kind: 'command',
      sequence,
      status: 'completed',
    });
  }
  assert.equal(entries.length, 141);
  assert.deepEqual(entries[0], { kind: 'start' });
  assert.deepEqual(entries.at(-1), { kind: 'command', sequence: 140, status: 'completed' });
  assert.equal(entries.filter((entry) => entry.kind === 'command').length, 140);
});

test('dependency milestone facts preserve exact run and queue ownership and reset on replacement', () => {
  const facts = createProfileSessionDependencyMilestoneFacts();
  facts.observe(matchingEvent());

  const { controller } = createFakeScheduler();
  assert.notEqual(controller.install({
    command: command({ queueId: 'queue-b' }),
    observedEvents: facts.snapshot(),
    onTimeout: () => {},
  }), null);
  controller.clear();
  assert.notEqual(controller.install({
    command: command({ runId: 'run-b' }),
    observedEvents: facts.snapshot(),
    onTimeout: () => {},
  }), null);
  controller.clear();
  assert.equal(controller.install({
    command: command(),
    observedEvents: facts.snapshot(),
    onTimeout: () => assert.fail('matching fact must prevent a gate'),
  }), null);

  facts.reset();
  assert.equal(facts.snapshot().length, 0);
  assert.notEqual(controller.install({
    command: command({ id: 'replacement-command' }),
    observedEvents: facts.snapshot(),
    onTimeout: () => {},
  }), null);
  controller.clear();
});

test('dependency milestone facts survive bootstrap suspension and remount for the active session', () => {
  const lifecycle = createProfileSessionLifecycleController();
  const facts = createProfileSessionDependencyMilestoneFacts();
  const { controller } = createFakeScheduler();
  facts.observe(matchingEvent({ event: 'gallery_ready' }));

  lifecycle.invalidate();
  controller.suspend();

  const remountedCommand = command({
    dependsOnMilestones: ['gallery_ready'],
    id: 'remounted-command',
    sequence: 29,
  });
  assert.equal(controller.install({
    command: remountedCommand,
    observedEvents: facts.snapshot(),
    onTimeout: () => assert.fail('bootstrap churn must not discard active-session facts'),
  }), null);
  assert.equal(facts.snapshot().length, 1);
});

test('dependency controller replacement prevents a stale callback from acting', () => {
  const { controller, tasks } = createFakeScheduler();
  const timedOut: string[] = [];
  controller.install({
    command: command(),
    observedEvents: [],
    onTimeout: (gate: { id: string }) => timedOut.push(gate.id),
  });
  controller.install({
    command: command({ id: 'command-2', sequence: 2, timestamp: 200 }),
    observedEvents: [],
    onTimeout: (gate: { id: string }) => timedOut.push(gate.id),
  });
  tasks[0]?.callback();
  assert.deepEqual(timedOut, []);
  tasks[1]?.callback();
  assert.deepEqual(timedOut, ['command-2']);
});

test('dependency controller cleanup prevents a cancelled callback from mutating state', () => {
  const { controller, tasks } = createFakeScheduler();
  let timeoutCount = 0;
  controller.install({
    command: command(),
    observedEvents: [],
    onTimeout: () => {
      timeoutCount += 1;
    },
  });
  controller.clear();
  tasks[0]?.callback();
  assert.equal(timeoutCount, 0);
  assert.equal(controller.getGate(), null);
});

function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function runGuardedStorageSync(
  lifecycle: ReturnType<typeof createProfileSessionLifecycleController>,
  sessionRead: Promise<string>,
  commandRead: Promise<string[]>,
  onMutation: (commands: string[]) => void,
) {
  const generation = lifecycle.capture();
  const session = await readProfileSessionLifecycleValue({
    generation,
    isActive: () => true,
    lifecycle,
    read: () => sessionRead,
  });
  if (!session.current) {
    return;
  }
  const commands = await readProfileSessionLifecycleValue({
    generation,
    isActive: () => true,
    lifecycle,
    read: () => commandRead,
  });
  if (!commands.current) {
    return;
  }
  onMutation(commands.value);
}

test('bootstrap lifecycle rejects a deferred storage read after unmount', async () => {
  const lifecycle = createProfileSessionLifecycleController();
  const sessionRead = createDeferred<string>();
  const commandRead = createDeferred<string[]>();
  const mutations: string[][] = [];
  const sync = runGuardedStorageSync(
    lifecycle,
    sessionRead.promise,
    commandRead.promise,
    (commands) => mutations.push(commands),
  );

  lifecycle.invalidate();
  sessionRead.resolve('stored-session');
  commandRead.resolve(['stale-command']);
  await sync;

  assert.deepEqual(mutations, []);
});

test('bootstrap lifecycle rejects deferred stored commands after session replacement', async () => {
  const lifecycle = createProfileSessionLifecycleController();
  const sessionRead = createDeferred<string>();
  const commandRead = createDeferred<string[]>();
  const mutations: string[][] = [];
  const sync = runGuardedStorageSync(
    lifecycle,
    sessionRead.promise,
    commandRead.promise,
    (commands) => mutations.push(commands),
  );

  sessionRead.resolve('stored-session');
  await Promise.resolve();
  lifecycle.invalidate();
  commandRead.resolve(['stale-command']);
  await sync;

  assert.deepEqual(mutations, []);
});

test('bootstrap sequences storage before initial link and rejects later replacement or unmount', async () => {
  const lifecycle = createProfileSessionLifecycleController();
  const storageSync = createDeferred<void>();
  const acceptedRead = createDeferred<string | null>();
  const applied: Array<string | null> = [];
  let initialReadStarted = false;
  const applyUrl = (url: string | null) => {
    applied.push(url);
  };
  const accepted = runProfileSessionBootstrapSequence({
    applyInitialValue: applyUrl,
    isActive: () => true,
    lifecycle,
    readInitialValue: () => {
      initialReadStarted = true;
      return acceptedRead.promise;
    },
    synchronizeStorage: async () => {
      await storageSync.promise;
      lifecycle.invalidate(); // Storage synchronization established the active session.
    },
  });
  assert.equal(initialReadStarted, false);
  storageSync.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(initialReadStarted, true);
  acceptedRead.resolve('app://profile-session/command');
  assert.equal(await accepted, true);
  assert.deepEqual(applied, ['app://profile-session/command']);

  const replacementRead = createDeferred<string | null>();
  const replaced = runProfileSessionBootstrapSequence({
    applyInitialValue: applyUrl,
    isActive: () => true,
    lifecycle,
    readInitialValue: () => replacementRead.promise,
    synchronizeStorage: async () => {},
  });
  await Promise.resolve();
  lifecycle.invalidate();
  replacementRead.resolve('app://stale-replacement');
  assert.equal(await replaced, false);

  let mounted = true;
  const unmountRead = createDeferred<string | null>();
  const unmounted = runProfileSessionBootstrapSequence({
    applyInitialValue: applyUrl,
    isActive: () => mounted,
    lifecycle,
    readInitialValue: () => unmountRead.promise,
    synchronizeStorage: async () => {},
  });
  await Promise.resolve();
  mounted = false;
  lifecycle.invalidate();
  unmountRead.resolve('app://stale-unmount');
  assert.equal(await unmounted, false);
  assert.deepEqual(applied, ['app://profile-session/command']);
});

test('dependency controller suspend and remount preserve the original deadline', () => {
  const { advance, controller, tasks } = createFakeScheduler();
  const timedOut: string[] = [];
  const blocked = command();
  controller.install({
    command: blocked,
    observedEvents: [],
    onTimeout: (gate: { id: string }) => timedOut.push(gate.id),
  });
  advance(40);
  controller.suspend();
  advance(20);
  controller.install({
    command: { ...blocked },
    observedEvents: [],
    onTimeout: (gate: { id: string }) => timedOut.push(gate.id),
  });
  assert.equal(tasks[1]?.waitMs, 40);
  tasks[0]?.callback();
  assert.deepEqual(timedOut, []);
  tasks[1]?.callback();
  assert.deepEqual(timedOut, ['command-1']);
});

test('dependency suspension invalidates a callback already dispatched by the host timer', () => {
  const { controller, tasks } = createFakeScheduler();
  const timedOut: string[] = [];
  controller.install({
    command: command(),
    observedEvents: [],
    onTimeout: (gate: { id: string }) => timedOut.push(gate.id),
  });
  controller.suspend();
  tasks[0]?.callback();
  assert.deepEqual(timedOut, []);
});

test('dependency timeout scopes fail-fast skips to one logical queue', () => {
  const blocked = command();
  const sameQueue = command({ id: 'same-queue', sequence: 2, timestamp: 200 });
  const earlierSameQueue = command({ id: 'earlier-same-queue', sequence: 0, timestamp: 50 });
  const otherQueue = command({ id: 'other-queue', queueId: 'queue-b', sequence: 1, timestamp: 300 });
  const otherRun = command({ id: 'other-run', runId: 'run-b', sequence: 1, timestamp: 400 });
  const otherScenario = command({ id: 'other-scenario', scenario: 'other', sequence: 1, timestamp: 500 });

  assert.deepEqual(resolveDependencyTimeoutQueueTransition({
    blockedCommand: blocked,
    pendingCommands: [sameQueue, earlierSameQueue, otherQueue],
    sequencedCommands: [otherRun, otherScenario],
    stopOnFailure: true,
  }), {
    pendingCommands: [earlierSameQueue, otherQueue],
    sequencedCommands: [otherRun, otherScenario],
    skippedCommands: [sameQueue],
  });
  assert.deepEqual(resolveDependencyTimeoutQueueTransition({
    blockedCommand: blocked,
    pendingCommands: [sameQueue, otherQueue],
    sequencedCommands: [otherRun],
    stopOnFailure: false,
  }), {
    pendingCommands: [sameQueue, otherQueue],
    sequencedCommands: [otherRun],
    skippedCommands: [],
  }, 'continue mode retains every later command for normal processing');
});

test('dependency timer callback composes with scoped stop and continue queue transitions', () => {
  const stopScheduler = createFakeScheduler();
  const blocked = command();
  const sameQueue = command({ id: 'same-queue', sequence: 2, timestamp: 200 });
  const otherQueue = command({ id: 'other-queue', queueId: 'queue-b', sequence: 1, timestamp: 300 });
  let stopTransition: unknown = null;
  stopScheduler.controller.install({
    command: blocked,
    observedEvents: [],
    onTimeout: () => {
      stopTransition = resolveDependencyTimeoutQueueTransition({
        blockedCommand: blocked,
        pendingCommands: [],
        sequencedCommands: [sameQueue, otherQueue],
        stopOnFailure: true,
      });
    },
  });
  stopScheduler.tasks[0]?.callback();
  assert.deepEqual(stopTransition, {
    pendingCommands: [],
    sequencedCommands: [otherQueue],
    skippedCommands: [sameQueue],
  });

  const continueScheduler = createFakeScheduler();
  let continueTransition: unknown = null;
  continueScheduler.controller.install({
    command: command({ stopOnFailure: false }),
    observedEvents: [],
    onTimeout: () => {
      continueTransition = resolveDependencyTimeoutQueueTransition({
        blockedCommand: blocked,
        pendingCommands: [],
        sequencedCommands: [sameQueue, otherQueue],
        stopOnFailure: false,
      });
    },
  });
  continueScheduler.tasks[0]?.callback();
  assert.deepEqual(continueTransition, {
    pendingCommands: [],
    sequencedCommands: [sameQueue, otherQueue],
    skippedCommands: [],
  });
});

test('milestone timeout preserves commands from other queues and runs', () => {
  const blocked = command({ id: 'milestone-blocked' });
  const sameQueueLater = command({ id: 'same-queue-later', sequence: 2, timestamp: 200 });
  const otherQueue = command({ id: 'other-queue', queueId: 'queue-b', sequence: 2, timestamp: 200 });
  const otherRun = command({ id: 'other-run', runId: 'run-b', sequence: 2, timestamp: 200 });

  assert.deepEqual(resolveProfileCommandFailFastQueueTransition({
    blockedCommand: blocked,
    pendingCommands: [otherRun, sameQueueLater],
    sequencedCommands: [otherQueue],
    stopOnFailure: true,
  }), {
    pendingCommands: [otherRun],
    sequencedCommands: [otherQueue],
    skippedCommands: [sameQueueLater],
  });
});

test('stale scheduled microtask cannot mutate a replacement lifecycle', async () => {
  const lifecycle = createProfileSessionLifecycleController();
  const schedules = createProfileCommandScheduleController(lifecycle);
  const mutations: string[] = [];
  const token = schedules.captureNext();
  queueMicrotask(() => {
    if (schedules.isCurrent(token)) {
      mutations.push('stale');
    }
  });

  lifecycle.invalidate();
  await Promise.resolve();
  assert.deepEqual(mutations, []);
});

test('new schedule installation invalidates an already queued microtask', async () => {
  const lifecycle = createProfileSessionLifecycleController();
  const schedules = createProfileCommandScheduleController(lifecycle);
  const mutations: string[] = [];
  const staleToken = schedules.captureNext();
  queueMicrotask(() => {
    if (schedules.isCurrent(staleToken)) {
      mutations.push('stale');
    }
  });
  const currentToken = schedules.captureNext();
  queueMicrotask(() => {
    if (schedules.isCurrent(currentToken)) {
      mutations.push('current');
    }
  });

  await Promise.resolve();
  assert.deepEqual(mutations, ['current']);
});
