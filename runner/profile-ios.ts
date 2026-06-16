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

type IosProfileOptions = {
  delay?: (ms: number) => Promise<void>;
  executor?: import('./ios-simctl').CommandExecutor;
};

type IosSimctlProfileCommand = {
  command: string;
  label?: string;
  waitMs?: number;
};

type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;

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
  if (!isEnabled(args['simctl-capture'])) {
    return runProfileMobile(args, {
      defaultDriver: 'xcodebuildmcp',
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
  const scenarioName = typeof scenario.name === 'string' ? scenario.name : path.basename(args.scenario, '.json');
  const profileSessionCommands = profileSessionEnabled ? resolveIosSimctlProfileCommands(scenario) : [];
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
  const simctlCapture = await runIosSimctlCapture({
    bundleId: resolveIosBundleId({ args, config }),
    collectProfileStorage: profileSessionStorageEnabled,
    deepLinks: profileSessionDeepLinks,
    ...(options.delay ? { delay: options.delay } : {}),
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    ...(options.executor ? { executor: options.executor } : {}),
    launch: isEnabled(args.launch),
    ...(typeof args['log-last'] === 'string' ? { logLast: args['log-last'] } : {}),
    outputDir: resolveSimctlCaptureOutputDir({ args, runId }),
    ...(profileSessionStorageEnabled
      ? {
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
    waitMs: readPositiveInteger(readScalarArg(args['wait-ms']), 0),
    ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
  });

  if (simctlCapture.health.healthStatus !== 'passed') {
    throw new Error(
      `iOS simctl capture failed; inspect ${simctlCapture.runDir}/agent-summary.md.${summarizeFailedIosChecks(simctlCapture.health)}`,
    );
  }

  return runProfileMobile({
    ...args,
    events: undefined,
    'run-id': runId,
    'simctl-artifacts': simctlCapture.runDir,
  }, {
    defaultDriver: 'xcodebuildmcp',
    interactionDriver: 'ios-simctl',
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
  main,
  parseArgs,
  resolveIosBundleId,
  resolveIosSimctlProfileCommands,
  resolveSimctlCaptureOutputDir,
  runProfileIos,
  summarizeFailedIosChecks,
  usage,
};

export type {
  CliArgs,
  ProfileRunResult,
} from './profile-mobile';
