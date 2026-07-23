const { SCHEMAS, validateJson } = require('./schema-validator');

type NonEmptyArray<T> = [T, ...T[]];

type HistoricalEvaluationDirectionalDecisionStatus = 'improved' | 'regressed' | 'unchanged';
type HistoricalEvaluationNoDecisionStatus = 'insufficient-evidence' | 'not-comparable';
type HistoricalEvaluationDecisionStatus =
  | HistoricalEvaluationDirectionalDecisionStatus
  | 'mixed'
  | HistoricalEvaluationNoDecisionStatus;

type HistoricalEvaluationExclusionReason =
  | 'missing-evidence'
  | 'partial-evidence'
  | 'non-finite-sample'
  | 'incompatible-evidence'
  | 'untrusted-health'
  | 'retry-attempt'
  | 'identity-mismatch'
  | 'lineage-mismatch'
  | 'stale-clock'
  | 'invalid-clock'
  | 'native-not-ready';

type HistoricalEvaluationAggregationMode = 'median' | 'mean';
type HistoricalEvaluationDirection = 'lower-is-better' | 'higher-is-better';
type HistoricalEvaluationEligibilityStatus = 'eligible' | 'ineligible';
type HistoricalEvaluationAggregationStatus =
  | 'computed'
  | 'insufficient-evidence'
  | 'not-comparable';

type HistoricalEvaluationScope = {
  scenarioId: string;
  comparisonLane: string;
  cohortHash: string;
  platform: string;
  lineage: {
    status: 'exact';
    scenarioHash: string;
  };
};

type HistoricalEvaluationTolerance = {
  absolute: number;
  /** Unit interval ratio applied to abs(historicalValue). */
  relative: number;
};

type HistoricalEvaluationMetricPolicy = {
  metricId: string;
  unit: string;
  direction: HistoricalEvaluationDirection;
  tolerance: HistoricalEvaluationTolerance;
};

type HistoricalEvaluationPopulationPolicy = {
  authority: 'consumer-declared';
  minimumEligibleRuns: number;
  /** ASL defines mean and median; the consumer chooses which declared mode applies. */
  aggregation: HistoricalEvaluationAggregationMode;
  warmup: 'none';
  outliers: 'none';
  metrics: NonEmptyArray<HistoricalEvaluationMetricPolicy>;
};

type HistoricalEvaluationPolicyWithoutNative = {
  history: 'local-only';
  metrics: HistoricalEvaluationPopulationPolicy;
  nativeHistory?: never;
};

type HistoricalEvaluationPolicyWithNative = {
  history: 'local-only';
  metrics: HistoricalEvaluationPopulationPolicy;
  nativeHistory: HistoricalEvaluationPopulationPolicy;
};

type HistoricalEvaluationPolicy =
  | HistoricalEvaluationPolicyWithoutNative
  | HistoricalEvaluationPolicyWithNative;

type HistoricalEvaluationArtifactReference = {
  path: string;
  sha256: string;
};

type HistoricalEvaluationCandidateProvenance = {
  runId: string;
  endedAt: string;
  artifact: HistoricalEvaluationArtifactReference;
};

type HistoricalEvaluationEligibleCandidate = {
  status: 'eligible';
  provenance: HistoricalEvaluationCandidateProvenance;
};

type HistoricalEvaluationExcludedCandidate = {
  status: 'ineligible';
  provenance: HistoricalEvaluationCandidateProvenance;
  reasons: NonEmptyArray<HistoricalEvaluationExclusionReason>;
};

type HistoricalEvaluationCurrentEligibility =
  | {
      status: 'eligible';
      reasons: [];
    }
  | {
      status: 'ineligible';
      reasons: NonEmptyArray<HistoricalEvaluationExclusionReason>;
    };

type HistoricalEvaluationEligibility = {
  currentRun: HistoricalEvaluationCurrentEligibility;
  historicalPopulation: {
    included: HistoricalEvaluationEligibleCandidate[];
    excluded: HistoricalEvaluationExcludedCandidate[];
  };
};

