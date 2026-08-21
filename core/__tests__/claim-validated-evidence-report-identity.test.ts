const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
  inspectScenarioClaimValidatedEvidenceReportIdentity,
} = require('../claim-validated-evidence-report-identity');

type JsonRecord = Record<string, any>;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);

function sha256(bytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function candidate(kind = 'validatedEvidence', subjectBytes?: Uint8Array): JsonRecord {
  const evidenceBytes = subjectBytes ?? Buffer.from('subject-artifact');
  const common: JsonRecord = {
    schemaVersion: '1.0.0',
    candidateId: 'candidate-1',
    claimId: 'claim-1',
    assertionId: 'assertion-1',
    runIdentityHash: SHA_A,
    claimHash: SHA_B,
    assertionKind: kind,
    authority: {
      declarationId: 'declaration-1',
      role: 'app',
      producerId: 'producer-1',
      evidenceSelector: 'selector-1',
      producerVersion: '1.0.0',
      producerSha256: SHA_C,
      strength: 'verified',
      completeness: 'point',
    },
    captureStatus: 'produced',
    evidence: {
      path: 'artifacts/subject.bin',
      sha256: sha256(evidenceBytes),
    },
    cleanupStatus: 'finalized',
    redactionStatus: 'not-redacted',
  };
  if (kind === 'validatedEvidence') {
    return {
      ...common,
      artifactKind: 'logs',
      validationContract: 'unknown-contract-v9',
    };
  }
  if (kind === 'boundedCount' || kind === 'absence') {
    return {
      ...common,
      observationWindow: {
        from: 'window-from',
        to: 'window-to',
        completeSourceRequired: true,
      },
    };
  }
  return common;
}

function inspect(input: unknown) {
  return inspectScenarioClaimValidatedEvidenceReportIdentity(input);
}

function forbiddenVocabulary(result: unknown): string[] {
  const serialized = JSON.stringify(result);
  const forbidden = [
    'not_applicable',
    'supported',
    'passed',
    'health',
    'verdict',
    'parsed',
    'findings',
  ];
  return forbidden.filter((token) => serialized.includes(token));
}

test('valid distinct identity admits opaque report bytes and unknown validationContract', () => {
  const reportBytes = Buffer.from([0xff, 0x00, 0x7b, 0x6e, 0x6f, 0x74, 0x2d, 0x6a, 0x73, 0x6f, 0x6e]);
  const reportSha = sha256(reportBytes);
  const result = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/report.bin', sha256: reportSha },
    reportBytes,
  });

  assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION);
  assert.equal(result.status, 'admitted');
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.nextAction, 'evaluate_validated_evidence_report');
  assert.deepEqual(Object.keys(result).sort(), [
    'artifactKind',
    'assertionId',
    'assertionKind',
    'candidateId',
    'claimHash',
    'claimId',
    'contractVersion',
    'nextAction',
    'reasonCodes',
    'reportArtifact',
    'runIdentityHash',
    'status',
    'subjectArtifact',
    'validationContract',
  ]);
  assert.equal(result.candidateId, 'candidate-1');
  assert.equal(result.runIdentityHash, SHA_A);
  assert.equal(result.claimId, 'claim-1');
  assert.equal(result.claimHash, SHA_B);
  assert.equal(result.assertionId, 'assertion-1');
  assert.equal(result.assertionKind, 'validatedEvidence');
  assert.equal(result.artifactKind, 'logs');
  assert.equal(result.validationContract, 'unknown-contract-v9');
  assert.deepEqual(result.subjectArtifact, {
    path: 'artifacts/subject.bin',
    sha256: sha256(Buffer.from('subject-artifact')),
  });
  assert.deepEqual(result.reportArtifact, {
    path: 'artifacts/report.bin',
    sha256: reportSha,
    byteLength: reportBytes.byteLength,
  });
  assert.deepEqual(forbiddenVocabulary(result), []);
});

