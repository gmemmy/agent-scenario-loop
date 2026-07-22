const assert = require('node:assert/strict');
const test = require('node:test');

const { validateHistoricalEvaluationArtifact } = require('../historical-evaluation');
const { SCHEMAS, validateJson } = require('../schema-validator');

import type {
  HistoricalEvaluationArtifact,
  HistoricalEvaluationCandidateProvenance,
  HistoricalEvaluationMetricSample,
  HistoricalEvaluationResult,
  ValidatedHistoricalEvaluationArtifact,
} from '../historical-evaluation';

type JsonRecord = Record<string, any>;

function candidate(runId: string, order: number): HistoricalEvaluationCandidateProvenance {
  return {
    runId,
    endedAt: `2026-07-22T10:0${order}:00.000Z`,
    artifact: {
      path: `runs/${runId}/metrics.json`,
      sha256: String(order).repeat(64),
    },
  };
}

function evaluationResult({
  metricId,
  historicalValues,
  currentValue,
}: {
  metricId: string;
  historicalValues: number[];
  currentValue: number;
}): HistoricalEvaluationResult {
  const historicalValue = historicalValues[1] ?? historicalValues[0] ?? 0;
  const historicalCandidates = historicalValues.map((value, order) => ({
    order,
    provenance: candidate(`historical-${metricId}-${order}`, order + 1),
    metrics: [{ metricId, value }] as [HistoricalEvaluationMetricSample],
  }));

  return {
    eligibility: {
      currentRun: {
        status: 'eligible',
        reasons: [],
      },
      historicalPopulation: {
        included: historicalCandidates.map((sample) => ({
          status: 'eligible',
          provenance: sample.provenance,
        })),
        excluded: [
          {
            status: 'ineligible',
            provenance: candidate(`excluded-${metricId}`, 8),
            reasons: ['untrusted-health'],
          },
        ],
      },
    },
    aggregation: {
      status: 'computed',
      eligibleRunCount: historicalCandidates.length,
      orderedSamples: historicalCandidates,
      metrics: [
        {
          metricId,
          status: 'computed',
          sampleCount: historicalCandidates.length,
          value: historicalValue,
        },
      ],
    },
    currentSample: {
      provenance: candidate(`current-${metricId}`, 9),
      status: 'eligible',
      reasons: [],
      metrics: [{ metricId, value: currentValue }],
    },
    decision: {
      status: 'improved',
      reason: 'The current sample improved beyond the declared tolerance.',
      metrics: [
        {
          metricId,
          status: 'improved',
          reason: 'The current value is lower than the historical aggregate.',
          historicalValue,
          currentValue,
          delta: currentValue - historicalValue,
          percentChange: ((currentValue - historicalValue) / Math.abs(historicalValue)) * 100,
        },
      ],
    },
  };
}

function validArtifact(): HistoricalEvaluationArtifact {
  const artifact: HistoricalEvaluationArtifact = {
    schemaVersion: '1.0.0',
    artifactType: 'historical-evaluation',
    scope: {
      scenarioId: 'open-primary-surface',
      comparisonLane: 'android-release',
      cohortHash: 'c'.repeat(64),
      platform: 'android',
      lineage: {
        status: 'exact',
        scenarioHash: 'a'.repeat(64),
      },
    },
    policy: {
      history: 'local-only',
      metrics: {
        authority: 'consumer-declared',
        minimumEligibleRuns: 3,
        aggregation: 'median',
        warmup: 'none',
        outliers: 'none',
        metrics: [
          {
            metricId: 'ready-ms',
            unit: 'ms',
            direction: 'lower-is-better',
            tolerance: {
              absolute: 8,
              relative: 0.03,
            },
          },
        ],
      },
      nativeHistory: {
        authority: 'consumer-declared',
        minimumEligibleRuns: 3,
        aggregation: 'mean',
        warmup: 'none',
        outliers: 'none',
        metrics: [
          {
            metricId: 'frame-time-p95-ms',
            unit: 'ms',
            direction: 'lower-is-better',
            tolerance: {
              absolute: 1,
              relative: 0.02,
            },
          },
        ],
      },
    },
    evaluation: evaluationResult({
      metricId: 'ready-ms',
      historicalValues: [120, 125, 130],
      currentValue: 108,
    }),
    nativeEvaluation: evaluationResult({
      metricId: 'frame-time-p95-ms',
      historicalValues: [19, 20, 21],
      currentValue: 17,
    }),
  };
  if (artifact.nativeEvaluation) {
    artifact.nativeEvaluation.currentSample.provenance.runId =
      artifact.evaluation.currentSample.provenance.runId;
    artifact.nativeEvaluation.currentSample.provenance.endedAt =
      artifact.evaluation.currentSample.provenance.endedAt;
  }
  return artifact;
}

