const path = require('node:path');

const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');

type LiveProofPlatform = 'android' | 'ios';

type LiveProofProfilePointer = {
  label: string;
  runDir: string;
  runId: string;
  scenarioId: string;
};

type LiveProofComparisonPointer = {
  baselineDir: string | null;
  comparisonDir: string | null;
  label: string;
  reason: string | null;
  runId: string;
  scenarioId: string;
  status: 'better' | 'worse' | 'unchanged' | 'inconclusive' | 'skipped';
  summaryPath: string | null;
};

type LiveProofArtifact = {
  comparisons: LiveProofComparisonPointer[];
  comparisonStatus: LiveProofComparisonStatus;
  nextAction: LiveProofNextAction;
  outputDir: string;
  platform: LiveProofPlatform;
  preflight: {
    runDir: string;
    runId: string;
    summaryPath: string;
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
  'not_compared' |
  'regressed' |
  'unchanged'
);

type LiveProofNextAction = {
  code: 'establish_baseline' | 'inspect_inconclusive' | 'inspect_regressions' | 'inspect_summary';
  summary: string;
};

type LiveProofSummaryResult = {
  liveProofDir: string;
  liveProofPath: string;
  summaryPath: string;
};

type WriteLiveProofSummaryOptions = {
  comparisons: LiveProofComparisonPointer[];
  outputDir: string;
  platform: LiveProofPlatform;
  preflightDir: string;
  preflightRunId: string;
  profiles: LiveProofProfilePointer[];
  runId: string;
};

/**
 * Builds a compact summary sentence for an aggregate live proof.
 *
 * @param {{platform: string, profileCount: number, comparisonCount: number}} options
 * @returns {string}
 */
function buildLiveProofSummary({
  comparisonCount,
  comparisonStatus,
  platform,
  profileCount,
}: {
  comparisonCount: number;
  comparisonStatus: LiveProofComparisonStatus;
  platform: string;
  profileCount: number;
}): string {
  const comparisonText = comparisonCount > 0
    ? `with ${comparisonCount} comparison result(s): ${comparisonStatus}`
    : 'without comparison results';
  return `${platform} live proof passed ${profileCount} profile run(s) ${comparisonText}.`;
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

  if (statuses.includes('better')) {
    return 'improved';
  }

  return 'unchanged';
}

/**
 * Builds the next action an agent should take after reading the batch proof.
 *
 * @param {LiveProofComparisonStatus} comparisonStatus
 * @returns {LiveProofNextAction}
 */
function buildLiveProofNextAction(comparisonStatus: LiveProofComparisonStatus): LiveProofNextAction {
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

  return {
    code: 'inspect_summary',
    summary: 'Scenario health passed; inspect the live-proof summary and linked evidence before reporting the result.',
  };
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
      `- ${profile.label} (${profile.scenarioId}): ${profile.summaryPath}`
    )),
  ];

  if (artifact.comparisons.length > 0) {
    lines.push(
      '',
      '## Comparisons',
      '',
      ...artifact.comparisons.map((comparison) => (
        comparison.status === 'skipped'
          ? `- ${comparison.label} (${comparison.scenarioId}): skipped - ${comparison.reason}`
          : `- ${comparison.label} (${comparison.scenarioId}): ${comparison.status} - ${comparison.summaryPath}`
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
  outputDir,
  platform,
  preflightDir,
  preflightRunId,
  profiles,
  runId,
}: WriteLiveProofSummaryOptions): Promise<LiveProofSummaryResult> {
  const liveProofDir = path.join(outputDir, '_live-proof', runId);
  const layout = createArtifactLayout({ outputDir: liveProofDir });
  const comparisonStatus = buildLiveProofComparisonStatus(comparisons);
  const artifact: LiveProofArtifact = {
    comparisons,
    comparisonStatus,
    nextAction: buildLiveProofNextAction(comparisonStatus),
    outputDir,
    platform,
    preflight: {
      runDir: preflightDir,
      runId: preflightRunId,
      summaryPath: path.join(preflightDir, 'agent-summary.md'),
    },
    profiles: profiles.map((profile) => ({
      label: profile.label,
      runDir: profile.runDir,
      runId: profile.runId,
      scenarioId: profile.scenarioId,
      summaryPath: path.join(profile.runDir, 'agent-summary.md'),
    })),
    runId,
    schemaVersion: '1.0.0',
    status: 'passed',
    summary: buildLiveProofSummary({
      comparisonCount: comparisons.length,
      comparisonStatus,
      platform,
      profileCount: profiles.length,
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
  buildLiveProofComparisonStatus,
  buildLiveProofMarkdown,
  buildLiveProofNextAction,
  buildLiveProofSummary,
  writeLiveProofSummary,
};

export type {
  LiveProofArtifact,
  LiveProofComparisonPointer,
  LiveProofComparisonStatus,
  LiveProofNextAction,
  LiveProofPlatform,
  LiveProofProfilePointer,
  LiveProofSummaryResult,
  WriteLiveProofSummaryOptions,
};
