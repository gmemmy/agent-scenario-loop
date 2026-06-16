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

type FailedRunOutput = {
  status: number | null;
  stderr: string;
  stdout: string;
};

type ExecFileSyncError = Error & {
  status?: number | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

type ExampleProfileRun = {
  binaryName: string;
  eventLog: string;
  platform: string;
  runId: string;
  scenario: string;
};

const EXAMPLE_PROFILE_RUNS: ExampleProfileRun[] = [
  {
    binaryName: 'asl-profile-ios',
    eventLog: 'app-startup.log',
    platform: 'ios',
    runId: 'example-startup',
    scenario: 'app-startup.json',
  },
  {
    binaryName: 'asl-profile-ios',
    eventLog: 'open-close-cycle.log',
    platform: 'ios',
    runId: 'example-open-close',
    scenario: 'open-close-cycle.json',
  },
  {
    binaryName: 'asl-profile-ios',
    eventLog: 'scroll-settle.log',
    platform: 'ios',
    runId: 'example-scroll',
    scenario: 'scroll-settle.json',
  },
  {
    binaryName: 'asl-profile-android',
    eventLog: 'android-app-startup.log',
    platform: 'android',
    runId: 'android-example-startup',
    scenario: 'app-startup.json',
  },
  {
    binaryName: 'asl-profile-android',
    eventLog: 'android-open-close-cycle.log',
    platform: 'android',
    runId: 'android-example-open-close',
    scenario: 'open-close-cycle.json',
  },
  {
    binaryName: 'asl-profile-android',
    eventLog: 'android-scroll-settle.log',
    platform: 'android',
    runId: 'android-example-scroll',
    scenario: 'scroll-settle.json',
  },
];

const PACKED_FILE_ALLOWLIST = [
  /^LICENSE$/u,
  /^README\.md$/u,
  /^package\.json$/u,
  /^app\/profile-session\.ts$/u,
  /^core\/config-template\.json$/u,
  /^dist\/index\.(?:js|d\.ts)$/u,
  /^dist\/core\/[a-z-]+\.(?:js|d\.ts)$/u,
  /^dist\/runner\/[a-z-]+\.(?:js|d\.ts)$/u,
  /^docs\/[a-z-]+\.md$/u,
  /^examples\/.+/u,
  /^schemas\/[a-z-]+\.schema\.json$/u,
];

/**
 * Lists every file under a directory using relative POSIX-style paths.
 *
 * @param {string} rootDir
 * @param {string} [relativeDir]
 * @returns {string[]}
 */
function listFiles(rootDir: string, relativeDir = ''): string[] {
  const absoluteDir = path.join(rootDir, relativeDir);
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry: import('node:fs').Dirent) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(rootDir, relativePath);
    }

    if (!entry.isFile()) {
      return [];
    }

    return [relativePath.split(path.sep).join('/')];
  });
}

/**
 * Returns whether a packed file belongs to the intentional public package surface.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isAllowedPackedFile(filePath: string): boolean {
  return PACKED_FILE_ALLOWLIST.some((pattern) => pattern.test(filePath));
}

/**
 * Creates a clean npm environment for repeatable package smoke checks.
 *
 * @param {string} tempRoot
 * @returns {NodeJS.ProcessEnv}
 */
