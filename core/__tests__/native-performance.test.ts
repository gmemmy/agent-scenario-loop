const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAndroidNativePerformanceEvidence,
  buildIosNativePerformanceEvidence,
  classifyNativePerformanceComparisonReadiness,
  parseAndroidFramestatsSummary,
  parseAndroidGfxinfoSummary,
  parseAndroidMeminfoSummary,
  parseIosMetricKitSummaryText,
  parseIosXctraceSummaryText,
} = require('../native-performance');

const EMPTY_STDOUT_SHA256 = 'a'.repeat(64);
const EMPTY_STDERR_SHA256 = 'b'.repeat(64);
const CAPTURE_OUTPUT_SHA256 = 'd'.repeat(64);
const TARGET_OUTPUT_SHA256 = 'c'.repeat(64);
const RUNNER_ACTIVE_LOOP_WINDOW_PATH = 'raw/runner-active-loop-window.json';

function comparisonContext({
  appId,
  artifactPath,
  evidenceHashes = {},
  evidenceRecords = {},
  platform,
  providerId,
  runId,
  scenarioId,
  sourcePaths = [],
  targetId,
  targetBindingRecord,
  targetPath,
}: {
  appId?: string;
  artifactPath: string;
  evidenceHashes?: Record<string, string>;
  evidenceRecords?: Record<string, unknown>;
  platform: 'android' | 'ios';
  providerId: string;
  runId: string;
  scenarioId: string;
  sourcePaths?: string[];
  targetId?: string;
  targetBindingRecord?: Record<string, unknown>;
  targetPath: string;
}) {
  const requestedAppId = appId ?? 'com.example.app';
  const requestedTargetId = targetId ?? (platform === 'android' ? 'emulator-5554' : 'SIM-123');
  const targetBindingFixture = targetBindingRecord === undefined
    ? buildObservedTargetBindingFixture({
        platform,
        providerId,
        requestedAppId,
        requestedTargetId,
        runId,
        scenarioId,
        targetPath,
      })
    : null;
  const durablePaths = new Set([
    artifactPath,
    targetPath,
    ...sourcePaths,
    ...(targetBindingFixture?.durablePaths ?? []),
  ]);
  const records = new Map<string, unknown>(Object.entries(evidenceRecords));
  const hashes = new Map<string, string>(Object.entries(evidenceHashes));
  records.set(
    targetPath,
    targetBindingRecord ?? targetBindingFixture?.record,
  );
  for (const [runRelativePath, record] of Object.entries(targetBindingFixture?.records ?? {})) {
    if (!records.has(runRelativePath)) {
      records.set(runRelativePath, record);
    }
  }
  for (const [runRelativePath, sha256] of Object.entries(targetBindingFixture?.hashes ?? {})) {
    if (!hashes.has(runRelativePath) && typeof sha256 === 'string') {
      hashes.set(runRelativePath, sha256);
    }
  }
  return {
    artifactPath,
    evidencePathExists: (runRelativePath: string) => durablePaths.has(runRelativePath),
    expectedPlatform: platform,
    expectedProviderId: providerId,
    expectedRunId: runId,
    expectedScenarioId: scenarioId,
    readEvidenceJson: (runRelativePath: string) => {
      if (!records.has(runRelativePath)) {
        throw new Error(`Missing test evidence JSON for ${runRelativePath}`);
      }

      return JSON.parse(JSON.stringify(records.get(runRelativePath)));
    },
    readEvidenceSha256: (runRelativePath: string) => hashes.get(runRelativePath) ?? null,
  };
}

