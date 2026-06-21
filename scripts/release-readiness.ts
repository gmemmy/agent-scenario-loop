#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REQUIRED_BIN_TARGETS: Record<string, string> = {
  'agent-scenario-loop': 'dist/runner/check-plan.js',
  'asl-agent-device': 'dist/runner/agent-device.js',
  'asl-android-adb': 'dist/runner/android-adb.js',
  'asl-argent': 'dist/runner/argent.js',
  'asl-check-plan': 'dist/runner/check-plan.js',
  'asl-compare': 'dist/runner/compare.js',
  'asl-compare-latest': 'dist/runner/compare-latest.js',
  'asl-demo-loop': 'dist/runner/demo-loop.js',
  'asl-example-android-live': 'dist/runner/example-android-live.js',
  'asl-example-ios-live': 'dist/runner/example-ios-live.js',
  'asl-host-doctor': 'dist/runner/host-doctor.js',
  'asl-init': 'dist/runner/init-project.js',
  'asl-ios-simctl': 'dist/runner/ios-simctl.js',
  'asl-live-android': 'dist/runner/live-android.js',
  'asl-live-ios': 'dist/runner/live-ios.js',
  'asl-live-proof': 'dist/runner/live-proof.js',
  'asl-profile-android': 'dist/runner/profile-android.js',
  'asl-profile-ios': 'dist/runner/profile-ios.js',
  'asl-validate-project': 'dist/runner/validate-project.js',
};

