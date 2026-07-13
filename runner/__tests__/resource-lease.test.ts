const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const publicLease = require('../resource-lease');
const internalLease = require('../resource-lease-internal');

type TestContext = import('node:test').TestContext;
type InternalDeps = Partial<import('../resource-lease-internal').ResourceLeaseDependencies>;
type ResourceLeaseFs = import('../resource-lease-internal').ResourceLeaseFs;
type ResourceLeaseRecord = import('../resource-lease-internal').ResourceLeaseRecord;

function createNodeFs(): ResourceLeaseFs {
  return {
    readFile: (filePath, encoding) => fsp.readFile(filePath, encoding),
    open: async (filePath, flags, mode) => {
      const handle = await fsp.open(filePath, flags, mode);
      return {
        readFile: (encoding) => handle.readFile({ encoding }),
        write: async (buffer, offset, length, position) => {
          const result = await handle.write(buffer, offset, length, position);
          return { bytesWritten: result.bytesWritten };
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    unlink: (filePath) => fsp.unlink(filePath),
    link: (existingPath, newPath) => fsp.link(existingPath, newPath),
    rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
  };
}

function createDependencies(overrides?: InternalDeps): import('../resource-lease-internal').ResourceLeaseDependencies {
  return {
    nowMs: overrides?.nowMs ?? (() => Date.now()),
    createLeaseId: overrides?.createLeaseId ?? (() => 'lease-default'),
    createGuardId: overrides?.createGuardId ?? (() => 'guard-default'),
    getPid: overrides?.getPid ?? (() => process.pid),
    getHostname: overrides?.getHostname ?? (() => os.hostname()),
    probePidLiveness: overrides?.probePidLiveness ?? (() => 'alive'),
    fs: overrides?.fs ?? createNodeFs(),
    syncDirectory:
      overrides?.syncDirectory ??
      (async (directoryPath: string) => {
        const handle = await fsp.open(directoryPath, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }),
  };
}

async function createLeasePath(t: TestContext): Promise<string> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-resource-lease-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  return path.join(tempDir, 'resource.lock');
}

function buildLeaseRecord(leaseId: string, nowMs = 10_000, ttlMs = 2_000): ResourceLeaseRecord {
  return {
    schemaVersion: internalLease.RESOURCE_LEASE_SCHEMA_VERSION,
    leaseId,
    resourceId: 'resource-alpha',
    ownerId: 'owner-alpha',
    runId: 'run-alpha',
    pid: 1001,
    hostname: os.hostname(),
    createdAt: nowMs - 100,
    heartbeatAt: nowMs - 50,
    expiresAt: nowMs + ttlMs,
    ttlMs,
  };
}

async function writeLeaseRecord(leasePath: string, record: ResourceLeaseRecord): Promise<void> {
  await fsp.writeFile(leasePath, JSON.stringify(record), 'utf8');
}

async function readLeaseRecord(leasePath: string): Promise<ResourceLeaseRecord> {
  return JSON.parse(await fsp.readFile(leasePath, 'utf8')) as ResourceLeaseRecord;
}

function accessExists(filePath: string): Promise<boolean> {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function createAbortError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

test('public resource lease functions expose no dependency-injection parameter', async () => {
  assert.equal(publicLease.inspectResourceLease.length, 1);
  assert.equal(publicLease.acquireResourceLease.length, 1);
  assert.equal(publicLease.heartbeatResourceLease.length, 1);
  assert.equal(publicLease.releaseResourceLease.length, 1);
  assert.equal(publicLease.runWithResourceLease.length, 1);
});

test('release detaches then keeps successor published when replacement appears mid-release', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-old'));

  const nodeFs = createNodeFs();
  let detachedOnce = false;
  const deps = createDependencies({
    fs: {
      ...nodeFs,
      rename: async (oldPath, newPath) => {
        await nodeFs.rename(oldPath, newPath);
        if (oldPath === leasePath && !detachedOnce) {
          detachedOnce = true;
          await writeLeaseRecord(leasePath, buildLeaseRecord('lease-successor', 10_500, 3_000));
        }
      },
    },
  });

  const release = await internalLease.releaseResourceLeaseInternal({ leasePath, leaseId: 'lease-old' }, deps);
  assert.equal(release.status, 'released');
  assert.equal((await readLeaseRecord(leasePath)).leaseId, 'lease-successor');
});

test('release restores detached replacement when lease id does not match', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-replacement'));

  const release = await internalLease.releaseResourceLeaseInternal(
    { leasePath, leaseId: 'lease-original' },
    createDependencies(),
  );
  assert.equal(release.status, 'retained');
  assert.equal(release.reason, 'replaced');
  assert.equal((await readLeaseRecord(leasePath)).leaseId, 'lease-replacement');
  assert.equal(release.detachedDisposition?.status, 'restored');
});

test('heartbeat zero-write failure preserves prior lease JSON', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-heartbeat-zero'));
  const before = await fsp.readFile(leasePath, 'utf8');

  const nodeFs = createNodeFs();
  const deps = createDependencies({
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (flags.includes('wx') && filePath.includes('.heartbeat.tmp')) {
          return {
            ...handle,
            write: async () => ({ bytesWritten: 0 }),
          };
        }
        return handle;
      },
    },
  });

  const heartbeat = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-heartbeat-zero', ttlMs: 5_000 },
    deps,
  );
  assert.equal(heartbeat.status, 'failed');
  assert.equal(await fsp.readFile(leasePath, 'utf8'), before);
});

