const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,
  CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,
  inspectScenarioClaimRawObservationAdmission,
} = require('../claim-raw-observation-admission');

type JsonRecord = Record<string, any>;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const WINDOW = {
  from: 'journey-start',
  to: 'journey-terminal',
  completeSourceRequired: true,
};

function bytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function candidate(
  assertionKind = 'eventOccurrence',
  artifactBytes: Uint8Array = bytes(eventOccurrence()),
): JsonRecord {
  const common = {
    schemaVersion: '1.0.0',
    candidateId: `${assertionKind}-candidate`,
    runIdentityHash: SHA_A,
    claimId: 'journey-completes',
    claimHash: SHA_B,
    assertionId: `${assertionKind}-assertion`,
    assertionKind,
    authority: {
      declarationId: 'app-authority',
      role: 'app',
      producerId: 'app-profile-session',
      evidenceSelector: `observations.${assertionKind}`,
      producerVersion: '1.0.0',
      producerSha256: SHA_A,
      strength: 'verified',
      completeness: assertionKind === 'boundedCount' || assertionKind === 'absence'
        ? 'bounded'
        : 'point',
    },
    captureStatus: 'produced',
    evidence: {
      path: `raw/${assertionKind}.json`,
      sha256: sha256(artifactBytes),
    },
    cleanupStatus: 'finalized',
    redactionStatus: 'redacted',
  };
  if (assertionKind === 'boundedCount' || assertionKind === 'absence') {
    return { ...common, observationWindow: clone(WINDOW) };
  }
  if (assertionKind === 'validatedEvidence') {
    return {
      ...common,
      artifactKind: 'video',
      validationContract: 'media-validation-v1',
    };
  }
  return common;
}

function eventOccurrence(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    kind: 'eventOccurrence',
    occurrences: [{ event: 'journey_completed', atMs: 12.5 }],
  };
}

function eventOrder(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    kind: 'eventOrder',
    occurrences: [
      { event: 'journey_started', atMs: 1 },
      { event: 'journey_completed', atMs: 12 },
    ],
  };
}

function terminalState(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    kind: 'terminalState',
    observations: [{ path: 'screen.state', value: 'ready', atMs: 14 }],
  };
}

function boundedCount(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    kind: 'boundedCount',
    selector: 'rendered.items',
    count: 4,
    observationWindow: clone(WINDOW),
  };
}

function absence(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    kind: 'absence',
    selector: 'fatal.errors',
    count: 0,
    observationWindow: clone(WINDOW),
  };
}

test('admits exact bytes for every JSON-native observation kind', () => {
  const cases: Array<[string, JsonRecord]> = [
    ['eventOccurrence', eventOccurrence()],
    ['eventOrder', eventOrder()],
    ['terminalState', terminalState()],
    ['boundedCount', boundedCount()],
    ['absence', absence()],
  ];
  for (const [kind, observation] of cases) {
    const artifactBytes = bytes(observation);
    const result = inspectScenarioClaimRawObservationAdmission({
      candidate: candidate(kind, artifactBytes),
      artifactBytes,
    });
    assert.equal(result.contractVersion, CLAIM_RAW_OBSERVATION_ADMISSION_VERSION);
    assert.equal(result.status, 'admitted');
    assert.equal(result.assertionKind, kind);
    assert.equal(result.artifact.sha256, sha256(artifactBytes));
    assert.equal(result.artifact.byteLength, artifactBytes.byteLength);
    assert.deepEqual(result.observation, observation);
  }
});

test('preserves occurrence order and admits empty observation arrays', () => {
  const ordered = eventOrder();
  ordered.occurrences.push({ event: 'cleanup_completed', atMs: 13 });
  const orderedBytes = bytes(ordered);
  const orderedResult = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOrder', orderedBytes),
    artifactBytes: orderedBytes,
  });
  assert.equal(orderedResult.status, 'admitted');
  assert.deepEqual(
    orderedResult.observation.occurrences.map((item: JsonRecord) => item.event),
    ['journey_started', 'journey_completed', 'cleanup_completed'],
  );

  for (const observation of [
    { schemaVersion: '1.0.0', kind: 'eventOccurrence', occurrences: [] },
    { schemaVersion: '1.0.0', kind: 'terminalState', observations: [] },
  ]) {
    const artifactBytes = bytes(observation);
    const result = inspectScenarioClaimRawObservationAdmission({
      candidate: candidate(observation.kind, artifactBytes),
      artifactBytes,
    });
    assert.equal(result.status, 'admitted');
  }
});

test('blocks an exact-byte mismatch before attempting JSON decoding', () => {
  const artifactBytes = Buffer.from('not-json', 'utf8');
  const expectedBytes = bytes(eventOccurrence());
  const result = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', expectedBytes),
    artifactBytes,
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.reasonCodes, ['artifact_hash_mismatch']);
  assert.equal(result.nextAction, 'supply_exact_artifact_bytes');
  assert.equal(result.artifact.expectedSha256, sha256(expectedBytes));
  assert.equal(result.artifact.observedSha256, sha256(artifactBytes));
});

