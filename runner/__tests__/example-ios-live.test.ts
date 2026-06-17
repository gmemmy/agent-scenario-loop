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
  runExampleIosLiveProof,
} = require('../example-ios-live');
const {
  resolveAsyncStorageDirectory,
} = require('../ios-simctl');

type CommandResult = import('../ios-simctl').CommandResult;
type AgentDeviceCommandResult = import('../agent-device').CommandResult;
type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');
const BUNDLE_ID = 'dev.agent-scenario-loop.example';
const DEVICE_ID = 'A692ED28-893E-453F-8866-C69331AE757F';

test('normalizes iOS example live run suffixes', () => {
  assert.equal(normalizeRunSuffix(' PR 123 / before '), 'pr-123-before');
  assert.equal(normalizeRunSuffix('---'), null);
  assert.equal(buildLiveRunId('ios-live-startup', 'pr-123'), 'ios-live-startup-pr-123');
  assert.equal(buildLiveRunId('ios-live-startup', null), 'ios-live-startup');
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
      comparisons: [{ label: 'startup', status: 'unchanged' }],
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
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const session = JSON.parse(manifest['agent-scenario-loop.profile-session.1']);
  manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify(
    readFixtureEvents(session.scenario, session.runId),
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
}

test('runs the packaged iOS example live proof with a fake simctl executor', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-ios-live-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-ios-data-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });

  const calls: string[] = [];
  const agentDeviceCalls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);

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
      writeCurrentSessionEvents(dataContainer);
      return { command, args, exitCode: 0, stderr: '', stdout: `${BUNDLE_ID}: 1234\n` };
    }
    if (key === `simctl spawn ${DEVICE_ID} log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"`) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Timestamp Ty Process[PID:TID]\n' };
    }

    return { command, args, exitCode: 1, stderr: `unexpected command: ${key}`, stdout: '' };
  };
  const agentDeviceExecutor = async (command: string, args: string[]): Promise<AgentDeviceCommandResult> => {
    agentDeviceCalls.push(args.join(' '));
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

  await runExampleIosLiveProof({
    'agent-device-proof': true,
    device: DEVICE_ID,
    out: outputDir,
  }, {
    agentDeviceExecutor,
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  const result = await runExampleIosLiveProof({
    'agent-device-proof': true,
    'compare-latest': true,
    device: DEVICE_ID,
    out: outputDir,
    'run-suffix': 'PR 123',
  }, {
    agentDeviceExecutor,
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  assert.equal(result.profiles.length, 3);
  assert.equal(result.interactionProofs.length, 1);
  assert.equal(result.comparisons.length, 3);
  assert.equal(fs.existsSync(result.aggregateSummary.liveProofPath), true);
  assert.equal(fs.existsSync(result.aggregateSummary.summaryPath), true);
  assert.match(formatResult(result), /iOS example live proof passed/u);
  assert.match(formatResult(result), /Live proof:/u);
  assert.match(formatResult(result), /Comparisons:/u);
  assert.ok(calls.some((call) => call === `simctl launch ${DEVICE_ID} ${BUNDLE_ID}`));
  assert.ok(agentDeviceCalls.some((call) => call.includes(`open ${BUNDLE_ID}`)));
  assert.ok(agentDeviceCalls.some((call) => call.includes('is visible id="asl-example-title"')));
  assert.ok(agentDeviceCalls.some((call) => call.includes('screenshot')));
  assert.deepEqual(
    result.profiles.map((profile: { runId: string }) => profile.runId),
    ['ios-live-startup-pr-123', 'ios-live-open-close-pr-123', 'ios-live-scroll-pr-123'],
  );

  for (const profile of result.profiles) {
    const health = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'health.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'manifest.json'), 'utf8'));
    const verdict = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'verdict.json'), 'utf8'));
    assert.equal(manifest.comparisonLane, 'example-ios-live+agent-device');
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
    aggregate.interactionProofs.map((proof: { healthStatus: string; label: string; runnerId: string; verdictStatus: string }) => ({
      healthStatus: proof.healthStatus,
      label: proof.label,
      runnerId: proof.runnerId,
      verdictStatus: proof.verdictStatus,
    })),
    [
      {
        healthStatus: 'passed',
        label: 'startup-ui',
        runnerId: 'agent-device',
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
          unchanged: 8,
          inconclusive: 0,
        },
        notableMetrics: [],
      },
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 8,
          inconclusive: 0,
        },
        notableMetrics: [],
      },
      {
        counts: {
          better: 0,
          worse: 0,
          unchanged: 8,
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
});
