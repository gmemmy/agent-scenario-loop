const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const CHECK_PLAN = path.join(DIST_ROOT, 'runner', 'check-plan.js');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;
type JsonRecord = Record<string, any>;
type PlanCheck = {
  code?: string;
};

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
 * Resolves a path relative to the repository root.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function fixturePath(relativePath: string): string {
  return path.join(ROOT, relativePath);
}

/**
 * Reads a JSON file.
 *
 * @param {string} filePath
 * @returns {unknown}
 */
function readJson(filePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('prints health and verdict artifacts for a compatible plan', async () => {
  const { SCHEMAS, validateJson } = require('../../core/schema-validator');
  const { stdout } = await execFileAsync(process.execPath, [
    CHECK_PLAN,
    '--scenario',
    fixturePath('examples/scenarios/mobile/app-startup.json'),
    '--runner',
    fixturePath('examples/runners/xcodebuildmcp-ios.json'),
    '--platform',
    'ios',
    '--run-id',
    'cli-run-1',
  ]);

  const output = JSON.parse(stdout);
  assert.equal(output.health.scenarioId, 'app-startup');
  assert.equal(output.health.runId, 'cli-run-1');
  assert.equal(output.health.healthStatus, 'passed');
  assert.equal(output.verdict.verdictStatus, 'not_evaluated');
  assert.equal(validateJson(output.health, SCHEMAS.health, 'Health artifact').valid, true);
  assert.equal(validateJson(output.verdict, SCHEMAS.verdict, 'Verdict artifact').valid, true);
});

test('writes health, verdict, and compatibility artifacts to an output directory', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-check-plan-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(process.execPath, [
    CHECK_PLAN,
    '--scenario',
    fixturePath('examples/scenarios/mobile/open-close-cycle.json'),
    '--runner',
    fixturePath('examples/runners/xcodebuildmcp-ios.json'),
    '--platform',
    'ios',
    '--run-id',
    'cli-run-2',
    '--out',
    outputDir,
  ]);

  assert.equal(stdout.trim(), outputDir);
  const health = readJson(path.join(outputDir, 'health.json'));
  const verdict = readJson(path.join(outputDir, 'verdict.json'));
  const compatibility = readJson(path.join(outputDir, 'planner-compatibility.json'));
  const agentSummary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'not_evaluated');
  assert.equal(compatibility.compatible, true);
  assert.ok(health.matched.driverActions.includes('tap'));
  assert.ok(compatibility.matched.driverActions.includes('tap'));
  assert.match(agentSummary, /Scenario health passed/u);
});

test('writes failed health and inconclusive verdict for incompatible plans', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-check-plan-failed-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  await execFileAsync(process.execPath, [
    CHECK_PLAN,
    '--scenario',
    fixturePath('examples/scenarios/mobile/media-open-close.json'),
    '--runner',
    fixturePath('examples/runners/manual-log-ingest.json'),
    '--platform',
    'ios',
    '--run-id',
    'cli-run-3',
    '--out',
    outputDir,
  ]);

  const health = readJson(path.join(outputDir, 'health.json'));
  const verdict = readJson(path.join(outputDir, 'verdict.json'));

  assert.equal(health.healthStatus, 'failed');
  assert.ok(health.checks.some((check: PlanCheck) => check.code === 'missing_required_capability'));
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.match(verdict.summary, /do not optimize/u);
});

test('allows evidence providers to satisfy required evidence in CLI plans', async () => {
  const { buildPlanArtifacts } = require('../check-plan');
  const scenario = readJson(fixturePath('examples/scenarios/mobile/scroll-settle.json'));
  const scenarioPath = path.join(os.tmpdir(), `asl-scroll-settle-${Date.now()}.json`);
  scenario.artifacts.required.push('profiler');
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

  try {
    const artifacts = await buildPlanArtifacts({
      scenarioPath,
      runnerPath: fixturePath('examples/runners/xcodebuildmcp-ios.json'),
      providerPaths: [fixturePath('examples/runners/rozenite-profiler-provider.json')],
      platform: 'ios',
      runId: 'cli-run-4',
    });

    assert.equal(artifacts.health.healthStatus, 'passed');
    assert.ok(artifacts.health.matched.artifacts.includes('profiler'));
    assert.deepEqual(artifacts.health.matched.evidenceProviders, ['rozenite-profiler-provider']);
  } finally {
    await fsp.rm(scenarioPath, { force: true });
  }
});

test('fails before planning when the scenario manifest does not match the schema', async (t: TestContext) => {
  const scenario = readJson(fixturePath('examples/scenarios/mobile/app-startup.json'));
  scenario.steps[0].kind = 'summon';
  const scenarioPath = path.join(os.tmpdir(), `asl-invalid-scenario-${Date.now()}.json`);
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  t.after(async () => {
    await fsp.rm(scenarioPath, { force: true });
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      CHECK_PLAN,
      '--scenario',
      scenarioPath,
      '--runner',
      fixturePath('examples/runners/xcodebuildmcp-ios.json'),
      '--platform',
      'ios',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.match(execError.stderr, /Scenario manifest failed schema validation/u);
      assert.match(execError.stderr, /\$\.steps\[0\]\.kind/u);
      assert.match(execError.stderr, /Expected one of/u);
      return true;
    },
  );
});

test('fails before planning when an evidence provider manifest does not match the schema', async (t: TestContext) => {
  const provider = readJson(fixturePath('examples/runners/rozenite-profiler-provider.json'));
  provider.kind = 'primary';
  delete provider.runnerId;
  const providerPath = path.join(os.tmpdir(), `asl-invalid-provider-${Date.now()}.json`);
  await fsp.writeFile(providerPath, `${JSON.stringify(provider, null, 2)}\n`, 'utf8');
  t.after(async () => {
    await fsp.rm(providerPath, { force: true });
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      CHECK_PLAN,
      '--scenario',
      fixturePath('examples/scenarios/mobile/scroll-settle.json'),
      '--runner',
      fixturePath('examples/runners/xcodebuildmcp-ios.json'),
      '--provider',
      providerPath,
      '--platform',
      'ios',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.match(execError.stderr, /Evidence provider manifest 1 failed schema validation/u);
      assert.match(execError.stderr, /\$\.runnerId/u);
      return true;
    },
  );
});
