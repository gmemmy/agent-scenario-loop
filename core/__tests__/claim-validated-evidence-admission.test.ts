import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,
  inspectScenarioClaimValidatedEvidenceAdmission,
} from '../claim-validated-evidence-admission';
import { inspectScenarioClaimRawObservationAdmission } from '../claim-raw-observation-admission';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function eligibleCandidate(overrides: Record<string, unknown> = {}) {
  const subject = new TextEncoder().encode('subject-bytes');
  const base = {
    schemaVersion: '1.0.0',
    candidateId: 'candidate-1',
    runIdentityHash: 'a'.repeat(64),
    claimId: 'claim-1',
    claimHash: 'b'.repeat(64),
    assertionId: 'assertion-1',
    assertionKind: 'validatedEvidence',
    authority: {
      declarationId: 'declaration-1',
      role: 'app',
      producerId: 'producer-1',
      evidenceSelector: 'selector-1',
      producerVersion: '1.0.0',
      producerSha256: 'c'.repeat(64),
      strength: 'verified',
      completeness: 'point',
    },
    captureStatus: 'produced',
    evidence: {
      path: 'artifacts/subject.bin',
      sha256: sha256Hex(subject),
    },
    cleanupStatus: 'finalized',
    redactionStatus: 'not-redacted',
    artifactKind: 'logs',
    validationContract: 'unknown-contract-v9',
  };
  return { ...base, ...overrides, subject };
}

function reportBytesFor(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function admittedInputs() {
  const { subject, ...candidate } = eligibleCandidate();
  const reportBytes = reportBytesFor('report-bytes-distinct');
  return {
    candidate,
    subjectBytes: subject,
    report: {
      path: 'artifacts/report.bin',
      sha256: sha256Hex(reportBytes),
    },
    reportBytes,
  };
}

const OUTSIDE_KEYS = ['contractVersion', 'nextAction', 'reasonCodes', 'status'];
const SUBJECT_BYTES_INVALID_KEYS = ['contractVersion', 'nextAction', 'reasonCodes', 'status'];
const SUBJECT_HASH_MISMATCH_KEYS = [
  'contractVersion',
  'nextAction',
  'reasonCodes',
  'status',
  'subjectArtifact',
];
const REPORT_BLOCKED_KEYS = [
  'contractVersion',
  'nextAction',
  'reasonCodes',
  'reportIdentity',
  'status',
  'subjectArtifact',
];
const ADMITTED_KEYS = [
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
];

const FORBIDDEN_VOCABULARY = [
  'not_applicable',
  'supported',
  'passed',
  'health',
  'verdict',
  'parsed',
  'findings',
  'published',
];

test('version is frozen 1.0.0', () => {
  assert.equal(CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION, '1.0.0');
});

test('distinct exact subject and report bytes return identity_admitted', () => {
  const input = admittedInputs();
  const result = inspectScenarioClaimValidatedEvidenceAdmission(input);
  assert.equal(result.status, 'identity_admitted');
  if (result.status !== 'identity_admitted') {
    return;
  }
  assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION);
  assert.deepEqual(Object.keys(result).sort(), ADMITTED_KEYS);
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.nextAction, 'evaluate_validated_evidence_report');
  assert.equal(result.candidateId, input.candidate.candidateId);
  assert.equal(result.runIdentityHash, input.candidate.runIdentityHash);
  assert.equal(result.claimId, input.candidate.claimId);
  assert.equal(result.claimHash, input.candidate.claimHash);
  assert.equal(result.assertionId, input.candidate.assertionId);
  assert.equal(result.assertionKind, 'validatedEvidence');
  assert.equal(result.artifactKind, input.candidate.artifactKind);
  assert.equal(result.validationContract, input.candidate.validationContract);
  assert.equal(result.subjectArtifact.path, input.candidate.evidence.path);
  assert.equal(result.subjectArtifact.sha256, input.candidate.evidence.sha256);
  assert.equal(result.subjectArtifact.byteLength, input.subjectBytes.byteLength);
  assert.equal(result.reportArtifact.path, input.report.path);
  assert.equal(result.reportArtifact.sha256, input.report.sha256);
  assert.equal(result.reportArtifact.byteLength, input.reportBytes.byteLength);
  assert.notEqual(result.subjectArtifact.sha256, result.reportArtifact.sha256);
});

