import { snapshotAndHashExactArtifactBytes } from './exact-artifact-bytes';
import { type ScenarioClaimEligibleEvidenceCandidate } from './claim-evidence-candidate-identity';
import {
  CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
  inspectScenarioClaimValidatedEvidenceReportIdentity,
  type ScenarioClaimValidatedEvidenceReportIdentityInspection,
} from './claim-validated-evidence-report-identity';

export const CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION = '1.0.0' as const;

const CLOSED_TOP_LEVEL_KEYS = [
  'candidate',
  'subjectBytes',
  'report',
  'reportBytes',
] as const;

const CLOSED_CANDIDATE_KEYS = [
  'schemaVersion',
  'candidateId',
  'runIdentityHash',
  'claimId',
  'claimHash',
  'assertionId',
  'assertionKind',
  'authority',
  'captureStatus',
  'evidence',
  'cleanupStatus',
  'redactionStatus',
  'artifactKind',
  'validationContract',
] as const;

const CLOSED_JSON_NATIVE_CANDIDATE_KEYS = [
  'schemaVersion',
  'candidateId',
  'runIdentityHash',
  'claimId',
  'claimHash',
  'assertionId',
  'assertionKind',
  'authority',
  'captureStatus',
  'evidence',
  'cleanupStatus',
  'redactionStatus',
] as const;

const CLOSED_WINDOWED_JSON_NATIVE_CANDIDATE_KEYS = [
  ...CLOSED_JSON_NATIVE_CANDIDATE_KEYS,
  'observationWindow',
] as const;

const CLOSED_AUTHORITY_KEYS = [
  'declarationId',
  'role',
  'producerId',
  'evidenceSelector',
  'producerVersion',
  'producerSha256',
  'strength',
  'completeness',
] as const;

const CLOSED_EVIDENCE_KEYS = ['path', 'sha256'] as const;

const CLOSED_OBSERVATION_WINDOW_KEYS = ['from', 'to', 'completeSourceRequired'] as const;

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
const STRENGTHS = ['observed', 'verified'] as const;
const COMPLETENESS = ['point', 'bounded', 'continuous-complete'] as const;
const CLEANUP_STATUSES = ['finalized', 'not_required'] as const;
const REDACTION_STATUSES = ['not-redacted', 'redacted', 'private'] as const;

const SEMANTIC_JSON_NATIVE_KINDS = [
  'eventOccurrence',
  'eventOrder',
  'terminalState',
] as const;

const WINDOWED_JSON_NATIVE_KINDS = ['boundedCount', 'absence'] as const;

const OUTSIDE_NEXT_ACTION =
  'supply_eligible_validated_evidence_candidate_and_exact_bytes' as const;
const SUBJECT_NEXT_ACTION = 'supply_exact_subject_bytes' as const;
const ADMITTED_NEXT_ACTION = 'evaluate_validated_evidence_report' as const;

export type ScenarioClaimValidatedEvidenceAdmissionInput = {
  readonly candidate: ScenarioClaimEligibleEvidenceCandidate;
  readonly subjectBytes: Uint8Array;
  readonly report: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly reportBytes: Uint8Array;
};

export type ScenarioClaimValidatedEvidenceAdmissionOutsideContract = {
  readonly status: 'outside_contract';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION;
  readonly reasonCodes: readonly [
    'input_invalid' | 'candidate_not_eligible' | 'assertion_kind_not_validated_evidence',
    ...Array<
      'input_invalid' | 'candidate_not_eligible' | 'assertion_kind_not_validated_evidence'
    >,
  ];
  readonly nextAction: typeof OUTSIDE_NEXT_ACTION;
};

export type ScenarioClaimValidatedEvidenceAdmissionSubjectBytesInvalid = {
  readonly status: 'subject_blocked';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION;
  readonly reasonCodes: readonly ['subject_bytes_invalid'];
  readonly nextAction: typeof SUBJECT_NEXT_ACTION;
};

export type ScenarioClaimValidatedEvidenceAdmissionSubjectHashMismatch = {
  readonly status: 'subject_blocked';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION;
  readonly reasonCodes: readonly ['subject_hash_mismatch'];
  readonly nextAction: typeof SUBJECT_NEXT_ACTION;
  readonly subjectArtifact: {
    readonly path: string;
    readonly expectedSha256: string;
    readonly observedSha256: string;
    readonly byteLength: number;
  };
};

