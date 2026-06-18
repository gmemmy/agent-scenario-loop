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
  assert.equal(causalRun.scenario.id, 'public-journey');
  assert.deepEqual(causalRun.budgets, {
    cycleP95Ms: { limit: 8000, metric: 'cycleP95Ms', unit: 'ms' },
    failures: { limit: 0, metric: 'failures', unit: 'count' },
  });
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

test('profile-ios maps schema-era open and close milestone budgets', async (t: TestContext) => {
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
  assert.deepEqual(causalRun.budgets, {
    closeP95Ms: { limit: 120, metric: 'closeP95Ms', unit: 'ms' },
    openP95Ms: { limit: 200, metric: 'openP95Ms', unit: 'ms' },
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
      fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    },
    executor,
  });

  const manifest = readJson(path.join(result.runDir, 'manifest.json'));
  const health = readJson(path.join(result.runDir, 'health.json'));
  const simctlHealth = readJson(path.join(simctlCaptureRoot, 'health.json'));

  assert.equal(health.healthStatus, 'passed');
  assert.equal(simctlHealth.healthStatus, 'passed');
  assert.equal((manifest.artifacts as { raw: { interactionLog: string } }).raw.interactionLog, 'raw/ios-profile-events.log');
  assert.ok(calls.includes('simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'));
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'ios-profile-events.log')));
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
  const seed = readJson(path.join(simctlCaptureRoot, 'raw', 'ios-profile-session-seed.json'));

  assert.equal(health.healthStatus, 'passed');
  assert.equal((seed.commands as unknown[]).length, 6);
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
  assert.match(openUrlCalls[2] as string, /command=activate-target%3Aclose-card/u);
  assert.equal((metadata.deepLinkResults as unknown[]).length, 7);
  assert.deepEqual((metadata.deepLinkResults as Array<Record<string, unknown>>)[1], {
    args: firstCommandOpenUrl.split(' '),
    exitCode: 0,
    label: 'open first example card',
    rawPath: 'raw/ios-deep-link-2.txt',
    url: 'asl-example://profile-session/command?runId=ios-deep-link-open-close&scenario=open-close-cycle&command=activate-target%3Aexample-card-1',
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

  assert.equal(health.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.deepEqual(causalRun.timeline, []);
});

test('profile-ios derives storage capture waits from scenario execution windows', () => {
  const startup = readJson(fixturePath('examples/mobile-app/scenarios/mobile/app-startup.json'));
  const openClose = readJson(fixturePath('examples/mobile-app/scenarios/mobile/open-close-cycle.json'));
  const scroll = readJson(fixturePath('examples/mobile-app/scenarios/mobile/scroll-settle.json'));

  assert.equal(deriveProfileSessionCaptureWaitMs(startup), 9000);
  assert.equal(deriveProfileSessionCaptureWaitMs(openClose), 17800);
  assert.equal(deriveProfileSessionCaptureWaitMs(scroll), 9400);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: { 'wait-ms': '25' },
    profileSessionEnabled: true,
    scenario: startup,
  }), 25);
  assert.equal(resolveProfileSessionCaptureWaitMs({
    args: {},
    profileSessionEnabled: false,
    scenario: startup,
  }), 0);
});

test('profile-ios derives simctl commands from scenario adapter metadata', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/ios/open-close-cycle.json'));

  assert.deepEqual(resolveIosSimctlProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', label: 'open first example card', waitMs: 300 },
    { command: 'activate-target:close-card', label: 'close example card', waitMs: 300 },
    { command: 'activate-target:example-card-1', label: 'open first example card', waitMs: 300 },
    { command: 'activate-target:close-card', label: 'close example card', waitMs: 300 },
    { command: 'activate-target:example-card-1', label: 'open first example card', waitMs: 300 },
    { command: 'activate-target:close-card', label: 'close example card', waitMs: 300 },
  ]);
});
