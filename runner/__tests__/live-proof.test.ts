const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  countLiveProofComparisons,
  deriveLiveProofComparisonStatus,
  expectedLiveProofNextActionCode,
  formatLiveProof,
  parseArgs,
  readLiveProof,
  shouldFailOnRegression,
} = require('../live-proof');

type TestContext = import('node:test').TestContext;

/**
 * Builds a minimal valid live-proof artifact for CLI tests.
 *
 * @param {'regressed' | 'unchanged'} comparisonStatus
 * @returns {Record<string, unknown>}
 */
function buildProof(comparisonStatus: 'regressed' | 'unchanged'): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    platform: 'android',
    runId: 'android-live-proof',
    status: 'passed',
    outputDir: 'artifacts/example-mobile-app/android',
    preflight: {
      runId: 'android-live-preflight',
      runDir: 'artifacts/example-mobile-app/android/_preflight/android-live-preflight',
      summaryPath: 'artifacts/example-mobile-app/android/_preflight/android-live-preflight/agent-summary.md',
    },
    profiles: [
      {
        healthStatus: 'passed',
        label: 'startup',
        scenarioId: 'app-startup',
        runId: 'android-live-startup',
        runDir: 'artifacts/example-mobile-app/android/app-startup/android-live-startup',
        summaryPath: 'artifacts/example-mobile-app/android/app-startup/android-live-startup/agent-summary.md',
        verdictStatus: 'passed',
      },
    ],
    comparisons: [
      {
        label: 'startup',
        scenarioId: 'app-startup',
        runId: 'android-live-startup',
        status: comparisonStatus === 'regressed' ? 'worse' : 'unchanged',
        baselineDir: 'artifacts/example-mobile-app/android/app-startup/android-live-startup-baseline',
        comparisonDir: 'artifacts/example-mobile-app/android/comparisons/app-startup/android-live-startup',
        summaryPath: 'artifacts/example-mobile-app/android/comparisons/app-startup/android-live-startup/agent-summary.md',
        reason: null,
      },
    ],
    comparisonCounts: comparisonStatus === 'regressed'
      ? {
          better: 0,
          inconclusive: 0,
          skipped: 0,
          unchanged: 0,
          worse: 1,
        }
      : {
          better: 0,
          inconclusive: 0,
          skipped: 0,
          unchanged: 1,
          worse: 0,
        },
    comparisonStatus,
    nextAction: {
      code: comparisonStatus === 'regressed' ? 'inspect_regressions' : 'inspect_summary',
      summary: 'Inspect linked evidence.',
    },
    summary: `android live proof ${comparisonStatus}.`,
  };
}

/**
 * Writes one proof artifact to a temporary file.
 *
 * @param {string} tempDir
 * @param {Record<string, unknown>} proof
 * @returns {string}
 */
function writeProof(tempDir: string, proof: Record<string, unknown>): string {
  const proofPath = path.join(tempDir, 'live-proof.json');
  fs.writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return proofPath;
}

test('parses live-proof CLI arguments', () => {
  assert.deepEqual(parseArgs(['--file', 'live-proof.json', '--fail-on-regression']), {
    file: 'live-proof.json',
    'fail-on-regression': true,
  });
});

test('counts live-proof comparison statuses from pointers', () => {
  assert.deepEqual(
    countLiveProofComparisons([
      { status: 'better' },
      { status: 'worse' },
      { status: 'unchanged' },
      { status: 'unchanged' },
      { status: 'inconclusive' },
      { status: 'skipped' },
    ]),
    {
      better: 1,
      inconclusive: 1,
      skipped: 1,
      unchanged: 2,
      worse: 1,
    },
  );
});

test('derives aggregate status and next action from comparisons', () => {
  assert.equal(deriveLiveProofComparisonStatus([]), 'not_compared');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'skipped' }]), 'baseline_missing');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'skipped' }]), 'inconclusive');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'inconclusive' }]), 'inconclusive');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'unchanged' }]), 'improved');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'unchanged' }]), 'unchanged');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'worse' }]), 'regressed');

  assert.equal(expectedLiveProofNextActionCode('regressed'), 'inspect_regressions');
  assert.equal(expectedLiveProofNextActionCode('baseline_missing'), 'establish_baseline');
  assert.equal(expectedLiveProofNextActionCode('inconclusive'), 'inspect_inconclusive');
  assert.equal(expectedLiveProofNextActionCode('improved'), 'inspect_summary');
  assert.equal(expectedLiveProofNextActionCode('unchanged'), 'inspect_summary');
  assert.equal(expectedLiveProofNextActionCode('not_compared'), 'inspect_summary');
});

test('rejects live-proof artifacts with inconsistent comparison counts', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-counts-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  (proof.comparisonCounts as Record<string, number>).worse = 1;
  const proofPath = writeProof(tempDir, proof);

  assert.throws(
    () => readLiveProof(proofPath),
    /comparisonCounts\.unchanged expected 1 from comparisons but found 0|comparisonCounts\.worse expected 0 from comparisons but found 1/u,
  );
});

test('rejects live-proof artifacts with inconsistent aggregate status', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-status-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  proof.comparisonStatus = 'regressed';
  const proofPath = writeProof(tempDir, proof);

  assert.throws(
    () => readLiveProof(proofPath),
    /comparisonStatus expected unchanged from comparisons but found regressed/u,
  );
});

test('rejects live-proof artifacts with inconsistent next action', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-action-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  (proof.nextAction as Record<string, string>).code = 'inspect_regressions';
  const proofPath = writeProof(tempDir, proof);

  assert.throws(
    () => readLiveProof(proofPath),
    /nextAction\.code expected inspect_summary for unchanged but found inspect_regressions/u,
  );
});

test('reads, validates, and formats live-proof artifacts', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proofPath = writeProof(tempDir, buildProof('unchanged'));

  const proof = readLiveProof(proofPath);
  const output = formatLiveProof(proof);

  assert.equal(proof.comparisonStatus, 'unchanged');
  assert.match(output, /Live proof: android android-live-proof/u);
  assert.match(output, /startup \(app-startup\/android-live-startup\): health=passed verdict=passed/u);
  assert.match(output, /Comparison counts: better=0 worse=0 unchanged=1 inconclusive=0 skipped=0/u);
  assert.match(output, /Next action: inspect_summary/u);
  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), false);
});

test('supports a fail-on-regression gate', () => {
  const proof = buildProof('regressed') as ReturnType<typeof readLiveProof>;

  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), true);
  assert.equal(shouldFailOnRegression({ failOnRegression: false, proof }), false);
});