test('hash mismatch blocks before content interpretation', () => {
  const reportBytes = Buffer.from('report-bytes');
  const result = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/report.bin', sha256: SHA_D },
    reportBytes,
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasonCodes, ['report_hash_mismatch']);
  assert.equal(result.nextAction, 'supply_exact_report_bytes');
  assert.equal(result.reportArtifact.path, 'artifacts/report.bin');
  assert.equal(result.reportArtifact.expectedSha256, SHA_D);
  assert.equal(result.reportArtifact.observedSha256, sha256(reportBytes));
  assert.equal(result.reportArtifact.byteLength, reportBytes.byteLength);
});

test('same path and same SHA each block as subject_report_identity_collision after byte binding', () => {
  const reportBytes = Buffer.from('distinct-report');
  const reportSha = sha256(reportBytes);
  const samePath = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/subject.bin', sha256: reportSha },
    reportBytes,
  });
  assert.equal(samePath.status, 'blocked');
  assert.deepEqual(samePath.reasonCodes, ['subject_report_identity_collision']);
  assert.equal(samePath.nextAction, 'declare_distinct_report_identity');
  assert.deepEqual(samePath.subjectArtifact, {
    path: 'artifacts/subject.bin',
    sha256: sha256(Buffer.from('subject-artifact')),
  });
  assert.deepEqual(samePath.reportArtifact, {
    path: 'artifacts/subject.bin',
    sha256: reportSha,
    byteLength: reportBytes.byteLength,
  });

  const subjectBytes = Buffer.from('shared-bytes');
  const sharedSha = sha256(subjectBytes);
  const sameSha = inspect({
    candidate: candidate('validatedEvidence', subjectBytes),
    report: { path: 'artifacts/report.bin', sha256: sharedSha },
    reportBytes: subjectBytes,
  });
  assert.equal(sameSha.status, 'blocked');
  assert.deepEqual(sameSha.reasonCodes, ['subject_report_identity_collision']);
  assert.equal(sameSha.nextAction, 'declare_distinct_report_identity');
  assert.equal(sameSha.subjectArtifact.sha256, sharedSha);
  assert.equal(sameSha.reportArtifact.sha256, sharedSha);
});

test('exact eventOccurrence candidate is assertion_kind_not_validated_evidence', () => {
  const reportBytes = Buffer.from('report');
  const result = inspect({
    candidate: candidate('eventOccurrence'),
    report: { path: 'artifacts/report.bin', sha256: sha256(reportBytes) },
    reportBytes,
  });
  assert.equal(result.status, 'outside_contract');
  assert.deepEqual(result.reasonCodes, ['assertion_kind_not_validated_evidence']);
  assert.equal(
    result.nextAction,
    'supply_eligible_validated_evidence_candidate_and_exact_report_bytes',
  );
});

test('eventOccurrence with validated-evidence extras is candidate_not_eligible', () => {
  const reportBytes = Buffer.from('report');
  const extras = candidate('eventOccurrence');
  extras.artifactKind = 'logs';
  extras.validationContract = 'unknown-contract-v9';
  const result = inspect({
    candidate: extras,
    report: { path: 'artifacts/report.bin', sha256: sha256(reportBytes) },
    reportBytes,
  });
  assert.equal(result.status, 'outside_contract');
  assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
});

test('exact boundedCount candidate is assertion_kind_not_validated_evidence', () => {
  const reportBytes = Buffer.from('report');
  const result = inspect({
    candidate: candidate('boundedCount'),
    report: { path: 'artifacts/report.bin', sha256: sha256(reportBytes) },
    reportBytes,
  });
  assert.equal(result.status, 'outside_contract');
  assert.deepEqual(result.reasonCodes, ['assertion_kind_not_validated_evidence']);
});

test('boundedCount with malformed observationWindow is candidate_not_eligible', () => {
  const reportBytes = Buffer.from('report');
  const malformed = candidate('boundedCount');
  malformed.observationWindow = {
    from: 'window-from',
    to: 'window-to',
    completeSourceRequired: false,
  };
  const result = inspect({
    candidate: malformed,
    report: { path: 'artifacts/report.bin', sha256: sha256(reportBytes) },
    reportBytes,
  });
  assert.equal(result.status, 'outside_contract');
  assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
});