test('heartbeat sync failure before publish preserves prior lease JSON', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-heartbeat-sync'));
  const before = await fsp.readFile(leasePath, 'utf8');

  const nodeFs = createNodeFs();
  const deps = createDependencies({
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (flags.includes('wx') && filePath.includes('.heartbeat.tmp')) {
          return {
            ...handle,
            sync: async () => {
              const error = new Error('temp sync denied') as NodeJS.ErrnoException;
              error.code = 'EIO';
              throw error;
            },
          };
        }
        return handle;
      },
    },
  });

  const heartbeat = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-heartbeat-sync', ttlMs: 5_000 },
    deps,
  );
  assert.equal(heartbeat.status, 'failed');
  assert.equal(await fsp.readFile(leasePath, 'utf8'), before);
});

test('operation guard contention is explicit and no guard takeover happens', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await fsp.writeFile(
    `${leasePath}.operation`,
    JSON.stringify({
      schemaVersion: internalLease.OPERATION_GUARD_SCHEMA_VERSION,
      guardId: 'guard-active',
      operation: 'release',
      leaseId: 'lease-locked',
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: 20_000,
      expiresAt: 30_000,
    }),
    'utf8',
  );

  const result = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-alpha',
      runId: 'run-alpha',
      ttlMs: 2_000,
    },
    createDependencies({ nowMs: () => 21_000 }),
  );
  assert.equal(result.status, 'contended');
  assert.equal(result.operationGuard.status, 'contended');
});

test('orphaned operation guard is explicit and never auto-broken', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const guardPath = `${leasePath}.operation`;
  await fsp.writeFile(
    guardPath,
    JSON.stringify({
      schemaVersion: internalLease.OPERATION_GUARD_SCHEMA_VERSION,
      guardId: 'guard-orphaned',
      operation: 'heartbeat',
      leaseId: 'lease-older',
      pid: 424242,
      hostname: os.hostname(),
      createdAt: 10_000,
      expiresAt: 10_500,
    }),
    'utf8',
  );

  const result = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-alpha',
      runId: 'run-alpha',
      ttlMs: 2_000,
    },
    createDependencies({ nowMs: () => 12_000, probePidLiveness: () => 'dead' }),
  );

  assert.equal(result.status, 'contended');
  assert.equal(result.operationGuard.status, 'orphaned');
  assert.equal(await fsp.readFile(guardPath, 'utf8').then(() => true).catch(() => false), true);
});

