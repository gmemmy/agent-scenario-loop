const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAndroidNativePerformanceEvidence,
  parseAndroidGfxinfoSummary,
  parseAndroidMeminfoSummary,
} = require('../native-performance');

test('parses Android gfxinfo headline summary fields', () => {
  const summary = parseAndroidGfxinfoSummary(`
    Total frames rendered: 21570
    Janky frames: 9470 (43.90%)
    p50: 38ms
    p90: 85ms
    p95: 113ms
    p99: 250ms
    Number Missed Vsync: 22
    Slow UI thread: 4136
    Slow bitmap uploads: 2193
    Slow issue draw commands: 9150
    Frame deadline missed: 9470
  `);

  assert.deepEqual(summary, {
    frameDeadlineMissed: 9470,
    janky: 9470,
    jankyPercent: 43.9,
    missedVsync: 22,
    p50Ms: 38,
    p90Ms: 85,
    p95Ms: 113,
    p99Ms: 250,
    slowBitmapUploads: 2193,
    slowIssueDrawCommands: 9150,
    slowUiThread: 4136,
    total: 21570,
  });
});

test('parses Android meminfo headline summary fields', () => {
  const summary = parseAndroidMeminfoSummary(`
    TOTAL PSS: 1300515 KB
    Native Heap PSS: 918226 KB
    Native Heap Alloc: 934398 KB
    Views: 6882
    Activities: 6
    WebViews: 12
  `);

  assert.deepEqual(summary, {
    activities: 6,
    nativeHeapAllocKb: 934398,
    nativeHeapPssKb: 918226,
    totalPssKb: 1300515,
    views: 6882,
    webViews: 12,
  });
});

test('builds diagnostic-only Android native-performance evidence from platform summaries', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    appId: 'com.example.app',
    attachments: [
      {
        kind: 'raw-gfxinfo',
        path: 'raw/providers/native/gfxinfo.txt',
        sizeBytes: 1234,
      },
      {
        kind: 'raw-meminfo',
        path: 'raw/providers/native/meminfo.txt',
      },
    ],
    capturedAt: '2026-06-23T00:00:00.000Z',
    deviceId: 'emulator-5554',
    gfxinfoText: `
      Total frames rendered: 100
      Janky frames: 12 (12.00%)
      95th percentile: 44ms
    `,
    meminfoText: `
      TOTAL PSS: 250000 KB
      Native Heap PSS: 90000 KB
      Views: 1200
    `,
    providerId: 'native-provider',
    runId: 'run-1',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.schemaVersion, '1.0.0');
  assert.equal(evidence.platform, 'android');
  assert.equal(evidence.evidenceKind, 'mixed');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.deepEqual(evidence.dataClasses, ['frames', 'jank', 'render', 'memory']);
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.targetBinding.status, 'verified');
  assert.deepEqual(
    evidence.diagnosticSources.map((source: { path?: string; sourceId: string; status: string }) => ({
      path: source.path,
      sourceId: source.sourceId,
      status: source.status,
    })),
    [
      {
        path: 'raw/providers/native/gfxinfo.txt',
        sourceId: 'gfxinfo',
        status: 'captured',
      },
      {
        path: undefined,
        sourceId: 'framestats',
        status: 'unverified',
      },
      {
        path: 'raw/providers/native/meminfo.txt',
        sourceId: 'meminfo',
        status: 'captured',
      },
      {
        path: undefined,
        sourceId: 'perfetto',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'trace-processor',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'logcat-render',
        status: 'unverified',
      },
    ],
  );
  assert.equal(evidence.tool.command, 'dumpsys gfxinfo / dumpsys meminfo');
  assert.deepEqual(evidence.frames, {
    janky: 12,
    jankyPercent: 12,
    p95Ms: 44,
    total: 100,
  });
  assert.deepEqual(evidence.memory, {
    nativeHeapPssKb: 90000,
    totalPssKb: 250000,
    views: 1200,
  });
  assert.deepEqual(evidence.attachments, [
    {
      kind: 'raw-gfxinfo',
      path: 'raw/providers/native/gfxinfo.txt',
      sizeBytes: 1234,
    },
    {
      kind: 'raw-meminfo',
      path: 'raw/providers/native/meminfo.txt',
    },
  ]);
});

