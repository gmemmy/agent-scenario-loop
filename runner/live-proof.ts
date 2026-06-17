#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  file?: string | boolean;
  'fail-on-regression'?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type LiveProofArtifact = {
  comparisonCounts: {
    better: number;
    inconclusive: number;
    mixed: number;
    skipped: number;
    unchanged: number;
    worse: number;
  };
  comparisonStatus: string;
  comparisons: unknown[];
  nextAction: {
    code: string;
    summary: string;
  };
  interactionProofs?: Array<{
    healthStatus: string;
    label: string;
    runDir: string;
    runId: string;
    runnerId: string;
    scenarioId: string;
    summaryPath: string;
    verdictStatus: string;
  }>;
  platform: string;
  profiles: Array<{
    healthStatus: string;
    label: string;
    runId: string;
    scenarioId: string;
    verdictStatus: string;
  }>;
  runId: string;
  status: string;
  summary: string;
};
type LiveProofComparisonCounts = LiveProofArtifact['comparisonCounts'];
type LiveProofComparisonStatus = keyof LiveProofComparisonCounts;
type LiveProofAggregateStatus = (
  'baseline_missing' |
  'improved' |
  'inconclusive' |
  'mixed' |
  'not_compared' |
  'regressed' |
  'unchanged'
);
type LiveProofNextActionCode = LiveProofArtifact['nextAction']['code'];

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-live-proof --file <live-proof.json> [--fail-on-regression]',
    '',
    'Validates an aggregate live-proof artifact and prints its status and next action.',
    'Use --fail-on-regression to exit nonzero when comparisonStatus is regressed.',
  ], output);
}

/**
 * Parses a small flag set for the live-proof CLI.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

/**
 * Counts comparison outcomes from one live-proof comparison list.
 *
 * @param {Array<{status?: string}>} comparisons
 * @returns {LiveProofComparisonCounts}
 */
function countLiveProofComparisons(comparisons: Array<{status?: string}>): LiveProofComparisonCounts {
  const counts: LiveProofComparisonCounts = {
    better: 0,
    inconclusive: 0,
    mixed: 0,
    skipped: 0,
    unchanged: 0,
    worse: 0,
  };
  for (const comparison of comparisons) {
    const status = comparison.status as LiveProofComparisonStatus | undefined;
    if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }
  return counts;
}

/**
 * Collapses live-proof comparison pointers into the expected aggregate status.
 *
 * @param {Array<{status?: string}>} comparisons
 * @returns {LiveProofAggregateStatus}
 */
function deriveLiveProofComparisonStatus(comparisons: Array<{status?: string}>): LiveProofAggregateStatus {
  if (comparisons.length === 0) {
    return 'not_compared';
  }

  const statuses = comparisons.map((comparison) => comparison.status);
  if (statuses.includes('worse')) {
    return 'regressed';
  }
  if (statuses.includes('inconclusive')) {
    return 'inconclusive';
  }
  if (statuses.every((status) => status === 'skipped')) {
    return 'baseline_missing';
  }
  if (statuses.includes('skipped')) {
    return 'inconclusive';
  }
  if (statuses.includes('mixed')) {
    return 'mixed';
  }
  if (statuses.includes('better')) {
    return 'improved';
  }
  return 'unchanged';
}

/**
 * Resolves the expected next-action code for an aggregate comparison status.
 *
 * @param {LiveProofAggregateStatus} comparisonStatus
 * @returns {LiveProofNextActionCode}
 */
function expectedLiveProofNextActionCode(comparisonStatus: LiveProofAggregateStatus): LiveProofNextActionCode {
  if (comparisonStatus === 'regressed') {
    return 'inspect_regressions';
  }
  if (comparisonStatus === 'baseline_missing') {
    return 'establish_baseline';
  }
  if (comparisonStatus === 'inconclusive') {
    return 'inspect_inconclusive';
  }
  if (comparisonStatus === 'mixed') {
    return 'inspect_mixed';
  }
  return 'inspect_summary';
}

/**
 * Verifies that aggregate comparison counts match the comparison pointers.
 *
 * @param {LiveProofArtifact} proof
 * @returns {void}
 */