const REQUIRED_EXPORTS: Record<string, string | Record<string, string>> = {
  '.': {
    require: './dist/index.js',
    types: './dist/index.d.ts',
    import: './dist/index.js',
    default: './dist/index.js',
  },
  './app/profile-session': {
    require: './app/profile-session.ts',
    types: './app/profile-session.d.ts',
    import: './app/profile-session.ts',
    default: './app/profile-session.ts',
  },
  './examples/*': './examples/*',
  './package.json': './package.json',
  './runner/agent-device': {
    require: './dist/runner/agent-device.js',
    types: './dist/runner/agent-device.d.ts',
    import: './dist/runner/agent-device.js',
    default: './dist/runner/agent-device.js',
  },
  './runner/agent-device-driver': {
    require: './dist/runner/agent-device-driver.js',
    types: './dist/runner/agent-device-driver.d.ts',
    import: './dist/runner/agent-device-driver.js',
    default: './dist/runner/agent-device-driver.js',
  },
  './runner/argent-driver': {
    require: './dist/runner/argent-driver.js',
    types: './dist/runner/argent-driver.d.ts',
    import: './dist/runner/argent-driver.js',
    default: './dist/runner/argent-driver.js',
  },
  './runner/argent': {
    require: './dist/runner/argent.js',
    types: './dist/runner/argent.d.ts',
    import: './dist/runner/argent.js',
    default: './dist/runner/argent.js',
  },
  './runner/android-adb': {
    require: './dist/runner/android-adb.js',
    types: './dist/runner/android-adb.d.ts',
    import: './dist/runner/android-adb.js',
    default: './dist/runner/android-adb.js',
  },
  './runner/android-adb-driver': {
    require: './dist/runner/android-adb-driver.js',
    types: './dist/runner/android-adb-driver.d.ts',
    import: './dist/runner/android-adb-driver.js',
    default: './dist/runner/android-adb-driver.js',
  },
  './runner/check-plan': {
    require: './dist/runner/check-plan.js',
    types: './dist/runner/check-plan.d.ts',
    import: './dist/runner/check-plan.js',
    default: './dist/runner/check-plan.js',
  },
  './runner/compare': {
    require: './dist/runner/compare.js',
    types: './dist/runner/compare.d.ts',
    import: './dist/runner/compare.js',
    default: './dist/runner/compare.js',
  },
  './runner/compare-latest': {
    require: './dist/runner/compare-latest.js',
    types: './dist/runner/compare-latest.d.ts',
    import: './dist/runner/compare-latest.js',
    default: './dist/runner/compare-latest.js',
  },
  './runner/demo-loop': {
    require: './dist/runner/demo-loop.js',
    types: './dist/runner/demo-loop.d.ts',
    import: './dist/runner/demo-loop.js',
    default: './dist/runner/demo-loop.js',
  },
  './runner/example-android-live': {
    require: './dist/runner/example-android-live.js',
    types: './dist/runner/example-android-live.d.ts',
    import: './dist/runner/example-android-live.js',
    default: './dist/runner/example-android-live.js',
  },
  './runner/example-ios-live': {
    require: './dist/runner/example-ios-live.js',
    types: './dist/runner/example-ios-live.d.ts',
    import: './dist/runner/example-ios-live.js',
    default: './dist/runner/example-ios-live.js',
  },
  './runner/host-doctor': {
    require: './dist/runner/host-doctor.js',
    types: './dist/runner/host-doctor.d.ts',
    import: './dist/runner/host-doctor.js',
    default: './dist/runner/host-doctor.js',
  },
  './runner/init-project': {
    require: './dist/runner/init-project.js',
    types: './dist/runner/init-project.d.ts',
    import: './dist/runner/init-project.js',
    default: './dist/runner/init-project.js',
  },
  './runner/ios-simctl': {
    require: './dist/runner/ios-simctl.js',
    types: './dist/runner/ios-simctl.d.ts',
    import: './dist/runner/ios-simctl.js',
    default: './dist/runner/ios-simctl.js',
  },
  './runner/ios-simctl-driver': {
    require: './dist/runner/ios-simctl-driver.js',
    types: './dist/runner/ios-simctl-driver.d.ts',
    import: './dist/runner/ios-simctl-driver.js',
    default: './dist/runner/ios-simctl-driver.js',
  },
  './runner/live-android': {
    require: './dist/runner/live-android.js',
    types: './dist/runner/live-android.d.ts',
    import: './dist/runner/live-android.js',
    default: './dist/runner/live-android.js',
  },
  './runner/live-ios': {
    require: './dist/runner/live-ios.js',
    types: './dist/runner/live-ios.d.ts',
    import: './dist/runner/live-ios.js',
    default: './dist/runner/live-ios.js',
  },
  './runner/live-proof': {
    require: './dist/runner/live-proof.js',
    types: './dist/runner/live-proof.d.ts',
    import: './dist/runner/live-proof.js',
    default: './dist/runner/live-proof.js',
  },
  './runner/profile-android': {
    require: './dist/runner/profile-android.js',
    types: './dist/runner/profile-android.d.ts',
    import: './dist/runner/profile-android.js',
    default: './dist/runner/profile-android.js',
  },
  './runner/profile-ios': {
    require: './dist/runner/profile-ios.js',
    types: './dist/runner/profile-ios.d.ts',
    import: './dist/runner/profile-ios.js',
    default: './dist/runner/profile-ios.js',
  },
  './runner/validate-project': {
    require: './dist/runner/validate-project.js',
    types: './dist/runner/validate-project.d.ts',
    import: './dist/runner/validate-project.js',
    default: './dist/runner/validate-project.js',
  },
  './schemas/*': './schemas/*',
  './templates/*': './templates/*',
};

const REQUIRED_PACKAGE_FILES = [
  'LICENSE',
  'README.md',
  'app/profile-session.ts',
  'app/profile-session.d.ts',
  'core/config-template.json',
  'dist',
  'docs',
  'examples',
  'schemas',
  'templates',
];

const REQUIRED_PACKAGE_EXCLUSIONS = [
  '!dist/**/__tests__',
  '!examples/mobile-app/.expo',
  '!examples/mobile-app/.expo/**',
  '!examples/mobile-app/android',
  '!examples/mobile-app/android/**',
  '!examples/mobile-app/artifacts',
  '!examples/mobile-app/artifacts/**',
  '!examples/mobile-app/ios',
  '!examples/mobile-app/ios/**',
  '!examples/mobile-app/node_modules',
  '!examples/mobile-app/node_modules/**',
];

const REQUIRED_GITIGNORE_ENTRIES = [
  'node_modules/',
  '.agents/',
  'dist/',
  'core/artifacts/',
  'artifacts/',
  'examples/mobile-app/.expo/',
  'examples/mobile-app/android/',
  'examples/mobile-app/artifacts/',
  'examples/mobile-app/ios/',
  'examples/mobile-app/node_modules/',
];

