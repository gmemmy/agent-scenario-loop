const PROFILE_EVENT_PREFIX = '[profile-event]';

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKeyValueProfileEvent(payload) {
  const matches = payload.match(/(?:[^\s=]+)=(?:"[^"]*"|'[^']*'|[^\s]+)/gu) ?? [];
  if (matches.length === 0) {
    return null;
  }

  const event = {};
  for (const match of matches) {
    const separatorIndex = match.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = match.slice(0, separatorIndex);
    let value = match.slice(separatorIndex + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    event[key] = value;
  }

  if (
    typeof event.event !== 'string' ||
    typeof event.scenario !== 'string' ||
    typeof event.runId !== 'string'
  ) {
    return null;
  }

  const iteration = coerceNumber(event.iteration);
  const atMs = coerceNumber(event.atMs) ?? coerceNumber(event.timestamp);
  if (iteration !== null) {
    event.iteration = iteration;
  }
  if (atMs !== null) {
    event.atMs = atMs;
  }

  return event;
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(values, percentileValue) {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return roundMs(sorted[index]);
}

function extractProfileEvents(logText, filters = {}) {
  const { runId, scenario } = filters;

  return String(logText)
    .split(/\r?\n/u)
    .flatMap((line) => {
      const prefixIndex = line.indexOf(PROFILE_EVENT_PREFIX);
      if (prefixIndex === -1) {
        return [];
      }

      const payload = line.slice(prefixIndex + PROFILE_EVENT_PREFIX.length).trim();
      if (!payload) {
        return [];
      }

      try {
        const event = JSON.parse(payload);
        if (!event || typeof event !== 'object') {
          return [];
        }

        if (runId && event.runId !== runId) {
          return [];
        }

        if (scenario && event.scenario !== scenario) {
          return [];
        }

        return [event];
      } catch {
        const event = parseKeyValueProfileEvent(payload);
        if (!event) {
          return [];
        }

        if (runId && event.runId !== runId) {
          return [];
        }

        if (scenario && event.scenario !== scenario) {
          return [];
        }

        return [event];
      }
    });
}

function buildMetricsFromProfileEvents({
  scenario,
  runId,
  events,
  expectedIterations,
  timeoutCount = 0,
  artifacts = {},
  cycleEventNames = null,
  budgets = null,
}) {
  const resolvedCycleEventNames = {
    openRequested: cycleEventNames?.openRequested ?? 'surface_open_requested',
    opened: cycleEventNames?.opened ?? 'surface_opened',
    closeRequested: cycleEventNames?.closeRequested ?? 'surface_close_requested',
    dismissed: cycleEventNames?.dismissed ?? 'surface_dismissed',
  };
  const iterations = new Map();

  for (const event of [...events].sort((left, right) => {
    const leftAt = typeof left.atMs === 'number' ? left.atMs : Number.POSITIVE_INFINITY;
    const rightAt = typeof right.atMs === 'number' ? right.atMs : Number.POSITIVE_INFINITY;
    return leftAt - rightAt;
  })) {
    if (typeof event.iteration !== 'number') {
      continue;
    }

    const current = iterations.get(event.iteration) ?? {};
    if (event.event === resolvedCycleEventNames.openRequested) {
      current.presentRequestedAt = event.atMs;
    }
    if (event.event === resolvedCycleEventNames.opened) {
      current.openedAt = event.atMs;
    }
    if (event.event === resolvedCycleEventNames.closeRequested) {
      current.closeRequestedAt = event.atMs;
    }
    if (event.event === resolvedCycleEventNames.dismissed) {
      current.dismissedAt = event.atMs;
    }

    iterations.set(event.iteration, current);
  }

  const durationsMs = [];
  const openDurationsMs = [];
  const closeDurationsMs = [];
  const incompleteIterations = [];
  let failures = 0;

  for (let iteration = 1; iteration <= expectedIterations; iteration += 1) {
    const record = iterations.get(iteration);
    if (!record) {
      failures += 1;
      incompleteIterations.push(iteration);
      continue;
    }

    const hasCycleDuration =
      typeof record.presentRequestedAt === 'number' &&
      typeof record.dismissedAt === 'number' &&
      record.dismissedAt >= record.presentRequestedAt;
    const hasOpenDuration =
      typeof record.presentRequestedAt === 'number' &&
      typeof record.openedAt === 'number' &&
      record.openedAt >= record.presentRequestedAt;
    const hasCloseDuration =
      typeof record.closeRequestedAt === 'number' &&
      typeof record.dismissedAt === 'number' &&
      record.dismissedAt >= record.closeRequestedAt;

    if (hasCycleDuration) {
      durationsMs.push(roundMs(record.dismissedAt - record.presentRequestedAt));
    }
    if (hasOpenDuration) {
      openDurationsMs.push(roundMs(record.openedAt - record.presentRequestedAt));
    }
    if (hasCloseDuration) {
      closeDurationsMs.push(roundMs(record.dismissedAt - record.closeRequestedAt));
    }

    if (!(hasCycleDuration && hasOpenDuration && hasCloseDuration)) {
      failures += 1;
      incompleteIterations.push(iteration);
    }
  }

  const metrics = {
    scenario,
    runId,
    status: failures === 0 && timeoutCount === 0 ? 'passed' : 'failed',
    iterations: expectedIterations,
    durationsMs,
    p50Ms: percentile(durationsMs, 50),
    p95Ms: percentile(durationsMs, 95),
    failures,
    timeouts: timeoutCount,
    openDurationsMs,
    closeDurationsMs,
    incompleteIterations,
    artifacts: sortValue(artifacts),
  };

  const budgetEvaluation = evaluateProfileBudgets({ metrics, budgets });
  if (budgetEvaluation) {
    metrics.budgetEvaluation = sortValue(budgetEvaluation);
  }

  return metrics;
}

function evaluateBudgetCheck({ name, actual, limit }) {
  if (typeof limit !== 'number') {
    return null;
  }

  const pass = typeof actual === 'number' && actual <= limit;
  return {
    name,
    actual,
    limit,
    pass,
    unit: 'ms',
  };
}

function evaluateProfileBudgets({ metrics, budgets }) {
  if (!budgets?.pass || typeof budgets.pass !== 'object') {
    return null;
  }

  const checks = [
    evaluateBudgetCheck({
      name: 'cycle p50',
      actual: metrics.p50Ms,
      limit: budgets.pass.cycleP50Ms,
    }),
    evaluateBudgetCheck({
      name: 'cycle p95',
      actual: metrics.p95Ms,
      limit: budgets.pass.cycleP95Ms,
    }),
    evaluateBudgetCheck({
      name: 'open p50',
      actual: percentile(metrics.openDurationsMs, 50),
      limit: budgets.pass.openP50Ms,
    }),
    evaluateBudgetCheck({
      name: 'open p95',
      actual: percentile(metrics.openDurationsMs, 95),
      limit: budgets.pass.openP95Ms,
    }),
    evaluateBudgetCheck({
      name: 'close p50',
      actual: percentile(metrics.closeDurationsMs, 50),
      limit: budgets.pass.closeP50Ms,
    }),
    evaluateBudgetCheck({
      name: 'close p95',
      actual: percentile(metrics.closeDurationsMs, 95),
      limit: budgets.pass.closeP95Ms,
    }),
    evaluateBudgetCheck({
      name: 'scroll p50',
      actual: metrics.p50Ms,
      limit: budgets.pass.scrollP50Ms,
    }),
    evaluateBudgetCheck({
      name: 'scroll p95',
      actual: metrics.p95Ms,
      limit: budgets.pass.scrollP95Ms,
    }),
    evaluateBudgetCheck({
      name: 'first visible p50',
      actual: metrics.firstVisibleP50Ms,
      limit: budgets.pass.firstVisibleP50Ms,
    }),
    evaluateBudgetCheck({
      name: 'first visible p95',
      actual: metrics.firstVisibleP95Ms,
      limit: budgets.pass.firstVisibleP95Ms,
    }),
  ].filter(Boolean);

  const thresholdChecks = [
    typeof budgets.pass.failures === 'number'
      ? {
          name: 'failures',
          actual: metrics.failures,
          limit: budgets.pass.failures,
          pass: metrics.failures <= budgets.pass.failures,
          unit: 'count',
        }
      : null,
    typeof budgets.pass.timeouts === 'number'
      ? {
          name: 'timeouts',
          actual: metrics.timeouts,
          limit: budgets.pass.timeouts,
          pass: metrics.timeouts <= budgets.pass.timeouts,
          unit: 'count',
        }
      : null,
  ].filter(Boolean);

  const allChecks = [...thresholdChecks, ...checks];
  if (allChecks.length === 0) {
    return null;
  }

  return {
    metric: budgets.metric ?? metrics.measurement ?? 'profile budget',
    pass: allChecks.every((check) => check.pass),
    checks: allChecks,
    failedChecks: allChecks.filter((check) => !check.pass).map((check) => check.name),
  };
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return [...value].sort().map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortValue(value[key]);
        return result;
      }, {});
  }

  return value;
}

