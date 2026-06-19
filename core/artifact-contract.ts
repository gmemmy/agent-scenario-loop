const PROFILE_EVENT_PREFIX = '[profile-event]';

type ArtifactRecord = Record<string, any>;
type ProfileEvent = ArtifactRecord & {
  event?: string;
  scenario?: string;
  runId?: string;
  iteration?: number;
  atMs?: number;
  timestamp?: number | string;
};

const CAUSAL_TIMELINE_PHASES = new Set([
  'intent',
  'navigation',
  'domain',
  'query',
  'network',
  'render',
  'native',
  'visual',
  'completion',
]);
const CAUSAL_TIMELINE_STATUSES = new Set([
  'started',
  'completed',
  'failed',
  'skipped',
  'observed',
]);

type BudgetCheck = {
  name: string;
  actual: unknown;
  limit: number;
  pass: boolean;
  unit: string;
};

/**
 * Converts finite numeric strings to numbers while preserving invalid input as `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses legacy key/value `[profile-event]` payloads into structured event objects.
 *
 * @param {string} payload
 * @returns {Record<string, unknown> | null}
 */
function parseKeyValueProfileEvent(payload: string): ProfileEvent | null {
  const matches = payload.match(/(?:[^\s=]+)=(?:"[^"]*"|'[^']*'|[^\s]+)/gu) ?? [];
  if (matches.length === 0) {
    return null;
  }

  const event: ProfileEvent = {};
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

/**
 * Rounds millisecond values to a stable artifact precision.
 *
 * @param {number} value
 * @returns {number}
 */
function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Returns a nearest-rank percentile for numeric measurements.
 *
 * @param {number[]} values
 * @param {number} percentileValue
 * @returns {number | null}
 */
function percentile(values: number[], percentileValue: number): number | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  const value = sorted[index];
  return typeof value === 'number' ? roundMs(value) : null;
}

/**
 * Extracts structured profile events from device logs.
 *
 * Supports both JSON payloads and the older key/value payload format.
 *
 * @param {string} logText
 * @param {{runId?: string, scenario?: string}} [filters]
 * @returns {Record<string, unknown>[]}
 */
function extractProfileEvents(logText: string, filters: { runId?: string; scenario?: string } = {}): ProfileEvent[] {
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

/**
 * Builds timing metrics from app-emitted profile events.
 *
 * @param {{scenario: string, runId: string, events: Record<string, unknown>[], expectedIterations: number, timeoutCount?: number, artifacts?: Record<string, unknown>, cycleEventNames?: Record<string, string> | null, budgets?: Record<string, unknown> | null}} options
 * @returns {Record<string, unknown>}
 */
function buildMetricsFromProfileEvents({
  scenario,
  runId,
  events,
  expectedIterations,
  timeoutCount = 0,
  artifacts = {},
  cycleEventNames = null,
  budgets = null,
}: {
  scenario: string;
  runId: string;
  events: ProfileEvent[];
  expectedIterations: number;
  timeoutCount?: number;
  artifacts?: ArtifactRecord;
  cycleEventNames?: ArtifactRecord | null;
  budgets?: ArtifactRecord | null;
}): ArtifactRecord {
  const resolvedCycleEventNames = {
    openRequested: cycleEventNames?.openRequested ?? 'surface_open_requested',
    opened: cycleEventNames?.opened ?? 'surface_opened',
    closeRequested: cycleEventNames?.closeRequested ?? 'surface_close_requested',
    dismissed: cycleEventNames?.dismissed ?? 'surface_dismissed',
    milestone: cycleEventNames?.milestone,
  };
  const usesMilestoneOnlyCycle = typeof resolvedCycleEventNames.milestone === 'string';
  const iterations = new Map();

  for (const event of [...events].sort((left, right) => {
    const leftAt = typeof left.atMs === 'number' ? left.atMs : Number.POSITIVE_INFINITY;
    const rightAt = typeof right.atMs === 'number' ? right.atMs : Number.POSITIVE_INFINITY;
    return leftAt - rightAt;
  })) {
    const eventIteration = typeof event.iteration === 'number'
      ? event.iteration
      : expectedIterations === 1
        ? 1
        : null;
    if (eventIteration === null) {
      continue;
    }
    if (typeof event.atMs !== 'number') {
      continue;
    }

    const current = iterations.get(eventIteration) ?? {};
    if (
      event.event === resolvedCycleEventNames.openRequested &&
      typeof current.presentRequestedAt !== 'number'
    ) {
      current.presentRequestedAt = event.atMs;
    }
    if (
      event.event === resolvedCycleEventNames.opened &&
      typeof current.openedAt !== 'number' &&
      typeof current.presentRequestedAt === 'number' &&
      event.atMs >= current.presentRequestedAt
    ) {
      current.openedAt = event.atMs;
    }
    if (
      event.event === resolvedCycleEventNames.closeRequested &&
      typeof current.closeRequestedAt !== 'number'
    ) {
      current.closeRequestedAt = event.atMs;
    }
    if (
      event.event === resolvedCycleEventNames.dismissed &&
      typeof current.dismissedAt !== 'number' &&
      typeof current.presentRequestedAt === 'number' &&
      typeof current.closeRequestedAt === 'number' &&
      event.atMs >= current.presentRequestedAt &&
      event.atMs >= current.closeRequestedAt
    ) {
      current.dismissedAt = event.atMs;
    }
    if (
      event.event === resolvedCycleEventNames.milestone &&
      typeof current.milestoneAt !== 'number'
    ) {
      current.milestoneAt = event.atMs;
    }

    iterations.set(eventIteration, current);
  }

  const durationsMs: number[] = [];
  const openDurationsMs: number[] = [];
  const closeDurationsMs: number[] = [];
  const incompleteIterations: number[] = [];
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
    const hasMilestoneDuration =
      usesMilestoneOnlyCycle &&
      typeof record.milestoneAt === 'number' &&
      record.milestoneAt >= 0;

    if (hasMilestoneDuration) {
      durationsMs.push(roundMs(record.milestoneAt));
      openDurationsMs.push(roundMs(record.milestoneAt));
    } else if (hasCycleDuration) {
      durationsMs.push(roundMs(record.dismissedAt - record.presentRequestedAt));
    }
    if (hasOpenDuration) {
      openDurationsMs.push(roundMs(record.openedAt - record.presentRequestedAt));
    }
    if (hasCloseDuration) {
      closeDurationsMs.push(roundMs(record.dismissedAt - record.closeRequestedAt));
    }

    const iterationComplete = usesMilestoneOnlyCycle
      ? hasMilestoneDuration
      : hasCycleDuration && hasOpenDuration && hasCloseDuration;
    if (!iterationComplete) {
      failures += 1;
      incompleteIterations.push(iteration);
    }
  }

  const metrics: ArtifactRecord = {
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

/**
 * Evaluates one numeric budget threshold.
 *
 * @param {{name: string, actual: unknown, limit: unknown}} options
 * @returns {{name: string, actual: unknown, limit: number, pass: boolean, unit: string} | null}
 */
function evaluateBudgetCheck({ name, actual, limit }: { name: string; actual: unknown; limit: unknown }): BudgetCheck | null {
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

/**
 * Evaluates configured profile budgets against generated metrics.
 *
 * @param {{metrics: Record<string, unknown>, budgets?: Record<string, unknown> | null}} options
 * @returns {Record<string, unknown> | null}
 */
function evaluateProfileBudgets({ metrics, budgets }: { metrics: ArtifactRecord; budgets?: ArtifactRecord | null }): ArtifactRecord | null {
  if (!budgets?.pass || typeof budgets.pass !== 'object') {
    return null;
  }

  const checks: BudgetCheck[] = [
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
  ].filter((check): check is BudgetCheck => Boolean(check));

  const thresholdChecks: BudgetCheck[] = [
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
  ].filter((check): check is BudgetCheck => Boolean(check));

  const allChecks: BudgetCheck[] = [...thresholdChecks, ...checks];
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

/**
 * Recursively sorts object keys and array values for stable JSON artifacts.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function sortValue(value: any): any {
  if (Array.isArray(value)) {
    return [...value].sort().map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<ArtifactRecord>((result, key) => {
        result[key] = sortValue(value[key]);
        return result;
      }, {});
  }

  return value;
}

/**
 * Normalizes event timestamps to milliseconds since run start.
 *
 * @param {{event: Record<string, unknown>, startedAt?: string}} options
 * @returns {number | null}
 */
function normalizeEventTimestamp({ event, startedAt }: { event: ProfileEvent; startedAt?: string }): number | null {
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

  if (eventTimestamp !== null && Number.isFinite(eventTimestamp) && Number.isFinite(startedAtEpochMs)) {
    return roundMs(Math.max(0, eventTimestamp - startedAtEpochMs));
  }

  return null;
}

/**
 * Infers a causal timeline phase from an event name when no explicit phase is provided.
 *
 * @param {unknown} eventName
 * @returns {string}
 */
function inferTimelinePhase(eventName: unknown): string {
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

/**
 * Infers timeline status from an event name when no explicit status is provided.
 *
 * @param {unknown} eventName
 * @returns {string}
 */
function inferTimelineStatus(eventName: unknown): string {
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

/**
 * Keeps causal-run timeline values within the public artifact schema.
 *
 * App-owned events may carry richer phase/status vocabulary than ASL's stable
 * artifact contract. Preserve that vocabulary in metadata, but emit only schema
 * values at the timeline top level.
 *
 * @param {{phase: string, status: string, metadata: Record<string, unknown>}} options
 * @returns {{phase: string, status: string, metadata: Record<string, unknown>}}
 */
function normalizeTimelineContractValues({
  metadata,
  phase,
  status,
}: {
  metadata: ArtifactRecord;
  phase: string;
  status: string;
}): {
  metadata: ArtifactRecord;
  phase: string;
  status: string;
} {
  const normalizedMetadata = { ...metadata };
  let normalizedPhase = phase;
  let normalizedStatus = status;

  if (!CAUSAL_TIMELINE_PHASES.has(normalizedPhase)) {
    normalizedMetadata.appPhase = normalizedPhase;
    normalizedPhase = 'domain';
  }

  if (!CAUSAL_TIMELINE_STATUSES.has(normalizedStatus)) {
    normalizedMetadata.appStatus = normalizedStatus;
    normalizedStatus = 'observed';
  }

  return {
    metadata: normalizedMetadata,
    phase: normalizedPhase,
    status: normalizedStatus,
  };
}

/**
 * Builds a causal timeline from app-owned profile events.
 *
 * @param {{events: Record<string, unknown>[], startedAt?: string, phaseMap?: Record<string, string> | null, owner?: string | null}} options
 * @returns {Record<string, unknown>[]}
 */
function buildCausalTimeline({
  events,
  startedAt,
  phaseMap = null,
  owner = null,
}: {
  events: ProfileEvent[];
  startedAt?: string;
  phaseMap?: ArtifactRecord | null;
  owner?: string | null;
}): ArtifactRecord[] {
  return [...(Array.isArray(events) ? events : [])]
    .map((event) => {
      if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
        return null;
      }

      const atMs = normalizeEventTimestamp({
        event,
        ...(typeof startedAt === 'string' ? { startedAt } : {}),
      });
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
      const timelineValues = normalizeTimelineContractValues({
        metadata,
        phase: explicitPhase ?? inferTimelinePhase(event.event),
        status: typeof event.status === 'string' ? event.status : inferTimelineStatus(event.event),
      });

      return sortValue({
        phase: timelineValues.phase,
        name: event.event,
        atMs,
        status: timelineValues.status,
        ...((typeof event.owner === 'string' && event.owner.length > 0) || owner
          ? { owner: event.owner || owner }
          : {}),
        ...(Object.keys(timelineValues.metadata).length > 0 ? { metadata: timelineValues.metadata } : {}),
      });
    })
    .filter(Boolean)
    .sort((left, right) => left.atMs - right.atMs);
}

/**
 * Builds the `budget-verdict.json` profile artifact from budget evaluation.
 *
 * @param {{flowId: string, runId: string, budgetEvaluation?: Record<string, unknown> | null, visualOutcome?: Record<string, unknown> | null, baselineRunId?: string | null}} options
 * @returns {Record<string, unknown> | null}
 */
function buildBudgetVerdict({
  flowId,
  runId,
  budgetEvaluation,
  visualOutcome = null,
  baselineRunId = null,
}: {
  flowId: string;
  runId: string;
  budgetEvaluation?: ArtifactRecord | null;
  visualOutcome?: ArtifactRecord | null;
  baselineRunId?: string | null;
}): ArtifactRecord | null {
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
    checks: (budgetEvaluation.checks ?? []).map((check: BudgetCheck) => ({
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
            summary: 'Regression status is unknown until comparison.json is produced for the baseline/current run folders.',
          },
        }
      : {}),
  });
}

/**
 * Infers the display unit for legacy budget keys.
 *
 * @param {unknown} name
 * @returns {string}
 */
function inferBudgetUnit(name: unknown): string {
  if (typeof name !== 'string') {
    return 'count';
  }

  if (/ms$/u.test(name) || /p50|p95|duration|cycle|visible|open|close/u.test(name)) {
    return 'ms';
  }

  return 'count';
}

/**
 * Normalizes legacy budget config into the causal-run budget shape.
 *
 * @param {Record<string, unknown> | null | undefined} budgets
 * @returns {Record<string, unknown>}
 */
function normalizeBudgetsForCausalRun(budgets: ArtifactRecord | null | undefined): ArtifactRecord {
  if (!budgets || typeof budgets !== 'object') {
    return {};
  }

  return Object.keys(budgets).reduce<ArtifactRecord>((result, key) => {
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

/**
 * Builds the `causal-run.json` profile artifact.
 *
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
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
}: ArtifactRecord): ArtifactRecord {
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
    provenanceRef: {
      manifest: artifacts.manifest,
      runId,
      ...(typeof manifest.scenarioHash === 'string' && manifest.scenarioHash.length > 0
        ? { scenarioHash: manifest.scenarioHash }
        : {}),
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
      evidenceAttachments: Array.isArray(artifacts.evidenceAttachments) ? artifacts.evidenceAttachments : [],
    },
    notes: [
      `Manifest status: ${manifest.status}`,
      `Metrics status: ${metrics.status}`,
    ],
  });
}

/**
 * Builds the run manifest artifact.
 *
 * @param {Record<string, unknown>} options
 * @returns {Record<string, unknown>}
 */
function buildManifest({
  scenario,
  scenarioHash,
  runId,
  attemptId,
  platform = 'ios',
  status,
  terminalState,
  startedAt,
  endedAt,
  interactionDriver,
  comparisonLane,
  classification,
  cleanup,
  partialArtifacts,
  simulator,
  bundleId,
  gitSha,
  toolVersions,
  artifacts,
  failureReason = null,
}: ArtifactRecord): ArtifactRecord {
  const durationMs = roundMs(Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)));
  const sortedToolVersions = sortValue(toolVersions);
  const sortedSimulator = sortValue(simulator);
  const resolvedTerminalState = typeof terminalState === 'string' && terminalState.length > 0 ? terminalState : status;
  const resolvedClassification = classification
    ? sortValue(classification)
    : {
        category: status === 'passed' ? 'none' : 'unknown',
      };
  const resolvedCleanup = cleanup
    ? sortValue(cleanup)
    : {
        status: 'not-required',
      };
  const resolvedPartialArtifacts = partialArtifacts
    ? sortValue(partialArtifacts)
    : {
        valid: status !== 'passed',
        reason:
          status === 'passed'
            ? 'complete successful run artifacts are present'
            : 'failed run artifacts are preserved for diagnosis and must not be treated as product proof unless health passes',
      };

  return {
    scenario,
    ...(typeof scenarioHash === 'string' && scenarioHash.length > 0 ? { scenarioHash } : {}),
    runId,
    platform,
    status,
    startedAt,
    endedAt,
    durationMs,
    interactionDriver,
    ...(typeof comparisonLane === 'string' && comparisonLane.length > 0 ? { comparisonLane } : {}),
    provenance: {
      ...(typeof scenarioHash === 'string' && scenarioHash.length > 0 ? { scenarioHash } : {}),
      gitSha,
      toolVersions: sortedToolVersions,
    },
    attempt: {
      attemptId: typeof attemptId === 'string' && attemptId.length > 0 ? attemptId : runId,
      runId,
      status,
      terminalState: resolvedTerminalState,
      startedAt,
      endedAt,
      durationMs,
      interactionDriver,
      ...(typeof comparisonLane === 'string' && comparisonLane.length > 0 ? { comparisonLane } : {}),
      classification: resolvedClassification,
      cleanup: resolvedCleanup,
      partialArtifacts: resolvedPartialArtifacts,
    },
    environment: {
      platform,
      bundleId,
      runtimeTarget: sortedSimulator,
      ...(typeof sortedToolVersions.node === 'string' ? { nodeVersion: sortedToolVersions.node } : {}),
    },
    simulator: sortedSimulator,
    bundleId,
    gitSha,
    toolVersions: sortedToolVersions,
    artifacts: sortValue(artifacts),
    failureReason,
  };
}

/**
 * Builds the human-readable profile summary.
 *
 * @param {{manifest: Record<string, unknown>, metrics: Record<string, unknown>}} options
 * @returns {string}
 */
function buildSummaryMarkdown({ manifest, metrics }: { manifest: ArtifactRecord; metrics: ArtifactRecord }): string {
  const runtimeLabel = manifest.platform === 'android' ? 'Device' : 'Simulator';
  const signalLines = [
    `- JS: ${
      manifest.artifacts.signals.js.length > 0
        ? manifest.artifacts.signals.js.map((item: string) => `\`${item}\``).join(', ')
        : 'none'
    }`,
    `- Memory: ${
      manifest.artifacts.signals.memory.length > 0
        ? manifest.artifacts.signals.memory.map((item: string) => `\`${item}\``).join(', ')
        : 'none'
    }`,
    `- Network: ${
      manifest.artifacts.signals.network.length > 0
        ? manifest.artifacts.signals.network.map((item: string) => `\`${item}\``).join(', ')
        : 'none'
    }`,
  ];
  const screenshots = Array.isArray(manifest.artifacts.captures.screenshots)
    ? manifest.artifacts.captures.screenshots
    : [];
  const evidenceAttachments = Array.isArray(manifest.artifacts.evidenceAttachments)
    ? manifest.artifacts.evidenceAttachments
    : [];
  const evidenceAttachmentLines = evidenceAttachments.length > 0
    ? evidenceAttachments.map((attachment: ArtifactRecord) =>
        `- ${attachment.channel}/${attachment.kind}: \`${attachment.path}\` (${attachment.sizeBytes} bytes, sha256 ${attachment.sha256})`,
      )
    : ['- none'];
  const lines = [
    `# ${String(manifest.platform || 'ios').toUpperCase()} profile run: ${manifest.scenario}`,
    '',
    `- Status: ${manifest.status}`,
    `- Run ID: \`${manifest.runId}\``,
    `- Interaction driver: \`${manifest.interactionDriver}\``,
    ...(typeof manifest.comparisonLane === 'string'
      ? [`- Comparison lane: \`${manifest.comparisonLane}\``]
      : []),
    `- ${runtimeLabel}: ${manifest.simulator.name} (${manifest.simulator.udid})`,
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
    `- Screenshots: ${
      screenshots.length > 0
        ? screenshots.map((item: string) => `\`${item}\``).join(', ')
        : 'none'
    }`,
    '',
    '## Signal attachments',
    '',
    ...signalLines,
    '',
    '## Evidence attachments',
    '',
    ...evidenceAttachmentLines,
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
      const formatValue = (value: unknown) => {
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

/**
 * Extracts possible accessibility or test identifiers from a UI tree dump.
 *
 * @param {string} rawDescription
 * @returns {string[]}
 */
function extractCandidateIdentifiers(rawDescription: string): string[] {
  const seen = new Set();
  const identifiers: string[] = [];
  const push = (value: unknown): void => {
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

  const visit = (value: unknown): void => {
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

/**
 * Finds the first UI identifier matching a required pattern.
 *
 * @param {string} rawDescription
 * @param {string} pattern
 * @returns {string | null}
 */
function findMatchingIdentifier(rawDescription: string, pattern: string): string | null {
  const regex = new RegExp(pattern, 'u');
  const identifier = extractCandidateIdentifiers(rawDescription).find((candidate) =>
    regex.test(candidate),
  );

  if (identifier) {
    return identifier;
  }

  return String(rawDescription).match(regex)?.[0] ?? null;
}

/**
 * Evaluates a UI contract from required identifier patterns.
 *
 * @param {{rawDescription: string, requiredIdentifierPatterns?: string[]}} options
 * @returns {{pass: boolean, checks: Record<string, unknown>[], missingPatterns: string[]}}
 */
function evaluateUiContract({
  rawDescription,
  requiredIdentifierPatterns = [],
}: {
  rawDescription: string;
  requiredIdentifierPatterns?: string[];
}): { pass: boolean; checks: ArtifactRecord[]; missingPatterns: string[] } {
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

export {
  PROFILE_EVENT_PREFIX,
  buildBudgetVerdict,
  buildCausalRun,
  buildCausalTimeline,
  buildManifest,
  buildMetricsFromProfileEvents,
  buildSummaryMarkdown,
  evaluateUiContract,
  evaluateProfileBudgets,
  extractCandidateIdentifiers,
  extractProfileEvents,
  findMatchingIdentifier,
  percentile,
  sortValue,
};

export type {
  ArtifactRecord,
  BudgetCheck,
  ProfileEvent,
};