function clone(value: HistoricalEvaluationArtifact): JsonRecord {
  return structuredClone(value) as JsonRecord;
}

function nextUp(value: number): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value >= 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

function advanceUlps(value: number, count: number): number {
  let result = value;
  for (let index = 0; index < count; index += 1) {
    result = nextUp(result);
  }
  return result;
}

function setNativeNotReady(
  artifact: JsonRecord,
  eligibilityReasons: string[] = ['native-not-ready'],
  sampleReasons: string[] = eligibilityReasons,
): void {
  const nativeEvaluation = artifact.nativeEvaluation;
  nativeEvaluation.eligibility.currentRun = {
    status: 'ineligible',
    reasons: eligibilityReasons,
  };
  nativeEvaluation.eligibility.historicalPopulation = {
    included: [],
    excluded: [],
  };
  nativeEvaluation.aggregation = {
    status: 'insufficient-evidence',
    eligibleRunCount: 0,
    orderedSamples: [],
    metrics: [
      {
        metricId: 'frame-time-p95-ms',
        status: 'insufficient-evidence',
        sampleCount: 0,
        value: null,
      },
    ],
  };
  nativeEvaluation.currentSample = {
    provenance: nativeEvaluation.currentSample.provenance,
    status: 'ineligible',
    reasons: sampleReasons,
    metrics: [],
  };
  nativeEvaluation.decision = {
    status: 'insufficient-evidence',
    reason: 'Native evidence is not ready for historical evaluation.',
    metrics: [
      {
        metricId: 'frame-time-p95-ms',
        status: 'insufficient-evidence',
        reason: 'No native historical or current samples are eligible.',
      },
    ],
  };
}

function assertInvalid(artifact: JsonRecord, expectedPath: string): void {
  const result = validateJson(
    artifact,
    SCHEMAS.historicalEvaluation,
    'Historical evaluation artifact',
  );
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error: { path: string }) => error.path === expectedPath),
    `${result.message}\nExpected an error at ${expectedPath}`,
  );
}

function assertSemanticInvalid(artifact: JsonRecord, expectedCode: string): void {
  const result = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((error: { code: string }) => error.code === expectedCode),
    `Expected semantic error ${expectedCode}, received ${JSON.stringify(result.errors)}`,
  );
}

test('accepts a strict local-only historical evaluation artifact', () => {
  const artifact = validArtifact();
  const result = validateJson(
    artifact,
    SCHEMAS.historicalEvaluation,
    'Historical evaluation artifact',
  );

  assert.equal(result.valid, true, result.message);
  const semanticResult = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(semanticResult.valid, true, JSON.stringify(semanticResult.errors));
  if (semanticResult.valid) {
    const validated: ValidatedHistoricalEvaluationArtifact = semanticResult.value;
    assert.equal(validated, artifact);
  }
  assert.equal(
    artifact.evaluation.eligibility.historicalPopulation.included.some(
      (entry) => entry.provenance.runId === artifact.evaluation.currentSample.provenance.runId,
    ),
    false,
  );
  assert.notEqual(artifact.evaluation.decision, artifact.nativeEvaluation?.decision);
});

test('rejects differing ordinary and native current run ids', () => {
  const artifact = clone(validArtifact());
  artifact.nativeEvaluation.currentSample.provenance.runId = 'different-current-run';
  assertSemanticInvalid(artifact, 'current_run_provenance_mismatch');
});

test('rejects differing ordinary and native current completion times', () => {
  const artifact = clone(validArtifact());
  artifact.nativeEvaluation.currentSample.provenance.endedAt = '2026-07-22T11:00:00.000Z';
  assertSemanticInvalid(artifact, 'current_run_provenance_mismatch');
});

