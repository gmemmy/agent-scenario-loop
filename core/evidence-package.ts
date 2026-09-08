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

export type EvidencePackageRequestEntry = {
  artifactPath: `files/${string}`;
  kind: EvidencePackageKind;
  sourcePath: string;
};

export type EvidencePackageJsonPointerRequest = {
  jsonPointer: string;
  role: 'artifact-reference';
  sourcePath: string;
  referencedSourcePath: string;
} | {
  jsonPointer: string;
  role: 'host-local-provenance';
  sourcePath: string;
};

export type EvidencePackageJsonPointer = {
  artifactPath: `files/${string}`;
  dereferenceable: false;
  jsonPointer: string;
  role: 'host-local-provenance';
  value: string;
} | {
  artifactPath: `files/${string}`;
  dereferenceable: true;
  jsonPointer: string;
  referencedArtifactPath: `files/${string}`;
  role: 'artifact-reference';
  value: `files/${string}`;
};

type EvidencePackageRequestBase = {
  entries: EvidencePackageRequestEntry[];
  outputDir: string;
  packageId: string;
  runId: string;
  sensitivityPolicy: 'allowlist-and-secret-marker-v1';
  sourceRoot: string;
};

export type EvidencePackageRequest = EvidencePackageRequestBase & ({
  schemaVersion: '1.0.0';
} | {
  jsonPointers: EvidencePackageJsonPointerRequest[];
  schemaVersion: '1.1.0';
});

type EvidencePackageEntry = EvidencePackageRequestEntry & {
  byteSize: number;
  sha256: string;
};

type EvidencePackageArtifactBase = {
  checksumsPath: 'SHA256SUMS';
  entries: EvidencePackageEntry[];
  fileCount: number;
  packageId: string;
  runId: string;
  sensitivityPolicy: 'allowlist-and-secret-marker-v1';
  status: 'complete';
  totalByteSize: number;
};

export type EvidencePackageArtifact = EvidencePackageArtifactBase & ({
  schemaVersion: '1.0.0';
} | {
  completionMarkerPath: 'evidence-package.complete';
  jsonPointers: EvidencePackageJsonPointer[];
  schemaVersion: '1.1.0';
});

export type EvidencePackageRejection = {
  artifactPath?: string;
  code: 'changed-during-read' | 'checksum-mismatch' | 'duplicate-artifact' | 'duplicate-source' | 'empty' | 'invalid-json' | 'invalid-path' | 'invalid-pointer' | 'missing' | 'missing-manifest' | 'missing-pointer' | 'missing-reference' | 'non-string-pointer' | 'not-regular' | 'output-conflict' | 'secret-marker' | 'sensitive-path' | 'symlink' | 'unclassified-absolute-path';
  reason: string;
  sourcePath?: string;
};

export type EvidencePackageResult = {
  artifact: EvidencePackageArtifact;
  checksumsPath: string;
  manifestPath: string;
  outputDir: string;
};

export type EvidencePackageVerification = {
  artifact: EvidencePackageArtifact;
  checksumsPath: string;
  manifestPath: string;
  outputDir: string;
  status: 'complete';
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

type JsonPointerLocation = {
  parent: unknown[] | Record<string, unknown> | null;
  key: number | string | null;
  value: unknown;
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

function decodeJsonPointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new Error('JSON Pointer must be empty or begin with /.');
  }
  return pointer.slice(1).split('/').map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) {
      throw new Error('JSON Pointer contains an invalid escape.');
    }
    return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
  });
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function locateJsonPointer(root: unknown, pointer: string): JsonPointerLocation | null {
  const segments = decodeJsonPointer(pointer);
  if (segments.length === 0) {
    return { parent: null, key: null, value: root };
  }
  let current: unknown = root;
  for (const [index, segment] of segments.entries()) {
    const terminal = index === segments.length - 1;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment)) {
        return null;
      }
      const key = Number(segment);
      if (key >= current.length) {
        return null;
      }
      if (terminal) {
        return { parent: current, key, value: current[key] };
      }
      current = current[key];
      continue;
    }
    if (current === null || typeof current !== 'object') {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return null;
    }
    if (terminal) {
      return { parent: record, key: segment, value: record[segment] };
    }
    current = record[segment];
  }
  return null;
}

