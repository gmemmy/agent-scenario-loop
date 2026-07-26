const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProfileCommandMilestoneGate,
  compareProfileCommands,
  doesProfileEventReleaseCommandGate,
  hasObservedProfileCommandDependencies,
  hasObservedProfileCommandMilestone,
  resolveProfileCommandCadenceOutcome,
  resolveProfileCommandMilestoneTimeoutOutcome,
  resolveProfileCommandSettleOutcome,
  resolveRemainingProfileCommandSettleMs,
} = require('../../profile-session-command-ordering');
const {
  buildProfileCommandDependencyGate,
  doesProfileCommandMatchDependencyGate,
  hasObservedDeliveredProfileCommandMilestone,
  resolveMissingProfileCommandDependencies,
  resolveProfileCommandDependencyTimeoutOutcome,
  resolveProfileCommandQueueBlocker,
  resolveProfileCommandTimeoutQueueTransition,
  resolveProfileCommandWaitTimeoutMs,
  takeNextProfileCommand,
} = require('../../app/profile-session-command-ordering');

test('profile-session command ordering sorts sequence before timestamp', () => {
  const commands = [
    { id: 'late-unsequenced', command: 'late', timestamp: 5_000 },
    { id: 'seq-2', command: 'second', sequence: 2, timestamp: 100 },
    { id: 'seq-1-late', command: 'first-late', sequence: 1, timestamp: 300 },
    { id: 'seq-1-early', command: 'first-early', sequence: 1, timestamp: 200 },
  ];

  commands.sort(compareProfileCommands);

  assert.deepEqual(commands.map((command) => command.id), [
    'seq-1-early',
    'seq-1-late',
    'seq-2',
    'late-unsequenced',
  ]);
});

test('profile-session command ordering uses id as the deterministic final tie-break', () => {
  const commands = [
    { id: 'command-b', command: 'second', sequence: 2, timestamp: 100 },
    { id: 'command-a', command: 'first', sequence: 2, timestamp: 100 },
    { id: 'unsequenced-b', command: 'fourth', timestamp: 200 },
    { id: 'unsequenced-a', command: 'third', timestamp: 200 },
  ];

  commands.sort(compareProfileCommands);

  assert.deepEqual(commands.map((command) => command.id), [
    'command-a',
    'command-b',
    'unsequenced-a',
    'unsequenced-b',
  ]);
});

test('profile-session command ordering builds scoped milestone gates', () => {
  assert.equal(buildProfileCommandMilestoneGate({
    id: 'no-gate',
    command: 'tap',
    timestamp: 1,
  }), null);

  assert.deepEqual(buildProfileCommandMilestoneGate({
    id: 'command-1',
    commandId: 'open-card',
    queueId: 'card-cycle',
    runId: 'run-1',
    scenario: 'open-close-cycle',
    sequence: 2,
    timestamp: 1,
    waitForMilestone: 'card_opened',
    waitMs: 125,
  }), {
    commandId: 'open-card',
    id: 'command-1',
    milestone: 'card_opened',
    queueId: 'card-cycle',
    runId: 'run-1',
    scenario: 'open-close-cycle',
    sequence: 2,
    waitMs: 125,
    waitTimeoutMs: 30000,
  });
});

test('profile-session command ordering overlaps minimum settle with readiness waits', () => {
  const commandReleasedAtMs = 1_000;

  assert.equal(
    resolveRemainingProfileCommandSettleMs(300, commandReleasedAtMs, 1_100),
    200,
    'fast readiness leaves only the unspent settle window',
  );
  assert.equal(
    resolveRemainingProfileCommandSettleMs(300, commandReleasedAtMs, 1_300),
    0,
    'readiness on the settle boundary continues immediately',
  );
  assert.equal(
    resolveRemainingProfileCommandSettleMs(300, commandReleasedAtMs, 1_700),
    0,
    'slow readiness does not add a fixed sleep',
  );
  assert.equal(
    resolveRemainingProfileCommandSettleMs(undefined, commandReleasedAtMs, 1_100),
    0,
    'commands without cadence remain readiness-driven',
  );
  assert.equal(
    resolveRemainingProfileCommandSettleMs(300, commandReleasedAtMs, 900),
    300,
    'clock rollback cannot erase the declared minimum settle',
  );
});

