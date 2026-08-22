import {
  type AbsenceAssertion,
  type AbsenceResult,
  type BoundedCountAssertion,
  type BoundedCountResult,
  type ClaimAuthority,
  type ClaimEvidenceReference,
  type ClaimObservationWindow,
  type WindowedClaimAuthority,
} from './claim-contract';
import {
  CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
  CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
} from './claim-raw-observation-admission';

type BoundedCountBounds = Pick<BoundedCountAssertion, 'minimum' | 'maximum'>;

const CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION = '1.0.0' as const;

type JsonNativeWindowedAssertion = BoundedCountAssertion | AbsenceAssertion;

type JsonNativeWindowedKind = JsonNativeWindowedAssertion['kind'];

type JsonNativeWindowedObservation =
  | {
      schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
      kind: 'boundedCount';
      selector: string;
      count: number;
      observationWindow: ClaimObservationWindow;
    }
  | {
      schemaVersion: typeof CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;
      kind: 'absence';
      selector: string;
      count: number;
      observationWindow: ClaimObservationWindow;
    };

type ParsedAdmittedWindowed = {
  contractVersion: typeof CLAIM_RAW_OBSERVATION_ADMISSION_VERSION;
  status: 'admitted';
  candidateId: string;
  runIdentityHash: string;
  claimId: string;
  claimHash: string;
  assertionId: string;
  assertionKind: JsonNativeWindowedKind;
  artifact: {
    path: string;
    sha256: string;
    byteLength: number;
  };
  observation: JsonNativeWindowedObservation;
};

type JsonNativeWindowedInterpretationTrust = 'admitted_observation_interpretation_only';

type JsonNativeWindowedInterpretationOutsideReason =
  | 'input_invalid'
  | 'assertion_identity_mismatch'
  | 'assertion_kind_mismatch'
  | 'observation_kind_mismatch'
  | 'selector_mismatch'
  | 'observation_window_mismatch';

type ScenarioClaimJsonNativeWindowedInterpretationOutsideContract = {
  contractVersion: typeof CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION;
  status: 'outside_contract';
  trust: JsonNativeWindowedInterpretationTrust;
  reasonCodes: [
    JsonNativeWindowedInterpretationOutsideReason,
    ...JsonNativeWindowedInterpretationOutsideReason[],
  ];
};

type ScenarioClaimJsonNativeWindowedInterpreted = {
  contractVersion: typeof CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION;
  status: 'interpreted';
  trust: JsonNativeWindowedInterpretationTrust;
  result: BoundedCountResult | AbsenceResult;
};

type ScenarioClaimJsonNativeWindowedInterpretationInspection =
  | ScenarioClaimJsonNativeWindowedInterpretationOutsideContract
  | ScenarioClaimJsonNativeWindowedInterpreted;

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

