const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { buildScenarioExecutionPlan } = require('../../core/execution-plan');
const { SCHEMAS, validateJson } = require('../../core/schema-validator');

type JsonRecord = Record<string, any>;

const fixtureDir = path.join(process.cwd(), 'runner', '__tests__', 'fixtures', 'external-adapter');
const pythonFixture = path.join(fixtureDir, 'adapter_fixture.py');
const nodeFixture = path.join(fixtureDir, 'replacement_adapter.cjs');
const runId = 'adapter-replacement-run';
const attemptId = 'adapter-replacement-attempt';

function at<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`missing item ${index}`);
  return value;
}

const scenario = {
  schemaVersion: '1.0.0',
  id: 'adapter-replacement-conformance',
  flowId: 'adapter-replacement-conformance',
  platforms: ['android'],
  requiredCapabilities: ['launch', 'command'],
  truthEvents: { ready: { event: 'app.ready', timeoutMs: 2500 } },
  steps: [
    { id: 'launch', kind: 'launch' },
    { id: 'tap-start', kind: 'gesture', driverAction: 'tap', selector: { kind: 'text', value: 'Start' } },
    { id: 'wait-ready', kind: 'waitForMilestone', milestone: 'ready', timeoutMs: 2500 },
    { id: 'capture', kind: 'captureEvidence', artifact: 'screenshot' },
  ],
};

function deadlineFor(seq: number): string {
  return `2026-06-19T12:00:${String(seq).padStart(2, '0')}.000Z`;
}

function request(seq: number, type: string, body: JsonRecord, includeIdentity = true): JsonRecord {
  return {
    protocolVersion: '1.0',
    seq,
    operationId: `op-${type}-${seq}`,
    kind: 'request',
    type,
    ...(includeIdentity ? { runId, attemptId } : {}),
    deadline: deadlineFor(seq),
    body,
  };
}

function buildRequests(): JsonRecord[] {
  const plan = buildScenarioExecutionPlan(scenario);
  const requests = [
    request(1, 'hello', {
      host: { name: 'agent-scenario-loop', version: '0.1.x' },
      platform: 'android',
    }, false),
    request(2, 'prepare', {
      artifactsRoot: `artifacts/asl/${runId}`,
      platform: 'android',
      target: { appId: 'dev.example.fixture' },
    }),
  ];

  for (const step of plan.steps) {
    if (step.kind === 'launch') {
      requests.push(request(requests.length + 1, 'launch', {
        platform: 'android', target: { appId: 'dev.example.fixture' },
      }));
    } else if (step.kind === 'gesture') {
      requests.push(request(requests.length + 1, 'executeAction', {
        driverAction: step.driverAction, selector: step.selector,
      }));
    } else if (step.kind === 'waitForMilestone') {
      const seq = requests.length + 1;
      requests.push(request(seq, 'waitCondition', {
        clockDomain: 'device-log',
        condition: { truthEvent: scenario.truthEvents.ready.event },
        deadline: deadlineFor(seq),
      }));
    } else if (step.kind === 'captureEvidence') {
      requests.push(request(requests.length + 1, 'captureEvidence', { kinds: [step.artifact] }));
    }
  }

  requests.push(request(requests.length + 1, 'stop', {}));
  requests.push(request(requests.length + 1, 'finalize', {}));
  return requests;
}

