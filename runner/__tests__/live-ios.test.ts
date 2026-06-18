const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runIosLiveProof,
} = require('../live-ios');
const {
  resolveAsyncStorageDirectory,
} = require('../ios-simctl');

type CommandResult = import('../ios-simctl').CommandResult;
type AgentDeviceCommandResult = import('../agent-device').CommandResult;
type ArgentCommandResult = import('../argent').CommandResult;
type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');
const BUNDLE_ID = 'dev.agent-scenario-loop.example';
const DEVICE_ID = 'A692ED28-893E-453F-8866-C69331AE757F';

/**
 * Reads the iOS startup fixture events with the requested run id.
 *
 * @param {string} runId
 * @returns {Record<string, unknown>[]}
 */
function readStartupEvents(runId: string): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(ROOT, 'examples', 'mobile-app', 'event-logs', 'app-startup.log'), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line: string) => JSON.parse(line.slice(line.indexOf('[profile-event]') + '[profile-event]'.length).trim()))
    .map((event: Record<string, unknown>) => ({ ...event, runId }));
}

/**
 * Writes fixture events into fake AsyncStorage for the currently seeded session.
 *
 * @param {string} dataContainer
 * @returns {void}
 */
function writeCurrentSessionEvents(dataContainer: string): void {
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: BUNDLE_ID,
    dataContainer,
  });
  const manifestPath = path.join(storageDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const session = JSON.parse(manifest['agent-scenario-loop.profile-session.1']);
  manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify(readStartupEvents(session.runId));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}

test('generic iOS live proof captures profile evidence before sidecar proofs', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-ios-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-ios-data-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });

  const orderedCalls: string[] = [];
  const waits: number[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    orderedCalls.push(`simctl:${key}`);

    if (key === 'simctl list devices') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: ['== Devices ==', '-- iOS 26.3 --', `    iPhone 17 Pro Max (${DEVICE_ID}) (Booted)`].join('\n'),
      };
    }
    if (key === `simctl get_app_container ${DEVICE_ID} ${BUNDLE_ID} app`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '/tmp/ASLExampleMobile.app\n' };
    }
    if (key === `simctl get_app_container ${DEVICE_ID} ${BUNDLE_ID} data`) {
      return { command, args, exitCode: 0, stderr: '', stdout: `${dataContainer}\n` };
    }
    if (key === `simctl terminate ${DEVICE_ID} ${BUNDLE_ID}`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === `simctl launch ${DEVICE_ID} ${BUNDLE_ID}`) {
      writeCurrentSessionEvents(dataContainer);
      return { command, args, exitCode: 0, stderr: '', stdout: `${BUNDLE_ID}: 1234\n` };
    }
    if (key.startsWith(`simctl openurl ${DEVICE_ID} asl-example://expo-development-client/`)) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.startsWith(`simctl io ${DEVICE_ID} screenshot `)) {
      const screenshotPath = args.at(-1);
      assert.equal(typeof screenshotPath, 'string');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return { command, args, exitCode: 0, stderr: '', stdout: `Wrote screenshot to ${screenshotPath}\n` };
    }
    if (key === `simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"`) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Timestamp Ty Process[PID:TID]\n' };
    }

    return { command, args, exitCode: 1, stderr: `unexpected command: ${key}`, stdout: '' };
  };
  const agentDeviceExecutor = async (command: string, args: string[]): Promise<AgentDeviceCommandResult> => {
    const key = args.join(' ');
    orderedCalls.push(`agent-device:${key}`);
    if (args[0] === 'screenshot' && typeof args[1] === 'string') {
      await fsp.writeFile(args[1], 'fake screenshot', 'utf8');
    }
    return { args, command, exitCode: 0, stderr: '', stdout: '{"success":true}\n' };
  };
  const argentExecutor = async (command: string, args: string[]): Promise<ArgentCommandResult> => {
    const key = args.join(' ');
    orderedCalls.push(`argent:${key}`);
    if (args.includes('screenshot')) {
      const screenshotPath = path.join(outputDir, 'argent-ios.png');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return { args, command, exitCode: 0, stderr: '', stdout: `Saved screenshot: ${screenshotPath}\n` };
    }
    if (args.includes('describe')) {
      return { args, command, exitCode: 0, stderr: '', stdout: '{"description":"Example Mobile App"}\n' };
    }
    if (args.includes('launch-app')) {
      return { args, command, exitCode: 0, stderr: '', stdout: `{"launched":true,"bundleId":"${BUNDLE_ID}"}\n` };
    }
    return { args, command, exitCode: 1, stderr: `unexpected Argent command: ${key}`, stdout: '' };
  };

  const result = await runIosLiveProof({
    'agent-device-proof': true,
    'argent-proof': true,
    bundle: BUNDLE_ID,
    config: path.join(ROOT, 'examples', 'mobile-app', 'asl.config.json'),
    device: DEVICE_ID,
    'ios-dev-client-url': 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
    'ios-dev-client-wait-ms': '15',
    out: outputDir,
    scenario: path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'),
  }, {
    agentDeviceExecutor,
    argentExecutor,
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const liveProof = JSON.parse(fs.readFileSync(result.aggregateSummary.liveProofPath, 'utf8'));
  assert.equal(liveProof.status, 'passed');
  assert.deepEqual(
    liveProof.interactionProofs.map((proof: { runnerId: string }) => proof.runnerId),
    ['agent-device', 'argent'],
  );

  const profileCapture = orderedCalls.findIndex((call) => (
    call === `simctl:simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"`
  ));
  assert.ok(profileCapture > -1, 'expected iOS profile evidence capture command');
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`agent-device:open ${BUNDLE_ID}`)) > profileCapture,
    'agent-device proof should run after iOS profile evidence capture',
  );
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`argent:run launch-app --udid ${DEVICE_ID} --bundleId ${BUNDLE_ID}`)) > profileCapture,
    'Argent proof should run after iOS profile evidence capture',
  );
  assert.ok(waits.includes(9000), 'expected generic iOS live proof to derive the startup capture window from scenario timeouts');
  assert.ok(waits.includes(15), 'expected generic iOS live proof to wait after opening the dev-client URL');
  assert.ok(
    orderedCalls.some((call) => call.startsWith(`simctl:simctl openurl ${DEVICE_ID} asl-example://expo-development-client/`)),
    'expected generic iOS live proof to open the dev-client URL before evidence capture',
  );

  const failedAgentDeviceExecutor = async (command: string, args: string[]): Promise<AgentDeviceCommandResult> => {
    orderedCalls.push(`failed-agent-device:${args.join(' ')}`);
    return {
      args,
      command,
      exitCode: 1,
      stderr: 'agent-device could not inspect the app',
      stdout: '',
    };
  };
  await assert.rejects(
    () => runIosLiveProof({
      'agent-device-proof': true,
      bundle: BUNDLE_ID,
      config: path.join(ROOT, 'examples', 'mobile-app', 'asl.config.json'),
      device: DEVICE_ID,
      out: outputDir,
      'run-suffix': 'sidecar failure',
      scenario: path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'),
    }, {
      agentDeviceExecutor: failedAgentDeviceExecutor,
      delay: async (ms: number) => {
        waits.push(ms);
      },
      executor,
    }),
    /iOS live proof failed\. Inspect/u,
  );
  const failedSidecarProof = JSON.parse(fs.readFileSync(
    path.join(outputDir, '_live-proof', 'ios-live-proof-sidecar-failure', 'live-proof.json'),
    'utf8',
  ));
  assert.equal(failedSidecarProof.status, 'failed');
  assert.equal(failedSidecarProof.nextAction.code, 'inspect_failed_run');
  assert.equal(failedSidecarProof.skippedInteractionProofs, undefined);
  assert.deepEqual(
    failedSidecarProof.interactionProofs.map((proof: { healthStatus: string; runnerId: string }) => ({
      healthStatus: proof.healthStatus,
      runnerId: proof.runnerId,
    })),
    [
      {
        healthStatus: 'failed',
        runnerId: 'agent-device',
      },
    ],
  );
});