function walkJsonStrings(
  value: unknown,
  pointer = '',
): Array<{jsonPointer: string; value: string}> {
  if (typeof value === 'string') {
    return [{ jsonPointer: pointer, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => walkJsonStrings(child, `${pointer}/${index}`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => (
      walkJsonStrings(child, `${pointer}/${escapeJsonPointerSegment(key)}`)
    ));
  }
  return [];
}

function isAbsoluteHostPath(value: string): boolean {
  return /^(?:\/.*|[A-Za-z]:[\\/].*|\\\\.+)$/u.test(value);
}

function requestJsonPointers(request: EvidencePackageRequest): EvidencePackageJsonPointerRequest[] {
  if (request.schemaVersion === '1.0.0') {
    return [];
  }
  return request.jsonPointers;
}

function parseJsonBytes(bytes: Uint8Array): {status: 'parsed'; value: unknown} | {status: 'not-json'} {
  const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/u, '');
  try {
    return { status: 'parsed', value: JSON.parse(text) };
  } catch {
    return { status: 'not-json' };
  }
}

function referencedEntryForValue(
  value: string,
  referencedSourcePath: string,
  sourceRoot: string,
  entries: readonly EvidencePackageRequestEntry[],
): {entry: EvidencePackageRequestEntry; status: 'matched'} | {status: 'missing'} | {status: 'outside-root'} {
  const referenced = entries.find((entry) => entry.sourcePath === referencedSourcePath);
  if (!referenced) {
    return { status: 'missing' };
  }
  if (!path.isAbsolute(value)) {
    return { status: 'missing' };
  }
  let resolvedValue: string;
  try {
    resolvedValue = fs.realpathSync(value);
  } catch {
    return { status: 'missing' };
  }
  const relative = path.relative(sourceRoot, resolvedValue).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    return { status: 'outside-root' };
  }
  return relative === referenced.sourcePath
    ? { entry: referenced, status: 'matched' }
    : { status: 'missing' };
}