const VALID_OBSERVATION_WINDOW = {
  from: 'phase/start',
  to: 'phase/end',
  completeSourceRequired: true,
} as const;

function eligibleJsonNativeCandidate(
  kind: 'eventOccurrence' | 'eventOrder' | 'boundedCount' | 'absence',
) {
  const subject = new TextEncoder().encode('subject-bytes');
  const base = {
    schemaVersion: '1.0.0',
    candidateId: 'candidate-1',
    runIdentityHash: 'a'.repeat(64),
    claimId: 'claim-1',
    claimHash: 'b'.repeat(64),
    assertionId: 'assertion-1',
    assertionKind: kind,
    authority: {
      declarationId: 'declaration-1',
      role: 'app',
      producerId: 'producer-1',
      evidenceSelector: 'selector-1',
      producerVersion: '1.0.0',
      producerSha256: 'c'.repeat(64),
      strength: 'verified',
      completeness: 'point',
    },
    captureStatus: 'produced',
    evidence: {
      path: 'artifacts/subject.bin',
      sha256: sha256Hex(subject),
    },
    cleanupStatus: 'finalized',
    redactionStatus: 'not-redacted',
  };
  if (kind === 'boundedCount' || kind === 'absence') {
    return {
      ...base,
      observationWindow: { ...VALID_OBSERVATION_WINDOW },
      subject,
    };
  }
  return { ...base, subject };
}

test('ineligible and JSON-native candidates return outside_contract without reading report', () => {
  let reportReads = 0;
  const report = new Proxy(
    { path: 'artifacts/report.bin', sha256: '00'.repeat(32) },
    {
      get(target, prop) {
        reportReads += 1;
        return Reflect.get(target, prop);
      },
    },
  );
  const reportBytes = new Proxy(reportBytesFor('report'), {
    get(target, prop) {
      reportReads += 1;
      return Reflect.get(target, prop);
    },
  });

  const jsonNative = eligibleJsonNativeCandidate('eventOccurrence');
  const { subject: _s, ...jsonCandidate } = jsonNative;
  const jsonResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: jsonCandidate,
    subjectBytes: new Uint8Array([1]),
    report,
    reportBytes,
  });
  assert.equal(jsonResult.status, 'outside_contract');
  if (jsonResult.status === 'outside_contract') {
    assert.deepEqual(Object.keys(jsonResult).sort(), OUTSIDE_KEYS);
    assert.equal(jsonResult.contractVersion, CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION);
    assert.deepEqual(jsonResult.reasonCodes, ['assertion_kind_not_validated_evidence']);
    assert.equal(
      jsonResult.nextAction,
      'supply_eligible_validated_evidence_candidate_and_exact_bytes',
    );
  }
  assert.equal(reportReads, 0);

  const eventOrderNative = eligibleJsonNativeCandidate('eventOrder');
  const { subject: _eo, ...eventOrderCandidate } = eventOrderNative;
  const eventOrderResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: eventOrderCandidate,
    subjectBytes: new Uint8Array([1]),
    report,
    reportBytes,
  });
  assert.equal(eventOrderResult.status, 'outside_contract');
  if (eventOrderResult.status === 'outside_contract') {
    assert.deepEqual(eventOrderResult.reasonCodes, ['assertion_kind_not_validated_evidence']);
  }
  assert.equal(reportReads, 0);

  for (const kind of ['boundedCount', 'absence'] as const) {
    const windowedNative = eligibleJsonNativeCandidate(kind);
    const { subject: _w, ...windowedCandidate } = windowedNative;
    const windowedResult = inspectScenarioClaimValidatedEvidenceAdmission({
      candidate: windowedCandidate,
      subjectBytes: new Uint8Array([1]),
      report,
      reportBytes,
    });
    assert.equal(windowedResult.status, 'outside_contract', kind);
    if (windowedResult.status === 'outside_contract') {
      assert.deepEqual(windowedResult.reasonCodes, ['assertion_kind_not_validated_evidence']);
    }
    assert.equal(reportReads, 0);
  }

  const ineligibleWindows = [
    { name: 'missing window', observationWindow: undefined },
    { name: 'extra window key', observationWindow: { ...VALID_OBSERVATION_WINDOW, extra: true } },
    {
      name: 'unsafe from',
      observationWindow: { ...VALID_OBSERVATION_WINDOW, from: '../start' },
    },
    {
      name: 'completeSourceRequired false',
      observationWindow: { ...VALID_OBSERVATION_WINDOW, completeSourceRequired: false },
    },
  ] as const;
  for (const kind of ['boundedCount', 'absence'] as const) {
    for (const item of ineligibleWindows) {
      const built = eligibleJsonNativeCandidate(kind);
      const { subject: _iw, ...windowed } = built;
      const candidate =
        item.observationWindow === undefined
          ? (() => {
              const { observationWindow: _ow, ...rest } = windowed as Record<string, unknown>;
              return rest;
            })()
          : { ...windowed, observationWindow: item.observationWindow };
      const result = inspectScenarioClaimValidatedEvidenceAdmission({
        candidate,
        subjectBytes: new Uint8Array([1]),
        report,
        reportBytes,
      });
      assert.equal(result.status, 'outside_contract', `${kind}:${item.name}`);
      if (result.status === 'outside_contract') {
        assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
      }
    }
  }
  assert.equal(reportReads, 0);

  const unknownKind = eligibleCandidate({ assertionKind: 'jsonNative' });
  const { subject: _u, ...unknownCandidate } = unknownKind;
  const unknownResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: unknownCandidate,
    subjectBytes: new Uint8Array([1]),
    report,
    reportBytes,
  });
  assert.equal(unknownResult.status, 'outside_contract');
  if (unknownResult.status === 'outside_contract') {
    assert.deepEqual(unknownResult.reasonCodes, ['candidate_not_eligible']);
  }
  assert.equal(reportReads, 0);

  const ineligible = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: { assertionKind: 'validatedEvidence' },
    subjectBytes: new Uint8Array([1]),
    report,
    reportBytes,
  });
  assert.equal(ineligible.status, 'outside_contract');
  if (ineligible.status === 'outside_contract') {
    assert.deepEqual(ineligible.reasonCodes, ['candidate_not_eligible']);
  }
  assert.equal(reportReads, 0);
});

