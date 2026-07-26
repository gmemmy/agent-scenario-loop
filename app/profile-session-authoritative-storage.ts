export type ProfileSessionAuthoritySession = {
  scenario: string;
  runId: string;
  startedAt: number;
};

export type ProfileSessionAuthorityStorageAdapter = {
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
};

export type ProfileSessionAuthorityStorageKeys = {
  command: string;
  event: string;
  session: string;
  sessionEntries: string;
};

type ProfileSessionAuthorityManifest = {
  schemaVersion: 1;
  generation: number;
  status: 'active' | 'failed' | 'stopped';
  session: ProfileSessionAuthoritySession;
  eventChunkKeys: string[];
  sessionEntryChunkKeys: string[];
};

export type ProfileSessionAuthorityRecovery<Event, Entry> =
  | { kind: 'new-session' }
  | { kind: 'stopped-session' }
  | { kind: 'recovered'; events: Event[]; sessionEntries: Entry[] };

export type ProfileSessionAuthoritativeStorage<Event, Entry> = {
  appendEvent: (event: Event) => void;
  appendSessionEntry: (entry: Entry, forceMaterialize?: boolean) => void;
  barrier: () => Promise<void>;
  enqueue: (mutation: () => Promise<void>) => Promise<void>;
  flush: () => Promise<void>;
  isAvailable: () => boolean;
  recover: (session: ProfileSessionAuthoritySession) => Promise<ProfileSessionAuthorityRecovery<Event, Entry>>;
  start: (session: ProfileSessionAuthoritySession) => void;
  stop: (session: ProfileSessionAuthoritySession) => void;
};

const AUTHORITY_SCHEMA_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 32;

export function resolveProfileSessionAuthorityStartedAt(
  storedStartedAt: unknown,
  fallbackStartedAt: number,
): number {
  if (typeof storedStartedAt === 'number' && Number.isFinite(storedStartedAt)) {
    return storedStartedAt;
  }
  if (!Number.isFinite(fallbackStartedAt)) {
    throw new Error('Profile-session authority fallback start time must be finite.');
  }
  return fallbackStartedAt;
}

export async function normalizeProfileSessionAuthorityIdentity<Session extends object>(
  session: Session,
  fallbackStartedAt: number,
  persist: (normalizedSession: Session & { startedAt: number }) => Promise<void>,
): Promise<Session & { startedAt: number }> {
  const startedAt = resolveProfileSessionAuthorityStartedAt(
    (session as { startedAt?: unknown }).startedAt,
    fallbackStartedAt,
  );
  const normalizedSession = { ...session, startedAt };
  if ((session as { startedAt?: unknown }).startedAt !== startedAt) {
    await persist(normalizedSession);
  }
  return normalizedSession;
}

function sameSession(
  left: ProfileSessionAuthoritySession,
  right: ProfileSessionAuthoritySession,
): boolean {
  return left.scenario === right.scenario &&
    left.runId === right.runId &&
    left.startedAt === right.startedAt;
}

function parseJson<Value>(value: string | null, fallback: Value): Value {
  if (value === null) {
    return fallback;
  }
  return JSON.parse(value) as Value;
}

function isAuthorityManifest(value: unknown): value is ProfileSessionAuthorityManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const manifest = value as Partial<ProfileSessionAuthorityManifest>;
  return manifest.schemaVersion === AUTHORITY_SCHEMA_VERSION &&
    typeof manifest.generation === 'number' &&
    Number.isInteger(manifest.generation) &&
    manifest.generation >= 0 &&
    (manifest.status === 'active' || manifest.status === 'failed' || manifest.status === 'stopped') &&
    Boolean(manifest.session) &&
    typeof manifest.session?.scenario === 'string' &&
    typeof manifest.session?.runId === 'string' &&
    typeof manifest.session?.startedAt === 'number' &&
    Number.isFinite(manifest.session.startedAt) &&
    Array.isArray(manifest.eventChunkKeys) &&
    manifest.eventChunkKeys.every((key) => typeof key === 'string') &&
    Array.isArray(manifest.sessionEntryChunkKeys) &&
    manifest.sessionEntryChunkKeys.every((key) => typeof key === 'string');
}

/**
 * Stores active-session truth in bounded append chunks while retaining the
 * existing runner-facing arrays as compatibility projections.
 */
