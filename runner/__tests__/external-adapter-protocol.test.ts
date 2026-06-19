const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

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

test('external adapter fixture matches the golden success protocol transcript', async () => {
  const transcript = await readTranscript('golden-success.jsonl');
  const actual = await runFixture(messagesByDirection(transcript, 'host'));

  assert.deepEqual(actual, messagesByDirection(transcript, 'adapter'));
});

test('external adapter fixture returns structured failures for unsupported actions', async () => {
  const transcript = await readTranscript('golden-failure.jsonl');
  const actual = await runFixture(messagesByDirection(transcript, 'host'));

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
