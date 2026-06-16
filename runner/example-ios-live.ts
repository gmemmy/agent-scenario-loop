#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag, writeUsage } = require('./cli');
const {
  parseArgs,
  runIosSimctlCapture,
} = require('./ios-simctl');
const { runProfileIos } = require('./profile-ios');

type CliArgs = import('./ios-simctl').CliArgs;
type IosLiveProofOptions = {
  delay?: (ms: number) => Promise<void>;
  executor?: import('./ios-simctl').CommandExecutor;
  packageRoot?: string;
};
type IosLiveProfile = {
  label: string;
  runDir: string;
  runId: string;
  scenario: string;
};
type IosLiveProofResult = {
  outputDir: string;
  preflightDir: string;
  profiles: IosLiveProfile[];
};

const EXAMPLE_PROFILES = [
  {
    label: 'startup',
    runId: 'ios-live-startup',
    scenario: 'app-startup.json',
  },
  {
    label: 'open-close',
    runId: 'ios-live-open-close',
    scenario: 'open-close-cycle.json',
  },
  {
    label: 'scroll',
    runId: 'ios-live-scroll',
    scenario: 'scroll-settle.json',
  },
];

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-example-ios-live [--config <path>] [--out <dir>] [--bundle <id>] [--device <udid|booted>] [--xcrun <path>]',
    '',
    'Runs the packaged example iOS live proof: simctl preflight, startup, open-close, and scroll-settle.',
    'The example app must already be installed on a booted iOS simulator and connected to Metro.',
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
 * Resolves the iOS bundle id from explicit input or ASL config.
 *
 * @param {{args: CliArgs, config: Record<string, unknown>}} options
 * @returns {string | null}
 */
function resolveIosBundleId({
  args,
  config,
}: {
  args: CliArgs;
  config: Record<string, unknown>;
}): string | null {
  if (typeof args.bundle === 'string') {
    return args.bundle;
  }

  const app = readObjectProperty(config, 'app');
  return typeof app?.iosBundleId === 'string' ? app.iosBundleId : null;
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
      `iOS live proof failed for ${label}.`,
      `Health: ${health.healthStatus ?? 'unknown'}.`,
      `Verdict: ${verdict.verdictStatus ?? 'unknown'}.`,
      `Inspect ${runDir}/agent-summary.md.`,
    ].join(' '),
  );
}

/**
 * Runs simctl preflight plus all canonical iOS example live profiles.
 *
 * @param {CliArgs} args
 * @param {IosLiveProofOptions} [options]
 * @returns {Promise<IosLiveProofResult>}
 */
async function runExampleIosLiveProof(
  args: CliArgs,
  options: IosLiveProofOptions = {},
): Promise<IosLiveProofResult> {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const exampleRoot = path.join(packageRoot, 'examples', 'mobile-app');
  const configPath = typeof args.config === 'string'
    ? path.resolve(args.config)
    : path.join(exampleRoot, 'asl.config.json');
  const outputDir = typeof args.out === 'string'
    ? path.resolve(args.out)
    : path.resolve('artifacts/example-mobile-app/ios');
  const config = readJson(configPath);
  const bundleId = resolveIosBundleId({ args, config });
  const preflightDir = path.join(outputDir, '_preflight', 'ios-live-preflight');

  const preflight = await runIosSimctlCapture({
    bundleId,
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    outputDir: preflightDir,
    runId: 'ios-live-preflight',
    ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
  });

  if (preflight.health.healthStatus !== 'passed') {
    throw new Error(`iOS live proof preflight failed; inspect ${preflight.runDir}/agent-summary.md.`);
  }

  const profiles: IosLiveProfile[] = [];
  for (const profile of EXAMPLE_PROFILES) {
    const result = await runProfileIos({
      config: configPath,
      ...(typeof args.device === 'string' ? { device: args.device } : {}),
      ...(typeof args['log-last'] === 'string' ? { 'log-last': args['log-last'] } : {}),
      launch: true,
      out: outputDir,
      'profile-session': true,
      'profile-session-storage': true,
      'run-id': profile.runId,
      scenario: path.join(exampleRoot, 'scenarios', 'ios', profile.scenario),
      'simctl-capture': true,
      'simctl-out': path.join(outputDir, '_ios-simctl-captures', profile.runId),
      'wait-ms': typeof args['wait-ms'] === 'string' ? args['wait-ms'] : '1000',
      ...(bundleId ? { bundle: bundleId } : {}),
      ...(typeof args.xcrun === 'string' ? { xcrun: args.xcrun } : {}),
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
      runId: profile.runId,
      scenario: profile.scenario,
    });
  }

  return {
    outputDir,
    preflightDir: preflight.runDir,
    profiles,
  };
}

/**
 * Formats the live proof result for humans and agents.
 *
 * @param {IosLiveProofResult} result
 * @returns {string}
 */
function formatResult(result: IosLiveProofResult): string {
  return [
    'iOS example live proof passed.',
    `Preflight: ${result.preflightDir}/agent-summary.md`,
    ...result.profiles.map((profile) => (
      `${profile.label}: ${profile.runDir}/agent-summary.md`
    )),
    `Artifact root: ${result.outputDir}`,
  ].join('\n');
}

/**
 * Runs the example iOS live proof CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const result = await runExampleIosLiveProof(parseArgs(argv));
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
  main,
  runExampleIosLiveProof,
  usage,
};

export type {
  IosLiveProofOptions,
  IosLiveProofResult,
  IosLiveProfile,
};