export function createProfileSessionAuthoritativeStorage<Event, Entry>({
  chunkSize = DEFAULT_CHUNK_SIZE,
  keys,
  onFailure,
  storage,
  validateEvent,
  validateSessionEntry,
}: {
  chunkSize?: number;
  keys: ProfileSessionAuthorityStorageKeys;
  onFailure: (error: unknown) => void;
  storage: ProfileSessionAuthorityStorageAdapter;
  validateEvent: (value: unknown, session: ProfileSessionAuthoritySession) => boolean;
  validateSessionEntry: (value: unknown, session: ProfileSessionAuthoritySession) => boolean;
}): ProfileSessionAuthoritativeStorage<Event, Entry> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('Profile-session authority chunk size must be a positive integer.');
  }

  const authorityKey = `${keys.session}.authority.${AUTHORITY_SCHEMA_VERSION}`;
  let chain = Promise.resolve();
  let failed = false;
  let failureReported = false;
  let manifest: ProfileSessionAuthorityManifest | null = null;
  let eventChunks: Event[][] = [];
  let sessionEntryChunks: Entry[][] = [];
  let materializeTimer: ReturnType<typeof setTimeout> | null = null;
  let emergencyBoundary = Promise.resolve();

  const persistEmergencyBoundary = () => {
    const failedManifest = manifest ? { ...manifest, status: 'failed' as const } : null;
    if (failedManifest) {
      manifest = failedManifest;
    }
    emergencyBoundary = (async () => {
      if (failedManifest) {
        try {
          await storage.setItem(authorityKey, JSON.stringify(failedManifest));
        } catch {
          // Session and command removal still provide a second fail-closed boundary.
        }
      }
      await Promise.allSettled([
        storage.removeItem(keys.command),
        storage.removeItem(keys.session),
      ]);
    })();
  };

  const reportFailure = (error: unknown) => {
    failed = true;
    if (materializeTimer !== null) {
      clearTimeout(materializeTimer);
      materializeTimer = null;
    }
    if (failureReported) {
      return;
    }
    failureReported = true;
    persistEmergencyBoundary();
    onFailure(error);
  };

  const enqueue = (mutation: () => Promise<void>): Promise<void> => {
    const operation = chain.then(async () => {
      if (failed) {
        throw new Error('Profile-session authoritative storage is unavailable.');
      }
      await mutation();
    });
    chain = operation.catch((error: unknown) => {
      reportFailure(error);
    });
    return operation;
  };

  const readManifest = async (): Promise<ProfileSessionAuthorityManifest | null> => {
    const stored = await storage.getItem(authorityKey);
    if (stored === null) {
      return null;
    }
    const parsed = JSON.parse(stored) as unknown;
    if (!isAuthorityManifest(parsed)) {
      throw new Error('Profile-session authority manifest is invalid.');
    }
    const expectedEventChunkKeys = parsed.eventChunkKeys.map((_, index) => (
      `${authorityKey}.${parsed.generation}.event.${index}`
    ));
    const expectedSessionEntryChunkKeys = parsed.sessionEntryChunkKeys.map((_, index) => (
      `${authorityKey}.${parsed.generation}.session-entry.${index}`
    ));
    if (
      parsed.eventChunkKeys.some((key, index) => key !== expectedEventChunkKeys[index]) ||
      parsed.sessionEntryChunkKeys.some((key, index) => key !== expectedSessionEntryChunkKeys[index])
    ) {
      throw new Error('Profile-session authority manifest chunk keys are invalid.');
    }
    return parsed;
  };

  const materialize = async () => {
    await Promise.all([
      storage.setItem(keys.event, JSON.stringify(eventChunks.flat())),
      storage.setItem(keys.sessionEntries, JSON.stringify(sessionEntryChunks.flat())),
    ]);
  };

  const scheduleMaterialize = () => {
    if (failed) {
      return;
    }
    if (materializeTimer !== null) {
      clearTimeout(materializeTimer);
    }
    materializeTimer = setTimeout(() => {
      materializeTimer = null;
      void enqueue(materialize);
    }, 0);
  };

  const writeManifest = async () => {
    if (!manifest) {
      throw new Error('Profile-session authority manifest is unavailable.');
    }
    await storage.setItem(authorityKey, JSON.stringify(manifest));
  };

  const removeChunks = async (currentManifest: ProfileSessionAuthorityManifest | null) => {
    if (!currentManifest) {
      return;
    }
    await Promise.all(
      [...currentManifest.eventChunkKeys, ...currentManifest.sessionEntryChunkKeys]
        .map((key) => storage.removeItem(key)),
    );
  };

  const appendChunked = async <Value>(
    kind: 'event' | 'session-entry',
    chunks: Value[][],
    value: Value,
  ) => {
    if (!manifest || manifest.status !== 'active') {
      throw new Error('Profile-session authoritative storage has no active session.');
    }
    let chunk = chunks.at(-1);
    let chunkIndex = chunks.length - 1;
    let createdChunk = false;
    if (!chunk || chunk.length >= chunkSize) {
      chunk = [];
      chunks.push(chunk);
      chunkIndex = chunks.length - 1;
      createdChunk = true;
    }
    chunk.push(value);
    const chunkKey = `${authorityKey}.${manifest.generation}.${kind}.${chunkIndex}`;
    const manifestKeys = kind === 'event'
      ? manifest.eventChunkKeys
      : manifest.sessionEntryChunkKeys;
    if (createdChunk) {
      // Publish the chunk before adding it to the manifest so concurrent runner
      // reads never observe an authority pointer to a missing chunk.
      await storage.setItem(chunkKey, JSON.stringify(chunk));
      manifestKeys[chunkIndex] = chunkKey;
      await writeManifest();
      return;
    }
    await storage.setItem(chunkKey, JSON.stringify(chunk));
  };

  return {
    appendEvent: (event) => {
      void enqueue(async () => {
        await appendChunked('event', eventChunks, event);
      });
    },
    appendSessionEntry: (entry, forceMaterialize = false) => {
      void enqueue(async () => {
        await appendChunked('session-entry', sessionEntryChunks, entry);
        if (forceMaterialize) {
          scheduleMaterialize();
        }
      });
    },
    barrier: async () => {
      await chain;
      await emergencyBoundary;
    },
    enqueue,
    flush: async () => {
      await enqueue(async () => {
        if (materializeTimer !== null) {
          clearTimeout(materializeTimer);
          materializeTimer = null;
        }
        await materialize();
      });
    },
    isAvailable: () => !failed,
    recover: async (session) => {
      let recovery: ProfileSessionAuthorityRecovery<Event, Entry> = { kind: 'new-session' };
      await enqueue(async () => {
        const storedManifest = await readManifest();
        if (!storedManifest || !sameSession(storedManifest.session, session)) {
          recovery = { kind: 'new-session' };
          return;
        }
        if (storedManifest.status === 'stopped') {
          recovery = { kind: 'stopped-session' };
          return;
        }
        if (storedManifest.status === 'failed') {
          throw new Error('Profile-session authority records a storage failure.');
        }
        const loadedEventChunks = await Promise.all(
          storedManifest.eventChunkKeys.map(async (key) => {
            const chunk = parseJson<unknown>(await storage.getItem(key), null);
            if (!Array.isArray(chunk)) {
              throw new Error(`Profile-session event authority chunk is missing: ${key}`);
            }
            if (chunk.length === 0 || chunk.length > chunkSize) {
              throw new Error(`Profile-session event authority chunk has invalid length: ${key}`);
            }
            if (!chunk.every((value) => validateEvent(value, storedManifest.session))) {
              throw new Error(`Profile-session event authority chunk is invalid: ${key}`);
            }
            return chunk as Event[];
          }),
        );
        const loadedSessionEntryChunks = await Promise.all(
          storedManifest.sessionEntryChunkKeys.map(async (key) => {
            const chunk = parseJson<unknown>(await storage.getItem(key), null);
            if (!Array.isArray(chunk)) {
              throw new Error(`Profile-session entry authority chunk is missing: ${key}`);
            }
            if (chunk.length === 0 || chunk.length > chunkSize) {
              throw new Error(`Profile-session entry authority chunk has invalid length: ${key}`);
            }
            if (!chunk.every((value) => validateSessionEntry(value, storedManifest.session))) {
              throw new Error(`Profile-session entry authority chunk is invalid: ${key}`);
            }
            return chunk as Entry[];
          }),
        );
        manifest = storedManifest;
        eventChunks = loadedEventChunks;
        sessionEntryChunks = loadedSessionEntryChunks;
        await materialize();
        recovery = {
          kind: 'recovered',
          events: eventChunks.flat(),
          sessionEntries: sessionEntryChunks.flat(),
        };
      });
      return recovery;
    },
    start: (session) => {
      void enqueue(async () => {
        const previousManifest = await readManifest();
        const generation = (previousManifest?.generation ?? 0) + 1;
        eventChunks = [];
        sessionEntryChunks = [];
        manifest = {
          schemaVersion: AUTHORITY_SCHEMA_VERSION,
          generation,
          status: 'active',
          session,
          eventChunkKeys: [],
          sessionEntryChunkKeys: [],
        };
        // Supersede old pointers before garbage collection. A concurrent runner
        // sees either the old complete generation or this new empty generation.
        await writeManifest();
        await removeChunks(previousManifest);
        await Promise.all([
          storage.removeItem(keys.event),
          storage.removeItem(keys.sessionEntries),
        ]);
      });
    },
    stop: (session) => {
      void enqueue(async () => {
        const currentManifest = manifest ?? await readManifest();
        if (currentManifest && sameSession(currentManifest.session, session)) {
          manifest = { ...currentManifest, status: 'stopped' };
          await writeManifest();
        }
        await Promise.all([
          storage.removeItem(keys.command),
          storage.removeItem(keys.session),
        ]);
      });
    },
  };
}
