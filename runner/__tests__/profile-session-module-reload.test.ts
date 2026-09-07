const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

type LoadedProfileSession = {
  cleanupEffects: () => void;
  exports: {
    applyProfileSessionUrl: (url: string) => boolean;
    startProfileSession: (params: { scenario: string; runId: string; startedAt?: number }) => void;
    stopProfileSession: (expectedOwner?: { scenario: string; runId: string }) =>
      | { kind: 'already-stopped' }
      | { kind: 'rejected'; reason: 'owner-mismatch' }
      | { kind: 'stop-requested'; scenario: string; runId: string };
    subscribeToProfileCommands: (listener: (command: {
      commandId?: string;
      id: string;
      queueId?: string;
      sequence?: number;
    }) => void) => () => void;
    useProfileSession: () => { active: boolean; runId: string | null; scenario: string | null; startedAt: number | null };
    useProfileSessionBootstrap: () => void;
  };
};

const sessionKey = 'agent-scenario-loop.profile-session.1';
const commandKey = 'agent-scenario-loop.profile-commands.1';
const sessionEntriesKey = 'agent-scenario-loop.profile-session-entries.1';
const authorityKey = `${sessionKey}.authority.1`;

function snapshotStorage(storage: Map<string, string>) {
  return [...storage.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function readAuthoritySessionEntries(storage: Map<string, string>): Array<Record<string, unknown>> {
  const manifest = JSON.parse(storage.get(authorityKey) ?? 'null') as {
    sessionEntryChunkKeys?: string[];
  } | null;
  return (manifest?.sessionEntryChunkKeys ?? []).flatMap((key) => (
    JSON.parse(storage.get(key) ?? '[]') as Array<Record<string, unknown>>
  ));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for profile-session module recovery.');
}

function loadProfileSessionModule(storage: Map<string, string>): LoadedProfileSession {
  const moduleCache = new Map<string, { exports: unknown }>();
  const effectCleanups: (() => void)[] = [];
  const effects: (() => void | (() => void))[] = [];
  const asyncStorage = {
    getItem: async (key: string) => storage.get(key) ?? null,
    removeItem: async (key: string) => {
      storage.delete(key);
    },
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  const mocks: Record<string, unknown> = {
    '@react-native-async-storage/async-storage': { __esModule: true, default: asyncStorage },
    react: {
      useEffect: (effect: () => void | (() => void)) => {
        effects.push(effect);
      },
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    },
    'react-native': {
      Linking: {
        addEventListener: () => ({ remove: () => {} }),
        getInitialURL: async () => null,
      },
      NativeModules: {},
      Platform: { OS: 'android' },
    },
    'expo-linking': {
      parse: (url: string) => {
        const parsed = new URL(url);
        return {
          hostname: parsed.hostname,
          path: parsed.pathname.replace(/^\//u, ''),
          queryParams: Object.fromEntries(parsed.searchParams.entries()),
        };
      },
    },
  };

  const load = (filePath: string): { exports: unknown } => {
    const normalizedPath = path.resolve(filePath);
    const cached = moduleCache.get(normalizedPath);
    if (cached) {
      return cached;
    }
    const module = { exports: {} as unknown };
    moduleCache.set(normalizedPath, module);
    const source = fs.readFileSync(normalizedPath, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: normalizedPath,
    }).outputText;
    const localRequire = (specifier: string) => {
      if (Object.hasOwn(mocks, specifier)) {
        return mocks[specifier];
      }
      if (specifier.startsWith('.')) {
        if (specifier.endsWith('.json')) {
          const jsonPath = path.resolve(path.dirname(normalizedPath), specifier);
          return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        }
        return load(path.resolve(path.dirname(normalizedPath), `${specifier}.ts`)).exports;
      }
      return require(specifier);
    };
    const evaluate = new Function('require', 'module', 'exports', '__filename', '__dirname', compiled);
    evaluate(localRequire, module, module.exports, normalizedPath, path.dirname(normalizedPath));
    return module;
  };

  const profileSession = load(path.resolve('app/profile-session.ts')).exports as LoadedProfileSession['exports'];
  profileSession.useProfileSessionBootstrap();
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === 'function') {
      effectCleanups.push(cleanup);
    }
  }
  return {
    cleanupEffects: () => {
      for (const cleanup of effectCleanups.reverse()) {
        cleanup();
      }
    },
    exports: profileSession,
  };
}

test('profile-session command deep links preserve explicit runner command ids', async () => {
  const storage = new Map<string, string>();
  const loaded = loadProfileSessionModule(storage);
  const dispatches: Array<{ commandId?: string; id: string; queueId?: string; sequence?: number }> = [];
  const unsubscribe = loaded.exports.subscribeToProfileCommands((command) => {
    dispatches.push(command);
  });

  try {
    assert.equal(loaded.exports.applyProfileSessionUrl(
      'asl-example://profile-session/start?scenario=gallery&runId=deep-link-run',
    ), true);
    assert.equal(loaded.exports.applyProfileSessionUrl(
      'asl-example://profile-session/command?scenario=gallery&runId=deep-link-run&id=ios-storage-command-1&command=page-forward&commandId=page-forward&queueId=gallery&sequence=1&waitMs=0',
    ), true);

    await waitFor(() => dispatches.length === 1);
    assert.equal(dispatches[0]?.id, 'ios-storage-command-1');
    assert.equal(dispatches[0]?.commandId, 'page-forward');
    assert.equal(dispatches[0]?.queueId, 'gallery');
    assert.equal(dispatches[0]?.sequence, 1);
  } finally {
    unsubscribe();
    loaded.cleanupEffects();
  }
});

test('profile-session stop is idempotent and records one terminal transition', async () => {
  const storage = new Map<string, string>();
  const loaded = loadProfileSessionModule(storage);

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    loaded.exports.startProfileSession({
      scenario: 'gallery',
      runId: 'stop-once',
      startedAt: 1000,
    });
    const first = loaded.exports.stopProfileSession();
    assert.deepEqual(first, {
      kind: 'stop-requested',
      scenario: 'gallery',
      runId: 'stop-once',
    });
    await waitFor(() => (
      JSON.parse(storage.get(authorityKey) ?? 'null') as { status?: string } | null
    )?.status === 'stopped');
    await waitFor(() => readAuthoritySessionEntries(storage).some((entry) => entry.kind === 'stop'));

    const entries = readAuthoritySessionEntries(storage);
    assert.deepEqual(entries.filter((entry) => entry.kind === 'start').map((entry) => entry.runId), ['stop-once']);
    assert.deepEqual(entries.filter((entry) => entry.kind === 'stop').map((entry) => entry.runId), ['stop-once']);
    const frozen = snapshotStorage(storage);

    assert.deepEqual(loaded.exports.stopProfileSession(), { kind: 'already-stopped' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(snapshotStorage(storage), frozen);
  } finally {
    loaded.cleanupEffects();
  }
});

test('stale owner stop cannot terminate or mutate a newer active run', async () => {
  const storage = new Map<string, string>();
  const loaded = loadProfileSessionModule(storage);

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    loaded.exports.startProfileSession({ scenario: 'gallery', runId: 'older', startedAt: 1000 });
    loaded.exports.startProfileSession({ scenario: 'gallery', runId: 'newer', startedAt: 2000 });
    await waitFor(() => (
      JSON.parse(storage.get(authorityKey) ?? 'null') as { session?: { runId?: string } } | null
    )?.session?.runId === 'newer');
    const frozen = snapshotStorage(storage);

    assert.deepEqual(
      loaded.exports.stopProfileSession({ scenario: 'gallery', runId: 'older' }),
      { kind: 'rejected', reason: 'owner-mismatch' },
    );
    assert.equal(loaded.exports.useProfileSession().runId, 'newer');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(snapshotStorage(storage), frozen);
  } finally {
    loaded.cleanupEffects();
  }
});

test('stop deep links require exact owner identity and replay without mutation', async () => {
  const storage = new Map<string, string>();
  const loaded = loadProfileSessionModule(storage);

  try {
    await new Promise((resolve) => setTimeout(resolve, 25));
    loaded.exports.startProfileSession({ scenario: 'gallery', runId: 'url-stop', startedAt: 1000 });
    await waitFor(() => storage.has(authorityKey));
    const active = snapshotStorage(storage);

    assert.equal(loaded.exports.applyProfileSessionUrl('asl-example://profile-session/stop'), false);
    assert.equal(loaded.exports.applyProfileSessionUrl(
      'asl-example://profile-session/stop?scenario=gallery',
    ), false);
    assert.equal(loaded.exports.applyProfileSessionUrl(
      'asl-example://profile-session/stop?scenario=gallery&runId=stale',
    ), false);
    assert.deepEqual(snapshotStorage(storage), active);

    const exactUrl = 'asl-example://profile-session/stop?scenario=gallery&runId=url-stop';
    assert.equal(loaded.exports.applyProfileSessionUrl(exactUrl), true);
    await waitFor(() => (
      JSON.parse(storage.get(authorityKey) ?? 'null') as { status?: string } | null
    )?.status === 'stopped');
    const stopped = snapshotStorage(storage);
    assert.equal(loaded.exports.applyProfileSessionUrl(exactUrl), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(snapshotStorage(storage), stopped);
  } finally {
    loaded.cleanupEffects();
  }
});

test('bootstrap preserves stopped authority bytes and cleans expired owned authority', async () => {
  const stoppedSession = { active: true, scenario: 'gallery', runId: 'stopped-run', startedAt: 1000 };
  const stoppedStorage = new Map<string, string>([
    [authorityKey, JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      status: 'stopped',
      session: { scenario: stoppedSession.scenario, runId: stoppedSession.runId, startedAt: stoppedSession.startedAt },
      eventChunkKeys: [],
      sessionEntryChunkKeys: [],
    })],
    [sessionKey, JSON.stringify(stoppedSession)],
  ]);
  const stoppedBefore = snapshotStorage(stoppedStorage);
  const stoppedModule = loadProfileSessionModule(stoppedStorage);
  try {
    await waitFor(() => stoppedModule.exports.useProfileSession().active === false);
    assert.deepEqual(snapshotStorage(stoppedStorage), stoppedBefore);
  } finally {
    stoppedModule.cleanupEffects();
  }

  const expiredSession = {
    active: true,
    scenario: 'gallery',
    runId: 'expired-run',
    startedAt: Date.now() - 3 * 60 * 60 * 1000,
  };
  const expiredStorage = new Map<string, string>([
    [authorityKey, JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      status: 'active',
      session: {
        scenario: expiredSession.scenario,
        runId: expiredSession.runId,
        startedAt: expiredSession.startedAt,
      },
      eventChunkKeys: [],
      sessionEntryChunkKeys: [],
    })],
    [sessionKey, JSON.stringify(expiredSession)],
    [commandKey, JSON.stringify([{ id: 'expired-command' }])],
    [sessionEntriesKey, JSON.stringify([])],
  ]);
  const expiredModule = loadProfileSessionModule(expiredStorage);
  try {
    await waitFor(() => (
      JSON.parse(expiredStorage.get(authorityKey) ?? 'null') as { status?: string } | null
    )?.status === 'stopped');
    assert.equal(expiredStorage.has(sessionKey), false);
    assert.equal(expiredStorage.has(commandKey), false);
    assert.deepEqual(readAuthoritySessionEntries(expiredStorage), []);
  } finally {
    expiredModule.cleanupEffects();
  }
});

