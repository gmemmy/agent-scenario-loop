const { assertValidJson, SCHEMAS } = require('./schema-validator');

type JsonRecord = Record<string, unknown>;

type NativePerformanceAttachment = {
  kind: string;
  path: string;
  sha256?: string;
  sizeBytes?: number;
};

type NativePerformanceDiagnosticSource = {
  dataClasses: string[];
  nextAction: string;
  path?: string | undefined;
  reason: string;
  sourceId: string;
  status: 'captured' | 'unverified';
  tool: {
    name: string;
  };
};

type AndroidNativePerformanceEvidenceInput = {
  appId?: string;
  attachments?: NativePerformanceAttachment[];
  capturedAt?: string;
  deviceId?: string;
  gfxinfoText?: string;
  meminfoText?: string;
  providerId: string;
  runId: string;
  scenarioId: string;
};

type AndroidGfxinfoSummary = {
  frameDeadlineMissed?: number;
  janky?: number;
  jankyPercent?: number;
  missedVsync?: number;
  p50Ms?: number;
  p90Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  slowBitmapUploads?: number;
  slowIssueDrawCommands?: number;
  slowUiThread?: number;
  total?: number;
};

type AndroidMeminfoSummary = {
  activities?: number;
  nativeHeapAllocKb?: number;
  nativeHeapPssKb?: number;
  totalPssKb?: number;
  views?: number;
  webViews?: number;
};

/**
 * Reads an integer token that may contain thousands separators.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parseIntegerToken(value: string | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value.replace(/,/gu, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Reads a percentage token.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parsePercentToken(value: string | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Finds the first integer that matches any supplied pattern.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {number | undefined}
 */
function firstIntegerMatch(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const parsed = parseIntegerToken(match?.[1]);
    if (typeof parsed === 'number') {
      return parsed;
    }
  }

  return undefined;
}

/**
 * Adds a defined scalar to an object without leaking undefined fields into public artifacts.
 *
 * @param {Record<string, unknown>} target
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
function setDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Returns true when an object carries at least one scalar summary field.
 *
 * @param {Record<string, unknown>} value
 * @returns {boolean}
 */
function hasFields(value: JsonRecord): boolean {
  return Object.keys(value).length > 0;
}

/**
 * Parses Android `dumpsys gfxinfo` summary text into ASL native frame evidence.
 *
 * @param {string} text
 * @returns {AndroidGfxinfoSummary}
 */
function parseAndroidGfxinfoSummary(text: string): AndroidGfxinfoSummary {
  const jankyMatch = /Janky frames:\s*([\d,]+)(?:\s*\(([\d.]+)%\))?/iu.exec(text);
  const summary: JsonRecord = {};

  setDefined(summary, 'total', firstIntegerMatch(text, [
    /Total frames rendered:\s*([\d,]+)/iu,
    /\btotalFrameCount\s*[:=]\s*([\d,]+)/iu,
  ]));
  setDefined(summary, 'janky', parseIntegerToken(jankyMatch?.[1]));
  setDefined(summary, 'jankyPercent', parsePercentToken(jankyMatch?.[2]));
  setDefined(summary, 'p50Ms', firstIntegerMatch(text, [
    /\bp50\s*:\s*([\d,]+)\s*ms/iu,
    /\b50th percentile:\s*([\d,]+)\s*ms/iu,
  ]));
  setDefined(summary, 'p90Ms', firstIntegerMatch(text, [
    /\bp90\s*:\s*([\d,]+)\s*ms/iu,
    /\b90th percentile:\s*([\d,]+)\s*ms/iu,
  ]));
  setDefined(summary, 'p95Ms', firstIntegerMatch(text, [
    /\bp95\s*:\s*([\d,]+)\s*ms/iu,
    /\b95th percentile:\s*([\d,]+)\s*ms/iu,
  ]));
  setDefined(summary, 'p99Ms', firstIntegerMatch(text, [
    /\bp99\s*:\s*([\d,]+)\s*ms/iu,
    /\b99th percentile:\s*([\d,]+)\s*ms/iu,
  ]));
  setDefined(summary, 'missedVsync', firstIntegerMatch(text, [/Number Missed Vsync:\s*([\d,]+)/iu]));
  setDefined(summary, 'slowUiThread', firstIntegerMatch(text, [/Slow UI thread:\s*([\d,]+)/iu]));
  setDefined(summary, 'slowBitmapUploads', firstIntegerMatch(text, [/Slow bitmap uploads:\s*([\d,]+)/iu]));
  setDefined(summary, 'slowIssueDrawCommands', firstIntegerMatch(text, [/Slow issue draw commands:\s*([\d,]+)/iu]));
  setDefined(summary, 'frameDeadlineMissed', firstIntegerMatch(text, [/Frame deadline missed:\s*([\d,]+)/iu]));

  return summary as AndroidGfxinfoSummary;
}

