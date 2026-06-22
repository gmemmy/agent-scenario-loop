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
  resolveArtifactRoot,
  resolveProfileScenarioName,
  runProfileCompatibilityPreflight,
  runProfileMobile,
  usage,
} = require('./profile-mobile');
const { buildScenarioExecutionPlan } = require('../core/execution-plan');
const { PROFILE_SESSION_STORAGE_KEYS } = require('../profile-session-storage');
const { runAgentDeviceCapture } = require('./agent-device');
const { assertConcreteMobileAppId } = require('./app-identity');
const { loadAslLocalEnv, readStringArgOrEnv } = require('./local-env');

type AndroidProfileOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  comparisonLane?: string;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./android-adb').CommandExecutor;
};

type AndroidAdbProfileCommand = {
  command: string;
  commandId?: string;
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
const PROFILE_SESSION_STORAGE_CAPTURE_BOOTSTRAP_MS = 15000;
const PROFILE_SESSION_CAPTURE_MAX_MS = 120000;
const PROFILE_SESSION_LOGCAT_MIN_LINES = 1000;
const PROFILE_SESSION_LOGCAT_MAX_LINES = 20000;
const PROFILE_SESSION_LOGCAT_LINES_PER_COMMAND = 300;
const DEFAULT_ANDROID_PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.session;
const DEFAULT_ANDROID_PROFILE_COMMAND_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.command;
const DEFAULT_ANDROID_DEV_CLIENT_READY_PATTERN = 'Running "main"';
const MANIFEST_LIFECYCLE_PHASES = new Set([
  'cold-launch',
  'warm-launch',
  'hot-launch',
  'resume',
  'foreground',
  'background',
  'force-stop',
  'process-death',
  'scene-recreation',
  'activity-recreation',
  'os-reclaim',
  'reboot',
  'relaunch',
]);
const ANDROID_PROFILE_RUNNER_CAPABILITIES = {
  schemaVersion: '1.0.0',
  runnerId: 'android-adb-profile-runner',
  kind: 'primary',
  platforms: ['android'],
  capabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
  driverActions: ['tap', 'scroll', 'assertVisible', 'inspectTree', 'screenshot', 'record', 'readLogs'],
  artifactOutputs: ['logs', 'signals', 'screenshot', 'video', 'uiTree'],
  uiContexts: ['app'],
  lifecycle: ['prepare', 'launch', 'startSession', 'executeStep', 'waitForTruthEvent', 'captureEvidence', 'stopSession', 'finalize'],
};

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
 * Resolves the lifecycle phase this runner is prepared to assert.
 *
 * @param {import('./profile-mobile').CliArgs} args
 * @returns {string}
 */
function resolveManifestLifecyclePhase(args: import('./profile-mobile').CliArgs): string {
  const lifecyclePhase = readScalarArg(args['lifecycle-phase']);
  if (lifecyclePhase === undefined) {
    return 'cold-launch';
  }
  if (typeof lifecyclePhase !== 'string' || !MANIFEST_LIFECYCLE_PHASES.has(lifecyclePhase)) {
    throw new Error(
      `Unsupported --lifecycle-phase "${String(lifecyclePhase)}". Expected one of ${Array.from(MANIFEST_LIFECYCLE_PHASES).join(', ')}.`,
    );
  }
  return lifecyclePhase;
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
  commandId,
  config,
  queueId,
  runId,
  scenario,
  sequence,
  waitForMilestone,
  waitMs,
  waitTimeoutMs,
}: {
  action: 'start' | 'command';
  command?: string;
  commandId?: string;
  config: Record<string, any>;
  queueId?: string;
  runId: string;
  scenario: string;
  sequence?: number;
  waitForMilestone?: string;
  waitMs?: number;
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
    if (commandId) {
      params.set('commandId', commandId);
    }
    if (typeof sequence === 'number') {
      params.set('sequence', String(sequence));
    }
    if (queueId) {
      params.set('queueId', queueId);
    }
    if (waitForMilestone) {
      params.set('waitForMilestone', waitForMilestone);
    }
    if (typeof waitMs === 'number') {
      params.set('waitMs', String(waitMs));
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
  const storedCommands = commands.map((profileCommand, index) => {
    const timestampPlaceholder = `${ANDROID_DEVICE_EPOCH_MS_PLACEHOLDER}+${index + 1}`;
    return {
      id: `${scenario}-${index + 1}-${profileCommand.command}`,
      scenario,
      runId,
      command: profileCommand.command,
      ...(typeof profileCommand.commandId === 'string' ? { commandId: profileCommand.commandId } : {}),
      ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
      ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
      ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
      ...(typeof profileCommand.waitMs === 'number' ? { waitMs: profileCommand.waitMs } : {}),
      ...(typeof profileCommand.waitTimeoutMs === 'number' ? { waitTimeoutMs: profileCommand.waitTimeoutMs } : {}),
      timestamp: timestampPlaceholder,
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
 * Sums the command-side pacing and milestone-gate windows the app helper can spend before command evidence appears.
 *
 * @param {AndroidAdbProfileCommand[]} commands
 * @returns {number}
 */
function deriveProfileCommandCaptureBudgetMs(commands: AndroidAdbProfileCommand[]): number {
  return commands.reduce((total, command) => {
    const waitMs = typeof command.waitMs === 'number' && command.waitMs > 0 ? command.waitMs : 0;
    const waitTimeoutMs = typeof command.waitTimeoutMs === 'number' && command.waitTimeoutMs > 0
      ? command.waitTimeoutMs
      : 0;
    return total + waitMs + waitTimeoutMs;
  }, 0);
}

/**
 * Derives a logcat-backed profile capture window from scenario waits and cycles.
 *
 * @param {Record<string, unknown>} scenario
 * @param {{bootstrapMs?: number, commands?: AndroidAdbProfileCommand[]}} [options]
 * @returns {number}
 */
function deriveProfileSessionCaptureWaitMs(
  scenario: Record<string, any>,
  options: { bootstrapMs?: number; commands?: AndroidAdbProfileCommand[] } = {},
): number {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  const iterations = readScenarioIterationCount(scenario);
  const bootstrapMs = readPositiveInteger(options.bootstrapMs, PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS);
  const perIterationWaitMs = executionPlan.steps.reduce((total: number, step: ScenarioExecutionStep) => {
    if (step.kind === 'command') {
      return total + readStepWaitMs(step);
    }
    if (step.portMethod === 'waitForTruthEvent') {
      return total + readPositiveInteger(step.timeoutMs, 0);
    }
    return total;
  }, 0);
  const planWaitMs = perIterationWaitMs * iterations;
  const commandWaitMs = deriveProfileCommandCaptureBudgetMs(options.commands ?? resolveAndroidAdbProfileCommands(scenario));
  const derivedWaitMs = bootstrapMs + Math.max(planWaitMs, commandWaitMs);

  return Math.min(Math.max(derivedWaitMs, bootstrapMs), PROFILE_SESSION_CAPTURE_MAX_MS);
}

/**
 * Resolves the Android adb capture wait, keeping explicit CLI waits authoritative.
 *
 * @param {{args: import('./profile-mobile').CliArgs, commands?: AndroidAdbProfileCommand[], scenario: Record<string, unknown>, profileSessionEnabled: boolean, profileSessionStorageEnabled?: boolean}} options
 * @returns {number}
 */
function resolveProfileSessionCaptureWaitMs({
  args,
  commands,
  profileSessionEnabled,
  profileSessionStorageEnabled = false,
  scenario,
}: {
  args: import('./profile-mobile').CliArgs;
  commands?: AndroidAdbProfileCommand[];
  profileSessionEnabled: boolean;
  profileSessionStorageEnabled?: boolean;
  scenario: Record<string, any>;
}): number {
  const explicitWaitMs = readScalarArg(args['wait-ms']);
  if (explicitWaitMs !== undefined) {
    return parsePositiveInteger(explicitWaitMs, 0);
  }

  if (!profileSessionEnabled) {
    return 0;
  }

  return deriveProfileSessionCaptureWaitMs(scenario, {
    bootstrapMs: profileSessionStorageEnabled
      ? PROFILE_SESSION_STORAGE_CAPTURE_BOOTSTRAP_MS
      : PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS,
    ...(commands ? { commands } : {}),
  });
}

/**
 * Derives a bounded logcat tail large enough to keep command-session evidence.
 *
 * @param {{commands: AndroidAdbProfileCommand[], profileSessionEnabled: boolean}} options
 * @returns {number}
 */
function deriveProfileSessionLogcatLines({
  commands,
  profileSessionEnabled,
}: {
  commands: AndroidAdbProfileCommand[];
  profileSessionEnabled: boolean;
}): number {
  if (!profileSessionEnabled || commands.length === 0) {
    return PROFILE_SESSION_LOGCAT_MIN_LINES;
  }

  const derivedLines =
    PROFILE_SESSION_LOGCAT_MIN_LINES + (commands.length * PROFILE_SESSION_LOGCAT_LINES_PER_COMMAND);
  return Math.min(Math.max(derivedLines, PROFILE_SESSION_LOGCAT_MIN_LINES), PROFILE_SESSION_LOGCAT_MAX_LINES);
}

/**
 * Resolves Android logcat capture lines, keeping explicit CLI input authoritative.
 *
 * @param {{args: import('./profile-mobile').CliArgs, commands: AndroidAdbProfileCommand[], profileSessionEnabled: boolean}} options
 * @returns {number}
 */
function resolveProfileSessionLogcatLines({
  args,
  commands,
  profileSessionEnabled,
}: {
  args: import('./profile-mobile').CliArgs;
  commands: AndroidAdbProfileCommand[];
  profileSessionEnabled: boolean;
}): number {
  const explicitLogcatLines = readScalarArg(args['logcat-lines']);
  if (explicitLogcatLines !== undefined) {
    return parsePositiveInteger(explicitLogcatLines, PROFILE_SESSION_LOGCAT_MIN_LINES);
  }

  return deriveProfileSessionLogcatLines({ commands, profileSessionEnabled });
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
      commandId: step.id,
      label: step.id,
      queueId: scenario.id ?? scenario.name,
      waitMs: readStepWaitMs(step),
      ...(nextStep?.portMethod === 'waitForTruthEvent' && typeof nextStep.milestone === 'string'
        ? {
            waitForMilestone: resolveMilestoneEventName(scenario, nextStep.milestone),
            waitTimeoutMs: readPositiveInteger(nextStep.timeoutMs, 0),
          }
        : {}),
    });
  }

  return expandProfileCommandCycles(scenario, commands, repeat);
}

/**
 * Returns true when a command is part of the setup prefix that establishes app readiness before repeated cycle work.
 *
 * @param {Record<string, unknown>} scenario
 * @param {AndroidAdbProfileCommand} command
 * @returns {boolean}
 */
function isReadinessSetupProfileCommand(
  scenario: Record<string, any>,
  command: AndroidAdbProfileCommand,
): boolean {
  if (typeof command.waitForMilestone !== 'string') {
    return false;
  }

  const readyEvent = resolveScenarioReadinessEvent(scenario);
  return typeof readyEvent === 'string' && command.waitForMilestone === readyEvent;
}

/**
 * Reads a string id list from scenario cycles metadata.
 *
 * @param {unknown} value
 * @returns {Set<string>}
 */
function readCycleStepIdSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
}

/**
 * Resolves the milestone ids that represent measured cycle boundaries.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {Set<string>}
 */
function resolveMeasuredCycleMilestoneEvents(scenario: Record<string, any>): Set<string> {
  const milestones = new Set<string>();
  for (const budget of Array.isArray(scenario.budgets) ? scenario.budgets : []) {
    if (!budget || typeof budget !== 'object' || budget.source !== 'milestone') {
      continue;
    }
    if (typeof budget.fromMilestone === 'string') {
      milestones.add(resolveMilestoneEventName(scenario, budget.fromMilestone));
    }
    if (typeof budget.toMilestone === 'string') {
      milestones.add(resolveMilestoneEventName(scenario, budget.toMilestone));
    }
  }
  return milestones;
}

/**
 * Resolves how many leading commands are setup-only before repeated cycle work.
 *
 * @param {Record<string, unknown>} scenario
 * @param {AndroidAdbProfileCommand[]} commands
 * @returns {number}
 */
function resolveSetupCommandCount(
  scenario: Record<string, any>,
  commands: AndroidAdbProfileCommand[],
): number {
  const explicitSetupStepIds = readCycleStepIdSet(scenario.cycles?.setupStepIds);
  if (explicitSetupStepIds.size > 0) {
    let count = 0;
    for (const command of commands) {
      if (!command.commandId || !explicitSetupStepIds.has(command.commandId)) {
        break;
      }
      count += 1;
    }
    return count;
  }

  const explicitBodyStepIds = readCycleStepIdSet(scenario.cycles?.bodyStepIds);
  if (explicitBodyStepIds.size > 0) {
    const firstBodyIndex = commands.findIndex((command) => (
      typeof command.commandId === 'string' && explicitBodyStepIds.has(command.commandId)
    ));
    return firstBodyIndex > 0 ? firstBodyIndex : 0;
  }

  let readinessSetupCommandCount = 0;
  for (const command of commands) {
    if (!isReadinessSetupProfileCommand(scenario, command)) {
      break;
    }
    readinessSetupCommandCount += 1;
  }
  if (readinessSetupCommandCount > 0) {
    return readinessSetupCommandCount;
  }

  const measuredMilestones = resolveMeasuredCycleMilestoneEvents(scenario);
  if (measuredMilestones.size === 0) {
    return 0;
  }

  const firstMeasuredCommandIndex = commands.findIndex((command) => (
    typeof command.waitForMilestone === 'string' && measuredMilestones.has(command.waitForMilestone)
  ));
  return firstMeasuredCommandIndex > 0 ? firstMeasuredCommandIndex : 0;
}

/**
 * Expands commands so setup/readiness commands execute once while cycle-body commands repeat.
 *
 * @param {Record<string, unknown>} scenario
 * @param {AndroidAdbProfileCommand[]} commands
 * @param {number} repeat
 * @returns {AndroidAdbProfileCommand[]}
 */
function expandProfileCommandCycles(
  scenario: Record<string, any>,
  commands: AndroidAdbProfileCommand[],
  repeat: number,
): AndroidAdbProfileCommand[] {
  const setupCommandCount = resolveSetupCommandCount(scenario, commands);
  const setupCommands = commands.slice(0, setupCommandCount);
  const cycleCommands = commands.slice(setupCommandCount);
  const expandedCommands = cycleCommands.length === 0
    ? setupCommands
    : [
        ...setupCommands,
        ...Array.from({ length: repeat }).flatMap(() => cycleCommands),
      ];

  return expandedCommands.map((command, index) => ({
    ...command,
    sequence: index + 1,
  }));
}

/**
 * Resolves a portable milestone id to the app truth event that releases command sequencing.
 *
 * @param {Record<string, unknown>} scenario
 * @param {string} milestone
 * @returns {string}
 */
function resolveMilestoneEventName(scenario: Record<string, any>, milestone: string): string {
  const milestoneEntry = Array.isArray(scenario.milestones)
    ? scenario.milestones.find((entry: Record<string, unknown>) => entry?.id === milestone)
    : undefined;
  if (typeof milestoneEntry?.event === 'string' && milestoneEntry.event.length > 0) {
    return milestoneEntry.event;
  }

  const metricEvent = scenario.metricEvents?.[milestone];
  return typeof metricEvent === 'string' && metricEvent.length > 0 ? metricEvent : milestone;
}

/**
 * Resolves the scenario truth event that represents initial app readiness.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {string | null}
 */
function resolveScenarioReadinessEvent(scenario: Record<string, any>): string | null {
  const explicitReadyEvent = scenario.truthEvents?.ready?.event;
  if (typeof explicitReadyEvent === 'string' && explicitReadyEvent.length > 0) {
    return explicitReadyEvent;
  }

  const milestoneEntry = Array.isArray(scenario.milestones)
    ? scenario.milestones.find((entry: Record<string, unknown>) => (
        String(entry?.event ?? '').includes('ready')
      ))
    : undefined;

  return typeof milestoneEntry?.event === 'string' && milestoneEntry.event.length > 0
    ? milestoneEntry.event
    : null;
}

/**
 * Applies wait gates from the normalized execution plan to platform-declared commands.
 *
 * @param {Record<string, unknown>} scenario
 * @param {AndroidAdbProfileCommand[]} commands
 * @returns {AndroidAdbProfileCommand[]}
 */
function applyExecutionPlanCommandGates(
  scenario: Record<string, any>,
  commands: AndroidAdbProfileCommand[],
): AndroidAdbProfileCommand[] {
  const planCommands = resolveExecutionPlanProfileCommands(scenario);
  if (planCommands.length === 0) {
    return commands;
  }

  return commands.map((command, index) => {
    const planCommand = planCommands[index];
    if (!planCommand || typeof planCommand.waitForMilestone !== 'string' || typeof command.waitForMilestone === 'string') {
      return command;
    }

    return {
      ...command,
      waitForMilestone: planCommand.waitForMilestone,
      ...(typeof command.waitTimeoutMs === 'number'
        ? {}
        : { waitTimeoutMs: readPositiveInteger(planCommand.waitTimeoutMs, 0) }),
    };
  });
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
        commandId: typeof command.id === 'string'
          ? command.id
          : typeof command.commandId === 'string'
            ? command.commandId
            : typeof command.label === 'string'
              ? command.label
              : command.command,
        ...(typeof command.label === 'string' ? { label: command.label } : {}),
        queueId: scenario.id ?? scenario.name,
        sequence: commands.length + 1,
        waitMs: readPositiveInteger(command.waitMs, 0),
      });
    }
  }

  return applyExecutionPlanCommandGates(scenario, commands);
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
      commandTransport: typeof args.events === 'string' ? 'fixture-log-ingest' : 'adb-artifacts',
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
  const scenarioName = resolveProfileScenarioName({ scenario, scenarioPath: path.resolve(args.scenario) });
  const artifactRoot = resolveArtifactRoot({
    args,
    config,
    configPath: path.resolve(args.config),
    platform: 'android',
  });
  const adbCaptureEnabled = isEnabled(args['adb-capture']);
  const agentDeviceCaptureEnabled = isEnabled(args['agent-device-capture']);
  const driverSteps = adbCaptureEnabled ? resolveAndroidAdbDriverSteps(scenario) : [];
  if (adbCaptureEnabled) {
    const driverStepErrors = validateAndroidAdbDriverSteps(driverSteps);
    if (driverStepErrors.length > 0) {
      throw new Error(`Invalid Android adb driver step metadata: ${driverStepErrors.join(' ')}`);
    }
  }
  await runProfileCompatibilityPreflight({
    args,
    artifactRoot,
    platform: 'android',
    primaryRunner: ANDROID_PROFILE_RUNNER_CAPABILITIES,
    runDir: path.join(artifactRoot, scenarioName, runId),
    runId,
    scenario,
    scenarioName,
  });
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
  const configuredAndroidDevClientReadyPattern = readStringArgOrEnv(args['android-dev-client-ready-pattern'], [
    'ASL_ANDROID_DEV_CLIENT_READY_PATTERN',
    'ASL_EXAMPLE_ANDROID_DEV_CLIENT_READY_PATTERN',
  ]);
  const androidDevClientReadyPattern = configuredAndroidDevClientReadyPattern
    ?? (androidDevClientUrl && profileSessionEnabled && profileSessionStorageEnabled
      ? DEFAULT_ANDROID_DEV_CLIENT_READY_PATTERN
      : undefined);
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
  const adbCommandTimeoutMs = parsePositiveInteger(
    readStringArgOrEnv(args['adb-command-timeout-ms'], [
      'ASL_ANDROID_ADB_COMMAND_TIMEOUT_MS',
      'ASL_EXAMPLE_ANDROID_ADB_COMMAND_TIMEOUT_MS',
    ]),
    30000,
  );
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
            ...(typeof profileCommand.commandId === 'string' ? { commandId: profileCommand.commandId } : {}),
            config,
            runId,
            scenario: scenarioName,
            ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
            ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
            ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
            ...(typeof profileCommand.waitMs === 'number' ? { waitMs: profileCommand.waitMs } : {}),
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
  const androidPackageName = resolveAndroidPackageName({ args, config });
  if (adbCaptureEnabled || agentDeviceCaptureEnabled) {
    assertConcreteMobileAppId({
      appId: androidPackageName,
      appIdKind: 'Android package',
      platform: 'android',
      replacementHint: 'Pass --package, set ASL_ANDROID_APP_ID in generated scripts, or replace app.androidPackage in asl.config.json.',
    });
  }
  const adbCapture = adbCaptureEnabled
    ? await runAndroidAdbPreflight({
        ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
        captureLogcat: true,
        clearLogcat: isEnabled(args['clear-logcat']),
        commandTimeoutMs: adbCommandTimeoutMs,
        deepLinks: profileSessionDeepLinks,
        ...(options.delay ? { delay: options.delay } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
        driverSteps,
        launch: isEnabled(args.launch),
        launchWaitMs: parsePositiveInteger(readScalarArg(args['launch-wait-ms']), 0),
        logcatLines: resolveProfileSessionLogcatLines({
          args,
          commands: profileSessionCommands,
          profileSessionEnabled,
        }),
        outputDir: resolveAdbCaptureOutputDir({ args, runId }),
        packageName: androidPackageName,
        ...(typeof args['react-native-debug-host'] === 'string'
          ? { reactNativeDebugHost: args['react-native-debug-host'] }
          : {}),
        runId,
        ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
        startupDeepLinks,
        storageWrites: profileSessionStorageWrites,
        waitMs: resolveProfileSessionCaptureWaitMs({
          args,
          commands: profileSessionCommands,
          profileSessionEnabled,
          profileSessionStorageEnabled,
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
          : androidPackageName,
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
  const lifecyclePhase = resolveManifestLifecyclePhase(args);
  const environmentSource = agentDeviceCapture ? 'agent-device' : 'adb';
  const copiedAdbLogArtifact = adbCapture ? 'raw/adb-logcat.txt' : undefined;

  return runProfileMobile(profileArgs, {
    commandTransport: profileSessionStorageEnabled
      ? 'profile-session-storage'
      : profileSessionEnabled
        ? 'profile-session-deeplink'
        : agentDeviceCapture
          ? 'agent-device'
          : 'adb-capture',
    ...(options.comparisonLane ? { comparisonLane: options.comparisonLane } : {}),
    defaultDriver: 'adb-logcat',
    environmentPostconditions: {
      appState: {
        value: 'foreground',
        evidence: 'asserted',
        source: environmentSource,
        ...(copiedAdbLogArtifact ? { artifact: copiedAdbLogArtifact } : {}),
      },
      lifecyclePhase: {
        value: 'foreground',
        evidence: 'asserted',
        source: environmentSource,
        ...(copiedAdbLogArtifact ? { artifact: copiedAdbLogArtifact } : {}),
      },
    },
    environmentPreconditions: {
      foregroundState: {
        value: 'controlled-by-runner',
        evidence: 'asserted',
        source: environmentSource,
      },
      lifecyclePhase: {
        value: lifecyclePhase,
        evidence: 'asserted',
        source: environmentSource,
        ...(copiedAdbLogArtifact ? { artifact: copiedAdbLogArtifact } : {}),
      },
    },
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
  deriveProfileSessionLogcatLines,
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
