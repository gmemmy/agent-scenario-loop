import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_LIVE_RESOURCE_LEASE_HEARTBEAT_MS,
  DEFAULT_LIVE_RESOURCE_LEASE_TTL_MS,
  resolveLiveResourceLeaseRoot,
} from './live-resource-lease';
import {
  acquireResourceLease,
  heartbeatResourceLease,
  releaseResourceLease,
  resolveResourceLeasePath,
} from './resource-lease';
import type {
  ResourceLeaseAcquireOptions,
  ResourceLeaseAcquireResult,
  ResourceLeaseHeartbeatOptions,
  ResourceLeaseHeartbeatResult,
  ResourceLeaseRecord,
  ResourceLeaseReleaseOptions,
  ResourceLeaseReleaseResult,
} from './resource-lease';
import type {
  ProviderExclusiveResourcePhase,
  ResolvedProviderExclusiveResourceClaim,
} from './provider-exclusive-resources';

const PROVIDER_RESOURCE_LEASE_JOURNAL_VERSION = 1 as const;
const HOST_PATH_KEYS = new Set(['detachedPath', 'guardPath', 'leasePath', 'path', 'tempPath']);
type TimerHandle = ReturnType<typeof setTimeout>;

type ProviderResourceLeaseFailureCode =
  | 'provider_resource_target_identity_missing'
  | 'provider_resource_lease_not_acquired'
  | 'provider_resource_lease_acquisition_untrusted'
  | 'provider_resource_lease_ownership_lost'
  | 'provider_resource_lease_release_untrusted';

type ProviderResourceLeaseFailure = {
  code: ProviderResourceLeaseFailureCode;
  message: string;
  nextAction: string;
  nextActionCode: string;
  providerId: string;
  rawPath: string;
};

type ProviderResourceLeaseClaimJournal = {
  acquisition?: Record<string, unknown>;
  heartbeat: {
    count: number;
    error?: { message: string };
    lastResult?: Record<string, unknown>;
  };
  claimId: string;
  leaseFileName: string;
  providerId: string;
  release?: Record<string, unknown>;
  releaseError?: { message: string };
  resource:
    | { kind: 'provider'; providerId: string; targetId?: string }
    | { kind: 'tcpPort'; host: string; port: number };
  resourceId: string;
  status:
    | 'pending'
    | 'not-acquired'
    | 'acquisition-untrusted'
    | 'held'
    | 'ownership-lost'
    | 'released'
    | 'release-untrusted';
  window: {
    acquireAt: ProviderExclusiveResourcePhase;
    releaseAfter: ProviderExclusiveResourcePhase;
  };
};

type ProviderResourceLeaseJournal = {
  claims: ProviderResourceLeaseClaimJournal[];
  heartbeatIntervalMs: number;
  ownerId: string;
  runId: string;
  schemaVersion: typeof PROVIDER_RESOURCE_LEASE_JOURNAL_VERSION;
  status:
    | 'idle'
    | 'held'
    | 'not-acquired'
    | 'acquisition-untrusted'
    | 'ownership-lost'
    | 'release-untrusted'
    | 'released';
  ttlMs: number;
};

type ProviderResourceLeaseDependencies = {
  acquire: (options: ResourceLeaseAcquireOptions) => Promise<ResourceLeaseAcquireResult>;
  heartbeat: (options: ResourceLeaseHeartbeatOptions) => Promise<ResourceLeaseHeartbeatResult>;
  release: (options: ResourceLeaseReleaseOptions) => Promise<ResourceLeaseReleaseResult>;
  clearTimer: (timer: TimerHandle) => void;
  setTimer: (callback: () => void, ms: number) => TimerHandle;
};

type ProviderResourceLeaseSessionOptions = {
  evidencePath: string;
  heartbeatIntervalMs?: number;
  leaseRoot?: string;
  ownerId: string;
  runId: string;
  ttlMs?: number;
};

