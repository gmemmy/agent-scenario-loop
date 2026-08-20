#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { assertScenarioExecutionContractSupported } = require('../core/claim-contract');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
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
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  providers: string[];
  scenario?: string | boolean;
  runner?: string | boolean;
  platform?: string | boolean;
  out?: string | boolean;
  'run-id'?: string | boolean;
  [key: string]: string | boolean | string[] | undefined;
};

type PlanArtifacts = {
  compatibility: Record<string, unknown>;
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
  agentSummary: string;
};

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr) {
  writeUsage([
    'Usage: agent-scenario-loop --scenario <path> --runner <path> [--provider <path> ...] [--platform <ios|android>] [--run-id <id>] [--out <dir>]',
    '',
    'Aliases: asl-check-plan',
    'Writes health.json and verdict.json to --out when provided.',
    'Without --out, prints the planned artifacts as JSON.',
  ], output);
}

/**
 * Parses the small flag surface for the plan-check CLI.
 *
 * @param {string[]} argv
 * @returns {{providers: string[], [key: string]: string | boolean | string[]}}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    providers: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
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
function readJson(filePath: string, label?: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const prefix = label ? `${label} ` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${prefix}could not be parsed as JSON: ${filePath}\n${message}`);
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
function readValidatedJson(filePath: string, schema: Record<string, unknown>, label: string): Record<string, unknown> {
  return assertValidJson(readJson(filePath, label), schema, label);
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
 * @returns {Promise<{compatibility: Record<string, unknown>, health: Record<string, unknown>, verdict: Record<string, unknown>, agentSummary: string}>}
 */
async function buildPlanArtifacts({
  scenarioPath,
  runnerPath,
  providerPaths = [],
  platform = null,
  runId = createRunId(),
}: {
  scenarioPath: string;
  runnerPath: string;
  providerPaths?: string[];
  platform?: string | null;
  runId?: string;
}): Promise<PlanArtifacts> {
  const scenario = readValidatedJson(
    path.resolve(scenarioPath),
    SCHEMAS.scenario,
    'Scenario manifest',
  );
  assertScenarioExecutionContractSupported(scenario);
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
  const agentSummary = buildAgentSummaryMarkdown({
    health,
    verdict,
  });
  assertValidJson(health, SCHEMAS.health, 'Health artifact');
  assertValidJson(verdict, SCHEMAS.verdict, 'Verdict artifact');

  return {
    agentSummary,
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
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const args = parseArgs(argv);
  if (typeof args.scenario !== 'string' || typeof args.runner !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  const artifacts = await buildPlanArtifacts({
    scenarioPath: args.scenario,
    runnerPath: args.runner,
    providerPaths: args.providers,
    platform: typeof args.platform === 'string' ? args.platform : null,
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
  });

  if (typeof args.out === 'string' && args.out.length > 0) {
    const outputDir = path.resolve(args.out);
    const layout = createArtifactLayout({ outputDir });
    await writeJsonArtifact({
      filePath: layout.health,
      value: artifacts.health,
      schema: SCHEMAS.health,
      label: 'Health artifact',
    });
    await writeJsonArtifact({
      filePath: layout.verdict,
      value: artifacts.verdict,
      schema: SCHEMAS.verdict,
      label: 'Verdict artifact',
    });
    await writeJsonArtifact({
      filePath: layout.plannerCompatibility,
      value: artifacts.compatibility,
      schema: {
        type: 'object',
        additionalProperties: true,
      },
      label: 'Planner compatibility artifact',
    });
    await writeTextArtifact({
      filePath: layout.agentSummary,
      content: artifacts.agentSummary,
    });
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

export {
  buildPlanArtifacts,
  parseArgs,
  usage,
};
