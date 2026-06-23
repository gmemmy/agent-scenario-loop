const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const PROFILE_ANDROID = path.join(DIST_ROOT, 'runner', 'profile-android.js');
const {
  deriveProfileSessionCaptureWaitMs,
  deriveProfileSessionLogcatLines,
  resolveAndroidAdbDriverSteps,
  resolveAndroidAdbProfileCommands,
  resolveProfileSessionCaptureWaitMs,
  runProfileAndroid,
  validateAndroidAdbDriverSteps,
} = require('../profile-android');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;

function unknownLifecycleAssertion() {
  return {
    evidence: 'not-asserted',
    value: 'unknown',
  };
}

function sampleEnvironmentLifecycle() {
  return {
    postconditions: {
      appState: unknownLifecycleAssertion(),
      artifactState: unknownLifecycleAssertion(),
      lifecyclePhase: unknownLifecycleAssertion(),
      cleanupState: unknownLifecycleAssertion(),
      dataState: unknownLifecycleAssertion(),
    },
    preconditions: {
      animations: unknownLifecycleAssertion(),
      appDataState: unknownLifecycleAssertion(),
      authState: unknownLifecycleAssertion(),
      deviceLockState: unknownLifecycleAssertion(),
      fontScale: unknownLifecycleAssertion(),
      foregroundState: unknownLifecycleAssertion(),
      lifecyclePhase: unknownLifecycleAssertion(),
      initialRoute: unknownLifecycleAssertion(),
      installedState: unknownLifecycleAssertion(),
      locale: unknownLifecycleAssertion(),
      networkState: unknownLifecycleAssertion(),
      orientation: unknownLifecycleAssertion(),
      permissions: unknownLifecycleAssertion(),
      theme: unknownLifecycleAssertion(),
      timezone: unknownLifecycleAssertion(),
    },
  };
}

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
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Hashes a fixture file for provider attachment assertions.
 *
 * @param {string} filePath
 * @returns {string}
 */
function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Creates a fake adb executor from argument-keyed responses.
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

test('profile-android writes artifacts from fixture event logs', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--out',
    artifactRoot,
    '--run-id',
    'android-example-startup',
  ], {
    env: {
      ...process.env,
      ASL_GIT_SHA: 'abc123profilemanifest',
    },
  });

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json')) as Record<string, any>;
  const runPlan = readJson(path.join(runDir, 'run-plan.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json'));
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const agentSummary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');
  const profileSummary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');

  assert.equal(runDir, path.join(artifactRoot, 'app-startup', 'android-example-startup'));
  assert.deepEqual(runPlan, {
    artifactVersion: '1.0.0',
    runId: 'android-example-startup',
    scenarioId: 'app-startup',
    scenarioHash: manifest.scenarioHash,
    platform: 'android',
    inputMode: 'fixture-event-log',
    artifactRoot,
    runDir,
    interactionDriver: 'fixture-log-ingest',
    expectedIterations: 1,
    milestoneEventsPerIteration: 1,
    commandTransport: 'fixture-log-ingest',
    providers: [],
    requestedDiagnostics: {
      required: [],
      optional: [],
    },
    scenarioShape: {
      budgets: 0,
      steps: 0,
      stepKinds: [],
      waitForMilestones: [],
    },
    evidenceSources: {
      events: 'examples/mobile-app/event-logs/android-app-startup.log',
      adbCapture: false,
      simctlCapture: false,
      signals: 0,
      captures: 0,
    },
  });
  assert.equal(manifest.platform, 'android');
  assert.equal(typeof manifest.scenarioHash, 'string');
  assert.match(manifest.scenarioHash, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.bundleId, 'dev.agentscenarioloop.example');
  assert.deepEqual(manifest.provenance, {
    cohort: {
      appId: 'dev.agentscenarioloop.example',
      commandTransport: 'fixture-log-ingest',
      platform: 'android',
      providers: [],
      runnerName: 'fixture-log-ingest',
      runnerVersion: manifest.provenance.cohort.runnerVersion,
    },
    cohortHash: manifest.provenance.cohortHash,
    gitSha: 'abc123profilemanifest',
    scenarioHash: manifest.scenarioHash,
    toolVersions: {
      node: process.version,
    },
  });
  assert.match(manifest.provenance.cohortHash, /^[a-f0-9]{64}$/u);
  assert.match(manifest.provenance.cohort.runnerVersion, /^\d+\.\d+\.\d+/u);
  assert.deepEqual(manifest.attempt, {
    attemptId: 'android-example-startup',
    attemptNumber: 1,
    classification: {
      category: 'none',
    },
    cleanup: {
      status: 'not-required',
    },
    durationMs: manifest.durationMs,
    endedAt: manifest.endedAt,
    interactionDriver: manifest.interactionDriver,
    maxAttempts: 1,
    partialArtifacts: {
      reason: 'complete successful run artifacts are present',
      valid: false,
    },
    runId: 'android-example-startup',
    startedAt: manifest.startedAt,
    status: 'passed',
    terminalState: 'passed',
  });
  assert.deepEqual(manifest.environment, {
    bundleId: 'dev.agentscenarioloop.example',
    nodeVersion: process.version,
    platform: 'android',
    ...sampleEnvironmentLifecycle(),
    postconditions: {
      ...sampleEnvironmentLifecycle().postconditions,
      artifactState: {
        artifact: 'manifest.json',
        evidence: 'asserted',
        source: 'asl-profile-runner',
        value: 'complete',
      },
      cleanupState: {
        evidence: 'asserted',
        source: 'asl-profile-runner',
        value: 'not-required',
      },
    },
    runtimeTarget: manifest.simulator,
  });
  assert.deepEqual(causalRun.provenanceRef, {
    manifest: 'manifest.json',
    runId: 'android-example-startup',
    scenarioHash: manifest.scenarioHash,
  });
  assert.equal(health.healthStatus, 'passed', JSON.stringify(health, null, 2));
  assert.equal(verdict.verdictStatus, 'passed');
  assert.equal(manifest.artifacts.raw.interactionLog, 'raw/android-app-startup.log');
  assert.equal(manifest.artifacts.raw.deviceLog, 'raw/android-app-startup.log');
  assert.equal('video' in manifest.artifacts.captures, false);
  assert.equal('uiTree' in manifest.artifacts.captures, false);
  assert.equal('video' in (causalRun as Record<string, any>).artifacts, false);
  const diagnostics = manifest.artifacts.diagnostics as Array<Record<string, any>>;
  assert.deepEqual(diagnostics.find((entry) => entry.kind === 'logs'), {
    kind: 'logs',
    name: 'device-log',
    path: 'raw/android-app-startup.log',
    provider: 'fixture-log-ingest',
    reason: 'Device or fixture log evidence was available to the profile runner.',
    required: false,
    status: 'captured',
  });
  assert.equal(diagnostics.find((entry) => entry.kind === 'video')?.status, 'not_requested');
  assert.equal(diagnostics.find((entry) => entry.kind === 'video')?.required, false);
  assert.equal('path' in (diagnostics.find((entry) => entry.kind === 'video') ?? {}), false);
  assert.equal(diagnostics.find((entry) => entry.kind === 'uiTree')?.status, 'not_requested');
  assert.equal('path' in (diagnostics.find((entry) => entry.kind === 'uiTree') ?? {}), false);
  assert.match(profileSummary, /## Attempt/u);
  assert.match(profileSummary, /## Diagnostic inventory/u);
  assert.match(profileSummary, /Attempt number: 1\/1/u);
  assert.match(profileSummary, /Terminal state: passed/u);
  assert.match(agentSummary, /Scenario health passed/u);
});

test('profile-android treats optional diagnostic capabilities as requested inventory', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-optional-capability-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'app-startup-video-capability.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.optionalCapabilities = ['video'];
  delete scenario.artifacts;
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--out',
    artifactRoot,
    '--run-id',
    'android-example-startup',
  ]);

  const manifest = readJson(path.join(stdout.trim(), 'manifest.json')) as Record<string, any>;
  const videoDiagnostic = manifest.artifacts.diagnostics.find((entry: Record<string, unknown>) => entry.kind === 'video');

  assert.equal(videoDiagnostic.status, 'unavailable');
  assert.equal(videoDiagnostic.required, false);
  assert.equal('path' in videoDiagnostic, false);
  assert.match(videoDiagnostic.nextAction, /capture provider/u);
});

test('profile-android profiles public scenario ids and milestone budgets', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-public-scenario-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'public-journey.json');
  const eventLogPath = path.join(tempRoot, 'public-journey-android.log');
  const scenario = readJson(fixturePath('templates/mobile-scenario.json')) as Record<string, unknown>;
  scenario.id = 'public-journey';
  scenario.flowId = 'public-journey';
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"public-journey-android","iteration":1,"atMs":0}',
      '2026-01-01T00:10:00.820Z public-android [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"public-journey-android","iteration":1,"atMs":820}',
      '2026-01-01T00:10:01.000Z public-android [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"public-journey-android","iteration":2,"atMs":1000}',
      '2026-01-01T00:10:01.870Z public-android [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"public-journey-android","iteration":2,"atMs":1870}',
      '2026-01-01T00:10:02.000Z public-android [profile-event] {"event":"first_journey_started","scenario":"public-journey","runId":"public-journey-android","iteration":3,"atMs":2000}',
      '2026-01-01T00:10:02.940Z public-android [profile-event] {"event":"first_journey_completed","scenario":"public-journey","runId":"public-journey-android","iteration":3,"atMs":2940}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'public-journey-android',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(runDir, path.join(artifactRoot, 'public-journey', 'public-journey-android'));
  assert.equal(metrics.scenario, 'public-journey');
  assert.equal(metrics.iterations, 3);
  assert.equal(metrics.failures, 0);
  assert.deepEqual(metrics.durationsMs, [820, 870, 940]);
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

test('profile-android treats readiness-to-completion budgets as repeated milestone cycles', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-ready-milestone-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'ready-scroll-cycle.json');
  const eventLogPath = path.join(tempRoot, 'ready-scroll-cycle-android.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'ready-scroll-cycle',
    flowId: 'ready-scroll-cycle',
    journey: {
      name: 'Ready scroll cycle',
      intent: 'Scroll a ready feed repeatedly.',
      actor: 'app user',
      startState: 'home',
      endState: 'home',
    },
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    truthEvents: {
      ready: { event: 'surface_ready', required: true, timeoutMs: 120000, phase: 'render' },
      settled: { event: 'surface_settled', required: true, timeoutMs: 8000, phase: 'completion' },
    },
    milestones: [
      { id: 'ready', event: 'surface_ready', required: true, phase: 'render' },
      { id: 'settled', event: 'surface_settled', required: true, phase: 'completion' },
    ],
    expectedEvents: ['surface_ready', 'surface_settled'],
    cycles: { iterations: 3, warmupIterations: 0, stopOnFailure: true },
    budgets: [
      {
        name: 'cycle p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 10000,
        fromMilestone: 'ready',
        toMilestone: 'settled',
      },
      {
        name: 'failures',
        source: 'milestone',
        metric: 'failures',
        unit: 'count',
        limit: 0,
      },
    ],
    steps: [{ id: 'launch', kind: 'launch' }],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"surface_ready","scenario":"ready-scroll-cycle","runId":"ready-scroll-cycle-android","atMs":1000}',
      '2026-01-01T00:10:00.200Z public-android [profile-event] {"event":"surface_settled","scenario":"ready-scroll-cycle","runId":"ready-scroll-cycle-android","atMs":1200}',
      '2026-01-01T00:10:00.500Z public-android [profile-event] {"event":"surface_settled","scenario":"ready-scroll-cycle","runId":"ready-scroll-cycle-android","atMs":1500}',
      '2026-01-01T00:10:00.900Z public-android [profile-event] {"event":"surface_settled","scenario":"ready-scroll-cycle","runId":"ready-scroll-cycle-android","atMs":1900}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'ready-scroll-cycle-android',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, []);
  assert.equal(metrics.failures, 0);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(causalRun.iterationSummary, {
    completed: 3,
    expected: 3,
    failed: 0,
    incomplete: [],
    status: 'complete',
    timeouts: 0,
  });
});

test('profile-android associates repeated interval milestones without iteration payloads', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-implicit-interval-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'scroll-interval-cycle.json');
  const eventLogPath = path.join(tempRoot, 'scroll-interval-cycle-android.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'scroll-interval-cycle',
    flowId: 'scroll-interval-cycle',
    journey: {
      name: 'Scroll interval cycle',
      intent: 'Measure repeated request-to-settle scroll intervals.',
      actor: 'app user',
      startState: 'surface ready',
      endState: 'surface settled',
    },
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    truthEvents: {
      ready: { event: 'surface_ready', required: true, timeoutMs: 120000, phase: 'render' },
      requested: { event: 'surface_scroll_requested', required: true, timeoutMs: 5000, phase: 'intent' },
      settled: { event: 'surface_scroll_settled', required: true, timeoutMs: 8000, phase: 'completion' },
    },
    milestones: [
      { id: 'ready', event: 'surface_ready', required: true, phase: 'render' },
      { id: 'requested', event: 'surface_scroll_requested', required: true, phase: 'intent' },
      { id: 'settled', event: 'surface_scroll_settled', required: true, phase: 'completion' },
    ],
    expectedEvents: ['surface_ready', 'surface_scroll_requested', 'surface_scroll_settled'],
    cycles: { iterations: 3, warmupIterations: 0, stopOnFailure: true },
    budgets: [
      {
        name: 'scroll settle p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 1000,
        fromMilestone: 'requested',
        toMilestone: 'settled',
      },
      {
        name: 'failures',
        source: 'milestone',
        metric: 'failures',
        unit: 'count',
        limit: 0,
      },
    ],
    steps: [
      { id: 'launch', kind: 'launch' },
      { id: 'wait-ready', kind: 'waitForMilestone', milestone: 'ready', timeoutMs: 120000 },
      { id: 'scroll-surface', kind: 'command', command: 'scroll-by:600' },
      { id: 'wait-scroll-settle', kind: 'waitForMilestone', milestone: 'settled', timeoutMs: 8000 },
    ],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"surface_ready","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":1000}',
      '2026-01-01T00:10:00.200Z public-android [profile-event] {"event":"surface_scroll_requested","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":1200}',
      '2026-01-01T00:10:00.520Z public-android [profile-event] {"event":"surface_scroll_settled","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":1520}',
      '2026-01-01T00:10:01.000Z public-android [profile-event] {"event":"surface_scroll_requested","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":2000}',
      '2026-01-01T00:10:01.410Z public-android [profile-event] {"event":"surface_scroll_settled","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":2410}',
      '2026-01-01T00:10:02.000Z public-android [profile-event] {"event":"surface_scroll_requested","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":3000}',
      '2026-01-01T00:10:02.360Z public-android [profile-event] {"event":"surface_scroll_settled","scenario":"scroll-interval-cycle","runId":"scroll-interval-cycle-android","atMs":3360}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'scroll-interval-cycle-android',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, [320, 410, 360]);
  assert.equal(metrics.p95Ms, 410);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(metrics.failures, 0);
  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(causalRun.iterationSummary, {
    completed: 3,
    expected: 3,
    failed: 0,
    incomplete: [],
    status: 'complete',
    timeouts: 0,
  });
});

