#!/usr/bin/env node

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  'dry-run'?: string | boolean;
  'with-agent-skill'?: string | boolean;
  force?: string | boolean;
  out?: string | boolean;
  scenario?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type ScaffoldFile = {
  destination: string;
  scenarioId?: string;
  source: string;
  transform?: 'scenario' | 'template';
};

type InitProjectOptions = {
  dryRun?: boolean;
  force?: boolean;
  outDir?: string;
  packageRoot?: string;
  scenarioId?: string;
  withAgentSkill?: boolean;
};

type InitProjectResult = {
  created: string[];
  skipped: string[];
  targetDir: string;
};

const TEMPLATE_FILES = {
  agentSkillAdoptionChecklist: path.join('skills', 'agent-scenario-loop', 'references', 'adoption-checklist.md'),
  agentSkillArtifactInterpretation: path.join('skills', 'agent-scenario-loop', 'references', 'artifact-interpretation.md'),
  agentSkillReadme: path.join('skills', 'agent-scenario-loop', 'SKILL.md'),
  config: 'project.config.json',
  evidenceProvider: 'evidence-provider.json',
  gitignoreSnippet: 'gitignore-snippet',
  integrationReadme: 'integration-readme.md',
  packageScripts: 'package-scripts.json',
  primaryRunner: 'primary-runner.json',
  accessibilityProviderScript: path.join('scripts', 'asl-capture-accessibility-provider.mjs'),
  profilerProviderScript: path.join('scripts', 'asl-capture-profiler-provider.mjs'),
  scenario: 'mobile-scenario.json',
};

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-init [--out <dir>] [--scenario <id>] [--with-agent-skill] [--force] [--dry-run]',
    '',
    'Copies public Agent Scenario Loop templates into a consuming app layout.',
    'Refuses to overwrite existing files unless --force is provided.',
  ], output);
}

/**
 * Parses `--key value` arguments for the init CLI.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      continue;
    }
    if (!token || !token.startsWith('--')) {
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
 * Resolves the installed package root from source or built CLI execution.
 *
 * @returns {string}
 */
function defaultPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Returns true when a boolean-style CLI value is enabled.
 *
 * @param {string | boolean | undefined} value
 * @returns {boolean}
 */
function isEnabled(value: string | boolean | undefined): boolean {
  return value === true || value === 'true';
}

/**
 * Normalizes a scenario id into a portable filename stem.
 *
 * @param {string | undefined} value
 * @returns {string}
 */
function normalizeScenarioId(value: string | undefined): string {
  const normalized = (value || 'first-journey')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');

  return normalized || 'first-journey';
}

/**
 * Builds the scaffold file map for a consuming app.
 *
 * @param {{packageRoot: string, scenarioId: string, targetDir: string}} options
 * @returns {ScaffoldFile[]}
 */
function buildScaffoldFiles({
  packageRoot,
  scenarioId,
  targetDir,
  withAgentSkill = false,
}: {
  packageRoot: string;
  scenarioId: string;
  targetDir: string;
  withAgentSkill?: boolean;
}): ScaffoldFile[] {
  const templatesRoot = path.join(packageRoot, 'templates');
  const files: ScaffoldFile[] = [
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.config),
      destination: path.join(targetDir, 'asl.config.json'),
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.scenario),
      destination: path.join(targetDir, 'scenarios', 'mobile', `${scenarioId}.json`),
      scenarioId,
      transform: 'scenario',
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.primaryRunner),
      destination: path.join(targetDir, 'runner-manifests', 'primary-runner.json'),
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.evidenceProvider),
      destination: path.join(targetDir, 'runner-manifests', 'evidence-provider.json'),
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.accessibilityProviderScript),
      destination: path.join(targetDir, 'scripts', 'asl-capture-accessibility-provider.mjs'),
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.profilerProviderScript),
      destination: path.join(targetDir, 'scripts', 'asl-capture-profiler-provider.mjs'),
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.integrationReadme),
      destination: path.join(targetDir, 'asl', 'README.md'),
      scenarioId,
      transform: 'template',
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.packageScripts),
      destination: path.join(targetDir, 'asl', 'package-scripts.json'),
      scenarioId,
      transform: 'template',
    },
    {
      source: path.join(templatesRoot, TEMPLATE_FILES.gitignoreSnippet),
      destination: path.join(targetDir, 'asl', 'gitignore-snippet'),
    },
    {
      source: path.join(packageRoot, 'app', 'profile-session.ts'),
      destination: path.join(targetDir, 'src', 'devtools', 'profile-session.ts'),
    },
    {
      source: path.join(packageRoot, 'app', 'profile-session-storage.ts'),
      destination: path.join(targetDir, 'src', 'devtools', 'profile-session-storage.ts'),
    },
  ];

  if (withAgentSkill) {
    files.push(
      {
        source: path.join(templatesRoot, TEMPLATE_FILES.agentSkillReadme),
        destination: path.join(targetDir, '.agents', 'skills', 'agent-scenario-loop', 'SKILL.md'),
      },
      {
        source: path.join(templatesRoot, TEMPLATE_FILES.agentSkillArtifactInterpretation),
        destination: path.join(targetDir, '.agents', 'skills', 'agent-scenario-loop', 'references', 'artifact-interpretation.md'),
      },
      {
        source: path.join(templatesRoot, TEMPLATE_FILES.agentSkillAdoptionChecklist),
        destination: path.join(targetDir, '.agents', 'skills', 'agent-scenario-loop', 'references', 'adoption-checklist.md'),
      },
    );
  }

  return files;
}

