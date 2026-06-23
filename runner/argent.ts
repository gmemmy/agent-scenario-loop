#!/usr/bin/env node

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { buildScenarioExecutionPlan } = require('../core/execution-plan');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');
const {
  createArgentDriver,
  formatArgentRawOutput,
  isArgentRootOnlyDescription,
} = require('./argent-driver');
const {
  createIosSimctlDriver,
  formatIosSimctlRawOutput,
} = require('./ios-simctl-driver');
const {
  loadAslLocalEnv,
  readBooleanArgOrEnv,
  readStringArgOrEnv,
} = require('./local-env');

type CliArgs = {
  app?: string | boolean;
  'app-flag'?: string | boolean;
  argent?: string | boolean;
  'base-args'?: string | boolean;
  check?: string | boolean;
  'command-timeout-ms'?: string | boolean;
  device?: string | boolean;
  'device-flag'?: string | boolean;
  'ios-simctl-screenshot-fallback'?: string | boolean;
  out?: string | boolean;
  platform?: string | boolean;
  'run-id'?: string | boolean;
  scenario?: string | boolean;
  serial?: string | boolean;
  'screen-height'?: string | boolean;
  'screen-width'?: string | boolean;
  udid?: string | boolean;
  'wait-ms'?: string | boolean;
  xcrun?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;
type SpawnError = Error & {
  code?: number | string;
};
type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;

type ArgentAvailabilityOptions = {
  argentCommand?: string;
  baseArgs?: string[];
  commandTimeoutMs?: number;
  executor?: CommandExecutor;
  requiredTools?: string[];
};

type ArgentAvailabilityCheck = {
  args: string[];
  code: string;
  command: string;
  exitCode: number;
  metadata?: Record<string, string | number | boolean | null>;
  message: string;
  name: string;
  stderrPreview?: string;
  status: 'failed' | 'passed';
  stdoutPreview?: string;
};

type ArgentAvailabilityResult = {
  argentCommand: string;
  baseArgs: string[];
  checks: ArgentAvailabilityCheck[];
  requiredTools: string[];
  status: 'failed' | 'passed';
};

type ArgentAvailabilityArtifactOptions = {
  outputDir: string;
  result: ArgentAvailabilityResult;
  runId?: string;
};

type ArgentDriverStep = {
  appId?: string;
  captureFileName?: string;
  driverAction: 'assertVisible' | 'inspectTree' | 'launch' | 'longPress' | 'screenshot' | 'scroll' | 'swipe' | 'tap';
  durationMs?: number;
  endX?: number;
  endY?: number;
  rawFileName: string;
  required: boolean;
  screenSize?: import('./argent-driver').ArgentScreenSize;
  selector?: import('./argent-driver').ArgentSelector;
  startX?: number;
  startY?: number;
  stepId: string;
  waitMs: number;
  x?: number;
  y?: number;
};

type ArgentCaptureOptions = {
  app?: string | null;
  appFlag?: string;
  argentCommand?: string;
  baseArgs?: string[];
  commandTimeoutMs?: number;
  delay?: (ms: number) => Promise<void>;
  deviceFlag?: string;
  deviceId: string;
  executor?: CommandExecutor;
  iosSimctlExecutor?: CommandExecutor;
  iosSimctlScreenshotFallback?: boolean;
  outputDir?: string;
  platform: 'android' | 'ios';
  resolveBootedIosSimulatorUdid?: () => Promise<string | null>;
  runId?: string;
  scenario: Record<string, unknown>;
  screenSize?: import('./argent-driver').ArgentScreenSize;
  waitMs?: number;
  xcrunPath?: string;
};

type ArgentCaptureResult = {
  agentSummary: string;
  captures: {
    screenshots: string[];
  };
  health: Record<string, unknown>;
  metadata: Record<string, unknown>;
  raw: Record<string, string>;
  runDir: string;
  verdict: Record<string, unknown>;
};
type ArgentFailureHintOptions = {
  driverAction: ArgentDriverStep['driverAction'];
  fallbackCapturePath?: string;
  missingRequiredScreenshot: boolean;
  rawFileName: string;
  result: import('./argent-driver').ArgentCommandResult;
  rootOnlyDescription: boolean;
};
type IosSimctlScreenshotFallbackResult = {
  capturePath?: string;
  rawFileName: string;
  result: CommandResult;
};

const DASH_VALUE_KEYS = new Set(['app-flag', 'base-args', 'device-flag']);
const DEFAULT_ARGENT_BASE_ARGS = ['run'];
const DEFAULT_ARGENT_REQUIRED_TOOLS = [
  'launch-app',
  'open-url',
  'describe',
  'screenshot',
  'gesture-tap',
  'gesture-custom',
  'gesture-swipe',
];

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} output
 * @returns {void}
 */
function usage(output: {write: (message: string) => unknown} = process.stderr): void {
  writeUsage([
    'Usage: asl-argent --platform <ios|android> --scenario <path> --device <id> [--app <bundle-or-package>] [--out <dir>] [--run-id <id>]',
    '',
    'Executes scenario-declared launch and portable driver actions through the external Argent CLI.',
    'Writes health.json, verdict.json, agent-summary.md, raw command transcripts, and screenshot captures.',
    'Use --check --out <dir> to verify the configured Argent command and required tool surface and preserve availability artifacts.',
    'Use --argent <binary> and --base-args "<args>" to adapt local Argent installs without bundling Argent.',
    'Use --device-flag and --app-flag when your Argent command expects platform-specific flag names.',
    'Use --command-timeout-ms <ms> to bound each external Argent invocation.',
    'Use --ios-simctl-screenshot-fallback on iOS when simctl should provide screenshot evidence if Argent screenshot is unavailable.',
    'Use --xcrun <path> to route the iOS simctl screenshot fallback through a specific xcrun binary.',
  ], output);
}

/**
 * Parses `--key value` CLI arguments.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      continue;
    }
    if (!token?.startsWith('--')) {
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 2) {
      args[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && (!value.startsWith('--') || DASH_VALUE_KEYS.has(key))) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

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
 * Reads a finite number from adapter metadata.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads a positive integer from CLI or scenario metadata.
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
 * Creates a short random run id.
 *
 * @returns {string}
 */
function createRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Runs a command and captures stdout, stderr, and exit code without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<CommandResult>}
 */
