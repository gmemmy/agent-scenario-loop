import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const RESOURCE_LEASE_SCHEMA_VERSION = 1 as const;
const OPERATION_GUARD_SCHEMA_VERSION = 1 as const;
const OPERATION_GUARD_TTL_MS = 30_000;

type ResourceLeaseRecord = {
  schemaVersion: typeof RESOURCE_LEASE_SCHEMA_VERSION;
  leaseId: string;
  resourceId: string;
  ownerId: string;
  runId: string;
  pid: number;
  hostname: string;
  createdAt: number;
  heartbeatAt: number;
  expiresAt: number;
  ttlMs: number;
};

type ResourceLeasePidLiveness = 'alive' | 'dead' | 'unknown';

type ResourceLeaseError = {
  code?: string;
  message: string;
};

type ResourceLeaseInspection =
  | { status: 'available'; leasePath: string }
  | {
      status: 'held';
      leasePath: string;
      record: ResourceLeaseRecord;
      pidLiveness: ResourceLeasePidLiveness;
    }
  | {
      status: 'stale';
      leasePath: string;
      record: ResourceLeaseRecord;
      pidLiveness: ResourceLeasePidLiveness;
      staleReason: 'expired' | 'owner-dead';
    }
  | {
      status: 'invalid';
      leasePath: string;
      invalidReason: 'unreadable' | 'malformed';
      detail: string;
      error?: ResourceLeaseError;
    };

type AcquirePhase =
  | 'preflight'
  | 'operation-guard'
  | 'write-temp'
  | 'sync-temp'
  | 'publish-link'
  | 'sync-directory'
  | 'cleanup-temp'
  | 'cleanup-guard'
  | 'complete';

type HeartbeatPhase =
  | 'preflight'
  | 'operation-guard'
  | 'read-existing'
  | 'write-temp'
  | 'sync-temp'
  | 'publish-rename'
  | 'sync-directory'
  | 'cleanup-temp'
  | 'cleanup-guard'
  | 'complete';

type ReleasePhase =
  | 'preflight'
  | 'operation-guard'
  | 'detach-candidate'
  | 'read-detached'
  | 'restore-detached'
  | 'unlink-detached'
  | 'sync-directory'
  | 'cleanup-detached'
  | 'cleanup-guard'
  | 'complete';

type AcquireCleanup = { status: 'not-needed' } | { status: 'succeeded' } | { status: 'failed'; message: string };
type CleanupWithError = { status: 'not-needed' } | { status: 'succeeded' } | { status: 'failed'; error: ResourceLeaseError };

type ResourceLeaseOperationGuard =
  | { status: 'acquired'; guardPath: string; guardId: string }
  | { status: 'contended'; guardPath: string; detail: string; guardOwner?: { operation: string; leaseId?: string } }
  | { status: 'orphaned'; guardPath: string; detail: string; guardOwner?: { operation: string; leaseId?: string } };

type ResourceLeaseAcquireResult =
  | {
      status: 'acquired';
      phase: 'sync-directory' | 'cleanup-temp' | 'cleanup-guard' | 'complete';
      leasePath: string;
      lease: ResourceLeaseRecord;
      tempPath: string;
      operationGuard: ResourceLeaseOperationGuard;
      durability: { status: 'synced' } | { status: 'sync-failed'; error: ResourceLeaseError };
      cleanup: AcquireCleanup;
      guardCleanup: CleanupWithError;
    }
  | {
      status: 'contended' | 'cancelled' | 'failed';
      phase: AcquirePhase;
      leasePath: string;
      tempPath?: string;
      operationGuard: ResourceLeaseOperationGuard;
      cleanup: AcquireCleanup;
      guardCleanup: CleanupWithError;
      error: ResourceLeaseError;
    };

type ResourceLeaseHeartbeatResult =
  | {
      status: 'renewed';
      phase: 'complete';
      leasePath: string;
      lease: ResourceLeaseRecord;
      operationGuard: ResourceLeaseOperationGuard;
      tempPath: string;
      durability: { status: 'synced' } | { status: 'sync-failed'; error: ResourceLeaseError };
      tempCleanup: CleanupWithError;
      guardCleanup: CleanupWithError;
    }
  | {
      status: 'missing' | 'invalid' | 'cancelled' | 'failed' | 'contended';
      phase: HeartbeatPhase;
      leasePath: string;
      operationGuard: ResourceLeaseOperationGuard;
      tempPath?: string;
      tempCleanup: CleanupWithError;
      guardCleanup: CleanupWithError;
      error: ResourceLeaseError;
    }
  | {
      status: 'mismatch';
      phase: HeartbeatPhase;
      leasePath: string;
      operationGuard: ResourceLeaseOperationGuard;
      tempPath?: string;
      tempCleanup: CleanupWithError;
      guardCleanup: CleanupWithError;
      expectedLeaseId: string;
      foundLeaseId: string;
      error: ResourceLeaseError;
    };

type DetachedLeaseDisposition =
  | { status: 'restored'; path: string; cleanup: CleanupWithError }
  | { status: 'preserved'; path: string; cleanup: CleanupWithError }
  | { status: 'preserved-at-detached'; path: string; cleanup: CleanupWithError };

type ResourceLeaseReleaseResult =
  | {
      status: 'released';
      phase: 'complete';
      leasePath: string;
      leaseId: string;
      detachedPath: string;
      operationGuard: ResourceLeaseOperationGuard;
      guardCleanup: CleanupWithError;
      detachedCleanup: CleanupWithError;
      durability: { status: 'synced' } | { status: 'sync-failed'; error: ResourceLeaseError };
    }
  | {
      status: 'retained';
      phase: ReleasePhase;
      leasePath: string;
      leaseId: string;
      operationGuard: ResourceLeaseOperationGuard;
      guardCleanup: CleanupWithError;
      reason: 'operation-in-progress' | 'operation-guard-orphaned' | 'missing' | 'mismatch' | 'invalid' | 'replaced';
      detachedPath?: string;
      detachedDisposition?: DetachedLeaseDisposition;
      foundLeaseId?: string;
      error?: ResourceLeaseError;
    }
  | {
      status: 'cancelled' | 'failed';
      phase: ReleasePhase;
      leasePath: string;
      leaseId: string;
      operationGuard: ResourceLeaseOperationGuard;
      guardCleanup: CleanupWithError;
      detachedCleanup: CleanupWithError;
      detachedPath?: string;
      detachedDisposition?: DetachedLeaseDisposition;
      error: ResourceLeaseError;
    };

type CleanResourceLeaseReleaseResult = Extract<ResourceLeaseReleaseResult, { status: 'released' }> & {
  guardCleanup: { status: 'succeeded' };
  detachedCleanup: { status: 'succeeded' };
  durability: { status: 'synced' };
};

