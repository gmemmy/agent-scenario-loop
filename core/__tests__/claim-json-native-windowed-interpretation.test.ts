const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION,
  inspectScenarioClaimJsonNativeWindowedInterpretation,
} = require('../claim-json-native-windowed-interpretation');

type JsonRecord = Record<string, any>;

const SHA_A = 'a'.repeat(64);
const FORBIDDEN_VOCABULARY = [
  'health',
  'ClaimResult',
  'verdict',
  'eventOccurrence',
  'eventOrder',
  'terminalState',
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

function observationWindow(): JsonRecord {
  return {
    from: 't0',
    to: 't1',
    completeSourceRequired: true,
  };
}

function windowedAuthority(completeness: 'bounded' | 'continuous-complete' = 'bounded'): JsonRecord {
  return {
    role: 'app',
    producerId: 'app-profile-session',
    evidenceSelector: 'observations.windowed',
    requiredStrength: 'verified',
    completeness,
  };
}

function boundedCountAssertion(bounds: JsonRecord = { minimum: 1, maximum: 3 }): JsonRecord {
  return {
    id: 'boundedCount-assertion',
    kind: 'boundedCount',
    selector: 'errors',
    observationWindow: observationWindow(),
    authority: windowedAuthority(),
    ...bounds,
  };
}

function absenceAssertion(): JsonRecord {
  return {
    id: 'absence-assertion',
    kind: 'absence',
    selector: 'errors',
    observationWindow: observationWindow(),
    authority: windowedAuthority('continuous-complete'),
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

function windowedAdmitted(kind: 'boundedCount' | 'absence', count: number, extra: JsonRecord = {}): JsonRecord {
  return admittedBase(kind, {
    schemaVersion: '1.0.0',
    kind,
    selector: 'errors',
    count,
    observationWindow: observationWindow(),
    ...extra,
  });
}

function assertClosedEnvelope(
  result: JsonRecord,
  status: 'outside_contract' | 'interpreted',
): void {
  assert.equal(result.contractVersion, CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION);
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

test('supports min-only equality and values above the inclusive minimum', () => {
  for (const count of [2, 3]) {
    const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
      boundedCountAssertion({ minimum: 2 }),
      windowedAdmitted('boundedCount', count),
    );
    assertClosedEnvelope(inspection, 'interpreted');
    assertSupportedShape(inspection.result);
    assert.deepEqual(inspection.result.expected, {
      selector: 'errors',
      observationWindow: observationWindow(),
      minimum: 2,
    });
    assert.deepEqual(inspection.result.observed, { selector: 'errors', count });
    assertEvidenceCopied(inspection.result, 'boundedCount');
    assertNoForbiddenVocabulary(inspection);
  }
});

test('supports max-only equality and values below the inclusive maximum', () => {
  for (const count of [0, 2]) {
    const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
      boundedCountAssertion({ maximum: 2 }),
      windowedAdmitted('boundedCount', count),
    );
    assertClosedEnvelope(inspection, 'interpreted');
    assertSupportedShape(inspection.result);
    assert.deepEqual(inspection.result.expected, {
      selector: 'errors',
      observationWindow: observationWindow(),
      maximum: 2,
    });
    assert.deepEqual(inspection.result.observed, { selector: 'errors', count });
  }
});

test('supports inclusive both-bound values including the endpoints', () => {
  for (const count of [1, 2, 3]) {
    const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
      boundedCountAssertion({ minimum: 1, maximum: 3 }),
      windowedAdmitted('boundedCount', count),
    );
    assertClosedEnvelope(inspection, 'interpreted');
    assertSupportedShape(inspection.result);
    assert.deepEqual(inspection.result.observed, { selector: 'errors', count });
  }
});

test('rejects boundedCount below the inclusive minimum', () => {
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 2 }),
    windowedAdmitted('boundedCount', 1),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertRejectedShape(inspection.result);
  assert.deepEqual(inspection.result.observed, { selector: 'errors', count: 1 });
  assert.deepEqual(inspection.result.rejectedEvidence, ['errors=1']);
  assertEvidenceCopied(inspection.result, 'boundedCount');
});

test('rejects boundedCount above the inclusive maximum', () => {
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ maximum: 2 }),
    windowedAdmitted('boundedCount', 3),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertRejectedShape(inspection.result);
  assert.deepEqual(inspection.result.observed, { selector: 'errors', count: 3 });
  assert.deepEqual(inspection.result.rejectedEvidence, ['errors=3']);
  assertEvidenceCopied(inspection.result, 'boundedCount');
});