test('fails closed for invalid UTF-8 and malformed JSON with matching hashes', () => {
  const invalidUtf8 = Uint8Array.from([0xc3, 0x28]);
  const utf8Result = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', invalidUtf8),
    artifactBytes: invalidUtf8,
  });
  assert.equal(utf8Result.status, 'blocked');
  assert.deepEqual(utf8Result.reasonCodes, ['invalid_utf8']);

  const malformed = Buffer.from('{"schemaVersion":', 'utf8');
  const jsonResult = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', malformed),
    artifactBytes: malformed,
  });
  assert.equal(jsonResult.status, 'blocked');
  assert.deepEqual(jsonResult.reasonCodes, ['invalid_json']);
});

test('rejects wrong schema versions, kinds, and unknown keys', () => {
  const cases: Array<[JsonRecord, string]> = [
    [{ ...eventOccurrence(), schemaVersion: '2.0.0' }, 'observation_schema_version_mismatch'],
    [{ ...eventOccurrence(), kind: 'eventOrder' }, 'observation_kind_mismatch'],
    [{ ...eventOccurrence(), unexpected: true }, 'observation_shape_invalid'],
    [{
      ...eventOccurrence(),
      occurrences: [{ event: 'journey_completed', atMs: 1, unexpected: true }],
    }, 'observation_shape_invalid'],
  ];
  for (const [observation, reason] of cases) {
    const artifactBytes = bytes(observation);
    const result = inspectScenarioClaimRawObservationAdmission({
      candidate: candidate('eventOccurrence', artifactBytes),
      artifactBytes,
    });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.reasonCodes, [reason]);
  }
});

test('rejects invalid observation strings and numeric values', () => {
  const invalidJsonTexts = [
    JSON.stringify({ ...eventOccurrence(), occurrences: [{ event: '', atMs: 1 }] }),
    JSON.stringify({ ...eventOccurrence(), occurrences: [{ event: 'ready', atMs: -1 }] }),
    '{"schemaVersion":"1.0.0","kind":"eventOccurrence","occurrences":[{"event":"ready","atMs":1e400}]}',
    JSON.stringify({ ...terminalState(), observations: [{ path: '', value: true, atMs: 1 }] }),
    JSON.stringify({ ...terminalState(), observations: [{ path: 'state', value: { bad: true }, atMs: 1 }] }),
    JSON.stringify({ ...boundedCount(), count: -1 }),
    JSON.stringify({ ...boundedCount(), count: 1.5 }),
    JSON.stringify({ ...boundedCount(), selector: '' }),
  ];
  for (const text of invalidJsonTexts) {
    const artifactBytes = Buffer.from(text, 'utf8');
    const parsed = JSON.parse(text);
    const kind = parsed.kind;
    const result = inspectScenarioClaimRawObservationAdmission({
      candidate: candidate(kind, artifactBytes),
      artifactBytes,
    });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.reasonCodes, ['observation_shape_invalid']);
  }
});

test('blocks bounded and absence observations with mismatched windows', () => {
  for (const observation of [boundedCount(), absence()]) {
    observation.observationWindow.to = 'different-terminal';
    const artifactBytes = bytes(observation);
    const result = inspectScenarioClaimRawObservationAdmission({
      candidate: candidate(observation.kind, artifactBytes),
      artifactBytes,
    });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.reasonCodes, ['observation_window_mismatch']);
    assert.equal(result.nextAction, 'align_observation_window');
  }
});

test('validated evidence is unsupported only after exact bytes bind', () => {
  const artifactBytes = bytes({ opaque: 'validator-report' });
  const unsupported = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('validatedEvidence', artifactBytes),
    artifactBytes,
  });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.reasonCode, 'validated_evidence_report_identity_undefined');
  assert.equal(unsupported.nextAction, 'define_validated_evidence_report_identity');
  assert.equal(JSON.stringify(unsupported).includes('not_applicable'), false);

  const mismatch = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('validatedEvidence', bytes({ opaque: 'other' })),
    artifactBytes,
  });
  assert.equal(mismatch.status, 'blocked');
  assert.deepEqual(mismatch.reasonCodes, ['artifact_hash_mismatch']);
});

test('rejects malformed input and non-eligible candidate projections', () => {
  const artifactBytes = bytes(eventOccurrence());
  const valid = candidate('eventOccurrence', artifactBytes);
  const malformedCandidates = [
    { ...valid, captureStatus: 'partial' },
    { ...valid, cleanupStatus: 'incomplete' },
    { ...valid, evidence: { ...valid.evidence, path: '../secret.json' } },
    { ...valid, evidence: { ...valid.evidence, sha256: 'INVALID' } },
    { ...valid, authority: { ...valid.authority, role: 'product' } },
    { ...valid, authority: { ...valid.authority, unknown: true } },
    { ...valid, unknown: true },
  ];
  for (const malformedCandidate of malformedCandidates) {
    const result = inspectScenarioClaimRawObservationAdmission({
      candidate: malformedCandidate,
      artifactBytes,
    });
    assert.equal(result.status, 'outside_contract');
    assert.deepEqual(result.reasonCodes, ['candidate_not_eligible']);
  }

  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission(null).reasonCodes,
    ['input_invalid'],
  );
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission({ candidate: valid, artifactBytes: 'bytes' }).reasonCodes,
    ['artifact_bytes_invalid'],
  );
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission({
      candidate: { ...valid, captureStatus: 'partial' },
      artifactBytes: 'bytes',
    }).reasonCodes,
    ['candidate_not_eligible', 'artifact_bytes_invalid'],
  );
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission({ candidate: valid, artifactBytes, extra: true }).reasonCodes,
    ['input_invalid'],
  );
});

