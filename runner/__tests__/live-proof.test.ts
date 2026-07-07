const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertLiveProofArtifactPointers,
  buildLiveProofSetArtifact,
  collectLiveProofArtifactPointerIssues,
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
  resolveLiveProofArtifactBaseDir,
  resolveLiveProofFiles,
  writeLiveProofSetArtifact,
  shouldFailLiveProofSet,
  shouldFailOnRegression,
  shouldRequireArtifacts,
} = require('../live-proof');

type TestContext = import('node:test').TestContext;
type TestNextActionCode = (
  'establish_baseline' |
  'inspect_failed_run' |
  'inspect_inconclusive' |
  'inspect_low_confidence' |
  'inspect_mixed' |
  'inspect_regressions' |
  'inspect_summary'
);
type TestNextActionOwner = (
  'asl_runner' |
  'product_optimization' |
  'scenario_contract'
);
type TestComparisonPointerStatus = 'low_confidence' | 'mixed' | 'unchanged' | 'worse';
type TestComparisonStatus = 'low_confidence' | 'mixed' | 'regressed' | 'unchanged';

function buildComparisonPointerStatus(
  comparisonStatus: TestComparisonStatus,
): TestComparisonPointerStatus {
  switch (comparisonStatus) {
    case 'regressed':
      return 'worse';
    case 'mixed':
      return 'mixed';
    case 'low_confidence':
      return 'low_confidence';
    case 'unchanged':
      return 'unchanged';
  }
}

function buildComparisonMetricCounts(
  comparisonStatus: TestComparisonStatus,
): Record<'better' | 'inconclusive' | 'low_confidence' | 'unchanged' | 'worse', number> {
  switch (comparisonStatus) {
    case 'mixed':
      return {
        better: 1,
        inconclusive: 0,
        low_confidence: 0,
        unchanged: 0,
        worse: 1,
      };
    case 'regressed':
      return {
        better: 0,
        inconclusive: 0,
        low_confidence: 0,
        unchanged: 0,
        worse: 1,
      };
    case 'low_confidence':
      return {
        better: 0,
        inconclusive: 0,
        low_confidence: 1,
        unchanged: 0,
        worse: 0,
      };
    case 'unchanged':
      return {
        better: 0,
        inconclusive: 0,
        low_confidence: 0,
        unchanged: 1,
        worse: 0,
      };
  }
}

function buildNotableMetrics(comparisonStatus: TestComparisonStatus): Array<Record<string, number | string>> {
  switch (comparisonStatus) {
    case 'mixed':
      return [
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
      ];
    case 'regressed':
      return [
        {
          baseline: 400,
          current: 426,
          delta: 26,
          name: 'cycle p95',
          status: 'worse',
          unit: 'ms',
        },
      ];
    case 'low_confidence':
      return [
        {
          baseline: 960,
          current: 1211,
          delta: 251,
          name: 'cycle p95',
          status: 'low_confidence',
          unit: 'ms',
        },
      ];
    case 'unchanged':
      return [];
  }
}

function buildComparisonCounts(
  comparisonStatus: TestComparisonStatus,
): Record<'better' | 'inconclusive' | 'low_confidence' | 'mixed' | 'skipped' | 'unchanged' | 'worse', number> {
  const counts = {
    better: 0,
    inconclusive: 0,
    low_confidence: 0,
    mixed: 0,
    skipped: 0,
    unchanged: 0,
    worse: 0,
  };

  switch (comparisonStatus) {
    case 'regressed':
      return { ...counts, worse: 1 };
    case 'mixed':
      return { ...counts, mixed: 1 };
    case 'low_confidence':
      return { ...counts, low_confidence: 1 };
    case 'unchanged':
      return { ...counts, unchanged: 1 };
  }
}

function buildProofNextActionCode(
  comparisonStatus: TestComparisonStatus,
  status: 'failed' | 'passed',
): TestNextActionCode {
  if (status === 'failed') {
    return 'inspect_failed_run';
  }

  switch (comparisonStatus) {
    case 'regressed':
      return 'inspect_regressions';
    case 'mixed':
      return 'inspect_mixed';
    case 'low_confidence':
      return 'inspect_low_confidence';
    case 'unchanged':
      return 'inspect_summary';
  }
}

function buildProofNextActionOwner(actionCode: TestNextActionCode): TestNextActionOwner {
  switch (actionCode) {
    case 'inspect_failed_run':
      return 'asl_runner';
    case 'inspect_regressions':
    case 'inspect_mixed':
    case 'inspect_summary':
      return 'product_optimization';
    case 'establish_baseline':
    case 'inspect_inconclusive':
    case 'inspect_low_confidence':
      return 'scenario_contract';
  }
}

/**
 * Builds a minimal valid live-proof artifact for CLI tests.
 *
 * @param {'low_confidence' | 'mixed' | 'regressed' | 'unchanged'} comparisonStatus
 * @param {'failed' | 'passed'} [status]
 * @param {'android' | 'ios'} [platform]
 * @returns {Record<string, unknown>}
 */