function buildObservedTargetBindingFixture({
  captureArtifactPath,
  platform,
  providerId,
  requestedAppId,
  requestedTargetId,
  runId,
  scenarioId,
  targetPath,
}: {
  captureArtifactPath?: string;
  platform: 'android' | 'ios';
  providerId: string;
  requestedAppId: string;
  requestedTargetId: string;
  runId: string;
  scenarioId: string;
  targetPath: string;
}) {
  const activeCapturePath = captureArtifactPath ?? `raw/providers/${providerId}/active-window-capture.json`;
  const commandDefinitions = [
    {
      args: ['start-window', '--target-binding', targetPath],
      commandId: 'start-native-window',
      endedAt: '2026-07-13T12:00:00.050Z',
      outputs: [],
      phase: 'startWindow',
      sourceId: 'start-window',
      startedAt: '2026-07-13T12:00:00.000Z',
    },
    {
      args: ['stop-window', '--target-binding', targetPath],
      commandId: 'stop-native-window',
      endedAt: '2026-07-13T12:00:12.050Z',
      outputs: [
        {
          channel: 'logs',
          kind: 'logs',
          path: '{providerDir}/active-window-capture.json',
          required: false,
          runRelativePath: activeCapturePath,
          sha256: CAPTURE_OUTPUT_SHA256,
          stale: false,
          status: 'captured',
        },
      ],
      phase: 'stopWindow',
      sourceId: 'stop-window',
      startedAt: '2026-07-13T12:00:12.000Z',
    },
    {
      args: ['normalize', '--target-binding', targetPath],
      commandId: 'capture-native-performance',
      endedAt: '2026-07-13T12:00:12.200Z',
      outputs: [],
      outputPath: targetPath,
      outputSha256: TARGET_OUTPUT_SHA256,
      phase: 'afterCapture',
      sourceId: 'capture-native-performance',
      startedAt: '2026-07-13T12:00:12.100Z',
    },
  ];
  const sourceCommands = commandDefinitions.map((definition) => {
    const commandRecordId = `${providerId}-${definition.commandId}`;
    return {
      args: definition.args,
      command: 'capture-native-performance',
      commandId: definition.commandId,
      ...(definition.outputPath ? { outputPath: definition.outputPath } : {}),
      phase: definition.phase,
      recordPath: `raw/provider-commands/${commandRecordId}.json`,
      startedRecordPath: `raw/provider-commands/${commandRecordId}.started.json`,
      sourceId: definition.sourceId,
      status: 'completed',
      stderrPath: `raw/provider-commands/${commandRecordId}.stderr.txt`,
      stderrSha256: EMPTY_STDERR_SHA256,
      stdoutPath: `raw/provider-commands/${commandRecordId}.stdout.txt`,
      stdoutSha256: EMPTY_STDOUT_SHA256,
    };
  });
  const record = {
    observedProcessName: platform === 'android' ? requestedAppId : 'ExampleApp',
    observedProcessPid: 4242,
    observedTargetId: requestedTargetId,
    platform,
    providerId,
    requestedAppId,
    requestedTargetId,
    runId,
    scenarioId,
    schemaVersion: '1.0.0',
    captureArtifacts: [
      {
        commandId: 'stop-native-window',
        path: activeCapturePath,
      },
    ],
    sourceCommands,
    status: 'verified',
    window: {
      durationMs: 11950,
      endedAt: '2026-07-13T12:00:12.000Z',
      phase: 'activeLoop',
      startedAt: '2026-07-13T12:00:00.050Z',
    },
  } as Record<string, unknown>;
  const runnerWindowRecord = {
    durationMs: 11950,
    endedAt: '2026-07-13T12:00:12.000Z',
    phase: 'activeLoop',
    platform,
    runnerId: platform === 'android' ? 'android-adb-profile-runner' : 'ios-simctl-profile-runner',
    schemaVersion: '1.0.0',
    startedAt: '2026-07-13T12:00:00.050Z',
  };

  if (platform === 'android') {
    record.observedAppId = requestedAppId;
  } else {
    record.observedTargetPlatform = 'iOS Simulator';
    record.observedTemplate = 'Animation Hitches';
  }

  const recordEntries: Array<[string, unknown]> = sourceCommands.flatMap((sourceCommand, index) => {
    const definition = commandDefinitions[index];
    if (!definition) {
      return [];
    }
    return [
      [sourceCommand.recordPath, {
        args: definition.args,
        command: 'capture-native-performance',
        endedAt: definition.endedAt,
        ...(definition.outputPath ? { outputPath: definition.outputPath } : {}),
        ...(definition.outputSha256 ? { outputSha256: definition.outputSha256 } : {}),
        outputs: definition.outputs.map((output) => ({
          channel: output.channel,
          kind: output.kind,
          path: output.path,
          required: output.required,
          runRelativePath: output.runRelativePath,
          sha256: output.sha256,
          stale: output.stale,
          status: output.status,
        })),
        phase: definition.phase,
        providerId,
        startedAt: definition.startedAt,
        startedRecordPath: sourceCommand.startedRecordPath,
        status: 'completed',
        stderrPath: sourceCommand.stderrPath,
        stderrSha256: EMPTY_STDERR_SHA256,
        stdoutPath: sourceCommand.stdoutPath,
        stdoutSha256: EMPTY_STDOUT_SHA256,
      }],
      [sourceCommand.startedRecordPath, {
        args: definition.args,
        command: 'capture-native-performance',
        outputs: definition.outputs.map((output) => ({
          channel: output.channel,
          kind: output.kind,
          path: output.path,
          required: output.required,
          runRelativePath: output.runRelativePath,
        })),
        phase: definition.phase,
        providerId,
        startedAt: definition.startedAt,
        startedRecordPath: sourceCommand.startedRecordPath,
        status: 'started',
        stderrPath: sourceCommand.stderrPath,
        stdoutPath: sourceCommand.stdoutPath,
      }],
    ];
  });
  recordEntries.push([RUNNER_ACTIVE_LOOP_WINDOW_PATH, runnerWindowRecord]);

  return {
    durablePaths: [
      activeCapturePath,
      targetPath,
      RUNNER_ACTIVE_LOOP_WINDOW_PATH,
      ...sourceCommands.flatMap((sourceCommand) => [
        sourceCommand.recordPath,
        sourceCommand.startedRecordPath,
        sourceCommand.stdoutPath,
        sourceCommand.stderrPath,
      ]),
    ],
    hashes: Object.fromEntries([
      [targetPath, TARGET_OUTPUT_SHA256],
      [activeCapturePath, CAPTURE_OUTPUT_SHA256],
      ...sourceCommands.flatMap((sourceCommand) => [
        [sourceCommand.stdoutPath, sourceCommand.stdoutSha256],
        [sourceCommand.stderrPath, sourceCommand.stderrSha256],
      ]),
    ]),
    record,
    records: Object.fromEntries(recordEntries),
  };
}

