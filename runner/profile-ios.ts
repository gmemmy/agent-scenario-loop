#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag } = require('./cli');
const { buildScenarioExecutionPlan } = require('../core/execution-plan');
const {
  buildProfileHealth,
  buildProfileVerdict,
  buildVerdictBudgetChecks,
  parseArgs,
  readScalarArg,
  runProfileCli,
  runProfileMobile,
  usage,
} = require('./profile-mobile');
const { runIosSimctlCapture } = require('./ios-simctl');
const { runAgentDeviceCapture } = require('./agent-device');
const { loadAslLocalEnv, readStringArgOrEnv } = require('./local-env');

type IosProfileOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  comparisonLane?: string;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./ios-simctl').CommandExecutor;
};

type IosSimctlProfileCommand = {
  command: string;
  label?: string;
  waitMs?: number;
};

type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;

const PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS = 1000;
const PROFILE_SESSION_CAPTURE_MAX_MS = 30000;
const DEFAULT_IOS_PROFILE_SESSION_STORAGE_KEY = 'agent-scenario-loop.profile-session.1';
const DEFAULT_IOS_PROFILE_COMMAND_STORAGE_KEY = 'agent-scenario-loop.profile-commands.1';
const DEFAULT_IOS_PROFILE_EVENT_STORAGE_KEY = 'agent-scenario-loop.profile-events.1';
const DEFAULT_IOS_PROFILE_SIGNAL_STORAGE_KEY = 'agent-scenario-loop.profile-signals.1';
const DEFAULT_IOS_PROFILE_SESSION_ENTRIES_STORAGE_KEY = 'agent-scenario-loop.profile-session-entries.1';

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
function isEnabled(value: string | boolean | Array<string | boolean> | undefined): boolean {
  return value === true || value === 'true';
}

/**
 * Reads a positive integer from unknown scenario adapter metadata.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Reads the number of scenario iterations that can emit app-owned truth events.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {number}
 */
function readScenarioIterationCount(scenario: Record<string, any>): number {
  return readPositiveInteger(scenario.defaultIterations, readPositiveInteger(scenario.cycles?.iterations, 1));
}

/**
 * Creates a short run id when simctl capture must share the id with profile artifacts.
 *
 * @returns {string}
 */
function createRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Resolves the simctl capture output directory for a profile run.
 *
 * @param {{args: import('./profile-mobile').CliArgs, runId: string}} options
 * @returns {string}
 */
function resolveSimctlCaptureOutputDir({
  args,
  runId,
}: {
  args: import('./profile-mobile').CliArgs;
  runId: string;
}): string {
  if (typeof args['simctl-out'] === 'string') {
    return path.resolve(args['simctl-out']);
  }

  if (typeof args.out === 'string') {
    return path.resolve(args.out, '_ios-simctl-captures', runId);
  }

  return path.resolve('artifacts/ios-simctl-captures', runId);
}

/**
 * Resolves the agent-device capture output directory for a profile run.
 *
 * @param {{args: import('./profile-mobile').CliArgs, runId: string}} options
 * @returns {string}
 */
function resolveAgentDeviceCaptureOutputDir({
  args,
  runId,
}: {
  args: import('./profile-mobile').CliArgs;
  runId: string;
}): string {
  if (typeof args['agent-device-out'] === 'string') {
    return path.resolve(args['agent-device-out']);
  }

  if (typeof args.out === 'string') {
    return path.resolve(args.out, '_agent-device-captures', runId);
  }

  return path.resolve('artifacts/agent-device-captures', runId);
}

/**
 * Resolves the iOS bundle id from explicit CLI input or project config.
 *
 * @param {{args: import('./profile-mobile').CliArgs, config: Record<string, unknown>}} options
 * @returns {string | null}
 */
function resolveIosBundleId({
  args,
  config,
}: {
  args: import('./profile-mobile').CliArgs;
  config: Record<string, any>;
}): string | null {
  if (typeof args.bundle === 'string') {
    return args.bundle;
  }

  return typeof config.app?.iosBundleId === 'string' ? config.app.iosBundleId : null;
}

/**
 * Resolves optional sibling iOS bundle ids that make simulator targeting ambiguous.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
function resolveIosConflictingBundleIds(config: Record<string, any>): string[] {
  const configured = config.app?.iosConflictingBundleIds;
  return Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
}

/**
 * Builds a profile-session deep link for the example app or another configured app.
 *
 * @param {{config: Record<string, unknown>, action: 'start' | 'command', scenario: string, runId: string, command?: string}} options
 * @returns {string}
 */
