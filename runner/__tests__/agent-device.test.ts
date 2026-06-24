const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  checkAgentDeviceAvailability,
  parseAgentDeviceSessionMode,
  parseRequiredPlatforms,
  resolveAgentDeviceDriverSteps,
  runAgentDeviceCapture,
  validateAgentDeviceDriverSteps,
  writeAgentDeviceAvailabilityArtifacts,
} = require('../agent-device');
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

test('agent-device required platforms parser accepts comma-separated OS targets', () => {
  assert.deepEqual(parseRequiredPlatforms('ios,android'), ['ios', 'android']);
  assert.deepEqual(parseRequiredPlatforms('ios, unknown, android'), ['ios', 'android']);
  assert.deepEqual(parseRequiredPlatforms(true), []);
});

test('agent-device session mode parser accepts explicit target-selection modes', () => {
  assert.equal(parseAgentDeviceSessionMode(undefined), 'reuse');
  assert.equal(parseAgentDeviceSessionMode('reuse'), 'reuse');
  assert.equal(parseAgentDeviceSessionMode('bind'), 'bind');
  assert.throws(() => parseAgentDeviceSessionMode('default'), /--session-mode must be either reuse or bind/u);
});

test('agent-device availability check verifies command surface and booted platforms', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'devices --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              devices: [
                { platform: 'android', id: 'emulator-5554', target: 'mobile', booted: true },
                { platform: 'ios', id: 'SIM-123', target: 'mobile', booted: true },
              ],
            },
          }),
        };
      }
      if (args.join(' ') === 'session list --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              sessions: [
                { name: 'android-example', platform: 'android', target: 'mobile', device: 'emulator-5554' },
                { name: 'default', platform: 'ios', target: 'mobile', device: 'SIM-123' },
              ],
            },
          }),
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: [
          'CLI to control iOS and Android devices',
          'open',
          'snapshot',
          'screenshot',
          'is',
          'click',
          'fill',
          'focus',
          'longpress',
          'pinch',
          'press',
          'rotate',
          'scroll',
          'swipe',
          'type',
          'logs',
          'devices',
          'session list',
        ].join('\n'),
      };
    },
    requiredPlatforms: ['ios', 'android'],
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.requiredPlatforms, ['ios', 'android']);
  assert.equal(result.devices.length, 2);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_sessions')?.status, 'passed');
  assert.match(
    String(result.checks.find((check: {name: string}) => check.name === 'agent_device_sessions')?.metadata?.activeSessions),
    /android-example:android:mobile:emulator-5554/u,
  );
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_booted_ios')?.status, 'passed');
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_booted_android')?.status, 'passed');
});

test('agent-device availability check does not require iOS-only pinch for Android-only checks', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'devices --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              devices: [{ platform: 'android', id: 'emulator-5554', target: 'mobile', booted: true }],
            },
          }),
        };
      }
      if (args.join(' ') === 'session list --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              sessions: [{ name: 'android-example', platform: 'android', target: 'mobile', device: 'emulator-5554' }],
            },
          }),
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: [
          'CLI to control iOS and Android devices',
          'open',
          'snapshot',
          'screenshot',
          'is',
          'click',
          'fill',
          'focus',
          'longpress',
          'press',
          'rotate',
          'scroll',
          'swipe',
          'type',
          'logs',
          'devices',
          'session list',
        ].join('\n'),
      };
    },
    requiredPlatforms: ['android'],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.checks.some((check: {name: string}) => check.name === 'agent_device_command_pinch'), false);
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_booted_android')?.status, 'passed');
});

test('agent-device availability check preserves failed command diagnostics', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: args[0] === 'devices' ? 1 : 0,
      stderr: args[0] === 'devices' ? 'daemon unavailable' : '',
      stdout: args[0] === 'devices'
        ? ''
        : 'CLI to control iOS and Android devices\nopen\nsnapshot\nscreenshot\nis\nclick\nfill\nfocus\nlongpress\npinch\npress\nrotate\nscroll\nswipe\ntype\nlogs\ndevices\nsession list\n',
    }),
    requiredPlatforms: ['ios'],
  });

  const devicesCheck = result.checks.find((check: {name: string}) => check.name === 'agent_device_devices');
  assert.equal(result.status, 'failed');
  assert.equal(devicesCheck?.exitCode, 1);
  assert.equal(devicesCheck?.stderrPreview, 'daemon unavailable');
  assert.equal(devicesCheck?.metadata?.failureClass, 'host_access');
  assert.equal(devicesCheck?.metadata?.nextActionCode, 'rerun_with_host_access');
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_booted_ios')?.status, 'failed');
});

