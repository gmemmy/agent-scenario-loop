const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildRunIndex,
  findLatestTrustedRun,
  findRunDirs,
  readRunIndexEntry,
} = require('../run-index');

type TestContext = import('node:test').TestContext;

/**
 * Writes JSON with stable formatting.
 *
 * @param {string} filePath
 * @param {Record<string, unknown>} value
 * @returns {Promise<void>}
 */
async function writeJson(filePath: string, value: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Writes the minimum run artifacts needed for the index.
 *
 * @param {{root: string, scenarioId: string, runId: string, verdictStatus: string, attempt?: Record<string, unknown>, cohortHash?: string, comparisonLane?: string, endedAt?: string, healthSchemaVersion?: string, healthStatus?: string, manifestSchemaVersion?: string, scenarioHash?: string, verdictSchemaVersion?: string}} options
 * @returns {Promise<string>}
 */
async function writeRun({
  attempt,
  cohortHash,
  comparisonLane,
  endedAt,
  healthSchemaVersion = '1.0.0',
  healthStatus = 'passed',
  manifestSchemaVersion,
  root,
  runId,
  scenarioHash,
  scenarioId,
  verdictSchemaVersion = '1.0.0',
  verdictStatus,
}: {
  attempt?: Record<string, unknown>;
  cohortHash?: string;
  endedAt?: string;
  healthSchemaVersion?: string;
  healthStatus?: string;
  manifestSchemaVersion?: string;
  comparisonLane?: string;
  root: string;
  runId: string;
  scenarioHash?: string;
  scenarioId: string;
  verdictSchemaVersion?: string;
  verdictStatus: string;
}): Promise<string> {
  const runDir = path.join(root, scenarioId, runId);
  await writeJson(path.join(runDir, 'health.json'), {
    schemaVersion: healthSchemaVersion,
    scenarioId,
    flowId: scenarioId,
    runId,
    healthStatus,
    checks: [{ name: 'scenario_health', status: healthStatus, source: 'truth' }],
  });
  await writeJson(path.join(runDir, 'verdict.json'), {
    schemaVersion: verdictSchemaVersion,
    scenarioId,
    flowId: scenarioId,
    runId,
    healthStatus,
    verdictStatus,
  });
  await writeJson(path.join(runDir, 'manifest.json'), {
    ...(manifestSchemaVersion ? { schemaVersion: manifestSchemaVersion } : {}),
    scenario: scenarioId,
    ...(scenarioHash ? { scenarioHash } : {}),
    runId,
    platform: 'android',
    status: healthStatus === 'passed' ? 'passed' : 'failed',
    startedAt: '2026-06-16T10:00:00.000Z',
    endedAt,
    durationMs: 1200,
    ...(attempt ? { attempt } : {}),
    ...(comparisonLane ? { comparisonLane } : {}),
    ...(cohortHash
      ? {
          provenance: {
            cohortHash,
          },
        }
      : {}),
    interactionDriver: 'adb-logcat',
  });
  return runDir;
}

test('finds completed run directories under an artifact root', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const runDir = await writeRun({
    root,
    scenarioId: 'app-startup',
    runId: 'run-1',
    verdictStatus: 'passed',
  });
  await writeJson(path.join(root, 'partial', 'health.json'), {
    schemaVersion: '1.0.0',
    scenarioId: 'partial',
    runId: 'partial',
    healthStatus: 'passed',
    checks: [{ name: 'scenario_health', status: 'passed', source: 'truth' }],
  });

  assert.deepEqual(findRunDirs(root), [runDir]);
});

test('marks future major artifact schemas incompatible for baseline trust', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const runDir = await writeRun({
    root,
    scenarioId: 'app-startup',
    runId: 'future-schema',
    verdictStatus: 'passed',
    manifestSchemaVersion: '2.0.0',
  });

  const entry = readRunIndexEntry(runDir);
  const index = buildRunIndex({ rootDir: root });

  assert.equal(entry.artifactCompatibility.status, 'incompatible');
  assert.equal(entry.artifactCompatibility.reason, 'manifest_future_major');
  assert.equal(entry.trusted, false);
  assert.equal(entry.trustReason, 'artifact_schema_incompatible');
  assert.deepEqual(index.trusted.map((item: { runId: string }) => item.runId), []);
});

test('marks malformed artifact schemas incompatible for baseline trust', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const runDir = await writeRun({
    root,
    scenarioId: 'app-startup',
    runId: 'malformed-schema',
    verdictStatus: 'passed',
    healthSchemaVersion: 'next',
  });

  const entry = readRunIndexEntry(runDir);

  assert.equal(entry.artifactCompatibility.status, 'incompatible');
  assert.equal(entry.artifactCompatibility.reason, 'health_malformed');
  assert.equal(entry.trusted, false);
  assert.equal(entry.trustReason, 'artifact_schema_incompatible');
});

test('builds a newest-first trusted run index', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  await writeRun({
    root,
    scenarioId: 'open-close-cycle',
    runId: 'older-passed',
    verdictStatus: 'passed',
    endedAt: '2026-06-16T10:00:00.000Z',
  });
  await writeRun({
    root,
    scenarioId: 'open-close-cycle',
    runId: 'newer-failed',
    verdictStatus: 'failed',
    endedAt: '2026-06-16T11:00:00.000Z',
  });
  await writeRun({
    root,
    scenarioId: 'scroll-settle',
    runId: 'newest-passed',
    verdictStatus: 'passed',
    endedAt: '2026-06-16T12:00:00.000Z',
  });

  const index = buildRunIndex({ rootDir: root });

  assert.deepEqual(index.entries.map((entry: { runId: string }) => entry.runId), [
    'newest-passed',
    'newer-failed',
    'older-passed',
  ]);
  assert.deepEqual(index.trusted.map((entry: { runId: string }) => entry.runId), [
    'newest-passed',
    'older-passed',
  ]);
  assert.equal(findLatestTrustedRun(index, 'open-close-cycle')?.runId, 'older-passed');
});

