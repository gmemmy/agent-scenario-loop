const { assertValidJson, SCHEMAS } = require('./schema-validator');

type JsonRecord = Record<string, unknown>;

type NativePerformanceAttachment = {
  kind: string;
  path: string;
  sha256?: string;
  sizeBytes?: number;
};

type NativePerformanceDiagnosticSourceStatus =
  | 'available-unproven'
  | 'captured'
  | 'failed'
  | 'not-requested'
  | 'partial'
  | 'timeout'
  | 'unknown'
  | 'unsupported'
  | 'unverified';

type NativePerformanceDiagnosticSourceId =
  | 'custom'
  | 'diagnostic-summary'
  | 'framestats'
  | 'gfxinfo'
  | 'instruments'
  | 'logcat-render'
  | 'meminfo'
  | 'metrickit'
  | 'native-trace'
  | 'perfetto'
  | 'simctl'
  | 'trace-processor'
  | 'xctrace';

type NativePerformanceDiagnosticSource = {
  dataClasses: string[];
  nextAction?: string;
  path?: string | undefined;
  reason?: string;
  sourceId: NativePerformanceDiagnosticSourceId;
  status: NativePerformanceDiagnosticSourceStatus;
  tool?: {
    name: string;
    command?: string;
    version?: string;
  };
};

type NativePerformanceDiagnosticSourceOverride = {
  dataClasses?: string[];
  nextAction?: string;
  path?: string;
  reason?: string;
  sourceId: NativePerformanceDiagnosticSourceId;
  status: NativePerformanceDiagnosticSourceStatus;
  tool?: {
    command?: string;
    name: string;
    version?: string;
  };
};

type NativePerformanceClaimSufficiencyStatus =
  | 'insufficient-for-claim'
  | 'sufficient-for-comparison'
  | 'sufficient-for-diagnosis'
  | 'unknown';

type NativePerformanceClaimSufficiencyOverride = {
  claim?: string;
  missingEvidence?: string[];
  nextAction?: string;
  reason?: string;
  status: NativePerformanceClaimSufficiencyStatus;
  supportingEvidence?: string[];
};

type NativePerformanceComparabilityStatus =
  | 'captured-not-comparable'
  | 'comparable'
  | 'diagnostic-only'
  | 'incomplete'
  | 'low-confidence'
  | 'unknown';

type NativePerformanceComparabilityOverride = {
  policy?: string;
  reason?: string;
  status: NativePerformanceComparabilityStatus;
};

type NativePerformanceCompletenessStatus = 'complete' | 'failed' | 'partial' | 'truncated' | 'unknown';

type NativePerformanceCaptureMode = 'afterCapture' | 'inline' | 'passive-report' | 'postRun' | 'rehydrated' | 'session' | 'unknown';

type NativePerformanceLifecycleOverride = {
  durationMs?: number;
  endedAt?: string;
  perturbsTiming: boolean;
  phase: 'activeLoop' | 'afterCapture' | 'beforeRun' | 'postRun' | 'rehydrated' | 'unknown';
  startedAt?: string;
};

type NativePerformanceComparisonEvidenceGap =
  | 'artifact-identity'
  | 'bounded-capture-window'
  | 'capture-timestamp'
  | 'captured-source'
  | 'clock-domain'
  | 'comparable-policy'
  | 'comparison-claim'
  | 'complete-evidence'
  | 'measurable-samples'
  | 'observed-target-binding';

type NativePerformanceComparisonContext = {
  artifactPath: string;
  evidencePathExists: (runRelativePath: string) => boolean;
  expectedPlatform: 'android' | 'ios';
  expectedProviderId: string;
  expectedRunId: string;
  expectedScenarioId: string;
};

type NativePerformanceComparisonReadiness =
  | {
      missingEvidence: [];
      status: 'comparison-ready';
    }
  | {
      missingEvidence: NativePerformanceComparisonEvidenceGap[];
      status: 'diagnostic-only';
    };

type NativePerformanceTargetBindingStatus = 'ambiguous' | 'mismatch' | 'unknown' | 'unverified' | 'verified';

type NativePerformanceTargetCandidate = {
  appId?: string;
  bindingStatus: 'conflicting' | 'expected' | 'observed' | 'unknown' | 'unverified';
  deviceId?: string;
  deviceName?: string;
  evidencePath?: string;
  platform?: 'android' | 'ios' | 'unknown';
  reason?: string;
  source?: string;
};

type NativePerformanceTargetBindingOverride = {
  appId?: string;
  bundleId?: string;
  candidateTargets?: NativePerformanceTargetCandidate[];
  deviceId?: string;
  reason?: string;
  source?: string;
  status: NativePerformanceTargetBindingStatus;
};