const FORBIDDEN_TRACKED_PATH_PATTERNS = [
  /^artifacts\//u,
  /^core\/artifacts\//u,
  /^dist\//u,
  /^examples\/mobile-app\/(?:\.expo|android|artifacts|ios|node_modules)(?:\/|$)/u,
];

const REQUIRED_CONFIG_STRING_FIELDS: string[][] = [
  ['app', 'profileSessionScheme'],
  ['app', 'iosBundleId'],
  ['app', 'androidPackage'],
  ['paths', 'artifactRoot'],
  ['paths', 'iosArtifactsRoot'],
  ['paths', 'androidArtifactsRoot'],
  ['paths', 'scenarioRoot'],
];

const REQUIRED_PLATFORM_SCRIPT_PAIRS: Array<[string, string]> = [
  ['asl:check:ios', 'asl:check:android'],
  ['asl:profile:ios', 'asl:profile:android'],
  ['asl:profile:ios:provider', 'asl:profile:android:provider'],
  ['asl:profile:ios:live', 'asl:profile:android:live'],
  ['asl:ios:live', 'asl:android:live'],
  ['asl:ios:live:agent-device', 'asl:android:live:agent-device'],
  ['asl:ios:live:argent', 'asl:android:live:argent'],
  ['asl:ios:live:runners', 'asl:android:live:runners'],
  ['asl:agent-device:ios', 'asl:agent-device:android'],
  ['asl:argent:ios', 'asl:argent:android'],
  ['asl:compare:ios', 'asl:compare:android'],
  ['asl:live-proof:ios', 'asl:live-proof:android'],
];

const REQUIRED_STRICT_EXAMPLE_LIVE_SCRIPTS = [
  'example:android:live',
  'example:android:live:agent-device',
  'example:android:live:argent',
  'example:android:live:runners',
  'example:ios:live',
  'example:ios:live:agent-device',
  'example:ios:live:argent',
  'example:ios:live:runners',
];

/**
 * Reads and parses a JSON object from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJsonObject(filePath: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(typeof value, 'object', `${filePath} must contain a JSON object`);
  assert.notEqual(value, null, `${filePath} must contain a JSON object`);
  assert.equal(Array.isArray(value), false, `${filePath} must contain a JSON object`);
  return value as Record<string, unknown>;
}

/**
 * Reads a nested value from a JSON object.
 *
 * @param {Record<string, unknown>} object
 * @param {string[]} pathSegments
 * @returns {unknown}
 */
function readNestedValue(object: Record<string, unknown>, pathSegments: string[]): unknown {
  let value: unknown = object;
  for (const segment of pathSegments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }

  return value;
}

/**
 * Returns a string map property from a JSON object.
 *
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {Record<string, string>}
 */
function getStringMap(object: Record<string, unknown>, key: string): Record<string, string> {
  const value = object[key];
  assert.equal(typeof value, 'object', `${key} must be an object`);
  assert.notEqual(value, null, `${key} must be an object`);
  assert.equal(Array.isArray(value), false, `${key} must be an object`);
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    assert.equal(typeof entryValue, 'string', `${key}.${entryKey} must be a string`);
  }
  return value as Record<string, string>;
}

/**
 * Returns an object map property from a JSON object.
 *
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function getObjectMap(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = object[key];
  assert.equal(typeof value, 'object', `${key} must be an object`);
  assert.notEqual(value, null, `${key} must be an object`);
  assert.equal(Array.isArray(value), false, `${key} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * Returns a string array property from a JSON object.
 *
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @returns {string[]}
 */
function getStringArray(object: Record<string, unknown>, key: string): string[] {
  const value = object[key];
  assert.equal(Array.isArray(value), true, `${key} must be an array`);
  for (const entry of value as unknown[]) {
    assert.equal(typeof entry, 'string', `${key} entries must be strings`);
  }
  return value as string[];
}

/**
 * Asserts that every expected value appears in an actual string list.
 *
 * @param {string[]} actual
 * @param {string[]} expected
 * @param {string} label
 * @returns {void}
 */
