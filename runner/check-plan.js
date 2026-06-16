#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  evaluateRunnerCompatibility,
} = require('../core/planner');
const {
  SCHEMAS,
  SchemaValidationError,
  assertValidJson,
} = require('../core/schema-validator');

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage() {
  console.error(
    [
      'Usage: node runner/check-plan.js --scenario <path> --runner <path> [--provider <path> ...] [--platform <ios|android>] [--run-id <id>] [--out <dir>]',
      '',
      'Writes health.json and verdict.json to --out when provided.',
      'Without --out, prints the planned artifacts as JSON.',
    ].join('\n'),
  );
}

/**
 * Parses the small flag surface for the plan-check CLI.
 *
 * @param {string[]} argv
 * @returns {{providers: string[], [key: string]: string | boolean | string[]}}
 */
function parseArgs(argv) {
  const args = {
    providers: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    if (key === 'provider') {
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        args.providers.push(value);
        index += 1;
      }
      continue;
    }

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
 * Reads a JSON file and reports parse failures with the manifest label.
 *
 * @param {string} filePath
 * @param {string} [label]
 * @returns {unknown}
 */
function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const prefix = label ? `${label} ` : '';
    throw new Error(`${prefix}could not be parsed as JSON: ${filePath}\n${error.message}`);
  }
}

/**
 * Reads a JSON file and validates it against a public contract schema.
 *
 * @param {string} filePath
 * @param {Record<string, unknown>} schema
 * @param {string} label
 * @returns {unknown}
 */
function readValidatedJson(filePath, schema, label) {
  return assertValidJson(readJson(filePath, label), schema, label);
}

/**
 * Writes a stable, newline-terminated JSON artifact.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @returns {Promise<void>}
 */
async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Creates a short random run id for ad-hoc plan checks.
 *
 * @returns {string}
 */
function createRunId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Builds pre-execution planner artifacts from validated scenario and runner manifests.
 *
 * @param {{scenarioPath: string, runnerPath: string, providerPaths?: string[], platform?: string | null, runId?: string}} options
 * @returns {Promise<{compatibility: Record<string, unknown>, health: Record<string, unknown>, verdict: Record<string, unknown>}>}
 */
async function buildPlanArtifacts({
  scenarioPath,
  runnerPath,
  providerPaths = [],
  platform = null,
  runId = createRunId(),
}) {
  const scenario = readValidatedJson(
    path.resolve(scenarioPath),
    SCHEMAS.scenario,
    'Scenario manifest',
  );
  const runner = readValidatedJson(
    path.resolve(runnerPath),
    SCHEMAS.runnerCapabilities,
    'Runner capability manifest',
  );
  const evidenceProviders = providerPaths.map((providerPath, index) =>
    readValidatedJson(
      path.resolve(providerPath),
      SCHEMAS.runnerCapabilities,
      `Evidence provider manifest ${index + 1}`,
    ),
  );
  const compatibility = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders,
    platform,
  });
  const health = buildCompatibilityHealth({
    scenario,
    runId,
    compatibility,
  });
  const verdict = buildUnevaluatedVerdict({
    scenario,
    runId,
    health,
  });
  assertValidJson(health, SCHEMAS.health, 'Health artifact');
  assertValidJson(verdict, SCHEMAS.verdict, 'Verdict artifact');

  return {
    compatibility,
    health,
    verdict,
  };
}

/**
 * Runs the check-plan CLI.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scenario || !args.runner) {
    usage();
    process.exitCode = 1;
    return;
  }

  const artifacts = await buildPlanArtifacts({
    scenarioPath: args.scenario,
    runnerPath: args.runner,
    providerPaths: args.providers,
    platform: typeof args.platform === 'string' ? args.platform : null,
    runId: typeof args['run-id'] === 'string' ? args['run-id'] : undefined,
  });

  if (typeof args.out === 'string' && args.out.length > 0) {
    const outputDir = path.resolve(args.out);
    await fsp.mkdir(outputDir, { recursive: true });
    await writeJson(path.join(outputDir, 'health.json'), artifacts.health);
    await writeJson(path.join(outputDir, 'verdict.json'), artifacts.verdict);
    await writeJson(path.join(outputDir, 'planner-compatibility.json'), artifacts.compatibility);
    process.stdout.write(`${outputDir}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(artifacts, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof SchemaValidationError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
}

module.exports = {
  buildPlanArtifacts,
  parseArgs,
};