test('hostile run-relative identities reject candidate_not_eligible without reading report', () => {
  let reportReads = 0;
  const report = new Proxy(
    { path: 'artifacts/report.bin', sha256: '00'.repeat(32) },
    {
      get(target, prop) {
        reportReads += 1;
        return Reflect.get(target, prop);
      },
    },
  );
  const reportBytes = new Proxy(reportBytesFor('report'), {
    get(target, prop) {
      reportReads += 1;
      return Reflect.get(target, prop);
    },
  });
  const hostiles = ['../x', '/abs', 'C:foo', 'file:foo', 'a\\b'];
  const fields: Array<{ name: string; apply: (value: string) => Record<string, unknown> }> = [
    { name: 'candidateId', apply: (value) => ({ candidateId: value }) },
    { name: 'claimId', apply: (value) => ({ claimId: value }) },
    { name: 'assertionId', apply: (value) => ({ assertionId: value }) },
    { name: 'validationContract', apply: (value) => ({ validationContract: value }) },
    {
      name: 'authority.declarationId',
      apply: (value) => ({
        authority: {
          declarationId: value,
          role: 'app',
          producerId: 'producer-1',
          evidenceSelector: 'selector-1',
          producerVersion: '1.0.0',
          producerSha256: 'c'.repeat(64),
          strength: 'verified',
          completeness: 'point',
        },
      }),
    },
    {
      name: 'authority.producerId',
      apply: (value) => ({
        authority: {
          declarationId: 'declaration-1',
          role: 'app',
          producerId: value,
          evidenceSelector: 'selector-1',
          producerVersion: '1.0.0',
          producerSha256: 'c'.repeat(64),
          strength: 'verified',
          completeness: 'point',
        },
      }),
    },
    {
      name: 'authority.evidenceSelector',
      apply: (value) => ({
        authority: {
          declarationId: 'declaration-1',
          role: 'app',
          producerId: 'producer-1',
          evidenceSelector: value,
          producerVersion: '1.0.0',
          producerSha256: 'c'.repeat(64),
          strength: 'verified',
          completeness: 'point',
        },
      }),
    },
    {
      name: 'authority.producerVersion',
      apply: (value) => ({
        authority: {
          declarationId: 'declaration-1',
          role: 'app',
          producerId: 'producer-1',
          evidenceSelector: 'selector-1',
          producerVersion: value,
          producerSha256: 'c'.repeat(64),
          strength: 'verified',
          completeness: 'point',
        },
      }),
    },
  ];

  for (const field of fields) {
    for (const hostile of hostiles) {
      const built = eligibleCandidate(field.apply(hostile));
      const { subject: _s, ...candidate } = built;
      const result = inspectScenarioClaimValidatedEvidenceAdmission({
        candidate,
        subjectBytes: new Uint8Array([1]),
        report,
        reportBytes,
      });
      assert.equal(result.status, 'outside_contract', `${field.name}:${hostile}`);
      if (result.status === 'outside_contract') {
        assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
      }
    }
  }
  assert.equal(reportReads, 0);
});

