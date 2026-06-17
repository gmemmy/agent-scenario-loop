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
  invalidScripts: string[];
  missingPaths: string[];
  missingScripts: string[];
  path: string;
  scriptNames: string[];
  status: 'present' | 'missing' | 'incomplete';
  unknownCommands: string[];
};

type ProjectValidationGitignore = {
  missingPatterns: string[];
  path: string;
  snippetPath: string;
  status: 'present' | 'missing' | 'incomplete';
};

type ProjectValidationNextAction = {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  target: string;
};

type ProjectValidationResult = {
  appHelper: ProjectValidationAppHelper;
  configPath: string;
  errors: string[];
  gitignore: ProjectValidationGitignore;
  nextActions: ProjectValidationNextAction[];
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
  'asl:agent-device:ios',
  'asl:agent-device:android',
  'asl:profile:ios:live',
  'asl:profile:android:live',
  'asl:compare:ios',
  'asl:compare:android',
  'asl:live-proof',
];

const PATH_ARGUMENT_FLAGS = new Set(['--config', '--provider', '--runner', '--scenario']);

const REQUIRED_PACKAGE_SCRIPT_SHAPES = {
  'asl:check:ios': {
    command: 'asl-check-plan',
    flags: ['--scenario', '--runner', '--provider', '--platform', '--out'],
    values: { '--platform': 'ios' },
  },
  'asl:check:android': {
    command: 'asl-check-plan',
    flags: ['--scenario', '--runner', '--provider', '--platform', '--out'],
    values: { '--platform': 'android' },
  },
  'asl:validate': {
    command: 'asl-validate-project',
    flags: ['--root', '--platform', '--out'],
    values: {},
  },
  'asl:profile:ios': {
    command: 'asl-profile-ios',
    flags: ['--config', '--scenario', '--comparison-lane', '--out', '--run-id'],
    values: {},
  },
  'asl:profile:android': {
    command: 'asl-profile-android',
    flags: ['--config', '--scenario', '--comparison-lane', '--out', '--run-id'],
    values: {},
  },
  'asl:agent-device:ios': {
    command: 'asl-agent-device',
    flags: ['--platform', '--scenario', '--app', '--open', '--out', '--run-id'],
    values: { '--platform': 'ios' },
  },
  'asl:agent-device:android': {
    command: 'asl-agent-device',
    flags: ['--platform', '--scenario', '--app', '--open', '--out', '--run-id'],
    values: { '--platform': 'android' },
  },
  'asl:profile:ios:live': {
    command: 'asl-profile-ios',
    flags: ['--config', '--scenario', '--simctl-capture', '--profile-session', '--launch', '--comparison-lane', '--out', '--run-id'],
    values: {},
  },
  'asl:profile:android:live': {
    command: 'asl-profile-android',
    flags: ['--config', '--scenario', '--adb-capture', '--profile-session', '--launch', '--comparison-lane', '--out', '--run-id'],
    values: {},
  },
  'asl:compare:ios': {
    command: 'asl-compare-latest',
    flags: ['--root', '--scenario', '--current', '--out', '--fail-on-regression'],
    values: {},
  },
  'asl:compare:android': {
    command: 'asl-compare-latest',
    flags: ['--root', '--scenario', '--current', '--out', '--fail-on-regression'],
    values: {},
  },
  'asl:live-proof': {
    command: 'asl-live-proof',
    flags: ['--file', '--fail-on-regression'],
    values: {},
  },
} satisfies Record<string, { command: string; flags: string[]; values: Record<string, string> }>;

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

