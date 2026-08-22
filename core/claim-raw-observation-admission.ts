import {
  type ClaimObservationWindow,
  type ClaimScalar,
} from './claim-contract';
import {
  type ScenarioClaimEligibleEvidenceCandidate,
} from './claim-evidence-candidate-identity';
import {
  type ExactArtifactBytesSnapshot,
  snapshotAndHashExactArtifactBytes,
} from './exact-artifact-bytes';

const CLAIM_RAW_OBSERVATION_ADMISSION_VERSION = '1.0.0' as const;
const CLAIM_RAW_OBSERVATION_SCHEMA_VERSION = '1.0.0' as const;

type JsonNativeAssertionKind =
  | 'eventOccurrence'
  | 'eventOrder'
  | 'terminalState'
  | 'boundedCount'
  | 'absence';

type ObservationOccurrence = {
  event: string;
  atMs: number;
};

type TerminalStateObservationValue = {
  path: string;
  value: ClaimScalar;
  atMs: number;
};

type EventOccurrenceRawObservation = {
  schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
  kind: 'eventOccurrence';
  occurrences: ObservationOccurrence[];
};

type EventOrderRawObservation = {
  schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
  kind: 'eventOrder';
  occurrences: ObservationOccurrence[];
};

type TerminalStateRawObservation = {
  schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
  kind: 'terminalState';
  observations: TerminalStateObservationValue[];
};

type BoundedCountRawObservation = {
  schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
  kind: 'boundedCount';
  selector: string;
  count: number;
  observationWindow: ClaimObservationWindow;
};

type AbsenceRawObservation = {
  schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
  kind: 'absence';
  selector: string;
  count: number;
  observationWindow: ClaimObservationWindow;
};

type ScenarioClaimRawObservation =
  | EventOccurrenceRawObservation
  | EventOrderRawObservation
  | TerminalStateRawObservation
  | BoundedCountRawObservation
  | AbsenceRawObservation;

type ScenarioClaimRawObservationAdmissionInput = {
  candidate: ScenarioClaimEligibleEvidenceCandidate;
  artifactBytes: Uint8Array;
};

type ScenarioClaimRawObservationArtifactIdentity = {
  path: string;
  sha256: string;
  byteLength: number;
};

type ScenarioClaimRawObservationCandidateIdentity = {
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: ScenarioClaimEligibleEvidenceCandidate['assertionKind'];
};

type ScenarioClaimRawObservationOutsideReason =
  | 'input_invalid'
  | 'candidate_not_eligible'
  | 'artifact_bytes_invalid';

type ScenarioClaimRawObservationBlockedReason =
  | 'artifact_hash_mismatch'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'observation_schema_version_mismatch'
  | 'observation_kind_mismatch'
  | 'observation_shape_invalid'
  | 'observation_window_mismatch';

type ScenarioClaimRawObservationUnsupportedReason =
  'validated_evidence_report_identity_undefined';

type ScenarioClaimRawObservationOutsideNextAction =
  'supply_eligible_candidate_and_exact_bytes';

type ScenarioClaimRawObservationBlockedNextAction =
  | 'supply_exact_artifact_bytes'
  | 'repair_observation_artifact'
  | 'align_observation_window';

type ScenarioClaimRawObservationUnsupportedNextAction =
  'define_validated_evidence_report_identity';

type ScenarioClaimRawObservationOutsideContract = {
  contractVersion: typeof CLAIM_RAW_OBSERVATION_ADMISSION_VERSION;
  status: 'outside_contract';
  reasonCodes: [
    ScenarioClaimRawObservationOutsideReason,
    ...ScenarioClaimRawObservationOutsideReason[],
  ];
  nextAction: ScenarioClaimRawObservationOutsideNextAction;
};

type ScenarioClaimRawObservationInspectionBase =
  ScenarioClaimRawObservationCandidateIdentity & {
    contractVersion: typeof CLAIM_RAW_OBSERVATION_ADMISSION_VERSION;
  };

