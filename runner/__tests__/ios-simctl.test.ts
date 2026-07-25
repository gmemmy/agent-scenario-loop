const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  asyncStorageFileNameForKey,
  deriveIosSimctlCaptureWatchdogBudget,
  execFileCommandWithTimeout,
  formatStoredProfileEventLog,
  parseArgs,
  parseSimctlDevices,
  readAsyncStorageValueSync,
  resolveAsyncStorageDirectory,
  runIosSimctlCapture,
  seedProfileSessionStorage,
  selectSimulator,
} = require('../ios-simctl');
const {
  assertAdapterArtifactConformance,
  assertFailedHealthHasActionableMetadata,
  assertMetadataCapturePathsExist,
  assertReportedCaptureArtifactsExist,
} = require('./adapter-conformance');

type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};
type TestContext = import('node:test').TestContext;

/**
 * Creates a promise that can be resolved by the test.
 *
 * @returns {{promise: Promise<CommandResult>, resolve: (value: CommandResult) => void}}
 */
function createDeferredCommandResult() {
  let resolve: (value: CommandResult) => void = () => {};
  const promise = new Promise<CommandResult>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

/**
 * Waits until a condition is true or fails the test.
 *
 * @param {() => boolean} predicate
 * @returns {Promise<void>}
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for condition.');
}

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

const IOS_TEST_SIMULATOR_UDID = 'A692ED28-893E-453F-8866-C69331AE757F';
const IOS_PROFILE_LOG_PREDICATE = 'eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"';

function createBootedSimctlExecutor(extraResponses: Record<string, Partial<CommandResult>> = {}) {
  return createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        `    iPhone 17 Pro Max (${IOS_TEST_SIMULATOR_UDID}) (Booted)`,
      ].join('\n'),
    },
    [`simctl spawn ${IOS_TEST_SIMULATOR_UDID} launchctl getenv DYLD_INSERT_LIBRARIES`]: {
      stdout: '',
    },
    [`simctl spawn ${IOS_TEST_SIMULATOR_UDID} launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET`]: {
      stdout: '',
    },
    [`simctl spawn ${IOS_TEST_SIMULATOR_UDID} log show --style compact --last 2m --predicate ${IOS_PROFILE_LOG_PREDICATE}`]: {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
    ...extraResponses,
  });
}

async function captureMissingProfileSessionStartForApplicationState({
  applicationState,
  runId,
  t,
}: {
  applicationState: string | null;
  runId: string;
  t: TestContext;
}) {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), `asl-ios-simctl-${runId}-`));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), `asl-ios-simctl-${runId}-data-`));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const appInfo = applicationState
    ? { ApplicationState: applicationState, Bundle: 'dev.agent-scenario-loop.example' }
    : { Bundle: 'dev.agent-scenario-loop.example' };
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
      stdout: '',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
      stdout: '',
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data': {
      stdout: `${dataContainer}\n`,
    },
    'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '',
    },
    'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097': {
      stdout: '',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: `${JSON.stringify(appInfo)}\n`,
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    deepLinks: [
      {
        label: 'ios-dev-client-url',
        url: 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
      },
    ],
    delay: async () => {},
    executor,
    outputDir,
    profileSessionStorage: {
      commands: [{ command: 'open-drawer', sequence: 1 }],
      runId,
      scenario: 'account-drawer',
    },
    profileSessionStartWaitMs: 5,
    runId,
    terminateBeforeLaunch: true,
  });
  const readiness = JSON.parse(
    fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-readiness.json'), 'utf8'),
  );
  const startWaitCheck = (result.health.checks as Array<{ code: string; metadata?: Record<string, unknown> }>).find(
    (check) => check.code === 'ios_profile_session_start_wait_exhausted',
  );

  return { readiness, startWaitCheck };
}

async function captureProfileSessionCompletionFixture({
  commands,
  entries,
  record = false,
  runId,
  t,
  waitMs = 1000,
}: {
  commands?: Array<{
    command: string;
    commandId?: string;
    id?: string;
    queueId?: string;
    sequence?: number;
    timestamp?: number;
  }>;
  entries: Record<string, unknown>[];
  record?: boolean;
  runId: string;
  t: TestContext;
  waitMs?: number;
}) {
  const bundleId = 'dev.agent-scenario-loop.example';
  const scenario = 'profile-session-completion';
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), `asl-ios-simctl-${runId}-`));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), `asl-ios-simctl-${runId}-data-`));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const executor = createBootedSimctlExecutor({
    [`simctl get_app_container ${IOS_TEST_SIMULATOR_UDID} ${bundleId} app`]: {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    [`simctl get_app_container ${IOS_TEST_SIMULATOR_UDID} ${bundleId} data`]: {
      stdout: `${dataContainer}\n`,
    },
  });
  const waits: number[] = [];
  const expectedCommands = commands ?? [
    { command: 'first', commandId: 'first', id: 'completion-command-1', queueId: 'completion-queue', sequence: 1 },
    { command: 'second', commandId: 'second', id: 'completion-command-2', queueId: 'completion-queue', sequence: 2 },
    { command: 'third', commandId: 'third', id: 'completion-command-3', queueId: 'completion-queue', sequence: 3 },
  ];
  const delay = async (ms: number) => {
    waits.push(ms);
    const storageDir = resolveAsyncStorageDirectory({ bundleId, dataContainer });
    const manifestPath = path.join(storageDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const correlatedEntries = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || entry.kind !== 'command' || !Number.isInteger(entry.sequence)) {
        return entry;
      }
      const expectedCommand = typeof entry.id === 'string'
        ? expectedCommands.find((command) => command.id === entry.id)
        : expectedCommands.filter((command) => (
            command.sequence === entry.sequence &&
            (entry.queueId === undefined || command.queueId === entry.queueId)
          )).find((_, _index, candidates) => candidates.length === 1);
      return expectedCommand ? { ...expectedCommand, ...entry } : entry;
    });
    manifest['agent-scenario-loop.profile-session-entries.1'] = JSON.stringify(correlatedEntries);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  };
  const recorder = new EventEmitter() as import('node:events').EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: import('node:events').EventEmitter;
    stdout: import('node:events').EventEmitter;
  };
  recorder.stderr = new EventEmitter();
  recorder.stdout = new EventEmitter();
  recorder.kill = () => {
    const videoPath = path.join(outputDir, 'captures', 'ios-recording.mp4');
    void fsp.writeFile(videoPath, Buffer.from('000000106674797069736f6d00000000', 'hex'))
      .then(() => recorder.emit('close', 0, 'SIGINT'));
    return true;
  };

  const result = await runIosSimctlCapture({
    bundleId,
    collectProfileStorage: true,
    delay,
    executor,
    outputDir,
    profileSessionStorage: {
      commands: expectedCommands,
      runId,
      scenario,
    },
    profileSessionStartWaitMs: 100,
    record,
    ...(record ? { recorderFactory: () => recorder } : {}),
    runId,
    waitMs,
  });

  return { outputDir, result, waits };
}

test('parses and selects booted iOS simulators', () => {
  const simulators = parseSimctlDevices([
    '== Devices ==',
    '-- iOS 26.3 --',
    '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
    '    iPhone 17e (209480D9-7F23-4C6D-911E-52B228783B69) (Shutdown)',
    '',
  ].join('\n'));

  assert.deepEqual(simulators[0], {
    name: 'iPhone 17 Pro Max',
    state: 'Booted',
    udid: 'A692ED28-893E-453F-8866-C69331AE757F',
  });
  assert.equal(selectSimulator(simulators, null)?.udid, 'A692ED28-893E-453F-8866-C69331AE757F');
  assert.equal(selectSimulator(simulators, '209480D9-7F23-4C6D-911E-52B228783B69')?.state, 'Shutdown');
});

test('ignores package-manager argument separator', () => {
  assert.deepEqual(parseArgs(['--', '--xcrun', 'fake-xcrun', '--run-id', 'run-1']), {
    xcrun: 'fake-xcrun',
    'run-id': 'run-1',
  });
});

test('ends iOS capture early and finalizes video after decisive stop-on-failure evidence', async (t: TestContext) => {
  const runId = 'ios-decisive-stop';
  const scenario = 'profile-session-completion';
  const { outputDir, result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'completed' },
      {
        command: 'second',
        commandId: 'second',
        continuationReason: 'milestone-timeout-stop',
        kind: 'command',
        queueId: 'completion-queue',
        reason: 'wait-for-milestone-timeout',
        runId,
        scenario,
        sequence: 2,
        status: 'skipped',
        stopOnFailure: true,
      },
      {
        continuationReason: 'milestone-timeout-stop',
        kind: 'command',
        reason: 'prior-command-failure',
        runId,
        scenario,
        sequence: 3,
        status: 'skipped',
      },
    ],
    record: true,
    runId,
    t,
  });

  assert.equal(waits.length, 1);
  assert.ok(waits[0] !== undefined && waits[0] > 0 && waits[0] <= 100);
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.verdict.verdictStatus, 'inconclusive');
  assert.equal(result.captures.video, 'captures/ios-recording.mp4');
  assert.equal((result.metadata.video as Record<string, unknown>).state, 'finalized');
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completionKind, 'stop-on-failure');
  assert.equal(completionWait.observedTerminalCommands, 3);
  assert.equal(completionWait.rawPath, 'raw/ios-profile-session-completion-wait.json');
  const commandFailure = (result.health.checks as Array<Record<string, unknown>>).find(
    (check) => check.code === 'profile_command_gate_timeout',
  );
  assert.equal(commandFailure?.status, 'failed');
  assert.deepEqual(commandFailure?.metadata, {
    command: 'second',
    commandId: 'second',
    commandStatus: 'skipped',
    completionKind: 'stop-on-failure',
    continuationReason: 'milestone-timeout-stop',
    expectedCommandCount: 3,
    observedTerminalCommands: 3,
    queueId: 'completion-queue',
    rawPath: 'raw/ios-profile-session-completion-wait.json',
    reason: 'wait-for-milestone-timeout',
    sequence: 2,
    stopOnFailure: true,
  });
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'ios-profile-session-completion-wait.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'raw', 'ios-profile-session-entries.json')));
  assert.ok(fs.existsSync(path.join(outputDir, 'captures', 'ios-recording.mp4')));
});

test('ends iOS capture early after a canonical dependency timeout stop', async (t: TestContext) => {
  const runId = 'ios-dependency-stop';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'completed' },
      {
        command: 'second',
        commandId: 'second',
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        missingDependencies: ['second_ready'],
        queueId: 'completion-queue',
        reason: 'dependency-milestone-timeout',
        runId,
        scenario,
        sequence: 2,
        status: 'skipped',
        stopOnFailure: true,
      },
      {
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        reason: 'prior-command-failure',
        runId,
        scenario,
        sequence: 3,
        status: 'skipped',
      },
    ],
    runId,
    t,
  });

  assert.ok(waits[0] !== undefined && waits[0] > 0 && waits[0] <= 100);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completionKind, 'stop-on-failure');
  const commandFailure = (result.health.checks as Array<Record<string, unknown>>).find(
    (check) => check.code === 'profile_command_gate_timeout',
  );
  assert.deepEqual(commandFailure?.metadata, {
    command: 'second',
    commandId: 'second',
    commandStatus: 'skipped',
    completionKind: 'stop-on-failure',
    continuationReason: 'dependency-timeout-stop',
    expectedCommandCount: 3,
    missingDependencies: 'second_ready',
    observedTerminalCommands: 3,
    queueId: 'completion-queue',
    rawPath: 'raw/ios-profile-session-completion-wait.json',
    reason: 'dependency-milestone-timeout',
    sequence: 2,
    stopOnFailure: true,
  });
});

test('ends iOS capture when commandId is omitted and stable id is used', async (t: TestContext) => {
  const runId = 'ios-command-id-fallback';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    commands: [
      { command: 'first', id: 'fallback-command-1', queueId: 'fallback-queue', sequence: 1 },
    ],
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        id: 'fallback-command-1',
        kind: 'command',
        queueId: 'fallback-queue',
        runId,
        scenario,
        sequence: 1,
        status: 'completed',
      },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 0);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, true);
  assert.equal(completionWait.malformed, false);
});

test('classifies fail-fast tails by canonical command order instead of seed ordinal', async (t: TestContext) => {
  const runId = 'ios-out-of-order-seed';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    commands: [
      { command: 'later', commandId: 'later', id: 'queue-a-2', queueId: 'queue-a', sequence: 2 },
      { command: 'blocked', commandId: 'blocked', id: 'queue-a-1', queueId: 'queue-a', sequence: 1 },
    ],
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        commandId: 'blocked', continuationReason: 'dependency-timeout-stop', id: 'queue-a-1',
        kind: 'command', queueId: 'queue-a', reason: 'dependency-milestone-timeout', runId,
        scenario, sequence: 1, status: 'skipped', stopOnFailure: true,
      },
      {
        commandId: 'later', continuationReason: 'dependency-timeout-stop', id: 'queue-a-2',
        kind: 'command', queueId: 'queue-a', reason: 'prior-command-failure', runId,
        scenario, sequence: 2, status: 'skipped',
      },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 0);
  assert.equal(
    (result.metadata.profileSessionCompletionWait as Record<string, unknown>).completionKind,
    'stop-on-failure',
  );
  const commandFailure = (result.health.checks as Array<Record<string, unknown>>).find(
    (check) => check.name === 'profile_command_sequence',
  );
  assert.equal(commandFailure?.code, 'profile_command_gate_timeout');
  assert.deepEqual(commandFailure?.metadata, {
    command: 'blocked',
    commandId: 'blocked',
    commandStatus: 'skipped',
    completionKind: 'stop-on-failure',
    continuationReason: 'dependency-timeout-stop',
    expectedCommandCount: 2,
    observedTerminalCommands: 2,
    queueId: 'queue-a',
    rawPath: 'raw/ios-profile-session-completion-wait.json',
    reason: 'dependency-milestone-timeout',
    sequence: 1,
    stopOnFailure: true,
  });
});

test('classifies equal and missing sequences by timestamp then stable id', async (t: TestContext) => {
  const runId = 'ios-sequence-tie-breaks';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    commands: [
      { command: 'unsequenced', commandId: 'unsequenced', id: 'queue-a-c', queueId: 'queue-a', timestamp: 300 },
      { command: 'equal-later', commandId: 'equal-later', id: 'queue-a-b', queueId: 'queue-a', sequence: 1, timestamp: 100 },
      { command: 'blocked', commandId: 'blocked', id: 'queue-a-a', queueId: 'queue-a', sequence: 1, timestamp: 100 },
    ],
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        commandId: 'blocked', continuationReason: 'dependency-timeout-stop', id: 'queue-a-a',
        kind: 'command', queueId: 'queue-a', reason: 'dependency-milestone-timeout', runId,
        scenario, sequence: 1, status: 'skipped', stopOnFailure: true,
      },
      {
        commandId: 'equal-later', continuationReason: 'dependency-timeout-stop', id: 'queue-a-b',
        kind: 'command', queueId: 'queue-a', reason: 'prior-command-failure', runId,
        scenario, sequence: 1, status: 'skipped',
      },
      {
        commandId: 'unsequenced', continuationReason: 'dependency-timeout-stop', id: 'queue-a-c',
        kind: 'command', queueId: 'queue-a', reason: 'prior-command-failure', runId,
        scenario, status: 'skipped',
      },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 0);
  assert.equal(
    (result.metadata.profileSessionCompletionWait as Record<string, unknown>).completionKind,
    'stop-on-failure',
  );
});

test('allows sequence reuse across independent queues during fail-fast completion', async (t: TestContext) => {
  const runId = 'ios-sequence-reuse-across-queues';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    commands: [
      { command: 'blocked', commandId: 'blocked', id: 'queue-a-1', queueId: 'queue-a', sequence: 1 },
      { command: 'independent', commandId: 'independent', id: 'queue-b-1', queueId: 'queue-b', sequence: 1 },
    ],
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        commandId: 'blocked', continuationReason: 'dependency-timeout-stop', id: 'queue-a-1',
        kind: 'command', queueId: 'queue-a', reason: 'dependency-milestone-timeout', runId,
        scenario, sequence: 1, status: 'skipped', stopOnFailure: true,
      },
      {
        commandId: 'independent', id: 'queue-b-1', kind: 'command', queueId: 'queue-b',
        runId, scenario, sequence: 1, status: 'completed',
      },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 0);
  assert.equal(
    (result.metadata.profileSessionCompletionWait as Record<string, unknown>).completionKind,
    'stop-on-failure',
  );
});

test('ends iOS capture after one failed queue while another expected queue completes', async (t: TestContext) => {
  const runId = 'ios-scoped-dependency-stop';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    commands: [
      { command: 'first', commandId: 'first', id: 'queue-a-1', queueId: 'queue-a', sequence: 1 },
      { command: 'second', commandId: 'second', id: 'queue-a-2', queueId: 'queue-a', sequence: 2 },
      { command: 'third', commandId: 'third', id: 'queue-b-1', queueId: 'queue-b', sequence: 3 },
    ],
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        reason: 'dependency-milestone-timeout',
        runId,
        scenario,
        sequence: 1,
        status: 'skipped',
        stopOnFailure: true,
      },
      {
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        reason: 'prior-command-failure',
        runId,
        scenario,
        sequence: 2,
        status: 'skipped',
      },
      { kind: 'command', runId, scenario, sequence: 3, status: 'completed' },
    ],
    runId,
    t,
  });

  assert.ok(waits[0] !== undefined && waits[0] > 0 && waits[0] <= 100);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completionKind, 'stop-on-failure');
  assert.equal(completionWait.observedTerminalCommands, 3);
});

test('keeps the full iOS capture window for partial dependency timeout evidence', async (t: TestContext) => {
  const runId = 'ios-partial-dependency-stop';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        reason: 'dependency-milestone-timeout',
        runId,
        scenario,
        sequence: 1,
        status: 'skipped',
        stopOnFailure: true,
      },
      { kind: 'command', runId, scenario, sequence: 2, status: 'delivered' },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, false);
  assert.equal(completionWait.observedTerminalCommands, 1);
});

test('keeps the full iOS capture window for a noncanonical dependency timeout tail', async (t: TestContext) => {
  const runId = 'ios-wrong-dependency-tail';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        continuationReason: 'dependency-timeout-stop', kind: 'command',
        reason: 'dependency-milestone-timeout', runId, scenario, sequence: 1,
        status: 'skipped', stopOnFailure: true,
      },
      { kind: 'command', runId, scenario, sequence: 2, status: 'completed' },
      { kind: 'command', runId, scenario, sequence: 3, status: 'completed' },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  assert.equal(
    (result.metadata.profileSessionCompletionWait as Record<string, unknown>).completed,
    false,
  );
});

test('keeps the full iOS capture window for a noncanonical milestone timeout tail', async (t: TestContext) => {
  const runId = 'ios-wrong-milestone-tail';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        continuationReason: 'milestone-timeout-stop', kind: 'command',
        reason: 'wait-for-milestone-timeout', runId, scenario, sequence: 1,
        status: 'skipped', stopOnFailure: true,
      },
      {
        continuationReason: 'dependency-timeout-stop', kind: 'command',
        reason: 'prior-command-failure', runId, scenario, sequence: 2, status: 'skipped',
      },
      { kind: 'command', runId, scenario, sequence: 3, status: 'completed' },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  assert.equal(
    (result.metadata.profileSessionCompletionWait as Record<string, unknown>).completed,
    false,
  );
});

test('keeps the full iOS capture window for a wrong-queue dependency timeout set', async (t: TestContext) => {
  const runId = 'ios-wrong-queue-dependency-stop';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'completed' },
      {
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        queueId: 'wrong-queue',
        reason: 'dependency-milestone-timeout',
        runId,
        scenario,
        sequence: 2,
        status: 'skipped',
        stopOnFailure: true,
      },
      {
        continuationReason: 'dependency-timeout-stop',
        kind: 'command',
        queueId: 'wrong-queue',
        reason: 'prior-command-failure',
        runId,
        scenario,
        sequence: 3,
        status: 'skipped',
      },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, false);
  assert.equal(completionWait.malformed, true);
});

test('keeps the full iOS capture window for ambiguous expected command identities', async (t: TestContext) => {
  const runId = 'ios-duplicate-expected-command';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    commands: [
      { command: 'first', commandId: 'first', id: 'duplicate-id', queueId: 'completion-queue', sequence: 1, timestamp: 100 },
      { command: 'second', commandId: 'second', id: 'duplicate-id', queueId: 'completion-queue', sequence: 1, timestamp: 100 },
    ],
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { id: 'duplicate-id', kind: 'command', queueId: 'completion-queue', runId, scenario, sequence: 1, status: 'completed' },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, false);
  assert.equal(completionWait.malformed, true);
});

test('keeps the full iOS capture window for wrong-run and nonterminal command evidence', async (t: TestContext) => {
  const runId = 'ios-nonterminal';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'delivered' },
      { kind: 'command', runId: 'other-run', scenario, sequence: 1, status: 'completed' },
      { kind: 'command', runId, scenario: 'other-scenario', sequence: 2, status: 'completed' },
      null as unknown as Record<string, unknown>,
    ],
    runId,
    t,
  });

  assert.ok(waits[0] !== undefined && waits[0] > 0 && waits[0] <= 100);
  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, false);
  assert.equal(completionWait.observedTerminalCommands, 0);
  assert.equal(
    (result.health.checks as Array<Record<string, unknown>>).some((check) => check.name === 'profile_command_sequence'),
    false,
  );
});

test('keeps the full iOS capture window for malformed same-run command evidence', async (t: TestContext) => {
  const runId = 'ios-malformed-terminal';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'completed' },
      { kind: 'command', runId, scenario, sequence: 2, status: 'completed' },
      { kind: 'command', runId, scenario, sequence: 3, status: 'completed' },
      { kind: 'command', runId, scenario, sequence: 'invalid', status: 'completed' },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, false);
  assert.equal(completionWait.malformed, true);
});

test('keeps the full iOS capture window for ambiguous decisive failures', async (t: TestContext) => {
  const runId = 'ios-ambiguous-stop';
  const scenario = 'profile-session-completion';
  const decisiveFailure = (sequence: number) => ({
    continuationReason: 'milestone-timeout-stop',
    kind: 'command',
    reason: 'wait-for-milestone-timeout',
    runId,
    scenario,
    sequence,
    status: 'skipped',
    stopOnFailure: true,
  });
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'completed' },
      decisiveFailure(2),
      decisiveFailure(3),
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.ambiguous, true);
  assert.equal(completionWait.completed, false);
});

test('does not fail fast when milestone timeout evidence has stopOnFailure false', async (t: TestContext) => {
  const runId = 'ios-stop-disabled';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      {
        continuationReason: 'milestone-timeout-continue',
        kind: 'command',
        reason: 'wait-for-milestone-timeout',
        runId,
        scenario,
        sequence: 1,
        status: 'skipped',
        stopOnFailure: false,
      },
      { kind: 'command', runId, scenario, sequence: 2, status: 'delivered' },
    ],
    runId,
    t,
  });

  assert.equal(waits.slice(1).reduce((total, value) => total + value, 0), 1000);
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completed, false);
  assert.equal(completionWait.completionKind, null);
  const captureWindowCheck = (result.health.checks as Array<Record<string, unknown>>).find(
    (check) => check.name === 'ios_capture_window_waited',
  );
  assert.equal((captureWindowCheck?.metadata as Record<string, unknown>).endedEarly, false);
});

test('ends iOS capture early when every expected command completed successfully', async (t: TestContext) => {
  const runId = 'ios-all-completed';
  const scenario = 'profile-session-completion';
  const { result, waits } = await captureProfileSessionCompletionFixture({
    entries: [
      { kind: 'start', runId, scenario, status: 'started' },
      { kind: 'command', runId, scenario, sequence: 1, status: 'completed' },
      { kind: 'command', runId, scenario, sequence: 2, status: 'completed' },
      { kind: 'command', runId, scenario, sequence: 3, status: 'completed' },
    ],
    runId,
    t,
  });

  assert.equal(waits.length, 1);
  assert.ok(waits[0] !== undefined && waits[0] > 0 && waits[0] <= 100);
  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  const completionWait = result.metadata.profileSessionCompletionWait as Record<string, unknown>;
  assert.equal(completionWait.completionKind, 'all-commands-terminal');
  const captureWindowCheck = (result.health.checks as Array<Record<string, unknown>>).find(
    (check) => check.name === 'ios_capture_window_waited',
  );
  assert.equal((captureWindowCheck?.metadata as Record<string, unknown>).endedEarly, true);
});

test('writes next-action hints when no iOS simulator is booted', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-missing-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Shutdown)',
      ].join('\n'),
    },
  });

  const result = await runIosSimctlCapture({
    executor,
    launch: true,
    outputDir,
    runId: 'ios-missing-sim',
  });
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.verdict.verdictStatus, 'inconclusive');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_simulator_missing' && check.metadata?.nextActionCode === 'boot_ios_simulator',
    ),
  );
  assert.match(summary, /Next action `boot_ios_simulator`/u);
});

test('explains agent sandbox access when simctl listing is unavailable', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-unavailable-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      exitCode: 1,
      stderr: 'Operation not permitted',
    },
  });

  const result = await runIosSimctlCapture({
    executor,
    outputDir,
    runId: 'ios-simctl-unavailable',
  });
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextAction?: string; nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_simctl_unavailable'
        && check.metadata?.nextActionCode === 'fix_xcrun_simctl'
        && /agent sandbox/u.test(check.metadata.nextAction ?? ''),
    ),
  );
  assert.match(summary, /agent sandbox/u);
});

test('writes iOS capture started checkpoint before executor resolves', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-started-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const devices = createDeferredCommandResult();
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    if (args.join(' ') === 'simctl list devices') {
      return devices.promise;
    }

    return {
      args,
      command,
      exitCode: 1,
      stderr: `unexpected command: ${args.join(' ')}`,
      stdout: '',
    };
  };

  const run = runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    commandTimeoutMs: 30000,
    executor,
    launch: true,
    outputDir,
    runId: 'ios-simctl-started',
  });
  const checkpointPath = path.join(outputDir, 'raw', 'ios-simctl-capture-started.json');
  let checkpointText = '';
  await waitFor(() => {
    if (!fs.existsSync(checkpointPath)) {
      return false;
    }
    checkpointText = fs.readFileSync(checkpointPath, 'utf8');
    try {
      JSON.parse(checkpointText);
      return true;
    } catch {
      return false;
    }
  });
  const rawEntriesBeforeExecutorResolves = fs.readdirSync(path.join(outputDir, 'raw'));
  const checkpoint = JSON.parse(checkpointText);

  assert.deepEqual(rawEntriesBeforeExecutorResolves, ['ios-simctl-capture-started.json']);
  assert.equal(checkpoint.status, 'started');
  assert.equal(checkpoint.runId, 'ios-simctl-started');
  assert.equal(checkpoint.commandTimeoutMs, 30000);
  assert.equal(checkpoint.watchdog.armed, true);
  assert.equal(typeof checkpoint.watchdog.timeoutMs, 'number');
  assert.equal(typeof checkpoint.watchdog.deadlineEpochMs, 'number');
  assert.equal(checkpoint.selectedInputs.bundleId, 'dev.agent-scenario-loop.example');
  assert.equal(checkpoint.selectedInputs.launch, true);

  devices.resolve({
    args: ['simctl', 'list', 'devices'],
    command: 'fake-xcrun',
    exitCode: 0,
    stderr: '',
    stdout: [
      '== Devices ==',
      '-- iOS 26.3 --',
      '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
    ].join('\n'),
  });
  const result = await run;
  const finalMetadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8'));

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(finalMetadata.captureStarted.rawPath, 'raw/ios-simctl-capture-started.json');
});

test('derives bounded iOS simctl capture watchdog from declared waits', () => {
  const watchdog = deriveIosSimctlCaptureWatchdogBudget({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    commandTimeoutMs: 60000,
    deepLinks: [
      {
        url: 'example://profile-session/start',
        waitMs: 250,
      },
    ],
    launch: true,
    profileSessionStorage: {
      commands: [
        {
          command: 'open',
          sequence: 1,
        },
      ],
      runId: 'ios-watchdog',
      scenario: 'open-close-cycle',
    },
    profileSessionStartWaitMs: 10000,
    screenshot: true,
    terminateBeforeLaunch: true,
    waitMs: 1000,
  });

  assert.equal(watchdog.source, 'derived');
  assert.equal(watchdog.declaredWaitMs, 11250);
  assert.equal(watchdog.perCommandOverheadMs, 3000);
  assert.equal(watchdog.commandBudgetMs <= 45000, true);
  assert.equal(watchdog.timeoutMs < 120000, true);

  const devClientWatchdog = deriveIosSimctlCaptureWatchdogBudget({
    bundleId: 'dev.agent-scenario-loop.example',
    commandTimeoutMs: 60000,
    deepLinks: [
      {
        label: 'ios-dev-client-url',
        url: 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
        waitMs: 25000,
      },
    ],
    profileSessionStorage: {
      commands: [],
      runId: 'ios-watchdog-dev-client',
      scenario: 'app-startup',
    },
    profileSessionStartWaitMs: 20000,
    waitMs: 145000,
  });

  assert.equal(devClientWatchdog.declaredWaitMs, 210000);
  assert.equal(devClientWatchdog.timeoutMs >= devClientWatchdog.declaredWaitMs, true);

  const explicitWatchdog = deriveIosSimctlCaptureWatchdogBudget({
    captureWatchdogMs: 600000,
    commandTimeoutMs: 60000,
  });

  assert.equal(explicitWatchdog.source, 'override');
  assert.equal(explicitWatchdog.timeoutMs, 600000);
});

test('writes failed artifact set when iOS simctl executor never resolves after output setup', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-watchdog-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    if (args.join(' ') === 'simctl list devices') {
      return new Promise<CommandResult>(() => {});
    }

    return {
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: 'ok\n',
    };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    captureWatchdogMs: 50,
    commandTimeoutMs: 1000,
    executor,
    launch: true,
    outputDir,
    runId: 'ios-simctl-watchdog',
  });
  const health = JSON.parse(fs.readFileSync(path.join(outputDir, 'health.json'), 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(path.join(outputDir, 'verdict.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8'));
  const failureRaw = fs.readFileSync(path.join(outputDir, 'raw', 'ios-simctl-runner-watchdog-timeout.txt'), 'utf8');
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  assert.notEqual(verdict.verdictStatus, 'passed');
  assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'failed',
    rawArtifacts: [
      'raw/ios-simctl-capture-started.json',
      'raw/ios-simctl-runner-watchdog-timeout.txt',
      'raw/ios-metadata.json',
    ],
  });
  assert.ok(
    (health.checks as Array<{
      code: string;
      metadata?: {
        nextActionCode?: string;
        nextActionOwner?: string;
        pendingPhase?: string;
        pendingPhaseDetails?: string;
        rawPath?: string;
        watchdogTimeoutMs?: number;
      };
    }>).some(
      (check) => check.code === 'ios_simctl_runner_liveness_timeout'
        && check.metadata?.nextActionCode === 'inspect_ios_simctl_runner_timeout'
        && check.metadata?.nextActionOwner === 'asl_runner'
        && check.metadata?.pendingPhase === 'listing_simulators'
        && check.metadata?.pendingPhaseDetails === '{"device":"booted"}'
        && check.metadata?.rawPath === 'raw/ios-simctl-runner-watchdog-timeout.txt'
        && check.metadata?.watchdogTimeoutMs === 50,
    ),
  );
  assert.match(failureRaw, /iOS simctl capture did not complete within 50ms/u);
  assert.match(failureRaw, /ios_simctl_runner_liveness_timeout/u);
  assert.match(summary, /Next action `inspect_ios_simctl_runner_timeout`/u);
  assert.match(summary, /Owner: `asl_runner`/u);
  assert.match(summary, /pendingPhase=`listing_simulators`/u);
  assert.match(summary, /watchdogTimeoutMs=`50`/u);
  assert.equal(metadata.runnerFailure.rawPath, 'raw/ios-simctl-runner-watchdog-timeout.txt');
  assert.equal(metadata.runnerFailure.watchdog.timeoutMs, 50);
  assert.equal(metadata.runnerFailure.currentPhase.name, 'listing_simulators');
  assert.ok(metadata.runnerFailure.collectedRawArtifacts.includes('raw/ios-simctl-capture-started.json'));
});

test('classifies missing iOS profile-session start after storage seed and dev-client open', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-profile-start-missing-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-profile-start-data-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
      stdout: '',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
      stdout: '',
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data': {
      stdout: `${dataContainer}\n`,
    },
    'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '',
    },
    'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097': {
      stdout: '',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"ApplicationState":"ForegroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });
  const waits: number[] = [];
  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    deepLinks: [
      {
        label: 'ios-dev-client-url',
        url: 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
      },
    ],
    executor,
    outputDir,
    profileSessionStorage: {
      commands: [
        {
          command: 'open-drawer',
          sequence: 1,
        },
      ],
      runId: 'ios-profile-start-missing',
      scenario: 'account-drawer',
    },
    delay: async (ms: number) => {
      waits.push(ms);
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    profileSessionStartWaitMs: 5,
    runId: 'ios-profile-start-missing',
    terminateBeforeLaunch: true,
    waitMs: 1000,
  });
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8'));
  const startWait = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-start-wait.json'), 'utf8'));
  const readiness = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-readiness.json'), 'utf8'));
  const startAppInfo = fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-start-app-info.txt'), 'utf8');
  const startWaitCheck = (result.health.checks as Array<{ code: string; metadata?: Record<string, unknown> }>).find(
    (check) => check.code === 'ios_profile_session_start_wait_exhausted',
  );

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(startWaitCheck?.metadata?.nextActionCode, 'fix_ios_profile_command_channel');
  assert.equal(startWaitCheck?.metadata?.nextActionOwner, 'runtime_environment');
  assert.equal(startWaitCheck?.metadata?.commandCount, 1);
  assert.equal(startWaitCheck?.metadata?.devClientDeepLinkOpened, true);
  assert.equal(startWaitCheck?.metadata?.expectedEvidence, 'profile-session-start-or-profile-events');
  assert.equal(startWaitCheck?.metadata?.failureClass, 'profile_command_channel_missing');
  assert.equal(startWaitCheck?.metadata?.foregroundAppInfoCaptured, true);
  assert.equal(startWaitCheck?.metadata?.foregroundApplicationState, 'ForegroundRunning');
  assert.equal(startWaitCheck?.metadata?.foregroundRawPath, 'raw/ios-profile-session-start-app-info.txt');
  assert.equal(startWaitCheck?.metadata?.foregroundTargetOwned, true);
  assert.equal(startWaitCheck?.metadata?.lastDeepLinkLabel, 'ios-dev-client-url');
  assert.equal(startWaitCheck?.metadata?.pendingPhase, 'waiting_for_profile_session_start');
  assert.equal(startWaitCheck?.metadata?.readinessDetail, 'dev_client_foreground_command_channel_missing');
  assert.equal(startWaitCheck?.metadata?.profileCommandStorageKey, 'agent-scenario-loop.profile-commands.1');
  assert.equal(startWaitCheck?.metadata?.readinessRawPath, 'raw/ios-profile-session-readiness.json');
  assert.equal(startWaitCheck?.metadata?.profileSessionSeeded, true);
  assert.equal(startWaitCheck?.metadata?.profileSessionSeedRawPath, 'raw/ios-profile-session-seed.json');
  assert.ok(!waits.includes(1000));
  assert.equal(startWait.completed, false);
  assert.match(startAppInfo, /ForegroundRunning/u);
  assert.equal(readiness.commandCount, 1);
  assert.equal(readiness.devClientDeepLinkOpened, true);
  assert.equal(readiness.failureClass, 'profile_command_channel_missing');
  assert.equal(readiness.foregroundProbe.applicationState, 'ForegroundRunning');
  assert.equal(readiness.foregroundProbe.targetForeground, true);
  assert.equal(readiness.pendingPhase, 'waiting_for_profile_session_start');
  assert.equal(readiness.profileCommandStorageKey, 'agent-scenario-loop.profile-commands.1');
  assert.equal(readiness.seedRawPath, 'raw/ios-profile-session-seed.json');
  assert.equal(readiness.profileSessionStorageKey, 'agent-scenario-loop.profile-session.1');
  assert.equal(readiness.readinessDetail, 'dev_client_foreground_command_channel_missing');
  assert.equal(metadata.profileSessionStartWait.completed, false);
  assert.equal(metadata.profileSessionStartWait.rawPath, 'raw/ios-profile-session-start-wait.json');
  assert.equal(metadata.profileSessionReadiness.rawPath, 'raw/ios-profile-session-readiness.json');
  assert.equal(metadata.profileSessionReadiness.expectedEvidence, 'profile-session-start-or-profile-events');
  assert.equal(metadata.profileSessionReadiness.foregroundProbe.rawPath, 'raw/ios-profile-session-start-app-info.txt');
  assert.equal(metadata.profileSessionStartObservation.observed, false);
  assert.equal(metadata.profileSessionStartObservation.runId, 'ios-profile-start-missing');
  assert.equal(metadata.currentPhase.name, 'finalizing_artifacts');
});

test('classifies iOS profile-session foreground evidence at the readiness policy boundary', async (t: TestContext) => {
  const cases = [
    {
      applicationState: null,
      expectedFailureClass: 'dev_client_bundle_or_command_channel_not_ready',
      expectedNextActionCode: 'fix_ios_dev_client_bundle_or_command_channel',
      expectedReadinessDetail: 'dev_client_foreground_unknown',
      expectedTargetForeground: null,
      name: 'unknown when ApplicationState is missing',
    },
    {
      applicationState: 'ForegroundRunning',
      expectedFailureClass: 'profile_command_channel_missing',
      expectedNextActionCode: 'fix_ios_profile_command_channel',
      expectedReadinessDetail: 'dev_client_foreground_command_channel_missing',
      expectedTargetForeground: true,
      name: 'known foreground',
    },
    {
      applicationState: 'BackgroundRunning',
      expectedFailureClass: 'dev_client_not_foreground',
      expectedNextActionCode: 'reload_ios_dev_client_url',
      expectedReadinessDetail: 'dev_client_not_foreground',
      expectedTargetForeground: false,
      name: 'known non-foreground',
    },
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest: TestContext) => {
      const { readiness, startWaitCheck } = await captureMissingProfileSessionStartForApplicationState({
        applicationState: fixture.applicationState,
        runId: `ios-readiness-${fixture.name.replaceAll(' ', '-')}`,
        t: subtest,
      });

      assert.equal(startWaitCheck?.metadata?.failureClass, fixture.expectedFailureClass);
      assert.equal(startWaitCheck?.metadata?.foregroundTargetOwned, fixture.expectedTargetForeground);
      assert.equal(startWaitCheck?.metadata?.nextActionCode, fixture.expectedNextActionCode);
      assert.equal(startWaitCheck?.metadata?.readinessDetail, fixture.expectedReadinessDetail);
      assert.equal(readiness.failureClass, fixture.expectedFailureClass);
      assert.equal(readiness.foregroundProbe.targetForeground, fixture.expectedTargetForeground);
      assert.equal(readiness.readinessDetail, fixture.expectedReadinessDetail);
    });
  }
});

test('reopens iOS dev-client URL when storage start is missing before final classification', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-profile-start-repair-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-profile-start-repair-data-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const runId = 'ios-profile-start-repaired';
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  let devClientOpenCount = 0;
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    if (key === 'simctl list devices') {
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      };
    }
    if (key === 'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES' ||
      key === 'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET') {
      return { args, command, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === 'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app') {
      return { args, command, exitCode: 0, stderr: '', stdout: '/tmp/ASLExampleMobile.app\n' };
    }
    if (key === 'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data') {
      return { args, command, exitCode: 0, stderr: '', stdout: `${dataContainer}\n` };
    }
    if (key === 'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') {
      return { args, command, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === 'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') {
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: '{"ApplicationState":"BackgroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
      };
    }
    if (key === 'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097') {
      devClientOpenCount += 1;
      if (devClientOpenCount === 2) {
        await fsp.mkdir(storageDir, { recursive: true });
        await fsp.writeFile(
          path.join(storageDir, 'manifest.json'),
          JSON.stringify({
            'agent-scenario-loop.profile-events.1': null,
            'agent-scenario-loop.profile-session-entries.1': null,
          }),
          'utf8',
        );
        await fsp.writeFile(
          path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1')),
          JSON.stringify([{ event: 'app_ready', runId, timestamp: Date.now() }]),
          'utf8',
        );
        await fsp.writeFile(
          path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-session-entries.1')),
          JSON.stringify([{ kind: 'start', runId, timestamp: Date.now() }]),
          'utf8',
        );
      }
      return { args, command, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === 'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"') {
      return { args, command, exitCode: 0, stderr: '', stdout: 'Timestamp Ty Process[PID:TID]\n' };
    }
    return { args, command, exitCode: 1, stderr: `unexpected command: ${key}`, stdout: '' };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    deepLinks: [
      {
        label: 'ios-dev-client-url',
        url: 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097',
      },
    ],
    delay: async () => {},
    executor,
    outputDir,
    profileSessionStorage: {
      commands: [],
      runId,
      scenario: 'app-startup',
    },
    profileSessionStartWaitMs: 5,
    runId,
    terminateBeforeLaunch: true,
  });
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8'));
  const readiness = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-readiness.json'), 'utf8'));
  const repairOpenCheck = (result.health.checks as Array<{ code: string; status: string }>).find(
    (check) => check.code === 'ios_dev_client_readiness_repair_opened',
  );
  const startWaitCheck = (result.health.checks as Array<{ name: string; status: string }>).find(
    (check) => check.name === 'ios_profile_session_start_wait',
  );

  assert.equal(result.health.healthStatus, 'passed');
  assert.equal(devClientOpenCount, 2);
  assert.equal(repairOpenCheck?.status, 'passed');
  assert.equal(startWaitCheck?.status, 'passed');
  assert.equal(metadata.profileSessionStartWait.completed, true);
  assert.equal(metadata.profileSessionStartRepair.completed, true);
  assert.equal(metadata.profileSessionStartRepair.reason, 'dev_client_not_foreground');
  assert.equal(metadata.profileSessionStartRepair.rawPath, 'raw/ios-dev-client-readiness-retry-1.txt');
  assert.equal(readiness.profileSessionStartRepair.completed, true);
  assert.equal(readiness.profileSessionStartRepair.reason, 'dev_client_not_foreground');
});

test('times out hung iOS simctl subprocesses with diagnostic stderr', async () => {
  const result = await execFileCommandWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], 20);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Command timed out after 20ms/u);
});

test('clamps oversized command timeout values before writing metadata', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-timeout-clamp-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
      exitCode: 1,
      stderr: '',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
      exitCode: 1,
      stderr: '',
    },
  });

  const result = await runIosSimctlCapture({
    commandTimeoutMs: 5_000_000_000,
    executor,
    outputDir,
    runId: 'ios-simctl-timeout-clamp',
  });
  const checkpoint = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-simctl-capture-started.json'), 'utf8'));

  assert.equal(result.metadata.commandTimeoutMs, 2_147_483_647);
  assert.equal(checkpoint.commandTimeoutMs, 2_147_483_647);
});

test('captures bounded iOS simulator log evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const screenshotPath = path.join(outputDir, 'captures', 'ios-screenshot.jpeg');
    if (key === `simctl io A692ED28-893E-453F-8866-C69331AE757F screenshot --type=jpeg --display=Internal-1 --mask=black ${screenshotPath}`) {
      await fsp.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fsp.writeFile(screenshotPath, 'PNG', 'utf8');
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: 'Wrote screenshot\n',
      };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?scenario=app-startup&runId=ios-live': {
        stdout: '',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: '[profile-event] scenario=app-startup runId=ios-live event=home_ready timestamp=1\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
  const waits: number[] = [];
  const recorder = new EventEmitter() as import('node:events').EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: import('node:events').EventEmitter;
    stdout: import('node:events').EventEmitter;
  };
  recorder.stderr = new EventEmitter();
  recorder.stdout = new EventEmitter();
  recorder.kill = () => {
    const videoPath = path.join(outputDir, 'captures', 'ios-recording.mp4');
    void fsp.writeFile(videoPath, Buffer.from('000000106674797069736f6d00000000', 'hex'))
      .then(() => recorder.emit('close', 0, 'SIGINT'));
    return true;
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
      },
    ],
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    record: true,
    recorderFactory: () => {
      calls.push('recordVideo started');
      return recorder;
    },
    runId: 'ios-live',
    screenshot: true,
    screenshotDisplay: 'Internal-1',
    screenshotMask: 'black',
    screenshotType: 'jpeg',
    waitMs: 250,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'passed',
    rawArtifacts: ['raw/ios-metadata.json', 'raw/ios-screenshot.txt'],
  });
  assertReportedCaptureArtifactsExist(result);
  assertMetadataCapturePathsExist(outputDir, 'raw/ios-metadata.json');
  assert.deepEqual(waits, [250]);
  assert.equal(result.captures.screenshot, 'captures/ios-screenshot.jpeg');
  assert.equal(result.captures.video, 'captures/ios-recording.mp4');
  assert.ok(fs.existsSync(path.join(outputDir, 'captures', 'ios-recording.mp4')));
  assert.deepEqual((result.metadata.video as Record<string, unknown>).cleanup, {
    orphaned: false,
    signals: ['SIGINT'],
  });
  assert.equal((result.metadata.video as Record<string, unknown>).state, 'finalized');
  assert.ok(Array.isArray((result.metadata.video as Record<string, unknown>).timeline));
  assert.deepEqual((result.metadata.video as Record<string, unknown>).args, [
    'simctl', 'io', 'A692ED28-893E-453F-8866-C69331AE757F', 'recordVideo', 'captures/ios-recording.mp4',
  ]);
  assert.deepEqual((result.metadata.deepLinkResults as Array<Record<string, unknown>>)[0], {
    args: [
      'simctl',
      'openurl',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
    ],
    exitCode: 0,
    label: 'profile-session-start',
    rawPath: 'raw/ios-deep-link-1.txt',
    url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
    waitMs: 0,
  });
  assert.deepEqual(result.metadata.screenshot, {
    args: [
      'simctl',
      'io',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'screenshot',
      '--type=jpeg',
      '--display=Internal-1',
      '--mask=black',
      path.join(outputDir, 'captures', 'ios-screenshot.jpeg'),
    ],
    capturePath: 'captures/ios-screenshot.jpeg',
    exitCode: 0,
    options: {
      display: 'Internal-1',
      mask: 'black',
      type: 'jpeg',
    },
    rawPath: 'raw/ios-screenshot.txt',
  });
  assert.ok(fs.existsSync(path.join(outputDir, 'captures', 'ios-screenshot.jpeg')));
  assert.ok(fs.readFileSync(path.join(outputDir, 'raw', 'ios-simctl-log.txt'), 'utf8').includes('[profile-event]'));
  assert.ok(calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') < calls.indexOf('simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?scenario=app-startup&runId=ios-live'));
  assert.ok(calls.indexOf('recordVideo started') < calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'ios_logs_captured'),
  );
});

test('reports start failure when iOS recorder cannot be created', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-record-start-failed-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const result = await runIosSimctlCapture({
    executor: createBootedSimctlExecutor(),
    outputDir,
    record: true,
    recorderFactory: () => {
      throw new Error('spawn failed');
    },
    runId: 'ios-record-start-failed',
  });

  const videoCheck = (result.health.checks as Array<{
    code: string;
    metadata?: { nextActionOwner?: string };
    status: string;
  }>).find(
    (check) => check.code.startsWith('ios_video_') && check.status === 'failed',
  );
  const videoRaw = fs.readFileSync(path.join(outputDir, 'raw', 'ios-record-video.txt'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.captures.video, null);
  assert.equal(videoCheck?.status, 'failed');
  assert.equal(videoCheck?.metadata?.nextActionOwner, 'asl_runner');
  assert.match(result.agentSummary, /Owner: `asl_runner`/u);
  assert.match(videoRaw, /spawn failed/u);
  assert.match(videoRaw, /validationReason=missing/u);
});

test('records partial iOS video evidence when watchdog cancels active recorder', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-record-watchdog-cancelled-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const signals: NodeJS.Signals[] = [];
  const recorder = new EventEmitter() as import('node:events').EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: import('node:events').EventEmitter;
    stdout: import('node:events').EventEmitter;
  };
  recorder.stderr = new EventEmitter();
  recorder.stdout = new EventEmitter();
  recorder.kill = (signal: NodeJS.Signals) => {
    signals.push(signal);
    if (signal === 'SIGINT') {
      const videoPath = path.join(outputDir, 'captures', 'ios-recording.mp4');
      fs.writeFileSync(videoPath, Buffer.from('000000106674797069736f6d00000000', 'hex'));
      recorder.emit('close', 0, 'SIGINT');
    }
    return true;
  };

  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    if (key === 'simctl list devices') {
      return createBootedSimctlExecutor()('fake-xcrun', args);
    }
    if (
      key === `simctl spawn ${IOS_TEST_SIMULATOR_UDID} launchctl getenv DYLD_INSERT_LIBRARIES` ||
      key === `simctl spawn ${IOS_TEST_SIMULATOR_UDID} launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET`
    ) {
      return { args, command, exitCode: 0, stderr: '', stdout: '' };
    }
    if (key === `simctl get_app_container ${IOS_TEST_SIMULATOR_UDID} dev.agent-scenario-loop.example app`) {
      return { args, command, exitCode: 0, stderr: '', stdout: '/tmp/ASLExampleMobile.app\n' };
    }
    return {
      args,
      command,
      exitCode: 0,
      stderr: '',
      stdout: '',
    };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    captureWatchdogMs: 500,
    commandTimeoutMs: 50,
    delay: () => new Promise<void>(() => {}),
    executor,
    outputDir,
    record: true,
    recorderFactory: () => recorder,
    runId: 'ios-record-watchdog-cancelled',
    waitMs: 1000,
  });

  const videoCheck = (result.health.checks as Array<{ code: string; status: string }>).find(
    (check) => check.code === 'ios_video_cancelled_partial',
  );
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8'));

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.captures.video, 'captures/ios-recording.mp4');
  assert.deepEqual(signals, ['SIGINT']);
  assert.equal(videoCheck?.status, 'partial');
  assert.equal(metadata.video.state, 'cancelled');
  assert.equal(metadata.video.capturePath, 'captures/ios-recording.mp4');
  assert.equal(metadata.video.validation.reason, 'valid');
});

test('keeps validated early-stop iOS video as partial health evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-record-partial-health-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const recorder = new EventEmitter() as import('node:events').EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: import('node:events').EventEmitter;
    stdout: import('node:events').EventEmitter;
  };
  recorder.stderr = new EventEmitter();
  recorder.stdout = new EventEmitter();
  recorder.kill = () => true;

  const videoPath = path.join(outputDir, 'captures', 'ios-recording.mp4');
  const result = await runIosSimctlCapture({
    executor: createBootedSimctlExecutor(),
    outputDir,
    record: true,
    recorderFactory: () => {
      queueMicrotask(() => {
        fs.writeFileSync(videoPath, Buffer.from('000000106674797069736f6d00000000', 'hex'));
        recorder.emit('close', 0, 'SIGINT');
      });
      return recorder;
    },
    runId: 'ios-record-partial-health',
  });

  const videoCheck = (result.health.checks as Array<{ code: string; status: string }>).find(
    (check) => check.code === 'ios_video_failed_partial',
  );

  assert.equal(result.health.healthStatus, 'partial');
  assert.equal(result.captures.video, 'captures/ios-recording.mp4');
  assert.equal(videoCheck?.status, 'partial');
});

test('keeps zero-window direct recording as cancelled partial evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-record-zero-window-'));
  t.after(async () => fsp.rm(outputDir, { recursive: true, force: true }));
  const signals: NodeJS.Signals[] = [];
  const recorder = new EventEmitter() as import('node:events').EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: import('node:events').EventEmitter;
    stdout: import('node:events').EventEmitter;
  };
  recorder.stderr = new EventEmitter();
  recorder.stdout = new EventEmitter();
  recorder.kill = (signal: NodeJS.Signals) => {
    signals.push(signal);
    fs.writeFileSync(
      path.join(outputDir, 'captures', 'ios-recording.mp4'),
      Buffer.from('000000106674797069736f6d00000000', 'hex'),
    );
    recorder.emit('close', 0, 'SIGINT');
    return true;
  };
  const result = await runIosSimctlCapture({
    executor: createBootedSimctlExecutor(), outputDir, record: true,
    recorderFactory: () => recorder, runId: 'ios-record-zero-window', waitMs: 0,
  });
  const check = (result.health.checks as Array<{ code: string; status: string }>).find(
    (entry) => entry.code === 'ios_video_cancelled_partial',
  );
  assert.equal(result.health.healthStatus, 'partial');
  assert.equal(result.captures.video, 'captures/ios-recording.mp4');
  assert.equal(check?.status, 'partial');
  assert.deepEqual(signals, ['SIGINT']);
  assert.equal((result.metadata.video as Record<string, unknown>).state, 'cancelled');
});

test('fails iOS video capture when recorder output is invalid media', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-record-invalid-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });

  const recorder = new EventEmitter() as import('node:events').EventEmitter & {
    kill: (signal: NodeJS.Signals) => boolean;
    stderr: import('node:events').EventEmitter;
    stdout: import('node:events').EventEmitter;
  };
  recorder.stderr = new EventEmitter();
  recorder.stdout = new EventEmitter();
  recorder.kill = () => {
    const videoPath = path.join(outputDir, 'captures', 'ios-recording.mp4');
    fs.writeFileSync(videoPath, 'invalid-video-content-without-ftyp', 'utf8');
    recorder.emit('close', 0, 'SIGINT');
    return true;
  };

  const result = await runIosSimctlCapture({
    executor: createBootedSimctlExecutor(),
    outputDir,
    record: true,
    recorderFactory: () => recorder,
    runId: 'ios-record-invalid',
  });

  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8'));
  const videoCheck = (result.health.checks as Array<{ code: string; status: string }>).find(
    (check) => check.code === 'ios_video_output_invalid',
  );

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.captures.video, null);
  assert.equal(videoCheck?.status, 'failed');
  assert.equal(metadata.video.validation.reason, 'missing-ftyp');
  assert.equal(metadata.video.capturePath, null);
});

test('fails iOS capture when launched app exits during the capture window', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-crash-'));
  const diagnosticReportsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-diagnostic-reports-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(diagnosticReportsDir, { recursive: true, force: true });
  });
  const crashReportPath = path.join(diagnosticReportsDir, 'ASLExampleMobile-2026-06-18-194524.ips');
  await fsp.writeFile(
    crashReportPath,
    '{"app_name":"ASLExampleMobile","timestamp":"2026-06-18 19:45:24.00 +0100","bundleID":"dev.agent-scenario-loop.example","exception":{"type":"EXC_BAD_ACCESS","signal":"SIGSEGV"}}\n',
    'utf8',
  );
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 74759\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "74759"': {
      stdout: [
        'SpringBoard Process exited: <FBApplicationProcess; app<dev.agent-scenario-loop.example>:74759> -> <RBSProcessExitContext| specific, status:<RBSProcessExitStatus| domain:signal(2) code:SIGSEGV(11)>>',
        'runningboardd app<dev.agent-scenario-loop.example>:74759 exited with context signal SIGSEGV',
      ].join('\n'),
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    diagnosticReportsDir,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-crash',
  });

  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');
  const lifecycleLog = fs.readFileSync(path.join(outputDir, 'raw', 'ios-app-lifecycle-log.txt'), 'utf8');
  const attachedCrashReport = fs.readFileSync(
    path.join(outputDir, 'raw', 'ios-host-diagnostic-report-dev.agent-scenario-loop.example.ips'),
    'utf8',
  );
  const appLifecycle = result.metadata.appLifecycle as {
    hostDiagnosticReport: { modifiedAt: string };
  };

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(lifecycleLog.includes('SIGSEGV'));
  assert.ok(attachedCrashReport.includes('EXC_BAD_ACCESS'));
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextAction?: string; nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_app_exited_during_capture'
        && check.metadata?.nextActionCode === 'inspect_ios_app_crash'
        && /ios-host-diagnostic-report/u.test(check.metadata.nextAction ?? ''),
    ),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some(
      (check) => check.code === 'ios_host_diagnostic_report_attached',
    ),
  );
  assert.match(summary, /inspect_ios_app_crash/u);
  assert.deepEqual(result.metadata.appLifecycle, {
    args: [
      'simctl',
      'spawn',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      '1m',
      '--predicate',
      'eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "74759"',
    ],
    exitCode: 0,
    hostDiagnosticReport: {
      matched: true,
      modifiedAt: appLifecycle.hostDiagnosticReport.modifiedAt,
      rawPath: 'raw/ios-host-diagnostic-report-dev.agent-scenario-loop.example.ips',
      reportPath: crashReportPath,
      searchRawPath: 'raw/ios-host-diagnostic-report-search.txt',
    },
    pid: '74759',
    rawPath: 'raw/ios-app-lifecycle-log.txt',
  });
});

test('warns instead of failing when iOS lifecycle exit is not confirmed by crash evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-ambiguous-exit-'));
  const diagnosticReportsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-empty-diagnostic-reports-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(diagnosticReportsDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 74759\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "74759"': {
      stdout: 'runningboardd app<dev.agent-scenario-loop.example>:74759 exited with context unknown',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    diagnosticReportsDir,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-ambiguous-exit',
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(
    (result.health.checks as Array<{ code: string; status: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_app_lifecycle_exit_unconfirmed'
        && check.status === 'warning'
        && check.metadata?.nextActionCode === 'confirm_ios_app_lifecycle',
    ),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string; status: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_target_app_state_unknown'
        && check.status === 'warning'
        && check.metadata?.nextActionCode === 'confirm_ios_target_foreground',
    ),
  );
});

test('ignores WebKit helper lifecycle noise when app remains foreground', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-webkit-noise-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 89365\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "89365"': {
      stdout: [
        'SpringBoard RX dev.agent-scenario-loop.example(89365) signalKeyboardChanged',
        'runningboardd [xpcservice<com.apple.WebKit.WebContent([app<dev.agent-scenario-loop.example((null))>:89365])>:89543] reported to RB as running',
        'runningboardd Invalidating assertion 39338-89365-15099 (target:[xpcservice<com.apple.WebKit.WebContent([app<dev.agent-scenario-loop.example((null))>:89365])>:89543])',
        'SpringBoard Asked to bootstrap a new process for handle: [xpcservice<com.apple.WebKit.Networking([app<dev.agent-scenario-loop.example((null))>:89365])>:89542]',
      ].join('\n'),
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"ApplicationState":"ForegroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-webkit-noise',
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(
    (result.health.checks as Array<{ code: string; status: string }>).some(
      (check) => check.code === 'ios_app_lifecycle_stable' && check.status === 'passed',
    ),
  );
});

test('fails iOS capture when launched target app is not foreground after capture', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-backgrounded-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 1234\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"ApplicationState":"BackgroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-backgrounded',
  });

  const appInfo = result.metadata.appInfo as { applicationState: string; rawPath: string };

  assert.equal(result.health.healthStatus, 'failed');
  const { health } = assertAdapterArtifactConformance(result, {
    expectedHealthStatus: 'failed',
    rawArtifacts: ['raw/ios-app-info.txt', 'raw/ios-metadata.json'],
  });
  assertFailedHealthHasActionableMetadata(health, { checkCode: 'ios_target_app_backgrounded' });
  assert.deepEqual(appInfo, {
    applicationState: 'BackgroundRunning',
    args: [
      'simctl',
      'appinfo',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'dev.agent-scenario-loop.example',
    ],
    exitCode: 0,
    rawPath: 'raw/ios-app-info.txt',
  });
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_target_app_backgrounded'
        && check.metadata?.nextActionCode === 'restore_ios_target_foreground',
    ),
  );
  assert.match(
    fs.readFileSync(path.join(outputDir, 'raw', 'ios-app-info.txt'), 'utf8'),
    /BackgroundRunning/u,
  );
});

test('classifies iOS dev-client foreground mismatch after opening dev-client URL', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-dev-client-foreground-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const devClientUrl = 'asl-example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8097';
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 1234\n',
    },
    [`simctl openurl A692ED28-893E-453F-8866-C69331AE757F ${devClientUrl}`]: {
      stdout: '',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"ApplicationState":"BackgroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    deepLinks: [
      {
        label: 'ios-dev-client-url',
        url: devClientUrl,
      },
    ],
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-dev-client-backgrounded',
  });

  const foregroundCheck = (
    result.health.checks as Array<{
      code: string;
      metadata?: {
        devClientDeepLinkLabel?: string | null;
        devClientDeepLinkRawPath?: string | null;
        devClientDeepLinkUrl?: string | null;
        failureClass?: string;
        nextActionCode?: string;
      };
    }>
  ).find((check) => check.code === 'ios_target_app_backgrounded');

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(foregroundCheck?.metadata?.failureClass, 'dev_client_foreground_mismatch');
  assert.equal(foregroundCheck?.metadata?.nextActionCode, 'reload_ios_dev_client_url');
  assert.equal(foregroundCheck?.metadata?.devClientDeepLinkLabel, 'ios-dev-client-url');
  assert.equal(foregroundCheck?.metadata?.devClientDeepLinkRawPath, 'raw/ios-deep-link-1.txt');
  assert.equal(foregroundCheck?.metadata?.devClientDeepLinkUrl, devClientUrl);
});

test('blocks lifecycle mutation when simulator launch environment is contaminated', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-launch-env-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
        stdout: '/tmp/libInjectedRunner.dylib\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
        stdout: '/tmp/runner.sock\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-contaminated',
      },
    ],
    executor,
    launch: true,
    outputDir,
    runId: 'ios-contaminated',
    terminateBeforeLaunch: true,
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(calls.some((call) => call.includes('simctl terminate ')), false);
  assert.equal(calls.some((call) => call.includes('simctl launch ')), false);
  assert.equal(calls.some((call) => call.includes('simctl openurl ')), false);
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_simulator_launch_environment_contaminated'
        && check.metadata?.nextActionCode === 'clear_ios_simulator_launch_environment',
    ),
  );
  assert.match(
    fs.readFileSync(path.join(outputDir, 'raw', 'ios-launch-env-dyld-insert-libraries.txt'), 'utf8'),
    /libInjectedRunner/u,
  );
});

test('fails iOS capture when configured sibling bundle variants are installed', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-conflict-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.beta app': {
        stdout: '/tmp/ASLExampleMobileBeta.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.prod app': {
        exitCode: 1,
        stderr: 'An error was encountered processing the command',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    conflictingBundleIds: [
      'dev.agent-scenario-loop.example',
      'dev.agent-scenario-loop.beta',
      'dev.agent-scenario-loop.prod',
    ],
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-conflict',
      },
    ],
    executor,
    launch: true,
    outputDir,
    runId: 'ios-conflict',
    terminateBeforeLaunch: true,
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_conflicting_bundles_installed'
        && check.metadata?.nextActionCode === 'uninstall_ios_conflicting_bundles',
    ),
  );
  assert.equal(calls.some((call) => call.includes('simctl launch ')), false);
  assert.equal(calls.some((call) => call.includes('simctl openurl ')), false);
  assert.equal(calls.some((call) => call.includes('simctl terminate ')), false);
  assert.deepEqual((result.metadata.conflictingBundleIds as { installed: string[] }).installed, [
    'dev.agent-scenario-loop.beta',
  ]);
});

test('seeds profile-session AsyncStorage while preserving unrelated app keys', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({
    'agent-scenario-loop.profile-events.1': null,
    'unrelated.key': 'keep-me',
  }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1')), '[]', 'utf8');

  await seedProfileSessionStorage({
    bundleId: 'dev.agent-scenario-loop.example',
    commands: [
      { command: 'activate-target:example-card-1', dependsOnMilestones: ['surface_ready'], id: 'open-card' },
      { command: 'activate-target:close-card', id: 'close-card', stopOnFailure: false },
    ],
    dataContainer,
    runId: 'ios-live-startup',
    scenario: 'app-startup',
    startedAt: 123,
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
  const session = JSON.parse(manifest['agent-scenario-loop.profile-session.1']);
  const commands = JSON.parse(manifest['agent-scenario-loop.profile-commands.1']);

  assert.equal(manifest['unrelated.key'], 'keep-me');
  assert.equal(manifest['agent-scenario-loop.profile-events.1'], undefined);
  assert.equal(fs.existsSync(path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1'))), false);
  assert.deepEqual(session, {
    active: true,
    scenario: 'app-startup',
    runId: 'ios-live-startup',
    startedAt: 123,
  });
  assert.deepEqual(commands, [
    {
      id: 'open-card',
      scenario: 'app-startup',
      runId: 'ios-live-startup',
      command: 'activate-target:example-card-1',
      dependsOnMilestones: ['surface_ready'],
      timestamp: 124,
    },
    {
      id: 'close-card',
      scenario: 'app-startup',
      runId: 'ios-live-startup',
      command: 'activate-target:close-card',
      stopOnFailure: false,
      timestamp: 125,
    },
  ]);
});

test('seeds profile-session AsyncStorage with app-owned storage keys', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-custom-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.consumer',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({
    'consumer.profile-events.v1': null,
    'unrelated.key': 'keep-me',
  }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey('consumer.profile-events.v1')), '[]', 'utf8');

  await seedProfileSessionStorage({
    bundleId: 'dev.agent-scenario-loop.consumer',
    dataContainer,
    profileStorageKeys: {
      command: 'consumer.profile-commands.v1',
      event: 'consumer.profile-events.v1',
      session: 'consumer.profile-session.v1',
      sessionEntries: 'consumer.profile-session-entries.v1',
      signal: 'consumer.profile-signals.v1',
    },
    runId: 'consumer-ios-live-startup',
    scenario: 'app-startup',
    startedAt: 456,
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
  const session = JSON.parse(manifest['consumer.profile-session.v1']);

  assert.equal(manifest['unrelated.key'], 'keep-me');
  assert.equal(manifest['consumer.profile-events.v1'], undefined);
  assert.equal(manifest['agent-scenario-loop.profile-session.1'], undefined);
  assert.equal(fs.existsSync(path.join(storageDir, asyncStorageFileNameForKey('consumer.profile-events.v1'))), false);
  assert.deepEqual(session, {
    active: true,
    scenario: 'app-startup',
    runId: 'consumer-ios-live-startup',
    startedAt: 456,
  });
});

test('reads inline and spilled AsyncStorage profile event values', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-read-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  const eventKey = 'agent-scenario-loop.profile-events.1';
  const spilledValue = JSON.stringify([
    { event: 'home_ready', scenario: 'app-startup', runId: 'ios-live-startup', timestamp: 123 },
  ]);
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({ [eventKey]: null }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey(eventKey)), spilledValue, 'utf8');

  assert.equal(readAsyncStorageValueSync({ key: eventKey, storageDir }), spilledValue);
  assert.ok(formatStoredProfileEventLog(JSON.parse(spilledValue)).includes('[profile-event] {"event":"home_ready"'));
});

test('captures stored iOS profile events from app data container', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-storage-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-data-container-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data': {
        stdout: `${dataContainer}\n`,
      },
      'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stderr: 'Simulator device failed to terminate dev.agent-scenario-loop.example.\nfound nothing to terminate\n',
        exitCode: 3,
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const wait = async () => {
    const storageDir = resolveAsyncStorageDirectory({
      bundleId: 'dev.agent-scenario-loop.example',
      dataContainer,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
    manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify([
      {
        event: 'home_ready',
        scenario: 'app-startup',
        runId: 'ios-live-startup',
        timestamp: 123,
      },
    ]);
    fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    delay: wait,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    profileSessionStorage: {
      runId: 'ios-live-startup',
      scenario: 'app-startup',
      startedAt: 123,
    },
    runId: 'ios-live-startup',
    terminateBeforeLaunch: true,
    waitMs: 25,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(calls.indexOf('simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') < calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'));
  assert.ok(
    fs
      .readFileSync(path.join(outputDir, 'raw', 'ios-profile-events.log'), 'utf8')
      .includes('[profile-event] {"event":"home_ready"'),
  );
  const metadataText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8');
  const seedText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-seed.json'), 'utf8');
  assert.match(seedText, /ios-live-startup/u);
  assert.equal(metadataText.includes(dataContainer), false);
  assert.equal(seedText.includes(dataContainer), false);
});

test('captures stored iOS profile events from app-owned storage keys', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-storage-custom-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-data-container-custom-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
        stdout: '',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
        stdout: '',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.consumer app': {
        stdout: '/tmp/ASLConsumer.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.consumer data': {
        stdout: `${dataContainer}\n`,
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.consumer': {
        stdout: 'dev.agent-scenario-loop.consumer: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.consumer" AND eventMessage CONTAINS "1234"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
      'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.consumer': {
        stdout: '{"ApplicationState":"ForegroundRunning","Bundle":"dev.agent-scenario-loop.consumer"}\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
  const profileStorageKeys = {
    command: 'consumer.profile-commands.v1',
    event: 'consumer.profile-events.v1',
    session: 'consumer.profile-session.v1',
    sessionEntries: 'consumer.profile-session-entries.v1',
    signal: 'consumer.profile-signals.v1',
  };
  const wait = async () => {
    const storageDir = resolveAsyncStorageDirectory({
      bundleId: 'dev.agent-scenario-loop.consumer',
      dataContainer,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
    manifest['consumer.profile-events.v1'] = JSON.stringify([
      {
        event: 'app_first_usable_screen',
        scenario: 'app-startup',
        runId: 'consumer-ios-live-startup',
        timestamp: 789,
      },
    ]);
    fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.consumer',
    collectProfileStorage: true,
    delay: wait,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    profileSessionStorage: {
      runId: 'consumer-ios-live-startup',
      scenario: 'app-startup',
      startedAt: 456,
    },
    profileStorageKeys,
    runId: 'consumer-ios-live-startup',
    waitMs: 25,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(
    fs
      .readFileSync(path.join(outputDir, 'raw', 'ios-profile-events.log'), 'utf8')
      .includes('[profile-event] {"event":"app_first_usable_screen"'),
  );
  const seedText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-seed.json'), 'utf8');
  assert.match(seedText, /consumer-ios-live-startup/u);
  assert.equal(seedText.includes(dataContainer), false);
});
