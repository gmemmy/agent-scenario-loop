const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAgentSummaryMarkdown } = require('../agent-summary');

type HealthCheck = {
  code: string;
  message?: string;
  metadata?: Record<string, unknown>;
  name?: string;
  source?: string;
  status: 'failed' | 'warning';
};

function buildFailedSummary(checks: HealthCheck[]): string {
  return buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'owner-routing-fault-matrix',
      runId: 'owner-routing-run',
      healthStatus: 'failed',
      checks,
    },
    verdict: {
      scenarioId: 'owner-routing-fault-matrix',
      runId: 'owner-routing-run',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });
}

test('explicit owner metadata outranks misleading check vocabulary', () => {
  const summary = buildFailedSummary([{
    code: 'provider_command_handler_truth_missing',
    message: 'Provider-shaped text must not override producer-owned routing.',
    metadata: { nextActionOwner: 'app_truth' },
    status: 'failed',
  }]);

  assert.match(summary, /Owner: `app_truth`/u);
  assert.match(summary, /app-owned truth is incomplete at provider_command_handler_truth_missing/u);
});

test('failed checks own routing before warning-only owners', () => {
  const summary = buildFailedSummary([
    {
      code: 'runtime_identity_warning',
      metadata: { nextActionOwner: 'runtime_environment' },
      status: 'warning',
    },
    {
      code: 'provider_capture_failed',
      metadata: { nextActionOwner: 'provider_tooling' },
      status: 'failed',
    },
  ]);

  assert.match(summary, /Owner: `provider_tooling`/u);
  assert.match(summary, /provider evidence is incomplete at provider_capture_failed/u);
});

test('mixed failed owners use the existing recovery rank', () => {
  const summary = buildFailedSummary([
    {
      code: 'provider_capture_failed',
      metadata: { nextActionOwner: 'provider_tooling' },
      status: 'failed',
    },
    {
      code: 'runtime_target_missing',
      metadata: { nextActionOwner: 'runtime_environment' },
      status: 'failed',
    },
  ]);

  assert.match(summary, /Owner: `runtime_environment`/u);
  assert.match(summary, /runtime evidence is invalid or unverified at runtime_target_missing/u);
});

test('same-owner ambiguity remains deterministic by input order', () => {
  const summary = buildFailedSummary([
    {
      code: 'first_truth_failure',
      metadata: { nextActionOwner: 'app_truth' },
      status: 'failed',
    },
    {
      code: 'second_truth_failure',
      metadata: { nextActionOwner: 'app_truth' },
      status: 'failed',
    },
  ]);

  assert.match(summary, /Owner: `app_truth`/u);
  assert.match(summary, /app-owned truth is incomplete at first_truth_failure/u);
});

test('unknown owner metadata falls back to product-neutral inference', () => {
  const summary = buildFailedSummary([{
    code: 'runtime_identity_mismatch',
    metadata: { nextActionOwner: 'external_team' },
    status: 'failed',
  }]);

  assert.match(summary, /Owner: `runtime_environment`/u);
});
