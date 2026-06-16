#!/usr/bin/env node

const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { compareRunDirectories, readRunArtifacts } = require('../core/comparison');
const { SCHEMAS } = require('../core/schema-validator');
const { buildPlanArtifacts } = require('./check-plan');
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
 * Writes a fixture-backed preflight, baseline profile, current profile, and comparison.
 *
 * @param {{outputDir?: string}} options
 * @returns {Promise<DemoLoopResult>}
 */
async function runDemoLoop({ outputDir = path.resolve('artifacts/demo-loop') }: { outputDir?: string } = {}): Promise<DemoLoopResult> {
  const root = process.cwd();
  const resolvedOutputDir = path.resolve(outputDir);
  const preflightDir = path.join(resolvedOutputDir, 'preflight', 'app-startup');
  const profileRoot = path.join(resolvedOutputDir, 'profile-runs');
  const configPath = path.join(root, 'core/config-template.json');
  const transitionScenarioPath = path.join(root, 'examples/scenarios/ios/app-startup.json');
  const mobileScenarioPath = path.join(root, 'examples/scenarios/mobile/app-startup.json');
  const runnerPath = path.join(root, 'examples/runners/xcodebuildmcp-ios.json');
  const baselineLogPath = path.join(root, 'examples/event-logs/app-startup-baseline.log');
  const currentLogPath = path.join(root, 'examples/event-logs/app-startup-current.log');

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

  const baseline = await runProfileIos({
    config: configPath,
    events: baselineLogPath,
    out: profileRoot,
    scenario: transitionScenarioPath,
    'run-id': 'demo-baseline',
  });
  const current = await runProfileIos({
    config: configPath,
    events: currentLogPath,
    out: profileRoot,
    scenario: transitionScenarioPath,
    'run-id': 'demo-current',
  });
  const comparison = compareRunDirectories({
    baselineDir: baseline.runDir,
    currentDir: current.runDir,
  });
  const currentLayout = createArtifactLayout({ outputDir: current.runDir });
  await writeJsonArtifact({
    filePath: currentLayout.comparison,
    value: comparison,
    schema: SCHEMAS.comparison,
    label: 'Comparison artifact',
  });

  const currentArtifacts = readRunArtifacts(current.runDir);
  await writeTextArtifact({
    filePath: currentLayout.agentSummary,
    content: buildAgentSummaryMarkdown({
      health: currentArtifacts.health,
      verdict: currentArtifacts.verdict,
      comparison,
    }),
  });

  return {
    baselineRunDir: baseline.runDir,
    comparison,
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
  const args = parseArgs(process.argv.slice(2));
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
};

export type {
  CliArgs,
  DemoLoopResult,
};
