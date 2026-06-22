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

test('profile health fails when sidecar runtime identity mismatches expected app id', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-runtime-identity',
      flowId: 'mobile-runtime-identity',
    },
    runId: 'mobile-runtime-identity-run',
    metrics: {
      failures: 0,
      status: 'passed',
      timeouts: 0,
    },
    runtimeIdentity: {
      expectedAppId: 'dev.expected.app',
      expectedAppIdSource: 'cli',
      nextAction: 'Rerun the adb sidecar with the expected package.',
      nextActionCode: 'rerun_sidecar_with_expected_runtime_identity',
      observedAppId: 'dev.other.app',
      platform: 'android',
      reason: 'Android adb sidecar metadata records package dev.other.app, but this profile run expected dev.expected.app.',
      sidecarMetadataPath: 'raw/android-metadata.json',
      status: 'mismatched',
    },
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'runtime_identity',
    status: 'failed',
    source: 'runner',
    code: 'runtime_identity_mismatch',
    message: 'Android adb sidecar metadata records package dev.other.app, but this profile run expected dev.expected.app.',
    metadata: {
      platform: 'android',
      identityStatus: 'mismatched',
      sidecarMetadataPath: 'raw/android-metadata.json',
      nextAction: 'Rerun the adb sidecar with the expected package.',
      nextActionCode: 'rerun_sidecar_with_expected_runtime_identity',
      expectedAppId: 'dev.expected.app',
      expectedAppIdSource: 'cli',
      observedAppId: 'dev.other.app',
    },
  });
});

test('profile health records unverified sidecar runtime identity without failing passed metrics', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-runtime-identity',
      flowId: 'mobile-runtime-identity',
    },
    runId: 'mobile-runtime-identity-run',
    metrics: {
      failures: 0,
      status: 'passed',
      timeouts: 0,
    },
    runtimeIdentity: {
      expectedAppId: 'dev.expected.app',
      expectedAppIdSource: 'cli',
      nextAction: 'Use a simctl capture sidecar that writes raw/ios-metadata.json.',
      nextActionCode: 'capture_runtime_identity_metadata',
      platform: 'ios',
      reason: 'iOS simctl sidecar metadata did not include enough runtime identity to verify the expected app or target.',
      sidecarMetadataPath: 'raw/ios-metadata.json',
      status: 'unverified',
    },
  });

  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(health.checks[1], {
    name: 'runtime_identity',
    status: 'warning',
    source: 'runner',
    code: 'runtime_identity_unverified',
    message: 'iOS simctl sidecar metadata did not include enough runtime identity to verify the expected app or target.',
    metadata: {
      platform: 'ios',
      identityStatus: 'unverified',
      sidecarMetadataPath: 'raw/ios-metadata.json',
      nextAction: 'Use a simctl capture sidecar that writes raw/ios-metadata.json.',
      nextActionCode: 'capture_runtime_identity_metadata',
      expectedAppId: 'dev.expected.app',
      expectedAppIdSource: 'cli',
    },
  });
});

test('profile health fails when app helper version mismatches the runner contract', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-helper-version',
      flowId: 'mobile-helper-version',
    },
    runId: 'mobile-helper-version-run',
    metrics: {
      failures: 0,
      status: 'passed',
      timeouts: 0,
    },
    helperVersion: {
      expectedVersion: '1.0.0',
      observedVersions: ['0.9.0'],
      reason: 'Profile evidence was emitted by app helper version 0.9.0, but this runner expects 1.0.0.',
      status: 'mismatched',
    },
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'profile_session_helper_version',
    status: 'failed',
    source: 'runner',
    code: 'profile_session_helper_version_mismatch',
    message: 'Profile evidence was emitted by app helper version 0.9.0, but this runner expects 1.0.0.',
    metadata: {
      expectedVersion: '1.0.0',
      observedVersions: '0.9.0',
      observedVersionCount: 1,
      nextAction: 'Update the app-side profile-session helper to the package version used by the runner, then rerun before trusting timing evidence.',
      nextActionCode: 'update_profile_session_helper',
    },
  });
});

test('profile health warns when app helper version is missing from profile evidence', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-helper-version',
      flowId: 'mobile-helper-version',
    },
    runId: 'mobile-helper-version-run',
    metrics: {
      failures: 0,
      status: 'passed',
      timeouts: 0,
    },
    helperVersion: {
      expectedVersion: '1.0.0',
      observedVersions: [],
      reason: 'Profile evidence did not include app helper version metadata.',
      status: 'missing',
    },
  });

  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(health.checks[1], {
    name: 'profile_session_helper_version',
    status: 'warning',
    source: 'runner',
    code: 'profile_session_helper_version_missing',
    message: 'Profile evidence did not include app helper version metadata.',
    metadata: {
      expectedVersion: '1.0.0',
      observedVersions: '',
      observedVersionCount: 0,
      nextAction: 'Use an app-side profile-session helper that emits helperVersion in session entries and profile events so ASL can verify helper/package compatibility.',
      nextActionCode: 'emit_profile_session_helper_version',
    },
  });
});
