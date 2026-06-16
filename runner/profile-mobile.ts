#!/usr/bin/env node

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
  defaultDriver: string;
  interactionDriver?: string;
  platform: ProfilePlatform;
};
type CaptureEvidenceKind = 'screenshot' | 'uiTree' | 'video';
type SignalEvidenceKind = 'js' | 'memory' | 'network';
type EvidenceAttachment = {
  destinationPath: string;
  kind: CaptureEvidenceKind | SignalEvidenceKind;
  manifestPath: string;
  sourcePath: string;
};
type AttachedEvidence = {
  captures: {
    screenshots: string[];
    uiTree: string | null;
    video: string | null;
  };
  copies: EvidenceAttachment[];
  signals: Record<SignalEvidenceKind, string[]>;
};

const CAPTURE_EVIDENCE_KINDS = new Set(['screenshot', 'uiTree', 'video']);
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
    'Use repeated --signal <js|memory|network>:<path> to attach provider signal artifacts.',
    'Use repeated --capture <screenshot|video|uiTree>:<path> to attach named capture artifacts.',
  ];
  if (platform === 'android') {
    lines.push('Use --adb-artifacts <dir> to read raw/adb-logcat.txt from a prior asl-android-adb capture.');
    lines.push('Use --adb-capture [--clear-logcat] [--launch] [--wait-ms <ms>] to capture adb logcat before profiling.');
    lines.push('Use --profile-session with --adb-capture to start the app profile session and execute scenario-declared Android commands.');
  } else {
    lines.push('Use --simctl-artifacts <dir> to read raw/ios-simctl-log.txt from a prior iOS simctl capture.');
    lines.push('Use --simctl-capture [--launch] [--wait-ms <ms>] to capture iOS simulator logs before profiling.');
    lines.push('Use --profile-session with --simctl-capture to start the app profile session and execute scenario-declared iOS commands.');
    lines.push('Use --profile-session-storage with --profile-session to seed startup control through iOS AsyncStorage and collect stored truth events.');
  }

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
 * Validates provider artifact files and resolves their stable run destinations.
 *
 * @param {{args: CliArgs, layout: ReturnType<typeof createArtifactLayout>}} options
 * @returns {Promise<AttachedEvidence>}
 */
async function resolveAttachedEvidence({
  args,
  layout,
}: {
  args: CliArgs;
  layout: ReturnType<typeof createArtifactLayout>;
}): Promise<AttachedEvidence> {
  const attached: AttachedEvidence = {
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
    destinationPath,
    kind,
    manifestPath,
    sourcePath,
  }: EvidenceAttachment): Promise<void> => {
    const stat = await fsp.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`Evidence artifact does not exist or is not a file: ${sourcePath}`);
    }

    if (destinationPaths.has(destinationPath)) {
      throw new Error(`Duplicate evidence artifact destination: ${manifestPath}`);
    }

    destinationPaths.add(destinationPath);
    attached.copies.push({ destinationPath, kind, manifestPath, sourcePath });
  };

  for (const value of readRepeatableArgValues(args, 'signal')) {
    const parsed = parseEvidenceArg({
      allowedKinds: SIGNAL_EVIDENCE_KINDS,
      argName: 'signal',
      value,
    }) as { kind: SignalEvidenceKind; sourcePath: string };
    const fileName = path.basename(parsed.sourcePath);
    const manifestPath = `signals/${parsed.kind}/${fileName}`;
    attached.signals[parsed.kind].push(manifestPath);
    await addCopy({
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
      attached.captures.screenshots.push(manifestPath);
      await addCopy({
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

    attached.captures[parsed.kind] = manifestPath;
    await addCopy({
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
  const runId = typeof args['run-id'] === 'string' ? args['run-id'] : createRunId();
  const artifactRoot = resolveArtifactRoot({ args, config, configPath, platform: options.platform });
  const runDir = path.join(artifactRoot, scenario.name, runId);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = layout.raw;
  const capturesDir = layout.captures;
  const startedAt = new Date().toISOString();
  const eventLogPath = resolveEventLogPath({ args, platform: options.platform });
  const interactionDriver = resolveInteractionDriver({ config, options, scenario });

  await ensureDir(rawDir);
  await ensureDir(capturesDir);
  await ensureDir(layout.signals.js);
  await ensureDir(layout.signals.memory);
  await ensureDir(layout.signals.network);
  const attachedEvidence = await resolveAttachedEvidence({ args, layout });

  const eventLogText = eventLogPath ? await fsp.readFile(eventLogPath, 'utf8') : '';
  const events = extractProfileEvents(eventLogText, {
    scenario: scenario.name,
    runId,
  });

  const metrics = buildMetricsFromProfileEvents({
    scenario: scenario.name,
    runId,
    events,
    expectedIterations: scenario.defaultIterations ?? 1,
    budgets: scenario.budgets ?? null,
    cycleEventNames: scenario.metricEvents ?? null,
    artifacts: {
      captures: attachedEvidence.captures,
      signals: attachedEvidence.signals,
    },
  });

  const manifest = buildManifest({
    scenario: scenario.name,
    runId,
    platform: options.platform,
    status: metrics.status,
    endedAt: new Date().toISOString(),
    interactionDriver,
    startedAt,
    simulator: {
      name: options.platform === 'android' ? 'unknown android device' : 'unknown',
      udid: 'unknown',
    },
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
    },
  });

  const timeline = buildCausalTimeline({
    events,
    startedAt,
    phaseMap: scenario.timelinePhases ?? null,
    owner: scenario.flowId ?? scenario.name,
  });

  const causalRun = buildCausalRun({
    scenario,
    flowId: scenario.flowId ?? scenario.name,
    runId,
    platform: options.platform,
    buildFlavor: 'unknown',
    interactionDriver,
    trigger: scenario.trigger ?? null,
    budgets: scenario.budgets?.pass ?? null,
    timeline,
    artifacts: manifest.artifacts,
    manifest,
    metrics,
  });

  const budgetVerdict = buildBudgetVerdict({
    flowId: scenario.flowId ?? scenario.name,
    runId,
    budgetEvaluation: metrics.budgetEvaluation ?? null,
  });

  const health = buildProfileHealth({ scenario, runId, metrics });
  const verdict = buildProfileVerdict({ scenario, runId, health, metrics });
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
  buildProfileVerdict,
  buildVerdictBudgetChecks,
  parseArgs,
  readScalarArg,
  resolveAppId,
  resolveArtifactRoot,
  resolveAttachedEvidence,
  resolveEventLogPath,
  resolveInteractionDriver,
  runProfileCli,
  runProfileMobile,
  usage,
};

export type {
  CliArgs,
  ProfileMobileOptions,
  ProfilePlatform,
  ProfileRunResult,
};
