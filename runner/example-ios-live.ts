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
} = require('./live-comparison');
const { writeLiveProofSummary } = require('./live-proof-summary');
const { runAgentDeviceCapture } = require('./agent-device');
const { parseBaseArgs: parseArgentBaseArgs, runArgentCapture } = require('./argent');
const { runProfileIos } = require('./profile-ios');

type CliArgs = import('./ios-simctl').CliArgs;
type LiveComparisonResult = import('./live-comparison').LiveComparisonResult;
type LiveProofSummaryResult = import('./live-proof-summary').LiveProofSummaryResult;
type IosLiveProofOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  argentExecutor?: import('./argent').CommandExecutor;
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
type IosSkippedInteractionProof = import('./live-proof-summary').LiveProofSkippedInteractionProofPointer;
type IosLiveProfile = {
  healthStatus?: string;
  label: string;
  runDir: string;
  runId: string;
  scenario: string;
  scenarioId: string;
  verdictStatus?: string;
};
type IosLiveProofResult = {
  aggregateSummary: LiveProofSummaryResult;
  comparisons: LiveComparisonResult[];
  interactionProofs: IosInteractionProof[];
  outputDir: string;
  preflightDir: string;
  profiles: IosLiveProfile[];
  skippedInteractionProofs: IosSkippedInteractionProof[];
};
type RegressionGateOptions = {
  platformLabel: string;
  result: IosLiveProofResult;
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
/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-example-ios-live [--config <path>] [--out <dir>] [--bundle <id>] [--device <udid|booted>] [--xcrun <path>] [--run-suffix <label>] [--compare-latest] [--fail-on-regression] [--agent-device-proof] [--argent-proof]',
    '',
    'Runs the packaged example iOS live proof: simctl preflight, startup, open-close, and scroll-settle.',
    'The example app must already be installed on a booted iOS simulator and connected to Metro.',
    'Use --run-suffix to preserve multiple live proof artifact sets without changing deterministic default run ids.',
    'Use --compare-latest to compare each passed scenario against the latest trusted prior run under the artifact root.',
    'Use --fail-on-regression with --compare-latest to exit nonzero after writing evidence when any comparison regressed.',
    'Use --agent-device-proof to attach the shared startup UI assertion through agent-device; pass --agent-device-session-mode bind when a named session should still receive the configured UDID.',
    'Use --argent-proof to attach the shared startup UI assertion through Argent; set ASL_ARGENT_BIN and ASL_ARGENT_BASE_ARGS for non-global installs. iOS Argent screenshots fall back to simctl when Argent screenshot is unavailable.',
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
 * Resolves optional sibling iOS bundle ids that make simulator targeting ambiguous.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
function resolveIosConflictingBundleIds(config: Record<string, unknown>): string[] {
  const app = readObjectProperty(config, 'app');
  const configured = app?.iosConflictingBundleIds;
  return Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

/**
 * Resolves the simulator target used by every iOS proof lane.
 *
 * @param {CliArgs} args
 * @returns {string}
 */
function resolveIosDeviceId(args: CliArgs): string {
  if (typeof args.device === 'string') {
    return args.device;
  }
  if (typeof process.env.ASL_EXAMPLE_IOS_UDID === 'string' && process.env.ASL_EXAMPLE_IOS_UDID.length > 0) {
    return process.env.ASL_EXAMPLE_IOS_UDID;
  }
  return 'booted';
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
 * Builds the comparison lane suffix for enabled interaction proofs.
 *
 * @param {string[]} runnerIds
 * @returns {string}
 */
function buildInteractionComparisonLane(runnerIds: string[]): string {
  return runnerIds.length > 0
    ? `example-ios-live+${runnerIds.join('+')}`
    : 'example-ios-live';
}

/**
 * Reports whether profile evidence is healthy enough to trust sidecar proofs and comparisons.
 *
 * @param {{health: Record<string, unknown>, verdict: Record<string, unknown>}} run
 * @returns {boolean}
 */
function isTrustedProfileRun({
  health,
  verdict,
}: {
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
}): boolean {
  return health.healthStatus === 'passed' && verdict.verdictStatus === 'passed';
}

/**
 * Builds skipped sidecar pointers for requested example runners when the profile batch failed.
 *
 * @param {{failedProfiles: IosLiveProfile[], requestedRunners: string[], runIdsByRunner: Record<string, string>}} options
 * @returns {IosSkippedInteractionProof[]}
 */
function buildSkippedInteractionProofs({
  failedProfiles,
  requestedRunners,
  runIdsByRunner,
}: {
  failedProfiles: IosLiveProfile[];
  requestedRunners: string[];
  runIdsByRunner: Record<string, string>;
}): IosSkippedInteractionProof[] {
  if (failedProfiles.length === 0) {
    return [];
  }

  const failedSummary = failedProfiles
    .map((profile) => `${profile.label}=health:${profile.healthStatus ?? 'unknown'}/verdict:${profile.verdictStatus ?? 'unknown'}`)
    .join(', ');
  const reason = `Profile batch failed (${failedSummary}); sidecar interaction proof was skipped because aggregate runner evidence would not be trustworthy.`;
  const labelsByRunner: Record<string, string> = {
    'agent-device': 'startup-ui',
    argent: 'startup-ui-argent',
  };
  return requestedRunners.map((runnerId) => ({
    label: labelsByRunner[runnerId] ?? `startup-ui-${runnerId}`,
    nextAction: {
      code: 'fix_profile_gate',
      summary: 'Inspect the failed profile health and verdict before rerunning sidecar interaction proofs.',
    },
    reason,
    runId: runIdsByRunner[runnerId] ?? `ios-${runnerId}-startup`,
    runnerId,
    scenarioId: 'app-startup',
  }));
}

/**
 * Throws after aggregate proof writing when the live proof itself failed.
 *
 * @param {IosLiveProofResult} result
 * @returns {void}
 */
function assertAggregatePassed(result: IosLiveProofResult): void {
  const proof = readJson(result.aggregateSummary.liveProofPath);
  if (proof.status === 'passed') {
    return;
  }

  throw new Error(`iOS example live proof failed. Inspect ${result.aggregateSummary.summaryPath}.`);
}

/**
 * Throws after aggregate proof writing when fail-on-regression should gate the run.
 *
 * @param {RegressionGateOptions} options
 * @returns {void}
 */
function assertNoRegressedComparisons({
  platformLabel,
  result,
}: RegressionGateOptions): void {
  const regressed = result.comparisons.filter((comparison) => comparison.status === 'worse');
  if (regressed.length === 0) {
    return;
  }

  const labels = regressed.map((comparison) => comparison.label).join(', ');
  throw new Error(
    `${platformLabel} example live proof found regressed comparison(s): ${labels}. Inspect ${result.aggregateSummary.summaryPath}.`,
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
  const deviceId = resolveIosDeviceId(args);
  const runSuffix = normalizeRunSuffix(args['run-suffix']);
  const aggregateRunId = buildLiveRunId('ios-live-proof', runSuffix);
  const preflightRunId = buildLiveRunId('ios-live-preflight', runSuffix);
  const agentDeviceRunId = buildLiveRunId('ios-agent-device-startup', runSuffix);
  const argentRunId = buildLiveRunId('ios-argent-startup', runSuffix);
  const enabledInteractionRunners = [
    ...(isEnabledFlag(args['agent-device-proof']) ? ['agent-device'] : []),
    ...(isEnabledFlag(args['argent-proof']) ? ['argent'] : []),
  ];
  const comparisonLane = buildInteractionComparisonLane(enabledInteractionRunners);
  const runIdsByRunner = {
    'agent-device': agentDeviceRunId,
    argent: argentRunId,
  };
  const preflightDir = path.join(outputDir, '_preflight', preflightRunId);

  const preflight = await runIosSimctlCapture({
    bundleId,
    conflictingBundleIds: resolveIosConflictingBundleIds(config),
    device: deviceId,
    ...(options.executor ? { executor: options.executor } : {}),
    outputDir: preflightDir,
    runId: preflightRunId,
    ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
  });

  if (preflight.health.healthStatus !== 'passed') {
    throw new Error(`iOS live proof preflight failed; inspect ${preflight.runDir}/agent-summary.md.`);
  }

  const interactionProofs: IosInteractionProof[] = [];
  const profiles: IosLiveProfile[] = [];
  const failedProfiles: IosLiveProfile[] = [];
  for (const profile of EXAMPLE_PROFILES) {
    const profileRunId = buildLiveRunId(profile.runId, runSuffix);
    const result = await runProfileIos({
      config: configPath,
      device: deviceId,
      ...(typeof args['log-last'] === 'string' ? { 'log-last': args['log-last'] } : {}),
      launch: true,
      out: outputDir,
      'profile-session': true,
      'profile-session-storage': true,
      'run-id': profileRunId,
      scenario: path.join(exampleRoot, 'scenarios', 'mobile', profile.scenario),
      'simctl-capture': true,
      'simctl-out': path.join(outputDir, '_ios-simctl-captures', profileRunId),
      ...(typeof args['wait-ms'] === 'string' ? { 'wait-ms': args['wait-ms'] } : {}),
      ...(bundleId ? { bundle: bundleId } : {}),
      ...(typeof args.xcrun === 'string' ? { xcrun: args.xcrun } : {}),
    }, {
      comparisonLane,
      ...(options.delay ? { delay: options.delay } : {}),
      ...(options.executor ? { executor: options.executor } : {}),
    });

    const profilePointer = {
      healthStatus: typeof result.health.healthStatus === 'string' ? result.health.healthStatus : 'unknown',
      label: profile.label,
      runDir: result.runDir,
      runId: profileRunId,
      scenario: profile.scenario,
      scenarioId: profile.scenarioId,
      verdictStatus: typeof result.verdict.verdictStatus === 'string' ? result.verdict.verdictStatus : 'unknown',
    };
    profiles.push(profilePointer);
    if (!isTrustedProfileRun({ health: result.health, verdict: result.verdict })) {
      failedProfiles.push(profilePointer);
    }
  }

  const skippedInteractionProofs = buildSkippedInteractionProofs({
    failedProfiles,
    requestedRunners: enabledInteractionRunners,
    runIdsByRunner,
  });
  const profileBatchTrusted = failedProfiles.length === 0;

  if (profileBatchTrusted && isEnabledFlag(args['agent-device-proof'])) {
    const agentDeviceCapture = await runAgentDeviceCapture({
      ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
      app: bundleId,
      ...(options.agentDeviceExecutor ? { executor: options.agentDeviceExecutor } : {}),
      open: true,
      outputDir: path.join(outputDir, '_agent-device-captures', agentDeviceRunId),
      platform: 'ios',
      runId: agentDeviceRunId,
      scenario: readJson(path.join(exampleRoot, 'scenarios', 'mobile', 'app-startup.json')),
      ...(typeof args['agent-device-session'] === 'string' ? { session: args['agent-device-session'] } : {}),
      ...(typeof args['agent-device-session-mode'] === 'string'
        ? { sessionMode: args['agent-device-session-mode'] as import('./agent-device').AgentDeviceSessionMode }
        : {}),
      udid: deviceId,
      waitMs: parsePositiveInteger(args['agent-device-wait-ms'], 1000),
    });
    interactionProofs.push({
      label: 'startup-ui',
      runDir: agentDeviceCapture.runDir,
      runId: agentDeviceRunId,
      runnerId: 'agent-device',
      scenarioId: 'app-startup',
    });
  }

  if (profileBatchTrusted && isEnabledFlag(args['argent-proof'])) {
    const argentBaseArgs = parseArgentBaseArgs(process.env.ASL_ARGENT_BASE_ARGS);
    const argentCapture = await runArgentCapture({
      app: bundleId,
      argentCommand: process.env.ASL_ARGENT_BIN || 'argent',
      ...(argentBaseArgs ? { baseArgs: argentBaseArgs } : {}),
      commandTimeoutMs: parsePositiveInteger(process.env.ASL_ARGENT_COMMAND_TIMEOUT_MS, 60_000),
      deviceId,
      ...(options.delay ? { delay: options.delay } : {}),
      ...(options.argentExecutor ? { executor: options.argentExecutor } : {}),
      iosSimctlScreenshotFallback: true,
      ...(options.executor ? { iosSimctlExecutor: options.executor } : {}),
      outputDir: path.join(outputDir, '_argent-captures', argentRunId),
      platform: 'ios',
      runId: argentRunId,
      scenario: readJson(path.join(exampleRoot, 'scenarios', 'mobile', 'app-startup.json')),
    });
    interactionProofs.push({
      label: 'startup-ui-argent',
      runDir: argentCapture.runDir,
      runId: argentRunId,
      runnerId: 'argent',
      scenarioId: 'app-startup',
    });
  }

  const comparisons = profileBatchTrusted && isEnabledFlag(args['compare-latest'])
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
    skippedInteractionProofs,
  });
  const result = {
    aggregateSummary,
    comparisons,
    interactionProofs,
    outputDir,
    preflightDir: preflight.runDir,
    profiles,
    skippedInteractionProofs,
  };
  if (isEnabledFlag(args['fail-on-regression'])) {
    assertNoRegressedComparisons({
      platformLabel: 'iOS',
      result,
    });
  }
  assertAggregatePassed(result);
  return result;
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

  const args = parseArgs(argv);
  const result = await runExampleIosLiveProof(args);
  process.stdout.write(`${formatResult(result)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertAggregatePassed,
  buildLiveRunId,
  formatResult,
  assertNoRegressedComparisons,
  buildSkippedInteractionProofs,
  buildInteractionComparisonLane,
  isTrustedProfileRun,
  main,
  normalizeRunSuffix,
  resolveIosDeviceId,
  runExampleIosLiveProof,
  usage,
};

export type {
  IosLiveProofOptions,
  IosInteractionProof,
  IosLiveProofResult,
  IosLiveProfile,
};
