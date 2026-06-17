#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag, writeUsage } = require('./cli');
const { parseArgs, parsePositiveInteger, runAndroidAdbPreflight } = require('./android-adb');
const { compareLiveProfilesToLatest, isEnabledFlag } = require('./example-live-comparison');
const { writeLiveProofSummary } = require('./example-live-proof-summary');
const { runAgentDeviceCapture } = require('./agent-device');
const { parseBaseArgs: parseArgentBaseArgs, runArgentCapture } = require('./argent');
const { runProfileAndroid } = require('./profile-android');

type CliArgs = import('./android-adb').CliArgs;
type AndroidGenericLiveOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  argentExecutor?: import('./argent').CommandExecutor;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./android-adb').CommandExecutor;
};
type AndroidGenericLiveResult = {
  aggregateSummary: import('./example-live-proof-summary').LiveProofSummaryResult;
  outputDir: string;
  preflightDir: string;
  profileDir: string;
};

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-live-android --config <path> --scenario <path> [--out <dir>] [--package <name>] [--serial <device>] [--run-id <id>] [--run-suffix <label>] [--compare-latest] [--fail-on-regression] [--agent-device-proof] [--argent-proof]',
    '',
    'Runs one generic Android live proof: adb preflight, profile-session adb capture, optional sidecars, optional latest-trusted comparison, and aggregate live-proof artifacts.',
    'Use --agent-device-proof to attach scenario-declared portable driver actions through agent-device.',
    'Use --argent-proof to attach scenario-declared Argent-compatible driver actions; set ASL_ARGENT_BIN and ASL_ARGENT_BASE_ARGS for non-global installs.',
  ], output);
}

/**
 * Reads a JSON object from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Reads a nested object property from unknown JSON.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {Record<string, unknown> | null}
 */
function readObjectProperty(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const property = value[key];
  return property && typeof property === 'object' && !Array.isArray(property)
    ? property as Record<string, unknown>
    : null;
}

/**
 * Resolves a stable scenario id from a scenario file.
 *
 * @param {{scenario: Record<string, unknown>, scenarioPath: string}} options
 * @returns {string}
 */
function resolveScenarioId({
  scenario,
  scenarioPath,
}: {
  scenario: Record<string, unknown>;
  scenarioPath: string;
}): string {
  return typeof scenario.id === 'string' && scenario.id.length > 0
    ? scenario.id
    : path.basename(scenarioPath, '.json');
}

/**
 * Resolves the Android package name from explicit input or ASL config.
 *
 * @param {{args: CliArgs, config: Record<string, unknown>}} options
 * @returns {string | null}
 */
function resolveAndroidPackageName({
  args,
  config,
}: {
  args: CliArgs;
  config: Record<string, unknown>;
}): string | null {
  if (typeof args.package === 'string') {
    return args.package;
  }

  const app = readObjectProperty(config, 'app');
  return typeof app?.androidPackage === 'string' ? app.androidPackage : null;
}

/**
 * Converts an optional run suffix into a path-safe segment.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeRunSuffix(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Applies an optional suffix to deterministic run ids.
 *
 * @param {string} baseRunId
 * @param {string | null} suffix
 * @returns {string}
 */
function buildRunId(baseRunId: string, suffix: string | null): string {
  return suffix ? `${baseRunId}-${suffix}` : baseRunId;
}

/**
 * Throws if a profile or interaction proof failed before aggregate writing.
 *
 * @param {{kind: string, runDir: string, health: Record<string, unknown>, verdict?: Record<string, unknown>}} options
 * @returns {void}
 */
function assertPassedRun({
  health,
  kind,
  runDir,
  verdict,
}: {
  health: Record<string, unknown>;
  kind: string;
  runDir: string;
  verdict?: Record<string, unknown>;
}): void {
  if (health.healthStatus === 'passed' && (!verdict || verdict.verdictStatus === 'passed')) {
    return;
  }

  throw new Error(
    [
      `Android live proof failed for ${kind}.`,
      `Health: ${health.healthStatus ?? 'unknown'}.`,
      ...(verdict ? [`Verdict: ${verdict.verdictStatus ?? 'unknown'}.`] : []),
      `Inspect ${runDir}/agent-summary.md.`,
    ].join(' '),
  );
}

