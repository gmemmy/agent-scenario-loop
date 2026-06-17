const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
 * @param {{root: string, runId: string, actual: number, endedAt: string, healthStatus?: string, verdictStatus?: string}} options
 * @returns {Promise<string>}
 */
async function writeRun({
  root,
  runId,
  actual,
  endedAt,
  healthStatus = 'passed',
  verdictStatus = actual <= 1000 ? 'passed' : 'failed',
}: {
  root: string;
  runId: string;
  actual: number;
  endedAt: string;
  healthStatus?: string;
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
      platform: 'android',
      interactionDriver: 'adb-logcat',
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
  assert.equal(comparison.comparisonStatus, 'better');
  assert.equal(comparison.metricComparisons[0].delta, -190);
  assert.deepEqual(comparison.comparisonBasis, {
    strategy: 'latest_trusted_prior',
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
      trustedCandidates: 2,
      trustedPriorCandidates: 1,
    },
  });
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
