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
    summary: string;
  };
  reason: string;
  runId: string;
  runnerId: string;
  scenarioId: string;
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
  status: 'better' | 'worse' | 'unchanged' | 'mixed' | 'inconclusive' | 'skipped';
  summaryPath: string | null;
};

type LiveProofComparisonMetricStatus = 'better' | 'worse' | 'unchanged' | 'inconclusive';

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
  'mixed' |
  'not_compared' |
  'regressed' |
  'unchanged'
);

type LiveProofComparisonCounts = {
  better: number;
  inconclusive: number;
  mixed: number;
  skipped: number;
  unchanged: number;
  worse: number;
};

type LiveProofNextAction = {
  code: 'establish_baseline' | 'inspect_failed_run' | 'inspect_inconclusive' | 'inspect_mixed' | 'inspect_regressions' | 'inspect_summary';
  summary: string;
};

type LiveProofSummaryResult = {
  liveProofDir: string;
  liveProofPath: string;
  summaryPath: string;
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
 * @returns {{healthStatus: string, verdictStatus: string}}
 */
function readProfileRunStatus(runDir: string): {healthStatus: string; verdictStatus: string} {
  const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health.json'), 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
  return {
    healthStatus: String(health.healthStatus ?? 'unknown'),
    verdictStatus: String(verdict.verdictStatus ?? 'unknown'),
  };
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
 * Builds a compact summary sentence for an aggregate live proof.
 *
 * @param {{platform: string, profileCount: number, comparisonCount: number}} options
 * @returns {string}
 */
function buildLiveProofSummary({
  comparisonCount,
  comparisonStatus,
  interactionProofCount = 0,
  interactionWarningCount = 0,
  platform,
  profileCount,
  skippedInteractionProofCount = 0,
  status = 'passed',
}: {
  comparisonCount: number;
  comparisonStatus: LiveProofComparisonStatus;
  interactionProofCount?: number;
  interactionWarningCount?: number;
  platform: string;
  profileCount: number;
  skippedInteractionProofCount?: number;
  status?: 'failed' | 'passed';
}): string {
  const statusText = status === 'passed' ? 'passed' : 'failed';
  const comparisonText = comparisonCount > 0
    ? `with ${comparisonCount} comparison result(s): ${comparisonStatus}`
    : 'without comparison results';
  const interactionText = interactionProofCount > 0
    ? ` and ${interactionProofCount} interaction proof(s)`
    : '';
  const skippedText = skippedInteractionProofCount > 0
    ? `; skipped ${skippedInteractionProofCount} interaction proof(s)`
    : '';
  const warningText = interactionWarningCount > 0
    ? `; ${interactionWarningCount} interaction warning(s)`
    : '';
  return `${platform} live proof ${statusText} ${profileCount} profile run(s)${interactionText} ${comparisonText}${skippedText}${warningText}.`;
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
 * @returns {LiveProofNextAction}
 */
function buildLiveProofNextAction(
  comparisonStatus: LiveProofComparisonStatus,
  status: 'failed' | 'passed' = 'passed',
): LiveProofNextAction {
  if (status === 'failed') {
    return {
      code: 'inspect_failed_run',
      summary: 'One or more live proof gates failed; inspect failed profile or interaction summaries before making optimization claims.',
    };
  }

  if (comparisonStatus === 'regressed') {
    return {
      code: 'inspect_regressions',
      summary: 'One or more scenario comparisons regressed; inspect comparison summaries before claiming improvement.',
    };
  }

  if (comparisonStatus === 'baseline_missing') {
    return {
      code: 'establish_baseline',
      summary: 'No trusted prior run was available; keep this proof as a baseline before making before/after claims.',
    };
  }

  if (comparisonStatus === 'inconclusive') {
    return {
      code: 'inspect_inconclusive',
      summary: 'Some comparisons are inconclusive or incomplete; inspect scenario health and missing baseline details.',
    };
  }

  if (comparisonStatus === 'mixed') {
    return {
      code: 'inspect_mixed',
      summary: 'Some timing metrics improved while others worsened; inspect comparison details before claiming improvement or regression.',
    };
  }

  return {
    code: 'inspect_summary',
    summary: 'Scenario health passed; inspect the live-proof summary and linked evidence before reporting the result.',
  };
}

/**
 * Reports whether a referenced run is healthy enough to trust as proof.
 *
 * @param {{healthStatus?: string, verdictStatus?: string}} status
 * @returns {boolean}
 */
function isTrustedLiveRunStatus(status: {healthStatus?: string; verdictStatus?: string}): boolean {
  return status.healthStatus === 'passed' && (status.verdictStatus === 'passed' || status.verdictStatus === 'not_evaluated');
}

/**
 * Derives the aggregate live-proof status from the linked evidence pointers.
 *
 * @param {{preflight: {healthStatus?: string, verdictStatus?: string}, profiles: Array<{healthStatus?: string, verdictStatus?: string}>, interactionProofs: Array<{healthStatus?: string, verdictStatus?: string}>, skippedInteractionProofCount?: number}} options
 * @returns {'failed' | 'passed'}
 */
function buildLiveProofStatus({
  interactionProofs,
  preflight,
  profiles,
  skippedInteractionProofCount = 0,
}: {
  interactionProofs: Array<{healthStatus?: string; verdictStatus?: string}>;
  preflight: {healthStatus?: string; verdictStatus?: string};
  profiles: Array<{healthStatus?: string; verdictStatus?: string}>;
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

  const counts = `metrics better=${summary.counts.better} worse=${summary.counts.worse} unchanged=${summary.counts.unchanged} inconclusive=${summary.counts.inconclusive}`;
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
    `Comparison counts: better=${artifact.comparisonCounts.better} worse=${artifact.comparisonCounts.worse} unchanged=${artifact.comparisonCounts.unchanged} mixed=${artifact.comparisonCounts.mixed} inconclusive=${artifact.comparisonCounts.inconclusive} skipped=${artifact.comparisonCounts.skipped}`,
    `Next action: ${artifact.nextAction.code} - ${artifact.nextAction.summary}`,
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
  ];

  if (artifact.interactionProofs?.length) {
    lines.push(
      '',
      '## Interaction Proofs',
      '',
      ...artifact.interactionProofs.map((proof) => (
        `- ${proof.label} (${proof.runnerId}/${proof.scenarioId}): health=${proof.healthStatus} verdict=${proof.verdictStatus}${formatInteractionProofCaptures(proof)}${formatInteractionProofWarnings(proof)} - ${proof.summaryPath}`
      )),
    );
  }

  if (artifact.skippedInteractionProofs?.length) {
    lines.push(
      '',
      '## Skipped Interaction Proofs',
      '',
      ...artifact.skippedInteractionProofs.map((proof) => (
        `- ${proof.label} (${proof.runnerId}/${proof.scenarioId}/${proof.runId}): ${proof.reason} Next action: ${proof.nextAction.code} - ${proof.nextAction.summary}`
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
  const profilePointers = profiles.map((profile) => ({
    ...readProfileRunStatus(profile.runDir),
    label: profile.label,
    runDir: profile.runDir,
    runId: profile.runId,
    scenarioId: profile.scenarioId,
    summaryPath: path.join(profile.runDir, 'agent-summary.md'),
  }));
  const interactionProofPointers = interactionProofs.map((proof) => {
    const captures = readInteractionProofCaptures(proof.runDir);
    const warnings = readInteractionProofWarnings(proof.runDir);
    return {
      ...readProfileRunStatus(proof.runDir),
      ...(captures ? { captures } : {}),
      label: proof.label,
      runDir: proof.runDir,
      runId: proof.runId,
      runnerId: proof.runnerId,
      scenarioId: proof.scenarioId,
      summaryPath: path.join(proof.runDir, 'agent-summary.md'),
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
  const artifact: LiveProofArtifact = {
    comparisons,
    comparisonCounts,
    comparisonStatus,
    nextAction: buildLiveProofNextAction(comparisonStatus, status),
    outputDir,
    platform,
    ...(interactionProofPointers.length > 0 ? { interactionProofs: interactionProofPointers } : {}),
    ...(skippedInteractionProofs.length > 0 ? { skippedInteractionProofs } : {}),
    preflight: {
      ...preflightStatus,
      runDir: preflightDir,
      runId: preflightRunId,
      summaryPath: path.join(preflightDir, 'agent-summary.md'),
    },
    profiles: profilePointers,
    runId,
    schemaVersion: '1.0.0',
    status,
    summary: buildLiveProofSummary({
      comparisonCount: comparisons.length,
      comparisonStatus,
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
  formatInteractionProofWarnings,
  isTrustedLiveRunStatus,
  readInteractionProofCaptures,
  readInteractionProofWarnings,
  readProfileRunStatus,
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
  LiveProofNextAction,
  LiveProofPlatform,
  LiveProofProfilePointer,
  LiveProofSkippedInteractionProofPointer,
  LiveProofSummaryResult,
  WriteLiveProofSummaryOptions,
};
