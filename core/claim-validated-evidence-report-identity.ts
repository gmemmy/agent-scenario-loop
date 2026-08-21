import { snapshotAndHashExactArtifactBytes } from './exact-artifact-bytes';
import type { ScenarioClaimEligibleEvidenceCandidate } from './claim-evidence-candidate-identity';

export const CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION = '1.0.0' as const;

const JSON_NATIVE_ASSERTION_KINDS = [
  'eventOccurrence',
  'eventOrder',
  'terminalState',
  'boundedCount',
  'absence',
] as const;

const ARTIFACT_KINDS = [
  'logs',
  'screenshot',
  'video',
  'uiTree',
  'memory',
  'nativePerformance',
  'network',
  'profiler',
  'accessibility',
  'signals',
] as const;

const AUTHORITY_ROLES = ['app', 'runner', 'adapter', 'provider', 'comparator'] as const;
const AUTHORITY_STRENGTHS = ['observed', 'verified'] as const;
const AUTHORITY_COMPLETENESS = ['point', 'bounded', 'continuous-complete'] as const;
const CLEANUP_STATUSES = ['finalized', 'not_required'] as const;
const REDACTION_STATUSES = ['not-redacted', 'redacted', 'private'] as const;

const INPUT_KEYS = ['candidate', 'report', 'reportBytes'] as const;
const REPORT_KEYS = ['path', 'sha256'] as const;
const EVIDENCE_KEYS = ['path', 'sha256'] as const;
const AUTHORITY_KEYS = [
  'declarationId',
  'role',
  'producerId',
  'evidenceSelector',
  'producerVersion',
  'producerSha256',
  'strength',
  'completeness',
] as const;
const CANDIDATE_COMMON_KEYS = [
  'schemaVersion',
  'candidateId',
  'claimId',
  'assertionId',
  'runIdentityHash',
  'claimHash',
  'assertionKind',
  'authority',
  'captureStatus',
  'evidence',
  'cleanupStatus',
  'redactionStatus',
] as const;
const CANDIDATE_ALLOWED_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  'artifactKind',
  'validationContract',
  'observationWindow',
] as const;
const VALIDATED_EVIDENCE_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  'artifactKind',
  'validationContract',
] as const;
const WINDOWED_JSON_NATIVE_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  'observationWindow',
] as const;
const OBSERVATION_WINDOW_KEYS = ['from', 'to', 'completeSourceRequired'] as const;

type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function inspectScenarioClaimValidatedEvidenceReportIdentity(
  input: unknown,
): ScenarioClaimValidatedEvidenceReportIdentityInspection {
  try {
    return inspectValidatedEvidenceReportIdentity(input);
  } catch {
    return outsideContract(['input_invalid']);
  }
}