type AndroidNativePerformanceEvidenceInput = {
  appId?: string;
  attachments?: NativePerformanceAttachment[];
  capturedAt?: string;
  claimSufficiency?: NativePerformanceClaimSufficiencyOverride;
  comparability?: NativePerformanceComparabilityOverride;
  completenessStatus?: NativePerformanceCompletenessStatus;
  deviceId?: string;
  diagnosticSources?: NativePerformanceDiagnosticSourceOverride[];
  framestatsText?: string;
  gfxinfoText?: string;
  meminfoText?: string;
  providerId: string;
  runId: string;
  scenarioId: string;
  targetBinding?: NativePerformanceTargetBindingOverride;
  traceProcessorSummary?: AndroidTraceProcessorSummaryInput;
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

type AndroidFramestatsSummary = {
  flaggedFrameCount?: number;
  frameCount?: number;
  jankyFrameCount?: number;
  missedDeadlineFrameCount?: number;
  p50FrameMs?: number;
  p90FrameMs?: number;
  p95FrameMs?: number;
  p99FrameMs?: number;
  worstFrameMs?: number;
};

type AndroidMeminfoSummary = {
  activities?: number;
  nativeHeapAllocKb?: number;
  nativeHeapPssKb?: number;
  totalPssKb?: number;
  views?: number;
  webViews?: number;
};

type AndroidTraceProcessorSummaryInput = {
  cpuMs?: number;
  durationMs?: number;
  expectedFrameCount?: number;
  frameCount?: number;
  frameDeadlineMissed?: number;
  jankyFrameCount?: number;
  mainThreadCpuMs?: number;
  missedDeadlineFrameCount?: number;
  p50FrameMs?: number;
  p90FrameMs?: number;
  p95FrameMs?: number;
  p99FrameMs?: number;
  renderThreadCpuMs?: number;
  slowFrameCount?: number;
  threadSchedulingDelayMs?: number;
  traceId?: string;
  windowEndMs?: number;
  windowStartMs?: number;
  worstFrameMs?: number;
};

type AndroidTraceProcessorSummary = {
  frames: JsonRecord;
  metrics: JsonRecord;
  traces: JsonRecord;
};

type IosNativePerformanceSummaryInput = {
  averageFrameMs?: number;
  batteryImpact?: number;
  cpuMs?: number;
  durationMs?: number;
  frameCount?: number;
  hitchCount?: number;
  jankyFrameCount?: number;
  mainThreadCpuMs?: number;
  memoryPeakBytes?: number;
  p50FrameMs?: number;
  p90FrameMs?: number;
  p95FrameMs?: number;
  p99FrameMs?: number;
  physicalFootprintBytes?: number;
  residentSizeBytes?: number;
  threadSchedulingDelayMs?: number;
  thermalState?: string;
  traceId?: string;
  windowEndMs?: number;
  windowStartMs?: number;
  worstFrameMs?: number;
};

type IosNativePerformanceEvidenceInput = {
  appId?: string;
  attachments?: NativePerformanceAttachment[];
  bundleId?: string;
  captureMode?: NativePerformanceCaptureMode;
  capturedAt?: string;
  claimSufficiency?: NativePerformanceClaimSufficiencyOverride;
  comparability?: NativePerformanceComparabilityOverride;
  completenessStatus?: NativePerformanceCompletenessStatus;
  deviceId?: string;
  diagnosticSources?: NativePerformanceDiagnosticSourceOverride[];
  instrumentsSummary?: IosNativePerformanceSummaryInput;
  lifecycle?: NativePerformanceLifecycleOverride;
  metricKitSummary?: IosNativePerformanceSummaryInput;
  providerId: string;
  runId: string;
  scenarioId: string;
  simctlSummary?: IosNativePerformanceSummaryInput;
  targetBinding?: NativePerformanceTargetBindingOverride;
  xctraceSummary?: IosNativePerformanceSummaryInput;
};

type IosNativePerformanceTextSummary = IosNativePerformanceSummaryInput;

type IosNativePerformanceSummary = {
  frames: JsonRecord;
  memory: JsonRecord;
  metrics: JsonRecord;
  traces: JsonRecord;
};

type IosNativePerformanceSourceSummary = {
  sourceId: 'instruments' | 'metrickit' | 'simctl' | 'xctrace';
  summary: IosNativePerformanceSummary;
};

type IosNativePerformanceEvidenceSource = IosNativePerformanceSourceSummary['sourceId'] | 'native-trace';

const NATIVE_PERFORMANCE_SAMPLE_KEYS = new Set([
  'activities',
  'averageFrameMs',
  'batteryImpact',
  'cpuMs',
  'cpuPercent',
  'droppedFrameCount',
  'droppedFramePercent',
  'expectedFrameCount',
  'flaggedFrameCount',
  'frameCount',
  'frameDeadlineMissed',
  'frameDurationMs',
  'frameHitchCount',
  'gpuMs',
  'gpuPercent',
  'hitchCount',
  'ioReadBytes',
  'ioWriteBytes',
  'janky',
  'jankyFrameCount',
  'jankyPercent',
  'mainThreadCpuMs',
  'memoryPeakBytes',
  'missedDeadlineFrameCount',
  'missedVsync',
  'nativeHeapAllocKb',
  'nativeHeapPssKb',
  'networkReceivedBytes',
  'networkSentBytes',
  'p50FrameMs',
  'p50Ms',
  'p90FrameMs',
  'p90Ms',
  'p95FrameMs',
  'p95Ms',
  'p99FrameMs',
  'p99Ms',
  'peakResidentMemoryKb',
  'physicalFootprintBytes',
  'renderDurationMs',
  'renderThreadCpuMs',
  'residentSizeBytes',
  'slowBitmapUploads',
  'slowFrameCount',
  'slowIssueDrawCommands',
  'slowUiThread',
  'threadSchedulingDelayMs',
  'total',
  'totalFrameCount',
  'totalPssKb',
  'views',
  'webViews',
  'worstFrameMs',
]);

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
 * Reads a finite number token that may contain thousands separators.
 *
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parseNumberToken(value: string | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Number(value.replace(/,/gu, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Converts a duration token into milliseconds.
 *
 * @param {string | undefined} value
 * @param {string | undefined} unit
 * @returns {number | undefined}
 */
function parseDurationMsToken(value: string | undefined, unit: string | undefined): number | undefined {
  const parsed = parseNumberToken(value);
  if (typeof parsed !== 'number') {
    return undefined;
  }

  const normalizedUnit = unit?.toLowerCase();
  if (normalizedUnit === 's' || normalizedUnit === 'sec' || normalizedUnit === 'secs' || normalizedUnit === 'second' || normalizedUnit === 'seconds') {
    return parsed * 1000;
  }

  return parsed;
}

/**
 * Converts a memory-size token into bytes.
 *
 * @param {string | undefined} value
 * @param {string | undefined} unit
 * @returns {number | undefined}
 */
function parseBytesToken(value: string | undefined, unit: string | undefined): number | undefined {
  const parsed = parseNumberToken(value);
  if (typeof parsed !== 'number') {
    return undefined;
  }

  const normalizedUnit = unit?.toLowerCase();
  if (normalizedUnit === 'kb' || normalizedUnit === 'kib') {
    return Math.round(parsed * 1024);
  }
  if (normalizedUnit === 'mb' || normalizedUnit === 'mib') {
    return Math.round(parsed * 1024 * 1024);
  }
  if (normalizedUnit === 'gb' || normalizedUnit === 'gib') {
    return Math.round(parsed * 1024 * 1024 * 1024);
  }

  return Math.round(parsed);
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
 * Finds the first finite number that matches any supplied pattern.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {number | undefined}
 */
function firstNumberMatch(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const parsed = parseNumberToken(match?.[1]);
    if (typeof parsed === 'number') {
      return parsed;
    }
  }

  return undefined;
}

/**
 * Finds the first duration value and returns it in milliseconds.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {number | undefined}
 */
function firstDurationMsMatch(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const parsed = parseDurationMsToken(match?.[1], match?.[2]);
    if (typeof parsed === 'number') {
      return parsed;
    }
  }

  return undefined;
}

/**
 * Finds the first memory-size value and returns it in bytes.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {number | undefined}
 */
function firstBytesMatch(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const parsed = parseBytesToken(match?.[1], match?.[2]);
    if (typeof parsed === 'number') {
      return parsed;
    }
  }

  return undefined;
}

/**
 * Finds the first string capture that matches any supplied pattern.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {string | undefined}
 */
function firstStringMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1];
    if (isNonEmptyString(value)) {
      return value;
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
 * Returns true when a normalized trace-processor summary carries evidence.
 *
 * @param {AndroidTraceProcessorSummary} summary
 * @returns {boolean}
 */
function hasTraceProcessorSummary(summary: AndroidTraceProcessorSummary): boolean {
  return hasFields(summary.frames) || hasFields(summary.metrics) || hasFields(summary.traces);
}

/**
 * Returns a finite numeric value from provider-supplied structured summary input.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {number | undefined}
 */
function readFiniteNumber(value: JsonRecord, key: string): number | undefined {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return undefined;
  }

  return raw;
}

/**
 * Returns a non-empty string from provider-supplied structured summary input.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {string | undefined}
 */
function readNonEmptyString(value: JsonRecord, key: string): string | undefined {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }

  return raw;
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
 * Calculates a percentile from a sorted list of values.
 *
 * @param {number[]} sortedValues
 * @param {number} percentile
 * @returns {number | undefined}
 */
function percentile(sortedValues: number[], percentile: number): number | undefined {
  if (sortedValues.length === 0) {
    return undefined;
  }

  const rawIndex = Math.ceil((percentile / 100) * sortedValues.length) - 1;
  const index = Math.min(Math.max(rawIndex, 0), sortedValues.length - 1);
  return sortedValues[index];
}

/**
 * Parses Android `dumpsys gfxinfo framestats` rows into ASL frame evidence.
 *
 * @param {string} text
 * @returns {AndroidFramestatsSummary}
 */
function parseAndroidFramestatsSummary(text: string): AndroidFramestatsSummary {
  const frames: Array<{ durationMs: number; flags: number }> = [];
  const frameDeadlineMs = 16.67;

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---') || /Flags,IntendedVsync/u.test(trimmed)) {
      continue;
    }

    const columns = trimmed.split(',').map((column) => Number(column.trim()));
    const flags = columns[0];
    const intendedVsync = columns[1];
    const frameCompleted = columns[13];
    if (
      typeof flags !== 'number' ||
      typeof intendedVsync !== 'number' ||
      typeof frameCompleted !== 'number' ||
      !Number.isFinite(flags) ||
      !Number.isFinite(intendedVsync) ||
      !Number.isFinite(frameCompleted) ||
      frameCompleted <= intendedVsync
    ) {
      continue;
    }

    frames.push({
      durationMs: (frameCompleted - intendedVsync) / 1_000_000,
      flags,
    });
  }

  if (frames.length === 0) {
    return {};
  }

  const sortedDurations = frames.map((frame) => frame.durationMs).sort((left, right) => left - right);
  const missedDeadlineFrameCount = frames.filter((frame) => frame.durationMs > frameDeadlineMs).length;
  const flaggedFrameCount = frames.filter((frame) => frame.flags !== 0).length;
  const summary: JsonRecord = {
    flaggedFrameCount,
    frameCount: frames.length,
    jankyFrameCount: frames.filter((frame) => frame.flags !== 0 || frame.durationMs > frameDeadlineMs).length,
    missedDeadlineFrameCount,
  };
  setDefined(summary, 'p50FrameMs', percentile(sortedDurations, 50));
  setDefined(summary, 'p90FrameMs', percentile(sortedDurations, 90));
  setDefined(summary, 'p95FrameMs', percentile(sortedDurations, 95));
  setDefined(summary, 'p99FrameMs', percentile(sortedDurations, 99));
  setDefined(summary, 'worstFrameMs', sortedDurations[sortedDurations.length - 1]);
  return summary as AndroidFramestatsSummary;
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
 * Parses common xctrace or Instruments exported summary text into iOS native-performance fields.
 *
 * Capture/export ownership stays with the provider; this helper only normalizes
 * scalar fields that are already present in a bounded summary.
 *
 * @param {string} text
 * @returns {IosNativePerformanceTextSummary}
 */