test('getter-backed candidate values stay consistent from the first stable projection', () => {
  const { subject, ...plain } = eligibleCandidate();
  let candidateIdReads = 0;
  let shaReads = 0;
  const evidence = {
    get path() {
      return 'artifacts/subject.bin';
    },
    get sha256() {
      shaReads += 1;
      if (shaReads === 1) {
        return (plain.evidence as { sha256: string }).sha256;
      }
      return 'ff'.repeat(32);
    },
  };
  const candidate = {
    get schemaVersion() {
      return plain.schemaVersion;
    },
    get candidateId() {
      candidateIdReads += 1;
      return candidateIdReads === 1 ? 'candidate-1' : 'mutated-candidate';
    },
    get runIdentityHash() {
      return plain.runIdentityHash;
    },
    get claimId() {
      return plain.claimId;
    },
    get claimHash() {
      return plain.claimHash;
    },
    get assertionId() {
      return plain.assertionId;
    },
    get assertionKind() {
      return plain.assertionKind;
    },
    get authority() {
      return plain.authority;
    },
    get captureStatus() {
      return plain.captureStatus;
    },
    get evidence() {
      return evidence;
    },
    get cleanupStatus() {
      return plain.cleanupStatus;
    },
    get redactionStatus() {
      return plain.redactionStatus;
    },
    get artifactKind() {
      return plain.artifactKind;
    },
    get validationContract() {
      return plain.validationContract;
    },
  };
  const reportBytes = reportBytesFor('report-bytes-distinct');
  const result = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate,
    subjectBytes: subject,
    report: {
      path: 'artifacts/report.bin',
      sha256: sha256Hex(reportBytes),
    },
    reportBytes,
  });
  assert.equal(result.status, 'identity_admitted');
  if (result.status === 'identity_admitted') {
    assert.equal(result.candidateId, 'candidate-1');
    assert.equal(result.subjectArtifact.sha256, (plain.evidence as { sha256: string }).sha256);
    assert.equal(result.subjectArtifact.path, 'artifacts/subject.bin');
  }
});

test('invalid candidate evidence paths fail closed as candidate_not_eligible', () => {
  const paths = [
    '/absolute/path.bin',
    'C:/drive/path.bin',
    'file:artifacts/subject.bin',
    'artifacts\\subject.bin',
    'artifacts/nested/../subject.bin',
  ];
  for (const path of paths) {
    const built = eligibleCandidate({
      evidence: { path, sha256: 'd'.repeat(64) },
    });
    const { subject: _s, ...candidate } = built;
    const result = inspectScenarioClaimValidatedEvidenceAdmission({
      candidate,
      subjectBytes: new Uint8Array([1]),
      report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
      reportBytes: reportBytesFor('x'),
    });
    assert.equal(result.status, 'outside_contract', path);
    if (result.status === 'outside_contract') {
      assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
    }
  }
});

