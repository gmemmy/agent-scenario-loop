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

const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

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
  /^app\/profile-session(?:-authoritative-storage|-command-ordering|-dependency-controller|-storage)?\.(?:d\.ts|ts)$/u,
  /^core\/config-template\.json$/u,
  /^dist\/index\.(?:js|d\.ts)$/u,
  /^dist\/profile-session(?:-command-ordering|-storage)\.(?:js|d\.ts)$/u,
  /^dist\/app\/profile-session(?:-command-ordering|-storage)\.(?:js|d\.ts)$/u,
  /^dist\/core\/[a-z-]+\.(?:js|d\.ts)$/u,
  /^dist\/runner\/[a-z-]+\.(?:js|d\.ts)$/u,
  /^dist\/scripts\/[a-z-]+\.(?:js|d\.ts)$/u,
  /^docs\/[a-z-]+\.md$/u,
  /^examples\/.+/u,
  /^schemas\/[a-z-]+\.schema\.json$/u,
  /^templates\/[a-z0-9.-]+(?:\.(?:json|md))?$/u,
  /^templates\/skills\/agent-scenario-loop\/SKILL\.md$/u,
  /^templates\/skills\/agent-scenario-loop\/references\/[a-z-]+\.md$/u,
  /^templates\/scripts\/[a-z0-9.-]+\.mjs$/u,
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
 * Builds a compact command label for package smoke progress output.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {string}
 */
function formatCommandLabel(command: string, args: string[]): string {
  const commandName = path.basename(command);
  const renderedArgs: string[] = [];
  let skipInlineScript = false;
  for (const arg of args) {
    if (skipInlineScript) {
      skipInlineScript = false;
      continue;
    }

    if (arg === '-e') {
      renderedArgs.push('-e <inline>');
      skipInlineScript = true;
      continue;
    }

    if (arg.startsWith(os.tmpdir())) {
      renderedArgs.push(path.basename(arg));
      continue;
    }

    if (arg.length > 80) {
      renderedArgs.push(`${arg.slice(0, 77)}...`);
      continue;
    }

    renderedArgs.push(arg);
  }
  return [commandName, ...renderedArgs].join(' ');
}

/**
 * Writes a stable package smoke phase marker before a child command runs.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {void}
 */