test('builds Android native-performance evidence from trace-processor summaries', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    appId: 'com.example.app',
    attachments: [
      {
        kind: 'raw-perfetto',
        path: 'raw/providers/native/feed-scroll.perfetto-trace',
      },
      {
        kind: 'trace-processor-summary',
        path: 'raw/providers/native/trace-processor-summary.json',
      },
    ],
    capturedAt: '2026-06-23T00:00:00.000Z',
    deviceId: 'emulator-5554',
    providerId: 'native-provider',
    runId: 'run-trace',
    scenarioId: 'feed-scroll',
    traceProcessorSummary: {
      cpuMs: 321.5,
      durationMs: 20000,
      frameCount: 7574,
      jankyFrameCount: 805,
      mainThreadCpuMs: 201.25,
      missedDeadlineFrameCount: 119,
      p95FrameMs: 113,
      renderThreadCpuMs: 88.75,
      threadSchedulingDelayMs: 42,
      traceId: 'feed-scroll-trace',
      windowEndMs: 20000,
      windowStartMs: 0,
      worstFrameMs: 587.6,
    },
  });

  assert.equal(evidence.evidenceKind, 'trace-processor');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.deepEqual(evidence.dataClasses, ['frames', 'jank', 'render', 'cpu', 'thread-scheduling', 'native-trace']);
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.deepEqual(
    evidence.diagnosticSources.map((source: { path?: string; sourceId: string; status: string }) => ({
      path: source.path,
      sourceId: source.sourceId,
      status: source.status,
    })),
    [
      {
        path: undefined,
        sourceId: 'gfxinfo',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'framestats',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'meminfo',
        status: 'unverified',
      },
      {
        path: 'raw/providers/native/feed-scroll.perfetto-trace',
        sourceId: 'perfetto',
        status: 'captured',
      },
      {
        path: 'raw/providers/native/trace-processor-summary.json',
        sourceId: 'trace-processor',
        status: 'captured',
      },
      {
        path: undefined,
        sourceId: 'logcat-render',
        status: 'unverified',
      },
    ],
  );
  assert.equal(evidence.tool.command, 'trace_processor_shell');
  assert.deepEqual(evidence.frames, {
    jankyFrameCount: 805,
    missedDeadlineFrameCount: 119,
    p95FrameMs: 113,
    totalFrameCount: 7574,
    worstFrameMs: 587.6,
  });
  assert.deepEqual(evidence.metrics, {
    cpuMs: 321.5,
    mainThreadCpuMs: 201.25,
    renderThreadCpuMs: 88.75,
    threadSchedulingDelayMs: 42,
  });
  assert.deepEqual(evidence.traces, [
    {
      durationMs: 20000,
      traceId: 'feed-scroll-trace',
      windowEndMs: 20000,
      windowStartMs: 0,
    },
  ]);
});

test('keeps Android native-performance evidence untrusted when summaries are missing', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    gfxinfoText: 'no frame summary here',
    meminfoText: 'no memory summary here',
    providerId: 'native-provider',
    runId: 'run-2',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.evidenceKind, 'unknown');
  assert.equal(evidence.completenessStatus, 'unknown');
  assert.deepEqual(evidence.dataClasses, ['unknown']);
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.deepEqual(
    evidence.diagnosticSources.map((source: { sourceId: string; status: string }) => ({
      sourceId: source.sourceId,
      status: source.status,
    })),
    [
      {
        sourceId: 'gfxinfo',
        status: 'unverified',
      },
      {
        sourceId: 'framestats',
        status: 'unverified',
      },
      {
        sourceId: 'meminfo',
        status: 'unverified',
      },
      {
        sourceId: 'perfetto',
        status: 'unverified',
      },
      {
        sourceId: 'trace-processor',
        status: 'unverified',
      },
      {
        sourceId: 'logcat-render',
        status: 'unverified',
      },
    ],
  );
  assert.equal('frames' in evidence, false);
  assert.equal('memory' in evidence, false);
  assert.equal(evidence.tool.command, 'android native diagnostics');
});