test('profile-session command ordering reports cadence overlap telemetry deterministically', () => {
  assert.deepEqual(resolveProfileCommandCadenceOutcome({
    minimumSettleMs: 300,
    commandReleasedAtMs: 1_000,
    readinessObservedAtMs: 1_100,
    maxReadinessWaitMs: 1_500,
  }), {
    kind: 'continue',
    reason: 'readiness-released-before-settle-complete',
    remainingSettleMs: 200,
    telemetry: {
      actualWaitMs: 300,
      maxReadinessWaitMs: 1500,
      minimumSettleMs: 300,
      readinessWaitMs: 100,
      settleOverlapSavedMs: 100,
      timeoutAvoided: true,
    },
  });

  assert.deepEqual(resolveProfileCommandCadenceOutcome({
    minimumSettleMs: 300,
    commandReleasedAtMs: 1_000,
    readinessObservedAtMs: 1_800,
    maxReadinessWaitMs: 2_000,
  }), {
    kind: 'continue',
    reason: 'readiness-and-settle-satisfied',
    remainingSettleMs: 0,
    telemetry: {
      actualWaitMs: 800,
      maxReadinessWaitMs: 2000,
      minimumSettleMs: 300,
      readinessWaitMs: 800,
      settleOverlapSavedMs: 300,
      timeoutAvoided: true,
    },
  });

  assert.deepEqual(resolveProfileCommandCadenceOutcome({
    minimumSettleMs: 100,
    commandReleasedAtMs: 1_000,
    readinessObservedAtMs: 1_050,
  }).telemetry, {
    actualWaitMs: 100,
    minimumSettleMs: 100,
    readinessWaitMs: 50,
    settleOverlapSavedMs: 50,
  }, 'telemetry does not manufacture a timeout when none was supplied');
});

test('profile-session command ordering records settle-only continuation at the observed boundary', () => {
  assert.deepEqual(resolveProfileCommandSettleOutcome({
    minimumSettleMs: 300,
    commandReleasedAtMs: 1_000,
    continuationObservedAtMs: 1_325,
  }), {
    kind: 'continue',
    reason: 'minimum-settle-satisfied',
    remainingSettleMs: 0,
    telemetry: {
      actualWaitMs: 325,
      minimumSettleMs: 300,
      readinessWaitMs: 0,
      settleOverlapSavedMs: 0,
    },
  });

  assert.equal(resolveProfileCommandCadenceOutcome({
    minimumSettleMs: 300,
    commandReleasedAtMs: 1_000,
    readinessObservedAtMs: 1_100,
    continuationObservedAtMs: 1_325,
    maxReadinessWaitMs: 1_500,
  }).telemetry.actualWaitMs, 325);
});

test('profile-session command ordering resolves stop policy from milestone timeout outcomes', () => {
  assert.deepEqual(resolveProfileCommandMilestoneTimeoutOutcome({
    commandReleasedAtMs: 1_000,
    timeoutObservedAtMs: 2_500,
    minimumSettleMs: 300,
    maxReadinessWaitMs: 1500,
    stopOnFailure: true,
  }), {
    kind: 'terminal',
    reason: 'milestone-timeout-stop',
    telemetry: {
      actualWaitMs: 1500,
      maxReadinessWaitMs: 1500,
      minimumSettleMs: 300,
      readinessWaitMs: 1500,
      settleOverlapSavedMs: 300,
      timeoutAvoided: false,
    },
  });

  assert.deepEqual(resolveProfileCommandMilestoneTimeoutOutcome({
    commandReleasedAtMs: 1_000,
    timeoutObservedAtMs: 2_500,
    minimumSettleMs: 300,
    maxReadinessWaitMs: 1500,
    stopOnFailure: false,
  }), {
    kind: 'continue',
    reason: 'milestone-timeout-continue',
    telemetry: {
      actualWaitMs: 1500,
      maxReadinessWaitMs: 1500,
      minimumSettleMs: 300,
      readinessWaitMs: 1500,
      settleOverlapSavedMs: 300,
      timeoutAvoided: false,
    },
  });
});