function execFileCommand(command: string, args: string[]): Promise<CommandResult> {
  return execFileCommandWithTimeout(command, args);
}

/**
 * Runs a command with a bounded timeout and captures stdout, stderr, and exit code without throwing.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<CommandResult>}
 */
function execFileCommandWithTimeout(command: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    /**
     * Signals the spawned command and its process group when the platform supports it.
     *
     * @param {NodeJS.Signals} signal
     * @returns {void}
     */
    const signalChildTree = (signal: NodeJS.Signals): void => {
      if (typeof child.pid !== 'number') {
        return;
      }
      try {
        if (process.platform === 'win32') {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        child.kill(signal);
      }
    };
    const buildResult = (code: number | null, signal: NodeJS.Signals | null): CommandResult => ({
      command,
      args,
      exitCode: typeof code === 'number' ? code : signal ? 1 : 0,
      stderr: [stderr, timedOut ? `Argent command timed out after ${timeoutMs}ms.` : ''].filter(Boolean).join('\n'),
      stdout,
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      signalChildTree('SIGTERM');
      forceKillTimer = setTimeout(() => {
        signalChildTree('SIGKILL');
        finish(buildResult(null, 'SIGKILL'));
      }, 1500);
    }, timeoutMs);

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      child.unref();
      child.stdout?.unref();
      child.stderr?.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: SpawnError) => {
      finish({
        command,
        args,
        exitCode: 1,
        stderr: stderr || error.message,
        stdout,
      });
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // `exit` can arrive before pipe data events drain, while `close` can wait on
      // wrapper-spawned helpers that inherited stdio. Defer one tick to capture
      // buffered output without reintroducing inherited-pipe hangs.
      setImmediate(() => finish(buildResult(code, signal)));
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(buildResult(code, signal));
    });
  });
}

/**
 * Waits for the requested capture window.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Reads the first booted iOS simulator UDID from `simctl` JSON.
 *
 * @param {string} stdout
 * @returns {string | null}
 */
