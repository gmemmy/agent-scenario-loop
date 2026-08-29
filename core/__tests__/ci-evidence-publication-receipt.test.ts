const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const { buildCiEvidencePack } = require('../ci-evidence-pack');
const {
  assertCiEvidencePublicationReceiptForExactPackBytes,
  assertCiEvidencePublicationReceiptForPack,
  buildCiEvidencePublicationReceipt,
  CiEvidencePublicationReceiptError,
  readCiEvidencePublicationReceipt,
} = require('../ci-evidence-publication-receipt');
const { SCHEMAS, assertValidJson, SchemaValidationError } = require('../schema-validator');
import type { CiEvidencePack, CiEvidencePackBuildInput } from '../ci-evidence-pack';
import type {
  CiEvidencePublicationItemOutcome,
  CiEvidencePublicationReceipt,
  CiEvidencePublicationReceiptFacts,
} from '../ci-evidence-publication-receipt';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function presentEvidence(
  evidenceId: string,
  attemptId: string,
  platform: 'android' | 'ios',
  kind: 'recording' | 'verdict',
) {
  return {
    evidenceId,
    attemptId,
    platform,
    kind,
    status: 'present' as const,
    relativePath: `evidence/${evidenceId}.bin`,
    sha256: SHA256,
    byteSize: 12,
  };
}

function attemptEvidence(platform: 'android' | 'ios', attemptId: string) {
  const kinds = ['recording', 'verdict'] as const;
  const evidence = kinds.map((kind) => presentEvidence(`${attemptId}-${kind}`, attemptId, platform, kind));
  return { evidence, evidenceIds: evidence.map((item) => item.evidenceId) };
}

function validPackInput(): CiEvidencePackBuildInput {
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
    requiredPlatforms: ['android', 'ios'],
    requiredEvidenceKinds: ['recording', 'verdict'],
    platforms: [
      {
        platform: 'android',
        authorityStatus: 'supported',
        evaluationStatus: 'passed',
        selectedAttemptId: 'android-retry',
      },
      {
        platform: 'ios',
        authorityStatus: 'supported',
        evaluationStatus: 'passed',
        selectedAttemptId: 'ios-pass',
      },
    ],
    attempts: [
      {
        attemptId: 'android-fail',
        platform: 'android',
        scenarioId: 'scenario-a',
        runId: 'run-fail',
        status: 'failed',
        attemptNumber: 1,
        maxAttempts: 2,
        startedAt: '2026-08-22T00:00:00.000Z',
        endedAt: '2026-08-22T00:00:30.000Z',
        evidenceIds: androidFail.evidenceIds,
      },
      {
        attemptId: 'android-retry',
        platform: 'android',
        scenarioId: 'scenario-a',
        runId: 'run-1',
        status: 'passed',
        attemptNumber: 2,
        maxAttempts: 2,
        startedAt: '2026-08-22T00:01:00.000Z',
        predecessorAttemptId: 'android-fail',
        evidenceIds: androidRetry.evidenceIds,
      },
      {
        attemptId: 'ios-pass',
        platform: 'ios',
        scenarioId: 'scenario-a',
        runId: 'run-1',
        status: 'passed',
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
        platform: 'android',
        status: 'passed',
        evidenceId: 'android-retry-verdict',
      },
      {
        scenarioId: 'scenario-a',
        runId: 'run-1',
        platform: 'ios',
        status: 'passed',
        evidenceId: 'ios-pass-verdict',
      },
    ],
    comparisonStatus: 'comparable',
    completeness: { status: 'complete', reasons: [] },
    assembly: { status: 'succeeded', reasons: [] },
    summary: 'android and ios evidence assembled',
    nextAction: 'publish receipt in a later slice',
  };
}

function packBytes(pack: CiEvidencePack): Uint8Array {
  return Buffer.from(JSON.stringify(pack), 'utf8');
}

function publishedOutcome(requestId: string) {
  return {
    requestId,
    status: 'published' as const,
    url: 'https://example.test/artifacts/ci-evidence-pack.json',
    visibility: 'public' as const,
    publishedAt: '2026-08-22T03:00:00.000Z',
  };
}

function validFacts(): CiEvidencePublicationReceiptFacts {
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
      { requestId: 'req-ev', targetKind: 'evidence', evidenceId: 'ios-pass-recording' },
    ],
    outcomes: [
      publishedOutcome('req-pack'),
      publishedOutcome('req-lps'),
      publishedOutcome('req-ev'),
    ],
  };
}

function cloneFacts(): CiEvidencePublicationReceiptFacts {
  return JSON.parse(JSON.stringify(validFacts())) as CiEvidencePublicationReceiptFacts;
}