test('uppercase SHA, untrimmed identity, extra keys, class instance, and symbol fail closed', () => {
  const cases: Array<{ name: string; candidate: unknown }> = [
    {
      name: 'uppercase sha',
      candidate: eligibleCandidate({
        evidence: {
          path: 'artifacts/subject.bin',
          sha256: 'A'.repeat(64),
        },
      }),
    },
    {
      name: 'untrimmed identity',
      candidate: eligibleCandidate({ candidateId: ' candidate-1 ' }),
    },
    {
      name: 'extra authority key',
      candidate: eligibleCandidate({
        authority: {
          declarationId: 'declaration-1',
          role: 'app',
          producerId: 'producer-1',
          evidenceSelector: 'selector-1',
          producerVersion: '1.0.0',
          producerSha256: 'c'.repeat(64),
          strength: 'verified',
          completeness: 'point',
          extra: true,
        },
      }),
    },
    {
      name: 'extra evidence key',
      candidate: eligibleCandidate({
        evidence: {
          path: 'artifacts/subject.bin',
          sha256: 'd'.repeat(64),
          extra: true,
        },
      }),
    },
    {
      name: 'observationWindow',
      candidate: eligibleCandidate({ observationWindow: { ...VALID_OBSERVATION_WINDOW } }),
    },
  ];

  for (const item of cases) {
    const raw = item.candidate as { subject?: Uint8Array } & Record<string, unknown>;
    const { subject: _s, ...candidate } = raw;
    const result = inspectScenarioClaimValidatedEvidenceAdmission({
      candidate,
      subjectBytes: new Uint8Array([1]),
      report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
      reportBytes: reportBytesFor('x'),
    });
    assert.equal(result.status, 'outside_contract', item.name);
    if (result.status === 'outside_contract') {
      assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
    }
  }

  class CandidateClass {}
  const classResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: new CandidateClass(),
    subjectBytes: new Uint8Array([1]),
    report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
    reportBytes: reportBytesFor('x'),
  });
  assert.equal(classResult.status, 'outside_contract');
  if (classResult.status === 'outside_contract') {
    assert.deepEqual(classResult.reasonCodes, ['candidate_not_eligible']);
  }

  const { subject: _sym, ...plain } = eligibleCandidate();
  const withSymbol = { ...plain, [Symbol('extra')]: true };
  const symbolResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: withSymbol,
    subjectBytes: new Uint8Array([1]),
    report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
    reportBytes: reportBytesFor('x'),
  });
  assert.equal(symbolResult.status, 'outside_contract');
  if (symbolResult.status === 'outside_contract') {
    assert.deepEqual(symbolResult.reasonCodes, ['candidate_not_eligible']);
  }
});

test('throwing top-level ownKeys and get plus throwing candidate proxy fail closed without throw', () => {
  const throwingOwnKeys = new Proxy(
    {
      candidate: {},
      subjectBytes: new Uint8Array([1]),
      report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
      reportBytes: reportBytesFor('x'),
    },
    {
      ownKeys() {
        throw new Error('ownKeys');
      },
    },
  );
  const ownKeysResult = inspectScenarioClaimValidatedEvidenceAdmission(throwingOwnKeys);
  assert.equal(ownKeysResult.status, 'outside_contract');
  if (ownKeysResult.status === 'outside_contract') {
    assert.deepEqual(ownKeysResult.reasonCodes, ['input_invalid']);
  }

  const throwingGet = new Proxy(
    {
      candidate: {},
      subjectBytes: new Uint8Array([1]),
      report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
      reportBytes: reportBytesFor('x'),
    },
    {
      get(_target, prop) {
        if (prop === 'candidate' || prop === 'subjectBytes') {
          throw new Error('get');
        }
        return Reflect.get(_target, prop);
      },
    },
  );
  const getResult = inspectScenarioClaimValidatedEvidenceAdmission(throwingGet);
  assert.equal(getResult.status, 'outside_contract');
  if (getResult.status === 'outside_contract') {
    assert.deepEqual(getResult.reasonCodes, ['input_invalid']);
  }

  const throwingCandidate = new Proxy(
    { assertionKind: 'validatedEvidence' },
    {
      get() {
        throw new Error('candidate');
      },
    },
  );
  const candidateResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: throwingCandidate,
    subjectBytes: new Uint8Array([1]),
    report: { path: 'artifacts/report.bin', sha256: 'e'.repeat(64) },
    reportBytes: reportBytesFor('x'),
  });
  assert.equal(candidateResult.status, 'outside_contract');
  if (candidateResult.status === 'outside_contract') {
    assert.deepEqual(candidateResult.reasonCodes, ['candidate_not_eligible']);
  }
});

test('composer rejects a top-level artifactBytes key instead of subjectBytes', () => {
  const input = admittedInputs();
  const result = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: input.candidate,
    artifactBytes: input.subjectBytes,
    report: input.report,
    reportBytes: input.reportBytes,
  });
  assert.equal(result.status, 'outside_contract');
  if (result.status === 'outside_contract') {
    assert.deepEqual(Object.keys(result).sort(), OUTSIDE_KEYS);
    assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION);
    assert.deepEqual(result.reasonCodes, ['input_invalid']);
  }
});

