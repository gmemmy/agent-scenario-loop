const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER,
  buildReactNativeDebugHostPreferenceCommand,
  escapeAndroidPreferenceXml,
  execFileCommandWithTimeout,
  parseAdbDevices,
  parseArgs,
  parseReactNativeDebugHostPort,
  runAndroidAdbPreflight,
  selectDevice,
} = require('../android-adb');
const {
  assertAdapterArtifactConformance,
  assertFailedHealthHasActionableMetadata,
  assertMetadataCapturePathsExist,
} = require('./adapter-conformance');

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

test('parses and rejects React Native debug host ports', () => {
  assert.equal(parseReactNativeDebugHostPort('localhost:8097'), 8097);
  assert.equal(parseReactNativeDebugHostPort('10.0.2.2:8081'), 8081);
  assert.equal(parseReactNativeDebugHostPort('http://localhost:8097'), null);
  assert.equal(parseReactNativeDebugHostPort('localhost'), null);
  assert.equal(parseReactNativeDebugHostPort('localhost:70000'), null);
});

test('builds React Native debug host preference command safely', () => {
  assert.equal(escapeAndroidPreferenceXml('localhost:8097'), 'localhost:8097');
  assert.equal(escapeAndroidPreferenceXml('owner&device<debug>"host\''), 'owner&amp;device&lt;debug&gt;&quot;host&apos;');
  assert.match(
    buildReactNativeDebugHostPreferenceCommand({
      debugHost: 'localhost:8097',
      packageName: 'com.example.app',
    }),
    /debug_http_host/u,
  );
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
  assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/adb-devices.txt', 'raw/android-metadata.json'],
  });
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-devices.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'android-metadata.json')));
  assert.match(fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8'), /Scenario health passed/u);
});

test('configures React Native debug host and adb reverse when requested', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-rn-host-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const fallbackExecutor = createExecutor({
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
    '-s emulator-5554 reverse tcp:8097 tcp:8097': { stdout: '' },
  });
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (key.includes('shell run-as com.example.app sh -c') && key.includes('debug_http_host') && key.includes('localhost:8097')) {
      return { args, command, exitCode: 0, stderr: '', stdout: '' };
    }

    return fallbackExecutor(command, args);
  };

  const result = await runAndroidAdbPreflight({
    adbPath: 'fake-adb',
    executor,
    outputDir,
    packageName: 'com.example.app',
    reactNativeDebugHost: 'localhost:8097',
    runId: 'android-rn-host',
  });
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'android-metadata.json'), 'utf8'));

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(calls.includes('-s emulator-5554 reverse tcp:8097 tcp:8097'));
  assert.ok(calls.some((call) => call.includes('debug_http_host')));
  assert.equal(metadata.reactNativeDebugHostSetup.debugHost, 'localhost:8097');
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-react-native-reverse.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-react-native-debug-host.txt')));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => (
      check.code === 'android_react_native_debug_host_configured'
    )),
  );
});

