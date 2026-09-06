const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeJsonArtifact } = require('./artifact-writer');
const { SCHEMAS, assertValidJson } = require('./schema-validator');
const {
  StableContainedFileError,
  assertRunRelativeFilePath,
  readStableContainedFile,
  resolveStableDirectory,
} = require('./stable-contained-file') as typeof import('./stable-contained-file');

type EvidencePackageKind = 'recording' | 'screenshot' | 'uiTree' | 'actionTranscript' | 'log' | 'metrics' | 'health' | 'verdict' | 'summary' | 'liveProof' | 'liveProofSet' | 'ciEvidencePack' | 'other';

type EvidencePackageRequestEntry = {
  artifactPath: `files/${string}`;
  kind: EvidencePackageKind;
  sourcePath: string;
};

export type EvidencePackageRequest = {
  entries: EvidencePackageRequestEntry[];
  outputDir: string;
  packageId: string;
  runId: string;
  schemaVersion: '1.0.0';
  sensitivityPolicy: 'allowlist-and-secret-marker-v1';
  sourceRoot: string;
};

type EvidencePackageEntry = EvidencePackageRequestEntry & {
  byteSize: number;
  sha256: string;
};

export type EvidencePackageArtifact = {
  checksumsPath: 'SHA256SUMS';
  entries: EvidencePackageEntry[];
  fileCount: number;
  packageId: string;
  runId: string;
  schemaVersion: '1.0.0';
  sensitivityPolicy: 'allowlist-and-secret-marker-v1';
  status: 'complete';
  totalByteSize: number;
};

export type EvidencePackageRejection = {
  artifactPath?: string;
  code: 'changed-during-read' | 'duplicate-artifact' | 'duplicate-source' | 'empty' | 'invalid-path' | 'missing' | 'not-regular' | 'output-conflict' | 'secret-marker' | 'sensitive-path' | 'symlink';
  reason: string;
  sourcePath?: string;
};

export type EvidencePackageResult = {
  artifact: EvidencePackageArtifact;
  checksumsPath: string;
  manifestPath: string;
  outputDir: string;
};

export class EvidencePackageError extends Error {
  code: 'invalid-request' | 'output-conflict' | 'rejected';
  rejections: EvidencePackageRejection[];

  constructor(
    code: EvidencePackageError['code'],
    message: string,
    rejections: EvidencePackageRejection[] = [],
  ) {
    super(message);
    this.name = 'EvidencePackageError';
    this.code = code;
    this.rejections = rejections;
  }
}

type PreparedEvidencePackageEntry = EvidencePackageEntry & {
  bytes: Uint8Array;
};

const SENSITIVE_FILE_NAMES = new Set([
  '.env',
  '.dockercfg',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'authorized_keys',
  'credentials.json',
  'google-services.json',
  'googleservice-info.plist',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'service-account.json',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.cer',
  '.crt',
  '.der',
  '.key',
  '.jks',
  '.kdbx',
  '.keystore',
  '.mobileprovision',
  '.p12',
  '.p8',
  '.pem',
  '.pfx',
]);

const SECRET_MARKERS = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN PGP PRIVATE KEY BLOCK-----',
];

type DirectoryIdentity = {
  dev: number;
  ino: number;
};

