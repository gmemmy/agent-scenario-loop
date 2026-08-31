const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAgentDeviceCapabilityInventory,
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

function activeLeaseJournal({
  expiresAt = Date.now() + 60_000,
  platform,
  runId,
  targetId,
}: {
  expiresAt?: number;
  platform: 'android' | 'ios';
  runId: string;
  targetId: string;
}): Record<string, unknown> {
  const ownerId = `${runId}-owner`;
  const resourceId = `mobile-target:${platform}:${targetId}`;
  return {
    schemaVersion: 1,
    status: 'held',
    runId,
    ownerId,
    resource: { platform, resourceId, targetId },
    heartbeat: { count: 0 },
    acquisition: {
      status: 'acquired',
      lease: {
        schemaVersion: 1,
        leaseId: `${runId}-lease`,
        resourceId,
        ownerId,
        runId,
        pid: process.pid,
        hostname: 'test-host',
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        expiresAt,
        ttlMs: 60_000,
      },
    },
  };
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
      if (args.join(' ') === 'capabilities --json') {
        return {
          args,
          command,
          exitCode: 1,
          stderr: 'unknown command "capabilities"',
          stdout: '',
        };
      }
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
          'back',
          'click',
          'fill',
          'focus',
          'home',
          'app-switcher',
          'keyboard',
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
  assert.equal(result.capabilityProbe.source, 'help-output-fallback');
  assert.equal(result.capabilityInventory.status, 'fallback');
  assert.equal(result.requiredCommands.includes('pinch'), true);
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

test('agent-device availability check uses capabilities inventory when available', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-capability-inventory-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'capabilities --platform android --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            device: { id: 'emulator-5554', platform: 'android', target: 'mobile' },
            availableCommands: [
              'open',
              'snapshot',
              'screenshot',
              'is',
              'back',
              'click',
              'fill',
              'focus',
              'home',
              'app-switcher',
              'keyboard',
              'longpress',
              'press',
              'rotate',
              'scroll',
              'swipe',
              'type',
              'logs',
            ],
          }),
        };
      }
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
          'devices',
          'session list',
        ].join('\n'),
      };
    },
    requiredCommands: ['snapshot'],
    requiredPlatforms: ['android'],
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.capabilityProbe.source, 'capabilities-command');
  assert.deepEqual(result.capabilityProbe.availableCommands.slice(0, 2), ['open', 'snapshot']);
  assert.deepEqual(result.capabilityInventory.driverActions, [
    'assertVisible',
    'fill',
    'focus',
    'inspectTree',
    'longPress',
    'pressButton',
    'pressKey',
    'readLogs',
    'rotate',
    'screenshot',
    'scroll',
    'swipe',
    'tap',
    'typeText',
  ]);
  assert.deepEqual(result.capabilityInventory.unsupportedDriverActions, ['pinch']);
  assert.deepEqual(result.capabilityInventory.unknownCommands, []);
  assert.equal(
    result.checks.find((check: {name: string}) => check.name === 'agent_device_command_snapshot')?.metadata?.capabilitySource,
    'capabilities-command',
  );
  assert.equal(
    result.checks.find((check: {name: string}) => check.name === 'agent_device_command_devices')?.metadata?.capabilitySource,
    undefined,
  );

  await writeAgentDeviceAvailabilityArtifacts({
    outputDir: tempDir,
    result,
    runId: 'agent-device-capability-inventory',
  });
  const raw = readJson(path.join(tempDir, 'raw', 'agent-device-availability.json'));
  assert.equal(raw.capabilityInventory.status, 'available');
  assert.deepEqual(raw.capabilityInventory.driverActions, result.capabilityInventory.driverActions);
  assert.deepEqual(raw.capabilityInventory.unsupportedDriverActions, ['pinch']);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /ASL driver actions: /u);
});

