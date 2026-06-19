#!/usr/bin/env node

const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { readRunArtifacts } = require('../core/comparison');
const { SCHEMAS } = require('../core/schema-validator');
const { buildPlanArtifacts } = require('./check-plan');
const { hasHelpFlag, writeUsage } = require('./cli');
const { compareLatestTrustedRun } = require('./compare-latest');
const { runProfileIos } = require('./profile-ios');

type CliArgs = {
  out?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type DemoLoopResult = {
  baselineRunDir: string;
  comparison: Record<string, unknown>;
  currentRunDir: string;
  outputDir: string;
  preflightDir: string;
};

/**
 * Resolves files shipped with the installed package.
 *
 * @returns {string}
 */
function resolvePackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-demo-loop [--out <dir>]',
    '',
    'Runs the fixture preflight, baseline/current profile logs, and comparison without a simulator.',
  ], output);
}

/**
 * Parses `--key value` arguments for the fixture demo loop.
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
 * Writes a fixture-backed preflight, profile history, current profile, and latest-trusted comparison.
 *
 * @param {{outputDir?: string}} options
 * @returns {Promise<DemoLoopResult>}
 */
async function runDemoLoop({ outputDir = path.resolve('artifacts/demo-loop') }: { outputDir?: string } = {}): Promise<DemoLoopResult> {
  const packageRoot = resolvePackageRoot();
  const resolvedOutputDir = path.resolve(outputDir);
  const preflightDir = path.join(resolvedOutputDir, 'preflight', 'app-startup');
  const profileRoot = path.join(resolvedOutputDir, 'profile-runs');
  const configPath = path.join(packageRoot, 'core/config-template.json');
  const profileScenarioPath = path.join(packageRoot, 'examples/scenarios/ios/app-startup.json');
  const mobileScenarioPath = path.join(packageRoot, 'examples/scenarios/mobile/app-startup.json');
  const runnerPath = path.join(packageRoot, 'examples/runners/xcodebuildmcp-ios.json');
  const baselineLogPath = path.join(packageRoot, 'examples/event-logs/app-startup-baseline.log');
  const currentLogPath = path.join(packageRoot, 'examples/event-logs/app-startup-current.log');

  const preflight = await buildPlanArtifacts({
    scenarioPath: mobileScenarioPath,
    runnerPath,
    platform: 'ios',
    runId: 'demo-preflight',
  });
  const preflightLayout = createArtifactLayout({ outputDir: preflightDir });
  await writeJsonArtifact({
    filePath: preflightLayout.health,
    value: preflight.health,
    schema: SCHEMAS.health,
    label: 'Health artifact',
  });
  await writeJsonArtifact({
    filePath: preflightLayout.verdict,
    value: preflight.verdict,
    schema: SCHEMAS.verdict,
    label: 'Verdict artifact',
  });
  await writeTextArtifact({
    filePath: preflightLayout.agentSummary,
    content: preflight.agentSummary,
  });
  await writeJsonArtifact({
    filePath: preflightLayout.plannerCompatibility,
    value: preflight.compatibility,
    schema: {
      type: 'object',
      additionalProperties: true,
    },
    label: 'Planner compatibility artifact',
  });

  await runProfileIos({
    config: configPath,
    events: baselineLogPath,
    out: profileRoot,
    scenario: profileScenarioPath,
    'run-id': 'demo-baseline',
  });
  const current = await runProfileIos({
    config: configPath,
    events: currentLogPath,
    out: profileRoot,
    scenario: profileScenarioPath,
    'run-id': 'demo-current',
  });
  const latestComparison = compareLatestTrustedRun({
    rootDir: profileRoot,
    scenarioId: 'app-startup',
    currentDir: current.runDir,
  });
  const currentLayout = createArtifactLayout({ outputDir: current.runDir });
  await writeJsonArtifact({
    filePath: currentLayout.comparison,
    value: latestComparison.comparison,
    schema: SCHEMAS.comparison,
    label: 'Comparison artifact',
  });

  const currentArtifacts = readRunArtifacts(current.runDir);
  await writeTextArtifact({
    filePath: currentLayout.agentSummary,
    content: buildAgentSummaryMarkdown({
      health: currentArtifacts.health,
      verdict: currentArtifacts.verdict,
      comparison: latestComparison.comparison,
    }),
  });

  return {
    baselineRunDir: latestComparison.baselineDir,
    comparison: latestComparison.comparison,
    currentRunDir: current.runDir,
    outputDir: resolvedOutputDir,
    preflightDir,
  };
}

/**
 * Runs the fixture demo CLI.
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
  const result = await runDemoLoop({
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
  runDemoLoop,
  resolvePackageRoot,
  usage,
};

export type {
  CliArgs,
  DemoLoopResult,
};
