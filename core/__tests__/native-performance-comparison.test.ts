const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { compareRunDirectories } = require('../comparison');
const { compareNativePerformanceEvidencePair } = require('../native-performance-comparison');
const { SCHEMAS, validateJson } = require('../schema-validator');

type TestContext = import('node:test').TestContext;
type JsonRecord = Record<string, any>;

function buildComparisonMetric({
  budget = { operator: 'at-most', threshold: 20 },
  sample = 'p95FrameMs',
}: {
  budget?: { operator: 'at-most' | 'at-least'; threshold: number } | null;
  sample?: string;
} = {}) {
  return {
    aggregation: 'p95',
    ...(budget ? { budget } : {}),
    direction: 'lower-is-better',
    id: 'frame-p95',
    sample,
    surface: 'frames',
    tolerance: {
      absolute: 1,
      relative: 0.05,
    },
    unit: 'ms',
  };
}

function buildComparisonPolicy({
  buildMode = 'release',
  durationMs = 12000,
  environment = [
    { name: 'device-class', value: 'emulator' },
    { name: 'thermal-state', value: 'nominal' },
  ],
  policyId = 'release-native-baseline-v1',
  providerVersion = '1.2.3',
  targetFamily = 'android-mobile-app',
}: {
  buildMode?: string;
  durationMs?: number;
  environment?: Array<{ name: string; value: string }>;
  policyId?: string;
  providerVersion?: string;
  targetFamily?: string;
} = {}) {
  return {
    environment,
    policyId,
    providerVersion,
    target: {
      buildMode,
      family: targetFamily,
    },
    window: {
      definitionId: 'startup-window',
      durationMs,
      kind: 'bounded-duration',
      phase: 'activeLoop',
    },
  };
}

function buildNativeEvidence({
  captureMode = 'session',
  claimStatus = 'sufficient-for-comparison',
  comparabilityStatus = 'comparable',
  comparisonMetrics = [buildComparisonMetric()],
  comparisonPolicy = buildComparisonPolicy(),
  completenessStatus = 'complete',
  diagnosticSourceId = 'trace-processor',
  frames = {
    jankyFrameCount: 2,
    p50FrameMs: 12,
    p90FrameMs: 16,
    p95FrameMs: 18,
    p99FrameMs: 24,
    totalFrameCount: 120,
    worstFrameMs: 32,
  },
  platform = 'android',
  providerId = 'native-provider',
  runId = 'run-1',
  scenarioId = 'app-startup',
  schemaVersion = '1.1.0',
  tool = {
    name: 'native-trace-provider',
    version: '1.2.3',
  },
}: {
  captureMode?: string;
  claimStatus?: 'insufficient-for-claim' | 'sufficient-for-comparison' | 'sufficient-for-diagnosis';
  comparabilityStatus?: 'captured-not-comparable' | 'comparable' | 'diagnostic-only';
  comparisonMetrics?: Array<Record<string, unknown>>;
  comparisonPolicy?: Record<string, unknown>;
  completenessStatus?: string;
  diagnosticSourceId?: string;
  frames?: Record<string, unknown>;
  platform?: 'android' | 'ios';
  providerId?: string;
  runId?: string;
  scenarioId?: string;
  schemaVersion?: string;
  tool?: { name: string; version?: string };
} = {}): JsonRecord {
  const deviceId = platform === 'android' ? 'emulator-5554' : 'SIM-123';
  const targetPath = `raw/providers/${providerId}/target.json`;
  const sourcePath = `raw/providers/${providerId}/source.json`;

  return {
    schemaVersion,
    providerId,
    platform,
    runId,
    scenarioId,
    tool,
    capturedAt: '2026-07-15T10:00:00.000Z',
    captureMode,
    clockDomain: 'host',
    evidenceKind: 'trace-processor',
    dataClasses: ['frames', 'jank'],
    completenessStatus,
    comparability: {
      status: comparabilityStatus,
      policy: 'release-native-baseline-v1',
      reason: 'Provider captured a bounded same-condition native metric window.',
    },
    claimSufficiency: {
      status: claimStatus,
      claim: `${platform}-native-performance`,
      reason: 'Provider captured comparable native metrics.',
      supportingEvidence: ['bounded native summary'],
    },
    ...(comparisonPolicy ? { comparisonPolicy } : {}),
    ...(comparisonMetrics ? { comparisonMetrics } : {}),
    diagnosticSources: [
      {
        dataClasses: ['frames', 'jank'],
        path: sourcePath,
        sourceId: diagnosticSourceId,
        status: 'captured',
      },
    ],
    frames,
    lifecycle: {
      durationMs: 12000,
      endedAt: '2026-07-15T10:00:12.000Z',
      perturbsTiming: false,
      phase: 'activeLoop',
      startedAt: '2026-07-15T10:00:00.000Z',
    },
    targetBinding: {
      status: 'verified',
      appId: 'dev.agent-scenario-loop.example',
      deviceId,
      source: 'provider-session-status',
      candidateTargets: [
        {
          appId: 'dev.agent-scenario-loop.example',
          bindingStatus: 'observed',
          deviceId,
          evidencePath: targetPath,
          platform,
          source: 'provider-session-status',
        },
      ],
    },
    traces: [
      {
        durationMs: 12000,
        traceId: `${runId}-trace`,
        windowEndMs: 12000,
        windowStartMs: 0,
      },
    ],
  };
}