type HistoricalEvaluationMetricSample = {
  metricId: string;
  value: number;
};

type HistoricalEvaluationOrderedSample = {
  order: number;
  provenance: HistoricalEvaluationCandidateProvenance;
  metrics: NonEmptyArray<HistoricalEvaluationMetricSample>;
};

type HistoricalEvaluationAggregatedMetric =
  | {
      metricId: string;
      status: 'computed';
      sampleCount: number;
      value: number;
    }
  | {
      metricId: string;
      status: Exclude<HistoricalEvaluationAggregationStatus, 'computed'>;
      sampleCount: number;
      value: null;
    };

type HistoricalEvaluationAggregation = {
  status: HistoricalEvaluationAggregationStatus;
  eligibleRunCount: number;
  orderedSamples: HistoricalEvaluationOrderedSample[];
  metrics: NonEmptyArray<HistoricalEvaluationAggregatedMetric>;
};

type HistoricalEvaluationCurrentSample =
  | {
      provenance: HistoricalEvaluationCandidateProvenance;
      status: 'eligible';
      reasons: [];
      metrics: NonEmptyArray<HistoricalEvaluationMetricSample>;
    }
  | {
      provenance: HistoricalEvaluationCandidateProvenance;
      status: 'ineligible';
      reasons: NonEmptyArray<HistoricalEvaluationExclusionReason>;
      metrics: [];
    };

type HistoricalEvaluationDirectionalMetricDecision = {
  metricId: string;
  status: HistoricalEvaluationDirectionalDecisionStatus;
  reason: string;
  historicalValue: number;
  currentValue: number;
  /** currentValue - historicalValue */
  delta: number;
  /** delta / abs(historicalValue) * 100, or null when historicalValue is zero. */
  percentChange: number | null;
};

type HistoricalEvaluationNoDecisionMetricDecision = {
  metricId: string;
  status: HistoricalEvaluationNoDecisionStatus;
  reason: string;
  historicalValue?: never;
  currentValue?: never;
  delta?: never;
  percentChange?: never;
};

type HistoricalEvaluationMetricDecision =
  | HistoricalEvaluationDirectionalMetricDecision
  | HistoricalEvaluationNoDecisionMetricDecision;

type HistoricalEvaluationDecision = {
  status: HistoricalEvaluationDecisionStatus;
  reason: string;
  metrics: NonEmptyArray<HistoricalEvaluationMetricDecision>;
};

type HistoricalEvaluationResult = {
  eligibility: HistoricalEvaluationEligibility;
  aggregation: HistoricalEvaluationAggregation;
  currentSample: HistoricalEvaluationCurrentSample;
  decision: HistoricalEvaluationDecision;
};

type HistoricalEvaluationArtifactBase = {
  schemaVersion: '1.0.0';
  artifactType: 'historical-evaluation';
  scope: HistoricalEvaluationScope;
  evaluation: HistoricalEvaluationResult;
};

type UnvalidatedHistoricalEvaluationArtifact = HistoricalEvaluationArtifactBase &
  (
    | {
        policy: HistoricalEvaluationPolicyWithoutNative;
        nativeEvaluation?: never;
      }
    | {
        policy: HistoricalEvaluationPolicyWithNative;
        nativeEvaluation: HistoricalEvaluationResult;
      }
  );

type HistoricalEvaluationArtifact = UnvalidatedHistoricalEvaluationArtifact;

declare const validatedHistoricalEvaluationArtifactBrand: unique symbol;

type ValidatedHistoricalEvaluationArtifact = UnvalidatedHistoricalEvaluationArtifact & {
  readonly [validatedHistoricalEvaluationArtifactBrand]: true;
};

type HistoricalEvaluationValidationError = {
  code: string;
  path: string;
  message: string;
};

