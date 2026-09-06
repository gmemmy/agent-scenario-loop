const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EvidencePackageError,
  materializeEvidencePackage,
} = require('../evidence-package') as typeof import('../evidence-package');
const { SCHEMAS, assertValidJson } = require('../schema-validator');

type TestContext = import('node:test').TestContext;

async function setup(t: TestContext): Promise<{
  outputDir: string;
  request: Record<string, unknown>;
  sourceRoot: string;
  tempDir: string;
}> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-evidence-package-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const sourceRoot = path.join(tempDir, 'source');
  const outputDir = path.join(tempDir, 'package');
  await fsp.mkdir(path.join(sourceRoot, 'captures'), { recursive: true });
  await fsp.mkdir(path.join(sourceRoot, 'raw'), { recursive: true });
  await fsp.writeFile(path.join(sourceRoot, 'captures', 'journey.mov'), 'video-bytes', 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'raw', 'ui-tree.json'), '{"nodes":[]}', 'utf8');
  await fsp.writeFile(path.join(sourceRoot, '.env'), 'SECRET=must-not-copy', 'utf8');
  await fsp.writeFile(path.join(sourceRoot, 'raw', 'signing.key'), 'must-not-copy', 'utf8');
  return {
    outputDir,
    request: {
      schemaVersion: '1.0.0',
      packageId: 'sanitized-package',
      runId: 'run-1',
      sourceRoot,
      outputDir,
      sensitivityPolicy: 'allowlist-and-secret-marker-v1',
      entries: [
        {
          kind: 'uiTree',
          sourcePath: 'raw/ui-tree.json',
          artifactPath: 'files/ui-tree.json',
        },
        {
          kind: 'recording',
          sourcePath: 'captures/journey.mov',
          artifactPath: 'files/journey.mov',
        },
      ],
    },
    sourceRoot,
    tempDir,
  };
}

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

test('materializes only allowlisted stable bytes with deterministic inventory and private modes', async (t: TestContext) => {
  const fixture = await setup(t);
  const result = await materializeEvidencePackage(fixture.request);
  assert.doesNotThrow(() => assertValidJson(
    result.artifact,
    SCHEMAS.evidencePackage,
    'Evidence package artifact',
  ));
  assert.equal(result.artifact.status, 'complete');
  assert.equal(result.artifact.fileCount, 2);
  assert.deepEqual(result.artifact.entries.map((entry) => entry.artifactPath), [
    'files/journey.mov',
    'files/ui-tree.json',
  ]);
  assert.equal(result.artifact.totalByteSize, Buffer.byteLength('video-bytes{"nodes":[]}'));
  assert.equal(fs.readFileSync(path.join(fixture.outputDir, 'files', 'journey.mov'), 'utf8'), 'video-bytes');
  assert.equal(fs.readFileSync(path.join(fixture.outputDir, 'files', 'ui-tree.json'), 'utf8'), '{"nodes":[]}');
  assert.equal(fs.existsSync(path.join(fixture.outputDir, '.env')), false);
  assert.equal(fs.existsSync(path.join(fixture.outputDir, 'raw', 'signing.key')), false);
  assert.equal(mode(fixture.outputDir), 0o700);
  assert.equal(mode(result.manifestPath), 0o600);
  assert.equal(mode(result.checksumsPath), 0o600);
  assert.equal(mode(path.join(fixture.outputDir, 'files', 'journey.mov')), 0o600);

  const checksums: string[] = fs.readFileSync(result.checksumsPath, 'utf8').trim().split('\n');
  assert.deepEqual(checksums.map((line) => line.split('  ')[1]), [
    'evidence-package.json',
    'files/journey.mov',
    'files/ui-tree.json',
  ]);
  for (const line of checksums) {
    const [expected, relativePath] = line.split('  ');
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture.outputDir, relativePath ?? ''))).digest('hex'),
      expected,
    );
  }
});

