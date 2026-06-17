const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLiveProofSetArtifact,
  countLiveProofComparisons,
  deriveLiveProofComparisonStatus,
  expectedLiveProofNextActionCode,
  formatLiveProof,
  formatLiveProofSet,
  formatLiveProofSetArtifactMarkdown,
  parseArgs,
  parseRequiredPlatforms,
  readLiveProof,
  readLiveProofSet,
  resolveLiveProofFiles,
  writeLiveProofSetArtifact,
  shouldFailLiveProofSet,
  shouldFailOnRegression,
} = require('../live-proof');

type TestContext = import('node:test').TestContext;

/**
 * Builds a minimal valid live-proof artifact for CLI tests.
 *
 * @param {'mixed' | 'regressed' | 'unchanged'} comparisonStatus
 * @param {'failed' | 'passed'} [status]
 * @param {'android' | 'ios'} [platform]
 * @returns {Record<string, unknown>}
 */
function buildProof(
  comparisonStatus: 'mixed' | 'regressed' | 'unchanged',
  status: 'failed' | 'passed' = 'passed',
  platform: 'android' | 'ios' = 'android',
): Record<string, unknown> {
  const comparisonPointerStatus = comparisonStatus === 'regressed'
    ? 'worse'
    : comparisonStatus === 'mixed'
      ? 'mixed'
      : 'unchanged';
  return {
    schemaVersion: '1.0.0',
    platform,
    runId: `${platform}-live-proof`,
    status,
    outputDir: `artifacts/example-mobile-app/${platform}`,
    preflight: {
      healthStatus: 'passed',
      runId: `${platform}-live-preflight`,
      runDir: `artifacts/example-mobile-app/${platform}/_preflight/${platform}-live-preflight`,
      summaryPath: `artifacts/example-mobile-app/${platform}/_preflight/${platform}-live-preflight/agent-summary.md`,
      verdictStatus: 'not_evaluated',
    },
    profiles: [
      {
        healthStatus: 'passed',
        label: 'startup',
        scenarioId: 'app-startup',
        runId: `${platform}-live-startup`,
        runDir: `artifacts/example-mobile-app/${platform}/app-startup/${platform}-live-startup`,
        summaryPath: `artifacts/example-mobile-app/${platform}/app-startup/${platform}-live-startup/agent-summary.md`,
        verdictStatus: 'passed',
      },
    ],
    interactionProofs: [
      {
        captures: {
          screenshots: ['captures/startup-ui.png'],
        },
        healthStatus: 'passed',
        label: 'startup-ui',
        runDir: `artifacts/example-mobile-app/${platform}/_agent-device-captures/agent-device-startup`,
        runnerId: 'agent-device',
        scenarioId: 'app-startup',
        runId: 'agent-device-startup',
        summaryPath: `artifacts/example-mobile-app/${platform}/_agent-device-captures/agent-device-startup/agent-summary.md`,
        verdictStatus: 'not_evaluated',
        warnings: {
          checks: [
            {
              code: 'argent_screenshot_failed',
              message: 'Argent driver action screenshot failed.',
              name: 'argent_screenshot',
              nextAction: {
                code: 'inspect_argent_driver_action',
                summary: 'Inspect raw screenshot output.',
              },
            },
          ],
          count: 1,
        },
      },
    ],
    comparisons: [
      {
        label: 'startup',
        scenarioId: 'app-startup',
        runId: `${platform}-live-startup`,
        status: comparisonPointerStatus,
        baselineDir: `artifacts/example-mobile-app/${platform}/app-startup/${platform}-live-startup-baseline`,
        comparisonDir: `artifacts/example-mobile-app/${platform}/comparisons/app-startup/${platform}-live-startup`,
        summaryPath: `artifacts/example-mobile-app/${platform}/comparisons/app-startup/${platform}-live-startup/agent-summary.md`,
        reason: null,
        metricSummary: {
          counts: {
            better: comparisonStatus === 'mixed' ? 1 : 0,
            worse: comparisonStatus === 'regressed' || comparisonStatus === 'mixed' ? 1 : 0,
            unchanged: comparisonStatus === 'unchanged' ? 1 : 0,
            inconclusive: 0,
          },
          notableMetrics: comparisonStatus === 'mixed'
            ? [
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
              ]
            : comparisonStatus === 'regressed'
              ? [
                  {
                    baseline: 400,
                    current: 426,
                    delta: 26,
                    name: 'cycle p95',
                    status: 'worse',
                    unit: 'ms',
                  },
                ]
              : [],
        },
      },
    ],
    comparisonCounts: comparisonStatus === 'regressed'
      ? {
          better: 0,
          inconclusive: 0,
          mixed: 0,
          skipped: 0,
          unchanged: 0,
          worse: 1,
        }
      : comparisonStatus === 'mixed'
        ? {
            better: 0,
            inconclusive: 0,
            mixed: 1,
            skipped: 0,
            unchanged: 0,
            worse: 0,
          }
        : {
            better: 0,
            inconclusive: 0,
            mixed: 0,
            skipped: 0,
            unchanged: 1,
            worse: 0,
          },
    comparisonStatus,
    nextAction: {
      code: status === 'failed'
        ? 'inspect_failed_run'
        : comparisonStatus === 'regressed'
        ? 'inspect_regressions'
        : comparisonStatus === 'mixed'
          ? 'inspect_mixed'
          : 'inspect_summary',
      summary: 'Inspect linked evidence.',
    },
    summary: `${platform} live proof ${status}/${comparisonStatus}.`,
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
  const args = parseArgs([
    '--file',
    'android-live-proof.json',
    '--file',
    'ios-live-proof.json',
    '--require-platforms',
    'android,ios',
    '--out',
    'artifacts/asl/live-proof-set',
    '--run-id',
    'current-platform-set',
    '--fail-on-regression',
  ]);

  assert.deepEqual(args, {
    file: ['android-live-proof.json', 'ios-live-proof.json'],
    'fail-on-regression': true,
    out: 'artifacts/asl/live-proof-set',
    'require-platforms': 'android,ios',
    'run-id': 'current-platform-set',
  });
  assert.deepEqual(resolveLiveProofFiles(args), ['android-live-proof.json', 'ios-live-proof.json']);
  assert.deepEqual(parseRequiredPlatforms(args['require-platforms']), ['android', 'ios']);
});

