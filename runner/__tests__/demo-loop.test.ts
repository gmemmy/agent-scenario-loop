const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const DEMO_LOOP = path.join(DIST_ROOT, 'runner', 'demo-loop.js');

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

test('demo loop runs preflight, fixture profiles, and comparison without a simulator', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-demo-loop-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(process.execPath, [
    DEMO_LOOP,
    '--out',
    outputDir,
  ]);

  const result = JSON.parse(stdout);
  const comparison = JSON.parse(fs.readFileSync(path.join(result.currentRunDir, 'comparison.json'), 'utf8'));
  const agentSummary = fs.readFileSync(path.join(result.currentRunDir, 'agent-summary.md'), 'utf8');
  const cycleP95 = comparison.metricComparisons.find(
    (metric: { name: string }) => metric.name === 'cycle p95',
  );

  assert.equal(result.outputDir, outputDir);
  assert.equal(comparison.comparisonStatus, 'low_confidence');
  assert.equal(cycleP95.delta, -800);
  assert.ok(fs.existsSync(path.join(result.preflightDir, 'planner-compatibility.json')));
  assert.match(agentSummary, /Comparison: low_confidence/u);
  assert.match(agentSummary, /Owner: `scenario_contract`/u);
  assert.match(agentSummary, /Repeat the same comparison policy or collect a complete multi-sample run/u);
});
