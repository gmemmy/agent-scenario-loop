const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

type FileIdentity = {
  ctimeMs: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  nlink: number;
  size: number;
};

export type StableContainedFile = {
  byteSize: number;
  bytes: Uint8Array;
  sha256: string;
};

export class StableContainedFileError extends Error {
  code: 'invalid-path' | 'missing' | 'not-regular' | 'outside-root' | 'symlink' | 'changed-during-read';

  constructor(
    code: StableContainedFileError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'StableContainedFileError';
    this.code = code;
  }
}

function mutationIdentity(stat: FileIdentity): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.nlink}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function assertRunRelativeFilePath(value: string, label = 'path'): void {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith('\\\\') ||
    value.includes('\\') ||
    value.includes('//') ||
    /[\u0000-\u001F\u007F]/u.test(value) ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new StableContainedFileError(
      'invalid-path',
      `${label} must be a safe run-relative POSIX path.`,
    );
  }
}

export function resolveStableDirectory(directory: string, label = 'directory'): string {
  const resolved = path.resolve(directory);
  let status: ReturnType<typeof fs.lstatSync>;
  try {
    status = fs.lstatSync(resolved);
  } catch {
    throw new StableContainedFileError('missing', `${label} is missing or unreadable.`);
  }
  if (status.isSymbolicLink()) {
    throw new StableContainedFileError('symlink', `${label} must not be a symlink.`);
  }
  if (!status.isDirectory()) {
    throw new StableContainedFileError('not-regular', `${label} must be a directory.`);
  }
  return fs.realpathSync(resolved);
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new StableContainedFileError('outside-root', `${label} escapes its declared root.`);
  }
}

function readPathComponentIdentities(
  root: string,
  relativePath: string,
  label: string,
): string[] {
  const segments = relativePath.split('/');
  return segments.map((segment, index) => {
    const candidate = path.join(root, ...segments.slice(0, index + 1));
    let status: ReturnType<typeof fs.lstatSync>;
    try {
      status = fs.lstatSync(candidate);
    } catch {
      throw new StableContainedFileError('missing', `${label} is missing or unreadable.`);
    }
    if (status.isSymbolicLink()) {
      throw new StableContainedFileError('symlink', `${label} must not traverse a symlink.`);
    }
    if (index < segments.length - 1 && !status.isDirectory()) {
      throw new StableContainedFileError('not-regular', `${label} parent must be a directory.`);
    }
    return mutationIdentity(status);
  });
}

function openReadOnlyNoFollow(): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  return fs.constants.O_RDONLY | noFollow;
}

export function readStableContainedFile(
  rootDirectory: string,
  relativePath: string,
  label = 'file',
): StableContainedFile {
  assertRunRelativeFilePath(relativePath, label);
  const root = resolveStableDirectory(rootDirectory, `${label} root`);
  const filePath = path.resolve(root, relativePath);
  assertContained(root, filePath, label);
  const pathComponentsBefore = readPathComponentIdentities(root, relativePath, label);

  let before: ReturnType<typeof fs.lstatSync>;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    throw new StableContainedFileError('missing', `${label} is missing or unreadable.`);
  }
  if (before.isSymbolicLink()) {
    throw new StableContainedFileError('symlink', `${label} must not be a symlink.`);
  }
  if (!before.isFile()) {
    throw new StableContainedFileError('not-regular', `${label} must be a regular file.`);
  }

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, openReadOnlyNoFollow());
    const opened = fs.fstatSync(descriptor);
    if (mutationIdentity(opened) !== mutationIdentity(before)) {
      throw new StableContainedFileError('changed-during-read', `${label} changed during verification.`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const bytesRead = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw new StableContainedFileError('changed-during-read', `${label} changed during verification.`);
      }
      offset += bytesRead;
    }
    const afterRead = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(filePath);
    const pathComponentsAfter = readPathComponentIdentities(root, relativePath, label);
    if (
      mutationIdentity(afterRead) !== mutationIdentity(opened) ||
      mutationIdentity(afterPath) !== mutationIdentity(before) ||
      afterPath.isSymbolicLink() ||
      pathComponentsAfter.length !== pathComponentsBefore.length ||
      pathComponentsAfter.some((identity, index) => identity !== pathComponentsBefore[index])
    ) {
      throw new StableContainedFileError('changed-during-read', `${label} changed during verification.`);
    }
    const realPath = fs.realpathSync(filePath);
    assertContained(root, realPath, label);
    const realStatus = fs.statSync(realPath);
    if (mutationIdentity(realStatus) !== mutationIdentity(before)) {
      throw new StableContainedFileError('outside-root', `${label} does not resolve to its declared path.`);
    }
    return {
      byteSize: bytes.length,
      bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (cause) {
    if (cause instanceof StableContainedFileError) {
      throw cause;
    }
    throw new StableContainedFileError('missing', `${label} is missing or unreadable.`);
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The primary verification result remains authoritative.
      }
    }
  }
}

module.exports = {
  StableContainedFileError,
  assertRunRelativeFilePath,
  readStableContainedFile,
  resolveStableDirectory,
};