async function writeRun({
  comparisonLane = 'android-native-release',
  cohortHash = 'cohort-a',
  endedAt = '2026-07-15T10:00:12.000Z',
  healthStatus = 'passed',
  nativeEvidence,
  root,
  runId,
  scenarioHash = 'scenario-hash-a',
  verdictActual = 900,
  verdictStatus = verdictActual <= 1000 ? 'passed' : 'failed',
}: {
  comparisonLane?: string;
  cohortHash?: string;
  endedAt?: string;
  healthStatus?: string;
  nativeEvidence?: JsonRecord;
  root: string;
  runId: string;
  scenarioHash?: string;
  verdictActual?: number;
  verdictStatus?: string;
}): Promise<string> {
  const runDir = path.join(root, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(
    path.join(runDir, 'health.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'app-startup',
      flowId: 'app-startup',
      runId,
      healthStatus,
      checks: [{ name: 'truth_events_complete', source: 'truth', status: healthStatus }],
    })}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(runDir, 'verdict.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'app-startup',
      flowId: 'app-startup',
      runId,
      healthStatus,
      verdictStatus,
      budgetChecks: [
        {
          name: 'startup p95',
          source: 'milestone',
          metric: 'p95',
          unit: 'ms',
          expected: 1000,
          actual: verdictActual,
          pass: verdictActual <= 1000,
        },
      ],
    })}\n`,
    'utf8',
  );

  const manifest: JsonRecord = {
    schemaVersion: '1.0.0',
    runId,
    scenario: 'app-startup',
    scenarioHash,
    platform: 'android',
    interactionDriver: 'adb-logcat',
    comparisonLane,
    provenance: {
      cohortHash,
    },
    startedAt: '2026-07-15T10:00:00.000Z',
    endedAt,
    durationMs: 12000,
    artifacts: {
      raw: {},
      evidenceAttachments: [],
    },
  };

  if (nativeEvidence) {
    const providerId = nativeEvidence.providerId;
    const attachmentPath = `raw/providers/${providerId}/native-performance.json`;
    manifest.artifacts.evidenceAttachments.push({
      kind: 'nativePerformance',
      path: attachmentPath,
    });
    const sourcePath = nativeEvidence.diagnosticSources?.[0]?.path;
    const targetPath = nativeEvidence.targetBinding?.candidateTargets?.[0]?.evidencePath;
    await fsp.mkdir(path.join(runDir, 'raw', 'providers', providerId), { recursive: true });
    await fsp.writeFile(path.join(runDir, attachmentPath), `${JSON.stringify(nativeEvidence)}\n`, 'utf8');
    if (typeof sourcePath === 'string') {
      await fsp.mkdir(path.dirname(path.join(runDir, sourcePath)), { recursive: true });
      await fsp.writeFile(path.join(runDir, sourcePath), '{"status":"captured"}\n', 'utf8');
    }
    if (typeof targetPath === 'string') {
      await fsp.mkdir(path.dirname(path.join(runDir, targetPath)), { recursive: true });
      await fsp.writeFile(
        path.join(runDir, targetPath),
        `${JSON.stringify({
          appId: 'dev.agent-scenario-loop.example',
          deviceId: 'emulator-5554',
          platform: 'android',
        })}\n`,
        'utf8',
      );
    }
  }

  await fsp.writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  return runDir;
}

test('compares trusted native-performance evidence and emits deterministic metric deltas', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 3,
        p50FrameMs: 13,
        p90FrameMs: 17,
        p95FrameMs: 20,
        p99FrameMs: 26,
        totalFrameCount: 120,
        worstFrameMs: 34,
      },
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 2,
        p50FrameMs: 11,
        p90FrameMs: 14,
        p95FrameMs: 18,
        p99FrameMs: 22,
        totalFrameCount: 120,
        worstFrameMs: 28,
      },
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'improved');
  assert.equal(result.policyId, 'release-native-baseline-v1');
  assert.deepEqual(result.explanations, []);
  assert.deepEqual(result.metrics, [
    {
      aggregation: 'p95',
      baseline: 20,
      budget: {
        operator: 'at-most',
        result: 'passed',
        threshold: 20,
      },
      current: 18,
      delta: -2,
      direction: 'lower-is-better',
      id: 'frame-p95',
      percentChange: -10,
      sample: 'p95FrameMs',
      status: 'improved',
      surface: 'frames',
      unit: 'ms',
    },
  ]);
});

test('reports trusted native-performance regressions and configured budget failures', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 1,
        p50FrameMs: 10,
        p90FrameMs: 14,
        p95FrameMs: 18,
        p99FrameMs: 21,
        totalFrameCount: 120,
        worstFrameMs: 26,
      },
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 4,
        p50FrameMs: 15,
        p90FrameMs: 21,
        p95FrameMs: 28,
        p99FrameMs: 34,
        totalFrameCount: 120,
        worstFrameMs: 40,
      },
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'regressed');
  assert.equal(result.metrics[0].status, 'regressed');
  assert.equal(result.metrics[0].budget.result, 'failed');
  assert.equal(result.metrics[0].delta, 10);
});

test('fails closed on tool and bounded-window mismatches', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      comparisonPolicy: buildComparisonPolicy({
        durationMs: 8000,
      }),
      runId: 'current-run',
      tool: {
        name: 'native-trace-provider',
        version: '2.0.0',
      },
    }),
  });

  assert.equal(result.status, 'not-comparable');
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'tool.version'));
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'comparisonPolicy.window.durationMs'));
});

test('fails closed on empty declared environment conditions', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      comparisonPolicy: buildComparisonPolicy({
        environment: [],
      }),
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      comparisonPolicy: buildComparisonPolicy({
        environment: [],
      }),
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'not-comparable');
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'comparisonPolicy.environment'));
});

test('fails closed on target-contract mismatch', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      comparisonPolicy: buildComparisonPolicy({
        buildMode: 'debug',
        targetFamily: 'android-dev-client',
      }),
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'not-comparable');
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'comparisonPolicy.target.buildMode'));
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'comparisonPolicy.target.family'));
});

test('fails closed on provider and policy mismatches even when current looks faster', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 3,
        p50FrameMs: 13,
        p90FrameMs: 18,
        p95FrameMs: 22,
        p99FrameMs: 28,
        totalFrameCount: 120,
        worstFrameMs: 34,
      },
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      comparisonPolicy: buildComparisonPolicy({
        policyId: 'release-native-baseline-v2',
        providerVersion: '2.0.0',
      }),
      frames: {
        jankyFrameCount: 1,
        p50FrameMs: 10,
        p90FrameMs: 13,
        p95FrameMs: 16,
        p99FrameMs: 20,
        totalFrameCount: 120,
        worstFrameMs: 26,
      },
      providerId: 'other-native-provider',
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'not-comparable');
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'providerId'));
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'comparisonPolicy.policyId'));
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'comparisonPolicy.providerVersion'));
});

test('rejects invalid native-performance samples and frame invariants', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 12,
        p50FrameMs: 30,
        p90FrameMs: 24,
        p95FrameMs: 20,
        p99FrameMs: 18,
        totalFrameCount: 10,
        worstFrameMs: 32,
      },
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'not-comparable');
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'frames.jankyFrameCount'));
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'frames.percentiles'));
  assert.deepEqual(result.metrics, []);
});

test('rejects non-finite native-performance samples as not comparable', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 2,
        p50FrameMs: 12,
        p90FrameMs: 16,
        p95FrameMs: Number.NaN,
        p99FrameMs: 24,
        totalFrameCount: 120,
        worstFrameMs: 31,
      },
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'not-comparable');
  assert.equal(result.metrics[0].status, 'not-comparable');
  assert.ok(result.explanations.some((entry: JsonRecord) => entry.field === 'p95FrameMs'));
});

test('reports native metrics without a configured budget separately from comparison status', () => {
  const result = compareNativePerformanceEvidencePair({
    baselineEvidence: buildNativeEvidence({
      comparisonMetrics: [buildComparisonMetric({ budget: null })],
      runId: 'baseline-run',
    }),
    currentEvidence: buildNativeEvidence({
      comparisonMetrics: [buildComparisonMetric({ budget: null })],
      frames: {
        jankyFrameCount: 2,
        p50FrameMs: 12,
        p90FrameMs: 15,
        p95FrameMs: 18,
        p99FrameMs: 23,
        totalFrameCount: 120,
        worstFrameMs: 29,
      },
      runId: 'current-run',
    }),
  });

  assert.equal(result.status, 'unchanged');
  assert.equal(result.metrics[0].budget.result, 'not-configured');
  assert.equal(result.metrics[0].status, 'unchanged');
});

test('marks native comparison not comparable when baseline evidence is missing from trusted runs', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-missing-baseline-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    root,
    runId: 'baseline-run',
  });
  const currentDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      runId: 'current-run',
    }),
    root,
    runId: 'current-run',
  });

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => entry.phase === 'baseline' && entry.code === 'missing-evidence',
    ),
  );
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('keeps native-performance not comparable when current run fails health gate despite faster metrics', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-health-gate-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 4,
        p50FrameMs: 16,
        p90FrameMs: 20,
        p95FrameMs: 24,
        p99FrameMs: 30,
        totalFrameCount: 120,
        worstFrameMs: 36,
      },
      runId: 'baseline-run',
    }),
    root,
    runId: 'baseline-run',
  });
  const currentDir = await writeRun({
    healthStatus: 'failed',
    nativeEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 1,
        p50FrameMs: 11,
        p90FrameMs: 14,
        p95FrameMs: 17,
        p99FrameMs: 22,
        totalFrameCount: 120,
        worstFrameMs: 29,
      },
      runId: 'current-run',
    }),
    root,
    runId: 'current-run',
  });

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.healthStatus, 'failed');
  assert.equal(comparison.comparisonStatus, 'inconclusive');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => entry.phase === 'current' && entry.field === 'trusted',
    ),
  );
});

test('keeps diagnostic-only native evidence out of comparison truth and enforces trusted run compatibility', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-diagnostic-only-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const diagnosticOnlyEvidence = buildNativeEvidence({
    claimStatus: 'sufficient-for-diagnosis',
    comparabilityStatus: 'diagnostic-only',
    runId: 'baseline-run',
    schemaVersion: '1.0.0',
  });
  delete diagnosticOnlyEvidence.comparisonMetrics;
  delete diagnosticOnlyEvidence.comparisonPolicy;
  const baselineDir = await writeRun({
    nativeEvidence: diagnosticOnlyEvidence,
    root,
    runId: 'baseline-run',
  });
  const currentDir = await writeRun({
    cohortHash: 'cohort-b',
    nativeEvidence: {
      ...diagnosticOnlyEvidence,
      runId: 'current-run',
    },
    root,
    runId: 'current-run',
  });

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => entry.field === 'comparability' && entry.phase === 'baseline',
    ),
  );
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => entry.field === 'cohortHash' && entry.phase === 'pair',
    ),
  );
});

test('marks native evidence not comparable when measurable samples are missing', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-missing-samples-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    root,
    runId: 'baseline-run',
  });
  const noSamplesEvidence = buildNativeEvidence({
    frames: {},
    runId: 'current-run',
  });
  const currentDir = await writeRun({
    nativeEvidence: noSamplesEvidence,
    root,
    runId: 'current-run',
  });

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => entry.phase === 'current' && entry.field === 'frames',
    ),
  );
});

test('rejects a faster-looking inadmissible candidate without creating a native improvement claim', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-inadmissible-faster-candidate-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      frames: {
        jankyFrameCount: 3,
        p50FrameMs: 14,
        p90FrameMs: 18,
        p95FrameMs: 22,
        p99FrameMs: 26,
        totalFrameCount: 120,
        worstFrameMs: 33,
      },
      runId: 'baseline-run',
    }),
    root,
    runId: 'baseline-run',
    verdictActual: 920,
  });
  const currentDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      claimStatus: 'sufficient-for-diagnosis',
      comparabilityStatus: 'diagnostic-only',
      completenessStatus: 'partial',
      frames: {
        jankyFrameCount: 1,
        p50FrameMs: 8,
        p90FrameMs: 10,
        p95FrameMs: 12,
        p99FrameMs: 15,
        totalFrameCount: 120,
        worstFrameMs: 19,
      },
      runId: 'current-run',
    }),
    root,
    runId: 'current-run',
    verdictActual: 760,
  });

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.comparisonStatus, 'better');
  assert.ok(Array.isArray(comparison.metricComparisons));
  assert.ok(comparison.metricComparisons.some((metric: JsonRecord) => metric.status === 'better'));

  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) =>
        entry.phase === 'current' &&
        entry.field === 'claimSufficiency' &&
        entry.code === 'untrusted-evidence',
    ),
  );
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) =>
        entry.phase === 'current' &&
        entry.field === 'comparability' &&
        entry.code === 'policy-mismatch',
    ),
  );
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) =>
        entry.phase === 'current' &&
        entry.field === 'completenessStatus' &&
        entry.code === 'untrusted-evidence',
    ),
  );
  assert.ok(
    comparison.nativePerformance.metrics.every((metric: JsonRecord) => metric.status !== 'improved'),
  );
  assert.doesNotMatch(comparison.summary, /Native performance improved/u);
  assert.match(comparison.summary, /Native performance was not comparable/u);
  assert.equal(validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact').valid, true);
});

test('compareRunDirectories rejects native-performance attachment symlink escapes', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-attachment-symlink-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    root,
    runId: 'baseline-run',
  });
  const currentEvidence = buildNativeEvidence({
    frames: {
      jankyFrameCount: 4,
      p50FrameMs: 15,
      p90FrameMs: 21,
      p95FrameMs: 30,
      p99FrameMs: 34,
      totalFrameCount: 120,
      worstFrameMs: 40,
    },
    runId: 'current-run',
  });
  const currentDir = await writeRun({
    nativeEvidence: currentEvidence,
    root,
    runId: 'current-run',
  });
  const externalEvidenceDir = path.join(root, 'external-attachment');
  await fsp.mkdir(externalEvidenceDir, { recursive: true });
  const externalEvidencePath = path.join(externalEvidenceDir, 'native-performance.json');
  await fsp.writeFile(externalEvidencePath, `${JSON.stringify(currentEvidence)}\n`, 'utf8');
  const runEvidencePath = path.join(currentDir, 'raw', 'providers', 'native-provider', 'native-performance.json');
  await fsp.rm(runEvidencePath, { force: true });
  await fsp.symlink(externalEvidencePath, runEvidencePath);

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => /regular file inside the run directory|real run directory/u.test(String(entry.reason)),
    ),
  );
});

test('compareRunDirectories rejects native-performance supporting-path symlink escapes', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-supporting-symlink-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    root,
    runId: 'baseline-run',
  });
  const currentEvidence = buildNativeEvidence({
    frames: {
      jankyFrameCount: 4,
      p50FrameMs: 15,
      p90FrameMs: 21,
      p95FrameMs: 30,
      p99FrameMs: 34,
      totalFrameCount: 120,
      worstFrameMs: 40,
    },
    runId: 'current-run',
  });
  const currentDir = await writeRun({
    nativeEvidence: currentEvidence,
    root,
    runId: 'current-run',
  });
  const externalEvidenceDir = path.join(root, 'external-supporting');
  await fsp.mkdir(externalEvidenceDir, { recursive: true });
  const externalSourcePath = path.join(externalEvidenceDir, 'source.json');
  const externalTargetPath = path.join(externalEvidenceDir, 'target.json');
  await fsp.writeFile(externalSourcePath, '{"status":"captured"}\n', 'utf8');
  await fsp.writeFile(
    externalTargetPath,
    `${JSON.stringify({
      appId: 'dev.agent-scenario-loop.example',
      deviceId: 'emulator-5554',
      platform: 'android',
    })}\n`,
    'utf8',
  );
  const runSourcePath = path.join(currentDir, 'raw', 'providers', 'native-provider', 'source.json');
  const runTargetPath = path.join(currentDir, 'raw', 'providers', 'native-provider', 'target.json');
  await fsp.rm(runSourcePath, { force: true });
  await fsp.rm(runTargetPath, { force: true });
  await fsp.symlink(externalSourcePath, runSourcePath);
  await fsp.symlink(externalTargetPath, runTargetPath);

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => /durable captured source|observed target binding/u.test(String(entry.reason)),
    ),
  );
});

test('compareRunDirectories rejects native-performance ancestor-directory symlink escapes', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-comparison-ancestor-symlink-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const baselineDir = await writeRun({
    nativeEvidence: buildNativeEvidence({
      runId: 'baseline-run',
    }),
    root,
    runId: 'baseline-run',
  });
  const currentEvidence = buildNativeEvidence({
    frames: {
      jankyFrameCount: 4,
      p50FrameMs: 15,
      p90FrameMs: 21,
      p95FrameMs: 30,
      p99FrameMs: 34,
      totalFrameCount: 120,
      worstFrameMs: 40,
    },
    runId: 'current-run',
  });
  currentEvidence.diagnosticSources[0].path = 'raw/providers/native-provider/supporting/source.json';
  currentEvidence.targetBinding.candidateTargets[0].evidencePath =
    'raw/providers/native-provider/supporting/target.json';
  const currentDir = await writeRun({
    nativeEvidence: currentEvidence,
    root,
    runId: 'current-run',
  });
  const externalSupportingDir = path.join(root, 'external-supporting-dir');
  await fsp.mkdir(externalSupportingDir, { recursive: true });
  await fsp.writeFile(path.join(externalSupportingDir, 'source.json'), '{"status":"captured"}\n', 'utf8');
  await fsp.writeFile(
    path.join(externalSupportingDir, 'target.json'),
    `${JSON.stringify({
      appId: 'dev.agent-scenario-loop.example',
      deviceId: 'emulator-5554',
      platform: 'android',
    })}\n`,
    'utf8',
  );
  const runSupportingDir = path.join(currentDir, 'raw', 'providers', 'native-provider', 'supporting');
  await fsp.rm(runSupportingDir, { recursive: true, force: true });
  await fsp.symlink(externalSupportingDir, runSupportingDir, 'dir');

  const comparison = compareRunDirectories({
    baselineDir,
    currentDir,
  });

  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: JsonRecord) => /durable captured source|observed target binding/u.test(String(entry.reason)),
    ),
  );
});
