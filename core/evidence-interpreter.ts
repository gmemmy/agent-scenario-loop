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

  if (!timingTrusted) {
    blockedReasons.push('scenario health did not pass');
    recommendations.push('harden scenario health before interpreting timing evidence');
  }

  const failedChecks = asArray(health?.checks).filter(
    (check) => {
      const record = check as EvidenceRecord | null;
      return !!record && typeof record === 'object' && record.status !== 'passed';
    },
  );
  for (const check of failedChecks) {
    const record = check as EvidenceRecord;
    const name = typeof record.name === 'string' ? record.name : record.code;
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

    if (comparison?.comparisonStatus === 'worse') {
      recommendations.push('investigate regression against baseline comparison');
    }
  }

  return {
    timingTrusted,
    recommendations,
    blockedReasons,
  };
}

module.exports = {
  interpretEvidence,
  isTimingEvidenceTrusted,
};
type EvidenceRecord = Record<string, unknown>;

type EvidenceInterpretation = {
  timingTrusted: boolean;
  recommendations: string[];
  blockedReasons: string[];
};
