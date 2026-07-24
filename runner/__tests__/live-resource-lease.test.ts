const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LiveResourceLeaseError,
  runWithLiveResourceLease,
} = require('../live-resource-lease') as typeof import('../live-resource-lease');
const {
  acquireResourceLease,
  buildMobileTargetResourceId,
  releaseResourceLease,
  resolveResourceLeasePath,
} = require('../resource-lease');

type ResourceLeaseHeartbeatResult = import('../resource-lease').ResourceLeaseHeartbeatResult;
type ResourceLeaseAcquireResult = import('../resource-lease').ResourceLeaseAcquireResult;
type ResourceLeaseReleaseResult = import('../resource-lease').ResourceLeaseReleaseResult;
type TestContext = import('node:test').TestContext;

async function createWorkspace(t: TestContext): Promise<{ evidencePath: string; leaseRoot: string; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-live-resource-lease-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    evidencePath: path.join(root, 'artifacts', 'raw', 'resource-lease.json'),
    leaseRoot: path.join(root, 'leases'),
    root,
  };
}

function readJournal(evidencePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
}

function hasLeaseErrorCode(error: unknown, code: string): boolean {
  return error instanceof LiveResourceLeaseError
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

test('live resource lease heartbeats, releases, and writes a host-path-safe journal', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const value = await runWithLiveResourceLease({
    ...workspace,
    heartbeatIntervalMs: 5,
    ownerId: 'test-runner',
    platform: 'android',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return 'completed';
    },
    runId: 'run-1',
    targetId: 'emulator-5554',
    ttlMs: 100,
  });

  assert.equal(value, 'completed');
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'released');
  assert.ok((journal.heartbeat as { count: number }).count >= 1);
  assert.equal(JSON.stringify(journal).includes(workspace.leaseRoot), false);
  assert.match(journal.leaseFileName as string, /^[a-f0-9]{64}\.json$/u);
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('live resource lease fails before callback when the target is already held', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const resourceId = buildMobileTargetResourceId({ platform: 'ios', targetId: 'simulator-1' });
  const leasePath = resolveResourceLeasePath({ leaseRoot: workspace.leaseRoot, resourceId });
  await fsp.mkdir(workspace.leaseRoot, { recursive: true });
  const held = await acquireResourceLease({
    leasePath,
    ownerId: 'other-runner',
    resourceId,
    runId: 'other-run',
    ttlMs: 10_000,
  });
  assert.equal(held.status, 'acquired');
  if (held.status !== 'acquired') {
    throw new Error('Expected fixture lease acquisition to succeed.');
  }
  t.after(async () => {
    await releaseResourceLease({ leaseId: held.lease.leaseId, leasePath });
  });
  let callbackRan = false;

  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      ownerId: 'test-runner',
      platform: 'ios',
      run: () => {
        callbackRan = true;
      },
      runId: 'run-2',
      targetId: 'simulator-1',
    }),
    (error: unknown) => hasLeaseErrorCode(error, 'resource_lease_not_acquired'),
  );
  assert.equal(callbackRan, false);
  assert.equal(readJournal(workspace.evidencePath).status, 'not-acquired');
});