test('profile-session command runtime drains pending backlogs one transition at a time', () => {
  const first = takeNextProfileCommand(['command-1', 'command-2', 'command-3']);
  assert.deepEqual(first, {
    command: 'command-1',
    remainingCommands: ['command-2', 'command-3'],
  });

  const second = takeNextProfileCommand(first.remainingCommands);
  assert.deepEqual(second, {
    command: 'command-2',
    remainingCommands: ['command-3'],
  });

  assert.deepEqual(takeNextProfileCommand(second.remainingCommands), {
    command: 'command-3',
    remainingCommands: [],
  });
});

test('profile-session command runtime blocks registration-driven draining during readiness and settle', () => {
  assert.equal(resolveProfileCommandQueueBlocker({
    hasActiveGate: true,
    processingScheduled: false,
    remainingSettleMs: 0,
  }), 'active-readiness-gate');
  assert.equal(resolveProfileCommandQueueBlocker({
    hasActiveGate: false,
    processingScheduled: true,
    remainingSettleMs: 200,
  }), 'scheduled-settle');
  assert.equal(resolveProfileCommandQueueBlocker({
    hasActiveGate: false,
    processingScheduled: false,
    remainingSettleMs: 200,
  }), 'remaining-settle');
  assert.equal(resolveProfileCommandQueueBlocker({
    hasActiveGate: false,
    processingScheduled: false,
    remainingSettleMs: 0,
  }), null);
});

test('profile-session command runtime makes fail-fast timeout terminal before late readiness', () => {
  const transition = resolveProfileCommandTimeoutQueueTransition({
    activeGateId: 'command-1',
    pendingCommands: ['command-2'],
    sequencedCommands: ['command-3'],
    stopOnFailure: true,
  });

  assert.deepEqual(transition, {
    activeGateId: null,
    pendingCommands: [],
    sequencedCommands: [],
    skippedCommands: ['command-2', 'command-3'],
  });
  const lateReadinessCouldRelease = transition.activeGateId === null
    ? false
    : doesProfileEventReleaseCommandGate({
        id: transition.activeGateId,
        milestone: 'surface_ready',
      }, {
        event: 'surface_ready',
        runId: 'run-1',
        scenario: 'scenario-1',
        timestamp: 2_000,
      });
  assert.equal(lateReadinessCouldRelease, false);
});

test('profile-session command runtime preserves queued work when timeout policy continues', () => {
  assert.deepEqual(resolveProfileCommandTimeoutQueueTransition({
    activeGateId: 'command-1',
    pendingCommands: ['command-2'],
    sequencedCommands: ['command-3'],
    stopOnFailure: false,
  }), {
    activeGateId: null,
    pendingCommands: ['command-2'],
    sequencedCommands: ['command-3'],
    skippedCommands: [],
  });
});

test('profile-session command ordering only reuses observed readiness for first sequenced commands', () => {
  const observedEvents = [
    {
      event: 'surface_ready',
      queueId: 'scroll-cycle-queue',
      runId: 'run-1',
      scenario: 'scroll-cycle',
      sequence: 1,
      timestamp: 100,
    },
  ];

  assert.equal(hasObservedProfileCommandMilestone({
    id: 'ready-command',
    command: 'reset-surface',
    queueId: 'scroll-cycle-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 1,
    timestamp: 200,
    waitForMilestone: 'surface_ready',
  }, observedEvents), true);

  assert.equal(hasObservedProfileCommandMilestone({
    id: 'repeat-command',
    command: 'scroll',
    queueId: 'scroll-cycle-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 2,
    timestamp: 300,
    waitForMilestone: 'surface_ready',
  }, observedEvents), false);

  assert.equal(hasObservedProfileCommandMilestone({
    id: 'stale-run-command',
    command: 'reset-surface',
    queueId: 'scroll-cycle-queue',
    runId: 'run-2',
    scenario: 'scroll-cycle',
    sequence: 1,
    timestamp: 400,
    waitForMilestone: 'surface_ready',
  }, observedEvents), false);

  assert.equal(hasObservedProfileCommandMilestone({
    id: 'wrong-queue-command',
    command: 'reset-surface',
    queueId: 'other-scroll-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 1,
    timestamp: 500,
    waitForMilestone: 'surface_ready',
  }, observedEvents), false);
});

