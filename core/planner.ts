type ManifestRecord = Record<string, unknown>;

type PlannerIssue = {
  code: string;
  message: string;
  [key: string]: unknown;
};

type CompatibilityResult = {
  compatible: boolean;
  errors: PlannerIssue[];
  warnings: PlannerIssue[];
  downgradePolicy: {
    mode: string;
    allowedSubstitutions: Array<Record<string, unknown>>;
    substitutions: Array<Record<string, unknown>>;
    unsupported: Array<Record<string, unknown>>;
    warnings: Array<Record<string, unknown>>;
  };
  matched: {
    platforms: string[];
    capabilities: string[];
    driverActions: string[];
    uiContexts: string[];
    artifacts: string[];
    evidenceProviders: string[];
    manifestVersions: Array<Record<string, unknown>>;
  };
};

type ScenarioStep = ManifestRecord & {
  adapterOptions?: unknown;
  driverAction?: unknown;
  id?: unknown;
  required?: unknown;
  selector?: unknown;
  uiContext?: unknown;
};

type ScenarioManifest = ManifestRecord & {
  adapterOptions?: unknown;
  budgets?: unknown;
  cycles?: unknown;
  id?: string;
  milestones?: unknown;
  name?: string;
  flowId?: string;
  metricEvents?: unknown;
  platforms?: unknown[];
  requiredCapabilities?: unknown[];
  optionalCapabilities?: unknown[];
  steps?: ScenarioStep[];
  artifacts?: {
    required?: unknown[];
    optional?: unknown[];
  };
};

type RunnerManifest = ManifestRecord & {
  schemaVersion?: string;
  runnerId?: string;
  name?: string;
  kind?: string;
  platforms?: unknown[];
  capabilities?: unknown[];
  driverActions?: unknown[];
  uiContexts?: unknown[];
  artifactOutputs?: unknown[];
};
const UI_DRIVER_ACTIONS = new Set([
  'tap',
  'longPress',
  'scroll',
  'swipe',
  'drag',
  'pinch',
  'rotate',
  'typeText',
  'focus',
  'pressKey',
  'pressButton',
  'assertVisible',
  'inspectTree',
  'screenshot',
  'record',
  'customGesture',
  'runSequence',
]);

/**
 * Returns `value` when it is already an array; otherwise returns an empty array.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns non-empty string values with duplicates removed and deterministic ordering.
 *
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueSorted(values: unknown[]): string[] {
  const strings = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(strings)].sort();
}

/**
 * Finds the unique string values shared by two arrays.
 *
 * @param {unknown[]} left
 * @param {unknown[]} right
 * @returns {string[]}
 */
function intersection(left: unknown[], right: unknown[]): string[] {
  const rightSet = new Set(asArray(right));
  return uniqueSorted(asArray(left).filter((value) => rightSet.has(value)));
}

/**
 * Returns required values that are absent from the available set.
 *
 * @param {unknown[]} available
 * @param {unknown[]} required
 * @returns {unknown[]}
 */
function includesAll(available: unknown[], required: unknown[]): unknown[] {
  const availableSet = new Set(asArray(available));
  return asArray(required).filter((item) => !availableSet.has(item));
}

/**
 * Creates a structured planner issue.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [metadata]
 * @returns {Record<string, unknown>}
 */
function createIssue(code: string, message: string, metadata: ManifestRecord = {}): PlannerIssue {
  return {
    code,
    message,
    ...metadata,
  };
}

/**
 * Converts a planner issue into a capability policy entry when it affects proof strength.
 *
 * @param {Record<string, unknown>} issue
 * @param {'unsupported' | 'warning'} status
 * @returns {Record<string, unknown> | null}
 */
function issueToCapabilityPolicyEntry(issue: PlannerIssue, status: 'unsupported' | 'warning'): ManifestRecord | null {
  if (typeof issue.capability === 'string') {
    return {
      kind: 'capability',
      name: issue.capability,
      status,
      code: issue.code,
    };
  }

  if (typeof issue.driverAction === 'string') {
    return {
      kind: 'driverAction',
      name: issue.driverAction,
      status,
      code: issue.code,
    };
  }

  if (typeof issue.uiContext === 'string') {
    return {
      kind: 'uiContext',
      name: issue.uiContext,
      status,
      code: issue.code,
    };
  }

  if (typeof issue.artifact === 'string') {
    return {
      kind: 'artifact',
      name: issue.artifact,
      status,
      code: issue.code,
    };
  }

  return null;
}

/**
 * Builds the no-silent-downgrade policy artifact from planner results.
 *
 * @param {{errors: Record<string, unknown>[], warnings: Record<string, unknown>[]}} options
 * @returns {Record<string, unknown>}
 */
function buildDowngradePolicy({
  errors,
  warnings,
}: {
  errors: PlannerIssue[];
  warnings: PlannerIssue[];
}): CompatibilityResult['downgradePolicy'] {
  return {
    mode: 'no-silent-downgrade',
    allowedSubstitutions: [],
    substitutions: [],
    unsupported: errors
      .map((issue) => issueToCapabilityPolicyEntry(issue, 'unsupported'))
      .filter((entry): entry is ManifestRecord => entry !== null),
    warnings: warnings
      .map((issue) => issueToCapabilityPolicyEntry(issue, 'warning'))
      .filter((entry): entry is ManifestRecord => entry !== null),
  };
}

/**
 * Returns `value` when it is a plain object; otherwise returns an empty object.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asObject(value: unknown): ManifestRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ManifestRecord : {};
}

/**
 * Returns true when a value is a finite number.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Returns true when a value is a positive integer.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Resolves the stable scenario step identifier used in planner errors.
 *
 * @param {Record<string, unknown>} step
 * @param {number} index
 * @returns {string}
 */