/**
 * Copies one scaffold template unless it already exists and overwrite is disabled.
 * Scenario templates get their stable id fields aligned with the requested filename.
 *
 * @param {{dryRun: boolean, file: ScaffoldFile, force: boolean}} options
 * @returns {Promise<'created' | 'skipped'>}
 */
async function copyScaffoldFile({
  dryRun,
  file,
  force,
}: {
  dryRun: boolean;
  file: ScaffoldFile;
  force: boolean;
}): Promise<'created' | 'skipped'> {
  if (fs.existsSync(file.destination) && !force) {
    return 'skipped';
  }

  if (dryRun) {
    return 'created';
  }

  await fsp.mkdir(path.dirname(file.destination), { recursive: true });
  if (file.transform === 'scenario' && file.scenarioId) {
    const scenario = JSON.parse(await fsp.readFile(file.source, 'utf8'));
    scenario.id = file.scenarioId;
    scenario.flowId = file.scenarioId;
    await fsp.writeFile(file.destination, `${JSON.stringify(scenario, null, 2)}\n`, 'utf8');
  } else if (file.transform === 'template' && file.scenarioId) {
    const template = await fsp.readFile(file.source, 'utf8');
    await fsp.writeFile(file.destination, template.replace(/\{\{SCENARIO_ID\}\}/gu, file.scenarioId), 'utf8');
  } else {
    await fsp.copyFile(file.source, file.destination);
  }
  return 'created';
}

/**
 * Scaffolds Agent Scenario Loop starter files into a consuming app directory.
 *
 * @param {InitProjectOptions} [options]
 * @returns {Promise<InitProjectResult>}
 */
async function initProject(options: InitProjectOptions = {}): Promise<InitProjectResult> {
  const packageRoot = options.packageRoot ?? defaultPackageRoot();
  const targetDir = path.resolve(options.outDir ?? process.cwd());
  const scenarioId = normalizeScenarioId(options.scenarioId);
  const files = buildScaffoldFiles({
    packageRoot,
    scenarioId,
    targetDir,
    withAgentSkill: Boolean(options.withAgentSkill),
  });
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const result = await copyScaffoldFile({
      dryRun: Boolean(options.dryRun),
      file,
      force: Boolean(options.force),
    });
    const relativeDestination = path.relative(targetDir, file.destination).split(path.sep).join('/');
    if (result === 'created') {
      created.push(relativeDestination);
    } else {
      skipped.push(relativeDestination);
    }
  }

  return {
    created,
    skipped,
    targetDir,
  };
}

/**
 * Formats init output for humans and agents.
 *
 * @param {InitProjectResult} result
 * @returns {string}
 */
function formatResult(result: InitProjectResult): string {
  const lines = [
    `Agent Scenario Loop files initialized in ${result.targetDir}`,
  ];
  if (result.created.length > 0) {
    lines.push('created:', ...result.created.map((filePath) => `- ${filePath}`));
  }
  if (result.skipped.length > 0) {
    lines.push('skipped:', ...result.skipped.map((filePath) => `- ${filePath}`));
  }

  return lines.join('\n');
}

/**
 * Runs the init CLI.
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
  const result = await initProject({
    dryRun: isEnabled(args['dry-run']),
    force: isEnabled(args.force),
    ...(typeof args.out === 'string' ? { outDir: args.out } : {}),
    ...(typeof args.scenario === 'string' ? { scenarioId: args.scenario } : {}),
    withAgentSkill: isEnabled(args['with-agent-skill']),
  });
  process.stdout.write(`${formatResult(result)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildScaffoldFiles,
  defaultPackageRoot,
  formatResult,
  initProject,
  main,
  normalizeScenarioId,
  parseArgs,
  usage,
};

export type {
  CliArgs,
  InitProjectOptions,
  InitProjectResult,
  ScaffoldFile,
};
