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
  verifyEvidencePackage,
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

async function usePortableRequest(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await fsp.writeFile(
    path.join(fixture.sourceRoot, 'raw', 'ui-tree.json'),
    JSON.stringify({ producerRoot: fixture.sourceRoot }),
    'utf8',
  );
  fixture.request.schemaVersion = '1.1.0';
  fixture.request.jsonPointers = [{
    sourcePath: 'raw/ui-tree.json',
    jsonPointer: '/producerRoot',
    role: 'host-local-provenance',
  }];
}

function resealEvidencePackageControlFiles(outputDir: string): void {
  const manifestPath = path.join(outputDir, 'evidence-package.json');
  const checksumsPath = path.join(outputDir, 'SHA256SUMS');
  const markerPath = path.join(outputDir, 'evidence-package.complete');
  const artifact = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const manifestText = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.writeFileSync(manifestPath, manifestText);
  fs.chmodSync(manifestPath, 0o600);
  const manifestDigest = crypto.createHash('sha256').update(manifestText).digest('hex');
  const markerText = `${manifestDigest}\n`;
  fs.writeFileSync(markerPath, markerText);
  fs.chmodSync(markerPath, 0o600);
  const checksumLines = fs.readFileSync(checksumsPath, 'utf8').trimEnd().split('\n');
  const nextLines = checksumLines.map((line: string) => {
    const separator = line.indexOf('  ');
    const relativePath = separator === -1 ? undefined : line.slice(separator + 2);
    if (relativePath === 'evidence-package.json') {
      return `${manifestDigest}  evidence-package.json`;
    }
    if (relativePath === 'evidence-package.complete') {
      const markerDigest = crypto.createHash('sha256').update(markerText).digest('hex');
      return `${markerDigest}  evidence-package.complete`;
    }
    return line;
  });
  fs.writeFileSync(checksumsPath, `${nextLines.join('\n')}\n`);
  fs.chmodSync(checksumsPath, 0o600);
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
  assert.equal('completionMarkerPath' in result.artifact, false);
  assert.equal(fs.existsSync(path.join(fixture.outputDir, 'evidence-package.complete')), false);
  assert.equal(verifyEvidencePackage(fixture.outputDir).status, 'complete');
});

test('schema 1.0.0 byte-copies JSON with absolute host paths and stays marker-free', async (t: TestContext) => {
  const fixture = await setup(t);
  const sourceBytes = JSON.stringify({ absolutePath: '/private/tmp/evidence.json' });
  await fsp.writeFile(
    path.join(fixture.sourceRoot, 'raw', 'ui-tree.json'),
    sourceBytes,
    'utf8',
  );

  const result = await materializeEvidencePackage(fixture.request);

  assert.equal(result.artifact.schemaVersion, '1.0.0');
  assert.equal(
    await fsp.readFile(path.join(fixture.outputDir, 'files', 'ui-tree.json'), 'utf8'),
    sourceBytes,
  );
  assert.equal('jsonPointers' in result.artifact, false);
  assert.equal('completionMarkerPath' in result.artifact, false);
  assert.equal(fs.existsSync(path.join(fixture.outputDir, 'evidence-package.complete')), false);
  assert.equal(verifyEvidencePackage(fixture.outputDir).status, 'complete');
});

