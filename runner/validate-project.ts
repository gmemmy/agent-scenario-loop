#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');
const { buildPlanArtifacts } = require('./check-plan');

type CliArgs = {
  out?: string | boolean;
  platform?: string | boolean;
  root?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type ProjectValidationPlan = {
  healthStatus: string;
  platform: string;
  runId: string;
  scenarioId: string;
  scenarioPath: string;
};

type ProjectValidationAppHelper = {
  missingExports: string[];
  path: string;
  status: 'present' | 'missing' | 'incomplete';
};

type ProjectValidationResult = {
  appHelper: ProjectValidationAppHelper;
  configPath: string;
  errors: string[];
  platform: string;
  plans: ProjectValidationPlan[];
  providerPaths: string[];
  rootDir: string;
  runnerPath: string;
  scenarioPaths: string[];
  status: 'passed' | 'failed';
};

const REQUIRED_APP_HELPER_EXPORTS = [
  'emitProfileEvent',
  'registerProfileCommandTargetHandler',
  'useProfileSessionBootstrap',
];

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-validate-project [--root <dir>] [--platform <ios|android|all>] [--out <dir>]',
    '',
    'Validates an initialized Agent Scenario Loop project before live device execution.',
    'Checks config presence, scenario manifests, runner manifests, and planner compatibility.',
  ], output);
}

/**
 * Parses the small flag set for the project validator.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
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
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Lists sorted JSON files from a directory, returning an empty list when absent.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function listJsonFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
    .filter((name: string) => name.endsWith('.json'))
    .sort()
    .map((name: string) => path.join(directory, name));
}

/**
 * Resolves platforms that should be validated for one scenario.
 *
 * @param {{requestedPlatform: string, scenario: Record<string, unknown>}} options
 * @returns {string[]}
 */
function resolvePlatforms({
  requestedPlatform,
  scenario,
}: {
  requestedPlatform: string;
  scenario: Record<string, unknown>;
}): string[] {
  if (requestedPlatform !== 'all') {
    return [requestedPlatform];
  }

  const platforms = Array.isArray(scenario.platforms)
    ? scenario.platforms.filter((platform): platform is string => typeof platform === 'string')
    : [];
  return platforms.length > 0 ? platforms : ['ios', 'android'];
}

/**
 * Builds a stable run id for one project-validation plan check.
 *
 * @param {{platform: string, scenarioId: string}} options
 * @returns {string}
 */
function buildValidationRunId({
  platform,
  scenarioId,
}: {
  platform: string;
  scenarioId: string;
}): string {
  return `validate-${platform}-${scenarioId}`;
}

/**
 * Validates that the generated app helper is present and still exposes the expected integration API.
 *
 * @param {string} rootDir
 * @returns {ProjectValidationAppHelper}
 */
function validateAppHelper(rootDir: string): ProjectValidationAppHelper {
  const helperPath = path.join(rootDir, 'src', 'devtools', 'profile-session.ts');
  if (!fs.existsSync(helperPath)) {
    return {
      missingExports: REQUIRED_APP_HELPER_EXPORTS,
      path: helperPath,
      status: 'missing',
    };
  }

  const source = fs.readFileSync(helperPath, 'utf8');
  const missingExports = REQUIRED_APP_HELPER_EXPORTS.filter((exportName) => !source.includes(exportName));
  return {
    missingExports,
    path: helperPath,
    status: missingExports.length > 0 ? 'incomplete' : 'present',
  };
}

/**
 * Validates a generated or hand-authored Agent Scenario Loop project.
 *
 * @param {{rootDir?: string, platform?: string}} [options]
 * @returns {Promise<ProjectValidationResult>}
 */