export type ScenarioClaimValidatedEvidenceAdmissionSubjectBlocked =
  | ScenarioClaimValidatedEvidenceAdmissionSubjectBytesInvalid
  | ScenarioClaimValidatedEvidenceAdmissionSubjectHashMismatch;

type BlockedReportIdentity = Extract<
  ScenarioClaimValidatedEvidenceReportIdentityInspection,
  { status: 'outside_contract' | 'blocked' }
>;

export type ScenarioClaimValidatedEvidenceAdmissionReportBlocked = {
  readonly status: 'report_blocked';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION;
  readonly reasonCodes: BlockedReportIdentity['reasonCodes'];
  readonly nextAction: BlockedReportIdentity['nextAction'];
  readonly subjectArtifact: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly reportIdentity: BlockedReportIdentity;
};

export type ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted = {
  readonly status: 'identity_admitted';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION;
  readonly reasonCodes: readonly [];
  readonly nextAction: typeof ADMITTED_NEXT_ACTION;
  readonly candidateId: string;
  readonly runIdentityHash: string;
  readonly claimId: string;
  readonly claimHash: string;
  readonly assertionId: string;
  readonly assertionKind: 'validatedEvidence';
  readonly artifactKind: (typeof ARTIFACT_KINDS)[number];
  readonly validationContract: string;
  readonly subjectArtifact: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly reportArtifact: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
};

export type ScenarioClaimValidatedEvidenceAdmissionResult =
  | ScenarioClaimValidatedEvidenceAdmissionOutsideContract
  | ScenarioClaimValidatedEvidenceAdmissionSubjectBlocked
  | ScenarioClaimValidatedEvidenceAdmissionReportBlocked
  | ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted;

type EligibleValidatedEvidenceCandidate = {
  readonly schemaVersion: '1.0.0';
  readonly candidateId: string;
  readonly runIdentityHash: string;
  readonly claimId: string;
  readonly claimHash: string;
  readonly assertionId: string;
  readonly assertionKind: 'validatedEvidence';
  readonly authority: {
    readonly declarationId: string;
    readonly role: (typeof AUTHORITY_ROLES)[number];
    readonly producerId: string;
    readonly evidenceSelector: string;
    readonly producerVersion: string;
    readonly producerSha256: string;
    readonly strength: (typeof STRENGTHS)[number];
    readonly completeness: (typeof COMPLETENESS)[number];
  };
  readonly captureStatus: 'produced';
  readonly evidence: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly cleanupStatus: (typeof CLEANUP_STATUSES)[number];
  readonly redactionStatus: (typeof REDACTION_STATUSES)[number];
  readonly artifactKind: (typeof ARTIFACT_KINDS)[number];
  readonly validationContract: string;
};

type CandidateParseResult =
  | { readonly ok: true; readonly candidate: EligibleValidatedEvidenceCandidate }
  | {
      readonly ok: false;
      readonly reasonCodes: ScenarioClaimValidatedEvidenceAdmissionOutsideContract['reasonCodes'];
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) {
    return false;
  }
  return expected.every((key) => keys.includes(key));
}

function safeGet(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isTrimmedControlFreeIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value !== value.trim()) {
    return false;
  }
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  return true;
}

function isSafeRunRelativePath(value: unknown): value is string {
  if (!isTrimmedControlFreeIdentity(value)) {
    return false;
  }
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value)) {
    return false;
  }
  if (/^file:/i.test(value)) {
    return false;
  }
  for (const segment of value.split('/')) {
    if (segment === '..') {
      return false;
    }
  }
  return true;
}

function isClosedStringUnion<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function outside(
  reasonCodes: ScenarioClaimValidatedEvidenceAdmissionOutsideContract['reasonCodes'],
): ScenarioClaimValidatedEvidenceAdmissionOutsideContract {
  return {
    status: 'outside_contract',
    contractVersion: CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,
    reasonCodes,
    nextAction: OUTSIDE_NEXT_ACTION,
  };
}

function subjectBytesInvalid(): ScenarioClaimValidatedEvidenceAdmissionSubjectBytesInvalid {
  return {
    status: 'subject_blocked',
    contractVersion: CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,
    reasonCodes: ['subject_bytes_invalid'],
    nextAction: SUBJECT_NEXT_ACTION,
  };
}