test('public artifact schema rejects destinations outside files and control characters', () => {
  const artifact = {
    schemaVersion: '1.0.0',
    packageId: 'package-1',
    runId: 'run-1',
    status: 'complete',
    sensitivityPolicy: 'allowlist-and-secret-marker-v1',
    fileCount: 1,
    totalByteSize: 1,
    checksumsPath: 'SHA256SUMS',
    entries: [{
      kind: 'log',
      sourcePath: 'raw/device.log',
      artifactPath: 'device.log',
      byteSize: 1,
      sha256: '0'.repeat(64),
    }],
  };
  assert.throws(
    () => assertValidJson(artifact, SCHEMAS.evidencePackage, 'Evidence package artifact'),
    /schema validation/iu,
  );
  artifact.entries[0]!.artifactPath = 'files/device\nlog';
  assert.throws(
    () => assertValidJson(artifact, SCHEMAS.evidencePackage, 'Evidence package artifact'),
    /schema validation/iu,
  );
  artifact.entries[0]!.artifactPath = 'files/device.log/';
  assert.throws(
    () => assertValidJson(artifact, SCHEMAS.evidencePackage, 'Evidence package artifact'),
    /schema validation/iu,
  );
  artifact.entries[0]!.artifactPath = 'files/device./log';
  assert.throws(
    () => assertValidJson(artifact, SCHEMAS.evidencePackage, 'Evidence package artifact'),
    /schema validation/iu,
  );
});

