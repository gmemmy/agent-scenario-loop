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

type ProjectValidationScripts = {
  missingPaths: string[];
  missingScripts: string[];
  path: string;
  scriptNames: string[];
  status: 'present' | 'missing' | 'incomplete';
  unknownCommands: string[];
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
  scripts: ProjectValidationScripts;
  scenarioPaths: string[];
  status: 'passed' | 'failed';
  warnings: string[];
};

const REQUIRED_APP_HELPER_EXPORTS = [
  'emitProfileEvent',
  'registerProfileCommandTargetHandler',
  'useProfileSessionBootstrap',
];

const REQUIRED_PACKAGE_SCRIPT_NAMES = [
  'asl:check:ios',
  'asl:check:android',
  'asl:validate',
  'asl:profile:ios',
  'asl:profile:android',
  'asl:compare:ios',
  'asl:compare:android',
  'asl:live-proof',
];

const PATH_ARGUMENT_FLAGS = new Set(['--config', '--runner', '--scenario']);

const CONFIG_PLACEHOLDER_VALUES = [
  {
    path: ['projectName'],
    values: ['replace-me'],
  },
  {
    path: ['app', 'displayName'],
    values: ['Example App'],
  },
  {
    path: ['app', 'scheme'],
    values: ['example-app'],
  },
  {
    path: ['app', 'profileSessionScheme'],
    values: ['example-app'],
  },
  {
    path: ['app', 'iosBundleId'],
    values: ['com.example.app'],
  },
  {
    path: ['app', 'androidPackage'],
    values: ['com.example.app'],
  },
  {
    path: ['app', 'ios', 'xcodeScheme'],
    values: ['Example App'],
  },
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
 * Reads a nested string property from an object.
 *
 * @param {Record<string, unknown>} source
 * @param {string[]} pathSegments
 * @returns {string | null}
 */
function readNestedString(source: Record<string, unknown>, pathSegments: string[]): string | null {
  let value: unknown = source;
  for (const segment of pathSegments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === 'string' ? value : null;
}

/**
 * Resolves the package root for bin-name checks from source or built CLI execution.
 *
 * @returns {string}
 */
function defaultPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
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
 * Finds known placeholder values in the initialized project config.
 *
 * @param {Record<string, unknown>} config
 * @returns {string[]}
 */
function validateConfigPlaceholders(config: Record<string, unknown>): string[] {
  return CONFIG_PLACEHOLDER_VALUES.flatMap((placeholder) => {
    const value = readNestedString(config, placeholder.path);
    if (value === null || !placeholder.values.includes(value)) {
      return [];
    }

    return [`Config field ${placeholder.path.join('.')} still uses placeholder value '${value}'.`];
  });
}

/**
 * Reads public package binary names from package.json.
 *
 * @param {string} packageRoot
 * @returns {Set<string>}
 */
function readPackageBinNames(packageRoot: string): Set<string> {
  const packageJson = readJson(path.join(packageRoot, 'package.json'));
  const bins = packageJson.bin;
  if (!bins || typeof bins !== 'object' || Array.isArray(bins)) {
    return new Set();
  }

  return new Set(Object.keys(bins));
}

/**
 * Splits the generated script snippets into tokens. The template intentionally avoids shell quoting.
 *
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeScript(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

/**
 * Returns true for concrete path-like script arguments while leaving ids and placeholders alone.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPathLikeArgument(value: string): boolean {
  return value.includes('/') || value.includes(path.sep) || /\.[a-z0-9]+$/iu.test(value);
}

/**
 * Validates the generated package-script snippets against installed CLI bins and project-local inputs.
 *
 * @param {{packageRoot?: string, rootDir: string}} options
 * @returns {ProjectValidationScripts}
 */
function validatePackageScripts({
  packageRoot = defaultPackageRoot(),
  rootDir,
}: {
  packageRoot?: string;
  rootDir: string;
}): ProjectValidationScripts {
  const scriptPath = path.join(rootDir, 'asl', 'package-scripts.json');
  if (!fs.existsSync(scriptPath)) {
    return {
      missingPaths: [],
      missingScripts: REQUIRED_PACKAGE_SCRIPT_NAMES,
      path: scriptPath,
      scriptNames: [],
      status: 'missing',
      unknownCommands: [],
    };
  }

  const scripts = readJson(scriptPath);
  const binNames = readPackageBinNames(packageRoot);
  const scriptNames = Object.keys(scripts).sort();
  const missingScripts = REQUIRED_PACKAGE_SCRIPT_NAMES.filter((scriptName) => !(scriptName in scripts));
  const commandNames = new Set<string>();
  const missingPaths = new Set<string>();

  for (const value of Object.values(scripts)) {
    if (typeof value !== 'string') {
      continue;
    }

    const tokens = tokenizeScript(value);
    if (tokens[0]) {
      commandNames.add(tokens[0]);
    }

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const next = tokens[index + 1];
      if (!token || !PATH_ARGUMENT_FLAGS.has(token) || !next || next.startsWith('<') || !isPathLikeArgument(next)) {
        continue;
      }

      const candidatePath = path.resolve(rootDir, next);
      if (!fs.existsSync(candidatePath)) {
        missingPaths.add(candidatePath);
      }
    }
  }

  const unknownCommands = [...commandNames].filter((commandName) => !binNames.has(commandName)).sort();
  return {
    missingPaths: [...missingPaths].sort(),
    missingScripts,
    path: scriptPath,
    scriptNames,
    status: missingScripts.length > 0 || missingPaths.size > 0 || unknownCommands.length > 0 ? 'incomplete' : 'present',
    unknownCommands,
  };
}

/**
 * Validates a generated or hand-authored Agent Scenario Loop project.
 *
 * @param {{rootDir?: string, platform?: string}} [options]
 * @returns {Promise<ProjectValidationResult>}
 */
async function validateProject(options: {
  packageRoot?: string;
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
  const scripts = validatePackageScripts({
    ...(options.packageRoot ? { packageRoot: options.packageRoot } : {}),
    rootDir,
  });
  const errors: string[] = [];
  const plans: ProjectValidationPlan[] = [];
  const warnings: string[] = [];

  if (!['ios', 'android', 'all'].includes(requestedPlatform)) {
    errors.push(`Unsupported platform '${requestedPlatform}'. Expected ios, android, or all.`);
  }

  if (!fs.existsSync(configPath)) {
    errors.push(`Missing config: ${configPath}`);
  } else {
    warnings.push(...validateConfigPlaceholders(readJson(configPath)));
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

  if (scripts.status === 'missing') {
    errors.push(`Missing package-script snippets: ${scripts.path}`);
  } else if (scripts.status === 'incomplete') {
    if (scripts.missingScripts.length > 0) {
      errors.push(`Package-script snippets are missing script(s): ${scripts.missingScripts.join(', ')}.`);
    }
    if (scripts.unknownCommands.length > 0) {
      errors.push(`Package-script snippets reference unknown command(s): ${scripts.unknownCommands.join(', ')}.`);
    }
    if (scripts.missingPaths.length > 0) {
      errors.push(`Package-script snippets reference missing path(s): ${scripts.missingPaths.join(', ')}.`);
    }
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
    scripts,
    scenarioPaths,
    status: errors.length > 0 ? 'failed' : 'passed',
    warnings,
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
    `Package scripts: ${result.scripts.status}`,
    `Scenarios: ${result.scenarioPaths.length}`,
    `Providers: ${result.providerPaths.length}`,
    ...(result.warnings.length > 0
      ? [
        'Warnings:',
        ...result.warnings.map((warning) => `- ${warning}`),
      ]
      : []),
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
  validateConfigPlaceholders,
  validateProject,
  validateAppHelper,
  validatePackageScripts,
};

export type {
  CliArgs,
  ProjectValidationAppHelper,
  ProjectValidationPlan,
  ProjectValidationResult,
  ProjectValidationScripts,
};