test('agent-device availability check fails when active sessions cannot be inspected', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'devices --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: { devices: [{ platform: 'android', id: 'emulator-5554', target: 'mobile', booted: true }] },
          }),
        };
      }
      if (args.join(' ') === 'session list --json') {
        return {
          args,
          command,
          exitCode: 1,
          stderr: 'session daemon unavailable',
          stdout: '',
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: 'CLI to control iOS and Android devices\nopen\nsnapshot\nscreenshot\nis\nclick\nfill\nfocus\nlongpress\npinch\npress\nrotate\nscroll\nswipe\ntype\nlogs\ndevices\nsession list\n',
      };
    },
  });

  const sessionsCheck = result.checks.find((check: {name: string}) => check.name === 'agent_device_sessions');
  assert.equal(result.status, 'failed');
  assert.equal(sessionsCheck?.exitCode, 1);
  assert.equal(sessionsCheck?.stderrPreview, 'session daemon unavailable');
  assert.equal(sessionsCheck?.metadata?.failureClass, 'host_access');
  assert.equal(sessionsCheck?.metadata?.nextActionCode, 'rerun_with_host_access');
});

test('agent-device availability check classifies missing binaries', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: 'spawn agent-device ENOENT',
      stdout: '',
    }),
    requiredCommands: [],
  });

  const failedCheck = result.checks.find((check: {name: string}) => check.name === 'agent_device_help');
  assert.equal(result.status, 'failed');
  assert.equal(failedCheck?.metadata?.failureClass, 'missing_binary');
  assert.equal(failedCheck?.metadata?.nextActionCode, 'configure_agent_device_binary');
});

test('agent-device availability check writes ASL artifacts when requested', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-check-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'devices --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: { devices: [{ platform: 'android', id: 'emulator-5554', target: 'mobile', booted: true }] },
          }),
        };
      }
      if (args.join(' ') === 'session list --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: { sessions: [{ name: 'android-example', platform: 'android', target: 'mobile' }] },
          }),
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: 'CLI to control iOS and Android devices\nopen\nsnapshot\nscreenshot\nis\nclick\nfill\nfocus\nlongpress\npinch\npress\nrotate\nscroll\nswipe\ntype\nlogs\ndevices\nsession list\n',
      };
    },
    requiredPlatforms: ['android'],
  });

  const artifacts = await writeAgentDeviceAvailabilityArtifacts({
    outputDir: tempDir,
    result,
    runId: 'agent-device-check',
  });
  const health = readJson(path.join(tempDir, 'health.json'));
  const verdict = readJson(path.join(tempDir, 'verdict.json'));
  const raw = readJson(path.join(tempDir, 'raw', 'agent-device-availability.json'));

  assert.equal(artifacts.runDir, tempDir);
  assert.equal(health.scenarioId, 'agent-device-availability');
  assert.equal(health.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'not_evaluated');
  assert.equal(raw.status, 'passed');
  assert.equal(raw.sessions.length, 1);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /Active sessions: 1/u);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /android-example:android:mobile/u);
  assertAdapterArtifactConformance(artifacts, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/agent-device-availability.json'],
  });
  assert.equal(fs.existsSync(path.join(tempDir, 'agent-summary.md')), true);
});

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
        id: 'focus-search',
        kind: 'gesture',
        driverAction: 'focus',
        adapterOptions: {
          agentDevice: {
            rawFileName: 'focus-search.txt',
            x: 120,
            y: 240,
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
    'session list --json',
    'open dev.example.app --platform ios --target mobile --udid BOOTED --json',
    'click label="Open" --platform ios --target mobile --udid BOOTED --json',
    'focus 120 240 --platform ios --target mobile --udid BOOTED --json',
    'is visible text="Ready" --platform ios --target mobile --udid BOOTED --json',
    `screenshot ${path.join(tempDir, 'captures', 'final.png')} --platform ios --target mobile --udid BOOTED --json`,
  ]);
  assert.deepEqual(result.captures.screenshots, ['captures/final.png']);
  assert.equal(readJson(path.join(tempDir, 'health.json')).healthStatus, 'passed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'not_evaluated');
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'agent-device-open.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'final-screenshot.txt')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'captures', 'final.png')), true);
  assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/agent-device-metadata.json', 'raw/final-screenshot.txt', 'raw/focus-search.txt'],
  });
  assertReportedCaptureArtifactsExist(result);
  assertMetadataCapturePathsExist(tempDir, 'raw/agent-device-metadata.json');
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
  const conformance = assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'failed',
    rawArtifacts: ['raw/assert-visible.txt', 'raw/agent-device-metadata.json'],
  });
  assertFailedHealthHasActionableMetadata(conformance.health, { checkName: 'agent_device_assert_visible' });
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
    nextAction: 'The selected agent-device session is bound to another platform or device. Use a platform-specific --agent-device-session, close the bound session, or rerun without the conflicting session.',
    nextActionCode: 'select_agent_device_session',
    selectorKind: 'testId',
    selectorValue: 'asl-example-title',
    stepId: 'assert-home-visible',
  });
  assert.match(
    fs.readFileSync(path.join(tempDir, 'raw', 'agent-device-assert-visible.txt'), 'utf8'),
    /INVALID_ARGS/u,
  );
});

