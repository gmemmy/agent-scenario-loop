const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  packReleasePackage,
  resolveCommandTimeoutMs,
  resolveNestedGateTimeoutMs,
} = require('../../scripts/release-check');

async function writeFakeNpm(binDir: string, logPath: string, tarballName: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.writeFile(
    path.join(binDir, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, args.join('\\n') + '\\n');
const destinationIndex = args.indexOf('--pack-destination');
if (destinationIndex === -1 || !args[destinationIndex + 1]) {
  process.stderr.write('missing pack destination\\n');
  process.exit(1);
}
fs.mkdirSync(args[destinationIndex + 1], { recursive: true });
fs.writeFileSync(path.join(args[destinationIndex + 1], ${JSON.stringify(tarballName)}), 'fake tarball');
process.stdout.write(${JSON.stringify(`${tarballName}\n`)});
`,
    { mode: 0o755 },
  );
}

test('packReleasePackage skips lifecycle scripts when packing a release tarball', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-release-check-test-'));
  const binDir = path.join(tempRoot, 'bin');
  const logPath = path.join(tempRoot, 'npm-args.log');
  const packDir = path.join(tempRoot, 'pack');
  const tarballName = 'agent-scenario-loop-0.1.8.tgz';
  await writeFakeNpm(binDir, logPath, tarballName);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  try {
    const tarballPath = packReleasePackage({
      env,
      packageRoot: tempRoot,
      packDir,
    });
    const args = (await fsp.readFile(logPath, 'utf8')).trim().split('\n');

    assert.equal(tarballPath, path.join(packDir, tarballName));
    assert.deepEqual(args, ['pack', '--ignore-scripts', '--pack-destination', packDir]);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('nested package gates get a wider parent timeout than single release commands', () => {
  const env = {
    ...process.env,
    ASL_PACKAGE_GATE_TIMEOUT_MS: '2000',
  };

  assert.equal(resolveCommandTimeoutMs(env), 2000);
  assert.equal(resolveNestedGateTimeoutMs(env), 10_000);
});