test('rejects explicitly requested environment and key-extension paths without creating output', async (t: TestContext) => {
  const fixture = await setup(t);
  const request = fixture.request as { entries: Array<Record<string, unknown>> };
  request.entries.push({
    kind: 'other',
    sourcePath: '.env',
    artifactPath: 'files/environment.txt',
  });
  request.entries.push({
    kind: 'other',
    sourcePath: 'raw/signing.key',
    artifactPath: 'files/signing.key',
  });
  await assert.rejects(
    materializeEvidencePackage(request),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.code === 'rejected' &&
      error.rejections.filter((rejection) => rejection.code === 'sensitive-path').length === 2
    ),
  );
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('rejects private-key markers even when the file path is allowlisted', async (t: TestContext) => {
  const fixture = await setup(t);
  await fsp.writeFile(
    path.join(fixture.sourceRoot, 'raw', 'device.log'),
    '-----BEGIN PRIVATE KEY-----\nprivate\n',
    'utf8',
  );
  const request = fixture.request as { entries: Array<Record<string, unknown>> };
  request.entries = [{
    kind: 'log',
    sourcePath: 'raw/device.log',
    artifactPath: 'files/device.log',
  }];
  await assert.rejects(
    materializeEvidencePackage(request),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'secret-marker'
    ),
  );
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('rejects UTF-16 encrypted-private-key markers plus sensitive aliases', async (t: TestContext) => {
  const marker = await setup(t);
  await fsp.writeFile(
    path.join(marker.sourceRoot, 'raw', 'encoded.log'),
    Buffer.from('-----BEGIN ENCRYPTED PRIVATE KEY-----\nprivate\n', 'utf16le'),
  );
  const markerRequest = marker.request as { entries: Array<Record<string, unknown>> };
  markerRequest.entries = [{
    kind: 'log',
    sourcePath: 'raw/encoded.log',
    artifactPath: 'files/encoded.log',
  }];
  await assert.rejects(
    materializeEvidencePackage(markerRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections[0]?.code === 'secret-marker',
  );
  assert.equal(fs.existsSync(marker.outputDir), false);

  const alias = await setup(t);
  await fsp.writeFile(path.join(alias.sourceRoot, 'raw', '.key'), 'binary-key-placeholder', 'utf8');
  const aliasRequest = alias.request as { entries: Array<Record<string, unknown>> };
  aliasRequest.entries = [{
    kind: 'other',
    sourcePath: 'raw/.key',
    artifactPath: 'files/key.bin',
  }];
  await assert.rejects(
    materializeEvidencePackage(aliasRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections[0]?.code === 'sensitive-path',
  );
  assert.equal(fs.existsSync(alias.outputDir), false);
});

test('portable-folds compatibility spellings before sensitive path admission', async (t: TestContext) => {
  const fixture = await setup(t);
  const compatibilityKey = '\uFF0E\uFF4B\uFF45\uFF59';
  await fsp.writeFile(path.join(fixture.sourceRoot, 'raw', compatibilityKey), 'key-bytes', 'utf8');
  const request = fixture.request as { entries: Array<Record<string, unknown>> };
  request.entries = [{
    kind: 'other',
    sourcePath: `raw/${compatibilityKey}`,
    artifactPath: 'files/key.bin',
  }];

  await assert.rejects(
    materializeEvidencePackage(request),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections[0]?.code === 'sensitive-path',
  );
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('rejects portable artifact collisions and file-directory prefix conflicts', async (t: TestContext) => {
  const caseCollision = await setup(t);
  const caseRequest = caseCollision.request as { entries: Array<Record<string, unknown>> };
  caseRequest.entries = [
    { kind: 'recording', sourcePath: 'captures/journey.mov', artifactPath: 'files/Journey.mov' },
    { kind: 'uiTree', sourcePath: 'raw/ui-tree.json', artifactPath: 'files/journey.mov' },
  ];
  await assert.rejects(
    materializeEvidencePackage(caseRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections.some((entry) => entry.code === 'duplicate-artifact'),
  );
  assert.equal(fs.existsSync(caseCollision.outputDir), false);

  const prefixCollision = await setup(t);
  const prefixRequest = prefixCollision.request as { entries: Array<Record<string, unknown>> };
  prefixRequest.entries = [
    { kind: 'recording', sourcePath: 'captures/journey.mov', artifactPath: 'files/journey' },
    { kind: 'uiTree', sourcePath: 'raw/ui-tree.json', artifactPath: 'files/journey/tree.json' },
  ];
  await assert.rejects(
    materializeEvidencePackage(prefixRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections.some((entry) => entry.code === 'duplicate-artifact'),
  );
  assert.equal(fs.existsSync(prefixCollision.outputDir), false);
});

test('rejects missing and symlinked allowlist entries transactionally', async (t: TestContext) => {
  const missing = await setup(t);
  const missingRequest = missing.request as { entries: Array<Record<string, unknown>> };
  missingRequest.entries.push({
    kind: 'log',
    sourcePath: 'raw/missing.log',
    artifactPath: 'files/missing.log',
  });
  await assert.rejects(
    materializeEvidencePackage(missingRequest),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'missing')
    ),
  );
  assert.equal(fs.existsSync(missing.outputDir), false);

  const linked = await setup(t);
  const external = path.join(linked.tempDir, 'external.log');
  await fsp.writeFile(external, 'outside', 'utf8');
  await fsp.symlink(external, path.join(linked.sourceRoot, 'raw', 'linked.log'));
  const linkedRequest = linked.request as { entries: Array<Record<string, unknown>> };
  linkedRequest.entries = [{
    kind: 'log',
    sourcePath: 'raw/linked.log',
    artifactPath: 'files/linked.log',
  }];
  await assert.rejects(
    materializeEvidencePackage(linkedRequest),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'symlink'
    ),
  );
  assert.equal(fs.existsSync(linked.outputDir), false);

  const linkedParent = await setup(t);
  const externalDirectory = path.join(linkedParent.tempDir, 'external-directory');
  await fsp.mkdir(externalDirectory);
  await fsp.writeFile(path.join(externalDirectory, 'outside.log'), 'outside', 'utf8');
  await fsp.symlink(externalDirectory, path.join(linkedParent.sourceRoot, 'linked-directory'), 'dir');
  const linkedParentRequest = linkedParent.request as { entries: Array<Record<string, unknown>> };
  linkedParentRequest.entries = [{
    kind: 'log',
    sourcePath: 'linked-directory/outside.log',
    artifactPath: 'files/outside.log',
  }];
  await assert.rejects(
    materializeEvidencePackage(linkedParentRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections[0]?.code === 'symlink',
  );
  assert.equal(fs.existsSync(linkedParent.outputDir), false);
});

test('accepts a stable macOS normalization alias without weakening containment', async (t: TestContext) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS filesystem normalization proof');
    return;
  }
  const fixture = await setup(t);
  const decomposedName = 'caf\u0065\u0301.log';
  const composedName = 'caf\u00E9.log';
  await fsp.writeFile(path.join(fixture.sourceRoot, 'raw', decomposedName), 'normalized', 'utf8');
  const request = fixture.request as { entries: Array<Record<string, unknown>> };
  request.entries = [{
    kind: 'log',
    sourcePath: `raw/${composedName}`,
    artifactPath: 'files/normalized.log',
  }];

  const result = await materializeEvidencePackage(request);
  assert.equal(fs.readFileSync(path.join(result.outputDir, 'files', 'normalized.log'), 'utf8'), 'normalized');
});

test('rejects duplicate identities, traversal, output-in-source, and existing outputs', async (t: TestContext) => {
  const duplicate = await setup(t);
  const duplicateRequest = duplicate.request as { entries: Array<Record<string, unknown>> };
  duplicateRequest.entries.push({
    kind: 'other',
    sourcePath: 'captures/journey.mov',
    artifactPath: 'files/duplicate.mov',
  });
  await assert.rejects(
    materializeEvidencePackage(duplicateRequest),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'duplicate-source')
    ),
  );
  assert.equal(fs.existsSync(duplicate.outputDir), false);

  const traversal = await setup(t);
  const traversalRequest = traversal.request as { entries: Array<Record<string, unknown>> };
  traversalRequest.entries[0]!.sourcePath = '../outside';
  await assert.rejects(materializeEvidencePackage(traversalRequest), /schema validation/iu);
  assert.equal(fs.existsSync(traversal.outputDir), false);

  const nested = await setup(t);
  nested.request.outputDir = path.join(nested.sourceRoot, 'package');
  await assert.rejects(
    materializeEvidencePackage(nested.request),
    (error: unknown) => error instanceof EvidencePackageError && error.code === 'invalid-request',
  );
  assert.equal(fs.existsSync(path.join(nested.sourceRoot, 'package')), false);

  const existing = await setup(t);
  await fsp.mkdir(existing.outputDir);
  await fsp.writeFile(path.join(existing.outputDir, 'keep.txt'), 'keep', 'utf8');
  await assert.rejects(
    materializeEvidencePackage(existing.request),
    (error: unknown) => error instanceof EvidencePackageError && error.code === 'output-conflict',
  );
  assert.equal(fs.readFileSync(path.join(existing.outputDir, 'keep.txt'), 'utf8'), 'keep');

  const emptyExisting = await setup(t);
  await fsp.mkdir(emptyExisting.outputDir);
  await assert.rejects(
    materializeEvidencePackage(emptyExisting.request),
    (error: unknown) => error instanceof EvidencePackageError && error.code === 'output-conflict',
  );
  assert.deepEqual(await fsp.readdir(emptyExisting.outputDir), []);
});

test('rejects a missing output parent through a source alias without creating source directories', async (t: TestContext) => {
  const fixture = await setup(t);
  const sourceAlias = path.join(fixture.tempDir, 'source-alias');
  await fsp.symlink(fixture.sourceRoot, sourceAlias, 'dir');
  fixture.request.outputDir = path.join(sourceAlias, 'missing-parent', 'package');

  await assert.rejects(
    materializeEvidencePackage(fixture.request),
    (error: unknown) => error instanceof EvidencePackageError && error.code === 'invalid-request',
  );
  assert.equal(fs.existsSync(path.join(fixture.sourceRoot, 'missing-parent')), false);
});

test('does not replace an empty output directory that appears at publication time', async (t: TestContext) => {
  const fixture = await setup(t);
  const originalMkdirSync = fs.mkdirSync;
  const canonicalOutputDir = path.join(
    fs.realpathSync(path.dirname(fixture.outputDir)),
    path.basename(fixture.outputDir),
  );
  let injected = false;
  fs.mkdirSync = ((directory: Parameters<typeof fs.mkdirSync>[0], options?: Parameters<typeof fs.mkdirSync>[1]) => {
    if (path.resolve(String(directory)) === canonicalOutputDir && !injected) {
      injected = true;
      originalMkdirSync(canonicalOutputDir, { mode: 0o700 });
    }
    return originalMkdirSync(directory, options as never);
  }) as typeof fs.mkdirSync;
  try {
    await assert.rejects(
      materializeEvidencePackage(fixture.request),
      (error: unknown) => error instanceof EvidencePackageError && error.code === 'output-conflict',
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(injected, true);
  assert.deepEqual(await fsp.readdir(fixture.outputDir), []);
});

test('retains a complete package when post-publication staging cleanup fails', async (t: TestContext) => {
  const fixture = await setup(t);
  const originalRmSync = fs.rmSync;
  let cleanupAttempts = 0;
  fs.rmSync = ((target: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
    if (String(target).includes('.incomplete-')) {
      cleanupAttempts += 1;
      throw new Error('simulated staging cleanup failure');
    }
    return originalRmSync(target, options as never);
  }) as typeof fs.rmSync;
  const result = await (async () => {
    try {
      return await materializeEvidencePackage(fixture.request);
    } finally {
      fs.rmSync = originalRmSync;
    }
  })();

  assert.equal(cleanupAttempts, 1);
  assert.equal(fs.existsSync(result.manifestPath), true);
  assert.equal(fs.existsSync(result.checksumsPath), true);
  assert.equal(result.artifact.status, 'complete');
});

test('maps an unreadable or missing source root to invalid request', async (t: TestContext) => {
  const fixture = await setup(t);
  fixture.request.sourceRoot = path.join(fixture.tempDir, 'missing-source');
  await assert.rejects(
    materializeEvidencePackage(fixture.request),
    (error: unknown) => error instanceof EvidencePackageError && error.code === 'invalid-request',
  );
  assert.equal(fs.existsSync(fixture.outputDir), false);
});

test('rejects non-files artifact paths, control characters, empty files, and directories', async (t: TestContext) => {
  const outsideFiles = await setup(t);
  const outsideRequest = outsideFiles.request as { entries: Array<Record<string, unknown>> };
  outsideRequest.entries[0]!.artifactPath = 'evidence-package.json';
  await assert.rejects(materializeEvidencePackage(outsideRequest), /schema validation/iu);

  const control = await setup(t);
  const controlRequest = control.request as { entries: Array<Record<string, unknown>> };
  controlRequest.entries[0]!.artifactPath = 'files/bad\npath.json';
  await assert.rejects(materializeEvidencePackage(controlRequest), /schema validation/iu);

  const empty = await setup(t);
  await fsp.writeFile(path.join(empty.sourceRoot, 'raw', 'empty.log'), '', 'utf8');
  const emptyRequest = empty.request as { entries: Array<Record<string, unknown>> };
  emptyRequest.entries = [{ kind: 'log', sourcePath: 'raw/empty.log', artifactPath: 'files/empty.log' }];
  await assert.rejects(
    materializeEvidencePackage(emptyRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections[0]?.code === 'empty',
  );

  const directory = await setup(t);
  const directoryRequest = directory.request as { entries: Array<Record<string, unknown>> };
  directoryRequest.entries = [{ kind: 'other', sourcePath: 'raw', artifactPath: 'files/raw-directory' }];
  await assert.rejects(
    materializeEvidencePackage(directoryRequest),
    (error: unknown) => error instanceof EvidencePackageError && error.rejections[0]?.code === 'not-regular',
  );
});