function parseIosXctraceSummaryText(text: string): IosNativePerformanceTextSummary {
  const summary: JsonRecord = {};

  setDefined(summary, 'traceId', firstStringMatch(text, [
    /\btrace(?:Id| ID)?\s*[:=]\s*([A-Za-z0-9._:-]+)/iu,
    /\brun(?:Id| ID)?\s*[:=]\s*([A-Za-z0-9._:-]+)/iu,
  ]));
  setDefined(summary, 'durationMs', firstDurationMsMatch(text, [
    /\bduration\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
    /\btrace window\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'windowStartMs', firstDurationMsMatch(text, [
    /\bwindow start\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'windowEndMs', firstDurationMsMatch(text, [
    /\bwindow end\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'cpuMs', firstDurationMsMatch(text, [
    /\bcpu(?: time)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'mainThreadCpuMs', firstDurationMsMatch(text, [
    /\bmain thread cpu(?: time)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'threadSchedulingDelayMs', firstDurationMsMatch(text, [
    /\bthread scheduling delay\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
    /\bscheduling delay\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'frameCount', firstNumberMatch(text, [
    /\bframes?(?: count)?\s*[:=]\s*([\d,.]+)/iu,
  ]));
  setDefined(summary, 'jankyFrameCount', firstNumberMatch(text, [
    /\bjanky frames?\s*[:=]\s*([\d,.]+)/iu,
  ]));
  setDefined(summary, 'hitchCount', firstNumberMatch(text, [
    /\bhitches?\s*[:=]\s*([\d,.]+)/iu,
    /\bhitch count\s*[:=]\s*([\d,.]+)/iu,
  ]));
  setDefined(summary, 'averageFrameMs', firstDurationMsMatch(text, [
    /\baverage frame(?: time)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'p95FrameMs', firstDurationMsMatch(text, [
    /\bp95(?: frame)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
    /\b95th percentile(?: frame)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'worstFrameMs', firstDurationMsMatch(text, [
    /\bworst frame(?: time)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'residentSizeBytes', firstBytesMatch(text, [
    /\bresident(?: size)?\s*[:=]\s*([\d,.]+)\s*(bytes?|kb|kib|mb|mib|gb|gib)\b/iu,
  ]));
  setDefined(summary, 'physicalFootprintBytes', firstBytesMatch(text, [
    /\bphysical footprint\s*[:=]\s*([\d,.]+)\s*(bytes?|kb|kib|mb|mib|gb|gib)\b/iu,
  ]));
  setDefined(summary, 'memoryPeakBytes', firstBytesMatch(text, [
    /\b(?:peak memory|memory peak)\s*[:=]\s*([\d,.]+)\s*(bytes?|kb|kib|mb|mib|gb|gib)\b/iu,
  ]));

  return summary as IosNativePerformanceTextSummary;
}

/**
 * Parses common MetricKit payload summaries into iOS native-performance fields.
 *
 * @param {string} text
 * @returns {IosNativePerformanceTextSummary}
 */
function parseIosMetricKitSummaryText(text: string): IosNativePerformanceTextSummary {
  const summary: JsonRecord = {};

  setDefined(summary, 'hitchCount', firstNumberMatch(text, [
    /\bhitches?\s*[:=]\s*([\d,.]+)/iu,
    /\bscroll hitch(?:es)?\s*[:=]\s*([\d,.]+)/iu,
  ]));
  setDefined(summary, 'jankyFrameCount', firstNumberMatch(text, [
    /\bjanky frames?\s*[:=]\s*([\d,.]+)/iu,
    /\bdropped frames?\s*[:=]\s*([\d,.]+)/iu,
  ]));
  setDefined(summary, 'p95FrameMs', firstDurationMsMatch(text, [
    /\bp95(?: frame)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
    /\b95th percentile(?: frame)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'averageFrameMs', firstDurationMsMatch(text, [
    /\baverage frame(?: time)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'cpuMs', firstDurationMsMatch(text, [
    /\bcpu(?: time)?\s*[:=]\s*([\d,.]+)\s*(ms|s|sec|secs|seconds?)\b/iu,
  ]));
  setDefined(summary, 'memoryPeakBytes', firstBytesMatch(text, [
    /\b(?:peak memory|memory peak)\s*[:=]\s*([\d,.]+)\s*(bytes?|kb|kib|mb|mib|gb|gib)\b/iu,
  ]));
  setDefined(summary, 'physicalFootprintBytes', firstBytesMatch(text, [
    /\bphysical footprint\s*[:=]\s*([\d,.]+)\s*(bytes?|kb|kib|mb|mib|gb|gib)\b/iu,
  ]));
  setDefined(summary, 'thermalState', firstStringMatch(text, [
    /\bthermal state\s*[:=]\s*([A-Za-z0-9._:-]+)/iu,
  ]));
  setDefined(summary, 'batteryImpact', firstNumberMatch(text, [
    /\bbattery impact\s*[:=]\s*([\d,.]+)/iu,
  ]));

  return summary as IosNativePerformanceTextSummary;
}

/**
 * Normalizes project-local Android trace-processor summary fields into ASL evidence surfaces.
 *
 * @param {AndroidTraceProcessorSummaryInput | undefined} input
 * @returns {AndroidTraceProcessorSummary}
 */
function normalizeAndroidTraceProcessorSummary(input: AndroidTraceProcessorSummaryInput | undefined): AndroidTraceProcessorSummary {
  if (!input || typeof input !== 'object') {
    return {
      frames: {},
      metrics: {},
      traces: {},
    };
  }

  const source = input as JsonRecord;
  const frames: JsonRecord = {};
  const metrics: JsonRecord = {};
  const traces: JsonRecord = {};

  setDefined(frames, 'totalFrameCount', readFiniteNumber(source, 'frameCount'));
  setDefined(frames, 'expectedFrameCount', readFiniteNumber(source, 'expectedFrameCount'));
  setDefined(frames, 'jankyFrameCount', readFiniteNumber(source, 'jankyFrameCount'));
  setDefined(frames, 'missedDeadlineFrameCount', readFiniteNumber(source, 'missedDeadlineFrameCount'));
  setDefined(frames, 'frameDeadlineMissed', readFiniteNumber(source, 'frameDeadlineMissed'));
  setDefined(frames, 'slowFrameCount', readFiniteNumber(source, 'slowFrameCount'));
  setDefined(frames, 'worstFrameMs', readFiniteNumber(source, 'worstFrameMs'));
  setDefined(frames, 'p50FrameMs', readFiniteNumber(source, 'p50FrameMs'));
  setDefined(frames, 'p90FrameMs', readFiniteNumber(source, 'p90FrameMs'));
  setDefined(frames, 'p95FrameMs', readFiniteNumber(source, 'p95FrameMs'));
  setDefined(frames, 'p99FrameMs', readFiniteNumber(source, 'p99FrameMs'));

  setDefined(metrics, 'cpuMs', readFiniteNumber(source, 'cpuMs'));
  setDefined(metrics, 'mainThreadCpuMs', readFiniteNumber(source, 'mainThreadCpuMs'));
  setDefined(metrics, 'renderThreadCpuMs', readFiniteNumber(source, 'renderThreadCpuMs'));
  setDefined(metrics, 'threadSchedulingDelayMs', readFiniteNumber(source, 'threadSchedulingDelayMs'));

  setDefined(traces, 'traceId', readNonEmptyString(source, 'traceId'));
  setDefined(traces, 'durationMs', readFiniteNumber(source, 'durationMs'));
  setDefined(traces, 'windowStartMs', readFiniteNumber(source, 'windowStartMs'));
  setDefined(traces, 'windowEndMs', readFiniteNumber(source, 'windowEndMs'));

  return {
    frames,
    metrics,
    traces,
  };
}

/**
 * Resolves the most specific native-performance evidence kind for Android text inputs.
 *
 * @param {{framestats: Record<string, unknown>, frames: Record<string, unknown>, memory: Record<string, unknown>, traceProcessor: AndroidTraceProcessorSummary}} options
 * @returns {'framestats' | 'gfxinfo' | 'meminfo' | 'mixed' | 'trace-processor' | 'unknown'}
 */
function resolveAndroidEvidenceKind({
  framestats,
  frames,
  memory,
  traceProcessor,
}: {
  framestats: JsonRecord;
  frames: JsonRecord;
  memory: JsonRecord;
  traceProcessor: AndroidTraceProcessorSummary;
}): 'framestats' | 'gfxinfo' | 'meminfo' | 'mixed' | 'trace-processor' | 'unknown' {
  const hasFramestats = hasFields(framestats);
  const hasFrames = hasFields(frames);
  const hasMemory = hasFields(memory);
  const hasTraceProcessor = hasTraceProcessorSummary(traceProcessor);
  const sourceCount = [hasFramestats, hasFrames, hasMemory, hasTraceProcessor].filter(Boolean).length;
  if (sourceCount > 1) {
    return 'mixed';
  }
  if (hasFramestats) {
    return 'framestats';
  }
  if (hasTraceProcessor) {
    return 'trace-processor';
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
 * @param {{framestats: Record<string, unknown>, frames: Record<string, unknown>, memory: Record<string, unknown>, traceProcessor: AndroidTraceProcessorSummary}} options
 * @returns {string[]}
 */
function buildAndroidDataClasses({
  framestats,
  frames,
  memory,
  traceProcessor,
}: {
  framestats: JsonRecord;
  frames: JsonRecord;
  memory: JsonRecord;
  traceProcessor: AndroidTraceProcessorSummary;
}): string[] {
  const dataClasses = new Set<string>();
  if (hasFields(framestats)) {
    dataClasses.add('frames');
    dataClasses.add('jank');
    dataClasses.add('render');
  }
  if (hasFields(frames)) {
    dataClasses.add('frames');
    dataClasses.add('jank');
    dataClasses.add('render');
  }
  if (hasFields(memory)) {
    dataClasses.add('memory');
  }
  if (hasFields(traceProcessor.frames)) {
    dataClasses.add('frames');
    dataClasses.add('jank');
    dataClasses.add('render');
  }
  if (hasFields(traceProcessor.metrics)) {
    dataClasses.add('cpu');
    dataClasses.add('thread-scheduling');
  }
  if (hasFields(traceProcessor.traces)) {
    dataClasses.add('native-trace');
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
 * Finds the first run-relative attachment path for any native-performance source alias.
 *
 * @param {NativePerformanceAttachment[] | undefined} attachments
 * @param {string[]} kinds
 * @returns {string | undefined}
 */
function findFirstAttachmentPath(attachments: NativePerformanceAttachment[] | undefined, kinds: string[]): string | undefined {
  for (const kind of kinds) {
    const path = findAttachmentPath(attachments, kind);
    if (path) {
      return path;
    }
  }

  return undefined;
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
    dataClasses: source.dataClasses,
  };
  setDefined(artifact, 'tool', source.tool);
  setDefined(artifact, 'path', source.path);
  setDefined(artifact, 'reason', source.reason);
  setDefined(artifact, 'nextAction', source.nextAction);
  return artifact;
}

/**
 * Returns true for a non-empty string.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Copies a provider-owned string list only when it carries values.
 *
 * @param {string[] | undefined} values
 * @returns {string[] | undefined}
 */
function copyStringList(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const copied = values.filter(isNonEmptyString);
  if (copied.length === 0) {
    return undefined;
  }

  return copied;
}

/**
 * Narrows unknown JSON input to an object record.
 *
 * @param {unknown} value
 * @returns {JsonRecord | null}
 */
function readJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

/**
 * Returns true when an evidence path is run-relative and cannot traverse out of the run.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isRunRelativeEvidencePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const normalized = value.trim();
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/u.test(normalized)
  ) {
    return false;
  }

  return !normalized.split(/[\\/]/u).includes('..');
}

/**
 * Resolves a run-relative evidence claim through the caller-owned artifact boundary.
 *
 * @param {unknown} value
 * @param {NativePerformanceComparisonContext} context
 * @returns {boolean}
 */
function isDurableEvidencePath(
  value: unknown,
  context: Partial<NativePerformanceComparisonContext>,
): boolean {
  if (!isRunRelativeEvidencePath(value) || typeof context.evidencePathExists !== 'function') {
    return false;
  }

  try {
    return context.evidencePathExists(value);
  } catch {
    return false;
  }
}

/**
 * Returns true for a real capture timestamp rather than the helper's epoch placeholder.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasCaptureTimestamp(value: unknown): boolean {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > 0;
}

/**
 * Returns true when the evidence envelope contains structured native-performance output.
 *
 * @param {JsonRecord} evidence
 * @returns {boolean}
 */
function hasStructuredNativePerformanceContent(evidence: JsonRecord): boolean {
  for (const key of ['frames', 'memory', 'metrics']) {
    const content = readJsonRecord(evidence[key]);
    if (content && hasFields(content)) {
      return true;
    }
  }

  return ['events', 'traces'].some((key) => Array.isArray(evidence[key]) && evidence[key].length > 0);
}

/**
 * Returns true when the envelope contains at least one finite native-performance sample.
 * Capture-window metadata alone is not a performance sample.
 *
 * @param {JsonRecord} evidence
 * @returns {boolean}
 */
function hasMeasurableNativePerformanceSamples(evidence: JsonRecord): boolean {
  const hasFiniteNativePerformanceMetric = (value: unknown): boolean => {
    const record = readJsonRecord(value);
    if (!record) {
      return false;
    }

    return Object.entries(record).some(
      ([key, entry]) => (
        NATIVE_PERFORMANCE_SAMPLE_KEYS.has(key) &&
        typeof entry === 'number' &&
        Number.isFinite(entry)
      ),
    );
  };

  if (['frames', 'memory', 'metrics'].some((key) => hasFiniteNativePerformanceMetric(evidence[key]))) {
    return true;
  }

  return Array.isArray(evidence.events) && evidence.events.some(
    (event) => hasFiniteNativePerformanceMetric(event),
  );
}

/**
 * Returns true when at least one source is captured and backed by durable or structured output.
 *
 * @param {JsonRecord} evidence
 * @param {NativePerformanceComparisonContext} context
 * @returns {boolean}
 */
function hasCapturedNativePerformanceSource(
  evidence: JsonRecord,
  context: Partial<NativePerformanceComparisonContext>,
): boolean {
  if (
    !isDurableEvidencePath(context.artifactPath, context) ||
    !Array.isArray(evidence.diagnosticSources)
  ) {
    return false;
  }

  const hasDurableStructuredContent = hasStructuredNativePerformanceContent(evidence);
  return evidence.diagnosticSources.some((source) => {
    const sourceRecord = readJsonRecord(source);
    return sourceRecord?.status === 'captured' &&
      (isDurableEvidencePath(sourceRecord.path, context) || hasDurableStructuredContent);
  });
}

/**
 * Returns true when the envelope identity matches every caller-owned run expectation.
 *
 * @param {JsonRecord} evidence
 * @param {NativePerformanceComparisonContext} context
 * @returns {boolean}
 */
function hasExpectedNativePerformanceIdentity(
  evidence: JsonRecord,
  context: Partial<NativePerformanceComparisonContext>,
): boolean {
  return (context.expectedPlatform === 'android' || context.expectedPlatform === 'ios') &&
    isNonEmptyString(context.expectedProviderId) &&
    isNonEmptyString(context.expectedRunId) &&
    isNonEmptyString(context.expectedScenarioId) &&
    evidence.platform === context.expectedPlatform &&
    evidence.providerId === context.expectedProviderId &&
    evidence.runId === context.expectedRunId &&
    evidence.scenarioId === context.expectedScenarioId;
}

/**
 * Allows small clock rounding while rejecting contradictory duration metadata.
 *
 * @param {number} durationMs
 * @param {number} elapsedMs
 * @returns {boolean}
 */
function hasConsistentDuration(durationMs: number, elapsedMs: number): boolean {
  const toleranceMs = Math.max(1, elapsedMs * 0.01);
  return Math.abs(durationMs - elapsedMs) <= toleranceMs;
}

/**
 * Returns true when lifecycle metadata describes a positive bounded wall-clock window.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasBoundedLifecycleWindow(value: unknown): boolean {
  const lifecycle = readJsonRecord(value);
  if (!lifecycle || !isNonEmptyString(lifecycle.startedAt) || !isNonEmptyString(lifecycle.endedAt)) {
    return false;
  }

  const startedAt = Date.parse(lifecycle.startedAt);
  const endedAt = Date.parse(lifecycle.endedAt);
  return Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) &&
    endedAt > startedAt &&
    typeof lifecycle.durationMs === 'number' &&
    Number.isFinite(lifecycle.durationMs) &&
    lifecycle.durationMs > 0 &&
    hasConsistentDuration(lifecycle.durationMs, endedAt - startedAt);
}

/**
 * Returns true when a structured trace carries a positive bounded capture window.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasBoundedTraceWindow(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }

  return value.some((trace) => {
    const traceRecord = readJsonRecord(trace);
    if (!traceRecord) {
      return false;
    }

    const windowStartMs = traceRecord.windowStartMs;
    const windowEndMs = traceRecord.windowEndMs;
    const durationMs = traceRecord.durationMs;
    return typeof windowStartMs === 'number' &&
      Number.isFinite(windowStartMs) &&
      typeof windowEndMs === 'number' &&
      Number.isFinite(windowEndMs) &&
      windowEndMs > windowStartMs &&
      typeof durationMs === 'number' &&
      Number.isFinite(durationMs) &&
      durationMs > 0 &&
      hasConsistentDuration(durationMs, windowEndMs - windowStartMs);
  });
}

/**
 * Returns true when the provider preserved observed target proof matching the declared binding.
 *
 * @param {unknown} value
 * @param {unknown} platform
 * @param {NativePerformanceComparisonContext} context
 * @returns {boolean}
 */
function hasObservedTargetBinding(
  value: unknown,
  platform: unknown,
  context: Partial<NativePerformanceComparisonContext>,
): boolean {
  const targetBinding = readJsonRecord(value);
  if (
    (platform !== 'android' && platform !== 'ios') ||
    targetBinding?.status !== 'verified' ||
    !isNonEmptyString(targetBinding.appId) ||
    !isNonEmptyString(targetBinding.deviceId) ||
    !isNonEmptyString(targetBinding.source) ||
    !Array.isArray(targetBinding.candidateTargets)
  ) {
    return false;
  }

  let hasMatchingObservedTarget = false;
  for (const candidate of targetBinding.candidateTargets) {
    const candidateRecord = readJsonRecord(candidate);
    if (!candidateRecord) {
      return false;
    }

    if (
      candidateRecord.bindingStatus === 'conflicting' ||
      candidateRecord.bindingStatus === 'unknown' ||
      candidateRecord.bindingStatus === 'unverified'
    ) {
      return false;
    }

    const candidateIdentityMatches =
      (candidateRecord.platform === undefined || candidateRecord.platform === platform) &&
      (candidateRecord.appId === undefined || candidateRecord.appId === targetBinding.appId) &&
      (candidateRecord.deviceId === undefined || candidateRecord.deviceId === targetBinding.deviceId);
    if (!candidateIdentityMatches) {
      return false;
    }

    if (candidateRecord.bindingStatus === 'observed') {
      if (
        candidateRecord.platform !== platform ||
        candidateRecord.appId !== targetBinding.appId ||
        candidateRecord.deviceId !== targetBinding.deviceId ||
        !isDurableEvidencePath(candidateRecord.evidencePath, context)
      ) {
        return false;
      }
      hasMatchingObservedTarget = true;
    }
  }

  return hasMatchingObservedTarget;
}

/**
 * Classifies whether native-performance evidence can support comparison claims.
 * Structurally valid evidence that lacks semantic proof remains diagnostic-only.
 *
 * @param {unknown} value
 * @param {NativePerformanceComparisonContext} context
 * @returns {NativePerformanceComparisonReadiness}
 */
function classifyNativePerformanceComparisonReadiness(
  value: unknown,
  context: NativePerformanceComparisonContext | undefined,
): NativePerformanceComparisonReadiness {
  const evidence = readJsonRecord(value) ?? {};
  const comparisonContext: Partial<NativePerformanceComparisonContext> = context ?? {};
  const missingEvidence: NativePerformanceComparisonEvidenceGap[] = [];
  const claimSufficiency = readJsonRecord(evidence.claimSufficiency);
  const comparability = readJsonRecord(evidence.comparability);

  if (evidence.completenessStatus !== 'complete') {
    missingEvidence.push('complete-evidence');
  }
  if (!hasExpectedNativePerformanceIdentity(evidence, comparisonContext)) {
    missingEvidence.push('artifact-identity');
  }
  if (
    claimSufficiency?.status !== 'sufficient-for-comparison' ||
    !Array.isArray(claimSufficiency.supportingEvidence) ||
    !claimSufficiency.supportingEvidence.some(isNonEmptyString)
  ) {
    missingEvidence.push('comparison-claim');
  }
  if (comparability?.status !== 'comparable' || !isNonEmptyString(comparability.policy)) {
    missingEvidence.push('comparable-policy');
  }
  if (!hasCaptureTimestamp(evidence.capturedAt)) {
    missingEvidence.push('capture-timestamp');
  }
  if (!isNonEmptyString(evidence.clockDomain)) {
    missingEvidence.push('clock-domain');
  }
  if (!hasCapturedNativePerformanceSource(evidence, comparisonContext)) {
    missingEvidence.push('captured-source');
  }
  if (!hasMeasurableNativePerformanceSamples(evidence)) {
    missingEvidence.push('measurable-samples');
  }
  if (!hasBoundedLifecycleWindow(evidence.lifecycle) && !hasBoundedTraceWindow(evidence.traces)) {
    missingEvidence.push('bounded-capture-window');
  }
  if (!hasObservedTargetBinding(evidence.targetBinding, evidence.platform, comparisonContext)) {
    missingEvidence.push('observed-target-binding');
  }

  if (missingEvidence.length > 0) {
    return {
      missingEvidence,
      status: 'diagnostic-only',
    };
  }

  return {
    missingEvidence: [],
    status: 'comparison-ready',
  };
}

/**
 * Applies an explicit provider claim-sufficiency classification to the helper default.
 *
 * @param {Record<string, unknown>} defaultClaimSufficiency
 * @param {NativePerformanceClaimSufficiencyOverride | undefined} override
 * @returns {Record<string, unknown>}
 */
function applyClaimSufficiencyOverride(
  defaultClaimSufficiency: JsonRecord,
  override: NativePerformanceClaimSufficiencyOverride | undefined,
): JsonRecord {
  if (!override) {
    return defaultClaimSufficiency;
  }

  const claimSufficiency: JsonRecord = {
    ...defaultClaimSufficiency,
    status: override.status,
  };
  setDefined(claimSufficiency, 'claim', override.claim);
  setDefined(claimSufficiency, 'reason', override.reason);
  setDefined(claimSufficiency, 'nextAction', override.nextAction);
  setDefined(claimSufficiency, 'missingEvidence', copyStringList(override.missingEvidence));
  setDefined(claimSufficiency, 'supportingEvidence', copyStringList(override.supportingEvidence));
  return claimSufficiency;
}

/**
 * Applies provider-owned comparability metadata to the helper default.
 *
 * @param {Record<string, unknown>} defaultComparability
 * @param {NativePerformanceComparabilityOverride | undefined} override
 * @returns {Record<string, unknown>}
 */
function applyComparabilityOverride(
  defaultComparability: JsonRecord,
  override: NativePerformanceComparabilityOverride | undefined,
): JsonRecord {
  if (!override) {
    return defaultComparability;
  }

  const comparability: JsonRecord = {
    ...defaultComparability,
    status: override.status,
  };
  setDefined(comparability, 'reason', override.reason);
  setDefined(comparability, 'policy', override.policy);
  return comparability;
}

/**
 * Applies provider-owned target binding metadata to the helper default.
 *
 * @param {Record<string, unknown>} defaultTargetBinding
 * @param {NativePerformanceTargetBindingOverride | undefined} override
 * @returns {Record<string, unknown>}
 */
function applyTargetBindingOverride(
  defaultTargetBinding: JsonRecord,
  override: NativePerformanceTargetBindingOverride | undefined,
): JsonRecord {
  if (!override) {
    return defaultTargetBinding;
  }

  const targetBinding: JsonRecord = {
    ...defaultTargetBinding,
    status: override.status,
  };
  setDefined(targetBinding, 'appId', override.appId);
  setDefined(targetBinding, 'bundleId', override.bundleId);
  setDefined(targetBinding, 'deviceId', override.deviceId);
  setDefined(targetBinding, 'source', override.source);
  if (isNonEmptyString(override.reason)) {
    targetBinding.reason = override.reason;
  } else if (override.status !== defaultTargetBinding.status) {
    delete targetBinding.reason;
  }
  if (Array.isArray(override.candidateTargets) && override.candidateTargets.length > 0) {
    targetBinding.candidateTargets = override.candidateTargets.map((candidate) => ({ ...candidate }));
  }
  return targetBinding;
}

/**
 * Merges provider-owned native source status overrides into the generated source inventory.
 *
 * @param {Record<string, unknown>[]} sources
 * @param {NativePerformanceDiagnosticSourceOverride[] | undefined} overrides
 * @returns {Record<string, unknown>[]}
 */
function applyDiagnosticSourceOverrides(
  sources: JsonRecord[],
  overrides: NativePerformanceDiagnosticSourceOverride[] | undefined,
): JsonRecord[] {
  if (!overrides || overrides.length === 0) {
    return sources;
  }

  const sourceMap = new Map<string, JsonRecord>();
  const sourceOrder: string[] = [];
  for (const source of sources) {
    const sourceId = source.sourceId;
    if (!isNonEmptyString(sourceId) || sourceMap.has(sourceId)) {
      continue;
    }
    sourceMap.set(sourceId, { ...source });
    sourceOrder.push(sourceId);
  }

  for (const override of overrides) {
    const sourceId = override.sourceId;
    const existingSource = sourceMap.get(sourceId);
    const mergedSource: JsonRecord = existingSource ? { ...existingSource } : { sourceId };
    mergedSource.status = override.status;

    if (Array.isArray(override.dataClasses) && override.dataClasses.length > 0) {
      mergedSource.dataClasses = override.dataClasses;
    }
    if (override.tool) {
      mergedSource.tool = override.tool;
    }
    if (isNonEmptyString(override.path)) {
      mergedSource.path = override.path;
    }
    if (isNonEmptyString(override.reason)) {
      mergedSource.reason = override.reason;
    }
    if (isNonEmptyString(override.nextAction)) {
      mergedSource.nextAction = override.nextAction;
    }

    if (!sourceMap.has(sourceId)) {
      sourceOrder.push(sourceId);
    }
    sourceMap.set(sourceId, mergedSource);
  }

  return sourceOrder.map((sourceId) => sourceMap.get(sourceId)).filter((source): source is JsonRecord => Boolean(source));
}

/**
 * Builds the Android native-performance source inventory, marking parsed surfaces as captured.
 *
 * @param {{attachments?: NativePerformanceAttachment[], frames: Record<string, unknown>, memory: Record<string, unknown>}} options
 * @returns {Record<string, unknown>[]}
 */
function buildAndroidDiagnosticSources({
  attachments,
  diagnosticSources,
  framestats,
  frames,
  memory,
  traceProcessor,
}: {
  attachments: NativePerformanceAttachment[] | undefined;
  diagnosticSources: NativePerformanceDiagnosticSourceOverride[] | undefined;
  framestats: JsonRecord;
  frames: JsonRecord;
  memory: JsonRecord;
  traceProcessor: AndroidTraceProcessorSummary;
}): JsonRecord[] {
  const framestatsCaptured = hasFields(framestats);
  const gfxinfoCaptured = hasFields(frames);
  const meminfoCaptured = hasFields(memory);
  const traceProcessorCaptured = hasTraceProcessorSummary(traceProcessor);
  const perfettoPath = findFirstAttachmentPath(attachments, ['raw-perfetto', 'perfetto-trace', 'raw-native-trace']);
  const traceProcessorPath = findFirstAttachmentPath(attachments, ['trace-processor-summary', 'raw-trace-processor']);
  const sources = [
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
      nextAction: framestatsCaptured
        ? 'Use the parsed framestats summary for diagnosis; capture comparable frame evidence before release claims.'
        : 'Capture Android framestats when frame deadline or per-frame timing evidence is needed.',
      path: findAttachmentPath(attachments, 'raw-framestats'),
      reason: framestatsCaptured
        ? 'Parsed Android framestats frame timing rows were captured.'
        : 'No Android framestats rows were parsed.',
      sourceId: 'framestats',
      status: framestatsCaptured ? 'captured' : 'unverified',
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
      nextAction: perfettoPath
        ? 'Use the raw Perfetto trace for diagnosis; attach a structured trace-processor summary before claim comparisons.'
        : 'Capture a bounded Perfetto trace and attach the raw trace plus a structured summary.',
      path: perfettoPath,
      reason: perfettoPath
        ? 'A raw Perfetto/native trace attachment was supplied.'
        : 'No Perfetto trace was supplied to this Android summary builder.',
      sourceId: 'perfetto',
      status: perfettoPath ? 'captured' : 'unverified',
      tool: {
        name: 'perfetto',
      },
    }),
    buildAndroidDiagnosticSource({
      dataClasses: ['frames', 'jank', 'cpu', 'thread-scheduling'],
      nextAction: traceProcessorCaptured
        ? 'Use the trace-processor summary for diagnosis; require a complete comparable trace lane before release claims.'
        : 'Summarize Perfetto trace data with trace-processor SQL before making comparable claims.',
      path: traceProcessorPath,
      reason: traceProcessorCaptured
        ? 'Structured trace-processor summary fields were captured.'
        : 'No trace-processor summary was supplied to this Android summary builder.',
      sourceId: 'trace-processor',
      status: traceProcessorCaptured ? 'captured' : 'unverified',
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
  return applyDiagnosticSourceOverrides(sources, diagnosticSources);
}

/**
 * Describes the concrete Android native diagnostic commands reflected by the evidence.
 *
 * @param {string[]} commands
 * @returns {string}
 */
function buildAndroidToolCommand(commands: string[]): string {
  if (commands.length === 0) {
    return 'android native diagnostics';
  }

  return commands.join(' / ');
}

/**
 * Builds provider-owned Android target binding metadata.
 *
 * @param {AndroidNativePerformanceEvidenceInput} input
 * @returns {Record<string, unknown>}
 */
function buildAndroidTargetBinding(input: AndroidNativePerformanceEvidenceInput): JsonRecord {
  const targetBinding: JsonRecord = {
    status: 'unverified',
  };
  if (input.appId && input.deviceId) {
    targetBinding.reason = 'Provider supplied Android package and device ids, but did not attach observed matching target proof.';
  } else {
    targetBinding.reason = 'Provider did not supply both Android package id and device id.';
  }
  setDefined(targetBinding, 'appId', input.appId);
  setDefined(targetBinding, 'deviceId', input.deviceId);
  targetBinding.source = 'provider';
  return applyTargetBindingOverride(targetBinding, input.targetBinding);
}

/**
 * Builds the default Android comparability classification.
 *
 * @param {NativePerformanceComparabilityOverride | undefined} override
 * @returns {Record<string, unknown>}
 */
function buildAndroidComparability(override: NativePerformanceComparabilityOverride | undefined): JsonRecord {
  return applyComparabilityOverride(
    {
      status: 'diagnostic-only',
      reason: 'Android native diagnostics were normalized for investigation, not collected under a comparable ASL native-performance baseline.',
      policy: 'Use this evidence to classify native/render/memory pressure; require a complete comparable lane before release performance claims.',
    },
    override,
  );
}

/**
 * Builds the claim gate for Android native-performance evidence.
 *
 * @param {string[]} supportingEvidence
 * @param {NativePerformanceClaimSufficiencyOverride | undefined} override
 * @returns {Record<string, unknown>}
 */
function buildAndroidClaimSufficiency(
  supportingEvidence: string[],
  override: NativePerformanceClaimSufficiencyOverride | undefined,
): JsonRecord {
  const claimSufficiency: JsonRecord = {
    claim: 'android-native-performance',
    nextAction: 'Use provider-captured raw artifacts and rerun a comparable native-performance lane before making release claims.',
  };
  if (supportingEvidence.length > 0) {
    claimSufficiency.status = 'sufficient-for-diagnosis';
    claimSufficiency.reason = 'Parsed Android native diagnostics are useful for diagnosis but are not budget-comparable.';
    claimSufficiency.supportingEvidence = supportingEvidence;
    return applyClaimSufficiencyOverride(claimSufficiency, override);
  }

  claimSufficiency.status = 'insufficient-for-claim';
  claimSufficiency.reason = 'No Android native diagnostic summary fields were parsed.';
  claimSufficiency.missingEvidence = ['gfxinfo or meminfo summary fields'];
  return applyClaimSufficiencyOverride(claimSufficiency, override);
}

/**
 * Summarizes Android native-performance evidence without making a product claim.
 *
 * @param {string[]} supportingEvidence
 * @returns {string}
 */
function summarizeAndroidNativePerformanceEvidence(supportingEvidence: string[]): string {
  if (supportingEvidence.length === 0) {
    return 'No Android native-performance summary fields were parsed from provider input.';
  }

  return `Normalized ${supportingEvidence.join(' and ')} as diagnostic-only native-performance evidence.`;
}

/**
 * Normalizes one provider-owned iOS native-performance summary into ASL evidence surfaces.
 *
 * @param {IosNativePerformanceSummaryInput | undefined} input
 * @returns {IosNativePerformanceSummary}
 */
function normalizeIosNativePerformanceSummary(input: IosNativePerformanceSummaryInput | undefined): IosNativePerformanceSummary {
  if (!input || typeof input !== 'object') {
    return {
      frames: {},
      memory: {},
      metrics: {},
      traces: {},
    };
  }

  const source = input as JsonRecord;
  const frames: JsonRecord = {};
  const memory: JsonRecord = {};
  const metrics: JsonRecord = {};
  const traces: JsonRecord = {};

  setDefined(frames, 'totalFrameCount', readFiniteNumber(source, 'frameCount'));
  setDefined(frames, 'jankyFrameCount', readFiniteNumber(source, 'jankyFrameCount'));
  setDefined(frames, 'hitchCount', readFiniteNumber(source, 'hitchCount'));
  setDefined(frames, 'averageFrameMs', readFiniteNumber(source, 'averageFrameMs'));
  setDefined(frames, 'worstFrameMs', readFiniteNumber(source, 'worstFrameMs'));
  setDefined(frames, 'p50FrameMs', readFiniteNumber(source, 'p50FrameMs'));
  setDefined(frames, 'p90FrameMs', readFiniteNumber(source, 'p90FrameMs'));
  setDefined(frames, 'p95FrameMs', readFiniteNumber(source, 'p95FrameMs'));
  setDefined(frames, 'p99FrameMs', readFiniteNumber(source, 'p99FrameMs'));

  setDefined(memory, 'residentSizeBytes', readFiniteNumber(source, 'residentSizeBytes'));
  setDefined(memory, 'physicalFootprintBytes', readFiniteNumber(source, 'physicalFootprintBytes'));
  setDefined(memory, 'memoryPeakBytes', readFiniteNumber(source, 'memoryPeakBytes'));

  setDefined(metrics, 'cpuMs', readFiniteNumber(source, 'cpuMs'));
  setDefined(metrics, 'mainThreadCpuMs', readFiniteNumber(source, 'mainThreadCpuMs'));
  setDefined(metrics, 'threadSchedulingDelayMs', readFiniteNumber(source, 'threadSchedulingDelayMs'));
  setDefined(metrics, 'batteryImpact', readFiniteNumber(source, 'batteryImpact'));
  setDefined(metrics, 'thermalState', readNonEmptyString(source, 'thermalState'));

  setDefined(traces, 'traceId', readNonEmptyString(source, 'traceId'));
  setDefined(traces, 'durationMs', readFiniteNumber(source, 'durationMs'));
  setDefined(traces, 'windowStartMs', readFiniteNumber(source, 'windowStartMs'));
  setDefined(traces, 'windowEndMs', readFiniteNumber(source, 'windowEndMs'));

  return {
    frames,
    memory,
    metrics,
    traces,
  };
}

/**
 * Returns true when a normalized iOS summary carries any evidence.
 *
 * @param {IosNativePerformanceSummary} summary
 * @returns {boolean}
 */
function hasIosNativePerformanceSummary(summary: IosNativePerformanceSummary): boolean {
  return hasFields(summary.frames) || hasFields(summary.memory) || hasFields(summary.metrics) || hasFields(summary.traces);
}

/**
 * Shallowly merges normalized iOS source summaries into one native-performance surface set.
 *
 * @param {IosNativePerformanceSourceSummary[]} summaries
 * @returns {IosNativePerformanceSummary}
 */
function mergeIosNativePerformanceSummaries(summaries: IosNativePerformanceSourceSummary[]): IosNativePerformanceSummary {
  const merged: IosNativePerformanceSummary = {
    frames: {},
    memory: {},
    metrics: {},
    traces: {},
  };

  for (const entry of summaries) {
    Object.assign(merged.frames, entry.summary.frames);
    Object.assign(merged.memory, entry.summary.memory);
    Object.assign(merged.metrics, entry.summary.metrics);
    Object.assign(merged.traces, entry.summary.traces);
  }

  return merged;
}

/**
 * Builds the provider-owned iOS summary inventory in stable source order.
 *
 * @param {IosNativePerformanceEvidenceInput} input
 * @returns {IosNativePerformanceSourceSummary[]}
 */
function buildIosSourceSummaries(input: IosNativePerformanceEvidenceInput): IosNativePerformanceSourceSummary[] {
  return [
    {
      sourceId: 'instruments',
      summary: normalizeIosNativePerformanceSummary(input.instrumentsSummary),
    },
    {
      sourceId: 'xctrace',
      summary: normalizeIosNativePerformanceSummary(input.xctraceSummary),
    },
    {
      sourceId: 'metrickit',
      summary: normalizeIosNativePerformanceSummary(input.metricKitSummary),
    },
    {
      sourceId: 'simctl',
      summary: normalizeIosNativePerformanceSummary(input.simctlSummary),
    },
  ];
}

/**
 * Builds the iOS native-performance data class vocabulary from normalized summaries.
 *
 * @param {IosNativePerformanceSummary} summary
 * @returns {string[]}
 */
function buildIosDataClasses(summary: IosNativePerformanceSummary): string[] {
  const dataClasses = new Set<string>();
  if (hasFields(summary.frames)) {
    dataClasses.add('frames');
    dataClasses.add('jank');
    dataClasses.add('render');
  }
  if (hasFields(summary.memory)) {
    dataClasses.add('memory');
  }
  if (hasFields(summary.metrics)) {
    if ('cpuMs' in summary.metrics || 'mainThreadCpuMs' in summary.metrics) {
      dataClasses.add('cpu');
    }
    if ('threadSchedulingDelayMs' in summary.metrics) {
      dataClasses.add('thread-scheduling');
    }
    if ('thermalState' in summary.metrics) {
      dataClasses.add('thermal');
    }
    if ('batteryImpact' in summary.metrics) {
      dataClasses.add('battery');
    }
  }
  if (hasFields(summary.traces)) {
    dataClasses.add('native-trace');
  }
  if (dataClasses.size === 0) {
    dataClasses.add('unknown');
  }
  return Array.from(dataClasses);
}

/**
 * Adds raw native trace coverage to iOS data classes without leaving unknown beside known evidence.
 *
 * @param {string[]} dataClasses
 * @param {boolean} nativeTraceCaptured
 * @returns {string[]}
 */
function buildIosDataClassesWithNativeTrace(dataClasses: string[], nativeTraceCaptured: boolean): string[] {
  if (!nativeTraceCaptured) {
    return dataClasses;
  }

  const normalized = new Set(dataClasses.filter((dataClass) => dataClass !== 'unknown'));
  normalized.add('native-trace');
  return Array.from(normalized);
}

/**
 * Resolves the native-performance evidence kind for provider-owned iOS sources.
 *
 * @param {IosNativePerformanceSourceSummary[]} summaries
 * @param {boolean} nativeTraceCaptured
 * @returns {'instruments' | 'metrickit' | 'mixed' | 'native-trace' | 'simctl' | 'unknown'}
 */
function resolveIosEvidenceKind(
  summaries: IosNativePerformanceSourceSummary[],
  nativeTraceCaptured: boolean,
): 'instruments' | 'metrickit' | 'mixed' | 'native-trace' | 'simctl' | 'unknown' {
  const capturedSources: IosNativePerformanceEvidenceSource[] = summaries
    .filter((entry) => hasIosNativePerformanceSummary(entry.summary))
    .map((entry) => entry.sourceId);
  if (nativeTraceCaptured) {
    capturedSources.push('native-trace');
  }
  const uniqueSources = new Set(capturedSources);
  if (uniqueSources.size > 1) {
    return 'mixed';
  }
  const [sourceId] = Array.from(uniqueSources);
  if (sourceId === 'instruments' || sourceId === 'metrickit' || sourceId === 'simctl' || sourceId === 'native-trace') {
    return sourceId;
  }
  if (sourceId === 'xctrace') {
    return 'native-trace';
  }
  return 'unknown';
}

/**
 * Builds the iOS native-performance source inventory.
 *
 * @param {{attachments?: NativePerformanceAttachment[], summaries: IosNativePerformanceSourceSummary[]}} options
 * @returns {Record<string, unknown>[]}
 */
function buildIosDiagnosticSources({
  attachments,
  diagnosticSources,
  summaries,
}: {
  attachments: NativePerformanceAttachment[] | undefined;
  diagnosticSources: NativePerformanceDiagnosticSourceOverride[] | undefined;
  summaries: IosNativePerformanceSourceSummary[];
}): JsonRecord[] {
  const summaryBySource = new Map(summaries.map((entry) => [entry.sourceId, entry.summary]));
  const instrumentsPath = findFirstAttachmentPath(attachments, ['raw-instruments', 'instruments-trace', 'instruments-summary']);
  const xctracePath = findFirstAttachmentPath(attachments, ['raw-xctrace', 'xctrace-export', 'xctrace-summary']);
  const metricKitPath = findFirstAttachmentPath(attachments, ['raw-metrickit', 'metrickit-payload', 'metrickit-summary']);
  const simctlPath = findFirstAttachmentPath(attachments, ['raw-simctl', 'simctl-log', 'simctl-summary']);
  const nativeTracePath = findFirstAttachmentPath(attachments, ['raw-native-trace', 'native-trace']);

  const sources = [
    buildIosDiagnosticSource({
      dataClasses: ['frames', 'jank', 'cpu', 'memory', 'native-trace'],
      nextAction: 'Capture an Instruments trace or exported summary for iOS native-performance evidence.',
      path: instrumentsPath,
      sourceId: 'instruments',
      summary: summaryBySource.get('instruments'),
      toolName: 'Instruments',
    }),
    buildIosDiagnosticSource({
      dataClasses: ['cpu', 'thread-scheduling', 'memory', 'native-trace'],
      nextAction: 'Run a bounded xctrace capture/export and attach raw trace references plus structured metrics.',
      path: xctracePath,
      sourceId: 'xctrace',
      summary: summaryBySource.get('xctrace'),
      toolName: 'xctrace',
    }),
    buildIosDiagnosticSource({
      dataClasses: ['frames', 'jank', 'cpu', 'memory', 'thermal', 'battery'],
      nextAction: 'Ingest MetricKit payloads only when app, build, run identity, and time window are bound.',
      path: metricKitPath,
      sourceId: 'metrickit',
      summary: summaryBySource.get('metrickit'),
      toolName: 'MetricKit',
    }),
    buildIosDiagnosticSource({
      dataClasses: ['render', 'memory', 'cpu'],
      nextAction: 'Use simctl-derived logs or process state as diagnostic evidence, not comparable native performance by itself.',
      path: simctlPath,
      sourceId: 'simctl',
      summary: summaryBySource.get('simctl'),
      toolName: 'xcrun simctl',
    }),
    buildIosDiagnosticSource({
      dataClasses: ['native-trace'],
      nextAction: 'Attach structured native-trace summaries before making performance claims from raw traces.',
      path: nativeTracePath,
      sourceId: 'native-trace',
      summary: undefined,
      toolName: 'iOS native trace',
    }),
  ];
  return applyDiagnosticSourceOverrides(sources, diagnosticSources);
}

/**
 * Builds one iOS native diagnostic source inventory entry.
 *
 * @param {{dataClasses: string[], nextAction: string, path?: string, sourceId: IosNativePerformanceEvidenceSource, summary?: IosNativePerformanceSummary, toolName: string}} source
 * @returns {Record<string, unknown>}
 */
function buildIosDiagnosticSource(source: {
  dataClasses: string[];
  nextAction: string;
  path?: string | undefined;
  sourceId: IosNativePerformanceEvidenceSource;
  summary?: IosNativePerformanceSummary | undefined;
  toolName: string;
}): JsonRecord {
  const summaryCaptured = source.summary ? hasIosNativePerformanceSummary(source.summary) : false;
  const captured = summaryCaptured || Boolean(source.path);
  const reason = captured
    ? `Provider supplied ${source.sourceId} iOS native-performance evidence.`
    : `No ${source.sourceId} iOS native-performance evidence was supplied.`;

  return buildAndroidDiagnosticSource({
    dataClasses: source.dataClasses,
    nextAction: source.nextAction,
    path: source.path,
    reason,
    sourceId: source.sourceId,
    status: captured ? 'captured' : 'unverified',
    tool: {
      name: source.toolName,
    },
  });
}

/**
 * Describes the concrete iOS native diagnostic commands reflected by the evidence.
 *
 * @param {string[]} commands
 * @returns {string}
 */
function buildIosToolCommand(commands: string[]): string {
  if (commands.length === 0) {
    return 'ios native diagnostics';
  }

  return commands.join(' / ');
}

/**
 * Lists the iOS evidence surfaces that can support diagnostic-only claims.
 *
 * @param {IosNativePerformanceSourceSummary[]} summaries
 * @param {string | undefined} nativeTracePath
 * @returns {string[]}
 */
function buildIosSupportingEvidence(summaries: IosNativePerformanceSourceSummary[], nativeTracePath: string | undefined): string[] {
  const supportingEvidence = summaries
    .filter((entry) => hasIosNativePerformanceSummary(entry.summary))
    .map((entry) => `${entry.sourceId} summary`);
  if (nativeTracePath) {
    supportingEvidence.push('native trace attachment');
  }
  return supportingEvidence;
}

/**
 * Lists the concrete iOS diagnostic commands reflected by parsed summaries.
 *
 * @param {IosNativePerformanceSourceSummary[]} summaries
 * @returns {string[]}
 */
function buildIosToolCommands(summaries: IosNativePerformanceSourceSummary[]): string[] {
  return summaries
    .filter((entry) => hasIosNativePerformanceSummary(entry.summary))
    .map((entry) => {
      if (entry.sourceId === 'metrickit') {
        return 'MetricKit';
      }
      if (entry.sourceId === 'simctl') {
        return 'xcrun simctl';
      }
      return entry.sourceId;
    });
}

/**
 * Builds provider-owned iOS target binding metadata.
 *
 * @param {IosNativePerformanceEvidenceInput} input
 * @returns {JsonRecord}
 */
function buildIosTargetBinding(input: IosNativePerformanceEvidenceInput): JsonRecord {
  const targetBinding: JsonRecord = {
    status: 'unverified',
  };
  const appId = input.appId ?? input.bundleId;
  if (appId && input.deviceId) {
    targetBinding.reason = 'Provider supplied iOS bundle and device ids, but did not attach observed matching target proof.';
  } else {
    targetBinding.reason = 'Provider did not supply both iOS bundle id and device id.';
  }
  setDefined(targetBinding, 'appId', appId);
  setDefined(targetBinding, 'bundleId', input.bundleId);
  setDefined(targetBinding, 'deviceId', input.deviceId);
  targetBinding.source = 'provider';
  return applyTargetBindingOverride(targetBinding, input.targetBinding);
}

/**
 * Builds the default iOS comparability classification.
 *
 * @param {NativePerformanceComparabilityOverride | undefined} override
 * @returns {Record<string, unknown>}
 */
function buildIosComparability(override: NativePerformanceComparabilityOverride | undefined): JsonRecord {
  return applyComparabilityOverride(
    {
      status: 'diagnostic-only',
      reason: 'iOS native diagnostics were normalized for investigation, not collected under a comparable ASL native-performance baseline.',
      policy: 'Use this evidence to classify native/render/memory pressure; require a complete comparable lane before release performance claims.',
    },
    override,
  );
}

/**
 * Builds the claim gate for iOS native-performance evidence.
 *
 * @param {string[]} supportingEvidence
 * @param {NativePerformanceClaimSufficiencyOverride | undefined} override
 * @returns {JsonRecord}
 */
function buildIosClaimSufficiency(
  supportingEvidence: string[],
  override: NativePerformanceClaimSufficiencyOverride | undefined,
): JsonRecord {
  const claimSufficiency: JsonRecord = {
    claim: 'ios-native-performance',
    nextAction: 'Use provider-captured raw artifacts and rerun a comparable native-performance lane before making release claims.',
  };
  if (supportingEvidence.length > 0) {
    claimSufficiency.status = 'sufficient-for-diagnosis';
    claimSufficiency.reason = 'iOS native diagnostics are useful for diagnosis but are not budget-comparable.';
    claimSufficiency.supportingEvidence = supportingEvidence;
    return applyClaimSufficiencyOverride(claimSufficiency, override);
  }

  claimSufficiency.status = 'insufficient-for-claim';
  claimSufficiency.reason = 'No iOS native diagnostic summary fields or raw native trace attachments were supplied.';
  claimSufficiency.missingEvidence = ['iOS native diagnostic summary or native trace attachment'];
  return applyClaimSufficiencyOverride(claimSufficiency, override);
}

/**
 * Summarizes iOS native-performance evidence without making a product claim.
 *
 * @param {string[]} supportingEvidence
 * @returns {string}
 */
function summarizeIosNativePerformanceEvidence(supportingEvidence: string[]): string {
  if (supportingEvidence.length === 0) {
    return 'No iOS native-performance summary fields were parsed from provider input.';
  }

  return `Normalized ${supportingEvidence.join(' and ')} as diagnostic-only native-performance evidence.`;
}

/**
 * Builds a product-neutral, schema-valid iOS native-performance evidence envelope.
 *
 * @param {IosNativePerformanceEvidenceInput} input
 * @returns {Record<string, unknown>}
 */
function buildIosNativePerformanceEvidence(input: IosNativePerformanceEvidenceInput): JsonRecord {
  const sourceSummaries = buildIosSourceSummaries(input);
  const summary = mergeIosNativePerformanceSummaries(sourceSummaries);
  const nativeTracePath = findFirstAttachmentPath(input.attachments, ['raw-native-trace', 'native-trace']);
  const diagnosticSources = buildIosDiagnosticSources({
    attachments: input.attachments,
    diagnosticSources: input.diagnosticSources,
    summaries: sourceSummaries,
  });
  const dataClasses = buildIosDataClassesWithNativeTrace(buildIosDataClasses(summary), Boolean(nativeTracePath));
  const supportingEvidence = buildIosSupportingEvidence(sourceSummaries, nativeTracePath);
  const toolCommands = buildIosToolCommands(sourceSummaries);
  const hasDiagnosticEvidence = supportingEvidence.length > 0;

  const evidence: JsonRecord = {
    schemaVersion: '1.0.0',
    providerId: input.providerId,
    platform: 'ios',
    runId: input.runId,
    scenarioId: input.scenarioId,
    tool: {
      name: 'ios-platform-diagnostics',
      command: buildIosToolCommand(toolCommands),
    },
    capturedAt: input.capturedAt ?? new Date(0).toISOString(),
    captureMode: input.captureMode ?? 'afterCapture',
    clockDomain: 'host',
    completenessStatus: input.completenessStatus ?? (hasDiagnosticEvidence ? 'partial' : 'unknown'),
    comparability: buildIosComparability(input.comparability),
    dataClasses,
    diagnosticSources,
    evidenceKind: resolveIosEvidenceKind(sourceSummaries, Boolean(nativeTracePath)),
    lifecycle: input.lifecycle
      ? { ...input.lifecycle }
      : {
          phase: 'afterCapture',
          perturbsTiming: false,
        },
    targetBinding: buildIosTargetBinding(input),
    claimSufficiency: buildIosClaimSufficiency(supportingEvidence, input.claimSufficiency),
    summary: summarizeIosNativePerformanceEvidence(supportingEvidence),
  };

  if (hasFields(summary.frames)) {
    evidence.frames = summary.frames;
  }
  if (hasFields(summary.memory)) {
    evidence.memory = summary.memory;
  }
  if (hasFields(summary.metrics)) {
    evidence.metrics = summary.metrics;
  }
  if (hasFields(summary.traces)) {
    evidence.traces = [summary.traces];
  }
  if (input.attachments && input.attachments.length > 0) {
    evidence.attachments = input.attachments;
  }

  return assertValidJson(evidence, SCHEMAS.nativePerformance, 'Native performance evidence artifact') as JsonRecord;
}

/**
 * Builds a product-neutral, schema-valid Android native-performance evidence envelope.
 *
 * @param {AndroidNativePerformanceEvidenceInput} input
 * @returns {Record<string, unknown>}
 */
function buildAndroidNativePerformanceEvidence(input: AndroidNativePerformanceEvidenceInput): JsonRecord {
  const framestats = typeof input.framestatsText === 'string' ? parseAndroidFramestatsSummary(input.framestatsText) : {};
  const frames = typeof input.gfxinfoText === 'string' ? parseAndroidGfxinfoSummary(input.gfxinfoText) : {};
  const memory = typeof input.meminfoText === 'string' ? parseAndroidMeminfoSummary(input.meminfoText) : {};
  const traceProcessor = normalizeAndroidTraceProcessorSummary(input.traceProcessorSummary);
  const traceProcessorCaptured = hasTraceProcessorSummary(traceProcessor);
  const evidenceKind = resolveAndroidEvidenceKind({ framestats, frames, memory, traceProcessor });
  const dataClasses = buildAndroidDataClasses({ framestats, frames, memory, traceProcessor });
  const diagnosticSources = buildAndroidDiagnosticSources({
    attachments: input.attachments,
    diagnosticSources: input.diagnosticSources,
    framestats,
    frames,
    memory,
    traceProcessor,
  });
  const supportingEvidence: string[] = [];
  if (hasFields(framestats)) {
    supportingEvidence.push('android framestats frame summary');
  }
  if (hasFields(frames)) {
    supportingEvidence.push('android gfxinfo frame summary');
  }
  if (hasFields(memory)) {
    supportingEvidence.push('android meminfo memory summary');
  }
  if (traceProcessorCaptured) {
    supportingEvidence.push('android trace-processor summary');
  }
  const toolCommands: string[] = [];
  if (hasFields(framestats)) {
    toolCommands.push('dumpsys gfxinfo framestats');
  }
  if (hasFields(frames)) {
    toolCommands.push('dumpsys gfxinfo');
  }
  if (hasFields(memory)) {
    toolCommands.push('dumpsys meminfo');
  }
  if (traceProcessorCaptured) {
    toolCommands.push('trace_processor_shell');
  }

  const evidence: JsonRecord = {
    schemaVersion: '1.0.0',
    providerId: input.providerId,
    platform: 'android',
    runId: input.runId,
    scenarioId: input.scenarioId,
    tool: {
      name: 'android-platform-diagnostics',
      command: buildAndroidToolCommand(toolCommands),
    },
    capturedAt: input.capturedAt ?? new Date(0).toISOString(),
    captureMode: 'afterCapture',
    clockDomain: 'host',
    completenessStatus: input.completenessStatus ?? (supportingEvidence.length > 0 ? 'partial' : 'unknown'),
    comparability: buildAndroidComparability(input.comparability),
    dataClasses,
    diagnosticSources,
    evidenceKind,
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding: buildAndroidTargetBinding(input),
    claimSufficiency: buildAndroidClaimSufficiency(supportingEvidence, input.claimSufficiency),
    summary: summarizeAndroidNativePerformanceEvidence(supportingEvidence),
  };

  if (hasFields(frames)) {
    evidence.frames = frames;
  }
  if (hasFields(framestats)) {
    evidence.frames = {
      ...((evidence.frames as JsonRecord | undefined) ?? {}),
      ...framestats,
    };
  }
  if (hasFields(memory)) {
    evidence.memory = memory;
  }
  if (hasFields(traceProcessor.metrics)) {
    evidence.metrics = traceProcessor.metrics;
  }
  if (hasFields(traceProcessor.traces)) {
    evidence.traces = [traceProcessor.traces];
  }
  if (hasFields(traceProcessor.frames)) {
    evidence.frames = {
      ...((evidence.frames as JsonRecord | undefined) ?? {}),
      ...traceProcessor.frames,
    };
  }
  if (input.attachments && input.attachments.length > 0) {
    evidence.attachments = input.attachments;
  }

  return assertValidJson(evidence, SCHEMAS.nativePerformance, 'Native performance evidence artifact') as JsonRecord;
}

export {
  buildAndroidNativePerformanceEvidence,
  classifyNativePerformanceComparisonReadiness,
  parseAndroidFramestatsSummary,
  buildIosNativePerformanceEvidence,
  parseAndroidGfxinfoSummary,
  parseAndroidMeminfoSummary,
  parseIosMetricKitSummaryText,
  parseIosXctraceSummaryText,
};

export type {
  AndroidGfxinfoSummary,
  AndroidFramestatsSummary,
  AndroidMeminfoSummary,
  AndroidNativePerformanceEvidenceInput,
  AndroidTraceProcessorSummaryInput,
  IosNativePerformanceEvidenceInput,
  IosNativePerformanceSummaryInput,
  IosNativePerformanceTextSummary,
  NativePerformanceAttachment,
  NativePerformanceClaimSufficiencyOverride,
  NativePerformanceClaimSufficiencyStatus,
  NativePerformanceCaptureMode,
  NativePerformanceComparisonContext,
  NativePerformanceComparisonEvidenceGap,
  NativePerformanceComparisonReadiness,
  NativePerformanceComparabilityOverride,
  NativePerformanceComparabilityStatus,
  NativePerformanceCompletenessStatus,
  NativePerformanceDiagnosticSourceId,
  NativePerformanceDiagnosticSourceOverride,
  NativePerformanceDiagnosticSourceStatus,
  NativePerformanceLifecycleOverride,
  NativePerformanceTargetBindingOverride,
  NativePerformanceTargetBindingStatus,
  NativePerformanceTargetCandidate,
};
