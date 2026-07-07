const fs = require('node:fs');
const path = require('node:path');

const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');

type LiveProofPlatform = 'android' | 'ios';

type LiveProofProfilePointer = {
  healthStatus?: string;
  label: string;
  runDir: string;
  runId: string;
  scenarioId: string;
  verdictStatus?: string;
};

type LiveProofInteractionProofPointer = {
  captures?: LiveProofInteractionProofCaptures;
  healthStatus?: string;
  label: string;
  runDir: string;
  runId: string;
  runnerId: string;
  scenarioId: string;
  warnings?: LiveProofInteractionProofWarnings;
  verdictStatus?: string;
};

type LiveProofSkippedInteractionProofPointer = {
  label: string;
  nextAction: {
    code: string;
    owner?: LiveProofNextActionOwner;
    summary: string;
  };
  profileGateDiagnostics?: LiveProofProfileGateDiagnostics;
  profileGateReadiness?: LiveProofProfileGateReadiness;
  reason: string;
  runId: string;
  runnerId: string;
  scenarioId: string;
};

type LiveProofDiagnosticSufficiencyEntry = {
  kind: string;
  status: string;
};

type LiveProofRequestedDiagnosticInventoryEntry = {
  availability?: string;
  kind: string;
  nextAction?: string;
  provider?: string;
  reason?: string;
  required: boolean;
  runnerId?: string;
  status: string;
  sufficiencyStatus?: string;
};

type LiveProofNativePerformanceSourceEntry = {
  sourceId: string;
  status: string;
};

type LiveProofNativePerformanceDiagnosticSummary = {
  claimSufficiency?: string;
  comparability?: string;
  diagnosticSources?: LiveProofNativePerformanceSourceEntry[];
  targetBinding?: string;
};

type LiveProofNativePerformanceCount = {
  count: number;
  status: string;
};

type LiveProofNativePerformanceSourceCount = LiveProofNativePerformanceCount & {
  sourceId: string;
};

type LiveProofProfileNativePerformanceRollup = {
  claimSufficiencyCounts?: LiveProofNativePerformanceCount[];
  completenessStatusCounts?: LiveProofNativePerformanceCount[];
  comparabilityCounts?: LiveProofNativePerformanceCount[];
  diagnosticSourceCounts?: LiveProofNativePerformanceSourceCount[];
  evidenceCount: number;
  profileCount: number;
  targetBindingCounts?: LiveProofNativePerformanceCount[];
};

type LiveProofProfileGateDiagnostics = {
  blockingDiagnosticSufficiency?: LiveProofDiagnosticSufficiencyEntry[];
  capturedDiagnosticSufficiency?: LiveProofDiagnosticSufficiencyEntry[];
  nativePerformance?: LiveProofNativePerformanceDiagnosticSummary;
  requestedDiagnosticInventory?: LiveProofRequestedDiagnosticInventoryEntry[];
};

type LiveProofProfileGateReadiness = {
  commandCount?: number;
  devClientDeepLinkOpened?: boolean;
  expectedEvidence?: string;
  failureClass?: string;
  foregroundAppInfoCaptured?: boolean;
  foregroundApplicationState?: string;
  foregroundRawPath?: string;
  foregroundTargetOwned?: boolean;
  lastDeepLinkLabel?: string;
  pendingPhase?: string;
  profileSessionSeedRawPath?: string;
  profileSessionSeeded?: boolean;
  readinessRawPath?: string;
};

type LiveProofInteractionProofCaptures = {
  screenshots: string[];
};

type LiveProofInteractionProofWarning = {
  code: string;
  message: string;
  name: string;
  nextAction?: {
    code: string;
    owner?: LiveProofNextActionOwner;
    summary: string;
  };
};

type LiveProofInteractionProofWarnings = {
  checks: LiveProofInteractionProofWarning[];
  count: number;
};

type LiveProofComparisonPointer = {
  baselineDir: string | null;
  comparisonDir: string | null;
  label: string;
  metricSummary?: LiveProofComparisonMetricSummary;
  reason: string | null;
  runId: string;
  scenarioId: string;
  status: 'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'low_confidence' | 'skipped';
  summaryPath: string | null;
};

type LiveProofComparisonMetricStatus = 'better' | 'worse' | 'unchanged' | 'inconclusive' | 'low_confidence';

type LiveProofComparisonMetricSummary = {
  counts: Record<LiveProofComparisonMetricStatus, number>;
  notableMetrics: Array<{
    baseline: number | boolean | null;
    current: number | boolean | null;
    delta: number | null;
    name: string;
    status: Exclude<LiveProofComparisonMetricStatus, 'unchanged'>;
    unit: string;
  }>;
};

type LiveProofArtifact = {
  comparisons: LiveProofComparisonPointer[];
  comparisonCounts: LiveProofComparisonCounts;
  comparisonStatus: LiveProofComparisonStatus;
  nextAction: LiveProofNextAction;
  outputDir: string;
  platform: LiveProofPlatform;
  interactionProofs?: Array<LiveProofInteractionProofPointer & { summaryPath: string }>;
  profileNativePerformance?: LiveProofProfileNativePerformanceRollup;
  skippedInteractionProofs?: LiveProofSkippedInteractionProofPointer[];
  preflight: {
    healthStatus: string;
    runDir: string;
    runId: string;
    summaryPath: string;
    verdictStatus: string;
  };
  profiles: Array<LiveProofProfilePointer & { summaryPath: string }>;
  runId: string;
  schemaVersion: '1.0.0';
  status: 'passed' | 'failed';
  summary: string;
};

type LiveProofComparisonStatus = (
  'baseline_missing' |
  'improved' |
  'inconclusive' |
  'low_confidence' |
  'mixed' |
  'not_compared' |
  'regressed' |
  'unchanged'
);

type LiveProofComparisonCounts = {
  better: number;
  inconclusive: number;
  low_confidence: number;
  mixed: number;
  skipped: number;
  unchanged: number;
  worse: number;
};

type LiveProofNextAction = {
  code: 'establish_baseline' | 'inspect_failed_run' | 'inspect_inconclusive' | 'inspect_low_confidence' | 'inspect_mixed' | 'inspect_regressions' | 'inspect_summary';
  owner: LiveProofNextActionOwner;
  summary: string;
};

type LiveProofNextActionOwner = (
  'app_truth' |
  'asl_runner' |
  'product_optimization' |
  'provider_tooling' |
  'runtime_environment' |
  'scenario_contract'
);

type LiveProofSummaryResult = {
  liveProofDir: string;
  liveProofPath: string;
  summaryPath: string;
};

type LiveProofRunStatus = {
  healthStatus?: string;
  nextActionOwner?: LiveProofNextActionOwner;
  verdictStatus?: string;
};

type WriteLiveProofSummaryOptions = {
  comparisons: LiveProofComparisonPointer[];
  interactionProofs?: LiveProofInteractionProofPointer[];
  outputDir: string;
  platform: LiveProofPlatform;
  preflightDir: string;
  preflightRunId: string;
  profiles: LiveProofProfilePointer[];
  runId: string;
  skippedInteractionProofs?: LiveProofSkippedInteractionProofPointer[];
};

/**
 * Reads the profile run status fields that agents need at the aggregate entrypoint.
 *
 * @param {string} runDir
 * @returns {LiveProofRunStatus}
 */