const WINDOWED_ASSERTION_KINDS: readonly JsonNativeWindowedKind[] = [
  'boundedCount',
  'absence',
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

function inspectScenarioClaimJsonNativeWindowedInterpretation(
  assertionInput: unknown,
  admittedInput: unknown,
): ScenarioClaimJsonNativeWindowedInterpretationInspection {
  try {
    const parsed = parseInterpretationInput(assertionInput, admittedInput);
    if (!parsed.valid) {
      return {
        contractVersion: CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION,
        status: 'outside_contract',
        trust: 'admitted_observation_interpretation_only',
        reasonCodes: parsed.reasonCodes,
      };
    }

    return {
      contractVersion: CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION,
      status: 'interpreted',
      trust: 'admitted_observation_interpretation_only',
      result: interpretWindowedAssertion(parsed.assertion, parsed.admitted),
    };
  } catch {
    return {
      contractVersion: CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION,
      status: 'outside_contract',
      trust: 'admitted_observation_interpretation_only',
      reasonCodes: ['input_invalid'],
    };
  }
}

function interpretWindowedAssertion(
  assertion: JsonNativeWindowedAssertion,
  admitted: ParsedAdmittedWindowed,
): BoundedCountResult | AbsenceResult {
  const observation = admitted.observation;
  if (assertion.kind === 'boundedCount' && observation.kind === 'boundedCount') {
    return interpretBoundedCount(assertion, admitted, observation);
  }
  if (assertion.kind === 'absence' && observation.kind === 'absence') {
    return interpretAbsence(assertion, admitted, observation);
  }
  throw new Error('unreachable observation kind after parse');
}

function interpretBoundedCount(
  assertion: BoundedCountAssertion,
  admitted: ParsedAdmittedWindowed,
  observation: Extract<JsonNativeWindowedObservation, { kind: 'boundedCount' }>,
): BoundedCountResult {
  const expected = projectBoundedCountExpected(assertion);
  const evidenceReferences = evidenceFromAdmitted(admitted);
  const observed = {
    selector: observation.selector,
    count: observation.count,
  };

  if (countSatisfiesInclusiveBounds(observation.count, assertion)) {
    return {
      assertionId: assertion.id,
      assertionKind: 'boundedCount',
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
    assertionKind: 'boundedCount',
    expected,
    status: 'rejected',
    reasonCode: 'authoritative_evidence_rejected',
    observed,
    evidenceReferences,
    rejectedEvidence: [`${observation.selector}=${String(observation.count)}`],
    missingProof: [],
  };
}

function interpretAbsence(
  assertion: AbsenceAssertion,
  admitted: ParsedAdmittedWindowed,
  observation: Extract<JsonNativeWindowedObservation, { kind: 'absence' }>,
): AbsenceResult {
  const expected = {
    selector: assertion.selector,
    observationWindow: projectObservationWindow(assertion.observationWindow),
  };
  const evidenceReferences = evidenceFromAdmitted(admitted);

  if (observation.count === 0) {
    return {
      assertionId: assertion.id,
      assertionKind: 'absence',
      expected,
      status: 'supported',
      reasonCode: 'all_assertions_supported',
      observed: {
        selector: observation.selector,
        count: 0,
      },
      evidenceReferences,
      rejectedEvidence: [],
      missingProof: [],
    };
  }

  return {
    assertionId: assertion.id,
    assertionKind: 'absence',
    expected,
    status: 'rejected',
    reasonCode: 'authoritative_evidence_rejected',
    observed: {
      selector: observation.selector,
      count: observation.count,
    },
    evidenceReferences,
    rejectedEvidence: [`${observation.selector}=${String(observation.count)}`],
    missingProof: [],
  };
}

function countSatisfiesInclusiveBounds(count: number, bounds: BoundedCountBounds): boolean {
  if (Object.hasOwn(bounds, 'minimum') && bounds.minimum !== undefined && count < bounds.minimum) {
    return false;
  }
  if (Object.hasOwn(bounds, 'maximum') && bounds.maximum !== undefined && count > bounds.maximum) {
    return false;
  }
  return true;
}

function projectBoundedCountExpected(
  assertion: BoundedCountAssertion,
): BoundedCountResult['expected'] {
  const shared = {
    selector: assertion.selector,
    observationWindow: projectObservationWindow(assertion.observationWindow),
  };
  const hasMinimum = Object.hasOwn(assertion, 'minimum');
  const hasMaximum = Object.hasOwn(assertion, 'maximum');
  const minimum = assertion.minimum;
  const maximum = assertion.maximum;
  if (hasMinimum && hasMaximum && minimum !== undefined && maximum !== undefined) {
    return {
      ...shared,
      minimum,
      maximum,
    };
  }
  if (hasMinimum && minimum !== undefined) {
    return {
      ...shared,
      minimum,
    };
  }
  if (hasMaximum && maximum !== undefined) {
    return {
      ...shared,
      maximum,
    };
  }
  throw new Error('unreachable boundedCount expected without bounds after parse');
}

function evidenceFromAdmitted(
  admitted: ParsedAdmittedWindowed,
): [ClaimEvidenceReference, ...ClaimEvidenceReference[]] {
  return [
    {
      path: admitted.artifact.path,
      sha256: admitted.artifact.sha256,
    },
  ];
}

function parseInterpretationInput(
  assertionInput: unknown,
  admittedInput: unknown,
):
  | {
      valid: true;
      assertion: JsonNativeWindowedAssertion;
      admitted: ParsedAdmittedWindowed;
    }
  | {
      valid: false;
      reasonCodes: [
        JsonNativeWindowedInterpretationOutsideReason,
        ...JsonNativeWindowedInterpretationOutsideReason[],
      ];
    } {
  const assertion = parseWindowedAssertion(assertionInput);
  const envelope = parseAdmittedEnvelope(admittedInput);
  if (!assertion || !envelope) {
    return { valid: false, reasonCodes: ['input_invalid'] };
  }

  const reasons: JsonNativeWindowedInterpretationOutsideReason[] = [];
  if (envelope.assertionId !== assertion.id) {
    reasons.push('assertion_identity_mismatch');
  }
  if (envelope.assertionKind !== assertion.kind) {
    reasons.push('assertion_kind_mismatch');
  }
  if (envelope.observationKind !== assertion.kind) {
    reasons.push('observation_kind_mismatch');
  }

  const observation = parseWindowedObservation(assertion.kind, envelope.observationRecord);
  if (!observation) {
    if (reasons.length > 0) {
      return { valid: false, reasonCodes: nonemptyReasons(reasons) };
    }
    return { valid: false, reasonCodes: ['input_invalid'] };
  }

  if (observation.selector !== assertion.selector) {
    reasons.push('selector_mismatch');
  }
  if (!sameObservationWindow(observation.observationWindow, assertion.observationWindow)) {
    reasons.push('observation_window_mismatch');
  }
  if (reasons.length > 0) {
    return { valid: false, reasonCodes: nonemptyReasons(reasons) };
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
  reasons: JsonNativeWindowedInterpretationOutsideReason[],
): [
  JsonNativeWindowedInterpretationOutsideReason,
  ...JsonNativeWindowedInterpretationOutsideReason[],
] {
  const first = reasons[0];
  if (first === undefined) {
    return ['input_invalid'];
  }
  return [first, ...reasons.slice(1)];
}

function parseWindowedAssertion(value: unknown): JsonNativeWindowedAssertion | null {
  const record = snapshotPlainRecord(value);
  if (!record) {
    return null;
  }
  const id = record.id;
  const kind = record.kind;
  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }
  if (!isClosedVocabulary(kind, WINDOWED_ASSERTION_KINDS)) {
    return null;
  }
  const authority = parseWindowedAuthority(record.authority);
  if (!authority) {
    return null;
  }
  const selector = record.selector;
  if (typeof selector !== 'string' || selector.length === 0) {
    return null;
  }
  const observationWindow = parseObservationWindow(record.observationWindow);
  if (!observationWindow) {
    return null;
  }

  if (kind === 'absence') {
    if (!hasExactOwnKeys(record, ['id', 'kind', 'authority', 'selector', 'observationWindow'])) {
      return null;
    }
    return {
      id,
      kind: 'absence',
      authority,
      selector,
      observationWindow,
    };
  }

  return parseBoundedCountAssertion(record, {
    id,
    authority,
    selector,
    observationWindow,
  });
}

function parseBoundedCountAssertion(
  record: Record<string, unknown>,
  base: {
    id: string;
    authority: WindowedClaimAuthority;
    selector: string;
    observationWindow: ClaimObservationWindow;
  },
): BoundedCountAssertion | null {
  const required = ['id', 'kind', 'authority', 'selector', 'observationWindow'] as const;
  const hasMinimum = Object.hasOwn(record, 'minimum');
  const hasMaximum = Object.hasOwn(record, 'maximum');
  if (!hasMinimum && !hasMaximum) {
    return null;
  }
  const expectedKeys = [
    ...required,
    ...(hasMinimum ? (['minimum'] as const) : []),
    ...(hasMaximum ? (['maximum'] as const) : []),
  ];
  if (!hasExactOwnKeys(record, expectedKeys)) {
    return null;
  }
  if (hasMinimum && !isInclusiveBound(record.minimum)) {
    return null;
  }
  if (hasMaximum && !isInclusiveBound(record.maximum)) {
    return null;
  }
  if (
    hasMinimum
    && hasMaximum
    && isInclusiveBound(record.minimum)
    && isInclusiveBound(record.maximum)
    && record.minimum > record.maximum
  ) {
    return null;
  }

  const shared = {
    id: base.id,
    kind: 'boundedCount' as const,
    authority: base.authority,
    selector: base.selector,
    observationWindow: base.observationWindow,
  };
  if (hasMinimum && hasMaximum) {
    return {
      ...shared,
      minimum: record.minimum as number,
      maximum: record.maximum as number,
    };
  }
  if (hasMinimum) {
    return {
      ...shared,
      minimum: record.minimum as number,
    };
  }
  return {
    ...shared,
    maximum: record.maximum as number,
  };
}

function isInclusiveBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function parseWindowedAuthority(value: unknown): WindowedClaimAuthority | null {
  const authority = parseAuthority(value);
  if (!authority) {
    return null;
  }
  if (authority.completeness === 'point') {
    return null;
  }
  return {
    role: authority.role,
    producerId: authority.producerId,
    evidenceSelector: authority.evidenceSelector,
    requiredStrength: authority.requiredStrength,
    completeness: authority.completeness,
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

function parseWindowedObservation(
  kind: JsonNativeWindowedKind,
  record: Record<string, unknown>,
): JsonNativeWindowedObservation | null {
  if (record.schemaVersion !== CLAIM_RAW_OBSERVATION_SCHEMA_VERSION) {
    return null;
  }
  if (record.kind !== kind) {
    return null;
  }
  if (
    !hasExactOwnKeys(record, [
      'schemaVersion',
      'kind',
      'selector',
      'count',
      'observationWindow',
    ])
  ) {
    return null;
  }
  const selector = record.selector;
  const count = record.count;
  const observationWindow = parseObservationWindow(record.observationWindow);
  if (
    typeof selector !== 'string'
    || selector.length === 0
    || typeof count !== 'number'
    || !Number.isInteger(count)
    || count < 0
    || !observationWindow
  ) {
    return null;
  }
  if (kind === 'boundedCount') {
    return {
      schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
      kind: 'boundedCount',
      selector,
      count,
      observationWindow,
    };
  }
  return {
    schemaVersion: CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
    kind: 'absence',
    selector,
    count,
    observationWindow,
  };
}

function parseObservationWindow(value: unknown): ClaimObservationWindow | null {
  const record = snapshotPlainRecord(value);
  if (
    !record
    || !hasExactOwnKeys(record, ['from', 'to', 'completeSourceRequired'])
  ) {
    return null;
  }
  const from = record.from;
  const to = record.to;
  if (
    typeof from !== 'string'
    || from.length === 0
    || typeof to !== 'string'
    || to.length === 0
    || record.completeSourceRequired !== true
  ) {
    return null;
  }
  return {
    from,
    to,
    completeSourceRequired: true,
  };
}

function sameObservationWindow(
  left: ClaimObservationWindow,
  right: ClaimObservationWindow,
): boolean {
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
  CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION,
  inspectScenarioClaimJsonNativeWindowedInterpretation,
};

export type {
  JsonNativeWindowedAssertion,
  JsonNativeWindowedInterpretationOutsideReason,
  JsonNativeWindowedInterpretationTrust,
  ScenarioClaimJsonNativeWindowedInterpretationInspection,
  ScenarioClaimJsonNativeWindowedInterpretationOutsideContract,
  ScenarioClaimJsonNativeWindowedInterpreted,
};