test('profile-android treats unmeasurable milestone latency budgets as partial evidence', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-unmeasurable-budget-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'completion-only-budget.json');
  const eventLogPath = path.join(tempRoot, 'completion-only-budget.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'completion-only-budget',
    flowId: 'completion-only-budget',
    journey: {
      name: 'Completion-only budget',
      intent: 'Show that completion-only evidence does not imply transition latency.',
      actor: 'runner',
      startState: 'home',
      endState: 'home',
    },
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'logCapture', 'artifactWrite'],
    truthEvents: {
      settled: { event: 'surface_settled', required: true, timeoutMs: 8000, phase: 'completion' },
    },
    milestones: [
      { id: 'settled', event: 'surface_settled', required: true, phase: 'completion' },
    ],
    expectedEvents: ['surface_settled'],
    cycles: { iterations: 3, warmupIterations: 0, stopOnFailure: true },
    budgets: [
      { name: 'cycle p95', source: 'milestone', metric: 'p95', unit: 'ms', limit: 1000, toMilestone: 'settled' },
      { name: 'failures', source: 'milestone', metric: 'failures', unit: 'count', limit: 0 },
    ],
    steps: [{ id: 'launch', kind: 'launch' }],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.200Z public-android [profile-event] {"event":"surface_settled","scenario":"completion-only-budget","runId":"completion-only-budget-android","atMs":1200}',
      '2026-01-01T00:10:00.900Z public-android [profile-event] {"event":"surface_settled","scenario":"completion-only-budget","runId":"completion-only-budget-android","atMs":1900}',
      '2026-01-01T00:10:01.600Z public-android [profile-event] {"event":"surface_settled","scenario":"completion-only-budget","runId":"completion-only-budget-android","atMs":2600}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'completion-only-budget-android',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const budgetVerdict = readJson(path.join(runDir, 'budget-verdict.json')) as Record<string, any>;
  const summary = await fsp.readFile(path.join(runDir, 'summary.md'), 'utf8');

  assert.equal(metrics.status, 'passed');
  assert.equal(metrics.budgetEvaluation.status, 'partial');
  assert.deepEqual(metrics.budgetEvaluation.failedChecks, []);
  assert.deepEqual(metrics.budgetEvaluation.unmeasurableChecks, ['cycle p95']);
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(budgetVerdict.status, 'partial');
  assert.match(summary, /- Status: partial/u);
  assert.deepEqual(
    verdict.budgetChecks.find((check: Record<string, unknown>) => check.name === 'cycle p95'),
    {
      actual: null,
      expected: 1000,
      metric: 'milestone budget',
      name: 'cycle p95',
      notes: 'No latency samples were available for this budget. Use explicit interval anchors when the claim is transition latency.',
      pass: false,
      source: 'milestone',
      status: 'unmeasurable',
      unit: 'ms',
    },
  );
});

test('profile-android accounts for multi-command repeated milestone cycle bodies', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-multi-command-cycle-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'scope-switch-cycle.json');
  const eventLogPath = path.join(tempRoot, 'scope-switch-cycle-android.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'scope-switch-cycle',
    flowId: 'scope-switch-cycle',
    journey: {
      name: 'Scope switch cycle',
      intent: 'Switch between three feed scopes repeatedly.',
      actor: 'app user',
      startState: 'home',
      endState: 'home',
    },
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    truthEvents: {
      ready: { event: 'surface_ready', required: true, timeoutMs: 120000, phase: 'render' },
      settled: { event: 'surface_settled', required: true, timeoutMs: 8000, phase: 'completion' },
    },
    milestones: [
      { id: 'ready', event: 'surface_ready', required: true, phase: 'render' },
      { id: 'settled', event: 'surface_settled', required: true, phase: 'completion' },
    ],
    expectedEvents: ['surface_ready', 'surface_settled'],
    cycles: {
      iterations: 2,
      warmupIterations: 0,
      stopOnFailure: true,
      bodyStepIds: ['switch-a', 'switch-b', 'switch-c'],
    },
    budgets: [
      {
        name: 'cycle p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 30000,
        fromMilestone: 'ready',
        toMilestone: 'settled',
      },
      {
        name: 'failures',
        source: 'milestone',
        metric: 'failures',
        unit: 'count',
        limit: 0,
      },
    ],
    steps: [
      { id: 'wait-ready', kind: 'waitForMilestone', milestone: 'ready', timeoutMs: 120000 },
      { id: 'switch-a', kind: 'command', command: 'switch:a' },
      { id: 'wait-a', kind: 'waitForMilestone', milestone: 'settled', timeoutMs: 8000 },
      { id: 'switch-b', kind: 'command', command: 'switch:b' },
      { id: 'wait-b', kind: 'waitForMilestone', milestone: 'settled', timeoutMs: 8000 },
      { id: 'switch-c', kind: 'command', command: 'switch:c' },
      { id: 'wait-c', kind: 'waitForMilestone', milestone: 'settled', timeoutMs: 8000 },
    ],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"surface_ready","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":1000}',
      '2026-01-01T00:10:00.200Z public-android [profile-event] {"event":"surface_settled","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":1200}',
      '2026-01-01T00:10:00.900Z public-android [profile-event] {"event":"surface_settled","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":1900}',
      '2026-01-01T00:10:01.600Z public-android [profile-event] {"event":"surface_settled","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":2600}',
      '2026-01-01T00:10:02.300Z public-android [profile-event] {"event":"surface_settled","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":3300}',
      '2026-01-01T00:10:03.000Z public-android [profile-event] {"event":"surface_settled","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":4000}',
      '2026-01-01T00:10:03.700Z public-android [profile-event] {"event":"surface_settled","scenario":"scope-switch-cycle","runId":"scope-switch-cycle-android","atMs":4700}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'scope-switch-cycle-android',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(metrics.status, 'passed');
  assert.deepEqual(metrics.durationsMs, []);
  assert.equal(metrics.failures, 0);
  assert.deepEqual(metrics.incompleteIterations, []);
  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(causalRun.iterationSummary, {
    completed: 2,
    expected: 2,
    failed: 0,
    incomplete: [],
    status: 'complete',
    timeouts: 0,
  });
});

test('profile-android preserves app timeline vocabulary without breaking causal-run schema', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-causal-vocab-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const eventLogPath = path.join(tempRoot, 'invalid-vocabulary-android.log');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"first_journey_started","scenario":"first-journey","runId":"invalid-vocabulary-android","iteration":1,"atMs":0,"phase":"capture","status":"passed"}',
      '2026-01-01T00:10:00.820Z public-android [profile-event] {"event":"first_journey_completed","scenario":"first-journey","runId":"invalid-vocabulary-android","iteration":1,"atMs":820}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('templates/mobile-scenario.json'),
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'invalid-vocabulary-android',
  ]);

  const runDir = stdout.trim();
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(causalRun.timeline[0].phase, 'domain');
  assert.equal(causalRun.timeline[0].status, 'observed');
  assert.equal(causalRun.timeline[0].metadata.appPhase, 'capture');
  assert.equal(causalRun.timeline[0].metadata.appStatus, 'passed');
});

