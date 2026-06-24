const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkArgentAvailability,
  deriveArgentRootArgs,
  execFileCommandWithTimeout,
  parseArgs,
  parseBaseArgs,
  resolveArgentDriverSteps,
  runArgentCapture,
  validateArgentDriverSteps,
  writeArgentAvailabilityArtifacts,
} = require('../argent');
const {
  assertAdapterArtifactConformance,
  assertFailedHealthHasActionableMetadata,
  assertMetadataCapturePathsExist,
  assertReportedCaptureArtifactsExist,
} = require('./adapter-conformance');

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

test('Argent availability check verifies configured run command and required tools', async () => {
  const calls: string[] = [];
  const result = await checkArgentAvailability({
    argentCommand: 'npx',
    baseArgs: ['--yes', '@swmansion/argent', 'run'],
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args.at(-1) === '--help') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: 'Usage: argent run <tool> [flags]\n',
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: `Tool: ${args.at(-1)}\nFlags:\n  --udid <value>\n`,
      };
    },
    requiredTools: ['launch-app', 'screenshot'],
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.requiredTools, ['launch-app', 'screenshot']);
  assert.deepEqual(calls, [
    'npx --yes @swmansion/argent run --help',
    'npx --yes @swmansion/argent tools describe launch-app',
    'npx --yes @swmansion/argent tools describe screenshot',
  ]);
});

test('Argent availability check fails when a required tool is unavailable', async () => {
  const result = await checkArgentAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: args.includes('gesture-tap') ? 1 : 0,
      stderr: args.includes('gesture-tap') ? 'unknown tool gesture-tap' : '',
      stdout: args.at(-1) === '--help'
        ? 'Usage: argent run <tool> [flags]\n'
        : `Tool: ${args.at(-1)}\n`,
    }),
    requiredTools: ['launch-app', 'gesture-tap'],
  });

  assert.equal(result.status, 'failed');
  const failedCheck = result.checks.find((check: {name: string}) => check.name === 'argent_tool_gesture-tap');
  assert.equal(failedCheck?.status, 'failed');
  assert.equal(failedCheck?.exitCode, 1);
  assert.equal(failedCheck?.stderrPreview, 'unknown tool gesture-tap');
  assert.equal(failedCheck?.metadata?.failureClass, 'command_surface');
  assert.equal(failedCheck?.metadata?.nextActionCode, 'inspect_argent_availability');
});

test('Argent availability accepts expected output emitted before a wrapper timeout', async () => {
  const result = await checkArgentAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: args.at(-1) === '--help' ? 0 : 1,
      stderr: args.at(-1) === '--help' ? '' : 'Argent command timed out after 30000ms.',
      stdout: args.at(-1) === '--help'
        ? 'Usage: argent run <tool> [flags]\n'
        : `Tool: ${args.at(-1)}\nFlags:\n  --udid <value>\n`,
    }),
    requiredTools: ['launch-app'],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.checks[1].status, 'passed');
  assert.equal(result.checks[1].message, 'argent_tool_launch-app returned the expected Argent output before a wrapper timeout.');
});

test('Argent availability check classifies host access failures', async () => {
  const result = await checkArgentAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: 'operation not permitted while connecting to the local device service',
      stdout: '',
    }),
    requiredTools: [],
  });

  const failedCheck = result.checks.find((check: {name: string}) => check.name === 'argent_run_help');
  assert.equal(result.status, 'failed');
  assert.equal(failedCheck?.metadata?.failureClass, 'host_access');
  assert.equal(failedCheck?.metadata?.nextActionCode, 'rerun_with_host_access');
});

test('Argent availability check writes ASL artifacts when requested', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-check-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const result = await checkArgentAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: args.at(-1) === '--help'
        ? 'Usage: argent run <tool> [flags]\n'
        : `Tool: ${args.at(-1)}\n`,
    }),
    requiredTools: ['launch-app'],
  });

  const artifacts = await writeArgentAvailabilityArtifacts({
    outputDir: tempDir,
    result,
    runId: 'argent-check',
  });
  const health = readJson(path.join(tempDir, 'health.json'));
  const verdict = readJson(path.join(tempDir, 'verdict.json'));
  const raw = readJson(path.join(tempDir, 'raw', 'argent-availability.json'));

  assert.equal(artifacts.runDir, tempDir);
  assert.equal(health.scenarioId, 'argent-availability');
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.summary, 'Argent command surface is available; no product budget has been evaluated.');
  assert.equal(raw.status, 'passed');
  assertAdapterArtifactConformance(artifacts, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/argent-availability.json'],
  });
  assert.equal(fs.existsSync(path.join(tempDir, 'agent-summary.md')), true);
});