test('agent-device capture points device-in-use failures at the owning session', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-device-in-use-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const stdout = JSON.stringify({
    success: false,
    error: {
      code: 'DEVICE_IN_USE',
      message: 'Device is already in use by session "android-example".',
      hint: 'Retry with --debug and inspect diagnostics log for details.',
      diagnosticId: 'diag-device-in-use',
    },
  });

  await runAgentDeviceCapture({
    app: 'dev.example.app',
    executor: async (command: string, args: string[]): Promise<CommandResult> => ({
      args,
      command,
      exitCode: 1,
      stderr: '',
      stdout,
    }),
    open: true,
    outputDir: tempDir,
    platform: 'android',
    runId: 'agent-device-device-in-use',
    serial: 'emulator-5554',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.deepEqual(health.checks[0].metadata, {
    agentDeviceDiagnosticId: 'diag-device-in-use',
    agentDeviceErrorCode: 'DEVICE_IN_USE',
    agentDeviceErrorHint: 'Retry with --debug and inspect diagnostics log for details.',
    agentDeviceErrorMessage: 'Device is already in use by session "android-example".',
    nextAction: 'Device is already owned by agent-device session "android-example". Reuse that session with --agent-device-session android-example, close it, or choose another device before rerunning.',
    nextActionCode: 'reuse_agent_device_session',
  });
});

test('agent-device capture lets named sessions own target selection', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-session-target-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const calls: string[] = [];

  await runAgentDeviceCapture({
    app: 'dev.example.app',
    driverSteps: [
      {
        driverAction: 'assertVisible',
        required: true,
        selector: { kind: 'testId', value: 'home-title' },
        stepId: 'assert-home-visible',
      },
    ],
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args.join(' '));
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"success":true}\n',
      };
    },
    open: true,
    outputDir: tempDir,
    platform: 'android',
    runId: 'agent-device-session-target',
    serial: 'emulator-5554',
    session: 'android-example',
  });

  assert.deepEqual(calls, [
    'open dev.example.app --platform android --session android-example --json',
    'is visible id="home-title" --platform android --session android-example --json',
  ]);
  const metadata = readJson(path.join(tempDir, 'raw', 'agent-device-metadata.json'));
  assert.equal(metadata.requestedTarget, 'emulator-5554');
  assert.equal(metadata.selectedTarget, 'android-example');
  assert.equal(metadata.targetSelectionMode, 'session');
});

