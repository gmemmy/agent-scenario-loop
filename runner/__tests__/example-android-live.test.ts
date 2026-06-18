const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertNoRegressedComparisons,
  buildLiveRunId,
  formatResult,
  normalizeRunSuffix,
  resolveAndroidSerial,
  runExampleAndroidLiveProof,
} = require('../example-android-live');

type CommandResult = import('../android-adb').CommandResult;
type AgentDeviceCommandResult = import('../agent-device').CommandResult;
type ArgentCommandResult = import('../argent').CommandResult;
type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');
const SERIAL = 'emulator-7777';

test('normalizes Android example live run suffixes', () => {
  assert.equal(normalizeRunSuffix(' PR 123 / before '), 'pr-123-before');
  assert.equal(normalizeRunSuffix('---'), null);
  assert.equal(buildLiveRunId('android-live-startup', 'pr-123'), 'android-live-startup-pr-123');
  assert.equal(buildLiveRunId('android-live-startup', null), 'android-live-startup');
});

test('resolves the Android example serial from args, env, then emulator fallback', () => {
  const previous = process.env.ASL_EXAMPLE_ANDROID_SERIAL;
  try {
    delete process.env.ASL_EXAMPLE_ANDROID_SERIAL;
    assert.equal(resolveAndroidSerial({}), 'emulator-5554');
    process.env.ASL_EXAMPLE_ANDROID_SERIAL = SERIAL;
    assert.equal(resolveAndroidSerial({}), SERIAL);
    assert.equal(resolveAndroidSerial({ serial: 'explicit-serial' }), 'explicit-serial');
  } finally {
    if (typeof previous === 'string') {
      process.env.ASL_EXAMPLE_ANDROID_SERIAL = previous;
    } else {
      delete process.env.ASL_EXAMPLE_ANDROID_SERIAL;
    }
  }
});

test('Android example live proof regression gate reports the aggregate summary', () => {
  const result = {
    aggregateSummary: {
      summaryPath: '/tmp/asl/android-live-proof/agent-summary.md',
    },
    comparisons: [
      { label: 'startup', status: 'unchanged' },
      { label: 'open-close', status: 'worse' },
    ],
  };

  assert.throws(
    () => assertNoRegressedComparisons({ platformLabel: 'Android', result }),
    /Android example live proof found regressed comparison\(s\): open-close\. Inspect \/tmp\/asl\/android-live-proof\/agent-summary\.md\./u,
  );
  assert.doesNotThrow(() => assertNoRegressedComparisons({
    platformLabel: 'Android',
    result: {
      ...result,
      comparisons: [{ label: 'startup', status: 'unchanged' }],
    },
  }));
});

/**
 * Reads fixture logcat text for one Android example scenario.
 *
 * @param {string} scenario
 * @param {string} runId
 * @returns {string}
 */
function readFixtureLog(scenario: string, runId: string): string {
  const fixtureMap: Record<string, { file: string; fixtureRunId: string }> = {
    'app-startup': {
      file: 'android-app-startup.log',
      fixtureRunId: 'android-example-startup',
    },
    'open-close-cycle': {
      file: 'android-open-close-cycle.log',
      fixtureRunId: 'android-example-open-close',
    },
    'scroll-settle': {
      file: 'android-scroll-settle.log',
      fixtureRunId: 'android-example-scroll',
    },
  };
  const fixture = fixtureMap[scenario];
  if (!fixture) {
    throw new Error(`missing fixture for ${scenario}`);
  }

  return fs
    .readFileSync(path.join(ROOT, 'examples', 'mobile-app', 'event-logs', fixture.file), 'utf8')
    .replace(new RegExp(fixture.fixtureRunId, 'gu'), runId);
}

