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
  check?: string | boolean;
  'command-timeout-ms'?: string | boolean;
  device?: string | boolean;
  open?: string | boolean;
  out?: string | boolean;
  platform?: string | boolean;
  'require-platforms'?: string | boolean;
  'run-id'?: string | boolean;
  scenario?: string | boolean;
  serial?: string | boolean;
  session?: string | boolean;
  'session-mode'?: string | boolean;
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
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
};
type ScenarioExecutionStep = import('../core/execution-plan').ScenarioExecutionStep;
type AgentDeviceSessionMode = 'bind' | 'reuse';

type AgentDeviceAvailabilityOptions = {
  agentDevicePath?: string;
  commandTimeoutMs?: number;
  executor?: CommandExecutor;
  requiredCommands?: string[];
  requiredPlatforms?: import('./agent-device-driver').AgentDevicePlatform[];
};

type AgentDeviceAvailabilityCheck = {
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

type AgentDeviceAvailabilityResult = {
  agentDevicePath: string;
  checks: AgentDeviceAvailabilityCheck[];
  devices: Array<Record<string, unknown>>;
  requiredCommands: string[];
  requiredPlatforms: string[];
  status: 'failed' | 'passed';
};

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
  commandTimeoutMs?: number;
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
  sessionMode?: AgentDeviceSessionMode;
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
type AgentDeviceFailureHintOptions = {
  defaultNextAction: string;
  defaultNextActionCode: string;
  errorMetadata: AgentDeviceErrorMetadata;
  rawFileName: string;
};

const DEFAULT_AGENT_DEVICE_REQUIRED_COMMANDS = [
  'open',
  'snapshot',
  'screenshot',
  'is',
  'click',
  'scroll',
  'logs',
  'devices',
  'session list',
];

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
    'Use --check to verify the configured agent-device command surface without running a scenario.',
    'Use --open --app <bundle-or-package> to open the app before running driver actions.',
    'Use --udid <id> for iOS simulators or --serial <id> for Android devices.',
    'Use --session <name> [--session-mode reuse|bind] to reuse an existing session or bind a named session to direct target flags.',
    'Use --command-timeout-ms <ms> to bound each external agent-device invocation.',
    'Use --require-platforms ios,android with --check when device discovery must prove booted OS targets.',
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
    execFile(command, args, { timeout: timeoutMs }, (error: ExecFileError | null, stdout: string, stderr: string) => {
      resolve({
        command,
        args,
        exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stderr: [
          stderr,
          error?.killed || error?.signal === 'SIGTERM' ? `agent-device command timed out after ${timeoutMs}ms.` : '',
        ].filter(Boolean).join('\n'),
        stdout,
      });
    });
  });
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
 * Classifies an agent-device availability failure into the next operational step.
 *
 * @param {CommandResult} result
 * @returns {Record<string, string>}
 */
function classifyAgentDeviceAvailabilityFailure(result: CommandResult): Record<string, string> {
  const diagnostic = `${result.stderr}\n${result.stdout}`;
  if (/operation not permitted|permission denied|sandbox|eacces|eperm|daemon|\.agent-device|cannot bind|smartsocket/iu.test(diagnostic)) {
    return {
      failureClass: 'host_access',
      nextAction: 'Rerun agent-device availability with host/device access before treating this as an app, scenario, or runner regression.',
      nextActionCode: 'rerun_with_host_access',
    };
  }
  if (/timed out|timeout/iu.test(diagnostic)) {
    return {
      failureClass: 'timeout',
      nextAction: 'Confirm agent-device can run without prompts, increase --command-timeout-ms if it is legitimately slow, then rerun the availability check.',
      nextActionCode: 'increase_agent_device_timeout',
    };
  }
  if (/enoent|not found|command not found|no such file or directory/iu.test(diagnostic)) {
    return {
      failureClass: 'missing_binary',
      nextAction: 'Install agent-device or pass the correct binary with --agent-device before starting live proof.',
      nextActionCode: 'configure_agent_device_binary',
    };
  }
  return {
    failureClass: 'command_surface',
    nextAction: 'Inspect the failed agent-device command output, fix the command surface, then rerun the availability check before starting live proof.',
    nextActionCode: 'inspect_agent_device_availability',
  };
}

/**
 * Parses a comma-separated platform requirement list for availability checks.
 *
 * @param {unknown} value
 * @returns {import('./agent-device-driver').AgentDevicePlatform[]}
 */
function parseRequiredPlatforms(value: unknown): import('./agent-device-driver').AgentDevicePlatform[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((platform) => platform.trim())
    .filter((platform): platform is import('./agent-device-driver').AgentDevicePlatform =>
      ['android', 'apple', 'ios', 'linux', 'macos'].includes(platform),
    );
}