test('acquire reports contention between competing owners', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const first = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-1',
      runId: 'run-1',
      ttlMs: 2_000,
    },
    createDependencies({ createLeaseId: () => 'lease-owner-1', createGuardId: () => 'guard-owner-1' }),
  );
  assert.equal(first.status, 'acquired');

  const second = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-2',
      runId: 'run-2',
      ttlMs: 2_000,
    },
    createDependencies({ createLeaseId: () => 'lease-owner-2', createGuardId: () => 'guard-owner-2' }),
  );
  assert.equal(second.status, 'contended');
});

test('inspect reports stale leases but acquisition does not force takeover', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const nowMs = 12_000;
  await writeLeaseRecord(leasePath, { ...buildLeaseRecord('lease-stale', nowMs), expiresAt: nowMs - 1 });

  const inspection = await internalLease.inspectResourceLeaseInternal({ leasePath }, createDependencies({ nowMs: () => nowMs }));
  assert.equal(inspection.status, 'stale');
  assert.equal(inspection.staleReason, 'expired');

  const acquire = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-contender',
      runId: 'run-contender',
      ttlMs: 2_000,
    },
    createDependencies({ createLeaseId: () => 'lease-contender', createGuardId: () => 'guard-contender', nowMs: () => nowMs }),
  );
  assert.equal(acquire.status, 'contended');
});

test('inspect rejects malformed records and release retains malformed lease payload', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await fsp.writeFile(leasePath, '{not-json', 'utf8');

  const inspection = await internalLease.inspectResourceLeaseInternal({ leasePath }, createDependencies());
  assert.equal(inspection.status, 'invalid');
  assert.equal(inspection.invalidReason, 'malformed');

  const release = await internalLease.releaseResourceLeaseInternal({ leasePath, leaseId: 'lease-any' }, createDependencies());
  assert.equal(release.status, 'retained');
  assert.equal(release.reason, 'invalid');
  assert.equal(await fsp.readFile(leasePath, 'utf8'), '{not-json');

  const acquire = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-contender',
      runId: 'run-contender',
      ttlMs: 2_000,
    },
    createDependencies({ createLeaseId: () => 'lease-malformed', createGuardId: () => 'guard-malformed' }),
  );
  assert.equal(acquire.status, 'contended');
});

test('inspect uses unknown pid liveness for remote host leases', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(
    leasePath,
    {
      ...buildLeaseRecord('lease-remote'),
      hostname: 'remote-host',
      expiresAt: Date.now() + 30_000,
    },
  );

  const inspection = await internalLease.inspectResourceLeaseInternal(
    { leasePath },
    createDependencies({ getHostname: () => 'local-host', probePidLiveness: () => 'dead' }),
  );
  assert.equal(inspection.status, 'held');
  assert.equal(inspection.pidLiveness, 'unknown');
});

test('acquire cancellation after temp sync cleans up temporary file', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const controller = new AbortController();
  const nodeFs = createNodeFs();
  const deps = createDependencies({
    createLeaseId: () => 'lease-cancelled',
    createGuardId: () => 'guard-cancelled',
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (flags.includes('wx') && filePath.endsWith('.tmp') && !filePath.includes('.operation.')) {
          return {
            ...handle,
            sync: async () => {
              await handle.sync();
              controller.abort();
            },
          };
        }
        return handle;
      },
    },
  });

  const result = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-cancelled',
      runId: 'run-cancelled',
      ttlMs: 2_000,
      signal: controller.signal,
    },
    deps,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cleanup.status, 'succeeded');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(result.tempPath ? await accessExists(result.tempPath) : false, false);
  assert.equal(await accessExists(leasePath), false);
  assert.equal(await accessExists(`${leasePath}.operation`), false);
});

test('acquire cancellation during guard staging returns cleanup evidence and no published guard', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const controller = new AbortController();
  const nodeFs = createNodeFs();
  const guardId = 'guard-stage-cancelled';
  const guardTempPath = `${leasePath}.operation.${Buffer.from(guardId, 'utf8').toString('base64url')}.tmp`;
  const deps = createDependencies({
    createLeaseId: () => 'lease-stage-cancelled',
    createGuardId: () => guardId,
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (filePath === guardTempPath) {
          return {
            ...handle,
            sync: async () => {
              await handle.sync();
              controller.abort();
            },
          };
        }
        return handle;
      },
    },
  });

  const result = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-stage-cancelled',
      runId: 'run-stage-cancelled',
      ttlMs: 2_000,
      signal: controller.signal,
    },
    deps,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.phase, 'operation-guard');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(await accessExists(guardTempPath), false);
  assert.equal(await accessExists(`${leasePath}.operation`), false);
  assert.equal(await accessExists(leasePath), false);
});

