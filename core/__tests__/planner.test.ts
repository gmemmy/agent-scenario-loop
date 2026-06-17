const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  collectProvidedDriverActions,
  collectScenarioDriverActions,
  evaluateRunnerCompatibility,
} = require('../planner');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;
type PlannerIssue = {
  adapter?: string;
  artifact?: string;
  capability?: string;
  code?: string;
  driverAction?: string;
  field?: string;
  status?: string;
  stepId?: string;
};
type HealthCheck = {
  code?: string;
  status?: string;
};

/**
 * Reads a repo-local JSON fixture.
 *
 * @param {string} relativePath
 * @returns {unknown}
 */
function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

/**
 * Deep-clones JSON-compatible test data.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Lists JSON fixture paths under a repo-local directory.
 *
 * @param {string} relativeDir
 * @returns {string[]}
 */
function listJsonFiles(relativeDir: string): string[] {
  const absoluteDir = path.join(ROOT, relativeDir);
  return fs
    .readdirSync(absoluteDir)
    .filter((name: string) => name.endsWith('.json'))
    .sort()
    .map((name: string) => path.join(relativeDir, name));
}

test('all canonical mobile scenarios have at least one compatible primary runner', () => {
  const scenarios = listJsonFiles('examples/scenarios/mobile').map((fixture: string) => readJson(fixture));
  const primaryRunners = listJsonFiles('examples/runners')
    .map((fixture: string) => readJson(fixture))
    .filter((runner: JsonRecord) => runner.kind === 'primary' && runner.runnerId !== 'manual-log-ingest');
  const profilerProvider = readJson('examples/runners/rozenite-profiler-provider.json');

  for (const scenario of scenarios) {
    const compatibleRunners = primaryRunners.filter((runner: JsonRecord) => {
      const platform = runner.platforms.find((candidate: string) => scenario.platforms.includes(candidate));
      const result = evaluateRunnerCompatibility({
        scenario,
        runner,
        evidenceProviders: [profilerProvider],
        platform,
      });
      return result.compatible;
    });

    assert.ok(
      compatibleRunners.length > 0,
      `${scenario.id} has no compatible primary runner fixture`,
    );
  }
});

test('manual log-ingest is intentionally incompatible with live canonical scenarios', () => {
  const scenarios = listJsonFiles('examples/scenarios/mobile').map((fixture: string) => readJson(fixture));
  const runner = readJson('examples/runners/manual-log-ingest.json');

  for (const scenario of scenarios) {
    const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

    assert.equal(result.compatible, false, `${scenario.id} unexpectedly accepted manual log ingest`);
    assert.ok(
      result.errors.some((error: PlannerIssue) => error.code === 'missing_required_capability'),
      `${scenario.id} did not report missing lifecycle capabilities`,
    );
  }
});

test('accepts a compatible primary runner for a canonical scenario', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.matched.platforms, ['ios']);
  assert.ok(result.matched.capabilities.includes('command'));
  assert.ok(result.matched.driverActions.includes('tap'));
  assert.ok(result.matched.artifacts.includes('logs'));
});

test('fails when a runner is missing a required capability', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.capabilities = runner.capabilities.filter((capability: string) => capability !== 'logCapture');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors.map((error: PlannerIssue) => error.code),
    ['missing_required_capability'],
  );
  assert.equal(result.errors[0].capability, 'logCapture');
});

test('fails when scenario steps require unsupported driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps[1].driverAction = 'collectPerfSignals';

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors.map((error: PlannerIssue) => error.code),
    ['missing_required_driver_action'],
  );
  assert.equal(result.errors[0].driverAction, 'collectPerfSignals');
});

test('accepts scenario steps when the runner declares required driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.steps[1].driverAction = 'scroll';

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.driverActions.includes('scroll'));
});

test('fails when Android adb tap metadata is missing coordinates', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps.push({
    id: 'tap-card',
    kind: 'gesture',
    driverAction: 'tap',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
        stepId: error.stepId,
      })),
    [{ adapter: 'androidAdb', field: 'x/y', stepId: 'tap-card' }],
  );
});

test('accepts Android adb tap metadata when a portable selector is present', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps.push({
    id: 'tap-card',
    kind: 'gesture',
    driverAction: 'tap',
    selector: {
      kind: 'testId',
      value: 'example-card-1',
    },
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.errors.filter((error: PlannerIssue) => error.code === 'invalid_adapter_options'),
    [],
  );
});

test('fails when Android adb assertVisible is missing a selector', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps.push({
    id: 'assert-card-visible',
    kind: 'assertUi',
    driverAction: 'assertVisible',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
        stepId: error.stepId,
      })),
    [{ adapter: 'androidAdb', field: 'selector', stepId: 'assert-card-visible' }],
  );
});

