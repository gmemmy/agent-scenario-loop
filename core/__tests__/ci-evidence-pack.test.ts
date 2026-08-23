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
  deriveCiEvidencePackTwoPlatformClaim,
  parseCiEvidencePackBytes,
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
        attemptNumber: 1,
        maxAttempts: 2,
        startedAt: '2026-08-22T00:00:00.000Z',
        endedAt: '2026-08-22T00:00:30.000Z',
        evidenceIds: androidFail.evidenceIds,
      },
      {
        attemptId: 'android-retry',
        platform: 'android' as const,
        scenarioId: 'scenario-a',
        runId: 'run-1',
        status: 'passed' as const,
        attemptNumber: 2,
        maxAttempts: 2,
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
        attemptNumber: 1,
        maxAttempts: 1,
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

  it('keeps twoPlatformClaim passed when product verdicts are failed, inconclusive, or not_evaluated', () => {
    const failed = cloneInput();
    const androidVerdict = requiredItem(
      failed.verdicts.find((item) => item.platform === 'android'),
      'android verdict',
    );
    androidVerdict.status = 'failed';
    assert.equal(buildCiEvidencePack(failed).twoPlatformClaim.status, 'passed');

    const inconclusive = cloneInput();
    const androidInconclusive = requiredItem(
      inconclusive.verdicts.find((item) => item.platform === 'android'),
      'android verdict',
    );
    androidInconclusive.status = 'inconclusive';
    assert.equal(buildCiEvidencePack(inconclusive).twoPlatformClaim.status, 'passed');

    const notEvaluated = cloneInput();
    const iosVerdict = requiredItem(
      notEvaluated.verdicts.find((item) => item.platform === 'ios'),
      'ios verdict',
    );
    iosVerdict.status = 'not_evaluated';
    assert.equal(buildCiEvidencePack(notEvaluated).twoPlatformClaim.status, 'passed');
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

  it('requires exactly android and ios plus recording and verdict kinds', () => {
    const platforms = cloneInput();
    platforms.requiredPlatforms = ['android'] as PackInput['requiredPlatforms'];
    assert.throws(() => buildCiEvidencePack(platforms));

    const kinds = cloneInput();
    kinds.requiredEvidenceKinds = ['recording'] as PackInput['requiredEvidenceKinds'];
    assert.throws(() => buildCiEvidencePack(kinds));

    const extraKinds = cloneInput();
    extraKinds.requiredEvidenceKinds = ['recording', 'verdict', 'log'];
    extraKinds.evidence.push({
      evidenceId: 'ios-pass-log',
      attemptId: 'ios-pass',
      platform: 'ios',
      kind: 'log',
      status: 'present',
      relativePath: 'evidence/ios-pass-log.bin',
      sha256: SHA256,
      byteSize: 8,
    });
    const extraAttempt = requiredItem(
      extraKinds.attempts.find((attempt) => attempt.attemptId === 'ios-pass'),
      'ios-pass attempt',
    );
    extraAttempt.evidenceIds = [...extraAttempt.evidenceIds, 'ios-pass-log'];
    extraKinds.evidence.push({
      evidenceId: 'android-retry-log',
      attemptId: 'android-retry',
      platform: 'android',
      kind: 'log',
      status: 'present',
      relativePath: 'evidence/android-retry-log.bin',
      sha256: SHA256,
      byteSize: 8,
    });
    const extraAndroid = requiredItem(
      extraKinds.attempts.find((attempt) => attempt.attemptId === 'android-retry'),
      'android-retry attempt',
    );
    extraAndroid.evidenceIds = [...extraAndroid.evidenceIds, 'android-retry-log'];
    assert.equal(buildCiEvidencePack(extraKinds).twoPlatformClaim.status, 'passed');
  });

  it('accepts reversed requiredPlatforms order in schema and build', () => {
    const input = cloneInput();
    input.requiredPlatforms = ['ios', 'android'];
    const pack = buildCiEvidencePack(input);
    assert.deepEqual(pack.requiredPlatforms, ['ios', 'android']);
    assert.doesNotThrow(() => assertValidJson(pack, SCHEMAS.ciEvidencePack, 'reversed platforms'));
  });

  it('rejects unsafe run-relative paths in schema and build', () => {
    const unsafePaths = [
      '/absolute/pack.bin',
      '\\windows\\pack.bin',
      '\\\\unc\\share\\pack.bin',
      'C:/drive/pack.bin',
      'evidence\\backslash.bin',
      'evidence/./dot.bin',
      'evidence/../parent.bin',
      'evidence//empty.bin',
    ];

    for (const relativePath of unsafePaths) {
      assert.throws(() => assertCiEvidencePackRunRelativePath(relativePath), CiEvidencePackError);

      const live = cloneInput();
      live.liveProofSet.relativePath = relativePath;
      assert.throws(() => buildCiEvidencePack(live), CiEvidencePackError);
      const livePack = {
        ...buildCiEvidencePack(cloneInput()),
        liveProofSet: { ...buildCiEvidencePack(cloneInput()).liveProofSet, relativePath },
      };
      assert.throws(() => assertValidJson(livePack, SCHEMAS.ciEvidencePack, `unsafe liveProofSet ${relativePath}`));

      const present = cloneInput();
      const recording = requiredItem(
        present.evidence.find((item) => item.evidenceId === 'ios-pass-recording'),
        'ios recording',
      );
      if (recording.status === 'present') {
        recording.relativePath = relativePath;
      }
      assert.throws(() => buildCiEvidencePack(present), CiEvidencePackError);
      const presentPack = buildCiEvidencePack(cloneInput());
      const presentEvidenceList: EvidenceRecord[] = presentPack.evidence;
      const presentEvidence = requiredItem(
        presentEvidenceList.find((item) => item.evidenceId === 'ios-pass-recording'),
        'ios recording pack',
      );
      if (presentEvidence.status === 'present') {
        presentEvidence.relativePath = relativePath;
      }
      assert.throws(() =>
        assertValidJson(presentPack, SCHEMAS.ciEvidencePack, `unsafe evidence ${relativePath}`),
      );
    }
  });

  it('rejects duplicate verdict platform+scenarioId+runId identity', () => {
    const input = cloneInput();
    const first = requiredItem(input.verdicts[0], 'first verdict');
    input.verdicts.push({ ...first, evidenceId: 'android-fail-verdict' });
    assert.throws(() => buildCiEvidencePack(input), CiEvidencePackError);
  });

  it('classifies duplicate-kind evidence from every matching row, not first match', () => {
    const presentThenMissing = cloneInput();
    presentThenMissing.evidence.push({
      evidenceId: 'ios-pass-recording-extra-missing',
      attemptId: 'ios-pass',
      platform: 'ios',
      kind: 'recording',
      status: 'missing',
      reason: 'second recording missing',
    });
    const extraIds = requiredItem(
      presentThenMissing.attempts.find((attempt) => attempt.attemptId === 'ios-pass'),
      'ios-pass attempt',
    );
    extraIds.evidenceIds = [...extraIds.evidenceIds, 'ios-pass-recording-extra-missing'];
    assert.equal(buildCiEvidencePack(presentThenMissing).twoPlatformClaim.status, 'passed');

    const missingThenPresent = cloneInput();
    missingThenPresent.evidence.unshift({
      evidenceId: 'ios-pass-recording-extra-missing-first',
      attemptId: 'ios-pass',
      platform: 'ios',
      kind: 'recording',
      status: 'missing',
      reason: 'first recording missing',
    });
    const iosAttempt = requiredItem(
      missingThenPresent.attempts.find((attempt) => attempt.attemptId === 'ios-pass'),
      'ios-pass attempt',
    );
    iosAttempt.evidenceIds = ['ios-pass-recording-extra-missing-first', ...iosAttempt.evidenceIds];
    assert.equal(buildCiEvidencePack(missingThenPresent).twoPlatformClaim.status, 'passed');

    const onlyUnavailable = cloneInput();
    const recordingIndex = onlyUnavailable.evidence.findIndex((item) => item.evidenceId === 'ios-pass-recording');
    const recording = requiredItem(onlyUnavailable.evidence[recordingIndex], 'ios recording');
    onlyUnavailable.evidence[recordingIndex] = {
      evidenceId: recording.evidenceId,
      attemptId: recording.attemptId,
      platform: recording.platform,
      kind: 'recording',
      status: 'not_available',
      reason: 'recording not offered',
    };
    onlyUnavailable.evidence.push({
      evidenceId: 'ios-pass-recording-alt',
      attemptId: 'ios-pass',
      platform: 'ios',
      kind: 'recording',
      status: 'not_available',
      reason: 'alternate recording not offered',
    });
    const onlyAttempt = requiredItem(
      onlyUnavailable.attempts.find((attempt) => attempt.attemptId === 'ios-pass'),
      'ios-pass attempt',
    );
    onlyAttempt.evidenceIds = [...onlyAttempt.evidenceIds, 'ios-pass-recording-alt'];
    assert.equal(buildCiEvidencePack(onlyUnavailable).twoPlatformClaim.status, 'not_evaluable');
  });

  it('keeps unsupported authority not_evaluable even when a retained attempt failed', () => {
    const input = cloneInput();
    const ios = requiredItem(
      input.platforms.find((record) => record.platform === 'ios'),
      'ios platform',
    );
    ios.authorityStatus = 'unsupported';
    ios.evaluationStatus = 'not_evaluable';
    delete ios.selectedAttemptId;
    const iosAttempt = requiredItem(
      input.attempts.find((attempt) => attempt.attemptId === 'ios-pass'),
      'ios-pass attempt',
    );
    iosAttempt.status = 'failed';
    assert.equal(buildCiEvidencePack(input).twoPlatformClaim.status, 'not_evaluable');
  });

  it('throws when derive receives an incoherent inventory', () => {
    const input = cloneInput();
    input.attempts = [];
    assert.throws(() => deriveCiEvidencePackTwoPlatformClaim(input), CiEvidencePackError);
  });

  it('rejects duplicate present paths and dot path segments', () => {
    const duplicates = cloneInput();
    const second = requiredItem(
      duplicates.evidence.find((item) => item.evidenceId === 'ios-pass-recording'),
      'ios recording',
    );
    if (second.status === 'present') {
      second.relativePath = 'evidence/android-retry-recording.bin';
    }
    assert.throws(() => buildCiEvidencePack(duplicates), CiEvidencePackError);

    assert.throws(() => assertCiEvidencePackRunRelativePath('evidence/./pack.bin'), CiEvidencePackError);
    const dotted = cloneInput();
    const live = dotted.liveProofSet;
    live.relativePath = 'dir/./live-proof-set.json';
    assert.throws(() => buildCiEvidencePack(dotted), CiEvidencePackError);
  });

  it('enforces exact SHA and source-status observedSha rules', () => {
    const midLength = cloneInput();
    midLength.source = {
      expectedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      observedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'current',
    };
    assert.throws(() => buildCiEvidencePack(midLength), CiEvidencePackError);

    const missingObserved = cloneInput();
    missingObserved.source = { expectedSha: SHA, status: 'missing' };
    assert.equal(buildCiEvidencePack(missingObserved).mechanismStatus, 'succeeded');

    const missingWithObserved = cloneInput();
    missingWithObserved.source = {
      expectedSha: SHA,
      observedSha: SHA,
      status: 'missing',
    };
    assert.throws(() => buildCiEvidencePack(missingWithObserved), CiEvidencePackError);

    const staleSame = cloneInput();
    staleSame.source = { expectedSha: SHA, observedSha: SHA, status: 'stale' };
    assert.throws(() => buildCiEvidencePack(staleSame), CiEvidencePackError);

    const pack = buildCiEvidencePack(cloneInput());
    assert.throws(() => {
      assertValidJson(
        {
          ...pack,
          source: {
            expectedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            observedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            status: 'current',
          },
        },
        SCHEMAS.ciEvidencePack,
        'sha length 41',
      );
    });
    assert.throws(() => {
      assertValidJson(
        {
          ...pack,
          source: { expectedSha: SHA, status: 'current' },
        },
        SCHEMAS.ciEvidencePack,
        'current without observedSha',
      );
    });
    assert.throws(() => {
      assertValidJson(
        {
          ...pack,
          source: { expectedSha: SHA, observedSha: SHA, status: 'missing' },
        },
        SCHEMAS.ciEvidencePack,
        'missing with observedSha',
      );
    });
  });

  it('requires attemptNumber/maxAttempts and valid predecessor lineage', () => {
    const firstHasPredecessor = cloneInput();
    const fail = requiredItem(
      firstHasPredecessor.attempts.find((attempt) => attempt.attemptId === 'android-fail'),
      'android-fail',
    );
    fail.predecessorAttemptId = 'android-retry';
    assert.throws(() => buildCiEvidencePack(firstHasPredecessor), CiEvidencePackError);

    const retryMissingPredecessor = cloneInput();
    const retry = requiredItem(
      retryMissingPredecessor.attempts.find((attempt) => attempt.attemptId === 'android-retry'),
      'android-retry',
    );
    delete retry.predecessorAttemptId;
    assert.throws(() => buildCiEvidencePack(retryMissingPredecessor), CiEvidencePackError);

    const crossPlatform = cloneInput();
    const androidRetry = requiredItem(
      crossPlatform.attempts.find((attempt) => attempt.attemptId === 'android-retry'),
      'android-retry',
    );
    androidRetry.predecessorAttemptId = 'ios-pass';
    assert.throws(() => buildCiEvidencePack(crossPlatform), CiEvidencePackError);

    const skipped = cloneInput();
    const skippedRetry = requiredItem(
      skipped.attempts.find((attempt) => attempt.attemptId === 'android-retry'),
      'android-retry',
    );
    skippedRetry.attemptNumber = 3;
    skippedRetry.maxAttempts = 3;
    assert.throws(() => buildCiEvidencePack(skipped), CiEvidencePackError);

    const missingEndedAt = cloneInput();
    const predecessor = requiredItem(
      missingEndedAt.attempts.find((attempt) => attempt.attemptId === 'android-fail'),
      'android-fail',
    );
    delete predecessor.endedAt;
    assert.throws(() => buildCiEvidencePack(missingEndedAt), CiEvidencePackError);

    const inverted = cloneInput();
    const invertedPredecessor = requiredItem(
      inverted.attempts.find((attempt) => attempt.attemptId === 'android-fail'),
      'android-fail',
    );
    invertedPredecessor.endedAt = '2026-08-22T00:02:00.000Z';
    assert.throws(() => buildCiEvidencePack(inverted), CiEvidencePackError);
  });

  it('enforces completeness and assembly reason coherence plus unsupported evaluation', () => {
    const completeReasons = cloneInput();
    completeReasons.completeness = { status: 'complete', reasons: ['extra'] };
    assert.throws(() => buildCiEvidencePack(completeReasons));

    const incompleteEmpty = cloneInput();
    incompleteEmpty.completeness = { status: 'incomplete', reasons: [] };
    assert.throws(() => buildCiEvidencePack(incompleteEmpty));

    const assemblyFailedEmpty = cloneInput();
    assemblyFailedEmpty.assembly = { status: 'failed', reasons: [] };
    assert.throws(() => buildCiEvidencePack(assemblyFailedEmpty));

    const supportedWithoutSelected = cloneInput();
    const android = requiredItem(
      supportedWithoutSelected.platforms.find((record) => record.platform === 'android'),
      'android platform',
    );
    delete android.selectedAttemptId;
    assert.throws(() => buildCiEvidencePack(supportedWithoutSelected));

    const unsupportedPassed = cloneInput();
    const ios = requiredItem(
      unsupportedPassed.platforms.find((record) => record.platform === 'ios'),
      'ios platform',
    );
    ios.authorityStatus = 'unsupported';
    ios.evaluationStatus = 'passed';
    assert.throws(() => buildCiEvidencePack(unsupportedPassed));
  });

  it('keeps comparisonStatus not_available separate from a passed two-platform claim', () => {
    const input = cloneInput();
    input.comparisonStatus = 'not_available';
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.comparisonStatus, 'not_available');
    assert.equal(pack.twoPlatformClaim.status, 'passed');
  });

  it('parses schema-valid UTF-8 pack bytes without mutating caller bytes', () => {
    const pack = buildCiEvidencePack(cloneInput());
    const bytes = new TextEncoder().encode(JSON.stringify(pack));
    const original = Uint8Array.from(bytes);
    const parsed = parseCiEvidencePackBytes(bytes);
    assert.deepEqual(parsed, pack);
    assert.deepEqual(bytes, original);
  });

  it('rejects invalid UTF-8 pack bytes', () => {
    assert.throws(() => parseCiEvidencePackBytes(new Uint8Array([0xff, 0xfe, 0xfd])), CiEvidencePackError);
  });

  it('rejects malformed JSON pack bytes', () => {
    assert.throws(() => parseCiEvidencePackBytes(new TextEncoder().encode('{not-json')), CiEvidencePackError);
  });

  it('rejects schema-invalid JSON pack bytes', () => {
    assert.throws(
      () => parseCiEvidencePackBytes(new TextEncoder().encode(JSON.stringify({ schemaVersion: '1.0.0' }))),
      (error: unknown) => error instanceof CiEvidencePackError,
    );
  });

  it('rejects tampered derived mechanismStatus or twoPlatformClaim through existing semantics', () => {
    const pack = buildCiEvidencePack(cloneInput());
    assert.throws(
      () =>
        parseCiEvidencePackBytes(
          new TextEncoder().encode(JSON.stringify({ ...pack, mechanismStatus: 'failed' })),
        ),
      CiEvidencePackError,
    );
    assert.throws(
      () =>
        parseCiEvidencePackBytes(
          new TextEncoder().encode(
            JSON.stringify({
              ...pack,
              twoPlatformClaim: { status: 'failed', reasons: ['tampered'] },
            }),
          ),
        ),
      CiEvidencePackError,
    );
  });

  it('rejects non-Uint8Array input supplied through an unknown boundary', () => {
    const unknown: unknown = [123];
    assert.throws(() => parseCiEvidencePackBytes(unknown as Uint8Array), CiEvidencePackError);
  });
});
