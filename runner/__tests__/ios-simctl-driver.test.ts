const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
type TestContext = import('node:test').TestContext;
type NodeEventEmitter = import('node:events').EventEmitter;

const {
  PROFILE_LOG_PREDICATE,
  createIosSimctlDriver,
  formatIosSimctlRawOutput,
} = require('../ios-simctl-driver');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Creates a fake xcrun executor from argument-keyed responses.
 *
 * @param {Record<string, Partial<CommandResult>>} responses
 * @returns {(command: string, args: string[]) => Promise<CommandResult>}
 */
function createExecutor(responses: Record<string, Partial<CommandResult>>) {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
}

test('iOS simctl driver keeps lifecycle helpers separate from portable evidence actions', async () => {
  const executor = createExecutor({
    'simctl launch BOOTED dev.example.app': {
      stdout: 'dev.example.app: 1234\n',
    },
    'simctl openurl BOOTED asl-example://profile-session/start?runId=one': {
      stdout: '',
    },
    'simctl terminate BOOTED dev.example.app': {
      stderr: 'No such process\n',
      exitCode: 3,
    },
  });
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor,
    xcrunPath: 'fake-xcrun',
  });

  const launch = await driver.launchBundle('dev.example.app');
  const deepLink = await driver.openDeepLink({
    rawFileName: 'ios-deep-link-1.txt',
    url: 'asl-example://profile-session/start?runId=one',
  });
  const terminate = await driver.terminateBundle('dev.example.app');

  assert.equal(launch.action, 'launchBundle');
  assert.equal(launch.rawFileName, 'ios-launch.txt');
  assert.equal(deepLink.action, 'openDeepLink');
  assert.equal(deepLink.rawFileName, 'ios-deep-link-1.txt');
  assert.equal(terminate.action, 'terminateBundle');
  assert.equal(terminate.rawFileName, 'ios-terminate.txt');
});

test('iOS simctl driver captures logs and screenshots through portable evidence actions', async () => {
  const screenshotPath = '/tmp/asl-ios-screenshot.png';
  const executor = createExecutor({
    [`simctl spawn BOOTED log show --style compact --last 30s --predicate ${PROFILE_LOG_PREDICATE}`]: {
      stdout: '[profile-event] {}\n',
    },
    [`simctl io BOOTED screenshot ${screenshotPath}`]: {
      stdout: 'Wrote screenshot\n',
    },
  });
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor,
    xcrunPath: 'fake-xcrun',
  });

  const logs = await driver.readLogs({ last: '30s' });
  const screenshot = await driver.screenshot({ outputPath: screenshotPath });

  assert.equal(logs.action, 'readLogs');
  assert.equal(logs.rawFileName, 'ios-simctl-log.txt');
  assert.match(formatIosSimctlRawOutput(logs), /\[profile-event\]/u);
  assert.equal(screenshot.action, 'screenshot');
  assert.equal(screenshot.rawFileName, 'ios-screenshot.txt');
  assert.deepEqual(screenshot.args, ['simctl', 'io', 'BOOTED', 'screenshot', screenshotPath]);
});

test('iOS simctl driver preserves screenshot options in command args', async () => {
  const screenshotPath = '/tmp/asl-ios-screenshot.jpeg';
  const executor = createExecutor({
    [`simctl io BOOTED screenshot --type=jpeg --display=Internal-1 --mask=black ${screenshotPath}`]: {
      stdout: 'Wrote screenshot\n',
    },
  });
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor,
    xcrunPath: 'fake-xcrun',
  });

  const screenshot = await driver.screenshot({
    display: 'Internal-1',
    imageType: 'jpeg',
    mask: 'black',
    outputPath: screenshotPath,
  });

  assert.equal(screenshot.action, 'screenshot');
  assert.deepEqual(screenshot.args, [
    'simctl',
    'io',
    'BOOTED',
    'screenshot',
    '--type=jpeg',
    '--display=Internal-1',
    '--mask=black',
    screenshotPath,
  ]);
});