test('runs the packaged Android example live proof with a fake adb executor', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-android-live-'));
  const previousSerial = process.env.ASL_EXAMPLE_ANDROID_SERIAL;
  process.env.ASL_EXAMPLE_ANDROID_SERIAL = SERIAL;
  t.after(async () => {
    if (typeof previousSerial === 'string') {
      process.env.ASL_EXAMPLE_ANDROID_SERIAL = previousSerial;
    } else {
      delete process.env.ASL_EXAMPLE_ANDROID_SERIAL;
    }
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  let currentScenario = 'app-startup';
  let currentRunId = 'android-live-startup';
  const calls: string[] = [];
  const agentDeviceCalls: string[] = [];
  const argentCalls: string[] = [];
  const orderedCalls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    orderedCalls.push(`adb:${key}`);

    if (key === 'version') {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Android Debug Bridge version 1.0.41\n' };
    }
    if (key === 'devices -l') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: [
          'List of devices attached',
          `${SERIAL} device product:sdk_gphone model:Pixel_6 device:emu64`,
        ].join('\n'),
      };
    }
    if (key.endsWith('shell getprop ro.product.model')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Pixel 6\n' };
    }
    if (key.endsWith('shell getprop ro.build.version.release')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '15\n' };
    }
    if (key.endsWith('shell getprop ro.build.version.sdk')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '35\n' };
    }
    if (key.endsWith('shell pm path dev.agentscenarioloop.example')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
      };
    }
    if (key === `-s ${SERIAL} reverse tcp:8097 tcp:8097`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.includes('shell run-as dev.agentscenarioloop.example sh -c') && key.includes('debug_http_host') && key.includes('localhost:8097')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.endsWith('shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Events injected: 1\n' };
    }
    if (key.endsWith('logcat -c')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.includes('profile-session/start')) {
      const runId = /runId=([^&']+)/u.exec(key)?.[1];
      const scenario = /scenario=([^&']+)/u.exec(key)?.[1];
      currentRunId = runId ?? currentRunId;
      currentScenario = scenario ?? currentScenario;
      return { command, args, exitCode: 0, stderr: '', stdout: 'Starting: Intent\n' };
    }
    if (key.includes('profile-session/command')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Starting: Intent\n' };
    }
    if (key.endsWith('shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<hierarchy rotation="0">',
          '<node index="0" text="Example Mobile App" resource-id="dev.agentscenarioloop.example:id/asl-example-title" bounds="[32,96][720,180]" />',
          '</hierarchy>',
        ].join('\n'),
      };
    }
    if (key.endsWith('exec-out screencap -p')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'fake png bytes' };
    }
    if (key.endsWith('logcat -d -v time -t 1000')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: readFixtureLog(currentScenario, currentRunId),
      };
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
      const screenshotPath = path.join(outputDir, 'fake-argent-android.png');
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
        stdout: '{"description":"Example Mobile App asl-example-title"}\n',
      };
    }
    if (args.includes('launch-app')) {
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"launched":true,"bundleId":"dev.agentscenarioloop.example"}\n',
      };
    }
    return { args, command, exitCode: 1, stderr: `unexpected Argent command: ${key}`, stdout: '' };
  };

  await runExampleAndroidLiveProof({
    'agent-device-proof': true,
    'argent-proof': true,
    adb: 'fake-adb',
    out: outputDir,
  }, {
    agentDeviceExecutor,
    argentExecutor,
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  const result = await runExampleAndroidLiveProof({
    'agent-device-proof': true,
    'argent-proof': true,
    adb: 'fake-adb',
    'compare-latest': true,
    out: outputDir,
    'run-suffix': 'PR 123',
  }, {
    agentDeviceExecutor,
    argentExecutor,
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  assert.equal(result.profiles.length, 3);
  assert.equal(result.interactionProofs.length, 2);
  assert.equal(result.comparisons.length, 3);
  assert.equal(fs.existsSync(result.aggregateSummary.liveProofPath), true);
  assert.equal(fs.existsSync(result.aggregateSummary.summaryPath), true);
  assert.match(formatResult(result), /Android example live proof passed/u);
  assert.match(formatResult(result), /Live proof:/u);
  assert.match(formatResult(result), /Comparisons:/u);
  assert.ok(calls.some((call) => call.includes('profile-session/start')));
  assert.ok(calls.some((call) => call === `-s ${SERIAL} reverse tcp:8097 tcp:8097`));
  assert.ok(calls.some((call) => call.includes('debug_http_host')));
  assert.ok(agentDeviceCalls.some((call) => call.includes('open dev.agentscenarioloop.example')));
  assert.ok(agentDeviceCalls.some((call) => call.includes('is visible id="asl-example-title"')));
  assert.ok(agentDeviceCalls.some((call) => call.includes('screenshot')));
  assert.ok(argentCalls.some((call) => call.includes(`launch-app --udid ${SERIAL} --bundleId dev.agentscenarioloop.example`)));
  assert.ok(argentCalls.some((call) => call.includes(`describe --udid ${SERIAL} --bundleId dev.agentscenarioloop.example`)));
  assert.ok(argentCalls.some((call) => call.includes(`screenshot --udid ${SERIAL}`)));
  const firstProfileSessionStart = orderedCalls.findIndex((call) => call.includes('profile-session/start'));
  assert.ok(firstProfileSessionStart > -1, 'expected profile session start command');
  assert.ok(
    orderedCalls.findIndex((call) => call.includes('agent-device:open dev.agentscenarioloop.example')) > firstProfileSessionStart,
    'agent-device startup proof should run after profile evidence capture',
  );
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`argent:run launch-app --udid ${SERIAL} --bundleId dev.agentscenarioloop.example`)) > firstProfileSessionStart,
    'Argent startup proof should run after profile evidence capture',
  );
  assert.deepEqual(
    result.profiles.map((profile: { runId: string }) => profile.runId),
    ['android-live-startup-pr-123', 'android-live-open-close-pr-123', 'android-live-scroll-pr-123'],
  );

  for (const profile of result.profiles) {
    const health = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'health.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'manifest.json'), 'utf8'));
    const verdict = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'verdict.json'), 'utf8'));
    assert.equal(manifest.comparisonLane, 'example-android-live+agent-device+argent');
    assert.equal(health.healthStatus, 'passed');
    assert.equal(verdict.verdictStatus, 'passed');
  }

  for (const comparison of result.comparisons) {
    assert.equal(comparison.status, 'unchanged');
    assert.equal(fs.existsSync(path.join(comparison.comparisonDir, 'comparison.json')), true);
    assert.equal(fs.existsSync(path.join(comparison.comparisonDir, 'agent-summary.md')), true);
  }

  const aggregate = JSON.parse(fs.readFileSync(result.aggregateSummary.liveProofPath, 'utf8'));
  assert.equal(aggregate.platform, 'android');
  assert.equal(aggregate.runId, 'android-live-proof-pr-123');
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
        },
        notableMetrics: [],
      },
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 3,
          inconclusive: 0,
        },
        notableMetrics: [],
      },
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 3,
          inconclusive: 0,
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
    () => runExampleAndroidLiveProof({
      'agent-device-proof': true,
      adb: 'fake-adb',
      out: outputDir,
      'run-suffix': 'sidecar failure',
    }, {
      agentDeviceExecutor: failedAgentDeviceExecutor,
      delay: async () => {},
      executor,
      packageRoot: ROOT,
    }),
    /Android example live proof failed\. Inspect /u,
  );
  const failedSidecarAggregate = JSON.parse(fs.readFileSync(
    path.join(outputDir, '_live-proof', 'android-live-proof-sidecar-failure', 'live-proof.json'),
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

test('Android example live proof writes failed aggregate before skipping requested sidecars on failed profiles', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-android-live-failed-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const sidecarCalls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    if (key === 'version') {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Android Debug Bridge version 1.0.41\n' };
    }
    if (key === 'devices -l') {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: [
          'List of devices attached',
          `${SERIAL} device product:sdk_gphone model:Pixel_6 device:emu64`,
        ].join('\n'),
      };
    }
    if (key.endsWith('shell getprop ro.product.model')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Pixel 6\n' };
    }
    if (key.endsWith('shell getprop ro.build.version.release')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '15\n' };
    }
    if (key.endsWith('shell getprop ro.build.version.sdk')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '35\n' };
    }
    if (key.endsWith('shell pm path dev.agentscenarioloop.example')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: 'package:/data/app/dev.agentscenarioloop.example/base.apk\n',
      };
    }
    if (key === `-s ${SERIAL} reverse tcp:8097 tcp:8097`) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.includes('shell run-as dev.agentscenarioloop.example sh -c') && key.includes('debug_http_host')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.endsWith('shell monkey -p dev.agentscenarioloop.example -c android.intent.category.LAUNCHER 1')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Events injected: 1\n' };
    }
    if (key.endsWith('logcat -c')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.includes('profile-session/start') || key.includes('profile-session/command')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Starting: Intent\n' };
    }
    if (key.endsWith('shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<hierarchy rotation="0">',
          '<node index="0" text="Example Mobile App" resource-id="dev.agentscenarioloop.example:id/asl-example-title" bounds="[32,96][720,180]" />',
          '</hierarchy>',
        ].join('\n'),
      };
    }
    if (key.endsWith('exec-out screencap -p')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'fake png bytes' };
    }
    if (key.endsWith('logcat -d -v time -t 1000')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '--------- beginning of main\n' };
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
    () => runExampleAndroidLiveProof({
      'agent-device-proof': true,
      'argent-proof': true,
      adb: 'fake-adb',
      out: outputDir,
      serial: SERIAL,
    }, {
      agentDeviceExecutor: sidecarExecutor,
      argentExecutor,
      delay: async () => {},
      executor,
      packageRoot: ROOT,
    }),
    /Android example live proof failed\. Inspect /u,
  );

  assert.deepEqual(sidecarCalls, []);
  const aggregatePath = path.join(outputDir, '_live-proof', 'android-live-proof', 'live-proof.json');
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
