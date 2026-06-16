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
const { buildScenarioExecutionPlan } = require('../core/execution-plan');

type AndroidProfileOptions = {
  delay?: (ms: number) => Promise<void>;
  executor?: import('./android-adb').CommandExecutor;
};

type AndroidAdbProfileCommand = {
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
function isEnabled(value: string | boolean | undefined): boolean {
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
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
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
 * Reads Android-specific wait metadata from a normalized execution step.
 *
 * @param {import('../core/execution-plan').ScenarioExecutionStep} step
 * @returns {number}
 */
function readStepWaitMs(step: ScenarioExecutionStep): number {
  const androidAdbOptions = step.adapterOptions?.androidAdb;
  if (androidAdbOptions && typeof androidAdbOptions === 'object' && !Array.isArray(androidAdbOptions)) {
    const waitMs = (androidAdbOptions as Record<string, unknown>).waitMs;
    if (typeof waitMs === 'number' && Number.isInteger(waitMs) && waitMs > 0) {
      return waitMs;
    }
  }

  return readPositiveInteger(step.timeoutMs, 0);
}

/**
 * Expands portable scenario command steps into Android profile-session commands.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {AndroidAdbProfileCommand[]}
 */
function resolveExecutionPlanProfileCommands(scenario: Record<string, any>): AndroidAdbProfileCommand[] {
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
 * Expands scenario-declared Android commands for an adb capture profile session.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {AndroidAdbProfileCommand[]}
 */
function resolveAndroidAdbProfileCommands(scenario: Record<string, any>): AndroidAdbProfileCommand[] {
  const androidAdbOptions = scenario.adapterOptions?.androidAdb;
  if (!androidAdbOptions || !Array.isArray(androidAdbOptions.commands)) {
    return resolveExecutionPlanProfileCommands(scenario);
  }

  const repeat = readPositiveInteger(androidAdbOptions.repeat, readPositiveInteger(scenario.defaultIterations, 1));
  const commands: AndroidAdbProfileCommand[] = [];
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const command of androidAdbOptions.commands) {
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
 * Summarizes failed adb capture checks for CLI errors.
 *
 * @param {Record<string, unknown>} health
 * @returns {string}
 */
function summarizeFailedAndroidChecks(health: Record<string, unknown>): string {
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
 * Runs the Android profile artifact pipeline.
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
      ...(typeof args['adb-artifacts'] === 'string' ? { interactionDriver: 'adb-logcat' } : {}),
      platform: 'android',
    });
  }

  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    throw new Error('Both --config and --scenario are required.');
  }

  const config = readJson(path.resolve(args.config));
  const scenario = readJson(path.resolve(args.scenario));
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const profileSessionEnabled = isEnabled(args['profile-session']);
  const scenarioName = typeof scenario.name === 'string' ? scenario.name : path.basename(args.scenario, '.json');
  const profileSessionDeepLinks = profileSessionEnabled
    ? [
        {
          label: 'profile-session-start',
          url: buildProfileSessionUrl({
            action: 'start',
            config,
            runId,
            scenario: scenarioName,
          }),
          waitMs: parsePositiveInteger(args['command-wait-ms'], 250),
        },
        ...resolveAndroidAdbProfileCommands(scenario).map((profileCommand, index) => ({
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
  const adbCapture = await runAndroidAdbPreflight({
    ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
    captureLogcat: true,
    clearLogcat: isEnabled(args['clear-logcat']),
    deepLinks: profileSessionDeepLinks,
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
    throw new Error(
      `Android adb capture failed; inspect ${adbCapture.runDir}/agent-summary.md.${summarizeFailedAndroidChecks(adbCapture.health)}`,
    );
  }

  return runProfileMobile({
    ...args,
    'adb-artifacts': adbCapture.runDir,
    events: undefined,
    'run-id': runId,
  }, {
    defaultDriver: 'adb-logcat',
    interactionDriver: 'adb-logcat',
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
  resolveAndroidAdbProfileCommands,
  runProfileAndroid,
  summarizeFailedAndroidChecks,
  usage,
};
