#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  'artifact-base-dir'?: string | boolean;
  file?: string | string[] | boolean;
  'fail-on-regression'?: string | boolean;
  out?: string | boolean;
  'require-artifacts'?: string | boolean;
  'require-platforms'?: string | boolean;
  'run-id'?: string | boolean;
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
    low_confidence: number;
  };
  comparisonStatus: string;
  comparisons: LiveProofComparisonPointer[];
  nextAction: {
    code: string;
    owner?: LiveProofNextActionOwner;
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
          owner?: LiveProofNextActionOwner;
          summary?: string;
        };
      }>;
      count?: number;
    };
  }>;
  skippedInteractionProofs?: LiveProofSkippedInteractionProofPointer[];
  platform: 'android' | 'ios';
  preflight: {
    healthStatus: string;
    runId: string;
    runDir: string;
    summaryPath: string;
    verdictStatus: string;
  };
  profiles: Array<{
    healthStatus: string;
    label: string;
    runId: string;
    runDir: string;
    scenarioId: string;
    summaryPath: string;
    verdictStatus: string;
  }>;
  profileNativePerformance?: LiveProofProfileNativePerformanceRollup;
  runId: string;
  status: string;
  summary: string;
};
type LiveProofComparisonCounts = LiveProofArtifact['comparisonCounts'];
type LiveProofComparisonStatus = keyof LiveProofComparisonCounts;
type LiveProofMetricStatus = 'better' | 'worse' | 'unchanged' | 'inconclusive' | 'low_confidence';
type LiveProofPlatform = LiveProofArtifact['platform'];
type LiveProofComparisonPointer = {
  baselineDir?: string | null;
  comparisonDir?: string | null;
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
  summaryPath?: string | null;
};
type LiveProofAggregateStatus = (
  'baseline_missing' |
  'improved' |
  'inconclusive' |
  'low_confidence' |
  'mixed' |
  'not_compared' |
  'regressed' |
  'unchanged'
);
type LiveProofNextActionCode = (
  'establish_baseline' |
  'inspect_failed_run' |
  'inspect_inconclusive' |
  'inspect_low_confidence' |
  'inspect_mixed' |
  'inspect_regressions' |
  'inspect_summary'
);
type LiveProofNextActionOwner = (
  'app_truth' |
  'asl_runner' |
  'product_optimization' |
  'provider_tooling' |
  'runtime_environment' |
  'scenario_contract'
);
type LiveProofDiagnosticSufficiencyEntry = {
  kind: string;
  status: string;
};
type LiveProofDiagnosticSufficiencyCount = LiveProofDiagnosticSufficiencyEntry & {
  count: number;
};
type LiveProofNativePerformanceSourceEntry = {
  sourceId: string;
  status: string;
};
type LiveProofProfileGateDiagnostics = {
  blockingDiagnosticSufficiency?: LiveProofDiagnosticSufficiencyEntry[];
  capturedDiagnosticSufficiency?: LiveProofDiagnosticSufficiencyEntry[];
  nativePerformance?: {
    claimSufficiency?: string;
    comparability?: string;
    diagnosticSources?: LiveProofNativePerformanceSourceEntry[];
    targetBinding?: string;
  };
};
type LiveProofProfileGateReadiness = {
  commandCount?: number;
  devClientDeepLinkOpened?: boolean;
  expectedEvidence?: string;
  failureClass?: string;
  foregroundAppInfoCaptured?: boolean;
  foregroundApplicationState?: string;
  foregroundRawPath?: string;
  foregroundTargetOwned?: boolean;
  lastDeepLinkLabel?: string;
  pendingPhase?: string;
  profileSessionSeedRawPath?: string;
  profileSessionSeeded?: boolean;
  readinessRawPath?: string;
};
type LiveProofSkippedInteractionProofPointer = {
  label: string;
  nextAction: {
    code: string;
    owner?: LiveProofNextActionOwner;
    summary: string;
  };
  profileGateDiagnostics?: LiveProofProfileGateDiagnostics;
  profileGateReadiness?: LiveProofProfileGateReadiness;
  reason: string;
  runId: string;
  runnerId: string;
  scenarioId: string;
};
type LiveProofNativePerformanceCount = {
  count: number;
  status: string;
};
type LiveProofNativePerformanceSourceCount = {
  count: number;
  sourceId: string;
  status: string;
};
type LiveProofProfileGateReadinessBooleanCount = {
  count: number;
  value: boolean;
};
type LiveProofProfileGateReadinessValueCount = {
  count: number;
  value: string;
};
type LiveProofProfileNativePerformanceRollup = {
  claimSufficiencyCounts?: LiveProofNativePerformanceCount[];
  comparabilityCounts?: LiveProofNativePerformanceCount[];
  diagnosticSourceCounts?: LiveProofNativePerformanceSourceCount[];
  evidenceCount: number;
  profileCount: number;
  targetBindingCounts?: LiveProofNativePerformanceCount[];
};
type LiveProofSetProfileGateDiagnosticSufficiencyRollup = {
  blockingDiagnosticSufficiencyCounts?: LiveProofDiagnosticSufficiencyCount[];
  capturedDiagnosticSufficiencyCounts?: LiveProofDiagnosticSufficiencyCount[];
  skippedInteractionProofCount: number;
};
type LiveProofSetProfileGateNativePerformanceRollup = {
  claimSufficiencyCounts?: LiveProofNativePerformanceCount[];
  comparabilityCounts?: LiveProofNativePerformanceCount[];
  diagnosticSourceCounts?: LiveProofNativePerformanceSourceCount[];
  skippedInteractionProofCount: number;
  targetBindingCounts?: LiveProofNativePerformanceCount[];
};
type LiveProofSetProfileGateReadinessRollup = {
  commandCountTotal?: number;
  devClientDeepLinkOpenedCounts?: LiveProofProfileGateReadinessBooleanCount[];
  expectedEvidenceCounts?: LiveProofProfileGateReadinessValueCount[];
  failureClassCounts?: LiveProofProfileGateReadinessValueCount[];
  foregroundAppInfoCapturedCounts?: LiveProofProfileGateReadinessBooleanCount[];
  foregroundApplicationStateCounts?: LiveProofProfileGateReadinessValueCount[];
  foregroundTargetOwnedCounts?: LiveProofProfileGateReadinessBooleanCount[];
  pendingPhaseCounts?: LiveProofProfileGateReadinessValueCount[];
  profileSessionSeededCounts?: LiveProofProfileGateReadinessBooleanCount[];
  readinessProofCount: number;
  skippedInteractionProofCount: number;
};
type LiveProofSetArtifact = {
  failureReasons: string[];
  missingPlatforms: LiveProofPlatform[];
  nextAction: {
    code: string;
    owner?: LiveProofNextActionOwner;
    summary: string;
  };
  presentPlatforms: LiveProofPlatform[];
  profileGateDiagnosticSufficiency?: LiveProofSetProfileGateDiagnosticSufficiencyRollup;
  profileGateNativePerformance?: LiveProofSetProfileGateNativePerformanceRollup;
  profileGateReadiness?: LiveProofSetProfileGateReadinessRollup;
  profileNativePerformance?: LiveProofProfileNativePerformanceRollup;
  proofCount: number;
  proofs: LiveProofSetProofPointer[];
  requiredPlatforms: LiveProofPlatform[];
  runId: string;
  schemaVersion: '1.0.0';
  skippedInteractionProofCount?: number;
  skippedInteractionProofs?: LiveProofSetSkippedInteractionProofPointer[];
  status: 'failed' | 'passed';
  summary: string;
};
type LiveProofSetProofPointer = {
  comparisonStatus: string;
  filePath: string;
  interactionProofCount: number;
  interactionWarnings?: LiveProofSetInteractionWarningPointer[];
  interactionWarningCount: number;
  nextAction: {
    code: string;
    owner?: LiveProofNextActionOwner;
    summary: string;
  };
  platform: LiveProofPlatform;
  profileCount: number;
  runId: string;
  status: string;
  summaryPath: string;
};
type LiveProofSetInteractionWarningPointer = {
  checks: Array<{
    code: string;
    message: string;
    name: string;
    nextAction?: {
      code: string;
      owner?: LiveProofNextActionOwner;
      summary: string;
    };
  }>;
  label: string;
  runId: string;
  runnerId: string;
  scenarioId: string;
};
type LiveProofSetSkippedInteractionProofPointer = LiveProofSkippedInteractionProofPointer & {
  platform: LiveProofPlatform;
  proofFilePath: string;
  proofRunId: string;
};
type LiveProofArtifactPointerIssue = {
  expected: 'directory' | 'file';
  label: string;
  path: string;
  reason: string;
};
type LiveProofArtifactReadOptions = {
  artifactBaseDir?: string;
  requireArtifacts?: boolean;
};

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-live-proof --file <live-proof.json> [--file <live-proof.json> ...] [--require-platforms android,ios] [--out <dir>] [--run-id <id>] [--fail-on-regression]',
    '',
    'Validates one or more aggregate live-proof artifacts and prints status and next action details.',
    'Use --require-platforms to fail when a platform proof is missing from a multi-artifact gate.',
    'Use --require-artifacts to fail when live-proof pointers reference missing local evidence files.',
    'Use --artifact-base-dir <dir> to resolve relative artifact pointers from a directory other than cwd.',
    'Use --out to write live-proof-set.json and agent-summary.md for a durable platform-set gate.',
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
    low_confidence: 0,
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
  if (statuses.includes('low_confidence')) {
    return 'low_confidence';
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
  if (comparisonStatus === 'low_confidence') {
    return 'inspect_low_confidence';
  }
  if (comparisonStatus === 'mixed') {
    return 'inspect_mixed';
  }
  return 'inspect_summary';
}

