const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  assembleCiEvidencePack,
  __testOnlyChildCanonicalization,
  __testOnlyStableContainedFileReader,
  verifyCiEvidencePackLiveProofSet,
} = require('../ci-evidence-pack-assembler');
const { CiEvidencePackError } = require('../ci-evidence-pack');
import type {
  CiEvidencePackAttemptRecord,
  CiEvidencePackBuildInput,
  CiEvidencePackEvidenceRecord,
  CiEvidencePackPlatformRecord,
  CiEvidencePackVerdictPointer,
} from '../ci-evidence-pack';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function presentEvidence(
  evidenceId: string,
  attemptId: string,
  platform: 'android' | 'ios',
  kind: 'recording' | 'verdict',
): CiEvidencePackEvidenceRecord {
  return {
    evidenceId,
    attemptId,
    platform,
    kind,
    status: 'present',
    relativePath: `evidence/${evidenceId}.bin`,
    sha256: SHA256,
    byteSize: 12,
  };
}

function attemptRecord(
  platform: 'android' | 'ios',
  attemptId: string,
  runId: string,
  extras: Partial<CiEvidencePackAttemptRecord> = {},
): CiEvidencePackAttemptRecord {
  const evidenceIds = [`${attemptId}-recording`, `${attemptId}-verdict`];
  return {
    attemptId,
    platform,
    scenarioId: 'scenario-a',
    runId,
    status: 'passed',
    attemptNumber: 1,
    maxAttempts: 1,
    startedAt: '2026-08-22T00:00:00.000Z',
    evidenceIds,
    ...extras,
  };
}

const PASSING_NEXT_ACTION = { code: 'none', summary: 'No action required.' };

function proofPointer(
  platform: 'android' | 'ios',
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    filePath: `proofs/${platform}.json`,
    platform,
    runId: `run-${platform}`,
    status: 'passed',
    summaryPath: `summaries/${platform}.json`,
    comparisonStatus: 'not_compared',
    profileCount: 0,
    interactionProofCount: 0,
    interactionWarningCount: 0,
    nextAction: PASSING_NEXT_ACTION,
    ...extras,
  };
}

function liveProofSetPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    runId: 'run-1',
    status: 'passed',
    proofCount: 2,
    requiredPlatforms: ['android', 'ios'],
    presentPlatforms: ['android', 'ios'],
    missingPlatforms: [],
    failureReasons: [],
    nextAction: PASSING_NEXT_ACTION,
    summary: 'Android and iOS live proofs assembled.',
    proofs: [proofPointer('android'), proofPointer('ios')],
    ...overrides,
  };
}

function writeChildFiles(root: string): void {
  mkdirSync(path.join(root, 'proofs'), { recursive: true });
  mkdirSync(path.join(root, 'summaries'), { recursive: true });
  writeFileSync(path.join(root, 'proofs', 'android.json'), '{}\n');
  writeFileSync(path.join(root, 'proofs', 'ios.json'), '{}\n');
  writeFileSync(path.join(root, 'summaries', 'android.json'), '{}\n');
  writeFileSync(path.join(root, 'summaries', 'ios.json'), '{}\n');
  writeFileSync(path.join(root, 'summaries', 'android.md'), '# android\n');
  writeFileSync(path.join(root, 'summaries', 'ios.md'), '# ios\n');
}

function writeLiveProofSet(root: string, payload: unknown): { relativePath: string; bytes: Buffer } {
  writeChildFiles(root);
  const relativePath = 'live-proof-set.json';
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(root, relativePath), bytes);
  return { relativePath, bytes };
}

function defaultPlatforms(): CiEvidencePackPlatformRecord[] {
  return [
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
  ];
}

function defaultAttempts(): CiEvidencePackAttemptRecord[] {
  return [
    attemptRecord('android', 'attempt-android', 'run-android'),
    attemptRecord('ios', 'attempt-ios', 'run-ios'),
  ];
}

function evidenceForAttempts(attempts: CiEvidencePackAttemptRecord[]): CiEvidencePackEvidenceRecord[] {
  return attempts.flatMap((item) => [
    presentEvidence(`${item.attemptId}-recording`, item.attemptId, item.platform, 'recording'),
    presentEvidence(`${item.attemptId}-verdict`, item.attemptId, item.platform, 'verdict'),
  ]);
}

