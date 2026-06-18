#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag, writeUsage } = require('./cli');
const { parseArgs, parsePositiveInteger, runIosSimctlCapture } = require('./ios-simctl');
const { compareLiveProfilesToLatest, isEnabledFlag } = require('./live-comparison');
const { writeLiveProofSummary } = require('./live-proof-summary');
const { runAgentDeviceCapture } = require('./agent-device');
const { parseBaseArgs: parseArgentBaseArgs, runArgentCapture } = require('./argent');
const { loadAslLocalEnv, readStringArgOrEnv } = require('./local-env');
const { runProfileIos } = require('./profile-ios');

type CliArgs = import('./ios-simctl').CliArgs;
type IosGenericLiveOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  argentExecutor?: import('./argent').CommandExecutor;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./ios-simctl').CommandExecutor;
};
type IosGenericLiveResult = {
  aggregateSummary: import('./live-proof-summary').LiveProofSummaryResult;
  outputDir: string;
  preflightDir: string;
  profileDir: string;
};
type SkippedInteractionProof = import('./live-proof-summary').LiveProofSkippedInteractionProofPointer;

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-live-ios --config <path> --scenario <path> [--out <dir>] [--bundle <id>] [--device <udid|booted>] [--ios-dev-client-url <url>] [--ios-profile-session-transport storage|deeplink] [--run-id <id>] [--run-suffix <label>] [--compare-latest] [--fail-on-regression] [--agent-device-proof] [--argent-proof]',
    '',
    'Runs one generic iOS live proof: simctl preflight, profile-session simctl capture, optional sidecars, optional latest-trusted comparison, and aggregate live-proof artifacts.',
    'Set ASL_IOS_DEV_CLIENT_URL when an Expo dev-client shell must open a specific Metro URL before profile evidence is collected.',
    'Use --ios-profile-session-transport deeplink when profile-session control should use app URLs instead of simulator storage seeding; storage is the default deterministic startup-control transport.',
    'Use --agent-device-proof to attach scenario-declared portable driver actions through agent-device; pass --agent-device-session-mode bind when a named session should still receive the configured UDID.',
    'Use --argent-proof to attach scenario-declared Argent-compatible driver actions; set ASL_ARGENT_BIN and ASL_ARGENT_BASE_ARGS for non-global installs. iOS Argent screenshots fall back to simctl when Argent screenshot is unavailable.',
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
  const envBundleId = readStringArgOrEnv(undefined, ['ASL_IOS_APP_ID', 'ASL_EXAMPLE_IOS_APP_ID']);
  if (envBundleId) {
    return envBundleId;
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
 * Resolves how iOS live proof should deliver app-owned profile-session control.
 *
 * @param {CliArgs} args
 * @returns {'storage' | 'deeplink'}
 */
function resolveIosProfileSessionTransport(args: CliArgs): 'storage' | 'deeplink' {
  const value = readStringArgOrEnv(args['ios-profile-session-transport'], [
    'ASL_IOS_PROFILE_SESSION_TRANSPORT',
    'ASL_EXAMPLE_IOS_PROFILE_SESSION_TRANSPORT',
  ]);
  if (!value) {
    return 'storage';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'storage' || normalized === 'deeplink') {
    return normalized;
  }

  throw new Error(`Unsupported iOS profile-session transport "${value}". Use storage or deeplink.`);
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
      `iOS live proof failed for ${kind}.`,
      `Health: ${health.healthStatus ?? 'unknown'}.`,
      ...(verdict ? [`Verdict: ${verdict.verdictStatus ?? 'unknown'}.`] : []),
      `Inspect ${runDir}/agent-summary.md.`,
    ].join(' '),
  );
}

/**
 * Reports whether profile evidence is trusted enough to run sidecar interaction proofs.
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
 * Builds skipped sidecar pointers for requested runners when the profile gate failed.
 *
 * @param {{requestedRunners: string[], runIdsByRunner: Record<string, string>, scenarioId: string, profileHealthStatus: unknown, profileVerdictStatus: unknown}} options
 * @returns {SkippedInteractionProof[]}
 */
function buildSkippedInteractionProofs({
  profileHealthStatus,
  profileVerdictStatus,
  requestedRunners,
  runIdsByRunner,
  scenarioId,
}: {
  profileHealthStatus: unknown;
  profileVerdictStatus: unknown;
  requestedRunners: string[];
  runIdsByRunner: Record<string, string>;
  scenarioId: string;
}): SkippedInteractionProof[] {
  const reason = `Profile gate failed with health=${String(profileHealthStatus ?? 'unknown')} verdict=${String(profileVerdictStatus ?? 'unknown')}; sidecar interaction proof was skipped because timing and runner evidence would not be trustworthy.`;
  return requestedRunners.map((runnerId) => ({
    label: `interaction-${runnerId}`,
    nextAction: {
      code: 'fix_profile_gate',
      summary: 'Inspect the profile health and verdict before rerunning sidecar interaction proofs.',
    },
    reason,
    runId: runIdsByRunner[runnerId] ?? `${scenarioId}-ios-${runnerId}`,
    runnerId,
    scenarioId,
  }));
}

