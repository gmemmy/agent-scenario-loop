const crypto = require('node:crypto');

export type ExactArtifactBytesSnapshot = {
  bytes: Uint8Array;
  sha256: string;
};

function isGenuineUint8ArrayView(value: unknown): value is Uint8Array {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!(value instanceof Uint8Array)) {
    return false;
  }
  if (!ArrayBuffer.isView(value)) {
    return false;
  }
  return true;
}

export function snapshotAndHashExactArtifactBytes(
  value: unknown,
): ExactArtifactBytesSnapshot | null {
  if (!isGenuineUint8ArrayView(value)) {
    return null;
  }

  try {
    const bytes = new Uint8Array(value);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { bytes, sha256 };
  } catch {
    return null;
  }
}
