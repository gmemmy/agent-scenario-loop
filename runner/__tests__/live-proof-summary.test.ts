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
  await fsp.writeFile(path.join(profileDir, 'health.json'), '{"healthStatus":"passed"}\n', 'utf8');
  await fsp.writeFile(path.join(profileDir, 'verdict.json'), '{"verdictStatus":"failed"}\n', 'utf8');

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
  assert.equal(artifact.skippedInteractionProofs[0].runnerId, 'argent');
  const summary = fs.readFileSync(result.summaryPath, 'utf8');
  assert.match(summary, /Next action: runtime_environment\/inspect_failed_run/u);
  assert.match(summary, /## Skipped Interaction Proofs/u);
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
  assert.match(summary, /screenshots=1/u);
  assert.match(summary, /warnings=1/u);
  assert.match(summary, /warning argent_screenshot: argent_screenshot_failed - Argent driver action screenshot failed\. Next action: provider_tooling\/inspect_argent_driver_action - Inspect raw screenshot output\./u);
});
