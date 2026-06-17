#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag, writeUsage } = require('./cli');
const {
  parsePositiveInteger,
  parseArgs,
  runIosSimctlCapture,
} = require('./ios-simctl');
const {
  compareLiveProfilesToLatest,
  isEnabledFlag,
} = require('./example-live-comparison');
const { writeLiveProofSummary } = require('./example-live-proof-summary');
const { runAgentDeviceCapture } = require('./agent-device');
const { runProfileIos } = require('./profile-ios');

type CliArgs = import('./ios-simctl').CliArgs;
type ExampleLiveComparisonResult = import('./example-live-comparison').ExampleLiveComparisonResult;
type LiveProofSummaryResult = import('./example-live-proof-summary').LiveProofSummaryResult;
type IosLiveProofOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./ios-simctl').CommandExecutor;
  packageRoot?: string;
};
type IosInteractionProof = {
  label: string;
  runDir: string;
  runId: string;
  runnerId: string;
  scenarioId: string;
};
type IosLiveProfile = {
  label: string;
  runDir: string;
  runId: string;
  scenario: string;
  scenarioId: string;
};
type IosLiveProofResult = {
  aggregateSummary: LiveProofSummaryResult;
  comparisons: ExampleLiveComparisonResult[];
  interactionProofs: IosInteractionProof[];
  outputDir: string;
  preflightDir: string;
  profiles: IosLiveProfile[];
};

const EXAMPLE_PROFILES = [
  {
    label: 'startup',
    runId: 'ios-live-startup',
    scenario: 'app-startup.json',
    scenarioId: 'app-startup',
  },
  {
    label: 'open-close',
    runId: 'ios-live-open-close',
    scenario: 'open-close-cycle.json',
    scenarioId: 'open-close-cycle',
  },
  {
    label: 'scroll',
    runId: 'ios-live-scroll',
    scenario: 'scroll-settle.json',
    scenarioId: 'scroll-settle',
  },
];
const DEFAULT_AGENT_DEVICE_IOS_SESSION = 'ios-example-live';

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-example-ios-live [--config <path>] [--out <dir>] [--bundle <id>] [--device <udid|booted>] [--xcrun <path>] [--run-suffix <label>] [--compare-latest] [--agent-device-proof]',
    '',
    'Runs the packaged example iOS live proof: simctl preflight, startup, open-close, and scroll-settle.',
    'The example app must already be installed on a booted iOS simulator and connected to Metro.',
    'Use --run-suffix to preserve multiple live proof artifact sets without changing deterministic default run ids.',
    'Use --compare-latest to compare each passed scenario against the latest trusted prior run under the artifact root.',
    `Use --agent-device-proof to attach the shared startup UI assertion through agent-device; defaults to session ${DEFAULT_AGENT_DEVICE_IOS_SESSION}.`,
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
      `iOS live proof failed for ${label}.`,
      `Health: ${health.healthStatus ?? 'unknown'}.`,
      `Verdict: ${verdict.verdictStatus ?? 'unknown'}.`,
      `Inspect ${runDir}/agent-summary.md.`,
    ].join(' '),
  );
}

/**
 * Throws when an interaction proof failed before aggregate summary writing.
 *
 * @param {{label: string, runDir: string, health: Record<string, unknown>}} options
 * @returns {void}
 */
function assertPassedInteractionProof({
  health,
  label,
  runDir,
}: {
  health: Record<string, unknown>;
  label: string;
  runDir: string;
}): void {
  if (health.healthStatus === 'passed') {
    return;
  }

  throw new Error(
    [
      `iOS interaction proof failed for ${label}.`,
      `Health: ${health.healthStatus ?? 'unknown'}.`,
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
  const runSuffix = normalizeRunSuffix(args['run-suffix']);
  const aggregateRunId = buildLiveRunId('ios-live-proof', runSuffix);
  const preflightRunId = buildLiveRunId('ios-live-preflight', runSuffix);
  const interactionRunId = buildLiveRunId('ios-agent-device-startup', runSuffix);
  const preflightDir = path.join(outputDir, '_preflight', preflightRunId);

  const preflight = await runIosSimctlCapture({
    bundleId,
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    outputDir: preflightDir,
    runId: preflightRunId,
    ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
  });

  if (preflight.health.healthStatus !== 'passed') {
    throw new Error(`iOS live proof preflight failed; inspect ${preflight.runDir}/agent-summary.md.`);
  }

  const interactionProofs: IosInteractionProof[] = [];
  if (isEnabledFlag(args['agent-device-proof'])) {
    const agentDeviceCapture = await runAgentDeviceCapture({
      ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
      app: bundleId,
      ...(options.agentDeviceExecutor ? { executor: options.agentDeviceExecutor } : {}),
      open: true,
      outputDir: path.join(outputDir, '_agent-device-captures', interactionRunId),
      platform: 'ios',
      runId: interactionRunId,
      scenario: readJson(path.join(exampleRoot, 'scenarios', 'mobile', 'app-startup.json')),
      session: typeof args['agent-device-session'] === 'string'
        ? args['agent-device-session']
        : DEFAULT_AGENT_DEVICE_IOS_SESSION,
      ...(typeof args.device === 'string' ? { udid: args.device } : {}),
      waitMs: parsePositiveInteger(args['agent-device-wait-ms'], 1000),
    });
    assertPassedInteractionProof({
      health: agentDeviceCapture.health,
      label: 'startup-ui',
      runDir: agentDeviceCapture.runDir,
    });
    interactionProofs.push({
      label: 'startup-ui',
      runDir: agentDeviceCapture.runDir,
      runId: interactionRunId,
      runnerId: 'agent-device',
      scenarioId: 'app-startup',
    });
  }

  const profiles: IosLiveProfile[] = [];
  for (const profile of EXAMPLE_PROFILES) {
    const profileRunId = buildLiveRunId(profile.runId, runSuffix);
    const result = await runProfileIos({
      config: configPath,
      ...(typeof args.device === 'string' ? { device: args.device } : {}),
      ...(typeof args['log-last'] === 'string' ? { 'log-last': args['log-last'] } : {}),
      launch: true,
      out: outputDir,
      'profile-session': true,
      'profile-session-storage': true,
      'run-id': profileRunId,
      scenario: path.join(exampleRoot, 'scenarios', 'ios', profile.scenario),
      'simctl-capture': true,
      'simctl-out': path.join(outputDir, '_ios-simctl-captures', profileRunId),
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
    interactionProofs,
    outputDir,
    platform: 'ios',
    preflightDir: preflight.runDir,
    preflightRunId,
    profiles,
    runId: aggregateRunId,
  });

  return {
    aggregateSummary,
    comparisons,
    interactionProofs,
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
    `Live proof: ${result.aggregateSummary.summaryPath}`,
    `Preflight: ${result.preflightDir}/agent-summary.md`,
    ...result.profiles.map((profile) => (
      `${profile.label}: ${profile.runDir}/agent-summary.md`
    )),
    ...result.interactionProofs.map((proof) => (
      `${proof.label}: ${proof.runDir}/agent-summary.md`
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
  buildLiveRunId,
  formatResult,
  main,
  normalizeRunSuffix,
  runExampleIosLiveProof,
  usage,
};

export type {
  IosLiveProofOptions,
  IosInteractionProof,
  IosLiveProofResult,
  IosLiveProfile,
};
