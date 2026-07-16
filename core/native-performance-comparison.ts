type JsonRecord = Record<string, unknown>;
type JsonScalar = string | number | boolean | null;

type NativePerformanceComparisonStatus = 'improved' | 'regressed' | 'unchanged' | 'mixed' | 'not-comparable';
type NativePerformanceMetricStatus = 'improved' | 'regressed' | 'unchanged' | 'not-comparable';
type NativePerformanceExplanationCode =
  | 'missing-evidence'
  | 'ambiguous-evidence'
  | 'untrusted-evidence'
  | 'incompatible-run'
  | 'policy-mismatch'
  | 'invalid-metric'
  | 'unsupported-version';
type NativePerformanceExplanationPhase = 'baseline' | 'current' | 'pair' | 'metric';
type NativePerformanceComparisonSurface = 'frames' | 'memory' | 'metrics';
type NativePerformanceComparisonUnit = 'ms' | 'count' | 'bytes' | 'percent';
type NativePerformanceComparisonAggregation = 'count' | 'last' | 'max' | 'mean' | 'p50' | 'p90' | 'p95' | 'p99' | 'sum';
type NativePerformanceComparisonDirection = 'lower-is-better' | 'higher-is-better';
type NativePerformanceComparisonBudgetOperator = 'at-most' | 'at-least';

type NativePerformanceComparisonExplanation = {
  code: NativePerformanceExplanationCode;
  phase: NativePerformanceExplanationPhase;
  reason: string;
  field?: string;
  metricId?: string;
  baseline?: JsonScalar;
  current?: JsonScalar;
};

type NativePerformanceComparisonBudgetResult = {
  result: 'passed' | 'failed' | 'not-configured';
  operator?: NativePerformanceComparisonBudgetOperator;
  threshold?: number;
};

type NativePerformanceComparisonMetric = {
  aggregation: NativePerformanceComparisonAggregation;
  baseline: number | null;
  budget: NativePerformanceComparisonBudgetResult;
  current: number | null;
  delta: number | null;
  direction: NativePerformanceComparisonDirection;
  id: string;
  percentChange: number | null;
  percentChangeReason?: 'zero-baseline';
  sample: string;
  status: NativePerformanceMetricStatus;
  surface: NativePerformanceComparisonSurface;
  unit: NativePerformanceComparisonUnit;
};

type NativePerformanceComparisonSection = {
  explanations: NativePerformanceComparisonExplanation[];
  metrics: NativePerformanceComparisonMetric[];
  policyId?: string;
  status: NativePerformanceComparisonStatus;
};

type NativePerformanceComparisonEnvironment = {
  name: string;
  value: JsonScalar;
};

type NativePerformanceComparisonPolicy = {
  environment: NativePerformanceComparisonEnvironment[];
  policyId: string;
  providerVersion: string;
  target: {
    buildMode: string;
    family: string;
  };
  window: {
    definitionId: string;
    durationMs: number;
    kind: string;
    phase: string;
  };
};

type NativePerformanceComparisonTolerance = {
  absolute: number;
  relative: number;
};

type NativePerformanceComparisonBudget = {
  operator: NativePerformanceComparisonBudgetOperator;
  threshold: number;
};

type NativePerformanceComparisonDescriptor = {
  aggregation: NativePerformanceComparisonAggregation;
  budget?: NativePerformanceComparisonBudget;
  direction: NativePerformanceComparisonDirection;
  id: string;
  sample: string;
  surface: NativePerformanceComparisonSurface;
  tolerance: NativePerformanceComparisonTolerance;
  unit: NativePerformanceComparisonUnit;
};

type NormalizedComparisonContract = {
  metrics: NativePerformanceComparisonDescriptor[];
  policy: NativePerformanceComparisonPolicy;
};

