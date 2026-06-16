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
  sortValue,
} = require('../core/artifact-contract');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { writeUsage } = require('./cli');

type CliArgs = {
  'adb-artifacts'?: string | boolean;
  config?: string | boolean;
  scenario?: string | boolean;
  events?: string | boolean;
  out?: string | boolean;
  'run-id'?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type ProfileRunResult = {
  runDir: string;
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
};
type ProfilePlatform = 'android' | 'ios';
type ProfileMobileOptions = {
  defaultDriver: string;
  platform: ProfilePlatform;
};

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
    `Reads scenario metadata plus profile-event logs and writes the artifact layout for one ${platform} log-ingest run.`,
  ];
  if (platform === 'android') {
    lines.push('Use --adb-artifacts <dir> to read raw/adb-logcat.txt from a prior asl-android-adb capture.');
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
 * Writes a stable, newline-terminated JSON artifact.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.writeFile(filePath, `${JSON.stringify(sortValue(value), null, 2)}\n`, 'utf8');
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
  const rawDir = path.join(runDir, 'raw');
  const capturesDir = path.join(runDir, 'captures');
  const signalsDir = path.join(runDir, 'signals');
  const startedAt = new Date().toISOString();
  const eventLogPath = resolveEventLogPath({ args, platform: options.platform });

  await ensureDir(rawDir);
  await ensureDir(capturesDir);
  await ensureDir(path.join(signalsDir, 'js'));
  await ensureDir(path.join(signalsDir, 'memory'));
  await ensureDir(path.join(signalsDir, 'network'));

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
  });

  const manifest = buildManifest({
    scenario: scenario.name,
    runId,
    platform: options.platform,
    status: metrics.status,
    endedAt: new Date().toISOString(),
    interactionDriver: scenario.interactionDriver || config.drivers?.default || options.defaultDriver,
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
      scenario: toPortablePathReference(scenarioPath),
      raw: {
        interactionLog: eventLogPath ? `raw/${path.basename(eventLogPath)}` : 'raw/interaction.log',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
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
    interactionDriver: scenario.interactionDriver || config.drivers?.default || options.defaultDriver,
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
  await writeJson(path.join(runDir, 'manifest.json'), manifest);
  await writeJson(path.join(runDir, 'metrics.json'), metrics);
  await writeJson(path.join(runDir, 'causal-run.json'), causalRun);
  if (budgetVerdict) {
    await writeJson(path.join(runDir, 'budget-verdict.json'), budgetVerdict);
  }
  await fsp.writeFile(path.join(runDir, 'summary.md'), summary, 'utf8');
  if (eventLogPath) {
    await fsp.copyFile(eventLogPath, path.join(rawDir, path.basename(eventLogPath)));
  }

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
  resolveAppId,
  resolveArtifactRoot,
  resolveEventLogPath,
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
