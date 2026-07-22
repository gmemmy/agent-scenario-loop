type ScenarioCompatibilityStatus =
  | 'declared-compatible'
  | 'exact'
  | 'incompatible'
  | 'legacy-compatible';

type ScenarioCompatibility = {
  status: ScenarioCompatibilityStatus;
  reason: string;
  baselineHash?: string;
  currentHash?: string;
};

const SCENARIO_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function readScenarioHashes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => (
    typeof entry === 'string' && SCENARIO_HASH_PATTERN.test(entry)
  ));
}

function resolveScenarioCompatibility({
  acceptedBaselineScenarioHashes,
  baselineHash,
  baselineScenarioId,
  currentHash,
  currentScenarioId,
}: {
  acceptedBaselineScenarioHashes?: unknown;
  baselineHash?: unknown;
  baselineScenarioId: string;
  currentHash?: unknown;
  currentScenarioId: string;
}): ScenarioCompatibility {
  const baselineHashSupplied = baselineHash !== undefined && baselineHash !== null;
  const currentHashSupplied = currentHash !== undefined && currentHash !== null;
  const resolvedBaselineHash = typeof baselineHash === 'string' && SCENARIO_HASH_PATTERN.test(baselineHash)
    ? baselineHash
    : undefined;
  const resolvedCurrentHash = typeof currentHash === 'string' && SCENARIO_HASH_PATTERN.test(currentHash)
    ? currentHash
    : undefined;
  const hashes = {
    ...(resolvedBaselineHash ? { baselineHash: resolvedBaselineHash } : {}),
    ...(resolvedCurrentHash ? { currentHash: resolvedCurrentHash } : {}),
  };

  if (baselineScenarioId !== currentScenarioId) {
    return {
      ...hashes,
      status: 'incompatible',
      reason: 'scenario_id_mismatch',
    };
  }

  if (currentHashSupplied && !resolvedCurrentHash) {
    return {
      ...hashes,
      status: 'incompatible',
      reason: 'current_scenario_hash_malformed',
    };
  }

  if (baselineHashSupplied && !resolvedBaselineHash) {
    return {
      ...hashes,
      status: 'incompatible',
      reason: 'baseline_scenario_hash_malformed',
    };
  }

  if (!resolvedCurrentHash) {
    return {
      ...hashes,
      status: 'legacy-compatible',
      reason: 'current_scenario_hash_missing',
    };
  }

  if (!resolvedBaselineHash) {
    return {
      ...hashes,
      status: 'incompatible',
      reason: 'baseline_scenario_hash_missing',
    };
  }

  if (resolvedBaselineHash === resolvedCurrentHash) {
    return {
      ...hashes,
      status: 'exact',
      reason: 'scenario_hash_match',
    };
  }

  if (readScenarioHashes(acceptedBaselineScenarioHashes).includes(resolvedBaselineHash)) {
    return {
      ...hashes,
      status: 'declared-compatible',
      reason: 'baseline_hash_explicitly_accepted',
    };
  }

  return {
    ...hashes,
    status: 'incompatible',
    reason: 'scenario_hash_mismatch',
  };
}

function isScenarioCompatible(result: ScenarioCompatibility): boolean {
  return result.status !== 'incompatible';
}

export {
  isScenarioCompatible,
  readScenarioHashes,
  resolveScenarioCompatibility,
};

export type {
  ScenarioCompatibility,
  ScenarioCompatibilityStatus,
};
