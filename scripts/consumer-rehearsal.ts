#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type ExecFileSyncError = Error & {
  signal?: string | null;
  status?: number | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

type FailedRunOutput = {
  status: number | null;
  stderr: string;
  stdout: string;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

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
  env.npm_config_fetch_retries = '0';
  env.npm_config_fetch_timeout = '60000';
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  return env;
}

/**
 * Resolves an existing tarball from the environment, when a parent release gate
 * has already packed the current package.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
function resolveProvidedTarball(env: NodeJS.ProcessEnv): string | null {
  const tarballPath = env.ASL_PACKAGE_TARBALL ? path.resolve(env.ASL_PACKAGE_TARBALL) : '';
  if (!tarballPath) {
    return null;
  }

  assert.equal(fs.existsSync(tarballPath), true, `ASL_PACKAGE_TARBALL does not exist: ${tarballPath}`);
  assert.match(path.basename(tarballPath), /^agent-scenario-loop-.+\.tgz$/u, 'ASL_PACKAGE_TARBALL must point to an agent-scenario-loop tarball');
  return tarballPath;
}

/**
 * Resolves the per-command timeout for package gate child processes.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolveCommandTimeoutMs(env: NodeJS.ProcessEnv): number {
  const timeoutMs = Number.parseInt(env.ASL_PACKAGE_GATE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS;
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
      timeout: resolveCommandTimeoutMs(options.env),
    });
  } catch (error) {
    const failed = error as ExecFileSyncError;
    const stdout = Buffer.isBuffer(failed.stdout) ? failed.stdout.toString('utf8') : String(failed.stdout ?? '');
    const status = failed.signal === 'SIGTERM' ? 'timeout' : failed.status ?? 'unknown';
    throw new Error(`${command} ${args.join(' ')} failed with status ${status}\n${stdout}`);
  }
}

/**
 * Runs a command that must fail and returns captured output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {FailedRunOutput}
 */
function runExpectFailure(command: string, args: string[], options: RunOptions): FailedRunOutput {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: resolveCommandTimeoutMs(options.env),
    });
    throw new Error(`Expected command to fail, but it passed with stdout: ${stdout}`);
  } catch (error) {
    const failed = error as ExecFileSyncError;
    if (failed.message.startsWith('Expected command to fail')) {
      throw failed;
    }

    return {
      status: failed.status ?? null,
      stderr: Buffer.isBuffer(failed.stderr) ? failed.stderr.toString('utf8') : String(failed.stderr ?? ''),
      stdout: Buffer.isBuffer(failed.stdout) ? failed.stdout.toString('utf8') : String(failed.stdout ?? ''),
    };
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
      '2026-01-01T00:00:00.000Z consumer-ios [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-ios","iteration":1,"atMs":0,"helperVersion":"1.1.0"}',
      '2026-01-01T00:00:00.700Z consumer-ios [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-ios","iteration":1,"atMs":700,"helperVersion":"1.1.0"}',
      '2026-01-01T00:00:01.000Z consumer-ios [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-ios","iteration":2,"atMs":1000,"helperVersion":"1.1.0"}',
      '2026-01-01T00:00:01.760Z consumer-ios [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-ios","iteration":2,"atMs":1760,"helperVersion":"1.1.0"}',
      '2026-01-01T00:00:02.000Z consumer-ios [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-ios","iteration":3,"atMs":2000,"helperVersion":"1.1.0"}',
      '2026-01-01T00:00:02.830Z consumer-ios [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-ios","iteration":3,"atMs":2830,"helperVersion":"1.1.0"}',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    androidEvents,
    [
      '2026-01-01T00:10:00.000Z consumer-android [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-android","iteration":1,"atMs":0,"helperVersion":"1.1.0"}',
      '2026-01-01T00:10:00.820Z consumer-android [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-android","iteration":1,"atMs":820,"helperVersion":"1.1.0"}',
      '2026-01-01T00:10:01.000Z consumer-android [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-android","iteration":2,"atMs":1000,"helperVersion":"1.1.0"}',
      '2026-01-01T00:10:01.870Z consumer-android [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-android","iteration":2,"atMs":1870,"helperVersion":"1.1.0"}',
      '2026-01-01T00:10:02.000Z consumer-android [profile-event] {"event":"first_journey_started","scenario":"account-overview","runId":"account-overview-android","iteration":3,"atMs":2000,"helperVersion":"1.1.0"}',
      '2026-01-01T00:10:02.940Z consumer-android [profile-event] {"event":"first_journey_completed","scenario":"account-overview","runId":"account-overview-android","iteration":3,"atMs":2940,"helperVersion":"1.1.0"}',
      '',
    ].join('\n'),
    'utf8',
  );

  return { androidEvents, iosEvents };
}

