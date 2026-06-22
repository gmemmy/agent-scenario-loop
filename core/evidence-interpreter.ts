/**
 * Returns an array when the value is already an array; otherwise returns an empty array.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns whether timing evidence can be used for interpretation.
 *
 * @param {Record<string, unknown>} health
 * @returns {boolean}
 */
function isTimingEvidenceTrusted(health: EvidenceRecord): boolean {
  return health?.healthStatus === 'passed';
}

/**
 * Returns a typed health check record when the value is object-like.
 *
 * @param {unknown} value
 * @returns {EvidenceRecord | null}
 */
function asEvidenceRecord(value: unknown): EvidenceRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as EvidenceRecord : null;
}

/**
 * Returns whether a provider check preserved useful diagnostic evidence while failing.
 *
 * @param {EvidenceRecord} check
 * @returns {boolean}
 */
function isPartialProviderEvidenceCheck(check: EvidenceRecord): boolean {
  return check.code === 'partial_provider_evidence_preserved';
}

/**
 * Returns whether a budget check names an unmeasurable claim.
 *
 * @param {EvidenceRecord} check
 * @returns {boolean}
 */
function isUnmeasurableBudgetCheck(check: EvidenceRecord): boolean {
  return check.status === 'unmeasurable';
}

/**
 * Classifies whether the artifact can support a product claim.
 *
 * @param {{failedHealthChecks: EvidenceRecord[], health: EvidenceRecord, unmeasurableBudgetChecks: EvidenceRecord[], verdict?: EvidenceRecord | null}} options
 * @returns {ClaimSufficiency}
 */
function resolveClaimSufficiency({
  failedHealthChecks,
  health,
  unmeasurableBudgetChecks,
  verdict = null,
}: {
  failedHealthChecks: EvidenceRecord[];
  health: EvidenceRecord;
  unmeasurableBudgetChecks: EvidenceRecord[];
  verdict?: EvidenceRecord | null;
}): ClaimSufficiency {
  if (health.healthStatus !== 'passed') {
    const partialProviderEvidence = failedHealthChecks.some(isPartialProviderEvidenceCheck);
    if (partialProviderEvidence) {
      return {
        status: 'diagnostic-only',
        reason: 'scenario health failed but partial provider evidence was preserved for diagnosis',
      };
    }

    return {
      status: 'blocked',
      reason: 'scenario health did not pass',
    };
  }

  if (unmeasurableBudgetChecks.length > 0 || verdict?.verdictStatus === 'inconclusive') {
    return {
      status: 'partial',
      reason: 'one or more requested claims are unmeasurable or inconclusive',
    };
  }

  return {
    status: 'sufficient',
    reason: 'scenario health passed and requested claims are measurable',
  };
}

/**
 * Builds evidence-backed interpretation hints without overriding scenario health.
 *
 * Timing-based hints are only emitted after scenario health passed.
 *
 * @param {{health: Record<string, unknown>, verdict?: Record<string, unknown> | null, comparison?: Record<string, unknown> | null}} options
 * @returns {{timingTrusted: boolean, recommendations: string[], blockedReasons: string[]}}
 */
function interpretEvidence({
  health,
  verdict = null,
  comparison = null,
}: {
  health: EvidenceRecord;
  verdict?: EvidenceRecord | null;
  comparison?: EvidenceRecord | null;
}): EvidenceInterpretation {
  const timingTrusted = isTimingEvidenceTrusted(health);
  const blockedReasons: string[] = [];
  const recommendations: string[] = [];

  const failedChecks = asArray(health?.checks).filter(
    (check) => {
      const record = asEvidenceRecord(check);
      return !!record && record.status !== 'passed';
    },
  ) as EvidenceRecord[];
  const unmeasurableBudgetChecks = asArray(verdict?.budgetChecks).filter(
    (check) => {
      const record = asEvidenceRecord(check);
      return !!record && isUnmeasurableBudgetCheck(record);
    },
  ) as EvidenceRecord[];
  const claimSufficiency = resolveClaimSufficiency({
    failedHealthChecks: failedChecks,
    health,
    unmeasurableBudgetChecks,
    verdict,
  });

  if (claimSufficiency.status === 'blocked') {
    blockedReasons.push(claimSufficiency.reason);
    recommendations.push('harden scenario health before interpreting timing evidence');
  }

  if (claimSufficiency.status === 'diagnostic-only') {
    blockedReasons.push(claimSufficiency.reason);
    recommendations.push('use preserved partial provider evidence only for diagnosis');
  }

  for (const check of failedChecks) {
    const name = typeof check.name === 'string' ? check.name : check.code;
    recommendations.push(`resolve health check ${name ?? 'unknown_check'}`);
  }

  if (timingTrusted) {
    const failedBudgets = asArray(verdict?.budgetChecks).filter(
      (check) => {
        const record = check as EvidenceRecord | null;
        return !!record && typeof record === 'object' && record.pass === false;
      },
    );
    for (const check of failedBudgets) {
      const record = check as EvidenceRecord;
      recommendations.push(`investigate failed budget ${record.name ?? 'unknown budget'}`);
    }

    for (const check of unmeasurableBudgetChecks) {
      recommendations.push(`add interval anchors for unmeasurable budget ${check.name ?? 'unknown budget'}`);
    }

    if (comparison?.comparisonStatus === 'worse') {
      recommendations.push('investigate regression against baseline comparison');
    }

    if (comparison?.comparisonStatus === 'mixed') {
      recommendations.push('inspect mixed baseline comparison signals before claiming improvement');
    }
  }

  return {
    claimSufficiency,
    timingTrusted,
    recommendations,
    blockedReasons,
  };
}

export {
  interpretEvidence,
  isTimingEvidenceTrusted,
};

export type {
  EvidenceInterpretation,
  EvidenceRecord,
};
type EvidenceRecord = Record<string, unknown>;

type ClaimSufficiency = {
  status: 'blocked' | 'diagnostic-only' | 'partial' | 'sufficient';
  reason: string;
};

type EvidenceInterpretation = {
  claimSufficiency: ClaimSufficiency;
  timingTrusted: boolean;
  recommendations: string[];
  blockedReasons: string[];
};
