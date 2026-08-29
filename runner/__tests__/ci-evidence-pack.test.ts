import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  parseCiEvidencePackCliArgs,
  readCiEvidencePackAssembleRequest,
  runCiEvidencePackCli,
  usage,
  writeFileAtomically,
  type FileSystemPort,
} from '../ci-evidence-pack';
import { readCiEvidencePack } from '../../core/ci-evidence-pack';
import {
  evaluateCiEvidencePublicationSummary,
  renderCiEvidencePublicationSummary,
} from '../../core/ci-evidence-publication-summary';
import type { CiEvidencePack, CiEvidencePackBuildInput } from '../../core/ci-evidence-pack';
import {
  buildCiEvidencePublicationReceipt,
  readCiEvidencePublicationReceipt,
  type CiEvidencePublicationReceipt,
  type CiEvidencePublicationReceiptFacts,
} from '../../core/ci-evidence-publication-receipt';

const SOURCE_SHA = '3530469c658db8182a5dca6ae933e66ce67bd8c8';
const tempRoots: string[] = [];
type LiveProofStatus = 'passed' | 'failed';

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-ci-evidence-pack-cli-'));
  tempRoots.push(dir);
  return dir;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(filePath: string, value: unknown): Buffer {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.writeFileSync(filePath, bytes);
  return bytes;
}

function captureIo(): {
  stdout: NodeJS.WritableStream & { text: () => string };
  stderr: NodeJS.WritableStream & { text: () => string };
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
      text: () => stdout,
    } as NodeJS.WritableStream & { text: () => string },
    stderr: {
      write(chunk: string | Uint8Array) {
        stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      },
      text: () => stderr,
    } as NodeJS.WritableStream & { text: () => string },
  };
}

function writeContainedFile(root: string, relative: string, contents: string): { relativePath: string; sha256: string; byteSize: number } {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from(contents, 'utf8');
  fs.writeFileSync(filePath, bytes);
  return { relativePath: relative, sha256: sha256(bytes), byteSize: bytes.byteLength };
}

const NONE_ACTION = { code: 'none' as const, summary: 'No action required.' };
const STARTED_AT = '2026-08-22T00:00:00.000Z';

function proofPointer(platform: 'android' | 'ios', runId: string) {
  return {
    filePath: `proofs/${platform}.json`,
    platform,
    runId,
    status: 'passed' as const,
    summaryPath: `summaries/${platform}.json`,
    comparisonStatus: 'not_compared' as const,
    profileCount: 0,
    interactionProofCount: 0,
    interactionWarningCount: 0,
    nextAction: NONE_ACTION,
  };
}

function buildLiveProofSet(
  artifactRoot: string,
  options: { includeAndroid?: boolean; status?: LiveProofStatus } = {},
) {
  const includeAndroid = options.includeAndroid !== false;
  const status = options.status ?? 'passed';
  const androidRecording = includeAndroid
    ? writeContainedFile(artifactRoot, 'runs/run-android/recording.json', '{"kind":"recording","platform":"android"}\n')
    : { relativePath: 'runs/run-android/recording.json', sha256: '0'.repeat(64), byteSize: 0 };
  const androidVerdict = includeAndroid
    ? writeContainedFile(artifactRoot, 'runs/run-android/verdict.json', '{"kind":"verdict","status":"failed"}\n')
    : { relativePath: 'runs/run-android/verdict.json', sha256: '0'.repeat(64), byteSize: 0 };
  const iosRecording = writeContainedFile(artifactRoot, 'runs/run-ios/recording.json', '{"kind":"recording","platform":"ios"}\n');
  const iosVerdict = writeContainedFile(artifactRoot, 'runs/run-ios/verdict.json', '{"kind":"verdict","status":"failed"}\n');
  if (includeAndroid) {
    writeContainedFile(artifactRoot, 'proofs/android.json', '{"platform":"android"}\n');
    writeContainedFile(artifactRoot, 'summaries/android.json', '{"platform":"android"}\n');
  }
  writeContainedFile(artifactRoot, 'proofs/ios.json', '{"platform":"ios"}\n');
  writeContainedFile(artifactRoot, 'summaries/ios.json', '{"platform":"ios"}\n');

  const proofs = includeAndroid
    ? [proofPointer('android', 'run-android'), proofPointer('ios', 'run-ios')]
    : [proofPointer('ios', 'run-ios')];
  const presentPlatforms = includeAndroid ? ['android', 'ios'] : ['ios'];
  const missingPlatforms = includeAndroid ? [] : ['android'];
  const liveProofSet = {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    status,
    proofCount: proofs.length,
    requiredPlatforms: ['android', 'ios'],
    presentPlatforms,
    missingPlatforms,
    failureReasons: [] as string[],
    summary: includeAndroid
      ? 'Android and iOS live proofs assembled.'
      : 'iOS live proof assembled; Android is unsupported.',
    nextAction: NONE_ACTION,
    proofs,
  };
  const relativePath = 'live-proof-set.json';
  const bytes = writeJson(path.join(artifactRoot, relativePath), liveProofSet);
  return {
    relativePath,
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
    runId: 'run-1' as const,
    status,
    files: { androidRecording, androidVerdict, iosRecording, iosVerdict },
    liveProofSet,
  };
}

function evidenceRecord(
  evidenceId: string,
  kind: 'recording' | 'verdict',
  attemptId: string,
  platform: 'android' | 'ios',
  file: { relativePath: string; sha256: string; byteSize: number },
) {
  return {
    evidenceId,
    attemptId,
    platform,
    kind,
    status: 'present' as const,
    relativePath: file.relativePath,
    sha256: file.sha256,
    byteSize: file.byteSize,
  };
}

function attemptRecord(
  attemptId: string,
  platform: 'android' | 'ios',
  runId: string,
  recordingId: string,
  verdictId: string,
) {
  return {
    attemptId,
    scenarioId: `scenario-${platform}`,
    platform,
    runId,
    status: 'passed' as const,
    attemptNumber: 1,
    maxAttempts: 1,
    startedAt: STARTED_AT,
    evidenceIds: [recordingId, verdictId],
  };
}