function assertIncludesAll(actual: string[], expected: string[], label: string): void {
  for (const entry of expected) {
    assert.equal(actual.includes(entry), true, `${label} is missing ${entry}`);
  }
}

/**
 * Asserts that package metadata still describes the intended public package.
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {void}
 */
function assertPublicPackageMetadata(packageJson: Record<string, unknown>): void {
  assert.equal(packageJson.name, 'agent-scenario-loop');
  assert.match(String(packageJson.version), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u);
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.type, 'commonjs');
  assert.equal(packageJson.main, 'dist/index.js');
  assert.equal(packageJson.types, 'dist/index.d.ts');
  assert.equal(getObjectMap(packageJson, 'publishConfig').access, 'public');
  assert.equal(getObjectMap(packageJson, 'engines').node, '>=20');
}

/**
 * Asserts that release scripts keep npm publishing behind the full validation gate.
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {void}
 */
function assertReleaseScripts(packageJson: Record<string, unknown>): void {
  const scripts = getStringMap(packageJson, 'scripts');
  assert.equal(scripts.prepublishOnly, 'pnpm release:check');
  assert.equal(scripts['release:readiness'], 'pnpm build && node dist/scripts/release-readiness.js');
  assert.equal(
    scripts['release:check'],
    'pnpm build && node dist/scripts/release-check.js',
  );
  assert.equal(scripts['package:smoke'], 'pnpm build && node dist/scripts/package-smoke.js');
  assert.equal(scripts['consumer:rehearse'], 'pnpm build && node dist/scripts/consumer-rehearsal.js');
  assert.equal(
    scripts['downstream:local-package'],
    'pnpm build && node dist/scripts/downstream-local-package-gate.js',
  );
  for (const scriptName of REQUIRED_STRICT_EXAMPLE_LIVE_SCRIPTS) {
    assert.match(scripts[scriptName], /--compare-latest/u, `${scriptName} must write comparison evidence by default`);
    assert.match(scripts[scriptName], /--fail-on-regression/u, `${scriptName} must fail on regressions by default`);
  }
  assert.match(scripts['example:mobile:live-proof'], /--require-platforms android,ios/u);
  assert.match(scripts['example:mobile:live-proof'], /--out artifacts\/example-mobile-app\/live-proof-set/u);
  assert.match(scripts['example:mobile:live-proof'], /--fail-on-regression/u);
  assert.match(scripts['example:app:start:isolated'], /--port 8097 --host localhost --clear/u);
}

/**
 * Asserts that pushed semver tags synchronize GitHub Releases from npm package truth.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function assertGithubReleaseWorkflow(repoRoot: string): void {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'github-release.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /tags:\n\s+- 'v\*\.\*\.\*'/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /VERSION="\$\{GITHUB_REF_NAME#v\}"/u);
  assert.match(workflow, /PACKAGE_VERSION="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/u);
  assert.match(workflow, /npm view agent-scenario-loop@"\$VERSION" version/u);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/u);
  assert.match(workflow, /--generate-notes/u);
  assert.match(workflow, /--verify-tag/u);
}

/**
 * Asserts that public binaries and package subpath exports map to built files.
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {void}
 */
function assertPublicEntrypoints(packageJson: Record<string, unknown>): void {
  assert.deepEqual(getStringMap(packageJson, 'bin'), REQUIRED_BIN_TARGETS);
  assert.deepEqual(getObjectMap(packageJson, 'exports'), REQUIRED_EXPORTS);
}

/**
 * Extracts documented runner subpath specifiers from the public API guide.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
function readDocumentedRunnerSubpaths(repoRoot: string): string[] {
  const apiDocs = fs.readFileSync(path.join(repoRoot, 'docs', 'api.md'), 'utf8');
  const subpaths = new Set<string>();
  for (const match of apiDocs.matchAll(/`(agent-scenario-loop\/runner\/[^`]+)`/gu)) {
    subpaths.add(match[1]);
  }
  return Array.from(subpaths).sort();
}

/**
 * Extracts concrete runner subpath specifiers from package exports.
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {string[]}
 */
function readExportedRunnerSubpaths(packageJson: Record<string, unknown>): string[] {
  return Object.keys(getObjectMap(packageJson, 'exports'))
    .filter((subpath) => subpath.startsWith('./runner/'))
    .map((subpath) => `agent-scenario-loop/${subpath.slice(2)}`)
    .sort();
}