function buildObservedTargetBindingRecord(options: {
  platform: 'android' | 'ios';
  providerId: string;
  requestedAppId: string;
  requestedTargetId: string;
  runId: string;
  scenarioId: string;
  targetPath: string;
}) {
  return buildObservedTargetBindingFixture(options).record;
}

function buildComparisonContract({
  buildMode = 'release',
  durationMs = 12000,
  environment = [
    {
      name: 'device-class',
      value: 'emulator',
    },
    {
      name: 'thermal-state',
      value: 'nominal',
    },
  ],
  policyId = 'release-native-baseline-v1',
  providerVersion = '1.2.3',
  targetFamily,
}: {
  buildMode?: string;
  durationMs?: number;
  environment?: Array<{ name: string; value: string }>;
  policyId?: string;
  providerVersion?: string;
  targetFamily: string;
}) {
  return {
    comparisonMetrics: [
      {
        aggregation: 'p95',
        budget: {
          operator: 'at-most',
          threshold: 20,
        },
        direction: 'lower-is-better',
        id: 'frame-p95',
        sample: 'p95FrameMs',
        surface: 'frames',
        tolerance: {
          absolute: 1,
          relative: 0.05,
        },
        unit: 'ms',
      },
    ],
    comparisonPolicy: {
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
    },
  };
}

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

