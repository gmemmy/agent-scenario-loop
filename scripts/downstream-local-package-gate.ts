#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

type CliOptions = {
  appRoot: string;
  commands: string[][];
  expectedBranch?: string;
  keepInstall: boolean;
  packDir?: string;
};

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

const DEFAULT_TIMEOUT_MS = 300_000;
const RESTORE_FILES = ['package.json', 'pnpm-lock.yaml'];

/**
 * Returns the per-command timeout for downstream release gates.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const timeoutMs = Number.parseInt(env.ASL_DOWNSTREAM_GATE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

/**
 * Runs one command with inherited output so downstream gates preserve evidence.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {string}
 */
function run(command: string, args: string[], options: RunOptions): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: resolveTimeoutMs(options.env),
  });
}

/**
 * Runs one command while streaming its stdout and stderr.
 *
 * @param {string[]} argv
 * @param {RunOptions} options
 * @returns {void}
 */
function runGateCommand(argv: string[], options: RunOptions): void {
  assert.ok(argv.length > 0, 'downstream command arrays must not be empty');
  execFileSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
    timeout: resolveTimeoutMs(options.env),
  });
}

/**
 * Parses CLI options.
 *
 * @param {string[]} argv
 * @returns {CliOptions}
 */
function parseArgs(argv: string[]): CliOptions {
  const commands: string[][] = [];
  let appRoot = process.env.ASL_DOWNSTREAM_APP_ROOT ?? '';
  let expectedBranch = process.env.ASL_DOWNSTREAM_EXPECTED_BRANCH;
  let keepInstall = process.env.ASL_DOWNSTREAM_KEEP_INSTALL === '1';
  let packDir = process.env.ASL_DOWNSTREAM_PACK_DIR;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    } else if (arg === '--app-root') {
      appRoot = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--expected-branch') {
      expectedBranch = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--command-json') {
      const parsed = JSON.parse(argv[index + 1] ?? 'null');
      assert.ok(Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'), '--command-json must be a JSON string array');
      commands.push(parsed);
      index += 1;
    } else if (arg === '--commands-json') {
      const parsed = JSON.parse(argv[index + 1] ?? 'null');
      assert.ok(
        Array.isArray(parsed) &&
          parsed.every((entry) => Array.isArray(entry) && entry.every((part) => typeof part === 'string')),
        '--commands-json must be a JSON array of string arrays',
      );
      commands.push(...parsed);
      index += 1;
    } else if (arg === '--keep-install') {
      keepInstall = true;
    } else if (arg === '--pack-dir') {
      packDir = argv[index + 1] ?? '';
      index += 1;
    } else if (arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (process.env.ASL_DOWNSTREAM_COMMANDS_JSON) {
    const parsed = JSON.parse(process.env.ASL_DOWNSTREAM_COMMANDS_JSON);
    assert.ok(
      Array.isArray(parsed) &&
        parsed.every((entry) => Array.isArray(entry) && entry.every((part) => typeof part === 'string')),
      'ASL_DOWNSTREAM_COMMANDS_JSON must be a JSON array of string arrays',
    );
    commands.push(...parsed);
  }

  assert.ok(appRoot, 'Provide --app-root or ASL_DOWNSTREAM_APP_ROOT.');
  assert.ok(commands.length > 0, 'Provide at least one --command-json, --commands-json, or ASL_DOWNSTREAM_COMMANDS_JSON entry.');

  return {
    appRoot: path.resolve(appRoot),
    commands,
    ...(expectedBranch ? { expectedBranch } : {}),
    keepInstall,
    ...(packDir ? { packDir: path.resolve(packDir) } : {}),
  };
}

function printUsage(): void {
  process.stdout.write([
    'Usage: pnpm downstream:local-package -- --app-root <path> --command-json \'["pnpm","run","asl:validate"]\'',
    '',
    'Options:',
    '  --app-root <path>              Downstream app worktree to validate.',
    '  --expected-branch <branch>     Fail if the downstream worktree is on another branch.',
    '  --command-json <json-array>    Command argv to run after installing the local tarball. Repeatable.',
    '  --commands-json <json-array>   JSON array of command argv arrays.',
    '  --keep-install                 Leave package.json/pnpm-lock.yaml as modified validation state.',
    '  --pack-dir <path>              Directory for npm pack output. Defaults to a temp directory.',
    '',
  ].join('\n'));
}

/**
 * Packs this repository and returns the tarball path.
 *
 * @param {{env: NodeJS.ProcessEnv; packageRoot: string; packDir: string}} options
 * @returns {string}
 */
function packLocalPackage({
  env,
  packageRoot,
  packDir,
}: {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  packDir: string;
}): string {
  fs.mkdirSync(packDir, { recursive: true });
  const npmStateDir = path.join(packDir, '.npm');
  fs.mkdirSync(npmStateDir, { recursive: true });
  const packOutput = run('npm', ['pack', '--pack-destination', packDir], {
    cwd: packageRoot,
    env: {
      ...env,
      npm_config_cache: path.join(npmStateDir, 'cache'),
      npm_config_logs_dir: path.join(npmStateDir, 'logs'),
    },
  });
  const tarballName = packOutput.trim().split(/\n/u).pop();
  assert.ok(tarballName, 'npm pack did not print a tarball name');
  const tarballPath = path.join(packDir, tarballName);
  assert.equal(fs.existsSync(tarballPath), true, `missing packed tarball: ${tarballPath}`);
  return tarballPath;
}

/**
 * Reads the current git branch for a worktree.
 *
 * @param {string} appRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function readGitBranch(appRoot: string, env: NodeJS.ProcessEnv): string {
  return run('git', ['branch', '--show-current'], { cwd: appRoot, env }).trim();
}

/**
 * Fails when dependency files already have local changes.
 *
 * @param {string} appRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {void}
 */
function assertDependencyFilesClean(appRoot: string, env: NodeJS.ProcessEnv): void {
  const status = run('git', ['status', '--porcelain', '--', ...RESTORE_FILES], {
    cwd: appRoot,
    env,
  }).trim();
  assert.equal(
    status,
    '',
    `downstream dependency files are already dirty; preserve or commit them before running this gate:\n${status}`,
  );
}

/**
 * Captures dependency files so the temporary tarball install can be restored.
 *
 * @param {string} appRoot
 * @returns {Map<string, string | null>}
 */
function snapshotRestoreFiles(appRoot: string): Map<string, string | null> {
  const snapshots = new Map<string, string | null>();
  for (const relativePath of RESTORE_FILES) {
    const filePath = path.join(appRoot, relativePath);
    snapshots.set(relativePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);
  }
  return snapshots;
}

/**
 * Restores dependency files after a temporary tarball install.
 *
 * @param {string} appRoot
 * @param {Map<string, string | null>} snapshots
 * @returns {void}
 */
function restoreFiles(appRoot: string, snapshots: Map<string, string | null>): void {
  for (const [relativePath, content] of snapshots.entries()) {
    const filePath = path.join(appRoot, relativePath);
    if (content === null) {
      fs.rmSync(filePath, { force: true });
    } else {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
}

/**
 * Runs the downstream local-package gate.
 *
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const options = parseArgs(process.argv.slice(2));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };

  assert.equal(fs.existsSync(path.join(options.appRoot, 'package.json')), true, `missing downstream package.json at ${options.appRoot}`);
  if (options.expectedBranch) {
    assert.equal(readGitBranch(options.appRoot, env), options.expectedBranch);
  }
  assertDependencyFilesClean(options.appRoot, env);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const packDir = options.packDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'asl-downstream-pack-'));
  const tarballPath = packLocalPackage({ env, packageRoot: repoRoot, packDir });
  const snapshots = snapshotRestoreFiles(options.appRoot);

  try {
    runGateCommand(['pnpm', 'add', tarballPath], { cwd: options.appRoot, env });
    const installedPackageJsonPath = path.join(options.appRoot, 'node_modules', 'agent-scenario-loop', 'package.json');
    assert.equal(fs.existsSync(installedPackageJsonPath), true, 'local package install did not create node_modules/agent-scenario-loop/package.json');
    const installedPackageJson = JSON.parse(fs.readFileSync(installedPackageJsonPath, 'utf8'));
    assert.equal(installedPackageJson.name, 'agent-scenario-loop');
    assert.equal(installedPackageJson.version, packageJson.version);

    for (const command of options.commands) {
      runGateCommand(command, { cwd: options.appRoot, env });
    }

    process.stdout.write([
      `downstream local-package gate passed: ${options.appRoot}`,
      `candidate tarball: ${tarballPath}`,
      `installed version: ${installedPackageJson.version}`,
      '',
    ].join('\n'));
  } finally {
    if (!options.keepInstall) {
      restoreFiles(options.appRoot, snapshots);
      process.stdout.write('downstream dependency files restored; run the app package manager if node_modules needs a clean registry install.\n');
    }
  }
}

main();
