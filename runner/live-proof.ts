#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  file?: string | string[] | boolean;
  'fail-on-regression'?: string | boolean;
  'require-platforms'?: string | boolean;
  [key: string]: string | string[] | boolean | undefined;
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
  comparisons: LiveProofComparisonPointer[];
  nextAction: {
    code: string;
    summary: string;
  };
  interactionProofs?: Array<{
    captures?: {
      screenshots?: string[];
    };
    healthStatus: string;
    label: string;
    runDir: string;
    runId: string;
    runnerId: string;
    scenarioId: string;
    summaryPath: string;
    verdictStatus: string;
    warnings?: {
      checks?: Array<{
        code?: string;
        message?: string;
        name?: string;
        nextAction?: {
          code?: string;
          summary?: string;
        };
      }>;
      count?: number;
    };
  }>;
  skippedInteractionProofs?: Array<{
    label: string;
    nextAction: {
      code: string;
      summary: string;
    };
    reason: string;
    runId: string;
    runnerId: string;
    scenarioId: string;
  }>;
  platform: 'android' | 'ios';
  preflight: {
    healthStatus: string;
    runId: string;
    verdictStatus: string;
  };
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
type LiveProofMetricStatus = 'better' | 'worse' | 'unchanged' | 'inconclusive';
type LiveProofPlatform = LiveProofArtifact['platform'];
type LiveProofComparisonPointer = {
  label?: string;
  metricSummary?: {
    counts?: Record<LiveProofMetricStatus, number>;
    notableMetrics?: Array<{
      delta?: number | null;
      name?: string;
      status?: Exclude<LiveProofMetricStatus, 'unchanged'>;
      unit?: string;
    }>;
  };
  runId?: string;
  scenarioId?: string;
  status?: string;
};
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
    'Usage: asl-live-proof --file <live-proof.json> [--file <live-proof.json> ...] [--require-platforms android,ios] [--fail-on-regression]',
    '',
    'Validates one or more aggregate live-proof artifacts and prints status and next action details.',
    'Use --require-platforms to fail when a platform proof is missing from a multi-artifact gate.',
    'Use --fail-on-regression to exit nonzero when comparisonStatus is regressed.',
  ], output);
}

/**
 * Adds one parsed CLI argument, preserving repeated --file flags.
 *
 * @param {CliArgs} args
 * @param {string} key
 * @param {string | boolean} value
 * @returns {void}
 */
function assignArg(args: CliArgs, key: string, value: string | boolean): void {
  if (key !== 'file' || typeof value !== 'string') {
    args[key] = value;
    return;
  }

  if (Array.isArray(args.file)) {
    args.file.push(value);
    return;
  }

  if (typeof args.file === 'string') {
    args.file = [args.file, value];
    return;
  }

  args.file = value;
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
      assignArg(args, key, true);
      continue;
    }

    assignArg(args, key, next);
    index += 1;
  }
  return args;
}

/**
 * Resolves one or more --file values into a stable list.
 *
 * @param {CliArgs} args
 * @returns {string[]}
 */
function resolveLiveProofFiles(args: CliArgs): string[] {
  if (Array.isArray(args.file)) {
    return args.file;
  }
  return typeof args.file === 'string' ? [args.file] : [];
}

/**
 * Parses required platform names for a live-proof set gate.
 *
 * @param {string | boolean | undefined} value
 * @returns {LiveProofPlatform[]}
 */
function parseRequiredPlatforms(value: string | boolean | undefined): LiveProofPlatform[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== 'string') {
    throw new Error('--require-platforms expects a comma-separated platform list such as android,ios.');
  }

  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter((platform) => platform.length > 0);
  const invalid = platforms.filter((platform) => platform !== 'android' && platform !== 'ios');
  if (invalid.length > 0) {
    throw new Error(`Unsupported required live-proof platform(s): ${invalid.join(', ')}.`);
  }

  return Array.from(new Set(platforms)) as LiveProofPlatform[];
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
 * Resolves the expected next-action code for an aggregate proof status.
 *
 * @param {LiveProofAggregateStatus} comparisonStatus
 * @param {string} [status]
 * @returns {LiveProofNextActionCode}
 */
