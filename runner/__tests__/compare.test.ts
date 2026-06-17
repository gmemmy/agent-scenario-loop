const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const COMPARE = path.join(DIST_ROOT, 'runner', 'compare.js');

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
 * Writes a minimal comparable run directory.
 *
 * @param {{root: string, runId: string, actual: number, healthStatus?: string}} options
 * @returns {Promise<string>}
 */
async function writeRun({
  root,
  runId,
  actual,
  healthStatus = 'passed',
}: {
  root: string;
  runId: string;
  actual: number;
  healthStatus?: string;
}): Promise<string> {
  const runDir = path.join(root, runId);
  await fsp.mkdir(runDir, { recursive: true });
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
      verdictStatus: actual <= 1000 ? 'passed' : 'failed',
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

test('prints comparison JSON for two trusted run directories', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({ root: outputDir, runId: 'baseline-run', actual: 1200 });
  const currentDir = await writeRun({ root: outputDir, runId: 'current-run', actual: 900 });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.comparisonStatus, 'better');
  assert.equal(comparison.metricComparisons[0].delta, -300);
  assert.deepEqual(comparison.comparisonBasis, {
    strategy: 'explicit',
    baseline: {
      runId: 'baseline-run',
      runDir: baselineDir,
      healthStatus: 'passed',
      verdictStatus: 'failed',
    },
    current: {
      runId: 'current-run',
      runDir: currentDir,
      healthStatus: 'passed',
      verdictStatus: 'passed',
    },
  });
});

test('writes comparison and agent summary when output is a run directory', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-out-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({ root: outputDir, runId: 'baseline-run', actual: 900 });
  const currentDir = await writeRun({ root: outputDir, runId: 'current-run', actual: 1200 });
  const comparisonDir = path.join(outputDir, 'comparison');

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
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
  assert.match(summary, /Current run regressed/u);
});
