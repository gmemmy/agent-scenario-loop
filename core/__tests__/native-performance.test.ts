const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAndroidNativePerformanceEvidence,
  buildIosNativePerformanceEvidence,
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

test('preserves Android provider-owned native diagnostic source statuses', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    diagnosticSources: [
      {
        sourceId: 'gfxinfo',
        status: 'timeout',
        path: 'raw/providers/native/gfxinfo-timeout.txt',
        reason: 'The provider could not collect gfxinfo before its bounded timeout.',
        nextAction: 'Retry gfxinfo after stabilizing the target app or mark Android frame evidence unavailable.',
      },
      {
        sourceId: 'perfetto',
        status: 'not-requested',
        reason: 'Perfetto was intentionally skipped for this lightweight diagnostic pass.',
      },
      {
        sourceId: 'custom',
        status: 'available-unproven',
        tool: {
          name: 'project-local-render-probe',
          command: 'render-probe --summary',
        },
        dataClasses: ['render'],
        reason: 'The project-local render probe exists, but this run did not bind its output to the target app.',
      },
    ],
    providerId: 'native-provider',
    runId: 'run-android-source-status',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.deepEqual(
    evidence.diagnosticSources
      .filter((source: { sourceId: string }) => ['custom', 'gfxinfo', 'perfetto'].includes(source.sourceId))
      .map((source: { dataClasses?: string[]; path?: string; sourceId: string; status: string; tool?: { command?: string; name?: string } }) => ({
        dataClasses: source.dataClasses,
        path: source.path,
        sourceId: source.sourceId,
        status: source.status,
        tool: source.tool,
      })),
    [
      {
        dataClasses: ['frames', 'jank', 'render'],
        path: 'raw/providers/native/gfxinfo-timeout.txt',
        sourceId: 'gfxinfo',
        status: 'timeout',
        tool: {
          name: 'adb dumpsys gfxinfo',
        },
      },
      {
        dataClasses: ['frames', 'jank', 'cpu', 'thread-scheduling', 'native-trace'],
        path: undefined,
        sourceId: 'perfetto',
        status: 'not-requested',
        tool: {
          name: 'perfetto',
        },
      },
      {
        dataClasses: ['render'],
        path: undefined,
        sourceId: 'custom',
        status: 'available-unproven',
        tool: {
          command: 'render-probe --summary',
          name: 'project-local-render-probe',
        },
      },
    ],
  );
});

test('preserves Android provider-owned claim sufficiency and target ambiguity', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    appId: 'com.example.app',
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'android-native-frame-budget',
      reason: 'Frame and memory diagnostics survived, but accessibility and comparable trace evidence were unavailable.',
      nextAction: 'Rerun with the required accessibility and trace outputs before product comparison.',
      missingEvidence: ['accessibility snapshot', 'comparable trace window'],
      supportingEvidence: ['gfxinfo summary', 'meminfo summary'],
    },
    comparability: {
      status: 'captured-not-comparable',
      reason: 'Capture was collected after the active loop and cannot be compared to product budgets.',
      policy: 'Use as diagnostic evidence only.',
    },
    deviceId: 'emulator-5554',
    gfxinfoText: `
      Total frames rendered: 100
      Janky frames: 10 (10.00%)
    `,
    meminfoText: `
      TOTAL PSS: 250000 KB
    `,
    providerId: 'native-provider',
    runId: 'run-android-claim-override',
    scenarioId: 'feed-scroll',
    targetBinding: {
      status: 'ambiguous',
      reason: 'Two app runtimes were visible during capture.',
      source: 'provider',
      candidateTargets: [
        {
          appId: 'com.example.app',
          bindingStatus: 'expected',
          deviceId: 'emulator-5554',
          platform: 'android',
          source: 'runner',
        },
        {
          appId: 'com.example.app.debug',
          bindingStatus: 'observed',
          deviceId: 'emulator-5554',
          platform: 'android',
          reason: 'Provider observed the debug runtime in the native trace metadata.',
        },
      ],
    },
  });

  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.claimSufficiency.claim, 'android-native-frame-budget');
  assert.deepEqual(evidence.claimSufficiency.missingEvidence, ['accessibility snapshot', 'comparable trace window']);
  assert.deepEqual(evidence.claimSufficiency.supportingEvidence, ['gfxinfo summary', 'meminfo summary']);
  assert.equal(evidence.comparability.status, 'captured-not-comparable');
  assert.equal(evidence.targetBinding.status, 'ambiguous');
  assert.equal(evidence.targetBinding.candidateTargets.length, 2);
});

test('rejects Android comparison sufficiency without comparable complete verified evidence', () => {
  assert.throws(
    () =>
      buildAndroidNativePerformanceEvidence({
        claimSufficiency: {
          status: 'sufficient-for-comparison',
          claim: 'android-native-frame-budget',
          reason: 'Provider attempted to mark the evidence comparable.',
        },
        gfxinfoText: `
          Total frames rendered: 100
          Janky frames: 1 (1.00%)
        `,
        providerId: 'native-provider',
        runId: 'run-android-overclaim',
        scenarioId: 'feed-scroll',
      }),
    /Native performance evidence artifact failed schema validation/,
  );
});