test('rejects cross-evaluation current-run contamination', () => {
  const ordinaryContaminated = clone(validArtifact());
  ordinaryContaminated.evaluation.eligibility.historicalPopulation.excluded[0].provenance.runId =
    ordinaryContaminated.nativeEvaluation.currentSample.provenance.runId;
  assertSemanticInvalid(ordinaryContaminated, 'current_run_in_history');

  const nativeContaminated = clone(validArtifact());
  nativeContaminated.nativeEvaluation.aggregation.orderedSamples[0].provenance.runId =
    nativeContaminated.evaluation.currentSample.provenance.runId;
  assertSemanticInvalid(nativeContaminated, 'current_run_in_history');
});

test('rejects a consumer minimum below three', () => {
  const artifact = clone(validArtifact());
  artifact.policy.metrics.minimumEligibleRuns = 2;
  assertInvalid(artifact, '$.policy.metrics.minimumEligibleRuns');
});

test('rejects unsupported aggregation, warmup, and outlier policies', () => {
  const invalidPolicies: ReadonlyArray<readonly [string, string]> = [
    ['aggregation', 'p95'],
    ['warmup', 'drop-first'],
    ['outliers', 'iqr'],
  ];

  for (const [field, value] of invalidPolicies) {
    const artifact = clone(validArtifact());
    artifact.policy.metrics[field] = value;
    assertInvalid(artifact, `$.policy.metrics.${field}`);
  }
});

test('rejects relative tolerance outside the unit interval', () => {
  const artifact = clone(validArtifact());
  artifact.policy.metrics.metrics[0].tolerance.relative = 1.01;
  assertInvalid(artifact, '$.policy.metrics.metrics[0].tolerance.relative');
});

test('requires exact scenario, lane, cohort, platform, and lineage identity', () => {
  for (const field of ['scenarioId', 'comparisonLane', 'cohortHash', 'platform', 'lineage']) {
    const artifact = clone(validArtifact());
    delete artifact.scope[field];
    assertInvalid(artifact, `$.scope.${field}`);
  }

  const compatibleLineage = clone(validArtifact());
  compatibleLineage.scope.lineage.status = 'declared-compatible';
  assertInvalid(compatibleLineage, '$.scope.lineage.status');
});

test('rejects non-finite historical and current samples', () => {
  for (const [path, mutate] of [
    [
      '$.evaluation.aggregation.orderedSamples[0].metrics[0].value',
      (artifact: JsonRecord) => {
        artifact.evaluation.aggregation.orderedSamples[0].metrics[0].value = Number.NaN;
      },
    ],
    [
      '$.evaluation.currentSample.metrics[0].value',
      (artifact: JsonRecord) => {
        artifact.evaluation.currentSample.metrics[0].value = Number.POSITIVE_INFINITY;
      },
    ],
  ] as const) {
    const artifact = clone(validArtifact());
    mutate(artifact);
    assertInvalid(artifact, path);
  }
});

test('rejects absolute and traversing public provenance paths', () => {
  for (const invalidPath of [
    '/Users/example/asl/runs/metrics.json',
    'C:\\asl\\runs\\metrics.json',
    'runs/../metrics.json',
  ]) {
    const artifact = clone(validArtifact());
    artifact.evaluation.aggregation.orderedSamples[0].provenance.artifact.path = invalidPath;
    assertInvalid(
      artifact,
      '$.evaluation.aggregation.orderedSamples[0].provenance.artifact.path',
    );
  }
});

test('rejects unknown eligibility, aggregation, decision, and exclusion statuses', () => {
  const cases: Array<[string, (artifact: JsonRecord) => void]> = [
    [
      '$.evaluation.eligibility.currentRun.status',
      (artifact) => {
        artifact.evaluation.eligibility.currentRun.status = 'unknown';
      },
    ],
    [
      '$.evaluation.aggregation.status',
      (artifact) => {
        artifact.evaluation.aggregation.status = 'partial';
      },
    ],
    [
      '$.evaluation.decision.status',
      (artifact) => {
        artifact.evaluation.decision.status = 'better';
      },
    ],
    [
      '$.evaluation.eligibility.historicalPopulation.excluded[0].reasons[0]',
      (artifact) => {
        artifact.evaluation.eligibility.historicalPopulation.excluded[0].reasons[0] = 'unknown';
      },
    ],
  ];

  for (const [path, mutate] of cases) {
    const artifact = clone(validArtifact());
    mutate(artifact);
    assertInvalid(artifact, path);
  }
});