type ScenarioClaimRawObservationBlocked = ScenarioClaimRawObservationInspectionBase & {
  status: 'blocked';
  reasonCodes: [
    ScenarioClaimRawObservationBlockedReason,
    ...ScenarioClaimRawObservationBlockedReason[],
  ];
  nextAction: ScenarioClaimRawObservationBlockedNextAction;
  artifact: {
    path: string;
    expectedSha256: string;
    observedSha256: string;
    byteLength: number;
  };
};

type ScenarioClaimRawObservationUnsupported = ScenarioClaimRawObservationInspectionBase & {
  status: 'unsupported';
  reasonCode: ScenarioClaimRawObservationUnsupportedReason;
  nextAction: ScenarioClaimRawObservationUnsupportedNextAction;
  artifact: ScenarioClaimRawObservationArtifactIdentity;
};

type ScenarioClaimRawObservationAdmitted = ScenarioClaimRawObservationInspectionBase & {
  status: 'admitted';
  artifact: ScenarioClaimRawObservationArtifactIdentity;
  observation: ScenarioClaimRawObservation;
};

type ScenarioClaimRawObservationAdmissionInspection =
  | ScenarioClaimRawObservationOutsideContract
  | ScenarioClaimRawObservationBlocked
  | ScenarioClaimRawObservationUnsupported
  | ScenarioClaimRawObservationAdmitted;

type ParsedAdmissionInput = {
  candidate: ScenarioClaimEligibleEvidenceCandidate;
  snapshot: ExactArtifactBytesSnapshot;
};

type ObservationParseResult =
  | { valid: true; observation: ScenarioClaimRawObservation }
  | {
      valid: false;
      reason: Exclude<
        ScenarioClaimRawObservationBlockedReason,
        'artifact_hash_mismatch'
      >;
    };

function inspectScenarioClaimRawObservationAdmission(
  input: unknown,
): ScenarioClaimRawObservationAdmissionInspection {
  let parsedInput: ReturnType<typeof parseAdmissionInput>;
  try {
    parsedInput = parseAdmissionInput(input);
  } catch {
    parsedInput = { valid: false, reasons: ['input_invalid'] };
  }
  if (!parsedInput.valid) {
    return {
      contractVersion: CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
      status: 'outside_contract',
      reasonCodes: parsedInput.reasons,
      nextAction: 'supply_eligible_candidate_and_exact_bytes',
    };
  }

  const { candidate, snapshot } = parsedInput.input;
  const artifactBytes = snapshot.bytes;
  const observedSha256 = snapshot.sha256;
  const identity = projectCandidateIdentity(candidate);
  const artifactBase = {
    path: candidate.evidence.path,
    byteLength: artifactBytes.byteLength,
  };

  if (observedSha256 !== candidate.evidence.sha256) {
    return {
      contractVersion: CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
      ...identity,
      status: 'blocked',
      reasonCodes: ['artifact_hash_mismatch'],
      nextAction: 'supply_exact_artifact_bytes',
      artifact: {
        ...artifactBase,
        expectedSha256: candidate.evidence.sha256,
        observedSha256,
      },
    };
  }

  const artifact: ScenarioClaimRawObservationArtifactIdentity = {
    ...artifactBase,
    sha256: observedSha256,
  };

  if (candidate.assertionKind === 'validatedEvidence') {
    return {
      contractVersion: CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
      ...identity,
      status: 'unsupported',
      reasonCode: 'validated_evidence_report_identity_undefined',
      nextAction: 'define_validated_evidence_report_identity',
      artifact,
    };
  }

  const parsedObservation = parseObservation(artifactBytes, candidate);
  if (!parsedObservation.valid) {
    return {
      contractVersion: CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
      ...identity,
      status: 'blocked',
      reasonCodes: [parsedObservation.reason],
      nextAction: blockedNextAction(parsedObservation.reason),
      artifact: {
        ...artifactBase,
        expectedSha256: candidate.evidence.sha256,
        observedSha256,
      },
    };
  }

  return {
    contractVersion: CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
    ...identity,
    status: 'admitted',
    artifact,
    observation: parsedObservation.observation,
  };
}

