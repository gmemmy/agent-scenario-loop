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

test('runs portable adb driver actions and writes raw evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-driver-actions-'));
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
    '-s emulator-5554 shell input tap 120 240': { stdout: '' },
    '-s emulator-5554 shell input swipe 500 1400 500 400 350': { stdout: '' },
    '-s emulator-5554 shell uiautomator dump /dev/tty': {
      stdout: '<hierarchy><node text="Example" resource-id="dev.example:id/example" bounds="[10,100][210,260]" /></hierarchy>\n',
    },
    '-s emulator-5554 exec-out screencap -p': { stdout: 'PNG' },
  });

  const result = await runAndroidAdbPreflight({
    driverSteps: [
      { driverAction: 'tap', stepId: 'tap-card', x: 120, y: 240 },
      { driverAction: 'scroll', durationMs: 350, endX: 500, endY: 400, startX: 500, startY: 1400, stepId: 'scroll-feed' },
      { driverAction: 'inspectTree', stepId: 'inspect-final' },
      {
        driverAction: 'assertVisible',
        selector: { kind: 'resourceId', value: 'dev.example:id/example' },
        stepId: 'assert-example',
      },
      { driverAction: 'screenshot', stepId: 'capture-final' },
    ],
    executor,
    outputDir,
    runId: 'android-driver-actions',
  });

  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'android-metadata.json'), 'utf8'));

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-tap.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-scroll-2.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-ui-tree-3.xml')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-assert-visible-4.xml')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-screenshot-5.png')));
  assert.deepEqual(
    (metadata.driverActions as Array<{ driverAction: string }>).map((item) => item.driverAction),
    ['tap', 'scroll', 'inspectTree', 'assertVisible', 'screenshot'],
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_tap_completed'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_inspect_tree_completed'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_assert_visible_completed'),
  );
});

test('resolves portable selectors into adb tap and scroll coordinates', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-selector-actions-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const uiTreeXml = [
    '<hierarchy>',
    '<node text="Open" resource-id="dev.example:id/open_card" content-desc="Open card" bounds="[10,100][210,260]" />',
    '<node text="Feed" resource-id="dev.example:id/feed" content-desc="Feed" bounds="[100,400][500,1000]" />',
    '</hierarchy>',
  ].join('');
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
      '-s emulator-5554 shell uiautomator dump /dev/tty': {
        stdout: uiTreeXml,
      },
      '-s emulator-5554 shell input tap 110 180': { stdout: '' },
      '-s emulator-5554 shell input swipe 300 880 300 520 300': { stdout: '' },
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

  const result = await runAndroidAdbPreflight({
    driverSteps: [
      {
        driverAction: 'tap',
        selector: { kind: 'testId', value: 'open_card' },
        stepId: 'tap-open-card',
      },
      {
        driverAction: 'scroll',
        selector: { kind: 'resourceId', value: 'dev.example:id/feed' },
        stepId: 'scroll-feed',
      },
    ],
    executor,
    outputDir,
    runId: 'android-selector-actions',
  });

  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'android-metadata.json'), 'utf8'));

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(calls.includes('-s emulator-5554 shell input tap 110 180'));
  assert.ok(calls.includes('-s emulator-5554 shell input swipe 300 880 300 520 300'));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-selector-tree-1.xml')));
  assert.deepEqual(
    (metadata.selectorResolutions as Array<{ status: string; stepId: string }>).map((item) => ({
      status: item.status,
      stepId: item.stepId,
    })),
    [
      { status: 'passed', stepId: 'tap-open-card' },
      { status: 'passed', stepId: 'scroll-feed' },
    ],
  );
});

test('fails required adb tap steps when coordinates are missing', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-tap-missing-coordinates-'));
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
  });

  const result = await runAndroidAdbPreflight({
    driverSteps: [{ driverAction: 'tap', stepId: 'tap-card' }],
    executor,
    outputDir,
    runId: 'android-missing-tap',
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(fs.readFileSync(path.join(outputDir, 'raw', 'adb-tap.txt'), 'utf8').includes('requires x and y'));
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
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.verdict.verdictStatus, 'inconclusive');
  assert.equal(result.device, null);
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'android_device_missing' && check.metadata?.nextActionCode === 'select_android_device',
    ),
  );
  assert.match(summary, /Next action `select_android_device`/u);
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
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'android_package_missing' && check.metadata?.nextActionCode === 'install_android_package',
    ),
  );
});