function readProfileRunStatus(runDir: string): LiveProofRunStatus {
  const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health.json'), 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
  const nextActionOwner = readRunNextActionOwner(runDir);
  return {
    healthStatus: String(health.healthStatus ?? 'unknown'),
    ...(nextActionOwner ? { nextActionOwner } : {}),
    verdictStatus: String(verdict.verdictStatus ?? 'unknown'),
  };
}

/**
 * Reads native-performance evidence paths from a profile manifest.
 *
 * @param {string} runDir
 * @returns {string[]}
 */
function readProfileNativePerformanceEvidencePaths(runDir: string): string[] {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const artifacts = readObject(manifest.artifacts);
    const attachments = Array.isArray(artifacts?.evidenceAttachments)
      ? artifacts.evidenceAttachments
      : [];
    return attachments
      .filter((attachment): attachment is Record<string, unknown> => (
        attachment &&
        typeof attachment === 'object' &&
        !Array.isArray(attachment) &&
        attachment.kind === 'nativePerformance' &&
        typeof attachment.path === 'string' &&
        attachment.path.length > 0
      ))
      .map((attachment) => attachment.path as string);
  } catch {
    return [];
  }
}

/**
 * Returns a string field from an untrusted object record.
 *
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {string | undefined}
 */
function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads an object value when the input is an object record.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Returns whether a requested diagnostic inventory entry still blocks proof interpretation.
 *
 * @param {Record<string, unknown>} diagnostic
 * @returns {boolean}
 */
function isUnresolvedRequestedDiagnostic(diagnostic: Record<string, unknown>): boolean {
  if (diagnostic.requested !== true) {
    return false;
  }

  const availability = readStringField(diagnostic, 'availability');
  if (availability && availability !== 'captured' && availability !== 'not-requested') {
    return true;
  }

  const sufficiency = readObject(diagnostic.sufficiency);
  const sufficiencyStatus = sufficiency ? readStringField(sufficiency, 'status') : undefined;
  if (
    sufficiencyStatus &&
    sufficiencyStatus !== 'satisfies-required-diagnostic' &&
    sufficiencyStatus !== 'optional-preserved-evidence' &&
    sufficiencyStatus !== 'not-requested'
  ) {
    return true;
  }

  const status = readStringField(diagnostic, 'status');
  return Boolean(status && status !== 'captured' && status !== 'not_requested');
}

/**
 * Reads unresolved requested diagnostic inventory from a profile manifest.
 *
 * @param {string} runDir
 * @returns {LiveProofRequestedDiagnosticInventoryEntry[]}
 */
function readRequestedDiagnosticInventory(runDir: string): LiveProofRequestedDiagnosticInventoryEntry[] {
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const artifacts = readObject(manifest.artifacts);
    const diagnostics = Array.isArray(artifacts?.diagnostics) ? artifacts.diagnostics : [];
    return diagnostics
      .filter((diagnostic): diagnostic is Record<string, unknown> => (
        diagnostic &&
        typeof diagnostic === 'object' &&
        !Array.isArray(diagnostic) &&
        isUnresolvedRequestedDiagnostic(diagnostic)
      ))
      .flatMap((diagnostic) => {
        const kind = readStringField(diagnostic, 'kind');
        const status = readStringField(diagnostic, 'status');
        if (!kind || !status || typeof diagnostic.required !== 'boolean') {
          return [];
        }

        const sufficiency = readObject(diagnostic.sufficiency);
        const availability = readStringField(diagnostic, 'availability');
        const nextAction = readStringField(diagnostic, 'nextAction');
        const provider = readStringField(diagnostic, 'provider');
        const reason = readStringField(diagnostic, 'reason');
        const runnerId = readStringField(diagnostic, 'runnerId');
        const sufficiencyStatus = sufficiency ? readStringField(sufficiency, 'status') : undefined;
        return [{
          ...(availability ? { availability } : {}),
          kind,
          ...(nextAction ? { nextAction } : {}),
          ...(provider ? { provider } : {}),
          ...(reason ? { reason } : {}),
          required: diagnostic.required,
          ...(runnerId ? { runnerId } : {}),
          status,
          ...(sufficiencyStatus ? { sufficiencyStatus } : {}),
        }];
      })
      .sort((left, right) => (
        `${left.kind}:${left.status}:${left.availability ?? ''}:${left.sufficiencyStatus ?? ''}:${left.required}`
          .localeCompare(`${right.kind}:${right.status}:${right.availability ?? ''}:${right.sufficiencyStatus ?? ''}:${right.required}`)
      ));
  } catch {
    return [];
  }
}

/**
 * Reads a native-performance evidence envelope from a profile-relative path.
 *
 * @param {{runDir: string, relativePath: string}} options
 * @returns {Record<string, unknown> | null}
 */