test('invalid subject bytes return subject_blocked without touching report', () => {
  const { candidate } = admittedInputs();
  let reportReads = 0;
  const report = {
    get path() {
      reportReads += 1;
      return 'artifacts/report.bin';
    },
    get sha256() {
      reportReads += 1;
      return '00'.repeat(32);
    },
  };
  const result = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate,
    subjectBytes: 'not-bytes',
    report,
    reportBytes: reportBytesFor('x'),
  });
  assert.equal(result.status, 'subject_blocked');
  if (result.status === 'subject_blocked') {
    assert.deepEqual(Object.keys(result).sort(), SUBJECT_BYTES_INVALID_KEYS);
    assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION);
    assert.deepEqual(result.reasonCodes, ['subject_bytes_invalid']);
    assert.equal(result.nextAction, 'supply_exact_subject_bytes');
    assert.equal('subjectArtifact' in result, false);
  }
  assert.equal(reportReads, 0);
});

test('subject hash mismatch returns subject_blocked with observed identity', () => {
  const { candidate, report, reportBytes } = admittedInputs();
  let reportReads = 0;
  const hostileReport = new Proxy(report, {
    get(target, prop) {
      reportReads += 1;
      return Reflect.get(target, prop);
    },
  });
  const observed = new TextEncoder().encode('different-subject');
  const result = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate,
    subjectBytes: observed,
    report: hostileReport,
    reportBytes,
  });
  assert.equal(result.status, 'subject_blocked');
  if (result.status === 'subject_blocked' && 'subjectArtifact' in result) {
    assert.deepEqual(result.reasonCodes, ['subject_hash_mismatch']);
    assert.deepEqual(Object.keys(result).sort(), SUBJECT_HASH_MISMATCH_KEYS);
    assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION);
    assert.equal(result.subjectArtifact.expectedSha256, candidate.evidence.sha256);
    assert.equal(result.subjectArtifact.observedSha256, sha256Hex(observed));
    assert.equal(result.subjectArtifact.byteLength, observed.byteLength);
    assert.equal(result.subjectArtifact.path, candidate.evidence.path);
  } else {
    assert.fail('expected subject_hash_mismatch with subjectArtifact');
  }
  assert.equal(reportReads, 0);
});

test('detached, proxy, and spoof subject bytes fail subject_bytes_invalid without reading report', () => {
  const { candidate, report, reportBytes } = admittedInputs();
  let reportReads = 0;
  const hostileReport = new Proxy(report, {
    get(target, prop) {
      reportReads += 1;
      return Reflect.get(target, prop);
    },
  });
  const spoof = {
    byteLength: 4,
    buffer: new ArrayBuffer(4),
    byteOffset: 0,
  };
  const buffer = new ArrayBuffer(4);
  const detached = new Uint8Array(buffer);
  detached.set([1, 2, 3, 4]);
  structuredClone(buffer, { transfer: [buffer] });
  const proxyBytes = new Proxy(new Uint8Array([1, 2, 3]), {
    get() {
      throw new Error('subject');
    },
  });

  for (const subjectBytes of [spoof, detached, proxyBytes]) {
    const result = inspectScenarioClaimValidatedEvidenceAdmission({
      candidate,
      subjectBytes,
      report: hostileReport,
      reportBytes,
    });
    assert.equal(result.status, 'subject_blocked');
    if (result.status === 'subject_blocked') {
      assert.deepEqual(result.reasonCodes, ['subject_bytes_invalid']);
      assert.equal('subjectArtifact' in result, false);
    }
  }
  assert.equal(reportReads, 0);
});

