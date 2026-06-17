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
  createArgentDriver,
  formatArgentRawOutput,
  isArgentRootOnlyDescription,
} = require('./argent-driver');

type CliArgs = {
  app?: string | boolean;
  'app-flag'?: string | boolean;
  argent?: string | boolean;
  'base-args'?: string | boolean;
  device?: string | boolean;
  'device-flag'?: string | boolean;
  out?: string | boolean;
  platform?: string | boolean;
  'run-id'?: string | boolean;
  scenario?: string | boolean;
  serial?: string | boolean;
  'screen-height'?: string | boolean;
  'screen-width'?: string | boolean;
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

type ArgentDriverStep = {
  appId?: string;
  captureFileName?: string;
  driverAction: 'assertVisible' | 'inspectTree' | 'launch' | 'screenshot' | 'scroll' | 'tap';
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
  delay?: (ms: number) => Promise<void>;
  deviceFlag?: string;
  deviceId: string;
  executor?: CommandExecutor;
  outputDir?: string;
  platform: 'android' | 'ios';
  runId?: string;
  scenario: Record<string, unknown>;
  screenSize?: import('./argent-driver').ArgentScreenSize;
  waitMs?: number;
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
    'Use --argent <binary> and --base-args "<args>" to adapt local Argent installs without bundling Argent.',
    'Use --device-flag and --app-flag when your Argent command expects platform-specific flag names.',
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
      ['assertVisible', 'inspectTree', 'screenshot', 'scroll', 'tap'].includes(String(step.driverAction)),
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
        ...(isArgentSelector(step.selector) ? { selector: step.selector } : {}),
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
    if (step.driverAction === 'scroll' && (
      typeof step.startX !== 'number' ||
      typeof step.startY !== 'number' ||
      typeof step.endX !== 'number' ||
      typeof step.endY !== 'number'
    )) {
      errors.push(`${stepLabel} uses driverAction \`scroll\` but is missing adapterOptions.argent.startX/startY/endX/endY.`);
    }
    if (step.driverAction === 'assertVisible' && !step.selector) {
      errors.push(`${stepLabel} uses driverAction \`assertVisible\` but is missing a portable selector.`);
    }
    if (step.selector?.match && step.selector.match !== 'exact') {
      errors.push(`${stepLabel} uses selector match \`${step.selector.match}\`, but Argent supports exact visibility selectors only.`);
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
  if (driverStep.driverAction === 'tap') {
    return driver.tap({
      rawFileName: driverStep.rawFileName,
      ...(driverStep.screenSize ? { screenSize: driverStep.screenSize } : {}),
      x: driverStep.x as number,
      y: driverStep.y as number,
    });
  }

  throw new Error(`Unsupported Argent driver action: ${driverStep.driverAction}`);
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
  delay: wait = delay,
  deviceFlag,
  deviceId,
  executor = execFileCommand,
  outputDir = path.resolve('artifacts/argent-capture'),
  platform,
  runId = createRunId(),
  scenario,
  screenSize,
  waitMs = 0,
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

  const driver = createArgentDriver({
    ...(app ? { appId: app } : {}),
    ...(appFlag ? { appFlag } : {}),
    argentCommand,
    ...(baseArgs ? { baseArgs } : {}),
    ...(deviceFlag ? { deviceFlag } : {}),
    deviceId,
    executor,
    ...(screenSize ? { screenSize } : {}),
  });

  const metadata: Record<string, unknown> = {
    app,
    argentCommand,
    baseArgs: baseArgs ?? ['run'],
    captures,
    deviceId,
    driverActions: [],
    platform,
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
    const status = failed && driverStep.required === false ? 'warning' : failed ? 'failed' : 'passed';
    let stableCapturePath: string | null = null;
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
          ? {
              nextAction: `Inspect raw/${driverResult.rawFileName}, confirm Argent can see the selected app/device, and rerun the capture.`,
              nextActionCode: 'inspect_argent_driver_action',
            }
          : {}),
        ...(rootOnlyDescription ? { argentDiagnostic: 'root_only_description' } : {}),
        ...(missingRequiredScreenshot ? { argentDiagnostic: 'missing_screenshot_path' } : {}),
        ...buildArgentSelectorHealthMetadata(driverStep.selector),
        stepId: driverStep.stepId,
      },
    });

    driverActionMetadata.push({
      args: driverResult.args,
      driverAction: driverStep.driverAction,
      exitCode: driverResult.exitCode,
      ...(stableCapturePath ? { capturePath: stableCapturePath } : {}),
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

  const args = parseArgs(argv);
  if (typeof args.platform !== 'string' || typeof args.scenario !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }
  if (!['android', 'ios'].includes(args.platform)) {
    throw new Error('--platform must be one of android or ios.');
  }

  const deviceId = typeof args.device === 'string'
    ? args.device
    : args.platform === 'ios' && typeof args.udid === 'string'
      ? args.udid
      : args.platform === 'android' && typeof args.serial === 'string'
        ? args.serial
        : null;
  if (!deviceId) {
    usage();
    process.exitCode = 1;
    return;
  }

  const baseArgs = parseBaseArgs(args['base-args']);
  const screenSize = readScreenSize({ height: args['screen-height'], width: args['screen-width'] });
  const result = await runArgentCapture({
    ...(typeof args.app === 'string' ? { app: args.app } : {}),
    ...(typeof args['app-flag'] === 'string' ? { appFlag: args['app-flag'] } : {}),
    ...(typeof args.argent === 'string' ? { argentCommand: args.argent } : {}),
    ...(baseArgs ? { baseArgs } : {}),
    ...(typeof args['device-flag'] === 'string'
      ? { deviceFlag: args['device-flag'] }
      : { deviceFlag: args.platform === 'android' ? '--serial' : '--udid' }),
    deviceId,
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    platform: args.platform as 'android' | 'ios',
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    scenario: readJson(path.resolve(args.scenario)),
    ...(screenSize ? { screenSize } : {}),
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
  argentDriverActionCode,
  buildArgentHealth,
  buildArgentSelectorHealthMetadata,
  buildArgentVerdict,
  copyArgentCapture,
  defaultArgentRawFileName,
  execFileCommand,
  isArgentSelector,
  main,
  parseArgs,
  parseBaseArgs,
  readArgentStepOptions,
  readScreenSize,
  resolveArgentDriverSteps,
  runArgentCapture,
  runArgentDriverStep,
  usage,
  validateArgentDriverSteps,
};

export type {
  ArgentCaptureOptions,
  ArgentCaptureResult,
  ArgentDriverStep,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
