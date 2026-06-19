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
    artifacts: sampleManifestArtifacts(),
  });

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.deepEqual(manifest.provenance, {
    gitSha: 'abc123',
    scenarioHash: 'a'.repeat(64),
    toolVersions: {
      node: 'v24.0.0',
    },
  });
  assert.deepEqual(manifest.attempt, {
    attemptId: 'public-journey-1',
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
  assert.equal(manifest.attempt.classification.category, 'cancelled');
  assert.equal(manifest.attempt.cleanup.status, 'passed');
  assert.deepEqual(manifest.attempt.partialArtifacts.paths, ['health.json', 'manifest.json', 'raw/device.log']);
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