test('accepts Android comparison sufficiency when completeness, comparability, and target binding are verified', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    appId: 'com.example.app',
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      claim: 'android-native-frame-budget',
      reason: 'Provider captured a complete comparable trace against the verified target.',
      supportingEvidence: ['complete trace-processor summary'],
    },
    comparability: {
      status: 'comparable',
      reason: 'The provider used the release-gated baseline capture policy.',
      policy: 'release-native-baseline-v1',
    },
    completenessStatus: 'complete',
    deviceId: 'emulator-5554',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    traceProcessorSummary: {
      durationMs: 12000,
      frameCount: 100,
      jankyFrameCount: 1,
      p95FrameMs: 18,
      traceId: 'trace-1',
    },
  });

  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-comparison');
  assert.equal(evidence.comparability.status, 'comparable');
  assert.equal(evidence.completenessStatus, 'complete');
  assert.equal(evidence.targetBinding.status, 'verified');
});

test('builds diagnostic-only iOS native-performance evidence from provider summaries', () => {
  const evidence = buildIosNativePerformanceEvidence({
    attachments: [
      {
        kind: 'xctrace-summary',
        path: 'raw/providers/native/xctrace-summary.json',
      },
      {
        kind: 'metrickit-summary',
        path: 'raw/providers/native/metrickit-summary.json',
      },
    ],
    bundleId: 'com.example.app',
    capturedAt: '2026-06-23T00:00:00.000Z',
    deviceId: 'SIM-123',
    metricKitSummary: {
      batteryImpact: 2,
      hitchCount: 4,
      jankyFrameCount: 8,
      p95FrameMs: 32,
      physicalFootprintBytes: 90000000,
      thermalState: 'nominal',
    },
    providerId: 'native-provider',
    runId: 'run-ios',
    scenarioId: 'feed-scroll',
    xctraceSummary: {
      cpuMs: 455.25,
      durationMs: 12000,
      mainThreadCpuMs: 300.5,
      memoryPeakBytes: 120000000,
      threadSchedulingDelayMs: 14,
      traceId: 'ios-feed-trace',
      windowEndMs: 12000,
      windowStartMs: 0,
    },
  });

  assert.equal(evidence.schemaVersion, '1.0.0');
  assert.equal(evidence.platform, 'ios');
  assert.equal(evidence.evidenceKind, 'mixed');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.deepEqual(evidence.dataClasses, ['frames', 'jank', 'render', 'memory', 'cpu', 'thread-scheduling', 'thermal', 'battery', 'native-trace']);
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.targetBinding.status, 'verified');
  assert.equal(evidence.tool.command, 'xctrace / MetricKit');
  assert.deepEqual(
    evidence.diagnosticSources.map((source: { path?: string; sourceId: string; status: string }) => ({
      path: source.path,
      sourceId: source.sourceId,
      status: source.status,
    })),
    [
      {
        path: undefined,
        sourceId: 'instruments',
        status: 'unverified',
      },
      {
        path: 'raw/providers/native/xctrace-summary.json',
        sourceId: 'xctrace',
        status: 'captured',
      },
      {
        path: 'raw/providers/native/metrickit-summary.json',
        sourceId: 'metrickit',
        status: 'captured',
      },
      {
        path: undefined,
        sourceId: 'simctl',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'native-trace',
        status: 'unverified',
      },
    ],
  );
  assert.deepEqual(evidence.frames, {
    hitchCount: 4,
    jankyFrameCount: 8,
    p95FrameMs: 32,
  });
  assert.deepEqual(evidence.memory, {
    memoryPeakBytes: 120000000,
    physicalFootprintBytes: 90000000,
  });
  assert.deepEqual(evidence.metrics, {
    batteryImpact: 2,
    cpuMs: 455.25,
    mainThreadCpuMs: 300.5,
    thermalState: 'nominal',
    threadSchedulingDelayMs: 14,
  });
  assert.deepEqual(evidence.traces, [
    {
      durationMs: 12000,
      traceId: 'ios-feed-trace',
      windowEndMs: 12000,
      windowStartMs: 0,
    },
  ]);
});

