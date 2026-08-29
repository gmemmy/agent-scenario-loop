const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { buildCiEvidencePack } = require('../ci-evidence-pack');
const {
  CiEvidenceGithubPublicationGateError,
} = require('../ci-evidence-github-publication-gate');
const { buildCiEvidenceGithubPublicationReport } = require('../ci-evidence-github-publication-report');
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

function publishedOutcome(requestId: string, url: string, visibility: 'public' | 'restricted' = 'restricted') {
  return {
    requestId,
    status: 'published' as const,
    url,
    visibility,
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

function buildReport(
  input: CiEvidencePackBuildInput = cloneInput(),
  facts: unknown = validFacts(),
) {
  const pack = buildCiEvidencePack(input);
  const bytes = packBytes(pack);
  const report = buildCiEvidenceGithubPublicationReport(bytes, facts);
  return { pack, bytes, report };
}

function assertNoForbiddenVocabulary(markdown: string): void {
  const serialized = markdown.toLowerCase();
  for (const phrase of FORBIDDEN_PASS_VOCABULARY) {
    assert.equal(serialized.includes(phrase), false, `forbidden vocabulary: ${phrase}`);
  }
}

function assertExactlyOneTrailingNewline(markdown: string): void {
  assert.ok(markdown.endsWith('\n'));
  assert.equal(markdown.endsWith('\n\n'), false);
}

function escapeFixtureCell(value: string): string {
  return value.replace(/_/g, '\\_');
}

function linkFor(label: string, url: string, visibility: 'public' | 'restricted'): string {
  return `[${escapeFixtureCell(label)}](<${url}>) (${visibility})`;
}

describe('ci evidence github publication report', () => {
  it('authenticated all-restricted successful fixture renders passed gate plus restricted links', () => {
    const { report } = buildReport();
    assert.equal(report.gate.evaluation.status, 'passed');
    assert.deepEqual(report.gate.evaluation.reasons, []);
    assert.equal(report.markdown.includes('# CI evidence review'), true);
    assert.equal(report.markdown.includes('| publication evidence gate | passed |'), true);
    assert.equal(
      report.markdown.includes(`| comparison status | ${escapeFixtureCell('not_available')} |`),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor('ci_evidence_pack', 'https://github.com/acme/asl/actions/runs/1/pack.json', 'restricted'),
      ),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor('live_proof_set', 'https://github.com/acme/asl/actions/runs/1/lps.json', 'restricted'),
      ),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor(
          'android-retry-recording',
          'https://github.com/acme/asl/actions/runs/1/android-recording.bin',
          'restricted',
        ),
      ),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor(
          'android-retry-verdict',
          'https://github.com/acme/asl/actions/runs/1/android-verdict.json',
          'restricted',
        ),
      ),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor(
          'ios-pass-recording',
          'https://github.com/acme/asl/actions/runs/1/ios-recording.bin',
          'restricted',
        ),
      ),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor(
          'ios-pass-verdict',
          'https://github.com/acme/asl/actions/runs/1/ios-verdict.json',
          'restricted',
        ),
      ),
      true,
    );
    assert.equal(report.markdown.includes('no public review link'), false);
    assertExactlyOneTrailingNewline(report.markdown);
    assertNoForbiddenVocabulary(report.markdown);
  });

  it('safe public links also render', () => {
    const facts = cloneFacts();
    const outcomes = facts.outcomes as Array<Record<string, unknown>>;
    for (const outcome of outcomes) {
      outcome.visibility = 'public';
    }
    const { report } = buildReport(cloneInput(), facts);
    assert.equal(report.gate.evaluation.status, 'passed');
    assert.equal(
      report.markdown.includes(
        linkFor('ci_evidence_pack', 'https://github.com/acme/asl/actions/runs/1/pack.json', 'public'),
      ),
      true,
    );
    assert.equal(
      report.markdown.includes(
        linkFor('live_proof_set', 'https://github.com/acme/asl/actions/runs/1/lps.json', 'public'),
      ),
      true,
    );
  });

  it('does not call or mention the generic public-link-strict renderer', () => {
    const source = fs.readFileSync(
      require.resolve('../ci-evidence-github-publication-report'),
      'utf8',
    );
    assert.equal(source.includes('renderCiEvidencePublicationSummary'), false);
  });

  it('failed product verdict and comparison not_available remain visible while gate stays passed', () => {
    const { report } = buildReport();
    assert.equal(report.gate.evaluation.status, 'passed');
    assert.equal(report.gate.pack.comparisonStatus, 'not_available');
    assert.equal(
      report.markdown.includes(`| comparison status | ${escapeFixtureCell('not_available')} |`),
      true,
    );
    assert.match(
      report.markdown,
      /\| android \| supported \| passed \| android-retry \| failed \|/,
    );
    assert.match(
      report.markdown,
      /\| ios \| supported \| passed \| ios-pass \| failed \|/,
    );
    assertNoForbiddenVocabulary(report.markdown);
  });

  it('rejected publication produces failed gate, inert escaped reason, and no link for that outcome', () => {
    const facts = cloneFacts();
    const outcomes = facts.outcomes as Array<Record<string, unknown>>;
    const packOutcome = requiredItem(
      outcomes.find((outcome) => outcome.requestId === 'req-pack'),
      'pack outcome',
    );
    const rejectedUrl = String(packOutcome.url);
    packOutcome.status = 'rejected';
    packOutcome.reason = 'publisher rejected the artifact';
    delete packOutcome.url;
    delete packOutcome.visibility;
    delete packOutcome.publishedAt;
    const { report } = buildReport(cloneInput(), facts);
    assert.equal(report.gate.evaluation.status, 'failed');
    assert.equal(report.markdown.includes('## Gate reasons'), true);
    assert.equal(report.markdown.includes('rejected: publisher rejected the artifact'), true);
    assert.equal(report.markdown.includes(`](<${rejectedUrl}>)`), false);
    assert.equal(report.markdown.includes(rejectedUrl), false);
    assert.equal(
      report.markdown.includes(
        linkFor(
          'android-retry-recording',
          'https://github.com/acme/asl/actions/runs/1/android-recording.bin',
          'restricted',
        ),
      ),
      true,
    );
  });

  it('omitted publication produces failed gate, inert escaped reason, and no link for that outcome', () => {
    const facts = cloneFacts();
    const outcomes = facts.outcomes as Array<Record<string, unknown>>;
    const lpsOutcome = requiredItem(
      outcomes.find((outcome) => outcome.requestId === 'req-lps'),
      'lps outcome',
    );
    const omittedUrl = String(lpsOutcome.url);
    lpsOutcome.status = 'omitted';
    lpsOutcome.reason = 'publisher omitted the artifact';
    delete lpsOutcome.url;
    delete lpsOutcome.visibility;
    delete lpsOutcome.publishedAt;
    const { report } = buildReport(cloneInput(), facts);
    assert.equal(report.gate.evaluation.status, 'failed');
    assert.equal(report.markdown.includes('omitted: publisher omitted the artifact'), true);
    assert.equal(report.markdown.includes(omittedUrl), false);
  });

  it('stale mismatched source produces failed gate and ordered reasons', () => {
    const input = cloneInput();
    input.source = {
      expectedSha: HEAD_SHA,
      observedSha: OTHER_SHA,
      status: 'stale',
    };
    const { report } = buildReport(input);
    assert.equal(report.gate.evaluation.status, 'failed');
    const expectedReasons = [
      'pack.source.status is stale, expected current',
      `pack.source.observedSha is ${OTHER_SHA}, expected ${HEAD_SHA}`,
    ];
    assert.deepEqual(report.gate.evaluation.reasons.slice(0, expectedReasons.length), expectedReasons);
    let cursor = -1;
    for (const reason of expectedReasons) {
      const index = report.markdown.indexOf(reason);
      assert.ok(index > cursor, `missing ordered reason ${reason}`);
      cursor = index;
    }
  });

  it('retained failed retry remains visible and selected retry is marked', () => {
    const { report } = buildReport();
    assert.match(
      report.markdown,
      /\| android \| scenario-a \| 1 \| android-fail \| failed \|  \|/,
    );
    assert.match(
      report.markdown,
      /\| android \| scenario-a \| 2 \| android-retry \| passed \| selected \|/,
    );
    assert.match(
      report.markdown,
      /\| ios \| scenario-a \| 1 \| ios-pass \| passed \| selected \|/,
    );
  });

  it('reversed requestedItems, outcomes, and attempts produce byte-identical Markdown', () => {
    const forwardInput = cloneInput();
    const reversedInput = cloneInput();
    reversedInput.attempts = [...reversedInput.attempts].reverse();
    reversedInput.evidence = [...reversedInput.evidence].reverse();
    reversedInput.verdicts = [...reversedInput.verdicts].reverse();
    reversedInput.platforms = [...reversedInput.platforms].reverse();
    const forwardFacts = cloneFacts();
    const reversedFacts = cloneFacts();
    reversedFacts.requestedItems = [...(reversedFacts.requestedItems as unknown[])].reverse();
    reversedFacts.outcomes = [...(reversedFacts.outcomes as unknown[])].reverse();
    const forward = buildReport(forwardInput, forwardFacts);
    const reversed = buildReport(reversedInput, reversedFacts);
    assert.equal(reversed.report.markdown, forward.report.markdown);
  });

  it('malicious ids, reasons, control, bidi, and autolink text cannot inject markup', () => {
    const hostile = '@user @org/team [click](https://evil.example) user@host.com www.evil.example <img>\u202Ehidden\u200B | injected |';
    const input = cloneInput();
    input.platforms = input.platforms.map((platform) =>
      platform.platform === 'android'
        ? { ...platform, selectedAttemptId: `android-retry-${hostile}` }
        : platform,
    );
    input.attempts = input.attempts.map((attempt) => {
      const withHostileScenario = {
        ...attempt,
        scenarioId: `scenario-a-${hostile}`,
      };
      if (attempt.attemptId === 'android-retry') {
        return {
          ...withHostileScenario,
          attemptId: `android-retry-${hostile}`,
          evidenceIds: attempt.evidenceIds.map((id) => `${id}-${hostile}`),
        };
      }
      return withHostileScenario;
    });
    input.evidence = input.evidence.map((item) =>
      item.attemptId === 'android-retry'
        ? {
            ...item,
            attemptId: `android-retry-${hostile}`,
            evidenceId: `${item.evidenceId}-${hostile}`,
          }
        : item,
    );
    input.verdicts = input.verdicts.map((verdict) => ({
      ...verdict,
      scenarioId: `scenario-a-${hostile}`,
      ...(verdict.platform === 'android'
        ? { evidenceId: `${verdict.evidenceId}-${hostile}` }
        : {}),
    }));

    const facts = cloneFacts();
    const requestedItems = facts.requestedItems as Array<Record<string, unknown>>;
    for (const requestId of ['req-android-recording', 'req-android-verdict'] as const) {
      const item = requiredItem(
        requestedItems.find((candidate) => candidate.requestId === requestId),
        requestId,
      );
      item.evidenceId = `${String(item.evidenceId)}-${hostile}`;
    }
    const androidRecording = requiredItem(
      requestedItems.find((item) => item.requestId === 'req-android-recording'),
      'android recording request',
    );
    androidRecording.requestId = `req-android-recording-${hostile}`;
    const outcomes = facts.outcomes as Array<Record<string, unknown>>;
    const packOutcome = requiredItem(
      outcomes.find((outcome) => outcome.requestId === 'req-pack'),
      'pack outcome',
    );
    packOutcome.status = 'rejected';
    packOutcome.reason = `boom\n| injected |\n${hostile}`;
    delete packOutcome.url;
    delete packOutcome.visibility;
    delete packOutcome.publishedAt;
    const androidRecordingOutcome = requiredItem(
      outcomes.find((outcome) => outcome.requestId === 'req-android-recording'),
      'android recording outcome',
    );
    androidRecordingOutcome.requestId = `req-android-recording-${hostile}`;
    androidRecordingOutcome.status = 'rejected';
    androidRecordingOutcome.reason = hostile;
    delete androidRecordingOutcome.url;
    delete androidRecordingOutcome.visibility;
    delete androidRecordingOutcome.publishedAt;

    const { report } = buildReport(input, facts);
    assert.equal(report.gate.evaluation.status, 'failed');
    assert.equal(report.markdown.includes('\n| injected |'), false);
    assert.equal(report.markdown.includes('[click](https://evil.example)'), false);
    assert.equal(report.markdown.includes('https://evil.example'), false);
    assert.equal(report.markdown.includes('user@host.com'), false);
    assert.equal(report.markdown.includes('www.evil.example'), false);
    assert.equal(report.markdown.includes('<img>'), false);
    assert.equal(report.markdown.includes('\u202E'), false);
    assert.equal(report.markdown.includes('\u200B'), false);
    assert.equal(report.markdown.includes('@user'), false);
    assert.equal(report.markdown.includes('@org/team'), false);
    assert.match(report.markdown, / @ user/);
    assert.match(report.markdown, / @ org\/team/);
    assert.match(report.markdown, /user @ host\.com/);
    assert.equal(report.markdown.includes('android-retry-recording- @ user'), true);
    assert.equal(report.markdown.includes('req-android-recording- @ user'), true);
    assert.equal(report.markdown.includes('scenario-a- @ user'), true);
  });

  it('malformed, private, and unsafe facts plus corrupt pack bytes throw the gate error', () => {
    const bytes = packBytes(buildCiEvidencePack(cloneInput()));
    assert.throws(
      () => buildCiEvidenceGithubPublicationReport(bytes, { unexpected: true }),
      CiEvidenceGithubPublicationGateError,
    );
    const privateFacts = cloneFacts();
    const privateOutcomes = privateFacts.outcomes as Array<Record<string, unknown>>;
    requiredItem(privateOutcomes[0], 'first outcome').visibility = 'private';
    assert.throws(
      () => buildCiEvidenceGithubPublicationReport(bytes, privateFacts),
      CiEvidenceGithubPublicationGateError,
    );
    const unsafeFacts = cloneFacts();
    const unsafeOutcomes = unsafeFacts.outcomes as Array<Record<string, unknown>>;
    requiredItem(unsafeOutcomes[0], 'first outcome').url = 'javascript:alert(1)';
    assert.throws(
      () => buildCiEvidenceGithubPublicationReport(bytes, unsafeFacts),
      CiEvidenceGithubPublicationGateError,
    );
    assert.throws(
      () => buildCiEvidenceGithubPublicationReport(Buffer.from('{not-json', 'utf8'), validFacts()),
      CiEvidenceGithubPublicationGateError,
    );
  });

  it('does not mutate pack bytes or publication facts and ends with one trailing newline', () => {
    const pack = buildCiEvidencePack(cloneInput());
    const bytes = packBytes(pack);
    const facts = validFacts();
    const bytesBefore = Buffer.from(bytes);
    const factsBefore = JSON.stringify(facts);
    const report = buildCiEvidenceGithubPublicationReport(bytes, facts);
    assert.deepEqual(Buffer.from(bytes), bytesBefore);
    assert.equal(JSON.stringify(facts), factsBefore);
    assert.equal(report.gate.evaluation.status, 'passed');
    assert.deepEqual(report.gate.evaluation.reasons, []);
    assert.equal(report.gate.pack.packId, pack.packId);
    assertExactlyOneTrailingNewline(report.markdown);
    assertNoForbiddenVocabulary(report.markdown);
    assert.equal(report.markdown.includes('merge acceptance'), true);
    assert.equal(
      report.markdown.includes(
        'Publication links and the publication evidence gate do not prove product, runtime, comparison, release, deployment, or merge acceptance.',
      ),
      true,
    );
  });
});