test('agent-device availability check fails unsupported commands from capabilities inventory', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'capabilities --platform android --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            device: { id: 'emulator-5554', platform: 'android', target: 'mobile' },
            availableCommands: ['open'],
          }),
        };
      }
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
          stdout: JSON.stringify({ success: true, data: { sessions: [] } }),
        };
      }
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: 'CLI to control iOS and Android devices\ndevices\nsession list\n',
      };
    },
    requiredCommands: ['open', 'snapshot'],
    requiredPlatforms: ['android'],
  });

  const snapshotCheck = result.checks.find((check: {name: string}) => check.name === 'agent_device_command_snapshot');
  assert.equal(result.status, 'failed');
  assert.equal(snapshotCheck?.status, 'failed');
  assert.equal(snapshotCheck?.metadata?.nextActionCode, 'select_agent_device_capability');
  assert.deepEqual(result.capabilityInventory.driverActions, []);
  assert.deepEqual(result.capabilityInventory.unsupportedDriverActions, [
    'tap',
    'longPress',
    'typeText',
    'fill',
    'focus',
    'pinch',
    'scroll',
    'swipe',
    'rotate',
    'pressKey',
    'pressButton',
    'assertVisible',
    'inspectTree',
    'screenshot',
    'readLogs',
  ]);
});

test('agent-device availability check falls back when capabilities JSON is malformed', async () => {
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args.join(' ') === 'capabilities --platform android --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: '{not-json',
        };
      }
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
          stdout: JSON.stringify({ success: true, data: { sessions: [] } }),
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
          'back',
          'click',
          'fill',
          'focus',
          'home',
          'app-switcher',
          'keyboard',
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
  assert.equal(result.capabilityProbe.source, 'help-output-fallback');
  assert.equal(result.capabilityProbe.failureClass, 'command_surface');
  assert.equal(result.capabilityInventory.status, 'fallback');
  assert.deepEqual(result.capabilityInventory.driverActions, []);
});

test('agent-device capability inventory preserves unknown commands without promoting ASL support', () => {
  const inventory = buildAgentDeviceCapabilityInventory({
    args: ['capabilities', '--json'],
    availableCommands: ['open', 'snapshot', 'screenshot', 'teleport', 'network capture'],
    code: 'agent_device_capabilities_available',
    command: 'agent-device',
    exitCode: 0,
    source: 'capabilities-command',
  });

  assert.deepEqual(inventory.driverActions, ['inspectTree', 'screenshot']);
  assert.deepEqual(inventory.capabilities, ['artifactWrite', 'command', 'launch', 'screenshot', 'uiTree']);
  assert.deepEqual(inventory.artifactOutputs, ['screenshot', 'uiTree']);
  assert.deepEqual(inventory.unknownCommands, ['network capture', 'teleport']);
  assert.equal(inventory.unsupportedDriverActions.includes('collectPerfSignals'), false);
  assert.equal(inventory.unsupportedDriverActions.includes('tap'), true);
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
          'back',
          'click',
          'fill',
          'focus',
          'home',
          'app-switcher',
          'keyboard',
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
        : 'CLI to control iOS and Android devices\nopen\nsnapshot\nscreenshot\nis\nback\nclick\nfill\nfocus\nhome\napp-switcher\nkeyboard\nlongpress\npinch\npress\nrotate\nscroll\nswipe\ntype\nlogs\ndevices\nsession list\n',
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
        stdout: 'CLI to control iOS and Android devices\nopen\nsnapshot\nscreenshot\nis\nback\nclick\nfill\nfocus\nhome\napp-switcher\nkeyboard\nlongpress\npinch\npress\nrotate\nscroll\nswipe\ntype\nlogs\ndevices\nsession list\n',
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
        stdout: 'CLI to control iOS and Android devices\nopen\nsnapshot\nscreenshot\nis\nback\nclick\nfill\nfocus\nhome\napp-switcher\nkeyboard\nlongpress\npinch\npress\nrotate\nscroll\nswipe\ntype\nlogs\ndevices\nsession list\n',
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
  assert.equal(raw.capabilityInventory.status, 'fallback');
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /Active sessions: 1/u);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /android-example:android:mobile/u);
  assertAdapterArtifactConformance(artifacts, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/agent-device-availability.json'],
  });
  assert.equal(fs.existsSync(path.join(tempDir, 'agent-summary.md')), true);
});

