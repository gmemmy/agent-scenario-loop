const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acquireResourceLease,
  releaseResourceLease,
  buildProviderResourceId,
  buildTcpPortResourceId,
  resolveResourceLeasePath,
} = require('../resource-lease');
const {
  createProviderResourceLeaseSession,
} = require('../provider-resource-lease');
const {
  resolveProviderExclusiveResourceClaims,
  validateProviderExclusiveResources,
} = require('../provider-exclusive-resources');

type TestContext = import('node:test').TestContext;
type ResourceLeaseAcquireOptions = import('../resource-lease').ResourceLeaseAcquireOptions;
type ResourceLeaseReleaseOptions = import('../resource-lease').ResourceLeaseReleaseOptions;
type ProviderResourceLeaseFailure = import('../provider-resource-lease').ProviderResourceLeaseFailure;

async function createWorkspace(t: TestContext): Promise<{ evidencePath: string; leaseRoot: string; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-provider-resource-lease-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    evidencePath: path.join(root, 'artifacts', 'raw', 'provider-resource-leases.json'),
    leaseRoot: path.join(root, 'leases'),
    root,
  };
}

function readJournal(evidencePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
}

function buildClaims({
  providerId = 'native-provider',
  releaseAfter = 'finalize',
}: {
  providerId?: string;
  releaseAfter?: 'stopWindow' | 'finalize';
} = {}) {
  const validated = validateProviderExclusiveResources({
    manifest: {
      schemaVersion: '1.1.0',
      runnerId: providerId,
      kind: 'evidenceProvider',
      platforms: ['android'],
      exclusiveResources: [
        {
          id: 'provider-target',
          acquireAt: 'startWindow',
          releaseAfter,
          resource: {
            kind: 'provider',
            providerId: 'self',
            target: 'selected-target',
          },
        },
        {
          id: 'trace-port',
          acquireAt: 'startWindow',
          releaseAfter,
          resource: {
            kind: 'tcpPort',
            host: '127.0.0.1',
            port: 4317,
          },
        },
      ],
    },
    manifestPath: path.join('/tmp', `${providerId}.json`),
    providerId,
  });
  return resolveProviderExclusiveResourceClaims({
    claims: validated,
    platform: 'android',
    providerId,
    targetId: 'emulator-5554',
  });
}

test('provider resource leases acquire deterministically, hold across phases, and release in reverse order', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const claims = buildClaims({ releaseAfter: 'finalize' });
  const operations: string[] = [];
  const session = await createProviderResourceLeaseSession({
    ...workspace,
    heartbeatIntervalMs: 500,
    ownerId: 'test-runner',
    runId: 'run-1',
    ttlMs: 5_000,
  }, {
    acquire: async (options: ResourceLeaseAcquireOptions) => {
      operations.push(`acquire:${options.resourceId}`);
      return acquireResourceLease(options);
    },
    release: async (options: ResourceLeaseReleaseOptions) => {
      const lease = JSON.parse(await fsp.readFile(options.leasePath, 'utf8')) as { resourceId: string };
      operations.push(`release:${lease.resourceId}`);
      return releaseResourceLease(options);
    },
  });

  assert.equal(await session.beforeProviderPhase({
    claims,
    phase: 'startWindow',
    providerId: 'native-provider',
  }), null);
  assert.deepEqual(await session.afterProviderPhase({
    claims,
    phase: 'startWindow',
    providerId: 'native-provider',
  }), []);
  assert.deepEqual(await session.afterProviderPhase({
    claims,
    phase: 'stopWindow',
    providerId: 'native-provider',
  }), []);
  assert.deepEqual(await session.finalize(), []);

  const expectedAcquireOrder = [...claims].map((claim) => `acquire:${claim.resourceId}`);
  const expectedReleaseOrder = [...claims]
    .sort((left, right) => right.resourceId.localeCompare(left.resourceId))
    .map((claim) => `release:${claim.resourceId}`);
  assert.deepEqual(operations, [...expectedAcquireOrder, ...expectedReleaseOrder]);
  assert.equal(readJournal(workspace.evidencePath).status, 'released');
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('provider resource leases roll back earlier acquisitions when a later resource is contended', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const claims = buildClaims();
  const secondClaim = claims[1];
  const secondLeasePath = resolveResourceLeasePath({
    leaseRoot: workspace.leaseRoot,
    resourceId: secondClaim.resourceId,
  });
  await fsp.mkdir(workspace.leaseRoot, { recursive: true });
  const held = await acquireResourceLease({
    leasePath: secondLeasePath,
    ownerId: 'other-runner',
    resourceId: secondClaim.resourceId,
    runId: 'other-run',
    ttlMs: 5_000,
  });
  assert.equal(held.status, 'acquired');
  if (held.status !== 'acquired') {
    throw new Error('expected held fixture lease');
  }
  t.after(async () => {
    await releaseResourceLease({ leaseId: held.lease.leaseId, leasePath: secondLeasePath });
  });

  const session = await createProviderResourceLeaseSession({
    ...workspace,
    heartbeatIntervalMs: 500,
    ownerId: 'test-runner',
    runId: 'run-rollback',
    ttlMs: 5_000,
  });

  const failure = await session.beforeProviderPhase({
    claims,
    phase: 'startWindow',
    providerId: 'native-provider',
  });

  assert.equal(failure?.code, 'provider_resource_lease_not_acquired');
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'not-acquired');
  assert.equal(JSON.stringify(journal).includes(workspace.leaseRoot), false);
  const claimStatuses = new Map(
    (journal.claims as Array<{ claimId: string; status: string }>).map((claim) => [claim.claimId, claim.status]),
  );
  assert.equal(claimStatuses.get('provider-target'), 'released');
  assert.equal(claimStatuses.get('trace-port'), 'not-acquired');
});

