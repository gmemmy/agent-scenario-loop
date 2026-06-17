const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runAndroidLiveProof,
} = require('../live-android');

type CommandResult = import('../android-adb').CommandResult;
type AgentDeviceCommandResult = import('../agent-device').CommandResult;
type ArgentCommandResult = import('../argent').CommandResult;
type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');
const ANDROID_PACKAGE = 'dev.agentscenarioloop.example';

/**
 * Reads the Android startup fixture log with the requested run id.
 *
 * @param {string} runId
 * @returns {string}
 */
function readStartupLog(runId: string): string {
  return fs
    .readFileSync(path.join(ROOT, 'examples', 'mobile-app', 'event-logs', 'android-app-startup.log'), 'utf8')
    .replace(/android-example-startup/gu, runId);
}

test('generic Android live proof captures profile evidence before sidecar proofs', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-android-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  let currentRunId = 'app-startup-android-live';
  const orderedCalls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
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
        stdout: 'List of devices attached\nemulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64\n',
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
    if (key.endsWith(`shell pm path ${ANDROID_PACKAGE}`)) {
      return { command, args, exitCode: 0, stderr: '', stdout: `package:/data/app/${ANDROID_PACKAGE}/base.apk\n` };
    }
    if (key.endsWith(`shell monkey -p ${ANDROID_PACKAGE} -c android.intent.category.LAUNCHER 1`)) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'Events injected: 1\n' };
    }
    if (key.endsWith('logcat -c')) {
      return { command, args, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key.includes('profile-session/start')) {
      currentRunId = /runId=([^&']+)/u.exec(key)?.[1] ?? currentRunId;
      return { command, args, exitCode: 0, stderr: '', stdout: 'Starting: Intent\n' };
    }
    if (key.endsWith('shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status')) {
      return {
        command,
        args,
        exitCode: 0,
        stderr: '',
        stdout: '<hierarchy><node text="Example Mobile App" resource-id="asl-example-title" bounds="[32,96][720,180]" /></hierarchy>\n',
      };
    }
    if (key.endsWith('exec-out screencap -p')) {
      return { command, args, exitCode: 0, stderr: '', stdout: 'fake png bytes' };
    }
    if (key.endsWith('logcat -d -v time -t 1000')) {
      return { command, args, exitCode: 0, stderr: '', stdout: readStartupLog(currentRunId) };
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
      const screenshotPath = path.join(outputDir, 'argent-android.png');
      await fsp.writeFile(screenshotPath, 'fake screenshot', 'utf8');
      return { args, command, exitCode: 0, stderr: '', stdout: `Saved screenshot: ${screenshotPath}\n` };
    }
    if (args.includes('describe')) {
      return { args, command, exitCode: 0, stderr: '', stdout: '{"description":"Example Mobile App"}\n' };
    }
    if (args.includes('launch-app')) {
      return { args, command, exitCode: 0, stderr: '', stdout: `{"launched":true,"bundleId":"${ANDROID_PACKAGE}"}\n` };
    }
    return { args, command, exitCode: 1, stderr: `unexpected Argent command: ${key}`, stdout: '' };
  };

  const result = await runAndroidLiveProof({
    'agent-device-proof': true,
    'argent-proof': true,
    config: path.join(ROOT, 'examples', 'mobile-app', 'asl.config.json'),
    out: outputDir,
    package: ANDROID_PACKAGE,
    scenario: path.join(ROOT, 'examples', 'mobile-app', 'scenarios', 'mobile', 'app-startup.json'),
    serial: 'emulator-5554',
  }, {
    agentDeviceExecutor,
    argentExecutor,
    delay: async () => {},
    executor,
  });

  const liveProof = JSON.parse(fs.readFileSync(result.aggregateSummary.liveProofPath, 'utf8'));
  assert.equal(liveProof.status, 'passed');
  assert.deepEqual(
    liveProof.interactionProofs.map((proof: { runnerId: string }) => proof.runnerId),
    ['agent-device', 'argent'],
  );

  const profileCapture = orderedCalls.findIndex((call) => call.endsWith('logcat -d -v time -t 1000'));
  assert.ok(profileCapture > -1, 'expected Android profile evidence capture command');
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`agent-device:open ${ANDROID_PACKAGE}`)) > profileCapture,
    'agent-device proof should run after Android profile evidence capture',
  );
  assert.ok(
    orderedCalls.findIndex((call) => call.includes(`argent:run launch-app --udid emulator-5554 --bundleId ${ANDROID_PACKAGE}`)) > profileCapture,
    'Argent proof should run after Android profile evidence capture',
  );
});