function parseAdmissionInput(input: unknown):
  | { valid: true; input: ParsedAdmissionInput }
  | {
      valid: false;
      reasons: [
        ScenarioClaimRawObservationOutsideReason,
        ...ScenarioClaimRawObservationOutsideReason[],
      ];
    } {
  if (!isPlainRecord(input) || !hasExactKeys(input, ['candidate', 'artifactBytes'])) {
    return { valid: false, reasons: ['input_invalid'] };
  }

  const candidate = parseEligibleCandidate(input.candidate);
  const snapshot = snapshotAndHashExactArtifactBytes(input.artifactBytes);
  if (candidate === null && snapshot === null) {
    return {
      valid: false,
      reasons: ['candidate_not_eligible', 'artifact_bytes_invalid'],
    };
  }
  if (candidate === null) {
    return { valid: false, reasons: ['candidate_not_eligible'] };
  }
  if (snapshot === null) {
    return { valid: false, reasons: ['artifact_bytes_invalid'] };
  }
  return { valid: true, input: { candidate, snapshot } };
}

function parseObservation(
  bytes: Uint8Array,
  candidate: Exclude<
    ScenarioClaimEligibleEvidenceCandidate,
    { assertionKind: 'validatedEvidence' }
  >,
): ObservationParseResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { valid: false, reason: 'invalid_utf8' };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { valid: false, reason: 'invalid_json' };
  }
  if (!isPlainRecord(value)) {
    return { valid: false, reason: 'observation_shape_invalid' };
  }
  if (value.schemaVersion !== CLAIM_RAW_OBSERVATION_SCHEMA_VERSION) {
    return { valid: false, reason: 'observation_schema_version_mismatch' };
  }
  if (value.kind !== candidate.assertionKind) {
    return { valid: false, reason: 'observation_kind_mismatch' };
  }

  switch (candidate.assertionKind) {
    case 'eventOccurrence':
    case 'eventOrder': {
      if (!hasExactKeys(value, ['schemaVersion', 'kind', 'occurrences'])) {
        return { valid: false, reason: 'observation_shape_invalid' };
      }
      const occurrences = parseOccurrences(value.occurrences);
      if (occurrences === null) return { valid: false, reason: 'observation_shape_invalid' };
      return {
        valid: true,
        observation: {
          schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
          kind: candidate.assertionKind,
          occurrences,
        },
      };
    }
    case 'terminalState': {
      if (!hasExactKeys(value, ['schemaVersion', 'kind', 'observations'])) {
        return { valid: false, reason: 'observation_shape_invalid' };
      }
      const observations = parseTerminalObservations(value.observations);
      if (observations === null) return { valid: false, reason: 'observation_shape_invalid' };
      return {
        valid: true,
        observation: {
          schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
          kind: 'terminalState',
          observations,
        },
      };
    }
    case 'boundedCount':
    case 'absence': {
      if (!hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'selector',
        'count',
        'observationWindow',
      ])) {
        return { valid: false, reason: 'observation_shape_invalid' };
      }
      if (
        !isNonemptyString(value.selector)
        || !Number.isInteger(value.count)
        || (value.count as number) < 0
        || !isObservationWindow(value.observationWindow)
      ) {
        return { valid: false, reason: 'observation_shape_invalid' };
      }
      if (!sameObservationWindow(value.observationWindow, candidate.observationWindow)) {
        return { valid: false, reason: 'observation_window_mismatch' };
      }
      return {
        valid: true,
        observation: {
          schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
          kind: candidate.assertionKind,
          selector: value.selector,
          count: value.count as number,
          observationWindow: projectObservationWindow(value.observationWindow),
        },
      };
    }
  }
}

function parseOccurrences(value: unknown): ObservationOccurrence[] | null {
  if (!Array.isArray(value)) return null;
  const occurrences: ObservationOccurrence[] = [];
  for (const item of value) {
    if (
      !isPlainRecord(item)
      || !hasExactKeys(item, ['event', 'atMs'])
      || !isNonemptyString(item.event)
      || !isFiniteNonnegativeNumber(item.atMs)
    ) return null;
    occurrences.push({ event: item.event, atMs: item.atMs });
  }
  return occurrences;
}