test('fails when iOS simctl command metadata is malformed', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.adapterOptions = {
    iosSimctl: {
      commands: [
        {
          waitMs: 0,
        },
      ],
      repeat: 0,
    },
  };

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
      })),
    [
      { adapter: 'iosSimctl', field: 'repeat' },
      { adapter: 'iosSimctl', field: 'commands[0].command' },
      { adapter: 'iosSimctl', field: 'commands[0].waitMs' },
    ],
  );
});

test('agent-device runner target satisfies portable driver-action scenarios', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/agent-device-android.json');
  scenario.steps[1].driverAction = 'scroll';

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.driverActions.includes('scroll'));
  assert.ok(result.matched.artifacts.includes('uiTree'));
});

test('agent-device runner target rejects tap steps without an executable target', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push({
    id: 'tap-missing',
    kind: 'gesture',
    driverAction: 'tap',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
        stepId: error.stepId,
      })),
    [{ adapter: 'agentDevice', field: 'selector/ref/x/y', stepId: 'tap-missing' }],
  );
});

test('agent-device runner target accepts tap steps with ref or coordinates', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push(
    {
      id: 'tap-ref',
      kind: 'gesture',
      driverAction: 'tap',
      adapterOptions: {
        agentDevice: {
          ref: 'node-1',
        },
      },
    },
    {
      id: 'tap-coordinates',
      kind: 'gesture',
      driverAction: 'tap',
      adapterOptions: {
        agentDevice: {
          x: 12,
          y: 34,
        },
      },
    },
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.errors.filter((error: PlannerIssue) => error.code === 'invalid_adapter_options'),
    [],
  );
});

test('agent-device runner target rejects assertVisible without a selector', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-android.json');
  scenario.steps.push({
    id: 'assert-ready',
    kind: 'assertUi',
    driverAction: 'assertVisible',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
        stepId: error.stepId,
      })),
    [{ adapter: 'agentDevice', field: 'selector', stepId: 'assert-ready' }],
  );
});

test('agent-device runner target rejects non-exact selector matches before runtime', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push({
    id: 'tap-contains',
    kind: 'gesture',
    driverAction: 'tap',
    selector: {
      kind: 'text',
      match: 'contains',
      value: 'Ready',
    },
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
        stepId: error.stepId,
      })),
    [{ adapter: 'agentDevice', field: 'selector.match', stepId: 'tap-contains' }],
  );
});

test('argent runner targets satisfy portable driver-action scenarios', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  scenario.steps[1].driverAction = 'scroll';
  scenario.steps[1].adapterOptions = {
    ...scenario.steps[1].adapterOptions,
    argent: {
      startX: 500,
      startY: 1600,
      endX: 500,
      endY: 400,
      durationMs: 250,
    },
  };

  for (const fixture of ['argent-ios.json', 'argent-android.json']) {
    const runner = readJson(`examples/runners/${fixture}`);
    const platform = runner.platforms[0];

    const result = evaluateRunnerCompatibility({ scenario, runner, platform });

    assert.equal(result.compatible, true, `${fixture} should satisfy scroll-settle`);
    assert.deepEqual(result.errors, []);
    assert.ok(result.matched.driverActions.includes('scroll'));
    assert.ok(result.matched.artifacts.includes('uiTree'));
  }
});

test('argent runner target rejects unsupported adapter metadata before runtime', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/argent-ios.json');
  scenario.steps.push(
    {
      id: 'tap-missing',
      kind: 'gesture',
      driverAction: 'tap',
    },
    {
      id: 'scroll-missing',
      kind: 'gesture',
      driverAction: 'scroll',
      adapterOptions: {
        argent: {
          startX: 100,
          startY: 800,
        },
      },
    },
    {
      id: 'assert-missing',
      kind: 'assertUi',
      driverAction: 'assertVisible',
    },
    {
      id: 'assert-contains',
      kind: 'assertUi',
      driverAction: 'assertVisible',
      selector: {
        kind: 'text',
        match: 'contains',
        value: 'Ready',
      },
    },
    {
      id: 'tap-bad-duration',
      kind: 'gesture',
      driverAction: 'tap',
      adapterOptions: {
        argent: {
          x: 1,
          y: 2,
          durationMs: 0,
        },
      },
    },
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'invalid_adapter_options')
      .map((error: PlannerIssue) => ({
        adapter: error.adapter,
        field: error.field,
        stepId: error.stepId,
      })),
    [
      { adapter: 'argent', field: 'x/y', stepId: 'tap-missing' },
      { adapter: 'argent', field: 'startX/startY/endX/endY', stepId: 'scroll-missing' },
      { adapter: 'argent', field: 'selector', stepId: 'assert-missing' },
      { adapter: 'argent', field: 'selector.match', stepId: 'assert-contains' },
      { adapter: 'argent', field: 'durationMs', stepId: 'tap-bad-duration' },
    ],
  );
});

