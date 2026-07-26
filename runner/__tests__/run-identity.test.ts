import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRunSuffix as normalizeExampleAndroidRunSuffix } from '../example-android-live';
import { normalizeRunSuffix as normalizeExampleIosRunSuffix } from '../example-ios-live';
import { normalizeRunSuffix as normalizeAndroidRunSuffix } from '../live-android';
import { normalizeRunSuffix as normalizeIosRunSuffix } from '../live-ios';
import { resolveLiveProofSetRunId } from '../live-proof';
import { normalizeBoundedIdentitySegment } from '../run-identity';

test('preserves normalized identities that fit within the limit', () => {
  assert.equal(normalizeBoundedIdentitySegment(' PR 123 / before ', 64), 'pr-123-before');
  assert.equal(normalizeBoundedIdentitySegment('a'.repeat(64), 64), 'a'.repeat(64));
});

test('returns null for invalid or empty normalized identities', () => {
  assert.equal(normalizeBoundedIdentitySegment(undefined, 64), null);
  assert.equal(normalizeBoundedIdentitySegment(false, 64), null);
  assert.equal(normalizeBoundedIdentitySegment('---', 64), null);
  assert.equal(normalizeBoundedIdentitySegment('.', 64), null);
  assert.equal(normalizeBoundedIdentitySegment(' .. ', 64), null);
});

test('uses the complete normalized identity to distinguish overflowing tails', () => {
  const prefix = 'same-readable-prefix-'.padEnd(80, 'x');
  const first = normalizeBoundedIdentitySegment(`${prefix}-first-tail`, 64);
  const second = normalizeBoundedIdentitySegment(`${prefix}-second-tail`, 64);

  assert.notEqual(first, second);
  assert.equal(first, normalizeBoundedIdentitySegment(`${prefix}-first-tail`, 64));
  assert.equal(first?.length, 64);
  assert.equal(second?.length, 64);
  assert.match(first ?? '', /^same-readable-prefix-/u);
});

test('keeps every live and example run suffix normalizer in parity', () => {
  const longSuffix = `release-candidate-${'x'.repeat(80)}-ios-android-tail`;
  const normalizers = [
    normalizeIosRunSuffix,
    normalizeAndroidRunSuffix,
    normalizeExampleIosRunSuffix,
    normalizeExampleAndroidRunSuffix,
  ];
  const normalizedLongSuffixes = normalizers.map((normalize) => normalize(longSuffix));

  assert.deepEqual(normalizedLongSuffixes, Array.from({ length: normalizers.length }, () => normalizedLongSuffixes[0]));
  assert.equal(normalizedLongSuffixes[0]?.length, 64);
  for (const normalize of normalizers) {
    assert.equal(normalize(' PR 123 / before '), 'pr-123-before');
    assert.equal(normalize('---'), null);
    assert.equal(normalize('.'), null);
    assert.equal(normalize('..'), null);
    assert.equal(normalize(undefined), null);
  }
});

test('preserves proof-set fallbacks and makes long run ids collision resistant', () => {
  assert.equal(resolveLiveProofSetRunId({}), 'live-proof-set');
  assert.equal(resolveLiveProofSetRunId({ 'run-id': '---' }), 'live-proof-set');
  assert.equal(resolveLiveProofSetRunId({ 'run-id': '.' }), 'live-proof-set');
  assert.equal(resolveLiveProofSetRunId({ 'run-id': '..' }), 'live-proof-set');
  assert.equal(resolveLiveProofSetRunId({ 'run-id': ' Release Proof ' }), 'release-proof');

  const prefix = 'proof-set-'.padEnd(120, 'p');
  const first = resolveLiveProofSetRunId({ 'run-id': `${prefix}-first-tail` });
  const second = resolveLiveProofSetRunId({ 'run-id': `${prefix}-second-tail` });

  assert.notEqual(first, second);
  assert.equal(first, resolveLiveProofSetRunId({ 'run-id': `${prefix}-first-tail` }));
  assert.equal(first.length, 96);
  assert.equal(second.length, 96);
});