function expectedLiveProofNextActionCode(
  comparisonStatus: LiveProofAggregateStatus,
  status = 'passed',
): LiveProofNextActionCode {
  if (status === 'failed') {
    return 'inspect_failed_run';
  }

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
  const actual = countLiveProofComparisons(proof.comparisons);
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
  const expectedStatus = deriveLiveProofComparisonStatus(proof.comparisons);
  if (proof.comparisonStatus !== expectedStatus) {
    throw new Error(
      `Live proof artifact comparisonStatus expected ${expectedStatus} from comparisons but found ${proof.comparisonStatus}.`,
    );
  }

  const expectedAction = expectedLiveProofNextActionCode(expectedStatus, proof.status);
  if (proof.nextAction.code !== expectedAction) {
    throw new Error(
      `Live proof artifact nextAction.code expected ${expectedAction} for ${proof.status}/${expectedStatus} but found ${proof.nextAction.code}.`,
    );
  }
}

/**
 * Formats one metric highlight from a comparison pointer.
 *
 * @param {{delta?: number | null, name?: string, status?: string, unit?: string}} metric
 * @returns {string}
 */
function formatMetricHighlight(metric: {delta?: number | null; name?: string; status?: string; unit?: string}): string {
  const delta = typeof metric.delta === 'number' ? `${metric.delta}${metric.unit ?? ''}` : 'n/a';
  return `${metric.name ?? 'unknown metric'} ${metric.status ?? 'unknown'} (${delta})`;
}

/**
 * Formats compact metric summary details for one comparison pointer.
 *
 * @param {LiveProofComparisonPointer} comparison
 * @returns {string}
 */
function formatComparisonPointerMetrics(comparison: LiveProofComparisonPointer): string {
  const counts = comparison.metricSummary?.counts;
  if (!counts) {
    return '';
  }

  const highlights = comparison.metricSummary?.notableMetrics ?? [];
  const highlightText = highlights.length > 0
    ? `; notable: ${highlights.map(formatMetricHighlight).join(', ')}`
    : '';

  return ` (metrics better=${counts.better} worse=${counts.worse} unchanged=${counts.unchanged} inconclusive=${counts.inconclusive}${highlightText})`;
}

/**
 * Formats capture counts for one interaction proof pointer.
 *
 * @param {{captures?: {screenshots?: string[]}}} proofPointer
 * @returns {string}
 */
function formatInteractionProofCaptures(proofPointer: {captures?: {screenshots?: string[]}}): string {
  const screenshotCount = proofPointer.captures?.screenshots?.length ?? 0;
  return screenshotCount > 0 ? ` screenshots=${screenshotCount}` : '';
}

/**
 * Formats warning counts for one interaction proof pointer.
 *
 * @param {{warnings?: {count?: number}}} proofPointer
 * @returns {string}
 */
function formatInteractionProofWarnings(proofPointer: {warnings?: {count?: number}}): string {
  const warningCount = proofPointer.warnings?.count ?? 0;
  return warningCount > 0 ? ` warnings=${warningCount}` : '';
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
 * Verifies that a multi-proof gate includes every required platform.
 *
 * @param {LiveProofArtifact[]} proofs
 * @param {LiveProofPlatform[]} requiredPlatforms
 * @returns {void}
 */
function assertLiveProofSetRequiredPlatforms(
  proofs: LiveProofArtifact[],
  requiredPlatforms: LiveProofPlatform[],
): void {
  if (requiredPlatforms.length === 0) {
    return;
  }

  const present = new Set(proofs.map((proof) => proof.platform));
  const missing = requiredPlatforms.filter((platform) => !present.has(platform));
  if (missing.length === 0) {
    return;
  }

  const presentText = Array.from(present).sort().join(', ') || 'none';
  throw new Error(
    `Live proof set missing required platform(s): ${missing.join(', ')}. Present platform(s): ${presentText}.`,
  );
}

/**
 * Reads and validates a platform proof set.
 *
 * @param {{files: string[], requiredPlatforms?: LiveProofPlatform[]}} options
 * @returns {LiveProofArtifact[]}
 */
function readLiveProofSet({
  files,
  requiredPlatforms = [],
}: {
  files: string[];
  requiredPlatforms?: LiveProofPlatform[];
}): LiveProofArtifact[] {
  const proofs = files.map(readLiveProof);
  assertLiveProofSetRequiredPlatforms(proofs, requiredPlatforms);
  return proofs;
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
    `Preflight: ${proof.preflight.runId} health=${proof.preflight.healthStatus} verdict=${proof.preflight.verdictStatus}`,
    `Profiles: ${proof.profiles.length}`,
    ...proof.profiles.map((profile) => (
      `- ${profile.label} (${profile.scenarioId}/${profile.runId}): health=${profile.healthStatus} verdict=${profile.verdictStatus}`
    )),
    `Interaction proofs: ${proof.interactionProofs?.length ?? 0}`,
    ...(proof.interactionProofs ?? []).map((proofPointer) => (
      `- ${proofPointer.label} (${proofPointer.runnerId}/${proofPointer.scenarioId}/${proofPointer.runId}): health=${proofPointer.healthStatus} verdict=${proofPointer.verdictStatus}${formatInteractionProofCaptures(proofPointer)}${formatInteractionProofWarnings(proofPointer)}`
    )),
    `Skipped interaction proofs: ${proof.skippedInteractionProofs?.length ?? 0}`,
    ...(proof.skippedInteractionProofs ?? []).map((proofPointer) => (
      `- ${proofPointer.label} (${proofPointer.runnerId}/${proofPointer.scenarioId}/${proofPointer.runId}): ${proofPointer.reason} next=${proofPointer.nextAction.code}`
    )),
    `Comparisons: ${proof.comparisons.length}`,
    `Comparison counts: better=${proof.comparisonCounts.better} worse=${proof.comparisonCounts.worse} unchanged=${proof.comparisonCounts.unchanged} mixed=${proof.comparisonCounts.mixed} inconclusive=${proof.comparisonCounts.inconclusive} skipped=${proof.comparisonCounts.skipped}`,
    ...proof.comparisons.map((comparison) => (
      `- ${comparison.label ?? 'comparison'} (${comparison.scenarioId ?? 'unknown-scenario'}/${comparison.runId ?? 'unknown-run'}): ${comparison.status ?? 'unknown'}${formatComparisonPointerMetrics(comparison)}`
    )),
    `Next action: ${proof.nextAction.code} - ${proof.nextAction.summary}`,
    `Summary: ${proof.summary}`,
  ].join('\n');
}

