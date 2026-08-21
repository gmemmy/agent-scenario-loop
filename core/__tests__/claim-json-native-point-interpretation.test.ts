const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION,
  inspectScenarioClaimJsonNativePointInterpretation,
} = require('../claim-json-native-point-interpretation');

type JsonRecord = Record<string, any>;

const SHA_A = 'a'.repeat(64);
const FORBIDDEN_VOCABULARY = [
  'health',
  'ClaimResult',
  'verdict',
  'boundedCount',
  'absence',
  'validatedEvidence',
  'not_applicable',
];

const RESULT_KEYS = [
  'assertionId',
  'assertionKind',
  'evidenceReferences',
  'expected',
  'missingProof',
  'observed',
  'reasonCode',
  'rejectedEvidence',
  'status',
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function authority(): JsonRecord {
  return {
    role: 'app',
    producerId: 'app-profile-session',
    evidenceSelector: 'observations.point',
    requiredStrength: 'verified',
    completeness: 'point',
  };
}

function eventOccurrenceAssertion(): JsonRecord {
  return {
    id: 'eventOccurrence-assertion',
    kind: 'eventOccurrence',
    event: 'journey_completed',
    authority: authority(),
  };
}

function eventOrderAssertion(): JsonRecord {
  return {
    id: 'eventOrder-assertion',
    kind: 'eventOrder',
    beforeEvent: 'journey_started',
    afterEvent: 'journey_completed',
    authority: authority(),
  };
}

function terminalStateAssertion(expected: string | number | boolean | null = 'ready'): JsonRecord {
  return {
    id: 'terminalState-assertion',
    kind: 'terminalState',
    path: 'screen.state',
    expected,
    authority: authority(),
  };
}

function admittedBase(kind: string, observation: JsonRecord): JsonRecord {
  return {
    contractVersion: '1.0.0',
    status: 'admitted',
    candidateId: `${kind}-candidate`,
    runIdentityHash: SHA_A,
    claimId: 'journey-completes',
    claimHash: 'b'.repeat(64),
    assertionId: `${kind}-assertion`,
    assertionKind: kind,
    artifact: {
      path: `raw/${kind}.json`,
      sha256: SHA_A,
      byteLength: 32,
    },
    observation,
  };
}

function eventOccurrenceAdmitted(occurrences: JsonRecord[]): JsonRecord {
  return admittedBase('eventOccurrence', {
    schemaVersion: '1.0.0',
    kind: 'eventOccurrence',
    occurrences,
  });
}

function eventOrderAdmitted(occurrences: JsonRecord[]): JsonRecord {
  return admittedBase('eventOrder', {
    schemaVersion: '1.0.0',
    kind: 'eventOrder',
    occurrences,
  });
}

function terminalStateAdmitted(observations: JsonRecord[]): JsonRecord {
  return admittedBase('terminalState', {
    schemaVersion: '1.0.0',
    kind: 'terminalState',
    observations,
  });
}

function assertClosedEnvelope(
  result: JsonRecord,
  status: 'outside_contract' | 'interpreted',
): void {
  assert.equal(result.contractVersion, CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION);
  assert.equal(result.trust, 'admitted_observation_interpretation_only');
  assert.equal(result.status, status);
  if (status === 'outside_contract') {
    assert.deepEqual(Object.keys(result).sort(), [
      'contractVersion',
      'reasonCodes',
      'status',
      'trust',
    ]);
    assert.ok(Array.isArray(result.reasonCodes) && result.reasonCodes.length > 0);
  } else {
    assert.deepEqual(Object.keys(result).sort(), [
      'contractVersion',
      'result',
      'status',
      'trust',
    ]);
    assertClosedResult(result.result);
  }
}

function assertClosedResult(result: JsonRecord): void {
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
}

function assertNoForbiddenVocabulary(result: JsonRecord): void {
  const serialized = JSON.stringify(result);
  for (const token of FORBIDDEN_VOCABULARY) {
    assert.equal(
      serialized.includes(token),
      false,
      `serialized result must not include ${token}`,
    );
  }
}

function assertEvidenceCopied(result: JsonRecord, kind: string): void {
  assert.deepEqual(result.evidenceReferences, [
    { path: `raw/${kind}.json`, sha256: SHA_A },
  ]);
}

function assertSupportedShape(result: JsonRecord): void {
  assertClosedResult(result);
  assert.equal(result.status, 'supported');
  assert.equal(result.reasonCode, 'all_assertions_supported');
  assert.ok(Array.isArray(result.evidenceReferences) && result.evidenceReferences.length > 0);
  assert.deepEqual(result.rejectedEvidence, []);
  assert.deepEqual(result.missingProof, []);
}

function assertRejectedShape(result: JsonRecord): void {
  assertClosedResult(result);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reasonCode, 'authoritative_evidence_rejected');
  assert.ok(Array.isArray(result.evidenceReferences) && result.evidenceReferences.length > 0);
  assert.ok(Array.isArray(result.rejectedEvidence) && result.rejectedEvidence.length > 0);
  assert.deepEqual(result.missingProof, []);
}

