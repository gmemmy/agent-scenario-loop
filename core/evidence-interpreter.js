/**
 * Returns an array when the value is already an array; otherwise returns an empty array.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns whether timing evidence can be used for interpretation.
 *
 * @param {Record<string, unknown>} health
 * @returns {boolean}
 */
function isTimingEvidenceTrusted(health) {
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
function interpretEvidence({ health, verdict = null, comparison = null }) {
  const timingTrusted = isTimingEvidenceTrusted(health);
  const blockedReasons = [];
  const recommendations = [];

  if (!timingTrusted) {
    blockedReasons.push('scenario health did not pass');
    recommendations.push('harden scenario health before interpreting timing evidence');
  }

  const failedChecks = asArray(health?.checks).filter(
    (check) => check && typeof check === 'object' && check.status !== 'passed',
  );
  for (const check of failedChecks) {
    const name = typeof check.name === 'string' ? check.name : check.code;
    recommendations.push(`resolve health check ${name ?? 'unknown_check'}`);
  }

  if (timingTrusted) {
    const failedBudgets = asArray(verdict?.budgetChecks).filter(
      (check) => check && typeof check === 'object' && check.pass === false,
    );
    for (const check of failedBudgets) {
      recommendations.push(`investigate failed budget ${check.name ?? 'unknown budget'}`);
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
