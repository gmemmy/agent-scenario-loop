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
 * Returns a summary record when the value is object-like.
 *
 * @param {unknown} value
 * @returns {SummaryRecord}
 */
function asSummaryRecord(value: unknown): SummaryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as SummaryRecord;
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
 * Formats diagnostics that survived an unhealthy provider or sidecar run.
 *
 * @param {unknown[]} checks
 * @returns {string[]}
 */
function formatPreservedDiagnosticEvidence(checks: unknown[]): string[] {
  return asArray(checks)
    .filter((check) => {
      const record = check as SummaryRecord | null;
      if (!record || typeof record !== 'object') {
        return false;
      }

      return record.code === 'partial_provider_evidence_preserved' ||
        record.code === 'partial_sidecar_evidence_preserved';
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
      const failedRequiredKinds = splitMetadataList(metadataRecord.failedRequiredKinds);
      let kindText = code('unknown');
      if (kinds.length > 0) {
        kindText = kinds.map((kind) => code(kind)).join(', ');
      }

      let pathText = code('not-recorded');
      if (paths.length > 0) {
        pathText = paths.map((item) => code(item)).join(', ');
      }

      let failedRequiredText = '';
      if (failedRequiredKinds.length > 0) {
        const failedText = failedRequiredKinds.map((kind) => code(kind)).join(', ');
        failedRequiredText = ` Missing required ${failedText}.`;
      }

      const message = firstString([record.message], 'Diagnostics were preserved from an unhealthy run.');
      const nextAction = formatNextAction(record).trim();
      let nextActionText = '';
      if (nextAction) {
        nextActionText = ` ${nextAction}`;
      }

      return `- Captured ${kindText} at ${pathText}.${failedRequiredText} ${message}${nextActionText}`;
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
 * Returns a lower-case matching string for a health or budget record.
 *
 * @param {SummaryRecord} record
 * @returns {string}
 */
function recordSearchText(record: SummaryRecord): string {
  const metadata = asSummaryRecord(record.metadata);
  return [
    record.code,
    record.name,
    record.source,
    record.status,
    metadata.nextActionCode,
    metadata.nextAction,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(' ')
    .toLowerCase();
}

/**
 * Returns whether text contains any of the target fragments.
 *
 * @param {string} text
 * @param {string[]} fragments
 * @returns {boolean}
 */
function containsAny(text: string, fragments: string[]): boolean {
  return fragments.some((fragment) => text.includes(fragment));
}

/**
 * Classifies the owner of the next useful action for an unhealthy check.
 *
 * @param {SummaryRecord} record
 * @returns {NextActionOwner}
 */
function classifyCheckOwner(record: SummaryRecord): NextActionOwner {
  const text = recordSearchText(record);

  if (containsAny(text, ['provider', 'diagnostic', 'accessibility_snapshot', 'ui_tree', 'native_performance'])) {
    return 'provider_tooling';
  }

  if (containsAny(text, [
    'runtime_identity',
    'foreground',
    'backgrounded',
    'bundle',
    'package',
    'metro',
    'dev_client',
    'launch_env',
    'adb_daemon',
    'simctl',
    'core_simulator',
    'xcode',
    'profile_session_stale',
    'stale',
  ])) {
    return 'runtime_environment';
  }

  if (containsAny(text, [
    'truth_events',
    'profile_session_start_missing',
    'milestone',
    'command_handler',
    'command_sequence',
    'app_truth',
  ])) {
    return 'app_truth';
  }

  if (containsAny(text, ['unmeasurable', 'interval_anchor', 'scenario_contract', 'missing_required_artifact'])) {
    return 'scenario_contract';
  }

  if (containsAny(text, ['finalization', 'sidecar', 'ingest', 'artifact_write', 'manifest'])) {
    return 'asl_runner';
  }

  return 'asl_runner';
}

/**
 * Ranks owner classes so summaries choose the safest blocker before optimization.
 *
 * @param {NextActionOwner} owner
 * @returns {number}
 */
function nextActionOwnerRank(owner: NextActionOwner): number {
  const rank: Record<NextActionOwner, number> = {
    runtime_environment: 0,
    asl_runner: 1,
    app_truth: 2,
    scenario_contract: 3,
    provider_tooling: 4,
    product_optimization: 5,
  };
  return rank[owner];
}

/**
 * Picks the health checks that should own next-action classification.
 *
 * Failed checks are the blocker. Warnings remain visible in the summary, but
 * they should not outrank a concrete failed provider, runtime, or app-truth
 * check when health is already failed.
 *
 * @param {SummaryRecord[]} checks
 * @returns {SummaryRecord[]}
 */
function selectNextActionHealthChecks(checks: SummaryRecord[]): SummaryRecord[] {
  const failedChecks = checks.filter(
    (record) => firstString([record.status], 'unknown') === 'failed',
  );
  if (failedChecks.length > 0) {
    return failedChecks;
  }

  return checks;
}

/**
 * Picks the most actionable owner from health and budget evidence.
 *
 * @param {{healthStatus: string, healthChecks: unknown[], verdictStatus: string, budgetChecks: unknown[]}} options
 * @returns {NextActionSummary}
 */
function resolveNextActionSummary({
  healthStatus,
  healthChecks,
  verdictStatus,
  budgetChecks,
}: {
  budgetChecks: unknown[];
  healthChecks: unknown[];
  healthStatus: string;
  verdictStatus: string;
}): NextActionSummary {
  const activeHealthChecks = asArray(healthChecks)
    .map((check) => asSummaryRecord(check))
    .filter((record) => firstString([record.status], 'unknown') !== 'passed');

  if (healthStatus !== 'passed' && activeHealthChecks.length > 0) {
    const ownerSourceChecks = selectNextActionHealthChecks(activeHealthChecks);
    const owners = ownerSourceChecks.map((record) => classifyCheckOwner(record));
    const owner = owners.sort((left, right) => nextActionOwnerRank(left) - nextActionOwnerRank(right))[0] ?? 'asl_runner';
    const ownerRecords = ownerSourceChecks.filter((record) => classifyCheckOwner(record) === owner);
    return nextActionSummaryForOwner(owner, ownerRecords);
  }

  const unmeasurableBudgets = asArray(budgetChecks)
    .map((check) => asSummaryRecord(check))
    .filter((record) => record.status === 'unmeasurable');
  if (unmeasurableBudgets.length > 0 || verdictStatus === 'inconclusive' || verdictStatus === 'not_evaluated') {
    return nextActionSummaryForOwner('scenario_contract', unmeasurableBudgets);
  }

  const failedBudgets = asArray(budgetChecks)
    .map((check) => asSummaryRecord(check))
    .filter((record) => record.pass === false && record.status !== 'unmeasurable');
  if (healthStatus === 'passed' && failedBudgets.length > 0) {
    return nextActionSummaryForOwner('product_optimization', failedBudgets);
  }

  if (healthStatus === 'passed' && verdictStatus === 'passed') {
    return {
      action: 'Use the artifact as trusted evidence or compare it against a compatible baseline.',
      owner: 'product_optimization',
      reason: 'scenario health and product verdict passed',
    };
  }

  return nextActionSummaryForOwner('asl_runner', []);
}

/**
 * Builds owner-specific next-action copy.
 *
 * @param {NextActionOwner} owner
 * @param {SummaryRecord[]} records
 * @returns {NextActionSummary}
 */
function nextActionSummaryForOwner(owner: NextActionOwner, records: SummaryRecord[]): NextActionSummary {
  const firstRecord = records[0] ?? {};
  const firstName = firstString([firstRecord.name, firstRecord.code], 'unknown_check');
  const summaries: Record<NextActionOwner, NextActionSummary> = {
    runtime_environment: {
      action: 'Fix target selection or runtime setup, then rerun before interpreting product timing.',
      owner,
      reason: `runtime evidence is invalid or unverified at ${firstName}`,
    },
    app_truth: {
      action: 'Repair app-owned scenario truth or command milestone emission, then rerun the same scenario.',
      owner,
      reason: `app-owned truth is incomplete at ${firstName}`,
    },
    provider_tooling: {
      action: 'Fix or downgrade provider diagnostics and use preserved outputs only as diagnostic evidence.',
      owner,
      reason: `provider evidence is incomplete at ${firstName}`,
    },
    asl_runner: {
      action: 'Inspect runner, sidecar, or artifact finalization before trusting this artifact.',
      owner,
      reason: `ASL artifact production needs attention at ${firstName}`,
    },
    scenario_contract: {
      action: 'Clarify scenario contracts or add interval anchors before making a product claim.',
      owner,
      reason: `the requested claim is not measurable at ${firstName}`,
    },
    product_optimization: {
      action: 'Treat the run as product evidence and investigate the failing budget or regression.',
      owner,
      reason: `scenario health passed and product budgets need attention at ${firstName}`,
    },
  };
  return summaries[owner];
}

/**
 * Formats the next-action owner section.
 *
 * @param {NextActionSummary} summary
 * @returns {string[]}
 */
function formatNextActionSummary(summary: NextActionSummary): string[] {
  return [
    '',
    '## next action',
    '',
    `- Owner: ${code(summary.owner)}`,
    `- Reason: ${summary.reason}`,
    `- Action: ${summary.action}`,
  ];
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
  const classification = asSummaryRecord(attemptRecord.classification);
  const cleanup = asSummaryRecord(attemptRecord.cleanup);
  const partialArtifacts = asSummaryRecord(attemptRecord.partialArtifacts);
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
  const budgetChecks = asArray(verdict?.budgetChecks);
  lines.push(...formatNextActionSummary(resolveNextActionSummary({
    budgetChecks,
    healthChecks,
    healthStatus,
    verdictStatus,
  })));

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

  const preservedDiagnosticEvidence = formatPreservedDiagnosticEvidence(healthChecks);
  if (preservedDiagnosticEvidence.length > 0) {
    lines.push('', '## preserved diagnostic evidence', '', ...preservedDiagnosticEvidence);
  }

  const failedBudgets = formatFailedBudgets(budgetChecks);
  if (failedBudgets.length > 0) {
    lines.push('', '## failed budgets', '', ...failedBudgets);
  }

  const unmeasurableBudgets = formatUnmeasurableBudgets(budgetChecks);
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

type NextActionOwner =
  | 'app_truth'
  | 'asl_runner'
  | 'product_optimization'
  | 'provider_tooling'
  | 'runtime_environment'
  | 'scenario_contract';

type NextActionSummary = {
  action: string;
  owner: NextActionOwner;
  reason: string;
};
