const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLiveProofComparisonCounts,
  buildLiveProofComparisonStatus,
  buildLiveProofNextAction,
  buildLiveProofStatus,
  formatComparisonMetricSummary,
  readProfileGateDiagnosticSummary,
  readProfileGateReadinessSummary,
  writeLiveProofSummary,
} = require('../live-proof-summary');

type TestContext = import('node:test').TestContext;

/**
 * Builds a minimal comparison pointer for status aggregation tests.
 *
 * @param {'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'low_confidence' | 'skipped'} status
 * @returns {Record<string, unknown>}
 */
function comparison(status: 'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'low_confidence' | 'skipped'): Record<string, unknown> {
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
  assert.equal(buildLiveProofComparisonStatus([comparison('low_confidence')]), 'low_confidence');
  assert.equal(buildLiveProofComparisonStatus([comparison('mixed')]), 'mixed');
  assert.equal(buildLiveProofComparisonStatus([comparison('better'), comparison('unchanged')]), 'improved');
  assert.equal(buildLiveProofComparisonStatus([comparison('unchanged')]), 'unchanged');
  assert.equal(buildLiveProofComparisonStatus([comparison('better'), comparison('worse')]), 'regressed');
});

test('counts live proof comparison outcomes', () => {
  assert.deepEqual(
    buildLiveProofComparisonCounts([
      comparison('better'),
      comparison('worse'),
      comparison('mixed'),
      comparison('unchanged'),
      comparison('unchanged'),
      comparison('inconclusive'),
      comparison('low_confidence'),
      comparison('skipped'),
    ]),
    {
      better: 1,
      inconclusive: 1,
      low_confidence: 1,
      mixed: 1,
      skipped: 1,
      unchanged: 2,
      worse: 1,
    },
  );
});

test('maps aggregate live proof statuses to next actions', () => {
  assert.deepEqual(buildLiveProofNextAction('unchanged', 'failed'), {
    code: 'inspect_failed_run',
    owner: 'asl_runner',
    summary: 'One or more live proof gates failed; inspect failed profile or interaction summaries before making optimization claims.',
  });
  assert.deepEqual(buildLiveProofNextAction('regressed'), {
    code: 'inspect_regressions',
    owner: 'product_optimization',
    summary: 'One or more scenario comparisons regressed; inspect comparison summaries before claiming improvement.',
  });
  assert.deepEqual(buildLiveProofNextAction('baseline_missing'), {
    code: 'establish_baseline',
    owner: 'scenario_contract',
    summary: 'No trusted prior run was available; keep this proof as a baseline before making before/after claims.',
  });
  assert.deepEqual(buildLiveProofNextAction('inconclusive'), {
    code: 'inspect_inconclusive',
    owner: 'scenario_contract',
    summary: 'Some comparisons are inconclusive or incomplete; inspect scenario health and missing baseline details.',
  });
  assert.deepEqual(buildLiveProofNextAction('low_confidence'), {
    code: 'inspect_low_confidence',
    owner: 'scenario_contract',
    summary: 'Some comparisons show low-confidence timing movement; repeat or multi-sample proof is required before treating it as a regression.',
  });
  assert.deepEqual(buildLiveProofNextAction('mixed'), {
    code: 'inspect_mixed',
    owner: 'product_optimization',
    summary: 'Some timing metrics improved while others worsened; inspect comparison details before claiming improvement or regression.',
  });
  assert.equal(buildLiveProofNextAction('improved').owner, 'product_optimization');
  assert.equal(buildLiveProofNextAction('unchanged').owner, 'product_optimization');
  assert.equal(buildLiveProofNextAction('not_compared').owner, 'product_optimization');
});

