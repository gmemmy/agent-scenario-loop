const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runProfileMobile } = require('../profile-mobile');

test('refuses claim-complete scenarios before profile artifact or runtime work', async (t: import('node:test').TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-claim-profile-'));
  const configPath = path.join(root, 'asl.config.json');
  const scenarioPath = path.join(root, 'scenario.json');
  const outputDir = path.join(root, 'artifacts');
  await fsp.writeFile(configPath, '{}\n', 'utf8');
  await fsp.writeFile(scenarioPath, JSON.stringify({ schemaVersion: '1.1.0', id: 'claim-scenario' }), 'utf8');
  t.after(async () => {
    await fsp.rm(root, { force: true, recursive: true });
  });

  await assert.rejects(
    runProfileMobile(
      { config: configPath, scenario: scenarioPath, out: outputDir },
      { defaultDriver: 'adb', platform: 'android' },
    ),
    /reader-only.*execution is unsupported/u,
  );
  await assert.rejects(fsp.access(outputDir));
});
