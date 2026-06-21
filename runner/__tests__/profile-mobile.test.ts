const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProfileHealth,
} = require('../profile-mobile');

test('profile health surfaces command gate timeouts explicitly', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-command-cycle',
      flowId: 'mobile-command-cycle',
    },
    runId: 'mobile-command-cycle-run',
    metrics: {
      failures: 1,
      status: 'failed',
      timeouts: 0,
    },
    profileEventCount: 4,
    profileSessionEntryCount: 3,
    commandTransport: 'profile-session-storage',
    sessionEntries: [
      {
        kind: 'command',
        scenario: 'mobile-command-cycle',
        runId: 'mobile-command-cycle-run',
        command: 'reset-surface',
        commandId: 'reset-surface',
        queueId: 'mobile-command-cycle',
        sequence: 3,
        source: 'storage',
        status: 'skipped',
        reason: 'wait-for-milestone-timeout',
        waitForMilestone: 'surface_ready',
        waitTimeoutMs: 120000,
      },
    ],
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'profile_command_sequence',
    status: 'failed',
    source: 'runner',
    code: 'profile_command_gate_timeout',
    message: 'One or more profile-session commands waited for a milestone that was not observed before timeout.',
    metadata: {
      skippedCommandCount: 1,
      command: 'reset-surface',
      commandId: 'reset-surface',
      queueId: 'mobile-command-cycle',
      reason: 'wait-for-milestone-timeout',
      sequence: 3,
      waitForMilestone: 'surface_ready',
      waitTimeoutMs: 120000,
    },
  });
});

test('profile health fails when command sequence fails even if truth metrics pass', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-command-cycle',
      flowId: 'mobile-command-cycle',
    },
    runId: 'mobile-command-cycle-run',
    metrics: {
      failures: 0,
      status: 'passed',
      timeouts: 0,
    },
    profileEventCount: 8,
    profileSessionEntryCount: 6,
    commandTransport: 'profile-session-storage',
    sessionEntries: [
      {
        kind: 'command',
        scenario: 'mobile-command-cycle',
        runId: 'mobile-command-cycle-run',
        command: 'switch-mode',
        commandId: 'switch-mode',
        queueId: 'mobile-command-cycle',
        sequence: 4,
        source: 'storage',
        status: 'skipped',
        reason: 'wait-for-milestone-timeout',
        waitForMilestone: 'mode_settled',
        waitTimeoutMs: 8000,
      },
    ],
  });

  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].status, 'passed');
  assert.equal(health.checks[1].name, 'profile_command_sequence');
  assert.equal(health.checks[1].status, 'failed');
});

test('profile health fails when an explicit required diagnostic is unavailable', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-required-video',
      flowId: 'mobile-required-video',
    },
    runId: 'mobile-required-video-run',
    metrics: {
      failures: 0,
      status: 'passed',
      timeouts: 0,
    },
    diagnostics: [
      {
        kind: 'video',
        status: 'unavailable',
        required: true,
        reason: 'No video capture was produced by the selected runner/provider set.',
        nextAction: 'Use --capture video:<path> or run a capture provider that records video.',
      },
    ],
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'required_video_diagnostic',
    status: 'failed',
    source: 'evidence',
    code: 'required_diagnostic_not_captured',
    message: 'No video capture was produced by the selected runner/provider set.',
    metadata: {
      kind: 'video',
      status: 'unavailable',
      nextAction: 'Use --capture video:<path> or run a capture provider that records video.',
    },
  });
});