test('writes Android AsyncStorage values through package-scoped RKStorage', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-storage-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const fallbackExecutor = createExecutor({
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
    '-s emulator-5554 shell date +%s': { stdout: '1800000000\n' },
  });
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    if (
      key.includes('run-as') &&
      key.includes('com.example.app') &&
      key.includes('sqlite3') &&
      key.includes('databases/RKStorage') &&
      key.includes('agent-scenario-loop.profile-session.1') &&
      key.includes('"startedAt":1800000000000') &&
      key.includes('"timestamp":1800000000007') &&
      !key.includes(ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER)
    ) {
      return { args, command, exitCode: 0, stderr: '', stdout: '' };
    }

    return fallbackExecutor(command, args);
  };
  const waits: number[] = [];

  const result = await runAndroidAdbPreflight({
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    outputDir,
    packageName: 'com.example.app',
    runId: 'android-storage',
    storageWrites: [{
      clearKeys: ['agent-scenario-loop.profile-commands.1'],
      key: 'agent-scenario-loop.profile-session.1',
      label: 'profile-session-start',
      value: JSON.stringify({
        active: true,
        scenario: 'app-startup',
        runId: 'android-storage',
        startedAt: ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER,
        timestamp: `${ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER}+7`,
      }).replace(`"${ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER}"`, ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER),
      waitMs: 125,
    }],
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.deepEqual(waits, [125]);
  assert.ok(calls.includes('-s emulator-5554 shell date +%s'));
  assert.ok(calls.some((call) => call.includes('catalystLocalStorage')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-device-epoch-ms.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-async-storage-write-1.txt')));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => (
      check.code === 'android_async_storage_written'
    )),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => (
      check.code === 'android_device_clock_read'
    )),
  );
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
    delay: async () => {},
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
  const fallbackExecutor = createExecutor({
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
    '-s emulator-5554 shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status': {
      stdout: '<hierarchy><node text="Example" resource-id="dev.example:id/example" bounds="[10,100][210,260]" /></hierarchy>\n',
    },
    '-s emulator-5554 exec-out screencap -p': { stdout: 'PNG' },
    '-s emulator-5554 shell screenrecord --time-limit 2 /sdcard/asl-record.mp4': { stdout: '' },
    '-s emulator-5554 shell rm -f /sdcard/asl-record.mp4': { stdout: '' },
    '-s emulator-5554 logcat -d -v time -t 25': {
      stdout: '06-16 12:00:00.000 I ReactNativeJS: [profile-event] {"event":"done"}\n',
    },
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const videoPath = path.join(outputDir, 'captures', 'adb-record-6.mp4');
    if (key === `-s emulator-5554 pull /sdcard/asl-record.mp4 ${videoPath}`) {
      await fsp.writeFile(videoPath, 'MP4', 'utf8');
      return { args, command, exitCode: 0, stderr: '', stdout: `${videoPath}\n` };
    }

    return fallbackExecutor(command, args);
  };

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
      {
        captureFileName: 'adb-record-6.mp4',
        driverAction: 'record',
        durationSeconds: 2,
        remotePath: '/sdcard/asl-record.mp4',
        stepId: 'record-final',
      },
    ],
    captureLogcat: true,
    executor,
    logcatLines: 25,
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
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-record-6.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-logcat.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'captures', 'adb-record-6.mp4')));
  assert.ok(calls.includes('-s emulator-5554 shell rm -f /sdcard/asl-record.mp4'));
  assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/android-metadata.json', 'raw/adb-record-6.txt'],
  });
  assertMetadataCapturePathsExist(outputDir, 'raw/android-metadata.json');
  assert.deepEqual(
    (metadata.driverActions as Array<{ driverAction: string }>).map((item) => item.driverAction),
    ['tap', 'scroll', 'inspectTree', 'assertVisible', 'screenshot', 'record', 'readLogs'],
  );
  assert.equal((metadata.driverActions as Array<{ capturePath?: string }>)[5]?.capturePath, 'captures/adb-record-6.mp4');
  assert.equal((metadata.logcat as { rawPath: string }).rawPath, 'raw/adb-logcat.txt');
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

test('classifies Android UIAutomator contention as runner environment health', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-uiautomator-busy-'));
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
    '-s emulator-5554 shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status': {
      exitCode: 1,
      stderr: 'java.lang.IllegalStateException: UiAutomationService already registered!',
      stdout: 'Killed\ncat: /sdcard/agent-scenario-loop-ui.xml: No such file or directory\n',
    },
  });

  const result = await runAndroidAdbPreflight({
    driverSteps: [
      {
        driverAction: 'assertVisible',
        selector: { kind: 'testId', value: 'asl-example-title' },
        stepId: 'assert-home-visible',
      },
    ],
    executor,
    outputDir,
    runId: 'android-uiautomator-busy',
  });

  const check = (result.health.checks as Array<{metadata?: Record<string, unknown>; name: string}>)
    .find((item) => item.name === 'android_assert_visible');
  const { health } = assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'failed',
    rawArtifacts: ['raw/adb-assert-visible.xml'],
  });
  assertFailedHealthHasActionableMetadata(health, { checkName: 'android_assert_visible' });
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(check?.metadata?.nextActionCode, 'reset_android_uiautomator');
  assert.match(String(check?.metadata?.nextAction), /another automation session owns the service/u);
  assert.match(String(check?.metadata?.failurePreview), /UiAutomationService already registered/u);
  assert.match(
    fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8'),
    /Next action `reset_android_uiautomator`/u,
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
      '-s emulator-5554 shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status': {
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
      '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
        stdout: '1234\n',
      },
      '-s emulator-5554 logcat -d -v time -t 50': {
        stdout: '06-16 10:00:00.000 I/ReactNativeJS(123): [profile-event] {"event":"app_ready"}\n',
      },
      '-s emulator-5554 logcat -d -v time -t 200': {
        stdout: [
          '06-16 10:00:00.100 D/AndroidRuntime(4321): Calling main entry com.android.commands.monkey.Monkey',
          '06-16 10:00:00.101 W/Monkey  (4321): args: [-p, dev.agentscenarioloop.example, -c, android.intent.category.LAUNCHER, 1]',
          '06-16 10:00:00.200 I/AndroidRuntime(4321): VM exiting with result code 0.',
          '06-16 10:00:01.000 I/ReactNativeJS(1234): [profile-event] {"event":"app_ready"}',
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

  const result = await runAndroidAdbPreflight({
    captureLogcat: true,
    clearLogcat: true,
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    launch: true,
    launchWaitMs: 125,
    logcatLines: 50,
    outputDir,
    packageName: 'dev.agentscenarioloop.example',
    runId: 'android-window-1',
    waitMs: 250,
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.deepEqual(waits, [125, 250]);
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-logcat-clear.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-launch.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-pidof-after-launch.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-pidof-after-capture.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-lifecycle-log.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-logcat.txt')));
  assert.ok(calls.indexOf('-s emulator-5554 logcat -c') < calls.indexOf('-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1'));
  assert.ok(calls.indexOf('-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1') < calls.indexOf('-s emulator-5554 logcat -d -v time -t 50'));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_package_launched'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_launch_waited'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_capture_window_waited'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_app_lifecycle_stable'),
  );
});

test('fails health when launched Android app emits crash evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-crash-'));
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
    '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
      stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
    },
    '-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1': {
      stdout: 'Events injected: 1\n',
    },
    '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
      stdout: '1234\n',
    },
    '-s emulator-5554 logcat -d -v time -t 1000': {
      stdout: [
        '06-16 10:00:00.000 E/AndroidRuntime(1234): FATAL EXCEPTION: main',
        '06-16 10:00:00.000 E/AndroidRuntime(1234): Process: dev.agentscenarioloop.example, PID: 1234',
        '06-16 10:00:00.000 E/AndroidRuntime(1234): java.lang.RuntimeException: boom',
      ].join('\n'),
    },
  });

  const result = await runAndroidAdbPreflight({
    executor,
    launch: true,
    outputDir,
    packageName: 'dev.agentscenarioloop.example',
    runId: 'android-crash',
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-lifecycle-log.txt')));
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'android_app_crashed_during_capture'
        && check.metadata?.nextActionCode === 'inspect_android_app_crash',
    ),
  );
  assert.match(fs.readFileSync(path.join(outputDir, 'raw', 'adb-app-lifecycle-log.txt'), 'utf8'), /FATAL EXCEPTION/u);
});