test('profile-android writes partial iteration accounting for incomplete repeated cycles', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-partial-iterations-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'portable-open-close-partial.json');
  const eventLogPath = path.join(tempRoot, 'portable-open-close-partial-android.log');
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
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"surface_open_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":1,"atMs":0,"sequence":1,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:00.120Z public-android [profile-event] {"event":"surface_opened","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":1,"atMs":120,"sequence":1,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:00.220Z public-android [profile-event] {"event":"surface_close_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":1,"atMs":220,"sequence":2,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:00.340Z public-android [profile-event] {"event":"surface_dismissed","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":1,"atMs":340,"sequence":2,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:01.000Z public-android [profile-event] {"event":"surface_open_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":2,"atMs":1000,"sequence":3,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:01.140Z public-android [profile-event] {"event":"surface_opened","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":2,"atMs":1140,"sequence":3,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.000Z public-android [profile-event] {"event":"surface_open_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":3,"atMs":2000,"sequence":5,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.130Z public-android [profile-event] {"event":"surface_opened","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":3,"atMs":2130,"sequence":5,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.260Z public-android [profile-event] {"event":"surface_close_requested","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":3,"atMs":2260,"sequence":6,"queueId":"portable-open-close-partial"}',
      '2026-01-01T00:10:02.390Z public-android [profile-event] {"event":"surface_dismissed","scenario":"portable-open-close-partial","runId":"partial-iterations-android","iteration":3,"atMs":2390,"sequence":6,"queueId":"portable-open-close-partial"}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'partial-iterations-android',
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

test('profile-android reports schema-era open and close interval budgets', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-open-close-budget-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'portable-open-close.json');
  const eventLogPath = path.join(tempRoot, 'portable-open-close-android.log');
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
      '2026-01-01T00:10:00.000Z public-android [profile-event] {"event":"card_open_requested","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":1,"atMs":0}',
      '2026-01-01T00:10:00.120Z public-android [profile-event] {"event":"card_opened","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":1,"atMs":120}',
      '2026-01-01T00:10:00.420Z public-android [profile-event] {"event":"card_close_requested","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":1,"atMs":420}',
      '2026-01-01T00:10:00.500Z public-android [profile-event] {"event":"card_dismissed","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":1,"atMs":500}',
      '2026-01-01T00:10:01.000Z public-android [profile-event] {"event":"card_open_requested","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":2,"atMs":1000}',
      '2026-01-01T00:10:01.130Z public-android [profile-event] {"event":"card_opened","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":2,"atMs":1130}',
      '2026-01-01T00:10:01.430Z public-android [profile-event] {"event":"card_close_requested","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":2,"atMs":1430}',
      '2026-01-01T00:10:01.520Z public-android [profile-event] {"event":"card_dismissed","scenario":"portable-open-close","runId":"portable-open-close-android","iteration":2,"atMs":1520}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'portable-open-close-android',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.deepEqual(metrics.durationsMs, [500, 520]);
  assert.deepEqual(metrics.openDurationsMs, [120, 130]);
  assert.deepEqual(metrics.closeDurationsMs, [80, 90]);
  assert.equal(metrics.budgetEvaluation.pass, true);
  assert.deepEqual(metrics.budgetEvaluation.checks, [
    { actual: 130, limit: 200, name: 'open p95', pass: true, unit: 'ms' },
    { actual: 90, limit: 120, name: 'close p95', pass: true, unit: 'ms' },
  ]);
  assert.deepEqual(causalRun.budgets, {
  });
});

test('profile-android keeps intent interval anchors separate from completion health', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-interval-anchor-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'intent-anchor-cycle.json');
  const eventLogPath = path.join(tempRoot, 'intent-anchor-cycle-android.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'intent-anchor-cycle',
    flowId: 'intent-anchor-cycle',
    journey: {
      name: 'Intent anchor cycle',
      intent: 'Measure request-to-settle duration while completion truth owns health.',
      actor: 'app user',
      startState: 'home',
      endState: 'home',
    },
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    milestones: [
      { id: 'request', event: 'surface_request_completed', required: false, phase: 'intent' },
      { id: 'settled', event: 'surface_settled', required: true, phase: 'completion' },
    ],
    expectedEvents: ['surface_settled'],
    cycles: { iterations: 2, warmupIterations: 0, stopOnFailure: true },
    budgets: [
      {
        name: 'request to settled p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 300,
        fromMilestone: 'request',
        toMilestone: 'settled',
      },
      {
        name: 'failures',
        source: 'milestone',
        metric: 'failures',
        unit: 'count',
        limit: 0,
      },
    ],
    steps: [{ id: 'launch', kind: 'launch' }],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:01.200Z public-android [profile-event] {"event":"surface_request_completed","scenario":"intent-anchor-cycle","runId":"intent-anchor-cycle-android","atMs":1200}',
      '2026-01-01T00:10:01.440Z public-android [profile-event] {"event":"surface_settled","scenario":"intent-anchor-cycle","runId":"intent-anchor-cycle-android","atMs":1440}',
      '2026-01-01T00:10:02.600Z public-android [profile-event] {"event":"surface_request_completed","scenario":"intent-anchor-cycle","runId":"intent-anchor-cycle-android","atMs":2600}',
      '2026-01-01T00:10:02.870Z public-android [profile-event] {"event":"surface_settled","scenario":"intent-anchor-cycle","runId":"intent-anchor-cycle-android","atMs":2870}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'intent-anchor-cycle-android',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  assert.deepEqual(metrics.durationsMs, []);
  assert.equal(metrics.budgetEvaluation.pass, true);
  assert.deepEqual(metrics.budgetEvaluation.checks, [
    { actual: 0, limit: 0, name: 'failures', pass: true, unit: 'count' },
    { actual: 270, limit: 300, name: 'request to settled p95', pass: true, unit: 'ms' },
  ]);
  assert.deepEqual(causalRun.iterationSummary, {
    completed: 2,
    expected: 2,
    failed: 0,
    incomplete: [],
    status: 'complete',
    timeouts: 0,
  });
});

test('profile-android reports required named interval budgets without collapsing to cycle p95', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-required-interval-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'artifacts');
  const scenarioPath = path.join(tempRoot, 'required-interval-cycle.json');
  const eventLogPath = path.join(tempRoot, 'required-interval-cycle-android.log');
  const scenario = {
    schemaVersion: '1.0.0',
    id: 'required-interval-cycle',
    flowId: 'required-interval-cycle',
    journey: {
      name: 'Required interval cycle',
      intent: 'Measure a named target-to-open interval while completion truth owns health.',
      actor: 'app user',
      startState: 'home',
      endState: 'home',
    },
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    milestones: [
      { id: 'mediaTargetReady', event: 'media_target_ready', required: true, phase: 'completion' },
      { id: 'opened', event: 'media_viewer_opened', required: true, phase: 'completion' },
      { id: 'dismissed', event: 'media_viewer_dismissed', required: true, phase: 'completion' },
    ],
    expectedEvents: ['media_target_ready', 'media_viewer_opened', 'media_viewer_dismissed'],
    cycles: { iterations: 2, warmupIterations: 0, stopOnFailure: true },
    budgets: [
      {
        name: 'media viewer open p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 300,
        fromMilestone: 'mediaTargetReady',
        toMilestone: 'opened',
      },
      {
        name: 'media viewer close p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 200,
        fromMilestone: 'opened',
        toMilestone: 'dismissed',
      },
      {
        name: 'failures',
        source: 'milestone',
        metric: 'failures',
        unit: 'count',
        limit: 0,
      },
    ],
    steps: [{ id: 'launch', kind: 'launch' }],
    artifacts: { required: ['logs'], optional: [] },
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  await fsp.writeFile(
    eventLogPath,
    [
      '2026-01-01T00:10:10.000Z public-android [profile-event] {"event":"media_target_ready","scenario":"required-interval-cycle","runId":"required-interval-cycle-android","atMs":10000}',
      '2026-01-01T00:10:10.180Z public-android [profile-event] {"event":"media_viewer_opened","scenario":"required-interval-cycle","runId":"required-interval-cycle-android","atMs":10180}',
      '2026-01-01T00:10:10.300Z public-android [profile-event] {"event":"media_viewer_dismissed","scenario":"required-interval-cycle","runId":"required-interval-cycle-android","atMs":10300}',
      '2026-01-01T00:10:20.000Z public-android [profile-event] {"event":"media_target_ready","scenario":"required-interval-cycle","runId":"required-interval-cycle-android","atMs":20000}',
      '2026-01-01T00:10:20.240Z public-android [profile-event] {"event":"media_viewer_opened","scenario":"required-interval-cycle","runId":"required-interval-cycle-android","atMs":20240}',
      '2026-01-01T00:10:20.390Z public-android [profile-event] {"event":"media_viewer_dismissed","scenario":"required-interval-cycle","runId":"required-interval-cycle-android","atMs":20390}',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--events',
    eventLogPath,
    '--out',
    artifactRoot,
    '--run-id',
    'required-interval-cycle-android',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const causalRun = readJson(path.join(runDir, 'causal-run.json')) as Record<string, any>;

  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  assert.deepEqual(metrics.budgetEvaluation.checks, [
    { actual: 0, limit: 0, name: 'failures', pass: true, unit: 'count' },
    { actual: 240, limit: 300, name: 'media viewer open p95', pass: true, unit: 'ms' },
    { actual: 150, limit: 200, name: 'media viewer close p95', pass: true, unit: 'ms' },
  ]);
  assert.deepEqual(
    verdict.budgetChecks.map((check: Record<string, unknown>) => check.name),
    ['failures', 'media viewer open p95', 'media viewer close p95'],
  );
  assert.equal(
    verdict.budgetChecks.some((check: Record<string, unknown>) => check.name === 'cycle p95'),
    false,
  );
  assert.deepEqual(causalRun.budgets, {
    failures: { limit: 0, metric: 'failures', unit: 'count' },
  });
});

test('profile-android attaches agent-device capture artifacts with explicit event logs', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-agent-device-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });
  const scenarioPath = path.join(artifactRoot, 'app-startup-agent-device.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.steps = [
    {
      id: 'capture-agent-device-screenshot',
      kind: 'captureEvidence',
      artifact: 'screenshot',
      driverAction: 'screenshot',
      adapterOptions: {
        agentDevice: {
          captureFileName: 'android-agent-device-final.png',
          rawFileName: 'android-agent-device-final.txt',
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

  const result = await runProfileAndroid({
    config: fixturePath('examples/mobile-app/asl.config.json'),
    scenario: scenarioPath,
    events: fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    out: artifactRoot,
    'run-id': 'android-agent-device-profile',
    'agent-device-capture': true,
    serial: 'emulator-5554',
    'agent-device-session': 'profile-android',
    'agent-device-session-mode': 'bind',
  }, { agentDeviceExecutor });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const agentDeviceMetadata = readJson(path.join(
    artifactRoot,
    '_agent-device-captures',
    'android-agent-device-profile',
    'raw',
    'agent-device-metadata.json',
  ));

  assert.deepEqual(calls, [
    `screenshot ${path.join(artifactRoot, '_agent-device-captures', 'android-agent-device-profile', 'captures', 'android-agent-device-final.png')} --platform android --target mobile --serial emulator-5554 --session profile-android --json`,
  ]);
  assert.equal(manifest.interactionDriver, 'agent-device');
  assert.deepEqual((manifest.artifacts as { captures: { screenshots: string[] } }).captures.screenshots, [
    'captures/android-agent-device-final.png',
  ]);
  assert.equal(agentDeviceMetadata.session, 'profile-android');
  assert.equal(agentDeviceMetadata.sessionMode, 'bind');
  assert.equal(agentDeviceMetadata.targetSelectionMode, 'session_bind');
  assert.equal((agentDeviceMetadata.captures as { screenshots: string[] }).screenshots[0], 'captures/android-agent-device-final.png');
  assert.equal(fs.existsSync(path.join(result.runDir, 'captures', 'android-agent-device-final.png')), true);
});

test('profile-android attaches provider signal and capture artifacts', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-evidence-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-evidence-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const jsSignalPath = path.join(providerRoot, 'js-profile.json');
  const networkSignalPath = path.join(providerRoot, 'network-capture.har');
  const uiTreePath = path.join(providerRoot, 'ui-tree-provider.json');
  await fsp.writeFile(jsSignalPath, '{"samples":[]}\n', 'utf8');
  await fsp.writeFile(networkSignalPath, '{"log":{"entries":[]}}\n', 'utf8');
  await fsp.writeFile(uiTreePath, '{"tree":[]}\n', 'utf8');

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--signal',
    `js:${jsSignalPath}`,
    '--signal',
    `network:${networkSignalPath}`,
    '--capture',
    `uiTree:${uiTreePath}`,
    '--out',
    artifactRoot,
    '--run-id',
    'android-example-startup',
  ]);

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const metrics = readJson(path.join(runDir, 'metrics.json'));
  const artifacts = manifest.artifacts as {
    captures: { uiTree: string };
    evidenceAttachments: Array<{
      channel: string;
      completenessStatus: string;
      corruptionStatus: string;
      kind: string;
      path: string;
      redactionPolicy: {
        authority: string;
        reason: string;
        sensitivity: string;
        status: string;
      };
      redactionStatus: string;
      sha256: string;
      sizeBytes: number;
      sourceFileName: string;
      transformations: string[];
    }>;
    signals: { js: string[]; network: string[] };
  };
  const causalRun = readJson(path.join(runDir, 'causal-run.json'));
  const summary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');

  assert.deepEqual(artifacts.signals.js, ['signals/js/js-profile.json']);
  assert.deepEqual(artifacts.signals.network, ['signals/network/network-capture.har']);
  assert.equal(artifacts.captures.uiTree, 'captures/ui-tree-provider.json');
  assert.deepEqual(artifacts.evidenceAttachments, [
    {
      channel: 'signal',
      completenessStatus: 'complete',
      corruptionStatus: 'valid',
      kind: 'js',
      path: 'signals/js/js-profile.json',
      redactionPolicy: {
        authority: 'asl-default',
        reason: 'ASL copied the artifact but did not inspect it for secrets, PII, tokens, or other sensitive content.',
        sensitivity: 'may-contain-sensitive-data',
        status: 'unknown',
      },
      redactionStatus: 'unknown',
      sha256: sha256File(jsSignalPath),
      sizeBytes: fs.statSync(jsSignalPath).size,
      sourceFileName: 'js-profile.json',
      transformations: ['copied'],
    },
    {
      channel: 'signal',
      completenessStatus: 'complete',
      corruptionStatus: 'valid',
      kind: 'network',
      path: 'signals/network/network-capture.har',
      redactionPolicy: {
        authority: 'asl-default',
        reason: 'ASL copied the artifact but did not inspect it for secrets, PII, tokens, or other sensitive content.',
        sensitivity: 'may-contain-sensitive-data',
        status: 'unknown',
      },
      redactionStatus: 'unknown',
      sha256: sha256File(networkSignalPath),
      sizeBytes: fs.statSync(networkSignalPath).size,
      sourceFileName: 'network-capture.har',
      transformations: ['copied'],
    },
    {
      channel: 'capture',
      completenessStatus: 'complete',
      corruptionStatus: 'valid',
      kind: 'uiTree',
      path: 'captures/ui-tree-provider.json',
      redactionPolicy: {
        authority: 'asl-default',
        reason: 'ASL copied the artifact but did not inspect it for secrets, PII, tokens, or other sensitive content.',
        sensitivity: 'may-contain-sensitive-data',
        status: 'unknown',
      },
      redactionStatus: 'unknown',
      sha256: sha256File(uiTreePath),
      sizeBytes: fs.statSync(uiTreePath).size,
      sourceFileName: 'ui-tree-provider.json',
      transformations: ['copied'],
    },
  ]);
  assert.ok(fs.existsSync(path.join(runDir, 'signals', 'js', 'js-profile.json')));
  assert.ok(fs.existsSync(path.join(runDir, 'signals', 'network', 'network-capture.har')));
  assert.ok(fs.existsSync(path.join(runDir, 'captures', 'ui-tree-provider.json')));
  assert.deepEqual((metrics.artifacts as { signals: { js: string[] } }).signals.js, ['signals/js/js-profile.json']);
  assert.equal((causalRun.artifacts as { evidenceAttachments: unknown[] }).evidenceAttachments.length, 3);
  assert.match(summary, /## Evidence attachments/u);
  assert.match(summary, /signal\/js/u);
});

test('profile-android executes declared evidence provider commands', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-command-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-command-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'write-accessibility.js');
  await fsp.writeFile(
    providerScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const outputPath = process.argv[2];",
      "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
      "fs.writeFileSync(outputPath, JSON.stringify({ violations: [] }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'local-accessibility-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: [providerScript, '{providerDir}/accessibility.json'],
          outputs: [
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
              redactionStatus: 'redacted',
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-provider-command',
  ]);

  const runDir = stdout.trim();
  const providerOutputPath = path.join(runDir, 'raw', 'providers', 'local-accessibility-provider', 'accessibility.json');
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const artifacts = manifest.artifacts as {
    evidenceAttachments: Array<{
      channel: string;
      completenessStatus: string;
      corruptionStatus: string;
      kind: string;
      path: string;
      redactionPolicy: {
        authority: string;
        reason: string;
        sensitivity: string;
        status: string;
      };
      redactionStatus: string;
      sha256: string;
      sizeBytes: number;
      sourceFileName: string;
      transformations: string[];
    }>;
  };
  const summary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');

  assert.ok(fs.existsSync(providerOutputPath));
  assert.ok(fs.existsSync(path.join(runDir, 'raw', 'provider-commands', 'local-accessibility-provider-capture-accessibility.json')));
  assert.deepEqual(artifacts.evidenceAttachments, [
    {
      channel: 'provider',
      completenessStatus: 'complete',
      corruptionStatus: 'valid',
      kind: 'accessibility',
      path: 'raw/providers/local-accessibility-provider/accessibility.json',
      redactionPolicy: {
        authority: 'provider-declared',
        reason: 'The artifact producer declared that sensitive content was redacted before ASL copied it.',
        sensitivity: 'unknown',
        status: 'redacted',
      },
      redactionStatus: 'redacted',
      sha256: sha256File(providerOutputPath),
      sizeBytes: fs.statSync(providerOutputPath).size,
      sourceFileName: 'accessibility.json',
      transformations: ['copied'],
    },
  ]);
  assert.match(summary, /provider\/accessibility/u);
});

test('profile-android fails health for malformed profiler provider evidence', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-profiler-invalid-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-profiler-invalid-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'write-invalid-profiler.js');
  await fsp.writeFile(
    providerScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const outputPath = process.argv[2];",
      "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
      "fs.writeFileSync(outputPath, JSON.stringify({ samples: [] }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'invalid-profiler-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['profiler'],
      artifactOutputs: ['profiler'],
      lifecycle: ['afterCapture'],
      providerCommands: [
        {
          id: 'capture-profiler',
          phase: 'afterCapture',
          command: process.execPath,
          args: [providerScript, '{providerDir}/profiler.json'],
          outputs: [
            {
              channel: 'provider',
              kind: 'profiler',
              path: '{providerDir}/profiler.json',
              required: true,
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-invalid-profiler-provider',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const agentSummary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].code, 'provider_evidence_invalid');
  assert.equal(health.checks[0].metadata.providerId, 'invalid-profiler-provider');
  assert.equal(health.checks[0].metadata.nextActionCode, 'fix_provider_evidence_output');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.match(agentSummary, /fix_provider_evidence_output/u);
});

test('profile-android fails health for malformed native performance provider evidence', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-native-performance-invalid-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-native-performance-invalid-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'write-invalid-native-performance.js');
  await fsp.writeFile(
    providerScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const outputPath = process.argv[2];",
      "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
      "fs.writeFileSync(outputPath, JSON.stringify({ frames: { janky: 0 } }) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'invalid-native-performance-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['nativePerformance'],
      artifactOutputs: ['nativePerformance'],
      lifecycle: ['afterCapture'],
      providerCommands: [
        {
          id: 'capture-native-performance',
          phase: 'afterCapture',
          command: process.execPath,
          args: [providerScript, '{providerDir}/native-performance.json'],
          outputs: [
            {
              channel: 'provider',
              kind: 'nativePerformance',
              path: '{providerDir}/native-performance.json',
              required: true,
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-invalid-native-performance-provider',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const agentSummary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].code, 'provider_evidence_invalid');
  assert.equal(health.checks[0].metadata.providerId, 'invalid-native-performance-provider');
  assert.equal(health.checks[0].metadata.nextActionCode, 'fix_provider_evidence_output');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.match(agentSummary, /fix_provider_evidence_output/u);
});

test('profile-android marks required provider command outputs as required diagnostics', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-required-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-required-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'write-required-evidence.js');
  await fsp.writeFile(
    providerScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "for (const outputPath of process.argv.slice(2)) {",
      "  fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
      "}",
      "fs.writeFileSync(process.argv[2], JSON.stringify({ heapBytes: 1234 }) + '\\n');",
      "fs.writeFileSync(process.argv[3], JSON.stringify({ violations: [] }) + '\\n');",
      "fs.writeFileSync(process.argv[4], JSON.stringify({",
      "  schemaVersion: '1.0.0',",
      "  providerId: 'required-diagnostics-provider',",
      "  platform: 'android',",
      "  runId: 'android-provider-required',",
      "  scenarioId: 'app-startup',",
      "  tool: { name: 'adb', command: 'dumpsys gfxinfo' },",
      "  captureMode: 'afterCapture',",
      "  evidenceKind: 'gfxinfo',",
      "  dataClasses: ['frames', 'jank'],",
      "  completenessStatus: 'complete',",
      "  targetBinding: { status: 'verified', deviceId: 'emulator-5554', appId: 'dev.agent-scenario-loop.example' },",
      "  comparability: { status: 'diagnostic-only', reason: 'Provider evidence was captured after the profile loop.' },",
      "  frames: { janky: 0 }",
      "}) + '\\n');",
    ].join('\n'),
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'required-diagnostics-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['memory', 'accessibility', 'nativePerformance'],
      artifactOutputs: ['memory', 'accessibility', 'nativePerformance'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-required-diagnostics',
          phase: 'capture',
          command: process.execPath,
          args: [
            providerScript,
            '{providerDir}/memory.json',
            '{providerDir}/accessibility.json',
            '{providerDir}/native-performance.json',
          ],
          outputs: [
            {
              channel: 'signal',
              kind: 'memory',
              path: '{providerDir}/memory.json',
              required: true,
            },
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
              required: true,
            },
            {
              channel: 'provider',
              kind: 'nativePerformance',
              path: '{providerDir}/native-performance.json',
              required: true,
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-provider-required',
  ]);

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const diagnostics = (manifest.artifacts as { diagnostics: Array<Record<string, unknown>> }).diagnostics;
  const memoryDiagnostic = diagnostics.find((entry) => entry.kind === 'memory');
  const accessibilityDiagnostic = diagnostics.find((entry) => entry.kind === 'accessibility');
  const nativePerformanceDiagnostic = diagnostics.find((entry) => entry.kind === 'nativePerformance');

  assert.equal(memoryDiagnostic?.status, 'captured');
  assert.equal(memoryDiagnostic?.required, true);
  assert.equal(memoryDiagnostic?.path, 'signals/memory/memory.json');
  assert.equal(accessibilityDiagnostic?.status, 'captured');
  assert.equal(accessibilityDiagnostic?.required, true);
  assert.equal(accessibilityDiagnostic?.path, 'raw/providers/required-diagnostics-provider/accessibility.json');
  assert.equal(nativePerformanceDiagnostic?.status, 'captured');
  assert.equal(nativePerformanceDiagnostic?.required, true);
  assert.equal(nativePerformanceDiagnostic?.path, 'raw/providers/required-diagnostics-provider/native-performance.json');
});

test('profile-android rejects duplicate evidence provider command ids', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-duplicate-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-duplicate-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  const commandOutput = {
    channel: 'provider',
    kind: 'accessibility',
    path: '{providerDir}/accessibility.json',
  };
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'duplicate-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          outputs: [commandOutput],
        },
        {
          id: 'capture-accessibility',
          phase: 'finalize',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          outputs: [commandOutput],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  await assert.rejects(
    () =>
      runProfileAndroid({
        config: fixturePath('examples/mobile-app/asl.config.json'),
        events: fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
        out: artifactRoot,
        provider: providerManifestPath,
        'run-id': 'android-provider-duplicate',
        scenario: fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
      }),
    /duplicate providerCommand id `capture-accessibility`/u,
  );
});

test('profile-android rejects providers that do not support the selected platform', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-platform-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-platform-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const markerPath = path.join(providerRoot, 'provider-ran.txt');
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'ios-only-provider',
      kind: 'evidenceProvider',
      platforms: ['ios'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran\\n')`],
          outputs: [
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-provider-platform',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json'));
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(health.healthStatus, 'failed');
  assert.deepEqual(
    (health.checks as Array<{ code: string; metadata?: { nextActionCode?: string; providerId?: string } }>).map((check) => ({
      code: check.code,
      nextActionCode: check.metadata?.nextActionCode,
      providerId: check.metadata?.providerId,
    })),
    [
      {
        code: 'provider_platform_unsupported',
        nextActionCode: 'select_supported_provider_platform',
        providerId: 'ios-only-provider',
      },
    ],
  );
  assert.equal(fs.existsSync(path.join(runDir, 'raw', 'provider-commands', 'ios-only-provider-capture-accessibility.json')), false);
  assert.match(summary, /Next action `select_supported_provider_platform`/u);
});

test('profile-android fails health for unsupported provider lifecycle phases', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-phase-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-phase-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const markerPath = path.join(providerRoot, 'provider-ran.txt');
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'window-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['profiler'],
      artifactOutputs: ['profiler'],
      lifecycle: ['startWindow'],
      providerCommands: [
        {
          id: 'start-profiler',
          phase: 'startWindow',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran\\n')`],
          outputs: [
            {
              channel: 'provider',
              kind: 'profiler',
              path: '{providerDir}/profiler.json',
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-provider-unsupported-phase',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');
  const commandRecord = readJson(path.join(runDir, 'raw', 'provider-commands', 'window-provider-start-profiler.json'));

  assert.equal(fs.existsSync(markerPath), false);
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(commandRecord.status, 'unsupported');
  assert.equal(commandRecord.phase, 'startWindow');
  assert.deepEqual(commandRecord.supportedPhases, ['capture', 'afterCapture', 'postRun']);
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: { nextActionCode?: string; phase?: string; rawPath?: string } }>).some(
      (check) =>
        check.code === 'provider_lifecycle_phase_unsupported' &&
        check.metadata?.nextActionCode === 'select_supported_provider_lifecycle_phase' &&
        check.metadata?.phase === 'startWindow' &&
        check.metadata?.rawPath === 'raw/provider-commands/window-provider-start-profiler.json',
    ),
  );
  assert.match(summary, /evidence_provider_lifecycle_supported/u);
  assert.match(summary, /Next action `select_supported_provider_lifecycle_phase`/u);
});

test('profile-android writes failed health when an evidence provider command fails', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-failure-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-failure-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'fail-provider.js');
  await fsp.writeFile(
    providerScript,
    "process.stderr.write('provider unavailable\\n'); process.exit(7);\n",
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'failing-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: [providerScript],
          outputs: [
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-provider-failure',
  ]);

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const runPlan = readJson(path.join(runDir, 'run-plan.json')) as Record<string, any>;
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');
  const commandRecord = readJson(path.join(runDir, 'raw', 'provider-commands', 'failing-provider-capture-accessibility.json'));

  assert.equal(runPlan.inputMode, 'fixture-event-log');
  assert.deepEqual(runPlan.providers, [{ path: 'provider.json' }]);
  assert.deepEqual(runPlan.requestedDiagnostics, { required: [], optional: [] });
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(commandRecord.exitCode, 7);
  assert.equal(commandRecord.stderr, 'provider unavailable\n');
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'provider_command_failed' && check.metadata?.nextActionCode === 'fix_provider_command',
    ),
  );
  assert.match(summary, /Do not optimize from this run/u);
  assert.match(summary, /Next action `fix_provider_command`/u);
});