function subjectHashMismatch(subjectArtifact: {
  readonly path: string;
  readonly expectedSha256: string;
  readonly observedSha256: string;
  readonly byteLength: number;
}): ScenarioClaimValidatedEvidenceAdmissionSubjectHashMismatch {
  return {
    status: 'subject_blocked',
    contractVersion: CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,
    reasonCodes: ['subject_hash_mismatch'],
    nextAction: SUBJECT_NEXT_ACTION,
    subjectArtifact,
  };
}

function reportBlocked(
  reportIdentity: BlockedReportIdentity,
  subjectArtifact: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  },
): ScenarioClaimValidatedEvidenceAdmissionReportBlocked {
  return {
    status: 'report_blocked',
    contractVersion: CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,
    reasonCodes: reportIdentity.reasonCodes,
    nextAction: reportIdentity.nextAction,
    subjectArtifact,
    reportIdentity,
  };
}

function inspectTopLevelCandidateAndSubject(input: unknown):
  | {
      readonly ok: true;
      readonly record: Record<string, unknown>;
      readonly candidate: unknown;
      readonly subjectBytes: unknown;
    }
  | {
      readonly ok: false;
      readonly reasonCodes: ScenarioClaimValidatedEvidenceAdmissionOutsideContract['reasonCodes'];
    } {
  if (!isPlainRecord(input)) {
    return { ok: false, reasonCodes: ['input_invalid'] };
  }
  if (!hasExactOwnKeys(input, CLOSED_TOP_LEVEL_KEYS)) {
    return { ok: false, reasonCodes: ['input_invalid'] };
  }

  let candidate: unknown;
  let subjectBytes: unknown;
  try {
    candidate = input.candidate;
    subjectBytes = input.subjectBytes;
  } catch {
    return { ok: false, reasonCodes: ['input_invalid'] };
  }

  return { ok: true, record: input, candidate, subjectBytes };
}

function parseAuthority(
  value: unknown,
): EligibleValidatedEvidenceCandidate['authority'] | null {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, CLOSED_AUTHORITY_KEYS)) {
    return null;
  }
  const declarationId = safeGet(value, 'declarationId');
  const role = safeGet(value, 'role');
  const producerId = safeGet(value, 'producerId');
  const evidenceSelector = safeGet(value, 'evidenceSelector');
  const producerVersion = safeGet(value, 'producerVersion');
  const producerSha256 = safeGet(value, 'producerSha256');
  const strength = safeGet(value, 'strength');
  const completeness = safeGet(value, 'completeness');
  if (!isSafeRunRelativePath(declarationId)) {
    return null;
  }
  if (!isClosedStringUnion(role, AUTHORITY_ROLES)) {
    return null;
  }
  if (!isSafeRunRelativePath(producerId)) {
    return null;
  }
  if (!isSafeRunRelativePath(evidenceSelector)) {
    return null;
  }
  if (!isSafeRunRelativePath(producerVersion)) {
    return null;
  }
  if (!isLowerSha256(producerSha256)) {
    return null;
  }
  if (!isClosedStringUnion(strength, STRENGTHS)) {
    return null;
  }
  if (!isClosedStringUnion(completeness, COMPLETENESS)) {
    return null;
  }
  return {
    declarationId,
    role,
    producerId,
    evidenceSelector,
    producerVersion,
    producerSha256,
    strength,
    completeness,
  };
}

function parseEvidence(value: unknown): EligibleValidatedEvidenceCandidate['evidence'] | null {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, CLOSED_EVIDENCE_KEYS)) {
    return null;
  }
  const path = safeGet(value, 'path');
  const sha256 = safeGet(value, 'sha256');
  if (!isSafeRunRelativePath(path) || !isLowerSha256(sha256)) {
    return null;
  }
  return { path, sha256 };
}

function parseObservationWindow(value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, CLOSED_OBSERVATION_WINDOW_KEYS)) {
    return false;
  }
  const from = safeGet(value, 'from');
  const to = safeGet(value, 'to');
  const completeSourceRequired = safeGet(value, 'completeSourceRequired');
  if (!isSafeRunRelativePath(from) || !isSafeRunRelativePath(to)) {
    return false;
  }
  return completeSourceRequired === true;
}

