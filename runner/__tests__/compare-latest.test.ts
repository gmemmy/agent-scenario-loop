const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareLatestTrustedRun } = require('../compare-latest');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const COMPARE_LATEST = path.join(DIST_ROOT, 'runner', 'compare-latest.js');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;

/**
 * Runs a child process and returns captured output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileAsync(command: string, args: string[], options: Record<string, unknown> = {}): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: ROOT, ...options }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        const execError = error as ExecFailure;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Writes a minimal indexed run directory with deterministic sort metadata.
 *
 * @param {{root: string, runId: string, actual: number, endedAt: string, acceptedBaselineScenarioHashes?: string[], cohortHash?: string, comparisonLane?: string, healthStatus?: string, scenarioHash?: string, verdictStatus?: string}} options
 * @returns {Promise<string>}
 */
async function writeRun({
  acceptedBaselineScenarioHashes,
  cohortHash,
  comparisonLane,
  root,
  runId,
  actual,
  endedAt,
  healthStatus = 'passed',
  verdictStatus = actual <= 1000 ? 'passed' : 'failed',
  scenarioHash,
}: {
  acceptedBaselineScenarioHashes?: string[];
  root: string;
  runId: string;
  actual: number;
  endedAt: string;
  cohortHash?: string;
  comparisonLane?: string;
  healthStatus?: string;
  scenarioHash?: string;
  verdictStatus?: string;
}): Promise<string> {
  const runDir = path.join(root, 'open-close-cycle', runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runId,
      scenario: 'open-close-cycle',
      ...(scenarioHash ? { scenarioHash } : {}),
      ...(acceptedBaselineScenarioHashes ? { acceptedBaselineScenarioHashes } : {}),
      platform: 'android',
      interactionDriver: 'adb-logcat',
      ...(comparisonLane ? { comparisonLane } : {}),
      ...(cohortHash
        ? {
            provenance: {
              cohortHash,
            },
          }
        : {}),
      startedAt: '2026-06-16T10:00:00.000Z',
      endedAt,
      durationMs: 1000,
      artifacts: { raw: {} },
    })}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(runDir, 'health.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'open-close-cycle',
      flowId: 'open-close-cycle',
      runId,
      healthStatus,
      checks: [{ name: 'truth_events_complete', status: healthStatus, source: 'truth' }],
    })}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(runDir, 'verdict.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'open-close-cycle',
      flowId: 'open-close-cycle',
      runId,
      healthStatus,
      verdictStatus,
      budgetChecks: [
        {
          name: 'open p95',
          source: 'milestone',
          metric: 'p95',
          unit: 'ms',
          expected: 1000,
          actual,
          pass: actual <= 1000,
        },
      ],
    })}\n`,
    'utf8',
  );
  return runDir;
}

test('compares current run against latest trusted prior run', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'older-trusted-run',
    actual: 990,
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  await writeRun({
    root: rootDir,
    runId: 'newer-untrusted-run',
    actual: 1200,
    endedAt: '2026-06-16T10:05:00.000Z',
    verdictStatus: 'failed',
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
  });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE_LATEST,
    '--root',
    rootDir,
    '--scenario',
    'open-close-cycle',
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.baselineRunId, 'older-trusted-run');
  assert.equal(comparison.runId, 'current-run');
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.metricComparisons[0].delta, -190);
  assert.deepEqual(comparison.measurementPolicy, {
    baselineSelection: {
      mode: 'latestTrustedPrior',
      poisoningProtection: {
        requireMatchingScenarioId: true,
        requirePassedHealth: true,
        requirePassedVerdict: true,
        scenarioCompatibility: {
          status: 'legacy-compatible',
          reason: 'current_scenario_hash_missing',
        },
      },
    },
    confidence: {
      level: 'low_confidence',
      minValidSamples: 1,
      reason: 'Single-run timing movement stayed within passing budgets; repeat or multi-sample proof is required before treating it as an optimization or regression.',
    },
    samples: {
      baseline: {
        outliersExcluded: 0,
        validSamples: 1,
        warmupSamples: 0,
      },
      current: {
        outliersExcluded: 0,
        validSamples: 1,
        warmupSamples: 0,
      },
    },
    tolerance: {
      timing: {
        absoluteMs: 16,
        relative: 0.05,
      },
    },
  });
  assert.deepEqual(comparison.comparisonBasis, {
    strategy: 'latest_trusted_prior',
    scenarioContract: {
      status: 'legacy-compatible',
      reason: 'current_scenario_hash_missing',
    },
    baseline: {
      runId: 'older-trusted-run',
      runDir: path.join(rootDir, 'open-close-cycle', 'older-trusted-run'),
      healthStatus: 'passed',
      verdictStatus: 'passed',
    },
    current: {
      runId: 'current-run',
      runDir: currentDir,
      healthStatus: 'passed',
      verdictStatus: 'passed',
    },
    selection: {
      artifactRoot: rootDir,
      candidatesInspected: 3,
      scenarioId: 'open-close-cycle',
      selectedRunDir: path.join(rootDir, 'open-close-cycle', 'older-trusted-run'),
      selectedRunId: 'older-trusted-run',
      skippedCurrentRun: true,
      scenarioCompatibility: 'legacy-compatible',
      trustedCandidates: 2,
      trustedComparableCandidates: 1,
      trustedPriorCandidates: 1,
    },
  });
});

test('keeps unlabeled current runs out of labeled comparison lanes', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-unlabeled-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'older-unlabeled-run',
    actual: 990,
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  await writeRun({
    root: rootDir,
    runId: 'newer-labeled-run',
    actual: 120,
    endedAt: '2026-06-16T10:05:00.000Z',
    comparisonLane: 'example-android-live',
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-unlabeled-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
  });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE_LATEST,
    '--root',
    rootDir,
    '--scenario',
    'open-close-cycle',
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.baselineRunId, 'older-unlabeled-run');
  assert.equal(comparison.runId, 'current-unlabeled-run');
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.comparisonBasis.selection.trustedPriorCandidates, 2);
  assert.equal(comparison.comparisonBasis.selection.trustedComparableCandidates, 1);
  assert.equal(comparison.comparisonBasis.selection.comparisonLane, undefined);
});

test('filters latest trusted prior runs by current comparison lane', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-lane-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'older-agent-device-run',
    actual: 900,
    endedAt: '2026-06-16T10:00:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
  });
  await writeRun({
    root: rootDir,
    runId: 'newer-plain-run',
    actual: 120,
    endedAt: '2026-06-16T10:05:00.000Z',
    comparisonLane: 'example-android-live',
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-agent-device-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
  });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE_LATEST,
    '--root',
    rootDir,
    '--scenario',
    'open-close-cycle',
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.baselineRunId, 'older-agent-device-run');
  assert.equal(comparison.runId, 'current-agent-device-run');
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.comparisonBasis.selection.comparisonLane, 'example-android-live+agent-device');
  assert.equal(comparison.comparisonBasis.selection.trustedPriorCandidates, 2);
  assert.equal(comparison.comparisonBasis.selection.trustedComparableCandidates, 1);
});

test('filters latest trusted prior runs by scenario contract hash when current is hash-aware', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-scenario-hash-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'newer-stale-contract-run',
    actual: 10,
    endedAt: '2026-06-16T10:05:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
    scenarioHash: 'b'.repeat(64),
  });
  await writeRun({
    root: rootDir,
    runId: 'older-same-contract-run',
    actual: 900,
    endedAt: '2026-06-16T10:00:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
    scenarioHash: 'a'.repeat(64),
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-same-contract-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
    scenarioHash: 'a'.repeat(64),
  });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE_LATEST,
    '--root',
    rootDir,
    '--scenario',
    'open-close-cycle',
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.baselineRunId, 'older-same-contract-run');
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.comparisonBasis.selection.comparisonLane, 'example-android-live+agent-device');
  assert.equal(comparison.comparisonBasis.selection.scenarioHash, 'a'.repeat(64));
  assert.equal(comparison.comparisonBasis.selection.trustedComparableCandidates, 2);
  assert.equal(comparison.comparisonBasis.selection.trustedScenarioContractCandidates, 1);
});

test('prefers an exact scenario contract before a newer declared-compatible baseline', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-compatible-hash-'));
  t.after(async () => fsp.rm(rootDir, { recursive: true, force: true }));
  await writeRun({
    root: rootDir,
    runId: 'newer-compatible-run',
    actual: 700,
    endedAt: '2026-06-16T10:05:00.000Z',
    scenarioHash: 'a'.repeat(64),
  });
  await writeRun({
    root: rootDir,
    runId: 'older-exact-run',
    actual: 900,
    endedAt: '2026-06-16T10:00:00.000Z',
    scenarioHash: 'b'.repeat(64),
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
    scenarioHash: 'b'.repeat(64),
    acceptedBaselineScenarioHashes: ['a'.repeat(64)],
  });

  const comparison = compareLatestTrustedRun({ rootDir, scenarioId: 'open-close-cycle', currentDir }).comparison;
  assert.equal(comparison.baselineRunId, 'older-exact-run');
  assert.equal(comparison.comparisonBasis.scenarioContract.status, 'exact');
});

test('uses the newest explicitly accepted baseline when no exact contract exists', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-declared-hash-'));
  t.after(async () => fsp.rm(rootDir, { recursive: true, force: true }));
  await writeRun({
    root: rootDir,
    runId: 'accepted-baseline-run',
    actual: 900,
    endedAt: '2026-06-16T10:05:00.000Z',
    scenarioHash: 'a'.repeat(64),
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
    scenarioHash: 'b'.repeat(64),
    acceptedBaselineScenarioHashes: ['a'.repeat(64)],
  });

  const comparison = compareLatestTrustedRun({ rootDir, scenarioId: 'open-close-cycle', currentDir }).comparison;
  assert.equal(comparison.baselineRunId, 'accepted-baseline-run');
  assert.equal(comparison.comparisonBasis.scenarioContract.status, 'declared-compatible');
  assert.equal(comparison.measurementPolicy.baselineSelection.poisoningProtection.scenarioCompatibility.status, 'declared-compatible');
});

test('keeps newest-first ordering for legacy current runs with mixed historical hashes', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-legacy-order-'));
  t.after(async () => fsp.rm(rootDir, { recursive: true, force: true }));
  await writeRun({
    root: rootDir,
    runId: 'older-hashless-run',
    actual: 900,
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  await writeRun({
    root: rootDir,
    runId: 'newer-hash-aware-run',
    actual: 850,
    endedAt: '2026-06-16T10:05:00.000Z',
    scenarioHash: 'a'.repeat(64),
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-legacy-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
  });

  const comparison = compareLatestTrustedRun({ rootDir, scenarioId: 'open-close-cycle', currentDir }).comparison;
  assert.equal(comparison.baselineRunId, 'newer-hash-aware-run');
  assert.equal(comparison.comparisonBasis.scenarioContract.status, 'legacy-compatible');
});

test('filters latest trusted prior runs by provenance cohort hash when current is cohort-aware', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-cohort-hash-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'newer-other-cohort-run',
    actual: 10,
    endedAt: '2026-06-16T10:05:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
    scenarioHash: 'a'.repeat(64),
    cohortHash: 'b'.repeat(64),
  });
  await writeRun({
    root: rootDir,
    runId: 'older-same-cohort-run',
    actual: 900,
    endedAt: '2026-06-16T10:00:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
    scenarioHash: 'a'.repeat(64),
    cohortHash: 'c'.repeat(64),
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-same-cohort-run',
    actual: 800,
    endedAt: '2026-06-16T10:10:00.000Z',
    comparisonLane: 'example-android-live+agent-device',
    scenarioHash: 'a'.repeat(64),
    cohortHash: 'c'.repeat(64),
  });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE_LATEST,
    '--root',
    rootDir,
    '--scenario',
    'open-close-cycle',
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.baselineRunId, 'older-same-cohort-run');
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(comparison.comparisonBasis.selection.cohortHash, 'c'.repeat(64));
  assert.deepEqual(comparison.measurementPolicy.baselineSelection, {
    mode: 'latestTrustedPrior',
    poisoningProtection: {
      cohortHash: 'c'.repeat(64),
      comparisonLane: 'example-android-live+agent-device',
      requireMatchingScenarioId: true,
      requirePassedHealth: true,
      requirePassedVerdict: true,
      scenarioCompatibility: {
        baselineHash: 'a'.repeat(64),
        currentHash: 'a'.repeat(64),
        reason: 'scenario_hash_match',
        status: 'exact',
      },
      scenarioHash: 'a'.repeat(64),
    },
  });
  assert.equal(comparison.comparisonBasis.selection.trustedComparableCandidates, 2);
  assert.equal(comparison.comparisonBasis.selection.trustedScenarioContractCandidates, 2);
  assert.equal(comparison.comparisonBasis.selection.trustedCohortCandidates, 1);
});

test('demonstrates why latest-only movement cannot stand in for historical evidence', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-history-falsification-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  const scenarioHash = 'a'.repeat(64);
  const cohortHash = 'b'.repeat(64);
  const comparisonLane = 'android-release';
  const historicalActuals = [700, 700, 950];
  for (const [index, actual] of historicalActuals.entries()) {
    await writeRun({
      root: rootDir,
      runId: `trusted-history-${index + 1}`,
      actual,
      endedAt: `2026-06-16T10:0${index}:00.000Z`,
      scenarioHash,
      cohortHash,
      comparisonLane,
    });
  }
  const currentActual = 850;
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: currentActual,
    endedAt: '2026-06-16T10:10:00.000Z',
    scenarioHash,
    cohortHash,
    comparisonLane,
  });

  const result = compareLatestTrustedRun({
    rootDir,
    scenarioId: 'open-close-cycle',
    currentDir,
  });
  const latestMetric = result.comparison.metricComparisons[0];
  const sortedHistory = [...historicalActuals].sort((left, right) => left - right);
  const declaredHistoricalMedian = sortedHistory[1];
  if (declaredHistoricalMedian === undefined) {
    throw new Error('Historical falsification fixture requires three declared samples.');
  }

  assert.equal(result.comparison.baselineRunId, 'trusted-history-3');
  assert.equal(result.comparison.comparisonStatus, 'low_confidence');
  assert.equal(latestMetric.baseline, 950);
  assert.equal(latestMetric.current, currentActual);
  assert.equal(latestMetric.delta, -100);
  assert.equal(result.comparison.comparisonBasis.selection.trustedCohortCandidates, 3);
  assert.equal(declaredHistoricalMedian, 700);
  assert.equal(currentActual - declaredHistoricalMedian, 150);
});

test('writes comparison and agent summary to output directory', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-out-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'baseline-run',
    actual: 850,
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 950,
    endedAt: '2026-06-16T10:05:00.000Z',
  });
  const comparisonDir = path.join(rootDir, 'comparison-output');

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE_LATEST,
    '--root',
    rootDir,
    '--scenario',
    'open-close-cycle',
    '--current',
    currentDir,
    '--out',
    comparisonDir,
  ]);

  const comparison = JSON.parse(fs.readFileSync(path.join(comparisonDir, 'comparison.json'), 'utf8'));
  const summary = fs.readFileSync(path.join(comparisonDir, 'agent-summary.md'), 'utf8');
  assert.equal(stdout.trim(), comparisonDir);
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.match(summary, /Comparison: low_confidence/u);
  assert.match(summary, /low-confidence timing movement/u);
});

test('fail-on-regression exits nonzero after writing latest comparison artifacts', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-regression-gate-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'baseline-run',
    actual: 850,
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 1200,
    endedAt: '2026-06-16T10:05:00.000Z',
  });
  const comparisonDir = path.join(rootDir, 'comparison-output');

  await assert.rejects(
    execFileAsync(process.execPath, [
      COMPARE_LATEST,
      '--root',
      rootDir,
      '--scenario',
      'open-close-cycle',
      '--current',
      currentDir,
      '--out',
      comparisonDir,
      '--fail-on-regression',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.equal(execError.stdout.trim(), comparisonDir);
      assert.match(execError.stderr, /Comparison regressed for current-run/u);
      assert.match(execError.stderr, /Inspect .*comparison-output/u);
      return true;
    },
  );

  const comparison = JSON.parse(fs.readFileSync(path.join(comparisonDir, 'comparison.json'), 'utf8'));
  const summary = fs.readFileSync(path.join(comparisonDir, 'agent-summary.md'), 'utf8');
  assert.equal(comparison.comparisonStatus, 'worse');
  assert.match(summary, /Comparison: worse/u);
});

test('rejects current runs that failed scenario health', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-health-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  await writeRun({
    root: rootDir,
    runId: 'baseline-run',
    actual: 850,
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 800,
    endedAt: '2026-06-16T10:05:00.000Z',
    healthStatus: 'failed',
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      COMPARE_LATEST,
      '--root',
      rootDir,
      '--scenario',
      'open-close-cycle',
      '--current',
      currentDir,
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.match(execError.stderr, /Current run health did not pass/u);
      return true;
    },
  );
});

test('rejects roots without a trusted prior run', async (t: TestContext) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-latest-missing-'));
  t.after(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });
  const currentDir = await writeRun({
    root: rootDir,
    runId: 'current-run',
    actual: 800,
    endedAt: '2026-06-16T10:05:00.000Z',
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      COMPARE_LATEST,
      '--root',
      rootDir,
      '--scenario',
      'open-close-cycle',
      '--current',
      currentDir,
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.match(execError.stderr, /No trusted prior run/u);
      assert.match(execError.stderr, /inspected 1 candidate run\(s\), 1 trusted/u);
      return true;
    },
  );
});
