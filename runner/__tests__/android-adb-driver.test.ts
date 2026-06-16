const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createAndroidAdbDriver,
  formatAndroidAdbRawOutput,
  quoteAndroidShellArg,
} = require('../android-adb-driver');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

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

test('quotes Android shell arguments that contain shell metacharacters', () => {
  assert.equal(
    quoteAndroidShellArg("asl-example://profile-session/start?runId=a&label=owner's"),
    "'asl-example://profile-session/start?runId=a&label=owner'\\''s'",
  );
});

test('Android adb driver reads bounded logs through the declared driver action', async () => {
  const executor = createExecutor({
    '-s emulator-5554 logcat -d -v time -t 25': {
      stdout: '06-16 10:00:00.000 I/ReactNativeJS(123): [profile-event] {}\n',
    },
  });
  const driver = createAndroidAdbDriver({
    adbPath: 'fake-adb',
    deviceSerial: 'emulator-5554',
    executor,
  });

  const result = await driver.readLogs({ lines: 25 });

  assert.equal(result.action, 'readLogs');
  assert.equal(result.rawFileName, 'adb-logcat.txt');
  assert.deepEqual(result.args, ['-s', 'emulator-5554', 'logcat', '-d', '-v', 'time', '-t', '25']);
  assert.match(formatAndroidAdbRawOutput(result), /\[profile-event\]/u);
});

test('Android adb driver keeps lifecycle helpers separate from portable driver actions', async () => {
  const executor = createExecutor({
    '-s emulator-5554 logcat -c': { stdout: '' },
    '-s emulator-5554 shell monkey -p dev.example.app -c android.intent.category.LAUNCHER 1': {
      stdout: 'Events injected: 1\n',
    },
    "-s emulator-5554 shell am start -a 'android.intent.action.VIEW' -d 'asl-example://profile-session/start?runId=one&scenario=startup' -p 'dev.example.app'": {
      stdout: 'Starting: Intent\n',
    },
  });
  const driver = createAndroidAdbDriver({
    adbPath: 'fake-adb',
    deviceSerial: 'emulator-5554',
    executor,
  });

  const clear = await driver.clearLogs();
  const launch = await driver.launchPackage('dev.example.app');
  const deepLink = await driver.openDeepLink({
    packageName: 'dev.example.app',
    rawFileName: 'adb-deep-link-1.txt',
    url: 'asl-example://profile-session/start?runId=one&scenario=startup',
  });

  assert.equal(clear.action, 'clearLogs');
  assert.equal(clear.rawFileName, 'adb-logcat-clear.txt');
  assert.equal(launch.action, 'launchPackage');
  assert.equal(launch.rawFileName, 'adb-launch.txt');
  assert.equal(deepLink.action, 'openDeepLink');
  assert.equal(deepLink.rawFileName, 'adb-deep-link-1.txt');
});
