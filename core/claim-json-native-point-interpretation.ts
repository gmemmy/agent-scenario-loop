import {
  type ClaimAuthority,
  type ClaimEvidenceReference,
  type ClaimScalar,
  type EventOccurrenceAssertion,
  type EventOccurrenceResult,
  type EventOrderAssertion,
  type EventOrderResult,
  type NotEvaluableReasonCode,
  type TerminalStateAssertion,
  type TerminalStateResult,
  canonicalizeClaimValue,
} from './claim-contract';
import {
  CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
  CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
  type ObservationOccurrence,
  type TerminalStateObservationValue,
} from './claim-raw-observation-admission';

const CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION = '1.0.0' as const;

type JsonNativePointAssertion =
  | EventOccurrenceAssertion
  | EventOrderAssertion
  | TerminalStateAssertion;

type JsonNativePointKind = JsonNativePointAssertion['kind'];

type JsonNativePointObservation =
  | {
      schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
      kind: 'eventOccurrence';
      occurrences: ObservationOccurrence[];
    }
  | {
      schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
      kind: 'eventOrder';
      occurrences: ObservationOccurrence[];
    }
  | {
      schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
      kind: 'terminalState';
      observations: TerminalStateObservationValue[];
    };

type ParsedAdmittedPoint = {
  contractVersion: typeof CLAIM_RAW_OBSERVATION_ADMISSION_VERSION;
  status: 'admitted';
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: JsonNativePointKind;
  artifact: {
    path: string;
    sha256: string;
    byteLength: number;
  };
  observation: JsonNativePointObservation;
};

type JsonNativePointInterpretationTrust = 'admitted_observation_interpretation_only';

type JsonNativePointInterpretationOutsideReason =
  | 'input_invalid'
  | 'assertion_identity_mismatch'
  | 'assertion_kind_mismatch'
  | 'observation_kind_mismatch';

type ScenarioClaimJsonNativePointInterpretationOutsideContract = {
  contractVersion: typeof CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION;
  status: 'outside_contract';
  trust: JsonNativePointInterpretationTrust;
  reasonCodes: [
    JsonNativePointInterpretationOutsideReason,
    ...JsonNativePointInterpretationOutsideReason[],
  ];
};

type ScenarioClaimJsonNativePointInterpreted = {
  contractVersion: typeof CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION;
  status: 'interpreted';
  trust: JsonNativePointInterpretationTrust;
  result: EventOccurrenceResult | EventOrderResult | TerminalStateResult;
};

type ScenarioClaimJsonNativePointInterpretationInspection =
  | ScenarioClaimJsonNativePointInterpretationOutsideContract
  | ScenarioClaimJsonNativePointInterpreted;

type ParsedAdmittedEnvelope = {
  contractVersion: typeof CLAIM_RAW_OBSERVATION_ADMISSION_VERSION;
  status: 'admitted';
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: string;
  artifact: {
    path: string;
    sha256: string;
    byteLength: number;
  };
  observationKind: string;
  observationRecord: Record<string, unknown>;
};

const POINT_ASSERTION_KINDS: readonly JsonNativePointKind[] = [
  'eventOccurrence',
  'eventOrder',
  'terminalState',
];

const ADMITTED_KEYS = [
  'contractVersion',
  'status',
  'candidateId',
  'runIdentityHash',
  'claimId',
  'claimHash',
  'assertionId',
  'assertionKind',
  'artifact',
  'observation',
] as const;

function inspectScenarioClaimJsonNativePointInterpretation(
  assertionInput: unknown,
  admittedInput: unknown,
): ScenarioClaimJsonNativePointInterpretationInspection {
  try {
    const parsed = parseInterpretationInput(assertionInput, admittedInput);
    if (!parsed.valid) {
      return {
        contractVersion: CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION,
        status: 'outside_contract',
        trust: 'admitted_observation_interpretation_only',
        reasonCodes: parsed.reasonCodes,
      };
    }

    return {
      contractVersion: CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION,
      status: 'interpreted',
      trust: 'admitted_observation_interpretation_only',
      result: interpretPointAssertion(parsed.assertion, parsed.admitted),
    };
  } catch {
    return {
      contractVersion: CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION,
      status: 'outside_contract',
      trust: 'admitted_observation_interpretation_only',
      reasonCodes: ['input_invalid'],
    };
  }
}