test('provider resource leases fail closed on acquisition distrust', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const claims = buildClaims({ providerId: 'acquisition-provider' }).slice(0, 1);
  const session = await createProviderResourceLeaseSession({
    ...workspace,
    heartbeatIntervalMs: 500,
    ownerId: 'test-runner',
    runId: 'run-untrusted',
    ttlMs: 5_000,
  }, {
    acquire: async (options: ResourceLeaseAcquireOptions) => {
      const result = await acquireResourceLease(options);
      assert.equal(result.status, 'acquired');
      if (result.status !== 'acquired') {
        throw new Error('expected fixture acquisition');
      }
      return {
        ...result,
        durability: { status: 'sync-failed', error: { message: 'sync failed' } },
      };
    },
  });

  const failure = await session.beforeProviderPhase({
    claims,
    phase: 'startWindow',
    providerId: 'acquisition-provider',
  });

  assert.equal(failure?.code, 'provider_resource_lease_acquisition_untrusted');
  assert.equal(readJournal(workspace.evidencePath).status, 'acquisition-untrusted');
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('provider resource leases report heartbeat ownership loss and release remaining claims', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const claims = buildClaims({ providerId: 'heartbeat-provider' }).slice(0, 1);
  const session = await createProviderResourceLeaseSession({
    ...workspace,
    heartbeatIntervalMs: 1,
    ownerId: 'test-runner',
    runId: 'run-heartbeat',
    ttlMs: 100,
  }, {
    heartbeat: async ({ leaseId, leasePath }: { leaseId: string; leasePath: string }) => ({
      status: 'mismatch',
      phase: 'read-existing',
      leasePath,
      operationGuard: { status: 'acquired', guardPath: `${leasePath}.guard`, guardId: 'guard-1' },
      tempCleanup: { status: 'not-needed' },
      guardCleanup: { status: 'succeeded' },
      expectedLeaseId: leaseId,
      foundLeaseId: 'replacement-lease',
      error: { message: 'lease ownership changed' },
    }),
  });

  assert.equal(await session.beforeProviderPhase({
    claims,
    phase: 'startWindow',
    providerId: 'heartbeat-provider',
  }), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const failures = await session.afterProviderPhase({
    claims,
    phase: 'stopWindow',
    providerId: 'heartbeat-provider',
  });

  assert.deepEqual(failures.map((failure: ProviderResourceLeaseFailure) => failure.code), ['provider_resource_lease_ownership_lost']);
  assert.equal(readJournal(workspace.evidencePath).status, 'ownership-lost');
  assert.deepEqual(await fsp.readdir(workspace.leaseRoot), []);
});

test('provider resource leases fail closed on release distrust without leaking lease roots', async (t: TestContext) => {
  const workspace = await createWorkspace(t);
  const claims = buildClaims({ providerId: 'release-provider' }).slice(0, 1);
  const session = await createProviderResourceLeaseSession({
    ...workspace,
    heartbeatIntervalMs: 500,
    ownerId: 'test-runner',
    runId: 'run-release',
    ttlMs: 5_000,
  }, {
    release: async (options: ResourceLeaseReleaseOptions) => {
      await releaseResourceLease(options);
      return {
        status: 'retained',
        phase: 'complete',
        leasePath: options.leasePath,
        leaseId: options.leaseId,
        operationGuard: { status: 'acquired', guardPath: `${options.leasePath}.guard`, guardId: 'guard-2' },
        guardCleanup: { status: 'succeeded' },
        reason: 'mismatch',
        error: { message: `release proof failed at ${workspace.leaseRoot}` },
      };
    },
  });

  assert.equal(await session.beforeProviderPhase({
    claims,
    phase: 'startWindow',
    providerId: 'release-provider',
  }), null);
  const failures = await session.finalize();

  assert.deepEqual(failures.map((failure: ProviderResourceLeaseFailure) => failure.code), ['provider_resource_lease_release_untrusted']);
  const journal = readJournal(workspace.evidencePath);
  assert.equal(journal.status, 'release-untrusted');
  assert.equal(JSON.stringify(journal).includes(workspace.leaseRoot), false);
});
