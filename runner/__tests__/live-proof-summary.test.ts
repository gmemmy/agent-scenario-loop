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
 * @param {'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'skipped'} status
 * @returns {Record<string, unknown>}
 */
function comparison(status: 'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'skipped'): Record<string, unknown> {
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
      comparison('skipped'),
    ]),
    {
      better: 1,
      inconclusive: 1,
      mixed: 1,
      skipped: 1,
      unchanged: 2,
      worse: 1,
    },
  );
});

test('maps aggregate live proof statuses to next actions', () => {
  assert.equal(buildLiveProofNextAction('unchanged', 'failed').code, 'inspect_failed_run');
  assert.equal(buildLiveProofNextAction('regressed').code, 'inspect_regressions');
  assert.equal(buildLiveProofNextAction('baseline_missing').code, 'establish_baseline');
  assert.equal(buildLiveProofNextAction('inconclusive').code, 'inspect_inconclusive');
  assert.equal(buildLiveProofNextAction('mixed').code, 'inspect_mixed');
  assert.equal(buildLiveProofNextAction('improved').code, 'inspect_summary');
  assert.equal(buildLiveProofNextAction('unchanged').code, 'inspect_summary');
  assert.equal(buildLiveProofNextAction('not_compared').code, 'inspect_summary');
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
    ' (metrics better=1 worse=1 unchanged=6 inconclusive=0; notable: cycle p50 better (-22ms), close p50 worse (6ms))',
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
  await fsp.writeFile(path.join(profileDir, 'agent-summary.md'), '# profile\n', 'utf8');
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
  assert.equal(artifact.nextAction.code, 'inspect_failed_run');
  assert.equal(artifact.skippedInteractionProofs[0].runnerId, 'argent');
  assert.match(fs.readFileSync(result.summaryPath, 'utf8'), /## Skipped Interaction Proofs/u);
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
  await fsp.writeFile(path.join(interactionDir, 'health.json'), '{"healthStatus":"passed"}\n', 'utf8');
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
  assert.equal(artifact.summary, 'android live proof passed 1 profile run(s) and 1 interaction proof(s) without comparison results.');
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
    artifact.interactionProofs.map((proof: { captures?: { screenshots: string[] }; healthStatus: string; label: string; runnerId: string; summaryPath: string }) => ({
      captures: proof.captures,
      healthStatus: proof.healthStatus,
      label: proof.label,
      runnerId: proof.runnerId,
      summaryPath: proof.summaryPath,
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
      },
    ],
  );
  const summary = fs.readFileSync(result.summaryPath, 'utf8');
  assert.match(summary, /## Interaction Proofs/u);
  assert.match(summary, /screenshots=1/u);
});