test('argent runner target accepts coordinate-backed tap and scroll metadata', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/argent-android.json');
  scenario.steps.push(
    {
      id: 'tap-card',
      kind: 'gesture',
      driverAction: 'tap',
      adapterOptions: {
        argent: {
          x: 0.5,
          y: 0.25,
        },
      },
    },
    {
      id: 'scroll-feed',
      kind: 'gesture',
      driverAction: 'scroll',
      adapterOptions: {
        argent: {
          startX: 0.5,
          startY: 0.8,
          endX: 0.5,
          endY: 0.2,
          durationMs: 300,
        },
      },
    },
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.errors.filter((error: PlannerIssue) => error.code === 'invalid_adapter_options'),
    [],
  );
});

test('treats optional step driver actions as warnings', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps[2].driverAction = 'collectPerfSignals';
  scenario.steps[2].required = false;

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.warnings
      .filter((warning: PlannerIssue) => warning.code === 'missing_optional_driver_action')
      .map((warning: PlannerIssue) => warning.driverAction),
    ['collectPerfSignals'],
  );
});

test('collects required and optional scenario driver actions deterministically', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps.push(
    { id: 'inspect', kind: 'captureEvidence', artifact: 'uiTree', driverAction: 'inspectTree' },
    { id: 'optional-screenshot', kind: 'captureEvidence', artifact: 'screenshot', driverAction: 'screenshot', required: false },
  );

  assert.deepEqual(collectScenarioDriverActions(scenario), {
    required: ['inspectTree'],
    optional: ['screenshot'],
  });
});

test('fails early when a manual log-ingest runner cannot own live scenario lifecycle', () => {
  const scenario = readJson('examples/scenarios/mobile/media-open-close.json');
  const runner = readJson('examples/runners/manual-log-ingest.json');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'missing_required_capability')
      .map((error: PlannerIssue) => error.capability),
    ['launch', 'sessionControl', 'command'],
  );
});

test('treats missing optional evidence as warnings, not incompatibility', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.capabilities = runner.capabilities.filter(
    (capability: string) => capability !== 'screenshot' && capability !== 'video',
  );
  runner.artifactOutputs = runner.artifactOutputs.filter(
    (artifact: string) => artifact !== 'screenshot' && artifact !== 'video',
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.warnings
      .filter((warning: PlannerIssue) => warning.code === 'missing_optional_artifact')
      .map((warning: PlannerIssue) => warning.artifact),
    ['screenshot', 'video'],
  );
});

test('fails when required evidence cannot be produced by the runner or providers', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.artifacts.required.push('profiler');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors.map((error: PlannerIssue) => error.code),
    ['missing_required_artifact'],
  );
  assert.equal(result.errors[0].artifact, 'profiler');
});

test('allows an evidence provider to satisfy required evidence', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const profilerProvider = readJson('examples/runners/rozenite-profiler-provider.json');
  scenario.artifacts.required.push('profiler');

  const result = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [profilerProvider],
    platform: 'ios',
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.artifacts.includes('profiler'));
  assert.deepEqual(result.matched.evidenceProviders, ['rozenite-profiler-provider']);
});

test('axe accessibility provider can satisfy required accessibility evidence', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  const accessibilityProvider = readJson('examples/runners/axe-accessibility-provider.json');
  scenario.artifacts.required.push('accessibility');

  const result = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [accessibilityProvider],
    platform: 'android',
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.artifacts.includes('accessibility'));
  assert.deepEqual(result.matched.evidenceProviders, ['axe-accessibility-provider']);
});

test('argent react profiler provider can satisfy required profiler evidence', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/adb-android.json');
  const profilerProvider = readJson('examples/runners/argent-react-profiler-provider.json');
  scenario.artifacts.required.push('profiler');

  const result = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [profilerProvider],
    platform: 'android',
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.artifacts.includes('profiler'));
  assert.deepEqual(result.matched.evidenceProviders, ['argent-react-profiler-provider']);
});

test('active evidence providers can satisfy required provider driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/adb-android.json');
  const profilerProvider = readJson('examples/runners/argent-react-profiler-provider.json');
  scenario.steps.push({
    id: 'collect-js-profile',
    kind: 'captureEvidence',
    artifact: 'profiler',
    driverAction: 'collectPerfSignals',
  });
  scenario.artifacts.required.push('profiler');

  const result = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [profilerProvider],
    platform: 'android',
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.driverActions.includes('collectPerfSignals'));
  assert.deepEqual(result.matched.evidenceProviders, ['argent-react-profiler-provider']);
});

