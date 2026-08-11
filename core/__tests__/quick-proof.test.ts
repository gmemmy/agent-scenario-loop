const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
import type { TestContext } from 'node:test';

const {
  buildQuickProofSummary,
  coordinateQuickProof,
  writeQuickProofArtifacts,
} = require('../quick-proof');
const { SCHEMAS, validateJson } = require('../schema-validator');

function createClock() {
  let value = Date.parse('2026-08-10T00:00:00.000Z');
  return {
    now: () => value,
    advance: (durationMs: number) => {
      value += durationMs;
    },
  };
}

function observedIdentity() {
  return { name: 'target', status: 'observed', expected: 'device-1', observed: 'device-1' };
}

function baseAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trusted',
    tier: 'trusted-automated',
    async discover() {
      return {
        status: 'passed',
        capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
        identities: [{ name: 'target', status: 'unresolved-until-observed', expected: 'device-1' }],
      };
    },
    async preflight() {
      return { status: 'passed', identities: [observedIdentity()] };
    },
    async runProduct(context: { beginProductAction?: () => Promise<void> }) {
      await context.beginProductAction?.();
      return { status: 'passed', productActionStarted: true };
    },
    async cleanup() {
      return { status: 'passed' };
    },
    ...overrides,
  };
}

function baseOptions(clock: ReturnType<typeof createClock>, overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    scenarioId: 'scenario-1',
    goalId: 'goal-1',
    source: {
      revision: 'source-revision-1',
      packageName: 'agent-scenario-loop',
      packageVersion: '0.1.18-candidate',
      packageIntegrity: 'sha256:quick-proof-candidate',
      helperIdentity: 'profile-session-helper@1.1.0',
    },
    authorization: {
      grantId: 'grant-1',
      goalId: 'goal-1',
      operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z',
      delegationChain: ['cos', 'worker'],
      targetResource: 'mobile-target:ios:device-1',
    },
    targetResource: 'mobile-target:ios:device-1',
    requirements: {
      operations: [{ operation: 'inspect', requiredArguments: ['target'] }],
      identities: [{ name: 'target', expected: 'device-1' }],
    },
    budgets: { setupMs: 240000, totalMs: 600000, minimumProductRatio: 0.6 },
    adapters: [baseAdapter()],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        return {
          leaseId: 'lease-1', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
      },
      async release() {
        return { status: 'released' };
      },
    },
    now: clock.now,
    ...overrides,
  };
}

test('coordinates a schema-valid trusted product execution with scoped authorization and lease cleanup', async () => {
  const clock = createClock();
  const artifact = await coordinateQuickProof(baseOptions(clock));

  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'quick proof').valid, true);
  assert.equal(artifact.status, 'product-executed');
  assert.equal(artifact.proofTier, 'trusted-automated');
  assert.equal(artifact.decision.code, 'product-completed');
  assert.equal(artifact.product.started, true);
  assert.equal(artifact.lease.status, 'released');
  assert.equal(artifact.cleanup.status, 'passed');
  assert.deepEqual(artifact.authorization.operations, ['inspect']);
  assert.equal(artifact.source.packageIntegrity, 'sha256:quick-proof-candidate');
  assert.equal(artifact.phases.some((phase: { reason?: string }) => /malformed/u.test(phase.reason ?? '')), false);
});

test('rejects an observed identity that omits its observed value before product execution', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    requirements: {
      operations: [{ operation: 'inspect', requiredArguments: ['target'] }],
      identities: [{ name: 'target' }],
    },
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [{ name: 'target', status: 'unresolved-until-observed' }],
        };
      },
      async preflight() {
        return { status: 'passed', identities: [{ name: 'target', status: 'observed' }] };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'identity-unresolved');
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'incomplete observed identity').valid, true);
});

test('writes a setup-only schema artifact and explicitly non-product summary', async () => {
  const clock = createClock();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-quick-proof-'));
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [baseAdapter({ tier: 'manual-assisted' })],
  }));
  const paths = await writeQuickProofArtifacts({ outDir: output, artifact });

  assert.equal(fs.existsSync(paths.artifactPath), true);
  assert.match(fs.readFileSync(paths.summaryPath, 'utf8'), /setup friction only/u);
  assert.match(buildQuickProofSummary(artifact), /Product action: not started/u);
});

test('stops when setup exceeds its declared deadline', async () => {
  const clock = createClock();
  let preflightCalls = 0;
  let productCalls = 0;
  const adapter = baseAdapter({
    async discover() {
      clock.advance(121000);
      return {
        status: 'passed',
        capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
        identities: [],
      };
    },
    async preflight() {
      preflightCalls += 1;
      return { status: 'passed', identities: [observedIdentity()] };
    },
    async runProduct() {
      productCalls += 1;
      return { status: 'passed', productActionStarted: true };
    },
  });
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    budgets: { setupMs: 120000, totalMs: 600000, minimumProductRatio: 0.6 },
    adapters: [adapter],
  }));

  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'setup-budget-exceeded');
  assert.equal(artifact.adapters[0]?.status, 'failed');
  assert.equal(preflightCalls, 0);
  assert.equal(productCalls, 0);
});

test('reserves the configured share of total time for product execution', async () => {
  const clock = createClock();
  const adapter = baseAdapter({
    async preflight() {
      clock.advance(250000);
      return { status: 'passed', identities: [observedIdentity()] };
    },
  });
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    budgets: { setupMs: 300000, totalMs: 600000, minimumProductRatio: 0.6 },
    adapters: [adapter],
  }));

  assert.equal(artifact.decision.code, 'product-budget-reserve-insufficient');
  assert.equal(artifact.product.started, false);
});

test('rechecks setup and product reserve after lease acquisition', async () => {
  const clock = createClock();
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    budgets: { setupMs: 100, totalMs: 1000, minimumProductRatio: 0.6 },
    adapters: [baseAdapter({
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        clock.advance(150);
        return {
          leaseId: 'lease-late', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
      },
      async release() { return { status: 'released' }; },
    },
  }));

  assert.equal(artifact.decision.code, 'setup-budget-exceeded');
  assert.equal(productCalls, 0);
  assert.equal(artifact.lease.status, 'released');
});

test('allows only the initial attempt and one retry for each adapter path', async () => {
  const clock = createClock();
  let discoveryCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    targetResource: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    leasePort: undefined,
    adapters: [baseAdapter({
      async discover() {
        discoveryCalls += 1;
        return { status: 'failed', capabilities: [], identities: [], reason: 'unavailable' };
      },
    })],
  }));

  assert.equal(discoveryCalls, 2);
  assert.equal(artifact.adapters[0].attempts, 2);
  assert.equal(artifact.decision.code, 'capability-unavailable');
});

test('rejects unsupported arguments even when the operation exists', async () => {
  const clock = createClock();
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['session'] }],
          identities: [],
        };
      },
    })],
  }));

  assert.equal(artifact.decision.code, 'capability-unavailable');
  assert.match(artifact.decision.reason, /argument target/u);
  assert.equal(artifact.product.started, false);
});

test('rejects duplicate capability declarations instead of resolving them by array order', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [
            { operation: 'inspect', supportedArguments: ['target'] },
            { operation: 'inspect', supportedArguments: [] },
          ],
          identities: [],
        };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.decision.code, 'capability-unavailable');
  assert.match(artifact.decision.reason, /declared more than once/u);
});

test('permits unresolved identity during discovery but fails closed when preflight cannot observe it', async () => {
  const clock = createClock();
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [baseAdapter({
      async preflight() {
        return { status: 'passed', identities: [] };
      },
    })],
  }));

  assert.equal(artifact.decision.code, 'identity-unresolved');
  assert.equal(artifact.identities[0].status, 'unresolved-until-observed');
});

