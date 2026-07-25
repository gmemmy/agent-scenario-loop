import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  acquireResourceLease,
  buildMobileTargetResourceId,
  heartbeatResourceLease,
  releaseResourceLease,
  resolveResourceLeasePath,
} from './resource-lease';

import type {
  ResourceLeaseAcquireOptions,
  ResourceLeaseAcquireResult,
  ResourceLeaseHeartbeatOptions,
  ResourceLeaseHeartbeatResult,
  ResourceLeaseReleaseOptions,
  ResourceLeaseReleaseResult,
  ResourceLeaseRecord,
} from './resource-lease';

const LIVE_RESOURCE_LEASE_JOURNAL_VERSION = 1 as const;
const DEFAULT_LIVE_RESOURCE_LEASE_TTL_MS = 120_000;
const DEFAULT_LIVE_RESOURCE_LEASE_HEARTBEAT_MS = 30_000;
type TimerHandle = ReturnType<typeof setTimeout>;

type LiveResourceLeasePlatform = 'android' | 'ios';

type LiveResourceLeaseDependencies = {
  acquire: (options: ResourceLeaseAcquireOptions) => Promise<ResourceLeaseAcquireResult>;
  heartbeat: (options: ResourceLeaseHeartbeatOptions) => Promise<ResourceLeaseHeartbeatResult>;
  release: (options: ResourceLeaseReleaseOptions) => Promise<ResourceLeaseReleaseResult>;
  setTimer: (callback: () => void, ms: number) => TimerHandle;
  clearTimer: (timer: TimerHandle) => void;
};

type LiveResourceLeaseJournal = {
  schemaVersion: typeof LIVE_RESOURCE_LEASE_JOURNAL_VERSION;
  status:
    | 'acquiring'
    | 'acquisition-untrusted'
    | 'held'
    | 'ownership-lost'
    | 'releasing'
    | 'released'
    | 'release-untrusted'
    | 'not-acquired';
  runId: string;
  ownerId: string;
  resource: {
    platform: LiveResourceLeasePlatform;
    resourceId: string;
    targetId: string;
  };
  leaseFileName: string;
  ttlMs: number;
  heartbeatIntervalMs: number;
  acquisition?: Record<string, unknown>;
  heartbeat: {
    count: number;
    lastResult?: Record<string, unknown>;
    error?: { message: string };
  };
  release?: Record<string, unknown>;
  releaseError?: { message: string };
  callbackError?: { message: string };
};

type RunWithLiveResourceLeaseOptions<T> = {
  evidencePath: string;
  heartbeatIntervalMs?: number;
  leaseRoot?: string;
  ownerId: string;
  platform: LiveResourceLeasePlatform;
  run: (lease: ResourceLeaseRecord) => Promise<T> | T;
  runId: string;
  targetId: string;
  ttlMs?: number;
};

