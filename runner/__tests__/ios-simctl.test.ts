const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  asyncStorageFileNameForKey,
  formatStoredProfileEventLog,
  parseArgs,
  parseSimctlDevices,
  readAsyncStorageValueSync,
  resolveAsyncStorageDirectory,
  runIosSimctlCapture,
  seedProfileSessionStorage,
  selectSimulator,
} = require('../ios-simctl');

type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};
type TestContext = import('node:test').TestContext;

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

test('parses and selects booted iOS simulators', () => {
  const simulators = parseSimctlDevices([
    '== Devices ==',
    '-- iOS 26.3 --',
    '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
    '    iPhone 17e (209480D9-7F23-4C6D-911E-52B228783B69) (Shutdown)',
    '',
  ].join('\n'));

  assert.deepEqual(simulators[0], {
    name: 'iPhone 17 Pro Max',
    state: 'Booted',
    udid: 'A692ED28-893E-453F-8866-C69331AE757F',
  });
  assert.equal(selectSimulator(simulators, null)?.udid, 'A692ED28-893E-453F-8866-C69331AE757F');
  assert.equal(selectSimulator(simulators, '209480D9-7F23-4C6D-911E-52B228783B69')?.state, 'Shutdown');
});

test('ignores package-manager argument separator', () => {
  assert.deepEqual(parseArgs(['--', '--xcrun', 'fake-xcrun', '--run-id', 'run-1']), {
    xcrun: 'fake-xcrun',
    'run-id': 'run-1',
  });
});

test('captures bounded iOS simulator log evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
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
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?scenario=app-startup&runId=ios-live': {
        stdout: '',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: '[profile-event] scenario=app-startup runId=ios-live event=home_ready timestamp=1\n',
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

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
      },
    ],
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-live',
    waitMs: 250,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.deepEqual(waits, [250]);
  assert.ok(fs.readFileSync(path.join(outputDir, 'raw', 'ios-simctl-log.txt'), 'utf8').includes('[profile-event]'));
  assert.ok(calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') < calls.indexOf('simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?scenario=app-startup&runId=ios-live'));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'ios_logs_captured'),
  );
});

test('seeds profile-session AsyncStorage while preserving unrelated app keys', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({
    'agent-scenario-loop.profile-events.1': null,
    'unrelated.key': 'keep-me',
  }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1')), '[]', 'utf8');

  await seedProfileSessionStorage({
    bundleId: 'dev.agent-scenario-loop.example',
    commands: [
      { command: 'activate-target:example-card-1', id: 'open-card' },
      { command: 'activate-target:close-card', id: 'close-card' },
    ],
    dataContainer,
    runId: 'ios-live-startup',
    scenario: 'app-startup',
    startedAt: 123,
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
  const session = JSON.parse(manifest['agent-scenario-loop.profile-session.1']);
  const commands = JSON.parse(manifest['agent-scenario-loop.profile-commands.1']);

  assert.equal(manifest['unrelated.key'], 'keep-me');
  assert.equal(manifest['agent-scenario-loop.profile-events.1'], undefined);
  assert.equal(fs.existsSync(path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1'))), false);
  assert.deepEqual(session, {
    active: true,
    scenario: 'app-startup',
    runId: 'ios-live-startup',
    startedAt: 123,
  });
  assert.deepEqual(commands, [
    {
      id: 'open-card',
      scenario: 'app-startup',
      runId: 'ios-live-startup',
      command: 'activate-target:example-card-1',
      timestamp: 124,
    },
    {
      id: 'close-card',
      scenario: 'app-startup',
      runId: 'ios-live-startup',
      command: 'activate-target:close-card',
      timestamp: 125,
    },
  ]);
});

test('reads inline and spilled AsyncStorage profile event values', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-read-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  const eventKey = 'agent-scenario-loop.profile-events.1';
  const spilledValue = JSON.stringify([
    { event: 'home_ready', scenario: 'app-startup', runId: 'ios-live-startup', timestamp: 123 },
  ]);
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({ [eventKey]: null }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey(eventKey)), spilledValue, 'utf8');

  assert.equal(readAsyncStorageValueSync({ key: eventKey, storageDir }), spilledValue);
  assert.ok(formatStoredProfileEventLog(JSON.parse(spilledValue)).includes('[profile-event] {"event":"home_ready"'));
});

test('captures stored iOS profile events from app data container', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-storage-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-data-container-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
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
        stderr: 'The operation couldn\'t be completed. No such process\n',
        exitCode: 3,
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
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

  const wait = async () => {
    const storageDir = resolveAsyncStorageDirectory({
      bundleId: 'dev.agent-scenario-loop.example',
      dataContainer,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
    manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify([
      {
        event: 'home_ready',
        scenario: 'app-startup',
        runId: 'ios-live-startup',
        timestamp: 123,
      },
    ]);
    fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    delay: wait,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    profileSessionStorage: {
      runId: 'ios-live-startup',
      scenario: 'app-startup',
      startedAt: 123,
    },
    runId: 'ios-live-startup',
    terminateBeforeLaunch: true,
    waitMs: 25,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(calls.indexOf('simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') < calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'));
  assert.ok(
    fs
      .readFileSync(path.join(outputDir, 'raw', 'ios-profile-events.log'), 'utf8')
      .includes('[profile-event] {"event":"home_ready"'),
  );
  const metadataText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8');
  const seedText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-seed.json'), 'utf8');
  assert.match(seedText, /ios-live-startup/u);
  assert.equal(metadataText.includes(dataContainer), false);
  assert.equal(seedText.includes(dataContainer), false);
});
