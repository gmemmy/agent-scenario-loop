const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveAgentDeviceDriverSteps,
  runAgentDeviceCapture,
  validateAgentDeviceDriverSteps,
} = require('../agent-device');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};
type TestContext = import('node:test').TestContext;

/**
 * Reads a JSON artifact.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('agent-device capture executes scenario driver actions and writes artifacts', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const scenario = {
    name: 'agent-device-flow',
    steps: [
      {
        id: 'tap-open',
        kind: 'gesture',
        driverAction: 'tap',
        selector: { kind: 'accessibilityLabel', value: 'Open' },
      },
      {
        id: 'assert-ready',
        kind: 'assertUi',
        driverAction: 'assertVisible',
        selector: { kind: 'text', value: 'Ready' },
      },
      {
        id: 'capture-final',
        kind: 'captureEvidence',
        artifact: 'screenshot',
        driverAction: 'screenshot',
        adapterOptions: {
          agentDevice: {
            captureFileName: 'final.png',
            rawFileName: 'final-screenshot.txt',
          },
        },
      },
    ],
  };
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push(args.join(' '));
    if (args[0] === 'screenshot' && typeof args[1] === 'string') {
      await fsp.writeFile(args[1], 'fake image', 'utf8');
    }
    return {
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: '{"success":true}\n',
    };
  };

  const result = await runAgentDeviceCapture({
    app: 'dev.example.app',
    executor,
    open: true,
    outputDir: tempDir,
    platform: 'ios',
    runId: 'agent-device-run',
    scenario,
    udid: 'BOOTED',
  });

  assert.equal(result.runDir, tempDir);
  assert.deepEqual(calls, [
    'open dev.example.app --platform ios --target mobile --udid BOOTED --json',
    'click label="Open" --platform ios --target mobile --udid BOOTED --json',
    'is visible text="Ready" --platform ios --target mobile --udid BOOTED --json',
    `screenshot ${path.join(tempDir, 'captures', 'final.png')} --platform ios --target mobile --udid BOOTED --json`,
  ]);
  assert.deepEqual(result.captures.screenshots, ['captures/final.png']);
  assert.equal(readJson(path.join(tempDir, 'health.json')).healthStatus, 'passed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'not_evaluated');
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'agent-device-open.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'final-screenshot.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'captures', 'final.png')), true);
});

test('agent-device capture marks required action failures unhealthy', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-failed-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const result = await runAgentDeviceCapture({
    driverSteps: [
      {
        driverAction: 'assertVisible',
        rawFileName: 'assert-visible.txt',
        required: true,
        selector: { kind: 'text', value: 'Ready' },
        stepId: 'assert-ready',
      },
    ],
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: 'not visible',
      stdout: '',
    }),
    outputDir: tempDir,
    platform: 'android',
    runId: 'agent-device-failed',
    serial: 'emulator-5554',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /Do not optimize from this run/u);
});

test('agent-device capture preserves structured CLI errors in health metadata', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-error-metadata-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const stdout = JSON.stringify({
    success: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'Session "default" is bound to ios device and cannot be used with --platform=android.',
      hint: 'Use a different --session name or close this session first.',
      diagnosticId: 'diag-123',
    },
  });

  await runAgentDeviceCapture({
    driverSteps: [
      {
        driverAction: 'assertVisible',
        required: true,
        selector: { kind: 'testId', value: 'asl-example-title' },
        stepId: 'assert-home-visible',
      },
    ],
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: '',
      stdout,
    }),
    outputDir: tempDir,
    platform: 'android',
    runId: 'agent-device-error-metadata',
    serial: 'emulator-5554',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.deepEqual(health.checks[0].metadata, {
    agentDeviceDiagnosticId: 'diag-123',
    agentDeviceErrorCode: 'INVALID_ARGS',
    agentDeviceErrorHint: 'Use a different --session name or close this session first.',
    agentDeviceErrorMessage: 'Session "default" is bound to ios device and cannot be used with --platform=android.',
    driverAction: 'assertVisible',
    nextAction: 'Inspect raw/agent-device-assert-visible.txt, confirm the device is interactive and the action metadata is valid, then rerun the capture.',
    nextActionCode: 'inspect_agent_device_driver_action',
    selectorKind: 'testId',
    selectorValue: 'asl-example-title',
    stepId: 'assert-home-visible',
  });
  assert.match(
    fs.readFileSync(path.join(tempDir, 'raw', 'agent-device-assert-visible.txt'), 'utf8'),
    /INVALID_ARGS/u,
  );
});

test('agent-device driver step expansion preserves portable selectors and options', () => {
  const scenario = {
    id: 'portable-actions',
    steps: [
      {
        id: 'tap-card',
        kind: 'gesture',
        driverAction: 'tap',
        selector: { kind: 'testId', value: 'card' },
        timeoutMs: 250,
      },
      {
        id: 'scroll-feed',
        kind: 'gesture',
        driverAction: 'scroll',
        adapterOptions: {
          agentDevice: {
            direction: 'down',
            pixels: 400,
            rawFileName: 'scroll-feed.txt',
          },
        },
      },
      {
        id: 'capture-final',
        kind: 'captureEvidence',
        artifact: 'screenshot',
        driverAction: 'screenshot',
      },
    ],
  };

  assert.deepEqual(resolveAgentDeviceDriverSteps(scenario), [
    {
      driverAction: 'tap',
      rawFileName: 'agent-device-tap-1.txt',
      required: true,
      selector: { kind: 'testId', value: 'card' },
      stepId: 'tap-card',
      waitMs: 250,
    },
    {
      direction: 'down',
      driverAction: 'scroll',
      pixels: 400,
      rawFileName: 'scroll-feed.txt',
      required: true,
      stepId: 'scroll-feed',
      waitMs: 0,
    },
    {
      captureFileName: 'agent-device-screenshot-3.png',
      driverAction: 'screenshot',
      rawFileName: 'agent-device-screenshot-3.txt',
      required: true,
      stepId: 'capture-final',
      waitMs: 0,
    },
  ]);
});

test('agent-device driver step validation rejects missing tap targets', () => {
  assert.deepEqual(
    validateAgentDeviceDriverSteps([
      {
        driverAction: 'tap',
        required: true,
        stepId: 'tap-missing',
      },
    ]),
    ['step `tap-missing` uses driverAction `tap` but is missing a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.'],
  );
});
