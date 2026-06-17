const path = require('node:path');

const { createArtifactLayout } = require('../core/artifact-layout');
const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const { readRunArtifacts } = require('../core/comparison');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { compareLatestTrustedRun } = require('./compare-latest');

type ExampleLiveProfileForComparison = {
  label: string;
  runDir: string;
  runId: string;
  scenarioId: string;
};

type ComparisonMetricStatus = 'better' | 'worse' | 'unchanged' | 'inconclusive';

type ComparisonMetricHighlight = {
  baseline: number | boolean | null;
  current: number | boolean | null;
  delta: number | null;
  name: string;
  status: Exclude<ComparisonMetricStatus, 'unchanged'>;
  unit: string;
};

type ComparisonMetricSummary = {
  counts: Record<ComparisonMetricStatus, number>;
  notableMetrics: ComparisonMetricHighlight[];
};

type ExampleLiveComparisonResult = {
  baselineDir: string | null;
  comparisonDir: string | null;
  label: string;
  metricSummary?: ComparisonMetricSummary;
  reason: string | null;
  runId: string;
  scenarioId: string;
  status: 'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'skipped';
  summaryPath: string | null;
};

type CompareLiveProfilesOptions = {
  outputDir: string;
  profiles: ExampleLiveProfileForComparison[];
};

/**
 * Checks whether a parsed CLI flag is enabled.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Reports whether compare-latest failed only because no baseline exists yet.
 *
 * @param {unknown} error
 * @returns {error is Error}
 */
function isMissingPriorRunError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('No trusted prior run found');
}

/**
 * Builds a compact agent-readable summary from a detailed comparison artifact.
 *
 * @param {Record<string, unknown>} comparison
 * @returns {ComparisonMetricSummary | undefined}
 */
function buildComparisonMetricSummary(comparison: Record<string, unknown>): ComparisonMetricSummary | undefined {
  if (!Array.isArray(comparison.metricComparisons)) {
    return undefined;
  }

  const counts: Record<ComparisonMetricStatus, number> = {
    better: 0,
    worse: 0,
    unchanged: 0,
    inconclusive: 0,
  };
  const notableMetrics: ComparisonMetricHighlight[] = [];

  for (const metric of comparison.metricComparisons) {
    if (!metric || typeof metric !== 'object') {
      continue;
    }

    const record = metric as Record<string, unknown>;
    const status = record.status;
    if (status !== 'better' && status !== 'worse' && status !== 'unchanged' && status !== 'inconclusive') {
      continue;
    }

    counts[status] += 1;
    if (status === 'unchanged') {
      continue;
    }

    notableMetrics.push({
      baseline: typeof record.baseline === 'number' || typeof record.baseline === 'boolean' ? record.baseline : null,
      current: typeof record.current === 'number' || typeof record.current === 'boolean' ? record.current : null,
      delta: typeof record.delta === 'number' ? record.delta : null,
      name: typeof record.name === 'string' ? record.name : 'unknown metric',
      status,
      unit: typeof record.unit === 'string' ? record.unit : 'unknown',
    });
  }

  return {
    counts,
    notableMetrics,
  };
}

/**
 * Writes comparison artifacts for one already-passed live profile.
 *
 * @param {{outputDir: string, profile: ExampleLiveProfileForComparison}} options
 * @returns {Promise<ExampleLiveComparisonResult>}
 */
async function compareLiveProfileToLatest({
  outputDir,
  profile,
}: {
  outputDir: string;
  profile: ExampleLiveProfileForComparison;
}): Promise<ExampleLiveComparisonResult> {
  try {
    const result = compareLatestTrustedRun({
      currentDir: profile.runDir,
      rootDir: outputDir,
      scenarioId: profile.scenarioId,
    });
    const comparisonDir = path.join(outputDir, 'comparisons', profile.scenarioId, profile.runId);
    const layout = createArtifactLayout({ outputDir: comparisonDir });
    await writeJsonArtifact({
      filePath: layout.comparison,
      value: result.comparison,
      schema: SCHEMAS.comparison,
      label: 'Comparison artifact',
    });

    const current = readRunArtifacts(profile.runDir);
    await writeTextArtifact({
      filePath: layout.agentSummary,
      content: buildAgentSummaryMarkdown({
        health: current.health,
        verdict: current.verdict,
        comparison: result.comparison,
      }),
    });

    const metricSummary = buildComparisonMetricSummary(result.comparison);

    return {
      baselineDir: result.baselineDir,
      comparisonDir,
      label: profile.label,
      ...(metricSummary ? { metricSummary } : {}),
      reason: null,
      runId: profile.runId,
      scenarioId: profile.scenarioId,
      status: String(result.comparison.comparisonStatus) as ExampleLiveComparisonResult['status'],
      summaryPath: layout.agentSummary,
    };
  } catch (error) {
    if (!isMissingPriorRunError(error)) {
      throw error;
    }

    return {
      baselineDir: null,
      comparisonDir: null,
      label: profile.label,
      reason: error.message,
      runId: profile.runId,
      scenarioId: profile.scenarioId,
      status: 'skipped',
      summaryPath: null,
    };
  }
}

/**
 * Compares live proof profiles against the latest trusted prior run for each scenario.
 *
 * @param {CompareLiveProfilesOptions} options
 * @returns {Promise<ExampleLiveComparisonResult[]>}
 */
async function compareLiveProfilesToLatest({
  outputDir,
  profiles,
}: CompareLiveProfilesOptions): Promise<ExampleLiveComparisonResult[]> {
  const comparisons: ExampleLiveComparisonResult[] = [];
  for (const profile of profiles) {
    comparisons.push(await compareLiveProfileToLatest({ outputDir, profile }));
  }
  return comparisons;
}

export {
  buildComparisonMetricSummary,
  compareLiveProfileToLatest,
  compareLiveProfilesToLatest,
  isEnabledFlag,
};

export type {
  CompareLiveProfilesOptions,
  ExampleLiveComparisonResult,
  ExampleLiveProfileForComparison,
  ComparisonMetricHighlight,
  ComparisonMetricSummary,
};