const defaultDependencies: LiveResourceLeaseDependencies = {
  acquire: acquireResourceLease,
  heartbeat: heartbeatResourceLease,
  release: releaseResourceLease,
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

class LiveResourceLeaseError extends Error {
  readonly code: string;
  readonly evidencePath: string;

  constructor(code: string, message: string, evidencePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LiveResourceLeaseError';
    this.code = code;
    this.evidencePath = evidencePath;
  }
}

function resolveLiveResourceLeaseRoot(value?: string): string {
  const configured = value?.trim() || process.env.ASL_RESOURCE_LEASE_DIR?.trim();
  return configured || path.join(os.tmpdir(), 'agent-scenario-loop', 'resource-leases');
}

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

const HOST_PATH_KEYS = new Set(['detachedPath', 'guardPath', 'leasePath', 'path', 'tempPath']);

function sanitizeLeaseEvidence(
  value: unknown,
  sensitivePaths: readonly string[],
): unknown {
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

async function writeJournal(filePath: string, journal: LiveResourceLeaseJournal): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

async function runWithLiveResourceLease<T>(
  options: RunWithLiveResourceLeaseOptions<T>,
  dependencyOverrides?: Partial<LiveResourceLeaseDependencies>,
): Promise<T> {
  const dependencies: LiveResourceLeaseDependencies = { ...defaultDependencies, ...dependencyOverrides };
  const ttlMs = options.ttlMs ?? DEFAULT_LIVE_RESOURCE_LEASE_TTL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_LIVE_RESOURCE_LEASE_HEARTBEAT_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new Error('Resource lease ttlMs must be a positive integer.');
  }
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs >= ttlMs) {
    throw new Error('Resource lease heartbeatIntervalMs must be a positive integer lower than ttlMs.');
  }

  const resourceId = buildMobileTargetResourceId({ platform: options.platform, targetId: options.targetId });
  const leaseRoot = resolveLiveResourceLeaseRoot(options.leaseRoot);
  const leasePath = resolveResourceLeasePath({ leaseRoot, resourceId });
  await fs.mkdir(leaseRoot, { recursive: true });
  const journal: LiveResourceLeaseJournal = {
    schemaVersion: LIVE_RESOURCE_LEASE_JOURNAL_VERSION,
    status: 'acquiring',
    runId: options.runId,
    ownerId: options.ownerId,
    resource: {
      platform: options.platform,
      resourceId,
      targetId: options.targetId,
    },
    leaseFileName: path.basename(leasePath),
    ttlMs,
    heartbeatIntervalMs,
    heartbeat: { count: 0 },
  };
  await writeJournal(options.evidencePath, journal);

  const acquisition = await dependencies.acquire({
    leasePath,
    ownerId: options.ownerId,
    resourceId,
    runId: options.runId,
    ttlMs,
  });
  const sensitivePaths = [leaseRoot, leasePath];
  journal.acquisition = summarizeLeaseEvidence(acquisition, sensitivePaths);
  if (!isTrustedAcquisition(acquisition)) {
    if (acquisition.status === 'acquired') {
      journal.status = 'acquisition-untrusted';
      try {
        const release = await dependencies.release({ leaseId: acquisition.lease.leaseId, leasePath });
        journal.release = summarizeLeaseEvidence(release, sensitivePaths);
        if (!isTrustedRelease(release)) {
          journal.releaseError = { message: 'Untrusted acquisition cleanup did not produce a trusted release.' };
        }
      } catch (error: unknown) {
        journal.releaseError = { message: sanitizedErrorMessage(error, sensitivePaths) };
      }
    } else {
      journal.status = 'not-acquired';
    }
    await writeJournal(options.evidencePath, journal);
    throw new LiveResourceLeaseError(
      acquisition.status === 'acquired'
        ? 'resource_lease_acquisition_untrusted'
        : 'resource_lease_not_acquired',
      acquisition.status === 'acquired'
        ? `Resource lease acquisition was not trustworthy for ${resourceId}. Inspect ${options.evidencePath}.`
        : `Resource lease was not acquired for ${resourceId}. Inspect ${options.evidencePath}.`,
      options.evidencePath,
    );
  }
  if (acquisition.status !== 'acquired') {
    throw new Error('Trusted resource lease acquisition did not contain an acquired lease.');
  }

  journal.status = 'held';
  await writeJournal(options.evidencePath, journal);
  let stopped = false;
  let timer: TimerHandle | null = null;
  let heartbeatInFlight: Promise<void> | null = null;
  let heartbeatFailure: ResourceLeaseHeartbeatResult | null = null;
  let heartbeatError: unknown;

  const scheduleHeartbeat = (): void => {
    timer = dependencies.setTimer(() => {
      heartbeatInFlight = (async () => {
        try {
          const result = await dependencies.heartbeat({
            leaseId: acquisition.lease.leaseId,
            leasePath,
            ttlMs,
          });
          journal.heartbeat = {
            count: journal.heartbeat.count + 1,
            lastResult: summarizeLeaseEvidence(result, sensitivePaths),
          };
          if (!isTrustedHeartbeat(result)) {
            heartbeatFailure = result;
            journal.status = 'ownership-lost';
          }
          await writeJournal(options.evidencePath, journal);
        } catch (error: unknown) {
          heartbeatError = error;
          journal.heartbeat = {
            count: journal.heartbeat.count + 1,
            error: { message: sanitizedErrorMessage(error, sensitivePaths) },
          };
          journal.status = 'ownership-lost';
          await writeJournal(options.evidencePath, journal).catch(() => undefined);
        }
        if (!stopped && heartbeatFailure === null && heartbeatError === undefined) {
          scheduleHeartbeat();
        }
      })();
    }, heartbeatIntervalMs);
  };
  scheduleHeartbeat();

  let callbackValue: T | undefined;
  let callbackError: unknown;
  try {
    callbackValue = await Promise.resolve(options.run(acquisition.lease));
  } catch (error: unknown) {
    callbackError = error;
    journal.callbackError = { message: sanitizedErrorMessage(error, sensitivePaths) };
  } finally {
    stopped = true;
    if (timer) {
      dependencies.clearTimer(timer);
    }
    await heartbeatInFlight;
    const ownershipLost = heartbeatFailure !== null || heartbeatError !== undefined;
    journal.status = 'releasing';
    await writeJournal(options.evidencePath, journal);
    try {
      const release = await dependencies.release({ leaseId: acquisition.lease.leaseId, leasePath });
      journal.release = summarizeLeaseEvidence(release, sensitivePaths);
      if (!isTrustedRelease(release)) {
        journal.status = 'release-untrusted';
      } else if (ownershipLost) {
        journal.status = 'ownership-lost';
      } else {
        journal.status = 'released';
      }
    } catch (error: unknown) {
      journal.releaseError = { message: sanitizedErrorMessage(error, sensitivePaths) };
      journal.status = 'release-untrusted';
    }
    await writeJournal(options.evidencePath, journal);
  }

  if (heartbeatFailure || heartbeatError !== undefined) {
    throw new LiveResourceLeaseError(
      'resource_lease_ownership_lost',
      `Resource lease ownership was lost for ${resourceId}. Inspect ${options.evidencePath}.`,
      options.evidencePath,
      callbackError || heartbeatError
        ? { cause: callbackError ?? heartbeatError }
        : undefined,
    );
  }
  if (journal.status === 'release-untrusted') {
    throw new LiveResourceLeaseError(
      'resource_lease_release_untrusted',
      `Resource lease release was not trustworthy for ${resourceId}. Inspect ${options.evidencePath}.`,
      options.evidencePath,
      callbackError ? { cause: callbackError } : undefined,
    );
  }
  if (callbackError) {
    throw callbackError;
  }
  return callbackValue as T;
}

export {
  DEFAULT_LIVE_RESOURCE_LEASE_HEARTBEAT_MS,
  DEFAULT_LIVE_RESOURCE_LEASE_TTL_MS,
  LIVE_RESOURCE_LEASE_JOURNAL_VERSION,
  LiveResourceLeaseError,
  resolveLiveResourceLeaseRoot,
  runWithLiveResourceLease,
};

export type {
  LiveResourceLeaseDependencies,
  LiveResourceLeaseJournal,
  LiveResourceLeasePlatform,
  RunWithLiveResourceLeaseOptions,
};