function buildProof(
  comparisonStatus: TestComparisonStatus,
  status: 'failed' | 'passed' = 'passed',
  platform: 'android' | 'ios' = 'android',
): Record<string, unknown> {
  const nextActionCode = buildProofNextActionCode(comparisonStatus, status);
  const comparisonPointerStatus = buildComparisonPointerStatus(comparisonStatus);
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
                owner: 'provider_tooling',
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
          counts: buildComparisonMetricCounts(comparisonStatus),
          notableMetrics: buildNotableMetrics(comparisonStatus),
        },
      },
    ],
    comparisonCounts: buildComparisonCounts(comparisonStatus),
    comparisonStatus,
    nextAction: {
      code: nextActionCode,
      owner: buildProofNextActionOwner(nextActionCode),
      summary: 'Inspect linked evidence.',
    },
    summary: `${platform} live proof ${status}/${comparisonStatus}.`,
  };
}

/**
 * Adds native-performance rollup metadata to a live-proof fixture.
 *
 * @param {Record<string, unknown>} proof
 * @param {{claim: string, comparability: string, evidenceCount: number, profileCount: number, sourceId: string, sourceStatus: string, target: string}} options
 * @returns {Record<string, unknown>}
 */
function withNativePerformanceRollup(
  proof: Record<string, unknown>,
  {
    claim,
    comparability,
    evidenceCount,
    profileCount,
    sourceId,
    sourceStatus,
    target,
  }: {
    claim: string;
    comparability: string;
    evidenceCount: number;
    profileCount: number;
    sourceId: string;
    sourceStatus: string;
    target: string;
  },
): Record<string, unknown> {
  return {
    ...proof,
    profileNativePerformance: {
      claimSufficiencyCounts: [
        {
          count: evidenceCount,
          status: claim,
        },
      ],
      comparabilityCounts: [
        {
          count: evidenceCount,
          status: comparability,
        },
      ],
      diagnosticSourceCounts: [
        {
          count: evidenceCount,
          sourceId,
          status: sourceStatus,
        },
      ],
      evidenceCount,
      profileCount,
      targetBindingCounts: [
        {
          count: evidenceCount,
          status: target,
        },
      ],
    },
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

/**
 * Writes the files and directories referenced by a generated live-proof fixture.
 *
 * @param {string} artifactBaseDir
 * @param {Record<string, unknown>} proof
 * @returns {Promise<void>}
 */
async function materializeLiveProofPointers(
  artifactBaseDir: string,
  proof: Record<string, unknown>,
): Promise<void> {
  const writePointerFile = async (filePath: string): Promise<void> => {
    const resolved = path.resolve(artifactBaseDir, filePath);
    await fsp.mkdir(path.dirname(resolved), { recursive: true });
    await fsp.writeFile(resolved, 'summary\n', 'utf8');
  };
  const writePointerDir = async (dirPath: string): Promise<void> => {
    await fsp.mkdir(path.resolve(artifactBaseDir, dirPath), { recursive: true });
  };

  const preflight = proof.preflight as {runDir: string; summaryPath: string};
  await writePointerDir(preflight.runDir);
  await writePointerFile(preflight.summaryPath);

  for (const profile of proof.profiles as Array<{runDir: string; summaryPath: string}>) {
    await writePointerDir(profile.runDir);
    await writePointerFile(profile.summaryPath);
  }

  for (const interactionProof of (proof.interactionProofs ?? []) as Array<Record<string, unknown>>) {
    const runDir = interactionProof.runDir as string;
    await writePointerDir(runDir);
    await writePointerFile(interactionProof.summaryPath as string);
    const captures = interactionProof.captures as {screenshots?: string[]} | undefined;
    for (const screenshot of captures?.screenshots ?? []) {
      await writePointerFile(path.join(runDir, screenshot));
    }
  }

  for (const comparison of proof.comparisons as Array<Record<string, string | null>>) {
    if (comparison.status === 'skipped') {
      continue;
    }
    await writePointerDir(comparison.baselineDir as string);
    await writePointerDir(comparison.comparisonDir as string);
    await writePointerFile(comparison.summaryPath as string);
  }
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
    '--artifact-base-dir',
    'project-root',
    '--require-artifacts',
    '--fail-on-regression',
  ]);

  assert.deepEqual(args, {
    file: ['android-live-proof.json', 'ios-live-proof.json'],
    'fail-on-regression': true,
    'artifact-base-dir': 'project-root',
    out: 'artifacts/asl/live-proof-set',
    'require-artifacts': true,
    'require-platforms': 'android,ios',
    'run-id': 'current-platform-set',
  });
  assert.deepEqual(resolveLiveProofFiles(args), ['android-live-proof.json', 'ios-live-proof.json']);
  assert.deepEqual(parseRequiredPlatforms(args['require-platforms']), ['android', 'ios']);
  assert.equal(shouldRequireArtifacts(args), true);
  assert.equal(resolveLiveProofArtifactBaseDir(args), path.resolve('project-root'));
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
      low_confidence: 0,
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
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'low_confidence' }]), 'low_confidence');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'mixed' }]), 'mixed');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'unchanged' }]), 'improved');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'unchanged' }]), 'unchanged');
  assert.equal(deriveLiveProofComparisonStatus([{ status: 'better' }, { status: 'worse' }]), 'regressed');

  assert.equal(expectedLiveProofNextActionCode('regressed'), 'inspect_regressions');
  assert.equal(expectedLiveProofNextActionCode('regressed', 'failed'), 'inspect_failed_run');
  assert.equal(expectedLiveProofNextActionCode('baseline_missing'), 'establish_baseline');
  assert.equal(expectedLiveProofNextActionCode('inconclusive'), 'inspect_inconclusive');
  assert.equal(expectedLiveProofNextActionCode('low_confidence'), 'inspect_low_confidence');
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

