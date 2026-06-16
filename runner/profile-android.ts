#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag } = require('./cli');
const {
  parsePositiveInteger,
  runAndroidAdbPreflight,
} = require('./android-adb');
const {
  parseArgs,
  runProfileMobile,
  usage,
} = require('./profile-mobile');

type AndroidProfileOptions = {
  delay?: (ms: number) => Promise<void>;
  executor?: import('./android-adb').CommandExecutor;
};

/**
 * Reads and parses a JSON object from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Checks whether a boolean-style CLI flag is enabled.
 *
 * @param {string | boolean | undefined} value
 * @returns {boolean}
 */
function isEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

/**
 * Creates a short run id when adb capture must share the id with profile artifacts.
 *
 * @returns {string}
 */
function createRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Resolves the adb capture output directory for a profile run.
 *
 * @param {{args: import('./profile-mobile').CliArgs, runId: string}} options
 * @returns {string}
 */
function resolveAdbCaptureOutputDir({
  args,
  runId,
}: {
  args: import('./profile-mobile').CliArgs;
  runId: string;
}): string {
  if (typeof args['adb-out'] === 'string') {
    return path.resolve(args['adb-out']);
  }

  if (typeof args.out === 'string') {
    return path.resolve(args.out, '_adb-captures', runId);
  }

  return path.resolve('artifacts/android-adb-captures', runId);
}

/**
 * Resolves the Android package name from explicit CLI input or project config.
 *
 * @param {{args: import('./profile-mobile').CliArgs, config: Record<string, unknown>}} options
 * @returns {string | null}
 */
function resolveAndroidPackageName({
  args,
  config,
}: {
  args: import('./profile-mobile').CliArgs;
  config: Record<string, any>;
}): string | null {
  if (typeof args.package === 'string') {
    return args.package;
  }

  return typeof config.app?.androidPackage === 'string' ? config.app.androidPackage : null;
}

/**
 * Runs the Android log-ingest profile artifact pipeline.
 *
 * @param {import('./profile-mobile').CliArgs} args
 * @param {AndroidProfileOptions} [options]
 * @returns {Promise<import('./profile-mobile').ProfileRunResult>}
 */
async function runProfileAndroid(
  args: import('./profile-mobile').CliArgs,
  options: AndroidProfileOptions = {},
): Promise<import('./profile-mobile').ProfileRunResult> {
  if (!isEnabled(args['adb-capture'])) {
    return runProfileMobile(args, {
      defaultDriver: 'adb-logcat',
      platform: 'android',
    });
  }

  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    throw new Error('Both --config and --scenario are required.');
  }

  const config = readJson(path.resolve(args.config));
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const adbCapture = await runAndroidAdbPreflight({
    ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
    captureLogcat: true,
    clearLogcat: isEnabled(args['clear-logcat']),
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    launch: isEnabled(args.launch),
    logcatLines: parsePositiveInteger(args['logcat-lines'], 1000),
    outputDir: resolveAdbCaptureOutputDir({ args, runId }),
    packageName: resolveAndroidPackageName({ args, config }),
    runId,
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    waitMs: parsePositiveInteger(args['wait-ms'], 0),
  });

  if (adbCapture.health.healthStatus !== 'passed') {
    throw new Error(`Android adb capture failed; see ${adbCapture.runDir}`);
  }

  return runProfileMobile({
    ...args,
    'adb-artifacts': adbCapture.runDir,
    events: undefined,
    'run-id': runId,
  }, {
    defaultDriver: 'adb-logcat',
    platform: 'android',
  });
}

/**
 * Runs the profile-android CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage({ binaryName: 'asl-profile-android', output: process.stdout, platform: 'android' });
    return;
  }

  const args = parseArgs(argv);
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    usage({ binaryName: 'asl-profile-android', platform: 'android' });
    process.exitCode = 1;
    return;
  }

  const result = await runProfileAndroid(args);
  process.stdout.write(`${result.runDir}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
  runProfileAndroid,
  usage,
};
