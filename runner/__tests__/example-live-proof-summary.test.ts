const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLiveProofComparisonStatus,
  buildLiveProofNextAction,
} = require('../example-live-proof-summary');

/**
 * Builds a minimal comparison pointer for status aggregation tests.
 *
 * @param {'better' | 'worse' | 'unchanged' | 'inconclusive' | 'skipped'} status
 * @returns {Record<string, unknown>}
 */
function comparison(status: 'better' | 'worse' | 'unchanged' | 'inconclusive' | 'skipped'): Record<string, unknown> {
  return {
    baselineDir: status === 'skipped' ? null : 'baseline',
    comparisonDir: status === 'skipped' ? null : 'comparison',
    label: status,
    reason: status === 'skipped' ? 'No trusted prior run found.' : null,
    runId: `run-${status}`,
    scenarioId: `scenario-${status}`,
    status,
    summaryPath: status === 'skipped' ? null : 'comparison/agent-summary.md',
  };
}

test('collapses live proof comparisons into aggregate statuses', () => {
  assert.equal(buildLiveProofComparisonStatus([]), 'not_compared');
  assert.equal(buildLiveProofComparisonStatus([comparison('skipped')]), 'baseline_missing');
  assert.equal(buildLiveProofComparisonStatus([comparison('better'), comparison('skipped')]), 'inconclusive');
  assert.equal(buildLiveProofComparisonStatus([comparison('inconclusive')]), 'inconclusive');
  assert.equal(buildLiveProofComparisonStatus([comparison('better'), comparison('unchanged')]), 'improved');
  assert.equal(buildLiveProofComparisonStatus([comparison('unchanged')]), 'unchanged');
  assert.equal(buildLiveProofComparisonStatus([comparison('better'), comparison('worse')]), 'regressed');
});

test('maps aggregate live proof statuses to next actions', () => {
  assert.equal(buildLiveProofNextAction('regressed').code, 'inspect_regressions');
  assert.equal(buildLiveProofNextAction('baseline_missing').code, 'establish_baseline');
  assert.equal(buildLiveProofNextAction('inconclusive').code, 'inspect_inconclusive');
  assert.equal(buildLiveProofNextAction('improved').code, 'inspect_summary');
  assert.equal(buildLiveProofNextAction('unchanged').code, 'inspect_summary');
  assert.equal(buildLiveProofNextAction('not_compared').code, 'inspect_summary');
});