function buildProfileSessionUrl({
  action,
  command,
  config,
  runId,
  scenario,
}: {
  action: 'start' | 'command';
  command?: string;
  config: Record<string, any>;
  runId: string;
  scenario: string;
}): string {
  const scheme = typeof config.app?.profileSessionScheme === 'string'
    ? config.app.profileSessionScheme
    : typeof config.app?.scheme === 'string'
      ? config.app.scheme
      : 'app';
  const params = new URLSearchParams({ runId, scenario });
  if (action === 'command' && command) {
    params.set('command', command);
  }

  return `${scheme}://profile-session/${action}?${params.toString()}`;
}

/**
 * Reads iOS-specific wait metadata from a normalized execution step.
 *
 * @param {import('../core/execution-plan').ScenarioExecutionStep} step
 * @returns {number}
 */
function readStepWaitMs(step: ScenarioExecutionStep): number {
  const iosSimctlOptions = step.adapterOptions?.iosSimctl;
  if (iosSimctlOptions && typeof iosSimctlOptions === 'object' && !Array.isArray(iosSimctlOptions)) {
    const waitMs = (iosSimctlOptions as Record<string, unknown>).waitMs;
    if (typeof waitMs === 'number' && Number.isInteger(waitMs) && waitMs > 0) {
      return waitMs;
    }
  }

  return readPositiveInteger(step.timeoutMs, 0);
}

/**
 * Derives a storage-backed profile capture window from scenario waits and cycles.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {number}
 */
function deriveProfileSessionCaptureWaitMs(scenario: Record<string, any>): number {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  const iterations = readScenarioIterationCount(scenario);
  const perIterationWaitMs = executionPlan.steps.reduce((total: number, step: ScenarioExecutionStep) => {
    if (step.kind === 'command') {
      return total + readStepWaitMs(step);
    }
    if (step.portMethod === 'waitForTruthEvent') {
      return total + readPositiveInteger(step.timeoutMs, 0);
    }
    return total;
  }, 0);
  const derivedWaitMs = PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS + (perIterationWaitMs * iterations);

  return Math.min(Math.max(derivedWaitMs, PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS), PROFILE_SESSION_CAPTURE_MAX_MS);
}

/**
 * Resolves the iOS capture wait, keeping explicit CLI waits authoritative.
 *
 * @param {{args: import('./profile-mobile').CliArgs, scenario: Record<string, unknown>, profileSessionEnabled: boolean}} options
 * @returns {number}
 */
function resolveProfileSessionCaptureWaitMs({
  args,
  profileSessionEnabled,
  scenario,
}: {
  args: import('./profile-mobile').CliArgs;
  profileSessionEnabled: boolean;
  scenario: Record<string, any>;
}): number {
  const explicitWaitMs = readScalarArg(args['wait-ms']);
  if (explicitWaitMs !== undefined) {
    return readPositiveInteger(explicitWaitMs, 0);
  }

  return profileSessionEnabled ? deriveProfileSessionCaptureWaitMs(scenario) : 0;
}

/**
 * Expands portable scenario command steps into iOS profile-session commands.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {IosSimctlProfileCommand[]}
 */
function resolveExecutionPlanProfileCommands(scenario: Record<string, any>): IosSimctlProfileCommand[] {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  const repeat = readPositiveInteger(scenario.defaultIterations, readPositiveInteger(scenario.cycles?.iterations, 1));
  const commands = executionPlan.steps
    .filter((step: ScenarioExecutionStep) => step.portMethod === 'executeStep' && typeof step.command === 'string')
    .map((step: ScenarioExecutionStep) => ({
      command: step.command as string,
      label: step.id,
      waitMs: readStepWaitMs(step),
    }));

  return Array.from({ length: repeat }).flatMap(() => commands);
}

/**
 * Expands scenario-declared iOS commands for a simctl capture profile session.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {IosSimctlProfileCommand[]}
 */
function resolveIosSimctlProfileCommands(scenario: Record<string, any>): IosSimctlProfileCommand[] {
  const iosSimctlOptions = scenario.adapterOptions?.iosSimctl;
  if (!iosSimctlOptions || !Array.isArray(iosSimctlOptions.commands)) {
    return resolveExecutionPlanProfileCommands(scenario);
  }

  const repeat = readPositiveInteger(iosSimctlOptions.repeat, readPositiveInteger(scenario.defaultIterations, 1));
  const commands: IosSimctlProfileCommand[] = [];
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const command of iosSimctlOptions.commands) {
      if (!command || typeof command.command !== 'string') {
        continue;
      }

      commands.push({
        command: command.command,
        ...(typeof command.label === 'string' ? { label: command.label } : {}),
        waitMs: readPositiveInteger(command.waitMs, 0),
      });
    }
  }

  return commands;
}