function writeReceipt(receipt: CiEvidencePublicationReceipt): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-pub-receipt-'));
  const filePath = path.join(dir, 'ci-evidence-publication-receipt.json');
  writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`);
  return filePath;
}

function requiredItem<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe('ci evidence publication receipt', () => {
  it('builds a schema-valid all-published receipt and reads it back', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: cloneFacts() });
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(receipt.reasons, []);
    assert.equal(receipt.pack.mechanismStatus, pack.mechanismStatus);
    assert.equal(receipt.pack.twoPlatformClaim.status, pack.twoPlatformClaim.status);
    assert.equal(receipt.pack.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.pack.byteSize, bytes.byteLength);
    assertValidJson(receipt, SCHEMAS.ciEvidencePublicationReceipt, 'ci-evidence-publication-receipt');
    const roundTrip = readCiEvidencePublicationReceipt(writeReceipt(receipt), bytes);
    assert.deepEqual(roundTrip, receipt);
  });

  it('derives partial, failed, and not_published from publication mechanics only', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);

    const partialFacts = cloneFacts();
    partialFacts.outcomes[1] = {
      requestId: 'req-lps',
      status: 'omitted',
      reason: 'live proof set withheld',
    };
    const partial = buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: partialFacts });
    assert.equal(partial.publicationStatus, 'partial');
    assert.ok(partial.reasons.length > 0);

    const failedFacts = cloneFacts();
    failedFacts.outcomes = [
      { requestId: 'req-pack', status: 'failed', reason: 'upload failed' },
      { requestId: 'req-lps', status: 'rejected', reason: 'policy rejected' },
      { requestId: 'req-ev', status: 'invalid', reason: 'url invalid' },
    ];
    const failed = buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: failedFacts });
    assert.equal(failed.publicationStatus, 'failed');
    assert.ok(failed.reasons.length > 0);

    const notPublishedFacts = cloneFacts();
    notPublishedFacts.outcomes = [
      { requestId: 'req-pack', status: 'omitted', reason: 'not requested for this run' },
      { requestId: 'req-lps', status: 'private', reason: 'kept private' },
      { requestId: 'req-ev', status: 'not_available', reason: 'publisher unavailable' },
    ];
    const notPublished = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: notPublishedFacts,
    });
    assert.equal(notPublished.publicationStatus, 'not_published');
    assert.ok(notPublished.reasons.length > 0);

    const emptyFacts = cloneFacts();
    emptyFacts.requestedItems = [];
    emptyFacts.outcomes = [];
    const empty = buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: emptyFacts });
    assert.equal(empty.publicationStatus, 'not_published');
  });

  it('copies a stale pack binding and does not launder it via published outcomes', () => {
    const input = validPackInput();
    input.source = {
      expectedSha: SHA,
      observedSha: 'cccccccccccccccccccccccccccccccccccccccc',
      status: 'stale',
    };
    const pack = buildCiEvidencePack(input);
    assert.equal(pack.twoPlatformClaim.status, 'failed');
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: packBytes(pack),
      facts: cloneFacts(),
    });
    assert.equal(receipt.publicationStatus, 'published');
    assert.equal(receipt.pack.source.status, 'stale');
    assert.equal(receipt.pack.twoPlatformClaim.status, 'failed');
    assert.equal(receipt.pack.mechanismStatus, pack.mechanismStatus);
    assert.match(receipt.summary, /publication published/);
    assert.match(receipt.summary, /twoPlatformClaim failed/);
  });

  it('leaves rejected and failed pack attempts untouched', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: packBytes(pack),
      facts: cloneFacts(),
    });
    assert.equal(receipt.publicationStatus, 'published');
    const failedAttempt = requiredItem(
      pack.attempts.find((attempt: { attemptId: string }) => attempt.attemptId === 'android-fail'),
      'android-fail',
    );
    assert.equal(failedAttempt.status, 'failed');
    assert.equal(receipt.pack.packId, pack.packId);
  });

  it('binds exact supplied bytes, including whitespace differences', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const compact = Buffer.from(JSON.stringify(pack), 'utf8');
    const pretty = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    const compactReceipt = buildCiEvidencePublicationReceipt({
      packBytes: compact,
      facts: cloneFacts(),
    });
    const prettyReceipt = buildCiEvidencePublicationReceipt({
      packBytes: pretty,
      facts: cloneFacts(),
    });
    assert.notEqual(compactReceipt.pack.sha256, prettyReceipt.pack.sha256);
    assert.notEqual(compactReceipt.pack.byteSize, prettyReceipt.pack.byteSize);
    assert.equal(compactReceipt.pack.sha256, createHash('sha256').update(compact).digest('hex'));
    assert.equal(prettyReceipt.pack.sha256, createHash('sha256').update(pretty).digest('hex'));
  });

  it('rejects duplicate requestId and duplicate targets', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const duplicateRequest = cloneFacts();
    duplicateRequest.requestedItems[1] = {
      requestId: 'req-pack',
      targetKind: 'pack_artifact',
      packArtifact: 'live_proof_set',
    };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: duplicateRequest }),
      CiEvidencePublicationReceiptError,
    );

    const duplicateTarget = cloneFacts();
    duplicateTarget.requestedItems[2] = {
      requestId: 'req-ev-2',
      targetKind: 'pack_artifact',
      packArtifact: 'ci_evidence_pack',
    };
    duplicateTarget.outcomes.push(publishedOutcome('req-ev-2'));
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: duplicateTarget }),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects unknown evidenceId and published non-present evidence', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const unknown = cloneFacts();
    unknown.requestedItems[2] = {
      requestId: 'req-ev',
      targetKind: 'evidence',
      evidenceId: 'missing-id',
    };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: unknown }),
      CiEvidencePublicationReceiptError,
    );

    const missingInput = validPackInput();
    const recordingIndex = missingInput.evidence.findIndex(
      (item) => item.evidenceId === 'ios-pass-recording',
    );
    const recording = requiredItem(missingInput.evidence[recordingIndex], 'recording');
    missingInput.evidence[recordingIndex] = {
      evidenceId: recording.evidenceId,
      attemptId: recording.attemptId,
      platform: recording.platform,
      kind: recording.kind,
      status: 'missing',
      reason: 'recording not produced',
    };
    const missingPack = buildCiEvidencePack(missingInput);
    const publishMissing = cloneFacts();
    assert.throws(
      () =>
        buildCiEvidencePublicationReceipt({
          packBytes: packBytes(missingPack),
          facts: publishMissing,
        }),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects unsafe packRelativePath and unsafe published URLs', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const unsafePath = cloneFacts();
    unsafePath.packRelativePath = '../ci-evidence-pack.json';
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: unsafePath }),
      CiEvidencePublicationReceiptError,
    );

    const credentialUrl = cloneFacts();
    credentialUrl.outcomes[0] = {
      ...publishedOutcome('req-pack'),
      url: 'https://user:pass@example.test/pack.json',
    };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: credentialUrl }),
      CiEvidencePublicationReceiptError,
    );

    const httpUrl = cloneFacts();
    httpUrl.outcomes[0] = {
      ...publishedOutcome('req-pack'),
      url: 'http://example.test/pack.json',
    };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: httpUrl }),
      CiEvidencePublicationReceiptError,
    );

    const whitespaceUrl = cloneFacts();
    whitespaceUrl.outcomes[0] = {
      ...publishedOutcome('req-pack'),
      url: 'https://example.test/pack.json ',
    };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: whitespaceUrl }),
      CiEvidencePublicationReceiptError,
    );

    const bidiUrl = cloneFacts();
    bidiUrl.outcomes[0] = {
      ...publishedOutcome('req-pack'),
      url: 'https://example.test/\u202Epack.json',
    };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: bidiUrl }),
      CiEvidencePublicationReceiptError,
    );

    const markdownUnsafeUrls = [
      'https://example.test/pack.json)ignored',
      'https://example.test/pack.json(ignored',
      'https://example.test/pack.json[ignored',
      'https://example.test/pack.json]ignored',
      'https://example.test/pack.json<ignored',
      'https://example.test/pack.json>ignored',
      'https://example.test/pack.json"ignored',
      "https://example.test/pack.json'ignored",
      'https://example.test/pack.json`ignored',
      'https://example.test/pack.json|ignored',
      'https://example.test/pack.json@ignored',
      'https://example.test/pack.json{ignored',
      'https://example.test/pack.json}ignored',
      'https://example.test/pack.json\\ignored',
    ];
    const schemaValidReceipt = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: cloneFacts(),
    });
    for (const url of markdownUnsafeUrls) {
      const markdownUrl = cloneFacts();
      markdownUrl.outcomes[0] = {
        ...publishedOutcome('req-pack'),
        url,
      };
      assert.throws(
        () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: markdownUrl }),
        CiEvidencePublicationReceiptError,
      );
      const schemaOnlyUnsafe = {
        ...schemaValidReceipt,
        outcomes: schemaValidReceipt.outcomes.map(
          (outcome: CiEvidencePublicationItemOutcome, index: number) =>
            index === 0 ? { ...outcome, url } : outcome,
        ),
      };
      assert.throws(
        () =>
          assertValidJson(
            schemaOnlyUnsafe,
            SCHEMAS.ciEvidencePublicationReceipt,
            'ci-evidence-publication-receipt',
          ),
        SchemaValidationError,
      );
    }
  });

  it('rejects malformed input and tampered derived fields as CiEvidencePublicationReceiptError', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: packBytes(pack),
      facts: cloneFacts(),
    });
    const tampered = {
      ...receipt,
      publicationStatus: 'failed' as const,
      reasons: ['tampered'],
    };
    const filePath = writeReceipt(tampered);
    assert.throws(
      () => readCiEvidencePublicationReceipt(filePath, packBytes(pack)),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () =>
        buildCiEvidencePublicationReceipt({
          packBytes: Buffer.from('{', 'utf8'),
          facts: cloneFacts(),
        }),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects nonpublished outcomes with URL and published outcomes with reason', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const withUrl = cloneFacts();
    withUrl.outcomes[1] = {
      requestId: 'req-lps',
      status: 'omitted',
      reason: 'withheld',
      url: 'https://example.test/secret',
    } as unknown as CiEvidencePublicationReceiptFacts['outcomes'][number];
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withUrl }),
      CiEvidencePublicationReceiptError,
    );

    const withReason = cloneFacts();
    withReason.outcomes[0] = {
      ...publishedOutcome('req-pack'),
      reason: 'should not be here',
    } as unknown as CiEvidencePublicationReceiptFacts['outcomes'][number];
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withReason }),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects unknown enumerable fields on publisher, requested items, and outcomes', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);

    const publishedWithReason = cloneFacts();
    publishedWithReason.outcomes[0] = {
      ...publishedOutcome('req-pack'),
      reason: 'should not be here',
    } as unknown as CiEvidencePublicationReceiptFacts['outcomes'][number];
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: publishedWithReason }),
      CiEvidencePublicationReceiptError,
    );

    const nonpublishedWithUrl = cloneFacts();
    nonpublishedWithUrl.outcomes[1] = {
      requestId: 'req-lps',
      status: 'omitted',
      reason: 'withheld',
      url: 'https://example.test/secret',
    } as unknown as CiEvidencePublicationReceiptFacts['outcomes'][number];
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: nonpublishedWithUrl }),
      CiEvidencePublicationReceiptError,
    );

    const nonpublishedWithVisibility = cloneFacts();
    nonpublishedWithVisibility.outcomes[1] = {
      requestId: 'req-lps',
      status: 'omitted',
      reason: 'withheld',
      visibility: 'public',
    } as unknown as CiEvidencePublicationReceiptFacts['outcomes'][number];
    assert.throws(
      () =>
        buildCiEvidencePublicationReceipt({
          packBytes: bytes,
          facts: nonpublishedWithVisibility,
        }),
      CiEvidencePublicationReceiptError,
    );

    const nonpublishedWithPublishedAt = cloneFacts();
    nonpublishedWithPublishedAt.outcomes[1] = {
      requestId: 'req-lps',
      status: 'omitted',
      reason: 'withheld',
      publishedAt: '2026-08-22T03:00:00.000Z',
    } as unknown as CiEvidencePublicationReceiptFacts['outcomes'][number];
    assert.throws(
      () =>
        buildCiEvidencePublicationReceipt({
          packBytes: bytes,
          facts: nonpublishedWithPublishedAt,
        }),
      CiEvidencePublicationReceiptError,
    );

    const publisherUnknown = cloneFacts();
    (publisherUnknown.publisher as { extra?: string }).extra = 'unknown-publisher-field';
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: publisherUnknown }),
      CiEvidencePublicationReceiptError,
    );

    const requestedUnknown = cloneFacts();
    (requestedUnknown.requestedItems[0] as { extra?: string }).extra = 'unknown-item-field';
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: requestedUnknown }),
      CiEvidencePublicationReceiptError,
    );
  });

  it('does not mutate caller input', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = Uint8Array.from(packBytes(pack));
    const facts = cloneFacts();
    const originalFacts = JSON.stringify(facts);
    const originalBytes = Buffer.from(bytes).toString('hex');
    buildCiEvidencePublicationReceipt({ packBytes: bytes, facts });
    assert.equal(JSON.stringify(facts), originalFacts);
    assert.equal(Buffer.from(bytes).toString('hex'), originalBytes);
  });

  it('never uses not_applicable or GitHub-specific API vocabulary', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: packBytes(pack),
      facts: cloneFacts(),
    });
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes('not_applicable'), false);
    assert.equal(serialized.includes('actions/upload-artifact'), false);
    assert.equal(serialized.includes('github.com'), false);
    assert.equal(serialized.includes('gh api'), false);
  });

  it('asserts every copied pack-binding field against the supplied pack', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: packBytes(pack),
      facts: cloneFacts(),
    });
    assertCiEvidencePublicationReceiptForPack(receipt, pack);
    assert.equal(receipt.pack.packId, pack.packId);
    assert.equal(receipt.pack.schemaVersion, pack.schemaVersion);
    assert.deepEqual(receipt.pack.source, pack.source);
    assert.deepEqual(receipt.pack.liveProofSet, pack.liveProofSet);
    assert.deepEqual(receipt.pack.requiredPlatforms, pack.requiredPlatforms);
    assert.deepEqual(receipt.pack.requiredEvidenceKinds, pack.requiredEvidenceKinds);
    assert.equal(receipt.pack.mechanismStatus, pack.mechanismStatus);
    assert.deepEqual(receipt.pack.twoPlatformClaim, pack.twoPlatformClaim);
    assert.equal(receipt.pack.comparisonStatus, pack.comparisonStatus);
    assert.deepEqual(receipt.pack.completeness, pack.completeness);
    assert.deepEqual(receipt.pack.assembly, pack.assembly);

    const mismatchedPackId = {
      ...receipt,
      pack: { ...receipt.pack, packId: 'other-pack' },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedPackId, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedSchemaVersion = {
      ...receipt,
      pack: { ...receipt.pack, schemaVersion: '0.0.0' as typeof receipt.pack.schemaVersion },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedSchemaVersion, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedSource = {
      ...receipt,
      pack: {
        ...receipt.pack,
        source: { ...receipt.pack.source, status: 'stale' as const, observedSha: 'cccccccccccccccccccccccccccccccccccccccc' },
      },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedSource, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedLiveProof = {
      ...receipt,
      pack: {
        ...receipt.pack,
        liveProofSet: { ...receipt.pack.liveProofSet, status: 'failed' as const },
      },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedLiveProof, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedPlatforms = {
      ...receipt,
      pack: { ...receipt.pack, requiredPlatforms: ['ios', 'android'] as typeof receipt.pack.requiredPlatforms },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedPlatforms, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedKinds = {
      ...receipt,
      pack: {
        ...receipt.pack,
        requiredEvidenceKinds: ['verdict', 'recording'] as typeof receipt.pack.requiredEvidenceKinds,
      },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedKinds, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedMechanism = {
      ...receipt,
      pack: { ...receipt.pack, mechanismStatus: 'failed' as const },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedMechanism, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedTwoPlatform = {
      ...receipt,
      pack: {
        ...receipt.pack,
        twoPlatformClaim: { status: 'failed' as const, reasons: ['tampered'] },
      },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedTwoPlatform, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedComparison = {
      ...receipt,
      pack: { ...receipt.pack, comparisonStatus: 'not_available' as const },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedComparison, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedCompleteness = {
      ...receipt,
      pack: { ...receipt.pack, completeness: { status: 'incomplete' as const, reasons: ['missing'] } },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedCompleteness, pack),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedAssembly = {
      ...receipt,
      pack: { ...receipt.pack, assembly: { status: 'failed' as const, reasons: ['failed'] } },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForPack(mismatchedAssembly, pack),
      CiEvidencePublicationReceiptError,
    );
  });

  it('accepts independently serialized pack bytes with reordered object keys', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const reordered = JSON.parse(JSON.stringify(pack)) as CiEvidencePack;
    const bytes = Buffer.from(
      JSON.stringify({
        twoPlatformClaim: reordered.twoPlatformClaim,
        source: reordered.source,
        packId: reordered.packId,
        schemaVersion: reordered.schemaVersion,
        createdAt: reordered.createdAt,
        liveProofSet: reordered.liveProofSet,
        requiredEvidenceKinds: reordered.requiredEvidenceKinds,
        requiredPlatforms: reordered.requiredPlatforms,
        platforms: reordered.platforms,
        attempts: reordered.attempts,
        evidence: reordered.evidence,
        verdicts: reordered.verdicts,
        comparisonStatus: reordered.comparisonStatus,
        completeness: reordered.completeness,
        assembly: reordered.assembly,
        mechanismStatus: reordered.mechanismStatus,
        summary: reordered.summary,
        nextAction: reordered.nextAction,
      }),
      'utf8',
    );
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: cloneFacts(),
    });
    assertCiEvidencePublicationReceiptForPack(receipt, pack);
    assertCiEvidencePublicationReceiptForExactPackBytes(receipt, pack, bytes);
    assert.equal(receipt.pack.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(receipt.pack.byteSize, bytes.byteLength);
  });

  it('asserts exact pack bytes for digest, size, whitespace, parse, and copied-field tampering', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const compact = Buffer.from(JSON.stringify(pack), 'utf8');
    const pretty = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    const compactReceipt = buildCiEvidencePublicationReceipt({
      packBytes: compact,
      facts: cloneFacts(),
    });
    const prettyReceipt = buildCiEvidencePublicationReceipt({
      packBytes: pretty,
      facts: cloneFacts(),
    });

    assertCiEvidencePublicationReceiptForExactPackBytes(compactReceipt, pack, compact);
    assertCiEvidencePublicationReceiptForExactPackBytes(prettyReceipt, pack, pretty);
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(compactReceipt, pack, pretty),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(prettyReceipt, pack, compact),
      CiEvidencePublicationReceiptError,
    );

    const tamperedDigest = {
      ...compactReceipt,
      pack: { ...compactReceipt.pack, sha256: 'c'.repeat(64) },
    };
    assertCiEvidencePublicationReceiptForPack(tamperedDigest, pack);
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(tamperedDigest, pack, compact),
      CiEvidencePublicationReceiptError,
    );

    const tamperedSize = {
      ...compactReceipt,
      pack: { ...compactReceipt.pack, byteSize: compact.byteLength + 1 },
    };
    assertCiEvidencePublicationReceiptForPack(tamperedSize, pack);
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(tamperedSize, pack, compact),
      CiEvidencePublicationReceiptError,
    );

    const unparseable = Buffer.from('{', 'utf8');
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(compactReceipt, pack, unparseable),
      CiEvidencePublicationReceiptError,
    );

    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]);
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(compactReceipt, pack, invalidUtf8),
      CiEvidencePublicationReceiptError,
    );

    const mismatchedPackId = {
      ...compactReceipt,
      pack: { ...compactReceipt.pack, packId: 'other-pack' },
    };
    assert.throws(
      () => assertCiEvidencePublicationReceiptForExactPackBytes(mismatchedPackId, pack, compact),
      CiEvidencePublicationReceiptError,
    );
  });

  it('keeps mixed published plus failed outcomes as partial without laundering pack claims', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const mixedFacts = cloneFacts();
    mixedFacts.outcomes[1] = {
      requestId: 'req-lps',
      status: 'failed',
      reason: 'upload failed',
    };
    mixedFacts.outcomes[2] = {
      requestId: 'req-ev',
      status: 'rejected',
      reason: 'policy rejected',
    };
    const mixed = buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: mixedFacts });
    assert.equal(mixed.publicationStatus, 'partial');
    assert.equal(mixed.pack.mechanismStatus, pack.mechanismStatus);
    assert.equal(mixed.pack.twoPlatformClaim.status, pack.twoPlatformClaim.status);
    assert.equal(mixed.pack.source.status, pack.source.status);
    assertCiEvidencePublicationReceiptForExactPackBytes(mixed, pack, bytes);

    const mixedInvalidFacts = cloneFacts();
    mixedInvalidFacts.outcomes[1] = {
      requestId: 'req-lps',
      status: 'invalid',
      reason: 'url invalid',
    };
    const mixedInvalid = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: mixedInvalidFacts,
    });
    assert.equal(mixedInvalid.publicationStatus, 'partial');
    assert.equal(mixedInvalid.pack.twoPlatformClaim.status, pack.twoPlatformClaim.status);
    assertCiEvidencePublicationReceiptForExactPackBytes(mixedInvalid, pack, bytes);
    const failedAttempt = requiredItem(
      pack.attempts.find((attempt: { attemptId: string }) => attempt.attemptId === 'android-fail'),
      'android-fail',
    );
    assert.equal(failedAttempt.status, 'failed');
    assert.equal('attempts' in mixed.pack, false);
    assert.equal(JSON.stringify(mixed).includes('android-fail'), false);
  });

  it('binds failed and rejected pack attempts only through digest and copied fields', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: cloneFacts(),
    });
    assertCiEvidencePublicationReceiptForExactPackBytes(receipt, pack, bytes);
    assert.equal(receipt.pack.packId, pack.packId);
    assert.equal(receipt.pack.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal('attempts' in receipt.pack, false);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes('android-fail'), false);
    assert.equal(serialized.includes('predecessorAttemptId'), false);
  });

  it('rejects reader-path closed-field violations', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: cloneFacts(),
    });

    const publishedWithReason = {
      ...receipt,
      outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) =>
        index === 0 ? { ...outcome, reason: 'should not be here' } : outcome,
      ),
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(
          writeReceipt(publishedWithReason as CiEvidencePublicationReceipt),
          bytes,
        ),
      CiEvidencePublicationReceiptError,
    );

    const omitted = {
      requestId: 'req-lps',
      status: 'omitted' as const,
      reason: 'withheld',
    };
    const nonpublishedWithUrl = {
      ...receipt,
      publicationStatus: 'partial' as const,
      outcomes: [receipt.outcomes[0], { ...omitted, url: 'https://example.test/secret' }, receipt.outcomes[2]],
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(
          writeReceipt(nonpublishedWithUrl as CiEvidencePublicationReceipt),
          bytes,
        ),
      CiEvidencePublicationReceiptError,
    );

    const credentialUrl = {
      ...receipt,
      outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) =>
        index === 0
          ? { ...outcome, url: 'https://user:pass@example.test/pack.json' }
          : outcome,
      ),
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(
          writeReceipt(credentialUrl as CiEvidencePublicationReceipt),
          bytes,
        ),
      CiEvidencePublicationReceiptError,
    );

    const httpUrl = {
      ...receipt,
      outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) =>
        index === 0 ? { ...outcome, url: 'http://example.test/pack.json' } : outcome,
      ),
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(writeReceipt(httpUrl as CiEvidencePublicationReceipt), bytes),
      CiEvidencePublicationReceiptError,
    );

    const extraField = {
      ...receipt,
      extra: 'unknown-receipt-field',
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(
          writeReceipt(extraField as CiEvidencePublicationReceipt),
          bytes,
        ),
      CiEvidencePublicationReceiptError,
    );

    const nonpublishedWithVisibility = {
      ...receipt,
      publicationStatus: 'partial' as const,
      outcomes: [
        receipt.outcomes[0],
        { ...omitted, visibility: 'public' },
        receipt.outcomes[2],
      ],
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(
          writeReceipt(nonpublishedWithVisibility as CiEvidencePublicationReceipt),
          bytes,
        ),
      CiEvidencePublicationReceiptError,
    );

    const nonpublishedWithPublishedAt = {
      ...receipt,
      publicationStatus: 'partial' as const,
      outcomes: [
        receipt.outcomes[0],
        { ...omitted, publishedAt: '2026-08-22T03:00:00.000Z' },
        receipt.outcomes[2],
      ],
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(
          writeReceipt(nonpublishedWithPublishedAt as CiEvidencePublicationReceipt),
          bytes,
        ),
      CiEvidencePublicationReceiptError,
    );

    const markdownUnsafeUrls = [
      'https://example.test/pack.json)ignored',
      'https://example.test/pack.json(ignored',
      'https://example.test/pack.json[ignored',
      'https://example.test/pack.json]ignored',
      'https://example.test/pack.json<ignored',
      'https://example.test/pack.json>ignored',
      'https://example.test/pack.json"ignored',
      "https://example.test/pack.json'ignored",
      'https://example.test/pack.json`ignored',
      'https://example.test/pack.json|ignored',
    ];
    for (const url of markdownUnsafeUrls) {
      const markdownUrl = {
        ...receipt,
        outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) =>
          index === 0 ? { ...outcome, url } : outcome,
        ),
      };
      assert.throws(
        () =>
          readCiEvidencePublicationReceipt(
            writeReceipt(markdownUrl as CiEvidencePublicationReceipt),
            bytes,
          ),
        CiEvidencePublicationReceiptError,
      );
    }

    const invalidUtf8Path = path.join(mkdtempSync(path.join(tmpdir(), 'ci-receipt-utf8-')), 'receipt.json');
    const validReceiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
    const receiptIdIndex = validReceiptBytes.indexOf(Buffer.from('receipt-1', 'utf8'));
    assert.ok(receiptIdIndex >= 0);
    const invalidUtf8Bytes = Buffer.from(validReceiptBytes);
    invalidUtf8Bytes[receiptIdIndex] = 0xff;
    writeFileSync(invalidUtf8Path, invalidUtf8Bytes);
    assert.throws(
      () => readCiEvidencePublicationReceipt(invalidUtf8Path, bytes),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects facts that are not closed plain JSON own-data', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);

    const withGetter = cloneFacts();
    Object.defineProperty(withGetter, 'receiptId', {
      get() {
        throw new Error('getter invoked');
      },
      enumerable: true,
    });
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withGetter }),
      CiEvidencePublicationReceiptError,
    );

    const withSymbol = cloneFacts();
    (withSymbol as unknown as { [key: symbol]: string })[Symbol('extra')] = 'nope';
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withSymbol }),
      CiEvidencePublicationReceiptError,
    );

    const withArrayNamedProp = cloneFacts();
    (withArrayNamedProp.requestedItems as unknown as { extra?: string }).extra = 'non-index';
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withArrayNamedProp }),
      CiEvidencePublicationReceiptError,
    );

    const sparse = cloneFacts();
    sparse.outcomes = [];
    sparse.outcomes[1] = publishedOutcome('req-pack');
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: sparse }),
      CiEvidencePublicationReceiptError,
    );

    const protoFacts = JSON.parse(JSON.stringify(cloneFacts())) as CiEvidencePublicationReceiptFacts;
    Object.setPrototypeOf(protoFacts, { polluted: true });
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: protoFacts }),
      CiEvidencePublicationReceiptError,
    );

    const constructorFacts = cloneFacts() as CiEvidencePublicationReceiptFacts & {
      constructor?: unknown;
    };
    constructorFacts.constructor = { name: 'injected' };
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: constructorFacts }),
      CiEvidencePublicationReceiptError,
    );

    const protoKeyFacts = cloneFacts();
    Object.defineProperty(protoKeyFacts, '__proto__', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: protoKeyFacts }),
      CiEvidencePublicationReceiptError,
    );

    const throwingProxy = new Proxy(cloneFacts(), {
      getOwnPropertyDescriptor() {
        throw new Error('proxy trap');
      },
    });
    assert.throws(
      () =>
        buildCiEvidencePublicationReceipt({
          packBytes: bytes,
          facts: throwingProxy,
        }),
      CiEvidencePublicationReceiptError,
    );

    const cyclic = cloneFacts() as CiEvidencePublicationReceiptFacts & { extra?: unknown };
    cyclic.extra = cyclic;
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: cyclic }),
      CiEvidencePublicationReceiptError,
    );

    const withUndefined = cloneFacts() as CiEvidencePublicationReceiptFacts & {
      extra?: undefined;
    };
    withUndefined.extra = undefined;
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withUndefined }),
      CiEvidencePublicationReceiptError,
    );

    const withFunction = cloneFacts() as CiEvidencePublicationReceiptFacts & {
      extra?: () => void;
    };
    withFunction.extra = () => undefined;
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withFunction }),
      CiEvidencePublicationReceiptError,
    );

    const withNonFinite = cloneFacts() as CiEvidencePublicationReceiptFacts & { extra?: number };
    withNonFinite.extra = Number.NaN;
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: withNonFinite }),
      CiEvidencePublicationReceiptError,
    );

    const unknownField = cloneFacts() as CiEvidencePublicationReceiptFacts & { extra?: string };
    unknownField.extra = 'unknown-own-field';
    assert.throws(
      () => buildCiEvidencePublicationReceipt({ packBytes: bytes, facts: unknownField }),
      CiEvidencePublicationReceiptError,
    );
  });

  it('reads a receipt only against exact pack bytes', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const bytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: bytes,
      facts: cloneFacts(),
    });
    const pathOnDisk = writeReceipt(receipt);
    const roundTrip = readCiEvidencePublicationReceipt(pathOnDisk, bytes);
    assert.deepEqual(roundTrip, receipt);
    assertCiEvidencePublicationReceiptForExactPackBytes(roundTrip, pack, bytes);

    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(Buffer.from(bytes).toString('utf8')), null, 2),
      'utf8',
    );
    assert.notDeepEqual(reserialized, bytes);
    assert.throws(
      () => readCiEvidencePublicationReceipt(pathOnDisk, reserialized),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () => readCiEvidencePublicationReceipt(pathOnDisk, Buffer.concat([bytes, Buffer.from([0x0a])])),
      CiEvidencePublicationReceiptError,
    );

    const unknownIdentity = {
      ...receipt,
      requestedItems: receipt.requestedItems.map(
        (item: CiEvidencePublicationReceipt['requestedItems'][number], index: number) =>
          index === 0 ? { ...item, evidenceId: 'unknown-evidence' } : item,
      ),
    };
    assert.throws(
      () => readCiEvidencePublicationReceipt(writeReceipt(unknownIdentity), bytes),
      CiEvidencePublicationReceiptError,
    );

    const nonPresentPack = {
      ...pack,
      evidence: pack.evidence.map((item: (typeof pack.evidence)[number], index: number) =>
        index === 1 ? { ...item, status: 'missing' as const } : item,
      ),
    };
    const nonPresentBytes = packBytes(nonPresentPack);
    const publishedNonPresent = {
      ...receipt,
      pack: {
        ...receipt.pack,
        sha256: createHash('sha256').update(nonPresentBytes).digest('hex'),
        byteSize: nonPresentBytes.byteLength,
      },
      requestedItems: receipt.requestedItems.map(
        (item: CiEvidencePublicationReceipt['requestedItems'][number], index: number) =>
          index === 1
            ? { ...item, evidenceId: requiredItem(nonPresentPack.evidence[1], 'non-present evidence').id }
            : item,
      ),
      outcomes: receipt.outcomes.map(
        (outcome: CiEvidencePublicationItemOutcome, index: number) =>
          index === 1
            ? {
                requestId: outcome.requestId,
                status: 'published' as const,
                url: 'https://example.test/live-proof-summary.md',
                visibility: 'public' as const,
                publishedAt: '2026-08-22T03:00:00.000Z',
              }
            : outcome,
      ),
    };
    assert.throws(
      () =>
        readCiEvidencePublicationReceipt(writeReceipt(publishedNonPresent), nonPresentBytes),
      CiEvidencePublicationReceiptError,
    );
  });
});