function inspectValidatedEvidenceReportIdentity(
  input: unknown,
): ScenarioClaimValidatedEvidenceReportIdentityInspection {
  if (!isPlainRecord(input) || !hasExactKeys(input, INPUT_KEYS)) {
    return outsideContract(['input_invalid']);
  }

  const candidateParse = parseEligibleValidatedEvidenceCandidate(input.candidate);
  const reportParse = parseReportIdentity(input.report);
  const snapshot = snapshotAndHashExactArtifactBytes(input.reportBytes);

  if (!candidateParse.valid || !reportParse.valid || snapshot === null) {
    const reasons: OutsideReason[] = [];
    if (!candidateParse.valid) {
      reasons.push(candidateParse.reason);
    }
    if (!reportParse.valid) {
      reasons.push('report_identity_invalid');
    }
    if (snapshot === null) {
      reasons.push('report_bytes_invalid');
    }
    return outsideContract(toReasonTuple(reasons));
  }

  const expectedSha256 = reportParse.identity.sha256;
  const observedSha256 = snapshot.sha256;
  const byteLength = snapshot.bytes.byteLength;
  if (expectedSha256 !== observedSha256) {
    return {
      contractVersion: CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
      candidateId: copyString(candidateParse.candidate.candidateId),
      runIdentityHash: copyString(candidateParse.candidate.runIdentityHash),
      claimId: copyString(candidateParse.candidate.claimId),
      claimHash: copyString(candidateParse.candidate.claimHash),
      assertionId: copyString(candidateParse.candidate.assertionId),
      assertionKind: 'validatedEvidence',
      artifactKind: candidateParse.candidate.artifactKind,
      validationContract: copyString(candidateParse.candidate.validationContract),
      status: 'blocked',
      reasonCodes: ['report_hash_mismatch'],
      nextAction: 'supply_exact_report_bytes',
      reportArtifact: {
        path: copyString(reportParse.identity.path),
        expectedSha256: copyString(expectedSha256),
        observedSha256: copyString(observedSha256),
        byteLength,
      },
    };
  }

  const subjectPath = candidateParse.candidate.evidence.path;
  const subjectSha256 = candidateParse.candidate.evidence.sha256;
  const reportPath = reportParse.identity.path;
  const reportSha256 = snapshot.sha256;

  if (subjectPath === reportPath || subjectSha256 === reportSha256) {
    return {
      contractVersion: CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
      candidateId: copyString(candidateParse.candidate.candidateId),
      runIdentityHash: copyString(candidateParse.candidate.runIdentityHash),
      claimId: copyString(candidateParse.candidate.claimId),
      claimHash: copyString(candidateParse.candidate.claimHash),
      assertionId: copyString(candidateParse.candidate.assertionId),
      assertionKind: 'validatedEvidence',
      artifactKind: candidateParse.candidate.artifactKind,
      validationContract: copyString(candidateParse.candidate.validationContract),
      status: 'blocked',
      reasonCodes: ['subject_report_identity_collision'],
      nextAction: 'declare_distinct_report_identity',
      subjectArtifact: {
        path: copyString(subjectPath),
        sha256: copyString(subjectSha256),
      },
      reportArtifact: {
        path: copyString(reportPath),
        sha256: copyString(reportSha256),
        byteLength,
      },
    };
  }

  return {
    contractVersion: CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
    candidateId: copyString(candidateParse.candidate.candidateId),
    runIdentityHash: copyString(candidateParse.candidate.runIdentityHash),
    claimId: copyString(candidateParse.candidate.claimId),
    claimHash: copyString(candidateParse.candidate.claimHash),
    assertionId: copyString(candidateParse.candidate.assertionId),
    assertionKind: 'validatedEvidence',
    artifactKind: candidateParse.candidate.artifactKind,
    validationContract: copyString(candidateParse.candidate.validationContract),
    status: 'admitted',
    reasonCodes: [],
    nextAction: 'evaluate_validated_evidence_report',
    subjectArtifact: {
      path: copyString(subjectPath),
      sha256: copyString(subjectSha256),
    },
    reportArtifact: {
      path: copyString(reportPath),
      sha256: copyString(reportSha256),
      byteLength,
    },
  };
}

function outsideContract(
  reasonCodes: OutsideReasonTuple,
): ScenarioClaimValidatedEvidenceReportIdentityOutsideContract {
  return {
    contractVersion: CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
    status: 'outside_contract',
    reasonCodes,
    nextAction: 'supply_eligible_validated_evidence_candidate_and_exact_report_bytes',
  };
}

function toReasonTuple(reasons: OutsideReason[]): OutsideReasonTuple {
  const first = reasons[0];
  if (first === undefined) {
    return ['input_invalid'];
  }
  return [first, ...reasons.slice(1)];
}

type CandidateParse =
  | { valid: true; candidate: ValidatedEvidenceCandidateProjection }
  | {
      valid: false;
      reason: 'candidate_not_eligible' | 'assertion_kind_not_validated_evidence';
    };