function buildInput(
  live: ReturnType<typeof buildLiveProofSet>,
  overrides: Partial<CiEvidencePackBuildInput> = {},
): CiEvidencePackBuildInput {
  const androidAttempt = attemptRecord(
    'attempt-android',
    'android',
    'run-android',
    'ev-android-recording',
    'ev-android-verdict',
  );
  const iosAttempt = attemptRecord('attempt-ios', 'ios', 'run-ios', 'ev-ios-recording', 'ev-ios-verdict');
  return {
    schemaVersion: '1.0.0',
    packId: 'pack-1',
    createdAt: '2026-08-22T01:00:00.000Z',
    source: {
      expectedSha: SOURCE_SHA,
      observedSha: SOURCE_SHA,
      status: 'current',
    },
    liveProofSet: {
      relativePath: live.relativePath,
      sha256: live.sha256,
      byteSize: live.byteSize,
      runId: live.runId,
      status: live.status,
    },
    requiredPlatforms: ['android', 'ios'],
    requiredEvidenceKinds: ['recording', 'verdict'],
    platforms: [
      {
        platform: 'android',
        authorityStatus: 'supported',
        evaluationStatus: 'passed',
        selectedAttemptId: 'attempt-android',
      },
      {
        platform: 'ios',
        authorityStatus: 'supported',
        evaluationStatus: 'passed',
        selectedAttemptId: 'attempt-ios',
      },
    ],
    attempts: [androidAttempt, iosAttempt],
    evidence: [
      evidenceRecord('ev-android-recording', 'recording', 'attempt-android', 'android', live.files.androidRecording),
      evidenceRecord('ev-android-verdict', 'verdict', 'attempt-android', 'android', live.files.androidVerdict),
      evidenceRecord('ev-ios-recording', 'recording', 'attempt-ios', 'ios', live.files.iosRecording),
      evidenceRecord('ev-ios-verdict', 'verdict', 'attempt-ios', 'ios', live.files.iosVerdict),
    ],
    verdicts: [
      {
        scenarioId: 'scenario-android',
        runId: 'run-android',
        platform: 'android',
        status: 'failed',
        evidenceId: 'ev-android-verdict',
      },
      {
        scenarioId: 'scenario-ios',
        runId: 'run-ios',
        platform: 'ios',
        status: 'failed',
        evidenceId: 'ev-ios-verdict',
      },
    ],
    comparisonStatus: 'comparable',
    completeness: { status: 'complete', reasons: [] },
    assembly: { status: 'succeeded', reasons: [] },
    summary: 'Android and iOS live proofs assembled.',
    nextAction: 'No action required.',
    ...overrides,
  };
}

function writeRequest(dir: string, artifactRoot: string, outDir: string, input: unknown): string {
  const requestPath = path.join(dir, 'request.json');
  writeJson(requestPath, { artifactRoot, outDir, input });
  return requestPath;
}

async function runCli(argv: string[], options?: { fs?: FileSystemPort }) {
  const io = captureIo();
  const code = await runCiEvidencePackCli(['node', 'asl-ci-evidence-pack', ...argv], io, options?.fs);
  return { code, stdout: io.stdout.text(), stderr: io.stderr.text() };
}

function testFileSystemPort(overrides: Partial<FileSystemPort> = {}): FileSystemPort {
  return {
    readFileSync: (filePath) => fs.readFileSync(filePath),
    writeFileSync: (filePath, contents) => {
      fs.writeFileSync(filePath, contents);
    },
    mkdirSync: (dirPath, mkdirOptions) => {
      fs.mkdirSync(dirPath, mkdirOptions);
    },
    renameSync: (from, to) => {
      fs.renameSync(from, to);
    },
    unlinkSync: (filePath) => {
      fs.unlinkSync(filePath);
    },
    ...overrides,
  };
}

function parseStdout(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function assertNoCanonicalPack(outDir: string): void {
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-pack.json')), false);
}

function assertCanonicalPackReadable(outDir: string) {
  const packPath = path.join(outDir, 'ci-evidence-pack.json');
  assert.equal(fs.existsSync(packPath), true);
  return readCiEvidencePack(packPath);
}

test('assemble success writes pack, returns 0, and leaves product verdicts failed', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const requestPath = writeRequest(root, artifactRoot, outDir, buildInput(live));
  const result = await runCli(['assemble', '--request', requestPath]);
  assert.equal(result.code, 0);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'passed');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  assert.equal(stdout.twoPlatformClaimStatus, 'passed');
  assert.equal(typeof stdout.artifact, 'string');
  const packPath = path.join(outDir, 'ci-evidence-pack.json');
  assert.equal(stdout.artifact, packPath);
  assert.equal(fs.existsSync(packPath), true);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-receipt.json')), false);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);
  const pack = readCiEvidencePack(packPath);
  assert.equal(pack.mechanismStatus, 'succeeded');
  assert.equal(pack.twoPlatformClaim.status, 'passed');
  assert.equal(pack.verdicts.every((verdict) => verdict.status === 'failed'), true);
});

test('missing selected Android recording writes valid pack with twoPlatformClaim failed and product verdicts failed', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const input = buildInput(live, {
    attempts: [
      {
        attemptId: 'attempt-android',
        scenarioId: 'scenario-android',
        platform: 'android',
        runId: 'run-android',
        status: 'passed',
        attemptNumber: 1,
        maxAttempts: 1,
        startedAt: STARTED_AT,
        evidenceIds: ['ev-android-verdict'],
      },
      attemptRecord('attempt-ios', 'ios', 'run-ios', 'ev-ios-recording', 'ev-ios-verdict'),
    ],
    evidence: [
      evidenceRecord('ev-android-verdict', 'verdict', 'attempt-android', 'android', live.files.androidVerdict),
      evidenceRecord('ev-ios-recording', 'recording', 'attempt-ios', 'ios', live.files.iosRecording),
      evidenceRecord('ev-ios-verdict', 'verdict', 'attempt-ios', 'ios', live.files.iosVerdict),
    ],
  });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'failed');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  assert.equal(stdout.twoPlatformClaimStatus, 'failed');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(pack.mechanismStatus, 'succeeded');
  assert.equal(pack.twoPlatformClaim.status, 'failed');
  assert.deepEqual(pack.twoPlatformClaim.reasons, [
    'required recording evidence missing/invalid/rejected for attempt-android',
  ]);
  assert.equal(pack.verdicts.every((verdict) => verdict.status === 'failed'), true);
});