test('builds iOS native-performance evidence from a raw native trace attachment', () => {
  const evidence = buildIosNativePerformanceEvidence({
    attachments: [
      {
        kind: 'raw-native-trace',
        path: 'raw/providers/native/feed.trace',
      },
    ],
    providerId: 'native-provider',
    runId: 'run-ios-trace',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.evidenceKind, 'native-trace');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.deepEqual(evidence.dataClasses, ['native-trace']);
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.deepEqual(
    evidence.diagnosticSources.map((source: { path?: string; sourceId: string; status: string }) => ({
      path: source.path,
      sourceId: source.sourceId,
      status: source.status,
    })),
    [
      {
        path: undefined,
        sourceId: 'instruments',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'xctrace',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'metrickit',
        status: 'unverified',
      },
      {
        path: undefined,
        sourceId: 'simctl',
        status: 'unverified',
      },
      {
        path: 'raw/providers/native/feed.trace',
        sourceId: 'native-trace',
        status: 'captured',
      },
    ],
  );
  assert.equal(evidence.tool.command, 'ios native diagnostics');
  assert.equal('frames' in evidence, false);
  assert.equal('memory' in evidence, false);
});

test('keeps iOS native-performance evidence untrusted when summaries are missing', () => {
  const evidence = buildIosNativePerformanceEvidence({
    providerId: 'native-provider',
    runId: 'run-ios-empty',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.evidenceKind, 'unknown');
  assert.equal(evidence.completenessStatus, 'unknown');
  assert.deepEqual(evidence.dataClasses, ['unknown']);
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.tool.command, 'ios native diagnostics');
  assert.equal('frames' in evidence, false);
  assert.equal('memory' in evidence, false);
});

test('preserves iOS provider-owned native diagnostic source statuses', () => {
  const evidence = buildIosNativePerformanceEvidence({
    diagnosticSources: [
      {
        sourceId: 'instruments',
        status: 'unsupported',
        reason: 'The selected host cannot run Instruments in this environment.',
        nextAction: 'Use xctrace export or move this proof to a host with Instruments support.',
      },
      {
        sourceId: 'xctrace',
        status: 'failed',
        path: 'raw/providers/native/xctrace-error.txt',
        reason: 'xctrace failed before writing an export.',
      },
      {
        sourceId: 'native-trace',
        status: 'not-requested',
        reason: 'Raw native trace capture was intentionally skipped for this pass.',
      },
    ],
    providerId: 'native-provider',
    runId: 'run-ios-source-status',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.deepEqual(
    evidence.diagnosticSources
      .filter((source: { sourceId: string }) => ['instruments', 'native-trace', 'xctrace'].includes(source.sourceId))
      .map((source: { path?: string; reason?: string; sourceId: string; status: string }) => ({
        path: source.path,
        reason: source.reason,
        sourceId: source.sourceId,
        status: source.status,
      })),
    [
      {
        path: undefined,
        reason: 'The selected host cannot run Instruments in this environment.',
        sourceId: 'instruments',
        status: 'unsupported',
      },
      {
        path: 'raw/providers/native/xctrace-error.txt',
        reason: 'xctrace failed before writing an export.',
        sourceId: 'xctrace',
        status: 'failed',
      },
      {
        path: undefined,
        reason: 'Raw native trace capture was intentionally skipped for this pass.',
        sourceId: 'native-trace',
        status: 'not-requested',
      },
    ],
  );
});

test('preserves iOS provider-owned claim sufficiency and mismatch binding', () => {
  const evidence = buildIosNativePerformanceEvidence({
    appId: 'com.example.ios.dev',
    bundleId: 'com.example.ios.dev',
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'ios-native-hitch-budget',
      reason: 'xctrace metrics survived, but target binding observed a different bundle.',
      nextAction: 'Rerun after binding the provider to the selected simulator and app bundle.',
      missingEvidence: ['verified target binding'],
      supportingEvidence: ['xctrace summary'],
    },
    comparability: {
      status: 'low-confidence',
      reason: 'The trace was captured while another runtime was connected.',
      policy: 'diagnostic-only',
    },
    deviceId: 'SIM-123',
    providerId: 'native-provider',
    runId: 'run-ios-claim-override',
    scenarioId: 'feed-scroll',
    targetBinding: {
      status: 'mismatch',
      reason: 'Provider metadata named a different bundle than the selected scenario target.',
      source: 'provider',
      candidateTargets: [
        {
          appId: 'com.example.ios.dev',
          bindingStatus: 'expected',
          deviceId: 'SIM-123',
          platform: 'ios',
          source: 'runner',
        },
        {
          appId: 'com.example.ios.other',
          bindingStatus: 'observed',
          deviceId: 'SIM-123',
          platform: 'ios',
          reason: 'Observed in provider trace metadata.',
        },
      ],
    },
    xctraceSummary: {
      durationMs: 12000,
      p95FrameMs: 28,
      traceId: 'ios-trace-1',
    },
  });

  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.deepEqual(evidence.claimSufficiency.missingEvidence, ['verified target binding']);
  assert.deepEqual(evidence.claimSufficiency.supportingEvidence, ['xctrace summary']);
  assert.equal(evidence.comparability.status, 'low-confidence');
  assert.equal(evidence.targetBinding.status, 'mismatch');
  assert.equal(evidence.targetBinding.candidateTargets.length, 2);
});
