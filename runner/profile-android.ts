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
  readScalarArg,
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

type AndroidAdbDriverStep = import('./android-adb').AndroidAdbDriverStep;
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
 * Reads Android adb adapter metadata from a normalized scenario step.
 *
 * @param {import('../core/execution-plan').ScenarioExecutionStep} step
 * @returns {Record<string, unknown>}
 */
function readAndroidAdbStepOptions(step: ScenarioExecutionStep): Record<string, unknown> {
  const androidAdbOptions = step.adapterOptions?.androidAdb;
  return androidAdbOptions && typeof androidAdbOptions === 'object' && !Array.isArray(androidAdbOptions)
    ? androidAdbOptions as Record<string, unknown>
    : {};
}

/**
 * Reads a finite number from Android adb adapter metadata.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Returns true when a normalized execution step has a portable selector adb can try to resolve.
 *
 * @param {unknown} value
 * @returns {value is import('./android-adb-driver').AndroidSelector}
 */
function isAndroidSelector(value: unknown): value is import('./android-adb-driver').AndroidSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const selector = value as Record<string, unknown>;
  return typeof selector.kind === 'string' && typeof selector.value === 'string' && selector.value.length > 0;
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
 * Expands normalized scenario evidence steps into Android adb driver actions.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {import('./android-adb').AndroidAdbDriverStep[]}
 */
function resolveAndroidAdbDriverSteps(scenario: Record<string, any>): AndroidAdbDriverStep[] {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  let readLogsIndex = 0;
  return executionPlan.steps
    .filter((step: ScenarioExecutionStep) =>
      ['assertVisible', 'inspectTree', 'readLogs', 'record', 'screenshot', 'scroll', 'tap'].includes(String(step.driverAction)),
    )
    .map((step: ScenarioExecutionStep) => {
      const androidAdbOptions = readAndroidAdbStepOptions(step);
      if (step.driverAction === 'readLogs') {
        readLogsIndex += 1;
      }
      const rawFileName = typeof androidAdbOptions.rawFileName === 'string' && androidAdbOptions.rawFileName.length > 0
        ? androidAdbOptions.rawFileName
        : step.driverAction === 'readLogs'
          ? readLogsIndex === 1
            ? 'adb-logcat.txt'
            : `adb-logcat-${readLogsIndex}.txt`
        : undefined;

      return {
        driverAction: step.driverAction as AndroidAdbDriverStep['driverAction'],
        ...(typeof androidAdbOptions.captureFileName === 'string' && androidAdbOptions.captureFileName.length > 0
          ? { captureFileName: androidAdbOptions.captureFileName }
          : {}),
        ...(typeof readFiniteNumber(androidAdbOptions.durationSeconds) === 'number'
          ? { durationSeconds: readFiniteNumber(androidAdbOptions.durationSeconds) }
          : {}),
        ...(step.driverAction === 'readLogs' ? { lines: readPositiveInteger(androidAdbOptions.logcatLines, 1000) } : {}),
        ...(typeof rawFileName === 'string' ? { rawFileName } : {}),
        required: step.required,
        ...(isAndroidSelector(step.selector) ? { selector: step.selector } : {}),
        stepId: step.id,
        ...(typeof readFiniteNumber(androidAdbOptions.durationMs) === 'number'
          ? { durationMs: readFiniteNumber(androidAdbOptions.durationMs) }
          : {}),
        ...(typeof readFiniteNumber(androidAdbOptions.endX) === 'number' ? { endX: readFiniteNumber(androidAdbOptions.endX) } : {}),
        ...(typeof readFiniteNumber(androidAdbOptions.endY) === 'number' ? { endY: readFiniteNumber(androidAdbOptions.endY) } : {}),
        ...(typeof readFiniteNumber(androidAdbOptions.startX) === 'number' ? { startX: readFiniteNumber(androidAdbOptions.startX) } : {}),
        ...(typeof readFiniteNumber(androidAdbOptions.startY) === 'number' ? { startY: readFiniteNumber(androidAdbOptions.startY) } : {}),
        ...(typeof androidAdbOptions.remotePath === 'string' && androidAdbOptions.remotePath.length > 0
          ? { remotePath: androidAdbOptions.remotePath }
          : {}),
        waitMs: readStepWaitMs(step),
        ...(typeof readFiniteNumber(androidAdbOptions.x) === 'number' ? { x: readFiniteNumber(androidAdbOptions.x) } : {}),
        ...(typeof readFiniteNumber(androidAdbOptions.y) === 'number' ? { y: readFiniteNumber(androidAdbOptions.y) } : {}),
      };
    });
}