function getScenarioStepId(step: ScenarioStep, index: number): string {
  return typeof step.id === 'string' && step.id.length > 0 ? step.id : `step-${index + 1}`;
}

/**
 * Returns true when a scenario step has a portable selector object.
 *
 * @param {Record<string, unknown>} step
 * @returns {boolean}
 */
function hasPortableSelector(step: ScenarioStep): boolean {
  const selector = asObject(step.selector);
  return typeof selector.kind === 'string' && typeof selector.value === 'string' && selector.value.length > 0;
}

/**
 * Reads a string set from scenario list metadata.
 *
 * @param {unknown} value
 * @returns {Set<string>}
 */
function readStringSet(value: unknown): Set<string> {
  const entries = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return new Set(entries);
}

/**
 * Resolves a scenario milestone id to its app-owned event name.
 *
 * @param {Record<string, unknown>} scenario
 * @param {string} milestone
 * @returns {string}
 */
function resolveMilestoneEventName(scenario: ScenarioManifest, milestone: string): string {
  const milestoneEntry = Array.isArray(scenario.milestones)
    ? scenario.milestones.find((entry): entry is ManifestRecord => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return false;
        }
        return (entry as ManifestRecord).id === milestone;
      })
    : undefined;
  if (typeof milestoneEntry?.event === 'string' && milestoneEntry.event.length > 0) {
    return milestoneEntry.event;
  }

  const metricEvents = asObject(scenario.metricEvents);
  const metricEvent = metricEvents[milestone];
  if (typeof metricEvent === 'string' && metricEvent.length > 0) {
    return metricEvent;
  }

  return milestone;
}

/**
 * Returns true when a value can be used as an agent-device ref target.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function hasAgentDeviceRef(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Returns true when a scenario step has an agent-device target.
 *
 * @param {Record<string, unknown>} step
 * @returns {boolean}
 */
function hasAgentDeviceTarget(step: ScenarioStep): boolean {
  const agentDevice = asObject(asObject(step.adapterOptions).agentDevice);
  return (
    hasPortableSelector(step) ||
    hasAgentDeviceRef(agentDevice.ref) ||
    (isFiniteNumber(agentDevice.x) && isFiniteNumber(agentDevice.y))
  );
}

/**
 * Returns true when adapter metadata has explicit start and end coordinates.
 *
 * @param {Record<string, unknown>} options
 * @returns {boolean}
 */
function hasStartEndCoordinates(options: ManifestRecord): boolean {
  return (
    isFiniteNumber(options.startX) &&
    isFiniteNumber(options.startY) &&
    isFiniteNumber(options.endX) &&
    isFiniteNumber(options.endY)
  );
}

/**
 * Returns true when a value is one of the agent-device orientation tokens.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isAgentDeviceOrientation(value: unknown): boolean {
  return value === 'portrait' ||
    value === 'portrait-upside-down' ||
    value === 'landscape-left' ||
    value === 'landscape-right';
}

const AGENT_DEVICE_ORIENTATION_DESCRIPTION = 'portrait, portrait-upside-down, landscape-left, or landscape-right';

/**
 * Returns true when a scenario step has Argent point coordinates.
 *
 * @param {Record<string, unknown>} step
 * @returns {boolean}
 */
function hasArgentPointTarget(step: ScenarioStep): boolean {
  const argent = asObject(asObject(step.adapterOptions).argent);
  return isFiniteNumber(argent.x) && isFiniteNumber(argent.y);
}

/**
 * Resolves the stable scenario identifier used in generated artifacts.
 *
 * @param {Record<string, unknown> | null | undefined} scenario
 * @returns {string}
 */
function getScenarioId(scenario: ScenarioManifest | null | undefined): string {
  return scenario?.id ?? scenario?.name ?? 'unknown-scenario';
}

/**
 * Resolves the stable runner identifier used in planner errors.
 *
 * @param {Record<string, unknown> | null | undefined} runner
 * @returns {string}
 */
function getRunnerId(runner: RunnerManifest | null | undefined): string {
  return runner?.runnerId ?? runner?.name ?? 'unknown-runner';
}

/**
 * Returns true when the scenario declares repeated body work.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {boolean}
 */
function hasRepeatedCycleBody(scenario: ScenarioManifest): boolean {
  const cycles = asObject(scenario.cycles);
  const cycleIterations = cycles.iterations;
  if (typeof cycleIterations === 'number' && isPositiveInteger(cycleIterations) && cycleIterations > 1) {
    return true;
  }

  const defaultIterations = scenario.defaultIterations;
  return typeof defaultIterations === 'number' && isPositiveInteger(defaultIterations) && defaultIterations > 1;
}

/**
 * Collects milestone budget anchors that describe measured product claims.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {{budgetNames: string[], events: string[]}}
 */
function collectMilestoneBudgetAnchors(scenario: ScenarioManifest): { budgetNames: string[]; events: string[] } {
  const budgetNames = new Set<string>();
  const events = new Set<string>();

  for (const budget of Array.isArray(scenario.budgets) ? scenario.budgets : []) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      continue;
    }

    const budgetRecord = budget as ManifestRecord;
    if (budgetRecord.source !== 'milestone') {
      continue;
    }

    if (typeof budgetRecord.name === 'string' && budgetRecord.name.length > 0) {
      budgetNames.add(budgetRecord.name);
    }
    if (typeof budgetRecord.fromMilestone === 'string' && budgetRecord.fromMilestone.length > 0) {
      events.add(resolveMilestoneEventName(scenario, budgetRecord.fromMilestone));
    }
    if (typeof budgetRecord.toMilestone === 'string' && budgetRecord.toMilestone.length > 0) {
      events.add(resolveMilestoneEventName(scenario, budgetRecord.toMilestone));
    }
  }

  return {
    budgetNames: [...budgetNames].sort(),
    events: [...events].sort(),
  };
}

