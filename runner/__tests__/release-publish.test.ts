const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  publishRelease,
  resolveReleaseProofPath,
  writeReleaseProof,
} = require('../../scripts/release-publish');

type FakeReleaseRepo = {
  binDir: string;
  commandLogPath: string;
  repoRoot: string;
  tempRoot: string;
};

async function writeExecutable(filePath: string, source: string): Promise<void> {
  await fsp.writeFile(filePath, source, { mode: 0o755 });
}

async function createFakeReleaseRepo(options: {
  npmVersionPresent: boolean;
  remoteTagPresent: boolean;
  localTagPresent?: boolean;
}): Promise<FakeReleaseRepo> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-release-publish-test-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const binDir = path.join(tempRoot, 'bin');
  const commandLogPath = path.join(tempRoot, 'commands.jsonl');
  const npmPublishedPath = path.join(tempRoot, 'npm-published');

  await fsp.mkdir(repoRoot, { recursive: true });
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({
      name: 'agent-scenario-loop',
      version: '0.1.13',
    }, null, 2),
  );
  await fsp.writeFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  if (options.npmVersionPresent) {
    await fsp.writeFile(npmPublishedPath, '0.1.13');
  }

  await writeExecutable(
    path.join(binDir, 'git'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ command: 'git', args }) + '\\n');