test('heartbeat cancellation after temp sync preserves prior lease and cleans temp plus guard', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const controller = new AbortController();
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-heartbeat-cancel-safe-point', 12_000, 4_000));
  const before = await fsp.readFile(leasePath, 'utf8');
  const nodeFs = createNodeFs();
  const deps = createDependencies({
    createGuardId: () => 'guard-heartbeat-cancel-safe-point',
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (flags.includes('wx') && filePath.includes('.heartbeat.tmp')) {
          return {
            ...handle,
            sync: async () => {
              await handle.sync();
              controller.abort();
            },
          };
        }
        return handle;
      },
    },
  });

  const result = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-heartbeat-cancel-safe-point', ttlMs: 6_000, signal: controller.signal },
    deps,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.tempCleanup.status, 'succeeded');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(result.tempPath ? await accessExists(result.tempPath) : false, false);
  assert.equal(await accessExists(`${leasePath}.operation`), false);
  assert.equal(await fsp.readFile(leasePath, 'utf8'), before);
});

test('release cancellation after detach restores prior lease and cleans operation guard', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const controller = new AbortController();
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-release-cancel-safe-point'));
  const before = await fsp.readFile(leasePath, 'utf8');
  const nodeFs = createNodeFs();
  const deps = createDependencies({
    createGuardId: () => 'guard-release-cancel-safe-point',
    fs: {
      ...nodeFs,
      rename: async (oldPath, newPath) => {
        await nodeFs.rename(oldPath, newPath);
        if (oldPath === leasePath && newPath.includes('.detached')) {
          controller.abort();
        }
      },
    },
  });

  const result = await internalLease.releaseResourceLeaseInternal(
    { leasePath, leaseId: 'lease-release-cancel-safe-point', signal: controller.signal },
    deps,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.detachedDisposition?.status, 'restored');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(await accessExists(`${leasePath}.operation`), false);
  assert.equal(await fsp.readFile(leasePath, 'utf8'), before);
  assert.equal(result.detachedPath ? await accessExists(result.detachedPath) : false, false);
});

test('heartbeat renews only for owning lease id', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const acquire = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-heartbeat',
      runId: 'run-heartbeat',
      ttlMs: 1_000,
    },
    createDependencies({ createLeaseId: () => 'lease-heartbeat', createGuardId: () => 'guard-heartbeat-acquire' }),
  );
  assert.equal(acquire.status, 'acquired');

  const renewed = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-heartbeat', ttlMs: 3_000 },
    createDependencies({ createGuardId: () => 'guard-heartbeat-renew' }),
  );
  assert.equal(renewed.status, 'renewed');
  assert.equal(renewed.lease.ttlMs, 3_000);

  const mismatch = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-other' },
    createDependencies({ createGuardId: () => 'guard-heartbeat-mismatch' }),
  );
  assert.equal(mismatch.status, 'mismatch');
  assert.equal(mismatch.expectedLeaseId, 'lease-other');
  assert.equal(mismatch.foundLeaseId, 'lease-heartbeat');
});

test('heartbeat preserves full JSON payload for partial writes', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-partial'));
  const nodeFs = createNodeFs();
  let writeCalls = 0;
  const deps = createDependencies({
    createGuardId: () => 'guard-heartbeat-partial',
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (flags.includes('wx') && filePath.includes('.heartbeat.tmp')) {
          return {
            ...handle,
            write: async (buffer, offset, length, position) => {
              writeCalls += 1;
              const chunk = Math.min(4, length);
              return handle.write(buffer, offset, chunk, position);
            },
          };
        }
        return handle;
      },
    },
  });

  const result = await internalLease.heartbeatResourceLeaseInternal({ leasePath, leaseId: 'lease-partial', ttlMs: 5_000 }, deps);
  assert.equal(result.status, 'renewed');
  assert.equal(writeCalls > 1, true);
  const parsed = await readLeaseRecord(leasePath);
  assert.equal(parsed.leaseId, 'lease-partial');
  assert.equal(parsed.ttlMs, 5_000);
});

