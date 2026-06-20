const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const PACKAGE_VERSION = require(path.join(ROOT, 'package.json')).version;
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/gu;

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeFakeBin(binDir: string, name: string, body: string): Promise<void> {
  const filePath = path.join(binDir, name);
  await fsp.writeFile(filePath, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
}

async function createDownstreamApp(root: string): Promise<void> {
  await fsp.mkdir(root, { recursive: true });
  writeJson(path.join(root, 'package.json'), {
    dependencies: {
      'agent-scenario-loop': '0.1.2',
    },
    name: 'downstream-app',
  });
  await fsp.writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
}

async function createFakeTools(binDir: string, logPath: string): Promise<void> {
  await fsp.mkdir(binDir, { recursive: true });
  await writeFakeBin(binDir, 'git', `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, \`git \${args.join(' ')}\\n\`);
if (args.join(' ') === 'branch --show-current') {
  process.stdout.write('adoption-branch\\n');
  process.exit(0);
}
if (args[0] === 'status') {
  process.exit(0);
}
process.stderr.write(\`unexpected git args: \${args.join(' ')}\\n\`);
process.exit(1);
`);
  await writeFakeBin(binDir, 'npm', `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, \`npm \${args.join(' ')} cache=\${process.env.npm_config_cache || ''} logs=\${process.env.npm_config_logs_dir || ''}\\n\`);
const destination = args[args.indexOf('--pack-destination') + 1];
if (!destination) {
  process.stderr.write('missing pack destination\\n');
  process.exit(1);
}
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, ${JSON.stringify(`agent-scenario-loop-${PACKAGE_VERSION}.tgz`)}), 'fake tarball');
process.stdout.write(${JSON.stringify(`agent-scenario-loop-${PACKAGE_VERSION}.tgz\n`)});
`);
  await writeFakeBin(binDir, 'pnpm', `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, \`pnpm \${args.join(' ')}\\n\`);
if (args[0] !== 'add') {
  process.stderr.write(\`unexpected pnpm args: \${args.join(' ')}\\n\`);
  process.exit(1);
}
const packagePath = path.join(process.cwd(), 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.dependencies = {
  ...(packageJson.dependencies || {}),
  'agent-scenario-loop': args[1],
};
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\\n');
fs.writeFileSync(path.join(process.cwd(), 'pnpm-lock.yaml'), 'temporary local tarball lock\\n');
const installedRoot = path.join(process.cwd(), 'node_modules', 'agent-scenario-loop');
fs.mkdirSync(installedRoot, { recursive: true });
fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({
  name: 'agent-scenario-loop',
  version: ${JSON.stringify(PACKAGE_VERSION)},
}) + '\\n');
`);
}

test('downstream local-package gate restores dependency files after command failure', async (t: any) => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-downstream-gate-test-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });
  const appRoot = path.join(tempRoot, 'app');
  const binDir = path.join(tempRoot, 'bin');
  const packDir = path.join(tempRoot, 'pack');
  const logPath = path.join(tempRoot, 'commands.log');
  await createDownstreamApp(appRoot);
  await createFakeTools(binDir, logPath);

  const originalPackage = await fsp.readFile(path.join(appRoot, 'package.json'), 'utf8');
  const originalLock = await fsp.readFile(path.join(appRoot, 'pnpm-lock.yaml'), 'utf8');
  let failure: { status?: number; stderr?: Buffer; stdout?: Buffer } | null = null;
  try {
    execFileSync(process.execPath, [
      path.join(DIST_ROOT, 'scripts', 'downstream-local-package-gate.js'),
      '--app-root',
      appRoot,
      '--expected-branch',
      'adoption-branch',
      '--pack-dir',
      packDir,
      '--command-json',
      JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
      '--command-json',
      JSON.stringify([process.execPath, '-e', 'process.exit(7)']),
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        ASL_DOWNSTREAM_GATE_TIMEOUT_MS: '30000',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: 'pipe',
    });
  } catch (error) {
    failure = error as { status?: number; stderr?: Buffer; stdout?: Buffer };
  }
  if (!failure) {
    throw new Error('downstream gate should fail on the second validation command');
  }
  assert.equal(failure.status, 1);
  assert.match((failure.stderr?.toString() ?? '').replace(ANSI_PATTERN, ''), /status: 7/u);

  assert.equal(await fsp.readFile(path.join(appRoot, 'package.json'), 'utf8'), originalPackage);
  assert.equal(await fsp.readFile(path.join(appRoot, 'pnpm-lock.yaml'), 'utf8'), originalLock);
  const log = await fsp.readFile(logPath, 'utf8');
  assert.match(log, /git branch --show-current/u);
  assert.match(log, /git status --porcelain -- package\.json pnpm-lock\.yaml/u);
  assert.match(log, /npm pack --pack-destination/u);
  assert.match(log, /cache=.*\.npm\/cache/u);
  assert.match(log, /logs=.*\.npm\/logs/u);
  assert.match(log, new RegExp(`pnpm add .*agent-scenario-loop-${PACKAGE_VERSION.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.tgz`, 'u'));
});