test('malformed ineligible candidate returns candidate_not_eligible', () => {
  const reportBytes = Buffer.from('report');
  const malformed = candidate();
  malformed.captureStatus = 'missing';
  const result = inspect({
    candidate: malformed,
    report: { path: 'artifacts/report.bin', sha256: sha256(reportBytes) },
    reportBytes,
  });
  assert.equal(result.status, 'outside_contract');
  assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
});

test('invalid report paths and hashes return report_identity_invalid', () => {
  const reportBytes = Buffer.from('report');
  const observedSha = sha256(reportBytes);
  const invalidPaths = [
    '',
    ' report.bin ',
    'artifacts/\u0001report.bin',
    '/absolute/report.bin',
    'artifacts/../report.bin',
    'C:/report.bin',
    'file:artifacts/report.bin',
    'artifacts\\report.bin',
  ];
  for (const path of invalidPaths) {
    const result = inspect({
      candidate: candidate(),
      report: { path, sha256: observedSha },
      reportBytes,
    });
    assert.equal(result.status, 'outside_contract', path);
    assert.deepEqual(result.reasonCodes, ['report_identity_invalid'], path);
  }

  const invalidHash = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/report.bin', sha256: 'not-a-hash' },
    reportBytes,
  });
  assert.equal(invalidHash.status, 'outside_contract');
  assert.deepEqual(invalidHash.reasonCodes, ['report_identity_invalid']);
});

test('non-byte, Proxy, prototype spoof, and detached bytes fail as report_bytes_invalid', () => {
  const report = { path: 'artifacts/report.bin', sha256: SHA_D };
  const nonByte = inspect({ candidate: candidate(), report, reportBytes: 'bytes' });
  assert.equal(nonByte.status, 'outside_contract');
  assert.deepEqual(nonByte.reasonCodes, ['report_bytes_invalid']);

  const genuineBytes = new Uint8Array([1, 2, 3]);
  const proxy = inspect({
    candidate: candidate(),
    report,
    reportBytes: new Proxy(genuineBytes, { get: () => 1 }),
  });
  assert.equal(proxy.status, 'outside_contract');
  assert.deepEqual(proxy.reasonCodes, ['report_bytes_invalid']);

  const spoof = Object.create(Uint8Array.prototype);
  const spoofed = inspect({ candidate: candidate(), report, reportBytes: spoof });
  assert.equal(spoofed.status, 'outside_contract');
  assert.deepEqual(spoofed.reasonCodes, ['report_bytes_invalid']);

  const buffer = new ArrayBuffer(8);
  const view = new Uint8Array(buffer);
  view.set([1, 2, 3, 4, 5, 6, 7, 8]);
  structuredClone(buffer, { transfer: [buffer] });
  const detached = inspect({
    candidate: candidate(),
    report: {
      path: 'artifacts/report.bin',
      sha256: sha256(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
    },
    reportBytes: view,
  });
  assert.equal(detached.status, 'outside_contract');
  assert.deepEqual(detached.reasonCodes, ['report_bytes_invalid']);
});

test('Buffer and empty bytes admit with matching declarations and distinct subject identity', () => {
  const empty = Buffer.alloc(0);
  const emptyResult = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/empty.bin', sha256: sha256(empty) },
    reportBytes: empty,
  });
  assert.equal(emptyResult.status, 'admitted');
  assert.equal(emptyResult.reportArtifact.byteLength, 0);
  assert.equal(emptyResult.reportArtifact.sha256, sha256(empty));

  const nodeBuffer = Buffer.from('node-buffer-report');
  const bufferResult = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/buffer.bin', sha256: sha256(nodeBuffer) },
    reportBytes: nodeBuffer,
  });
  assert.equal(bufferResult.status, 'admitted');
  assert.equal(bufferResult.reportArtifact.byteLength, nodeBuffer.byteLength);
});

