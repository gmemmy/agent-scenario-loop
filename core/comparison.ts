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

type ComparisonStatus = MetricComparison['status'];

type BuildComparisonOptions = {
  baselineHealth: ComparisonRecord;
  baselineVerdict: ComparisonRecord;
  currentHealth: ComparisonRecord;
  currentVerdict: ComparisonRecord;
};

type CompareRunDirectoriesOptions = {
  baselineDir: string;
  currentDir: string;
};

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
  const status = delta < 0 ? 'better' : delta > 0 ? 'worse' : 'unchanged';

  return {
    name: current.name,
    unit: current.unit,
    baseline: baseline.actual,
    current: current.actual,
    delta,
    status,
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
  if (metricComparisons.some((metric) => metric.status === 'worse')) {
    return 'worse';
  }

  if (metricComparisons.some((metric) => metric.status === 'better')) {
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
 * Builds a comparison artifact from two validated run artifact sets.
 *
 * @param {BuildComparisonOptions} options
 * @returns {Record<string, unknown>}
 */
function buildComparisonArtifact({
  baselineHealth,
  baselineVerdict,
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
function compareRunDirectories({ baselineDir, currentDir }: CompareRunDirectoriesOptions): ComparisonRecord {
  const baseline = readRunArtifacts(baselineDir);
  const current = readRunArtifacts(currentDir);

  return buildComparisonArtifact({
    baselineHealth: baseline.health,
    baselineVerdict: baseline.verdict,
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

  if (comparisonStatus === 'unchanged') {
    return 'Current run matched the explicit baseline.';
  }

  return 'Comparison is inconclusive.';
}

export {
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
  CompareRunDirectoriesOptions,
  ComparisonBudgetCheck,
  ComparisonRecord,
  ComparisonStatus,
  MetricComparison,
};
