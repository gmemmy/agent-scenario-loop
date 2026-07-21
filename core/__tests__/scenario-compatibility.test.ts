const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isScenarioCompatible,
  resolveScenarioCompatibility,
} = require('../scenario-compatibility');

const BASELINE_HASH = 'a'.repeat(64);
const CURRENT_HASH = 'b'.repeat(64);

test('classifies matching scenario hashes as exact', () => {
  const result = resolveScenarioCompatibility({
    baselineHash: CURRENT_HASH,
    baselineScenarioId: 'checkout-submit',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  });

  assert.equal(result.status, 'exact');
  assert.equal(isScenarioCompatible(result), true);
});

test('accepts only explicitly declared baseline hashes', () => {
  const accepted = resolveScenarioCompatibility({
    acceptedBaselineScenarioHashes: [BASELINE_HASH],
    baselineHash: BASELINE_HASH,
    baselineScenarioId: 'checkout-submit',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  });
  const reverse = resolveScenarioCompatibility({
    acceptedBaselineScenarioHashes: [CURRENT_HASH],
    baselineHash: BASELINE_HASH,
    baselineScenarioId: 'checkout-submit',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  });

  assert.equal(accepted.status, 'declared-compatible');
  assert.equal(reverse.status, 'incompatible');
});

test('keeps declarations non-transitive', () => {
  const result = resolveScenarioCompatibility({
    acceptedBaselineScenarioHashes: ['c'.repeat(64)],
    baselineHash: BASELINE_HASH,
    baselineScenarioId: 'checkout-submit',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  });

  assert.equal(result.status, 'incompatible');
  assert.equal(result.reason, 'scenario_hash_mismatch');
});

test('preserves legacy current-run behavior without claiming exactness', () => {
  const result = resolveScenarioCompatibility({
    baselineHash: BASELINE_HASH,
    baselineScenarioId: 'checkout-submit',
    currentScenarioId: 'checkout-submit',
  });

  assert.equal(result.status, 'legacy-compatible');
  assert.equal(isScenarioCompatible(result), true);
});

test('rejects missing baseline hashes for hash-aware current runs and scenario id changes', () => {
  assert.equal(resolveScenarioCompatibility({
    baselineScenarioId: 'checkout-submit',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  }).status, 'incompatible');
  assert.equal(resolveScenarioCompatibility({
    acceptedBaselineScenarioHashes: [BASELINE_HASH],
    baselineHash: BASELINE_HASH,
    baselineScenarioId: 'checkout-old',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  }).reason, 'scenario_id_mismatch');
});

test('rejects malformed supplied hashes instead of treating them as legacy', () => {
  assert.equal(resolveScenarioCompatibility({
    baselineHash: BASELINE_HASH,
    baselineScenarioId: 'checkout-submit',
    currentHash: 'malformed-current-hash',
    currentScenarioId: 'checkout-submit',
  }).reason, 'current_scenario_hash_malformed');
  assert.equal(resolveScenarioCompatibility({
    baselineHash: 'malformed-baseline-hash',
    baselineScenarioId: 'checkout-submit',
    currentHash: CURRENT_HASH,
    currentScenarioId: 'checkout-submit',
  }).reason, 'baseline_scenario_hash_malformed');
  assert.equal(resolveScenarioCompatibility({
    baselineHash: 'malformed-baseline-hash',
    baselineScenarioId: 'checkout-submit',
    currentScenarioId: 'checkout-submit',
  }).reason, 'baseline_scenario_hash_malformed');
});