test('agent-device availability binds scenario commands, target, session, and active lease', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-target-bound-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const leaseEvidencePath = path.join(tempDir, 'resource-lease.json');
  const leaseJournal = activeLeaseJournal({
    expiresAt: Date.now() - 1,
    platform: 'ios',
    runId: 'target-bound-run',
    targetId: 'SIM-EXACT',
  }) as Record<string, any>;
  leaseJournal.heartbeat = {
    count: 1,
    lastResult: {
      status: 'renewed',
      lease: {
        ...leaseJournal.acquisition.lease,
        expiresAt: Date.now() + 60_000,
        heartbeatAt: Date.now(),
      },
    },
  };
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(leaseJournal)}\n`, 'utf8');
  const calls: string[] = [];
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(args.join(' '));
      if (args[0] === 'capabilities') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            availableCommands: ['click', 'snapshot'],
            device: { id: 'SIM-EXACT', platform: 'ios', target: 'mobile' },
          }),
        };
      }
      if (args.join(' ') === 'devices --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            data: {
              devices: [
                { platform: 'ios', id: 'SIM-OTHER', target: 'mobile', booted: true },
                { platform: 'ios', id: 'SIM-EXACT', target: 'mobile', booted: true },
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
            data: {
              sessions: [
                { name: 'other-session', platform: 'ios', target: 'mobile', udid: 'SIM-OTHER' },
                { name: 'exact-session', platform: 'ios', target: 'mobile', udid: 'SIM-EXACT' },
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
        stdout: 'Agent Device command line\n',
      };
    },
    leaseEvidencePath,
    leaseRunId: 'target-bound-run',
    platform: 'ios',
    scenario: {
      id: 'category-discovery',
      flowId: 'category-discovery-flow',
      steps: [
        {
          id: 'open-category',
          kind: 'gesture',
          driverAction: 'tap',
          selector: { kind: 'accessibilityLabel', value: 'Category' },
        },
        {
          id: 'inspect-category',
          kind: 'captureEvidence',
          artifact: 'uiTree',
          driverAction: 'inspectTree',
        },
      ],
    },
    session: 'exact-session',
    udid: 'SIM-EXACT',
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.scenarioId, 'category-discovery');
  assert.equal(result.flowId, 'category-discovery-flow');
  assert.deepEqual(result.requiredCommands, ['click', 'devices', 'session list', 'snapshot']);
  assert.equal(result.requiredCommands.includes('pinch'), false);
  assert.equal(result.requiredCommands.includes('rotate'), false);
  assert.deepEqual(result.targetBinding, {
    leaseRunId: 'target-bound-run',
    leaseStatus: 'trusted',
    platform: 'ios',
    requestedSession: 'exact-session',
    requestedTarget: 'SIM-EXACT',
    selectedDevice: 'SIM-EXACT',
    selectedSession: 'exact-session',
    status: 'bound',
  });
  assert.equal(calls[0], 'capabilities --platform ios --target mobile --udid SIM-EXACT --session exact-session --json');
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_resource_lease')?.status, 'passed');
});

test('agent-device availability rejects expired lease evidence before adapter probes', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-expired-lease-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const leaseEvidencePath = path.join(tempDir, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(activeLeaseJournal({
    expiresAt: Date.now() - 1,
    platform: 'ios',
    runId: 'expired-lease-run',
    targetId: 'SIM-EXPIRED',
  }))}\n`, 'utf8');
  let executorCalls = 0;
  const result = await checkAgentDeviceAvailability({
    executor: async (): Promise<CommandResult> => {
      executorCalls += 1;
      throw new Error('executor must not run for expired lease evidence');
    },
    leaseEvidencePath,
    leaseRunId: 'expired-lease-run',
    platform: 'ios',
    scenario: { id: 'expired-lease-scenario', steps: [] },
    session: 'expired-lease-session',
    udid: 'SIM-EXPIRED',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.targetBinding.leaseStatus, 'untrusted');
  assert.equal(result.capabilityProbe.source, 'not-probed');
  assert.equal(result.capabilityInventory.status, 'not-probed');
  assert.equal(executorCalls, 0);
});