test('rejects live-proof artifacts with inconsistent next action owner when present', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-action-owner-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  (proof.nextAction as Record<string, string>).owner = 'provider_tooling';
  const proofPath = writeProof(tempDir, proof);

  assert.throws(
    () => readLiveProof(proofPath),
    /nextAction\.owner expected product_optimization for inspect_summary but found provider_tooling/u,
  );
});

test('keeps legacy live-proof artifacts valid when next action owner is absent', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-legacy-action-owner-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  delete (proof.nextAction as Record<string, string>).owner;
  const proofPath = writeProof(tempDir, proof);

  assert.equal(readLiveProof(proofPath).nextAction.owner, undefined);
});

test('validates local live-proof artifact pointers when requested', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-pointers-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  await materializeLiveProofPointers(tempDir, proof);
  const proofPath = writeProof(tempDir, proof);

  const issues = collectLiveProofArtifactPointerIssues(proof, {
    artifactBaseDir: tempDir,
  });
  const readProof = readLiveProof(proofPath, {
    artifactBaseDir: tempDir,
    requireArtifacts: true,
  });

  assert.deepEqual(issues, []);
  assert.equal(readProof.runId, 'android-live-proof');
});

test('rejects missing local live-proof artifact pointers when requested', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-missing-pointers-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  await materializeLiveProofPointers(tempDir, proof);
  const preflight = proof.preflight as Record<string, string>;
  await fsp.rm(path.resolve(tempDir, preflight.summaryPath));
  const proofPath = writeProof(tempDir, proof);

  assert.throws(
    () => assertLiveProofArtifactPointers(proof as ReturnType<typeof readLiveProof>, {
      artifactBaseDir: tempDir,
    }),
    /preflight android-live-preflight summaryPath.+path does not exist/u,
  );
  assert.throws(
    () => readLiveProof(proofPath, {
      artifactBaseDir: tempDir,
      requireArtifacts: true,
    }),
    /Live proof artifact pointers missing/u,
  );
});