test('supports absence when the admitted count is zero', () => {
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    absenceAssertion(),
    windowedAdmitted('absence', 0),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertSupportedShape(inspection.result);
  assert.deepEqual(inspection.result.expected, {
    selector: 'errors',
    observationWindow: observationWindow(),
  });
  assert.deepEqual(inspection.result.observed, { selector: 'errors', count: 0 });
  assertEvidenceCopied(inspection.result, 'absence');
  assertNoForbiddenVocabulary(inspection);
});

test('rejects absence when the admitted count is positive', () => {
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    absenceAssertion(),
    windowedAdmitted('absence', 2),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertRejectedShape(inspection.result);
  assert.deepEqual(inspection.result.observed, { selector: 'errors', count: 2 });
  assert.deepEqual(inspection.result.rejectedEvidence, ['errors=2']);
});

test('point completeness is outside_contract because WindowedClaimAuthority excludes it', () => {
  // incomplete_observation_window is reserved for product not_evaluable, but a
  // point completeness cannot be represented on BoundedCountAssertion or
  // AbsenceAssertion, so this interpreter classifies it as outside-contract.
  const assertion = boundedCountAssertion({ minimum: 0 });
  assertion.authority = windowedAuthority();
  assertion.authority.completeness = 'point';
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    assertion,
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(inspection, 'outside_contract');
  assert.deepEqual(inspection.reasonCodes, ['input_invalid']);
});

test('rejects malformed input, identity mismatch, and kind mismatch as outside_contract', () => {
  const malformedCases: Array<[unknown, unknown]> = [
    [null, undefined],
    [42, windowedAdmitted('boundedCount', 1)],
    [boundedCountAssertion(), 'admitted'],
    [[], {}],
    [{ ...boundedCountAssertion(), kind: 'eventOccurrence' }, windowedAdmitted('boundedCount', 1)],
    [boundedCountAssertion(), { ...windowedAdmitted('boundedCount', 1), status: 'blocked' }],
    [
      { ...boundedCountAssertion(), extra: true },
      windowedAdmitted('boundedCount', 1),
    ],
  ];
  for (const [assertion, admitted] of malformedCases) {
    const malformed = inspectScenarioClaimJsonNativeWindowedInterpretation(assertion, admitted);
    assertClosedEnvelope(malformed, 'outside_contract');
    assert.ok(malformed.reasonCodes.includes('input_invalid'));
    assertNoForbiddenVocabulary(malformed);
  }

  const identity = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 1 }),
    {
      ...windowedAdmitted('boundedCount', 1),
      assertionId: 'other',
    },
  );
  assertClosedEnvelope(identity, 'outside_contract');
  assert.deepEqual(identity.reasonCodes, ['assertion_identity_mismatch']);

  const kindMismatch = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 0 }),
    {
      ...windowedAdmitted('absence', 0),
      assertionId: 'boundedCount-assertion',
    },
  );
  assertClosedEnvelope(kindMismatch, 'outside_contract');
  assert.deepEqual(kindMismatch.reasonCodes, [
    'assertion_kind_mismatch',
    'observation_kind_mismatch',
  ]);

  const observationKind = windowedAdmitted('boundedCount', 1);
  observationKind.observation = {
    schemaVersion: '1.0.0',
    kind: 'absence',
    selector: 'errors',
    count: 0,
    observationWindow: observationWindow(),
  };
  const observationMismatch = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 0 }),
    observationKind,
  );
  assertClosedEnvelope(observationMismatch, 'outside_contract');
  assert.deepEqual(observationMismatch.reasonCodes, ['observation_kind_mismatch']);

  const selectorMismatch = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 0 }),
    {
      ...windowedAdmitted('boundedCount', 0),
      observation: {
        schemaVersion: '1.0.0',
        kind: 'boundedCount',
        selector: 'other',
        count: 0,
        observationWindow: observationWindow(),
      },
    },
  );
  assertClosedEnvelope(selectorMismatch, 'outside_contract');
  assert.deepEqual(selectorMismatch.reasonCodes, ['selector_mismatch']);

  const windowMismatch = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 0 }),
    {
      ...windowedAdmitted('boundedCount', 0),
      observation: {
        schemaVersion: '1.0.0',
        kind: 'boundedCount',
        selector: 'errors',
        count: 0,
        observationWindow: { from: 't0', to: 't9', completeSourceRequired: true },
      },
    },
  );
  assertClosedEnvelope(windowMismatch, 'outside_contract');
  assert.deepEqual(windowMismatch.reasonCodes, ['observation_window_mismatch']);
});