test('parses Android framestats frame timing rows', () => {
  const summary = parseAndroidFramestatsSummary(`
    ---PROFILEDATA---
    Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted
    0,1000000000,1000000000,0,0,0,0,0,0,0,0,0,0,1010000000,0,0,0
    0,2000000000,2000000000,0,0,0,0,0,0,0,0,0,0,2020000000,0,0,0
    0,3000000000,3000000000,0,0,0,0,0,0,0,0,0,0,3035000000,0,0,0
    1,4000000000,4000000000,0,0,0,0,0,0,0,0,0,0,4005000000,0,0,0
  `);

  assert.deepEqual(summary, {
    flaggedFrameCount: 1,
    frameCount: 4,
    jankyFrameCount: 3,
    missedDeadlineFrameCount: 2,
    p50FrameMs: 10,
    p90FrameMs: 35,
    p95FrameMs: 35,
    p99FrameMs: 35,
    worstFrameMs: 35,
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

test('parses iOS xctrace-style summary fields', () => {
  const summary = parseIosXctraceSummaryText(`
    traceId: feed-scroll-trace
    duration: 12.5s
    window start: 250ms
    window end: 12750ms
    cpu time: 455.25ms
    main thread cpu: 300.5ms
    thread scheduling delay: 14ms
    frames: 720
    janky frames: 8
    hitches: 4
    average frame: 16.7ms
    p95 frame: 32ms
    worst frame: 91ms
    resident size: 95 MB
    physical footprint: 110 MB
    peak memory: 128 MB
  `);

  assert.deepEqual(summary, {
    averageFrameMs: 16.7,
    cpuMs: 455.25,
    durationMs: 12500,
    frameCount: 720,
    hitchCount: 4,
    jankyFrameCount: 8,
    mainThreadCpuMs: 300.5,
    memoryPeakBytes: 134217728,
    p95FrameMs: 32,
    physicalFootprintBytes: 115343360,
    residentSizeBytes: 99614720,
    threadSchedulingDelayMs: 14,
    traceId: 'feed-scroll-trace',
    windowEndMs: 12750,
    windowStartMs: 250,
    worstFrameMs: 91,
  });
});

test('parses iOS MetricKit-style summary fields', () => {
  const summary = parseIosMetricKitSummaryText(`
    scroll hitches: 3
    dropped frames: 17
    95th percentile frame: 42ms
    average frame time: 18ms
    cpu time: 1.25s
    peak memory: 146 MB
    physical footprint: 120 MB
    thermal state: nominal
    battery impact: 2.5
  `);

  assert.deepEqual(summary, {
    averageFrameMs: 18,
    batteryImpact: 2.5,
    cpuMs: 1250,
    hitchCount: 3,
    jankyFrameCount: 17,
    memoryPeakBytes: 153092096,
    p95FrameMs: 42,
    physicalFootprintBytes: 125829120,
    thermalState: 'nominal',
  });
});

test('builds iOS native-performance evidence from parsed text summaries', () => {
  const evidence = buildIosNativePerformanceEvidence({
    attachments: [
      {
        kind: 'xctrace-summary',
        path: 'raw/providers/native/xctrace-summary.txt',
      },
      {
        kind: 'metrickit-summary',
        path: 'raw/providers/native/metrickit-summary.txt',
      },
    ],
    bundleId: 'com.example.app',
    deviceId: 'SIM-123',
    metricKitSummary: parseIosMetricKitSummaryText(`
      hitches: 2
      p95 frame: 36ms
      physical footprint: 96 MB
      thermal state: nominal
    `),
    providerId: 'native-provider',
    runId: 'run-ios-text',
    scenarioId: 'feed-scroll',
    xctraceSummary: parseIosXctraceSummaryText(`
      traceId: run-ios-text-trace
      duration: 10s
      cpu time: 375ms
      main thread cpu: 240ms
      thread scheduling delay: 9ms
      frames: 600
    `),
  });

  assert.equal(evidence.evidenceKind, 'mixed');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.frames.totalFrameCount, 600);
  assert.equal(evidence.frames.hitchCount, 2);
  assert.equal(evidence.frames.p95FrameMs, 36);
  assert.equal(evidence.metrics.cpuMs, 375);
  assert.equal(evidence.metrics.thermalState, 'nominal');
  assert.equal(evidence.memory.physicalFootprintBytes, 100663296);
  assert.deepEqual(evidence.traces, [
    {
      durationMs: 10000,
      traceId: 'run-ios-text-trace',
    },
  ]);
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

  assert.equal(evidence.schemaVersion, '1.1.0');
  assert.equal(evidence.platform, 'android');
  assert.equal(evidence.evidenceKind, 'mixed');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.deepEqual(evidence.dataClasses, ['frames', 'jank', 'render', 'memory']);
  assert.equal(evidence.comparability.status, 'diagnostic-only');
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

test('builds Android native-performance evidence from framestats rows', () => {
  const evidence = buildAndroidNativePerformanceEvidence({
    attachments: [
      {
        kind: 'raw-framestats',
        path: 'raw/providers/native/framestats.txt',
      },
    ],
    framestatsText: `
      Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted
      0,1000000000,1000000000,0,0,0,0,0,0,0,0,0,0,1011000000,0,0,0
      0,2000000000,2000000000,0,0,0,0,0,0,0,0,0,0,2024000000,0,0,0
    `,
    providerId: 'native-provider',
    runId: 'run-android-framestats',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.evidenceKind, 'framestats');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.tool.command, 'dumpsys gfxinfo framestats');
  assert.deepEqual(evidence.frames, {
    flaggedFrameCount: 0,
    frameCount: 2,
    jankyFrameCount: 1,
    missedDeadlineFrameCount: 1,
    p50FrameMs: 11,
    p90FrameMs: 24,
    p95FrameMs: 24,
    p99FrameMs: 24,
    worstFrameMs: 24,
  });
  assert.deepEqual(
    evidence.diagnosticSources
      .filter((source: { sourceId: string; status: string }) => ['framestats', 'gfxinfo'].includes(source.sourceId))
      .map((source: { path?: string; sourceId: string; status: string }) => ({
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
        path: 'raw/providers/native/framestats.txt',
        sourceId: 'framestats',
        status: 'captured',
      },
    ],
  );
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

test('classifies Android evidence as comparison-ready only with captured source, bounded window, and observed target proof', () => {
  const artifactPath = 'raw/providers/native-provider/native-performance.json';
  const capturePath = 'raw/providers/native-provider/active-window-capture.json';
  const sourcePath = 'raw/providers/native-provider/trace-processor-summary.json';
  const targetPath = 'raw/providers/native-provider/android-target.json';
  const evidence = buildAndroidNativePerformanceEvidence({
    appId: 'com.example.app',
    attachments: [
      {
        kind: 'native-trace',
        path: capturePath,
      },
    ],
    capturedAt: '2026-07-13T12:00:12.000Z',
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
    ...buildComparisonContract({
      targetFamily: 'android-mobile-app',
    }),
    completenessStatus: 'complete',
    diagnosticSources: [
      {
        sourceId: 'trace-processor',
        status: 'captured',
        path: sourcePath,
      },
    ],
    deviceId: 'emulator-5554',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    targetBinding: {
      status: 'verified',
      source: 'provider-session-status',
      candidateTargets: [
        {
          appId: 'com.example.app',
          bindingStatus: 'observed',
          deviceId: 'emulator-5554',
          evidencePath: targetPath,
          platform: 'android',
          source: 'provider-session-status',
        },
      ],
    },
    traceProcessorSummary: {
      durationMs: 12000,
      frameCount: 100,
      jankyFrameCount: 1,
      p95FrameMs: 18,
      traceId: 'trace-1',
      windowEndMs: 12000,
      windowStartMs: 0,
    },
  });

  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-comparison');
  assert.equal(evidence.comparability.status, 'comparable');
  assert.equal(evidence.completenessStatus, 'complete');
  assert.equal(evidence.targetBinding.status, 'verified');
  assert.equal(evidence.targetBinding.reason, undefined);
  const context = comparisonContext({
    artifactPath,
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [sourcePath],
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, context), {
    missingEvidence: [],
    status: 'comparison-ready',
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, {
    ...context,
    readEvidenceJson: undefined,
    readEvidenceSha256: undefined,
  }), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const mismatchedPlatformEvidence = {
    ...evidence,
    targetBinding: {
      ...evidence.targetBinding,
      candidateTargets: evidence.targetBinding.candidateTargets.map((candidate: Record<string, unknown>) => ({
        ...candidate,
        platform: 'ios',
      })),
    },
  };
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(mismatchedPlatformEvidence, context), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const mismatchedAppEvidence = {
    ...evidence,
    targetBinding: {
      ...evidence.targetBinding,
      candidateTargets: evidence.targetBinding.candidateTargets.map((candidate: Record<string, unknown>) => ({
        ...candidate,
        appId: 'com.example.other',
      })),
    },
  };
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(mismatchedAppEvidence, context), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const conflictingTargetEvidence = {
    ...evidence,
    targetBinding: {
      ...evidence.targetBinding,
      candidateTargets: [
        ...evidence.targetBinding.candidateTargets,
        {
          appId: 'com.example.other',
          bindingStatus: 'conflicting',
          deviceId: 'emulator-9999',
          evidencePath: targetPath,
          platform: 'android',
          source: 'provider-session-status',
        },
      ],
    },
  };
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(conflictingTargetEvidence, context), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const durableSourcePath = 'raw/providers/native-provider/gfxinfo-summary.json';
  const durableTargetBindingFixture = buildObservedTargetBindingFixture({
    platform: 'android',
    providerId: 'native-provider',
    requestedAppId: 'com.example.app',
    requestedTargetId: 'emulator-5554',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    targetPath,
  });
  const durableSourceEvidence = {
    ...evidence,
    diagnosticSources: evidence.diagnosticSources.map((source: Record<string, unknown>) => ({
      ...source,
      ...(source.status === 'captured' ? { path: durableSourcePath } : {}),
    })),
  };
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(durableSourceEvidence, {
    ...context,
    evidencePathExists: (runRelativePath: string) => (
      runRelativePath === durableSourcePath || durableTargetBindingFixture.durablePaths.includes(runRelativePath)
    ),
  }), {
    missingEvidence: ['captured-source'],
    status: 'diagnostic-only',
  });

  const pathlessCapturedSourceEvidence = {
    ...evidence,
    diagnosticSources: evidence.diagnosticSources.map((source: Record<string, unknown>) => ({
      ...source,
      ...(source.status === 'captured' ? { path: undefined } : {}),
    })),
  };
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(pathlessCapturedSourceEvidence, context), {
    missingEvidence: ['captured-source'],
    status: 'diagnostic-only',
  });

  const afterCaptureOnlyTargetBindingFixture = buildObservedTargetBindingFixture({
    platform: 'android',
    providerId: 'native-provider',
    requestedAppId: 'com.example.app',
    requestedTargetId: 'emulator-5554',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    targetPath,
  });
  const afterCaptureOnlyContext = comparisonContext({
    artifactPath,
    evidenceHashes: afterCaptureOnlyTargetBindingFixture.hashes,
    evidenceRecords: Object.fromEntries(Object.entries(afterCaptureOnlyTargetBindingFixture.records).filter(([runRelativePath]) => (
      runRelativePath.includes('capture-native-performance')
    ))),
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [
      sourcePath,
      ...afterCaptureOnlyTargetBindingFixture.durablePaths.filter((runRelativePath) => (
        runRelativePath === targetPath || runRelativePath.includes('capture-native-performance')
      )),
    ],
    targetBindingRecord: {
      ...afterCaptureOnlyTargetBindingFixture.record,
      sourceCommands: (afterCaptureOnlyTargetBindingFixture.record.sourceCommands as Record<string, unknown>[]).filter((sourceCommand) => (
        sourceCommand.phase === 'afterCapture'
      )),
    },
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, afterCaptureOnlyContext), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const incompleteTargetBindingContext = comparisonContext({
    artifactPath,
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [sourcePath],
    targetBindingRecord: {
      ...buildObservedTargetBindingRecord({
        platform: 'android',
        providerId: 'native-provider',
        requestedAppId: 'com.example.app',
        requestedTargetId: 'emulator-5554',
        runId: 'run-android-comparable',
        scenarioId: 'feed-scroll',
        targetPath,
      }),
      sourceCommands: [],
    },
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, incompleteTargetBindingContext), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const inconsistentWindowTargetBindingFixture = buildObservedTargetBindingFixture({
    platform: 'android',
    providerId: 'native-provider',
    requestedAppId: 'com.example.app',
    requestedTargetId: 'emulator-5554',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    targetPath,
  });
  const inconsistentWindowContext = comparisonContext({
    artifactPath,
    evidenceHashes: inconsistentWindowTargetBindingFixture.hashes,
    evidenceRecords: inconsistentWindowTargetBindingFixture.records,
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [sourcePath, ...inconsistentWindowTargetBindingFixture.durablePaths],
    targetBindingRecord: {
      ...inconsistentWindowTargetBindingFixture.record,
      window: {
        durationMs: 12000,
        endedAt: '2026-07-13T12:00:12.000Z',
        phase: 'activeLoop',
        startedAt: '2026-07-13T11:59:59.000Z',
      },
    },
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, inconsistentWindowContext), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const providerOnlyWindowContext = comparisonContext({
    artifactPath,
    evidenceHashes: inconsistentWindowTargetBindingFixture.hashes,
    evidenceRecords: inconsistentWindowTargetBindingFixture.records,
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [sourcePath, ...inconsistentWindowTargetBindingFixture.durablePaths],
    targetBindingRecord: {
      ...inconsistentWindowTargetBindingFixture.record,
      window: {
        durationMs: 10000,
        endedAt: '2026-07-13T12:00:11.000Z',
        phase: 'activeLoop',
        startedAt: '2026-07-13T12:00:01.000Z',
      },
    },
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, providerOnlyWindowContext), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const missingCommandRecordContext = comparisonContext({
    artifactPath,
    evidenceRecords: {},
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [sourcePath],
    targetBindingRecord: buildObservedTargetBindingRecord({
      platform: 'android',
      providerId: 'native-provider',
      requestedAppId: 'com.example.app',
      requestedTargetId: 'emulator-5554',
      runId: 'run-android-comparable',
      scenarioId: 'feed-scroll',
      targetPath,
    }),
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, missingCommandRecordContext), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const mismatchedTargetBindingFixture = buildObservedTargetBindingFixture({
    platform: 'android',
    providerId: 'native-provider',
    requestedAppId: 'com.example.app',
    requestedTargetId: 'emulator-5554',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    targetPath,
  });
  const mismatchedCommandRecordContext = comparisonContext({
    artifactPath,
    evidenceHashes: mismatchedTargetBindingFixture.hashes,
    evidenceRecords: {
      'raw/provider-commands/native-provider-capture-native-performance.json': {
        args: ['normalize', '--target-binding', 'raw/providers/native-provider/wrong-target-binding.json'],
        command: 'capture-native-performance',
        endedAt: '2026-07-13T12:00:12.200Z',
        phase: 'afterCapture',
        providerId: 'native-provider',
        startedAt: '2026-07-13T12:00:12.100Z',
        startedRecordPath: 'raw/provider-commands/native-provider-capture-native-performance.started.json',
        status: 'completed',
        stderrPath: 'raw/provider-commands/native-provider-capture-native-performance.stderr.txt',
        stderrSha256: EMPTY_STDERR_SHA256,
        stdoutPath: 'raw/provider-commands/native-provider-capture-native-performance.stdout.txt',
        stdoutSha256: EMPTY_STDOUT_SHA256,
      },
      'raw/provider-commands/native-provider-capture-native-performance.started.json': {
        args: ['normalize', '--target-binding', targetPath],
        command: 'capture-native-performance',
        phase: 'afterCapture',
        providerId: 'native-provider',
        startedAt: '2026-07-13T12:00:12.100Z',
        startedRecordPath: 'raw/provider-commands/native-provider-capture-native-performance.started.json',
        status: 'started',
        stderrPath: 'raw/provider-commands/native-provider-capture-native-performance.stderr.txt',
        stdoutPath: 'raw/provider-commands/native-provider-capture-native-performance.stdout.txt',
      },
      ...Object.fromEntries(Object.entries(mismatchedTargetBindingFixture.records).filter(([runRelativePath]) => (
        !runRelativePath.includes('capture-native-performance')
      ))),
    },
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-android-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [
      sourcePath,
      'raw/provider-commands/native-provider-capture-native-performance.json',
      'raw/provider-commands/native-provider-capture-native-performance.started.json',
      'raw/provider-commands/native-provider-capture-native-performance.stdout.txt',
      'raw/provider-commands/native-provider-capture-native-performance.stderr.txt',
      ...mismatchedTargetBindingFixture.durablePaths.filter((runRelativePath) => (
        !runRelativePath.includes('capture-native-performance')
      )),
    ],
    targetBindingRecord: mismatchedTargetBindingFixture.record,
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, mismatchedCommandRecordContext), {
    missingEvidence: ['observed-target-binding'],
    status: 'diagnostic-only',
  });

  const policyBoundaryCases: Array<{
    evidence: Record<string, unknown>;
    expectedGap: string;
    name: string;
  }> = [
    {
      evidence: { ...evidence, completenessStatus: 'partial' },
      expectedGap: 'complete-evidence',
      name: 'partial completeness',
    },
    {
      evidence: { ...evidence, claimSufficiency: { status: 'sufficient-for-comparison', supportingEvidence: [] } },
      expectedGap: 'comparison-claim',
      name: 'unsupported comparison claim',
    },
    {
      evidence: { ...evidence, comparability: { status: 'comparable' } },
      expectedGap: 'comparable-policy',
      name: 'missing comparable policy',
    },
    {
      evidence: {
        ...evidence,
        ...buildComparisonContract({
          environment: [],
          targetFamily: 'android-mobile-app',
        }),
      },
      expectedGap: 'comparable-policy',
      name: 'empty environment conditions',
    },
    {
      evidence: { ...evidence, capturedAt: '1970-01-01T00:00:00.000Z' },
      expectedGap: 'capture-timestamp',
      name: 'placeholder capture timestamp',
    },
    {
      evidence: { ...evidence, clockDomain: '' },
      expectedGap: 'clock-domain',
      name: 'missing clock domain',
    },
    {
      evidence: {
        ...evidence,
        events: [{ timestampMs: 1 }],
        frames: undefined,
        memory: undefined,
        metrics: undefined,
      },
      expectedGap: 'measurable-samples',
      name: 'event timestamp metadata without performance samples',
    },
    {
      evidence: {
        ...evidence,
        events: undefined,
        frames: { timestampMs: 1 },
        memory: undefined,
        metrics: undefined,
      },
      expectedGap: 'measurable-samples',
      name: 'frame timestamp metadata without performance samples',
    },
    {
      evidence: {
        ...evidence,
        events: undefined,
        frames: undefined,
        memory: { timestampMs: 1 },
        metrics: undefined,
      },
      expectedGap: 'measurable-samples',
      name: 'memory timestamp metadata without performance samples',
    },
    {
      evidence: {
        ...evidence,
        events: undefined,
        frames: undefined,
        memory: undefined,
        metrics: { timestampMs: 1 },
      },
      expectedGap: 'measurable-samples',
      name: 'metric timestamp metadata without performance samples',
    },
    {
      evidence: {
        ...evidence,
        traces: evidence.traces.map((trace: Record<string, unknown>) => ({
          ...trace,
          durationMs: 1000,
        })),
      },
      expectedGap: 'bounded-capture-window',
      name: 'inconsistent trace duration',
    },
  ];
  for (const policyCase of policyBoundaryCases) {
    const readiness = classifyNativePerformanceComparisonReadiness(policyCase.evidence, context);
    assert.equal(readiness.status, 'diagnostic-only', policyCase.name);
    assert.ok(readiness.missingEvidence.includes(policyCase.expectedGap), policyCase.name);
  }

  const wrongRunReadiness = classifyNativePerformanceComparisonReadiness(evidence, {
    ...context,
    expectedRunId: 'another-run',
  });
  assert.deepEqual(wrongRunReadiness, {
    missingEvidence: ['artifact-identity', 'observed-target-binding'],
    status: 'diagnostic-only',
  });

  const missingFilesReadiness = classifyNativePerformanceComparisonReadiness(evidence, {
    ...context,
    evidencePathExists: () => false,
  });
  assert.deepEqual(missingFilesReadiness, {
    missingEvidence: ['captured-source', 'observed-target-binding'],
    status: 'diagnostic-only',
  });
});

test('downgrades self-attested comparison evidence without durable source, window, or observed target proof', () => {
  const evidence = {
    capturedAt: '2026-07-13T12:00:12.000Z',
    clockDomain: 'host',
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      supportingEvidence: ['provider summary'],
    },
    comparability: {
      status: 'comparable',
      policy: 'same declared cohort',
    },
    completenessStatus: 'complete',
    diagnosticSources: [
      {
        path: '/tmp/provider-summary.txt',
        sourceId: 'diagnostic-summary',
        status: 'captured',
      },
    ],
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-self-attested',
    scenarioId: 'feed-scroll',
    summary: 'Provider declared the evidence comparison-ready.',
    targetBinding: {
      appId: 'com.example.app',
      deviceId: 'emulator-5554',
      source: 'provider',
      status: 'verified',
    },
  };
  const context = comparisonContext({
    artifactPath: 'raw/providers/native-provider/native-performance.json',
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-self-attested',
    scenarioId: 'feed-scroll',
    targetPath: 'raw/providers/native-provider/target.json',
  });
  const readiness = classifyNativePerformanceComparisonReadiness(evidence, {
    ...context,
    evidencePathExists: () => false,
  });

  assert.deepEqual(readiness, {
    missingEvidence: ['comparable-policy', 'captured-source', 'measurable-samples', 'bounded-capture-window', 'observed-target-binding'],
    status: 'diagnostic-only',
  });
});

test('requires every caller-owned native-performance identity expectation', () => {
  const artifactPath = 'raw/providers/native-provider/native-performance.json';
  const targetPath = 'raw/providers/native-provider/target.json';
  const context = comparisonContext({
    artifactPath,
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-identity',
    scenarioId: 'feed-scroll',
    targetPath,
  });
  const evidence = {
    ...buildComparisonContract({
      targetFamily: 'android-mobile-app',
    }),
    schemaVersion: '1.1.0',
    attachments: [
      {
        kind: 'native-trace',
        path: 'raw/providers/native-provider/active-window-capture.json',
      },
    ],
    capturedAt: '2026-07-13T12:00:12.000Z',
    clockDomain: 'host',
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      supportingEvidence: ['provider summary'],
    },
    comparability: {
      policy: 'same captured cohort',
      status: 'comparable',
    },
    completenessStatus: 'complete',
    diagnosticSources: [
      {
        path: artifactPath,
        sourceId: 'trace-processor',
        status: 'captured',
      },
    ],
    frames: {
      totalFrameCount: 60,
    },
    platform: 'android',
    providerId: 'native-provider',
    runId: 'run-identity',
    scenarioId: 'feed-scroll',
    targetBinding: {
      appId: 'com.example.app',
      candidateTargets: [
        {
          appId: 'com.example.app',
          bindingStatus: 'observed',
          deviceId: 'emulator-5554',
          evidencePath: targetPath,
          platform: 'android',
          source: 'provider-session-status',
        },
      ],
      deviceId: 'emulator-5554',
      source: 'provider-session-status',
      status: 'verified',
    },
    traces: [
      {
        durationMs: 1000,
        traceId: 'trace-identity',
        windowEndMs: 1000,
        windowStartMs: 0,
      },
    ],
  };

  assert.equal(classifyNativePerformanceComparisonReadiness(evidence, context).status, 'comparison-ready');
  for (const key of [
    'expectedPlatform',
    'expectedProviderId',
    'expectedRunId',
    'expectedScenarioId',
  ] as const) {
    const incompleteContext = { ...context } as Record<string, unknown>;
    delete incompleteContext[key];
    const readiness = classifyNativePerformanceComparisonReadiness(evidence, incompleteContext);
    assert.equal(readiness.status, 'diagnostic-only', key);
    assert.ok(readiness.missingEvidence.includes('artifact-identity'), key);
  }

  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, undefined), {
    missingEvidence: ['artifact-identity', 'captured-source', 'observed-target-binding'],
    status: 'diagnostic-only',
  });
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

  assert.equal(evidence.schemaVersion, '1.1.0');
  assert.equal(evidence.platform, 'ios');
  assert.equal(evidence.evidenceKind, 'mixed');
  assert.equal(evidence.completenessStatus, 'partial');
  assert.deepEqual(evidence.dataClasses, ['frames', 'jank', 'render', 'memory', 'cpu', 'thread-scheduling', 'thermal', 'battery', 'native-trace']);
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.claimSufficiency.status, 'sufficient-for-diagnosis');
  assert.equal(evidence.targetBinding.status, 'unverified');
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

test('classifies iOS evidence as comparison-ready under the shared native-performance trust gate', () => {
  const artifactPath = 'raw/providers/native-provider/native-performance.json';
  const capturePath = 'raw/providers/native-provider/active-window-capture.json';
  const sourcePath = 'raw/providers/native-provider/xctrace-summary.json';
  const targetPath = 'raw/providers/native-provider/ios-target.json';
  const evidence = buildIosNativePerformanceEvidence({
    bundleId: 'com.example.app',
    attachments: [
      {
        kind: 'native-trace',
        path: capturePath,
      },
    ],
    capturedAt: '2026-07-13T12:00:12.000Z',
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      claim: 'ios-native-frame-budget',
      reason: 'Provider captured a complete comparable xctrace window against the observed target.',
      supportingEvidence: ['bounded xctrace summary'],
    },
    comparability: {
      status: 'comparable',
      reason: 'The provider used the release-gated iOS baseline policy.',
      policy: 'release-native-baseline-v1',
    },
    ...buildComparisonContract({
      targetFamily: 'ios-simulator-app',
    }),
    completenessStatus: 'complete',
    diagnosticSources: [
      {
        sourceId: 'xctrace',
        status: 'captured',
        path: sourcePath,
      },
    ],
    deviceId: 'SIM-123',
    providerId: 'native-provider',
    runId: 'run-ios-comparable',
    scenarioId: 'feed-scroll',
    targetBinding: {
      status: 'verified',
      source: 'provider-session-status',
      candidateTargets: [
        {
          appId: 'com.example.app',
          bindingStatus: 'observed',
          deviceId: 'SIM-123',
          evidencePath: targetPath,
          platform: 'ios',
          source: 'provider-session-status',
        },
      ],
    },
    xctraceSummary: {
      durationMs: 12000,
      frameCount: 720,
      p95FrameMs: 20,
      traceId: 'ios-trace-1',
      windowEndMs: 12000,
      windowStartMs: 0,
    },
  });

  const context = comparisonContext({
    artifactPath,
    platform: 'ios',
    providerId: 'native-provider',
    runId: 'run-ios-comparable',
    scenarioId: 'feed-scroll',
    sourcePaths: [sourcePath],
    targetPath,
  });
  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, context), {
    missingEvidence: [],
    status: 'comparison-ready',
  });

  assert.deepEqual(classifyNativePerformanceComparisonReadiness(evidence, {
    ...context,
    expectedPlatform: 'android',
  }), {
    missingEvidence: ['artifact-identity'],
    status: 'diagnostic-only',
  });
});

test('preserves provider-owned iOS capture session lifecycle metadata', () => {
  const evidence = buildIosNativePerformanceEvidence({
    captureMode: 'session',
    lifecycle: {
      durationMs: 10000,
      endedAt: '2026-07-13T12:00:10.000Z',
      perturbsTiming: true,
      phase: 'afterCapture',
      startedAt: '2026-07-13T12:00:00.000Z',
    },
    providerId: 'native-provider',
    runId: 'run-ios-session',
    scenarioId: 'feed-scroll',
  });

  assert.equal(evidence.captureMode, 'session');
  assert.deepEqual(evidence.lifecycle, {
    durationMs: 10000,
    endedAt: '2026-07-13T12:00:10.000Z',
    perturbsTiming: true,
    phase: 'afterCapture',
    startedAt: '2026-07-13T12:00:00.000Z',
  });
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
