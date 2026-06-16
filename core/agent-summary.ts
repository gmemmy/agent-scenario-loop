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
 * Wraps a scalar value in markdown code ticks.
 *
 * @param {unknown} value
 * @returns {string}
 */
function code(value: unknown): string {
  return `\`${String(value ?? 'unknown')}\``;
}

/**
 * Reads the first non-empty string from candidate values.
 *
 * @param {unknown[]} values
 * @param {string} fallback
 * @returns {string}
 */
function firstString(values: unknown[], fallback: string): string {
  const found = values.find((value) => typeof value === 'string' && value.length > 0);
  return typeof found === 'string' ? found : fallback;
}

/**
 * Formats health or warning checks as markdown list items.
 *
 * @param {unknown[]} checks
 * @returns {string[]}
 */
function formatChecks(checks: unknown[]): string[] {
  return asArray(checks).map((check) => {
    if (!check || typeof check !== 'object') {
      return '- unknown check';
    }

    const record = check as SummaryRecord;
    const name = firstString([record.name, record.code], 'unknown_check');
    const status = firstString([record.status], 'unknown');
    const message = firstString([record.message], 'no message');
    return `- ${code(name)}: ${status} - ${message}`;
  });
}

/**
 * Formats failed budget checks as markdown list items.
 *
 * @param {unknown[]} budgetChecks
 * @returns {string[]}
 */
function formatFailedBudgets(budgetChecks: unknown[]): string[] {
  return asArray(budgetChecks)
    .filter((check) => {
      const record = check as SummaryRecord | null;
      return !!record && typeof record === 'object' && record.pass === false;
    })
    .map((check) => {
      const record = check as SummaryRecord;
      const name = firstString([record.name], 'unknown budget');
      const metric = firstString([record.metric], 'unknown metric');
      return `- ${name}: ${metric} expected ${record.expected ?? 'n/a'}, actual ${record.actual ?? 'n/a'}`;
    });
}

/**
 * Builds the minimum agent-facing markdown summary for a run.
 *
 * @param {{health: Record<string, unknown>, verdict: Record<string, unknown>, comparison?: Record<string, unknown> | null}} options
 * @returns {string}
 */
function buildAgentSummaryMarkdown({ health, verdict, comparison = null }: AgentSummaryInput): string {
  const scenarioId = firstString([health?.scenarioId, verdict?.scenarioId], 'unknown-scenario');
  const runId = firstString([health?.runId, verdict?.runId], 'unknown-run');
  const healthStatus = firstString([health?.healthStatus], 'failed');
  const verdictStatus = firstString([verdict?.verdictStatus], 'inconclusive');
  const comparisonStatus = comparison
    ? firstString([comparison.comparisonStatus], 'inconclusive')
    : 'not_available';
  const lines = [
    '# agent summary',
    '',
    `- Scenario: ${code(scenarioId)}`,
    `- Run ID: ${code(runId)}`,
    `- Health: ${healthStatus}`,
    `- Verdict: ${verdictStatus}`,
    `- Comparison: ${comparisonStatus}`,
    '',
    '## gate',
    '',
  ];

  if (healthStatus === 'passed') {
    lines.push('Scenario health passed. Optimization claims still require verdict or comparison evidence.');
  } else {
    lines.push('Do not optimize from this run. Scenario health did not pass.');
  }

  const failedChecks = asArray(health?.checks).filter(
    (check) => {
      const record = check as SummaryRecord | null;
      return !!record && typeof record === 'object' && record.status !== 'passed';
    },
  );
  if (failedChecks.length > 0) {
    lines.push('', '## failed checks', '', ...formatChecks(failedChecks));
  }

  const warnings = asArray(health?.warnings);
  if (warnings.length > 0) {
    lines.push('', '## warnings', '', ...formatChecks(warnings));
  }

  const failedBudgets = formatFailedBudgets(asArray(verdict?.budgetChecks));
  if (failedBudgets.length > 0) {
    lines.push('', '## failed budgets', '', ...failedBudgets);
  }

  if (comparison) {
    lines.push('', '## comparison', '', firstString([comparison.summary], 'No comparison summary provided.'));
  }

  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildAgentSummaryMarkdown,
};
type SummaryRecord = Record<string, unknown>;

type AgentSummaryInput = {
  health: SummaryRecord;
  verdict: SummaryRecord;
  comparison?: SummaryRecord | null;
};
