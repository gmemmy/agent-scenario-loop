#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag } = require('./cli');
const {
  ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER,
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
const { runAgentDeviceCapture } = require('./agent-device');
const { loadAslLocalEnv, readStringArgOrEnv } = require('./local-env');

type AndroidProfileOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  comparisonLane?: string;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./android-adb').CommandExecutor;
};

type AndroidAdbProfileCommand = {
  command: string;
  label?: string;
  queueId?: string;
  sequence?: number;
  waitForMilestone?: string;
  waitMs?: number;
  waitTimeoutMs?: number;
};

type AndroidAdbDriverStep = import('./android-adb').AndroidAdbDriverStep;
type AndroidAsyncStorageWrite = import('./android-adb').AndroidAsyncStorageWrite;
type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;

const PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS = 1000;
const PROFILE_SESSION_CAPTURE_MAX_MS = 120000;
const DEFAULT_ANDROID_PROFILE_SESSION_STORAGE_KEY = 'agent-scenario-loop.profile-session.1';
const DEFAULT_ANDROID_PROFILE_COMMAND_STORAGE_KEY = 'agent-scenario-loop.profile-commands.1';

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
 * Reads the number of scenario iterations that can emit app-owned truth events.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {number}
 */
function readScenarioIterationCount(scenario: Record<string, any>): number {
  return readPositiveInteger(scenario.defaultIterations, readPositiveInteger(scenario.cycles?.iterations, 1));
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
  queueId,
  runId,
  scenario,
  sequence,
  waitForMilestone,
  waitTimeoutMs,
}: {
  action: 'start' | 'command';
  command?: string;
  config: Record<string, any>;
  queueId?: string;
  runId: string;
  scenario: string;
  sequence?: number;
  waitForMilestone?: string;
  waitTimeoutMs?: number;
}): string {
  const scheme = typeof config.app?.profileSessionScheme === 'string'
    ? config.app.profileSessionScheme
    : typeof config.app?.scheme === 'string'
      ? config.app.scheme
      : 'app';
  const params = new URLSearchParams({ runId, scenario });
  if (action === 'command' && command) {
    params.set('command', command);
    if (typeof sequence === 'number') {
      params.set('sequence', String(sequence));
    }
    if (queueId) {
      params.set('queueId', queueId);
    }
    if (waitForMilestone) {
      params.set('waitForMilestone', waitForMilestone);
    }
    if (typeof waitTimeoutMs === 'number') {
      params.set('waitTimeoutMs', String(waitTimeoutMs));
    }
  }

  return `${scheme}://profile-session/${action}?${params.toString()}`;
}

/**
 * Builds Android AsyncStorage writes for one profile-session run.
 *
 * @param {{commands: AndroidAdbProfileCommand[], commandStorageKey: string, commandWaitMs: number, runId: string, scenario: string, sessionStorageKey: string}} options
 * @returns {import('./android-adb').AndroidAsyncStorageWrite[]}
 */