test('does not require skipped comparison artifact pointers', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-skipped-pointers-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const proof = buildProof('unchanged');
  proof.comparisons = [
    {
      label: 'startup',
      scenarioId: 'app-startup',
      runId: 'android-live-startup',
      status: 'skipped',
      baselineDir: null,
      comparisonDir: null,
      summaryPath: null,
      reason: 'No trusted baseline.',
    },
  ];
  proof.comparisonCounts = {
    better: 0,
    inconclusive: 0,
    low_confidence: 0,
    mixed: 0,
    skipped: 1,
    unchanged: 0,
    worse: 0,
  };
  proof.comparisonStatus = 'baseline_missing';
  (proof.nextAction as Record<string, string>).code = 'establish_baseline';
  (proof.nextAction as Record<string, string>).owner = 'scenario_contract';
  await materializeLiveProofPointers(tempDir, proof);
  const proofPath = writeProof(tempDir, proof);

  const readProof = readLiveProof(proofPath, {
    artifactBaseDir: tempDir,
    requireArtifacts: true,
  });

  assert.equal(readProof.comparisonStatus, 'baseline_missing');
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
  const androidProofPath = writeProof(tempDir, withNativePerformanceRollup(
    buildProof('unchanged', 'passed', 'android'),
    {
      claim: 'insufficient-for-claim',
      comparability: 'diagnostic-only',
      evidenceCount: 1,
      profileCount: 1,
      sourceId: 'gfxinfo',
      sourceStatus: 'partial',
      target: 'verified',
    },
  ));
  const iosProofPath = path.join(tempDir, 'ios-live-proof.json');
  const iosProof = withNativePerformanceRollup(
    buildProof('unchanged', 'passed', 'ios'),
    {
      claim: 'sufficient-for-comparison',
      comparability: 'comparable',
      evidenceCount: 2,
      profileCount: 1,
      sourceId: 'xctrace',
      sourceStatus: 'captured',
      target: 'verified',
    },
  );
  fs.writeFileSync(iosProofPath, `${JSON.stringify(iosProof, null, 2)}\n`, 'utf8');
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
  assert.deepEqual(artifact.nextAction, {
    code: 'inspect_summary',
    owner: 'product_optimization',
    summary: 'Platform proof set is complete; inspect linked artifacts for detail.',
  });
  assert.equal(artifact.proofCount, 2);
  assert.deepEqual(artifact.presentPlatforms, ['android', 'ios']);
  assert.deepEqual(artifact.missingPlatforms, []);
  assert.deepEqual(artifact.failureReasons, []);
  assert.deepEqual(artifact.profileNativePerformance, {
    claimSufficiencyCounts: [
      {
        count: 1,
        status: 'insufficient-for-claim',
      },
      {
        count: 2,
        status: 'sufficient-for-comparison',
      },
    ],
    comparabilityCounts: [
      {
        count: 2,
        status: 'comparable',
      },
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
        count: 2,
        sourceId: 'xctrace',
        status: 'captured',
      },
    ],
    evidenceCount: 3,
    profileCount: 2,
    targetBindingCounts: [
      {
        count: 3,
        status: 'verified',
      },
    ],
  });
  assert.equal(artifact.proofs[0].interactionWarningCount, 1);
  assert.deepEqual(artifact.proofs[0].interactionWarnings, [
    {
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
      label: 'startup-ui',
      runId: 'agent-device-startup',
      runnerId: 'agent-device',
      scenarioId: 'app-startup',
    },
  ]);
  assert.deepEqual(artifact.interactionWarningNextActions, {
    interactionWarningCount: 2,
    nextActionCounts: [
      {
        code: 'inspect_argent_driver_action',
        count: 2,
        owner: 'provider_tooling',
      },
    ],
    proofCount: 2,
  });
  assert.match(markdown, /Status: passed/u);
  assert.match(markdown, /- android android-live-proof: status=passed comparison=unchanged/u);
  assert.match(markdown, /warning android\/startup-ui \(agent-device\/app-startup\/agent-device-startup\): argent_screenshot argent_screenshot_failed - Argent driver action screenshot failed\. Next action: provider_tooling\/inspect_argent_driver_action - Inspect raw screenshot output\./u);
  assert.match(markdown, /Interaction warning next actions: proofs=2; warnings=2; actions=provider_tooling\/inspect_argent_driver_action=2/u);
  assert.match(markdown, /- ios ios-live-proof: status=passed comparison=unchanged/u);
  assert.match(markdown, /Native performance: profiles=2; evidence=3; sources=gfxinfo:partial=1, xctrace:captured=2; claim=insufficient-for-claim=1, sufficient-for-comparison=2; comparability=comparable=2, diagnostic-only=1; target=verified=3/u);
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
  const markdown = formatLiveProofSetArtifactMarkdown(artifact);
  const written = await writeLiveProofSetArtifact({
    artifact,
    outputDir: path.join(tempDir, 'proof-set'),
  });
  const writtenJson = JSON.parse(fs.readFileSync(written.liveProofSetPath, 'utf8'));

  assert.equal(artifact.status, 'failed');
  assert.deepEqual(artifact.missingPlatforms, ['ios']);
  assert.deepEqual(artifact.failureReasons, ['Missing required platform proof: ios.']);
  assert.deepEqual(artifact.missingPlatformNextActions, {
    missingPlatformCount: 1,
    nextActionCounts: [
      {
        code: 'collect_missing_platform_proofs',
        count: 1,
        owner: 'runtime_environment',
      },
    ],
  });
  assert.deepEqual(writtenJson.missingPlatformNextActions, artifact.missingPlatformNextActions);
  assert.deepEqual(artifact.nextAction, {
    code: 'collect_missing_platform_proofs',
    owner: 'runtime_environment',
    summary: 'Run the missing platform proof(s): ios.',
  });
  assert.match(markdown, /Missing platform next actions: missingPlatforms=1; actions=runtime_environment\/collect_missing_platform_proofs=1/u);
});

