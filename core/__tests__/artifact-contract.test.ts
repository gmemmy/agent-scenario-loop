const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBudgetVerdict,
  buildCausalRun,
  buildCausalTimeline,
  buildManifest,
  buildMetricsFromProfileEvents,
} = require('../artifact-contract');
const { SCHEMAS, validateJson } = require('../schema-validator');

function sampleDiagnostics() {
  return [
    {
      kind: 'logs',
      name: 'device-log',
      status: 'captured',
      required: true,
      path: 'raw/device.log',
      reason: 'Device log evidence was captured.',
    },
    {
      kind: 'video',
      status: 'not_requested',
      required: false,
      reason: 'Scenario did not request this optional diagnostic surface.',
    },
  ];
}

function sampleManifestArtifacts() {
  return {
    causalRun: 'causal-run.json',
    budgetVerdict: 'budget-verdict.json',
    manifest: 'manifest.json',
    metrics: 'metrics.json',
    summary: 'summary.md',
    scenario: 'scenario.json',
    raw: {
      interactionLog: 'raw/interaction.log',
      deviceLog: 'raw/device.log',
    },
    captures: {
      video: 'captures/run.mp4',
      uiTree: 'captures/ui-tree.json',
      screenshots: ['captures/first.png'],
    },
    signals: {
      js: [],
      memory: [],
      network: [],
    },
    diagnostics: sampleDiagnostics(),
  };
}

function unknownLifecycleAssertion() {
  return {
    evidence: 'not-asserted',
    value: 'unknown',
  };
}

function sampleEnvironmentLifecycle() {
  return {
    postconditions: {
      appState: unknownLifecycleAssertion(),
      artifactState: unknownLifecycleAssertion(),
      lifecyclePhase: unknownLifecycleAssertion(),
      cleanupState: unknownLifecycleAssertion(),
      dataState: unknownLifecycleAssertion(),
    },
    preconditions: {
      animations: unknownLifecycleAssertion(),
      appDataState: unknownLifecycleAssertion(),
      authState: unknownLifecycleAssertion(),
      deviceLockState: unknownLifecycleAssertion(),
      fontScale: unknownLifecycleAssertion(),
      foregroundState: unknownLifecycleAssertion(),
      lifecyclePhase: unknownLifecycleAssertion(),
      initialRoute: unknownLifecycleAssertion(),
      installedState: unknownLifecycleAssertion(),
      locale: unknownLifecycleAssertion(),
      networkState: unknownLifecycleAssertion(),
      orientation: unknownLifecycleAssertion(),
      permissions: unknownLifecycleAssertion(),
      theme: unknownLifecycleAssertion(),
      timezone: unknownLifecycleAssertion(),
    },
  };
}

