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
  assert.match(summary, /## next action/u);
  assert.match(summary, /Owner: `scenario_contract`/u);
  assert.match(summary, /Optimization claims still require verdict or comparison evidence/u);
});

test('surfaces native-performance comparison status in the summary header', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'app-startup',
      runId: 'run-1',
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed', source: 'truth' }],
    },
    verdict: {
      scenarioId: 'app-startup',
      runId: 'run-1',
      verdictStatus: 'passed',
      budgetChecks: [],
    },
    comparison: {
      comparisonStatus: 'unchanged',
      nativePerformance: {
        status: 'regressed',
      },
      summary: 'Ordinary budgets matched, but trusted native performance regressed.',
    },
  });

  assert.match(summary, /Comparison: unchanged; native=regressed/u);
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
  assert.match(summary, /Owner: `provider_tooling`/u);
  assert.match(summary, /provider evidence is incomplete at missing_required_artifact/u);
  assert.match(summary, /## failed checks/u);
  assert.match(summary, /`missing_required_artifact`: failed/u);
  assert.match(summary, /Next action `add_profiler_provider`: Enable a runner or provider/u);
  assert.match(summary, /## warnings/u);
  assert.match(summary, /`missing_optional_artifact`: warning/u);
});

test('renders diagnostic failure classes and raw paths on checks', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'app-startup',
      runId: 'run-diagnostic',
      healthStatus: 'failed',
      checks: [
        {
          name: 'ios_profile_session_start_wait',
          status: 'failed',
          source: 'runner',
          message: 'No same-run iOS profile-session app evidence appeared.',
          metadata: {
            commandCount: 0,
            devClientDeepLinkOpened: true,
            failureClass: 'dev_client_bundle_or_command_channel_not_ready',
            foregroundAppInfoCaptured: true,
            foregroundApplicationState: 'BackgroundRunning',
            foregroundRawPath: 'raw/ios-profile-session-start-app-info.txt',
            foregroundTargetOwned: false,
            lastDeepLinkLabel: 'ios-dev-client-url',
            nextAction: 'Confirm the development client loaded the intended app bundle and command channel.',
            nextActionCode: 'fix_ios_dev_client_bundle_or_command_channel',
            profileSessionSeeded: true,
            readinessRawPath: 'raw/ios-profile-session-readiness.json',
          },
        },
      ],
    },
    verdict: {
      scenarioId: 'app-startup',
      runId: 'run-diagnostic',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });

  assert.match(summary, /failureClass=`dev_client_bundle_or_command_channel_not_ready`/u);
  assert.match(summary, /commandCount=`0`/u);
  assert.match(summary, /devClientDeepLinkOpened=`true`/u);
  assert.match(summary, /foregroundAppInfoCaptured=`true`/u);
  assert.match(summary, /foregroundApplicationState=`BackgroundRunning`/u);
  assert.match(summary, /foregroundTargetOwned=`false`/u);
  assert.match(summary, /lastDeepLinkLabel=`ios-dev-client-url`/u);
  assert.match(summary, /profileSessionSeeded=`true`/u);
  assert.match(summary, /foregroundRawPath=`raw\/ios-profile-session-start-app-info\.txt`/u);
  assert.match(summary, /readinessRawPath=`raw\/ios-profile-session-readiness\.json`/u);
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
  assert.match(summary, /Owner: `product_optimization`/u);
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
  assert.match(summary, /Owner: `scenario_contract`/u);
  assert.match(summary, /add interval anchors/u);
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
  assert.match(summary, /Owner: `app_truth`/u);
  assert.match(summary, /app-owned truth is incomplete at truth_events_complete/u);
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
            capturedDiagnosticSufficiency: 'nativePerformance:diagnostic-only,profiler:diagnostic-only',
            blockingDiagnosticSufficiency: 'accessibility:provider-blocked,uiTree:provider-blocked',
            failedRequiredKinds: 'accessibility,uiTree',
            nativePerformanceClaimSufficiency: 'insufficient-for-claim',
            nativePerformanceCompletenessStatus: 'partial',
            nativePerformanceComparability: 'captured-not-comparable',
            nativePerformanceDiagnosticSources: 'xctrace:partial,metrickit:timeout',
            nativePerformanceTargetBinding: 'ambiguous',
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
        {
          name: 'profile_session_helper_version',
          code: 'profile_session_helper_version_missing',
          status: 'warning',
          source: 'runner',
          message: 'Profile evidence did not include app helper version metadata.',
          metadata: {
            nextActionCode: 'emit_profile_session_helper_version',
            nextAction: 'Use an app-side profile-session helper that emits helperVersion metadata.',
          },
        },
      ],
    },
    verdict: {
      scenarioId: 'gallery-video-native-fidelity',
      runId: 'run-6',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
    manifest: {
      artifacts: {
        diagnostics: [
          {
            kind: 'accessibility',
            provider: 'native-provider',
            required: true,
            status: 'failed',
            sufficiency: {
              status: 'provider-blocked',
              reason: 'accessibility evidence was requested from a provider, but the provider did not produce a sufficient output.',
            },
          },
          {
            kind: 'nativePerformance',
            path: 'raw/providers/native/native-performance.json',
            provider: 'native-provider',
            required: true,
            status: 'captured',
            sufficiency: {
              status: 'diagnostic-only',
              reason: 'nativePerformance evidence was captured, but it is diagnostic-only.',
            },
          },
          {
            kind: 'memory',
            path: 'signals/memory/memory.json',
            provider: 'native-provider',
            required: false,
            status: 'captured',
            sufficiency: {
              status: 'optional-preserved-evidence',
              reason: 'memory evidence was captured as optional preserved evidence.',
            },
          },
          {
            kind: 'uiTree',
            provider: 'native-provider',
            required: true,
            status: 'failed',
            sufficiency: {
              status: 'provider-blocked',
              reason: 'uiTree evidence was requested from a provider, but the provider did not produce a sufficient output.',
            },
          },
        ],
      },
    },
  });

  assert.match(summary, /Do not optimize from this run/u);
  assert.match(summary, /Owner: `provider_tooling`/u);
  assert.match(summary, /## preserved diagnostic evidence/u);
  assert.match(summary, /Captured `nativePerformance`, `profiler`/u);
  assert.match(summary, /Missing required `accessibility`, `uiTree`/u);
  assert.match(summary, /Captured sufficiency: `nativePerformance:diagnostic-only`, `profiler:diagnostic-only`/u);
  assert.match(summary, /Blocking sufficiency: `accessibility:provider-blocked`, `uiTree:provider-blocked`/u);
  assert.match(summary, /Native performance claim: `insufficient-for-claim`/u);
  assert.match(summary, /Native performance completeness: `partial`/u);
  assert.match(summary, /Native performance comparability: `captured-not-comparable`/u);
  assert.match(summary, /Native performance target binding: `ambiguous`/u);
  assert.match(summary, /Native performance sources: `xctrace:partial`, `metrickit:timeout`/u);
  assert.match(summary, /`raw\/providers\/native\/native-performance\.json`/u);
  assert.match(summary, /Next action `use_partial_provider_evidence_for_diagnosis`/u);
  assert.match(summary, /## diagnostic sufficiency/u);
  assert.match(summary, /`accessibility`: `provider-blocked`/u);
  assert.match(summary, /`nativePerformance`: `diagnostic-only` \(required, provider=`native-provider`, path=`raw\/providers\/native\/native-performance\.json`\)/u);
  assert.match(summary, /`memory`: `optional-preserved-evidence`/u);
  assert.match(summary, /`uiTree`: `provider-blocked`/u);
  assert.match(summary, /## failed checks/u);
  assert.match(summary, /`required_accessibility_diagnostic`: failed/u);
  assert.match(summary, /## warnings/u);
  assert.match(summary, /`profile_session_helper_version`: warning/u);
});

test('uses warning owners when no failed health checks exist', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'app-startup',
      runId: 'run-warning-only',
      healthStatus: 'failed',
      checks: [
        {
          name: 'profile_session_helper_version',
          code: 'profile_session_helper_version_missing',
          status: 'warning',
          source: 'runner',
          message: 'Profile evidence did not include app helper version metadata.',
          metadata: {
            nextActionCode: 'emit_profile_session_helper_version',
            nextAction: 'Use an app-side profile-session helper that emits helperVersion metadata.',
          },
        },
      ],
    },
    verdict: {
      scenarioId: 'app-startup',
      runId: 'run-warning-only',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });

  assert.match(summary, /Owner: `asl_runner`/u);
  assert.match(summary, /`profile_session_helper_version`: warning/u);
});

test('classifies runtime identity failures as runtime environment work', () => {
  const summary = buildAgentSummaryMarkdown({
    health: {
      scenarioId: 'app-startup',
      runId: 'run-runtime',
      healthStatus: 'failed',
      checks: [
        {
          code: 'runtime_identity_mismatch',
          name: 'runtime_identity_mismatch',
          status: 'failed',
          source: 'runtime',
          message: 'Observed package did not match the expected app id.',
          metadata: {
            nextActionCode: 'rerun_sidecar_with_expected_runtime_identity',
          },
        },
      ],
    },
    verdict: {
      scenarioId: 'app-startup',
      runId: 'run-runtime',
      verdictStatus: 'inconclusive',
      budgetChecks: [],
    },
  });

  assert.match(summary, /Owner: `runtime_environment`/u);
  assert.match(summary, /runtime evidence is invalid or unverified at runtime_identity_mismatch/u);
  assert.match(summary, /Fix target selection or runtime setup/u);
});
