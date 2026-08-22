import { snapshotAndHashExactArtifactBytes } from './exact-artifact-bytes';
import { SCHEMAS, validateJson } from './schema-validator';
import type { ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted } from './claim-validated-evidence-admission';

export const CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION = '1.0.0' as const;

const CLOSED_TOP_LEVEL_KEYS = ['validatedEvidence', 'result', 'resultBytes'] as const;
const CLOSED_RESULT_IDENTITY_KEYS = ['path', 'sha256'] as const;
const CLOSED_ENVELOPE_KEYS = [
  'status',
  'contractVersion',
  'reasonCodes',
  'nextAction',
  'candidateId',
  'runIdentityHash',
  'claimId',
  'claimHash',
  'assertionId',
  'assertionKind',
  'artifactKind',
  'validationContract',
  'subjectArtifact',
  'reportArtifact',
] as const;
const CLOSED_SUBJECT_ARTIFACT_KEYS = ['path', 'sha256', 'byteLength'] as const;
const CLOSED_REPORT_ARTIFACT_KEYS = ['path', 'sha256', 'byteLength'] as const;
const CLOSED_VALIDATOR_KEYS = ['producerId', 'producerVersion', 'producerSha256'] as const;
const CLOSED_EVIDENCE_REFERENCE_KEYS = ['path'] as const;
const CLOSED_EVIDENCE_REFERENCE_WITH_HASH_KEYS = ['path', 'sha256'] as const;

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

const RESULT_STATUSES = ['passed', 'failed', 'not_evaluable'] as const;
const PASSED_REASON = 'validation_passed' as const;
const FAILED_REASON = 'validation_failed' as const;
const NOT_EVALUABLE_REASONS = [
  'validator_unavailable',
  'result_incomplete',
  'contract_not_evaluable',
] as const;

const OUTSIDE_NEXT_ACTION =
  'supply_identity_admitted_validated_evidence_and_exact_result_bytes' as const;
const BYTES_NEXT_ACTION = 'supply_exact_result_bytes' as const;
const IDENTITY_NEXT_ACTION = 'declare_matching_validator_result_identity' as const;
const COLLISION_NEXT_ACTION = 'declare_distinct_result_identity' as const;
const ADMITTED_NEXT_ACTION = 'treat_validator_result_as_identity_evidence_only' as const;

type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
type ResultStatus = (typeof RESULT_STATUSES)[number];
type ResultReasonCode =
  | typeof PASSED_REASON
  | typeof FAILED_REASON
  | (typeof NOT_EVALUABLE_REASONS)[number];

type PathHash = {
  readonly path: string;
  readonly sha256: string;
};

type Envelope = {
  readonly candidateId: string;
  readonly runIdentityHash: string;
  readonly claimId: string;
  readonly claimHash: string;
  readonly assertionId: string;
  readonly assertionKind: 'validatedEvidence';
  readonly artifactKind: ArtifactKind;
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

type ValidatorIdentity = {
  readonly producerId: string;
  readonly producerVersion: string;
  readonly producerSha256: string;
};

type EvidenceReference = {
  readonly path: string;
  readonly sha256?: string;
};

export type ScenarioClaimValidatedEvidenceResultAdmissionInput = {
  readonly validatedEvidence: ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted;
  readonly result: {
    readonly path: string;
    readonly sha256: string;
  };
  readonly resultBytes: Uint8Array;
};

export type ScenarioClaimValidatedEvidenceResultAdmissionOutsideContract = {
  readonly status: 'outside_contract';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION;
  readonly reasonCodes: readonly [
    'input_invalid' | 'validated_evidence_not_identity_admitted',
    ...Array<'input_invalid' | 'validated_evidence_not_identity_admitted'>,
  ];
  readonly nextAction: typeof OUTSIDE_NEXT_ACTION;
};

export type ScenarioClaimValidatedEvidenceResultAdmissionBlocked = {
  readonly status: 'blocked';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION;
  readonly reasonCodes: readonly [
    (
      | 'result_bytes_invalid'
      | 'result_hash_mismatch'
      | 'result_utf8_invalid'
      | 'result_json_invalid'
      | 'result_schema_invalid'
      | 'assertion_identity_mismatch'
      | 'validation_contract_mismatch'
      | 'subject_identity_mismatch'
      | 'report_identity_mismatch'
      | 'validator_identity_mismatch'
      | 'result_identity_collision'
    ),
  ];
  readonly nextAction:
    | typeof BYTES_NEXT_ACTION
    | typeof IDENTITY_NEXT_ACTION
    | typeof COLLISION_NEXT_ACTION;
  readonly resultArtifact?: {
    readonly path: string;
    readonly expectedSha256?: string;
    readonly observedSha256?: string;
    readonly byteLength: number;
  };
};

export type ScenarioClaimValidatedEvidenceResultAdmissionAdmitted = {
  readonly status: 'admitted';
  readonly contractVersion: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION;
  readonly reasonCodes: readonly [];
  readonly nextAction: typeof ADMITTED_NEXT_ACTION;
  readonly candidateId: string;
  readonly runIdentityHash: string;
  readonly claimId: string;
  readonly claimHash: string;
  readonly assertionId: string;
  readonly assertionKind: 'validatedEvidence';
  readonly artifactKind: ArtifactKind;
  readonly validationContract: string;
  readonly resultId: string;
  readonly validator: ValidatorIdentity;
  readonly subject: PathHash;
  readonly report: PathHash;
  readonly validatorResultStatus: ResultStatus;
  readonly validatorReasonCode: ResultReasonCode;
  readonly evidenceReferences: readonly EvidenceReference[];
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
  readonly resultArtifact: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  };
};