/**
 * Throws after aggregate writing when the live proof itself failed.
 *
 * @param {IosGenericLiveResult} result
 * @returns {void}
 */
function assertAggregatePassed(result: IosGenericLiveResult): void {
  const proof = readJson(result.aggregateSummary.liveProofPath);
  if (proof.status === 'passed') {
    return;
  }

  throw new Error(`iOS live proof failed. Inspect ${result.aggregateSummary.summaryPath}.`);
}

/**
 * Throws after aggregate proof writing when fail-on-regression should gate the run.
 *
 * @param {{result: IosGenericLiveResult, comparisons: Array<{label: string, status: string}>}} options
 * @returns {void}
 */
function assertNoRegressedComparisons({
  comparisons,
  result,
}: {
  comparisons: Array<{label: string; status: string}>;
  result: IosGenericLiveResult;
}): void {
  const regressed = comparisons.filter((comparison) => comparison.status === 'worse');
  if (regressed.length === 0) {
    return;
  }

  throw new Error(
    `iOS live proof found regressed comparison(s): ${regressed.map((comparison) => comparison.label).join(', ')}. Inspect ${result.aggregateSummary.summaryPath}.`,
  );
}

/**
 * Runs a generic one-scenario iOS live proof.
 *
 * @param {CliArgs} args
 * @param {IosGenericLiveOptions} [options]
 * @returns {Promise<IosGenericLiveResult>}
 */
