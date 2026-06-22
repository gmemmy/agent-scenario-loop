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
 * Formats an optional next-action hint stored on a health check.
 *
 * @param {SummaryRecord} record
 * @returns {string}
 */
function formatNextAction(record: SummaryRecord): string {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }

  const metadataRecord = metadata as SummaryRecord;
  const nextAction = firstString([metadataRecord.nextAction], '');
  if (!nextAction) {
    return '';
  }

  const nextActionCode = firstString([metadataRecord.nextActionCode], '');
  return nextActionCode
    ? ` Next action ${code(nextActionCode)}: ${nextAction}`
    : ` Next action: ${nextAction}`;
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
    return `- ${code(name)}: ${status} - ${message}${formatNextAction(record)}`;
  });
}

/**
 * Splits comma-delimited health metadata into stable non-empty tokens.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function splitMetadataList(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Formats provider diagnostics that survived an unhealthy provider command.
 *
 * @param {unknown[]} checks
 * @returns {string[]}
 */
function formatPreservedProviderEvidence(checks: unknown[]): string[] {
  return asArray(checks)
    .filter((check) => {
      const record = check as SummaryRecord | null;
      return !!record && typeof record === 'object' && record.code === 'partial_provider_evidence_preserved';
    })
    .map((check) => {
      const record = check as SummaryRecord;
      const metadata = record.metadata;
      let metadataRecord: SummaryRecord = {};
      if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
        metadataRecord = metadata as SummaryRecord;
      }

      const kinds = splitMetadataList(metadataRecord.capturedKinds);
      const paths = splitMetadataList(metadataRecord.capturedPaths);
      const blockingKinds = splitMetadataList(metadataRecord.blockingRequiredKinds);
      let kindText = code('unknown');
      if (kinds.length > 0) {
        kindText = kinds.map((kind) => code(kind)).join(', ');
      }

      let pathText = code('not-recorded');
      if (paths.length > 0) {
        pathText = paths.map((item) => code(item)).join(', ');
      }

      const message = firstString([record.message], 'Provider command failed, but diagnostics were preserved.');
      const nextAction = formatNextAction(record).trim();
      let nextActionText = '';
      if (nextAction) {
        nextActionText = ` ${nextAction}`;
      }

      let blockingText = '';
      if (blockingKinds.length > 0) {
        blockingText = ` Blocking required surfaces: ${blockingKinds.map((kind) => code(kind)).join(', ')}.`;
      }

      return `- Captured ${kindText} at ${pathText}. ${message}${blockingText}${nextActionText}`;
    });
}

/**
 * Returns health checks whose status matches one of the requested values.
 *
 * @param {unknown[]} checks
 * @param {string[]} statuses
 * @returns {unknown[]}
 */
function filterChecksByStatus(checks: unknown[], statuses: string[]): unknown[] {
  const statusSet = new Set(statuses);
  return asArray(checks).filter((check) => {
    const record = check as SummaryRecord | null;
    return !!record && typeof record === 'object' && statusSet.has(firstString([record.status], 'unknown'));
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
      return !!record && typeof record === 'object' && record.pass === false && record.status !== 'unmeasurable';
    })
    .map((check) => {
      const record = check as SummaryRecord;
      const name = firstString([record.name], 'unknown budget');
      const metric = firstString([record.metric], 'unknown metric');
      return `- ${name}: ${metric} expected ${record.expected ?? 'n/a'}, actual ${record.actual ?? 'n/a'}`;
    });
}

/**
 * Formats unmeasurable budget checks as non-optimization guidance.
 *
 * @param {unknown[]} budgetChecks
 * @returns {string[]}
 */
function formatUnmeasurableBudgets(budgetChecks: unknown[]): string[] {
  return asArray(budgetChecks)
    .filter((check) => {
      const record = check as SummaryRecord | null;
      return !!record && typeof record === 'object' && record.status === 'unmeasurable';
    })
    .map((check) => {
      const record = check as SummaryRecord;
      const name = firstString([record.name], 'unknown budget');
      const metric = firstString([record.metric], 'unknown metric');
      const notes = firstString([record.notes], 'No measurable samples were available.');
      return `- ${name}: ${metric} was unmeasurable. ${notes}`;
    });
}

/**
 * Formats comparison provenance for agent-readable summaries.
 *
 * @param {SummaryRecord} comparison
 * @returns {string[]}
 */
function formatComparisonBasis(comparison: SummaryRecord): string[] {
  const basis = comparison.comparisonBasis;
  if (!basis || typeof basis !== 'object' || Array.isArray(basis)) {
    return [];
  }

  const basisRecord = basis as SummaryRecord;
  const baseline = basisRecord.baseline;
  const current = basisRecord.current;
  if (!baseline || typeof baseline !== 'object' || !current || typeof current !== 'object') {
    return [];
  }

  const baselineRecord = baseline as SummaryRecord;
  const currentRecord = current as SummaryRecord;
  const lines = [
    '',
    '## comparison basis',
    '',
    `- Strategy: ${code(firstString([basisRecord.strategy], 'unknown'))}`,
    `- Baseline: ${code(firstString([baselineRecord.runId], 'unknown-baseline'))} at ${code(firstString([baselineRecord.runDir], 'unknown-dir'))}`,
    `- Current: ${code(firstString([currentRecord.runId], 'unknown-current'))} at ${code(firstString([currentRecord.runDir], 'unknown-dir'))}`,
  ];

  const selection = basisRecord.selection;
  if (selection && typeof selection === 'object' && !Array.isArray(selection)) {
    const selectionRecord = selection as SummaryRecord;
    lines.push(
      `- Selection: inspected ${selectionRecord.candidatesInspected ?? 'unknown'}, trusted ${selectionRecord.trustedCandidates ?? 'unknown'}, trusted prior ${selectionRecord.trustedPriorCandidates ?? 'unknown'}, skipped current ${selectionRecord.skippedCurrentRun ?? 'unknown'}`,
    );
  }

  return lines;
}