test('returns detached candidate identity and observation projections', () => {
  const observation = eventOrder();
  const artifactBytes = bytes(observation);
  const eligibleCandidate = candidate('eventOrder', artifactBytes);
  const result = inspectScenarioClaimRawObservationAdmission({
    candidate: eligibleCandidate,
    artifactBytes,
  });
  assert.equal(result.status, 'admitted');

  eligibleCandidate.candidateId = 'mutated-candidate';
  eligibleCandidate.evidence.path = 'raw/mutated.json';
  artifactBytes[0] = 0;
  observation.occurrences[0].event = 'mutated-event';

  assert.equal(result.candidateId, 'eventOrder-candidate');
  assert.equal(result.artifact.path, 'raw/eventOrder.json');
  assert.equal(result.observation.occurrences[0].event, 'journey_started');
});

test('snapshots bytes and fails closed for throwing untrusted accessors', () => {
  const observation = eventOccurrence();
  const artifactBytes = bytes(observation);
  const result = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', artifactBytes),
    artifactBytes,
  });
  assert.equal(result.status, 'admitted');
  artifactBytes.fill(0);
  assert.equal(result.artifact.sha256, sha256(bytes(observation)));
  assert.equal(result.observation.occurrences[0].event, 'journey_completed');

  const hostileInput = Object.defineProperty({}, 'candidate', {
    enumerable: true,
    get() { throw new Error('untrusted getter'); },
  });
  Object.defineProperty(hostileInput, 'artifactBytes', {
    enumerable: true,
    value: bytes(observation),
  });
  assert.doesNotThrow(() => inspectScenarioClaimRawObservationAdmission(hostileInput));
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission(hostileInput).reasonCodes,
    ['input_invalid'],
  );

  const iteratorSubstitution = bytes(observation);
  Object.defineProperty(iteratorSubstitution, Symbol.iterator, {
    value: function* () { yield 0; },
  });
  const iteratorResult = inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', bytes(observation)),
    artifactBytes: iteratorSubstitution,
  });
  assert.equal(iteratorResult.status, 'admitted');

  const throwingIterator = bytes(observation);
  Object.defineProperty(throwingIterator, Symbol.iterator, {
    value: function* () { throw new Error('hostile iterator'); },
  });
  assert.doesNotThrow(() => inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', bytes(observation)),
    artifactBytes: throwingIterator,
  }));
  assert.equal(
    inspectScenarioClaimRawObservationAdmission({
      candidate: candidate('eventOccurrence', bytes(observation)),
      artifactBytes: throwingIterator,
    }).status,
    'admitted',
  );

  const proxyBytes = new Proxy(bytes(observation), {
    get(target, property) {
      if (property === Symbol.iterator) {
        return function* () { yield* bytes(observation); };
      }
      return Reflect.get(target, property, target);
    },
  });
  assert.equal(proxyBytes instanceof Uint8Array, true);
  assert.equal(ArrayBuffer.isView(proxyBytes), false);
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission({
      candidate: candidate('eventOccurrence', bytes(observation)),
      artifactBytes: proxyBytes,
    }).reasonCodes,
    ['artifact_bytes_invalid'],
  );

  const prototypeSpoof = Object.create(Uint8Array.prototype);
  assert.equal(prototypeSpoof instanceof Uint8Array, true);
  assert.equal(ArrayBuffer.isView(prototypeSpoof), false);
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission({
      candidate: candidate('eventOccurrence', bytes(observation)),
      artifactBytes: prototypeSpoof,
    }).reasonCodes,
    ['artifact_bytes_invalid'],
  );

  const originalBytes = bytes(observation);
  const detachedBuffer = new ArrayBuffer(originalBytes.byteLength);
  const detachedBytes = new Uint8Array(detachedBuffer);
  detachedBytes.set(originalBytes);
  structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
  assert.doesNotThrow(() => inspectScenarioClaimRawObservationAdmission({
    candidate: candidate('eventOccurrence', bytes(observation)),
    artifactBytes: detachedBytes,
  }));
  assert.deepEqual(
    inspectScenarioClaimRawObservationAdmission({
      candidate: candidate('eventOccurrence', bytes(observation)),
      artifactBytes: detachedBytes,
    }).reasonCodes,
    ['artifact_bytes_invalid'],
  );
});

test('exports stable reader and observation versions', () => {
  assert.equal(CLAIM_RAW_OBSERVATION_ADMISSION_VERSION, '1.0.0');
  assert.equal(CLAIM_RAW_OBSERVATION_SCHEMA_VERSION, '1.0.0');
});