/**
 * Resolves the expected owner for an aggregate proof next action.
 *
 * @param {LiveProofNextActionCode} actionCode
 * @returns {LiveProofNextActionOwner}
 */
function expectedLiveProofNextActionOwner(actionCode: LiveProofNextActionCode): LiveProofNextActionOwner {
  switch (actionCode) {
    case 'inspect_failed_run':
      return 'asl_runner';
    case 'inspect_regressions':
    case 'inspect_mixed':
    case 'inspect_summary':
      return 'product_optimization';
    case 'establish_baseline':
    case 'inspect_inconclusive':
    case 'inspect_low_confidence':
      return 'scenario_contract';
  }
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
  if (proof.nextAction.owner && proof.nextAction.owner !== expectedLiveProofNextActionOwner(expectedAction)) {
    throw new Error(
      `Live proof artifact nextAction.owner expected ${expectedLiveProofNextActionOwner(expectedAction)} for ${proof.nextAction.code} but found ${proof.nextAction.owner}.`,
    );
  }
}

/**
 * Resolves a pointer path using the CLI working directory by default.
 *
 * @param {string} pointerPath
 * @param {string} baseDir
 * @returns {string}
 */
function resolveLiveProofPointerPath(pointerPath: string, baseDir: string): string {
  return path.isAbsolute(pointerPath) ? pointerPath : path.resolve(baseDir, pointerPath);
}

/**
 * Records a pointer issue when a referenced local artifact is missing.
 *
 * @param {LiveProofArtifactPointerIssue[]} issues
 * @param {{baseDir: string, expected: 'directory' | 'file', label: string, pointerPath?: string | null | undefined}} options
 * @returns {void}
 */
function collectExistingPointerIssue(
  issues: LiveProofArtifactPointerIssue[],
  {
    baseDir,
    expected,
    label,
    pointerPath,
  }: {
    baseDir: string;
    expected: 'directory' | 'file';
    label: string;
    pointerPath?: string | null | undefined;
  },
): void {
  if (!pointerPath) {
    issues.push({
      expected,
      label,
      path: '<missing pointer>',
      reason: 'pointer is empty',
    });
    return;
  }

  const resolvedPath = resolveLiveProofPointerPath(pointerPath, baseDir);
  let stats: ReturnType<typeof fs.statSync>;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    issues.push({
      expected,
      label,
      path: resolvedPath,
      reason: 'path does not exist',
    });
    return;
  }

  if (expected === 'directory' && !stats.isDirectory()) {
    issues.push({
      expected,
      label,
      path: resolvedPath,
      reason: 'path is not a directory',
    });
  }
  if (expected === 'file' && !stats.isFile()) {
    issues.push({
      expected,
      label,
      path: resolvedPath,
      reason: 'path is not a file',
    });
  }
}

/**
 * Collects missing local evidence pointers from one live-proof artifact.
 *
 * @param {LiveProofArtifact} proof
 * @param {{artifactBaseDir?: string}} [options]
 * @returns {LiveProofArtifactPointerIssue[]}
 */
function collectLiveProofArtifactPointerIssues(
  proof: LiveProofArtifact,
  { artifactBaseDir = process.cwd() }: {artifactBaseDir?: string} = {},
): LiveProofArtifactPointerIssue[] {
  const issues: LiveProofArtifactPointerIssue[] = [];
  const baseDir = path.resolve(artifactBaseDir);
  collectExistingPointerIssue(issues, {
    baseDir,
    expected: 'directory',
    label: `preflight ${proof.preflight.runId} runDir`,
    pointerPath: proof.preflight.runDir,
  });
  collectExistingPointerIssue(issues, {
    baseDir,
    expected: 'file',
    label: `preflight ${proof.preflight.runId} summaryPath`,
    pointerPath: proof.preflight.summaryPath,
  });

  for (const profile of proof.profiles) {
    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'directory',
      label: `profile ${profile.label} runDir`,
      pointerPath: profile.runDir,
    });
    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'file',
      label: `profile ${profile.label} summaryPath`,
      pointerPath: profile.summaryPath,
    });
  }

  for (const interactionProof of proof.interactionProofs ?? []) {
    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'directory',
      label: `interaction ${interactionProof.label} runDir`,
      pointerPath: interactionProof.runDir,
    });
    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'file',
      label: `interaction ${interactionProof.label} summaryPath`,
      pointerPath: interactionProof.summaryPath,
    });
    for (const screenshotPath of interactionProof.captures?.screenshots ?? []) {
      collectExistingPointerIssue(issues, {
        baseDir,
        expected: 'file',
        label: `interaction ${interactionProof.label} screenshot`,
        pointerPath: path.isAbsolute(screenshotPath)
          ? screenshotPath
          : path.join(interactionProof.runDir, screenshotPath),
      });
    }
  }

  for (const comparison of proof.comparisons) {
    if (comparison.status === 'skipped') {
      continue;
    }

    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'directory',
      label: `comparison ${comparison.label ?? 'comparison'} baselineDir`,
      pointerPath: comparison.baselineDir,
    });
    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'directory',
      label: `comparison ${comparison.label ?? 'comparison'} comparisonDir`,
      pointerPath: comparison.comparisonDir,
    });
    collectExistingPointerIssue(issues, {
      baseDir,
      expected: 'file',
      label: `comparison ${comparison.label ?? 'comparison'} summaryPath`,
      pointerPath: comparison.summaryPath,
    });
  }

  return issues;
}

/**
 * Fails when a live-proof artifact references missing local evidence.
 *
 * @param {LiveProofArtifact} proof
 * @param {{artifactBaseDir?: string}} [options]
 * @returns {void}
 */