test('agent-device capture can bind a named session to direct target selectors', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-session-bind-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const calls: string[] = [];

  await runAgentDeviceCapture({
    app: 'dev.example.app',
    driverSteps: [
      {
        driverAction: 'assertVisible',
        required: true,
        selector: { kind: 'testId', value: 'home-title' },
        stepId: 'assert-home-visible',
      },
    ],
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args.join(' '));
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"success":true}\n',
      };
    },
    open: true,
    outputDir: tempDir,
    platform: 'android',
    runId: 'agent-device-session-bind',
    serial: 'emulator-5554',
    session: 'asl-android',
    sessionMode: 'bind',
  });

  assert.deepEqual(calls, [
    'open dev.example.app --platform android --target mobile --serial emulator-5554 --session asl-android --json',
    'is visible id="home-title" --platform android --target mobile --serial emulator-5554 --session asl-android --json',
  ]);
  const metadata = readJson(path.join(tempDir, 'raw', 'agent-device-metadata.json'));
  assert.equal(metadata.requestedTarget, 'emulator-5554');
  assert.equal(metadata.selectedTarget, 'emulator-5554');
  assert.equal(metadata.session, 'asl-android');
  assert.equal(metadata.sessionMode, 'bind');
  assert.equal(metadata.targetSelectionMode, 'session_bind');
});

