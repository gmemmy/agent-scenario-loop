import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProfileSessionAuthoritativeStorage,
  normalizeProfileSessionAuthorityIdentity,
  resolveProfileSessionAuthorityStartedAt,
} from '../../app/profile-session-authoritative-storage';
import {
  createProfileSessionDependencyMilestoneFacts,
  recoverProfileCommandLifecycle,
} from '../../app/profile-session-dependency-controller';
import { hasObservedDeliveredProfileCommandMilestone } from '../../app/profile-session-command-ordering';

const keys = {
  command: 'profile-command',
  event: 'profile-event',
  session: 'profile-session',
  sessionEntries: 'profile-session-entry',
};

const session = {
  scenario: 'long-session',
  runId: 'run-1',
  startedAt: 1000,
};

const validateRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);
const validateOwnedRecord = (
  value: unknown,
  owner: { scenario: string; runId: string },
): value is Record<string, unknown> => (
  validateRecord(value) && value.scenario === owner.scenario && value.runId === owner.runId
);

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for authoritative storage state.');
}

test('legacy session start time normalizes to one finite authority identity', () => {
  assert.equal(resolveProfileSessionAuthorityStartedAt(undefined, 2000), 2000);
  assert.equal(resolveProfileSessionAuthorityStartedAt(null, 2000), 2000);
  assert.equal(resolveProfileSessionAuthorityStartedAt(Number.NaN, 2000), 2000);
  assert.equal(resolveProfileSessionAuthorityStartedAt(1000, 2000), 1000);
  assert.throws(
    () => resolveProfileSessionAuthorityStartedAt(undefined, Number.NaN),
    /fallback start time must be finite/u,
  );
});

test('legacy session identity persists its normalized start before reuse', async () => {
  const persisted: Array<{ active: boolean; runId: string; startedAt: number }> = [];
  const legacy = { active: true, runId: 'legacy-run' };
  const normalized = await normalizeProfileSessionAuthorityIdentity(
    legacy,
    2000,
    async (value) => {
      persisted.push(value);
    },
  );
  assert.deepEqual(normalized, { ...legacy, startedAt: 2000 });
  assert.deepEqual(persisted, [normalized]);

  const recovered = await normalizeProfileSessionAuthorityIdentity(
    normalized,
    3000,
    async () => assert.fail('a normalized identity must not be rewritten'),
  );
  assert.deepEqual(recovered, normalized);
});

function createMemoryStorage() {
  const values = new Map<string, string>();
  const writes = new Map<string, number>();
  const removals = new Map<string, number>();
  return {
    values,
    writes,
    removals,
    storage: {
      getItem: async (key: string) => values.get(key) ?? null,
      removeItem: async (key: string) => {
        values.delete(key);
        removals.set(key, (removals.get(key) ?? 0) + 1);
      },
      setItem: async (key: string, value: string) => {
        values.set(key, value);
        writes.set(key, (writes.get(key) ?? 0) + 1);
      },
    },
  };
}

function snapshotMemory(memory: ReturnType<typeof createMemoryStorage>) {
  return {
    removals: [...memory.removals.entries()],
    values: [...memory.values.entries()],
    writes: [...memory.writes.entries()],
  };
}