test('inactive evidence provider driver actions do not satisfy selected platform', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const profilerProvider = readJson('examples/runners/argent-react-profiler-provider.json');
  scenario.steps.push({
    id: 'collect-js-profile',
    kind: 'captureEvidence',
    artifact: 'profiler',
    driverAction: 'collectPerfSignals',
  });

  const result = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [profilerProvider],
    platform: 'ios',
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'missing_required_driver_action')
      .map((error: PlannerIssue) => error.driverAction),
    ['collectPerfSignals'],
  );
  assert.equal(result.matched.driverActions.includes('collectPerfSignals'), false);
  assert.deepEqual(result.matched.evidenceProviders, []);
});

test('collects provider driver actions only from active providers', () => {
  const runner = readJson('examples/runners/adb-android.json');
  const androidProvider = readJson('examples/runners/argent-react-profiler-provider.json');
  const inactiveProvider = clone(androidProvider);
  inactiveProvider.runnerId = 'inactive-profiler-provider';
  inactiveProvider.platforms = ['ios'];
  inactiveProvider.driverActions = ['screenshot'];

  assert.deepEqual(
    collectProvidedDriverActions({
      runner,
      evidenceProviders: [inactiveProvider, androidProvider],
      effectivePlatforms: ['android'],
    }),
    ['assertVisible', 'collectPerfSignals', 'inspectTree', 'readLogs', 'record', 'screenshot', 'scroll', 'tap'],
  );
});

test('rejects a selected platform that the runner does not support', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, false);
  assert.equal(result.errors[0].code, 'platform_not_supported_by_runner');
});

test('does not mutate caller-owned manifests', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const originalScenario = clone(scenario);
  const originalRunner = clone(runner);

  evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.deepEqual(scenario, originalScenario);
  assert.deepEqual(runner, originalRunner);
});

test('maps compatible planner output to passed health', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const compatibility = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  const health = buildCompatibilityHealth({
    scenario,
    runId: 'run-1',
    compatibility,
  });

  assert.equal(health.schemaVersion, '1.0.0');
  assert.equal(health.scenarioId, 'app-startup');
  assert.equal(health.flowId, 'startup');
  assert.equal(health.runId, 'run-1');
  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(
    health.checks.map((check: HealthCheck) => check.status),
    ['passed'],
  );
  assert.ok(health.matched.capabilities.includes('launch'));
  assert.ok(health.matched.driverActions.includes('screenshot'));
});

test('maps planner warnings into health warnings without failing health', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.capabilities = runner.capabilities.filter((capability: string) => capability !== 'video');
  runner.artifactOutputs = runner.artifactOutputs.filter((artifact: string) => artifact !== 'video');
  const compatibility = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  const health = buildCompatibilityHealth({
    scenario,
    runId: 'run-2',
    compatibility,
  });

  assert.equal(health.healthStatus, 'passed');
  assert.deepEqual(
    health.warnings.map((warning: PlannerIssue) => warning.code),
    ['missing_optional_capability', 'missing_optional_artifact'],
  );
});

test('maps incompatible planner output to failed health checks', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/manual-log-ingest.json');
  const compatibility = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  const health = buildCompatibilityHealth({
    scenario,
    runId: 'run-3',
    compatibility,
  });

  assert.equal(health.healthStatus, 'failed');
  assert.ok(health.checks.length >= 1);
  assert.ok(health.checks.every((check: HealthCheck) => check.status === 'failed'));
  assert.ok(health.checks.some((check: HealthCheck) => check.code === 'missing_required_capability'));
});

test('creates a not-evaluated verdict when health passes before budget evaluation', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const compatibility = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });
  const health = buildCompatibilityHealth({ scenario, runId: 'run-4', compatibility });

  const verdict = buildUnevaluatedVerdict({ scenario, health });

  assert.equal(verdict.schemaVersion, '1.0.0');
  assert.equal(verdict.scenarioId, 'app-startup');
  assert.equal(verdict.healthStatus, 'passed');
  assert.equal(verdict.verdictStatus, 'not_evaluated');
  assert.deepEqual(verdict.budgetChecks, []);
});

test('creates an inconclusive verdict when health fails', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/manual-log-ingest.json');
  const compatibility = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });
  const health = buildCompatibilityHealth({ scenario, runId: 'run-5', compatibility });

  const verdict = buildUnevaluatedVerdict({ scenario, health });

  assert.equal(verdict.healthStatus, 'failed');
  assert.equal(verdict.verdictStatus, 'inconclusive');
  assert.match(verdict.summary, /do not optimize/u);
});