test('fails closed for mismatched and unavailable required identities', async (t: TestContext) => {
  for (const status of ['mismatched', 'unavailable']) {
    await t.test(status, async () => {
      const clock = createClock();
      const artifact = await coordinateQuickProof(baseOptions(clock, {
        adapters: [baseAdapter({
          async preflight() {
            return { status: 'passed', identities: [{ name: 'target', status, reason: `target ${status}` }] };
          },
        })],
      }));
      assert.equal(artifact.decision.code, 'identity-unresolved');
      assert.equal(artifact.product.started, false);
    });
  }
});

test('does not allow later identity output to overwrite a terminal mismatch or unavailable state', async (t: TestContext) => {
  for (const status of ['mismatched', 'unavailable'] as const) {
    await t.test(status, async () => {
      let productCalls = 0;
      const artifact = await coordinateQuickProof(baseOptions(createClock(), {
        adapters: [baseAdapter({
          async discover() {
            return {
              status: 'passed',
              capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
              identities: [
                { name: 'target', status, expected: 'device-1', reason: `target is ${status}` },
                { name: 'target', status: 'observed', expected: 'device-1', observed: 'device-1' },
              ],
            };
          },
          async preflight() {
            return { status: 'passed', identities: [observedIdentity()] };
          },
          async runProduct() {
            productCalls += 1;
            return { status: 'passed', productActionStarted: true };
          },
        })],
      }));

      assert.equal(productCalls, 0);
      assert.equal(artifact.decision.code, 'identity-unresolved');
      assert.equal(artifact.identities[0]?.status, status);
    });
  }
});

test('fails closed when an observed required identity changes across discovery and preflight', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    requirements: {
      operations: [{ operation: 'inspect', requiredArguments: ['target'] }],
      identities: [{ name: 'target' }],
    },
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [{ name: 'target', status: 'observed', observed: 'device-a' }],
        };
      },
      async preflight() {
        return { status: 'passed', identities: [{ name: 'target', status: 'observed', observed: 'device-b' }] };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'identity-unresolved');
  assert.equal(artifact.identities[0].status, 'mismatched');
  assert.match(artifact.identities[0].reason, /changed from device-a to device-b/u);
});

test('denies expired, wrong-goal, missing-operation, target-mismatched, and credential-bearing grants', async (t: TestContext) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['expired', { expiresAt: '2026-08-09T00:00:00.000Z' }],
    ['wrong goal', { goalId: 'other-goal' }],
    ['missing operation', { operations: [] }],
    ['target mismatch', { targetResource: 'mobile-target:ios:other' }],
    ['credential field', { accessToken: 'must-not-pass' }],
  ];
  for (const [name, grantPatch] of cases) {
    await t.test(name, async () => {
      const clock = createClock();
      const options = baseOptions(clock);
      const artifact = await coordinateQuickProof({
        ...options,
        authorization: { ...options.authorization, ...grantPatch },
      });
      assert.equal(artifact.decision.code, 'authorization-denied');
      assert.equal(artifact.product.started, false);
    });
  }
});

test('revalidates authorization after setup and passes only sanitized fields to adapters', async () => {
  const clock = createClock();
  let productCalls = 0;
  const options = baseOptions(clock);
  const artifact = await coordinateQuickProof({
    ...options,
    authorization: {
      ...options.authorization,
      expiresAt: '2026-08-10T00:00:00.100Z',
    },
    adapters: [baseAdapter({
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        clock.advance(200);
        return {
          leaseId: 'lease-1', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
      },
      async release() { return { status: 'released' }; },
    },
  });

  assert.equal(artifact.decision.code, 'authorization-denied');
  assert.equal(productCalls, 0);
  assert.equal(artifact.lease.status, 'released');
});

test('does not acquire a lease when authorization expires during preflight', async () => {
  const clock = createClock();
  const options = baseOptions(clock);
  let acquireCalls = 0;
  const artifact = await coordinateQuickProof({
    ...options,
    authorization: {
      ...options.authorization,
      expiresAt: '2026-08-10T00:00:00.100Z',
    },
    adapters: [baseAdapter({
      async preflight() {
        clock.advance(200);
        return { status: 'passed', identities: [observedIdentity()] };
      },
    })],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        acquireCalls += 1;
        return {
          leaseId: 'lease-1', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
      },
      async release() { return { status: 'released' }; },
    },
  });

  assert.equal(acquireCalls, 0);
  assert.equal(artifact.decision.code, 'authorization-denied');
  assert.equal(artifact.authorization.status, 'denied');
  assert.equal(artifact.lease.status, 'not-acquired');
  assert.equal(artifact.product.started, false);
});

test('emits schema-valid authorization denial when authorization validation times out', async (t: TestContext) => {
  await t.test('initial validation', async () => {
    let acquireCalls = 0;
    const artifact = await coordinateQuickProof(baseOptions(createClock(), {
      now: Date.now,
      budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
      authorization: {
        grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
        expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
        targetResource: 'mobile-target:ios:device-1',
      },
      authorizationPort: {
        async validate(input: { signal: AbortSignal }) {
          return new Promise((_resolve) => {
            input.signal.addEventListener('abort', () => undefined);
          });
        },
      },
      leasePort: {
        async acquire() {
          acquireCalls += 1;
          throw new Error('lease acquisition must not run');
        },
        async release() { return { status: 'released' }; },
      },
    }));

    assert.equal(acquireCalls, 0);
    assert.equal(artifact.authorization.status, 'denied');
    assert.equal(artifact.decision.code, 'authorization-denied');
    assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'initial authorization timeout').valid, true);
  });

  await t.test('pre-lease revalidation', async () => {
    let authorizationCalls = 0;
    let acquireCalls = 0;
    const artifact = await coordinateQuickProof(baseOptions(createClock(), {
      now: Date.now,
      budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
      authorization: {
        grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
        expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
        targetResource: 'mobile-target:ios:device-1',
      },
      authorizationPort: {
        async validate(input: { signal: AbortSignal }) {
          authorizationCalls += 1;
          if (authorizationCalls === 1) {
            return { status: 'authorized' as const };
          }
          return new Promise((_resolve) => {
            input.signal.addEventListener('abort', () => undefined);
          });
        },
      },
      leasePort: {
        async acquire() {
          acquireCalls += 1;
          throw new Error('lease acquisition must not run');
        },
        async release() { return { status: 'released' }; },
      },
    }));

    assert.equal(authorizationCalls, 2);
    assert.equal(acquireCalls, 0);
    assert.equal(artifact.authorization.status, 'denied');
    assert.equal(artifact.decision.code, 'authorization-denied');
    assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'pre-lease authorization timeout').valid, true);
  });

  await t.test('post-lease revalidation releases ownership', async () => {
    let authorizationCalls = 0;
    let acquireCalls = 0;
    let releaseCalls = 0;
    const artifact = await coordinateQuickProof(baseOptions(createClock(), {
      now: Date.now,
      budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
      authorization: {
        grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
        expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
        targetResource: 'mobile-target:ios:device-1',
      },
      authorizationPort: {
        async validate(input: { signal: AbortSignal }) {
          authorizationCalls += 1;
          if (authorizationCalls < 3) {
            return { status: 'authorized' as const };
          }
          return new Promise((_resolve) => {
            input.signal.addEventListener('abort', () => undefined);
          });
        },
      },
      leasePort: {
        async acquire({ resource }: { resource: string }) {
          acquireCalls += 1;
          return {
            leaseId: 'lease-1', resource, status: 'trusted' as const,
            acquiredAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z',
          };
        },
        async release() {
          releaseCalls += 1;
          return { status: 'released' as const };
        },
      },
    }));

    assert.equal(authorizationCalls, 3);
    assert.equal(acquireCalls, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(artifact.authorization.status, 'denied');
    assert.equal(artifact.decision.code, 'authorization-denied');
    assert.equal(artifact.lease.status, 'released');
    assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'post-lease authorization timeout').valid, true);
  });

  await t.test('mutable-boundary revalidation is explicitly accounted', async () => {
    let authorizationCalls = 0;
    let fallbackCalls = 0;
    const artifact = await coordinateQuickProof(baseOptions(createClock(), {
      now: Date.now,
      targetResource: undefined,
      leasePort: undefined,
      budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
      authorization: {
        grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
        expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
      },
      authorizationPort: {
        async validate(input: { signal: AbortSignal }) {
          authorizationCalls += 1;
          if (authorizationCalls < 3) {
            return { status: 'authorized' as const };
          }
          return new Promise((_resolve) => {
            input.signal.addEventListener('abort', () => undefined);
          });
        },
      },
      adapters: [
        baseAdapter(),
        baseAdapter({
          id: 'direct', tier: 'degraded-direct',
          async runProduct() {
            fallbackCalls += 1;
            return { status: 'passed', productActionStarted: true };
          },
        }),
      ],
    }));

    assert.equal(authorizationCalls, 3);
    assert.equal(fallbackCalls, 0);
    assert.equal(artifact.authorization.status, 'denied');
    assert.equal(artifact.decision.code, 'authorization-denied');
    assert.equal(artifact.product.started, false);
    assert.equal(artifact.phases.some((phase: { name: string; status: string }) =>
      phase.name === 'mutable-boundary-authorization' && phase.status === 'failed'), true);
    assert.equal(artifact.phases.some((phase: { name: string; status: string }) =>
      phase.name === 'mutable-boundary-validation' && phase.status === 'failed'), true);
    assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'mutable-boundary authorization timeout').valid, true);
  });
});