function defaultVerdicts(status: 'passed' | 'failed' = 'failed'): CiEvidencePackVerdictPointer[] {
  return [
    {
      scenarioId: 'scenario-a',
      runId: 'run-android',
      platform: 'android',
      status,
      evidenceId: 'attempt-android-verdict',
    },
    {
      scenarioId: 'scenario-a',
      runId: 'run-ios',
      platform: 'ios',
      status,
      evidenceId: 'attempt-ios-verdict',
    },
  ];
}

function baseInput(
  liveProofSet: { relativePath: string; bytes: Buffer },
  platforms: CiEvidencePackPlatformRecord[] = defaultPlatforms(),
  attempts: CiEvidencePackAttemptRecord[] = defaultAttempts(),
  verdicts: CiEvidencePackVerdictPointer[] = defaultVerdicts('failed'),
): CiEvidencePackBuildInput {
  return {
    schemaVersion: '1.0.0',
    packId: 'pack-1',
    createdAt: '2026-08-22T00:03:00.000Z',
    source: { expectedSha: SHA, observedSha: SHA, status: 'current' },
    liveProofSet: {
      relativePath: liveProofSet.relativePath,
      sha256: sha256Hex(liveProofSet.bytes),
      byteSize: liveProofSet.bytes.byteLength,
      runId: 'run-1',
      status: 'passed',
    },
    requiredPlatforms: ['android', 'ios'],
    requiredEvidenceKinds: ['recording', 'verdict'],
    platforms,
    attempts,
    evidence: evidenceForAttempts(attempts),
    verdicts,
    comparisonStatus: 'comparable',
    completeness: { status: 'complete', reasons: [] },
    assembly: { status: 'succeeded', reasons: [] },
    summary: 'android and ios evidence assembled',
    nextAction: 'publish receipt in a later slice',
  };
}

test('valid Android+iOS live-proof-set verifies and assembles even when product verdict is failed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  const verified = verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root });
  assert.equal(verified.runId, 'run-1');
  assert.equal(verified.proofCount, 2);
  assert.equal(verified.schemaVersion, '1.0.0');
  const pack = assembleCiEvidencePack(input, { artifactRoot: root });
  assert.equal(pack.liveProofSet.runId, 'run-1');
  assert.equal(pack.verdicts[0]?.status, 'failed');
});

test('failed and retried attempts remain visible beside the unique selected platform+runId match', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const attempts = [
    attemptRecord('android', 'attempt-android-failed', 'run-android-old', {
      status: 'failed',
      attemptNumber: 1,
      maxAttempts: 2,
    }),
    attemptRecord('android', 'attempt-android', 'run-android', { attemptNumber: 2, maxAttempts: 2 }),
    attemptRecord('ios', 'attempt-ios', 'run-ios'),
  ];
  const input = baseInput(live, defaultPlatforms(), attempts);
  const verified = verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root });
  assert.equal(verified.proofs[0]?.runId, 'run-android');
  assert.equal(input.attempts.length, 3);
});

test('hash-bound set reference inventory requires child proof files to exist as regular files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  const verified = verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root });
  assert.deepEqual(
    verified.proofs.map((proof: { filePath: string }) => proof.filePath).sort(),
    ['proofs/android.json', 'proofs/ios.json'],
  );
});

test('Android/iOS requiredPlatforms order is irrelevant', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload({ requiredPlatforms: ['ios', 'android'] }));
  const input = baseInput(live);
  const verified = verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root });
  assert.deepEqual(verified.requiredPlatforms, ['ios', 'android']);
});

test('byte-size and SHA checks catch tampering including whitespace-only byte changes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  writeFileSync(path.join(root, live.relativePath), Buffer.concat([live.bytes, Buffer.from(' ')]));
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    CiEvidencePackError,
  );
});

test('runId mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  input.liveProofSet.runId = 'other-run';
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /runId/);
});

test('live-proof-set status mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  input.liveProofSet.status = 'failed';
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /status/);
});

test('malformed JSON rejects as CiEvidencePackError', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  writeChildFiles(root);
  const relativePath = 'live-proof-set.json';
  const bytes = Buffer.from('{not-json', 'utf8');
  writeFileSync(path.join(root, relativePath), bytes);
  const input = baseInput({ relativePath, bytes });
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    CiEvidencePackError,
  );
});