function assertNotEvaluableShape(result: JsonRecord, reasonCode: string): void {
  assertClosedResult(result);
  assert.equal(result.status, 'not_evaluable');
  assert.equal(result.reasonCode, reasonCode);
  assert.equal(result.observed, null);
  assert.deepEqual(result.rejectedEvidence, []);
  assert.deepEqual(result.missingProof, [reasonCode]);
}

test('supports a single matching eventOccurrence', () => {
  const assertion = eventOccurrenceAssertion();
  const admitted = eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 12.5 }]);
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(assertion, admitted);
  assertClosedEnvelope(inspection, 'interpreted');
  const result = inspection.result;
  assert.equal(result.assertionId, 'eventOccurrence-assertion');
  assert.equal(result.assertionKind, 'eventOccurrence');
  assert.deepEqual(result.expected, { event: 'journey_completed' });
  assertSupportedShape(result);
  assert.deepEqual(result.observed, {
    event: 'journey_completed',
    matchedEvidence: 'journey_completed@12.5',
  });
  assertEvidenceCopied(result, 'eventOccurrence');
  assertNoForbiddenVocabulary(inspection);
});

test('eventOccurrence with zero matches is not_evaluable missing_authoritative_evidence', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    eventOccurrenceAdmitted([{ event: 'other_event', atMs: 1 }]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertNotEvaluableShape(inspection.result, 'missing_authoritative_evidence');
  assert.deepEqual(inspection.result.expected, { event: 'journey_completed' });
  assertEvidenceCopied(inspection.result, 'eventOccurrence');
  assertNoForbiddenVocabulary(inspection);
});

test('eventOccurrence with empty occurrences is not_evaluable missing_authoritative_evidence', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    eventOccurrenceAdmitted([]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertNotEvaluableShape(inspection.result, 'missing_authoritative_evidence');
});

test('eventOccurrence with duplicate matches is not_evaluable ambiguous_evidence', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    eventOccurrenceAdmitted([
      { event: 'journey_completed', atMs: 1 },
      { event: 'journey_completed', atMs: 2 },
    ]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertNotEvaluableShape(inspection.result, 'ambiguous_evidence');
  assertEvidenceCopied(inspection.result, 'eventOccurrence');
});

test('eventOrder supports before when before atMs is less than after atMs', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([
      { event: 'noise', atMs: 0 },
      { event: 'journey_started', atMs: 1 },
      { event: 'journey_completed', atMs: 12 },
    ]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  const result = inspection.result;
  assertSupportedShape(result);
  assert.deepEqual(result.expected, {
    beforeEvent: 'journey_started',
    afterEvent: 'journey_completed',
  });
  assert.equal(result.observed.relation, 'before');
  assert.equal(result.observed.beforeEvidence, 'journey_started@1');
  assert.equal(result.observed.afterEvidence, 'journey_completed@12');
  assertEvidenceCopied(result, 'eventOrder');
  assertNoForbiddenVocabulary(inspection);
});