/**
 * Reads the first video capture produced by adb driver actions.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {string | null}
 */
function readAndroidAdbVideoCapturePath(metadata: Record<string, unknown>): string | null {
  const actions = Array.isArray(metadata.driverActions) ? metadata.driverActions : [];
  const recordAction = actions.find((action: Record<string, unknown>) =>
    action.driverAction === 'record' &&
    action.exitCode === 0 &&
    typeof action.capturePath === 'string',
  );

  return typeof recordAction?.capturePath === 'string' ? recordAction.capturePath : null;
}

/**
 * Returns profile-time validation errors for adb driver steps.
 *
 * @param {import('./android-adb').AndroidAdbDriverStep[]} driverSteps
 * @returns {string[]}
 */
function validateAndroidAdbDriverSteps(driverSteps: AndroidAdbDriverStep[]): string[] {
  const errors: string[] = [];
  for (const step of driverSteps) {
    const stepLabel = step.stepId ? `step \`${step.stepId}\`` : 'unnamed step';
    if (step.driverAction === 'tap' && !step.selector && (typeof step.x !== 'number' || typeof step.y !== 'number')) {
      errors.push(`${stepLabel} uses driverAction \`tap\` but is missing adapterOptions.androidAdb.x/y.`);
    }
    if (step.driverAction === 'assertVisible' && !step.selector) {
      errors.push(`${stepLabel} uses driverAction \`assertVisible\` but is missing a portable selector.`);
    }
    if (
      step.driverAction === 'scroll' &&
      !step.selector &&
      (
        typeof step.startX !== 'number' ||
        typeof step.startY !== 'number' ||
        typeof step.endX !== 'number' ||
        typeof step.endY !== 'number'
      )
    ) {
      errors.push(
        `${stepLabel} uses driverAction \`scroll\` but is missing adapterOptions.androidAdb.startX/startY/endX/endY.`,
      );
    }
  }

  return errors;
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
  const driverSteps = resolveAndroidAdbDriverSteps(scenario);
  const driverStepErrors = validateAndroidAdbDriverSteps(driverSteps);
  if (driverStepErrors.length > 0) {
    throw new Error(`Invalid Android adb driver step metadata: ${driverStepErrors.join(' ')}`);
  }
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
          waitMs: parsePositiveInteger(readScalarArg(args['command-wait-ms']), 250),
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
    driverSteps,
    launch: isEnabled(args.launch),
    logcatLines: parsePositiveInteger(readScalarArg(args['logcat-lines']), 1000),
    outputDir: resolveAdbCaptureOutputDir({ args, runId }),
    packageName: resolveAndroidPackageName({ args, config }),
    ...(typeof args['react-native-debug-host'] === 'string'
      ? { reactNativeDebugHost: args['react-native-debug-host'] }
      : {}),
    runId,
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    waitMs: parsePositiveInteger(readScalarArg(args['wait-ms']), 0),
  });

  if (adbCapture.health.healthStatus !== 'passed') {
    throw new Error(
      `Android adb capture failed; inspect ${adbCapture.runDir}/agent-summary.md.${summarizeFailedAndroidChecks(adbCapture.health)}`,
    );
  }

  const videoCapturePath = readAndroidAdbVideoCapturePath(adbCapture.metadata);

  return runProfileMobile({
    ...args,
    'adb-artifacts': adbCapture.runDir,
    ...(videoCapturePath
      ? {
          capture: appendCaptureArg({
            args,
            value: `video:${path.join(adbCapture.runDir, videoCapturePath)}`,
          }),
        }
      : {}),
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
  resolveAndroidAdbDriverSteps,
  readAndroidAdbVideoCapturePath,
  validateAndroidAdbDriverSteps,
  runProfileAndroid,
  summarizeFailedAndroidChecks,
  usage,
};
