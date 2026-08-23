const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { constants } = require('node:fs');
const path = require('node:path');

const {
  assertCiEvidencePackRunRelativePath,
  buildCiEvidencePack,
  CiEvidencePackError,
} = require('./ci-evidence-pack');
const { assertValidJson, SCHEMAS } = require('./schema-validator');

import type {
  CiEvidencePack,
  CiEvidencePackBuildInput,
  CiEvidencePackLiveProofSetStatus,
  CiEvidencePackPlatform,
} from './ci-evidence-pack';

export interface CiEvidencePackAssemblyOptions {
  artifactRoot: string;
}

export interface VerifiedCiEvidencePackLiveProofPointer {
  filePath: string;
  platform: CiEvidencePackPlatform;
  runId: string;
  status: CiEvidencePackLiveProofSetStatus;
  summaryPath: string;
}

export interface VerifiedCiEvidencePackLiveProofSet {
  schemaVersion: '1.0.0';
  runId: string;
  status: CiEvidencePackLiveProofSetStatus;
  proofCount: number;
  requiredPlatforms: CiEvidencePackPlatform[];
  presentPlatforms: CiEvidencePackPlatform[];
  missingPlatforms: CiEvidencePackPlatform[];
  proofs: VerifiedCiEvidencePackLiveProofPointer[];
}

