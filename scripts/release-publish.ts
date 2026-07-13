#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

type CommandResult = {
  status: 'passed' | 'failed';
  stdout: string;
};

type ReleasePublishArgs = {
  resumeUpload: boolean;
};

type ReleaseProof = {
  schemaVersion: 1;
  packageName: string;
  version: string;
  commit: string;
  packageJsonSha256: string;
  pnpmLockSha256: string | null;
  releaseCheckCommand: 'pnpm release:check';
};

type ReleaseProofMismatch = {
  field: keyof ReleaseProof;
  expected: string | number | null;
  actual: string | number | null;
};

/**
 * Prints a stable phase marker before a release operation.
 *
 * @param {string} phase
 * @returns {void}
 */
function announcePhase(phase: string): void {
  process.stdout.write(`release publish phase: ${phase}\n`);
}

/**
 * Parses release publish coordinator flags.
 *
 * @param {string[]} args
 * @returns {ReleasePublishArgs}
 */
function parseArgs(args: string[]): ReleasePublishArgs {
  const parsed: ReleasePublishArgs = {
    resumeUpload: false,
  };

  for (const arg of args) {
    switch (arg) {
      case '--':
        break;
      case '--resume-upload':
        parsed.resumeUpload = true;
        break;
      default:
        throw new Error(`unknown release:publish argument: ${arg}`);
    }
  }

  return parsed;
}

/**
 * Reads package metadata from the repository root.
 *
 * @param {string} repoRoot
 * @returns {Record<string, unknown>}
 */
function readPackageJson(repoRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Runs a command and returns trimmed stdout.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function readCommand(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

/**
 * Hashes a required file that contributes to release proof identity.
 *
 * @param {string} filePath
 * @returns {string}
 */
function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Hashes an optional file that contributes to release proof identity.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function hashFileOrNull(filePath: string): string | null {
  return fs.existsSync(filePath) ? hashFile(filePath) : null;
}

/**
 * Runs a command and captures whether it succeeded.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {CommandResult}
 */
function tryCommand(command: string, args: string[], cwd: string): CommandResult {
  try {
    return {
      status: 'passed',
      stdout: readCommand(command, args, cwd),
    };
  } catch {
    return {
      status: 'failed',
      stdout: '',
    };
  }
}

/**
 * Runs a command with inherited output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {void}
 */
function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
  });
}

/**
 * Runs the full release proof gate before coordinator-managed upload.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function runReleaseCheck(repoRoot: string): void {
  announcePhase('release-check');
  run('pnpm', ['release:check'], repoRoot);
}

/**
 * Rebuilds the package immediately before script-skipped npm upload.
 *
 * `npm publish --ignore-scripts` intentionally avoids rerunning
 * prepublishOnly after release proof has passed, so the coordinator must own
 * the prepack-equivalent clean/build step explicitly.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function preparePackageForPublish(repoRoot: string): void {
  announcePhase('publish-build');
  run('pnpm', ['clean'], repoRoot);
  run('pnpm', ['build'], repoRoot);
}

/**
 * Resolves and validates the package version used for both npm and git tags.
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {string}
 */
function resolvePackageVersion(packageJson: Record<string, unknown>): string {
  const version = packageJson.version;
  if (typeof version !== 'string') {
    throw new Error('package.json version must be a string');
  }
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'release:publish only supports stable semver package versions');
  return version;
}

/**
 * Ensures release tagging happens from a clean main checkout.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function assertReleaseCheckout(repoRoot: string): void {
  const branch = readCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  assert.equal(branch, 'main', 'release:publish must run from main');

  const status = readCommand('git', ['status', '--porcelain'], repoRoot);
  assert.equal(status, '', 'release:publish requires a clean worktree');
}

/**
 * Resolves the local ignored cache path for release proof state.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function resolveReleaseProofPath(repoRoot: string): string {
  return path.join(repoRoot, 'node_modules', '.cache', 'agent-scenario-loop', 'release-publish-proof.json');
}

/**
 * Builds the release proof expected for the current checkout.
 *
 * @param {{packageName: string, version: string, repoRoot: string}} options
 * @returns {ReleaseProof}
 */