test('generic iOS live proof can use deep-link profile transport without terminating the app', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-ios-deeplink-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const profileRunId = 'app-startup-ios-live-warm-path';
  const orderedCalls: string[] = [];
  const waits: number[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    orderedCalls.push(`simctl:${key}`);

    if (key === 'simctl list devices') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: ['== Devices ==', '-- iOS 26.3 --', `    iPhone 17 Pro Max (${DEVICE_ID}) (Booted)`].join('\n'),
      };
    }
    if (key === `simctl spawn ${DEVICE_ID} launchctl getenv DYLD_INSERT_LIBRARIES`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === `simctl spawn ${DEVICE_ID} launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === `simctl get_app_container ${DEVICE_ID} ${BUNDLE_ID} app`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '/tmp/ASLExampleMobile.app\n' };
    }
    if (key === `simctl launch ${DEVICE_ID} ${BUNDLE_ID}`) {
      return { command, args, exitCode: 0, stderr: '', stdout: `${BUNDLE_ID}: 4321\n` };
    }
    if (key.startsWith(`simctl openurl ${DEVICE_ID} asl-example://expo-development-client/`)) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.startsWith(`simctl openurl ${DEVICE_ID} asl-example://profile-session/start`)) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.startsWith(`simctl io ${DEVICE_ID} screenshot `)) {
      const screenshotPath = args.at(-1);
      assert.equal(typeof screenshotPath, 'string');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return { command, args, exitCode: 0, stderr: '', stdout: `Wrote screenshot to ${screenshotPath}\n` };
    }
    if (key === `simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "${BUNDLE_ID}" AND eventMessage CONTAINS "4321"`) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'No native app exit was found.\n' };
    }
    if (key === `simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"`) {
      const stdout = readStartupEvents(profileRunId)
        .map((event) => `HelpBnk [profile-event] ${JSON.stringify(event)}`)
        .join('\n');
      return { command, args, exitCode: 0, stderr: '', stdout };
    }

    return { command, args, exitCode: 1, stderr: `unexpected command: ${key}`, stdout: '' };
  };

  const result = await runIosLiveProof({
    bundle: BUNDLE_ID,
    config: path.join(ROOT, 'examples', 'mobile-app', 'asl.config.json'),
    device: DEVICE_ID,
    'ios-dev-client-url': 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
    'ios-dev-client-wait-ms': '15',
    'ios-profile-session-transport': 'deeplink',
    out: outputDir,
    'run-suffix': 'warm path',
    scenario: path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'),
  }, {
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
  });

  const liveProof = JSON.parse(fs.readFileSync(result.aggregateSummary.liveProofPath, 'utf8'));
  assert.equal(liveProof.status, 'passed');
  assert.equal(orderedCalls.some((call) => call.includes('simctl terminate ')), false);
  assert.equal(orderedCalls.some((call) => call.includes(`get_app_container ${DEVICE_ID} ${BUNDLE_ID} data`)), false);
  assert.ok(
    orderedCalls.some((call) => call.startsWith(`simctl:simctl openurl ${DEVICE_ID} asl-example://profile-session/start`)),
    'expected deep-link profile session start',
  );
  assert.ok(waits.includes(9000), 'expected warm proof to still use the scenario capture window');
});