test('keeps native policy and native results paired but separate', () => {
  const missingNativeResult = clone(validArtifact());
  delete missingNativeResult.nativeEvaluation;
  assertInvalid(missingNativeResult, '$.nativeEvaluation');

  const missingNativePolicy = clone(validArtifact());
  delete missingNativePolicy.policy.nativeHistory;
  assertInvalid(missingNativePolicy, '$.policy.nativeHistory');
});

test('accepts truthful native-not-ready evidence with no eligible population', () => {
  const artifact = clone(validArtifact());
  setNativeNotReady(artifact);

  const result = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('treats exclusion reasons as an unordered unique set', () => {
  const permuted = clone(validArtifact());
  setNativeNotReady(
    permuted,
    ['native-not-ready', 'partial-evidence'],
    ['partial-evidence', 'native-not-ready'],
  );
  const accepted = validateHistoricalEvaluationArtifact(permuted);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));

  const duplicated = clone(validArtifact());
  setNativeNotReady(
    duplicated,
    ['native-not-ready', 'native-not-ready'],
    ['native-not-ready', 'native-not-ready'],
  );
  assertSemanticInvalid(duplicated, 'duplicate_item');
});

test('rejects unknown properties at every public contract boundary', () => {
  const artifact = clone(validArtifact());
  artifact.evaluation.decision.exitCode = 1;
  assertInvalid(artifact, '$.evaluation.decision.exitCode');
});

test('rejects the current run anywhere in historical eligibility or samples', () => {
  const mutations: Array<(artifact: JsonRecord) => void> = [
    (artifact) => {
      artifact.evaluation.eligibility.historicalPopulation.included.push({
        status: 'eligible',
        provenance: artifact.evaluation.currentSample.provenance,
      });
    },
    (artifact) => {
      artifact.evaluation.eligibility.historicalPopulation.excluded.push({
        status: 'ineligible',
        provenance: artifact.evaluation.currentSample.provenance,
        reasons: ['untrusted-health'],
      });
    },
    (artifact) => {
      artifact.evaluation.aggregation.orderedSamples.push({
        order: 3,
        provenance: artifact.evaluation.currentSample.provenance,
        metrics: artifact.evaluation.currentSample.metrics,
      });
    },
  ];

  for (const mutate of mutations) {
    const artifact = clone(validArtifact());
    mutate(artifact);
    assertSemanticInvalid(artifact, 'current_run_in_history');
  }
});

test('rejects disagreement between included candidates and canonical samples', () => {
  const artifact = clone(validArtifact());
  const included = artifact.evaluation.eligibility.historicalPopulation.included[0];
  included.provenance = {
    ...included.provenance,
    artifact: {
      ...included.provenance.artifact,
      sha256: 'e'.repeat(64),
    },
  };
  assertSemanticInvalid(artifact, 'population_sample_mismatch');
});

test('rejects eligible run and per-metric sample count drift', () => {
  const eligibleCount = clone(validArtifact());
  eligibleCount.evaluation.aggregation.eligibleRunCount = 4;
  assertSemanticInvalid(eligibleCount, 'eligible_run_count_mismatch');

  const sampleCount = clone(validArtifact());
  sampleCount.evaluation.aggregation.metrics[0].sampleCount = 2;
  assertSemanticInvalid(sampleCount, 'sample_count_mismatch');
});

test('rejects computed aggregation below the consumer-declared minimum', () => {
  const artifact = clone(validArtifact());
  artifact.policy.metrics.minimumEligibleRuns = 4;
  assertSemanticInvalid(artifact, 'computed_below_minimum');
});

test('rejects duplicate and non-deterministic sample order values', () => {
  for (const orders of [
    [0, 0, 2],
    [1, 0, 2],
  ]) {
    const artifact = clone(validArtifact());
    artifact.evaluation.aggregation.orderedSamples.forEach(
      (sample: JsonRecord, index: number) => {
        sample.order = orders[index];
      },
    );
    assertSemanticInvalid(artifact, 'invalid_sample_order');
  }
});