function announceCommand(command: string, args: string[]): void {
  process.stdout.write(`package smoke command: ${formatCommandLabel(command, args)}\n`);
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
  announceCommand(command, args);
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: resolveCommandTimeoutMs(options.env),
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
  announceCommand(command, args);
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
    "  [`-s emulator-5554 shell pidof ${packageName}`, { stdout: '1234\\n' }],",
    "  ['-s emulator-5554 shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status', { stdout: '<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy><node resource-id=\"dev.agentscenarioloop.example:id/asl-example-title\" text=\"Example Mobile App\" bounds=\"[10,20][300,80]\" /></hierarchy>\\n' }],",
    "  ['-s emulator-5554 exec-out screencap -p', { stdout: 'fake png' }],",
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
    "if (key.endsWith(`shell pidof ${packageName}`)) ok('1234\\n');",
    "if (key.endsWith('shell rm -f /sdcard/agent-scenario-loop-ui.xml; uiautomator dump /sdcard/agent-scenario-loop-ui.xml >/dev/null; cat /sdcard/agent-scenario-loop-ui.xml; status=$?; rm -f /sdcard/agent-scenario-loop-ui.xml; exit $status')) ok('<?xml version=\"1.0\" encoding=\"UTF-8\"?><hierarchy><node resource-id=\"dev.agentscenarioloop.example:id/asl-example-title\" text=\"Example Mobile App\" bounds=\"[10,20][300,80]\" /></hierarchy>\\n');",
    "if (key.endsWith('exec-out screencap -p')) ok('fake png');",
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
 * Writes a tiny Argent-compatible command for installed-package smoke tests.
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
    "function ok(stdout = '{\"description\":\"Home Ready asl-example-title Example Mobile App\"}\\n') { process.stdout.write(stdout); process.exit(0); }",
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
    "if (args[0] === 'simctl' && args[1] === 'io' && args[2] === deviceId && args[3] === 'screenshot' && typeof args[4] === 'string') {",
    "  fs.mkdirSync(path.dirname(args[4]), { recursive: true });",
    "  fs.writeFileSync(args[4], 'fake screenshot', 'utf8');",
    "  ok('');",
    "}",
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
 * Asserts that an installed-package comparison carries latest-trusted provenance.
 *
 * @param {{artifactRoot: string, baselineRunDir: string, baselineRunId: string, comparison: Record<string, any>, currentRunDir: string, currentRunId: string}} options
 * @returns {void}
 */
function assertLatestTrustedComparisonBasis({
  artifactRoot,
  baselineRunDir,
  baselineRunId,
  comparison,
  currentRunDir,
  currentRunId,
}: {
  artifactRoot: string;
  baselineRunDir: string;
  baselineRunId: string;
  comparison: Record<string, any>;
  currentRunDir: string;
  currentRunId: string;
}): void {
  assert.equal(comparison.comparisonBasis.strategy, 'latest_trusted_prior');
  assert.equal(comparison.comparisonBasis.baseline.runId, baselineRunId);
  assert.equal(comparison.comparisonBasis.baseline.runDir, baselineRunDir);
  assert.equal(comparison.comparisonBasis.current.runId, currentRunId);
  assert.equal(comparison.comparisonBasis.current.runDir, currentRunDir);
  assert.equal(comparison.comparisonBasis.selection.artifactRoot, artifactRoot);
  assert.equal(comparison.comparisonBasis.selection.selectedRunId, baselineRunId);
  assert.equal(comparison.comparisonBasis.selection.selectedRunDir, baselineRunDir);
  assert.equal(comparison.comparisonBasis.selection.scenarioId, comparison.scenarioId);
  assert.equal(comparison.comparisonBasis.selection.skippedCurrentRun, true);
  assert.equal(comparison.comparisonBasis.selection.trustedPriorCandidates >= 1, true);
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
    assert.equal(
      fs.existsSync(path.join(repoRoot, '.npmignore')),
      true,
      'root .npmignore must exist so npm pack never falls back to .gitignore',
    );
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'examples', 'mobile-app', '.npmignore')),
      true,
      'example app .npmignore must exist so npm pack never falls back to the app-local .gitignore',
    );
    const providedTarballPath = resolveProvidedTarball(env);
    const tarballPath = providedTarballPath ?? (() => {
      const packOutput = run('npm', ['pack', '--pack-destination', packDir], {
        cwd: repoRoot,
        env,
      });
      const tarballName = packOutput.trim().split(/\n/u).pop();
      assert.ok(tarballName, 'npm pack did not print a tarball name');
      const packedTarballPath = path.join(packDir, tarballName);
      assert.equal(fs.existsSync(packedTarballPath), true, `missing packed tarball: ${packedTarballPath}`);
      return packedTarballPath;
    })();

    run('npm', ['init', '-y'], {
      cwd: installDir,
      env,
    });
    run('npm', ['install', tarballPath, '--ignore-scripts'], {
      cwd: installDir,
      env,
    });

    const packageRoot = path.join(installDir, 'node_modules', 'agent-scenario-loop');
    const installedPackageManifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    assert.equal(
      Object.prototype.hasOwnProperty.call(installedPackageManifest.dependencies ?? {}, '@types/node'),
      false,
      'packed agent-scenario-loop must not declare a runtime dependency on @types/node',
    );
    assert.equal(
      fs.existsSync(path.join(installDir, 'node_modules', '@types', 'node')),
      false,
      'packed-consumer install must not contain node_modules/@types/node',
    );
    const commonJsSmokeScript = [
      "const assert = require('node:assert/strict');",
      "const asl = require('agent-scenario-loop');",
      "assert.equal(typeof asl.buildRunIndex, 'function');",
      "assert.equal(typeof asl.createArtifactLayout, 'function');",
      "assert.equal(typeof asl.validateJson, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceReportIdentity, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceResultAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimJsonNativePointInterpretation, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimJsonNativeWindowedInterpretation, 'function');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION, '1.0.0');",
      "const cjsPointAssertion = { id: 'usable-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } };",
      "const cjsPointAdmitted = { contractVersion: '1.0.0', status: 'admitted', candidateId: 'cjs-point', runIdentityHash: 'a'.repeat(64), claimId: 'app-usable', claimHash: 'b'.repeat(64), assertionId: 'usable-event', assertionKind: 'eventOccurrence', artifact: { path: 'raw/cjs-point.json', sha256: 'c'.repeat(64), byteLength: 1 }, observation: { schemaVersion: '1.0.0', kind: 'eventOccurrence', occurrences: [{ event: 'app_first_usable_screen', atMs: 1 }] } };",
      "const cjsPointInterpretation = asl.inspectScenarioClaimJsonNativePointInterpretation(cjsPointAssertion, cjsPointAdmitted);",
      "assert.equal(cjsPointInterpretation.status, 'interpreted');",
      "assert.equal(cjsPointInterpretation.result.status, 'supported');",
    ].join('\n');
    run(process.execPath, ['-e', commonJsSmokeScript], {
      cwd: installDir,
      env,
    });

    const esmSmokeScriptPath = path.join(installDir, 'package-smoke-esm.mjs');
    fs.writeFileSync(esmSmokeScriptPath, [
      "import assert from 'node:assert/strict';",
      "import * as asl from 'agent-scenario-loop';",
      "import * as demoLoop from 'agent-scenario-loop/runner/demo-loop';",
      "assert.equal(typeof asl.buildRunIndex, 'function');",
      "assert.equal(typeof asl.createArtifactLayout, 'function');",
      "assert.equal(typeof asl.validateJson, 'function');",
      "assert.equal(typeof asl.coordinateQuickProof, 'function');",
      "assert.equal(typeof asl.createQuickProofAuthorizationPort, 'function');",
      "assert.equal(typeof asl.writeQuickProofArtifacts, 'function');",
      "assert.equal(typeof asl.buildScenarioClaimEvidenceRunIdentityHash, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimEvidenceCandidateIdentity, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimRawObservationAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceReportIdentity, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceResultAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimJsonNativePointInterpretation, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimJsonNativeWindowedInterpretation, 'function');",
      "assert.equal(asl.CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_RAW_OBSERVATION_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_RAW_OBSERVATION_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_EVIDENCE_RUN_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(typeof demoLoop.runDemoLoop, 'function');",
    ].join('\n'), 'utf8');
    run(process.execPath, [esmSmokeScriptPath], {
      cwd: installDir,
      env,
    });

    const esmEvidenceIdentityPath = path.join(installDir, 'package-smoke-evidence-identity.mjs');
    fs.writeFileSync(esmEvidenceIdentityPath, [
      "import assert from 'node:assert/strict';",
      "import crypto from 'node:crypto';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { createRequire } from 'node:module';",
      "import * as asl from 'agent-scenario-loop';",
      "const require = createRequire(import.meta.url);",
      "const packageJson = require('agent-scenario-loop/package.json');",
      "const packageRoot = path.join(process.cwd(), 'node_modules', 'agent-scenario-loop');",
      "function readJson(relativePath) { return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), 'utf8')); }",
      "assert.equal(asl.CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_EVIDENCE_RUN_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_RAW_OBSERVATION_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_RAW_OBSERVATION_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION, '1.0.0');",
      "const claimCompleteScenario = readJson('examples/scenarios/mobile/app-startup.json');",
      "claimCompleteScenario.schemaVersion = '1.1.0';",
      "claimCompleteScenario.journey = { name: 'Start app', intent: 'Reach a usable app surface.', actor: 'user', startState: 'app stopped', endState: 'app usable', phases: [{ id: 'launch', description: 'Launch app.', coverageKind: 'product' }], terminalInvariants: [{ id: 'usable', description: 'App remains usable.', coverageKind: 'product' }], recovery: { status: 'not_required', rationale: 'No interruption is authored.' } };",
      "claimCompleteScenario.claims = [{ id: 'app-usable', role: 'mandatory', applicability: { platforms: ['ios', 'android'] }, closes: { phases: ['launch'], terminalInvariants: ['usable'] }, assertions: [{ id: 'usable-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } }] }];",
      "claimCompleteScenario.safety = { class: 'read_only', rationale: 'The scenario observes product behavior without mutation.', allowedOperations: ['observe'] };",
      "claimCompleteScenario.dependencies = [{ id: 'app-entry-ready', kind: 'journey_entry', applicability: { platforms: ['ios', 'android'] }, predicate: { id: 'entry-ready-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } } }];",
      "const claimCompleteScenarioHash = asl.buildScenarioClaimCompleteContractHash(claimCompleteScenario);",
      "const scenarioApproval = { schemaVersion: '1.0.0', approvalId: 'package-smoke-approval', scenarioId: claimCompleteScenario.id, scenarioHash: claimCompleteScenarioHash, selection: { platform: 'ios' }, decision: 'approved', approvedAt: '2026-08-21T12:00:00Z', approverRef: 'package-smoke-review' };",
      "const scenarioAuthorization = { schemaVersion: '1.0.0', grantId: 'package-smoke-grant', scenarioId: claimCompleteScenario.id, scenarioHash: claimCompleteScenarioHash, selection: { platform: 'ios' }, safetyClass: 'read_only', goalId: 'package-smoke-goal', operations: ['observe'], targetResource: 'mobile-target:ios:package-smoke', expiresAt: '2026-08-21T12:00:01.000Z', delegationChain: ['local-owner'] };",
      "const scenarioAuthorizationRequest = { goalId: 'package-smoke-goal', operations: ['observe'], targetResource: 'mobile-target:ios:package-smoke', nowMs: Date.parse('2026-08-21T12:00:00.000Z') };",
      "const claimAdmissionAuthority = { schemaVersion: '1.0.0', declarationId: 'package-smoke-app-authority', role: 'app', producerId: 'app', platforms: ['ios'], assertionKinds: ['eventOccurrence'], evidenceSelectors: ['events.app_first_usable_screen'], maxStrength: 'verified', maxCompleteness: 'continuous-complete' };",
      "const claimAdmission = asl.inspectScenarioClaimAdmission({ scenario: claimCompleteScenario, selection: { platform: 'ios' }, authorityCatalog: [claimAdmissionAuthority], authorizationRequest: scenarioAuthorizationRequest, authorizationGrant: scenarioAuthorization, approval: scenarioApproval });",
      "const claimEvidenceRunIdentity = { schemaVersion: '1.0.0', scenarioId: claimCompleteScenario.id, scenarioHash: claimCompleteScenarioHash, runId: 'package-smoke-evidence-run', attemptId: 'attempt-1', selection: { platform: 'ios' }, source: { gitSha: 'c156f784600e8b5245cfedbcdbd2a48376704f70' }, package: { name: 'agent-scenario-loop', version: packageJson.version, sha256: 'a'.repeat(64) }, target: { resourceId: 'mobile-target:ios:package-smoke', deviceId: 'package-smoke-device', runtimeId: 'ios-package-smoke' }, installedApp: { appId: 'dev.example.app', version: '1.0.0', buildId: '1', sha256: 'b'.repeat(64) }, runner: { id: 'package-smoke-runner', version: packageJson.version }, adapter: { id: 'package-smoke-adapter', version: '1.0.0' }, transport: { id: 'package-smoke-transport', version: '1.0.0' }, appHelper: { payloadId: 'profile-session-helper@1.1.0', sha256: 'c'.repeat(64) }, environment: { id: 'package-smoke-environment', cohortHash: 'a'.repeat(64) }, producers: [{ role: 'app', producerId: 'app', version: '1.0.0', sha256: 'b'.repeat(64) }] };",
      "const rawObservationBytes = Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', kind: 'eventOccurrence', occurrences: [{ event: 'app_first_usable_screen', atMs: 42 }] }), 'utf8');",
      "const rawObservationSha256 = crypto.createHash('sha256').update(rawObservationBytes).digest('hex');",
      "const claimEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'package-smoke-candidate', runIdentityHash: asl.buildScenarioClaimEvidenceRunIdentityHash(claimEvidenceRunIdentity), claimId: 'app-usable', claimHash: asl.buildScenarioClaimHash(claimCompleteScenario.claims[0]), assertionId: 'usable-event', assertionKind: 'eventOccurrence', authority: { declarationId: 'package-smoke-app-authority', role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', producerVersion: '1.0.0', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/profile-events.json', sha256: rawObservationSha256 }, cleanupStatus: 'finalized', redactionStatus: 'not-redacted' };",
      "const claimEvidenceInspection = asl.inspectScenarioClaimEvidenceCandidateIdentity({ admission: claimAdmission, scenario: claimCompleteScenario, runIdentity: claimEvidenceRunIdentity, claimId: 'app-usable', assertionId: 'usable-event', candidate: claimEvidenceCandidate });",
      "assert.equal(claimEvidenceInspection.status, 'eligible');",
      "assert.equal(claimEvidenceInspection.contractVersion, '1.0.0');",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection, 'eligibleCandidate'), true);",
      "assert.notEqual(claimEvidenceInspection.eligibleCandidate, claimEvidenceCandidate);",
      "assert.equal(claimEvidenceInspection.eligibleCandidate.captureStatus, 'produced');",
      "assert.equal(claimEvidenceInspection.eligibleCandidate.assertionKind, 'eventOccurrence');",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection.eligibleCandidate, 'artifactKind'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection.eligibleCandidate, 'observationWindow'), false);",
      "const rawObservationAdmission = asl.inspectScenarioClaimRawObservationAdmission({ candidate: claimEvidenceInspection.eligibleCandidate, artifactBytes: rawObservationBytes });",
      "assert.equal(rawObservationAdmission.status, 'admitted');",
      "assert.equal(rawObservationAdmission.artifact.sha256, rawObservationSha256);",
      "assert.equal(rawObservationAdmission.observation.occurrences[0].event, 'app_first_usable_screen');",
      "const pointInterpretation = asl.inspectScenarioClaimJsonNativePointInterpretation({ id: 'usable-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } }, rawObservationAdmission);",
      "assert.equal(pointInterpretation.status, 'interpreted');",
      "assert.equal(pointInterpretation.trust, 'admitted_observation_interpretation_only');",
      "assert.equal(pointInterpretation.result.status, 'supported');",
      "assert.equal(pointInterpretation.result.assertionId, 'usable-event');",
      "assert.equal(pointInterpretation.result.evidenceReferences.length, 1);",
      "assert.equal(pointInterpretation.result.evidenceReferences[0].path, rawObservationAdmission.artifact.path);",
      "assert.equal(pointInterpretation.result.evidenceReferences[0].sha256, rawObservationAdmission.artifact.sha256);",
      "const pointInterpretationOutsideContract = asl.inspectScenarioClaimJsonNativePointInterpretation({ id: 'usable-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } }, { ...rawObservationAdmission, assertionId: 'other-event' });",
      "assert.equal(pointInterpretationOutsideContract.status, 'outside_contract');",
      "const pointInterpretationNotEvaluable = asl.inspectScenarioClaimJsonNativePointInterpretation({ id: 'usable-event', kind: 'eventOccurrence', event: 'journey_completed', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } }, rawObservationAdmission);",
      "assert.equal(pointInterpretationNotEvaluable.status, 'interpreted');",
      "assert.equal(pointInterpretationNotEvaluable.result.status, 'not_evaluable');",
      "assert.equal(pointInterpretationNotEvaluable.result.reasonCode, 'missing_authoritative_evidence');",
      "assert.equal(pointInterpretationNotEvaluable.result.assertionId, 'usable-event');",
      "assert.equal(pointInterpretationNotEvaluable.result.evidenceReferences.length, 1);",
      "assert.equal(pointInterpretationNotEvaluable.result.evidenceReferences[0].path, rawObservationAdmission.artifact.path);",
      "assert.equal(pointInterpretationNotEvaluable.result.evidenceReferences[0].sha256, rawObservationAdmission.artifact.sha256);",
      "const windowedObservationBytes = Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', kind: 'boundedCount', selector: 'events.app_first_usable_screen', count: 1, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }), 'utf8');",
      "const windowedObservationSha256 = crypto.createHash('sha256').update(windowedObservationBytes).digest('hex');",
      "const windowedEvidenceCandidate = { ...claimEvidenceInspection.eligibleCandidate, candidateId: 'package-smoke-windowed-candidate', assertionId: 'bounded-count', assertionKind: 'boundedCount', authority: { ...claimEvidenceInspection.eligibleCandidate.authority, strength: 'verified', completeness: 'bounded' }, evidence: { path: 'raw/windowed-events.json', sha256: windowedObservationSha256 }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } };",
      "const windowedObservationAdmission = asl.inspectScenarioClaimRawObservationAdmission({ candidate: windowedEvidenceCandidate, artifactBytes: windowedObservationBytes });",
      "assert.equal(windowedObservationAdmission.status, 'admitted');",
      "const boundedCountInterpretation = asl.inspectScenarioClaimJsonNativeWindowedInterpretation({ id: 'bounded-count', kind: 'boundedCount', selector: 'events.app_first_usable_screen', minimum: 1, maximum: 1, authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'verified', completeness: 'bounded' }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, windowedObservationAdmission);",
      "assert.equal(boundedCountInterpretation.status, 'interpreted');",
      "assert.equal(boundedCountInterpretation.trust, 'admitted_observation_interpretation_only');",
      "assert.equal(boundedCountInterpretation.result.status, 'supported');",
      "assert.equal(boundedCountInterpretation.result.assertionId, 'bounded-count');",
      "assert.equal(boundedCountInterpretation.result.assertionKind, 'boundedCount');",
      "assert.equal(boundedCountInterpretation.result.evidenceReferences.length, 1);",
      "assert.equal(boundedCountInterpretation.result.evidenceReferences[0].path, windowedObservationAdmission.artifact.path);",
      "assert.equal(boundedCountInterpretation.result.evidenceReferences[0].sha256, windowedObservationAdmission.artifact.sha256);",
      "const absenceObservationBytes = Buffer.from(JSON.stringify({ schemaVersion: '1.0.0', kind: 'absence', selector: 'error_event', count: 0, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }), 'utf8');",
      "const absenceObservationSha256 = crypto.createHash('sha256').update(absenceObservationBytes).digest('hex');",
      "const absenceEvidenceCandidate = { ...claimEvidenceInspection.eligibleCandidate, candidateId: 'package-smoke-absence-candidate', assertionId: 'absence-event', assertionKind: 'absence', authority: { ...claimEvidenceInspection.eligibleCandidate.authority, evidenceSelector: 'error_event', strength: 'verified', completeness: 'continuous-complete' }, evidence: { path: 'raw/absence-events.json', sha256: absenceObservationSha256 }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } };",
      "const absenceObservationAdmission = asl.inspectScenarioClaimRawObservationAdmission({ candidate: absenceEvidenceCandidate, artifactBytes: absenceObservationBytes });",
      "assert.equal(absenceObservationAdmission.status, 'admitted');",
      "const absenceInterpretation = asl.inspectScenarioClaimJsonNativeWindowedInterpretation({ id: 'absence-event', kind: 'absence', selector: 'error_event', authority: { role: 'app', producerId: 'app', evidenceSelector: 'error_event', requiredStrength: 'verified', completeness: 'continuous-complete' }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, absenceObservationAdmission);",
      "assert.equal(absenceInterpretation.status, 'interpreted');",
      "assert.equal(absenceInterpretation.trust, 'admitted_observation_interpretation_only');",
      "assert.equal(absenceInterpretation.result.status, 'supported');",
      "assert.equal(absenceInterpretation.result.assertionId, 'absence-event');",
      "assert.equal(absenceInterpretation.result.assertionKind, 'absence');",
      "assert.equal(absenceInterpretation.result.evidenceReferences.length, 1);",
      "assert.equal(absenceInterpretation.result.evidenceReferences[0].path, absenceObservationAdmission.artifact.path);",
      "assert.equal(absenceInterpretation.result.evidenceReferences[0].sha256, absenceObservationAdmission.artifact.sha256);",
      "const windowedInterpretationOutsideContract = asl.inspectScenarioClaimJsonNativeWindowedInterpretation({ id: 'bounded-count', kind: 'boundedCount', selector: 'events.app_first_usable_screen', minimum: 1, maximum: 1, authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'verified', completeness: 'bounded' }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, { ...windowedObservationAdmission, assertionId: 'other-event' });",
      "assert.equal(windowedInterpretationOutsideContract.status, 'outside_contract');",
      "const rawObservationMismatch = asl.inspectScenarioClaimRawObservationAdmission({ candidate: claimEvidenceInspection.eligibleCandidate, artifactBytes: Buffer.from('{}', 'utf8') });",
      "assert.equal(rawObservationMismatch.status, 'blocked');",
      "assert.deepEqual(rawObservationMismatch.reasonCodes, ['artifact_hash_mismatch']);",
      "const validatorBytes = Buffer.from('validator-report', 'utf8');",
      "const validatorSha256 = crypto.createHash('sha256').update(validatorBytes).digest('hex');",
      "const validatedEvidenceCandidate = { ...claimEvidenceInspection.eligibleCandidate, candidateId: 'validated-candidate', assertionId: 'validated-assertion', assertionKind: 'validatedEvidence', evidence: { path: 'raw/validator.txt', sha256: validatorSha256 }, artifactKind: 'video', validationContract: 'media-v1' };",
      "const validatedEvidenceAdmission = asl.inspectScenarioClaimRawObservationAdmission({ candidate: validatedEvidenceCandidate, artifactBytes: validatorBytes });",
      "assert.equal(validatedEvidenceAdmission.status, 'unsupported');",
      "assert.equal(validatedEvidenceAdmission.reasonCode, 'validated_evidence_report_identity_undefined');",
      "const subjectBytes = Buffer.from('validated-subject', 'utf8');",
      "const subjectSha256 = crypto.createHash('sha256').update(subjectBytes).digest('hex');",
      "const reportBytes = Buffer.from('opaque-validator-report', 'utf8');",
      "const reportSha256 = crypto.createHash('sha256').update(reportBytes).digest('hex');",
      "const validatedEvidenceIdentityCandidate = { ...claimEvidenceInspection.eligibleCandidate, candidateId: 'validated-identity-candidate', assertionId: 'validated-identity-assertion', assertionKind: 'validatedEvidence', evidence: { path: 'captures/video.mp4', sha256: subjectSha256 }, artifactKind: 'video', validationContract: 'media-v1' };",
      "const validatedEvidenceReport = { path: 'raw/validator-report.bin', sha256: reportSha256 };",
      "const validatedEvidenceReportIdentity = asl.inspectScenarioClaimValidatedEvidenceReportIdentity({ candidate: validatedEvidenceIdentityCandidate, report: validatedEvidenceReport, reportBytes });",
      "assert.equal(validatedEvidenceReportIdentity.status, 'admitted');",
      "assert.equal(validatedEvidenceReportIdentity.subjectArtifact.path, 'captures/video.mp4');",
      "assert.equal(validatedEvidenceReportIdentity.subjectArtifact.sha256, subjectSha256);",
      "assert.equal(validatedEvidenceReportIdentity.reportArtifact.path, 'raw/validator-report.bin');",
      "assert.equal(validatedEvidenceReportIdentity.reportArtifact.sha256, reportSha256);",
      "assert.equal(validatedEvidenceReportIdentity.reportArtifact.byteLength, reportBytes.byteLength);",
      "const validatedEvidenceIdentityAdmission = asl.inspectScenarioClaimValidatedEvidenceAdmission({ candidate: validatedEvidenceIdentityCandidate, subjectBytes, report: validatedEvidenceReport, reportBytes });",
      "assert.equal(validatedEvidenceIdentityAdmission.status, 'identity_admitted');",
      "assert.equal(validatedEvidenceIdentityAdmission.candidateId, 'validated-identity-candidate');",
      "assert.equal(validatedEvidenceIdentityAdmission.assertionKind, 'validatedEvidence');",
      "assert.equal(validatedEvidenceIdentityAdmission.subjectArtifact.path, 'captures/video.mp4');",
      "assert.equal(validatedEvidenceIdentityAdmission.subjectArtifact.sha256, subjectSha256);",
      "assert.equal(validatedEvidenceIdentityAdmission.subjectArtifact.byteLength, subjectBytes.byteLength);",
      "assert.equal(validatedEvidenceIdentityAdmission.reportArtifact.path, 'raw/validator-report.bin');",
      "assert.equal(validatedEvidenceIdentityAdmission.reportArtifact.sha256, reportSha256);",
      "assert.equal(validatedEvidenceIdentityAdmission.reportArtifact.byteLength, reportBytes.byteLength);",
      "const resultPayload = { schemaVersion: '1.0.0', resultId: 'results/media-validator-1', assertionId: validatedEvidenceIdentityAdmission.assertionId, validationContract: validatedEvidenceIdentityAdmission.validationContract, validator: { producerId: 'media-validator', producerVersion: '1.0.0', producerSha256: 'e'.repeat(64) }, subject: { path: validatedEvidenceIdentityAdmission.subjectArtifact.path, sha256: validatedEvidenceIdentityAdmission.subjectArtifact.sha256 }, report: { path: validatedEvidenceIdentityAdmission.reportArtifact.path, sha256: validatedEvidenceIdentityAdmission.reportArtifact.sha256 }, status: 'passed', reasonCode: 'validation_passed' };",
      "assert.equal(asl.validateJson(resultPayload, asl.SCHEMAS.validatedEvidenceResult, 'validated evidence result').valid, true);",
      "const resultBytes = Buffer.from(JSON.stringify(resultPayload), 'utf8');",
      "const resultSha256 = crypto.createHash('sha256').update(resultBytes).digest('hex');",
      "const result = { path: 'raw/validator-result.json', sha256: resultSha256 };",
      "const validatedEvidenceResultAdmission = asl.inspectScenarioClaimValidatedEvidenceResultAdmission({ validatedEvidence: validatedEvidenceIdentityAdmission, result, resultBytes });",
      "assert.equal(validatedEvidenceResultAdmission.status, 'admitted');",
      "assert.equal(validatedEvidenceResultAdmission.candidateId, 'validated-identity-candidate');",
      "assert.equal(validatedEvidenceResultAdmission.assertionId, validatedEvidenceIdentityAdmission.assertionId);",
      "assert.equal(validatedEvidenceResultAdmission.validationContract, validatedEvidenceIdentityAdmission.validationContract);",
      "assert.equal(validatedEvidenceResultAdmission.validatorResultStatus, 'passed');",
      "assert.equal(validatedEvidenceResultAdmission.validatorReasonCode, 'validation_passed');",
      "assert.equal(validatedEvidenceResultAdmission.resultArtifact.path, result.path);",
      "assert.equal(validatedEvidenceResultAdmission.resultArtifact.sha256, resultSha256);",
      "assert.equal(validatedEvidenceResultAdmission.resultArtifact.byteLength, resultBytes.byteLength);",
      "assert.equal(validatedEvidenceResultAdmission.resultId, 'results/media-validator-1');",
      "assert.deepEqual(validatedEvidenceResultAdmission.validator, { producerId: resultPayload.validator.producerId, producerVersion: resultPayload.validator.producerVersion, producerSha256: resultPayload.validator.producerSha256 });",
      "assert.deepEqual(validatedEvidenceResultAdmission.subject, { path: validatedEvidenceIdentityAdmission.subjectArtifact.path, sha256: validatedEvidenceIdentityAdmission.subjectArtifact.sha256 });",
      "assert.deepEqual(validatedEvidenceResultAdmission.report, { path: validatedEvidenceIdentityAdmission.reportArtifact.path, sha256: validatedEvidenceIdentityAdmission.reportArtifact.sha256 });",
      "assert.equal(validatedEvidenceResultAdmission.nextAction, 'treat_validator_result_as_identity_evidence_only');",
      "const invalidPassedFailed = { ...resultPayload, status: 'passed', reasonCode: 'validation_failed' };",
      "assert.equal(asl.validateJson(invalidPassedFailed, asl.SCHEMAS.validatedEvidenceResult, 'invalid passed+validation_failed').valid, false);",
      "const invalidFailedPassed = { ...resultPayload, status: 'failed', reasonCode: 'validation_passed' };",
      "assert.equal(asl.validateJson(invalidFailedPassed, asl.SCHEMAS.validatedEvidenceResult, 'invalid failed+validation_passed').valid, false);",
      "const invalidNotEvaluablePassed = { ...resultPayload, status: 'not_evaluable', reasonCode: 'validation_passed' };",
      "assert.equal(asl.validateJson(invalidNotEvaluablePassed, asl.SCHEMAS.validatedEvidenceResult, 'invalid not_evaluable+validation_passed').valid, false);",
      "const invalidNotApplicable = { ...resultPayload, status: 'not_applicable', reasonCode: 'validation_passed' };",
      "assert.equal(asl.validateJson(invalidNotApplicable, asl.SCHEMAS.validatedEvidenceResult, 'invalid status not_applicable').valid, false);",
      "const validNotEvaluable = { ...resultPayload, status: 'not_evaluable', reasonCode: 'validator_unavailable' };",
      "assert.equal(asl.validateJson(validNotEvaluable, asl.SCHEMAS.validatedEvidenceResult, 'valid not_evaluable').valid, true);",
      "const validatedEvidenceResultMismatch = asl.inspectScenarioClaimValidatedEvidenceResultAdmission({ validatedEvidence: validatedEvidenceIdentityAdmission, result, resultBytes: Buffer.from('wrong-result', 'utf8') });",
      "assert.equal(validatedEvidenceResultMismatch.status, 'blocked');",
      "const validatedEvidenceWrongSubject = asl.inspectScenarioClaimValidatedEvidenceAdmission({ candidate: validatedEvidenceIdentityCandidate, subjectBytes: Buffer.from('wrong-subject', 'utf8'), report: validatedEvidenceReport, reportBytes });",
      "assert.equal(validatedEvidenceWrongSubject.status, 'subject_blocked');",
      "assert.deepEqual(validatedEvidenceWrongSubject.reasonCodes, ['subject_hash_mismatch']);",
      "const validatedEvidenceWrongReport = asl.inspectScenarioClaimValidatedEvidenceAdmission({ candidate: validatedEvidenceIdentityCandidate, subjectBytes, report: validatedEvidenceReport, reportBytes: Buffer.from('wrong-report', 'utf8') });",
      "assert.equal(validatedEvidenceWrongReport.status, 'report_blocked');",
      "assert.equal(validatedEvidenceWrongReport.reportIdentity.status, 'blocked');",
      "assert.deepEqual(validatedEvidenceWrongReport.reportIdentity.reasonCodes, ['report_hash_mismatch']);",
      "const blockedClaimEvidenceInspection = asl.inspectScenarioClaimEvidenceCandidateIdentity({ admission: claimAdmission, scenario: claimCompleteScenario, runIdentity: claimEvidenceRunIdentity, claimId: 'app-usable', assertionId: 'usable-event', candidate: { ...claimEvidenceCandidate, runIdentityHash: 'd'.repeat(64) } });",
      "assert.equal(blockedClaimEvidenceInspection.status, 'blocked');",
      "assert.equal(Object.prototype.hasOwnProperty.call(blockedClaimEvidenceInspection, 'eligibleCandidate'), false);",
      "const outsideClaimEvidenceInspection = asl.inspectScenarioClaimEvidenceCandidateIdentity({ admission: { ...claimAdmission, status: 'blocked' }, scenario: claimCompleteScenario, runIdentity: claimEvidenceRunIdentity, claimId: 'app-usable', assertionId: 'usable-event', candidate: claimEvidenceCandidate });",
      "assert.equal(outsideClaimEvidenceInspection.status, 'outside_contract');",
      "assert.equal(Object.prototype.hasOwnProperty.call(outsideClaimEvidenceInspection, 'eligibleCandidate'), false);",
      "assert.throws(() => asl.buildScenarioClaimEvidenceRunIdentityHash({ ...claimEvidenceRunIdentity, runId: ' padded' }), asl.InvalidScenarioClaimEvidenceRunIdentityError);",
    ].join('\n'), 'utf8');
    run(process.execPath, [esmEvidenceIdentityPath], {
      cwd: installDir,
      env,
    });

    const realInstallDir = fs.realpathSync(installDir);
    const demoOutputDir = path.join(realInstallDir, 'artifacts', 'asl', 'demo');
    const demoOutput = run('npx', [
      '--no-install',
      'asl-demo-loop',
      '--out',
      path.join('artifacts', 'asl', 'demo'),
    ], {
      cwd: installDir,
      env,
    });
    const demoResult = JSON.parse(demoOutput) as {
      baselineRunDir: string;
      currentRunDir: string;
      outputDir: string;
      preflightDir: string;
    };
    assert.equal(demoResult.outputDir, demoOutputDir);
    assert.equal(fs.existsSync(path.join(demoOutputDir, 'preflight', 'app-startup', 'health.json')), true);
    assert.equal(fs.existsSync(path.join(demoOutputDir, 'preflight', 'app-startup', 'agent-summary.md')), true);
    assert.equal(fs.existsSync(path.join(demoOutputDir, 'profile-runs', 'app-startup', 'demo-baseline', 'health.json')), true);
    assert.equal(fs.existsSync(path.join(demoOutputDir, 'profile-runs', 'app-startup', 'demo-current', 'health.json')), true);
    assert.equal(fs.existsSync(path.join(demoOutputDir, 'profile-runs', 'app-startup', 'demo-current', 'comparison.json')), true);
    assert.equal(fs.existsSync(path.join(demoOutputDir, 'profile-runs', 'app-startup', 'demo-current', 'agent-summary.md')), true);
    assert.equal(demoResult.baselineRunDir, path.join(demoOutputDir, 'profile-runs', 'app-startup', 'demo-baseline'));
    assert.equal(demoResult.currentRunDir, path.join(demoOutputDir, 'profile-runs', 'app-startup', 'demo-current'));
    assert.equal(demoResult.preflightDir, path.join(demoOutputDir, 'preflight', 'app-startup'));

    const packedFiles = listFiles(packageRoot);
    assert.equal(
      packedFiles.includes('examples/mobile-app/scenarios/android/app-startup.json'),
      true,
      'packed package must include Android example app scenarios',
    );
    assert.equal(
      packedFiles.includes('examples/mobile-app/scenarios/ios/app-startup.json'),
      true,
      'packed package must include iOS example app scenarios',
    );
    const packedExampleScripts = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'examples', 'mobile-app', 'asl', 'package-scripts.json'), 'utf8'),
    );
    assert.match(packedExampleScripts['asl:argent:ios'], /ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK/u);
    assert.match(packedExampleScripts['asl:argent:ios'], /ASL_XCRUN_PATH/u);
    const forbiddenPathPatterns = [
      /^\.github\//u,
      /^artifacts\//u,
      /^dist\/.*__tests__\//u,
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
    assert.equal(fs.existsSync(path.join(initOutputDir, '.agents', 'skills', 'agent-scenario-loop', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'src', 'devtools', 'profile-session.ts')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'src', 'devtools', 'profile-session-storage.ts')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'src', 'devtools', 'profile-session-command-ordering.ts')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'src', 'devtools', 'profile-session-dependency-controller.ts')), true);
    const initWithSkillOutputDir = path.join(tempRoot, 'initialized-app-with-skill');
    const initWithSkillOutput = run(packageBinPath(installDir, 'asl-init'), [
      '--out',
      initWithSkillOutputDir,
      '--scenario',
      'Checkout Submit',
      '--with-agent-skill',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(initWithSkillOutput, /Agent Scenario Loop files initialized/u);
    assert.equal(fs.existsSync(path.join(initWithSkillOutputDir, '.agents', 'skills', 'agent-scenario-loop', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(initWithSkillOutputDir, '.agents', 'skills', 'agent-scenario-loop', 'references', 'artifact-interpretation.md')), true);
    assert.equal(fs.existsSync(path.join(initWithSkillOutputDir, '.agents', 'skills', 'agent-scenario-loop', 'references', 'adoption-checklist.md')), true);
    assert.match(
      fs.readFileSync(path.join(initWithSkillOutputDir, '.agents', 'skills', 'agent-scenario-loop', 'SKILL.md'), 'utf8'),
      /Treat passed health plus failed verdict as trustworthy evidence of failure/u,
    );
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
    assert.equal(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'README.md'), 'utf8').includes('--current <run-dir>'),
      false,
    );
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'README.md'), 'utf8'),
      /ASL_COMPARE_ANDROID_CURRENT=/u,
    );
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'README.md'), 'utf8'),
      /Keep deterministic validation and live device proof as separate lanes/u,
    );
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'README.md'), 'utf8'),
      /host\/device access/u,
    );
    const initializedScripts = JSON.parse(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'package-scripts.json'), 'utf8'),
    );
    const initializedConfig = JSON.parse(
      fs.readFileSync(path.join(initOutputDir, 'asl.config.json'), 'utf8'),
    );
    assert.deepEqual(initializedConfig.drivers?.supported, ['fixture-log-ingest', 'adb', 'ios-simctl', 'agent-device', 'argent', 'xcodebuildmcp']);
    fs.writeFileSync(
      path.join(initOutputDir, 'package.json'),
      `${JSON.stringify({
        name: 'initialized-app',
        private: true,
        scripts: initializedScripts,
      }, null, 2)}\n`,
      'utf8',
    );
    assert.deepEqual(Object.keys(initializedScripts).sort(), [
      'asl:agent-device:android',
      'asl:agent-device:check',
      'asl:agent-device:ios',
      'asl:android:live',
      'asl:android:live:agent-device',
      'asl:android:live:argent',
      'asl:android:live:runners',
      'asl:argent:android',
      'asl:argent:check',
      'asl:argent:ios',
      'asl:check:android',
      'asl:check:ios',
      'asl:compare:android',
      'asl:compare:ios',
      'asl:host:doctor',
      'asl:ios:live',
      'asl:ios:live:agent-device',
      'asl:ios:live:argent',
      'asl:ios:live:runners',
      'asl:live-proof',
      'asl:live-proof:android',
      'asl:live-proof:both',
      'asl:live-proof:ios',
      'asl:profile:android',
      'asl:profile:android:live',
      'asl:profile:android:provider',
      'asl:profile:ios',
      'asl:profile:ios:live',
      'asl:profile:ios:provider',
      'asl:validate',
    ]);
    assert.match(initializedScripts['asl:check:ios'], /checkout-submit/u);
    assert.match(initializedScripts['asl:check:ios'], /--provider runner-manifests\/evidence-provider\.json/u);
    assert.match(initializedScripts['asl:check:android'], /--provider runner-manifests\/evidence-provider\.json/u);
    assert.match(initializedScripts['asl:host:doctor'], /^asl-host-doctor --out artifacts\/asl\/host-doctor$/u);
    assert.match(initializedScripts['asl:host:doctor'], /--out artifacts\/asl\/host-doctor/u);
    assert.match(initializedScripts['asl:profile:ios'], /\$\{ASL_PROFILE_IOS_EVENTS:\+--events \$ASL_PROFILE_IOS_EVENTS\}/u);
    assert.match(initializedScripts['asl:profile:ios:provider'], /--provider runner-manifests\/evidence-provider\.json/u);
    assert.match(initializedScripts['asl:profile:ios:provider'], /--comparison-lane checkout-submit-ios-provider/u);
    assert.match(initializedScripts['asl:profile:ios'], /--comparison-lane checkout-submit-ios-fixture/u);
    assert.match(
      initializedScripts['asl:profile:android'],
      /\$\{ASL_PROFILE_ANDROID_EVENTS:\+--events \$ASL_PROFILE_ANDROID_EVENTS\}/u,
    );
    assert.match(initializedScripts['asl:profile:android'], /--comparison-lane checkout-submit-android-fixture/u);
    assert.match(initializedScripts['asl:profile:android:provider'], /--provider runner-manifests\/evidence-provider\.json/u);
    assert.match(initializedScripts['asl:profile:android:provider'], /--comparison-lane checkout-submit-android-provider/u);
    assert.match(initializedScripts['asl:agent-device:ios'], /checkout-submit-ios-agent-device/u);
    assert.match(initializedScripts['asl:agent-device:android'], /checkout-submit-android-agent-device/u);
    assert.match(initializedScripts['asl:agent-device:ios'], /ASL_AGENT_DEVICE_COMMAND_TIMEOUT_MS/u);
    assert.match(initializedScripts['asl:agent-device:android'], /ASL_AGENT_DEVICE_COMMAND_TIMEOUT_MS/u);
    assert.match(initializedScripts['asl:agent-device:check'], /^asl-agent-device --check --out artifacts\/asl\/agent-device-check$/u);
    assert.match(initializedScripts['asl:agent-device:check'], /--out artifacts\/asl\/agent-device-check/u);
    assert.match(initializedScripts['asl:argent:check'], /^asl-argent --check --out artifacts\/asl\/argent-check$/u);
    assert.match(initializedScripts['asl:argent:check'], /--out artifacts\/asl\/argent-check/u);
    assert.match(initializedScripts['asl:argent:ios'], /checkout-submit-ios-argent/u);
    assert.match(initializedScripts['asl:argent:android'], /checkout-submit-android-argent/u);
    assert.match(initializedScripts['asl:argent:ios'], /ASL_ARGENT_BASE_ARGS/u);
    assert.match(initializedScripts['asl:argent:android'], /ASL_ARGENT_BASE_ARGS/u);
    assert.match(initializedScripts['asl:argent:ios'], /ASL_ARGENT_COMMAND_TIMEOUT_MS/u);
    assert.match(initializedScripts['asl:argent:android'], /ASL_ARGENT_COMMAND_TIMEOUT_MS/u);
    assert.match(initializedScripts['asl:argent:ios'], /ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK/u);
    assert.match(initializedScripts['asl:argent:ios'], /ASL_XCRUN_PATH/u);
    assert.match(initializedScripts['asl:ios:live'], /^asl-live-ios /u);
    assert.match(initializedScripts['asl:ios:live'], /--scenario scenarios\/mobile\/checkout-submit\.json/u);
    assert.match(initializedScripts['asl:ios:live'], /--compare-latest --fail-on-regression/u);
    assert.match(initializedScripts['asl:android:live'], /^asl-live-android /u);
    assert.match(initializedScripts['asl:android:live'], /--scenario scenarios\/mobile\/checkout-submit\.json/u);
    assert.match(initializedScripts['asl:android:live'], /--compare-latest --fail-on-regression/u);
    assert.match(initializedScripts['asl:ios:live:agent-device'], /ASL_IOS_AGENT_DEVICE_SESSION:\+--agent-device-session/u);
    assert.match(initializedScripts['asl:ios:live:agent-device'], /ASL_IOS_AGENT_DEVICE_SESSION_MODE:\+--agent-device-session-mode/u);
    assert.match(initializedScripts['asl:ios:live:agent-device'], /--run-suffix agent-device --agent-device-proof/u);
    assert.match(initializedScripts['asl:android:live:agent-device'], /ASL_ANDROID_AGENT_DEVICE_SESSION:\+--agent-device-session/u);
    assert.match(initializedScripts['asl:android:live:agent-device'], /ASL_ANDROID_AGENT_DEVICE_SESSION_MODE:\+--agent-device-session-mode/u);
    assert.match(initializedScripts['asl:android:live:agent-device'], /--run-suffix agent-device --agent-device-proof/u);
    assert.match(initializedScripts['asl:ios:live:argent'], /--run-suffix argent --argent-proof/u);
    assert.match(initializedScripts['asl:android:live:argent'], /--run-suffix argent --argent-proof/u);
    assert.match(initializedScripts['asl:ios:live:runners'], /ASL_IOS_AGENT_DEVICE_SESSION:\+--agent-device-session/u);
    assert.match(initializedScripts['asl:ios:live:runners'], /ASL_IOS_AGENT_DEVICE_SESSION_MODE:\+--agent-device-session-mode/u);
    assert.match(initializedScripts['asl:android:live:runners'], /ASL_ANDROID_AGENT_DEVICE_SESSION:\+--agent-device-session/u);
    assert.match(initializedScripts['asl:android:live:runners'], /ASL_ANDROID_AGENT_DEVICE_SESSION_MODE:\+--agent-device-session-mode/u);
    assert.match(initializedScripts['asl:ios:live:runners'], /--run-suffix runners --agent-device-proof --argent-proof --compare-latest --fail-on-regression/u);
    assert.match(initializedScripts['asl:android:live:runners'], /--run-suffix runners --agent-device-proof --argent-proof --compare-latest --fail-on-regression/u);
    assert.equal(Object.values(initializedScripts).some((script) => String(script).startsWith('asl-example-')), false);
    assert.match(initializedScripts['asl:compare:ios'], /--fail-on-regression/u);
    assert.match(initializedScripts['asl:compare:android'], /--fail-on-regression/u);
    assert.match(initializedScripts['asl:compare:ios'], /\$\{ASL_COMPARE_IOS_CURRENT:\?set_ASL_COMPARE_IOS_CURRENT\}/u);
    assert.match(initializedScripts['asl:compare:android'], /\$\{ASL_COMPARE_ANDROID_CURRENT:\?set_ASL_COMPARE_ANDROID_CURRENT\}/u);
    assert.match(initializedScripts['asl:live-proof:ios'], /artifacts\/asl\/ios-live\/_live-proof\/ios-live-proof\/live-proof\.json/u);
    assert.match(initializedScripts['asl:live-proof:android'], /artifacts\/asl\/android-live\/_live-proof\/android-live-proof\/live-proof\.json/u);
    assert.match(initializedScripts['asl:live-proof:both'], /--require-platforms android,ios --out artifacts\/asl\/live-proof-set --fail-on-regression/u);
    assert.match(initializedScripts['asl:live-proof'], /\$\{ASL_LIVE_PROOF:\?set_ASL_LIVE_PROOF\}/u);
    assert.equal(Object.values(initializedScripts).some((script) => String(script).includes('<run-dir>')), false);
    assert.equal(Object.values(initializedScripts).some((script) => String(script).includes('<live-proof.json>')), false);
    assert.match(initializedScripts['asl:profile:ios:live'], /checkout-submit-ios-live/u);
    assert.match(initializedScripts['asl:profile:ios:live'], /--comparison-lane checkout-submit-ios-live/u);
    assert.match(initializedScripts['asl:profile:android:live'], /checkout-submit-android-live/u);
    assert.match(initializedScripts['asl:profile:android:live'], /--comparison-lane checkout-submit-android-live/u);
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'gitignore-snippet'), 'utf8'),
      /artifacts\/asl\//u,
    );
    assert.match(
      fs.readFileSync(path.join(initOutputDir, 'asl', 'gitignore-snippet'), 'utf8'),
      /\.asl\.local\.env/u,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(initOutputDir, 'runner-manifests', 'evidence-provider.json'), 'utf8')).capabilities,
      ['accessibility', 'memory', 'nativePerformance', 'network', 'profiler'],
    );
    assert.equal(fs.existsSync(path.join(initOutputDir, 'scripts', 'asl-capture-accessibility-provider.mjs')), true);
    assert.equal(fs.existsSync(path.join(initOutputDir, 'scripts', 'asl-capture-profiler-provider.mjs')), true);
    const packedProviderId = 'packed-template-provider';
    const packedProviderRunDir = path.join(initOutputDir, 'artifacts', 'asl', 'packed-provider-run');
    const packedProviderEvidencePath = path.join(
      packedProviderRunDir,
      'raw',
      'providers',
      packedProviderId,
      'native-performance.json',
    );
    fs.mkdirSync(path.join(initOutputDir, 'node_modules'), { recursive: true });
    fs.symlinkSync(packageRoot, path.join(initOutputDir, 'node_modules', 'agent-scenario-loop'), 'dir');
    run(process.execPath, [
      path.join(initOutputDir, 'scripts', 'asl-capture-native-performance-provider.mjs'),
      '--platform',
      'android',
      '--scenario',
      'checkout-submit',
      '--run-id',
      'packed-provider-run',
      '--run-dir',
      packedProviderRunDir,
      '--out',
      packedProviderEvidencePath,
    ], {
      cwd: initOutputDir,
      env,
    });
    assert.equal(JSON.parse(fs.readFileSync(packedProviderEvidencePath, 'utf8')).providerId, packedProviderId);
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
    assert.equal(initializedValidation.scripts.packageJsonStatus, 'present');
    assert.deepEqual(initializedValidation.config.customDrivers, []);
    assert.deepEqual(initializedValidation.config.externalTargetDrivers, ['xcodebuildmcp']);
    assert.deepEqual(initializedValidation.config.packageSupportedDrivers, ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl']);
    assert.deepEqual(initializedValidation.config.supportedDrivers, ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl', 'xcodebuildmcp']);
    assert.deepEqual(initializedValidation.config.missingSupportedDrivers, []);
    assert.equal(
      initializedValidation.nextActions.some((action: { code: string }) => action.code === 'replace_config_placeholders'),
      true,
    );
    assert.equal(
      initializedValidation.nextActions.some((action: { code: string }) => action.code === 'ignore_runtime_artifacts'),
      true,
    );
    assert.equal(initializedValidation.warnings.some((warning: string) => warning.includes('projectName')), true);
    assert.equal(
      initializedValidation.warnings.some((warning: string) => warning.includes('Runtime artifact gitignore')),
      true,
    );

    for (const binaryName of Object.keys(packageJson.bin).sort()) {
      const helpText = run(packageBinPath(installDir, binaryName), ['--help'], {
        cwd: installDir,
        env,
      });
      assert.match(helpText, /Usage:/u, `${binaryName} did not print usage`);
      if (binaryName === 'asl-android-adb' || binaryName === 'asl-profile-android') {
        assert.match(helpText, /--launch-wait-ms <ms>/u, `${binaryName} did not expose Android launch wait help`);
      }
    }

    const fakeArgentPath = path.join(
      tempRoot,
      process.platform === 'win32' ? 'fake-argent.cmd' : 'fake-argent',
    );
    const argentRunRoot = path.join(tempRoot, 'argent-run');
    writeFakeArgent(fakeArgentPath);
    const argentRunOutput = run(packageBinPath(installDir, 'asl-argent'), [
      '--argent',
      fakeArgentPath,
      '--platform',
      'ios',
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'mobile', 'app-startup.json'),
      '--app',
      'dev.agent-scenario-loop.example',
      '--device',
      'SIM-123',
      '--out',
      argentRunRoot,
      '--run-id',
      'package-smoke-argent',
    ], {
      cwd: installDir,
      env,
    });
    const argentRunDir = argentRunOutput.trim();
    assert.equal(argentRunDir, argentRunRoot);
    assert.equal(JSON.parse(fs.readFileSync(path.join(argentRunDir, 'health.json'), 'utf8')).healthStatus, 'passed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(argentRunDir, 'verdict.json'), 'utf8')).verdictStatus, 'not_evaluated');
    assert.equal(fs.existsSync(path.join(argentRunDir, 'raw', 'argent-metadata.json')), true);
    assert.equal(fs.existsSync(path.join(argentRunDir, 'captures', 'fake-argent-screenshot.png')), true);

    for (const exampleRun of EXAMPLE_PROFILE_RUNS) {
      const output = run(packageBinPath(installDir, exampleRun.binaryName), [
        '--config',
        path.join(exampleAppRoot, 'asl.config.json'),
        '--scenario',
        path.join(exampleAppRoot, 'scenarios', 'mobile', exampleRun.scenario),
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
      `network@redacted:${path.join(providerEvidenceRoot, 'network-capture.har')}`,
      '--capture',
      `uiTree@not-redacted:${path.join(providerEvidenceRoot, 'ui-tree.json')}`,
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
        completenessStatus: 'complete',
        corruptionStatus: 'valid',
        kind: 'js',
        path: 'signals/js/js-profile.json',
        redactionPolicy: {
          authority: 'asl-default',
          reason: 'ASL copied the artifact but did not inspect it for secrets, PII, tokens, or other sensitive content.',
          sensitivity: 'may-contain-sensitive-data',
          status: 'unknown',
        },
        redactionStatus: 'unknown',
        sha256: sha256File(providerJsSignal),
        sizeBytes: fs.statSync(providerJsSignal).size,
        sourceFileName: 'js-profile.json',
        transformations: ['copied'],
      },
      {
        channel: 'signal',
        completenessStatus: 'complete',
        corruptionStatus: 'valid',
        kind: 'network',
        path: 'signals/network/network-capture.har',
        redactionPolicy: {
          authority: 'operator-declared',
          reason: 'The artifact producer declared that sensitive content was redacted before ASL copied it.',
          sensitivity: 'declared-non-sensitive',
          status: 'redacted',
        },
        redactionStatus: 'redacted',
        sha256: sha256File(providerNetworkSignal),
        sizeBytes: fs.statSync(providerNetworkSignal).size,
        sourceFileName: 'network-capture.har',
        transformations: ['copied'],
      },
      {
        channel: 'capture',
        completenessStatus: 'complete',
        corruptionStatus: 'valid',
        kind: 'uiTree',
        path: 'captures/ui-tree.json',
        redactionPolicy: {
          authority: 'operator-declared',
          reason: 'The artifact producer declared that the copied artifact was not redacted.',
          sensitivity: 'may-contain-sensitive-data',
          status: 'not-redacted',
        },
        redactionStatus: 'not-redacted',
        sha256: sha256File(providerUiTree),
        sizeBytes: fs.statSync(providerUiTree).size,
        sourceFileName: 'ui-tree.json',
        transformations: ['copied'],
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
              redactionStatus: 'redacted',
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
        completenessStatus: 'complete',
        corruptionStatus: 'valid',
        kind: 'accessibility',
        path: 'raw/providers/smoke-accessibility-provider/accessibility.json',
        redactionPolicy: {
          authority: 'provider-declared',
          reason: 'The artifact producer declared that sensitive content was redacted before ASL copied it.',
          sensitivity: 'declared-non-sensitive',
          status: 'redacted',
        },
        redactionStatus: 'redacted',
        sha256: sha256File(providerCommandOutput),
        sizeBytes: fs.statSync(providerCommandOutput).size,
        sourceFileName: 'accessibility.json',
        transformations: ['copied'],
      },
    ]);

    const unsupportedProviderRoot = path.join(tempRoot, 'provider-command-unsupported-platform');
    const unsupportedProviderProfileRoot = path.join(tempRoot, 'provider-command-unsupported-platform-profile');
    fs.mkdirSync(unsupportedProviderRoot, { recursive: true });
    const unsupportedProviderMarkerPath = path.join(unsupportedProviderRoot, 'provider-ran.txt');
    const unsupportedProviderManifestPath = path.join(unsupportedProviderRoot, 'provider.json');
    fs.writeFileSync(unsupportedProviderManifestPath, `${JSON.stringify({
      schemaVersion: '1.0.0',
      runnerId: 'smoke-ios-only-provider',
      kind: 'evidenceProvider',
      platforms: ['ios'],
      capabilities: ['accessibility'],
      artifactOutputs: ['accessibility'],
      lifecycle: ['capture'],
      providerCommands: [
        {
          id: 'capture-accessibility',
          phase: 'capture',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(unsupportedProviderMarkerPath)}, 'ran\\n')`],
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
    const unsupportedProviderProfileOutput = run(packageBinPath(installDir, 'asl-profile-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'android', 'app-startup.json'),
      '--events',
      path.join(exampleAppRoot, 'event-logs', 'android-app-startup.log'),
      '--provider',
      unsupportedProviderManifestPath,
      '--out',
      unsupportedProviderProfileRoot,
      '--run-id',
      'android-provider-unsupported-platform',
    ], {
      cwd: installDir,
      env,
    });
    const unsupportedProviderRunDir = unsupportedProviderProfileOutput.trim();
    const unsupportedProviderHealth = JSON.parse(fs.readFileSync(path.join(unsupportedProviderRunDir, 'health.json'), 'utf8'));
    const unsupportedProviderManifest = JSON.parse(fs.readFileSync(path.join(unsupportedProviderRunDir, 'manifest.json'), 'utf8'));
    const unsupportedProviderSummary = fs.readFileSync(path.join(unsupportedProviderRunDir, 'agent-summary.md'), 'utf8');
    const unsupportedProviderAccessibility = unsupportedProviderManifest.artifacts.diagnostics.find(
      (diagnostic: { kind?: string }) => diagnostic.kind === 'accessibility',
    ) as { availability?: string; provider?: string; status?: string } | undefined;
    if (!unsupportedProviderAccessibility) {
      throw new Error('unsupported provider profile should inventory the declared accessibility diagnostic');
    }
    assert.equal(fs.existsSync(unsupportedProviderMarkerPath), false);
    assert.equal(unsupportedProviderHealth.healthStatus, 'failed');
    assert.equal(unsupportedProviderAccessibility.status, 'not_supported');
    assert.equal(unsupportedProviderAccessibility.availability, 'unsupported');
    assert.equal(unsupportedProviderAccessibility.provider, 'smoke-ios-only-provider');
    assert.equal(
      unsupportedProviderHealth.checks.some((check: { code: string; metadata?: { nextActionCode?: string; providerId?: string } }) =>
        check.code === 'provider_platform_unsupported' &&
        check.metadata?.nextActionCode === 'select_supported_provider_platform' &&
        check.metadata?.providerId === 'smoke-ios-only-provider'
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(unsupportedProviderRunDir, 'raw', 'provider-commands', 'smoke-ios-only-provider-capture-accessibility.json')),
      false,
    );
    assert.match(unsupportedProviderSummary, /Next action `select_supported_provider_platform`/u);

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
    assert.equal(adbArtifactHealth.healthStatus, 'failed');
    assert.equal(
      adbArtifactHealth.checks.some((check: { code: string; status: string }) =>
        check.code === 'runtime_identity_unverified' && check.status === 'failed'
      ),
      true,
    );
    assert.equal(adbArtifactVerdict.verdictStatus, 'inconclusive');

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
    assert.equal(fs.existsSync(path.join(adbCaptureRoot, 'raw', 'adb-app-pidof-after-launch.txt')), true);
    assert.equal(fs.existsSync(path.join(adbCaptureRoot, 'raw', 'adb-app-pidof-after-capture.txt')), true);
    assert.equal(fs.existsSync(path.join(adbCaptureRoot, 'raw', 'adb-app-lifecycle-log.txt')), true);

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
    const genericAndroidLiveRoot = path.join(tempRoot, 'generic-android-live-proof');
    const genericAndroidLiveOutput = run(packageBinPath(installDir, 'asl-live-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'mobile', 'app-startup.json'),
      '--adb',
      fakeExampleLiveAdbPath,
      '--package',
      androidPackageName,
      '--out',
      genericAndroidLiveRoot,
      '--wait-ms',
      '1',
      '--command-wait-ms',
      '1',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-android',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
    });
    assert.match(genericAndroidLiveOutput, /_live-proof\/android-live-proof\/agent-summary\.md/u);
    assert.equal(
      fs.existsSync(path.join(genericAndroidLiveRoot, '_live-proof', 'android-live-proof', 'live-proof.json')),
      true,
    );
    const genericAndroidLiveCompareOutput = run(packageBinPath(installDir, 'asl-live-android'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'mobile', 'app-startup.json'),
      '--adb',
      fakeExampleLiveAdbPath,
      '--package',
      androidPackageName,
      '--out',
      genericAndroidLiveRoot,
      '--wait-ms',
      '1',
      '--command-wait-ms',
      '1',
      '--run-suffix',
      'smoke',
      '--compare-latest',
      '--fail-on-regression',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-android',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
    });
    assert.match(genericAndroidLiveCompareOutput, /_live-proof\/android-live-proof-smoke\/agent-summary\.md/u);
    const genericAndroidProofOutput = run(packageBinPath(installDir, 'asl-live-proof'), [
      '--file',
      path.join(genericAndroidLiveRoot, '_live-proof', 'android-live-proof-smoke', 'live-proof.json'),
      '--fail-on-regression',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(genericAndroidProofOutput, /Comparison status: unchanged/u);
    assert.match(genericAndroidProofOutput, /app-startup \(app-startup\/app-startup-android-live-smoke\): unchanged/u);
    assert.match(genericAndroidProofOutput, /interaction-agent-device \(agent-device\/app-startup\/app-startup-android-agent-device-smoke\): health=passed verdict=not_evaluated/u);
    assert.match(genericAndroidProofOutput, /interaction-argent \(argent\/app-startup\/app-startup-android-argent-smoke\): health=passed verdict=not_evaluated/u);

    const exampleLiveOutput = run(packageBinPath(installDir, 'asl-example-android-live'), [
      '--adb',
      fakeExampleLiveAdbPath,
      '--out',
      exampleLiveRoot,
      '--wait-ms',
      '1',
      '--command-wait-ms',
      '1',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-android',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
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
      '--fail-on-regression',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-android',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
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
    assert.match(exampleLiveProofOutput, /Preflight: android-live-preflight-smoke health=passed verdict=not_evaluated/u);
    assert.match(exampleLiveProofOutput, /Comparison counts: better=0 worse=0 unchanged=3 mixed=0 inconclusive=0 low_confidence=0 skipped=0/u);
    assert.match(
      exampleLiveProofOutput,
      /startup \(app-startup\/android-live-startup-smoke\): unchanged native=not-comparable \(metrics better=0 worse=0 unchanged=1 inconclusive=0 low_confidence=0\)/u,
    );
    assert.match(exampleLiveProofOutput, /startup \(app-startup\/android-live-startup-smoke\): health=passed verdict=passed/u);
    assert.match(exampleLiveProofOutput, /startup-ui \(agent-device\/app-startup\/android-agent-device-startup-smoke\): health=passed verdict=not_evaluated/u);
    assert.match(exampleLiveProofOutput, /startup-ui-argent \(argent\/app-startup\/android-argent-startup-smoke\): health=passed verdict=not_evaluated/u);
    assert.match(exampleLiveProofOutput, /Next action: product_optimization\/inspect_summary/u);
    const exampleLiveProof = JSON.parse(
      fs.readFileSync(path.join(exampleLiveRoot, '_live-proof', 'android-live-proof-smoke', 'live-proof.json'), 'utf8'),
    );
    assert.deepEqual(
      {
        healthStatus: exampleLiveProof.preflight.healthStatus,
        verdictStatus: exampleLiveProof.preflight.verdictStatus,
      },
      { healthStatus: 'passed', verdictStatus: 'not_evaluated' },
    );
    assert.deepEqual(
      exampleLiveProof.interactionProofs.map((proof: { healthStatus: string; runnerId: string }) => ({
        healthStatus: proof.healthStatus,
        runnerId: proof.runnerId,
      })),
      [
        { healthStatus: 'passed', runnerId: 'agent-device' },
        { healthStatus: 'passed', runnerId: 'argent' },
      ],
    );
    assert.deepEqual(
      exampleLiveProof.comparisons.map((comparison: { metricSummary?: { counts?: { unchanged?: number }; notableMetrics?: unknown[] } }) => ({
        notableMetrics: comparison.metricSummary?.notableMetrics?.length ?? 0,
        unchanged: comparison.metricSummary?.counts?.unchanged,
      })),
      [
        { notableMetrics: 0, unchanged: 1 },
        { notableMetrics: 0, unchanged: 3 },
        { notableMetrics: 0, unchanged: 3 },
      ],
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
    ] as const) {
      const baselineRunId = runId.replace(/-smoke$/u, '');
      const comparisonDir = path.join(exampleLiveRoot, 'comparisons', scenarioDir, runId);
      const comparisonPath = path.join(comparisonDir, 'comparison.json');
      const comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8'));
      assertLatestTrustedComparisonBasis({
        artifactRoot: exampleLiveRoot,
        baselineRunDir: path.join(exampleLiveRoot, scenarioDir, baselineRunId),
        baselineRunId,
        comparison,
        currentRunDir: path.join(exampleLiveRoot, scenarioDir, runId),
        currentRunId: runId,
      });
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
    const genericIosLiveRoot = path.join(tempRoot, 'generic-ios-live-proof');
    const genericIosLiveOutput = run(packageBinPath(installDir, 'asl-live-ios'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'mobile', 'app-startup.json'),
      '--xcrun',
      fakeExampleLiveXcrunPath,
      '--device',
      iosDeviceId,
      '--bundle',
      iosBundleId,
      '--out',
      genericIosLiveRoot,
      '--wait-ms',
      '1',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-ios',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
    });
    assert.match(genericIosLiveOutput, /_live-proof\/ios-live-proof\/agent-summary\.md/u);
    assert.equal(
      fs.existsSync(path.join(genericIosLiveRoot, '_live-proof', 'ios-live-proof', 'live-proof.json')),
      true,
    );
    const genericIosLiveCompareOutput = run(packageBinPath(installDir, 'asl-live-ios'), [
      '--config',
      path.join(exampleAppRoot, 'asl.config.json'),
      '--scenario',
      path.join(exampleAppRoot, 'scenarios', 'mobile', 'app-startup.json'),
      '--xcrun',
      fakeExampleLiveXcrunPath,
      '--device',
      iosDeviceId,
      '--bundle',
      iosBundleId,
      '--out',
      genericIosLiveRoot,
      '--wait-ms',
      '1',
      '--run-suffix',
      'smoke',
      '--compare-latest',
      '--fail-on-regression',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-ios',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
    });
    assert.match(genericIosLiveCompareOutput, /_live-proof\/ios-live-proof-smoke\/agent-summary\.md/u);
    const genericIosProofOutput = run(packageBinPath(installDir, 'asl-live-proof'), [
      '--file',
      path.join(genericIosLiveRoot, '_live-proof', 'ios-live-proof-smoke', 'live-proof.json'),
      '--fail-on-regression',
    ], {
      cwd: installDir,
      env,
    });
    assert.match(genericIosProofOutput, /Comparison status: unchanged/u);
    assert.match(genericIosProofOutput, /app-startup \(app-startup\/app-startup-ios-live-smoke\): unchanged/u);
    assert.match(genericIosProofOutput, /interaction-agent-device \(agent-device\/app-startup\/app-startup-ios-agent-device-smoke\): health=passed verdict=not_evaluated/u);
    assert.match(genericIosProofOutput, /interaction-argent \(argent\/app-startup\/app-startup-ios-argent-smoke\): health=passed verdict=not_evaluated/u);

    const exampleIosLiveOutput = run(packageBinPath(installDir, 'asl-example-ios-live'), [
      '--xcrun',
      fakeExampleLiveXcrunPath,
      '--device',
      iosDeviceId,
      '--out',
      exampleIosLiveRoot,
      '--wait-ms',
      '1',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-ios',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
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
      '--fail-on-regression',
      '--agent-device-proof',
      '--agent-device',
      fakeAgentDevicePath,
      '--agent-device-session',
      'package-smoke-ios',
      '--agent-device-session-mode',
      'bind',
      '--argent-proof',
    ], {
      cwd: installDir,
      env: {
        ...env,
        ASL_ARGENT_BIN: fakeArgentPath,
      },
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
    assert.match(exampleIosLiveProofOutput, /Preflight: ios-live-preflight-smoke health=passed verdict=not_evaluated/u);
    assert.match(
      exampleIosLiveProofOutput,
      /startup \(app-startup\/ios-live-startup-smoke\): unchanged native=not-comparable \(metrics better=0 worse=0 unchanged=1 inconclusive=0 low_confidence=0\)/u,
    );
    assert.match(exampleIosLiveProofOutput, /startup-ui \(agent-device\/app-startup\/ios-agent-device-startup-smoke\): health=passed verdict=not_evaluated/u);
    assert.match(exampleIosLiveProofOutput, /startup-ui-argent \(argent\/app-startup\/ios-argent-startup-smoke\): health=passed verdict=not_evaluated/u);
    const exampleIosLiveProof = JSON.parse(
      fs.readFileSync(path.join(exampleIosLiveRoot, '_live-proof', 'ios-live-proof-smoke', 'live-proof.json'), 'utf8'),
    );
    assert.deepEqual(
      {
        healthStatus: exampleIosLiveProof.preflight.healthStatus,
        verdictStatus: exampleIosLiveProof.preflight.verdictStatus,
      },
      { healthStatus: 'passed', verdictStatus: 'not_evaluated' },
    );
    assert.deepEqual(
      exampleIosLiveProof.interactionProofs.map((proof: { healthStatus: string; runnerId: string }) => ({
        healthStatus: proof.healthStatus,
        runnerId: proof.runnerId,
      })),
      [
        { healthStatus: 'passed', runnerId: 'agent-device' },
        { healthStatus: 'passed', runnerId: 'argent' },
      ],
    );
    assert.deepEqual(
      exampleIosLiveProof.comparisons.map((comparison: { metricSummary?: { counts?: { unchanged?: number }; notableMetrics?: unknown[] } }) => ({
        notableMetrics: comparison.metricSummary?.notableMetrics?.length ?? 0,
        unchanged: comparison.metricSummary?.counts?.unchanged,
      })),
      [
        { notableMetrics: 0, unchanged: 1 },
        { notableMetrics: 0, unchanged: 3 },
        { notableMetrics: 0, unchanged: 3 },
      ],
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
    ] as const) {
      const baselineRunId = runId.replace(/-smoke$/u, '');
      const comparisonDir = path.join(exampleIosLiveRoot, 'comparisons', scenarioDir, runId);
      const comparisonPath = path.join(comparisonDir, 'comparison.json');
      const comparison = JSON.parse(fs.readFileSync(comparisonPath, 'utf8'));
      assertLatestTrustedComparisonBasis({
        artifactRoot: exampleIosLiveRoot,
        baselineRunDir: path.join(exampleIosLiveRoot, scenarioDir, baselineRunId),
        baselineRunId,
        comparison,
        currentRunDir: path.join(exampleIosLiveRoot, scenarioDir, runId),
        currentRunId: runId,
      });
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
      '--fail-on-regression',
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
    assert.equal(latestComparison.comparisonStatus, 'low_confidence');
    assertLatestTrustedComparisonBasis({
      artifactRoot: latestCompareRoot,
      baselineRunDir: path.join(latestCompareRoot, 'app-startup', 'baseline-run'),
      baselineRunId: 'baseline-run',
      comparison: latestComparison,
      currentRunDir: latestCompareCurrentDir,
      currentRunId: 'current-run',
    });
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
      "function documentedRunnerSubpaths() {",
      "  const apiDocs = fs.readFileSync(path.join(packageRoot, 'docs/api.md'), 'utf8');",
      "  return Array.from(new Set(Array.from(apiDocs.matchAll(/`(agent-scenario-loop\\/runner\\/[^`]+)`/gu), (match) => match[1]))).sort();",
      "}",
      "function exportedRunnerSubpaths() {",
      "  return Object.keys(packageJson.exports).filter((name) => name.startsWith('./runner/')).map((name) => `agent-scenario-loop/${name.slice(2)}`).sort();",
      "}",
      "for (const subpath of Object.keys(packageJson.exports).filter((name) => !name.includes('*'))) {",
      "  const specifier = subpath === '.' ? 'agent-scenario-loop' : `agent-scenario-loop/${subpath.slice(2)}`;",
      "  require.resolve(specifier);",
      "}",
      "assert.deepEqual(documentedRunnerSubpaths(), exportedRunnerSubpaths(), 'installed docs/api.md runner subpaths must match package exports');",
      "assert.equal(asl.ARTIFACT_LAYOUT_VERSION, '1.0.0');",
      "assert.equal(asl.ARTIFACT_FILENAMES.health, 'health.json');",
      "assert.deepEqual(asl.ARTIFACT_FILENAMES, { agentSummary: 'agent-summary.md', ciEvidencePack: 'ci-evidence-pack.json', comparison: 'comparison.json', health: 'health.json', liveProof: 'live-proof.json', liveProofSet: 'live-proof-set.json', plannerCompatibility: 'planner-compatibility.json', projectValidation: 'project-validation.json', runPlan: 'run-plan.json', verdict: 'verdict.json' });",
      "assert.equal(asl.PROFILE_ARTIFACT_FILENAMES.metrics, 'metrics.json');",
      "assert.deepEqual(asl.PROFILE_ARTIFACT_FILENAMES, { budgetVerdict: 'budget-verdict.json', causalRun: 'causal-run.json', manifest: 'manifest.json', metrics: 'metrics.json', summary: 'summary.md' });",
      "assert.equal(typeof asl.createArtifactLayout, 'function');",
      "const layout = asl.createArtifactLayout({ outputDir: 'run' });",
      "assert.equal(layout.health, 'run/health.json');",
      "assert.equal(layout.verdict, 'run/verdict.json');",
      "assert.equal(layout.comparison, 'run/comparison.json');",
      "assert.equal(layout.agentSummary, 'run/agent-summary.md');",
      "assert.equal(layout.liveProof, 'run/live-proof.json');",
      "assert.equal(layout.liveProofSet, 'run/live-proof-set.json');",
      "assert.equal(layout.ciEvidencePack, 'run/ci-evidence-pack.json');",
      "assert.equal(layout.plannerCompatibility, 'run/planner-compatibility.json');",
      "assert.equal(layout.projectValidation, 'run/project-validation.json');",
      "assert.equal(layout.runPlan, 'run/run-plan.json');",
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
      "assert.equal(asl.CLAIM_CONTRACT_SCHEMA_VERSION, '1.1.0');",
      "assert.equal(asl.LEGACY_SCENARIO_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(typeof asl.buildScenarioClaimHash, 'function');",
      "assert.equal(typeof asl.buildScenarioClaimCompleteContractHash, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimAdmission, 'function');",
      "assert.equal(asl.CLAIM_ADMISSION_INSPECTION_VERSION, '1.0.0');",
      "assert.equal(typeof asl.buildScenarioClaimEvidenceRunIdentityHash, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimEvidenceCandidateIdentity, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimRawObservationAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceReportIdentity, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceAdmission, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimValidatedEvidenceResultAdmission, 'function');",
      "assert.equal(asl.CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_RAW_OBSERVATION_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_RAW_OBSERVATION_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_EVIDENCE_RUN_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(asl.CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION, '1.0.0');",
      "assert.equal(typeof asl.InvalidScenarioClaimEvidenceRunIdentityError, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimApproval, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimAuthorization, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimClosure, 'function');",
      "assert.equal(typeof asl.buildClaimCompleteVerdict, 'function');",
      "assert.equal(typeof asl.inspectScenarioClaimDependencies, 'function');",
      "assert.equal(asl.inspectScenarioClaimClosure({ schemaVersion: '1.0.0' }, { platform: 'ios' }).claimClosure, 'outside_contract');",
      "const claimCompleteScenario = readJson('examples/scenarios/mobile/app-startup.json');",
      "claimCompleteScenario.schemaVersion = '1.1.0';",
      "claimCompleteScenario.journey = { name: 'Start app', intent: 'Reach a usable app surface.', actor: 'user', startState: 'app stopped', endState: 'app usable', phases: [{ id: 'launch', description: 'Launch app.', coverageKind: 'product' }], terminalInvariants: [{ id: 'usable', description: 'App remains usable.', coverageKind: 'product' }], recovery: { status: 'not_required', rationale: 'No interruption is authored.' } };",
      "claimCompleteScenario.claims = [{ id: 'app-usable', role: 'mandatory', applicability: { platforms: ['ios', 'android'] }, closes: { phases: ['launch'], terminalInvariants: ['usable'] }, assertions: [{ id: 'usable-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } }] }];",
      "claimCompleteScenario.safety = { class: 'read_only', rationale: 'The scenario observes product behavior without mutation.', allowedOperations: ['observe'] };",
      "claimCompleteScenario.dependencies = [{ id: 'app-entry-ready', kind: 'journey_entry', applicability: { platforms: ['ios', 'android'] }, predicate: { id: 'entry-ready-event', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', requiredStrength: 'observed', completeness: 'point' } } }];",
      "const claimCompleteVerdictResult = {",
      "  claimId: 'app-usable',",
      "  claimHash: asl.buildScenarioClaimHash(claimCompleteScenario.claims[0]),",
      "  role: 'mandatory',",
      "  status: 'supported',",
      "  reasonCode: 'all_assertions_supported',",
      "  assertionResults: [{ assertionId: 'usable-event', assertionKind: 'eventOccurrence', status: 'supported', reasonCode: 'all_assertions_supported', expected: { event: 'app_first_usable_screen' }, observed: { event: 'app_first_usable_screen', matchedEvidence: 'profile-event-1' }, evidenceReferences: [{ path: 'raw/profile-events.json' }], rejectedEvidence: [], missingProof: [] }],",
      "  evidenceReferences: [{ path: 'raw/profile-events.json' }],",
      "  missingProof: [],",
      "  nextActionOwner: 'product_optimization',",
      "  nextAction: 'Retain the evidence.'",
      "};",
      "const claimCompleteVerdict = asl.buildClaimCompleteVerdict({",
      "  scenario: claimCompleteScenario,",
      "  selection: { platform: 'ios', applicableClaimIds: ['app-usable'], excludedClaimIds: [] },",
      "  healthStatus: 'passed',",
      "  runId: 'package-smoke-claim-complete-run',",
      "  claimResults: [claimCompleteVerdictResult]",
      "});",
      "assert.equal(claimCompleteVerdict.schemaVersion, '1.1.0');",
      "assert.equal(claimCompleteVerdict.verdictStatus, 'passed');",
      "assert.equal(claimCompleteVerdict.healthStatus, 'passed');",
      "assert.equal(claimCompleteVerdict.scenarioId, claimCompleteScenario.id);",
      "assert.equal(claimCompleteVerdict.runId, 'package-smoke-claim-complete-run');",
      "assert.equal(claimCompleteVerdict.claimResults.length, 1);",
      "assert.deepEqual(claimCompleteVerdict.claimResults[0], claimCompleteVerdictResult);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0], claimCompleteVerdictResult);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0].assertionResults, claimCompleteVerdictResult.assertionResults);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0].assertionResults[0], claimCompleteVerdictResult.assertionResults[0]);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0].assertionResults[0].evidenceReferences, claimCompleteVerdictResult.assertionResults[0].evidenceReferences);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0].assertionResults[0].evidenceReferences[0], claimCompleteVerdictResult.assertionResults[0].evidenceReferences[0]);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0].evidenceReferences, claimCompleteVerdictResult.evidenceReferences);",
      "assert.notEqual(claimCompleteVerdict.claimResults[0].evidenceReferences[0], claimCompleteVerdictResult.evidenceReferences[0]);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict), true);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict.claimResults), true);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict.claimResults[0]), true);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict.claimResults[0].assertionResults), true);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict.claimResults[0].assertionResults[0]), true);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict.claimResults[0].assertionResults[0].evidenceReferences), true);",
      "assert.equal(Object.isFrozen(claimCompleteVerdict.claimResults[0].assertionResults[0].evidenceReferences[0]), true);",
      "assert.equal(asl.validateJson(claimCompleteVerdict, asl.SCHEMAS.verdict, 'claim-complete verdict').valid, true);",
      "const claimCompleteFailedHealthVerdict = asl.buildClaimCompleteVerdict({",
      "  scenario: claimCompleteScenario,",
      "  selection: { platform: 'ios', applicableClaimIds: ['app-usable'], excludedClaimIds: [] },",
      "  healthStatus: 'failed',",
      "  runId: 'package-smoke-claim-complete-failed-health-run',",
      "  claimResults: [claimCompleteVerdictResult]",
      "});",
      "assert.equal(claimCompleteFailedHealthVerdict.schemaVersion, '1.1.0');",
      "assert.equal(claimCompleteFailedHealthVerdict.verdictStatus, 'inconclusive');",
      "assert.equal(claimCompleteFailedHealthVerdict.healthStatus, 'failed');",
      "assert.equal(claimCompleteFailedHealthVerdict.claimResults.length, 1);",
      "assert.equal(claimCompleteFailedHealthVerdict.claimResults[0].status, 'not_evaluable');",
      "assert.equal(claimCompleteFailedHealthVerdict.claimResults[0].reasonCode, 'health_gate_failed');",
      "assert.equal(claimCompleteFailedHealthVerdict.claimResults[0].assertionResults.length, 1);",
      "assert.equal(claimCompleteFailedHealthVerdict.claimResults[0].assertionResults[0].status, 'not_evaluable');",
      "assert.equal(claimCompleteFailedHealthVerdict.claimResults[0].assertionResults[0].reasonCode, 'health_gate_failed');",
      "assert.equal(asl.validateJson(claimCompleteFailedHealthVerdict, asl.SCHEMAS.verdict, 'claim-complete failed-health verdict').valid, true);",
      "const claimCompletePartialHealthVerdict = asl.buildClaimCompleteVerdict({",
      "  scenario: claimCompleteScenario,",
      "  selection: { platform: 'ios', applicableClaimIds: ['app-usable'], excludedClaimIds: [] },",
      "  healthStatus: 'partial',",
      "  runId: 'package-smoke-claim-complete-partial-health-run',",
      "  claimResults: [claimCompleteVerdictResult]",
      "});",
      "assert.equal(claimCompletePartialHealthVerdict.schemaVersion, '1.1.0');",
      "assert.equal(claimCompletePartialHealthVerdict.verdictStatus, 'inconclusive');",
      "assert.equal(claimCompletePartialHealthVerdict.healthStatus, 'partial');",
      "assert.equal(claimCompletePartialHealthVerdict.claimResults.length, 1);",
      "assert.equal(claimCompletePartialHealthVerdict.claimResults[0].status, 'not_evaluable');",
      "assert.equal(claimCompletePartialHealthVerdict.claimResults[0].reasonCode, 'health_gate_failed');",
      "assert.equal(claimCompletePartialHealthVerdict.claimResults[0].assertionResults.length, 1);",
      "assert.equal(claimCompletePartialHealthVerdict.claimResults[0].assertionResults[0].status, 'not_evaluable');",
      "assert.equal(claimCompletePartialHealthVerdict.claimResults[0].assertionResults[0].reasonCode, 'health_gate_failed');",
      "assert.equal(asl.validateJson(claimCompletePartialHealthVerdict, asl.SCHEMAS.verdict, 'claim-complete partial-health verdict').valid, true);",
      "assert.throws(() => asl.buildClaimCompleteVerdict({",
      "  scenario: { schemaVersion: '1.0.0' },",
      "  selection: { platform: 'ios', applicableClaimIds: ['app-usable'], excludedClaimIds: [] },",
      "  healthStatus: 'passed',",
      "  runId: 'package-smoke-claim-complete-run',",
      "  claimResults: [claimCompleteVerdictResult]",
      "}));",
      "const claimCompleteScenarioHash = asl.buildScenarioClaimCompleteContractHash(claimCompleteScenario);",
      "const scenarioApproval = { schemaVersion: '1.0.0', approvalId: 'package-smoke-approval', scenarioId: claimCompleteScenario.id, scenarioHash: claimCompleteScenarioHash, selection: { platform: 'ios' }, decision: 'approved', approvedAt: '2026-08-21T12:00:00Z', approverRef: 'package-smoke-review' };",
      "assert.equal(asl.validateJson(scenarioApproval, asl.SCHEMAS.scenarioClaimApproval, 'scenario approval').valid, true);",
      "assert.equal(asl.inspectScenarioClaimApproval(claimCompleteScenario, { platform: 'ios' }, scenarioApproval).approvalBinding, 'bound');",
      "assert.equal(asl.inspectScenarioClaimApproval(claimCompleteScenario, { platform: 'android' }, scenarioApproval).approvalBinding, 'invalidated');",
      "assert.equal(asl.inspectScenarioClaimApproval({ schemaVersion: '1.0.0' }, { platform: 'ios' }, scenarioApproval).approvalBinding, 'outside_contract');",
      "assert.equal(asl.inspectScenarioClaimApproval(claimCompleteScenario, { platform: 'ios' }, { ...scenarioApproval, expiresAt: '2026-08-22T12:00:00Z' }).approvalBinding, 'outside_contract');",
      "const scenarioAuthorization = { schemaVersion: '1.0.0', grantId: 'package-smoke-grant', scenarioId: claimCompleteScenario.id, scenarioHash: claimCompleteScenarioHash, selection: { platform: 'ios' }, safetyClass: 'read_only', goalId: 'package-smoke-goal', operations: ['observe'], targetResource: 'mobile-target:ios:package-smoke', expiresAt: '2026-08-21T12:00:01.000Z', delegationChain: ['local-owner'] };",
      "const scenarioAuthorizationRequest = { goalId: 'package-smoke-goal', operations: ['observe'], targetResource: 'mobile-target:ios:package-smoke', nowMs: Date.parse('2026-08-21T12:00:00.000Z') };",
      "assert.equal(asl.validateJson(scenarioAuthorization, asl.SCHEMAS.scenarioClaimAuthorizationGrant, 'scenario authorization').valid, true);",
      "assert.equal(asl.inspectScenarioClaimAuthorization(claimCompleteScenario, { platform: 'ios' }, scenarioAuthorizationRequest, scenarioAuthorization).authorizationCompatibility, 'compatible');",
      "assert.equal(asl.inspectScenarioClaimAuthorization(claimCompleteScenario, { platform: 'ios' }, { ...scenarioAuthorizationRequest, operations: ['observe', 'delete'] }, scenarioAuthorization).authorizationCompatibility, 'incompatible');",
      "assert.equal(asl.inspectScenarioClaimAuthorization(claimCompleteScenario, { platform: 'ios' }, scenarioAuthorizationRequest, { ...scenarioAuthorization, accessToken: 'private' }).authorizationCompatibility, 'outside_contract');",
      "assert.equal(asl.inspectScenarioClaimClosure(claimCompleteScenario, { platform: 'ios' }).claimClosure, 'closed');",
      "assert.deepEqual(asl.inspectScenarioClaimDependencies(claimCompleteScenario, { platform: 'ios' }).applicableDependencyIds, ['app-entry-ready']);",
      "assert.equal(asl.inspectScenarioClaimSafety(claimCompleteScenario, { platform: 'ios' }).safetyContract, 'complete');",
      "const claimAdmissionAuthority = { schemaVersion: '1.0.0', declarationId: 'package-smoke-app-authority', role: 'app', producerId: 'app', platforms: ['ios'], assertionKinds: ['eventOccurrence'], evidenceSelectors: ['events.app_first_usable_screen'], maxStrength: 'verified', maxCompleteness: 'continuous-complete' };",
      "const claimAdmission = asl.inspectScenarioClaimAdmission({ scenario: claimCompleteScenario, selection: { platform: 'ios' }, authorityCatalog: [claimAdmissionAuthority], authorizationRequest: scenarioAuthorizationRequest, authorizationGrant: scenarioAuthorization, approval: scenarioApproval });",
      "assert.equal(claimAdmission.status, 'admitted');",
      "assert.deepEqual(claimAdmission.gateSummaries.map((gate) => [gate.gate, gate.status]), [['closure', 'closed'], ['authority', 'compatible'], ['safety', 'complete'], ['authorization', 'compatible'], ['approval', 'bound'], ['dependencies', 'complete']]);",
      "assert.deepEqual(claimAdmission.blockingGates, []);",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimAdmission, 'firstBlockingGate'), false);",
      "const claimEvidenceRunIdentity = { schemaVersion: '1.0.0', scenarioId: claimCompleteScenario.id, scenarioHash: claimCompleteScenarioHash, runId: 'package-smoke-evidence-run', attemptId: 'attempt-1', selection: { platform: 'ios' }, source: { gitSha: 'c156f784600e8b5245cfedbcdbd2a48376704f70' }, package: { name: 'agent-scenario-loop', version: packageJson.version, sha256: 'a'.repeat(64) }, target: { resourceId: 'mobile-target:ios:package-smoke', deviceId: 'package-smoke-device', runtimeId: 'ios-package-smoke' }, installedApp: { appId: 'dev.example.app', version: '1.0.0', buildId: '1', sha256: 'b'.repeat(64) }, runner: { id: 'package-smoke-runner', version: packageJson.version }, adapter: { id: 'package-smoke-adapter', version: '1.0.0' }, transport: { id: 'package-smoke-transport', version: '1.0.0' }, appHelper: { payloadId: 'profile-session-helper@1.1.0', sha256: 'c'.repeat(64) }, environment: { id: 'package-smoke-environment', cohortHash: 'a'.repeat(64) }, producers: [{ role: 'app', producerId: 'app', version: '1.0.0', sha256: 'b'.repeat(64) }] };",
      "const claimEvidenceRunIdentityHash = asl.buildScenarioClaimEvidenceRunIdentityHash(claimEvidenceRunIdentity);",
      "const claimEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'package-smoke-candidate', runIdentityHash: claimEvidenceRunIdentityHash, claimId: 'app-usable', claimHash: asl.buildScenarioClaimHash(claimCompleteScenario.claims[0]), assertionId: 'usable-event', assertionKind: 'eventOccurrence', authority: { declarationId: 'package-smoke-app-authority', role: 'app', producerId: 'app', evidenceSelector: 'events.app_first_usable_screen', producerVersion: '1.0.0', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/profile-events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'not-redacted' };",
      "const claimEvidenceInspection = asl.inspectScenarioClaimEvidenceCandidateIdentity({ admission: claimAdmission, scenario: claimCompleteScenario, runIdentity: claimEvidenceRunIdentity, claimId: 'app-usable', assertionId: 'usable-event', candidate: claimEvidenceCandidate });",
      "assert.equal(claimEvidenceInspection.status, 'eligible');",
      "assert.equal(claimEvidenceInspection.contractVersion, '1.0.0');",
      "assert.deepEqual(claimEvidenceInspection.blockingGates, []);",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection, 'eligibleCandidate'), true);",
      "assert.notEqual(claimEvidenceInspection.eligibleCandidate, claimEvidenceCandidate);",
      "assert.notEqual(claimEvidenceInspection.eligibleCandidate.authority, claimEvidenceCandidate.authority);",
      "assert.notEqual(claimEvidenceInspection.eligibleCandidate.evidence, claimEvidenceCandidate.evidence);",
      "assert.equal(claimEvidenceInspection.eligibleCandidate.schemaVersion, '1.0.0');",
      "assert.equal(claimEvidenceInspection.eligibleCandidate.captureStatus, 'produced');",
      "assert.equal(claimEvidenceInspection.eligibleCandidate.assertionKind, 'eventOccurrence');",
      "assert.equal(claimEvidenceInspection.eligibleCandidate.cleanupStatus, 'finalized');",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection.eligibleCandidate, 'artifactKind'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection.eligibleCandidate, 'validationContract'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimEvidenceInspection.eligibleCandidate, 'observationWindow'), false);",
      "const blockedClaimEvidenceInspection = asl.inspectScenarioClaimEvidenceCandidateIdentity({ admission: claimAdmission, scenario: claimCompleteScenario, runIdentity: claimEvidenceRunIdentity, claimId: 'app-usable', assertionId: 'usable-event', candidate: { ...claimEvidenceCandidate, runIdentityHash: 'd'.repeat(64) } });",
      "assert.equal(blockedClaimEvidenceInspection.status, 'blocked');",
      "assert.equal(blockedClaimEvidenceInspection.firstBlockingGate, 'run_identity');",
      "assert.equal(blockedClaimEvidenceInspection.nextAction, 'repair_run_identity_binding');",
      "assert.equal(Object.prototype.hasOwnProperty.call(blockedClaimEvidenceInspection, 'eligibleCandidate'), false);",
      "const outsideClaimEvidenceInspection = asl.inspectScenarioClaimEvidenceCandidateIdentity({ admission: { ...claimAdmission, status: 'blocked' }, scenario: claimCompleteScenario, runIdentity: claimEvidenceRunIdentity, claimId: 'app-usable', assertionId: 'usable-event', candidate: claimEvidenceCandidate });",
      "assert.equal(outsideClaimEvidenceInspection.status, 'outside_contract');",
      "assert.deepEqual(outsideClaimEvidenceInspection.reasonCodes, ['admission_not_admitted']);",
      "assert.equal(Object.prototype.hasOwnProperty.call(outsideClaimEvidenceInspection, 'eligibleCandidate'), false);",
      "assert.throws(() => asl.buildScenarioClaimEvidenceRunIdentityHash({ ...claimEvidenceRunIdentity, runId: ' padded' }), asl.InvalidScenarioClaimEvidenceRunIdentityError);",
      "assert.match(asl.buildScenarioClaimHash({ id: 'claim', role: 'mandatory', applicability: { platforms: ['ios'] }, closes: { phases: ['phase'] }, assertions: [{ id: 'event', kind: 'eventOccurrence', event: 'completed', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events.completed', requiredStrength: 'observed', completeness: 'point' } }] }), /^[a-f0-9]{64}$/u);",
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
      "assert.equal(typeof asl.validateHistoricalEvaluationArtifact, 'function');",
      "assert.equal(typeof asl.coordinateQuickProof, 'function');",
      "assert.equal(typeof asl.createQuickProofAuthorizationPort, 'function');",
      "assert.equal(typeof asl.writeQuickProofArtifacts, 'function');",
      "assert.equal(typeof asl.assertValidJson, 'function');",
      "assert.deepEqual(asl.PRIMARY_RUNNER_PORT, ['prepare', 'launch', 'startSession', 'executeStep', 'waitForTruthEvent', 'captureEvidence', 'stopSession', 'finalize']);",
      "assert.deepEqual(asl.EVIDENCE_PROVIDER_PORT, ['prepare', 'startWindow', 'capture', 'stopWindow', 'finalize']);",
      "assert.deepEqual(asl.DRIVER_PORT, ['tap', 'longPress', 'typeText', 'fill', 'scroll', 'swipe', 'drag', 'pinch', 'rotate', 'rotateGesture', 'pressKey', 'pressButton', 'focus', 'assertVisible', 'inspectTree', 'screenshot', 'record', 'readLogs', 'collectPerfSignals', 'customGesture', 'runSequence']);",
      "assert.deepEqual(asl.ARTIFACT_WRITER_PORT, ['writeJson', 'writeText', 'copyRaw']);",
      "assert.deepEqual(asl.INTERPRETER_PORT, ['interpret']);",
      "assert.equal(typeof asl.validatePortImplementation, 'function');",
      "assert.equal(typeof asl.assertPortImplementation, 'function');",
      "assert.equal(typeof asl.dispatchDriverAction, 'function');",
      "assert.equal(asl.isDriverActionName('tap'), true);",
      "assert.equal(asl.isDriverActionName('drag'), true);",
      "assert.equal(asl.isDriverActionName('pinch'), true);",
      "assert.equal(asl.isDriverActionName('rotate'), true);",
      "assert.equal(asl.isDriverActionName('rotateGesture'), true);",
      "assert.equal(asl.isDriverActionName('fill'), true);",
      "assert.equal(asl.isDriverActionName('pressKey'), true);",
      "assert.equal(asl.isDriverActionName('pressButton'), true);",
      "assert.equal(asl.isDriverActionName('focus'), true);",
      "assert.equal(asl.isDriverActionName('customGesture'), true);",
      "assert.equal(asl.isDriverActionName('runSequence'), true);",
      "const driverValidation = asl.validatePortImplementation({ name: 'driver', implementation: { tap() {}, screenshot() {} }, requiredMethods: asl.DRIVER_PORT });",
      "assert.equal(driverValidation.valid, false);",
      "assert.deepEqual(driverValidation.expectedMethods, asl.DRIVER_PORT);",
      "assert.deepEqual(driverValidation.implementedMethods, ['screenshot', 'tap']);",
      "assert.deepEqual(driverValidation.missingMethods, ['longPress', 'typeText', 'fill', 'scroll', 'swipe', 'drag', 'pinch', 'rotate', 'rotateGesture', 'pressKey', 'pressButton', 'focus', 'assertVisible', 'inspectTree', 'record', 'readLogs', 'collectPerfSignals', 'customGesture', 'runSequence']);",
      "assert.equal(driverValidation.message, 'driver is missing required method(s): longPress, typeText, fill, scroll, swipe, drag, pinch, rotate, rotateGesture, pressKey, pressButton, focus, assertVisible, inspectTree, record, readLogs, collectPerfSignals, customGesture, runSequence');",
      "assert.deepEqual(asl.collectScenarioDriverActions({ steps: [{ kind: 'gesture', driverAction: 'scroll' }, { kind: 'captureEvidence', driverAction: 'screenshot', required: false }] }), { required: ['scroll'], optional: ['screenshot'] });",
      "assert.deepEqual(asl.buildScenarioExecutionPlan({ id: 'scroll', steps: [{ kind: 'gesture', driverAction: 'scroll' }] }).steps[0], { id: '01-gesture', index: 0, kind: 'gesture', portMethod: 'executeStep', required: true, driverAction: 'scroll' });",
      "assert.deepEqual(asl.buildScenarioExecutionPlan({ id: 'cadence', cadence: { commandSettleMs: 120 }, steps: [{ kind: 'command', command: 'open' }] }).steps[0].cadence, { settleMs: 120, source: 'scenario-kind' });",
      "const legacyLayoutVersionExport = ['V', '1', '_ARTIFACT_LAYOUT_VERSION'].join('');",
      "const legacyFilenamesExport = ['V', '1', '_ARTIFACT_FILENAMES'].join('');",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, legacyLayoutVersionExport), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, legacyFilenamesExport), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'TRANSITION_ARTIFACT_FILENAMES'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(layout, 'transition'), false);",
      "require.resolve('agent-scenario-loop/schemas/budget-verdict.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/authority-capabilities.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/causal-run.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/comparison.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/external-adapter-message.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/health.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/historical-evaluation.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/live-proof.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/live-proof-set.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/ci-evidence-pack.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/ci-evidence-publication-receipt.schema.json');",
      "assert.equal(asl.CI_EVIDENCE_PACK_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(typeof asl.buildCiEvidencePack, 'function');",
      "assert.equal(typeof asl.readCiEvidencePack, 'function');",
      "assert.equal(typeof asl.verifyCiEvidencePackLiveProofSet, 'function');",
      "assert.equal(typeof asl.assembleCiEvidencePack, 'function');",
      "assert.equal(typeof asl.deriveCiEvidencePackMechanismStatus, 'function');",
      "assert.equal(typeof asl.deriveCiEvidencePackTwoPlatformClaim, 'function');",
      "assert.equal(typeof asl.assertCiEvidencePackSemantics, 'function');",
      "assert.equal(typeof asl.assertCiEvidencePackRunRelativePath, 'function');",
      "assert.equal(Boolean(asl.SCHEMAS.ciEvidencePack), true);",
      "assert.equal(asl.CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(Boolean(asl.SCHEMAS.ciEvidencePublicationReceipt), true);",
      "assert.equal(typeof asl.buildCiEvidencePublicationReceipt, 'function');",
      "assert.equal(typeof asl.readCiEvidencePublicationReceipt, 'function');",
      "assert.equal(typeof asl.assertCiEvidencePublicationReceiptForPack, 'function');",
      "assert.equal(typeof asl.assertCiEvidencePublicationReceiptForExactPackBytes, 'function');",
      "assert.equal(typeof asl.renderCiEvidencePublicationSummary, 'function');",
      "assert.equal(typeof asl.evaluateCiEvidencePublicationSummary, 'function');",
      "assert.equal(typeof asl.CiEvidencePublicationReceiptError, 'function');",
      "assert.equal(asl.CI_EVIDENCE_GITHUB_PUBLICATION_SCHEMA_VERSION, '1.0.0');",
      "assert.equal(typeof asl.admitCiEvidenceGithubPublicationFacts, 'function');",
      "assert.equal(typeof asl.evaluateCiEvidenceGithubPublicationGate, 'function');",
      "assert.equal(typeof asl.CiEvidenceGithubPublicationGateError, 'function');",
      "assert.equal(typeof asl.buildCiEvidenceGithubPublicationReport, 'function');",
      "require.resolve('agent-scenario-loop/runner/ci-evidence-pack');",
      "const os = require('os');",
      "const crypto = require('crypto');",
      "const ciPackArtifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-ci-evidence-pack-package-smoke-'));",
      "const ciPackPath = path.join(ciPackArtifactRoot, 'ci-evidence-pack.json');",
      "const liveProofSetPath = path.join(ciPackArtifactRoot, 'live-proof-set.json');",
      "const ciPackSource = { expectedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', observedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'current' };",
      "const ciPackSha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';",
      "function ciPackPresentEvidence(evidenceId, attemptId, platform, kind) {",
      "  return { evidenceId, attemptId, platform, kind, status: 'present', relativePath: 'evidence/' + evidenceId + '.bin', sha256: ciPackSha256, byteSize: 12 };",
      "}",
      "function ciPackAttemptEvidence(platform, attemptId) {",
      "  const evidence = ['recording', 'verdict'].map((kind) => ciPackPresentEvidence(attemptId + '-' + kind, attemptId, platform, kind));",
      "  return { evidence, evidenceIds: evidence.map((item) => item.evidenceId) };",
      "}",
      "const androidFailedEvidence = ciPackAttemptEvidence('android', 'android-failed');",
      "const androidRetryEvidence = ciPackAttemptEvidence('android', 'android-retry');",
      "const iosPassEvidence = ciPackAttemptEvidence('ios', 'ios-pass');",
      "function ciPackProofPointer(platform, attemptId) {",
      "  return {",
      "    filePath: path.join(ciPackArtifactRoot, attemptId, 'live-proof.json'),",
      "    platform: platform,",
      "    runId: 'run-1',",
      "    status: 'passed',",
      "    comparisonStatus: 'not_compared',",
      "    summaryPath: path.join(ciPackArtifactRoot, attemptId, 'summary.json'),",
      "    profileCount: 0,",
      "    interactionProofCount: 0,",
      "    interactionWarningCount: 0,",
      "    nextAction: { code: 'none', summary: 'No action required.' }",
      "  };",
      "}",
      "const liveProofSet = {",
      "  schemaVersion: '1.0.0',",
      "  runId: 'run-1',",
      "  status: 'passed',",
      "  proofCount: 2,",
      "  requiredPlatforms: ['android', 'ios'],",
      "  presentPlatforms: ['android', 'ios'],",
      "  missingPlatforms: [],",
      "  proofs: [ciPackProofPointer('android', 'android-retry'), ciPackProofPointer('ios', 'ios-pass')],",
      "  failureReasons: [],",
      "  nextAction: { code: 'none', summary: 'No action required.' },",
      "  summary: 'Android and iOS live proofs assembled.'",
      "};",
      "try {",
      "for (const pointer of liveProofSet.proofs) {",
      "  fs.mkdirSync(path.dirname(pointer.filePath), { recursive: true });",
      "  fs.writeFileSync(pointer.filePath, JSON.stringify({ platform: pointer.platform, runId: pointer.runId }));",
      "  fs.writeFileSync(pointer.summaryPath, JSON.stringify({ platform: pointer.platform, runId: pointer.runId, kind: 'summary' }));",
      "}",
      "fs.writeFileSync(liveProofSetPath, JSON.stringify(liveProofSet));",

      "const liveProofSetBytes = fs.readFileSync(liveProofSetPath);",
      "const liveProofSetSha256 = crypto.createHash('sha256').update(liveProofSetBytes).digest('hex');",
      "const ciPackInput = {",
      "  schemaVersion: '1.0.0',",
      "  packId: 'package-smoke-ci-pack',",
      "  createdAt: '2026-08-22T00:00:00.000Z',",
      "  source: ciPackSource,",
      "  liveProofSet: { relativePath: 'live-proof-set.json', sha256: liveProofSetSha256, byteSize: liveProofSetBytes.length, runId: 'run-1', status: 'passed' },",
      "  requiredPlatforms: ['android', 'ios'],",
      "  requiredEvidenceKinds: ['recording', 'verdict'],",
      "  platforms: [",
      "    { platform: 'android', authorityStatus: 'supported', evaluationStatus: 'passed', selectedAttemptId: 'android-retry' },",
      "    { platform: 'ios', authorityStatus: 'supported', evaluationStatus: 'passed', selectedAttemptId: 'ios-pass' }",
      "  ],",
      "  attempts: [",
      "    { attemptId: 'android-failed', platform: 'android', scenarioId: 'scenario-a', runId: 'run-fail', status: 'failed', attemptNumber: 1, maxAttempts: 2, startedAt: '2026-08-22T00:00:00.000Z', endedAt: '2026-08-22T00:00:30.000Z', evidenceIds: androidFailedEvidence.evidenceIds },",
      "    { attemptId: 'android-retry', platform: 'android', scenarioId: 'scenario-a', runId: 'run-1', status: 'passed', attemptNumber: 2, maxAttempts: 2, startedAt: '2026-08-22T00:01:00.000Z', predecessorAttemptId: 'android-failed', evidenceIds: androidRetryEvidence.evidenceIds },",
      "    { attemptId: 'ios-pass', platform: 'ios', scenarioId: 'scenario-a', runId: 'run-1', status: 'passed', attemptNumber: 1, maxAttempts: 1, startedAt: '2026-08-22T00:02:00.000Z', evidenceIds: iosPassEvidence.evidenceIds }",
      "  ],",
      "  evidence: [...androidFailedEvidence.evidence, ...androidRetryEvidence.evidence, ...iosPassEvidence.evidence],",
      "  verdicts: [",
      "    { scenarioId: 'scenario-a', runId: 'run-fail', platform: 'android', status: 'failed', evidenceId: 'android-failed-verdict' },",
      "    { scenarioId: 'scenario-a', runId: 'run-1', platform: 'android', status: 'failed', evidenceId: 'android-retry-verdict' },",
      "    { scenarioId: 'scenario-a', runId: 'run-1', platform: 'ios', status: 'passed', evidenceId: 'ios-pass-verdict' }",
      "  ],",
      "  comparisonStatus: 'not_available',",
      "  completeness: { status: 'complete', reasons: [] },",
      "  assembly: { status: 'succeeded', reasons: [] },",
      "  summary: 'android and ios evidence assembled',",
      "  nextAction: 'publish receipt in a later slice'",
      "};",
      "  asl.verifyCiEvidencePackLiveProofSet(ciPackInput, { artifactRoot: ciPackArtifactRoot });",

      "  const builtCiPack = asl.assembleCiEvidencePack(ciPackInput, { artifactRoot: ciPackArtifactRoot });",
      "  fs.writeFileSync(ciPackPath, JSON.stringify(builtCiPack));",
      "  const readCiPack = asl.readCiEvidencePack(ciPackPath);",
      "  assert.equal(readCiPack.mechanismStatus, 'succeeded');",
      "  assert.equal(readCiPack.twoPlatformClaim.status, 'passed');",
      "  assert.deepEqual(readCiPack.twoPlatformClaim.reasons, []);",
      "  assert.deepEqual(readCiPack.source, ciPackSource);",
      "  assert.equal(readCiPack.liveProofSet.relativePath, 'live-proof-set.json');",
      "  assert.equal(readCiPack.attempts.length, 3);",
      "  assert.deepEqual(readCiPack.attempts.map((attempt) => attempt.attemptId), ['android-failed', 'android-retry', 'ios-pass']);",
      "  assert.equal(readCiPack.platforms[0].selectedAttemptId, 'android-retry');",
      "  assert.equal(readCiPack.platforms[1].selectedAttemptId, 'ios-pass');",
      "  assert.equal(readCiPack.attempts[0].attemptNumber, 1);",
      "  assert.equal(readCiPack.attempts[0].maxAttempts, 2);",
      "  assert.equal(readCiPack.attempts[1].attemptNumber, 2);",
      "  assert.equal(readCiPack.attempts[1].maxAttempts, 2);",
      "  assert.equal(readCiPack.attempts[1].predecessorAttemptId, 'android-failed');",
      "  assert.equal(readCiPack.verdicts[1].status, 'failed');",
      "  assert.equal(readCiPack.twoPlatformClaim.status, 'passed');",
      "  const packedCiPackBytes = fs.readFileSync(ciPackPath);",
      "  const packedCiPackSha256 = crypto.createHash('sha256').update(packedCiPackBytes).digest('hex');",
      "  const parsedEquivalentDifferentPackBytes = Buffer.concat([packedCiPackBytes, Buffer.from('\\n')]);",
      "  const publicationReceipt = asl.buildCiEvidencePublicationReceipt({",
      "    packBytes: packedCiPackBytes,",
      "    facts: {",
      "      receiptId: 'package-smoke-ci-publication-receipt',",
      "      createdAt: '2026-08-22T00:03:00.000Z',",
      "      packRelativePath: 'ci-evidence-pack.json',",
      "      publisher: { providerId: 'package-smoke', providerKind: 'local', runId: 'package-smoke-run', attemptNumber: 1 },",
      "      requestedItems: [{ requestId: 'pack-artifact', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' }],",
      "      outcomes: [{ requestId: 'pack-artifact', status: 'published', url: 'https://evidence.example.test/packs/package-smoke-ci-pack', visibility: 'public', publishedAt: '2026-08-22T00:03:00.000Z' }]",
      "    }",
      "  });",
      "  asl.assertCiEvidencePublicationReceiptForPack(publicationReceipt, readCiPack);",
      "  asl.assertCiEvidencePublicationReceiptForExactPackBytes(publicationReceipt, readCiPack, packedCiPackBytes);",
      "  const receiptPath = path.join(ciPackArtifactRoot, 'ci-evidence-publication-receipt.json');",
      "  fs.writeFileSync(receiptPath, JSON.stringify(publicationReceipt));",
      "  const readReceipt = asl.readCiEvidencePublicationReceipt(receiptPath, packedCiPackBytes);",
      "  assert.equal(readReceipt.receiptId, publicationReceipt.receiptId);",
      "  assert.equal(readReceipt.publicationStatus, 'published');",
      "  assert.throws(() => asl.readCiEvidencePublicationReceipt(receiptPath, Buffer.from(JSON.stringify(readCiPack, null, 2))), asl.CiEvidencePublicationReceiptError);",
      "  assert.throws(() => asl.readCiEvidencePublicationReceipt(receiptPath, parsedEquivalentDifferentPackBytes), asl.CiEvidencePublicationReceiptError);",
      "  assert.throws(() => asl.assertCiEvidencePublicationReceiptForExactPackBytes(publicationReceipt, readCiPack, parsedEquivalentDifferentPackBytes), asl.CiEvidencePublicationReceiptError);",
      "  assert.throws(() => asl.renderCiEvidencePublicationSummary(readCiPack, publicationReceipt, parsedEquivalentDifferentPackBytes), asl.CiEvidencePublicationReceiptError);",
      "  const publicationSummary = asl.renderCiEvidencePublicationSummary(readCiPack, publicationReceipt, packedCiPackBytes);",
      "  assert.equal(publicationReceipt.pack.sha256, packedCiPackSha256);",
      "  assert.equal(publicationReceipt.pack.byteSize, packedCiPackBytes.byteLength);",
      "  assert.equal(publicationReceipt.publicationStatus, 'published');",
      "  assert.match(publicationSummary, /\\| pack mechanism \\|/);",
      "  assert.match(publicationSummary, /\\| two-platform evidence claim \\| passed \\|/);",
      "  assert.match(publicationSummary, /\\| comparison \\|/);",
      "  assert.match(publicationSummary, /\\| completeness \\|/);",
      "  assert.match(publicationSummary, /\\| assembly \\|/);",
      "  assert.match(publicationSummary, /\\| Android selected product verdict \\|/);",
      "  assert.match(publicationSummary, /\\| iOS selected product verdict \\|/);",
      "  assert.match(publicationSummary, /\\| publication \\| published \\|/);",
      "  assert.match(publicationSummary, /Publication success does not prove runtime acceptance\\./);",
      "  assert.match(publicationSummary, /Publication success does not prove deployment\\./);",
      "  assert.doesNotMatch(publicationSummary, /\\|\\s*release(?:\\s+acceptance)?\\s*\\|/i);",
      "  assert.doesNotMatch(publicationSummary, /\\|\\s*runtime(?:\\s+acceptance)?\\s*\\|/i);",
      "  assert.doesNotMatch(publicationSummary, /\\|\\s*deployment(?:\\s+acceptance)?\\s*\\|/i);",
      "  const { spawnSync } = require('child_process');",
      "  const ciPackBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'asl-ci-evidence-pack.cmd' : 'asl-ci-evidence-pack');",
      "  function runCiPackCli(args) {",
      "    return spawnSync(ciPackBin, args, { encoding: 'utf8' });",
      "  }",
      "  const cliOutDir = path.join(ciPackArtifactRoot, 'cli-out');",
      "  fs.mkdirSync(cliOutDir, { recursive: true });",
      "  const cliRequestPath = path.join(ciPackArtifactRoot, 'assemble-request.json');",
      "  const cliRequest = { artifactRoot: ciPackArtifactRoot, outDir: cliOutDir, input: ciPackInput };",
      "  fs.writeFileSync(cliRequestPath, JSON.stringify(cliRequest));",
      "  const cliPackPath = path.join(cliOutDir, 'ci-evidence-pack.json');",
      "  const assembleResult = runCiPackCli(['assemble', '--request', cliRequestPath]);",
      "  assert.equal(assembleResult.status, 0, assembleResult.stderr || assembleResult.stdout);",
      "  const assembleStdout = JSON.parse(assembleResult.stdout);",
      "  assert.equal(assembleStdout.phase, 'assemble');",
      "  assert.equal(assembleStdout.artifact, path.resolve(cliPackPath));",
      "  assert.equal(assembleStdout.publicationAttempted, false);",
      "  assert.equal(assembleStdout.gateStatus, 'passed');",
      "  assert.equal(assembleStdout.mechanismStatus, 'succeeded');",
      "  assert.equal(assembleStdout.twoPlatformClaimStatus, 'passed');",
      "  assert.equal(fs.existsSync(cliPackPath), true);",
      "  const cliPack = JSON.parse(fs.readFileSync(cliPackPath, 'utf8'));",
      "  assert.equal(cliPack.mechanismStatus, 'succeeded');",
      "  assert.equal(cliPack.twoPlatformClaim.status, 'passed');",
      "  assert.deepEqual(cliPack.attempts.map((attempt) => attempt.attemptId), ['android-failed', 'android-retry', 'ios-pass']);",
      "  assert.equal(cliPack.attempts[0].status, 'failed');",
      "  const cliPackBytes = fs.readFileSync(cliPackPath);",
      "  const parsedCliPack = asl.parseCiEvidencePackBytes(cliPackBytes);",
      "  assert.equal(parsedCliPack.packId, cliPack.packId);",
      "  assert.equal(parsedCliPack.mechanismStatus, 'succeeded');",
      "  assert.equal(parsedCliPack.twoPlatformClaim.status, 'passed');",
      "  const parsedAndroidRun1Verdict = parsedCliPack.verdicts.find(",
      "    (verdict) => verdict.runId === 'run-1' && verdict.platform === 'android',",
      "  );",
      "  const parsedIosRun1Verdict = parsedCliPack.verdicts.find(",
      "    (verdict) => verdict.runId === 'run-1' && verdict.platform === 'ios',",
      "  );",
      "  assert.equal(parsedAndroidRun1Verdict?.status, 'failed');",
      "  assert.equal(parsedIosRun1Verdict?.status, 'passed');",
      "  assert.throws(() => asl.parseCiEvidencePackBytes(Buffer.from(JSON.stringify({ schemaVersion: '1.0.0' }))), asl.CiEvidencePackError);",
      "  const cliReceipt = asl.buildCiEvidencePublicationReceipt({",
      "    packBytes: cliPackBytes,",
      "    facts: {",
      "      receiptId: 'package-smoke-ci-publication-receipt-cli',",
      "      createdAt: '2026-08-22T00:04:00.000Z',",
      "      packRelativePath: 'ci-evidence-pack.json',",
      "      publisher: { providerId: 'package-smoke', providerKind: 'local', runId: 'package-smoke-run', attemptNumber: 1 },",
      "      requestedItems: [",
      "        { requestId: 'pack-artifact-ci-evidence-pack', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' },",
      "        { requestId: 'pack-artifact-live-proof-set', targetKind: 'pack_artifact', packArtifact: 'live_proof_set' },",
      "        { requestId: 'evidence-android-retry-recording', targetKind: 'evidence', evidenceId: 'android-retry-recording' },",
      "        { requestId: 'evidence-android-retry-verdict', targetKind: 'evidence', evidenceId: 'android-retry-verdict' },",
      "        { requestId: 'evidence-ios-pass-recording', targetKind: 'evidence', evidenceId: 'ios-pass-recording' },",
      "        { requestId: 'evidence-ios-pass-verdict', targetKind: 'evidence', evidenceId: 'ios-pass-verdict' }",
      "      ],",
      "      outcomes: [",
      "        { requestId: 'pack-artifact-ci-evidence-pack', status: 'published', url: 'https://evidence.example.test/packs/package-smoke-ci-pack-cli', visibility: 'public', publishedAt: '2026-08-22T00:04:00.000Z' },",
      "        { requestId: 'pack-artifact-live-proof-set', status: 'published', url: 'https://evidence.example.test/packs/package-smoke-live-proof-set-cli', visibility: 'public', publishedAt: '2026-08-22T00:04:00.000Z' },",
      "        { requestId: 'evidence-android-retry-recording', status: 'published', url: 'https://evidence.example.test/evidence/android-retry-recording-cli', visibility: 'public', publishedAt: '2026-08-22T00:04:00.000Z' },",
      "        { requestId: 'evidence-android-retry-verdict', status: 'published', url: 'https://evidence.example.test/evidence/android-retry-verdict-cli', visibility: 'public', publishedAt: '2026-08-22T00:04:00.000Z' },",
      "        { requestId: 'evidence-ios-pass-recording', status: 'published', url: 'https://evidence.example.test/evidence/ios-pass-recording-cli', visibility: 'public', publishedAt: '2026-08-22T00:04:00.000Z' },",
      "        { requestId: 'evidence-ios-pass-verdict', status: 'published', url: 'https://evidence.example.test/evidence/ios-pass-verdict-cli', visibility: 'public', publishedAt: '2026-08-22T00:04:00.000Z' }",
      "      ]",
      "    }",
      "  });",
      "  const cliReceiptPath = path.join(cliOutDir, 'ci-evidence-publication-receipt.json');",
      "  fs.writeFileSync(cliReceiptPath, JSON.stringify(cliReceipt));",
      "  const cliSummaryPath = path.join(cliOutDir, 'publication-summary.md');",
      "  const summarizeResult = runCiPackCli(['summarize', '--pack', cliPackPath, '--receipt', cliReceiptPath, '--out', cliSummaryPath]);",
      "  assert.equal(summarizeResult.status, 0, summarizeResult.stderr || summarizeResult.stdout);",
      "  const summarizeStdout = JSON.parse(summarizeResult.stdout);",
      "  assert.equal(summarizeStdout.phase, 'summarize');",
      "  assert.equal(summarizeStdout.artifact, path.resolve(cliSummaryPath));",
      "  assert.equal(summarizeStdout.gateStatus, 'passed');",
      "  const cliSummary = fs.readFileSync(cliSummaryPath, 'utf8');",
      "  const summarizeAgain = runCiPackCli(['summarize', '--pack', cliPackPath, '--receipt', cliReceiptPath, '--out', path.join(cliOutDir, 'publication-summary-repeat.md')]);",
      "  assert.equal(summarizeAgain.status, 0);",
      "  assert.equal(fs.readFileSync(path.join(cliOutDir, 'publication-summary-repeat.md'), 'utf8'), cliSummary);",
      "  assert.match(cliSummary, /\\| two-platform evidence claim \\| passed \\|/);",
      "  assert.match(cliSummary, /\\| publication evidence gate \\| passed \\|/);",
      "  assert.match(cliSummary, /Publication success does not prove runtime acceptance\\./);",
      "  const unknownCommand = runCiPackCli(['definitely-not-a-command']);",
      "  assert.equal(unknownCommand.status, 2);",
      "  assert.equal(unknownCommand.stdout, '');",
      "  assert.match(unknownCommand.stderr, /Usage/);",
      "  const packBytesBeforeAlias = fs.readFileSync(cliPackPath);",
      "  const receiptBytesBeforeAlias = fs.readFileSync(cliReceiptPath);",
      "  const summaryBytesBeforeAlias = fs.readFileSync(cliSummaryPath);",
      "  const packOutAlias = path.join(cliOutDir, 'pack-out-alias.json');",
      "  fs.symlinkSync(path.resolve(cliPackPath), packOutAlias);",
      "  const aliasSummarize = runCiPackCli(['summarize', '--pack', cliPackPath, '--receipt', cliReceiptPath, '--out', packOutAlias]);",
      "  assert.equal(aliasSummarize.status, 2);",
      "  assert.equal(aliasSummarize.stdout, '');",
      "  assert.match(aliasSummarize.stderr, /must not overwrite the bound (?:pack|receipt)/);",
      "  assert.deepEqual(fs.readFileSync(cliPackPath), packBytesBeforeAlias);",
      "  assert.deepEqual(fs.readFileSync(cliReceiptPath), receiptBytesBeforeAlias);",
      "  assert.deepEqual(fs.readFileSync(cliSummaryPath), summaryBytesBeforeAlias);",
      "  assert.doesNotMatch(aliasSummarize.stderr, /Publication success does not prove runtime acceptance\\./);",
      "  const packedPublicationEvaluation = asl.evaluateCiEvidencePublicationSummary(parsedCliPack, cliReceipt, cliPackBytes);",
      "  assert.equal(packedPublicationEvaluation.status, 'passed');",
      "  const packedPublicAudienceEvaluation = asl.evaluateCiEvidencePublicationSummary(parsedCliPack, cliReceipt, cliPackBytes, { audience: 'public' });",
      "  assert.equal(packedPublicAudienceEvaluation.status, 'passed');",
      "  const packedAuthenticatedReviewerEvaluation = asl.evaluateCiEvidencePublicationSummary(parsedCliPack, cliReceipt, cliPackBytes, { audience: 'authenticated_reviewer' });",
      "  assert.equal(packedAuthenticatedReviewerEvaluation.status, 'passed');",
      "  const githubPublicationFacts = {",
      "    schemaVersion: '1.0.0',",
      "    receiptId: 'package-smoke-github-publication',",
      "    createdAt: '2026-08-22T00:06:00.000Z',",
      "    packRelativePath: 'ci-evidence-pack.json',",
      "    context: {",
      "      repository: { owner: 'example-org', repo: 'example-repo' },",
      "      eventName: 'pull_request',",
      "      headSha: ciPackSource.observedSha,",
      "      ref: 'refs/pull/42/head',",
      "      pullRequestNumber: 42",
      "    },",
      "    publisher: {",
      "      providerKind: 'ci_workflow',",
      "      providerId: 'github-actions',",
      "      runId: 'package-smoke-run-1',",
      "      workflowId: 'ci-evidence.yml',",
      "      jobId: 'publish-evidence',",
      "      attemptNumber: 1",
      "    },",
      "    requestedItems: [",
      "      { requestId: 'pack-artifact-ci-evidence-pack', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' },",
      "      { requestId: 'pack-artifact-live-proof-set', targetKind: 'pack_artifact', packArtifact: 'live_proof_set' },",
      "      { requestId: 'evidence-android-retry-recording', targetKind: 'evidence', evidenceId: 'android-retry-recording' },",
      "      { requestId: 'evidence-android-retry-verdict', targetKind: 'evidence', evidenceId: 'android-retry-verdict' },",
      "      { requestId: 'evidence-ios-pass-recording', targetKind: 'evidence', evidenceId: 'ios-pass-recording' },",
      "      { requestId: 'evidence-ios-pass-verdict', targetKind: 'evidence', evidenceId: 'ios-pass-verdict' }",
      "    ],",
      "    outcomes: [",
      "      { requestId: 'pack-artifact-ci-evidence-pack', status: 'published', url: 'https://github.com/example-org/example-repo/actions/artifacts/pack', visibility: 'restricted', publishedAt: '2026-08-22T00:06:00.000Z' },",
      "      { requestId: 'pack-artifact-live-proof-set', status: 'published', url: 'https://github.com/example-org/example-repo/actions/artifacts/live-proof-set', visibility: 'restricted', publishedAt: '2026-08-22T00:06:00.000Z' },",
      "      { requestId: 'evidence-android-retry-recording', status: 'published', url: 'https://github.com/example-org/example-repo/actions/artifacts/android-retry-recording', visibility: 'restricted', publishedAt: '2026-08-22T00:06:00.000Z' },",
      "      { requestId: 'evidence-android-retry-verdict', status: 'published', url: 'https://github.com/example-org/example-repo/actions/artifacts/android-retry-verdict', visibility: 'restricted', publishedAt: '2026-08-22T00:06:00.000Z' },",
      "      { requestId: 'evidence-ios-pass-recording', status: 'published', url: 'https://github.com/example-org/example-repo/actions/artifacts/ios-pass-recording', visibility: 'restricted', publishedAt: '2026-08-22T00:06:00.000Z' },",
      "      { requestId: 'evidence-ios-pass-verdict', status: 'published', url: 'https://github.com/example-org/example-repo/actions/artifacts/ios-pass-verdict', visibility: 'restricted', publishedAt: '2026-08-22T00:06:00.000Z' }",
      "    ]",
      "  };",
      "  const admittedGitHubFacts = asl.admitCiEvidenceGithubPublicationFacts(githubPublicationFacts);",
      "  assert.equal(admittedGitHubFacts.publisher.providerKind, 'ci_workflow');",
      "  const githubGate = asl.evaluateCiEvidenceGithubPublicationGate(cliPackBytes, githubPublicationFacts);",
      "  assert.equal(githubGate.evaluation.status, 'passed');",
      "  const githubReportBuilt = asl.buildCiEvidenceGithubPublicationReport(cliPackBytes, githubPublicationFacts);",
      "  assert.equal(githubReportBuilt.gate.evaluation.status, 'passed');",
      "  const githubInputPath = path.join(ciPackArtifactRoot, 'github-publication-input.json');",
      "  fs.writeFileSync(githubInputPath, JSON.stringify(githubPublicationFacts));",
      "  const githubOutDir = path.join(ciPackArtifactRoot, 'github-report-out');",
      "  const githubReportResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', githubOutDir]);",
      "  assert.equal(githubReportResult.status, 0, githubReportResult.stderr || githubReportResult.stdout);",
      "  const githubReportStdout = JSON.parse(githubReportResult.stdout);",
      "  assert.equal(githubReportStdout.phase, 'github-report');",
      "  assert.equal(githubReportStdout.artifactDirectory, githubOutDir);",
      "  assert.equal(githubReportStdout.receiptArtifact, path.join(githubOutDir, 'ci-evidence-publication-receipt.json'));",
      "  assert.equal(githubReportStdout.reportArtifact, path.join(githubOutDir, 'ci-evidence-github-report.md'));",
      "  assert.equal(githubReportStdout.gateStatus, 'passed');",
      "  assert.equal('artifact' in githubReportStdout, false);",
      "  assert.equal('productVerdictStatus' in githubReportStdout, false);",
      "  assert.equal('comparisonStatus' in githubReportStdout, false);",
      "  const githubReceiptPath = path.join(githubOutDir, 'ci-evidence-publication-receipt.json');",
      "  const githubMarkdownPath = path.join(githubOutDir, 'ci-evidence-github-report.md');",
      "  const githubIncompleteMarker = path.join(githubOutDir, '.ci-evidence-github-report.incomplete');",
      "  assert.equal(fs.existsSync(githubReceiptPath), true);",
      "  assert.equal(fs.existsSync(githubMarkdownPath), true);",
      "  assert.equal(fs.existsSync(githubIncompleteMarker), false);",
      "  const githubReceipt = asl.readCiEvidencePublicationReceipt(githubReceiptPath, cliPackBytes);",
      "  asl.assertCiEvidencePublicationReceiptForExactPackBytes(githubReceipt, parsedCliPack, cliPackBytes);",
      "  const githubMarkdown = fs.readFileSync(githubMarkdownPath, 'utf8');",
      "  assert.equal(githubMarkdown.includes('https://github.com/example-org/example-repo/actions/artifacts/pack'), true);",
      "  assert.doesNotMatch(githubMarkdown, /public visibility/);",
      "  assert.match(githubMarkdown, /Restricted links require authenticated access/);",
      "  const failedGitHubFacts = JSON.parse(JSON.stringify(githubPublicationFacts));",
      "  failedGitHubFacts.receiptId = 'package-smoke-github-publication-failed';",
      "  failedGitHubFacts.outcomes = [{ requestId: 'pack-artifact-ci-evidence-pack', status: 'not_available', reason: 'publication target was not bound' }];",
      "  failedGitHubFacts.requestedItems = [{ requestId: 'pack-artifact-ci-evidence-pack', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' }];",
      "  const failedGitHubInputPath = path.join(ciPackArtifactRoot, 'github-publication-input-failed.json');",
      "  fs.writeFileSync(failedGitHubInputPath, JSON.stringify(failedGitHubFacts));",
      "  const failedGitHubOutDir = path.join(ciPackArtifactRoot, 'github-report-failed');",
      "  const failedGitHubResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', failedGitHubInputPath, '--out', failedGitHubOutDir]);",
      "  assert.equal(failedGitHubResult.status, 1, failedGitHubResult.stderr || failedGitHubResult.stdout);",
      "  const failedGitHubStdout = JSON.parse(failedGitHubResult.stdout);",
      "  assert.equal(failedGitHubStdout.phase, 'github-report');",
      "  assert.equal(failedGitHubStdout.artifactDirectory, failedGitHubOutDir);",
      "  assert.equal(failedGitHubStdout.receiptArtifact, path.join(failedGitHubOutDir, 'ci-evidence-publication-receipt.json'));",
      "  assert.equal(failedGitHubStdout.reportArtifact, path.join(failedGitHubOutDir, 'ci-evidence-github-report.md'));",
      "  assert.equal(failedGitHubStdout.gateStatus, 'failed');",
      "  assert.equal('artifact' in failedGitHubStdout, false);",
      "  assert.equal('productVerdictStatus' in failedGitHubStdout, false);",
      "  assert.equal('comparisonStatus' in failedGitHubStdout, false);",
      "  assert.equal(fs.existsSync(path.join(failedGitHubOutDir, 'ci-evidence-publication-receipt.json')), true);",
      "  assert.equal(fs.existsSync(path.join(failedGitHubOutDir, 'ci-evidence-github-report.md')), true);",
      "  assert.equal(fs.existsSync(path.join(failedGitHubOutDir, '.ci-evidence-github-report.incomplete')), false);",
      "  const occupiedGitHubOut = path.join(ciPackArtifactRoot, 'github-report-occupied');",
      "  fs.mkdirSync(occupiedGitHubOut, { recursive: true });",
      "  const occupiedMarkerPath = path.join(occupiedGitHubOut, 'keep-me.txt');",
      "  fs.writeFileSync(occupiedMarkerPath, 'preserve-existing-bytes');",
      "  const occupiedGitHubResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', occupiedGitHubOut]);",
      "  assert.equal(occupiedGitHubResult.status, 2);",
      "  assert.equal(occupiedGitHubResult.stdout, '');",
      "  assert.equal(fs.readFileSync(occupiedMarkerPath, 'utf8'), 'preserve-existing-bytes');",
      "  const existingEmptyDirOut = path.join(ciPackArtifactRoot, 'github-report-existing-empty-dir');",
      "  fs.mkdirSync(existingEmptyDirOut, { recursive: true });",
      "  const existingEmptyDirResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', existingEmptyDirOut]);",
      "  assert.equal(existingEmptyDirResult.status, 2);",
      "  assert.equal(existingEmptyDirResult.stdout, '');",
      "  assert.equal(fs.existsSync(existingEmptyDirOut), true);",
      "  assert.deepEqual(fs.readdirSync(existingEmptyDirOut), []);",
      "  const existingFileOut = path.join(ciPackArtifactRoot, 'github-report-existing-file');",
      "  fs.writeFileSync(existingFileOut, 'preserve-regular-file-bytes');",
      "  const existingFileResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', existingFileOut]);",
      "  assert.equal(existingFileResult.status, 2);",
      "  assert.equal(existingFileResult.stdout, '');",
      "  assert.equal(fs.readFileSync(existingFileOut, 'utf8'), 'preserve-regular-file-bytes');",
      "  const symlinkTargetPath = path.join(ciPackArtifactRoot, 'github-report-symlink-target');",
      "  const symlinkOut = path.join(ciPackArtifactRoot, 'github-report-symlink-out');",
      "  fs.writeFileSync(symlinkTargetPath, 'preserve-symlink-target-bytes');",
      "  fs.symlinkSync(symlinkTargetPath, symlinkOut);",
      "  const symlinkResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', symlinkOut]);",
      "  assert.equal(symlinkResult.status, 2);",
      "  assert.equal(symlinkResult.stdout, '');",
      "  assert.equal(fs.lstatSync(symlinkOut).isSymbolicLink(), true);",
      "  assert.equal(fs.readlinkSync(symlinkOut), symlinkTargetPath);",
      "  assert.equal(fs.readFileSync(symlinkTargetPath, 'utf8'), 'preserve-symlink-target-bytes');",
      "  const danglingSymlinkOut = path.join(ciPackArtifactRoot, 'github-report-dangling-symlink-out');",
      "  const danglingTargetPath = path.join(ciPackArtifactRoot, 'github-report-dangling-target-missing');",
      "  fs.symlinkSync(danglingTargetPath, danglingSymlinkOut);",
      "  const danglingSymlinkResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', danglingSymlinkOut]);",
      "  assert.equal(danglingSymlinkResult.status, 2);",
      "  assert.equal(danglingSymlinkResult.stdout, '');",
      "  assert.equal(fs.lstatSync(danglingSymlinkOut).isSymbolicLink(), true);",
      "  assert.equal(fs.readlinkSync(danglingSymlinkOut), danglingTargetPath);",
      "  assert.equal(fs.existsSync(danglingTargetPath), false);",
      "  const packAliasBytes = fs.readFileSync(cliPackPath);",
      "  const packAliasResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', cliPackPath]);",
      "  assert.equal(packAliasResult.status, 2);",
      "  assert.equal(packAliasResult.stdout, '');",
      "  assert.deepEqual(fs.readFileSync(cliPackPath), packAliasBytes);",
      "  const githubInputAliasBytes = fs.readFileSync(githubInputPath);",
      "  const githubInputAliasResult = runCiPackCli(['github-report', '--pack', cliPackPath, '--input', githubInputPath, '--out', githubInputPath]);",
      "  assert.equal(githubInputAliasResult.status, 2);",
      "  assert.equal(githubInputAliasResult.stdout, '');",
      "  assert.deepEqual(fs.readFileSync(githubInputPath), githubInputAliasBytes);",
      "  const tamperedPackPath = path.join(cliOutDir, 'tampered-ci-evidence-pack.json');",
      "  const tamperedSummaryPath = path.join(cliOutDir, 'tampered-publication-summary.md');",
      "  fs.writeFileSync(tamperedPackPath, Buffer.concat([cliPackBytes, Buffer.from('\\n')]));",
      "  const tamperedSummarize = runCiPackCli(['summarize', '--pack', tamperedPackPath, '--receipt', cliReceiptPath, '--out', tamperedSummaryPath]);",
      "  assert.equal(tamperedSummarize.status, 1, tamperedSummarize.stderr || tamperedSummarize.stdout);",
      "  assert.equal(fs.existsSync(tamperedSummaryPath), false);",
      "  const wrongLiveProofSetDir = path.join(ciPackArtifactRoot, 'wrong-live-proof-set');",
      "  fs.mkdirSync(wrongLiveProofSetDir, { recursive: true });",
      "  const wrongLiveProofSetRequestPath = path.join(ciPackArtifactRoot, 'wrong-live-proof-set-request.json');",
      "  const wrongLiveProofSetPackPath = path.join(wrongLiveProofSetDir, 'ci-evidence-pack.json');",
      "  const wrongLiveProofSetInput = JSON.parse(JSON.stringify(ciPackInput));",
      "  wrongLiveProofSetInput.liveProofSet.sha256 = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';",
      "  fs.writeFileSync(wrongLiveProofSetRequestPath, JSON.stringify({ artifactRoot: ciPackArtifactRoot, outDir: wrongLiveProofSetDir, input: wrongLiveProofSetInput }));",
      "  const wrongLiveProofSetResult = runCiPackCli(['assemble', '--request', wrongLiveProofSetRequestPath]);",
      "  assert.equal(wrongLiveProofSetResult.status, 1, wrongLiveProofSetResult.stderr || wrongLiveProofSetResult.stdout);",
      "  assert.equal(fs.existsSync(wrongLiveProofSetPackPath), false);",
      "  const notAvailableReceipt = asl.buildCiEvidencePublicationReceipt({",
      "    packBytes: cliPackBytes,",
      "    facts: {",
      "      receiptId: 'package-smoke-ci-publication-receipt-not-available',",
      "      createdAt: '2026-08-22T00:05:00.000Z',",
      "      packRelativePath: 'ci-evidence-pack.json',",
      "      publisher: { providerId: 'package-smoke', providerKind: 'local', runId: 'package-smoke-run', attemptNumber: 1 },",
      "      requestedItems: [{ requestId: 'pack-artifact', targetKind: 'pack_artifact', packArtifact: 'ci_evidence_pack' }],",
      "      outcomes: [{ requestId: 'pack-artifact', status: 'not_available', reason: 'publication target was not bound' }]",
      "    }",
      "  });",
      "  const notAvailableReceiptPath = path.join(cliOutDir, 'not-available-receipt.json');",
      "  const notAvailableSummaryPath = path.join(cliOutDir, 'not-available-summary.md');",
      "  fs.writeFileSync(notAvailableReceiptPath, JSON.stringify(notAvailableReceipt));",
      "  const notAvailableResult = runCiPackCli(['summarize', '--pack', cliPackPath, '--receipt', notAvailableReceiptPath, '--out', notAvailableSummaryPath]);",
      "  assert.equal(notAvailableResult.status, 1);",
      "  assert.equal(fs.existsSync(notAvailableSummaryPath), true);",
      "  assert.match(fs.readFileSync(notAvailableSummaryPath, 'utf8'), /not\\\\_available/);",
      "  const extraTopLevelDir = path.join(ciPackArtifactRoot, 'extra-top-level');",
      "  fs.mkdirSync(extraTopLevelDir, { recursive: true });",
      "  const extraTopLevelRequestPath = path.join(ciPackArtifactRoot, 'extra-top-level-request.json');",
      "  const extraTopLevelPackPath = path.join(extraTopLevelDir, 'ci-evidence-pack.json');",
      "  fs.writeFileSync(extraTopLevelRequestPath, JSON.stringify({ artifactRoot: ciPackArtifactRoot, outDir: extraTopLevelDir, input: ciPackInput, extra: true }));",
      "  const extraTopLevelResult = runCiPackCli(['assemble', '--request', extraTopLevelRequestPath]);",
      "  assert.equal(extraTopLevelResult.status, 2);",
      "  assert.equal(fs.existsSync(extraTopLevelPackPath), false);",
      "  const extraInputDir = path.join(ciPackArtifactRoot, 'extra-input');",
      "  fs.mkdirSync(extraInputDir, { recursive: true });",
      "  const extraInputRequestPath = path.join(ciPackArtifactRoot, 'extra-input-request.json');",
      "  const extraInputPackPath = path.join(extraInputDir, 'ci-evidence-pack.json');",
      "  fs.writeFileSync(extraInputRequestPath, JSON.stringify({ artifactRoot: ciPackArtifactRoot, outDir: extraInputDir, input: { ...ciPackInput, extra: true } }));",
      "  const extraInputResult = runCiPackCli(['assemble', '--request', extraInputRequestPath]);",
      "  assert.equal(extraInputResult.status, 2);",
      "  assert.equal(fs.existsSync(extraInputPackPath), false);",
      "} finally {",
      "  fs.rmSync(ciPackArtifactRoot, { recursive: true, force: true });",
      "}",
      "require.resolve('agent-scenario-loop/schemas/scenario.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/scenario-claim-authorization-grant.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/manifest.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/metrics.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/native-performance.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/project-validation.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/quick-proof.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/runner-capabilities.schema.json');",
      "require.resolve('agent-scenario-loop/schemas/verdict.schema.json');",
      "require.resolve('agent-scenario-loop/examples/scenarios/mobile/app-startup.json');",
      "require.resolve('agent-scenario-loop/examples/mobile-app/asl.config.json');",
      "require.resolve('agent-scenario-loop/examples/runners/README.md');",
      "require.resolve('agent-scenario-loop/examples/runners/script-accessibility-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-memory-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-native-performance-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-network-provider.json');",
      "require.resolve('agent-scenario-loop/examples/runners/script-profiler-provider.json');",
      "require.resolve('agent-scenario-loop/templates/project.config.json');",
      "require.resolve('agent-scenario-loop/templates/mobile-scenario.json');",
      "require.resolve('agent-scenario-loop/templates/primary-runner.json');",
      "require.resolve('agent-scenario-loop/templates/evidence-provider.json');",
      "require.resolve('agent-scenario-loop/templates/authority-capabilities.json');",
      "require.resolve('agent-scenario-loop/templates/gitignore-snippet');",
      "require.resolve('agent-scenario-loop/templates/integration-readme.md');",
      "require.resolve('agent-scenario-loop/templates/package-scripts.json');",
      "require.resolve('agent-scenario-loop/templates/skills/agent-scenario-loop/SKILL.md');",
      "require.resolve('agent-scenario-loop/templates/skills/agent-scenario-loop/references/artifact-interpretation.md');",
      "require.resolve('agent-scenario-loop/templates/skills/agent-scenario-loop/references/adoption-checklist.md');",
      "require.resolve('agent-scenario-loop/templates/scripts/asl-capture-accessibility-provider.mjs');",
      "require.resolve('agent-scenario-loop/templates/scripts/asl-capture-native-performance-provider.mjs');",
      "require.resolve('agent-scenario-loop/templates/scripts/asl-capture-profiler-provider.mjs');",
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
      "assert.equal(asl.validateJson(readJson('templates/authority-capabilities.json'), asl.SCHEMAS.authorityCapabilities, 'templates/authority-capabilities.json').valid, true);",
      "const authorityScenario = { ...readJson('templates/mobile-scenario.json'), schemaVersion: '1.1.0', journey: { name: 'Complete journey', intent: 'Complete the product intent.', actor: 'user', startState: 'ready', endState: 'complete', phases: [{ id: 'complete-journey', description: 'Complete the journey.', coverageKind: 'product' }], terminalInvariants: [{ id: 'terminal-stable', description: 'Terminal state is stable.', coverageKind: 'product' }], recovery: { status: 'not_required', rationale: 'No recovery is required.' } }, claims: [{ id: 'journey-completes', role: 'mandatory', applicability: { platforms: ['ios'] }, closes: { phases: ['complete-journey'], terminalInvariants: ['terminal-stable'] }, assertions: [{ id: 'completion-event', kind: 'eventOccurrence', event: 'journey_completed', authority: { role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.journey_completed', requiredStrength: 'observed', completeness: 'point' } }] }], safety: { class: 'read_only', rationale: 'The scenario observes product behavior without mutation.', allowedOperations: ['observe'] }, dependencies: [{ id: 'journey-entry-ready', kind: 'journey_entry', applicability: { platforms: ['ios'] }, predicate: { id: 'entry-ready-event', kind: 'eventOccurrence', event: 'journey_completed', authority: { role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.journey_completed', requiredStrength: 'observed', completeness: 'point' } } }] };",
      "const authorityDeclaration = readJson('templates/authority-capabilities.json');",
      "const authorityInspection = asl.inspectScenarioClaimAuthority(authorityScenario, { platform: 'ios' }, [authorityDeclaration]);",
      "assert.equal(authorityInspection.authorityCompatibility, 'compatible');",
      "assert.deepEqual(authorityInspection.checks.map((check) => check.subjectKind), ['claim_assertion', 'dependency_predicate']);",
      "assert.equal(asl.inspectScenarioClaimAuthority(authorityScenario, { platform: 'ios' }, []).authorityCompatibility, 'incompatible');",
      "const mutatingSafetyScenario = JSON.parse(JSON.stringify(authorityScenario));",
      "mutatingSafetyScenario.safety = { class: 'local_mutation', rationale: 'Create and remove one bounded record.', allowedOperations: ['create-test-record'], mutationIdentity: { id: 'test-record', assertionIds: ['completion-event'] }, rollback: { status: 'required', rationale: 'Restore the prior state.', assertionIds: ['completion-event'] }, cleanup: { status: 'not_required', rationale: 'Rollback completes cleanup.' }, reconciliation: { terminalInvariantIds: ['terminal-stable'], assertionIds: ['completion-event'] } };",
      "assert.equal(asl.inspectScenarioClaimSafety(mutatingSafetyScenario, { platform: 'ios' }).safetyContract, 'complete');",
      "mutatingSafetyScenario.safety.mutationIdentity.assertionIds = ['missing-assertion'];",
      "assert.equal(asl.inspectScenarioClaimSafety(mutatingSafetyScenario, { platform: 'ios' }).safetyContract, 'incomplete');",
      "const claimCandidate = { schemaVersion: '1.1.0', scenarioId: authorityScenario.id, runId: 'package-smoke-claim-reduction', healthStatus: 'passed', verdictStatus: 'passed', claimResults: [{ claimId: 'journey-completes', claimHash: asl.buildScenarioClaimHash(authorityScenario.claims[0]), role: 'mandatory', status: 'supported', reasonCode: 'all_assertions_supported', assertionResults: [{ assertionId: 'completion-event', assertionKind: 'eventOccurrence', status: 'supported', reasonCode: 'all_assertions_supported', expected: { event: 'journey_completed' }, observed: { event: 'journey_completed', matchedEvidence: 'profile-event-1' }, evidenceReferences: [{ path: 'raw/profile-events.json' }], rejectedEvidence: [], missingProof: [] }], evidenceReferences: [{ path: 'raw/profile-events.json' }], missingProof: [], nextActionOwner: 'product_optimization', nextAction: 'Retain the evidence.' }] };",
      "const claimReduction = asl.inspectScenarioClaimVerdictReduction(authorityScenario, { platform: 'ios' }, claimCandidate);",
      "assert.equal(claimReduction.reductionStatus, 'reduced');",
      "assert.equal(claimReduction.trust, 'inventory_reduction_only');",
      "assert.equal(claimReduction.reducedVerdictStatus, 'passed');",
      "assert.equal(Object.prototype.hasOwnProperty.call(claimReduction, 'verdict'), false);",
      "const appJson = readJson('examples/mobile-app/app.json');",
      "const aslConfig = readJson('examples/mobile-app/asl.config.json');",
      "assert.equal(aslConfig.app.androidPackage, appJson.expo.android.package);",
      "assert.equal(aslConfig.app.iosBundleId, appJson.expo.ios.bundleIdentifier);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session-command-ordering.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session-command-ordering.d.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session-authoritative-storage.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session-dependency-controller.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session-storage.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session-storage.d.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session.d.ts'), true);",
      "require.resolve('agent-scenario-loop/app/profile-session');",
      "const profileSessionExport = packageJson.exports['./app/profile-session'];",
      "assert.equal(profileSessionExport.types, './app/profile-session.d.ts');",
      "assert.equal(profileSessionExport['react-native'], './app/profile-session.ts');",
      "assert.equal(fs.existsSync(path.join(packageRoot, profileSessionExport['react-native'])), true);",
      "const profileSessionDeclarations = fs.readFileSync('node_modules/agent-scenario-loop/app/profile-session.d.ts', 'utf8');",
      "assert.match(profileSessionDeclarations, /PROFILE_SESSION_STORAGE_KEYS/u);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/core/config-template.json'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/docs/api.md'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/docs/authoring.md'), true);",
      "require.resolve('agent-scenario-loop/runner/agent-device');",
      "require.resolve('agent-scenario-loop/runner/agent-device-driver');",
      "require.resolve('agent-scenario-loop/runner/argent');",
      "require.resolve('agent-scenario-loop/runner/argent-driver');",
      "require.resolve('agent-scenario-loop/runner/ios-simctl-driver');",
      "require.resolve('agent-scenario-loop/runner/live-proof');",
      "const resourceLease = require('agent-scenario-loop/runner/resource-lease');",
      "assert.equal(resourceLease.buildMobileTargetResourceId({ platform: 'android', targetId: 'emulator-5554' }), 'mobile-target:android:emulator-5554');",
      "assert.equal(resourceLease.buildProviderResourceId({ providerId: 'native-profiler', targetId: 'emulator-5554' }), 'provider:native-profiler:emulator-5554');",
      "assert.equal(resourceLease.buildTcpPortResourceId({ host: 'LOCALHOST', port: 8081 }), 'tcp-port:localhost:8081');",
      "require.resolve('agent-scenario-loop/runner/validate-project');",
    ].join('\n');
    run(process.execPath, ['-e', resolveSmokeScript], {
      cwd: installDir,
      env,
    });

    const typeSmokeSource = [
      "import {",
      "  ARTIFACT_LAYOUT_VERSION,",
      "  CLAIM_ADMISSION_INSPECTION_VERSION,",
      "  CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION,",
      "  CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION,",
      "  CLAIM_EVIDENCE_RUN_IDENTITY_VERSION,",
      "  CLAIM_RAW_OBSERVATION_ADMISSION_VERSION,",
      "  CLAIM_RAW_OBSERVATION_SCHEMA_VERSION,",
      "  CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION,",
      "  CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION,",
      "  CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION,",
      "  CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION,",
      "  CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION,",
      "  DRIVER_PORT,",
      "  SCHEMAS,",
      "  buildAgentSummaryMarkdown,",
      "  buildComparisonArtifact,",
      "  buildScenarioClaimHash,",
      "  buildScenarioClaimCompleteContractHash,",
      "  buildScenarioClaimEvidenceRunIdentityHash,",
      "  inspectScenarioClaimAdmission,",
      "  inspectScenarioClaimEvidenceCandidateIdentity,",
      "  inspectScenarioClaimRawObservationAdmission,",
      "  inspectScenarioClaimValidatedEvidenceAdmission,",
      "  inspectScenarioClaimValidatedEvidenceResultAdmission,",
      "  inspectScenarioClaimValidatedEvidenceReportIdentity,",
      "  inspectScenarioClaimJsonNativePointInterpretation,",
      "  inspectScenarioClaimJsonNativeWindowedInterpretation,",
      "  InvalidScenarioClaimEvidenceRunIdentityError,",
      "  buildScenarioExecutionPlan,",
      "  inspectScenarioClaimClosure,",
      "  inspectScenarioClaimDependencies,",
      "  inspectScenarioClaimAuthority,",
      "  inspectScenarioClaimSafety,",
      "  inspectScenarioClaimVerdictReduction,",
      "  buildClaimCompleteVerdict,",
      "  inspectScenarioClaimApproval,",
      "  inspectScenarioClaimAuthorization,",
      "  createArtifactLayout,",
      "  collectScenarioDriverActions,",
      "  dispatchDriverAction,",
      "  buildRunIndex,",
      "  findLatestTrustedRun,",
      "  validateJson,",
      "  validateHistoricalEvaluationArtifact,",
      "  validatePortImplementation,",
      "  validateScenarioAdapterOptions,",
      "  type ArtifactLayout,",
      "  type ArtifactKind,",
      "  type ArtifactWriterPort,",
      "  type DriverActionName,",
      "  type DriverPort,",
      "  type EvidenceProviderPort,",
      "  type InterpreterPort,",
      "  type HistoricalEvaluationArtifact,",
      "  type ScenarioClaimRawObservationAdmissionInspection,",
      "  type ScenarioClaimRawObservationAdmitted,",
      "  type ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted,",
      "  type ScenarioClaimValidatedEvidenceAdmissionResult,",
      "  type ScenarioClaimValidatedEvidenceResultAdmissionAdmitted,",
      "  type ScenarioClaimValidatedEvidenceResultAdmissionResult,",
      "  type ScenarioClaimValidatedEvidenceReportIdentityInspection,",
      "  type ScenarioClaimJsonNativePointInterpretationInspection,",
      "  type ScenarioClaimJsonNativePointInterpreted,",
      "  type ScenarioClaimJsonNativePointInterpretationOutsideContract,",
      "  type ScenarioClaimJsonNativeWindowedInterpretationInspection,",
      "  type ScenarioClaimJsonNativeWindowedInterpreted,",
      "  type ScenarioClaimJsonNativeWindowedInterpretationOutsideContract,",
      "  type BoundedCountResult,",
      "  type AbsenceResult,",
      "  type EventOccurrenceResult,",
      "  type EventOrderResult,",
      "  type TerminalStateResult,",
      "  type ValidatedHistoricalEvaluationArtifact,",
      "  type PortResult,",
      "  type PortValidationResult,",
      "  type PrimaryRunnerPort,",
      "  type QuickProofSourceIdentity,",
      "  type ClaimAssertionResult,",
      "  type ClaimResult,",
      "  type ScenarioClaimAssertion,",
      "  type ScenarioClaimDefinition,",
      "  type ScenarioClaimDependency,",
      "  type ScenarioClaimAdmissionInput,",
      "  type ScenarioClaimAdmissionAdmitted,",
      "  type ScenarioClaimAdmissionBlocked,",
      "  type ScenarioClaimAdmissionGate,",
      "  type ScenarioClaimAdmissionInspection,",
      "  type ScenarioClaimAdmissionOutsideContract,",
      "  type ScenarioClaimAdmissionSelection,",
      "  type ScenarioClaimEligibleEvidenceCandidate,",
      "  type ScenarioClaimEvidenceCandidate,",
      "  type ScenarioClaimEvidenceCandidateBlocked,",
      "  type ScenarioClaimEvidenceCandidateEligible,",
      "  type ScenarioClaimEvidenceCandidateIdentityInspection,",
      "  type ScenarioClaimEvidenceCandidateOutsideContract,",
      "  type ScenarioClaimEvidenceRunIdentity,",
      "  type ScenarioClaimDependencyInspection,",
      "  type ScenarioClaimClosureInspection,",
      "  type AuthorityCapabilities,",
      "  type ScenarioClaimAuthorityInspection,",
      "  type ScenarioClaimSafetyInspection,",
      "  type ScenarioClaimVerdictReductionInspection,",
      "  type ClaimCompleteVerdictInput,",
      "  type ClaimCompleteVerdictCandidate,",
      "  type PreRuntimeClaimSelection,",
      "  type ScenarioClaimApprovalInspection,",
      "  type ScenarioClaimApprovalRecord,",
      "  type ScenarioClaimAuthorizationGrant,",
      "  type ScenarioClaimAuthorizationInspection,",
      "  type ScenarioClaimAuthorizationRequest,",
      "  type ScenarioSafetyDeclaration,",
      "  type ValidatedEvidenceAssertion,",
      "  assembleCiEvidencePack,",
      "  verifyCiEvidencePackLiveProofSet,",
      "  type CiEvidencePackAssemblyOptions,",
      "  type VerifiedCiEvidencePackLiveProofSet,",
      "  buildCiEvidencePublicationReceipt,",
      "  readCiEvidencePublicationReceipt,",
      "  assertCiEvidencePublicationReceiptForPack,",
      "  assertCiEvidencePublicationReceiptForExactPackBytes,",
      "  renderCiEvidencePublicationSummary,",
      "  evaluateCiEvidencePublicationSummary,",
      "  CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION,",
      "  CiEvidencePublicationReceiptError,",
      "  type CiEvidencePublicationReceipt,",
      "  type CiEvidencePublicationAudience,",
      "  type CiEvidencePublicationSummaryEvaluationOptions,",
      "  type CiEvidencePublicationStatus,",
      "} from 'agent-scenario-loop';",
      "import { resolveAgentDeviceDriverSteps, runAgentDeviceCapture } from 'agent-scenario-loop/runner/agent-device';",
      "import { resolveArgentDriverSteps, runArgentCapture } from 'agent-scenario-loop/runner/argent';",
      "import { buildAndroidScrollCoordinatesFromBounds, createAndroidAdbDriver, resolveAndroidSelectorFromUiTree } from 'agent-scenario-loop/runner/android-adb-driver';",
      "import { createAgentDeviceDriver, formatAgentDeviceSelector } from 'agent-scenario-loop/runner/agent-device-driver';",
      "import { createArgentDriver, normalizeArgentPoint } from 'agent-scenario-loop/runner/argent-driver';",
      "import { createIosSimctlDriver } from 'agent-scenario-loop/runner/ios-simctl-driver';",
      "import { runExampleAndroidLiveProof } from 'agent-scenario-loop/runner/example-android-live';",
      "import { runExampleIosLiveProof } from 'agent-scenario-loop/runner/example-ios-live';",
      "import { initProject } from 'agent-scenario-loop/runner/init-project';",
      "import { compareLatestTrustedRun } from 'agent-scenario-loop/runner/compare-latest';",
      "import { runIosSimctlCapture } from 'agent-scenario-loop/runner/ios-simctl';",
      "import { readLiveProof } from 'agent-scenario-loop/runner/live-proof';",
      "import { resolveAndroidAdbDriverSteps, resolveAndroidAdbProfileCommands, runProfileAndroid } from 'agent-scenario-loop/runner/profile-android';",
      "import { runProfileIos, type CliArgs } from 'agent-scenario-loop/runner/profile-ios';",
      "import { acquireResourceLease, buildMobileTargetResourceId, buildProviderResourceId, buildTcpPortResourceId, releaseResourceLease, resolveResourceLeasePath, type ResourceLeaseAcquireResult } from 'agent-scenario-loop/runner/resource-lease';",
      "import { validateProject } from 'agent-scenario-loop/runner/validate-project';",
      "import {",
      "  emitProfileEvent,",
      "  PROFILE_SESSION_STORAGE_KEYS,",
      "  storeProfileSignal,",
      "  useProfileSession,",
      "  type ProfileEventMetadata,",
      "  type ProfileSessionCommand,",
      "  type ProfileSessionState,",
      "} from 'agent-scenario-loop/app/profile-session';",
      '',
      "const ciEvidencePackAssemblyOptions: CiEvidencePackAssemblyOptions = { artifactRoot: 'run' };",
      "const assembleCiEvidencePackFn: typeof assembleCiEvidencePack = assembleCiEvidencePack;",
      "const verifyCiEvidencePackLiveProofSetFn: typeof verifyCiEvidencePackLiveProofSet = verifyCiEvidencePackLiveProofSet;",
      "type VerifiedLiveProofSetRef = VerifiedCiEvidencePackLiveProofSet;",
      "const buildCiEvidencePublicationReceiptFn: typeof buildCiEvidencePublicationReceipt = buildCiEvidencePublicationReceipt;",
      "const readCiEvidencePublicationReceiptFn: (receiptPath: string, packBytes: Uint8Array) => CiEvidencePublicationReceipt = readCiEvidencePublicationReceipt;",
      "const assertCiEvidencePublicationReceiptForPackFn: typeof assertCiEvidencePublicationReceiptForPack = assertCiEvidencePublicationReceiptForPack;",
      "const assertCiEvidencePublicationReceiptForExactPackBytesFn: typeof assertCiEvidencePublicationReceiptForExactPackBytes = assertCiEvidencePublicationReceiptForExactPackBytes;",
      "const renderCiEvidencePublicationSummaryFn: typeof renderCiEvidencePublicationSummary = renderCiEvidencePublicationSummary;",
      "const evaluateCiEvidencePublicationSummaryFn: typeof evaluateCiEvidencePublicationSummary = evaluateCiEvidencePublicationSummary;",
      "const publicAudienceOptions: CiEvidencePublicationSummaryEvaluationOptions = { audience: 'public' };",
      "const authenticatedReviewerOptions: CiEvidencePublicationSummaryEvaluationOptions = { audience: 'authenticated_reviewer' };",
      "const unusedPublicationAudience: CiEvidencePublicationAudience = 'public';",
      "// @ts-expect-error unknown publication audience is not part of the closed vocabulary",
      "const invalidPublicationAudience: CiEvidencePublicationAudience = 'github';",
      "const publicationReceiptSchemaVersion: typeof CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION = CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION;",
      "const publicationReceiptErrorCtor: typeof CiEvidencePublicationReceiptError = CiEvidencePublicationReceiptError;",
      "const publicationReceiptSchemaEntry: typeof SCHEMAS.ciEvidencePublicationReceipt = SCHEMAS.ciEvidencePublicationReceipt;",
      "type PublicationReceiptRef = CiEvidencePublicationReceipt;",
      "type PublicationStatusRef = CiEvidencePublicationStatus;",
      "const unusedPublicationStatusValue: PublicationStatusRef = 'published';",
      "void ciEvidencePackAssemblyOptions; void assembleCiEvidencePackFn; void verifyCiEvidencePackLiveProofSetFn;",
      "void buildCiEvidencePublicationReceiptFn; void readCiEvidencePublicationReceiptFn; void assertCiEvidencePublicationReceiptForPackFn; void assertCiEvidencePublicationReceiptForExactPackBytesFn; void renderCiEvidencePublicationSummaryFn; void evaluateCiEvidencePublicationSummaryFn; void publicAudienceOptions; void authenticatedReviewerOptions; void unusedPublicationAudience; void invalidPublicationAudience;",
      "void publicationReceiptSchemaVersion; void publicationReceiptErrorCtor; void publicationReceiptSchemaEntry; void unusedPublicationStatusValue;",
      "const unusedVerifiedLiveProofSet: VerifiedLiveProofSetRef | undefined = undefined;",
      "const unusedPublicationReceipt: PublicationReceiptRef | undefined = undefined;",
      "const unusedPublicationStatus: PublicationStatusRef | undefined = undefined;",
      "void unusedVerifiedLiveProofSet; void unusedPublicationReceipt; void unusedPublicationStatus;",
      "const layout: ArtifactLayout = createArtifactLayout({ outputDir: 'run' });",
      "const claimDefinition: ScenarioClaimDefinition = {",
      "  id: 'journey-completes', role: 'mandatory', applicability: { platforms: ['ios'] },",
      "  closes: { phases: ['complete-journey'] },",
      "  assertions: [{ id: 'completion-event', kind: 'eventOccurrence', event: 'journey_completed', authority: { role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.journey_completed', requiredStrength: 'observed', completeness: 'point' } }],",
      "};",
      "const claimHash: string = buildScenarioClaimHash(claimDefinition);",
      "const scenarioDependency: ScenarioClaimDependency = { id: 'entry-ready', kind: 'journey_entry', applicability: { platforms: ['ios'] }, predicate: { id: 'entry-event', kind: 'eventOccurrence', event: 'entry_ready', authority: { role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.entry_ready', requiredStrength: 'observed', completeness: 'point' } } };",
      "const dependencyInspection: ScenarioClaimDependencyInspection = inspectScenarioClaimDependencies({ schemaVersion: '1.0.0' }, { platform: 'ios' });",
      "void scenarioDependency; void dependencyInspection;",
      "// @ts-expect-error journey-entry dependencies cannot claim ownership of claim IDs.",
      "const invalidJourneyDependency: ScenarioClaimDependency = { ...scenarioDependency, claimIds: ['claim'] };",
      "// @ts-expect-error claim-scoped dependencies require at least one claim ID.",
      "const invalidClaimDependency: ScenarioClaimDependency = { id: 'claim-entry', kind: 'claim_scoped', applicability: { platforms: ['ios'] }, predicate: scenarioDependency.predicate };",
      "void invalidJourneyDependency; void invalidClaimDependency;",
      "const scenarioApprovalRecord: ScenarioClaimApprovalRecord = { schemaVersion: '1.0.0', approvalId: 'approval', scenarioId: 'scenario', scenarioHash: 'a'.repeat(64), selection: { platform: 'ios' }, decision: 'approved', approvedAt: '2026-08-21T12:00:00Z', approverRef: 'local-review' };",
      "const scenarioApprovalInspection: ScenarioClaimApprovalInspection = inspectScenarioClaimApproval({ schemaVersion: '1.0.0' }, { platform: 'ios' }, scenarioApprovalRecord);",
      "void scenarioApprovalInspection;",
      "// @ts-expect-error approval decisions use the closed approved vocabulary.",
      "const invalidApprovalDecision: ScenarioClaimApprovalRecord = { ...scenarioApprovalRecord, decision: 'pending' };",
      "// @ts-expect-error runtime authorization expiry does not belong in human approval records.",
      "const invalidApprovalExpiry: ScenarioClaimApprovalRecord = { schemaVersion: '1.0.0', approvalId: 'approval', scenarioId: 'scenario', scenarioHash: 'a'.repeat(64), selection: { platform: 'ios' }, decision: 'approved', approvedAt: '2026-08-21T12:00:00Z', approverRef: 'local-review', expiresAt: '2026-08-22T12:00:00Z' };",
      "void invalidApprovalDecision; void invalidApprovalExpiry;",
      "const scenarioAuthorizationGrant: ScenarioClaimAuthorizationGrant = { schemaVersion: '1.0.0', grantId: 'grant', scenarioId: 'scenario', scenarioHash: 'a'.repeat(64), selection: { platform: 'ios' }, safetyClass: 'read_only', goalId: 'goal', operations: ['observe'], targetResource: 'mobile-target:ios:device', expiresAt: '2026-08-21T12:00:01.000Z', delegationChain: ['owner'] };",
      "const scenarioAuthorizationRequest: ScenarioClaimAuthorizationRequest = { goalId: 'goal', operations: ['observe'], targetResource: 'mobile-target:ios:device', nowMs: Date.parse('2026-08-21T12:00:00.000Z') };",
      "const scenarioAuthorizationInspection: ScenarioClaimAuthorizationInspection = inspectScenarioClaimAuthorization({ schemaVersion: '1.0.0' }, { platform: 'ios' }, scenarioAuthorizationRequest, scenarioAuthorizationGrant);",
      "void scenarioAuthorizationInspection;",
      "// @ts-expect-error claim authorization requires a target resource.",
      "const invalidAuthorizationTarget: ScenarioClaimAuthorizationGrant = { schemaVersion: '1.0.0', grantId: 'grant', scenarioId: 'scenario', scenarioHash: 'a'.repeat(64), selection: { platform: 'ios' }, safetyClass: 'read_only', goalId: 'goal', operations: ['observe'], expiresAt: '2026-08-21T12:00:01.000Z', delegationChain: ['owner'] };",
      "// @ts-expect-error read-only authorization cannot declare mutation identity.",
      "const invalidReadOnlyAuthorization: ScenarioClaimAuthorizationGrant = { ...scenarioAuthorizationGrant, mutationIdentityId: 'mutation' };",
      "// @ts-expect-error mutating authorization requires mutation identity.",
      "const invalidMutatingAuthorization: ScenarioClaimAuthorizationGrant = { ...scenarioAuthorizationGrant, safetyClass: 'local_mutation' };",
      "// @ts-expect-error compatibility uses the closed reader vocabulary.",
      "const invalidAuthorizationInspection: ScenarioClaimAuthorizationInspection = { contractVersion: '1.0.0', authorizationCompatibility: 'authorized', checks: [], blockingReasons: [], nextAction: 'authorization_inspection_complete' };",
      "void invalidAuthorizationTarget; void invalidReadOnlyAuthorization; void invalidMutatingAuthorization; void invalidAuthorizationInspection;",
      "const claimCompleteHashBuilder: (scenario: unknown) => string = buildScenarioClaimCompleteContractHash;",
      "void claimCompleteHashBuilder;",
      "const supportedAssertionResult: ClaimAssertionResult = { assertionId: 'completion-event', assertionKind: 'eventOccurrence', status: 'supported', reasonCode: 'all_assertions_supported', expected: { event: 'journey_completed' }, observed: { event: 'journey_completed', matchedEvidence: 'profile-event-1' }, evidenceReferences: [{ path: 'raw/profile-events.json' }], rejectedEvidence: [], missingProof: [] };",
      "const notEvaluableWithRejectedCandidate: ClaimAssertionResult = { assertionId: 'video-evidence', assertionKind: 'validatedEvidence', status: 'not_evaluable', reasonCode: 'identity_mismatch', expected: { artifactKind: 'video', validationContract: 'media-v1' }, observed: null, evidenceReferences: [], rejectedEvidence: ['candidate identity mismatch'], missingProof: ['verified artifact identity'] };",
      "const claimClosureInspection: ScenarioClaimClosureInspection = inspectScenarioClaimClosure({ schemaVersion: '1.0.0' }, { platform: 'ios' });",
      "const authorityCapabilities: AuthorityCapabilities = { schemaVersion: '1.0.0', declarationId: 'app-profile-authority', role: 'app', producerId: 'app-profile-session', platforms: ['ios'], assertionKinds: ['eventOccurrence'], evidenceSelectors: ['profileEvents.journey_completed'], maxStrength: 'verified', maxCompleteness: 'continuous-complete' };",
      "const claimAuthorityInspection: ScenarioClaimAuthorityInspection = inspectScenarioClaimAuthority({ schemaVersion: '1.0.0' }, { platform: 'ios' }, [authorityCapabilities]);",
      "const admissionInput: ScenarioClaimAdmissionInput = { scenario: { schemaVersion: '1.0.0' }, selection: { platform: 'ios' }, authorityCatalog: [authorityCapabilities], authorizationRequest: scenarioAuthorizationRequest, authorizationGrant: scenarioAuthorizationGrant, approval: scenarioApprovalRecord };",
      "const claimAdmissionInspection: ScenarioClaimAdmissionInspection = inspectScenarioClaimAdmission(admissionInput);",
      "const admissionSelection: ScenarioClaimAdmissionSelection = { platform: 'ios' };",
      "const admissionGate: ScenarioClaimAdmissionGate = 'authority';",
      "type AdmissionTerminalVariant = ScenarioClaimAdmissionAdmitted | ScenarioClaimAdmissionBlocked | ScenarioClaimAdmissionOutsideContract;",
      "const admissionTerminalVariant: AdmissionTerminalVariant = claimAdmissionInspection;",
      "const admissionInspectionVersion: '1.0.0' = CLAIM_ADMISSION_INSPECTION_VERSION;",
      "void claimAdmissionInspection; void admissionSelection; void admissionGate; void admissionTerminalVariant; void admissionInspectionVersion;",
      "// @ts-expect-error admission uses a closed terminal status vocabulary.",
      "const invalidAdmissionInspection: ScenarioClaimAdmissionInspection = { contractVersion: '1.0.0', status: 'ready' };",
      "void invalidAdmissionInspection;",
      "const evidenceRunIdentity: ScenarioClaimEvidenceRunIdentity = { schemaVersion: '1.0.0', scenarioId: 'scenario', scenarioHash: 'a'.repeat(64), runId: 'run', attemptId: 'attempt', selection: { platform: 'ios' }, source: { gitSha: 'source' }, package: { name: 'agent-scenario-loop', version: '0.1.18', sha256: 'a'.repeat(64) }, target: { resourceId: 'mobile-target:ios:device', deviceId: 'device', runtimeId: 'runtime' }, installedApp: { appId: 'dev.example.app', version: '1', buildId: '1', sha256: 'b'.repeat(64) }, runner: { id: 'runner', version: '1' }, adapter: { id: 'adapter', version: '1' }, transport: { id: 'transport', version: '1' }, appHelper: { payloadId: 'helper', sha256: 'c'.repeat(64) }, environment: { id: 'environment', cohortHash: 'a'.repeat(64) }, producers: [{ role: 'app', producerId: 'app', version: '1', sha256: 'b'.repeat(64) }] };",
      "const evidenceCandidate: ScenarioClaimEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: buildScenarioClaimEvidenceRunIdentityHash(evidenceRunIdentity), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'eventOccurrence', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'private' };",
      "const evidenceIdentityInspection: ScenarioClaimEvidenceCandidateIdentityInspection = inspectScenarioClaimEvidenceCandidateIdentity({ admission: claimAdmissionInspection as ScenarioClaimAdmissionAdmitted, scenario: { schemaVersion: '1.0.0' }, runIdentity: evidenceRunIdentity, claimId: 'claim', assertionId: 'assertion', candidate: evidenceCandidate });",
      "const evidenceIdentityVersion: '1.0.0' = CLAIM_EVIDENCE_RUN_IDENTITY_VERSION;",
      "const evidenceCandidateVersion: '1.0.0' = CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION;",
      "const evidenceInspectionVersion: '1.0.0' = CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION;",
      "const evidenceIdentityError: Error = new InvalidScenarioClaimEvidenceRunIdentityError('invalid');",
      "const eligibleSemanticCandidate: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'eventOccurrence', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'private' };",
      "const eligibleValidatedCandidate: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'validatedEvidence', authority: { declarationId: 'declaration', role: 'comparator', producerId: 'comparator', evidenceSelector: 'captures.video', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'verified', completeness: 'bounded' }, captureStatus: 'produced', evidence: { path: 'captures/video.mp4', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'not-redacted', artifactKind: 'video', validationContract: 'video-structure-v1' };",
      "const eligibleWindowedCandidate: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'boundedCount', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'verified', completeness: 'bounded' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'not_required', redactionStatus: 'not-redacted', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } };",
      "const rawObservationInspection: ScenarioClaimRawObservationAdmissionInspection = inspectScenarioClaimRawObservationAdmission({ candidate: eligibleSemanticCandidate, artifactBytes: new Uint8Array() });",
      "const rawObservationAdmitted: ScenarioClaimRawObservationAdmitted = { contractVersion: '1.0.0', status: 'admitted', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'eventOccurrence', artifact: { path: 'raw/events.json', sha256: 'c'.repeat(64), byteLength: 0 }, observation: { schemaVersion: '1.0.0', kind: 'eventOccurrence', occurrences: [] } };",
      "const rawObservationAdmissionVersion: '1.0.0' = CLAIM_RAW_OBSERVATION_ADMISSION_VERSION;",
      "const rawObservationSchemaVersion: '1.0.0' = CLAIM_RAW_OBSERVATION_SCHEMA_VERSION;",
      "void evidenceIdentityInspection; void evidenceIdentityVersion; void evidenceCandidateVersion; void evidenceInspectionVersion; void evidenceIdentityError;",
      "void eligibleSemanticCandidate; void eligibleValidatedCandidate; void eligibleWindowedCandidate; void rawObservationInspection; void rawObservationAdmitted; void rawObservationAdmissionVersion; void rawObservationSchemaVersion;",
      "// @ts-expect-error runtime raw-observation status cannot use pre-runtime not_applicable.",
      "const invalidRawObservationStatus: ScenarioClaimRawObservationAdmissionInspection = { contractVersion: '1.0.0', status: 'not_applicable' };",
      "void invalidRawObservationStatus;",
      "const validatedEvidenceReportIdentityInspection: ScenarioClaimValidatedEvidenceReportIdentityInspection = inspectScenarioClaimValidatedEvidenceReportIdentity({ candidate: eligibleValidatedCandidate, report: { path: 'raw/validator-report.bin', sha256: 'd'.repeat(64) }, reportBytes: new Uint8Array() });",
      "const validatedEvidenceAdmissionResult: ScenarioClaimValidatedEvidenceAdmissionResult = inspectScenarioClaimValidatedEvidenceAdmission({ candidate: eligibleValidatedCandidate, subjectBytes: new Uint8Array(), report: { path: 'raw/validator-report.bin', sha256: 'd'.repeat(64) }, reportBytes: new Uint8Array() });",
      "const validatedEvidenceIdentityAdmitted: ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted = { status: 'identity_admitted', contractVersion: '1.0.0', reasonCodes: [], nextAction: 'evaluate_validated_evidence_report', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'validatedEvidence', artifactKind: 'video', validationContract: 'video-structure-v1', subjectArtifact: { path: 'captures/video.mp4', sha256: 'c'.repeat(64), byteLength: 0 }, reportArtifact: { path: 'raw/validator-report.bin', sha256: 'd'.repeat(64), byteLength: 0 } };",
      "const validatedEvidenceResultAdmissionCall: ScenarioClaimValidatedEvidenceResultAdmissionResult = inspectScenarioClaimValidatedEvidenceResultAdmission({ validatedEvidence: validatedEvidenceIdentityAdmitted, result: { path: 'raw/validator-result.json', sha256: 'f'.repeat(64) }, resultBytes: new Uint8Array() });",
      "const validatedEvidenceResultAdmissionAdmitted: ScenarioClaimValidatedEvidenceResultAdmissionAdmitted = { contractVersion: '1.0.0', status: 'admitted', reasonCodes: [], nextAction: 'treat_validator_result_as_identity_evidence_only', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'validatedEvidence', artifactKind: 'video', validationContract: 'video-structure-v1', resultId: 'result', validator: { producerId: 'media-validator', producerVersion: '1.0.0', producerSha256: 'e'.repeat(64) }, subject: { path: 'captures/video.mp4', sha256: 'c'.repeat(64) }, report: { path: 'raw/validator-report.bin', sha256: 'd'.repeat(64) }, validatorResultStatus: 'passed', validatorReasonCode: 'validation_passed', evidenceReferences: [{ path: 'raw/validator-result.json', sha256: 'f'.repeat(64) }], subjectArtifact: { path: 'captures/video.mp4', sha256: 'c'.repeat(64), byteLength: 0 }, reportArtifact: { path: 'raw/validator-report.bin', sha256: 'd'.repeat(64), byteLength: 0 }, resultArtifact: { path: 'raw/validator-result.json', sha256: 'f'.repeat(64), byteLength: 0 } };",
      "const validatedEvidenceReportIdentityVersion: '1.0.0' = CLAIM_VALIDATED_EVIDENCE_REPORT_IDENTITY_VERSION;",
      "const validatedEvidenceAdmissionVersion: '1.0.0' = CLAIM_VALIDATED_EVIDENCE_ADMISSION_VERSION;",
      "const validatedEvidenceResultAdmissionVersion: '1.0.0' = CLAIM_VALIDATED_EVIDENCE_RESULT_ADMISSION_VERSION;",
      "void validatedEvidenceReportIdentityInspection; void validatedEvidenceAdmissionResult; void validatedEvidenceIdentityAdmitted; void validatedEvidenceResultAdmissionCall; void validatedEvidenceResultAdmissionAdmitted; void validatedEvidenceReportIdentityVersion; void validatedEvidenceAdmissionVersion; void validatedEvidenceResultAdmissionVersion;",
      "const pointInterpretationInspection: ScenarioClaimJsonNativePointInterpretationInspection = inspectScenarioClaimJsonNativePointInterpretation({ id: 'assertion', kind: 'eventOccurrence', event: 'app_first_usable_screen', authority: { role: 'app', producerId: 'app', evidenceSelector: 'events', requiredStrength: 'observed', completeness: 'point' } }, rawObservationAdmitted);",
      "const pointInterpretationVersion: '1.0.0' = CLAIM_JSON_NATIVE_POINT_INTERPRETATION_VERSION;",
      "const supportedEventOccurrence: EventOccurrenceResult = { assertionId: 'assertion', assertionKind: 'eventOccurrence', expected: { event: 'app_first_usable_screen' }, status: 'supported', reasonCode: 'all_assertions_supported', observed: { event: 'app_first_usable_screen', matchedEvidence: 'raw/events.json' }, evidenceReferences: [{ path: 'raw/events.json', sha256: 'c'.repeat(64) }], rejectedEvidence: [], missingProof: [] };",
      "const supportedEventOrder: EventOrderResult = { assertionId: 'order-assertion', assertionKind: 'eventOrder', expected: { beforeEvent: 'app_first_usable_screen', afterEvent: 'journey_completed' }, status: 'supported', reasonCode: 'all_assertions_supported', observed: { beforeEvidence: 'raw/events.json', afterEvidence: 'raw/events.json', relation: 'before' }, evidenceReferences: [{ path: 'raw/events.json', sha256: 'c'.repeat(64) }], rejectedEvidence: [], missingProof: [] };",
      "const supportedTerminalState: TerminalStateResult = { assertionId: 'terminal-assertion', assertionKind: 'terminalState', expected: { path: 'app.state', value: 'complete' }, status: 'supported', reasonCode: 'all_assertions_supported', observed: { path: 'app.state', value: 'complete' }, evidenceReferences: [{ path: 'raw/events.json', sha256: 'c'.repeat(64) }], rejectedEvidence: [], missingProof: [] };",
      "const pointInterpreted: ScenarioClaimJsonNativePointInterpreted = { contractVersion: '1.0.0', status: 'interpreted', trust: 'admitted_observation_interpretation_only', result: supportedEventOccurrence };",
      "const pointOutsideContract: ScenarioClaimJsonNativePointInterpretationOutsideContract = { contractVersion: '1.0.0', status: 'outside_contract', trust: 'admitted_observation_interpretation_only', reasonCodes: ['input_invalid'] };",
      "void pointInterpretationInspection; void pointInterpretationVersion; void pointInterpreted; void supportedEventOccurrence; void supportedEventOrder; void supportedTerminalState; void pointOutsideContract;",
      "// @ts-expect-error runtime point interpretation cannot use not_applicable.",
      "const invalidPointInterpretationStatus: ScenarioClaimJsonNativePointInterpretationInspection = { contractVersion: '1.0.0', status: 'not_applicable', trust: 'admitted_observation_interpretation_only', reasonCodes: ['input_invalid'] };",
      "void invalidPointInterpretationStatus;",
      "const windowedAdmitted: ScenarioClaimRawObservationAdmitted = { contractVersion: '1.0.0', status: 'admitted', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'boundedCount', artifact: { path: 'raw/events.json', sha256: 'c'.repeat(64), byteLength: 0 }, observation: { schemaVersion: '1.0.0', kind: 'boundedCount', selector: 'events', count: 0, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } } };",
      "const windowedInterpretationInspection: ScenarioClaimJsonNativeWindowedInterpretationInspection = inspectScenarioClaimJsonNativeWindowedInterpretation({ id: 'assertion', kind: 'boundedCount', selector: 'events', minimum: 0, maximum: 1, authority: { role: 'app', producerId: 'app', evidenceSelector: 'events', requiredStrength: 'verified', completeness: 'bounded' }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, windowedAdmitted);",
      "const windowedInterpretationVersion: '1.0.0' = CLAIM_JSON_NATIVE_WINDOWED_INTERPRETATION_VERSION;",
      "const supportedBoundedCount: BoundedCountResult = { assertionId: 'assertion', assertionKind: 'boundedCount', expected: { selector: 'events', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true }, minimum: 0, maximum: 1 }, status: 'supported', reasonCode: 'all_assertions_supported', observed: { selector: 'events', count: 0 }, evidenceReferences: [{ path: 'raw/events.json', sha256: 'c'.repeat(64) }], rejectedEvidence: [], missingProof: [] };",
      "const supportedAbsence: AbsenceResult = { assertionId: 'absence-assertion', assertionKind: 'absence', expected: { selector: 'error_event', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, status: 'supported', reasonCode: 'all_assertions_supported', observed: { selector: 'error_event', count: 0 }, evidenceReferences: [{ path: 'raw/events.json', sha256: 'c'.repeat(64) }], rejectedEvidence: [], missingProof: [] };",
      "const absenceAdmitted: ScenarioClaimRawObservationAdmitted = { contractVersion: '1.0.0', status: 'admitted', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'absence-assertion', assertionKind: 'absence', artifact: { path: 'raw/events.json', sha256: 'c'.repeat(64), byteLength: 0 }, observation: { schemaVersion: '1.0.0', kind: 'absence', selector: 'error_event', count: 0, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } } };",
      "const absenceInterpretationInspection: ScenarioClaimJsonNativeWindowedInterpretationInspection = inspectScenarioClaimJsonNativeWindowedInterpretation({ id: 'absence-assertion', kind: 'absence', selector: 'error_event', authority: { role: 'app', producerId: 'app', evidenceSelector: 'error_event', requiredStrength: 'verified', completeness: 'continuous-complete' }, observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, absenceAdmitted);",
      "const windowedInterpreted: ScenarioClaimJsonNativeWindowedInterpreted = { contractVersion: '1.0.0', status: 'interpreted', trust: 'admitted_observation_interpretation_only', result: supportedBoundedCount };",
      "const windowedOutsideContract: ScenarioClaimJsonNativeWindowedInterpretationOutsideContract = { contractVersion: '1.0.0', status: 'outside_contract', trust: 'admitted_observation_interpretation_only', reasonCodes: ['input_invalid'] };",
      "void windowedInterpretationInspection; void windowedInterpretationVersion; void windowedInterpreted; void supportedBoundedCount; void supportedAbsence; void absenceAdmitted; void absenceInterpretationInspection; void windowedOutsideContract;",
      "// @ts-expect-error runtime windowed interpretation cannot use not_applicable.",
      "const invalidWindowedInterpretationStatus: ScenarioClaimJsonNativeWindowedInterpretationInspection = { contractVersion: '1.0.0', status: 'not_applicable', trust: 'admitted_observation_interpretation_only', reasonCodes: ['input_invalid'] };",
      "void invalidWindowedInterpretationStatus;",

      "// @ts-expect-error runtime admission statuses cannot use not_applicable.",
      "const invalidValidatedEvidenceAdmissionStatus: ScenarioClaimValidatedEvidenceAdmissionResult = { status: 'not_applicable', contractVersion: '1.0.0', reasonCodes: [], nextAction: 'evaluate_validated_evidence_report' };",
      "void invalidValidatedEvidenceAdmissionStatus;",
      "// @ts-expect-error runtime result-admission status cannot be not_applicable.",
      "const invalidValidatedEvidenceResultAdmissionStatus: ScenarioClaimValidatedEvidenceResultAdmissionResult = { status: 'not_applicable', contractVersion: '1.0.0', reasonCodes: [], nextAction: 'treat_validator_result_as_identity_evidence_only' };",
      "void invalidValidatedEvidenceResultAdmissionStatus;",
      "// @ts-expect-error identity_admitted cannot omit required subject/report artifacts.",
      "const invalidIdentityAdmittedMissingArtifacts: ScenarioClaimValidatedEvidenceAdmissionIdentityAdmitted = { status: 'identity_admitted', contractVersion: '1.0.0', reasonCodes: [], nextAction: 'evaluate_validated_evidence_report', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'validatedEvidence', artifactKind: 'video', validationContract: 'video-structure-v1' };",
      "void invalidIdentityAdmittedMissingArtifacts;",
      "// @ts-expect-error semantic eligible candidates cannot carry artifact validation fields.",
      "const invalidSemanticEligibleArtifact: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'eventOccurrence', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'private', artifactKind: 'video', validationContract: 'video-structure-v1' };",
      "// @ts-expect-error semantic eligible candidates cannot carry observation windows.",
      "const invalidSemanticEligibleWindow: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'eventOrder', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'private', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } };",
      "// @ts-expect-error validated eligible candidates cannot carry observation windows.",
      "const invalidValidatedEligibleWindow: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'validatedEvidence', authority: { declarationId: 'declaration', role: 'comparator', producerId: 'comparator', evidenceSelector: 'captures.video', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'verified', completeness: 'bounded' }, captureStatus: 'produced', evidence: { path: 'captures/video.mp4', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'not-redacted', artifactKind: 'video', validationContract: 'video-structure-v1', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } };",
      "// @ts-expect-error windowed eligible candidates cannot carry artifact validation fields.",
      "const invalidWindowedEligibleArtifact: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'absence', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'verified', completeness: 'continuous-complete' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'not-redacted', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true }, artifactKind: 'logs', validationContract: 'logs-v1' };",
      "// @ts-expect-error eligible projection requires produced capture.",
      "const invalidEligibleCapture: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'eventOccurrence', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'partial', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'finalized', redactionStatus: 'private' };",
      "// @ts-expect-error eligible projection cannot retain incomplete cleanup.",
      "const invalidEligibleCleanup: ScenarioClaimEligibleEvidenceCandidate = { schemaVersion: '1.0.0', candidateId: 'candidate', runIdentityHash: 'a'.repeat(64), claimId: 'claim', claimHash: 'a'.repeat(64), assertionId: 'assertion', assertionKind: 'terminalState', authority: { declarationId: 'declaration', role: 'app', producerId: 'app', evidenceSelector: 'events', producerVersion: '1', producerSha256: 'b'.repeat(64), strength: 'observed', completeness: 'point' }, captureStatus: 'produced', evidence: { path: 'raw/events.json', sha256: 'c'.repeat(64) }, cleanupStatus: 'incomplete', redactionStatus: 'private' };",
      "const eligibleInspectionBase = { contractVersion: '1.0.0' as const, scenarioSchemaVersion: '1.1.0' as const, selection: { platform: 'ios' as const }, scenarioHash: 'a'.repeat(64), runIdentityHash: 'a'.repeat(64), candidateId: 'candidate', claimId: 'claim', assertionId: 'assertion', gateSummaries: [{ gate: 'run_identity' as const, status: 'matched' as const, reasonCodes: [] }, { gate: 'assertion_identity' as const, status: 'matched' as const, reasonCodes: [] }, { gate: 'authority_binding' as const, status: 'matched' as const, reasonCodes: [] }, { gate: 'evidence_binding' as const, status: 'matched' as const, reasonCodes: [] }, { gate: 'lifecycle' as const, status: 'matched' as const, reasonCodes: [] }] as ScenarioClaimEvidenceCandidateEligible['gateSummaries'] };",
      "const eligibleInspection: ScenarioClaimEvidenceCandidateEligible = { ...eligibleInspectionBase, status: 'eligible', blockingGates: [], eligibleCandidate: eligibleSemanticCandidate };",
      "// @ts-expect-error eligible inspections require the detached candidate projection.",
      "const invalidEligibleMissingProjection: ScenarioClaimEvidenceCandidateEligible = { ...eligibleInspectionBase, status: 'eligible', blockingGates: [] };",
      "// @ts-expect-error blocked inspections cannot expose an eligible candidate projection.",
      "const invalidBlockedEligible: ScenarioClaimEvidenceCandidateBlocked = { ...eligibleInspectionBase, status: 'blocked', firstBlockingGate: 'run_identity', blockingGates: ['run_identity'], nextAction: 'repair_run_identity_binding', eligibleCandidate: eligibleSemanticCandidate };",
      "// @ts-expect-error outside-contract inspections cannot expose an eligible candidate projection.",
      "const invalidOutsideEligible: ScenarioClaimEvidenceCandidateOutsideContract = { contractVersion: '1.0.0', status: 'outside_contract', reasonCodes: ['admission_not_admitted'], nextAction: 'supply_admitted_scenario', eligibleCandidate: eligibleSemanticCandidate };",
      "void invalidSemanticEligibleArtifact; void invalidSemanticEligibleWindow; void invalidValidatedEligibleWindow; void invalidWindowedEligibleArtifact;",
      "void invalidEligibleCapture; void invalidEligibleCleanup; void eligibleInspection; void invalidEligibleMissingProjection; void invalidBlockedEligible; void invalidOutsideEligible;",
      "const scenarioSafety: ScenarioSafetyDeclaration = { class: 'read_only', rationale: 'Observe without mutation.', allowedOperations: ['observe'] };",
      "const claimSafetyInspection: ScenarioClaimSafetyInspection = inspectScenarioClaimSafety({ schemaVersion: '1.0.0' }, { platform: 'ios' });",
      "const claimReductionInspection: ScenarioClaimVerdictReductionInspection = inspectScenarioClaimVerdictReduction({ schemaVersion: '1.0.0' }, { platform: 'ios' }, { schemaVersion: '1.0.0' });",
      "const supportedClaimResult: ClaimResult = { claimId: 'journey-completes', claimHash, role: 'mandatory', status: 'supported', reasonCode: 'all_assertions_supported', assertionResults: [supportedAssertionResult], evidenceReferences: [{ path: 'raw/profile-events.json' }], missingProof: [], nextActionOwner: 'product_optimization', nextAction: 'Retain the evidence.' };",
      "const claimCompleteSelection: PreRuntimeClaimSelection = { platform: 'ios', applicableClaimIds: ['journey-completes'], excludedClaimIds: [] };",
      "const claimCompleteTypedScenario: Record<string, unknown> = { schemaVersion: '1.1.0', id: 'typed-claim-complete', title: 'Typed claim complete', platform: 'mobile', journey: { name: 'Complete journey', intent: 'Finish the journey.', actor: 'user', startState: 'start', endState: 'complete', phases: [{ id: 'complete-journey', description: 'Complete the journey.', coverageKind: 'product' }], terminalInvariants: [{ id: 'complete', description: 'Journey complete.', coverageKind: 'product' }], recovery: { status: 'not_required', rationale: 'No interruption is authored.' } }, claims: [claimDefinition], safety: { class: 'read_only', rationale: 'Observe without mutation.', allowedOperations: ['observe'] }, dependencies: [] };",
      "const claimCompleteVerdictInput: ClaimCompleteVerdictInput = { scenario: claimCompleteTypedScenario, runId: 'typed-claim-complete-run', healthStatus: 'passed', selection: claimCompleteSelection, claimResults: [supportedClaimResult] };",
      "const claimCompleteVerdictCandidate: ClaimCompleteVerdictCandidate = buildClaimCompleteVerdict(claimCompleteVerdictInput);",
      "const buildClaimCompleteVerdictFn: typeof buildClaimCompleteVerdict = buildClaimCompleteVerdict;",
      "void buildClaimCompleteVerdictFn;",
      "void claimCompleteVerdictCandidate;",
      "void scenarioSafety; void claimSafetyInspection; void claimReductionInspection;",
      "// @ts-expect-error claim-complete runtime results cannot use not_applicable.",
      "const invalidClaimCompleteResultStatus: ClaimResult = { ...supportedClaimResult, status: 'not_applicable', reasonCode: 'all_assertions_supported' };",
      "void invalidClaimCompleteResultStatus;",
      "// @ts-expect-error claim-complete candidates cannot use not_evaluated.",
      "const invalidClaimCompleteCandidate: ClaimCompleteVerdictCandidate = { ...claimCompleteVerdictCandidate, verdictStatus: 'not_evaluated' };",
      "void invalidClaimCompleteCandidate;",

      "// @ts-expect-error read-only safety cannot declare mutation identity.",
      "const invalidReadOnlySafety: ScenarioSafetyDeclaration = { class: 'read_only', rationale: 'Invalid mutation.', allowedOperations: ['observe'], mutationIdentity: { id: 'mutation', assertionIds: ['assertion'] } };",
      "// @ts-expect-error local mutation requires rollback or cleanup truth.",
      "const invalidLocalSafety: ScenarioSafetyDeclaration = { class: 'local_mutation', rationale: 'Invalid safeguards.', allowedOperations: ['mutate'], mutationIdentity: { id: 'mutation', assertionIds: ['assertion'] }, rollback: { status: 'not_required', rationale: 'No rollback.' }, cleanup: { status: 'not_required', rationale: 'No cleanup.' }, reconciliation: { terminalInvariantIds: ['terminal'], assertionIds: ['assertion'] } };",
      "void invalidReadOnlySafety; void invalidLocalSafety;",
      "// @ts-expect-error boundedCount requires at least one declared bound.",
      "const invalidBoundedCountAssertion: ScenarioClaimAssertion = { id: 'count', kind: 'boundedCount', selector: 'events', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true }, authority: { role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents', requiredStrength: 'observed', completeness: 'bounded' } };",
      "void invalidBoundedCountAssertion;",
      "const artifactKind: ArtifactKind = 'logs';",
      "// @ts-expect-error validated evidence uses the closed public artifact-kind vocabulary.",
      "const invalidEvidenceAssertion: ValidatedEvidenceAssertion = { id: 'evidence', kind: 'validatedEvidence', artifactKind: 'not-a-schema-kind', validationContract: 'v1', authority: { role: 'runner', producerId: 'runner', evidenceSelector: 'artifacts', requiredStrength: 'verified', completeness: 'point' } };",
      "// @ts-expect-error supported results require all_assertions_supported.",
      "const invalidClaimResult: ClaimResult = { claimId: 'claim', claimHash: 'hash', role: 'mandatory', status: 'supported', reasonCode: 'health_gate_failed', assertionResults: [supportedAssertionResult], evidenceReferences: [], missingProof: [], nextActionOwner: 'unresolved', nextAction: 'inspect evidence' };",
      "// @ts-expect-error rejected results require authoritative_evidence_rejected.",
      "const invalidRejectedClaimResult: ClaimResult = { claimId: 'claim', claimHash: 'hash', role: 'mandatory', status: 'rejected', reasonCode: 'partial_evidence', assertionResults: [supportedAssertionResult], evidenceReferences: [], missingProof: [], nextActionOwner: 'unresolved', nextAction: 'inspect evidence' };",
      "// @ts-expect-error not_evaluable results cannot use supported reason vocabulary.",
      "const invalidNotEvaluableClaimResult: ClaimResult = { claimId: 'claim', claimHash: 'hash', role: 'mandatory', status: 'not_evaluable', reasonCode: 'all_assertions_supported', assertionResults: [supportedAssertionResult], evidenceReferences: [], missingProof: [], nextActionOwner: 'unresolved', nextAction: 'inspect evidence' };",
      "// @ts-expect-error assertion results use the same status and reason correlation.",
      "const invalidAssertionResult: ClaimAssertionResult = { assertionId: 'assertion', assertionKind: 'eventOccurrence', status: 'supported', reasonCode: 'health_gate_failed', expected: { event: 'completed' }, observed: { event: 'completed', matchedEvidence: 'event-1' }, evidenceReferences: [{ path: 'raw/events.json' }], rejectedEvidence: [], missingProof: [] };",
      "// @ts-expect-error assertion expectations are kind-specific objects, not legacy scalars.",
      "const invalidScalarAssertionResult: ClaimAssertionResult = { assertionId: 'assertion', assertionKind: 'eventOccurrence', status: 'supported', reasonCode: 'all_assertions_supported', expected: 'present', observed: 'completed', evidenceReferences: [{ path: 'raw/events.json' }], rejectedEvidence: [], missingProof: [] };",
      "// @ts-expect-error point-authority event occurrence has no rejected result form.",
      "const invalidRejectedOccurrence: ClaimAssertionResult = { assertionId: 'assertion', assertionKind: 'eventOccurrence', status: 'rejected', reasonCode: 'authoritative_evidence_rejected', expected: { event: 'completed' }, observed: { event: 'completed', matchedEvidence: 'event-1' }, evidenceReferences: [{ path: 'raw/events.json' }], rejectedEvidence: ['missing'], missingProof: [] };",
      "// @ts-expect-error supported assertion results require at least one evidence reference.",
      "const invalidSupportedWithoutEvidence: ClaimAssertionResult = { assertionId: 'assertion', assertionKind: 'eventOccurrence', status: 'supported', reasonCode: 'all_assertions_supported', expected: { event: 'completed' }, observed: { event: 'completed', matchedEvidence: 'event-1' }, evidenceReferences: [], rejectedEvidence: [], missingProof: [] };",
      "// @ts-expect-error supported assertion results cannot carry rejected-evidence inventory.",
      "const invalidSupportedWithRejectedEvidence: ClaimAssertionResult = { ...supportedAssertionResult, rejectedEvidence: ['candidate'] };",
      "// @ts-expect-error supported assertion results cannot carry missing-proof inventory.",
      "const invalidSupportedWithMissingProof: ClaimAssertionResult = { ...supportedAssertionResult, missingProof: ['proof'] };",
      "// @ts-expect-error a supported event-order result must record the before relation.",
      "const invalidSupportedOrder: ClaimAssertionResult = { assertionId: 'assertion', assertionKind: 'eventOrder', status: 'supported', reasonCode: 'all_assertions_supported', expected: { beforeEvent: 'started', afterEvent: 'completed' }, observed: { beforeEvidence: 'event-1', afterEvidence: 'event-2', relation: 'after' }, evidenceReferences: [{ path: 'raw/events.json' }], rejectedEvidence: [], missingProof: [] };",
      "// @ts-expect-error a supported absence result must record zero observations.",
      "const invalidSupportedAbsence: ClaimAssertionResult = { assertionId: 'assertion', assertionKind: 'absence', status: 'supported', reasonCode: 'all_assertions_supported', expected: { selector: 'events.crash', observationWindow: { from: 'start', to: 'end', completeSourceRequired: true } }, observed: { selector: 'events.crash', count: 1 }, evidenceReferences: [{ path: 'raw/events.json' }], rejectedEvidence: [], missingProof: [] };",
      "void artifactKind;",
      "void invalidEvidenceAssertion;",
      "void invalidClaimResult;",
      "void invalidRejectedClaimResult;",
      "void invalidNotEvaluableClaimResult;",
      "void invalidAssertionResult;",
      "void invalidScalarAssertionResult;",
      "void invalidRejectedOccurrence;",
      "void invalidSupportedWithoutEvidence;",
      "void invalidSupportedWithRejectedEvidence;",
      "void invalidSupportedWithMissingProof;",
      "void invalidSupportedOrder;",
      "void invalidSupportedAbsence;",
      "void supportedAssertionResult;",
      "void notEvaluableWithRejectedCandidate;",
      "void claimAuthorityInspection;",
      'declare const historicalArtifact: HistoricalEvaluationArtifact;',
      'const historicalValidation = validateHistoricalEvaluationArtifact(historicalArtifact);',
      'if (historicalValidation.valid) {',
      '  const validatedHistoricalArtifact: ValidatedHistoricalEvaluationArtifact = historicalValidation.value;',
      '  void validatedHistoricalArtifact;',
      '}',
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
      '  longPress: async () => passedResult,',
      '  typeText: async () => passedResult,',
      '  fill: async () => passedResult,',
      '  scroll: async () => passedResult,',
      '  swipe: async () => passedResult,',
      '  drag: async () => passedResult,',
      '  pinch: async () => passedResult,',
      '  rotate: async () => passedResult,',
      '  rotateGesture: async () => passedResult,',
      '  pressKey: async () => passedResult,',
      '  pressButton: async () => passedResult,',
      '  focus: async () => passedResult,',
      '  assertVisible: async () => passedResult,',
      '  inspectTree: async () => passedResult,',
      '  screenshot: async () => passedResult,',
      '  record: async () => passedResult,',
      '  readLogs: async () => passedResult,',
      '  collectPerfSignals: async () => passedResult,',
      '  customGesture: async () => passedResult,',
      '  runSequence: async () => passedResult,',
      '};',
      "const driverActionName: DriverActionName = 'runSequence';",
      "const dispatchedDriverAction = dispatchDriverAction({ driver: driverPort, input: { action: driverActionName, platform: 'android' } });",
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
      "const agentDeviceFocus = agentDeviceDriver.focus({ x: 120, y: 240 });",
      "const agentDeviceSelector = formatAgentDeviceSelector({ kind: 'text', value: 'Ready' });",
      "const agentDeviceSteps = resolveAgentDeviceDriverSteps({ steps: [{ kind: 'captureEvidence', artifact: 'screenshot', driverAction: 'screenshot' }] });",
      "const argentPoint = normalizeArgentPoint({ screenSize: { width: 1000, height: 2000 }, x: 500, y: 400 });",
      "const argentDriver = createArgentDriver({",
      "  argentCommand: 'argent',",
      "  appId: 'dev.example.app',",
      "  deviceId: 'booted',",
      "  executor: async (command, commandArgs) => ({",
      '    args: commandArgs,',
      '    command,',
      '    exitCode: 0,',
      "    stderr: '',",
      "    stdout: '',",
      '  }),',
      '});',
      "const argentTap = argentDriver.tap({ x: 0.5, y: 0.25 });",
      "const argentSteps = resolveArgentDriverSteps({ steps: [{ kind: 'gesture', driverAction: 'tap', adapterOptions: { argent: { x: 0.5, y: 0.25 } } }] });",
      "const argentCapture = runArgentCapture({",
      "  deviceId: 'booted',",
      "  executor: async (command, commandArgs) => ({",
      '    args: commandArgs,',
      '    command,',
      '    exitCode: 0,',
      "    stderr: '',",
      "    stdout: '',",
      '  }),',
      "  platform: 'ios',",
      "  runId: 'argent-smoke',",
      "  scenario: { id: 'argent-smoke', steps: [] },",
      '});',
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
      "const profileState: ProfileSessionState = { active: true, scenario: 'startup', runId: 'run-1', startedAt: Date.now() };",
      "const profileCommand: ProfileSessionCommand = { id: 'command-1', command: 'activate-target:open', timestamp: Date.now() };",
      "const profileMetadata: ProfileEventMetadata = { phase: 'completion', status: 'completed', atMs: 10 };",
      "const profileSessionStorageKey: string = PROFILE_SESSION_STORAGE_KEYS.session;",
      'const comparison = buildComparisonArtifact({',
      "  baselineHealth: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'before', healthStatus: 'passed', checks: [] },",
      "  baselineVerdict: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'before', healthStatus: 'passed', verdictStatus: 'passed' },",
      "  currentHealth: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'after', healthStatus: 'passed', checks: [] },",
      "  currentVerdict: { schemaVersion: '1.0.0', scenarioId: 'startup', runId: 'after', healthStatus: 'passed', verdictStatus: 'passed' },",
      '});',
      "const summary = buildAgentSummaryMarkdown({ health: comparison, verdict: comparison });",
      "validateJson({ schemaVersion: '1.0.0' }, SCHEMAS.health, 'health');",
      "validateScenarioAdapterOptions({ effectivePlatforms: ['android'], errors: [], scenario: { id: 'startup', steps: [] } });",
      'const resourceLeaseResultSample: ResourceLeaseAcquireResult["status"] = "failed";',
      "void ARTIFACT_LAYOUT_VERSION;",
      'void layout;',
      'void claimHash;',
      'void claimClosureInspection;',
      'void validation;',
      'void historicalValidation;',
      'void primaryRunner;',
      'void evidenceProvider;',
      'void driverPort;',
      'void driverActionName;',
      'void dispatchedDriverAction;',
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
      'void agentDeviceTap;',
      'void agentDeviceFocus;',
      'void agentDeviceSelector;',
      'void agentDeviceSteps;',
      'void agentDeviceCapture;',
      'void argentDriver;',
      'void argentPoint;',
      'void argentTap;',
      'void argentSteps;',
      'void argentCapture;',
      'void iosDriver;',
      'void iosLogs;',
      'void iosScreenshot;',
      'void args;',
      'void profileState;',
      'void profileCommand;',
      'void profileMetadata;',
      'void profileSessionStorageKey;',
      'void emitProfileEvent;',
      'void storeProfileSignal;',
      'void useProfileSession;',
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
      'void acquireResourceLease;',
      "void buildMobileTargetResourceId({ platform: 'android', targetId: 'emulator-5554' });",
      "void buildProviderResourceId({ providerId: 'native-profiler', targetId: 'emulator-5554' });",
      "void buildTcpPortResourceId({ host: 'localhost', port: 8081 });",
      'void releaseResourceLease;',
      "void resolveResourceLeasePath({ leaseRoot: 'leases', resourceId: 'mobile-target:android:emulator-5554' });",
      'void resourceLeaseResultSample;',
      'void validateProject;',
      "const quickProofSource: QuickProofSourceIdentity = { revision: 'source', packageName: 'agent-scenario-loop', packageVersion: 'packed', packageIntegrity: 'packed-tarball' };",
      'void quickProofSource;',
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
  resolveProvidedTarball,
  run,
  runExpectFailure,
  typescriptBinPath,
  writeFakeAdb,
  writeSmokeRun,
};