test('delivered-command recovery reuses only sequence-correlated readiness', () => {
  const command = {
    id: 'command-29',
    queueId: 'queue-a',
    runId: 'run-a',
    scenario: 'gallery',
    sequence: 29,
    timestamp: 100,
    waitForMilestone: 'viewer_ready',
  };
  const matching = {
    event: 'viewer_ready',
    queueId: 'queue-a',
    runId: 'run-a',
    scenario: 'gallery',
    sequence: 29,
    timestamp: 150,
  };
  assert.equal(hasObservedProfileCommandMilestone(command, [matching]), false);
  assert.equal(hasObservedDeliveredProfileCommandMilestone(command, [matching]), true);
  assert.equal(hasObservedDeliveredProfileCommandMilestone(command, [
    { ...matching, sequence: 28 },
  ]), false);
});

test('profile-session command ordering rejects readiness events missing required command scope', () => {
  const observedEvents = [
    {
      event: 'surface_ready',
      runId: 'run-1',
      scenario: 'scroll-cycle',
      timestamp: 100,
    },
  ];

  assert.equal(hasObservedProfileCommandMilestone({
    id: 'ready-command',
    command: 'reset-surface',
    queueId: 'scroll-cycle-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 1,
    timestamp: 200,
    waitForMilestone: 'surface_ready',
  }, observedEvents), false);
});

test('profile-session command ordering releases gates only for matching run and scenario', () => {
  const gate = {
    id: 'command-1',
    milestone: 'gallery_viewer_dismissed',
    queueId: 'gallery-cycle-queue',
    runId: 'run-1',
    scenario: 'gallery-cycle',
    sequence: 5,
  };

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'gallery_viewer_dismissed',
    queueId: 'gallery-cycle-queue',
    runId: 'run-1',
    scenario: 'gallery-cycle',
    sequence: 5,
    timestamp: 500,
  }), true);

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'gallery_viewer_dismissed',
    queueId: 'gallery-cycle-queue',
    runId: 'run-2',
    scenario: 'gallery-cycle',
    sequence: 5,
    timestamp: 500,
  }), false);

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'gallery_viewer_opened',
    queueId: 'gallery-cycle-queue',
    runId: 'run-1',
    scenario: 'gallery-cycle',
    sequence: 5,
    timestamp: 500,
  }), false);
});

test('profile-session command ordering releases gates only for matching command correlation', () => {
  const gate = {
    id: 'command-2',
    milestone: 'home_feed_scroll_settled',
    queueId: 'scroll-cycle-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 3,
  };

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'home_feed_scroll_settled',
    queueId: 'scroll-cycle-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 2,
    timestamp: 700,
  }), false);

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'home_feed_scroll_settled',
    queueId: 'other-scroll-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 3,
    timestamp: 700,
  }), false);

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'home_feed_scroll_settled',
    queueId: 'scroll-cycle-queue',
    runId: 'run-1',
    scenario: 'scroll-cycle',
    sequence: 3,
    timestamp: 700,
  }), true);
});

test('profile-session command ordering rejects uncorrelated milestone events', () => {
  const gate = {
    id: 'command-3',
    milestone: 'surface_ready',
    queueId: 'startup-queue',
    runId: 'run-1',
    scenario: 'startup',
    sequence: 1,
  };

  assert.equal(doesProfileEventReleaseCommandGate(gate, {
    event: 'surface_ready',
    runId: 'run-1',
    scenario: 'startup',
    timestamp: 900,
  }), false);
});

test('profile-session command dependencies wait for setup milestones without sequence binding', () => {
  const command = {
    command: 'scroll-to-feed-end',
    dependsOnMilestones: ['home_feed_profile_ready', 'app_first_usable_screen'],
    id: 'ios-storage-command-1',
    queueId: 'home-feed-pagination-stress',
    runId: 'ios-pagination-run',
    scenario: 'home-feed-pagination-stress',
    sequence: 1,
    timestamp: 1000,
    waitForMilestone: 'home_feed_pagination_requested',
  };

  assert.equal(hasObservedProfileCommandDependencies(command, [
    {
      event: 'home_feed_profile_ready',
      queueId: 'home-feed-pagination-stress',
      runId: 'ios-pagination-run',
      scenario: 'home-feed-pagination-stress',
      timestamp: 1100,
    },
  ]), false);

  assert.equal(hasObservedProfileCommandDependencies(command, [
    {
      event: 'home_feed_profile_ready',
      queueId: 'home-feed-pagination-stress',
      runId: 'ios-pagination-run',
      scenario: 'home-feed-pagination-stress',
      sequence: 99,
      timestamp: 1100,
    },
    {
      event: 'app_first_usable_screen',
      queueId: 'home-feed-pagination-stress',
      runId: 'ios-pagination-run',
      scenario: 'home-feed-pagination-stress',
      timestamp: 1200,
    },
  ]), true);
});

