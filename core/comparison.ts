const fs = require('node:fs');

const { createArtifactLayout } = require('./artifact-layout');
const { SCHEMAS, assertValidJson } = require('./schema-validator');

type ComparisonRecord = Record<string, any>;

type ComparisonBudgetCheck = {
  actual: number | boolean | null;
  name: string;
  pass: boolean;
  unit: 'ms' | 'count' | 'bytes' | 'percent' | 'boolean';
};

type MetricComparison = {
  name: string;
  unit: ComparisonBudgetCheck['unit'];
  baseline: number | boolean | null;
  current: number | boolean | null;
  delta: number | null;
  status: 'better' | 'worse' | 'unchanged' | 'inconclusive';
  notes?: string;
};

type ComparisonStatus = MetricComparison['status'] | 'mixed';

type ComparisonBasisStrategy = 'explicit' | 'latest_trusted_prior';

type ComparisonRunBasis = {
  healthStatus?: string;
  runDir?: string;
  runId: string;
  verdictStatus?: string;
};

type ComparisonSelectionBasis = {
  artifactRoot?: string;
  candidatesInspected?: number;
  scenarioId?: string;
  selectedRunDir?: string;
  selectedRunId?: string;
  skippedCurrentRun?: boolean;
  trustedCandidates?: number;
  trustedPriorCandidates?: number;
};

type ComparisonBasis = {
  baseline: ComparisonRunBasis;
  current: ComparisonRunBasis;
  selection?: ComparisonSelectionBasis;
  strategy: ComparisonBasisStrategy;
};

type BuildComparisonOptions = {
  baselineHealth: ComparisonRecord;
  baselineVerdict: ComparisonRecord;
  comparisonBasis?: ComparisonBasis;
  currentHealth: ComparisonRecord;
  currentVerdict: ComparisonRecord;
};

type CompareRunDirectoriesOptions = {
  baselineDir: string;
  currentDir: string;
  selection?: ComparisonSelectionBasis;
  strategy?: ComparisonBasisStrategy;
};

const MIN_MS_COMPARISON_TOLERANCE = 10;
const RELATIVE_MS_COMPARISON_TOLERANCE = 0.05;

/**
 * Reads and validates the health and verdict artifacts from a run directory.
 *
 * @param {string} runDir
 * @returns {{health: Record<string, unknown>, verdict: Record<string, unknown>}}
 */