test('profile-android preserves captured provider evidence when another required output fails', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-partial-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-partial-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'partial-provider.js');
  await fsp.writeFile(
    providerScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const nativePerformancePath = process.argv[2];",
      'fs.mkdirSync(path.dirname(nativePerformancePath), { recursive: true });',
      "fs.writeFileSync(nativePerformancePath, JSON.stringify({",
      "  schemaVersion: '1.0.0',",
      "  providerId: 'partial-native-provider',",
      "  platform: 'android',",
      "  runId: 'android-example-startup',",
      "  scenarioId: 'app-startup',",
      "  tool: { name: 'adb', command: 'dumpsys gfxinfo framestats' },",
      "  captureMode: 'afterCapture',",
      "  evidenceKind: 'gfxinfo',",
      "  dataClasses: ['frames', 'jank'],",
      "  completenessStatus: 'partial',",
      "  targetBinding: { status: 'verified', deviceId: 'emulator-5554', appId: 'dev.agent-scenario-loop.example' },",
      "  comparability: { status: 'diagnostic-only', reason: 'Provider command failed after preserving native performance evidence.' },",
      "  frames: { totalFrameCount: 42, droppedFrameCount: 3 }",
      "}) + '\\n');",
      "process.stderr.write('accessibility snapshot timed out\\n');",
      'process.exit(7);',
    ].join('\n'),
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'partial-native-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility', 'nativePerformance'],
      artifactOutputs: ['accessibility', 'nativePerformance'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-required-diagnostics',
          phase: 'capture',
          command: process.execPath,
          args: [
            providerScript,
            '{providerDir}/native-performance.json',
          ],
          outputs: [
            {
              channel: 'provider',
              kind: 'nativePerformance',
              path: '{providerDir}/native-performance.json',
              required: true,
            },
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
              required: true,
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-example-startup',
  ]);

  const runDir = stdout.trim();
  const nativePerformancePath = path.join(runDir, 'raw', 'providers', 'partial-native-provider', 'native-performance.json');
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;
  const commandRecord = readJson(path.join(runDir, 'raw', 'provider-commands', 'partial-native-provider-capture-required-diagnostics.json'));
  const diagnostics = (manifest.artifacts as { diagnostics: Array<Record<string, unknown>> }).diagnostics;
  const attachments = (manifest.artifacts as { evidenceAttachments: Array<Record<string, unknown>> }).evidenceAttachments;
  const nativePerformanceDiagnostic = diagnostics.find((entry) => entry.kind === 'nativePerformance');
  const accessibilityDiagnostic = diagnostics.find((entry) => entry.kind === 'accessibility');

  assert.equal(fs.existsSync(nativePerformancePath), true);
  assert.equal(metrics.status, 'passed');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(commandRecord.exitCode, 7);
  assert.equal(nativePerformanceDiagnostic?.status, 'captured');
  assert.equal(nativePerformanceDiagnostic?.required, true);
  assert.equal(nativePerformanceDiagnostic?.path, 'raw/providers/partial-native-provider/native-performance.json');
  assert.equal(accessibilityDiagnostic?.status, 'failed');
  assert.equal(accessibilityDiagnostic?.required, true);
  assert.equal(accessibilityDiagnostic?.provider, 'partial-native-provider');
  assert.deepEqual(attachments.map((attachment) => attachment.kind), ['nativePerformance']);
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: { kind?: string; nextActionCode?: string; providerId?: string } }>).some(
      (check) => check.code === 'provider_command_failed' && check.metadata?.providerId === 'partial-native-provider',
    ),
  );
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: { capturedKinds?: string; failedRequiredKinds?: string; nextActionCode?: string } }>).some(
      (check) => (
        check.code === 'partial_provider_evidence_preserved' &&
        check.metadata?.capturedKinds?.split(',').includes('nativePerformance') &&
        check.metadata?.failedRequiredKinds?.split(',').includes('accessibility') &&
        check.metadata?.nextActionCode === 'use_partial_provider_evidence_for_diagnosis'
      ),
    ),
  );
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: { kind?: string; nextActionCode?: string; providerId?: string } }>).some(
      (check) => check.code === 'required_diagnostic_not_captured' && check.metadata?.kind === 'accessibility',
    ),
  );
});