/**
 * Returns true when a command step should be checked against repeated budget gates.
 *
 * @param {{bodyStepIds: Set<string>, setupStepIds: Set<string>, stepId: string}} options
 * @returns {boolean}
 */
function shouldCheckCommandGate({
  bodyStepIds,
  setupStepIds,
  stepId,
}: {
  bodyStepIds: Set<string>;
  setupStepIds: Set<string>;
  stepId: string;
}): boolean {
  if (setupStepIds.has(stepId)) {
    return false;
  }

  if (bodyStepIds.size === 0) {
    return true;
  }

  return bodyStepIds.has(stepId);
}

/**
 * Warns when repeated command gates differ from milestone budget anchors.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {Record<string, unknown>[]}
 */
function collectCommandGateBudgetDriftWarnings(scenario: ScenarioManifest): PlannerIssue[] {
  if (!hasRepeatedCycleBody(scenario)) {
    return [];
  }

  const budgetAnchors = collectMilestoneBudgetAnchors(scenario);
  if (budgetAnchors.events.length === 0) {
    return [];
  }

  const cycles = asObject(scenario.cycles);
  const setupStepIds = readStringSet(cycles.setupStepIds);
  const bodyStepIds = readStringSet(cycles.bodyStepIds);
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const budgetEventSet = new Set(budgetAnchors.events);
  const warnings: PlannerIssue[] = [];

  for (let index = 0; index < steps.length - 1; index += 1) {
    const step = steps[index];
    const nextStep = steps[index + 1];
    if (!step || step.kind !== 'command' || !nextStep || nextStep.kind !== 'waitForMilestone') {
      continue;
    }

    const stepId = getScenarioStepId(step, index);
    if (!shouldCheckCommandGate({ bodyStepIds, setupStepIds, stepId })) {
      continue;
    }
    if (typeof nextStep.milestone !== 'string' || nextStep.milestone.length === 0) {
      continue;
    }

    const gateEvent = resolveMilestoneEventName(scenario, nextStep.milestone);
    if (budgetEventSet.has(gateEvent)) {
      continue;
    }

    warnings.push(
      createIssue(
        'command_gate_budget_drift',
        `Command step \`${stepId}\` is gated by milestone \`${nextStep.milestone}\`, but milestone budgets measure different anchors.`,
        {
          scenarioId: getScenarioId(scenario),
          stepId,
          command: step.command,
          waitStepId: getScenarioStepId(nextStep, index + 1),
          waitForMilestone: nextStep.milestone,
          gateEvent,
          budgetEvents: budgetAnchors.events,
          budgetNames: budgetAnchors.budgetNames,
          nextAction:
            'Verify the immediate command gate is intentional, or align body command gates with the milestone interval being claimed.',
        },
      ),
    );
  }

  return warnings;
}

/**
 * Builds product-neutral manifest provenance for planner compatibility evidence.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>}
 */
function buildManifestVersionRecord(manifest: RunnerManifest): Record<string, unknown> {
  return {
    runnerId: getRunnerId(manifest),
    kind: typeof manifest.kind === 'string' ? manifest.kind : 'unknown',
    schemaVersion: typeof manifest.schemaVersion === 'string' ? manifest.schemaVersion : 'unknown',
  };
}

/**
 * Keeps only scalar issue metadata so health artifacts remain schema-safe.
 *
 * @param {Record<string, unknown>} issue
 * @returns {Record<string, string | number | boolean | null>}
 */
function getIssueMetadata(issue: PlannerIssue): Record<string, string | number | boolean | null> {
  return Object.keys(issue)
    .filter((key) => key !== 'code' && key !== 'message')
    .sort()
    .reduce<Record<string, string | number | boolean | null>>((metadata, key) => {
      const value = issue[key];
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        metadata[key] = value;
      }
      return metadata;
    }, {});
}

/**
 * Converts a planner issue into a `health.json` check entry.
 *
 * @param {Record<string, unknown>} issue
 * @param {'failed' | 'warning'} status
 * @returns {Record<string, unknown>}
 */