function assertLiveProofArtifactPointers(
  proof: LiveProofArtifact,
  options: {artifactBaseDir?: string} = {},
): void {
  const issues = collectLiveProofArtifactPointerIssues(proof, options);
  if (issues.length === 0) {
    return;
  }

  const preview = issues
    .slice(0, 8)
    .map((issue) => `${issue.label} -> ${issue.path} (${issue.reason})`)
    .join('; ');
  const suffix = issues.length > 8 ? `; ${issues.length - 8} more` : '';
  throw new Error(`Live proof artifact pointers missing: ${preview}${suffix}.`);
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

  return ` (metrics better=${counts.better} worse=${counts.worse} unchanged=${counts.unchanged} inconclusive=${counts.inconclusive} low_confidence=${counts.low_confidence}${highlightText})`;
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
 * Formats warning check details for one interaction proof pointer.
 *
 * @param {{warnings?: {checks?: Array<{code?: string, message?: string, name?: string, nextAction?: {code?: string, owner?: LiveProofNextActionOwner, summary?: string}}>}}} proofPointer
 * @returns {string[]}
 */
function formatInteractionProofWarningDetails(proofPointer: {
  warnings?: {
    checks?: Array<{
      code?: string;
      message?: string;
      name?: string;
      nextAction?: {
        code?: string;
        owner?: LiveProofNextActionOwner;
        summary?: string;
      };
    }>;
  };
}): string[] {
  return (proofPointer.warnings?.checks ?? []).map((warning) => {
    const nextAction = warning.nextAction?.code || warning.nextAction?.summary
      ? ` next=${warning.nextAction?.owner ?? 'unknown'}/${warning.nextAction?.code ?? 'inspect_interaction_warning'}${warning.nextAction?.summary ? ` - ${warning.nextAction.summary}` : ''}`
      : '';
    return `  warning ${warning.name ?? 'interaction_warning'}: ${warning.code ?? 'warning'} - ${warning.message ?? 'Interaction proof emitted a warning.'}${nextAction}`;
  });
}

/**
 * Reads and validates a live-proof artifact.
 *
 * @param {string} filePath
 * @param {LiveProofArtifactReadOptions} [options]
 * @returns {LiveProofArtifact}
 */
function readLiveProof(filePath: string, options: LiveProofArtifactReadOptions = {}): LiveProofArtifact {
  const proof = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  const validated = assertValidJson(proof, SCHEMAS.liveProof, 'Live proof artifact') as LiveProofArtifact;
  assertLiveProofComparisonCounts(validated);
  assertLiveProofAggregateSignals(validated);
  if (options.requireArtifacts) {
    assertLiveProofArtifactPointers(
      validated,
      options.artifactBaseDir === undefined ? {} : { artifactBaseDir: options.artifactBaseDir },
    );
  }
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
 * @param {{artifactBaseDir?: string, files: string[], requiredPlatforms?: LiveProofPlatform[], requireArtifacts?: boolean}} options
 * @returns {LiveProofArtifact[]}
 */
function readLiveProofSet({
  artifactBaseDir,
  files,
  requiredPlatforms = [],
  requireArtifacts = false,
}: {
  artifactBaseDir?: string;
  files: string[];
  requiredPlatforms?: LiveProofPlatform[];
  requireArtifacts?: boolean;
}): LiveProofArtifact[] {
  const readOptions: LiveProofArtifactReadOptions = { requireArtifacts };
  if (artifactBaseDir !== undefined) {
    readOptions.artifactBaseDir = artifactBaseDir;
  }
  const proofs = files.map((file) => readLiveProof(file, readOptions));
  assertLiveProofSetRequiredPlatforms(proofs, requiredPlatforms);
  return proofs;
}

/**
 * Resolves the optional proof-set artifact output directory.
 *
 * @param {CliArgs} args
 * @returns {string | null}
 */
function resolveLiveProofSetOutputDir(args: CliArgs): string | null {
  return typeof args.out === 'string' ? path.resolve(args.out) : null;
}

/**
 * Resolves the proof-set run id used for written artifacts.
 *
 * @param {CliArgs} args
 * @returns {string}
 */
function resolveLiveProofSetRunId(args: CliArgs): string {
  if (typeof args['run-id'] !== 'string') {
    return 'live-proof-set';
  }

  const normalized = args['run-id']
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96);
  return normalized.length > 0 ? normalized : 'live-proof-set';
}

/**
 * Resolves the base directory for local artifact pointer checks.
 *
 * @param {CliArgs} args
 * @returns {string | undefined}
 */
function resolveLiveProofArtifactBaseDir(args: CliArgs): string | undefined {
  if (args['artifact-base-dir'] === undefined) {
    return undefined;
  }
  if (typeof args['artifact-base-dir'] !== 'string') {
    throw new Error('--artifact-base-dir expects a directory path.');
  }
  return path.resolve(args['artifact-base-dir']);
}

/**
 * Returns whether the caller requested local artifact pointer checks.
 *
 * @param {CliArgs} args
 * @returns {boolean}
 */
function shouldRequireArtifacts(args: CliArgs): boolean {
  return args['require-artifacts'] === true || args['require-artifacts'] === 'true';
}

/**
 * Counts interaction warnings preserved by one live-proof artifact.
 *
 * @param {LiveProofArtifact} proof
 * @returns {number}
 */
function countInteractionWarnings(proof: LiveProofArtifact): number {
  return (proof.interactionProofs ?? []).reduce((sum, interactionProof) => (
    sum + (interactionProof.warnings?.count ?? 0)
  ), 0);
}

/**
 * Adds native-performance status counts into a proof-set accumulator.
 *
 * @param {Map<string, number>} counts
 * @param {LiveProofNativePerformanceCount[] | undefined} entries
 * @returns {void}
 */
function addNativePerformanceStatusCounts(
  counts: Map<string, number>,
  entries: LiveProofNativePerformanceCount[] | undefined,
): void {
  for (const entry of entries ?? []) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + entry.count);
  }
}

/**
 * Adds native-performance diagnostic source counts into a proof-set accumulator.
 *
 * @param {Map<string, number>} counts
 * @param {LiveProofNativePerformanceSourceCount[] | undefined} entries
 * @returns {void}
 */
function addNativePerformanceSourceCounts(
  counts: Map<string, number>,
  entries: LiveProofNativePerformanceSourceCount[] | undefined,
): void {
  for (const entry of entries ?? []) {
    const key = `${entry.sourceId}\u0000${entry.status}`;
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
}

/**
 * Converts accumulated native-performance status counts into stable artifact order.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofNativePerformanceCount[]}
 */
function formatNativePerformanceStatusCounts(
  counts: Map<string, number>,
): LiveProofNativePerformanceCount[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ count, status }));
}

/**
 * Converts accumulated native-performance source counts into stable artifact order.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofNativePerformanceSourceCount[]}
 */
function formatNativePerformanceSourceCounts(
  counts: Map<string, number>,
): LiveProofNativePerformanceSourceCount[] {
  return [...counts.entries()]
    .map(([key, count]) => {
      const [sourceId = '', status = ''] = key.split('\u0000');
      return { count, sourceId, status };
    })
    .sort((left, right) => (
      left.sourceId.localeCompare(right.sourceId) || left.status.localeCompare(right.status)
    ));
}

/**
 * Builds native-performance interpretation counts across linked live-proof artifacts.
 *
 * @param {LiveProofArtifact[]} proofs
 * @returns {LiveProofProfileNativePerformanceRollup | null}
 */
function buildLiveProofSetNativePerformanceRollup(
  proofs: LiveProofArtifact[],
): LiveProofProfileNativePerformanceRollup | null {
  const claimSufficiencyCounts = new Map<string, number>();
  const comparabilityCounts = new Map<string, number>();
  const diagnosticSourceCounts = new Map<string, number>();
  const targetBindingCounts = new Map<string, number>();
  let evidenceCount = 0;
  let profileCount = 0;

  for (const proof of proofs) {
    const rollup = proof.profileNativePerformance;
    if (!rollup) {
      continue;
    }
    evidenceCount += rollup.evidenceCount;
    profileCount += rollup.profileCount;
    addNativePerformanceStatusCounts(claimSufficiencyCounts, rollup.claimSufficiencyCounts);
    addNativePerformanceStatusCounts(comparabilityCounts, rollup.comparabilityCounts);
    addNativePerformanceSourceCounts(diagnosticSourceCounts, rollup.diagnosticSourceCounts);
    addNativePerformanceStatusCounts(targetBindingCounts, rollup.targetBindingCounts);
  }

  if (evidenceCount === 0) {
    return null;
  }

  const claimCounts = formatNativePerformanceStatusCounts(claimSufficiencyCounts);
  const comparableCounts = formatNativePerformanceStatusCounts(comparabilityCounts);
  const sourceCounts = formatNativePerformanceSourceCounts(diagnosticSourceCounts);
  const targetCounts = formatNativePerformanceStatusCounts(targetBindingCounts);
  return {
    ...(claimCounts.length > 0 ? { claimSufficiencyCounts: claimCounts } : {}),
    ...(comparableCounts.length > 0 ? { comparabilityCounts: comparableCounts } : {}),
    ...(sourceCounts.length > 0 ? { diagnosticSourceCounts: sourceCounts } : {}),
    evidenceCount,
    profileCount,
    ...(targetCounts.length > 0 ? { targetBindingCounts: targetCounts } : {}),
  };
}

/**
 * Builds warning detail pointers from one platform live-proof artifact.
 *
 * @param {LiveProofArtifact} proof
 * @returns {LiveProofSetInteractionWarningPointer[]}
 */