const COMPARISON_SURFACES = new Set<NativePerformanceComparisonSurface>(['frames', 'memory', 'metrics']);
const COMPARISON_UNITS = new Set<NativePerformanceComparisonUnit>(['ms', 'count', 'bytes', 'percent']);
const COMPARISON_AGGREGATIONS = new Set<NativePerformanceComparisonAggregation>([
  'count',
  'last',
  'max',
  'mean',
  'p50',
  'p90',
  'p95',
  'p99',
  'sum',
]);
const COMPARISON_DIRECTIONS = new Set<NativePerformanceComparisonDirection>(['lower-is-better', 'higher-is-better']);
const COMPARISON_BUDGET_OPERATORS = new Set<NativePerformanceComparisonBudgetOperator>(['at-most', 'at-least']);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readScalar(value: unknown): JsonScalar | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isScalar(value)) {
    return undefined;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function compareJsonScalar(left: JsonScalar, right: JsonScalar): boolean {
  return typeof left === typeof right && left === right;
}

function explanationSortKey(explanation: NativePerformanceComparisonExplanation): string {
  const ordered: JsonRecord = {
    code: explanation.code,
    phase: explanation.phase,
    ...(explanation.field !== undefined ? { field: explanation.field } : {}),
    ...(explanation.metricId !== undefined ? { metricId: explanation.metricId } : {}),
    ...(explanation.baseline !== undefined ? { baseline: explanation.baseline } : {}),
    ...(explanation.current !== undefined ? { current: explanation.current } : {}),
    reason: explanation.reason,
  };
  return JSON.stringify(ordered);
}

function normalizeExplanations(
  explanations: NativePerformanceComparisonExplanation[],
): NativePerformanceComparisonExplanation[] {
  return [...explanations].sort((left, right) => explanationSortKey(left).localeCompare(explanationSortKey(right)));
}

function buildExplanation({
  code,
  current,
  field,
  baseline,
  metricId,
  phase,
  reason,
}: {
  code: NativePerformanceExplanationCode;
  current?: JsonScalar;
  field?: string;
  baseline?: JsonScalar;
  metricId?: string;
  phase: NativePerformanceExplanationPhase;
  reason: string;
}): NativePerformanceComparisonExplanation {
  return {
    code,
    phase,
    reason,
    ...(field ? { field } : {}),
    ...(metricId ? { metricId } : {}),
    ...(baseline !== undefined ? { baseline } : {}),
    ...(current !== undefined ? { current } : {}),
  };
}

function buildNotComparableNativePerformanceComparison({
  explanations,
  metrics = [],
  policyId,
}: {
  explanations: NativePerformanceComparisonExplanation[];
  metrics?: NativePerformanceComparisonMetric[];
  policyId?: string;
}): NativePerformanceComparisonSection {
  return {
    explanations: normalizeExplanations(explanations),
    metrics,
    ...(policyId ? { policyId } : {}),
    status: 'not-comparable',
  };
}

function parseSchemaVersion(value: unknown): { major: number; minor: number; patch: number } | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim());
  if (!match) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(patch)
    ? { major, minor, patch }
    : null;
}

function budgetOperatorMatchesDirection(
  operator: NativePerformanceComparisonBudgetOperator,
  direction: NativePerformanceComparisonDirection,
): boolean {
  return (
    (operator === 'at-most' && direction === 'lower-is-better') ||
    (operator === 'at-least' && direction === 'higher-is-better')
  );
}