function issueToHealthCheck(issue: PlannerIssue, status: 'failed' | 'warning'): ManifestRecord {
  const metadata = getIssueMetadata(issue);
  return {
    name: issue.code,
    status,
    source:
      issue.code?.includes('artifact') || issue.code?.includes('evidence')
        ? 'evidence'
        : 'planner',
    code: issue.code,
    message: issue.message,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * Returns whether a provider can participate in the selected platform set.
 *
 * @param {Record<string, unknown>} provider
 * @param {string[]} effectivePlatforms
 * @returns {boolean}
 */
function isProviderActiveForPlatforms(provider: RunnerManifest, effectivePlatforms: string[]): boolean {
  return intersection(asArray(provider?.platforms), effectivePlatforms).length > 0;
}

/**
 * Collects artifacts available from the primary runner and active evidence providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {{activeProviders: Record<string, unknown>[], artifacts: string[]}}
 */
function collectProvidedArtifacts({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): { activeProviders: RunnerManifest[]; artifacts: string[] } {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return {
    activeProviders,
    artifacts: uniqueSorted([
      ...asArray(runner?.artifactOutputs),
      ...activeProviders.flatMap((provider) => asArray(provider?.artifactOutputs)),
    ]),
  };
}

/**
 * Collects capabilities available from the primary runner and active evidence providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {string[]}
 */
function collectProvidedCapabilities({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): string[] {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return uniqueSorted([
    ...asArray(runner?.capabilities),
    ...activeProviders.flatMap((provider) => asArray(provider?.capabilities)),
  ]);
}

/**
 * Collects driver operations available from the primary runner and active providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {string[]}
 */
function collectProvidedDriverActions({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): string[] {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return uniqueSorted([
    ...asArray(runner?.driverActions),
    ...activeProviders.flatMap((provider) => asArray(provider?.driverActions)),
  ]);
}

/**
 * Collects UI/system contexts owned by the primary runner and active providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {string[]}
 */
function collectProvidedUiContexts({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): string[] {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return uniqueSorted([
    ...asArray(runner?.uiContexts),
    ...activeProviders.flatMap((provider) => asArray(provider?.uiContexts)),
  ]);
}

/**
 * Resolves the UI/system context a scenario step requires from its driver action.
 *
 * Explicit step ownership wins. UI driver actions default to app-owned UI, and
 * non-UI steps do not claim a UI context.
 *
 * @param {ScenarioStep} step
 * @returns {string | null}
 */
function resolveScenarioStepUiContext(step: ScenarioStep): string | null {
  if (typeof step.uiContext === 'string') {
    return step.uiContext;
  }

  if (typeof step.driverAction === 'string' && UI_DRIVER_ACTIONS.has(step.driverAction)) {
    return 'app';
  }

  return null;
}

/**
 * Collects UI/system contexts required by scenario steps.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {{required: string[], optional: string[]}}
 */
function collectScenarioUiContexts(scenario: ScenarioManifest): { required: string[]; optional: string[] } {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const required: unknown[] = [];
  const optional: unknown[] = [];

  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      continue;
    }

    const uiContext = resolveScenarioStepUiContext(step);
    if (!uiContext) {
      continue;
    }

    if (step.required === false) {
      optional.push(uiContext);
    } else {
      required.push(uiContext);
    }
  }

  return {
    required: uniqueSorted(required),
    optional: uniqueSorted(optional),
  };
}

/**
 * Collects driver operations required by scenario steps.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {{required: string[], optional: string[]}}
 */
function collectScenarioDriverActions(scenario: ScenarioManifest): { required: string[]; optional: string[] } {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const required: unknown[] = [];
  const optional: unknown[] = [];

  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof step.driverAction !== 'string') {
      continue;
    }

    if (step.required === false) {
      optional.push(step.driverAction);
    } else {
      required.push(step.driverAction);
    }
  }

  return {
    required: uniqueSorted(required),
    optional: uniqueSorted(optional),
  };
}

/**
 * Adds a structured invalid-adapter-options issue.
 *
 * @param {{adapter: string, errors: PlannerIssue[], field: string, message: string, scenario: ScenarioManifest, stepId?: string}} options
 * @returns {void}
 */
function pushInvalidAdapterOption({
  adapter,
  errors,
  field,
  message,
  scenario,
  stepId,
}: {
  adapter: string;
  errors: PlannerIssue[];
  field: string;
  message: string;
  scenario: ScenarioManifest;
  stepId?: string;
}): void {
  errors.push(
    createIssue('invalid_adapter_options', message, {
      adapter,
      field,
      scenarioId: getScenarioId(scenario),
      ...(stepId ? { stepId } : {}),
    }),
  );
}

/**
 * Validates Android adb metadata that built-in runners depend on at runtime.
 *
 * @param {{scenario: ScenarioManifest, errors: PlannerIssue[]}} options
 * @returns {void}
 */
function validateAndroidAdbAdapterOptions({
  errors,
  scenario,
}: {
  errors: PlannerIssue[];
  scenario: ScenarioManifest;
}): void {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') {
      continue;
    }

    const androidAdb = asObject(asObject(step.adapterOptions).androidAdb);
    const stepId = getScenarioStepId(step, index);
    if (
      step.driverAction === 'assertVisible' &&
      !hasPortableSelector(step)
    ) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'selector',
        message: `Step \`${stepId}\` uses driverAction \`assertVisible\` but a portable selector is required.`,
        scenario,
        stepId,
      });
    }

    if (
      step.driverAction === 'tap' &&
      !hasPortableSelector(step) &&
      (!isFiniteNumber(androidAdb.x) || !isFiniteNumber(androidAdb.y))
    ) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'x/y',
        message: `Step \`${stepId}\` uses driverAction \`tap\` but adapterOptions.androidAdb.x/y are required.`,
        scenario,
        stepId,
      });
    }

    if (
      step.driverAction === 'scroll' &&
      !hasPortableSelector(step) &&
      (
        !isFiniteNumber(androidAdb.startX) ||
        !isFiniteNumber(androidAdb.startY) ||
        !isFiniteNumber(androidAdb.endX) ||
        !isFiniteNumber(androidAdb.endY)
      )
    ) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'startX/startY/endX/endY',
        message: `Step \`${stepId}\` uses driverAction \`scroll\` but adapterOptions.androidAdb.startX/startY/endX/endY are required.`,
        scenario,
        stepId,
      });
    }

    if (
      step.driverAction === 'swipe' &&
      (
        !isFiniteNumber(androidAdb.startX) ||
        !isFiniteNumber(androidAdb.startY) ||
        !isFiniteNumber(androidAdb.endX) ||
        !isFiniteNumber(androidAdb.endY)
      )
    ) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'startX/startY/endX/endY',
        message: `Step \`${stepId}\` uses driverAction \`swipe\` but adapterOptions.androidAdb.startX/startY/endX/endY are required.`,
        scenario,
        stepId,
      });
    }

    if ('durationMs' in androidAdb && !isPositiveInteger(androidAdb.durationMs)) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'durationMs',
        message: `Step \`${stepId}\` has adapterOptions.androidAdb.durationMs, but it must be a positive integer.`,
        scenario,
        stepId,
      });
    }

    if ('logcatLines' in androidAdb && !isPositiveInteger(androidAdb.logcatLines)) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'logcatLines',
        message: `Step \`${stepId}\` has adapterOptions.androidAdb.logcatLines, but it must be a positive integer.`,
        scenario,
        stepId,
      });
    }

    if ('waitMs' in androidAdb && !isPositiveInteger(androidAdb.waitMs)) {
      pushInvalidAdapterOption({
        adapter: 'androidAdb',
        errors,
        field: 'waitMs',
        message: `Step \`${stepId}\` has adapterOptions.androidAdb.waitMs, but it must be a positive integer.`,
        scenario,
        stepId,
      });
    }
  }
}

