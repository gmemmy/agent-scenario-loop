const path = require('node:path');

const ARTIFACT_LAYOUT_VERSION = '1.0.0';

const ARTIFACT_FILENAMES = {
  agentSummary: 'agent-summary.md',
  comparison: 'comparison.json',
  health: 'health.json',
  plannerCompatibility: 'planner-compatibility.json',
  verdict: 'verdict.json',
};

const PROFILE_ARTIFACT_FILENAMES = {
  budgetVerdict: 'budget-verdict.json',
  causalRun: 'causal-run.json',
  manifest: 'manifest.json',
  metrics: 'metrics.json',
  summary: 'summary.md',
};

const TRANSITION_ARTIFACT_FILENAMES = PROFILE_ARTIFACT_FILENAMES;

type ProfileArtifactPaths = {
  budgetVerdict: string;
  causalRun: string;
  manifest: string;
  metrics: string;
  summary: string;
};

type ArtifactLayout = {
  version: string;
  root: string;
  health: string;
  verdict: string;
  comparison: string;
  agentSummary: string;
  plannerCompatibility: string;
  raw: string;
  captures: string;
  signals: {
    js: string;
    memory: string;
    network: string;
  };
  profile: ProfileArtifactPaths;
  transition: ProfileArtifactPaths;
};

/**
 * Builds the stable artifact path contract for one run directory.
 *
 * @param {{outputDir: string}} options
 * @returns {ArtifactLayout}
 */
function createArtifactLayout({ outputDir }: { outputDir: string }): ArtifactLayout {
  const profileArtifacts = {
    budgetVerdict: path.join(outputDir, PROFILE_ARTIFACT_FILENAMES.budgetVerdict),
    causalRun: path.join(outputDir, PROFILE_ARTIFACT_FILENAMES.causalRun),
    manifest: path.join(outputDir, PROFILE_ARTIFACT_FILENAMES.manifest),
    metrics: path.join(outputDir, PROFILE_ARTIFACT_FILENAMES.metrics),
    summary: path.join(outputDir, PROFILE_ARTIFACT_FILENAMES.summary),
  };

  return {
    version: ARTIFACT_LAYOUT_VERSION,
    root: outputDir,
    health: path.join(outputDir, ARTIFACT_FILENAMES.health),
    verdict: path.join(outputDir, ARTIFACT_FILENAMES.verdict),
    comparison: path.join(outputDir, ARTIFACT_FILENAMES.comparison),
    agentSummary: path.join(outputDir, ARTIFACT_FILENAMES.agentSummary),
    plannerCompatibility: path.join(outputDir, ARTIFACT_FILENAMES.plannerCompatibility),
    raw: path.join(outputDir, 'raw'),
    captures: path.join(outputDir, 'captures'),
    signals: {
      js: path.join(outputDir, 'signals', 'js'),
      memory: path.join(outputDir, 'signals', 'memory'),
      network: path.join(outputDir, 'signals', 'network'),
    },
    profile: profileArtifacts,
    transition: profileArtifacts,
  };
}

export {
  ARTIFACT_FILENAMES,
  ARTIFACT_LAYOUT_VERSION,
  PROFILE_ARTIFACT_FILENAMES,
  TRANSITION_ARTIFACT_FILENAMES,
  createArtifactLayout,
};

export type {
  ArtifactLayout,
  ProfileArtifactPaths,
};