function parseEligibleValidatedEvidenceCandidate(value: unknown): CandidateParse {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CANDIDATE_ALLOWED_KEYS)) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }
  if (!CANDIDATE_COMMON_KEYS.every((key) => Object.hasOwn(value, key))) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }
  if (value.schemaVersion !== '1.0.0') {
    return { valid: false, reason: 'candidate_not_eligible' };
  }

  const candidateId = parseIdentityString(value.candidateId);
  const claimId = parseIdentityString(value.claimId);
  const assertionId = parseIdentityString(value.assertionId);
  const runIdentityHash = parseSha256(value.runIdentityHash);
  const claimHash = parseSha256(value.claimHash);
  if (
    candidateId === undefined
    || claimId === undefined
    || assertionId === undefined
    || runIdentityHash === undefined
    || claimHash === undefined
  ) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }

  const assertionKind = value.assertionKind;
  const isJsonNative = isClosedVocabulary(assertionKind, JSON_NATIVE_ASSERTION_KINDS);
  const isValidatedEvidence = assertionKind === 'validatedEvidence';
  if (!isValidatedEvidence && !isJsonNative) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }

  if (!isEligibleAuthority(value.authority)) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }
  if (value.captureStatus !== 'produced') {
    return { valid: false, reason: 'candidate_not_eligible' };
  }

  const evidence = parseEvidenceIdentity(value.evidence);
  if (evidence === undefined) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }
  if (!isClosedVocabulary(value.cleanupStatus, CLEANUP_STATUSES)) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }
  if (!isClosedVocabulary(value.redactionStatus, REDACTION_STATUSES)) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }

  if (isValidatedEvidence) {
    if (!hasExactKeys(value, VALIDATED_EVIDENCE_KEYS)) {
      return { valid: false, reason: 'candidate_not_eligible' };
    }
    if (!isClosedVocabulary(value.artifactKind, ARTIFACT_KINDS)) {
      return { valid: false, reason: 'candidate_not_eligible' };
    }
    const validationContract = parseIdentityString(value.validationContract);
    if (validationContract === undefined) {
      return { valid: false, reason: 'candidate_not_eligible' };
    }

    return {
      valid: true,
      candidate: {
        candidateId,
        claimId,
        assertionId,
        runIdentityHash,
        claimHash,
        artifactKind: value.artifactKind,
        validationContract,
        evidence,
      },
    };
  }

  if (
    !isJsonNative
    || !isEligibleJsonNativeCandidateShape(value, assertionKind)
  ) {
    return { valid: false, reason: 'candidate_not_eligible' };
  }
  return { valid: false, reason: 'assertion_kind_not_validated_evidence' };
}

function isEligibleJsonNativeCandidateShape(
  value: Record<string, unknown>,
  assertionKind: (typeof JSON_NATIVE_ASSERTION_KINDS)[number],
): boolean {
  switch (assertionKind) {
    case 'eventOccurrence':
    case 'eventOrder':
    case 'terminalState':
      return hasExactKeys(value, CANDIDATE_COMMON_KEYS);
    case 'boundedCount':
    case 'absence':
      return hasExactKeys(value, WINDOWED_JSON_NATIVE_KEYS)
        && isClosedEligibleObservationWindow(value.observationWindow);
  }
}

function isClosedEligibleObservationWindow(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, OBSERVATION_WINDOW_KEYS)) {
    return false;
  }
  return parseIdentityString(value.from) !== undefined
    && parseIdentityString(value.to) !== undefined
    && value.completeSourceRequired === true;
}

function isEligibleAuthority(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, AUTHORITY_KEYS)
    && parseIdentityString(value.declarationId) !== undefined
    && isClosedVocabulary(value.role, AUTHORITY_ROLES)
    && parseIdentityString(value.producerId) !== undefined
    && parseIdentityString(value.evidenceSelector) !== undefined
    && parseIdentityString(value.producerVersion) !== undefined
    && parseSha256(value.producerSha256) !== undefined
    && isClosedVocabulary(value.strength, AUTHORITY_STRENGTHS)
    && isClosedVocabulary(value.completeness, AUTHORITY_COMPLETENESS);
}

function parseEvidenceIdentity(
  value: unknown,
): { path: string; sha256: string } | undefined {
  if (!isPlainRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) {
    return undefined;
  }
  const path = parseIdentityString(value.path);
  const sha256 = parseSha256(value.sha256);
  if (path === undefined || sha256 === undefined) {
    return undefined;
  }
  return { path, sha256 };
}

