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
  assert.deepEqual(result.claimSufficiency, {
    status: 'blocked',
    reason: 'scenario health did not pass',
  });
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
  assert.deepEqual(result.claimSufficiency, {
    status: 'sufficient',
    reason: 'scenario health passed and requested claims are measurable',
  });
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

test('classifies preserved partial provider evidence as diagnostic only', () => {
  const result = interpretEvidence({
    health: {
      healthStatus: 'failed',
      checks: [
        {
          code: 'partial_provider_evidence_preserved',
          name: 'partial_provider_evidence_preserved',
          status: 'warning',
          metadata: {
            capturedKinds: 'nativePerformance',
          },
        },
        {
          code: 'provider_command_failed',
          name: 'provider_command_failed',
          status: 'failed',
        },
      ],
    },
  });

  assert.deepEqual(result.claimSufficiency, {
    status: 'diagnostic-only',
    reason: 'scenario health failed but partial diagnostic evidence was preserved for diagnosis',
  });
  assert.deepEqual(result.blockedReasons, [
    'scenario health failed but partial diagnostic evidence was preserved for diagnosis',
  ]);
  assert.ok(result.recommendations.includes('use preserved partial diagnostic evidence only for diagnosis'));
  assert.ok(result.recommendations.includes('resolve health check provider_command_failed'));
});

test('classifies preserved partial sidecar evidence as diagnostic only', () => {
  const result = interpretEvidence({
    health: {
      healthStatus: 'failed',
      checks: [
        {
          code: 'partial_sidecar_evidence_preserved',
          name: 'partial_sidecar_evidence_preserved',
          status: 'partial',
          metadata: {
            capturedKinds: 'profileSessionLog,logs,screenshot',
          },
        },
        {
          code: 'android_profile_session_start_missing',
          name: 'android_profile_session_start_missing',
          status: 'failed',
        },
      ],
    },
  });

  assert.deepEqual(result.claimSufficiency, {
    status: 'diagnostic-only',
    reason: 'scenario health failed but partial diagnostic evidence was preserved for diagnosis',
  });
  assert.deepEqual(result.blockedReasons, [
    'scenario health failed but partial diagnostic evidence was preserved for diagnosis',
  ]);
  assert.ok(result.recommendations.includes('use preserved partial diagnostic evidence only for diagnosis'));
  assert.ok(result.recommendations.includes('resolve health check android_profile_session_start_missing'));
});

test('classifies unmeasurable budgets as partial claims', () => {
  const result = interpretEvidence({
    health: {
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed' }],
    },
    verdict: {
      verdictStatus: 'inconclusive',
      budgetChecks: [
        {
          name: 'cycle p95',
          status: 'unmeasurable',
        },
      ],
    },
  });

  assert.equal(result.timingTrusted, true);
  assert.deepEqual(result.claimSufficiency, {
    status: 'partial',
    reason: 'one or more requested claims are unmeasurable or inconclusive',
  });
  assert.deepEqual(result.blockedReasons, []);
  assert.deepEqual(result.recommendations, [
    'add interval anchors for unmeasurable budget cycle p95',
  ]);
});