async function runAdapterProcess(
  command: string,
  args: string[],
  requests: Array<JsonRecord | string>,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  requests.forEach((message) => {
    child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  });
  child.stdin.end();

  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);
  return {
    exitCode,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

async function runAdapter(command: string, args: string[], requests: Array<JsonRecord | string>): Promise<JsonRecord[]> {
  const output = await runAdapterProcess(command, args, requests);
  assert.equal(output.exitCode, 0, output.stderr);
  assert.equal(output.stderr, '');
  return output.stdout.trim().split('\n')
    .map((line: string) => JSON.parse(line) as JsonRecord);
}

function resultOf(response: JsonRecord): JsonRecord {
  assert.equal(response.body?.ok, true, JSON.stringify(response.body?.failure));
  assert.ok(response.body.result && typeof response.body.result === 'object');
  return response.body.result;
}

function artifactKinds(result: JsonRecord): string[] {
  return (Array.isArray(result.artifacts) ? result.artifacts : [])
    .map((artifact: JsonRecord) => artifact.kind)
    .filter((kind: unknown): kind is string => typeof kind === 'string')
    .sort();
}

function assertArtifactReference(reference: JsonRecord): void {
  assert.equal(typeof reference.path, 'string');
  assert.equal(path.isAbsolute(reference.path), false);
  assert.equal(path.posix.normalize(reference.path), reference.path);
  assert.notEqual(reference.path, '..');
  assert.match(reference.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Number.isInteger(reference.sizeBytes), true);
  assert.ok(reference.sizeBytes >= 0);
  assert.equal('data' in reference, false);
  assert.equal('base64' in reference, false);
}

function assertAdapterConforms(requests: JsonRecord[], responses: JsonRecord[]): void {
  assert.equal(responses.length, requests.length);
  requests.forEach((source, index) => {
    const validation = validateJson(source, SCHEMAS.externalAdapterMessage, `request ${index + 1}`);
    assert.equal(validation.valid, true, validation.message);
  });
  responses.forEach((response, index) => {
    const validation = validateJson(response, SCHEMAS.externalAdapterMessage, `response ${index + 1}`);
    assert.equal(validation.valid, true, validation.message);
    const source = at(requests, index);
    assert.equal(response.protocolVersion, source.protocolVersion);
    assert.equal(response.seq, index + 1);
    assert.equal(response.kind, 'response');
    assert.equal(response.type, source.type);
    assert.equal(response.operationId, source.operationId);
    assert.equal(response.runId, source.runId);
    assert.equal(response.attemptId, source.attemptId);
    const result = resultOf(response);
    (Array.isArray(result.artifacts) ? result.artifacts : []).forEach(assertArtifactReference);

    if (source.type === 'executeAction') {
      assert.equal(result.driverAction, source.body.driverAction);
      assert.equal(result.status, 'completed');
      assertArtifactReference(result.raw);
    } else if (source.type === 'waitCondition') {
      assert.equal(source.body.deadline, source.deadline);
      assert.equal(result.matched, true);
      assert.equal(result.clockDomain, source.body.clockDomain);
      assert.equal(result.truthEvent?.name, source.body.condition.truthEvent);
      assert.equal(Number.isNaN(Date.parse(result.truthEvent?.observedAt)), false);
    } else if (source.type === 'captureEvidence') {
      const captured = artifactKinds(result);
      source.body.kinds.forEach((kind: string) => assert.ok(captured.includes(kind)));
    }
  });

  const hello = resultOf(at(responses, 0));
  assert.equal(hello.acceptedProtocolVersion, '1.0');
  assert.ok(hello.platforms.includes('android'));
  scenario.requiredCapabilities.forEach((capability) => assert.ok(hello.capabilities.includes(capability)));
  assert.ok(hello.driverActions.includes('tap'));
  assert.ok(hello.artifactOutputs.includes('screenshot'));
  assert.ok(hello.clockDomains.includes('device-log'));
}

function semanticOutcome(source: JsonRecord, response: JsonRecord): JsonRecord {
  const result = resultOf(response);
  let semanticResult: JsonRecord;
  switch (source.type) {
    case 'hello':
      semanticResult = {
        acceptedProtocolVersion: result.acceptedProtocolVersion,
        supportsPlatform: result.platforms.includes('android'),
        supportsCapabilities: scenario.requiredCapabilities.every((item) => result.capabilities.includes(item)),
        supportsAction: result.driverActions.includes('tap'),
        supportsArtifact: result.artifactOutputs.includes('screenshot'),
        supportsClock: result.clockDomains.includes('device-log'),
      };
      break;
    case 'prepare':
      semanticResult = { platform: result.platform };
      break;
    case 'launch':
      semanticResult = { status: result.status };
      break;
    case 'executeAction':
      semanticResult = { driverAction: result.driverAction, status: result.status };
      break;
    case 'waitCondition':
      semanticResult = {
        matched: result.matched,
        clockDomain: result.clockDomain,
        truthEvent: { name: result.truthEvent?.name },
      };
      break;
    case 'captureEvidence':
      semanticResult = {
        requestedKindsCaptured: source.body.kinds.every((kind: string) => artifactKinds(result).includes(kind)),
      };
      break;
    case 'stop':
    case 'finalize':
      semanticResult = { status: result.status };
      break;
    default:
      throw new Error(`unexpected response type ${response.type}`);
  }
  return {
    protocolVersion: response.protocolVersion,
    seq: response.seq,
    operationId: response.operationId,
    type: response.type,
    runId: response.runId,
    attemptId: response.attemptId,
    result: semanticResult,
  };
}

function semanticOutcomes(requests: JsonRecord[], responses: JsonRecord[]): JsonRecord[] {
  assert.equal(responses.length, requests.length);
  const requestIds = new Set(requests.map((source) => source.operationId));
  assert.equal(requestIds.size, requests.length);
  const responsesByOperationId = new Map<string, JsonRecord>();
  responses.forEach((response) => {
    assert.ok(requestIds.has(response.operationId));
    assert.equal(responsesByOperationId.has(response.operationId), false);
    responsesByOperationId.set(response.operationId, response);
  });
  return requests.map((source) => {
    const response = responsesByOperationId.get(source.operationId);
    if (response === undefined) throw new Error(`missing response ${source.operationId}`);
    return semanticOutcome(source, response);
  });
}

test('an unchanged scenario plan keeps semantic proof when the external adapter is replaced', async () => {
  const scenarioValidation = validateJson(scenario, SCHEMAS.scenario, scenario.id);
  assert.equal(scenarioValidation.valid, true, scenarioValidation.message);
  const requests = buildRequests();
  const python = await runAdapter('python3', [pythonFixture], requests);
  const node = await runAdapter(process.execPath, [nodeFixture], requests);

  assertAdapterConforms(requests, python);
  assertAdapterConforms(requests, node);
  assert.deepEqual(semanticOutcomes(requests, node), semanticOutcomes(requests, python));
});

test('replacement equivalence ignores additional optional evidence', async () => {
  const requests = buildRequests();
  const responses = await runAdapter(process.execPath, [nodeFixture], requests);
  const withAdditionalEvidence = structuredClone(responses);
  resultOf(at(withAdditionalEvidence, 5)).artifacts.push({
    kind: 'logs',
    path: 'node/optional.log',
    contentType: 'text/plain',
    sha256: '0'.repeat(64),
    sizeBytes: 0,
  });
  withAdditionalEvidence.reverse();

  assert.deepEqual(
    semanticOutcomes(requests, withAdditionalEvidence),
    semanticOutcomes(requests, responses),
  );
});

test('replacement equivalence rejects different required outcomes', async () => {
  const requests = buildRequests();
  const launched = await runAdapter(process.execPath, [nodeFixture], requests);
  const resumed = structuredClone(launched);
  resultOf(at(resumed, 2)).status = 'resumed';

  assertAdapterConforms(requests, launched);
  assertAdapterConforms(requests, resumed);
  assert.notDeepEqual(
    semanticOutcomes(requests, resumed),
    semanticOutcomes(requests, launched),
  );
});

test('replacement fixture stays an external adapter with no ASL source imports', async () => {
  const source = await fsp.readFile(nodeFixture, 'utf8');
  assert.doesNotMatch(source, /require\(['"].*(?:core|runner|dist|agent-scenario-loop)/u);
});

test('replacement fixture rejects invalid requests and cleanup order', async (t: import('node:test').TestContext) => {
  const cases: Array<[string, Array<JsonRecord | string>, string]> = [
    ['unsupported protocol', [
      { ...request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false), protocolVersion: '2.0' },
    ], 'unsupported_protocol'],
    ['unsupported platform', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'ios' }, false),
    ], 'unsupported_platform'],
    ['malformed hello', [
      request(1, 'hello', { platform: 'android' }, false),
    ], 'invalid_request'],
    ['prepare before hello', [
      request(1, 'prepare', { platform: 'android', target: { appId: 'test' } }),
    ], 'hello_required'],
    ['hello after negotiation', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
    ], 'hello_already_completed'],
    ['malformed prepare target', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'prepare', { platform: 'android', target: {} }),
    ], 'invalid_request'],
    ['malformed launch target', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'prepare', { platform: 'android', target: { appId: 'test' } }),
      request(3, 'launch', { platform: 'android', target: {} }),
    ], 'invalid_request'],
    ['expired deadline', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      { ...request(2, 'prepare', { platform: 'android', target: { appId: 'test' } }), deadline: '2026-06-19T12:00:00.000Z' },
    ], 'deadline_expired'],
    ['malformed deadline', [
      { ...request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false), deadline: 'invalid' },
    ], 'invalid_deadline'],
    ['non-monotonic host sequence', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(3, 'stop', {}),
    ], 'invalid_sequence'],
    ['launch before prepare', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'launch', { platform: 'android', target: { appId: 'test' } }),
    ], 'not_prepared'],
    ['platform drift after prepare', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'prepare', { platform: 'android', target: { appId: 'test' } }),
      request(3, 'launch', { platform: 'ios', target: { appId: 'test' } }),
    ], 'unsupported_platform'],
    ['stop before launch', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'stop', {}),
    ], 'not_launched'],
    ['repeated finalization', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'finalize', {}),
      request(3, 'finalize', {}),
    ], 'already_finalized'],
    ['operation after finalization', [
      request(1, 'hello', { host: { name: 'test', version: '1' }, platform: 'android' }, false),
      request(2, 'finalize', {}),
      request(3, 'executeAction', { driverAction: 'tap' }),
    ], 'already_finalized'],
  ];

  for (const [name, requests, expectedCode] of cases) {
    await t.test(name, async () => {
      const responses = await runAdapter(process.execPath, [nodeFixture], requests);
      responses.forEach((response, index) => {
        const validation = validateJson(response, SCHEMAS.externalAdapterMessage, `${name} response ${index + 1}`);
        assert.equal(validation.valid, true, validation.message);
      });
      assert.equal(at(responses, responses.length - 1).body?.failure?.code, expectedCode);
    });
  }
});