function parseSharedEligibleFields(candidate: Record<string, unknown>): {
  readonly schemaVersion: '1.0.0';
  readonly candidateId: string;
  readonly runIdentityHash: string;
  readonly claimId: string;
  readonly claimHash: string;
  readonly assertionId: string;
  readonly assertionKind: unknown;
  readonly authority: EligibleValidatedEvidenceCandidate['authority'];
  readonly captureStatus: 'produced';
  readonly evidence: EligibleValidatedEvidenceCandidate['evidence'];
  readonly cleanupStatus: (typeof CLEANUP_STATUSES)[number];
  readonly redactionStatus: (typeof REDACTION_STATUSES)[number];
} | null {
  const schemaVersion = safeGet(candidate, 'schemaVersion');
  const candidateId = safeGet(candidate, 'candidateId');
  const runIdentityHash = safeGet(candidate, 'runIdentityHash');
  const claimId = safeGet(candidate, 'claimId');
  const claimHash = safeGet(candidate, 'claimHash');
  const assertionId = safeGet(candidate, 'assertionId');
  const assertionKind = safeGet(candidate, 'assertionKind');
  const captureStatus = safeGet(candidate, 'captureStatus');
  const cleanupStatus = safeGet(candidate, 'cleanupStatus');
  const redactionStatus = safeGet(candidate, 'redactionStatus');
  if (schemaVersion !== '1.0.0') {
    return null;
  }
  if (!isSafeRunRelativePath(candidateId)) {
    return null;
  }
  if (!isLowerSha256(runIdentityHash)) {
    return null;
  }
  if (!isSafeRunRelativePath(claimId)) {
    return null;
  }
  if (!isLowerSha256(claimHash)) {
    return null;
  }
  if (!isSafeRunRelativePath(assertionId)) {
    return null;
  }
  if (captureStatus !== 'produced') {
    return null;
  }
  if (!isClosedStringUnion(cleanupStatus, CLEANUP_STATUSES)) {
    return null;
  }
  if (!isClosedStringUnion(redactionStatus, REDACTION_STATUSES)) {
    return null;
  }
  const authority = parseAuthority(safeGet(candidate, 'authority'));
  const evidence = parseEvidence(safeGet(candidate, 'evidence'));
  if (authority === null || evidence === null) {
    return null;
  }
  return {
    schemaVersion,
    candidateId,
    runIdentityHash,
    claimId,
    claimHash,
    assertionId,
    assertionKind,
    authority,
    captureStatus,
    evidence,
    cleanupStatus,
    redactionStatus,
  };
}

function isEligibleJsonNativeCandidate(candidate: unknown): boolean {
  if (!isPlainRecord(candidate)) {
    return false;
  }
  const hasSemanticKeys = hasExactOwnKeys(candidate, CLOSED_JSON_NATIVE_CANDIDATE_KEYS);
  const hasWindowedKeys = hasExactOwnKeys(
    candidate,
    CLOSED_WINDOWED_JSON_NATIVE_CANDIDATE_KEYS,
  );
  if (!hasSemanticKeys && !hasWindowedKeys) {
    return false;
  }
  const shared = parseSharedEligibleFields(candidate);
  if (shared === null) {
    return false;
  }
  if (hasSemanticKeys) {
    return isClosedStringUnion(shared.assertionKind, SEMANTIC_JSON_NATIVE_KINDS);
  }
  if (!parseObservationWindow(safeGet(candidate, 'observationWindow'))) {
    return false;
  }
  return isClosedStringUnion(shared.assertionKind, WINDOWED_JSON_NATIVE_KINDS);
}

function parseEligibleValidatedEvidenceCandidate(candidate: unknown): CandidateParseResult {
  if (!isPlainRecord(candidate)) {
    return { ok: false, reasonCodes: ['candidate_not_eligible'] };
  }

  if (isEligibleJsonNativeCandidate(candidate)) {
    return { ok: false, reasonCodes: ['assertion_kind_not_validated_evidence'] };
  }

  if (!hasExactOwnKeys(candidate, CLOSED_CANDIDATE_KEYS)) {
    return { ok: false, reasonCodes: ['candidate_not_eligible'] };
  }

  const shared = parseSharedEligibleFields(candidate);
  if (shared === null) {
    return { ok: false, reasonCodes: ['candidate_not_eligible'] };
  }
  if (shared.assertionKind !== 'validatedEvidence') {
    return { ok: false, reasonCodes: ['candidate_not_eligible'] };
  }
  const artifactKind = safeGet(candidate, 'artifactKind');
  const validationContract = safeGet(candidate, 'validationContract');
  if (!isClosedStringUnion(artifactKind, ARTIFACT_KINDS)) {
    return { ok: false, reasonCodes: ['candidate_not_eligible'] };
  }
  if (!isSafeRunRelativePath(validationContract)) {
    return { ok: false, reasonCodes: ['candidate_not_eligible'] };
  }

  return {
    ok: true,
    candidate: {
      schemaVersion: shared.schemaVersion,
      candidateId: shared.candidateId,
      runIdentityHash: shared.runIdentityHash,
      claimId: shared.claimId,
      claimHash: shared.claimHash,
      assertionId: shared.assertionId,
      assertionKind: 'validatedEvidence',
      authority: shared.authority,
      captureStatus: shared.captureStatus,
      evidence: shared.evidence,
      cleanupStatus: shared.cleanupStatus,
      redactionStatus: shared.redactionStatus,
      artifactKind,
      validationContract,
    },
  };
}

