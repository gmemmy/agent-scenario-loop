const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { SCHEMAS, validateJson } = require('../../core/schema-validator');

type TranscriptEntry = {
  direction: 'host' | 'adapter';
  message: Record<string, unknown>;
};

const fixtureDir = path.join(process.cwd(), 'runner', '__tests__', 'fixtures', 'external-adapter');
const fixturePath = path.join(fixtureDir, 'adapter_fixture.py');

async function readTranscript(fileName: string): Promise<TranscriptEntry[]> {
  const content = await fsp.readFile(path.join(fixtureDir, fileName), 'utf8');
  return content
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line) as TranscriptEntry);
}

async function runFixture(hostMessages: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const child = spawn('python3', [fixturePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  for (const message of hostMessages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, '');

  const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
  return stdout.split('\n').map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

function messagesByDirection(transcript: TranscriptEntry[], direction: TranscriptEntry['direction']) {
  return transcript.filter((entry) => entry.direction === direction).map((entry) => entry.message);
}

function assertValidProtocolMessage(message: Record<string, unknown>, label: string): void {
  const result = validateJson(message, SCHEMAS.externalAdapterMessage, label);
  assert.equal(result.valid, true, result.message);
}

function assertValidTranscript(transcript: TranscriptEntry[], label: string): void {
  transcript.forEach((entry, index) => {
    assertValidProtocolMessage(entry.message, `${label} line ${index + 1} ${entry.direction} message`);
  });
}

function assertMonotonicSenderSequences(transcript: TranscriptEntry[], label: string): void {
  const lastSeqByDirection = new Map<TranscriptEntry['direction'], number>();
  for (const [index, entry] of transcript.entries()) {
    const seq = entry.message.seq;
    assert.equal(typeof seq, 'number', `${label} line ${index + 1} is missing numeric seq`);
    const numericSeq = seq as number;
    const previousSeq = lastSeqByDirection.get(entry.direction) ?? 0;
    assert.equal(numericSeq, previousSeq + 1, `${label} line ${index + 1} has non-monotonic ${entry.direction} seq`);
    lastSeqByDirection.set(entry.direction, numericSeq);
  }
}

function assertValidMessages(messages: Record<string, unknown>[], label: string): void {
  messages.forEach((message, index) => {
    assertValidProtocolMessage(message, `${label} message ${index + 1}`);
  });
}

function assertNoEmbeddedEvidenceBytes(message: Record<string, any>): void {
  const serialized = JSON.stringify(message);
  assert.doesNotMatch(serialized, /"data"\s*:/u, 'protocol messages must not embed raw evidence bytes');
  assert.doesNotMatch(serialized, /"base64"\s*:/u, 'protocol messages must not embed base64 evidence');
}

function getResultArtifacts(message: Record<string, any>): Record<string, unknown>[] {
  return Array.isArray(message.body?.result?.artifacts) ? message.body.result.artifacts : [];
}

function findResultByType(messages: Record<string, unknown>[], type: string): Record<string, unknown> {
  const message = messages.find((candidate) => candidate.type === type) as Record<string, any> | undefined;
  const result = message?.body?.result;
  assert.ok(result !== null && typeof result === 'object', `missing ${type} result`);
  return result;
}

function assertArtifactReference(artifact: Record<string, any>): void {
  assert.equal(typeof artifact.path, 'string');
  assert.notEqual(artifact.path, '');
  assert.equal(typeof artifact.contentType, 'string');
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(typeof artifact.sizeBytes, 'number');
  assert.ok(artifact.sizeBytes >= 0);
  assert.equal('data' in artifact, false, 'artifact references must not embed evidence bytes');
  assert.equal('base64' in artifact, false, 'artifact references must not embed base64 evidence');
}

test('external adapter fixture matches the golden success protocol transcript', async () => {
  const transcript = await readTranscript('golden-success.jsonl');
  assertValidTranscript(transcript, 'golden-success.jsonl');
  assertMonotonicSenderSequences(transcript, 'golden-success.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture success stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
});

test('external adapter fixture reports artifact references with integrity metadata', async () => {
  const transcript = await readTranscript('golden-success.jsonl');
  const actual = await runFixture(messagesByDirection(transcript, 'host'));

  const artifactRefs = actual.flatMap(getResultArtifacts);
  const rawRefs = actual
    .map((message: Record<string, any>) => message.body?.result?.raw)
    .filter((raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object');

  assert.ok(artifactRefs.length >= 1);
  [...artifactRefs, ...rawRefs].forEach(assertArtifactReference);
  actual.forEach(assertNoEmbeddedEvidenceBytes);
});

test('external adapter fixture returns structured failures for unsupported actions', async () => {
  const transcript = await readTranscript('golden-failure.jsonl');
  assertValidTranscript(transcript, 'golden-failure.jsonl');
  assertMonotonicSenderSequences(transcript, 'golden-failure.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture failure stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
  assert.deepEqual(actual[1]?.body, {
    ok: false,
    failure: {
      category: 'unsupported',
      code: 'unsupported_action',
      message: 'driverAction `pinch` is not supported',
      retryable: false,
      details: {
        driverAction: 'pinch',
      },
    },
  });
  assert.equal(actual[1]?.operationId, 'op-unsupported-action');
  assert.equal(actual[1]?.runId, 'run-001');
  assert.equal(actual[1]?.attemptId, 'attempt-001');
  assert.equal((actual[1] as Record<string, any>).body?.ok, false);
  assert.equal('result' in ((actual[1] as Record<string, any>).body ?? {}), false);
});

test('external adapter fixture classifies expired deadlines as retryable failures', async () => {
  const transcript = await readTranscript('golden-deadline.jsonl');
  assertValidTranscript(transcript, 'golden-deadline.jsonl');
  assertMonotonicSenderSequences(transcript, 'golden-deadline.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture deadline stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
  assert.deepEqual(actual[1]?.body, {
    ok: false,
    failure: {
      category: 'deadline',
      code: 'deadline_expired',
      message: 'operation deadline expired before adapter work started',
      retryable: true,
      details: {
        clockDomain: 'host-monotonic',
        deadline: '2026-06-19T11:59:59.000Z',
      },
    },
  });
});

test('external adapter fixture classifies non-monotonic host sequence as protocol failure', async () => {
  const actual = await runFixture([
    {
      protocolVersion: '1.0',
      seq: 1,
      operationId: 'op-hello',
      kind: 'request',
      type: 'hello',
      deadline: '2026-06-19T12:00:01.000Z',
      body: {
        host: {
          name: 'agent-scenario-loop',
          version: '0.1.x',
        },
        platform: 'android',
      },
    },
    {
      protocolVersion: '1.0',
      seq: 1,
      operationId: 'op-repeated-seq',
      kind: 'request',
      type: 'prepare',
      runId: 'run-001',
      attemptId: 'attempt-001',
      deadline: '2026-06-19T12:00:02.000Z',
      body: {
        artifactsRoot: 'artifacts/asl/run-001',
        platform: 'android',
        target: {
          appId: 'dev.example.fixture',
        },
      },
    },
  ]);

  assertValidMessages(actual, 'fixture non-monotonic host sequence stdout');
  assert.deepEqual(actual[1]?.body, {
    ok: false,
    failure: {
      category: 'protocol',
      code: 'invalid_sequence',
      message: 'host seq must increase by exactly one',
      retryable: false,
      details: {
        actualSeq: 1,
        expectedSeq: 2,
      },
    },
  });
  assert.equal(actual[1]?.operationId, 'op-repeated-seq');
});

test('external adapter fixture classifies cleanup and finalization invariants', async () => {
  const transcript = await readTranscript('golden-cleanup.jsonl');
  assertValidTranscript(transcript, 'golden-cleanup.jsonl');
  assertMonotonicSenderSequences(transcript, 'golden-cleanup.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture cleanup stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
  assert.deepEqual(actual[1]?.body, {
    ok: false,
    failure: {
      category: 'cleanup',
      code: 'not_launched',
      message: 'stop requires an active launched target',
      retryable: false,
      details: {
        cleanupStatus: 'not-required',
        operation: 'stop',
      },
    },
  });
  assert.equal((actual[2] as Record<string, any>)?.body?.result?.status, 'finalized');
  assert.deepEqual(actual[3]?.body, {
    ok: false,
    failure: {
      category: 'cleanup',
      code: 'already_finalized',
      message: 'adapter has already finalized this attempt',
      retryable: false,
      details: {
        cleanupStatus: 'passed',
        operation: 'finalize',
      },
    },
  });
});

test('external adapter fixture keeps cancellation and finalization explicit', async () => {
  const transcript = await readTranscript('golden-success.jsonl');
  const actual = await runFixture(messagesByDirection(transcript, 'host'));

  const cancel = actual.find((message) => message.type === 'cancel') as Record<string, any> | undefined;
  const finalize = actual.find((message) => message.type === 'finalize') as Record<string, any> | undefined;

  assert.equal(cancel?.body?.ok, true);
  assert.deepEqual(cancel?.body?.result, {
    reason: 'conformance cancellation check',
    status: 'not-running',
    targetOperationId: 'op-not-running',
  });
  assert.equal(finalize?.body?.ok, true);
  assert.equal(finalize?.body?.result?.status, 'finalized');
  assert.equal(finalize?.body?.result?.adapter?.name, 'asl-python-conformance-fixture');
  assert.ok(Array.isArray(finalize?.body?.result?.artifacts));
});

test('external adapter fixture records active cancellation before cleanup', async () => {
  const transcript = await readTranscript('golden-cancel.jsonl');
  assertValidTranscript(transcript, 'golden-cancel.jsonl');
  assertMonotonicSenderSequences(transcript, 'golden-cancel.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture cancel stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
  const cancelResult = findResultByType(actual, 'cancel');
  const stopResult = findResultByType(actual, 'stop');
  const finalizeResult = findResultByType(actual, 'finalize');

  assert.deepEqual(cancelResult, {
    reason: 'conformance active cancellation check',
    status: 'cancelled',
    targetOperationId: 'op-active-action',
  });
  assert.equal(stopResult.status, 'stopped');
  assert.equal(stopResult.cleanupStatus, 'partial');
  assert.equal(finalizeResult.status, 'finalized');
});

test('external adapter conformance fixture is out-of-process and imports no ASL TypeScript', async () => {
  const source = await fsp.readFile(fixturePath, 'utf8');

  assert.match(source, /^#!\/usr\/bin\/env python3/u);
  assert.doesNotMatch(source, /require\(|from ['"].*(?:core|runner|index|dist)/u);
  assert.doesNotMatch(source, /agent-scenario-loop|\.ts/u);
});

test('external adapter schema rejects malformed protocol messages', () => {
  const result = validateJson(
    {
      protocolVersion: '1.0',
      seq: 1,
      operationId: 'op-malformed',
      kind: 'request',
      type: 'executeAction',
      runId: 'run-001',
      attemptId: 'attempt-001',
      deadline: '2026-06-19T12:00:02.000Z',
      body: {
        selector: {
          kind: 'text',
          value: 'Start',
        },
      },
    },
    SCHEMAS.externalAdapterMessage,
    'Malformed executeAction request',
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: { path: string }) => error.path === '$.body.driverAction'), result.message);
});

test('external adapter schema rejects malformed failure bodies', () => {
  const result = validateJson(
    {
      protocolVersion: '1.0',
      seq: 2,
      operationId: 'op-unsupported-action',
      kind: 'response',
      type: 'executeAction',
      runId: 'run-001',
      attemptId: 'attempt-001',
      body: {
        ok: false,
        failure: {
          code: 'unsupported_action',
          message: 'driverAction `pinch` is not supported',
        },
      },
    },
    SCHEMAS.externalAdapterMessage,
    'Malformed failure response',
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: { path: string }) => error.path === '$.body.failure.retryable'), result.message);
});

test('external adapter schema accepts structured failure categories', () => {
  const result = validateJson(
    {
      protocolVersion: '1.0',
      seq: 2,
      operationId: 'op-expired-prepare',
      kind: 'response',
      type: 'prepare',
      runId: 'run-001',
      attemptId: 'attempt-001',
      body: {
        ok: false,
        failure: {
          category: 'deadline',
          code: 'deadline_expired',
          message: 'operation deadline expired before adapter work started',
          retryable: true,
          details: {
            clockDomain: 'host-monotonic',
            deadline: '2026-06-19T11:59:59.000Z',
          },
        },
      },
    },
    SCHEMAS.externalAdapterMessage,
    'Structured deadline failure response',
  );

  assert.equal(result.valid, true, result.message);
});

test('external adapter schema rejects malformed artifact integrity', () => {
  const result = validateJson(
    {
      protocolVersion: '1.0',
      seq: 1,
      operationId: 'op-capture',
      kind: 'response',
      type: 'captureEvidence',
      runId: 'run-001',
      attemptId: 'attempt-001',
      body: {
        ok: true,
        result: {
          artifacts: [
            {
              kind: 'screenshot',
              path: 'captures/final-screen.png',
              contentType: 'image/png',
              sha256: 'not-a-sha',
              sizeBytes: -1,
            },
          ],
        },
      },
    },
    SCHEMAS.externalAdapterMessage,
    'Malformed artifact integrity',
  );

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: { path: string }) => error.path === '$.body.result.artifacts[0].sha256'), result.message);
  assert.ok(result.errors.some((error: { path: string }) => error.path === '$.body.result.artifacts[0].sizeBytes'), result.message);
});