function buildLiveProofSetInteractionWarnings(proof: LiveProofArtifact): LiveProofSetInteractionWarningPointer[] {
  return (proof.interactionProofs ?? [])
    .filter((interactionProof) => (interactionProof.warnings?.checks?.length ?? 0) > 0)
    .map((interactionProof) => ({
      checks: (interactionProof.warnings?.checks ?? []).map((warning) => ({
        code: warning.code ?? 'warning',
        message: warning.message ?? 'Interaction proof emitted a warning.',
        name: warning.name ?? 'interaction_warning',
        ...(warning.nextAction?.code || warning.nextAction?.summary
          ? {
            nextAction: {
              code: warning.nextAction?.code ?? 'inspect_interaction_warning',
              ...(warning.nextAction?.owner ? { owner: warning.nextAction.owner } : {}),
              summary: warning.nextAction?.summary ?? 'Inspect the interaction proof warning.',
            },
          }
          : {}),
      })),
      label: interactionProof.label,
      runId: interactionProof.runId,
      runnerId: interactionProof.runnerId,
      scenarioId: interactionProof.scenarioId,
    }));
}

/**
 * Builds the compact pointer for one platform live-proof artifact.
 *
 * @param {{filePath: string, proof: LiveProofArtifact}} options
 * @returns {LiveProofSetProofPointer}
 */
function buildLiveProofSetProofPointer({
  filePath,
  proof,
}: {
  filePath: string;
  proof: LiveProofArtifact;
}): LiveProofSetProofPointer {
  const interactionWarnings = buildLiveProofSetInteractionWarnings(proof);
  return {
    comparisonStatus: proof.comparisonStatus,
    filePath,
    interactionProofCount: proof.interactionProofs?.length ?? 0,
    ...(interactionWarnings.length > 0 ? { interactionWarnings } : {}),
    interactionWarningCount: countInteractionWarnings(proof),
    nextAction: proof.nextAction,
    platform: proof.platform,
    profileCount: proof.profiles.length,
    runId: proof.runId,
    status: proof.status,
    summaryPath: path.join(path.dirname(path.resolve(filePath)), 'agent-summary.md'),
  };
}

/**
 * Builds flattened skipped interaction proof pointers across platform live-proof artifacts.
 *
 * @param {{files: string[], proofs: LiveProofArtifact[]}} options
 * @returns {LiveProofSetSkippedInteractionProofPointer[]}
 */
function buildLiveProofSetSkippedInteractionProofs({
  files,
  proofs,
}: {
  files: string[];
  proofs: LiveProofArtifact[];
}): LiveProofSetSkippedInteractionProofPointer[] {
  return proofs.flatMap((proof, index) => {
    const proofFilePath = path.resolve(files[index] ?? '');
    return (proof.skippedInteractionProofs ?? []).map((skippedProof) => ({
      ...skippedProof,
      platform: proof.platform,
      proofFilePath,
      proofRunId: proof.runId,
    }));
  });
}

/**
 * Adds diagnostic sufficiency entries into a proof-set accumulator.
 *
 * @param {Map<string, number>} counts
 * @param {LiveProofDiagnosticSufficiencyEntry[] | undefined} entries
 * @returns {void}
 */