test('eventOrder rejects when before atMs is greater than after atMs', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([
      { event: 'journey_started', atMs: 20 },
      { event: 'journey_completed', atMs: 12 },
    ]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  const result = inspection.result;
  assertRejectedShape(result);
  assert.equal(result.observed.relation, 'after');
  assertEvidenceCopied(result, 'eventOrder');
  assertNoForbiddenVocabulary(inspection);
});

test('eventOrder equal timestamps are not_evaluable ambiguous_evidence', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([
      { event: 'journey_started', atMs: 12 },
      { event: 'journey_completed', atMs: 12 },
    ]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertNotEvaluableShape(inspection.result, 'ambiguous_evidence');
  assertEvidenceCopied(inspection.result, 'eventOrder');
});

test('eventOrder missing endpoint is missing_authoritative_evidence', () => {
  const missingAfter = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([{ event: 'journey_started', atMs: 1 }]),
  );
  assertClosedEnvelope(missingAfter, 'interpreted');
  assertNotEvaluableShape(missingAfter.result, 'missing_authoritative_evidence');

  const missingBefore = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([{ event: 'journey_completed', atMs: 12 }]),
  );
  assertClosedEnvelope(missingBefore, 'interpreted');
  assertNotEvaluableShape(missingBefore.result, 'missing_authoritative_evidence');
});

test('eventOrder duplicate endpoint is ambiguous_evidence', () => {
  const duplicateBefore = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([
      { event: 'journey_started', atMs: 1 },
      { event: 'journey_started', atMs: 2 },
      { event: 'journey_completed', atMs: 12 },
    ]),
  );
  assertClosedEnvelope(duplicateBefore, 'interpreted');
  assertNotEvaluableShape(duplicateBefore.result, 'ambiguous_evidence');

  const duplicateAfter = inspectScenarioClaimJsonNativePointInterpretation(
    eventOrderAssertion(),
    eventOrderAdmitted([
      { event: 'journey_started', atMs: 1 },
      { event: 'journey_completed', atMs: 12 },
      { event: 'journey_completed', atMs: 13 },
    ]),
  );
  assertClosedEnvelope(duplicateAfter, 'interpreted');
  assertNotEvaluableShape(duplicateAfter.result, 'ambiguous_evidence');
});

test('terminalState supports a single canonical matching value', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    terminalStateAssertion(),
    terminalStateAdmitted([{ path: 'screen.state', value: 'ready', atMs: 14 }]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  const result = inspection.result;
  assertSupportedShape(result);
  assert.deepEqual(result.expected, { path: 'screen.state', value: 'ready' });
  assert.deepEqual(result.observed, { path: 'screen.state', value: 'ready' });
  assertEvidenceCopied(result, 'terminalState');
  assertNoForbiddenVocabulary(inspection);
});

test('terminalState supports repeated observations that canonicalize equally', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    terminalStateAssertion(),
    terminalStateAdmitted([
      { path: 'screen.state', value: 'ready', atMs: 14 },
      { path: 'screen.state', value: 'ready', atMs: 15 },
    ]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertSupportedShape(inspection.result);
});

test('terminalState rejects a single canonical unequal value', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    terminalStateAssertion(),
    terminalStateAdmitted([{ path: 'screen.state', value: 'busy', atMs: 14 }]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  const result = inspection.result;
  assertRejectedShape(result);
  assert.deepEqual(result.observed, { path: 'screen.state', value: 'busy' });
  assertEvidenceCopied(result, 'terminalState');
});

test('terminalState missing path is missing_authoritative_evidence', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    terminalStateAssertion(),
    terminalStateAdmitted([{ path: 'other.path', value: 'ready', atMs: 14 }]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertNotEvaluableShape(inspection.result, 'missing_authoritative_evidence');
  assert.deepEqual(inspection.result.expected, { path: 'screen.state', value: 'ready' });
  assertEvidenceCopied(inspection.result, 'terminalState');
});

