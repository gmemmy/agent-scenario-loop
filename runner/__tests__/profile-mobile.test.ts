const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAndroidProfileSessionSidecarObservationChecks,
  buildProfileHealth,
  resolveProfileHelperVersionCheck,
  resolveProfileBudgetStatus,
  resolveProfileVerdictStatus,
  resolveProfileVerdictSummary,
} = require('../profile-mobile');
type TestContext = import('node:test').TestContext;

test('profile verdict policy keeps health and budget interpretation explicit', () => {
  const cases = [
    {
      name: 'failed health',
      budgetEvaluation: { pass: true },
      healthPassed: false,
      expectedBudgetStatus: 'passed',
      expectedVerdictStatus: 'inconclusive',
      expectedSummary: 'Scenario health did not pass; do not compare or optimize from this run.',
    },
    {
      name: 'no budgets',
      budgetEvaluation: undefined,
      healthPassed: true,
      expectedBudgetStatus: 'not_evaluated',
      expectedVerdictStatus: 'not_evaluated',
      expectedSummary: 'Scenario health passed; no profile budgets were configured.',
    },
    {
      name: 'partial budgets',
      budgetEvaluation: { status: 'partial' },
      healthPassed: true,
      expectedBudgetStatus: 'partial',
      expectedVerdictStatus: 'inconclusive',
      expectedSummary: 'Profile budgets were partially evaluated; unmeasurable checks are not product-performance failures.',
    },
    {
      name: 'passed budgets',
      budgetEvaluation: { status: 'passed' },
      healthPassed: true,
      expectedBudgetStatus: 'passed',
      expectedVerdictStatus: 'passed',
      expectedSummary: 'Profile budgets passed.',
    },
    {
      name: 'failed budgets',
      budgetEvaluation: { pass: false },
      healthPassed: true,
      expectedBudgetStatus: 'failed',
      expectedVerdictStatus: 'failed',
      expectedSummary: 'Profile budgets failed.',
    },
  ];

  for (const testCase of cases) {
    const budgetStatus = resolveProfileBudgetStatus(testCase.budgetEvaluation);
    assert.equal(budgetStatus, testCase.expectedBudgetStatus, testCase.name);
    assert.equal(
      resolveProfileVerdictStatus({
        budgetEvaluation: testCase.budgetEvaluation,
        budgetStatus,
        healthPassed: testCase.healthPassed,
      }),
      testCase.expectedVerdictStatus,
      testCase.name,
    );
    assert.equal(
      resolveProfileVerdictSummary({
        budgetEvaluation: testCase.budgetEvaluation,
        budgetStatus,
        healthPassed: testCase.healthPassed,
      }),
      testCase.expectedSummary,
      testCase.name,
    );
  }
});

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

test('profile health surfaces dependency gate timeout metadata with Android parity', () => {
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
        command: 'open-viewer',
        commandId: 'open-viewer',
        continuationReason: 'dependency-timeout-stop',
        missingDependencies: ['gallery_ready', 'video_ready'],
        queueId: 'mobile-command-cycle',
        sequence: 3,
        source: 'storage',
        status: 'skipped',
        reason: 'dependency-milestone-timeout',
        waitTimeoutMs: 30000,
      },
    ],
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'profile_command_sequence',
    status: 'failed',
    source: 'runner',
    code: 'profile_command_gate_timeout',
    message: 'One or more profile-session commands waited for required dependencies that were not observed before timeout.',
    metadata: {
      skippedCommandCount: 1,
      command: 'open-viewer',
      commandId: 'open-viewer',
      continuationReason: 'dependency-timeout-stop',
      missingDependencies: 'gallery_ready,video_ready',
      queueId: 'mobile-command-cycle',
      reason: 'dependency-milestone-timeout',
      sequence: 3,
      waitTimeoutMs: 30000,
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

test('profile health classifies incomplete truth after terminal profile-session commands', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-scroll-cycle',
      flowId: 'mobile-scroll-cycle',
    },
    runId: 'mobile-scroll-cycle-run',
    metrics: {
      failures: 2,
      status: 'failed',
      timeouts: 0,
    },
    profileEventCount: 12,
    profileSessionEntryCount: 6,
    commandTransport: 'profile-session-storage',
    sessionEntries: [
      {
        kind: 'command',
        scenario: 'mobile-scroll-cycle',
        runId: 'mobile-scroll-cycle-run',
        command: 'scroll-by:600',
        commandId: 'scroll-surface',
        queueId: 'mobile-scroll-cycle',
        sequence: 2,
        source: 'storage',
        status: 'completed',
        result: 'target-dispatched',
        waitForMilestone: 'surface_settled',
        waitTimeoutMs: 8000,
      },
      {
        kind: 'command',
        scenario: 'mobile-scroll-cycle',
        runId: 'mobile-scroll-cycle-run',
        command: 'scroll-by:600',
        commandId: 'scroll-surface',
        queueId: 'mobile-scroll-cycle',
        sequence: 3,
        source: 'storage',
        status: 'completed',
        result: 'target-dispatched',
        waitForMilestone: 'surface_settled',
        waitTimeoutMs: 8000,
      },
    ],
  });

  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].code, 'truth_events_incomplete');
  assert.equal(health.checks[0].metadata.completedCommandCount, 2);
  assert.equal(health.checks[0].metadata.milestoneBackedCommandCount, 2);
  assert.equal(health.checks[0].metadata.nextActionCode, 'inspect_truth_iteration_mapping');
  assert.match(
    health.checks[0].metadata.nextAction,
    /Profile-session commands reached terminal status/u,
  );
});