test('turns a malformed custom authorization result into durable denied evidence', async () => {
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    authorizationPort: { async validate() { return {} as never; } },
  }));

  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.authorization.status, 'denied');
  assert.equal(artifact.decision.code, 'authorization-denied');
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'quick proof').valid, true);
});

test('revalidates budget, authorization, and lease at the actual mutable boundary', async (t: TestContext) => {
  await t.test('setup deadline equality', async () => {
    const clock = createClock();
    const artifact = await coordinateQuickProof(baseOptions(clock, {
      targetResource: undefined,
      leasePort: undefined,
      budgets: { setupMs: 100, totalMs: 1000, minimumProductRatio: 0.5 },
      authorization: {
        grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
        expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
      },
      adapters: [baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          clock.advance(100);
          await context.beginProductAction?.();
          return { status: 'passed', productActionStarted: true };
        },
      })],
    }));
    assert.equal(artifact.decision.code, 'setup-budget-exceeded');
    assert.equal(artifact.product.started, false);
  });

  await t.test('authorization expiry', async () => {
    const clock = createClock();
    const options = baseOptions(clock);
    const artifact = await coordinateQuickProof({
      ...options,
      authorization: { ...options.authorization, expiresAt: '2026-08-10T00:00:00.100Z' },
      adapters: [baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          clock.advance(100);
          await context.beginProductAction?.();
          return { status: 'passed', productActionStarted: true };
        },
      })],
    });
    assert.equal(artifact.decision.code, 'authorization-denied');
    assert.equal(artifact.product.started, false);
  });

  await t.test('lease expiry', async () => {
    const clock = createClock();
    const artifact = await coordinateQuickProof(baseOptions(clock, {
      adapters: [baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          clock.advance(100);
          await context.beginProductAction?.();
          return { status: 'passed', productActionStarted: true };
        },
      })],
      leasePort: {
        async acquire({ resource }: { resource: string }) {
          return {
            leaseId: 'lease-short', resource, status: 'trusted',
            acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:00:00.100Z',
          };
        },
        async release() { return { status: 'released' }; },
      },
    }));
    assert.equal(artifact.decision.code, 'lease-unavailable');
    assert.equal(artifact.product.started, false);
    assert.equal(artifact.lease.status, 'released');
  });
});

