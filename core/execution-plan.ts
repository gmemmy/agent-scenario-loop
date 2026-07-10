const { collectScenarioDriverActions } = require('./planner');

type ScenarioManifest = import('./planner').ScenarioManifest;

type ScenarioStepKind =
  | 'launch'
  | 'command'
  | 'waitForMilestone'
  | 'captureEvidence'
  | 'gesture'
  | 'assertUi';

type RunnerPortMethod =
  | 'launch'
  | 'executeStep'
  | 'waitForTruthEvent'
  | 'captureEvidence';

type StepCadence = {
  settleMs: number;
  source: 'step' | 'scenario-kind' | 'scenario-default';
  reason?: string;
};

type ScenarioExecutionStep = {
  id: string;
  index: number;
  kind: ScenarioStepKind;
  portMethod: RunnerPortMethod;
  required: boolean;
  adapterOptions?: Record<string, unknown>;
  artifact?: string;
  command?: string;
  cadence?: StepCadence;
  driverAction?: string;
  milestone?: string;
  selector?: Record<string, unknown>;
  timeoutMs?: number;
};

type ScenarioExecutionPlan = {
  scenarioId: string;
  flowId?: string;
  steps: ScenarioExecutionStep[];
  driverActions: {
    optional: string[];
    required: string[];
  };
};

const STEP_KIND_TO_PORT_METHOD: Record<ScenarioStepKind, RunnerPortMethod> = {
  assertUi: 'executeStep',
  captureEvidence: 'captureEvidence',
  command: 'executeStep',
  gesture: 'executeStep',
  launch: 'launch',
  waitForMilestone: 'waitForTruthEvent',
};

/**
 * Resolves the scenario identifier for execution-plan artifacts and logs.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {string}
 */
function getScenarioId(scenario: ScenarioManifest): string {
  return scenario.id ?? scenario.name ?? 'unknown-scenario';
}

/**
 * Returns true for scenario step kinds supported by the execution-plan contract.
 *
 * @param {unknown} kind
 * @returns {kind is ScenarioStepKind}
 */
function isScenarioStepKind(kind: unknown): kind is ScenarioStepKind {
  return typeof kind === 'string' && kind in STEP_KIND_TO_PORT_METHOD;
}

/**
 * Builds a deterministic id for an unnamed scenario step.
 *
 * @param {number} index
 * @param {ScenarioStepKind} kind
 * @returns {string}
 */
function buildDefaultStepId(index: number, kind: ScenarioStepKind): string {
  return `${String(index + 1).padStart(2, '0')}-${kind}`;
}

/**
 * Reads a non-negative integer from scenario cadence fields.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function readCadenceMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Resolves the scenario cadence field associated with a step kind.
 *
 * @param {ScenarioStepKind} kind
 * @returns {string}
 */
function getScenarioKindCadenceField(kind: ScenarioStepKind): string {
  switch (kind) {
    case 'assertUi':
      return 'assertionSettleMs';
    case 'captureEvidence':
      return 'captureSettleMs';
    case 'command':
      return 'commandSettleMs';
    case 'gesture':
      return 'gestureSettleMs';
    case 'launch':
      return 'launchSettleMs';
    case 'waitForMilestone':
      return 'waitSettleMs';
  }
}

/**
 * Resolves first-class scenario cadence metadata for a normalized step.
 *
 * @param {Record<string, unknown>} step
 * @param {ScenarioStepKind} kind
 * @param {Record<string, unknown> | undefined} scenarioCadence
 * @returns {StepCadence | undefined}
 */
