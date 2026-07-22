#!/usr/bin/env node

const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { compareRunDirectories, readRunArtifacts } = require('../core/comparison');
const { buildRunIndex, readRunIndexEntry } = require('../core/run-index');
const { isScenarioCompatible, resolveScenarioCompatibility } = require('../core/scenario-compatibility');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');
const { assertNoRegressedComparison, isEnabledFlag, parseArgs, resolveOutput } = require('./compare');

import type { RunIndex, RunIndexEntry } from '../core/run-index';

type CliArgs = {
  'comparison-lane'?: string | boolean;
  current?: string | boolean;
  'fail-on-regression'?: string | boolean;
  out?: string | boolean;
  root?: string | boolean;
  scenario?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type CompareLatestOptions = {
  comparisonLane?: string;
  currentDir: string;
  rootDir: string;
  scenarioId: string;
};

type CompareLatestResult = {
  baselineDir: string;
  comparison: Record<string, unknown>;
  currentDir: string;
};

type LatestTrustedSelection = {
  artifactRoot: string;
  candidatesInspected: number;
  cohortHash?: string;
  scenarioId: string;
  selectedRunDir: string;
  selectedRunId: string;
  skippedCurrentRun: boolean;
  comparisonLane?: string;
  scenarioHash?: string;
  acceptedBaselineScenarioHashes?: string[];
  scenarioCompatibility?: 'declared-compatible' | 'exact' | 'legacy-compatible';
  trustedCandidates: number;
  trustedCohortCandidates?: number;
  trustedComparableCandidates?: number;
  trustedScenarioContractCandidates?: number;
  trustedPriorCandidates: number;
};

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-compare-latest --root <artifact-root> --scenario <id> --current <run-dir> [--comparison-lane <id>] [--out <comparison.json|run-dir>] [--fail-on-regression]',
    '',
    'Finds the latest trusted prior run for the scenario, then compares it with the current run.',
    'A trusted prior run must have passed health and passed verdict artifacts.',
    'The current run must pass scenario health before timing or budget comparison is allowed.',
    'Use --fail-on-regression to exit nonzero after writing evidence when ordinary or trusted native-performance comparison regresses.',
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
 * Returns whether a historical run belongs to the requested comparison lane.
 * Runs without an explicit lane are compared only with other unlabeled runs.
 *
 * @param {RunIndexEntry} entry
 * @param {string | undefined} comparisonLane
 * @returns {boolean}
 */
function isComparableLane(entry: RunIndexEntry, comparisonLane: string | undefined): boolean {
  return comparisonLane ? entry.comparisonLane === comparisonLane : entry.comparisonLane === undefined;
}

/**
 * Returns whether a historical run used the same scenario contract as the current run.
 * Runs without a current scenario hash keep legacy behavior for old artifacts.
 *
 * @param {RunIndexEntry} entry
 * @param {string | undefined} scenarioHash
 * @returns {boolean}
 */
function isComparableScenarioContract(
  entry: RunIndexEntry,
  scenarioHash: string | undefined,
  acceptedBaselineScenarioHashes: string[] = [],
): boolean {
  return isScenarioCompatible(resolveScenarioCompatibility({
    acceptedBaselineScenarioHashes,
    baselineHash: entry.scenarioHash,
    baselineScenarioId: entry.scenarioId,
    currentHash: scenarioHash,
    currentScenarioId: entry.scenarioId,
  }));
}

/**
 * Returns whether a historical run belongs to the requested provenance cohort.
 * Runs without a current cohort hash keep legacy behavior for old artifacts.
 *
 * @param {RunIndexEntry} entry
 * @param {string | undefined} cohortHash
 * @returns {boolean}
 */
function isComparableCohort(entry: RunIndexEntry, cohortHash: string | undefined): boolean {
  return cohortHash ? entry.cohortHash === cohortHash : true;
}

/**
 * Finds the newest trusted run for a scenario while excluding the current run directory.
 *
 * @param {{index: RunIndex, scenarioId: string, currentDir: string, cohortHash?: string, comparisonLane?: string, scenarioHash?: string}} options
 * @returns {RunIndexEntry | null}
 */
function findLatestTrustedPriorRun({
  cohortHash,
  comparisonLane,
  index,
  acceptedBaselineScenarioHashes = [],
  scenarioHash,
  scenarioId,
  currentDir,
}: {
  cohortHash?: string;
  comparisonLane?: string;
  acceptedBaselineScenarioHashes?: string[];
  index: RunIndex;
  scenarioHash?: string;
  scenarioId: string;
  currentDir: string;
}): RunIndexEntry | null {
  const resolvedCurrentDir = path.resolve(currentDir);
  const candidates = index.trusted.filter((entry) => (
    entry.scenarioId === scenarioId &&
    isComparableLane(entry, comparisonLane) &&
    isComparableScenarioContract(entry, scenarioHash, acceptedBaselineScenarioHashes) &&
    isComparableCohort(entry, cohortHash) &&
    path.resolve(entry.runDir) !== resolvedCurrentDir
  ));
  if (!scenarioHash) {
    return candidates[0] ?? null;
  }
  return candidates.find((entry) => entry.scenarioHash === scenarioHash) ?? candidates[0] ?? null;
}

/**
 * Builds stable provenance for the latest-trusted baseline selection.
 *
 * @param {{baseline: RunIndexEntry, cohortHash?: string, comparisonLane?: string, currentDir: string, index: RunIndex, rootDir: string, scenarioHash?: string, scenarioId: string}} options
 * @returns {LatestTrustedSelection}
 */
function buildLatestTrustedSelection({
  baseline,
  cohortHash,
  comparisonLane,
  currentDir,
  index,
  acceptedBaselineScenarioHashes = [],
  rootDir,
  scenarioHash,
  scenarioId,
}: {
  baseline: RunIndexEntry;
  cohortHash?: string;
  comparisonLane?: string;
  acceptedBaselineScenarioHashes?: string[];
  currentDir: string;
  index: RunIndex;
  rootDir: string;
  scenarioHash?: string;
  scenarioId: string;
}): LatestTrustedSelection {
  const resolvedCurrentDir = path.resolve(currentDir);
  const trustedPriorCandidates = index.trusted.filter((entry) => (
    entry.scenarioId === scenarioId &&
    path.resolve(entry.runDir) !== resolvedCurrentDir
  ));
  const trustedComparableCandidates = trustedPriorCandidates.filter((entry) => (
    isComparableLane(entry, comparisonLane)
  ));
  const trustedScenarioContractCandidates = trustedComparableCandidates.filter((entry) => (
    isComparableScenarioContract(entry, scenarioHash, acceptedBaselineScenarioHashes)
  ));
  const trustedCohortCandidates = trustedScenarioContractCandidates.filter((entry) => (
    isComparableCohort(entry, cohortHash)
  ));
  const scenarioCompatibility = resolveScenarioCompatibility({
    acceptedBaselineScenarioHashes,
    baselineHash: baseline.scenarioHash,
    baselineScenarioId: baseline.scenarioId,
    currentHash: scenarioHash,
    currentScenarioId: scenarioId,
  });

  return {
    artifactRoot: rootDir,
    candidatesInspected: index.entries.length,
    scenarioId,
    selectedRunDir: baseline.runDir,
    selectedRunId: baseline.runId,
    skippedCurrentRun: index.entries.some((entry) => path.resolve(entry.runDir) === resolvedCurrentDir),
    ...(comparisonLane ? { comparisonLane } : {}),
    ...(scenarioHash ? { scenarioHash } : {}),
    ...(acceptedBaselineScenarioHashes.length > 0 ? { acceptedBaselineScenarioHashes } : {}),
    ...(scenarioCompatibility.status !== 'incompatible'
      ? { scenarioCompatibility: scenarioCompatibility.status }
      : {}),
    ...(cohortHash ? { cohortHash } : {}),
    trustedCandidates: index.trusted.length,
    trustedComparableCandidates: trustedComparableCandidates.length,
    ...(scenarioHash ? { trustedScenarioContractCandidates: trustedScenarioContractCandidates.length } : {}),
    ...(cohortHash ? { trustedCohortCandidates: trustedCohortCandidates.length } : {}),
    trustedPriorCandidates: trustedPriorCandidates.length,
  };
}

/**
 * Builds a comparison against the latest trusted prior run in an artifact root.
 *
 * @param {CompareLatestOptions} options
 * @returns {CompareLatestResult}
 */
function compareLatestTrustedRun({
  comparisonLane,
  currentDir,
  rootDir,
  scenarioId,
}: CompareLatestOptions): CompareLatestResult {
  const resolvedCurrentDir = path.resolve(currentDir);
  const resolvedRootDir = path.resolve(rootDir);
  assertComparableCurrentRun({ currentDir: resolvedCurrentDir, scenarioId });
  const currentEntry = readRunIndexEntry(resolvedCurrentDir);
  const resolvedComparisonLane = comparisonLane ?? currentEntry.comparisonLane;
  const scenarioHash = currentEntry.scenarioHash;
  const acceptedBaselineScenarioHashes = currentEntry.acceptedBaselineScenarioHashes ?? [];
  const cohortHash = currentEntry.cohortHash;

  const index = buildRunIndex({ rootDir: resolvedRootDir, scenarioId });
  const baseline = findLatestTrustedPriorRun({
    ...(cohortHash ? { cohortHash } : {}),
    ...(resolvedComparisonLane ? { comparisonLane: resolvedComparisonLane } : {}),
    ...(scenarioHash ? { scenarioHash } : {}),
    ...(acceptedBaselineScenarioHashes.length > 0 ? { acceptedBaselineScenarioHashes } : {}),
    index,
    scenarioId,
    currentDir: resolvedCurrentDir,
  });
  if (!baseline) {
    const laneSuffix = resolvedComparisonLane
      ? ` in comparison lane '${resolvedComparisonLane}'`
      : ' without a comparison lane';
    const scenarioHashSuffix = scenarioHash ? ` and scenario hash '${scenarioHash}'` : '';
    const cohortHashSuffix = cohortHash ? ` and cohort hash '${cohortHash}'` : '';
    throw new Error(
      `No trusted prior run found for scenario '${scenarioId}'${laneSuffix}${scenarioHashSuffix}${cohortHashSuffix} under ${resolvedRootDir}; inspected ${index.entries.length} candidate run(s), ${index.trusted.length} trusted.`,
    );
  }

  return {
    baselineDir: baseline.runDir,
    comparison: compareRunDirectories({
      baselineDir: baseline.runDir,
      currentDir: resolvedCurrentDir,
      selection: buildLatestTrustedSelection({
        baseline,
        ...(cohortHash ? { cohortHash } : {}),
        ...(resolvedComparisonLane ? { comparisonLane: resolvedComparisonLane } : {}),
        currentDir: resolvedCurrentDir,
        index,
        rootDir: resolvedRootDir,
        ...(scenarioHash ? { scenarioHash } : {}),
        ...(acceptedBaselineScenarioHashes.length > 0 ? { acceptedBaselineScenarioHashes } : {}),
        scenarioId,
      }),
      strategy: 'latest_trusted_prior',
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
    ...(typeof args['comparison-lane'] === 'string' ? { comparisonLane: args['comparison-lane'] } : {}),
  });
  const failOnRegression = isEnabledFlag(args['fail-on-regression']);

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
    if (failOnRegression) {
      assertNoRegressedComparison({
        comparison: result.comparison,
        evidencePath: printedPath,
      });
    }
    return;
  }

  process.stdout.write(`${JSON.stringify(result.comparison, null, 2)}\n`);
  if (failOnRegression) {
    assertNoRegressedComparison({ comparison: result.comparison });
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertComparableCurrentRun,
  buildLatestTrustedSelection,
  compareLatestTrustedRun,
  findLatestTrustedPriorRun,
  isComparableScenarioContract,
  main,
  usage,
};
