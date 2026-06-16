#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
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
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
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
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Creates a directory and any missing parents.
 *
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

/**
 * Writes a stable, newline-terminated JSON artifact.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function writeJson(filePath, value) {
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
function toPortablePathReference(targetPath) {
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
 * Runs the iOS log-ingest profile artifact pipeline.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args.scenario) {
    usage();
    process.exitCode = 1;
    return;
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

  const summary = buildSummaryMarkdown({ manifest, metrics });

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

  process.stdout.write(`${runDir}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