function interpretPointAssertion(
  assertion: JsonNativePointAssertion,
  admitted: ParsedAdmittedPoint,
): EventOccurrenceResult | EventOrderResult | TerminalStateResult {
  const observation = admitted.observation;
  if (assertion.kind === 'eventOccurrence' && observation.kind === 'eventOccurrence') {
    return interpretEventOccurrence(assertion, admitted, observation);
  }
  if (assertion.kind === 'eventOrder' && observation.kind === 'eventOrder') {
    return interpretEventOrder(assertion, admitted, observation);
  }
  if (assertion.kind === 'terminalState' && observation.kind === 'terminalState') {
    return interpretTerminalState(assertion, admitted, observation);
  }
  throw new Error('unreachable observation kind after parse');
}

function interpretEventOccurrence(
  assertion: EventOccurrenceAssertion,
  admitted: ParsedAdmittedPoint,
  observation: Extract<JsonNativePointObservation, { kind: 'eventOccurrence' }>,
): EventOccurrenceResult {
  const expected = { event: assertion.event };
  const evidenceReferences = evidenceFromAdmitted(admitted);
  const matches = observation.occurrences.filter(
    (occurrence) => occurrence.event === assertion.event,
  );
  const match = matches[0];
  if (matches.length === 1 && match) {
    return {
      assertionId: assertion.id,
      assertionKind: 'eventOccurrence',
      expected,
      status: 'supported',
      reasonCode: 'all_assertions_supported',
      observed: {
        event: assertion.event,
        matchedEvidence: formatOccurrenceEvidence(match),
      },
      evidenceReferences,
      rejectedEvidence: [],
      missingProof: [],
    };
  }

  if (matches.length === 0) {
    return notEvaluableEventOccurrence(
      assertion.id,
      expected,
      evidenceReferences,
      'missing_authoritative_evidence',
    );
  }

  return notEvaluableEventOccurrence(
    assertion.id,
    expected,
    evidenceReferences,
    'ambiguous_evidence',
  );
}

function interpretEventOrder(
  assertion: EventOrderAssertion,
  admitted: ParsedAdmittedPoint,
  observation: Extract<JsonNativePointObservation, { kind: 'eventOrder' }>,
): EventOrderResult {
  const expected = {
    beforeEvent: assertion.beforeEvent,
    afterEvent: assertion.afterEvent,
  };
  const evidenceReferences = evidenceFromAdmitted(admitted);
  const beforeMatches = observation.occurrences.filter(
    (occurrence) => occurrence.event === assertion.beforeEvent,
  );
  const afterMatches = observation.occurrences.filter(
    (occurrence) => occurrence.event === assertion.afterEvent,
  );
  const before = beforeMatches[0];
  const after = afterMatches[0];

  if (beforeMatches.length === 0 || afterMatches.length === 0 || !before || !after) {
    return notEvaluableEventOrder(
      assertion.id,
      expected,
      evidenceReferences,
      'missing_authoritative_evidence',
    );
  }
  if (beforeMatches.length > 1 || afterMatches.length > 1) {
    return notEvaluableEventOrder(
      assertion.id,
      expected,
      evidenceReferences,
      'ambiguous_evidence',
    );
  }

  if (before.atMs < after.atMs) {
    return {
      assertionId: assertion.id,
      assertionKind: 'eventOrder',
      expected,
      status: 'supported',
      reasonCode: 'all_assertions_supported',
      observed: {
        beforeEvidence: formatOccurrenceEvidence(before),
        afterEvidence: formatOccurrenceEvidence(after),
        relation: 'before',
      },
      evidenceReferences,
      rejectedEvidence: [],
      missingProof: [],
    };
  }

  if (before.atMs > after.atMs) {
    return {
      assertionId: assertion.id,
      assertionKind: 'eventOrder',
      expected,
      status: 'rejected',
      reasonCode: 'authoritative_evidence_rejected',
      observed: {
        beforeEvidence: formatOccurrenceEvidence(before),
        afterEvidence: formatOccurrenceEvidence(after),
        relation: 'after',
      },
      evidenceReferences,
      rejectedEvidence: [
        `${formatOccurrenceEvidence(before)} occurred after ${formatOccurrenceEvidence(after)}`,
      ],
      missingProof: [],
    };
  }

  return notEvaluableEventOrder(
    assertion.id,
    expected,
    evidenceReferences,
    'ambiguous_evidence',
  );
}

