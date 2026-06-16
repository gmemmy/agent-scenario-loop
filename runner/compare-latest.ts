#!/usr/bin/env node

const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { compareRunDirectories, readRunArtifacts } = require('../core/comparison');
const { buildRunIndex } = require('../core/run-index');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');
const { parseArgs, resolveOutput } = require('./compare');

import type { RunIndex, RunIndexEntry } from '../core/run-index';

type CliArgs = {
  current?: string | boolean;
  out?: string | boolean;
  root?: string | boolean;
  scenario?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type CompareLatestOptions = {
  currentDir: string;
  rootDir: string;
  scenarioId: string;
};

type CompareLatestResult = {
  baselineDir: string;
  comparison: Record<string, unknown>;
  currentDir: string;
};

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-compare-latest --root <artifact-root> --scenario <id> --current <run-dir> [--out <comparison.json|run-dir>]',
    '',
    'Finds the latest trusted prior run for the scenario, then compares it with the current run.',
    'A trusted prior run must have passed health and passed verdict artifacts.',
    'The current run must pass scenario health before timing or budget comparison is allowed.',
  ], output);
}

/**
 * Returns the scenario id recorded by a run artifact set.
 *
 * @param {{health: Record<string, unknown>, verdict: Record<string, unknown>}} artifacts
 * @returns {string}
 */
function readScenarioId(artifacts: {
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
}): string {
  return String(artifacts.health.scenarioId ?? artifacts.verdict.scenarioId ?? 'unknown-scenario');
}

/**
 * Validates that the current run can be compared against trusted historical evidence.
 *
 * @param {{currentDir: string, scenarioId: string}} options
 * @returns {{health: Record<string, unknown>, verdict: Record<string, unknown>}}
 */
function assertComparableCurrentRun({
  currentDir,
  scenarioId,
}: {
  currentDir: string;
  scenarioId: string;
}): {
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
} {
  const current = readRunArtifacts(currentDir);
  if (current.health.healthStatus !== 'passed') {
    throw new Error(`Current run health did not pass: ${currentDir}`);
  }

  const currentScenarioId = readScenarioId(current);
  if (currentScenarioId !== scenarioId) {
    throw new Error(`Current run scenario '${currentScenarioId}' does not match requested scenario '${scenarioId}'.`);
  }

  return current;
}

/**
 * Finds the newest trusted run for a scenario while excluding the current run directory.
 *
 * @param {{index: RunIndex, scenarioId: string, currentDir: string}} options
 * @returns {RunIndexEntry | null}
 */
function findLatestTrustedPriorRun({
  index,
  scenarioId,
  currentDir,
}: {
  index: RunIndex;
  scenarioId: string;
  currentDir: string;
}): RunIndexEntry | null {
  const resolvedCurrentDir = path.resolve(currentDir);
  return index.trusted.find((entry) => (
    entry.scenarioId === scenarioId &&
    path.resolve(entry.runDir) !== resolvedCurrentDir
  )) ?? null;
}

/**
 * Builds a comparison against the latest trusted prior run in an artifact root.
 *
 * @param {CompareLatestOptions} options
 * @returns {CompareLatestResult}
 */
function compareLatestTrustedRun({
  currentDir,
  rootDir,
  scenarioId,
}: CompareLatestOptions): CompareLatestResult {
  const resolvedCurrentDir = path.resolve(currentDir);
  const resolvedRootDir = path.resolve(rootDir);
  assertComparableCurrentRun({ currentDir: resolvedCurrentDir, scenarioId });

  const index = buildRunIndex({ rootDir: resolvedRootDir, scenarioId });
  const baseline = findLatestTrustedPriorRun({
    index,
    scenarioId,
    currentDir: resolvedCurrentDir,
  });
  if (!baseline) {
    throw new Error(`No trusted prior run found for scenario '${scenarioId}' under ${resolvedRootDir}.`);
  }

  return {
    baselineDir: baseline.runDir,
    comparison: compareRunDirectories({
      baselineDir: baseline.runDir,
      currentDir: resolvedCurrentDir,
    }),
    currentDir: resolvedCurrentDir,
  };
}

/**
 * Runs the compare-latest CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const args = parseArgs(argv) as CliArgs;
  if (
    typeof args.root !== 'string' ||
    typeof args.scenario !== 'string' ||
    typeof args.current !== 'string'
  ) {
    usage();
    process.exitCode = 1;
    return;
  }

  const result = compareLatestTrustedRun({
    rootDir: args.root,
    scenarioId: args.scenario,
    currentDir: args.current,
  });

  if (typeof args.out === 'string' && args.out.length > 0) {
    const { comparisonPath, summaryPath, printedPath } = resolveOutput(args.out);
    await writeJsonArtifact({
      filePath: comparisonPath,
      value: result.comparison,
      schema: SCHEMAS.comparison,
      label: 'Comparison artifact',
    });

    if (summaryPath) {
      const current = readRunArtifacts(result.currentDir);
      await writeTextArtifact({
        filePath: summaryPath,
        content: buildAgentSummaryMarkdown({
          health: current.health,
          verdict: current.verdict,
          comparison: result.comparison,
        }),
      });
    }

    process.stdout.write(`${printedPath}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result.comparison, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertComparableCurrentRun,
  compareLatestTrustedRun,
  findLatestTrustedPriorRun,
  main,
  usage,
};