test('terminalState conflicting values are authoritative_evidence_conflict', () => {
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(
    terminalStateAssertion(),
    terminalStateAdmitted([
      { path: 'screen.state', value: 'ready', atMs: 14 },
      { path: 'screen.state', value: 'busy', atMs: 15 },
    ]),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertNotEvaluableShape(inspection.result, 'authoritative_evidence_conflict');
});

test('terminalState supports null, boolean, number, and -0 scalar values', () => {
  const cases: Array<{ expected: string | number | boolean | null; observed: string | number | boolean | null }> = [
    { expected: null, observed: null },
    { expected: true, observed: true },
    { expected: false, observed: false },
    { expected: 0, observed: 0 },
    { expected: 7, observed: 7 },
    { expected: -0, observed: -0 },
  ];
  for (const sample of cases) {
    const inspection = inspectScenarioClaimJsonNativePointInterpretation(
      terminalStateAssertion(sample.expected),
      terminalStateAdmitted([{ path: 'screen.state', value: sample.observed, atMs: 1 }]),
    );
    assertClosedEnvelope(inspection, 'interpreted');
    assertSupportedShape(inspection.result);
    assert.deepEqual(inspection.result.expected, { path: 'screen.state', value: sample.expected });
    assert.deepEqual(inspection.result.observed, { path: 'screen.state', value: sample.observed });
  }

  const rejectedZero = inspectScenarioClaimJsonNativePointInterpretation(
    terminalStateAssertion(0),
    terminalStateAdmitted([{ path: 'screen.state', value: 1, atMs: 1 }]),
  );
  assertClosedEnvelope(rejectedZero, 'interpreted');
  assertRejectedShape(rejectedZero.result);
});

test('rejects malformed input, identity mismatch, and kind mismatch as outside_contract', () => {
  const malformedCases: Array<[unknown, unknown]> = [
    [null, undefined],
    [42, eventOccurrenceAdmitted([])],
    [eventOccurrenceAssertion(), 'admitted'],
    [[], {}],
    [{ ...eventOccurrenceAssertion(), kind: 'boundedCount' }, eventOccurrenceAdmitted([])],
    [eventOccurrenceAssertion(), { ...eventOccurrenceAdmitted([]), status: 'blocked' }],
    [
      { ...eventOccurrenceAssertion(), extra: true },
      eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
    ],
  ];
  for (const [assertion, admitted] of malformedCases) {
    const malformed = inspectScenarioClaimJsonNativePointInterpretation(assertion, admitted);
    assertClosedEnvelope(malformed, 'outside_contract');
    assert.ok(malformed.reasonCodes.includes('input_invalid'));
    assertNoForbiddenVocabulary(malformed);
  }

  const identity = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    {
      ...eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
      assertionId: 'other',
    },
  );
  assertClosedEnvelope(identity, 'outside_contract');
  assert.deepEqual(identity.reasonCodes, ['assertion_identity_mismatch']);

  const kindMismatch = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    eventOrderAdmitted([
      { event: 'journey_started', atMs: 1 },
      { event: 'journey_completed', atMs: 2 },
    ]),
  );
  assertClosedEnvelope(kindMismatch, 'outside_contract');
  assert.ok(kindMismatch.reasonCodes.includes('assertion_kind_mismatch'));
  assert.ok(kindMismatch.reasonCodes.includes('observation_kind_mismatch'));

  const observationKind = eventOccurrenceAdmitted([
    { event: 'journey_completed', atMs: 1 },
  ]);
  observationKind.observation = {
    schemaVersion: '1.0.0',
    kind: 'terminalState',
    observations: [{ path: 'screen.state', value: 'ready', atMs: 1 }],
  };
  const observationMismatch = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    observationKind,
  );
  assertClosedEnvelope(observationMismatch, 'outside_contract');
  assert.deepEqual(observationMismatch.reasonCodes, ['observation_kind_mismatch']);
});