test('schema 1.0.0 byte-copies non-JSON bytes at JSON artifact paths', async (t: TestContext) => {
  const fixture = await setup(t);
  const sourceBytes = '{not-json';
  await fsp.writeFile(
    path.join(fixture.sourceRoot, 'raw', 'ui-tree.json'),
    sourceBytes,
    'utf8',
  );

  const result = await materializeEvidencePackage(fixture.request);

  assert.equal(result.artifact.schemaVersion, '1.0.0');
  assert.equal(
    await fsp.readFile(path.join(fixture.outputDir, 'files', 'ui-tree.json'), 'utf8'),
    sourceBytes,
  );
  assert.equal('jsonPointers' in result.artifact, false);
  assert.equal('completionMarkerPath' in result.artifact, false);
  assert.equal(fs.existsSync(path.join(fixture.outputDir, 'evidence-package.complete')), false);
  assert.equal(verifyEvidencePackage(fixture.outputDir).status, 'complete');
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

test('materializes classified JSON references and verifies them after relocation', async (t: TestContext) => {
  const fixture = await setup(t);
  const targetPath = path.join(fixture.sourceRoot, 'raw', 'ui-tree.json');
  const reportPath = path.join(fixture.sourceRoot, 'raw', 'report.json');
  const producerRoot = path.join(fixture.tempDir, 'producer-root');
  await fsp.mkdir(producerRoot);
  const report = {
    artifact: targetPath,
    producerRoot,
  };
  await fsp.writeFile(reportPath, JSON.stringify(report), 'utf8');
  const originalReport = await fsp.readFile(reportPath);
  const request = fixture.request as Record<string, unknown> & {entries: Array<Record<string, unknown>>};
  request.schemaVersion = '1.1.0';
  request.entries.push({
    kind: 'summary',
    sourcePath: 'raw/report.json',
    artifactPath: 'files/report.json',
  });
  request.jsonPointers = [
    {
      sourcePath: 'raw/report.json',
      jsonPointer: '/artifact',
      role: 'artifact-reference',
      referencedSourcePath: 'raw/ui-tree.json',
    },
    {
      sourcePath: 'raw/report.json',
      jsonPointer: '/producerRoot',
      role: 'host-local-provenance',
    },
  ];

  const result = await materializeEvidencePackage(request);
  assert.deepEqual(await fsp.readFile(reportPath), originalReport);
  const artifact = result.artifact;
  assert.equal(artifact.schemaVersion, '1.1.0');
  if (artifact.schemaVersion !== '1.1.0') {
    throw new Error('expected evidence package schema 1.1.0');
  }
  assert.equal(artifact.completionMarkerPath, 'evidence-package.complete');
  assert.equal(mode(path.join(result.outputDir, artifact.completionMarkerPath)), 0o600);
  assert.equal(
    fs.readFileSync(path.join(result.outputDir, artifact.completionMarkerPath), 'utf8'),
    `${crypto.createHash('sha256').update(fs.readFileSync(result.manifestPath)).digest('hex')}\n`,
  );
  assert.deepEqual(artifact.jsonPointers, [
    {
      artifactPath: 'files/report.json',
      dereferenceable: true,
      jsonPointer: '/artifact',
      referencedArtifactPath: 'files/ui-tree.json',
      role: 'artifact-reference',
      value: 'files/ui-tree.json',
    },
    {
      artifactPath: 'files/report.json',
      dereferenceable: false,
      jsonPointer: '/producerRoot',
      role: 'host-local-provenance',
      value: producerRoot,
    },
  ]);
  const packagedReport = JSON.parse(await fsp.readFile(
    path.join(result.outputDir, 'files', 'report.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(packagedReport.artifact, 'files/ui-tree.json');
  assert.equal(packagedReport.producerRoot, producerRoot);

  const relocated = path.join(fixture.tempDir, 'relocated-package');
  await fsp.rm(fixture.sourceRoot, { recursive: true, force: true });
  await fsp.rm(producerRoot, { recursive: true, force: true });
  await fsp.rename(result.outputDir, relocated);
  const verification = verifyEvidencePackage(relocated);
  assert.equal(verification.status, 'complete');
  assert.equal(mode(path.join(relocated, 'evidence-package.complete')), 0o600);
  assert.equal(
    fs.readFileSync(path.join(relocated, 'evidence-package.complete'), 'utf8'),
    `${crypto.createHash('sha256').update(fs.readFileSync(path.join(relocated, 'evidence-package.json'))).digest('hex')}\n`,
  );
  assert.equal(verification.outputDir, fs.realpathSync(relocated));
  const relocatedReport = JSON.parse(
    await fsp.readFile(path.join(relocated, 'files', 'report.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(relocatedReport.artifact, 'files/ui-tree.json');
  assert.equal(relocatedReport.producerRoot, producerRoot);
  assert.equal((await fsp.stat(path.join(relocated, 'files', 'ui-tree.json'))).isFile(), true);
  if (verification.artifact.schemaVersion !== '1.1.0') {
    throw new Error('expected relocated evidence package schema 1.1.0');
  }
  assert.deepEqual(verification.artifact.jsonPointers[0], {
    artifactPath: 'files/report.json',
    dereferenceable: true,
    jsonPointer: '/artifact',
    referencedArtifactPath: 'files/ui-tree.json',
    role: 'artifact-reference',
    value: 'files/ui-tree.json',
  });
});

test('rejects unclassified absolute JSON paths across path families', async (t: TestContext) => {
  for (const [index, absolutePath] of [
    '/private/tmp/evidence.json',
    'C:\\temp\\evidence.json',
    '\\\\server\\share\\evidence.json',
  ].entries()) {
    const fixture = await setup(t);
    fixture.request.schemaVersion = '1.1.0';
    fixture.request.jsonPointers = [];
    fixture.request.outputDir = path.join(fixture.tempDir, `package-${index}`);
    await fsp.writeFile(
      path.join(fixture.sourceRoot, 'raw', 'ui-tree.json'),
      JSON.stringify({ absolutePath }),
      'utf8',
    );
    await assert.rejects(
      materializeEvidencePackage(fixture.request),
      (error: unknown) => (
        error instanceof EvidencePackageError &&
        error.rejections.some((rejection) => rejection.code === 'unclassified-absolute-path')
      ),
    );
    assert.equal(fs.existsSync(fixture.request.outputDir as string), false);
  }
});

test('keeps JSON pointer declarations isolated to schema version 1.1.0', async (t: TestContext) => {
  const legacy = await setup(t);
  (legacy.request as Record<string, unknown>).jsonPointers = [{
    sourcePath: 'raw/ui-tree.json',
    jsonPointer: '/path',
    role: 'host-local-provenance',
  }];
  await assert.rejects(materializeEvidencePackage(legacy.request), /schema validation/iu);

  const current = await setup(t);
  current.request.schemaVersion = '1.1.0';
  current.request.jsonPointers = [];
  const result = await materializeEvidencePackage(current.request);
  assert.equal(result.artifact.schemaVersion, '1.1.0');
  if (result.artifact.schemaVersion !== '1.1.0') {
    throw new Error('expected evidence package schema 1.1.0');
  }
  assert.equal(result.artifact.completionMarkerPath, 'evidence-package.complete');
  assert.deepEqual(result.artifact.jsonPointers, []);
  assert.equal(mode(path.join(current.outputDir, 'evidence-package.complete')), 0o600);
  assert.equal(verifyEvidencePackage(current.outputDir).status, 'complete');

  const missingPointers = await setup(t);
  missingPointers.request.schemaVersion = '1.1.0';
  await assert.rejects(
    materializeEvidencePackage(missingPointers.request),
    /schema validation/iu,
  );

  assert.throws(() => assertValidJson({
    schemaVersion: '1.1.0',
    packageId: 'package-1',
    runId: 'run-1',
    status: 'complete',
    sensitivityPolicy: 'allowlist-and-secret-marker-v1',
    fileCount: 1,
    totalByteSize: 1,
    checksumsPath: 'SHA256SUMS',
    completionMarkerPath: 'evidence-package.complete',
    entries: [{
      kind: 'summary',
      sourcePath: 'raw/report.json',
      artifactPath: 'files/report.json',
      byteSize: 1,
      sha256: '0'.repeat(64),
    }],
    jsonPointers: [{
      artifactPath: 'files/report.json',
      dereferenceable: false,
      jsonPointer: '/producerRoot',
      role: 'host-local-provenance',
      value: 'relative/path',
    }],
  }, SCHEMAS.evidencePackage, 'Evidence package artifact'), /schema validation/iu);
});

test('scans BOM-prefixed JSON and rejects classified invalid JSON', async (t: TestContext) => {
  const bom = await setup(t);
  bom.request.schemaVersion = '1.1.0';
  bom.request.jsonPointers = [];
  await fsp.writeFile(
    path.join(bom.sourceRoot, 'raw', 'ui-tree.json'),
    `\uFEFF${JSON.stringify({ path: '/private/tmp/hidden.json' })}`,
    'utf8',
  );
  await assert.rejects(
    materializeEvidencePackage(bom.request),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'unclassified-absolute-path'
    ),
  );

  const invalid = await setup(t);
  await fsp.writeFile(path.join(invalid.sourceRoot, 'raw', 'ui-tree.json'), '{not-json', 'utf8');
  invalid.request.schemaVersion = '1.1.0';
  (invalid.request as Record<string, unknown>).jsonPointers = [{
    sourcePath: 'raw/ui-tree.json',
    jsonPointer: '/path',
    role: 'host-local-provenance',
  }];
  await assert.rejects(
    materializeEvidencePackage(invalid.request),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'invalid-json'
    ),
  );
});

test('rejects invalid classified pointer targets without publishing', async (t: TestContext) => {
  const cases = [
    {
      report: { value: '/private/tmp/value' },
      pointer: { sourcePath: 'raw/report.json', jsonPointer: '/missing', role: 'host-local-provenance' },
      code: 'missing-pointer',
    },
    {
      report: { value: 42 },
      pointer: { sourcePath: 'raw/report.json', jsonPointer: '/value', role: 'host-local-provenance' },
      code: 'non-string-pointer',
    },
    {
      report: { value: '/private/tmp/not-requested' },
      pointer: {
        sourcePath: 'raw/report.json',
        jsonPointer: '/value',
        role: 'artifact-reference',
        referencedSourcePath: 'raw/not-requested.json',
      },
      code: 'missing-reference',
    },
    {
      report: { value: '\\Windows\\root-relative' },
      pointer: {
        sourcePath: 'raw/report.json',
        jsonPointer: '/value',
        role: 'host-local-provenance',
      },
      code: 'invalid-path',
    },
  ] as const;

  for (const [index, fixtureCase] of cases.entries()) {
    const fixture = await setup(t);
    fixture.request.outputDir = path.join(fixture.tempDir, `package-${index}`);
    await fsp.writeFile(
      path.join(fixture.sourceRoot, 'raw', 'report.json'),
      JSON.stringify(fixtureCase.report),
      'utf8',
    );
    const request = fixture.request as Record<string, unknown> & {entries: Array<Record<string, unknown>>};
    request.schemaVersion = '1.1.0';
    request.entries.push({ kind: 'summary', sourcePath: 'raw/report.json', artifactPath: 'files/report.json' });
    request.jsonPointers = [fixtureCase.pointer];
    await assert.rejects(
      materializeEvidencePackage(request),
      (error: unknown) => (
        error instanceof EvidencePackageError &&
        error.rejections.some((rejection) => rejection.code === fixtureCase.code)
      ),
    );
    assert.equal(fs.existsSync(fixture.request.outputDir as string), false);
  }

  const outsideRoot = await setup(t);
  const outsidePath = path.join(outsideRoot.tempDir, 'outside-reference.json');
  await fsp.writeFile(outsidePath, '{}', 'utf8');
  await fsp.writeFile(
    path.join(outsideRoot.sourceRoot, 'raw', 'report.json'),
    JSON.stringify({ value: outsidePath }),
    'utf8',
  );
  const outsideRequest = outsideRoot.request as Record<string, unknown> & {entries: Array<Record<string, unknown>>};
  outsideRequest.schemaVersion = '1.1.0';
  outsideRequest.entries.push({ kind: 'summary', sourcePath: 'raw/report.json', artifactPath: 'files/report.json' });
  outsideRequest.jsonPointers = [{
    sourcePath: 'raw/report.json',
    jsonPointer: '/value',
    role: 'artifact-reference',
    referencedSourcePath: 'raw/ui-tree.json',
  }];
  await assert.rejects(
    materializeEvidencePackage(outsideRequest),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'invalid-path')
    ),
  );
});

type TrackedFsEvent = {
  flags?: string;
  op: 'open' | 'fsync';
  path: string;
};

function canonicalOutputPath(outputDir: string): string {
  return path.join(fs.realpathSync(path.dirname(outputDir)), path.basename(outputDir));
}

function installTrackedFsync(failurePath: string, failure: Error): {
  events: TrackedFsEvent[];
  restore: () => void;
} {
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalFsyncSync = fs.fsyncSync;
  const fdToPath = new Map<number, string>();
  const events: TrackedFsEvent[] = [];
  let failed = false;

  fs.openSync = ((target: string, flags: string, mode?: number): number => {
    const fd = originalOpenSync(target, flags, mode);
    const resolved = path.resolve(target);
    fdToPath.set(fd, resolved);
    events.push({ op: 'open', path: resolved, flags });
    return fd;
  }) as typeof fs.openSync;
  fs.closeSync = ((fileDescriptor: number): void => {
    try {
      originalCloseSync(fileDescriptor);
    } finally {
      fdToPath.delete(fileDescriptor);
    }
  }) as typeof fs.closeSync;
  fs.fsyncSync = ((fileDescriptor: number): void => {
    const event = {
      op: 'fsync' as const,
      path: fdToPath.get(fileDescriptor) ?? `<fd:${fileDescriptor}>`,
    };
    events.push(event);
    if (!failed && event.path === failurePath) {
      failed = true;
      throw failure;
    }
    originalFsyncSync(fileDescriptor);
  }) as typeof fs.fsyncSync;

  return {
    events,
    restore: () => {
      fs.openSync = originalOpenSync;
      fs.closeSync = originalCloseSync;
      fs.fsyncSync = originalFsyncSync;
    },
  };
}

function publicationEventIndexes(events: TrackedFsEvent[], outputDir: string): {
  markerFsync: number;
  markerOpen: number;
  outputDirectoryFsync: number;
} {
  const canonicalOutput = canonicalOutputPath(outputDir);
  const markerPath = path.join(canonicalOutput, 'evidence-package.complete');
  return {
    markerFsync: events.findIndex((event) => event.op === 'fsync' && event.path === markerPath),
    markerOpen: events.findIndex((event) => (
      event.op === 'open' && event.path === markerPath && event.flags === 'wx'
    )),
    outputDirectoryFsync: events.findIndex((event) => (
      event.op === 'fsync' && event.path === canonicalOutput
    )),
  };
}

function assertSealedContentsFsyncBeforeMarker(events: TrackedFsEvent[], outputDir: string): void {
  const indexes = publicationEventIndexes(events, outputDir);
  const canonicalOutput = canonicalOutputPath(outputDir);
  assert.notEqual(indexes.markerOpen, -1);
  for (const relativePath of [
    'files/journey.mov',
    'files/nested/ui-tree.json',
    'evidence-package.json',
    'SHA256SUMS',
    'files/nested',
    'files',
  ]) {
    const fsyncIndex = events.findIndex((event) => (
      event.op === 'fsync' && event.path === path.join(canonicalOutput, relativePath)
    ));
    assert.notEqual(fsyncIndex, -1, `expected fsync for ${relativePath}`);
    assert.equal(fsyncIndex < indexes.markerOpen, true, `expected ${relativePath} fsync before marker create`);
  }
}

async function prepareNestedPortableRequest(
  fixture: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
  await usePortableRequest(fixture);
  const entries = fixture.request.entries;
  if (!Array.isArray(entries) || typeof entries[0] !== 'object' || entries[0] === null) {
    throw new Error('expected evidence package entries');
  }
  (entries[0] as Record<string, unknown>).artifactPath = 'files/nested/ui-tree.json';
}

test('completion-marker fsync failure preserves ordering, removes output, and permits retry', async (t: TestContext) => {
  const fixture = await setup(t);
  await prepareNestedPortableRequest(fixture);
  const failure = new Error('simulated completion-marker fsync interruption');
  const tracked = installTrackedFsync(
    path.join(canonicalOutputPath(fixture.outputDir), 'evidence-package.complete'),
    failure,
  );
  try {
    await assert.rejects(
      materializeEvidencePackage(fixture.request),
      (error: unknown) => error === failure,
    );
    assertSealedContentsFsyncBeforeMarker(tracked.events, fixture.outputDir);
    const indexes = publicationEventIndexes(tracked.events, fixture.outputDir);
    assert.notEqual(indexes.markerFsync, -1);
    assert.equal(indexes.markerOpen < indexes.markerFsync, true);
    assert.equal(indexes.outputDirectoryFsync, -1);
    assert.equal(fs.existsSync(fixture.outputDir), false);
  } finally {
    tracked.restore();
  }

  const result = await materializeEvidencePackage(fixture.request);
  assert.equal(verifyEvidencePackage(result.outputDir).status, 'complete');
});

test('final directory fsync failure removes output and permits a clean retry', async (t: TestContext) => {
  const fixture = await setup(t);
  await prepareNestedPortableRequest(fixture);
  const failure = new Error('simulated output-directory fsync interruption');
  const tracked = installTrackedFsync(canonicalOutputPath(fixture.outputDir), failure);
  try {
    await assert.rejects(
      materializeEvidencePackage(fixture.request),
      (error: unknown) => error === failure,
    );
    assertSealedContentsFsyncBeforeMarker(tracked.events, fixture.outputDir);
    const indexes = publicationEventIndexes(tracked.events, fixture.outputDir);
    assert.notEqual(indexes.markerFsync, -1);
    assert.notEqual(indexes.outputDirectoryFsync, -1);
    assert.equal(indexes.markerOpen < indexes.markerFsync, true);
    assert.equal(indexes.markerFsync < indexes.outputDirectoryFsync, true);
    assert.equal(fs.existsSync(fixture.outputDir), false);
  } finally {
    tracked.restore();
  }

  const result = await materializeEvidencePackage(fixture.request);
  assert.equal(verifyEvidencePackage(result.outputDir).status, 'complete');
});

test('verifier rejects crash-shaped output without its completion marker', async (t: TestContext) => {
  const fixture = await setup(t);
  await usePortableRequest(fixture);
  const result = await materializeEvidencePackage(fixture.request);
  const markerPath = path.join(result.outputDir, 'evidence-package.complete');
  const preserved = {
    checksums: fs.readFileSync(result.checksumsPath),
    manifest: fs.readFileSync(result.manifestPath),
    recording: fs.readFileSync(path.join(result.outputDir, 'files', 'journey.mov')),
    uiTree: fs.readFileSync(path.join(result.outputDir, 'files', 'ui-tree.json')),
  };
  await fsp.unlink(markerPath);

  assert.throws(
    () => verifyEvidencePackage(result.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => (
        rejection.code === 'checksum-mismatch' &&
        rejection.artifactPath === 'evidence-package.complete'
      ))
    ),
  );
  assert.equal(fs.existsSync(markerPath), false);
  assert.deepEqual(fs.readFileSync(result.checksumsPath), preserved.checksums);
  assert.deepEqual(fs.readFileSync(result.manifestPath), preserved.manifest);
  assert.deepEqual(fs.readFileSync(path.join(result.outputDir, 'files', 'journey.mov')), preserved.recording);
  assert.deepEqual(fs.readFileSync(path.join(result.outputDir, 'files', 'ui-tree.json')), preserved.uiTree);
});

test('verifier rejects completion-marker content drift', async (t: TestContext) => {
  const fixture = await setup(t);
  await usePortableRequest(fixture);
  const result = await materializeEvidencePackage(fixture.request);
  await fsp.writeFile(
    path.join(result.outputDir, 'evidence-package.complete'),
    `${'0'.repeat(64)}\n`,
    'utf8',
  );
  assert.throws(
    () => verifyEvidencePackage(result.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'checksum-mismatch')
    ),
  );
});

test('rejects duplicate and unbound JSON pointer declarations', async (t: TestContext) => {
  const duplicate = await setup(t);
  duplicate.request.schemaVersion = '1.1.0';
  (duplicate.request as Record<string, unknown>).jsonPointers = [
    { sourcePath: 'raw/ui-tree.json', jsonPointer: '/path', role: 'host-local-provenance' },
    { sourcePath: 'raw/ui-tree.json', jsonPointer: '/path', role: 'host-local-provenance' },
  ];
  await assert.rejects(
    materializeEvidencePackage(duplicate.request),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'invalid-pointer')
    ),
  );
  assert.equal(fs.existsSync(duplicate.outputDir), false);

  const unbound = await setup(t);
  unbound.request.schemaVersion = '1.1.0';
  (unbound.request as Record<string, unknown>).jsonPointers = [{
    sourcePath: 'raw/not-requested.json',
    jsonPointer: '/path',
    role: 'host-local-provenance',
  }];
  await assert.rejects(
    materializeEvidencePackage(unbound.request),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'missing-reference')
    ),
  );
  assert.equal(fs.existsSync(unbound.outputDir), false);
});

