#!/usr/bin/env node

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const {
  buildBudgetVerdict,
  buildCausalRun,
  buildCausalTimeline,
  buildManifest,
  buildMetricsFromProfileEvents,
  buildSummaryMarkdown,
  extractProfileEvents,
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
  'run-id'?: string | boolean;
  signal?: CliArgValue;
  [key: string]: CliArgValue | undefined;
};

type ProfileRunResult = {
  runDir: string;
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
};
type ProfilePlatform = 'android' | 'ios';
type ProfileMobileOptions = {
  comparisonLane?: string;
  defaultDriver: string;
  interactionDriver?: string;
  platform: ProfilePlatform;
};
type CaptureEvidenceKind = 'screenshot' | 'uiTree' | 'video';
type ProviderEvidenceKind = 'accessibility' | 'logs' | 'profiler';
type SignalEvidenceKind = 'js' | 'memory' | 'network';
type EvidenceChannel = 'capture' | 'provider' | 'signal';
type EvidenceKind = CaptureEvidenceKind | ProviderEvidenceKind | SignalEvidenceKind;
type EvidenceAttachment = {
  channel: EvidenceChannel;
  destinationPath: string;
  kind: EvidenceKind;
  manifestPath: string;
  sha256: string;
  sourcePath: string;
  sourceFileName: string;
  sizeBytes: number;
};
type EvidenceAttachmentInput = {
  channel: EvidenceChannel;
  destinationPath: string;
  kind: EvidenceKind;
  manifestPath: string;
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
type ProviderCommandOutput = {
  channel: EvidenceChannel;
  kind: EvidenceKind;
  path: string;
};
type ProviderCommand = {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  id: string;
  outputs: ProviderCommandOutput[];
  phase: 'prepare' | 'startWindow' | 'capture' | 'stopWindow' | 'finalize';
};
type ProviderManifest = {
  kind?: string;
  platforms?: string[];
  providerCommands?: ProviderCommand[];
  runnerId?: string;
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
  stderr: string;
  stdout: string;
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
type ProviderCommandExecution = {
  failures: ProviderCommandFailure[];
  inputs: EvidenceAttachmentInput[];
};
type ExecFileError = Error & {
  code?: number;
};

const CAPTURE_EVIDENCE_KINDS = new Set(['screenshot', 'uiTree', 'video']);
const PROVIDER_EVIDENCE_KINDS = new Set(['accessibility', 'logs', 'profiler']);
const SIGNAL_EVIDENCE_KINDS = new Set(['js', 'memory', 'network']);

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
    lines.push('Use --adb-capture [--clear-logcat] [--launch] [--launch-wait-ms <ms>] [--wait-ms <ms>] to capture adb logcat before profiling.');
    lines.push('Use --profile-session with --adb-capture to start the app profile session and execute scenario-declared Android commands.');
  } else {
    lines.push('Use --simctl-artifacts <dir> to read raw/ios-simctl-log.txt from a prior iOS simctl capture.');
    lines.push('Use --simctl-capture [--launch] [--wait-ms <ms>] to capture iOS simulator logs before profiling.');
    lines.push('Use --profile-session with --simctl-capture to start the app profile session and execute scenario-declared iOS commands.');
    lines.push('Use --profile-session-storage with --profile-session to seed startup control through iOS AsyncStorage and collect stored truth events.');
  }
  lines.push('Use --agent-device-capture to execute scenario-declared portable driver actions through agent-device and attach its captures.');
  lines.push('Use --agent-device-session-mode bind when a named agent-device session should still receive the configured Android serial or iOS UDID.');

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
 * Runs one provider command without a shell and captures its output.
 *
 * @param {{command: string, args: string[], cwd?: string, env?: Record<string, string>}} options
 * @returns {Promise<ProviderCommandResult>}
 */
function execProviderCommand({
  args,
  command,
  cwd,
  env,
}: {
  args: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<ProviderCommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, {
      ...(cwd ? { cwd } : {}),
      env: env ? { ...process.env, ...env } : process.env,
    }, (error: ExecFileError | null, stdout: string, stderr: string) => {
      resolve({
        args,
        command,
        exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stderr,
        stdout,
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
    sourcePath,
  };
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
  const providerManifestPaths = readRepeatableArgValues(args, 'provider');
  if (providerManifestPaths.length === 0) {
    return { failures, inputs };
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
      const resolvedCommand = applyProviderPlaceholders(providerCommand.command, context);
      const resolvedArgs = (providerCommand.args ?? []).map((arg) => applyProviderPlaceholders(arg, context));
      const resolvedCwd = providerCommand.cwd
        ? resolveProviderPath({ context, manifestDir, value: providerCommand.cwd })
        : manifestDir;
      const resolvedEnv = Object.fromEntries(
        Object.entries(providerCommand.env ?? {}).map(([key, value]) => [key, applyProviderPlaceholders(value, context)]),
      );
      const commandResult = await execProviderCommand({
        args: resolvedArgs,
        command: resolvedCommand,
        cwd: resolvedCwd,
        env: resolvedEnv,
      });
      const commandRecordFileName = `${providerId}-${providerCommand.id}.json`;
      const commandRecordPath = path.join(commandRecordDir, commandRecordFileName);
      await fsp.writeFile(
        commandRecordPath,
        `${JSON.stringify({
          args: commandResult.args,
          command: commandResult.command,
          exitCode: commandResult.exitCode,
          phase: providerCommand.phase,
          providerId,
          stderr: commandResult.stderr,
          stdout: commandResult.stdout,
        }, null, 2)}\n`,
        'utf8',
      );
      if (commandResult.exitCode !== 0) {
        failures.push({
          commandId: providerCommand.id,
          code: 'provider_command_failed',
          exitCode: commandResult.exitCode,
          message: `Evidence provider command ${providerId}/${providerCommand.id} failed with exit code ${commandResult.exitCode}.`,
          name: 'evidence_provider_command_completed',
          nextAction: `Inspect raw/provider-commands/${commandRecordFileName}, fix the provider command or its environment, then rerun the profile.`,
          nextActionCode: 'fix_provider_command',
          phase: providerCommand.phase,
          providerId,
          rawPath: `raw/provider-commands/${commandRecordFileName}`,
        });
        continue;
      }

      for (const output of providerCommand.outputs) {
        inputs.push(buildProviderEvidenceInput({
          layout,
          output,
          providerId,
          sourcePath: resolveProviderPath({ context, manifestDir, value: output.path }),
        }));
      }
    }
  }

  return { failures, inputs };
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
    kind: attachment.kind,
    path: attachment.manifestPath,
    sha256: attachment.sha256,
    sizeBytes: attachment.sizeBytes,
    sourceFileName: attachment.sourceFileName,
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
    sourcePath,
  }: EvidenceAttachmentInput): Promise<void> => {
    const stat = await fsp.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Evidence artifact does not exist or is not a file: ${sourcePath}`);
    }

    if (destinationPaths.has(destinationPath)) {
      throw new Error(`Duplicate evidence artifact destination: ${manifestPath}`);
    }

    destinationPaths.add(destinationPath);
    const attachment = {
      channel,
      destinationPath,
      kind,
      manifestPath,
      sha256: await hashFileSha256(sourcePath),
      sourceFileName: path.basename(sourcePath),
      sourcePath,
      sizeBytes: stat.size,
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
 * Builds scenario health from profile metrics.
 *
 * @param {{scenario: Record<string, unknown>, runId: string, metrics: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildProfileHealth({
  scenario,
  runId,
  metrics,
}: {
  scenario: Record<string, any>;
  runId: string;
  metrics: Record<string, any>;
}): Record<string, unknown> {
  const passed = metrics.status === 'passed';
  return assertValidJson(
    {
      schemaVersion: '1.0.0',
      scenarioId: scenario.name,
      ...(typeof scenario.flowId === 'string' ? { flowId: scenario.flowId } : {}),
      runId,
      healthStatus: passed ? 'passed' : 'failed',
      checks: [
        {
          name: 'truth_events_complete',
          status: passed ? 'passed' : 'failed',
          source: 'truth',
          code: passed ? 'truth_events_complete' : 'truth_events_incomplete',
          message: passed
            ? 'Profile events completed every expected iteration.'
            : 'Profile events did not complete every expected iteration.',
          metadata: {
            failures: typeof metrics.failures === 'number' ? metrics.failures : null,
            timeouts: typeof metrics.timeouts === 'number' ? metrics.timeouts : null,
          },
        },
      ],
    },
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
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
      checks: failures.map((failure) => ({
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
      })),
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
  const verdictStatus = !healthPassed
    ? 'inconclusive'
    : budgetEvaluation
      ? budgetEvaluation.pass
        ? 'passed'
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
          ? `Profile budgets ${budgetEvaluation.pass ? 'passed' : 'failed'}.`
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
 * Maps schema-era milestone budget fields to the legacy profile budget keys.
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
  for (const budget of scenario.budgets) {
    if (!isRecord(budget) || typeof budget.limit !== 'number') {
      continue;
    }

    if (budget.metric === 'p95' || budget.metric === 'p50') {
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

  return Object.keys(pass).length > 0
    ? {
        metric: 'milestone budget',
        pass,
      }
    : null;
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
  const profileBudgets = resolveProfileBudgets(profileScenario);
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const artifactRoot = resolveArtifactRoot({ args, config, configPath, platform: options.platform });
  const runDir = path.join(artifactRoot, scenarioName, runId);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  const capturesDir = layout.captures;
  const startedAt = new Date().toISOString();
  const eventLogPath = resolveEventLogPath({ args, platform: options.platform });
  const interactionDriver = resolveInteractionDriver({ config, options, scenario });
  const comparisonLane = resolveComparisonLane({ args, options, scenario });

  await ensureDir(rawDir);
  await ensureDir(capturesDir);
  await ensureDir(layout.signals.js);
  await ensureDir(layout.signals.memory);
  await ensureDir(layout.signals.network);
  const providerExecution = await executeProviderCommands({
    args,
    layout,
    platform: options.platform,
    runDir,
    runId,
    scenarioId: scenarioName,
  });
  if (providerExecution.failures.length > 0) {
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

  const attachedEvidence = await resolveAttachedEvidence({ args, layout, providerInputs: providerExecution.inputs });

  const eventLogText = eventLogPath ? await fsp.readFile(eventLogPath, 'utf8') : '';
  const events = extractProfileEvents(eventLogText, {
    scenario: scenarioName,
    runId,
  });
  const runtimeTarget = resolveRuntimeTarget({ args, platform: options.platform });

  const metrics = buildMetricsFromProfileEvents({
    scenario: scenarioName,
    runId,
    events,
    expectedIterations,
    budgets: profileBudgets,
    cycleEventNames: profileMetricEvents,
    artifacts: {
      captures: attachedEvidence.captures,
      signals: attachedEvidence.signals,
    },
  });

  const manifest = buildManifest({
    scenario: scenarioName,
    scenarioHash,
    runId,
    platform: options.platform,
    status: metrics.status,
    endedAt: new Date().toISOString(),
    interactionDriver,
    comparisonLane,
    startedAt,
    simulator: runtimeTarget,
    bundleId: resolveAppId({ config, platform: options.platform }),
    gitSha: 'unknown',
    toolVersions: {
      node: process.version,
    },
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: toPortablePathReference(scenarioPath),
      raw: {
        interactionLog: eventLogPath ? `raw/${path.basename(eventLogPath)}` : 'raw/interaction.log',
        deviceLog: 'raw/device.log',
      },
      captures: {
        screenshots: attachedEvidence.captures.screenshots,
        video: attachedEvidence.captures.video ?? 'captures/run.mp4',
        uiTree: attachedEvidence.captures.uiTree ?? 'captures/ui-tree.json',
      },
      signals: {
        js: attachedEvidence.signals.js,
        memory: attachedEvidence.signals.memory,
        network: attachedEvidence.signals.network,
      },
      evidenceAttachments: buildEvidenceAttachmentManifest(attachedEvidence.attachments),
    },
  });

  const timeline = buildCausalTimeline({
    events,
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

  const budgetVerdict = buildBudgetVerdict({
    flowId: scenario.flowId ?? scenarioName,
    runId,
    budgetEvaluation: metrics.budgetEvaluation ?? null,
  });

  const health = buildProfileHealth({ scenario: profileScenario, runId, metrics });
  const verdict = buildProfileVerdict({ scenario: profileScenario, runId, health, metrics });
  const agentSummary = buildAgentSummaryMarkdown({ health, verdict });
  const summary = buildSummaryMarkdown({ manifest, metrics });

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
  await copyAttachedEvidence(attachedEvidence.copies);

  return {
    runDir,
    health,
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