/**
 * Writes a tiny Argent-compatible command for consumer-script rehearsal.
 *
 * @param {string} filePath
 * @returns {void}
 */
function writeFakeArgent(filePath: string): void {
  const scriptPath = filePath.endsWith('.cmd') ? filePath.replace(/\.cmd$/u, '.js') : filePath;
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const key = args.join(' ');",
    "function ok(stdout = '{\"description\":\"Consumer Rehearsal first journey complete\"}\\n') { process.stdout.write(stdout); process.exit(0); }",
    "if (args.includes('launch-app')) ok('{\"success\":true}\\n');",
    "if (args.includes('describe')) ok();",
    "if (args.includes('screenshot')) {",
    "  const screenshotPath = path.join(path.dirname(process.argv[1]), 'fake-argent-screenshot.png');",
    "  fs.writeFileSync(screenshotPath, 'fake screenshot', 'utf8');",
    "  ok(`Saved screenshot: ${screenshotPath}\\n`);",
    "}",
    "if (args.includes('gesture-tap')) ok('{\"success\":true}\\n');",
    "if (args.includes('gesture-custom')) ok('{\"events\":3}\\n');",
    "if (args.includes('gesture-pinch')) ok('{\"pinched\":true}\\n');",
    "if (args.includes('gesture-rotate')) ok('{\"rotated\":true}\\n');",
    "if (args.includes('gesture-swipe')) ok('{\"success\":true}\\n');",
    "process.stderr.write(`unexpected fake Argent command: ${key}\\n`);",
    "process.exit(1);",
    '',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  if (filePath.endsWith('.cmd')) {
    fs.writeFileSync(filePath, `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(scriptPath)}" %*\r\n`, {
      mode: 0o755,
    });
  }
}

/**
 * Asserts one generated Argent package script can run from the installed app.
 *
 * @param {{appRoot: string, env: NodeJS.ProcessEnv, fakeArgentPath: string, platform: 'android' | 'ios'}} options
 * @returns {void}
 */
function assertArgentScriptRuns({
  appRoot,
  env,
  fakeArgentPath,
  platform,
}: {
  appRoot: string;
  env: NodeJS.ProcessEnv;
  fakeArgentPath: string;
  platform: 'android' | 'ios';
}): void {
  run('npm', ['run', `asl:argent:${platform}`, '--silent'], {
    cwd: appRoot,
    env: {
      ...env,
      ASL_ARGENT_BIN: fakeArgentPath,
    },
  });

  const runDir = path.join(
    appRoot,
    'artifacts',
    'asl',
    `argent-${platform}`,
  );
  const health = readJson(path.join(runDir, 'health.json')) as {
    healthStatus: string;
    runId: string;
    scenarioId: string;
  };
  const verdict = readJson(path.join(runDir, 'verdict.json')) as {
    runId: string;
    scenarioId: string;
    verdictStatus: string;
  };
  const metadata = readJson(path.join(runDir, 'raw', 'argent-metadata.json')) as {
    driverActions?: Array<{ driverAction?: string; rawPath?: string }>;
  };

  assert.equal(health.healthStatus, 'passed');
  assert.equal(health.runId, `account-overview-${platform}-argent`);
  assert.equal(health.scenarioId, 'account-overview');
  assert.equal(verdict.runId, `account-overview-${platform}-argent`);
  assert.equal(verdict.scenarioId, 'account-overview');
  assert.equal(verdict.verdictStatus, 'not_evaluated');
  assert.deepEqual(metadata.driverActions?.map((action) => action.driverAction), ['launch', 'tap', 'screenshot']);
  assert.equal(fs.existsSync(path.join(runDir, 'captures', 'fake-argent-screenshot.png')), true);
}