type ResourceLeaseInspectOptions = { leasePath: string };

type ResourceLeaseAcquireOptions = {
  leasePath: string;
  resourceId: string;
  ownerId: string;
  runId: string;
  ttlMs: number;
  signal?: AbortSignal;
};

type ResourceLeaseHeartbeatOptions = {
  leasePath: string;
  leaseId: string;
  ttlMs?: number;
  signal?: AbortSignal;
};

type ResourceLeaseReleaseOptions = {
  leasePath: string;
  leaseId: string;
  signal?: AbortSignal;
};

type RunWithResourceLeaseOptions<T> = ResourceLeaseAcquireOptions & {
  run: (lease: ResourceLeaseRecord) => Promise<T> | T;
};

type RunWithResourceLeaseResult<T> =
  | {
      status: 'completed';
      acquisition: Extract<ResourceLeaseAcquireResult, { status: 'acquired' }>;
      release: CleanResourceLeaseReleaseResult;
      value: T;
    }
  | {
      status: 'acquisition-untrusted';
      acquisition: Extract<ResourceLeaseAcquireResult, { status: 'acquired' }>;
      release: ResourceLeaseReleaseResult;
      error: ResourceLeaseError;
    }
  | {
      status: 'not-acquired';
      acquisition: Exclude<ResourceLeaseAcquireResult, { status: 'acquired' }>;
    }
  | {
      status: 'cancelled';
      phase: 'preflight' | 'callback';
      acquisition?: Extract<ResourceLeaseAcquireResult, { status: 'acquired' }>;
      release?: ResourceLeaseReleaseResult;
      error: ResourceLeaseError;
    }
  | {
      status: 'callback-failed';
      acquisition: Extract<ResourceLeaseAcquireResult, { status: 'acquired' }>;
      release: ResourceLeaseReleaseResult;
      error: ResourceLeaseError;
    }
  | {
      status: 'cleanup-failed';
      acquisition: Extract<ResourceLeaseAcquireResult, { status: 'acquired' }>;
      release: ResourceLeaseReleaseResult;
      callback:
        | { status: 'completed'; value: T }
        | { status: 'cancelled'; error: ResourceLeaseError }
        | { status: 'failed'; error: ResourceLeaseError };
    };