function buildCurrentReleaseProof({
  packageName,
  version,
  repoRoot,
}: {
  packageName: string;
  version: string;
  repoRoot: string;
}): ReleaseProof {
  return {
    schemaVersion: 1,
    packageName,
    version,
    commit: readCommand('git', ['rev-parse', 'HEAD'], repoRoot),
    packageJsonSha256: hashFile(path.join(repoRoot, 'package.json')),
    pnpmLockSha256: hashFileOrNull(path.join(repoRoot, 'pnpm-lock.yaml')),
    releaseCheckCommand: 'pnpm release:check',
  };
}

/**
 * Writes local release proof only after the full gate passes.
 *
 * @param {{packageName: string, version: string, repoRoot: string}} options
 * @returns {string}
 */
function writeReleaseProof({
  packageName,
  version,
  repoRoot,
}: {
  packageName: string;
  version: string;
  repoRoot: string;
}): string {
  const proofPath = resolveReleaseProofPath(repoRoot);
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(
    proofPath,
    `${JSON.stringify(buildCurrentReleaseProof({ packageName, version, repoRoot }), null, 2)}\n`,
  );
  process.stdout.write(`release publish proof recorded: ${path.relative(repoRoot, proofPath)}\n`);
  return proofPath;
}

/**
 * Reads and validates the local release proof shape.
 *
 * @param {string} repoRoot
 * @returns {ReleaseProof}
 */
function readReleaseProof(repoRoot: string): ReleaseProof {
  const proofPath = resolveReleaseProofPath(repoRoot);
  assert.equal(
    fs.existsSync(proofPath),
    true,
    `missing release publish proof at ${path.relative(repoRoot, proofPath)}; run pnpm release:publish without --resume-upload`,
  );

  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8')) as Partial<ReleaseProof>;
  assert.equal(proof.schemaVersion, 1, 'release publish proof has an unsupported schema version');
  assert.equal(typeof proof.packageName, 'string', 'release publish proof packageName must be a string');
  assert.equal(typeof proof.version, 'string', 'release publish proof version must be a string');
  assert.equal(typeof proof.commit, 'string', 'release publish proof commit must be a string');
  assert.equal(typeof proof.packageJsonSha256, 'string', 'release publish proof packageJsonSha256 must be a string');
  assert.ok(
    typeof proof.pnpmLockSha256 === 'string' || proof.pnpmLockSha256 === null,
    'release publish proof pnpmLockSha256 must be a string or null',
  );
  assert.equal(proof.releaseCheckCommand, 'pnpm release:check', 'release publish proof command is not reusable');
  return proof as ReleaseProof;
}

/**
 * Ensures upload resume uses proof from the same package state and commit.
 *
 * @param {{packageName: string, version: string, repoRoot: string}} options
 * @returns {void}
 */
function assertReleaseProofMatches({
  packageName,
  version,
  repoRoot,
}: {
  packageName: string;
  version: string;
  repoRoot: string;
}): void {
  const proof = readReleaseProof(repoRoot);
  const expected = buildCurrentReleaseProof({ packageName, version, repoRoot });
  const mismatches: ReleaseProofMismatch[] = [];

  for (const field of Object.keys(expected) as Array<keyof ReleaseProof>) {
    if (proof[field] !== expected[field]) {
      mismatches.push({
        field,
        expected: expected[field],
        actual: proof[field],
      });
    }
  }

  assert.equal(
    mismatches.length,
    0,
    `release publish proof does not match current checkout: ${mismatches
      .map(({ field, expected: expectedValue, actual }) => `${field} expected ${expectedValue} but found ${actual}`)
      .join('; ')}`,
  );
}

/**
 * Prepares or verifies the release proof that allows script-skipped npm upload.
 *
 * @param {{packageName: string, version: string, repoRoot: string, resumeUpload: boolean}} options
 * @returns {void}
 */
function prepareUploadProof({
  packageName,
  version,
  repoRoot,
  resumeUpload,
}: {
  packageName: string;
  version: string;
  repoRoot: string;
  resumeUpload: boolean;
}): void {
  if (resumeUpload) {
    announcePhase('resume-proof');
    assertReleaseProofMatches({ packageName, version, repoRoot });
    process.stdout.write(`release publish proof matched: ${packageName}@${version}\n`);
    return;
  }

  runReleaseCheck(repoRoot);
  writeReleaseProof({ packageName, version, repoRoot });
}

/**
 * Reads a published registry version when npm already has it.
 *
 * @param {string} packageName
 * @param {string} version
 * @param {string} repoRoot
 * @returns {string | null}
 */
