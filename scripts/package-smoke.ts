#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

/**
 * Hashes a package-smoke fixture file.
 *
 * @param {string} filePath
 * @returns {string}
 */
function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

type ExampleProfileRun = {
  binaryName: string;
  eventLog: string;
  platform: string;
  runId: string;
  scenario: string;
};

type ExampleLiveFixture = {
  fixtureRunId: string;
  logcatText: string;
};

type SmokeRunOptions = {
  actual: number;
  endedAt: string;
  root: string;
  runId: string;
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
  /^templates\/[a-z0-9.-]+(?:\.(?:json|md))?$/u,
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
    "  ['-s emulator-5554 logcat -d -v time -t 25', { stdout: logcatText }],",
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
 * Writes a tiny adb-compatible command for the installed example-live proof.
 *
 * @param {{filePath: string, fixtures: Record<string, ExampleLiveFixture>, packageName: string}} options
 * @returns {void}
 */
function writeFakeExampleLiveAdb({
  filePath,
  fixtures,
  packageName,
}: {
  filePath: string;
  fixtures: Record<string, ExampleLiveFixture>;
  packageName: string;
}): void {
  const scriptPath = filePath.endsWith('.cmd') ? filePath.replace(/\.cmd$/u, '.js') : filePath;
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const key = args.join(' ');",
    `const fixtures = ${JSON.stringify(fixtures)};`,
    `const packageName = ${JSON.stringify(packageName)};`,
    `const statePath = ${JSON.stringify(`${scriptPath}.state.json`)};`,
    "function readState() {",
    "  try {",
    "    return JSON.parse(fs.readFileSync(statePath, 'utf8'));",
    "  } catch {",
    "    return { currentRunId: 'android-live-startup', currentScenario: 'app-startup' };",
    "  }",
    "}",
    "function writeState(state) {",
    "  fs.writeFileSync(statePath, `${JSON.stringify(state)}\\n`, 'utf8');",
    "}",
    "const state = readState();",
    "function ok(stdout = '') { process.stdout.write(stdout); process.exit(0); }",
    "if (key === 'version') ok('Android Debug Bridge version 1.0.41\\n');",
    "if (key === 'devices -l') ok('List of devices attached\\nemulator-5554 device product:sdk_gphone model:Pixel_6 device:emu64\\n');",
    "if (key.endsWith('shell getprop ro.product.model')) ok('Pixel 6\\n');",
    "if (key.endsWith('shell getprop ro.build.version.release')) ok('15\\n');",
    "if (key.endsWith('shell getprop ro.build.version.sdk')) ok('35\\n');",
    "if (key.endsWith(`shell pm path ${packageName}`)) ok(`package:/data/app/${packageName}/base.apk\\n`);",
    "if (key === '-s emulator-5554 reverse tcp:8097 tcp:8097') ok('');",
    "if (key.includes(`shell run-as ${packageName} sh -c`) && key.includes('debug_http_host') && key.includes('localhost:8097')) ok('');",
    "if (key.endsWith(`shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`)) ok('Events injected: 1\\n');",
    "if (key.endsWith('logcat -c')) ok('');",
    "if (key.includes('profile-session/start')) {",
    "  state.currentRunId = /runId=([^&']+)/u.exec(key)?.[1] ?? state.currentRunId;",
    "  state.currentScenario = /scenario=([^&']+)/u.exec(key)?.[1] ?? state.currentScenario;",
    "  writeState(state);",
    "  ok('Starting: Intent\\n');",
    "}",
    "if (key.includes('profile-session/command')) ok('Starting: Intent\\n');",
    "if (key.endsWith('logcat -d -v time -t 1000')) {",
    "  const fixture = fixtures[state.currentScenario];",
    "  if (!fixture) {",
    "    process.stderr.write(`missing fixture for ${state.currentScenario}\\n`);",
    "    process.exit(1);",
    "  }",
    "  ok(fixture.logcatText.replaceAll(fixture.fixtureRunId, state.currentRunId));",
    "}",
    "process.stderr.write(`unexpected fake adb command: ${key}\\n`);",
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
 * Writes a tiny agent-device-compatible command for installed aggregate proof smoke tests.
 *
 * @param {string} filePath
 * @returns {void}
 */
function writeFakeAgentDevice(filePath: string): void {
  const scriptPath = filePath.endsWith('.cmd') ? filePath.replace(/\.cmd$/u, '.js') : filePath;
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "function ok(data = {}) {",
    "  process.stdout.write(`${JSON.stringify({ success: true, data })}\\n`);",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'open' && typeof args[1] === 'string') {",
    "  ok({ opened: args[1] });",
    "}",
    "if (args[0] === 'is' && args[1] === 'visible' && typeof args[2] === 'string') {",
    "  ok({ selector: args[2], visible: true });",
    "}",
    "if (args[0] === 'screenshot' && typeof args[1] === 'string') {",
    "  fs.mkdirSync(path.dirname(args[1]), { recursive: true });",
    "  fs.writeFileSync(args[1], 'fake screenshot', 'utf8');",
    "  ok({ path: args[1] });",
    "}",
    "process.stderr.write(`unexpected fake agent-device command: ${args.join(' ')}\\n`);",
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
 * Writes a tiny xcrun-compatible command for the installed iOS example-live proof.
 *
 * @param {{bundleId: string, deviceId: string, filePath: string, fixtures: Record<string, ExampleLiveFixture>}} options
 * @returns {void}
 */
function writeFakeExampleLiveXcrun({
  bundleId,
  deviceId,
  filePath,
  fixtures,
}: {
  bundleId: string;
  deviceId: string;
  filePath: string;
  fixtures: Record<string, ExampleLiveFixture>;
}): void {
  const scriptPath = filePath.endsWith('.cmd') ? filePath.replace(/\.cmd$/u, '.js') : filePath;
  const dataContainer = `${scriptPath}.data`;
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const key = args.join(' ');",
    `const bundleId = ${JSON.stringify(bundleId)};`,
    `const dataContainer = ${JSON.stringify(dataContainer)};`,
    `const deviceId = ${JSON.stringify(deviceId)};`,
    `const fixtures = ${JSON.stringify(fixtures)};`,
    "function ok(stdout = '') { process.stdout.write(stdout); process.exit(0); }",
    "function storageDir() {",
    "  return path.join(dataContainer, 'Library', 'Application Support', bundleId, 'RCTAsyncLocalStorage_V1');",
    "}",
    "function readSession() {",
    "  const manifestPath = path.join(storageDir(), 'manifest.json');",
    "  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));",
    "  return { manifest, manifestPath, session: JSON.parse(manifest['agent-scenario-loop.profile-session.1']) };",
    "}",
    "function parseFixtureEvents(logText, fixtureRunId, runId) {",
    "  return logText.split(/\\r?\\n/u).filter(Boolean).map((line) => {",
    "    const payload = line.slice(line.indexOf('[profile-event]') + '[profile-event]'.length).trim();",
    "    return { ...JSON.parse(payload), runId };",
    "  });",
    "}",
    "function writeCurrentEvents() {",
    "  const current = readSession();",
    "  const fixture = fixtures[current.session.scenario];",
    "  if (!fixture) {",
    "    process.stderr.write(`missing fixture for ${current.session.scenario}\\n`);",
    "    process.exit(1);",
    "  }",
    "  current.manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify(parseFixtureEvents(fixture.logcatText, fixture.fixtureRunId, current.session.runId));",
    "  fs.writeFileSync(current.manifestPath, JSON.stringify(current.manifest), 'utf8');",
    "}",
    "if (key === 'simctl list devices') ok(`== Devices ==\\n-- iOS 26.3 --\\n    iPhone 17 Pro Max (${deviceId}) (Booted)\\n`);",
    "if (key === `simctl get_app_container ${deviceId} ${bundleId} app`) ok('/tmp/ASLExampleMobile.app\\n');",
    "if (key === `simctl get_app_container ${deviceId} ${bundleId} data`) { fs.mkdirSync(storageDir(), { recursive: true }); ok(`${dataContainer}\\n`); }",
    "if (key === `simctl terminate ${deviceId} ${bundleId}`) ok('');",
    "if (key === `simctl launch ${deviceId} ${bundleId}`) { writeCurrentEvents(); ok(`${bundleId}: 1234\\n`); }",
    "if (key === `simctl spawn ${deviceId} log show --style compact --last 2m --predicate eventMessage CONTAINS \"[profile-event]\" OR eventMessage CONTAINS \"[profile-session]\"`) ok('Timestamp Ty Process[PID:TID]\\n');",
    "process.stderr.write(`unexpected fake xcrun command: ${key}\\n`);",
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
 * Writes a minimal passed run directory for installed-package comparison smoke tests.
 *
 * @param {SmokeRunOptions} options
 * @returns {string}
 */
function writeSmokeRun({
  actual,
  endedAt,
  root,
  runId,
}: SmokeRunOptions): string {
  const runDir = path.join(root, 'app-startup', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runId,
      scenario: 'app-startup',
      platform: 'android',
      interactionDriver: 'adb-logcat',
      startedAt: '2026-06-16T10:00:00.000Z',
      endedAt,
      durationMs: 1000,
      artifacts: { raw: {} },
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'health.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'app-startup',
      flowId: 'app-startup',
      runId,
      healthStatus: 'passed',
      checks: [{ name: 'truth_events_complete', status: 'passed', source: 'truth' }],
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'verdict.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'app-startup',
      flowId: 'app-startup',
      runId,
      healthStatus: 'passed',
      verdictStatus: 'passed',
      budgetChecks: [
        {
          name: 'startup p95',
          source: 'milestone',
          metric: 'p95',
          unit: 'ms',
          expected: 1000,
          actual,
          pass: actual <= 1000,
        },
      ],
    })}\n`,
    'utf8',
  );
  return runDir;
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
 * Returns the platform-specific path for the repo-local TypeScript compiler.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function typescriptBinPath(repoRoot: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(repoRoot, 'node_modules', '.bin', `tsc${suffix}`);
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
      /^examples\/mobile-app\/(?:\.expo|android|artifacts|ios|node_modules)(?:\/|$)/u,
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
      const legacyStorageSuffix = ['\\.', 'v', '1', '\\b'].join('');
      const forbiddenContentPattern = new RegExp(
        `${productName}|${productSlug}|${applicationsPath}|${localUserPath}|${privateTempPath}|${legacyStorageSuffix}`,
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

    run(packageBinPath(installDir, 'asl-check-plan'), [
      '--scenario',
      path.join(packageRoot, 'templates', 'mobile-scenario.json'),
      '--runner',
      path.join(packageRoot, 'templates', 'primary-runner.json'),
      '--platform',
      'ios',
      '--run-id',
      'template-smoke',
      '--out',
      path.join(tempRoot, 'template-plan'),
    ], {
      cwd: installDir,
      env,
    });

    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.private, false);
    assert.equal(packageJson.publishConfig?.access, 'public');
    assert.equal(packageJson.scripts?.prepublishOnly, 'pnpm release:check');

    const initOutputDir = path.join(tempRoot, 'initialized-app');
    const initOutput = run(packageBinPath(installDir, 'asl-init'), [
      '--out',
      initOutputDir,
      '--scenario',
      'Checkout Submit',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(initOutput, /Agent Scenario Loop files initialized/u);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'asl.config.json')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'scenarios', 'mobile', 'checkout-submit.json')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'runner-manifests', 'primary-runner.json')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'runner-manifests', 'evidence-provider.json')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'asl', 'README.md')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'asl', 'gitignore-snippet')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'asl', 'package-scripts.json')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'src', 'devtools', 'profile-session.ts')), true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(initOutputDir, 'asl.config.json'), 'utf8')).projectName,
      'replace-me',
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(initOutputDir, 'scenarios', 'mobile', 'checkout-submit.json'), 'utf8')).id,
      'checkout-submit',
    );
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'README.md'), 'utf8'),
      /checkout-submit/u,
    );
    const initializedScripts = JSON.parse(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'package-scripts.json'), 'utf8'),
    );
    assert.deepEqual(Object.keys(initializedScripts).sort(), [
      'asl:agent-device:android',
      'asl:agent-device:ios',
      'asl:check:android',
      'asl:check:ios',
      'asl:compare:android',
      'asl:compare:ios',
      'asl:live-proof',
      'asl:profile:android',
      'asl:profile:android:live',
      'asl:profile:ios',
      'asl:profile:ios:live',
      'asl:validate',
    ]);
    assert.match(initializedScripts['asl:check:ios'], /checkout-submit/u);
    assert.match(initializedScripts['asl:profile:ios'], /\$\{ASL_PROFILE_IOS_EVENTS:\+--events \$ASL_PROFILE_IOS_EVENTS\}/u);
    assert.match(
      initializedScripts['asl:profile:android'],
      /\$\{ASL_PROFILE_ANDROID_EVENTS:\+--events \$ASL_PROFILE_ANDROID_EVENTS\}/u,
    );
    assert.match(initializedScripts['asl:agent-device:ios'], /checkout-submit-ios-agent-device/u);
    assert.match(initializedScripts['asl:agent-device:android'], /checkout-submit-android-agent-device/u);
    assert.match(initializedScripts['asl:profile:ios:live'], /checkout-submit-ios-live/u);
    assert.match(initializedScripts['asl:profile:android:live'], /checkout-submit-android-live/u);
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'gitignore-snippet'), 'utf8'),
      /artifacts\/asl\//u,
    );
    for (const platform of ['ios', 'android']) {
      run(packageBinPath(installDir, 'asl-check-plan'), [
        '--scenario',
        path.join(initOutputDir, 'scenarios', 'mobile', 'checkout-submit.json'),
        '--runner',
        path.join(initOutputDir, 'runner-manifests', 'primary-runner.json'),
        '--platform',
        platform,
        '--run-id',
        `initialized-${platform}`,
        '--out',
        path.join(initOutputDir, 'artifacts', 'asl', 'plan', `checkout-submit-${platform}`),
      ], {
        cwd: initOutputDir,
        env,
      });
    }
    const initializedValidationOutput = run(packageBinPath(installDir, 'asl-validate-project'), [
      '--root',
      initOutputDir,
      '--platform',
      'all',
      '--out',
      path.join(initOutputDir, 'artifacts', 'asl', 'project-validation'),
    ], {
      cwd: initOutputDir,
      env,
    });
    assert.match(initializedValidationOutput, /project validation passed/u);
    assert.equal(
      fs.existsSync(path.join(initOutputDir, 'artifacts', 'asl', 'project-validation', 'project-validation.json')),
      true,
    );
    const initializedValidation = JSON.parse(
      fs.readFileSync(path.join(initOutputDir, 'artifacts', 'asl', 'project-validation', 'project-validation.json'), 'utf8'),
    );
    assert.equal(initializedValidation.scripts.status, 'present');
    assert.equal(
      initializedValidation.nextActions.some((action: { code: string }) => action.code === 'replace_config_placeholders'),
      true,
    );
    assert.equal(initializedValidation.warnings.some((warning: string) => warning.includes('projectName')), true);

    for (const binaryName of Object.keys(packageJson.bin).sort()) {
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

    const providerEvidenceRoot = path.join(tempRoot, 'provider-evidence');
    const providerProfileRoot = path.join(tempRoot, 'provider-evidence-profile');
    fs.mkdirSync(providerEvidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(providerEvidenceRoot, 'js-profile.json'), '{"samples":[]}\n', 'utf8');
    fs.writeFileSync(path.join(providerEvidenceRoot, 'network-capture.har'), '{"log":{"entries":[]}}\n', 'utf8');
    fs.writeFileSync(path.join(providerEvidenceRoot, 'ui-tree.json'), '{"tree":[]}\n', 'utf8');
    const providerProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--events',
      path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'),
      '--signal',
      `js:${path.join(providerEvidenceRoot, 'js-profile.json')}`,
      '--signal',
      `network:${path.join(providerEvidenceRoot, 'network-capture.har')}`,
      '--capture',
      `uiTree:${path.join(providerEvidenceRoot, 'ui-tree.json')}`,
      '--out',
      providerProfileRoot,
      '--run-id',
      'android-example-startup',
    ], {
      cwd: installDir,
      env,
    });
    const providerProfileRunDir = providerProfileOutput.trim();
    const providerManifest = JSON.parse(fs.readFileSync(path.join(providerProfileRunDir, 'manifest.json'), 'utf8'));
    const providerJsSignal = path.join(providerEvidenceRoot, 'js-profile.json');
    const providerNetworkSignal = path.join(providerEvidenceRoot, 'network-capture.har');
    const providerUiTree = path.join(providerEvidenceRoot, 'ui-tree.json');
    assert.deepEqual(providerManifest.artifacts.signals.js, ['signals/js/js-profile.json']);
    assert.deepEqual(providerManifest.artifacts.signals.network, ['signals/network/network-capture.har']);
    assert.equal(providerManifest.artifacts.captures.uiTree, 'captures/ui-tree.json');
    assert.deepEqual(providerManifest.artifacts.evidenceAttachments, [
      {
        channel: 'signal',
        kind: 'js',
        path: 'signals/js/js-profile.json',
        sha256: sha256File(providerJsSignal),
        sizeBytes: fs.statSync(providerJsSignal).size,
        sourceFileName: 'js-profile.json',
      },
      {
        channel: 'signal',
        kind: 'network',
        path: 'signals/network/network-capture.har',
        sha256: sha256File(providerNetworkSignal),
        sizeBytes: fs.statSync(providerNetworkSignal).size,
        sourceFileName: 'network-capture.har',
      },
      {
        channel: 'capture',
        kind: 'uiTree',
        path: 'captures/ui-tree.json',
        sha256: sha256File(providerUiTree),
        sizeBytes: fs.statSync(providerUiTree).size,
        sourceFileName: 'ui-tree.json',
      },
    ]);
    assert.equal(fs.existsSync(path.join(providerProfileRunDir, 'signals', 'js', 'js-profile.json')), true);
    assert.equal(fs.existsSync(path.join(providerProfileRunDir, 'signals', 'network', 'network-capture.har')), true);
    assert.equal(fs.existsSync(path.join(providerProfileRunDir, 'captures', 'ui-tree.json')), true);

    const providerCommandRoot = path.join(tempRoot, 'provider-command');
    const providerCommandProfileRoot = path.join(tempRoot, 'provider-command-profile');
    fs.mkdirSync(providerCommandRoot, { recursive: true });
    const providerCommandScript = path.join(providerCommandRoot, 'write-accessibility.js');
    fs.writeFileSync(providerCommandScript, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const outputPath = process.argv[2];",
      "fs.mkdirSync(path.dirname(outputPath), { recursive: true });",
      "fs.writeFileSync(outputPath, JSON.stringify({ violations: [] }) + '\\n');",
    ].join('\n'));
    const providerCommandManifestPath = path.join(providerCommandRoot, 'provider.json');
    fs.writeFileSync(providerCommandManifestPath, `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'smoke-accessibility-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: [providerCommandScript, '{providerDir}/accessibility.json'],
          outputs: [
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
            },
          ],
        },
      ],
    }, null, 2)}\n`);
    const providerCommandProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--events',
      path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'),
      '--provider',
      providerCommandManifestPath,
      '--out',
      providerCommandProfileRoot,
      '--run-id',
      'android-provider-command',
    ], {
      cwd: installDir,
      env,
    });
    const providerCommandRunDir = providerCommandProfileOutput.trim();
    const providerCommandManifest = JSON.parse(fs.readFileSync(path.join(providerCommandRunDir, 'manifest.json'), 'utf8'));
    const providerCommandOutput = path.join(providerCommandRunDir, 'raw', 'providers', 'smoke-accessibility-provider', 'accessibility.json');
    assert.equal(fs.existsSync(providerCommandOutput), true);
    assert.equal(fs.existsSync(path.join(providerCommandRunDir, 'raw', 'provider-commands', 'smoke-accessibility-provider-capture-accessibility.json')), true);
    assert.deepEqual(providerCommandManifest.artifacts.evidenceAttachments, [
      {
        channel: 'provider',
        kind: 'accessibility',
        path: 'raw/providers/smoke-accessibility-provider/accessibility.json',
        sha256: sha256File(providerCommandOutput),
        sizeBytes: fs.statSync(providerCommandOutput).size,
        sourceFileName: 'accessibility.json',
      },
    ]);

    const failingProviderCommandRoot = path.join(tempRoot, 'provider-command-failure');
    const failingProviderCommandProfileRoot = path.join(tempRoot, 'provider-command-failure-profile');
    fs.mkdirSync(failingProviderCommandRoot, { recursive: true });
    const failingProviderCommandScript = path.join(failingProviderCommandRoot, 'fail-provider.js');
    fs.writeFileSync(failingProviderCommandScript, "process.stderr.write('provider unavailable\\n'); process.exit(7);\n");
    const failingProviderCommandManifestPath = path.join(failingProviderCommandRoot, 'provider.json');
    fs.writeFileSync(failingProviderCommandManifestPath, `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'smoke-failing-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: [failingProviderCommandScript],
          outputs: [
            {
              channel: 'provider',
              kind: 'accessibility',
              path: '{providerDir}/accessibility.json',
            },
          ],
        },
      ],
    }, null, 2)}\n`);
    const failingProviderCommandProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--events',
      path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'),
      '--provider',
      failingProviderCommandManifestPath,
      '--out',
      failingProviderCommandProfileRoot,
      '--run-id',
      'android-provider-failure',
    ], {
      cwd: installDir,
      env,
    });
    const failingProviderCommandRunDir = failingProviderCommandProfileOutput.trim();
    const failingProviderCommandHealth = JSON.parse(fs.readFileSync(path.join(failingProviderCommandRunDir, 'health.json'), 'utf8'));
    const failingProviderCommandSummary = fs.readFileSync(path.join(failingProviderCommandRunDir, 'agent-summary.md'), 'utf8');
    const failingProviderCommandRecord = JSON.parse(fs.readFileSync(path.join(failingProviderCommandRunDir, 'raw', 'provider-commands', 'smoke-failing-provider-capture-accessibility.json'), 'utf8'));
    assert.equal(failingProviderCommandHealth.healthStatus, 'failed');
    assert.equal(failingProviderCommandRecord.exitCode, 7);
    assert.equal(
      failingProviderCommandHealth.checks.some((check: { code: string; metadata?: { nextActionCode?: string } }) =>
        check.code === 'provider_command_failed' && check.metadata?.nextActionCode === 'fix_provider_command'
      ),
      true,
    );
    assert.match(failingProviderCommandSummary, /Next action `fix_provider_command`/u);

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

    const adbDriverStepRunId = 'package-smoke-adb-driver-step';
    const fakeAdbDriverStepPath = path.join(
      tempRoot,
      process.platform === 'win32' ? 'fake-adb-driver-step.cmd' : 'fake-adb-driver-step',
    );
    const adbDriverStepProfileRoot = path.join(tempRoot, 'adb-driver-step-profile');
    const adbDriverStepScenarioPath = path.join(tempRoot, 'android-app-startup-readlogs.json');
    const adbDriverStepScenario = JSON.parse(
      fs.readFileSync(path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'), 'utf8'),
    );
    adbDriverStepScenario.steps = [
      {
        id: 'capture-log-window',
        kind: 'captureEvidence',
        artifact: 'logs',
        driverAction: 'readLogs',
        adapterOptions: {
          androidAdb: {
            logcatLines: 25,
            rawFileName: 'adb-logcat.txt',
          },
        },
      },
    ];
    fs.writeFileSync(adbDriverStepScenarioPath, `${JSON.stringify(adbDriverStepScenario, null, 2)}\n`, 'utf8');
    writeFakeAdb({
      filePath: fakeAdbDriverStepPath,
      logcatText: fs
        .readFileSync(path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'), 'utf8')
        .replace(/android-example-startup/gu, adbDriverStepRunId),
      packageName: androidPackageName,
    });
    const adbDriverStepProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      adbDriverStepScenarioPath,
      '--adb-capture',
      '--adb',
      fakeAdbDriverStepPath,
      '--out',
      adbDriverStepProfileRoot,
      '--run-id',
      adbDriverStepRunId,
    ], {
      cwd: installDir,
      env,
    });
    const adbDriverStepProfileRunDir = adbDriverStepProfileOutput.trim();
    const adbDriverStepCaptureRoot = path.join(adbDriverStepProfileRoot, '_adb-captures', adbDriverStepRunId);
    const adbDriverStepMetadata = JSON.parse(
      fs.readFileSync(path.join(adbDriverStepCaptureRoot, 'raw', 'android-metadata.json'), 'utf8'),
    );
    const adbDriverStepHealth = JSON.parse(fs.readFileSync(path.join(adbDriverStepProfileRunDir, 'health.json'), 'utf8'));
    assert.equal(adbDriverStepHealth.healthStatus, 'passed');
    assert.equal(adbDriverStepMetadata.logcat.rawPath, 'raw/adb-logcat.txt');
    assert.equal(adbDriverStepMetadata.logcat.stepId, 'capture-log-window');

    const exampleLiveRoot = path.join(tempRoot, 'example-android-live-proof');
    const fakeExampleLiveAdbPath = path.join(
      tempRoot,
      process.platform === 'win32' ? 'fake-example-live-adb.cmd' : 'fake-example-live-adb',
    );
    const fakeAgentDevicePath = path.join(
      tempRoot,
      process.platform === 'win32' ? 'fake-agent-device.cmd' : 'fake-agent-device',
    );
    writeFakeExampleLiveAdb({
      filePath: fakeExampleLiveAdbPath,
      fixtures: {
        'app-startup': {
          fixtureRunId: 'android-example-startup',
          logcatText: fs.readFileSync(path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'), 'utf8'),
        },
        'open-close-cycle': {
          fixtureRunId: 'android-example-open-close',
          logcatText: fs.readFileSync(path.join(exampleAppRoot, 'event-logs', 'android-open-close-cycle.log'), 'utf8'),
        },
        'scroll-settle': {
          fixtureRunId: 'android-example-scroll',
          logcatText: fs.readFileSync(path.join(exampleAppRoot, 'event-logs', 'android-scroll-settle.log'), 'utf8'),
        },
      },
      packageName: androidPackageName,
    });
    writeFakeAgentDevice(fakeAgentDevicePath);
    const exampleLiveOutput = run(packageBinPath(installDir, 'asl-example-android-live'), [
      '--adb',
      fakeExampleLiveAdbPath,
      '--out',
      exampleLiveRoot,
      '--wait-ms',
      '1',
      '--command-wait-ms',
      '1',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(exampleLiveOutput, /Android example live proof passed/u);
    const exampleLivePreflightHealth = JSON.parse(
      fs.readFileSync(path.join(exampleLiveRoot, '_preflight', 'android-live-preflight', 'health.json'), 'utf8'),
    );
    assert.equal(exampleLivePreflightHealth.healthStatus, 'passed');
    assert.equal(
      fs.existsSync(path.join(exampleLiveRoot, '_live-proof', 'android-live-proof', 'live-proof.json')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(exampleLiveRoot, '_live-proof', 'android-live-proof', 'agent-summary.md')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(exampleLiveRoot, '_preflight', 'android-live-preflight', 'raw', 'adb-react-native-reverse.txt')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(exampleLiveRoot, '_preflight', 'android-live-preflight', 'raw', 'adb-react-native-debug-host.txt')),
      true,
    );
    const exampleLiveCompareOutput = run(packageBinPath(installDir, 'asl-example-android-live'), [
      '--adb',
      fakeExampleLiveAdbPath,
      '--out',
      exampleLiveRoot,
      '--wait-ms',
      '1',
      '--command-wait-ms',
      '1',
      '--run-suffix',
      'smoke',
      '--compare-latest',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-android',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(exampleLiveCompareOutput, /Comparisons:/u);
    assert.equal(
      fs.existsSync(path.join(exampleLiveRoot, '_live-proof', 'android-live-proof-smoke', 'live-proof.json')),
      true,
    );
    const exampleLiveProofOutput = run(packageBinPath(installDir, 'asl-live-proof'), [
      '--file',
      path.join(exampleLiveRoot, '_live-proof', 'android-live-proof-smoke', 'live-proof.json'),
      '--fail-on-regression',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(exampleLiveProofOutput, /Comparison status: unchanged/u);
    assert.match(exampleLiveProofOutput, /Comparison counts: better=0 worse=0 unchanged=3 mixed=0 inconclusive=0 skipped=0/u);
    assert.match(exampleLiveProofOutput, /startup \(app-startup\/android-live-startup-smoke\): unchanged \(metrics better=0 worse=0 unchanged=8 inconclusive=0\)/u);
    assert.match(exampleLiveProofOutput, /startup \(app-startup\/android-live-startup-smoke\): health=passed verdict=passed/u);
    assert.match(exampleLiveProofOutput, /startup-ui \(agent-device\/app-startup\/android-agent-device-startup-smoke\): health=passed verdict=not_evaluated/u);
    assert.match(exampleLiveProofOutput, /Next action: inspect_summary/u);
    const exampleLiveProof = JSON.parse(
      fs.readFileSync(path.join(exampleLiveRoot, '_live-proof', 'android-live-proof-smoke', 'live-proof.json'), 'utf8'),
    );
    assert.equal(exampleLiveProof.interactionProofs.length, 1);
    assert.equal(exampleLiveProof.interactionProofs[0].healthStatus, 'passed');
    assert.equal(exampleLiveProof.interactionProofs[0].runnerId, 'agent-device');
    assert.equal(
      exampleLiveProof.comparisons.every((comparison: { metricSummary?: { counts?: { unchanged?: number }; notableMetrics?: unknown[] } }) =>
        comparison.metricSummary?.counts?.unchanged === 8 && comparison.metricSummary?.notableMetrics?.length === 0
      ),
      true,
    );
    for (const [scenarioDir, runId] of [
      ['app-startup', 'android-live-startup'],
      ['open-close-cycle', 'android-live-open-close'],
      ['scroll-settle', 'android-live-scroll'],
    ]) {
      const runDir = path.join(exampleLiveRoot, scenarioDir, runId);
      const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health.json'), 'utf8'));
      const verdict = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
      assert.equal(health.healthStatus, 'passed');
      assert.equal(verdict.verdictStatus, 'passed');
      assert.equal(fs.existsSync(path.join(runDir, 'agent-summary.md')), true);
    }
    for (const [scenarioDir, runId] of [
      ['app-startup', 'android-live-startup-smoke'],
      ['open-close-cycle', 'android-live-open-close-smoke'],
      ['scroll-settle', 'android-live-scroll-smoke'],
    ]) {
      const comparisonDir = path.join(exampleLiveRoot, 'comparisons', scenarioDir, runId);
      assert.equal(fs.existsSync(path.join(comparisonDir, 'comparison.json')), true);
      assert.equal(fs.existsSync(path.join(comparisonDir, 'agent-summary.md')), true);
    }

    const exampleIosLiveRoot = path.join(tempRoot, 'example-ios-live-proof');
    const fakeExampleLiveXcrunPath = path.join(
      tempRoot,
      process.platform === 'win32' ? 'fake-example-live-xcrun.cmd' : 'fake-example-live-xcrun',
    );
    const iosDeviceId = 'A692ED28-893E-453F-8866-C69331AE757F';
    const iosBundleId = 'dev.agent-scenario-loop.example';
    writeFakeExampleLiveXcrun({
      bundleId: iosBundleId,
      deviceId: iosDeviceId,
      filePath: fakeExampleLiveXcrunPath,
      fixtures: {
        'app-startup': {
          fixtureRunId: 'example-startup',
          logcatText: fs.readFileSync(path.join(exampleAppRoot, 'event-logs', 'app-startup.log'), 'utf8'),
        },
        'open-close-cycle': {
          fixtureRunId: 'example-open-close',
          logcatText: fs.readFileSync(path.join(exampleAppRoot, 'event-logs', 'open-close-cycle.log'), 'utf8'),
        },
        'scroll-settle': {
          fixtureRunId: 'example-scroll',
          logcatText: fs.readFileSync(path.join(exampleAppRoot, 'event-logs', 'scroll-settle.log'), 'utf8'),
        },
      },
    });
    const exampleIosLiveOutput = run(packageBinPath(installDir, 'asl-example-ios-live'), [
      '--xcrun',
      fakeExampleLiveXcrunPath,
      '--device',
      iosDeviceId,
      '--out',
      exampleIosLiveRoot,
      '--wait-ms',
      '1',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(exampleIosLiveOutput, /iOS example live proof passed/u);
    const exampleIosLivePreflightHealth = JSON.parse(
      fs.readFileSync(path.join(exampleIosLiveRoot, '_preflight', 'ios-live-preflight', 'health.json'), 'utf8'),
    );
    assert.equal(exampleIosLivePreflightHealth.healthStatus, 'passed');
    assert.equal(
      fs.existsSync(path.join(exampleIosLiveRoot, '_live-proof', 'ios-live-proof', 'live-proof.json')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(exampleIosLiveRoot, '_live-proof', 'ios-live-proof', 'agent-summary.md')),
      true,
    );
    const exampleIosLiveCompareOutput = run(packageBinPath(installDir, 'asl-example-ios-live'), [
      '--xcrun',
      fakeExampleLiveXcrunPath,
      '--device',
      iosDeviceId,
      '--out',
      exampleIosLiveRoot,
      '--wait-ms',
      '1',
      '--run-suffix',
      'smoke',
      '--compare-latest',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-ios',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(exampleIosLiveCompareOutput, /Comparisons:/u);
    assert.equal(
      fs.existsSync(path.join(exampleIosLiveRoot, '_live-proof', 'ios-live-proof-smoke', 'live-proof.json')),
      true,
    );
    const exampleIosLiveProofOutput = run(packageBinPath(installDir, 'asl-live-proof'), [
      '--file',
      path.join(exampleIosLiveRoot, '_live-proof', 'ios-live-proof-smoke', 'live-proof.json'),
      '--fail-on-regression',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(exampleIosLiveProofOutput, /Comparison status: unchanged/u);
    assert.match(exampleIosLiveProofOutput, /startup \(app-startup\/ios-live-startup-smoke\): unchanged \(metrics better=0 worse=0 unchanged=8 inconclusive=0\)/u);
    assert.match(exampleIosLiveProofOutput, /startup-ui \(agent-device\/app-startup\/ios-agent-device-startup-smoke\): health=passed verdict=not_evaluated/u);
    const exampleIosLiveProof = JSON.parse(
      fs.readFileSync(path.join(exampleIosLiveRoot, '_live-proof', 'ios-live-proof-smoke', 'live-proof.json'), 'utf8'),
    );
    assert.equal(exampleIosLiveProof.interactionProofs.length, 1);
    assert.equal(exampleIosLiveProof.interactionProofs[0].healthStatus, 'passed');
    assert.equal(exampleIosLiveProof.interactionProofs[0].runnerId, 'agent-device');
    assert.equal(
      exampleIosLiveProof.comparisons.every((comparison: { metricSummary?: { counts?: { unchanged?: number }; notableMetrics?: unknown[] } }) =>
        comparison.metricSummary?.counts?.unchanged === 8 && comparison.metricSummary?.notableMetrics?.length === 0
      ),
      true,
    );
    for (const [scenarioDir, runId] of [
      ['app-startup', 'ios-live-startup'],
      ['open-close-cycle', 'ios-live-open-close'],
      ['scroll-settle', 'ios-live-scroll'],
    ]) {
      const runDir = path.join(exampleIosLiveRoot, scenarioDir, runId);
      const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health.json'), 'utf8'));
      const verdict = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
      assert.equal(health.healthStatus, 'passed');
      assert.equal(verdict.verdictStatus, 'passed');
      assert.equal(fs.existsSync(path.join(runDir, 'agent-summary.md')), true);
      assert.equal(fs.existsSync(path.join(runDir, 'raw', 'ios-profile-events.log')), true);
    }
    for (const [scenarioDir, runId] of [
      ['app-startup', 'ios-live-startup-smoke'],
      ['open-close-cycle', 'ios-live-open-close-smoke'],
      ['scroll-settle', 'ios-live-scroll-smoke'],
    ]) {
      const comparisonDir = path.join(exampleIosLiveRoot, 'comparisons', scenarioDir, runId);
      assert.equal(fs.existsSync(path.join(comparisonDir, 'comparison.json')), true);
      assert.equal(fs.existsSync(path.join(comparisonDir, 'agent-summary.md')), true);
    }

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
    const missingAdbSummary = fs.readFileSync(path.join(missingAdbCaptureRoot, 'agent-summary.md'), 'utf8');
    assert.equal(missingAdb.status, 1);
    assert.match(missingAdb.stderr, /Android adb capture failed/u);
    assert.equal(missingAdbHealth.healthStatus, 'failed');
    assert.equal(
      missingAdbHealth.checks.some((check: { code: string }) => check.code === 'adb_unavailable'),
      true,
    );
    assert.equal(
      missingAdbHealth.checks.some((check: { code: string; metadata?: { nextActionCode?: string } }) =>
        check.code === 'adb_unavailable' && check.metadata?.nextActionCode === 'fix_adb_command'
      ),
      true,
    );
    assert.match(missingAdbSummary, /Next action `fix_adb_command`/u);

    const health = JSON.parse(fs.readFileSync(path.join(artifactDir, 'health.json'), 'utf8'));
    assert.equal(health.scenarioId, 'app-startup');
    assert.equal(health.runId, 'package-smoke');
    assert.equal(health.healthStatus, 'passed');

    const latestCompareRoot = path.join(tempRoot, 'latest-compare-runs');
    writeSmokeRun({
      root: latestCompareRoot,
      runId: 'baseline-run',
      actual: 950,
      endedAt: '2026-06-16T10:00:00.000Z',
    });
    const latestCompareCurrentDir = writeSmokeRun({
      root: latestCompareRoot,
      runId: 'current-run',
      actual: 850,
      endedAt: '2026-06-16T10:05:00.000Z',
    });
    const latestCompareOutputDir = path.join(tempRoot, 'latest-compare-output');
    const latestCompareOutput = run(packageBinPath(installDir, 'asl-compare-latest'), [
      '--root',
      latestCompareRoot,
      '--scenario',
      'app-startup',
      '--current',
      latestCompareCurrentDir,
      '--out',
      latestCompareOutputDir,
    ], {
      cwd: installDir,
      env,
    });
    const latestComparison = JSON.parse(
      fs.readFileSync(path.join(latestCompareOutputDir, 'comparison.json'), 'utf8'),
    );
    assert.equal(latestCompareOutput.trim(), latestCompareOutputDir);
    assert.equal(latestComparison.baselineRunId, 'baseline-run');
    assert.equal(latestComparison.runId, 'current-run');
    assert.equal(latestComparison.comparisonStatus, 'better');
    assert.equal(fs.existsSync(path.join(latestCompareOutputDir, 'agent-summary.md')), true);

    const resolveSmokeScript = [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const asl = require('agent-scenario-loop');",
      "const packageRoot = path.join(process.cwd(), 'node_modules', 'agent-scenario-loop');",
      "const packageJson = require('agent-scenario-loop/package.json');",
      "function readJson(relativePath) { return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')); }",
      "function listJsonFiles(relativeDir) { return fs.readdirSync(path.join(packageRoot, relativeDir)).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(relativeDir, name)); }",
      "for (const subpath of Object.keys(packageJson.exports).filter((name) => !name.includes('*'))) {",
      "  const specifier = subpath === '.' ? 'agent-scenario-loop' : `agent-scenario-loop/${subpath.slice(2)}`;",
      "  require.resolve(specifier);",
      "}",
      "assert.equal(asl.ARTIFACT_LAYOUT_VERSION, '1.0.0');",
      "assert.equal(asl.ARTIFACT_FILENAMES.health, 'health.json');",
      "assert.deepEqual(asl.ARTIFACT_FILENAMES, { agentSummary: 'agent-summary.md', comparison: 'comparison.json', health: 'health.json', liveProof: 'live-proof.json', plannerCompatibility: 'planner-compatibility.json', projectValidation: 'project-validation.json', verdict: 'verdict.json' });",
      "assert.equal(asl.PROFILE_ARTIFACT_FILENAMES.metrics, 'metrics.json');",
      "assert.deepEqual(asl.PROFILE_ARTIFACT_FILENAMES, { budgetVerdict: 'budget-verdict.json', causalRun: 'causal-run.json', manifest: 'manifest.json', metrics: 'metrics.json', summary: 'summary.md' });",
      "assert.equal(typeof asl.createArtifactLayout, 'function');",
      "const layout = asl.createArtifactLayout({ outputDir: 'run' });",
      "assert.equal(layout.health, 'run/health.json');",
      "assert.equal(layout.verdict, 'run/verdict.json');",
      "assert.equal(layout.comparison, 'run/comparison.json');",
      "assert.equal(layout.agentSummary, 'run/agent-summary.md');",
      "assert.equal(layout.liveProof, 'run/live-proof.json');",
      "assert.equal(layout.plannerCompatibility, 'run/planner-compatibility.json');",
      "assert.equal(layout.projectValidation, 'run/project-validation.json');",
      "assert.equal(layout.raw, 'run/raw');",
      "assert.equal(layout.captures, 'run/captures');",
      "assert.equal(layout.signals.js, 'run/signals/js');",
      "assert.equal(layout.signals.memory, 'run/signals/memory');",
      "assert.equal(layout.signals.network, 'run/signals/network');",
      "assert.equal(layout.profile.manifest, 'run/manifest.json');",
      "assert.equal(layout.profile.metrics, 'run/metrics.json');",
      "assert.equal(layout.profile.causalRun, 'run/causal-run.json');",
      "assert.equal(layout.profile.budgetVerdict, 'run/budget-verdict.json');",
      "assert.equal(layout.profile.summary, 'run/summary.md');",
      "assert.equal(typeof asl.buildAgentSummaryMarkdown, 'function');",
      "assert.equal(typeof asl.extractProfileEvents, 'function');",
      "assert.equal(typeof asl.buildMetricsFromProfileEvents, 'function');",
      "assert.equal(typeof asl.buildManifest, 'function');",
      "assert.equal(typeof asl.writeJsonArtifact, 'function');",
      "assert.equal(typeof asl.writeTextArtifact, 'function');",
      "assert.equal(typeof asl.buildComparisonArtifact, 'function');",
      "assert.equal(typeof asl.compareBudgetCheck, 'function');",
      "assert.equal(typeof asl.interpretEvidence, 'function');",
      "assert.equal(typeof asl.isTimingEvidenceTrusted, 'function');",
      "assert.equal(typeof asl.buildScenarioExecutionPlan, 'function');",
      "assert.equal(typeof asl.evaluateRunnerCompatibility, 'function');",
      "assert.equal(typeof asl.collectScenarioDriverActions, 'function');",
      "assert.equal(typeof asl.buildRunIndex, 'function');",
      "assert.equal(typeof asl.findLatestTrustedRun, 'function');",
      "assert.equal(typeof asl.validateJson, 'function');",
      "assert.equal(typeof asl.assertValidJson, 'function');",
      "assert.deepEqual(asl.PRIMARY_RUNNER_PORT, ['prepare', 'launch', 'startSession', 'executeStep', 'waitForTruthEvent', 'captureEvidence', 'stopSession', 'finalize']);",
      "assert.deepEqual(asl.EVIDENCE_PROVIDER_PORT, ['prepare', 'startWindow', 'capture', 'stopWindow', 'finalize']);",
      "assert.deepEqual(asl.DRIVER_PORT, ['tap', 'scroll', 'assertVisible', 'inspectTree', 'screenshot', 'record', 'readLogs', 'collectPerfSignals']);",
      "assert.deepEqual(asl.ARTIFACT_WRITER_PORT, ['writeJson', 'writeText', 'copyRaw']);",
      "assert.deepEqual(asl.INTERPRETER_PORT, ['interpret']);",
      "assert.equal(typeof asl.validatePortImplementation, 'function');",
      "assert.equal(typeof asl.assertPortImplementation, 'function');",
      "const driverValidation = asl.validatePortImplementation({ name: 'driver', implementation: { tap() {}, screenshot() {} }, requiredMethods: asl.DRIVER_PORT });",
      "assert.equal(driverValidation.valid, false);",
      "assert.deepEqual(driverValidation.expectedMethods, asl.DRIVER_PORT);",
      "assert.deepEqual(driverValidation.implementedMethods, ['screenshot', 'tap']);",
      "assert.deepEqual(driverValidation.missingMethods, ['scroll', 'assertVisible', 'inspectTree', 'record', 'readLogs', 'collectPerfSignals']);",
      "assert.equal(driverValidation.message, 'driver is missing required method(s): scroll, assertVisible, inspectTree, record, readLogs, collectPerfSignals');",
      "assert.deepEqual(asl.collectScenarioDriverActions({ steps: [{ kind: 'gesture', driverAction: 'scroll' }, { kind: 'captureEvidence', driverAction: 'screenshot', required: false }] }), { required: ['scroll'], optional: ['screenshot'] });",
      "assert.deepEqual(asl.buildScenarioExecutionPlan({ id: 'scroll', steps: [{ kind: 'gesture', driverAction: 'scroll' }] }).steps[0], { id: '01-gesture', index: 0, kind: 'gesture', portMethod: 'executeStep', required: true, driverAction: 'scroll' });",
      "const legacyLayoutVersionExport = ['V', '1', '_ARTIFACT_LAYOUT_VERSION'].join('');",
      "const legacyFilenamesExport = ['V', '1', '_ARTIFACT_FILENAMES'].join('');",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, legacyLayoutVersionExport), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, legacyFilenamesExport), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'TRANSITION_ARTIFACT_FILENAMES'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(layout, 'transition'), false);",
      "require.resolve('agent-scenario-loop/schemas/budget-verdict.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/causal-run.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/comparison.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/health.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/live-proof.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/scenario.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/manifest.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/metrics.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/project-validation.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/runner-capabilities.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/verdict.schema.json');",
      "require.resolve('agent-scenario-loop/examples/scenarios/mobile/app-startup.json');",
      "require.resolve('agent-scenario-loop/examples/mobile-app/asl.config.json');",
      "require.resolve('agent-scenario-loop/examples/runners/README.md');",
      "require.resolve('agent-scenario-loop/examples/runners/script-accessibility-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-memory-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-network-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-profiler-provider.json');",
      "require.resolve('agent-scenario-loop/templates/project.config.json');",
      "require.resolve('agent-scenario-loop/templates/mobile-scenario.json');",
      "require.resolve('agent-scenario-loop/templates/primary-runner.json');",
      "require.resolve('agent-scenario-loop/templates/evidence-provider.json');",
      "require.resolve('agent-scenario-loop/templates/gitignore-snippet');",
      "require.resolve('agent-scenario-loop/templates/integration-readme.md');",
      "require.resolve('agent-scenario-loop/templates/package-scripts.json');",
      "for (const scenarioFixture of listJsonFiles('examples/scenarios/mobile')) {",
      "  const result = asl.validateJson(readJson(scenarioFixture), asl.SCHEMAS.scenario, scenarioFixture);",
      "  assert.equal(result.valid, true, result.message);",
      "}",
      "assert.equal(asl.validateJson(readJson('templates/mobile-scenario.json'), asl.SCHEMAS.scenario, 'templates/mobile-scenario.json').valid, true);",
      "for (const runnerFixture of listJsonFiles('examples/runners')) {",
      "  const result = asl.validateJson(readJson(runnerFixture), asl.SCHEMAS.runnerCapabilities, runnerFixture);",
      "  assert.equal(result.valid, true, result.message);",
      "}",
      "const runnerMatrix = fs.readFileSync(path.join(packageRoot, 'examples/runners/README.md'), 'utf8');",
      "for (const runnerFixture of listJsonFiles('examples/runners')) {",
      "  const runnerFileName = path.basename(runnerFixture);",
      "  assert.equal(runnerMatrix.includes('`' + runnerFileName + '`'), true, `${runnerFileName} missing from runner matrix`);",
      "}",
      "assert.equal(asl.validateJson(readJson('templates/primary-runner.json'), asl.SCHEMAS.runnerCapabilities, 'templates/primary-runner.json').valid, true);",
      "assert.equal(asl.validateJson(readJson('templates/evidence-provider.json'), asl.SCHEMAS.runnerCapabilities, 'templates/evidence-provider.json').valid, true);",
      "const appJson = readJson('examples/mobile-app/app.json');",
      "const aslConfig = readJson('examples/mobile-app/asl.config.json');",
      "assert.equal(aslConfig.app.androidPackage, appJson.expo.android.package);",
      "assert.equal(aslConfig.app.iosBundleId, appJson.expo.ios.bundleIdentifier);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/core/config-template.json'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/docs/api.md'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/docs/authoring.md'), true);",
      "require.resolve('agent-scenario-loop/runner/agent-device');",
      "require.resolve('agent-scenario-loop/runner/agent-device-driver');",
      "require.resolve('agent-scenario-loop/runner/ios-simctl-driver');",
      "require.resolve('agent-scenario-loop/runner/live-proof');",
      "require.resolve('agent-scenario-loop/runner/validate-project');",
    ].join('\n');
    run(process.execPath, ['-e', resolveSmokeScript], {
      cwd: installDir,
      env,
    });

    const typeSmokeSource = [
      "import {",
      "  ARTIFACT_LAYOUT_VERSION,",
      "  DRIVER_PORT,",
      "  SCHEMAS,",
      "  buildAgentSummaryMarkdown,",
      "  buildComparisonArtifact,",
      "  buildScenarioExecutionPlan,",
      "  createArtifactLayout,",
      "  collectScenarioDriverActions,",
      "  buildRunIndex,",
      "  findLatestTrustedRun,",
      "  validateJson,",
      "  validatePortImplementation,",
      "  validateScenarioAdapterOptions,",
      "  type ArtifactLayout,",
      "  type ArtifactWriterPort,",
      "  type DriverPort,",
      "  type EvidenceProviderPort,",
      "  type InterpreterPort,",
      "  type PortResult,",
      "  type PortValidationResult,",
      "  type PrimaryRunnerPort,",
      "} from 'agent-scenario-loop';",
      "import { resolveAgentDeviceDriverSteps, runAgentDeviceCapture } from 'agent-scenario-loop/runner/agent-device';",
      "import { buildAndroidScrollCoordinatesFromBounds, createAndroidAdbDriver, resolveAndroidSelectorFromUiTree } from 'agent-scenario-loop/runner/android-adb-driver';",
      "import { createAgentDeviceDriver, formatAgentDeviceSelector } from 'agent-scenario-loop/runner/agent-device-driver';",
      "import { createIosSimctlDriver } from 'agent-scenario-loop/runner/ios-simctl-driver';",
      "import { runExampleAndroidLiveProof } from 'agent-scenario-loop/runner/example-android-live';",
      "import { runExampleIosLiveProof } from 'agent-scenario-loop/runner/example-ios-live';",
      "import { initProject } from 'agent-scenario-loop/runner/init-project';",
      "import { compareLatestTrustedRun } from 'agent-scenario-loop/runner/compare-latest';",
      "import { runIosSimctlCapture } from 'agent-scenario-loop/runner/ios-simctl';",
      "import { readLiveProof } from 'agent-scenario-loop/runner/live-proof';",
      "import { resolveAndroidAdbDriverSteps, resolveAndroidAdbProfileCommands, runProfileAndroid } from 'agent-scenario-loop/runner/profile-android';",
      "import { runProfileIos, type CliArgs } from 'agent-scenario-loop/runner/profile-ios';",
      "import { validateProject } from 'agent-scenario-loop/runner/validate-project';",
      '',
      "const layout: ArtifactLayout = createArtifactLayout({ outputDir: 'run' });",
      "const validation: PortValidationResult = validatePortImplementation({",
      "  name: 'driver',",
      '  implementation: { tap() {}, screenshot() {} },',
      '  requiredMethods: DRIVER_PORT,',
      '});',
      "const passedResult: PortResult = { status: 'passed' };",
      'const primaryRunner: PrimaryRunnerPort = {',
      '  prepare: async () => passedResult,',
      '  launch: async () => passedResult,',
      '  startSession: async () => passedResult,',
      '  executeStep: async () => passedResult,',
      '  waitForTruthEvent: async () => passedResult,',
      '  captureEvidence: async () => passedResult,',
      '  stopSession: async () => passedResult,',
      '  finalize: async () => passedResult,',
      '};',
      'const evidenceProvider: EvidenceProviderPort = {',
      '  prepare: async () => passedResult,',
      '  startWindow: async () => passedResult,',
      '  capture: async () => passedResult,',
      '  stopWindow: async () => passedResult,',
      '  finalize: async () => passedResult,',
      '};',
      'const driverPort: DriverPort = {',
      '  tap: async () => passedResult,',
      '  scroll: async () => passedResult,',
      '  assertVisible: async () => passedResult,',
      '  inspectTree: async () => passedResult,',
      '  screenshot: async () => passedResult,',
      '  record: async () => passedResult,',
      '  readLogs: async () => passedResult,',
      '  collectPerfSignals: async () => passedResult,',
      '};',
      'const artifactWriter: ArtifactWriterPort = {',
      "  writeJson: async () => {},",
      "  writeText: async () => {},",
      "  copyRaw: async () => 'raw/output.txt',",
      '};',
      'const interpreter: InterpreterPort = {',
      "  interpret: async () => ({ likelyCauses: [], notes: [], summary: 'passed', trusted: true }),",
      '};',
      "const driverActions = collectScenarioDriverActions({ steps: [{ kind: 'gesture', driverAction: 'scroll' }] });",
      "const executionPlan = buildScenarioExecutionPlan({ id: 'scroll', steps: [{ kind: 'gesture', driverAction: 'scroll' }] });",
      "const runIndex = buildRunIndex({ rootDir: 'missing-artifacts' });",
      "const latestTrusted = findLatestTrustedRun(runIndex, 'startup');",
      "const androidDriver = createAndroidAdbDriver({",
      "  adbPath: 'adb',",
      "  deviceSerial: 'emulator-5554',",
      "  executor: async (command, commandArgs) => ({",
      '    args: commandArgs,',
      '    command,',
      '    exitCode: 0,',
      "    stderr: '',",
      "    stdout: '',",
      '  }),',
      '});',
      "const androidTap = androidDriver.tap({ x: 10, y: 20 });",
      "const androidScroll = androidDriver.scroll({ startX: 100, startY: 800, endX: 100, endY: 200 });",
      "const androidTree = androidDriver.inspectTree();",
      "const androidScreenshot = androidDriver.screenshot();",
      "const androidSelector = resolveAndroidSelectorFromUiTree({",
      "  selector: { kind: 'testId', value: 'open-card' },",
      "  uiTreeXml: '<hierarchy><node resource-id=\"dev.example:id/open-card\" bounds=\"[0,0][100,200]\" /></hierarchy>',",
      '});',
      "const androidSelectorScroll = buildAndroidScrollCoordinatesFromBounds({ bottom: 200, left: 0, right: 100, top: 0 });",
      "const androidDriverSteps = resolveAndroidAdbDriverSteps({ steps: [{ kind: 'captureEvidence', driverAction: 'readLogs', artifact: 'logs' }] });",
      "const agentDeviceDriver = createAgentDeviceDriver({",
      "  agentDevicePath: 'agent-device',",
      "  platform: 'ios',",
      "  udid: 'booted',",
      "  executor: async (command, commandArgs) => ({",
      '    args: commandArgs,',
      '    command,',
      '    exitCode: 0,',
      "    stderr: '',",
      "    stdout: '',",
      '  }),',
      '});',
      "const agentDeviceTap = agentDeviceDriver.tap({ selector: { kind: 'accessibilityLabel', value: 'Open' } });",
      "const agentDeviceSelector = formatAgentDeviceSelector({ kind: 'text', value: 'Ready' });",
      "const agentDeviceSteps = resolveAgentDeviceDriverSteps({ steps: [{ kind: 'captureEvidence', artifact: 'screenshot', driverAction: 'screenshot' }] });",
      "const agentDeviceCapture = runAgentDeviceCapture({",
      "  driverSteps: [],",
      "  executor: async (command, commandArgs) => ({",
      '    args: commandArgs,',
      '    command,',
      '    exitCode: 0,',
      "    stderr: '',",
      "    stdout: '',",
      '  }),',
      "  platform: 'ios',",
      "  runId: 'agent-device-smoke',",
      "});",
      "const iosDriver = createIosSimctlDriver({",
      "  deviceUdid: 'booted',",
      "  xcrunPath: 'xcrun',",
      "  executor: async (command, commandArgs) => ({",
      '    args: commandArgs,',
      '    command,',
      '    exitCode: 0,',
      "    stderr: '',",
      "    stdout: '',",
      '  }),',
      '});',
      "const iosLogs = iosDriver.readLogs({ last: '30s' });",
      "const iosScreenshot = iosDriver.screenshot({ display: 'Internal-1', imageType: 'jpeg', mask: 'black', outputPath: 'ios-screenshot.jpeg' });",
      "const args: CliArgs = { config: 'config.json', scenario: 'scenario.json' };",
      'const comparison = buildComparisonArtifact({',
      "  baselineHealth: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'before', healthStatus: 'passed', checks: [] },",
      "  baselineVerdict: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'before', healthStatus: 'passed', verdictStatus: 'passed' },",
      "  currentHealth: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'after', healthStatus: 'passed', checks: [] },",
      "  currentVerdict: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'after', healthStatus: 'passed', verdictStatus: 'passed' },",
      '});',
      "const summary = buildAgentSummaryMarkdown({ health: comparison, verdict: comparison });",
      "validateJson({ schemaVersion: '1.0.0' }, SCHEMAS.health, 'health');",
      "validateScenarioAdapterOptions({ effectivePlatforms: ['android'], errors: [], scenario: { id: 'startup', steps: [] } });",
      "void ARTIFACT_LAYOUT_VERSION;",
      'void layout;',
      'void validation;',
      'void primaryRunner;',
      'void evidenceProvider;',
      'void driverPort;',
      'void artifactWriter;',
      'void interpreter;',
      'void driverActions;',
      'void executionPlan;',
      'void runIndex;',
      'void latestTrusted;',
      'void androidDriver;',
      'void androidTap;',
      'void androidScroll;',
      'void androidTree;',
      'void androidScreenshot;',
      'void androidSelector;',
      'void androidSelectorScroll;',
      'void androidDriverSteps;',
      'void iosDriver;',
      'void iosLogs;',
      'void iosScreenshot;',
      'void args;',
      'void summary;',
      'void compareLatestTrustedRun;',
      'void runExampleAndroidLiveProof;',
      'void runExampleIosLiveProof;',
      'void initProject;',
      'void runIosSimctlCapture;',
      'void readLiveProof;',
      'void resolveAndroidAdbProfileCommands;',
      'void runProfileAndroid;',
      'void runProfileIos;',
      'void validateProject;',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(installDir, 'package-smoke-types.ts'), typeSmokeSource, 'utf8');
    fs.writeFileSync(
      path.join(installDir, 'tsconfig.json'),
      `${JSON.stringify({
        compilerOptions: {
          module: 'Node16',
          moduleResolution: 'Node16',
          noEmit: true,
          strict: true,
          target: 'ES2022',
        },
        include: ['package-smoke-types.ts'],
      }, null, 2)}\n`,
      'utf8',
    );
    run(typescriptBinPath(repoRoot), ['-p', installDir], {
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
  typescriptBinPath,
  writeFakeAdb,
  writeSmokeRun,
};