type ProviderResourceLeasePhaseOptions = {
  claims: readonly ResolvedProviderExclusiveResourceClaim[];
  phase: ProviderExclusiveResourcePhase;
  providerId: string;
};

type ActiveProviderLease = {
  claim: ResolvedProviderExclusiveResourceClaim;
  heartbeatError?: unknown;
  heartbeatFailure: ResourceLeaseHeartbeatResult | null;
  heartbeatInFlight: Promise<void> | null;
  journal: ProviderResourceLeaseClaimJournal;
  lease: ResourceLeaseRecord;
  leasePath: string;
  released: boolean;
  timer: TimerHandle | null;
};

type ProviderState = {
  blocked: ProviderResourceLeaseFailure | null;
  claims: Map<string, ResolvedProviderExclusiveResourceClaim>;
};

type ProviderResourceLeaseSession = {
  afterProviderPhase: (options: ProviderResourceLeasePhaseOptions) => Promise<ProviderResourceLeaseFailure[]>;
  beforeProviderPhase: (options: ProviderResourceLeasePhaseOptions) => Promise<ProviderResourceLeaseFailure | null>;
  finalize: () => Promise<ProviderResourceLeaseFailure[]>;
  evidencePath: string;
};

const defaultDependencies: ProviderResourceLeaseDependencies = {
  acquire: acquireResourceLease,
  heartbeat: heartbeatResourceLease,
  release: releaseResourceLease,
  clearTimer: (timer) => clearTimeout(timer),
  setTimer: (callback, ms) => setTimeout(callback, ms),
};

function isTrustedAcquisition(result: ResourceLeaseAcquireResult): boolean {
  return result.status === 'acquired'
    && result.durability.status === 'synced'
    && result.cleanup.status !== 'failed'
    && result.guardCleanup.status === 'succeeded';
}

function isTrustedHeartbeat(result: ResourceLeaseHeartbeatResult): boolean {
  return result.status === 'renewed'
    && result.durability.status === 'synced'
    && result.tempCleanup.status === 'succeeded'
    && result.guardCleanup.status === 'succeeded';
}

function isTrustedRelease(result: ResourceLeaseReleaseResult): boolean {
  return result.status === 'released'
    && result.durability.status === 'synced'
    && result.detachedCleanup.status === 'succeeded'
    && result.guardCleanup.status === 'succeeded';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeLeaseEvidence(value: unknown, sensitivePaths: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLeaseEvidence(entry, sensitivePaths));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !HOST_PATH_KEYS.has(key))
        .map(([key, entry]) => [key, sanitizeLeaseEvidence(entry, sensitivePaths)]),
    );
  }
  if (typeof value === 'string') {
    return sensitivePaths
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .reduce((sanitized, sensitivePath) => sanitized.replaceAll(sensitivePath, '<host-path>'), value);
  }
  return value;
}

function summarizeLeaseEvidence(
  value: ResourceLeaseAcquireResult | ResourceLeaseHeartbeatResult | ResourceLeaseReleaseResult,
  sensitivePaths: readonly string[],
): Record<string, unknown> {
  return sanitizeLeaseEvidence(value, sensitivePaths) as Record<string, unknown>;
}

function sanitizedErrorMessage(error: unknown, sensitivePaths: readonly string[]): string {
  return sanitizeLeaseEvidence(errorMessage(error), sensitivePaths) as string;
}

async function writeJournal(filePath: string, journal: ProviderResourceLeaseJournal): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