test('profile-android writes provider liveness artifacts when an evidence provider command hangs', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-provider-hang-'));
  const providerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-hang-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
    await fsp.rm(providerRoot, { recursive: true, force: true });
  });
  const providerScript = path.join(providerRoot, 'hang-provider.js');
  await fsp.writeFile(
    providerScript,
    [
      "const fs = require('node:fs');",
      "fs.writeSync(1, 'provider started\\n');",
      "fs.writeSync(2, 'waiting for external tool\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );
  const providerManifestPath = path.join(providerRoot, 'provider.json');
  await fsp.writeFile(
    providerManifestPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'hanging-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: [providerScript],
          outputs: [
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
            },
          ],
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--events',
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    '--provider',
    providerManifestPath,
    '--out',
    artifactRoot,
    '--run-id',
    'android-provider-hang',
  ], {
    env: {
      ...process.env,
      ASL_PROVIDER_COMMAND_TIMEOUT_MS: '1000',
    },
  });

  const runDir = stdout.trim();
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');
  const commandRecordPath = path.join(runDir, 'raw', 'provider-commands', 'hanging-provider-capture-accessibility.json');
  const stdoutPath = path.join(runDir, 'raw', 'provider-commands', 'hanging-provider-capture-accessibility.stdout.txt');
  const stderrPath = path.join(runDir, 'raw', 'provider-commands', 'hanging-provider-capture-accessibility.stderr.txt');
  const commandRecord = readJson(commandRecordPath);

  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(commandRecord.status, 'timed_out');
  assert.equal(commandRecord.timedOut, true);
  assert.equal(commandRecord.timeoutMs, 1000);
  assert.equal(fs.readFileSync(stdoutPath, 'utf8'), 'provider started\n');
  assert.equal(fs.readFileSync(stderrPath, 'utf8'), 'waiting for external tool\n');
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'provider_liveness_timeout' && check.metadata?.nextActionCode === 'fix_provider_liveness',
    ),
  );
  assert.match(summary, /Do not optimize from this run/u);
  assert.match(summary, /Next action `fix_provider_liveness`/u);
});

test('profile-android reads logcat from adb artifact folders', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-adb-artifacts-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbArtifactRoot = path.join(tempRoot, 'adb-capture');
  const profileArtifactRoot = path.join(tempRoot, 'profile');
  await fsp.mkdir(path.join(adbArtifactRoot, 'raw'), { recursive: true });
  await fsp.copyFile(
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    path.join(adbArtifactRoot, 'raw', 'adb-logcat.txt'),
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--adb-artifacts',
    adbArtifactRoot,
    '--out',
    profileArtifactRoot,
    '--run-id',
    'android-example-startup',
  ]);

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const artifacts = manifest.artifacts as { raw: { interactionLog: string } };
  const causalRun = readJson(path.join(runDir, 'causal-run.json'));

  assert.equal(artifacts.raw.interactionLog, 'raw/adb-logcat.txt');
  assert.equal(manifest.interactionDriver, 'adb-logcat');
  assert.deepEqual((manifest.environment as Record<string, any>).preconditions.foregroundState, unknownLifecycleAssertion());
  assert.deepEqual((manifest.environment as Record<string, any>).preconditions.lifecyclePhase, unknownLifecycleAssertion());
  assert.deepEqual((manifest.environment as Record<string, any>).postconditions.artifactState, {
    artifact: 'manifest.json',
    evidence: 'asserted',
    source: 'asl-profile-runner',
    value: 'complete',
  });
  assert.deepEqual(manifest.simulator, {
    name: 'unknown android device',
    udid: 'unknown',
  });
  assert.equal((causalRun.scenario as { driver: string }).driver, 'adb-logcat');
  const diagnostics = (manifest.artifacts as { diagnostics: Array<Record<string, any>> }).diagnostics;
  const logDiagnostic = diagnostics.find((entry) => entry.kind === 'logs');
  assert.equal(logDiagnostic?.status, 'captured');
  assert.equal(logDiagnostic?.path, 'raw/adb-logcat.txt');
  assert.equal(logDiagnostic?.runnerId, 'android-adb');
  assert.ok(String(logDiagnostic?.sidecarRoot).endsWith('adb-capture'));
  assert.equal(logDiagnostic?.evidenceDependency?.root, 'sidecar');
  assert.equal(logDiagnostic?.evidenceDependency?.path, 'raw/adb-logcat.txt');
  const identityCheck = (health.checks as Array<{ code: string; metadata?: Record<string, unknown>; status: string }>).find(
    (check) => check.code === 'runtime_identity_unverified',
  );
  assert.equal(identityCheck?.status, 'failed');
  assert.equal(identityCheck?.metadata?.expectedAppId, 'dev.agentscenarioloop.example');
  assert.equal(identityCheck?.metadata?.sidecarMetadataPath, 'raw/android-metadata.json');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.ok(fs.existsSync(path.join(runDir, 'raw', 'adb-logcat.txt')));
});

test('profile-android fails health when adb sidecar package mismatches expected package', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-runtime-identity-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbArtifactRoot = path.join(tempRoot, 'adb-capture');
  const profileArtifactRoot = path.join(tempRoot, 'profile');
  await fsp.mkdir(path.join(adbArtifactRoot, 'raw'), { recursive: true });
  await fsp.copyFile(
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    path.join(adbArtifactRoot, 'raw', 'adb-logcat.txt'),
  );
  await fsp.writeFile(
    path.join(adbArtifactRoot, 'raw', 'android-metadata.json'),
    `${JSON.stringify({
      packageName: 'dev.other.example',
      selectedDevice: {
        serial: 'emulator-5554',
        state: 'device',
      },
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--adb-artifacts',
    adbArtifactRoot,
    '--package',
    'dev.agentscenarioloop.example',
    '--out',
    profileArtifactRoot,
    '--run-id',
    'android-runtime-identity',
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
  assert.equal(identityCheck?.metadata?.expectedAppId, 'dev.agentscenarioloop.example');
  assert.equal(identityCheck?.metadata?.expectedAppIdSource, 'cli');
  assert.equal(identityCheck?.metadata?.observedAppId, 'dev.other.example');
  assert.equal(identityCheck?.metadata?.sidecarMetadataPath, 'raw/android-metadata.json');
  assert.equal(identityCheck?.metadata?.nextActionCode, 'rerun_sidecar_with_expected_runtime_identity');
});

test('profile-android fails health when storage session seed is newer than app session start', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-stale-session-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'profile');
  const adbRoot = path.join(tempRoot, 'adb');
  const rawDir = path.join(adbRoot, 'raw');
  await fsp.mkdir(rawDir, { recursive: true });
  const scenarioPath = path.join(tempRoot, 'stale-session.json');
  await fsp.writeFile(
    scenarioPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      id: 'stale-session',
      flowId: 'stale-session',
      journey: {
        name: 'Stale session',
        intent: 'Reject stale profile-session evidence.',
        actor: 'runner',
        startState: 'home',
        endState: 'home',
      },
      platforms: ['android'],
      requiredCapabilities: ['launch', 'sessionControl', 'logCapture', 'artifactWrite'],
      truthEvents: {
        done: { event: 'profile_done', required: true, timeoutMs: 1000, phase: 'completion' },
      },
      milestones: [
        { id: 'done', event: 'profile_done', required: true, phase: 'completion' },
      ],
      expectedEvents: ['profile_done'],
      cycles: { iterations: 1, warmupIterations: 0, stopOnFailure: true },
      budgets: [
        { name: 'cycle p95', source: 'milestone', metric: 'p95', unit: 'ms', limit: 1000, toMilestone: 'done' },
        { name: 'failures', source: 'milestone', metric: 'failures', unit: 'count', limit: 0 },
      ],
      artifacts: { required: ['logs'], optional: [] },
    }, null, 2)}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(rawDir, 'adb-logcat.txt'),
    [
      '06-21 18:51:24.886 I/ReactNativeJS(123): [profile-session] {"kind":"start","scenario":"stale-session","runId":"stale-run","startedAt":1000,"timestamp":1000,"atMs":0}',
      '06-21 18:51:25.000 I/ReactNativeJS(123): [profile-event] {"event":"profile_done","scenario":"stale-session","runId":"stale-run","atMs":100}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(rawDir, 'adb-async-storage-write-1.txt'),
    [
      '$ adb -s emulator-5554 shell run-as dev.example sqlite3 databases/RKStorage \'INSERT OR REPLACE INTO catalystLocalStorage (key,value) VALUES (\'agent-scenario-loop.profile-session.1\',\'{"active":true,"scenario":"stale-session","runId":"stale-run","startedAt":2000}\');\'',
      'exitCode=0',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--adb-artifacts',
    adbRoot,
    '--out',
    artifactRoot,
    '--run-id',
    'stale-run',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;

  assert.equal(metrics.status, 'passed');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: Record<string, unknown> }>).some((check) => (
      check.code === 'profile_session_stale' &&
      check.metadata?.seedStartedAt === 2000 &&
      check.metadata?.appStartedAt === 1000
    )),
  );
});

test('profile-android fails health when storage session seed has no matching app session start', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-missing-session-start-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const artifactRoot = path.join(tempRoot, 'profile');
  const adbRoot = path.join(tempRoot, 'adb');
  const rawDir = path.join(adbRoot, 'raw');
  await fsp.mkdir(rawDir, { recursive: true });
  const scenarioPath = path.join(tempRoot, 'missing-session-start.json');
  await fsp.writeFile(
    scenarioPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      id: 'missing-session-start',
      flowId: 'missing-session-start',
      journey: {
        name: 'Missing session start',
        intent: 'Reject app truth that never acknowledged the runner-written session.',
        actor: 'runner',
        startState: 'home',
        endState: 'home',
      },
      platforms: ['android'],
      requiredCapabilities: ['launch', 'sessionControl', 'logCapture', 'artifactWrite'],
      truthEvents: {
        done: { event: 'profile_done', required: true, timeoutMs: 1000, phase: 'completion' },
      },
      milestones: [
        { id: 'done', event: 'profile_done', required: true, phase: 'completion' },
      ],
      expectedEvents: ['profile_done'],
      cycles: { iterations: 1, warmupIterations: 0, stopOnFailure: true },
      budgets: [
        { name: 'cycle p95', source: 'milestone', metric: 'p95', unit: 'ms', limit: 1000, toMilestone: 'done' },
        { name: 'failures', source: 'milestone', metric: 'failures', unit: 'count', limit: 0 },
      ],
      artifacts: { required: ['logs'], optional: [] },
    }, null, 2)}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(rawDir, 'adb-logcat.txt'),
    [
      '06-21 18:51:25.000 I/ReactNativeJS(123): [profile-event] {"event":"profile_done","scenario":"missing-session-start","runId":"missing-start-run","atMs":100}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(rawDir, 'adb-async-storage-write-1.txt'),
    [
      '$ adb -s emulator-5554 shell run-as dev.example sqlite3 databases/RKStorage \'INSERT OR REPLACE INTO catalystLocalStorage (key,value) VALUES (\'agent-scenario-loop.profile-session.1\',\'{"active":true,"scenario":"missing-session-start","runId":"missing-start-run","startedAt":2000}\');\'',
      'exitCode=0',
      '',
    ].join('\n'),
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    scenarioPath,
    '--adb-artifacts',
    adbRoot,
    '--out',
    artifactRoot,
    '--run-id',
    'missing-start-run',
  ]);

  const runDir = stdout.trim();
  const metrics = readJson(path.join(runDir, 'metrics.json')) as Record<string, any>;
  const health = readJson(path.join(runDir, 'health.json')) as Record<string, any>;
  const verdict = readJson(path.join(runDir, 'verdict.json')) as Record<string, any>;

  assert.equal(metrics.status, 'passed');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.ok(
    (health.checks as Array<{ code: string; metadata?: Record<string, unknown>; status: string }>).some((check) => (
      check.code === 'profile_session_start_missing' &&
      check.status === 'failed' &&
      check.metadata?.seedStartedAt === 2000
    )),
  );
});

test('profile-android reports adb sidecar screenshots as captured diagnostics', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-adb-screenshot-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbArtifactRoot = path.join(tempRoot, 'adb-capture');
  const profileArtifactRoot = path.join(tempRoot, 'profile');
  await fsp.mkdir(path.join(adbArtifactRoot, 'raw'), { recursive: true });
  await fsp.copyFile(
    fixturePath('examples/mobile-app/event-logs/android-app-startup.log'),
    path.join(adbArtifactRoot, 'raw', 'adb-logcat.txt'),
  );
  await fsp.writeFile(
    path.join(adbArtifactRoot, 'raw', 'adb-screenshot-2.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
  );
  await fsp.writeFile(
    path.join(adbArtifactRoot, 'raw', 'android-metadata.json'),
    `${JSON.stringify({
      driverActions: [
        {
          driverAction: 'screenshot',
          exitCode: 1,
          rawPath: 'raw/adb-screenshot-2.png',
          stepId: 'capture-final',
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    PROFILE_ANDROID,
    '--config',
    fixturePath('examples/mobile-app/asl.config.json'),
    '--scenario',
    fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    '--adb-artifacts',
    adbArtifactRoot,
    '--out',
    profileArtifactRoot,
    '--run-id',
    'android-sidecar-screenshot',
  ]);

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const diagnostics = (manifest.artifacts as { diagnostics: Array<Record<string, any>> }).diagnostics;
  const screenshotDiagnostic = diagnostics.find((entry) => entry.kind === 'screenshot');

  assert.equal(screenshotDiagnostic?.status, 'captured');
  assert.equal(screenshotDiagnostic?.provider, 'adb');
  assert.equal(screenshotDiagnostic?.runnerId, 'android-adb');
  assert.equal(screenshotDiagnostic?.path, 'raw/adb-screenshot-2.png');
  assert.ok(String(screenshotDiagnostic?.sidecarRoot).endsWith('adb-capture'));
  assert.equal(screenshotDiagnostic?.evidenceDependency?.kind, 'sidecar');
  assert.equal(screenshotDiagnostic?.evidenceDependency?.root, 'sidecar');
  assert.equal(screenshotDiagnostic?.evidenceDependency?.path, 'raw/adb-screenshot-2.png');
  assert.deepEqual((manifest.artifacts as { captures: { screenshots: string[] } }).captures.screenshots, []);
  assert.equal(fs.existsSync(path.join(runDir, 'captures', 'adb-screenshot-2.png')), false);
});

test('profile-android can capture adb logs and profile them in one run', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-adb-capture-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbCaptureRoot = path.join(tempRoot, 'adb-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const waits: number[] = [];
  const executor = createExecutor({
    version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
    'devices -l': {
      stdout: [
        'List of devices attached',
        'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
      ].join('\n'),
    },
    '-s emulator-5554 shell getprop ro.product.model': { stdout: 'Pixel 6\n' },
    '-s emulator-5554 shell getprop ro.build.version.release': { stdout: '15\n' },
    '-s emulator-5554 shell getprop ro.build.version.sdk': { stdout: '35\n' },
    '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
      stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
    },
    '-s emulator-5554 logcat -c': { stdout: '' },
    '-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1': {
      stdout: 'Events injected: 1\n',
    },
    '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
      stdout: '1234\n',
    },
    '-s emulator-5554 logcat -d -v time -t 1000': {
      stdout: fs
        .readFileSync(fixturePath('examples/mobile-app/event-logs/android-app-startup.log'), 'utf8')
        .replace(/android-example-startup/gu, 'android-captured-startup'),
    },
  });

  const result = await runProfileAndroid({
    'adb-capture': true,
    'adb-out': adbCaptureRoot,
    'clear-logcat': true,
    config: fixturePath('examples/mobile-app/asl.config.json'),
    events: fixturePath('examples/mobile-app/event-logs/android-open-close-cycle.log'),
    launch: true,
    'lifecycle-phase': 'warm-launch',
    out: profileRoot,
    'run-id': 'android-captured-startup',
    scenario: fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    'wait-ms': '25',
  }, {
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const health = readJson(path.join(result.runDir, 'health.json'));
  const adbHealth = readJson(path.join(adbCaptureRoot, 'health.json'));
  const causalRun = readJson(path.join(result.runDir, 'causal-run.json'));

  assert.deepEqual(waits, [25]);
  assert.equal(result.runDir, path.join(profileRoot, 'app-startup', 'android-captured-startup'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(adbHealth.healthStatus, 'passed');
  assert.deepEqual(manifest.simulator, {
    name: 'Pixel 6 Android 15 API 35',
    udid: 'emulator-5554',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).preconditions.foregroundState, {
    evidence: 'asserted',
    source: 'adb',
    value: 'controlled-by-runner',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).preconditions.lifecyclePhase, {
    artifact: 'raw/adb-logcat.txt',
    evidence: 'asserted',
    source: 'adb',
    value: 'warm-launch',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).postconditions.appState, {
    artifact: 'raw/adb-logcat.txt',
    evidence: 'asserted',
    source: 'adb',
    value: 'foreground',
  });
  assert.deepEqual((manifest.environment as Record<string, any>).postconditions.lifecyclePhase, {
    artifact: 'raw/adb-logcat.txt',
    evidence: 'asserted',
    source: 'adb',
    value: 'foreground',
  });
  assert.equal((manifest.artifacts as { raw: { interactionLog: string } }).raw.interactionLog, 'raw/adb-logcat.txt');
  assert.equal(manifest.interactionDriver, 'adb-logcat');
  assert.equal((causalRun.scenario as { driver: string }).driver, 'adb-logcat');
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'adb-logcat.txt')));
});

test('profile-android fails compatibility before live capture when required evidence is impossible', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-preflight-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const profileRoot = path.join(tempRoot, 'profile');
  const scenarioPath = path.join(tempRoot, 'requires-accessibility.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.artifacts = {
    required: ['accessibility'],
  };
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');

  await assert.rejects(
    runProfileAndroid({
      'adb-capture': true,
      config: fixturePath('examples/mobile-app/asl.config.json'),
      out: profileRoot,
      'run-id': 'android-preflight-missing-accessibility',
      scenario: scenarioPath,
    }, {
      executor: async () => {
        throw new Error('adb executor should not run after failed compatibility preflight');
      },
    }),
    /Profile compatibility preflight failed/u,
  );

  const runDir = path.join(profileRoot, 'app-startup', 'android-preflight-missing-accessibility');
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const compatibility = readJson(path.join(runDir, 'planner-compatibility.json'));
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.equal(compatibility.compatible, false);
  assert.ok(
    (health.checks as Array<{ code: string }>).some((check) => check.code === 'missing_required_artifact'),
  );
  assert.match(summary, /Do not optimize from this run/u);
});

test('profile-android fails fast with adb artifacts when adb devices times out', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-adb-hung-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbCaptureRoot = path.join(tempRoot, 'adb-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const executor = createExecutor({
    version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
    'devices -l': {
      exitCode: 1,
      stderr: 'adb command timed out after 50ms.',
    },
  });

  await assert.rejects(
    () => runProfileAndroid({
      'adb-capture': true,
      'adb-command-timeout-ms': '50',
      'adb-out': adbCaptureRoot,
      config: fixturePath('examples/mobile-app/asl.config.json'),
      out: profileRoot,
      'run-id': 'android-hung-devices',
      scenario: fixturePath('examples/mobile-app/scenarios/android/app-startup.json'),
    }, { executor }),
    /Android adb capture failed; inspect/u,
  );

  const adbHealth = readJson(path.join(adbCaptureRoot, 'health.json'));
  const devicesRaw = fs.readFileSync(path.join(adbCaptureRoot, 'raw', 'adb-devices.txt'), 'utf8');
  assert.equal(adbHealth.healthStatus, 'failed');
  assert.match(devicesRaw, /adb command timed out after 50ms/u);
  const profileRunDir = path.join(profileRoot, 'app-startup', 'android-hung-devices');
  const compatibility = readJson(path.join(profileRunDir, 'planner-compatibility.json'));
  assert.equal(compatibility.compatible, true);
  assert.ok(!fs.existsSync(path.join(profileRunDir, 'health.json')));
});