test('replacement fixture fails the process on uncorrelatable input without emitting a protocol message', async (t: import('node:test').TestContext) => {
  const cases = ['{', '{}', 'null', JSON.stringify({ operationId: 'op', type: 'unknown' })];
  for (const input of cases) {
    await t.test(input, async () => {
      const output = await runAdapterProcess(process.execPath, [nodeFixture], [input]);
      assert.equal(output.exitCode, 1);
      assert.equal(output.stdout, '');
      assert.match(output.stderr, /^invalid adapter input\n$/u);
    });
  }
});

test('adapter replacement proof rejects false equivalence', async (t: import('node:test').TestContext) => {
  const requests = buildRequests();
  const valid = await runAdapter(process.execPath, [nodeFixture], requests);
  const cases: Array<[string, (responses: JsonRecord[]) => void]> = [
    ['platform', (responses) => { resultOf(at(responses, 0)).platforms = ['ios']; }],
    ['capability', (responses) => { resultOf(at(responses, 0)).capabilities = ['launch']; }],
    ['driver action inventory', (responses) => { resultOf(at(responses, 0)).driverActions = []; }],
    ['artifact inventory', (responses) => { resultOf(at(responses, 0)).artifactOutputs = []; }],
    ['clock inventory', (responses) => { resultOf(at(responses, 0)).clockDomains = []; }],
    ['accepted protocol version', (responses) => { resultOf(at(responses, 0)).acceptedProtocolVersion = '2.0'; }],
    ['protocol version', (responses) => { at(responses, 1).protocolVersion = '2.0'; }],
    ['sequence', (responses) => { at(responses, 1).seq = 1; }],
    ['operation identity', (responses) => { at(responses, 1).operationId = 'wrong'; }],
    ['run identity', (responses) => { at(responses, 1).runId = 'wrong'; }],
    ['attempt identity', (responses) => { at(responses, 1).attemptId = 'wrong'; }],
    ['action result', (responses) => { resultOf(at(responses, 3)).driverAction = 'pressKey'; }],
    ['wait clock', (responses) => { resultOf(at(responses, 4)).clockDomain = 'host-monotonic'; }],
    ['truth event', (responses) => { resultOf(at(responses, 4)).truthEvent.name = 'wrong'; }],
    ['truth timestamp', (responses) => { resultOf(at(responses, 4)).truthEvent.observedAt = 'invalid'; }],
    ['evidence kinds', (responses) => {
      at<JsonRecord>(resultOf(at(responses, 5)).artifacts, 0).kind = 'logs';
    }],
    ['artifact path', (responses) => {
      at<JsonRecord>(resultOf(at(responses, 5)).artifacts, 0).path = '/tmp/evidence.png';
    }],
    ['artifact traversal', (responses) => {
      at<JsonRecord>(resultOf(at(responses, 5)).artifacts, 0).path = 'node/../../outside.png';
    }],
    ['artifact integrity', (responses) => {
      at<JsonRecord>(resultOf(at(responses, 5)).artifacts, 0).sha256 = 'invalid';
    }],
    ['embedded evidence', (responses) => {
      at<JsonRecord>(resultOf(at(responses, 5)).artifacts, 0).base64 = 'bytes';
    }],
    ['raw reference', (responses) => { delete resultOf(at(responses, 3)).raw.path; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const corrupted = structuredClone(valid);
      mutate(corrupted);
      assert.throws(() => assertAdapterConforms(requests, corrupted));
    });
  }
});