async function runIosLiveProof(
  args: CliArgs,
  options: IosGenericLiveOptions = {},
): Promise<IosGenericLiveResult> {
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    throw new Error('Both --config and --scenario are required.');
  }

  const configPath = path.resolve(args.config);
  const scenarioPath = path.resolve(args.scenario);
  const config = readJson(configPath);
  const scenario = readJson(scenarioPath);
  const scenarioId = resolveScenarioId({ scenario, scenarioPath });
  const bundleId = resolveIosBundleId({ args, config });
  const deviceId = readStringArgOrEnv(args.device, ['ASL_IOS_UDID', 'ASL_EXAMPLE_IOS_UDID']);
  const xcrunPath = readStringArgOrEnv(args.xcrun, ['ASL_XCRUN_PATH', 'ASL_IOS_XCRUN_BIN']);
  const agentDeviceSession = readStringArgOrEnv(args['agent-device-session'], [
    'ASL_IOS_AGENT_DEVICE_SESSION',
    'ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION',
  ]);
  const agentDeviceSessionMode = readStringArgOrEnv(args['agent-device-session-mode'], [
    'ASL_IOS_AGENT_DEVICE_SESSION_MODE',
    'ASL_EXAMPLE_IOS_AGENT_DEVICE_SESSION_MODE',
  ]);
  const iosDevClientUrl = readStringArgOrEnv(args['ios-dev-client-url'], [
    'ASL_IOS_DEV_CLIENT_URL',
    'ASL_EXAMPLE_IOS_DEV_CLIENT_URL',
  ]);
  const iosDevClientWaitMs = readStringArgOrEnv(args['ios-dev-client-wait-ms'], [
    'ASL_IOS_DEV_CLIENT_WAIT_MS',
    'ASL_EXAMPLE_IOS_DEV_CLIENT_WAIT_MS',
  ]);
  const iosProfileSessionTransport = resolveIosProfileSessionTransport(args);
  const outputDir = typeof args.out === 'string' ? path.resolve(args.out) : path.resolve('artifacts/asl/ios-live');
  const runSuffix = normalizeRunSuffix(args['run-suffix']);
  const aggregateRunId = buildRunId(typeof args['run-id'] === 'string' ? args['run-id'] : 'ios-live-proof', runSuffix);
  const preflightRunId = buildRunId(`${scenarioId}-ios-preflight`, runSuffix);
  const profileRunId = buildRunId(`${scenarioId}-ios-live`, runSuffix);
  const agentDeviceRunId = buildRunId(`${scenarioId}-ios-agent-device`, runSuffix);
  const argentRunId = buildRunId(`${scenarioId}-ios-argent`, runSuffix);
  const enabledInteractionRunners = [
    ...(isEnabledFlag(args['agent-device-proof']) ? ['agent-device'] : []),
    ...(isEnabledFlag(args['argent-proof']) ? ['argent'] : []),
  ];
  const runIdsByRunner = {
    'agent-device': agentDeviceRunId,
    argent: argentRunId,
  };
  const comparisonLane = enabledInteractionRunners.length > 0
    ? `${scenarioId}-ios-live+${enabledInteractionRunners.join('+')}`
    : `${scenarioId}-ios-live`;
  const preflightDir = path.join(outputDir, '_preflight', preflightRunId);

  const preflight = await runIosSimctlCapture({
    bundleId,
    conflictingBundleIds: resolveIosConflictingBundleIds(config),
    ...(deviceId ? { device: deviceId } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    outputDir: preflightDir,
    runId: preflightRunId,
    ...(xcrunPath ? { xcrunPath } : {}),
  });
  if (preflight.health.healthStatus !== 'passed') {
    throw new Error(`iOS live proof preflight failed; inspect ${preflight.runDir}/agent-summary.md.`);
  }

  const interactionProofs: Array<{
    label: string;
    runDir: string;
    runId: string;
    runnerId: string;
    scenarioId: string;
  }> = [];
  const profile = await runProfileIos({
    config: configPath,
    ...(deviceId ? { device: deviceId } : {}),
    launch: true,
    out: outputDir,
    ...(iosDevClientUrl ? { 'ios-dev-client-url': iosDevClientUrl } : {}),
    ...(iosDevClientWaitMs ? { 'ios-dev-client-wait-ms': iosDevClientWaitMs } : {}),
    'profile-session': true,
    ...(iosProfileSessionTransport === 'storage' ? { 'profile-session-storage': true } : {}),
    'run-id': profileRunId,
    scenario: scenarioPath,
    'simctl-capture': true,
    'simctl-out': path.join(outputDir, '_ios-simctl-captures', profileRunId),
    ...(typeof args['wait-ms'] === 'string' ? { 'wait-ms': args['wait-ms'] } : {}),
    ...(bundleId ? { bundle: bundleId } : {}),
    ...(xcrunPath ? { xcrun: xcrunPath } : {}),
  }, {
    comparisonLane,
    ...(options.delay ? { delay: options.delay } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
  });
  const profileTrusted = isTrustedProfileRun({ health: profile.health, verdict: profile.verdict });

  let skippedInteractionProofs: SkippedInteractionProof[] = [];
  if (!profileTrusted) {
    skippedInteractionProofs = buildSkippedInteractionProofs({
      profileHealthStatus: profile.health.healthStatus,
      profileVerdictStatus: profile.verdict.verdictStatus,
      requestedRunners: enabledInteractionRunners,
      runIdsByRunner,
      scenarioId,
    });
  }

  if (profileTrusted && isEnabledFlag(args['agent-device-proof'])) {
    const capture = await runAgentDeviceCapture({
      ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
      app: bundleId,
      ...(options.agentDeviceExecutor ? { executor: options.agentDeviceExecutor } : {}),
      open: true,
      outputDir: path.join(outputDir, '_agent-device-captures', agentDeviceRunId),
      platform: 'ios',
      runId: agentDeviceRunId,
      scenario,
      ...(deviceId ? { udid: deviceId } : {}),
      ...(agentDeviceSession ? { session: agentDeviceSession } : {}),
      ...(agentDeviceSessionMode
        ? { sessionMode: agentDeviceSessionMode as import('./agent-device').AgentDeviceSessionMode }
        : {}),
      waitMs: parsePositiveInteger(args['agent-device-wait-ms'], 1000),
    });
    interactionProofs.push({
      label: 'interaction-agent-device',
      runDir: capture.runDir,
      runId: agentDeviceRunId,
      runnerId: 'agent-device',
      scenarioId,
    });
  }

  if (profileTrusted && isEnabledFlag(args['argent-proof'])) {
    const argentBaseArgs = parseArgentBaseArgs(process.env.ASL_ARGENT_BASE_ARGS);
    const capture = await runArgentCapture({
      app: bundleId,
      argentCommand: process.env.ASL_ARGENT_BIN || 'argent',
      ...(argentBaseArgs ? { baseArgs: argentBaseArgs } : {}),
      commandTimeoutMs: parsePositiveInteger(process.env.ASL_ARGENT_COMMAND_TIMEOUT_MS, 60_000),
      deviceId: deviceId ?? 'booted',
      ...(options.delay ? { delay: options.delay } : {}),
      ...(options.argentExecutor ? { executor: options.argentExecutor } : {}),
      iosSimctlScreenshotFallback: true,
      ...(options.executor ? { iosSimctlExecutor: options.executor } : {}),
      outputDir: path.join(outputDir, '_argent-captures', argentRunId),
      platform: 'ios',
      runId: argentRunId,
      scenario,
    });
    interactionProofs.push({
      label: 'interaction-argent',
      runDir: capture.runDir,
      runId: argentRunId,
      runnerId: 'argent',
      scenarioId,
    });
  }

  const profiles = [{
    label: scenarioId,
    runDir: profile.runDir,
    runId: profileRunId,
    scenarioId,
  }];
  const comparisons = profileTrusted && isEnabledFlag(args['compare-latest'])
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
    outputDir,
    preflightDir: preflight.runDir,
    profileDir: profile.runDir,
  };
  if (isEnabledFlag(args['fail-on-regression'])) {
    assertNoRegressedComparisons({ comparisons, result });
  }
  assertAggregatePassed(result);
  return result;
}

/**
 * Runs the generic iOS live CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  loadAslLocalEnv();
  const args = parseArgs(argv);
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  const result = await runIosLiveProof(args);
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
  assertAggregatePassed,
  assertPassedRun,
  buildRunId,
  buildSkippedInteractionProofs,
  isTrustedProfileRun,
  main,
  normalizeRunSuffix,
  readJson,
  resolveIosBundleId,
  resolveScenarioId,
  runIosLiveProof,
  usage,
};

export type {
  IosGenericLiveOptions,
  IosGenericLiveResult,
};
