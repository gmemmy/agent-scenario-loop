const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildCiEvidencePack } = require('../ci-evidence-pack');
const {
  buildCiEvidencePublicationReceipt,
  CiEvidencePublicationReceiptError,
} = require('../ci-evidence-publication-receipt');
const {
  evaluateCiEvidencePublicationSummary,
  renderCiEvidencePublicationSummary,
} = require('../ci-evidence-publication-summary');
import type { CiEvidencePack, CiEvidencePackBuildInput } from '../ci-evidence-pack';
import type {
  CiEvidencePublicationItemOutcome,
  CiEvidencePublicationReceiptFacts,
  CiEvidencePublicationRequestedItem,
} from '../ci-evidence-publication-receipt';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function presentEvidence(
  evidenceId: string,
  attemptId: string,
  platform: 'android' | 'ios',
  kind: 'recording' | 'verdict' | 'log' | 'screenshot',
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

function attemptEvidence(
  platform: 'android' | 'ios',
  attemptId: string,
  kinds: readonly ('recording' | 'verdict' | 'log' | 'screenshot')[] = ['recording', 'verdict'],
) {
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

function publishedOutcome(requestId: string, url: string, visibility: 'public' | 'restricted' = 'public') {
  return {
    requestId,
    status: 'published' as const,
    url,
    visibility,
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
      { requestId: 'req-android-recording', targetKind: 'evidence', evidenceId: 'android-retry-recording' },
      { requestId: 'req-android-verdict', targetKind: 'evidence', evidenceId: 'android-retry-verdict' },
      { requestId: 'req-ios-recording', targetKind: 'evidence', evidenceId: 'ios-pass-recording' },
      { requestId: 'req-ios-verdict', targetKind: 'evidence', evidenceId: 'ios-pass-verdict' },
    ],
    outcomes: [
      publishedOutcome('req-pack', 'https://example.test/pack.json'),
      publishedOutcome('req-lps', 'https://example.test/lps.json'),
      publishedOutcome('req-android-recording', 'https://example.test/android-recording.bin'),
      publishedOutcome('req-android-verdict', 'https://example.test/android-verdict.json'),
      publishedOutcome('req-ios-recording', 'https://example.test/ios-recording.bin'),
      publishedOutcome('req-ios-verdict', 'https://example.test/ios-verdict.json'),
    ],
  };
}

function cloneFacts(): CiEvidencePublicationReceiptFacts {
  return JSON.parse(JSON.stringify(validFacts())) as CiEvidencePublicationReceiptFacts;
}

function renderFrom(input: CiEvidencePackBuildInput, facts: CiEvidencePublicationReceiptFacts) {
  const pack = buildCiEvidencePack(input);
  const exactBytes = packBytes(pack);
  const receipt = buildCiEvidencePublicationReceipt({ packBytes: exactBytes, facts });
  return { pack, receipt, exactBytes, markdown: renderCiEvidencePublicationSummary(pack, receipt, exactBytes) };
}

function evaluateFrom(input: CiEvidencePackBuildInput, facts: CiEvidencePublicationReceiptFacts) {
  const pack = buildCiEvidencePack(input);
  const exactBytes = packBytes(pack);
  const receipt = buildCiEvidencePublicationReceipt({ packBytes: exactBytes, facts });
  return {
    pack,
    receipt,
    exactBytes,
    result: evaluateCiEvidencePublicationSummary(pack, receipt, exactBytes),
  };
}

describe('ci evidence publication summary', () => {
  it('emits deterministic golden output with exactly one trailing newline', () => {
    const { markdown, receipt } = renderFrom(validPackInput(), cloneFacts());
    assert.equal(markdown.endsWith('\n'), true);
    assert.equal(markdown.endsWith('\n\n'), false);
    assert.equal(markdown.includes('\r'), false);
    assert.equal(markdown.split('\n').some((line: string) => /[ \t]$/.test(line)), false);
    const again = renderFrom(validPackInput(), cloneFacts()).markdown;
    assert.equal(markdown, again);
    assert.match(markdown, /^# CI evidence publication\n/);
    assert.equal(markdown.includes('# passed'), false);
    assert.match(markdown, new RegExp(`packSha256 \\| ${receipt.pack.sha256}`));
    assert.match(markdown, new RegExp(`packByteSize \\| ${receipt.pack.byteSize}`));
    const sections = [
      '## Distinct statuses',
      '## Pack identity',
      '## Publication identity',
      '## Android evidence',
      '## iOS evidence',
      '## Attempts',
      '## Unpublished and missing evidence',
      '## Publication evidence gate',
      '## Guardrails',
    ];
    let lastIndex = -1;
    for (const section of sections) {
      const index = markdown.indexOf(section);
      assert.ok(index > lastIndex, section);
      lastIndex = index;
    }
    assert.match(markdown, /Publication success does not prove runtime acceptance\./);
    assert.match(markdown, /Publication success does not prove deployment\./);
    assert.doesNotMatch(markdown, /\|\s*release(?:\s+acceptance)?\s*\|/i);
    assert.doesNotMatch(markdown, /\|\s*runtime(?:\s+acceptance)?\s*\|/i);
    assert.doesNotMatch(markdown, /\|\s*deployment(?:\s+acceptance)?\s*\|/i);
  });

  it('renders stable semantic ordering from reversed noncanonical arrays', () => {
    const input = validPackInput();
    input.attempts = [...input.attempts].reverse();
    input.evidence = [...input.evidence].reverse();
    input.requiredPlatforms = ['ios', 'android'];
    input.requiredEvidenceKinds = ['verdict', 'recording', 'log'];
    const extraLog = presentEvidence('android-retry-log', 'android-retry', 'android', 'log');
    const extraShot = presentEvidence('android-retry-screenshot', 'android-retry', 'android', 'screenshot');
    input.evidence.push(extraShot, extraLog);
    const retry = input.attempts.find((attempt) => attempt.attemptId === 'android-retry');
    if (retry === undefined) {
      throw new Error('missing retry');
    }
    retry.evidenceIds = [...retry.evidenceIds, extraShot.evidenceId, extraLog.evidenceId];
    const facts = cloneFacts();
    facts.requestedItems = [...facts.requestedItems].reverse();
    facts.outcomes = [...facts.outcomes].reverse();
    facts.requestedItems.push({
      requestId: 'req-log',
      targetKind: 'evidence',
      evidenceId: extraLog.evidenceId,
    });
    facts.outcomes.push(publishedOutcome('req-log', 'https://example.test/log.bin'));
    const { markdown } = renderFrom(input, facts);
    const androidBlock = markdown.slice(
      markdown.indexOf('## Android evidence'),
      markdown.indexOf('## iOS evidence'),
    );
    const selectedIndex = androidBlock.indexOf('android-retry');
    const failedIndex = androidBlock.indexOf('android-fail');
    assert.ok(selectedIndex >= 0);
    assert.ok(failedIndex > selectedIndex);
    const verdictIndex = androidBlock.indexOf('android-retry-verdict');
    const recordingIndex = androidBlock.indexOf('android-retry-recording');
    const logIndex = androidBlock.indexOf('android-retry-log');
    const screenshotIndex = androidBlock.indexOf('android-retry-screenshot');
    assert.ok(logIndex < recordingIndex);
    assert.ok(recordingIndex < verdictIndex);
    assert.ok(verdictIndex < screenshotIndex);
    const identity = markdown.slice(
      markdown.indexOf('## Pack identity'),
      markdown.indexOf('## Publication identity'),
    );
    assert.match(identity, /requiredPlatforms \| android, ios/);
    assert.match(identity, /requiredEvidenceKinds \| log, recording, verdict/);
  });

  it('keeps published mechanics separate from failed product verdicts', () => {
    const input = validPackInput();
    input.verdicts[0] = {
      scenarioId: 'scenario-a',
      runId: 'run-1',
      platform: 'android',
      status: 'failed',
      evidenceId: 'android-retry-verdict',
    };
    const { markdown } = renderFrom(input, cloneFacts());
    assert.match(markdown, /\| publication \| published \|/);
    assert.match(markdown, /\| Android selected product verdict \| failed \|/);
    assert.equal(markdown.includes('product pass'), false);
    assert.equal(markdown.includes('product passed'), false);
  });

  it('binds selected product verdict to the selected attempt verdict evidenceId', () => {
    const input = validPackInput();
    input.verdicts = [
      {
        scenarioId: 'scenario-a',
        runId: 'run-fail',
        platform: 'android',
        status: 'failed',
        evidenceId: 'android-fail-verdict',
      },
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
    ];
    const { markdown } = renderFrom(input, cloneFacts());
    assert.match(markdown, /\| Android selected product verdict \| passed \|/);
    assert.match(markdown, /android-fail-verdict/);
  });

  it('keeps failed twoPlatformClaim visible when uploads are published', () => {
    const input = validPackInput();
    input.source = {
      expectedSha: SHA,
      observedSha: 'cccccccccccccccccccccccccccccccccccccccc',
      status: 'stale',
    };
    const { pack, markdown } = renderFrom(input, cloneFacts());
    assert.equal(pack.twoPlatformClaim.status, 'failed');
    assert.match(markdown, /\| two-platform evidence claim \| failed \|/);
    assert.match(markdown, /\| publication \| published \|/);
  });

  it('always emits both platform sections', () => {
    const input = validPackInput();
    input.platforms[1] = {
      platform: 'ios',
      authorityStatus: 'unsupported',
      evaluationStatus: 'not_evaluable',
    };
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter(
      (item) => item.targetKind !== 'evidence' || !item.evidenceId.startsWith('ios-'),
    );
    facts.outcomes = facts.outcomes.filter((outcome) =>
      facts.requestedItems.some((item) => item.requestId === outcome.requestId),
    );
    const { markdown } = renderFrom(input, facts);
    assert.match(markdown, /## Android evidence/);
    assert.match(markdown, /## iOS evidence/);
    assert.match(markdown, /authorityStatus/);
    assert.match(markdown, /no selected attempt/);
    assert.equal(markdown.includes('missing from pack'), false);
  });

  it('labels restricted outcomes without a clickable link or raw URL', () => {
    const facts = cloneFacts();
    facts.outcomes[2] = publishedOutcome(
      'req-android-recording',
      'https://example.test/android-recording.bin',
      'restricted',
    );
    facts.outcomes[4] = {
      requestId: 'req-ios-recording',
      status: 'private',
      reason: 'kept private',
    };
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.match(markdown, /published \\\(restricted\\\)/);
    assert.equal(markdown.includes('[android-retry-recording]('), false);
    assert.equal(markdown.includes('https://example.test/android-recording.bin'), false);
    assert.equal(markdown.includes('https://example.test/ios-recording.bin'), false);
    assert.match(markdown, /private: kept private/);
    assert.match(markdown, /lacking a public review link|no public review link|no usable public review link/);
  });

  it('rejects unsafe published URL families before rendering', () => {
    const receiptRejectedUrls = [
      'http://example.test/pack.json',
      'https://user:pass@example.test/lps.json',
      'javascript:alert(1)',
      'https://example.test/a|pipe.bin',
      'https://example.test/quote"x.json',
      'https://example.test/ctrl\u0001.bin',
    ];
    for (const url of receiptRejectedUrls) {
      const facts = cloneFacts();
      facts.outcomes[0] = publishedOutcome('req-pack', url);
      assert.throws(
        () => renderFrom(validPackInput(), facts),
        CiEvidencePublicationReceiptError,
      );
    }
  });

  it('renders safe HTTPS published destinations in angle brackets', () => {
    const { markdown } = renderFrom(validPackInput(), cloneFacts());
    assert.match(markdown, /\[ci\\_evidence\\_pack\]\(<https:\/\/example\.test\/pack\.json>\)/);
  });

  it('canonically sorts unpublished rows independent of requestedItems and outcomes order', () => {
    const facts = cloneFacts();
    facts.outcomes = [
      publishedOutcome('req-ios-verdict', 'https://example.test/ios-verdict.json'),
      {
        requestId: 'req-android-recording',
        status: 'rejected',
        reason: 'policy rejected',
      },
      publishedOutcome('req-pack', 'https://example.test/pack.json'),
      {
        requestId: 'req-lps',
        status: 'failed',
        reason: 'upload failed',
      },
      publishedOutcome('req-android-verdict', 'https://example.test/android-verdict.json'),
      publishedOutcome('req-ios-recording', 'https://example.test/ios-recording.bin'),
    ];
    facts.requestedItems = [...facts.requestedItems].reverse();
    const { markdown } = renderFrom(validPackInput(), facts);
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    const lps = unpublished.indexOf('req-lps');
    const recording = unpublished.indexOf('req-android-recording');
    assert.ok(lps >= 0);
    assert.ok(recording >= 0);
    assert.ok(recording < lps);
    const againFacts = cloneFacts();
    againFacts.outcomes = [
      {
        requestId: 'req-lps',
        status: 'failed',
        reason: 'upload failed',
      },
      {
        requestId: 'req-android-recording',
        status: 'rejected',
        reason: 'policy rejected',
      },
      publishedOutcome('req-pack', 'https://example.test/pack.json'),
      publishedOutcome('req-android-verdict', 'https://example.test/android-verdict.json'),
      publishedOutcome('req-ios-recording', 'https://example.test/ios-recording.bin'),
      publishedOutcome('req-ios-verdict', 'https://example.test/ios-verdict.json'),
    ];
    const again = renderFrom(validPackInput(), againFacts).markdown;
    assert.equal(
      unpublished.slice(0, unpublished.indexOf('## Guardrails')),
      again.slice(again.indexOf('## Unpublished and missing evidence'), again.indexOf('## Guardrails')),
    );
  });

  it('retains failed retries and marks the selected attempt', () => {
    const { markdown } = renderFrom(validPackInput(), cloneFacts());
    assert.match(markdown, /android-fail/);
    assert.match(markdown, /android-retry/);
    const attempts = markdown.slice(markdown.indexOf('## Attempts'), markdown.indexOf('## Unpublished'));
    assert.match(attempts, /\| android \| scenario-a \| 1 \| android-fail \| failed \| {0,}\|/);
    assert.match(attempts, /\| android \| scenario-a \| 2 \| android-retry \| passed \| selected \|/);
    const androidBlock = markdown.slice(
      markdown.indexOf('## Android evidence'),
      markdown.indexOf('## iOS evidence'),
    );
    assert.match(androidBlock, /android-fail-recording/);
    assert.match(androidBlock, /selected/);
  });

  it('shows missing, not_available, rejected, incomplete, unsupported, and unrequested obligations', () => {
    const input = validPackInput();
    input.platforms[1] = {
      platform: 'ios',
      authorityStatus: 'unsupported',
      evaluationStatus: 'not_evaluable',
    };
    const recordingIndex = input.evidence.findIndex((item) => item.evidenceId === 'ios-pass-recording');
    input.evidence[recordingIndex] = {
      evidenceId: 'ios-pass-recording',
      attemptId: 'ios-pass',
      platform: 'ios',
      kind: 'recording',
      status: 'not_available',
      reason: 'runtime missing',
    };
    const failedRecordingIndex = input.evidence.findIndex(
      (item) => item.evidenceId === 'android-fail-recording',
    );
    input.evidence[failedRecordingIndex] = {
      evidenceId: 'android-fail-recording',
      attemptId: 'android-fail',
      platform: 'android',
      kind: 'recording',
      status: 'missing',
      reason: 'recording not produced',
    };
    const failedVerdictIndex = input.evidence.findIndex(
      (item) => item.evidenceId === 'android-fail-verdict',
    );
    input.evidence[failedVerdictIndex] = {
      evidenceId: 'android-fail-verdict',
      attemptId: 'android-fail',
      platform: 'android',
      kind: 'verdict',
      status: 'rejected',
      reason: 'rejected by assembler',
    };
    const failedAttempt = input.attempts[0];
    if (failedAttempt === undefined) {
      throw new Error('expected android-fail attempt');
    }
    const incompleteAttempt: typeof failedAttempt = {
      attemptId: failedAttempt.attemptId,
      platform: failedAttempt.platform,
      scenarioId: failedAttempt.scenarioId,
      runId: failedAttempt.runId,
      status: 'incomplete',
      attemptNumber: failedAttempt.attemptNumber,
      maxAttempts: failedAttempt.maxAttempts,
      startedAt: failedAttempt.startedAt,
      evidenceIds: [...failedAttempt.evidenceIds],
    };
    if (failedAttempt.endedAt !== undefined) {
      incompleteAttempt.endedAt = failedAttempt.endedAt;
    }
    if (failedAttempt.predecessorAttemptId !== undefined) {
      incompleteAttempt.predecessorAttemptId = failedAttempt.predecessorAttemptId;
    }
    input.attempts[0] = incompleteAttempt;
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter(
      (item) => item.requestId !== 'req-ios-recording' && item.requestId !== 'req-ios-verdict',
    );
    facts.outcomes = facts.outcomes.filter(
      (outcome) => outcome.requestId !== 'req-ios-recording' && outcome.requestId !== 'req-ios-verdict',
    );
    facts.outcomes[2] = {
      requestId: 'req-android-recording',
      status: 'rejected',
      reason: 'policy rejected',
    };
    const { markdown } = renderFrom(input, facts);
    assert.match(markdown, /not\\_available/);
    assert.match(markdown, /rejected/);
    assert.match(markdown, /incomplete/);
    assert.match(markdown, /unsupported/);
    assert.match(markdown, /unrequested/);
    assert.equal(markdown.includes('not_applicable'), false);
    assert.match(markdown, /android-fail-recording/);
    assert.match(markdown, /android-fail-verdict/);
  });

  it('escapes malicious pack and receipt strings including C0, DEL, and bidi controls', () => {
    const input = validPackInput();
    input.packId = 'pack\n# injected\n<script>x</script>|row\u0001\u007f\u202e';
    input.summary = 'ignore';
    const facts = cloneFacts();
    facts.receiptId = 'receipt](http://evil.test) `code` <img> *emph* _em_';
    const { markdown } = renderFrom(input, facts);
    assert.equal(markdown.includes('\n# injected\n'), false);
    assert.equal(markdown.includes('<script>'), false);
    assert.equal(markdown.includes('<img>'), false);
    assert.match(markdown, /\\\|row/);
    assert.equal(/\n\|row/.test(markdown), false);
    assert.equal(/\]\(http:\/\/evil\.test\)/.test(markdown), false);
    assert.equal(markdown.includes('\u0001'), false);
    assert.equal(markdown.includes('\u007f'), false);
    assert.equal(markdown.includes('\u202e'), false);
  });

  it('folds Unicode line separators and review-obscuring format characters', () => {
    const input = validPackInput();
    input.packId = 'pack\u2028# injected-heading\u2029|injected-row\u00a0\u061c\u200b\u200c\u200d\ufeff';
    const { markdown } = renderFrom(input, cloneFacts());
    assert.equal(markdown.includes('\n# injected-heading'), false);
    assert.equal(/\n\|injected-row/.test(markdown), false);
    assert.match(markdown, /\\# injected-heading/);
    assert.match(markdown, /\\\|injected-row/);
    assert.equal(markdown.includes('\u2028'), false);
    assert.equal(markdown.includes('\u2029'), false);
    assert.equal(markdown.includes('\u00a0'), false);
    assert.equal(markdown.includes('\u061c'), false);
    assert.equal(markdown.includes('\u200b'), false);
    assert.equal(markdown.includes('\u200c'), false);
    assert.equal(markdown.includes('\u200d'), false);
    assert.equal(markdown.includes('\ufeff'), false);
  });

  it('rejects mismatched receipt/pack binding', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: packBytes(pack),
      facts: cloneFacts(),
    });
    const otherInput = validPackInput();
    otherInput.packId = 'pack-other';
    const other = buildCiEvidencePack(otherInput);
    assert.throws(
      () => renderCiEvidencePublicationSummary(other, receipt, packBytes(other)),
      CiEvidencePublicationReceiptError,
    );
  });

  it('keeps required-obligation packStatus identical when mixed-status evidence order is reversed', () => {
    const forward = validPackInput();
    const retry = forward.attempts.find((attempt) => attempt.attemptId === 'android-retry');
    if (retry === undefined) {
      throw new Error('missing retry');
    }
    const missingLog = {
      evidenceId: 'android-retry-log-missing',
      attemptId: 'android-retry',
      platform: 'android' as const,
      kind: 'log' as const,
      status: 'missing' as const,
      reason: 'log not produced',
    };
    const unavailableLog = {
      evidenceId: 'android-retry-log-unavailable',
      attemptId: 'android-retry',
      platform: 'android' as const,
      kind: 'log' as const,
      status: 'not_available' as const,
      reason: 'log not available',
    };
    forward.requiredEvidenceKinds = [...forward.requiredEvidenceKinds, 'log'];
    forward.evidence.push(missingLog, unavailableLog);
    retry.evidenceIds = [...retry.evidenceIds, missingLog.evidenceId, unavailableLog.evidenceId];
    const reversed = validPackInput();
    reversed.requiredEvidenceKinds = [...forward.requiredEvidenceKinds];
    reversed.evidence = [...forward.evidence].reverse();
    const reversedRetry = reversed.attempts.find((attempt) => attempt.attemptId === 'android-retry');
    if (reversedRetry === undefined) {
      throw new Error('missing retry');
    }
    reversedRetry.evidenceIds = [...retry.evidenceIds];
    const forwardMarkdown = renderFrom(forward, cloneFacts()).markdown;
    const reversedMarkdown = renderFrom(reversed, cloneFacts()).markdown;
    const unpublishedForward = forwardMarkdown.slice(
      forwardMarkdown.indexOf('## Unpublished and missing evidence'),
      forwardMarkdown.indexOf('## Guardrails'),
    );
    const unpublishedReversed = reversedMarkdown.slice(
      reversedMarkdown.indexOf('## Unpublished and missing evidence'),
      reversedMarkdown.indexOf('## Guardrails'),
    );
    const logStatus = /\| android:log \| android \| ([^|]+) \|/;
    const forwardLog = unpublishedForward.match(logStatus)?.[1]?.trim();
    const reversedLog = unpublishedReversed.match(logStatus)?.[1]?.trim();
    assert.equal(forwardLog, 'missing,not\\_available');
    assert.equal(reversedLog, 'missing,not\\_available');
  });

  it('does not mutate inputs and contains no GitHub-specific API vocabulary', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts: cloneFacts(),
    });
    const packBefore = JSON.stringify(pack);
    const receiptBefore = JSON.stringify(receipt);
    const markdown = renderCiEvidencePublicationSummary(pack, receipt, exactBytes);
    assert.equal(JSON.stringify(pack), packBefore);
    assert.equal(JSON.stringify(receipt), receiptBefore);
    assert.equal(markdown.includes('actions/upload-artifact'), false);
    assert.equal(markdown.includes('gh api'), false);
    assert.equal(markdown.includes('github.com'), false);
  });

  it('rejects the same parsed pack when exact bytes differ by whitespace', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const compactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: compactBytes,
      facts: cloneFacts(),
    });
    const spacedBytes = Buffer.from(`${JSON.stringify(pack)}\n`, 'utf8');
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, receipt, spacedBytes),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects a tampered receipt digest even when parsed pack objects match', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts: cloneFacts(),
    });
    const tampered = {
      ...receipt,
      pack: {
        ...receipt.pack,
        sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    };
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, tampered, exactBytes),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects a tampered receipt byte size even when parsed pack objects match', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts: cloneFacts(),
    });
    const tampered = {
      ...receipt,
      pack: {
        ...receipt.pack,
        byteSize: receipt.pack.byteSize + 1,
      },
    };
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, tampered, exactBytes),
      CiEvidencePublicationReceiptError,
    );
  });

  it('rejects malformed invalid UTF-8 pack bytes', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts: cloneFacts(),
    });
    const invalidUtf8 = Uint8Array.from([0xff, 0xfe, 0xfd]);
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, receipt, invalidUtf8),
      CiEvidencePublicationReceiptError,
    );
  });

  it('isolates the renderer from later caller mutations of the supplied byte buffer', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts: cloneFacts(),
    });
    const mutableBytes = Uint8Array.from(exactBytes);
    const markdown = renderCiEvidencePublicationSummary(pack, receipt, mutableBytes);
    mutableBytes[0] = (mutableBytes[0] ?? 0) ^ 0xff;
    const again = renderCiEvidencePublicationSummary(pack, receipt, exactBytes);
    assert.equal(markdown, again);
  });

  it('does not let retained failed-attempt publication satisfy selected-attempt obligations', () => {
    const input = validPackInput();
    const retry = input.attempts.find((attempt) => attempt.attemptId === 'android-retry');
    if (retry === undefined) {
      throw new Error('missing retry');
    }
    retry.evidenceIds = retry.evidenceIds.filter((id) => !id.endsWith('-recording'));
    input.evidence = input.evidence.filter(
      (item) => item.evidenceId !== 'android-retry-recording',
    );
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter(
      (item: CiEvidencePublicationRequestedItem) =>
        item.targetKind !== 'evidence' || item.evidenceId !== 'android-retry-recording',
    );
    facts.outcomes = facts.outcomes.filter(
      (outcome) => outcome.requestId !== 'req-android-recording',
    );
    const { markdown } = renderFrom(input, facts);
    assert.match(markdown, /android-fail-recording/);
    assert.match(markdown, /\| publication \| published \|/);
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    assert.match(unpublished, /android:recording/);
    assert.match(unpublished, /required platform\+kind obligation lacks a published link/);
    const androidBlock = markdown.slice(
      markdown.indexOf('## Android evidence'),
      markdown.indexOf('## iOS evidence'),
    );
    assert.match(androidBlock, /android-fail-recording/);
    assert.match(androidBlock, /android-retry/);
  });

  it('preserves not_evaluated when selected verdict is absent or only retained verdict evidence remains', () => {
    const absent = validPackInput();
    absent.verdicts = [];
    const { markdown: absentMarkdown } = renderFrom(absent, cloneFacts());
    assert.match(absentMarkdown, /\| Android selected product verdict \| not\\_evaluated \|/);

    const retainedOnly = validPackInput();
    retainedOnly.verdicts = [
      {
        scenarioId: 'scenario-a',
        runId: 'run-fail',
        platform: 'android',
        status: 'failed',
        evidenceId: 'android-fail-verdict',
      },
    ];
    const { markdown: retainedMarkdown } = renderFrom(retainedOnly, cloneFacts());
    assert.match(retainedMarkdown, /\| Android selected product verdict \| not\\_evaluated \|/);
    assert.match(retainedMarkdown, /android-fail-verdict/);
  });

  it('ranks required evidence kinds by UTF-16 even when the required array is reversed', () => {
    const input = validPackInput();
    input.requiredEvidenceKinds = ['verdict', 'screenshot', 'recording', 'log'];
    const extraLog = presentEvidence('android-retry-log', 'android-retry', 'android', 'log');
    const extraShot = presentEvidence('android-retry-screenshot', 'android-retry', 'android', 'screenshot');
    input.evidence.push(extraShot, extraLog);
    const retry = input.attempts.find((attempt) => attempt.attemptId === 'android-retry');
    if (retry === undefined) {
      throw new Error('missing retry');
    }
    retry.evidenceIds = [...retry.evidenceIds, extraShot.evidenceId, extraLog.evidenceId];
    const facts = cloneFacts();
    facts.requestedItems.push({
      requestId: 'req-log',
      targetKind: 'evidence',
      evidenceId: extraLog.evidenceId,
    });
    facts.outcomes.push(publishedOutcome('req-log', 'https://example.test/log.bin'));
    const { markdown } = renderFrom(input, facts);
    const identity = markdown.slice(
      markdown.indexOf('## Pack identity'),
      markdown.indexOf('## Publication identity'),
    );
    assert.match(identity, /requiredEvidenceKinds \| log, recording, screenshot, verdict/);
    const androidBlock = markdown.slice(
      markdown.indexOf('## Android evidence'),
      markdown.indexOf('## iOS evidence'),
    );
    const logIndex = androidBlock.indexOf('android-retry-log');
    const recordingIndex = androidBlock.indexOf('android-retry-recording');
    const screenshotIndex = androidBlock.indexOf('android-retry-screenshot');
    const verdictIndex = androidBlock.indexOf('android-retry-verdict');
    assert.ok(logIndex < recordingIndex);
    assert.ok(recordingIndex < screenshotIndex);
    assert.ok(screenshotIndex < verdictIndex);
  });

  it('rejects a receipt that publishes evidence whose bound pack status is non-present', () => {
    const input = validPackInput();
    const recordingIndex = input.evidence.findIndex(
      (item) => item.evidenceId === 'android-retry-recording',
    );
    input.evidence[recordingIndex] = {
      evidenceId: 'android-retry-recording',
      attemptId: 'android-retry',
      platform: 'android',
      kind: 'recording',
      status: 'missing',
      reason: 'recording not produced',
    };
    assert.throws(() => renderFrom(input, cloneFacts()), CiEvidencePublicationReceiptError);
  });

  it('defends against hostile or missing published URLs on prebuilt receipts', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const facts = cloneFacts();
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts,
    });
    const withUrl = (url: unknown) => ({
      ...receipt,
      outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) =>
        index === 0
          ? {
              ...outcome,
              status: 'published' as const,
              url,
            }
          : outcome,
      ),
    });
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, withUrl('javascript:alert(1)'), exactBytes),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () =>
        renderCiEvidencePublicationSummary(
          pack,
          withUrl('https://example.test/a\u200b.bin'),
          exactBytes,
        ),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, withUrl(undefined), exactBytes),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, withUrl(1), exactBytes),
      CiEvidencePublicationReceiptError,
    );
    const missingUrl = {
      ...receipt,
      outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) => {
        if (index !== 0) {
          return outcome;
        }
        const { url: _url, ...rest } = outcome as typeof outcome & { url?: string };
        return { ...rest, status: 'published' as const };
      }),
    };
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, missingUrl, exactBytes),
      CiEvidencePublicationReceiptError,
    );
  });

  it('folds WORD JOINER, format controls, soft hyphen, Unicode spaces, and tag characters', () => {
    const input = validPackInput();
    input.packId =
      'pack\u2060join\u2061\u2062\u2063\u2064\u206A\u206B\u206C\u206D\u206E\u206F\u00adsoft\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000space\u{E0001}tag\uFE00var\uFE0Fsel\u{E0100}ivs\u{E01EF}end';
    const { markdown } = renderFrom(input, cloneFacts());
    assert.equal(markdown.includes('\u2060'), false);
    assert.equal(markdown.includes('\u2061'), false);
    assert.equal(markdown.includes('\u2064'), false);
    assert.equal(markdown.includes('\u206A'), false);
    assert.equal(markdown.includes('\u206F'), false);
    assert.equal(markdown.includes('\u00ad'), false);
    assert.equal(markdown.includes('\u2000'), false);
    assert.equal(markdown.includes('\u200a'), false);
    assert.equal(markdown.includes('\u202f'), false);
    assert.equal(markdown.includes('\u205f'), false);
    assert.equal(markdown.includes('\u3000'), false);
    assert.equal(markdown.includes('\u{E0001}'), false);
    assert.equal(markdown.includes('\uFE00'), false);
    assert.equal(markdown.includes('\uFE0F'), false);
    assert.equal(markdown.includes('\u{E0100}'), false);
    assert.equal(markdown.includes('\u{E01EF}'), false);
    assert.match(markdown, /pack join soft space tag var sel ivs end/);
  });

  it('does not autolink bare https:// or www. text in non-link untrusted cells', () => {
    const input = validPackInput();
    input.packId =
      'see https://evil.test/leak and HTTP://Evil.test/raw and http://evil.test/plain and www.evil.test/path';
    const { markdown } = renderFrom(input, cloneFacts());
    const identity = markdown.slice(
      markdown.indexOf('## Pack identity'),
      markdown.indexOf('## Publication identity'),
    );
    assert.equal(identity.includes('<https://evil.test/leak>'), false);
    assert.equal(identity.includes('[https://evil.test/leak]'), false);
    assert.equal(/\[see[^\]]*\]\(https:\/\/evil\.test/.test(identity), false);
    assert.equal(identity.includes('<http://www.evil.test/path>'), false);
    assert.equal(identity.includes('<https://www.evil.test/path>'), false);
    assert.equal(identity.includes('<http://evil.test/plain>'), false);
    assert.equal(identity.includes('<HTTP://Evil.test/raw>'), false);
    assert.equal(identity.includes('https://evil.test/leak'), false);
    assert.equal(identity.includes('http://evil.test/plain'), false);
    assert.equal(identity.includes('HTTP://Evil.test/raw'), false);
    assert.equal(identity.includes('www.evil.test'), false);
    assert.match(identity, /https: \/\//);
    assert.match(identity, /http: \/\//);
    assert.match(identity, /HTTP: \/\//);
    assert.match(identity, /www \./);
    assert.match(identity, /evil\.test/);
  });

  it('neutralizes any ASCII URI scheme and GFM email autolinks in untrusted cells', () => {
    const input = validPackInput();
    input.packId =
      'ftp://files.evil.test/dump mailto:ops@evil.test user@example.test keep https://example.test/safe';
    const { markdown } = renderFrom(input, cloneFacts());
    const identity = markdown.slice(
      markdown.indexOf('## Pack identity'),
      markdown.indexOf('## Publication identity'),
    );
    assert.equal(identity.includes('ftp://files.evil.test/dump'), false);
    assert.equal(identity.includes('<ftp://files.evil.test/dump>'), false);
    assert.equal(identity.includes('<mailto:ops@evil.test>'), false);
    assert.equal(identity.includes('<user@example.test>'), false);
    assert.equal(identity.includes('user@example.test'), false);
    assert.equal(identity.includes('ops@evil.test'), false);
    assert.match(identity, /ftp: \/\//);
    assert.match(identity, /mailto:/);
    assert.match(identity, /user @ example\.test/);
    assert.match(identity, /mailto:ops @ evil\.test/);
    assert.doesNotMatch(identity, /<user@example\.test>/);
    assert.doesNotMatch(markdown, /\]\(https:\/\/example\.test\/safe\)/);
  });

  it('keeps named HTML entities visible as inert text in untrusted Markdown cells', () => {
    const input = validPackInput();
    input.packId =
      '&rlm;&lrm;&nbsp;&shy;&ZeroWidthSpace;&NewLine;&lt;script&gt;';
    const { markdown } = renderFrom(input, cloneFacts());
    const identity = markdown.slice(
      markdown.indexOf('## Pack identity'),
      markdown.indexOf('## Publication identity'),
    );
    assert.match(identity, /&amp;rlm;/);
    assert.match(identity, /&amp;lrm;/);
    assert.match(identity, /&amp;nbsp;/);
    assert.match(identity, /&amp;shy;/);
    assert.match(identity, /&amp;ZeroWidthSpace;/);
    assert.match(identity, /&amp;NewLine;/);
    assert.match(identity, /&amp;lt;script&amp;gt;/);
    assert.equal(identity.includes('&rlm;'), false);
    assert.equal(identity.includes('&nbsp;'), false);
    assert.equal(identity.includes('&lt;script&gt;'), false);
  });
});

describe('ci evidence publication summary evaluation', () => {
  it('passes for the fully public complete fixture', () => {
    const { result, receipt } = evaluateFrom(validPackInput(), cloneFacts());
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, { status: 'passed', reasons: [] });
  });

  it('fails a partial receipt with both ordered reasons when an obligation is also missing', () => {
    const facts = cloneFacts();
    facts.outcomes[2] = {
      requestId: 'req-android-recording',
      status: 'rejected',
      reason: 'policy rejected',
    };
    const { result, receipt } = evaluateFrom(validPackInput(), facts);
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.equal(receipt.publicationStatus, 'partial');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: [
        'publicationStatus is partial',
        '2 publication or required-evidence obligation(s) lack a usable public link',
      ],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    assert.match(unpublished, /android:recording/);
    assert.match(unpublished, /rejected/);
  });

  it('fails a published receipt when a required selected-attempt kind is unrequested', () => {
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter(
      (item) => item.requestId !== 'req-android-recording',
    );
    facts.outcomes = facts.outcomes.filter((outcome) => outcome.requestId !== 'req-android-recording');
    const { result, receipt } = evaluateFrom(validPackInput(), facts);
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: ['1 publication or required-evidence obligation(s) lack a usable public link'],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    assert.match(
      unpublished,
      /\| android:recording \| android \| present \| required platform\+kind obligation lacks a published link \|/,
    );
  });

  it('fails when required selected-attempt evidence is restricted-only', () => {
    const facts = cloneFacts();
    facts.outcomes[2] = publishedOutcome(
      'req-android-recording',
      'https://example.test/android-recording.bin',
      'restricted',
    );
    const { result, receipt } = evaluateFrom(validPackInput(), facts);
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: ['2 publication or required-evidence obligation(s) lack a usable public link'],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    const unpublishedRows = unpublished.split('\n').filter((line: string) => line.startsWith('| '));
    const obligationRow = unpublishedRows.find((line: string) =>
      line.includes('| android:recording |'),
    );
    const restrictedRow = unpublishedRows.find((line: string) =>
      /published \\\(restricted\\\)/.test(line),
    );
    assert.match(
      obligationRow ?? '',
      /\| android:recording \| android \| present \| required platform\+kind obligation lacks a published link \|/,
    );
    assert.match(restrictedRow ?? '', /restricted; no public review link/);
  });

  it('throws for exact-byte mismatch and unsafe published URLs exactly as the renderer does', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const compactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: compactBytes,
      facts: cloneFacts(),
    });
    const spacedBytes = Buffer.from(`${JSON.stringify(pack)}\n`, 'utf8');
    assert.throws(
      () => evaluateCiEvidencePublicationSummary(pack, receipt, spacedBytes),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, receipt, spacedBytes),
      CiEvidencePublicationReceiptError,
    );

    const withUnsafeUrl = {
      ...receipt,
      outcomes: receipt.outcomes.map((outcome: CiEvidencePublicationItemOutcome, index: number) =>
        index === 0
          ? {
              ...outcome,
              status: 'published' as const,
              url: 'javascript:alert(1)',
            }
          : outcome,
      ),
    };
    assert.throws(
      () => evaluateCiEvidencePublicationSummary(pack, withUnsafeUrl, compactBytes),
      CiEvidencePublicationReceiptError,
    );
    assert.throws(
      () => renderCiEvidencePublicationSummary(pack, withUnsafeUrl, compactBytes),
      CiEvidencePublicationReceiptError,
    );
  });

  it('fails a published receipt when ci_evidence_pack was never requested', () => {
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter((item) => item.requestId !== 'req-pack');
    facts.outcomes = facts.outcomes.filter((outcome) => outcome.requestId !== 'req-pack');
    const { result, receipt, markdown } = {
      ...evaluateFrom(validPackInput(), facts),
      markdown: renderFrom(validPackInput(), facts).markdown,
    };
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: ['1 publication or required-evidence obligation(s) lack a usable public link'],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    assert.match(unpublished, /ci\\_evidence\\_pack/);
    assert.match(unpublished, /mandatory artifact lacks a published public link/);
  });

  it('fails a published receipt when live_proof_set was never requested', () => {
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter((item) => item.requestId !== 'req-lps');
    facts.outcomes = facts.outcomes.filter((outcome) => outcome.requestId !== 'req-lps');
    const { result, receipt } = evaluateFrom(validPackInput(), facts);
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: ['1 publication or required-evidence obligation(s) lack a usable public link'],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    assert.match(unpublished, /live\\_proof\\_set/);
    assert.match(unpublished, /mandatory artifact lacks a published public link/);
  });

  it('fails when ci_evidence_pack is restricted while other outcomes remain public', () => {
    const facts = cloneFacts();
    facts.outcomes[0] = publishedOutcome(
      'req-pack',
      'https://example.test/pack.json',
      'restricted',
    );
    const { result, receipt } = evaluateFrom(validPackInput(), facts);
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: ['1 publication or required-evidence obligation(s) lack a usable public link'],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    const packRows = unpublished
      .split('\n')
      .filter((line: string) => line.includes('ci\\_evidence\\_pack'));
    assert.equal(packRows.length, 1);
    assert.match(packRows[0] ?? '', /published \\\(restricted\\\)/);
  });

  it('fails when live_proof_set is restricted while other outcomes remain public', () => {
    const facts = cloneFacts();
    facts.outcomes[1] = publishedOutcome(
      'req-lps',
      'https://example.test/lps.json',
      'restricted',
    );
    const { result, receipt } = evaluateFrom(validPackInput(), facts);
    const { markdown } = renderFrom(validPackInput(), facts);
    assert.equal(receipt.publicationStatus, 'published');
    assert.deepEqual(result, {
      status: 'failed',
      reasons: ['1 publication or required-evidence obligation(s) lack a usable public link'],
    });
    const unpublished = markdown.slice(markdown.indexOf('## Unpublished and missing evidence'));
    const lpsRows = unpublished.split('\n').filter((line: string) => line.includes('live\\_proof\\_set'));
    assert.equal(lpsRows.length, 1);
    assert.match(lpsRows[0] ?? '', /published \\\(restricted\\\)/);
  });

  it('keeps missing pack-artifact obligation ordering identical when requests and outcomes are reversed', () => {
    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter((item) => item.requestId !== 'req-pack');
    facts.outcomes = facts.outcomes.filter((outcome) => outcome.requestId !== 'req-pack');
    const reversedFacts = cloneFacts();
    reversedFacts.requestedItems = [...facts.requestedItems].reverse();
    reversedFacts.outcomes = [...facts.outcomes].reverse();
    const forwardEval = evaluateFrom(validPackInput(), facts).result;
    const reversedEval = evaluateFrom(validPackInput(), reversedFacts).result;
    assert.deepEqual(forwardEval, reversedEval);
    const forwardMarkdown = renderFrom(validPackInput(), facts).markdown;
    const reversedMarkdown = renderFrom(validPackInput(), reversedFacts).markdown;
    const unpublishedForward = forwardMarkdown.slice(
      forwardMarkdown.indexOf('## Unpublished and missing evidence'),
      forwardMarkdown.indexOf('## Guardrails'),
    );
    const unpublishedReversed = reversedMarkdown.slice(
      reversedMarkdown.indexOf('## Unpublished and missing evidence'),
      reversedMarkdown.indexOf('## Guardrails'),
    );
    assert.equal(unpublishedForward, unpublishedReversed);
  });

  it('is deterministic under reversed ordering and does not mutate caller inputs', () => {
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactBytes,
      facts: cloneFacts(),
    });
    const packBefore = JSON.stringify(pack);
    const receiptBefore = JSON.stringify(receipt);
    const bytesBefore = Array.from(exactBytes);
    const first = evaluateCiEvidencePublicationSummary(pack, receipt, exactBytes);
    assert.equal(JSON.stringify(pack), packBefore);
    assert.equal(JSON.stringify(receipt), receiptBefore);
    assert.deepEqual(Array.from(exactBytes), bytesBefore);

    const reversedInput = validPackInput();
    reversedInput.attempts = [...reversedInput.attempts].reverse();
    reversedInput.evidence = [...reversedInput.evidence].reverse();
    reversedInput.requiredPlatforms = ['ios', 'android'];
    reversedInput.requiredEvidenceKinds = ['verdict', 'recording'];
    const reversedFacts = cloneFacts();
    reversedFacts.requestedItems = [...reversedFacts.requestedItems].reverse();
    reversedFacts.outcomes = [...reversedFacts.outcomes].reverse();
    const reversed = evaluateFrom(reversedInput, reversedFacts).result;
    assert.deepEqual(first, { status: 'passed', reasons: [] });
    assert.deepEqual(reversed, first);
  });

  it('renders the same publication evidence gate evaluation as evaluateCiEvidencePublicationSummary', () => {
    const passed = evaluateFrom(validPackInput(), cloneFacts());
    const passedMarkdown = renderCiEvidencePublicationSummary(
      passed.pack,
      passed.receipt,
      passed.exactBytes,
    );
    assert.deepEqual(passed.result, { status: 'passed', reasons: [] });
    assert.match(passedMarkdown, /\| publication evidence gate \| passed \|/);
    assert.match(passedMarkdown, /## Publication evidence gate\n\nnone\n/);
    assert.doesNotMatch(passedMarkdown, /\|\s*publication evidence gate \| (?:product|runtime|release|deployment)/i);
    const passedGate = passedMarkdown.slice(
      passedMarkdown.indexOf('## Publication evidence gate'),
      passedMarkdown.indexOf('## Guardrails'),
    );
    assert.equal(passedGate.includes('product acceptance'), false);
    assert.equal(passedGate.includes('runtime acceptance'), false);
    assert.equal(passedGate.includes('release acceptance'), false);
    assert.equal(passedGate.includes('deployment acceptance'), false);

    const facts = cloneFacts();
    facts.requestedItems = facts.requestedItems.filter(
      (item) => item.requestId !== 'req-android-recording',
    );
    facts.outcomes = facts.outcomes.filter((outcome) => outcome.requestId !== 'req-android-recording');
    const failed = evaluateFrom(validPackInput(), facts);
    const failedMarkdown = renderCiEvidencePublicationSummary(
      failed.pack,
      failed.receipt,
      failed.exactBytes,
    );
    assert.deepEqual(failed.result, {
      status: 'failed',
      reasons: ['1 publication or required-evidence obligation(s) lack a usable public link'],
    });
    assert.match(failedMarkdown, /\| publication evidence gate \| failed \|/);
    const failedGate = failedMarkdown.slice(
      failedMarkdown.indexOf('## Publication evidence gate'),
      failedMarkdown.indexOf('## Guardrails'),
    );
    assert.equal(
      failedGate.includes(`- ${failed.result.reasons[0]!.replaceAll('(', '\\(').replaceAll(')', '\\)')}`),
      true,
    );
    assert.equal(failedGate.includes('none'), false);
    assert.equal(failedGate.includes('http://'), false);
    assert.equal(failedGate.includes('https://'), false);
    assert.doesNotMatch(failedMarkdown, /\|\s*publication evidence gate \| (?:product|runtime|release|deployment)/i);
    assert.equal(failedGate.includes('product acceptance'), false);
    assert.equal(failedGate.includes('runtime acceptance'), false);
    assert.equal(failedGate.includes('release acceptance'), false);
    assert.equal(failedGate.includes('deployment acceptance'), false);
  });

  it('renders publication evidence gate reasons in canonical evaluate order without mutating inputs', () => {
    const facts = cloneFacts();
    facts.outcomes[2] = {
      requestId: 'req-android-recording',
      status: 'rejected',
      reason: 'publisher rejected the artifact',
    };
    const pack = buildCiEvidencePack(validPackInput());
    const exactBytes = packBytes(pack);
    const receipt = buildCiEvidencePublicationReceipt({ packBytes: exactBytes, facts });
    const packBefore = JSON.stringify(pack);
    const receiptBefore = JSON.stringify(receipt);
    const bytesBefore = Array.from(exactBytes);
    const evaluation = evaluateCiEvidencePublicationSummary(pack, receipt, exactBytes);
    const markdown = renderCiEvidencePublicationSummary(pack, receipt, exactBytes);
    assert.equal(JSON.stringify(pack), packBefore);
    assert.equal(JSON.stringify(receipt), receiptBefore);
    assert.deepEqual(Array.from(exactBytes), bytesBefore);
    assert.equal(evaluation.status, 'failed');
    assert.equal(evaluation.reasons.length > 1, true);
    const gateBody = markdown.slice(
      markdown.indexOf('## Publication evidence gate\n') + '## Publication evidence gate\n'.length,
      markdown.indexOf('## Guardrails'),
    );
    const listed = evaluation.reasons
      .map((reason: string) => `- ${reason.replaceAll('(', '\\(').replaceAll(')', '\\)')}`)
      .join('\n');
    assert.equal(gateBody.includes(listed), true);
    const firstReasonIndex = gateBody.indexOf(
      `- ${evaluation.reasons[0]!.replaceAll('(', '\\(').replaceAll(')', '\\)')}`,
    );
    const secondReasonIndex = gateBody.indexOf(
      `- ${evaluation.reasons[1]!.replaceAll('(', '\\(').replaceAll(')', '\\)')}`,
    );
    assert.equal(firstReasonIndex >= 0, true);
    assert.equal(secondReasonIndex > firstReasonIndex, true);
    assert.match(markdown, /\| publication evidence gate \| failed \|/);
    assert.doesNotMatch(markdown, /\|\s*publication evidence gate \| (?:product|runtime|release|deployment)/i);
  });
});