function interpretTerminalState(
  assertion: TerminalStateAssertion,
  admitted: ParsedAdmittedPoint,
  observation: Extract<JsonNativePointObservation, { kind: 'terminalState' }>,
): TerminalStateResult {
  const expected = {
    path: assertion.path,
    value: assertion.expected,
  };
  const evidenceReferences = evidenceFromAdmitted(admitted);
  const matches = observation.observations.filter((item) => item.path === assertion.path);
  const firstMatch = matches[0];
  if (matches.length === 0 || !firstMatch) {
    return notEvaluableTerminalState(
      assertion.id,
      expected,
      evidenceReferences,
      'missing_authoritative_evidence',
    );
  }

  if (uniqueCanonicalValues(matches).length > 1) {
    return notEvaluableTerminalState(
      assertion.id,
      expected,
      evidenceReferences,
      'authoritative_evidence_conflict',
    );
  }

  const observed = {
    path: assertion.path,
    value: firstMatch.value,
  };

  if (canonicalizeClaimValue(firstMatch.value) === canonicalizeClaimValue(assertion.expected)) {
    return {
      assertionId: assertion.id,
      assertionKind: 'terminalState',
      expected,
      status: 'supported',
      reasonCode: 'all_assertions_supported',
      observed,
      evidenceReferences,
      rejectedEvidence: [],
      missingProof: [],
    };
  }

  return {
    assertionId: assertion.id,
    assertionKind: 'terminalState',
    expected,
    status: 'rejected',
    reasonCode: 'authoritative_evidence_rejected',
    observed,
    evidenceReferences,
    rejectedEvidence: [`${assertion.path}=${String(firstMatch.value)}`],
    missingProof: [],
  };
}

function notEvaluableEventOccurrence(
  assertionId: string,
  expected: EventOccurrenceResult['expected'],
  evidenceReferences: ClaimEvidenceReference[],
  reasonCode: Extract<NotEvaluableReasonCode, 'missing_authoritative_evidence' | 'ambiguous_evidence'>,
): EventOccurrenceResult {
  return {
    assertionId,
    assertionKind: 'eventOccurrence',
    expected,
    status: 'not_evaluable',
    reasonCode,
    observed: null,
    evidenceReferences,
    rejectedEvidence: [],
    missingProof: [reasonCode],
  };
}

function notEvaluableEventOrder(
  assertionId: string,
  expected: EventOrderResult['expected'],
  evidenceReferences: ClaimEvidenceReference[],
  reasonCode: Extract<NotEvaluableReasonCode, 'missing_authoritative_evidence' | 'ambiguous_evidence'>,
): EventOrderResult {
  return {
    assertionId,
    assertionKind: 'eventOrder',
    expected,
    status: 'not_evaluable',
    reasonCode,
    observed: null,
    evidenceReferences,
    rejectedEvidence: [],
    missingProof: [reasonCode],
  };
}