test('matching release removes lease and mismatched release keeps current owner', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-release'));

  const mismatch = await internalLease.releaseResourceLeaseInternal(
    { leasePath, leaseId: 'lease-wrong' },
    createDependencies({ createGuardId: () => 'guard-release-mismatch' }),
  );
  assert.equal(mismatch.status, 'retained');
  assert.equal(mismatch.reason, 'replaced');
  assert.equal((await readLeaseRecord(leasePath)).leaseId, 'lease-release');

  const released = await internalLease.releaseResourceLeaseInternal(
    { leasePath, leaseId: 'lease-release' },
    createDependencies({ createGuardId: () => 'guard-release-match' }),
  );
  assert.equal(released.status, 'released');
  assert.equal(await accessExists(leasePath), false);
});

test('acquire reports cleanup failure without hiding successful lease publication', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const nodeFs = createNodeFs();
  const tempPath = `${leasePath}.${Buffer.from('lease-cleanup', 'utf8').toString('base64url')}.tmp`;
  const deps = createDependencies({
    createLeaseId: () => 'lease-cleanup',
    createGuardId: () => 'guard-cleanup',
    fs: {
      ...nodeFs,
      unlink: async (filePath) => {
        if (filePath === tempPath) {
          const error = new Error('temp cleanup denied') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        await nodeFs.unlink(filePath);
      },
    },
  });

  const result = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-cleanup',
      runId: 'run-cleanup',
      ttlMs: 2_000,
    },
    deps,
  );
  assert.equal(result.status, 'acquired');
  assert.deepEqual(result.cleanup, { status: 'failed', message: 'temp cleanup denied' });
  assert.equal(await accessExists(tempPath), true);
  assert.equal((await readLeaseRecord(leasePath)).leaseId, 'lease-cleanup');
});

test('runWithResourceLease waits for callback settlement before release', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const events: string[] = [];
  const result = await internalLease.runWithResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-run',
      runId: 'run-settlement',
      ttlMs: 2_000,
      run: async () => {
        events.push('callback-start');
        assert.equal(await accessExists(leasePath), true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push('callback-end');
        return 'done';
      },
    },
    createDependencies({ createLeaseId: () => 'lease-run', createGuardId: () => 'guard-run' }),
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, ['callback-start', 'callback-end']);
  assert.equal(await accessExists(leasePath), false);
});

test('runWithResourceLease skips callback when acquisition sync fails', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  let callbackRan = false;
  const result = await internalLease.runWithResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-acquisition-untrusted',
      runId: 'run-acquisition-untrusted',
      ttlMs: 2_000,
      run: async () => {
        callbackRan = true;
        return 'ignored';
      },
    },
    createDependencies({
      createLeaseId: () => 'lease-acq-sync',
      createGuardId: () => 'guard-acq-sync',
      syncDirectory: async () => {
        const error = new Error('directory sync denied') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    }),
  );
  assert.equal(result.status, 'acquisition-untrusted');
  assert.equal(callbackRan, false);
  assert.equal(result.release.status, 'released');
});

test('runWithResourceLease reports cleanup-failed when release sync fails after callback', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  let syncCalls = 0;
  const result = await internalLease.runWithResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-release-sync',
      runId: 'run-release-sync',
      ttlMs: 2_000,
      run: async () => 'value',
    },
    createDependencies({
      createLeaseId: () => 'lease-release-sync',
      createGuardId: () => 'guard-release-sync',
      syncDirectory: async (directoryPath: string) => {
        syncCalls += 1;
        if (syncCalls === 2) {
          const error = new Error('release sync denied') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        const handle = await fsp.open(directoryPath, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    }),
  );
  assert.equal(result.status, 'cleanup-failed');
  assert.equal(result.callback.status, 'completed');
  assert.equal(result.release.status, 'released');
  assert.equal(result.release.durability.status, 'sync-failed');
});