test('boundedCount without bounds, inverted bounds, or incomplete window is input_invalid', () => {
  const neitherBound = inspectScenarioClaimJsonNativeWindowedInterpretation(
    {
      id: 'boundedCount-assertion',
      kind: 'boundedCount',
      selector: 'errors',
      observationWindow: observationWindow(),
      authority: windowedAuthority(),
    },
    windowedAdmitted('boundedCount', 1),
  );
  assertClosedEnvelope(neitherBound, 'outside_contract');
  assert.deepEqual(neitherBound.reasonCodes, ['input_invalid']);

  const invertedBounds = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 3, maximum: 1 }),
    windowedAdmitted('boundedCount', 2),
  );
  assertClosedEnvelope(invertedBounds, 'outside_contract');
  assert.deepEqual(invertedBounds.reasonCodes, ['input_invalid']);

  const incompleteWindow = inspectScenarioClaimJsonNativeWindowedInterpretation(
    {
      ...boundedCountAssertion({ minimum: 0 }),
      observationWindow: { from: 't0', to: 't1', completeSourceRequired: false },
    },
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(incompleteWindow, 'outside_contract');
  assert.deepEqual(incompleteWindow.reasonCodes, ['input_invalid']);
});

test('hostile unknown-input gates fail closed as input_invalid', () => {
  const extraHidden = boundedCountAssertion({ minimum: 0 });
  Object.defineProperty(extraHidden, 'hidden', {
    value: true,
    enumerable: false,
  });
  const hiddenKeys = inspectScenarioClaimJsonNativeWindowedInterpretation(
    extraHidden,
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(hiddenKeys, 'outside_contract');
  assert.deepEqual(hiddenKeys.reasonCodes, ['input_invalid']);

  const symbolKeys = boundedCountAssertion({ minimum: 0 });
  Object.defineProperty(symbolKeys, Symbol('extra'), { value: true });
  const symbolResult = inspectScenarioClaimJsonNativeWindowedInterpretation(
    symbolKeys,
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(symbolResult, 'outside_contract');
  assert.deepEqual(symbolResult.reasonCodes, ['input_invalid']);

  const throwingGetter = {
    ...boundedCountAssertion({ minimum: 0 }),
    get selector() {
      throw new Error('getter');
    },
  };
  const throwing = inspectScenarioClaimJsonNativeWindowedInterpretation(
    throwingGetter,
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(throwing, 'outside_contract');
  assert.deepEqual(throwing.reasonCodes, ['input_invalid']);

  const changingGetter = {
    id: 'boundedCount-assertion',
    kind: 'boundedCount',
    authority: windowedAuthority(),
    observationWindow: observationWindow(),
    minimum: 0,
  };
  let reads = 0;
  Object.defineProperty(changingGetter, 'selector', {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? 'errors' : 'changed';
    },
  });
  const changing = inspectScenarioClaimJsonNativeWindowedInterpretation(
    changingGetter,
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(changing, 'outside_contract');
  assert.deepEqual(changing.reasonCodes, ['input_invalid']);

  const proxy = new Proxy(boundedCountAssertion({ minimum: 0 }), {
    ownKeys() {
      throw new Error('ownKeys');
    },
  });
  const proxyResult = inspectScenarioClaimJsonNativeWindowedInterpretation(
    proxy,
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(proxyResult, 'outside_contract');
  assert.deepEqual(proxyResult.reasonCodes, ['input_invalid']);
});

test('null-prototype records with exact own data properties are valid', () => {
  const assertion = Object.assign(Object.create(null), boundedCountAssertion({ minimum: 0, maximum: 1 }));
  assertion.authority = Object.assign(Object.create(null), windowedAuthority());
  assertion.observationWindow = Object.assign(Object.create(null), observationWindow());
  const admitted = Object.assign(Object.create(null), windowedAdmitted('boundedCount', 1));
  admitted.artifact = Object.assign(Object.create(null), admitted.artifact);
  admitted.observation = Object.assign(Object.create(null), admitted.observation);
  admitted.observation.observationWindow = Object.assign(
    Object.create(null),
    admitted.observation.observationWindow,
  );
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(assertion, admitted);
  assertClosedEnvelope(inspection, 'interpreted');
  assertSupportedShape(inspection.result);
});

test('does not mutate source objects and detaches output', () => {
  const assertion = boundedCountAssertion({ minimum: 1, maximum: 3 });
  const admitted = windowedAdmitted('boundedCount', 2);
  const assertionSnapshot = clone(assertion);
  const admittedSnapshot = clone(admitted);
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(assertion, admitted);
  assert.deepEqual(assertion, assertionSnapshot);
  assert.deepEqual(admitted, admittedSnapshot);
  inspection.result.expected.selector = 'mutated';
  inspection.result.evidenceReferences[0].path = 'mutated';
  inspection.result.observed.selector = 'mutated';
  inspection.result.expected.observationWindow.from = 'mutated';
  assert.equal(assertion.selector, 'errors');
  assert.equal(admitted.artifact.path, 'raw/boundedCount.json');
  assert.equal(admitted.observation.selector, 'errors');
  assert.equal(assertion.observationWindow.from, 't0');

  assertion.selector = 'after';
  admitted.observation.selector = 'after';
  admitted.artifact.path = 'after';
  const second = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 1, maximum: 3 }),
    windowedAdmitted('boundedCount', 2),
  );
  assert.equal(second.result.observed.selector, 'errors');
  assert.equal(second.result.evidenceReferences[0].path, 'raw/boundedCount.json');
});

test('closed output keys stay within interpretation envelope', () => {
  const interpreted = inspectScenarioClaimJsonNativeWindowedInterpretation(
    absenceAssertion(),
    windowedAdmitted('absence', 0),
  );
  assertClosedEnvelope(interpreted, 'interpreted');
  assertNoForbiddenVocabulary(interpreted);

  const outside = inspectScenarioClaimJsonNativeWindowedInterpretation(undefined, undefined);
  assertClosedEnvelope(outside, 'outside_contract');
  assertNoForbiddenVocabulary(outside);
});

test('non-negative unsafe integers are outside_contract for bounds, counts, and artifact byteLength', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;

  const unsafeMinimum = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: unsafe }),
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(unsafeMinimum, 'outside_contract');
  assert.deepEqual(unsafeMinimum.reasonCodes, ['input_invalid']);

  const unsafeMaximum = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ maximum: unsafe }),
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(unsafeMaximum, 'outside_contract');
  assert.deepEqual(unsafeMaximum.reasonCodes, ['input_invalid']);

  const unsafeCount = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 0 }),
    windowedAdmitted('boundedCount', unsafe),
  );
  assertClosedEnvelope(unsafeCount, 'outside_contract');
  assert.deepEqual(unsafeCount.reasonCodes, ['input_invalid']);

  const admitted = windowedAdmitted('boundedCount', 0);
  admitted.artifact = { ...admitted.artifact, byteLength: unsafe };
  const unsafeByteLength = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ minimum: 0 }),
    admitted,
  );
  assertClosedEnvelope(unsafeByteLength, 'outside_contract');
  assert.deepEqual(unsafeByteLength.reasonCodes, ['input_invalid']);
  assertNoForbiddenVocabulary(unsafeByteLength);
});