test('profile health records when final profile evidence reconciles an exhausted Android sidecar wait', async (t: TestContext) => {
  const sidecarRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-mobile-adb-sidecar-'));
  t.after(async () => {
    await fsp.rm(sidecarRoot, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(sidecarRoot, 'raw'), { recursive: true });
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'android-metadata.json'),
    `${JSON.stringify({
      profileSessionCompletionWait: {
        completed: false,
        elapsedMs: 120000,
        expectedCommandCount: 3,
        milestoneBackedSequences: [1],
        observedTerminalCommands: 1,
        pollCount: 120,
        rawPath: 'raw/adb-profile-session-early-log-3.txt',
        started: true,
        terminalSequences: [1],
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const sidecarObservationChecks = buildAndroidProfileSessionSidecarObservationChecks({
    args: {
      'adb-artifacts': sidecarRoot,
    },
    sessionEntries: [
      {
        kind: 'start',
        scenario: 'mobile-command-cycle',
        runId: 'mobile-command-cycle-run',
      },
      {
        kind: 'command',
        scenario: 'mobile-command-cycle',
        runId: 'mobile-command-cycle-run',
        commandId: 'open-card',
        sequence: 1,
        status: 'completed',
        waitForMilestone: 'card_opened',
      },
      {
        kind: 'command',
        scenario: 'mobile-command-cycle',
        runId: 'mobile-command-cycle-run',
        commandId: 'close-card',
        sequence: 2,
        status: 'completed',
      },
      {
        kind: 'command',
        scenario: 'mobile-command-cycle',
        runId: 'mobile-command-cycle-run',
        commandId: 'open-card',
        sequence: 3,
        status: 'completed',
        waitForMilestone: 'card_opened',
      },
    ],
  });
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
    commandTransport: 'profile-session-storage',
    profileEventCount: 12,
    profileSessionEntryCount: 4,
    sidecarObservationChecks,
  });

  const reconciliationCheck = health.checks.find((check: Record<string, unknown>) => (
    check.name === 'android_profile_session_sidecar_observation'
  ));
  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(reconciliationCheck, {
    name: 'android_profile_session_sidecar_observation',
    status: 'passed',
    source: 'runner',
    code: 'android_profile_session_completion_reconciled_from_profile_evidence',
    message: 'Final profile-session evidence contained terminal same-run command records after the Android sidecar completion wait exhausted.',
    metadata: {
      expectedCommandCount: 3,
      nextAction: 'Use the final profile health, verdict, metrics, and causal timeline for product interpretation; keep the sidecar wait metadata as early-capture diagnostic context.',
      nextActionCode: 'prefer_final_profile_evidence',
      profileDeliveredSequences: '1,2,3',
      profileMilestoneBackedSequences: '1,3',
      profileObservedDeliveredCommands: 3,
      profileObservedTerminalCommands: 3,
      profileStarted: true,
      profileTerminalSequences: '1,2,3',
      sidecarMilestoneBackedSequences: '1',
      sidecarObservedTerminalCommands: 1,
      sidecarRawPath: 'raw/adb-profile-session-early-log-3.txt',
      sidecarStarted: true,
      sidecarTerminalSequences: '1',
    },
  });
});

test('profile health records when final profile delivery reconciles an exhausted Android sidecar wait', async (t: TestContext) => {
  const sidecarRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-mobile-adb-sidecar-delivery-'));
  t.after(async () => {
    await fsp.rm(sidecarRoot, { recursive: true, force: true });
  });
  await fsp.mkdir(path.join(sidecarRoot, 'raw'), { recursive: true });
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'android-metadata.json'),
    `${JSON.stringify({
      profileSessionCompletionWait: {
        completed: false,
        elapsedMs: 120000,
        expectedCommandCount: 4,
        milestoneBackedSequences: [1, 2, 3],
        observedTerminalCommands: 3,
        pollCount: 120,
        rawPath: 'raw/adb-profile-session-early-log-2.txt',
        started: true,
        terminalSequences: [1, 2, 3],
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const sessionEntries = [
    {
      kind: 'start',
      scenario: 'mobile-command-cycle',
      runId: 'mobile-command-cycle-run',
    },
    ...[1, 2, 3, 4].map((sequence) => ({
      kind: 'command',
      scenario: 'mobile-command-cycle',
      runId: 'mobile-command-cycle-run',
      commandId: 'scroll-to-target',
      sequence,
      status: 'delivered',
      waitForMilestone: 'target_ready',
    })),
  ];
  const sidecarObservationChecks = buildAndroidProfileSessionSidecarObservationChecks({
    args: {
      'adb-artifacts': sidecarRoot,
    },
    sessionEntries,
  });
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
    commandTransport: 'profile-session-storage',
    profileEventCount: 20,
    profileSessionEntryCount: 9,
    sidecarObservationChecks,
  });

  const reconciliationCheck = health.checks.find((check: Record<string, unknown>) => (
    check.name === 'android_profile_session_sidecar_observation'
  ));
  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(reconciliationCheck, {
    name: 'android_profile_session_sidecar_observation',
    status: 'passed',
    source: 'runner',
    code: 'android_profile_session_delivery_reconciled_from_profile_evidence',
    message: 'Final profile-session evidence contained delivered same-run command records after the Android sidecar completion wait exhausted.',
    metadata: {
      expectedCommandCount: 4,
      nextAction: 'Use the final profile health, verdict, metrics, and causal timeline for product interpretation; keep the sidecar wait metadata as early-capture diagnostic context.',
      nextActionCode: 'prefer_final_profile_evidence',
      profileDeliveredSequences: '1,2,3,4',
      profileMilestoneBackedSequences: '1,2,3,4',
      profileObservedDeliveredCommands: 4,
      profileObservedTerminalCommands: 0,
      profileStarted: true,
      profileTerminalSequences: '',
      sidecarMilestoneBackedSequences: '1,2,3',
      sidecarObservedTerminalCommands: 3,
      sidecarRawPath: 'raw/adb-profile-session-early-log-2.txt',
      sidecarStarted: true,
      sidecarTerminalSequences: '1,2,3',
    },
  });
});

test('profile health does not misclassify incomplete truth without event counts', () => {
  const health = buildProfileHealth({
    scenario: {
      name: 'mobile-scroll-cycle',
      flowId: 'mobile-scroll-cycle',
    },
    runId: 'mobile-scroll-cycle-run',
    metrics: {
      failures: 2,
      status: 'failed',
      timeouts: 0,
    },
    profileSessionEntryCount: 6,
    commandTransport: 'profile-session-storage',
    sessionEntries: [
      {
        kind: 'command',
        scenario: 'mobile-scroll-cycle',
        runId: 'mobile-scroll-cycle-run',
        command: 'scroll-by:600',
        commandId: 'scroll-surface',
        queueId: 'mobile-scroll-cycle',
        sequence: 2,
        source: 'storage',
        status: 'completed',
        result: 'target-dispatched',
        waitForMilestone: 'surface_settled',
        waitTimeoutMs: 8000,
      },
    ],
  });

  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].code, 'truth_events_incomplete');
  assert.equal('nextActionCode' in health.checks[0].metadata, false);
  assert.equal('completedCommandCount' in health.checks[0].metadata, false);
  assert.equal('milestoneBackedCommandCount' in health.checks[0].metadata, false);
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

test('profile health fails when sidecar runtime identity is unverified', () => {
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

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'runtime_identity',
    status: 'failed',
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
      expectedVersion: '1.1.0',
      observedVersions: ['0.9.0'],
      reason: 'Profile evidence was emitted by app helper version 0.9.0, but this runner expects 1.1.0.',
      status: 'mismatched',
    },
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'profile_session_helper_version',
    status: 'failed',
    source: 'runner',
    code: 'profile_session_helper_version_mismatch',
    message: 'Profile evidence was emitted by app helper version 0.9.0, but this runner expects 1.1.0.',
    metadata: {
      expectedVersion: '1.1.0',
      observedVersions: '0.9.0',
      observedVersionCount: 1,
      nextAction: 'Update the app-side profile-session helper to the package version used by the runner, then rerun before trusting timing evidence.',
      nextActionCode: 'update_profile_session_helper',
    },
  });
});