test('Argent root args are derived from configured run args', () => {
  assert.deepEqual(deriveArgentRootArgs(['run']), []);
  assert.deepEqual(deriveArgentRootArgs(['--yes', '@swmansion/argent', 'run']), ['--yes', '@swmansion/argent']);
  assert.deepEqual(deriveArgentRootArgs(['--yes', '@swmansion/argent']), ['--yes', '@swmansion/argent']);
});

test('Argent command executor resolves when a helper keeps inherited pipes open', async () => {
  const result = await execFileCommandWithTimeout(process.execPath, [
    '-e',
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'inherit' });",
      'helper.unref();',
      "fs.writeSync(1, 'wrapper complete\\n');",
      'process.exit(0);',
    ].join('\n'),
  ], 20_000);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /wrapper complete/u);
});

test('Argent command executor returns a timeout result when a wrapper ignores termination', async () => {
  const startedAt = Date.now();
  const result = await execFileCommandWithTimeout(process.execPath, [
    '-e',
    [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "fs.writeSync(1, 'wrapper started\\n');",
      'setTimeout(() => {}, 10_000);',
    ].join('\n'),
  ], 2000);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Argent command timed out after 2000ms/u);
  assert.ok(Date.now() - startedAt < 6000);
});

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
        id: 'drag-card',
        kind: 'gesture',
        driverAction: 'drag',
        adapterOptions: {
          argent: {
            durationMs: 450,
            endX: 750,
            endY: 640,
            startX: 250,
            startY: 320,
          },
        },
      },
      {
        id: 'pinch-map',
        kind: 'gesture',
        driverAction: 'pinch',
        adapterOptions: {
          argent: {
            angle: 15,
            centerX: 500,
            centerY: 400,
            durationMs: 400,
            endDistance: 0.6,
            startDistance: 0.2,
          },
        },
      },
      {
        id: 'rotate-map',
        kind: 'gesture',
        driverAction: 'rotateGesture',
        adapterOptions: {
          argent: {
            centerX: 500,
            centerY: 400,
            durationMs: 500,
            endAngle: 90,
            radius: 0.25,
            startAngle: 0,
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
    '--yes @swmansion/argent run gesture-custom --udid SIM-123 --events-json [{"type":"Down","x":0.25,"y":0.4},{"delayMs":450,"type":"Move","x":0.75,"y":0.8},{"type":"Up","x":0.75,"y":0.8}]',
    '--yes @swmansion/argent run gesture-pinch --udid SIM-123 --centerX 0.5 --centerY 0.5 --startDistance 0.2 --endDistance 0.6 --angle 15 --durationMs 400',
    '--yes @swmansion/argent run gesture-rotate --udid SIM-123 --centerX 0.5 --centerY 0.5 --radius 0.25 --startAngle 0 --endAngle 90 --durationMs 500',
    '--yes @swmansion/argent run describe --udid SIM-123 --bundleId dev.example.app',
    '--yes @swmansion/argent run screenshot --udid SIM-123 --includeImageInContext false',
  ]);
  assert.deepEqual(result.captures.screenshots, ['captures/final.png']);
  assert.equal(readJson(path.join(tempDir, 'health.json')).healthStatus, 'passed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'not_evaluated');
  assert.equal(readJson(path.join(tempDir, 'raw', 'argent-metadata.json')).platform, 'ios');
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'argent-launch-1.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'argent-drag-3.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'argent-pinch-4.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'argent-rotateGesture-5.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'final-screenshot.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'captures', 'final.png')), true);
  assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/argent-metadata.json', 'raw/final-screenshot.txt'],
  });
  assertReportedCaptureArtifactsExist(result);
  assertMetadataCapturePathsExist(tempDir, 'raw/argent-metadata.json');
});

test('Argent capture resolves iOS booted shorthand before running driver actions', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-booted-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const calls: string[] = [];

  const result = await runArgentCapture({
    app: 'dev.example.app',
    deviceId: 'booted',
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args.join(' '));
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"bundleId":"dev.example.app"}\n',
      };
    },
    outputDir: tempDir,
    platform: 'ios',
    resolveBootedIosSimulatorUdid: async () => 'SIM-123',
    runId: 'argent-booted',
    scenario: {
      id: 'argent-booted-flow',
      steps: [
        {
          id: 'launch',
          kind: 'launch',
        },
      ],
    },
  });

  assert.equal(result.metadata.deviceId, 'SIM-123');
  assert.equal(result.metadata.requestedDeviceId, 'booted');
  assert.deepEqual(calls, ['run launch-app --udid SIM-123 --bundleId dev.example.app']);
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
  const conformance = assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'failed',
    rawArtifacts: ['raw/argent-assertVisible-1.txt', 'raw/argent-metadata.json'],
  });
  assertFailedHealthHasActionableMetadata(conformance.health, { checkName: 'argent_assert_visible' });
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

