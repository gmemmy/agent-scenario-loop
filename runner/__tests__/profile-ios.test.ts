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
  resolveIosSimctlProfileCommands,
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
