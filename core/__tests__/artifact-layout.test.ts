const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  TRANSITION_ARTIFACT_FILENAMES,
  ARTIFACT_FILENAMES,
  ARTIFACT_LAYOUT_VERSION,
  createArtifactLayout,
} = require('../artifact-layout');

test('builds the stable artifact layout for one run directory', () => {
  const outputDir = path.join('artifacts', 'runs', 'app-startup', 'run-1');

  const layout = createArtifactLayout({ outputDir });

  assert.equal(layout.version, ARTIFACT_LAYOUT_VERSION);
  assert.equal(layout.health, path.join(outputDir, ARTIFACT_FILENAMES.health));
  assert.equal(layout.verdict, path.join(outputDir, ARTIFACT_FILENAMES.verdict));
  assert.equal(layout.agentSummary, path.join(outputDir, ARTIFACT_FILENAMES.agentSummary));
  assert.equal(layout.plannerCompatibility, path.join(outputDir, ARTIFACT_FILENAMES.plannerCompatibility));
  assert.equal(layout.signals.memory, path.join(outputDir, 'signals', 'memory'));
  assert.equal(layout.transition.metrics, path.join(outputDir, TRANSITION_ARTIFACT_FILENAMES.metrics));
});