const REQUIRED_GITIGNORE_PATTERNS = [
  'artifacts/asl/',
  'artifacts/example-mobile-app/',
  '*.memgraph',
  '*.trace',
  '*.xcresult',
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
 * Validates that runtime proof artifacts are ignored by the consuming app.
 *
 * @param {string} rootDir
 * @returns {ProjectValidationGitignore}
 */
function validateGitignore(rootDir: string): ProjectValidationGitignore {
  const gitignorePath = path.join(rootDir, '.gitignore');
  const snippetPath = path.join(rootDir, 'asl', 'gitignore-snippet');
  if (!fs.existsSync(gitignorePath)) {
    return {
      missingPatterns: REQUIRED_GITIGNORE_PATTERNS,
      path: gitignorePath,
      snippetPath,
      status: 'missing',
    };
  }

  const lines = new Set(
    fs.readFileSync(gitignorePath, 'utf8')
      .split(/\r?\n/u)
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith('#')),
  );
  const missingPatterns = REQUIRED_GITIGNORE_PATTERNS.filter((pattern) => !lines.has(pattern));

  return {
    missingPatterns,
    path: gitignorePath,
    snippetPath,
    status: missingPatterns.length > 0 ? 'incomplete' : 'present',
  };
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
 * Reads a script flag value from tokenized package-script snippets.
 *
 * @param {string[]} tokens
 * @param {string} flag
 * @returns {string | null}
 */
function readScriptFlagValue(tokens: string[], flag: string): string | null {
  const index = tokens.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = tokens[index + 1];
  return value && !value.startsWith('--') ? value : null;
}

/**
 * Validates one generated package-script snippet against its expected lifecycle shape.
 *
 * @param {{command: string, scriptName: string}} options
 * @returns {string | null}
 */
function validatePackageScriptShape({
  command,
  scriptName,
}: {
  command: string;
  scriptName: string;
}): string | null {
  const expected = REQUIRED_PACKAGE_SCRIPT_SHAPES[scriptName as keyof typeof REQUIRED_PACKAGE_SCRIPT_SHAPES];
  if (!expected) {
    return null;
  }

  const tokens = tokenizeScript(command);
  if (tokens[0] !== expected.command) {
    return `${scriptName} should start with ${expected.command}.`;
  }

  const missingFlags = expected.flags.filter((flag) => !tokens.includes(flag));
  if (missingFlags.length > 0) {
    return `${scriptName} is missing required flag(s): ${missingFlags.join(', ')}.`;
  }

  const wrongValues = Object.entries(expected.values).flatMap(([flag, expectedValue]) => {
    const actual = readScriptFlagValue(tokens, flag);
    return actual === expectedValue ? [] : [`${flag}=${expectedValue}`];
  });
  if (wrongValues.length > 0) {
    return `${scriptName} has incorrect required value(s): ${wrongValues.join(', ')}.`;
  }

  return null;
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
      invalidScripts: [],
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
  const invalidScripts: string[] = [];
  const missingPaths = new Set<string>();

  for (const [scriptName, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') {
      invalidScripts.push(`${scriptName} should be a string command.`);
      continue;
    }

    const shapeError = validatePackageScriptShape({
      command: value,
      scriptName,
    });
    if (shapeError) {
      invalidScripts.push(shapeError);
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
    invalidScripts: invalidScripts.sort(),
    missingPaths: [...missingPaths].sort(),
    missingScripts,
    path: scriptPath,
    scriptNames,
    status: missingScripts.length > 0 || missingPaths.size > 0 || unknownCommands.length > 0 || invalidScripts.length > 0 ? 'incomplete' : 'present',
    unknownCommands,
  };
}

/**
 * Builds stable agent-readable next actions from project validation facts.
 *
 * @param {{appHelper: ProjectValidationAppHelper, configPath: string, gitignore: ProjectValidationGitignore, plans: ProjectValidationPlan[], requestedPlatform: string, rootDir: string, runnerPath: string, scenarioPaths: string[], scripts: ProjectValidationScripts, warnings: string[]}} options
 * @returns {ProjectValidationNextAction[]}
 */
function buildNextActions({
  appHelper,
  configPath,
  gitignore,
  plans,
  requestedPlatform,
  rootDir,
  runnerPath,
  scenarioPaths,
  scripts,
  warnings,
}: {
  appHelper: ProjectValidationAppHelper;
  configPath: string;
  gitignore: ProjectValidationGitignore;
  plans: ProjectValidationPlan[];
  requestedPlatform: string;
  rootDir: string;
  runnerPath: string;
  scenarioPaths: string[];
  scripts: ProjectValidationScripts;
  warnings: string[];
}): ProjectValidationNextAction[] {
  const actions: ProjectValidationNextAction[] = [];
  if (!['ios', 'android', 'all'].includes(requestedPlatform)) {
    actions.push({
      code: 'choose_supported_platform',
      message: 'Rerun project validation with --platform ios, --platform android, or --platform all.',
      severity: 'error',
      target: 'platform',
    });
  }

  if (!fs.existsSync(configPath)) {
    actions.push({
      code: 'add_project_config',
      message: 'Create asl.config.json from the package template and fill in app identifiers.',
      severity: 'error',
      target: configPath,
    });
  }

  if (!fs.existsSync(runnerPath)) {
    actions.push({
      code: 'add_primary_runner_manifest',
      message: 'Create runner-manifests/primary-runner.json or rerun asl-init for the scaffolded runner manifest.',
      severity: 'error',
      target: runnerPath,
    });
  }

  if (scenarioPaths.length === 0) {
    actions.push({
      code: 'add_mobile_scenario',
      message: 'Add at least one scenario manifest under scenarios/mobile.',
      severity: 'error',
      target: path.join(rootDir, 'scenarios', 'mobile'),
    });
  }

  if (appHelper.status === 'missing') {
    actions.push({
      code: 'add_profile_session_helper',
      message: 'Copy app/profile-session.ts into src/devtools/profile-session.ts and mount useProfileSessionBootstrap near the app root.',
      severity: 'error',
      target: appHelper.path,
    });
  } else if (appHelper.status === 'incomplete') {
    actions.push({
      code: 'restore_profile_session_exports',
      message: `Restore missing profile-session export(s): ${appHelper.missingExports.join(', ')}.`,
      severity: 'error',
      target: appHelper.path,
    });
  }

  if (scripts.status === 'missing') {
    actions.push({
      code: 'add_package_script_snippets',
      message: 'Create asl/package-scripts.json from the package template and merge needed snippets into package.json.',
      severity: 'error',
      target: scripts.path,
    });
  } else if (scripts.status === 'incomplete') {
    actions.push({
      code: 'fix_package_script_snippets',
      message: 'Fix missing package-script snippets, invalid snippet shapes, unknown CLI commands, or missing project-local paths before live proof.',
      severity: 'error',
      target: scripts.path,
    });
  }

  for (const plan of plans.filter((candidate) => candidate.healthStatus !== 'passed')) {
    actions.push({
      code: 'fix_planner_compatibility',
      message: `Fix runner/provider compatibility for ${plan.platform} ${plan.scenarioId}.`,
      severity: 'error',
      target: plan.scenarioPath,
    });
  }

  if (warnings.some((warning) => warning.startsWith('Config field '))) {
    actions.push({
      code: 'replace_config_placeholders',
      message: 'Replace scaffold placeholder values in asl.config.json before relying on live device proof.',
      severity: 'warning',
      target: configPath,
    });
  }

  if (gitignore.status !== 'present') {
    actions.push({
      code: 'ignore_runtime_artifacts',
      message: 'Merge asl/gitignore-snippet into .gitignore so runtime artifacts, traces, and local proof captures stay out of source control.',
      severity: 'warning',
      target: gitignore.path,
    });
  }

  return actions;
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
  const gitignore = validateGitignore(rootDir);
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

  if (gitignore.status !== 'present') {
    warnings.push(`Runtime artifact gitignore is missing pattern(s): ${gitignore.missingPatterns.join(', ')}.`);
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
    if (scripts.invalidScripts.length > 0) {
      errors.push(`Package-script snippets have invalid command shape(s): ${scripts.invalidScripts.join(' ')}`);
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

  const nextActions = buildNextActions({
    appHelper,
    configPath,
    gitignore,
    plans,
    requestedPlatform,
    rootDir,
    runnerPath,
    scenarioPaths,
    scripts,
    warnings,
  });

  return {
    appHelper,
    configPath,
    errors,
    gitignore,
    nextActions,
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
    `Gitignore: ${result.gitignore.status}`,
    `Package scripts: ${result.scripts.status}`,
    `Scenarios: ${result.scenarioPaths.length}`,
    `Providers: ${result.providerPaths.length}`,
    ...(result.warnings.length > 0
      ? [
        'Warnings:',
        ...result.warnings.map((warning) => `- ${warning}`),
      ]
      : []),
    ...(result.nextActions.length > 0
      ? [
        'Next actions:',
        ...result.nextActions.map((action) => `- ${action.severity} ${action.code}: ${action.message}`),
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
  buildNextActions,
  validateConfigPlaceholders,
  validateGitignore,
  validateProject,
  validateAppHelper,
  validatePackageScriptShape,
  validatePackageScripts,
};

export type {
  CliArgs,
  ProjectValidationAppHelper,
  ProjectValidationGitignore,
  ProjectValidationNextAction,
  ProjectValidationPlan,
  ProjectValidationResult,
  ProjectValidationScripts,
};