function normalizeEventTimestamp({ event, startedAt }) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  if (typeof event.atMs === 'number' && Number.isFinite(event.atMs)) {
    return roundMs(event.atMs);
  }

  const eventTimestamp =
    typeof event.timestamp === 'number'
      ? event.timestamp
      : typeof event.timestamp === 'string' && event.timestamp.length > 0
        ? Number(event.timestamp)
        : null;
  const startedAtEpochMs =
    typeof startedAt === 'string' && startedAt.length > 0 ? Date.parse(startedAt) : Number.NaN;

  if (Number.isFinite(eventTimestamp) && Number.isFinite(startedAtEpochMs)) {
    return roundMs(Math.max(0, eventTimestamp - startedAtEpochMs));
  }

  return null;
}

function inferTimelinePhase(eventName) {
  if (typeof eventName !== 'string' || eventName.length === 0) {
    return 'domain';
  }

  const normalized = eventName.toLowerCase();

  if (
    normalized.includes('requested') ||
    normalized.includes('tapped') ||
    normalized.includes('tap') ||
    normalized.includes('intent')
  ) {
    return 'intent';
  }

  if (
    normalized.includes('route') ||
    normalized.includes('presented') ||
    normalized.includes('dismissed') ||
    normalized.includes('opened')
  ) {
    return 'navigation';
  }

  if (normalized.includes('query') || normalized.includes('cache')) {
    return 'query';
  }

  if (
    normalized.includes('request') ||
    normalized.includes('response') ||
    normalized.includes('network')
  ) {
    return 'network';
  }

  if (
    normalized.includes('render') ||
    normalized.includes('mounted') ||
    normalized.includes('shell_ready')
  ) {
    return 'render';
  }

  if (
    normalized.includes('native') ||
    normalized.includes('frame') ||
    normalized.includes('hitch')
  ) {
    return 'native';
  }

  if (
    normalized.includes('visible') ||
    normalized.includes('usable') ||
    normalized.includes('committed')
  ) {
    return 'visual';
  }

  if (
    normalized.includes('finished') ||
    normalized.includes('completed') ||
    normalized.includes('settled')
  ) {
    return 'completion';
  }

  return 'domain';
}