function readNativePerformanceEvidence({
  relativePath,
  runDir,
}: {
  relativePath: string;
  runDir: string;
}): Record<string, unknown> | null {
  const evidencePath = path.join(runDir, relativePath);
  if (!fs.existsSync(evidencePath)) {
    return null;
  }

  try {
    return readObject(JSON.parse(fs.readFileSync(evidencePath, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Increments a count map by status.
 *
 * @param {Map<string, number>} counts
 * @param {unknown} status
 * @returns {void}
 */
function incrementStatusCount(counts: Map<string, number>, status: unknown): void {
  if (typeof status !== 'string' || status.length === 0) {
    return;
  }
  counts.set(status, (counts.get(status) ?? 0) + 1);
}

/**
 * Increments a native diagnostic source count map by source and status.
 *
 * @param {Map<string, number>} counts
 * @param {{sourceId: unknown, status: unknown}} source
 * @returns {void}
 */
function incrementSourceCount(
  counts: Map<string, number>,
  source: {sourceId: unknown; status: unknown},
): void {
  if (
    typeof source.sourceId !== 'string' ||
    source.sourceId.length === 0 ||
    typeof source.status !== 'string' ||
    source.status.length === 0
  ) {
    return;
  }
  const key = `${source.sourceId}\u0000${source.status}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Converts status counts to a stable artifact array.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofNativePerformanceCount[]}
 */
function formatStatusCounts(counts: Map<string, number>): LiveProofNativePerformanceCount[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => ({ count, status }));
}

/**
 * Converts native diagnostic source counts to a stable artifact array.
 *
 * @param {Map<string, number>} counts
 * @returns {LiveProofNativePerformanceSourceCount[]}
 */
function formatSourceCounts(counts: Map<string, number>): LiveProofNativePerformanceSourceCount[] {
  return [...counts.entries()]
    .map(([key, count]) => {
      const [sourceId = '', status = ''] = key.split('\u0000');
      return { count, sourceId, status };
    })
    .sort((left, right) => (
      left.sourceId.localeCompare(right.sourceId) || left.status.localeCompare(right.status)
    ));
}

/**
 * Builds aggregate native-performance evidence counts from profile artifacts.
 *
 * @param {LiveProofProfilePointer[]} profiles
 * @returns {LiveProofProfileNativePerformanceRollup | null}
 */
function buildProfileNativePerformanceRollup(
  profiles: LiveProofProfilePointer[],
): LiveProofProfileNativePerformanceRollup | null {
  const claimSufficiencyCounts = new Map<string, number>();
  const completenessStatusCounts = new Map<string, number>();
  const comparabilityCounts = new Map<string, number>();
  const diagnosticSourceCounts = new Map<string, number>();
  const targetBindingCounts = new Map<string, number>();
  let evidenceCount = 0;
  let profileCount = 0;

  for (const profile of profiles) {
    let profileEvidenceCount = 0;
    const paths = readProfileNativePerformanceEvidencePaths(profile.runDir);
    for (const relativePath of paths) {
      const evidence = readNativePerformanceEvidence({ relativePath, runDir: profile.runDir });
      if (!evidence) {
        continue;
      }
      evidenceCount += 1;
      profileEvidenceCount += 1;
      incrementStatusCount(claimSufficiencyCounts, readObject(evidence.claimSufficiency)?.status);
      incrementStatusCount(completenessStatusCounts, evidence.completenessStatus);
      incrementStatusCount(comparabilityCounts, readObject(evidence.comparability)?.status);
      incrementStatusCount(targetBindingCounts, readObject(evidence.targetBinding)?.status);
      const sources = Array.isArray(evidence.diagnosticSources) ? evidence.diagnosticSources : [];
      for (const source of sources) {
        const sourceRecord = readObject(source);
        if (sourceRecord) {
          incrementSourceCount(diagnosticSourceCounts, {
            sourceId: sourceRecord.sourceId,
            status: sourceRecord.status,
          });
        }
      }
    }
    if (profileEvidenceCount > 0) {
      profileCount += 1;
    }
  }

  if (evidenceCount === 0) {
    return null;
  }

  const sourceCounts = formatSourceCounts(diagnosticSourceCounts);
  const claimCounts = formatStatusCounts(claimSufficiencyCounts);
  const completenessCounts = formatStatusCounts(completenessStatusCounts);
  const comparableCounts = formatStatusCounts(comparabilityCounts);
  const targetCounts = formatStatusCounts(targetBindingCounts);
  return {
    ...(claimCounts.length > 0 ? { claimSufficiencyCounts: claimCounts } : {}),
    ...(completenessCounts.length > 0 ? { completenessStatusCounts: completenessCounts } : {}),
    ...(comparableCounts.length > 0 ? { comparabilityCounts: comparableCounts } : {}),
    ...(sourceCounts.length > 0 ? { diagnosticSourceCounts: sourceCounts } : {}),
    evidenceCount,
    profileCount,
    ...(targetCounts.length > 0 ? { targetBindingCounts: targetCounts } : {}),
  };
}

/**
 * Reads the owner rendered by an agent summary, preserving legacy artifacts that lack the section.
 *
 * @param {string} runDir
 * @returns {LiveProofNextActionOwner | null}
 */
function readRunNextActionOwner(runDir: string): LiveProofNextActionOwner | null {
  const summaryPath = path.join(runDir, 'agent-summary.md');
  if (!fs.existsSync(summaryPath)) {
    return null;
  }

  const summary = fs.readFileSync(summaryPath, 'utf8');
  const match = /-\s*Owner:\s*`([^`]+)`/u.exec(summary);
  const owner = match?.[1];
  if (isLiveProofNextActionOwner(owner)) {
    return owner;
  }
  return null;
}

/**
 * Reads compact diagnostic sufficiency context from a failed profile run.
 *
 * @param {string} runDir
 * @returns {LiveProofProfileGateDiagnostics | null}
 */
function readProfileGateDiagnosticSummary(runDir: string): LiveProofProfileGateDiagnostics | null {
  const healthPath = path.join(runDir, 'health.json');
  if (!fs.existsSync(healthPath)) {
    const requestedDiagnosticInventory = readRequestedDiagnosticInventory(runDir);
    return requestedDiagnosticInventory.length > 0 ? { requestedDiagnosticInventory } : null;
  }

  try {
    const requestedDiagnosticInventory = readRequestedDiagnosticInventory(runDir);
    const health = JSON.parse(fs.readFileSync(healthPath, 'utf8')) as Record<string, unknown>;
    const checks = Array.isArray(health.checks) ? health.checks : [];
    const partialEvidenceCheck = checks.find((check): check is Record<string, unknown> => (
      check &&
      typeof check === 'object' &&
      !Array.isArray(check) &&
      check.code === 'partial_provider_evidence_preserved'
    ));
    const metadata = partialEvidenceCheck?.metadata &&
      typeof partialEvidenceCheck.metadata === 'object' &&
      !Array.isArray(partialEvidenceCheck.metadata)
      ? partialEvidenceCheck.metadata as Record<string, unknown>
      : null;
    if (!metadata) {
      return requestedDiagnosticInventory.length > 0 ? { requestedDiagnosticInventory } : null;
    }

    const capturedDiagnosticSufficiency = parseDiagnosticSufficiencyList(metadata.capturedDiagnosticSufficiency);
    const blockingDiagnosticSufficiency = parseDiagnosticSufficiencyList(metadata.blockingDiagnosticSufficiency);
    const nativePerformance = buildNativePerformanceDiagnosticSummary(metadata);
    const summary = {
      ...(capturedDiagnosticSufficiency.length > 0 ? { capturedDiagnosticSufficiency } : {}),
      ...(blockingDiagnosticSufficiency.length > 0 ? { blockingDiagnosticSufficiency } : {}),
      ...(nativePerformance ? { nativePerformance } : {}),
      ...(requestedDiagnosticInventory.length > 0 ? { requestedDiagnosticInventory } : {}),
    };
    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    const requestedDiagnosticInventory = readRequestedDiagnosticInventory(runDir);
    return requestedDiagnosticInventory.length > 0 ? { requestedDiagnosticInventory } : null;
  }
}

/**
 * Reads compact iOS readiness context from a failed profile run.
 *
 * @param {string} runDir
 * @returns {LiveProofProfileGateReadiness | null}
 */
function readProfileGateReadinessSummary(runDir: string): LiveProofProfileGateReadiness | null {
  const healthPath = path.join(runDir, 'health.json');
  if (!fs.existsSync(healthPath)) {
    return null;
  }

  try {
    const health = JSON.parse(fs.readFileSync(healthPath, 'utf8')) as Record<string, unknown>;
    const checks = Array.isArray(health.checks) ? health.checks : [];
    const readinessCheck = checks.find((check): check is Record<string, unknown> => (
      check &&
      typeof check === 'object' &&
      !Array.isArray(check) &&
      check.code === 'ios_profile_session_start_wait_exhausted'
    ));
    const metadata = readinessCheck?.metadata &&
      typeof readinessCheck.metadata === 'object' &&
      !Array.isArray(readinessCheck.metadata)
      ? readinessCheck.metadata as Record<string, unknown>
      : null;
    if (!metadata) {
      return null;
    }

    const summary = {
      ...readOptionalNumber(metadata, 'commandCount'),
      ...readOptionalBoolean(metadata, 'devClientDeepLinkOpened'),
      ...readOptionalString(metadata, 'expectedEvidence'),
      ...readOptionalString(metadata, 'failureClass'),
      ...readOptionalBoolean(metadata, 'foregroundAppInfoCaptured'),
      ...readOptionalString(metadata, 'foregroundApplicationState'),
      ...readOptionalString(metadata, 'foregroundRawPath'),
      ...readOptionalBoolean(metadata, 'foregroundTargetOwned'),
      ...readOptionalString(metadata, 'lastDeepLinkLabel'),
      ...readOptionalString(metadata, 'pendingPhase'),
      ...readOptionalString(metadata, 'profileSessionSeedRawPath'),
      ...readOptionalBoolean(metadata, 'profileSessionSeeded'),
      ...readOptionalString(metadata, 'readinessRawPath'),
    };
    return Object.keys(summary).length > 0 ? summary : null;
  } catch {
    return null;
  }
}

/**
 * Reads a non-empty string property into an optional one-field object.
 *
 * @param {Record<string, unknown>} source
 * @param {keyof LiveProofProfileGateReadiness} key
 * @returns {Partial<LiveProofProfileGateReadiness>}
 */
function readOptionalString(
  source: Record<string, unknown>,
  key: keyof LiveProofProfileGateReadiness,
): Partial<LiveProofProfileGateReadiness> {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    return {};
  }
  return { [key]: value };
}

/**
 * Reads a boolean property into an optional one-field object.
 *
 * @param {Record<string, unknown>} source
 * @param {keyof LiveProofProfileGateReadiness} key
 * @returns {Partial<LiveProofProfileGateReadiness>}
 */
function readOptionalBoolean(
  source: Record<string, unknown>,
  key: keyof LiveProofProfileGateReadiness,
): Partial<LiveProofProfileGateReadiness> {
  const value = source[key];
  if (typeof value !== 'boolean') {
    return {};
  }
  return { [key]: value };
}

/**
 * Reads a finite number property into an optional one-field object.
 *
 * @param {Record<string, unknown>} source
 * @param {keyof LiveProofProfileGateReadiness} key
 * @returns {Partial<LiveProofProfileGateReadiness>}
 */
function readOptionalNumber(
  source: Record<string, unknown>,
  key: keyof LiveProofProfileGateReadiness,
): Partial<LiveProofProfileGateReadiness> {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {};
  }
  return { [key]: value };
}

/**
 * Parses comma-separated `kind:status` metadata into structured entries.
 *
 * @param {unknown} value
 * @returns {LiveProofDiagnosticSufficiencyEntry[]}
 */
function parseDiagnosticSufficiencyList(value: unknown): LiveProofDiagnosticSufficiencyEntry[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => {
      const separatorIndex = entry.indexOf(':');
      if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
        return null;
      }
      const kind = entry.slice(0, separatorIndex).trim();
      const status = entry.slice(separatorIndex + 1).trim();
      return kind.length > 0 && status.length > 0 ? { kind, status } : null;
    })
    .filter((entry): entry is LiveProofDiagnosticSufficiencyEntry => entry !== null);
}

/**
 * Parses comma-separated `sourceId:status` metadata into structured entries.
 *
 * @param {unknown} value
 * @returns {LiveProofNativePerformanceSourceEntry[]}
 */
function parseNativePerformanceSources(value: unknown): LiveProofNativePerformanceSourceEntry[] {
  return parseDiagnosticSufficiencyList(value).map((entry) => ({
    sourceId: entry.kind,
    status: entry.status,
  }));
}

/**
 * Builds compact native-performance claim context from scalar health metadata.
 *
 * @param {Record<string, unknown>} metadata
 * @returns {LiveProofNativePerformanceDiagnosticSummary | null}
 */
function buildNativePerformanceDiagnosticSummary(
  metadata: Record<string, unknown>,
): LiveProofNativePerformanceDiagnosticSummary | null {
  const diagnosticSources = parseNativePerformanceSources(metadata.nativePerformanceDiagnosticSources);
  const summary = {
    ...(typeof metadata.nativePerformanceClaimSufficiency === 'string'
      ? { claimSufficiency: metadata.nativePerformanceClaimSufficiency }
      : {}),
    ...(typeof metadata.nativePerformanceComparability === 'string'
      ? { comparability: metadata.nativePerformanceComparability }
      : {}),
    ...(diagnosticSources.length > 0 ? { diagnosticSources } : {}),
    ...(typeof metadata.nativePerformanceTargetBinding === 'string'
      ? { targetBinding: metadata.nativePerformanceTargetBinding }
      : {}),
  };
  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * Reports whether a string is a stable live-proof next-action owner.
 *
 * @param {unknown} owner
 * @returns {owner is LiveProofNextActionOwner}
 */
function isLiveProofNextActionOwner(owner: unknown): owner is LiveProofNextActionOwner {
  return owner === 'app_truth' ||
    owner === 'asl_runner' ||
    owner === 'product_optimization' ||
    owner === 'provider_tooling' ||
    owner === 'runtime_environment' ||
    owner === 'scenario_contract';
}

/**
 * Reads capture inventory from a sidecar interaction proof when available.
 *
 * @param {string} runDir
 * @returns {LiveProofInteractionProofCaptures | null}
 */
function readInteractionProofCaptures(runDir: string): LiveProofInteractionProofCaptures | null {
  const metadataPath = [
    path.join(runDir, 'raw', 'agent-device-metadata.json'),
    path.join(runDir, 'raw', 'argent-metadata.json'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!metadataPath) {
    return null;
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
    const captures = metadata.captures && typeof metadata.captures === 'object' && !Array.isArray(metadata.captures)
      ? metadata.captures as Record<string, unknown>
      : null;
    const screenshots = Array.isArray(captures?.screenshots)
      ? captures.screenshots.filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
      : [];
    return screenshots.length > 0 ? { screenshots } : null;
  } catch {
    return null;
  }
}

/**
 * Reads warning checks from a sidecar interaction proof health artifact.
 *
 * @param {string} runDir
 * @returns {LiveProofInteractionProofWarnings | null}
 */
function readInteractionProofWarnings(runDir: string): LiveProofInteractionProofWarnings | null {
  const healthPath = path.join(runDir, 'health.json');
  if (!fs.existsSync(healthPath)) {
    return null;
  }

  try {
    const health = JSON.parse(fs.readFileSync(healthPath, 'utf8')) as Record<string, unknown>;
    const checks = Array.isArray(health.checks) ? health.checks : [];
    const warningNextActionOwner: LiveProofNextActionOwner = 'provider_tooling';
    const warnings = checks
      .filter((check): check is Record<string, unknown> => (
        check &&
        typeof check === 'object' &&
        !Array.isArray(check) &&
        check.status === 'warning'
      ))
      .map((check) => {
        const metadata = check.metadata && typeof check.metadata === 'object' && !Array.isArray(check.metadata)
          ? check.metadata as Record<string, unknown>
          : {};
        return {
          code: typeof check.code === 'string' ? check.code : 'warning',
          message: typeof check.message === 'string' ? check.message : 'Interaction proof emitted a warning.',
          name: typeof check.name === 'string' ? check.name : 'interaction_warning',
          ...(typeof metadata.nextActionCode === 'string' || typeof metadata.nextAction === 'string'
            ? {
              nextAction: {
                code: typeof metadata.nextActionCode === 'string' ? metadata.nextActionCode : 'inspect_interaction_warning',
                owner: warningNextActionOwner,
                summary: typeof metadata.nextAction === 'string' ? metadata.nextAction : 'Inspect the interaction proof warning.',
              },
            }
            : {}),
        };
      });
    return warnings.length > 0 ? { checks: warnings, count: warnings.length } : null;
  } catch {
    return null;
  }
}

/**
 * Formats aggregate gate counts without hiding which linked proof lane failed.
 *
 * @param {{failed: number, label: string, passed: number}} options
 * @returns {string}
 */
function formatGateCountSummary({
  failed,
  label,
  passed,
}: {
  failed: number;
  label: string;
  passed: number;
}): string {
  if (failed === 0) {
    return `${passed} passed ${label}`;
  }
  if (passed === 0) {
    return `${failed} failed ${label}`;
  }
  return `${passed} passed and ${failed} failed ${label}`;
}

/**
 * Builds a compact summary sentence for an aggregate live proof.
 *
 * @param {{platform: string, profileCount: number, comparisonCount: number}} options
 * @returns {string}
 */
function buildLiveProofSummary({
  comparisonCount,
  comparisonStatus,
  failedInteractionProofCount = 0,
  failedProfileCount = 0,
  interactionProofCount = 0,
  interactionWarningCount = 0,
  platform,
  profileCount,
  skippedInteractionProofCount = 0,
  status = 'passed',
}: {
  comparisonCount: number;
  comparisonStatus: LiveProofComparisonStatus;
  failedInteractionProofCount?: number;
  failedProfileCount?: number;
  interactionProofCount?: number;
  interactionWarningCount?: number;
  platform: string;
  profileCount: number;
  skippedInteractionProofCount?: number;
  status?: 'failed' | 'passed';
}): string {
  const statusText = status === 'passed' ? 'passed' : 'failed';
  const profileText = formatGateCountSummary({
    failed: failedProfileCount,
    label: 'profile run(s)',
    passed: profileCount - failedProfileCount,
  });
  const comparisonText = comparisonCount > 0
    ? `with ${comparisonCount} comparison result(s): ${comparisonStatus}`
    : 'without comparison results';
  const interactionText = interactionProofCount > 0
    ? ` and ${formatGateCountSummary({
      failed: failedInteractionProofCount,
      label: 'interaction proof(s)',
      passed: interactionProofCount - failedInteractionProofCount,
    })}`
    : '';
  const skippedText = skippedInteractionProofCount > 0
    ? `; skipped ${skippedInteractionProofCount} interaction proof(s)`
    : '';
  const warningText = interactionWarningCount > 0
    ? `; ${interactionWarningCount} interaction warning(s)`
    : '';
  return `${platform} live proof ${statusText} with ${profileText}${interactionText} ${comparisonText}${skippedText}${warningText}.`;
}

/**
 * Collapses per-scenario comparison results into one batch status.
 *
 * @param {LiveProofComparisonPointer[]} comparisons
 * @returns {LiveProofComparisonStatus}
 */
function buildLiveProofComparisonStatus(
  comparisons: LiveProofComparisonPointer[],
): LiveProofComparisonStatus {
  if (comparisons.length === 0) {
    return 'not_compared';
  }

  const statuses = comparisons.map((comparison) => comparison.status);
  if (statuses.includes('worse')) {
    return 'regressed';
  }

  if (statuses.includes('inconclusive')) {
    return 'inconclusive';
  }

  if (statuses.includes('low_confidence')) {
    return 'low_confidence';
  }

  if (statuses.every((status) => status === 'skipped')) {
    return 'baseline_missing';
  }

  if (statuses.includes('skipped')) {
    return 'inconclusive';
  }

  if (statuses.includes('mixed')) {
    return 'mixed';
  }

  if (statuses.includes('better')) {
    return 'improved';
  }

  return 'unchanged';
}

/**
 * Counts per-scenario comparison outcomes for agent-readable aggregate summaries.
 *
 * @param {LiveProofComparisonPointer[]} comparisons
 * @returns {LiveProofComparisonCounts}
 */
function buildLiveProofComparisonCounts(
  comparisons: LiveProofComparisonPointer[],
): LiveProofComparisonCounts {
  const counts: LiveProofComparisonCounts = {
    better: 0,
    inconclusive: 0,
    low_confidence: 0,
    mixed: 0,
    skipped: 0,
    unchanged: 0,
    worse: 0,
  };
  for (const comparison of comparisons) {
    counts[comparison.status] += 1;
  }
  return counts;
}

/**
 * Builds the next action an agent should take after reading the batch proof.
 *
 * @param {LiveProofComparisonStatus} comparisonStatus
 * @param {'failed' | 'passed'} [status]
 * @param {LiveProofNextActionOwner} [failedOwner]
 * @returns {LiveProofNextAction}
 */
function buildLiveProofNextAction(
  comparisonStatus: LiveProofComparisonStatus,
  status: 'failed' | 'passed' = 'passed',
  failedOwner: LiveProofNextActionOwner = 'asl_runner',
): LiveProofNextAction {
  if (status === 'failed') {
    return {
      code: 'inspect_failed_run',
      owner: failedOwner,
      summary: 'One or more live proof gates failed; inspect failed profile or interaction summaries before making optimization claims.',
    };
  }

  if (comparisonStatus === 'regressed') {
    return {
      code: 'inspect_regressions',
      owner: 'product_optimization',
      summary: 'One or more scenario comparisons regressed; inspect comparison summaries before claiming improvement.',
    };
  }

  if (comparisonStatus === 'baseline_missing') {
    return {
      code: 'establish_baseline',
      owner: 'scenario_contract',
      summary: 'No trusted prior run was available; keep this proof as a baseline before making before/after claims.',
    };
  }

  if (comparisonStatus === 'inconclusive') {
    return {
      code: 'inspect_inconclusive',
      owner: 'scenario_contract',
      summary: 'Some comparisons are inconclusive or incomplete; inspect scenario health and missing baseline details.',
    };
  }

  if (comparisonStatus === 'low_confidence') {
    return {
      code: 'inspect_low_confidence',
      owner: 'scenario_contract',
      summary: 'Some comparisons show low-confidence timing movement; repeat or multi-sample proof is required before treating it as a regression.',
    };
  }

  if (comparisonStatus === 'mixed') {
    return {
      code: 'inspect_mixed',
      owner: 'product_optimization',
      summary: 'Some timing metrics improved while others worsened; inspect comparison details before claiming improvement or regression.',
    };
  }

  return {
    code: 'inspect_summary',
    owner: 'product_optimization',
    summary: 'Scenario health passed; inspect the live-proof summary and linked evidence before reporting the result.',
  };
}

/**
 * Ranks owners so aggregate failures point at the earliest useful recovery lane.
 *
 * @param {LiveProofNextActionOwner} owner
 * @returns {number}
 */
function liveProofFailureOwnerRank(owner: LiveProofNextActionOwner): number {
  switch (owner) {
    case 'runtime_environment':
      return 0;
    case 'asl_runner':
      return 1;
    case 'app_truth':
      return 2;
    case 'scenario_contract':
      return 3;
    case 'provider_tooling':
      return 4;
    case 'product_optimization':
      return 5;
  }
}

/**
 * Selects the owner for a failed aggregate from linked failed run summaries.
 *
 * @param {{interactionProofs: LiveProofRunStatus[], preflight: LiveProofRunStatus, profiles: LiveProofRunStatus[]}} options
 * @returns {LiveProofNextActionOwner}
 */
function selectLiveProofFailureOwner({
  interactionProofs,
  preflight,
  profiles,
}: {
  interactionProofs: LiveProofRunStatus[];
  preflight: LiveProofRunStatus;
  profiles: LiveProofRunStatus[];
}): LiveProofNextActionOwner {
  const owners: LiveProofNextActionOwner[] = [];
  const linkedRuns = [preflight, ...profiles, ...interactionProofs];
  for (const run of linkedRuns) {
    if (isTrustedLiveRunStatus(run)) {
      continue;
    }
    if (run.nextActionOwner) {
      owners.push(run.nextActionOwner);
    }
  }
  owners.sort((left, right) => liveProofFailureOwnerRank(left) - liveProofFailureOwnerRank(right));
  return owners[0] ?? 'asl_runner';
}

/**
 * Reports whether a referenced run is healthy enough to trust as proof.
 *
 * @param {LiveProofRunStatus} status
 * @returns {boolean}
 */
function isTrustedLiveRunStatus(status: LiveProofRunStatus): boolean {
  return status.healthStatus === 'passed' && (status.verdictStatus === 'passed' || status.verdictStatus === 'not_evaluated');
}

/**
 * Derives the aggregate live-proof status from the linked evidence pointers.
 *
 * @param {{preflight: LiveProofRunStatus, profiles: LiveProofRunStatus[], interactionProofs: LiveProofRunStatus[], skippedInteractionProofCount?: number}} options
 * @returns {'failed' | 'passed'}
 */
function buildLiveProofStatus({
  interactionProofs,
  preflight,
  profiles,
  skippedInteractionProofCount = 0,
}: {
  interactionProofs: LiveProofRunStatus[];
  preflight: LiveProofRunStatus;
  profiles: LiveProofRunStatus[];
  skippedInteractionProofCount?: number;
}): 'failed' | 'passed' {
  if (!isTrustedLiveRunStatus(preflight)) {
    return 'failed';
  }

  if (profiles.some((profile) => profile.healthStatus !== 'passed' || profile.verdictStatus !== 'passed')) {
    return 'failed';
  }

  if (interactionProofs.some((proof) => !isTrustedLiveRunStatus(proof))) {
    return 'failed';
  }

  return skippedInteractionProofCount > 0 ? 'failed' : 'passed';
}

/**
 * Formats one comparison metric highlight for markdown.
 *
 * @param {LiveProofComparisonMetricSummary['notableMetrics'][number]} metric
 * @returns {string}
 */
function formatComparisonMetricHighlight(
  metric: LiveProofComparisonMetricSummary['notableMetrics'][number],
): string {
  const delta = metric.delta === null ? 'n/a' : `${metric.delta}${metric.unit}`;
  return `${metric.name} ${metric.status} (${delta})`;
}

/**
 * Formats compact metric counts and highlights for one comparison pointer.
 *
 * @param {LiveProofComparisonPointer} comparison
 * @returns {string}
 */
function formatComparisonMetricSummary(comparison: LiveProofComparisonPointer): string {
  const summary = comparison.metricSummary;
  if (!summary) {
    return '';
  }

  const counts = `metrics better=${summary.counts.better} worse=${summary.counts.worse} unchanged=${summary.counts.unchanged} inconclusive=${summary.counts.inconclusive} low_confidence=${summary.counts.low_confidence}`;
  const highlights = summary.notableMetrics.length > 0
    ? `; notable: ${summary.notableMetrics.map(formatComparisonMetricHighlight).join(', ')}`
    : '';

  return ` (${counts}${highlights})`;
}

/**
 * Formats sidecar capture inventory for aggregate markdown.
 *
 * @param {LiveProofInteractionProofPointer} proof
 * @returns {string}
 */
function formatInteractionProofCaptures(proof: LiveProofInteractionProofPointer): string {
  const screenshotCount = proof.captures?.screenshots.length ?? 0;
  return screenshotCount > 0 ? ` screenshots=${screenshotCount}` : '';
}

/**
 * Formats sidecar warnings for aggregate markdown.
 *
 * @param {LiveProofInteractionProofPointer} proof
 * @returns {string}
 */
function formatInteractionProofWarnings(proof: LiveProofInteractionProofPointer): string {
  const warningCount = proof.warnings?.count ?? 0;
  return warningCount > 0 ? ` warnings=${warningCount}` : '';
}

/**
 * Formats sidecar warning details for aggregate markdown.
 *
 * @param {LiveProofInteractionProofPointer} proof
 * @returns {string[]}
 */
function formatInteractionProofWarningDetails(proof: LiveProofInteractionProofPointer): string[] {
  return (proof.warnings?.checks ?? []).map((warning) => {
    const nextAction = warning.nextAction
      ? ` Next action: ${formatLiveProofNextAction(warning.nextAction)}`
      : '';
    return `  - warning ${warning.name}: ${warning.code} - ${warning.message}${nextAction}`;
  });
}

function formatLiveProofNextAction(action: {
  code: string;
  owner?: LiveProofNextActionOwner;
  summary: string;
}): string {
  return `${action.owner ?? 'unknown'}/${action.code} - ${action.summary}`;
}

/**
 * Formats per-kind diagnostic sufficiency entries for aggregate markdown.
 *
 * @param {LiveProofDiagnosticSufficiencyEntry[]} entries
 * @returns {string}
 */
function formatDiagnosticSufficiencyEntries(entries: LiveProofDiagnosticSufficiencyEntry[]): string {
  return entries.map((entry) => `${entry.kind}:${entry.status}`).join(', ');
}

/**
 * Formats requested diagnostic inventory entries for aggregate markdown.
 *
 * @param {LiveProofRequestedDiagnosticInventoryEntry[]} entries
 * @returns {string}
 */
function formatRequestedDiagnosticInventoryEntries(entries: LiveProofRequestedDiagnosticInventoryEntry[]): string {
  return entries.map((entry) => {
    const status = entry.availability ?? entry.sufficiencyStatus ?? entry.status;
    const details = [
      entry.required ? 'required' : 'optional',
      entry.provider ? `provider=${entry.provider}` : '',
      entry.runnerId ? `runner=${entry.runnerId}` : '',
    ].filter((detail) => detail.length > 0);
    return `${entry.kind}:${status}${details.length > 0 ? `(${details.join(', ')})` : ''}`;
  }).join(', ');
}

/**
 * Formats native-performance source entries for aggregate markdown.
 *
 * @param {LiveProofNativePerformanceSourceEntry[]} entries
 * @returns {string}
 */
function formatNativePerformanceSources(entries: LiveProofNativePerformanceSourceEntry[]): string {
  return entries.map((entry) => `${entry.sourceId}:${entry.status}`).join(', ');
}

/**
 * Formats skipped-proof profile-gate diagnostics for aggregate markdown.
 *
 * @param {LiveProofProfileGateDiagnostics | undefined} diagnostics
 * @returns {string}
 */
function formatProfileGateDiagnostics(diagnostics: LiveProofProfileGateDiagnostics | undefined): string {
  if (!diagnostics) {
    return '';
  }

  const parts = [];
  if (diagnostics.capturedDiagnosticSufficiency?.length) {
    parts.push(`captured=${formatDiagnosticSufficiencyEntries(diagnostics.capturedDiagnosticSufficiency)}`);
  }
  if (diagnostics.blockingDiagnosticSufficiency?.length) {
    parts.push(`blocking=${formatDiagnosticSufficiencyEntries(diagnostics.blockingDiagnosticSufficiency)}`);
  }
  if (diagnostics.requestedDiagnosticInventory?.length) {
    parts.push(`requested=${formatRequestedDiagnosticInventoryEntries(diagnostics.requestedDiagnosticInventory)}`);
  }
  const nativePerformance = diagnostics.nativePerformance;
  if (nativePerformance) {
    const nativeParts = [
      nativePerformance.claimSufficiency ? `claim=${nativePerformance.claimSufficiency}` : '',
      nativePerformance.comparability ? `comparability=${nativePerformance.comparability}` : '',
      nativePerformance.targetBinding ? `target=${nativePerformance.targetBinding}` : '',
      nativePerformance.diagnosticSources?.length
        ? `sources=${formatNativePerformanceSources(nativePerformance.diagnosticSources)}`
        : '',
    ].filter((part) => part.length > 0);
    if (nativeParts.length > 0) {
      parts.push(`nativePerformance(${nativeParts.join(', ')})`);
    }
  }

  return parts.length > 0 ? ` Diagnostics: ${parts.join('; ')}.` : '';
}

/**
 * Formats iOS profile-session readiness context for aggregate markdown.
 *
 * @param {LiveProofProfileGateReadiness | undefined} readiness
 * @returns {string}
 */
function formatProfileGateReadiness(readiness: LiveProofProfileGateReadiness | undefined): string {
  if (!readiness) {
    return '';
  }

  const parts = [];
  if (readiness.failureClass) {
    parts.push(`failure=${readiness.failureClass}`);
  }
  if (typeof readiness.commandCount === 'number') {
    parts.push(`commands=${readiness.commandCount}`);
  }
  if (typeof readiness.devClientDeepLinkOpened === 'boolean') {
    parts.push(`devClientDeepLinkOpened=${readiness.devClientDeepLinkOpened}`);
  }
  if (typeof readiness.foregroundAppInfoCaptured === 'boolean') {
    parts.push(`foregroundAppInfoCaptured=${readiness.foregroundAppInfoCaptured}`);
  }
  if (readiness.foregroundApplicationState) {
    parts.push(`foregroundApplicationState=${readiness.foregroundApplicationState}`);
  }
  if (typeof readiness.foregroundTargetOwned === 'boolean') {
    parts.push(`foregroundTargetOwned=${readiness.foregroundTargetOwned}`);
  }
  if (readiness.lastDeepLinkLabel) {
    parts.push(`lastDeepLink=${readiness.lastDeepLinkLabel}`);
  }
  if (typeof readiness.profileSessionSeeded === 'boolean') {
    parts.push(`profileSessionSeeded=${readiness.profileSessionSeeded}`);
  }
  if (readiness.pendingPhase) {
    parts.push(`phase=${readiness.pendingPhase}`);
  }
  if (readiness.expectedEvidence) {
    parts.push(`expected=${readiness.expectedEvidence}`);
  }
  if (readiness.foregroundRawPath) {
    parts.push(`foregroundRawPath=${readiness.foregroundRawPath}`);
  }
  if (readiness.profileSessionSeedRawPath) {
    parts.push(`profileSessionSeedRawPath=${readiness.profileSessionSeedRawPath}`);
  }
  if (readiness.readinessRawPath) {
    parts.push(`readinessRawPath=${readiness.readinessRawPath}`);
  }

  return parts.length > 0 ? ` Readiness: ${parts.join(', ')}.` : '';
}

/**
 * Formats status count entries for aggregate markdown.
 *
 * @param {LiveProofNativePerformanceCount[]} counts
 * @returns {string}
 */
function formatNativePerformanceStatusCounts(counts: LiveProofNativePerformanceCount[]): string {
  return counts.map((entry) => `${entry.status}=${entry.count}`).join(', ');
}

/**
 * Formats native diagnostic source counts for aggregate markdown.
 *
 * @param {LiveProofNativePerformanceSourceCount[]} counts
 * @returns {string}
 */
function formatNativePerformanceSourceCounts(counts: LiveProofNativePerformanceSourceCount[]): string {
  return counts.map((entry) => `${entry.sourceId}:${entry.status}=${entry.count}`).join(', ');
}

/**
 * Formats aggregate profile native-performance context for markdown.
 *
 * @param {LiveProofProfileNativePerformanceRollup | undefined} rollup
 * @returns {string[]}
 */
function formatProfileNativePerformanceRollup(
  rollup: LiveProofProfileNativePerformanceRollup | undefined,
): string[] {
  if (!rollup) {
    return [];
  }

  const details = [
    `profiles=${rollup.profileCount}`,
    `evidence=${rollup.evidenceCount}`,
  ];
  if (rollup.diagnosticSourceCounts?.length) {
    details.push(`sources=${formatNativePerformanceSourceCounts(rollup.diagnosticSourceCounts)}`);
  }
  if (rollup.completenessStatusCounts?.length) {
    details.push(`completeness=${formatNativePerformanceStatusCounts(rollup.completenessStatusCounts)}`);
  }
  if (rollup.claimSufficiencyCounts?.length) {
    details.push(`claim=${formatNativePerformanceStatusCounts(rollup.claimSufficiencyCounts)}`);
  }
  if (rollup.comparabilityCounts?.length) {
    details.push(`comparability=${formatNativePerformanceStatusCounts(rollup.comparabilityCounts)}`);
  }
  if (rollup.targetBindingCounts?.length) {
    details.push(`target=${formatNativePerformanceStatusCounts(rollup.targetBindingCounts)}`);
  }

  return [
    '',
    '## Native Performance',
    '',
    `- ${details.join('; ')}`,
  ];
}

/**
 * Builds markdown for the aggregate live proof entrypoint.
 *
 * @param {LiveProofArtifact} artifact
 * @returns {string}
 */
function buildLiveProofMarkdown(artifact: LiveProofArtifact): string {
  const lines = [
    `# ${artifact.platform} live proof`,
    '',
    `Status: ${artifact.status}`,
    `Run: ${artifact.runId}`,
    `Comparison status: ${artifact.comparisonStatus}`,
    `Comparison counts: better=${artifact.comparisonCounts.better} worse=${artifact.comparisonCounts.worse} unchanged=${artifact.comparisonCounts.unchanged} mixed=${artifact.comparisonCounts.mixed} inconclusive=${artifact.comparisonCounts.inconclusive} low_confidence=${artifact.comparisonCounts.low_confidence} skipped=${artifact.comparisonCounts.skipped}`,
    `Next action: ${formatLiveProofNextAction(artifact.nextAction)}`,
    `Summary: ${artifact.summary}`,
    '',
    '## Preflight',
    '',
    `- ${artifact.preflight.runId}: ${artifact.preflight.summaryPath}`,
    '',
    '## Profiles',
    '',
    ...artifact.profiles.map((profile) => (
      `- ${profile.label} (${profile.scenarioId}): health=${profile.healthStatus} verdict=${profile.verdictStatus} - ${profile.summaryPath}`
    )),
    ...formatProfileNativePerformanceRollup(artifact.profileNativePerformance),
  ];

  if (artifact.interactionProofs?.length) {
    lines.push(
      '',
      '## Interaction Proofs',
      '',
      ...artifact.interactionProofs.flatMap((proof) => [
        `- ${proof.label} (${proof.runnerId}/${proof.scenarioId}): health=${proof.healthStatus} verdict=${proof.verdictStatus}${formatInteractionProofCaptures(proof)}${formatInteractionProofWarnings(proof)} - ${proof.summaryPath}`,
        ...formatInteractionProofWarningDetails(proof),
      ]),
    );
  }

  if (artifact.skippedInteractionProofs?.length) {
    lines.push(
      '',
      '## Skipped Interaction Proofs',
      '',
      ...artifact.skippedInteractionProofs.map((proof) => (
        `- ${proof.label} (${proof.runnerId}/${proof.scenarioId}/${proof.runId}): ${proof.reason}${formatProfileGateDiagnostics(proof.profileGateDiagnostics)}${formatProfileGateReadiness(proof.profileGateReadiness)} Next action: ${formatLiveProofNextAction(proof.nextAction)}`
      )),
    );
  }

  if (artifact.comparisons.length > 0) {
    lines.push(
      '',
      '## Comparisons',
      '',
      ...artifact.comparisons.map((comparison) => (
        comparison.status === 'skipped'
          ? `- ${comparison.label} (${comparison.scenarioId}): skipped - ${comparison.reason}`
          : `- ${comparison.label} (${comparison.scenarioId}): ${comparison.status}${formatComparisonMetricSummary(comparison)} - ${comparison.summaryPath}`
      )),
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Writes schema-validated aggregate live proof artifacts.
 *
 * @param {WriteLiveProofSummaryOptions} options
 * @returns {Promise<LiveProofSummaryResult>}
 */
async function writeLiveProofSummary({
  comparisons,
  interactionProofs = [],
  outputDir,
  platform,
  preflightDir,
  preflightRunId,
  profiles,
  runId,
  skippedInteractionProofs = [],
}: WriteLiveProofSummaryOptions): Promise<LiveProofSummaryResult> {
  const liveProofDir = path.join(outputDir, '_live-proof', runId);
  const layout = createArtifactLayout({ outputDir: liveProofDir });
  const comparisonStatus = buildLiveProofComparisonStatus(comparisons);
  const comparisonCounts = buildLiveProofComparisonCounts(comparisons);
  const preflightStatus = readProfileRunStatus(preflightDir);
  const profileStatuses = profiles.map((profile) => ({
    profile,
    status: readProfileRunStatus(profile.runDir),
  }));
  const profilePointers = profileStatuses.map(({ profile, status }) => ({
    healthStatus: String(status.healthStatus ?? 'unknown'),
    label: profile.label,
    runDir: profile.runDir,
    runId: profile.runId,
    scenarioId: profile.scenarioId,
    summaryPath: path.join(profile.runDir, 'agent-summary.md'),
    verdictStatus: String(status.verdictStatus ?? 'unknown'),
  }));
  const profileNativePerformance = buildProfileNativePerformanceRollup(profilePointers);
  const interactionProofStatuses = interactionProofs.map((proof) => ({
    proof,
    status: readProfileRunStatus(proof.runDir),
  }));
  const interactionProofPointers = interactionProofStatuses.map(({ proof, status }) => {
    const captures = readInteractionProofCaptures(proof.runDir);
    const warnings = readInteractionProofWarnings(proof.runDir);
    return {
      ...(captures ? { captures } : {}),
      healthStatus: String(status.healthStatus ?? 'unknown'),
      label: proof.label,
      runDir: proof.runDir,
      runId: proof.runId,
      runnerId: proof.runnerId,
      scenarioId: proof.scenarioId,
      summaryPath: path.join(proof.runDir, 'agent-summary.md'),
      verdictStatus: String(status.verdictStatus ?? 'unknown'),
      ...(warnings ? { warnings } : {}),
    };
  });
  const interactionWarningCount = interactionProofPointers.reduce((sum, proof) => sum + (proof.warnings?.count ?? 0), 0);
  const status = buildLiveProofStatus({
    interactionProofs: interactionProofPointers,
    preflight: preflightStatus,
    profiles: profilePointers,
    skippedInteractionProofCount: skippedInteractionProofs.length,
  });
  let failedOwner: LiveProofNextActionOwner = 'asl_runner';
  if (status === 'failed') {
    failedOwner = selectLiveProofFailureOwner({
      interactionProofs: interactionProofStatuses.map(({ status }) => status),
      preflight: preflightStatus,
      profiles: profileStatuses.map(({ status }) => status),
    });
  }
  const artifact: LiveProofArtifact = {
    comparisons,
    comparisonCounts,
    comparisonStatus,
    nextAction: buildLiveProofNextAction(comparisonStatus, status, failedOwner),
    outputDir,
    platform,
    ...(interactionProofPointers.length > 0 ? { interactionProofs: interactionProofPointers } : {}),
    ...(profileNativePerformance ? { profileNativePerformance } : {}),
    ...(skippedInteractionProofs.length > 0 ? { skippedInteractionProofs } : {}),
    preflight: {
      healthStatus: String(preflightStatus.healthStatus ?? 'unknown'),
      runDir: preflightDir,
      runId: preflightRunId,
      summaryPath: path.join(preflightDir, 'agent-summary.md'),
      verdictStatus: String(preflightStatus.verdictStatus ?? 'unknown'),
    },
    profiles: profilePointers,
    runId,
    schemaVersion: '1.0.0',
    status,
    summary: buildLiveProofSummary({
      comparisonCount: comparisons.length,
      comparisonStatus,
      failedInteractionProofCount: interactionProofPointers.filter((proof) => !isTrustedLiveRunStatus(proof)).length,
      failedProfileCount: profilePointers.filter((profile) => profile.healthStatus !== 'passed' || profile.verdictStatus !== 'passed').length,
      interactionProofCount: interactionProofs.length,
      interactionWarningCount,
      platform,
      profileCount: profiles.length,
      skippedInteractionProofCount: skippedInteractionProofs.length,
      status,
    }),
  };

  await writeJsonArtifact({
    filePath: layout.liveProof,
    value: artifact,
    schema: SCHEMAS.liveProof,
    label: 'Live proof artifact',
  });
  await writeTextArtifact({
    filePath: layout.agentSummary,
    content: buildLiveProofMarkdown(artifact),
  });

  return {
    liveProofDir,
    liveProofPath: layout.liveProof,
    summaryPath: layout.agentSummary,
  };
}

export {
  buildLiveProofComparisonCounts,
  buildLiveProofComparisonStatus,
  buildLiveProofMarkdown,
  buildLiveProofNextAction,
  buildLiveProofSummary,
  buildLiveProofStatus,
  formatComparisonMetricSummary,
  formatInteractionProofCaptures,
  formatInteractionProofWarningDetails,
  formatInteractionProofWarnings,
  formatProfileGateDiagnostics,
  formatProfileGateReadiness,
  formatProfileNativePerformanceRollup,
  isTrustedLiveRunStatus,
  buildProfileNativePerformanceRollup,
  readInteractionProofCaptures,
  readInteractionProofWarnings,
  readProfileGateDiagnosticSummary,
  readProfileGateReadinessSummary,
  readProfileRunStatus,
  readRunNextActionOwner,
  writeLiveProofSummary,
};

export type {
  LiveProofArtifact,
  LiveProofComparisonCounts,
  LiveProofComparisonMetricSummary,
  LiveProofComparisonPointer,
  LiveProofComparisonStatus,
  LiveProofInteractionProofCaptures,
  LiveProofInteractionProofPointer,
  LiveProofProfileGateDiagnostics,
  LiveProofProfileGateReadiness,
  LiveProofProfileNativePerformanceRollup,
  LiveProofNextActionOwner,
  LiveProofNextAction,
  LiveProofPlatform,
  LiveProofProfilePointer,
  LiveProofSkippedInteractionProofPointer,
  LiveProofSummaryResult,
  WriteLiveProofSummaryOptions,
};