test('live resource lease cleans up acquired-but-untrusted ownership before failing', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const acquire = async (options: import('../resource-lease').ResourceLeaseAcquireOptions): Promise<ResourceLeaseAcquireResult> => {
    const result = await acquireResourceLease(options);
    assert.equal(result.status, 'acquired');
    if (result.status !== 'acquired') {
      throw new Error('Expected fixture lease acquisition to succeed.');
    }
    return {
      ...result,
      durability: { status: 'sync-failed', error: { message: 'Directory sync failed.' } },
    };
  };
  let callbackRan = false;

  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      ownerId: 'test-runner',
      platform: 'android',
      run: () => {
        callbackRan = true;
      },
      runId: 'run-untrusted',
      targetId: 'emulator-untrusted',
    }, { acquire }),
    (error: unknown) => hasLeaseErrorCode(error, 'resource_lease_acquisition_untrusted'),
  );
  assert.equal(callbackRan, false);
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'acquisition-untrusted');
  assert.equal((journal.release as { status: string }).status, 'released');
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('live resource lease reports heartbeat ownership loss and still releases', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const heartbeat = async ({ leaseId, leasePath }: { leaseId: string; leasePath: string }): Promise<ResourceLeaseHeartbeatResult> => ({
    status: 'mismatch',
    phase: 'read-existing',
    leasePath,
    operationGuard: { status: 'acquired', guardPath: `${leasePath}.guard`, guardId: 'guard-1' },
    tempCleanup: { status: 'not-needed' },
    guardCleanup: { status: 'succeeded' },
    expectedLeaseId: leaseId,
    foundLeaseId: 'replacement-lease',
    error: { message: 'Lease ownership changed.' },
  });

  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      heartbeatIntervalMs: 1,
      ownerId: 'test-runner',
      platform: 'android',
      run: async () => new Promise((resolve) => setTimeout(resolve, 10)),
      runId: 'run-3',
      targetId: 'emulator-5554',
      ttlMs: 100,
    }, { heartbeat }),
    (error: unknown) => hasLeaseErrorCode(error, 'resource_lease_ownership_lost'),
  );
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'ownership-lost');
  assert.equal((journal.heartbeat as { lastResult: { status: string } }).lastResult.status, 'mismatch');
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('live resource lease converts heartbeat exceptions into durable ownership loss', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      heartbeatIntervalMs: 1,
      ownerId: 'test-runner',
      platform: 'ios',
      run: async () => new Promise((resolve) => setTimeout(resolve, 10)),
      runId: 'run-heartbeat-error',
      targetId: 'simulator-heartbeat-error',
      ttlMs: 100,
    }, {
      heartbeat: async () => {
        throw new Error(`heartbeat failed at ${workspace.leaseRoot}`);
      },
    }),
    (error: unknown) => hasLeaseErrorCode(error, 'resource_lease_ownership_lost'),
  );
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'ownership-lost');
  assert.equal((journal.heartbeat as { error: { message: string } }).error.message.includes(workspace.leaseRoot), false);
  assert.match((journal.heartbeat as { error: { message: string } }).error.message, /<host-path>/u);
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('live resource lease releases before rethrowing callback failure', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      ownerId: 'test-runner',
      platform: 'ios',
      run: () => {
        throw new Error('profile failed');
      },
      runId: 'run-4',
      targetId: 'simulator-2',
    }),
    /profile failed/u,
  );
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'released');
  assert.deepEqual(journal.callbackError, { message: 'profile failed' });
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('live resource lease fails closed when release evidence is untrusted', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const release = async (options: { leaseId: string; leasePath: string }): Promise<ResourceLeaseReleaseResult> => {
    await releaseResourceLease(options);
    return {
      status: 'retained',
      phase: 'complete',
      leasePath: options.leasePath,
      leaseId: options.leaseId,
      operationGuard: { status: 'acquired', guardPath: `${options.leasePath}.guard`, guardId: 'guard-2' },
      guardCleanup: { status: 'succeeded' },
      reason: 'mismatch',
      error: { message: 'Release proof did not match.' },
    };
  };

  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      ownerId: 'test-runner',
      platform: 'android',
      run: () => 'completed',
      runId: 'run-5',
      targetId: 'emulator-5556',
    }, { release }),
    (error: unknown) => hasLeaseErrorCode(error, 'resource_lease_release_untrusted'),
  );
  assert.equal(readJournal(workspace.evidencePath).status, 'release-untrusted');
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('live resource lease preserves thrown release failures as untrusted evidence', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  await assert.rejects(
    () => runWithLiveResourceLease({
      ...workspace,
      ownerId: 'test-runner',
      platform: 'ios',
      run: () => 'completed',
      runId: 'run-release-error',
      targetId: 'simulator-release-error',
    }, {
      release: async () => {
        throw new Error(`release failed at ${workspace.leaseRoot}`);
      },
    }),
    (error: unknown) => hasLeaseErrorCode(error, 'resource_lease_release_untrusted'),
  );
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'release-untrusted');
  assert.equal((journal.releaseError as { message: string }).message.includes(workspace.leaseRoot), false);
  assert.match((journal.releaseError as { message: string }).message, /<host-path>/u);
});
