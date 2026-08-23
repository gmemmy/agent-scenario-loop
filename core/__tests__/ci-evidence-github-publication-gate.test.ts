const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildCiEvidencePack } = require('../ci-evidence-pack');
const {
  CiEvidenceGithubPublicationGateError,
  evaluateCiEvidenceGithubPublicationGate,
} = require('../ci-evidence-github-publication-gate');
import type { CiEvidencePack, CiEvidencePackBuildInput } from '../ci-evidence-pack';

const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const FORBIDDEN_PASS_VOCABULARY = [
  'product accepted',
  'runtime accepted',
  'release accepted',
  'deployment accepted',
  'merge accepted',
  'comparison passed',
];

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
    schemaVersion: '1.0.0',
    packId: 'pack-1',
    createdAt: '2026-08-22T00:00:00.000Z',
    source: { expectedSha: HEAD_SHA, observedSha: HEAD_SHA, status: 'current' },
    liveProofSet: {
      relativePath: 'live-proof-set.json',
      sha256: SHA256,
      byteSize: 100,
      runId: 'run-1',
      status: 'passed',
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
        status: 'failed',
        evidenceId: 'android-retry-verdict',
      },
      {
        scenarioId: 'scenario-a',
        runId: 'run-1',
        platform: 'ios',
        status: 'failed',
        evidenceId: 'ios-pass-verdict',
      },
    ],
    comparisonStatus: 'not_available',
    completeness: { status: 'complete', reasons: [] },
    assembly: { status: 'succeeded', reasons: [] },
    summary: 'android and ios evidence assembled',
    nextAction: 'publish receipt in a later slice',
  };
}

function cloneInput(): CiEvidencePackBuildInput {
  return JSON.parse(JSON.stringify(validPackInput())) as CiEvidencePackBuildInput;
}

function requiredItem<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function packBytes(pack: CiEvidencePack): Uint8Array {
  return Buffer.from(JSON.stringify(pack), 'utf8');
}

function publishedOutcome(requestId: string, url: string) {
  return {
    requestId,
    status: 'published' as const,
    url,
    visibility: 'restricted' as const,
    publishedAt: '2026-08-23T12:00:01.000Z',
  };
}

function validFacts(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    receiptId: 'receipt-pr-1',
    createdAt: '2026-08-23T12:00:00.000Z',
    packRelativePath: 'packs/ci-evidence.json',
    context: {
      repository: { owner: 'acme', repo: 'asl' },
      eventName: 'pull_request',
      headSha: HEAD_SHA,
      ref: 'refs/pull/12/head',
      pullRequestNumber: 12,
    },
    publisher: {
      providerKind: 'ci_workflow',
      providerId: 'github-actions',
      runId: 'run-1',
      workflowId: 'ci.yml',
      jobId: 'publish',
      attemptNumber: 1,
    },
    requestedItems: [
      { requestId: 'req-pack', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' },
      { requestId: 'req-lps', targetKind: 'pack_artifact', packArtifact: 'live_proof_set' },
      { requestId: 'req-android-recording', targetKind: 'evidence', evidenceId: 'android-retry-recording' },
      { requestId: 'req-android-verdict', targetKind: 'evidence', evidenceId: 'android-retry-verdict' },
      { requestId: 'req-ios-recording', targetKind: 'evidence', evidenceId: 'ios-pass-recording' },
      { requestId: 'req-ios-verdict', targetKind: 'evidence', evidenceId: 'ios-pass-verdict' },
    ],
    outcomes: [
      publishedOutcome('req-pack', 'https://github.com/acme/asl/actions/runs/1/pack.json'),
      publishedOutcome('req-lps', 'https://github.com/acme/asl/actions/runs/1/lps.json'),
      publishedOutcome(
        'req-android-recording',
        'https://github.com/acme/asl/actions/runs/1/android-recording.bin',
      ),
      publishedOutcome(
        'req-android-verdict',
        'https://github.com/acme/asl/actions/runs/1/android-verdict.json',
      ),
      publishedOutcome('req-ios-recording', 'https://github.com/acme/asl/actions/runs/1/ios-recording.bin'),
      publishedOutcome('req-ios-verdict', 'https://github.com/acme/asl/actions/runs/1/ios-verdict.json'),
    ],
  };
}

function cloneFacts(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validFacts())) as Record<string, unknown>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function evaluateGate(
  input: CiEvidencePackBuildInput = cloneInput(),
  facts: unknown = validFacts(),
) {
  const pack = buildCiEvidencePack(input);
  const bytes = packBytes(pack);
  return {
    pack,
    bytes,
    result: evaluateCiEvidenceGithubPublicationGate(bytes, facts),
  };
}