test('makes concurrent mutable-boundary calls single-flight and idempotent', async () => {
  let authorizationCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    authorizationPort: {
      async validate() {
        authorizationCalls += 1;
        await Promise.resolve();
        return authorizationCalls <= 3
          ? { status: 'authorized' }
          : { status: 'denied', reason: 'unexpected duplicate boundary validation' };
      },
    },
    adapters: [baseAdapter({
      async runProduct(context: { beginProductAction: () => Promise<void> }) {
        await Promise.all([context.beginProductAction(), context.beginProductAction()]);
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(authorizationCalls, 3);
  assert.equal(artifact.decision.code, 'product-completed');
  assert.equal(artifact.phases.filter((phase: { name: string }) => phase.name === 'mutable-boundary-validation').length, 1);
});

test('fails closed for missing, untrusted, and target-mismatched leases', async (t: TestContext) => {
  const cases: Array<[string, unknown]> = [
    ['missing port', undefined],
    ['untrusted', {
      async acquire({ resource }: { resource: string }) {
        return { leaseId: 'lease-1', resource, status: 'untrusted', acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z', reason: 'untrusted' };
      },
      async release() { return { status: 'released' }; },
    }],
    ['target mismatch', {
      async acquire() {
        return { leaseId: 'lease-1', resource: 'other', status: 'trusted', acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z' };
      },
      async release() { return { status: 'released' }; },
    }],
  ];
  for (const [name, leasePort] of cases) {
    await t.test(name, async () => {
      const clock = createClock();
      const artifact = await coordinateQuickProof(baseOptions(clock, { leasePort }));
      assert.equal(artifact.decision.code, 'lease-unavailable');
      assert.equal(artifact.product.started, false);
    });
  }
});

test('releases acquired untrusted leases and rejects expired trusted leases', async (t: TestContext) => {
  await t.test('untrusted lease', async () => {
    const clock = createClock();
    let releaseCalls = 0;
    const artifact = await coordinateQuickProof(baseOptions(clock, {
      leasePort: {
        async acquire({ resource }: { resource: string }) {
          return {
            leaseId: 'lease-untrusted', resource, status: 'untrusted', reason: 'durability not proven',
            acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
          };
        },
        async release() {
          releaseCalls += 1;
          return { status: 'released' };
        },
      },
    }));
    assert.equal(artifact.decision.code, 'lease-unavailable');
    assert.equal(releaseCalls, 2);
  });

  await t.test('expired lease', async () => {
    const clock = createClock();
    const artifact = await coordinateQuickProof(baseOptions(clock, {
      leasePort: {
        async acquire({ resource }: { resource: string }) {
          return {
            leaseId: 'lease-expired', resource, status: 'trusted',
            acquiredAt: '2026-08-09T00:00:00.000Z', expiresAt: '2026-08-09T01:00:00.000Z',
          };
        },
        async release() { return { status: 'released' }; },
      },
    }));
    assert.equal(artifact.decision.code, 'lease-unavailable');
    assert.equal(artifact.product.started, false);
  });
});

test('does not reuse identity observations across adapter paths', async () => {
  const clock = createClock();
  let directProductCalls = 0;
  const commonAuthorization = {
    grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
    expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
  };
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    targetResource: undefined,
    authorization: commonAuthorization,
    leasePort: undefined,
    adapters: [
      baseAdapter({
        id: 'trusted',
        async discover() {
          return {
            status: 'passed',
            capabilities: [{ operation: 'inspect', supportedArguments: [] }],
            identities: [observedIdentity()],
          };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async preflight() { return { status: 'passed', identities: [] }; },
        async runProduct() {
          directProductCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(directProductCalls, 0);
  assert.equal(artifact.decision.code, 'identity-unresolved');
});

test('does not retry another adapter attempt after a terminal identity mismatch', async () => {
  let discoveryCalls = 0;
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    requirements: {
      operations: [{ operation: 'inspect', requiredArguments: ['target'] }],
      identities: [{ name: 'target', expected: 'device-1' }],
    },
    adapters: [baseAdapter({
      async discover() {
        discoveryCalls += 1;
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [{
            name: 'target', status: 'observed', expected: 'device-1',
            observed: discoveryCalls === 1 ? 'device-2' : 'device-1',
          }],
        };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(discoveryCalls, 1);
  assert.equal(productCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'identity-unresolved');
  assert.equal(artifact.identities[0]?.status, 'mismatched');
});

test('preserves a terminal identity mismatch returned by failed preflight', async () => {
  let preflightCalls = 0;
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [{ name: 'target', status: 'unresolved-until-observed', expected: 'device-1' }],
        };
      },
      async preflight() {
        preflightCalls += 1;
        return {
          status: 'failed',
          identities: [{
            name: 'target', status: 'observed', expected: 'device-1', observed: 'device-2',
          }],
          reason: 'wrong target',
        };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(preflightCalls, 1);
  assert.equal(productCalls, 0);
  assert.equal(artifact.decision.code, 'identity-unresolved');
  assert.equal(artifact.identities[0]?.status, 'mismatched');
  assert.equal(artifact.identityObservations.some((identity: { phase: string; status: string }) =>
    identity.phase === 'preflight' && identity.status === 'mismatched'), true);
});

test('malformed adapter output fails closed and still runs cleanup', async () => {
  const clock = createClock();
  let cleanupCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [baseAdapter({
      async discover() {
        return { status: 'passed', capabilities: null, identities: [] };
      },
      async cleanup() {
        cleanupCalls += 1;
        return { status: 'passed' };
      },
    })],
  }));

  assert.equal(cleanupCalls, 2);
  assert.equal(artifact.status, 'setup-only');
  assert.match(artifact.decision.reason, /malformed/u);
});

test('distinguishes valid reasonless negative states from malformed output', async (t: TestContext) => {
  const cases: Array<{
    name: string;
    phaseName: string;
    options: () => Record<string, unknown>;
  }> = [
    {
      name: 'authorization denied',
      phaseName: 'authorization',
      options: () => ({
        authorizationPort: { async validate() { return { status: 'denied' }; } },
      }),
    },
    {
      name: 'capability discovery failed',
      phaseName: 'capability-discovery',
      options: () => ({
        adapters: [baseAdapter({
          async discover() { return { status: 'failed', capabilities: [], identities: [] }; },
        })],
      }),
    },
    {
      name: 'preflight failed',
      phaseName: 'preflight',
      options: () => ({
        adapters: [baseAdapter({
          async preflight() { return { status: 'failed', identities: [] }; },
        })],
      }),
    },
    {
      name: 'authorization revalidation denied',
      phaseName: 'authorization-pre-lease-revalidation',
      options: () => {
        let calls = 0;
        return {
          authorizationPort: {
            async validate() {
              calls += 1;
              return calls === 1 ? { status: 'authorized' } : { status: 'denied' };
            },
          },
        };
      },
    },
    {
      name: 'cleanup failed',
      phaseName: 'adapter-cleanup',
      options: () => ({
        adapters: [baseAdapter({ async cleanup() { return { status: 'failed' }; } })],
      }),
    },
    {
      name: 'lease release failed',
      phaseName: 'lease-release',
      options: () => ({
        leasePort: {
          async acquire({ resource }: { resource: string }) {
            return {
              leaseId: 'lease-1', resource, status: 'trusted',
              acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
            };
          },
          async release() { return { status: 'failed' }; },
        },
      }),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const artifact = await coordinateQuickProof(baseOptions(createClock(), entry.options()));
      const phase = artifact.phases.find((candidate: { name: string }) => candidate.name === entry.phaseName);
      assert.ok(phase);
      assert.equal(phase.status, 'failed');
      assert.doesNotMatch(phase.reason, /malformed/u);
    });
  }
});

test('falls back deterministically from trusted to direct before product action', async () => {
  const clock = createClock();
  const order: string[] = [];
  const failing = baseAdapter({
    id: 'trusted',
    async discover() {
      return {
        status: 'passed',
        capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
        identities: [{ name: 'target', status: 'unresolved-until-observed', expected: 'device-1' }],
      };
    },
    async preflight() {
      order.push('trusted');
      return { status: 'failed', identities: [], reason: 'bridge unavailable' };
    },
  });
  const direct = baseAdapter({
    id: 'direct', tier: 'degraded-direct',
    async runProduct(context: { beginProductAction?: () => Promise<void> }) {
      order.push('direct');
      await context.beginProductAction?.();
      return { status: 'passed', productActionStarted: true };
    },
  });
  const artifact = await coordinateQuickProof(baseOptions(clock, { adapters: [direct, failing] }));

  assert.deepEqual(order, ['trusted', 'trusted', 'direct']);
  assert.equal(artifact.proofTier, 'degraded-direct');
  assert.equal(artifact.adapters.find((adapter: { adapterId: string }) => adapter.adapterId === 'direct')?.status, 'selected');
  assert.equal(artifact.identityObservations.some((identity: { adapterId: string; status: string }) =>
    identity.adapterId === 'trusted' && identity.status === 'unresolved-until-observed'), true);
  assert.equal(artifact.identityObservations.some((identity: { adapterId: string; status: string }) =>
    identity.adapterId === 'direct' && identity.status === 'observed'), true);
  assert.equal(artifact.identityObservations.some((identity: { adapterId: string; phase: string }) =>
    identity.adapterId === 'trusted' && identity.phase === 'preflight'), false);
});

test('selects explicit manual-required setup-only evidence after automated paths fail', async () => {
  const clock = createClock();
  const failing = baseAdapter({
    async preflight() { return { status: 'failed', identities: [], reason: 'no target' }; },
  });
  const manual = baseAdapter({ id: 'manual', tier: 'manual-assisted' });
  const artifact = await coordinateQuickProof(baseOptions(clock, { adapters: [manual, failing] }));

  assert.equal(artifact.decision.code, 'manual-required');
  assert.equal(artifact.proofTier, 'manual-assisted');
  assert.equal(artifact.product.started, false);
});

test('never retries or falls back after any product action starts', async () => {
  const clock = createClock();
  let trustedCalls = 0;
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [
      baseAdapter({
        async runProduct() {
          trustedCalls += 1;
          return { status: 'failed', productActionStarted: true, reason: 'product failed after launch' };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(trustedCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.decision.code, 'product-failed');
  assert.equal(artifact.status, 'product-executed');
});

test('treats an exception after boundary validation as an unknown mutation state', async () => {
  const clock = createClock();
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          await context.beginProductAction?.();
          throw new Error('transport disconnected after invocation');
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'inconclusive');
  assert.equal(artifact.product.started, 'unknown');
  assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
  assert.match(buildQuickProofSummary(artifact), /Time to first product action: unknown/u);
});

test('does not promote boundary validation without adapter-confirmed mutation', async () => {
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction: () => Promise<void> }) {
          await context.beginProductAction();
          return { status: 'passed', productActionStarted: false };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'inconclusive');
  assert.equal(artifact.product.started, 'unknown');
  assert.equal(artifact.proofTier, null);
});

test('does not retry malformed product output that reports an unmarked mutation', async () => {
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [
      baseAdapter({
        async runProduct() { return { status: 'unknown', productActionStarted: true }; },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'product-executed');
  assert.equal(artifact.product.status, 'failed');
  assert.equal(artifact.decision.code, 'product-failed');
  assert.match(artifact.decision.reason, /without passing the mutable-boundary/u);
});

test('does not retry or fall back when product-start state is unknown', async (t: TestContext) => {
  for (const [name, runProduct] of [
    ['throw', async () => { throw new Error('ambiguous product failure'); }],
    ['malformed result', async () => ({ status: 'unknown' })],
  ] as const) {
    await t.test(name, async () => {
      let fallbackCalls = 0;
      const artifact = await coordinateQuickProof(baseOptions(createClock(), {
        targetResource: undefined,
        leasePort: undefined,
        authorization: {
          grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
          expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
        },
        adapters: [
          baseAdapter({ runProduct }),
          baseAdapter({
            id: 'direct', tier: 'degraded-direct',
            async runProduct() {
              fallbackCalls += 1;
              return { status: 'passed', productActionStarted: true };
            },
          }),
        ],
      }));

      assert.equal(fallbackCalls, 0);
      assert.equal(artifact.status, 'inconclusive');
      assert.equal(artifact.product.started, 'unknown');
      assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
      assert.match(artifact.decision.reason, /Product-start state is unknown/u);
      assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'unknown product start').valid, true);
    });
  }
});

test('preserves an observed-late mutation even when boundary validation was rejected', async () => {
  const clock = createClock();
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    targetResource: undefined,
    leasePort: undefined,
    budgets: { setupMs: 100, totalMs: 1000, minimumProductRatio: 0.5 },
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          clock.advance(100);
          try { await context.beginProductAction?.(); } catch { /* Adapter violated the boundary below. */ }
          return { status: 'failed', productActionStarted: true };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'product-executed');
  assert.equal(artifact.product.timingStatus, 'observed-late');
  assert.equal(artifact.product.startedAt, undefined);
  assert.equal(artifact.budgets.timeToFirstProductActionMs, null);
  assert.equal(artifact.budgets.setupDurationMs, null);
  assert.match(buildQuickProofSummary(artifact), /Time to first product action: observed late; exact time unknown/u);
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'observed-late quick proof').valid, true);
});

test('preserves a schema-valid observed-late mutation after boundary authorization revocation', async () => {
  let authorizationCalls = 0;
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    authorizationPort: {
      async validate() {
        authorizationCalls += 1;
        return authorizationCalls < 3
          ? { status: 'authorized' }
          : { status: 'denied', reason: 'authorization revoked' };
      },
    },
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          try { await context.beginProductAction?.(); } catch { /* Adapter violated the rejected boundary below. */ }
          return { status: 'failed', productActionStarted: true };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(authorizationCalls, 3);
  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'product-executed');
  assert.equal(artifact.authorization.status, 'denied');
  assert.equal(artifact.product.timingStatus, 'observed-late');
  assert.equal(artifact.product.status, 'failed');
  assert.equal(artifact.decision.code, 'product-failed');
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'revoked observed-late quick proof').valid, true);
});

test('terminalizes a thrown mutable-boundary authorization check even when the adapter catches it', async () => {
  let authorizationCalls = 0;
  let productCalls = 0;
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    authorizationPort: {
      async validate() {
        authorizationCalls += 1;
        if (authorizationCalls === 3) {
          throw new Error('authorization service unavailable');
        }
        return { status: 'authorized' };
      },
    },
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          productCalls += 1;
          try { await context.beginProductAction?.(); } catch { /* The coordinator must retain the denial. */ }
          return { status: 'failed', productActionStarted: false };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(authorizationCalls, 3);
  assert.equal(productCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.authorization.status, 'denied');
  assert.equal(artifact.decision.code, 'authorization-denied');
  assert.equal(artifact.phases.some((phase: { name: string; status: string; reason: string }) =>
    phase.name === 'mutable-boundary-validation' && phase.status === 'failed' &&
    /authorization service unavailable/u.test(phase.reason)), true);
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'thrown boundary authorization').valid, true);
});

test('rejects malformed public identifiers and resources before adapter execution', async (t: TestContext) => {
  const cases: Array<[string, (options: ReturnType<typeof baseOptions>) => void, RegExp]> = [
    ['empty run id', (options) => { options.runId = ''; }, /runId/u],
    ['empty grant id', (options) => { options.authorization.grantId = ''; }, /authorization\.grantId/u],
    ['empty resource', (options) => { options.targetResource = ''; }, /targetResource/u],
    ['empty operation', (options) => { options.requirements.operations[0]!.operation = ''; }, /requirements\.operations/u],
    ['empty adapter id', (options) => { options.adapters[0]!.id = ''; }, /adapters\[0\]\.id/u],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      let discoveryCalls = 0;
      const options = baseOptions(createClock(), {
        adapters: [baseAdapter({
          async discover() {
            discoveryCalls += 1;
            return { status: 'passed', capabilities: [], identities: [] };
          },
        })],
      });
      mutate(options);
      await assert.rejects(coordinateQuickProof(options), expected);
      assert.equal(discoveryCalls, 0);
    });
  }
});