test('verifier rejects resealed duplicate JSON pointer records', async (t: TestContext) => {
  const fixture = await setup(t);
  const targetPath = path.join(fixture.sourceRoot, 'raw', 'ui-tree.json');
  const reportPath = path.join(fixture.sourceRoot, 'raw', 'report.json');
  const producerRoot = path.join(fixture.tempDir, 'producer-root');
  await fsp.mkdir(producerRoot);
  await fsp.writeFile(reportPath, JSON.stringify({ artifact: targetPath, producerRoot }), 'utf8');
  const request = fixture.request as Record<string, unknown> & {entries: Array<Record<string, unknown>>};
  request.schemaVersion = '1.1.0';
  request.entries.push({
    kind: 'summary',
    sourcePath: 'raw/report.json',
    artifactPath: 'files/report.json',
  });
  request.jsonPointers = [{
    sourcePath: 'raw/report.json',
    jsonPointer: '/artifact',
    role: 'artifact-reference',
    referencedSourcePath: 'raw/ui-tree.json',
  }, {
    sourcePath: 'raw/report.json',
    jsonPointer: '/producerRoot',
    role: 'host-local-provenance',
  }];
  const result = await materializeEvidencePackage(request);
  const artifact = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')) as Record<string, unknown>;
  const pointers = artifact.jsonPointers;
  if (!Array.isArray(pointers) || pointers[0] === undefined) {
    throw new Error('expected jsonPointers on 1.1.0 evidence package');
  }
  artifact.jsonPointers = [...pointers, pointers[0]];
  fs.writeFileSync(result.manifestPath, `${JSON.stringify(artifact, null, 2)}\n`);
  resealEvidencePackageControlFiles(result.outputDir);

  assert.throws(
    () => verifyEvidencePackage(result.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections.some((rejection) => rejection.code === 'invalid-pointer')
    ),
  );
});