test('unsupported selected platform produces not_evaluable and never not_applicable', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot, { includeAndroid: false });
  assert.equal(fs.existsSync(path.join(artifactRoot, 'proofs/android.json')), false);
  assert.equal(fs.existsSync(path.join(artifactRoot, 'summaries/android.json')), false);
  assert.equal(fs.existsSync(path.join(artifactRoot, 'runs/run-android/recording.json')), false);
  assert.equal(fs.existsSync(path.join(artifactRoot, 'runs/run-android/verdict.json')), false);
  const input = buildInput(live, {
    platforms: [
      {
        platform: 'android',
        authorityStatus: 'unsupported',
        evaluationStatus: 'not_evaluable',
      },
      {
        platform: 'ios',
        authorityStatus: 'supported',
        evaluationStatus: 'passed',
        selectedAttemptId: 'attempt-ios',
      },
    ],
    attempts: [attemptRecord('attempt-ios', 'ios', 'run-ios', 'ev-ios-recording', 'ev-ios-verdict')],
    evidence: [
      evidenceRecord('ev-ios-recording', 'recording', 'attempt-ios', 'ios', live.files.iosRecording),
      evidenceRecord('ev-ios-verdict', 'verdict', 'attempt-ios', 'ios', live.files.iosVerdict),
    ],
    verdicts: [
      {
        scenarioId: 'scenario-ios',
        runId: 'run-ios',
        platform: 'ios',
        status: 'failed',
        evidenceId: 'ev-ios-verdict',
      },
    ],
  });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'failed');
  assert.equal(stdout.twoPlatformClaimStatus, 'not_evaluable');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(stdout.mechanismStatus, pack.mechanismStatus);
  const android = pack.platforms.find((entry) => entry.platform === 'android');
  assert.ok(android);
  assert.equal(android.authorityStatus, 'unsupported');
  assert.equal(android.evaluationStatus, 'not_evaluable');
  assert.equal('selectedAttemptId' in android, false);
  assert.equal(pack.twoPlatformClaim.status, 'not_evaluable');
  const serialized = JSON.stringify(pack);
  assert.equal(serialized.includes('not_applicable'), false);
});

test('stale source writes canonical pack and returns 1', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const input = buildInput(live, {
    source: {
      expectedSha: SOURCE_SHA,
      observedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'stale',
    },
  });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'failed');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  assert.equal(stdout.twoPlatformClaimStatus, 'failed');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(pack.source.status, 'stale');
  assert.equal(pack.mechanismStatus, 'succeeded');
  assert.equal(pack.twoPlatformClaim.status, 'failed');
  assert.ok(pack.twoPlatformClaim.reasons.includes('source is stale'));
});

test('failed liveProofSet writes canonical pack and returns 1', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot, { status: 'failed' });
  const bytes = fs.readFileSync(path.join(artifactRoot, live.relativePath));
  const input = buildInput({
    ...live,
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
    status: 'failed',
  });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'failed');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  assert.equal(stdout.twoPlatformClaimStatus, 'failed');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(pack.liveProofSet.status, 'failed');
  assert.equal(pack.mechanismStatus, 'succeeded');
  assert.equal(pack.twoPlatformClaim.status, 'failed');
  assert.ok(pack.twoPlatformClaim.reasons.includes('liveProofSet failed'));
});

test('incomplete completeness writes canonical pack and returns 1', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const input = buildInput(live, { completeness: { status: 'incomplete', reasons: ['missing evidence'] } });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'failed');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  assert.equal(stdout.twoPlatformClaimStatus, 'failed');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(pack.completeness.status, 'incomplete');
  assert.equal(pack.mechanismStatus, 'succeeded');
  assert.equal(pack.twoPlatformClaim.status, 'failed');
  assert.ok(pack.twoPlatformClaim.reasons.includes('completeness is incomplete'));
});

test('failed assembly writes canonical pack and returns 1', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const input = buildInput(live, { assembly: { status: 'failed', reasons: ['assembly failed'] } });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'failed');
  assert.equal(stdout.mechanismStatus, 'failed');
  assert.equal(stdout.twoPlatformClaimStatus, 'failed');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(pack.assembly.status, 'failed');
  assert.equal(pack.mechanismStatus, 'failed');
  assert.equal(pack.twoPlatformClaim.status, 'failed');
  assert.ok(pack.twoPlatformClaim.reasons.includes('assembly failed'));
});

test('comparisonStatus not_available does not prevent assemble exit 0', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const input = buildInput(live, { comparisonStatus: 'not_available' });
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 0);
  const stdout = parseStdout(result.stdout);
  assert.equal(stdout.phase, 'assemble');
  assert.equal(stdout.artifact, path.join(outDir, 'ci-evidence-pack.json'));
  assert.equal(stdout.publicationAttempted, false);
  assert.equal(stdout.gateStatus, 'passed');
  assert.equal(stdout.mechanismStatus, 'succeeded');
  assert.equal(stdout.twoPlatformClaimStatus, 'passed');
  const pack = assertCanonicalPackReadable(outDir);
  assert.equal(pack.comparisonStatus, 'not_available');
  assert.equal(pack.source.status, 'current');
  assert.equal(pack.liveProofSet.status, 'passed');
  assert.equal(pack.completeness.status, 'complete');
  assert.equal(pack.assembly.status, 'succeeded');
  assert.equal(pack.mechanismStatus, 'succeeded');
  assert.equal(pack.twoPlatformClaim.status, 'passed');
});