test('requires exact source and package identity before adapter execution', async () => {
  const options = baseOptions(createClock());
  options.source.packageIntegrity = '';
  await assert.rejects(coordinateQuickProof(options), /source\.packageIntegrity/u);

  const unexpected = baseOptions(createClock());
  (unexpected.source as Record<string, unknown>).secret = 'must-not-leak';
  await assert.rejects(coordinateQuickProof(unexpected), /documented credential-free identity fields/u);
});

test('isolates authorization, requirements, and lease snapshots from adapter mutation', async () => {
  let fallbackContextChecked = false;
  const clock = createClock();
  const options = baseOptions(clock, {
    adapters: [
      baseAdapter({
        async discover(context: {
          authorization: { operations: string[] };
          requirements: Array<{ operation: string; requiredArguments: string[] }>;
        }) {
          context.authorization.operations.push('destructive-operation');
          context.requirements[0]!.operation = 'mutated-operation';
          context.requirements[0]!.requiredArguments.push('mutated-argument');
          return { status: 'failed', capabilities: [], identities: [], reason: 'force fallback' };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async discover(context: {
          authorization: { operations: string[] };
          requirements: Array<{ operation: string; requiredArguments: string[] }>;
        }) {
          assert.deepEqual(context.authorization.operations, ['inspect']);
          assert.deepEqual(context.requirements, [{ operation: 'inspect', requiredArguments: ['target'] }]);
          fallbackContextChecked = true;
          return {
            status: 'passed',
            capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
            identities: [],
          };
        },
      }),
    ],
  });

  const artifact = await coordinateQuickProof(options);

  assert.equal(fallbackContextChecked, true);
  assert.deepEqual(options.authorization.operations, ['inspect']);
  assert.deepEqual(options.requirements.operations, [{ operation: 'inspect', requiredArguments: ['target'] }]);
  assert.equal(artifact.decision.code, 'product-completed');
});

test('rejects malformed adapter identities before product execution', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [{ name: '', status: 'observed', observed: 'device-1', extra: 'not-public' }],
        };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'capability-unavailable');
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'malformed identity quick proof').valid, true);
});