test('schema-invalid JSON rejects as CiEvidencePackError', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, { schemaVersion: '1.0.0' });
  const input = baseInput(live);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    CiEvidencePackError,
  );
});

test('proofCount mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload({ proofCount: 1 }));
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /proofCount/);
});

test('duplicate proof platform rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  writeChildFiles(root);
  writeFileSync(path.join(root, 'proofs', 'android-2.json'), '{}\n');
  writeFileSync(path.join(root, 'summaries', 'android-2.json'), '{}\n');
  const payload = liveProofSetPayload({
    proofs: [
      proofPointer('android'),
      proofPointer('android', {
        filePath: 'proofs/android-2.json',
        runId: 'run-android-2',
        summaryPath: 'summaries/android-2.json',
      }),
    ],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /duplicate/);
});

test('presentPlatforms mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload({ presentPlatforms: ['android'] }));
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /presentPlatforms/);
});

test('missingPlatforms mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload({ missingPlatforms: ['ios'] }));
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /missingPlatforms/);
});

test('present and missing platform overlap rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(
    root,
    liveProofSetPayload({
      presentPlatforms: ['android', 'ios'],
      missingPlatforms: ['android'],
    }),
  );
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /disjoint/);
});

test('absolute child proof and summary paths inside artifactRoot are accepted when files exist', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload({
    proofs: [
      proofPointer('android', {
        filePath: path.join(root, 'proofs', 'android.json'),
        summaryPath: path.join(root, 'summaries', 'android.md'),
      }),
      proofPointer('ios', {
        filePath: path.join(root, 'proofs', 'ios.json'),
        summaryPath: path.join(root, 'summaries', 'ios.md'),
      }),
    ],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  const verified = verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root });
  assert.equal(verified.proofs[0]?.filePath, path.join(root, 'proofs', 'android.json'));
  assert.equal(verified.proofs[0]?.summaryPath, path.join(root, 'summaries', 'android.md'));
});

test('absolute child proof and summary paths outside artifactRoot reject', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload();
  const proofs = payload.proofs as Record<string, unknown>[];
  proofs[0] = {
    ...proofs[0],
    filePath: path.resolve(root, '..', 'outside-proof.json'),
    summaryPath: path.join(root, 'summaries', 'android.json'),
  };
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    CiEvidencePackError,
  );
});

test('missing child proof file rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const { unlinkSync } = require('node:fs');
  unlinkSync(path.join(root, 'proofs', 'android.json'));
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), CiEvidencePackError);
});

test('duplicate canonical proof file paths reject', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload({
    proofs: [
      proofPointer('android'),
      proofPointer('ios', { filePath: 'proofs/android.json' }),
    ],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /duplicate canonical proof filePath/);
});

test('duplicate canonical proof summary paths reject', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload({
    proofs: [
      proofPointer('android'),
      proofPointer('ios', { summaryPath: 'summaries/android.json' }),
    ],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /duplicate canonical proof summaryPath/,
  );
});

test('cross-kind file/summary alias rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload({
    proofs: [
      proofPointer('android'),
      proofPointer('ios', { filePath: 'summaries/android.json' }),
    ],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /alias/);
});

test('relative and absolute child paths that resolve to the same file reject as collisions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload({
    proofs: [
      proofPointer('android'),
      proofPointer('ios', { filePath: path.join(root, 'proofs', 'android.json') }),
    ],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /duplicate canonical proof filePath/);
});

test('child symlink escape rejects when supported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-outside-'));
  writeFileSync(path.join(outside, 'escaped-proof.json'), '{}\n');
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const { unlinkSync } = require('node:fs');
  unlinkSync(path.join(root, 'proofs', 'android.json'));
  try {
    symlinkSync(path.join(outside, 'escaped-proof.json'), path.join(root, 'proofs', 'android.json'));
  } catch {
    return;
  }
  const input = baseInput(live);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), CiEvidencePackError);
});

test('traversal and dot-segment proof and summary paths reject', () => {
  const cases = [
    { filePath: '../proofs/android.json', summaryPath: 'summaries/android.json' },
    { filePath: 'proofs/./android.json', summaryPath: 'summaries/android.json' },
    { filePath: 'proofs/android.json', summaryPath: 'summaries/./android.json' },
  ];
  for (const paths of cases) {
    const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
    const payload = liveProofSetPayload();
    const proofs = payload.proofs as Record<string, unknown>[];
    proofs[0] = { ...proofs[0], ...paths };
    const live = writeLiveProofSet(root, payload);
    const input = baseInput(live);
    assert.throws(
      () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
      CiEvidencePackError,
    );
  }
});