test('invalid request UTF-8, JSON, extra keys, array/null input, empty paths, unknown/duplicate/missing flags return 2', async () => {
  const root = makeTempDir();
  const outDir = path.join(root, 'out');

  const invalidUtf8 = path.join(root, 'bad-utf8.json');
  fs.writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe, 0x00]));
  assert.equal((await runCli(['assemble', '--request', invalidUtf8])).code, 2);
  assertNoCanonicalPack(outDir);

  const badJson = path.join(root, 'bad.json');
  fs.writeFileSync(badJson, '{');
  assert.equal((await runCli(['assemble', '--request', badJson])).code, 2);
  assertNoCanonicalPack(outDir);

  const extraOut = path.join(root, 'extra-out');
  const extra = path.join(root, 'extra.json');
  writeJson(extra, { artifactRoot: root, outDir: extraOut, input: {}, extra: true });
  assert.equal((await runCli(['assemble', '--request', extra])).code, 2);
  assertNoCanonicalPack(extraOut);

  const arrayOut = path.join(root, 'array-out');
  const arrayInput = path.join(root, 'array.json');
  writeJson(arrayInput, { artifactRoot: root, outDir: arrayOut, input: [] });
  assert.equal((await runCli(['assemble', '--request', arrayInput])).code, 2);
  assertNoCanonicalPack(arrayOut);

  const nullOut = path.join(root, 'null-out');
  const nullInput = path.join(root, 'null.json');
  writeJson(nullInput, { artifactRoot: root, outDir: nullOut, input: null });
  assert.equal((await runCli(['assemble', '--request', nullInput])).code, 2);
  assertNoCanonicalPack(nullOut);

  const emptyOut = path.join(root, 'empty-out');
  const emptyPath = path.join(root, 'empty.json');
  writeJson(emptyPath, { artifactRoot: '', outDir: emptyOut, input: {} });
  assert.equal((await runCli(['assemble', '--request', emptyPath])).code, 2);
  assertNoCanonicalPack(emptyOut);

  assert.equal((await runCli(['assemble'])).code, 2);
  assert.equal((await runCli(['assemble', '--request', extra, '--request', extra])).code, 2);
  assert.equal((await runCli(['assemble', '--unknown', 'x'])).code, 2);
  assert.equal((await runCli(['nope'])).code, 2);
  assert.equal((await runCli(['assemble', 'positional'])).code, 2);
  assert.equal((await runCli(['assemble', '--request', ''])).code, 2);
  assert.equal((await runCli(['assemble', '--request', '   '])).code, 2);
  assert.equal((await runCli(['summarize'])).code, 2);
  assert.equal((await runCli(['summarize', '--pack', extra, '--receipt', extra, '--pack', extra])).code, 2);
  assert.equal((await runCli(['summarize', '--unknown', 'x'])).code, 2);
  assert.equal((await runCli(['summarize', '--pack', ''])).code, 2);
  assert.equal((await runCli(['summarize', '--pack', '   ', '--receipt', extra])).code, 2);
  assert.equal((await runCli(['summarize', '--receipt', ''])).code, 2);
  assert.equal((await runCli(['summarize', '--out', '   '])).code, 2);
  assertNoCanonicalPack(outDir);
});

test('nested extra keys and non-object nested entries return 2 and create no pack', async () => {
  const cases: Array<{ name: string; mutate: (input: Record<string, unknown>) => void }> = [
    {
      name: 'source extra key',
      mutate: (input) => {
        input.source = { ...(input.source as object), extra: true };
      },
    },
    {
      name: 'liveProofSet extra key',
      mutate: (input) => {
        input.liveProofSet = { ...(input.liveProofSet as object), extra: true };
      },
    },
    {
      name: 'completeness extra key',
      mutate: (input) => {
        input.completeness = { ...(input.completeness as object), extra: true };
      },
    },
    {
      name: 'assembly extra key',
      mutate: (input) => {
        input.assembly = { ...(input.assembly as object), extra: true };
      },
    },
    {
      name: 'platform extra key',
      mutate: (input) => {
        const platforms = input.platforms as Array<Record<string, unknown>>;
        platforms[0] = { ...platforms[0]!, extra: true };
      },
    },
    {
      name: 'attempt extra key',
      mutate: (input) => {
        const attempts = input.attempts as Array<Record<string, unknown>>;
        attempts[0] = { ...attempts[0]!, extra: true };
      },
    },
    {
      name: 'present evidence extra key',
      mutate: (input) => {
        const evidence = input.evidence as Array<Record<string, unknown>>;
        evidence[0] = { ...evidence[0]!, extra: true };
      },
    },
    {
      name: 'non-present evidence extra key',
      mutate: (input) => {
        const evidence = input.evidence as Array<Record<string, unknown>>;
        const current = evidence[1]!;
        evidence[1] = {
          evidenceId: current.evidenceId,
          kind: current.kind,
          attemptId: current.attemptId,
          platform: current.platform,
          status: 'missing',
          reason: 'evidence not present',
          extra: true,
        };
      },
    },
    {
      name: 'verdict extra key',
      mutate: (input) => {
        const verdicts = input.verdicts as Array<Record<string, unknown>>;
        verdicts[0] = { ...verdicts[0]!, extra: true };
      },
    },
    {
      name: 'non-object platform entry',
      mutate: (input) => {
        (input.platforms as unknown[])[0] = null;
      },
    },
    {
      name: 'non-object attempt entry',
      mutate: (input) => {
        (input.attempts as unknown[])[0] = 'attempt';
      },
    },
    {
      name: 'non-object evidence entry',
      mutate: (input) => {
        (input.evidence as unknown[])[0] = 1;
      },
    },
    {
      name: 'non-object verdict entry',
      mutate: (input) => {
        (input.verdicts as unknown[])[0] = [];
      },
    },
  ];

  for (const nestedCase of cases) {
    const root = makeTempDir();
    const artifactRoot = path.join(root, 'artifacts');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(artifactRoot, { recursive: true });
    const live = buildLiveProofSet(artifactRoot);
    const input = buildInput(live) as Record<string, unknown>;
    nestedCase.mutate(input);
    const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
    assert.equal(result.code, 2, nestedCase.name);
    assertNoCanonicalPack(outDir);
  }
});

async function runLiveProofRejection(
  mutate: (input: CiEvidencePackBuildInput, live: ReturnType<typeof buildLiveProofSet>, artifactRoot: string) => void,
): Promise<void> {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const input = buildInput(live);
  mutate(input, live, artifactRoot);
  const result = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, input)]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assertNoCanonicalPack(outDir);
}

test('live-proof-set wrong sha256 returns 1 and writes no pack', async () => {
  await runLiveProofRejection((input, live) => {
    input.liveProofSet = {
      ...input.liveProofSet,
      sha256: '0'.repeat(64),
      byteSize: live.byteSize,
      runId: live.runId,
      status: live.status,
    };
  });
});

test('live-proof-set wrong byteSize returns 1 and writes no pack', async () => {
  await runLiveProofRejection((input, live) => {
    input.liveProofSet = {
      ...input.liveProofSet,
      sha256: live.sha256,
      byteSize: live.byteSize + 1,
      runId: live.runId,
      status: live.status,
    };
  });
});