test('copies accepted identity and lease evidence before external cleanup mutation', async () => {
  const identity = observedIdentity();
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({
      async preflight() {
        return { status: 'passed', identities: [identity] };
      },
      async cleanup() {
        identity.name = '';
        return { status: 'passed' };
      },
    })],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        return {
          leaseId: 'lease-1', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
      },
      async release(reference: { leaseId: string }) {
        reference.leaseId = '';
        return { status: 'released' };
      },
    },
  }));

  assert.equal(artifact.identities[0]?.name, 'target');
  assert.equal(artifact.lease.leaseId, 'lease-1');
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'copied evidence quick proof').valid, true);
});

test('invalidates a retained mutable-boundary callback when its attempt ends', async () => {
  let retainedBoundary: (() => Promise<void>) | undefined;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          retainedBoundary = context.beginProductAction;
          return { status: 'failed', productActionStarted: false };
        },
      }),
      baseAdapter({ id: 'manual', tier: 'manual-assisted' }),
    ],
  }));

  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'manual-required');
  assert.equal(typeof retainedBoundary, 'function');
  await assert.rejects((retainedBoundary as () => Promise<void>)(), /no longer active/u);
});

test('invalidates a retained successful mutable-boundary callback after cleanup', async () => {
  let retainedBoundary: (() => Promise<void>) | undefined;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    adapters: [baseAdapter({
      async runProduct(context: { beginProductAction: () => Promise<void> }) {
        retainedBoundary = context.beginProductAction;
        await context.beginProductAction();
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(artifact.status, 'product-executed');
  assert.equal(artifact.decision.code, 'product-completed');
  assert.equal(typeof retainedBoundary, 'function');
  await assert.rejects((retainedBoundary as () => Promise<void>)(), /no longer active/u);
});

test('normalizes empty external reasons before durable evidence', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({
      async discover() {
        return { status: 'failed', capabilities: [], identities: [], reason: '' };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.match(artifact.decision.reason, /malformed/u);
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'empty reason quick proof').valid, true);
});

test('snapshots authorization and lease port methods before adapter execution', async () => {
  const authorizationPort = {
    async validate() { return { status: 'authorized' }; },
  };
  const leasePort = {
    async acquire({ resource }: { resource: string }) {
      return {
        leaseId: 'lease-1', resource, status: 'trusted',
        acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
      };
    },
    async release() { return { status: 'released' }; },
  };
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    authorizationPort,
    leasePort,
    adapters: [baseAdapter({
      async discover() {
        authorizationPort.validate = async () => ({ status: 'denied' });
        leasePort.acquire = async () => { throw new Error('mutated acquire'); };
        leasePort.release = async () => { throw new Error('mutated release'); };
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [],
        };
      },
    })],
  }));

  assert.equal(artifact.decision.code, 'product-completed');
  assert.equal(artifact.lease.status, 'released');
});

test('rejects lease results with undeclared fields before adapter product work', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        return {
          leaseId: 'lease-1', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
          secret: 'must-not-reach-adapter',
        } as never;
      },
      async release() { return { status: 'released' }; },
    },
    adapters: [baseAdapter({
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.decision.code, 'lease-unavailable');
  assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'strict lease quick proof').valid, true);
});

test('normalizes empty thrown values in setup and product phases', async (t: TestContext) => {
  await t.test('setup', async () => {
    const artifact = await coordinateQuickProof(baseOptions(createClock(), {
      adapters: [baseAdapter({ async discover() { throw ''; } })],
    }));
    assert.match(artifact.decision.reason, /failed without a reason/u);
    assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'empty setup throw quick proof').valid, true);
  });

  await t.test('product', async () => {
    const artifact = await coordinateQuickProof(baseOptions(createClock(), {
      adapters: [baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void> }) {
          await context.beginProductAction?.();
          throw '';
        },
      })],
    }));
    assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
    assert.equal(artifact.status, 'inconclusive');
    assert.match(artifact.decision.reason, /failed without a reason/u);
    assert.equal(validateJson(artifact, SCHEMAS.quickProof, 'empty product throw quick proof').valid, true);
  });
});

test('preserves coordinator-owned expected identity and rejects adapter conflicts', async () => {
  let productCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    requirements: {
      operations: [{ operation: 'inspect', requiredArguments: ['target'] }],
      identities: [{ name: 'target', expected: 'right-target' }],
    },
    adapters: [baseAdapter({
      async discover() {
        return {
          status: 'passed',
          capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
          identities: [{ name: 'target', status: 'observed', expected: 'wrong-target', observed: 'right-target' }],
        };
      },
      async preflight() {
        return { status: 'passed', identities: [{ name: 'target', status: 'observed', observed: 'right-target' }] };
      },
      async runProduct() {
        productCalls += 1;
        return { status: 'passed', productActionStarted: true };
      },
    })],
  }));

  assert.equal(productCalls, 0);
  assert.equal(artifact.decision.code, 'identity-unresolved');
  assert.equal(artifact.identities[0]?.expected, 'right-target');
  assert.equal(artifact.identities[0]?.status, 'mismatched');
});

test('does not count or clean up a retry blocked by the opening budget gate', async () => {
  const clock = createClock();
  let discoveryCalls = 0;
  let cleanupCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    budgets: { setupMs: 100, totalMs: 1000, minimumProductRatio: 0.5 },
    adapters: [baseAdapter({
      async discover() {
        discoveryCalls += 1;
        clock.advance(100);
        return { status: 'failed', capabilities: [], identities: [], reason: 'first attempt unavailable' };
      },
      async cleanup() {
        cleanupCalls += 1;
        return { status: 'passed' };
      },
    })],
  }));

  assert.equal(discoveryCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(artifact.adapters[0]?.attempts, 1);
  assert.equal(artifact.decision.code, 'setup-budget-exceeded');
});

test('bounds adapter work before the mutable boundary by the setup deadline', async () => {
  let aborted = false;
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
    },
    budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
    adapters: [
      baseAdapter({
        async runProduct(context: { signal?: AbortSignal }) {
          return new Promise((_resolve) => {
            context.signal?.addEventListener('abort', () => { aborted = true; });
          });
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(aborted, true);
  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'inconclusive');
  assert.equal(artifact.product.started, 'unknown');
  assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
});

test('aborts a hanging setup phase at the real setup deadline', async () => {
  let aborted = false;
  let productCalls = 0;
  const startedAt = Date.now();
  const artifact = await coordinateQuickProof({
    ...baseOptions(createClock(), {
      now: Date.now,
      targetResource: undefined,
      leasePort: undefined,
      authorization: {
        grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
        expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
      },
      budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
      adapters: [baseAdapter({
        async discover(context: { signal?: AbortSignal }) {
          return new Promise((_resolve) => {
            context.signal?.addEventListener('abort', () => { aborted = true; });
          });
        },
        async runProduct() {
          productCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      })],
    }),
  });

  assert.equal(aborted, true);
  assert.equal(productCalls, 0);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'setup-budget-exceeded');
  assert.ok(Date.now() - startedAt < 500);
});

test('terminalizes a hanging preflight as a setup deadline rather than an identity failure', async () => {
  let aborted = false;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
    },
    budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0.5 },
    adapters: [baseAdapter({
      async preflight(context: { signal?: AbortSignal }) {
        return new Promise((_resolve) => {
          context.signal?.addEventListener('abort', () => { aborted = true; });
        });
      },
    })],
  }));

  assert.equal(aborted, true);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'setup-budget-exceeded');
});