type ReportParse =
  | { valid: true; identity: { path: string; sha256: string } }
  | { valid: false };

function parseReportIdentity(value: unknown): ReportParse {
  if (!isPlainRecord(value) || !hasExactKeys(value, REPORT_KEYS)) {
    return { valid: false };
  }
  const path = parseIdentityString(value.path);
  const sha256 = parseSha256(value.sha256);
  if (path === undefined || sha256 === undefined) {
    return { valid: false };
  }
  return { valid: true, identity: { path, sha256 } };
}

function parseIdentityString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length === 0 || value.trim() !== value) {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return undefined;
  }
  if (!isRunRelativePath(value)) {
    return undefined;
  }
  return value;
}

function parseSha256(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    return undefined;
  }
  return value;
}

function isRunRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) {
    return false;
  }
  if (/^[a-zA-Z]:/u.test(value) || /^file:/iu.test(value)) {
    return false;
  }
  return !value.split('/').includes('..');
}

function isClosedVocabulary<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasOnlyKeys(value, keys) && keys.every((key) => Object.hasOwn(value, key));
}

function copyString(value: string): string {
  return value.slice();
}

type ValidatedEvidenceCandidateProjection = {
  candidateId: string;
  claimId: string;
  assertionId: string;
  runIdentityHash: string;
  claimHash: string;
  artifactKind: ArtifactKind;
  validationContract: string;
  evidence: { path: string; sha256: string };
};

type OutsideReason =
  | 'input_invalid'
  | 'candidate_not_eligible'
  | 'assertion_kind_not_validated_evidence'
  | 'report_identity_invalid'
  | 'report_bytes_invalid';

type OutsideReasonTuple = readonly [OutsideReason, ...OutsideReason[]];

export type ScenarioClaimValidatedEvidenceReportIdentityInput = {
  candidate: ScenarioClaimEligibleEvidenceCandidate;
  report: { path: string; sha256: string };
  reportBytes: Uint8Array;
};

export type ScenarioClaimValidatedEvidenceReportIdentityOutsideContract = {
  contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION;
  status: 'outside_contract';
  reasonCodes: OutsideReasonTuple;
  nextAction: 'supply_eligible_validated_evidence_candidate_and_exact_report_bytes';
};

export type ScenarioClaimValidatedEvidenceReportIdentityBlockedHashMismatch = {
  contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION;
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: 'validatedEvidence';
  artifactKind: ArtifactKind;
  validationContract: string;
  status: 'blocked';
  reasonCodes: ['report_hash_mismatch'];
  nextAction: 'supply_exact_report_bytes';
  reportArtifact: {
    path: string;
    expectedSha256: string;
    observedSha256: string;
    byteLength: number;
  };
};

export type ScenarioClaimValidatedEvidenceReportIdentityBlockedCollision = {
  contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION;
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: 'validatedEvidence';
  artifactKind: ArtifactKind;
  validationContract: string;
  status: 'blocked';
  reasonCodes: ['subject_report_identity_collision'];
  nextAction: 'declare_distinct_report_identity';
  subjectArtifact: { path: string; sha256: string };
  reportArtifact: { path: string; sha256: string; byteLength: number };
};

export type ScenarioClaimValidatedEvidenceReportIdentityAdmitted = {
  contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION;
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: 'validatedEvidence';
  artifactKind: ArtifactKind;
  validationContract: string;
  status: 'admitted';
  reasonCodes: [];
  nextAction: 'evaluate_validated_evidence_report';
  subjectArtifact: { path: string; sha256: string };
  reportArtifact: { path: string; sha256: string; byteLength: number };
};

export type ScenarioClaimValidatedEvidenceReportIdentityInspection =
  | ScenarioClaimValidatedEvidenceReportIdentityOutsideContract
  | ScenarioClaimValidatedEvidenceReportIdentityBlockedHashMismatch
  | ScenarioClaimValidatedEvidenceReportIdentityBlockedCollision
  | ScenarioClaimValidatedEvidenceReportIdentityAdmitted;