test('accepts the arithmetic mean of the two middle values for an even median', () => {
  const artifact = clone(validArtifact());
  const fourth = {
    order: 3,
    provenance: candidate('historical-ready-ms-3', 4),
    metrics: [{ metricId: 'ready-ms', value: 135 }],
  };
  artifact.evaluation.aggregation.orderedSamples.push(fourth);
  artifact.evaluation.eligibility.historicalPopulation.included.push({
    status: 'eligible',
    provenance: fourth.provenance,
  });
  artifact.evaluation.aggregation.eligibleRunCount = 4;
  artifact.evaluation.aggregation.metrics[0].sampleCount = 4;
  artifact.evaluation.aggregation.metrics[0].value = 127.5;
  const decision = artifact.evaluation.decision.metrics[0];
  decision.historicalValue = 127.5;
  decision.delta = decision.currentValue - decision.historicalValue;
  decision.percentChange = (decision.delta / Math.abs(decision.historicalValue)) * 100;

  const result = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('computes mean in declared canonical sample order', () => {
  const artifact = clone(validArtifact());
  artifact.policy.metrics.aggregation = 'mean';
  const orderedValues = [1e16, -1e16, 1];
  artifact.evaluation.aggregation.orderedSamples.forEach(
    (sample: JsonRecord, index: number) => {
      sample.metrics[0].value = orderedValues[index];
    },
  );
  const historicalValue = 1 / 3;
  artifact.evaluation.aggregation.metrics[0].value = historicalValue;
  const decision = artifact.evaluation.decision.metrics[0];
  decision.historicalValue = historicalValue;
  decision.delta = decision.currentValue - historicalValue;
  decision.percentChange = (decision.delta / Math.abs(historicalValue)) * 100;
  decision.status = 'regressed';
  artifact.evaluation.decision.status = 'regressed';

  const result = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('accepts last-ULP derived-value differences but rejects meaningful drift', () => {
  const artifact = clone(validArtifact());
  const aggregation = artifact.evaluation.aggregation.metrics[0];
  const decision = artifact.evaluation.decision.metrics[0];
  aggregation.value = nextUp(aggregation.value);
  decision.historicalValue = nextUp(decision.historicalValue);
  decision.delta = nextUp(decision.delta);
  decision.percentChange = nextUp(decision.percentChange);

  const accepted = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));

  artifact.evaluation.aggregation.metrics[0].value = 126;
  assertSemanticInvalid(artifact, 'aggregation_value_mismatch');
});

test('bounds redundant aggregate encodings to eight adjacent representable values', () => {
  for (const canonicalHistoricalValue of [1, -1, Number.MIN_VALUE]) {
    const artifact = clone(validArtifact());
    artifact.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
      sample.metrics[0].value = canonicalHistoricalValue;
    });
    artifact.evaluation.aggregation.metrics[0].value = advanceUlps(
      canonicalHistoricalValue,
      8,
    );
    artifact.evaluation.currentSample.metrics[0].value = canonicalHistoricalValue;
    artifact.evaluation.decision.metrics[0] = {
      metricId: 'ready-ms',
      status: 'unchanged',
      reason: 'The current value equals the canonical historical value.',
      historicalValue: canonicalHistoricalValue,
      currentValue: canonicalHistoricalValue,
      delta: 0,
      percentChange: 0,
    };
    artifact.evaluation.decision.status = 'unchanged';

    const accepted = validateHistoricalEvaluationArtifact(artifact);
    assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));

    const ninthStep = structuredClone(artifact) as JsonRecord;
    ninthStep.evaluation.aggregation.metrics[0].value = advanceUlps(
      canonicalHistoricalValue,
      9,
    );
    assertSemanticInvalid(ninthStep, 'aggregation_value_mismatch');
  }
});

