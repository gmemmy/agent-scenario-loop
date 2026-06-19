const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertNoRegressedComparisons,
  buildBaselineRunId,
  buildLiveRunId,
  formatResult,
  normalizeRunSuffix,
  resolveIosDeviceId,
  runExampleIosLiveProof,
} = require('../example-ios-live');
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

test('normalizes iOS example live run suffixes', () => {
  assert.equal(normalizeRunSuffix(' PR 123 / before '), 'pr-123-before');
  assert.equal(normalizeRunSuffix('---'), null);
  assert.equal(buildLiveRunId('ios-live-startup', 'pr-123'), 'ios-live-startup-pr-123');
  assert.equal(buildLiveRunId('ios-live-startup', null), 'ios-live-startup');
  assert.equal(buildBaselineRunId('ios-live-startup', 'pr-123'), 'ios-live-startup-pr-123-baseline');
  assert.equal(buildBaselineRunId('ios-live-startup', null), 'ios-live-startup-baseline');
});

test('resolves the iOS example device from args, env, then booted fallback', () => {
  const previous = process.env.ASL_EXAMPLE_IOS_UDID;
  try {
    delete process.env.ASL_EXAMPLE_IOS_UDID;
    assert.equal(resolveIosDeviceId({}), 'booted');
    process.env.ASL_EXAMPLE_IOS_UDID = DEVICE_ID;
    assert.equal(resolveIosDeviceId({}), DEVICE_ID);
    assert.equal(resolveIosDeviceId({ device: 'explicit-device' }), 'explicit-device');
  } finally {
    if (typeof previous === 'string') {
      process.env.ASL_EXAMPLE_IOS_UDID = previous;
    } else {
      delete process.env.ASL_EXAMPLE_IOS_UDID;
    }
  }
});

test('iOS example live proof regression gate reports the aggregate summary', () => {
  const result = {
    aggregateSummary: {
      summaryPath: '/tmp/asl/ios-live-proof/agent-summary.md',
    },
    comparisons: [
      { label: 'startup', status: 'unchanged' },
      { label: 'open-close', status: 'worse' },
    ],
  };

  assert.throws(
    () => assertNoRegressedComparisons({ platformLabel: 'iOS', result }),
    /iOS example live proof found regressed comparison\(s\): open-close\. Inspect \/tmp\/asl\/ios-live-proof\/agent-summary\.md\./u,
  );
  assert.doesNotThrow(() => assertNoRegressedComparisons({
    platformLabel: 'iOS',
    result: {
      ...result,
      comparisons: [{ label: 'startup', status: 'low_confidence' }],
    },
  }));
});

/**
 * Reads fixture profile events for one iOS example scenario.
 *
 * @param {string} scenario
 * @param {string} runId
 * @returns {Record<string, unknown>[]}
 */
function readFixtureEvents(scenario: string, runId: string): Record<string, unknown>[] {
  const fixtureMap: Record<string, { file: string; fixtureRunId: string }> = {
    'app-startup': {
      file: 'app-startup.log',
      fixtureRunId: 'example-startup',
    },
    'open-close-cycle': {
      file: 'open-close-cycle.log',
      fixtureRunId: 'example-open-close',
    },
    'scroll-settle': {
      file: 'scroll-settle.log',
      fixtureRunId: 'example-scroll',
    },
  };
  const fixture = fixtureMap[scenario];
  if (!fixture) {
    throw new Error(`missing fixture for ${scenario}`);
  }

  return fs
    .readFileSync(path.join(ROOT, 'examples', 'mobile-app', 'event-logs', fixture.file), 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line: string) => JSON.parse(line.slice(line.indexOf('[profile-event]') + '[profile-event]'.length).trim()))
    .map((event: Record<string, unknown>) => ({
      ...event,
      runId,
    }));
}

