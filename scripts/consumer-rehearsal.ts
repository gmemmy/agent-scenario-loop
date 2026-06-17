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

type ExecFileSyncError = Error & {
  status?: number | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

/**
 * Creates a clean npm environment for local tarball install rehearsals.
 *
 * @param {string} tempRoot
 * @returns {NodeJS.ProcessEnv}
 */
function createRehearsalEnv(tempRoot: string): NodeJS.ProcessEnv {
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
 * Runs a command and returns stdout while preserving child stderr on failure.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {string}
 */
function run(command: string, args: string[], options: RunOptions): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    const failed = error as ExecFileSyncError;
    const stdout = Buffer.isBuffer(failed.stdout) ? failed.stdout.toString('utf8') : String(failed.stdout ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with status ${failed.status ?? 'unknown'}\n${stdout}`);
  }
}

/**
 * Reads and parses a JSON file.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Writes stable formatted JSON.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {void}
 */
function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Resolves a package binary path inside a temporary npm app.
 *
 * @param {string} appRoot
 * @param {string} name
 * @returns {string}
 */
function packageBinPath(appRoot: string, name: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(appRoot, 'node_modules', '.bin', `${name}${suffix}`);
}

/**
 * Packs the current repo and returns the tarball path.
 *
 * @param {{env: NodeJS.ProcessEnv, packageRoot: string, packDir: string}} options
 * @returns {string}
 */
function packPackage({
  env,
  packageRoot,
  packDir,
}: {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  packDir: string;
}): string {
  fs.mkdirSync(packDir, { recursive: true });
  const packOutput = run('npm', ['pack', '--pack-destination', packDir], {
    cwd: packageRoot,
    env,
  });
  const tarballName = packOutput.trim().split(/\n/u).pop();
  assert.ok(tarballName, 'npm pack did not print a tarball name');

  const tarballPath = path.join(packDir, tarballName);
  assert.equal(fs.existsSync(tarballPath), true, `missing packed tarball: ${tarballPath}`);
  return tarballPath;
}

/**
 * Creates an existing app layout before Agent Scenario Loop initialization.
 *
 * @param {string} appRoot
 * @returns {void}
 */
function writeExistingAppFixture(appRoot: string): void {
  fs.mkdirSync(path.join(appRoot, 'src'), { recursive: true });
  writeJson(path.join(appRoot, 'package.json'), {
    name: 'consumer-rehearsal-app',
    private: true,
    scripts: {
      start: 'react-native start',
      test: 'node --version',
    },
  });
  fs.writeFileSync(
    path.join(appRoot, 'src', 'App.tsx'),
    [
      "export function App() {",
      "  return null;",
      "}",
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Writes deterministic profile-event logs for the initialized consumer scenario.
 *
 * @param {string} appRoot
 * @returns {{androidEvents: string, iosEvents: string}}
 */
function writeProfileEventFixtures(appRoot: string): { androidEvents: string; iosEvents: string } {
  const eventLogDir = path.join(appRoot, 'event-logs');
  fs.mkdirSync(eventLogDir, { recursive: true });

  const iosEvents = path.join(eventLogDir, 'account-overview-ios.log');
  const androidEvents = path.join(eventLogDir, 'account-overview-android.log');
  fs.writeFileSync(
    iosEvents,
    [
      '2026-01-01T00:00:00.000Z consumer-ios [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-ios","iteration":1,"atMs":0}',
      '2026-01-01T00:00:00.700Z consumer-ios [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-ios","iteration":1,"atMs":700}',
      '2026-01-01T00:00:01.000Z consumer-ios [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-ios","iteration":2,"atMs":1000}',
      '2026-01-01T00:00:01.760Z consumer-ios [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-ios","iteration":2,"atMs":1760}',
      '2026-01-01T00:00:02.000Z consumer-ios [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-ios","iteration":3,"atMs":2000}',
      '2026-01-01T00:00:02.830Z consumer-ios [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-ios","iteration":3,"atMs":2830}',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    androidEvents,
    [
      '2026-01-01T00:10:00.000Z consumer-android [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-android","iteration":1,"atMs":0}',
      '2026-01-01T00:10:00.820Z consumer-android [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-android","iteration":1,"atMs":820}',
      '2026-01-01T00:10:01.000Z consumer-android [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-android","iteration":2,"atMs":1000}',
      '2026-01-01T00:10:01.870Z consumer-android [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-android","iteration":2,"atMs":1870}',
      '2026-01-01T00:10:02.000Z consumer-android [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-android","iteration":3,"atMs":2000}',
      '2026-01-01T00:10:02.940Z consumer-android [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-android","iteration":3,"atMs":2940}',
      '',
    ].join('\n'),
    'utf8',
  );

  return { androidEvents, iosEvents };
}

/**
 * Merges generated Agent Scenario Loop package-script snippets into the app package.json.
 *
 * @param {string} appRoot
 * @returns {Record<string, string>}
 */
function mergeGeneratedScripts(appRoot: string): Record<string, string> {
  const packagePath = path.join(appRoot, 'package.json');
  const packageJson = readJson(packagePath) as { scripts?: Record<string, string>; [key: string]: unknown };
  const generatedScripts = readJson(path.join(appRoot, 'asl', 'package-scripts.json')) as Record<string, string>;
  packageJson.scripts = {
    ...(packageJson.scripts ?? {}),
    ...generatedScripts,
  };
  writeJson(packagePath, packageJson);
  return generatedScripts;
}

/**
 * Merges the generated runtime-artifact ignore snippet into the fixture app.
 *
 * @param {string} appRoot
 * @returns {void}
 */
function mergeGitignoreSnippet(appRoot: string): void {
  const gitignorePath = path.join(appRoot, '.gitignore');
  const snippet = fs.readFileSync(path.join(appRoot, 'asl', 'gitignore-snippet'), 'utf8').trim();
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8').trim() : '';
  fs.writeFileSync(
    gitignorePath,
    `${[existing, snippet].filter(Boolean).join('\n\n')}\n`,
    'utf8',
  );
}

/**
 * Replaces scaffold placeholders with realistic app identifiers before validation.
 *
 * @param {string} appRoot
 * @returns {void}
 */
function replaceConfigPlaceholders(appRoot: string): void {
  const configPath = path.join(appRoot, 'asl.config.json');
  const config = readJson(configPath) as Record<string, any>;
  config.projectName = 'consumer-rehearsal';
  config.app = {
    ...(config.app ?? {}),
    displayName: 'Consumer Rehearsal',
    scheme: 'consumer-rehearsal',
    profileSessionScheme: 'consumer-rehearsal',
    iosBundleId: 'dev.agent-scenario-loop.consumer-rehearsal',
    androidPackage: 'dev.agentscenarioloop.consumerrehearsal',
    ios: {
      ...((config.app ?? {}).ios ?? {}),
      xcodeScheme: 'ConsumerRehearsal',
    },
  };
  writeJson(configPath, config);
}

/**
 * Asserts that the installed package can initialize and validate an existing app.
 *
 * @param {{appRoot: string, env: NodeJS.ProcessEnv, tarballPath: string}} options
 * @returns {void}
 */
function rehearseConsumerInstall({
  appRoot,
  env,
  tarballPath,
}: {
  appRoot: string;
  env: NodeJS.ProcessEnv;
  tarballPath: string;
}): void {
  writeExistingAppFixture(appRoot);
  run('npm', ['install', tarballPath, '--ignore-scripts'], {
    cwd: appRoot,
    env,
  });
  run(packageBinPath(appRoot, 'asl-init'), ['--out', appRoot, '--scenario', 'Account Overview'], {
    cwd: appRoot,
    env,
  });

  const generatedScripts = mergeGeneratedScripts(appRoot);
  mergeGitignoreSnippet(appRoot);
  replaceConfigPlaceholders(appRoot);
  const profileEvents = writeProfileEventFixtures(appRoot);

  const packageJson = readJson(path.join(appRoot, 'package.json')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts.start, 'react-native start');
  assert.equal(packageJson.scripts.test, 'node --version');
  for (const scriptName of Object.keys(generatedScripts)) {
    assert.equal(typeof packageJson.scripts[scriptName], 'string', `${scriptName} should be merged`);
  }

  run('npm', ['run', 'asl:check:ios', '--silent'], {
    cwd: appRoot,
    env,
  });
  run('npm', ['run', 'asl:check:android', '--silent'], {
    cwd: appRoot,
    env,
  });
  run('npm', ['run', 'asl:profile:ios', '--silent'], {
    cwd: appRoot,
    env: { ...env, ASL_PROFILE_IOS_EVENTS: profileEvents.iosEvents },
  });
  run('npm', ['run', 'asl:profile:android', '--silent'], {
    cwd: appRoot,
    env: { ...env, ASL_PROFILE_ANDROID_EVENTS: profileEvents.androidEvents },
  });
  run('npm', ['run', 'asl:profile:ios:provider', '--silent'], {
    cwd: appRoot,
    env: { ...env, ASL_PROFILE_IOS_EVENTS: profileEvents.iosEvents },
  });
  run('npm', ['run', 'asl:profile:android:provider', '--silent'], {
    cwd: appRoot,
    env: { ...env, ASL_PROFILE_ANDROID_EVENTS: profileEvents.androidEvents },
  });
  run('npm', ['run', 'asl:validate', '--silent'], {
    cwd: appRoot,
    env,
  });

  const validationPath = path.join(appRoot, 'artifacts', 'asl', 'project-validation', 'project-validation.json');
  const validation = readJson(validationPath) as Record<string, any>;
  assert.equal(validation.status, 'passed');
  assert.equal(validation.appHelper.status, 'present');
  assert.equal(validation.scripts.status, 'present');
  assert.deepEqual(validation.warnings, []);
  assert.equal(
    validation.nextActions.some((action: { code: string }) => action.code === 'replace_config_placeholders'),
    false,
  );
  assert.deepEqual(
    validation.plans
      .map((plan: { healthStatus: string; platform: string; scenarioId: string }) => ({
        healthStatus: plan.healthStatus,
        platform: plan.platform,
        scenarioId: plan.scenarioId,
      }))
      .sort((left: { platform: string }, right: { platform: string }) => left.platform.localeCompare(right.platform)),
    [
      { healthStatus: 'passed', platform: 'android', scenarioId: 'account-overview' },
      { healthStatus: 'passed', platform: 'ios', scenarioId: 'account-overview' },
    ],
  );

  for (const [platform, runId] of [['ios', 'account-overview-ios'], ['android', 'account-overview-android']] as const) {
    const runDir = path.join(appRoot, 'artifacts', 'asl', platform, 'account-overview', runId);
    const health = readJson(path.join(runDir, 'health.json')) as { healthStatus: string };
    const verdict = readJson(path.join(runDir, 'verdict.json')) as { verdictStatus: string };
    assert.equal(health.healthStatus, 'passed');
    assert.equal(verdict.verdictStatus, 'passed');
  }

  for (const [platform, runId] of [
    ['ios', 'account-overview-ios-provider'],
    ['android', 'account-overview-android-provider'],
  ] as const) {
    const providerRunDir = path.join(appRoot, 'artifacts', 'asl', platform, 'account-overview', runId);
    const providerManifest = readJson(path.join(providerRunDir, 'manifest.json')) as {
      artifacts?: {
        evidenceAttachments?: Array<{ channel: string; kind: string; path: string; sourceFileName: string }>;
        signals?: { js?: string[]; memory?: string[]; network?: string[] };
      };
    };
    assert.deepEqual(providerManifest.artifacts?.signals?.js, ['signals/js/profiler.json']);
    assert.deepEqual(providerManifest.artifacts?.signals?.memory, ['signals/memory/memory.json']);
    assert.deepEqual(providerManifest.artifacts?.signals?.network, ['signals/network/network.har']);
    assert.deepEqual(
      providerManifest.artifacts?.evidenceAttachments?.map((attachment) => ({
        channel: attachment.channel,
        kind: attachment.kind,
        path: attachment.path,
        sourceFileName: attachment.sourceFileName,
      })),
      [
        {
          channel: 'provider',
          kind: 'accessibility',
          path: 'raw/providers/example-evidence-provider/accessibility.json',
          sourceFileName: 'accessibility.json',
        },
        {
          channel: 'provider',
          kind: 'profiler',
          path: 'raw/providers/example-evidence-provider/profiler.json',
          sourceFileName: 'profiler.json',
        },
        {
          channel: 'signal',
          kind: 'js',
          path: 'signals/js/profiler.json',
          sourceFileName: 'profiler.json',
        },
        {
          channel: 'signal',
          kind: 'memory',
          path: 'signals/memory/memory.json',
          sourceFileName: 'memory.json',
        },
        {
          channel: 'signal',
          kind: 'network',
          path: 'signals/network/network.har',
          sourceFileName: 'network.har',
        },
      ],
    );
  }
}

/**
 * Runs the packed-package consumer rehearsal.
 *
 * @returns {void}
 */
function main(): void {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-consumer-rehearsal-'));
  const env = createRehearsalEnv(tempRoot);
  const appRoot = path.join(tempRoot, 'existing-mobile-app');
  fs.mkdirSync(appRoot, { recursive: true });

  try {
    const tarballPath = packPackage({
      env,
      packageRoot,
      packDir: path.join(tempRoot, 'pack'),
    });
    rehearseConsumerInstall({
      appRoot,
      env,
      tarballPath,
    });
    process.stdout.write(`consumer rehearsal passed: ${appRoot}\n`);
  } catch (error) {
    console.error(`consumer rehearsal temp kept at: ${tempRoot}`);
    throw error;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  createRehearsalEnv,
  mergeGeneratedScripts,
  packageBinPath,
  packPackage,
  readJson,
  rehearseConsumerInstall,
  replaceConfigPlaceholders,
  run,
  writeExistingAppFixture,
  writeProfileEventFixtures,
  writeJson,
};