function inferTimelineStatus(eventName) {
  if (typeof eventName !== 'string' || eventName.length === 0) {
    return 'observed';
  }

  const normalized = eventName.toLowerCase();
  if (normalized.includes('failed')) {
    return 'failed';
  }
  if (normalized.includes('requested') || normalized.includes('started')) {
    return 'started';
  }
  if (
    normalized.includes('opened') ||
    normalized.includes('dismissed') ||
    normalized.includes('committed') ||
    normalized.includes('visible') ||
    normalized.includes('ready') ||
    normalized.includes('settled') ||
    normalized.includes('completed') ||
    normalized.includes('finished')
  ) {
    return 'completed';
  }
  return 'observed';
}

function buildCausalTimeline({ events, startedAt, phaseMap = null, owner = null }) {
  return [...(Array.isArray(events) ? events : [])]
    .map((event) => {
      if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
        return null;
      }

      const atMs = normalizeEventTimestamp({ event, startedAt });
      if (atMs === null) {
        return null;
      }

      const eventMetadata =
        event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
          ? event.metadata
          : {};
      const explicitPhase =
        typeof event.phase === 'string'
          ? event.phase
          : phaseMap && typeof phaseMap[event.event] === 'string'
            ? phaseMap[event.event]
            : null;
      const metadata = {
        ...eventMetadata,
        ...(typeof event.flowId === 'string' ? { flowId: event.flowId } : {}),
        ...(typeof event.route === 'string' ? { route: event.route } : {}),
        ...(typeof event.iteration === 'number' ? { iteration: event.iteration } : {}),
      };

      return sortValue({
        phase: explicitPhase ?? inferTimelinePhase(event.event),
        name: event.event,
        atMs,
        status:
          typeof event.status === 'string' ? event.status : inferTimelineStatus(event.event),
        ...((typeof event.owner === 'string' && event.owner.length > 0) || owner
          ? { owner: event.owner || owner }
          : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    })
    .filter(Boolean)
    .sort((left, right) => left.atMs - right.atMs);
}

function buildBudgetVerdict({
  flowId,
  runId,
  budgetEvaluation,
  visualOutcome = null,
  baselineRunId = null,
}) {
  if (!budgetEvaluation) {
    return null;
  }

  const hasManualVisualReview =
    visualOutcome &&
    Array.isArray(visualOutcome.checks) &&
    visualOutcome.checks.some((check) => check.status === 'manual-review-needed');

  return sortValue({
    schemaVersion: '1.0.0',
    flowId,
    runId,
    status: hasManualVisualReview
      ? 'partial'
      : budgetEvaluation.pass
        ? 'passed'
        : 'failed',
    checks: (budgetEvaluation.checks ?? []).map((check) => ({
      name: check.name,
      metric: budgetEvaluation.metric ?? 'profile budget',
      unit: check.unit,
      expected: check.limit,
      actual: check.actual ?? null,
      pass: check.pass,
    })),
    ...(visualOutcome ? { visualOutcome } : {}),
    ...(baselineRunId
      ? {
          regression: {
            baselineRunId,
            status: 'unknown',
            summary: 'Baseline comparison not implemented yet.',
          },
        }
      : {}),
  });
}

function inferBudgetUnit(name) {
  if (typeof name !== 'string') {
    return 'count';
  }

  if (/ms$/u.test(name) || /p50|p95|duration|cycle|visible|open|close/u.test(name)) {
    return 'ms';
  }

  return 'count';
}

function normalizeBudgetsForCausalRun(budgets) {
  if (!budgets || typeof budgets !== 'object') {
    return {};
  }

  return Object.keys(budgets).reduce((result, key) => {
    const limit = budgets[key];
    if (typeof limit !== 'number' && typeof limit !== 'boolean') {
      return result;
    }

    result[key] = {
      metric: key,
      unit: inferBudgetUnit(key),
      limit,
    };
    return result;
  }, {});
}

function buildCausalRun({
  scenario,
  flowId,
  runId,
  platform = 'ios',
  buildFlavor = 'unknown',
  interactionDriver,
  trigger = null,
  budgets = null,
  timeline = [],
  artifacts,
  manifest,
  metrics,
}) {
  return sortValue({
    schemaVersion: '1.0.0',
    flowId,
    runId,
    platform,
    buildFlavor,
    scenario: {
      id: scenario.name,
      driver: interactionDriver,
      ...(typeof metrics?.iterations === 'number' ? { iterations: metrics.iterations } : {}),
    },
    trigger:
      trigger && typeof trigger === 'object'
        ? trigger
        : {
            kind: 'unknown',
            label: scenario.description ?? scenario.name,
          },
    budgets: normalizeBudgetsForCausalRun(budgets),
    timeline,
    artifacts: {
      summary: artifacts.summary,
      metrics: artifacts.metrics,
      manifest: artifacts.manifest,
      video: artifacts.captures?.video,
      screenshot: Array.isArray(artifacts.captures?.screenshots)
        ? artifacts.captures.screenshots[0] ?? null
        : null,
      signals: artifacts.signals,
    },
    notes: [
      `Manifest status: ${manifest.status}`,
      `Metrics status: ${metrics.status}`,
    ],
  });
}

function buildManifest({
  scenario,
  runId,
  platform = 'ios',
  status,
  startedAt,
  endedAt,
  interactionDriver,
  simulator,
  bundleId,
  gitSha,
  toolVersions,
  artifacts,
  failureReason = null,
}) {
  return {
    scenario,
    runId,
    platform,
    status,
    startedAt,
    endedAt,
    durationMs: roundMs(Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))),
    interactionDriver,
    simulator: sortValue(simulator),
    bundleId,
    gitSha,
    toolVersions: sortValue(toolVersions),
    artifacts: sortValue(artifacts),
    failureReason,
  };
}