/**
 * Formats one or more live-proof artifacts for CLI output.
 *
 * @param {{proofs: LiveProofArtifact[], requiredPlatforms?: LiveProofPlatform[]}} options
 * @returns {string}
 */
function formatLiveProofSet({
  proofs,
  requiredPlatforms = [],
}: {
  proofs: LiveProofArtifact[];
  requiredPlatforms?: LiveProofPlatform[];
}): string {
  if (proofs.length === 1 && requiredPlatforms.length === 0) {
    const [proof] = proofs;
    if (proof) {
      return formatLiveProof(proof);
    }
  }

  return [
    `Live proof set: ${proofs.length} artifact(s)`,
    requiredPlatforms.length > 0 ? `Required platforms: ${requiredPlatforms.join(', ')}` : null,
    `Present platforms: ${Array.from(new Set(proofs.map((proof) => proof.platform))).sort().join(', ')}`,
    '',
    ...proofs.map(formatLiveProof),
  ].filter((line): line is string => line !== null).join('\n');
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
 * Returns whether a live-proof set should make the CLI exit nonzero.
 *
 * @param {{failOnRegression: boolean, proofs: LiveProofArtifact[]}} options
 * @returns {boolean}
 */
function shouldFailLiveProofSet({
  failOnRegression,
  proofs,
}: {
  failOnRegression: boolean;
  proofs: LiveProofArtifact[];
}): boolean {
  return proofs.some((proof) => proof.status === 'failed' || shouldFailOnRegression({ failOnRegression, proof }));
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
  const files = resolveLiveProofFiles(args);
  if (files.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const requiredPlatforms = parseRequiredPlatforms(args['require-platforms']);
  const proofs = readLiveProofSet({ files, requiredPlatforms });
  process.stdout.write(`${formatLiveProofSet({ proofs, requiredPlatforms })}\n`);
  if (shouldFailLiveProofSet({
    failOnRegression: args['fail-on-regression'] === true || args['fail-on-regression'] === 'true',
    proofs,
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
  assertLiveProofSetRequiredPlatforms,
  countLiveProofComparisons,
  deriveLiveProofComparisonStatus,
  expectedLiveProofNextActionCode,
  formatComparisonPointerMetrics,
  formatInteractionProofCaptures,
  formatInteractionProofWarnings,
  formatLiveProof,
  formatLiveProofSet,
  main,
  parseArgs,
  parseRequiredPlatforms,
  readLiveProof,
  readLiveProofSet,
  resolveLiveProofFiles,
  shouldFailLiveProofSet,
  shouldFailOnRegression,
  usage,
};

export type {
  CliArgs,
  LiveProofArtifact,
};