test('live-proof-set wrong runId returns 1 and writes no pack', async () => {
  await runLiveProofRejection((input, live) => {
    input.liveProofSet = {
      ...input.liveProofSet,
      sha256: live.sha256,
      byteSize: live.byteSize,
      runId: 'other-run',
      status: live.status,
    };
  });
});

test('live-proof-set missing relativePath returns 1 and writes no pack', async () => {
  await runLiveProofRejection((input) => {
    input.liveProofSet = {
      ...input.liveProofSet,
      relativePath: 'missing-live-proof-set.json',
    };
  });
});

test('live-proof-set unsafe relativePath returns 1 and writes no pack', async () => {
  await runLiveProofRejection((input) => {
    input.liveProofSet = {
      ...input.liveProofSet,
      relativePath: '../escape-live-proof-set.json',
    };
  });
});

test('live-proof-set missing child proof file returns 1 and writes no pack', async () => {
  await runLiveProofRejection((_input, _live, artifactRoot) => {
    fs.rmSync(path.join(artifactRoot, 'proofs/android.json'));
  });
});

test('live-proof-set missing child summary file returns 1 and writes no pack', async () => {
  await runLiveProofRejection((_input, _live, artifactRoot) => {
    fs.rmSync(path.join(artifactRoot, 'summaries/ios.json'));
  });
});

test('live-proof-set child path escape returns 1 and writes no pack', async () => {
  await runLiveProofRejection((input, live, artifactRoot) => {
    const androidProof = live.liveProofSet.proofs[0];
    const iosProof = live.liveProofSet.proofs[1];
    assert.ok(androidProof);
    assert.ok(iosProof);
    const escaped = {
      ...live.liveProofSet,
      proofs: [
        {
          ...androidProof,
          filePath: '../escape-proof.json',
        },
        iosProof,
      ],
    };
    const bytes = writeJson(path.join(artifactRoot, live.relativePath), escaped);
    input.liveProofSet = {
      ...input.liveProofSet,
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
    };
  });
});

test('same assemble request rerun yields byte-identical pack and no leftover temps', async () => {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const requestPath = writeRequest(root, artifactRoot, outDir, buildInput(live));
  const first = await runCli(['assemble', '--request', requestPath]);
  const packPath = path.join(outDir, 'ci-evidence-pack.json');
  const firstBytes = fs.readFileSync(packPath);
  const second = await runCli(['assemble', '--request', requestPath]);
  const secondBytes = fs.readFileSync(packPath);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.deepEqual(firstBytes, secondBytes);
  const leftovers = fs.readdirSync(outDir).filter((name) => name.includes('.tmp') || name.startsWith('.ci-evidence-pack.'));
  assert.deepEqual(leftovers, []);
});

function publishedOutcome(requestId: string, url: string, visibility: 'public' | 'restricted' = 'public') {
  return {
    requestId,
    status: 'published' as const,
    url,
    visibility,
    publishedAt: '2026-08-22T03:00:00.000Z',
  };
}

function cloneFacts(facts: CiEvidencePublicationReceiptFacts): CiEvidencePublicationReceiptFacts {
  return JSON.parse(JSON.stringify(facts)) as CiEvidencePublicationReceiptFacts;
}

function publishedFacts(pack: CiEvidencePack): CiEvidencePublicationReceiptFacts {
  const present = pack.evidence.filter((record) => record.status === 'present');
  const evidenceItems = present.map((record) => ({
    requestId: `req-${record.evidenceId}`,
    targetKind: 'evidence' as const,
    evidenceId: record.evidenceId,
  }));
  const evidenceOutcomes = present.map((record) =>
    publishedOutcome(`req-${record.evidenceId}`, `https://example.test/${record.evidenceId}.json`),
  );
  return {
    receiptId: 'receipt-1',
    createdAt: '2026-08-22T03:00:00.000Z',
    packRelativePath: 'ci-evidence-pack.json',
    publisher: {
      providerId: 'ci-local',
      providerKind: 'local',
      runId: 'pub-run-1',
      attemptNumber: 1,
    },
    requestedItems: [
      { requestId: 'req-pack', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' },
      { requestId: 'req-lps', targetKind: 'pack_artifact', packArtifact: 'live_proof_set' },
      ...evidenceItems,
    ],
    outcomes: [
      publishedOutcome('req-pack', 'https://example.test/ci-evidence-pack.json'),
      publishedOutcome('req-lps', 'https://example.test/live-proof-set.json'),
      ...evidenceOutcomes,
    ],
  };
}

function buildValidReceipt(packBytes: Buffer, pack: CiEvidencePack, facts = publishedFacts(pack)) {
  return buildCiEvidencePublicationReceipt({ packBytes, facts });
}

async function assemblePassedPack(): Promise<{
  root: string;
  artifactRoot: string;
  outDir: string;
  live: ReturnType<typeof buildLiveProofSet>;
  packPath: string;
  packBytes: Buffer;
  pack: ReturnType<typeof readCiEvidencePack>;
}> {
  const root = makeTempDir();
  const artifactRoot = path.join(root, 'artifacts');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const live = buildLiveProofSet(artifactRoot);
  const assembled = await runCli(['assemble', '--request', writeRequest(root, artifactRoot, outDir, buildInput(live))]);
  assert.equal(assembled.code, 0);
  const packPath = path.join(outDir, 'ci-evidence-pack.json');
  const packBytes = fs.readFileSync(packPath);
  const pack = readCiEvidencePack(packPath);
  return { root, artifactRoot, outDir, live, packPath, packBytes, pack };
}

test('summarize success writes deterministic markdown and returns 0', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const summaryPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const summarized = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath]);
  const receiptAfterRead = readCiEvidencePublicationReceipt(receiptPath, packBytes);
  assert.equal(evaluateCiEvidencePublicationSummary(pack, receiptAfterRead, packBytes).status, 'passed');
  assert.equal(summarized.code, 0);
  const stdout = parseStdout(summarized.stdout);
  assert.equal(stdout.phase, 'summarize');
  assert.equal(stdout.gateStatus, 'passed');
  assert.equal(stdout.artifact, summaryPath);
  const markdown = fs.readFileSync(summaryPath, 'utf8');
  const expected = renderCiEvidencePublicationSummary(pack, receiptAfterRead, packBytes);
  assert.equal(markdown, expected);
  const packBytesAfter = fs.readFileSync(packPath);
  const receiptBytesAfter = fs.readFileSync(receiptPath);
  assert.deepEqual(packBytesAfter, packBytes);
  assert.deepEqual(receiptBytesAfter, receiptBytesBefore);
});