function addDiagnosticSufficiencyCounts(
  counts: Map<string, number>,
  entries: LiveProofDiagnosticSufficiencyEntry[] | undefined,
): void {
  for (const entry of entries ?? []) {
    const key = `${entry.kind}\u0000${entry.status}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

/**
 * Converts diagnostic sufficiency counts into stable artifact order.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofDiagnosticSufficiencyCount[]}
 */
function formatDiagnosticSufficiencyCounts(
  counts: Map<string, number>,
): LiveProofDiagnosticSufficiencyCount[] {
  return [...counts.entries()]
    .map(([key, count]) => {
      const [kind = '', status = ''] = key.split('\u0000');
      return { count, kind, status };
    })
    .sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.status.localeCompare(right.status)
    ));
}

/**
 * Builds provider diagnostic sufficiency counts across skipped proof gates.
 *
 * @param {LiveProofSetSkippedInteractionProofPointer[]} skippedProofs
 * @returns {LiveProofSetProfileGateDiagnosticSufficiencyRollup | null}
 */
function buildLiveProofSetProfileGateDiagnosticSufficiencyRollup(
  skippedProofs: LiveProofSetSkippedInteractionProofPointer[],
): LiveProofSetProfileGateDiagnosticSufficiencyRollup | null {
  const blockingCounts = new Map<string, number>();
  const capturedCounts = new Map<string, number>();

  for (const skippedProof of skippedProofs) {
    const diagnostics = skippedProof.profileGateDiagnostics;
    addDiagnosticSufficiencyCounts(capturedCounts, diagnostics?.capturedDiagnosticSufficiency);
    addDiagnosticSufficiencyCounts(blockingCounts, diagnostics?.blockingDiagnosticSufficiency);
  }

  const blockingDiagnosticSufficiencyCounts = formatDiagnosticSufficiencyCounts(blockingCounts);
  const capturedDiagnosticSufficiencyCounts = formatDiagnosticSufficiencyCounts(capturedCounts);
  if (blockingDiagnosticSufficiencyCounts.length === 0 && capturedDiagnosticSufficiencyCounts.length === 0) {
    return null;
  }

  return {
    ...(blockingDiagnosticSufficiencyCounts.length > 0 ? { blockingDiagnosticSufficiencyCounts } : {}),
    ...(capturedDiagnosticSufficiencyCounts.length > 0 ? { capturedDiagnosticSufficiencyCounts } : {}),
    skippedInteractionProofCount: skippedProofs.length,
  };
}

/**
 * Builds native-performance claim context counts across skipped proof gates.
 *
 * @param {LiveProofSetSkippedInteractionProofPointer[]} skippedProofs
 * @returns {LiveProofSetProfileGateNativePerformanceRollup | null}
 */
function buildLiveProofSetProfileGateNativePerformanceRollup(
  skippedProofs: LiveProofSetSkippedInteractionProofPointer[],
): LiveProofSetProfileGateNativePerformanceRollup | null {
  const claimSufficiencyCounts = new Map<string, number>();
  const comparabilityCounts = new Map<string, number>();
  const diagnosticSourceCounts = new Map<string, number>();
  const targetBindingCounts = new Map<string, number>();

  for (const skippedProof of skippedProofs) {
    const nativePerformance = skippedProof.profileGateDiagnostics?.nativePerformance;
    if (!nativePerformance) {
      continue;
    }
    if (nativePerformance.claimSufficiency) {
      claimSufficiencyCounts.set(
        nativePerformance.claimSufficiency,
        (claimSufficiencyCounts.get(nativePerformance.claimSufficiency) ?? 0) + 1,
      );
    }
    if (nativePerformance.comparability) {
      comparabilityCounts.set(
        nativePerformance.comparability,
        (comparabilityCounts.get(nativePerformance.comparability) ?? 0) + 1,
      );
    }
    if (nativePerformance.targetBinding) {
      targetBindingCounts.set(
        nativePerformance.targetBinding,
        (targetBindingCounts.get(nativePerformance.targetBinding) ?? 0) + 1,
      );
    }
    addNativePerformanceSourceCounts(diagnosticSourceCounts, nativePerformance.diagnosticSources?.map((source) => ({
      count: 1,
      sourceId: source.sourceId,
      status: source.status,
    })));
  }

  const claimCounts = formatNativePerformanceStatusCounts(claimSufficiencyCounts);
  const comparableCounts = formatNativePerformanceStatusCounts(comparabilityCounts);
  const sourceCounts = formatNativePerformanceSourceCounts(diagnosticSourceCounts);
  const targetCounts = formatNativePerformanceStatusCounts(targetBindingCounts);
  if (
    claimCounts.length === 0 &&
    comparableCounts.length === 0 &&
    sourceCounts.length === 0 &&
    targetCounts.length === 0
  ) {
    return null;
  }

  return {
    ...(claimCounts.length > 0 ? { claimSufficiencyCounts: claimCounts } : {}),
    ...(comparableCounts.length > 0 ? { comparabilityCounts: comparableCounts } : {}),
    ...(sourceCounts.length > 0 ? { diagnosticSourceCounts: sourceCounts } : {}),
    skippedInteractionProofCount: skippedProofs.length,
    ...(targetCounts.length > 0 ? { targetBindingCounts: targetCounts } : {}),
  };
}

/**
 * Adds one profile-session readiness string count.
 *
 * @param {Map<string, number>} counts
 * @param {string | undefined} value
 * @returns {void}
 */
function addProfileGateReadinessValueCount(
  counts: Map<string, number>,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

/**
 * Adds one profile-session readiness boolean count.
 *
 * @param {Map<string, number>} counts
 * @param {boolean | undefined} value
 * @returns {void}
 */
function addProfileGateReadinessBooleanCount(
  counts: Map<string, number>,
  value: boolean | undefined,
): void {
  if (typeof value !== 'boolean') {
    return;
  }
  counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
}

/**
 * Converts readiness value counts into stable artifact order.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofProfileGateReadinessValueCount[]}
 */
function formatProfileGateReadinessValueCounts(
  counts: Map<string, number>,
): LiveProofProfileGateReadinessValueCount[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

/**
 * Converts readiness boolean counts into stable artifact order.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofProfileGateReadinessBooleanCount[]}
 */
function formatProfileGateReadinessBooleanCounts(
  counts: Map<string, number>,
): LiveProofProfileGateReadinessBooleanCount[] {
  return [...counts.entries()]
    .map(([key, count]) => ({
      count,
      value: key === 'true',
    }))
    .sort((left, right) => Number(left.value) - Number(right.value));
}

/**
 * Builds profile-session readiness counts across skipped proof gates.
 *
 * @param {LiveProofSetSkippedInteractionProofPointer[]} skippedProofs
 * @returns {LiveProofSetProfileGateReadinessRollup | null}
 */
function buildLiveProofSetProfileGateReadinessRollup(
  skippedProofs: LiveProofSetSkippedInteractionProofPointer[],
): LiveProofSetProfileGateReadinessRollup | null {
  const devClientDeepLinkOpenedCounts = new Map<string, number>();
  const expectedEvidenceCounts = new Map<string, number>();
  const failureClassCounts = new Map<string, number>();
  const foregroundAppInfoCapturedCounts = new Map<string, number>();
  const foregroundApplicationStateCounts = new Map<string, number>();
  const foregroundTargetOwnedCounts = new Map<string, number>();
  const pendingPhaseCounts = new Map<string, number>();
  const profileSessionSeededCounts = new Map<string, number>();
  let commandCountTotal = 0;
  let commandCountSeen = false;
  let readinessProofCount = 0;

  for (const skippedProof of skippedProofs) {
    const readiness = skippedProof.profileGateReadiness;
    if (!readiness) {
      continue;
    }

    readinessProofCount += 1;
    if (typeof readiness.commandCount === 'number') {
      commandCountSeen = true;
      commandCountTotal += readiness.commandCount;
    }
    addProfileGateReadinessBooleanCount(devClientDeepLinkOpenedCounts, readiness.devClientDeepLinkOpened);
    addProfileGateReadinessValueCount(expectedEvidenceCounts, readiness.expectedEvidence);
    addProfileGateReadinessValueCount(failureClassCounts, readiness.failureClass);
    addProfileGateReadinessBooleanCount(foregroundAppInfoCapturedCounts, readiness.foregroundAppInfoCaptured);
    addProfileGateReadinessValueCount(foregroundApplicationStateCounts, readiness.foregroundApplicationState);
    addProfileGateReadinessBooleanCount(foregroundTargetOwnedCounts, readiness.foregroundTargetOwned);
    addProfileGateReadinessValueCount(pendingPhaseCounts, readiness.pendingPhase);
    addProfileGateReadinessBooleanCount(profileSessionSeededCounts, readiness.profileSessionSeeded);
  }

  if (readinessProofCount === 0) {
    return null;
  }

  const devClientCounts = formatProfileGateReadinessBooleanCounts(devClientDeepLinkOpenedCounts);
  const expectedCounts = formatProfileGateReadinessValueCounts(expectedEvidenceCounts);
  const failureCounts = formatProfileGateReadinessValueCounts(failureClassCounts);
  const foregroundCapturedCounts = formatProfileGateReadinessBooleanCounts(foregroundAppInfoCapturedCounts);
  const foregroundStateCounts = formatProfileGateReadinessValueCounts(foregroundApplicationStateCounts);
  const foregroundOwnedCounts = formatProfileGateReadinessBooleanCounts(foregroundTargetOwnedCounts);
  const phaseCounts = formatProfileGateReadinessValueCounts(pendingPhaseCounts);
  const seedCounts = formatProfileGateReadinessBooleanCounts(profileSessionSeededCounts);

  return {
    ...(commandCountSeen ? { commandCountTotal } : {}),
    ...(devClientCounts.length > 0 ? { devClientDeepLinkOpenedCounts: devClientCounts } : {}),
    ...(expectedCounts.length > 0 ? { expectedEvidenceCounts: expectedCounts } : {}),
    ...(failureCounts.length > 0 ? { failureClassCounts: failureCounts } : {}),
    ...(foregroundCapturedCounts.length > 0 ? { foregroundAppInfoCapturedCounts: foregroundCapturedCounts } : {}),
    ...(foregroundStateCounts.length > 0 ? { foregroundApplicationStateCounts: foregroundStateCounts } : {}),
    ...(foregroundOwnedCounts.length > 0 ? { foregroundTargetOwnedCounts: foregroundOwnedCounts } : {}),
    ...(phaseCounts.length > 0 ? { pendingPhaseCounts: phaseCounts } : {}),
    ...(seedCounts.length > 0 ? { profileSessionSeededCounts: seedCounts } : {}),
    readinessProofCount,
    skippedInteractionProofCount: skippedProofs.length,
  };
}

/**
 * Builds human-readable failure reasons for one proof set.
 *
 * @param {{failOnRegression: boolean, missingPlatforms: LiveProofPlatform[], proofs: LiveProofArtifact[]}} options
 * @returns {string[]}
 */
function buildLiveProofSetFailureReasons({
  failOnRegression,
  missingPlatforms,
  proofs,
}: {
  failOnRegression: boolean;
  missingPlatforms: LiveProofPlatform[];
  proofs: LiveProofArtifact[];
}): string[] {
  return [
    ...missingPlatforms.map((platform) => `Missing required platform proof: ${platform}.`),
    ...proofs
      .filter((proof) => proof.status === 'failed')
      .map((proof) => `${proof.platform} proof ${proof.runId} failed.`),
    ...(
      failOnRegression
        ? proofs
          .filter((proof) => proof.comparisonStatus === 'regressed')
          .map((proof) => `${proof.platform} proof ${proof.runId} regressed.`)
        : []
    ),
  ];
}

/**
 * Builds the next action for a proof-set artifact.
 *
 * @param {{failureReasons: string[], missingPlatforms: LiveProofPlatform[], proofs: LiveProofArtifact[]}} options
 * @returns {{code: string, owner: LiveProofNextActionOwner, summary: string}}
 */
function buildLiveProofSetNextAction({
  failureReasons,
  missingPlatforms,
  proofs,
}: {
  failureReasons: string[];
  missingPlatforms: LiveProofPlatform[];
  proofs: LiveProofArtifact[];
}): {code: string; owner: LiveProofNextActionOwner; summary: string} {
  if (missingPlatforms.length > 0) {
    return {
      code: 'collect_missing_platform_proofs',
      owner: 'runtime_environment',
      summary: `Run the missing platform proof(s): ${missingPlatforms.join(', ')}.`,
    };
  }
  if (proofs.some((proof) => proof.status === 'failed')) {
    return {
      code: 'inspect_failed_run',
      owner: 'asl_runner',
      summary: 'Inspect failed live-proof artifacts before trusting the platform set.',
    };
  }
  if (proofs.some((proof) => proof.comparisonStatus === 'regressed')) {
    return {
      code: 'inspect_regressions',
      owner: 'product_optimization',
      summary: 'Inspect regressed platform proof comparisons before claiming improvement.',
    };
  }
  if (failureReasons.length > 0) {
    return {
      code: 'inspect_failed_set',
      owner: 'asl_runner',
      summary: 'Inspect failed proof-set reasons before trusting the platform set.',
    };
  }
  return {
    code: 'inspect_summary',
    owner: 'product_optimization',
    summary: 'Platform proof set is complete; inspect linked artifacts for detail.',
  };
}

/**
 * Builds the durable platform proof-set artifact.
 *
 * @param {{failOnRegression: boolean, files: string[], proofs: LiveProofArtifact[], requiredPlatforms?: LiveProofPlatform[], runId?: string}} options
 * @returns {LiveProofSetArtifact}
 */
function buildLiveProofSetArtifact({
  failOnRegression,
  files,
  proofs,
  requiredPlatforms = [],
  runId = 'live-proof-set',
}: {
  failOnRegression: boolean;
  files: string[];
  proofs: LiveProofArtifact[];
  requiredPlatforms?: LiveProofPlatform[];
  runId?: string;
}): LiveProofSetArtifact {
  const presentPlatforms = Array.from(new Set(proofs.map((proof) => proof.platform))).sort() as LiveProofPlatform[];
  const missingPlatforms = requiredPlatforms.filter((platform) => !presentPlatforms.includes(platform));
  const failureReasons = buildLiveProofSetFailureReasons({
    failOnRegression,
    missingPlatforms,
    proofs,
  });
  const status = failureReasons.length > 0 ? 'failed' : 'passed';
  const nextAction = buildLiveProofSetNextAction({
    failureReasons,
    missingPlatforms,
    proofs,
  });
  const profileNativePerformance = buildLiveProofSetNativePerformanceRollup(proofs);
  const skippedInteractionProofs = buildLiveProofSetSkippedInteractionProofs({ files, proofs });
  const profileGateDiagnosticSufficiency = buildLiveProofSetProfileGateDiagnosticSufficiencyRollup(
    skippedInteractionProofs,
  );
  const profileGateNativePerformance = buildLiveProofSetProfileGateNativePerformanceRollup(
    skippedInteractionProofs,
  );
  const profileGateReadiness = buildLiveProofSetProfileGateReadinessRollup(
    skippedInteractionProofs,
  );
  return {
    failureReasons,
    missingPlatforms,
    nextAction,
    presentPlatforms,
    ...(profileGateDiagnosticSufficiency ? { profileGateDiagnosticSufficiency } : {}),
    ...(profileGateNativePerformance ? { profileGateNativePerformance } : {}),
    ...(profileGateReadiness ? { profileGateReadiness } : {}),
    ...(profileNativePerformance ? { profileNativePerformance } : {}),
    proofCount: proofs.length,
    proofs: proofs.map((proof, index) => buildLiveProofSetProofPointer({
      filePath: path.resolve(files[index] ?? ''),
      proof,
    })),
    requiredPlatforms,
    runId,
    schemaVersion: '1.0.0',
    ...(skippedInteractionProofs.length > 0
      ? {
        skippedInteractionProofCount: skippedInteractionProofs.length,
        skippedInteractionProofs,
      }
      : {}),
    status,
    summary: status === 'passed'
      ? `live proof set passed for ${presentPlatforms.join(', ')}.`
      : `live proof set failed: ${failureReasons.join(' ')}`,
  };
}

/**
 * Formats proof-set interaction warning details for agent-readable markdown.
 *
 * @param {LiveProofSetProofPointer} proof
 * @returns {string[]}
 */
function formatLiveProofSetWarningDetails(proof: LiveProofSetProofPointer): string[] {
  return (proof.interactionWarnings ?? []).flatMap((interactionWarning) => (
    interactionWarning.checks.map((warning) => {
      const nextAction = warning.nextAction
        ? ` Next action: ${warning.nextAction.owner ?? 'unknown'}/${warning.nextAction.code} - ${warning.nextAction.summary}`
        : '';
      return `  - warning ${proof.platform}/${interactionWarning.label} (${interactionWarning.runnerId}/${interactionWarning.scenarioId}/${interactionWarning.runId}): ${warning.name} ${warning.code} - ${warning.message}${nextAction}`;
    })
  ));
}

/**
 * Formats diagnostic sufficiency entries for proof-set markdown.
 *
 * @param {LiveProofDiagnosticSufficiencyEntry[]} entries
 * @returns {string}
 */
function formatLiveProofSetDiagnosticSufficiencyEntries(
  entries: LiveProofDiagnosticSufficiencyEntry[],
): string {
  return entries.map((entry) => `${entry.kind}:${entry.status}`).join(', ');
}

/**
 * Formats diagnostic sufficiency count entries for proof-set markdown.
 *
 * @param {LiveProofDiagnosticSufficiencyCount[]} entries
 * @returns {string}
 */
function formatLiveProofSetDiagnosticSufficiencyCounts(
  entries: LiveProofDiagnosticSufficiencyCount[],
): string {
  return entries.map((entry) => `${entry.kind}:${entry.status}=${entry.count}`).join(', ');
}

/**
 * Formats aggregate profile-gate diagnostic sufficiency counts for proof-set markdown.
 *
 * @param {LiveProofSetProfileGateDiagnosticSufficiencyRollup | undefined} rollup
 * @returns {string[]}
 */
function formatLiveProofSetProfileGateDiagnosticSufficiencyRollup(
  rollup: LiveProofSetProfileGateDiagnosticSufficiencyRollup | undefined,
): string[] {
  if (!rollup) {
    return [];
  }

  const details = [
    `skippedInteractionProofs=${rollup.skippedInteractionProofCount}`,
  ];
  if (rollup.capturedDiagnosticSufficiencyCounts?.length) {
    details.push(`captured=${formatLiveProofSetDiagnosticSufficiencyCounts(rollup.capturedDiagnosticSufficiencyCounts)}`);
  }
  if (rollup.blockingDiagnosticSufficiencyCounts?.length) {
    details.push(`blocking=${formatLiveProofSetDiagnosticSufficiencyCounts(rollup.blockingDiagnosticSufficiencyCounts)}`);
  }

  return [
    `Profile gate diagnostics: ${details.join('; ')}`,
  ];
}

/**
 * Formats aggregate skipped-gate native-performance claim context for proof-set markdown.
 *
 * @param {LiveProofSetProfileGateNativePerformanceRollup | undefined} rollup
 * @returns {string[]}
 */
function formatLiveProofSetProfileGateNativePerformanceRollup(
  rollup: LiveProofSetProfileGateNativePerformanceRollup | undefined,
): string[] {
  if (!rollup) {
    return [];
  }

  const details = [
    `skippedInteractionProofs=${rollup.skippedInteractionProofCount}`,
  ];
  if (rollup.diagnosticSourceCounts?.length) {
    details.push(`sources=${formatLiveProofSetNativePerformanceSourceCounts(rollup.diagnosticSourceCounts)}`);
  }
  if (rollup.claimSufficiencyCounts?.length) {
    details.push(`claim=${formatLiveProofSetNativePerformanceStatusCounts(rollup.claimSufficiencyCounts)}`);
  }
  if (rollup.comparabilityCounts?.length) {
    details.push(`comparability=${formatLiveProofSetNativePerformanceStatusCounts(rollup.comparabilityCounts)}`);
  }
  if (rollup.targetBindingCounts?.length) {
    details.push(`target=${formatLiveProofSetNativePerformanceStatusCounts(rollup.targetBindingCounts)}`);
  }

  return [
    `Profile gate native performance: ${details.join('; ')}`,
  ];
}

/**
 * Formats readiness value count entries for proof-set markdown.
 *
 * @param {LiveProofProfileGateReadinessValueCount[]} counts
 * @returns {string}
 */
function formatLiveProofSetReadinessValueCounts(
  counts: LiveProofProfileGateReadinessValueCount[],
): string {
  return counts.map((entry) => `${entry.value}=${entry.count}`).join(', ');
}

/**
 * Formats readiness boolean count entries for proof-set markdown.
 *
 * @param {LiveProofProfileGateReadinessBooleanCount[]} counts
 * @returns {string}
 */
function formatLiveProofSetReadinessBooleanCounts(
  counts: LiveProofProfileGateReadinessBooleanCount[],
): string {
  return counts.map((entry) => `${entry.value}=${entry.count}`).join(', ');
}

/**
 * Formats aggregate profile-session readiness counts for proof-set markdown.
 *
 * @param {LiveProofSetProfileGateReadinessRollup | undefined} rollup
 * @returns {string[]}
 */
function formatLiveProofSetProfileGateReadinessRollup(
  rollup: LiveProofSetProfileGateReadinessRollup | undefined,
): string[] {
  if (!rollup) {
    return [];
  }

  const details = [
    `skippedInteractionProofs=${rollup.skippedInteractionProofCount}`,
    `readinessProofs=${rollup.readinessProofCount}`,
  ];
  if (typeof rollup.commandCountTotal === 'number') {
    details.push(`commands=${rollup.commandCountTotal}`);
  }
  if (rollup.failureClassCounts?.length) {
    details.push(`failure=${formatLiveProofSetReadinessValueCounts(rollup.failureClassCounts)}`);
  }
  if (rollup.devClientDeepLinkOpenedCounts?.length) {
    details.push(`devClientDeepLinkOpened=${formatLiveProofSetReadinessBooleanCounts(rollup.devClientDeepLinkOpenedCounts)}`);
  }
  if (rollup.foregroundAppInfoCapturedCounts?.length) {
    details.push(`foregroundAppInfoCaptured=${formatLiveProofSetReadinessBooleanCounts(rollup.foregroundAppInfoCapturedCounts)}`);
  }
  if (rollup.foregroundApplicationStateCounts?.length) {
    details.push(`foregroundApplicationState=${formatLiveProofSetReadinessValueCounts(rollup.foregroundApplicationStateCounts)}`);
  }
  if (rollup.foregroundTargetOwnedCounts?.length) {
    details.push(`foregroundTargetOwned=${formatLiveProofSetReadinessBooleanCounts(rollup.foregroundTargetOwnedCounts)}`);
  }
  if (rollup.profileSessionSeededCounts?.length) {
    details.push(`profileSessionSeeded=${formatLiveProofSetReadinessBooleanCounts(rollup.profileSessionSeededCounts)}`);
  }
  if (rollup.pendingPhaseCounts?.length) {
    details.push(`phase=${formatLiveProofSetReadinessValueCounts(rollup.pendingPhaseCounts)}`);
  }
  if (rollup.expectedEvidenceCounts?.length) {
    details.push(`expected=${formatLiveProofSetReadinessValueCounts(rollup.expectedEvidenceCounts)}`);
  }

  return [
    `Profile gate readiness: ${details.join('; ')}`,
  ];
}

/**
 * Formats native-performance source entries for proof-set markdown.
 *
 * @param {LiveProofNativePerformanceSourceEntry[]} entries
 * @returns {string}
 */
function formatLiveProofSetNativePerformanceSources(
  entries: LiveProofNativePerformanceSourceEntry[],
): string {
  return entries.map((entry) => `${entry.sourceId}:${entry.status}`).join(', ');
}

/**
 * Formats skipped-proof profile-gate diagnostics for proof-set markdown.
 *
 * @param {LiveProofProfileGateDiagnostics | undefined} diagnostics
 * @returns {string}
 */
function formatLiveProofSetProfileGateDiagnostics(
  diagnostics: LiveProofProfileGateDiagnostics | undefined,
): string {
  if (!diagnostics) {
    return '';
  }

  const parts = [];
  if (diagnostics.capturedDiagnosticSufficiency?.length) {
    parts.push(`captured=${formatLiveProofSetDiagnosticSufficiencyEntries(diagnostics.capturedDiagnosticSufficiency)}`);
  }
  if (diagnostics.blockingDiagnosticSufficiency?.length) {
    parts.push(`blocking=${formatLiveProofSetDiagnosticSufficiencyEntries(diagnostics.blockingDiagnosticSufficiency)}`);
  }
  const nativePerformance = diagnostics.nativePerformance;
  if (nativePerformance) {
    const nativeParts = [
      nativePerformance.claimSufficiency ? `claim=${nativePerformance.claimSufficiency}` : '',
      nativePerformance.comparability ? `comparability=${nativePerformance.comparability}` : '',
      nativePerformance.targetBinding ? `target=${nativePerformance.targetBinding}` : '',
      nativePerformance.diagnosticSources?.length
        ? `sources=${formatLiveProofSetNativePerformanceSources(nativePerformance.diagnosticSources)}`
        : '',
    ].filter((part) => part.length > 0);
    if (nativeParts.length > 0) {
      parts.push(`nativePerformance(${nativeParts.join(', ')})`);
    }
  }

  return parts.length > 0 ? ` Diagnostics: ${parts.join('; ')}.` : '';
}

/**
 * Formats iOS profile-session readiness context for proof-set markdown.
 *
 * @param {LiveProofProfileGateReadiness | undefined} readiness
 * @returns {string}
 */
function formatLiveProofSetProfileGateReadiness(
  readiness: LiveProofProfileGateReadiness | undefined,
): string {
  if (!readiness) {
    return '';
  }

  const parts = [];
  if (readiness.failureClass) {
    parts.push(`failure=${readiness.failureClass}`);
  }
  if (typeof readiness.commandCount === 'number') {
    parts.push(`commands=${readiness.commandCount}`);
  }
  if (typeof readiness.devClientDeepLinkOpened === 'boolean') {
    parts.push(`devClientDeepLinkOpened=${readiness.devClientDeepLinkOpened}`);
  }
  if (typeof readiness.foregroundAppInfoCaptured === 'boolean') {
    parts.push(`foregroundAppInfoCaptured=${readiness.foregroundAppInfoCaptured}`);
  }
  if (readiness.foregroundApplicationState) {
    parts.push(`foregroundApplicationState=${readiness.foregroundApplicationState}`);
  }
  if (typeof readiness.foregroundTargetOwned === 'boolean') {
    parts.push(`foregroundTargetOwned=${readiness.foregroundTargetOwned}`);
  }
  if (readiness.lastDeepLinkLabel) {
    parts.push(`lastDeepLink=${readiness.lastDeepLinkLabel}`);
  }
  if (typeof readiness.profileSessionSeeded === 'boolean') {
    parts.push(`profileSessionSeeded=${readiness.profileSessionSeeded}`);
  }
  if (readiness.pendingPhase) {
    parts.push(`phase=${readiness.pendingPhase}`);
  }
  if (readiness.expectedEvidence) {
    parts.push(`expected=${readiness.expectedEvidence}`);
  }
  if (readiness.foregroundRawPath) {
    parts.push(`foregroundRawPath=${readiness.foregroundRawPath}`);
  }
  if (readiness.profileSessionSeedRawPath) {
    parts.push(`profileSessionSeedRawPath=${readiness.profileSessionSeedRawPath}`);
  }
  if (readiness.readinessRawPath) {
    parts.push(`readinessRawPath=${readiness.readinessRawPath}`);
  }

  return parts.length > 0 ? ` Readiness: ${parts.join(', ')}.` : '';
}

/**
 * Formats skipped interaction proof details for proof-set markdown.
 *
 * @param {LiveProofSetSkippedInteractionProofPointer[] | undefined} skippedProofs
 * @returns {string[]}
 */
function formatLiveProofSetSkippedInteractionProofs(
  skippedProofs: LiveProofSetSkippedInteractionProofPointer[] | undefined,
): string[] {
  if (!skippedProofs?.length) {
    return [];
  }

  return [
    `Skipped interaction proofs: ${skippedProofs.length}`,
    ...skippedProofs.map((proof) => (
      `- skipped ${proof.platform}/${proof.label} (${proof.runnerId}/${proof.scenarioId}/${proof.runId}) from ${proof.proofRunId}: ${proof.reason}${formatLiveProofSetProfileGateDiagnostics(proof.profileGateDiagnostics)}${formatLiveProofSetProfileGateReadiness(proof.profileGateReadiness)} Next action: ${proof.nextAction.owner ?? 'unknown'}/${proof.nextAction.code} - ${proof.nextAction.summary}`
    )),
  ];
}

/**
 * Formats native-performance status counts for proof-set markdown.
 *
 * @param {LiveProofNativePerformanceCount[]} counts
 * @returns {string}
 */
function formatLiveProofSetNativePerformanceStatusCounts(
  counts: LiveProofNativePerformanceCount[],
): string {
  return counts.map((entry) => `${entry.status}=${entry.count}`).join(', ');
}

/**
 * Formats native-performance diagnostic source counts for proof-set markdown.
 *
 * @param {LiveProofNativePerformanceSourceCount[]} counts
 * @returns {string}
 */
function formatLiveProofSetNativePerformanceSourceCounts(
  counts: LiveProofNativePerformanceSourceCount[],
): string {
  return counts.map((entry) => `${entry.sourceId}:${entry.status}=${entry.count}`).join(', ');
}

/**
 * Formats proof-set native-performance interpretation details for markdown.
 *
 * @param {LiveProofProfileNativePerformanceRollup | undefined} rollup
 * @returns {string[]}
 */
function formatLiveProofSetNativePerformanceRollup(
  rollup: LiveProofProfileNativePerformanceRollup | undefined,
): string[] {
  if (!rollup) {
    return [];
  }

  const details = [
    `profiles=${rollup.profileCount}`,
    `evidence=${rollup.evidenceCount}`,
  ];
  if (rollup.diagnosticSourceCounts?.length) {
    details.push(`sources=${formatLiveProofSetNativePerformanceSourceCounts(rollup.diagnosticSourceCounts)}`);
  }
  if (rollup.claimSufficiencyCounts?.length) {
    details.push(`claim=${formatLiveProofSetNativePerformanceStatusCounts(rollup.claimSufficiencyCounts)}`);
  }
  if (rollup.comparabilityCounts?.length) {
    details.push(`comparability=${formatLiveProofSetNativePerformanceStatusCounts(rollup.comparabilityCounts)}`);
  }
  if (rollup.targetBindingCounts?.length) {
    details.push(`target=${formatLiveProofSetNativePerformanceStatusCounts(rollup.targetBindingCounts)}`);
  }

  return [
    `Native performance: ${details.join('; ')}`,
  ];
}

/**
 * Formats a proof-set artifact for agent-readable markdown.
 *
 * @param {LiveProofSetArtifact} artifact
 * @returns {string}
 */
function formatLiveProofSetArtifactMarkdown(artifact: LiveProofSetArtifact): string {
  return [
    `# Live Proof Set ${artifact.runId}`,
    '',
    `Status: ${artifact.status}`,
    `Required platforms: ${artifact.requiredPlatforms.join(', ') || 'none'}`,
    `Present platforms: ${artifact.presentPlatforms.join(', ') || 'none'}`,
    `Missing platforms: ${artifact.missingPlatforms.join(', ') || 'none'}`,
    `Proofs: ${artifact.proofCount}`,
    ...artifact.proofs.flatMap((proof) => [
      `- ${proof.platform} ${proof.runId}: status=${proof.status} comparison=${proof.comparisonStatus} profiles=${proof.profileCount} interactionProofs=${proof.interactionProofCount} warnings=${proof.interactionWarningCount} summary=${proof.summaryPath}`,
      ...formatLiveProofSetWarningDetails(proof),
    ]),
    ...formatLiveProofSetSkippedInteractionProofs(artifact.skippedInteractionProofs),
    ...formatLiveProofSetProfileGateDiagnosticSufficiencyRollup(artifact.profileGateDiagnosticSufficiency),
    ...formatLiveProofSetProfileGateNativePerformanceRollup(artifact.profileGateNativePerformance),
    ...formatLiveProofSetProfileGateReadinessRollup(artifact.profileGateReadiness),
    ...formatLiveProofSetNativePerformanceRollup(artifact.profileNativePerformance),
    `Failure reasons: ${artifact.failureReasons.length > 0 ? artifact.failureReasons.join(' ') : 'none'}`,
    `Next action: ${artifact.nextAction.owner ?? 'unknown'}/${artifact.nextAction.code} - ${artifact.nextAction.summary}`,
    '',
    artifact.summary,
  ].join('\n');
}