/**
 * Throws after aggregate proof writing when fail-on-regression should gate the run.
 *
 * @param {{result: AndroidGenericLiveResult, comparisons: Array<{label: string, status: string}>}} options
 * @returns {void}
 */
function assertNoRegressedComparisons({
  comparisons,
  result,
}: {
  comparisons: Array<{label: string; status: string}>;
  result: AndroidGenericLiveResult;
}): void {
  const regressed = comparisons.filter((comparison) => comparison.status === 'worse');
  if (regressed.length === 0) {
    return;
  }

  throw new Error(
    `Android live proof found regressed comparison(s): ${regressed.map((comparison) => comparison.label).join(', ')}. Inspect ${result.aggregateSummary.summaryPath}.`,
  );
}

/**
 * Runs a generic one-scenario Android live proof.
 *
 * @param {CliArgs} args
 * @param {AndroidGenericLiveOptions} [options]
 * @returns {Promise<AndroidGenericLiveResult>}
 */
async function runAndroidLiveProof(
  args: CliArgs,
  options: AndroidGenericLiveOptions = {},
): Promise<AndroidGenericLiveResult> {
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    throw new Error('Both --config and --scenario are required.');
  }

  const configPath = path.resolve(args.config);
  const scenarioPath = path.resolve(args.scenario);
  const config = readJson(configPath);
  const scenario = readJson(scenarioPath);
  const scenarioId = resolveScenarioId({ scenario, scenarioPath });
  const packageName = resolveAndroidPackageName({ args, config });
  const outputDir = typeof args.out === 'string' ? path.resolve(args.out) : path.resolve('artifacts/asl/android-live');
  const runSuffix = normalizeRunSuffix(args['run-suffix']);
  const aggregateRunId = buildRunId(typeof args['run-id'] === 'string' ? args['run-id'] : 'android-live-proof', runSuffix);
  const preflightRunId = buildRunId(`${scenarioId}-android-preflight`, runSuffix);
  const profileRunId = buildRunId(`${scenarioId}-android-live`, runSuffix);
  const agentDeviceRunId = buildRunId(`${scenarioId}-android-agent-device`, runSuffix);
  const argentRunId = buildRunId(`${scenarioId}-android-argent`, runSuffix);
  const enabledInteractionRunners = [
    ...(isEnabledFlag(args['agent-device-proof']) ? ['agent-device'] : []),
    ...(isEnabledFlag(args['argent-proof']) ? ['argent'] : []),
  ];
  const comparisonLane = enabledInteractionRunners.length > 0
    ? `${scenarioId}-android-live+${enabledInteractionRunners.join('+')}`
    : `${scenarioId}-android-live`;
  const preflightDir = path.join(outputDir, '_preflight', preflightRunId);

  const preflight = await runAndroidAdbPreflight({
    ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    outputDir: preflightDir,
    packageName,
    ...(typeof args['react-native-debug-host'] === 'string'
      ? { reactNativeDebugHost: args['react-native-debug-host'] }
      : {}),
    runId: preflightRunId,
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
  });
  if (preflight.health.healthStatus !== 'passed') {
    throw new Error(`Android live proof preflight failed; inspect ${preflight.runDir}/agent-summary.md.`);
  }

  const interactionProofs: Array<{
    label: string;
    runDir: string;
    runId: string;
    runnerId: string;
    scenarioId: string;
  }> = [];
  if (isEnabledFlag(args['agent-device-proof'])) {
    const capture = await runAgentDeviceCapture({
      ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
      app: packageName,
      ...(options.agentDeviceExecutor ? { executor: options.agentDeviceExecutor } : {}),
      open: true,
      outputDir: path.join(outputDir, '_agent-device-captures', agentDeviceRunId),
      platform: 'android',
      runId: agentDeviceRunId,
      scenario,
      ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
      ...(typeof args['agent-device-session'] === 'string' ? { session: args['agent-device-session'] } : {}),
      waitMs: parsePositiveInteger(args['agent-device-wait-ms'], 1000),
    });
    assertPassedRun({ health: capture.health, kind: 'agent-device', runDir: capture.runDir });
    interactionProofs.push({
      label: 'interaction-agent-device',
      runDir: capture.runDir,
      runId: agentDeviceRunId,
      runnerId: 'agent-device',
      scenarioId,
    });
  }

  if (isEnabledFlag(args['argent-proof'])) {
    const argentBaseArgs = parseArgentBaseArgs(process.env.ASL_ARGENT_BASE_ARGS);
    const capture = await runArgentCapture({
      app: packageName,
      argentCommand: process.env.ASL_ARGENT_BIN || 'argent',
      ...(argentBaseArgs ? { baseArgs: argentBaseArgs } : {}),
      commandTimeoutMs: parsePositiveInteger(process.env.ASL_ARGENT_COMMAND_TIMEOUT_MS, 60_000),
      deviceId: typeof args.serial === 'string' ? args.serial : 'emulator-5554',
      ...(options.delay ? { delay: options.delay } : {}),
      ...(options.argentExecutor ? { executor: options.argentExecutor } : {}),
      outputDir: path.join(outputDir, '_argent-captures', argentRunId),
      platform: 'android',
      runId: argentRunId,
      scenario,
    });
    assertPassedRun({ health: capture.health, kind: 'argent', runDir: capture.runDir });
    interactionProofs.push({
      label: 'interaction-argent',
      runDir: capture.runDir,
      runId: argentRunId,
      runnerId: 'argent',
      scenarioId,
    });
  }

  const profile = await runProfileAndroid({
    ...(typeof args.adb === 'string' ? { adb: args.adb } : {}),
    'adb-capture': true,
    'clear-logcat': true,
    config: configPath,
    'command-wait-ms': typeof args['command-wait-ms'] === 'string' ? args['command-wait-ms'] : '250',
    launch: true,
    'launch-wait-ms': typeof args['launch-wait-ms'] === 'string' ? args['launch-wait-ms'] : '1500',
    'logcat-lines': typeof args['logcat-lines'] === 'string' ? args['logcat-lines'] : '1000',
    out: outputDir,
    ...(packageName ? { package: packageName } : {}),
    'profile-session': true,
    ...(typeof args['react-native-debug-host'] === 'string'
      ? { 'react-native-debug-host': args['react-native-debug-host'] }
      : {}),
    'run-id': profileRunId,
    scenario: scenarioPath,
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    'wait-ms': typeof args['wait-ms'] === 'string' ? args['wait-ms'] : '5000',
  }, {
    comparisonLane,
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  });
  assertPassedRun({ health: profile.health, kind: 'profile', runDir: profile.runDir, verdict: profile.verdict });

  const profiles = [{
    label: scenarioId,
    runDir: profile.runDir,
    runId: profileRunId,
    scenarioId,
  }];
  const comparisons = isEnabledFlag(args['compare-latest'])
    ? await compareLiveProfilesToLatest({ outputDir, profiles })
    : [];
  const aggregateSummary = await writeLiveProofSummary({
    comparisons,
    interactionProofs,
    outputDir,
    platform: 'android',
    preflightDir: preflight.runDir,
    preflightRunId,
    profiles,
    runId: aggregateRunId,
  });
  const result = {
    aggregateSummary,
    outputDir,
    preflightDir: preflight.runDir,
    profileDir: profile.runDir,
  };
  if (isEnabledFlag(args['fail-on-regression'])) {
    assertNoRegressedComparisons({ comparisons, result });
  }
  return result;
}

/**
 * Runs the generic Android live CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const args = parseArgs(argv);
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  const result = await runAndroidLiveProof(args);
  process.stdout.write(`${result.aggregateSummary.summaryPath}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertNoRegressedComparisons,
  assertPassedRun,
  buildRunId,
  main,
  normalizeRunSuffix,
  readJson,
  resolveAndroidPackageName,
  resolveScenarioId,
  runAndroidLiveProof,
  usage,
};

export type {
  AndroidGenericLiveOptions,
  AndroidGenericLiveResult,
};
