const { createHash } = require('node:crypto') as typeof import('node:crypto');

const IDENTITY_HASH_LENGTH = 16;

/**
 * Normalizes an untrusted value into a bounded, path-safe identity segment.
 * Values that already fit remain unchanged; longer values retain a readable
 * prefix and a deterministic digest of the complete normalized identity.
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string | null}
 */
function normalizeBoundedIdentitySegment(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (!Number.isSafeInteger(maxLength) || maxLength <= IDENTITY_HASH_LENGTH + 1) {
    throw new Error('Bounded identity maxLength must leave room for a readable prefix and hash.');
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (normalized.length === 0 || normalized === '.' || normalized === '..') {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const digest = createHash('sha256')
    .update(normalized, 'utf8')
    .digest('hex')
    .slice(0, IDENTITY_HASH_LENGTH);
  const prefixLength = maxLength - digest.length - 1;
  return `${normalized.slice(0, prefixLength)}-${digest}`;
}

export {
  normalizeBoundedIdentitySegment,
};