/**
 * Returns true when the scenario asks iOS simctl capture to preserve a screenshot.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {boolean}
 */
function requiresIosSimctlScreenshot(scenario: Record<string, any>): boolean {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  return executionPlan.steps.some((step: ScenarioExecutionStep) =>
    step.driverAction === 'screenshot' || step.artifact === 'screenshot',
  );
}

/**
 * Appends one repeatable profile capture argument without losing caller-provided values.
 *
 * @param {{args: import('./profile-mobile').CliArgs, value: string}} options
 * @returns {string | boolean | Array<string | boolean>}
 */
function appendCaptureArg({
  args,
  value,
}: {
  args: import('./profile-mobile').CliArgs;
  value: string;
}): string | boolean | Array<string | boolean> {
  const existing = args.capture;
  return existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
}

/**
 * Summarizes failed simctl capture checks for CLI errors.
 *
 * @param {Record<string, unknown>} health
 * @returns {string}
 */
function summarizeFailedIosChecks(health: Record<string, unknown>): string {
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const failedChecks = checks
    .filter((check: Record<string, unknown>) => check?.status === 'failed')
    .map((check: Record<string, unknown>) => (
      typeof check.message === 'string'
        ? check.message
        : typeof check.code === 'string'
          ? check.code
          : 'unknown failure'
    ));

  return failedChecks.length > 0 ? ` Failed checks: ${failedChecks.join(' ')}` : '';
}

/**
 * Summarizes failed agent-device checks for CLI errors.
 *
 * @param {Record<string, unknown>} health
 * @returns {string}
 */
function summarizeFailedAgentDeviceChecks(health: Record<string, unknown>): string {
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const failedChecks = checks
    .filter((check: Record<string, unknown>) => check?.status === 'failed')
    .map((check: Record<string, unknown>) => (
      typeof check.message === 'string'
        ? check.message
        : typeof check.code === 'string'
          ? check.code
          : 'unknown failure'
    ));

  return failedChecks.length > 0 ? ` Failed checks: ${failedChecks.join(' ')}` : '';
}

/**
 * Appends screenshots from an agent-device capture as profile capture inputs.
 *
 * @param {{args: import('./profile-mobile').CliArgs, capture: import('./agent-device').AgentDeviceCaptureResult}} options
 * @returns {import('./profile-mobile').CliArgs}
 */
function appendAgentDeviceCaptureArgs({
  args,
  capture,
}: {
  args: import('./profile-mobile').CliArgs;
  capture: import('./agent-device').AgentDeviceCaptureResult;
}): import('./profile-mobile').CliArgs {
  let captureArg = args.capture;
  for (const screenshot of capture.captures.screenshots) {
    captureArg = appendCaptureArg({
      args: captureArg === undefined ? {} : { capture: captureArg },
      value: `screenshot:${path.join(capture.runDir, screenshot)}`,
    });
  }

  return captureArg === undefined ? args : { ...args, capture: captureArg };
}

/**
 * Runs the iOS log-ingest profile artifact pipeline.
 *
 * @param {import('./profile-mobile').CliArgs} args
 * @param {IosProfileOptions} [options]
 * @returns {Promise<import('./profile-mobile').ProfileRunResult>}
 */
