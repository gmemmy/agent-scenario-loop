const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBudgetVerdict } = require('../artifact-contract');
const { SCHEMAS, validateJson } = require('../schema-validator');

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