test('POSIX hosts reject foreign Windows child pointer syntax', { skip: path.sep === '\\' }, () => {
  const cases = [
    { filePath: 'proofs\\android.json', summaryPath: 'summaries/android.json' },
    { filePath: 'C:/proofs/android.json', summaryPath: 'summaries/android.json' },
    { filePath: '//host/share/proof.json', summaryPath: 'summaries/android.json' },
  ];
  for (const paths of cases) {
    const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
    const payload = liveProofSetPayload();
    const proofs = payload.proofs as Record<string, unknown>[];
    proofs[0] = { ...proofs[0], ...paths };
    const live = writeLiveProofSet(root, payload);
    const input = baseInput(live);
    assert.throws(
      () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
      CiEvidencePackError,
    );
  }
});

test('missing referenced live-proof-set rejects as CiEvidencePackError', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  input.liveProofSet.relativePath = 'missing-live-proof-set.json';
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    CiEvidencePackError,
  );
});

test('symlink escape of hash-bound liveProofSet.relativePath rejects when supported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-outside-'));
  writeChildFiles(root);
  const payload = liveProofSetPayload();
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(outside, 'escaped.json'), bytes);
  try {
    symlinkSync(path.join(outside, 'escaped.json'), path.join(root, 'live-proof-set.json'));
  } catch {
    return;
  }
  const input = baseInput({ relativePath: 'live-proof-set.json', bytes });
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    CiEvidencePackError,
  );
});

test('supported platform missing a proof rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const payload = liveProofSetPayload({
    proofCount: 1,
    presentPlatforms: ['android'],
    missingPlatforms: ['ios'],
    proofs: [proofPointer('android')],
  });
  const live = writeLiveProofSet(root, payload);
  const input = baseInput(live);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /missing a live-proof-set proof pointer/,
  );
});

test('selected attempt missing rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const platforms = defaultPlatforms();
  delete (platforms[0] as { selectedAttemptId?: string }).selectedAttemptId;
  const input = baseInput(live, platforms);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /selectedAttemptId/);
});

test('unknown selected attempt rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const platforms = defaultPlatforms();
  platforms[0]!.selectedAttemptId = 'missing';
  const input = baseInput(live, platforms);
  assert.throws(() => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }), /unknown/);
});

test('selected attempt platform mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const attempts = defaultAttempts();
  attempts[0] = attemptRecord('ios', 'attempt-android', 'run-android');
  const input = baseInput(live, defaultPlatforms(), attempts);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /platform does not match|no retained attempt matches/,
  );
});

test('selected attempt runId mismatch rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const attempts = defaultAttempts();
  attempts[0] = attemptRecord('android', 'attempt-android', 'other-run');
  const input = baseInput(live, defaultPlatforms(), attempts);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /runId does not match|no retained attempt matches/,
  );
});

test('multiple retained attempts with the same proof platform+runId reject', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const attempts = [
    attemptRecord('android', 'attempt-android', 'run-android'),
    attemptRecord('android', 'attempt-android-retry', 'run-android', {
      status: 'failed',
      attemptNumber: 1,
      maxAttempts: 2,
    }),
    attemptRecord('ios', 'attempt-ios', 'run-ios'),
  ];
  const input = baseInput(live, defaultPlatforms(), attempts);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /multiple retained attempts match/,
  );
});

test('selected attempt that is not the unique platform+runId match rejects', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const attempts = [
    attemptRecord('android', 'attempt-android-other', 'run-android'),
    attemptRecord('android', 'attempt-android', 'run-android-selected'),
    attemptRecord('ios', 'attempt-ios', 'run-ios'),
  ];
  const input = baseInput(live, defaultPlatforms(), attempts);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /selected attempt is not the unique platform\+runId match/,
  );
});

test('unsupported authority with a proof rejects and stays fail closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const platforms: CiEvidencePackPlatformRecord[] = [
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
  ];
  const input = baseInput(live, platforms);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /must not have a live-proof-set proof pointer/,
  );
});

