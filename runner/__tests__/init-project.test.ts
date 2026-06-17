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
    'scripts/asl-capture-accessibility-provider.mjs',
    'scripts/asl-capture-profiler-provider.mjs',
    'src/devtools/profile-session.ts',
  ]);
  assert.deepEqual(result.skipped, []);
  assert.equal(readJson(path.join(targetDir, 'asl.config.json')).projectName, 'replace-me');
  assert.equal(readJson(path.join(targetDir, 'scenarios', 'mobile', 'checkout-submit.json')).id, 'checkout-submit');
  assert.equal(readJson(path.join(targetDir, 'scenarios', 'mobile', 'checkout-submit.json')).flowId, 'checkout-submit');
  assert.equal(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:check:ios'], 'asl-check-plan --scenario scenarios/mobile/checkout-submit.json --runner runner-manifests/primary-runner.json --provider runner-manifests/evidence-provider.json --platform ios --out artifacts/asl/plan/checkout-submit-ios');
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:profile:ios'], /\$\{ASL_PROFILE_IOS_EVENTS:\+--events \$ASL_PROFILE_IOS_EVENTS\}/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:profile:android'], /\$\{ASL_PROFILE_ANDROID_EVENTS:\+--events \$ASL_PROFILE_ANDROID_EVENTS\}/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:profile:ios:provider'], /--provider runner-manifests\/evidence-provider\.json/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:profile:android:provider'], /--provider runner-manifests\/evidence-provider\.json/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:agent-device:ios'], /checkout-submit-ios-agent-device/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:agent-device:android'], /checkout-submit-android-agent-device/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:argent:check'], /^asl-argent --check/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:argent:check'], /ASL_ARGENT_BASE_ARGS/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:argent:ios'], /checkout-submit-ios-argent/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:argent:android'], /checkout-submit-android-argent/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:ios:live'], /^asl-live-ios /u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:ios:live'], /--scenario scenarios\/mobile\/checkout-submit\.json/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:android:live'], /^asl-live-android /u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:android:live'], /--scenario scenarios\/mobile\/checkout-submit\.json/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:ios:live:runners'], /--agent-device-proof --argent-proof/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:android:live:runners'], /--agent-device-proof --argent-proof/u);
  assert.equal(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:profile:ios:live'], 'asl-profile-ios --config asl.config.json --scenario scenarios/mobile/checkout-submit.json --simctl-capture --profile-session --profile-session-storage --launch --wait-ms 5000 --comparison-lane checkout-submit-ios-live --out artifacts/asl/ios --run-id checkout-submit-ios-live');
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:compare:ios'], /--fail-on-regression/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:compare:ios'], /\$\{ASL_COMPARE_IOS_CURRENT:\?set_ASL_COMPARE_IOS_CURRENT\}/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:compare:android'], /--fail-on-regression/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:compare:android'], /\$\{ASL_COMPARE_ANDROID_CURRENT:\?set_ASL_COMPARE_ANDROID_CURRENT\}/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:live-proof:ios'], /artifacts\/asl\/ios-live\/_live-proof\/ios-live-proof\/live-proof\.json/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:live-proof:android'], /artifacts\/asl\/android-live\/_live-proof\/android-live-proof\/live-proof\.json/u);
  assert.match(readJson(path.join(targetDir, 'asl', 'package-scripts.json'))['asl:live-proof'], /\$\{ASL_LIVE_PROOF:\?set_ASL_LIVE_PROOF\}/u);
  assert.deepEqual(readJson(path.join(targetDir, 'runner-manifests', 'evidence-provider.json')).capabilities, ['accessibility', 'memory', 'network', 'profiler']);
  const integrationReadme = fs.readFileSync(path.join(targetDir, 'asl', 'README.md'), 'utf8');
  assert.match(integrationReadme, /checkout-submit/u);
  assert.match(integrationReadme, /ASL_IOS_UDID=<simulator-udid>/u);
  assert.match(integrationReadme, /ASL_ANDROID_SERIAL=<emulator-or-device-serial>/u);
  assert.match(integrationReadme, /ASL_IOS_AGENT_DEVICE_SESSION/u);
  assert.match(integrationReadme, /ASL_ANDROID_AGENT_DEVICE_SESSION/u);
  assert.match(integrationReadme, /ASL_ARGENT_BIN=npx ASL_ARGENT_BASE_ARGS="--yes @swmansion\/argent run"/u);
  assert.match(integrationReadme, /ASL_ARGENT_COMMAND_TIMEOUT_MS/u);
  assert.match(fs.readFileSync(path.join(targetDir, 'asl', 'gitignore-snippet'), 'utf8'), /artifacts\/asl\//u);
  const accessibilityProviderScript = fs.readFileSync(path.join(targetDir, 'scripts', 'asl-capture-accessibility-provider.mjs'), 'utf8');
  assert.match(accessibilityProviderScript, /writeAccessibilityEvidence/u);
  assert.match(accessibilityProviderScript, /violations/u);
  const providerScript = fs.readFileSync(path.join(targetDir, 'scripts', 'asl-capture-profiler-provider.mjs'), 'utf8');
  assert.match(providerScript, /writeProviderEvidence/u);
  assert.match(providerScript, /memory-out/u);
  assert.match(providerScript, /network-out/u);
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
    'scripts/asl-capture-accessibility-provider.mjs',
    'scripts/asl-capture-profiler-provider.mjs',
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

  assert.equal(result.created.length, 10);
  assert.equal(fs.existsSync(path.join(targetDir, 'asl.config.json')), false);
});