test('counts live-proof comparison statuses from pointers', () => {
  assert.deepEqual(
    countLiveProofComparisons([
      { status: 'better' },
      { status: 'worse' },
      { status: 'mixed' },
      { status: 'unchanged' },
      { status: 'unchanged' },
      { status: 'inconclusive' },
      { status: 'skipped' },
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

test('derives aggregate status and next action from comparisons', () => {
  assert.equal(deriveLiveProofComparisonStatus([]), 'not_compared');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'skipped' }]), 'baseline_missing');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'skipped' }]), 'inconclusive');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'inconclusive' }]), 'inconclusive');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'mixed' }]), 'mixed');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'unchanged' }]), 'improved');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'unchanged' }]), 'unchanged');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'worse' }]), 'regressed');

  assert.equal(expectedLiveProofNextActionCode('regressed'), 'inspect_regressions');
  assert.equal(expectedLiveProofNextActionCode('regressed', 'failed'), 'inspect_failed_run');
  assert.equal(expectedLiveProofNextActionCode('baseline_missing'), 'establish_baseline');
  assert.equal(expectedLiveProofNextActionCode('inconclusive'), 'inspect_inconclusive');
  assert.equal(expectedLiveProofNextActionCode('mixed'), 'inspect_mixed');
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
    /nextAction\.code expected inspect_summary for passed\/unchanged but found inspect_regressions/u,
  );
});