function buildSummaryMarkdown({ manifest, metrics }) {
  const signalLines = [
    `- JS: ${
      manifest.artifacts.signals.js.length > 0
        ? manifest.artifacts.signals.js.map((item) => `\`${item}\``).join(', ')
        : 'none'
    }`,
    `- Memory: ${
      manifest.artifacts.signals.memory.length > 0
        ? manifest.artifacts.signals.memory.map((item) => `\`${item}\``).join(', ')
        : 'none'
    }`,
    `- Network: ${
      manifest.artifacts.signals.network.length > 0
        ? manifest.artifacts.signals.network.map((item) => `\`${item}\``).join(', ')
        : 'none'
    }`,
  ];
  const lines = [
    `# ${String(manifest.platform || 'ios').toUpperCase()} profile run: ${manifest.scenario}`,
    '',
    `- Status: ${manifest.status}`,
    `- Run ID: \`${manifest.runId}\``,
    `- Interaction driver: \`${manifest.interactionDriver}\``,
    `- Simulator: ${manifest.simulator.name} (${manifest.simulator.udid})`,
    `- Bundle ID: \`${manifest.bundleId}\``,
    `- Iterations: ${metrics.iterations}`,
    `- Completed cycles: ${metrics.durationsMs.length}/${metrics.iterations}`,
    `- Failures: ${metrics.failures}`,
    `- Timeouts: ${metrics.timeouts}`,
    `- p50 cycle: ${metrics.p50Ms === null ? 'n/a' : `${metrics.p50Ms}ms`}`,
    `- p95 cycle: ${metrics.p95Ms === null ? 'n/a' : `${metrics.p95Ms}ms`}`,
    '',
    '## Artifact paths',
    '',
    `- Causal run: \`${manifest.artifacts.causalRun}\``,
    `- Budget verdict: ${
      metrics.budgetEvaluation ? `\`${manifest.artifacts.budgetVerdict}\`` : 'none (no budgets configured)'
    }`,
    `- Manifest: \`${manifest.artifacts.manifest}\``,
    `- Scenario: \`${manifest.artifacts.scenario}\``,
    `- Metrics: \`${manifest.artifacts.metrics}\``,
    `- Interaction log: \`${manifest.artifacts.raw.interactionLog}\``,
    `- Device log: \`${manifest.artifacts.raw.deviceLog}\``,
    `- Video: \`${manifest.artifacts.captures.video}\``,
    `- UI tree: \`${manifest.artifacts.captures.uiTree}\``,
    '',
    '## Signal attachments',
    '',
    ...signalLines,
  ];

  if (metrics.budgetEvaluation) {
    lines.push(
      '',
      '## Budget',
      '',
      `- Metric: ${metrics.budgetEvaluation.metric}`,
      `- Status: ${metrics.budgetEvaluation.pass ? 'pass' : 'fail'}`,
    );

    for (const check of metrics.budgetEvaluation.checks) {
      const formatValue = (value) => {
        if (typeof value !== 'number') {
          return value ?? 'n/a';
        }

        return check.unit === 'ms' ? `${value}ms` : String(value);
      };
      lines.push(`- ${check.name}: ${formatValue(check.actual)} / ${formatValue(check.limit)}`);
    }
  }

  if (metrics.openDurationsMs.length > 0) {
    lines.push('', `- Open durations (ms): ${metrics.openDurationsMs.join(', ')}`);
  }

  if (metrics.closeDurationsMs.length > 0) {
    lines.push(`- Close durations (ms): ${metrics.closeDurationsMs.join(', ')}`);
  }

  if (metrics.incompleteIterations.length > 0) {
    lines.push(`- Incomplete iterations: ${metrics.incompleteIterations.join(', ')}`);
  }

  if (manifest.failureReason) {
    lines.push('', '## Failure', '', manifest.failureReason);
  }

  return lines.join('\n');
}