test('builds proof-set skipped interaction proof context from linked proofs', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-skipped-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const androidProof = buildProof('unchanged', 'failed', 'android');
  androidProof.skippedInteractionProofs = [
    {
      label: 'startup-agent-device',
      nextAction: {
        code: 'fix_provider_outputs',
        owner: 'provider_tooling',
        summary: 'Restore required provider outputs and rerun profile proof.',
      },
      profileGateDiagnostics: {
        blockingDiagnosticSufficiency: [
          {
            kind: 'profiler',
            status: 'provider-blocked',
          },
        ],
        capturedDiagnosticSufficiency: [
          {
            kind: 'nativePerformance',
            status: 'diagnostic-only',
          },
        ],
        nativePerformance: {
          claimSufficiency: 'insufficient-for-claim',
          comparability: 'diagnostic-only',
          diagnosticSources: [
            {
              sourceId: 'gfxinfo',
              status: 'partial',
            },
          ],
          targetBinding: 'verified',
        },
        requestedDiagnosticInventory: [
          {
            availability: 'provider-blocked',
            kind: 'profiler',
            provider: 'profiler-provider',
            required: true,
            status: 'failed',
            sufficiencyStatus: 'provider-blocked',
          },
        ],
      },
      reason: 'Profile provider evidence was partial.',
      runId: 'android-startup-agent-device',
      runnerId: 'agent-device',
      scenarioId: 'app-startup',
    },
  ];
  const androidProofPath = writeProof(tempDir, androidProof);
  const iosProof = buildProof('unchanged', 'failed', 'ios');
  iosProof.skippedInteractionProofs = [
    {
      label: 'startup-ui',
      nextAction: {
        code: 'restart_ios_dev_client',
        owner: 'runtime_environment',
        summary: 'Restart the iOS dev client and rerun profile proof.',
      },
      profileGateDiagnostics: {
        blockingDiagnosticSufficiency: [
          {
            kind: 'accessibility',
            status: 'provider-blocked',
          },
        ],
        capturedDiagnosticSufficiency: [
          {
            kind: 'nativePerformance',
            status: 'diagnostic-only',
          },
        ],
        nativePerformance: {
          claimSufficiency: 'insufficient-for-claim',
          comparability: 'diagnostic-only',
          diagnosticSources: [
            {
              sourceId: 'xctrace',
              status: 'partial',
            },
          ],
          targetBinding: 'ambiguous',
        },
        requestedDiagnosticInventory: [
          {
            availability: 'provider-blocked',
            kind: 'accessibility',
            provider: 'axe',
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
      },
      profileGateReadiness: {
        commandCount: 1,
        devClientDeepLinkOpened: true,
        expectedEvidence: 'profile_session_started',
        failureClass: 'dev_client_bundle_or_command_channel_not_ready',
        foregroundAppInfoCaptured: true,
        foregroundApplicationState: 'foreground',
        foregroundRawPath: 'raw/ios-foreground-app.json',
        foregroundTargetOwned: false,
        lastDeepLinkLabel: 'startup',
        pendingPhase: 'session-start',
        profileSessionSeedRawPath: 'raw/profile-session-seed.json',
        profileSessionSeeded: true,
        readinessRawPath: 'raw/ios-profile-session-readiness.json',
      },
      reason: 'Profile health failed before sidecar proof.',
      runId: 'ios-startup-agent-device',
      runnerId: 'agent-device',
      scenarioId: 'app-startup',
    },
  ];
  const iosProofPath = path.join(tempDir, 'ios-live-proof.json');
  fs.writeFileSync(iosProofPath, `${JSON.stringify(iosProof, null, 2)}\n`, 'utf8');
  const proofs = [readLiveProof(androidProofPath), readLiveProof(iosProofPath)];

  const artifact = buildLiveProofSetArtifact({
    failOnRegression: false,
    files: [androidProofPath, iosProofPath],
    proofs,
    requiredPlatforms: ['android', 'ios'],
    runId: 'skipped-ios-proof',
  });
  const markdown = formatLiveProofSetArtifactMarkdown(artifact);
  const written = await writeLiveProofSetArtifact({
    artifact,
    outputDir: path.join(tempDir, 'proof-set'),
  });
  const writtenJson = JSON.parse(fs.readFileSync(written.liveProofSetPath, 'utf8'));

  assert.equal(artifact.status, 'failed');
  assert.equal(artifact.skippedInteractionProofCount, 2);
  assert.deepEqual(artifact.profileGateDiagnosticSufficiency, {
    blockingDiagnosticSufficiencyCounts: [
      {
        count: 1,
        kind: 'accessibility',
        status: 'provider-blocked',
      },
      {
        count: 1,
        kind: 'profiler',
        status: 'provider-blocked',
      },
    ],
    capturedDiagnosticSufficiencyCounts: [
      {
        count: 2,
        kind: 'nativePerformance',
        status: 'diagnostic-only',
      },
    ],
    skippedInteractionProofCount: 2,
  });
  assert.deepEqual(artifact.proofFailureDiagnosticSufficiency, {
    blockingDiagnosticSufficiencyCounts: [
      {
        count: 1,
        kind: 'accessibility',
        status: 'provider-blocked',
      },
      {
        count: 1,
        kind: 'profiler',
        status: 'provider-blocked',
      },
    ],
    capturedDiagnosticSufficiencyCounts: [
      {
        count: 2,
        kind: 'nativePerformance',
        status: 'diagnostic-only',
      },
    ],
    failedProofCount: 2,
    skippedInteractionProofCount: 2,
  });
  assert.deepEqual(artifact.proofFailureRequestedDiagnostics, {
    failedProofCount: 2,
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
        availability: 'provider-blocked',
        count: 1,
        kind: 'profiler',
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
    skippedInteractionProofCount: 2,
  });
  assert.deepEqual(artifact.profileGateNativePerformance, {
    claimSufficiencyCounts: [
      {
        count: 2,
        status: 'insufficient-for-claim',
      },
    ],
    comparabilityCounts: [
      {
        count: 2,
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
        sourceId: 'xctrace',
        status: 'partial',
      },
    ],
    skippedInteractionProofCount: 2,
    targetBindingCounts: [
      {
        count: 1,
        status: 'ambiguous',
      },
      {
        count: 1,
        status: 'verified',
      },
    ],
  });
  assert.deepEqual(artifact.proofFailureNativePerformance, {
    claimSufficiencyCounts: [
      {
        count: 2,
        status: 'insufficient-for-claim',
      },
    ],
    comparabilityCounts: [
      {
        count: 2,
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
        sourceId: 'xctrace',
        status: 'partial',
      },
    ],
    failedProofCount: 2,
    skippedInteractionProofCount: 2,
    targetBindingCounts: [
      {
        count: 1,
        status: 'ambiguous',
      },
      {
        count: 1,
        status: 'verified',
      },
    ],
  });
  assert.deepEqual(artifact.profileGateReadiness, {
    commandCountTotal: 1,
    devClientDeepLinkOpenedCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    expectedEvidenceCounts: [
      {
        count: 1,
        value: 'profile_session_started',
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
        value: 'foreground',
      },
    ],
    foregroundTargetOwnedCounts: [
      {
        count: 1,
        value: false,
      },
    ],
    pendingPhaseCounts: [
      {
        count: 1,
        value: 'session-start',
      },
    ],
    readinessDetailCounts: [
      {
        count: 1,
        value: 'dev-client-deep-link-opened',
      },
      {
        count: 1,
        value: 'profile-session-command-present',
      },
      {
        count: 1,
        value: 'profile-session-storage-seeded',
      },
      {
        count: 1,
        value: 'target-foreground-not-owned',
      },
    ],
    profileSessionSeededCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    readinessProofCount: 1,
    skippedInteractionProofCount: 2,
  });
  assert.deepEqual(writtenJson.proofFailureDiagnosticSufficiency, artifact.proofFailureDiagnosticSufficiency);
  assert.deepEqual(writtenJson.proofFailureRequestedDiagnostics, artifact.proofFailureRequestedDiagnostics);
  assert.deepEqual(writtenJson.proofFailureNativePerformance, artifact.proofFailureNativePerformance);
  assert.deepEqual(artifact.proofFailureReadiness, {
    commandCountTotal: 1,
    devClientDeepLinkOpenedCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    expectedEvidenceCounts: [
      {
        count: 1,
        value: 'profile_session_started',
      },
    ],
    failedProofCount: 1,
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
        value: 'foreground',
      },
    ],
    foregroundTargetOwnedCounts: [
      {
        count: 1,
        value: false,
      },
    ],
    pendingPhaseCounts: [
      {
        count: 1,
        value: 'session-start',
      },
    ],
    readinessDetailCounts: [
      {
        count: 1,
        value: 'dev-client-deep-link-opened',
      },
      {
        count: 1,
        value: 'profile-session-command-present',
      },
      {
        count: 1,
        value: 'profile-session-storage-seeded',
      },
      {
        count: 1,
        value: 'target-foreground-not-owned',
      },
    ],
    profileSessionSeededCounts: [
      {
        count: 1,
        value: true,
      },
    ],
    readinessProofCount: 1,
    skippedInteractionProofCount: 1,
  });
  assert.deepEqual(writtenJson.proofFailureReadiness, artifact.proofFailureReadiness);
  assert.deepEqual(artifact.skippedInteractionProofNextActions, {
    nextActionCounts: [
      {
        code: 'fix_provider_outputs',
        count: 1,
        owner: 'provider_tooling',
      },
      {
        code: 'restart_ios_dev_client',
        count: 1,
        owner: 'runtime_environment',
      },
    ],
    skippedInteractionProofCount: 2,
  });
  assert.equal(artifact.skippedInteractionProofs?.[0].platform, 'android');
  assert.equal(artifact.skippedInteractionProofs?.[1].platform, 'ios');
  assert.equal(artifact.skippedInteractionProofs?.[1].proofRunId, 'ios-live-proof');
  assert.equal(artifact.skippedInteractionProofs?.[1].proofFilePath, path.resolve(iosProofPath));
  assert.deepEqual(artifact.skippedInteractionProofs?.[1].profileGateReadiness, {
    commandCount: 1,
    devClientDeepLinkOpened: true,
    expectedEvidence: 'profile_session_started',
    failureClass: 'dev_client_bundle_or_command_channel_not_ready',
    foregroundAppInfoCaptured: true,
    foregroundApplicationState: 'foreground',
    foregroundRawPath: 'raw/ios-foreground-app.json',
    foregroundTargetOwned: false,
    lastDeepLinkLabel: 'startup',
    pendingPhase: 'session-start',
    profileSessionSeedRawPath: 'raw/profile-session-seed.json',
    profileSessionSeeded: true,
    readinessRawPath: 'raw/ios-profile-session-readiness.json',
  });
  assert.match(markdown, /Skipped interaction proofs: 2/u);
  assert.match(markdown, /skipped ios\/startup-ui \(agent-device\/app-startup\/ios-startup-agent-device\) from ios-live-proof: Profile health failed before sidecar proof\./u);
  assert.match(markdown, /Diagnostics: captured=nativePerformance:diagnostic-only; blocking=accessibility:provider-blocked; nativePerformance\(claim=insufficient-for-claim, comparability=diagnostic-only, target=ambiguous, sources=xctrace:partial\)\./u);
  assert.match(markdown, /Readiness: failure=dev_client_bundle_or_command_channel_not_ready, commands=1, devClientDeepLinkOpened=true, foregroundAppInfoCaptured=true, foregroundApplicationState=foreground, foregroundTargetOwned=false, lastDeepLink=startup, profileSessionSeeded=true, phase=session-start, expected=profile_session_started, foregroundRawPath=raw\/ios-foreground-app\.json, profileSessionSeedRawPath=raw\/profile-session-seed\.json, readinessRawPath=raw\/ios-profile-session-readiness\.json\./u);
  assert.match(markdown, /Next action: runtime_environment\/restart_ios_dev_client - Restart the iOS dev client and rerun profile proof\./u);
  assert.match(markdown, /Skipped interaction proof next actions: skippedInteractionProofs=2; actions=provider_tooling\/fix_provider_outputs=1, runtime_environment\/restart_ios_dev_client=1/u);
  assert.match(markdown, /Proof failure diagnostics: failedProofs=2; skippedInteractionProofs=2; captured=nativePerformance:diagnostic-only=2; blocking=accessibility:provider-blocked=1, profiler:provider-blocked=1/u);
  assert.match(markdown, /Proof failure requested diagnostics: failedProofs=2; skippedInteractionProofs=2; requested=accessibility:provider-blocked\(required\)=1, profiler:provider-blocked\(required\)=1, video:requested-missing\(optional\)=1/u);
  assert.match(markdown, /Proof failure native performance: failedProofs=2; skippedInteractionProofs=2; sources=gfxinfo:partial=1, xctrace:partial=1; claim=insufficient-for-claim=2; comparability=diagnostic-only=2; target=ambiguous=1, verified=1/u);
  assert.match(markdown, /Proof failure readiness: failedProofs=1; skippedInteractionProofs=1; readinessProofs=1; commands=1; failure=dev_client_bundle_or_command_channel_not_ready=1; devClientDeepLinkOpened=true=1; foregroundAppInfoCaptured=true=1; foregroundApplicationState=foreground=1; foregroundTargetOwned=false=1; profileSessionSeeded=true=1; phase=session-start=1; detail=dev-client-deep-link-opened=1, profile-session-command-present=1, profile-session-storage-seeded=1, target-foreground-not-owned=1; expected=profile_session_started=1/u);
  assert.match(markdown, /Profile gate diagnostics: skippedInteractionProofs=2; captured=nativePerformance:diagnostic-only=2; blocking=accessibility:provider-blocked=1, profiler:provider-blocked=1/u);
  assert.match(markdown, /Profile gate native performance: skippedInteractionProofs=2; sources=gfxinfo:partial=1, xctrace:partial=1; claim=insufficient-for-claim=2; comparability=diagnostic-only=2; target=ambiguous=1, verified=1/u);
  assert.match(markdown, /Profile gate readiness: skippedInteractionProofs=2; readinessProofs=1; commands=1; failure=dev_client_bundle_or_command_channel_not_ready=1; devClientDeepLinkOpened=true=1; foregroundAppInfoCaptured=true=1; foregroundApplicationState=foreground=1; foregroundTargetOwned=false=1; profileSessionSeeded=true=1; phase=session-start=1; detail=dev-client-deep-link-opened=1, profile-session-command-present=1, profile-session-storage-seeded=1, target-foreground-not-owned=1; expected=profile_session_started=1/u);
});