test('agent-device availability rejects lease evidence without non-empty owner identity', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-ownerless-lease-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const journal = activeLeaseJournal({
    platform: 'ios',
    runId: 'ownerless-lease-run',
    targetId: 'SIM-OWNERLESS',
  }) as Record<string, unknown>;
  delete journal.ownerId;
  const acquisition = journal.acquisition as {lease?: Record<string, unknown>};
  delete acquisition.lease?.ownerId;
  const leaseEvidencePath = path.join(tempDir, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(journal)}\n`, 'utf8');
  let executorCalls = 0;
  const result = await checkAgentDeviceAvailability({
    executor: async (): Promise<CommandResult> => {
      executorCalls += 1;
      throw new Error('executor must not run for ownerless lease evidence');
    },
    leaseEvidencePath,
    leaseRunId: 'ownerless-lease-run',
    platform: 'ios',
    scenario: { id: 'ownerless-lease-scenario', steps: [] },
    session: 'ownerless-lease-session',
    udid: 'SIM-OWNERLESS',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.targetBinding.leaseStatus, 'untrusted');
  assert.equal(executorCalls, 0);
});

test('agent-device availability rejects a present non-renewed heartbeat before adapter probes', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-failed-heartbeat-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const journal = activeLeaseJournal({
    platform: 'ios',
    runId: 'failed-heartbeat-run',
    targetId: 'SIM-HEARTBEAT',
  });
  journal.heartbeat = {
    count: 1,
    lastResult: { status: 'mismatch' },
  };
  const leaseEvidencePath = path.join(tempDir, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(journal)}\n`, 'utf8');
  let executorCalls = 0;
  const result = await checkAgentDeviceAvailability({
    executor: async (): Promise<CommandResult> => {
      executorCalls += 1;
      throw new Error('executor must not run after a failed heartbeat');
    },
    leaseEvidencePath,
    leaseRunId: 'failed-heartbeat-run',
    platform: 'ios',
    scenario: { id: 'failed-heartbeat-scenario', steps: [] },
    session: 'failed-heartbeat-session',
    udid: 'SIM-HEARTBEAT',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.targetBinding.leaseStatus, 'untrusted');
  assert.equal(result.capabilityProbe.source, 'not-probed');
  assert.equal(executorCalls, 0);
});