test('does not trust adapter-supplied timeout-like text as coordinator timeout provenance', async () => {
  let discoveryCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({
      async discover() {
        discoveryCalls += 1;
        return {
          status: 'failed', capabilities: [], identities: [],
          reason: 'capability-discovery exceeded its 20 ms deadline',
        };
      },
    })],
  }));

  assert.equal(discoveryCalls, 2);
  assert.equal(artifact.status, 'setup-only');
  assert.equal(artifact.decision.code, 'capability-unavailable');
});

test('aborts a hanging product phase without retry or fallback', async () => {
  let productAborted = false;
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
    },
    budgets: { setupMs: 30, totalMs: 40, minimumProductRatio: 0 },
    adapters: [
      baseAdapter({
        async runProduct(context: { beginProductAction?: () => Promise<void>; signal?: AbortSignal }) {
          await context.beginProductAction?.();
          return new Promise((_resolve) => {
            context.signal?.addEventListener('abort', () => { productAborted = true; });
          });
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async runProduct() {
          fallbackCalls += 1;
          return { status: 'passed', productActionStarted: true };
        },
      }),
    ],
  }));

  assert.equal(productAborted, true);
  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.status, 'inconclusive');
  assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
});

test('preserves adapter cleanup and lease release failures after product execution', async () => {
  const clock = createClock();
  const artifact = await coordinateQuickProof(baseOptions(clock, {
    adapters: [baseAdapter({
      async cleanup() { return { status: 'failed', reason: 'adapter cleanup failed' }; },
    })],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        return { leaseId: 'lease-1', resource, status: 'trusted', acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z' };
      },
      async release() { return { status: 'failed', reason: 'lease release failed' }; },
    },
  }));

  assert.equal(artifact.decision.code, 'product-completed');
  assert.equal(artifact.cleanup.status, 'failed');
  assert.equal(artifact.cleanup.failures.length, 2);
  assert.equal(artifact.lease.status, 'release-failed');
});

test('blocks adapter fallback when cleanup fails before product execution', async () => {
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    targetResource: undefined,
    leasePort: undefined,
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2026-08-10T01:00:00.000Z', delegationChain: ['cos'],
    },
    adapters: [
      baseAdapter({
        async discover() { return { status: 'failed', reason: 'trusted discovery failed' }; },
        async cleanup() { return { status: 'failed', reason: 'trusted cleanup failed' }; },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async discover() {
          fallbackCalls += 1;
          return {
            status: 'passed',
            capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
            identities: [],
          };
        },
      }),
    ],
  }));

  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
  assert.match(artifact.decision.reason, /fallback is blocked/u);
  assert.equal(artifact.cleanup.status, 'failed');
});

test('blocks adapter fallback when a trusted lease cannot be released', async () => {
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [
      baseAdapter({
        async runProduct() {
          return { status: 'failed', productActionStarted: false, reason: 'trusted path unavailable' };
        },
      }),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async discover() {
          fallbackCalls += 1;
          return {
            status: 'passed',
            capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
            identities: [],
          };
        },
      }),
    ],
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        return {
          leaseId: 'lease-1', resource, status: 'trusted',
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
      },
      async release() { return { status: 'failed', reason: 'lease release failed' }; },
    },
  }));

  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.decision.code, 'adapter-paths-exhausted');
  assert.match(artifact.decision.reason, /fallback is blocked/u);
  assert.equal(artifact.lease.status, 'release-failed');
  assert.equal(artifact.cleanup.status, 'failed');
});

test('releases ownership registered by a lease acquisition that times out', async () => {
  let releaseCalls = 0;
  let fallbackCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    budgets: { setupMs: 20, totalMs: 100, minimumProductRatio: 0 },
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
      targetResource: 'mobile-target:ios:device-1',
    },
    adapters: [
      baseAdapter(),
      baseAdapter({
        id: 'direct', tier: 'degraded-direct',
        async discover() {
          fallbackCalls += 1;
          return {
            status: 'passed',
            capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }],
            identities: [],
          };
        },
      }),
    ],
    leasePort: {
      async acquire(input: {
        resource: string;
        signal: AbortSignal;
        registerAcquiredLease(lease: {
          leaseId: string; resource: string; status: 'trusted'; acquiredAt: string; expiresAt: string;
        }): void;
      }) {
        input.registerAcquiredLease({
          leaseId: 'lease-late', resource: input.resource, status: 'trusted',
          acquiredAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z',
        });
        return new Promise((_resolve) => {
          input.signal.addEventListener('abort', () => undefined);
        });
      },
      async release(lease: { leaseId: string }) {
        releaseCalls += 1;
        assert.equal(lease.leaseId, 'lease-late');
        return { status: 'released' };
      },
    },
  }));

  assert.equal(releaseCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(artifact.lease.status, 'released');
  assert.equal(artifact.decision.code, 'setup-budget-exceeded');
});

test('releases ownership registered after lease acquisition times out', async () => {
  const released: string[] = [];
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    budgets: { setupMs: 10, totalMs: 100, minimumProductRatio: 0 },
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
      targetResource: 'mobile-target:ios:device-1',
    },
    leasePort: {
      async acquire(input: {
        resource: string;
        signal: AbortSignal;
        registerAcquiredLease(lease: {
          leaseId: string; resource: string; status: 'trusted'; acquiredAt: string; expiresAt: string;
        }): void;
      }) {
        return new Promise((resolve) => {
          input.signal.addEventListener('abort', () => {
            setTimeout(() => {
              const lease = {
                leaseId: 'lease-after-timeout', resource: input.resource, status: 'trusted' as const,
                acquiredAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z',
              };
              input.registerAcquiredLease(lease);
              resolve(lease);
            }, 5);
          });
        });
      },
      async release(lease: { leaseId: string }) {
        released.push(lease.leaseId);
        return { status: 'released' };
      },
    },
  }));

  assert.deepEqual(released, ['lease-after-timeout']);
  assert.equal(artifact.lease.status, 'released');
  assert.equal(artifact.cleanup.status, 'passed');
});

test('releases ownership returned after timeout even when the lease port omitted registration', async () => {
  const released: string[] = [];
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    budgets: { setupMs: 10, totalMs: 100, minimumProductRatio: 0 },
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
      targetResource: 'mobile-target:ios:device-1',
    },
    leasePort: {
      async acquire(input: { resource: string; signal: AbortSignal }) {
        return new Promise((resolve) => {
          input.signal.addEventListener('abort', () => {
            setTimeout(() => resolve({
              leaseId: 'lease-returned-after-timeout', resource: input.resource, status: 'trusted' as const,
              acquiredAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z',
            }), 5);
          });
        });
      },
      async release(lease: { leaseId: string }) {
        released.push(lease.leaseId);
        return { status: 'released' };
      },
    },
  }));

  assert.deepEqual(released, ['lease-returned-after-timeout']);
  assert.equal(artifact.lease.status, 'released');
  assert.equal(artifact.cleanup.status, 'passed');
});

test('fails cleanup closed while guarding a lease that may register after coordinator return', async () => {
  const released: string[] = [];
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    now: Date.now,
    budgets: { setupMs: 10, totalMs: 30, minimumProductRatio: 0 },
    authorization: {
      grantId: 'grant-1', goalId: 'goal-1', operations: ['inspect'],
      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['cos'],
      targetResource: 'mobile-target:ios:device-1',
    },
    leasePort: {
      async acquire(input: {
        resource: string;
        signal: AbortSignal;
        registerAcquiredLease(lease: {
          leaseId: string; resource: string; status: 'trusted'; acquiredAt: string; expiresAt: string;
        }): void;
      }) {
        return new Promise((resolve) => {
          input.signal.addEventListener('abort', () => {
            setTimeout(() => {
              const lease = {
                leaseId: 'lease-after-return', resource: input.resource, status: 'trusted' as const,
                acquiredAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z',
              };
              input.registerAcquiredLease(lease);
              resolve(lease);
            }, 40);
          });
        });
      },
      async release(lease: { leaseId: string }) {
        released.push(lease.leaseId);
        return { status: 'failed', reason: 'late release failed' };
      },
    },
  }));

  assert.equal(artifact.cleanup.status, 'failed');
  assert.match(artifact.cleanup.failures.join('\n'), /did not settle during cleanup/u);
  assert.equal(artifact.lease.status, 'not-acquired');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(released, ['lease-after-return']);
});