function normalizeEnvironment(
  value: unknown,
  phase: NativePerformanceExplanationPhase,
  explanations: NativePerformanceComparisonExplanation[],
): NativePerformanceComparisonEnvironment[] | null {
  if (!Array.isArray(value)) {
    explanations.push(buildExplanation({
      code: 'policy-mismatch',
      field: 'comparisonPolicy.environment',
      phase,
      reason: 'Comparison policy environment must be an array.',
    }));
    return null;
  }
  if (value.length === 0) {
    explanations.push(buildExplanation({
      code: 'policy-mismatch',
      field: 'comparisonPolicy.environment',
      phase,
      reason: 'Comparison policy environment must declare at least one same-condition constraint.',
    }));
    return null;
  }

  const seen = new Set<string>();
  const entries: NativePerformanceComparisonEnvironment[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      explanations.push(buildExplanation({
        code: 'policy-mismatch',
        field: 'comparisonPolicy.environment',
        phase,
        reason: 'Comparison policy environment entries must be objects.',
      }));
      return null;
    }

    const name = readString(entry.name);
    const environmentValue = readScalar(entry.value);
    if (!name || environmentValue === undefined) {
      explanations.push(buildExplanation({
        code: 'policy-mismatch',
        field: 'comparisonPolicy.environment',
        phase,
        reason: 'Comparison policy environment entries require a non-empty name and scalar value.',
      }));
      return null;
    }
    if (seen.has(name)) {
      explanations.push(buildExplanation({
        code: 'policy-mismatch',
        field: `comparisonPolicy.environment.${name}`,
        phase,
        reason: 'Comparison policy environment names must be unique.',
      }));
      return null;
    }
    seen.add(name);
    entries.push({ name, value: environmentValue });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function normalizePolicy(
  evidence: JsonRecord,
  phase: NativePerformanceExplanationPhase,
  explanations: NativePerformanceComparisonExplanation[],
): NativePerformanceComparisonPolicy | null {
  const policy = isRecord(evidence.comparisonPolicy) ? evidence.comparisonPolicy : null;
  if (!policy) {
    explanations.push(buildExplanation({
      code: 'unsupported-version',
      field: 'comparisonPolicy',
      phase,
      reason: 'Comparable native-performance evidence requires a structured comparisonPolicy block in schemaVersion 1.1.0.',
    }));
    return null;
  }

  const policyId = readString(policy.policyId);
  const providerVersion = readString(policy.providerVersion);
  const window = isRecord(policy.window) ? policy.window : null;
  const target = isRecord(policy.target) ? policy.target : null;
  const environment = normalizeEnvironment(policy.environment, phase, explanations);
  const definitionId = readString(window?.definitionId);
  const kind = readString(window?.kind);
  const windowPhase = readString(window?.phase);
  const durationMs = readFiniteNumber(window?.durationMs);
  const family = readString(target?.family);
  const buildMode = readString(target?.buildMode);

  if (!policyId || !providerVersion || !window || !target || !definitionId || !kind || !windowPhase || durationMs === null || durationMs <= 0 || !family || !buildMode || !environment) {
    explanations.push(buildExplanation({
      code: 'policy-mismatch',
      field: 'comparisonPolicy',
      phase,
      reason: 'Structured comparisonPolicy requires policyId, providerVersion, bounded window, target family/build mode, and declared environment conditions.',
    }));
    return null;
  }

  return {
    environment,
    policyId,
    providerVersion,
    target: {
      buildMode,
      family,
    },
    window: {
      definitionId,
      durationMs,
      kind,
      phase: windowPhase,
    },
  };
}

function normalizeBudget(
  value: unknown,
  direction: NativePerformanceComparisonDirection,
  phase: NativePerformanceExplanationPhase,
  metricId: string,
  explanations: NativePerformanceComparisonExplanation[],
): NativePerformanceComparisonBudget | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    explanations.push(buildExplanation({
      code: 'policy-mismatch',
      field: 'comparisonMetrics.budget',
      metricId,
      phase,
      reason: 'Metric budget must be an object when declared.',
    }));
    return null;
  }

  const operator = readString(value.operator);
  const threshold = readFiniteNumber(value.threshold);
  if (
    (operator !== 'at-most' && operator !== 'at-least') ||
    threshold === null ||
    !budgetOperatorMatchesDirection(operator, direction)
  ) {
    explanations.push(buildExplanation({
      code: 'policy-mismatch',
      field: 'comparisonMetrics.budget',
      metricId,
      phase,
      reason: 'Metric budget requires a finite threshold and an operator that agrees with the declared metric direction.',
    }));
    return null;
  }

  return {
    operator,
    threshold,
  };
}

