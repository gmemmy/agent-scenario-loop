const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROFILE_LOG_PREDICATE,
  createIosSimctlDriver,
  formatIosSimctlRawOutput,
} = require('../ios-simctl-driver');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

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

test('iOS simctl driver keeps lifecycle helpers separate from portable evidence actions', async () => {
  const executor = createExecutor({
    'simctl launch BOOTED dev.example.app': {
      stdout: 'dev.example.app: 1234\n',
    },
    'simctl openurl BOOTED asl-example://profile-session/start?runId=one': {
      stdout: '',
    },
    'simctl terminate BOOTED dev.example.app': {
      stderr: 'No such process\n',
      exitCode: 3,
    },
  });
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor,
    xcrunPath: 'fake-xcrun',
  });

  const launch = await driver.launchBundle('dev.example.app');
  const deepLink = await driver.openDeepLink({
    rawFileName: 'ios-deep-link-1.txt',
    url: 'asl-example://profile-session/start?runId=one',
  });
  const terminate = await driver.terminateBundle('dev.example.app');

  assert.equal(launch.action, 'launchBundle');
  assert.equal(launch.rawFileName, 'ios-launch.txt');
  assert.equal(deepLink.action, 'openDeepLink');
  assert.equal(deepLink.rawFileName, 'ios-deep-link-1.txt');
  assert.equal(terminate.action, 'terminateBundle');
  assert.equal(terminate.rawFileName, 'ios-terminate.txt');
});

test('iOS simctl driver captures logs and screenshots through portable evidence actions', async () => {
  const screenshotPath = '/tmp/asl-ios-screenshot.png';
  const executor = createExecutor({
    [`simctl spawn BOOTED log show --style compact --last 30s --predicate ${PROFILE_LOG_PREDICATE}`]: {
      stdout: '[profile-event] {}\n',
    },
    [`simctl io BOOTED screenshot ${screenshotPath}`]: {
      stdout: 'Wrote screenshot\n',
    },
  });
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor,
    xcrunPath: 'fake-xcrun',
  });

  const logs = await driver.readLogs({ last: '30s' });
  const screenshot = await driver.screenshot({ outputPath: screenshotPath });

  assert.equal(logs.action, 'readLogs');
  assert.equal(logs.rawFileName, 'ios-simctl-log.txt');
  assert.match(formatIosSimctlRawOutput(logs), /\[profile-event\]/u);
  assert.equal(screenshot.action, 'screenshot');
  assert.equal(screenshot.rawFileName, 'ios-screenshot.txt');
  assert.deepEqual(screenshot.args, ['simctl', 'io', 'BOOTED', 'screenshot', screenshotPath]);
});

test('iOS simctl driver preserves screenshot options in command args', async () => {
  const screenshotPath = '/tmp/asl-ios-screenshot.jpeg';
  const executor = createExecutor({
    [`simctl io BOOTED screenshot --type=jpeg --display=Internal-1 --mask=black ${screenshotPath}`]: {
      stdout: 'Wrote screenshot\n',
    },
  });
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor,
    xcrunPath: 'fake-xcrun',
  });

  const screenshot = await driver.screenshot({
    display: 'Internal-1',
    imageType: 'jpeg',
    mask: 'black',
    outputPath: screenshotPath,
  });

  assert.equal(screenshot.action, 'screenshot');
  assert.deepEqual(screenshot.args, [
    'simctl',
    'io',
    'BOOTED',
    'screenshot',
    '--type=jpeg',
    '--display=Internal-1',
    '--mask=black',
    screenshotPath,
  ]);
});