function buildLeaseFailure({
  code,
  providerId,
  rawPath,
}: {
  code: ProviderResourceLeaseFailureCode;
  providerId: string;
  rawPath: string;
}): ProviderResourceLeaseFailure {
  switch (code) {
    case 'provider_resource_target_identity_missing':
      return {
        code,
        message: `Evidence provider ${providerId} requires an exact selected target before claiming provider-owned exclusive resources.`,
        nextAction: 'Run the provider only from a live Android or iOS profile that has already bound the exact target identity.',
        nextActionCode: 'select_exact_provider_target',
        providerId,
        rawPath,
      };
    case 'provider_resource_lease_not_acquired':
      return {
        code,
        message: `Evidence provider ${providerId} could not acquire one or more exclusive resources before mutable provider work.`,
        nextAction: 'Free the contended provider-owned resource or wait for the current owner to finish, then rerun the live proof.',
        nextActionCode: 'free_provider_owned_resource',
        providerId,
        rawPath,
      };
    case 'provider_resource_lease_acquisition_untrusted':
      return {
        code,
        message: `Evidence provider ${providerId} acquired an exclusive resource, but ASL could not trust the acquisition proof.`,
        nextAction: 'Fix the provider-owned lease lifecycle or host storage so acquisition produces durable synced evidence before rerunning.',
        nextActionCode: 'fix_provider_resource_acquisition',
        providerId,
        rawPath,
      };
    case 'provider_resource_lease_ownership_lost':
      return {
        code,
        message: `Evidence provider ${providerId} lost exclusive resource ownership during the live window.`,
        nextAction: 'Stabilize provider-owned resource ownership for the full live window, then rerun the proof.',
        nextActionCode: 'stabilize_provider_resource_ownership',
        providerId,
        rawPath,
      };
    case 'provider_resource_lease_release_untrusted':
      return {
        code,
        message: `Evidence provider ${providerId} finished work, but ASL could not trust exclusive resource release cleanup.`,
        nextAction: 'Fix provider-owned lease release cleanup so the exclusive resource can be trusted as released after the run.',
        nextActionCode: 'fix_provider_resource_release',
        providerId,
        rawPath,
      };
  }
}

function buildProviderState(claims: readonly ResolvedProviderExclusiveResourceClaim[]): Map<string, ProviderState> {
  const providers = new Map<string, ProviderState>();
  for (const claim of claims) {
    const providerState = providers.get(claim.providerId) ?? {
      blocked: null,
      claims: new Map<string, ResolvedProviderExclusiveResourceClaim>(),
    };
    providerState.claims.set(claim.id, claim);
    providers.set(claim.providerId, providerState);
  }
  return providers;
}

