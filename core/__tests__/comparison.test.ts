const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildComparisonArtifact,
  compareBudgetCheck,
} = require('../comparison');
const { SCHEMAS, validateJson } = require('../schema-validator');

type JsonRecord = Record<string, any>;

/**
 * Builds a schema-valid health artifact for comparison tests.
 *
 * @param {{runId: string, healthStatus?: string}} options
 * @returns {Record<string, unknown>}
 */
function health({ runId, healthStatus = 'passed' }: { runId: string; healthStatus?: string }): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    scenarioId: 'open-close-cycle',
    flowId: 'open-close-cycle',
    runId,
    healthStatus,
    checks: [{ name: 'truth_events_complete', status: healthStatus, source: 'truth' }],
  };
}

/**
 * Builds a schema-valid verdict artifact for comparison tests.
 *
 * @param {{runId: string, actual: number, pass?: boolean, verdictStatus?: string}} options
 * @returns {Record<string, unknown>}
 */
function verdict({
  runId,
  actual,
  pass = true,
  verdictStatus = 'passed',
}: {
  runId: string;
  actual: number;
  pass?: boolean;
  verdictStatus?: string;
}): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    scenarioId: 'open-close-cycle',
    flowId: 'open-close-cycle',
    runId,
    healthStatus: 'passed',
    verdictStatus,
    budgetChecks: [
      {
        name: 'open p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        expected: 1000,
        actual,
        pass,
      },
    ],
  };
}

test('compares numeric budget actuals with lower values treated as better', () => {
  assert.deepEqual(
    compareBudgetCheck(
      { name: 'open p95', unit: 'ms', actual: 1200, pass: false },
      { name: 'open p95', unit: 'ms', actual: 900, pass: true },
    ),
    {
      name: 'open p95',
      unit: 'ms',
      baseline: 1200,
      current: 900,
      delta: -300,
      status: 'better',
    },
  );
});

test('rejects faster-looking non-finite budget samples as inconclusive', () => {
  assert.deepEqual(
    compareBudgetCheck(
      { name: 'open p95', unit: 'ms', actual: 900, pass: true },
      { name: 'open p95', unit: 'ms', actual: Number.NEGATIVE_INFINITY, pass: true },
    ),
    {
      name: 'open p95',
      unit: 'ms',
      baseline: 900,
      current: null,
      delta: null,
      status: 'inconclusive',
      notes: 'Only finite numeric budget actuals are compared by direction.',
    },
  );

  for (const invalidActual of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      compareBudgetCheck(
        { name: 'open p95', unit: 'ms', actual: invalidActual, pass: true },
        { name: 'open p95', unit: 'ms', actual: invalidActual, pass: true },
      ).status,
      'inconclusive',
    );
  }
});

test('normalizes invalid samples in schema-valid persisted comparison artifacts', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 900 }),
    currentHealth: health({ runId: 'invalid-current-run' }),
    currentVerdict: verdict({ runId: 'invalid-current-run', actual: Number.NEGATIVE_INFINITY }),
  });

  assert.equal(comparison.comparisonStatus, 'inconclusive');
  assert.deepEqual(comparison.metricComparisons[0], {
    name: 'open p95',
    unit: 'ms',
    baseline: 900,
    current: null,
    delta: null,
    status: 'inconclusive',
    notes: 'Only finite numeric budget actuals are compared by direction.',
  });
  assert.equal(comparison.measurementPolicy.samples.current.validSamples, 0);
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
  assert.deepEqual(JSON.parse(JSON.stringify(comparison)), comparison);
});

test('keeps explicitly incompatible scenario contracts out of ordinary comparison truth', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 900 }),
    comparisonBasis: {
      strategy: 'explicit',
      baseline: { runId: 'baseline-run' },
      current: { runId: 'current-run' },
      scenarioContract: {
        status: 'incompatible',
        reason: 'scenario_hash_mismatch',
        baselineHash: 'a'.repeat(64),
        currentHash: 'b'.repeat(64),
      },
    },
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict: verdict({ runId: 'current-run', actual: 800 }),
  });

  assert.equal(comparison.comparisonStatus, 'inconclusive');
  assert.equal(comparison.healthStatus, 'failed');
  assert.equal(comparison.metricComparisons, undefined);
  assert.match(comparison.evidence.missingRequired[0], /compatible scenario contract/u);
});

test('derives incompatible scenario contracts from manifests for direct comparisons', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineManifest: {
      scenarioId: 'open-close-cycle',
      scenarioHash: 'a'.repeat(64),
    },
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 900 }),
    currentHealth: health({ runId: 'current-run' }),
    currentManifest: {
      scenarioId: 'open-close-cycle',
      scenarioHash: 'b'.repeat(64),
    },
    currentVerdict: verdict({ runId: 'current-run', actual: 800 }),
  });

  assert.equal(comparison.comparisonStatus, 'inconclusive');
  assert.equal(comparison.healthStatus, 'failed');
  assert.equal(comparison.metricComparisons, undefined);
  assert.match(comparison.evidence.missingRequired[0], /scenario_hash_mismatch/u);
});