test('report identity failures after subject bind preserve nested reportIdentity', () => {
  const { candidate, subjectBytes } = admittedInputs();
  const reportBytes = reportBytesFor('report-ok');
  const cases = [
    {
      name: 'malformed report',
      report: { path: 1, sha256: 'not-hash' },
      bytes: reportBytes,
      expectedStatus: 'outside_contract',
      expectedReasons: ['report_identity_invalid'],
      expectedNext: 'supply_eligible_validated_evidence_candidate_and_exact_report_bytes',
    },
    {
      name: 'invalid report bytes',
      report: { path: 'artifacts/report.bin', sha256: sha256Hex(reportBytes) },
      bytes: 'nope',
      expectedStatus: 'outside_contract',
      expectedReasons: ['report_bytes_invalid'],
      expectedNext: 'supply_eligible_validated_evidence_candidate_and_exact_report_bytes',
    },
    {
      name: 'report hash mismatch',
      report: { path: 'artifacts/report.bin', sha256: 'ab'.repeat(32) },
      bytes: reportBytes,
      expectedStatus: 'blocked',
      expectedReasons: ['report_hash_mismatch'],
      expectedNext: 'supply_exact_report_bytes',
    },
    {
      name: 'same path collision',
      report: { path: candidate.evidence.path, sha256: sha256Hex(reportBytes) },
      bytes: reportBytes,
      expectedStatus: 'blocked',
      expectedReasons: ['subject_report_identity_collision'],
      expectedNext: 'declare_distinct_report_identity',
    },
    {
      name: 'same SHA collision',
      report: { path: 'artifacts/report.bin', sha256: candidate.evidence.sha256 },
      bytes: subjectBytes,
      expectedStatus: 'blocked',
      expectedReasons: ['subject_report_identity_collision'],
      expectedNext: 'declare_distinct_report_identity',
    },
  ] as const;

  for (const item of cases) {
    const result = inspectScenarioClaimValidatedEvidenceAdmission({
      candidate,
      subjectBytes,
      report: item.report,
      reportBytes: item.bytes,
    });
    assert.equal(result.status, 'report_blocked', item.name);
    if (result.status !== 'report_blocked') {
      continue;
    }
    assert.deepEqual(Object.keys(result).sort(), REPORT_BLOCKED_KEYS, item.name);
    assert.equal(result.contractVersion, CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION);
    assert.equal(result.reportIdentity.status, item.expectedStatus, item.name);
    assert.deepEqual(result.reportIdentity.reasonCodes, [...item.expectedReasons], item.name);
    assert.equal(result.reportIdentity.nextAction, item.expectedNext, item.name);
    assert.deepEqual(result.reasonCodes, [...result.reportIdentity.reasonCodes]);
    assert.equal(result.nextAction, result.reportIdentity.nextAction);
    assert.equal(result.subjectArtifact.path, candidate.evidence.path);
    assert.equal(result.subjectArtifact.sha256, candidate.evidence.sha256);
  }
});

test('Buffer, empty bytes, and non-zero-offset subject views bind identities', () => {
  const empty = new Uint8Array(0);
  const emptyCandidate = eligibleCandidate({
    evidence: { path: 'artifacts/empty.bin', sha256: sha256Hex(empty) },
  });
  const { subject: _e, ...emptyCand } = emptyCandidate;
  const emptyReport = reportBytesFor('empty-report');
  const emptyResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: emptyCand,
    subjectBytes: empty,
    report: { path: 'artifacts/empty-report.bin', sha256: sha256Hex(emptyReport) },
    reportBytes: emptyReport,
  });
  assert.equal(emptyResult.status, 'identity_admitted');
  if (emptyResult.status === 'identity_admitted') {
    assert.equal(emptyResult.subjectArtifact.byteLength, 0);
    assert.equal(emptyResult.subjectArtifact.sha256, sha256Hex(empty));
    assert.equal(emptyResult.reportArtifact.byteLength, emptyReport.byteLength);
  }

  const payload = new TextEncoder().encode('offset-subject');
  const enclosing = new Uint8Array(payload.length + 4);
  enclosing.set(payload, 2);
  const view = enclosing.subarray(2, 2 + payload.length);
  const offsetCandidate = eligibleCandidate({
    evidence: { path: 'artifacts/offset.bin', sha256: sha256Hex(payload) },
  });
  const { subject: _o, ...offsetCand } = offsetCandidate;
  const offsetReport = reportBytesFor('offset-report');
  const offsetResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: offsetCand,
    subjectBytes: view,
    report: { path: 'artifacts/offset-report.bin', sha256: sha256Hex(offsetReport) },
    reportBytes: offsetReport,
  });
  assert.equal(offsetResult.status, 'identity_admitted');
  if (offsetResult.status === 'identity_admitted') {
    assert.equal(offsetResult.subjectArtifact.byteLength, payload.byteLength);
    assert.equal(offsetResult.subjectArtifact.sha256, sha256Hex(payload));
  }

  const bufferPayload = Buffer.from('buffer-subject');
  const bufferCandidate = eligibleCandidate({
    evidence: { path: 'artifacts/buffer.bin', sha256: sha256Hex(bufferPayload) },
  });
  const { subject: _b, ...bufferCand } = bufferCandidate;
  const bufferReport = reportBytesFor('buffer-report');
  const bufferResult = inspectScenarioClaimValidatedEvidenceAdmission({
    candidate: bufferCand,
    subjectBytes: bufferPayload,
    report: { path: 'artifacts/buffer.bin-report', sha256: sha256Hex(bufferReport) },
    reportBytes: bufferReport,
  });
  assert.equal(bufferResult.status, 'identity_admitted');
  if (bufferResult.status === 'identity_admitted') {
    assert.equal(bufferResult.subjectArtifact.byteLength, bufferPayload.byteLength);
    assert.equal(bufferResult.subjectArtifact.sha256, sha256Hex(bufferPayload));
  }
});

