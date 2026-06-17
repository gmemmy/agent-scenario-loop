#!/usr/bin/env node

const { execFile } = require('node:child_process');
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
  createAgentDeviceDriver,
  formatAgentDeviceRawOutput,
} = require('./agent-device-driver');

type CliArgs = {
  app?: string | boolean;
  'agent-device'?: string | boolean;
  device?: string | boolean;
  open?: string | boolean;
  out?: string | boolean;
  platform?: string | boolean;
  'run-id'?: string | boolean;
  scenario?: string | boolean;
  serial?: string | boolean;
  session?: string | boolean;
  target?: string | boolean;
  udid?: string | boolean;
  'wait-ms'?: string | boolean;
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
type ExecFileError = Error & {
  code?: number;
};
type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;

type AgentDeviceDriverStep = {
  amount?: string;
  captureFileName?: string;
  direction?: string;
  driverAction: 'assertVisible' | 'inspectTree' | 'readLogs' | 'screenshot' | 'scroll' | 'tap';
  durationMs?: number;
  endX?: number;
  endY?: number;
  pixels?: number;
  rawFileName?: string;
  ref?: string;
  required?: boolean;
  selector?: import('./agent-device-driver').AgentDeviceSelector;
  stepId?: string;
  startX?: number;
  startY?: number;
  waitMs?: number;
  x?: number;
  y?: number;
};

type AgentDeviceCaptureOptions = {
  agentDevicePath?: string;
  app?: string | null;
  delay?: (ms: number) => Promise<void>;
  device?: string | null;
  driverSteps?: AgentDeviceDriverStep[];
  executor?: CommandExecutor;
  open?: boolean;
  outputDir?: string;
  platform: import('./agent-device-driver').AgentDevicePlatform;
  runId?: string;
  scenario?: Record<string, unknown> | null;
  serial?: string | null;
  session?: string | null;
  target?: 'desktop' | 'mobile' | 'tv';
  udid?: string | null;
  waitMs?: number;
};

type AgentDeviceCaptureResult = {
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

type NextActionHint = {
  nextAction: string;
  nextActionCode: string;
};
type AgentDeviceErrorMetadata = {
  agentDeviceDiagnosticId?: string;
  agentDeviceErrorCode?: string;
  agentDeviceErrorHint?: string;
  agentDeviceErrorMessage?: string;
};

/**
 * Prints CLI usage.
 *
 * @returns {void}
 */
function usage(output: {write: (message: string) => unknown} = process.stderr): void {
  writeUsage([
    'Usage: asl-agent-device --platform <ios|android> --scenario <path> [--out <dir>] [--run-id <id>]',
    '',
    'Executes scenario-declared portable driver actions through the external agent-device CLI.',
    'Writes health.json, verdict.json, agent-summary.md, raw command transcripts, and capture artifacts.',
    'Use --open --app <bundle-or-package> to open the app before running driver actions.',
    'Use --udid <id> for iOS simulators or --serial <id> for Android devices.',
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

    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
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
 * Checks whether a boolean-style flag is enabled.
 *
 * @param {string | boolean | undefined} value
 * @returns {boolean}
 */
function isEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
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
 * Reads a finite number from adapter metadata.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  return new Promise((resolve) => {
    execFile(command, args, (error: ExecFileError | null, stdout: string, stderr: string) => {
      resolve({
        command,
        args,
        exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stderr,
        stdout,
      });
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
 * Creates scalar health-check metadata for an agent-readable next action.
 *
 * @param {string} nextActionCode
 * @param {string} nextAction
 * @returns {NextActionHint}
 */
function nextActionHint(nextActionCode: string, nextAction: string): NextActionHint {
  return {
    nextAction,
    nextActionCode,
  };
}

/**
 * Normalizes CLI diagnostic text into scalar health metadata.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeAgentDeviceDiagnosticText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 500);
}

/**
 * Reads structured agent-device JSON errors from stdout or stderr.
 *
 * @param {{stdout: string, stderr: string}} result
 * @returns {AgentDeviceErrorMetadata}
 */
function readAgentDeviceErrorMetadata(result: {stdout: string; stderr: string}): AgentDeviceErrorMetadata {
  for (const content of [result.stdout, result.stderr]) {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const error = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
        ? parsed.error as Record<string, unknown>
        : null;
      if (!error) {
        continue;
      }

      return {
        ...(typeof error.code === 'string'
          ? { agentDeviceErrorCode: normalizeAgentDeviceDiagnosticText(error.code) }
          : {}),
        ...(typeof error.message === 'string'
          ? { agentDeviceErrorMessage: normalizeAgentDeviceDiagnosticText(error.message) }
          : {}),
        ...(typeof error.hint === 'string'
          ? { agentDeviceErrorHint: normalizeAgentDeviceDiagnosticText(error.hint) }
          : {}),
        ...(typeof error.diagnosticId === 'string'
          ? { agentDeviceDiagnosticId: normalizeAgentDeviceDiagnosticText(error.diagnosticId) }
          : {}),
      };
    } catch {
      continue;
    }
  }

  return {};
}

/**
 * Builds a health artifact from agent-device capture checks.
 *
 * @param {{runId: string, checks: Record<string, unknown>[]}} options
 * @returns {Record<string, unknown>}
 */
function buildAgentDeviceHealth({ runId, checks }: {runId: string; checks: Record<string, unknown>[]}): Record<string, unknown> {
  const failed = checks.some((check) => check.status === 'failed');
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'agent-device-capture',
      flowId: 'agent-device-capture',
      runId,
      healthStatus: failed ? 'failed' : 'passed',
      checks,
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Builds a verdict artifact for agent-device capture readiness.
 *
 * @param {{runId: string, health: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildAgentDeviceVerdict({ runId, health }: {runId: string; health: Record<string, unknown>}): Record<string, unknown> {
  const passed = health.healthStatus === 'passed';
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: 'agent-device-capture',
      flowId: 'agent-device-capture',
      runId,
      healthStatus: health.healthStatus,
      verdictStatus: passed ? 'not_evaluated' : 'inconclusive',
      budgetChecks: [],
      summary: passed
        ? 'agent-device capture passed; no product budget has been evaluated.'
        : 'agent-device capture failed; runtime scenario execution is not ready.',
    },
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
}

/**
 * Reads agent-device adapter metadata from a normalized scenario step.
 *
 * @param {ScenarioExecutionStep} step
 * @returns {Record<string, unknown>}
 */
function readAgentDeviceStepOptions(step: ScenarioExecutionStep): Record<string, unknown> {
  const agentDeviceOptions = step.adapterOptions?.agentDevice;
  return agentDeviceOptions && typeof agentDeviceOptions === 'object' && !Array.isArray(agentDeviceOptions)
    ? agentDeviceOptions as Record<string, unknown>
    : {};
}

/**
 * Returns true when a normalized step has a portable selector.
 *
 * @param {unknown} value
 * @returns {value is import('./agent-device-driver').AgentDeviceSelector}
 */
function isAgentDeviceSelector(value: unknown): value is import('./agent-device-driver').AgentDeviceSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const selector = value as Record<string, unknown>;
  return typeof selector.kind === 'string' && typeof selector.value === 'string' && selector.value.length > 0;
}

/**
 * Returns the default raw file name for one agent-device action.
 *
 * @param {{driverAction: AgentDeviceDriverStep['driverAction'], index: number}} options
 * @returns {string}
 */
function defaultAgentDeviceRawFileName({
  driverAction,
  index,
}: {
  driverAction: AgentDeviceDriverStep['driverAction'];
  index: number;
}): string {
  return `agent-device-${driverAction}-${index}.txt`;
}

/**
 * Returns the default capture file name for one agent-device action.
 *
 * @param {{driverAction: AgentDeviceDriverStep['driverAction'], index: number}} options
 * @returns {string}
 */
function defaultAgentDeviceCaptureFileName({
  driverAction,
  index,
}: {
  driverAction: AgentDeviceDriverStep['driverAction'];
  index: number;
}): string {
  return `agent-device-${driverAction}-${index}.png`;
}

/**
 * Expands normalized scenario steps into agent-device driver actions.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {AgentDeviceDriverStep[]}
 */
function resolveAgentDeviceDriverSteps(scenario: Record<string, any>): AgentDeviceDriverStep[] {
  const executionPlan = buildScenarioExecutionPlan(scenario);
  return executionPlan.steps
    .filter((step: ScenarioExecutionStep) =>
      ['assertVisible', 'inspectTree', 'readLogs', 'screenshot', 'scroll', 'tap'].includes(String(step.driverAction)),
    )
    .map((step: ScenarioExecutionStep, index: number) => {
      const agentDeviceOptions = readAgentDeviceStepOptions(step);
      const action = step.driverAction as AgentDeviceDriverStep['driverAction'];
      const actionIndex = index + 1;

      return {
        driverAction: action,
        ...(typeof agentDeviceOptions.amount === 'string' ? { amount: agentDeviceOptions.amount } : {}),
        ...(typeof agentDeviceOptions.captureFileName === 'string' && agentDeviceOptions.captureFileName.length > 0
          ? { captureFileName: agentDeviceOptions.captureFileName }
          : action === 'screenshot'
            ? { captureFileName: defaultAgentDeviceCaptureFileName({ driverAction: action, index: actionIndex }) }
            : {}),
        ...(typeof agentDeviceOptions.direction === 'string' ? { direction: agentDeviceOptions.direction } : {}),
        ...(typeof readFiniteNumber(agentDeviceOptions.durationMs) === 'number'
          ? { durationMs: readFiniteNumber(agentDeviceOptions.durationMs) }
          : {}),
        ...(typeof readFiniteNumber(agentDeviceOptions.endX) === 'number' ? { endX: readFiniteNumber(agentDeviceOptions.endX) } : {}),
        ...(typeof readFiniteNumber(agentDeviceOptions.endY) === 'number' ? { endY: readFiniteNumber(agentDeviceOptions.endY) } : {}),
        ...(typeof readFiniteNumber(agentDeviceOptions.pixels) === 'number' ? { pixels: readFiniteNumber(agentDeviceOptions.pixels) } : {}),
        rawFileName: typeof agentDeviceOptions.rawFileName === 'string' && agentDeviceOptions.rawFileName.length > 0
          ? agentDeviceOptions.rawFileName
          : defaultAgentDeviceRawFileName({ driverAction: action, index: actionIndex }),
        ...(typeof agentDeviceOptions.ref === 'string' ? { ref: agentDeviceOptions.ref } : {}),
        required: step.required !== false,
        ...(isAgentDeviceSelector(step.selector) ? { selector: step.selector } : {}),
        stepId: step.id,
        ...(typeof readFiniteNumber(agentDeviceOptions.startX) === 'number' ? { startX: readFiniteNumber(agentDeviceOptions.startX) } : {}),
        ...(typeof readFiniteNumber(agentDeviceOptions.startY) === 'number' ? { startY: readFiniteNumber(agentDeviceOptions.startY) } : {}),
        waitMs: readPositiveInteger(agentDeviceOptions.waitMs ?? step.timeoutMs, 0),
        ...(typeof readFiniteNumber(agentDeviceOptions.x) === 'number' ? { x: readFiniteNumber(agentDeviceOptions.x) } : {}),
        ...(typeof readFiniteNumber(agentDeviceOptions.y) === 'number' ? { y: readFiniteNumber(agentDeviceOptions.y) } : {}),
      };
    });
}

/**
 * Returns profile-time validation errors for agent-device driver steps.
 *
 * @param {AgentDeviceDriverStep[]} driverSteps
 * @returns {string[]}
 */
function validateAgentDeviceDriverSteps(driverSteps: AgentDeviceDriverStep[]): string[] {
  const errors: string[] = [];
  for (const step of driverSteps) {
    const stepLabel = step.stepId ? `step \`${step.stepId}\`` : 'unnamed step';
    if (step.driverAction === 'tap' && !step.selector && !step.ref && (typeof step.x !== 'number' || typeof step.y !== 'number')) {
      errors.push(`${stepLabel} uses driverAction \`tap\` but is missing a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.`);
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
 * @param {import('./agent-device-driver').AgentDeviceSelector | undefined} selector
 * @returns {Record<string, string>}
 */
function buildAgentDeviceSelectorHealthMetadata(
  selector?: import('./agent-device-driver').AgentDeviceSelector,
): Record<string, string> {
  if (!selector) {
    return {};
  }

  return {
    selectorKind: selector.kind,
    selectorValue: selector.value,
    ...(selector.match ? { selectorMatch: selector.match } : {}),
  };
}

/**
 * Runs one agent-device driver action.
 *
 * @param {{capturesDir: string, driver: import('./agent-device-driver').AgentDeviceDriver, driverStep: AgentDeviceDriverStep}} options
 * @returns {Promise<import('./agent-device-driver').AgentDeviceCommandResult>}
 */
async function runAgentDeviceDriverStep({
  capturesDir,
  driver,
  driverStep,
}: {
  capturesDir: string;
  driver: import('./agent-device-driver').AgentDeviceDriver;
  driverStep: AgentDeviceDriverStep;
}): Promise<import('./agent-device-driver').AgentDeviceCommandResult> {
  if (driverStep.driverAction === 'assertVisible' && driverStep.selector) {
    return driver.assertVisible({
      selector: driverStep.selector,
      ...(driverStep.rawFileName ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }
  if (driverStep.driverAction === 'inspectTree') {
    return driver.inspectTree({
      ...(driverStep.rawFileName ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }
  if (driverStep.driverAction === 'readLogs') {
    return driver.readLogs({
      ...(driverStep.rawFileName ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }
  if (driverStep.driverAction === 'screenshot') {
    return driver.screenshot({
      outputPath: path.join(capturesDir, driverStep.captureFileName ?? 'agent-device-screenshot.png'),
      ...(driverStep.rawFileName ? { rawFileName: driverStep.rawFileName } : {}),
    });
  }
  if (driverStep.driverAction === 'scroll') {
    return driver.scroll({
      ...(driverStep.amount ? { amount: driverStep.amount } : {}),
      ...(driverStep.direction ? { direction: driverStep.direction } : {}),
      ...(typeof driverStep.durationMs === 'number' ? { durationMs: driverStep.durationMs } : {}),
      ...(typeof driverStep.endX === 'number' ? { endX: driverStep.endX } : {}),
      ...(typeof driverStep.endY === 'number' ? { endY: driverStep.endY } : {}),
      ...(typeof driverStep.pixels === 'number' ? { pixels: driverStep.pixels } : {}),
      ...(driverStep.rawFileName ? { rawFileName: driverStep.rawFileName } : {}),
      ...(typeof driverStep.startX === 'number' ? { startX: driverStep.startX } : {}),
      ...(typeof driverStep.startY === 'number' ? { startY: driverStep.startY } : {}),
    });
  }
  if (driverStep.driverAction === 'tap') {
    return driver.tap({
      ...(driverStep.rawFileName ? { rawFileName: driverStep.rawFileName } : {}),
      ...(driverStep.ref ? { ref: driverStep.ref } : {}),
      ...(driverStep.selector ? { selector: driverStep.selector } : {}),
      ...(typeof driverStep.x === 'number' ? { x: driverStep.x } : {}),
      ...(typeof driverStep.y === 'number' ? { y: driverStep.y } : {}),
    });
  }

  throw new Error(`Unsupported agent-device driver action: ${driverStep.driverAction}`);
}

/**
 * Builds a stable health code suffix for one agent-device driver action.
 *
 * @param {AgentDeviceDriverStep['driverAction']} driverAction
 * @returns {string}
 */
function agentDeviceDriverActionCode(driverAction: AgentDeviceDriverStep['driverAction']): string {
  return driverAction.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
}

/**
 * Runs scenario-declared portable actions through agent-device and writes artifacts.
 *
 * @param {AgentDeviceCaptureOptions} options
 * @returns {Promise<AgentDeviceCaptureResult>}
 */
async function runAgentDeviceCapture({
  agentDevicePath = 'agent-device',
  app = null,
  delay: wait = delay,
  device = null,
  driverSteps,
  executor = execFileCommand,
  open = false,
  outputDir = path.resolve('artifacts/agent-device-capture'),
  platform,
  runId = createRunId(),
  scenario = null,
  serial = null,
  session = null,
  target = 'mobile',
  udid = null,
  waitMs = 0,
}: AgentDeviceCaptureOptions): Promise<AgentDeviceCaptureResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  await fsp.mkdir(rawDir, { recursive: true });
  await fsp.mkdir(layout.captures, { recursive: true });

  const raw: Record<string, string> = {};
  const captures: {screenshots: string[]} = {
    screenshots: [],
  };
  const checks: Record<string, unknown>[] = [];
  const driverActionMetadata: Record<string, unknown>[] = [];
  const resolvedDriverSteps = driverSteps ?? (scenario ? resolveAgentDeviceDriverSteps(scenario) : []);
  const driverStepErrors = validateAgentDeviceDriverSteps(resolvedDriverSteps);
  if (driverStepErrors.length > 0) {
    throw new Error(`Invalid agent-device driver step metadata: ${driverStepErrors.join(' ')}`);
  }

  const driver = createAgentDeviceDriver({
    agentDevicePath,
    ...(device ? { device } : {}),
    executor,
    platform,
    ...(serial ? { serial } : {}),
    ...(session ? { session } : {}),
    target,
    ...(udid ? { udid } : {}),
  });

  const metadata: Record<string, unknown> = {
    app,
    device,
    driverActions: [],
    open,
    platform,
    selectedTarget: udid ?? serial ?? device ?? null,
    session,
    target,
  };

  if (open) {
    if (!app) {
      checks.push({
        name: 'agent_device_opened',
        status: 'failed',
        source: 'runner',
        code: 'agent_device_open_missing_app',
        message: 'agent-device app open was requested, but no app id or URL was provided.',
        metadata: nextActionHint(
          'provide_agent_device_app',
          'Pass --app with a bundle id, package name, app name, or URL before requesting --open.',
        ),
      });
    } else {
      const openResult = await driver.open({ appOrUrl: app });
      raw[openResult.rawFileName] = formatAgentDeviceRawOutput(openResult);
      checks.push({
        name: 'agent_device_opened',
        status: openResult.exitCode === 0 ? 'passed' : 'failed',
        source: 'runner',
        code: openResult.exitCode === 0 ? 'agent_device_opened' : 'agent_device_open_failed',
        message: openResult.exitCode === 0 ? `Opened ${app} with agent-device.` : `Failed to open ${app} with agent-device.`,
        ...(openResult.exitCode !== 0
          ? {
              metadata: {
                ...nextActionHint(
                  'inspect_agent_device_open',
                  `Inspect raw/${openResult.rawFileName}, confirm the selected device is available, and rerun the capture.`,
                ),
                ...readAgentDeviceErrorMetadata(openResult),
              },
            }
          : {}),
      });
    }
  }

  if (waitMs > 0) {
    await wait(waitMs);
    checks.push({
      name: 'agent_device_capture_window_waited',
      status: 'passed',
      source: 'runner',
      code: 'agent_device_capture_window_waited',
      message: `Waited ${waitMs}ms before running agent-device driver actions.`,
    });
  }

  for (const driverStep of resolvedDriverSteps) {
    if (driverStep.waitMs && driverStep.waitMs > 0) {
      await wait(driverStep.waitMs);
      checks.push({
        name: 'agent_device_driver_action_waited',
        status: 'passed',
        source: 'runner',
        code: 'agent_device_driver_action_waited',
        message: `Waited ${driverStep.waitMs}ms before running agent-device driver action ${driverStep.driverAction}.`,
        metadata: {
          driverAction: driverStep.driverAction,
          ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
        },
      });
    }

    const driverResult = await runAgentDeviceDriverStep({
      capturesDir: layout.captures,
      driver,
      driverStep,
    });
    raw[driverResult.rawFileName] = formatAgentDeviceRawOutput(driverResult);
    const failed = driverResult.exitCode !== 0;
    const codeSuffix = agentDeviceDriverActionCode(driverStep.driverAction);
    checks.push({
      name: `agent_device_${codeSuffix}`,
      status: failed && driverStep.required === false ? 'warning' : failed ? 'failed' : 'passed',
      source: 'runner',
      code: driverResult.exitCode === 0 ? `agent_device_${codeSuffix}_completed` : `agent_device_${codeSuffix}_failed`,
      message: driverResult.exitCode === 0
        ? `Completed agent-device driver action ${driverStep.driverAction}.`
        : `agent-device driver action ${driverStep.driverAction} failed.`,
      metadata: {
        driverAction: driverStep.driverAction,
        ...(failed
          ? nextActionHint(
              'inspect_agent_device_driver_action',
              `Inspect raw/${driverResult.rawFileName}, confirm the device is interactive and the action metadata is valid, then rerun the capture.`,
            )
          : {}),
        ...(failed ? readAgentDeviceErrorMetadata(driverResult) : {}),
        ...buildAgentDeviceSelectorHealthMetadata(driverStep.selector),
        ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
      },
    });
    const actionMetadata = {
      args: driverResult.args,
      driverAction: driverStep.driverAction,
      exitCode: driverResult.exitCode,
      ...(driverResult.capturePath
        ? { capturePath: `captures/${path.basename(driverResult.capturePath)}` }
        : {}),
      rawPath: `raw/${driverResult.rawFileName}`,
      ...(driverStep.selector ? { selector: driverStep.selector } : {}),
      ...(driverStep.stepId ? { stepId: driverStep.stepId } : {}),
    };
    driverActionMetadata.push(actionMetadata);
    if (driverStep.driverAction === 'screenshot' && driverResult.exitCode === 0 && driverResult.capturePath) {
      captures.screenshots.push(`captures/${path.basename(driverResult.capturePath)}`);
    }
  }

  metadata.driverActions = driverActionMetadata;
  metadata.captures = captures;
  const health = buildAgentDeviceHealth({ runId, checks });
  const verdict = buildAgentDeviceVerdict({ runId, health });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });

  await Promise.all(
    Object.entries(raw).map(([fileName, content]) =>
      fsp.writeFile(path.join(rawDir, fileName), `${content.trimEnd()}\n`, 'utf8'),
    ),
  );
  await fsp.writeFile(path.join(rawDir, 'agent-device-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
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
 * Runs the agent-device capture CLI.
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
  if (typeof args.platform !== 'string' || typeof args.scenario !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!['android', 'apple', 'ios', 'linux', 'macos'].includes(args.platform)) {
    throw new Error('--platform must be one of android, ios, macos, linux, or apple.');
  }

  const result = await runAgentDeviceCapture({
    ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
    ...(typeof args.app === 'string' ? { app: args.app } : {}),
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    open: isEnabled(args.open),
    platform: args.platform as import('./agent-device-driver').AgentDevicePlatform,
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    scenario: readJson(path.resolve(args.scenario)),
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    ...(typeof args.session === 'string' ? { session: args.session } : {}),
    ...(typeof args.target === 'string' && ['desktop', 'mobile', 'tv'].includes(args.target)
      ? { target: args.target as 'desktop' | 'mobile' | 'tv' }
      : {}),
    ...(typeof args.udid === 'string' ? { udid: args.udid } : {}),
    waitMs: readPositiveInteger(args['wait-ms'], 0),
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
  agentDeviceDriverActionCode,
  buildAgentDeviceHealth,
  buildAgentDeviceVerdict,
  buildAgentDeviceSelectorHealthMetadata,
  defaultAgentDeviceCaptureFileName,
  defaultAgentDeviceRawFileName,
  execFileCommand,
  isAgentDeviceSelector,
  main,
  parseArgs,
  readAgentDeviceStepOptions,
  resolveAgentDeviceDriverSteps,
  runAgentDeviceCapture,
  runAgentDeviceDriverStep,
  usage,
  validateAgentDeviceDriverSteps,
};

export type {
  AgentDeviceCaptureOptions,
  AgentDeviceCaptureResult,
  AgentDeviceDriverStep,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