test('input remains unchanged', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const input = baseInput(live);
  const snapshot = JSON.stringify(input);
  assembleCiEvidencePack(input, { artifactRoot: root });
  assert.equal(JSON.stringify(input), snapshot);
});

test('stable contained file reader rejects identity replacement via injectable io', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  writeChildFiles(root);
  const target = path.join(root, 'live-proof-set.json');
  writeFileSync(target, 'hello\n');
  const real = require('node:fs');
  const io = {
    openSync: real.openSync,
    readSync: real.readSync,
    fstatSync: (fd: number) => {
      const stat = real.fstatSync(fd);
      return { ...stat, ino: stat.ino + 1 };
    },
    closeSync: real.closeSync,
    realpathSync: real.realpathSync,
    lstatSync: real.lstatSync,
    statSync: real.statSync,
  };
  assert.throws(
    () =>
      __testOnlyStableContainedFileReader.read(
        target,
        real.realpathSync(root),
        'live-proof-set referenced file',
        io,
      ),
    /changed during verification/,
  );
});

test('stable contained file reader rejects in-place mutation when mtimeMs and ctimeMs change', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  writeChildFiles(root);
  const target = path.join(root, 'live-proof-set.json');
  writeFileSync(target, 'hello\n');
  const real = require('node:fs');
  let fstatCalls = 0;
  const io = {
    openSync: real.openSync,
    readSync: real.readSync,
    fstatSync: (fd: number) => {
      const stat = real.fstatSync(fd);
      fstatCalls += 1;
      if (fstatCalls === 1) {
        return Object.assign(stat, { mtimeMs: 1000, ctimeMs: 1000 });
      }
      return Object.assign(stat, { mtimeMs: 2000, ctimeMs: 2000 });
    },
    closeSync: real.closeSync,
    realpathSync: real.realpathSync,
    lstatSync: (filePath: string) => {
      const stat = real.lstatSync(filePath);
      return Object.assign(stat, { mtimeMs: 1000, ctimeMs: 1000 });
    },
    statSync: real.statSync,
  };
  assert.throws(
    () =>
      __testOnlyStableContainedFileReader.read(
        target,
        real.realpathSync(root),
        'live-proof-set referenced file',
        io,
      ),
    /changed during verification/,
  );
});

function fakeRegularFileIo(entries: Record<string, { dev: number; ino: number }>) {
  const lookup = (filePath: string) => {
    const record = entries[filePath];
    if (!record) {
      const error = new Error('ENOENT');
      (error as { code?: string }).code = 'ENOENT';
      throw error;
    }
    return {
      ...record,
      size: 1,
      nlink: 1,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
  };
  return {
    lstatSync: lookup,
    realpathSync: (filePath: string) => {
      lookup(filePath);
      return filePath;
    },
  };
}

test('win32 canonicalization accepts native relative, drive-absolute, and UNC pointers inside root', () => {
  const win32 = path.win32;
  const driveRoot = 'C:\\artifacts';
  const driveInside = 'C:\\artifacts\\proofs\\android.json';
  const uncRoot = '\\\\host\\share\\artifacts';
  const uncInside = '\\\\host\\share\\artifacts\\proofs\\android.json';
  const driveIo = fakeRegularFileIo({
    [driveInside]: { dev: 1, ino: 10 },
  });
  const uncIo = fakeRegularFileIo({
    [uncInside]: { dev: 2, ino: 20 },
  });
  assert.equal(
    __testOnlyChildCanonicalization.canonicalize(
      'proofs\\android.json',
      driveRoot,
      'proof filePath',
      win32,
      driveIo,
    ).realPath,
    driveInside,
  );
  assert.equal(
    __testOnlyChildCanonicalization.canonicalize(
      driveInside,
      driveRoot,
      'proof filePath',
      win32,
      driveIo,
    ).realPath,
    driveInside,
  );
  assert.equal(
    __testOnlyChildCanonicalization.canonicalize(
      uncInside,
      uncRoot,
      'proof filePath',
      win32,
      uncIo,
    ).realPath,
    uncInside,
  );
});

test('win32 canonicalization rejects drive and UNC pointers outside root before promotion', () => {
  const win32 = path.win32;
  const driveRoot = 'C:\\artifacts';
  const driveOutside = 'D:\\other\\proofs\\android.json';
  const uncRoot = '\\\\host\\share\\artifacts';
  const uncOutside = '\\\\host\\other\\proofs\\android.json';
  const io = fakeRegularFileIo({
    [driveOutside]: { dev: 1, ino: 11 },
    [uncOutside]: { dev: 2, ino: 21 },
  });
  assert.throws(
    () =>
      __testOnlyChildCanonicalization.canonicalize(
        driveOutside,
        driveRoot,
        'proof filePath',
        win32,
        io,
      ),
    /escapes artifactRoot/,
  );
  assert.throws(
    () =>
      __testOnlyChildCanonicalization.canonicalize(
        uncOutside,
        uncRoot,
        'proof filePath',
        win32,
        io,
      ),
    /escapes artifactRoot/,
  );
});

test('win32 path semantics reject traversal, mixed separators, empty segments, and foreign absolute syntax', () => {
  const win32 = path.win32;
  const rejected = [
    '..\\proofs\\android.json',
    'proofs\\.\\android.json',
    'proofs\\\\android.json',
    'proofs\\foo/android.json',
    '/tmp/proofs/android.json',
  ];
  for (const value of rejected) {
    assert.throws(
      () => __testOnlyChildCanonicalization.assertSafeChildPointerPath(value, 'proof filePath', win32),
      CiEvidencePackError,
    );
  }
});

test('hardlink aliases of distinct proof and summary pointers reject when linkSync is supported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const { unlinkSync } = require('node:fs');
  unlinkSync(path.join(root, 'proofs', 'ios.json'));
  try {
    linkSync(path.join(root, 'proofs', 'android.json'), path.join(root, 'proofs', 'ios.json'));
  } catch {
    return;
  }
  const input = baseInput(live);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /duplicate canonical proof filePath/,
  );
});

