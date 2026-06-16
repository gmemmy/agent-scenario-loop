const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  formatResult,
  runExampleIosLiveProof,
} = require('../example-ios-live');
const {
  resolveAsyncStorageDirectory,
} = require('../ios-simctl');

type CommandResult = import('../ios-simctl').CommandResult;
type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');
const BUNDLE_ID = 'dev.agent-scenario-loop.example';
const DEVICE_ID = 'A692ED28-893E-453F-8866-C69331AE757F';

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

  const result = await runExampleIosLiveProof({
    device: DEVICE_ID,
    out: outputDir,
  }, {
    delay: async () => {},
    executor,
    packageRoot: ROOT,
  });

  assert.equal(result.profiles.length, 3);
  assert.match(formatResult(result), /iOS example live proof passed/u);
  assert.ok(calls.some((call) => call === `simctl launch ${DEVICE_ID} ${BUNDLE_ID}`));

  for (const profile of result.profiles) {
    const health = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'health.json'), 'utf8'));
    const verdict = JSON.parse(fs.readFileSync(path.join(profile.runDir, 'verdict.json'), 'utf8'));
    assert.equal(health.healthStatus, 'passed');
    assert.equal(verdict.verdictStatus, 'passed');
  }
});