function notEvaluableTerminalState(
  assertionId: string,
  expected: TerminalStateResult['expected'],
  evidenceReferences: ClaimEvidenceReference[],
  reasonCode: Extract<
    NotEvaluableReasonCode,
    'missing_authoritative_evidence' | 'authoritative_evidence_conflict'
  >,
): TerminalStateResult {
  return {
    assertionId,
    assertionKind: 'terminalState',
    expected,
    status: 'not_evaluable',
    reasonCode,
    observed: null,
    evidenceReferences,
    rejectedEvidence: [],
    missingProof: [reasonCode],
  };
}

function evidenceFromAdmitted(
  admitted: ParsedAdmittedPoint,
): [ClaimEvidenceReference, ...ClaimEvidenceReference[]] {
  return [
    {
      path: admitted.artifact.path,
      sha256: admitted.artifact.sha256,
    },
  ];
}

function formatOccurrenceEvidence(occurrence: ObservationOccurrence): string {
  return `${occurrence.event}@${String(occurrence.atMs)}`;
}

function uniqueCanonicalValues(observations: TerminalStateObservationValue[]): string[] {
  const values = new Set<string>();
  for (const observation of observations) {
    values.add(canonicalizeClaimValue(observation.value));
  }
  return [...values];
}

function parseInterpretationInput(
  assertionInput: unknown,
  admittedInput: unknown,
):
  | {
      valid: true;
      assertion: JsonNativePointAssertion;
      admitted: ParsedAdmittedPoint;
    }
  | {
      valid: false;
      reasonCodes: [
        JsonNativePointInterpretationOutsideReason,
        ...JsonNativePointInterpretationOutsideReason[],
      ];
    } {
  const assertion = parsePointAssertion(assertionInput);
  const envelope = parseAdmittedEnvelope(admittedInput);
  if (!assertion || !envelope) {
    return { valid: false, reasonCodes: ['input_invalid'] };
  }

  const reasons: JsonNativePointInterpretationOutsideReason[] = [];
  if (envelope.assertionId !== assertion.id) {
    reasons.push('assertion_identity_mismatch');
  }
  if (envelope.assertionKind !== assertion.kind) {
    reasons.push('assertion_kind_mismatch');
  }
  if (envelope.observationKind !== assertion.kind) {
    reasons.push('observation_kind_mismatch');
  }
  if (reasons.length > 0) {
    return { valid: false, reasonCodes: nonemptyReasons(reasons) };
  }

  const observation = parsePointObservation(assertion.kind, envelope.observationRecord);
  if (!observation) {
    return { valid: false, reasonCodes: ['input_invalid'] };
  }

  return {
    valid: true,
    assertion,
    admitted: {
      contractVersion: envelope.contractVersion,
      status: 'admitted',
      candidateId: envelope.candidateId,
      runIdentityHash: envelope.runIdentityHash,
      claimId: envelope.claimId,
      claimHash: envelope.claimHash,
      assertionId: envelope.assertionId,
      assertionKind: assertion.kind,
      artifact: {
        path: envelope.artifact.path,
        sha256: envelope.artifact.sha256,
        byteLength: envelope.artifact.byteLength,
      },
      observation,
    },
  };
}

function nonemptyReasons(
  reasons: JsonNativePointInterpretationOutsideReason[],
): [
  JsonNativePointInterpretationOutsideReason,
  ...JsonNativePointInterpretationOutsideReason[],
] {
  const first = reasons[0];
  if (first === undefined) {
    return ['input_invalid'];
  }
  return [first, ...reasons.slice(1)];
}