/**
 * Validates iOS simctl metadata that built-in runners depend on at runtime.
 *
 * @param {{scenario: ScenarioManifest, errors: PlannerIssue[]}} options
 * @returns {void}
 */
function validateIosSimctlAdapterOptions({
  errors,
  scenario,
}: {
  errors: PlannerIssue[];
  scenario: ScenarioManifest;
}): void {
  const scenarioIosSimctl = asObject(asObject(scenario.adapterOptions).iosSimctl);
  if ('repeat' in scenarioIosSimctl && !isPositiveInteger(scenarioIosSimctl.repeat)) {
    pushInvalidAdapterOption({
      adapter: 'iosSimctl',
      errors,
      field: 'repeat',
      message: 'Scenario adapterOptions.iosSimctl.repeat must be a positive integer.',
      scenario,
    });
  }

  if ('commands' in scenarioIosSimctl) {
    if (!Array.isArray(scenarioIosSimctl.commands)) {
      pushInvalidAdapterOption({
        adapter: 'iosSimctl',
        errors,
        field: 'commands',
        message: 'Scenario adapterOptions.iosSimctl.commands must be an array when provided.',
        scenario,
      });
    } else {
      for (const [index, command] of scenarioIosSimctl.commands.entries()) {
        const commandOptions = asObject(command);
        if (typeof commandOptions.command !== 'string' || commandOptions.command.length === 0) {
          pushInvalidAdapterOption({
            adapter: 'iosSimctl',
            errors,
            field: `commands[${index}].command`,
            message: `Scenario adapterOptions.iosSimctl.commands[${index}].command must be a non-empty string.`,
            scenario,
          });
        }
        if ('waitMs' in commandOptions && !isPositiveInteger(commandOptions.waitMs)) {
          pushInvalidAdapterOption({
            adapter: 'iosSimctl',
            errors,
            field: `commands[${index}].waitMs`,
            message: `Scenario adapterOptions.iosSimctl.commands[${index}].waitMs must be a positive integer.`,
            scenario,
          });
        }
      }
    }
  }

  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') {
      continue;
    }

    const iosSimctl = asObject(asObject(step.adapterOptions).iosSimctl);
    if ('waitMs' in iosSimctl && !isPositiveInteger(iosSimctl.waitMs)) {
      const stepId = getScenarioStepId(step, index);
      pushInvalidAdapterOption({
        adapter: 'iosSimctl',
        errors,
        field: 'waitMs',
        message: `Step \`${stepId}\` has adapterOptions.iosSimctl.waitMs, but it must be a positive integer.`,
        scenario,
        stepId,
      });
    }
  }
}

/**
 * Validates agent-device metadata that the bundled adapter enforces at runtime.
 *
 * @param {{scenario: ScenarioManifest, errors: PlannerIssue[]}} options
 * @returns {void}
 */
function validateAgentDeviceAdapterOptions({
  errors,
  scenario,
}: {
  errors: PlannerIssue[];
  scenario: ScenarioManifest;
}): void {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') {
      continue;
    }

    const agentDevice = asObject(asObject(step.adapterOptions).agentDevice);
    const selector = asObject(step.selector);
    const stepId = getScenarioStepId(step, index);
    if (
      typeof selector.match === 'string' &&
      selector.match !== 'exact' &&
      ['assertVisible', 'longPress', 'pressButton', 'tap'].includes(String(step.driverAction))
    ) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'selector.match',
        message: `Step \`${stepId}\` uses selector match \`${selector.match}\`, but the agent-device adapter currently supports exact selector matches only.`,
        scenario,
        stepId,
      });
    }

    if (step.driverAction === 'assertVisible' && !hasPortableSelector(step)) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'selector',
        message: `Step \`${stepId}\` uses driverAction \`assertVisible\` but a portable selector is required.`,
        scenario,
        stepId,
      });
    }

    if (
      (step.driverAction === 'tap' || step.driverAction === 'longPress' || step.driverAction === 'pressButton') &&
      !hasAgentDeviceTarget(step)
    ) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'selector/ref/x/y',
        message: `Step \`${stepId}\` uses driverAction \`${step.driverAction}\` but requires a selector, adapterOptions.agentDevice.ref, or adapterOptions.agentDevice.x/y.`,
        scenario,
        stepId,
      });
    }

    if (step.driverAction === 'typeText' && (typeof agentDevice.text !== 'string' || agentDevice.text.length === 0)) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'text',
        message: `Step \`${stepId}\` uses driverAction \`typeText\` but adapterOptions.agentDevice.text is required.`,
        scenario,
        stepId,
      });
    }

    if (step.driverAction === 'focus' && (!isFiniteNumber(agentDevice.x) || !isFiniteNumber(agentDevice.y))) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'x/y',
        message: `Step \`${stepId}\` uses driverAction \`focus\` but adapterOptions.agentDevice.x/y are required.`,
        scenario,
        stepId,
      });
    }

    if (step.driverAction === 'pinch' && !isFiniteNumber(agentDevice.scale)) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'scale',
        message: `Step \`${stepId}\` uses driverAction \`pinch\` but adapterOptions.agentDevice.scale is required.`,
        scenario,
        stepId,
      });
    }

    if (step.driverAction === 'rotate' && !isAgentDeviceOrientation(agentDevice.orientation)) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'orientation',
        message: `Step \`${stepId}\` uses driverAction \`rotate\` but adapterOptions.agentDevice.orientation must be ${AGENT_DEVICE_ORIENTATION_DESCRIPTION}.`,
        scenario,
        stepId,
      });
    }

    if (step.driverAction === 'swipe' && !hasStartEndCoordinates(agentDevice)) {
      pushInvalidAdapterOption({
        adapter: 'agentDevice',
        errors,
        field: 'startX/startY/endX/endY',
        message: `Step \`${stepId}\` uses driverAction \`swipe\` but adapterOptions.agentDevice.startX/startY/endX/endY are required.`,
        scenario,
        stepId,
      });
    }
  }
}