function parseTerminalObservations(value: unknown): TerminalStateObservationValue[] | null {
  if (!Array.isArray(value)) return null;
  const observations: TerminalStateObservationValue[] = [];
  for (const item of value) {
    if (
      !isPlainRecord(item)
      || !hasExactKeys(item, ['path', 'value', 'atMs'])
      || !isNonemptyString(item.path)
      || !isClaimScalar(item.value)
      || !isFiniteNonnegativeNumber(item.atMs)
    ) return null;
    observations.push({ path: item.path, value: item.value, atMs: item.atMs });
  }
  return observations;
}

function parseEligibleCandidate(value: unknown): ScenarioClaimEligibleEvidenceCandidate | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
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
    'observationWindow',
  ])) return null;
  const commonKeys = [
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
  ];
  if (!commonKeys.every((key) => Object.hasOwn(value, key))) return null;
  if (value.schemaVersion !== '1.0.0') return null;
  if (!['candidateId', 'claimId', 'assertionId'].every((key) => isIdentityString(value[key]))) return null;
  if (!isSha256(value.runIdentityHash) || !isSha256(value.claimHash)) return null;
  if (!isAssertionKind(value.assertionKind)) return null;
  if (!isEligibleAuthority(value.authority) || !isEvidenceReference(value.evidence)) return null;
  if (value.captureStatus !== 'produced') return null;
  if (value.cleanupStatus !== 'finalized' && value.cleanupStatus !== 'not_required') return null;
  if (!isClosedVocabulary(value.redactionStatus, ['not-redacted', 'redacted', 'private'])) return null;

  if (value.assertionKind === 'validatedEvidence') {
    if (!hasExactKeys(value, [...commonKeys, 'artifactKind', 'validationContract'])) return null;
    if (!isArtifactKind(value.artifactKind) || !isIdentityString(value.validationContract)) return null;
  } else if (value.assertionKind === 'boundedCount' || value.assertionKind === 'absence') {
    if (!hasExactKeys(value, [...commonKeys, 'observationWindow'])) return null;
    if (!isObservationWindow(value.observationWindow)) return null;
  } else if (!hasExactKeys(value, commonKeys)) {
    return null;
  }
  return projectEligibleCandidate(value as ScenarioClaimEligibleEvidenceCandidate);
}

function projectEligibleCandidate(
  candidate: ScenarioClaimEligibleEvidenceCandidate,
): ScenarioClaimEligibleEvidenceCandidate {
  const common = {
    schemaVersion: candidate.schemaVersion,
    candidateId: candidate.candidateId,
    runIdentityHash: candidate.runIdentityHash,
    claimId: candidate.claimId,
    claimHash: candidate.claimHash,
    assertionId: candidate.assertionId,
    authority: {
      declarationId: candidate.authority.declarationId,
      role: candidate.authority.role,
      producerId: candidate.authority.producerId,
      evidenceSelector: candidate.authority.evidenceSelector,
      producerVersion: candidate.authority.producerVersion,
      producerSha256: candidate.authority.producerSha256,
      strength: candidate.authority.strength,
      completeness: candidate.authority.completeness,
    },
    captureStatus: candidate.captureStatus,
    evidence: {
      path: candidate.evidence.path,
      sha256: candidate.evidence.sha256,
    },
    cleanupStatus: candidate.cleanupStatus,
    redactionStatus: candidate.redactionStatus,
  };
  switch (candidate.assertionKind) {
    case 'validatedEvidence':
      return {
        ...common,
        assertionKind: 'validatedEvidence',
        artifactKind: candidate.artifactKind,
        validationContract: candidate.validationContract,
      };
    case 'boundedCount':
    case 'absence':
      return {
        ...common,
        assertionKind: candidate.assertionKind,
        observationWindow: projectObservationWindow(candidate.observationWindow),
      };
    case 'eventOccurrence':
    case 'eventOrder':
    case 'terminalState':
      return { ...common, assertionKind: candidate.assertionKind };
  }
}

