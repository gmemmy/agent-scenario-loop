const assert = require('node:assert/strict');
const test = require('node:test');

const { buildBudgetVerdict, buildMetricsFromProfileEvents } = require('../artifact-contract');
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