function transformJsonEntries(
  request: EvidencePackageRequest,
  sourceRoot: string,
  prepared: PreparedEvidencePackageEntry[],
): {entries: PreparedEvidencePackageEntry[]; pointers: EvidencePackageJsonPointer[]} {
  if (request.schemaVersion === '1.0.0') {
    return {
      entries: prepared,
      pointers: [],
    };
  }
  const declarations = requestJsonPointers(request);
  const declarationsBySource = new Map<string, EvidencePackageJsonPointerRequest[]>();
  const declarationKeys = new Set<string>();
  const rejections: EvidencePackageRejection[] = [];
  for (const declaration of declarations) {
    try {
      decodeJsonPointer(declaration.jsonPointer);
      assertRunRelativeFilePath(declaration.sourcePath, 'jsonPointers.sourcePath');
      if (declaration.role === 'artifact-reference') {
        assertRunRelativeFilePath(declaration.referencedSourcePath, 'jsonPointers.referencedSourcePath');
      }
    } catch {
      rejections.push({
        code: 'invalid-pointer',
        reason: 'JSON pointer declarations must use valid JSON Pointer and run-relative source paths.',
        sourcePath: declaration.sourcePath,
      });
      continue;
    }
    const key = `${declaration.sourcePath}\n${declaration.jsonPointer}`;
    if (declarationKeys.has(key)) {
      rejections.push({
        code: 'invalid-pointer',
        reason: 'Each JSON pointer may be classified only once per source entry.',
        sourcePath: declaration.sourcePath,
      });
      continue;
    }
    declarationKeys.add(key);
    const list = declarationsBySource.get(declaration.sourcePath) ?? [];
    list.push(declaration);
    declarationsBySource.set(declaration.sourcePath, list);
  }

  const pointers: EvidencePackageJsonPointer[] = [];
  const entries = prepared.map((entry) => {
    const entryDeclarations = declarationsBySource.get(entry.sourcePath) ?? [];
    const decoded = parseJsonBytes(entry.bytes);
    if (decoded.status === 'not-json') {
      if (entryDeclarations.length > 0 || entry.artifactPath.toLowerCase().endsWith('.json')) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'invalid-json',
          reason: 'A classified JSON pointer source is not valid JSON.',
          sourcePath: entry.sourcePath,
        });
      }
      return entry;
    }
    let parsed = decoded.value;

    for (const declaration of entryDeclarations) {
      let located: JsonPointerLocation | null;
      try {
        located = locateJsonPointer(parsed, declaration.jsonPointer);
      } catch {
        located = null;
      }
      if (!located) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'missing-pointer',
          reason: `Classified JSON pointer ${declaration.jsonPointer} is missing.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      if (typeof located.value !== 'string') {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'non-string-pointer',
          reason: `Classified JSON pointer ${declaration.jsonPointer} does not identify a string.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      if (!isAbsoluteHostPath(located.value)) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'invalid-path',
          reason: `Classified JSON pointer ${declaration.jsonPointer} does not contain an absolute path.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }

      if (declaration.role === 'host-local-provenance') {
        pointers.push({
          artifactPath: entry.artifactPath,
          dereferenceable: false,
          jsonPointer: declaration.jsonPointer,
          role: declaration.role,
          value: located.value,
        });
        continue;
      }

      const reference = referencedEntryForValue(
        located.value,
        declaration.referencedSourcePath,
        sourceRoot,
        request.entries,
      );
      if (reference.status === 'outside-root') {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'invalid-path',
          reason: `Artifact reference ${declaration.jsonPointer} escapes the evidence source root.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      if (reference.status === 'missing') {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'missing-reference',
          reason: `Artifact reference ${declaration.jsonPointer} does not identify its declared requested entry.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      const referenced = reference.entry;
      if (located.parent === null) {
        parsed = referenced.artifactPath;
      } else if (Array.isArray(located.parent) && typeof located.key === 'number') {
        located.parent[located.key] = referenced.artifactPath;
      } else if (!Array.isArray(located.parent) && typeof located.key === 'string') {
        located.parent[located.key] = referenced.artifactPath;
      } else {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'invalid-pointer',
          reason: `Artifact reference ${declaration.jsonPointer} could not be rewritten.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      const rewritten = locateJsonPointer(parsed, declaration.jsonPointer);
      if (!rewritten || rewritten.value !== referenced.artifactPath) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'invalid-pointer',
          reason: `Artifact reference ${declaration.jsonPointer} was not rewritten deterministically.`,
          sourcePath: entry.sourcePath,
        });
        continue;
      }
      pointers.push({
        artifactPath: entry.artifactPath,
        dereferenceable: true,
        jsonPointer: declaration.jsonPointer,
        referencedArtifactPath: referenced.artifactPath,
        role: declaration.role,
        value: referenced.artifactPath,
      });
    }

    for (const candidate of walkJsonStrings(parsed)) {
      if (!isAbsoluteHostPath(candidate.value)) {
        continue;
      }
      if (!declarationKeys.has(`${entry.sourcePath}\n${candidate.jsonPointer}`)) {
        rejections.push({
          artifactPath: entry.artifactPath,
          code: 'unclassified-absolute-path',
          reason: `Packaged JSON contains an unclassified absolute path at ${candidate.jsonPointer || '<root>'}.`,
          sourcePath: entry.sourcePath,
        });
      }
    }

    if (entryDeclarations.some((declaration) => declaration.role === 'artifact-reference')) {
      const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      return {
        ...entry,
        byteSize: bytes.byteLength,
        bytes,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    }
    return entry;
  });

  for (const sourcePath of declarationsBySource.keys()) {
    if (!prepared.some((entry) => entry.sourcePath === sourcePath)) {
      rejections.push({
        code: 'missing-reference',
        reason: 'A JSON pointer declaration does not identify a requested source entry.',
        sourcePath,
      });
    }
  }
  if (rejections.length > 0) {
    throw new EvidencePackageError(
      'rejected',
      'One or more packaged JSON references were rejected; no package was written.',
      rejections,
    );
  }
  return {
    entries,
    pointers: pointers.sort((left, right) => {
      const leftKey = `${left.artifactPath}\n${left.jsonPointer}`;
      const rightKey = `${right.artifactPath}\n${right.jsonPointer}`;
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      return 0;
    }),
  };
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