test('profile-session dependency queue ownership is symmetric when queue id is absent', () => {
  const queueLessCommand = {
    command: 'open-surface',
    dependsOnMilestones: ['surface_ready'],
    id: 'queue-less-command',
    runId: 'run-1',
    scenario: 'surface-flow',
    timestamp: 100,
  };
  const event = {
    event: 'surface_ready',
    runId: 'run-1',
    scenario: 'surface-flow',
    timestamp: 200,
  };

  assert.equal(hasObservedProfileCommandDependencies(queueLessCommand, [event]), true);
  assert.equal(hasObservedProfileCommandDependencies(queueLessCommand, [{
    ...event,
    queueId: 'explicit-other-queue',
  }]), false);
  assert.equal(hasObservedProfileCommandDependencies({
    ...queueLessCommand,
    queueId: 'explicit-queue',
  }, [event]), false);
});

test('profile-session dependency gates resolve missing milestones and bounded deadlines', () => {
  const command = {
    commandId: 'open-viewer',
    dependsOnMilestones: ['gallery_ready', 'video_ready'],
    id: 'command-8',
    queueId: 'gallery-flow',
    runId: 'run-1',
    scenario: 'gallery-stress',
    sequence: 8,
    stopOnFailure: true,
    timestamp: 1_000,
  };
  const observedEvents = [{
    event: 'gallery_ready',
    queueId: 'gallery-flow',
    runId: 'run-1',
    scenario: 'gallery-stress',
    timestamp: 1_100,
  }];

  assert.deepEqual(resolveMissingProfileCommandDependencies(command, observedEvents), ['video_ready']);
  const gate = buildProfileCommandDependencyGate(command, observedEvents);
  assert.deepEqual(gate, {
    commandId: 'open-viewer',
    commandTimestamp: 1_000,
    id: 'command-8',
    missingDependencies: ['video_ready'],
    queueId: 'gallery-flow',
    runId: 'run-1',
    scenario: 'gallery-stress',
    sequence: 8,
    stopOnFailure: true,
    waitTimeoutMs: 30_000,
  });
  assert.equal(doesProfileCommandMatchDependencyGate(gate, command), true);
  assert.equal(doesProfileCommandMatchDependencyGate(gate, { ...command, runId: 'other-run' }), false);
  assert.equal(doesProfileCommandMatchDependencyGate(gate, { ...command, sequence: 9 }), false);
  assert.deepEqual(resolveMissingProfileCommandDependencies(command, [
    ...observedEvents,
    {
      event: 'video_ready',
      queueId: 'gallery-flow',
      runId: 'other-run',
      scenario: 'gallery-stress',
      timestamp: 1_200,
    },
  ]), ['video_ready'], 'wrong-run evidence cannot release the dependency gate');
  assert.equal(buildProfileCommandDependencyGate(command, [
    ...observedEvents,
    {
      event: 'video_ready',
      queueId: 'gallery-flow',
      runId: 'run-1',
      scenario: 'gallery-stress',
      timestamp: 1_300,
    },
  ]), null, 'matching evidence releases the dependency before its deadline');
  assert.equal(resolveProfileCommandWaitTimeoutMs(4_500), 4_500);
  assert.equal(resolveProfileCommandWaitTimeoutMs(0), 30_000);
  assert.equal(resolveProfileCommandWaitTimeoutMs(Number.NaN), 30_000);
});

test('profile-session dependency timeout policy preserves stop and continue semantics', () => {
  const stop = resolveProfileCommandDependencyTimeoutOutcome(true);
  assert.deepEqual(stop, {
    kind: 'terminal',
    reason: 'dependency-timeout-stop',
  });
  assert.deepEqual(resolveProfileCommandDependencyTimeoutOutcome(undefined), {
    kind: 'terminal',
    reason: 'dependency-timeout-stop',
  });
  const proceed = resolveProfileCommandDependencyTimeoutOutcome(false);
  assert.deepEqual(proceed, {
    kind: 'continue',
    reason: 'dependency-timeout-continue',
  });
});