test('trailing child lstat failure after realpath is a changed-during-verification CiEvidencePackError', () => {
  const posix = path.posix;
  const root = '/artifacts';
  const child = '/artifacts/proofs/android.json';
  let lstatCalls = 0;
  const io = {
    lstatSync: (filePath: string) => {
      lstatCalls += 1;
      if (lstatCalls === 1) {
        return {
          dev: 1,
          ino: 10,
          size: 1,
          nlink: 1,
          mtimeMs: 1,
          ctimeMs: 1,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      }
      const error = new Error('ENOENT');
      (error as { code?: string }).code = 'ENOENT';
      throw error;
    },
    realpathSync: (filePath: string) => filePath,
  };
  assert.throws(
    () =>
      __testOnlyChildCanonicalization.canonicalize(child, root, 'proof filePath', posix, io),
    (error: unknown) =>
      error instanceof CiEvidencePackError &&
      /changed during verification/.test((error as Error).message),
  );
});

test('stable contained file reader containment uses injected realpathSync', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  writeChildFiles(root);
  const target = path.join(root, 'live-proof-set.json');
  writeFileSync(target, 'hello\n');
  const real = require('node:fs');
  const seen: string[] = [];
  const io = {
    openSync: real.openSync,
    readSync: real.readSync,
    fstatSync: real.fstatSync,
    closeSync: real.closeSync,
    realpathSync: (filePath: string) => {
      seen.push(filePath);
      return real.realpathSync(filePath);
    },
    lstatSync: real.lstatSync,
    statSync: real.statSync,
  };
  const bytes = __testOnlyStableContainedFileReader.read(
    target,
    real.realpathSync(root),
    'live-proof-set referenced file',
    io,
  );
  assert.equal(Buffer.from(bytes).toString('utf8'), 'hello\n');
  assert.ok(seen.length >= 2);
  assert.ok(seen.some((value) => value === target || value === real.realpathSync(target)));
});

test('cross-kind hardlink aliases reject when linkSync is supported', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ci-pack-assembler-'));
  const live = writeLiveProofSet(root, liveProofSetPayload());
  const { unlinkSync } = require('node:fs');
  unlinkSync(path.join(root, 'summaries', 'android.json'));
  try {
    linkSync(path.join(root, 'proofs', 'android.json'), path.join(root, 'summaries', 'android.json'));
  } catch {
    return;
  }
  const input = baseInput(live);
  assert.throws(
    () => verifyCiEvidencePackLiveProofSet(input, { artifactRoot: root }),
    /alias/,
  );
});
