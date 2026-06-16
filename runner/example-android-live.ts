#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag, writeUsage } = require('./cli');
const {
  parseArgs,
  runAndroidAdbPreflight,
} = require('./android-adb');
const {
  compareLiveProfilesToLatest,
  isEnabledFlag,
} = require('./example-live-comparison');
const { writeLiveProofSummary } = require('./example-live-proof-summary');
const { runProfileAndroid } = require('./profile-android');

type CliArgs = import('./android-adb').CliArgs;
type ExampleLiveComparisonResult = import('./example-live-comparison').ExampleLiveComparisonResult;
type LiveProofSummaryResult = import('./example-live-proof-summary').LiveProofSummaryResult;
type AndroidLiveProofOptions = {
  delay?: (ms: number) => Promise<void>;
  executor?: import('./android-adb').CommandExecutor;
  packageRoot?: string;
};
type AndroidLiveProfile = {
  label: string;
  runDir: string;
  runId: string;
  scenario: string;
  scenarioId: string;
};
type AndroidLiveProofResult = {
  aggregateSummary: LiveProofSummaryResult;
  comparisons: ExampleLiveComparisonResult[];
  outputDir: string;
  preflightDir: string;
  profiles: AndroidLiveProfile[];
};

const EXAMPLE_PROFILES = [
  {
    label: 'startup',
    runId: 'android-live-startup',
    scenario: 'app-startup.json',
    scenarioId: 'app-startup',
  },
  {
    label: 'open-close',
    runId: 'android-live-open-close',
    scenario: 'open-close-cycle.json',
    scenarioId: 'open-close-cycle',
  },
  {
    label: 'scroll',
    runId: 'android-live-scroll',
    scenario: 'scroll-settle.json',
    scenarioId: 'scroll-settle',
  },
];
const DEFAULT_REACT_NATIVE_DEBUG_HOST = 'localhost:8097';

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-example-android-live [--config <path>] [--out <dir>] [--package <name>] [--serial <device>] [--react-native-debug-host <host:port>] [--run-suffix <label>] [--compare-latest]',
    '',
    'Runs the packaged example Android live proof: adb preflight, startup, open-close, and scroll-settle.',
    'The example app must already be installed and reachable on an online Android emulator or device.',
    `By default, the runner sets the app React Native debug host to ${DEFAULT_REACT_NATIVE_DEBUG_HOST} for the isolated Metro server.`,
    'Use --run-suffix to preserve multiple live proof artifact sets without changing deterministic default run ids.',
    'Use --compare-latest to compare each passed scenario against the latest trusted prior run under the artifact root.',
  ], output);
}

/**
 * Resolves the package root for source and built CLI execution.
 *
 * @returns {string}
 */
function defaultPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
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
 * Converts a caller-provided run suffix into a path-safe run-id segment.
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
 * Applies the optional run suffix while preserving deterministic defaults.
 *
 * @param {string} baseRunId
 * @param {string | null} suffix
 * @returns {string}
 */
function buildLiveRunId(baseRunId: string, suffix: string | null): string {
  return suffix ? `${baseRunId}-${suffix}` : baseRunId;
}

/**
 * Throws when a profile run did not produce trusted evidence.
 *
 * @param {{label: string, runDir: string, health: Record<string, unknown>, verdict: Record<string, unknown>}} options
 * @returns {void}
 */
function assertPassedProfile({
  health,
  label,
  runDir,
  verdict,
}: {
  health: Record<string, unknown>;
  label: string;
  runDir: string;
  verdict: Record<string, unknown>;
}): void {
  if (health.healthStatus === 'passed' && verdict.verdictStatus === 'passed') {
    return;
  }

  throw new Error(
    [
      `Android live proof failed for ${label}.`,
      `Health: ${health.healthStatus ?? 'unknown'}.`,
      `Verdict: ${verdict.verdictStatus ?? 'unknown'}.`,
      `Inspect ${runDir}/agent-summary.md.`,
    ].join(' '),
  );
}

/**
 * Runs adb preflight plus all canonical Android example live profiles.
 *
 * @param {CliArgs} args
 * @param {AndroidLiveProofOptions} [options]
 * @returns {Promise<AndroidLiveProofResult>}
 */