test('never rewrites zero, subnormal aggregates, or subnormal deltas as each other', () => {
  const subnormalAsZero = clone(validArtifact());
  subnormalAsZero.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
    sample.metrics[0].value = Number.MIN_VALUE;
  });
  subnormalAsZero.evaluation.aggregation.metrics[0].value = 0;
  assertSemanticInvalid(subnormalAsZero, 'aggregation_value_mismatch');

  const zeroAsSubnormal = clone(validArtifact());
  zeroAsSubnormal.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
    sample.metrics[0].value = 0;
  });
  zeroAsSubnormal.evaluation.aggregation.metrics[0].value = Number.MIN_VALUE;
  assertSemanticInvalid(zeroAsSubnormal, 'aggregation_value_mismatch');

  const subnormalDeltaAsZero = clone(validArtifact());
  subnormalDeltaAsZero.policy.metrics.metrics[0].tolerance = { absolute: 0, relative: 0 };
  subnormalDeltaAsZero.evaluation.aggregation.orderedSamples.forEach(
    (sample: JsonRecord) => {
      sample.metrics[0].value = 0;
    },
  );
  subnormalDeltaAsZero.evaluation.aggregation.metrics[0].value = 0;
  subnormalDeltaAsZero.evaluation.currentSample.metrics[0].value = Number.MIN_VALUE;
  subnormalDeltaAsZero.evaluation.decision.metrics[0] = {
    metricId: 'ready-ms',
    status: 'regressed',
    reason: 'The canonical current value is a positive subnormal at zero tolerance.',
    historicalValue: 0,
    currentValue: Number.MIN_VALUE,
    delta: 0,
    percentChange: null,
  };
  subnormalDeltaAsZero.evaluation.decision.status = 'regressed';
  assertSemanticInvalid(subnormalDeltaAsZero, 'delta_mismatch');
});

test('accepts signed zero but rejects opposite-sign nonzero encodings', () => {
  const artifact = clone(validArtifact());
  artifact.policy.metrics.metrics[0].tolerance = { absolute: 0, relative: 0 };
  artifact.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
    sample.metrics[0].value = 0;
  });
  artifact.evaluation.aggregation.metrics[0].value = -0;
  artifact.evaluation.currentSample.metrics[0].value = 0;
  artifact.evaluation.decision.metrics[0] = {
    metricId: 'ready-ms',
    status: 'unchanged',
    reason: 'Signed zero is the same canonical zero value.',
    historicalValue: 0,
    currentValue: -0,
    delta: -0,
    percentChange: null,
  };
  artifact.evaluation.decision.status = 'unchanged';

  const result = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(result.valid, true, JSON.stringify(result.errors));

  const oppositeSign = structuredClone(artifact) as JsonRecord;
  oppositeSign.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
    sample.metrics[0].value = Number.MIN_VALUE;
  });
  oppositeSign.evaluation.aggregation.metrics[0].value = -Number.MIN_VALUE;
  assertSemanticInvalid(oppositeSign, 'aggregation_value_mismatch');
});

test('uses canonical aggregation for zero-tolerance direction despite accepted encoding drift', () => {
  const artifact = clone(validArtifact());
  const canonicalHistoricalValue = 1;
  const reportedHistoricalValue = advanceUlps(canonicalHistoricalValue, 8);
  const currentValue = advanceUlps(canonicalHistoricalValue, 4);
  artifact.policy.metrics.metrics[0].tolerance = { absolute: 0, relative: 0 };
  artifact.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
    sample.metrics[0].value = canonicalHistoricalValue;
  });
  artifact.evaluation.aggregation.metrics[0].value = reportedHistoricalValue;
  artifact.evaluation.currentSample.metrics[0].value = currentValue;
  artifact.evaluation.decision.metrics[0] = {
    metricId: 'ready-ms',
    status: 'regressed',
    reason: 'The canonical current value is higher at zero tolerance.',
    historicalValue: reportedHistoricalValue,
    currentValue,
    delta: currentValue - canonicalHistoricalValue,
    percentChange:
      ((currentValue - canonicalHistoricalValue) / Math.abs(canonicalHistoricalValue)) * 100,
  };
  artifact.evaluation.decision.status = 'regressed';

  const accepted = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors));

  const oppositeDecision = structuredClone(artifact) as JsonRecord;
  oppositeDecision.evaluation.decision.metrics[0] = {
    metricId: 'ready-ms',
    status: 'improved',
    reason: 'The producer incorrectly used its reported aggregate for direction.',
    historicalValue: reportedHistoricalValue,
    currentValue,
    delta: currentValue - reportedHistoricalValue,
    percentChange:
      ((currentValue - reportedHistoricalValue) / Math.abs(reportedHistoricalValue)) * 100,
  };
  oppositeDecision.evaluation.decision.status = 'improved';
  assertSemanticInvalid(oppositeDecision, 'metric_decision_mismatch');
});

