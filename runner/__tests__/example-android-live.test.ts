const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLiveRunId,
  formatResult,
  normalizeRunSuffix,
  runExampleAndroidLiveProof,
} = require('../example-android-live');

type CommandResult = import('../android-adb').CommandResult;
type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');

test('normalizes Android example live run suffixes', () => {
  assert.equal(normalizeRunSuffix(' PR 123 / before '), 'pr-123-before');
  assert.equal(normalizeRunSuffix('---'), null);
  assert.equal(buildLiveRunId('android-live-startup', 'pr-123'), 'android-live-startup-pr-123');
  assert.equal(buildLiveRunId('android-live-startup', null), 'android-live-startup');
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
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  let currentScenario = 'app-startup';
  let currentRunId = 'android-live-startup';
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);

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
          'emulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64',
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
    if (key === '-s emulator-5554 reverse tcp:8097 tcp:8097') {
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

  await runExampleAndroidLiveProof({
    adb: 'fake-adb',
    out: outputDir,
  }, {
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  const result = await runExampleAndroidLiveProof({
    adb: 'fake-adb',
    'compare-latest': true,
    out: outputDir,
    'run-suffix': 'PR 123',
  }, {
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  assert.equal(result.profiles.length, 3);
  assert.equal(result.comparisons.length, 3);
  assert.equal(fs.existsSync(result.aggregateSummary.liveProofPath), true);
  assert.equal(fs.existsSync(result.aggregateSummary.summaryPath), true);
  assert.match(formatResult(result), /Android example live proof passed/u);
  assert.match(formatResult(result), /Live proof:/u);
  assert.match(formatResult(result), /Comparisons:/u);
  assert.ok(calls.some((call) => call.includes('profile-session/start')));
  assert.ok(calls.some((call) => call === '-s emulator-5554 reverse tcp:8097 tcp:8097'));
  assert.ok(calls.some((call) => call.includes('debug_http_host')));
  assert.deepEqual(
    result.profiles.map((profile: { runId: string }) => profile.runId),
    ['android-live-startup-pr-123', 'android-live-open-close-pr-123', 'android-live-scroll-pr-123'],
  );

  for (const profile of result.profiles) {
    const health = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'health.json'), 'utf8'));
    const verdict = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'verdict.json'), 'utf8'));
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
  assert.equal(aggregate.comparisonStatus, 'unchanged');
  assert.equal(aggregate.nextAction.code, 'inspect_summary');
  assert.equal(aggregate.profiles.length, 3);
  assert.equal(aggregate.comparisons.length, 3);
});