test('reads and formats a required Android and iOS live-proof set', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const androidProofPath = writeProof(tempDir, buildProof('unchanged', 'passed', 'android'));
  const iosProofPath = path.join(tempDir, 'ios-live-proof.json');
  fs.writeFileSync(iosProofPath, `${JSON.stringify(buildProof('unchanged', 'passed', 'ios'), null, 2)}\n`, 'utf8');

  const proofs = readLiveProofSet({
    files: [androidProofPath, iosProofPath],
    requiredPlatforms: ['android', 'ios'],
  });
  const output = formatLiveProofSet({
    proofs,
    requiredPlatforms: ['android', 'ios'],
  });

  assert.equal(proofs.length, 2);
  assert.match(output, /Live proof set: 2 artifact\(s\)/u);
  assert.match(output, /Required platforms: android, ios/u);
  assert.match(output, /Present platforms: android, ios/u);
  assert.match(output, /Live proof: android android-live-proof/u);
  assert.match(output, /Live proof: ios ios-live-proof/u);
});

test('rejects a live-proof set when a required platform is missing', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-missing-platform-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proofPath = writeProof(tempDir, buildProof('unchanged', 'passed', 'android'));

  assert.throws(
    () => readLiveProofSet({
      files: [proofPath],
      requiredPlatforms: ['android', 'ios'],
    }),
    /missing required platform\(s\): ios\. Present platform\(s\): android/u,
  );
});

test('builds a durable live-proof-set artifact for Android and iOS proofs', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-artifact-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const androidProofPath = writeProof(tempDir, buildProof('unchanged', 'passed', 'android'));
  const iosProofPath = path.join(tempDir, 'ios-live-proof.json');
  fs.writeFileSync(iosProofPath, `${JSON.stringify(buildProof('unchanged', 'passed', 'ios'), null, 2)}\n`, 'utf8');
  const proofs = [readLiveProof(androidProofPath), readLiveProof(iosProofPath)];

  const artifact = buildLiveProofSetArtifact({
    failOnRegression: true,
    files: [androidProofPath, iosProofPath],
    proofs,
    requiredPlatforms: ['android', 'ios'],
    runId: 'both-platforms',
  });
  const markdown = formatLiveProofSetArtifactMarkdown(artifact);

  assert.equal(artifact.status, 'passed');
  assert.equal(artifact.proofCount, 2);
  assert.deepEqual(artifact.presentPlatforms, ['android', 'ios']);
  assert.deepEqual(artifact.missingPlatforms, []);
  assert.deepEqual(artifact.failureReasons, []);
  assert.equal(artifact.proofs[0].interactionWarningCount, 1);
  assert.match(markdown, /Status: passed/u);
  assert.match(markdown, /- android android-live-proof: status=passed comparison=unchanged/u);
  assert.match(markdown, /- ios ios-live-proof: status=passed comparison=unchanged/u);
});

test('builds a failed live-proof-set artifact when a required platform is missing', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-missing-artifact-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proofPath = writeProof(tempDir, buildProof('unchanged', 'passed', 'android'));

  const artifact = buildLiveProofSetArtifact({
    failOnRegression: true,
    files: [proofPath],
    proofs: [readLiveProof(proofPath)],
    requiredPlatforms: ['android', 'ios'],
    runId: 'missing-ios',
  });

  assert.equal(artifact.status, 'failed');
  assert.deepEqual(artifact.missingPlatforms, ['ios']);
  assert.deepEqual(artifact.failureReasons, ['Missing required platform proof: ios.']);
  assert.equal(artifact.nextAction.code, 'collect_missing_platform_proofs');
});