function parseBootedIosSimulatorUdid(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as {devices?: Record<string, Array<{state?: string, udid?: string}>>};
    for (const devices of Object.values(parsed.devices ?? {})) {
      const booted = devices.find((device) => device.state === 'Booted' && typeof device.udid === 'string');
      if (booted?.udid) {
        return booted.udid;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolves Argent's iOS device id because Argent does not understand simctl's `booted` shorthand.
 *
 * @param {number} commandTimeoutMs
 * @returns {Promise<string | null>}
 */
async function resolveBootedIosSimulatorUdid(commandTimeoutMs: number): Promise<string | null> {
  const result = await execFileCommandWithTimeout(
    'xcrun',
    ['simctl', 'list', 'devices', 'booted', '-j'],
    Math.min(commandTimeoutMs, 10_000),
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return parseBootedIosSimulatorUdid(result.stdout);
}

/**
 * Resolves the device id that should be passed to Argent.
 *
 * @param {{commandTimeoutMs: number, deviceId: string, platform: 'android' | 'ios', resolveBootedIosSimulatorUdid?: () => Promise<string | null>}} options
 * @returns {Promise<{deviceId: string, requestedDeviceId?: string}>}
 */
async function resolveArgentDeviceId({
  commandTimeoutMs,
  deviceId,
  platform,
  resolveBootedIosSimulatorUdid: resolveBooted = () => resolveBootedIosSimulatorUdid(commandTimeoutMs),
}: {
  commandTimeoutMs: number;
  deviceId: string;
  platform: 'android' | 'ios';
  resolveBootedIosSimulatorUdid?: () => Promise<string | null>;
}): Promise<{deviceId: string; requestedDeviceId?: string}> {
  if (platform !== 'ios' || deviceId !== 'booted') {
    return { deviceId };
  }
  const resolvedDeviceId = await resolveBooted();
  return resolvedDeviceId ? { deviceId: resolvedDeviceId, requestedDeviceId: deviceId } : { deviceId };
}

/**
 * Returns adapter options for an Argent-backed step.
 *
 * @param {ScenarioExecutionStep} step
 * @returns {Record<string, unknown>}
 */
function readArgentStepOptions(step: ScenarioExecutionStep): Record<string, unknown> {
  const argentOptions = step.adapterOptions?.argent;
  return argentOptions && typeof argentOptions === 'object' && !Array.isArray(argentOptions)
    ? argentOptions as Record<string, unknown>
    : {};
}

/**
 * Returns true when a normalized step has a portable selector.
 *
 * @param {unknown} value
 * @returns {value is import('./argent-driver').ArgentSelector}
 */
function isArgentSelector(value: unknown): value is import('./argent-driver').ArgentSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const selector = value as Record<string, unknown>;
  return typeof selector.kind === 'string' && typeof selector.value === 'string' && selector.value.length > 0;
}

/**
 * Returns the default raw file name for one Argent action.
 *
 * @param {{driverAction: ArgentDriverStep['driverAction'], index: number}} options
 * @returns {string}
 */
function defaultArgentRawFileName({
  driverAction,
  index,
}: {
  driverAction: ArgentDriverStep['driverAction'];
  index: number;
}): string {
  return `argent-${driverAction}-${index}.txt`;
}

/**
 * Converts a scenario step id into a safe artifact filename segment.
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeArtifactFileSegment(value: string): string {
  const sanitized = value.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return sanitized || 'step';
}

/**
 * Returns the simctl fallback screenshot filename for an Argent screenshot step.
 *
 * @param {ArgentDriverStep} driverStep
 * @returns {string}
 */
function defaultIosSimctlFallbackScreenshotFileName(driverStep: ArgentDriverStep): string {
  return driverStep.captureFileName && driverStep.captureFileName.length > 0
    ? driverStep.captureFileName
    : `ios-simctl-${sanitizeArtifactFileSegment(driverStep.stepId)}.png`;
}

/**
 * Expands normalized scenario steps into Argent driver actions.
 *
 * @param {Record<string, unknown>} scenario
 * @param {import('./argent-driver').ArgentScreenSize | undefined} screenSize
 * @returns {ArgentDriverStep[]}
 */
function resolveArgentDriverSteps(
  scenario: Record<string, any>,
  screenSize?: import('./argent-driver').ArgentScreenSize,
): ArgentDriverStep[] {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  return executionPlan.steps
    .filter((step: ScenarioExecutionStep) =>
      step.kind === 'launch' ||
      ['assertVisible', 'inspectTree', 'longPress', 'screenshot', 'scroll', 'swipe', 'tap'].includes(String(step.driverAction)),
    )
    .map((step: ScenarioExecutionStep, index: number) => {
      const argentOptions = readArgentStepOptions(step);
      const action = step.kind === 'launch' ? 'launch' : step.driverAction as ArgentDriverStep['driverAction'];
      const actionIndex = index + 1;

      return {
        driverAction: action,
        ...(typeof argentOptions.appId === 'string' ? { appId: argentOptions.appId } : {}),
        ...(typeof argentOptions.captureFileName === 'string' ? { captureFileName: argentOptions.captureFileName } : {}),
        ...(typeof readFiniteNumber(argentOptions.durationMs) === 'number'
          ? { durationMs: readFiniteNumber(argentOptions.durationMs) }
          : {}),
        ...(typeof readFiniteNumber(argentOptions.endX) === 'number' ? { endX: readFiniteNumber(argentOptions.endX) } : {}),
        ...(typeof readFiniteNumber(argentOptions.endY) === 'number' ? { endY: readFiniteNumber(argentOptions.endY) } : {}),
        rawFileName: typeof argentOptions.rawFileName === 'string' && argentOptions.rawFileName.length > 0
          ? argentOptions.rawFileName
          : defaultArgentRawFileName({ driverAction: action, index: actionIndex }),
        required: step.required !== false,
        ...(screenSize ? { screenSize } : {}),
        ...(isArgentSelector(argentOptions.selector)
          ? { selector: argentOptions.selector }
          : isArgentSelector(step.selector)
            ? { selector: step.selector }
            : {}),
        ...(typeof readFiniteNumber(argentOptions.startX) === 'number' ? { startX: readFiniteNumber(argentOptions.startX) } : {}),
        ...(typeof readFiniteNumber(argentOptions.startY) === 'number' ? { startY: readFiniteNumber(argentOptions.startY) } : {}),
        stepId: step.id,
        waitMs: readPositiveInteger(argentOptions.waitMs ?? step.timeoutMs, 0),
        ...(typeof readFiniteNumber(argentOptions.x) === 'number' ? { x: readFiniteNumber(argentOptions.x) } : {}),
        ...(typeof readFiniteNumber(argentOptions.y) === 'number' ? { y: readFiniteNumber(argentOptions.y) } : {}),
      };
    });
}

/**
 * Returns profile-time validation errors for Argent driver steps.
 *
 * @param {ArgentDriverStep[]} driverSteps
 * @param {{app?: string | null}} options
 * @returns {string[]}
 */
function validateArgentDriverSteps(driverSteps: ArgentDriverStep[], options: {app?: string | null} = {}): string[] {
  const errors: string[] = [];
  for (const step of driverSteps) {
    const stepLabel = step.stepId ? `step \`${step.stepId}\`` : 'unnamed step';
    if (step.driverAction === 'launch' && !step.appId && !options.app) {
      errors.push(`${stepLabel} is a launch step but no app id was provided through --app or adapterOptions.argent.appId.`);
    }
    if (step.driverAction === 'tap' && (typeof step.x !== 'number' || typeof step.y !== 'number')) {
      errors.push(`${stepLabel} uses driverAction \`tap\` but is missing adapterOptions.argent.x/y.`);
    }
    if (step.driverAction === 'longPress' && (typeof step.x !== 'number' || typeof step.y !== 'number')) {
      errors.push(`${stepLabel} uses driverAction \`longPress\` but is missing adapterOptions.argent.x/y.`);
    }
    if (step.driverAction === 'scroll' && (
      typeof step.startX !== 'number' ||
      typeof step.startY !== 'number' ||
      typeof step.endX !== 'number' ||
      typeof step.endY !== 'number'
    )) {
      errors.push(`${stepLabel} uses driverAction \`scroll\` but is missing adapterOptions.argent.startX/startY/endX/endY.`);
    }
    if (step.driverAction === 'swipe' && (
      typeof step.startX !== 'number' ||
      typeof step.startY !== 'number' ||
      typeof step.endX !== 'number' ||
      typeof step.endY !== 'number'
    )) {
      errors.push(`${stepLabel} uses driverAction \`swipe\` but is missing adapterOptions.argent.startX/startY/endX/endY.`);
    }
    if (step.driverAction === 'assertVisible' && !step.selector) {
      errors.push(`${stepLabel} uses driverAction \`assertVisible\` but is missing a portable selector.`);
    }
  }

  return errors;
}

/**
 * Builds scalar health metadata for one portable selector.
 *
 * @param {import('./argent-driver').ArgentSelector | undefined} selector
 * @returns {Record<string, string>}
 */
function buildArgentSelectorHealthMetadata(
  selector?: import('./argent-driver').ArgentSelector,
): Record<string, string> {
  if (!selector) {
    return {};
  }

  return {
    selectorKind: selector.kind,
    ...(selector.match ? { selectorMatch: selector.match } : {}),
    selectorValue: selector.value,
  };
}

/**
 * Builds the most specific next-action hint available from an Argent failure.
 *
 * @param {ArgentFailureHintOptions} options
 * @returns {{nextAction: string, nextActionCode: string, argentDiagnostic?: string}}
 */
function buildArgentFailureMetadata({
  driverAction,
  fallbackCapturePath,
  missingRequiredScreenshot,
  rawFileName,
  result,
  rootOnlyDescription,
}: ArgentFailureHintOptions): {nextAction: string; nextActionCode: string; argentDiagnostic?: string} {
  const output = `${result.stdout}\n${result.stderr}`;

  if (/ENOENT|command not found|not found/iu.test(output)) {
    return {
      argentDiagnostic: 'argent_command_unavailable',
      nextAction: 'Install Argent, pass --argent with the local Argent command, or set --base-args/--device-flag/--app-flag to match the installed command before rerunning.',
      nextActionCode: 'configure_argent_command',
    };
  }

  if (/timed out after \d+ms/iu.test(output)) {
    return {
      argentDiagnostic: 'argent_command_timeout',
      nextAction: 'Confirm the Argent command can run without package-manager or device-control prompts, increase --command-timeout-ms if the command is legitimately slow, then rerun.',
      nextActionCode: 'fix_argent_command_timeout',
    };
  }

  if (/SimulatorServer|simulator-server/iu.test(output)) {
    return {
      argentDiagnostic: 'argent_simulator_server_unavailable',
      ...(fallbackCapturePath ? { fallbackCapturePath, fallbackProvider: 'ios-simctl' } : {}),
      nextAction: fallbackCapturePath
        ? `Argent could not start its simulator-server dependency for ${driverAction}, but iOS simctl fallback captured ${fallbackCapturePath}. Inspect raw/${rawFileName} before relying on Argent screenshot evidence.`
        : `Argent could not start its simulator-server dependency for ${driverAction}. Inspect raw/${rawFileName}, verify the selected simulator is accessible to Argent, and use simctl or another screenshot provider when screenshot evidence is required.`,
      nextActionCode: 'fix_argent_simulator_server',
    };
  }

  if (rootOnlyDescription) {
    return {
      argentDiagnostic: 'root_only_description',
      nextAction: `Argent returned only the root UI description for ${driverAction}. Inspect raw/${rawFileName}, confirm the app is foregrounded and visible to Argent, then rerun.`,
      nextActionCode: 'fix_argent_visibility_target',
    };
  }

  if (missingRequiredScreenshot) {
    return {
      argentDiagnostic: 'missing_screenshot_path',
      nextAction: `Argent completed screenshot without reporting a saved file. Inspect raw/${rawFileName}, adjust the Argent command shape, or make the screenshot step optional before rerunning.`,
      nextActionCode: 'fix_argent_screenshot_output',
    };
  }

  return {
    nextAction: `Inspect raw/${rawFileName}, confirm Argent can see the selected app/device, and rerun the capture.`,
    nextActionCode: 'inspect_argent_driver_action',
  };
}

/**
 * Runs one Argent driver action.
 *
 * @param {{driver: import('./argent-driver').ArgentDriver, driverStep: ArgentDriverStep}} options
 * @returns {Promise<import('./argent-driver').ArgentCommandResult>}
 */
async function runArgentDriverStep({
  driver,
  driverStep,
}: {
  driver: import('./argent-driver').ArgentDriver;
  driverStep: ArgentDriverStep;
}): Promise<import('./argent-driver').ArgentCommandResult> {
  if (driverStep.driverAction === 'launch') {
    return driver.launchApp({
      ...(driverStep.appId ? { appId: driverStep.appId } : {}),
      rawFileName: driverStep.rawFileName,
    });
  }
  if (driverStep.driverAction === 'assertVisible' && driverStep.selector) {
    return driver.assertVisible({
      ...(driverStep.appId ? { appId: driverStep.appId } : {}),
      rawFileName: driverStep.rawFileName,
      selector: driverStep.selector,
    });
  }
  if (driverStep.driverAction === 'inspectTree') {
    return driver.inspectTree({
      ...(driverStep.appId ? { appId: driverStep.appId } : {}),
      rawFileName: driverStep.rawFileName,
    });
  }
  if (driverStep.driverAction === 'screenshot') {
    return driver.screenshot({
      rawFileName: driverStep.rawFileName,
    });
  }
  if (driverStep.driverAction === 'scroll') {
    return driver.scroll({
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      endX: driverStep.endX as number,
      endY: driverStep.endY as number,
      rawFileName: driverStep.rawFileName,
      ...(driverStep.screenSize ? { screenSize: driverStep.screenSize } : {}),
      startX: driverStep.startX as number,
      startY: driverStep.startY as number,
    });
  }
  if (driverStep.driverAction === 'swipe') {
    return driver.swipe({
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      endX: driverStep.endX as number,
      endY: driverStep.endY as number,
      rawFileName: driverStep.rawFileName,
      ...(driverStep.screenSize ? { screenSize: driverStep.screenSize } : {}),
      startX: driverStep.startX as number,
      startY: driverStep.startY as number,
    });
  }
  if (driverStep.driverAction === 'tap') {
    return driver.tap({
      rawFileName: driverStep.rawFileName,
      ...(driverStep.screenSize ? { screenSize: driverStep.screenSize } : {}),
      x: driverStep.x as number,
      y: driverStep.y as number,
    });
  }
  if (driverStep.driverAction === 'longPress') {
    return driver.longPress({
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      rawFileName: driverStep.rawFileName,
      ...(driverStep.screenSize ? { screenSize: driverStep.screenSize } : {}),
      x: driverStep.x as number,
      y: driverStep.y as number,
    });
  }

  throw new Error(`Unsupported Argent driver action: ${driverStep.driverAction}`);
}

/**
 * Captures an iOS screenshot through simctl when Argent's iOS screenshot backend is unavailable.
 *
 * @param {{capturesDir: string, deviceId: string, driverStep: ArgentDriverStep, executor?: CommandExecutor, xcrunPath: string}} options
 * @returns {Promise<IosSimctlScreenshotFallbackResult>}
 */
async function runIosSimctlScreenshotFallback({
  capturesDir,
  deviceId,
  driverStep,
  executor = execFileCommandWithTimeout,
  xcrunPath,
}: {
  capturesDir: string;
  deviceId: string;
  driverStep: ArgentDriverStep;
  executor?: CommandExecutor;
  xcrunPath: string;
}): Promise<IosSimctlScreenshotFallbackResult> {
  const fileName = defaultIosSimctlFallbackScreenshotFileName(driverStep);
  const outputPath = path.join(capturesDir, fileName);
  const rawFileName = `ios-simctl-${sanitizeArtifactFileSegment(driverStep.stepId)}-screenshot.txt`;
  const driver = createIosSimctlDriver({
    deviceUdid: deviceId,
    executor,
    xcrunPath,
  });
  const result = await driver.screenshot({
    outputPath,
    rawFileName,
  });

  try {
    await fsp.access(outputPath);
  } catch {
    return {
      rawFileName,
      result,
    };
  }

  return {
    capturePath: `captures/${fileName}`,
    rawFileName,
    result,
  };
}

/**
 * Builds a stable health code suffix for one Argent driver action.
 *
 * @param {ArgentDriverStep['driverAction']} driverAction
 * @returns {string}
 */
function argentDriverActionCode(driverAction: ArgentDriverStep['driverAction']): string {
  return driverAction.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
}

/**
 * Builds a health artifact from Argent capture checks.
 *
 * @param {{flowId?: string, runId: string, scenarioId: string, checks: Record<string, unknown>[]}} options
 * @returns {Record<string, unknown>}
 */
function buildArgentHealth({
  checks,
  flowId,
  runId,
  scenarioId,
}: {
  checks: Record<string, unknown>[];
  flowId?: string;
  runId: string;
  scenarioId: string;
}): Record<string, unknown> {
  const failed = checks.some((check) => check.status === 'failed');
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId,
      ...(flowId ? { flowId } : {}),
      runId,
      healthStatus: failed ? 'failed' : 'passed',
      checks,
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Builds a verdict artifact for Argent capture readiness.
 *
 * @param {{health: Record<string, unknown>, runId: string, scenarioId: string, flowId?: string}} options
 * @returns {Record<string, unknown>}
 */
function buildArgentVerdict({
  flowId,
  health,
  runId,
  scenarioId,
}: {
  flowId?: string;
  health: Record<string, unknown>;
  runId: string;
  scenarioId: string;
}): Record<string, unknown> {
  const passed = health.healthStatus === 'passed';
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId,
      ...(flowId ? { flowId } : {}),
      runId,
      healthStatus: health.healthStatus,
      verdictStatus: passed ? 'not_evaluated' : 'inconclusive',
      budgetChecks: [],
      summary: passed
        ? 'Argent capture passed; no product budget has been evaluated.'
        : 'Argent capture failed; runtime scenario execution is not ready.',
    },
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
}

/**
 * Splits CLI base args without invoking a shell.
 *
 * @param {unknown} value
 * @returns {string[] | undefined}
 */
function parseBaseArgs(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return value.trim().split(/\s+/u);
}

/**
 * Returns root-level Argent args from an `argent run` command shape.
 *
 * @param {string[]} baseArgs
 * @returns {string[]}
 */
function deriveArgentRootArgs(baseArgs: string[]): string[] {
  return baseArgs.at(-1) === 'run' ? baseArgs.slice(0, -1) : baseArgs;
}

/**
 * Converts one Argent availability check into a schema-safe health check.
 *
 * @param {ArgentAvailabilityCheck} check
 * @returns {Record<string, unknown>}
 */
function argentAvailabilityHealthCheck(check: ArgentAvailabilityCheck): Record<string, unknown> {
  return {
    name: check.name,
    status: check.status,
    source: 'runner',
    code: check.code,
    message: check.message,
    metadata: {
      command: check.command,
      args: check.args.join(' '),
      exitCode: check.exitCode,
      ...(check.stderrPreview ? { stderrPreview: check.stderrPreview } : {}),
      ...(check.stdoutPreview ? { stdoutPreview: check.stdoutPreview } : {}),
      ...(check.metadata ?? {}),
    },
  };
}

/**
 * Writes ASL artifacts for an Argent command-surface availability check.
 *
 * @param {ArgentAvailabilityArtifactOptions} options
 * @returns {Promise<{agentSummary: string, health: Record<string, unknown>, runDir: string, verdict: Record<string, unknown>}>}
 */
async function writeArgentAvailabilityArtifacts({
  outputDir,
  result,
  runId = createRunId(),
}: ArgentAvailabilityArtifactOptions): Promise<{
  agentSummary: string;
  health: Record<string, unknown>;
  runDir: string;
  verdict: Record<string, unknown>;
}> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const checks = result.checks.map(argentAvailabilityHealthCheck);
  const health = buildArgentHealth({
    checks,
    flowId: 'argent-availability',
    runId,
    scenarioId: 'argent-availability',
  });
  const verdict = assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'argent-availability',
      flowId: 'argent-availability',
      runId,
      healthStatus: health.healthStatus,
      verdictStatus: result.status === 'passed' ? 'not_evaluated' : 'inconclusive',
      budgetChecks: [],
      summary: result.status === 'passed'
        ? 'Argent command surface is available; no product budget has been evaluated.'
        : 'Argent command surface is unavailable; fix runner environment health before live proof.',
    },
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });

  await fsp.mkdir(layout.raw, { recursive: true });
  await writeJsonArtifact({
    filePath: layout.health,
    value: health,
    schema: SCHEMAS.health,
    label: 'Health artifact',
  });
  await writeJsonArtifact({
    filePath: layout.verdict,
    value: verdict,
    schema: SCHEMAS.verdict,
    label: 'Verdict artifact',
  });
  await writeTextArtifact({
    filePath: layout.agentSummary,
    content: agentSummary,
  });
  await fsp.writeFile(
    path.join(layout.raw, 'argent-availability.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );

  return {
    agentSummary,
    health,
    runDir,
    verdict,
  };
}

/**
 * Returns a compact single-line preview for command diagnostics.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
function previewCommandOutput(value: string): string | undefined {
  const preview = value.replace(/\s+/gu, ' ').trim();
  return preview.length > 240 ? `${preview.slice(0, 237)}...` : preview || undefined;
}

/**
 * Classifies an Argent availability failure into the next operational step.
 *
 * @param {CommandResult} result
 * @returns {Record<string, string>}
 */
function classifyArgentAvailabilityFailure(result: CommandResult): Record<string, string> {
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (/operation not permitted|permission denied|sandbox|eacces|eperm|cannot bind|smartsocket/iu.test(diagnostic)) {
    return {
      failureClass: 'host_access',
      nextAction: 'Rerun Argent availability with host/device access before treating this as an app, scenario, or runner regression.',
      nextActionCode: 'rerun_with_host_access',
    };
  }
  if (/timed out|timeout/iu.test(diagnostic)) {
    return {
      failureClass: 'timeout',
      nextAction: 'Confirm Argent can run without prompts, use a direct Argent binary when available, or increase --command-timeout-ms before rerunning the availability check.',
      nextActionCode: 'increase_argent_timeout',
    };
  }
  if (/enoent|not found|command not found|no such file or directory|could not determine executable/iu.test(diagnostic)) {
    return {
      failureClass: 'missing_binary',
      nextAction: 'Install Argent, pass the correct binary with --argent, or provide the wrapper shape with --base-args before starting live proof.',
      nextActionCode: 'configure_argent_binary',
    };
  }
  return {
    failureClass: 'command_surface',
    nextAction: 'Inspect the failed Argent command output, fix the command surface, then rerun the availability check before starting live proof.',
    nextActionCode: 'inspect_argent_availability',
  };
}

/**
 * Builds one availability check result from an Argent command execution.
 *
 * @param {{code: string, expectedPattern: RegExp, name: string, result: CommandResult}} options
 * @returns {ArgentAvailabilityCheck}
 */
function buildArgentAvailabilityCheck({
  code,
  expectedPattern,
  name,
  result,
}: {
  code: string;
  expectedPattern: RegExp;
  name: string;
  result: CommandResult;
}): ArgentAvailabilityCheck {
  const output = `${result.stdout}\n${result.stderr}`;
  const expectedOutputFound = expectedPattern.test(output);
  const completedBeforeWrapperTimeout = expectedOutputFound && /timed out after \d+ms/iu.test(result.stderr);
  const passed = expectedOutputFound && (result.exitCode === 0 || completedBeforeWrapperTimeout);
  const check: ArgentAvailabilityCheck = {
    args: result.args,
    code,
    command: result.command,
    exitCode: result.exitCode,
    message: passed
      ? completedBeforeWrapperTimeout
        ? `${name} returned the expected Argent output before a wrapper timeout.`
        : `${name} is available.`
      : `${name} did not return the expected Argent output.`,
    name,
    status: passed ? 'passed' : 'failed',
  };
  if (!passed) {
    const stderrPreview = previewCommandOutput(result.stderr);
    const stdoutPreview = previewCommandOutput(result.stdout);
    check.metadata = classifyArgentAvailabilityFailure(result);
    if (stderrPreview) {
      check.stderrPreview = stderrPreview;
    }
    if (stdoutPreview) {
      check.stdoutPreview = stdoutPreview;
    }
  }
  return check;
}

/**
 * Verifies that the configured Argent command can invoke the ASL-required tool surface.
 *
 * @param {ArgentAvailabilityOptions} options
 * @returns {Promise<ArgentAvailabilityResult>}
 */
async function checkArgentAvailability({
  argentCommand = 'argent',
  baseArgs = DEFAULT_ARGENT_BASE_ARGS,
  commandTimeoutMs = 30_000,
  executor,
  requiredTools = DEFAULT_ARGENT_REQUIRED_TOOLS,
}: ArgentAvailabilityOptions = {}): Promise<ArgentAvailabilityResult> {
  const run = executor ?? ((command, args) => execFileCommandWithTimeout(command, args, commandTimeoutMs));
  const checks: ArgentAvailabilityCheck[] = [];
  const runHelp = await run(argentCommand, [...baseArgs, '--help']);
  checks.push(buildArgentAvailabilityCheck({
    code: 'argent_run_help_available',
    expectedPattern: /Usage:\s+argent\s+run\s+<tool>/iu,
    name: 'argent_run_help',
    result: runHelp,
  }));

  const rootArgs = deriveArgentRootArgs(baseArgs);
  for (const tool of requiredTools) {
    const result = await run(argentCommand, [...rootArgs, 'tools', 'describe', tool]);
    checks.push(buildArgentAvailabilityCheck({
      code: `argent_tool_${tool.replace(/-/gu, '_')}_available`,
      expectedPattern: new RegExp(`Tool:\\s+${tool.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'iu'),
      name: `argent_tool_${tool}`,
      result,
    }));
  }

  const status = checks.every((check) => check.status === 'passed') ? 'passed' : 'failed';
  return {
    argentCommand,
    baseArgs,
    checks,
    requiredTools,
    status,
  };
}

/**
 * Returns a screen size from CLI values when both dimensions are present.
 *
 * @param {{width?: unknown, height?: unknown}} options
 * @returns {import('./argent-driver').ArgentScreenSize | undefined}
 */
function readScreenSize({
  height,
  width,
}: {
  height?: unknown;
  width?: unknown;
}): import('./argent-driver').ArgentScreenSize | undefined {
  const parsedWidth = typeof width === 'string' ? Number(width) : width;
  const parsedHeight = typeof height === 'string' ? Number(height) : height;
  if (typeof parsedWidth !== 'number' || typeof parsedHeight !== 'number') {
    return undefined;
  }
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight) || parsedWidth <= 0 || parsedHeight <= 0) {
    throw new Error('--screen-width and --screen-height must be positive numbers.');
  }
  return {
    height: parsedHeight,
    width: parsedWidth,
  };
}

/**
 * Copies a screenshot produced by Argent into the stable ASL captures folder.
 *
 * @param {{capturesDir: string, capturePath: string, preferredFileName?: string}} options
 * @returns {Promise<string | null>}
 */
async function copyArgentCapture({
  capturePath,
  capturesDir,
  preferredFileName,
}: {
  capturePath: string;
  capturesDir: string;
  preferredFileName?: string;
}): Promise<string | null> {
  try {
    await fsp.access(capturePath);
  } catch {
    return null;
  }

  const fileName = preferredFileName && preferredFileName.length > 0
    ? preferredFileName
    : path.basename(capturePath);
  const destination = path.join(capturesDir, fileName);
  if (path.resolve(capturePath) !== path.resolve(destination)) {
    await fsp.copyFile(capturePath, destination);
  }
  return `captures/${fileName}`;
}

/**
 * Runs scenario-declared portable actions through Argent and writes ASL artifacts.
 *
 * @param {ArgentCaptureOptions} options
 * @returns {Promise<ArgentCaptureResult>}
 */
async function runArgentCapture({
  app = null,
  appFlag,
  argentCommand = 'argent',
  baseArgs,
  commandTimeoutMs = 60_000,
  delay: wait = delay,
  deviceFlag,
  deviceId,
  executor,
  iosSimctlExecutor,
  iosSimctlScreenshotFallback = false,
  outputDir = path.resolve('artifacts/argent-capture'),
  platform,
  resolveBootedIosSimulatorUdid: resolveBooted,
  runId = createRunId(),
  scenario,
  screenSize,
  waitMs = 0,
  xcrunPath = 'xcrun',
}: ArgentCaptureOptions): Promise<ArgentCaptureResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  await fsp.mkdir(rawDir, { recursive: true });
  await fsp.mkdir(layout.captures, { recursive: true });

  const executionPlan = buildScenarioExecutionPlan(scenario);
  const raw: Record<string, string> = {};
  const captures: {screenshots: string[]} = {
    screenshots: [],
  };
  const checks: Record<string, unknown>[] = [];
  const driverActionMetadata: Record<string, unknown>[] = [];
  const resolvedDriverSteps = resolveArgentDriverSteps(scenario, screenSize);
  const driverStepErrors = validateArgentDriverSteps(resolvedDriverSteps, { app });
  if (driverStepErrors.length > 0) {
    throw new Error(`Invalid Argent driver step metadata: ${driverStepErrors.join(' ')}`);
  }
  const resolvedDevice = await resolveArgentDeviceId({
    commandTimeoutMs,
    deviceId,
    platform,
    ...(resolveBooted ? { resolveBootedIosSimulatorUdid: resolveBooted } : {}),
  });

  const driver = createArgentDriver({
    ...(app ? { appId: app } : {}),
    ...(appFlag ? { appFlag } : {}),
    argentCommand,
    ...(baseArgs ? { baseArgs } : {}),
    ...(deviceFlag ? { deviceFlag } : {}),
    deviceId: resolvedDevice.deviceId,
    executor: executor ?? ((command, args) => execFileCommandWithTimeout(command, args, commandTimeoutMs)),
    ...(screenSize ? { screenSize } : {}),
  });

  const metadata: Record<string, unknown> = {
    app,
    argentCommand,
    baseArgs: baseArgs ?? ['run'],
    captures,
    commandTimeoutMs,
    deviceId: resolvedDevice.deviceId,
    driverActions: [],
    platform,
    ...(resolvedDevice.requestedDeviceId ? { requestedDeviceId: resolvedDevice.requestedDeviceId } : {}),
    ...(screenSize ? { screenSize } : {}),
  };

  if (waitMs > 0) {
    await wait(waitMs);
    checks.push({
      name: 'argent_capture_window_waited',
      status: 'passed',
      source: 'runner',
      code: 'argent_capture_window_waited',
      message: `Waited ${waitMs}ms before running Argent driver actions.`,
    });
  }

  for (const driverStep of resolvedDriverSteps) {
    if (driverStep.waitMs > 0) {
      await wait(driverStep.waitMs);
      checks.push({
        name: 'argent_driver_action_waited',
        status: 'passed',
        source: 'runner',
        code: 'argent_driver_action_waited',
        message: `Waited ${driverStep.waitMs}ms before running Argent driver action ${driverStep.driverAction}.`,
        metadata: {
          driverAction: driverStep.driverAction,
          stepId: driverStep.stepId,
        },
      });
    }

    const driverResult = await runArgentDriverStep({ driver, driverStep });
    raw[driverResult.rawFileName] = formatArgentRawOutput(driverResult);
    const rootOnlyDescription = ['assertVisible', 'inspectTree'].includes(driverStep.driverAction) &&
      isArgentRootOnlyDescription(driverResult.stdout);
    const missingRequiredScreenshot = driverStep.driverAction === 'screenshot' &&
      driverResult.exitCode === 0 &&
      !driverResult.capturePath &&
      driverStep.required;
    const failed = driverResult.exitCode !== 0 || rootOnlyDescription || missingRequiredScreenshot;
    const codeSuffix = argentDriverActionCode(driverStep.driverAction);
    let stableCapturePath: string | null = null;
    let fallbackCapture: IosSimctlScreenshotFallbackResult | null = null;
    if (driverStep.driverAction === 'screenshot' && driverResult.exitCode === 0 && driverResult.capturePath) {
      stableCapturePath = await copyArgentCapture({
        capturePath: driverResult.capturePath,
        capturesDir: layout.captures,
        ...(driverStep.captureFileName ? { preferredFileName: driverStep.captureFileName } : {}),
      });
      if (stableCapturePath) {
        captures.screenshots.push(stableCapturePath);
      }
    }
    if (
      driverStep.driverAction === 'screenshot' &&
      failed &&
      platform === 'ios' &&
      iosSimctlScreenshotFallback
    ) {
      fallbackCapture = await runIosSimctlScreenshotFallback({
        capturesDir: layout.captures,
        deviceId: resolvedDevice.deviceId,
        driverStep,
        ...(iosSimctlExecutor ? { executor: iosSimctlExecutor } : {}),
        xcrunPath,
      });
      raw[fallbackCapture.rawFileName] = formatIosSimctlRawOutput(fallbackCapture.result);
      if (fallbackCapture.capturePath) {
        stableCapturePath = fallbackCapture.capturePath;
        captures.screenshots.push(fallbackCapture.capturePath);
      }
    }
    const recoveredByFallback = Boolean(fallbackCapture?.capturePath);
    const status = failed && (driverStep.required === false || recoveredByFallback)
      ? 'warning'
      : failed
        ? 'failed'
        : 'passed';

    checks.push({
      name: `argent_${codeSuffix}`,
      status,
      source: 'runner',
      code: status === 'passed' ? `argent_${codeSuffix}_completed` : `argent_${codeSuffix}_failed`,
      message: status === 'passed'
        ? `Completed Argent driver action ${driverStep.driverAction}.`
        : `Argent driver action ${driverStep.driverAction} failed.`,
      metadata: {
        driverAction: driverStep.driverAction,
        ...(failed
          ? buildArgentFailureMetadata({
              driverAction: driverStep.driverAction,
              ...(fallbackCapture?.capturePath ? { fallbackCapturePath: fallbackCapture.capturePath } : {}),
              missingRequiredScreenshot,
              rawFileName: driverResult.rawFileName,
              result: driverResult,
              rootOnlyDescription,
            })
          : {}),
        ...buildArgentSelectorHealthMetadata(driverStep.selector),
        stepId: driverStep.stepId,
      },
    });
    if (fallbackCapture) {
      checks.push({
        name: 'ios_simctl_screenshot_fallback',
        status: fallbackCapture.capturePath ? 'passed' : driverStep.required ? 'failed' : 'warning',
        source: 'runner',
        code: fallbackCapture.capturePath
          ? 'ios_simctl_screenshot_fallback_completed'
          : 'ios_simctl_screenshot_fallback_failed',
        message: fallbackCapture.capturePath
          ? 'Captured iOS screenshot through simctl after Argent screenshot was unavailable.'
          : 'iOS simctl screenshot fallback failed after Argent screenshot was unavailable.',
        metadata: {
          driverAction: driverStep.driverAction,
          provider: 'ios-simctl',
          rawPath: `raw/${fallbackCapture.rawFileName}`,
          ...(fallbackCapture.capturePath ? { capturePath: fallbackCapture.capturePath } : {}),
          stepId: driverStep.stepId,
        },
      });
    }

    driverActionMetadata.push({
      args: driverResult.args,
      driverAction: driverStep.driverAction,
      exitCode: driverResult.exitCode,
      ...(stableCapturePath ? { capturePath: stableCapturePath } : {}),
      ...(fallbackCapture?.capturePath ? { captureProvider: 'ios-simctl' } : {}),
      rawPath: `raw/${driverResult.rawFileName}`,
      ...(driverStep.selector ? { selector: driverStep.selector } : {}),
      stepId: driverStep.stepId,
    });
  }

  metadata.driverActions = driverActionMetadata;
  metadata.captures = captures;
  const health = buildArgentHealth({
    checks,
    ...(executionPlan.flowId ? { flowId: executionPlan.flowId } : {}),
    runId,
    scenarioId: executionPlan.scenarioId,
  });
  const verdict = buildArgentVerdict({
    ...(executionPlan.flowId ? { flowId: executionPlan.flowId } : {}),
    health,
    runId,
    scenarioId: executionPlan.scenarioId,
  });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });

  await Promise.all(
    Object.entries(raw).map(([fileName, content]) =>
      fsp.writeFile(path.join(rawDir, fileName), `${content.trimEnd()}\n`, 'utf8'),
    ),
  );
  await fsp.writeFile(path.join(rawDir, 'argent-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await writeJsonArtifact({
    filePath: layout.health,
    value: health,
    schema: SCHEMAS.health,
    label: 'Health artifact',
  });
  await writeJsonArtifact({
    filePath: layout.verdict,
    value: verdict,
    schema: SCHEMAS.verdict,
    label: 'Verdict artifact',
  });
  await writeTextArtifact({
    filePath: layout.agentSummary,
    content: agentSummary,
  });

  return {
    agentSummary,
    captures,
    health,
    metadata,
    raw,
    runDir,
    verdict,
  };
}

/**
 * Runs the Argent capture CLI.
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
  const argentCommand = readStringArgOrEnv(args.argent, ['ASL_ARGENT_BIN']);
  const baseArgs = parseBaseArgs(readStringArgOrEnv(args['base-args'], ['ASL_ARGENT_BASE_ARGS']));
  const commandTimeoutMs = readPositiveInteger(
    readStringArgOrEnv(args['command-timeout-ms'], ['ASL_ARGENT_COMMAND_TIMEOUT_MS']),
    60_000,
  );
  if (args.check === true || args.check === 'true') {
    const result = await checkArgentAvailability({
      ...(argentCommand ? { argentCommand } : {}),
      ...(baseArgs ? { baseArgs } : {}),
      commandTimeoutMs,
    });
    if (typeof args.out === 'string') {
      await writeArgentAvailabilityArtifacts({
        outputDir: args.out,
        result,
        ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
      });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'passed') {
      process.exitCode = 1;
    }
    return;
  }

  if (typeof args.platform !== 'string' || typeof args.scenario !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!['android', 'ios'].includes(args.platform)) {
    throw new Error('--platform must be one of android or ios.');
  }

  const platform = args.platform as 'android' | 'ios';
  const app = readStringArgOrEnv(args.app, platform === 'ios'
    ? ['ASL_IOS_APP_ID', 'ASL_EXAMPLE_IOS_APP_ID']
    : ['ASL_ANDROID_APP_ID', 'ASL_EXAMPLE_ANDROID_APP_ID']);
  const envDevice = readStringArgOrEnv(undefined, platform === 'ios'
    ? ['ASL_IOS_UDID', 'ASL_EXAMPLE_IOS_UDID']
    : ['ASL_ANDROID_SERIAL', 'ASL_EXAMPLE_ANDROID_SERIAL']);
  const deviceFlag = readStringArgOrEnv(args['device-flag'], ['ASL_ARGENT_DEVICE_FLAG']);
  const appFlag = readStringArgOrEnv(args['app-flag'], ['ASL_ARGENT_APP_FLAG']);
  const xcrunPath = readStringArgOrEnv(args.xcrun, ['ASL_XCRUN_PATH', 'ASL_IOS_XCRUN_BIN']);
  const deviceId = typeof args.device === 'string'
    ? args.device
    : platform === 'ios' && typeof args.udid === 'string'
      ? args.udid
      : platform === 'android' && typeof args.serial === 'string'
        ? args.serial
        : envDevice ?? null;
  if (!deviceId) {
    usage();
    process.exitCode = 1;
    return;
  }

  const screenSize = readScreenSize({ height: args['screen-height'], width: args['screen-width'] });
  const result = await runArgentCapture({
    ...(app ? { app } : {}),
    ...(appFlag ? { appFlag } : {}),
    ...(argentCommand ? { argentCommand } : {}),
    ...(baseArgs ? { baseArgs } : {}),
    commandTimeoutMs,
    ...(deviceFlag ? { deviceFlag } : {}),
    deviceId,
    iosSimctlScreenshotFallback: args['ios-simctl-screenshot-fallback'] === true ||
      readBooleanArgOrEnv(args['ios-simctl-screenshot-fallback'], ['ASL_ARGENT_IOS_SIMCTL_SCREENSHOT_FALLBACK']),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    platform,
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    scenario: readJson(path.resolve(args.scenario)),
    ...(screenSize ? { screenSize } : {}),
    waitMs: readPositiveInteger(args['wait-ms'], 0),
    ...(xcrunPath ? { xcrunPath } : {}),
  });
  process.stdout.write(`${result.runDir}\n`);
  if (result.health.healthStatus !== 'passed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  argentDriverActionCode,
  buildArgentHealth,
  buildArgentAvailabilityCheck,
  buildArgentSelectorHealthMetadata,
  buildArgentVerdict,
  checkArgentAvailability,
  copyArgentCapture,
  defaultArgentRawFileName,
  defaultIosSimctlFallbackScreenshotFileName,
  deriveArgentRootArgs,
  execFileCommand,
  execFileCommandWithTimeout,
  isArgentSelector,
  main,
  parseArgs,
  parseBaseArgs,
  readArgentStepOptions,
  readScreenSize,
  resolveArgentDriverSteps,
  runArgentCapture,
  runArgentDriverStep,
  runIosSimctlScreenshotFallback,
  sanitizeArtifactFileSegment,
  usage,
  validateArgentDriverSteps,
  writeArgentAvailabilityArtifacts,
};

export type {
  ArgentAvailabilityCheck,
  ArgentAvailabilityOptions,
  ArgentAvailabilityResult,
  ArgentCaptureOptions,
  ArgentCaptureResult,
  ArgentDriverStep,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