function assertNoForbiddenVocabulary(result: unknown): void {
  const serialized = JSON.stringify(result).toLowerCase();
  for (const phrase of FORBIDDEN_PASS_VOCABULARY) {
    assert.equal(serialized.includes(phrase), false, `forbidden vocabulary: ${phrase}`);
  }
}

function assertFailedWithReason(
  result: ReturnType<typeof evaluateCiEvidenceGithubPublicationGate>,
  expected: string,
): void {
  assert.equal(result.evaluation.status, 'failed');
  assert.ok(
    result.evaluation.reasons.includes(expected),
    `missing ${expected} in ${result.evaluation.reasons.join(' | ')}`,
  );
  assertNoForbiddenVocabulary(result);
}

function replaceOutcomes(
  facts: Record<string, unknown>,
  status: 'rejected' | 'omitted',
  reason: string,
): Record<string, unknown> {
  const outcomes = facts.outcomes;
  if (!Array.isArray(outcomes)) {
    throw new Error('expected outcomes array');
  }
  facts.outcomes = outcomes.map((outcome) => {
    const record = outcome as { requestId: string };
    return {
      requestId: record.requestId,
      status,
      reason,
    };
  });
  return facts;
}

describe('ci evidence github publication gate', () => {
  it('complete two-platform pack plus safe restricted publication links passes', () => {
    const { result } = evaluateGate();
    assert.equal(result.evaluation.status, 'passed');
    assert.deepEqual(result.evaluation.reasons, []);
    assert.equal(result.pack.source.status, 'current');
    assert.equal(result.pack.comparisonStatus, 'not_available');
    assert.ok(result.pack.verdicts.every((verdict: { status: string }) => verdict.status === 'failed'));
    assert.ok(result.receipt);
    assertNoForbiddenVocabulary(result);
  });

  it('comparisonStatus not_available plus failed product verdict still passes', () => {
    const input = cloneInput();
    input.comparisonStatus = 'not_available';
    for (const verdict of input.verdicts) {
      verdict.status = 'failed';
    }
    const { result } = evaluateGate(input);
    assert.equal(result.evaluation.status, 'passed');
    assert.deepEqual(result.evaluation.reasons, []);
    assert.equal(result.pack.comparisonStatus, 'not_available');
    assertNoForbiddenVocabulary(result);
  });

  it('GitHub head SHA mismatch against expected and observed fails deterministically', () => {
    const input = cloneInput();
    input.source = {
      expectedSha: OTHER_SHA,
      observedSha: OTHER_SHA,
      status: 'current',
    };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, `pack.source.expectedSha is ${OTHER_SHA}, expected ${HEAD_SHA}`);
    assertFailedWithReason(result, `pack.source.observedSha is ${OTHER_SHA}, expected ${HEAD_SHA}`);
  });

  it('source stale fails without conflating other boundaries', () => {
    const input = cloneInput();
    input.source = {
      expectedSha: HEAD_SHA,
      observedSha: OTHER_SHA,
      status: 'stale',
    };
    const { result } = evaluateGate(input);
    assert.deepEqual(
      result.evaluation.reasons.filter((reason: string) => reason.startsWith('pack.source.status')),
      ['pack.source.status is stale, expected current'],
    );
  });

  it('source missing fails without conflating other boundaries', () => {
    const input = cloneInput();
    input.source = { expectedSha: HEAD_SHA, status: 'missing' };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.source.status is missing, expected current');
  });

  it('source mismatch fails without conflating other boundaries', () => {
    const input = cloneInput();
    input.source = {
      expectedSha: HEAD_SHA,
      observedSha: OTHER_SHA,
      status: 'mismatch',
    };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.source.status is mismatch, expected current');
  });

  it('liveProofSet failed fails without conflation', () => {
    const input = cloneInput();
    input.liveProofSet = { ...input.liveProofSet, status: 'failed' };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.liveProofSet.status is failed, expected passed');
  });

  it('completeness incomplete fails without conflation', () => {
    const input = cloneInput();
    input.completeness = { status: 'incomplete', reasons: ['inventory incomplete'] };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.completeness.status is incomplete, expected complete');
  });

  it('assembly failed fails without conflation', () => {
    const input = cloneInput();
    input.assembly = { status: 'failed', reasons: ['assembly failed'] };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.assembly.status is failed, expected succeeded');
  });

  it('mechanism failed fails without conflation', () => {
    const input = cloneInput();
    input.assembly = { status: 'failed', reasons: ['assembly failed'] };
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.mechanismStatus is failed, expected succeeded');
  });

  it('twoPlatformClaim failed fails without conflation', () => {
    const input = cloneInput();
    const android = requiredItem(
      input.platforms.find((record) => record.platform === 'android'),
      'android platform',
    );
    android.selectedAttemptId = 'android-fail';
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.twoPlatformClaim.status is failed, expected passed');
  });

  it('twoPlatformClaim not_evaluable fails without conflation', () => {
    const input = cloneInput();
    const ios = requiredItem(
      input.platforms.find((record) => record.platform === 'ios'),
      'ios platform',
    );
    ios.authorityStatus = 'unsupported';
    ios.evaluationStatus = 'not_evaluable';
    const { result } = evaluateGate(input);
    assertFailedWithReason(result, 'pack.twoPlatformClaim.status is not_evaluable, expected passed');
  });

  it('rejected publication fails', () => {
    const facts = replaceOutcomes(cloneFacts(), 'rejected', 'publisher rejected the artifact');
    const { result } = evaluateGate(cloneInput(), facts);
    assertFailedWithReason(result, 'publication.evaluation.status is failed, expected passed');
    assert.ok(
      result.evaluation.reasons.some((reason: string) => reason.includes('publicationStatus')),
      result.evaluation.reasons.join(' | '),
    );
  });

  it('omitted publication fails', () => {
    const facts = replaceOutcomes(cloneFacts(), 'omitted', 'publisher omitted the artifact');
    const { result } = evaluateGate(cloneInput(), facts);
    assertFailedWithReason(result, 'publication.evaluation.status is failed, expected passed');
  });

  it('unsafe URL fails closed at admission or binding', () => {
    const facts = cloneFacts();
    const outcomes = facts.outcomes as Array<Record<string, unknown>>;
    const first = requiredItem(outcomes[0], 'first outcome');
    first.url = 'javascript:alert(1)';
    assert.throws(
      () => evaluateCiEvidenceGithubPublicationGate(packBytes(buildCiEvidencePack(cloneInput())), facts),
      CiEvidenceGithubPublicationGateError,
    );
  });

  it('malformed private visibility fails closed', () => {
    const facts = cloneFacts();
    const outcomes = facts.outcomes as Array<Record<string, unknown>>;
    const first = requiredItem(outcomes[0], 'first outcome');
    first.visibility = 'private';
    assert.throws(
      () => evaluateCiEvidenceGithubPublicationGate(packBytes(buildCiEvidencePack(cloneInput())), facts),
      CiEvidenceGithubPublicationGateError,
    );
  });

  it('corrupt bytes fail closed', () => {
    assert.throws(
      () => evaluateCiEvidenceGithubPublicationGate(Buffer.from('{not-json', 'utf8'), validFacts()),
      CiEvidenceGithubPublicationGateError,
    );
  });

  it('unknown facts fail closed', () => {
    assert.throws(
      () =>
        evaluateCiEvidenceGithubPublicationGate(
          packBytes(buildCiEvidencePack(cloneInput())),
          { unexpected: true },
        ),
      CiEvidenceGithubPublicationGateError,
    );
  });

  it('semantically corrupt pack bytes fail closed', () => {
    const pack = buildCiEvidencePack(cloneInput());
    const tampered = { ...pack, mechanismStatus: 'failed' };
    assert.throws(
      () =>
        evaluateCiEvidenceGithubPublicationGate(
          Buffer.from(JSON.stringify(tampered), 'utf8'),
          validFacts(),
        ),
      CiEvidenceGithubPublicationGateError,
    );
  });

  it('reversal of requestedItems and outcomes does not change evaluation', () => {
    const bytes = packBytes(buildCiEvidencePack(cloneInput()));
    const factsForward = validFacts();
    const factsReversed = cloneFacts();
    const requestedItems = factsReversed.requestedItems as unknown[];
    const outcomes = factsReversed.outcomes as unknown[];
    factsReversed.requestedItems = [...requestedItems].reverse();
    factsReversed.outcomes = [...outcomes].reverse();
    const forward = evaluateCiEvidenceGithubPublicationGate(bytes, factsForward);
    const reversed = evaluateCiEvidenceGithubPublicationGate(bytes, factsReversed);
    assert.deepEqual(forward.evaluation, reversed.evaluation);
  });

  it('caller bytes and facts are not mutated', () => {
    const bytes = packBytes(buildCiEvidencePack(cloneInput()));
    const originalBytes = Uint8Array.from(bytes);
    const facts = validFacts();
    const snapshot = cloneJson(facts);
    evaluateCiEvidenceGithubPublicationGate(bytes, facts);
    assert.deepEqual(Array.from(bytes), Array.from(originalBytes));
    assert.deepEqual(facts, snapshot);
  });
});
