const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const PROFILE_IOS = path.join(DIST_ROOT, 'runner', 'profile-ios.js');
const {
  deriveProfileSessionCaptureWaitMs,
  resolveIosSimctlProfileCommands,
  resolveProfileSessionCaptureWaitMs,
  runProfileIos,
} = require('../profile-ios');
const {
  resolveAsyncStorageDirectory,
} = require('../ios-simctl');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};
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
 * Resolves a repository fixture path.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function fixturePath(relativePath: string): string {
  return path.join(ROOT, relativePath);
}

/**
 * Reads a JSON artifact.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Creates a fake xcrun executor from argument-keyed responses.
 *
 * @param {Record<string, Partial<CommandResult>>} responses
 * @returns {(command: string, args: string[]) => Promise<CommandResult>}
 */
function createExecutor(responses: Record<string, Partial<CommandResult>>) {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
}

test('profile-ios writes artifacts from fixture event logs', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('core/config-template.json'),
    '--scenario',
    fixturePath('examples/scenarios/ios/app-startup.json'),
    '--events',
    fixturePath('examples/event-logs/app-startup-baseline.log'),
    '--out',
    artifactRoot,
    '--run-id',
    'demo-baseline',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const metrics = readJson(path.join(runDir, 'metrics.json'));
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

  assert.equal(runDir, path.join(artifactRoot, 'app-startup', 'demo-baseline'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  assert.equal(metrics.p95Ms, 2400);
  assert.equal(verdict.budgetChecks[0].name, 'failures');
  assert.match(summary, /Scenario health passed/u);
});

test('profile-ios profiles public scenario ids and milestone budgets', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-public-scenario-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'public-journey.json');
  const eventLogPath = path.join(tempRoot, 'public-journey-ios.log');
  const scenario = readJson(fixturePath('templates/mobile-scenario.json'));
  scenario.id = 'public-journey';
  scenario.flowId = 'public-journey';
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:00:00.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"public-journey-ios","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.700Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"public-journey-ios","iteration":1,"atMs":700}',
      '2026-01-01T00:00:01.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"public-journey-ios","iteration":2,"atMs":1000}',
      '2026-01-01T00:00:01.760Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"public-journey-ios","iteration":2,"atMs":1760}',
      '2026-01-01T00:00:02.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"public-journey-ios","iteration":3,"atMs":2000}',
      '2026-01-01T00:00:02.830Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"public-journey-ios","iteration":3,"atMs":2830}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'public-journey-ios',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json'));
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const causalRun = readJson(path.join(runDir, 'causal-run.json'));

  assert.equal(runDir, path.join(artifactRoot, 'public-journey', 'public-journey-ios'));
  assert.equal(metrics.scenario, 'public-journey');
  assert.equal(metrics.iterations, 3);
  assert.equal(metrics.failures, 0);
  assert.deepEqual(metrics.durationsMs, [700, 760, 830]);
  assert.equal(metrics.budgetEvaluation.pass, true);
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  assert.deepEqual(
    verdict.budgetChecks.map((check: Record<string, unknown>) => check.name),
    ['failures', 'journey p95'],
  );
  assert.equal(causalRun.scenario.id, 'public-journey');
  assert.deepEqual(causalRun.budgets, {
    failures: { limit: 0, metric: 'failures', unit: 'count' },
  });
});