test('iOS simctl driver finalizes valid video and reports truthful capture state', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'captures', 'video.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: NodeEventEmitter;
    stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = () => {
    void fsp.writeFile(outputPath, Buffer.from('000000106674797069736f6d00000000', 'hex'))
      .then(() => {
        process.emit('exit', 0, 'SIGINT');
        process.stdout.emit('data', 'trailing recorder output');
        process.emit('close', 0, 'SIGINT');
      });
    return true;
  };
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED', executor: createExecutor({}),
    recorderFactory: () => process, xcrunPath: 'fake-xcrun',
  });
  const recording = await driver.startRecording({ outputPath, startTimeoutMs: 1 });
  assert.equal(recording.state, 'active');
  const result = await recording.stop();
  assert.equal(result.state, 'finalized');
  assert.equal(result.capturePath, outputPath);
  assert.equal(result.signal, 'SIGINT');
  assert.equal(result.validation.reason, 'valid');
  assert.match(result.stdout, /trailing recorder output/u);
  assert.deepEqual(result.args, ['simctl', 'io', 'BOOTED', 'recordVideo', outputPath]);
});

test('iOS simctl driver bounds recorder stdout and stderr independently', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-streams-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'video.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: NodeEventEmitter;
    stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = () => {
    void fsp.writeFile(outputPath, Buffer.from('000000106674797069736f6d00000000', 'hex'))
      .then(() => process.emit('close', 0, 'SIGINT'));
    return true;
  };
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED', executor: createExecutor({}), recorderFactory: () => process, xcrunPath: 'fake-xcrun',
  });
  const recording = await driver.startRecording({ outputPath, startTimeoutMs: 1 });
  process.stdout.emit('data', 'o'.repeat(300_000));
  process.stderr.emit('data', 'e'.repeat(262_144));
  process.stderr.emit('data', 'dropped');
  const result = await recording.stop();
  assert.match(result.stdout, /output truncated at 262144 bytes/u);
  assert.match(result.stderr, /output truncated at 262144 bytes/u);
  assert.ok(Buffer.byteLength(result.stdout) < 264_000);
  assert.ok(Buffer.byteLength(result.stderr) < 264_000);
});

test('iOS simctl driver cleans up a recorder that misses bounded finalization', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-timeout-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const signals: NodeJS.Signals[] = [];
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: NodeEventEmitter;
    stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = (signal: NodeJS.Signals) => { signals.push(signal); if (signal === 'SIGKILL') setImmediate(() => process.emit('close', null, signal)); return true; };
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED', executor: createExecutor({}), recorderFactory: () => process, xcrunPath: 'fake-xcrun',
  });
  const recording = await driver.startRecording({
    finalizeTimeoutMs: 1,
    outputPath: path.join(tempRoot, 'video.mp4'),
    startTimeoutMs: 1,
    stopTimeoutMs: 1,
  });
  const result = await recording.stop('cancelled');
  assert.equal(result.state, 'timed_out');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.validation.reason, 'missing');
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.equal('capturePath' in result, false);
});

test('iOS simctl driver marks recorder failed when process exits before start timeout', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-start-failed-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'video.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: NodeEventEmitter;
    stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = () => true;
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor: createExecutor({}),
    recorderFactory: () => {
      setImmediate(() => process.emit('close', 1, null));
      return process;
    },
    xcrunPath: 'fake-xcrun',
  });
  const recording = await driver.startRecording({ outputPath, startTimeoutMs: 100 });
  assert.equal(recording.state, 'failed');
  const result = await recording.stop();
  assert.equal(result.state, 'failed');
  assert.equal(result.validation.reason, 'missing');
  assert.equal(result.cleanup.signals.length, 0);
});

test('iOS simctl driver reports orphaned cleanup when recorder never exits', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-orphaned-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'video.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: NodeEventEmitter;
    stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter();
  process.stdout = new EventEmitter();
  process.kill = () => true;
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor: createExecutor({}),
    recorderFactory: () => process,
    xcrunPath: 'fake-xcrun',
  });
  const recording = await driver.startRecording({
    finalizeTimeoutMs: 1,
    outputPath,
    startTimeoutMs: 1,
    stopTimeoutMs: 1,
  });
  const result = await recording.stop('cancelled');
  assert.equal(result.state, 'timed_out');
  assert.equal(result.cleanup.orphaned, true);
  assert.deepEqual(result.cleanup.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /did not exit after SIGKILL/u);
});