test('builds schema-valid manifest provenance attempt and environment artifacts', () => {
  const manifest = buildManifest({
    scenario: 'public-journey',
    scenarioHash: 'a'.repeat(64),
    runId: 'public-journey-1',
    platform: 'android',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.250Z',
    interactionDriver: 'adb-logcat',
    comparisonLane: 'android-adb',
    simulator: {
      name: 'Pixel_8',
      udid: 'emulator-5554',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'abc123',
    toolVersions: {
      node: 'v24.0.0',
    },
    cohort: {
      appVersion: '1.2.3',
      buildId: 'build-123',
      buildMode: 'dev-debug',
      commandTransport: 'profile-session-storage',
      deviceClass: 'simulator',
      featureFlags: {
        betaFlow: true,
      },
      osVersion: 'Android 15',
      platform: 'android',
      providers: [{ name: 'accessibility-provider', version: '0.1.0' }],
      runnerName: 'adb-logcat',
      runnerVersion: '0.1.2',
      seedIdentity: 'fixture-seed-v1',
    },
    artifacts: sampleManifestArtifacts(),
  });

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.deepEqual(manifest.provenance, {
    cohort: {
      appVersion: '1.2.3',
      buildId: 'build-123',
      buildMode: 'dev-debug',
      commandTransport: 'profile-session-storage',
      deviceClass: 'simulator',
      featureFlags: {
        betaFlow: true,
      },
      osVersion: 'Android 15',
      platform: 'android',
      providers: [{ name: 'accessibility-provider', version: '0.1.0' }],
      runnerName: 'adb-logcat',
      runnerVersion: '0.1.2',
      seedIdentity: 'fixture-seed-v1',
    },
    cohortHash: manifest.provenance.cohortHash,
    gitSha: 'abc123',
    scenarioHash: 'a'.repeat(64),
    toolVersions: {
      node: 'v24.0.0',
    },
  });
  assert.match(manifest.provenance.cohortHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(manifest.attempt, {
    attemptId: 'public-journey-1',
    attemptNumber: 1,
    classification: {
      category: 'none',
    },
    cleanup: {
      status: 'not-required',
    },
    comparisonLane: 'android-adb',
    durationMs: 1250,
    endedAt: '2026-01-01T00:00:01.250Z',
    interactionDriver: 'adb-logcat',
    maxAttempts: 1,
    partialArtifacts: {
      reason: 'complete successful run artifacts are present',
      valid: false,
    },
    runId: 'public-journey-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'passed',
    terminalState: 'passed',
  });
  assert.deepEqual(manifest.environment, {
    bundleId: 'dev.agent.example',
    nodeVersion: 'v24.0.0',
    platform: 'android',
    ...sampleEnvironmentLifecycle(),
    runtimeTarget: {
      name: 'Pixel_8',
      udid: 'emulator-5554',
    },
  });
});

test('builds schema-valid manifest with asserted mobile lifecycle phases', () => {
  const manifest = buildManifest({
    scenario: 'public-journey',
    runId: 'public-journey-rich-lifecycle',
    platform: 'ios',
    status: 'failed',
    terminalState: 'unhealthy',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:02.000Z',
    interactionDriver: 'simctl',
    preconditions: {
      lifecyclePhase: {
        value: 'cold-launch',
        evidence: 'observed',
        source: 'runner',
        artifact: 'raw/ios-app-lifecycle-log.txt',
      },
    },
    postconditions: {
      lifecyclePhase: {
        value: 'os-reclaim',
        evidence: 'inferred',
        source: 'host diagnostics',
        artifact: 'raw/ios-host-diagnostic-report-search.txt',
      },
    },
    simulator: {
      name: 'iPhone 16',
      udid: 'SIM-UDID',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'abc123',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts: sampleManifestArtifacts(),
    failureReason: 'Runtime became unhealthy after OS reclaim.',
  });

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.equal(manifest.attempt.terminalState, 'unhealthy');
  assert.deepEqual(manifest.environment.preconditions.lifecyclePhase, {
    artifact: 'raw/ios-app-lifecycle-log.txt',
    evidence: 'observed',
    source: 'runner',
    value: 'cold-launch',
  });
  assert.deepEqual(manifest.environment.postconditions.lifecyclePhase, {
    artifact: 'raw/ios-host-diagnostic-report-search.txt',
    evidence: 'inferred',
    source: 'host diagnostics',
    value: 'os-reclaim',
  });
});

test('builds schema-valid failed attempt semantics for preserved partial artifacts', () => {
  const manifest = buildManifest({
    scenario: 'public-journey',
    runId: 'public-journey-timeout',
    attemptId: 'attempt-2',
    platform: 'android',
    status: 'failed',
    terminalState: 'timeout',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:10.000Z',
    interactionDriver: 'adb-logcat',
    classification: {
      category: 'timeout',
      code: 'milestone_timeout',
      message: 'Milestone did not settle before the scenario deadline.',
      retryable: true,
    },
    cleanup: {
      status: 'partial',
      message: 'Log capture stopped but device state cleanup did not complete.',
      artifacts: ['raw/cleanup.txt'],
    },
    partialArtifacts: {
      valid: true,
      reason: 'timeout run preserved raw evidence for diagnosis',
      paths: ['manifest.json', 'health.json', 'raw/interaction.log'],
    },
    simulator: {
      name: 'Pixel_8',
      udid: 'emulator-5554',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'abc123',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts: sampleManifestArtifacts(),
    failureReason: 'Milestone did not settle before the scenario deadline.',
  });

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.deepEqual(manifest.attempt, {
    attemptId: 'attempt-2',
    attemptNumber: 1,
    classification: {
      category: 'timeout',
      code: 'milestone_timeout',
      message: 'Milestone did not settle before the scenario deadline.',
      retryable: true,
    },
    cleanup: {
      artifacts: ['raw/cleanup.txt'],
      message: 'Log capture stopped but device state cleanup did not complete.',
      status: 'partial',
    },
    durationMs: 10000,
    endedAt: '2026-01-01T00:00:10.000Z',
    interactionDriver: 'adb-logcat',
    maxAttempts: 1,
    partialArtifacts: {
      paths: ['health.json', 'manifest.json', 'raw/interaction.log'],
      reason: 'timeout run preserved raw evidence for diagnosis',
      valid: true,
    },
    runId: 'public-journey-timeout',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'failed',
    terminalState: 'timeout',
  });
});

test('builds schema-valid cancelled attempt semantics with preserved partial artifacts', () => {
  const manifest = buildManifest({
    scenario: 'public-journey',
    runId: 'public-journey-cancelled',
    attemptId: 'attempt-cancelled',
    platform: 'ios',
    status: 'failed',
    terminalState: 'cancelled',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    interactionDriver: 'ios-simctl',
    classification: {
      category: 'cancelled',
      code: 'operator_cancelled',
      message: 'Operator cancelled the run before completion.',
      retryable: true,
    },
    cleanup: {
      status: 'passed',
      message: 'Runner stopped capture and left preserved artifacts in place.',
      artifacts: ['raw/cleanup.txt'],
    },
    partialArtifacts: {
      valid: true,
      reason: 'cancelled run preserved raw evidence for diagnosis',
      paths: ['manifest.json', 'health.json', 'raw/device.log'],
    },
    simulator: {
      name: 'iPhone 16',
      udid: 'SIM-UDID',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'abc123',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts: sampleManifestArtifacts(),
    failureReason: 'Operator cancelled the run before completion.',
  });

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.equal(manifest.attempt.terminalState, 'cancelled');
  assert.equal(manifest.attempt.attemptNumber, 1);
  assert.equal(manifest.attempt.maxAttempts, 1);
  assert.equal(manifest.attempt.classification.category, 'cancelled');
  assert.equal(manifest.attempt.cleanup.status, 'passed');
  assert.deepEqual(manifest.attempt.partialArtifacts.paths, ['health.json', 'manifest.json', 'raw/device.log']);
});

test('builds schema-valid retry attempt lineage', () => {
  const manifest = buildManifest({
    scenario: 'public-journey',
    runId: 'public-journey-retry',
    attemptId: 'attempt-2',
    attemptNumber: 2,
    maxAttempts: 3,
    retryOfAttemptId: 'attempt-1',
    retryReason: 'Previous attempt timed out while waiting for a milestone.',
    platform: 'android',
    status: 'passed',
    terminalState: 'passed',
    startedAt: '2026-01-01T00:01:00.000Z',
    endedAt: '2026-01-01T00:01:02.000Z',
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel_8',
      udid: 'emulator-5554',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'abc123',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts: sampleManifestArtifacts(),
  });

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.deepEqual({
    attemptId: manifest.attempt.attemptId,
    attemptNumber: manifest.attempt.attemptNumber,
    maxAttempts: manifest.attempt.maxAttempts,
    retryOfAttemptId: manifest.attempt.retryOfAttemptId,
    retryReason: manifest.attempt.retryReason,
    terminalState: manifest.attempt.terminalState,
  }, {
    attemptId: 'attempt-2',
    attemptNumber: 2,
    maxAttempts: 3,
    retryOfAttemptId: 'attempt-1',
    retryReason: 'Previous attempt timed out while waiting for a milestone.',
    terminalState: 'passed',
  });
});

test('builds schema-valid non-success terminal attempt states', () => {
  const cases = [
    {
      terminalState: 'aborted',
      classification: {
        category: 'cancelled',
        code: 'operator_aborted',
        message: 'Operator aborted the run before completion.',
        retryable: true,
      },
      partialArtifacts: {
        valid: true,
        reason: 'aborted run preserved raw evidence for diagnosis',
        paths: ['manifest.json', 'health.json', 'raw/device.log'],
      },
    },
    {
      terminalState: 'unsupported',
      classification: {
        category: 'runner',
        code: 'platform_unsupported',
        message: 'Selected runner does not support this platform.',
        retryable: false,
      },
      partialArtifacts: {
        valid: true,
        reason: 'unsupported run preserved compatibility evidence',
        paths: ['manifest.json', 'health.json'],
      },
    },
    {
      terminalState: 'inconclusive',
      classification: {
        category: 'evidence',
        code: 'partial_evidence',
        message: 'Run produced partial evidence that cannot support a product verdict.',
        retryable: true,
      },
      partialArtifacts: {
        valid: true,
        reason: 'inconclusive run preserved partial evidence for diagnosis',
        paths: ['manifest.json', 'health.json', 'raw/device.log'],
      },
    },
  ];

  for (const terminalCase of cases) {
    const manifest = buildManifest({
      scenario: 'public-journey',
      runId: `public-journey-${terminalCase.terminalState}`,
      platform: 'android',
      status: 'failed',
      terminalState: terminalCase.terminalState,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:04.000Z',
      interactionDriver: 'adb-logcat',
      classification: terminalCase.classification,
      cleanup: {
        status: 'passed',
        message: 'Runner finalized and preserved available artifacts.',
        artifacts: ['raw/cleanup.txt'],
      },
      partialArtifacts: terminalCase.partialArtifacts,
      simulator: {
        name: 'Pixel_8',
        udid: 'emulator-5554',
      },
      bundleId: 'dev.agent.example',
      gitSha: 'abc123',
      toolVersions: {
        node: 'v24.0.0',
      },
      artifacts: sampleManifestArtifacts(),
      failureReason: terminalCase.classification.message,
    });

    assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
    assert.equal(manifest.attempt.terminalState, terminalCase.terminalState);
    assert.equal(manifest.attempt.partialArtifacts.valid, true);
  }
});

test('rejects mismatched cancellation and cleanup attempt semantics', () => {
  const baseOptions = {
    scenario: 'public-journey',
    runId: 'public-journey-cancelled',
    platform: 'ios',
    status: 'failed',
    terminalState: 'cancelled',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    interactionDriver: 'ios-simctl',
    classification: {
      category: 'cancelled',
      code: 'operator_cancelled',
      message: 'Operator cancelled the run before completion.',
    },
    cleanup: {
      status: 'passed',
      message: 'Runner stopped capture and left preserved artifacts in place.',
    },
    partialArtifacts: {
      valid: true,
      reason: 'cancelled run preserved raw evidence for diagnosis',
      paths: ['manifest.json'],
    },
    simulator: {
      name: 'iPhone 16',
      udid: 'SIM-UDID',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'abc123',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts: sampleManifestArtifacts(),
  };

  assert.throws(
    () => buildManifest({
      ...baseOptions,
      classification: {
        category: 'timeout',
      },
    }),
    /terminalState "cancelled" requires classification\.category "cancelled"/u,
  );
  assert.throws(
    () => buildManifest({
      ...baseOptions,
      partialArtifacts: {
        valid: true,
        reason: 'cancelled run preserved raw evidence for diagnosis',
      },
    }),
    /terminalState "cancelled" must record partialArtifacts\.paths/u,
  );
  assert.throws(
    () => buildManifest({
      ...baseOptions,
      cleanup: {
        status: 'partial',
      },
    }),
    /cleanup\.status "partial" must include a cleanup message/u,
  );
  assert.throws(
    () => buildManifest({
      ...baseOptions,
      attemptId: 'attempt-2',
      attemptNumber: 2,
      maxAttempts: 3,
    }),
    /retry attempts must record retryOfAttemptId/u,
  );
  assert.throws(
    () => buildManifest({
      ...baseOptions,
      attemptId: 'attempt-2',
      attemptNumber: 2,
      maxAttempts: 1,
      retryOfAttemptId: 'attempt-1',
      retryReason: 'Previous attempt timed out.',
    }),
    /attemptNumber 2 cannot exceed maxAttempts 1/u,
  );
  assert.throws(
    () => buildManifest({
      ...baseOptions,
      attemptId: 'attempt-1',
      attemptNumber: 1,
      maxAttempts: 2,
      retryOfAttemptId: 'attempt-0',
      retryReason: 'Not a retry.',
    }),
    /first attempts must not record retry lineage/u,
  );
});

test('builds schema-valid causal-run provenance reference to manifest', () => {
  const artifacts = sampleManifestArtifacts();
  const manifest = buildManifest({
    scenario: 'public-journey',
    scenarioHash: 'b'.repeat(64),
    runId: 'public-journey-1',
    platform: 'ios',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    interactionDriver: 'ios-simctl',
    simulator: {
      name: 'iPhone 16',
      udid: 'ios-sim-1',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'def456',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts,
  });
  const causalRun = buildCausalRun({
    scenario: {
      name: 'public-journey',
      description: 'Public journey',
    },
    flowId: 'public-journey',
    runId: 'public-journey-1',
    platform: 'ios',
    buildFlavor: 'unknown',
    interactionDriver: 'ios-simctl',
    budgets: {
      cycleP95Ms: 2000,
    },
    timeline: [],
    artifacts,
    manifest,
    metrics: {
      status: 'passed',
      iterations: 1,
    },
  });

  assert.equal(validateJson(causalRun, SCHEMAS.causalRun, 'Causal run artifact').valid, true);
  assert.deepEqual(causalRun.provenanceRef, {
    manifest: 'manifest.json',
    runId: 'public-journey-1',
    scenarioHash: 'b'.repeat(64),
  });
});

test('builds schema-valid causal-run partial iteration accounting', () => {
  const artifacts = sampleManifestArtifacts();
  const manifest = buildManifest({
    scenario: 'public-journey',
    scenarioHash: 'c'.repeat(64),
    runId: 'public-journey-partial',
    platform: 'android',
    status: 'failed',
    terminalState: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:03.000Z',
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel_8',
      udid: 'emulator-5554',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'ghi789',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts,
    failureReason: 'One expected iteration did not emit completion evidence.',
  });
  const causalRun = buildCausalRun({
    scenario: {
      name: 'public-journey',
      description: 'Public journey',
    },
    flowId: 'public-journey',
    runId: 'public-journey-partial',
    platform: 'android',
    buildFlavor: 'unknown',
    interactionDriver: 'adb-logcat',
    budgets: {
      failures: 0,
    },
    timeline: [],
    artifacts,
    manifest,
    metrics: {
      status: 'failed',
      iterations: 3,
      failures: 1,
      timeouts: 0,
      incompleteIterations: [3],
    },
  });

  assert.equal(validateJson(causalRun, SCHEMAS.causalRun, 'Causal run artifact').valid, true);
  assert.deepEqual(causalRun.iterationSummary, {
    completed: 2,
    expected: 3,
    failed: 1,
    incomplete: [3],
    status: 'partial',
    timeouts: 0,
  });
});

test('builds schema-valid causal-run without budget thresholds', () => {
  const artifacts = sampleManifestArtifacts();
  const manifest = buildManifest({
    scenario: 'public-journey',
    scenarioHash: 'd'.repeat(64),
    runId: 'public-journey-no-budgets',
    platform: 'ios',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    interactionDriver: 'ios-simctl',
    simulator: {
      name: 'iPhone 16',
      udid: 'ios-sim-1',
    },
    bundleId: 'dev.agent.example',
    gitSha: 'jkl012',
    toolVersions: {
      node: 'v24.0.0',
    },
    artifacts,
  });
  const causalRun = buildCausalRun({
    scenario: {
      name: 'public-journey',
      description: 'Public journey',
    },
    flowId: 'public-journey',
    runId: 'public-journey-no-budgets',
    platform: 'ios',
    buildFlavor: 'unknown',
    interactionDriver: 'ios-simctl',
    budgets: null,
    timeline: [],
    artifacts,
    manifest,
    metrics: {
      status: 'passed',
      iterations: 1,
      failures: 0,
      timeouts: 0,
      incompleteIterations: [],
    },
  });

  assert.equal(validateJson(causalRun, SCHEMAS.causalRun, 'Causal run artifact').valid, true);
  assert.deepEqual(causalRun.budgets, {});
});

test('preserves timeline command correlation metadata in schema-valid form', () => {
  const timeline = buildCausalTimeline({
    events: [
      {
        event: 'card_open_requested',
        runId: 'correlated-run',
        scenario: 'open-close-cycle',
        iteration: 2,
        atMs: 120,
        sequence: 4,
        queueId: 'open-close-cycle',
        commandId: 'open-card',
        operationId: 'op-004',
        attemptId: 'attempt-001',
        clockDomain: 'monotonic',
      },
    ],
    owner: 'open-close-cycle',
  });

  assert.deepEqual(timeline, [
    {
      atMs: 120,
      metadata: {
        attemptId: 'attempt-001',
        clockDomain: 'monotonic',
        commandId: 'open-card',
        iteration: 2,
        operationId: 'op-004',
        queueId: 'open-close-cycle',
        sequence: 4,
      },
      name: 'card_open_requested',
      owner: 'open-close-cycle',
      phase: 'intent',
      status: 'started',
    },
  ]);
});

test('adds profile-session command acknowledgements to causal timelines', () => {
  const timeline = buildCausalTimeline({
    events: [
      {
        event: 'card_opened',
        runId: 'command-run',
        scenario: 'open-close-cycle',
        atMs: 180,
      },
    ],
    sessionEntries: [
      {
        kind: 'command',
        scenario: 'open-close-cycle',
        runId: 'command-run',
        command: 'activate-target:example-card-1',
        commandId: 'open-card',
        queueId: 'open-close-cycle',
        sequence: 1,
        source: 'storage',
        status: 'received',
        atMs: 100,
        waitForMilestone: 'card_opened',
        waitMs: 300,
        waitTimeoutMs: 1500,
      },
      {
        kind: 'command',
        scenario: 'open-close-cycle',
        runId: 'command-run',
        command: 'activate-target:example-card-1',
        commandId: 'open-card',
        queueId: 'open-close-cycle',
        result: 'target-dispatched',
        sequence: 1,
        source: 'storage',
        status: 'completed',
        atMs: 120,
        waitForMilestone: 'card_opened',
        waitMs: 300,
        waitTimeoutMs: 1500,
      },
    ],
    owner: 'open-close-cycle',
  });

  assert.deepEqual(timeline, [
    {
      atMs: 100,
      metadata: {
        command: 'activate-target:example-card-1',
        commandId: 'open-card',
        commandStatus: 'received',
        queueId: 'open-close-cycle',
        sequence: 1,
        source: 'storage',
        waitForMilestone: 'card_opened',
        waitMs: 300,
        waitTimeoutMs: 1500,
      },
      name: 'profile_command_received',
      owner: 'asl-command-transport',
      phase: 'intent',
      status: 'started',
    },
    {
      atMs: 120,
      metadata: {
        command: 'activate-target:example-card-1',
        commandId: 'open-card',
        commandStatus: 'completed',
        queueId: 'open-close-cycle',
        result: 'target-dispatched',
        sequence: 1,
        source: 'storage',
        waitForMilestone: 'card_opened',
        waitMs: 300,
        waitTimeoutMs: 1500,
      },
      name: 'profile_command_completed',
      owner: 'asl-command-transport',
      phase: 'intent',
      status: 'completed',
    },
    {
      atMs: 180,
      name: 'card_opened',
      owner: 'open-close-cycle',
      phase: 'navigation',
      status: 'completed',
    },
  ]);
});

test('builds baseline regression metadata without stale implementation disclaimers', () => {
  const verdict = buildBudgetVerdict({
    flowId: 'open-close-cycle',
    runId: 'current-run',
    baselineRunId: 'baseline-run',
    budgetEvaluation: {
      metric: 'profile budget',
      pass: true,
      checks: [
        {
          name: 'open p95',
          unit: 'ms',
          limit: 1000,
          actual: 900,
          pass: true,
        },
      ],
    },
  });
  const staleDisclaimer = ['not', 'implemented'].join(' ');

  assert.equal(validateJson(verdict, SCHEMAS.budgetVerdict, 'Budget verdict artifact').valid, true);
  assert.equal(verdict.regression.baselineRunId, 'baseline-run');
  assert.equal(verdict.regression.status, 'unknown');
  assert.match(verdict.regression.summary, /comparison\.json/u);
  assert.equal(verdict.regression.summary.includes(staleDisclaimer), false);
});

test('keeps first valid lifecycle timestamps when duplicate completion events arrive late', () => {
  const metrics = buildMetricsFromProfileEvents({
    scenario: 'scroll-settle',
    runId: 'android-live-scroll',
    expectedIterations: 1,
    cycleEventNames: {
      openRequested: 'feed_scroll_started',
      opened: 'feed_first_content_visible',
      closeRequested: 'feed_scroll_settle_requested',
      dismissed: 'feed_scroll_settled',
    },
    events: [
      { event: 'feed_scroll_started', iteration: 1, atMs: 100 },
      { event: 'feed_first_content_visible', iteration: 1, atMs: 140 },
      { event: 'feed_scroll_settle_requested', iteration: 1, atMs: 140 },
      { event: 'feed_scroll_settled', iteration: 1, atMs: 140 },
      { event: 'feed_first_content_visible', iteration: 1, atMs: 900 },
      { event: 'feed_scroll_settle_requested', iteration: 1, atMs: 900 },
      { event: 'feed_scroll_settled', iteration: 1, atMs: 900 },
    ],
  });

  assert.deepEqual(metrics.openDurationsMs, [40]);
  assert.deepEqual(metrics.durationsMs, [40]);
  assert.deepEqual(metrics.closeDurationsMs, [0]);
  assert.deepEqual(metrics.incompleteIterations, []);
});

test('treats milestone-only startup proof as a complete cycle', () => {
  const metrics = buildMetricsFromProfileEvents({
    scenario: 'app-startup',
    runId: 'android-live-startup',
    expectedIterations: 1,
    cycleEventNames: {
      milestone: 'home_ready',
    },
    budgets: {
      metric: 'startup first usable',
      pass: {
        cycleP95Ms: 1700,
      },
    },
    events: [
      { event: 'app_launch_requested', atMs: 0 },
      { event: 'home_ready', atMs: 1020 },
    ],
  });

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, [1020]);
  assert.deepEqual(metrics.openDurationsMs, [1020]);
  assert.deepEqual(metrics.closeDurationsMs, []);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(metrics.budgetEvaluation.pass, true);
});

test('measures custom transition milestone pairs as interval durations', () => {
  const metrics = buildMetricsFromProfileEvents({
    scenario: 'custom-transition',
    runId: 'android-live-transition',
    expectedIterations: 2,
    cycleEventNames: {
      closeRequested: 'surface_settled',
      dismissed: 'surface_settled',
      opened: 'surface_transition_requested',
      openRequested: 'surface_transition_requested',
    },
    budgets: {
      metric: 'milestone budget',
      pass: {
        cycleP95Ms: 300,
      },
    },
    events: [
      { event: 'surface_transition_requested', iteration: 1, atMs: 1200 },
      { event: 'surface_settled', iteration: 1, atMs: 1440 },
      { event: 'surface_transition_requested', iteration: 2, atMs: 2600 },
      { event: 'surface_settled', iteration: 2, atMs: 2870 },
    ],
  });

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, [240, 270]);
  assert.equal(metrics.p95Ms, 270);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(metrics.budgetEvaluation.pass, true);
});

test('counts repeated milestone-only cycles without explicit iteration payloads', () => {
  const metrics = buildMetricsFromProfileEvents({
    scenario: 'home-feed-scroll-stress',
    runId: 'android-live-scroll',
    expectedIterations: 6,
    cycleEventNames: {
      milestone: 'home_feed_scroll_settled',
    },
    budgets: {
      metric: 'milestone budget',
      pass: {
        cycleP95Ms: 1400,
        failures: 0,
      },
    },
    events: [
      { event: 'home_feed_profile_ready', atMs: 7558 },
      { event: 'home_feed_scroll_settled', atMs: 7939 },
      { event: 'home_feed_scroll_settled', atMs: 8489 },
      { event: 'home_feed_scroll_settled', atMs: 9155 },
      { event: 'home_feed_scroll_settled', atMs: 9158 },
      { event: 'home_feed_scroll_settled', atMs: 9458 },
      { event: 'home_feed_scroll_settled', atMs: 9876 },
    ],
  });

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, []);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(metrics.failures, 0);
  assert.equal(metrics.budgetEvaluation.pass, false);
});

test('counts multi-command milestone-only cycles without explicit iteration payloads', () => {
  const metrics = buildMetricsFromProfileEvents({
    scenario: 'home-feed-scope-switch-stress',
    runId: 'android-live-scope-switch',
    expectedIterations: 3,
    cycleEventNames: {
      milestone: 'home_feed_pill_change_settled',
    },
    milestoneEventsPerIteration: 3,
    budgets: {
      metric: 'milestone budget',
      pass: {
        cycleP95Ms: 2500,
        failures: 0,
      },
    },
    events: [
      { event: 'home_feed_pill_change_settled', atMs: 9232 },
      { event: 'home_feed_pill_change_settled', atMs: 10725 },
      { event: 'home_feed_pill_change_settled', atMs: 11480 },
      { event: 'home_feed_pill_change_settled', atMs: 13258 },
      { event: 'home_feed_pill_change_settled', atMs: 14020 },
      { event: 'home_feed_pill_change_settled', atMs: 15557 },
      { event: 'home_feed_pill_change_settled', atMs: 17100 },
      { event: 'home_feed_pill_change_settled', atMs: 18750 },
      { event: 'home_feed_pill_change_settled', atMs: 20216 },
    ],
  });

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, []);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(metrics.failures, 0);
});