test('does not treat Android WebView renderer crashes as app process crashes', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-renderer-crash-'));
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
    '-s emulator-5554 shell pm path dev.agentscenarioloop.example': {
      stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
    },
    '-s emulator-5554 shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1': {
      stdout: 'Events injected: 1\n',
    },
    '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
      stdout: '1234\n',
    },
    '-s emulator-5554 logcat -d -v time -t 1000': {
      stdout: [
        '06-16 10:00:00.000 E/chromium(1234): [ERROR:aw_browser_terminator.cc(154)] Renderer process (5678) crash detected (code -1).',
        '06-16 10:00:01.000 I/ReactNativeJS(1234): Running "main"',
      ].join('\n'),
    },
  });

  const result = await runAndroidAdbPreflight({
    executor,
    launch: true,
    outputDir,
    packageName: 'dev.agentscenarioloop.example',
    runId: 'android-renderer-crash',
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some(
      (check) => check.code === 'android_app_lifecycle_stable',
    ),
  );
  assert.match(fs.readFileSync(path.join(outputDir, 'raw', 'adb-app-lifecycle-log.txt'), 'utf8'), /Renderer process/u);
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
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?scenario=app-startup&runId=android-live' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
        stdout: '1234\n',
      },
      '-s emulator-5554 logcat -d -v time -t 25': {
        stdout: [
          '06-16 10:00:00.000 I/ReactNativeJS(123): Running "main" with {"rootTag":1}',
          '06-16 10:00:00.100 I/ReactNativeJS(123): [profile-event] event=home_ready',
        ].join('\n'),
      },
      '-s emulator-5554 logcat -d -v time -t 200': {
        stdout: '06-16 10:00:00.000 I/ReactNativeJS(1234): [profile-event] event=home_ready\n',
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
    startupDeepLinks: [
      {
        label: 'android-dev-client-url',
        readyLogPattern: 'Running "main"',
        url: 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097',
        waitMs: 80,
      },
    ],
  });

  assert.equal(result.health.healthStatus, 'passed');
  assert.deepEqual(waits, [80, 125]);
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-startup-deep-link-1.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-startup-deep-link-1-ready-log.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-deep-link-1.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-pidof-after-deep-link.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-pidof-after-capture.txt')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'adb-app-lifecycle-log.txt')));
  assert.ok(
    calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097' -p 'dev.agentscenarioloop.example'") <
      calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?scenario=app-startup&runId=android-live' -p 'dev.agentscenarioloop.example'"),
  );
  assert.ok(
    calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?scenario=app-startup&runId=android-live' -p 'dev.agentscenarioloop.example'") <
      calls.lastIndexOf('-s emulator-5554 logcat -d -v time -t 25'),
  );
  assert.ok(
    calls.indexOf("-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?scenario=app-startup&runId=android-live' -p 'dev.agentscenarioloop.example'") <
      calls.indexOf('-s emulator-5554 shell pidof dev.agentscenarioloop.example'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => (
      check.code === 'android_startup_deep_link_opened'
    )),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => (
      check.code === 'android_startup_deep_link_ready'
    )),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_deep_link_opened'),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some(
      (check) => check.code === 'android_app_process_running_after_deep_link',
    ),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'android_app_lifecycle_stable'),
  );
});