test('applies max absolute-relative tolerance before metric direction', () => {
  const artifact = clone(validArtifact());
  artifact.evaluation.currentSample.metrics[0].value = 118;
  const decision = artifact.evaluation.decision.metrics[0];
  decision.currentValue = 118;
  decision.delta = -7;
  decision.percentChange = (-7 / 125) * 100;
  decision.status = 'unchanged';
  artifact.evaluation.decision.status = 'unchanged';

  const result = validateHistoricalEvaluationArtifact(artifact);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('requires null percent change for positive and negative zero history', () => {
  for (const historicalValue of [0, -0]) {
    const artifact = clone(validArtifact());
    artifact.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
      sample.metrics[0].value = historicalValue;
    });
    artifact.evaluation.aggregation.metrics[0].value = historicalValue;
    artifact.evaluation.currentSample.metrics[0].value = 1;
    artifact.evaluation.decision.metrics[0] = {
      metricId: 'ready-ms',
      status: 'unchanged',
      reason: 'The delta remains inside absolute tolerance.',
      historicalValue,
      currentValue: 1,
      delta: 1,
      percentChange: null,
    };
    artifact.evaluation.decision.status = 'unchanged';

    const result = validateHistoricalEvaluationArtifact(artifact);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
});

test('uses every finite nonzero percent denominator without clamping and fails closed on overflow', () => {
  const artifact = clone(validArtifact());
  artifact.evaluation.aggregation.orderedSamples.forEach((sample: JsonRecord) => {
    sample.metrics[0].value = Number.MIN_VALUE;
  });
  artifact.evaluation.aggregation.metrics[0].value = Number.MIN_VALUE;
  artifact.evaluation.currentSample.metrics[0].value = 1;
  artifact.evaluation.decision.metrics[0] = {
    metricId: 'ready-ms',
    status: 'unchanged',
    reason: 'The delta remains inside absolute tolerance.',
    historicalValue: Number.MIN_VALUE,
    currentValue: 1,
    delta: 1,
    percentChange: Number.MAX_VALUE,
  };
  artifact.evaluation.decision.status = 'unchanged';

  assertSemanticInvalid(artifact, 'percent_change_mismatch');
});

test('rejects aggregation, delta, percent-change, and directional decision drift', () => {
  const cases: Array<[string, (artifact: JsonRecord) => void]> = [
    [
      'aggregation_value_mismatch',
      (artifact) => {
        artifact.evaluation.aggregation.metrics[0].value = 126;
      },
    ],
    [
      'delta_mismatch',
      (artifact) => {
        artifact.evaluation.decision.metrics[0].delta = -1;
      },
    ],
    [
      'percent_change_mismatch',
      (artifact) => {
        artifact.evaluation.decision.metrics[0].percentChange = null;
      },
    ],
    [
      'metric_decision_mismatch',
      (artifact) => {
        artifact.evaluation.decision.metrics[0].status = 'regressed';
        artifact.evaluation.decision.status = 'regressed';
      },
    ],
  ];

  for (const [code, mutate] of cases) {
    const artifact = clone(validArtifact());
    mutate(artifact);
    assertSemanticInvalid(artifact, code);
  }
});

test('requires directional operands and forbids operands on no-decision metrics', () => {
  const missingOperand = clone(validArtifact());
  delete missingOperand.evaluation.decision.metrics[0].percentChange;
  assertInvalid(missingOperand, '$.evaluation.decision.metrics[0]');

  const noDecisionOperands = clone(validArtifact());
  noDecisionOperands.evaluation.decision.metrics[0].status = 'insufficient-evidence';
  noDecisionOperands.evaluation.decision.status = 'insufficient-evidence';
  assertInvalid(noDecisionOperands, '$.evaluation.decision.metrics[0]');
});

test('enforces aggregate decision reduction and no-decision blocking', () => {
  const wrongDirectionalAggregate = clone(validArtifact());
  wrongDirectionalAggregate.evaluation.decision.status = 'mixed';
  assertSemanticInvalid(wrongDirectionalAggregate, 'aggregate_decision_mismatch');

  const blockedAggregate = clone(validArtifact());
  blockedAggregate.evaluation.decision.metrics[0] = {
    metricId: 'ready-ms',
    status: 'insufficient-evidence',
    reason: 'Required evidence is missing.',
  };
  blockedAggregate.evaluation.decision.status = 'improved';
  assertSemanticInvalid(blockedAggregate, 'aggregate_decision_mismatch');
});
