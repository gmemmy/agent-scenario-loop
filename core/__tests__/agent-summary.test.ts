const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAgentSummaryMarkdown } = require('../agent-summary');

test('builds a passed-health agent summary with comparison context', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'app-startup',
      runId: 'run-1',
      healthStatus: 'passed',
      checks: [{ name: 'planner_compatibility', status: 'passed', source: 'planner' }],
    },
    verdict: {
      scenarioId: 'app-startup',
      runId: 'run-1',
      verdictStatus: 'not_evaluated',
      budgetChecks: [],
    },
    comparison: {
      comparisonStatus: 'unchanged',
      summary: 'Current run matched the explicit baseline.',
    },
  });

  assert.match(summary, /# agent summary/u);
  assert.match(summary, /Scenario: `app-startup`/u);
  assert.match(summary, /Health: passed/u);
  assert.match(summary, /Comparison: unchanged/u);
  assert.match(summary, /Optimization claims still require verdict or comparison evidence/u);
});

test('blocks optimization claims when scenario health fails', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'open-close-cycle',
      runId: 'run-2',
      healthStatus: 'failed',
      checks: [
        {
          name: 'missing_required_artifact',
          status: 'failed',
          source: 'evidence',
          message: 'No active runner or evidence provider can produce required artifact `profiler`.',
          metadata: {
            nextAction: 'Enable a runner or provider that produces profiler evidence before comparing budgets.',
            nextActionCode: 'add_profiler_provider',
          },
        },
      ],
      warnings: [
        {
          name: 'missing_optional_artifact',
          status: 'warning',
          source: 'evidence',
          message: 'No active runner or evidence provider declares optional artifact `video`.',
        },
      ],
    },
    verdict: {
      scenarioId: 'open-close-cycle',
      runId: 'run-2',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });

  assert.match(summary, /Do not optimize from this run/u);
  assert.match(summary, /## failed checks/u);
  assert.match(summary, /`missing_required_artifact`: failed/u);
  assert.match(summary, /Next action `add_profiler_provider`: Enable a runner or provider/u);
  assert.match(summary, /## warnings/u);
  assert.match(summary, /`missing_optional_artifact`: warning/u);
});

test('surfaces failed budget checks for valid runs', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'scroll-settle',
      runId: 'run-3',
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed', source: 'truth' }],
    },
    verdict: {
      scenarioId: 'scroll-settle',
      runId: 'run-3',
      verdictStatus: 'failed',
      budgetChecks: [
        {
          name: 'scroll settle p95',
          source: 'milestone',
          metric: 'p95',
          unit: 'ms',
          expected: 1400,
          actual: 1600,
          pass: false,
        },
      ],
    },
  });

  assert.match(summary, /## failed budgets/u);
  assert.match(summary, /scroll settle p95: p95 expected 1400, actual 1600/u);
});