test('derives failed aggregate status from failed profile gates and skipped sidecars', () => {
  assert.equal(
    buildLiveProofStatus({
      interactionProofs: [],
      preflight: { healthStatus: 'passed', verdictStatus: 'not_evaluated' },
      profiles: [{ healthStatus: 'passed', verdictStatus: 'failed' }],
    }),
    'failed',
  );
  assert.equal(
    buildLiveProofStatus({
      interactionProofs: [],
      preflight: { healthStatus: 'passed', verdictStatus: 'not_evaluated' },
      profiles: [{ healthStatus: 'passed', verdictStatus: 'passed' }],
      skippedInteractionProofCount: 1,
    }),
    'failed',
  );
});

test('formats comparison metric summaries for aggregate markdown', () => {
  assert.equal(
    formatComparisonMetricSummary({
      ...comparison('mixed'),
      metricSummary: {
        counts: {
          better: 1,
          worse: 1,
          unchanged: 6,
          inconclusive: 0,
          low_confidence: 0,
        },
        notableMetrics: [
          {
            baseline: 420,
            current: 398,
            delta: -22,
            name: 'cycle p50',
            status: 'better',
            unit: 'ms',
          },
          {
            baseline: 10,
            current: 16,
            delta: 6,
            name: 'close p50',
            status: 'worse',
            unit: 'ms',
          },
        ],
      },
    }),
    ' (metrics better=1 worse=1 unchanged=6 inconclusive=0 low_confidence=0; notable: cycle p50 better (-22ms), close p50 worse (6ms))',
  );
});

