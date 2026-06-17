const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initProject } = require('../init-project');
const {
  buildValidationRunId,
  formatResult,
  parseArgs,
  resolvePlatforms,
  validateConfigPlaceholders,
  validateAppHelper,
  validatePackageScripts,
  validateProject,
} = require('../validate-project');

type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');

test('parses project validation arguments', () => {
  assert.deepEqual(parseArgs(['--root', 'app', '--platform', 'ios', '--out', 'artifacts/validation']), {
    out: 'artifacts/validation',
    platform: 'ios',
    root: 'app',
  });
});

test('resolves validation platforms from scenario manifests', () => {
  assert.deepEqual(resolvePlatforms({
    requestedPlatform: 'ios',
    scenario: { platforms: ['ios', 'android'] },
  }), ['ios']);
  assert.deepEqual(resolvePlatforms({
    requestedPlatform: 'all',
    scenario: { platforms: ['ios', 'android'] },
  }), ['ios', 'android']);
  assert.deepEqual(resolvePlatforms({
    requestedPlatform: 'all',
    scenario: {},
  }), ['ios', 'android']);
  assert.equal(buildValidationRunId({ platform: 'android', scenarioId: 'checkout-submit' }), 'validate-android-checkout-submit');
});

test('validates an initialized project for iOS and Android', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });

  const result = await validateProject({ rootDir: targetDir });

  assert.equal(result.status, 'passed');
  assert.equal(result.appHelper.status, 'present');
  assert.equal(result.scripts.status, 'present');
  assert.equal(result.scripts.scriptNames.includes('asl:validate'), true);
  assert.equal(result.warnings.some((warning: string) => warning.includes('projectName')), true);
  assert.equal(result.scenarioPaths.length, 1);
  assert.equal(result.providerPaths.length, 1);
  assert.deepEqual(
    result.plans.map((plan: { healthStatus: string; platform: string; scenarioId: string }) => ({
      healthStatus: plan.healthStatus,
      platform: plan.platform,
      scenarioId: plan.scenarioId,
    })).sort((
      left: { healthStatus: string; platform: string; scenarioId: string },
      right: { healthStatus: string; platform: string; scenarioId: string },
    ) => left.platform.localeCompare(right.platform)),
    [
      { healthStatus: 'passed', platform: 'android', scenarioId: 'checkout-submit' },
      { healthStatus: 'passed', platform: 'ios', scenarioId: 'checkout-submit' },
    ],
  );
  assert.match(formatResult(result), /project validation passed/u);
  assert.match(formatResult(result), /Warnings:/u);
});

test('fails validation when initialized project files are missing', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-missing-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  const result = await validateProject({ rootDir: targetDir });

  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some((error: string) => error.includes('Missing config')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing primary runner manifest')));
  assert.ok(result.errors.some((error: string) => error.includes('No scenario manifests found')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing app profile-session helper')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing package-script snippets')));
});

test('validates app profile-session helper exports', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-helper-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });
  const helperDir = path.join(targetDir, 'src', 'devtools');
  await fsp.mkdir(helperDir, { recursive: true });
  const helperPath = path.join(helperDir, 'profile-session.ts');
  await fsp.writeFile(helperPath, 'export function emitProfileEvent() {}\n', 'utf8');

  const helper = validateAppHelper(targetDir);

  assert.equal(helper.status, 'incomplete');
  assert.deepEqual(helper.missingExports, [
    'registerProfileCommandTargetHandler',
    'useProfileSessionBootstrap',
  ]);
  assert.equal(fs.existsSync(helper.path), true);
});

test('validates generated package-script snippets', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-scripts-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });
  const scriptsDir = path.join(targetDir, 'asl');
  await fsp.mkdir(scriptsDir, { recursive: true });
  await fsp.writeFile(
    path.join(scriptsDir, 'package-scripts.json'),
    `${JSON.stringify({
      'asl:check:ios': 'asl-check-plan --scenario scenarios/mobile/missing.json --runner runner-manifests/primary-runner.json --platform ios',
      'asl:validate': 'not-an-asl-bin --root . --platform all',
    }, null, 2)}\n`,
    'utf8',
  );

  const scripts = validatePackageScripts({ packageRoot: ROOT, rootDir: targetDir });

  assert.equal(scripts.status, 'incomplete');
  assert.deepEqual(scripts.missingScripts, [
    'asl:check:android',
    'asl:profile:ios',
    'asl:profile:android',
    'asl:compare:ios',
    'asl:compare:android',
    'asl:live-proof',
  ]);
  assert.deepEqual(scripts.unknownCommands, ['not-an-asl-bin']);
  assert.equal(scripts.missingPaths.some((missingPath: string) => missingPath.endsWith('scenarios/mobile/missing.json')), true);
});

test('warns when config values still use scaffold placeholders', () => {
  const warnings = validateConfigPlaceholders({
    app: {
      androidPackage: 'com.example.app',
      displayName: 'Example App',
      iosBundleId: 'dev.real.app',
      profileSessionScheme: 'real-app',
      scheme: 'example-app',
    },
    projectName: 'replace-me',
  });

  assert.deepEqual(warnings, [
    "Config field projectName still uses placeholder value 'replace-me'.",
    "Config field app.displayName still uses placeholder value 'Example App'.",
    "Config field app.scheme still uses placeholder value 'example-app'.",
    "Config field app.androidPackage still uses placeholder value 'com.example.app'.",
  ]);
});