test('fresh helper modules recover durable command boundaries without replaying delivered work', async () => {
  const sessionKey = 'agent-scenario-loop.profile-session.1';
  const commandKey = 'agent-scenario-loop.profile-commands.1';
  const eventKey = 'agent-scenario-loop.profile-events.1';
  const sessionEntriesKey = 'agent-scenario-loop.profile-session-entries.1';
  const authorityKey = `${sessionKey}.authority.1`;
  const eventChunkKeys = Array.from({ length: 10 }, (_, index) => `${authorityKey}.1.event.${index}`);
  const entryChunkKeys = Array.from({ length: 5 }, (_, index) => `${authorityKey}.1.session-entry.${index}`);
  const session = { active: true, scenario: 'gallery', runId: 'reload-run', startedAt: Date.now() };
  const commands = [
    { id: 'received', command: 'received', scenario: 'gallery', runId: 'reload-run', queueId: 'main', sequence: 1, timestamp: session.startedAt + 1, waitMs: 0 },
    { id: 'delivered', command: 'delivered', scenario: 'gallery', runId: 'reload-run', queueId: 'main', sequence: 2, timestamp: session.startedAt + 2, waitForMilestone: 'video-ready', waitMs: 0, waitTimeoutMs: 1000 },
    { id: 'terminal', command: 'terminal', scenario: 'gallery', runId: 'reload-run', queueId: 'main', sequence: 3, timestamp: session.startedAt + 3, waitMs: 0 },
  ];
  const events: Record<string, unknown>[] = [{
    event: 'video-ready',
    scenario: 'gallery',
    runId: 'reload-run',
    queueId: 'main',
    sequence: 2,
    timestamp: session.startedAt + 10,
  }, ...Array.from({ length: 301 }, (_, index) => ({
    event: `diagnostic-${index}`,
    scenario: 'gallery',
    runId: 'reload-run',
    timestamp: session.startedAt + index + 11,
  }))];
  const entries = [
    { kind: 'start', scenario: 'gallery', runId: 'reload-run', timestamp: session.startedAt },
    { kind: 'command', id: 'received', command: 'received', status: 'received', scenario: 'gallery', runId: 'reload-run', timestamp: session.startedAt + 200 },
    { kind: 'command', id: 'delivered', command: 'delivered', status: 'delivered', scenario: 'gallery', runId: 'reload-run', timestamp: session.startedAt + 201 },
    { kind: 'command', id: 'terminal', command: 'terminal', status: 'completed', scenario: 'gallery', runId: 'reload-run', timestamp: session.startedAt + 202 },
    ...Array.from({ length: 125 }, (_, index) => ({
      kind: 'command', id: `old-terminal-${index}`, command: 'old', status: 'completed',
      scenario: 'gallery', runId: 'reload-run', timestamp: session.startedAt + index + 300,
    })),
  ];
  const storage = new Map<string, string>([
    [sessionKey, JSON.stringify(session)],
    [commandKey, JSON.stringify(commands)],
    [authorityKey, JSON.stringify({
      schemaVersion: 1,
      generation: 1,
      status: 'active',
      session: { scenario: session.scenario, runId: session.runId, startedAt: session.startedAt },
      eventChunkKeys,
      sessionEntryChunkKeys: entryChunkKeys,
    })],
  ]);
  eventChunkKeys.forEach((key, index) => {
    storage.set(key, JSON.stringify(events.slice(index * 32, (index + 1) * 32)));
  });
  entryChunkKeys.forEach((key, index) => {
    storage.set(key, JSON.stringify(entries.slice(index * 32, (index + 1) * 32)));
  });

  const first = loadProfileSessionModule(storage);
  const firstDispatches: string[] = [];
  const unsubscribeFirst = first.exports.subscribeToProfileCommands((command) => {
    firstDispatches.push(command.id);
  });
  await waitFor(() => firstDispatches.includes('received'));
  await waitFor(() => [...storage.values()].some((value) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.some((entry) => (
        entry && typeof entry === 'object' &&
        (entry as Record<string, unknown>).id === 'delivered' &&
        (entry as Record<string, unknown>).status === 'completed'
      ));
    } catch {
      return false;
    }
  }));
  assert.equal((JSON.parse(storage.get(eventKey) ?? '[]') as unknown[]).length, events.length);
  assert.ok((JSON.parse(storage.get(sessionEntriesKey) ?? '[]') as unknown[]).length >= entries.length);
  assert.deepEqual(firstDispatches, ['received']);
  unsubscribeFirst();
  first.cleanupEffects();

  storage.set(commandKey, JSON.stringify(commands));
  const second = loadProfileSessionModule(storage);
  const secondDispatches: string[] = [];
  const unsubscribeSecond = second.exports.subscribeToProfileCommands((command) => {
    secondDispatches.push(command.id);
  });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(secondDispatches, []);
  unsubscribeSecond();
  second.cleanupEffects();
});

