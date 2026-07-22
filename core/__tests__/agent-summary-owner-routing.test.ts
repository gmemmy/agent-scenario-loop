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

function buildFailedSummary(checks: readonly HealthCheck[]): string {
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

const adjacentOwnerFaults: Array<{
  expectedOwner: string;
  higher: HealthCheck;
  lower: HealthCheck;
  name: string;
}> = [
  {
    expectedOwner: 'runtime_environment',
    higher: { code: 'runtime_identity_mismatch', metadata: { nextActionOwner: 'runtime_environment' }, source: 'runner', status: 'failed' },
    lower: { code: 'ios_simctl_runner_liveness_timeout', metadata: { nextActionOwner: 'asl_runner' }, source: 'runner', status: 'failed' },
    name: 'runtime readiness outranks runner liveness',
  },
  {
    expectedOwner: 'asl_runner',
    higher: { code: 'ios_simctl_runner_liveness_timeout', metadata: { nextActionOwner: 'asl_runner' }, source: 'runner', status: 'failed' },
    lower: { code: 'profile_session_start_missing', metadata: { nextActionOwner: 'app_truth' }, source: 'truth', status: 'failed' },
    name: 'runner liveness outranks app truth',
  },
  {
    expectedOwner: 'app_truth',
    higher: { code: 'profile_session_start_missing', metadata: { nextActionOwner: 'app_truth' }, source: 'truth', status: 'failed' },
    lower: { code: 'interval_anchor_missing', metadata: { nextActionOwner: 'scenario_contract' }, source: 'planner', status: 'failed' },
    name: 'app truth outranks scenario contract',
  },
  {
    expectedOwner: 'scenario_contract',
    higher: { code: 'interval_anchor_missing', metadata: { nextActionOwner: 'scenario_contract' }, source: 'planner', status: 'failed' },
    lower: { code: 'native_performance_provider_failed', metadata: { nextActionOwner: 'provider_tooling' }, source: 'provider', status: 'failed' },
    name: 'scenario contract outranks provider tooling',
  },
  {
    expectedOwner: 'provider_tooling',
    higher: { code: 'native_performance_provider_failed', metadata: { nextActionOwner: 'provider_tooling' }, source: 'provider', status: 'failed' },
    lower: { code: 'startup_budget_failed', metadata: { nextActionOwner: 'product_optimization' }, source: 'verdict', status: 'failed' },
    name: 'provider tooling outranks product optimization',
  },
];

const unresolvedTruthCheck: HealthCheck = {
  code: 'truth_events_incomplete',
  metadata: { nextActionCode: 'inspect_truth_iteration_mapping' },
  name: 'truth_events_complete',
  source: 'truth',
  status: 'failed',
};

const unresolvedOwnerFaults: Array<{
  expectedOwner: string;
  resolved: HealthCheck;
  name: string;
}> = [
  {
    expectedOwner: 'runtime_environment',
    name: 'runtime readiness outranks unresolved truth ownership',
    resolved: { code: 'runtime_identity_mismatch', metadata: { nextActionOwner: 'runtime_environment' }, source: 'runner', status: 'failed' },
  },
  {
    expectedOwner: 'asl_runner',
    name: 'runner liveness outranks unresolved truth ownership',
    resolved: { code: 'ios_simctl_runner_liveness_timeout', metadata: { nextActionOwner: 'asl_runner' }, source: 'runner', status: 'failed' },
  },
  {
    expectedOwner: 'app_truth',
    name: 'explicit app truth outranks unresolved truth ownership',
    resolved: { code: 'profile_session_start_missing', metadata: { nextActionOwner: 'app_truth' }, source: 'truth', status: 'failed' },
  },
  {
    expectedOwner: 'unresolved',
    name: 'unresolved truth ownership outranks scenario contract',
    resolved: { code: 'interval_anchor_missing', metadata: { nextActionOwner: 'scenario_contract' }, source: 'planner', status: 'failed' },
  },
  {
    expectedOwner: 'unresolved',
    name: 'unresolved truth ownership outranks provider tooling',
    resolved: { code: 'native_performance_provider_failed', metadata: { nextActionOwner: 'provider_tooling' }, source: 'provider', status: 'failed' },
  },
];

for (const fault of adjacentOwnerFaults) {
  for (const [order, checks] of [
    ['higher-first', [fault.higher, fault.lower]],
    ['lower-first', [fault.lower, fault.higher]],
  ] as const) {
    test(`${fault.name} with ${order} input`, () => {
      const summary = buildFailedSummary(checks);
      assert.match(summary, new RegExp('Owner: `' + fault.expectedOwner + '`', 'u'));
    });
  }
}

for (const fault of unresolvedOwnerFaults) {
  for (const [order, checks] of [
    ['unresolved-first', [unresolvedTruthCheck, fault.resolved]],
    ['resolved-first', [fault.resolved, unresolvedTruthCheck]],
  ] as const) {
    test(`${fault.name} with ${order} input`, () => {
      const summary = buildFailedSummary(checks);
      assert.match(summary, new RegExp('Owner: `' + fault.expectedOwner + '`', 'u'));
    });
  }
}

for (const checks of [
  [
    { code: 'runtime_identity_warning', metadata: { nextActionOwner: 'runtime_environment' }, status: 'warning' as const },
    { code: 'provider_capture_failed', metadata: { nextActionOwner: 'provider_tooling' }, status: 'failed' as const },
  ],
  [
    { code: 'provider_capture_failed', metadata: { nextActionOwner: 'provider_tooling' }, status: 'failed' as const },
    { code: 'runtime_identity_warning', metadata: { nextActionOwner: 'runtime_environment' }, status: 'warning' as const },
  ],
]) {
  test('failed checks own routing before warning-only owners independent of input order', () => {
    const summary = buildFailedSummary(checks);
    assert.match(summary, /Owner: `provider_tooling`/u);
    assert.match(summary, /provider evidence is incomplete at provider_capture_failed/u);
  });
}

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

test('ownerless truth-events incompleteness remains unresolved between app truth and scenario contract', () => {
  const summary = buildFailedSummary([{
    code: 'truth_events_incomplete',
    metadata: {
      completedCommandCount: 2,
      nextActionCode: 'inspect_truth_iteration_mapping',
    },
    name: 'truth_events_complete',
    source: 'truth',
    status: 'failed',
  }]);

  assert.match(summary, /Owner: `unresolved`/u);
  assert.match(summary, /cannot distinguish app truth emission from scenario contract mapping at truth_events_complete/u);
  assert.match(summary, /Inspect app truth emission and scenario contract milestone or iteration mapping/u);
  assert.doesNotMatch(summary, /Owner: `app_truth`/u);
  assert.doesNotMatch(summary, /Owner: `scenario_contract`/u);
});

test('explicit metadata resolves truth-events incompleteness when the producer can identify the owner', () => {
  const summary = buildFailedSummary([{
    code: 'truth_events_incomplete',
    metadata: { nextActionOwner: 'scenario_contract' },
    source: 'truth',
    status: 'failed',
  }]);

  assert.match(summary, /Owner: `scenario_contract`/u);
});
