const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;

const HELP_CASES = [
  {
    file: path.join(DIST_ROOT, 'runner', 'agent-device.js'),
    usage: 'Usage: asl-agent-device',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'android-adb.js'),
    usage: 'Usage: asl-android-adb',
    fragments: ['--launch-wait-ms <ms>'],
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'argent.js'),
    usage: 'Usage: asl-argent',
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
    file: path.join(DIST_ROOT, 'runner', 'live-android.js'),
    usage: 'Usage: asl-live-android',
  },
  {
    file: path.join(DIST_ROOT, 'runner', 'live-ios.js'),
    usage: 'Usage: asl-live-ios',
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
    fragments: ['--launch-wait-ms <ms>'],
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

/**
 * Writes an executable Node.js script for CLI boundary tests.
 *
 * @param {string} filePath
 * @param {string} body
 * @returns {Promise<void>}
 */
async function writeExecutableScript(filePath: string, body: string): Promise<void> {
  await fsp.writeFile(filePath, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await fsp.chmod(filePath, 0o755);
}

/**
 * Reads a JSON file from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

for (const helpCase of HELP_CASES) {
  test(`${path.basename(helpCase.file)} prints help without side effects`, async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [helpCase.file, '--help']);

    assert.match(stdout, new RegExp(helpCase.usage, 'u'));
    for (const fragment of helpCase.fragments ?? []) {
      assert.match(stdout, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }
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

test('low-level capture CLIs exit nonzero when health fails', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-cli-failed-health-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const fakeAdb = path.join(tempDir, 'fake-adb.js');
  await writeExecutableScript(fakeAdb, [
    "const key = process.argv.slice(2).join(' ');",
    "if (key === 'version') { process.stdout.write('Android Debug Bridge version 1.0.41\\n'); process.exit(0); }",
    "if (key === 'devices -l') { process.stdout.write('List of devices attached\\n'); process.exit(0); }",
    "process.stderr.write(`unexpected fake adb command: ${key}\\n`);",
    "process.exit(1);",
  ].join('\n'));
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(DIST_ROOT, 'runner', 'android-adb.js'),
      '--adb',
      fakeAdb,
      '--out',
      path.join(tempDir, 'android'),
      '--run-id',
      'android-failed-health',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      const runDir = execError.stdout.trim();
      assert.equal(runDir, path.join(tempDir, 'android'));
      assert.equal(readJson(path.join(runDir, 'health.json')).healthStatus, 'failed');
      return true;
    },
  );

  const fakeXcrun = path.join(tempDir, 'fake-xcrun.js');
  await writeExecutableScript(fakeXcrun, [
    "const key = process.argv.slice(2).join(' ');",
    "if (key === 'simctl list devices') {",
    "  process.stdout.write(['== Devices ==', '-- iOS 26.3 --', '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Shutdown)'].join('\\n'));",
    "  process.exit(0);",
    "}",
    "process.stderr.write(`unexpected fake xcrun command: ${key}\\n`);",
    "process.exit(1);",
  ].join('\n'));
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(DIST_ROOT, 'runner', 'ios-simctl.js'),
      '--xcrun',
      fakeXcrun,
      '--out',
      path.join(tempDir, 'ios'),
      '--run-id',
      'ios-failed-health',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      const runDir = execError.stdout.trim();
      assert.equal(runDir, path.join(tempDir, 'ios'));
      assert.equal(readJson(path.join(runDir, 'health.json')).healthStatus, 'failed');
      return true;
    },
  );

  const fakeAgentDevice = path.join(tempDir, 'fake-agent-device.js');
  await writeExecutableScript(fakeAgentDevice, [
    "process.stderr.write(`fake agent-device failure: ${process.argv.slice(2).join(' ')}\\n`);",
    "process.exit(1);",
  ].join('\n'));
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(DIST_ROOT, 'runner', 'agent-device.js'),
      '--agent-device',
      fakeAgentDevice,
      '--platform',
      'ios',
      '--scenario',
      path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'),
      '--out',
      path.join(tempDir, 'agent-device'),
      '--run-id',
      'agent-device-failed-health',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      const runDir = execError.stdout.trim();
      assert.equal(runDir, path.join(tempDir, 'agent-device'));
      assert.equal(readJson(path.join(runDir, 'health.json')).healthStatus, 'failed');
      return true;
    },
  );

  const fakeArgent = path.join(tempDir, 'fake-argent.js');
  await writeExecutableScript(fakeArgent, [
    "process.stderr.write(`fake Argent failure: ${process.argv.slice(2).join(' ')}\\n`);",
    "process.exit(1);",
  ].join('\n'));
  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(DIST_ROOT, 'runner', 'argent.js'),
      '--argent',
      fakeArgent,
      '--platform',
      'ios',
      '--scenario',
      path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'),
      '--app',
      'dev.agent-scenario-loop.example',
      '--device',
      'SIM-123',
      '--out',
      path.join(tempDir, 'argent'),
      '--run-id',
      'argent-failed-health',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      const runDir = execError.stdout.trim();
      assert.equal(runDir, path.join(tempDir, 'argent'));
      assert.equal(readJson(path.join(runDir, 'health.json')).healthStatus, 'failed');
      return true;
    },
  );
});
