#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

type CommandResult = {
  status: 'passed' | 'failed';
  stdout: string;
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

  announcePhase('npm-publish');
  run('npm', ['publish', '--access', 'public'], repoRoot);

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
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const packageJson = readPackageJson(repoRoot);
  assert.equal(packageJson.name, 'agent-scenario-loop');
  const version = resolvePackageVersion(packageJson);
  const tagName = `v${version}`;

  announcePhase('checkout');
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

if (require.main === module) {
  main();
}

export {
  assertReleaseCheckout,
  localRefExists,
  main,
  publishOrResume,
  readPublishedVersion,
  resolvePackageVersion,
  syncGithubReleaseTag,
};