if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
  process.stdout.write('main\\n');
  process.exit(0);
}
if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  process.stdout.write('0123456789abcdef0123456789abcdef01234567\\n');
  process.exit(0);
}
if (args[0] === 'status' && args[1] === '--porcelain') {
  process.exit(0);
}
if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet') {
  process.exit(${options.localTagPresent ? 0 : 1});
}
if (args[0] === 'ls-remote' && args[1] === '--tags') {
  ${options.remoteTagPresent ? "process.stdout.write('abc123\\trefs/tags/v0.1.13\\n');" : ''}
  process.exit(0);
}
if (args[0] === 'tag' || args[0] === 'push') {
  process.exit(0);
}
process.stderr.write('unexpected git args: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );

  await writeExecutable(
    path.join(binDir, 'pnpm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ command: 'pnpm', args }) + '\\n');
if (args.length === 1 && args[0] === 'release:check') {
  process.exit(0);
}
if (args.length === 1 && (args[0] === 'clean' || args[0] === 'build')) {
  process.exit(0);
}
process.stderr.write('unexpected pnpm args: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );

  await writeExecutable(
    path.join(binDir, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify({ command: 'npm', args }) + '\\n');
if (args[0] === 'view') {
  if (fs.existsSync(${JSON.stringify(npmPublishedPath)})) {
    process.stdout.write(fs.readFileSync(${JSON.stringify(npmPublishedPath)}, 'utf8') + '\\n');
    process.exit(0);
  }
  process.exit(1);
}
if (args[0] === 'publish') {
  if (!args.includes('--ignore-scripts')) {
    process.stderr.write('publish would rerun prepublishOnly\\n');
    process.exit(1);
  }
  fs.writeFileSync(${JSON.stringify(npmPublishedPath)}, '0.1.13');
  process.exit(0);
}
process.stderr.write('unexpected npm args: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );

  return {
    binDir,
    commandLogPath,
    repoRoot,
    tempRoot,
  };
}

async function readCommandLog(logPath: string): Promise<Array<{ command: string; args: string[] }>> {
  const contents = await fsp.readFile(logPath, 'utf8');
  return contents.trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line));
}

async function withFakePath<T>(binDir: string, runTest: () => Promise<T>): Promise<T> {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
  try {
    return await runTest();
  } finally {
    process.env.PATH = oldPath;
  }
}

test('release publish records proof then uploads without rerunning npm lifecycle scripts', async () => {
  const repo = await createFakeReleaseRepo({
    npmVersionPresent: false,
    remoteTagPresent: false,
  });

  try {
    await withFakePath(repo.binDir, async () => {
      publishRelease({
        repoRoot: repo.repoRoot,
        resumeUpload: false,
      });
    });

    const log = await readCommandLog(repo.commandLogPath);
    assert.equal(log.some((entry) => entry.command === 'pnpm' && entry.args.join(' ') === 'release:check'), true);
    assert.equal(log.some((entry) => entry.command === 'pnpm' && entry.args.join(' ') === 'clean'), true);
    assert.equal(log.some((entry) => entry.command === 'pnpm' && entry.args.join(' ') === 'build'), true);
    assert.equal(
      log.some((entry) => entry.command === 'npm' && entry.args.join(' ') === 'publish --ignore-scripts --access public'),
      true,
    );
    assert.equal(log.some((entry) => entry.command === 'git' && entry.args.join(' ') === 'tag v0.1.13'), true);
    assert.equal(log.some((entry) => entry.command === 'git' && entry.args.join(' ') === 'push origin v0.1.13'), true);
    assert.equal(await fsp.stat(resolveReleaseProofPath(repo.repoRoot)).then(() => true), true);
  } finally {
    await fsp.rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test('resume upload reuses matching release proof and skips the release gate', async () => {
  const repo = await createFakeReleaseRepo({
    npmVersionPresent: false,
    remoteTagPresent: false,
  });

  try {
    await withFakePath(repo.binDir, async () => {
      writeReleaseProof({
        packageName: 'agent-scenario-loop',
        version: '0.1.13',
        repoRoot: repo.repoRoot,
      });
      await fsp.writeFile(repo.commandLogPath, '');
      publishRelease({
        repoRoot: repo.repoRoot,
        resumeUpload: true,
      });
    });

    const log = await readCommandLog(repo.commandLogPath);
    assert.equal(log.some((entry) => entry.command === 'pnpm' && entry.args.join(' ') === 'release:check'), false);
    assert.equal(log.some((entry) => entry.command === 'pnpm' && entry.args.join(' ') === 'clean'), true);
    assert.equal(log.some((entry) => entry.command === 'pnpm' && entry.args.join(' ') === 'build'), true);
    assert.equal(
      log.some((entry) => entry.command === 'npm' && entry.args.join(' ') === 'publish --ignore-scripts --access public'),
      true,
    );
  } finally {
    await fsp.rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test('resume upload refuses mismatched release proof before npm upload', async () => {
  const repo = await createFakeReleaseRepo({
    npmVersionPresent: false,
    remoteTagPresent: false,
  });

  try {
    await withFakePath(repo.binDir, async () => {
      await fsp.mkdir(path.dirname(resolveReleaseProofPath(repo.repoRoot)), { recursive: true });
      await fsp.writeFile(
        resolveReleaseProofPath(repo.repoRoot),
        JSON.stringify({
          schemaVersion: 1,
          packageName: 'agent-scenario-loop',
          version: '0.1.12',
          commit: '0123456789abcdef0123456789abcdef01234567',
          packageJsonSha256: 'not-current',
          pnpmLockSha256: null,
          releaseCheckCommand: 'pnpm release:check',
        }),
      );

      assert.throws(
        () => publishRelease({
          repoRoot: repo.repoRoot,
          resumeUpload: true,
        }),
        /release publish proof does not match current checkout/u,
      );
    });

    const log = await readCommandLog(repo.commandLogPath);
    assert.equal(log.some((entry) => entry.command === 'npm' && entry.args[0] === 'publish'), false);
  } finally {
    await fsp.rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test('published npm version resumes at tag synchronization', async () => {
  const repo = await createFakeReleaseRepo({
    npmVersionPresent: true,
    remoteTagPresent: false,
  });

  try {
    await withFakePath(repo.binDir, async () => {
      writeReleaseProof({
        packageName: 'agent-scenario-loop',
        version: '0.1.13',
        repoRoot: repo.repoRoot,
      });
      await fsp.writeFile(repo.commandLogPath, '');
      publishRelease({
        repoRoot: repo.repoRoot,
        resumeUpload: true,
      });
    });

    const log = await readCommandLog(repo.commandLogPath);
    assert.equal(log.some((entry) => entry.command === 'npm' && entry.args[0] === 'publish'), false);
    assert.equal(log.some((entry) => entry.command === 'git' && entry.args.join(' ') === 'push origin v0.1.13'), true);
  } finally {
    await fsp.rm(repo.tempRoot, { recursive: true, force: true });
  }
});

test('existing remote release tag skips tag push after npm sync', async () => {
  const repo = await createFakeReleaseRepo({
    npmVersionPresent: true,
    remoteTagPresent: true,
    localTagPresent: true,
  });

  try {
    await withFakePath(repo.binDir, async () => {
      writeReleaseProof({
        packageName: 'agent-scenario-loop',
        version: '0.1.13',
        repoRoot: repo.repoRoot,
      });
      await fsp.writeFile(repo.commandLogPath, '');
      publishRelease({
        repoRoot: repo.repoRoot,
        resumeUpload: true,
      });
    });

    const log = await readCommandLog(repo.commandLogPath);
    assert.equal(log.some((entry) => entry.command === 'git' && entry.args[0] === 'tag'), false);
    assert.equal(log.some((entry) => entry.command === 'git' && entry.args[0] === 'push'), false);
  } finally {
    await fsp.rm(repo.tempRoot, { recursive: true, force: true });
  }
});