test('summarize success with explicit --out writes the same markdown', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const summaryPath = path.join(outDir, 'custom-summary.md');
  const summarized = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', summaryPath]);
  assert.equal(summarized.code, 0);
  const stdout = parseStdout(summarized.stdout);
  assert.equal(stdout.phase, 'summarize');
  assert.equal(stdout.gateStatus, 'passed');
  assert.equal(stdout.artifact, summaryPath);
  const markdown = fs.readFileSync(summaryPath, 'utf8');
  const expected = renderCiEvidencePublicationSummary(pack, receipt, packBytes);
  assert.equal(markdown, expected);
  assert.deepEqual(fs.readFileSync(packPath), packBytes);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);
});

test('summarize rejects --out equal to pack or receipt without altering artifacts', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const packBytesBefore = Buffer.from(packBytes);

  const collidePack = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', packPath]);
  assert.equal(collidePack.code, 2);
  assert.equal(collidePack.stdout, '');
  assert.match(collidePack.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);
  const leftoversAfterPack = fs
    .readdirSync(outDir)
    .filter((name) => name.includes('.tmp') || name.startsWith('.ci-evidence-pack.'));
  assert.deepEqual(leftoversAfterPack, []);

  const collideReceipt = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', receiptPath]);
  assert.equal(collideReceipt.code, 2);
  assert.equal(collideReceipt.stdout, '');
  assert.match(collideReceipt.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);
  const leftoversAfterReceipt = fs
    .readdirSync(outDir)
    .filter((name) => name.includes('.tmp') || name.startsWith('.ci-evidence-pack.'));
  assert.deepEqual(leftoversAfterReceipt, []);
});

test('summarize rejects --out that realpath-aliases pack or receipt without altering artifacts', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const packBytesBefore = Buffer.from(packBytes);

  const aliasDir = path.join(outDir, 'aliases');
  fs.mkdirSync(aliasDir, { recursive: true });
  const packAlias = path.join(aliasDir, 'pack-alias.json');
  const receiptAlias = path.join(aliasDir, 'receipt-alias.json');
  fs.symlinkSync(packPath, packAlias);
  fs.symlinkSync(receiptPath, receiptAlias);

  const collidePackAlias = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', packAlias]);
  assert.equal(collidePackAlias.code, 2);
  assert.equal(collidePackAlias.stdout, '');
  assert.match(collidePackAlias.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.readlinkSync(packAlias), packPath);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);

  const collideReceiptAlias = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    receiptPath,
    '--out',
    receiptAlias,
  ]);
  assert.equal(collideReceiptAlias.code, 2);
  assert.equal(collideReceiptAlias.stdout, '');
  assert.match(collideReceiptAlias.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.readlinkSync(receiptAlias), receiptPath);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);
});

test('summarize rejects string-unequal non-symlink . and .. --out aliases without clobber', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const packBytesBefore = Buffer.from(packBytes);

  const packDotAlias = [outDir, '.', path.basename(packPath)].join(path.sep);
  assert.notEqual(packDotAlias, packPath);
  const collidePackDot = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', packDotAlias]);
  assert.equal(collidePackDot.code, 2);
  assert.equal(collidePackDot.stdout, '');
  assert.match(collidePackDot.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);

  fs.mkdirSync(path.join(outDir, 'nested'), { recursive: true });
  const receiptDotDotAlias = [outDir, 'nested', '..', path.basename(receiptPath)].join(path.sep);
  assert.notEqual(receiptDotDotAlias, receiptPath);
  const collideReceiptDotDot = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    receiptPath,
    '--out',
    receiptDotDotAlias,
  ]);
  assert.equal(collideReceiptDotDot.code, 2);
  assert.equal(collideReceiptDotDot.stdout, '');
  assert.match(collideReceiptDotDot.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);
});

test('unsupported command through runCli argv harness exits usage without stdout', async () => {
  const result = await runCli(['not-a-ci-evidence-command']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Usage/);
});

test('summarize FileSystemPort omit-both keeps exact-string collision exit 2 and allows a new output', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const packBytesBefore = Buffer.from(packBytes);
  const omitBoth = testFileSystemPort();

  const collide = await runCli(
    ['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', packPath],
    { fs: omitBoth },
  );
  assert.equal(collide.code, 2);
  assert.equal(collide.stdout, '');
  assert.match(collide.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.existsSync(path.join(outDir, 'ci-evidence-publication-summary.md')), false);

  const outPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const ok = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', outPath], {
    fs: omitBoth,
  });
  assert.equal(ok.code, 0);
  assert.equal(fs.existsSync(outPath), true);
});

test('summarize FileSystemPort exists-only does not falsely reject a valid new output', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  writeJson(receiptPath, receipt);
  const existsOnly = testFileSystemPort({
    existsSync: (target) => fs.existsSync(target),
  });
  const outPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const ok = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', outPath], {
    fs: existsOnly,
  });
  assert.equal(ok.code, 0);
  assert.equal(fs.existsSync(outPath), true);
});

test('summarize FileSystemPort realpath-only does not falsely reject a valid new output', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  writeJson(receiptPath, receipt);
  const realpathOnly = testFileSystemPort({
    realpathSync: (target) => fs.realpathSync(target),
  });
  const outPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const ok = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', outPath], {
    fs: realpathOnly,
  });
  assert.equal(ok.code, 0);
  assert.equal(fs.existsSync(outPath), true);
});

test('summarize FileSystemPort with both methods allows a new output and rejects symlink aliases', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const packBytesBefore = Buffer.from(packBytes);
  const both = testFileSystemPort({
    existsSync: (target) => fs.existsSync(target),
    realpathSync: (target) => fs.realpathSync(target),
  });
  const outPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const ok = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', outPath], { fs: both });
  assert.equal(ok.code, 0);
  assert.equal(fs.existsSync(outPath), true);
  const summaryBytesBefore = fs.readFileSync(outPath);

  const aliasDir = path.join(outDir, 'aliases-port');
  fs.mkdirSync(aliasDir, { recursive: true });
  const packAlias = path.join(aliasDir, 'pack-alias.json');
  fs.symlinkSync(packPath, packAlias);
  const collide = await runCli(
    ['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', packAlias],
    { fs: both },
  );
  assert.equal(collide.code, 2);
  assert.equal(collide.stdout, '');
  assert.match(collide.stderr, /must not overwrite the bound (?:pack|receipt)/);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);
  assert.equal(fs.readlinkSync(packAlias), packPath);
  assert.deepEqual(fs.readFileSync(outPath), summaryBytesBefore);
});