function parsePointAssertion(value: unknown): JsonNativePointAssertion | null {
  const record = snapshotPlainRecord(value);
  if (!record) {
    return null;
  }
  const id = record.id;
  const kind = record.kind;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  if (!isClosedVocabulary(kind, POINT_ASSERTION_KINDS)) {
    return null;
  }
  const authority = parseAuthority(record.authority);
  if (!authority) {
    return null;
  }

  if (kind === 'eventOccurrence') {
    if (!hasExactOwnKeys(record, ['id', 'kind', 'event', 'authority'])) {
      return null;
    }
    const event = record.event;
    if (typeof event !== 'string' || event.length === 0) {
      return null;
    }
    return {
      id,
      kind: 'eventOccurrence',
      event,
      authority,
    };
  }

  if (kind === 'eventOrder') {
    if (!hasExactOwnKeys(record, ['id', 'kind', 'beforeEvent', 'afterEvent', 'authority'])) {
      return null;
    }
    const beforeEvent = record.beforeEvent;
    const afterEvent = record.afterEvent;
    if (typeof beforeEvent !== 'string' || beforeEvent.length === 0) {
      return null;
    }
    if (typeof afterEvent !== 'string' || afterEvent.length === 0) {
      return null;
    }
    return {
      id,
      kind: 'eventOrder',
      beforeEvent,
      afterEvent,
      authority,
    };
  }

  if (!hasExactOwnKeys(record, ['id', 'kind', 'path', 'expected', 'authority'])) {
    return null;
  }
  const path = record.path;
  const expected = record.expected;
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  if (!isClaimScalar(expected)) {
    return null;
  }
  return {
    id,
    kind: 'terminalState',
    path,
    expected,
    authority,
  };
}

function parseAuthority(value: unknown): ClaimAuthority | null {
  const record = snapshotPlainRecord(value);
  if (
    !record
    || !hasExactOwnKeys(record, [
      'role',
      'producerId',
      'evidenceSelector',
      'requiredStrength',
      'completeness',
    ])
  ) {
    return null;
  }
  const role = record.role;
  const producerId = record.producerId;
  const evidenceSelector = record.evidenceSelector;
  const requiredStrength = record.requiredStrength;
  const completeness = record.completeness;
  if (
    !isClosedVocabulary(role, ['app', 'runner', 'adapter', 'provider', 'comparator'])
    || typeof producerId !== 'string'
    || producerId.length === 0
    || typeof evidenceSelector !== 'string'
    || evidenceSelector.length === 0
    || !isClosedVocabulary(requiredStrength, ['observed', 'verified'])
    || !isClosedVocabulary(completeness, ['point', 'bounded', 'continuous-complete'])
  ) {
    return null;
  }
  return {
    role,
    producerId,
    evidenceSelector,
    requiredStrength,
    completeness,
  };
}

function parseAdmittedEnvelope(value: unknown): ParsedAdmittedEnvelope | null {
  const record = snapshotPlainRecord(value);
  if (!record || !hasExactOwnKeys(record, ADMITTED_KEYS)) {
    return null;
  }
  if (record.contractVersion !== CLAIM_RAW_OBSERVATION_ADMISSION_VERSION) {
    return null;
  }
  if (record.status !== 'admitted') {
    return null;
  }
  const candidateId = record.candidateId;
  const runIdentityHash = record.runIdentityHash;
  const claimId = record.claimId;
  const claimHash = record.claimHash;
  const assertionId = record.assertionId;
  const assertionKind = record.assertionKind;
  if (
    typeof candidateId !== 'string'
    || candidateId.length === 0
    || typeof runIdentityHash !== 'string'
    || runIdentityHash.length === 0
    || typeof claimId !== 'string'
    || claimId.length === 0
    || typeof claimHash !== 'string'
    || claimHash.length === 0
    || typeof assertionId !== 'string'
    || assertionId.length === 0
    || typeof assertionKind !== 'string'
    || assertionKind.length === 0
  ) {
    return null;
  }
  const artifactRecord = snapshotPlainRecord(record.artifact);
  if (!artifactRecord || !hasExactOwnKeys(artifactRecord, ['path', 'sha256', 'byteLength'])) {
    return null;
  }
  const artifactPath = artifactRecord.path;
  const artifactSha256 = artifactRecord.sha256;
  const artifactByteLength = artifactRecord.byteLength;
  if (
    typeof artifactPath !== 'string'
    || artifactPath.length === 0
    || typeof artifactSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(artifactSha256)
    || typeof artifactByteLength !== 'number'
    || !Number.isInteger(artifactByteLength)
    || artifactByteLength < 0
  ) {
    return null;
  }
  const observationRecord = snapshotPlainRecord(record.observation);
  if (!observationRecord) {
    return null;
  }
  const observationKind = observationRecord.kind;
  if (typeof observationKind !== 'string') {
    return null;
  }

  return {
    contractVersion: CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
    status: 'admitted',
    candidateId,
    runIdentityHash,
    claimId,
    claimHash,
    assertionId,
    assertionKind,
    artifact: {
      path: artifactPath,
      sha256: artifactSha256,
      byteLength: artifactByteLength,
    },
    observationKind,
    observationRecord,
  };
}