test('profile-android routes normalized readLogs evidence steps through adb driver capture', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-driver-steps-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const scenarioPath = path.join(tempRoot, 'app-startup-readlogs.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.steps = [
    {
      id: 'capture-log-window',
      kind: 'captureEvidence',
      artifact: 'logs',
      driverAction: 'readLogs',
      adapterOptions: {
        androidAdb: {
          logcatLines: 25,
          rawFileName: 'adb-logcat.txt',
        },
      },
    },
  ];
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  const adbCaptureRoot = path.join(tempRoot, 'adb-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (key.includes('profile-session/command')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n' };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
      'devices -l': {
        stdout: [
          'List of devices attached',
          'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
        ].join('\n'),
      },
      '-s emulator-5554 shell getprop ro.product.model': { stdout: 'Pixel 6\n' },
      '-s emulator-5554 shell getprop ro.build.version.release': { stdout: '15\n' },
      '-s emulator-5554 shell getprop ro.build.version.sdk': { stdout: '35\n' },
      '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
        stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
      },
      '-s emulator-5554 logcat -d -v time -t 25': {
        stdout: fs
          .readFileSync(fixturePath('examples/mobile-app/event-logs/android-app-startup.log'), 'utf8')
          .replace(/android-example-startup/gu, 'android-driver-startup'),
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

  const result = await runProfileAndroid({
    'adb-capture': true,
    'adb-out': adbCaptureRoot,
    config: fixturePath('examples/mobile-app/asl.config.json'),
    out: profileRoot,
    'run-id': 'android-driver-startup',
    scenario: scenarioPath,
  }, {
    executor,
  });

  const health = readJson(path.join(result.runDir, 'health.json'));
  const adbHealth = readJson(path.join(adbCaptureRoot, 'health.json'));
  const adbMetadata = readJson(path.join(adbCaptureRoot, 'raw', 'android-metadata.json'));
  assert.equal(result.runDir, path.join(profileRoot, 'app-startup', 'android-driver-startup'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(adbHealth.healthStatus, 'passed');
  assert.ok(calls.includes('-s emulator-5554 logcat -d -v time -t 25'));
  assert.equal((adbMetadata.logcat as { rawPath: string; stepId: string }).rawPath, 'raw/adb-logcat.txt');
  assert.equal((adbMetadata.logcat as { rawPath: string; stepId: string }).stepId, 'capture-log-window');
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'adb-logcat.txt')));
});

test('profile-android attaches adb record output as video evidence', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-record-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const scenarioPath = path.join(tempRoot, 'app-startup-record.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.steps = [
    {
      id: 'capture-log-window',
      kind: 'captureEvidence',
      artifact: 'logs',
      driverAction: 'readLogs',
      adapterOptions: {
        androidAdb: {
          logcatLines: 25,
          rawFileName: 'adb-logcat.txt',
        },
      },
    },
    {
      id: 'record-startup',
      kind: 'captureEvidence',
      artifact: 'video',
      driverAction: 'record',
      adapterOptions: {
        androidAdb: {
          captureFileName: 'startup-record.mp4',
          durationSeconds: 2,
          rawFileName: 'adb-record.txt',
          remotePath: '/sdcard/asl-startup-record.mp4',
        },
      },
    },
  ];
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  const adbCaptureRoot = path.join(tempRoot, 'adb-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const videoPath = path.join(adbCaptureRoot, 'captures', 'startup-record.mp4');
    if (key === `-s emulator-5554 pull /sdcard/asl-startup-record.mp4 ${videoPath}`) {
      await fsp.writeFile(videoPath, 'MP4', 'utf8');
      return { command, args, exitCode: 0, stderr: '', stdout: `${videoPath}\n` };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
      'devices -l': {
        stdout: [
          'List of devices attached',
          'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
        ].join('\n'),
      },
      '-s emulator-5554 shell getprop ro.product.model': { stdout: 'Pixel 6\n' },
      '-s emulator-5554 shell getprop ro.build.version.release': { stdout: '15\n' },
      '-s emulator-5554 shell getprop ro.build.version.sdk': { stdout: '35\n' },
      '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
        stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
      },
      '-s emulator-5554 logcat -d -v time -t 25': {
        stdout: fs
          .readFileSync(fixturePath('examples/mobile-app/event-logs/android-app-startup.log'), 'utf8')
          .replace(/android-example-startup/gu, 'android-record-startup'),
      },
      '-s emulator-5554 shell screenrecord --time-limit 2 /sdcard/asl-startup-record.mp4': {
        stdout: '',
      },
      '-s emulator-5554 shell rm -f /sdcard/asl-startup-record.mp4': {
        stdout: '',
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

  const result = await runProfileAndroid({
    'adb-capture': true,
    'adb-out': adbCaptureRoot,
    config: fixturePath('examples/mobile-app/asl.config.json'),
    out: profileRoot,
    'run-id': 'android-record-startup',
    scenario: scenarioPath,
  }, {
    executor,
  });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const health = readJson(path.join(result.runDir, 'health.json'));
  const adbMetadata = readJson(path.join(adbCaptureRoot, 'raw', 'android-metadata.json'));

  assert.equal(health.healthStatus, 'passed');
  assert.equal((manifest.artifacts as { captures: { video: string } }).captures.video, 'captures/startup-record.mp4');
  assert.equal((adbMetadata.driverActions as Array<{ capturePath?: string; driverAction: string }>)[1]?.capturePath, 'captures/startup-record.mp4');
  assert.ok(fs.existsSync(path.join(adbCaptureRoot, 'captures', 'startup-record.mp4')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'captures', 'startup-record.mp4')));
});

test('profile-android rejects adb tap metadata before capture starts', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-invalid-driver-step-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const scenarioPath = path.join(tempRoot, 'invalid-tap.json');
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.steps = [
    {
      id: 'tap-card',
      kind: 'gesture',
      driverAction: 'tap',
    },
  ];
  await fsp.writeFile(scenarioPath, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  const calls: string[] = [];

  await assert.rejects(
    runProfileAndroid({
      'adb-capture': true,
      config: fixturePath('examples/mobile-app/asl.config.json'),
      out: path.join(tempRoot, 'profile'),
      'run-id': 'invalid-tap',
      scenario: scenarioPath,
    }, {
      executor: async (command: string, args: string[]): Promise<CommandResult> => {
        calls.push(args.join(' '));
        return { args, command, exitCode: 0, stderr: '', stdout: '' };
      },
    }),
    /Invalid Android adb driver step metadata: step `tap-card` uses driverAction `tap`/u,
  );
  assert.deepEqual(calls, []);
});

test('profile-android validates tap and scroll driver metadata', () => {
  assert.deepEqual(
    validateAndroidAdbDriverSteps([
      { driverAction: 'tap', stepId: 'tap-card', x: 10, y: 20 },
      { driverAction: 'scroll', endX: 100, endY: 200, startX: 100, startY: 800, stepId: 'scroll-list' },
      { driverAction: 'swipe', endX: 300, endY: 400, startX: 100, startY: 200, stepId: 'swipe-card' },
      { driverAction: 'assertVisible', selector: { kind: 'text', value: 'Example' }, stepId: 'assert-visible' },
      { driverAction: 'tap', selector: { kind: 'testId', value: 'card' }, stepId: 'tap-selector' },
      { driverAction: 'scroll', selector: { kind: 'resourceId', value: 'feed' }, stepId: 'scroll-selector' },
    ]),
    [],
  );
  assert.deepEqual(
    validateAndroidAdbDriverSteps([
      { driverAction: 'tap', stepId: 'tap-card' },
      { driverAction: 'scroll', stepId: 'scroll-list', startX: 100, startY: 800 },
      { driverAction: 'swipe', stepId: 'swipe-card', startX: 100, startY: 800 },
      { driverAction: 'assertVisible', stepId: 'assert-visible' },
    ]),
    [
      'step `tap-card` uses driverAction `tap` but is missing adapterOptions.androidAdb.x/y.',
      'step `scroll-list` uses driverAction `scroll` but is missing adapterOptions.androidAdb.startX/startY/endX/endY.',
      'step `swipe-card` uses driverAction `swipe` but is missing adapterOptions.androidAdb.startX/startY/endX/endY.',
      'step `assert-visible` uses driverAction `assertVisible` but is missing a portable selector.',
    ],
  );
});

