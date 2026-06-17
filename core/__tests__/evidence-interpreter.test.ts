const assert = require('node:assert/strict');
const test = require('node:test');

const {
  interpretEvidence,
  isTimingEvidenceTrusted,
} = require('../evidence-interpreter');

test('does not trust timing evidence when scenario health failed', () => {
  const health = {
    healthStatus: 'failed',
    checks: [
      {
        name: 'missing_required_artifact',
        status: 'failed',
      },
    ],
  };

  const result = interpretEvidence({
    health,
    verdict: {
      budgetChecks: [{ name: 'open p95', pass: false }],
    },
  });

  assert.equal(isTimingEvidenceTrusted(health), false);
  assert.equal(result.timingTrusted, false);
  assert.deepEqual(result.blockedReasons, ['scenario health did not pass']);
  assert.ok(result.recommendations.includes('harden scenario health before interpreting timing evidence'));
  assert.ok(result.recommendations.includes('resolve health check missing_required_artifact'));
  assert.equal(result.recommendations.some((item: string) => item.includes('open p95')), false);
});

test('emits budget and comparison hints only after scenario health passed', () => {
  const result = interpretEvidence({
    health: {
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed' }],
    },
    verdict: {
      budgetChecks: [{ name: 'scroll settle p95', pass: false }],
    },
    comparison: {
      comparisonStatus: 'worse',
    },
  });

  assert.equal(result.timingTrusted, true);
  assert.deepEqual(result.blockedReasons, []);
  assert.deepEqual(result.recommendations, [
    'investigate failed budget scroll settle p95',
    'investigate regression against baseline comparison',
  ]);
});

test('emits a distinct hint for mixed comparison movement', () => {
  const result = interpretEvidence({
    health: {
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed' }],
    },
    comparison: {
      comparisonStatus: 'mixed',
    },
  });

  assert.deepEqual(result.recommendations, [
    'inspect mixed baseline comparison signals before claiming improvement',
  ]);
});