test('agent-device availability rejects a capability probe that omits selected-target authority', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-capability-target-missing-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const leaseEvidencePath = path.join(tempDir, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(activeLeaseJournal({
    platform: 'ios',
    runId: 'capability-target-run',
    targetId: 'SIM-CAPABILITY',
  }))}\n`, 'utf8');
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === 'capabilities') {
        return { args, command, exitCode: 0, stderr: '', stdout: JSON.stringify({ availableCommands: ['click'] }) };
      }
      if (args.join(' ') === 'devices --json') {
        return { args, command, exitCode: 0, stderr: '', stdout: JSON.stringify({ data: { devices: [{ platform: 'ios', id: 'SIM-CAPABILITY', target: 'mobile', booted: true }] } }) };
      }
      if (args.join(' ') === 'session list --json') {
        return { args, command, exitCode: 0, stderr: '', stdout: JSON.stringify({ data: { sessions: [{ name: 'capability-session', platform: 'ios', target: 'mobile', udid: 'SIM-CAPABILITY' }] } }) };
      }
      return { args, command, exitCode: 0, stderr: '', stdout: 'Agent Device command line\n' };
    },
    leaseEvidencePath,
    leaseRunId: 'capability-target-run',
    platform: 'ios',
    scenario: { id: 'capability-target-scenario', steps: [] },
    session: 'capability-session',
    udid: 'SIM-CAPABILITY',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.targetBinding.status, 'mismatch');
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_capability_target')?.status, 'failed');
});

test('agent-device availability rejects an untrusted lease before adapter probes', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-target-mismatch-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const leaseEvidencePath = path.join(tempDir, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify({
    schemaVersion: 1,
    status: 'released',
    runId: 'older-run',
    resource: { platform: 'ios', targetId: 'SIM-OTHER' },
  })}\n`, 'utf8');
  let executorCalls = 0;
  const result = await checkAgentDeviceAvailability({
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      executorCalls += 1;
      if (args[0] === 'capabilities') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            availableCommands: ['click'],
            device: { id: 'SIM-OTHER', platform: 'ios', target: 'mobile' },
          }),
        };
      }
      if (args.join(' ') === 'devices --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ data: { devices: [{ platform: 'ios', id: 'SIM-OTHER', target: 'mobile', booted: true }] } }),
        };
      }
      if (args.join(' ') === 'session list --json') {
        return {
          args,
          command,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ data: { sessions: [{ name: 'exact-session', platform: 'ios', udid: 'SIM-OTHER' }] } }),
        };
      }
      return { args, command, exitCode: 0, stderr: '', stdout: 'Agent Device command line\n' };
    },
    leaseEvidencePath,
    leaseRunId: 'target-bound-run',
    platform: 'ios',
    scenario: {
      id: 'target-mismatch',
      steps: [{
        id: 'tap',
        kind: 'gesture',
        driverAction: 'tap',
        selector: { kind: 'accessibilityLabel', value: 'Category' },
      }],
    },
    session: 'exact-session',
    udid: 'SIM-EXACT',
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.targetBinding.status, 'mismatch');
  assert.equal(result.targetBinding.leaseStatus, 'untrusted');
  assert.equal(executorCalls, 0);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks.find((check: {name: string}) => check.name === 'agent_device_resource_lease')?.status, 'failed');
});

test('agent-device capture executes scenario driver actions and writes artifacts', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const scenario = {
    id: 'agent-device-scenario',
    flowId: 'agent-device-flow',
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
  assert.equal(readJson(path.join(tempDir, 'health.json')).scenarioId, 'agent-device-scenario');
  assert.equal(readJson(path.join(tempDir, 'health.json')).flowId, 'agent-device-flow');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'not_evaluated');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).scenarioId, 'agent-device-scenario');
  assert.equal(readJson(path.join(tempDir, 'raw', 'agent-device-metadata.json')).scenarioId, 'agent-device-scenario');
  assert.equal(readJson(path.join(tempDir, 'raw', 'agent-device-metadata.json')).flowId, 'agent-device-flow');
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

test('agent-device capture rejects reader-only scenarios before output or executor calls', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-reader-only-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const outputDir = path.join(tempRoot, 'output');
  const calls: string[] = [];

  await assert.rejects(
    () => runAgentDeviceCapture({
      driverSteps: [],
      executor: async (command: string, args: string[]): Promise<CommandResult> => {
        calls.push(`${command} ${args.join(' ')}`);
        return { command, args, exitCode: 0, stderr: '', stdout: '' };
      },
      outputDir,
      platform: 'ios',
      scenario: { schemaVersion: '1.1.0', id: 'reader-only' },
    }),
    /Scenario schemaVersion 1\.1\.0 is reader-only/u,
  );
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(outputDir), false);
});

