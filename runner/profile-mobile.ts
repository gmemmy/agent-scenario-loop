#!/usr/bin/env node

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  evaluateRunnerCompatibility,
} = require('../core/planner');
const {
  buildBudgetVerdict,
  buildCausalRun,
  buildCausalTimeline,
  buildManifest,
  buildMetricsFromProfileEvents,
  buildSummaryMarkdown,
  extractProfileEvents,
  extractProfileSessionEntries,
} = require('../core/artifact-contract');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { writeUsage } = require('./cli');

type CliArgValue = string | boolean | Array<string | boolean>;
type CliArgs = {
  'adb-artifacts'?: string | boolean;
  'simctl-artifacts'?: string | boolean;
  capture?: CliArgValue;
  config?: string | boolean;
  scenario?: string | boolean;
  events?: string | boolean;
  out?: string | boolean;
  provider?: CliArgValue;
  'profile-session-entries'?: string | boolean;
  'run-id'?: string | boolean;
  signal?: CliArgValue;
  [key: string]: CliArgValue | undefined;
};

type ProfileRunResult = {
  runDir: string;
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
};
type CompatibilityPreflightOptions = {
  args: CliArgs;
  artifactRoot: string;
  platform: ProfilePlatform;
  primaryRunner: Record<string, unknown>;
  runDir: string;
  runId: string;
  scenario: Record<string, unknown>;
  scenarioName: string;
};
type ProfilePlatform = 'android' | 'ios';
type ProfileMobileOptions = {
  commandTransport?: string;
  comparisonLane?: string;
  defaultDriver: string;
  environmentPostconditions?: Record<string, unknown>;
  environmentPreconditions?: Record<string, unknown>;
  interactionDriver?: string;
  platform: ProfilePlatform;
  provenanceCohort?: Record<string, unknown>;
};
type CaptureEvidenceKind = 'screenshot' | 'uiTree' | 'video';
type ProviderEvidenceKind = 'accessibility' | 'logs' | 'nativePerformance' | 'profiler';
type SignalEvidenceKind = 'js' | 'memory' | 'network';
type EvidenceChannel = 'capture' | 'provider' | 'signal';
type EvidenceKind = CaptureEvidenceKind | ProviderEvidenceKind | SignalEvidenceKind;
type DiagnosticStatus = 'captured' | 'not_requested' | 'not_supported' | 'unavailable' | 'failed' | 'skipped' | 'missing';
type DiagnosticKind = EvidenceKind | 'logs';
type DiagnosticInventoryEntry = {
  kind: DiagnosticKind;
  status: DiagnosticStatus;
  required: boolean;
  name?: string;
  provider?: string;
  runnerId?: string;
  path?: string;
  reason?: string;
  nextAction?: string;
  sidecarRoot?: string;
  evidenceDependency?: {
    kind: string;
    root?: 'run' | 'sidecar';
    path: string;
  };
};
type SidecarEvidenceDependency = {
  kind: 'sidecar';
  root?: 'sidecar';
  path: string;
};
type EvidenceAttachment = {
  channel: EvidenceChannel;
  completenessStatus: 'complete';
  corruptionStatus: 'valid';
  destinationPath: string;
  kind: EvidenceKind;
  manifestPath: string;
  providerId?: string;
  redactionStatus: 'not-redacted';
  required: boolean;
  sha256: string;
  sourcePath: string;
  sourceFileName: string;
  sizeBytes: number;
  transformations: readonly ['copied'];
};
type EvidenceAttachmentInput = {
  channel: EvidenceChannel;
  destinationPath: string;
  kind: EvidenceKind;
  manifestPath: string;
  providerId?: string;
  required?: boolean;
  sourcePath: string;
};
type AttachedEvidence = {
  attachments: EvidenceAttachment[];
  captures: {
    screenshots: string[];
    uiTree: string | null;
    video: string | null;
  };
  copies: EvidenceAttachment[];
  signals: Record<SignalEvidenceKind, string[]>;
};
type RuntimeTarget = {
  name: string;
  udid: string;
};
/**
 * Resolves the consumer repo git revision for manifest provenance.
 *
 * @returns {string}
 */
function resolveGitSha(): string {
  const envSha = process.env.ASL_GIT_SHA;
  if (typeof envSha === 'string' && envSha.trim().length > 0) {
    return envSha.trim();
  }

  const gitRoot = process.env.ASL_GIT_ROOT;
  const cwd = typeof gitRoot === 'string' && gitRoot.trim().length > 0 ? gitRoot.trim() : process.cwd();
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
type EvidenceIdentityFailure = {
  code: 'profile_session_identity_ambiguous';
  message: string;
  requestedRunId: string;
  sourceRunIds: string[];
};
type ProviderCommandOutput = {
  channel: EvidenceChannel;
  kind: EvidenceKind;
  path: string;
  required?: boolean;
};
type ProviderCommand = {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  id: string;
  outputs: ProviderCommandOutput[];
  phase: 'prepare' | 'startWindow' | 'capture' | 'stopWindow' | 'afterCapture' | 'postRun' | 'finalize';
};
const SUPPORTED_PROVIDER_COMMAND_PHASES = new Set<ProviderCommand['phase']>(['capture', 'afterCapture', 'postRun']);
type ProviderManifest = {
  kind?: string;
  platforms?: string[];
  providerCommands?: ProviderCommand[];
  runnerId?: string;
  version?: string;
};
type ProviderCommandContext = {
  capturesDir: string;
  platform: ProfilePlatform;
  providerDir: string;
  rawDir: string;
  runDir: string;
  runId: string;
  scenarioId: string;
};
type ProviderCommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  signal: string | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};
type ProviderCommandFailure = {
  commandId: string;
  code?: string;
  exitCode: number | null;
  message?: string;
  name?: string;
  nextAction?: string;
  nextActionCode?: string;
  phase: ProviderCommand['phase'];
  providerId: string;
  rawPath?: string;
};
type ProviderOutputStatus = {
  channel: EvidenceChannel;
  commandId: string;
  kind: EvidenceKind;
  path: string;
  phase: ProviderCommand['phase'];
  providerId: string;
  reason?: string;
  required: boolean;
  status: 'captured' | 'missing';
};
type ProviderCommandExecution = {
  failures: ProviderCommandFailure[];
  inputs: EvidenceAttachmentInput[];
  outputStatuses: ProviderOutputStatus[];
  providers: Array<{ name: string; version?: string }>;
};
type ProfileRunPlan = {
  artifactVersion: '1.0.0';
  runId: string;
  scenarioId: string;
  scenarioHash: string;
  platform: ProfilePlatform;
  inputMode: string;
  artifactRoot: string;
  runDir: string;
  interactionDriver: string;
  comparisonLane?: string;
  expectedIterations: number;
  milestoneEventsPerIteration: number;
  commandTransport: string;
  providers: Array<{
    path: string;
  }>;
  requestedDiagnostics: {
    required: string[];
    optional: string[];
  };
  scenarioShape: {
    budgets: number;
    steps: number;
    stepKinds: string[];
    waitForMilestones: string[];
  };
  evidenceSources: {
    events?: string;
    profileSessionEntries?: string;
    adbArtifacts?: string;
    simctlArtifacts?: string;
    adbCapture: boolean;
    simctlCapture: boolean;
    signals: number;
    captures: number;
  };
};
type ProfileSessionSeed = {
  runId: string;
  scenario: string;
  startedAt: number;
};
type ProfileSessionFreshness = {
  appStartedAt?: number;
  reason?: string;
  seed: ProfileSessionSeed;
  status: 'fresh' | 'missing-app-session' | 'stale';
};
type ProfileHelperVersionCheck = {
  expectedVersion: string;
  observedVersions: string[];
  reason: string;
  status: 'matched' | 'missing' | 'mismatched';
};
type ExpectedRuntimeIdentityValue = {
  source: 'cli' | 'config';
  value: string;
};
type RuntimeIdentityVerification = {
  expectedAppId?: string;
  expectedAppIdSource?: 'cli' | 'config';
  expectedTargetId?: string;
  expectedTargetIdSource?: 'cli';
  nextAction: string;
  nextActionCode: string;
  observedAppId?: string;
  observedTargetId?: string;
  platform: ProfilePlatform;
  reason: string;
  sidecarMetadataPath: string;
  status: 'mismatched' | 'unverified' | 'verified';
};
const CAPTURE_EVIDENCE_KINDS = new Set(['screenshot', 'uiTree', 'video']);
const PROVIDER_EVIDENCE_KINDS = new Set(['accessibility', 'logs', 'nativePerformance', 'profiler']);
const SIGNAL_EVIDENCE_KINDS = new Set(['js', 'memory', 'network']);
const DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS = 180_000;
const PLACEHOLDER_APP_IDS = new Set(['com.example.app']);
const EXPECTED_PROFILE_SESSION_HELPER_VERSION = '1.0.0';

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage({
  binaryName,
  output = process.stderr,
  platform,
}: {
  binaryName: string;
  output?: { write: (message: string) => unknown };
  platform: ProfilePlatform;
}): void {
  const lines = [
    `Usage: ${binaryName} --config <path> --scenario <path> [--events <path>] [--out <dir>] [--run-id <id>]`,
    '',
    `Reads scenario metadata plus profile-event evidence and writes the artifact layout for one ${platform} profile run.`,
    'Use --comparison-lane <id> to keep latest-trusted baselines inside a stable proof lane.',
    'Use repeated --provider <manifest> to execute declared evidence-provider commands before artifact writing.',
    'Use repeated --signal <js|memory|network>:<path> to attach provider signal artifacts.',
    'Use repeated --capture <screenshot|video|uiTree>:<path> to attach named capture artifacts.',
  ];
  if (platform === 'android') {
    lines.push('Use --adb-artifacts <dir> to read raw/adb-logcat.txt from a prior asl-android-adb capture.');
    lines.push('Use --adb-capture [--clear-logcat] [--launch] [--launch-wait-ms <ms>] [--wait-ms <ms>] [--adb-command-timeout-ms <ms>] to capture adb logcat before profiling.');
    lines.push('Use --android-dev-client-url <url> [--android-dev-client-wait-ms <ms>] [--android-dev-client-ready-pattern <pattern>] with --adb-capture to open an Expo dev-client session before profile-session deep links.');
    lines.push('Use --android-profile-session-storage with --profile-session to seed startup control through Android AsyncStorage.');
    lines.push('Use --profile-session with --adb-capture to start the app profile session and execute scenario-declared Android commands.');
  } else {
    lines.push('Use --simctl-artifacts <dir> to read raw/ios-simctl-log.txt from a prior iOS simctl capture.');
    lines.push('Use --simctl-capture [--launch] [--wait-ms <ms>] to capture iOS simulator logs before profiling.');
    lines.push('Use --profile-session with --simctl-capture to start the app profile session and execute scenario-declared iOS commands.');
    lines.push('Use --profile-session-storage with --profile-session to seed startup control through iOS AsyncStorage and collect stored truth events.');
  }
  lines.push('Use --agent-device-capture to execute scenario-declared portable driver actions through agent-device and attach its captures.');
  lines.push('Use --agent-device-session-mode bind when a named agent-device session should still receive the configured Android serial or iOS UDID.');
  lines.push('Use --lifecycle-phase <phase> when the runner can explicitly assert a non-cold lifecycle precondition such as warm-launch or resume.');

  writeUsage(lines, output);
}

/**
 * Parses `--key value` arguments for a mobile profile runner.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    const hasValue = typeof value === 'string' && !value.startsWith('--');
    const resolvedValue = hasValue ? value : true;
    const existingValue = args[key];
    if (Array.isArray(existingValue)) {
      existingValue.push(resolvedValue);
    } else if (existingValue !== undefined) {
      args[key] = [existingValue, resolvedValue];
    } else {
      args[key] = resolvedValue;
    }
    if (hasValue) {
      index += 1;
    }
  }
  return args;
}

/**
 * Returns a scalar CLI flag value, ignoring repeated values for scalar-only flags.
 *
 * @param {string | boolean | Array<string | boolean> | undefined} value
 * @returns {string | boolean | undefined}
 */
function readScalarArg(value: CliArgValue | undefined): string | boolean | undefined {
  return Array.isArray(value) ? undefined : value;
}

/**
 * Reads and parses a JSON file.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Creates a directory and any missing parents.
 *
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

/**
 * Returns string values supplied for a repeatable CLI option.
 *
 * @param {CliArgs} args
 * @param {string} key
 * @returns {string[]}
 */
function readRepeatableArgValues(args: CliArgs, key: string): string[] {
  const value = args[key];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];

  return values.map((entry) => {
    if (typeof entry !== 'string') {
      throw new Error(`--${key} requires a value.`);
    }

    return entry;
  });
}

/**
 * Reads whether a boolean-style CLI flag was supplied.
 *
 * @param {CliArgValue | undefined} value
 * @returns {boolean}
 */
function isEnabled(value: CliArgValue | undefined): boolean {
  return value === true || value === 'true';
}

/**
 * Parses a `kind:path` evidence attachment value.
 *
 * @param {{argName: string, allowedKinds: Set<string>, value: string}} options
 * @returns {{kind: string, sourcePath: string}}
 */
function parseEvidenceArg({
  allowedKinds,
  argName,
  value,
}: {
  allowedKinds: Set<string>;
  argName: string;
  value: string;
}): { kind: string; sourcePath: string } {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`--${argName} must use <kind>:<path>.`);
  }

  const kind = value.slice(0, separatorIndex);
  if (!allowedKinds.has(kind)) {
    throw new Error(`Unsupported --${argName} kind "${kind}".`);
  }

  return {
    kind,
    sourcePath: path.resolve(value.slice(separatorIndex + 1)),
  };
}

/**
 * Hashes one provider artifact without recording its source path in public metadata.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function hashFileSha256(filePath: string): Promise<string> {
  const content = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Resolves the timeout applied to provider commands.
 *
 * @returns {number}
 */
function resolveProviderCommandTimeoutMs(): number {
  return readPositiveInteger(process.env.ASL_PROVIDER_COMMAND_TIMEOUT_MS, DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS);
}

/**
 * Runs one provider command without a shell, streaming output to raw files.
 *
 * @param {{command: string, args: string[], cwd?: string, env?: Record<string, string>, stderrPath: string, stdoutPath: string, timeoutMs: number}} options
 * @returns {Promise<ProviderCommandResult>}
 */