function readPublishedVersion(packageName: string, version: string, repoRoot: string): string | null {
  const result = tryCommand('npm', ['view', `${packageName}@${version}`, 'version'], repoRoot);
  return result.status === 'passed' ? result.stdout : null;
}

/**
 * Publishes the package unless the exact version already exists on npm.
 *
 * @param {{packageName: string, version: string, repoRoot: string}} options
 * @returns {void}
 */
function publishOrResume({
  packageName,
  version,
  repoRoot,
}: {
  packageName: string;
  version: string;
  repoRoot: string;
}): void {
  const publishedVersion = readPublishedVersion(packageName, version, repoRoot);
  if (publishedVersion === version) {
    process.stdout.write(`npm already contains ${packageName}@${version}; continuing to tag sync\n`);
    return;
  }

  preparePackageForPublish(repoRoot);
  announcePhase('npm-publish');
  run('npm', ['publish', '--ignore-scripts', '--access', 'public'], repoRoot);

  const verifiedVersion = readPublishedVersion(packageName, version, repoRoot);
  assert.equal(verifiedVersion, version, `npm registry did not publish ${packageName}@${version}`);
}

/**
 * Returns whether a git ref exists locally.
 *
 * @param {string} ref
 * @param {string} repoRoot
 * @returns {boolean}
 */
function localRefExists(ref: string, repoRoot: string): boolean {
  return tryCommand('git', ['rev-parse', '--verify', '--quiet', ref], repoRoot).status === 'passed';
}

/**
 * Returns whether the release tag exists on origin.
 *
 * @param {string} tagName
 * @param {string} repoRoot
 * @returns {boolean}
 */
function remoteTagExists(tagName: string, repoRoot: string): boolean {
  const result = tryCommand('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tagName}`], repoRoot);
  return result.status === 'passed' && result.stdout.length > 0;
}

/**
 * Creates and pushes the semver tag that drives GitHub Releases.
 *
 * @param {{tagName: string, repoRoot: string}} options
 * @returns {void}
 */
function syncGithubReleaseTag({ tagName, repoRoot }: { tagName: string; repoRoot: string }): void {
  announcePhase('git-tag');
  if (!localRefExists(`refs/tags/${tagName}`, repoRoot)) {
    run('git', ['tag', tagName], repoRoot);
  }

  if (remoteTagExists(tagName, repoRoot)) {
    process.stdout.write(`origin already has ${tagName}; GitHub release workflow should already be queued or complete\n`);
    return;
  }

  announcePhase('push-tag');
  run('git', ['push', 'origin', tagName], repoRoot);
}

/**
 * Publishes npm package truth and synchronizes the matching GitHub Release tag.
 *
 * @param {{repoRoot: string, resumeUpload: boolean}} options
 * @returns {void}
 */
function publishRelease({
  repoRoot,
  resumeUpload,
}: {
  repoRoot: string;
  resumeUpload: boolean;
}): void {
  const packageJson = readPackageJson(repoRoot);
  assert.equal(packageJson.name, 'agent-scenario-loop');
  const version = resolvePackageVersion(packageJson);
  const tagName = `v${version}`;

  announcePhase('checkout');
  assertReleaseCheckout(repoRoot);
  prepareUploadProof({
    packageName: 'agent-scenario-loop',
    version,
    repoRoot,
    resumeUpload,
  });
  announcePhase('pre-upload-checkout');
  assertReleaseCheckout(repoRoot);
  publishOrResume({
    packageName: 'agent-scenario-loop',
    version,
    repoRoot,
  });

  announcePhase('post-publish-checkout');
  assertReleaseCheckout(repoRoot);
  syncGithubReleaseTag({ tagName, repoRoot });
  process.stdout.write(`release publish synced: agent-scenario-loop@${version} -> ${tagName}\n`);
}

/**
 * CLI entrypoint for the release publish coordinator.
 *
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const args = parseArgs(process.argv.slice(2));
  publishRelease({
    repoRoot,
    resumeUpload: args.resumeUpload,
  });
}

if (require.main === module) {
  main();
}

export {
  assertReleaseCheckout,
  assertReleaseProofMatches,
  buildCurrentReleaseProof,
  localRefExists,
  main,
  parseArgs,
  prepareUploadProof,
  preparePackageForPublish,
  publishRelease,
  publishOrResume,
  readPublishedVersion,
  readReleaseProof,
  resolvePackageVersion,
  resolveReleaseProofPath,
  runReleaseCheck,
  syncGithubReleaseTag,
  writeReleaseProof,
};