/**
 * Parses Android `dumpsys meminfo` summary text into ASL native memory evidence.
 *
 * @param {string} text
 * @returns {AndroidMeminfoSummary}
 */
function parseAndroidMeminfoSummary(text: string): AndroidMeminfoSummary {
  const summary: JsonRecord = {};

  setDefined(summary, 'totalPssKb', firstIntegerMatch(text, [
    /TOTAL PSS:\s*([\d,]+)\s*KB/iu,
    /^\s*TOTAL\s+([\d,]+)\b/imu,
  ]));
  setDefined(summary, 'nativeHeapPssKb', firstIntegerMatch(text, [
    /Native Heap PSS:\s*([\d,]+)\s*KB/iu,
    /^\s*Native Heap\s+([\d,]+)\b/imu,
    /Native Heap:\s*([\d,]+)\s*KB/iu,
  ]));
  setDefined(summary, 'nativeHeapAllocKb', firstIntegerMatch(text, [
    /Native Heap Alloc:\s*([\d,]+)\s*KB/iu,
    /^\s*Native Heap\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+([\d,]+)\b/imu,
  ]));
  setDefined(summary, 'views', firstIntegerMatch(text, [/\bViews:\s*([\d,]+)/iu]));
  setDefined(summary, 'activities', firstIntegerMatch(text, [/\bActivities:\s*([\d,]+)/iu]));
  setDefined(summary, 'webViews', firstIntegerMatch(text, [/\bWebViews:\s*([\d,]+)/iu]));

  return summary as AndroidMeminfoSummary;
}

/**
 * Resolves the most specific native-performance evidence kind for Android text inputs.
 *
 * @param {{frames: Record<string, unknown>, memory: Record<string, unknown>}} options
 * @returns {'gfxinfo' | 'meminfo' | 'mixed' | 'unknown'}
 */
function resolveAndroidEvidenceKind({
  frames,
  memory,
}: {
  frames: JsonRecord;
  memory: JsonRecord;
}): 'gfxinfo' | 'meminfo' | 'mixed' | 'unknown' {
  const hasFrames = hasFields(frames);
  const hasMemory = hasFields(memory);
  if (hasFrames && hasMemory) {
    return 'mixed';
  }
  if (hasFrames) {
    return 'gfxinfo';
  }
  if (hasMemory) {
    return 'meminfo';
  }
  return 'unknown';
}

/**
 * Builds data-class tags from parsed native surfaces.
 *
 * @param {{frames: Record<string, unknown>, memory: Record<string, unknown>}} options
 * @returns {string[]}
 */
function buildAndroidDataClasses({
  frames,
  memory,
}: {
  frames: JsonRecord;
  memory: JsonRecord;
}): string[] {
  const dataClasses = new Set<string>();
  if (hasFields(frames)) {
    dataClasses.add('frames');
    dataClasses.add('jank');
    dataClasses.add('render');
  }
  if (hasFields(memory)) {
    dataClasses.add('memory');
  }
  if (dataClasses.size === 0) {
    dataClasses.add('unknown');
  }
  return Array.from(dataClasses);
}

/**
 * Finds the run-relative path for a raw native-performance attachment.
 *
 * @param {NativePerformanceAttachment[] | undefined} attachments
 * @param {string} kind
 * @returns {string | undefined}
 */
function findAttachmentPath(attachments: NativePerformanceAttachment[] | undefined, kind: string): string | undefined {
  return attachments?.find((attachment) => attachment.kind === kind)?.path;
}