test('safe integer bounds and counts remain interpretable at Number.MAX_SAFE_INTEGER', () => {
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    boundedCountAssertion({ maximum: Number.MAX_SAFE_INTEGER }),
    windowedAdmitted('boundedCount', Number.MAX_SAFE_INTEGER),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertSupportedShape(inspection.result);
  assert.deepEqual(inspection.result.observed, {
    selector: 'errors',
    count: Number.MAX_SAFE_INTEGER,
  });
});

test('parsed windowed authority is structurally required but not rematched here', () => {
  const observedAuthority = windowedAuthority();
  observedAuthority.requiredStrength = 'observed';
  const inspection = inspectScenarioClaimJsonNativeWindowedInterpretation(
    { ...boundedCountAssertion({ minimum: 0 }), authority: observedAuthority },
    windowedAdmitted('boundedCount', 0),
  );
  assertClosedEnvelope(inspection, 'interpreted');
  assertSupportedShape(inspection.result);

  const rejectedObserved = inspectScenarioClaimJsonNativeWindowedInterpretation(
    {
      ...absenceAssertion(),
      authority: {
        ...windowedAuthority('continuous-complete'),
        requiredStrength: 'observed',
      },
    },
    windowedAdmitted('absence', 1),
  );
  assertClosedEnvelope(rejectedObserved, 'interpreted');
  assertRejectedShape(rejectedObserved.result);
  assert.equal(rejectedObserved.result.reasonCode, 'authoritative_evidence_rejected');
  assertNoForbiddenVocabulary(rejectedObserved);
});