test('accepts a manifest-declared baseline hash for direct comparisons', () => {
  const baselineHash = 'a'.repeat(64);
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineManifest: {
      scenarioId: 'open-close-cycle',
      scenarioHash: baselineHash,
    },
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 900 }),
    currentHealth: health({ runId: 'current-run' }),
    currentManifest: {
      acceptedBaselineScenarioHashes: [baselineHash],
      scenarioId: 'open-close-cycle',
      scenarioHash: 'b'.repeat(64),
    },
    currentVerdict: verdict({ runId: 'current-run', actual: 800 }),
  });

  assert.equal(comparison.comparisonStatus, 'better');
  assert.equal(comparison.healthStatus, 'passed');
  assert.equal(comparison.metricComparisons[0].status, 'better');
});

test('treats tiny millisecond deltas as unchanged timing noise', () => {
  assert.deepEqual(
    compareBudgetCheck(
      { name: 'scroll p95', unit: 'ms', actual: 7, pass: true },
      { name: 'scroll p95', unit: 'ms', actual: 8, pass: true },
    ),
    {
      name: 'scroll p95',
      unit: 'ms',
      baseline: 7,
      current: 8,
      delta: 1,
      status: 'unchanged',
      notes: 'Delta within 16ms timing tolerance.',
    },
  );
});

test('treats single-frame mobile timing drift as unchanged noise', () => {
  assert.deepEqual(
    compareBudgetCheck(
      { name: 'scroll p95', unit: 'ms', actual: 13, pass: true },
      { name: 'scroll p95', unit: 'ms', actual: 25, pass: true },
    ),
    {
      name: 'scroll p95',
      unit: 'ms',
      baseline: 13,
      current: 25,
      delta: 12,
      status: 'unchanged',
      notes: 'Delta within 16ms timing tolerance.',
    },
  );
});

test('keeps budget pass/fail boundary changes directional inside timing tolerance', () => {
  assert.deepEqual(
    compareBudgetCheck(
      { name: 'open p95', unit: 'ms', actual: 997, pass: true },
      { name: 'open p95', unit: 'ms', actual: 1001, pass: false },
    ),
    {
      name: 'open p95',
      unit: 'ms',
      baseline: 997,
      current: 1001,
      delta: 4,
      status: 'worse',
    },
  );
});