function createSmokeEnv(tempRoot: string): NodeJS.ProcessEnv {
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
 * Runs a command and returns stdout while preserving stderr for failures.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {string}
 */
function run(command: string, args: string[], options: RunOptions): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * Runs a command that is expected to fail and returns captured output.
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
 * Writes a tiny adb-compatible command for installed-package smoke tests.
 *
 * @param {{filePath: string, logcatText: string, packageName: string}} options
 * @returns {void}
 */
function writeFakeAdb({
  filePath,
  logcatText,
  packageName,
}: {
  filePath: string;
  logcatText: string;
  packageName: string;
}): void {
  const scriptPath = filePath.endsWith('.cmd') ? filePath.replace(/\.cmd$/u, '.js') : filePath;
  const script = [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "const key = args.join(' ');",
    `const logcatText = ${JSON.stringify(logcatText)};`,
    `const packageName = ${JSON.stringify(packageName)};`,
    "const responses = new Map([",
    "  ['version', { stdout: 'Android Debug Bridge version 1.0.41\\n' }],",
    "  ['devices -l', { stdout: 'List of devices attached\\nemulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64\\n' }],",
    "  ['-s emulator-5554 shell getprop ro.product.model', { stdout: 'Pixel 6\\n' }],",
    "  ['-s emulator-5554 shell getprop ro.build.version.release', { stdout: '15\\n' }],",
    "  ['-s emulator-5554 shell getprop ro.build.version.sdk', { stdout: '35\\n' }],",
    "  [`-s emulator-5554 shell pm path ${packageName}`, { stdout: `package:/data/app/${packageName}/base.apk\\n` }],",
    "  ['-s emulator-5554 logcat -c', { stdout: '' }],",
    "  [`-s emulator-5554 shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`, { stdout: 'Events injected: 1\\n' }],",
    "  ['-s emulator-5554 logcat -d -v time -t 1000', { stdout: logcatText }],",
    "]);",
    "const response = responses.get(key);",
    "if (!response) {",
    "  process.stderr.write(`unexpected fake adb command: ${key}\\n`);",
    "  process.exit(1);",
    "}",
    "process.stdout.write(response.stdout ?? '');",
    "process.stderr.write(response.stderr ?? '');",
    "process.exit(response.exitCode ?? 0);",
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
 * Returns the platform-specific path for a package binary in a temp install.
 *
 * @param {string} installDir
 * @param {string} name
 * @returns {string}
 */
function packageBinPath(installDir: string, name: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(installDir, 'node_modules', '.bin', `${name}${suffix}`);
}

/**
 * Packs, installs, and exercises the public package surface from a temp project.
 *
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-package-smoke-'));
  const packDir = path.join(tempRoot, 'pack');
  const installDir = path.join(tempRoot, 'install');
  const artifactDir = path.join(tempRoot, 'artifacts', 'plan', 'app-startup');
  const env = createSmokeEnv(tempRoot);

  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  try {
    const packOutput = run('npm', ['pack', '--pack-destination', packDir], {
      cwd: repoRoot,
      env,
    });
    const tarballName = packOutput.trim().split(/\n/u).pop();
    assert.ok(tarballName, 'npm pack did not print a tarball name');
    const tarballPath = path.join(packDir, tarballName);
    assert.equal(fs.existsSync(tarballPath), true, `missing packed tarball: ${tarballPath}`);

    run('npm', ['install', tarballPath, '--ignore-scripts'], {
      cwd: installDir,
      env,
    });

    const packageRoot = path.join(installDir, 'node_modules', 'agent-scenario-loop');
    const packedFiles = listFiles(packageRoot);
    const forbiddenPathPatterns = [
      /^\.github\//u,
      /^artifacts\//u,
      /^dist\/scripts\//u,
      /^node_modules\//u,
      /^runner\/__tests__\//u,
      /^scripts\//u,
      new RegExp(['internal', 'roadmap'].join('-'), 'u'),
    ];
    for (const filePath of packedFiles) {
      assert.equal(isAllowedPackedFile(filePath), true, `unexpected public package path: ${filePath}`);
      assert.equal(
        forbiddenPathPatterns.some((pattern) => pattern.test(filePath)),
        false,
        `unexpected file shipped in package: ${filePath}`,
      );
    }

    for (const filePath of packedFiles) {
      const content = fs.readFileSync(path.join(packageRoot, filePath), 'utf8');
      const productName = ['Help', 'Bnk'].join('');
      const productSlug = ['help', 'bnk'].join('');
      const applicationsPath = ['/', 'Applications'].join('');
      const localUserPath = ['/', 'Users', 'sensei'].join('/');
      const privateTempPath = ['private', 'tmp'].join('/');
      const forbiddenContentPattern = new RegExp(
        `${productName}|${productSlug}|${applicationsPath}|${localUserPath}|${privateTempPath}`,
        'u',
      );
      assert.equal(
        forbiddenContentPattern.test(content),
        false,
        `local or product-specific content leaked into ${filePath}`,
      );
    }

    const scenarioPath = path.join(packageRoot, 'examples', 'scenarios', 'mobile', 'app-startup.json');
    const runnerPath = path.join(packageRoot, 'examples', 'runners', 'xcodebuildmcp-ios.json');
    const exampleAppRoot = path.join(packageRoot, 'examples', 'mobile-app');
    run(packageBinPath(installDir, 'asl-check-plan'), [
      '--scenario',
      scenarioPath,
      '--runner',
      runnerPath,
      '--platform',
      'ios',
      '--run-id',
      'package-smoke',
      '--out',
      artifactDir,
    ], {
      cwd: installDir,
      env,
    });

    for (const binaryName of [
      'agent-scenario-loop',
      'asl-android-adb',
      'asl-check-plan',
      'asl-compare',
      'asl-demo-loop',
      'asl-profile-android',
      'asl-profile-ios',
    ]) {
      const helpText = run(packageBinPath(installDir, binaryName), ['--help'], {
        cwd: installDir,
        env,
      });
      assert.match(helpText, /Usage:/u, `${binaryName} did not print usage`);
    }

    for (const exampleRun of EXAMPLE_PROFILE_RUNS) {
      const output = run(packageBinPath(installDir, exampleRun.binaryName), [
        '--config',
        path.join(exampleAppRoot, 'asl.config.json'),
        '--scenario',
        path.join(exampleAppRoot, 'scenarios', exampleRun.platform, exampleRun.scenario),
        '--events',
        path.join(exampleAppRoot, 'event-logs', exampleRun.eventLog),
        '--out',
        path.join(tempRoot, 'example-mobile-app-artifacts', exampleRun.platform),
        '--run-id',
        exampleRun.runId,
      ], {
        cwd: installDir,
        env,
      });
      const runDir = output.trim();
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
      const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health.json'), 'utf8'));
      const verdict = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
      assert.equal(manifest.platform, exampleRun.platform);
      assert.equal(health.healthStatus, 'passed');
      assert.equal(verdict.verdictStatus, 'passed');
    }

    const adbArtifactRoot = path.join(tempRoot, 'adb-artifacts');
    fs.mkdirSync(path.join(adbArtifactRoot, 'raw'), { recursive: true });
    fs.copyFileSync(
      path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'),
      path.join(adbArtifactRoot, 'raw', 'adb-logcat.txt'),
    );
    const adbArtifactProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--adb-artifacts',
      adbArtifactRoot,
      '--out',
      path.join(tempRoot, 'example-mobile-app-adb-artifact-profile'),
      '--run-id',
      'android-example-startup',
    ], {
      cwd: installDir,
      env,
    });
    const adbArtifactProfileRunDir = adbArtifactProfileOutput.trim();
    const adbArtifactManifest = JSON.parse(fs.readFileSync(path.join(adbArtifactProfileRunDir, 'manifest.json'), 'utf8'));
    const adbArtifactCausalRun = JSON.parse(fs.readFileSync(path.join(adbArtifactProfileRunDir, 'causal-run.json'), 'utf8'));
    const adbArtifactHealth = JSON.parse(fs.readFileSync(path.join(adbArtifactProfileRunDir, 'health.json'), 'utf8'));
    const adbArtifactVerdict = JSON.parse(fs.readFileSync(path.join(adbArtifactProfileRunDir, 'verdict.json'), 'utf8'));
    assert.equal(adbArtifactManifest.artifacts.raw.interactionLog, 'raw/adb-logcat.txt');
    assert.equal(adbArtifactManifest.interactionDriver, 'adb-logcat');
    assert.equal(adbArtifactCausalRun.scenario.driver, 'adb-logcat');
    assert.equal(adbArtifactHealth.healthStatus, 'passed');
    assert.equal(adbArtifactVerdict.verdictStatus, 'passed');

    const adbCaptureRunId = 'package-smoke-adb-capture';
    const androidPackageName = 'dev.agentscenarioloop.example';
    const fakeAdbPath = path.join(tempRoot, process.platform === 'win32' ? 'fake-adb.cmd' : 'fake-adb');
    const adbCaptureProfileRoot = path.join(tempRoot, 'adb-capture-profile');
    writeFakeAdb({
      filePath: fakeAdbPath,
      logcatText: fs
        .readFileSync(path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'), 'utf8')
        .replace(/android-example-startup/gu, adbCaptureRunId),
      packageName: androidPackageName,
    });
    const adbCaptureProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--adb-capture',
      '--adb',
      fakeAdbPath,
      '--clear-logcat',
      '--launch',
      '--wait-ms',
      '1',
      '--out',
      adbCaptureProfileRoot,
      '--run-id',
      adbCaptureRunId,
    ], {
      cwd: installDir,
      env,
    });
    const adbCaptureProfileRunDir = adbCaptureProfileOutput.trim();
    const adbCaptureRoot = path.join(adbCaptureProfileRoot, '_adb-captures', adbCaptureRunId);
    const adbCaptureManifest = JSON.parse(fs.readFileSync(path.join(adbCaptureProfileRunDir, 'manifest.json'), 'utf8'));
    const adbCaptureCausalRun = JSON.parse(fs.readFileSync(path.join(adbCaptureProfileRunDir, 'causal-run.json'), 'utf8'));
    const adbCaptureHealth = JSON.parse(fs.readFileSync(path.join(adbCaptureProfileRunDir, 'health.json'), 'utf8'));
    const adbCaptureVerdict = JSON.parse(fs.readFileSync(path.join(adbCaptureProfileRunDir, 'verdict.json'), 'utf8'));
    const adbCaptureRunnerHealth = JSON.parse(fs.readFileSync(path.join(adbCaptureRoot, 'health.json'), 'utf8'));
    assert.equal(adbCaptureProfileRunDir, path.join(adbCaptureProfileRoot, 'app-startup', adbCaptureRunId));
    assert.equal(adbCaptureManifest.artifacts.raw.interactionLog, 'raw/adb-logcat.txt');
    assert.equal(adbCaptureManifest.bundleId, androidPackageName);
    assert.equal(adbCaptureManifest.interactionDriver, 'adb-logcat');
    assert.equal(adbCaptureCausalRun.scenario.driver, 'adb-logcat');
    assert.equal(adbCaptureHealth.healthStatus, 'passed');
    assert.equal(adbCaptureVerdict.verdictStatus, 'passed');
    assert.equal(adbCaptureRunnerHealth.healthStatus, 'passed');
    assert.equal(fs.existsSync(path.join(adbCaptureProfileRunDir, 'raw', 'adb-logcat.txt')), true);

    const missingAdbRunId = 'package-smoke-missing-adb';
    const missingAdbProfileRoot = path.join(tempRoot, 'missing-adb-profile');
    const missingAdb = runExpectFailure(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--adb-capture',
      '--adb',
      path.join(tempRoot, 'missing-adb'),
      '--clear-logcat',
      '--launch',
      '--wait-ms',
      '1',
      '--out',
      missingAdbProfileRoot,
      '--run-id',
      missingAdbRunId,
    ], {
      cwd: installDir,
      env,
    });
    const missingAdbCaptureRoot = path.join(missingAdbProfileRoot, '_adb-captures', missingAdbRunId);
    const missingAdbHealth = JSON.parse(fs.readFileSync(path.join(missingAdbCaptureRoot, 'health.json'), 'utf8'));
    assert.equal(missingAdb.status, 1);
    assert.match(missingAdb.stderr, /Android adb capture failed/u);
    assert.equal(missingAdbHealth.healthStatus, 'failed');
    assert.equal(
      missingAdbHealth.checks.some((check: { code: string }) => check.code === 'adb_unavailable'),
      true,
    );

    const health = JSON.parse(fs.readFileSync(path.join(artifactDir, 'health.json'), 'utf8'));
    assert.equal(health.scenarioId, 'app-startup');
    assert.equal(health.runId, 'package-smoke');
    assert.equal(health.healthStatus, 'passed');

    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.private, false);
    assert.equal(packageJson.publishConfig?.access, 'public');
    assert.equal(packageJson.scripts?.prepublishOnly, 'pnpm release:check');

    const resolveSmokeScript = [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const asl = require('agent-scenario-loop');",
      "assert.equal(asl.ARTIFACT_LAYOUT_VERSION, '1.0.0');",
      "assert.equal(asl.ARTIFACT_FILENAMES.health, 'health.json');",
      "assert.equal(asl.PROFILE_ARTIFACT_FILENAMES.metrics, 'metrics.json');",
      "assert.equal(typeof asl.createArtifactLayout, 'function');",
      "assert.equal(asl.createArtifactLayout({ outputDir: 'run' }).profile.metrics.endsWith('metrics.json'), true);",
      "assert.equal(typeof asl.buildAgentSummaryMarkdown, 'function');",
      "assert.equal(typeof asl.evaluateRunnerCompatibility, 'function');",
      "assert.deepEqual(asl.PRIMARY_RUNNER_PORT, ['prepare', 'launch', 'startSession', 'executeStep', 'waitForTruthEvent', 'captureEvidence', 'stopSession', 'finalize']);",
      "assert.deepEqual(asl.EVIDENCE_PROVIDER_PORT, ['prepare', 'startWindow', 'capture', 'stopWindow', 'finalize']);",
      "assert.deepEqual(asl.DRIVER_PORT, ['tap', 'scroll', 'inspectTree', 'screenshot', 'record', 'readLogs', 'collectPerfSignals']);",
      "assert.deepEqual(asl.ARTIFACT_WRITER_PORT, ['writeJson', 'writeText', 'copyRaw']);",
      "assert.deepEqual(asl.INTERPRETER_PORT, ['interpret']);",
      "assert.equal(typeof asl.validatePortImplementation, 'function');",
      "assert.equal(typeof asl.assertPortImplementation, 'function');",
      "assert.equal(asl.validatePortImplementation({ name: 'driver', implementation: {}, requiredMethods: asl.DRIVER_PORT }).missingMethods.length, asl.DRIVER_PORT.length);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'V1_ARTIFACT_LAYOUT_VERSION'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'V1_ARTIFACT_FILENAMES'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'TRANSITION_ARTIFACT_FILENAMES'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl.createArtifactLayout({ outputDir: 'run' }), 'transition'), false);",
      "require.resolve('agent-scenario-loop/schemas/scenario.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/manifest.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/metrics.schema.json');",
      "require.resolve('agent-scenario-loop/examples/scenarios/mobile/app-startup.json');",
      "require.resolve('agent-scenario-loop/examples/mobile-app/asl.config.json');",
      "require.resolve('agent-scenario-loop/runner/profile-android');",
      "require.resolve('agent-scenario-loop/runner/profile-ios');",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/core/config-template.json'), true);",
    ].join('\n');
    run(process.execPath, ['-e', resolveSmokeScript], {
      cwd: installDir,
      env,
    });

    process.stdout.write(`package smoke passed: ${tarballPath}\n`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    console.error(`package smoke temp kept at: ${tempRoot}`);
    throw error;
  }
}

if (require.main === module) {
  main();
}

export {
  createSmokeEnv,
  listFiles,
  main,
  isAllowedPackedFile,
  packageBinPath,
  run,
  runExpectFailure,
  writeFakeAdb,
};