test('agent-device capture records a trusted exact-target lease', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-capture-lease-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const outputDir = path.join(tempRoot, 'output');
  const leaseEvidencePath = path.join(tempRoot, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(activeLeaseJournal({
    platform: 'ios',
    runId: 'capture-lease-run',
    targetId: 'SIM-CAPTURE',
  }))}\n`, 'utf8');
  const calls: string[] = [];

  await runAgentDeviceCapture({
    app: 'dev.example.app',
    driverSteps: [],
    executor: async (command: string, args: string[]): Promise<CommandResult> => {
      calls.push(`${command} ${args.join(' ')}`);
      if (args[0] === 'capabilities') {
        return {
          command,
          args,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            availableCommands: ['open'],
            device: { id: 'SIM-CAPTURE', platform: 'ios', target: 'mobile' },
          }),
        };
      }
      if (args.join(' ') === 'devices --json') {
        return {
          command,
          args,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            data: { devices: [{ platform: 'ios', id: 'SIM-CAPTURE', target: 'mobile', booted: true }] },
          }),
        };
      }
      if (args.join(' ') === 'session list --json') {
        return {
          command,
          args,
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            data: { sessions: [{ name: 'capture-session', platform: 'ios', target: 'mobile', udid: 'SIM-CAPTURE' }] },
          }),
        };
      }
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: args[0] === '--help' ? 'Agent Device command line\n' : '',
      };
    },
    leaseEvidencePath,
    leaseRunId: 'capture-lease-run',
    open: true,
    outputDir,
    platform: 'ios',
    runId: 'capture-run',
    scenario: { id: 'capture-lease-scenario', steps: [] },
    session: 'capture-session',
    sessionMode: 'bind',
    udid: 'SIM-CAPTURE',
  });

  assert.deepEqual(calls, [
    'agent-device capabilities --platform ios --target mobile --udid SIM-CAPTURE --session capture-session --json',
    'agent-device --help',
    'agent-device devices --json',
    'agent-device session list --json',
    'agent-device open dev.example.app --platform ios --target mobile --udid SIM-CAPTURE --session capture-session --json',
  ]);
  const metadata = readJson(path.join(outputDir, 'raw', 'agent-device-metadata.json'));
  assert.equal(metadata.runId, 'capture-run');
  assert.equal(metadata.leaseRunId, 'capture-lease-run');
  assert.equal(metadata.leaseStatus, 'trusted');
  assert.equal(metadata.requestedTarget, 'SIM-CAPTURE');
  assert.deepEqual(metadata.requiredCommands, ['devices', 'open', 'session list']);
  assert.equal(metadata.scenarioId, 'capture-lease-scenario');
});

test('agent-device capture rejects a session bound to another target before output or mutable work', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-capture-session-mismatch-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const outputDir = path.join(tempRoot, 'output');
  const leaseEvidencePath = path.join(tempRoot, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify(activeLeaseJournal({
    platform: 'ios',
    runId: 'capture-session-mismatch-run',
    targetId: 'SIM-EXPECTED',
  }))}\n`, 'utf8');
  const calls: string[] = [];

  await assert.rejects(
    () => runAgentDeviceCapture({
      driverSteps: [],
      executor: async (command: string, args: string[]): Promise<CommandResult> => {
        calls.push(args.join(' '));
        if (args[0] === 'capabilities') {
          return {
            command,
            args,
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              availableCommands: [],
              device: { id: 'SIM-EXPECTED', platform: 'ios', target: 'mobile' },
            }),
          };
        }
        if (args.join(' ') === 'devices --json') {
          return {
            command,
            args,
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              data: { devices: [{ platform: 'ios', id: 'SIM-EXPECTED', target: 'mobile', booted: true }] },
            }),
          };
        }
        if (args.join(' ') === 'session list --json') {
          return {
            command,
            args,
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              data: { sessions: [{ name: 'capture-session', platform: 'ios', target: 'mobile', udid: 'SIM-OTHER' }] },
            }),
          };
        }
        return { command, args, exitCode: 0, stderr: '', stdout: 'Agent Device command line\n' };
      },
      leaseEvidencePath,
      leaseRunId: 'capture-session-mismatch-run',
      outputDir,
      platform: 'ios',
      scenario: { id: 'capture-session-mismatch-scenario', steps: [] },
      session: 'capture-session',
      sessionMode: 'bind',
      udid: 'SIM-EXPECTED',
    }),
    /target-bound availability preflight failed/iu,
  );

  assert.deepEqual(calls, [
    'capabilities --platform ios --target mobile --udid SIM-EXPECTED --session capture-session --json',
    '--help',
    'devices --json',
    'session list --json',
  ]);
  assert.equal(fs.existsSync(outputDir), false);
});

