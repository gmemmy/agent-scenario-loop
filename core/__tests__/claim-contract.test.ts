const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  LEGACY_SCENARIO_SCHEMA_VERSION,
  assertScenarioExecutionContractSupported,
  buildScenarioClaimHash,
  canonicalizeClaimValue,
} = require('../claim-contract');

function sampleClaim() {
  return {
    id: 'journey-completes',
    role: 'mandatory',
    applicability: {
      platforms: ['ios', 'android'],
    },
    closes: {
      phases: ['complete-journey'],
      terminalInvariants: ['terminal-state-reconciled'],
    },
    assertions: [
      {
        id: 'completion-event',
        kind: 'eventOccurrence',
        event: 'journey_completed',
        authority: {
          role: 'app',
          producerId: 'app-profile-session',
          evidenceSelector: 'profileEvents.journey_completed',
          requiredStrength: 'observed',
          completeness: 'point',
        },
      },
    ],
  };
}

test('exports additive and legacy claim contract versions', () => {
  assert.equal(CLAIM_CONTRACT_SCHEMA_VERSION, '1.1.0');
  assert.equal(LEGACY_SCENARIO_SCHEMA_VERSION, '1.0.0');
});

test('canonicalizes claim object keys without reordering authored arrays', () => {
  assert.equal(
    canonicalizeClaimValue({ z: [2, 1], a: { y: true, x: 'value' } }),
    '{"a":{"x":"value","y":true},"z":[2,1]}',
  );
});

test('canonicalizes object keys with locale-independent code-unit ordering', () => {
  assert.equal(
    canonicalizeClaimValue({ z: true, Z: true, a: true, A: true }),
    '{"A":true,"Z":true,"a":true,"z":true}',
  );
});

test('builds the same claim hash for equivalent object-key order', () => {
  const claim = sampleClaim();
  const reordered = {
    assertions: claim.assertions,
    closes: claim.closes,
    applicability: claim.applicability,
    role: claim.role,
    id: claim.id,
  };

  assert.equal(buildScenarioClaimHash(claim), buildScenarioClaimHash(reordered));
  assert.match(buildScenarioClaimHash(claim), /^[a-f0-9]{64}$/u);
});

test('claim hash preserves authored assertion order', () => {
  const claim = sampleClaim();
  const secondAssertion = {
    ...claim.assertions[0],
    id: 'second-assertion',
    event: 'journey_rendered',
  };
  const first = { ...claim, assertions: [claim.assertions[0], secondAssertion] };
  const second = { ...claim, assertions: [secondAssertion, claim.assertions[0]] };

  assert.notEqual(buildScenarioClaimHash(first), buildScenarioClaimHash(second));
});

test('rejects values that cannot be represented truthfully in JSON', () => {
  assert.throws(() => canonicalizeClaimValue(Number.NaN), /non-finite/u);
  assert.throws(() => canonicalizeClaimValue({ missing: undefined }), /cannot be undefined/u);
  assert.throws(() => canonicalizeClaimValue(Symbol('claim')), /symbol/u);
  assert.throws(() => canonicalizeClaimValue(new Date(0)), /only JSON objects and arrays/u);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalizeClaimValue(cyclic), /cyclic/u);
});

test('refuses claim-complete scenarios at the legacy execution boundary', () => {
  assert.doesNotThrow(() => assertScenarioExecutionContractSupported({ schemaVersion: '1.0.0' }));
  assert.throws(
    () => assertScenarioExecutionContractSupported({ schemaVersion: '1.1.0' }),
    /reader-only.*execution is unsupported/u,
  );
  assert.throws(
    () => assertScenarioExecutionContractSupported({ schemaVersion: '1.0.0', claims: [] }),
    /claim-complete fields claims are reader-only.*execution is unsupported/u,
  );
  assert.throws(
    () => assertScenarioExecutionContractSupported({ schemaVersion: '1.0.0', safety: {} }),
    /claim-complete fields safety are reader-only.*execution is unsupported/u,
  );
  assert.throws(
    () => assertScenarioExecutionContractSupported({ schemaVersion: '1.0.0', claims: [], safety: {} }),
    /claim-complete fields claims, safety are reader-only.*execution is unsupported/u,
  );
});
