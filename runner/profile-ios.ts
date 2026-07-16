#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hasHelpFlag } = require('./cli');
const { buildScenarioExecutionPlan } = require('../core/execution-plan');
const { alignProfileCommandsWithPortablePolicy } = require('../core/profile-command-policy') as typeof import('../core/profile-command-policy');
const {
  buildProfileHealth,
  buildProfileVerdict,
  buildVerdictBudgetChecks,
  parseArgs,
  readScalarArg,
  resolveArtifactRoot,
  resolveProfileScenarioName,
  runProfileCompatibilityPreflight,
  runProfileCli,
  runProfileMobile,
  usage,
} = require('./profile-mobile');
const { PROFILE_SESSION_STORAGE_KEYS } = require('../profile-session-storage');
const { runIosSimctlCapture } = require('./ios-simctl');
const { runAgentDeviceCapture } = require('./agent-device');
const { assertConcreteMobileAppId } = require('./app-identity');
const { loadAslLocalEnv, readStringArgOrEnv } = require('./local-env');

type IosProfileOptions = {
  agentDeviceExecutor?: import('./agent-device').CommandExecutor;
  comparisonLane?: string;
  delay?: (ms: number) => Promise<void>;
  executor?: import('./ios-simctl').CommandExecutor;
  recorderFactory?: import('./ios-simctl-driver').IosSimctlRecorderFactory;
};

type IosSimctlProfileCommand = {
  command: string;
  commandId?: string;
  dependsOnMilestones?: string[];
  label?: string;
  queueId?: string;
  sequence?: number;
  stopOnFailure?: boolean;
  waitForMilestone?: string;
  waitMs?: number;
  waitTimeoutMs?: number;
};

type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;

const PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS = 1000;
const PROFILE_SESSION_CAPTURE_COMMAND_OVERHEAD_MS = 250;
const PROFILE_SESSION_CAPTURE_BUFFER_MIN_MS = 2000;
const PROFILE_SESSION_CAPTURE_BUFFER_RATIO = 0.2;
const PROFILE_SESSION_CAPTURE_MAX_MS = 10 * 60 * 1000;
const DEFAULT_PROFILE_COMMAND_MILESTONE_TIMEOUT_MS = 30000;
const DEFAULT_IOS_PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.session;
const DEFAULT_IOS_PROFILE_COMMAND_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.command;
const DEFAULT_IOS_PROFILE_EVENT_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.event;
const DEFAULT_IOS_PROFILE_SIGNAL_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.signal;
const DEFAULT_IOS_PROFILE_SESSION_ENTRIES_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS.sessionEntries;
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
const IOS_PROFILE_RUNNER_CAPABILITIES = {
  schemaVersion: '1.0.0',
  runnerId: 'ios-simctl-profile-runner',
  kind: 'primary',
  platforms: ['ios'],
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
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
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

function readScenarioStopOnFailure(scenario: Record<string, any>): boolean {
  return scenario?.cycles?.stopOnFailure !== false;
}

function readStableAdapterCommandId(command: Record<string, unknown>): string {
  const commandId = typeof command.id === 'string'
    ? command.id
    : (typeof command.commandId === 'string' ? command.commandId : '');
  if (commandId.length === 0) {
    throw new Error('iOS adapter profile commands require a stable id. Labels and command text are not identities.');
  }
  return commandId;
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
  commandId,
  config,
  dependsOnMilestones,
  queueId,
  runId,
  scenario,
  sequence,
  stopOnFailure,
  waitForMilestone,
  waitMs,
  waitTimeoutMs,
}: {
  action: 'start' | 'command';
  command?: string;
  commandId?: string;
  config: Record<string, any>;
  dependsOnMilestones?: string[];
  queueId?: string;
  runId: string;
  scenario: string;
  sequence?: number;
  stopOnFailure?: boolean;
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
    if (Array.isArray(dependsOnMilestones) && dependsOnMilestones.length > 0) {
      params.set('dependsOnMilestones', dependsOnMilestones.join(','));
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
    if (typeof stopOnFailure === 'boolean') {
      params.set('stopOnFailure', String(stopOnFailure));
    }
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
  const cadenceWaitMs = readPositiveInteger(step.cadence?.settleMs, 0);
  if (cadenceWaitMs > 0) {
    return cadenceWaitMs;
  }

  const iosSimctlOptions = step.adapterOptions?.iosSimctl;
  if (iosSimctlOptions && typeof iosSimctlOptions === 'object' && !Array.isArray(iosSimctlOptions)) {
    const waitMs = (iosSimctlOptions as Record<string, unknown>).waitMs;
    if (typeof waitMs === 'number' && Number.isInteger(waitMs) && waitMs > 0) {
      return waitMs;
    }
  }

  return 0;
}

/**
 * Reads wait time from a profile-session command.
 *
 * @param {IosSimctlProfileCommand} command
 * @returns {number}
 */
function readProfileCommandWindowMs(command: IosSimctlProfileCommand): number {
  const minimumSettleMs = readPositiveInteger(command.waitMs, 0);
  const maxReadinessWaitMs = readPositiveInteger(command.waitTimeoutMs, 0);
  const boundedCommandWaitMs = maxReadinessWaitMs > 0
    ? Math.max(minimumSettleMs, maxReadinessWaitMs)
    : minimumSettleMs;
  return boundedCommandWaitMs + PROFILE_SESSION_CAPTURE_COMMAND_OVERHEAD_MS;
}

/**
 * Reads execution-plan waits that are not already attached to a profile-session command.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {number}
 */
function readUnattachedExecutionWaitMs(scenario: Record<string, any>): number {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  const iterations = readScenarioIterationCount(scenario);
  const perIterationWaitMs = executionPlan.steps.reduce((total: number, step: ScenarioExecutionStep, index: number) => {
    if (step.portMethod !== 'waitForTruthEvent') {
      return total;
    }

    const previousStep = executionPlan.steps[index - 1];
    if (previousStep?.kind === 'command' && typeof previousStep.command === 'string') {
      return total;
    }

    return total + readPositiveInteger(step.timeoutMs, 0);
  }, 0);

  return perIterationWaitMs * iterations;
}

/**
 * Derives a storage-backed profile capture window from scenario waits, command gates, and cycles.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {number}
 */
function deriveProfileSessionCaptureWaitMs(scenario: Record<string, any>): number {
  const commands = resolveIosSimctlProfileCommands(scenario);
  const commandWindowMs = commands.reduce(
    (total: number, command: IosSimctlProfileCommand) => total + readProfileCommandWindowMs(command),
    0,
  );
  const executionWindowMs = commandWindowMs + readUnattachedExecutionWaitMs(scenario);
  const bufferMs = Math.max(
    PROFILE_SESSION_CAPTURE_BUFFER_MIN_MS,
    Math.ceil(executionWindowMs * PROFILE_SESSION_CAPTURE_BUFFER_RATIO),
  );
  const derivedWaitMs = PROFILE_SESSION_CAPTURE_BOOTSTRAP_MS + executionWindowMs + bufferMs;

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

  return profileSessionEnabled || requiresIosSimctlVideo(scenario)
    ? deriveProfileSessionCaptureWaitMs(scenario)
    : 0;
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
  const stopOnFailure = readScenarioStopOnFailure(scenario);
  const commands: IosSimctlProfileCommand[] = [];
  const dependencies: string[] = [];
  for (const [index, step] of executionPlan.steps.entries()) {
    if (step.portMethod === 'waitForTruthEvent' && typeof step.milestone === 'string') {
      dependencies.push(resolveMilestoneEventName(scenario, step.milestone));
      continue;
    }
    if (step.portMethod !== 'executeStep' || typeof step.command !== 'string') {
      continue;
    }

    const nextStep = executionPlan.steps[index + 1];
    const commandDependencies = dependencies.length > 0 ? Array.from(new Set(dependencies)) : [];
    commands.push({
      command: step.command as string,
      commandId: step.id,
      ...(commandDependencies.length > 0 ? { dependsOnMilestones: commandDependencies } : {}),
      label: step.id,
      queueId: scenario.id ?? scenario.name,
      ...(stopOnFailure === false ? { stopOnFailure: false } : {}),
      waitMs: readStepWaitMs(step),
      ...(nextStep?.portMethod === 'waitForTruthEvent' && typeof nextStep.milestone === 'string'
        ? {
            waitForMilestone: resolveMilestoneEventName(scenario, nextStep.milestone),
            waitTimeoutMs: readPositiveInteger(
              nextStep.timeoutMs,
              DEFAULT_PROFILE_COMMAND_MILESTONE_TIMEOUT_MS,
            ),
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
 * @param {IosSimctlProfileCommand} command
 * @returns {boolean}
 */
function isReadinessSetupProfileCommand(
  scenario: Record<string, any>,
  command: IosSimctlProfileCommand,
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
 * @param {IosSimctlProfileCommand[]} commands
 * @returns {number}
 */
function resolveSetupCommandCount(
  scenario: Record<string, any>,
  commands: IosSimctlProfileCommand[],
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
 * @param {IosSimctlProfileCommand[]} commands
 * @param {number} repeat
 * @returns {IosSimctlProfileCommand[]}
 */
function expandProfileCommandCycles(
  scenario: Record<string, any>,
  commands: IosSimctlProfileCommand[],
  repeat: number,
): IosSimctlProfileCommand[] {
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
 * Applies normalized cadence, readiness, dependency, and failure policy to platform commands.
 *
 * @param {Record<string, unknown>} scenario
 * @param {IosSimctlProfileCommand[]} commands
 * @returns {IosSimctlProfileCommand[]}
 */
function applyExecutionPlanCommandPolicy(
  scenario: Record<string, any>,
  commands: IosSimctlProfileCommand[],
): IosSimctlProfileCommand[] {
  const planCommands = resolveExecutionPlanProfileCommands(scenario);
  return alignProfileCommandsWithPortablePolicy('iOS', commands, planCommands).map(({ command, planCommand }) => {
    const inheritedDependencies = (
      !Array.isArray(command.dependsOnMilestones) &&
      Array.isArray(planCommand.dependsOnMilestones) &&
      planCommand.dependsOnMilestones.length > 0
    ) ? { dependsOnMilestones: planCommand.dependsOnMilestones } : {};
    const waitForMilestone = typeof command.waitForMilestone === 'string'
      ? command.waitForMilestone
      : planCommand.waitForMilestone;
    const commandTimeoutMs = readPositiveInteger(command.waitTimeoutMs, 0);
    const planTimeoutMs = readPositiveInteger(planCommand.waitTimeoutMs, 0);
    const waitTimeoutMs = typeof waitForMilestone === 'string'
      ? (commandTimeoutMs || planTimeoutMs || DEFAULT_PROFILE_COMMAND_MILESTONE_TIMEOUT_MS)
      : undefined;

    return {
      ...command,
      ...inheritedDependencies,
      ...(typeof waitForMilestone === 'string' ? { waitForMilestone } : {}),
      ...(typeof command.waitMs === 'number'
        ? {}
        : (typeof planCommand.waitMs === 'number'
            ? { waitMs: readPositiveInteger(planCommand.waitMs, 0) }
            : {})),
      ...(typeof waitTimeoutMs === 'number' ? { waitTimeoutMs } : {}),
      ...(typeof command.stopOnFailure === 'boolean'
        ? {}
        : (planCommand.stopOnFailure === false ? { stopOnFailure: false } : {})),
    };
  });
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

  const repeat = readPositiveInteger(iosSimctlOptions.repeat, readScenarioIterationCount(scenario));
  const stopOnFailure = readScenarioStopOnFailure(scenario);
  const commands: IosSimctlProfileCommand[] = [];
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const command of iosSimctlOptions.commands) {
      if (!command || typeof command.command !== 'string') {
        continue;
      }
      const waitMs = readNonNegativeInteger(command.waitMs);

      commands.push({
        command: command.command,
        commandId: readStableAdapterCommandId(command),
        ...(Array.isArray(command.dependsOnMilestones) && command.dependsOnMilestones.length > 0
          ? {
              dependsOnMilestones: command.dependsOnMilestones.filter((milestone: unknown): milestone is string => (
                typeof milestone === 'string' && milestone.length > 0
              )),
            }
          : {}),
        ...(typeof command.label === 'string' ? { label: command.label } : {}),
        queueId: scenario.id ?? scenario.name,
        sequence: commands.length + 1,
        ...(typeof command.stopOnFailure === 'boolean'
          ? { stopOnFailure: command.stopOnFailure }
          : (stopOnFailure === false ? { stopOnFailure: false } : {})),
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(typeof command.waitForMilestone === 'string' && command.waitForMilestone.length > 0
          ? { waitForMilestone: command.waitForMilestone }
          : {}),
        ...(readPositiveInteger(command.waitTimeoutMs, 0) > 0
          ? { waitTimeoutMs: readPositiveInteger(command.waitTimeoutMs, 0) }
          : {}),
      });
    }
  }

  return applyExecutionPlanCommandPolicy(scenario, commands);
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

function requiresIosSimctlVideo(scenario: Record<string, any>): boolean {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  return executionPlan.steps.some((step: ScenarioExecutionStep) =>
    step.driverAction === 'record' || step.artifact === 'video',
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
function formatFailedAgentDeviceCheck(check: Record<string, unknown>): string {
  if (typeof check.message === 'string') {
    return check.message;
  }
  if (typeof check.code === 'string') {
    return check.code;
  }
  return 'unknown failure';
}

function summarizeFailedAgentDeviceChecks(health: Record<string, unknown>): string {
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const failedChecks = checks
    .filter((check: Record<string, unknown>) => check?.status === 'failed')
    .map((check: Record<string, unknown>) => formatFailedAgentDeviceCheck(check));

  return failedChecks.length > 0 ? ` Failed checks: ${failedChecks.join(' ')}` : '';
}

function buildCaptureAppendArgs(captureArg: import('./profile-mobile').CliArgs['capture']): import('./profile-mobile').CliArgs {
  const captureArgs: import('./profile-mobile').CliArgs = {};
  if (captureArg !== undefined) {
    captureArgs.capture = captureArg;
  }
  return captureArgs;
}

function assignCaptureArg(
  args: import('./profile-mobile').CliArgs,
  captureArg: import('./profile-mobile').CliArgs['capture'],
): import('./profile-mobile').CliArgs {
  if (captureArg === undefined) {
    return args;
  }
  return { ...args, capture: captureArg };
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
      args: buildCaptureAppendArgs(captureArg),
      value: `screenshot:${path.join(capture.runDir, screenshot)}`,
    });
  }

  return assignCaptureArg(args, captureArg);
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
      commandTransport: typeof args.events === 'string' ? 'fixture-log-ingest' : 'simctl-artifacts',
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
  const scenarioName = resolveProfileScenarioName({ scenario, scenarioPath: path.resolve(args.scenario) });
  const artifactRoot = resolveArtifactRoot({
    args,
    config,
    configPath: path.resolve(args.config),
    platform: 'ios',
  });
  await runProfileCompatibilityPreflight({
    args,
    artifactRoot,
    platform: 'ios',
    primaryRunner: IOS_PROFILE_RUNNER_CAPABILITIES,
    runDir: path.join(artifactRoot, scenarioName, runId),
    runId,
    scenario,
    scenarioName,
  });
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
  const profileSessionStartWaitMs = readStringArgOrEnv(args['ios-profile-session-start-wait-ms'], [
    'ASL_IOS_PROFILE_SESSION_START_WAIT_MS',
    'ASL_EXAMPLE_IOS_PROFILE_SESSION_START_WAIT_MS',
  ]);
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
            ...(typeof profileCommand.commandId === 'string' ? { commandId: profileCommand.commandId } : {}),
            ...(Array.isArray(profileCommand.dependsOnMilestones) && profileCommand.dependsOnMilestones.length > 0
              ? { dependsOnMilestones: profileCommand.dependsOnMilestones }
              : {}),
            config,
            runId,
            scenario: scenarioName,
            ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
            ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
            ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
            ...(typeof profileCommand.waitMs === 'number' ? { waitMs: profileCommand.waitMs } : {}),
            ...(typeof profileCommand.waitTimeoutMs === 'number' ? { waitTimeoutMs: profileCommand.waitTimeoutMs } : {}),
            ...(typeof profileCommand.stopOnFailure === 'boolean'
              ? { stopOnFailure: profileCommand.stopOnFailure }
              : {}),
          }),
          waitMs: profileCommand.waitMs,
        })),
      ]
    : [];
  const deepLinks = [...iosDevClientDeepLinks, ...profileSessionDeepLinks];
  const shouldLaunchWithSimctl = isEnabled(args.launch) && !(profileSessionStorageEnabled && iosDevClientUrl);
  const iosBundleId = resolveIosBundleId({ args, config });
  if (isEnabled(args['simctl-capture']) || isEnabled(args['agent-device-capture'])) {
    assertConcreteMobileAppId({
      appId: iosBundleId,
      appIdKind: 'iOS bundle id',
      platform: 'ios',
      replacementHint: 'Pass --bundle, set ASL_IOS_APP_ID in generated scripts, or replace app.iosBundleId in asl.config.json.',
    });
  }
  const simctlCapture = isEnabled(args['simctl-capture'])
    ? await runIosSimctlCapture({
        bundleId: iosBundleId,
        collectProfileStorage: profileSessionStorageEnabled,
        conflictingBundleIds: resolveIosConflictingBundleIds(config),
        deepLinks,
        ...(options.delay ? { delay: options.delay } : {}),
        ...(typeof args.device === 'string' ? { device: args.device } : {}),
        ...(options.executor ? { executor: options.executor } : {}),
        ...(options.recorderFactory ? { recorderFactory: options.recorderFactory } : {}),
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
                  ...(typeof profileCommand.commandId === 'string' ? { commandId: profileCommand.commandId } : {}),
                  ...(Array.isArray(profileCommand.dependsOnMilestones) && profileCommand.dependsOnMilestones.length > 0
                    ? { dependsOnMilestones: profileCommand.dependsOnMilestones }
                    : {}),
                  id: `ios-storage-command-${index + 1}`,
                  ...(typeof profileCommand.label === 'string' ? { label: profileCommand.label } : {}),
                  ...(typeof profileCommand.queueId === 'string' ? { queueId: profileCommand.queueId } : {}),
                  ...(typeof profileCommand.sequence === 'number' ? { sequence: profileCommand.sequence } : {}),
                  ...(typeof profileCommand.waitForMilestone === 'string' ? { waitForMilestone: profileCommand.waitForMilestone } : {}),
                  ...(typeof profileCommand.waitMs === 'number' ? { waitMs: profileCommand.waitMs } : {}),
                  ...(typeof profileCommand.waitTimeoutMs === 'number' ? { waitTimeoutMs: profileCommand.waitTimeoutMs } : {}),
                  ...(typeof profileCommand.stopOnFailure === 'boolean'
                    ? { stopOnFailure: profileCommand.stopOnFailure }
                    : {}),
                })),
                runId,
                scenario: scenarioName,
              },
              ...(profileSessionStartWaitMs
                ? { profileSessionStartWaitMs: readPositiveInteger(profileSessionStartWaitMs, 10000) }
                : {}),
              terminateBeforeLaunch: true,
            }
          : {
              terminateBeforeLaunch: isEnabled(args['terminate-before-launch']),
            }),
        runId,
        record: isEnabled(args.record) || isEnabled(args.video) || requiresIosSimctlVideo(scenario),
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
          : iosBundleId,
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
  };
  if (simctlCapture?.captures.screenshot) {
    baseProfileArgs.capture = appendCaptureArg({
      args,
      value: `screenshot:${path.join(simctlCapture.runDir, simctlCapture.captures.screenshot)}`,
    });
  }
  if (simctlCapture?.captures.video) {
    baseProfileArgs.capture = appendCaptureArg({
      args: baseProfileArgs,
      value: `video:${path.join(simctlCapture.runDir, simctlCapture.captures.video)}`,
    });
  }
  if (simctlCapture) {
    delete baseProfileArgs.events;
  }
  const profileArgs = agentDeviceCapture
    ? appendAgentDeviceCaptureArgs({ args: baseProfileArgs, capture: agentDeviceCapture })
    : baseProfileArgs;
  const lifecyclePhase = resolveManifestLifecyclePhase(args);
  const environmentSource = agentDeviceCapture ? 'agent-device' : 'simctl';
  const copiedSimctlLogArtifact = simctlCapture &&
    !fs.existsSync(path.join(simctlCapture.runDir, 'raw', 'ios-profile-events.log')) &&
    fs.existsSync(path.join(simctlCapture.runDir, 'raw', 'ios-simctl-log.txt'))
    ? 'raw/ios-simctl-log.txt'
    : undefined;

  return runProfileMobile(profileArgs, {
    commandTransport: agentDeviceCapture
      ? 'agent-device'
      : profileSessionEnabled && !profileSessionStorageEnabled
        ? 'profile-session-deeplink'
        : profileSessionEnabled
          ? 'profile-session-storage'
          : 'simctl-capture',
    ...(options.comparisonLane ? { comparisonLane: options.comparisonLane } : {}),
    defaultDriver: 'ios-simctl',
    environmentPostconditions: {
      appState: {
        value: 'foreground',
        evidence: 'asserted',
        source: environmentSource,
        ...(copiedSimctlLogArtifact ? { artifact: copiedSimctlLogArtifact } : {}),
      },
      lifecyclePhase: {
        value: 'foreground',
        evidence: 'asserted',
        source: environmentSource,
        ...(copiedSimctlLogArtifact ? { artifact: copiedSimctlLogArtifact } : {}),
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
        ...(copiedSimctlLogArtifact ? { artifact: copiedSimctlLogArtifact } : {}),
      },
    },
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
  requiresIosSimctlVideo,
  runProfileIos,
  summarizeFailedIosChecks,
  usage,
};

export type {
  CliArgs,
  ProfileRunResult,
} from './profile-mobile';