/**
 * Writes a small, valid platform live-proof artifact with all local pointers present.
 *
 * @param {{appRoot: string, platform: 'android' | 'ios'}} options
 * @returns {string}
 */
function writeConsumerLiveProofFixture({
  appRoot,
  platform,
}: {
  appRoot: string;
  platform: 'android' | 'ios';
}): string {
  const scenarioId = 'account-overview';
  const runId = `${platform}-live-proof-rehearsal`;
  const platformRoot = path.join(appRoot, 'artifacts', 'asl', `${platform}-live`);
  const liveProofDir = path.join(platformRoot, '_live-proof', `${platform}-live-proof`);
  const preflightDir = path.join(platformRoot, 'preflight');
  const profileDir = path.join(platformRoot, scenarioId, `${scenarioId}-${platform}-live`);
  const interactionDir = path.join(platformRoot, 'interactions', `${scenarioId}-${platform}-agent-device`);
  const comparisonBaselineDir = path.join(platformRoot, 'baselines', scenarioId);
  const comparisonDir = path.join(platformRoot, 'comparisons', scenarioId, `${scenarioId}-${platform}-live`);

  for (const dir of [
    liveProofDir,
    preflightDir,
    profileDir,
    interactionDir,
    path.join(interactionDir, 'captures'),
    comparisonBaselineDir,
    comparisonDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const summaryPath of [
    path.join(liveProofDir, 'agent-summary.md'),
    path.join(preflightDir, 'agent-summary.md'),
    path.join(profileDir, 'agent-summary.md'),
    path.join(interactionDir, 'agent-summary.md'),
    path.join(comparisonDir, 'agent-summary.md'),
  ]) {
    fs.writeFileSync(summaryPath, `# ${platform} ${scenarioId} rehearsal\n`, 'utf8');
  }
  fs.writeFileSync(path.join(interactionDir, 'captures', 'final.png'), 'fake screenshot', 'utf8');

  const liveProofPath = path.join(liveProofDir, 'live-proof.json');
  writeJson(liveProofPath, {
    schemaVersion: '1.0.0',
    platform,
    runId,
    status: 'passed',
    outputDir: path.relative(appRoot, liveProofDir),
    preflight: {
      runId: `${platform}-preflight`,
      runDir: path.relative(appRoot, preflightDir),
      summaryPath: path.relative(appRoot, path.join(preflightDir, 'agent-summary.md')),
      healthStatus: 'passed',
      verdictStatus: 'passed',
    },
    profiles: [
      {
        label: 'startup',
        scenarioId,
        runId: `${scenarioId}-${platform}-live`,
        runDir: path.relative(appRoot, profileDir),
        summaryPath: path.relative(appRoot, path.join(profileDir, 'agent-summary.md')),
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
    ],
    interactionProofs: [
      {
        label: 'agent-device startup',
        runnerId: 'agent-device',
        scenarioId,
        runId: `${scenarioId}-${platform}-agent-device`,
        runDir: path.relative(appRoot, interactionDir),
        summaryPath: path.relative(appRoot, path.join(interactionDir, 'agent-summary.md')),
        healthStatus: 'passed',
        verdictStatus: 'not_evaluated',
        captures: {
          screenshots: ['captures/final.png'],
        },
      },
    ],
    comparisons: [
      {
        label: 'startup',
        scenarioId,
        runId: `${scenarioId}-${platform}-live`,
        status: 'better',
        baselineDir: path.relative(appRoot, comparisonBaselineDir),
        comparisonDir: path.relative(appRoot, comparisonDir),
        summaryPath: path.relative(appRoot, path.join(comparisonDir, 'agent-summary.md')),
        reason: null,
        metricSummary: {
          counts: {
            better: 1,
            worse: 0,
            unchanged: 0,
            inconclusive: 0,
            low_confidence: 0,
          },
          notableMetrics: [
            {
              name: 'durationMs.p50',
              status: 'better',
              unit: 'ms',
              baseline: 900,
              current: 800,
              delta: -100,
            },
          ],
        },
      },
    ],
    comparisonCounts: {
      better: 1,
      worse: 0,
      unchanged: 0,
      mixed: 0,
      inconclusive: 0,
      low_confidence: 0,
      skipped: 0,
    },
    comparisonStatus: 'improved',
    nextAction: {
      code: 'inspect_summary',
      summary: 'Inspect the rehearsal proof summary.',
    },
    summary: `${platform} rehearsal live proof passed.`,
  });

  return path.relative(appRoot, liveProofPath);
}

/**
 * Asserts the generated two-platform live-proof script works from an installed app.
 *
 * @param {{appRoot: string, env: NodeJS.ProcessEnv}} options
 * @returns {void}
 */
function assertGeneratedLiveProofGateRuns({
  appRoot,
  env,
}: {
  appRoot: string;
  env: NodeJS.ProcessEnv;
}): void {
  const androidLiveProof = writeConsumerLiveProofFixture({ appRoot, platform: 'android' });
  const iosLiveProof = writeConsumerLiveProofFixture({ appRoot, platform: 'ios' });

  run('npm', ['run', 'asl:live-proof:both', '--silent'], {
    cwd: appRoot,
    env: {
      ...env,
      ASL_ANDROID_LIVE_PROOF: androidLiveProof,
      ASL_IOS_LIVE_PROOF: iosLiveProof,
      ASL_REQUIRE_LIVE_PROOF_ARTIFACTS: '1',
    },
  });

  const proofSet = readJson(path.join(appRoot, 'artifacts', 'asl', 'live-proof-set', 'live-proof-set.json')) as {
    nextAction: { code: string };
    presentPlatforms: string[];
    proofCount: number;
    requiredPlatforms: string[];
    status: string;
  };
  const summary = fs.readFileSync(path.join(appRoot, 'artifacts', 'asl', 'live-proof-set', 'agent-summary.md'), 'utf8');

  assert.equal(proofSet.status, 'passed');
  assert.deepEqual(proofSet.requiredPlatforms, ['android', 'ios']);
  assert.deepEqual(proofSet.presentPlatforms, ['android', 'ios']);
  assert.equal(proofSet.proofCount, 2);
  assert.equal(proofSet.nextAction.code, 'inspect_summary');
  assert.match(summary, /Status: passed/u);
  assert.match(summary, /Present platforms: android, ios/u);
  assert.match(summary, /android android-live-proof-rehearsal: status=passed comparison=improved/u);
  assert.match(summary, /ios ios-live-proof-rehearsal: status=passed comparison=improved/u);
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
 * Asserts that installed project validation rejects stale merged package scripts.
 *
 * @param {{appRoot: string, env: NodeJS.ProcessEnv}} options
 * @returns {void}
 */
function assertPackageScriptDriftFails({
  appRoot,
  env,
}: {
  appRoot: string;
  env: NodeJS.ProcessEnv;
}): void {
  const packagePath = path.join(appRoot, 'package.json');
  const packageJson = readJson(packagePath) as { scripts: Record<string, string> };
  packageJson.scripts['asl:profile:android'] = [
    'asl-profile-android',
    '--config asl.config.json',
    '--scenario scenarios/mobile/account-overview.json',
    '--comparison-lane stale-android',
    '--out artifacts/asl/android/stale',
    '--run-id stale-android',
  ].join(' ');
  packageJson.scripts['asl:android:live'] = [
    'asl-live-android',
    '--config asl.config.json',
    '--scenario scenarios/mobile/account-overview.json',
    '--out artifacts/asl/android-live',
  ].join(' ');
  writeJson(packagePath, packageJson);

  const outDir = path.join(appRoot, 'artifacts', 'asl', 'project-validation-drift');
  const failure = runExpectFailure(packageBinPath(appRoot, 'asl-validate-project'), [
    '--root',
    appRoot,
    '--platform',
    'all',
    '--out',
    outDir,
  ], {
    cwd: appRoot,
    env,
  });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stdout, /project validation failed/u);
  assert.match(failure.stdout, /App package\.json ASL script\(s\) differ/u);

  const validation = readJson(path.join(outDir, 'project-validation.json')) as Record<string, any>;
  assert.equal(validation.status, 'failed');
  assert.deepEqual(validation.scripts.mismatchedPackageJsonScripts, ['asl:profile:android', 'asl:android:live']);
  assert.equal(
    validation.nextActions.some((action: { code: string }) => action.code === 'merge_package_scripts'),
    true,
  );
}

/**
 * Asserts that installed project validation rejects invalid path config.
 *
 * @param {{appRoot: string, env: NodeJS.ProcessEnv}} options
 * @returns {void}
 */
function assertProjectPathConfigFails({
  appRoot,
  env,
}: {
  appRoot: string;
  env: NodeJS.ProcessEnv;
}): void {
  const configPath = path.join(appRoot, 'asl.config.json');
  const originalConfig = readJson(configPath) as Record<string, any>;
  const brokenConfig = JSON.parse(JSON.stringify(originalConfig)) as Record<string, any>;
  brokenConfig.paths = {
    ...(brokenConfig.paths ?? {}),
    androidArtifactsRoot: 42,
  };
  delete brokenConfig.paths.scenarioRoot;
  delete brokenConfig.paths.iosScenarioRoot;
  delete brokenConfig.paths.androidScenarioRoot;
  writeJson(configPath, brokenConfig);

  try {
    const outDir = path.join(appRoot, 'artifacts', 'asl', 'project-validation-path-config');
    const failure = runExpectFailure(packageBinPath(appRoot, 'asl-validate-project'), [
      '--root',
      appRoot,
      '--platform',
      'all',
      '--out',
      outDir,
    ], {
      cwd: appRoot,
      env,
    });
    assert.notEqual(failure.status, 0);
    assert.match(failure.stdout, /project validation failed/u);
    assert.match(failure.stdout, /Project config is missing required field\(s\)/u);
    assert.match(failure.stdout, /Project config has invalid required field\(s\)/u);

    const validation = readJson(path.join(outDir, 'project-validation.json')) as Record<string, any>;
    assert.equal(validation.status, 'failed');
    assert.equal(validation.config.status, 'incomplete');
    assert.deepEqual(validation.config.missingFields, [
      'paths.scenarioRoot or paths.iosScenarioRoot',
      'paths.scenarioRoot or paths.androidScenarioRoot',
    ]);
    assert.deepEqual(validation.config.invalidFields, ['paths.androidArtifactsRoot']);
    assert.equal(
      validation.nextActions.some((action: { code: string }) => action.code === 'fix_project_config'),
      true,
    );
  } finally {
    writeJson(configPath, originalConfig);
  }
}

/**
 * Asserts that the installed package can initialize and validate an existing app.
 *
 * @param {{appRoot: string, env: NodeJS.ProcessEnv, tarballPath: string, sourceRevision: string}} options
 * @returns {void}
 */
function rehearseConsumerInstall({
  appRoot,
  env,
  tarballPath,
  sourceRevision,
}: {
  appRoot: string;
  env: NodeJS.ProcessEnv;
  tarballPath: string;
  sourceRevision: string;
}): void {
  writeExistingAppFixture(appRoot);
  run('npm', ['install', tarballPath, '--ignore-scripts'], {
    cwd: appRoot,
    env,
  });
  const installedPackage = readJson(path.join(appRoot, 'node_modules', 'agent-scenario-loop', 'package.json')) as {
    name: string;
    version: string;
  };
  const packageIntegrity = `sha256:${createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex')}`;
  const quickProofScriptPath = path.join(appRoot, 'quick-proof-rehearsal.js');
  fs.writeFileSync(quickProofScriptPath, [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const asl = require('agent-scenario-loop');",
    "(async () => {",
    "  const artifact = await asl.coordinateQuickProof({",
    "    runId: 'consumer-quick-proof',",
    "    scenarioId: 'account-overview',",
    "    goalId: 'consumer-rehearsal',",
    `    source: { revision: ${JSON.stringify(sourceRevision)}, packageName: ${JSON.stringify(installedPackage.name)}, packageVersion: ${JSON.stringify(installedPackage.version)}, packageIntegrity: ${JSON.stringify(packageIntegrity)} },`,
    "    authorization: {",
    "      grantId: 'consumer-grant', goalId: 'consumer-rehearsal', operations: ['inspect'],",
    "      expiresAt: '2099-01-01T00:00:00.000Z', delegationChain: ['consumer-rehearsal'],",
    "    },",
    "    requirements: {",
    "      operations: [{ operation: 'inspect', requiredArguments: ['target'] }],",
    "      identities: [{ name: 'target', expected: 'consumer-target' }],",
    "    },",
    "    budgets: { setupMs: 1000, totalMs: 2000, minimumProductRatio: 0.5 },",
    "    adapters: [{",
    "      id: 'consumer-adapter', tier: 'trusted-automated',",
    "      async discover() { return { status: 'passed', capabilities: [{ operation: 'inspect', supportedArguments: ['target'] }], identities: [{ name: 'target', status: 'unresolved-until-observed' }] }; },",
    "      async preflight() { return { status: 'passed', identities: [{ name: 'target', status: 'observed', observed: 'consumer-target' }] }; },",
    "      async runProduct(context) { await context.beginProductAction(); return { status: 'passed', productActionStarted: true }; },",
    "      async cleanup() { return { status: 'passed' }; },",
    "    }],",
    "  });",
    "  assert.equal(artifact.status, 'product-executed');",
    "  assert.equal(artifact.decision.code, 'product-completed');",
    `  assert.equal(artifact.source.revision, ${JSON.stringify(sourceRevision)});`,
    `  assert.equal(artifact.source.packageVersion, ${JSON.stringify(installedPackage.version)});`,
    `  assert.equal(artifact.source.packageIntegrity, ${JSON.stringify(packageIntegrity)});`,
    "  const outDir = path.join(process.cwd(), 'artifacts', 'asl', 'quick-proof-rehearsal');",
    "  const written = await asl.writeQuickProofArtifacts({ outDir, artifact });",
    "  assert.equal(JSON.parse(fs.readFileSync(written.artifactPath, 'utf8')).status, 'product-executed');",
    "  assert.match(fs.readFileSync(written.summaryPath, 'utf8'), /Product interpretation remains/);",
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join('\n'), 'utf8');
  run(process.execPath, [quickProofScriptPath], {
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
  const fakeArgentPath = path.join(
    appRoot,
    process.platform === 'win32' ? 'fake-argent.cmd' : 'fake-argent',
  );
  writeFakeArgent(fakeArgentPath);

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
  assertArgentScriptRuns({ appRoot, env, fakeArgentPath, platform: 'ios' });
  assertArgentScriptRuns({ appRoot, env, fakeArgentPath, platform: 'android' });
  assertGeneratedLiveProofGateRuns({ appRoot, env });
  run('npm', ['run', 'asl:validate', '--silent'], {
    cwd: appRoot,
    env,
  });

  const validationPath = path.join(appRoot, 'artifacts', 'asl', 'project-validation', 'project-validation.json');
  const validation = readJson(validationPath) as Record<string, any>;
  assert.equal(validation.status, 'passed');
  assert.equal(validation.appHelper.status, 'present');
  assert.deepEqual(validation.config.customDrivers, []);
  assert.deepEqual(validation.config.externalTargetDrivers, ['xcodebuildmcp']);
  assert.deepEqual(validation.config.packageSupportedDrivers, ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl']);
  assert.deepEqual(validation.config.supportedDrivers, ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl', 'xcodebuildmcp']);
  assert.deepEqual(validation.config.missingSupportedDrivers, []);
  const realAppRoot = fs.realpathSync(appRoot);
  assert.deepEqual(
    validation.scenarioCandidateDirectories.map((directory: string) => path.relative(realAppRoot, fs.realpathSync(directory))),
    [
      'scenarios',
      path.join('scenarios', 'mobile'),
    ],
  );
  assert.equal(validation.scripts.status, 'present');
  assert.equal(validation.scripts.packageJsonStatus, 'present');
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
        {
          channel: 'provider',
          kind: 'nativePerformance',
          path: 'raw/providers/example-evidence-provider/native-performance.json',
          sourceFileName: 'native-performance.json',
        },
      ],
    );
  }

  assertProjectPathConfigFails({ appRoot, env });
  assertPackageScriptDriftFails({ appRoot, env });
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
    const tarballPath = resolveProvidedTarball(env) ?? packPackage({
      env,
      packageRoot,
      packDir: path.join(tempRoot, 'pack'),
    });
    const packageDigest = createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex');
    const sourceRevision = `package-sha256:${packageDigest}`;
    rehearseConsumerInstall({
      appRoot,
      env,
      tarballPath,
      sourceRevision,
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
  resolveProvidedTarball,
  run,
  runExpectFailure,
  writeFakeArgent,
  writeExistingAppFixture,
  writeProfileEventFixtures,
  writeJson,
};
