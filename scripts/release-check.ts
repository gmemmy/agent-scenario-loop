#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

/**
 * Writes a stable release-gate phase marker before a child command runs.
 *
 * @param {string} phase
 * @returns {void}
 */
function announcePhase(phase: string): void {
  process.stdout.write(`release check phase: ${phase}\n`);
}

/**
 * Creates a clean npm environment for repeatable release gates.
 *
 * @param {string} tempRoot
 * @returns {NodeJS.ProcessEnv}
 */
function createReleaseEnv(tempRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) {
      delete env[key];
    }
  }

  env.npm_config_audit = 'false';
  env.npm_config_cache = path.join(tempRoot, 'npm-cache');
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  return env;
}

/**
 * Resolves the per-command timeout for release gate child processes.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolveCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const timeoutMs = Number.parseInt(env.ASL_PACKAGE_GATE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS;
}

/**
 * Runs a release command with inherited output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {void}
 */
function run(command: string, args: string[], options: RunOptions): void {
  execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    timeout: resolveCommandTimeoutMs(options.env),
  });
}

/**
 * Packs the package once for downstream release gates.
 *
 * @param {{env: NodeJS.ProcessEnv, packageRoot: string, packDir: string}} options
 * @returns {string}
 */
function packReleasePackage({
  env,
  packageRoot,
  packDir,
}: {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  packDir: string;
}): string {
  fs.mkdirSync(packDir, { recursive: true });
  const packOutput = execFileSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: packageRoot,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: resolveCommandTimeoutMs(env),
  });
  const tarballName = packOutput.trim().split(/\n/u).pop();
  assert.ok(tarballName, 'npm pack did not print a tarball name');
  const tarballPath = path.join(packDir, tarballName);
  assert.equal(fs.existsSync(tarballPath), true, `missing packed tarball: ${tarballPath}`);
  return tarballPath;
}

/**
 * Runs the full release check while reusing one package tarball for install
 * smoke and consumer rehearsal.
 *
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-release-check-'));
  const env = createReleaseEnv(tempRoot);

  try {
    announcePhase('test');
    run('pnpm', ['test'], { cwd: repoRoot, env });
    announcePhase('release-readiness');
    run(process.execPath, [path.join(repoRoot, 'dist', 'scripts', 'release-readiness.js')], { cwd: repoRoot, env });

    announcePhase('pack');
    const tarballPath = packReleasePackage({
      env,
      packageRoot: repoRoot,
      packDir: path.join(tempRoot, 'pack'),
    });
    const gateEnv = {
      ...env,
      ASL_PACKAGE_TARBALL: tarballPath,
    };

    announcePhase('package-smoke');
    run(process.execPath, [path.join(repoRoot, 'dist', 'scripts', 'package-smoke.js')], { cwd: repoRoot, env: gateEnv });
    announcePhase('consumer-rehearsal');
    run(process.execPath, [path.join(repoRoot, 'dist', 'scripts', 'consumer-rehearsal.js')], { cwd: repoRoot, env: gateEnv });
    process.stdout.write(`release check passed: ${tarballPath}\n`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    console.error(`release check temp kept at: ${tempRoot}`);
    throw error;
  }
}

if (require.main === module) {
  main();
}

export {
  createReleaseEnv,
  main,
  packReleasePackage,
  resolveCommandTimeoutMs,
  run,
};