function extractCandidateIdentifiers(rawDescription) {
  const seen = new Set();
  const identifiers = [];
  const push = (value) => {
    if (typeof value !== 'string') {
      return;
    }

    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    identifiers.push(normalized);
  };

  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (!value || typeof value !== 'object') {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (
        key === 'id' ||
        key === 'identifier' ||
        key === 'accessibilityIdentifier' ||
        key === 'AXUniqueId' ||
        key === 'AXLabel' ||
        key === 'testID' ||
        key === 'testId'
      ) {
        push(child);
      }

      visit(child);
    }
  };

  try {
    visit(JSON.parse(rawDescription));
  } catch {
    // Fall back to a raw regex scan when the driver output is not JSON.
  }

  const matches = String(rawDescription).match(/[A-Za-z0-9][A-Za-z0-9._:-]{2,}/gu) ?? [];
  for (const match of matches) {
    push(match);
  }

  return identifiers;
}

function findMatchingIdentifier(rawDescription, pattern) {
  const regex = new RegExp(pattern, 'u');
  const identifier = extractCandidateIdentifiers(rawDescription).find((candidate) =>
    regex.test(candidate),
  );

  if (identifier) {
    return identifier;
  }

  return String(rawDescription).match(regex)?.[0] ?? null;
}

function evaluateUiContract({ rawDescription, requiredIdentifierPatterns = [] }) {
  const checks = requiredIdentifierPatterns.map((pattern) => {
    const matchedIdentifier = findMatchingIdentifier(rawDescription, pattern);
    return {
      pattern,
      pass: Boolean(matchedIdentifier),
      matchedIdentifier,
    };
  });

  return {
    pass: checks.every((check) => check.pass),
    checks,
    missingPatterns: checks.filter((check) => !check.pass).map((check) => check.pattern),
  };
}

module.exports = {
  PROFILE_EVENT_PREFIX,
  buildBudgetVerdict,
  buildCausalRun,
  buildCausalTimeline,
  buildManifest,
  buildMetricsFromProfileEvents,
  buildSummaryMarkdown,
  evaluateUiContract,
  extractCandidateIdentifiers,
  extractProfileEvents,
  evaluateProfileBudgets,
  findMatchingIdentifier,
  percentile,
  sortValue,
};
