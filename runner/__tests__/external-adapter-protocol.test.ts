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

function assertValidMessages(messages: Record<string, unknown>[], label: string): void {
  messages.forEach((message, index) => {
    assertValidProtocolMessage(message, `${label} message ${index + 1}`);
  });
}

test('external adapter fixture matches the golden success protocol transcript', async () => {
  const transcript = await readTranscript('golden-success.jsonl');
  assertValidTranscript(transcript, 'golden-success.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture success stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
});

test('external adapter fixture returns structured failures for unsupported actions', async () => {
  const transcript = await readTranscript('golden-failure.jsonl');
  assertValidTranscript(transcript, 'golden-failure.jsonl');

  const actual = await runFixture(messagesByDirection(transcript, 'host'));
  assertValidMessages(actual, 'fixture failure stdout');

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
  assert.deepEqual(actual[1]?.body, {
    ok: false,
    failure: {
      code: 'unsupported_action',
      message: 'driverAction `pinch` is not supported',
      retryable: false,
      details: {
        driverAction: 'pinch',
      },
    },
  });
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
