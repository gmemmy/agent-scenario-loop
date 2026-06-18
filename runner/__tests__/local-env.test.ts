const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  findNearestLocalEnvFile,
  loadAslLocalEnv,
  parseLocalEnvLine,
  readBooleanArgOrEnv,
  readStringArgOrEnv,
} = require('../local-env');

type TestContext = import('node:test').TestContext;

test('local env parser accepts simple values, export prefixes, and quoted wrapper args', () => {
  assert.deepEqual(parseLocalEnvLine('ASL_ARGENT_BIN=pnpm'), {
    key: 'ASL_ARGENT_BIN',
    value: 'pnpm',
  });
  assert.deepEqual(parseLocalEnvLine('export ASL_ARGENT_BASE_ARGS="dlx @swmansion/argent run"'), {
    key: 'ASL_ARGENT_BASE_ARGS',
    value: 'dlx @swmansion/argent run',
  });
  assert.equal(parseLocalEnvLine('# comment'), null);
  assert.equal(parseLocalEnvLine('1INVALID=value'), null);
});

test('local env loader finds nearest file and preserves explicit environment values', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-local-env-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const nestedDir = path.join(tempDir, 'app', 'scenarios');
  await fsp.mkdir(nestedDir, { recursive: true });
  const envPath = path.join(tempDir, 'app', '.asl.local.env');
  await fsp.writeFile(envPath, [
    'ASL_ARGENT_BIN=pnpm',
    'ASL_ARGENT_BASE_ARGS="dlx @swmansion/argent run"',
    'ASL_EXAMPLE_ANDROID_SERIAL=emulator-5554',
    '',
  ].join('\n'), 'utf8');

  const env: NodeJS.ProcessEnv = {
    ASL_ARGENT_BIN: 'argent',
  };
  assert.equal(findNearestLocalEnvFile(nestedDir), envPath);
  const result = loadAslLocalEnv({ cwd: nestedDir, env });

  assert.deepEqual(result, {
    filePath: envPath,
    keys: ['ASL_ARGENT_BASE_ARGS', 'ASL_EXAMPLE_ANDROID_SERIAL'],
  });
  assert.equal(env.ASL_ARGENT_BIN, 'argent');
  assert.equal(env.ASL_ARGENT_BASE_ARGS, 'dlx @swmansion/argent run');
  assert.equal(env.ASL_EXAMPLE_ANDROID_SERIAL, 'emulator-5554');
});

test('local env readers keep CLI values ahead of loaded defaults', () => {
  const env: NodeJS.ProcessEnv = {
    ASL_ARGENT_BIN: 'pnpm',
    ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK: '1',
  };

  assert.equal(readStringArgOrEnv('argent', ['ASL_ARGENT_BIN'], env), 'argent');
  assert.equal(readStringArgOrEnv(undefined, ['ASL_ARGENT_BIN'], env), 'pnpm');
  assert.equal(readBooleanArgOrEnv(false, ['ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK'], env), true);
});
