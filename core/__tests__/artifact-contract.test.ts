const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildBudgetVerdict,
  buildCausalRun,
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
    comparisonLane: 'android-adb',
    durationMs: 1250,
    endedAt: '2026-01-01T00:00:01.250Z',
    interactionDriver: 'adb-logcat',
    runId: 'public-journey-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'passed',
  });
  assert.deepEqual(manifest.environment, {
    bundleId: 'dev.agent.example',
    nodeVersion: 'v24.0.0',
    platform: 'android',
    runtimeTarget: {
      name: 'Pixel_8',
      udid: 'emulator-5554',
    },
  });
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