interface FileIdentityStat {
  ino: number;
  dev: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StableContainedFileIo {
  openSync: (
    filePath: string,
    flags: number,
  ) => number;
  readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  fstatSync: (fd: number) => FileIdentityStat & { mode: number };
  closeSync: (fd: number) => void;
  realpathSync: (filePath: string) => string;
  lstatSync: (filePath: string) => FileIdentityStat & { isFile(): boolean; isSymbolicLink(): boolean };
  statSync: (filePath: string) => FileIdentityStat & { isFile(): boolean };
}

type PathSemantics = {
  sep: string;
  isAbsolute(value: string): boolean;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
};

interface ChildCanonicalizeIo {
  realpathSync: (filePath: string) => string;
  lstatSync: (filePath: string) => FileIdentityStat & { isFile(): boolean; isSymbolicLink(): boolean };
}

type LiveProofSetProofRecord = {
  filePath: unknown;
  platform: unknown;
  runId: unknown;
  status: unknown;
  summaryPath: unknown;
};

type LiveProofSetRecord = {
  schemaVersion: unknown;
  runId: unknown;
  status: unknown;
  proofCount: unknown;
  requiredPlatforms: unknown;
  presentPlatforms: unknown;
  missingPlatforms: unknown;
  proofs: unknown;
};

const LIVE_PROOF_PLATFORMS = new Set<string>(['android', 'ios']);
const LIVE_PROOF_STATUSES = new Set<string>(['passed', 'failed']);

function fail(message: string, cause?: unknown): never {
  if (cause instanceof Error) {
    throw new CiEvidencePackError(`${message} ${cause.message}`);
  }
  throw new CiEvidencePackError(message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireLiveProofPlatform(value: unknown, label: string): CiEvidencePackPlatform {
  const platform = requireString(value, label);
  if (!LIVE_PROOF_PLATFORMS.has(platform)) {
    fail(`${label} must be android or ios.`);
  }
  return platform as CiEvidencePackPlatform;
}

function requireLiveProofStatus(value: unknown, label: string): CiEvidencePackLiveProofSetStatus {
  const status = requireString(value, label);
  if (!LIVE_PROOF_STATUSES.has(status)) {
    fail(`${label} must be a live-proof-set status.`);
  }
  return status as CiEvidencePackLiveProofSetStatus;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function sortedCopy(values: string[]): string[] {
  return [...values].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  const a = sortedCopy(left);
  const b = sortedCopy(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isOutsideArtifactRoot(
  root: string,
  candidate: string,
  pathApi: PathSemantics = path,
  realpathSync: (filePath: string) => string = fs.realpathSync,
): void {
  const resolvedCandidate = pathApi.resolve(candidate);
  let comparableCandidate = resolvedCandidate;
  try {
    comparableCandidate = realpathSync(resolvedCandidate);
  } catch {
    comparableCandidate = resolvedCandidate;
  }
  const relative = pathApi.relative(root, comparableCandidate);
  if (relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
    fail('path escapes artifactRoot.');
  }
}

function hasWindowsDriveOrUnc(value: string): boolean {
  return /^[A-Za-z]:/.test(value) || value.startsWith('//') || value.startsWith('\\\\');
}

function posixSegments(value: string, absolute: boolean): string[] {
  const body = absolute ? value.slice(1) : value;
  return body.split('/');
}

function usesWindowsPathSemantics(pathApi: PathSemantics): boolean {
  return pathApi.sep === '\\';
}

function assertSafePosixChildPointerPath(value: string, label: string): void {
  if (value.includes('\\')) {
    fail(`${label} must not contain a backslash.`);
  }
  if (hasWindowsDriveOrUnc(value)) {
    fail(`${label} must not be a Windows drive or UNC path.`);
  }
  const absolute = value.startsWith('/');
  const segments = posixSegments(value, absolute);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${label} must be a safe POSIX path without empty or dot segments.`);
  }
}

function assertSafeWindowsChildPointerPath(value: string, label: string): void {
  if (value.includes('/') && value.includes('\\')) {
    fail(`${label} must not mix path separators.`);
  }
  const sep = value.includes('\\') ? '\\' : '/';
  let body = value;
  if (/^[A-Za-z]:/.test(value)) {
    body = value.slice(2);
    if (body.startsWith(sep)) {
      body = body.slice(sep.length);
    } else if (body.length > 0) {
      fail(`${label} must be a safe Windows path without empty or dot segments.`);
    }
  } else if (value.startsWith('\\\\') || value.startsWith('//')) {
    body = value.slice(2);
  } else if (value.startsWith('/') || value.startsWith('\\')) {
    fail(`${label} must not use foreign absolute syntax.`);
  }
  const segments = body.length === 0 ? [] : body.split(sep);
  const unc = value.startsWith('\\\\') || value.startsWith('//');
  const minSegments = unc ? 3 : 1;
  if (
    segments.length < minSegments ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    fail(`${label} must be a safe Windows path without empty or dot segments.`);
  }
}

function assertSafeChildPointerPath(value: string, label: string, pathApi: PathSemantics = path): void {
  if (usesWindowsPathSemantics(pathApi)) {
    assertSafeWindowsChildPointerPath(value, label);
    return;
  }
  assertSafePosixChildPointerPath(value, label);
}

function defaultStableIo(): StableContainedFileIo {
  return {
    openSync: fs.openSync,
    readSync: fs.readSync,
    fstatSync: fs.fstatSync,
    closeSync: fs.closeSync,
    realpathSync: fs.realpathSync,
    lstatSync: fs.lstatSync,
    statSync: fs.statSync,
  };
}

function defaultChildCanonicalizeIo(): ChildCanonicalizeIo {
  return {
    realpathSync: fs.realpathSync,
    lstatSync: fs.lstatSync,
  };
}

function openFlags(): number {
  const nofollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  return constants.O_RDONLY | nofollow;
}

function mutationIdentityKey(stat: FileIdentityStat): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.nlink}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function filesystemIdentityKey(stat: { dev: number; ino: number }): string {
  return `${stat.dev}:${stat.ino}`;
}

function assertRegularFile(stat: { isFile(): boolean; isSymbolicLink?: () => boolean }, label: string): void {
  if (typeof stat.isSymbolicLink === 'function' && stat.isSymbolicLink()) {
    fail(`${label} must not be a symlink.`);
  }
  if (!stat.isFile()) {
    fail(`${label} must be a regular file.`);
  }
}

function readStableContainedFile(
  resolvedPath: string,
  artifactRootReal: string,
  label: string,
  io: StableContainedFileIo = defaultStableIo(),
): Uint8Array {
  isOutsideArtifactRoot(artifactRootReal, resolvedPath, path, io.realpathSync);
  let beforeLstat;
  try {
    beforeLstat = io.lstatSync(resolvedPath);
  } catch (cause) {
    fail(`${label} is missing or unreadable.`, cause);
  }
  assertRegularFile(beforeLstat, label);
  let fd: number | undefined;
  try {
    fd = io.openSync(resolvedPath, openFlags());
    const beforeFd = io.fstatSync(fd);
    if (mutationIdentityKey(beforeFd) !== mutationIdentityKey(beforeLstat)) {
      fail(`${label} changed during verification.`);
    }
    const bytes = Buffer.alloc(beforeFd.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n === 0) {
        fail(`${label} changed during verification.`);
      }
      offset += n;
    }
    const afterFd = io.fstatSync(fd);
    if (mutationIdentityKey(afterFd) !== mutationIdentityKey(beforeFd)) {
      fail(`${label} changed during verification.`);
    }
    let afterLstat;
    try {
      afterLstat = io.lstatSync(resolvedPath);
    } catch (cause) {
      fail(`${label} changed during verification.`, cause);
    }
    assertRegularFile(afterLstat, label);
    if (mutationIdentityKey(afterLstat) !== mutationIdentityKey(beforeLstat)) {
      fail(`${label} changed during verification.`);
    }
    let fileReal: string;
    try {
      fileReal = io.realpathSync(resolvedPath);
    } catch (cause) {
      fail(`${label} is missing or unreadable.`, cause);
    }
    isOutsideArtifactRoot(artifactRootReal, fileReal, path, io.realpathSync);
    if (path.resolve(fileReal) !== path.resolve(resolvedPath) && path.resolve(fileReal) !== resolvedPath) {
      const realStat = io.statSync(fileReal);
      if (mutationIdentityKey(realStat) !== mutationIdentityKey(beforeFd)) {
        fail(`${label} changed during verification.`);
      }
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof CiEvidencePackError) {
      throw cause;
    }
    fail(`${label} is missing or unreadable.`, cause);
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // already failing closed
      }
    }
  }
  fail(`${label} is missing or unreadable.`);
}

function canonicalizeChildPath(
  value: string,
  artifactRootReal: string,
  label: string,
  pathApi: PathSemantics = path,
  io: ChildCanonicalizeIo = defaultChildCanonicalizeIo(),
): { realPath: string; identity: string } {
  assertSafeChildPointerPath(value, label, pathApi);
  const resolved = pathApi.isAbsolute(value)
    ? pathApi.resolve(value)
    : pathApi.resolve(artifactRootReal, value);
  isOutsideArtifactRoot(artifactRootReal, resolved, pathApi, io.realpathSync);
  let lstat;
  try {
    lstat = io.lstatSync(resolved);
  } catch (cause) {
    fail(`${label} is missing or unreadable.`, cause);
  }
  if (lstat.isSymbolicLink()) {
    fail(`${label} must not be a symlink.`);
  }
  if (!lstat.isFile()) {
    fail(`${label} must be a regular file.`);
  }
  let fileReal: string;
  try {
    fileReal = io.realpathSync(resolved);
  } catch (cause) {
    fail(`${label} is missing or unreadable.`, cause);
  }
  isOutsideArtifactRoot(artifactRootReal, fileReal, pathApi, io.realpathSync);
  let after;
  try {
    after = io.lstatSync(resolved);
  } catch (cause) {
    fail(`${label} changed during verification.`, cause);
  }
  if (mutationIdentityKey(after) !== mutationIdentityKey(lstat) || after.isSymbolicLink()) {
    fail(`${label} changed during verification.`);
  }
  return {
    realPath: fileReal,
    identity: filesystemIdentityKey(lstat),
  };
}

function resolveAndReadLiveProofSet(
  relativePath: string,
  artifactRoot: string,
  io?: StableContainedFileIo,
): Uint8Array {
  assertCiEvidencePackRunRelativePath(relativePath);
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(artifactRoot);
  } catch (cause) {
    fail('artifactRoot is not readable.', cause);
  }
  const resolved = path.resolve(rootReal, relativePath);
  try {
    isOutsideArtifactRoot(rootReal, resolved);
  } catch {
    fail(`live-proof-set path escapes artifactRoot: ${relativePath}`);
  }
  return readStableContainedFile(resolved, rootReal, 'live-proof-set referenced file', io ?? defaultStableIo());
}

function parseLiveProofSetJson(bytes: Uint8Array): LiveProofSetRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (cause) {
    fail('live-proof-set is not valid UTF-8 JSON.', cause);
  }
  try {
    assertValidJson(parsed, SCHEMAS.liveProofSet, 'live-proof-set');
  } catch (cause) {
    fail('live-proof-set failed schema validation.', cause);
  }
  if (!parsed || typeof parsed !== 'object') {
    fail('live-proof-set is not a JSON object.');
  }
  return parsed as LiveProofSetRecord;
}

function verifyProofInventory(
  record: LiveProofSetRecord,
  artifactRoot: string,
): VerifiedCiEvidencePackLiveProofPointer[] {
  if (!Array.isArray(record.proofs)) {
    fail('live-proof-set proofs must be an array.');
  }
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(artifactRoot);
  } catch (cause) {
    fail('artifactRoot is not readable.', cause);
  }
  const proofs: VerifiedCiEvidencePackLiveProofPointer[] = [];
  const seenPlatforms = new Set<string>();
  const seenFileIdentities = new Set<string>();
  const seenSummaryIdentities = new Set<string>();
  const seenAnyIdentities = new Set<string>();
  for (const entry of record.proofs) {
    if (!entry || typeof entry !== 'object') {
      fail('live-proof-set proof pointer must be an object.');
    }
    const proof = entry as LiveProofSetProofRecord;
    const filePath = requireString(proof.filePath, 'proof filePath');
    const summaryPath = requireString(proof.summaryPath, 'proof summaryPath');
    const platform = requireLiveProofPlatform(proof.platform, 'proof platform');
    const runId = requireString(proof.runId, 'proof runId');
    const status = requireLiveProofStatus(proof.status, 'proof status');
    const fileChild = canonicalizeChildPath(filePath, rootReal, 'proof filePath');
    const summaryChild = canonicalizeChildPath(summaryPath, rootReal, 'proof summaryPath');
    if (seenFileIdentities.has(fileChild.identity)) {
      fail(`duplicate canonical proof filePath: ${filePath}`);
    }
    if (seenSummaryIdentities.has(summaryChild.identity)) {
      fail(`duplicate canonical proof summaryPath: ${summaryPath}`);
    }
    if (
      seenAnyIdentities.has(fileChild.identity) ||
      seenAnyIdentities.has(summaryChild.identity) ||
      fileChild.identity === summaryChild.identity
    ) {
      fail('proof filePath and summaryPath must not alias the same location.');
    }
    seenFileIdentities.add(fileChild.identity);
    seenSummaryIdentities.add(summaryChild.identity);
    seenAnyIdentities.add(fileChild.identity);
    seenAnyIdentities.add(summaryChild.identity);
    if (seenPlatforms.has(platform)) {
      fail(`duplicate live-proof-set proof platform: ${platform}`);
    }
    seenPlatforms.add(platform);
    proofs.push({ filePath, platform, runId, status, summaryPath });
  }
  return proofs;
}

function verifyPlatformSets(
  requiredPlatforms: string[],
  presentPlatforms: string[],
  missingPlatforms: string[],
  proofs: VerifiedCiEvidencePackLiveProofPointer[],
): void {
  if (!sameStringSet(requiredPlatforms, ['android', 'ios'])) {
    fail('requiredPlatforms must be exactly android and ios.');
  }
  const proofPlatforms = proofs.map((proof) => proof.platform);
  if (!sameStringSet(presentPlatforms, proofPlatforms)) {
    fail('presentPlatforms must equal the live-proof-set proof platform set.');
  }
  const required = new Set(requiredPlatforms);
  const present = new Set(presentPlatforms);
  const missing = new Set(missingPlatforms);
  for (const platform of present) {
    if (missing.has(platform)) {
      fail('presentPlatforms and missingPlatforms must be disjoint.');
    }
  }
  const expectedMissing = [...required].filter((platform) => !present.has(platform));
  if (!sameStringSet(missingPlatforms, expectedMissing)) {
    fail('missingPlatforms must equal requiredPlatforms minus presentPlatforms.');
  }
}

function verifyAuthorityBindings(
  input: CiEvidencePackBuildInput,
  proofs: VerifiedCiEvidencePackLiveProofPointer[],
): void {
  const proofsByPlatform = new Map(proofs.map((proof) => [proof.platform, proof]));
  for (const platformRecord of input.platforms) {
    const proof = proofsByPlatform.get(platformRecord.platform);
    if (platformRecord.authorityStatus === 'supported') {
      if (!proof) {
        fail(`supported platform ${platformRecord.platform} is missing a live-proof-set proof pointer.`);
      }
      const selectedAttemptId = platformRecord.selectedAttemptId;
      if (typeof selectedAttemptId !== 'string' || selectedAttemptId.length === 0) {
        fail(`supported platform ${platformRecord.platform} is missing selectedAttemptId.`);
      }
      const selectedAttempt = input.attempts.find((attempt) => attempt.attemptId === selectedAttemptId);
      if (!selectedAttempt) {
        fail(`supported platform ${platformRecord.platform} selectedAttemptId is unknown.`);
      }
      const tupleMatches = input.attempts.filter(
        (attempt) => attempt.platform === proof.platform && attempt.runId === proof.runId,
      );
      if (tupleMatches.length === 0) {
        fail(`no retained attempt matches proof platform+runId for ${platformRecord.platform}.`);
      }
      if (tupleMatches.length !== 1) {
        fail(`multiple retained attempts match proof platform+runId for ${platformRecord.platform}.`);
      }
      const exact = tupleMatches[0]!;
      if (exact.attemptId !== selectedAttemptId) {
        fail(`selected attempt is not the unique platform+runId match for ${platformRecord.platform}.`);
      }
      if (selectedAttempt.platform !== proof.platform) {
        fail(`selected attempt platform does not match proof pointer for ${platformRecord.platform}.`);
      }
      if (selectedAttempt.runId !== proof.runId) {
        fail(`selected attempt runId does not match proof pointer for ${platformRecord.platform}.`);
      }
      continue;
    }
    if (platformRecord.authorityStatus === 'unsupported') {
      if (proof) {
        fail(`unsupported platform ${platformRecord.platform} must not have a live-proof-set proof pointer.`);
      }
    }
  }
}

export function verifyCiEvidencePackLiveProofSet(
  input: CiEvidencePackBuildInput,
  options: CiEvidencePackAssemblyOptions,
): VerifiedCiEvidencePackLiveProofSet {
  const bytes = resolveAndReadLiveProofSet(input.liveProofSet.relativePath, options.artifactRoot);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== input.liveProofSet.byteSize) {
    fail('live-proof-set byteSize does not match the referenced file.');
  }
  if (sha256 !== input.liveProofSet.sha256) {
    fail('live-proof-set sha256 does not match the referenced file.');
  }
  const record = parseLiveProofSetJson(bytes);
  const schemaVersionRaw = requireString(record.schemaVersion, 'schemaVersion');
  if (schemaVersionRaw !== '1.0.0') {
    fail("schemaVersion must be '1.0.0'.");
  }
  const schemaVersion = '1.0.0' as const;
  const runId = requireString(record.runId, 'runId');
  const status = requireLiveProofStatus(record.status, 'status');
  if (runId !== input.liveProofSet.runId) {
    fail('live-proof-set runId does not match the referenced file.');
  }
  if (status !== input.liveProofSet.status) {
    fail('live-proof-set status does not match the referenced file.');
  }
  if (typeof record.proofCount !== 'number' || !Number.isInteger(record.proofCount)) {
    fail('proofCount must be an integer.');
  }
  const proofs = verifyProofInventory(record, options.artifactRoot);
  if (record.proofCount !== proofs.length) {
    fail('proofCount must equal proofs.length.');
  }
  const requiredPlatforms = requireStringArray(record.requiredPlatforms, 'requiredPlatforms').map((value) =>
    requireLiveProofPlatform(value, 'requiredPlatforms entry'),
  );
  const presentPlatforms = requireStringArray(record.presentPlatforms, 'presentPlatforms').map((value) =>
    requireLiveProofPlatform(value, 'presentPlatforms entry'),
  );
  const missingPlatforms = requireStringArray(record.missingPlatforms, 'missingPlatforms').map((value) =>
    requireLiveProofPlatform(value, 'missingPlatforms entry'),
  );
  verifyPlatformSets(requiredPlatforms, presentPlatforms, missingPlatforms, proofs);
  verifyAuthorityBindings(input, proofs);
  return {
    schemaVersion,
    runId,
    status,
    proofCount: record.proofCount,
    requiredPlatforms: [...requiredPlatforms],
    presentPlatforms: [...presentPlatforms],
    missingPlatforms: [...missingPlatforms],
    proofs: proofs.map((proof) => ({ ...proof })),
  };
}

export function assembleCiEvidencePack(
  input: CiEvidencePackBuildInput,
  options: CiEvidencePackAssemblyOptions,
): CiEvidencePack {
  verifyCiEvidencePackLiveProofSet(input, options);
  return buildCiEvidencePack(input);
}

export const __testOnlyStableContainedFileReader = {
  read(
    resolvedPath: string,
    artifactRootReal: string,
    label: string,
    io: StableContainedFileIo,
  ): Uint8Array {
    return readStableContainedFile(resolvedPath, artifactRootReal, label, io);
  },
};

export const __testOnlyChildCanonicalization = {
  canonicalize(
    value: string,
    artifactRootReal: string,
    label: string,
    pathApi: PathSemantics,
    io: ChildCanonicalizeIo,
  ): { realPath: string; identity: string } {
    return canonicalizeChildPath(value, artifactRootReal, label, pathApi, io);
  },
  assertSafeChildPointerPath(value: string, label: string, pathApi: PathSemantics): void {
    assertSafeChildPointerPath(value, label, pathApi);
  },
};

module.exports = {
  assembleCiEvidencePack,
  verifyCiEvidencePackLiveProofSet,
  __testOnlyStableContainedFileReader,
  __testOnlyChildCanonicalization,
};
