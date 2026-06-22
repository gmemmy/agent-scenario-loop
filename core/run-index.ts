const fs = require('node:fs');
const path = require('node:path');

const { ARTIFACT_FILENAMES, PROFILE_ARTIFACT_FILENAMES } = require('./artifact-layout');

type RunIndexEntry = {
  runDir: string;
  scenarioId: string;
  attemptId?: string;
  attemptNumber?: number;
  artifactCompatibility: ArtifactCompatibility;
  scenarioHash?: string;
  cohortHash?: string;
  runId: string;
  healthStatus: string;
  trusted: boolean;
  trustReason: string;
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

type ArtifactCompatibilityStatus = 'compatible' | 'legacy-compatible' | 'incompatible';
type ArtifactSchemaVersionRecord = {
  artifact: 'health' | 'manifest' | 'verdict';
  status: 'current' | 'future-major' | 'legacy-missing' | 'malformed';
  version?: string;
};
type ArtifactCompatibility = {
  reason: string;
  schemaVersions: ArtifactSchemaVersionRecord[];
  status: ArtifactCompatibilityStatus;
};

const SUPPORTED_ARTIFACT_SCHEMA_MAJOR = 1;

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
 * Resolves one schema-version field into reader compatibility metadata.
 *
 * @param {{artifact: ArtifactSchemaVersionRecord['artifact'], value: unknown}} options
 * @returns {ArtifactSchemaVersionRecord}
 */
function resolveArtifactSchemaVersion({
  artifact,
  value,
}: {
  artifact: ArtifactSchemaVersionRecord['artifact'];
  value: unknown;
}): ArtifactSchemaVersionRecord {
  if (typeof value !== 'string') {
    return {
      artifact,
      status: 'legacy-missing',
    };
  }

  const [majorText] = value.split('.');
  const major = Number(majorText);
  if (!Number.isInteger(major) || major < 1) {
    return {
      artifact,
      status: 'malformed',
      version: value,
    };
  }

  if (major > SUPPORTED_ARTIFACT_SCHEMA_MAJOR) {
    return {
      artifact,
      status: 'future-major',
      version: value,
    };
  }

  return {
    artifact,
    status: 'current',
    version: value,
  };
}

/**
 * Classifies whether a run artifact set is safe for the current reader.
 *
 * @param {{health: Record<string, unknown>, manifest: Record<string, unknown>, verdict: Record<string, unknown>}} options
 * @returns {ArtifactCompatibility}
 */
function resolveArtifactCompatibility({
  health,
  manifest,
  verdict,
}: {
  health: Record<string, unknown>;
  manifest: Record<string, unknown>;
  verdict: Record<string, unknown>;
}): ArtifactCompatibility {
  const schemaVersions = [
    resolveArtifactSchemaVersion({ artifact: 'health', value: health.schemaVersion }),
    resolveArtifactSchemaVersion({ artifact: 'verdict', value: verdict.schemaVersion }),
    resolveArtifactSchemaVersion({ artifact: 'manifest', value: manifest.schemaVersion }),
  ];
  const incompatible = schemaVersions.find((version) => version.status === 'future-major' || version.status === 'malformed');
  if (incompatible) {
    return {
      reason: `${incompatible.artifact}_${incompatible.status.replaceAll('-', '_')}`,
      schemaVersions,
      status: 'incompatible',
    };
  }

  if (schemaVersions.some((version) => version.status === 'legacy-missing')) {
    return {
      reason: 'schema_version_legacy_missing',
      schemaVersions,
      status: 'legacy-compatible',
    };
  }

  return {
    reason: 'schema_version_supported',
    schemaVersions,
    status: 'compatible',
  };
}

/**
 * Returns a stable reason explaining whether this run can seed latest-trusted comparisons.
 *
 * @param {{artifactCompatibility: ArtifactCompatibility, healthStatus: string, verdictStatus?: string, manifest: Record<string, unknown>}} options
 * @returns {string}
 */
function resolveTrustReason({
  artifactCompatibility,
  healthStatus,
  manifest,
  verdictStatus,
}: {
  artifactCompatibility: ArtifactCompatibility;
  healthStatus: string;
  manifest: Record<string, unknown>;
  verdictStatus: string | undefined;
}): string {
  if (artifactCompatibility.status === 'incompatible') {
    return 'artifact_schema_incompatible';
  }

  if (healthStatus !== 'passed') {
    return 'health_not_passed';
  }

  if (verdictStatus !== 'passed') {
    return 'verdict_not_passed';
  }

  const attempt = isRecord(manifest.attempt) ? manifest.attempt : null;
  if (!attempt) {
    return 'trusted_legacy_without_attempt';
  }

  if (attempt.status !== 'passed' || attempt.terminalState !== 'passed') {
    return 'attempt_not_passed';
  }

  if (typeof attempt.attemptNumber === 'number' && attempt.attemptNumber !== 1) {
    return 'retry_attempt_not_baseline_trusted';
  }

  if (typeof attempt.retryOfAttemptId === 'string' || typeof attempt.retryReason === 'string') {
    return 'retry_lineage_not_baseline_trusted';
  }

  const cleanup = isRecord(attempt.cleanup) ? attempt.cleanup : null;
  if (cleanup?.status === 'failed' || cleanup?.status === 'partial') {
    return 'cleanup_not_complete';
  }

  const partialArtifacts = isRecord(attempt.partialArtifacts) ? attempt.partialArtifacts : null;
  if (partialArtifacts?.valid === true) {
    return 'partial_artifacts_not_baseline_trusted';
  }

  return 'trusted';
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
 * Resolves the scenario id used to group indexed run artifacts.
 *
 * Health owns run identity. Manifest scenario ids are a fallback for legacy
 * artifacts that predate complete health identity fields.
 *
 * @param {{health: Record<string, unknown>, manifest: Record<string, unknown>}} options
 * @returns {string}
 */
function resolveRunIndexScenarioId({
  health,
  manifest,
}: {
  health: Record<string, unknown>;
  manifest: Record<string, unknown>;
}): string {
  if (typeof health.scenarioId === 'string') {
    return health.scenarioId;
  }

  if (typeof manifest.scenario === 'string') {
    return manifest.scenario;
  }

  return 'unknown-scenario';
}

/**
 * Resolves the run id used to identify an indexed artifact folder.
 *
 * Health owns run identity. Manifest run ids are a fallback, and the directory
 * name is used only for legacy or partial artifacts with missing identity.
 *
 * @param {{health: Record<string, unknown>, manifest: Record<string, unknown>, runDir: string}} options
 * @returns {string}
 */
function resolveRunIndexRunId({
  health,
  manifest,
  runDir,
}: {
  health: Record<string, unknown>;
  manifest: Record<string, unknown>;
  runDir: string;
}): string {
  if (typeof health.runId === 'string') {
    return health.runId;
  }

  if (typeof manifest.runId === 'string') {
    return manifest.runId;
  }

  return path.basename(runDir);
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
  const scenarioId = resolveRunIndexScenarioId({ health, manifest });
  const runId = resolveRunIndexRunId({ health, manifest, runDir });
  const healthStatus = typeof health.healthStatus === 'string' ? health.healthStatus : 'unknown';
  const verdictStatus = typeof verdict.verdictStatus === 'string' ? verdict.verdictStatus : undefined;
  const provenance = isRecord(manifest.provenance) ? manifest.provenance : {};
  const attempt = isRecord(manifest.attempt) ? manifest.attempt : null;
  const artifactCompatibility = resolveArtifactCompatibility({ health, manifest, verdict });
  const trustReason = resolveTrustReason({
    artifactCompatibility,
    healthStatus,
    manifest,
    verdictStatus,
  });

  return {
    runDir,
    scenarioId,
    runId,
    artifactCompatibility,
    ...(typeof attempt?.attemptId === 'string' ? { attemptId: attempt.attemptId } : {}),
    ...(typeof attempt?.attemptNumber === 'number' ? { attemptNumber: attempt.attemptNumber } : {}),
    ...(typeof manifest.scenarioHash === 'string' ? { scenarioHash: manifest.scenarioHash } : {}),
    ...(typeof provenance.cohortHash === 'string'
      ? { cohortHash: provenance.cohortHash }
      : {}),
    healthStatus,
    trusted: trustReason === 'trusted' || trustReason === 'trusted_legacy_without_attempt',
    trustReason,
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