type HistoricalEvaluationValidationResult =
  | {
      valid: true;
      errors: [];
      value: ValidatedHistoricalEvaluationArtifact;
    }
  | {
      valid: false;
      errors: HistoricalEvaluationValidationError[];
    };

function addError(
  errors: HistoricalEvaluationValidationError[],
  code: string,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

function provenanceKey(provenance: HistoricalEvaluationCandidateProvenance): string {
  return JSON.stringify([
    provenance.runId,
    provenance.endedAt,
    provenance.artifact.path,
    provenance.artifact.sha256,
  ]);
}

function metricMap<T extends { metricId: string }>(
  metrics: T[],
  path: string,
  errors: HistoricalEvaluationValidationError[],
): Map<string, T> {
  const result = new Map<string, T>();
  metrics.forEach((metric, index) => {
    if (result.has(metric.metricId)) {
      addError(
        errors,
        'duplicate_metric_id',
        `${path}[${index}].metricId`,
        `Metric id ${JSON.stringify(metric.metricId)} must be unique.`,
      );
    } else {
      result.set(metric.metricId, metric);
    }
  });
  return result;
}

function validateMetricInventory<T extends { metricId: string }>(
  policyMetrics: HistoricalEvaluationMetricPolicy[],
  metrics: T[],
  path: string,
  errors: HistoricalEvaluationValidationError[],
): Map<string, T> {
  const metricsById = metricMap(metrics, path, errors);
  const policyIds = new Set(policyMetrics.map((metric) => metric.metricId));

  for (const policyMetric of policyMetrics) {
    if (!metricsById.has(policyMetric.metricId)) {
      addError(
        errors,
        'missing_policy_metric',
        path,
        `Required policy metric ${JSON.stringify(policyMetric.metricId)} is missing.`,
      );
    }
  }

  for (const metric of metrics) {
    if (!policyIds.has(metric.metricId)) {
      addError(
        errors,
        'unexpected_metric',
        path,
        `Metric ${JSON.stringify(metric.metricId)} is not declared by the active policy.`,
      );
    }
  }

  return metricsById;
}

function aggregateValues(values: number[], mode: HistoricalEvaluationAggregationMode): number {
  if (mode === 'mean') {
    // Preserve orderedSamples as the canonical floating-point reduction order.
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) {
    return ordered[middle] ?? 0;
  }
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function historicalEvaluationFloatRank(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const signMask = 1n << 63n;
  const magnitude = bits & (signMask - 1n);
  return (bits & signMask) === 0n ? signMask + magnitude : signMask - magnitude;
}

function historicalEvaluationNumbersEquivalent(actual: number, expected: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return false;
  }
  if (actual === expected) {
    return true;
  }
  if (actual === 0 || expected === 0 || Math.sign(actual) !== Math.sign(expected)) {
    return false;
  }
  const actualRank = historicalEvaluationFloatRank(actual);
  const expectedRank = historicalEvaluationFloatRank(expected);
  const distance =
    actualRank >= expectedRank ? actualRank - expectedRank : expectedRank - actualRank;
  return distance <= 8n;
}

function canonicalExclusionReasons(
  reasons: HistoricalEvaluationExclusionReason[],
): HistoricalEvaluationExclusionReason[] {
  return [...new Set(reasons)].sort();
}

function exclusionReasonsEqual(
  left: HistoricalEvaluationExclusionReason[],
  right: HistoricalEvaluationExclusionReason[],
): boolean {
  const canonicalLeft = canonicalExclusionReasons(left);
  const canonicalRight = canonicalExclusionReasons(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((reason, index) => reason === canonicalRight[index])
  );
}

function directionalStatus({
  currentValue,
  historicalValue,
  policy,
}: {
  currentValue: number;
  historicalValue: number;
  policy: HistoricalEvaluationMetricPolicy;
}): HistoricalEvaluationDirectionalDecisionStatus {
  const delta = currentValue - historicalValue;
  const tolerance = Math.max(
    policy.tolerance.absolute,
    policy.tolerance.relative * Math.abs(historicalValue),
  );
  if (Math.abs(delta) <= tolerance) {
    return 'unchanged';
  }
  if (policy.direction === 'lower-is-better') {
    return delta < 0 ? 'improved' : 'regressed';
  }
  return delta > 0 ? 'improved' : 'regressed';
}

function reduceDecisionStatuses(
  statuses: HistoricalEvaluationMetricDecision['status'][],
): HistoricalEvaluationDecisionStatus {
  if (statuses.includes('not-comparable')) {
    return 'not-comparable';
  }
  if (statuses.includes('insufficient-evidence')) {
    return 'insufficient-evidence';
  }
  const hasImprovement = statuses.includes('improved');
  const hasRegression = statuses.includes('regressed');
  if (hasImprovement && hasRegression) {
    return 'mixed';
  }
  if (hasRegression) {
    return 'regressed';
  }
  if (hasImprovement) {
    return 'improved';
  }
  return 'unchanged';
}

function isDirectionalMetricDecision(
  decision: HistoricalEvaluationMetricDecision,
): decision is HistoricalEvaluationDirectionalMetricDecision {
  return (
    decision.status === 'improved' ||
    decision.status === 'regressed' ||
    decision.status === 'unchanged'
  );
}

function validateEvaluationResult({
  currentRunIds,
  errors,
  path,
  policy,
  result,
}: {
  currentRunIds: ReadonlySet<string>;
  errors: HistoricalEvaluationValidationError[];
  path: string;
  policy: HistoricalEvaluationPopulationPolicy;
  result: HistoricalEvaluationResult;
}): void {
  metricMap(policy.metrics, `${path}.policy.metrics`, errors);
  const included = result.eligibility.historicalPopulation.included;
  const excluded = result.eligibility.historicalPopulation.excluded;
  const orderedSamples = result.aggregation.orderedSamples;

  if (
    result.eligibility.currentRun.status !== result.currentSample.status ||
    !exclusionReasonsEqual(
      result.eligibility.currentRun.reasons,
      result.currentSample.reasons,
    )
  ) {
    addError(
      errors,
      'current_eligibility_mismatch',
      `${path}.eligibility.currentRun`,
      'Current-run eligibility must match the current sample status and reasons.',
    );
  }

  const historicalLocations = [
    ...included.map((candidate, index) => ({
      path: `${path}.eligibility.historicalPopulation.included[${index}].provenance.runId`,
      runId: candidate.provenance.runId,
    })),
    ...excluded.map((candidate, index) => ({
      path: `${path}.eligibility.historicalPopulation.excluded[${index}].provenance.runId`,
      runId: candidate.provenance.runId,
    })),
    ...orderedSamples.map((sample, index) => ({
      path: `${path}.aggregation.orderedSamples[${index}].provenance.runId`,
      runId: sample.provenance.runId,
    })),
  ];
  for (const location of historicalLocations) {
    if (currentRunIds.has(location.runId)) {
      addError(
        errors,
        'current_run_in_history',
        location.path,
        'Neither ordinary nor native current run may appear in historical evidence.',
      );
    }
  }

  const includedByRunId = new Map<string, HistoricalEvaluationCandidateProvenance>();
  included.forEach((candidate, index) => {
    const runId = candidate.provenance.runId;
    if (includedByRunId.has(runId)) {
      addError(
        errors,
        'duplicate_historical_run',
        `${path}.eligibility.historicalPopulation.included[${index}].provenance.runId`,
        `Included historical run ${JSON.stringify(runId)} must be unique.`,
      );
    } else {
      includedByRunId.set(runId, candidate.provenance);
    }
  });

  const excludedRunIds = new Set<string>();
  excluded.forEach((candidate, index) => {
    const runId = candidate.provenance.runId;
    if (excludedRunIds.has(runId) || includedByRunId.has(runId)) {
      addError(
        errors,
        'duplicate_historical_run',
        `${path}.eligibility.historicalPopulation.excluded[${index}].provenance.runId`,
        `Excluded historical run ${JSON.stringify(runId)} must be unique and not included.`,
      );
    }
    excludedRunIds.add(runId);
  });

  const samplesByRunId = new Map<string, HistoricalEvaluationCandidateProvenance>();
  orderedSamples.forEach((sample, index) => {
    if (sample.order !== index) {
      addError(
        errors,
        'invalid_sample_order',
        `${path}.aggregation.orderedSamples[${index}].order`,
        `Ordered samples must use contiguous zero-based order; expected ${index}.`,
      );
    }
    const runId = sample.provenance.runId;
    if (samplesByRunId.has(runId)) {
      addError(
        errors,
        'duplicate_historical_run',
        `${path}.aggregation.orderedSamples[${index}].provenance.runId`,
        `Ordered sample run ${JSON.stringify(runId)} must be unique.`,
      );
    } else {
      samplesByRunId.set(runId, sample.provenance);
    }
    validateMetricInventory(
      policy.metrics,
      sample.metrics,
      `${path}.aggregation.orderedSamples[${index}].metrics`,
      errors,
    );
  });

  const populationMatchesSamples =
    includedByRunId.size === samplesByRunId.size &&
    [...includedByRunId].every(([runId, provenance]) => {
      const sampleProvenance = samplesByRunId.get(runId);
      return sampleProvenance && provenanceKey(provenance) === provenanceKey(sampleProvenance);
    });
  if (!populationMatchesSamples) {
    addError(
      errors,
      'population_sample_mismatch',
      `${path}.aggregation.orderedSamples`,
      'Included historical candidates and ordered samples must contain identical provenance.',
    );
  }

  if (result.aggregation.eligibleRunCount !== orderedSamples.length) {
    addError(
      errors,
      'eligible_run_count_mismatch',
      `${path}.aggregation.eligibleRunCount`,
      `eligibleRunCount must equal the canonical ordered sample count ${orderedSamples.length}.`,
    );
  }

  if (
    result.aggregation.status === 'computed' &&
    orderedSamples.length < policy.minimumEligibleRuns
  ) {
    addError(
      errors,
      'computed_below_minimum',
      `${path}.aggregation.status`,
      `Computed aggregation requires at least ${policy.minimumEligibleRuns} eligible runs.`,
    );
  }

  const aggregationMetrics = validateMetricInventory(
    policy.metrics,
    result.aggregation.metrics,
    `${path}.aggregation.metrics`,
    errors,
  );
  const currentMetrics =
    result.currentSample.status === 'eligible'
      ? validateMetricInventory(
          policy.metrics,
          result.currentSample.metrics,
          `${path}.currentSample.metrics`,
          errors,
        )
      : new Map<string, HistoricalEvaluationMetricSample>();
  const decisionMetrics = validateMetricInventory(
    policy.metrics,
    result.decision.metrics,
    `${path}.decision.metrics`,
    errors,
  );

  for (const policyMetric of policy.metrics) {
    const samples = orderedSamples
      .map((sample) => sample.metrics.find((metric) => metric.metricId === policyMetric.metricId))
      .filter((metric): metric is HistoricalEvaluationMetricSample => metric !== undefined);
    const aggregationMetric = aggregationMetrics.get(policyMetric.metricId);
    if (!aggregationMetric) {
      continue;
    }
    if (aggregationMetric.sampleCount !== samples.length) {
      addError(
        errors,
        'sample_count_mismatch',
        `${path}.aggregation.metrics`,
        `sampleCount for ${JSON.stringify(policyMetric.metricId)} must equal ${samples.length}.`,
      );
    }
    if (aggregationMetric.status !== result.aggregation.status) {
      addError(
        errors,
        'aggregation_status_mismatch',
        `${path}.aggregation.metrics`,
        `Metric aggregation status must match ${JSON.stringify(result.aggregation.status)}.`,
      );
    }
    let canonicalHistoricalValue: number | undefined;
    if (aggregationMetric.status === 'computed' && samples.length > 0) {
      canonicalHistoricalValue = aggregateValues(
        samples.map((sample) => sample.value),
        policy.aggregation,
      );
      if (
        !historicalEvaluationNumbersEquivalent(
          aggregationMetric.value,
          canonicalHistoricalValue,
        )
      ) {
        addError(
          errors,
          'aggregation_value_mismatch',
          `${path}.aggregation.metrics`,
          `Aggregated value for ${JSON.stringify(policyMetric.metricId)} must equal ${canonicalHistoricalValue}.`,
        );
      }
    }

    const decisionMetric = decisionMetrics.get(policyMetric.metricId);
    const currentMetric = currentMetrics.get(policyMetric.metricId);
    if (!decisionMetric) {
      continue;
    }
    if (!isDirectionalMetricDecision(decisionMetric)) {
      if (aggregationMetric.status === 'computed' && currentMetric) {
        addError(
          errors,
          'no_decision_with_complete_samples',
          `${path}.decision.metrics`,
          `No-decision status for ${JSON.stringify(policyMetric.metricId)} requires incomplete or non-comparable evidence.`,
        );
      }
      continue;
    }
    if (
      aggregationMetric.status !== 'computed' ||
      canonicalHistoricalValue === undefined ||
      !currentMetric
    ) {
      addError(
        errors,
        'directional_decision_without_samples',
        `${path}.decision.metrics`,
        `Directional decision for ${JSON.stringify(policyMetric.metricId)} requires computed historical and current samples.`,
      );
      continue;
    }
    if (
      !historicalEvaluationNumbersEquivalent(
        decisionMetric.historicalValue,
        canonicalHistoricalValue,
      ) ||
      decisionMetric.currentValue !== currentMetric.value
    ) {
      addError(
        errors,
        'decision_operand_mismatch',
        `${path}.decision.metrics`,
        `Decision operands for ${JSON.stringify(policyMetric.metricId)} must match canonical samples.`,
      );
    }
    const expectedDelta = currentMetric.value - canonicalHistoricalValue;
    if (!historicalEvaluationNumbersEquivalent(decisionMetric.delta, expectedDelta)) {
      addError(
        errors,
        'delta_mismatch',
        `${path}.decision.metrics`,
        `delta must equal currentValue - historicalValue (${expectedDelta}).`,
      );
    }
    const expectedPercentChange =
      canonicalHistoricalValue === 0
        ? null
        : (expectedDelta / Math.abs(canonicalHistoricalValue)) * 100;
    const percentChangeMatches =
      expectedPercentChange === null
        ? decisionMetric.percentChange === null
        : decisionMetric.percentChange !== null &&
          historicalEvaluationNumbersEquivalent(
            decisionMetric.percentChange,
            expectedPercentChange,
          );
    if (!percentChangeMatches) {
      addError(
        errors,
        'percent_change_mismatch',
        `${path}.decision.metrics`,
        `percentChange must equal delta / abs(historicalValue) * 100, or null for zero history.`,
      );
    }
    const expectedStatus = directionalStatus({
      currentValue: currentMetric.value,
      historicalValue: canonicalHistoricalValue,
      policy: policyMetric,
    });
    if (decisionMetric.status !== expectedStatus) {
      addError(
        errors,
        'metric_decision_mismatch',
        `${path}.decision.metrics`,
        `Metric decision must be ${JSON.stringify(expectedStatus)} after declared tolerance and direction.`,
      );
    }
  }

  const expectedDecision = reduceDecisionStatuses(
    result.decision.metrics.map((metric) => metric.status),
  );
  if (result.decision.status !== expectedDecision) {
    addError(
      errors,
      'aggregate_decision_mismatch',
      `${path}.decision.status`,
      `Aggregate decision must reduce to ${JSON.stringify(expectedDecision)}.`,
    );
  }
}

/**
 * Validates structural schema and cross-record semantics without mutating the input.
 */
function validateHistoricalEvaluationArtifact(value: unknown): HistoricalEvaluationValidationResult {
  const structural = validateJson(
    value,
    SCHEMAS.historicalEvaluation,
    'Historical evaluation artifact',
  );
  if (!structural.valid) {
    return {
      valid: false,
      errors: structural.errors,
    };
  }

  const artifact = value as UnvalidatedHistoricalEvaluationArtifact;
  const errors: HistoricalEvaluationValidationError[] = [];
  const ordinaryCurrent = artifact.evaluation.currentSample.provenance;
  const nativeCurrent = artifact.nativeEvaluation?.currentSample.provenance;
  const currentRunIds = new Set([ordinaryCurrent.runId]);
  if (nativeCurrent) {
    currentRunIds.add(nativeCurrent.runId);
    if (nativeCurrent.runId !== ordinaryCurrent.runId) {
      addError(
        errors,
        'current_run_provenance_mismatch',
        '$.nativeEvaluation.currentSample.provenance.runId',
        'Ordinary and native current samples must identify the same runId.',
      );
    }
    if (nativeCurrent.endedAt !== ordinaryCurrent.endedAt) {
      addError(
        errors,
        'current_run_provenance_mismatch',
        '$.nativeEvaluation.currentSample.provenance.endedAt',
        'Ordinary and native current samples must identify the same endedAt.',
      );
    }
  }
  validateEvaluationResult({
    currentRunIds,
    errors,
    path: '$.evaluation',
    policy: artifact.policy.metrics,
    result: artifact.evaluation,
  });
  if (artifact.policy.nativeHistory && artifact.nativeEvaluation) {
    validateEvaluationResult({
      currentRunIds,
      errors,
      path: '$.nativeEvaluation',
      policy: artifact.policy.nativeHistory,
      result: artifact.nativeEvaluation,
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    errors: [],
    value: artifact as ValidatedHistoricalEvaluationArtifact,
  };
}

export {
  validateHistoricalEvaluationArtifact,
};

export type {
  HistoricalEvaluationAggregatedMetric,
  HistoricalEvaluationAggregation,
  HistoricalEvaluationAggregationMode,
  HistoricalEvaluationAggregationStatus,
  HistoricalEvaluationArtifact,
  HistoricalEvaluationArtifactReference,
  HistoricalEvaluationCandidateProvenance,
  HistoricalEvaluationCurrentEligibility,
  HistoricalEvaluationCurrentSample,
  HistoricalEvaluationDecision,
  HistoricalEvaluationDecisionStatus,
  HistoricalEvaluationDirection,
  HistoricalEvaluationDirectionalDecisionStatus,
  HistoricalEvaluationDirectionalMetricDecision,
  HistoricalEvaluationEligibility,
  HistoricalEvaluationEligibilityStatus,
  HistoricalEvaluationEligibleCandidate,
  HistoricalEvaluationExcludedCandidate,
  HistoricalEvaluationExclusionReason,
  HistoricalEvaluationMetricDecision,
  HistoricalEvaluationMetricPolicy,
  HistoricalEvaluationMetricSample,
  HistoricalEvaluationNoDecisionMetricDecision,
  HistoricalEvaluationNoDecisionStatus,
  HistoricalEvaluationOrderedSample,
  HistoricalEvaluationPolicy,
  HistoricalEvaluationPolicyWithNative,
  HistoricalEvaluationPolicyWithoutNative,
  HistoricalEvaluationPopulationPolicy,
  HistoricalEvaluationResult,
  HistoricalEvaluationScope,
  HistoricalEvaluationTolerance,
  HistoricalEvaluationValidationError,
  HistoricalEvaluationValidationResult,
  NonEmptyArray,
  UnvalidatedHistoricalEvaluationArtifact,
  ValidatedHistoricalEvaluationArtifact,
};