test('verifier rejects missing seals and post-copy drift', async (t: TestContext) => {
  const missingManifest = await setup(t);
  const first = await materializeEvidencePackage(missingManifest.request);
  await fsp.unlink(first.manifestPath);
  assert.throws(
    () => verifyEvidencePackage(first.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'missing-manifest'
    ),
  );

  const missingChecksums = await setup(t);
  missingChecksums.request.outputDir = path.join(missingChecksums.tempDir, 'package-checksums');
  const second = await materializeEvidencePackage(missingChecksums.request);
  await fsp.unlink(second.checksumsPath);
  assert.throws(
    () => verifyEvidencePackage(second.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'checksum-mismatch'
    ),
  );

  const drift = await setup(t);
  drift.request.outputDir = path.join(drift.tempDir, 'package-drift');
  const third = await materializeEvidencePackage(drift.request);
  await fsp.writeFile(path.join(third.outputDir, 'files', 'ui-tree.json'), '{"nodes":["changed"]}', 'utf8');
  assert.throws(
    () => verifyEvidencePackage(third.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'checksum-mismatch'
    ),
  );

  const extra = await setup(t);
  extra.request.outputDir = path.join(extra.tempDir, 'package-extra');
  const fourth = await materializeEvidencePackage(extra.request);
  await fsp.writeFile(path.join(fourth.outputDir, 'unsealed.txt'), 'unsealed', 'utf8');
  assert.throws(
    () => verifyEvidencePackage(fourth.outputDir),
    (error: unknown) => (
      error instanceof EvidencePackageError &&
      error.rejections[0]?.code === 'checksum-mismatch'
    ),
  );
});

test('rejects staged digest drift and removes incomplete output transactionally', async (t: TestContext) => {
  const fixture = await setup(t);
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = ((
    filePath: Parameters<typeof fs.writeFileSync>[0],
    data: Parameters<typeof fs.writeFileSync>[1],
    options?: Parameters<typeof fs.writeFileSync>[2],
  ) => {
    originalWriteFileSync(filePath, data, options as never);
    if (
      !injected &&
      String(filePath).includes('.incomplete-') &&
      String(filePath).endsWith('files/ui-tree.json')
    ) {
      injected = true;
      originalWriteFileSync(filePath, '{"nodes":["drift"]}', { mode: 0o600 });
    }
  }) as typeof fs.writeFileSync;
  try {
    await assert.rejects(
      materializeEvidencePackage(fixture.request),
      (error: unknown) => (
        error instanceof EvidencePackageError &&
        error.rejections[0]?.code === 'changed-during-read'
      ),
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(injected, true);
  assert.equal(fs.existsSync(fixture.outputDir), false);
  assert.equal(
    (await fsp.readdir(fixture.tempDir)).some((entry: string) => entry.includes('.incomplete-')),
    false,
  );
});