/**
 * Validates Argent metadata that the optional adapter enforces at runtime.
 *
 * @param {{scenario: ScenarioManifest, errors: PlannerIssue[]}} options
 * @returns {void}
 */
function validateArgentAdapterOptions({
  errors,
  scenario,
}: {
  errors: PlannerIssue[];
  scenario: ScenarioManifest;
}): void {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') {
      continue;
    }

    const argent = asObject(asObject(step.adapterOptions).argent);
    const selector = asObject(step.selector);
    const stepId = getScenarioStepId(step, index);

    if (step.driverAction === 'assertVisible' && !hasPortableSelector(step)) {
      pushInvalidAdapterOption({
        adapter: 'argent',
        errors,
        field: 'selector',
        message: `Step \`${stepId}\` uses driverAction \`assertVisible\` but a portable selector is required.`,
        scenario,
        stepId,
      });
    }

    if ((step.driverAction === 'tap' || step.driverAction === 'longPress') && !hasArgentPointTarget(step)) {
      pushInvalidAdapterOption({
        adapter: 'argent',
        errors,
        field: 'x/y',
        message: `Step \`${stepId}\` uses driverAction \`${String(step.driverAction)}\` but adapterOptions.argent.x/y are required.`,
        scenario,
        stepId,
      });
    }

    if (
      step.driverAction === 'scroll' &&
      (
        !isFiniteNumber(argent.startX) ||
        !isFiniteNumber(argent.startY) ||
        !isFiniteNumber(argent.endX) ||
        !isFiniteNumber(argent.endY)
      )
    ) {
      pushInvalidAdapterOption({
        adapter: 'argent',
        errors,
        field: 'startX/startY/endX/endY',
        message: `Step \`${stepId}\` uses driverAction \`scroll\` but adapterOptions.argent.startX/startY/endX/endY are required.`,
        scenario,
        stepId,
      });
    }

    if (
      step.driverAction === 'swipe' &&
      (
        !isFiniteNumber(argent.startX) ||
        !isFiniteNumber(argent.startY) ||
        !isFiniteNumber(argent.endX) ||
        !isFiniteNumber(argent.endY)
      )
    ) {
      pushInvalidAdapterOption({
        adapter: 'argent',
        errors,
        field: 'startX/startY/endX/endY',
        message: `Step \`${stepId}\` uses driverAction \`swipe\` but adapterOptions.argent.startX/startY/endX/endY are required.`,
        scenario,
        stepId,
      });
    }

    if ('durationMs' in argent && !isPositiveInteger(argent.durationMs)) {
      pushInvalidAdapterOption({
        adapter: 'argent',
        errors,
        field: 'durationMs',
        message: `Step \`${stepId}\` has adapterOptions.argent.durationMs, but it must be a positive integer.`,
        scenario,
        stepId,
      });
    }
  }
}

/**
 * Validates adapter-specific scenario metadata for the selected platform set.
 *
 * @param {{scenario: ScenarioManifest, effectivePlatforms: string[], errors: PlannerIssue[], runner?: RunnerManifest}} options
 * @returns {void}
 */
function validateScenarioAdapterOptions({
  effectivePlatforms,
  errors,
  runner,
  scenario,
}: {
  effectivePlatforms: string[];
  errors: PlannerIssue[];
  runner?: RunnerManifest;
  scenario: ScenarioManifest;
}): void {
  const runnerId = runner ? getRunnerId(runner) : '';
  const usesAndroidAdbOptions = Array.isArray(scenario.steps) &&
    scenario.steps.some((step) => Object.prototype.hasOwnProperty.call(asObject(asObject(step).adapterOptions), 'androidAdb'));
  if (effectivePlatforms.includes('android') && (runnerId.includes('adb') || usesAndroidAdbOptions)) {
    validateAndroidAdbAdapterOptions({ errors, scenario });
  }

  if (effectivePlatforms.includes('ios')) {
    validateIosSimctlAdapterOptions({ errors, scenario });
  }

  if (runnerId.includes('agent-device')) {
    validateAgentDeviceAdapterOptions({ errors, scenario });
  }

  const usesArgentOptions =
    Array.isArray(scenario.steps) &&
    scenario.steps.some((step) =>
      Object.prototype.hasOwnProperty.call(asObject(asObject(step).adapterOptions), 'argent'),
    );
  if (runnerId.includes('argent') || usesArgentOptions) {
    validateArgentAdapterOptions({ errors, scenario });
  }
}

/**
 * Adds planner errors when the selected runner cannot own a run lifecycle.
 *
 * @param {{runner: Record<string, unknown>, errors: Record<string, unknown>[]}} options
 * @returns {void}
 */
function validatePrimaryRunner({
  runner,
  errors,
}: {
  runner?: RunnerManifest | undefined;
  errors: PlannerIssue[];
}): void {
  if (!runner || typeof runner !== 'object') {
    errors.push(createIssue('runner_missing', 'A primary runner capability manifest is required.'));
    return;
  }

  if (runner.kind && runner.kind !== 'primary') {
    errors.push(
      createIssue('runner_not_primary', 'The selected runner must have kind `primary`.', {
        runnerId: getRunnerId(runner),
        kind: runner.kind,
      }),
    );
  }
}