function isEligibleAuthority(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'declarationId',
      'role',
      'producerId',
      'evidenceSelector',
      'producerVersion',
      'producerSha256',
      'strength',
      'completeness',
    ])
    && isIdentityString(value.declarationId)
    && isClosedVocabulary(value.role, ['app', 'runner', 'adapter', 'provider', 'comparator'])
    && isIdentityString(value.producerId)
    && isIdentityString(value.evidenceSelector)
    && isIdentityString(value.producerVersion)
    && isSha256(value.producerSha256)
    && isClosedVocabulary(value.strength, ['observed', 'verified'])
    && isClosedVocabulary(value.completeness, ['point', 'bounded', 'continuous-complete']);
}

function isEvidenceReference(value: unknown): boolean {
  return isPlainRecord(value)
    && hasExactKeys(value, ['path', 'sha256'])
    && isIdentityString(value.path)
    && isSha256(value.sha256);
}

function projectCandidateIdentity(
  candidate: ScenarioClaimEligibleEvidenceCandidate,
): ScenarioClaimRawObservationCandidateIdentity {
  return {
    candidateId: candidate.candidateId,
    runIdentityHash: candidate.runIdentityHash,
    claimId: candidate.claimId,
    claimHash: candidate.claimHash,
    assertionId: candidate.assertionId,
    assertionKind: candidate.assertionKind,
  };
}

function blockedNextAction(
  reason: Exclude<ScenarioClaimRawObservationBlockedReason, 'artifact_hash_mismatch'>,
): ScenarioClaimRawObservationBlockedNextAction {
  return reason === 'observation_window_mismatch'
    ? 'align_observation_window'
    : 'repair_observation_artifact';
}

function sameObservationWindow(left: ClaimObservationWindow, right: ClaimObservationWindow): boolean {
  return left.from === right.from
    && left.to === right.to
    && left.completeSourceRequired === right.completeSourceRequired;
}

function projectObservationWindow(value: ClaimObservationWindow): ClaimObservationWindow {
  return {
    from: value.from,
    to: value.to,
    completeSourceRequired: true,
  };
}

function isObservationWindow(value: unknown): value is ClaimObservationWindow {
  return isPlainRecord(value)
    && hasExactKeys(value, ['from', 'to', 'completeSourceRequired'])
    && isNonemptyString(value.from)
    && isNonemptyString(value.to)
    && value.completeSourceRequired === true;
}

function isClaimScalar(value: unknown): value is ClaimScalar {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIdentityString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && isRunRelativePath(value);
}

function isRunRelativePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/u.test(value) || /^file:/iu.test(value)) return false;
  return !value.split('/').includes('..');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isAssertionKind(value: unknown): value is ScenarioClaimEligibleEvidenceCandidate['assertionKind'] {
  return isClosedVocabulary(value, [
    'eventOccurrence',
    'eventOrder',
    'terminalState',
    'boundedCount',
    'absence',
    'validatedEvidence',
  ]);
}

function isArtifactKind(value: unknown): boolean {
  return isClosedVocabulary(value, [
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
  ]);
}

function isClosedVocabulary<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
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

export {
  CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
  CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
  inspectScenarioClaimRawObservationAdmission,
};

export type {
  AbsenceRawObservation,
  BoundedCountRawObservation,
  EventOccurrenceRawObservation,
  EventOrderRawObservation,
  JsonNativeAssertionKind,
  ObservationOccurrence,
  ScenarioClaimRawObservation,
  ScenarioClaimRawObservationAdmissionInput,
  ScenarioClaimRawObservationAdmissionInspection,
  ScenarioClaimRawObservationAdmitted,
  ScenarioClaimRawObservationArtifactIdentity,
  ScenarioClaimRawObservationBlocked,
  ScenarioClaimRawObservationBlockedNextAction,
  ScenarioClaimRawObservationBlockedReason,
  ScenarioClaimRawObservationCandidateIdentity,
  ScenarioClaimRawObservationOutsideContract,
  ScenarioClaimRawObservationOutsideNextAction,
  ScenarioClaimRawObservationOutsideReason,
  ScenarioClaimRawObservationUnsupported,
  ScenarioClaimRawObservationUnsupportedNextAction,
  ScenarioClaimRawObservationUnsupportedReason,
  TerminalStateObservationValue,
  TerminalStateRawObservation,
};