test('summarize FileSystemPort fail-closed names the pack or receipt path that could not be resolved', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const receipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  const receiptBytesBefore = writeJson(receiptPath, receipt);
  const packBytesBefore = Buffer.from(packBytes);
  const outPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const failingPack = testFileSystemPort({
    existsSync: (target) => fs.existsSync(target),
    realpathSync: (target) => {
      if (path.resolve(target) === path.resolve(packPath)) {
        throw new Error('ELOOP: too many symbolic links');
      }
      return fs.realpathSync(target);
    },
  });
  const packFail = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', outPath], {
    fs: failingPack,
  });
  assert.equal(packFail.code, 2);
  assert.equal(packFail.stderr.includes(packPath), true);
  assert.equal(packFail.stderr.includes('--out'), false);
  assert.match(packFail.stderr, /could not be resolved/);
  assert.equal(fs.existsSync(outPath), false);
  assert.deepEqual(fs.readFileSync(packPath), packBytesBefore);
  assert.deepEqual(fs.readFileSync(receiptPath), receiptBytesBefore);

  const failingReceipt = testFileSystemPort({
    existsSync: (target) => fs.existsSync(target),
    realpathSync: (target) => {
      if (path.resolve(target) === path.resolve(receiptPath)) {
        throw new Error('ELOOP: too many symbolic links');
      }
      return fs.realpathSync(target);
    },
  });
  const receiptFail = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath, '--out', outPath], {
    fs: failingReceipt,
  });
  assert.equal(receiptFail.code, 2);
  assert.equal(receiptFail.stderr.includes(receiptPath), true);
  assert.equal(receiptFail.stderr.includes('--out'), false);
  assert.match(receiptFail.stderr, /could not be resolved/);
  assert.equal(fs.existsSync(outPath), false);
});

test('summarize returns 1 and preserves a valid summary for incomplete publication obligations', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();

  const notPublishedFacts = cloneFacts(publishedFacts(pack));
  notPublishedFacts.outcomes = notPublishedFacts.requestedItems.map((item) => ({
    requestId: item.requestId,
    status: 'not_available' as const,
    reason: 'publisher did not publish',
  }));
  const notPublishedPack = buildCiEvidencePublicationReceipt({ packBytes, facts: notPublishedFacts });
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  writeJson(receiptPath, notPublishedPack);
  const summarized = await runCli(['summarize', '--pack', packPath, '--receipt', receiptPath]);
  assert.equal(evaluateCiEvidencePublicationSummary(pack, notPublishedPack, packBytes).status, 'failed');
  assert.equal(summarized.code, 1);
  const failedStdout = parseStdout(summarized.stdout);
  assert.equal(failedStdout.phase, 'summarize');
  assert.equal(failedStdout.gateStatus, 'failed');
  const summaryPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  assert.equal(failedStdout.artifact, summaryPath);
  assert.equal(fs.existsSync(summaryPath), true);
  assert.equal(fs.readFileSync(summaryPath, 'utf8'), renderCiEvidencePublicationSummary(pack, notPublishedPack, packBytes));

  const restrictedFacts = cloneFacts(publishedFacts(pack));
  restrictedFacts.outcomes = restrictedFacts.outcomes.map((outcome) =>
    outcome.requestId === 'req-lps' && outcome.status === 'published'
      ? { ...outcome, visibility: 'restricted' as const }
      : outcome,
  );
  const restrictedLive = buildCiEvidencePublicationReceipt({ packBytes, facts: restrictedFacts });
  const restrictedDir = path.join(outDir, 'restricted');
  fs.mkdirSync(restrictedDir, { recursive: true });
  const restrictedReceiptPath = path.join(restrictedDir, 'receipt.json');
  writeJson(restrictedReceiptPath, restrictedLive);
  const explicitOut = path.join(restrictedDir, 'summary.md');
  const restrictedResult = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    restrictedReceiptPath,
    '--out',
    explicitOut,
  ]);
  assert.equal(evaluateCiEvidencePublicationSummary(pack, restrictedLive, packBytes).status, 'failed');
  assert.equal(restrictedResult.code, 1);
  assert.equal(fs.existsSync(explicitOut), true);
  assert.equal(fs.readFileSync(explicitOut, 'utf8'), renderCiEvidencePublicationSummary(pack, restrictedLive, packBytes));

  const partialFacts = cloneFacts(publishedFacts(pack));
  partialFacts.outcomes = partialFacts.outcomes.map((outcome) =>
    outcome.requestId === 'req-lps'
      ? { requestId: 'req-lps', status: 'failed' as const, reason: 'upload failed' }
      : outcome,
  );
  const partialReceipt = buildCiEvidencePublicationReceipt({ packBytes, facts: partialFacts });
  const partialReceiptPath = path.join(outDir, 'partial-receipt.json');
  writeJson(partialReceiptPath, partialReceipt);
  const partialOut = path.join(outDir, 'partial-summary.md');
  const partialResult = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    partialReceiptPath,
    '--out',
    partialOut,
  ]);
  assert.equal(evaluateCiEvidencePublicationSummary(pack, partialReceipt, packBytes).status, 'failed');
  assert.equal(partialResult.code, 1);
  assert.equal(fs.existsSync(partialOut), true);
  assert.equal(fs.readFileSync(partialOut, 'utf8'), renderCiEvidencePublicationSummary(pack, partialReceipt, packBytes));

  const missingFacts = cloneFacts(publishedFacts(pack));
  missingFacts.requestedItems = missingFacts.requestedItems.filter((item) => item.requestId !== 'req-lps');
  missingFacts.outcomes = missingFacts.outcomes.filter((outcome) => outcome.requestId !== 'req-lps');
  const missingReceipt = buildCiEvidencePublicationReceipt({ packBytes, facts: missingFacts });
  const missingReceiptPath = path.join(outDir, 'missing-receipt.json');
  writeJson(missingReceiptPath, missingReceipt);
  const missingOut = path.join(outDir, 'missing-summary.md');
  const missingResult = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    missingReceiptPath,
    '--out',
    missingOut,
  ]);
  assert.equal(evaluateCiEvidencePublicationSummary(pack, missingReceipt, packBytes).status, 'failed');
  assert.equal(missingResult.code, 1);
  assert.equal(fs.existsSync(missingOut), true);
  assert.equal(fs.readFileSync(missingOut, 'utf8'), renderCiEvidencePublicationSummary(pack, missingReceipt, packBytes));
});

