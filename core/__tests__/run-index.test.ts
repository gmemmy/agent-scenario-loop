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
 * @param {{root: string, scenarioId: string, runId: string, verdictStatus: string, comparisonLane?: string, endedAt?: string, healthStatus?: string}} options
 * @returns {Promise<string>}
 */
async function writeRun({
  comparisonLane,
  endedAt,
  healthStatus = 'passed',
  root,
  runId,
  scenarioId,
  verdictStatus,
}: {
  endedAt?: string;
  healthStatus?: string;
  comparisonLane?: string;
  root: string;
  runId: string;
  scenarioId: string;
  verdictStatus: string;
}): Promise<string> {
  const runDir = path.join(root, scenarioId, runId);
  await writeJson(path.join(runDir, 'health.json'), {
    schemaVersion: '1.0.0',
    scenarioId,
    flowId: scenarioId,
    runId,
    healthStatus,
    checks: [{ name: 'scenario_health', status: healthStatus, source: 'truth' }],
  });
  await writeJson(path.join(runDir, 'verdict.json'), {
    schemaVersion: '1.0.0',
    scenarioId,
    flowId: scenarioId,
    runId,
    healthStatus,
    verdictStatus,
  });
  await writeJson(path.join(runDir, 'manifest.json'), {
    scenario: scenarioId,
    runId,
    platform: 'android',
    status: healthStatus === 'passed' ? 'passed' : 'failed',
    startedAt: '2026-06-16T10:00:00.000Z',
    endedAt,
    durationMs: 1200,
    ...(comparisonLane ? { comparisonLane } : {}),
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
  assert.equal(entry.interactionDriver, 'adb-logcat');
  assert.equal(entry.trusted, true);
});
