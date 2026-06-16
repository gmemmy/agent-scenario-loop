const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  ARTIFACT_FILENAMES,
  ARTIFACT_LAYOUT_VERSION,
  PROFILE_ARTIFACT_FILENAMES,
  createArtifactLayout,
} = require('../artifact-layout');

test('builds the stable artifact layout for one run directory', () => {
  const outputDir = path.join('artifacts', 'runs', 'app-startup', 'run-1');

  const layout = createArtifactLayout({ outputDir });

  assert.equal(layout.version, ARTIFACT_LAYOUT_VERSION);
  assert.equal(layout.health, path.join(outputDir, ARTIFACT_FILENAMES.health));
  assert.equal(layout.verdict, path.join(outputDir, ARTIFACT_FILENAMES.verdict));
  assert.equal(layout.agentSummary, path.join(outputDir, ARTIFACT_FILENAMES.agentSummary));
  assert.equal(layout.liveProof, path.join(outputDir, ARTIFACT_FILENAMES.liveProof));
  assert.equal(layout.plannerCompatibility, path.join(outputDir, ARTIFACT_FILENAMES.plannerCompatibility));
  assert.equal(layout.signals.memory, path.join(outputDir, 'signals', 'memory'));
  assert.equal(layout.profile.metrics, path.join(outputDir, PROFILE_ARTIFACT_FILENAMES.metrics));
  assert.equal(Object.prototype.hasOwnProperty.call(layout, 'transition'), false);
});