test('fresh helper modules persist one legacy startedAt identity across reloads', async () => {
  const sessionKey = 'agent-scenario-loop.profile-session.1';
  const authorityKey = `${sessionKey}.authority.1`;
  const storage = new Map<string, string>([
    [sessionKey, JSON.stringify({ active: true, scenario: 'startup', runId: 'legacy-run' })],
  ]);

  const first = loadProfileSessionModule(storage);
  await waitFor(() => storage.has(authorityKey));
  const normalizedSession = JSON.parse(storage.get(sessionKey) ?? 'null') as { startedAt?: unknown } | null;
  const normalizedManifest = JSON.parse(storage.get(authorityKey) ?? 'null') as {
    session?: { startedAt?: unknown };
  } | null;
  assert.equal(typeof normalizedSession?.startedAt, 'number');
  assert.equal(normalizedManifest?.session?.startedAt, normalizedSession?.startedAt);
  const firstStartedAt = first.exports.useProfileSession().startedAt;
  assert.equal(firstStartedAt, normalizedSession?.startedAt);
  first.cleanupEffects();

  const second = loadProfileSessionModule(storage);
  await waitFor(() => second.exports.useProfileSession().active);
  assert.equal(second.exports.useProfileSession().startedAt, firstStartedAt);
  second.cleanupEffects();
});