export type ScenarioClaimValidatedEvidenceResultAdmissionResult =
  | ScenarioClaimValidatedEvidenceResultAdmissionOutsideContract
  | ScenarioClaimValidatedEvidenceResultAdmissionBlocked
  | ScenarioClaimValidatedEvidenceResultAdmissionAdmitted;

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

function copyString(value: string): string {
  return value.slice();
}

function freezePathHash(value: PathHash): PathHash {
  return Object.freeze({
    path: copyString(value.path),
    sha256: copyString(value.sha256),
  });
}

function freezeArtifact(
  value: { readonly path: string; readonly sha256: string; readonly byteLength: number },
): {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
} {
  return Object.freeze({
    path: copyString(value.path),
    sha256: copyString(value.sha256),
    byteLength: value.byteLength,
  });
}

function outside(
  reasonCodes: ScenarioClaimValidatedEvidenceResultAdmissionOutsideContract['reasonCodes'],
): ScenarioClaimValidatedEvidenceResultAdmissionOutsideContract {
  return Object.freeze({
    status: 'outside_contract',
    contractVersion: CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION,
    reasonCodes: Object.freeze([...reasonCodes]) as ScenarioClaimValidatedEvidenceResultAdmissionOutsideContract['reasonCodes'],
    nextAction: OUTSIDE_NEXT_ACTION,
  });
}

function blocked(
  reasonCode: ScenarioClaimValidatedEvidenceResultAdmissionBlocked['reasonCodes'][0],
  nextAction: ScenarioClaimValidatedEvidenceResultAdmissionBlocked['nextAction'],
  resultArtifact?: ScenarioClaimValidatedEvidenceResultAdmissionBlocked['resultArtifact'],
): ScenarioClaimValidatedEvidenceResultAdmissionBlocked {
  if (resultArtifact === undefined) {
    return Object.freeze({
      status: 'blocked',
      contractVersion: CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION,
      reasonCodes: Object.freeze([reasonCode]) as ScenarioClaimValidatedEvidenceResultAdmissionBlocked['reasonCodes'],
      nextAction,
    });
  }
  return Object.freeze({
    status: 'blocked',
    contractVersion: CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION,
    reasonCodes: Object.freeze([reasonCode]) as ScenarioClaimValidatedEvidenceResultAdmissionBlocked['reasonCodes'],
    nextAction,
    resultArtifact: freezeBlockedResultArtifact(resultArtifact),
  });
}