test('agent-device capture auto-selects a matching platform session', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-auto-session-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const calls: string[] = [];

  await runAgentDeviceCapture({
    app: 'dev.example.app',
    driverSteps: [
      {
        driverAction: 'assertVisible',
        required: true,
        selector: { kind: 'testId', value: 'home-title' },
        stepId: 'assert-home-visible',
      },
    ],
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args.join(' '));
      if (args.join(' ') === 'session list --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            data: {
              sessions: [
                { name: 'default', platform: 'ios', target: 'mobile', id: 'SIM-123' },
                { name: 'asl-android', platform: 'android', target: 'mobile', id: 'emulator-5554' },
              ],
            },
          }),
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"success":true}\n',
      };
    },
    open: true,
    outputDir: tempDir,
    platform: 'android',
    runId: 'agent-device-auto-session',
    serial: 'emulator-5554',
  });

  assert.deepEqual(calls, [
    'session list --json',
    'open dev.example.app --platform android --session asl-android --json',
    'is visible id="home-title" --platform android --session asl-android --json',
  ]);
  const metadata = readJson(path.join(tempDir, 'raw', 'agent-device-metadata.json'));
  assert.equal(metadata.session, 'asl-android');
  assert.equal(metadata.sessionSelectionMode, 'auto');
  assert.equal(metadata.targetSelectionMode, 'session');
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
        id: 'long-press-menu',
        kind: 'gesture',
        driverAction: 'longPress',
        adapterOptions: {
          agentDevice: {
            durationMs: 700,
            ref: 'menu-button',
            rawFileName: 'long-press-menu.txt',
          },
        },
      },
      {
        id: 'pinch-map',
        kind: 'gesture',
        driverAction: 'pinch',
        adapterOptions: {
          agentDevice: {
            rawFileName: 'pinch-map.txt',
            scale: 1.2,
            x: 120,
            y: 240,
          },
        },
      },
      {
        id: 'fill-search',
        kind: 'gesture',
        driverAction: 'fill',
        selector: { kind: 'accessibilityLabel', value: 'Search' },
        adapterOptions: {
          agentDevice: {
            delayMs: 25,
            rawFileName: 'fill-search.txt',
            text: 'hello',
          },
        },
      },
      {
        id: 'press-submit',
        kind: 'gesture',
        driverAction: 'pressButton',
        selector: { kind: 'accessibilityLabel', value: 'Submit' },
        adapterOptions: {
          agentDevice: {
            rawFileName: 'press-submit.txt',
          },
        },
      },
      {
        id: 'rotate-landscape',
        kind: 'gesture',
        driverAction: 'rotate',
        adapterOptions: {
          agentDevice: {
            orientation: 'landscape-left',
          },
        },
      },
      {
        id: 'swipe-card',
        kind: 'gesture',
        driverAction: 'swipe',
        adapterOptions: {
          agentDevice: {
            durationMs: 250,
            endX: 300,
            endY: 400,
            startX: 100,
            startY: 200,
          },
        },
      },
      {
        id: 'type-search',
        kind: 'gesture',
        driverAction: 'typeText',
        adapterOptions: {
          agentDevice: {
            delayMs: 25,
            rawFileName: 'type-search.txt',
            text: 'hello',
          },
        },
      },
      {
        id: 'focus-search',
        kind: 'gesture',
        driverAction: 'focus',
        adapterOptions: {
          agentDevice: {
            rawFileName: 'focus-search.txt',
            x: 120,
            y: 240,
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
      driverAction: 'longPress',
      durationMs: 700,
      rawFileName: 'long-press-menu.txt',
      ref: 'menu-button',
      required: true,
      stepId: 'long-press-menu',
      waitMs: 0,
    },
    {
      driverAction: 'pinch',
      rawFileName: 'pinch-map.txt',
      required: true,
      scale: 1.2,
      stepId: 'pinch-map',
      waitMs: 0,
      x: 120,
      y: 240,
    },
    {
      delayMs: 25,
      driverAction: 'fill',
      rawFileName: 'fill-search.txt',
      required: true,
      selector: { kind: 'accessibilityLabel', value: 'Search' },
      stepId: 'fill-search',
      text: 'hello',
      waitMs: 0,
    },
    {
      driverAction: 'pressButton',
      rawFileName: 'press-submit.txt',
      required: true,
      selector: { kind: 'accessibilityLabel', value: 'Submit' },
      stepId: 'press-submit',
      waitMs: 0,
    },
    {
      driverAction: 'rotate',
      orientation: 'landscape-left',
      rawFileName: 'agent-device-rotate-7.txt',
      required: true,
      stepId: 'rotate-landscape',
      waitMs: 0,
    },
    {
      driverAction: 'swipe',
      durationMs: 250,
      endX: 300,
      endY: 400,
      rawFileName: 'agent-device-swipe-8.txt',
      required: true,
      startX: 100,
      startY: 200,
      stepId: 'swipe-card',
      waitMs: 0,
    },
    {
      delayMs: 25,
      driverAction: 'typeText',
      rawFileName: 'type-search.txt',
      required: true,
      stepId: 'type-search',
      text: 'hello',
      waitMs: 0,
    },
    {
      driverAction: 'focus',
      rawFileName: 'focus-search.txt',
      required: true,
      stepId: 'focus-search',
      waitMs: 0,
      x: 120,
      y: 240,
    },
    {
      captureFileName: 'agent-device-screenshot-11.png',
      driverAction: 'screenshot',
      rawFileName: 'agent-device-screenshot-11.txt',
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
      {
        driverAction: 'longPress',
        required: true,
        stepId: 'long-press-missing',
      },
      {
        driverAction: 'pinch',
        required: true,
        stepId: 'pinch-missing',
      },
      {
        driverAction: 'fill',
        required: true,
        stepId: 'fill-missing',
      },
      {
        driverAction: 'focus',
        required: true,
        stepId: 'focus-missing',
      },
      {
        driverAction: 'pressButton',
        required: true,
        stepId: 'press-button-missing',
      },
      {
        driverAction: 'rotate',
        required: true,
        stepId: 'rotate-missing',
      },
      {
        driverAction: 'swipe',
        required: true,
        stepId: 'swipe-missing',
        startX: 10,
        startY: 20,
      },
      {
        driverAction: 'typeText',
        required: true,
        stepId: 'type-missing',
      },
    ]),
    [
      'step `tap-missing` uses driverAction `tap` but is missing a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.',
      'step `long-press-missing` uses driverAction `longPress` but is missing a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.',
      'step `pinch-missing` uses driverAction `pinch` but is missing adapterOptions.agentDevice.scale.',
      'step `fill-missing` uses driverAction `fill` but is missing a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.',
      'step `fill-missing` uses driverAction `fill` but is missing adapterOptions.agentDevice.text.',
      'step `focus-missing` uses driverAction `focus` but is missing adapterOptions.agentDevice.x/y.',
      'step `press-button-missing` uses driverAction `pressButton` but is missing a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.',
      'step `rotate-missing` uses driverAction `rotate` but adapterOptions.agentDevice.orientation must be portrait, portrait-upside-down, landscape-left, or landscape-right.',
      'step `swipe-missing` uses driverAction `swipe` but is missing adapterOptions.agentDevice.startX/startY/endX/endY.',
      'step `type-missing` uses driverAction `typeText` but is missing adapterOptions.agentDevice.text.',
    ],
  );
});