function normalizeDescriptors(
  evidence: JsonRecord,
  phase: NativePerformanceExplanationPhase,
  explanations: NativePerformanceComparisonExplanation[],
): NativePerformanceComparisonDescriptor[] | null {
  const metrics = Array.isArray(evidence.comparisonMetrics) ? evidence.comparisonMetrics : null;
  if (!metrics || metrics.length === 0) {
    explanations.push(buildExplanation({
      code: 'unsupported-version',
      field: 'comparisonMetrics',
      phase,
      reason: 'Comparable native-performance evidence requires a non-empty comparisonMetrics array in schemaVersion 1.1.0.',
    }));
    return null;
  }

  const seen = new Set<string>();
  const descriptors: NativePerformanceComparisonDescriptor[] = [];
  for (const metric of metrics) {
    if (!isRecord(metric)) {
      explanations.push(buildExplanation({
        code: 'policy-mismatch',
        field: 'comparisonMetrics',
        phase,
        reason: 'comparisonMetrics entries must be objects.',
      }));
      return null;
    }

    const id = readString(metric.id);
    const surface = readString(metric.surface);
    const sample = readString(metric.sample);
    const unit = readString(metric.unit);
    const aggregation = readString(metric.aggregation);
    const direction = readString(metric.direction);
    const tolerance = isRecord(metric.tolerance) ? metric.tolerance : null;
    const absolute = readFiniteNumber(tolerance?.absolute);
    const relative = readFiniteNumber(tolerance?.relative);

    if (!id || seen.has(id)) {
      explanations.push(buildExplanation({
        code: 'policy-mismatch',
        field: 'comparisonMetrics.id',
        phase,
        reason: 'comparisonMetrics ids must be unique non-empty strings.',
      }));
      return null;
    }
    seen.add(id);

    if (
      !surface ||
      !COMPARISON_SURFACES.has(surface as NativePerformanceComparisonSurface) ||
      !sample ||
      !unit ||
      !COMPARISON_UNITS.has(unit as NativePerformanceComparisonUnit) ||
      !aggregation ||
      !COMPARISON_AGGREGATIONS.has(aggregation as NativePerformanceComparisonAggregation) ||
      !direction ||
      !COMPARISON_DIRECTIONS.has(direction as NativePerformanceComparisonDirection) ||
      absolute === null ||
      relative === null ||
      absolute < 0 ||
      relative < 0
    ) {
      explanations.push(buildExplanation({
        code: 'policy-mismatch',
        field: `comparisonMetrics.${id}`,
        metricId: id,
        phase,
        reason: 'Metric descriptors must declare a recognized surface, sample, unit, aggregation, direction, and non-negative absolute/relative tolerance.',
      }));
      return null;
    }

    const budget = normalizeBudget(metric.budget, direction as NativePerformanceComparisonDirection, phase, id, explanations);
    if (budget === null) {
      return null;
    }

    descriptors.push({
      aggregation: aggregation as NativePerformanceComparisonAggregation,
      ...(budget ? { budget } : {}),
      direction: direction as NativePerformanceComparisonDirection,
      id,
      sample,
      surface: surface as NativePerformanceComparisonSurface,
      tolerance: {
        absolute,
        relative,
      },
      unit: unit as NativePerformanceComparisonUnit,
    });
  }

  return descriptors.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeComparisonContract(
  evidence: JsonRecord,
  phase: NativePerformanceExplanationPhase,
): { contract: NormalizedComparisonContract | null; explanations: NativePerformanceComparisonExplanation[] } {
  const explanations: NativePerformanceComparisonExplanation[] = [];
  const version = parseSchemaVersion(evidence.schemaVersion);
  const schemaVersion = readScalar(evidence.schemaVersion);
  if (!version || version.major !== 1 || version.minor !== 1 || version.patch !== 0) {
    explanations.push(buildExplanation({
      code: 'unsupported-version',
      field: 'schemaVersion',
      phase,
      ...(schemaVersion !== undefined
        ? { baseline: schemaVersion }
        : {}),
      reason: 'Comparable native-performance evidence currently requires schemaVersion 1.1.0.',
    }));
    return { contract: null, explanations };
  }

  const policy = normalizePolicy(evidence, phase, explanations);
  const metrics = normalizeDescriptors(evidence, phase, explanations);
  if (!policy || !metrics) {
    return { contract: null, explanations };
  }

  return {
    contract: {
      metrics,
      policy,
    },
    explanations,
  };
}

function readMetricValue(
  evidence: JsonRecord,
  descriptor: NativePerformanceComparisonDescriptor,
): number | null {
  const surface = isRecord(evidence[descriptor.surface]) ? evidence[descriptor.surface] as JsonRecord : null;
  if (!surface) {
    return null;
  }
  return readFiniteNumber(surface[descriptor.sample]);
}

function validateMetricDomain(
  evidence: JsonRecord,
  descriptor: NativePerformanceComparisonDescriptor,
  phase: NativePerformanceExplanationPhase,
): NativePerformanceComparisonExplanation[] {
  const explanations: NativePerformanceComparisonExplanation[] = [];
  const value = readMetricValue(evidence, descriptor);
  if (value === null) {
    explanations.push(buildExplanation({
      code: 'invalid-metric',
      field: descriptor.sample,
      metricId: descriptor.id,
      phase: 'metric',
      reason: `${phase} metric ${descriptor.id} is missing or non-finite.`,
    }));
    return explanations;
  }

  if (value < 0) {
    explanations.push(buildExplanation({
      code: 'invalid-metric',
      field: descriptor.sample,
      metricId: descriptor.id,
      phase: 'metric',
      ...(phase === 'baseline' ? { baseline: value } : {}),
      ...(phase === 'current' ? { current: value } : {}),
      reason: `${phase} metric ${descriptor.id} must not be negative.`,
    }));
  }
  if (descriptor.unit === 'percent' && value > 100) {
    explanations.push(buildExplanation({
      code: 'invalid-metric',
      field: descriptor.sample,
      metricId: descriptor.id,
      phase: 'metric',
      ...(phase === 'baseline' ? { baseline: value } : {}),
      ...(phase === 'current' ? { current: value } : {}),
      reason: `${phase} metric ${descriptor.id} must remain within the 0-100 percent domain.`,
    }));
  }

  return explanations;
}

function validateFrameConsistency(
  evidence: JsonRecord,
  phase: NativePerformanceExplanationPhase,
): NativePerformanceComparisonExplanation[] {
  const frames = isRecord(evidence.frames) ? evidence.frames as JsonRecord : null;
  if (!frames) {
    return [];
  }

  const explanations: NativePerformanceComparisonExplanation[] = [];
  const totalFrameCount = readFiniteNumber(frames.totalFrameCount);
  const expectedFrameCount = readFiniteNumber(frames.expectedFrameCount);
  const jankyFrameCount = readFiniteNumber(frames.jankyFrameCount);
  const p50 = readFiniteNumber(frames.p50FrameMs);
  const p90 = readFiniteNumber(frames.p90FrameMs);
  const p95 = readFiniteNumber(frames.p95FrameMs);
  const p99 = readFiniteNumber(frames.p99FrameMs);

  if (totalFrameCount !== null && jankyFrameCount !== null && jankyFrameCount > totalFrameCount) {
    explanations.push(buildExplanation({
      code: 'invalid-metric',
      field: 'frames.jankyFrameCount',
      phase: 'metric',
      reason: `${phase} native-performance evidence reports jankyFrameCount greater than totalFrameCount.`,
    }));
  }

  if (expectedFrameCount !== null && totalFrameCount !== null && expectedFrameCount !== totalFrameCount) {
    explanations.push(buildExplanation({
      code: 'invalid-metric',
      field: 'frames.expectedFrameCount',
      phase: 'metric',
      reason: `${phase} native-performance evidence reports unreconciled frame counts across captured sources.`,
    }));
  }

  const percentileValues = [p50, p90, p95, p99].filter((value): value is number => value !== null);
  if (
    percentileValues.length > 1 &&
    (
      (p50 !== null && p90 !== null && p50 > p90) ||
      (p90 !== null && p95 !== null && p90 > p95) ||
      (p95 !== null && p99 !== null && p95 > p99)
    )
  ) {
    explanations.push(buildExplanation({
      code: 'invalid-metric',
      field: 'frames.percentiles',
      phase: 'metric',
      reason: `${phase} native-performance evidence reports impossible percentile ordering.`,
    }));
  }

  return explanations;
}

function compareEnvironmentSets(
  baseline: NativePerformanceComparisonEnvironment[],
  current: NativePerformanceComparisonEnvironment[],
): boolean {
  if (baseline.length !== current.length) {
    return false;
  }

  return baseline.every((entry, index) => {
    const other = current[index];
    if (!other) {
      return false;
    }

    return entry.name === other.name && compareJsonScalar(entry.value, other.value);
  });
}

function compareDescriptorSets(
  baseline: NativePerformanceComparisonDescriptor[],
  current: NativePerformanceComparisonDescriptor[],
): boolean {
  if (baseline.length !== current.length) {
    return false;
  }

  return baseline.every((descriptor, index) => JSON.stringify(descriptor) === JSON.stringify(current[index]));
}

function buildBudgetResult(
  descriptor: NativePerformanceComparisonDescriptor,
  currentValue: number,
): NativePerformanceComparisonBudgetResult {
  if (!descriptor.budget) {
    return {
      result: 'not-configured',
    };
  }

  const passed = descriptor.budget.operator === 'at-most'
    ? currentValue <= descriptor.budget.threshold
    : currentValue >= descriptor.budget.threshold;
  return {
    operator: descriptor.budget.operator,
    result: passed ? 'passed' : 'failed',
    threshold: descriptor.budget.threshold,
  };
}

function resolveDirectionalStatus({
  baselineValue,
  currentValue,
  descriptor,
}: {
  baselineValue: number;
  currentValue: number;
  descriptor: NativePerformanceComparisonDescriptor;
}): { delta: number; percentChange: number | null; percentChangeReason?: 'zero-baseline'; status: Exclude<NativePerformanceMetricStatus, 'not-comparable'> } {
  const delta = currentValue - baselineValue;
  const tolerance = Math.max(descriptor.tolerance.absolute, Math.abs(baselineValue) * descriptor.tolerance.relative);
  if (Math.abs(delta) <= tolerance) {
    return {
      delta,
      percentChange: baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100,
      ...(baselineValue === 0 ? { percentChangeReason: 'zero-baseline' } : {}),
      status: 'unchanged',
    };
  }

  const improved = descriptor.direction === 'lower-is-better'
    ? currentValue < baselineValue
    : currentValue > baselineValue;
  return {
    delta,
    percentChange: baselineValue === 0 ? null : (delta / Math.abs(baselineValue)) * 100,
    ...(baselineValue === 0 ? { percentChangeReason: 'zero-baseline' } : {}),
    status: improved ? 'improved' : 'regressed',
  };
}

function resolveAggregateStatus(
  metrics: NativePerformanceComparisonMetric[],
): NativePerformanceComparisonStatus {
  const statuses = metrics.map((metric) => metric.status);
  if (statuses.includes('not-comparable')) {
    return 'not-comparable';
  }
  const hasImproved = statuses.includes('improved');
  const hasRegressed = statuses.includes('regressed');
  if (hasImproved && hasRegressed) {
    return 'mixed';
  }
  if (hasRegressed) {
    return 'regressed';
  }
  if (hasImproved) {
    return 'improved';
  }
  return 'unchanged';
}

function compareNativePerformanceEvidencePair({
  baselineEvidence,
  currentEvidence,
}: {
  baselineEvidence: JsonRecord;
  currentEvidence: JsonRecord;
}): NativePerformanceComparisonSection {
  const baselineContract = normalizeComparisonContract(baselineEvidence, 'baseline');
  const currentContract = normalizeComparisonContract(currentEvidence, 'current');
  const explanations = [
    ...baselineContract.explanations,
    ...currentContract.explanations,
    ...validateFrameConsistency(baselineEvidence, 'baseline'),
    ...validateFrameConsistency(currentEvidence, 'current'),
  ];

  if (!baselineContract.contract || !currentContract.contract) {
    return buildNotComparableNativePerformanceComparison({
      explanations,
    });
  }

  const baselinePolicy = baselineContract.contract.policy;
  const currentPolicy = currentContract.contract.policy;
  const samePolicyId = baselinePolicy.policyId === currentPolicy.policyId ? baselinePolicy.policyId : undefined;

  const pairMismatches: Array<{ field: string; baseline: JsonScalar; current: JsonScalar; reason: string }> = [];
  const pairScalars: Array<{ field: string; baseline: JsonScalar; current: JsonScalar }> = [
    { field: 'providerId', baseline: readScalar(baselineEvidence.providerId) ?? null, current: readScalar(currentEvidence.providerId) ?? null },
    { field: 'platform', baseline: readScalar(baselineEvidence.platform) ?? null, current: readScalar(currentEvidence.platform) ?? null },
    { field: 'tool.name', baseline: readScalar(isRecord(baselineEvidence.tool) ? baselineEvidence.tool.name : undefined) ?? null, current: readScalar(isRecord(currentEvidence.tool) ? currentEvidence.tool.name : undefined) ?? null },
    { field: 'tool.version', baseline: readScalar(isRecord(baselineEvidence.tool) ? baselineEvidence.tool.version : undefined) ?? null, current: readScalar(isRecord(currentEvidence.tool) ? currentEvidence.tool.version : undefined) ?? null },
    { field: 'captureMode', baseline: readScalar(baselineEvidence.captureMode) ?? null, current: readScalar(currentEvidence.captureMode) ?? null },
    { field: 'comparisonPolicy.policyId', baseline: baselinePolicy.policyId, current: currentPolicy.policyId },
    { field: 'comparisonPolicy.providerVersion', baseline: baselinePolicy.providerVersion, current: currentPolicy.providerVersion },
    { field: 'comparisonPolicy.window.definitionId', baseline: baselinePolicy.window.definitionId, current: currentPolicy.window.definitionId },
    { field: 'comparisonPolicy.window.kind', baseline: baselinePolicy.window.kind, current: currentPolicy.window.kind },
    { field: 'comparisonPolicy.window.phase', baseline: baselinePolicy.window.phase, current: currentPolicy.window.phase },
    { field: 'comparisonPolicy.window.durationMs', baseline: baselinePolicy.window.durationMs, current: currentPolicy.window.durationMs },
    { field: 'comparisonPolicy.target.family', baseline: baselinePolicy.target.family, current: currentPolicy.target.family },
    { field: 'comparisonPolicy.target.buildMode', baseline: baselinePolicy.target.buildMode, current: currentPolicy.target.buildMode },
  ];

  for (const pairScalar of pairScalars) {
    if (!compareJsonScalar(pairScalar.baseline, pairScalar.current)) {
      pairMismatches.push({
        ...pairScalar,
        reason: `Pair contract field ${pairScalar.field} differs between baseline and current evidence.`,
      });
    }
  }

  if (!compareEnvironmentSets(baselinePolicy.environment, currentPolicy.environment)) {
    pairMismatches.push({
      field: 'comparisonPolicy.environment',
      baseline: JSON.stringify(baselinePolicy.environment),
      current: JSON.stringify(currentPolicy.environment),
      reason: 'Declared comparison environment conditions differ between baseline and current evidence.',
    });
  }

  if (!compareDescriptorSets(baselineContract.contract.metrics, currentContract.contract.metrics)) {
    pairMismatches.push({
      field: 'comparisonMetrics',
      baseline: baselineContract.contract.metrics.length,
      current: currentContract.contract.metrics.length,
      reason: 'Declared native-performance metric descriptors differ between baseline and current evidence.',
    });
  }

  if (pairMismatches.length > 0) {
    return buildNotComparableNativePerformanceComparison({
      explanations: [
        ...explanations,
        ...pairMismatches.map((mismatch) => buildExplanation({
          baseline: mismatch.baseline,
          code: mismatch.field === 'providerId' || mismatch.field === 'platform'
            ? 'incompatible-run'
            : 'policy-mismatch',
          current: mismatch.current,
          field: mismatch.field,
          phase: 'pair',
          reason: mismatch.reason,
        })),
      ],
      ...(samePolicyId ? { policyId: samePolicyId } : {}),
    });
  }

  if (explanations.length > 0) {
    return buildNotComparableNativePerformanceComparison({
      explanations,
      ...(samePolicyId ? { policyId: samePolicyId } : {}),
    });
  }

  const metrics: NativePerformanceComparisonMetric[] = [];
  const metricExplanations: NativePerformanceComparisonExplanation[] = [];

  for (const descriptor of baselineContract.contract.metrics) {
    const baselineMetricIssues = validateMetricDomain(baselineEvidence, descriptor, 'baseline');
    const currentMetricIssues = validateMetricDomain(currentEvidence, descriptor, 'current');
    if (baselineMetricIssues.length > 0 || currentMetricIssues.length > 0) {
      metricExplanations.push(...baselineMetricIssues, ...currentMetricIssues);
      metrics.push({
        aggregation: descriptor.aggregation,
        baseline: null,
        budget: {
          result: 'not-configured',
        },
        current: null,
        delta: null,
        direction: descriptor.direction,
        id: descriptor.id,
        percentChange: null,
        sample: descriptor.sample,
        status: 'not-comparable',
        surface: descriptor.surface,
        unit: descriptor.unit,
      });
      continue;
    }

    const baselineValue = readMetricValue(baselineEvidence, descriptor);
    const currentValue = readMetricValue(currentEvidence, descriptor);
    if (baselineValue === null || currentValue === null) {
      metricExplanations.push(buildExplanation({
        code: 'invalid-metric',
        field: descriptor.sample,
        metricId: descriptor.id,
        phase: 'metric',
        reason: `Metric ${descriptor.id} is missing or non-finite on one or both sides.`,
      }));
      metrics.push({
        aggregation: descriptor.aggregation,
        baseline: null,
        budget: {
          result: 'not-configured',
        },
        current: null,
        delta: null,
        direction: descriptor.direction,
        id: descriptor.id,
        percentChange: null,
        sample: descriptor.sample,
        status: 'not-comparable',
        surface: descriptor.surface,
        unit: descriptor.unit,
      });
      continue;
    }

    const directional = resolveDirectionalStatus({
      baselineValue,
      currentValue,
      descriptor,
    });
    metrics.push({
      aggregation: descriptor.aggregation,
      baseline: baselineValue,
      budget: buildBudgetResult(descriptor, currentValue),
      current: currentValue,
      delta: directional.delta,
      direction: descriptor.direction,
      id: descriptor.id,
      percentChange: directional.percentChange,
      ...(directional.percentChangeReason ? { percentChangeReason: directional.percentChangeReason } : {}),
      sample: descriptor.sample,
      status: directional.status,
      surface: descriptor.surface,
      unit: descriptor.unit,
    });
  }

  if (metrics.length === 0) {
    metricExplanations.push(buildExplanation({
      code: 'missing-evidence',
      field: 'comparisonMetrics',
      phase: 'pair',
      reason: 'No configured native-performance metrics were available for comparison.',
    }));
  }

  if (metricExplanations.length > 0) {
    return buildNotComparableNativePerformanceComparison({
      explanations: [...explanations, ...metricExplanations],
      metrics,
      ...(samePolicyId ? { policyId: samePolicyId } : {}),
    });
  }

  return {
    explanations: [],
    metrics,
    ...(samePolicyId ? { policyId: samePolicyId } : {}),
    status: resolveAggregateStatus(metrics),
  };
}

function isNativePerformanceRegressed(
  nativePerformance: NativePerformanceComparisonSection | undefined,
): boolean {
  return nativePerformance?.status === 'regressed';
}

export {
  buildExplanation,
  buildNotComparableNativePerformanceComparison,
  compareNativePerformanceEvidencePair,
  isNativePerformanceRegressed,
};

export type {
  NativePerformanceComparisonBudgetResult,
  NativePerformanceComparisonExplanation,
  NativePerformanceComparisonMetric,
  NativePerformanceComparisonSection,
  NativePerformanceComparisonStatus,
  NativePerformanceMetricStatus,
};