/**
 * Parses how a named agent-device session should participate in target selection.
 *
 * @param {unknown} value
 * @returns {AgentDeviceSessionMode}
 */
function parseAgentDeviceSessionMode(value: unknown): AgentDeviceSessionMode {
  if (value === undefined || value === false) {
    return 'reuse';
  }
  if (value === 'bind' || value === 'reuse') {
    return value;
  }
  throw new Error('--session-mode must be either reuse or bind.');
}

/**
 * Builds one availability check result from an agent-device command execution.
 *
 * @param {{code: string, expectedPattern: RegExp, name: string, result: CommandResult}} options
 * @returns {AgentDeviceAvailabilityCheck}
 */
function buildAgentDeviceAvailabilityCheck({
  code,
  expectedPattern,
  name,
  result,
}: {
  code: string;
  expectedPattern: RegExp;
  name: string;
  result: CommandResult;
}): AgentDeviceAvailabilityCheck {
  const output = `${result.stdout}\n${result.stderr}`;
  const passed = result.exitCode === 0 && expectedPattern.test(output);
  const check: AgentDeviceAvailabilityCheck = {
    args: result.args,
    code,
    command: result.command,
    exitCode: result.exitCode,
    message: passed ? `${name} is available.` : `${name} did not return the expected agent-device output.`,
    name,
    status: passed ? 'passed' : 'failed',
  };
  if (!passed) {
    const stderrPreview = previewCommandOutput(result.stderr);
    const stdoutPreview = previewCommandOutput(result.stdout);
    check.metadata = classifyAgentDeviceAvailabilityFailure(result);
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
 * Parses agent-device device discovery JSON.
 *
 * @param {CommandResult} result
 * @returns {Array<Record<string, unknown>>}
 */
function readAgentDeviceDiscoveryDevices(result: CommandResult): Array<Record<string, unknown>> {
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data as Record<string, unknown>
      : null;
    return Array.isArray(data?.devices)
      ? data.devices.filter((device): device is Record<string, unknown> =>
          Boolean(device) && typeof device === 'object' && !Array.isArray(device),
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Checks whether device discovery found a booted mobile target for one platform.
 *
 * @param {Array<Record<string, unknown>>} devices
 * @param {import('./agent-device-driver').AgentDevicePlatform} platform
 * @returns {boolean}
 */
function hasBootedMobilePlatform(
  devices: Array<Record<string, unknown>>,
  platform: import('./agent-device-driver').AgentDevicePlatform,
): boolean {
  return devices.some((device) =>
    device.platform === platform &&
    device.target === 'mobile' &&
    device.booted === true,
  );
}

/**
 * Verifies that the configured agent-device command exposes ASL-required surfaces.
 *
 * @param {AgentDeviceAvailabilityOptions} options
 * @returns {Promise<AgentDeviceAvailabilityResult>}
 */
async function checkAgentDeviceAvailability({
  agentDevicePath = 'agent-device',
  commandTimeoutMs = 30_000,
  executor,
  requiredCommands = DEFAULT_AGENT_DEVICE_REQUIRED_COMMANDS,
  requiredPlatforms = [],
}: AgentDeviceAvailabilityOptions = {}): Promise<AgentDeviceAvailabilityResult> {
  const run = executor ?? ((command, args) => execFileCommandWithTimeout(command, args, commandTimeoutMs));
  const checks: AgentDeviceAvailabilityCheck[] = [];
  const help = await run(agentDevicePath, ['--help']);
  checks.push(buildAgentDeviceAvailabilityCheck({
    code: 'agent_device_help_available',
    expectedPattern: /CLI to control iOS and Android devices/u,
    name: 'agent_device_help',
    result: help,
  }));

  for (const commandName of requiredCommands) {
    const commandLabel = commandName.replace(/\s+/gu, '_');
    const pattern = commandName === 'session list'
      ? /\bsession\s+list\b/u
      : new RegExp(`\\b${commandName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u');
    checks.push(buildAgentDeviceAvailabilityCheck({
      code: `agent_device_command_${commandLabel}_available`,
      expectedPattern: pattern,
      name: `agent_device_command_${commandLabel}`,
      result: help,
    }));
  }

  const devicesResult = await run(agentDevicePath, ['devices', '--json']);
  const devices = readAgentDeviceDiscoveryDevices(devicesResult);
  const discoveryPassed = devicesResult.exitCode === 0 && devices.length > 0;
  const devicesCheck: AgentDeviceAvailabilityCheck = {
    args: devicesResult.args,
    code: 'agent_device_devices_available',
    command: devicesResult.command,
    exitCode: devicesResult.exitCode,
    message: discoveryPassed
      ? `agent-device discovered ${devices.length} device(s).`
      : 'agent-device did not return any discoverable devices.',
    name: 'agent_device_devices',
    status: discoveryPassed ? 'passed' : 'failed',
  };
  if (!discoveryPassed) {
    const stderrPreview = previewCommandOutput(devicesResult.stderr);
    const stdoutPreview = previewCommandOutput(devicesResult.stdout);
    devicesCheck.metadata = classifyAgentDeviceAvailabilityFailure(devicesResult);
    if (stderrPreview) {
      devicesCheck.stderrPreview = stderrPreview;
    }
    if (stdoutPreview) {
      devicesCheck.stdoutPreview = stdoutPreview;
    }
  }
  checks.push(devicesCheck);

  for (const platform of requiredPlatforms) {
    const passed = hasBootedMobilePlatform(devices, platform);
    checks.push({
      args: devicesResult.args,
      code: `agent_device_booted_${platform}_available`,
      command: devicesResult.command,
      exitCode: devicesResult.exitCode,
      message: passed
        ? `agent-device discovered a booted ${platform} mobile target.`
        : `agent-device did not discover a booted ${platform} mobile target.`,
      name: `agent_device_booted_${platform}`,
      status: passed ? 'passed' : 'failed',
    });
  }

  const status = checks.every((check) => check.status === 'passed') ? 'passed' : 'failed';
  return {
    agentDevicePath,
    checks,
    devices,
    requiredCommands,
    requiredPlatforms,
    status,
  };
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
 * Reads a quoted agent-device session name from a diagnostic message.
 *
 * @param {string | undefined} message
 * @returns {string | null}
 */
function readDiagnosticSessionName(message: string | undefined): string | null {
  if (!message) {
    return null;
  }

  return /session "([^"]+)"/u.exec(message)?.[1] ?? null;
}

/**
 * Builds the most specific next-action hint available from an agent-device failure.
 *
 * @param {AgentDeviceFailureHintOptions} options
 * @returns {NextActionHint}
 */
function buildAgentDeviceFailureHint({
  defaultNextAction,
  defaultNextActionCode,
  errorMetadata,
  rawFileName,
}: AgentDeviceFailureHintOptions): NextActionHint {
  const errorCode = errorMetadata.agentDeviceErrorCode;
  const errorMessage = errorMetadata.agentDeviceErrorMessage;
  const sessionName = readDiagnosticSessionName(errorMessage);

  if (errorCode === 'DEVICE_IN_USE') {
    return nextActionHint(
      'reuse_agent_device_session',
      sessionName
        ? `Device is already owned by agent-device session "${sessionName}". Reuse that session with --agent-device-session ${sessionName}, close it, or choose another device before rerunning.`
        : 'Device is already owned by another agent-device session. Reuse the owning session with --agent-device-session, close it, or choose another device before rerunning.',
    );
  }

  if (errorMessage && /bound to .* cannot be used with --platform=/u.test(errorMessage)) {
    return nextActionHint(
      'select_agent_device_session',
      'The selected agent-device session is bound to another platform or device. Use a platform-specific --agent-device-session, close the bound session, or rerun without the conflicting session.',
    );
  }

  if (errorMessage && /No active session\. Run open first/u.test(errorMessage)) {
    return nextActionHint(
      'open_agent_device_session',
      `agent-device has no active session for this action. Inspect raw/${rawFileName}, make the app open step pass, or pass an existing --agent-device-session before rerunning.`,
    );
  }

  if (errorMessage && /session lock policy/u.test(errorMessage)) {
    return nextActionHint(
      'fix_agent_device_session_lock',
      'agent-device rejected the command because session lock policy conflicts with target selectors. Reuse the locked session directly, remove conflicting target selectors, or close the session before rerunning.',
    );
  }

  return nextActionHint(defaultNextActionCode, defaultNextAction);
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
  commandTimeoutMs = 60_000,
  delay: wait = delay,
  device = null,
  driverSteps,
  executor,
  open = false,
  outputDir = path.resolve('artifacts/agent-device-capture'),
  platform,
  runId = createRunId(),
  scenario = null,
  serial = null,
  session = null,
  sessionMode = 'reuse',
  target = 'mobile',
  udid = null,
  waitMs = 0,
}: AgentDeviceCaptureOptions): Promise<AgentDeviceCaptureResult> {
  const run = executor ?? ((command, args) => execFileCommandWithTimeout(command, args, commandTimeoutMs));
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
  const requestedTarget = udid ?? serial ?? device ?? null;
  const sessionName = typeof session === 'string' && session.length > 0 ? session : null;
  const normalizedSessionMode = parseAgentDeviceSessionMode(sessionMode);
  const sessionOwnsTarget = Boolean(sessionName) && (normalizedSessionMode === 'reuse' || !requestedTarget);

  const driver = createAgentDeviceDriver({
    agentDevicePath,
    ...(!sessionOwnsTarget && device ? { device } : {}),
    executor: run,
    platform,
    ...(!sessionOwnsTarget && serial ? { serial } : {}),
    ...(sessionName ? { session: sessionName } : {}),
    ...(!sessionOwnsTarget ? { target } : {}),
    ...(!sessionOwnsTarget && udid ? { udid } : {}),
  });

  const metadata: Record<string, unknown> = {
    app,
    device,
    driverActions: [],
    open,
    platform,
    ...(requestedTarget ? { requestedTarget } : {}),
    selectedTarget: sessionOwnsTarget ? sessionName : requestedTarget,
    session: sessionName,
    sessionMode: normalizedSessionMode,
    target,
    targetSelectionMode: sessionOwnsTarget ? 'session' : sessionName ? 'session_bind' : 'direct',
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
      const errorMetadata = openResult.exitCode !== 0 ? readAgentDeviceErrorMetadata(openResult) : {};
      checks.push({
        name: 'agent_device_opened',
        status: openResult.exitCode === 0 ? 'passed' : 'failed',
        source: 'runner',
        code: openResult.exitCode === 0 ? 'agent_device_opened' : 'agent_device_open_failed',
        message: openResult.exitCode === 0 ? `Opened ${app} with agent-device.` : `Failed to open ${app} with agent-device.`,
        ...(openResult.exitCode !== 0
          ? {
              metadata: {
                ...buildAgentDeviceFailureHint({
                  defaultNextAction: `Inspect raw/${openResult.rawFileName}, confirm the selected device is available, and rerun the capture.`,
                  defaultNextActionCode: 'inspect_agent_device_open',
                  errorMetadata,
                  rawFileName: openResult.rawFileName,
                }),
                ...errorMetadata,
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
    const errorMetadata = failed ? readAgentDeviceErrorMetadata(driverResult) : {};
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
          ? buildAgentDeviceFailureHint({
              defaultNextAction: `Inspect raw/${driverResult.rawFileName}, confirm the device is interactive and the action metadata is valid, then rerun the capture.`,
              defaultNextActionCode: 'inspect_agent_device_driver_action',
              errorMetadata,
              rawFileName: driverResult.rawFileName,
            })
          : {}),
        ...(failed ? errorMetadata : {}),
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
  const commandTimeoutMs = readPositiveInteger(args['command-timeout-ms'], 60_000);
  if (args.check === true || args.check === 'true') {
    const result = await checkAgentDeviceAvailability({
      ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
      commandTimeoutMs,
      requiredPlatforms: parseRequiredPlatforms(args['require-platforms']),
    });
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
  if (!['android', 'apple', 'ios', 'linux', 'macos'].includes(args.platform)) {
    throw new Error('--platform must be one of android, ios, macos, linux, or apple.');
  }

  const result = await runAgentDeviceCapture({
    ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
    ...(typeof args.app === 'string' ? { app: args.app } : {}),
    commandTimeoutMs,
    ...(typeof args.device === 'string' ? { device: args.device } : {}),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    open: isEnabled(args.open),
    platform: args.platform as import('./agent-device-driver').AgentDevicePlatform,
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    scenario: readJson(path.resolve(args.scenario)),
    ...(typeof args.serial === 'string' ? { serial: args.serial } : {}),
    ...(typeof args.session === 'string' ? { session: args.session } : {}),
    ...(typeof args['session-mode'] === 'string' ? { sessionMode: parseAgentDeviceSessionMode(args['session-mode']) } : {}),
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
  checkAgentDeviceAvailability,
  defaultAgentDeviceCaptureFileName,
  defaultAgentDeviceRawFileName,
  execFileCommand,
  execFileCommandWithTimeout,
  isAgentDeviceSelector,
  main,
  parseArgs,
  parseAgentDeviceSessionMode,
  parseRequiredPlatforms,
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
  AgentDeviceAvailabilityOptions,
  AgentDeviceAvailabilityResult,
  AgentDeviceAvailabilityCheck,
  AgentDeviceSessionMode,
  CliArgs,
  CommandExecutor,
  CommandResult,
};
