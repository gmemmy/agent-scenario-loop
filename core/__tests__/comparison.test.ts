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
      notes: 'Delta within 10ms timing tolerance.',
    },
  );
});

test('treats single-frame mobile timing drift as unchanged noise', () => {
  assert.deepEqual(
    compareBudgetCheck(
      { name: 'scroll p95', unit: 'ms', actual: 14, pass: true },
      { name: 'scroll p95', unit: 'ms', actual: 21, pass: true },
    ),
    {
      name: 'scroll p95',
      unit: 'ms',
      baseline: 14,
      current: 21,
      delta: 7,
      status: 'unchanged',
      notes: 'Delta within 10ms timing tolerance.',
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
    actual: 24,
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
