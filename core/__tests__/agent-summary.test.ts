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
    manifest: {
      attempt: {
        attemptId: 'attempt-2',
        attemptNumber: 2,
        maxAttempts: 3,
        retryOfAttemptId: 'attempt-1',
        retryReason: 'Previous attempt timed out.',
        terminalState: 'passed',
        classification: {
          category: 'none',
        },
        cleanup: {
          status: 'passed',
        },
        partialArtifacts: {
          valid: false,
          reason: 'complete successful run artifacts are present',
        },
      },
    },
    comparison: {
      comparisonStatus: 'unchanged',
      comparisonBasis: {
        strategy: 'latest_trusted_prior',
        baseline: {
          runId: 'baseline-run',
          runDir: 'artifacts/asl/android/app-startup/baseline-run',
        },
        current: {
          runId: 'run-1',
          runDir: 'artifacts/asl/android/app-startup/run-1',
        },
        selection: {
          candidatesInspected: 3,
          skippedCurrentRun: true,
          trustedCandidates: 2,
          trustedPriorCandidates: 1,
        },
      },
      summary: 'Current run matched the explicit baseline.',
    },
  });

  assert.match(summary, /# agent summary/u);
  assert.match(summary, /Scenario: `app-startup`/u);
  assert.match(summary, /Health: passed/u);
  assert.match(summary, /Comparison: unchanged/u);
  assert.match(summary, /## comparison basis/u);
  assert.match(summary, /Strategy: `latest_trusted_prior`/u);
  assert.match(summary, /Baseline: `baseline-run` at `artifacts\/asl\/android\/app-startup\/baseline-run`/u);
  assert.match(summary, /Selection: inspected 3, trusted 2, trusted prior 1, skipped current true/u);
  assert.match(summary, /## attempt/u);
  assert.match(summary, /Attempt: `attempt-2` \(2\/3\)/u);
  assert.match(summary, /Terminal state: `passed`/u);
  assert.match(summary, /Retry lineage: previous=`attempt-1` reason=Previous attempt timed out\./u);
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

test('separates unmeasurable budget checks from failed budgets', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'home-feed-scroll-stress',
      runId: 'run-4',
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed', source: 'truth' }],
    },
    verdict: {
      scenarioId: 'home-feed-scroll-stress',
      runId: 'run-4',
      verdictStatus: 'inconclusive',
      budgetChecks: [
        {
          name: 'cycle p95',
          source: 'milestone',
          metric: 'feed scroll budget',
          unit: 'ms',
          expected: 1400,
          actual: null,
          pass: false,
          status: 'unmeasurable',
          notes: 'No latency samples were available for this budget. Use explicit interval anchors when the claim is transition latency.',
        },
      ],
    },
  });

  assert.doesNotMatch(summary, /## failed budgets/u);
  assert.match(summary, /## unmeasurable budgets/u);
  assert.match(summary, /cycle p95: feed scroll budget was unmeasurable/u);
  assert.match(summary, /Use explicit interval anchors/u);
});
test('does not render warning or partial health checks as failed checks', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'gallery-video-native-fidelity',
      runId: 'run-5',
      healthStatus: 'failed',
      checks: [
        {
          name: 'native_performance_evidence',
          status: 'partial',
          source: 'provider',
          message: 'Native performance evidence was captured, but the provider reported incomplete diagnostics.',
        },
        {
          name: 'accessibility_snapshot',
          status: 'warning',
          source: 'provider',
          message: 'Accessibility snapshot timed out while the UI was animating.',
        },
        {
          name: 'truth_events_complete',
          status: 'failed',
          source: 'truth',
          message: 'Profile events did not complete every expected iteration.',
        },
      ],
    },
    verdict: {
      scenarioId: 'gallery-video-native-fidelity',
      runId: 'run-5',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });
  const failedSection = summary.split('## partial checks')[0] ?? summary;

  assert.match(summary, /## failed checks/u);
  assert.match(summary, /`truth_events_complete`: failed/u);
  assert.doesNotMatch(failedSection, /native_performance_evidence/u);
  assert.match(summary, /## partial checks/u);
  assert.match(summary, /`native_performance_evidence`: partial/u);
  assert.match(summary, /## warnings/u);
  assert.match(summary, /`accessibility_snapshot`: warning/u);
});

test('indexes preserved provider diagnostics separately from product claims', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'gallery-video-native-fidelity',
      runId: 'run-6',
      healthStatus: 'failed',
      checks: [
        {
          name: 'partial_provider_evidence_preserved',
          code: 'partial_provider_evidence_preserved',
          status: 'warning',
          source: 'evidence',
          message: 'Provider command health failed, but some provider-backed diagnostics were preserved for diagnosis.',
          metadata: {
            capturedKinds: 'nativePerformance,profiler',
            capturedPaths: 'raw/providers/native/native-performance.json,raw/providers/native/profiler.json',
            failedRequiredKinds: 'accessibility,uiTree',
            nextAction: 'Use preserved diagnostics for investigation only; rerun before making product claims.',
            nextActionCode: 'use_partial_provider_evidence_for_diagnosis',
          },
        },
        {
          name: 'required_accessibility_diagnostic',
          code: 'required_diagnostic_not_captured',
          status: 'failed',
          source: 'evidence',
          message: 'Required accessibility diagnostic was not captured.',
        },
      ],
    },
    verdict: {
      scenarioId: 'gallery-video-native-fidelity',
      runId: 'run-6',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });

  assert.match(summary, /Do not optimize from this run/u);
  assert.match(summary, /## preserved diagnostic evidence/u);
  assert.match(summary, /Captured `nativePerformance`, `profiler`/u);
  assert.match(summary, /Missing required `accessibility`, `uiTree`/u);
  assert.match(summary, /`raw\/providers\/native\/native-performance\.json`/u);
  assert.match(summary, /Next action `use_partial_provider_evidence_for_diagnosis`/u);
  assert.match(summary, /## failed checks/u);
  assert.match(summary, /`required_accessibility_diagnostic`: failed/u);
});