function boundSubjectArtifact(
  evidence: EligibleValidatedEvidenceCandidate['evidence'],
  byteLength: number,
): {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
} {
  return {
    path: evidence.path,
    sha256: evidence.sha256,
    byteLength,
  };
}

function inspectReportIdentityFailClosed(
  candidate: EligibleValidatedEvidenceCandidate,
  record: Record<string, unknown>,
): ScenarioClaimValidatedEvidenceReportIdentityInspection {
  let report: unknown;
  let reportBytes: unknown;
  try {
    report = safeGet(record, 'report');
    reportBytes = safeGet(record, 'reportBytes');
  } catch {
    report = undefined;
    reportBytes = undefined;
  }

  try {
    return inspectScenarioClaimValidatedEvidenceReportIdentity({
      candidate,
      report,
      reportBytes,
    });
  } catch {
    return {
      contractVersion: CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,
      status: 'outside_contract',
      reasonCodes: ['input_invalid'],
      nextAction: 'supply_eligible_validated_evidence_candidate_and_exact_report_bytes',
    };
  }
}

export function inspectScenarioClaimValidatedEvidenceAdmission(
  input: unknown,
): ScenarioClaimValidatedEvidenceAdmissionResult {
  try {
    const top = inspectTopLevelCandidateAndSubject(input);
    if (!top.ok) {
      return outside(top.reasonCodes);
    }

    const parsed = parseEligibleValidatedEvidenceCandidate(top.candidate);
    if (!parsed.ok) {
      return outside(parsed.reasonCodes);
    }

    const candidate = parsed.candidate;
    const subjectSnapshot = snapshotAndHashExactArtifactBytes(top.subjectBytes);
    if (subjectSnapshot === null) {
      return subjectBytesInvalid();
    }

    const subjectByteLength = subjectSnapshot.bytes.byteLength;
    if (subjectSnapshot.sha256 !== candidate.evidence.sha256) {
      return subjectHashMismatch({
        path: candidate.evidence.path,
        expectedSha256: candidate.evidence.sha256,
        observedSha256: subjectSnapshot.sha256,
        byteLength: subjectByteLength,
      });
    }

    const reportIdentity = inspectReportIdentityFailClosed(candidate, top.record);
    if (reportIdentity.status === 'outside_contract' || reportIdentity.status === 'blocked') {
      return reportBlocked(
        reportIdentity,
        boundSubjectArtifact(candidate.evidence, subjectByteLength),
      );
    }

    return {
      status: 'identity_admitted',
      contractVersion: CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,
      reasonCodes: [],
      nextAction: ADMITTED_NEXT_ACTION,
      candidateId: reportIdentity.candidateId,
      runIdentityHash: reportIdentity.runIdentityHash,
      claimId: reportIdentity.claimId,
      claimHash: reportIdentity.claimHash,
      assertionId: reportIdentity.assertionId,
      assertionKind: reportIdentity.assertionKind,
      artifactKind: reportIdentity.artifactKind,
      validationContract: reportIdentity.validationContract,
      subjectArtifact: {
        path: reportIdentity.subjectArtifact.path,
        sha256: reportIdentity.subjectArtifact.sha256,
        byteLength: subjectByteLength,
      },
      reportArtifact: {
        path: reportIdentity.reportArtifact.path,
        sha256: reportIdentity.reportArtifact.sha256,
        byteLength: reportIdentity.reportArtifact.byteLength,
      },
    };
  } catch {
    return outside(['input_invalid']);
  }
}