function freezeBlockedResultArtifact(
  resultArtifact: NonNullable<ScenarioClaimValidatedEvidenceResultAdmissionBlocked['resultArtifact']>,
): NonNullable<ScenarioClaimValidatedEvidenceResultAdmissionBlocked['resultArtifact']> {
  const path = copyString(resultArtifact.path);
  const byteLength = resultArtifact.byteLength;
  const expectedSha256 = resultArtifact.expectedSha256;
  const observedSha256 = resultArtifact.observedSha256;
  if (expectedSha256 !== undefined && observedSha256 !== undefined) {
    return Object.freeze({
      path,
      expectedSha256: copyString(expectedSha256),
      observedSha256: copyString(observedSha256),
      byteLength,
    });
  }
  if (expectedSha256 !== undefined) {
    return Object.freeze({
      path,
      expectedSha256: copyString(expectedSha256),
      byteLength,
    });
  }
  if (observedSha256 !== undefined) {
    return Object.freeze({
      path,
      observedSha256: copyString(observedSha256),
      byteLength,
    });
  }
  return Object.freeze({
    path,
    byteLength,
  });
}

function parsePathHash(value: unknown): PathHash | null {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, CLOSED_RESULT_IDENTITY_KEYS)) {
    return null;
  }
  const pathValue = safeGet(value, 'path');
  const sha256 = safeGet(value, 'sha256');
  if (!isSafeRunRelativePath(pathValue) || !isLowerSha256(sha256)) {
    return null;
  }
  return { path: pathValue, sha256 };
}

function parseByteLength(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseEnvelope(value: unknown): Envelope | null {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, CLOSED_ENVELOPE_KEYS)) {
    return null;
  }
  if (safeGet(value, 'status') !== 'identity_admitted') {
    return null;
  }
  if (safeGet(value, 'contractVersion') !== '1.0.0') {
    return null;
  }
  const reasonCodes = safeGet(value, 'reasonCodes');
  if (!Array.isArray(reasonCodes) || reasonCodes.length !== 0) {
    return null;
  }
  if (safeGet(value, 'nextAction') !== 'evaluate_validated_evidence_report') {
    return null;
  }
  if (safeGet(value, 'assertionKind') !== 'validatedEvidence') {
    return null;
  }

  const candidateId = safeGet(value, 'candidateId');
  const runIdentityHash = safeGet(value, 'runIdentityHash');
  const claimId = safeGet(value, 'claimId');
  const claimHash = safeGet(value, 'claimHash');
  const assertionId = safeGet(value, 'assertionId');
  const artifactKind = safeGet(value, 'artifactKind');
  const validationContract = safeGet(value, 'validationContract');
  const subjectArtifactValue = safeGet(value, 'subjectArtifact');
  const reportArtifactValue = safeGet(value, 'reportArtifact');

  if (!isSafeRunRelativePath(candidateId) || !isLowerSha256(runIdentityHash)) {
    return null;
  }
  if (!isSafeRunRelativePath(claimId) || !isLowerSha256(claimHash)) {
    return null;
  }
  if (!isSafeRunRelativePath(assertionId) || !isSafeRunRelativePath(validationContract)) {
    return null;
  }
  if (!isClosedStringUnion(artifactKind, ARTIFACT_KINDS)) {
    return null;
  }
  if (
    !isPlainRecord(subjectArtifactValue) ||
    !hasExactOwnKeys(subjectArtifactValue, CLOSED_SUBJECT_ARTIFACT_KEYS)
  ) {
    return null;
  }
  if (
    !isPlainRecord(reportArtifactValue) ||
    !hasExactOwnKeys(reportArtifactValue, CLOSED_REPORT_ARTIFACT_KEYS)
  ) {
    return null;
  }

  const subjectPath = safeGet(subjectArtifactValue, 'path');
  const subjectSha = safeGet(subjectArtifactValue, 'sha256');
  const subjectLen = parseByteLength(safeGet(subjectArtifactValue, 'byteLength'));
  const reportPath = safeGet(reportArtifactValue, 'path');
  const reportSha = safeGet(reportArtifactValue, 'sha256');
  const reportLen = parseByteLength(safeGet(reportArtifactValue, 'byteLength'));
  if (
    !isSafeRunRelativePath(subjectPath) ||
    !isLowerSha256(subjectSha) ||
    subjectLen === null
  ) {
    return null;
  }
  if (!isSafeRunRelativePath(reportPath) || !isLowerSha256(reportSha) || reportLen === null) {
    return null;
  }

  return {
    candidateId,
    runIdentityHash,
    claimId,
    claimHash,
    assertionId,
    assertionKind: 'validatedEvidence',
    artifactKind,
    validationContract,
    subjectArtifact: {
      path: subjectPath,
      sha256: subjectSha,
      byteLength: subjectLen,
    },
    reportArtifact: {
      path: reportPath,
      sha256: reportSha,
      byteLength: reportLen,
    },
  };
}

