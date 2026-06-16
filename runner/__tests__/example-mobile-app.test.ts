const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const PROFILE_ANDROID = path.join(DIST_ROOT, 'runner', 'profile-android.js');
const PROFILE_IOS = path.join(DIST_ROOT, 'runner', 'profile-ios.js');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;

const EXAMPLE_RUNS = [
  {
    eventLog: 'examples/mobile-app/event-logs/app-startup.log',
    platform: 'ios',
    profileRunner: PROFILE_IOS,
    runId: 'example-startup',
    scenario: 'examples/mobile-app/scenarios/ios/app-startup.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/open-close-cycle.log',
    platform: 'ios',
    profileRunner: PROFILE_IOS,
    runId: 'example-open-close',
    scenario: 'examples/mobile-app/scenarios/ios/open-close-cycle.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/scroll-settle.log',
    platform: 'ios',
    profileRunner: PROFILE_IOS,
    runId: 'example-scroll',
    scenario: 'examples/mobile-app/scenarios/ios/scroll-settle.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/android-app-startup.log',
    platform: 'android',
    profileRunner: PROFILE_ANDROID,
    runId: 'android-example-startup',
    scenario: 'examples/mobile-app/scenarios/android/app-startup.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/android-open-close-cycle.log',
    platform: 'android',
    profileRunner: PROFILE_ANDROID,
    runId: 'android-example-open-close',
    scenario: 'examples/mobile-app/scenarios/android/open-close-cycle.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/android-scroll-settle.log',
    platform: 'android',
    profileRunner: PROFILE_ANDROID,
    runId: 'android-example-scroll',
    scenario: 'examples/mobile-app/scenarios/android/scroll-settle.json',
  },
];

/**
 * Runs a child process and returns captured output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileAsync(command: string, args: string[], options: Record<string, unknown> = {}): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: ROOT, ...options }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        const execError = error as ExecFailure;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Resolves a repository fixture path.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function fixturePath(relativePath: string): string {
  return path.join(ROOT, relativePath);
}

/**
 * Reads a JSON artifact.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('example mobile app config matches Expo app identity', () => {
  const appJson = readJson(fixturePath('examples/mobile-app/app.json'));
  const aslConfig = readJson(fixturePath('examples/mobile-app/asl.config.json'));
  const expo = appJson.expo as { android?: { package?: string }; ios?: { bundleIdentifier?: string } };
  const app = aslConfig.app as { androidPackage?: string; iosBundleId?: string };

  assert.equal(app.androidPackage, expo.android?.package);
  assert.equal(app.iosBundleId, expo.ios?.bundleIdentifier);
});

test('example mobile app scenarios produce passed artifacts from committed evidence', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-mobile-app-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });

  for (const exampleRun of EXAMPLE_RUNS) {
    const { stdout } = await execFileAsync(process.execPath, [
      exampleRun.profileRunner,
      '--config',
      fixturePath('examples/mobile-app/asl.config.json'),
      '--scenario',
      fixturePath(exampleRun.scenario),
      '--events',
      fixturePath(exampleRun.eventLog),
      '--out',
      artifactRoot,
      '--run-id',
      exampleRun.runId,
    ]);

    const runDir = stdout.trim();
    const health = readJson(path.join(runDir, 'health.json'));
    const manifest = readJson(path.join(runDir, 'manifest.json'));
    const verdict = readJson(path.join(runDir, 'verdict.json'));
    const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

    assert.equal(manifest.platform, exampleRun.platform);
    assert.equal(health.healthStatus, 'passed');
    assert.equal(verdict.verdictStatus, 'passed');
    assert.match(summary, /Scenario health passed/u);
  }
});