test('authoritative storage batches production terminal projections and recovers complete truth', async () => {
  const memory = createMemoryStorage();
  const failures: unknown[] = [];
  const authority = createProfileSessionAuthoritativeStorage<
    { event: string; index: number },
    { id: string; index: number }
  >({
    chunkSize: 16,
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });

  authority.start(session);
  for (let index = 0; index < 350; index += 1) {
    authority.appendEvent({ event: `event-${index}`, index });
  }
  for (let index = 0; index < 140; index += 1) {
    authority.appendSessionEntry(
      { id: `command-${index}`, index },
      index === 139,
    );
  }
  await authority.flush();
  assert.equal(failures.length, 0);

  const reloaded = createProfileSessionAuthoritativeStorage<
    { event: string; index: number },
    { id: string; index: number }
  >({
    chunkSize: 16,
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  const recovery = await reloaded.recover(session);
  assert.equal(recovery.kind, 'recovered');
  if (recovery.kind !== 'recovered') {
    return;
  }
  assert.equal(recovery.events.length, 350);
  assert.equal(recovery.sessionEntries.length, 140);
  assert.equal(recovery.events.at(0)?.index, 0);
  assert.equal(recovery.events.at(349)?.index, 349);
  assert.equal(recovery.sessionEntries.at(0)?.index, 0);
  assert.equal(recovery.sessionEntries.at(139)?.index, 139);
  assert.deepEqual(JSON.parse(memory.values.get(keys.event) ?? '[]'), recovery.events);
  assert.deepEqual(
    JSON.parse(memory.values.get(keys.sessionEntries) ?? '[]'),
    recovery.sessionEntries,
  );
  assert.ok((memory.writes.get(keys.event) ?? 0) < 5);
  assert.ok((memory.writes.get(keys.sessionEntries) ?? 0) < 5);
});

test('poisoned authority refuses same-module session restart and new writes', async () => {
  const memory = createMemoryStorage();
  const failures: unknown[] = [];
  const authority = createProfileSessionAuthoritativeStorage<Record<string, unknown>, Record<string, unknown>>({
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: {
      ...memory.storage,
      setItem: async (key: string, value: string) => {
        if (key.includes('.event.')) {
          throw new Error('quota exceeded');
        }
        await memory.storage.setItem(key, value);
      },
    },
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  authority.start(session);
  authority.appendEvent({ event: 'poison' });
  await authority.barrier();

  assert.equal(authority.isAvailable(), false);
  authority.start({ ...session, runId: 'run-2', startedAt: 2000 });
  authority.appendEvent({ event: 'must-not-persist' });
  await authority.barrier();
  assert.equal(failures.length, 1);
  assert.equal(
    JSON.parse(memory.values.get(`${keys.session}.authority.1`) ?? 'null')?.status,
    'failed',
  );
});

test('reload rehydrates old readiness and command lifecycle beyond diagnostic limits', async () => {
  const memory = createMemoryStorage();
  const authority = createProfileSessionAuthoritativeStorage<Record<string, unknown>, Record<string, unknown>>({
    chunkSize: 16,
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  authority.start(session);
  authority.appendEvent({
    event: 'viewer_ready',
    queueId: 'queue-a',
    runId: session.runId,
    scenario: session.scenario,
    sequence: 129,
    timestamp: 1,
  });
  for (let index = 0; index < 350; index += 1) {
    authority.appendEvent({
      event: `noise-${index % 5}`,
      queueId: 'queue-a',
      runId: session.runId,
      scenario: session.scenario,
      timestamp: index + 2,
    });
  }
  for (let index = 0; index < 130; index += 1) {
    authority.appendSessionEntry({
      command: `command-${index}`,
      id: `command-${index}`,
      kind: 'command',
      runId: session.runId,
      scenario: session.scenario,
      status: index === 129 ? 'delivered' : 'completed',
      timestamp: index + 1,
    });
  }
  await authority.flush();

  const reloaded = createProfileSessionAuthoritativeStorage<Record<string, unknown>, Record<string, unknown>>({
    chunkSize: 16,
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  const recovery = await reloaded.recover(session);
  assert.equal(recovery.kind, 'recovered');
  if (recovery.kind !== 'recovered') {
    return;
  }
  const facts = createProfileSessionDependencyMilestoneFacts();
  for (const event of recovery.events) {
    facts.observe(event as {
      event: string;
      queueId?: string;
      runId: string;
      scenario: string;
      sequence?: number;
      timestamp: number;
    });
  }
  assert.equal(hasObservedDeliveredProfileCommandMilestone({
    id: 'command-129',
    queueId: 'queue-a',
    runId: session.runId,
    scenario: session.scenario,
    sequence: 129,
    timestamp: 500,
    waitForMilestone: 'viewer_ready',
  }, facts.snapshot()), true);
  const lifecycle = recoverProfileCommandLifecycle(recovery.sessionEntries as Array<{
    id?: string;
    status?: 'completed' | 'skipped' | 'delivered' | 'queued' | 'received';
    timestamp: number;
  }>);
  assert.equal(lifecycle.delivered.has('command-129'), true);
  assert.equal(lifecycle.terminal.has('command-0'), true);
  assert.equal(lifecycle.terminal.size, 129);
});

test('durable stop marker prevents stale session revival while deletion is delayed', async () => {
  const memory = createMemoryStorage();
  let releaseSessionRemoval!: () => void;
  const sessionRemoval = new Promise<void>((resolve) => {
    releaseSessionRemoval = resolve;
  });
  const storage = {
    ...memory.storage,
    removeItem: async (key: string) => {
      if (key === keys.session) {
        await sessionRemoval;
      }
      memory.values.delete(key);
    },
  };
  const authority = createProfileSessionAuthoritativeStorage<unknown, unknown>({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  authority.start(session);
  await authority.enqueue(async () => {
    await storage.setItem(keys.session, JSON.stringify({ active: true, ...session }));
    await storage.setItem(keys.command, JSON.stringify([{ id: 'command-1' }]));
  });
  const stopping = authority.stop(session);

  while (
    JSON.parse(memory.values.get(`${keys.session}.authority.1`) ?? 'null')?.status !== 'stopped'
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const reloaded = createProfileSessionAuthoritativeStorage<unknown, unknown>({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  const recovery = await reloaded.recover(session);
  assert.equal(recovery.kind, 'stopped-session');
  assert.equal(memory.values.has(keys.session), true);

  releaseSessionRemoval();
  assert.equal((await stopping).kind, 'stopped');
  await authority.barrier();
  assert.equal(memory.values.has(keys.session), false);
  assert.equal(memory.values.has(keys.command), false);
});

test('storage failure is reported once and leaves authority fail closed', async () => {
  const memory = createMemoryStorage();
  const failures: unknown[] = [];
  const authority = createProfileSessionAuthoritativeStorage<{ event: string }, unknown>({
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: {
      ...memory.storage,
      setItem: async (key: string, value: string) => {
        if (key.includes('.event.')) {
          throw new Error('quota exceeded');
        }
        await memory.storage.setItem(key, value);
      },
    },
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  authority.start(session);
  authority.appendEvent({ event: 'will-fail' });
  await authority.barrier();
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /quota exceeded/u);
  const reloaded = createProfileSessionAuthoritativeStorage<{ event: string }, unknown>({
    keys,
    onFailure: () => {},
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  assert.equal(
    JSON.parse(memory.values.get(`${keys.session}.authority.1`) ?? 'null')?.status,
    'failed',
  );
  await assert.rejects(reloaded.recover(session), /records a storage failure/u);
  await assert.rejects(authority.flush(), /unavailable/u);
  assert.equal(failures.length, 1);
});

test('session replacement publishes the new generation before removing old chunks', async () => {
  const memory = createMemoryStorage();
  let blockChunkRemoval = false;
  let releaseChunkRemoval = () => {};
  const chunkRemoval = new Promise<void>((resolve) => {
    releaseChunkRemoval = resolve;
  });
  const authority = createProfileSessionAuthoritativeStorage<{ event: string }, unknown>({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: {
      ...memory.storage,
      removeItem: async (key: string) => {
        if (blockChunkRemoval && key.includes('.event.')) {
          await chunkRemoval;
        }
        await memory.storage.removeItem(key);
      },
    },
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  authority.start(session);
  authority.appendEvent({ event: 'old-event' });
  await authority.barrier();
  const oldChunkKey = `${keys.session}.authority.1.1.event.0`;
  assert.equal(memory.values.has(oldChunkKey), true);

  blockChunkRemoval = true;
  const replacement = { scenario: 'gallery', runId: 'replacement-run', startedAt: 200 };
  authority.start(replacement);
  await waitFor(() => {
    const manifest = JSON.parse(memory.values.get(`${keys.session}.authority.1`) ?? 'null');
    return manifest?.session?.runId === replacement.runId;
  });
  const published = JSON.parse(memory.values.get(`${keys.session}.authority.1`) ?? 'null');
  assert.deepEqual(published.eventChunkKeys, []);
  assert.equal(memory.values.has(oldChunkKey), true);

  releaseChunkRemoval();
  await authority.barrier();
  assert.equal(memory.values.has(oldChunkKey), false);
});

test('invalid authority manifest fails closed instead of becoming a new session', async () => {
  const memory = createMemoryStorage();
  const failures: unknown[] = [];
  memory.values.set(`${keys.session}.authority.1`, JSON.stringify({ schemaVersion: 1 }));
  memory.values.set(keys.session, JSON.stringify({ active: true, ...session }));
  memory.values.set(keys.command, JSON.stringify([{ id: 'command-1' }]));
  const authority = createProfileSessionAuthoritativeStorage<unknown, unknown>({
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });

  await assert.rejects(authority.recover(session), /manifest is invalid/u);
  await authority.barrier();
  assert.equal(failures.length, 1);
  assert.equal(memory.values.has(keys.session), false);
  assert.equal(memory.values.has(keys.command), false);
});

test('invalid authority chunk keys and contents fail closed', async () => {
  const cases = [
    {
      name: 'duplicate key',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.eventChunkKeys = [
          `${keys.session}.authority.1.1.event.0`,
          `${keys.session}.authority.1.1.event.0`,
        ];
      },
    },
    {
      name: 'foreign key',
      mutate: (manifest: Record<string, unknown>) => {
        manifest.eventChunkKeys = ['foreign.event.chunk'];
      },
    },
    {
      name: 'malformed element',
      mutate: (manifest: Record<string, unknown>, values: Map<string, string>) => {
        const eventChunkKeys = manifest.eventChunkKeys as string[];
        values.set(eventChunkKeys[0] ?? '', JSON.stringify([null]));
      },
    },
    {
      name: 'missing chunk',
      mutate: (manifest: Record<string, unknown>, values: Map<string, string>) => {
        const eventChunkKeys = manifest.eventChunkKeys as string[];
        values.delete(eventChunkKeys[0] ?? '');
      },
    },
    {
      name: 'foreign session element',
      mutate: (manifest: Record<string, unknown>, values: Map<string, string>) => {
        const eventChunkKeys = manifest.eventChunkKeys as string[];
        values.set(eventChunkKeys[0] ?? '', JSON.stringify([{
          event: 'valid',
          runId: 'foreign-run',
          scenario: session.scenario,
          timestamp: 1,
        }]));
      },
    },
    {
      name: 'oversized chunk',
      mutate: (manifest: Record<string, unknown>, values: Map<string, string>) => {
        const eventChunkKeys = manifest.eventChunkKeys as string[];
        values.set(eventChunkKeys[0] ?? '', JSON.stringify(Array.from(
          { length: 33 },
          (_, index) => ({
            event: `event-${index}`,
            runId: session.runId,
            scenario: session.scenario,
            timestamp: index,
          }),
        )));
      },
    },
  ];

  for (const testCase of cases) {
    const memory = createMemoryStorage();
    const failures: unknown[] = [];
    const authority = createProfileSessionAuthoritativeStorage<Record<string, unknown>, Record<string, unknown>>({
      keys,
      onFailure: (error: unknown) => failures.push(error),
      storage: memory.storage,
      validateEvent: (value, owner) => validateOwnedRecord(value, owner) && typeof value.event === 'string',
      validateSessionEntry: validateOwnedRecord,
    });
    authority.start(session);
    authority.appendEvent({ event: 'valid' });
    await authority.flush();
    const manifestKey = `${keys.session}.authority.1`;
    const manifest = JSON.parse(memory.values.get(manifestKey) ?? 'null') as Record<string, unknown>;
    testCase.mutate(manifest, memory.values);
    memory.values.set(manifestKey, JSON.stringify(manifest));

    const reloaded = createProfileSessionAuthoritativeStorage<Record<string, unknown>, Record<string, unknown>>({
      keys,
      onFailure: (error: unknown) => failures.push(error),
      storage: memory.storage,
      validateEvent: (value, owner) => validateOwnedRecord(value, owner) && typeof value.event === 'string',
      validateSessionEntry: validateOwnedRecord,
    });
    await assert.rejects(reloaded.recover(session), /authority|chunk/u, testCase.name);
    await reloaded.barrier();
    assert.equal(reloaded.isAvailable(), false, testCase.name);
  }
});

test('first stop returns stopped and writes the terminal manifest once', async () => {
  const memory = createMemoryStorage();
  const authority = createProfileSessionAuthoritativeStorage<
    { event: string },
    { id: string }
  >({
    chunkSize: 8,
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });

  authority.start(session);
  authority.appendEvent({ event: 'terminal-event' });
  authority.appendSessionEntry({ id: 'terminal-entry' }, true);
  await authority.flush();
  await authority.enqueue(async () => {
    await memory.storage.setItem(keys.session, JSON.stringify({ active: true, ...session }));
    await memory.storage.setItem(keys.command, JSON.stringify([{ id: 'terminal-entry' }]));
  });

  const authorityKey = `${keys.session}.authority.1`;
  const manifestBefore = JSON.parse(memory.values.get(authorityKey) ?? 'null') as {
    eventChunkKeys: string[];
    generation: number;
    sessionEntryChunkKeys: string[];
  };
  const eventChunkValues = manifestBefore.eventChunkKeys.map((key) => memory.values.get(key));
  const sessionEntryChunkValues = manifestBefore.sessionEntryChunkKeys.map((key) => memory.values.get(key));
  const compatibilityEvents = memory.values.get(keys.event);
  const compatibilitySessionEntries = memory.values.get(keys.sessionEntries);
  const authorityWritesBefore = memory.writes.get(authorityKey) ?? 0;
  const commandRemovalsBefore = memory.removals.get(keys.command) ?? 0;
  const sessionRemovalsBefore = memory.removals.get(keys.session) ?? 0;

  const result = await authority.stop(session);
  assert.equal(result.kind, 'stopped');

  const manifestAfter = JSON.parse(memory.values.get(authorityKey) ?? 'null');
  assert.equal(manifestAfter.status, 'stopped');
  assert.equal(manifestAfter.generation, manifestBefore.generation);
  assert.deepEqual(manifestAfter.eventChunkKeys, manifestBefore.eventChunkKeys);
  assert.deepEqual(manifestAfter.sessionEntryChunkKeys, manifestBefore.sessionEntryChunkKeys);
  assert.deepEqual(
    manifestBefore.eventChunkKeys.map((key) => memory.values.get(key)),
    eventChunkValues,
  );
  assert.deepEqual(
    manifestBefore.sessionEntryChunkKeys.map((key) => memory.values.get(key)),
    sessionEntryChunkValues,
  );
  assert.equal(memory.values.get(keys.event), compatibilityEvents);
  assert.equal(memory.values.get(keys.sessionEntries), compatibilitySessionEntries);
  assert.equal(memory.writes.get(authorityKey), authorityWritesBefore + 1);
  assert.equal(memory.removals.get(keys.command), commandRemovalsBefore + 1);
  assert.equal(memory.removals.get(keys.session), sessionRemovalsBefore + 1);
  assert.equal(memory.values.has(keys.command), false);
  assert.equal(memory.values.has(keys.session), false);
});

test('repeated same-run stop is already-stopped and byte-identical', async () => {
  const memory = createMemoryStorage();
  const authority = createProfileSessionAuthoritativeStorage<
    { event: string },
    { id: string }
  >({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });

  authority.start(session);
  authority.appendEvent({ event: 'keep' });
  authority.appendSessionEntry({ id: 'keep' }, true);
  await authority.flush();
  await authority.enqueue(async () => {
    await memory.storage.setItem(keys.session, JSON.stringify({ active: true, ...session }));
    await memory.storage.setItem(keys.command, JSON.stringify([{ id: 'keep' }]));
  });

  const first = await authority.stop(session);
  assert.equal(first.kind, 'stopped');
  const frozen = snapshotMemory(memory);

  const second = await authority.stop(session);
  assert.equal(second.kind, 'already-stopped');
  assert.deepEqual(snapshotMemory(memory), frozen);
});

test('delayed same-run stop after reload of stopped authority is byte-identical', async () => {
  const memory = createMemoryStorage();
  const createAuthority = () => createProfileSessionAuthoritativeStorage<
    { event: string },
    { id: string }
  >({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });

  const authority = createAuthority();
  authority.start(session);
  authority.appendEvent({ event: 'keep' });
  authority.appendSessionEntry({ id: 'keep' }, true);
  await authority.flush();
  const first = await authority.stop(session);
  assert.equal(first.kind, 'stopped');
  await authority.barrier();

  const reloaded = createAuthority();
  const recovery = await reloaded.recover(session);
  assert.equal(recovery.kind, 'stopped-session');
  const frozen = snapshotMemory(memory);

  const delayed = await reloaded.stop(session);
  assert.equal(delayed.kind, 'already-stopped');
  assert.deepEqual(snapshotMemory(memory), frozen);
});

test('stale stop cannot mutate a newer active session or compatibility pointers', async () => {
  const memory = createMemoryStorage();
  const authority = createProfileSessionAuthoritativeStorage<
    { event: string },
    { id: string }
  >({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  const newer = { scenario: 'gallery', runId: 'run-2', startedAt: 2000 };

  authority.start(session);
  authority.appendEvent({ event: 'old' });
  await authority.barrier();
  authority.start(newer);
  authority.appendEvent({ event: 'new' });
  authority.appendSessionEntry({ id: 'new' }, true);
  await authority.flush();
  await authority.enqueue(async () => {
    await memory.storage.setItem(keys.session, JSON.stringify({ active: true, ...newer }));
    await memory.storage.setItem(keys.command, JSON.stringify([{ id: 'new' }]));
  });

  const frozen = snapshotMemory(memory);
  const result = await authority.stop(session);
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') {
    return;
  }
  assert.equal(result.reason, 'session-mismatch');
  assert.deepEqual(snapshotMemory(memory), frozen);

  const manifest = JSON.parse(memory.values.get(`${keys.session}.authority.1`) ?? 'null');
  assert.equal(manifest.status, 'active');
  assert.equal(manifest.session.runId, newer.runId);
  assert.equal(memory.values.get(keys.session), JSON.stringify({ active: true, ...newer }));
  assert.equal(memory.values.get(keys.command), JSON.stringify([{ id: 'new' }]));
});

test('missing authority rejects stop without mutation', async () => {
  const memory = createMemoryStorage();
  const failures: unknown[] = [];
  await memory.storage.setItem(keys.session, JSON.stringify({ active: true, ...session }));
  await memory.storage.setItem(keys.command, JSON.stringify([{ id: 'command-1' }]));
  const authority = createProfileSessionAuthoritativeStorage<unknown, unknown>({
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  const frozen = snapshotMemory(memory);

  const result = await authority.stop(session);
  assert.equal(result.kind, 'rejected');
  if (result.kind !== 'rejected') {
    return;
  }
  assert.equal(result.reason, 'missing-authority');
  assert.equal(authority.isAvailable(), true);
  assert.equal(failures.length, 0);
  assert.deepEqual(snapshotMemory(memory), frozen);
});

test('failed authority rejects stop without mutation', async () => {
  const memory = createMemoryStorage();
  const failures: unknown[] = [];
  const poisoned = createProfileSessionAuthoritativeStorage<Record<string, unknown>, Record<string, unknown>>({
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: {
      ...memory.storage,
      setItem: async (key: string, value: string) => {
        if (key.includes('.event.')) {
          throw new Error('quota exceeded');
        }
        await memory.storage.setItem(key, value);
      },
    },
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  poisoned.start(session);
  poisoned.appendEvent({ event: 'poison' });
  await poisoned.barrier();
  assert.equal(poisoned.isAvailable(), false);
  const unavailableFrozen = snapshotMemory(memory);
  const unavailable = await poisoned.stop(session);
  assert.equal(unavailable.kind, 'rejected');
  if (unavailable.kind !== 'rejected') {
    return;
  }
  assert.equal(unavailable.reason, 'unavailable');
  assert.equal(failures.length, 1);
  assert.deepEqual(snapshotMemory(memory), unavailableFrozen);

  const reloaded = createProfileSessionAuthoritativeStorage<unknown, unknown>({
    keys,
    onFailure: (error: unknown) => failures.push(error),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });
  const ambiguousFrozen = snapshotMemory(memory);
  const ambiguous = await reloaded.stop(session);
  assert.equal(ambiguous.kind, 'rejected');
  if (ambiguous.kind !== 'rejected') {
    return;
  }
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.equal(reloaded.isAvailable(), true);
  assert.equal(failures.length, 1);
  assert.deepEqual(snapshotMemory(memory), ambiguousFrozen);
});

test('concurrent exact-session stops serialize to one stopped transition', async () => {
  const memory = createMemoryStorage();
  const authority = createProfileSessionAuthoritativeStorage<
    { event: string },
    { id: string }
  >({
    keys,
    onFailure: (error: unknown) => assert.fail(String(error)),
    storage: memory.storage,
    validateEvent: validateRecord,
    validateSessionEntry: validateRecord,
  });

  authority.start(session);
  authority.appendEvent({ event: 'live' });
  authority.appendSessionEntry({ id: 'live' }, true);
  await authority.flush();
  await authority.enqueue(async () => {
    await memory.storage.setItem(keys.session, JSON.stringify({ active: true, ...session }));
    await memory.storage.setItem(keys.command, JSON.stringify([{ id: 'live' }]));
  });

  const authorityKey = `${keys.session}.authority.1`;
  const manifestBefore = JSON.parse(memory.values.get(authorityKey) ?? 'null');
  const eventChunkValues = (manifestBefore.eventChunkKeys as string[]).map((key) => memory.values.get(key));
  const sessionEntryChunkValues = (manifestBefore.sessionEntryChunkKeys as string[]).map((key) => (
    memory.values.get(key)
  ));
  const authorityWritesBefore = memory.writes.get(authorityKey) ?? 0;
  const commandRemovalsBefore = memory.removals.get(keys.command) ?? 0;
  const sessionRemovalsBefore = memory.removals.get(keys.session) ?? 0;

  const results = await Promise.all([
    authority.stop(session),
    authority.stop(session),
    authority.stop(session),
  ]);
  assert.equal(results.filter((result) => result.kind === 'stopped').length, 1);
  assert.equal(results.filter((result) => result.kind === 'already-stopped').length, 2);

  const manifestAfter = JSON.parse(memory.values.get(authorityKey) ?? 'null');
  assert.equal(manifestAfter.status, 'stopped');
  assert.equal(manifestAfter.generation, manifestBefore.generation);
  assert.deepEqual(manifestAfter.eventChunkKeys, manifestBefore.eventChunkKeys);
  assert.deepEqual(manifestAfter.sessionEntryChunkKeys, manifestBefore.sessionEntryChunkKeys);
  assert.deepEqual(
    (manifestBefore.eventChunkKeys as string[]).map((key) => memory.values.get(key)),
    eventChunkValues,
  );
  assert.deepEqual(
    (manifestBefore.sessionEntryChunkKeys as string[]).map((key) => memory.values.get(key)),
    sessionEntryChunkValues,
  );
  assert.equal(memory.writes.get(authorityKey), authorityWritesBefore + 1);
  assert.equal(memory.removals.get(keys.command), commandRemovalsBefore + 1);
  assert.equal(memory.removals.get(keys.session), sessionRemovalsBefore + 1);
  assert.equal(memory.values.has(keys.command), false);
  assert.equal(memory.values.has(keys.session), false);
});