function buildProfileSessionStorageWrites({
  commands,
  commandStorageKey,
  commandWaitMs,
  runId,
  scenario,
  sessionStorageKey,
}: {
  commands: AndroidAdbProfileCommand[];
  commandStorageKey: string;
  commandWaitMs: number;
  runId: string;
  scenario: string;
  sessionStorageKey: string;
}): AndroidAsyncStorageWrite[] {
  const timestampBase = Date.now();
  const storedCommands = commands.map((profileCommand, index) => {
    const timestamp = timestampBase + index + 1;
    return {
      id: `${timestamp}-${scenario}-${profileCommand.command}`,
      scenario,
      runId,
      command: profileCommand.command,
      ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
      ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
      ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
      ...(typeof profileCommand.waitTimeoutMs === 'number' ? { waitTimeoutMs: profileCommand.waitTimeoutMs } : {}),
      timestamp,
    };
  });
  const commandWaitMsTotal = commands.reduce((total, profileCommand) => (
    total + (typeof profileCommand.waitMs === 'number' && profileCommand.waitMs > 0 ? profileCommand.waitMs : 0)
  ), 0);

  return [
    {
      clearKeys: [commandStorageKey],
      key: sessionStorageKey,
      label: 'profile-session-start',
      value: JSON.stringify({
        active: true,
        scenario,
        runId,
        startedAt: ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER,
      }).replace(`"${ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER}"`, ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER),
      waitMs: commandWaitMs,
    },
    ...(storedCommands.length > 0
      ? [{
          key: commandStorageKey,
          label: 'profile-command-queue',
          value: JSON.stringify(storedCommands),
          ...(commandWaitMsTotal > 0 ? { waitMs: commandWaitMsTotal } : {}),
        }]
      : []),
  ];
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
 * Derives a logcat-backed profile capture window from scenario waits and cycles.
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
 * Resolves the Android adb capture wait, keeping explicit CLI waits authoritative.
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
    return parsePositiveInteger(explicitWaitMs, 0);
  }

  return profileSessionEnabled ? deriveProfileSessionCaptureWaitMs(scenario) : 0;
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
  const commands: AndroidAdbProfileCommand[] = [];
  for (const [index, step] of executionPlan.steps.entries()) {
    if (step.portMethod !== 'executeStep' || typeof step.command !== 'string') {
      continue;
    }

    const nextStep = executionPlan.steps[index + 1];
    commands.push({
      command: step.command as string,
      label: step.id,
      queueId: scenario.id ?? scenario.name,
      waitMs: readStepWaitMs(step),
      ...(nextStep?.portMethod === 'waitForTruthEvent' && typeof nextStep.milestone === 'string'
        ? {
            waitForMilestone: nextStep.milestone,
            waitTimeoutMs: readPositiveInteger(nextStep.timeoutMs, 0),
          }
        : {}),
    });
  }

  return Array.from({ length: repeat }).flatMap((_, iteration) =>
    commands.map((command, commandIndex) => ({
      ...command,
      sequence: (iteration * commands.length) + commandIndex + 1,
    })),
  );
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
        queueId: scenario.id ?? scenario.name,
        sequence: commands.length + 1,
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
  if (!isEnabled(args['adb-capture']) && !isEnabled(args['agent-device-capture'])) {
    return runProfileMobile(args, {
      ...(options.comparisonLane ? { comparisonLane: options.comparisonLane } : {}),
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
  const adbCaptureEnabled = isEnabled(args['adb-capture']);
  const agentDeviceCaptureEnabled = isEnabled(args['agent-device-capture']);
  const profileSessionEnabled = isEnabled(args['profile-session']);
  const profileSessionStorageEnabled = isEnabled(args['android-profile-session-storage']);
  const profileSessionStorageKey = readStringArgOrEnv(args['android-profile-session-storage-key'], [
    'ASL_ANDROID_PROFILE_SESSION_STORAGE_KEY',
    'ASL_EXAMPLE_ANDROID_PROFILE_SESSION_STORAGE_KEY',
  ]) ?? DEFAULT_ANDROID_PROFILE_SESSION_STORAGE_KEY;
  const profileCommandStorageKey = readStringArgOrEnv(args['android-profile-command-storage-key'], [
    'ASL_ANDROID_PROFILE_COMMAND_STORAGE_KEY',
    'ASL_EXAMPLE_ANDROID_PROFILE_COMMAND_STORAGE_KEY',
  ]) ?? DEFAULT_ANDROID_PROFILE_COMMAND_STORAGE_KEY;
  const androidDevClientUrl = readStringArgOrEnv(args['android-dev-client-url'], [
    'ASL_ANDROID_DEV_CLIENT_URL',
    'ASL_EXAMPLE_ANDROID_DEV_CLIENT_URL',
  ]);
  const androidDevClientWaitMs = parsePositiveInteger(
    readStringArgOrEnv(args['android-dev-client-wait-ms'], [
      'ASL_ANDROID_DEV_CLIENT_WAIT_MS',
      'ASL_EXAMPLE_ANDROID_DEV_CLIENT_WAIT_MS',
    ]),
    1000,
  );
  const androidDevClientReadyPattern = readStringArgOrEnv(args['android-dev-client-ready-pattern'], [
    'ASL_ANDROID_DEV_CLIENT_READY_PATTERN',
    'ASL_EXAMPLE_ANDROID_DEV_CLIENT_READY_PATTERN',
  ]);
  const androidDevClientReadyQuietMs = parsePositiveInteger(
    readStringArgOrEnv(args['android-dev-client-ready-quiet-ms'], [
      'ASL_ANDROID_DEV_CLIENT_READY_QUIET_MS',
      'ASL_EXAMPLE_ANDROID_DEV_CLIENT_READY_QUIET_MS',
    ]),
    0,
  );
  const androidDevClientReadyTimeoutMs = parsePositiveInteger(
    readStringArgOrEnv(args['android-dev-client-ready-timeout-ms'], [
      'ASL_ANDROID_DEV_CLIENT_READY_TIMEOUT_MS',
      'ASL_EXAMPLE_ANDROID_DEV_CLIENT_READY_TIMEOUT_MS',
    ]),
    60000,
  );
  const scenarioName = typeof scenario.name === 'string' ? scenario.name : path.basename(args.scenario, '.json');
  const driverSteps = adbCaptureEnabled ? resolveAndroidAdbDriverSteps(scenario) : [];
  if (adbCaptureEnabled) {
    const driverStepErrors = validateAndroidAdbDriverSteps(driverSteps);
    if (driverStepErrors.length > 0) {
      throw new Error(`Invalid Android adb driver step metadata: ${driverStepErrors.join(' ')}`);
    }
  }
  const profileSessionCommands = profileSessionEnabled ? resolveAndroidAdbProfileCommands(scenario) : [];
  const commandWaitMs = parsePositiveInteger(readScalarArg(args['command-wait-ms']), 250);
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
          waitMs: commandWaitMs,
        },
        ...profileSessionCommands.map((profileCommand, index) => ({
          label: profileCommand.label ?? `profile-command-${index + 1}`,
          url: buildProfileSessionUrl({
            action: 'command',
            command: profileCommand.command,
            config,
            runId,
            scenario: scenarioName,
            ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
            ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
            ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
            ...(typeof profileCommand.waitTimeoutMs === 'number' ? { waitTimeoutMs: profileCommand.waitTimeoutMs } : {}),
          }),
          waitMs: profileCommand.waitMs,
        })),
      ]
    : [];
  const profileSessionStorageWrites = profileSessionEnabled && profileSessionStorageEnabled
    ? buildProfileSessionStorageWrites({
        commandStorageKey: profileCommandStorageKey,
        commandWaitMs,
        commands: profileSessionCommands,
        runId,
        scenario: scenarioName,
        sessionStorageKey: profileSessionStorageKey,
      })
    : [];
  const startupDeepLinks = androidDevClientUrl
    ? [
        {
          label: 'android-dev-client-url',
          ...(androidDevClientReadyPattern ? { readyLogPattern: androidDevClientReadyPattern } : {}),
          readyLogQuietMs: androidDevClientReadyQuietMs,
          readyLogTimeoutMs: androidDevClientReadyTimeoutMs,
          url: androidDevClientUrl,
          waitMs: androidDevClientWaitMs,
        },
      ]
    : [];
  const adbCapture = adbCaptureEnabled
    ? await runAndroidAdbPreflight({
        ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
        captureLogcat: true,
        clearLogcat: isEnabled(args['clear-logcat']),
        deepLinks: profileSessionDeepLinks,
        ...(options.delay ? { delay: options.delay } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
        driverSteps,
        launch: isEnabled(args.launch),
        launchWaitMs: parsePositiveInteger(readScalarArg(args['launch-wait-ms']), 0),
        logcatLines: parsePositiveInteger(readScalarArg(args['logcat-lines']), 1000),
        outputDir: resolveAdbCaptureOutputDir({ args, runId }),
        packageName: resolveAndroidPackageName({ args, config }),
        ...(typeof args['react-native-debug-host'] === 'string'
          ? { reactNativeDebugHost: args['react-native-debug-host'] }
          : {}),
        runId,
        ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
        startupDeepLinks,
        storageWrites: profileSessionStorageWrites,
        waitMs: resolveProfileSessionCaptureWaitMs({
          args,
          profileSessionEnabled,
          scenario,
        }),
      })
    : null;

  if (adbCapture && adbCapture.health.healthStatus !== 'passed') {
    throw new Error(
      `Android adb capture failed; inspect ${adbCapture.runDir}/agent-summary.md.${summarizeFailedAndroidChecks(adbCapture.health)}`,
    );
  }

  const agentDeviceCapture = agentDeviceCaptureEnabled
    ? await runAgentDeviceCapture({
        ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
        app: typeof args['agent-device-app'] === 'string'
          ? args['agent-device-app']
          : resolveAndroidPackageName({ args, config }),
        ...(options.agentDeviceExecutor ? { executor: options.agentDeviceExecutor } : {}),
        ...(typeof args['agent-device-device'] === 'string' ? { device: args['agent-device-device'] } : {}),
        ...(typeof args['agent-device-session'] === 'string' ? { session: args['agent-device-session'] } : {}),
        ...(typeof args['agent-device-session-mode'] === 'string'
          ? { sessionMode: args['agent-device-session-mode'] as import('./agent-device').AgentDeviceSessionMode }
          : {}),
        ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
        open: isEnabled(args['agent-device-open']),
        outputDir: resolveAgentDeviceCaptureOutputDir({ args, runId }),
        platform: 'android',
        runId,
        scenario,
        waitMs: parsePositiveInteger(readScalarArg(args['agent-device-wait-ms']), 0),
      })
    : null;

  if (agentDeviceCapture && agentDeviceCapture.health.healthStatus !== 'passed') {
    throw new Error(
      `agent-device capture failed; inspect ${agentDeviceCapture.runDir}/agent-summary.md.${summarizeFailedAgentDeviceChecks(agentDeviceCapture.health)}`,
    );
  }

  const videoCapturePath = adbCapture ? readAndroidAdbVideoCapturePath(adbCapture.metadata) : null;
  const baseProfileArgs: import('./profile-mobile').CliArgs = {
    ...args,
    ...(adbCapture ? { 'adb-artifacts': adbCapture.runDir } : {}),
    ...(videoCapturePath
      ? {
          capture: appendCaptureArg({
            args,
            value: `video:${path.join(adbCapture?.runDir ?? '', videoCapturePath)}`,
          }),
        }
      : {}),
    'run-id': runId,
  };
  if (adbCapture) {
    delete baseProfileArgs.events;
  }
  const profileArgs = agentDeviceCapture
    ? appendAgentDeviceCaptureArgs({ args: baseProfileArgs, capture: agentDeviceCapture })
    : baseProfileArgs;

  return runProfileMobile(profileArgs, {
    ...(options.comparisonLane ? { comparisonLane: options.comparisonLane } : {}),
    defaultDriver: 'adb-logcat',
    interactionDriver: agentDeviceCapture ? 'agent-device' : 'adb-logcat',
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
  loadAslLocalEnv();
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
  deriveProfileSessionCaptureWaitMs,
  main,
  parseArgs,
  resolveAndroidAdbProfileCommands,
  resolveAndroidAdbDriverSteps,
  resolveProfileSessionCaptureWaitMs,
  readAndroidAdbVideoCapturePath,
  validateAndroidAdbDriverSteps,
  runProfileAndroid,
  summarizeFailedAndroidChecks,
  usage,
};