test('filters a run index by scenario id', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const startupRunDir = await writeRun({
    root,
    scenarioId: 'app-startup',
    runId: 'startup-run',
    verdictStatus: 'passed',
    comparisonLane: 'example-android-live',
    cohortHash: 'c'.repeat(64),
    scenarioHash: 'a'.repeat(64),
  });
  await writeRun({
    root,
    scenarioId: 'scroll-settle',
    runId: 'scroll-run',
    verdictStatus: 'passed',
  });

  const index = buildRunIndex({ rootDir: root, scenarioId: 'app-startup' });
  const entry = readRunIndexEntry(startupRunDir);

  assert.deepEqual(index.entries.map((item: { runId: string }) => item.runId), ['startup-run']);
  assert.equal(entry.platform, 'android');
  assert.equal(entry.comparisonLane, 'example-android-live');
  assert.equal(entry.cohortHash, 'c'.repeat(64));
  assert.equal(entry.scenarioHash, 'a'.repeat(64));
  assert.equal(entry.interactionDriver, 'adb-logcat');
  assert.equal(entry.artifactCompatibility.status, 'legacy-compatible');
  assert.equal(entry.artifactCompatibility.reason, 'schema_version_legacy_missing');
  assert.equal(entry.trusted, true);
  assert.equal(entry.trustReason, 'trusted_legacy_without_attempt');
});

test('falls back to manifest and directory identity for legacy run artifacts', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  const manifestIdentityRunDir = path.join(root, 'legacy', 'manifest-identity');
  await writeJson(path.join(manifestIdentityRunDir, 'health.json'), {
    schemaVersion: '1.0.0',
    healthStatus: 'passed',
    checks: [{ name: 'scenario_health', status: 'passed', source: 'truth' }],
  });
  await writeJson(path.join(manifestIdentityRunDir, 'verdict.json'), {
    schemaVersion: '1.0.0',
    healthStatus: 'passed',
    verdictStatus: 'passed',
  });
  await writeJson(path.join(manifestIdentityRunDir, 'manifest.json'), {
    scenario: 'manifest-scenario',
    runId: 'manifest-run',
  });
  const directoryIdentityRunDir = path.join(root, 'legacy', 'directory-identity');
  await writeJson(path.join(directoryIdentityRunDir, 'health.json'), {
    schemaVersion: '1.0.0',
    healthStatus: 'passed',
    checks: [{ name: 'scenario_health', status: 'passed', source: 'truth' }],
  });
  await writeJson(path.join(directoryIdentityRunDir, 'verdict.json'), {
    schemaVersion: '1.0.0',
    healthStatus: 'passed',
    verdictStatus: 'passed',
  });

  const manifestEntry = readRunIndexEntry(manifestIdentityRunDir);
  const directoryEntry = readRunIndexEntry(directoryIdentityRunDir);

  assert.equal(manifestEntry.scenarioId, 'manifest-scenario');
  assert.equal(manifestEntry.runId, 'manifest-run');
  assert.equal(directoryEntry.scenarioId, 'unknown-scenario');
  assert.equal(directoryEntry.runId, 'directory-identity');
});

test('does not trust retry or partial attempt artifacts as latest baselines', async (t: TestContext) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-run-index-'));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  await writeRun({
    root,
    scenarioId: 'open-close-cycle',
    runId: 'clean-first-attempt',
    verdictStatus: 'passed',
    endedAt: '2026-06-16T10:00:00.000Z',
    attempt: {
      attemptId: 'attempt-1',
      attemptNumber: 1,
      maxAttempts: 3,
      status: 'passed',
      terminalState: 'passed',
      cleanup: {
        status: 'passed',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
  });
  await writeRun({
    root,
    scenarioId: 'open-close-cycle',
    runId: 'retry-passed',
    verdictStatus: 'passed',
    endedAt: '2026-06-16T11:00:00.000Z',
    attempt: {
      attemptId: 'attempt-2',
      attemptNumber: 2,
      maxAttempts: 3,
      retryOfAttemptId: 'attempt-1',
      retryReason: 'Previous attempt timed out.',
      status: 'passed',
      terminalState: 'passed',
      cleanup: {
        status: 'passed',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
  });
  await writeRun({
    root,
    scenarioId: 'open-close-cycle',
    runId: 'partial-cleanup',
    verdictStatus: 'passed',
    endedAt: '2026-06-16T12:00:00.000Z',
    attempt: {
      attemptId: 'attempt-1',
      attemptNumber: 1,
      maxAttempts: 1,
      status: 'passed',
      terminalState: 'passed',
      cleanup: {
        status: 'partial',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
  });

  const index = buildRunIndex({ rootDir: root, scenarioId: 'open-close-cycle' });

  assert.deepEqual(index.entries.map((entry: { runId: string; trustReason: string }) => [entry.runId, entry.trustReason]), [
    ['partial-cleanup', 'cleanup_not_complete'],
    ['retry-passed', 'retry_attempt_not_baseline_trusted'],
    ['clean-first-attempt', 'trusted'],
  ]);
  assert.deepEqual(index.trusted.map((entry: { runId: string }) => entry.runId), ['clean-first-attempt']);
  assert.equal(findLatestTrustedRun(index, 'open-close-cycle')?.runId, 'clean-first-attempt');
});