/**
 * Writes durable proof-set artifacts under an output directory.
 *
 * @param {{artifact: LiveProofSetArtifact, outputDir: string}} options
 * @returns {Promise<{liveProofSetPath: string, summaryPath: string}>}
 */
async function writeLiveProofSetArtifact({
  artifact,
  outputDir,
}: {
  artifact: LiveProofSetArtifact;
  outputDir: string;
}): Promise<{liveProofSetPath: string; summaryPath: string}> {
  const layout = createArtifactLayout({ outputDir });
  await writeJsonArtifact({
    filePath: layout.liveProofSet,
    label: 'Live proof set artifact',
    schema: SCHEMAS.liveProofSet,
    value: artifact,
  });
  await writeTextArtifact({
    filePath: layout.agentSummary,
    content: formatLiveProofSetArtifactMarkdown(artifact),
  });
  return {
    liveProofSetPath: layout.liveProofSet,
    summaryPath: layout.agentSummary,
  };
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
    ...(proof.interactionProofs ?? []).flatMap((proofPointer) => [
      `- ${proofPointer.label} (${proofPointer.runnerId}/${proofPointer.scenarioId}/${proofPointer.runId}): health=${proofPointer.healthStatus} verdict=${proofPointer.verdictStatus}${formatInteractionProofCaptures(proofPointer)}${formatInteractionProofWarnings(proofPointer)}`,
      ...formatInteractionProofWarningDetails(proofPointer),
    ]),
    `Skipped interaction proofs: ${proof.skippedInteractionProofs?.length ?? 0}`,
    ...(proof.skippedInteractionProofs ?? []).map((proofPointer) => (
      `- ${proofPointer.label} (${proofPointer.runnerId}/${proofPointer.scenarioId}/${proofPointer.runId}): ${proofPointer.reason} next=${proofPointer.nextAction.owner ?? 'unknown'}/${proofPointer.nextAction.code}`
    )),
    `Comparisons: ${proof.comparisons.length}`,
    `Comparison counts: better=${proof.comparisonCounts.better} worse=${proof.comparisonCounts.worse} unchanged=${proof.comparisonCounts.unchanged} mixed=${proof.comparisonCounts.mixed} inconclusive=${proof.comparisonCounts.inconclusive} low_confidence=${proof.comparisonCounts.low_confidence} skipped=${proof.comparisonCounts.skipped}`,
    ...proof.comparisons.map((comparison) => (
      `- ${comparison.label ?? 'comparison'} (${comparison.scenarioId ?? 'unknown-scenario'}/${comparison.runId ?? 'unknown-run'}): ${comparison.status ?? 'unknown'}${formatComparisonPointerMetrics(comparison)}`
    )),
    `Next action: ${proof.nextAction.owner ?? 'unknown'}/${proof.nextAction.code} - ${proof.nextAction.summary}`,
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
  const requireArtifacts = shouldRequireArtifacts(args);
  const artifactBaseDir = resolveLiveProofArtifactBaseDir(args);
  const readOptions: LiveProofArtifactReadOptions = { requireArtifacts };
  if (artifactBaseDir !== undefined) {
    readOptions.artifactBaseDir = artifactBaseDir;
  }
  const proofs = files.map((file) => readLiveProof(file, readOptions));
  const failOnRegression = args['fail-on-regression'] === true || args['fail-on-regression'] === 'true';
  const proofSet = buildLiveProofSetArtifact({
    failOnRegression,
    files,
    proofs,
    requiredPlatforms,
    runId: resolveLiveProofSetRunId(args),
  });
  process.stdout.write(`${formatLiveProofSet({ proofs, requiredPlatforms })}\n`);
  if (proofSet.failureReasons.length > 0) {
    process.stdout.write(`Proof set status: ${proofSet.status}\n`);
    for (const reason of proofSet.failureReasons) {
      process.stdout.write(`- ${reason}\n`);
    }
    process.stdout.write(`Next action: ${proofSet.nextAction.owner ?? 'unknown'}/${proofSet.nextAction.code} - ${proofSet.nextAction.summary}\n`);
  }
  const outputDir = resolveLiveProofSetOutputDir(args);
  if (outputDir) {
    const written = await writeLiveProofSetArtifact({ artifact: proofSet, outputDir });
    process.stdout.write(`Live proof set artifact: ${written.liveProofSetPath}\n`);
    process.stdout.write(`Live proof set summary: ${written.summaryPath}\n`);
  }
  if (proofSet.status === 'failed') {
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
  assertLiveProofArtifactPointers,
  assertLiveProofAggregateSignals,
  assertLiveProofComparisonCounts,
  assertLiveProofSetRequiredPlatforms,
  buildLiveProofSetArtifact,
  buildLiveProofSetFailureReasons,
  buildLiveProofSetNextAction,
  collectLiveProofArtifactPointerIssues,
  countLiveProofComparisons,
  deriveLiveProofComparisonStatus,
  expectedLiveProofNextActionCode,
  formatComparisonPointerMetrics,
  formatInteractionProofCaptures,
  formatInteractionProofWarningDetails,
  formatInteractionProofWarnings,
  formatLiveProofSetWarningDetails,
  formatLiveProof,
  formatLiveProofSet,
  formatLiveProofSetArtifactMarkdown,
  main,
  parseArgs,
  parseRequiredPlatforms,
  readLiveProof,
  readLiveProofSet,
  resolveLiveProofSetOutputDir,
  resolveLiveProofArtifactBaseDir,
  resolveLiveProofFiles,
  resolveLiveProofSetRunId,
  shouldRequireArtifacts,
  shouldFailLiveProofSet,
  shouldFailOnRegression,
  usage,
  writeLiveProofSetArtifact,
};

export type {
  CliArgs,
  LiveProofArtifact,
  LiveProofArtifactPointerIssue,
  LiveProofArtifactReadOptions,
  LiveProofSetArtifact,
  LiveProofSetProofPointer,
};