test('writes failed aggregate proofs with skipped interaction proof pointers', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-summary-failed-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const preflightDir = path.join(tempDir, '_preflight', 'ios-live-preflight');
  const profileDir = path.join(tempDir, 'app-startup', 'ios-live-startup');
  await fsp.mkdir(preflightDir, { recursive: true });
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.writeFile(path.join(preflightDir, 'agent-summary.md'), '# preflight\n', 'utf8');
  await fsp.writeFile(path.join(preflightDir, 'health.json'), '{"healthStatus":"passed"}\n', 'utf8');
  await fsp.writeFile(path.join(preflightDir, 'verdict.json'), '{"verdictStatus":"not_evaluated"}\n', 'utf8');
  await fsp.writeFile(path.join(profileDir, 'agent-summary.md'), '# profile\n\n## Next Action\n\n- Owner: `runtime_environment`\n', 'utf8');
  await fsp.writeFile(
    path.join(profileDir, 'manifest.json'),
    JSON.stringify({
      artifacts: {
        diagnostics: [
          {
            availability: 'provider-blocked',
            kind: 'accessibility',
            nextAction: 'Fix the accessibility provider output.',
            provider: 'axe',
            reason: 'Provider command failed before required output.',
            requested: true,
            required: true,
            status: 'failed',
            sufficiency: {
              reason: 'Required diagnostic was provider-blocked.',
              status: 'provider-blocked',
            },
          },
          {
            availability: 'requested-missing',
            kind: 'video',
            requested: true,
            required: false,
            runnerId: 'agent-device',
            status: 'missing',
            sufficiency: {
              reason: 'Optional requested capture was not produced.',
              status: 'requested-missing',
            },
          },
          {
            availability: 'not-requested',
            kind: 'network',
            requested: false,
            required: false,
            status: 'not_requested',
          },
          {
            availability: 'captured',
            kind: 'logs',
            requested: true,
            required: false,
            status: 'captured',
            sufficiency: {
              reason: 'Captured optional logs.',
              status: 'optional-preserved-evidence',
            },
          },
        ],
      },
    }),
    'utf8',
  );
  await fsp.writeFile(
    path.join(profileDir, 'health.json'),
    JSON.stringify({
      checks: [
        {
          code: 'partial_provider_evidence_preserved',
          message: 'Provider failed after preserving partial diagnostics.',
          metadata: {
            blockingDiagnosticSufficiency: 'accessibility:provider-blocked,uiTree:provider-blocked',
            capturedDiagnosticSufficiency: 'nativePerformance:diagnostic-only,profiler:diagnostic-only',
            nativePerformanceClaimSufficiency: 'insufficient-for-claim',
            nativePerformanceCompletenessStatus: 'partial',
            nativePerformanceComparability: 'diagnostic-only',
            nativePerformanceDiagnosticSources: 'xctrace:partial,metrickit:timeout',
            nativePerformanceTargetBinding: 'ambiguous',
            nextAction: 'Use preserved diagnostics for investigation only.',
            nextActionCode: 'use_partial_provider_evidence_for_diagnosis',
            nextActionOwner: 'provider_tooling',
          },
          name: 'partial_provider_evidence_preserved',
          status: 'warning',
        },
        {
          code: 'ios_profile_session_start_wait_exhausted',
          message: 'No same-run iOS profile-session app evidence appeared.',
          metadata: {
            commandCount: 0,
            devClientDeepLinkOpened: true,
            expectedEvidence: 'profile-session-start-or-profile-events',
            failureClass: 'dev_client_bundle_or_command_channel_not_ready',
            foregroundAppInfoCaptured: true,
            foregroundApplicationState: 'ForegroundRunning',
            foregroundRawPath: 'raw/ios-profile-session-start-app-info.txt',
            foregroundTargetOwned: true,
            lastDeepLinkLabel: 'ios-dev-client-url',
            pendingPhase: 'waiting_for_profile_session_start',
            profileSessionSeedRawPath: 'raw/ios-profile-session-seed.json',
            profileSessionSeeded: true,
            readinessRawPath: 'raw/ios-profile-session-readiness.json',
            nextAction: 'Confirm the iOS development client loaded the intended app bundle.',
            nextActionCode: 'fix_ios_dev_client_bundle_or_command_channel',
            nextActionOwner: 'runtime_environment',
          },
          name: 'ios_profile_session_start_wait',
          status: 'failed',
        },
      ],
      healthStatus: 'passed',
    }),
    'utf8',
  );
  await fsp.writeFile(path.join(profileDir, 'verdict.json'), '{"verdictStatus":"failed"}\n', 'utf8');
  const profileGateDiagnostics = readProfileGateDiagnosticSummary(profileDir);
  assert.deepEqual(profileGateDiagnostics, {
    blockingDiagnosticSufficiency: [
      { kind: 'accessibility', status: 'provider-blocked' },
      { kind: 'uiTree', status: 'provider-blocked' },
    ],
    capturedDiagnosticSufficiency: [
      { kind: 'nativePerformance', status: 'diagnostic-only' },
      { kind: 'profiler', status: 'diagnostic-only' },
    ],
    nativePerformance: {
      claimSufficiency: 'insufficient-for-claim',
      completenessStatus: 'partial',
      comparability: 'diagnostic-only',
      diagnosticSources: [
        { sourceId: 'xctrace', status: 'partial' },
        { sourceId: 'metrickit', status: 'timeout' },
      ],
      targetBinding: 'ambiguous',
    },
    providerEvidenceNextAction: {
      code: 'use_partial_provider_evidence_for_diagnosis',
      owner: 'provider_tooling',
      summary: 'Use preserved diagnostics for investigation only.',
    },
    requestedDiagnosticInventory: [
      {
        availability: 'provider-blocked',
        kind: 'accessibility',
        nextAction: 'Fix the accessibility provider output.',
        provider: 'axe',
        reason: 'Provider command failed before required output.',
        required: true,
        status: 'failed',
        sufficiencyStatus: 'provider-blocked',
      },
      {
        availability: 'requested-missing',
        kind: 'video',
        required: false,
        runnerId: 'agent-device',
        status: 'missing',
        sufficiencyStatus: 'requested-missing',
      },
    ],
  });
  const profileGateReadiness = readProfileGateReadinessSummary(profileDir);
  assert.deepEqual(profileGateReadiness, {
    commandCount: 0,
    devClientDeepLinkOpened: true,
    expectedEvidence: 'profile-session-start-or-profile-events',
    failureClass: 'dev_client_bundle_or_command_channel_not_ready',
    foregroundAppInfoCaptured: true,
    foregroundApplicationState: 'ForegroundRunning',
    foregroundRawPath: 'raw/ios-profile-session-start-app-info.txt',
    foregroundTargetOwned: true,
    lastDeepLinkLabel: 'ios-dev-client-url',
    pendingPhase: 'waiting_for_profile_session_start',
    profileSessionSeedRawPath: 'raw/ios-profile-session-seed.json',
    profileSessionSeeded: true,
    readinessRawPath: 'raw/ios-profile-session-readiness.json',
    readinessNextAction: {
      code: 'fix_ios_dev_client_bundle_or_command_channel',
      owner: 'runtime_environment',
      summary: 'Confirm the iOS development client loaded the intended app bundle.',
    },
  });

  const result = await writeLiveProofSummary({
    comparisons: [],
    outputDir: tempDir,
    platform: 'ios',
    preflightDir,
    preflightRunId: 'ios-live-preflight',
    profiles: [
      {
        label: 'startup',
        runDir: profileDir,
        runId: 'ios-live-startup',
        scenarioId: 'app-startup',
      },
    ],
    runId: 'ios-live-proof',
    skippedInteractionProofs: [
      {
        label: 'interaction-argent',
        nextAction: {
          code: 'fix_profile_gate',
          owner: 'asl_runner',
          summary: 'Inspect the profile first.',
        },
        reason: 'Profile verdict failed.',
        profileGateDiagnostics,
        profileGateReadiness,
        runId: 'app-startup-ios-argent',
        runnerId: 'argent',
        scenarioId: 'app-startup',
      },
    ],
  });

  const artifact = JSON.parse(fs.readFileSync(result.liveProofPath, 'utf8'));
  assert.equal(artifact.status, 'failed');
  assert.deepEqual(artifact.nextAction, {
    code: 'inspect_failed_run',
    owner: 'runtime_environment',
    summary: 'One or more live proof gates failed; inspect failed profile or interaction summaries before making optimization claims.',
  });
  assert.equal(artifact.summary, 'ios live proof failed with 1 failed profile run(s) without comparison results; skipped 1 interaction proof(s).');
  assert.equal('nextActionOwner' in artifact.profiles[0], false);
  assert.deepEqual(artifact.profileGateRequestedDiagnostics, {
    requestedDiagnosticCounts: [
      {
        availability: 'provider-blocked',
        count: 1,
        kind: 'accessibility',
        required: true,
        status: 'failed',
        sufficiencyStatus: 'provider-blocked',
      },
      {
        availability: 'requested-missing',
        count: 1,
        kind: 'video',
        required: false,
        status: 'missing',
        sufficiencyStatus: 'requested-missing',
      },
    ],
    skippedInteractionProofCount: 1,
  });
  assert.deepEqual(artifact.profileGateProviderEvidenceNextActions, {
    nextActionCounts: [
      {
        code: 'use_partial_provider_evidence_for_diagnosis',
        count: 1,
        owner: 'provider_tooling',
      },
    ],
    skippedInteractionProofCount: 1,
  });
  assert.deepEqual(artifact.profileGateReadinessNextActions, {
    nextActionCounts: [
      {
        code: 'fix_ios_dev_client_bundle_or_command_channel',
        count: 1,
        owner: 'runtime_environment',
      },
    ],
    skippedInteractionProofCount: 1,
  });
  assert.deepEqual(artifact.profileGateReadiness, {
    commandCountTotal: 0,
    devClientDeepLinkOpenedCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    expectedEvidenceCounts: [
      {
        count: 1,
        value: 'profile-session-start-or-profile-events',
      },
    ],
    failureClassCounts: [
      {
        count: 1,
        value: 'dev_client_bundle_or_command_channel_not_ready',
      },
    ],
    foregroundAppInfoCapturedCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    foregroundApplicationStateCounts: [
      {
        count: 1,
        value: 'ForegroundRunning',
      },
    ],
    foregroundTargetOwnedCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    pendingPhaseCounts: [
      {
        count: 1,
        value: 'waiting_for_profile_session_start',
      },
    ],
    profileSessionSeededCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    readinessDetailCounts: [
      {
        count: 1,
        value: 'dev-client-deep-link-opened',
      },
      {
        count: 1,
        value: 'no-profile-session-command',
      },
      {
        count: 1,
        value: 'profile-session-storage-seeded',
      },
      {
        count: 1,
        value: 'target-foreground-owned',
      },
    ],
    readinessProofCount: 1,
    skippedInteractionProofCount: 1,
  });
  assert.equal(artifact.skippedInteractionProofs[0].runnerId, 'argent');
  assert.deepEqual(artifact.skippedInteractionProofs[0].profileGateDiagnostics, profileGateDiagnostics);
  assert.deepEqual(artifact.skippedInteractionProofs[0].profileGateReadiness, profileGateReadiness);
  const summary = fs.readFileSync(result.summaryPath, 'utf8');
  assert.match(summary, /Next action: runtime_environment\/inspect_failed_run/u);
  assert.match(summary, /## Profile Gate Requested Diagnostics/u);
  assert.match(summary, /requested=accessibility:provider-blocked\(required\)=1, video:requested-missing\(optional\)=1/u);
  assert.match(summary, /## Provider Evidence Next Actions/u);
  assert.match(summary, /actions=provider_tooling\/use_partial_provider_evidence_for_diagnosis=1/u);
  assert.match(summary, /## Profile Gate Readiness/u);
  assert.match(summary, /skippedInteractionProofs=1; readinessProofs=1; commands=0; failure=dev_client_bundle_or_command_channel_not_ready=1; devClientDeepLinkOpened=true=1; foregroundAppInfoCaptured=true=1; foregroundApplicationState=ForegroundRunning=1; foregroundTargetOwned=true=1; profileSessionSeeded=true=1; phase=waiting_for_profile_session_start=1; detail=dev-client-deep-link-opened=1, no-profile-session-command=1, profile-session-storage-seeded=1, target-foreground-owned=1; expected=profile-session-start-or-profile-events=1/u);
  assert.match(summary, /## Profile Gate Readiness Next Actions/u);
  assert.match(summary, /actions=runtime_environment\/fix_ios_dev_client_bundle_or_command_channel=1/u);
  assert.match(summary, /## Skipped Interaction Proofs/u);
  assert.match(summary, /Diagnostics: captured=nativePerformance:diagnostic-only, profiler:diagnostic-only; blocking=accessibility:provider-blocked, uiTree:provider-blocked; requested=accessibility:provider-blocked\(required, provider=axe\), video:requested-missing\(optional, runner=agent-device\); providerNextAction=provider_tooling\/use_partial_provider_evidence_for_diagnosis - Use preserved diagnostics for investigation only\.; nativePerformance\(claim=insufficient-for-claim, completeness=partial, comparability=diagnostic-only, target=ambiguous, sources=xctrace:partial, metrickit:timeout\)\./u);
  assert.match(summary, /Readiness: failure=dev_client_bundle_or_command_channel_not_ready, commands=0, devClientDeepLinkOpened=true, foregroundAppInfoCaptured=true, foregroundApplicationState=ForegroundRunning, foregroundTargetOwned=true, lastDeepLink=ios-dev-client-url, profileSessionSeeded=true, phase=waiting_for_profile_session_start, expected=profile-session-start-or-profile-events, readinessNextAction=runtime_environment\/fix_ios_dev_client_bundle_or_command_channel - Confirm the iOS development client loaded the intended app bundle\., foregroundRawPath=raw\/ios-profile-session-start-app-info\.txt, profileSessionSeedRawPath=raw\/ios-profile-session-seed\.json, readinessRawPath=raw\/ios-profile-session-readiness\.json\./u);
});

test('writes optional interaction proof pointers into aggregate live proof artifacts', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-summary-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const preflightDir = path.join(tempDir, '_preflight', 'android-live-preflight');
  const profileDir = path.join(tempDir, 'app-startup', 'android-live-startup');
  const interactionDir = path.join(tempDir, '_agent-device-captures', 'android-agent-device-startup');
  await fsp.mkdir(preflightDir, { recursive: true });
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.mkdir(interactionDir, { recursive: true });
  await fsp.writeFile(path.join(preflightDir, 'agent-summary.md'), '# preflight\n', 'utf8');
  await fsp.writeFile(path.join(profileDir, 'agent-summary.md'), '# profile\n', 'utf8');
  await fsp.writeFile(path.join(profileDir, 'health.json'), '{"healthStatus":"passed"}\n', 'utf8');
  await fsp.writeFile(path.join(profileDir, 'verdict.json'), '{"verdictStatus":"passed"}\n', 'utf8');
  await fsp.mkdir(path.join(profileDir, 'raw', 'providers', 'native'), { recursive: true });
  await fsp.writeFile(
    path.join(profileDir, 'manifest.json'),
    JSON.stringify({
      artifacts: {
        evidenceAttachments: [
          {
            kind: 'nativePerformance',
            path: 'raw/providers/native/native-performance.json',
          },
        ],
      },
    }),
    'utf8',
  );
  await fsp.writeFile(
    path.join(profileDir, 'raw', 'providers', 'native', 'native-performance.json'),
    JSON.stringify({
      claimSufficiency: {
        status: 'insufficient-for-claim',
      },
      completenessStatus: 'partial',
      comparability: {
        status: 'diagnostic-only',
      },
      diagnosticSources: [
        {
          sourceId: 'gfxinfo',
          status: 'partial',
        },
        {
          sourceId: 'meminfo',
          status: 'captured',
        },
      ],
      platform: 'android',
      providerId: 'native',
      runId: 'android-live-startup',
      scenarioId: 'app-startup',
      schemaVersion: '1.0.0',
      targetBinding: {
        candidateTargets: [
          {
            bindingStatus: 'expected',
            reason: 'Requested app id matched the provider command.',
            source: 'manifest',
          },
          {
            bindingStatus: 'observed',
            reason: 'Observed another debuggable runtime in trace metadata.',
            source: 'trace',
          },
        ],
        reason: 'Two app runtimes were visible during capture.',
        source: 'provider',
        status: 'ambiguous',
      },
    }),
    'utf8',
  );
  await fsp.writeFile(path.join(interactionDir, 'agent-summary.md'), '# interaction\n', 'utf8');
  await fsp.writeFile(
    path.join(interactionDir, 'health.json'),
    JSON.stringify({
      healthStatus: 'passed',
      checks: [
        {
          code: 'argent_screenshot_failed',
          message: 'Argent driver action screenshot failed.',
          metadata: {
            nextAction: 'Inspect raw screenshot output.',
            nextActionCode: 'inspect_argent_driver_action',
          },
          name: 'argent_screenshot',
          status: 'warning',
        },
      ],
    }),
    'utf8',
  );
  await fsp.writeFile(path.join(interactionDir, 'verdict.json'), '{"verdictStatus":"not_evaluated"}\n', 'utf8');
  await fsp.mkdir(path.join(interactionDir, 'raw'), { recursive: true });
  await fsp.writeFile(
    path.join(interactionDir, 'raw', 'agent-device-metadata.json'),
    JSON.stringify({
      captures: {
        screenshots: ['captures/startup-ui.png'],
      },
    }),
    'utf8',
  );
  await fsp.writeFile(path.join(preflightDir, 'health.json'), '{"healthStatus":"passed"}\n', 'utf8');
  await fsp.writeFile(path.join(preflightDir, 'verdict.json'), '{"verdictStatus":"not_evaluated"}\n', 'utf8');

  const result = await writeLiveProofSummary({
    comparisons: [],
    interactionProofs: [
      {
        label: 'startup-ui',
        runDir: interactionDir,
        runId: 'android-agent-device-startup',
        runnerId: 'agent-device',
        scenarioId: 'app-startup',
      },
    ],
    outputDir: tempDir,
    platform: 'android',
    preflightDir,
    preflightRunId: 'android-live-preflight',
    profiles: [
      {
        label: 'startup',
        runDir: profileDir,
        runId: 'android-live-startup',
        scenarioId: 'app-startup',
      },
    ],
    runId: 'android-live-proof',
  });

  const artifact = JSON.parse(fs.readFileSync(result.liveProofPath, 'utf8'));
  assert.equal(artifact.summary, 'android live proof passed with 1 passed profile run(s) and 1 passed interaction proof(s) without comparison results; 1 interaction warning(s).');
  assert.deepEqual(artifact.profileNativePerformance, {
    claimSufficiencyCounts: [
      {
        count: 1,
        status: 'insufficient-for-claim',
      },
    ],
    completenessStatusCounts: [
      {
        count: 1,
        status: 'partial',
      },
    ],
    comparabilityCounts: [
      {
        count: 1,
        status: 'diagnostic-only',
      },
    ],
    diagnosticSourceCounts: [
      {
        count: 1,
        sourceId: 'gfxinfo',
        status: 'partial',
      },
      {
        count: 1,
        sourceId: 'meminfo',
        status: 'captured',
      },
    ],
    evidenceCount: 1,
    profileCount: 1,
    targetBindingCounts: [
      {
        count: 1,
        status: 'ambiguous',
      },
    ],
    targetBindingDetailCounts: [
      {
        candidateBindingStatus: 'expected',
        count: 1,
        reason: 'Requested app id matched the provider command.',
        source: 'manifest',
        status: 'ambiguous',
      },
      {
        candidateBindingStatus: 'observed',
        count: 1,
        reason: 'Observed another debuggable runtime in trace metadata.',
        source: 'trace',
        status: 'ambiguous',
      },
    ],
  });
  assert.deepEqual(
    {
      healthStatus: artifact.preflight.healthStatus,
      verdictStatus: artifact.preflight.verdictStatus,
    },
    {
      healthStatus: 'passed',
      verdictStatus: 'not_evaluated',
    },
  );
  assert.deepEqual(
    artifact.interactionProofs.map((proof: { captures?: { screenshots: string[] }; healthStatus: string; label: string; runnerId: string; summaryPath: string; warnings?: Record<string, unknown> }) => ({
      captures: proof.captures,
        healthStatus: proof.healthStatus,
        label: proof.label,
        runnerId: proof.runnerId,
        summaryPath: proof.summaryPath,
        warnings: proof.warnings,
      })),
    [
      {
        captures: {
          screenshots: ['captures/startup-ui.png'],
        },
        healthStatus: 'passed',
        label: 'startup-ui',
        runnerId: 'agent-device',
        summaryPath: path.join(interactionDir, 'agent-summary.md'),
        warnings: {
          checks: [
            {
              code: 'argent_screenshot_failed',
              message: 'Argent driver action screenshot failed.',
              name: 'argent_screenshot',
              nextAction: {
                code: 'inspect_argent_driver_action',
                owner: 'provider_tooling',
                summary: 'Inspect raw screenshot output.',
              },
            },
          ],
          count: 1,
        },
      },
    ],
  );
  const summary = fs.readFileSync(result.summaryPath, 'utf8');
  assert.match(summary, /Next action: product_optimization\/inspect_summary/u);
  assert.match(summary, /## Interaction Proofs/u);
  assert.match(summary, /## Native Performance/u);
  assert.match(summary, /profiles=1; evidence=1; sources=gfxinfo:partial=1, meminfo:captured=1; completeness=partial=1; claim=insufficient-for-claim=1; comparability=diagnostic-only=1; target=ambiguous=1; targetDetails=ambiguous:candidate=expected:source=manifest:reason=Requested app id matched the provider command\.=1, ambiguous:candidate=observed:source=trace:reason=Observed another debuggable runtime in trace metadata\.=1/u);
  assert.match(summary, /screenshots=1/u);
  assert.match(summary, /warnings=1/u);
  assert.match(summary, /warning argent_screenshot: argent_screenshot_failed - Argent driver action screenshot failed\. Next action: provider_tooling\/inspect_argent_driver_action - Inspect raw screenshot output\./u);
});