/**
 * Formats attempt terminal semantics for agent-readable summaries.
 *
 * @param {SummaryRecord | null | undefined} manifest
 * @returns {string[]}
 */
function formatAttempt(manifest: SummaryRecord | null | undefined): string[] {
  const attempt = manifest?.attempt;
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    return [];
  }

  const attemptRecord = attempt as SummaryRecord;
  const classification = attemptRecord.classification && typeof attemptRecord.classification === 'object' && !Array.isArray(attemptRecord.classification)
    ? attemptRecord.classification as SummaryRecord
    : {};
  const cleanup = attemptRecord.cleanup && typeof attemptRecord.cleanup === 'object' && !Array.isArray(attemptRecord.cleanup)
    ? attemptRecord.cleanup as SummaryRecord
    : {};
  const partialArtifacts = attemptRecord.partialArtifacts && typeof attemptRecord.partialArtifacts === 'object' && !Array.isArray(attemptRecord.partialArtifacts)
    ? attemptRecord.partialArtifacts as SummaryRecord
    : {};
  const retryOfAttemptId = firstString([attemptRecord.retryOfAttemptId], '');
  const retryReason = firstString([attemptRecord.retryReason], '');
  const lines = [
    '',
    '## attempt',
    '',
    `- Attempt: ${code(firstString([attemptRecord.attemptId], 'unknown-attempt'))} (${attemptRecord.attemptNumber ?? 'unknown'}/${attemptRecord.maxAttempts ?? 'unknown'})`,
    `- Terminal state: ${code(firstString([attemptRecord.terminalState], 'unknown'))}`,
    `- Classification: ${code(firstString([classification.category], 'unknown'))}${classification.code ? ` ${code(classification.code)}` : ''}`,
    `- Cleanup: ${code(firstString([cleanup.status], 'unknown'))}`,
    `- Partial artifacts valid: ${partialArtifacts.valid === true ? 'true' : 'false'} - ${firstString([partialArtifacts.reason], 'no reason recorded')}`,
  ];

  if (retryOfAttemptId || retryReason) {
    lines.push(`- Retry lineage: previous=${code(retryOfAttemptId || 'unknown')} reason=${retryReason || 'not recorded'}`);
  }

  if (Array.isArray(partialArtifacts.paths) && partialArtifacts.paths.length > 0) {
    lines.push(`- Partial artifact paths: ${partialArtifacts.paths.map((item) => code(item)).join(', ')}`);
  }

  return lines;
}

/**
 * Builds the minimum agent-facing markdown summary for a run.
 *
 * @param {{health: Record<string, unknown>, verdict: Record<string, unknown>, comparison?: Record<string, unknown> | null, manifest?: Record<string, unknown> | null}} options
 * @returns {string}
 */
function buildAgentSummaryMarkdown({ health, verdict, comparison = null, manifest = null }: AgentSummaryInput): string {
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

  const healthChecks = asArray(health?.checks);
  const failedChecks = filterChecksByStatus(healthChecks, ['failed']);
  if (failedChecks.length > 0) {
    lines.push('', '## failed checks', '', ...formatChecks(failedChecks));
  }

  const partialChecks = filterChecksByStatus(healthChecks, ['partial']);
  if (partialChecks.length > 0) {
    lines.push('', '## partial checks', '', ...formatChecks(partialChecks));
  }

  const warnings = [
    ...filterChecksByStatus(healthChecks, ['warning']),
    ...asArray(health?.warnings),
  ];
  if (warnings.length > 0) {
    lines.push('', '## warnings', '', ...formatChecks(warnings));
  }

  const preservedProviderEvidence = formatPreservedProviderEvidence(healthChecks);
  if (preservedProviderEvidence.length > 0) {
    lines.push('', '## preserved diagnostic evidence', '', ...preservedProviderEvidence);
  }

  const failedBudgets = formatFailedBudgets(asArray(verdict?.budgetChecks));
  if (failedBudgets.length > 0) {
    lines.push('', '## failed budgets', '', ...failedBudgets);
  }

  const unmeasurableBudgets = formatUnmeasurableBudgets(asArray(verdict?.budgetChecks));
  if (unmeasurableBudgets.length > 0) {
    lines.push('', '## unmeasurable budgets', '', ...unmeasurableBudgets);
  }

  lines.push(...formatAttempt(manifest));

  if (comparison) {
    lines.push('', '## comparison', '', firstString([comparison.summary], 'No comparison summary provided.'));
    lines.push(...formatComparisonBasis(comparison));
  }

  return `${lines.join('\n')}\n`;
}

export {
  buildAgentSummaryMarkdown,
};

export type {
  AgentSummaryInput,
  SummaryRecord,
};
type SummaryRecord = Record<string, unknown>;

type AgentSummaryInput = {
  health: SummaryRecord;
  verdict: SummaryRecord;
  comparison?: SummaryRecord | null;
  manifest?: SummaryRecord | null;
};