function providerClaimsForPhase(
  providerState: ProviderState | undefined,
  phase: ProviderExclusiveResourcePhase,
): ResolvedProviderExclusiveResourceClaim[] {
  if (!providerState) {
    return [];
  }
  return [...providerState.claims.values()]
    .filter((claim) => claim.acquireAt === phase)
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

async function createProviderResourceLeaseSession(
  options: ProviderResourceLeaseSessionOptions,
  dependencyOverrides?: Partial<ProviderResourceLeaseDependencies>,
): Promise<ProviderResourceLeaseSession> {
  const dependencies: ProviderResourceLeaseDependencies = { ...defaultDependencies, ...dependencyOverrides };
  const ttlMs = options.ttlMs ?? DEFAULT_LIVE_RESOURCE_LEASE_TTL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_LIVE_RESOURCE_LEASE_HEARTBEAT_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new Error('Provider resource lease ttlMs must be a positive integer.');
  }
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs >= ttlMs) {
    throw new Error('Provider resource lease heartbeatIntervalMs must be a positive integer lower than ttlMs.');
  }
  const leaseRoot = resolveLiveResourceLeaseRoot(options.leaseRoot);
  await fs.mkdir(leaseRoot, { recursive: true });
  const journal: ProviderResourceLeaseJournal = {
    claims: [],
    heartbeatIntervalMs,
    ownerId: options.ownerId,
    runId: options.runId,
    schemaVersion: PROVIDER_RESOURCE_LEASE_JOURNAL_VERSION,
    status: 'idle',
    ttlMs,
  };
  await writeJournal(options.evidencePath, journal);

  const providerStates = new Map<string, ProviderState>();
  const activeLeases = new Map<string, ActiveProviderLease>();

  async function persist(): Promise<void> {
    journal.status = activeLeases.size > 0 ? 'held' : 'released';
    if (journal.claims.some((claim) => claim.status === 'ownership-lost')) {
      journal.status = 'ownership-lost';
    } else if (journal.claims.some((claim) => claim.status === 'release-untrusted')) {
      journal.status = 'release-untrusted';
    } else if (journal.claims.some((claim) => claim.status === 'acquisition-untrusted')) {
      journal.status = 'acquisition-untrusted';
    } else if (journal.claims.some((claim) => claim.status === 'not-acquired')) {
      journal.status = 'not-acquired';
    } else if (activeLeases.size > 0) {
      journal.status = 'held';
    } else if (journal.claims.length === 0) {
      journal.status = 'idle';
    }
    await writeJournal(options.evidencePath, journal);
  }

  async function releaseActiveLease(activeLease: ActiveProviderLease): Promise<ProviderResourceLeaseFailure | null> {
    if (activeLease.released) {
      return null;
    }
    activeLease.released = true;
    if (activeLease.timer) {
      dependencies.clearTimer(activeLease.timer);
      activeLease.timer = null;
    }
    await activeLease.heartbeatInFlight;
    const sensitivePaths = [leaseRoot, activeLease.leasePath];
    try {
      const release = await dependencies.release({
        leaseId: activeLease.lease.leaseId,
        leasePath: activeLease.leasePath,
      });
      activeLease.journal.release = summarizeLeaseEvidence(release, sensitivePaths);
      if (!isTrustedRelease(release)) {
        activeLease.journal.status = 'release-untrusted';
        activeLeases.delete(activeLease.claim.id);
        await persist();
        return buildLeaseFailure({
          code: 'provider_resource_lease_release_untrusted',
          providerId: activeLease.claim.providerId,
          rawPath: 'raw/provider-resource-leases.json',
        });
      }
      activeLease.journal.status = activeLease.heartbeatFailure || activeLease.heartbeatError !== undefined
        ? 'ownership-lost'
        : 'released';
      activeLeases.delete(activeLease.claim.id);
      await persist();
      if (activeLease.heartbeatFailure || activeLease.heartbeatError !== undefined) {
        return buildLeaseFailure({
          code: 'provider_resource_lease_ownership_lost',
          providerId: activeLease.claim.providerId,
          rawPath: 'raw/provider-resource-leases.json',
        });
      }
      return null;
    } catch (error: unknown) {
      activeLease.journal.releaseError = { message: sanitizedErrorMessage(error, sensitivePaths) };
      activeLease.journal.status = 'release-untrusted';
      activeLeases.delete(activeLease.claim.id);
      await persist();
      return buildLeaseFailure({
        code: 'provider_resource_lease_release_untrusted',
        providerId: activeLease.claim.providerId,
        rawPath: 'raw/provider-resource-leases.json',
      });
    }
  }

  function scheduleHeartbeat(activeLease: ActiveProviderLease): void {
    const sensitivePaths = [leaseRoot, activeLease.leasePath];
    activeLease.timer = dependencies.setTimer(() => {
      activeLease.heartbeatInFlight = (async () => {
        try {
          const result = await dependencies.heartbeat({
            leaseId: activeLease.lease.leaseId,
            leasePath: activeLease.leasePath,
            ttlMs,
          });
          activeLease.journal.heartbeat = {
            count: activeLease.journal.heartbeat.count + 1,
            lastResult: summarizeLeaseEvidence(result, sensitivePaths),
          };
          if (!isTrustedHeartbeat(result)) {
            activeLease.heartbeatFailure = result;
            activeLease.journal.status = 'ownership-lost';
          }
          await persist();
        } catch (error: unknown) {
          activeLease.heartbeatError = error;
          activeLease.journal.heartbeat = {
            count: activeLease.journal.heartbeat.count + 1,
            error: { message: sanitizedErrorMessage(error, sensitivePaths) },
          };
          activeLease.journal.status = 'ownership-lost';
          await persist().catch(() => undefined);
        }
        if (!activeLease.released && activeLease.heartbeatFailure === null && activeLease.heartbeatError === undefined) {
          scheduleHeartbeat(activeLease);
        }
      })();
    }, heartbeatIntervalMs);
  }

  function providerActiveLeases(providerId: string): ActiveProviderLease[] {
    return [...activeLeases.values()]
      .filter((activeLease) => activeLease.claim.providerId === providerId)
      .sort((left, right) => right.claim.resourceId.localeCompare(left.claim.resourceId));
  }

  async function releaseProviderLeases(providerId: string): Promise<ProviderResourceLeaseFailure[]> {
    const failures: ProviderResourceLeaseFailure[] = [];
    for (const activeLease of providerActiveLeases(providerId)) {
      const failure = await releaseActiveLease(activeLease);
      if (failure) {
        failures.push(failure);
      }
    }
    return failures;
  }

  function bindProviderClaims(providerId: string, claims: readonly ResolvedProviderExclusiveResourceClaim[]): ProviderState {
    const existing = providerStates.get(providerId);
    const providerState = existing ?? { blocked: null, claims: new Map() };
    for (const claim of claims) {
      providerState.claims.set(claim.id, claim);
    }
    providerStates.set(providerId, providerState);
    return providerState;
  }

  async function beforeProviderPhase({
    claims,
    phase,
    providerId,
  }: ProviderResourceLeasePhaseOptions): Promise<ProviderResourceLeaseFailure | null> {
    const providerState = bindProviderClaims(providerId, claims);
    if (providerState.blocked) {
      return providerState.blocked;
    }

    if (providerActiveLeases(providerId).some((lease) => lease.heartbeatFailure || lease.heartbeatError !== undefined)) {
      const failures = await releaseProviderLeases(providerId);
      providerState.blocked = failures[0] ?? buildLeaseFailure({
        code: 'provider_resource_lease_ownership_lost',
        providerId,
        rawPath: 'raw/provider-resource-leases.json',
      });
      return providerState.blocked;
    }

    const enteringClaims = providerClaimsForPhase(providerState, phase)
      .filter((claim) => !activeLeases.has(claim.id));
    if (enteringClaims.length === 0) {
      return null;
    }

    const acquiredThisPhase: ActiveProviderLease[] = [];
    for (const claim of enteringClaims) {
      const leasePath = resolveResourceLeasePath({
        leaseRoot,
        resourceId: claim.resourceId,
      });
      const journalEntry: ProviderResourceLeaseClaimJournal = {
        claimId: claim.id,
        heartbeat: { count: 0 },
        leaseFileName: path.basename(leasePath),
        providerId,
        resource: claim.resolvedResource,
        resourceId: claim.resourceId,
        status: 'pending',
        window: {
          acquireAt: claim.acquireAt,
          releaseAfter: claim.releaseAfter,
        },
      };
      journal.claims.push(journalEntry);
      await persist();
      const acquisition = await dependencies.acquire({
        leasePath,
        ownerId: options.ownerId,
        resourceId: claim.resourceId,
        runId: options.runId,
        ttlMs,
      });
      const sensitivePaths = [leaseRoot, leasePath];
      journalEntry.acquisition = summarizeLeaseEvidence(acquisition, sensitivePaths);
      if (!isTrustedAcquisition(acquisition)) {
        journalEntry.status = acquisition.status === 'acquired' ? 'acquisition-untrusted' : 'not-acquired';
        await persist();
        if (acquisition.status === 'acquired') {
          try {
            const release = await dependencies.release({
              leaseId: acquisition.lease.leaseId,
              leasePath,
            });
            journalEntry.release = summarizeLeaseEvidence(release, sensitivePaths);
            if (!isTrustedRelease(release)) {
              journalEntry.releaseError = { message: 'Untrusted acquisition cleanup did not produce a trusted release.' };
            } else {
              journalEntry.status = 'acquisition-untrusted';
            }
            await persist();
          } catch (error: unknown) {
            journalEntry.releaseError = { message: sanitizedErrorMessage(error, sensitivePaths) };
            await persist();
          }
        }
        for (const acquiredLease of acquiredThisPhase.reverse()) {
          const failure = await releaseActiveLease(acquiredLease);
          if (failure) {
            providerState.blocked = failure;
          }
        }
        providerState.blocked = providerState.blocked ?? buildLeaseFailure({
          code: acquisition.status === 'acquired'
            ? 'provider_resource_lease_acquisition_untrusted'
            : 'provider_resource_lease_not_acquired',
          providerId,
          rawPath: 'raw/provider-resource-leases.json',
        });
        return providerState.blocked;
      }
      if (acquisition.status !== 'acquired') {
        throw new Error('Trusted provider resource acquisition did not return an acquired lease.');
      }
      journalEntry.status = 'held';
      const activeLease: ActiveProviderLease = {
        claim,
        heartbeatFailure: null,
        heartbeatInFlight: null,
        journal: journalEntry,
        lease: acquisition.lease,
        leasePath,
        released: false,
        timer: null,
      };
      activeLeases.set(claim.id, activeLease);
      acquiredThisPhase.push(activeLease);
      scheduleHeartbeat(activeLease);
      await persist();
    }
    return null;
  }

  async function afterProviderPhase({
    claims,
    phase,
    providerId,
  }: ProviderResourceLeasePhaseOptions): Promise<ProviderResourceLeaseFailure[]> {
    bindProviderClaims(providerId, claims);
    const failures: ProviderResourceLeaseFailure[] = [];
    if (providerActiveLeases(providerId).some((lease) => lease.heartbeatFailure || lease.heartbeatError !== undefined)) {
      const releaseFailures = await releaseProviderLeases(providerId);
      failures.push(...releaseFailures);
      if (releaseFailures.length === 0) {
        failures.push(buildLeaseFailure({
          code: 'provider_resource_lease_ownership_lost',
          providerId,
          rawPath: 'raw/provider-resource-leases.json',
        }));
      }
      const providerState = providerStates.get(providerId);
      if (providerState) {
        providerState.blocked = failures[0] ?? null;
      }
      return failures;
    }

    const exiting = providerActiveLeases(providerId)
      .filter((lease) => lease.claim.releaseAfter === phase);
    for (const activeLease of exiting) {
      const failure = await releaseActiveLease(activeLease);
      if (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      const providerState = providerStates.get(providerId);
      if (providerState) {
        providerState.blocked = failures[0] ?? null;
      }
    }
    return failures;
  }

  async function finalize(): Promise<ProviderResourceLeaseFailure[]> {
    const failures: ProviderResourceLeaseFailure[] = [];
    const active = [...activeLeases.values()]
      .sort((left, right) => right.claim.resourceId.localeCompare(left.claim.resourceId));
    for (const activeLease of active) {
      const failure = await releaseActiveLease(activeLease);
      if (failure) {
        failures.push(failure);
      }
    }
    await persist();
    return failures;
  }

  return {
    afterProviderPhase,
    beforeProviderPhase,
    evidencePath: options.evidencePath,
    finalize,
  };
}

export {
  PROVIDER_RESOURCE_LEASE_JOURNAL_VERSION,
  createProviderResourceLeaseSession,
};

export type {
  ProviderResourceLeaseClaimJournal,
  ProviderResourceLeaseDependencies,
  ProviderResourceLeaseFailure,
  ProviderResourceLeaseFailureCode,
  ProviderResourceLeaseJournal,
  ProviderResourceLeaseSession,
  ProviderResourceLeaseSessionOptions,
};