async function validateProject(options: {
  rootDir?: string;
  platform?: string;
} = {}): Promise<ProjectValidationResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const requestedPlatform = options.platform ?? 'all';
  const configPath = path.join(rootDir, 'asl.config.json');
  const runnerPath = path.join(rootDir, 'runner-manifests', 'primary-runner.json');
  const providerPaths = listJsonFiles(path.join(rootDir, 'runner-manifests'))
    .filter((filePath) => path.basename(filePath) !== 'primary-runner.json');
  const scenarioPaths = listJsonFiles(path.join(rootDir, 'scenarios', 'mobile'));
  const appHelper = validateAppHelper(rootDir);
  const errors: string[] = [];
  const plans: ProjectValidationPlan[] = [];

  if (!['ios', 'android', 'all'].includes(requestedPlatform)) {
    errors.push(`Unsupported platform '${requestedPlatform}'. Expected ios, android, or all.`);
  }

  if (!fs.existsSync(configPath)) {
    errors.push(`Missing config: ${configPath}`);
  } else {
    readJson(configPath);
  }

  if (!fs.existsSync(runnerPath)) {
    errors.push(`Missing primary runner manifest: ${runnerPath}`);
  }

  if (scenarioPaths.length === 0) {
    errors.push(`No scenario manifests found under ${path.join(rootDir, 'scenarios', 'mobile')}.`);
  }

  if (appHelper.status === 'missing') {
    errors.push(`Missing app profile-session helper: ${appHelper.path}`);
  } else if (appHelper.status === 'incomplete') {
    errors.push(`App profile-session helper is missing export(s): ${appHelper.missingExports.join(', ')}.`);
  }

  if (errors.length === 0) {
    for (const scenarioPath of scenarioPaths) {
      const scenario = readJson(scenarioPath);
      const scenarioId = typeof scenario.id === 'string' ? scenario.id : path.basename(scenarioPath, '.json');
      for (const platform of resolvePlatforms({ requestedPlatform, scenario })) {
        const runId = buildValidationRunId({ platform, scenarioId });
        const artifacts = await buildPlanArtifacts({
          scenarioPath,
          runnerPath,
          providerPaths,
          platform,
          runId,
        });
        const healthStatus = String(artifacts.health.healthStatus ?? 'unknown');
        plans.push({
          healthStatus,
          platform,
          runId,
          scenarioId,
          scenarioPath,
        });
        if (healthStatus !== 'passed') {
          errors.push(`${scenarioId} is incompatible on ${platform}; healthStatus=${healthStatus}.`);
        }
      }
    }
  }

  return {
    appHelper,
    configPath,
    errors,
    platform: requestedPlatform,
    plans,
    providerPaths,
    rootDir,
    runnerPath,
    scenarioPaths,
    status: errors.length > 0 ? 'failed' : 'passed',
  };
}

/**
 * Formats project validation output for humans and agents.
 *
 * @param {ProjectValidationResult} result
 * @returns {string}
 */
function formatResult(result: ProjectValidationResult): string {
  return [
    `Agent Scenario Loop project validation ${result.status}.`,
    `Root: ${result.rootDir}`,
    `Config: ${result.configPath}`,
    `App helper: ${result.appHelper.status}`,
    `Scenarios: ${result.scenarioPaths.length}`,
    `Providers: ${result.providerPaths.length}`,
    ...(result.plans.length > 0
      ? [
        'Plans:',
        ...result.plans.map((plan) => `- ${plan.platform} ${plan.scenarioId}: ${plan.healthStatus}`),
      ]
      : []),
    ...(result.errors.length > 0
      ? [
        'Errors:',
        ...result.errors.map((error) => `- ${error}`),
      ]
      : []),
  ].join('\n');
}

/**
 * Runs the project validation CLI.
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
  const result = await validateProject({
    ...(typeof args.root === 'string' ? { rootDir: args.root } : {}),
    ...(typeof args.platform === 'string' ? { platform: args.platform } : {}),
  });

  if (typeof args.out === 'string' && args.out.length > 0) {
    const outDir = path.resolve(args.out);
    await fsp.mkdir(outDir, { recursive: true });
    await writeJsonArtifact({
      filePath: path.join(outDir, 'project-validation.json'),
      value: result,
      schema: SCHEMAS.projectValidation,
      label: 'Project validation artifact',
    });
    await writeTextArtifact({
      filePath: path.join(outDir, 'agent-summary.md'),
      content: `${formatResult(result)}\n`,
    });
  }

  process.stdout.write(`${formatResult(result)}\n`);
  if (result.status !== 'passed') {
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
  buildValidationRunId,
  formatResult,
  main,
  parseArgs,
  resolvePlatforms,
  usage,
  validateProject,
  validateAppHelper,
};

export type {
  CliArgs,
  ProjectValidationAppHelper,
  ProjectValidationPlan,
  ProjectValidationResult,
};