function resolveStepCadence(
  step: Record<string, unknown>,
  kind: ScenarioStepKind,
  scenarioCadence?: Record<string, unknown>,
): StepCadence | undefined {
  const stepCadence = step.cadence && typeof step.cadence === 'object' && !Array.isArray(step.cadence)
    ? step.cadence as Record<string, unknown>
    : undefined;
  const stepSettleMs = readCadenceMs(stepCadence?.settleMs);
  if (stepSettleMs !== undefined) {
    return {
      ...(typeof stepCadence?.reason === 'string' ? { reason: stepCadence.reason } : {}),
      settleMs: stepSettleMs,
      source: 'step',
    };
  }

  if (!scenarioCadence) {
    return undefined;
  }

  const kindSettleMs = readCadenceMs(scenarioCadence[getScenarioKindCadenceField(kind)]);
  if (kindSettleMs !== undefined) {
    return { settleMs: kindSettleMs, source: 'scenario-kind' };
  }

  const defaultSettleMs = readCadenceMs(scenarioCadence.defaultSettleMs);
  return defaultSettleMs !== undefined
    ? { settleMs: defaultSettleMs, source: 'scenario-default' }
    : undefined;
}

/**
 * Normalizes one scenario step into an adapter-facing execution step.
 *
 * @param {Record<string, unknown>} step
 * @param {number} index
 * @param {Record<string, unknown> | undefined} scenarioCadence
 * @returns {ScenarioExecutionStep}
 */
function normalizeScenarioStep(
  step: Record<string, unknown>,
  index: number,
  scenarioCadence?: Record<string, unknown>,
): ScenarioExecutionStep {
  if (!isScenarioStepKind(step.kind)) {
    throw new Error(`Scenario step ${index + 1} has unsupported kind.`);
  }

  const cadence = resolveStepCadence(step, step.kind, scenarioCadence);

  return {
    id: typeof step.id === 'string' && step.id.length > 0 ? step.id : buildDefaultStepId(index, step.kind),
    index,
    kind: step.kind,
    portMethod: STEP_KIND_TO_PORT_METHOD[step.kind],
    required: step.required !== false,
    ...(step.adapterOptions && typeof step.adapterOptions === 'object' && !Array.isArray(step.adapterOptions)
      ? { adapterOptions: step.adapterOptions as Record<string, unknown> }
      : {}),
    ...(typeof step.artifact === 'string' ? { artifact: step.artifact } : {}),
    ...(typeof step.command === 'string' ? { command: step.command } : {}),
    ...(cadence ? { cadence } : {}),
    ...(typeof step.driverAction === 'string' ? { driverAction: step.driverAction } : {}),
    ...(typeof step.milestone === 'string' ? { milestone: step.milestone } : {}),
    ...(step.selector && typeof step.selector === 'object' && !Array.isArray(step.selector)
      ? { selector: step.selector as Record<string, unknown> }
      : {}),
    ...(typeof step.timeoutMs === 'number' && Number.isFinite(step.timeoutMs) ? { timeoutMs: step.timeoutMs } : {}),
  };
}

/**
 * Builds the adapter-facing execution plan for a scenario manifest.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {ScenarioExecutionPlan}
 */
function buildScenarioExecutionPlan(scenario: ScenarioManifest): ScenarioExecutionPlan {
  const scenarioCadence = scenario.cadence && typeof scenario.cadence === 'object' && !Array.isArray(scenario.cadence)
    ? scenario.cadence as Record<string, unknown>
    : undefined;
  const steps = Array.isArray(scenario.steps)
    ? scenario.steps.map((step: unknown, index: number) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
          throw new Error(`Scenario step ${index + 1} must be an object.`);
        }

        return normalizeScenarioStep(step as Record<string, unknown>, index, scenarioCadence);
      })
    : [];

  return {
    scenarioId: getScenarioId(scenario),
    ...(typeof scenario.flowId === 'string' ? { flowId: scenario.flowId } : {}),
    steps,
    driverActions: collectScenarioDriverActions(scenario),
  };
}

export {
  STEP_KIND_TO_PORT_METHOD,
  buildScenarioExecutionPlan,
  resolveStepCadence,
  normalizeScenarioStep,
};

export type {
  RunnerPortMethod,
  ScenarioExecutionPlan,
  ScenarioExecutionStep,
  ScenarioStepKind,
  StepCadence,
};