test('Argent capture points simulator-server screenshot warnings at the tool dependency', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-simulator-server-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await runArgentCapture({
    deviceId: 'SIM-123',
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: '[Tool:screenshot] Service dependency failed: [SimulatorServer:SIM-123] simulator-server exited with code before becoming ready',
      stdout: '',
    }),
    outputDir: tempDir,
    platform: 'ios',
    runId: 'argent-simulator-server',
    scenario: {
      id: 'argent-simulator-server-flow',
      steps: [
        {
          id: 'capture-final',
          kind: 'captureEvidence',
          artifact: 'screenshot',
          driverAction: 'screenshot',
          required: false,
        },
      ],
    },
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(health.checks[0].status, 'warning');
  assert.equal(health.checks[0].metadata.argentDiagnostic, 'argent_simulator_server_unavailable');
  assert.equal(health.checks[0].metadata.nextActionCode, 'fix_argent_simulator_server');
});

test('Argent capture can recover iOS screenshot evidence through simctl fallback', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-argent-ios-simctl-fallback-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const simctlCalls: string[] = [];

  await runArgentCapture({
    deviceId: 'SIM-123',
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: '[Tool:screenshot] Service dependency failed: [SimulatorServer:SIM-123] simulator-server exited with code before becoming ready',
      stdout: '',
    }),
    iosSimctlExecutor: async (command: string, args: string[]): Promise<CommandResult> => {
      simctlCalls.push(`${command} ${args.join(' ')}`);
      const outputPath = args.at(-1);
      if (typeof outputPath === 'string') {
        await fsp.writeFile(outputPath, 'fake simctl screenshot', 'utf8');
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: `Wrote screenshot to: ${outputPath}\n`,
      };
    },
    iosSimctlScreenshotFallback: true,
    outputDir: tempDir,
    platform: 'ios',
    runId: 'argent-ios-simctl-fallback',
    scenario: {
      id: 'argent-ios-simctl-fallback-flow',
      steps: [
        {
          id: 'capture-final',
          kind: 'captureEvidence',
          artifact: 'screenshot',
          driverAction: 'screenshot',
        },
      ],
    },
    xcrunPath: '/Applications/Xcode.app/Contents/Developer/usr/bin/xcrun',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  const metadata = readJson(path.join(tempDir, 'raw', 'argent-metadata.json'));
  assert.equal(health.healthStatus, 'passed');
  assert.equal(health.checks[0].status, 'warning');
  assert.equal(health.checks[0].metadata.argentDiagnostic, 'argent_simulator_server_unavailable');
  assert.equal(health.checks[0].metadata.fallbackProvider, 'ios-simctl');
  assert.equal(health.checks[1].status, 'passed');
  assert.equal(health.checks[1].code, 'ios_simctl_screenshot_fallback_completed');
  assert.deepEqual(metadata.captures.screenshots, ['captures/ios-simctl-capture-final.png']);
  assert.equal(metadata.driverActions[0].captureProvider, 'ios-simctl');
  assert.equal(fs.existsSync(path.join(tempDir, 'captures', 'ios-simctl-capture-final.png')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'ios-simctl-capture-final-screenshot.txt')), true);
  assert.deepEqual(simctlCalls, [
    `/Applications/Xcode.app/Contents/Developer/usr/bin/xcrun simctl io SIM-123 screenshot ${path.join(tempDir, 'captures', 'ios-simctl-capture-final.png')}`,
  ]);
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
        id: 'long-press-card',
        kind: 'gesture',
        driverAction: 'longPress',
        adapterOptions: {
          argent: {
            durationMs: 850,
            x: 100,
            y: 300,
          },
        },
      },
      {
        id: 'drag-card',
        kind: 'gesture',
        driverAction: 'drag',
        adapterOptions: {
          argent: {
            durationMs: 475,
            endX: 300,
            endY: 500,
            startX: 100,
            startY: 300,
          },
        },
      },
      {
        id: 'pinch-map',
        kind: 'gesture',
        driverAction: 'pinch',
        adapterOptions: {
          argent: {
            angle: 15,
            centerX: 200,
            centerY: 300,
            durationMs: 400,
            endDistance: 0.6,
            startDistance: 0.2,
          },
        },
      },
      {
        id: 'rotate-map',
        kind: 'gesture',
        driverAction: 'rotateGesture',
        adapterOptions: {
          argent: {
            centerX: 200,
            centerY: 300,
            durationMs: 500,
            endAngle: 90,
            radius: 0.25,
            startAngle: 0,
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
      {
        id: 'swipe-card',
        kind: 'gesture',
        driverAction: 'swipe',
        adapterOptions: {
          argent: {
            durationMs: 175,
            endX: 300,
            endY: 400,
            startX: 100,
            startY: 200,
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
      driverAction: 'longPress',
      durationMs: 850,
      rawFileName: 'argent-longPress-3.txt',
      required: true,
      stepId: 'long-press-card',
      waitMs: 0,
      x: 100,
      y: 300,
    },
    {
      driverAction: 'drag',
      durationMs: 475,
      endX: 300,
      endY: 500,
      rawFileName: 'argent-drag-4.txt',
      required: true,
      startX: 100,
      startY: 300,
      stepId: 'drag-card',
      waitMs: 0,
    },
    {
      angle: 15,
      centerX: 200,
      centerY: 300,
      driverAction: 'pinch',
      durationMs: 400,
      endDistance: 0.6,
      rawFileName: 'argent-pinch-5.txt',
      required: true,
      startDistance: 0.2,
      stepId: 'pinch-map',
      waitMs: 0,
    },
    {
      centerX: 200,
      centerY: 300,
      driverAction: 'rotateGesture',
      durationMs: 500,
      endAngle: 90,
      radius: 0.25,
      rawFileName: 'argent-rotateGesture-6.txt',
      required: true,
      startAngle: 0,
      stepId: 'rotate-map',
      waitMs: 0,
    },
    {
      driverAction: 'assertVisible',
      rawFileName: 'argent-assertVisible-7.txt',
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
      rawFileName: 'argent-scroll-8.txt',
      required: true,
      startX: 100,
      startY: 700,
      stepId: 'scroll-feed',
      waitMs: 0,
    },
    {
      driverAction: 'swipe',
      durationMs: 175,
      endX: 300,
      endY: 400,
      rawFileName: 'argent-swipe-9.txt',
      required: true,
      startX: 100,
      startY: 200,
      stepId: 'swipe-card',
      waitMs: 0,
    },
  ]);

  assert.deepEqual(validateArgentDriverSteps(resolveArgentDriverSteps(scenario)), [
    'step `launch` is a launch step but no app id was provided through --app or adapterOptions.argent.appId.',
  ]);

  assert.deepEqual(validateArgentDriverSteps(resolveArgentDriverSteps(scenario), { app: 'dev.example.app' }), []);
  assert.deepEqual(validateArgentDriverSteps([
    { driverAction: 'tap', rawFileName: 'tap.txt', required: true, stepId: 'tap-missing', waitMs: 0 },
    { driverAction: 'longPress', rawFileName: 'long-press.txt', required: true, stepId: 'long-press-missing', waitMs: 0 },
    { driverAction: 'drag', rawFileName: 'drag.txt', required: true, stepId: 'drag-missing', waitMs: 0 },
    { driverAction: 'pinch', rawFileName: 'pinch.txt', required: true, stepId: 'pinch-missing', waitMs: 0 },
    { driverAction: 'rotateGesture', rawFileName: 'rotate.txt', required: true, stepId: 'rotate-missing', waitMs: 0 },
    { driverAction: 'swipe', rawFileName: 'swipe.txt', required: true, stepId: 'swipe-missing', waitMs: 0 },
  ]), [
    'step `tap-missing` uses driverAction `tap` but is missing adapterOptions.argent.x/y.',
    'step `long-press-missing` uses driverAction `longPress` but is missing adapterOptions.argent.x/y.',
    'step `drag-missing` uses driverAction `drag` but is missing adapterOptions.argent.startX/startY/endX/endY.',
    'step `pinch-missing` uses driverAction `pinch` but is missing adapterOptions.argent.centerX/centerY/startDistance/endDistance.',
    'step `rotate-missing` uses driverAction `rotateGesture` but is missing adapterOptions.argent.centerX/centerY/radius/startAngle/endAngle.',
    'step `swipe-missing` uses driverAction `swipe` but is missing adapterOptions.argent.startX/startY/endX/endY.',
  ]);
});
