const assert = require('node:assert/strict');
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
  resolveAndroidAdbDriverSteps,
  resolveAndroidAdbProfileCommands,
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
  ]);

  const runDir = stdout.trim();
  const manifest = readJson(path.join(runDir, 'manifest.json'));
  const health = readJson(path.join(runDir, 'health.json'));
  const verdict = readJson(path.join(runDir, 'verdict.json'));
  const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

  assert.equal(runDir, path.join(artifactRoot, 'app-startup', 'android-example-startup'));
  assert.equal(manifest.platform, 'android');
  assert.equal(manifest.bundleId, 'dev.agentscenarioloop.example');
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  assert.match(summary, /Scenario health passed/u);
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
    signals: { js: string[]; network: string[] };
  };

  assert.deepEqual(artifacts.signals.js, ['signals/js/js-profile.json']);
  assert.deepEqual(artifacts.signals.network, ['signals/network/network-capture.har']);
  assert.equal(artifacts.captures.uiTree, 'captures/ui-tree-provider.json');
  assert.ok(fs.existsSync(path.join(runDir, 'signals', 'js', 'js-profile.json')));
  assert.ok(fs.existsSync(path.join(runDir, 'signals', 'network', 'network-capture.har')));
  assert.ok(fs.existsSync(path.join(runDir, 'captures', 'ui-tree-provider.json')));
  assert.deepEqual((metrics.artifacts as { signals: { js: string[] } }).signals.js, ['signals/js/js-profile.json']);
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
  assert.equal((causalRun.scenario as { driver: string }).driver, 'adb-logcat');
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'passed');
  assert.ok(fs.existsSync(path.join(runDir, 'raw', 'adb-logcat.txt')));
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
  assert.equal((manifest.artifacts as { raw: { interactionLog: string } }).raw.interactionLog, 'raw/adb-logcat.txt');
  assert.equal(manifest.interactionDriver, 'adb-logcat');
  assert.equal((causalRun.scenario as { driver: string }).driver, 'adb-logcat');
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'adb-logcat.txt')));
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
    ]),
    [],
  );
  assert.deepEqual(
    validateAndroidAdbDriverSteps([
      { driverAction: 'tap', stepId: 'tap-card' },
      { driverAction: 'scroll', stepId: 'scroll-list', startX: 100, startY: 800 },
    ]),
    [
      'step `tap-card` uses driverAction `tap` but is missing adapterOptions.androidAdb.x/y.',
      'step `scroll-list` uses driverAction `scroll` but is missing adapterOptions.androidAdb.startX/startY/endX/endY.',
    ],
  );
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
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?runId=android-live-open-close&scenario=open-close-cycle' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/command?runId=android-live-open-close&scenario=open-close-cycle&command=activate-target%3Aexample-card-1' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/command?runId=android-live-open-close&scenario=open-close-cycle&command=activate-target%3Aclose-card' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      '-s emulator-5554 logcat -d -v time -t 1000': {
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
    'clear-logcat': true,
    config: fixturePath('examples/mobile-app/asl.config.json'),
    launch: true,
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
  assert.deepEqual(waits, [250, 300, 300, 300, 300, 300, 300]);
  assert.ok(
    calls.indexOf('-s emulator-5554 logcat -c') <
      calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?runId=android-live-open-close&scenario=open-close-cycle' -p 'dev.agentscenarioloop.example'"),
  );
  assert.ok(fs.existsSync(path.join(result.runDir, 'raw', 'adb-logcat.txt')));
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
      id: 'close-card',
      kind: 'command',
      command: 'activate-target:close-card',
      timeoutMs: 225,
    },
  ];

  assert.deepEqual(resolveAndroidAdbProfileCommands(scenario), [
    { command: 'activate-target:example-card-1', label: 'open-card', waitMs: 125 },
    { command: 'activate-target:close-card', label: 'close-card', waitMs: 225 },
    { command: 'activate-target:example-card-1', label: 'open-card', waitMs: 125 },
    { command: 'activate-target:close-card', label: 'close-card', waitMs: 225 },
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
        id: 'capture-final',
        kind: 'captureEvidence',
        artifact: 'screenshot',
        driverAction: 'screenshot',
        required: false,
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
      driverAction: 'screenshot',
      required: false,
      stepId: 'capture-final',
      waitMs: 0,
    },
  ]);
});