test('iOS simctl driver rejects start failures and missing, zero, or invalid output', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-invalid-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const expectedValidationReason: Record<string, string> = {
    invalid: 'missing-ftyp',
    missing: 'missing',
    'start-failure': 'missing',
    zero: 'zero-bytes',
  };
  for (const fixture of ['missing', 'zero', 'invalid', 'start-failure']) {
    const outputPath = path.join(tempRoot, `${fixture}.mp4`);
    const process = new EventEmitter() as NodeEventEmitter & {
      kill: (signal: NodeJS.Signals) => boolean; stderr: NodeEventEmitter; stdout: NodeEventEmitter;
    };
    process.stderr = new EventEmitter(); process.stdout = new EventEmitter();
    process.kill = () => {
      const write = fixture === 'zero' ? fsp.writeFile(outputPath, '')
        : fixture === 'invalid' ? fsp.writeFile(outputPath, 'invalid-video-content-without-ftyp') : Promise.resolve();
      void write.then(() => process.emit('close', fixture === 'start-failure' ? 1 : 0, 'SIGINT'));
      return true;
    };
    const driver = createIosSimctlDriver({
      deviceUdid: 'BOOTED', executor: createExecutor({}),
      recorderFactory: fixture === 'start-failure' ? () => { throw new Error('spawn failed'); } : () => process,
      xcrunPath: 'fake-xcrun',
    });
    const recording = await driver.startRecording({ outputPath, startTimeoutMs: 1 });
    const result = await recording.stop();
    assert.equal(result.state, 'failed', fixture);
    assert.equal('capturePath' in result, false, fixture);
    assert.equal(result.validation.reason, expectedValidationReason[fixture], fixture);
  }
});

test('iOS simctl driver does not trust stale output when recorder fails to spawn', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-stale-output-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'stale.mp4');
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, Buffer.from('000000106674797069736f6d00000000', 'hex'));
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED',
    executor: createExecutor({}),
    recorderFactory: () => {
      throw new Error('spawn failed');
    },
    xcrunPath: 'fake-xcrun',
  });
  const result = await (await driver.startRecording({ outputPath, startTimeoutMs: 1 })).stop();
  assert.equal(result.state, 'failed');
  assert.equal(result.validation.reason, 'missing');
  assert.equal('capturePath' in result, false);
});

test('iOS simctl driver rejects brands outside a malformed ftyp box', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-malformed-ftyp-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'malformed.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean; stderr: NodeEventEmitter; stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter(); process.stdout = new EventEmitter();
  process.kill = () => {
    const malformed = Buffer.concat([
      Buffer.from('0000000c6674797062616421', 'hex'),
      Buffer.from('isom'),
    ]);
    void fsp.writeFile(outputPath, malformed).then(() => process.emit('close', 0, 'SIGINT'));
    return true;
  };
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED', executor: createExecutor({}), recorderFactory: () => process, xcrunPath: 'fake-xcrun',
  });
  const result = await (await driver.startRecording({ outputPath, startTimeoutMs: 1 })).stop();
  assert.equal(result.validation.valid, false);
  assert.equal(result.validation.reason, 'truncated-header');
  assert.equal('capturePath' in result, false);
});

test('iOS simctl driver validates compatible brands beyond the initial header', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-large-ftyp-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'large-ftyp.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean; stderr: NodeEventEmitter; stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter(); process.stdout = new EventEmitter();
  process.kill = () => {
    const box = Buffer.alloc(132, 0x78);
    box.writeUInt32BE(box.length, 0); box.write('ftyp', 4); box.write('bad!', 8); box.writeUInt32BE(0, 12);
    box.write('isom', 128);
    void fsp.writeFile(outputPath, box).then(() => process.emit('close', 0, 'SIGINT'));
    return true;
  };
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED', executor: createExecutor({}), recorderFactory: () => process, xcrunPath: 'fake-xcrun',
  });
  const result = await (await driver.startRecording({ outputPath, startTimeoutMs: 1 })).stop();
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.reason, 'valid');
  assert.equal(result.capturePath, outputPath);
});

test('iOS simctl driver preserves valid partial evidence on cancellation', async (t: TestContext) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-record-partial-'));
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const outputPath = path.join(tempRoot, 'partial.mp4');
  const process = new EventEmitter() as NodeEventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean; stderr: NodeEventEmitter; stdout: NodeEventEmitter;
  };
  process.stderr = new EventEmitter(); process.stdout = new EventEmitter();
  process.kill = () => {
    void fsp.writeFile(outputPath, Buffer.from('000000106674797069736f6d00000000', 'hex'))
      .then(() => process.emit('close', 0, 'SIGINT'));
    return true;
  };
  const driver = createIosSimctlDriver({
    deviceUdid: 'BOOTED', executor: createExecutor({}), recorderFactory: () => process, xcrunPath: 'fake-xcrun',
  });
  const result = await (await driver.startRecording({ outputPath, startTimeoutMs: 1 })).stop('cancelled');
  assert.equal(result.state, 'cancelled');
  assert.equal(result.capturePath, outputPath);
  assert.equal(result.validation.reason, 'valid');
  assert.notEqual(result.exitCode, 0);
});