test('builds no-command readiness details from failed proof sets', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-readiness-detail-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const iosProof = buildProof('unchanged', 'failed', 'ios');
  iosProof.skippedInteractionProofs = [
    {
      label: 'startup-ui',
      nextAction: {
        code: 'restart_ios_dev_client',
        owner: 'runtime_environment',
        summary: 'Restart the iOS dev client and rerun profile proof.',
      },
      profileGateReadiness: {
        commandCount: 0,
        devClientDeepLinkOpened: true,
        expectedEvidence: 'profile-session-start-or-profile-events',
        failureClass: 'dev_client_bundle_or_command_channel_not_ready',
        foregroundTargetOwned: false,
        pendingPhase: 'waiting_for_profile_session_start',
        profileSessionSeeded: true,
      },
      reason: 'Profile health failed before sidecar proof.',
      runId: 'ios-startup-agent-device',
      runnerId: 'agent-device',
      scenarioId: 'app-startup',
    },
  ];
  const iosProofPath = writeProof(tempDir, iosProof);
  const artifact = buildLiveProofSetArtifact({
    failOnRegression: false,
    files: [iosProofPath],
    proofs: [readLiveProof(iosProofPath)],
    requiredPlatforms: ['ios'],
    runId: 'ios-readiness-detail',
  });
  const markdown = formatLiveProofSetArtifactMarkdown(artifact);

  assert.deepEqual(artifact.proofFailureReadiness?.readinessDetailCounts, [
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
      value: 'target-foreground-not-owned',
    },
  ]);
  assert.match(markdown, /Proof failure readiness: failedProofs=1; skippedInteractionProofs=1; readinessProofs=1; commands=0; failure=dev_client_bundle_or_command_channel_not_ready=1; devClientDeepLinkOpened=true=1; foregroundTargetOwned=false=1; profileSessionSeeded=true=1; phase=waiting_for_profile_session_start=1; detail=dev-client-deep-link-opened=1, no-profile-session-command=1, profile-session-storage-seeded=1, target-foreground-not-owned=1; expected=profile-session-start-or-profile-events=1/u);
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
  assert.equal(writtenJson.proofs[0].interactionWarnings[0].checks[0].code, 'argent_screenshot_failed');
  assert.match(writtenSummary, /Live Proof Set android-only/u);
  assert.match(writtenSummary, /warning android\/startup-ui/u);
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
        owner: 'asl_runner',
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
  assert.match(output, /interaction-argent \(argent\/app-startup\/app-startup-android-argent\): Profile verdict failed\. next=asl_runner\/fix_profile_gate/u);
  assert.match(output, /Next action: asl_runner\/inspect_failed_run/u);
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
  assert.match(output, /warning argent_screenshot: argent_screenshot_failed - Argent driver action screenshot failed\. next=provider_tooling\/inspect_argent_driver_action - Inspect raw screenshot output\./u);
  assert.match(output, /Comparison counts: better=0 worse=0 unchanged=1 mixed=0 inconclusive=0 low_confidence=0 skipped=0/u);
  assert.match(output, /startup \(app-startup\/android-live-startup\): unchanged \(metrics better=0 worse=0 unchanged=1 inconclusive=0 low_confidence=0\)/u);
  assert.match(output, /Next action: product_optimization\/inspect_summary/u);
  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), false);
});