test('profile health fails when app helper version is missing from profile evidence', () => {
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
      expectedVersion: '1.1.0',
      observedVersions: [],
      reason: 'Profile evidence did not include app helper version metadata.',
      status: 'missing',
    },
  });

  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(health.checks[1], {
    name: 'profile_session_helper_version',
    status: 'failed',
    source: 'runner',
    code: 'profile_session_helper_version_missing',
    message: 'Profile evidence did not include app helper version metadata.',
    metadata: {
      expectedVersion: '1.1.0',
      observedVersions: '',
      observedVersionCount: 0,
      nextAction: 'Use an app-side profile-session helper that emits helperVersion in session entries and profile events so ASL can verify helper/package compatibility.',
      nextActionCode: 'emit_profile_session_helper_version',
    },
  });
});

test('profile helper version evidence rejects mixed versioned and unversioned records', () => {
  assert.deepEqual(resolveProfileHelperVersionCheck({
    events: [
      { event: 'surface_opened', helperVersion: '1.1.0' },
      { event: 'surface_closed' },
    ],
    sessionEntries: [
      { helperVersion: '1.1.0', kind: 'start' },
    ],
  }), {
    expectedVersion: '1.1.0',
    observedVersions: ['1.1.0'],
    reason: 'Profile evidence did not include app helper version metadata.',
    status: 'missing',
  });
});