function parsePointObservation(
  kind: JsonNativePointKind,
  record: Record<string, unknown>,
): JsonNativePointObservation | null {
  if (record.schemaVersion !== CLAIM_RAW_OBSERVATION_SCHEMA_VERSION) {
    return null;
  }
  if (record.kind !== kind) {
    return null;
  }

  if (kind === 'eventOccurrence' || kind === 'eventOrder') {
    if (!hasExactOwnKeys(record, ['schemaVersion', 'kind', 'occurrences'])) {
      return null;
    }
    const occurrences = parseOccurrences(record.occurrences);
    if (!occurrences) {
      return null;
    }
    if (kind === 'eventOccurrence') {
      return {
        schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
        kind: 'eventOccurrence',
        occurrences,
      };
    }
    return {
      schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
      kind: 'eventOrder',
      occurrences,
    };
  }

  if (!hasExactOwnKeys(record, ['schemaVersion', 'kind', 'observations'])) {
    return null;
  }
  const observations = parseTerminalObservations(record.observations);
  if (!observations) {
    return null;
  }
  return {
    schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
    kind: 'terminalState',
    observations,
  };
}

function parseOccurrences(value: unknown): ObservationOccurrence[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const occurrences: ObservationOccurrence[] = [];
  for (const item of value) {
    const record = snapshotPlainRecord(item);
    if (!record || !hasExactOwnKeys(record, ['event', 'atMs'])) {
      return null;
    }
    const event = record.event;
    const atMs = record.atMs;
    if (
      typeof event !== 'string'
      || event.length === 0
      || typeof atMs !== 'number'
      || !Number.isFinite(atMs)
      || atMs < 0
    ) {
      return null;
    }
    occurrences.push({ event, atMs });
  }
  return occurrences;
}

function parseTerminalObservations(value: unknown): TerminalStateObservationValue[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const observations: TerminalStateObservationValue[] = [];
  for (const item of value) {
    const record = snapshotPlainRecord(item);
    if (!record || !hasExactOwnKeys(record, ['path', 'value', 'atMs'])) {
      return null;
    }
    const path = record.path;
    const observationValue = record.value;
    const atMs = record.atMs;
    if (
      typeof path !== 'string'
      || path.length === 0
      || !isClaimScalar(observationValue)
      || typeof atMs !== 'number'
      || !Number.isFinite(atMs)
      || atMs < 0
    ) {
      return null;
    }
    observations.push({ path, value: observationValue, atMs });
  }
  return observations;
}

function isClaimScalar(value: unknown): value is ClaimScalar {
  return (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  );
}

function isClosedVocabulary<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return null;
  }

  let ownKeys: Array<string | symbol>;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return null;
  }

  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of ownKeys) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return null;
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      return null;
    }
    if (typeof key !== 'string') {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) {
    return false;
  }
  const allowed = new Set<string>(keys);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return false;
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      return false;
    }
  }
  return true;
}

export {
  CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION,
  inspectScenarioClaimJsonNativePointInterpretation,
};

export type {
  JsonNativePointAssertion,
  JsonNativePointInterpretationOutsideReason,
  JsonNativePointInterpretationTrust,
  ScenarioClaimJsonNativePointInterpretationInspection,
  ScenarioClaimJsonNativePointInterpretationOutsideContract,
  ScenarioClaimJsonNativePointInterpreted,
};