test('agent-device rejects conflicting exact-target selectors before probes or output', async (t: TestContext) => {
  let executorCalls = 0;
  await assert.rejects(
    checkAgentDeviceAvailability({
      device: 'SIM-DEVICE',
      executor: async (): Promise<CommandResult> => {
        executorCalls += 1;
        throw new Error('executor must not run for conflicting selectors');
      },
      platform: 'ios',
      udid: 'SIM-UDID',
    }),
    /mutually exclusive/iu,
  );
  assert.equal(executorCalls, 0);

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-conflicting-selectors-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const outputDir = path.join(tempRoot, 'output');
  await assert.rejects(
    runAgentDeviceCapture({
      device: 'SIM-DEVICE',
      driverSteps: [],
      executor: async (): Promise<CommandResult> => {
        executorCalls += 1;
        throw new Error('executor must not run for conflicting selectors');
      },
      outputDir,
      platform: 'ios',
      udid: 'SIM-UDID',
    }),
    /mutually exclusive/iu,
  );
  assert.equal(executorCalls, 0);
  assert.equal(fs.existsSync(outputDir), false);
});

test('agent-device capture rejects an untrusted lease before output or executor calls', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-agent-device-capture-lease-rejected-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const outputDir = path.join(tempRoot, 'output');
  const leaseEvidencePath = path.join(tempRoot, 'resource-lease.json');
  await fsp.writeFile(leaseEvidencePath, `${JSON.stringify({
    schemaVersion: 1,
    status: 'released',
    runId: 'older-run',
    resource: {
      platform: 'ios',
      resourceId: 'mobile-target:ios:SIM-OTHER',
      targetId: 'SIM-OTHER',
    },
  })}\n`, 'utf8');
  const calls: string[] = [];

  await assert.rejects(
    () => runAgentDeviceCapture({
      driverSteps: [],
      executor: async (command: string, args: string[]): Promise<CommandResult> => {
        calls.push(`${command} ${args.join(' ')}`);
        return { command, args, exitCode: 0, stderr: '', stdout: '' };
      },
      leaseEvidencePath,
      leaseRunId: 'capture-lease-run',
      outputDir,
      platform: 'ios',
      scenario: { id: 'capture-lease-rejected', steps: [] },
      udid: 'SIM-CAPTURE',
    }),
    /trusted active ASL lease/u,
  );
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(outputDir), false);
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
        id: 'press-system-back',
        kind: 'gesture',
        driverAction: 'pressKey',
        adapterOptions: {
          agentDevice: {
            key: 'systemBack',
            rawFileName: 'press-system-back.txt',
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
      driverAction: 'pressKey',
      key: 'systemBack',
      rawFileName: 'press-system-back.txt',
      required: true,
      stepId: 'press-system-back',
      waitMs: 0,
    },
    {
      driverAction: 'swipe',
      durationMs: 250,
      endX: 300,
      endY: 400,
      rawFileName: 'agent-device-swipe-9.txt',
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
      captureFileName: 'agent-device-screenshot-12.png',
      driverAction: 'screenshot',
      rawFileName: 'agent-device-screenshot-12.txt',
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
        driverAction: 'pressKey',
        required: true,
        stepId: 'press-key-missing',
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
      'step `press-key-missing` uses driverAction `pressKey` but is missing supported adapterOptions.agentDevice.key.',
      'step `swipe-missing` uses driverAction `swipe` but is missing adapterOptions.agentDevice.startX/startY/endX/endY.',
      'step `type-missing` uses driverAction `typeText` but is missing adapterOptions.agentDevice.text.',
    ],
  );
});