test('does not treat mixed comparison movement as a fail-on-regression failure', () => {
  const proof = buildProof('mixed') as ReturnType<typeof readLiveProof>;
  const output = formatLiveProof(proof);

  assert.match(output, /notable: cycle p50 better \(-22ms\), close p50 worse \(6ms\)/u);
  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), false);
});

test('does not treat low-confidence timing movement as a fail-on-regression failure', () => {
  const proof = buildProof('low_confidence') as ReturnType<typeof readLiveProof>;
  const output = formatLiveProof(proof);

  assert.match(output, /Comparison status: low_confidence/u);
  assert.match(output, /cycle p95 low_confidence \(251ms\)/u);
  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), false);
});

test('supports a fail-on-regression gate', () => {
  const proof = buildProof('regressed') as ReturnType<typeof readLiveProof>;

  assert.equal(shouldFailOnRegression({ failOnRegression: true, proof }), true);
  assert.equal(shouldFailOnRegression({ failOnRegression: false, proof }), false);
});

test('fails a live-proof set when any proof artifact failed', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-proof-set-failed-next-actions-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const passedProof = buildProof('unchanged', 'passed', 'android') as ReturnType<typeof readLiveProof>;
  const failedProof = buildProof('unchanged', 'failed', 'ios') as ReturnType<typeof readLiveProof>;
  const artifact = buildLiveProofSetArtifact({
    failOnRegression: false,
    files: [
      path.join(tempDir, 'android-live-proof.json'),
      path.join(tempDir, 'ios-live-proof.json'),
    ],
    proofs: [passedProof, failedProof],
    requiredPlatforms: ['android', 'ios'],
    runId: 'failed-proof-next-actions',
  });
  const markdown = formatLiveProofSetArtifactMarkdown(artifact);

  assert.equal(shouldFailLiveProofSet({
    failOnRegression: false,
    proofs: [passedProof, failedProof],
  }), true);
  assert.deepEqual(artifact.proofFailureNextActions, {
    failedProofCount: 1,
    nextActionCounts: [
      {
        code: 'inspect_failed_run',
        count: 1,
        owner: 'asl_runner',
      },
    ],
    proofCount: 1,
    regressedProofCount: 0,
  });
  assert.match(markdown, /Proof failure next actions: proofs=1; failed=1; regressed=0; actions=asl_runner\/inspect_failed_run=1/u);
  await writeLiveProofSetArtifact({
    artifact,
    outputDir: path.join(tempDir, 'proof-set'),
  });
});

