const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  STEP_KIND_TO_PORT_METHOD,
  buildScenarioExecutionPlan,
  normalizeScenarioStep,
} = require('../execution-plan');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;

/**
 * Reads a repo-local JSON fixture.
 *
 * @param {string} relativePath
 * @returns {unknown}
 */
function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

test('maps scenario step kinds to runner port methods', () => {
  assert.deepEqual(STEP_KIND_TO_PORT_METHOD, {
    assertUi: 'executeStep',
    captureEvidence: 'captureEvidence',
    command: 'executeStep',
    gesture: 'executeStep',
    launch: 'launch',
    waitForMilestone: 'waitForTruthEvent',
  });
});

test('builds a stable execution plan from scenario steps', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');

  const plan = buildScenarioExecutionPlan(scenario);

  assert.equal(plan.scenarioId, 'open-close-cycle');
  assert.equal(plan.flowId, 'open-close-cycle');
  assert.deepEqual(plan.driverActions, { required: [], optional: [] });
  assert.deepEqual(
    plan.steps.map((step: { id: string; kind: string; portMethod: string }) => ({
      id: step.id,
      kind: step.kind,
      portMethod: step.portMethod,
    })),
    [
      { id: 'launch', kind: 'launch', portMethod: 'launch' },
      { id: 'open-surface', kind: 'command', portMethod: 'executeStep' },
      { id: 'wait-opened', kind: 'waitForMilestone', portMethod: 'waitForTruthEvent' },
      { id: 'close-surface', kind: 'command', portMethod: 'executeStep' },
      { id: 'wait-dismissed', kind: 'waitForMilestone', portMethod: 'waitForTruthEvent' },
    ],
  );
  assert.equal(plan.steps[1].command, 'activate-target:example-surface-open');
  assert.equal(plan.steps[2].milestone, 'opened');
  assert.equal(plan.steps[2].timeoutMs, 2500);
});

test('preserves required and optional driver actions in execution plans', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps.push(
    { id: 'inspect', kind: 'assertUi', driverAction: 'inspectTree' },
    { id: 'shot', kind: 'captureEvidence', artifact: 'screenshot', driverAction: 'screenshot', required: false },
  );

  const plan = buildScenarioExecutionPlan(scenario);

  assert.deepEqual(plan.driverActions, {
    required: ['inspectTree'],
    optional: ['screenshot'],
  });
  assert.deepEqual(
    plan.steps.slice(-2).map((step: { id: string; portMethod: string; required: boolean; driverAction: string }) => ({
      driverAction: step.driverAction,
      id: step.id,
      portMethod: step.portMethod,
      required: step.required,
    })),
    [
      { driverAction: 'inspectTree', id: 'inspect', portMethod: 'executeStep', required: true },
      { driverAction: 'screenshot', id: 'shot', portMethod: 'captureEvidence', required: false },
    ],
  );
});

test('normalizes unnamed steps with deterministic ids', () => {
  const step = normalizeScenarioStep({ kind: 'gesture', driverAction: 'scroll' }, 1);

  assert.deepEqual(step, {
    driverAction: 'scroll',
    id: '02-gesture',
    index: 1,
    kind: 'gesture',
    portMethod: 'executeStep',
    required: true,
  });
});

test('rejects malformed execution steps before adapter execution', () => {
  assert.throws(
    () => normalizeScenarioStep({ kind: 'summon' }, 0),
    /unsupported kind/u,
  );
  assert.throws(
    () => buildScenarioExecutionPlan({ id: 'bad', steps: [null] }),
    /must be an object/u,
  );
});