test('skips Android profile-session control when startup readiness does not pass', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-startup-not-ready-'));
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
      "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097' -p 'dev.agentscenarioloop.example'": {
        stdout: 'Starting: Intent { act=android.intent.action.VIEW }\n',
      },
      '-s emulator-5554 logcat -d -v time -t 25': {
        stdout: '06-16 10:00:00.100 I/ActivityTaskManager(123): blank native shell\n',
      },
      '-s emulator-5554 shell pidof dev.agentscenarioloop.example': {
        stdout: '1234\n',
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

  const result = await runAndroidAdbPreflight({
    captureLogcat: true,
    deepLinks: [
      {
        label: 'profile-session-command',
        url: 'asl-example://profile-session/command?scenario=app-startup&runId=android-live&command=activate-target%3Aexample-card-1',
        waitMs: 125,
      },
    ],
    delay: async () => {},
    executor,
    logcatLines: 25,
    outputDir,
    packageName: 'dev.agentscenarioloop.example',
    runId: 'android-live',
    startupDeepLinks: [
      {
        label: 'android-dev-client-url',
        readyLogPattern: 'Running "main"',
        readyLogTimeoutMs: 1,
        url: 'asl-example://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8097',
        waitMs: 80,
      },
    ],
    storageWrites: [
      {
        key: 'agent-scenario-loop.profile-session.1',
        label: 'profile-session-start',
        value: '{"active":true}',
      },
    ],
  });

  const codes = (result.health.checks as Array<{ code: string }>).map((check) => check.code);
  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(codes.includes('android_startup_deep_link_not_ready'));
  assert.ok(codes.includes('android_startup_not_ready_for_control'));
  assert.ok(codes.includes('android_async_storage_skipped_startup_not_ready'));
  assert.ok(codes.includes('android_deep_link_skipped_startup_not_ready'));
  assert.ok(!calls.some((call) => call.includes('run-as')));
  assert.ok(!calls.some((call) => call.includes('profile-session/command')));
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

test('times out hung adb commands with diagnostic stderr', async () => {
  const result = await execFileCommandWithTimeout(process.execPath, [
    '-e',
    'setTimeout(() => {}, 60_000);',
  ], 50);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /adb command timed out after 50ms/u);
});

test('explains agent sandbox access when adb daemon cannot be reached', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-sandbox-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    version: { stdout: 'Android Debug Bridge version 1.0.41\n' },
    'devices -l': {
      exitCode: 1,
      stderr: 'could not install *smartsocket* listener: Operation not permitted',
    },
  });

  const result = await runAndroidAdbPreflight({
    executor,
    outputDir,
    runId: 'android-adb-sandbox',
  });
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextAction?: string; nextActionCode?: string } }>).some(
      (check) => check.code === 'adb_daemon_unreachable'
        && check.metadata?.nextActionCode === 'rerun_with_adb_daemon_access'
        && /host adb daemon access/u.test(check.metadata.nextAction ?? ''),
    ),
  );
  assert.match(summary, /Next action `rerun_with_adb_daemon_access`/u);
});

test('writes adb daemon timeout artifacts when devices command hangs', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-android-adb-hung-devices-'));
  const fakeAdb = path.join(outputDir, 'fake-adb.js');
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  await fsp.writeFile(fakeAdb, [
    '#!/bin/sh',
    'if [ "$*" = "version" ]; then echo "Android Debug Bridge version 1.0.41"; exit 0; fi',
    'if [ "$*" = "devices -l" ]; then sleep 60; exit 0; fi',
    'echo "unexpected command: $*" >&2',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  await fsp.chmod(fakeAdb, 0o755);

  const result = await runAndroidAdbPreflight({
    adbPath: fakeAdb,
    commandTimeoutMs: 50,
    outputDir,
    runId: 'android-adb-hung-devices',
  });
  const devicesRaw = fs.readFileSync(path.join(outputDir, 'raw', 'adb-devices.txt'), 'utf8');
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.match(devicesRaw, /adb command timed out after 50ms/u);
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'adb_daemon_unreachable'
        && check.metadata?.nextActionCode === 'rerun_with_adb_daemon_access',
    ),
  );
  assert.match(summary, /Next action `rerun_with_adb_daemon_access`/u);
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
