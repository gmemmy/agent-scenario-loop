const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { ARTIFACT_FILENAMES, createArtifactLayout } = require('../artifact-layout');
const {
  assertCiEvidencePackRunRelativePath,
  buildCiEvidencePack,
  CiEvidencePackError,
  readCiEvidencePack,
} = require('../ci-evidence-pack');
const { SCHEMAS, assertValidJson } = require('../schema-validator');
import type {
  CiEvidencePackArtifactKind,
  CiEvidencePackBuildInput,
  CiEvidencePackEvidenceRecord,
  CiEvidencePackPlatform,
} from '../ci-evidence-pack';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type PackInput = CiEvidencePackBuildInput;
type EvidenceRecord = CiEvidencePackEvidenceRecord;

function presentEvidence(
  evidenceId: string,
  attemptId: string,
  platform: CiEvidencePackPlatform,
  kind: CiEvidencePackArtifactKind,
): EvidenceRecord {
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

function attemptEvidence(platform: 'android' | 'ios', attemptId: string): {
  evidence: EvidenceRecord[];
  evidenceIds: string[];
} {
  const kinds = ['recording', 'verdict'] as const;
  const evidence = kinds.map((kind) => presentEvidence(`${attemptId}-${kind}`, attemptId, platform, kind));
  return { evidence, evidenceIds: evidence.map((item) => item.evidenceId) };
}

function validInput(): PackInput {
  const androidRetry = attemptEvidence('android', 'android-retry');
  const androidFail = attemptEvidence('android', 'android-fail');
  const iosPass = attemptEvidence('ios', 'ios-pass');
  return {
    schemaVersion: '1.0.0' as const,
    packId: 'pack-1',
    createdAt: '2026-08-22T00:00:00.000Z',
    source: { expectedSha: SHA, observedSha: SHA, status: 'current' as const },
    liveProofSet: {
      relativePath: 'live-proof-set.json',
      sha256: SHA256,
      byteSize: 100,
      runId: 'run-1',
      status: 'passed' as const,
    },
    requiredPlatforms: ['android', 'ios'] as Array<'android' | 'ios'>,
    requiredEvidenceKinds: ['recording', 'verdict'] as Array<'recording' | 'verdict'>,
    platforms: [
      {
        platform: 'android' as const,
        authorityStatus: 'supported' as const,
        evaluationStatus: 'passed' as const,
        selectedAttemptId: 'android-retry',
      },
      {
        platform: 'ios' as const,
        authorityStatus: 'supported' as const,
        evaluationStatus: 'passed' as const,
        selectedAttemptId: 'ios-pass',
      },
    ],
    attempts: [
      {
        attemptId: 'android-fail',
        platform: 'android' as const,
        scenarioId: 'scenario-a',
        runId: 'run-fail',
        status: 'failed' as const,
        startedAt: '2026-08-22T00:00:00.000Z',
        evidenceIds: androidFail.evidenceIds,
      },
      {
        attemptId: 'android-retry',
        platform: 'android' as const,
        scenarioId: 'scenario-a',
        runId: 'run-1',
        status: 'passed' as const,
        startedAt: '2026-08-22T00:01:00.000Z',
        predecessorAttemptId: 'android-fail',
        evidenceIds: androidRetry.evidenceIds,
      },
      {
        attemptId: 'ios-pass',
        platform: 'ios' as const,
        scenarioId: 'scenario-a',
        runId: 'run-1',
        status: 'passed' as const,
        startedAt: '2026-08-22T00:02:00.000Z',
        evidenceIds: iosPass.evidenceIds,
      },
    ],
    evidence: [...androidFail.evidence, ...androidRetry.evidence, ...iosPass.evidence],
    verdicts: [
      {
        scenarioId: 'scenario-a',
        runId: 'run-1',
        platform: 'android' as const,
        status: 'passed' as const,
        evidenceId: 'android-retry-verdict',
      },
      {
        scenarioId: 'scenario-a',
        runId: 'run-1',
        platform: 'ios' as const,
        status: 'passed' as const,
        evidenceId: 'ios-pass-verdict',
      },
    ],
    comparisonStatus: 'comparable' as const,
    completeness: { status: 'complete' as const, reasons: [] as string[] },
    assembly: { status: 'succeeded' as const, reasons: [] as string[] },
    summary: 'android and ios evidence assembled',
    nextAction: 'publish receipt in a later slice',
  };
}

function cloneInput(): PackInput {
  return JSON.parse(JSON.stringify(validInput())) as PackInput;
}

function requiredItem<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe('ci evidence pack', () => {
  it('derives mechanism succeeded and two-platform passed for a complete pack', () => {
    const pack = buildCiEvidencePack(cloneInput());
    assert.equal(pack.mechanismStatus, 'succeeded');
    assert.equal(pack.twoPlatformClaim.status, 'passed');
    assertValidJson(pack, SCHEMAS.ciEvidencePack, 'ci-evidence-pack');
  });

  it('keeps mechanism succeeded when source is stale and fails the two-platform claim', () => {
    const input = cloneInput();
    input.source = {
      expectedSha: SHA,
      observedSha: 'cccccccccccccccccccccccccccccccccccccccc',
      status: 'stale',
    };
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.mechanismStatus, 'succeeded');
    assert.equal(pack.twoPlatformClaim.status, 'failed');
  });

  it('fails when the iOS platform record is missing and never uses not_applicable', () => {
    const input = cloneInput();
    input.platforms = input.platforms.filter((record) => record.platform !== 'ios');
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.twoPlatformClaim.status, 'failed');
    assert.equal(JSON.stringify(pack).includes('not_applicable'), false);
  });

  it('marks unsupported selected authority as not_evaluable', () => {
    const input = cloneInput();
    const ios = requiredItem(
      input.platforms.find((record) => record.platform === 'ios'),
      'ios platform',
    );
    ios.authorityStatus = 'unsupported';
    ios.evaluationStatus = 'not_evaluable';
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.twoPlatformClaim.status, 'not_evaluable');
  });

  it('lets a selected retry pass while the prior failed attempt remains', () => {
    const pack = buildCiEvidencePack(cloneInput());
    const failed = requiredItem(
      pack.attempts.find((attempt: { attemptId: string }) => attempt.attemptId === 'android-fail'),
      'android-fail attempt',
    );
    const retry = requiredItem(
      pack.attempts.find((attempt: { attemptId: string }) => attempt.attemptId === 'android-retry'),
      'android-retry attempt',
    );
    assert.equal(failed.status, 'failed');
    assert.equal(retry.predecessorAttemptId, 'android-fail');
    assert.equal(pack.twoPlatformClaim.status, 'passed');
  });

  it('fails when the selected attempt failed', () => {
    const input = cloneInput();
    const android = requiredItem(
      input.platforms.find((record) => record.platform === 'android'),
      'android platform',
    );
    android.selectedAttemptId = 'android-fail';
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.twoPlatformClaim.status, 'failed');
  });

  it('fails when required recording evidence is missing', () => {
    const input = cloneInput();
    const recordingIndex = input.evidence.findIndex((item) => item.evidenceId === 'ios-pass-recording');
    assert.notEqual(recordingIndex, -1);
    const recording = requiredItem(input.evidence[recordingIndex], 'ios recording');
    input.evidence[recordingIndex] = {
      evidenceId: recording.evidenceId,
      attemptId: recording.attemptId,
      platform: recording.platform,
      kind: 'recording',
      status: 'missing',
      reason: 'recording not produced',
    };
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.twoPlatformClaim.status, 'failed');
  });

  it('marks inconclusive and not_evaluated verdicts as not_evaluable', () => {
    const inconclusive = cloneInput();
    const androidVerdict = requiredItem(
      inconclusive.verdicts.find((item) => item.platform === 'android'),
      'android verdict',
    );
    androidVerdict.status = 'inconclusive';
    assert.equal(buildCiEvidencePack(inconclusive).twoPlatformClaim.status, 'not_evaluable');

    const notEvaluated = cloneInput();
    const iosVerdict = requiredItem(
      notEvaluated.verdicts.find((item) => item.platform === 'ios'),
      'ios verdict',
    );
    iosVerdict.status = 'not_evaluated';
    assert.equal(buildCiEvidencePack(notEvaluated).twoPlatformClaim.status, 'not_evaluable');
  });

  it('rejects absolute POSIX, drive, backslash, and parent traversal paths', () => {
    assert.throws(() => assertCiEvidencePackRunRelativePath('/tmp/pack.json'), CiEvidencePackError);
    assert.throws(() => assertCiEvidencePackRunRelativePath('C:\\pack.json'), CiEvidencePackError);
    assert.throws(() => assertCiEvidencePackRunRelativePath('\\\\server\\share'), CiEvidencePackError);
    assert.throws(() => assertCiEvidencePackRunRelativePath('../up.json'), CiEvidencePackError);
  });

  it('rejects duplicate ids and cross-platform or cross-attempt references', () => {
    const duplicates = cloneInput();
    const firstAttempt = requiredItem(duplicates.attempts[0], 'first attempt');
    duplicates.attempts.push({ ...firstAttempt, evidenceIds: [...firstAttempt.evidenceIds] });
    assert.throws(() => buildCiEvidencePack(duplicates), CiEvidencePackError);

    const crossPlatform = cloneInput();
    const android = requiredItem(
      crossPlatform.platforms.find((record) => record.platform === 'android'),
      'android platform',
    );
    android.selectedAttemptId = 'ios-pass';
    assert.throws(() => buildCiEvidencePack(crossPlatform), CiEvidencePackError);

    const crossAttempt = cloneInput();
    const evidence = requiredItem(
      crossAttempt.evidence.find((item) => item.evidenceId === 'ios-pass-recording'),
      'ios recording evidence',
    );
    evidence.attemptId = 'android-retry';
    assert.throws(() => buildCiEvidencePack(crossAttempt), CiEvidencePackError);
  });

  it('rejects current source whose observed SHA does not match expected', () => {
    const input = cloneInput();
    input.source = {
      expectedSha: SHA,
      observedSha: 'dddddddddddddddddddddddddddddddddddddddd',
      status: 'current',
    };
    assert.throws(() => buildCiEvidencePack(input), CiEvidencePackError);
  });

  it('schema-rejects present evidence without hash/bytes and non-present evidence with present-only fields', () => {
    const pack = buildCiEvidencePack(cloneInput());
    assert.throws(() => {
      assertValidJson(
        {
          ...pack,
          evidence: [
            {
              evidenceId: 'bad-present',
              attemptId: 'android-retry',
              platform: 'android',
              kind: 'log',
              status: 'present',
            },
          ],
        },
        SCHEMAS.ciEvidencePack,
        'present evidence without hash',
      );
    });
    assert.throws(() => {
      assertValidJson(
        {
          ...pack,
          evidence: [
            {
              evidenceId: 'bad-missing',
              attemptId: 'android-retry',
              platform: 'android',
              kind: 'log',
              status: 'missing',
              reason: 'gone',
              relativePath: 'evidence/x.bin',
              sha256: SHA256,
              byteSize: 1,
            },
          ],
        },
        SCHEMAS.ciEvidencePack,
        'non-present evidence with present-only fields',
      );
    });
  });

  it('reader rejects tampered mechanism or two-platform derived results', () => {
    const pack = buildCiEvidencePack(cloneInput());
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-pack-'));
    const filePath = path.join(dir, 'ci-evidence-pack.json');
    writeFileSync(filePath, JSON.stringify({ ...pack, mechanismStatus: 'failed' }), 'utf8');
    assert.throws(() => readCiEvidencePack(filePath), CiEvidencePackError);
    writeFileSync(
      filePath,
      JSON.stringify({
        ...pack,
        twoPlatformClaim: { status: 'failed', reasons: ['tampered'] },
      }),
      'utf8',
    );
    assert.throws(() => readCiEvidencePack(filePath), CiEvidencePackError);
  });

  it('rejects malformed and noncanonical timestamps', () => {
    const createdAt = cloneInput();
    createdAt.createdAt = '2026-08-22T00:00:00Z';
    assert.throws(() => buildCiEvidencePack(createdAt), CiEvidencePackError);

    const startedAt = cloneInput();
    const attempt = requiredItem(startedAt.attempts[0], 'first attempt');
    attempt.startedAt = 'not-a-timestamp';
    assert.throws(() => buildCiEvidencePack(startedAt), CiEvidencePackError);

    const endedBeforeStart = cloneInput();
    const timedAttempt = requiredItem(endedBeforeStart.attempts[0], 'first attempt');
    timedAttempt.startedAt = '2026-08-22T00:02:00.000Z';
    timedAttempt.endedAt = '2026-08-22T00:01:00.000Z';
    assert.throws(() => buildCiEvidencePack(endedBeforeStart), CiEvidencePackError);
  });

  it('artifact layout exposes ci-evidence-pack.json', () => {
    assert.equal(ARTIFACT_FILENAMES.ciEvidencePack, 'ci-evidence-pack.json');
    const layout = createArtifactLayout({ outputDir: '/tmp/run' });
    assert.equal(layout.ciEvidencePack, path.join('/tmp/run', 'ci-evidence-pack.json'));
  });
});