test('summarize fail-closed cases do not create or replace a summary', async () => {
  const { outDir, packPath, packBytes, pack } = await assemblePassedPack();
  const validReceipt = buildValidReceipt(packBytes, pack);
  const receiptPath = path.join(outDir, 'ci-evidence-publication-receipt.json');
  writeJson(receiptPath, validReceipt);

  const tamperedPackPath = path.join(outDir, 'tampered-pack.json');
  fs.writeFileSync(tamperedPackPath, Buffer.concat([packBytes, Buffer.from(' ')]));
  const tamperedOut = path.join(outDir, 'tampered-summary.md');
  const tampered = await runCli([
    'summarize',
    '--pack',
    tamperedPackPath,
    '--receipt',
    receiptPath,
    '--out',
    tamperedOut,
  ]);
  assert.equal(tampered.code, 1);
  assert.equal(fs.existsSync(tamperedOut), false);

  const mismatched: CiEvidencePublicationReceipt = {
    ...validReceipt,
    pack: { ...validReceipt.pack, sha256: '0'.repeat(64) },
  };
  const mismatchedReceiptPath = path.join(outDir, 'mismatched-receipt.json');
  writeJson(mismatchedReceiptPath, mismatched);
  const mismatchOut = path.join(outDir, 'mismatch-summary.md');
  const mismatchResult = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    mismatchedReceiptPath,
    '--out',
    mismatchOut,
  ]);
  assert.equal(mismatchResult.code, 1);
  assert.equal(fs.existsSync(mismatchOut), false);

  const malformedPath = path.join(outDir, 'malformed-receipt.json');
  fs.writeFileSync(malformedPath, '{');
  const defaultSummaryPath = path.join(outDir, 'ci-evidence-publication-summary.md');
  const existing = 'keep-existing-summary\n';
  fs.writeFileSync(defaultSummaryPath, existing);
  const malformed = await runCli(['summarize', '--pack', packPath, '--receipt', malformedPath]);
  assert.equal(malformed.code, 1);
  assert.equal(fs.readFileSync(defaultSummaryPath, 'utf8'), existing);

  const unsafeReceipt = JSON.parse(JSON.stringify(validReceipt)) as CiEvidencePublicationReceipt;
  const firstPublished = unsafeReceipt.outcomes.find((outcome) => outcome.status === 'published');
  assert.ok(firstPublished);
  firstPublished.url = 'https://user:pass@example.test/ci-evidence-pack.json';
  const unsafeReceiptPath = path.join(outDir, 'unsafe-receipt.json');
  writeJson(unsafeReceiptPath, unsafeReceipt);
  const unsafeOut = path.join(outDir, 'unsafe-summary.md');
  const unsafeResult = await runCli([
    'summarize',
    '--pack',
    packPath,
    '--receipt',
    unsafeReceiptPath,
    '--out',
    unsafeOut,
  ]);
  assert.equal(unsafeResult.code, 1);
  assert.equal(fs.existsSync(unsafeOut), false);
});

test('help and usage contain no upload GitHub PR release deployment runtime product-acceptance claims', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  const text = `${help.stdout}\n${usage.join('\n')}`.toLowerCase();
  for (const banned of ['upload', 'github', 'pull request', 'release', 'deployment', 'runtime acceptance', 'product acceptance']) {
    assert.equal(text.includes(banned), false, banned);
  }
  const missing = await runCli([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Usage:/);
});

test('atomic writer failure never replaces existing canonical file', () => {
  const root = makeTempDir();
  const target = path.join(root, 'canonical.json');
  fs.writeFileSync(target, 'keep-me\n');
  const fileSystem: FileSystemPort = {
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    unlinkSync: fs.unlinkSync,
    writeFileSync: fs.writeFileSync,
    renameSync: () => {
      throw new Error('rename failed');
    },
  };
  assert.throws(() => writeFileAtomically(target, 'partial\n', fileSystem));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep-me\n');
  const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('forged unsupported command fails closed as usage exit 2 rather than summarize', async () => {
  const result = await runCli(['upload']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, '');
});

test('parseCiEvidencePackCliArgs rejects unknown and duplicate flags', () => {
  assert.throws(() => parseCiEvidencePackCliArgs(['node', 'bin', 'assemble', '--request']));
  assert.throws(() =>
    parseCiEvidencePackCliArgs(['node', 'bin', 'assemble', '--request', 'a.json', '--request', 'b.json']),
  );
  assert.throws(() => parseCiEvidencePackCliArgs(['node', 'bin', 'summarize']));
  assert.throws(() => parseCiEvidencePackCliArgs(['node', 'bin', 'summarize', '--pack', 'p.json']));
  assert.throws(() => parseCiEvidencePackCliArgs(['node', 'bin', 'summarize', '--receipt', 'r.json']));
  const parsed = parseCiEvidencePackCliArgs([
    'node',
    'bin',
    'summarize',
    '--pack',
    'p.json',
    '--receipt',
    'r.json',
    '--out',
    'o.md',
  ]);
  assert.equal(parsed.command, 'summarize');
  if (parsed.command === 'summarize') {
    assert.equal(parsed.packPath, 'p.json');
    assert.equal(parsed.receiptPath, 'r.json');
    assert.equal(parsed.outPath, 'o.md');
  }
});

test('readCiEvidencePackAssembleRequest rejects extra keys', () => {
  const root = makeTempDir();
  const requestPath = path.join(root, 'request.json');
  writeJson(requestPath, { artifactRoot: root, outDir: root, input: {}, extra: 1 });
  assert.throws(() => readCiEvidencePackAssembleRequest(requestPath));
});