/**
 * Determines the platform set a plan should evaluate and records platform mismatches.
 *
 * @param {{scenario: Record<string, unknown>, runner: Record<string, unknown>, platform?: string | null, errors: Record<string, unknown>[]}} options
 * @returns {string[]}
 */
function resolveEffectivePlatforms({
  scenario,
  runner,
  platform,
  errors,
}: {
  scenario: ScenarioManifest;
  runner: RunnerManifest;
  platform?: string | null;
  errors: PlannerIssue[];
}): string[] {
  const declaredScenarioPlatforms = asArray(scenario?.platforms);
  const runnerPlatforms = asArray(runner?.platforms);
  const scenarioPlatforms = declaredScenarioPlatforms.length > 0 ? declaredScenarioPlatforms : runnerPlatforms;

  if (platform) {
    if (declaredScenarioPlatforms.length > 0 && !declaredScenarioPlatforms.includes(platform)) {
      errors.push(
        createIssue('platform_not_supported_by_scenario', 'The scenario does not support the selected platform.', {
          scenarioId: getScenarioId(scenario),
          platform,
          supportedPlatforms: uniqueSorted(declaredScenarioPlatforms),
        }),
      );
    }

    if (!runnerPlatforms.includes(platform)) {
      errors.push(
        createIssue('platform_not_supported_by_runner', 'The runner does not support the selected platform.', {
          runnerId: getRunnerId(runner),
          platform,
          supportedPlatforms: uniqueSorted(runnerPlatforms),
        }),
      );
    }

    return [platform];
  }

  const commonPlatforms = intersection(scenarioPlatforms, runnerPlatforms);
  if (commonPlatforms.length === 0) {
    errors.push(
      createIssue('platform_mismatch', 'The scenario and runner do not share a supported platform.', {
        scenarioId: getScenarioId(scenario),
        runnerId: getRunnerId(runner),
        scenarioPlatforms: uniqueSorted(scenarioPlatforms),
        runnerPlatforms: uniqueSorted(runnerPlatforms),
      }),
    );
  }

  return commonPlatforms;
}

/**
 * Evaluates whether a scenario can be served by a primary runner plus evidence providers.
 *
 * @param {{scenario?: Record<string, unknown>, runner?: Record<string, unknown>, evidenceProviders?: Record<string, unknown>[], platform?: string | null}} [options]
 * @returns {{compatible: boolean, errors: Record<string, unknown>[], warnings: Record<string, unknown>[], matched: {platforms: string[], capabilities: string[], driverActions: string[], artifacts: string[], evidenceProviders: string[]}}}
 */
