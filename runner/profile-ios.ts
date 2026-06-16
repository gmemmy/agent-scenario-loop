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

type CliArgs = {
  config?: string;
  scenario?: string;
  events?: string;
  out?: string;
  'run-id'?: string;
  [key: string]: string | undefined;
};

type ProfileRunResult = {
  runDir: string;
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
};

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage() {
  console.error(
    'Usage: node runner/profile-ios.js --config <path> --scenario <path> [--events <path>] [--out <dir>] [--run-id <id>]',
  );
}

/**
 * Parses `--key value` arguments for the iOS profile runner.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
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
    args[key] = value;
    index += 1;
  }
  return args;
}

/**
 * Reads and parses a JSON file.
 *
 * @param {string} filePath
 * @returns {unknown}
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
 * Builds v1 scenario health from profile metrics.
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
 * Converts profile budget evaluation checks into v1 verdict budget checks.
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
 * Builds v1 product verdict from profile metrics and budget evaluation.
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
 * Runs the iOS log-ingest profile artifact pipeline.
 *
 * @param {CliArgs} args
 * @returns {Promise<ProfileRunResult>}
 */
async function runProfileIos(args: CliArgs): Promise<ProfileRunResult> {
  if (!args.config || !args.scenario) {
    throw new Error('Both --config and --scenario are required.');
  }

  const configPath = path.resolve(args.config);
  const scenarioPath = path.resolve(args.scenario);
  const config = readJson(configPath);
  const scenario = readJson(scenarioPath);
  const runId = args['run-id'] || createRunId();
  const artifactRoot = path.resolve(
    args.out || path.join(path.dirname(configPath), config.paths?.iosArtifactsRoot || 'artifacts/ios'),
  );
  const runDir = path.join(artifactRoot, scenario.name, runId);
  const layout = createArtifactLayout({ outputDir: runDir });
  const rawDir = path.join(runDir, 'raw');
  const capturesDir = path.join(runDir, 'captures');
  const signalsDir = path.join(runDir, 'signals');
  const startedAt = new Date().toISOString();

  await ensureDir(rawDir);
  await ensureDir(capturesDir);
  await ensureDir(path.join(signalsDir, 'js'));
  await ensureDir(path.join(signalsDir, 'memory'));
  await ensureDir(path.join(signalsDir, 'network'));

  const eventLogText = args.events ? await fsp.readFile(path.resolve(args.events), 'utf8') : '';
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
    platform: 'ios',
    status: metrics.status,
    endedAt: new Date().toISOString(),
    interactionDriver: scenario.interactionDriver || config.drivers?.default || 'xcodebuildmcp',
    startedAt,
    simulator: {
      name: 'unknown',
      udid: 'unknown',
    },
    bundleId: config.app?.iosBundleId || 'com.example.app',
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
        interactionLog: args.events ? `raw/${path.basename(args.events)}` : 'raw/interaction.log',
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
    platform: 'ios',
    buildFlavor: 'unknown',
    interactionDriver: scenario.interactionDriver || config.drivers?.default || 'xcodebuildmcp',
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
  if (args.events) {
    await fsp.copyFile(path.resolve(args.events), path.join(rawDir, path.basename(args.events)));
  }

  return {
    runDir,
    health,
    verdict,
  };
}

/**
 * Runs the profile-ios CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args.scenario) {
    usage();
    process.exitCode = 1;
    return;
  }

  const result = await runProfileIos(args);
  process.stdout.write(`${result.runDir}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildProfileHealth,
  buildProfileVerdict,
  buildVerdictBudgetChecks,
  main,
  parseArgs,
  runProfileIos,
};

export type {
  CliArgs,
  ProfileRunResult,
};
