const fs = require('node:fs');
const path = require('node:path');

const { ARTIFACT_FILENAMES, PROFILE_ARTIFACT_FILENAMES } = require('./artifact-layout');

type RunIndexEntry = {
  runDir: string;
  scenarioId: string;
  scenarioHash?: string;
  cohortHash?: string;
  runId: string;
  healthStatus: string;
  trusted: boolean;
  durationMs?: number;
  endedAt?: string;
  flowId?: string;
  comparisonLane?: string;
  interactionDriver?: string;
  platform?: string;
  startedAt?: string;
  verdictStatus?: string;
};

type RunIndex = {
  entries: RunIndexEntry[];
  rootDir: string;
  trusted: RunIndexEntry[];
};

/**
 * Reads a JSON object from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Returns whether a value is a plain object record.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns whether a directory contains the minimum run artifact pair.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isRunDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.health)) &&
    fs.existsSync(path.join(dir, ARTIFACT_FILENAMES.verdict))
  );
}

/**
 * Recursively finds run directories under one artifact root.
 *
 * @param {string} rootDir
 * @returns {string[]}
 */
function findRunDirs(rootDir: string): string[] {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return [];
  }

  const results: string[] = [];
  const pending = [path.resolve(rootDir)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    if (isRunDir(current)) {
      results.push(current);
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        pending.push(path.join(current, entry.name));
      }
    }
  }

  return results.sort();
}

/**
 * Converts one run directory into an index entry.
 *
 * @param {string} runDir
 * @returns {RunIndexEntry}
 */
function readRunIndexEntry(runDir: string): RunIndexEntry {
  const health = readJson(path.join(runDir, ARTIFACT_FILENAMES.health));
  const verdict = readJson(path.join(runDir, ARTIFACT_FILENAMES.verdict));
  const manifestPath = path.join(runDir, PROFILE_ARTIFACT_FILENAMES.manifest);
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : {};
  const scenarioId = typeof health.scenarioId === 'string'
    ? health.scenarioId
    : typeof manifest.scenario === 'string'
      ? manifest.scenario
      : 'unknown-scenario';
  const runId = typeof health.runId === 'string'
    ? health.runId
    : typeof manifest.runId === 'string'
      ? manifest.runId
      : path.basename(runDir);
  const healthStatus = typeof health.healthStatus === 'string' ? health.healthStatus : 'unknown';
  const verdictStatus = typeof verdict.verdictStatus === 'string' ? verdict.verdictStatus : undefined;
  const provenance = isRecord(manifest.provenance) ? manifest.provenance : {};

  return {
    runDir,
    scenarioId,
    runId,
    ...(typeof manifest.scenarioHash === 'string' ? { scenarioHash: manifest.scenarioHash } : {}),
    ...(typeof provenance.cohortHash === 'string'
      ? { cohortHash: provenance.cohortHash }
      : {}),
    healthStatus,
    trusted: healthStatus === 'passed' && verdictStatus === 'passed',
    ...(typeof manifest.durationMs === 'number' ? { durationMs: manifest.durationMs } : {}),
    ...(typeof manifest.endedAt === 'string' ? { endedAt: manifest.endedAt } : {}),
    ...(typeof health.flowId === 'string' ? { flowId: health.flowId } : {}),
    ...(typeof manifest.comparisonLane === 'string' ? { comparisonLane: manifest.comparisonLane } : {}),
    ...(typeof manifest.interactionDriver === 'string' ? { interactionDriver: manifest.interactionDriver } : {}),
    ...(typeof manifest.platform === 'string' ? { platform: manifest.platform } : {}),
    ...(typeof manifest.startedAt === 'string' ? { startedAt: manifest.startedAt } : {}),
    ...(verdictStatus ? { verdictStatus } : {}),
  };
}

/**
 * Sorts entries newest first while keeping deterministic fallback ordering.
 *
 * @param {RunIndexEntry[]} entries
 * @returns {RunIndexEntry[]}
 */
function sortRunIndexEntries(entries: RunIndexEntry[]): RunIndexEntry[] {
  return [...entries].sort((left, right) => {
    const leftTime = Date.parse(left.endedAt ?? left.startedAt ?? '');
    const rightTime = Date.parse(right.endedAt ?? right.startedAt ?? '');
    const leftTimestamp = Number.isFinite(leftTime) ? leftTime : 0;
    const rightTimestamp = Number.isFinite(rightTime) ? rightTime : 0;
    if (leftTimestamp !== rightTimestamp) {
      return rightTimestamp - leftTimestamp;
    }

    return `${left.scenarioId}/${left.runId}/${left.runDir}`.localeCompare(
      `${right.scenarioId}/${right.runId}/${right.runDir}`,
    );
  });
}

/**
 * Builds a read-only index of completed run artifact folders.
 *
 * @param {{rootDir: string, scenarioId?: string}} options
 * @returns {RunIndex}
 */
function buildRunIndex({ rootDir, scenarioId }: { rootDir: string; scenarioId?: string }): RunIndex {
  const resolvedRoot = path.resolve(rootDir);
  const entries = sortRunIndexEntries(
    findRunDirs(resolvedRoot)
      .map((runDir) => readRunIndexEntry(runDir))
      .filter((entry) => !scenarioId || entry.scenarioId === scenarioId),
  );

  return {
    rootDir: resolvedRoot,
    entries,
    trusted: entries.filter((entry) => entry.trusted),
  };
}

/**
 * Returns the newest trusted run for a scenario, if one exists.
 *
 * @param {RunIndex} index
 * @param {string} scenarioId
 * @returns {RunIndexEntry | null}
 */
function findLatestTrustedRun(index: RunIndex, scenarioId: string): RunIndexEntry | null {
  return index.trusted.find((entry) => entry.scenarioId === scenarioId) ?? null;
}

export {
  buildRunIndex,
  findLatestTrustedRun,
  findRunDirs,
  readRunIndexEntry,
  sortRunIndexEntries,
};

export type {
  RunIndex,
  RunIndexEntry,
};