test('non-zero-offset Uint8Array or Buffer view hashes only selected bytes', () => {
  const backing = Buffer.from('XXXXREPORTYYYY');
  const view = backing.subarray(4, 10);
  const result = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/view.bin', sha256: sha256(view) },
    reportBytes: view,
  });
  assert.equal(result.status, 'admitted');
  assert.equal(result.reportArtifact.sha256, sha256(Buffer.from('REPORT')));
  assert.equal(result.reportArtifact.byteLength, 6);
});

test('top-level and report missing or extra keys fail outside contract', () => {
  const reportBytes = Buffer.from('report');
  const report = { path: 'artifacts/report.bin', sha256: sha256(reportBytes) };
  const missingTop = inspect({ candidate: candidate(), report });
  assert.equal(missingTop.status, 'outside_contract');
  assert.deepEqual(missingTop.reasonCodes, ['input_invalid']);

  const extraTop = inspect({
    candidate: candidate(),
    report,
    reportBytes,
    extra: true,
  });
  assert.equal(extraTop.status, 'outside_contract');
  assert.deepEqual(extraTop.reasonCodes, ['input_invalid']);

  const extraReport = inspect({
    candidate: candidate(),
    report: { ...report, extra: true },
    reportBytes,
  });
  assert.equal(extraReport.status, 'outside_contract');
  assert.deepEqual(extraReport.reasonCodes, ['report_identity_invalid']);

  const missingPath = inspect({
    candidate: candidate(),
    report: { sha256: sha256(reportBytes) },
    reportBytes,
  });
  assert.equal(missingPath.status, 'outside_contract');
  assert.deepEqual(missingPath.reasonCodes, ['report_identity_invalid']);

  const missingSha256 = inspect({
    candidate: candidate(),
    report: { path: 'artifacts/report.bin' },
    reportBytes,
  });
  assert.equal(missingSha256.status, 'outside_contract');
  assert.deepEqual(missingSha256.reasonCodes, ['report_identity_invalid']);
});

test('hostile top-level accessor does not throw', () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('hostile');
      },
      ownKeys() {
        throw new Error('hostile-keys');
      },
    },
  );
  const result = inspect(hostile);
  assert.equal(result.status, 'outside_contract');
  assert.deepEqual(result.reasonCodes, ['input_invalid']);
});

test('mutating candidate, report, and reportBytes after return does not change admitted result', () => {
  const reportBytes = Buffer.from('immutable-report');
  const inputCandidate = candidate();
  const report = { path: 'artifacts/report.bin', sha256: sha256(reportBytes) };
  const result = inspect({
    candidate: inputCandidate,
    report,
    reportBytes,
  });
  assert.equal(result.status, 'admitted');
  const snapshot = clone(result);

  inputCandidate.candidateId = 'mutated';
  inputCandidate.evidence.path = 'mutated/path';
  inputCandidate.validationContract = 'mutated-contract';
  report.path = 'mutated/report';
  report.sha256 = SHA_E;
  reportBytes[0] = 0x00;

  assert.deepEqual(result, snapshot);
});

test('serialized results never contain product vocabulary', () => {
  const samples = [
    inspect(null),
    inspect({
      candidate: candidate('eventOccurrence'),
      report: { path: 'artifacts/report.bin', sha256: SHA_D },
      reportBytes: Buffer.from('x'),
    }),
    inspect({
      candidate: candidate(),
      report: { path: 'artifacts/report.bin', sha256: SHA_D },
      reportBytes: Buffer.from('x'),
    }),
    inspect({
      candidate: candidate(),
      report: { path: 'artifacts/report.bin', sha256: sha256(Buffer.from('x')) },
      reportBytes: Buffer.from('x'),
    }),
  ];
  for (const sample of samples) {
    assert.deepEqual(forbiddenVocabulary(sample), []);
  }
});