function buildEvidencePackageArtifact(
  request: EvidencePackageRequest,
  prepared: PreparedEvidencePackageEntry[],
  pointers: EvidencePackageJsonPointer[],
): EvidencePackageArtifact {
  const common = {
    packageId: request.packageId,
    runId: request.runId,
    status: 'complete' as const,
    sensitivityPolicy: request.sensitivityPolicy,
    fileCount: prepared.length,
    totalByteSize: prepared.reduce((sum, entry) => sum + entry.byteSize, 0),
    checksumsPath: 'SHA256SUMS' as const,
    entries: prepared.map(({ bytes: _bytes, ...entry }) => entry),
  };
  const value = request.schemaVersion === '1.1.0'
    ? {
        ...common,
        completionMarkerPath: 'evidence-package.complete' as const,
        jsonPointers: pointers,
        schemaVersion: '1.1.0' as const,
      }
    : {
        ...common,
        schemaVersion: '1.0.0' as const,
      };
  return assertValidJson(
    value,
    SCHEMAS.evidencePackage,
    'Evidence package artifact',
  ) as EvidencePackageArtifact;
}

function writePrivateFile(filePath: string, bytes: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function completionMarkerBytes(manifestSha256: string): Buffer {
  return Buffer.from(`${manifestSha256}\n`, 'utf8');
}

function writeExclusivePrivateFile(filePath: string, bytes: Uint8Array | string): void {
  const handle = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fchmodSync(handle, 0o600);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function fsyncPersistentPath(targetPath: string): void {
  const handle = fs.openSync(targetPath, 'r');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function filesTreeDirectories(artifactPaths: readonly string[]): string[] {
  const directories = new Set<string>(['files']);
  for (const artifactPath of artifactPaths) {
    let directory = path.posix.dirname(artifactPath);
    while (directory !== '.' && directory !== '/') {
      directories.add(directory);
      const parent = path.posix.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  return [...directories].sort((left, right) => {
    const depthDelta = right.split('/').length - left.split('/').length;
    if (depthDelta !== 0) {
      return depthDelta;
    }
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function fsyncSealedPackageContents(
  outputDir: string,
  artifact: EvidencePackageArtifact,
): void {
  for (const entry of artifact.entries) {
    fsyncPersistentPath(path.join(outputDir, entry.artifactPath));
  }
  fsyncPersistentPath(path.join(outputDir, artifact.checksumsPath));
  fsyncPersistentPath(path.join(outputDir, 'evidence-package.json'));
  for (const directory of filesTreeDirectories(
    artifact.entries.map((entry) => entry.artifactPath),
  )) {
    fsyncPersistentPath(path.join(outputDir, directory));
  }
}

function buildChecksumEntries(
  artifact: EvidencePackageArtifact,
  manifestSha256: string,
): Array<{ path: string; sha256: string }> {
  const checksumEntries = [
    ...artifact.entries.map((entry) => ({ path: entry.artifactPath, sha256: entry.sha256 })),
    {
      path: 'evidence-package.json',
      sha256: manifestSha256,
    },
  ];
  if (artifact.schemaVersion === '1.1.0') {
    checksumEntries.push({
      path: artifact.completionMarkerPath,
      sha256: crypto.createHash('sha256').update(completionMarkerBytes(manifestSha256)).digest('hex'),
    });
  }
  return checksumEntries.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
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

  const admitted = prepareEvidenceEntries(request, sourceRoot);
  const transformed = transformJsonEntries(request, sourceRoot, admitted);
  const prepared = transformed.entries;
  const artifact = buildEvidencePackageArtifact(request, prepared, transformed.pointers);

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
    const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    const checksumEntries = buildChecksumEntries(artifact, manifestSha256);
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
    if (artifact.schemaVersion === '1.1.0') {
      fsyncSealedPackageContents(outputDir, artifact);
      writeExclusivePrivateFile(
        path.join(outputDir, artifact.completionMarkerPath),
        completionMarkerBytes(manifestSha256),
      );
      fsyncPersistentPath(outputDir);
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

function verificationError(
  code: EvidencePackageRejection['code'],
  reason: string,
  artifactPath?: string,
): EvidencePackageError {
  return new EvidencePackageError(
    'rejected',
    'Evidence package verification failed.',
    [{
      ...(artifactPath === undefined ? {} : { artifactPath }),
      code,
      reason,
    }],
  );
}

function readPackageFile(
  packageDir: string,
  relativePath: string,
  code: EvidencePackageRejection['code'],
): ReturnType<typeof readStableContainedFile> {
  try {
    return readStableContainedFile(packageDir, relativePath, `evidence package ${relativePath}`);
  } catch (cause) {
    if (cause instanceof StableContainedFileError) {
      throw verificationError(code, `Required package file ${relativePath} is unavailable (${cause.code}).`, relativePath);
    }
    throw cause;
  }
}

function parseChecksums(bytes: Uint8Array): Map<string, string> {
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.endsWith('\n')) {
    throw verificationError('checksum-mismatch', 'SHA256SUMS must end with one newline.');
  }
  const checksums = new Map<string, string>();
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match?.[1] || !match[2]) {
      throw verificationError('checksum-mismatch', 'SHA256SUMS contains a malformed record.');
    }
    const [, sha256, relativePath] = match;
    try {
      assertRunRelativeFilePath(relativePath, 'SHA256SUMS path');
    } catch {
      throw verificationError('checksum-mismatch', 'SHA256SUMS contains an unsafe path.', relativePath);
    }
    if (checksums.has(relativePath)) {
      throw verificationError('checksum-mismatch', 'SHA256SUMS contains a duplicate path.', relativePath);
    }
    checksums.set(relativePath, sha256);
  }
  return checksums;
}

function listPackagedFiles(packageDir: string, relativeDirectory = ''): string[] {
  const directory = relativeDirectory === ''
    ? packageDir
    : path.join(packageDir, relativeDirectory);
  const files: string[] = [];
  const children = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left: import('node:fs').Dirent, right: import('node:fs').Dirent) => (
      left.name.localeCompare(right.name, 'en')
    ));
  for (const child of children) {
    const relativePath = relativeDirectory === ''
      ? child.name
      : `${relativeDirectory}/${child.name}`;
    if (child.isSymbolicLink()) {
      throw verificationError('symlink', 'Evidence packages cannot contain symbolic links.', relativePath);
    }
    if (child.isDirectory()) {
      files.push(...listPackagedFiles(packageDir, relativePath));
      continue;
    }
    if (!child.isFile()) {
      throw verificationError('not-regular', 'Evidence packages can contain only regular files.', relativePath);
    }
    files.push(relativePath);
  }
  return files;
}

export function verifyEvidencePackage(packageDirInput: string): EvidencePackageVerification {
  let outputDir: string;
  try {
    outputDir = resolveStableDirectory(packageDirInput, 'evidence package directory');
  } catch {
    throw verificationError('missing-manifest', 'Evidence package directory is unavailable or unstable.');
  }
  const manifestSnapshot = readPackageFile(
    outputDir,
    'evidence-package.json',
    'missing-manifest',
  );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(Buffer.from(manifestSnapshot.bytes).toString('utf8'));
  } catch {
    throw verificationError('missing-manifest', 'evidence-package.json is not valid JSON.');
  }
  let artifact: EvidencePackageArtifact;
  try {
    artifact = assertValidJson(
      manifestValue,
      SCHEMAS.evidencePackage,
      'Evidence package artifact',
    ) as EvidencePackageArtifact;
  } catch {
    throw verificationError('missing-manifest', 'evidence-package.json does not satisfy the public schema.');
  }

  const checksumSnapshot = readPackageFile(outputDir, artifact.checksumsPath, 'checksum-mismatch');
  const checksums = parseChecksums(checksumSnapshot.bytes);
  const expectedPaths = new Set(['evidence-package.json', ...artifact.entries.map((entry) => entry.artifactPath)]);
  if (artifact.schemaVersion === '1.1.0') {
    expectedPaths.add(artifact.completionMarkerPath);
  }
  if (checksums.size !== expectedPaths.size || [...checksums.keys()].some((entry) => !expectedPaths.has(entry))) {
    throw verificationError('checksum-mismatch', 'SHA256SUMS does not exactly inventory the manifest and declared entries.');
  }
  if (checksums.get('evidence-package.json') !== manifestSnapshot.sha256) {
    throw verificationError('checksum-mismatch', 'The evidence-package.json digest does not match SHA256SUMS.');
  }

  if (artifact.schemaVersion === '1.1.0') {
    const markerSnapshot = readPackageFile(outputDir, artifact.completionMarkerPath, 'checksum-mismatch');
    const expectedMarkerBytes = completionMarkerBytes(manifestSnapshot.sha256);
    if (
      !Buffer.from(markerSnapshot.bytes).equals(expectedMarkerBytes) ||
      checksums.get(artifact.completionMarkerPath) !== markerSnapshot.sha256
    ) {
      throw verificationError(
        'checksum-mismatch',
        'The completion marker bytes or digest do not match the sealed evidence-package.json digest.',
      );
    }
  }

  const expectedPackageFiles = new Set([artifact.checksumsPath, ...expectedPaths]);
  const actualPackageFiles = listPackagedFiles(outputDir);
  if (
    actualPackageFiles.length !== expectedPackageFiles.size ||
    actualPackageFiles.some((entry) => !expectedPackageFiles.has(entry))
  ) {
    throw verificationError('checksum-mismatch', 'The package directory contains files outside its sealed inventory.');
  }

  const entriesByArtifactPath = new Map<string, EvidencePackageEntry>();
  const snapshotsByArtifactPath = new Map<string, ReturnType<typeof readStableContainedFile>>();
  for (const entry of artifact.entries) {
    if (entriesByArtifactPath.has(entry.artifactPath)) {
      throw verificationError('duplicate-artifact', 'The manifest repeats an artifact path.', entry.artifactPath);
    }
    const snapshot = readPackageFile(outputDir, entry.artifactPath, 'checksum-mismatch');
    if (
      snapshot.byteSize !== entry.byteSize ||
      snapshot.sha256 !== entry.sha256 ||
      checksums.get(entry.artifactPath) !== entry.sha256
    ) {
      throw verificationError(
        'checksum-mismatch',
        'A packaged artifact changed after materialization.',
        entry.artifactPath,
      );
    }
    entriesByArtifactPath.set(entry.artifactPath, entry);
    snapshotsByArtifactPath.set(entry.artifactPath, snapshot);
  }
  if (
    artifact.fileCount !== artifact.entries.length ||
    artifact.totalByteSize !== artifact.entries.reduce((sum, entry) => sum + entry.byteSize, 0)
  ) {
    throw verificationError('checksum-mismatch', 'Manifest file count or total byte size does not match its entries.');
  }

  if (artifact.schemaVersion === '1.0.0') {
    return {
      artifact,
      checksumsPath: path.join(outputDir, artifact.checksumsPath),
      manifestPath: path.join(outputDir, 'evidence-package.json'),
      outputDir,
      status: 'complete',
    };
  }

  const pointers = artifact.schemaVersion === '1.1.0' ? artifact.jsonPointers : [];
  const pointerKeys = new Set<string>();
  for (const pointer of pointers) {
    const pointerKey = `${pointer.artifactPath}\n${pointer.jsonPointer}`;
    if (pointerKeys.has(pointerKey)) {
      throw verificationError(
        'invalid-pointer',
        'The manifest repeats an artifact JSON pointer.',
        pointer.artifactPath,
      );
    }
    pointerKeys.add(pointerKey);
  }
  for (const entry of artifact.entries) {
    const snapshot = snapshotsByArtifactPath.get(entry.artifactPath);
    if (!snapshot) {
      throw verificationError('checksum-mismatch', 'A declared artifact snapshot is unavailable.', entry.artifactPath);
    }
    const decoded = parseJsonBytes(snapshot.bytes);
    if (decoded.status === 'not-json') {
      if (entry.artifactPath.toLowerCase().endsWith('.json')) {
        throw verificationError('invalid-json', 'A packaged JSON artifact cannot be parsed.', entry.artifactPath);
      }
      continue;
    }
    for (const candidate of walkJsonStrings(decoded.value)) {
      if (
        isAbsoluteHostPath(candidate.value) &&
        !pointerKeys.has(`${entry.artifactPath}\n${candidate.jsonPointer}`)
      ) {
        throw verificationError(
          'unclassified-absolute-path',
          `Packaged JSON contains an unclassified absolute path at ${candidate.jsonPointer || '<root>'}.`,
          entry.artifactPath,
        );
      }
    }
  }

  for (const pointer of pointers) {
    const snapshot = snapshotsByArtifactPath.get(pointer.artifactPath);
    if (!snapshot) {
      throw verificationError('missing-reference', 'A pointer record names an absent packaged JSON artifact.', pointer.artifactPath);
    }
    const decoded = parseJsonBytes(snapshot.bytes);
    if (decoded.status === 'not-json') {
      throw verificationError('invalid-json', 'A pointer record names an invalid JSON artifact.', pointer.artifactPath);
    }
    let located: JsonPointerLocation | null;
    try {
      located = locateJsonPointer(decoded.value, pointer.jsonPointer);
    } catch {
      located = null;
    }
    if (!located || typeof located.value !== 'string') {
      throw verificationError('missing-pointer', 'A manifest pointer cannot be resolved to a packaged string.', pointer.artifactPath);
    }
    if (located.value !== pointer.value) {
      throw verificationError('checksum-mismatch', 'A classified JSON pointer no longer matches its manifest record.', pointer.artifactPath);
    }
    if (pointer.role === 'artifact-reference') {
      if (
        pointer.value !== pointer.referencedArtifactPath ||
        !entriesByArtifactPath.has(pointer.referencedArtifactPath)
      ) {
        throw verificationError('missing-reference', 'An artifact reference does not resolve to a declared packaged entry.', pointer.artifactPath);
      }
      readPackageFile(outputDir, pointer.referencedArtifactPath, 'missing-reference');
    }
  }

  return {
    artifact,
    checksumsPath: path.join(outputDir, artifact.checksumsPath),
    manifestPath: path.join(outputDir, 'evidence-package.json'),
    outputDir,
    status: 'complete',
  };
}

module.exports = {
  EvidencePackageError,
  materializeEvidencePackage,
  verifyEvidencePackage,
};