test('writes live-proof-set artifact and agent summary', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-write-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proofPath = writeProof(tempDir, buildProof('unchanged', 'passed', 'android'));
  const outputDir = path.join(tempDir, 'proof-set');
  const artifact = buildLiveProofSetArtifact({
    failOnRegression: false,
    files: [proofPath],
    proofs: [readLiveProof(proofPath)],
    requiredPlatforms: ['android'],
    runId: 'android-only',
  });

  const written = await writeLiveProofSetArtifact({ artifact, outputDir });
  const writtenJson = JSON.parse(fs.readFileSync(written.liveProofSetPath, 'utf8'));
  const writtenSummary = fs.readFileSync(written.summaryPath, 'utf8');

  assert.equal(written.liveProofSetPath, path.join(outputDir, 'live-proof-set.json'));
  assert.equal(written.summaryPath, path.join(outputDir, 'agent-summary.md'));
  assert.equal(writtenJson.runId, 'android-only');
  assert.equal(writtenJson.status, 'passed');
  assert.match(writtenSummary, /Live Proof Set android-only/u);
});

test('accepts failed live-proof artifacts with skipped interaction proofs', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-failed-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged', 'failed');
  proof.skippedInteractionProofs = [
    {
      label: 'interaction-argent',
      nextAction: {
        code: 'fix_profile_gate',
        summary: 'Inspect profile verdict.',
      },
      reason: 'Profile verdict failed.',
      runId: 'app-startup-android-argent',
      runnerId: 'argent',
      scenarioId: 'app-startup',
    },
  ];
  const proofPath = writeProof(tempDir, proof);

  const output = formatLiveProof(readLiveProof(proofPath));
  assert.match(output, /Status: failed/u);
  assert.match(output, /Skipped interaction proofs: 1/u);
  assert.match(output, /interaction-argent \(argent\/app-startup\/app-startup-android-argent\): Profile verdict failed\. next=fix_profile_gate/u);
  assert.match(output, /Next action: inspect_failed_run/u);
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
  assert.match(output, /Preflight: android-live-preflight health=passed verdict=not_evaluated/u);
  assert.match(output, /startup \(app-startup\/android-live-startup\): health=passed verdict=passed/u);
  assert.match(output, /startup-ui \(agent-device\/app-startup\/agent-device-startup\): health=passed verdict=not_evaluated screenshots=1 warnings=1/u);
  assert.match(output, /Comparison counts: better=0 worse=0 unchanged=1 mixed=0 inconclusive=0 skipped=0/u);
  assert.match(output, /startup \(app-startup\/android-live-startup\): unchanged \(metrics better=0 worse=0 unchanged=1 inconclusive=0\)/u);
  assert.match(output, /Next action: inspect_summary/u);
  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), false);
});

test('does not treat mixed comparison movement as a fail-on-regression failure', () => {
  const proof = buildProof('mixed') as ReturnType<typeof readLiveProof>;
  const output = formatLiveProof(proof);

  assert.match(output, /notable: cycle p50 better \(-22ms\), close p50 worse \(6ms\)/u);
  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), false);
});

test('supports a fail-on-regression gate', () => {
  const proof = buildProof('regressed') as ReturnType<typeof readLiveProof>;

  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), true);
  assert.equal(shouldFailOnRegression({ failOnRegression: false, proof }), false);
});

test('fails a live-proof set when any proof artifact failed', () => {
  const passedProof = buildProof('unchanged', 'passed', 'android') as ReturnType<typeof readLiveProof>;
  const failedProof = buildProof('unchanged', 'failed', 'ios') as ReturnType<typeof readLiveProof>;

  assert.equal(shouldFailLiveProofSet({
    failOnRegression: false,
    proofs: [passedProof, failedProof],
  }), true);
});

test('fails a live-proof set when regression gating finds a regressed proof', () => {
  const androidProof = buildProof('unchanged', 'passed', 'android') as ReturnType<typeof readLiveProof>;
  const iosProof = buildProof('regressed', 'passed', 'ios') as ReturnType<typeof readLiveProof>;

  assert.equal(shouldFailLiveProofSet({
    failOnRegression: true,
    proofs: [androidProof, iosProof],
  }), true);
  assert.equal(shouldFailLiveProofSet({
    failOnRegression: false,
    proofs: [androidProof, iosProof],
  }), false);
});