test('profile-android preserves portable selectors in adb driver steps', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup.json'));
  scenario.steps = [
    {
      id: 'tap-card',
      kind: 'gesture',
      driverAction: 'tap',
      selector: {
        kind: 'testId',
        value: 'example-card-1',
      },
    },
  ];

  assert.deepEqual(resolveAndroidAdbDriverSteps(scenario), [
    {
      driverAction: 'tap',
      required: true,
      selector: {
        kind: 'testId',
        value: 'example-card-1',
      },
      stepId: 'tap-card',
      waitMs: 0,
    },
  ]);
});

test('profile-android starts profile sessions and executes scenario commands during adb capture', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-profile-session-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbCaptureRoot = path.join(tempRoot, 'adb-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (key.includes('profile-session/command')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n' };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
      'devices -l': {
        stdout: [
          'List of devices attached',
          'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
        ].join('\n'),
      },
      '-s emulator-5554 shell getprop ro.product.model': { stdout: 'Pixel 6\n' },
      '-s emulator-5554 shell getprop ro.build.version.release': { stdout: '15\n' },
      '-s emulator-5554 shell getprop ro.build.version.sdk': { stdout: '35\n' },
      '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
        stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
      },
      '-s emulator-5554 logcat -c': { stdout: '' },
      '-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1': {
        stdout: 'Events injected: 1\n',
      },
      '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
        stdout: '1234\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?runId=android-live-open-close&scenario=open-close-cycle' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/command?runId=android-live-open-close&scenario=open-close-cycle&command=activate-target%3Aexample-card-1' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/command?runId=android-live-open-close&scenario=open-close-cycle&command=activate-target%3Aclose-card' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      '-s emulator-5554 logcat -d -v time -t 2800': {
        stdout: fs
          .readFileSync(fixturePath('examples/mobile-app/event-logs/android-open-close-cycle.log'), 'utf8')
          .replace(/android-example-open-close/gu, 'android-live-open-close'),
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

  const result = await runProfileAndroid({
    'adb-capture': true,
    'adb-out': adbCaptureRoot,
    'android-dev-client-url': 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097',
    'android-dev-client-wait-ms': '125',
    'clear-logcat': true,
    config: fixturePath('examples/mobile-app/asl.config.json'),
    launch: true,
    'launch-wait-ms': '500',
    out: profileRoot,
    'profile-session': true,
    'run-id': 'android-live-open-close',
    scenario: fixturePath('examples/mobile-app/scenarios/android/open-close-cycle.json'),
  }, {
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const health = readJson(path.join(result.runDir, 'health.json'));
  const adbHealth = readJson(path.join(adbCaptureRoot, 'health.json'));
  const deepLinkCount = (adbHealth.checks as Array<{ code: string }>)
    .filter((check) => check.code === 'android_deep_link_opened')
    .length;

  assert.equal(result.runDir, path.join(profileRoot, 'open-close-cycle', 'android-live-open-close'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(adbHealth.healthStatus, 'passed');
  assert.equal(deepLinkCount, 7);
  assert.deepEqual(waits, [500, 125, 250, 300, 300, 300, 300, 300, 300, 2800]);
  const firstCommandDeepLink = calls.find((call) => (
    call.includes('profile-session/command') && call.includes('activate-target%3Aexample-card-1')
  ));
  assert.ok(firstCommandDeepLink);
  assert.match(firstCommandDeepLink, /commandId=open\+first\+example\+card/u);
  assert.match(firstCommandDeepLink, /sequence=1/u);
  assert.match(firstCommandDeepLink, /queueId=open-close-cycle/u);
  assert.ok(
    calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097' -p 'dev.agentscenarioloop.example'") <
      calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?runId=android-live-open-close&scenario=open-close-cycle' -p 'dev.agentscenarioloop.example'"),
  );
  assert.ok(
    calls.indexOf('-s emulator-5554 logcat -c') <
      calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?runId=android-live-open-close&scenario=open-close-cycle' -p 'dev.agentscenarioloop.example'"),
  );
  assert.ok(fs.existsSync(path.join(adbCaptureRoot, 'raw', 'adb-startup-deep-link-1.txt')));
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'adb-logcat.txt')));
});

test('profile-android seeds Android scenario commands as one ordered storage queue', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-profile-android-storage-commands-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const adbCaptureRoot = path.join(tempRoot, 'adb-capture');
  const profileRoot = path.join(tempRoot, 'profile');
  const calls: string[] = [];
  const storageWrites: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (key.includes('run-as') && key.includes('sqlite3') && key.includes('databases/RKStorage')) {
      storageWrites.push(key);
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }

    const responses: Record<string, Partial<CommandResult>> = {
      version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
      'devices -l': {
        stdout: [
          'List of devices attached',
          'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
        ].join('\n'),
      },
      '-s emulator-5554 shell getprop ro.product.model': { stdout: 'Pixel 6\n' },
      '-s emulator-5554 shell getprop ro.build.version.release': { stdout: '15\n' },
      '-s emulator-5554 shell getprop ro.build.version.sdk': { stdout: '35\n' },
      '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
        stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
      },
      '-s emulator-5554 shell date +%s': { stdout: '1800000000\n' },
      '-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1': {
        stdout: 'Events injected: 1\n',
      },
      '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
        stdout: '1234\n',
      },
      '-s emulator-5554 logcat -d -v time -t 2800': {
        stdout: Array.from({ length: 2800 }, (_value, index) => (
          `2026-01-01T00:00:00.${String(index).padStart(3, '0')}Z public-android noisy media line ${index}`
        )).join('\n'),
      },
      '-s emulator-5554 logcat -d -v time -t 10000': {
        stdout: [
          '2026-01-01T00:00:00.000Z public-android [profile-session] kind=start scenario=open-close-cycle runId=android-storage-open-close startedAt=1800000000000 timestamp=1800000000000 atMs=0',
          '2026-01-01T00:00:00.050Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:example-card-1 commandId=open-card queueId=open-close-cycle sequence=1 source=storage status=received atMs=50 waitForMilestone=card_opened waitMs=300 waitTimeoutMs=1500',
          '2026-01-01T00:00:00.070Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:example-card-1 commandId=open-card queueId=open-close-cycle sequence=1 source=storage status=delivered result=target-dispatched atMs=70 waitForMilestone=card_opened waitMs=300 waitTimeoutMs=1500',
          '2026-01-01T00:00:00.820Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:close-card commandId=close-card queueId=open-close-cycle sequence=2 source=storage status=received atMs=820 waitMs=300',
          '2026-01-01T00:00:00.850Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:close-card commandId=close-card queueId=open-close-cycle sequence=2 source=storage status=completed result=target-dispatched atMs=850 waitMs=300',
          '2026-01-01T00:00:02.020Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:example-card-1 commandId=open-card queueId=open-close-cycle sequence=3 source=storage status=received atMs=2020 waitForMilestone=card_opened waitMs=300 waitTimeoutMs=1500',
          '2026-01-01T00:00:02.050Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:example-card-1 commandId=open-card queueId=open-close-cycle sequence=3 source=storage status=completed result=target-dispatched atMs=2050 waitForMilestone=card_opened waitMs=300 waitTimeoutMs=1500',
          '2026-01-01T00:00:02.900Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:close-card commandId=close-card queueId=open-close-cycle sequence=4 source=storage status=received atMs=2900 waitMs=300',
          '2026-01-01T00:00:02.930Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:close-card commandId=close-card queueId=open-close-cycle sequence=4 source=storage status=completed result=target-dispatched atMs=2930 waitMs=300',
          '2026-01-01T00:00:04.020Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:example-card-1 commandId=open-card queueId=open-close-cycle sequence=5 source=storage status=received atMs=4020 waitForMilestone=card_opened waitMs=300 waitTimeoutMs=1500',
          '2026-01-01T00:00:04.050Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:example-card-1 commandId=open-card queueId=open-close-cycle sequence=5 source=storage status=completed result=target-dispatched atMs=4050 waitForMilestone=card_opened waitMs=300 waitTimeoutMs=1500',
          '2026-01-01T00:00:04.900Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:close-card commandId=close-card queueId=open-close-cycle sequence=6 source=storage status=received atMs=4900 waitMs=300',
          '2026-01-01T00:00:04.930Z public-android [profile-session] kind=command scenario=open-close-cycle runId=android-storage-open-close command=activate-target:close-card commandId=close-card queueId=open-close-cycle sequence=6 source=storage status=completed result=target-dispatched atMs=4930 waitMs=300',
          fs
            .readFileSync(fixturePath('examples/mobile-app/event-logs/android-open-close-cycle.log'), 'utf8')
            .replace(/android-example-open-close/gu, 'android-storage-open-close'),
        ].join('\n'),
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

  const result = await runProfileAndroid({
    'adb-capture': true,
    'adb-out': adbCaptureRoot,
    config: fixturePath('examples/mobile-app/asl.config.json'),
    launch: true,
    'launch-wait-ms': '500',
    out: profileRoot,
    'profile-session': true,
    'android-profile-session-storage': true,
    'run-id': 'android-storage-open-close',
    scenario: fixturePath('examples/mobile-app/scenarios/android/open-close-cycle.json'),
    'wait-ms': '25',
  }, {
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const health = readJson(path.join(result.runDir, 'health.json'));
  const adbHealth = readJson(path.join(adbCaptureRoot, 'health.json'));
  const adbMetadata = readJson(path.join(adbCaptureRoot, 'raw', 'android-metadata.json')) as Record<string, any>;
  const causalRun = readJson(path.join(result.runDir, 'causal-run.json')) as Record<string, any>;
  const commandQueueWrite = storageWrites.find((write) => (
    write.includes('INSERT OR REPLACE INTO catalystLocalStorage')
    && write.includes('agent-scenario-loop.profile-commands.1')
    && write.includes('activate-target:example-card-1')
  ));

  assert.equal(health.healthStatus, 'passed');
  assert.equal(adbHealth.healthStatus, 'passed');
  assert.equal(storageWrites.length, 2);
  assert.ok(commandQueueWrite);
  assert.match(commandQueueWrite, /activate-target:example-card-1/u);
  assert.match(commandQueueWrite, /activate-target:close-card/u);
  assert.match(commandQueueWrite, /"commandId":"open first example card"/u);
  assert.match(commandQueueWrite, /"commandId":"close example card"/u);
  assert.match(commandQueueWrite, /"timestamp":1800000000001/u);
  assert.match(commandQueueWrite, /"timestamp":1800000000002/u);
  assert.match(commandQueueWrite, /"timestamp":1800000000006/u);
  assert.match(commandQueueWrite, /"sequence":1/u);
  assert.match(commandQueueWrite, /"sequence":6/u);
  assert.match(commandQueueWrite, /"queueId":"open-close-cycle"/u);
  assert.doesNotMatch(commandQueueWrite, /DELETE FROM catalystLocalStorage WHERE key='agent-scenario-loop\.profile-commands\.1'.*DELETE FROM catalystLocalStorage WHERE key='agent-scenario-loop\.profile-commands\.1'/u);
  const commandTimeline = causalRun.timeline.filter((event: Record<string, any>) => (
    event.owner === 'asl-command-transport'
  ));
  const sequencingEvidence = causalRun.timeline
    .filter((event: Record<string, any>) => (
      (event.owner === 'asl-command-transport'
        && ['open-card', 'close-card'].includes(event.metadata?.commandId)
        && [1, 2, 3, 4].includes(event.metadata?.sequence))
      || (event.name === 'card_opened' && [1, 2].includes(event.metadata?.iteration))
    ))
    .map((event: Record<string, any>) => ({
      atMs: event.atMs,
      commandId: event.metadata?.commandId,
      name: event.name,
      sequence: event.metadata?.sequence,
    }));
  assert.deepEqual(sequencingEvidence, [
    { atMs: 50, commandId: 'open-card', name: 'profile_command_received', sequence: 1 },
    { atMs: 70, commandId: 'open-card', name: 'profile_command_delivered', sequence: 1 },
    { atMs: 420, commandId: undefined, name: 'card_opened', sequence: undefined },
    { atMs: 820, commandId: 'close-card', name: 'profile_command_received', sequence: 2 },
    { atMs: 850, commandId: 'close-card', name: 'profile_command_completed', sequence: 2 },
    { atMs: 2020, commandId: 'open-card', name: 'profile_command_received', sequence: 3 },
    { atMs: 2050, commandId: 'open-card', name: 'profile_command_completed', sequence: 3 },
    { atMs: 2450, commandId: undefined, name: 'card_opened', sequence: undefined },
    { atMs: 2900, commandId: 'close-card', name: 'profile_command_received', sequence: 4 },
    { atMs: 2930, commandId: 'close-card', name: 'profile_command_completed', sequence: 4 },
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
  assert.deepEqual(commandTimeline.map((event: Record<string, any>) => ({
    name: event.name,
    status: event.status,
    commandId: event.metadata.commandId,
    sequence: event.metadata.sequence,
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
      name: 'profile_command_delivered',
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
    {
      commandId: 'open-card',
      name: 'profile_command_received',
      sequence: 5,
      status: 'started',
      waitForMilestone: 'card_opened',
      waitMs: 300,
      waitTimeoutMs: 1500,
    },
    {
      commandId: 'open-card',
      name: 'profile_command_completed',
      sequence: 5,
      status: 'completed',
      waitForMilestone: 'card_opened',
      waitMs: 300,
      waitTimeoutMs: 1500,
    },
    {
      commandId: 'close-card',
      name: 'profile_command_received',
      sequence: 6,
      status: 'started',
      waitForMilestone: undefined,
      waitMs: 300,
      waitTimeoutMs: undefined,
    },
    {
      commandId: 'close-card',
      name: 'profile_command_completed',
      sequence: 6,
      status: 'completed',
      waitForMilestone: undefined,
      waitMs: 300,
      waitTimeoutMs: undefined,
    },
  ]);
  assert.deepEqual(waits, [500, 250, 1800]);
  assert.ok(calls.some((call) => call.includes('logcat -d -v time -t 10000')));
  assert.deepEqual(adbMetadata.profileSessionCompletionWait, {
    completed: true,
    elapsedMs: adbMetadata.profileSessionCompletionWait.elapsedMs,
    expectedCommandCount: 6,
    milestoneBackedSequences: [1],
    observedTerminalCommands: 6,
    pollCount: 1,
    rawPath: 'raw/adb-profile-session-early-log-1.txt',
    started: true,
    terminalSequences: [1, 2, 3, 4, 5, 6],
  });
  assert.ok(fs.existsSync(path.join(adbCaptureRoot, 'raw', 'adb-profile-session-early-log-1.txt')));
  const commandQueueWritePath = path.join(adbCaptureRoot, 'raw', 'adb-async-storage-write-2.txt');
  assert.ok(fs.existsSync(commandQueueWritePath));
  const commandQueueWriteArtifact = fs.readFileSync(commandQueueWritePath, 'utf8');
  assert.match(commandQueueWriteArtifact, /"waitMs":300/u);
});

test('profile-android derives adb capture waits from scenario execution windows', () => {
  const startup = readJson(fixturePath('examples/mobile-app/scenarios/mobile/app-startup.json'));
  const openClose = readJson(fixturePath('examples/mobile-app/scenarios/mobile/open-close-cycle.json'));
  const scroll = readJson(fixturePath('examples/mobile-app/scenarios/mobile/scroll-settle.json'));
  const longStartup = {
    ...startup,
    steps: [
      { id: 'launch', kind: 'launch' },
      {
        id: 'wait-for-first-usable',
        kind: 'waitForMilestone',
        milestone: 'firstUsable',
        timeoutMs: 120000,
      },
    ],
  };

  assert.equal(deriveProfileSessionCaptureWaitMs(startup), 9000);
  assert.equal(deriveProfileSessionCaptureWaitMs(openClose), 17800);
  assert.equal(deriveProfileSessionCaptureWaitMs(scroll), 9400);
  assert.equal(deriveProfileSessionCaptureWaitMs(longStartup), 120000);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: { 'wait-ms': '25' },
    profileSessionEnabled: true,
    scenario: startup,
  }), 25);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: {},
    profileSessionEnabled: true,
    profileSessionStorageEnabled: true,
    scenario: startup,
  }), 23000);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: {},
    profileSessionEnabled: false,
    scenario: startup,
  }), 0);
});