async function runProfileIos(
  args: import('./profile-mobile').CliArgs,
  options: IosProfileOptions = {},
): Promise<import('./profile-mobile').ProfileRunResult> {
  if (!isEnabled(args['simctl-capture']) && !isEnabled(args['agent-device-capture'])) {
    return runProfileMobile(args, {
      ...(options.comparisonLane ? { comparisonLane: options.comparisonLane } : {}),
      defaultDriver: 'ios-simctl',
      ...(typeof args['simctl-artifacts'] === 'string' ? { interactionDriver: 'ios-simctl' } : {}),
      platform: 'ios',
    });
  }

  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    throw new Error('Both --config and --scenario are required.');
  }

  const config = readJson(path.resolve(args.config));
  const scenario = readJson(path.resolve(args.scenario));
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const profileSessionEnabled = isEnabled(args['profile-session']);
  const profileSessionStorageEnabled = isEnabled(args['profile-session-storage']);
  const profileSessionStorageKey = readStringArgOrEnv(args['ios-profile-session-storage-key'], [
    'ASL_IOS_PROFILE_SESSION_STORAGE_KEY',
    'ASL_EXAMPLE_IOS_PROFILE_SESSION_STORAGE_KEY',
  ]) ?? DEFAULT_IOS_PROFILE_SESSION_STORAGE_KEY;
  const profileCommandStorageKey = readStringArgOrEnv(args['ios-profile-command-storage-key'], [
    'ASL_IOS_PROFILE_COMMAND_STORAGE_KEY',
    'ASL_EXAMPLE_IOS_PROFILE_COMMAND_STORAGE_KEY',
  ]) ?? DEFAULT_IOS_PROFILE_COMMAND_STORAGE_KEY;
  const profileEventStorageKey = readStringArgOrEnv(args['ios-profile-event-storage-key'], [
    'ASL_IOS_PROFILE_EVENT_STORAGE_KEY',
    'ASL_EXAMPLE_IOS_PROFILE_EVENT_STORAGE_KEY',
  ]) ?? DEFAULT_IOS_PROFILE_EVENT_STORAGE_KEY;
  const profileSignalStorageKey = readStringArgOrEnv(args['ios-profile-signal-storage-key'], [
    'ASL_IOS_PROFILE_SIGNAL_STORAGE_KEY',
    'ASL_EXAMPLE_IOS_PROFILE_SIGNAL_STORAGE_KEY',
  ]) ?? DEFAULT_IOS_PROFILE_SIGNAL_STORAGE_KEY;
  const profileSessionEntriesStorageKey = readStringArgOrEnv(args['ios-profile-session-entries-storage-key'], [
    'ASL_IOS_PROFILE_SESSION_ENTRIES_STORAGE_KEY',
    'ASL_EXAMPLE_IOS_PROFILE_SESSION_ENTRIES_STORAGE_KEY',
  ]) ?? DEFAULT_IOS_PROFILE_SESSION_ENTRIES_STORAGE_KEY;
  const iosDevClientUrl = readStringArgOrEnv(args['ios-dev-client-url'], [
    'ASL_IOS_DEV_CLIENT_URL',
    'ASL_EXAMPLE_IOS_DEV_CLIENT_URL',
  ]);
  const iosDevClientWaitMs = readPositiveInteger(
    readStringArgOrEnv(args['ios-dev-client-wait-ms'], [
      'ASL_IOS_DEV_CLIENT_WAIT_MS',
      'ASL_EXAMPLE_IOS_DEV_CLIENT_WAIT_MS',
    ]),
    1000,
  );
  const scenarioName = typeof scenario.name === 'string' ? scenario.name : path.basename(args.scenario, '.json');
  const profileSessionCommands = profileSessionEnabled ? resolveIosSimctlProfileCommands(scenario) : [];
  const iosDevClientDeepLinks = iosDevClientUrl
    ? [
        {
          label: 'ios-dev-client-url',
          url: iosDevClientUrl,
          waitMs: iosDevClientWaitMs,
        },
      ]
    : [];
  const profileSessionDeepLinks = profileSessionEnabled && !profileSessionStorageEnabled
    ? [
        {
          label: 'profile-session-start',
          url: buildProfileSessionUrl({
            action: 'start',
            config,
            runId,
            scenario: scenarioName,
          }),
          waitMs: readPositiveInteger(readScalarArg(args['command-wait-ms']), 250),
        },
        ...profileSessionCommands.map((profileCommand, index) => ({
          label: profileCommand.label ?? `profile-command-${index + 1}`,
          url: buildProfileSessionUrl({
            action: 'command',
            command: profileCommand.command,
            config,
            runId,
            scenario: scenarioName,
          }),
          waitMs: profileCommand.waitMs,
        })),
      ]
    : [];
  const deepLinks = [...iosDevClientDeepLinks, ...profileSessionDeepLinks];
  const shouldLaunchWithSimctl = isEnabled(args.launch) && !(profileSessionStorageEnabled && iosDevClientUrl);
  const simctlCapture = isEnabled(args['simctl-capture'])
    ? await runIosSimctlCapture({
        bundleId: resolveIosBundleId({ args, config }),
        collectProfileStorage: profileSessionStorageEnabled,
        conflictingBundleIds: resolveIosConflictingBundleIds(config),
        deepLinks,
        ...(options.delay ? { delay: options.delay } : {}),
        ...(typeof args.device === 'string' ? { device: args.device } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
        launch: shouldLaunchWithSimctl,
        ...(typeof args['log-last'] === 'string' ? { logLast: args['log-last'] } : {}),
        outputDir: resolveSimctlCaptureOutputDir({ args, runId }),
        ...(profileSessionStorageEnabled
          ? {
              profileStorageKeys: {
                command: profileCommandStorageKey,
                event: profileEventStorageKey,
                session: profileSessionStorageKey,
                sessionEntries: profileSessionEntriesStorageKey,
                signal: profileSignalStorageKey,
              },
              profileSessionStorage: {
                commands: profileSessionCommands.map((profileCommand, index) => ({
                  command: profileCommand.command,
                  id: `ios-storage-command-${index + 1}`,
                  ...(typeof profileCommand.label === 'string' ? { label: profileCommand.label } : {}),
                })),
                runId,
                scenario: scenarioName,
              },
              terminateBeforeLaunch: true,
            }
          : {
              terminateBeforeLaunch: isEnabled(args['terminate-before-launch']),
            }),
        runId,
        screenshot: isEnabled(args.screenshot) || requiresIosSimctlScreenshot(scenario),
        waitMs: resolveProfileSessionCaptureWaitMs({
          args,
          profileSessionEnabled,
          scenario,
        }),
        ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
      })
    : null;

  if (simctlCapture && simctlCapture.health.healthStatus !== 'passed') {
    throw new Error(
      `iOS simctl capture failed; inspect ${simctlCapture.runDir}/agent-summary.md.${summarizeFailedIosChecks(simctlCapture.health)}`,
    );
  }

  const agentDeviceCapture = isEnabled(args['agent-device-capture'])
    ? await runAgentDeviceCapture({
        ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
        app: typeof args['agent-device-app'] === 'string'
          ? args['agent-device-app']
          : resolveIosBundleId({ args, config }),
        ...(options.agentDeviceExecutor ? { executor: options.agentDeviceExecutor } : {}),
        ...(typeof args['agent-device-device'] === 'string' ? { device: args['agent-device-device'] } : {}),
        ...(typeof args['agent-device-session'] === 'string' ? { session: args['agent-device-session'] } : {}),
        ...(typeof args['agent-device-session-mode'] === 'string'
          ? { sessionMode: args['agent-device-session-mode'] as import('./agent-device').AgentDeviceSessionMode }
          : {}),
        ...(typeof args.device === 'string' ? { udid: args.device } : {}),
        open: isEnabled(args['agent-device-open']),
        outputDir: resolveAgentDeviceCaptureOutputDir({ args, runId }),
        platform: 'ios',
        runId,
        scenario,
        waitMs: readPositiveInteger(readScalarArg(args['agent-device-wait-ms']), 0),
      })
    : null;

  if (agentDeviceCapture && agentDeviceCapture.health.healthStatus !== 'passed') {
    throw new Error(
      `agent-device capture failed; inspect ${agentDeviceCapture.runDir}/agent-summary.md.${summarizeFailedAgentDeviceChecks(agentDeviceCapture.health)}`,
    );
  }

  const baseProfileArgs: import('./profile-mobile').CliArgs = {
    ...args,
    'run-id': runId,
    ...(simctlCapture ? { 'simctl-artifacts': simctlCapture.runDir } : {}),
    ...(simctlCapture?.captures.screenshot
      ? { capture: appendCaptureArg({
          args,
          value: `screenshot:${path.join(simctlCapture.runDir, simctlCapture.captures.screenshot)}`,
        }) }
      : {}),
  };
  if (simctlCapture) {
    delete baseProfileArgs.events;
  }
  const profileArgs = agentDeviceCapture
    ? appendAgentDeviceCaptureArgs({ args: baseProfileArgs, capture: agentDeviceCapture })
    : baseProfileArgs;

  return runProfileMobile(profileArgs, {
    ...(options.comparisonLane ? { comparisonLane: options.comparisonLane } : {}),
    defaultDriver: 'ios-simctl',
    interactionDriver: agentDeviceCapture ? 'agent-device' : 'ios-simctl',
    platform: 'ios',
  });
}

/**
 * Runs the profile-ios CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage({ binaryName: 'asl-profile-ios', output: process.stdout, platform: 'ios' });
    return;
  }

  loadAslLocalEnv();
  const args = parseArgs(argv);
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    usage({ binaryName: 'asl-profile-ios', platform: 'ios' });
    process.exitCode = 1;
    return;
  }

  const result = await runProfileIos(args);
  process.stdout.write(`${result.runDir}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildProfileHealth,
  buildProfileVerdict,
  buildVerdictBudgetChecks,
  buildProfileSessionUrl,
  deriveProfileSessionCaptureWaitMs,
  main,
  parseArgs,
  resolveIosBundleId,
  resolveIosConflictingBundleIds,
  resolveIosSimctlProfileCommands,
  resolveProfileSessionCaptureWaitMs,
  resolveSimctlCaptureOutputDir,
  requiresIosSimctlScreenshot,
  runProfileIos,
  summarizeFailedIosChecks,
  usage,
};

export type {
  CliArgs,
  ProfileRunResult,
} from './profile-mobile';