/**
 * Builds one Android native diagnostic source inventory entry.
 *
 * @param {NativePerformanceDiagnosticSource} source
 * @returns {Record<string, unknown>}
 */
function buildAndroidDiagnosticSource(source: NativePerformanceDiagnosticSource): JsonRecord {
  const artifact: JsonRecord = {
    sourceId: source.sourceId,
    status: source.status,
    tool: source.tool,
    dataClasses: source.dataClasses,
    reason: source.reason,
    nextAction: source.nextAction,
  };
  setDefined(artifact, 'path', source.path);
  return artifact;
}

/**
 * Builds the Android native-performance source inventory, marking parsed surfaces as captured.
 *
 * @param {{attachments?: NativePerformanceAttachment[], frames: Record<string, unknown>, memory: Record<string, unknown>}} options
 * @returns {Record<string, unknown>[]}
 */
function buildAndroidDiagnosticSources({
  attachments,
  frames,
  memory,
}: {
  attachments: NativePerformanceAttachment[] | undefined;
  frames: JsonRecord;
  memory: JsonRecord;
}): JsonRecord[] {
  const gfxinfoCaptured = hasFields(frames);
  const meminfoCaptured = hasFields(memory);
  return [
    buildAndroidDiagnosticSource({
      dataClasses: ['frames', 'jank', 'render'],
      nextAction: gfxinfoCaptured
        ? 'Use the parsed gfxinfo summary for diagnosis; capture comparable frame evidence before release claims.'
        : 'Capture and parse gfxinfo or framestats output for Android frame evidence.',
      path: findAttachmentPath(attachments, 'raw-gfxinfo'),
      reason: gfxinfoCaptured
        ? 'Parsed Android gfxinfo frame summary fields were captured.'
        : 'No Android gfxinfo frame summary fields were parsed.',
      sourceId: 'gfxinfo',
      status: gfxinfoCaptured ? 'captured' : 'unverified',
      tool: {
        name: 'adb dumpsys gfxinfo',
      },
    }),
    buildAndroidDiagnosticSource({
      dataClasses: ['frames', 'jank'],
      nextAction: 'Capture Android framestats when frame deadline or per-frame timing evidence is needed.',
      reason: 'This builder does not parse framestats rows yet.',
      sourceId: 'framestats',
      status: 'unverified',
      tool: {
        name: 'adb dumpsys gfxinfo framestats',
      },
    }),
    buildAndroidDiagnosticSource({
      dataClasses: ['memory'],
      nextAction: meminfoCaptured
        ? 'Use the parsed meminfo summary for diagnosis; capture comparable memory evidence before release claims.'
        : 'Capture and parse meminfo output for Android native memory evidence.',
      path: findAttachmentPath(attachments, 'raw-meminfo'),
      reason: meminfoCaptured
        ? 'Parsed Android meminfo memory summary fields were captured.'
        : 'No Android meminfo memory summary fields were parsed.',
      sourceId: 'meminfo',
      status: meminfoCaptured ? 'captured' : 'unverified',
      tool: {
        name: 'adb dumpsys meminfo',
      },
    }),
    buildAndroidDiagnosticSource({
      dataClasses: ['frames', 'jank', 'cpu', 'thread-scheduling', 'native-trace'],
      nextAction: 'Capture a bounded Perfetto trace and attach the raw trace plus a structured summary.',
      reason: 'No Perfetto trace was supplied to this Android summary builder.',
      sourceId: 'perfetto',
      status: 'unverified',
      tool: {
        name: 'perfetto',
      },
    }),
    buildAndroidDiagnosticSource({
      dataClasses: ['frames', 'jank', 'cpu', 'thread-scheduling'],
      nextAction: 'Summarize Perfetto trace data with trace-processor SQL before making comparable claims.',
      reason: 'No trace-processor summary was supplied to this Android summary builder.',
      sourceId: 'trace-processor',
      status: 'unverified',
      tool: {
        name: 'trace_processor_shell',
      },
    }),
    buildAndroidDiagnosticSource({
      dataClasses: ['render'],
      nextAction: 'Preserve render or runtime markers from logcat when they explain the native-performance run.',
      reason: 'No logcat render summary was supplied to this Android summary builder.',
      sourceId: 'logcat-render',
      status: 'unverified',
      tool: {
        name: 'adb logcat',
      },
    }),
  ];
}

