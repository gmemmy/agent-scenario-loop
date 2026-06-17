const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseArgs,
  parseBaseArgs,
  resolveArgentDriverSteps,
  runArgentCapture,
  validateArgentDriverSteps,
} = require('../argent');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};
type TestContext = import('node:test').TestContext;

test('Argent CLI parser accepts dash-leading adapter flag values', () => {
  const args = parseArgs([
    '--argent',
    'npx',
    '--base-args',
    '--yes @swmansion/argent run',
    '--device-flag',
    '--udid',
    '--app-flag=--bundleId',
  ]);

  assert.equal(args.argent, 'npx');
  assert.deepEqual(parseBaseArgs(args['base-args']), ['--yes', '@swmansion/argent', 'run']);
  assert.equal(args['device-flag'], '--udid');
  assert.equal(args['app-flag'], '--bundleId');
});

/**
 * Reads a JSON artifact.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('Argent capture executes scenario driver actions and writes artifacts', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const screenshotPath = path.join(tempDir, 'argent-source.png');
  const calls: string[] = [];
  const scenario = {
    id: 'argent-flow',
    flowId: 'example-flow',
    steps: [
      {
        id: 'launch',
        kind: 'launch',
      },
      {
        id: 'tap-card',
        kind: 'gesture',
        driverAction: 'tap',
        adapterOptions: {
          argent: {
            x: 500,
            y: 400,
          },
        },
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
          argent: {
            captureFileName: 'final.png',
            rawFileName: 'final-screenshot.txt',
          },
        },
      },
    ],
  };
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push(args.join(' '));
    if (args.includes('screenshot')) {
      await fsp.writeFile(screenshotPath, 'fake image', 'utf8');
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: `Saved screenshot: ${screenshotPath}\n`,
      };
    }
    return {
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: '{"description":"Home Ready"}\n',
    };
  };

  const result = await runArgentCapture({
    app: 'dev.example.app',
    argentCommand: 'npx',
    baseArgs: ['--yes', '@swmansion/argent', 'run'],
    deviceId: 'SIM-123',
    executor,
    outputDir: tempDir,
    platform: 'ios',
    runId: 'argent-run',
    scenario,
    screenSize: { height: 800, width: 1000 },
  });

  assert.equal(result.runDir, tempDir);
  assert.deepEqual(calls, [
    '--yes @swmansion/argent run launch-app --udid SIM-123 --bundleId dev.example.app',
    '--yes @swmansion/argent run gesture-tap --udid SIM-123 --x 0.5 --y 0.5',
    '--yes @swmansion/argent run describe --udid SIM-123 --bundleId dev.example.app',
    '--yes @swmansion/argent run screenshot --udid SIM-123 --includeImageInContext false',
  ]);
  assert.deepEqual(result.captures.screenshots, ['captures/final.png']);
  assert.equal(readJson(path.join(tempDir, 'health.json')).healthStatus, 'passed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'not_evaluated');
  assert.equal(readJson(path.join(tempDir, 'raw', 'argent-metadata.json')).platform, 'ios');
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'argent-launch-1.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'final-screenshot.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'captures', 'final.png')), true);
});

test('Argent capture marks required action failures unhealthy', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-failed-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const result = await runArgentCapture({
    deviceId: 'emulator-5554',
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: '{"description":"Root"}\n',
    }),
    outputDir: tempDir,
    platform: 'android',
    runId: 'argent-failed',
    scenario: {
      id: 'argent-failed-flow',
      steps: [
        {
          id: 'assert-ready',
          kind: 'assertUi',
          driverAction: 'assertVisible',
          selector: { kind: 'text', value: 'Ready' },
        },
      ],
    },
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /Do not optimize from this run/u);
  assert.match(JSON.stringify(health), /root_only_description/u);
  assert.equal(health.checks[0].metadata.nextActionCode, 'fix_argent_visibility_target');
});

test('Argent capture points missing command failures at command configuration', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-missing-command-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await runArgentCapture({
    deviceId: 'SIM-123',
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: 'spawn argent ENOENT',
      stdout: '',
    }),
    outputDir: tempDir,
    platform: 'ios',
    runId: 'argent-missing-command',
    scenario: {
      id: 'argent-missing-command-flow',
      steps: [
        {
          id: 'capture-final',
          kind: 'captureEvidence',
          artifact: 'screenshot',
          driverAction: 'screenshot',
        },
      ],
    },
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].metadata.argentDiagnostic, 'argent_command_unavailable');
  assert.equal(health.checks[0].metadata.nextActionCode, 'configure_argent_command');
});

test('Argent capture points command timeouts at runner configuration', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-timeout-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await runArgentCapture({
    deviceId: 'SIM-123',
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: 'Argent command timed out after 1000ms.',
      stdout: '',
    }),
    outputDir: tempDir,
    platform: 'ios',
    runId: 'argent-timeout',
    scenario: {
      id: 'argent-timeout-flow',
      steps: [
        {
          id: 'capture-final',
          kind: 'captureEvidence',
          artifact: 'screenshot',
          driverAction: 'screenshot',
        },
      ],
    },
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(health.healthStatus, 'failed');
  assert.equal(health.checks[0].metadata.argentDiagnostic, 'argent_command_timeout');
  assert.equal(health.checks[0].metadata.nextActionCode, 'fix_argent_command_timeout');
});

test('Argent driver step expansion validates coordinate-backed metadata', () => {
  const scenario = {
    id: 'portable-argent-actions',
    steps: [
      {
        id: 'launch',
        kind: 'launch',
      },
      {
        id: 'tap-card',
        kind: 'gesture',
        driverAction: 'tap',
        adapterOptions: {
          argent: {
            x: 100,
            y: 200,
          },
        },
      },
      {
        id: 'assert-title',
        kind: 'assertUi',
        driverAction: 'assertVisible',
        selector: {
          kind: 'testId',
          value: 'title-id',
        },
        adapterOptions: {
          argent: {
            selector: {
              kind: 'text',
              value: 'Title',
            },
          },
        },
      },
      {
        id: 'scroll-feed',
        kind: 'gesture',
        driverAction: 'scroll',
        adapterOptions: {
          argent: {
            durationMs: 350,
            endX: 100,
            endY: 200,
            startX: 100,
            startY: 700,
          },
        },
      },
    ],
  };

  assert.deepEqual(resolveArgentDriverSteps(scenario), [
    {
      driverAction: 'launch',
      rawFileName: 'argent-launch-1.txt',
      required: true,
      stepId: 'launch',
      waitMs: 0,
    },
    {
      driverAction: 'tap',
      rawFileName: 'argent-tap-2.txt',
      required: true,
      stepId: 'tap-card',
      waitMs: 0,
      x: 100,
      y: 200,
    },
    {
      driverAction: 'assertVisible',
      rawFileName: 'argent-assertVisible-3.txt',
      required: true,
      selector: {
        kind: 'text',
        value: 'Title',
      },
      stepId: 'assert-title',
      waitMs: 0,
    },
    {
      driverAction: 'scroll',
      durationMs: 350,
      endX: 100,
      endY: 200,
      rawFileName: 'argent-scroll-4.txt',
      required: true,
      startX: 100,
      startY: 700,
      stepId: 'scroll-feed',
      waitMs: 0,
    },
  ]);

  assert.deepEqual(validateArgentDriverSteps(resolveArgentDriverSteps(scenario)), [
    'step `launch` is a launch step but no app id was provided through --app or adapterOptions.argent.appId.',
  ]);

  assert.deepEqual(validateArgentDriverSteps(resolveArgentDriverSteps(scenario), { app: 'dev.example.app' }), []);
  assert.deepEqual(validateArgentDriverSteps([
    { driverAction: 'tap', rawFileName: 'tap.txt', required: true, stepId: 'tap-missing', waitMs: 0 },
  ]), ['step `tap-missing` uses driverAction `tap` but is missing adapterOptions.argent.x/y.']);
});