test('profile-android derives profile-session logcat lines from command count', () => {
  assert.equal(deriveProfileSessionLogcatLines({
    commands: [],
    profileSessionEnabled: true,
  }), 1000);
  assert.equal(deriveProfileSessionLogcatLines({
    commands: Array.from({ length: 6 }, (_, index) => ({
      command: `command-${index + 1}`,
      id: `command-${index + 1}`,
    })),
    profileSessionEnabled: true,
  }), 2800);
  assert.equal(deriveProfileSessionLogcatLines({
    commands: Array.from({ length: 19 }, (_, index) => ({
      command: `command-${index + 1}`,
      id: `command-${index + 1}`,
    })),
    profileSessionEnabled: true,
  }), 6700);
  assert.equal(deriveProfileSessionLogcatLines({
    commands: Array.from({ length: 100 }, (_, index) => ({
      command: `command-${index + 1}`,
      id: `command-${index + 1}`,
    })),
    profileSessionEnabled: true,
  }), 20000);
});

test('profile-android derives commands from normalized execution-plan steps', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/open-close-cycle.json'));
  delete scenario.adapterOptions;
  scenario.defaultIterations = 2;
  scenario.steps = [
    {
      id: 'open-card',
      kind: 'command',
      command: 'activate-target:example-card-1',
      adapterOptions: {
        androidAdb: {
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

  assert.deepEqual(resolveAndroidAdbProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', commandId: 'open-card', label: 'open-card', queueId: 'open-close-cycle', sequence: 1, waitForMilestone: 'card_opened', waitMs: 125, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close-card', label: 'close-card', queueId: 'open-close-cycle', sequence: 2, waitMs: 225 },
    { command: 'activate-target:example-card-1', commandId: 'open-card', label: 'open-card', queueId: 'open-close-cycle', sequence: 3, waitForMilestone: 'card_opened', waitMs: 125, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close-card', label: 'close-card', queueId: 'open-close-cycle', sequence: 4, waitMs: 225 },
  ]);
});

test('profile-android runs readiness setup commands once before repeated cycle commands', () => {
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

  assert.deepEqual(resolveAndroidAdbProfileCommands(scenario), [
    { command: 'reset-surface', commandId: 'reset-surface', label: 'reset-surface', queueId: 'ready-scroll-cycle', sequence: 1, waitForMilestone: 'surface_ready', waitMs: 0, waitTimeoutMs: 120000 },
    { command: 'scroll-by:600', commandId: 'scroll-surface', label: 'scroll-surface', queueId: 'ready-scroll-cycle', sequence: 2, waitForMilestone: 'surface_settled', waitMs: 0, waitTimeoutMs: 8000 },
    { command: 'scroll-by:600', commandId: 'scroll-surface', label: 'scroll-surface', queueId: 'ready-scroll-cycle', sequence: 3, waitForMilestone: 'surface_settled', waitMs: 0, waitTimeoutMs: 8000 },
    { command: 'scroll-by:600', commandId: 'scroll-surface', label: 'scroll-surface', queueId: 'ready-scroll-cycle', sequence: 4, waitForMilestone: 'surface_settled', waitMs: 0, waitTimeoutMs: 8000 },
  ]);
});

test('profile-android runs leading non-measured setup commands once before repeated cycle commands', () => {
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

  assert.deepEqual(resolveAndroidAdbProfileCommands(scenario), [
    { command: 'reset-home-surface', commandId: 'reset-home-surface', label: 'reset-home-surface', queueId: 'account-drawer-stress', sequence: 1, waitMs: 0 },
    { command: 'open-account-drawer', commandId: 'open-account-drawer', label: 'open-account-drawer', queueId: 'account-drawer-stress', sequence: 2, waitForMilestone: 'account_drawer_open_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'activate-target:account-drawer-close', commandId: 'close-account-drawer', label: 'close-account-drawer', queueId: 'account-drawer-stress', sequence: 3, waitForMilestone: 'account_drawer_close_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'open-account-drawer', commandId: 'open-account-drawer', label: 'open-account-drawer', queueId: 'account-drawer-stress', sequence: 4, waitForMilestone: 'account_drawer_open_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'activate-target:account-drawer-close', commandId: 'close-account-drawer', label: 'close-account-drawer', queueId: 'account-drawer-stress', sequence: 5, waitForMilestone: 'account_drawer_close_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'open-account-drawer', commandId: 'open-account-drawer', label: 'open-account-drawer', queueId: 'account-drawer-stress', sequence: 6, waitForMilestone: 'account_drawer_open_settled', waitMs: 0, waitTimeoutMs: 10000 },
    { command: 'activate-target:account-drawer-close', commandId: 'close-account-drawer', label: 'close-account-drawer', queueId: 'account-drawer-stress', sequence: 7, waitForMilestone: 'account_drawer_close_settled', waitMs: 0, waitTimeoutMs: 10000 },
  ]);
});

test('profile-android honors explicit cycle body step ids', () => {
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

  assert.deepEqual(resolveAndroidAdbProfileCommands(scenario), [
    { command: 'reset-surface', commandId: 'reset-surface', label: 'reset-surface', queueId: 'explicit-body-cycle', sequence: 1, waitMs: 0 },
    { command: 'open-surface', commandId: 'open-surface', label: 'open-surface', queueId: 'explicit-body-cycle', sequence: 2, waitForMilestone: 'surface_opened', waitMs: 0, waitTimeoutMs: 1000 },
    { command: 'close-surface', commandId: 'close-surface', label: 'close-surface', queueId: 'explicit-body-cycle', sequence: 3, waitForMilestone: 'surface_closed', waitMs: 0, waitTimeoutMs: 1000 },
    { command: 'open-surface', commandId: 'open-surface', label: 'open-surface', queueId: 'explicit-body-cycle', sequence: 4, waitForMilestone: 'surface_opened', waitMs: 0, waitTimeoutMs: 1000 },
    { command: 'close-surface', commandId: 'close-surface', label: 'close-surface', queueId: 'explicit-body-cycle', sequence: 5, waitForMilestone: 'surface_closed', waitMs: 0, waitTimeoutMs: 1000 },
  ]);
});

test('profile-android applies execution-plan wait gates to adb adapter commands', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/open-close-cycle.json')) as Record<string, any>;
  scenario.defaultIterations = 2;
  scenario.adapterOptions.androidAdb.repeat = 2;
  scenario.adapterOptions.androidAdb.commands = [
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

  assert.deepEqual(resolveAndroidAdbProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 1, waitForMilestone: 'card_opened', waitMs: 300, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 2, waitForMilestone: 'card_dismissed', waitMs: 300, waitTimeoutMs: 1200 },
    { command: 'activate-target:example-card-1', commandId: 'open first example card', label: 'open first example card', queueId: 'open-close-cycle', sequence: 3, waitForMilestone: 'card_opened', waitMs: 300, waitTimeoutMs: 1500 },
    { command: 'activate-target:close-card', commandId: 'close example card', label: 'close example card', queueId: 'open-close-cycle', sequence: 4, waitForMilestone: 'card_dismissed', waitMs: 300, waitTimeoutMs: 1200 },
  ]);
});

test('profile-android derives adb driver steps from normalized execution-plan evidence steps', () => {
  const scenario = {
    id: 'startup',
    steps: [
      {
        id: 'capture-log-window',
        kind: 'captureEvidence',
        artifact: 'logs',
        driverAction: 'readLogs',
        adapterOptions: {
          androidAdb: {
            logcatLines: 40,
          },
        },
        timeoutMs: 125,
      },
      {
        id: 'optional-log-window',
        kind: 'captureEvidence',
        artifact: 'logs',
        driverAction: 'readLogs',
        required: false,
      },
    ],
  };

  assert.deepEqual(resolveAndroidAdbDriverSteps(scenario), [
    {
      driverAction: 'readLogs',
      lines: 40,
      rawFileName: 'adb-logcat.txt',
      required: true,
      stepId: 'capture-log-window',
      waitMs: 125,
    },
    {
      driverAction: 'readLogs',
      lines: 1000,
      rawFileName: 'adb-logcat-2.txt',
      required: false,
      stepId: 'optional-log-window',
      waitMs: 0,
    },
  ]);
});

test('profile-android derives portable adb driver actions from scenario metadata', () => {
  const scenario = {
    id: 'ui-actions',
    steps: [
      {
        id: 'tap-card',
        kind: 'gesture',
        driverAction: 'tap',
        adapterOptions: {
          androidAdb: {
            x: 120,
            y: 240,
          },
        },
      },
      {
        id: 'scroll-feed',
        kind: 'gesture',
        driverAction: 'scroll',
        adapterOptions: {
          androidAdb: {
            durationMs: 350,
            endX: 500,
            endY: 400,
            startX: 500,
            startY: 1400,
          },
        },
      },
      {
        id: 'inspect-final',
        kind: 'captureEvidence',
        artifact: 'uiTree',
        driverAction: 'inspectTree',
      },
      {
        id: 'assert-final',
        kind: 'assertUi',
        driverAction: 'assertVisible',
        adapterOptions: {
          androidAdb: {
            waitMs: 125,
          },
        },
        selector: { kind: 'text', value: 'Example' },
        timeoutMs: 1500,
      },
      {
        id: 'capture-final',
        kind: 'captureEvidence',
        artifact: 'screenshot',
        driverAction: 'screenshot',
        required: false,
      },
      {
        id: 'record-final',
        kind: 'captureEvidence',
        artifact: 'video',
        driverAction: 'record',
        adapterOptions: {
          androidAdb: {
            captureFileName: 'record-final.mp4',
            durationSeconds: 3,
            rawFileName: 'record-final.txt',
            remotePath: '/sdcard/record-final.mp4',
          },
        },
      },
    ],
  };

  assert.deepEqual(resolveAndroidAdbDriverSteps(scenario), [
    {
      driverAction: 'tap',
      required: true,
      stepId: 'tap-card',
      waitMs: 0,
      x: 120,
      y: 240,
    },
    {
      driverAction: 'scroll',
      durationMs: 350,
      endX: 500,
      endY: 400,
      required: true,
      startX: 500,
      startY: 1400,
      stepId: 'scroll-feed',
      waitMs: 0,
    },
    {
      driverAction: 'inspectTree',
      required: true,
      stepId: 'inspect-final',
      waitMs: 0,
    },
    {
      driverAction: 'assertVisible',
      required: true,
      selector: { kind: 'text', value: 'Example' },
      stepId: 'assert-final',
      timeoutMs: 1500,
      waitMs: 125,
    },
    {
      driverAction: 'screenshot',
      required: false,
      stepId: 'capture-final',
      waitMs: 0,
    },
    {
      captureFileName: 'record-final.mp4',
      driverAction: 'record',
      durationSeconds: 3,
      rawFileName: 'record-final.txt',
      remotePath: '/sdcard/record-final.mp4',
      required: true,
      stepId: 'record-final',
      waitMs: 0,
    },
  ]);
});