function execProviderCommand({
  args,
  command,
  cwd,
  env,
  stderrPath,
  stdoutPath,
  timeoutMs,
}: {
  args: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  stderrPath: string;
  stdoutPath: string;
  timeoutMs: number;
}): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      env: env ? { ...process.env, ...env } : process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 1000).unref();
    }, timeoutMs);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      fs.appendFileSync(stdoutPath, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      fs.appendFileSync(stderrPath, chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      settled = true;
      const stderr = error.message;
      fs.appendFileSync(stderrPath, `${stderr}\n`, 'utf8');
      resolve({
        args,
        command,
        exitCode: 1,
        signal: null,
        stderr,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut,
      });
    });
    child.on('close', (exitCode: number | null, signal: string | null) => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({
        args,
        command,
        exitCode: typeof exitCode === 'number' ? exitCode : timedOut ? 124 : 1,
        signal,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

/**
 * Replaces provider command placeholders with run-local paths and ids.
 *
 * @param {string} value
 * @param {ProviderCommandContext} context
 * @returns {string}
 */
function applyProviderPlaceholders(value: string, context: ProviderCommandContext): string {
  return value
    .replaceAll('{capturesDir}', context.capturesDir)
    .replaceAll('{platform}', context.platform)
    .replaceAll('{providerDir}', context.providerDir)
    .replaceAll('{rawDir}', context.rawDir)
    .replaceAll('{runDir}', context.runDir)
    .replaceAll('{runId}', context.runId)
    .replaceAll('{scenarioId}', context.scenarioId);
}

/**
 * Resolves a provider command path after placeholder expansion.
 *
 * @param {{context: ProviderCommandContext, manifestDir: string, value: string}} options
 * @returns {string}
 */
function resolveProviderPath({
  context,
  manifestDir,
  value,
}: {
  context: ProviderCommandContext;
  manifestDir: string;
  value: string;
}): string {
  const resolved = applyProviderPlaceholders(value, context);
  return path.isAbsolute(resolved) ? resolved : path.resolve(manifestDir, resolved);
}

/**
 * Makes a provider id safe for run-local raw artifact filenames.
 *
 * @param {string} value
 * @returns {string}
 */
function safeProviderSegment(value: string): string {
  return value.replace(/[^a-z0-9-]+/giu, '-').replace(/^-|-$/gu, '') || 'provider';
}

/**
 * Converts one provider-declared output into an attachment copy plan.
 *
 * @param {{layout: ReturnType<typeof createArtifactLayout>, output: ProviderCommandOutput, providerId: string, sourcePath: string}} options
 * @returns {EvidenceAttachmentInput}
 */
function buildProviderEvidenceInput({
  layout,
  output,
  providerId,
  sourcePath,
}: {
  layout: ReturnType<typeof createArtifactLayout>;
  output: ProviderCommandOutput;
  providerId: string;
  sourcePath: string;
}): EvidenceAttachmentInput {
  const fileName = path.basename(sourcePath);
  if (output.channel === 'signal') {
    if (!SIGNAL_EVIDENCE_KINDS.has(output.kind)) {
      throw new Error(`Provider output ${providerId}/${output.path} uses signal channel with unsupported kind "${output.kind}".`);
    }

    const kind = output.kind as SignalEvidenceKind;
    return {
      channel: 'signal',
      destinationPath: path.join(layout.signals[kind], fileName),
      kind,
      manifestPath: `signals/${kind}/${fileName}`,
      providerId,
      ...(typeof output.required === 'boolean' ? { required: output.required } : {}),
      sourcePath,
    };
  }

  if (output.channel === 'capture') {
    if (!CAPTURE_EVIDENCE_KINDS.has(output.kind)) {
      throw new Error(`Provider output ${providerId}/${output.path} uses capture channel with unsupported kind "${output.kind}".`);
    }

    return {
      channel: 'capture',
      destinationPath: path.join(layout.captures, fileName),
      kind: output.kind as CaptureEvidenceKind,
      manifestPath: `captures/${fileName}`,
      providerId,
      ...(typeof output.required === 'boolean' ? { required: output.required } : {}),
      sourcePath,
    };
  }

  if (!PROVIDER_EVIDENCE_KINDS.has(output.kind) && !SIGNAL_EVIDENCE_KINDS.has(output.kind)) {
    throw new Error(`Provider output ${providerId}/${output.path} uses unsupported provider kind "${output.kind}".`);
  }

  return {
    channel: 'provider',
    destinationPath: path.join(layout.raw, 'providers', providerId, fileName),
    kind: output.kind,
    manifestPath: `raw/providers/${providerId}/${fileName}`,
    providerId,
    ...(typeof output.required === 'boolean' ? { required: output.required } : {}),
    sourcePath,
  };
}

/**
 * Validates structured provider evidence when a provider emits JSON.
 *
 * Raw traces, screenshots, and binary captures may be attached as preserved
 * evidence, but JSON profiler and native-performance files must carry enough
 * envelope metadata for agents to reason about source, target, completeness,
 * and comparability.
 *
 * @param {{kind: EvidenceKind, sourcePath: string}} options
 * @returns {void}
 */
function validateStructuredProviderEvidence({
  kind,
  sourcePath,
}: {
  kind: EvidenceKind;
  sourcePath: string;
}): void {
  if (path.extname(sourcePath).toLowerCase() !== '.json') {
    return;
  }

  const structuredSchema = kind === 'profiler'
    ? {
        label: 'Profiler evidence artifact',
        schema: SCHEMAS.profiler,
      }
    : kind === 'nativePerformance'
      ? {
          label: 'Native performance evidence artifact',
          schema: SCHEMAS.nativePerformance,
        }
      : null;

  if (!structuredSchema) {
    return;
  }

  try {
    assertValidJson(readJson(sourcePath), structuredSchema.schema, structuredSchema.label);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${structuredSchema.label} is invalid: ${sourcePath}. ${detail}`);
  }
}

/**
 * Fails when provider command ids would collide in raw command records.
 *
 * @param {{providerCommands?: ProviderCommand[], providerId: string}} options
 * @returns {void}
 */
function assertUniqueProviderCommandIds({
  providerCommands = [],
  providerId,
}: {
  providerCommands: ProviderCommand[] | undefined;
  providerId: string;
}): void {
  const seen = new Set<string>();
  for (const providerCommand of providerCommands) {
    if (seen.has(providerCommand.id)) {
      throw new Error(`Evidence provider \`${providerId}\` declares duplicate providerCommand id \`${providerCommand.id}\`.`);
    }
    seen.add(providerCommand.id);
  }
}

/**
 * Executes declared evidence-provider commands and returns their output attachments.
 *
 * @param {{args: CliArgs, layout: ReturnType<typeof createArtifactLayout>, platform: ProfilePlatform, runDir: string, runId: string, scenarioId: string}} options
 * @returns {Promise<ProviderCommandExecution>}
 */
async function executeProviderCommands({
  args,
  layout,
  platform,
  runDir,
  runId,
  scenarioId,
}: {
  args: CliArgs;
  layout: ReturnType<typeof createArtifactLayout>;
  platform: ProfilePlatform;
  runDir: string;
  runId: string;
  scenarioId: string;
}): Promise<ProviderCommandExecution> {
  const failures: ProviderCommandFailure[] = [];
  const inputs: EvidenceAttachmentInput[] = [];
  const outputStatuses: ProviderOutputStatus[] = [];
  const providers: Array<{ name: string; version?: string }> = [];
  const providerManifestPaths = readRepeatableArgValues(args, 'provider');
  if (providerManifestPaths.length === 0) {
    return { failures, inputs, outputStatuses, providers };
  }

  const commandRecordDir = path.join(layout.raw, 'provider-commands');
  await ensureDir(commandRecordDir);

  for (const providerManifestPath of providerManifestPaths) {
    const absoluteManifestPath = path.resolve(providerManifestPath);
    const manifestDir = path.dirname(absoluteManifestPath);
    const provider = assertValidJson(
      readJson(absoluteManifestPath),
      SCHEMAS.runnerCapabilities,
      'Evidence provider manifest',
    ) as ProviderManifest;
    if (provider.kind !== 'evidenceProvider') {
      throw new Error(`Provider manifest must use kind "evidenceProvider": ${absoluteManifestPath}`);
    }

    const providerId = safeProviderSegment(String(provider.runnerId ?? path.basename(absoluteManifestPath, '.json')));
    providers.push({
      name: providerId,
      ...(typeof provider.version === 'string' ? { version: provider.version } : {}),
    });
    if (Array.isArray(provider.platforms) && !provider.platforms.includes(platform)) {
      failures.push({
        commandId: 'platform-compatibility',
        code: 'provider_platform_unsupported',
        exitCode: null,
        message: `Evidence provider ${providerId} does not support selected platform "${platform}".`,
        name: 'evidence_provider_platform_supported',
        nextAction: `Use a provider manifest whose platforms include "${platform}", or run this scenario on one of the provider's supported platforms.`,
        nextActionCode: 'select_supported_provider_platform',
        phase: 'prepare',
        providerId,
      });
      continue;
    }

    assertUniqueProviderCommandIds({
      providerCommands: provider.providerCommands,
      providerId,
    });
    const providerDir = path.join(layout.raw, 'providers', providerId);
    await ensureDir(providerDir);
    const context = {
      capturesDir: layout.captures,
      platform,
      providerDir,
      rawDir: layout.raw,
      runDir,
      runId,
      scenarioId,
    };

    for (const providerCommand of provider.providerCommands ?? []) {
      const commandRecordFileName = `${providerId}-${providerCommand.id}.json`;
      const stdoutFileName = `${providerId}-${providerCommand.id}.stdout.txt`;
      const stderrFileName = `${providerId}-${providerCommand.id}.stderr.txt`;
      const commandRecordPath = path.join(commandRecordDir, commandRecordFileName);
      const stdoutPath = path.join(commandRecordDir, stdoutFileName);
      const stderrPath = path.join(commandRecordDir, stderrFileName);
      if (!SUPPORTED_PROVIDER_COMMAND_PHASES.has(providerCommand.phase)) {
        await fsp.writeFile(
          commandRecordPath,
          `${JSON.stringify({
            command: providerCommand.command,
            phase: providerCommand.phase,
            providerId,
            status: 'unsupported',
            supportedPhases: Array.from(SUPPORTED_PROVIDER_COMMAND_PHASES),
          }, null, 2)}\n`,
          'utf8',
        );
        failures.push({
          commandId: providerCommand.id,
          code: 'provider_lifecycle_phase_unsupported',
          exitCode: null,
          message: `Evidence provider command ${providerId}/${providerCommand.id} declares phase "${providerCommand.phase}", but profile runners currently support only capture, afterCapture, and postRun provider commands.`,
          name: 'evidence_provider_lifecycle_supported',
          nextAction: `Use phase "afterCapture" for diagnostics collected after adb/simctl evidence, "postRun" for post-profile enrichment, or wait for a runner that supports ${providerCommand.phase} scheduling.`,
          nextActionCode: 'select_supported_provider_lifecycle_phase',
          phase: providerCommand.phase,
          providerId,
          rawPath: `raw/provider-commands/${commandRecordFileName}`,
        });
        continue;
      }

      const resolvedCommand = applyProviderPlaceholders(providerCommand.command, context);
      const resolvedArgs = (providerCommand.args ?? []).map((arg) => applyProviderPlaceholders(arg, context));
      const resolvedCwd = providerCommand.cwd
        ? resolveProviderPath({ context, manifestDir, value: providerCommand.cwd })
        : manifestDir;
      const resolvedEnv = Object.fromEntries(
        Object.entries(providerCommand.env ?? {}).map(([key, value]) => [key, applyProviderPlaceholders(value, context)]),
      );
      const timeoutMs = resolveProviderCommandTimeoutMs();
      const startedAt = new Date().toISOString();
      await fsp.writeFile(stdoutPath, '', 'utf8');
      await fsp.writeFile(stderrPath, '', 'utf8');
      await fsp.writeFile(
        commandRecordPath,
        `${JSON.stringify({
          args: resolvedArgs,
          command: resolvedCommand,
          phase: providerCommand.phase,
          providerId,
          startedAt,
          status: 'started',
          stderrPath: `raw/provider-commands/${stderrFileName}`,
          stdoutPath: `raw/provider-commands/${stdoutFileName}`,
          timeoutMs,
        }, null, 2)}\n`,
        'utf8',
      );
      const commandResult = await execProviderCommand({
        args: resolvedArgs,
        command: resolvedCommand,
        cwd: resolvedCwd,
        env: resolvedEnv,
        stderrPath,
        stdoutPath,
        timeoutMs,
      });
      await fsp.writeFile(
        commandRecordPath,
        `${JSON.stringify({
          args: commandResult.args,
          command: commandResult.command,
          endedAt: new Date().toISOString(),
          exitCode: commandResult.exitCode,
          phase: providerCommand.phase,
          providerId,
          signal: commandResult.signal,
          stderr: commandResult.stderr,
          stderrPath: `raw/provider-commands/${stderrFileName}`,
          status: commandResult.timedOut ? 'timed_out' : commandResult.exitCode === 0 ? 'completed' : 'failed',
          stdout: commandResult.stdout,
          stdoutPath: `raw/provider-commands/${stdoutFileName}`,
          timedOut: commandResult.timedOut,
          timeoutMs,
        }, null, 2)}\n`,
        'utf8',
      );
      const commandFailed = commandResult.exitCode !== 0;
      if (commandFailed) {
        const timedOut = commandResult.timedOut;
        failures.push({
          commandId: providerCommand.id,
          code: timedOut ? 'provider_liveness_timeout' : 'provider_command_failed',
          exitCode: commandResult.exitCode,
          message: timedOut
            ? `Evidence provider command ${providerId}/${providerCommand.id} did not finish before the ${timeoutMs}ms timeout.`
            : `Evidence provider command ${providerId}/${providerCommand.id} failed with exit code ${commandResult.exitCode}.`,
          name: 'evidence_provider_command_completed',
          nextAction: timedOut
            ? `Inspect raw/provider-commands/${commandRecordFileName}, raw/provider-commands/${stdoutFileName}, and raw/provider-commands/${stderrFileName}; fix the provider liveness issue or increase ASL_PROVIDER_COMMAND_TIMEOUT_MS only if the provider is making progress.`
            : `Inspect raw/provider-commands/${commandRecordFileName}, fix the provider command or its environment, then rerun the profile.`,
          nextActionCode: timedOut ? 'fix_provider_liveness' : 'fix_provider_command',
          phase: providerCommand.phase,
          providerId,
          rawPath: `raw/provider-commands/${commandRecordFileName}`,
        });
      }

      for (const output of providerCommand.outputs) {
        const sourcePath = resolveProviderPath({ context, manifestDir, value: output.path });
        const exists = Boolean((await fsp.stat(sourcePath).catch(() => null))?.isFile());
        outputStatuses.push({
          channel: output.channel,
          commandId: providerCommand.id,
          kind: output.kind,
          path: output.path,
          phase: providerCommand.phase,
          providerId,
          ...(commandFailed && !exists
            ? { reason: `Provider command ${providerId}/${providerCommand.id} exited before producing this output.` }
            : !exists
              ? { reason: `Provider command ${providerId}/${providerCommand.id} did not produce this declared output.` }
              : {}),
          required: output.required === true,
          status: exists ? 'captured' : 'missing',
        });
        if (!exists) {
          continue;
        }
        inputs.push(buildProviderEvidenceInput({
          layout,
          output,
          providerId,
          sourcePath,
        }));
      }
    }
  }

  return { failures, inputs, outputStatuses, providers };
}

/**
 * Converts internal attachment copy plans into manifest-safe metadata.
 *
 * @param {EvidenceAttachment[]} attachments
 * @returns {Record<string, unknown>[]}
 */
function buildEvidenceAttachmentManifest(attachments: EvidenceAttachment[]): Record<string, unknown>[] {
  return attachments.map((attachment) => ({
    channel: attachment.channel,
    completenessStatus: attachment.completenessStatus,
    corruptionStatus: attachment.corruptionStatus,
    kind: attachment.kind,
    path: attachment.manifestPath,
    redactionStatus: attachment.redactionStatus,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
    sourceFileName: attachment.sourceFileName,
    transformations: attachment.transformations,
  }));
}

/**
 * Validates provider artifact files and resolves their stable run destinations.
 *
 * @param {{args: CliArgs, layout: ReturnType<typeof createArtifactLayout>, providerInputs?: EvidenceAttachmentInput[]}} options
 * @returns {Promise<AttachedEvidence>}
 */
async function resolveAttachedEvidence({
  args,
  layout,
  providerInputs = [],
}: {
  args: CliArgs;
  layout: ReturnType<typeof createArtifactLayout>;
  providerInputs?: EvidenceAttachmentInput[];
}): Promise<AttachedEvidence> {
  const attached: AttachedEvidence = {
    attachments: [],
    captures: {
      screenshots: [],
      uiTree: null,
      video: null,
    },
    copies: [],
    signals: {
      js: [],
      memory: [],
      network: [],
    },
  };
  const destinationPaths = new Set<string>();

  const addCopy = async ({
    channel,
    destinationPath,
    kind,
    manifestPath,
    providerId,
    required = false,
    sourcePath,
  }: EvidenceAttachmentInput): Promise<void> => {
    const stat = await fsp.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Evidence artifact does not exist or is not a file: ${sourcePath}`);
    }

    if (destinationPaths.has(destinationPath)) {
      throw new Error(`Duplicate evidence artifact destination: ${manifestPath}`);
    }

    validateStructuredProviderEvidence({ kind, sourcePath });

    destinationPaths.add(destinationPath);
    const attachment = {
      channel,
      completenessStatus: 'complete' as const,
      corruptionStatus: 'valid' as const,
      destinationPath,
      kind,
      manifestPath,
      ...(providerId ? { providerId } : {}),
      redactionStatus: 'not-redacted' as const,
      required,
      sha256: await hashFileSha256(sourcePath),
      sourceFileName: path.basename(sourcePath),
      sourcePath,
      sizeBytes: stat.size,
      transformations: ['copied'] as const,
    };
    attached.attachments.push(attachment);
    attached.copies.push(attachment);
  };

  const addAttachmentInput = async (input: EvidenceAttachmentInput): Promise<void> => {
    if (input.channel === 'signal') {
      if (!SIGNAL_EVIDENCE_KINDS.has(input.kind)) {
        throw new Error(`Signal evidence kind "${input.kind}" is not supported.`);
      }

      attached.signals[input.kind as SignalEvidenceKind].push(input.manifestPath);
    } else if (input.channel === 'capture') {
      if (input.kind === 'screenshot') {
        attached.captures.screenshots.push(input.manifestPath);
      } else if (input.kind === 'uiTree' || input.kind === 'video') {
        if (attached.captures[input.kind]) {
          throw new Error(`Duplicate capture kind "${input.kind}".`);
        }
        attached.captures[input.kind] = input.manifestPath;
      } else {
        throw new Error(`Capture evidence kind "${input.kind}" is not supported.`);
      }
    }

    await addCopy(input);
  };

  for (const input of providerInputs) {
    await addAttachmentInput(input);
  }

  for (const value of readRepeatableArgValues(args, 'signal')) {
    const parsed = parseEvidenceArg({
      allowedKinds: SIGNAL_EVIDENCE_KINDS,
      argName: 'signal',
      value,
    }) as { kind: SignalEvidenceKind; sourcePath: string };
    const fileName = path.basename(parsed.sourcePath);
    const manifestPath = `signals/${parsed.kind}/${fileName}`;
    await addAttachmentInput({
      channel: 'signal',
      destinationPath: path.join(layout.signals[parsed.kind], fileName),
      kind: parsed.kind,
      manifestPath,
      sourcePath: parsed.sourcePath,
    });
  }

  for (const value of readRepeatableArgValues(args, 'capture')) {
    const parsed = parseEvidenceArg({
      allowedKinds: CAPTURE_EVIDENCE_KINDS,
      argName: 'capture',
      value,
    }) as { kind: CaptureEvidenceKind; sourcePath: string };
    const fileName = path.basename(parsed.sourcePath);
    const manifestPath = `captures/${fileName}`;
    if (parsed.kind === 'screenshot') {
      await addAttachmentInput({
        channel: 'capture',
        destinationPath: path.join(layout.captures, fileName),
        kind: parsed.kind,
        manifestPath,
        sourcePath: parsed.sourcePath,
      });
      continue;
    }

    if (attached.captures[parsed.kind]) {
      throw new Error(`Duplicate --capture kind "${parsed.kind}".`);
    }

    await addAttachmentInput({
      channel: 'capture',
      destinationPath: path.join(layout.captures, fileName),
      kind: parsed.kind,
      manifestPath,
      sourcePath: parsed.sourcePath,
    });
  }

  return attached;
}

/**
 * Copies validated provider artifacts into the run artifact folder.
 *
 * @param {EvidenceAttachment[]} copies
 * @returns {Promise<void>}
 */
async function copyAttachedEvidence(copies: EvidenceAttachment[]): Promise<void> {
  for (const copy of copies) {
    if (path.resolve(copy.sourcePath) === path.resolve(copy.destinationPath)) {
      continue;
    }

    await fsp.copyFile(copy.sourcePath, copy.destinationPath);
  }
}

/**
 * Creates a short random run id for manual profile runs.
 *
 * @returns {string}
 */
function createRunId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Returns a path reference that can move with the artifact folder when possible.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function toPortablePathReference(targetPath: string): string {
  const cwdRelativePath = path.relative(process.cwd(), targetPath);
  if (
    cwdRelativePath &&
    !cwdRelativePath.startsWith('..') &&
    !path.isAbsolute(cwdRelativePath)
  ) {
    return cwdRelativePath;
  }

  return path.basename(targetPath);
}

/**
 * Resolves the evidence input mode before profile parsing starts.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform}} options
 * @returns {string}
 */
function resolveProfileInputMode({ args, platform }: { args: CliArgs; platform: ProfilePlatform }): string {
  if (typeof args.events === 'string') {
    return 'fixture-event-log';
  }

  if (platform === 'android') {
    if (typeof args['adb-artifacts'] === 'string') {
      return 'adb-sidecar';
    }
    if (isEnabled(args['adb-capture'])) {
      return 'adb-live-capture';
    }
  }

  if (typeof args['simctl-artifacts'] === 'string') {
    return 'simctl-sidecar';
  }
  if (isEnabled(args['simctl-capture'])) {
    return 'simctl-live-capture';
  }

  return 'no-profile-evidence';
}

/**
 * Reads unique scenario step kinds for early operator visibility.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {string[]}
 */
function readScenarioStepKinds(scenario: Record<string, unknown>): string[] {
  if (!Array.isArray(scenario.steps)) {
    return [];
  }

  return Array.from(new Set(scenario.steps
    .filter(isRecord)
    .map((step) => step.kind)
    .filter((kind): kind is string => typeof kind === 'string')))
    .sort();
}

/**
 * Reads wait milestone ids from scenario steps.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {string[]}
 */
function readScenarioWaitMilestones(scenario: Record<string, unknown>): string[] {
  if (!Array.isArray(scenario.steps)) {
    return [];
  }

  return Array.from(new Set(scenario.steps
    .filter(isRecord)
    .filter((step) => step.kind === 'waitForMilestone')
    .map((step) => step.milestone)
    .filter((milestone): milestone is string => typeof milestone === 'string')))
    .sort();
}

/**
 * Builds the early run plan artifact before provider commands or event parsing.
 *
 * @param {{args: CliArgs, artifactRoot: string, comparisonLane?: string | undefined, expectedIterations: number, interactionDriver: string, layout: ReturnType<typeof createArtifactLayout>, milestoneEventsPerIteration: number, options: ProfileMobileOptions, profileScenario: Record<string, unknown>, runDir: string, runId: string, scenarioHash: string, scenarioPath: string}} options
 * @returns {ProfileRunPlan}
 */
function buildProfileRunPlan({
  args,
  artifactRoot,
  comparisonLane,
  expectedIterations,
  interactionDriver,
  layout,
  milestoneEventsPerIteration,
  options,
  profileScenario,
  runDir,
  runId,
  scenarioHash,
  scenarioPath,
}: {
  args: CliArgs;
  artifactRoot: string;
  comparisonLane?: string | undefined;
  expectedIterations: number;
  interactionDriver: string;
  layout: ReturnType<typeof createArtifactLayout>;
  milestoneEventsPerIteration: number;
  options: ProfileMobileOptions;
  profileScenario: Record<string, unknown>;
  runDir: string;
  runId: string;
  scenarioHash: string;
  scenarioPath: string;
}): ProfileRunPlan {
  return {
    artifactVersion: '1.0.0',
    runId,
    scenarioId: resolveProfileScenarioName({ scenario: profileScenario, scenarioPath }),
    scenarioHash,
    platform: options.platform,
    inputMode: resolveProfileInputMode({ args, platform: options.platform }),
    artifactRoot,
    runDir,
    interactionDriver,
    ...(comparisonLane ? { comparisonLane } : {}),
    expectedIterations,
    milestoneEventsPerIteration,
    commandTransport: resolveCommandTransport({ args, interactionDriver, options }),
    providers: readRepeatableArgValues(args, 'provider').map((providerPath) => ({
      path: toPortablePathReference(path.resolve(providerPath)),
    })),
    requestedDiagnostics: {
      required: Array.from(readScenarioStringSet(profileScenario, ['artifacts', 'required'])).sort(),
      optional: Array.from(readScenarioStringSet(profileScenario, ['artifacts', 'optional'])).sort(),
    },
    scenarioShape: {
      budgets: Array.isArray(profileScenario.budgets) ? profileScenario.budgets.length : 0,
      steps: Array.isArray(profileScenario.steps) ? profileScenario.steps.length : 0,
      stepKinds: readScenarioStepKinds(profileScenario),
      waitForMilestones: readScenarioWaitMilestones(profileScenario),
    },
    evidenceSources: {
      ...(typeof args.events === 'string' ? { events: toPortablePathReference(path.resolve(args.events)) } : {}),
      ...(typeof args['profile-session-entries'] === 'string'
        ? { profileSessionEntries: toPortablePathReference(path.resolve(args['profile-session-entries'])) }
        : {}),
      ...(typeof args['adb-artifacts'] === 'string'
        ? { adbArtifacts: toPortablePathReference(path.resolve(args['adb-artifacts'])) }
        : {}),
      ...(typeof args['simctl-artifacts'] === 'string'
        ? { simctlArtifacts: toPortablePathReference(path.resolve(args['simctl-artifacts'])) }
        : {}),
      adbCapture: isEnabled(args['adb-capture']),
      simctlCapture: isEnabled(args['simctl-capture']),
      signals: readRepeatableArgValues(args, 'signal').length,
      captures: readRepeatableArgValues(args, 'capture').length,
    },
  };
}

/**
 * Writes the early profile run plan artifact and a compact status heartbeat.
 *
 * @param {{layout: ReturnType<typeof createArtifactLayout>, plan: ProfileRunPlan}} options
 * @returns {Promise<void>}
 */
async function writeProfileRunPlan({
  layout,
  plan,
}: {
  layout: ReturnType<typeof createArtifactLayout>;
  plan: ProfileRunPlan;
}): Promise<void> {
  await fsp.writeFile(layout.runPlan, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  process.stderr.write(
    `profile run plan: ${plan.platform}/${plan.scenarioId} mode=${plan.inputMode} providers=${plan.providers.length} requiredDiagnostics=${plan.requestedDiagnostics.required.length} runPlan=${path.relative(process.cwd(), layout.runPlan)}\n`,
  );
}

/**
 * Returns a path reference from one run folder to an external sidecar.
 *
 * @param {{runDir: string, targetPath: string}} options
 * @returns {string}
 */
function toRunPathReference({ runDir, targetPath }: { runDir: string; targetPath: string }): string {
  const relativePath = path.relative(runDir, targetPath);
  return relativePath.length > 0 ? relativePath : path.basename(targetPath);
}

/**
 * Returns a sidecar dependency path that stays readable in rehydrated artifacts.
 *
 * @param {{runDir: string, sidecarRoot: string, targetPath: string}} options
 * @returns {SidecarEvidenceDependency}
 */
function toSidecarEvidenceDependency({
  runDir,
  sidecarRoot,
  targetPath,
}: {
  runDir: string;
  sidecarRoot: string;
  targetPath: string;
}): SidecarEvidenceDependency {
  const sidecarRelativePath = path.relative(sidecarRoot, targetPath);
  if (
    sidecarRelativePath.length > 0 &&
    !sidecarRelativePath.startsWith('..') &&
    !path.isAbsolute(sidecarRelativePath)
  ) {
    return {
      kind: 'sidecar',
      root: 'sidecar',
      path: sidecarRelativePath,
    };
  }

  return {
    kind: 'sidecar',
    path: toRunPathReference({ runDir, targetPath }),
  };
}

/**
 * Reads scenario string-list declarations into a set.
 *
 * @param {Record<string, unknown>} scenario
 * @param {string[]} pathSegments
 * @returns {Set<string>}
 */
function readScenarioStringSet(
  scenario: Record<string, any>,
  pathSegments: string[],
): Set<string> {
  const values = pathSegments.reduce<unknown>((current, segment) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined
  ), scenario);
  return new Set(
    Array.isArray(values)
      ? values.filter((value: unknown): value is string => typeof value === 'string')
      : [],
  );
}

/**
 * Returns true when a scenario artifact declaration matches a diagnostic kind.
 *
 * @param {Set<string>} artifacts
 * @param {string[]} aliases
 * @returns {boolean}
 */
function artifactSetHasAny(artifacts: Set<string>, aliases: string[]): boolean {
  return aliases.some((alias) => artifacts.has(alias));
}

/**
 * Resolves common aliases used by scenario artifact contracts.
 *
 * @param {DiagnosticKind} kind
 * @returns {string[]}
 */
function diagnosticArtifactAliases(kind: DiagnosticKind): string[] {
  const aliases: Record<DiagnosticKind, string[]> = {
    accessibility: ['accessibility'],
    js: ['js', 'profileEvents', 'profileSession'],
    logs: ['logs', 'deviceLog', 'interactionLog'],
    memory: ['memory'],
    nativePerformance: ['nativePerformance', 'native-performance', 'nativePerf', 'perfetto', 'gfxinfo', 'framestats', 'meminfo'],
    network: ['network'],
    profiler: ['profiler', 'profile'],
    screenshot: ['screenshot', 'screenshots'],
    uiTree: ['uiTree', 'ui-tree', 'accessibilityTree'],
    video: ['video', 'recording'],
  };

  return aliases[kind];
}

/**
 * Resolves common aliases used by runner capability declarations.
 *
 * @param {DiagnosticKind} kind
 * @returns {string[]}
 */
function diagnosticCapabilityAliases(kind: DiagnosticKind): string[] {
  const aliases: Record<DiagnosticKind, string[]> = {
    accessibility: ['accessibility', 'accessibilityCapture'],
    js: ['js', 'profileSession', 'profileEvents'],
    logs: ['logCapture', 'logs', 'deviceLog'],
    memory: ['memory', 'memoryCapture'],
    nativePerformance: ['nativePerformance', 'native-performance', 'nativePerf', 'nativePerformanceCapture', 'perfetto', 'gfxinfo', 'framestats', 'meminfo'],
    network: ['network', 'networkCapture'],
    profiler: ['profiler', 'profile', 'profilerCapture'],
    screenshot: ['screenshot', 'screenshots'],
    uiTree: ['uiTree', 'ui-tree', 'accessibilityTree'],
    video: ['video', 'recording'],
  };

  return aliases[kind];
}

/**
 * Returns requirement/request metadata for one diagnostic kind.
 *
 * @param {{kind: DiagnosticKind, optionalArtifacts: Set<string>, optionalCapabilities: Set<string>, requiredArtifacts: Set<string>, requiredCapabilities: Set<string>}} options
 * @returns {{required: boolean, requested: boolean}}
 */
function resolveDiagnosticRequest({
  kind,
  optionalArtifacts,
  optionalCapabilities,
  requiredArtifacts,
  requiredCapabilities,
}: {
  kind: DiagnosticKind;
  optionalArtifacts: Set<string>;
  optionalCapabilities: Set<string>;
  requiredArtifacts: Set<string>;
  requiredCapabilities: Set<string>;
}): { required: boolean; requested: boolean } {
  const artifactAliases = diagnosticArtifactAliases(kind);
  const capabilityAliases = diagnosticCapabilityAliases(kind);
  const required = artifactSetHasAny(requiredArtifacts, artifactAliases) ||
    artifactSetHasAny(requiredCapabilities, capabilityAliases);
  return {
    required,
    requested: required ||
      artifactSetHasAny(optionalArtifacts, artifactAliases) ||
      artifactSetHasAny(optionalCapabilities, capabilityAliases),
  };
}

/**
 * Builds a status entry for one diagnostic surface.
 *
 * @param {DiagnosticInventoryEntry & {requested?: boolean}} entry
 * @returns {DiagnosticInventoryEntry}
 */
function buildDiagnosticEntry(
  entry: DiagnosticInventoryEntry & { requested?: boolean },
): DiagnosticInventoryEntry {
  const { requested = true, ...diagnostic } = entry;
  if (diagnostic.status === 'captured' || requested || diagnostic.required) {
    return diagnostic;
  }

  return {
    ...diagnostic,
    status: 'not_requested',
    reason: diagnostic.reason ?? 'Scenario did not request this optional diagnostic surface.',
  };
}

/**
 * Builds the product-neutral diagnostic inventory for a profile run.
 *
 * @param {{args: CliArgs, attachedEvidence: AttachedEvidence, eventLogPath: string | null, platform: ProfilePlatform, profileSessionEntriesPath: string | null, providerOutputStatuses?: ProviderOutputStatus[], runDir: string, scenario: Record<string, unknown>}} options
 * @returns {DiagnosticInventoryEntry[]}
 */
function buildDiagnosticInventory({
  args,
  attachedEvidence,
  eventLogPath,
  platform,
  profileSessionEntriesPath,
  providerOutputStatuses = [],
  runDir,
  scenario,
}: {
  args: CliArgs;
  attachedEvidence: AttachedEvidence;
  eventLogPath: string | null;
  platform: ProfilePlatform;
  profileSessionEntriesPath: string | null;
  providerOutputStatuses?: ProviderOutputStatus[];
  runDir: string;
  scenario: Record<string, any>;
}): DiagnosticInventoryEntry[] {
  const requiredArtifacts = readScenarioStringSet(scenario, ['artifacts', 'required']);
  const optionalArtifacts = readScenarioStringSet(scenario, ['artifacts', 'optional']);
  const requiredCapabilities = readScenarioStringSet(scenario, ['requiredCapabilities']);
  const optionalCapabilities = readScenarioStringSet(scenario, ['optionalCapabilities']);
  const requiredProviderDiagnostics = new Set(
    [
      ...attachedEvidence.attachments
        .filter((attachment) => attachment.required)
        .map((attachment) => attachment.kind),
      ...providerOutputStatuses
        .filter((output) => output.required)
        .map((output) => output.kind),
    ],
  );
  const missingProviderOutputByKind = new Map<DiagnosticKind, ProviderOutputStatus>();
  for (const output of providerOutputStatuses) {
    if (output.status !== 'missing' || !output.required) {
      continue;
    }
    if (!missingProviderOutputByKind.has(output.kind)) {
      missingProviderOutputByKind.set(output.kind, output);
    }
  }
  const sidecarRoot = typeof args['adb-artifacts'] === 'string'
    ? path.resolve(args['adb-artifacts'])
    : typeof args['simctl-artifacts'] === 'string'
      ? path.resolve(args['simctl-artifacts'])
      : null;
  const sidecarRootRef = sidecarRoot ? toRunPathReference({ runDir, targetPath: sidecarRoot }) : undefined;
  const adbScreenshotDependency = platform === 'android'
    ? resolveAndroidAdbScreenshotDependency({ runDir, sidecarRoot })
    : null;
  const eventLogBaseName = eventLogPath ? path.basename(eventLogPath) : undefined;
  const eventLogManifestPath = eventLogBaseName ? `raw/${eventLogBaseName}` : undefined;
  const eventLogIsIosProfileEvents = platform === 'ios' && eventLogBaseName === 'ios-profile-events.log';
  const simctlRuntimeLogPath = typeof args['simctl-artifacts'] === 'string'
    ? path.resolve(args['simctl-artifacts'], 'raw', 'ios-simctl-log.txt')
    : null;
  const simctlRuntimeLogExists = Boolean(simctlRuntimeLogPath && fs.existsSync(simctlRuntimeLogPath));
  const simctlRuntimeLogDependency = simctlRuntimeLogPath && simctlRuntimeLogExists
    ? toSidecarEvidenceDependency({ runDir, sidecarRoot: path.resolve(args['simctl-artifacts'] as string), targetPath: simctlRuntimeLogPath })
    : undefined;
  const copiedSimctlLogManifestPath = platform === 'ios' && eventLogPath && path.basename(eventLogPath) === 'ios-simctl-log.txt'
    ? eventLogManifestPath
    : undefined;
  const explicitIosRuntimeLogManifestPath = platform === 'ios' &&
    typeof args.events === 'string' &&
    eventLogManifestPath &&
    !eventLogIsIosProfileEvents
    ? eventLogManifestPath
    : undefined;
  const eventLogDependency = eventLogPath && sidecarRoot
    ? toSidecarEvidenceDependency({ runDir, sidecarRoot, targetPath: eventLogPath })
    : undefined;
  const jsProfilePath = attachedEvidence.signals.js[0] ?? eventLogManifestPath;
  const profileSessionEntriesManifestPath = profileSessionEntriesPath
    ? `raw/${path.basename(profileSessionEntriesPath)}`
    : undefined;
  const entries: DiagnosticInventoryEntry[] = [];
  const pushDiagnostic = (
    kind: DiagnosticKind,
    entry: Omit<DiagnosticInventoryEntry, 'kind' | 'required'> & { required?: boolean; requested?: boolean },
  ) => {
    const request = resolveDiagnosticRequest({
      kind,
      optionalArtifacts,
      optionalCapabilities,
      requiredArtifacts,
      requiredCapabilities,
    });
    entries.push(buildDiagnosticEntry({
      kind,
      ...entry,
      required: request.required || requiredProviderDiagnostics.has(kind) || Boolean(entry.required),
      requested: request.requested || requiredProviderDiagnostics.has(kind) || Boolean(entry.requested),
    }));
  };

  const logCaptured = platform === 'ios'
    ? Boolean(copiedSimctlLogManifestPath || simctlRuntimeLogDependency || explicitIosRuntimeLogManifestPath)
    : Boolean(eventLogManifestPath);
  pushDiagnostic('logs', {
    name: platform === 'ios' ? 'simulator-runtime-log' : 'device-log',
    ...(typeof args['adb-artifacts'] === 'string'
      ? { provider: 'adb', runnerId: 'android-adb' }
      : typeof args['simctl-artifacts'] === 'string'
        ? { provider: 'simctl', runnerId: 'ios-simctl' }
        : typeof args.events === 'string'
          ? { provider: 'fixture-log-ingest' }
          : {}),
    status: logCaptured ? 'captured' : 'unavailable',
    ...(platform === 'ios'
      ? copiedSimctlLogManifestPath
        ? { path: copiedSimctlLogManifestPath }
        : simctlRuntimeLogDependency
          ? { path: simctlRuntimeLogDependency.path }
          : explicitIosRuntimeLogManifestPath
            ? { path: explicitIosRuntimeLogManifestPath }
            : {}
      : eventLogManifestPath
        ? { path: eventLogManifestPath }
        : {}),
    ...(sidecarRootRef ? { sidecarRoot: sidecarRootRef } : {}),
    ...(platform === 'ios'
      ? simctlRuntimeLogDependency
        ? { evidenceDependency: simctlRuntimeLogDependency }
        : {}
      : eventLogDependency
        ? { evidenceDependency: eventLogDependency }
        : {}),
    ...(logCaptured
      ? {
          reason: platform === 'ios'
            ? 'iOS simulator runtime log evidence was available from the simctl capture sidecar.'
            : 'Device or fixture log evidence was available to the profile runner.',
        }
      : {
          reason: platform === 'ios'
            ? 'No iOS simulator runtime log was available in the selected simctl capture sidecar.'
            : 'No device log source was supplied to this profile run.',
          nextAction: platform === 'ios'
            ? 'Run with --simctl-capture or provide --simctl-artifacts containing raw/ios-simctl-log.txt.'
            : 'Run with --events, --adb-artifacts, --adb-capture, or provide a runtime log artifact.',
        }),
  });
  pushDiagnostic('js', {
    name: 'profile-session-evidence',
    status: eventLogManifestPath || attachedEvidence.signals.js.length > 0 ? 'captured' : 'unavailable',
    ...(jsProfilePath ? { path: jsProfilePath } : {}),
    ...(profileSessionEntriesManifestPath
      ? {
          evidenceDependency: {
            kind: 'profile-session-entries',
            path: profileSessionEntriesManifestPath,
          },
        }
      : eventLogDependency
        ? { evidenceDependency: eventLogDependency }
        : {}),
    ...(sidecarRootRef ? { sidecarRoot: sidecarRootRef } : {}),
    ...(eventLogManifestPath || attachedEvidence.signals.js.length > 0
      ? { reason: 'Profile or JS evidence was captured from runner input.' }
      : {
          reason: 'No profile-session event log or JS signal attachment was available.',
          nextAction: 'Attach JS evidence with --signal js:<path> or run a profile-session capture that emits profile events.',
        }),
  });
  const attachedScreenshotPath = attachedEvidence.captures.screenshots[0];
  const sidecarScreenshotDependency = attachedScreenshotPath ? null : adbScreenshotDependency;
  pushDiagnostic('screenshot', {
    ...(sidecarScreenshotDependency ? { provider: 'adb', runnerId: 'android-adb' } : {}),
    status: attachedScreenshotPath || sidecarScreenshotDependency ? 'captured' : 'unavailable',
    ...(attachedScreenshotPath
      ? { path: attachedScreenshotPath }
      : sidecarScreenshotDependency
        ? { path: sidecarScreenshotDependency.path }
        : {}),
    ...(sidecarScreenshotDependency && sidecarRootRef ? { sidecarRoot: sidecarRootRef } : {}),
    ...(sidecarScreenshotDependency ? { evidenceDependency: sidecarScreenshotDependency.dependency } : {}),
    ...(attachedScreenshotPath || sidecarScreenshotDependency
      ? {
          reason: sidecarScreenshotDependency
            ? 'Screenshot evidence was available from the adb capture sidecar.'
            : 'Screenshot capture was attached to the run.',
        }
      : {
          reason: 'No screenshot capture was produced by the selected runner/provider set.',
          nextAction: 'Use --capture screenshot:<path> or a runner/provider that produces screenshots.',
        }),
  });
  const missingUiTreeProviderOutput = missingProviderOutputByKind.get('uiTree');
  pushDiagnostic('uiTree', {
    ...(missingUiTreeProviderOutput ? { provider: missingUiTreeProviderOutput.providerId } : {}),
    status: attachedEvidence.captures.uiTree ? 'captured' : missingUiTreeProviderOutput ? 'failed' : 'unavailable',
    ...(attachedEvidence.captures.uiTree ? { path: attachedEvidence.captures.uiTree } : {}),
    ...(attachedEvidence.captures.uiTree
      ? { reason: 'UI tree capture was attached to the run.' }
      : missingUiTreeProviderOutput
        ? {
            reason: missingUiTreeProviderOutput.reason ?? 'Required UI tree provider output was not produced.',
            nextAction: 'Inspect the provider command record and fix the UI tree capture path before treating this diagnostic as complete.',
          }
      : {
          reason: 'No UI tree capture was produced by the selected runner/provider set.',
          nextAction: 'Use --capture uiTree:<path> or add an accessibility/UI-tree provider.',
        }),
  });
  const missingVideoProviderOutput = missingProviderOutputByKind.get('video');
  pushDiagnostic('video', {
    ...(missingVideoProviderOutput ? { provider: missingVideoProviderOutput.providerId } : {}),
    status: attachedEvidence.captures.video ? 'captured' : missingVideoProviderOutput ? 'failed' : 'unavailable',
    ...(attachedEvidence.captures.video ? { path: attachedEvidence.captures.video } : {}),
    ...(attachedEvidence.captures.video
      ? { reason: 'Video capture was attached to the run.' }
      : missingVideoProviderOutput
        ? {
            reason: missingVideoProviderOutput.reason ?? 'Required video provider output was not produced.',
            nextAction: 'Inspect the provider command record and fix the video capture path before treating this diagnostic as complete.',
          }
      : {
          reason: 'No video capture was produced by the selected runner/provider set.',
          nextAction: 'Use --capture video:<path> or run a capture provider that records video.',
        }),
  });
  for (const kind of ['memory', 'network'] as const) {
    const missingProviderOutput = missingProviderOutputByKind.get(kind);
    pushDiagnostic(kind, {
      ...(missingProviderOutput ? { provider: missingProviderOutput.providerId } : {}),
      status: attachedEvidence.signals[kind].length > 0 ? 'captured' : missingProviderOutput ? 'failed' : 'unavailable',
      ...(attachedEvidence.signals[kind][0] ? { path: attachedEvidence.signals[kind][0] } : {}),
      ...(attachedEvidence.signals[kind].length > 0
        ? { reason: `${kind} signal evidence was attached to the run.` }
        : missingProviderOutput
          ? {
              reason: missingProviderOutput.reason ?? `Required ${kind} provider output was not produced.`,
              nextAction: `Inspect the provider command record and fix ${kind} capture before treating this diagnostic as complete.`,
            }
        : {
            reason: `No ${kind} signal evidence was produced by the selected provider set.`,
            nextAction: `Attach ${kind} evidence with --signal ${kind}:<path> or add a provider command that emits it.`,
          }),
    });
  }
  for (const kind of ['accessibility', 'nativePerformance', 'profiler'] as const) {
    const attachment = attachedEvidence.attachments.find((item) => item.kind === kind);
    const missingProviderOutput = missingProviderOutputByKind.get(kind);
    pushDiagnostic(kind, {
      ...(attachment?.providerId ? { provider: attachment.providerId } : missingProviderOutput ? { provider: missingProviderOutput.providerId } : {}),
      status: attachment ? 'captured' : missingProviderOutput ? 'failed' : 'unavailable',
      ...(attachment ? { path: attachment.manifestPath } : {}),
      ...(attachment
        ? { reason: `${kind} provider evidence was attached to the run.` }
        : missingProviderOutput
          ? {
              reason: missingProviderOutput.reason ?? `Required ${kind} provider output was not produced.`,
              nextAction: `Inspect the provider command record and fix ${kind} capture before treating this diagnostic as complete.`,
            }
        : {
            reason: `No ${kind} provider attachment was produced by the selected provider set.`,
            nextAction: `Declare a provider command or attach ${kind} evidence before expecting this diagnostic.`,
          }),
    });
  }

  return entries.map((entry) => {
    const cleaned = Object.entries(entry).filter(([, value]) => value !== undefined);
    return Object.fromEntries(cleaned) as DiagnosticInventoryEntry;
  });
}

/**
 * Converts uncaptured required diagnostics into health checks.
 *
 * @param {DiagnosticInventoryEntry[]} diagnostics
 * @returns {Record<string, unknown>[]}
 */
function buildRequiredDiagnosticHealthChecks(diagnostics: DiagnosticInventoryEntry[] = []): Record<string, unknown>[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.required && diagnostic.status !== 'captured')
    .map((diagnostic) => ({
      name: `required_${diagnostic.kind}_diagnostic`,
      status: 'failed',
      source: 'evidence',
      code: 'required_diagnostic_not_captured',
      message: diagnostic.reason ?? `Required ${diagnostic.kind} diagnostic was not captured.`,
      metadata: {
        kind: diagnostic.kind,
        status: diagnostic.status,
        ...(diagnostic.name ? { name: diagnostic.name } : {}),
        ...(diagnostic.nextAction ? { nextAction: diagnostic.nextAction } : {}),
        ...(diagnostic.provider ? { provider: diagnostic.provider } : {}),
        ...(diagnostic.runnerId ? { runnerId: diagnostic.runnerId } : {}),
      },
    }));
}

/**
 * Reports provider-backed diagnostics that survived a provider command failure.
 *
 * @param {DiagnosticInventoryEntry[]} diagnostics
 * @param {ProviderCommandFailure[]} failures
 * @returns {Record<string, unknown>[]}
 */
function buildPartialProviderEvidenceHealthChecks(
  diagnostics: DiagnosticInventoryEntry[] = [],
  failures: ProviderCommandFailure[] = [],
): Record<string, unknown>[] {
  if (failures.length === 0) {
    return [];
  }

  const capturedProviderDiagnostics = diagnostics.filter((diagnostic) => (
    diagnostic.status === 'captured' &&
    typeof diagnostic.provider === 'string' &&
    diagnostic.provider.length > 0
  ));
  if (capturedProviderDiagnostics.length === 0) {
    return [];
  }

  const capturedKinds = uniqueStrings(capturedProviderDiagnostics.map((diagnostic) => diagnostic.kind));
  const capturedPaths = uniqueStrings(capturedProviderDiagnostics.map((diagnostic) => readTrimmedString(diagnostic.path)));
  return [
    {
      name: 'partial_provider_evidence_preserved',
      status: 'warning',
      source: 'evidence',
      code: 'partial_provider_evidence_preserved',
      message: 'Provider command health failed, but some provider-backed diagnostics were preserved for diagnosis.',
      metadata: {
        capturedKinds: capturedKinds.join(','),
        capturedPaths: capturedPaths.join(','),
        nextAction: 'Use preserved diagnostics for investigation only; rerun or fix missing required provider outputs before making product claims.',
        nextActionCode: 'use_partial_provider_evidence_for_diagnosis',
      },
    },
  ];
}

/**
 * Converts evidence-provider command failures into health checks.
 *
 * @param {ProviderCommandFailure[]} failures
 * @returns {Record<string, unknown>[]}
 */
function buildProviderCommandFailureChecks(failures: ProviderCommandFailure[] = []): Record<string, unknown>[] {
  return failures.map((failure) => ({
    name: failure.name ?? 'evidence_provider_command_completed',
    status: 'failed',
    source: 'evidence',
    code: failure.code ?? 'provider_command_failed',
    message: failure.message ?? `Evidence provider command ${failure.providerId}/${failure.commandId} failed with exit code ${failure.exitCode}.`,
    metadata: {
      commandId: failure.commandId,
      exitCode: failure.exitCode,
      nextAction: failure.nextAction ?? `Inspect ${failure.rawPath}, fix the provider command or its environment, then rerun the profile.`,
      nextActionCode: failure.nextActionCode ?? 'fix_provider_command',
      phase: failure.phase,
      providerId: failure.providerId,
      ...(failure.rawPath ? { rawPath: failure.rawPath } : {}),
    },
  }));
}

/**
 * Resolves the health status for a runtime identity check.
 *
 * @param {RuntimeIdentityVerification['status']} status
 * @returns {'failed' | 'passed' | 'warning'}
 */
function resolveRuntimeIdentityHealthStatus(status: RuntimeIdentityVerification['status']): 'failed' | 'passed' | 'warning' {
  if (status === 'mismatched') {
    return 'failed';
  }
  if (status === 'verified') {
    return 'passed';
  }
  return 'warning';
}

/**
 * Resolves the health code for a runtime identity check.
 *
 * @param {RuntimeIdentityVerification['status']} status
 * @returns {string}
 */
function resolveRuntimeIdentityHealthCode(status: RuntimeIdentityVerification['status']): string {
  if (status === 'mismatched') {
    return 'runtime_identity_mismatch';
  }
  if (status === 'verified') {
    return 'runtime_identity_verified';
  }
  return 'runtime_identity_unverified';
}

/**
 * Converts sidecar runtime identity verification into a scenario health check.
 *
 * @param {RuntimeIdentityVerification | null} runtimeIdentity
 * @returns {Record<string, unknown>[]}
 */
function buildRuntimeIdentityHealthChecks(runtimeIdentity: RuntimeIdentityVerification | null = null): Record<string, unknown>[] {
  if (!runtimeIdentity) {
    return [];
  }

  return [
    {
      name: 'runtime_identity',
      status: resolveRuntimeIdentityHealthStatus(runtimeIdentity.status),
      source: 'runner',
      code: resolveRuntimeIdentityHealthCode(runtimeIdentity.status),
      message: runtimeIdentity.reason,
      metadata: {
        platform: runtimeIdentity.platform,
        identityStatus: runtimeIdentity.status,
        sidecarMetadataPath: runtimeIdentity.sidecarMetadataPath,
        nextAction: runtimeIdentity.nextAction,
        nextActionCode: runtimeIdentity.nextActionCode,
        ...(runtimeIdentity.expectedAppId ? { expectedAppId: runtimeIdentity.expectedAppId } : {}),
        ...(runtimeIdentity.expectedAppIdSource ? { expectedAppIdSource: runtimeIdentity.expectedAppIdSource } : {}),
        ...(runtimeIdentity.observedAppId ? { observedAppId: runtimeIdentity.observedAppId } : {}),
        ...(runtimeIdentity.expectedTargetId ? { expectedTargetId: runtimeIdentity.expectedTargetId } : {}),
        ...(runtimeIdentity.expectedTargetIdSource ? { expectedTargetIdSource: runtimeIdentity.expectedTargetIdSource } : {}),
        ...(runtimeIdentity.observedTargetId ? { observedTargetId: runtimeIdentity.observedTargetId } : {}),
      },
    },
  ];
}

/**
 * Resolves the health status for an app helper version check.
 *
 * @param {ProfileHelperVersionCheck['status']} status
 * @returns {'failed' | 'passed' | 'warning'}
 */
function profileHelperVersionHealthStatus(status: ProfileHelperVersionCheck['status']): 'failed' | 'passed' | 'warning' {
  switch (status) {
    case 'matched':
      return 'passed';
    case 'missing':
      return 'warning';
    case 'mismatched':
      return 'failed';
  }
}

/**
 * Resolves the health code for an app helper version check.
 *
 * @param {ProfileHelperVersionCheck['status']} status
 * @returns {string}
 */
function profileHelperVersionHealthCode(status: ProfileHelperVersionCheck['status']): string {
  switch (status) {
    case 'matched':
      return 'profile_session_helper_version_matched';
    case 'missing':
      return 'profile_session_helper_version_missing';
    case 'mismatched':
      return 'profile_session_helper_version_mismatch';
  }
}

/**
 * Resolves the next action for an app helper version check.
 *
 * @param {ProfileHelperVersionCheck['status']} status
 * @returns {{nextAction: string, nextActionCode: string}}
 */
function profileHelperVersionNextAction(status: ProfileHelperVersionCheck['status']): {
  nextAction: string;
  nextActionCode: string;
} {
  switch (status) {
    case 'matched':
      return {
        nextAction: 'No action required.',
        nextActionCode: 'none',
      };
    case 'missing':
      return {
        nextAction: 'Use an app-side profile-session helper that emits helperVersion in session entries and profile events so ASL can verify helper/package compatibility.',
        nextActionCode: 'emit_profile_session_helper_version',
      };
    case 'mismatched':
      return {
        nextAction: 'Update the app-side profile-session helper to the package version used by the runner, then rerun before trusting timing evidence.',
        nextActionCode: 'update_profile_session_helper',
      };
  }
}

/**
 * Converts app helper version evidence into a scenario health check.
 *
 * @param {ProfileHelperVersionCheck | null} helperVersion
 * @returns {Record<string, unknown>[]}
 */
function buildProfileHelperVersionHealthChecks(helperVersion: ProfileHelperVersionCheck | null = null): Record<string, unknown>[] {
  if (!helperVersion) {
    return [];
  }

  const healthStatus = profileHelperVersionHealthStatus(helperVersion.status);
  const healthCode = profileHelperVersionHealthCode(helperVersion.status);
  const nextAction = profileHelperVersionNextAction(helperVersion.status);

  return [
    {
      name: 'profile_session_helper_version',
      status: healthStatus,
      source: 'runner',
      code: healthCode,
      message: helperVersion.reason,
      metadata: {
        expectedVersion: helperVersion.expectedVersion,
        observedVersions: helperVersion.observedVersions.join(','),
        observedVersionCount: helperVersion.observedVersions.length,
        nextAction: nextAction.nextAction,
        nextActionCode: nextAction.nextActionCode,
      },
    },
  ];
}

/**
 * Builds scenario health from profile metrics.
 *
 * @param {{scenario: Record<string, unknown>, runId: string, metrics: Record<string, unknown>, diagnostics?: DiagnosticInventoryEntry[], providerFailures?: ProviderCommandFailure[], profileEventCount?: number, profileSessionEntryCount?: number, commandTransport?: string, helperVersion?: ProfileHelperVersionCheck | null, runtimeIdentity?: RuntimeIdentityVerification | null, sessionEntries?: Record<string, unknown>[], sessionFreshness?: ProfileSessionFreshness | null, sessionFreshnessRequired?: boolean}} options
 * @returns {Record<string, unknown>}
 */
function buildProfileHealth({
  scenario,
  runId,
  metrics,
  diagnostics = [],
  providerFailures = [],
  profileEventCount,
  profileSessionEntryCount,
  commandTransport,
  evidenceIdentityFailure = null,
  helperVersion = null,
  runtimeIdentity = null,
  sessionEntries = [],
  sessionFreshness = null,
  sessionFreshnessRequired = false,
}: {
  scenario: Record<string, any>;
  runId: string;
  metrics: Record<string, any>;
  diagnostics?: DiagnosticInventoryEntry[];
  providerFailures?: ProviderCommandFailure[];
  profileEventCount?: number;
  profileSessionEntryCount?: number;
  commandTransport?: string;
  evidenceIdentityFailure?: EvidenceIdentityFailure | null;
  helperVersion?: ProfileHelperVersionCheck | null;
  runtimeIdentity?: RuntimeIdentityVerification | null;
  sessionEntries?: Record<string, any>[];
  sessionFreshness?: ProfileSessionFreshness | null;
  sessionFreshnessRequired?: boolean;
}): Record<string, unknown> {
  const passed = metrics.status === 'passed';
  const metadata: Record<string, string | number | boolean | null> = {
    failures: typeof metrics.failures === 'number' ? metrics.failures : null,
    timeouts: typeof metrics.timeouts === 'number' ? metrics.timeouts : null,
  };
  if (typeof profileEventCount === 'number') {
    metadata.profileEventCount = profileEventCount;
  }
  if (typeof profileSessionEntryCount === 'number') {
    metadata.profileSessionEntryCount = profileSessionEntryCount;
  }
  if (typeof commandTransport === 'string' && commandTransport.length > 0) {
    metadata.commandTransport = commandTransport;
  }
  if (
    !passed &&
    profileEventCount === 0 &&
    profileSessionEntryCount === 0 &&
    typeof commandTransport === 'string' &&
    commandTransport.startsWith('profile-session')
  ) {
    metadata.nextActionCode = 'verify_profile_session_bootstrap';
    metadata.nextAction =
      'Verify the app loaded the expected bundle, mounted the profile-session bootstrap near the app root, and uses the configured storage keys or deep-link scheme before treating this as a product failure.';
  }
  const skippedCommands = sessionEntries.filter((entry) => (
    entry?.kind === 'command' && entry.status === 'skipped'
  ));
  const firstSkippedCommand = skippedCommands[0] as Record<string, any> | undefined;
  const firstSkippedReason = typeof firstSkippedCommand?.reason === 'string'
    ? firstSkippedCommand.reason
    : undefined;
  const commandFailureCode = firstSkippedReason === 'wait-for-milestone-timeout'
    ? 'profile_command_gate_timeout'
    : 'profile_command_skipped';
  const commandFailureMessage = firstSkippedReason === 'wait-for-milestone-timeout'
    ? 'One or more profile-session commands waited for a milestone that was not observed before timeout.'
    : 'One or more profile-session commands were skipped before the scenario completed.';
  const commandChecks = skippedCommands.length > 0
    ? [
        {
          name: 'profile_command_sequence',
          status: 'failed',
          source: 'runner',
          code: commandFailureCode,
          message: commandFailureMessage,
          metadata: {
            skippedCommandCount: skippedCommands.length,
            ...(typeof firstSkippedCommand?.command === 'string' ? { command: firstSkippedCommand.command } : {}),
            ...(typeof firstSkippedCommand?.commandId === 'string' ? { commandId: firstSkippedCommand.commandId } : {}),
            ...(typeof firstSkippedCommand?.queueId === 'string' ? { queueId: firstSkippedCommand.queueId } : {}),
            ...(typeof firstSkippedCommand?.reason === 'string' ? { reason: firstSkippedCommand.reason } : {}),
            ...(typeof firstSkippedCommand?.sequence === 'number' ? { sequence: firstSkippedCommand.sequence } : {}),
            ...(typeof firstSkippedCommand?.waitForMilestone === 'string'
              ? { waitForMilestone: firstSkippedCommand.waitForMilestone }
              : {}),
            ...(typeof firstSkippedCommand?.waitTimeoutMs === 'number'
              ? { waitTimeoutMs: firstSkippedCommand.waitTimeoutMs }
              : {}),
          },
        },
      ]
    : [];
  const commandChecksPassed = commandChecks.every((check) => check.status === 'passed');
  const diagnosticChecks = buildRequiredDiagnosticHealthChecks(diagnostics);
  const diagnosticChecksPassed = diagnosticChecks.every((check) => check.status === 'passed');
  const evidenceIdentityChecks = evidenceIdentityFailure
    ? [
        {
          name: 'profile_session_identity',
          status: 'failed',
          source: 'runner',
          code: evidenceIdentityFailure.code,
          message: evidenceIdentityFailure.message,
          metadata: {
            nextAction: 'Select a sidecar with exactly one source run id for this scenario, or rerun the live capture with a fresh run id.',
            nextActionCode: 'rerun_with_unambiguous_profile_session',
            requestedRunId: evidenceIdentityFailure.requestedRunId,
            sourceRunIds: evidenceIdentityFailure.sourceRunIds.join(','),
          },
        },
      ]
    : [];
  const evidenceIdentityChecksPassed = evidenceIdentityChecks.every((check) => check.status !== 'failed');
  const providerFailureChecks = buildProviderCommandFailureChecks(providerFailures);
  const providerFailureChecksPassed = providerFailureChecks.every((check) => check.status === 'passed');
  const partialProviderEvidenceChecks = buildPartialProviderEvidenceHealthChecks(diagnostics, providerFailures);
  const helperVersionChecks = buildProfileHelperVersionHealthChecks(helperVersion);
  const helperVersionChecksPassed = helperVersionChecks.every((check) => check.status !== 'failed');
  const runtimeIdentityChecks = buildRuntimeIdentityHealthChecks(runtimeIdentity);
  const runtimeIdentityChecksPassed = runtimeIdentityChecks.every((check) => check.status !== 'failed');
  const sessionFreshnessChecks = sessionFreshness
    ? [
        {
          name: 'profile_session_freshness',
          status: sessionFreshness.status === 'fresh'
            ? 'passed'
            : sessionFreshness.status === 'missing-app-session' && !sessionFreshnessRequired
              ? 'warning'
              : 'failed',
          source: 'runner',
          code: sessionFreshness.status === 'fresh'
            ? 'profile_session_fresh'
            : sessionFreshness.status === 'missing-app-session'
              ? 'profile_session_start_missing'
              : 'profile_session_stale',
          message: sessionFreshness.status === 'fresh'
            ? 'App-side profile-session start matched the runner-written session seed.'
            : sessionFreshness.reason ?? 'App-side profile-session evidence did not match the runner-written session seed.',
          metadata: {
            appStartedAt: sessionFreshness.appStartedAt ?? null,
            nextAction: sessionFreshness.status === 'fresh'
              ? 'No action required.'
              : 'Clear stale app/session state, reload the expected app bundle, and rerun before treating profile events or metrics as product evidence.',
            nextActionCode: sessionFreshness.status === 'fresh'
              ? 'none'
              : 'rerun_with_fresh_profile_session',
            seedStartedAt: sessionFreshness.seed.startedAt,
          },
        },
      ]
    : [];
  const sessionFreshnessChecksPassed = sessionFreshnessChecks.every((check) => check.status !== 'failed');
  const healthPassed = passed &&
    commandChecksPassed &&
    diagnosticChecksPassed &&
    evidenceIdentityChecksPassed &&
    providerFailureChecksPassed &&
    helperVersionChecksPassed &&
    runtimeIdentityChecksPassed &&
    sessionFreshnessChecksPassed;

  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: scenario.name,
      ...(typeof scenario.flowId === 'string' ? { flowId: scenario.flowId } : {}),
      runId,
      healthStatus: healthPassed ? 'passed' : 'failed',
      checks: [
        {
          name: 'truth_events_complete',
          status: passed ? 'passed' : 'failed',
          source: 'truth',
          code: passed ? 'truth_events_complete' : 'truth_events_incomplete',
          message: passed
            ? 'Profile events completed every expected iteration.'
            : 'Profile events did not complete every expected iteration.',
          metadata,
        },
        ...evidenceIdentityChecks,
        ...sessionFreshnessChecks,
        ...commandChecks,
        ...providerFailureChecks,
        ...partialProviderEvidenceChecks,
        ...helperVersionChecks,
        ...runtimeIdentityChecks,
        ...diagnosticChecks,
      ],
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Adds provider command failures to otherwise finalized profile health.
 *
 * @param {{failures: ProviderCommandFailure[], health: Record<string, unknown>, runId: string, scenario: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function appendProviderCommandFailuresToHealth({
  failures,
  health,
  runId,
  scenario,
}: {
  failures: ProviderCommandFailure[];
  health: Record<string, any>;
  runId: string;
  scenario: Record<string, any>;
}): Record<string, unknown> {
  if (failures.length === 0) {
    return health;
  }

  const providerHealth = buildProviderCommandFailureHealth({ failures, runId, scenario });
  const existingChecks = Array.isArray(health.checks) ? health.checks : [];
  const providerChecks = Array.isArray(providerHealth.checks) ? providerHealth.checks : [];
  return assertValidJson(
    {
      ...health,
      healthStatus: 'failed',
      checks: [
        ...existingChecks,
        ...providerChecks,
      ],
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Derives the terminal state for one profile artifact attempt.
 *
 * @param {Record<string, unknown>} metrics
 * @returns {string}
 */
function buildAttemptTerminalState(metrics: Record<string, any>): string {
  if (metrics.status === 'passed') {
    return 'passed';
  }

  if (typeof metrics.timeouts === 'number' && metrics.timeouts > 0) {
    return 'timeout';
  }

  return 'failed';
}

/**
 * Classifies one profile artifact attempt without product-specific vocabulary.
 *
 * @param {Record<string, unknown>} metrics
 * @returns {Record<string, unknown>}
 */
function buildAttemptClassification(metrics: Record<string, any>): Record<string, unknown> {
  if (metrics.status === 'passed') {
    return {
      category: 'none',
    };
  }

  if (typeof metrics.timeouts === 'number' && metrics.timeouts > 0) {
    return {
      category: 'timeout',
      code: 'profile_truth_event_timeout',
      message: `Profile run recorded ${metrics.timeouts} timeout(s) before all expected truth events completed.`,
      retryable: true,
    };
  }

  return {
    category: 'evidence',
    code: 'profile_truth_events_incomplete',
    message: 'Profile run did not capture every expected truth event.',
    retryable: true,
  };
}

/**
 * Records whether the written artifact set is valid for diagnosis when a run fails.
 *
 * @param {{artifacts: Record<string, unknown>, metrics: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildAttemptPartialArtifacts({
  artifacts,
  metrics,
}: {
  artifacts: Record<string, any>;
  metrics: Record<string, any>;
}): Record<string, unknown> {
  if (metrics.status === 'passed') {
    return {
      valid: false,
      reason: 'complete successful run artifacts are present',
    };
  }

  const paths = [
    artifacts.manifest,
    'health.json',
    artifacts.metrics,
    artifacts.causalRun,
    artifacts.summary,
    artifacts.raw?.interactionLog,
    artifacts.raw?.deviceLog,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);

  return {
    valid: true,
    reason: 'failed profile run artifacts are preserved for diagnosis and are not a product proof until scenario health passes',
    paths,
  };
}

/**
 * Builds failed scenario health from evidence-provider command failures.
 *
 * @param {{failures: ProviderCommandFailure[], runId: string, scenario: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildProviderCommandFailureHealth({
  failures,
  runId,
  scenario,
}: {
  failures: ProviderCommandFailure[];
  runId: string;
  scenario: Record<string, any>;
}): Record<string, unknown> {
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: scenario.name,
      ...(typeof scenario.flowId === 'string' ? { flowId: scenario.flowId } : {}),
      runId,
      healthStatus: 'failed',
      checks: buildProviderCommandFailureChecks(failures),
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
}

/**
 * Converts profile budget evaluation checks into verdict budget checks.
 *
 * @param {Record<string, unknown> | null | undefined} budgetEvaluation
 * @returns {Record<string, unknown>[]}
 */
function buildVerdictBudgetChecks(budgetEvaluation: Record<string, any> | null | undefined): Record<string, unknown>[] {
  if (!Array.isArray(budgetEvaluation?.checks)) {
    return [];
  }

  return budgetEvaluation.checks.map((check: Record<string, any>) => ({
    name: String(check.name ?? 'unknown budget'),
    source: 'milestone',
    metric: String(budgetEvaluation.metric ?? check.name ?? 'profile budget'),
    unit: check.unit === 'count' ? 'count' : 'ms',
    expected: check.limit,
    actual: check.actual ?? null,
    pass: Boolean(check.pass),
    ...(typeof check.status === 'string' ? { status: check.status } : {}),
    ...(typeof check.notes === 'string' ? { notes: check.notes } : {}),
  }));
}

/**
 * Builds product verdict from profile metrics and budget evaluation.
 *
 * @param {{scenario: Record<string, unknown>, runId: string, health: Record<string, unknown>, metrics: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildProfileVerdict({
  scenario,
  runId,
  health,
  metrics,
}: {
  scenario: Record<string, any>;
  runId: string;
  health: Record<string, any>;
  metrics: Record<string, any>;
}): Record<string, unknown> {
  const healthPassed = health.healthStatus === 'passed';
  const budgetEvaluation = metrics.budgetEvaluation;
  const budgetChecks = buildVerdictBudgetChecks(budgetEvaluation);
  const budgetStatus = typeof budgetEvaluation?.status === 'string'
    ? budgetEvaluation.status
    : budgetEvaluation
      ? budgetEvaluation.pass
        ? 'passed'
        : 'failed'
      : 'not_evaluated';
  const verdictStatus = !healthPassed
    ? 'inconclusive'
    : budgetEvaluation
      ? budgetStatus === 'passed'
        ? 'passed'
        : budgetStatus === 'partial'
          ? 'inconclusive'
          : 'failed'
      : 'not_evaluated';

  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: scenario.name,
      ...(typeof scenario.flowId === 'string' ? { flowId: scenario.flowId } : {}),
      runId,
      healthStatus: health.healthStatus,
      verdictStatus,
      ...(budgetChecks.length > 0 ? { budgetChecks } : {}),
      summary: !healthPassed
        ? 'Scenario health did not pass; do not compare or optimize from this run.'
        : budgetEvaluation
          ? budgetStatus === 'partial'
            ? 'Profile budgets were partially evaluated; unmeasurable checks are not product-performance failures.'
            : `Profile budgets ${budgetStatus === 'passed' ? 'passed' : 'failed'}.`
          : 'Scenario health passed; no profile budgets were configured.',
    },
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
}

/**
 * Resolves the configured artifact root for a platform profile run.
 *
 * @param {{args: CliArgs, config: Record<string, unknown>, configPath: string, platform: ProfilePlatform}} options
 * @returns {string}
 */
function resolveArtifactRoot({
  args,
  config,
  configPath,
  platform,
}: {
  args: CliArgs;
  config: Record<string, any>;
  configPath: string;
  platform: ProfilePlatform;
}): string {
  if (typeof args.out === 'string') {
    return path.resolve(args.out);
  }

  const platformRootKey = `${platform}ArtifactsRoot`;
  const configuredPlatformRoot = config.paths?.[platformRootKey];
  if (typeof configuredPlatformRoot === 'string') {
    return path.resolve(path.dirname(configPath), configuredPlatformRoot);
  }

  const configuredArtifactRoot = config.paths?.artifactRoot;
  if (typeof configuredArtifactRoot === 'string') {
    return path.resolve(path.dirname(configPath), configuredArtifactRoot, platform);
  }

  return path.resolve(path.dirname(configPath), 'artifacts', platform);
}

/**
 * Resolves the app identifier used in profile manifests.
 *
 * @param {{config: Record<string, unknown>, platform: ProfilePlatform}} options
 * @returns {string}
 */
function resolveAppId({ config, platform }: { config: Record<string, any>; platform: ProfilePlatform }): string {
  if (platform === 'android') {
    return typeof config.app?.androidPackage === 'string' ? config.app.androidPackage : 'com.example.app';
  }

  return typeof config.app?.iosBundleId === 'string' ? config.app.iosBundleId : 'com.example.app';
}

/**
 * Resolves the interaction driver recorded in profile artifacts.
 *
 * @param {{config: Record<string, unknown>, options: ProfileMobileOptions, scenario: Record<string, unknown>}} options
 * @returns {string}
 */
function resolveInteractionDriver({
  config,
  options,
  scenario,
}: {
  config: Record<string, any>;
  options: ProfileMobileOptions;
  scenario: Record<string, any>;
}): string {
  return options.interactionDriver || scenario.interactionDriver || config.drivers?.default || options.defaultDriver;
}

/**
 * Resolves the stable comparison lane used for historical baseline selection.
 *
 * @param {{args: CliArgs, options: ProfileMobileOptions, scenario: Record<string, unknown>}} options
 * @returns {string | undefined}
 */
function resolveComparisonLane({
  args,
  options,
  scenario,
}: {
  args: CliArgs;
  options: ProfileMobileOptions;
  scenario: Record<string, any>;
}): string | undefined {
  const cliLane = readScalarArg(args['comparison-lane']);
  if (typeof cliLane === 'string' && cliLane.trim().length > 0) {
    return cliLane.trim();
  }

  if (typeof options.comparisonLane === 'string' && options.comparisonLane.trim().length > 0) {
    return options.comparisonLane.trim();
  }

  return typeof scenario.comparisonLane === 'string' && scenario.comparisonLane.trim().length > 0
    ? scenario.comparisonLane.trim()
    : undefined;
}

/**
 * Resolves the profile event log source from explicit logs or prior adb artifacts.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform}} options
 * @returns {string | null}
 */
function resolveEventLogPath({ args, platform }: { args: CliArgs; platform: ProfilePlatform }): string | null {
  if (typeof args.events === 'string') {
    return path.resolve(args.events);
  }

  if (platform === 'android' && typeof args['adb-artifacts'] === 'string') {
    return path.resolve(args['adb-artifacts'], 'raw', 'adb-logcat.txt');
  }

  if (platform === 'ios' && typeof args['simctl-artifacts'] === 'string') {
    const storedEventLogPath = path.resolve(args['simctl-artifacts'], 'raw', 'ios-profile-events.log');
    if (fs.existsSync(storedEventLogPath)) {
      return storedEventLogPath;
    }

    return path.resolve(args['simctl-artifacts'], 'raw', 'ios-simctl-log.txt');
  }

  return null;
}

/**
 * Resolves the optional profile-session entry artifact path for command acknowledgement evidence.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform}} options
 * @returns {string | null}
 */
function resolveProfileSessionEntriesPath({ args, platform }: { args: CliArgs; platform: ProfilePlatform }): string | null {
  if (platform === 'ios' && typeof args['simctl-artifacts'] === 'string') {
    const storedEntriesPath = path.resolve(args['simctl-artifacts'], 'raw', 'ios-profile-session-entries.json');
    return fs.existsSync(storedEntriesPath) ? storedEntriesPath : null;
  }

  return null;
}

/**
 * Reads one JSON object candidate from raw command text.
 *
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
function parseJsonObjectsFromText(text: string): Record<string, unknown>[] {
  const matches = text.match(/\{[^{}\n]*\}/gu) ?? [];
  const objects: Record<string, unknown>[] = [];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Raw command files can contain shell syntax around JSON payloads.
    }
  }

  return objects;
}

/**
 * Reads an Android profile-session seed from adb AsyncStorage raw artifacts.
 *
 * @param {{sidecarRoot: string, runId: string, scenarioName: string}} options
 * @returns {ProfileSessionSeed | null}
 */
function readAndroidProfileSessionSeed({
  runId,
  scenarioName,
  sidecarRoot,
}: {
  runId: string;
  scenarioName: string;
  sidecarRoot: string;
}): ProfileSessionSeed | null {
  const rawDir = path.resolve(sidecarRoot, 'raw');
  if (!fs.existsSync(rawDir)) {
    return null;
  }

  for (const fileName of fs.readdirSync(rawDir).filter((entry: string) => /^adb-async-storage-write-\d+\.txt$/u.test(entry)).sort()) {
    const rawText = fs.readFileSync(path.join(rawDir, fileName), 'utf8');
    for (const candidate of parseJsonObjectsFromText(rawText)) {
      if (
        candidate.runId === runId &&
        candidate.scenario === scenarioName &&
        typeof candidate.startedAt === 'number' &&
        Number.isFinite(candidate.startedAt)
      ) {
        return {
          runId,
          scenario: scenarioName,
          startedAt: candidate.startedAt,
        };
      }
    }
  }

  return null;
}

/**
 * Reads an iOS profile-session seed from simctl storage artifacts.
 *
 * @param {{sidecarRoot: string, runId: string, scenarioName: string}} options
 * @returns {ProfileSessionSeed | null}
 */
function readIosProfileSessionSeed({
  runId,
  scenarioName,
  sidecarRoot,
}: {
  runId: string;
  scenarioName: string;
  sidecarRoot: string;
}): ProfileSessionSeed | null {
  const seedPath = path.resolve(sidecarRoot, 'raw', 'ios-profile-session-seed.json');
  const seed = readOptionalJsonObject(seedPath);
  const session = seed?.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    return null;
  }

  const record = session as Record<string, unknown>;
  if (
    record.runId === runId &&
    record.scenario === scenarioName &&
    typeof record.startedAt === 'number' &&
    Number.isFinite(record.startedAt)
  ) {
    return {
      runId,
      scenario: scenarioName,
      startedAt: record.startedAt,
    };
  }

  return null;
}

/**
 * Reads the profile-session seed written by a platform sidecar, when present.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform, runId: string, scenarioName: string}} options
 * @returns {ProfileSessionSeed | null}
 */
function resolveProfileSessionSeed({
  args,
  platform,
  runId,
  scenarioName,
}: {
  args: CliArgs;
  platform: ProfilePlatform;
  runId: string;
  scenarioName: string;
}): ProfileSessionSeed | null {
  if (platform === 'android' && typeof args['adb-artifacts'] === 'string') {
    return readAndroidProfileSessionSeed({
      runId,
      scenarioName,
      sidecarRoot: path.resolve(args['adb-artifacts']),
    });
  }

  if (platform === 'ios' && typeof args['simctl-artifacts'] === 'string') {
    return readIosProfileSessionSeed({
      runId,
      scenarioName,
      sidecarRoot: path.resolve(args['simctl-artifacts']),
    });
  }

  return null;
}

/**
 * Compares the sidecar-written profile session to the app-emitted session.
 *
 * @param {{seed: ProfileSessionSeed | null, sessionEntries: Record<string, unknown>[]}} options
 * @returns {ProfileSessionFreshness | null}
 */
function resolveProfileSessionFreshness({
  seed,
  sessionEntries,
}: {
  seed: ProfileSessionSeed | null;
  sessionEntries: Record<string, unknown>[];
}): ProfileSessionFreshness | null {
  if (!seed) {
    return null;
  }

  const appStart = sessionEntries.find((entry) => (
    entry?.kind === 'start' &&
    entry.runId === seed.runId &&
    entry.scenario === seed.scenario &&
    typeof entry.startedAt === 'number' &&
    Number.isFinite(entry.startedAt)
  ));
  if (!appStart || typeof appStart.startedAt !== 'number') {
    return {
      seed,
      status: 'missing-app-session',
      reason: 'The runner wrote a profile-session seed, but no matching app-side start entry was observed.',
    };
  }

  if (appStart.startedAt !== seed.startedAt) {
    return {
      appStartedAt: appStart.startedAt,
      seed,
      status: 'stale',
      reason: 'The app-side profile-session start did not match the runner-written seed.',
    };
  }

  return {
    appStartedAt: appStart.startedAt,
    seed,
    status: 'fresh',
  };
}

/**
 * Resolves app helper version evidence from profile-session entries and profile events.
 *
 * @param {{events: Record<string, unknown>[], sessionEntries: Record<string, unknown>[]}} options
 * @returns {ProfileHelperVersionCheck | null}
 */
function resolveProfileHelperVersionCheck({
  events,
  sessionEntries,
}: {
  events: Record<string, unknown>[];
  sessionEntries: Record<string, unknown>[];
}): ProfileHelperVersionCheck | null {
  if (events.length === 0 && sessionEntries.length === 0) {
    return null;
  }

  const observedVersions = uniqueStrings([
    ...events.map((event) => readTrimmedString(event.helperVersion)),
    ...sessionEntries.map((entry) => readTrimmedString(entry.helperVersion)),
  ]);
  if (observedVersions.length === 0) {
    return {
      expectedVersion: EXPECTED_PROFILE_SESSION_HELPER_VERSION,
      observedVersions,
      reason: 'Profile evidence did not include app helper version metadata.',
      status: 'missing',
    };
  }

  const mismatchedVersion = observedVersions.find((version) => version !== EXPECTED_PROFILE_SESSION_HELPER_VERSION);
  if (mismatchedVersion) {
    return {
      expectedVersion: EXPECTED_PROFILE_SESSION_HELPER_VERSION,
      observedVersions,
      reason: `Profile evidence was emitted by app helper version ${mismatchedVersion}, but this runner expects ${EXPECTED_PROFILE_SESSION_HELPER_VERSION}.`,
      status: 'mismatched',
    };
  }

  return {
    expectedVersion: EXPECTED_PROFILE_SESSION_HELPER_VERSION,
    observedVersions,
    reason: 'Profile evidence helper version matched the runner contract.',
    status: 'matched',
  };
}

/**
 * Resolves the run id used by rehydrated sidecar evidence.
 *
 * A rehydrated artifact can intentionally have a new run id while ingesting a
 * previously captured adb/simctl sidecar. Keep live runs strict, but allow an
 * explicit sidecar with exactly one source run id for the scenario to provide
 * the event filter.
 *
 * @param {{args: CliArgs, eventLogText: string, profileSessionEntriesPath: string | null, runId: string, scenarioName: string}} options
 * @returns {{failure?: EvidenceIdentityFailure, runId: string}}
 */
function resolveEvidenceFilterRunId({
  args,
  eventLogText,
  profileSessionEntriesPath,
  runId,
  scenarioName,
}: {
  args: CliArgs;
  eventLogText: string;
  profileSessionEntriesPath: string | null;
  runId: string;
  scenarioName: string;
}): { failure?: EvidenceIdentityFailure; runId: string } {
  const isRehydratedSidecar = typeof args['adb-artifacts'] === 'string' || typeof args['simctl-artifacts'] === 'string';
  if (!isRehydratedSidecar) {
    return { runId };
  }

  const scenarioEvents = extractProfileEvents(eventLogText, { scenario: scenarioName });
  const currentRunEvents = scenarioEvents.filter((event: Record<string, unknown>) => event.runId === runId);
  if (currentRunEvents.length > 0) {
    return { runId };
  }

  const sourceRunIds = new Set<string>(
    scenarioEvents
      .map((event: Record<string, unknown>) => event.runId)
      .filter((sourceRunId: unknown): sourceRunId is string => typeof sourceRunId === 'string' && sourceRunId.length > 0),
  );

  if (profileSessionEntriesPath && fs.existsSync(profileSessionEntriesPath)) {
    const storedEntries = JSON.parse(fs.readFileSync(profileSessionEntriesPath, 'utf8'));
    if (Array.isArray(storedEntries)) {
      for (const entry of storedEntries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        if (record.scenario !== scenarioName) {
          continue;
        }
        if (typeof record.runId === 'string' && record.runId.length > 0) {
          sourceRunIds.add(record.runId);
        }
      }
    }
  }

  if (sourceRunIds.size === 1) {
    return { runId: [...sourceRunIds][0] as string };
  }

  const sourceRunIdList = [...sourceRunIds].sort();
  if (sourceRunIdList.length > 1) {
    return {
      failure: {
        code: 'profile_session_identity_ambiguous',
        message: `Rehydrated sidecar evidence for scenario "${scenarioName}" contains multiple source run ids; ASL cannot choose one safely.`,
        requestedRunId: runId,
        sourceRunIds: sourceRunIdList,
      },
      runId,
    };
  }

  return { runId };
}

/**
 * Returns the first usable adb screenshot file from sidecar metadata.
 *
 * ADB can produce a valid PNG even when command metadata records a nonzero
 * exit status from the host process. Treat the binary artifact as the capture
 * authority, but only after validating the PNG signature and sidecar boundary.
 *
 * @param {{runDir: string, sidecarRoot: string | null}} options
 * @returns {{dependency: SidecarEvidenceDependency, path: string} | null}
 */
function resolveAndroidAdbScreenshotDependency({
  runDir,
  sidecarRoot,
}: {
  runDir: string;
  sidecarRoot: string | null;
}): { dependency: SidecarEvidenceDependency; path: string } | null {
  if (!sidecarRoot) {
    return null;
  }

  const metadata = readOptionalJsonObject(path.resolve(sidecarRoot, 'raw', 'android-metadata.json'));
  const actions = Array.isArray(metadata?.driverActions) ? metadata.driverActions : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      continue;
    }
    const record = action as Record<string, unknown>;
    if (record.driverAction !== 'screenshot') {
      continue;
    }
    const sidecarRelativePath = typeof record.capturePath === 'string'
      ? record.capturePath
      : typeof record.rawPath === 'string'
      ? record.rawPath
      : null;
    if (!sidecarRelativePath || path.isAbsolute(sidecarRelativePath)) {
      continue;
    }

    const screenshotPath = path.resolve(sidecarRoot, sidecarRelativePath);
    const relativeToSidecar = path.relative(sidecarRoot, screenshotPath);
    if (
      relativeToSidecar.length === 0 ||
      relativeToSidecar.startsWith('..') ||
      path.isAbsolute(relativeToSidecar) ||
      !isPngFile(screenshotPath)
    ) {
      continue;
    }

    const sidecarDependency = toSidecarEvidenceDependency({ runDir, sidecarRoot, targetPath: screenshotPath });
    return {
      dependency: sidecarDependency,
      path: sidecarDependency.path,
    };
  }

  return null;
}

/**
 * Checks whether a file starts with the PNG signature.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isPngFile(filePath: string): boolean {
  let signature: Uint8Array;
  try {
    signature = fs.readFileSync(filePath, { flag: 'r' }).subarray(0, 8);
  } catch {
    return false;
  }
  return signature.length === 8 &&
    signature[0] === 0x89 &&
    signature[1] === 0x50 &&
    signature[2] === 0x4e &&
    signature[3] === 0x47 &&
    signature[4] === 0x0d &&
    signature[5] === 0x0a &&
    signature[6] === 0x1a &&
    signature[7] === 0x0a;
}

/**
 * Reads a JSON artifact if it exists and contains an object.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function readOptionalJsonObject(filePath: string): Record<string, unknown> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Returns an object value when sidecar metadata provides one.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Returns a trimmed non-empty string from sidecar or CLI input.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Deduplicates concrete strings while preserving their first observed order.
 *
 * @param {Array<string | null | undefined>} values
 * @returns {string[]}
 */
function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (value) {
      unique.add(value);
    }
  }

  return [...unique];
}

/**
 * Classifies app id strings that should not drive runtime identity verification.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isConcreteAppId(value: unknown): value is string {
  const appId = readTrimmedString(value);
  return Boolean(appId && !PLACEHOLDER_APP_IDS.has(appId));
}

/**
 * Resolves the app id that this profile run expects the sidecar to represent.
 *
 * @param {{args: CliArgs, config: Record<string, unknown>, platform: ProfilePlatform}} options
 * @returns {ExpectedRuntimeIdentityValue | null}
 */
function resolveExpectedRuntimeAppId({
  args,
  config,
  platform,
}: {
  args: CliArgs;
  config: Record<string, any>;
  platform: ProfilePlatform;
}): ExpectedRuntimeIdentityValue | null {
  const cliValue = readScalarArg(platform === 'android' ? args.package : args.bundle);
  const cliAppId = readTrimmedString(cliValue);
  if (cliAppId) {
    return {
      source: 'cli',
      value: cliAppId,
    };
  }

  const configValue = platform === 'android' ? config.app?.androidPackage : config.app?.iosBundleId;
  if (isConcreteAppId(configValue)) {
    return {
      source: 'config',
      value: configValue.trim(),
    };
  }

  return null;
}

/**
 * Resolves the concrete device/simulator id that this profile run expects.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform}} options
 * @returns {ExpectedRuntimeIdentityValue | null}
 */
function resolveExpectedRuntimeTargetId({
  args,
  platform,
}: {
  args: CliArgs;
  platform: ProfilePlatform;
}): ExpectedRuntimeIdentityValue | null {
  const cliValue = readScalarArg(platform === 'android' ? args.serial : args.device);
  const targetId = readTrimmedString(cliValue);
  if (!targetId || (platform === 'ios' && targetId === 'booted')) {
    return null;
  }

  return {
    source: 'cli',
    value: targetId,
  };
}

/**
 * Resolves platform sidecar metadata for runtime identity verification.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform}} options
 * @returns {{metadata: Record<string, unknown> | null, metadataPath: string} | null}
 */
function resolveRuntimeIdentityMetadata({
  args,
  platform,
}: {
  args: CliArgs;
  platform: ProfilePlatform;
}): { metadata: Record<string, unknown> | null; metadataPath: string } | null {
  if (platform === 'android' && typeof args['adb-artifacts'] === 'string') {
    const metadataPath = 'raw/android-metadata.json';
    return {
      metadata: readOptionalJsonObject(path.resolve(args['adb-artifacts'], metadataPath)),
      metadataPath,
    };
  }

  if (platform === 'ios' && typeof args['simctl-artifacts'] === 'string') {
    const metadataPath = 'raw/ios-metadata.json';
    return {
      metadata: readOptionalJsonObject(path.resolve(args['simctl-artifacts'], metadataPath)),
      metadataPath,
    };
  }

  return null;
}

/**
 * Reads app ids recorded by the selected sidecar metadata.
 *
 * @param {{metadata: Record<string, unknown>, platform: ProfilePlatform}} options
 * @returns {string[]}
 */
function resolveObservedRuntimeAppIds({
  metadata,
  platform,
}: {
  metadata: Record<string, unknown>;
  platform: ProfilePlatform;
}): string[] {
  if (platform === 'android') {
    const appLifecycle = readRecordValue(metadata.appLifecycle);
    return uniqueStrings([
      readTrimmedString(metadata.packageName),
      readTrimmedString(appLifecycle?.packageName),
    ]);
  }

  return uniqueStrings([readTrimmedString(metadata.bundleId)]);
}

/**
 * Reads the device/simulator target id recorded by the selected sidecar metadata.
 *
 * @param {{metadata: Record<string, unknown>, platform: ProfilePlatform}} options
 * @returns {string | null}
 */
function resolveObservedRuntimeTargetId({
  metadata,
  platform,
}: {
  metadata: Record<string, unknown>;
  platform: ProfilePlatform;
}): string | null {
  const targetRecord = readRecordValue(platform === 'android' ? metadata.selectedDevice : metadata.selectedSimulator);
  return readTrimmedString(targetRecord?.udid) ?? readTrimmedString(targetRecord?.serial);
}

/**
 * Creates the shared runtime identity verification payload.
 *
 * @param {{expectedAppId: ExpectedRuntimeIdentityValue | null, expectedTargetId: ExpectedRuntimeIdentityValue | null, metadataPath: string, nextAction: string, nextActionCode: string, observedAppId?: string, observedTargetId?: string, platform: ProfilePlatform, reason: string, status: RuntimeIdentityVerification['status']}} options
 * @returns {RuntimeIdentityVerification}
 */
function buildRuntimeIdentityVerification({
  expectedAppId,
  expectedTargetId,
  metadataPath,
  nextAction,
  nextActionCode,
  observedAppId,
  observedTargetId,
  platform,
  reason,
  status,
}: {
  expectedAppId: ExpectedRuntimeIdentityValue | null;
  expectedTargetId: ExpectedRuntimeIdentityValue | null;
  metadataPath: string;
  nextAction: string;
  nextActionCode: string;
  observedAppId?: string;
  observedTargetId?: string;
  platform: ProfilePlatform;
  reason: string;
  status: RuntimeIdentityVerification['status'];
}): RuntimeIdentityVerification {
  return {
    platform,
    reason,
    sidecarMetadataPath: metadataPath,
    status,
    nextAction,
    nextActionCode,
    ...(expectedAppId
      ? {
          expectedAppId: expectedAppId.value,
          expectedAppIdSource: expectedAppId.source,
        }
      : {}),
    ...(expectedTargetId
      ? {
          expectedTargetId: expectedTargetId.value,
          expectedTargetIdSource: 'cli' as const,
        }
      : {}),
    ...(observedAppId ? { observedAppId } : {}),
    ...(observedTargetId ? { observedTargetId } : {}),
  };
}

/**
 * Verifies that supplied sidecar metadata matches the expected runtime identity.
 *
 * @param {{args: CliArgs, config: Record<string, unknown>, platform: ProfilePlatform}} options
 * @returns {RuntimeIdentityVerification | null}
 */
function resolveRuntimeIdentityVerification({
  args,
  config,
  platform,
}: {
  args: CliArgs;
  config: Record<string, any>;
  platform: ProfilePlatform;
}): RuntimeIdentityVerification | null {
  const sidecarMetadata = resolveRuntimeIdentityMetadata({ args, platform });
  if (!sidecarMetadata) {
    return null;
  }

  const expectedAppId = resolveExpectedRuntimeAppId({ args, config, platform });
  const expectedTargetId = resolveExpectedRuntimeTargetId({ args, platform });
  if (!expectedAppId && !expectedTargetId) {
    return null;
  }

  const sidecarName = platform === 'android' ? 'adb' : 'simctl';
  const appLabel = platform === 'android' ? 'package' : 'bundle';
  const targetLabel = platform === 'android' ? 'device serial' : 'simulator UDID';
  const rerunAction = `Rerun the ${sidecarName} sidecar with the expected ${appLabel} or target id, or profile this sidecar with matching CLI identity flags before trusting runtime evidence.`;

  if (!sidecarMetadata.metadata) {
    return buildRuntimeIdentityVerification({
      expectedAppId,
      expectedTargetId,
      metadataPath: sidecarMetadata.metadataPath,
      nextAction: `Use a ${sidecarName} capture sidecar that writes ${sidecarMetadata.metadataPath}, then rerun before treating sidecar evidence as runtime-owned.`,
      nextActionCode: 'capture_runtime_identity_metadata',
      platform,
      reason: `${platform === 'android' ? 'Android adb' : 'iOS simctl'} sidecar metadata did not include enough runtime identity to verify the expected app or target.`,
      status: 'unverified',
    });
  }

  const observedAppIds = resolveObservedRuntimeAppIds({ metadata: sidecarMetadata.metadata, platform });
  const observedTargetId = resolveObservedRuntimeTargetId({ metadata: sidecarMetadata.metadata, platform });
  const mismatchedAppId = expectedAppId
    ? observedAppIds.find((observedAppId) => observedAppId !== expectedAppId.value) ?? null
    : null;
  if (expectedAppId && mismatchedAppId) {
    return buildRuntimeIdentityVerification({
      expectedAppId,
      expectedTargetId,
      metadataPath: sidecarMetadata.metadataPath,
      nextAction: rerunAction,
      nextActionCode: 'rerun_sidecar_with_expected_runtime_identity',
      observedAppId: mismatchedAppId,
      ...(observedTargetId ? { observedTargetId } : {}),
      platform,
      reason: `${platform === 'android' ? 'Android adb' : 'iOS simctl'} sidecar metadata records ${appLabel} ${mismatchedAppId}, but this profile run expected ${expectedAppId.value}.`,
      status: 'mismatched',
    });
  }

  if (expectedTargetId && observedTargetId && observedTargetId !== expectedTargetId.value) {
    return buildRuntimeIdentityVerification({
      expectedAppId,
      expectedTargetId,
      metadataPath: sidecarMetadata.metadataPath,
      nextAction: rerunAction,
      nextActionCode: 'rerun_sidecar_with_expected_runtime_identity',
      observedAppId: observedAppIds.join(','),
      observedTargetId,
      platform,
      reason: `${platform === 'android' ? 'Android adb' : 'iOS simctl'} sidecar metadata records ${targetLabel} ${observedTargetId}, but this profile run expected ${expectedTargetId.value}.`,
      status: 'mismatched',
    });
  }

  const appIdentityMissing = Boolean(expectedAppId && observedAppIds.length === 0);
  const targetIdentityMissing = Boolean(expectedTargetId && !observedTargetId);
  if (appIdentityMissing || targetIdentityMissing) {
    return buildRuntimeIdentityVerification({
      expectedAppId,
      expectedTargetId,
      metadataPath: sidecarMetadata.metadataPath,
      nextAction: `Use a ${sidecarName} capture sidecar that records the selected ${appLabel} and ${targetLabel}, then rerun before treating sidecar evidence as runtime-owned.`,
      nextActionCode: 'capture_runtime_identity_metadata',
      observedAppId: observedAppIds.join(','),
      ...(observedTargetId ? { observedTargetId } : {}),
      platform,
      reason: `${platform === 'android' ? 'Android adb' : 'iOS simctl'} sidecar metadata could not prove the expected runtime identity.`,
      status: 'unverified',
    });
  }

  return buildRuntimeIdentityVerification({
    expectedAppId,
    expectedTargetId,
    metadataPath: sidecarMetadata.metadataPath,
    nextAction: 'No action required.',
    nextActionCode: 'none',
    observedAppId: observedAppIds.join(','),
    ...(observedTargetId ? { observedTargetId } : {}),
    platform,
    reason: `${platform === 'android' ? 'Android adb' : 'iOS simctl'} sidecar metadata matched the expected runtime identity.`,
    status: 'verified',
  });
}

/**
 * Builds an Android target label from adb capture metadata.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {RuntimeTarget | null}
 */
function resolveAndroidRuntimeTarget(metadata: Record<string, unknown>): RuntimeTarget | null {
  const selectedDevice = metadata.selectedDevice && typeof metadata.selectedDevice === 'object' && !Array.isArray(metadata.selectedDevice)
    ? metadata.selectedDevice as Record<string, unknown>
    : null;
  const deviceProperties = metadata.deviceProperties && typeof metadata.deviceProperties === 'object' && !Array.isArray(metadata.deviceProperties)
    ? metadata.deviceProperties as Record<string, unknown>
    : null;
  const serial = typeof selectedDevice?.serial === 'string' ? selectedDevice.serial : null;
  if (!serial) {
    return null;
  }

  const model = typeof deviceProperties?.model === 'string' && deviceProperties.model.trim().length > 0
    ? deviceProperties.model.trim()
    : 'android device';
  const release = typeof deviceProperties?.release === 'string' && deviceProperties.release.trim().length > 0
    ? ` Android ${deviceProperties.release.trim()}`
    : '';
  const sdk = typeof deviceProperties?.sdk === 'string' && deviceProperties.sdk.trim().length > 0
    ? ` API ${deviceProperties.sdk.trim()}`
    : '';

  return {
    name: `${model}${release}${sdk}`.trim(),
    udid: serial,
  };
}

/**
 * Builds an iOS target label from simctl capture metadata.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {RuntimeTarget | null}
 */
function resolveIosRuntimeTarget(metadata: Record<string, unknown>): RuntimeTarget | null {
  const selectedSimulator = metadata.selectedSimulator && typeof metadata.selectedSimulator === 'object' && !Array.isArray(metadata.selectedSimulator)
    ? metadata.selectedSimulator as Record<string, unknown>
    : null;
  const name = typeof selectedSimulator?.name === 'string' ? selectedSimulator.name : null;
  const udid = typeof selectedSimulator?.udid === 'string' ? selectedSimulator.udid : null;
  if (!name || !udid) {
    return null;
  }

  return {
    name,
    udid,
  };
}

/**
 * Resolves the runtime target attached to adb or simctl capture artifacts.
 *
 * @param {{args: CliArgs, platform: ProfilePlatform}} options
 * @returns {RuntimeTarget}
 */
function resolveRuntimeTarget({ args, platform }: { args: CliArgs; platform: ProfilePlatform }): RuntimeTarget {
  if (platform === 'android' && typeof args['adb-artifacts'] === 'string') {
    const metadata = readOptionalJsonObject(path.resolve(args['adb-artifacts'], 'raw', 'android-metadata.json'));
    const target = metadata ? resolveAndroidRuntimeTarget(metadata) : null;
    if (target) {
      return target;
    }
  }

  if (platform === 'ios' && typeof args['simctl-artifacts'] === 'string') {
    const metadata = readOptionalJsonObject(path.resolve(args['simctl-artifacts'], 'raw', 'ios-metadata.json'));
    const target = metadata ? resolveIosRuntimeTarget(metadata) : null;
    if (target) {
      return target;
    }
  }

  return {
    name: platform === 'android' ? 'unknown android device' : 'unknown',
    udid: 'unknown',
  };
}

/**
 * Resolves the profile scenario name from modern or legacy scenario identity fields.
 *
 * @param {{scenario: Record<string, unknown>, scenarioPath: string}} options
 * @returns {string}
 */
function resolveProfileScenarioName({
  scenario,
  scenarioPath,
}: {
  scenario: Record<string, unknown>;
  scenarioPath: string;
}): string {
  if (typeof scenario.name === 'string' && scenario.name.length > 0) {
    return scenario.name;
  }

  if (typeof scenario.id === 'string' && scenario.id.length > 0) {
    return scenario.id;
  }

  return path.basename(scenarioPath, '.json');
}

/**
 * Reads evidence-provider manifests for profile compatibility preflight.
 *
 * @param {CliArgs} args
 * @returns {Record<string, unknown>[]}
 */
function readEvidenceProviderManifests(args: CliArgs): Record<string, unknown>[] {
  return readRepeatableArgValues(args, 'provider').map((providerPath, index) => (
    assertValidJson(
      readJson(path.resolve(providerPath)),
      SCHEMAS.runnerCapabilities,
      `Evidence provider manifest ${index + 1}`,
    ) as Record<string, unknown>
  ));
}

/**
 * Runs planner compatibility before a live profile capture starts.
 *
 * Failed compatibility writes classified artifacts in the profile run folder so
 * agents can stop before adb, simctl, or provider work consumes runtime time.
 *
 * @param {CompatibilityPreflightOptions} options
 * @returns {Promise<void>}
 */
async function runProfileCompatibilityPreflight({
  args,
  artifactRoot,
  platform,
  primaryRunner,
  runDir,
  runId,
  scenario,
  scenarioName,
}: CompatibilityPreflightOptions): Promise<void> {
  const layout = createArtifactLayout({ outputDir: runDir });
  const compatibility = evaluateRunnerCompatibility({
    scenario,
    runner: primaryRunner,
    evidenceProviders: readEvidenceProviderManifests(args),
    platform,
  });
  await writeJsonArtifact({
    filePath: layout.plannerCompatibility,
    value: compatibility,
    schema: {
      type: 'object',
      additionalProperties: true,
    },
    label: 'Planner compatibility artifact',
  });

  if (compatibility.compatible) {
    process.stderr.write(
      `profile preflight passed: ${platform}/${scenarioName} artifactRoot=${artifactRoot} planner=${path.relative(process.cwd(), layout.plannerCompatibility)}\n`,
    );
    return;
  }

  const health = buildCompatibilityHealth({ scenario, runId, compatibility });
  const verdict = buildUnevaluatedVerdict({ scenario, runId, health });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });
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
  throw new Error(`Profile compatibility preflight failed; inspect ${runDir}/agent-summary.md.`);
}

/**
 * Serializes JSON with stable object key ordering for reproducible hashes.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/**
 * Creates a stable fingerprint for the scenario contract used by one run.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {string}
 */
function hashScenarioContract(scenario: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(stableJsonStringify(scenario)).digest('hex');
}

/**
 * Returns true when a value is a plain object record.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a positive integer from scenario metadata.
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
 * Resolves the expected profile-event iteration count for a scenario.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {number}
 */
function resolveExpectedIterations(scenario: Record<string, unknown>): number {
  if (typeof scenario.defaultIterations === 'number' || typeof scenario.defaultIterations === 'string') {
    return readPositiveInteger(scenario.defaultIterations, 1);
  }

  return readPositiveInteger(isRecord(scenario.cycles) ? scenario.cycles.iterations : undefined, 1);
}

/**
 * Finds a milestone event name by milestone id.
 *
 * @param {Record<string, unknown>} scenario
 * @param {unknown} milestoneId
 * @returns {string | null}
 */
function findMilestoneEvent(scenario: Record<string, unknown>, milestoneId: unknown): string | null {
  if (typeof milestoneId !== 'string' || !Array.isArray(scenario.milestones)) {
    return null;
  }

  for (const milestone of scenario.milestones) {
    if (!isRecord(milestone)) {
      continue;
    }
    if (milestone.id === milestoneId && typeof milestone.event === 'string') {
      return milestone.event;
    }
  }

  return null;
}

/**
 * Returns true when a milestone is explicitly optional.
 *
 * @param {Record<string, unknown>} scenario
 * @param {unknown} milestoneId
 * @returns {boolean}
 */
function isOptionalMilestone(scenario: Record<string, unknown>, milestoneId: unknown): boolean {
  if (typeof milestoneId !== 'string' || !Array.isArray(scenario.milestones)) {
    return false;
  }

  for (const milestone of scenario.milestones) {
    if (!isRecord(milestone)) {
      continue;
    }
    if (milestone.id === milestoneId) {
      return milestone.required === false;
    }
  }

  return false;
}

/**
 * Returns true when a milestone represents one-time scenario readiness rather than a repeated cycle edge.
 *
 * @param {Record<string, unknown>} scenario
 * @param {unknown} milestoneId
 * @param {string | null} milestoneEvent
 * @returns {boolean}
 */
function isReadinessMilestone(
  scenario: Record<string, unknown>,
  milestoneId: unknown,
  milestoneEvent: string | null,
): boolean {
  const readyEvent = isRecord(scenario.truthEvents) && isRecord(scenario.truthEvents.ready)
    ? scenario.truthEvents.ready.event
    : undefined;
  if (typeof readyEvent === 'string' && milestoneEvent === readyEvent) {
    return true;
  }

  const id = typeof milestoneId === 'string' ? milestoneId.toLowerCase() : '';
  const event = typeof milestoneEvent === 'string' ? milestoneEvent.toLowerCase() : '';
  return id.includes('ready') || event.includes('ready');
}

/**
 * Builds a milestone-id to event-name lookup for schema-era scenarios.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {Record<string, string>}
 */
function buildMilestoneEventLookup(scenario: Record<string, unknown>): Record<string, string> {
  const lookup: Record<string, string> = {};
  if (!Array.isArray(scenario.milestones)) {
    return lookup;
  }

  for (const milestone of scenario.milestones) {
    if (!isRecord(milestone) || typeof milestone.id !== 'string' || typeof milestone.event !== 'string') {
      continue;
    }
    lookup[milestone.id] = milestone.event;
  }

  return lookup;
}

/**
 * Derives cycle metric event names from schema-era milestone budgets when needed.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {Record<string, string> | null}
 */
function resolveProfileMetricEvents(scenario: Record<string, unknown>): Record<string, string> | null {
  if (isRecord(scenario.metricEvents)) {
    return scenario.metricEvents as Record<string, string>;
  }

  if (!Array.isArray(scenario.budgets)) {
    return null;
  }

  const milestoneEvents = buildMilestoneEventLookup(scenario);
  if (
    milestoneEvents.openRequested &&
    milestoneEvents.opened &&
    milestoneEvents.closeRequested &&
    milestoneEvents.dismissed
  ) {
    return {
      closeRequested: milestoneEvents.closeRequested,
      dismissed: milestoneEvents.dismissed,
      opened: milestoneEvents.opened,
      openRequested: milestoneEvents.openRequested,
    };
  }

  for (const budget of scenario.budgets) {
    if (!isRecord(budget)) {
      continue;
    }
    const fromEvent = findMilestoneEvent(scenario, budget.fromMilestone);
    const toEvent = findMilestoneEvent(scenario, budget.toMilestone);
    if (!fromEvent && toEvent) {
      return {
        milestone: toEvent,
      };
    }
    if (fromEvent && toEvent && isReadinessMilestone(scenario, budget.fromMilestone, fromEvent)) {
      return {
        milestone: toEvent,
      };
    }
    if (fromEvent && toEvent && isOptionalMilestone(scenario, budget.fromMilestone)) {
      return {
        milestone: toEvent,
      };
    }
    if (fromEvent && toEvent) {
      return {
        closeRequested: toEvent,
        dismissed: toEvent,
        opened: fromEvent,
        openRequested: fromEvent,
      };
    }
  }

  return null;
}

/**
 * Resolves how many repeated completion milestone events prove one cycle body.
 *
 * @param {Record<string, unknown>} scenario
 * @param {Record<string, string> | null} metricEvents
 * @returns {number}
 */
function resolveMilestoneEventsPerIteration(
  scenario: Record<string, unknown>,
  metricEvents: Record<string, string> | null,
): number {
  if (!metricEvents || typeof metricEvents.milestone !== 'string' || !Array.isArray(scenario.steps)) {
    return 1;
  }

  const milestoneEvents = buildMilestoneEventLookup(scenario);
  const matchingWaitStepIds = new Set<string>();
  for (const step of scenario.steps) {
    if (!isRecord(step) || step.kind !== 'waitForMilestone' || typeof step.milestone !== 'string') {
      continue;
    }
    const event = milestoneEvents[step.milestone] ?? step.milestone;
    if (event === metricEvents.milestone && typeof step.id === 'string') {
      matchingWaitStepIds.add(step.id);
    }
  }

  if (matchingWaitStepIds.size === 0) {
    return 1;
  }

  const bodyStepIds = isRecord(scenario.cycles) && Array.isArray(scenario.cycles.bodyStepIds)
    ? new Set(scenario.cycles.bodyStepIds.filter((entry): entry is string => typeof entry === 'string'))
    : null;
  if (bodyStepIds && bodyStepIds.size > 0) {
    let count = 0;
    let bodyCommandPending = false;
    for (const step of scenario.steps) {
      if (!isRecord(step)) {
        continue;
      }
      if (typeof step.id === 'string' && bodyStepIds.has(step.id) && step.kind === 'command') {
        bodyCommandPending = true;
        continue;
      }
      if (bodyCommandPending && typeof step.id === 'string' && matchingWaitStepIds.has(step.id)) {
        count += 1;
        bodyCommandPending = false;
        continue;
      }
      if (bodyCommandPending && step.kind === 'command') {
        bodyCommandPending = false;
      }
    }
    return count > 1 ? count : 1;
  }

  return matchingWaitStepIds.size > 1 ? matchingWaitStepIds.size : 1;
}

/**
 * Maps shorthand milestone budget fields to aggregate profile budget keys.
 *
 * @param {{budget: Record<string, unknown>, metric: string}} options
 * @returns {string | null}
 */
function resolveProfileBudgetKey({
  budget,
  metric,
}: {
  budget: Record<string, unknown>;
  metric: string;
}): string | null {
  const suffix = metric === 'p95' ? 'P95Ms' : metric === 'p50' ? 'P50Ms' : null;
  if (!suffix) {
    return null;
  }

  if (budget.fromMilestone === 'openRequested' && budget.toMilestone === 'opened') {
    return `open${suffix}`;
  }

  if (budget.fromMilestone === 'closeRequested' && budget.toMilestone === 'dismissed') {
    return `close${suffix}`;
  }

  return `cycle${suffix}`;
}

/**
 * Normalizes schema-era budget arrays into the profile budget evaluator shape.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {Record<string, unknown> | null}
 */
function resolveProfileBudgets(scenario: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(scenario.budgets)) {
    return scenario.budgets;
  }

  if (!Array.isArray(scenario.budgets)) {
    return null;
  }

  const pass: Record<string, number> = {};
  const intervals: Record<string, unknown>[] = [];
  for (const budget of scenario.budgets) {
    if (!isRecord(budget) || typeof budget.limit !== 'number') {
      continue;
    }

    if (budget.metric === 'p95' || budget.metric === 'p50') {
      const fromEvent = findMilestoneEvent(scenario, budget.fromMilestone);
      const toEvent = findMilestoneEvent(scenario, budget.toMilestone);
      if (fromEvent && toEvent) {
        intervals.push({
          name: typeof budget.name === 'string' ? budget.name : `${String(budget.fromMilestone)} to ${String(budget.toMilestone)}`,
          metric: budget.metric,
          limit: budget.limit,
          fromEvent,
          toEvent,
        });
        continue;
      }

      const budgetKey = resolveProfileBudgetKey({ budget, metric: budget.metric });
      if (budgetKey) {
        pass[budgetKey] = budget.limit;
      }
    } else if (budget.metric === 'failures') {
      pass.failures = budget.limit;
    } else if (budget.metric === 'timeouts') {
      pass.timeouts = budget.limit;
    }
  }

  return Object.keys(pass).length > 0 || intervals.length > 0
    ? {
        metric: 'milestone budget',
        pass,
        ...(intervals.length > 0 ? { intervals } : {}),
      }
    : null;
}

/**
 * Reads the installed package version for run provenance.
 *
 * @returns {string}
 */
function readAslPackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const packageJson = readJson(packageJsonPath);
    return typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Infers the command transport used for profile-session or fixture evidence.
 *
 * @param {{args: CliArgs, interactionDriver: string, options: ProfileMobileOptions}} options
 * @returns {string}
 */
function resolveCommandTransport({
  args,
  interactionDriver,
  options,
}: {
  args: CliArgs;
  interactionDriver: string;
  options: ProfileMobileOptions;
}): string {
  if (typeof options.commandTransport === 'string' && options.commandTransport.length > 0) {
    return options.commandTransport;
  }
  if (typeof args.events === 'string') {
    return 'fixture-log-ingest';
  }
  if (typeof args['ios-profile-session-transport'] === 'string') {
    return `profile-session-${args['ios-profile-session-transport']}`;
  }
  if (args['android-profile-session-storage'] || args['ios-profile-session-storage']) {
    return 'profile-session-storage';
  }
  if (args['profile-session']) {
    return 'profile-session-deeplink';
  }
  if (typeof args['adb-artifacts'] === 'string') {
    return 'adb-artifacts';
  }
  if (typeof args['simctl-artifacts'] === 'string') {
    return 'simctl-artifacts';
  }
  return interactionDriver;
}

/**
 * Builds product-neutral provenance cohort metadata for the run manifest.
 *
 * @param {{args: CliArgs, appId: string, interactionDriver: string, options: ProfileMobileOptions, providerExecution: ProviderCommandExecution}} options
 * @returns {Record<string, unknown>}
 */
function buildProfileProvenanceCohort({
  appId,
  args,
  interactionDriver,
  options,
  providerExecution,
}: {
  appId: string;
  args: CliArgs;
  interactionDriver: string;
  options: ProfileMobileOptions;
  providerExecution: ProviderCommandExecution;
}): Record<string, unknown> {
  return {
    appId,
    commandTransport: resolveCommandTransport({ args, interactionDriver, options }),
    platform: options.platform,
    providers: providerExecution.providers,
    runnerName: interactionDriver,
    runnerVersion: readAslPackageVersion(),
    ...options.provenanceCohort,
  };
}

/**
 * Builds an environment assertion for manifest pre/postconditions.
 *
 * @param {{artifact?: string, evidence?: string, source: string, value: unknown}} options
 * @returns {Record<string, unknown>}
 */
function environmentAssertion({
  artifact,
  evidence = 'asserted',
  source,
  value,
}: {
  artifact?: string;
  evidence?: string;
  source: string;
  value: unknown;
}): Record<string, unknown> {
  return {
    value,
    evidence,
    source,
    ...(artifact ? { artifact } : {}),
  };
}

/**
 * Builds postconditions that ASL can truthfully assert after writing profile artifacts.
 *
 * @param {{metrics: Record<string, unknown>, options: ProfileMobileOptions}} options
 * @returns {Record<string, unknown>}
 */
function buildProfileEnvironmentPostconditions({
  metrics,
  options,
}: {
  metrics: Record<string, unknown>;
  options: ProfileMobileOptions;
}): Record<string, unknown> {
  const runPassed = metrics.status === 'passed';
  return {
    artifactState: environmentAssertion({
      value: runPassed ? 'complete' : 'partial',
      evidence: 'asserted',
      source: 'asl-profile-runner',
      artifact: 'manifest.json',
    }),
    cleanupState: environmentAssertion({
      value: 'not-required',
      evidence: 'asserted',
      source: 'asl-profile-runner',
    }),
    ...options.environmentPostconditions,
  };
}

/**
 * Runs the mobile log-ingest profile artifact pipeline.
 *
 * @param {CliArgs} args
 * @param {ProfileMobileOptions} options
 * @returns {Promise<ProfileRunResult>}
 */
async function runProfileMobile(args: CliArgs, options: ProfileMobileOptions): Promise<ProfileRunResult> {
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    throw new Error('Both --config and --scenario are required.');
  }

  const configPath = path.resolve(args.config);
  const scenarioPath = path.resolve(args.scenario);
  const config = readJson(configPath);
  const scenario = readJson(scenarioPath);
  const scenarioName = resolveProfileScenarioName({ scenario, scenarioPath });
  const profileScenario = { ...scenario, name: scenarioName };
  const scenarioHash = hashScenarioContract(profileScenario);
  const expectedIterations = resolveExpectedIterations(profileScenario);
  const profileMetricEvents = resolveProfileMetricEvents(profileScenario);
  const milestoneEventsPerIteration = resolveMilestoneEventsPerIteration(profileScenario, profileMetricEvents);
  const profileBudgets = resolveProfileBudgets(profileScenario);
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const artifactRoot = resolveArtifactRoot({ args, config, configPath, platform: options.platform });
  const runDir = path.join(artifactRoot, scenarioName, runId);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  const capturesDir = layout.captures;
  const startedAt = new Date().toISOString();
  const eventLogPath = resolveEventLogPath({ args, platform: options.platform });
  const profileSessionEntriesPath = resolveProfileSessionEntriesPath({ args, platform: options.platform });
  const interactionDriver = resolveInteractionDriver({ config, options, scenario });
  const comparisonLane = resolveComparisonLane({ args, options, scenario });

  await ensureDir(rawDir);
  await ensureDir(capturesDir);
  await ensureDir(layout.signals.js);
  await ensureDir(layout.signals.memory);
  await ensureDir(layout.signals.network);
  const runPlan = buildProfileRunPlan({
    args,
    artifactRoot,
    comparisonLane,
    expectedIterations,
    interactionDriver,
    layout,
    milestoneEventsPerIteration,
    options,
    profileScenario,
    runDir,
    runId,
    scenarioHash,
    scenarioPath,
  });
  await writeProfileRunPlan({ layout, plan: runPlan });
  const providerExecution = await executeProviderCommands({
    args,
    layout,
    platform: options.platform,
    runDir,
    runId,
    scenarioId: scenarioName,
  });
  let attachedEvidence: AttachedEvidence;
  try {
    attachedEvidence = await resolveAttachedEvidence({ args, layout, providerInputs: providerExecution.inputs });
  } catch (error) {
    const providerInput = providerExecution.inputs.find((input) => error instanceof Error && error.message.includes(input.sourcePath));
    const health = buildProviderCommandFailureHealth({
      failures: [
        {
          commandId: 'provider-evidence',
          code: 'provider_evidence_invalid',
          exitCode: null,
          message: error instanceof Error ? error.message : String(error),
          name: 'evidence_provider_output_valid',
          nextAction: 'Fix the provider output so it satisfies the ASL evidence contract, then rerun the profile.',
          nextActionCode: 'fix_provider_evidence_output',
          phase: 'afterCapture',
          providerId: providerInput?.providerId ?? 'unknown-provider',
          ...(providerInput?.manifestPath ? { rawPath: providerInput.manifestPath } : {}),
        },
      ],
      runId,
      scenario: profileScenario,
    });
    const verdict = buildProfileVerdict({ scenario: profileScenario, runId, health, metrics: {} });
    const agentSummary = buildAgentSummaryMarkdown({ health, verdict });
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
      runDir,
      health,
      verdict,
    };
  }
  if (
    providerExecution.failures.length > 0 &&
    providerExecution.inputs.length === 0 &&
    providerExecution.outputStatuses.length === 0
  ) {
    const health = buildProviderCommandFailureHealth({
      failures: providerExecution.failures,
      runId,
      scenario: profileScenario,
    });
    const verdict = buildProfileVerdict({ scenario: profileScenario, runId, health, metrics: {} });
    const agentSummary = buildAgentSummaryMarkdown({ health, verdict });
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
      runDir,
      health,
      verdict,
    };
  }

  const eventLogText = eventLogPath ? await fsp.readFile(eventLogPath, 'utf8') : '';
  const evidenceFilterRun = resolveEvidenceFilterRunId({
    args,
    eventLogText,
    profileSessionEntriesPath,
    runId,
    scenarioName,
  });
  const evidenceFilterRunId = evidenceFilterRun.runId;
  const events = extractProfileEvents(eventLogText, {
    scenario: scenarioName,
    runId: evidenceFilterRunId,
  });
  const logSessionEntries = extractProfileSessionEntries(eventLogText, {
    scenario: scenarioName,
    runId: evidenceFilterRunId,
  });
  const storedSessionEntries = profileSessionEntriesPath
    ? JSON.parse(await fsp.readFile(profileSessionEntriesPath, 'utf8'))
    : [];
  const sessionEntries = [
    ...logSessionEntries,
    ...(Array.isArray(storedSessionEntries)
      ? storedSessionEntries.filter((entry: unknown): entry is Record<string, unknown> => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return false;
          }
          const record = entry as Record<string, unknown>;
          return (
            (!('scenario' in record) || record.scenario === scenarioName) &&
            (!('runId' in record) || record.runId === evidenceFilterRunId)
          );
        })
      : []),
  ];
  const profileSessionSeed = resolveProfileSessionSeed({
    args,
    platform: options.platform,
    runId: evidenceFilterRunId,
    scenarioName,
  });
  const sessionFreshness = resolveProfileSessionFreshness({
    seed: profileSessionSeed,
    sessionEntries,
  });
  const helperVersion = resolveProfileHelperVersionCheck({
    events,
    sessionEntries,
  });
  const runtimeTarget = resolveRuntimeTarget({ args, platform: options.platform });
  const runtimeIdentity = resolveRuntimeIdentityVerification({
    args,
    config,
    platform: options.platform,
  });

  const metrics = buildMetricsFromProfileEvents({
    scenario: scenarioName,
    runId,
    events,
    expectedIterations,
    budgets: profileBudgets,
    cycleEventNames: profileMetricEvents,
    milestoneEventsPerIteration,
    artifacts: {
      captures: attachedEvidence.captures,
      signals: attachedEvidence.signals,
    },
  });
  const eventLogRawPath = eventLogPath ? `raw/${path.basename(eventLogPath)}` : undefined;
  const eventLogIsProfileSessionEvidenceOnly = options.platform === 'ios' &&
    eventLogPath &&
    path.basename(eventLogPath) === 'ios-profile-events.log';
  const manifestArtifacts = {
    causalRun: 'causal-run.json',
    budgetVerdict: 'budget-verdict.json',
    manifest: 'manifest.json',
    metrics: 'metrics.json',
    summary: 'summary.md',
    scenario: toPortablePathReference(scenarioPath),
    raw: {
      ...(eventLogRawPath && !eventLogIsProfileSessionEvidenceOnly
        ? {
            interactionLog: eventLogRawPath,
            deviceLog: eventLogRawPath,
          }
        : {}),
      ...(profileSessionEntriesPath
        ? { profileSessionEntries: `raw/${path.basename(profileSessionEntriesPath)}` }
        : {}),
    },
    captures: {
      screenshots: attachedEvidence.captures.screenshots,
      ...(attachedEvidence.captures.video ? { video: attachedEvidence.captures.video } : {}),
      ...(attachedEvidence.captures.uiTree ? { uiTree: attachedEvidence.captures.uiTree } : {}),
    },
    signals: {
      js: attachedEvidence.signals.js,
      memory: attachedEvidence.signals.memory,
      network: attachedEvidence.signals.network,
    },
    evidenceAttachments: buildEvidenceAttachmentManifest(attachedEvidence.attachments),
    diagnostics: buildDiagnosticInventory({
      args,
      attachedEvidence,
      eventLogPath,
      platform: options.platform,
      profileSessionEntriesPath,
      providerOutputStatuses: providerExecution.outputStatuses,
      runDir,
      scenario: profileScenario,
    }),
  };
  const appId = resolveAppId({ config, platform: options.platform });
  const commandTransport = resolveCommandTransport({ args, interactionDriver, options });
  const provenanceCohort = buildProfileProvenanceCohort({
    appId,
    args,
    interactionDriver,
    options,
    providerExecution,
  });

  const manifest = buildManifest({
    scenario: scenarioName,
    scenarioHash,
    runId,
    platform: options.platform,
    status: metrics.status,
    terminalState: buildAttemptTerminalState(metrics),
    endedAt: new Date().toISOString(),
    interactionDriver,
    comparisonLane,
    classification: buildAttemptClassification(metrics),
    cleanup: {
      status: 'not-required',
    },
    partialArtifacts: buildAttemptPartialArtifacts({ artifacts: manifestArtifacts, metrics }),
    preconditions: options.environmentPreconditions,
    postconditions: buildProfileEnvironmentPostconditions({ metrics, options }),
    startedAt,
    simulator: runtimeTarget,
    bundleId: appId,
    gitSha: resolveGitSha(),
    toolVersions: {
      node: process.version,
    },
    cohort: provenanceCohort,
    artifacts: manifestArtifacts,
  });

  const timeline = buildCausalTimeline({
    events,
    sessionEntries,
    startedAt,
    phaseMap: scenario.timelinePhases ?? null,
    owner: scenario.flowId ?? scenarioName,
  });

  const causalRun = buildCausalRun({
    scenario: profileScenario,
    flowId: scenario.flowId ?? scenarioName,
    runId,
    platform: options.platform,
    buildFlavor: 'unknown',
    interactionDriver,
    trigger: scenario.trigger ?? null,
    budgets: isRecord(profileBudgets?.pass) ? profileBudgets.pass : null,
    timeline,
    artifacts: manifest.artifacts,
    manifest,
    metrics,
  });

  const health = buildProfileHealth({
    scenario: profileScenario,
    runId,
    metrics,
    diagnostics: manifestArtifacts.diagnostics,
    evidenceIdentityFailure: evidenceFilterRun.failure ?? null,
    providerFailures: providerExecution.failures,
    profileEventCount: events.length,
    profileSessionEntryCount: sessionEntries.length,
    commandTransport,
    helperVersion,
    runtimeIdentity,
    sessionEntries,
    sessionFreshness,
    sessionFreshnessRequired: options.platform === 'android' && typeof args['adb-artifacts'] === 'string',
  });
  const finalHealth = appendProviderCommandFailuresToHealth({
    failures: providerExecution.failures,
    health,
    runId,
    scenario: profileScenario,
  });
  const budgetVerdict = buildBudgetVerdict({
    flowId: scenario.flowId ?? scenarioName,
    runId,
    budgetEvaluation: metrics.budgetEvaluation ?? null,
    healthStatus: typeof finalHealth.healthStatus === 'string' ? finalHealth.healthStatus : null,
  });
  const verdict = buildProfileVerdict({ scenario: profileScenario, runId, health: finalHealth, metrics });
  const agentSummary = buildAgentSummaryMarkdown({ health: finalHealth, verdict, manifest });
  const summary = buildSummaryMarkdown({ manifest, metrics });

  await writeJsonArtifact({
    filePath: layout.health,
    value: finalHealth,
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
  await writeJsonArtifact({
    filePath: layout.profile.manifest,
    value: manifest,
    schema: SCHEMAS.manifest,
    label: 'Manifest artifact',
  });
  await writeJsonArtifact({
    filePath: layout.profile.metrics,
    value: metrics,
    schema: SCHEMAS.metrics,
    label: 'Metrics artifact',
  });
  await writeJsonArtifact({
    filePath: layout.profile.causalRun,
    value: causalRun,
    schema: SCHEMAS.causalRun,
    label: 'Causal run artifact',
  });
  if (budgetVerdict) {
    await writeJsonArtifact({
      filePath: layout.profile.budgetVerdict,
      value: budgetVerdict,
      schema: SCHEMAS.budgetVerdict,
      label: 'Budget verdict artifact',
    });
  }
  await writeTextArtifact({
    filePath: layout.profile.summary,
    content: summary,
  });
  if (eventLogPath) {
    await fsp.copyFile(eventLogPath, path.join(rawDir, path.basename(eventLogPath)));
  }
  if (profileSessionEntriesPath) {
    await fsp.copyFile(profileSessionEntriesPath, path.join(rawDir, path.basename(profileSessionEntriesPath)));
  }
  await copyAttachedEvidence(attachedEvidence.copies);

  return {
    runDir,
    health: finalHealth,
    verdict,
  };
}

/**
 * Runs a platform-specific profile CLI.
 *
 * @param {{argv: string[], binaryName: string, platform: ProfilePlatform, defaultDriver: string}} options
 * @returns {Promise<void>}
 */
async function runProfileCli({
  argv,
  binaryName,
  defaultDriver,
  platform,
}: {
  argv: string[];
  binaryName: string;
  defaultDriver: string;
  platform: ProfilePlatform;
}): Promise<void> {
  const args = parseArgs(argv);
  if (typeof args.config !== 'string' || typeof args.scenario !== 'string') {
    usage({ binaryName, platform });
    process.exitCode = 1;
    return;
  }

  const result = await runProfileMobile(args, { defaultDriver, platform });
  process.stdout.write(`${result.runDir}\n`);
}

export {
  buildProfileHealth,
  buildProviderCommandFailureHealth,
  buildProfileVerdict,
  buildVerdictBudgetChecks,
  parseArgs,
  buildEvidenceAttachmentManifest,
  readScalarArg,
  resolveAppId,
  resolveArtifactRoot,
  resolveAttachedEvidence,
  resolveComparisonLane,
  resolveEventLogPath,
  resolveInteractionDriver,
  resolveProfileScenarioName,
  runProfileCompatibilityPreflight,
  runProfileCli,
  runProfileMobile,
  hashScenarioContract,
  usage,
};

export type {
  CliArgs,
  ProfileMobileOptions,
  ProfilePlatform,
  ProfileRunResult,
};