test('hostile unknown-input gates fail closed as input_invalid', () => {
  const extraHidden = eventOccurrenceAssertion();
  Object.defineProperty(extraHidden, 'hidden', {
    value: true,
    enumerable: false,
  });
  const hiddenKeys = inspectScenarioClaimJsonNativePointInterpretation(
    extraHidden,
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
  );
  assertClosedEnvelope(hiddenKeys, 'outside_contract');
  assert.deepEqual(hiddenKeys.reasonCodes, ['input_invalid']);

  const symbolKeys = eventOccurrenceAssertion();
  Object.defineProperty(symbolKeys, Symbol('extra'), { value: true });
  const symbolResult = inspectScenarioClaimJsonNativePointInterpretation(
    symbolKeys,
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
  );
  assertClosedEnvelope(symbolResult, 'outside_contract');
  assert.deepEqual(symbolResult.reasonCodes, ['input_invalid']);

  const throwingGetter = {
    ...eventOccurrenceAssertion(),
    get event() {
      throw new Error('getter');
    },
  };
  const throwing = inspectScenarioClaimJsonNativePointInterpretation(
    throwingGetter,
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
  );
  assertClosedEnvelope(throwing, 'outside_contract');
  assert.deepEqual(throwing.reasonCodes, ['input_invalid']);

  const changingGetter = {
    id: 'eventOccurrence-assertion',
    kind: 'eventOccurrence',
    authority: authority(),
  };
  let reads = 0;
  Object.defineProperty(changingGetter, 'event', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'journey_completed' : 'changed';
    },
  });
  const changing = inspectScenarioClaimJsonNativePointInterpretation(
    changingGetter,
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
  );
  assertClosedEnvelope(changing, 'outside_contract');
  assert.deepEqual(changing.reasonCodes, ['input_invalid']);

  const proxy = new Proxy(eventOccurrenceAssertion(), {
    ownKeys() {
      throw new Error('ownKeys');
    },
  });
  const proxyResult = inspectScenarioClaimJsonNativePointInterpretation(
    proxy,
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
  );
  assertClosedEnvelope(proxyResult, 'outside_contract');
  assert.deepEqual(proxyResult.reasonCodes, ['input_invalid']);
});

test('null-prototype records with exact own data properties are valid', () => {
  const assertion = Object.assign(Object.create(null), eventOccurrenceAssertion());
  assertion.authority = Object.assign(Object.create(null), authority());
  const admitted = Object.assign(Object.create(null), eventOccurrenceAdmitted([
    { event: 'journey_completed', atMs: 1 },
  ]));
  admitted.artifact = Object.assign(Object.create(null), admitted.artifact);
  admitted.observation = Object.assign(Object.create(null), admitted.observation);
  admitted.observation.occurrences = [
    Object.assign(Object.create(null), { event: 'journey_completed', atMs: 1 }),
  ];
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(assertion, admitted);
  assertClosedEnvelope(inspection, 'interpreted');
  assertSupportedShape(inspection.result);
});

test('does not mutate source objects and detaches output', () => {
  const assertion = eventOccurrenceAssertion();
  const admitted = eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 12.5 }]);
  const assertionSnapshot = clone(assertion);
  const admittedSnapshot = clone(admitted);
  const inspection = inspectScenarioClaimJsonNativePointInterpretation(assertion, admitted);
  assert.deepEqual(assertion, assertionSnapshot);
  assert.deepEqual(admitted, admittedSnapshot);
  inspection.result.expected.event = 'mutated';
  inspection.result.evidenceReferences[0].path = 'mutated';
  inspection.result.observed.event = 'mutated';
  assert.equal(assertion.event, 'journey_completed');
  assert.equal(admitted.artifact.path, 'raw/eventOccurrence.json');
  assert.equal(admitted.observation.occurrences[0].event, 'journey_completed');

  assertion.event = 'after';
  admitted.observation.occurrences[0].event = 'after';
  admitted.artifact.path = 'after';
  const second = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 12.5 }]),
  );
  assert.equal(second.result.observed.matchedEvidence, 'journey_completed@12.5');
});

test('closed output keys stay within interpretation envelope', () => {
  const interpreted = inspectScenarioClaimJsonNativePointInterpretation(
    eventOccurrenceAssertion(),
    eventOccurrenceAdmitted([{ event: 'journey_completed', atMs: 1 }]),
  );
  assertClosedEnvelope(interpreted, 'interpreted');
  assertNoForbiddenVocabulary(interpreted);

  const outside = inspectScenarioClaimJsonNativePointInterpretation(undefined, undefined);
  assertClosedEnvelope(outside, 'outside_contract');
  assertNoForbiddenVocabulary(outside);
});