test('mutating caller candidate and report after blocked results cannot alter returned identities', () => {
  const mismatchInput = admittedInputs();
  const mismatchObserved = new TextEncoder().encode('different-subject');
  const mismatch = inspectScenarioClaimValidatedEvidenceAdmission({
    ...mismatchInput,
    subjectBytes: mismatchObserved,
  });
  assert.equal(mismatch.status, 'subject_blocked');
  if (mismatch.status === 'subject_blocked' && 'subjectArtifact' in mismatch) {
    mismatchInput.candidate.evidence.path = 'mutated.bin';
    mismatchInput.candidate.evidence.sha256 = 'ff'.repeat(32);
    mismatchInput.report.path = 'mutated-report.bin';
    assert.equal(mismatch.subjectArtifact.path, 'artifacts/subject.bin');
    assert.notEqual(mismatch.subjectArtifact.expectedSha256, 'ff'.repeat(32));
  } else {
    assert.fail('expected subject_hash_mismatch with subjectArtifact');
  }

  const blockedInput = admittedInputs();
  const blocked = inspectScenarioClaimValidatedEvidenceAdmission({
    ...blockedInput,
    report: { path: blockedInput.candidate.evidence.path, sha256: blockedInput.report.sha256 },
  });
  assert.equal(blocked.status, 'report_blocked');
  if (blocked.status === 'report_blocked') {
    blockedInput.candidate.evidence.path = 'mutated.bin';
    blockedInput.report.path = 'mutated-report.bin';
    assert.equal(blocked.subjectArtifact.path, 'artifacts/subject.bin');
    assert.equal(blocked.reportIdentity.status, 'blocked');
  }
});

test('mutating inputs after return cannot alter identity_admitted output', () => {
  const input = admittedInputs();
  const result = inspectScenarioClaimValidatedEvidenceAdmission(input);
  assert.equal(result.status, 'identity_admitted');
  if (result.status !== 'identity_admitted') {
    return;
  }
  input.candidate.candidateId = 'mutated';
  input.candidate.evidence.path = 'mutated.bin';
  input.candidate.validationContract = 'mutated';
  input.subjectBytes[0] = 9;
  input.report.path = 'mutated-report.bin';
  assert.equal(result.candidateId, 'candidate-1');
  assert.equal(result.subjectArtifact.path, 'artifacts/subject.bin');
  assert.equal(result.validationContract, 'unknown-contract-v9');
  assert.equal(result.reportArtifact.path, 'artifacts/report.bin');
});

test('raw observation reader remains unsupported for validatedEvidence', () => {
  const input = admittedInputs();
  const admitted = inspectScenarioClaimValidatedEvidenceAdmission(input);
  assert.equal(admitted.status, 'identity_admitted');
  const raw = inspectScenarioClaimRawObservationAdmission({
    candidate: input.candidate,
    artifactBytes: input.subjectBytes,
  });
  assert.equal(raw.status, 'unsupported');
  if (raw.status === 'unsupported') {
    assert.equal(raw.reasonCode, 'validated_evidence_report_identity_undefined');
  }
});

test('serialized results never contain semantic product vocabulary', () => {
  const samples = [
    inspectScenarioClaimValidatedEvidenceAdmission(null),
    inspectScenarioClaimValidatedEvidenceAdmission(admittedInputs()),
    inspectScenarioClaimValidatedEvidenceAdmission({
      ...admittedInputs(),
      subjectBytes: new TextEncoder().encode('mismatch'),
    }),
    inspectScenarioClaimValidatedEvidenceAdmission({
      ...admittedInputs(),
      report: { path: 1, sha256: 'not-hash' },
    }),
  ];
  for (const sample of samples) {
    const serialized = JSON.stringify(sample);
    for (const word of FORBIDDEN_VOCABULARY) {
      assert.equal(serialized.includes(word), false, `${sample.status}:${word}`);
    }
  }
});
