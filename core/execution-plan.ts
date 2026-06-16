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

type ScenarioExecutionStep = {
  id: string;
  index: number;
  kind: ScenarioStepKind;
  portMethod: RunnerPortMethod;
  required: boolean;
  adapterOptions?: Record<string, unknown>;
  artifact?: string;
  command?: string;
  driverAction?: string;
  milestone?: string;
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
 * Normalizes one scenario step into an adapter-facing execution step.
 *
 * @param {Record<string, unknown>} step
 * @param {number} index
 * @returns {ScenarioExecutionStep}
 */
function normalizeScenarioStep(step: Record<string, unknown>, index: number): ScenarioExecutionStep {
  if (!isScenarioStepKind(step.kind)) {
    throw new Error(`Scenario step ${index + 1} has unsupported kind.`);
  }

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
    ...(typeof step.driverAction === 'string' ? { driverAction: step.driverAction } : {}),
    ...(typeof step.milestone === 'string' ? { milestone: step.milestone } : {}),
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
  const steps = Array.isArray(scenario.steps)
    ? scenario.steps.map((step: unknown, index: number) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
          throw new Error(`Scenario step ${index + 1} must be an object.`);
        }

        return normalizeScenarioStep(step as Record<string, unknown>, index);
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
  normalizeScenarioStep,
};

export type {
  RunnerPortMethod,
  ScenarioExecutionPlan,
  ScenarioExecutionStep,
  ScenarioStepKind,
};
