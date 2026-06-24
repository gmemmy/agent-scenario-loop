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
    'longpress label="Actions" 700 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'pinch 1.2 120 240 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'focus 120 240 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'press label="Submit" --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'rotate landscape-left --platform ios --udid BOOTED --json': {
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
    'swipe 20 30 220 330 125 --platform ios --udid BOOTED --json': {
      stdout: '{"success":true}\n',
    },
    'type hello --delay-ms 25 --platform ios --udid BOOTED --json': {
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
  const longPress = await driver.longPress({ durationMs: 700, selector: { kind: 'accessibilityLabel', value: 'Actions' } });
  const pinch = await driver.pinch({ scale: 1.2, x: 120, y: 240 });
  const focus = await driver.focus({ x: 120, y: 240 });
  const pressButton = await driver.pressButton({ selector: { kind: 'accessibilityLabel', value: 'Submit' } });
  const rotate = await driver.rotate({ orientation: 'landscape-left' });
  const assertVisible = await driver.assertVisible({ selector: { kind: 'text', value: 'Ready' } });
  const inspectTree = await driver.inspectTree();
  const screenshot = await driver.screenshot({ outputPath: screenshotPath });
  const scroll = await driver.scroll({ pixels: 400 });
  const scrollWithCoordinates = await driver.scroll({ durationMs: 250, endX: 100, endY: 300, startX: 100, startY: 800 });
  const swipe = await driver.swipe({ durationMs: 125, endX: 220, endY: 330, startX: 20, startY: 30 });
  const typeText = await driver.typeText({ delayMs: 25, text: 'hello' });
  const logs = await driver.readLogs();

  assert.equal(tapSelector.action, 'tap');
  assert.equal(tapCoordinates.action, 'tap');
  assert.equal(longPress.action, 'longPress');
  assert.equal(longPress.rawFileName, 'agent-device-long-press.txt');
  assert.equal(pinch.action, 'pinch');
  assert.equal(pinch.rawFileName, 'agent-device-pinch.txt');
  assert.equal(focus.action, 'focus');
  assert.equal(focus.rawFileName, 'agent-device-focus.txt');
  assert.equal(pressButton.action, 'pressButton');
  assert.equal(pressButton.rawFileName, 'agent-device-press-button.txt');
  assert.equal(rotate.action, 'rotate');
  assert.equal(rotate.rawFileName, 'agent-device-rotate.txt');
  assert.equal(assertVisible.action, 'assertVisible');
  assert.equal(inspectTree.action, 'inspectTree');
  assert.equal(screenshot.capturePath, screenshotPath);
  assert.equal(scroll.action, 'scroll');
  assert.equal(scrollWithCoordinates.action, 'scroll');
  assert.equal(swipe.action, 'swipe');
  assert.equal(swipe.rawFileName, 'agent-device-swipe.txt');
  assert.equal(typeText.action, 'typeText');
  assert.equal(typeText.rawFileName, 'agent-device-type-text.txt');
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
