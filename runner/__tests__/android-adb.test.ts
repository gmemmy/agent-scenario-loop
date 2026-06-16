const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseAdbDevices,
  parseArgs,
  runAndroidAdbPreflight,
  selectDevice,
} = require('../android-adb');

type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};
type TestContext = import('node:test').TestContext;

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

test('parses and selects online adb devices', () => {
  const devices = parseAdbDevices([
    'List of devices attached',
    'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
    'offline-1 offline usb:1-1',
    '',
  ].join('\n'));

  assert.deepEqual(devices[0], {
    serial: 'emulator-5554',
    state: 'device',
    description: 'product:sdk_gphone model:Pixel_6 device:emu64',
  });
  assert.equal(selectDevice(devices, null)?.serial, 'emulator-5554');
  assert.equal(selectDevice(devices, 'offline-1')?.state, 'offline');
});

test('ignores package-manager argument separator', () => {
  assert.deepEqual(parseArgs(['--', '--adb', 'fake-adb', '--run-id', 'run-1']), {
    adb: 'fake-adb',
    'run-id': 'run-1',
  });
});

test('writes passed health for an online adb device and installed package', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
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
    '-s emulator-5554 shell pm path com.example.app': { stdout: 'package:/data/app/com.example.app/base.apk\n' },
  });

  const result = await runAndroidAdbPreflight({
    adbPath: 'fake-adb',
    executor,
    outputDir,
    packageName: 'com.example.app',
    runId: 'android-run-1',
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.equal(result.verdict.verdictStatus, 'not_evaluated');
  assert.equal(result.device?.serial, 'emulator-5554');
  assert.equal(result.metadata.packageName, 'com.example.app');
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-devices.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'android-metadata.json')));
  assert.match(fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8'), /Scenario health passed/u);
});

test('captures bounded adb logcat evidence when requested', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-logcat-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
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
    '-s emulator-5554 logcat -d -v time -t 25': {
      stdout: '06-16 10:00:00.000 I/ReactNativeJS(123): [profile-event] {"event":"home_ready"}\n',
    },
  });

  const result = await runAndroidAdbPreflight({
    captureLogcat: true,
    executor,
    logcatLines: 25,
    outputDir,
    runId: 'android-run-logcat',
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.ok(fs.readFileSync(path.join(outputDir, 'raw', 'adb-logcat.txt'), 'utf8').includes('[profile-event]'));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_logcat_captured'),
  );
});

test('clears logs, launches package, waits, and captures a bounded Android window', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-window-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
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
      '-s emulator-5554 logcat -d -v time -t 50': {
        stdout: '06-16 10:00:00.000 I/ReactNativeJS(123): [profile-event] {"event":"app_ready"}\n',
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

  const result = await runAndroidAdbPreflight({
    captureLogcat: true,
    clearLogcat: true,
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    launch: true,
    logcatLines: 50,
    outputDir,
    packageName: 'dev.agentscenarioloop.example',
    runId: 'android-window-1',
    waitMs: 250,
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.deepEqual(waits, [250]);
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-logcat-clear.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-launch.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-logcat.txt')));
  assert.ok(calls.indexOf('-s emulator-5554 logcat -c') < calls.indexOf('-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1'));
  assert.ok(calls.indexOf('-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1') < calls.indexOf('-s emulator-5554 logcat -d -v time -t 50'));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_package_launched'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_capture_window_waited'),
  );
});

test('opens profile-session deep links before logcat capture', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-deep-link-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
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
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?scenario=app-startup&runId=android-live' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      '-s emulator-5554 logcat -d -v time -t 25': {
        stdout: '06-16 10:00:00.000 I/ReactNativeJS(123): [profile-event] event=home_ready\n',
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

  const result = await runAndroidAdbPreflight({
    captureLogcat: true,
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=android-live',
        waitMs: 125,
      },
    ],
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    logcatLines: 25,
    outputDir,
    packageName: 'dev.agentscenarioloop.example',
    runId: 'android-live',
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.deepEqual(waits, [125]);
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-deep-link-1.txt')));
  assert.ok(
    calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?scenario=app-startup&runId=android-live' -p 'dev.agentscenarioloop.example'") <
      calls.indexOf('-s emulator-5554 logcat -d -v time -t 25'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_deep_link_opened'),
  );
});

test('fails health when no online adb device is connected', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-missing-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
    'devices -l': {
      stdout: [
        'List of devices attached',
        'emulator-5554 offline product:sdk_gphone model:Pixel_6 device:emu64',
      ].join('\n'),
    },
  });

  const result = await runAndroidAdbPreflight({
    executor,
    outputDir,
    runId: 'android-run-2',
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.verdict.verdictStatus, 'inconclusive');
  assert.equal(result.device, null);
});

test('fails logcat capture when no online Android device is connected', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-logcat-missing-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
    'devices -l': {
      stdout: [
        'List of devices attached',
        'emulator-5554 offline product:sdk_gphone model:Pixel_6 device:emu64',
      ].join('\n'),
    },
  });

  const result = await runAndroidAdbPreflight({
    captureLogcat: true,
    clearLogcat: true,
    executor,
    launch: true,
    outputDir,
    runId: 'android-run-logcat-missing',
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_capture_window_no_device'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_logcat_no_device'),
  );
});

test('fails health when the requested package is not installed', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-package-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
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
    '-s emulator-5554 shell pm path com.example.missing': { exitCode: 1, stderr: 'package not found\n' },
  });

  const result = await runAndroidAdbPreflight({
    executor,
    outputDir,
    packageName: 'com.example.missing',
    runId: 'android-run-3',
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.verdict.verdictStatus, 'inconclusive');
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_package_missing'),
  );
});