test('reports latest-trusted single-run timing movement as low confidence while budgets still pass', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 960 }),
    comparisonBasis: {
      strategy: 'latest_trusted_prior',
      baseline: {
        runId: 'baseline-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      current: {
        runId: 'current-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      selection: {
        artifactRoot: 'artifacts/example-mobile-app/ios',
        scenarioId: 'open-close-cycle',
        selectedRunDir: 'artifacts/example-mobile-app/ios/open-close-cycle/baseline-run',
        selectedRunId: 'baseline-run',
        skippedCurrentRun: true,
      },
    },
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict: verdict({ runId: 'current-run', actual: 1211 }),
  });

  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.healthStatus, 'passed');
  assert.equal(comparison.metricComparisons[0].status, 'low_confidence');
  assert.equal(comparison.metricComparisons[0].delta, 251);
  assert.match(comparison.metricComparisons[0].notes, /Single-run timing movement/u);
  assert.equal(comparison.measurementPolicy.confidence.level, 'low_confidence');
  assert.match(comparison.summary, /low-confidence timing movement/u);
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('rejects faster-looking latest-trusted single-run timing as an optimization claim', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 960 }),
    comparisonBasis: {
      strategy: 'latest_trusted_prior',
      baseline: {
        runId: 'baseline-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      current: {
        runId: 'faster-looking-current-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      selection: {
        artifactRoot: 'artifacts/example-mobile-app/android',
        scenarioId: 'open-close-cycle',
        selectedRunDir: 'artifacts/example-mobile-app/android/open-close-cycle/baseline-run',
        selectedRunId: 'baseline-run',
        skippedCurrentRun: true,
      },
    },
    currentHealth: health({ runId: 'faster-looking-current-run' }),
    currentVerdict: verdict({ runId: 'faster-looking-current-run', actual: 700 }),
  });

  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.metricComparisons[0].status, 'low_confidence');
  assert.equal(comparison.metricComparisons[0].delta, -260);
  assert.match(comparison.metricComparisons[0].notes, /optimization or regression/u);
  assert.equal(comparison.measurementPolicy.confidence.level, 'low_confidence');
  assert.match(comparison.measurementPolicy.confidence.reason, /optimization or regression/u);
  assert.match(comparison.summary, /low-confidence timing movement/u);
  assert.doesNotMatch(comparison.summary, /improved/u);
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('keeps latest-trusted budget-boundary failures as hard regressions', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 960, pass: true }),
    comparisonBasis: {
      strategy: 'latest_trusted_prior',
      baseline: {
        runId: 'baseline-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      current: {
        runId: 'current-run',
        healthStatus: 'passed',
        verdictStatus: 'failed',
      },
    },
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict: verdict({ runId: 'current-run', actual: 1200, pass: false, verdictStatus: 'failed' }),
  });

  assert.equal(comparison.comparisonStatus, 'worse');
  assert.equal(comparison.metricComparisons[0].status, 'worse');
  assert.equal(comparison.measurementPolicy.confidence.level, 'single_run');
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('keeps one-run multi-metric comparisons at single-run confidence', () => {
  const baselineVerdict = verdict({ runId: 'baseline-run', actual: 420 });
  baselineVerdict.budgetChecks.push({
    name: 'close p95',
    source: 'milestone',
    metric: 'p95',
    unit: 'ms',
    expected: 1000,
    actual: 380,
    pass: true,
  });
  const currentVerdict = verdict({ runId: 'current-run', actual: 390 });
  currentVerdict.budgetChecks.push({
    name: 'close p95',
    source: 'milestone',
    metric: 'p95',
    unit: 'ms',
    expected: 1000,
    actual: 350,
    pass: true,
  });

  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict,
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict,
  });

  assert.equal(comparison.metricComparisons.length, 2);
  assert.equal(comparison.measurementPolicy.samples.baseline.validSamples, 1);
  assert.equal(comparison.measurementPolicy.samples.current.validSamples, 1);
  assert.equal(comparison.measurementPolicy.confidence.level, 'single_run');
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('builds a better comparison only after both runs passed health', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 1200, pass: false, verdictStatus: 'failed' }),
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict: verdict({ runId: 'current-run', actual: 900 }),
  });

  assert.equal(comparison.comparisonStatus, 'better');
  assert.equal(comparison.healthStatus, 'passed');
  assert.equal(comparison.baselineRunId, 'baseline-run');
  assert.equal(comparison.runId, 'current-run');
  assert.equal(comparison.metricComparisons[0].delta, -300);
  assert.deepEqual(comparison.measurementPolicy, {
    baselineSelection: {
      mode: 'explicit',
      poisoningProtection: {
        requireMatchingScenarioId: true,
        requirePassedHealth: true,
        requirePassedVerdict: false,
      },
    },
    confidence: {
      level: 'single_run',
      minValidSamples: 1,
    },
    samples: {
      baseline: {
        outliersExcluded: 0,
        validSamples: 1,
        warmupSamples: 0,
      },
      current: {
        outliersExcluded: 0,
        validSamples: 1,
        warmupSamples: 0,
      },
    },
    tolerance: {
      timing: {
        absoluteMs: 16,
        relative: 0.05,
      },
    },
  });
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('classifies opposite metric directions as mixed instead of a hard regression', () => {
  const baselineVerdict = verdict({ runId: 'baseline-run', actual: 420 });
  baselineVerdict.budgetChecks.push({
    name: 'close p50',
    source: 'milestone',
    metric: 'p50',
    unit: 'ms',
    expected: 1000,
    actual: 10,
    pass: true,
  });

  const currentVerdict = verdict({ runId: 'current-run', actual: 398 });
  currentVerdict.budgetChecks.push({
    name: 'close p50',
    source: 'milestone',
    metric: 'p50',
    unit: 'ms',
    expected: 1000,
    actual: 32,
    pass: true,
  });

  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict,
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict,
  });

  assert.equal(comparison.comparisonStatus, 'mixed');
  assert.equal(comparison.healthStatus, 'passed');
  assert.deepEqual(
    comparison.metricComparisons.map((metric: { name: string; status: string }) => [metric.name, metric.status]),
    [
      ['open p95', 'better'],
      ['close p50', 'worse'],
    ],
  );
  assert.match(comparison.summary, /mixed metric movement/u);
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('returns inconclusive comparison when scenario health did not pass', () => {
  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 900 }),
    currentHealth: health({ runId: 'current-run', healthStatus: 'failed' }),
    currentVerdict: verdict({ runId: 'current-run', actual: 700 }),
  });

  assert.equal(comparison.comparisonStatus, 'inconclusive');
  assert.equal(comparison.healthStatus, 'failed');
  assert.deepEqual(comparison.evidence.missingRequired, ['current health passed']);
  assert.equal(comparison.metricComparisons, undefined);
  assert.match(comparison.summary, /required evidence is missing/u);
});

test('returns inconclusive comparison when no matching budget checks exist', () => {
  const currentVerdict = verdict({ runId: 'current-run', actual: 900 });
  currentVerdict.budgetChecks[0].name = 'close p95';

  const comparison = buildComparisonArtifact({
    baselineHealth: health({ runId: 'baseline-run' }),
    baselineVerdict: verdict({ runId: 'baseline-run', actual: 900 }),
    currentHealth: health({ runId: 'current-run' }),
    currentVerdict,
  });

  assert.equal(comparison.comparisonStatus, 'inconclusive');
  assert.deepEqual(comparison.evidence.warnings, [
    'No baseline budget check matched close p95.',
    'No comparable budget checks were available.',
  ]);
});
