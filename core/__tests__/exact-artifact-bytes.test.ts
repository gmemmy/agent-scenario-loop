const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const { snapshotAndHashExactArtifactBytes } = require('../exact-artifact-bytes');

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('snapshotAndHashExactArtifactBytes', () => {
  it('copies ordinary Uint8Array bytes, hashes them, and isolates mutation', () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const snapshot = snapshotAndHashExactArtifactBytes(original);

    if (snapshot === null) {
      assert.fail('expected a snapshot for an ordinary Uint8Array');
    }

    assert.deepEqual(Array.from(snapshot.bytes), [0xde, 0xad, 0xbe, 0xef]);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])));
    assert.equal(snapshot.sha256.length, 64);
    assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(snapshot.bytes.buffer, original.buffer);

    original[0] = 0x00;
    assert.equal(snapshot.bytes[0], 0xde);

    snapshot.bytes[1] = 0x00;
    assert.equal(original[1], 0xad);
  });

  it('accepts Buffer as a genuine Uint8Array view', () => {
    const buffer = Buffer.from([1, 2, 3, 4]);
    const snapshot = snapshotAndHashExactArtifactBytes(buffer);

    if (snapshot === null) {
      assert.fail('expected a snapshot for Buffer');
    }

    assert.deepEqual(Array.from(snapshot.bytes), [1, 2, 3, 4]);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array([1, 2, 3, 4])));
    assert.ok(snapshot.bytes instanceof Uint8Array);
    assert.equal(snapshot.bytes.buffer === buffer.buffer, false);

    buffer[0] = 9;
    assert.equal(snapshot.bytes[0], 1);
  });

  it('ignores a substituting instance Symbol.iterator on a real Uint8Array', () => {
    const original = new Uint8Array([10, 20, 30]);
    Object.defineProperty(original, Symbol.iterator, {
      configurable: true,
      value: function* (): Generator<number> {
        yield 99;
        yield 98;
        yield 97;
      },
    });

    const snapshot = snapshotAndHashExactArtifactBytes(original);

    if (snapshot === null) {
      assert.fail('expected a snapshot despite a substituted iterator');
    }

    assert.deepEqual(Array.from(snapshot.bytes), [10, 20, 30]);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array([10, 20, 30])));
  });

  it('ignores a throwing instance Symbol.iterator on a real Uint8Array', () => {
    const original = new Uint8Array([4, 5, 6]);
    Object.defineProperty(original, Symbol.iterator, {
      configurable: true,
      value: (): Iterator<number> => {
        throw new Error('iterator must not be consulted');
      },
    });

    const snapshot = snapshotAndHashExactArtifactBytes(original);

    if (snapshot === null) {
      assert.fail('expected a snapshot despite a throwing iterator');
    }

    assert.deepEqual(Array.from(snapshot.bytes), [4, 5, 6]);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array([4, 5, 6])));
  });

  it('rejects a Proxy-wrapped typed array and Object.create(Uint8Array.prototype)', () => {
    const proxy = new Proxy(new Uint8Array([1, 2, 3]), {});
    assert.equal(snapshotAndHashExactArtifactBytes(proxy), null);

    const spoof = Object.create(Uint8Array.prototype) as Uint8Array;
    assert.equal(snapshotAndHashExactArtifactBytes(spoof), null);
  });

  it('returns null for a detached ArrayBuffer-backed Uint8Array without throwing', () => {
    const arrayBuffer = new ArrayBuffer(4);
    const view = new Uint8Array(arrayBuffer);
    view.set([7, 8, 9, 10]);
    structuredClone(arrayBuffer, { transfer: [arrayBuffer] });

    assert.equal(snapshotAndHashExactArtifactBytes(view), null);
  });

  it('returns null for representative non-byte inputs', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      0,
      1,
      'bytes',
      true,
      false,
      [],
      [1, 2, 3],
      { 0: 1, length: 1 },
      new ArrayBuffer(4),
      new DataView(new ArrayBuffer(4)),
      new Uint16Array([1, 2]),
      new Int8Array([1, 2]),
      new Uint8ClampedArray([1, 2]),
      () => new Uint8Array([1]),
    ];

    for (const input of inputs) {
      assert.equal(snapshotAndHashExactArtifactBytes(input), null);
    }
  });

  it('admits an empty Uint8Array view and hashes empty bytes', () => {
    const original = new Uint8Array(0);
    const snapshot = snapshotAndHashExactArtifactBytes(original);

    if (snapshot === null) {
      assert.fail('expected a snapshot for an empty Uint8Array');
    }

    assert.equal(snapshot.bytes.byteLength, 0);
    assert.deepEqual(Array.from(snapshot.bytes), []);
    assert.notEqual(snapshot.bytes.buffer, original.buffer);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array(0)));
    assert.equal(snapshot.sha256.length, 64);
    assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  });

  it('snapshots a non-zero-offset subarray without the backing prefix or suffix', () => {
    const backing = new Uint8Array([0xaa, 0x11, 0x22, 0x33, 0xbb]);
    const view = backing.subarray(1, 4);
    const snapshot = snapshotAndHashExactArtifactBytes(view);

    if (snapshot === null) {
      assert.fail('expected a snapshot for a non-zero-offset Uint8Array subarray');
    }

    assert.deepEqual(Array.from(snapshot.bytes), [0x11, 0x22, 0x33]);
    assert.equal(snapshot.bytes.byteLength, 3);
    assert.notEqual(snapshot.bytes.buffer, backing.buffer);
    assert.notEqual(snapshot.bytes.buffer, view.buffer);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array([0x11, 0x22, 0x33])));
    assert.notEqual(snapshot.sha256, sha256Hex(backing));

    backing[1] = 0x00;
    backing[2] = 0xff;
    backing[4] = 0x00;
    assert.deepEqual(Array.from(snapshot.bytes), [0x11, 0x22, 0x33]);
    assert.equal(snapshot.sha256, sha256Hex(new Uint8Array([0x11, 0x22, 0x33])));
  });
});