function decodeUtf8Fatal(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainRecord(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readResultStatus(record: Record<string, unknown>): ResultStatus | null {
  const status = safeGet(record, 'status');
  return isClosedStringUnion(status, RESULT_STATUSES) ? status : null;
}

function readReasonCode(
  status: ResultStatus,
  record: Record<string, unknown>,
): ResultReasonCode | null {
  const reasonCode = safeGet(record, 'reasonCode');
  if (status === 'passed') {
    return reasonCode === PASSED_REASON ? PASSED_REASON : null;
  }
  if (status === 'failed') {
    return reasonCode === FAILED_REASON ? FAILED_REASON : null;
  }
  return isClosedStringUnion(reasonCode, NOT_EVALUABLE_REASONS) ? reasonCode : null;
}

function readValidator(value: unknown): ValidatorIdentity | null {
  if (!isPlainRecord(value) || !hasExactOwnKeys(value, CLOSED_VALIDATOR_KEYS)) {
    return null;
  }
  const producerId = safeGet(value, 'producerId');
  const producerVersion = safeGet(value, 'producerVersion');
  const producerSha256 = safeGet(value, 'producerSha256');
  if (
    !isSafeRunRelativePath(producerId) ||
    !isSafeRunRelativePath(producerVersion) ||
    !isLowerSha256(producerSha256)
  ) {
    return null;
  }
  return Object.freeze({
    producerId: copyString(producerId),
    producerVersion: copyString(producerVersion),
    producerSha256: copyString(producerSha256),
  });
}

function readEvidenceReferences(value: unknown): EvidenceReference[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const references: EvidenceReference[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) {
      return null;
    }
    const pathValue = safeGet(item, 'path');
    if (!isSafeRunRelativePath(pathValue)) {
      return null;
    }
    const sha256 = safeGet(item, 'sha256');
    if (sha256 === undefined) {
      if (!hasExactOwnKeys(item, CLOSED_EVIDENCE_REFERENCE_KEYS)) {
        return null;
      }
      references.push(Object.freeze({ path: copyString(pathValue) }));
      continue;
    }
    if (!hasExactOwnKeys(item, CLOSED_EVIDENCE_REFERENCE_WITH_HASH_KEYS) || !isLowerSha256(sha256)) {
      return null;
    }
    references.push(
      Object.freeze({ path: copyString(pathValue), sha256: copyString(sha256) }),
    );
  }
  return references;
}

export function inspectScenarioClaimValidatedEvidenceResultAdmission(
  input: unknown,
): ScenarioClaimValidatedEvidenceResultAdmissionResult {
  try {
    if (!isPlainRecord(input) || !hasExactOwnKeys(input, CLOSED_TOP_LEVEL_KEYS)) {
      return outside(['input_invalid']);
    }

    let validatedEvidence: unknown;
    let resultIdentity: unknown;
    let resultBytes: unknown;
    try {
      validatedEvidence = input.validatedEvidence;
      resultIdentity = input.result;
      resultBytes = input.resultBytes;
    } catch {
      return outside(['input_invalid']);
    }

    const envelope = parseEnvelope(validatedEvidence);
    if (envelope === null) {
      if (isPlainRecord(validatedEvidence) && safeGet(validatedEvidence, 'status') !== 'identity_admitted') {
        return outside(['validated_evidence_not_identity_admitted']);
      }
      return outside(['input_invalid']);
    }

    const declaredResult = parsePathHash(resultIdentity);
    if (declaredResult === null) {
      return outside(['input_invalid']);
    }

    const snapshot = snapshotAndHashExactArtifactBytes(resultBytes);
    if (snapshot === null) {
      return blocked('result_bytes_invalid', BYTES_NEXT_ACTION);
    }

    const byteLength = snapshot.bytes.byteLength;
    if (snapshot.sha256 !== declaredResult.sha256) {
      return blocked('result_hash_mismatch', BYTES_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        expectedSha256: copyString(declaredResult.sha256),
        observedSha256: copyString(snapshot.sha256),
        byteLength,
      });
    }

    const utf8 = decodeUtf8Fatal(snapshot.bytes);
    if (utf8 === null) {
      return blocked('result_utf8_invalid', BYTES_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        expectedSha256: copyString(declaredResult.sha256),
        observedSha256: copyString(snapshot.sha256),
        byteLength,
      });
    }

    const parsed = parseJsonObject(utf8);
    if (parsed === null) {
      return blocked('result_json_invalid', BYTES_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        expectedSha256: copyString(declaredResult.sha256),
        observedSha256: copyString(snapshot.sha256),
        byteLength,
      });
    }

    if (
      declaredResult.path === envelope.subjectArtifact.path ||
      declaredResult.path === envelope.reportArtifact.path ||
      snapshot.sha256 === envelope.subjectArtifact.sha256 ||
      snapshot.sha256 === envelope.reportArtifact.sha256
    ) {
      return blocked('result_identity_collision', COLLISION_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        expectedSha256: copyString(declaredResult.sha256),
        observedSha256: copyString(snapshot.sha256),
        byteLength,
      });
    }

    const schemaResult = validateJson(
      parsed,
      SCHEMAS.validatedEvidenceResult,
      'validated-evidence-result',
    );
    if (!schemaResult.valid) {
      return blocked('result_schema_invalid', BYTES_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        expectedSha256: copyString(declaredResult.sha256),
        observedSha256: copyString(snapshot.sha256),
        byteLength,
      });
    }

    const assertionId = safeGet(parsed, 'assertionId');
    const validationContract = safeGet(parsed, 'validationContract');
    const resultId = safeGet(parsed, 'resultId');
    const validator = readValidator(safeGet(parsed, 'validator'));
    const subject = parsePathHash(safeGet(parsed, 'subject'));
    const report = parsePathHash(safeGet(parsed, 'report'));
    const status = readResultStatus(parsed);
    const reasonCode = status === null ? null : readReasonCode(status, parsed);
    const evidenceReferences = readEvidenceReferences(safeGet(parsed, 'evidenceReferences'));

    if (typeof resultId !== 'string' || !isSafeRunRelativePath(resultId) || status === null || reasonCode === null) {
      return blocked('result_schema_invalid', BYTES_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }
    if (evidenceReferences === null) {
      return blocked('result_schema_invalid', BYTES_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }

    if (typeof assertionId !== 'string' || assertionId !== envelope.assertionId) {
      return blocked('assertion_identity_mismatch', IDENTITY_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }
    if (
      typeof validationContract !== 'string' ||
      validationContract !== envelope.validationContract
    ) {
      return blocked('validation_contract_mismatch', IDENTITY_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }
    if (
      subject === null ||
      subject.path !== envelope.subjectArtifact.path ||
      subject.sha256 !== envelope.subjectArtifact.sha256
    ) {
      return blocked('subject_identity_mismatch', IDENTITY_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }
    if (
      report === null ||
      report.path !== envelope.reportArtifact.path ||
      report.sha256 !== envelope.reportArtifact.sha256
    ) {
      return blocked('report_identity_mismatch', IDENTITY_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }
    if (validator === null) {
      return blocked('validator_identity_mismatch', IDENTITY_NEXT_ACTION, {
        path: copyString(declaredResult.path),
        byteLength,
      });
    }

    const admitted: ScenarioClaimValidatedEvidenceResultAdmissionAdmitted = {
      status: 'admitted',
      contractVersion: CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION,
      reasonCodes: Object.freeze([]) as readonly [],
      nextAction: ADMITTED_NEXT_ACTION,
      candidateId: copyString(envelope.candidateId),
      runIdentityHash: copyString(envelope.runIdentityHash),
      claimId: copyString(envelope.claimId),
      claimHash: copyString(envelope.claimHash),
      assertionId: copyString(envelope.assertionId),
      assertionKind: 'validatedEvidence',
      artifactKind: envelope.artifactKind,
      validationContract: copyString(envelope.validationContract),
      resultId: copyString(resultId),
      validator,
      subject: freezePathHash(subject),
      report: freezePathHash(report),
      validatorResultStatus: status,
      validatorReasonCode: reasonCode,
      evidenceReferences: Object.freeze(evidenceReferences),
      subjectArtifact: freezeArtifact(envelope.subjectArtifact),
      reportArtifact: freezeArtifact(envelope.reportArtifact),
      resultArtifact: freezeArtifact({
        path: declaredResult.path,
        sha256: snapshot.sha256,
        byteLength,
      }),
    };
    return Object.freeze(admitted);
  } catch {
    return outside(['input_invalid']);
  }
}