function evaluateRunnerCompatibility({
  scenario,
  runner,
  evidenceProviders = [],
  platform = null,
}: {
  scenario?: ScenarioManifest;
  runner?: RunnerManifest;
  evidenceProviders?: RunnerManifest[];
  platform?: string | null;
} = {}): CompatibilityResult {
  const errors: PlannerIssue[] = [];
  const warnings: PlannerIssue[] = [];

  validatePrimaryRunner({ runner, errors });
  const primaryRunner = runner ?? {};

  if (!scenario || typeof scenario !== 'object') {
    errors.push(createIssue('scenario_missing', 'A scenario manifest is required.'));
    return {
      compatible: false,
      errors,
      warnings,
      downgradePolicy: buildDowngradePolicy({ errors, warnings }),
      matched: {
        platforms: [],
        capabilities: [],
        driverActions: [],
        uiContexts: [],
        artifacts: [],
        evidenceProviders: [],
        manifestVersions: [],
      },
    };
  }

  const effectivePlatforms = resolveEffectivePlatforms({ scenario, runner: primaryRunner, platform, errors });
  validateScenarioAdapterOptions({ effectivePlatforms, errors, runner: primaryRunner, scenario });
  const runnerCapabilities = uniqueSorted(asArray(primaryRunner.capabilities));
  const missingRequiredCapabilities = includesAll(
    runnerCapabilities,
    asArray(scenario.requiredCapabilities),
  );

  for (const capability of missingRequiredCapabilities) {
    errors.push(
      createIssue(
        'missing_required_capability',
        `Runner \`${getRunnerId(primaryRunner)}\` is missing required capability \`${capability}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          capability,
        },
      ),
    );
  }

  const providedCapabilities = collectProvidedCapabilities({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const missingOptionalCapabilities = includesAll(
    providedCapabilities,
    asArray(scenario.optionalCapabilities),
  );

  for (const capability of missingOptionalCapabilities) {
    warnings.push(
      createIssue('missing_optional_capability', `No active runner or provider declares optional capability \`${capability}\`.`, {
        scenarioId: getScenarioId(scenario),
        capability,
      }),
    );
  }

  const providedDriverActions = collectProvidedDriverActions({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const scenarioDriverActions = collectScenarioDriverActions(scenario);
  for (const driverAction of includesAll(providedDriverActions, scenarioDriverActions.required)) {
    errors.push(
      createIssue(
        'missing_required_driver_action',
        `No active runner or provider declares required driver action \`${driverAction}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          driverAction,
        },
      ),
    );
  }

  for (const driverAction of includesAll(providedDriverActions, scenarioDriverActions.optional)) {
    warnings.push(
      createIssue(
        'missing_optional_driver_action',
        `No active runner or provider declares optional driver action \`${driverAction}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          driverAction,
        },
      ),
    );
  }

  const providedUiContexts = collectProvidedUiContexts({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const scenarioUiContexts = collectScenarioUiContexts(scenario);
  for (const uiContext of includesAll(providedUiContexts, scenarioUiContexts.required)) {
    errors.push(
      createIssue(
        'missing_required_ui_context',
        `No active runner or provider declares required UI context \`${uiContext}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          uiContext,
        },
      ),
    );
  }

  for (const uiContext of includesAll(providedUiContexts, scenarioUiContexts.optional)) {
    warnings.push(
      createIssue(
        'missing_optional_ui_context',
        `No active runner or provider declares optional UI context \`${uiContext}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          uiContext,
        },
      ),
    );
  }

  const { activeProviders, artifacts } = collectProvidedArtifacts({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const requiredArtifacts = asArray(scenario.artifacts?.required);
  const optionalArtifacts = asArray(scenario.artifacts?.optional);

  for (const artifact of includesAll(artifacts, requiredArtifacts)) {
    errors.push(
      createIssue('missing_required_artifact', `No active runner or evidence provider can produce required artifact \`${artifact}\`.`, {
        scenarioId: getScenarioId(scenario),
        artifact,
      }),
    );
  }

  for (const artifact of includesAll(artifacts, optionalArtifacts)) {
    warnings.push(
      createIssue('missing_optional_artifact', `No active runner or evidence provider declares optional artifact \`${artifact}\`.`, {
        scenarioId: getScenarioId(scenario),
        artifact,
      }),
    );
  }

  warnings.push(...collectCommandGateBudgetDriftWarnings(scenario));

  return {
    compatible: errors.length === 0,
    errors,
    warnings,
    downgradePolicy: buildDowngradePolicy({ errors, warnings }),
    matched: {
      platforms: effectivePlatforms,
      capabilities: providedCapabilities,
      driverActions: providedDriverActions,
      uiContexts: providedUiContexts,
      artifacts,
      evidenceProviders: activeProviders.map((provider) => getRunnerId(provider)),
      manifestVersions: [
        buildManifestVersionRecord(primaryRunner),
        ...activeProviders.map(buildManifestVersionRecord),
      ],
    },
  };
}

/**
 * Builds the initial `health.json` artifact from planner compatibility results.
 *
 * @param {{scenario: Record<string, unknown>, runId?: string, compatibility: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildCompatibilityHealth({
  scenario,
  runId,
  compatibility,
}: {
  scenario: ScenarioManifest;
  runId?: string;
  compatibility: CompatibilityResult;
}): ManifestRecord {
  const scenarioId = getScenarioId(scenario);
  const resolvedRunId = typeof runId === 'string' && runId.length > 0 ? runId : 'unknown-run';
  const errors = compatibility.errors;
  const warnings = compatibility.warnings;
  const failedChecks = errors.map((issue) => issueToHealthCheck(issue, 'failed'));
  const warningChecks = warnings.map((issue) => issueToHealthCheck(issue, 'warning'));
  const checks =
    failedChecks.length > 0
      ? failedChecks
      : [
          {
            name: 'planner_compatibility',
            status: 'passed',
            source: 'planner',
            code: 'planner_compatible',
            message: 'Scenario requirements are compatible with the selected runner and evidence providers.',
          },
        ];

  return {
    schemaVersion: '1.0.0',
    scenarioId,
    ...(typeof scenario?.flowId === 'string' ? { flowId: scenario.flowId } : {}),
    runId: resolvedRunId,
    healthStatus: failedChecks.length > 0 ? 'failed' : 'passed',
    checks,
    ...(warningChecks.length > 0 ? { warnings: warningChecks } : {}),
    downgradePolicy: compatibility.downgradePolicy ?? buildDowngradePolicy({ errors, warnings }),
    matched: {
      platforms: uniqueSorted(asArray(compatibility?.matched?.platforms)),
      capabilities: uniqueSorted(asArray(compatibility?.matched?.capabilities)),
      driverActions: uniqueSorted(asArray(compatibility?.matched?.driverActions)),
      uiContexts: uniqueSorted(asArray(compatibility?.matched?.uiContexts)),
      artifacts: uniqueSorted(asArray(compatibility?.matched?.artifacts)),
      evidenceProviders: uniqueSorted(asArray(compatibility?.matched?.evidenceProviders)),
      manifestVersions: asArray(compatibility?.matched?.manifestVersions),
    },
  };
}

/**
 * Builds a pre-budget `verdict.json` artifact from scenario health.
 *
 * @param {{scenario: Record<string, unknown>, runId?: string, health: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildUnevaluatedVerdict({
  scenario,
  runId,
  health,
}: {
  scenario: ScenarioManifest;
  runId?: string;
  health: ManifestRecord;
}): ManifestRecord {
  const healthStatus = health?.healthStatus ?? 'failed';
  const scenarioId = health?.scenarioId ?? getScenarioId(scenario);
  const resolvedRunId =
    typeof health?.runId === 'string' && health.runId.length > 0
      ? health.runId
      : typeof runId === 'string' && runId.length > 0
        ? runId
        : 'unknown-run';
  const canEvaluateBudgets = healthStatus === 'passed';

  return {
    schemaVersion: '1.0.0',
    scenarioId,
    ...(typeof health?.flowId === 'string'
      ? { flowId: health.flowId }
      : typeof scenario?.flowId === 'string'
        ? { flowId: scenario.flowId }
        : {}),
    runId: resolvedRunId,
    healthStatus,
    verdictStatus: canEvaluateBudgets ? 'not_evaluated' : 'inconclusive',
    budgetChecks: [],
    summary: canEvaluateBudgets
      ? 'Scenario health passed; budget evaluation has not run yet.'
      : 'Scenario health did not pass; do not optimize from this run.',
  };
}

export {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  collectProvidedDriverActions,
  collectProvidedUiContexts,
  collectScenarioDriverActions,
  collectScenarioUiContexts,
  evaluateRunnerCompatibility,
  intersection,
  uniqueSorted,
  validateScenarioAdapterOptions,
};

export type {
  CompatibilityResult,
  ManifestRecord,
  PlannerIssue,
  RunnerManifest,
  ScenarioManifest,
};
