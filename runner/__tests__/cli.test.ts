const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;

const HELP_CASES = [
  {
    file: path.join(DIST_ROOT, 'runner', 'agent-device.js'),
    usage: 'Usage: asl-agent-device',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'android-adb.js'),
    usage: 'Usage: asl-android-adb',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'check-plan.js'),
    usage: 'Usage: agent-scenario-loop',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'compare.js'),
    usage: 'Usage: asl-compare',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'compare-latest.js'),
    usage: 'Usage: asl-compare-latest',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'demo-loop.js'),
    usage: 'Usage: asl-demo-loop',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'example-android-live.js'),
    usage: 'Usage: asl-example-android-live',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'example-ios-live.js'),
    usage: 'Usage: asl-example-ios-live',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'init-project.js'),
    usage: 'Usage: asl-init',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'ios-simctl.js'),
    usage: 'Usage: asl-ios-simctl',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'live-proof.js'),
    usage: 'Usage: asl-live-proof',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'profile-ios.js'),
    usage: 'Usage: asl-profile-ios',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'profile-android.js'),
    usage: 'Usage: asl-profile-android',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'validate-project.js'),
    usage: 'Usage: asl-validate-project',
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

for (const helpCase of HELP_CASES) {
  test(`${path.basename(helpCase.file)} prints help without side effects`, async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [helpCase.file, '--help']);

    assert.match(stdout, new RegExp(helpCase.usage, 'u'));
    assert.equal(stderr, '');
  });
}

test('missing required check-plan arguments still fail with stderr usage', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [path.join(DIST_ROOT, 'runner', 'check-plan.js')]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.equal(execError.stdout, '');
      assert.match(execError.stderr, /Usage: agent-scenario-loop/u);
      return true;
    },
  );
});
