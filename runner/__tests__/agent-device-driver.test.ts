const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAgentDeviceGlobalArgs,
  createAgentDeviceDriver,
  formatAgentDeviceRawOutput,
  formatAgentDeviceSelector,
} = require('../agent-device-driver');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Creates a fake agent-device executor from argument-keyed responses.
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

test('agent-device driver builds stable global target args', () => {
  assert.deepEqual(
    buildAgentDeviceGlobalArgs({
      agentDevicePath: 'agent-device',
      executor: createExecutor({}),
      platform: 'ios',
      session: 'asl-ios',
      target: 'mobile',
      udid: 'BOOTED',
    }),
    ['--platform', 'ios', '--target', 'mobile', '--udid', 'BOOTED', '--session', 'asl-ios', '--json'],
  );
});

test('agent-device driver formats portable selectors', () => {
  assert.equal(formatAgentDeviceSelector({ kind: 'testId', value: 'submit' }), 'id="submit"');
  assert.equal(formatAgentDeviceSelector({ kind: 'accessibilityLabel', value: 'Open' }), 'label="Open"');
  assert.equal(formatAgentDeviceSelector({ kind: 'text', value: 'Start "now"' }), 'text="Start \\"now\\""');
  assert.throws(
    () => formatAgentDeviceSelector({ kind: 'text', match: 'contains', value: 'Start' }),
    /selector match `contains` is not supported/u,
  );
});

test('agent-device driver maps lifecycle and alert helpers', async () => {
  const executor = createExecutor({
    'open dev.example.app --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'alert get --platform ios --udid BOOTED --json': {
      stdout: '{"success":true,"data":{"items":["Cancel","Open"]}}\n',
    },
    'close dev.example.app --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
  });
  const driver = createAgentDeviceDriver({
    agentDevicePath: 'agent-device',
    executor,
    platform: 'ios',
    udid: 'BOOTED',
  });

  const open = await driver.open({ appOrUrl: 'dev.example.app' });
  const alert = await driver.alert();
  const close = await driver.close('dev.example.app');

  assert.equal(open.action, 'open');
  assert.equal(open.rawFileName, 'agent-device-open.txt');
  assert.equal(alert.action, 'alert');
  assert.match(formatAgentDeviceRawOutput(alert), /"Open"/u);
  assert.equal(close.action, 'close');
});

test('agent-device driver maps portable driver actions', async () => {
  const screenshotPath = '/tmp/asl-agent-device.png';
  const executor = createExecutor({
    'click label="Open" --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'click 10 20 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'is visible text="Ready" --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'snapshot -i --platform ios --udid BOOTED --json': {
      stdout: '{"success":true,"data":{"nodes":[]}}\n',
    },
    [`screenshot ${screenshotPath} --platform ios --udid BOOTED --json`]: {
      stdout: '{"success":true}\n',
    },
    'scroll down --pixels 400 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'swipe 100 800 100 300 250 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'logs path --platform ios --udid BOOTED --json': {
      stdout: '/tmp/agent-device.log\n',
    },
  });
  const driver = createAgentDeviceDriver({
    agentDevicePath: 'agent-device',
    executor,
    platform: 'ios',
    udid: 'BOOTED',
  });

  const tapSelector = await driver.tap({ selector: { kind: 'accessibilityLabel', value: 'Open' } });
  const tapCoordinates = await driver.tap({ x: 10, y: 20 });
  const assertVisible = await driver.assertVisible({ selector: { kind: 'text', value: 'Ready' } });
  const inspectTree = await driver.inspectTree();
  const screenshot = await driver.screenshot({ outputPath: screenshotPath });
  const scroll = await driver.scroll({ pixels: 400 });
  const swipe = await driver.scroll({ durationMs: 250, endX: 100, endY: 300, startX: 100, startY: 800 });
  const logs = await driver.readLogs();

  assert.equal(tapSelector.action, 'tap');
  assert.equal(tapCoordinates.action, 'tap');
  assert.equal(assertVisible.action, 'assertVisible');
  assert.equal(inspectTree.action, 'inspectTree');
  assert.equal(screenshot.capturePath, screenshotPath);
  assert.equal(scroll.action, 'scroll');
  assert.equal(swipe.action, 'scroll');
  assert.equal(logs.rawFileName, 'agent-device-logs.txt');
});

test('agent-device driver rejects tap without a target', async () => {
  const driver = createAgentDeviceDriver({
    agentDevicePath: 'agent-device',
    executor: createExecutor({}),
    platform: 'android',
    serial: 'emulator-5554',
  });

  await assert.rejects(
    async () => driver.tap({}),
    /tap requires a selector, ref, or x\/y coordinates/u,
  );
});
