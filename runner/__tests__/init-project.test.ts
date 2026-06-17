const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  formatResult,
  initProject,
  normalizeScenarioId,
  parseArgs,
} = require('../init-project');

type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');

/**
 * Reads a JSON fixture from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('normalizes scenario ids for scaffold filenames', () => {
  assert.equal(normalizeScenarioId('Checkout Submit'), 'checkout-submit');
  assert.equal(normalizeScenarioId('  media/open close  '), 'media-open-close');
  assert.equal(normalizeScenarioId(''), 'first-journey');
});

test('parses init arguments', () => {
  assert.deepEqual(parseArgs(['--', '--out', 'app', '--scenario', 'Checkout Submit', '--force']), {
    force: true,
    out: 'app',
    scenario: 'Checkout Submit',
  });
});

test('init-project scaffolds templates into a consuming app layout', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-init-project-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  const result = await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });

  assert.deepEqual(result.created.sort(), [
    'asl.config.json',
    'asl/README.md',
    'asl/gitignore-snippet',
    'asl/package-scripts.json',
    'runner-manifests/evidence-provider.json',
    'runner-manifests/primary-runner.json',
    'scenarios/mobile/checkout-submit.json',
    'src/devtools/profile-session.ts',
  ]);
  assert.deepEqual(result.skipped, []);
  assert.equal(readJson(path.join(targetDir, 'asl.config.json')).projectName, 'replace-me');
  assert.equal(readJson(path.join(targetDir, 'scenarios', 'mobile', 'checkout-submit.json')).id, 'checkout-submit');
  assert.equal(readJson(path.join(targetDir, 'scenarios', 'mobile', 'checkout-submit.json')).flowId, 'checkout-submit');
  assert.equal(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:check:ios'], 'asl-check-plan --scenario scenarios/mobile/checkout-submit.json --runner runner-manifests/primary-runner.json --platform ios --out artifacts/asl/plan/checkout-submit-ios');
  assert.equal(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:profile:ios:live'], 'asl-profile-ios --config asl.config.json --scenario scenarios/mobile/checkout-submit.json --simctl-capture --profile-session --profile-session-storage --launch --wait-ms 5000 --out artifacts/asl/ios --run-id checkout-submit-ios-live');
  assert.match(fs.readFileSync(path.join(targetDir, 'asl', 'README.md'), 'utf8'), /checkout-submit/u);
  assert.match(fs.readFileSync(path.join(targetDir, 'asl', 'gitignore-snippet'), 'utf8'), /artifacts\/asl\//u);
  assert.match(fs.readFileSync(path.join(targetDir, 'src', 'devtools', 'profile-session.ts'), 'utf8'), /useProfileSessionBootstrap/u);
  assert.match(formatResult(result), /created:/u);
});

test('init-project skips existing files unless force is enabled', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-init-project-skip-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({ outDir: targetDir, packageRoot: ROOT });
  await fsp.writeFile(path.join(targetDir, 'asl.config.json'), '{"projectName":"custom"}\n', 'utf8');

  const skipped = await initProject({ outDir: targetDir, packageRoot: ROOT });
  assert.deepEqual(skipped.skipped, [
    'asl.config.json',
    'scenarios/mobile/first-journey.json',
    'runner-manifests/primary-runner.json',
    'runner-manifests/evidence-provider.json',
    'asl/README.md',
    'asl/package-scripts.json',
    'asl/gitignore-snippet',
    'src/devtools/profile-session.ts',
  ]);
  assert.equal(readJson(path.join(targetDir, 'asl.config.json')).projectName, 'custom');

  const forced = await initProject({ force: true, outDir: targetDir, packageRoot: ROOT });
  assert.equal(forced.skipped.length, 0);
  assert.equal(readJson(path.join(targetDir, 'asl.config.json')).projectName, 'replace-me');
});

test('init-project dry run reports files without writing them', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-init-project-dry-run-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  const result = await initProject({
    dryRun: true,
    outDir: targetDir,
    packageRoot: ROOT,
  });

  assert.equal(result.created.length, 8);
  assert.equal(fs.existsSync(path.join(targetDir, 'asl.config.json')), false);
});