/**
 * Builds a product-neutral, schema-valid Android native-performance evidence envelope.
 *
 * @param {AndroidNativePerformanceEvidenceInput} input
 * @returns {Record<string, unknown>}
 */
function buildAndroidNativePerformanceEvidence(input: AndroidNativePerformanceEvidenceInput): JsonRecord {
  const frames = typeof input.gfxinfoText === 'string' ? parseAndroidGfxinfoSummary(input.gfxinfoText) : {};
  const memory = typeof input.meminfoText === 'string' ? parseAndroidMeminfoSummary(input.meminfoText) : {};
  const evidenceKind = resolveAndroidEvidenceKind({ frames, memory });
  const dataClasses = buildAndroidDataClasses({ frames, memory });
  const diagnosticSources = buildAndroidDiagnosticSources({ attachments: input.attachments, frames, memory });
  const supportingEvidence: string[] = [];
  if (hasFields(frames)) {
    supportingEvidence.push('android gfxinfo frame summary');
  }
  if (hasFields(memory)) {
    supportingEvidence.push('android meminfo memory summary');
  }

  const targetBinding: JsonRecord = {};
  if (input.appId && input.deviceId) {
    targetBinding.status = 'verified';
    targetBinding.reason = 'Provider supplied both Android package id and device id for this evidence envelope.';
  } else {
    targetBinding.status = 'unverified';
    targetBinding.reason = 'Provider did not supply both Android package id and device id.';
  }
  setDefined(targetBinding, 'appId', input.appId);
  setDefined(targetBinding, 'deviceId', input.deviceId);
  targetBinding.source = 'provider';

  const evidence: JsonRecord = {
    schemaVersion: '1.0.0',
    providerId: input.providerId,
    platform: 'android',
    runId: input.runId,
    scenarioId: input.scenarioId,
    tool: {
      name: 'android-platform-diagnostics',
      command: 'dumpsys gfxinfo / dumpsys meminfo',
    },
    capturedAt: input.capturedAt ?? new Date(0).toISOString(),
    captureMode: 'afterCapture',
    clockDomain: 'host',
    completenessStatus: supportingEvidence.length > 0 ? 'partial' : 'unknown',
    comparability: {
      status: 'diagnostic-only',
      reason: 'Android native diagnostics were normalized for investigation, not collected under a comparable ASL native-performance baseline.',
      policy: 'Use this evidence to classify native/render/memory pressure; require a complete comparable lane before release performance claims.',
    },
    dataClasses,
    diagnosticSources,
    evidenceKind,
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding,
    claimSufficiency: {
      status: supportingEvidence.length > 0 ? 'sufficient-for-diagnosis' : 'insufficient-for-claim',
      claim: 'android-native-performance',
      reason: supportingEvidence.length > 0
        ? 'Parsed Android native diagnostics are useful for diagnosis but are not budget-comparable.'
        : 'No Android native diagnostic summary fields were parsed.',
      nextAction: 'Use provider-captured raw artifacts and rerun a comparable native-performance lane before making release claims.',
      ...(supportingEvidence.length > 0 ? { supportingEvidence } : { missingEvidence: ['gfxinfo or meminfo summary fields'] }),
    },
    summary: supportingEvidence.length > 0
      ? `Normalized ${supportingEvidence.join(' and ')} as diagnostic-only native-performance evidence.`
      : 'No Android native-performance summary fields were parsed from provider input.',
  };

  if (hasFields(frames)) {
    evidence.frames = frames;
  }
  if (hasFields(memory)) {
    evidence.memory = memory;
  }
  if (input.attachments && input.attachments.length > 0) {
    evidence.attachments = input.attachments;
  }

  return assertValidJson(evidence, SCHEMAS.nativePerformance, 'Native performance evidence artifact') as JsonRecord;
}

export {
  buildAndroidNativePerformanceEvidence,
  parseAndroidGfxinfoSummary,
  parseAndroidMeminfoSummary,
};

export type {
  AndroidGfxinfoSummary,
  AndroidMeminfoSummary,
  AndroidNativePerformanceEvidenceInput,
  NativePerformanceAttachment,
};