test('generic iOS live proof writes failed aggregate before skipping sidecars on failed profile gate', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-ios-failed-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-ios-data-failed-'));
  const scenarioPath = path.join(outputDir, 'failing-startup.json');
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });

  const scenario = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'), 'utf8'),
  );
  scenario.budgets = [
    {
      name: 'startup first usable p95',
      source: 'milestone',
      metric: 'p95',
      unit: 'ms',
      limit: 1,
      toMilestone: 'firstUsable',
    },
  ];
  await fsp.writeFile(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');

  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');

    if (key === 'simctl list devices') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: ['== Devices ==', '-- iOS 26.3 --', `    iPhone 17 Pro Max (${DEVICE_ID}) (Booted)`].join('\n'),
      };
    }
    if (key === `simctl get_app_container ${DEVICE_ID} ${BUNDLE_ID} app`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '/tmp/ASLExampleMobile.app\n' };
    }
    if (key === `simctl get_app_container ${DEVICE_ID} ${BUNDLE_ID} data`) {
      return { command, args, exitCode: 0, stderr: '', stdout: `${dataContainer}\n` };
    }
    if (key === `simctl terminate ${DEVICE_ID} ${BUNDLE_ID}`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === `simctl launch ${DEVICE_ID} ${BUNDLE_ID}`) {
      writeCurrentSessionEvents(dataContainer);
      return { command, args, exitCode: 0, stderr: '', stdout: `${BUNDLE_ID}: 1234\n` };
    }
    if (key.startsWith(`simctl io ${DEVICE_ID} screenshot `)) {
      const screenshotPath = args.at(-1);
      assert.equal(typeof screenshotPath, 'string');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return { command, args, exitCode: 0, stderr: '', stdout: `Wrote screenshot to ${screenshotPath}\n` };
    }
    if (key === `simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"`) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Timestamp Ty Process[PID:TID]\n' };
    }

    return { command, args, exitCode: 1, stderr: `unexpected command: ${key}`, stdout: '' };
  };
  const agentDeviceExecutor = async (): Promise<AgentDeviceCommandResult> => {
    assert.fail('agent-device sidecar should not run after a failed profile gate');
    throw new Error('unreachable');
  };
  const argentExecutor = async (): Promise<ArgentCommandResult> => {
    assert.fail('Argent sidecar should not run after a failed profile gate');
    throw new Error('unreachable');
  };

  await assert.rejects(
    () => runIosLiveProof({
      'agent-device-proof': true,
      'argent-proof': true,
      bundle: BUNDLE_ID,
      config: path.join(ROOT, 'examples', 'mobile-app', 'asl.config.json'),
      device: DEVICE_ID,
      out: outputDir,
      scenario: scenarioPath,
    }, {
      agentDeviceExecutor,
      argentExecutor,
      delay: async () => {},
      executor,
    }),
    /iOS live proof failed\. Inspect/u,
  );

  const liveProof = JSON.parse(
    fs.readFileSync(path.join(outputDir, '_live-proof', 'ios-live-proof', 'live-proof.json'), 'utf8'),
  );
  assert.equal(liveProof.status, 'failed');
  assert.equal(liveProof.nextAction.code, 'inspect_failed_run');
  assert.deepEqual(
    liveProof.skippedInteractionProofs.map((proof: { runnerId: string }) => proof.runnerId),
    ['agent-device', 'argent'],
  );
  assert.equal(liveProof.interactionProofs, undefined);
});