function lstatOrNull(filePath: string): ReturnType<typeof fs.lstatSync> | null {
  try {
    return fs.lstatSync(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw cause;
  }
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function readDirectoryIdentity(directory: string): DirectoryIdentity {
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new EvidencePackageError('invalid-request', 'Evidence package sourceRoot must remain one stable directory.');
  }
  return { dev: status.dev, ino: status.ino };
}

function assertDirectoryIdentity(directory: string, expected: DirectoryIdentity): void {
  const current = readDirectoryIdentity(directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new EvidencePackageError(
      'rejected',
      'Evidence package sourceRoot changed during materialization; no package was written.',
      [{ code: 'changed-during-read', reason: 'The evidence source root changed during materialization.' }],
    );
  }
}

function portableArtifactPathKey(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function hasSensitiveExtension(segment: string): boolean {
  return [...SENSITIVE_EXTENSIONS].some((extension) => (
    segment === extension || segment.endsWith(extension) || segment.includes(`${extension}.`)
  ));
}

function hasSensitiveFileAlias(segment: string): boolean {
  return [...SENSITIVE_FILE_NAMES].some((fileName) => (
    segment === fileName || segment.startsWith(`${fileName}.`)
  ));
}

function sensitivePathReason(value: string): string | null {
  const segments = portableArtifactPathKey(value).split('/');
  for (const segment of segments) {
    if (
      hasSensitiveFileAlias(segment) ||
      segment.startsWith('.env.') ||
      segment.endsWith('.env') ||
      hasSensitiveExtension(segment)
    ) {
      return 'The requested path is blocked by the evidence-package sensitivity policy.';
    }
  }
  return null;
}

function containsSecretMarker(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  return SECRET_MARKERS.some((marker) => {
    const utf16Le = Buffer.from(marker, 'utf16le');
    const utf16Be = Buffer.from(utf16Le);
    for (let index = 0; index + 1 < utf16Be.length; index += 2) {
      const first = utf16Be[index];
      utf16Be[index] = utf16Be[index + 1] ?? 0;
      utf16Be[index + 1] = first ?? 0;
    }
    return buffer.includes(marker) || buffer.includes(utf16Le) || buffer.includes(utf16Be);
  });
}

function stableFileRejection(
  entry: EvidencePackageRequestEntry,
  cause: import('./stable-contained-file').StableContainedFileError,
): EvidencePackageRejection {
  const code = cause.code === 'outside-root' ? 'invalid-path' : cause.code;
  return {
    artifactPath: entry.artifactPath,
    code,
    reason: code === 'missing'
      ? 'The requested source file was not produced.'
      : `The requested source file was rejected (${code}).`,
    sourcePath: entry.sourcePath,
  };
}

function validateEntryPaths(
  entry: EvidencePackageRequestEntry,
  index: number,
): EvidencePackageRejection[] {
  const rejections: EvidencePackageRejection[] = [];
  try {
    assertRunRelativeFilePath(entry.sourcePath, `entries[${index}].sourcePath`);
    assertRunRelativeFilePath(entry.artifactPath, `entries[${index}].artifactPath`);
  } catch {
    rejections.push({
      artifactPath: entry.artifactPath,
      code: 'invalid-path',
      reason: 'Evidence package entries must use safe run-relative POSIX paths.',
      sourcePath: entry.sourcePath,
    });
    return rejections;
  }
  if (!entry.artifactPath.startsWith('files/')) {
    rejections.push({
      artifactPath: entry.artifactPath,
      code: 'invalid-path',
      reason: 'Evidence package artifactPath must be under files/.',
      sourcePath: entry.sourcePath,
    });
  }
  if (entry.artifactPath.split('/').some((segment) => /[. ]$/u.test(segment))) {
    rejections.push({
      artifactPath: entry.artifactPath,
      code: 'invalid-path',
      reason: 'Evidence package artifact paths must be portable and cannot end a segment with a dot or space.',
      sourcePath: entry.sourcePath,
    });
  }
  const pathReason = sensitivePathReason(entry.sourcePath) ?? sensitivePathReason(entry.artifactPath);
  if (pathReason) {
    rejections.push({
      artifactPath: entry.artifactPath,
      code: 'sensitive-path',
      reason: pathReason,
      sourcePath: entry.sourcePath,
    });
  }
  return rejections;
}

function prepareEvidenceEntries(
  request: EvidencePackageRequest,
  sourceRoot: string,
): PreparedEvidencePackageEntry[] {
  const rejections: EvidencePackageRejection[] = [];
  const sourcePaths = new Set<string>();
  const artifactPaths = new Set<string>();
  const portableArtifactPaths = new Map<string, string>();
  const sourceRootIdentity = readDirectoryIdentity(sourceRoot);
  const entries = [...request.entries].sort((left, right) => (
    left.artifactPath < right.artifactPath ? -1 : left.artifactPath > right.artifactPath ? 1 : 0
  ));
  const prepared: PreparedEvidencePackageEntry[] = [];

  for (const [index, entry] of entries.entries()) {
    rejections.push(...validateEntryPaths(entry, index));
    if (sourcePaths.has(entry.sourcePath)) {
      rejections.push({
        artifactPath: entry.artifactPath,
        code: 'duplicate-source',
        reason: 'Each source file may appear only once in an evidence package.',
        sourcePath: entry.sourcePath,
      });
    }
    if (artifactPaths.has(entry.artifactPath)) {
      rejections.push({
        artifactPath: entry.artifactPath,
        code: 'duplicate-artifact',
        reason: 'Each evidence-package artifact path must be unique.',
        sourcePath: entry.sourcePath,
      });
    }
    const portableArtifactPath = portableArtifactPathKey(entry.artifactPath);
    const portableCollision = [...portableArtifactPaths.entries()].find(([candidate]) => (
      candidate === portableArtifactPath ||
      candidate.startsWith(`${portableArtifactPath}/`) ||
      portableArtifactPath.startsWith(`${candidate}/`)
    ));
    if (portableCollision) {
      rejections.push({
        artifactPath: entry.artifactPath,
        code: 'duplicate-artifact',
        reason: `Evidence package artifact paths collide under portable filesystem semantics (${portableCollision[1]}).`,
        sourcePath: entry.sourcePath,
      });
    } else {
      portableArtifactPaths.set(portableArtifactPath, entry.artifactPath);
    }
    sourcePaths.add(entry.sourcePath);
    artifactPaths.add(entry.artifactPath);
    if (rejections.some((rejection) => (
      rejection.sourcePath === entry.sourcePath && rejection.artifactPath === entry.artifactPath
    ))) {
      continue;
    }

    try {
      const snapshot = readStableContainedFile(sourceRoot, entry.sourcePath, `entries[${index}]`);
      assertDirectoryIdentity(sourceRoot, sourceRootIdentity);
      if (snapshot.byteSize === 0) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'empty',
          reason: 'Empty source files are not admissible evidence-package entries.',
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      if (containsSecretMarker(snapshot.bytes)) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'secret-marker',
          reason: 'The source file contains a blocked private-key marker.',
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      prepared.push({
        ...entry,
        byteSize: snapshot.byteSize,
        bytes: snapshot.bytes,
        sha256: snapshot.sha256,
      });
    } catch (cause) {
      if (cause instanceof StableContainedFileError) {
        rejections.push(stableFileRejection(entry, cause));
        continue;
      }
      throw cause;
    }
  }

  if (rejections.length > 0) {
    throw new EvidencePackageError(
      'rejected',
      'One or more requested evidence-package entries were rejected; no package was written.',
      rejections,
    );
  }
  assertDirectoryIdentity(sourceRoot, sourceRootIdentity);
  return prepared;
}

function writePrivateFile(filePath: string, bytes: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function removeCreatedDirectories(createdDirectories: string[]): void {
  for (const directory of [...createdDirectories].reverse()) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // Remove only package-created directories that are still empty.
    }
  }
}

function prepareOutputParent(
  requestedParent: string,
  sourceRoot: string,
): {createdDirectories: string[]; outputParent: string} {
  const missingSegments: string[] = [];
  let existingAncestor = path.resolve(requestedParent);
  while (!lstatOrNull(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new EvidencePackageError('invalid-request', 'Evidence package output parent cannot be resolved.');
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  let canonicalParent: string;
  try {
    canonicalParent = resolveStableDirectory(existingAncestor, 'evidence package output ancestor');
  } catch {
    throw new EvidencePackageError('invalid-request', 'Evidence package output parent must resolve through a stable directory.');
  }
  for (const segment of missingSegments) {
    canonicalParent = path.join(canonicalParent, segment);
  }
  if (isContained(sourceRoot, canonicalParent)) {
    throw new EvidencePackageError('invalid-request', 'Evidence package outputDir must be outside sourceRoot.');
  }

  const createdDirectories: string[] = [];
  let current = resolveStableDirectory(existingAncestor, 'evidence package output ancestor');
  try {
    for (const segment of missingSegments) {
      const next = path.join(current, segment);
      try {
        fs.mkdirSync(next, { mode: 0o700 });
        createdDirectories.push(next);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw cause;
        }
      }
      const resolved = resolveStableDirectory(next, 'evidence package output parent');
      if (isContained(sourceRoot, resolved)) {
        throw new EvidencePackageError(
          'invalid-request',
          'Evidence package output parent changed identity or entered sourceRoot during creation.',
        );
      }
      current = resolved;
    }
    return { createdDirectories, outputParent: current };
  } catch (cause) {
    removeCreatedDirectories(createdDirectories);
    if (cause instanceof EvidencePackageError) {
      throw cause;
    }
    throw new EvidencePackageError('invalid-request', 'Evidence package output parent could not be created safely.');
  }
}

export async function materializeEvidencePackage(
  requestInput: unknown,
): Promise<EvidencePackageResult> {
  const request = assertValidJson(
    requestInput,
    SCHEMAS.evidencePackageRequest,
    'Evidence package request',
  ) as EvidencePackageRequest;
  let sourceRoot: string;
  try {
    sourceRoot = resolveStableDirectory(request.sourceRoot, 'evidence package sourceRoot');
  } catch {
    throw new EvidencePackageError('invalid-request', 'Evidence package sourceRoot must be one stable readable directory.');
  }
  let outputDir = path.resolve(request.outputDir);
  const outputName = path.basename(outputDir);
  if (!outputName || outputName === '.' || outputName === '..') {
    throw new EvidencePackageError('invalid-request', 'Evidence package outputDir must name a new directory.');
  }
  let comparableOutputDir = outputDir;
  try {
    comparableOutputDir = path.join(resolveStableDirectory(path.dirname(outputDir), 'evidence package output parent'), outputName);
    outputDir = comparableOutputDir;
  } catch {
    // The output parent is created and validated only after all source entries pass admission.
  }
  if (lstatOrNull(outputDir)) {
    throw new EvidencePackageError(
      'output-conflict',
      'Evidence package outputDir already exists and will not be replaced.',
      [{ code: 'output-conflict', reason: 'The requested output path already exists.' }],
    );
  }
  if (isContained(sourceRoot, comparableOutputDir)) {
    throw new EvidencePackageError(
      'invalid-request',
      'Evidence package outputDir must be outside sourceRoot.',
    );
  }

  const prepared = prepareEvidenceEntries(request, sourceRoot);
  const artifact: EvidencePackageArtifact = assertValidJson(
    {
      schemaVersion: '1.0.0',
      packageId: request.packageId,
      runId: request.runId,
      status: 'complete',
      sensitivityPolicy: request.sensitivityPolicy,
      fileCount: prepared.length,
      totalByteSize: prepared.reduce((sum, entry) => sum + entry.byteSize, 0),
      checksumsPath: 'SHA256SUMS',
      entries: prepared.map(({ bytes: _bytes, ...entry }) => entry),
    },
    SCHEMAS.evidencePackage,
    'Evidence package artifact',
  ) as EvidencePackageArtifact;

  const requestedOutputParent = path.dirname(outputDir);
  const preparedParent = prepareOutputParent(requestedOutputParent, sourceRoot);
  const outputParent = preparedParent.outputParent;
  outputDir = path.join(outputParent, outputName);
  if (isContained(sourceRoot, outputDir)) {
    removeCreatedDirectories(preparedParent.createdDirectories);
    throw new EvidencePackageError(
      'invalid-request',
      'Evidence package outputDir must be outside sourceRoot.',
    );
  }
  if (lstatOrNull(outputDir)) {
    removeCreatedDirectories(preparedParent.createdDirectories);
    throw new EvidencePackageError(
      'output-conflict',
      'Evidence package outputDir already exists and will not be replaced.',
      [{ code: 'output-conflict', reason: 'The requested output path already exists.' }],
    );
  }
  const stage = path.join(
    outputParent,
    `.${path.basename(outputDir)}.incomplete-${process.pid}-${crypto.randomUUID()}`,
  );
  let published = false;
  let outputReserved = false;
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    for (const entry of prepared) {
      writePrivateFile(path.join(stage, entry.artifactPath), entry.bytes);
    }
    for (const entry of prepared) {
      const staged = readStableContainedFile(stage, entry.artifactPath, `packaged ${entry.artifactPath}`);
      if (staged.byteSize !== entry.byteSize || staged.sha256 !== entry.sha256) {
        throw new EvidencePackageError(
          'rejected',
          'A packaged file did not preserve its admitted bytes; no package was written.',
          [{
            artifactPath: entry.artifactPath,
            code: 'changed-during-read',
            reason: 'The staged artifact bytes do not match the admitted source bytes.',
            sourcePath: entry.sourcePath,
          }],
        );
      }
    }
    const manifestPath = path.join(stage, 'evidence-package.json');
    await writeJsonArtifact({
      filePath: manifestPath,
      value: artifact,
      schema: SCHEMAS.evidencePackage,
      label: 'Evidence package artifact',
    });
    fs.chmodSync(manifestPath, 0o600);
    const manifestBytes = fs.readFileSync(manifestPath);
    const checksumEntries = [
      ...artifact.entries.map((entry) => ({ path: entry.artifactPath, sha256: entry.sha256 })),
      {
        path: 'evidence-package.json',
        sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
      },
    ].sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ));
    writePrivateFile(
      path.join(stage, artifact.checksumsPath),
      `${checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n')}\n`,
    );
    try {
      fs.mkdirSync(outputDir, { mode: 0o700 });
      outputReserved = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new EvidencePackageError(
          'output-conflict',
          'Evidence package outputDir appeared during materialization and will not be replaced.',
          [{ code: 'output-conflict', reason: 'The requested output path already exists.' }],
        );
      }
      throw cause;
    }
    for (const child of ['files', artifact.checksumsPath, 'evidence-package.json']) {
      fs.renameSync(path.join(stage, child), path.join(outputDir, child));
    }
    published = true;
    return {
      artifact,
      checksumsPath: path.join(outputDir, artifact.checksumsPath),
      manifestPath: path.join(outputDir, 'evidence-package.json'),
      outputDir,
    };
  } finally {
    if (published) {
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch {
        // A complete reserved output remains authoritative over staging cleanup.
      }
    } else {
      fs.rmSync(stage, { recursive: true, force: true });
      if (outputReserved) {
        fs.rmSync(outputDir, { recursive: true, force: true });
      }
      removeCreatedDirectories(preparedParent.createdDirectories);
    }
  }
}

module.exports = {
  EvidencePackageError,
  materializeEvidencePackage,
};