function readRunArtifacts(runDir: string): { health: ComparisonRecord; verdict: ComparisonRecord } {
  const layout = createArtifactLayout({ outputDir: runDir });
  const health = JSON.parse(fs.readFileSync(layout.health, 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(layout.verdict, 'utf8'));

  return {
    health: assertValidJson(health, SCHEMAS.health, 'Health artifact') as ComparisonRecord,
    verdict: assertValidJson(verdict, SCHEMAS.verdict, 'Verdict artifact') as ComparisonRecord,
  };
}

/**
 * Returns budget checks indexed by stable comparison key.
 *
 * @param {unknown} checks
 * @returns {Map<string, BudgetCheck>}
 */
function indexBudgetChecks(checks: unknown): Map<string, ComparisonBudgetCheck> {
  const indexed = new Map<string, ComparisonBudgetCheck>();
  if (!Array.isArray(checks)) {
    return indexed;
  }

  for (const check of checks) {
    if (!check || typeof check !== 'object') {
      continue;
    }

    const record = check as Partial<ComparisonBudgetCheck>;
    if (typeof record.name !== 'string' || typeof record.unit !== 'string') {
      continue;
    }

    indexed.set(`${record.name}\u0000${record.unit}`, record as ComparisonBudgetCheck);
  }

  return indexed;
}

/**
 * Returns the absolute delta that should still be treated as timing noise.
 *
 * @param {ComparisonBudgetCheck} baseline
 * @param {ComparisonBudgetCheck} current
 * @returns {number}
 */
function comparisonTolerance(baseline: ComparisonBudgetCheck, current: ComparisonBudgetCheck): number {
  if (baseline.unit !== 'ms' || current.unit !== 'ms') {
    return 0;
  }

  if (typeof baseline.actual !== 'number' || typeof current.actual !== 'number') {
    return 0;
  }

  const reference = Math.max(Math.abs(baseline.actual), Math.abs(current.actual));
  return Math.max(MIN_MS_COMPARISON_TOLERANCE, reference * RELATIVE_MS_COMPARISON_TOLERANCE);
}

/**
 * Compares one budget check when both runs expose a compatible actual value.
 *
 * @param {BudgetCheck} baseline
 * @param {BudgetCheck} current
 * @returns {MetricComparison}
 */
function compareBudgetCheck(baseline: ComparisonBudgetCheck, current: ComparisonBudgetCheck): MetricComparison {
  if (typeof baseline.actual !== 'number' || typeof current.actual !== 'number') {
    return {
      name: current.name,
      unit: current.unit,
      baseline: baseline.actual ?? null,
      current: current.actual ?? null,
      delta: null,
      status: baseline.actual === current.actual ? 'unchanged' : 'inconclusive',
      notes: 'Only numeric budget actuals are compared by direction.',
    };
  }

  const delta = current.actual - baseline.actual;
  const tolerance = comparisonTolerance(baseline, current);
  const crossedBudgetBoundary = baseline.pass !== current.pass;
  const withinTolerance = Math.abs(delta) <= tolerance;
  let status: MetricComparison['status'];
  if (crossedBudgetBoundary) {
    status = current.pass ? 'better' : 'worse';
  } else if (withinTolerance) {
    status = 'unchanged';
  } else {
    status = delta < 0 ? 'better' : 'worse';
  }

  return {
    name: current.name,
    unit: current.unit,
    baseline: baseline.actual,
    current: current.actual,
    delta,
    status,
    ...(status === 'unchanged' && delta !== 0 && tolerance > 0 && withinTolerance
      ? { notes: `Delta within ${tolerance}ms timing tolerance.` }
      : {}),
  };
}

/**
 * Collapses metric-level comparison statuses into the run-level comparison status.
 *
 * @param {MetricComparison[]} metricComparisons
 * @param {{baselineVerdictStatus?: unknown, currentVerdictStatus?: unknown}} verdicts
 * @returns {ComparisonStatus}
 */
function resolveComparisonStatus(
  metricComparisons: MetricComparison[],
  {
    baselineVerdictStatus,
    currentVerdictStatus,
  }: {
    baselineVerdictStatus?: unknown;
    currentVerdictStatus?: unknown;
  },
): ComparisonStatus {
  const hasBetterMetric = metricComparisons.some((metric) => metric.status === 'better');
  const hasWorseMetric = metricComparisons.some((metric) => metric.status === 'worse');

  if (hasBetterMetric && hasWorseMetric) {
    return 'mixed';
  }

  if (hasWorseMetric) {
    return 'worse';
  }

  if (hasBetterMetric) {
    return 'better';
  }

  if (metricComparisons.length > 0 && metricComparisons.every((metric) => metric.status === 'unchanged')) {
    return 'unchanged';
  }

  if (baselineVerdictStatus === 'failed' && currentVerdictStatus === 'passed') {
    return 'better';
  }

  if (baselineVerdictStatus === 'passed' && currentVerdictStatus === 'failed') {
    return 'worse';
  }

  return 'inconclusive';
}

/**
 * Builds the provenance block that explains which runs a comparison used.
 *
 * @param {{baselineDir: string, currentDir: string, baselineHealth: ComparisonRecord, baselineVerdict: ComparisonRecord, currentHealth: ComparisonRecord, currentVerdict: ComparisonRecord, selection?: ComparisonSelectionBasis, strategy: ComparisonBasisStrategy}} options
 * @returns {ComparisonBasis}
 */
function buildComparisonBasis({
  baselineDir,
  currentDir,
  baselineHealth,
  baselineVerdict,
  currentHealth,
  currentVerdict,
  selection,
  strategy,
}: {
  baselineDir: string;
  currentDir: string;
  baselineHealth: ComparisonRecord;
  baselineVerdict: ComparisonRecord;
  currentHealth: ComparisonRecord;
  currentVerdict: ComparisonRecord;
  selection?: ComparisonSelectionBasis;
  strategy: ComparisonBasisStrategy;
}): ComparisonBasis {
  const baselineRunId = String(baselineHealth.runId ?? baselineVerdict.runId ?? 'unknown-baseline');
  const currentRunId = String(currentHealth.runId ?? currentVerdict.runId ?? 'unknown-current');

  return {
    strategy,
    baseline: {
      runId: baselineRunId,
      runDir: baselineDir,
      ...(typeof baselineHealth.healthStatus === 'string' ? { healthStatus: baselineHealth.healthStatus } : {}),
      ...(typeof baselineVerdict.verdictStatus === 'string' ? { verdictStatus: baselineVerdict.verdictStatus } : {}),
    },
    current: {
      runId: currentRunId,
      runDir: currentDir,
      ...(typeof currentHealth.healthStatus === 'string' ? { healthStatus: currentHealth.healthStatus } : {}),
      ...(typeof currentVerdict.verdictStatus === 'string' ? { verdictStatus: currentVerdict.verdictStatus } : {}),
    },
    ...(selection ? { selection } : {}),
  };
}

/**
 * Builds a comparison artifact from two validated run artifact sets.
 *
 * @param {BuildComparisonOptions} options
 * @returns {Record<string, unknown>}
 */
function buildComparisonArtifact({
  baselineHealth,
  baselineVerdict,
  comparisonBasis,
  currentHealth,
  currentVerdict,
}: BuildComparisonOptions): ComparisonRecord {
  const missingRequired: string[] = [];
  const warnings: string[] = [];
  const baselineScenarioId = String(baselineHealth.scenarioId ?? baselineVerdict.scenarioId ?? 'unknown-scenario');
  const currentScenarioId = String(currentHealth.scenarioId ?? currentVerdict.scenarioId ?? baselineScenarioId);
  const baselineRunId = String(baselineHealth.runId ?? baselineVerdict.runId ?? 'unknown-baseline');
  const currentRunId = String(currentHealth.runId ?? currentVerdict.runId ?? 'unknown-current');

  if (baselineHealth.healthStatus !== 'passed') {
    missingRequired.push('baseline health passed');
  }

  if (currentHealth.healthStatus !== 'passed') {
    missingRequired.push('current health passed');
  }

  if (baselineScenarioId !== currentScenarioId) {
    missingRequired.push('matching scenario id');
  }

  const canCompare = missingRequired.length === 0;
  const metricComparisons: MetricComparison[] = [];

  if (canCompare) {
    const baselineChecks = indexBudgetChecks(baselineVerdict.budgetChecks);
    const currentChecks = indexBudgetChecks(currentVerdict.budgetChecks);
    for (const [key, currentCheck] of currentChecks.entries()) {
      const baselineCheck = baselineChecks.get(key);
      if (!baselineCheck) {
        warnings.push(`No baseline budget check matched ${currentCheck.name}.`);
        continue;
      }
      metricComparisons.push(compareBudgetCheck(baselineCheck, currentCheck));
    }

    if (metricComparisons.length === 0) {
      warnings.push('No comparable budget checks were available.');
    }
  }

  const comparisonStatus = canCompare
    ? resolveComparisonStatus(metricComparisons, {
        baselineVerdictStatus: baselineVerdict.verdictStatus,
        currentVerdictStatus: currentVerdict.verdictStatus,
      })
    : 'inconclusive';
  const comparison = {
    schemaVersion: '1.0.0',
    scenarioId: currentScenarioId,
    ...(typeof currentHealth.flowId === 'string'
      ? { flowId: currentHealth.flowId }
      : typeof currentVerdict.flowId === 'string'
        ? { flowId: currentVerdict.flowId }
        : {}),
    runId: currentRunId,
    baselineRunId,
    comparisonStatus,
    healthStatus: canCompare ? 'passed' : 'failed',
    verdictStatus: typeof currentVerdict.verdictStatus === 'string' ? currentVerdict.verdictStatus : 'inconclusive',
    ...(comparisonBasis ? { comparisonBasis } : {}),
    ...(metricComparisons.length > 0 ? { metricComparisons } : {}),
    evidence: {
      missingRequired,
      warnings,
    },
    summary: summarizeComparison({ comparisonStatus, missingRequired, metricComparisons, warnings }),
  };

  return assertValidJson(comparison, SCHEMAS.comparison, 'Comparison artifact') as ComparisonRecord;
}

/**
 * Reads two run directories and builds a validated comparison artifact.
 *
 * @param {CompareRunDirectoriesOptions} options
 * @returns {Record<string, unknown>}
 */
function compareRunDirectories({
  baselineDir,
  currentDir,
  selection,
  strategy = 'explicit',
}: CompareRunDirectoriesOptions): ComparisonRecord {
  const baseline = readRunArtifacts(baselineDir);
  const current = readRunArtifacts(currentDir);

  return buildComparisonArtifact({
    baselineHealth: baseline.health,
    baselineVerdict: baseline.verdict,
    comparisonBasis: buildComparisonBasis({
      baselineDir,
      currentDir,
      baselineHealth: baseline.health,
      baselineVerdict: baseline.verdict,
      currentHealth: current.health,
      currentVerdict: current.verdict,
      ...(selection ? { selection } : {}),
      strategy,
    }),
    currentHealth: current.health,
    currentVerdict: current.verdict,
  });
}

/**
 * Builds the human-readable comparison summary.
 *
 * @param {{comparisonStatus: string, missingRequired: string[], metricComparisons: MetricComparison[], warnings: string[]}} options
 * @returns {string}
 */
function summarizeComparison({
  comparisonStatus,
  missingRequired,
  metricComparisons,
  warnings,
}: {
  comparisonStatus: string;
  missingRequired: string[];
  metricComparisons: MetricComparison[];
  warnings: string[];
}): string {
  if (missingRequired.length > 0) {
    return `Comparison is inconclusive because required evidence is missing: ${missingRequired.join(', ')}.`;
  }

  if (metricComparisons.length === 0) {
    return warnings.length > 0
      ? `Comparison is inconclusive: ${warnings.join(' ')}`
      : 'Comparison is inconclusive because there were no comparable metrics.';
  }

  if (comparisonStatus === 'better') {
    return 'Current run improved against the explicit baseline.';
  }

  if (comparisonStatus === 'worse') {
    return 'Current run regressed against the explicit baseline.';
  }

  if (comparisonStatus === 'mixed') {
    return 'Current run has mixed metric movement against the explicit baseline.';
  }

  if (comparisonStatus === 'unchanged') {
    return 'Current run matched the explicit baseline.';
  }

  return 'Comparison is inconclusive.';
}

export {
  buildComparisonBasis,
  buildComparisonArtifact,
  compareBudgetCheck,
  compareRunDirectories,
  indexBudgetChecks,
  readRunArtifacts,
  resolveComparisonStatus,
  summarizeComparison,
};

export type {
  BuildComparisonOptions,
  ComparisonBasis,
  ComparisonBasisStrategy,
  CompareRunDirectoriesOptions,
  ComparisonBudgetCheck,
  ComparisonRecord,
  ComparisonStatus,
  MetricComparison,
};