/**
 * Writes fixture events into the fake simulator app storage after launch.
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
  if (!fs.existsSync(manifestPath)) {
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const session = JSON.parse(manifest['agent-scenario-loop.profile-session.1']);
  manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify(
    readFixtureEvents(session.scenario, session.runId),
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}

test('runs the packaged iOS example live proof with a fake simctl executor', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-ios-live-'));
  const previousDevice = process.env.ASL_EXAMPLE_IOS_UDID;
  const previousDevClientUrl = process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_URL;
  const previousDevClientWaitMs = process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_WAIT_MS;
  process.env.ASL_EXAMPLE_IOS_UDID = DEVICE_ID;
  process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_URL = 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097';
  process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_WAIT_MS = '15';
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-ios-data-'));
  t.after(async () => {
    if (typeof previousDevice === 'string') {
      process.env.ASL_EXAMPLE_IOS_UDID = previousDevice;
    } else {
      delete process.env.ASL_EXAMPLE_IOS_UDID;
    }
    if (typeof previousDevClientUrl === 'string') {
      process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_URL = previousDevClientUrl;
    } else {
      delete process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_URL;
    }
    if (typeof previousDevClientWaitMs === 'string') {
      process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_WAIT_MS = previousDevClientWaitMs;
    } else {
      delete process.env.ASL_EXAMPLE_IOS_DEV_CLIENT_WAIT_MS;
    }
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });

  const calls: string[] = [];
  const agentDeviceCalls: string[] = [];
  const argentCalls: string[] = [];
  const orderedCalls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    orderedCalls.push(`simctl:${key}`);

    if (key === 'simctl list devices') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          `    iPhone 17 Pro Max (${DEVICE_ID}) (Booted)`,
        ].join('\n'),
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
      return { command, args, exitCode: 0, stderr: '', stdout: `${BUNDLE_ID}: 1234\n` };
    }
    if (key.startsWith(`simctl openurl ${DEVICE_ID} asl-example://expo-development-client/`)) {
      writeCurrentSessionEvents(dataContainer);
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.startsWith(`simctl io ${DEVICE_ID} screenshot `)) {
      const screenshotPath = args.at(-1);
      assert.equal(typeof screenshotPath, 'string');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return { command, args, exitCode: 0, stderr: '', stdout: `Wrote screenshot to ${screenshotPath}\n` };
    }
    if (key === `simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"`) {
      writeCurrentSessionEvents(dataContainer);
      return { command, args, exitCode: 0, stderr: '', stdout: 'Timestamp Ty Process[PID:TID]\n' };
    }

    return { command, args, exitCode: 1, stderr: `unexpected command: ${key}`, stdout: '' };
  };
  const agentDeviceExecutor = async (command: string, args: string[]): Promise<AgentDeviceCommandResult> => {
    const key = args.join(' ');
    agentDeviceCalls.push(key);
    orderedCalls.push(`agent-device:${key}`);
    if (args[0] === 'screenshot' && typeof args[1] === 'string') {
      await fsp.writeFile(args[1], 'fake screenshot', 'utf8');
    }
    return {
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: '{"success":true}\n',
    };
  };
  const argentExecutor = async (command: string, args: string[]): Promise<ArgentCommandResult> => {
    const key = args.join(' ');
    argentCalls.push(key);
    orderedCalls.push(`argent:${key}`);
    if (args.includes('screenshot')) {
      const screenshotPath = path.join(outputDir, 'fake-argent-ios.png');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: `Saved screenshot: ${screenshotPath}\n`,
      };
    }
    if (args.includes('describe')) {
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"description":"Example Mobile App"}\n',
      };
    }
    if (args.includes('launch-app')) {
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: `{"launched":true,"bundleId":"${BUNDLE_ID}"}\n`,
      };
    }
    return { args, command, exitCode: 1, stderr: `unexpected Argent command: ${key}`, stdout: '' };
  };

  await runExampleIosLiveProof({
    'agent-device-proof': true,
    'argent-proof': true,
    out: outputDir,
  }, {
    agentDeviceExecutor,
    argentExecutor,
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  const result = await runExampleIosLiveProof({
    'agent-device-proof': true,
    'argent-proof': true,
    'compare-latest': true,
    out: outputDir,
    'run-suffix': 'PR 123',
    'seed-baseline': true,
  }, {
    agentDeviceExecutor,
    argentExecutor,
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  assert.equal(result.profiles.length, 3);
  assert.equal(result.seededBaselines.length, 3);
  assert.equal(result.interactionProofs.length, 2);
  assert.equal(result.comparisons.length, 3);
  assert.equal(fs.existsSync(result.aggregateSummary.liveProofPath), true);
  assert.equal(fs.existsSync(result.aggregateSummary.summaryPath), true);
  assert.match(formatResult(result), /iOS example live proof passed/u);
  assert.match(formatResult(result), /Live proof:/u);
  assert.match(formatResult(result), /Comparisons:/u);
  assert.equal(calls.some((call) => call === `simctl launch ${DEVICE_ID} ${BUNDLE_ID}`), false);
  assert.equal(
    calls.filter((call) => call.startsWith(`simctl openurl ${DEVICE_ID} asl-example://expo-development-client/`)).length,
    9,
  );
  assert.ok(agentDeviceCalls.some((call) => call.includes(`open ${BUNDLE_ID}`)));
  assert.ok(agentDeviceCalls.some((call) => call.includes('is visible id="asl-example-title"')));
  assert.ok(agentDeviceCalls.some((call) => call.includes('screenshot')));
  assert.ok(argentCalls.some((call) => call.includes(`launch-app --udid ${DEVICE_ID} --bundleId ${BUNDLE_ID}`)));
  assert.ok(argentCalls.some((call) => call.includes(`describe --udid ${DEVICE_ID} --bundleId ${BUNDLE_ID}`)));
  assert.ok(argentCalls.some((call) => call.includes(`screenshot --udid ${DEVICE_ID}`)));
  const firstProfileOpenUrl = orderedCalls.findIndex((call) => (
    call.startsWith(`simctl:simctl openurl ${DEVICE_ID} asl-example://expo-development-client/`)
  ));
  assert.ok(firstProfileOpenUrl > -1, 'expected iOS profile dev-client open URL command');
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`agent-device:open ${BUNDLE_ID}`)) > firstProfileOpenUrl,
    'agent-device startup proof should run after profile evidence capture',
  );
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`argent:run launch-app --udid ${DEVICE_ID} --bundleId ${BUNDLE_ID}`)) > firstProfileOpenUrl,
    'Argent startup proof should run after profile evidence capture',
  );
  assert.deepEqual(
    result.profiles.map((profile: { runId: string }) => profile.runId),
    ['ios-live-startup-pr-123', 'ios-live-open-close-pr-123', 'ios-live-scroll-pr-123'],
  );
  assert.deepEqual(
    result.seededBaselines.map((profile: { runId: string }) => profile.runId),
    [
      'ios-live-startup-pr-123-baseline',
      'ios-live-open-close-pr-123-baseline',
      'ios-live-scroll-pr-123-baseline',
    ],
  );

  for (const profile of result.profiles) {
    const health = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'health.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'manifest.json'), 'utf8'));
    const verdict = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'verdict.json'), 'utf8'));
    assert.equal(manifest.comparisonLane, 'example-ios-live+agent-device+argent');
    assert.equal(health.healthStatus, 'passed');
    assert.equal(verdict.verdictStatus, 'passed');
  }

  for (const comparison of result.comparisons) {
    assert.equal(comparison.status, 'unchanged');
    assert.equal(fs.existsSync(path.join(comparison.comparisonDir, 'comparison.json')), true);
    assert.equal(fs.existsSync(path.join(comparison.comparisonDir, 'agent-summary.md')), true);
  }

  const aggregate = JSON.parse(fs.readFileSync(result.aggregateSummary.liveProofPath, 'utf8'));
  assert.equal(aggregate.platform, 'ios');
  assert.equal(aggregate.runId, 'ios-live-proof-pr-123');
  assert.deepEqual(
    aggregate.interactionProofs.map((proof: { captures?: { screenshots: string[] }; healthStatus: string; label: string; runnerId: string; verdictStatus: string }) => ({
      captures: proof.captures?.screenshots.length ?? 0,
      healthStatus: proof.healthStatus,
      label: proof.label,
      runnerId: proof.runnerId,
      verdictStatus: proof.verdictStatus,
    })),
    [
      {
        captures: 1,
        healthStatus: 'passed',
        label: 'startup-ui',
        runnerId: 'agent-device',
        verdictStatus: 'not_evaluated',
      },
      {
        captures: 1,
        healthStatus: 'passed',
        label: 'startup-ui-argent',
        runnerId: 'argent',
        verdictStatus: 'not_evaluated',
      },
    ],
  );
  assert.equal(aggregate.comparisonStatus, 'unchanged');
  assert.deepEqual(aggregate.comparisonCounts, {
    better: 0,
    inconclusive: 0,
    low_confidence: 0,
    mixed: 0,
    skipped: 0,
    unchanged: 3,
    worse: 0,
  });
  assert.equal(aggregate.nextAction.code, 'inspect_summary');
  assert.deepEqual(
    aggregate.comparisons.map((comparison: { metricSummary?: { counts: Record<string, number>; notableMetrics: unknown[] } }) => comparison.metricSummary),
    [
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 1,
          inconclusive: 0,
          low_confidence: 0,
        },
        notableMetrics: [],
      },
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 3,
          inconclusive: 0,
          low_confidence: 0,
        },
        notableMetrics: [],
      },
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 3,
          inconclusive: 0,
          low_confidence: 0,
        },
        notableMetrics: [],
      },
    ],
  );
  assert.equal(aggregate.profiles.length, 3);
  assert.deepEqual(
    aggregate.profiles.map((profile: { healthStatus: string; verdictStatus: string }) => ({
      healthStatus: profile.healthStatus,
      verdictStatus: profile.verdictStatus,
    })),
    [
      { healthStatus: 'passed', verdictStatus: 'passed' },
      { healthStatus: 'passed', verdictStatus: 'passed' },
      { healthStatus: 'passed', verdictStatus: 'passed' },
    ],
  );
  assert.equal(aggregate.comparisons.length, 3);

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
    () => runExampleIosLiveProof({
      'agent-device-proof': true,
      device: DEVICE_ID,
      out: outputDir,
      'run-suffix': 'sidecar failure',
    }, {
      agentDeviceExecutor: failedAgentDeviceExecutor,
      delay: async () => {},
      executor,
      packageRoot: ROOT,
    }),
    /iOS example live proof failed\. Inspect /u,
  );
  const failedSidecarAggregate = JSON.parse(fs.readFileSync(
    path.join(outputDir, '_live-proof', 'ios-live-proof-sidecar-failure', 'live-proof.json'),
    'utf8',
  ));
  assert.equal(failedSidecarAggregate.status, 'failed');
  assert.equal(failedSidecarAggregate.nextAction.code, 'inspect_failed_run');
  assert.equal(failedSidecarAggregate.skippedInteractionProofs, undefined);
  assert.deepEqual(
    failedSidecarAggregate.interactionProofs.map((proof: { healthStatus: string; runnerId: string }) => ({
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

test('iOS example live proof writes failed aggregate before skipping requested sidecars on failed profiles', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-ios-live-failed-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-ios-data-failed-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });

  const sidecarCalls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    if (key === 'simctl list devices') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          `    iPhone 17 Pro Max (${DEVICE_ID}) (Booted)`,
        ].join('\n'),
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
  const sidecarExecutor = async (command: string, args: string[]): Promise<AgentDeviceCommandResult> => {
    sidecarCalls.push(`${command} ${args.join(' ')}`);
    return { args, command, exitCode: 0, stderr: '', stdout: '{"success":true}\n' };
  };
  const argentExecutor = async (command: string, args: string[]): Promise<ArgentCommandResult> => {
    sidecarCalls.push(`${command} ${args.join(' ')}`);
    return { args, command, exitCode: 0, stderr: '', stdout: '{"success":true}\n' };
  };

  await assert.rejects(
    () => runExampleIosLiveProof({
      'agent-device-proof': true,
      'argent-proof': true,
      device: DEVICE_ID,
      out: outputDir,
    }, {
      agentDeviceExecutor: sidecarExecutor,
      argentExecutor,
      delay: async () => {},
      executor,
      packageRoot: ROOT,
    }),
    /iOS example live proof failed\. Inspect /u,
  );

  assert.deepEqual(sidecarCalls, []);
  const aggregatePath = path.join(outputDir, '_live-proof', 'ios-live-proof', 'live-proof.json');
  const aggregate = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
  assert.equal(aggregate.status, 'failed');
  assert.equal(aggregate.nextAction.code, 'inspect_failed_run');
  assert.equal(aggregate.profiles.length, 3);
  assert.equal(aggregate.profiles.some((profile: { healthStatus: string }) => profile.healthStatus === 'failed'), true);
  assert.deepEqual(
    aggregate.skippedInteractionProofs.map((proof: { label: string; nextAction: { code: string }; runnerId: string }) => ({
      label: proof.label,
      nextActionCode: proof.nextAction.code,
      runnerId: proof.runnerId,
    })),
    [
      {
        label: 'startup-ui',
        nextActionCode: 'fix_profile_gate',
        runnerId: 'agent-device',
      },
      {
        label: 'startup-ui-argent',
        nextActionCode: 'fix_profile_gate',
        runnerId: 'argent',
      },
    ],
  );
});