function assertLiveProofComparisonCounts(proof: LiveProofArtifact): void {
  const actual = countLiveProofComparisons(proof.comparisons as Array<{status?: string}>);
  for (const key of Object.keys(actual) as LiveProofComparisonStatus[]) {
    if (actual[key] !== proof.comparisonCounts[key]) {
      throw new Error(
        `Live proof artifact comparisonCounts.${key} expected ${actual[key]} from comparisons but found ${proof.comparisonCounts[key]}.`,
      );
    }
  }
}

/**
 * Verifies that aggregate comparison status and next action match the pointers.
 *
 * @param {LiveProofArtifact} proof
 * @returns {void}
 */
function assertLiveProofAggregateSignals(proof: LiveProofArtifact): void {
  const expectedStatus = deriveLiveProofComparisonStatus(proof.comparisons as Array<{status?: string}>);
  if (proof.comparisonStatus !== expectedStatus) {
    throw new Error(
      `Live proof artifact comparisonStatus expected ${expectedStatus} from comparisons but found ${proof.comparisonStatus}.`,
    );
  }

  const expectedAction = expectedLiveProofNextActionCode(expectedStatus);
  if (proof.nextAction.code !== expectedAction) {
    throw new Error(
      `Live proof artifact nextAction.code expected ${expectedAction} for ${expectedStatus} but found ${proof.nextAction.code}.`,
    );
  }
}

/**
 * Reads and validates a live-proof artifact.
 *
 * @param {string} filePath
 * @returns {LiveProofArtifact}
 */
function readLiveProof(filePath: string): LiveProofArtifact {
  const proof = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  const validated = assertValidJson(proof, SCHEMAS.liveProof, 'Live proof artifact') as LiveProofArtifact;
  assertLiveProofComparisonCounts(validated);
  assertLiveProofAggregateSignals(validated);
  return validated;
}

/**
 * Formats a live-proof artifact for CLI output.
 *
 * @param {LiveProofArtifact} proof
 * @returns {string}
 */
function formatLiveProof(proof: LiveProofArtifact): string {
  return [
    `Live proof: ${proof.platform} ${proof.runId}`,
    `Status: ${proof.status}`,
    `Comparison status: ${proof.comparisonStatus}`,
    `Profiles: ${proof.profiles.length}`,
    ...proof.profiles.map((profile) => (
      `- ${profile.label} (${profile.scenarioId}/${profile.runId}): health=${profile.healthStatus} verdict=${profile.verdictStatus}`
    )),
    `Interaction proofs: ${proof.interactionProofs?.length ?? 0}`,
    ...(proof.interactionProofs ?? []).map((proofPointer) => (
      `- ${proofPointer.label} (${proofPointer.runnerId}/${proofPointer.scenarioId}/${proofPointer.runId}): health=${proofPointer.healthStatus} verdict=${proofPointer.verdictStatus}`
    )),
    `Comparisons: ${proof.comparisons.length}`,
    `Comparison counts: better=${proof.comparisonCounts.better} worse=${proof.comparisonCounts.worse} unchanged=${proof.comparisonCounts.unchanged} mixed=${proof.comparisonCounts.mixed} inconclusive=${proof.comparisonCounts.inconclusive} skipped=${proof.comparisonCounts.skipped}`,
    `Next action: ${proof.nextAction.code} - ${proof.nextAction.summary}`,
    `Summary: ${proof.summary}`,
  ].join('\n');
}

/**
 * Returns whether the caller requested a regression gate and the proof regressed.
 *
 * @param {{failOnRegression: boolean, proof: LiveProofArtifact}} options
 * @returns {boolean}
 */
function shouldFailOnRegression({
  failOnRegression,
  proof,
}: {
  failOnRegression: boolean;
  proof: LiveProofArtifact;
}): boolean {
  return failOnRegression && proof.comparisonStatus === 'regressed';
}

/**
 * Runs the live-proof inspection CLI.
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
  if (typeof args.file !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  const proof = readLiveProof(args.file);
  process.stdout.write(`${formatLiveProof(proof)}\n`);
  if (shouldFailOnRegression({
    failOnRegression: args['fail-on-regression'] === true || args['fail-on-regression'] === 'true',
    proof,
  })) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertLiveProofAggregateSignals,
  assertLiveProofComparisonCounts,
  countLiveProofComparisons,
  deriveLiveProofComparisonStatus,
  expectedLiveProofNextActionCode,
  formatLiveProof,
  main,
  parseArgs,
  readLiveProof,
  shouldFailOnRegression,
  usage,
};

export type {
  CliArgs,
  LiveProofArtifact,
};