type ResourceLeaseFileHandle = {
  readFile(encoding: 'utf8'): Promise<string>;
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

type ResourceLeaseFs = {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  open(filePath: string, flags: string, mode?: number): Promise<ResourceLeaseFileHandle>;
  unlink(filePath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
};

type ResourceLeaseDependencies = {
  nowMs: () => number;
  createLeaseId: () => string;
  createGuardId: () => string;
  getPid: () => number;
  getHostname: () => string;
  probePidLiveness: (
    hostname: string,
    pid: number,
  ) => Promise<ResourceLeasePidLiveness> | ResourceLeasePidLiveness;
  fs: ResourceLeaseFs;
  syncDirectory: (directoryPath: string) => Promise<void>;
};

type OperationGuardRecord = {
  schemaVersion: typeof OPERATION_GUARD_SCHEMA_VERSION;
  guardId: string;
  operation: 'acquire' | 'heartbeat' | 'release';
  leaseId?: string;
  pid: number;
  hostname: string;
  createdAt: number;
  expiresAt: number;
};

function guardDetail(guard: ResourceLeaseOperationGuard): string {
  return guard.status === 'acquired' ? 'Operation guard acquired.' : guard.detail;
}

const defaultDependencies: ResourceLeaseDependencies = {
  nowMs: () => Date.now(),
  createLeaseId: () => randomUUID(),
  createGuardId: () => randomUUID(),
  getPid: () => process.pid,
  getHostname: () => os.hostname(),
  probePidLiveness: (hostname, pid) => {
    if (hostname !== os.hostname()) {
      return 'unknown';
    }
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch (error: unknown) {
      if (isNodeErrno(error) && error.code === 'ESRCH') {
        return 'dead';
      }
      if (isNodeErrno(error) && error.code === 'EPERM') {
        return 'alive';
      }
      return 'unknown';
    }
  },
  fs: {
    readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
    open: async (filePath, flags, mode) => {
      const handle = await fs.open(filePath, flags, mode);
      return {
        readFile: (encoding) => handle.readFile(encoding),
        write: async (buffer, offset, length, position) => {
          const writeResult = await handle.write(buffer, offset, length, position);
          return { bytesWritten: writeResult.bytesWritten };
        },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
    unlink: (filePath) => fs.unlink(filePath),
    link: (existingPath, newPath) => fs.link(existingPath, newPath),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  },
  syncDirectory: async (directoryPath) => {
    const handle = await fs.open(directoryPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

function withDependencies(overrides?: Partial<ResourceLeaseDependencies>): ResourceLeaseDependencies {
  if (!overrides) {
    return defaultDependencies;
  }
  return {
    nowMs: overrides.nowMs ?? defaultDependencies.nowMs,
    createLeaseId: overrides.createLeaseId ?? defaultDependencies.createLeaseId,
    createGuardId: overrides.createGuardId ?? defaultDependencies.createGuardId,
    getPid: overrides.getPid ?? defaultDependencies.getPid,
    getHostname: overrides.getHostname ?? defaultDependencies.getHostname,
    probePidLiveness: overrides.probePidLiveness ?? defaultDependencies.probePidLiveness,
    fs: overrides.fs ?? defaultDependencies.fs,
    syncDirectory: overrides.syncDirectory ?? defaultDependencies.syncDirectory,
  };
}

type ErrnoLikeError = {
  message: string;
  code?: string;
};

function isNodeErrno(error: unknown): error is ErrnoLikeError {
  return Boolean(error && typeof error === 'object' && 'message' in error);
}

function asResourceLeaseError(error: unknown, fallbackMessage: string): ResourceLeaseError {
  if (isNodeErrno(error) && typeof error.message === 'string') {
    return {
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return { message: error.message || fallbackMessage };
  }
  return { message: fallbackMessage };
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if ('name' in error && error.name === 'AbortError') {
    return true;
  }
  return Boolean(
    'code' in error && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code === 'ABORT_ERR',
  );
}

function isMissingFileError(error: unknown): boolean {
  return isNodeErrno(error) && error.code === 'ENOENT';
}

function abortError(signal?: AbortSignal): ResourceLeaseError | null {
  if (!signal?.aborted) {
    return null;
  }
  return { code: 'ABORT_ERR', message: 'Operation aborted.' };
}

function nonEmptyString(value: unknown, field: string): ResourceLeaseError | null {
  if (typeof value === 'string' && value.length > 0) {
    return null;
  }
  return { message: `${field} must be a non-empty string.` };
}

function positiveInteger(value: unknown, field: string): ResourceLeaseError | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return null;
  }
  return { message: `${field} must be a positive integer.` };
}

function finiteNumber(value: unknown, field: string): ResourceLeaseError | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return null;
  }
  return { message: `${field} must be a finite number.` };
}

function parseResourceLeaseRecord(payload: string): { ok: true; record: ResourceLeaseRecord } | { ok: false; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return { ok: false, detail: 'Lease file is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, detail: 'Lease file JSON must be an object.' };
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== RESOURCE_LEASE_SCHEMA_VERSION) {
    return { ok: false, detail: `schemaVersion must equal ${RESOURCE_LEASE_SCHEMA_VERSION}.` };
  }
  const stringChecks: Array<[unknown, string]> = [
    [candidate.leaseId, 'leaseId'],
    [candidate.resourceId, 'resourceId'],
    [candidate.ownerId, 'ownerId'],
    [candidate.runId, 'runId'],
    [candidate.hostname, 'hostname'],
  ];
  for (const [value, field] of stringChecks) {
    const issue = nonEmptyString(value, field);
    if (issue) {
      return { ok: false, detail: issue.message };
    }
  }
  const finiteChecks: Array<[unknown, string]> = [
    [candidate.pid, 'pid'],
    [candidate.createdAt, 'createdAt'],
    [candidate.heartbeatAt, 'heartbeatAt'],
    [candidate.expiresAt, 'expiresAt'],
    [candidate.ttlMs, 'ttlMs'],
  ];
  for (const [value, field] of finiteChecks) {
    const issue = finiteNumber(value, field);
    if (issue) {
      return { ok: false, detail: issue.message };
    }
  }
  const pidIssue = positiveInteger(candidate.pid, 'pid');
  if (pidIssue) {
    return { ok: false, detail: pidIssue.message };
  }
  const ttlIssue = positiveInteger(candidate.ttlMs, 'ttlMs');
  if (ttlIssue) {
    return { ok: false, detail: ttlIssue.message };
  }
  return {
    ok: true,
    record: {
      schemaVersion: RESOURCE_LEASE_SCHEMA_VERSION,
      leaseId: candidate.leaseId as string,
      resourceId: candidate.resourceId as string,
      ownerId: candidate.ownerId as string,
      runId: candidate.runId as string,
      pid: candidate.pid as number,
      hostname: candidate.hostname as string,
      createdAt: candidate.createdAt as number,
      heartbeatAt: candidate.heartbeatAt as number,
      expiresAt: candidate.expiresAt as number,
      ttlMs: candidate.ttlMs as number,
    },
  };
}

function parseGuardRecord(payload: string): { ok: true; record: OperationGuardRecord } | { ok: false; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return { ok: false, detail: 'Operation guard is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, detail: 'Operation guard must be an object.' };
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.schemaVersion !== OPERATION_GUARD_SCHEMA_VERSION) {
    return { ok: false, detail: `schemaVersion must equal ${OPERATION_GUARD_SCHEMA_VERSION}.` };
  }
  const operation = candidate.operation;
  if (operation !== 'acquire' && operation !== 'heartbeat' && operation !== 'release') {
    return { ok: false, detail: 'operation must be acquire, heartbeat, or release.' };
  }
  const requiredStrings: Array<[unknown, string]> = [
    [candidate.guardId, 'guardId'],
    [candidate.hostname, 'hostname'],
  ];
  for (const [value, field] of requiredStrings) {
    const issue = nonEmptyString(value, field);
    if (issue) {
      return { ok: false, detail: issue.message };
    }
  }
  const requiredNumbers: Array<[unknown, string]> = [
    [candidate.pid, 'pid'],
    [candidate.createdAt, 'createdAt'],
    [candidate.expiresAt, 'expiresAt'],
  ];
  for (const [value, field] of requiredNumbers) {
    const issue = finiteNumber(value, field);
    if (issue) {
      return { ok: false, detail: issue.message };
    }
  }
  return {
    ok: true,
    record: {
      schemaVersion: OPERATION_GUARD_SCHEMA_VERSION,
      guardId: candidate.guardId as string,
      operation,
      pid: candidate.pid as number,
      hostname: candidate.hostname as string,
      createdAt: candidate.createdAt as number,
      expiresAt: candidate.expiresAt as number,
      ...(typeof candidate.leaseId === 'string' ? { leaseId: candidate.leaseId } : {}),
    },
  };
}

function serializeLeaseRecord(record: ResourceLeaseRecord): string {
  return JSON.stringify(record);
}

function serializeGuardRecord(record: OperationGuardRecord): string {
  return JSON.stringify(record);
}

function encodeLeaseIdForPath(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function writeAllUtf8(handle: ResourceLeaseFileHandle, value: string, fallbackMessage: string): Promise<void> {
  const payload = Buffer.from(value, 'utf8');
  let totalWritten = 0;
  while (totalWritten < payload.length) {
    const remaining = payload.length - totalWritten;
    const { bytesWritten } = await handle.write(payload, totalWritten, remaining, totalWritten);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error(fallbackMessage);
    }
    totalWritten += bytesWritten;
  }
}

async function cleanupPath(
  deps: ResourceLeaseDependencies,
  filePath: string | undefined,
  fallbackMessage: string,
): Promise<CleanupWithError> {
  if (!filePath) {
    return { status: 'not-needed' };
  }
  try {
    await deps.fs.unlink(filePath);
    return { status: 'succeeded' };
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { status: 'succeeded' };
    }
    return { status: 'failed', error: asResourceLeaseError(error, fallbackMessage) };
  }
}

async function inspectResourceLeaseInternal(
  options: ResourceLeaseInspectOptions,
  dependencies?: Partial<ResourceLeaseDependencies>,
): Promise<ResourceLeaseInspection> {
  const deps = withDependencies(dependencies);
  const { leasePath } = options;
  let content: string;
  try {
    content = await deps.fs.readFile(leasePath, 'utf8');
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { status: 'available', leasePath };
    }
    return {
      status: 'invalid',
      leasePath,
      invalidReason: 'unreadable',
      detail: 'Could not read lease file.',
      error: asResourceLeaseError(error, 'Could not read lease file.'),
    };
  }
  const parsed = parseResourceLeaseRecord(content);
  if (!parsed.ok) {
    return { status: 'invalid', leasePath, invalidReason: 'malformed', detail: parsed.detail };
  }
  const record = parsed.record;
  const nowMs = deps.nowMs();
  const pidLiveness: ResourceLeasePidLiveness =
    record.hostname !== deps.getHostname()
      ? 'unknown'
      : await Promise.resolve(deps.probePidLiveness(record.hostname, record.pid)).catch(
          (): ResourceLeasePidLiveness => 'unknown',
        );
  if (record.expiresAt <= nowMs) {
    return { status: 'stale', leasePath, record, pidLiveness, staleReason: 'expired' };
  }
  if (pidLiveness === 'dead') {
    return { status: 'stale', leasePath, record, pidLiveness, staleReason: 'owner-dead' };
  }
  return { status: 'held', leasePath, record, pidLiveness };
}

type GuardAcquire =
  | { status: 'acquired'; guard: ResourceLeaseOperationGuard; guardTempPath: string; guardPath: string; guardCleanup: CleanupWithError }
  | { status: 'blocked'; guard: ResourceLeaseOperationGuard; guardCleanup: CleanupWithError }
  | { status: 'cancelled'; error: ResourceLeaseError; guardCleanup: CleanupWithError };

async function acquireOperationGuard(
  deps: ResourceLeaseDependencies,
  leasePath: string,
  operation: 'acquire' | 'heartbeat' | 'release',
  signal?: AbortSignal,
  leaseId?: string,
): Promise<GuardAcquire> {
  const cancelled = abortError(signal);
  if (cancelled) {
    return { status: 'cancelled', error: cancelled, guardCleanup: { status: 'not-needed' } };
  }
  const nowMs = deps.nowMs();
  const guardId = deps.createGuardId();
  const guardPath = `${leasePath}.operation`;
  const guardTempPath = `${guardPath}.${encodeLeaseIdForPath(guardId)}.tmp`;
  const guardRecord: OperationGuardRecord = {
    schemaVersion: OPERATION_GUARD_SCHEMA_VERSION,
    guardId,
    operation,
    pid: deps.getPid(),
    hostname: deps.getHostname(),
    createdAt: nowMs,
    expiresAt: nowMs + OPERATION_GUARD_TTL_MS,
    ...(leaseId ? { leaseId } : {}),
  };
  const payload = serializeGuardRecord(guardRecord);
  let handle: ResourceLeaseFileHandle | null = null;
  try {
    try {
      handle = await deps.fs.open(guardTempPath, 'wx', 0o600);
      await writeAllUtf8(handle, payload, 'Failed to write complete operation-guard payload.');
      await handle.sync();
    } finally {
      if (handle) {
        await handle.close();
      }
    }
  } catch (error: unknown) {
    const tempCleanup = await cleanupPath(deps, guardTempPath, 'Failed to clean temporary operation guard file.');
    return {
      status: 'blocked',
      guard: {
        status: 'orphaned',
        guardPath,
        detail: asResourceLeaseError(error, 'Failed to stage operation guard.').message,
      },
      guardCleanup: tempCleanup,
    };
  }
  const cancelledDuringStaging = abortError(signal);
  if (cancelledDuringStaging) {
    const tempCleanup = await cleanupPath(deps, guardTempPath, 'Failed to clean temporary operation guard file.');
    return {
      status: 'cancelled',
      error: cancelledDuringStaging,
      guardCleanup: tempCleanup,
    };
  }
  try {
    await deps.fs.link(guardTempPath, guardPath);
  } catch (error: unknown) {
    if (isNodeErrno(error) && error.code === 'EEXIST') {
      const existing = await deps.fs.readFile(guardPath, 'utf8').catch((readError: unknown) => {
        return `__READ_ERROR__${asResourceLeaseError(readError, 'Failed to read operation guard.').message}`;
      });
      const tempCleanup = await cleanupPath(deps, guardTempPath, 'Failed to clean temporary operation guard file.');
      if (existing.startsWith('__READ_ERROR__')) {
        return {
          status: 'blocked',
          guard: {
            status: 'orphaned',
            guardPath,
            detail: existing.replace('__READ_ERROR__', ''),
          },
          guardCleanup: tempCleanup,
        };
      }
      const parsed = parseGuardRecord(existing);
      if (!parsed.ok) {
        return {
          status: 'blocked',
          guard: {
            status: 'orphaned',
            guardPath,
            detail: parsed.detail,
          },
          guardCleanup: tempCleanup,
        };
      }
      const isExpired = parsed.record.expiresAt <= deps.nowMs();
      const pidLiveness =
        parsed.record.hostname === deps.getHostname()
          ? await Promise.resolve(deps.probePidLiveness(parsed.record.hostname, parsed.record.pid)).catch(
              (): ResourceLeasePidLiveness => 'unknown',
            )
          : 'unknown';
      const isDeadLocalOwner = parsed.record.hostname === deps.getHostname() && pidLiveness === 'dead';
      if (isExpired || isDeadLocalOwner) {
        return {
          status: 'blocked',
          guard: {
            status: 'orphaned',
            guardPath,
            detail: isExpired ? 'Operation guard is expired.' : 'Operation guard owner process is dead.',
            guardOwner: { operation: parsed.record.operation, ...(parsed.record.leaseId ? { leaseId: parsed.record.leaseId } : {}) },
          },
          guardCleanup: tempCleanup,
        };
      }
      return {
        status: 'blocked',
        guard: {
          status: 'contended',
          guardPath,
          detail: 'Another lease operation is in progress.',
          guardOwner: { operation: parsed.record.operation, ...(parsed.record.leaseId ? { leaseId: parsed.record.leaseId } : {}) },
        },
        guardCleanup: tempCleanup,
      };
    }
    const tempCleanup = await cleanupPath(deps, guardTempPath, 'Failed to clean temporary operation guard file.');
    return {
      status: 'blocked',
      guard: {
        status: 'orphaned',
        guardPath,
        detail: asResourceLeaseError(error, 'Failed to acquire operation guard.').message,
      },
      guardCleanup: tempCleanup,
    };
  }
  return {
    status: 'acquired',
    guard: { status: 'acquired', guardPath, guardId },
    guardTempPath,
    guardPath,
    guardCleanup: { status: 'not-needed' },
  };
}

async function releaseOperationGuard(
  deps: ResourceLeaseDependencies,
  guardPath: string | undefined,
  guardTempPath: string | undefined,
): Promise<CleanupWithError> {
  const unlinkMain = await cleanupPath(deps, guardPath, 'Failed to clean operation guard.');
  const unlinkTemp = await cleanupPath(deps, guardTempPath, 'Failed to clean temporary operation guard file.');
  if (unlinkMain.status === 'failed') {
    return unlinkMain;
  }
  if (unlinkTemp.status === 'failed') {
    return unlinkTemp;
  }
  if (unlinkMain.status === 'not-needed' && unlinkTemp.status === 'not-needed') {
    return { status: 'not-needed' };
  }
  return { status: 'succeeded' };
}

async function acquireResourceLeaseInternal(
  options: ResourceLeaseAcquireOptions,
  dependencies?: Partial<ResourceLeaseDependencies>,
): Promise<ResourceLeaseAcquireResult> {
  const deps = withDependencies(dependencies);
  const { leasePath, resourceId, ownerId, runId, ttlMs, signal } = options;
  let phase: AcquirePhase = 'preflight';
  let tempPath: string | undefined;
  let tempHandle: ResourceLeaseFileHandle | null = null;
  let cleanup: AcquireCleanup = { status: 'not-needed' };
  let guardCleanup: CleanupWithError = { status: 'not-needed' };
  let guardPath: string | undefined;
  let guardTempPath: string | undefined;
  let operationGuard: ResourceLeaseOperationGuard = { status: 'contended', guardPath: `${leasePath}.operation`, detail: 'Not attempted.' };
  let published = false;

  const cancelled = abortError(signal);
  if (cancelled) {
    return { status: 'cancelled', phase, leasePath, operationGuard, cleanup, guardCleanup, error: cancelled };
  }
  const nowMs = deps.nowMs();
  const pid = deps.getPid();
  const hostname = deps.getHostname();
  const leaseId = deps.createLeaseId();
  const issues = [
    positiveInteger(ttlMs, 'ttlMs'),
    positiveInteger(pid, 'PID'),
    finiteNumber(nowMs, 'nowMs'),
    nonEmptyString(resourceId, 'resourceId'),
    nonEmptyString(ownerId, 'ownerId'),
    nonEmptyString(runId, 'runId'),
    nonEmptyString(hostname, 'hostname'),
    nonEmptyString(leaseId, 'leaseId'),
  ].filter((value): value is ResourceLeaseError => Boolean(value));
  const firstIssue = issues.at(0);
  if (firstIssue) {
    return { status: 'failed', phase, leasePath, operationGuard, cleanup, guardCleanup, error: firstIssue };
  }
  const expiresAt = nowMs + ttlMs;
  const expiresIssue = finiteNumber(expiresAt, 'expiresAt');
  if (expiresIssue) {
    return { status: 'failed', phase, leasePath, operationGuard, cleanup, guardCleanup, error: expiresIssue };
  }
  const lease: ResourceLeaseRecord = {
    schemaVersion: RESOURCE_LEASE_SCHEMA_VERSION,
    leaseId,
    resourceId,
    ownerId,
    runId,
    pid,
    hostname,
    createdAt: nowMs,
    heartbeatAt: nowMs,
    expiresAt,
    ttlMs,
  };
  tempPath = `${leasePath}.${encodeLeaseIdForPath(leaseId)}.tmp`;
  const payload = serializeLeaseRecord(lease);
  let durability: { status: 'synced' } | { status: 'sync-failed'; error: ResourceLeaseError } = { status: 'synced' };
  try {
    phase = 'operation-guard';
    const guardAcquire = await acquireOperationGuard(deps, leasePath, 'acquire', signal, leaseId);
    if (guardAcquire.status === 'cancelled') {
      return {
        status: 'cancelled',
        phase,
        leasePath,
        operationGuard,
        cleanup,
        guardCleanup: guardAcquire.guardCleanup,
        error: guardAcquire.error,
      };
    }
    operationGuard = guardAcquire.guard;
    guardCleanup = guardAcquire.guardCleanup;
    if (guardAcquire.status === 'blocked') {
      return {
        status: 'contended',
        phase,
        leasePath,
        operationGuard,
        cleanup,
        guardCleanup,
        error: { message: guardDetail(operationGuard) },
      };
    }
    guardPath = guardAcquire.guardPath;
    guardTempPath = guardAcquire.guardTempPath;
    const cancelledAfterGuard = abortError(signal);
    if (cancelledAfterGuard) {
      phase = 'cleanup-guard';
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return { status: 'cancelled', phase, leasePath, tempPath, operationGuard, cleanup, guardCleanup, error: cancelledAfterGuard };
    }

    phase = 'write-temp';
    tempHandle = await deps.fs.open(tempPath, 'wx', 0o600);
    await writeAllUtf8(tempHandle, payload, 'Failed to write complete lease payload.');

    phase = 'sync-temp';
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
    const cancelledBeforePublish = abortError(signal);
    if (cancelledBeforePublish) {
      phase = 'cleanup-temp';
      const tempCleanup = await cleanupPath(deps, tempPath, 'Failed to remove temporary lease file.');
      cleanup =
        tempCleanup.status === 'failed'
          ? { status: 'failed', message: tempCleanup.error.message }
          : tempPath
            ? { status: 'succeeded' }
            : { status: 'not-needed' };
      phase = 'cleanup-guard';
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return { status: 'cancelled', phase, leasePath, tempPath, operationGuard, cleanup, guardCleanup, error: cancelledBeforePublish };
    }

    phase = 'publish-link';
    await deps.fs.link(tempPath, leasePath);
    published = true;

    phase = 'sync-directory';
    await deps.syncDirectory(path.dirname(leasePath));
  } catch (error: unknown) {
    const leaseError = asResourceLeaseError(error, 'Failed to acquire resource lease.');
    if (tempHandle) {
      await tempHandle.close().catch(() => undefined);
    }
    phase = 'cleanup-temp';
    const tempCleanup = await cleanupPath(deps, tempPath, 'Failed to remove temporary lease file.');
    cleanup =
      tempCleanup.status === 'failed'
        ? { status: 'failed', message: tempCleanup.error.message }
        : tempPath
          ? { status: 'succeeded' }
          : { status: 'not-needed' };
    phase = 'cleanup-guard';
    guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
    if (published) {
      durability = { status: 'sync-failed', error: leaseError };
      return {
        status: 'acquired',
        phase,
        leasePath,
        lease,
        tempPath: tempPath ?? `${leasePath}.unknown.tmp`,
        operationGuard,
        durability,
        cleanup,
        guardCleanup,
      };
    }
    if (isAbortError(error)) {
      return { status: 'cancelled', phase, leasePath, tempPath, operationGuard, cleanup, guardCleanup, error: leaseError };
    }
    if (leaseError.code === 'EEXIST') {
      return { status: 'contended', phase, leasePath, tempPath, operationGuard, cleanup, guardCleanup, error: leaseError };
    }
    return { status: 'failed', phase, leasePath, tempPath, operationGuard, cleanup, guardCleanup, error: leaseError };
  }
  phase = 'cleanup-temp';
  const tempCleanup = await cleanupPath(deps, tempPath, 'Failed to remove temporary lease file.');
  cleanup =
    tempCleanup.status === 'failed'
      ? { status: 'failed', message: tempCleanup.error.message }
      : tempPath
        ? { status: 'succeeded' }
        : { status: 'not-needed' };
  phase = 'cleanup-guard';
  guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
  return {
    status: 'acquired',
    phase: 'complete',
    leasePath,
    lease,
    tempPath,
    operationGuard,
    durability,
    cleanup,
    guardCleanup,
  };
}

async function heartbeatResourceLeaseInternal(
  options: ResourceLeaseHeartbeatOptions,
  dependencies?: Partial<ResourceLeaseDependencies>,
): Promise<ResourceLeaseHeartbeatResult> {
  const deps = withDependencies(dependencies);
  const { leasePath, leaseId, ttlMs, signal } = options;
  let phase: HeartbeatPhase = 'preflight';
  let tempPath: string | undefined;
  let tempHandle: ResourceLeaseFileHandle | null = null;
  let tempCleanup: CleanupWithError = { status: 'not-needed' };
  let guardCleanup: CleanupWithError = { status: 'not-needed' };
  let guardPath: string | undefined;
  let guardTempPath: string | undefined;
  let operationGuard: ResourceLeaseOperationGuard = { status: 'contended', guardPath: `${leasePath}.operation`, detail: 'Not attempted.' };
  let published = false;
  const cancelled = abortError(signal);
  if (cancelled) {
    return { status: 'cancelled', phase, leasePath, operationGuard, tempCleanup, guardCleanup, error: cancelled };
  }
  const leaseIdIssue = nonEmptyString(leaseId, 'leaseId');
  if (leaseIdIssue) {
    return { status: 'failed', phase, leasePath, operationGuard, tempCleanup, guardCleanup, error: leaseIdIssue };
  }
  const durability: { status: 'synced' } | { status: 'sync-failed'; error: ResourceLeaseError } = { status: 'synced' };
  let renewed: ResourceLeaseRecord | null = null;
  try {
    phase = 'operation-guard';
    const guardAcquire = await acquireOperationGuard(deps, leasePath, 'heartbeat', signal, leaseId);
    if (guardAcquire.status === 'cancelled') {
      return {
        status: 'cancelled',
        phase,
        leasePath,
        operationGuard,
        tempCleanup,
        guardCleanup: guardAcquire.guardCleanup,
        error: guardAcquire.error,
      };
    }
    operationGuard = guardAcquire.guard;
    guardCleanup = guardAcquire.guardCleanup;
    if (guardAcquire.status === 'blocked') {
      return {
        status: 'contended',
        phase,
        leasePath,
        operationGuard,
        tempCleanup,
        guardCleanup,
        error: { message: guardDetail(operationGuard) },
      };
    }
    guardPath = guardAcquire.guardPath;
    guardTempPath = guardAcquire.guardTempPath;
    const cleanupGuard = async (): Promise<CleanupWithError> => {
      phase = 'cleanup-guard';
      return releaseOperationGuard(deps, guardPath, guardTempPath);
    };
    const cancelledAfterGuard = abortError(signal);
    if (cancelledAfterGuard) {
      guardCleanup = await cleanupGuard();
      return { status: 'cancelled', phase, leasePath, operationGuard, tempCleanup, guardCleanup, error: cancelledAfterGuard };
    }

    phase = 'read-existing';
    const parsed = parseResourceLeaseRecord(await deps.fs.readFile(leasePath, 'utf8'));
    if (!parsed.ok) {
      guardCleanup = await cleanupGuard();
      return { status: 'invalid', phase, leasePath, operationGuard, tempCleanup, guardCleanup, error: { message: parsed.detail } };
    }
    if (parsed.record.leaseId !== leaseId) {
      guardCleanup = await cleanupGuard();
      return {
        status: 'mismatch',
        phase,
        leasePath,
        operationGuard,
        tempCleanup,
        guardCleanup,
        expectedLeaseId: leaseId,
        foundLeaseId: parsed.record.leaseId,
        error: { message: 'Lease id mismatch.' },
      };
    }
    const effectiveTtl = ttlMs ?? parsed.record.ttlMs;
    const ttlIssue = positiveInteger(effectiveTtl, 'ttlMs');
    if (ttlIssue) {
      guardCleanup = await cleanupGuard();
      return { status: 'failed', phase: 'preflight', leasePath, operationGuard, tempCleanup, guardCleanup, error: ttlIssue };
    }
    const nowMs = deps.nowMs();
    const nowIssue = finiteNumber(nowMs, 'nowMs');
    if (nowIssue) {
      guardCleanup = await cleanupGuard();
      return { status: 'failed', phase: 'preflight', leasePath, operationGuard, tempCleanup, guardCleanup, error: nowIssue };
    }
    const expiresAt = nowMs + effectiveTtl;
    const expiresIssue = finiteNumber(expiresAt, 'expiresAt');
    if (expiresIssue) {
      guardCleanup = await cleanupGuard();
      return { status: 'failed', phase: 'preflight', leasePath, operationGuard, tempCleanup, guardCleanup, error: expiresIssue };
    }
    renewed = {
      ...parsed.record,
      heartbeatAt: nowMs,
      ttlMs: effectiveTtl,
      expiresAt,
    };
    tempPath = `${leasePath}.${encodeLeaseIdForPath(leaseId)}.${encodeLeaseIdForPath(deps.createGuardId())}.heartbeat.tmp`;
    phase = 'write-temp';
    tempHandle = await deps.fs.open(tempPath, 'wx', 0o600);
    await writeAllUtf8(tempHandle, serializeLeaseRecord(renewed), 'Failed to write complete heartbeat payload.');
    phase = 'sync-temp';
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;
    const cancelledBeforePublish = abortError(signal);
    if (cancelledBeforePublish) {
      phase = 'cleanup-temp';
      tempCleanup = await cleanupPath(deps, tempPath, 'Failed to clean heartbeat temporary file.');
      guardCleanup = await cleanupGuard();
      return {
        status: 'cancelled',
        phase,
        leasePath,
        operationGuard,
        ...(tempPath ? { tempPath } : {}),
        tempCleanup,
        guardCleanup,
        error: cancelledBeforePublish,
      };
    }
    phase = 'publish-rename';
    await deps.fs.rename(tempPath, leasePath);
    published = true;
    phase = 'sync-directory';
    await deps.syncDirectory(path.dirname(leasePath));
  } catch (error: unknown) {
    if (tempHandle) {
      await tempHandle.close().catch(() => undefined);
    }
    phase = 'cleanup-temp';
    tempCleanup = await cleanupPath(deps, tempPath, 'Failed to clean heartbeat temporary file.');
    phase = 'cleanup-guard';
    guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
    const leaseError = asResourceLeaseError(error, 'Failed to heartbeat resource lease.');
    if (isMissingFileError(error)) {
      return {
        status: 'missing',
        phase,
        leasePath,
        operationGuard,
        ...(tempPath ? { tempPath } : {}),
        tempCleanup,
        guardCleanup,
        error: leaseError,
      };
    }
    if (published) {
      return {
        status: 'renewed',
        phase: 'complete',
        leasePath,
        lease: renewed as ResourceLeaseRecord,
        operationGuard,
        tempPath: tempPath ?? `${leasePath}.heartbeat.tmp`,
        durability: { status: 'sync-failed', error: leaseError },
        tempCleanup,
        guardCleanup,
      };
    }
    if (isAbortError(error)) {
      return {
        status: 'cancelled',
        phase,
        leasePath,
        operationGuard,
        ...(tempPath ? { tempPath } : {}),
        tempCleanup,
        guardCleanup,
        error: leaseError,
      };
    }
    return {
      status: 'failed',
      phase,
      leasePath,
      operationGuard,
      ...(tempPath ? { tempPath } : {}),
      tempCleanup,
      guardCleanup,
      error: leaseError,
    };
  }
  phase = 'cleanup-temp';
  tempCleanup = await cleanupPath(deps, tempPath, 'Failed to clean heartbeat temporary file.');
  phase = 'cleanup-guard';
  guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
  return {
    status: 'renewed',
    phase: 'complete',
    leasePath,
    lease: renewed as ResourceLeaseRecord,
    operationGuard,
    tempPath: tempPath as string,
    durability,
    tempCleanup,
    guardCleanup,
  };
}

async function restoreOrPreserveDetachedLease(
  deps: ResourceLeaseDependencies,
  detachedPath: string,
  leasePath: string,
): Promise<DetachedLeaseDisposition> {
  try {
    await deps.fs.link(detachedPath, leasePath);
  } catch (error: unknown) {
    if (isNodeErrno(error) && error.code === 'EEXIST') {
      const preservedPath = `${detachedPath}.preserved`;
      try {
        await deps.fs.rename(detachedPath, preservedPath);
        return { status: 'preserved', path: preservedPath, cleanup: { status: 'succeeded' } };
      } catch (preserveError: unknown) {
        return {
          status: 'preserved-at-detached',
          path: detachedPath,
          cleanup: { status: 'failed', error: asResourceLeaseError(preserveError, 'Failed to preserve detached lease.') },
        };
      }
    }
    return {
      status: 'preserved-at-detached',
      path: detachedPath,
      cleanup: { status: 'failed', error: asResourceLeaseError(error, 'Failed to restore detached lease.') },
    };
  }
  const detachedCleanup = await cleanupPath(deps, detachedPath, 'Failed to cleanup detached lease path after restoration.');
  return { status: 'restored', path: leasePath, cleanup: detachedCleanup };
}

async function releaseResourceLeaseInternal(
  options: ResourceLeaseReleaseOptions,
  dependencies?: Partial<ResourceLeaseDependencies>,
): Promise<ResourceLeaseReleaseResult> {
  const deps = withDependencies(dependencies);
  const { leasePath, leaseId, signal } = options;
  let phase: ReleasePhase = 'preflight';
  let detachedPath: string | undefined;
  let detachedCleanup: CleanupWithError = { status: 'not-needed' };
  let guardCleanup: CleanupWithError = { status: 'not-needed' };
  let guardPath: string | undefined;
  let guardTempPath: string | undefined;
  let operationGuard: ResourceLeaseOperationGuard = { status: 'contended', guardPath: `${leasePath}.operation`, detail: 'Not attempted.' };

  const cancelled = abortError(signal);
  if (cancelled) {
    return { status: 'cancelled', phase, leasePath, leaseId, operationGuard, guardCleanup, detachedCleanup, error: cancelled };
  }
  const leaseIdIssue = nonEmptyString(leaseId, 'leaseId');
  if (leaseIdIssue) {
    return { status: 'failed', phase, leasePath, leaseId, operationGuard, guardCleanup, detachedCleanup, error: leaseIdIssue };
  }
  try {
    phase = 'operation-guard';
    const guardAcquire = await acquireOperationGuard(deps, leasePath, 'release', signal, leaseId);
    if (guardAcquire.status === 'cancelled') {
      return {
        status: 'cancelled',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup: guardAcquire.guardCleanup,
        detachedCleanup,
        error: guardAcquire.error,
      };
    }
    operationGuard = guardAcquire.guard;
    guardCleanup = guardAcquire.guardCleanup;
    if (guardAcquire.status === 'blocked') {
      return {
        status: 'retained',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        reason: operationGuard.status === 'orphaned' ? 'operation-guard-orphaned' : 'operation-in-progress',
        error: { message: guardDetail(operationGuard) },
      };
    }
    guardPath = guardAcquire.guardPath;
    guardTempPath = guardAcquire.guardTempPath;
    const cancelledAfterGuard = abortError(signal);
    if (cancelledAfterGuard) {
      phase = 'cleanup-guard';
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return { status: 'cancelled', phase, leasePath, leaseId, operationGuard, guardCleanup, detachedCleanup, error: cancelledAfterGuard };
    }

    detachedPath = `${leasePath}.${encodeLeaseIdForPath(leaseId)}.${encodeLeaseIdForPath(deps.createGuardId())}.detached`;
    phase = 'detach-candidate';
    await deps.fs.rename(leasePath, detachedPath);
    const cancelledAfterDetach = abortError(signal);
    if (cancelledAfterDetach) {
      phase = 'restore-detached';
      const detachedDisposition = await restoreOrPreserveDetachedLease(deps, detachedPath, leasePath);
      detachedCleanup = detachedDisposition.cleanup;
      phase = 'cleanup-guard';
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return {
        status: 'cancelled',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        detachedCleanup,
        detachedPath,
        detachedDisposition,
        error: cancelledAfterDetach,
      };
    }

    phase = 'read-detached';
    const parsed = parseResourceLeaseRecord(await deps.fs.readFile(detachedPath, 'utf8'));
    if (!parsed.ok) {
      phase = 'restore-detached';
      const detachedDisposition = await restoreOrPreserveDetachedLease(deps, detachedPath, leasePath);
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return {
        status: 'retained',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        reason: 'invalid',
        detachedPath,
        detachedDisposition,
        error: { message: parsed.detail },
      };
    }
    if (parsed.record.leaseId !== leaseId) {
      phase = 'restore-detached';
      const detachedDisposition = await restoreOrPreserveDetachedLease(deps, detachedPath, leasePath);
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return {
        status: 'retained',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        reason: 'replaced',
        detachedPath,
        detachedDisposition,
        foundLeaseId: parsed.record.leaseId,
        error: { message: 'Detached lease does not match requested lease id.' },
      };
    }
    const cancelledBeforeUnlink = abortError(signal);
    if (cancelledBeforeUnlink) {
      phase = 'restore-detached';
      const detachedDisposition = await restoreOrPreserveDetachedLease(deps, detachedPath, leasePath);
      detachedCleanup = detachedDisposition.cleanup;
      phase = 'cleanup-guard';
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return {
        status: 'cancelled',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        detachedCleanup,
        detachedPath,
        detachedDisposition,
        error: cancelledBeforeUnlink,
      };
    }

    phase = 'unlink-detached';
    await deps.fs.unlink(detachedPath);
    detachedCleanup = { status: 'succeeded' };
    phase = 'sync-directory';
    let durability: { status: 'synced' } | { status: 'sync-failed'; error: ResourceLeaseError } = { status: 'synced' };
    try {
      await deps.syncDirectory(path.dirname(leasePath));
    } catch (error: unknown) {
      durability = { status: 'sync-failed', error: asResourceLeaseError(error, 'Failed to sync lease directory.') };
    }
    phase = 'cleanup-guard';
    guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
    return {
      status: 'released',
      phase: 'complete',
      leasePath,
      leaseId,
      detachedPath,
      operationGuard,
      guardCleanup,
      detachedCleanup,
      durability,
    };
  } catch (error: unknown) {
    const leaseError = asResourceLeaseError(error, 'Failed to release lease.');
    if (isMissingFileError(error)) {
      phase = 'cleanup-guard';
      guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
      return {
        status: 'retained',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        reason: 'missing',
        ...(detachedPath ? { detachedPath } : {}),
        error: leaseError,
      };
    }
    let detachedDisposition: DetachedLeaseDisposition | undefined;
    if (detachedPath) {
      phase = 'restore-detached';
      detachedDisposition = await restoreOrPreserveDetachedLease(deps, detachedPath, leasePath);
      detachedCleanup = detachedDisposition.cleanup;
    }
    phase = 'cleanup-guard';
    guardCleanup = await releaseOperationGuard(deps, guardPath, guardTempPath);
    if (isAbortError(error)) {
      return {
        status: 'cancelled',
        phase,
        leasePath,
        leaseId,
        operationGuard,
        guardCleanup,
        detachedCleanup,
        ...(detachedPath ? { detachedPath } : {}),
        ...(detachedDisposition ? { detachedDisposition } : {}),
        error: leaseError,
      };
    }
    return {
      status: 'failed',
      phase,
      leasePath,
      leaseId,
      operationGuard,
      guardCleanup,
      detachedCleanup,
      ...(detachedPath ? { detachedPath } : {}),
      ...(detachedDisposition ? { detachedDisposition } : {}),
      error: leaseError,
    };
  }
}

function normalizeRunError(error: unknown): ResourceLeaseError {
  return asResourceLeaseError(error, 'Lease-scoped callback failed.');
}

function isReleaseClean(result: ResourceLeaseReleaseResult): result is CleanResourceLeaseReleaseResult {
  return (
    result.status === 'released' &&
    result.durability.status === 'synced' &&
    result.guardCleanup.status === 'succeeded' &&
    result.detachedCleanup.status === 'succeeded'
  );
}

async function runWithResourceLeaseInternal<T>(
  options: RunWithResourceLeaseOptions<T>,
  dependencies?: Partial<ResourceLeaseDependencies>,
): Promise<RunWithResourceLeaseResult<T>> {
  const cancelled = abortError(options.signal);
  if (cancelled) {
    return { status: 'cancelled', phase: 'preflight', error: cancelled };
  }
  const acquisition = await acquireResourceLeaseInternal(options, dependencies);
  if (acquisition.status !== 'acquired') {
    return { status: 'not-acquired', acquisition };
  }
  if (acquisition.durability.status === 'sync-failed') {
    const release = await releaseResourceLeaseInternal({ leasePath: options.leasePath, leaseId: acquisition.lease.leaseId }, dependencies);
    return { status: 'acquisition-untrusted', acquisition, release, error: acquisition.durability.error };
  }
  const callback = await (async (): Promise<
    | { status: 'completed'; value: T }
    | { status: 'cancelled'; error: ResourceLeaseError }
    | { status: 'failed'; error: ResourceLeaseError }
  > => {
    const cancelledAfterAcquire = abortError(options.signal);
    if (cancelledAfterAcquire) {
      return { status: 'cancelled', error: cancelledAfterAcquire };
    }
    try {
      return { status: 'completed', value: await Promise.resolve(options.run(acquisition.lease)) };
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return { status: 'cancelled', error: normalizeRunError(error) };
      }
      return { status: 'failed', error: normalizeRunError(error) };
    }
  })();
  const release = await releaseResourceLeaseInternal({ leasePath: options.leasePath, leaseId: acquisition.lease.leaseId }, dependencies);
  if (!isReleaseClean(release)) {
    return { status: 'cleanup-failed', acquisition, release, callback };
  }
  if (callback.status === 'completed') {
    return { status: 'completed', acquisition, release, value: callback.value };
  }
  if (callback.status === 'cancelled') {
    return { status: 'cancelled', phase: 'callback', acquisition, release, error: callback.error };
  }
  return { status: 'callback-failed', acquisition, release, error: callback.error };
}

export {
  RESOURCE_LEASE_SCHEMA_VERSION,
  OPERATION_GUARD_SCHEMA_VERSION,
  inspectResourceLeaseInternal,
  acquireResourceLeaseInternal,
  heartbeatResourceLeaseInternal,
  releaseResourceLeaseInternal,
  runWithResourceLeaseInternal,
};

export type {
  ResourceLeaseAcquireOptions,
  ResourceLeaseAcquireResult,
  ResourceLeaseDependencies,
  ResourceLeaseError,
  ResourceLeaseFs,
  ResourceLeaseHeartbeatOptions,
  ResourceLeaseHeartbeatResult,
  ResourceLeaseInspectOptions,
  ResourceLeaseInspection,
  ResourceLeaseOperationGuard,
  ResourceLeasePidLiveness,
  ResourceLeaseRecord,
  ResourceLeaseReleaseOptions,
  ResourceLeaseReleaseResult,
  RunWithResourceLeaseOptions,
  RunWithResourceLeaseResult,
};
