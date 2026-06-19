const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildComparisonMetricSummary,
} = require('../live-comparison');

test('builds compact metric summaries from comparison artifacts', () => {
  const summary = buildComparisonMetricSummary({
    metricComparisons: [
      {
        name: 'cycle p50',
        unit: 'ms',
        baseline: 420,
        current: 398,
        delta: -22,
        status: 'better',
      },
      {
        name: 'close p50',
        unit: 'ms',
        baseline: 10,
        current: 16,
        delta: 6,
        status: 'worse',
      },
      {
        name: 'close p95',
        unit: 'ms',
        baseline: 17,
        current: 17,
        delta: 0,
        status: 'unchanged',
      },
      {
        name: 'startup p95',
        unit: 'ms',
        baseline: 960,
        current: 1211,
        delta: 251,
        status: 'low_confidence',
      },
    ],
  });

  assert.deepEqual(summary, {
    counts: {
      better: 1,
      worse: 1,
      unchanged: 1,
      inconclusive: 0,
      low_confidence: 1,
    },
    notableMetrics: [
      {
        baseline: 420,
        current: 398,
        delta: -22,
        name: 'cycle p50',
        status: 'better',
        unit: 'ms',
      },
      {
        baseline: 10,
        current: 16,
        delta: 6,
        name: 'close p50',
        status: 'worse',
        unit: 'ms',
      },
      {
        baseline: 960,
        current: 1211,
        delta: 251,
        name: 'startup p95',
        status: 'low_confidence',
        unit: 'ms',
      },
    ],
  });
});

test('omits metric summaries when a comparison has no metric list', () => {
  assert.equal(buildComparisonMetricSummary({ comparisonStatus: 'inconclusive' }), undefined);
});