test('releases every lease when a port registers multiple ownership references', async () => {
  const released: string[] = [];
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    leasePort: {
      async acquire(input: {
        resource: string;
        registerAcquiredLease(lease: {
          leaseId: string; resource: string; status: 'trusted'; acquiredAt: string; expiresAt: string;
        }): void;
      }) {
        const first = {
          leaseId: 'lease-first', resource: input.resource, status: 'trusted' as const,
          acquiredAt: '2026-08-10T00:00:00.000Z', expiresAt: '2026-08-10T00:10:00.000Z',
        };
        const second = { ...first, leaseId: 'lease-second' };
        input.registerAcquiredLease(first);
        input.registerAcquiredLease(second);
        return second;
      },
      async release(lease: { leaseId: string }) {
        released.push(lease.leaseId);
        return lease.leaseId === 'lease-second'
          ? { status: 'failed', reason: 'second lease release failed' }
          : { status: 'released' };
      },
    },
  }));

  assert.deepEqual(released.sort(), ['lease-first', 'lease-second']);
  assert.equal(artifact.cleanup.status, 'failed');
  assert.match(artifact.cleanup.failures.join('\n'), /multiple ownership references/u);
  assert.equal(artifact.lease.status, 'release-failed');
  assert.equal(artifact.lease.leaseId, 'lease-second');
  assert.equal(artifact.lease.reason, 'second lease release failed');
  assert.equal(artifact.decision.code, 'lease-unavailable');
});

test('best-effort releases a malformed acquisition that still identifies ownership', async () => {
  let releaseCalls = 0;
  const artifact = await coordinateQuickProof(baseOptions(createClock(), {
    leasePort: {
      async acquire({ resource }: { resource: string }) {
        return { leaseId: 'lease-malformed', resource, status: 'trusted' } as never;
      },
      async release(lease: { leaseId: string; resource: string }) {
        releaseCalls += 1;
        assert.equal(lease.leaseId, 'lease-malformed');
        return { status: 'released' };
      },
    },
  }));

  assert.equal(releaseCalls, 2);
  assert.equal(artifact.decision.code, 'lease-unavailable');
  assert.equal(artifact.lease.status, 'released');
});

test('quick-proof schema rejects contradictory setup-only product state', () => {
  const contradictory = {
    schemaVersion: '1.0.0', artifactType: 'quick-proof', runId: 'run', scenarioId: 'scenario', goalId: 'goal',
    source: {
      revision: 'revision', packageName: 'agent-scenario-loop', packageVersion: '0.1.18-candidate',
      packageIntegrity: 'sha256:candidate',
    },
    startedAt: 'now', endedAt: 'later', status: 'setup-only', proofTier: null,
    budgets: { setupMs: 1, totalMs: 2, minimumProductRatio: 0.5, setupDurationMs: 1, totalDurationMs: 1, timeToFirstProductActionMs: 1 },
    authorization: { status: 'authorized', grantId: 'grant', goalId: 'goal', operations: [], delegationDepth: 1 },
    lease: { status: 'not-required' }, identities: [], identityObservations: [], phases: [],
    adapters: [{ adapterId: 'adapter', tier: 'trusted-automated', attempts: 1, status: 'selected' }],
    decision: { code: 'product-completed', reason: 'contradictory' },
    product: { started: true, startedAt: 'now', status: 'passed' }, cleanup: { status: 'passed', failures: [] },
  };

  const result = validateJson(contradictory, SCHEMAS.quickProof, 'quick proof');
  assert.equal(result.valid, false);
  assert.match(result.message, /product.started/u);
});

test('quick-proof schema rejects an observed identity without observed evidence', async () => {
  const artifact = await coordinateQuickProof(baseOptions(createClock()));
  const contradictory = structuredClone(artifact);
  delete contradictory.identities[0].observed;

  const result = validateJson(contradictory, SCHEMAS.quickProof, 'incomplete observed identity');
  assert.equal(result.valid, false);
  assert.equal(result.errors.length > 0, true);
});

test('quick-proof schema rejects observed-late product success', async () => {
  const product = await coordinateQuickProof(baseOptions(createClock()));
  const contradictory = structuredClone(product);
  contradictory.product.timingStatus = 'observed-late';
  contradictory.product.detectedAt = contradictory.product.startedAt;
  delete contradictory.product.startedAt;
  contradictory.budgets.setupDurationMs = null;
  contradictory.budgets.timeToFirstProductActionMs = null;

  const result = validateJson(contradictory, SCHEMAS.quickProof, 'observed-late quick proof');
  assert.equal(result.valid, false);
  assert.match(result.message, /product-failed|failed/u);
});

test('quick-proof schema rejects contradictory manual, cleanup, and lease states', async () => {
  const manual = await coordinateQuickProof(baseOptions(createClock(), {
    adapters: [baseAdapter({ tier: 'manual-assisted' })],
  }));
  const manualWithoutTier = structuredClone(manual);
  manualWithoutTier.proofTier = null;
  assert.equal(validateJson(manualWithoutTier, SCHEMAS.quickProof, 'manual quick proof').valid, false);

  const product = await coordinateQuickProof(baseOptions(createClock()));
  const passedCleanupWithFailure = structuredClone(product);
  passedCleanupWithFailure.cleanup.failures.push('contradictory');
  assert.equal(validateJson(passedCleanupWithFailure, SCHEMAS.quickProof, 'cleanup quick proof').valid, false);

  const releasedWithoutIdentity = structuredClone(product);
  delete releasedWithoutIdentity.lease.leaseId;
  assert.equal(validateJson(releasedWithoutIdentity, SCHEMAS.quickProof, 'lease quick proof').valid, false);

  const productWithoutLease = structuredClone(product);
  productWithoutLease.lease = { status: 'not-acquired', resource: 'mobile-target:ios:device-1' };
  assert.equal(validateJson(productWithoutLease, SCHEMAS.quickProof, 'product lease quick proof').valid, false);

  const releaseFailureReportedClean = structuredClone(product);
  releaseFailureReportedClean.lease = {
    status: 'release-failed', resource: 'mobile-target:ios:device-1', leaseId: 'lease-1', reason: 'failed',
  };
  assert.equal(validateJson(releaseFailureReportedClean, SCHEMAS.quickProof, 'release cleanup quick proof').valid, false);

  const deniedExactProduct = structuredClone(product);
  deniedExactProduct.authorization.status = 'denied';
  deniedExactProduct.authorization.reason = 'revoked';
  assert.equal(validateJson(deniedExactProduct, SCHEMAS.quickProof, 'denied exact product quick proof').valid, false);

  const deniedSetupWrongDecision = structuredClone(manual);
  deniedSetupWrongDecision.authorization.status = 'denied';
  deniedSetupWrongDecision.authorization.reason = 'revoked';
  assert.equal(validateJson(deniedSetupWrongDecision, SCHEMAS.quickProof, 'denied setup quick proof').valid, false);
});
