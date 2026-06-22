const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProfileCommandMilestoneGate,
  compareProfileCommands,
  doesProfileEventReleaseCommandGate,
  hasObservedProfileCommandMilestone,
} = require('../../profile-session-command-ordering');

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

test('profile-session command ordering keeps legacy readiness milestones compatible', () => {
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
  }, observedEvents), true);
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

test('profile-session command ordering keeps legacy uncorrelated milestone events compatible', () => {
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
  }), true);
});