test('fails a live-proof set when regression gating finds a regressed proof', () => {
  const androidProof = buildProof('unchanged', 'passed', 'android') as ReturnType<typeof readLiveProof>;
  const iosProof = buildProof('regressed', 'passed', 'ios') as ReturnType<typeof readLiveProof>;
  const gatedArtifact = buildLiveProofSetArtifact({
    failOnRegression: true,
    files: ['android-live-proof.json', 'ios-live-proof.json'],
    proofs: [androidProof, iosProof],
    requiredPlatforms: ['android', 'ios'],
    runId: 'regressed-proof-next-actions',
  });
  const ungatedArtifact = buildLiveProofSetArtifact({
    failOnRegression: false,
    files: ['android-live-proof.json', 'ios-live-proof.json'],
    proofs: [androidProof, iosProof],
    requiredPlatforms: ['android', 'ios'],
    runId: 'ungated-regressed-proof-next-actions',
  });
  const markdown = formatLiveProofSetArtifactMarkdown(gatedArtifact);

  assert.equal(shouldFailLiveProofSet({
    failOnRegression: true,
    proofs: [androidProof, iosProof],
  }), true);
  assert.equal(shouldFailLiveProofSet({
    failOnRegression: false,
    proofs: [androidProof, iosProof],
  }), false);
  assert.deepEqual(gatedArtifact.proofFailureNextActions, {
    failedProofCount: 0,
    nextActionCounts: [
      {
        code: 'inspect_regressions',
        count: 1,
        owner: 'product_optimization',
      },
    ],
    proofCount: 1,
    regressedProofCount: 1,
  });
  assert.equal(ungatedArtifact.proofFailureNextActions, undefined);
  assert.match(markdown, /Proof failure next actions: proofs=1; failed=0; regressed=1; actions=product_optimization\/inspect_regressions=1/u);
});