/**
 * Asserts that the public API guide and package exports describe the same runner surface.
 *
 * @param {Record<string, unknown>} packageJson
 * @param {string} repoRoot
 * @returns {void}
 */
function assertPublicApiDocs(packageJson: Record<string, unknown>, repoRoot: string): void {
  assert.deepEqual(
    readDocumentedRunnerSubpaths(repoRoot),
    readExportedRunnerSubpaths(packageJson),
    'docs/api.md runner subpaths must match package.json exports',
  );
}

/**
 * Asserts that package include/exclude metadata protects generated local state.
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {void}
 */
function assertPackageFileList(packageJson: Record<string, unknown>): void {
  const files = getStringArray(packageJson, 'files');
  assertIncludesAll(files, REQUIRED_PACKAGE_FILES, 'package files');
  assertIncludesAll(files, REQUIRED_PACKAGE_EXCLUSIONS, 'package files');
  for (const forbidden of ['.github', 'scripts', 'runner', 'node_modules', 'artifacts']) {
    assert.equal(files.includes(forbidden), false, `package files must not include ${forbidden}`);
  }
}

/**
 * Asserts that ignored local state paths remain explicit in the repository.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function assertGitignoreState(repoRoot: string): void {
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8').split(/\r?\n/u);
  assertIncludesAll(gitignore, REQUIRED_GITIGNORE_ENTRIES, '.gitignore');
}

/**
 * Asserts that generated runtime/native state is not tracked by git.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function assertNoTrackedGeneratedState(repoRoot: string): void {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const trackedPaths = output.split('\0').filter(Boolean);
  for (const trackedPath of trackedPaths) {
    assert.equal(
      FORBIDDEN_TRACKED_PATH_PATTERNS.some((pattern) => pattern.test(trackedPath)),
      false,
      `generated state must not be tracked: ${trackedPath}`,
    );
  }
}

/**
 * Asserts that shipped config templates contain identifiers needed by both mobile platforms.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function assertConfigTemplates(repoRoot: string): void {
  for (const relativePath of ['core/config-template.json', 'templates/project.config.json']) {
    const config = readJsonObject(path.join(repoRoot, relativePath));
    for (const fieldPath of REQUIRED_CONFIG_STRING_FIELDS) {
      const value = readNestedValue(config, fieldPath);
      assert.equal(typeof value, 'string', `${relativePath} must include ${fieldPath.join('.')}`);
      assert.notEqual(String(value).trim(), '', `${relativePath} must include non-empty ${fieldPath.join('.')}`);
    }
  }
}

/**
 * Asserts that shipped package-script snippets expose paired iOS and Android lanes.
 *
 * @param {string} repoRoot
 * @returns {void}
 */
function assertPlatformPackageScripts(repoRoot: string): void {
  for (const relativePath of ['templates/package-scripts.json', 'examples/mobile-app/asl/package-scripts.json']) {
    const scripts = readJsonObject(path.join(repoRoot, relativePath));
    for (const [iosScriptName, androidScriptName] of REQUIRED_PLATFORM_SCRIPT_PAIRS) {
      assert.equal(typeof scripts[iosScriptName], 'string', `${relativePath} must include ${iosScriptName}`);
      assert.equal(typeof scripts[androidScriptName], 'string', `${relativePath} must include ${androidScriptName}`);
    }
  }
}

/**
 * Runs the release-readiness assertions for the current repository checkout.
 *
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const packageJson = readJsonObject(path.join(repoRoot, 'package.json'));

  assertPublicPackageMetadata(packageJson);
  assertReleaseScripts(packageJson);
  assertGithubReleaseWorkflow(repoRoot);
  assertPublicEntrypoints(packageJson);
  assertPublicApiDocs(packageJson, repoRoot);
  assertPackageFileList(packageJson);
  assertGitignoreState(repoRoot);
  assertNoTrackedGeneratedState(repoRoot);
  assertConfigTemplates(repoRoot);
  assertPlatformPackageScripts(repoRoot);

  process.stdout.write('release readiness passed\n');
}

main();