test('runWithResourceLease cancellation in callback requires clean release', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const result = await internalLease.runWithResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-cancelled',
      runId: 'run-cancelled',
      ttlMs: 2_000,
      run: async () => {
        throw createAbortError('callback aborted');
      },
    },
    createDependencies({ createLeaseId: () => 'lease-cancelled-callback', createGuardId: () => 'guard-cancelled-callback' }),
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.phase, 'callback');
  assert.equal(result.release?.status, 'released');
  assert.equal(await accessExists(leasePath), false);
});

test('heartbeat mismatch releases operation guard path', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-heartbeat-owner'));
  const guardPath = `${leasePath}.operation`;

  const result = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-heartbeat-other' },
    createDependencies({ createGuardId: () => 'guard-heartbeat-mismatch-release' }),
  );
  assert.equal(result.status, 'mismatch');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(await accessExists(guardPath), false);
});

test('heartbeat invalid payload releases operation guard path', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await fsp.writeFile(leasePath, '{bad-json', 'utf8');
  const guardPath = `${leasePath}.operation`;

  const result = await internalLease.heartbeatResourceLeaseInternal(
    { leasePath, leaseId: 'lease-heartbeat-invalid' },
    createDependencies({ createGuardId: () => 'guard-heartbeat-invalid-release' }),
  );
  assert.equal(result.status, 'invalid');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(await accessExists(guardPath), false);
});

test('guard staging sync failure cleans guard temp and returns orphaned guard outcome', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  const nodeFs = createNodeFs();
  const guardId = 'guard-stage-failure';
  const guardTempPath = `${leasePath}.operation.${Buffer.from(guardId, 'utf8').toString('base64url')}.tmp`;
  const deps = createDependencies({
    createLeaseId: () => 'lease-guard-stage-failure',
    createGuardId: () => guardId,
    fs: {
      ...nodeFs,
      open: async (filePath, flags, mode) => {
        const handle = await nodeFs.open(filePath, flags, mode);
        if (filePath === guardTempPath) {
          return {
            ...handle,
            sync: async () => {
              const error = new Error('guard sync denied') as NodeJS.ErrnoException;
              error.code = 'EIO';
              throw error;
            },
          };
        }
        return handle;
      },
    },
  });

  const result = await internalLease.acquireResourceLeaseInternal(
    {
      leasePath,
      resourceId: 'resource-alpha',
      ownerId: 'owner-guard-stage-failure',
      runId: 'run-guard-stage-failure',
      ttlMs: 2_000,
    },
    deps,
  );
  assert.equal(result.status, 'contended');
  assert.equal(result.operationGuard.status, 'orphaned');
  assert.equal(result.guardCleanup.status, 'succeeded');
  assert.equal(await accessExists(guardTempPath), false);
  assert.equal(await accessExists(`${leasePath}.operation`), false);
});

test('release read-error after detach restores or preserves detached record', async (t: TestContext) => {
  const leasePath = await createLeasePath(t);
  await writeLeaseRecord(leasePath, buildLeaseRecord('lease-detach-read-error'));

  const nodeFs = createNodeFs();
  const deps = createDependencies({
    createGuardId: () => 'guard-detach-read-error',
    fs: {
      ...nodeFs,
      readFile: async (filePath, encoding) => {
        if (filePath.includes('.detached')) {
          const error = new Error('detached read denied') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return nodeFs.readFile(filePath, encoding);
      },
    },
  });

  const release = await internalLease.releaseResourceLeaseInternal(
    { leasePath, leaseId: 'lease-detach-read-error' },
    deps,
  );
  assert.equal(release.status, 'failed');
  const survivingPath =
    release.detachedDisposition?.status === 'preserved' || release.detachedDisposition?.status === 'preserved-at-detached'
      ? release.detachedDisposition.path
      : leasePath;
  assert.equal(await accessExists(survivingPath), true);
  const survivingRecord = JSON.parse(await fsp.readFile(survivingPath, 'utf8')) as ResourceLeaseRecord;
  assert.equal(survivingRecord.leaseId, 'lease-detach-read-error');
});