test('profile-ios writes partial iteration accounting for incomplete repeated cycles', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-partial-iterations-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'portable-open-close-partial.json');
  const eventLogPath = path.join(tempRoot, 'portable-open-close-partial-ios.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'portable-open-close-partial',
    flowId: 'portable-open-close-partial',
    journey: {
      name: 'Portable open close partial',
      intent: 'Open and close a surface repeatedly.',
      actor: 'app user',
      startState: 'home',
      endState: 'home',
    },
    milestones: [
      { name: 'surface_open_requested', event: 'surface_open_requested', phase: 'intent', timeoutMs: 1000 },
      { name: 'surface_opened', event: 'surface_opened', phase: 'visual', timeoutMs: 1000 },
      { name: 'surface_close_requested', event: 'surface_close_requested', phase: 'intent', timeoutMs: 1000 },
      { name: 'surface_dismissed', event: 'surface_dismissed', phase: 'completion', timeoutMs: 1000 },
    ],
    cycles: {
      iterations: 3,
      stopOnFailure: false,
    },
    budgets: {
      pass: {
        failures: 0,
      },
    },
  };
  await fsp.writeFile(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.000Z public-ios [profile-event] {"event":"surface_open_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":1,"atMs":0,"sequence":1,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:00.120Z public-ios [profile-event] {"event":"surface_opened","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":1,"atMs":120,"sequence":1,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:00.220Z public-ios [profile-event] {"event":"surface_close_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":1,"atMs":220,"sequence":2,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:00.340Z public-ios [profile-event] {"event":"surface_dismissed","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":1,"atMs":340,"sequence":2,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:01.000Z public-ios [profile-event] {"event":"surface_open_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":2,"atMs":1000,"sequence":3,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:01.140Z public-ios [profile-event] {"event":"surface_opened","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":2,"atMs":1140,"sequence":3,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.000Z public-ios [profile-event] {"event":"surface_open_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":3,"atMs":2000,"sequence":5,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.130Z public-ios [profile-event] {"event":"surface_opened","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":3,"atMs":2130,"sequence":5,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.260Z public-ios [profile-event] {"event":"surface_close_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":3,"atMs":2260,"sequence":6,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.390Z public-ios [profile-event] {"event":"surface_dismissed","scenario":"portable-open-close-partial","runId":"partial-iterations-ios","iteration":3,"atMs":2390,"sequence":6,"queueId":"portable-open-close-partial"}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'partial-iterations-ios',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(causalRun.scenario.iterations, 3);
  assert.deepEqual(causalRun.iterationSummary, {
    completed: 2,
    expected: 3,
    failed: 1,
    incomplete: [2],
    status: 'partial',
    timeouts: 0,
  });
  assert.deepEqual(causalRun.timeline[0].metadata, {
    iteration: 1,
    queueId: 'portable-open-close-partial',
    sequence: 1,
  });
});

test('profile-ios rehydrates simctl sidecar events when enriched run id differs', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-rehydrate-sidecar-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const sidecarRoot = path.join(tempRoot, '_ios-simctl-captures', 'source-public-journey-ios');
  const scenarioPath = path.join(tempRoot, 'public-journey.json');
  const scenario = readJson(fixturePath('templates/mobile-scenario.json'));
  scenario.id = 'public-journey';
  scenario.flowId = 'public-journey';
  await fsp.mkdir(path.join(sidecarRoot, 'raw'), { recursive: true });
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-profile-events.log'),
    [
      '2026-01-01T00:00:00.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.700Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios","iteration":1,"atMs":700}',
      '2026-01-01T00:00:01.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios","iteration":2,"atMs":1000}',
      '2026-01-01T00:00:01.760Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios","iteration":2,"atMs":1760}',
      '2026-01-01T00:00:02.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios","iteration":3,"atMs":2000}',
      '2026-01-01T00:00:02.830Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios","iteration":3,"atMs":2830}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-simctl-log.txt'),
    'Timestamp Ty Process[PID:TID]\n',
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--simctl-artifacts',
    sidecarRoot,
    '--out',
    artifactRoot,
    '--run-id',
    'public-journey-ios-aftercapture',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json'));
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const causalRun = readJson(path.join(runDir, 'causal-run.json'));
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const diagnostics = (manifest.artifacts as { diagnostics: Array<Record<string, any>> }).diagnostics;
  const jsDiagnostic = diagnostics.find((entry) => entry.kind === 'js');

  assert.equal(runDir, path.join(artifactRoot, 'public-journey', 'public-journey-ios-aftercapture'));
  assert.equal(metrics.iterations, 3);
  assert.deepEqual(metrics.durationsMs, [700, 760, 830]);
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  const identityCheck = (health.checks as Array<{ code: string; metadata?: Record<string, unknown>; status: string }>).find(
    (check) => check.code === 'runtime_identity_unverified',
  );
  assert.equal(identityCheck?.status, 'warning');
  assert.equal(identityCheck?.metadata?.expectedAppId, 'dev.agent-scenario-loop.example');
  assert.equal(identityCheck?.metadata?.sidecarMetadataPath, 'raw/ios-metadata.json');
  assert.equal(causalRun.runId, 'public-journey-ios-aftercapture');
  assert.ok(causalRun.timeline.length > 0);
  assert.equal(jsDiagnostic?.status, 'captured');
  assert.equal(jsDiagnostic?.path, 'raw/ios-profile-events.log');
  assert.equal(jsDiagnostic?.evidenceDependency?.root, 'sidecar');
  assert.equal(jsDiagnostic?.evidenceDependency?.path, 'raw/ios-profile-events.log');
});

test('profile-ios fails health when rehydrated simctl sidecar has ambiguous source run ids', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-rehydrate-ambiguous-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const sidecarRoot = path.join(tempRoot, '_ios-simctl-captures', 'ambiguous-public-journey-ios');
  const scenarioPath = path.join(tempRoot, 'public-journey.json');
  const scenario = readJson(fixturePath('templates/mobile-scenario.json'));
  scenario.id = 'public-journey';
  scenario.flowId = 'public-journey';
  await fsp.mkdir(path.join(sidecarRoot, 'raw'), { recursive: true });
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-profile-events.log'),
    [
      '2026-01-01T00:00:00.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios-a","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.700Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios-a","iteration":1,"atMs":700}',
      '2026-01-01T00:01:00.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios-b","iteration":1,"atMs":0}',
      '2026-01-01T00:01:00.710Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios-b","iteration":1,"atMs":710}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-simctl-log.txt'),
    'Timestamp Ty Process[PID:TID]\n',
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--simctl-artifacts',
    sidecarRoot,
    '--out',
    artifactRoot,
    '--run-id',
    'public-journey-ios-aftercapture',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const identityCheck = (health.checks as Array<{ code: string; metadata?: Record<string, unknown> }>).find(
    (check) => check.code === 'profile_session_identity_ambiguous',
  );

  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.ok(identityCheck);
  assert.equal(identityCheck?.metadata?.sourceRunIds, 'source-public-journey-ios-a,source-public-journey-ios-b');
  assert.equal(identityCheck?.metadata?.nextActionCode, 'rerun_with_unambiguous_profile_session');
  assert.ok(fs.existsSync(path.join(runDir, 'manifest.json')));
});

test('profile-ios fails health when simctl sidecar bundle mismatches expected bundle', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-runtime-identity-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const sidecarRoot = path.join(tempRoot, '_ios-simctl-captures', 'source-public-journey-ios');
  const scenarioPath = path.join(tempRoot, 'public-journey.json');
  const scenario = readJson(fixturePath('templates/mobile-scenario.json'));
  scenario.id = 'public-journey';
  scenario.flowId = 'public-journey';
  await fsp.mkdir(path.join(sidecarRoot, 'raw'), { recursive: true });
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-profile-events.log'),
    [
      '2026-01-01T00:00:00.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.700Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios","iteration":1,"atMs":700}',
      '2026-01-01T00:00:01.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios","iteration":2,"atMs":1000}',
      '2026-01-01T00:00:01.760Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios","iteration":2,"atMs":1760}',
      '2026-01-01T00:00:02.000Z public-ios [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"source-public-journey-ios","iteration":3,"atMs":2000}',
      '2026-01-01T00:00:02.830Z public-ios [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"source-public-journey-ios","iteration":3,"atMs":2830}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-simctl-log.txt'),
    'Timestamp Ty Process[PID:TID]\n',
    'utf8',
  );
  await fsp.writeFile(
    path.join(sidecarRoot, 'raw', 'ios-metadata.json'),
    `${JSON.stringify({
      bundleId: 'dev.other.example',
      selectedSimulator: {
        name: 'iPhone 15',
        state: 'Booted',
        udid: 'A692ED28-893E-453F-8866-C69331AE757F',
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--simctl-artifacts',
    sidecarRoot,
    '--bundle',
    'dev.agent-scenario-loop.example',
    '--device',
    'A692ED28-893E-453F-8866-C69331AE757F',
    '--out',
    artifactRoot,
    '--run-id',
    'public-journey-ios-aftercapture',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const identityCheck = (health.checks as Array<{ code: string; metadata?: Record<string, unknown>; status: string }>).find(
    (check) => check.code === 'runtime_identity_mismatch',
  );

  assert.equal(metrics.status, 'passed');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(identityCheck?.status, 'failed');
  assert.equal(identityCheck?.metadata?.expectedAppId, 'dev.agent-scenario-loop.example');
  assert.equal(identityCheck?.metadata?.expectedAppIdSource, 'cli');
  assert.equal(identityCheck?.metadata?.observedAppId, 'dev.other.example');
  assert.equal(identityCheck?.metadata?.expectedTargetId, 'A692ED28-893E-453F-8866-C69331AE757F');
  assert.equal(identityCheck?.metadata?.observedTargetId, 'A692ED28-893E-453F-8866-C69331AE757F');
  assert.equal(identityCheck?.metadata?.sidecarMetadataPath, 'raw/ios-metadata.json');
  assert.equal(identityCheck?.metadata?.nextActionCode, 'rerun_sidecar_with_expected_runtime_identity');
});

test('profile-ios falls back to bundled simctl driver metadata when no host driver is declared', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-neutral-driver-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const configPath = path.join(tempRoot, 'asl.config.json');
  const scenarioPath = path.join(tempRoot, 'neutral-journey.json');
  const eventLogPath = path.join(tempRoot, 'neutral-journey-ios.log');
  const config = readJson(fixturePath('core/config-template.json'));
  delete config.drivers.default;
  const scenario = readJson(fixturePath('templates/mobile-scenario.json'));
  scenario.id = 'neutral-journey';
  scenario.flowId = 'neutral-journey';
  delete scenario.interactionDriver;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:00:00.000Z neutral-ios [profile-event] {"event":"first_journey_started","scenario":"neutral-journey","runId":"neutral-journey-ios","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.700Z neutral-ios [profile-event] {"event":"first_journey_completed","scenario":"neutral-journey","runId":"neutral-journey-ios","iteration":1,"atMs":700}',
      '2026-01-01T00:00:01.000Z neutral-ios [profile-event] {"event":"first_journey_started","scenario":"neutral-journey","runId":"neutral-journey-ios","iteration":2,"atMs":1000}',
      '2026-01-01T00:00:01.760Z neutral-ios [profile-event] {"event":"first_journey_completed","scenario":"neutral-journey","runId":"neutral-journey-ios","iteration":2,"atMs":1760}',
      '2026-01-01T00:00:02.000Z neutral-ios [profile-event] {"event":"first_journey_started","scenario":"neutral-journey","runId":"neutral-journey-ios","iteration":3,"atMs":2000}',
      '2026-01-01T00:00:02.830Z neutral-ios [profile-event] {"event":"first_journey_completed","scenario":"neutral-journey","runId":"neutral-journey-ios","iteration":3,"atMs":2830}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    configPath,
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'neutral-journey-ios',
  ]);

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json'));

  assert.equal(manifest.interactionDriver, 'ios-simctl');
});

test('profile-ios reports schema-era open and close interval budgets', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-open-close-budget-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'portable-open-close.json');
  const eventLogPath = path.join(tempRoot, 'portable-open-close-ios.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'portable-open-close',
    flowId: 'portable-open-close',
    journey: {
      name: 'Portable open close',
      intent: 'Open and close a surface.',
      actor: 'app user',
      startState: 'home',
      endState: 'home',
    },
    platforms: ['ios', 'android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    milestones: [
      { id: 'openRequested', event: 'card_open_requested', required: true, phase: 'intent' },
      { id: 'opened', event: 'card_opened', required: true, phase: 'visual' },
      { id: 'closeRequested', event: 'card_close_requested', required: true, phase: 'intent' },
      { id: 'dismissed', event: 'card_dismissed', required: true, phase: 'completion' },
    ],
    expectedEvents: ['card_open_requested', 'card_opened', 'card_close_requested', 'card_dismissed'],
    cycles: { iterations: 2, warmupIterations: 0, stopOnFailure: true },
    budgets: [
      {
        name: 'open p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 200,
        fromMilestone: 'openRequested',
        toMilestone: 'opened',
      },
      {
        name: 'close p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 120,
        fromMilestone: 'closeRequested',
        toMilestone: 'dismissed',
      },
    ],
    steps: [{ id: 'launch', kind: 'launch' }],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:00:00.000Z public-ios [profile-event] {"event":"card_open_requested","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.110Z public-ios [profile-event] {"event":"card_opened","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":1,"atMs":110}',
      '2026-01-01T00:00:00.390Z public-ios [profile-event] {"event":"card_close_requested","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":1,"atMs":390}',
      '2026-01-01T00:00:00.470Z public-ios [profile-event] {"event":"card_dismissed","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":1,"atMs":470}',
      '2026-01-01T00:00:01.000Z public-ios [profile-event] {"event":"card_open_requested","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":2,"atMs":1000}',
      '2026-01-01T00:00:01.125Z public-ios [profile-event] {"event":"card_opened","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":2,"atMs":1125}',
      '2026-01-01T00:00:01.410Z public-ios [profile-event] {"event":"card_close_requested","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":2,"atMs":1410}',
      '2026-01-01T00:00:01.500Z public-ios [profile-event] {"event":"card_dismissed","scenario":"portable-open-close","runId":"portable-open-close-ios","iteration":2,"atMs":1500}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_IOS,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'portable-open-close-ios',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.deepEqual(metrics.durationsMs, [470, 500]);
  assert.deepEqual(metrics.openDurationsMs, [110, 125]);
  assert.deepEqual(metrics.closeDurationsMs, [80, 90]);
  assert.equal(metrics.budgetEvaluation.pass, true);
  assert.deepEqual(metrics.budgetEvaluation.checks, [
    { actual: 125, limit: 200, name: 'open p95', pass: true, unit: 'ms' },
    { actual: 90, limit: 120, name: 'close p95', pass: true, unit: 'ms' },
  ]);
  assert.deepEqual(causalRun.budgets, {
  });
});

test('profile-ios attaches agent-device capture artifacts with explicit event logs', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-agent-device-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });
  const scenarioPath = path.join(artifactRoot, 'app-startup-agent-device.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/ios/app-startup.json'));
  scenario.steps = [
    {
      id: 'capture-agent-device-screenshot',
      kind: 'captureEvidence',
      artifact: 'screenshot',
      driverAction: 'screenshot',
      adapterOptions: {
        agentDevice: {
          captureFileName: 'agent-device-final.png',
          rawFileName: 'agent-device-final.txt',
        },
      },
    },
  ];
  fs.writeFileSync(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  const calls: string[] = [];
  const agentDeviceExecutor = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push(args.join(' '));
    if (args[0] === 'screenshot' && typeof args[1] === 'string') {
      await fsp.writeFile(args[1], 'fake image', 'utf8');
    }
    return {
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: '{"success":true}\n',
    };
  };

  const result = await runProfileIos({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    scenario: scenarioPath,
    events: fixturePath('examples/mobile-app/event-logs/app-startup.log'),
    out: artifactRoot,
    'run-id': 'ios-agent-device-profile',
    'agent-device-capture': true,
    device: 'BOOTED',
    'agent-device-session': 'profile-ios',
    'agent-device-session-mode': 'bind',
  }, { agentDeviceExecutor });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const agentDeviceMetadata = readJson(path.join(
    artifactRoot,
    '_agent-device-captures',
    'ios-agent-device-profile',
    'raw',
    'agent-device-metadata.json',
  ));

  assert.deepEqual(calls, [
    `screenshot ${path.join(artifactRoot, '_agent-device-captures', 'ios-agent-device-profile', 'captures', 'agent-device-final.png')} --platform ios --target mobile --udid BOOTED --session profile-ios --json`,
  ]);
  assert.equal(manifest.interactionDriver, 'agent-device');
  assert.deepEqual((manifest.artifacts as { captures: { screenshots: string[] } }).captures.screenshots, [
    'captures/agent-device-final.png',
  ]);
  assert.equal(agentDeviceMetadata.session, 'profile-ios');
  assert.equal(agentDeviceMetadata.sessionMode, 'bind');
  assert.equal(agentDeviceMetadata.targetSelectionMode, 'session_bind');
  assert.equal((agentDeviceMetadata.captures as { screenshots: string[] }).screenshots[0], 'captures/agent-device-final.png');
  assert.equal(fs.existsSync(path.join(result.runDir, 'captures', 'agent-device-final.png')), true);
});

test('profile-ios can capture simctl logs and profile them in one run', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-simctl-capture-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const simctlCaptureRoot = path.join(tempRoot, 'simctl-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/ios/app-startup.json'));
  scenario.steps = [];
  scenario.steps.push({
    id: 'final-screenshot',
    kind: 'captureEvidence',
    artifact: 'screenshot',
    driverAction: 'screenshot',
  });
  const scenarioPath = path.join(tempRoot, 'app-startup-screenshot.json');
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  const waits: number[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const screenshotPath = path.join(simctlCaptureRoot, 'captures', 'ios-screenshot.png');
    if (key === `simctl io A692ED28-893E-453F-8866-C69331AE757F screenshot ${screenshotPath}`) {
      await fsp.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fsp.writeFile(screenshotPath, 'PNG', 'utf8');
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: 'Wrote screenshot\n',
      };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?runId=ios-live-startup&scenario=app-startup': {
        stdout: '',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: fs
          .readFileSync(fixturePath('examples/mobile-app/event-logs/app-startup.log'), 'utf8')
          .replace(/example-startup/gu, 'ios-live-startup'),
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runProfileIos({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    device: 'A692ED28-893E-453F-8866-C69331AE757F',
    launch: true,
    'lifecycle-phase': 'resume',
    out: profileRoot,
    'profile-session': true,
    'run-id': 'ios-live-startup',
    scenario: scenarioPath,
    'simctl-capture': true,
    'simctl-out': simctlCaptureRoot,
    'wait-ms': '25',
  }, {
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const health = readJson(path.join(result.runDir, 'health.json'));
  const simctlHealth = readJson(path.join(simctlCaptureRoot, 'health.json'));
  const causalRun = readJson(path.join(result.runDir, 'causal-run.json'));

  assert.deepEqual(waits, [250, 25]);
  assert.equal(result.runDir, path.join(profileRoot, 'app-startup', 'ios-live-startup'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(simctlHealth.healthStatus, 'passed');
  assert.deepEqual(manifest.simulator, {
    name: 'iPhone 17 Pro Max',
    udid: 'A692ED28-893E-453F-8866-C69331AE757F',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).preconditions.foregroundState, {
    evidence: 'asserted',
    source: 'simctl',
    value: 'controlled-by-runner',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).preconditions.lifecyclePhase, {
    artifact: 'raw/ios-simctl-log.txt',
    evidence: 'asserted',
    source: 'simctl',
    value: 'resume',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).postconditions.appState, {
    artifact: 'raw/ios-simctl-log.txt',
    evidence: 'asserted',
    source: 'simctl',
    value: 'foreground',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).postconditions.lifecyclePhase, {
    artifact: 'raw/ios-simctl-log.txt',
    evidence: 'asserted',
    source: 'simctl',
    value: 'foreground',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).postconditions.artifactState, {
    artifact: 'manifest.json',
    evidence: 'asserted',
    source: 'asl-profile-runner',
    value: 'complete',
  });
  assert.equal((manifest.artifacts as { raw: { interactionLog: string } }).raw.interactionLog, 'raw/ios-simctl-log.txt');
  assert.deepEqual((manifest.artifacts as { captures: { screenshots: string[] } }).captures.screenshots, [
    'captures/ios-screenshot.png',
  ]);
  assert.equal(manifest.interactionDriver, 'ios-simctl');
  assert.equal((causalRun.scenario as { driver: string }).driver, 'ios-simctl');
  assert.equal((causalRun.artifacts as { screenshot: string }).screenshot, 'captures/ios-screenshot.png');
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'ios-simctl-log.txt')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'captures', 'ios-screenshot.png')));
});

test('profile-ios can seed and profile stored iOS app truth events', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-storage-capture-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-data-container-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const simctlCaptureRoot = path.join(tempRoot, 'simctl-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (key.startsWith('simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://expo-development-client/')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: '',
      };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data': {
        stdout: `${dataContainer}\n`,
      },
      'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: '',
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runProfileIos({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    device: 'A692ED28-893E-453F-8866-C69331AE757F',
    launch: true,
    out: profileRoot,
    'ios-dev-client-url': 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
    'ios-dev-client-wait-ms': '15',
    'profile-session': true,
    'profile-session-storage': true,
    'run-id': 'ios-live-startup',
    scenario: fixturePath('examples/mobile-app/scenarios/ios/app-startup.json'),
    'simctl-capture': true,
    'simctl-out': simctlCaptureRoot,
    'wait-ms': '25',
  }, {
    delay: async () => {
      const storageDir = resolveAsyncStorageDirectory({
        bundleId: 'dev.agent-scenario-loop.example',
        dataContainer,
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
      manifest['agent-scenario-loop.profile-events.1'] = fs
        .readFileSync(fixturePath('examples/mobile-app/event-logs/app-startup.log'), 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line: string) => JSON.parse(line.slice(line.indexOf('[profile-event]') + '[profile-event]'.length).trim()))
        .map((event: Record<string, unknown>) => ({
          ...event,
          runId: 'ios-live-startup',
        }));
      manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify(manifest['agent-scenario-loop.profile-events.1']);
      manifest['agent-scenario-loop.profile-session-entries.1'] = JSON.stringify([
        {
          kind: 'command',
          scenario: 'app-startup',
          runId: 'ios-live-startup',
          source: 'storage',
          status: 'completed',
          timestamp: Date.now(),
        },
      ]);
      fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    },
    executor,
  });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const health = readJson(path.join(result.runDir, 'health.json'));
  const simctlHealth = readJson(path.join(simctlCaptureRoot, 'health.json'));

  assert.equal(health.healthStatus, 'passed');
  assert.equal(simctlHealth.healthStatus, 'passed');
  assert.equal('interactionLog' in (manifest.artifacts as { raw: Record<string, unknown> }).raw, false);
  assert.equal('deviceLog' in (manifest.artifacts as { raw: Record<string, unknown> }).raw, false);
  assert.equal((manifest.artifacts as { raw: { profileSessionEntries: string } }).raw.profileSessionEntries, 'raw/ios-profile-session-entries.json');
  assert.equal('artifact' in (manifest.environment as Record<string, any>).preconditions.lifecyclePhase, false);
  assert.equal('artifact' in (manifest.environment as Record<string, any>).postconditions.appState, false);
  assert.equal('artifact' in (manifest.environment as Record<string, any>).postconditions.lifecyclePhase, false);
  assert.equal(fs.existsSync(path.join(result.runDir, 'raw', 'ios-simctl-log.txt')), false);
  assert.equal('video' in (manifest.artifacts as { captures: Record<string, unknown> }).captures, false);
  assert.equal('uiTree' in (manifest.artifacts as { captures: Record<string, unknown> }).captures, false);
  const diagnostics = (manifest.artifacts as { diagnostics: Array<Record<string, any>> }).diagnostics;
  const logDiagnostic = diagnostics.find((entry) => entry.kind === 'logs');
  const jsDiagnostic = diagnostics.find((entry) => entry.kind === 'js');
  assert.equal(logDiagnostic?.status, 'captured');
  assert.equal(logDiagnostic?.provider, 'simctl');
  assert.equal(logDiagnostic?.runnerId, 'ios-simctl');
  assert.ok(String(logDiagnostic?.sidecarRoot).endsWith('simctl-capture'));
  assert.equal(logDiagnostic?.path, 'raw/ios-simctl-log.txt');
  assert.equal(logDiagnostic?.evidenceDependency?.root, 'sidecar');
  assert.equal(logDiagnostic?.evidenceDependency?.path, 'raw/ios-simctl-log.txt');
  assert.equal(fs.existsSync(path.join(simctlCaptureRoot, 'raw', 'ios-simctl-log.txt')), true);
  assert.equal(jsDiagnostic?.status, 'captured');
  assert.equal(jsDiagnostic?.path, 'raw/ios-profile-events.log');
  assert.equal(jsDiagnostic?.evidenceDependency?.kind, 'profile-session-entries');
  assert.equal(jsDiagnostic?.evidenceDependency?.path, 'raw/ios-profile-session-entries.json');
  assert.ok(calls.includes('simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'));
  assert.equal(calls.includes('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'), false);
  assert.ok(calls.some((call) => call.startsWith('simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://expo-development-client/')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'ios-profile-events.log')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'ios-profile-session-entries.json')));
});

test('profile-ios seeds iOS scenario commands through app storage', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-command-storage-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-command-data-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const simctlCaptureRoot = path.join(tempRoot, 'simctl-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data': {
        stdout: `${dataContainer}\n`,
      },
      'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: '',
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runProfileIos({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    device: 'A692ED28-893E-453F-8866-C69331AE757F',
    launch: true,
    out: profileRoot,
    'profile-session': true,
    'profile-session-storage': true,
    'run-id': 'ios-live-open-close',
    scenario: fixturePath('examples/mobile-app/scenarios/ios/open-close-cycle.json'),
    'simctl-capture': true,
    'simctl-out': simctlCaptureRoot,
    'wait-ms': '25',
  }, {
    delay: async () => {
      const storageDir = resolveAsyncStorageDirectory({
        bundleId: 'dev.agent-scenario-loop.example',
        dataContainer,
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
      const commands = JSON.parse(manifest['agent-scenario-loop.profile-commands.1']);
      assert.equal(commands.length, 6);
      assert.equal(commands[0].sequence, 1);
      assert.equal(commands[5].sequence, 6);
      assert.equal(commands[0].queueId, 'open-close-cycle');
      assert.equal(commands[0].commandId, 'open first example card');
      assert.equal(commands[1].commandId, 'close example card');
      manifest['agent-scenario-loop.profile-session-entries.1'] = JSON.stringify([
        {
          atMs: 40,
          command: 'activate-target:example-card-1',
          commandId: 'open-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 1,
          source: 'storage',
          status: 'received',
          waitForMilestone: 'card_opened',
          waitMs: 300,
          waitTimeoutMs: 1500,
        },
        {
          atMs: 75,
          command: 'activate-target:example-card-1',
          commandId: 'open-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          result: 'target-dispatched',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 1,
          source: 'storage',
          status: 'completed',
          waitForMilestone: 'card_opened',
          waitMs: 300,
          waitTimeoutMs: 1500,
        },
        {
          atMs: 2020,
          command: 'activate-target:example-card-1',
          commandId: 'open-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 3,
          source: 'storage',
          status: 'received',
          waitForMilestone: 'card_opened',
          waitMs: 300,
          waitTimeoutMs: 1500,
        },
        {
          atMs: 2055,
          command: 'activate-target:example-card-1',
          commandId: 'open-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          result: 'target-dispatched',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 3,
          source: 'storage',
          status: 'completed',
          waitForMilestone: 'card_opened',
          waitMs: 300,
          waitTimeoutMs: 1500,
        },
        {
          atMs: 2810,
          command: 'activate-target:close-card',
          commandId: 'close-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 4,
          source: 'storage',
          status: 'received',
          waitMs: 300,
        },
        {
          atMs: 2845,
          command: 'activate-target:close-card',
          commandId: 'close-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          result: 'target-dispatched',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 4,
          source: 'storage',
          status: 'completed',
          waitMs: 300,
        },
        {
          atMs: 760,
          command: 'activate-target:close-card',
          commandId: 'close-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 2,
          source: 'storage',
          status: 'received',
          waitMs: 300,
        },
        {
          atMs: 795,
          command: 'activate-target:close-card',
          commandId: 'close-card',
          kind: 'command',
          queueId: 'open-close-cycle',
          result: 'target-dispatched',
          runId: 'ios-live-open-close',
          scenario: 'open-close-cycle',
          sequence: 2,
          source: 'storage',
          status: 'completed',
          waitMs: 300,
        },
      ]);
      manifest['agent-scenario-loop.profile-events.1'] = fs
        .readFileSync(fixturePath('examples/mobile-app/event-logs/open-close-cycle.log'), 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line: string) => JSON.parse(line.slice(line.indexOf('[profile-event]') + '[profile-event]'.length).trim()))
        .map((event: Record<string, unknown>) => ({
          ...event,
          runId: 'ios-live-open-close',
        }));
      manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify(manifest['agent-scenario-loop.profile-events.1']);
      fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    },
    executor,
  });

  const health = readJson(path.join(result.runDir, 'health.json'));
  const causalRun = readJson(path.join(result.runDir, 'causal-run.json')) as Record<string, any>;
  const seed = readJson(path.join(simctlCaptureRoot, 'raw', 'ios-profile-session-seed.json'));

  assert.equal(health.healthStatus, 'passed');
  assert.equal((seed.commands as unknown[]).length, 6);
  assert.deepEqual(
    (seed.commands as Array<Record<string, unknown>>).slice(0, 2).map((command) => command.waitMs),
    [300, 300],
  );
  const sequencingEvidence = causalRun.timeline
    .filter((event: Record<string, any>) => (
      (event.owner === 'asl-command-transport'
        && ['open-card', 'close-card'].includes(event.metadata?.commandId)
        && [1, 2, 3, 4].includes(event.metadata?.sequence))
      || (event.name === 'card_opened' && [1, 2].includes(event.metadata?.iteration))
    ))
    .map((event: Record<string, any>) => ({
      atMs: event.atMs,
      commandId: event.metadata.commandId,
      name: event.name,
      sequence: event.metadata.sequence,
    }));
  assert.deepEqual(sequencingEvidence, [
    { atMs: 40, commandId: 'open-card', name: 'profile_command_received', sequence: 1 },
    { atMs: 75, commandId: 'open-card', name: 'profile_command_completed', sequence: 1 },
    { atMs: 380, commandId: undefined, name: 'card_opened', sequence: undefined },
    { atMs: 760, commandId: 'close-card', name: 'profile_command_received', sequence: 2 },
    { atMs: 795, commandId: 'close-card', name: 'profile_command_completed', sequence: 2 },
    { atMs: 2020, commandId: 'open-card', name: 'profile_command_received', sequence: 3 },
    { atMs: 2055, commandId: 'open-card', name: 'profile_command_completed', sequence: 3 },
    { atMs: 2410, commandId: undefined, name: 'card_opened', sequence: undefined },
    { atMs: 2810, commandId: 'close-card', name: 'profile_command_received', sequence: 4 },
    { atMs: 2845, commandId: 'close-card', name: 'profile_command_completed', sequence: 4 },
  ]);
  const firstCardOpened = causalRun.timeline.find((event: Record<string, any>) => (
    event.name === 'card_opened' && event.metadata?.iteration === 1
  ));
  const secondCardOpened = causalRun.timeline.find((event: Record<string, any>) => (
    event.name === 'card_opened' && event.metadata?.iteration === 2
  ));
  const frontLoadedCloseReceived = causalRun.timeline.find((event: Record<string, any>) => (
    event.owner === 'asl-command-transport'
    && event.name === 'profile_command_received'
    && event.metadata?.commandId === 'close-card'
    && event.atMs < firstCardOpened.atMs
  ));
  assert.equal(frontLoadedCloseReceived, undefined);
  const frontLoadedSecondCloseReceived = causalRun.timeline.find((event: Record<string, any>) => (
    event.owner === 'asl-command-transport'
    && event.name === 'profile_command_received'
    && event.metadata?.commandId === 'close-card'
    && event.metadata?.sequence === 4
    && event.atMs < secondCardOpened.atMs
  ));
  assert.equal(frontLoadedSecondCloseReceived, undefined);
  assert.deepEqual(causalRun.timeline
    .filter((event: Record<string, any>) => event.owner === 'asl-command-transport')
    .map((event: Record<string, any>) => ({
      commandId: event.metadata.commandId,
      name: event.name,
      sequence: event.metadata.sequence,
      status: event.status,
      waitForMilestone: event.metadata.waitForMilestone,
      waitMs: event.metadata.waitMs,
      waitTimeoutMs: event.metadata.waitTimeoutMs,
    })), [
    {
      commandId: 'open-card',
      name: 'profile_command_received',
      sequence: 1,
      status: 'started',
      waitForMilestone: 'card_opened',
      waitMs: 300,
      waitTimeoutMs: 1500,
    },
    {
      commandId: 'open-card',
      name: 'profile_command_completed',
      sequence: 1,
      status: 'completed',
      waitForMilestone: 'card_opened',
      waitMs: 300,
      waitTimeoutMs: 1500,
    },
    {
      commandId: 'close-card',
      name: 'profile_command_received',
      sequence: 2,
      status: 'started',
      waitForMilestone: undefined,
      waitMs: 300,
      waitTimeoutMs: undefined,
    },
    {
      commandId: 'close-card',
      name: 'profile_command_completed',
      sequence: 2,
      status: 'completed',
      waitForMilestone: undefined,
      waitMs: 300,
      waitTimeoutMs: undefined,
    },
    {
      commandId: 'open-card',
      name: 'profile_command_received',
      sequence: 3,
      status: 'started',
      waitForMilestone: 'card_opened',
      waitMs: 300,
      waitTimeoutMs: 1500,
    },
    {
      commandId: 'open-card',
      name: 'profile_command_completed',
      sequence: 3,
      status: 'completed',
      waitForMilestone: 'card_opened',
      waitMs: 300,
      waitTimeoutMs: 1500,
    },
    {
      commandId: 'close-card',
      name: 'profile_command_received',
      sequence: 4,
      status: 'started',
      waitForMilestone: undefined,
      waitMs: 300,
      waitTimeoutMs: undefined,
    },
    {
      commandId: 'close-card',
      name: 'profile_command_completed',
      sequence: 4,
      status: 'completed',
      waitForMilestone: undefined,
      waitMs: 300,
      waitTimeoutMs: undefined,
    },
  ]);
  assert.equal(calls.some((call) => call.startsWith('simctl openurl ')), false);
});

test('profile-ios executes iOS scenario commands through deep links when storage is disabled', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-command-deeplinks-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const simctlCaptureRoot = path.join(tempRoot, 'simctl-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (key.startsWith('simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: '',
      };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: fs
          .readFileSync(fixturePath('examples/mobile-app/event-logs/open-close-cycle.log'), 'utf8')
          .replace(/example-open-close/gu, 'ios-deep-link-open-close'),
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
  const waits: number[] = [];

  const result = await runProfileIos({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    device: 'A692ED28-893E-453F-8866-C69331AE757F',
    launch: true,
    out: profileRoot,
    'profile-session': true,
    'run-id': 'ios-deep-link-open-close',
    scenario: fixturePath('examples/mobile-app/scenarios/ios/open-close-cycle.json'),
    'simctl-capture': true,
    'simctl-out': simctlCaptureRoot,
    'wait-ms': '25',
  }, {
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const health = readJson(path.join(result.runDir, 'health.json'));
  const metadata = readJson(path.join(simctlCaptureRoot, 'raw', 'ios-metadata.json'));
  const openUrlCalls = calls.filter((call) => call.startsWith('simctl openurl '));

  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(waits, [250, 300, 300, 300, 300, 300, 300, 25]);
  assert.equal(openUrlCalls.length, 7);
  const firstCommandOpenUrl = openUrlCalls[1] as string;
  assert.match(firstCommandOpenUrl, /command=activate-target%3Aexample-card-1/u);
  assert.match(firstCommandOpenUrl, /commandId=open\+first\+example\+card/u);
  assert.match(firstCommandOpenUrl, /sequence=1/u);
  assert.match(firstCommandOpenUrl, /queueId=open-close-cycle/u);
  assert.match(openUrlCalls[2] as string, /command=activate-target%3Aclose-card/u);
  assert.equal((metadata.deepLinkResults as unknown[]).length, 7);
  assert.deepEqual((metadata.deepLinkResults as Array<Record<string, unknown>>)[1], {
    args: firstCommandOpenUrl.split(' '),
    exitCode: 0,
    label: 'open first example card',
    rawPath: 'raw/ios-deep-link-2.txt',
    url: 'asl-example://profile-session/command?runId=ios-deep-link-open-close&scenario=open-close-cycle&command=activate-target%3Aexample-card-1&commandId=open+first+example+card&sequence=1&queueId=open-close-cycle&waitMs=300',
    waitMs: 300,
  });
  assert.ok(fs.existsSync(path.join(simctlCaptureRoot, 'raw', 'ios-deep-link-7.txt')));
});

test('profile-ios writes failed health instead of crashing when simctl capture has no profile events', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-ios-empty-simctl-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const simctlCaptureRoot = path.join(tempRoot, 'simctl-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 1234\n',
    },
    'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?runId=ios-empty-startup&scenario=app-startup': {
      stdout: '',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runProfileIos({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    device: 'A692ED28-893E-453F-8866-C69331AE757F',
    launch: true,
    out: profileRoot,
    'profile-session': true,
    'run-id': 'ios-empty-startup',
    scenario: fixturePath('examples/mobile-app/scenarios/ios/app-startup.json'),
    'simctl-capture': true,
    'simctl-out': simctlCaptureRoot,
    'wait-ms': '0',
  }, {
    executor,
  });

  const health = readJson(path.join(result.runDir, 'health.json'));
  const verdict = readJson(path.join(result.runDir, 'verdict.json'));
  const causalRun = readJson(path.join(result.runDir, 'causal-run.json'));
  const manifest = readJson(path.join(result.runDir, 'manifest.json'));

  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].metadata.profileEventCount, 0);
  assert.equal(health.checks[0].metadata.profileSessionEntryCount, 0);
  assert.equal(health.checks[0].metadata.commandTransport, 'profile-session-deeplink');
  assert.equal(health.checks[0].metadata.nextActionCode, 'verify_profile_session_bootstrap');
  assert.match(
    health.checks[0].metadata.nextAction,
    /loaded the expected bundle/,
  );
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.deepEqual(causalRun.timeline, []);
  assert.equal(manifest.attempt.status, 'failed');
  assert.equal(manifest.attempt.terminalState, 'failed');
  assert.deepEqual(manifest.attempt.classification, {
    category: 'evidence',
    code: 'profile_truth_events_incomplete',
    message: 'Profile run did not capture every expected truth event.',
    retryable: true,
  });
  assert.deepEqual(manifest.attempt.cleanup, {
    status: 'not-required',
  });
  assert.equal(manifest.attempt.partialArtifacts.valid, true);
  assert.equal(
    manifest.attempt.partialArtifacts.reason,
    'failed profile run artifacts are preserved for diagnosis and are not a product proof until scenario health passes',
  );
  assert.ok(manifest.attempt.partialArtifacts.paths.includes('manifest.json'));
  assert.ok(manifest.attempt.partialArtifacts.paths.includes('health.json'));
  assert.ok(manifest.attempt.partialArtifacts.paths.includes('metrics.json'));
  assert.ok(manifest.attempt.partialArtifacts.paths.includes('causal-run.json'));
  assert.ok(manifest.attempt.partialArtifacts.paths.includes('summary.md'));
  assert.ok(
    manifest.attempt.partialArtifacts.paths.some((artifactPath: string) => artifactPath.startsWith('raw/')),
  );
});

test('profile-ios derives storage capture waits from scenario execution windows', () => {
  const startup = readJson(fixturePath('examples/mobile-app/scenarios/mobile/app-startup.json'));
  const openClose = readJson(fixturePath('examples/mobile-app/scenarios/mobile/open-close-cycle.json'));
  const scroll = readJson(fixturePath('examples/mobile-app/scenarios/mobile/scroll-settle.json'));
  const commandHeavyCycle = {
    id: 'command-heavy-cycle',
    defaultIterations: 6,
    cycles: {
      setupStepIds: ['reset-surface'],
      bodyStepIds: ['open-panel', 'close-panel'],
    },
    milestones: [
      { id: 'ready', event: 'surface_ready' },
      { id: 'opened', event: 'panel_opened' },
      { id: 'closed', event: 'panel_closed' },
    ],
    steps: [
      {
        id: 'reset-surface',
        kind: 'command',
        command: 'reset-surface',
        adapterOptions: {
          iosSimctl: {
            waitMs: 500,
          },
        },
      },
      { id: 'wait-ready', kind: 'waitForMilestone', milestone: 'ready', timeoutMs: 4000 },
      {
        id: 'open-panel',
        kind: 'command',
        command: 'open-panel',
        adapterOptions: {
          iosSimctl: {
            waitMs: 300,
          },
        },
      },
      { id: 'wait-opened', kind: 'waitForMilestone', milestone: 'opened', timeoutMs: 7000 },
      {
        id: 'close-panel',
        kind: 'command',
        command: 'close-panel',
        adapterOptions: {
          iosSimctl: {
            waitMs: 400,
          },
        },
      },
      { id: 'wait-closed', kind: 'waitForMilestone', milestone: 'closed', timeoutMs: 9000 },
    ],
  };

  assert.equal(deriveProfileSessionCaptureWaitMs(startup), 11000);
  assert.equal(deriveProfileSessionCaptureWaitMs(openClose), 22960);
  assert.equal(deriveProfileSessionCaptureWaitMs(scroll), 12150);
  assert.equal(resolveIosSimctlProfileCommands(commandHeavyCycle).length, 13);
  assert.equal(deriveProfileSessionCaptureWaitMs(commandHeavyCycle), 130540);
  assert.ok(deriveProfileSessionCaptureWaitMs(commandHeavyCycle) > 30000);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: { 'wait-ms': '25' },
    profileSessionEnabled: true,
    scenario: commandHeavyCycle,
  }), 25);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: {},
    profileSessionEnabled: false,
    scenario: commandHeavyCycle,
  }), 0);
});

test('profile-ios derives simctl commands from scenario adapter metadata', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/ios/open-close-cycle.json'));

  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 1, waitMs: 300 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 2, waitMs: 300 },
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 3, waitMs: 300 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 4, waitMs: 300 },
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 5, waitMs: 300 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 6, waitMs: 300 },
  ]);

  delete scenario.adapterOptions;
  scenario.defaultIterations = 2;
  scenario.steps = [
    {
      id: 'open-card',
      kind: 'command',
      command: 'activate-target:example-card-1',
      adapterOptions: {
        iosSimctl: {
          waitMs: 125,
        },
      },
    },
    {
      id: 'wait-opened',
      kind: 'waitForMilestone',
      milestone: 'card_opened',
      timeoutMs: 1500,
    },
    {
      id: 'close-card',
      kind: 'command',
      command: 'activate-target:close-card',
      timeoutMs: 225,
    },
  ];
  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', commandId: 'open-card', label: 'open-card', queueId: 'open-close-cycle', sequence: 1, waitForMilestone: 'card_opened', waitMs: 125, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close-card', label: 'close-card', queueId: 'open-close-cycle', sequence: 2, waitMs: 225 },
    { command: 'activate-target:example-card-1', commandId: 'open-card', label: 'open-card', queueId: 'open-close-cycle', sequence: 3, waitForMilestone: 'card_opened', waitMs: 125, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close-card', label: 'close-card', queueId: 'open-close-cycle', sequence: 4, waitMs: 225 },
  ]);
});

test('profile-ios runs readiness setup commands once before repeated cycle commands', () => {
  const scenario = {
    id: 'ready-scroll-cycle',
    defaultIterations: 3,
    truthEvents: {
      ready: { event: 'surface_ready' },
    },
    milestones: [
      { id: 'ready', event: 'surface_ready', phase: 'render' },
      { id: 'settled', event: 'surface_settled', phase: 'completion' },
    ],
    steps: [
      { id: 'reset-surface', kind: 'command', command: 'reset-surface' },
      { id: 'wait-ready', kind: 'waitForMilestone', milestone: 'ready', timeoutMs: 120000 },
      { id: 'scroll-surface', kind: 'command', command: 'scroll-by:600' },
      { id: 'wait-settled', kind: 'waitForMilestone', milestone: 'settled', timeoutMs: 8000 },
    ],
  };

  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'reset-surface', commandId: 'reset-surface', label: 'reset-surface', queueId: 'ready-scroll-cycle', sequence: 1, waitForMilestone: 'surface_ready', waitMs: 0, waitTimeoutMs: 120000 },
    { command: 'scroll-by:600', commandId: 'scroll-surface', label: 'scroll-surface', queueId: 'ready-scroll-cycle', sequence: 2, waitForMilestone: 'surface_settled', waitMs: 0, waitTimeoutMs: 8000 },
    { command: 'scroll-by:600', commandId: 'scroll-surface', label: 'scroll-surface', queueId: 'ready-scroll-cycle', sequence: 3, waitForMilestone: 'surface_settled', waitMs: 0, waitTimeoutMs: 8000 },
    { command: 'scroll-by:600', commandId: 'scroll-surface', label: 'scroll-surface', queueId: 'ready-scroll-cycle', sequence: 4, waitForMilestone: 'surface_settled', waitMs: 0, waitTimeoutMs: 8000 },
  ]);
});

test('profile-ios runs leading non-measured setup commands once before repeated cycle commands', () => {
  const scenario = {
    id: 'account-drawer-stress',
    defaultIterations: 3,
    truthEvents: {
      opened: { event: 'account_drawer_open_settled' },
      closed: { event: 'account_drawer_close_settled' },
    },
    milestones: [
      { id: 'opened', event: 'account_drawer_open_settled', phase: 'visual' },
      { id: 'closed', event: 'account_drawer_close_settled', phase: 'visual' },
    ],
    budgets: [
      { name: 'open p95', source: 'milestone', metric: 'p95', unit: 'ms', limit: 900, toMilestone: 'opened' },
      { name: 'close p95', source: 'milestone', metric: 'p95', unit: 'ms', limit: 900, toMilestone: 'closed' },
    ],
    steps: [
      { id: 'reset-home-surface', kind: 'command', command: 'reset-home-surface' },
      { id: 'open-account-drawer', kind: 'command', command: 'open-account-drawer' },
      { id: 'wait-for-open-settle', kind: 'waitForMilestone', milestone: 'opened', timeoutMs: 10000 },
      { id: 'close-account-drawer', kind: 'command', command: 'activate-target:account-drawer-close' },
      { id: 'wait-for-close-settle', kind: 'waitForMilestone', milestone: 'closed', timeoutMs: 10000 },
    ],
  };

  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'reset-home-surface', commandId: 'reset-home-surface', label: 'reset-home-surface', queueId: 'account-drawer-stress', sequence: 1, waitMs: 0 },
    { command: 'open-account-drawer', commandId: 'open-account-drawer', label: 'open-account-drawer', queueId: 'account-drawer-stress', sequence: 2, waitForMilestone: 'account_drawer_open_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'activate-target:account-drawer-close', commandId: 'close-account-drawer', label: 'close-account-drawer', queueId: 'account-drawer-stress', sequence: 3, waitForMilestone: 'account_drawer_close_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'open-account-drawer', commandId: 'open-account-drawer', label: 'open-account-drawer', queueId: 'account-drawer-stress', sequence: 4, waitForMilestone: 'account_drawer_open_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'activate-target:account-drawer-close', commandId: 'close-account-drawer', label: 'close-account-drawer', queueId: 'account-drawer-stress', sequence: 5, waitForMilestone: 'account_drawer_close_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'open-account-drawer', commandId: 'open-account-drawer', label: 'open-account-drawer', queueId: 'account-drawer-stress', sequence: 6, waitForMilestone: 'account_drawer_open_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'activate-target:account-drawer-close', commandId: 'close-account-drawer', label: 'close-account-drawer', queueId: 'account-drawer-stress', sequence: 7, waitForMilestone: 'account_drawer_close_settled', waitMs: 0, waitTimeoutMs: 10000 },
  ]);
});

test('profile-ios honors explicit cycle body step ids', () => {
  const scenario = {
    id: 'explicit-body-cycle',
    defaultIterations: 2,
    cycles: {
      bodyStepIds: ['open-surface', 'close-surface'],
    },
    milestones: [
      { id: 'opened', event: 'surface_opened' },
      { id: 'closed', event: 'surface_closed' },
    ],
    steps: [
      { id: 'reset-surface', kind: 'command', command: 'reset-surface' },
      { id: 'open-surface', kind: 'command', command: 'open-surface' },
      { id: 'wait-opened', kind: 'waitForMilestone', milestone: 'opened', timeoutMs: 1000 },
      { id: 'close-surface', kind: 'command', command: 'close-surface' },
      { id: 'wait-closed', kind: 'waitForMilestone', milestone: 'closed', timeoutMs: 1000 },
    ],
  };

  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'reset-surface', commandId: 'reset-surface', label: 'reset-surface', queueId: 'explicit-body-cycle', sequence: 1, waitMs: 0 },
    { command: 'open-surface', commandId: 'open-surface', label: 'open-surface', queueId: 'explicit-body-cycle', sequence: 2, waitForMilestone: 'surface_opened', waitMs: 0, waitTimeoutMs: 1000 },
    { command: 'close-surface', commandId: 'close-surface', label: 'close-surface', queueId: 'explicit-body-cycle', sequence: 3, waitForMilestone: 'surface_closed', waitMs: 0, waitTimeoutMs: 1000 },
    { command: 'open-surface', commandId: 'open-surface', label: 'open-surface', queueId: 'explicit-body-cycle', sequence: 4, waitForMilestone: 'surface_opened', waitMs: 0, waitTimeoutMs: 1000 },
    { command: 'close-surface', commandId: 'close-surface', label: 'close-surface', queueId: 'explicit-body-cycle', sequence: 5, waitForMilestone: 'surface_closed', waitMs: 0, waitTimeoutMs: 1000 },
  ]);
});

test('profile-ios applies execution-plan wait gates to simctl adapter commands', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/ios/open-close-cycle.json'));
  scenario.defaultIterations = 2;
  scenario.adapterOptions.iosSimctl.repeat = 2;
  scenario.adapterOptions.iosSimctl.commands = [
    {
      command: 'activate-target:example-card-1',
      label: 'open first example card',
      waitMs: 300,
    },
    {
      command: 'activate-target:close-card',
      label: 'close example card',
      waitMs: 300,
    },
  ];
  scenario.milestones = [
    { id: 'ready', event: 'card_opened' },
    { id: 'dismissed', event: 'card_dismissed' },
  ];
  scenario.steps = [
    {
      id: 'open-card',
      kind: 'command',
      command: 'activate-target:example-card-1',
    },
    {
      id: 'wait-opened',
      kind: 'waitForMilestone',
      milestone: 'ready',
      timeoutMs: 1500,
    },
    {
      id: 'close-card',
      kind: 'command',
      command: 'activate-target:close-card',
    },
    {
      id: 'wait-dismissed',
      kind: 'waitForMilestone',
      milestone: 'dismissed',
      timeoutMs: 1200,
    },
  ];

  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 1, waitForMilestone: 'card_opened', waitMs: 300, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 2, waitForMilestone: 'card_dismissed', waitMs: 300, waitTimeoutMs: 1200 },
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 3, waitForMilestone: 'card_opened', waitMs: 300, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 4, waitForMilestone: 'card_dismissed', waitMs: 300, waitTimeoutMs: 1200 },
  ]);
});