async function runExampleAndroidLiveProof(
  args: CliArgs,
  options: AndroidLiveProofOptions = {},
): Promise<AndroidLiveProofResult> {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const exampleRoot = path.join(packageRoot, 'examples', 'mobile-app');
  const configPath = typeof args.config === 'string'
    ? path.resolve(args.config)
    : path.join(exampleRoot, 'asl.config.json');
  const outputDir = typeof args.out === 'string'
    ? path.resolve(args.out)
    : path.resolve('artifacts/example-mobile-app/android');
  const config = readJson(configPath);
  const packageName = resolveAndroidPackageName({ args, config });
  const runSuffix = normalizeRunSuffix(args['run-suffix']);
  const aggregateRunId = buildLiveRunId('android-live-proof', runSuffix);
  const preflightRunId = buildLiveRunId('android-live-preflight', runSuffix);
  const preflightDir = path.join(outputDir, '_preflight', preflightRunId);
  const reactNativeDebugHost = typeof args['react-native-debug-host'] === 'string'
    ? args['react-native-debug-host']
    : DEFAULT_REACT_NATIVE_DEBUG_HOST;

  const preflight = await runAndroidAdbPreflight({
    ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    outputDir: preflightDir,
    packageName,
    reactNativeDebugHost,
    runId: preflightRunId,
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
  });

  if (preflight.health.healthStatus !== 'passed') {
    throw new Error(`Android live proof preflight failed; inspect ${preflight.runDir}/agent-summary.md.`);
  }

  const profiles: AndroidLiveProfile[] = [];
  for (const profile of EXAMPLE_PROFILES) {
    const profileRunId = buildLiveRunId(profile.runId, runSuffix);
    const result = await runProfileAndroid({
      ...(typeof args.adb === 'string' ? { adb: args.adb } : {}),
      'adb-capture': true,
      'clear-logcat': true,
      config: configPath,
      'command-wait-ms': typeof args['command-wait-ms'] === 'string' ? args['command-wait-ms'] : '250',
      launch: true,
      'logcat-lines': typeof args['logcat-lines'] === 'string' ? args['logcat-lines'] : '1000',
      out: outputDir,
      ...(packageName ? { package: packageName } : {}),
      'profile-session': true,
      'react-native-debug-host': reactNativeDebugHost,
      'run-id': profileRunId,
      scenario: path.join(exampleRoot, 'scenarios', 'android', profile.scenario),
      ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
      'wait-ms': typeof args['wait-ms'] === 'string' ? args['wait-ms'] : '1000',
    }, {
      ...(options.delay ? { delay: options.delay } : {}),
      ...(options.executor ? { executor: options.executor } : {}),
    });

    assertPassedProfile({
      health: result.health,
      label: profile.label,
      runDir: result.runDir,
      verdict: result.verdict,
    });
    profiles.push({
      label: profile.label,
      runDir: result.runDir,
      runId: profileRunId,
      scenario: profile.scenario,
      scenarioId: profile.scenarioId,
    });
  }

  const comparisons = isEnabledFlag(args['compare-latest'])
    ? await compareLiveProfilesToLatest({ outputDir, profiles })
    : [];
  const aggregateSummary = await writeLiveProofSummary({
    comparisons,
    outputDir,
    platform: 'android',
    preflightDir: preflight.runDir,
    preflightRunId,
    profiles,
    runId: aggregateRunId,
  });

  return {
    aggregateSummary,
    comparisons,
    outputDir,
    preflightDir: preflight.runDir,
    profiles,
  };
}

/**
 * Formats the live proof result for humans and agents.
 *
 * @param {AndroidLiveProofResult} result
 * @returns {string}
 */
function formatResult(result: AndroidLiveProofResult): string {
  return [
    'Android example live proof passed.',
    `Live proof: ${result.aggregateSummary.summaryPath}`,
    `Preflight: ${result.preflightDir}/agent-summary.md`,
    ...result.profiles.map((profile) => (
      `${profile.label}: ${profile.runDir}/agent-summary.md`
    )),
    ...(
      result.comparisons.length > 0
        ? [
          'Comparisons:',
          ...result.comparisons.map((comparison) => (
            comparison.status === 'skipped'
              ? `${comparison.label}: skipped - ${comparison.reason}`
              : `${comparison.label}: ${comparison.status} ${comparison.summaryPath}`
          )),
        ]
        : []
    ),
    `Artifact root: ${result.outputDir}`,
  ].join('\n');
}

/**
 * Runs the example Android live proof CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const result = await runExampleAndroidLiveProof(parseArgs(argv));
  process.stdout.write(`${formatResult(result)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  formatResult,
  buildLiveRunId,
  main,
  normalizeRunSuffix,
  runExampleAndroidLiveProof,
  usage,
};

export type {
  AndroidLiveProofOptions,
  AndroidLiveProofResult,
  AndroidLiveProfile,
};
