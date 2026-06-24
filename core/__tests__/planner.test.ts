const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  collectProvidedDriverActions,
  collectProvidedUiContexts,
  collectScenarioDriverActions,
  collectScenarioUiContexts,
  evaluateRunnerCompatibility,
} = require('../planner');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;
type PlannerIssue = {
  adapter?: string;
  artifact?: string;
  budgetEvents?: string[];
  budgetNames?: string[];
  capability?: string;
  code?: string;
  command?: string;
  driverAction?: string;
  field?: string;
  gateEvent?: string;
  nextAction?: string;
  status?: string;
  stepId?: string;
  uiContext?: string;
  waitForMilestone?: string;
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
  assert.deepEqual(result.matched.manifestVersions, [
    {
      kind: 'primary',
      runnerId: 'xcodebuildmcp-ios',
      schemaVersion: '1.0.0',
    },
  ]);
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

test('fails when scenarios require undeclared rich driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/argent-ios.json');
  scenario.steps.push({
    id: 'static-sequence',
    kind: 'gesture',
    driverAction: 'runSequence',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'missing_required_driver_action')
      .map((error: PlannerIssue) => error.driverAction),
    ['runSequence'],
  );
  assert.equal(result.matched.driverActions.includes('runSequence'), false);
});

test('accepts scenario steps when the runner declares required driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/scroll-settle.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.steps[1].driverAction = 'scroll';

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.matched.driverActions.includes('scroll'));
  assert.ok(result.matched.uiContexts.includes('app'));
});

test('accepts rich driver actions only when declared by the selected runner', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/argent-ios.json');
  runner.runnerId = 'custom-rich-gesture-runner';
  runner.driverActions.push('runSequence');
  scenario.steps.push(
    {
      id: 'long-press-card',
      kind: 'gesture',
      driverAction: 'longPress',
    },
    {
      id: 'static-sequence',
      kind: 'gesture',
      driverAction: 'runSequence',
      required: false,
    },
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.errors.filter((error: PlannerIssue) => error.code === 'missing_required_driver_action'),
    [],
  );
  assert.deepEqual(
    result.warnings.filter((warning: PlannerIssue) => warning.code === 'missing_optional_driver_action'),
    [],
  );
  assert.ok(result.matched.driverActions.includes('longPress'));
  assert.ok(result.matched.driverActions.includes('pinch'));
  assert.ok(result.matched.uiContexts.includes('app'));
});

test('collects app UI context by default for UI driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.steps.push({
    id: 'capture-final',
    kind: 'captureEvidence',
    driverAction: 'screenshot',
  });

  assert.deepEqual(collectScenarioUiContexts(scenario), {
    optional: [],
    required: ['app'],
  });
  assert.deepEqual(collectProvidedUiContexts({
    runner,
    evidenceProviders: [],
    effectivePlatforms: ['ios'],
  }), ['app']);
});

test('collects app UI context by default for rich UI driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps.push(
    {
      id: 'long-press-target',
      kind: 'gesture',
      driverAction: 'longPress',
    },
    {
      id: 'type-query',
      kind: 'gesture',
      driverAction: 'typeText',
      required: false,
    },
  );

  assert.deepEqual(collectScenarioUiContexts(scenario), {
    optional: ['app'],
    required: ['app'],
  });
});

test('does not infer app UI context for non-UI driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps.push({
    id: 'collect-perf',
    kind: 'captureEvidence',
    driverAction: 'collectPerfSignals',
  });

  assert.deepEqual(collectScenarioUiContexts(scenario), {
    optional: [],
    required: [],
  });
});

test('fails when a required system UI context has no owner', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.steps.push({
    id: 'accept-permission',
    kind: 'gesture',
    driverAction: 'tap',
    selector: {
      kind: 'text',
      value: 'Allow',
    },
    uiContext: 'systemDialog',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, false);
  assert.deepEqual(
    result.errors
      .filter((error: PlannerIssue) => error.code === 'missing_required_ui_context')
      .map((error: PlannerIssue) => error.uiContext),
    ['systemDialog'],
  );
  assert.ok(result.downgradePolicy.unsupported.some((entry: Record<string, unknown>) => (
    entry.kind === 'uiContext' &&
    entry.name === 'systemDialog' &&
    entry.code === 'missing_required_ui_context'
  )));
});

test('allows active providers to satisfy required system UI contexts', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const provider = {
    schemaVersion: '1.0.0',
    runnerId: 'system-dialog-provider',
    kind: 'evidenceProvider',
    platforms: ['ios'],
    capabilities: ['accessibility'],
    driverActions: ['tap'],
    uiContexts: ['systemDialog'],
    artifactOutputs: ['accessibility'],
  };
  scenario.steps.push({
    id: 'accept-permission',
    kind: 'gesture',
    driverAction: 'tap',
    selector: {
      kind: 'text',
      value: 'Allow',
    },
    uiContext: 'systemDialog',
  });

  const result = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [provider],
    platform: 'ios',
  });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.errors.filter((error: PlannerIssue) => error.code === 'missing_required_ui_context'),
    [],
  );
  assert.ok(result.matched.uiContexts.includes('systemDialog'));
  assert.deepEqual(result.matched.evidenceProviders, ['system-dialog-provider']);
});

test('warns when an optional UI context has no owner', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  scenario.steps.push({
    id: 'dismiss-share-sheet',
    kind: 'gesture',
    driverAction: 'tap',
    required: false,
    selector: {
      kind: 'text',
      value: 'Cancel',
    },
    uiContext: 'shareSheet',
  });

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.warnings
      .filter((warning: PlannerIssue) => warning.code === 'missing_optional_ui_context')
      .map((warning: PlannerIssue) => warning.uiContext),
    ['shareSheet'],
  );
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

test('accepts Android adb longPress selector and pressKey metadata', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps.push(
    {
      id: 'long-press-card',
      kind: 'gesture',
      driverAction: 'longPress',
      selector: {
        kind: 'testId',
        value: 'example-card-1',
      },
    },
    {
      id: 'press-system-back',
      kind: 'gesture',
      driverAction: 'pressKey',
      adapterOptions: {
        androidAdb: {
          key: 'systemBack',
        },
      },
    },
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, true);
  assert.ok(result.matched.driverActions.includes('longPress'));
  assert.ok(result.matched.driverActions.includes('pressKey'));
  assert.deepEqual(
    result.errors.filter((error: PlannerIssue) => error.code === 'invalid_adapter_options'),
    [],
  );
});

test('fails when Android adb longPress or pressKey metadata is missing', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/adb-android.json');
  scenario.steps.push(
    {
      id: 'long-press-card',
      kind: 'gesture',
      driverAction: 'longPress',
    },
    {
      id: 'press-key-missing',
      kind: 'gesture',
      driverAction: 'pressKey',
    },
    {
      id: 'press-key-unsupported',
      kind: 'gesture',
      driverAction: 'pressKey',
      adapterOptions: {
        androidAdb: {
          key: 'escape',
        },
      },
    },
  );

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
    [
      { adapter: 'androidAdb', field: 'x/y', stepId: 'long-press-card' },
      { adapter: 'androidAdb', field: 'key', stepId: 'press-key-missing' },
      { adapter: 'androidAdb', field: 'key', stepId: 'press-key-unsupported' },
    ],
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

test('agent-device runner target rejects tap and longPress steps without an executable target', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push(
    {
      id: 'tap-missing',
      kind: 'gesture',
      driverAction: 'tap',
    },
    {
      id: 'long-press-missing',
      kind: 'gesture',
      driverAction: 'longPress',
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
      { adapter: 'agentDevice', field: 'selector/ref/x/y', stepId: 'tap-missing' },
      { adapter: 'agentDevice', field: 'selector/ref/x/y', stepId: 'long-press-missing' },
    ],
  );
});

test('agent-device runner target rejects typeText steps without text', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push({
    id: 'type-search',
    kind: 'gesture',
    driverAction: 'typeText',
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
    [{ adapter: 'agentDevice', field: 'text', stepId: 'type-search' }],
  );
});

test('agent-device runner target rejects focus steps without coordinates', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push({
    id: 'focus-search',
    kind: 'gesture',
    driverAction: 'focus',
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
    [{ adapter: 'agentDevice', field: 'x/y', stepId: 'focus-search' }],
  );
});

test('agent-device runner target rejects pinch steps without scale', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push({
    id: 'pinch-map',
    kind: 'gesture',
    driverAction: 'pinch',
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
    [{ adapter: 'agentDevice', field: 'scale', stepId: 'pinch-map' }],
  );
});

test('agent-device runner target rejects pressButton steps without an executable target', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push({
    id: 'press-submit',
    kind: 'gesture',
    driverAction: 'pressButton',
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
    [{ adapter: 'agentDevice', field: 'selector/ref/x/y', stepId: 'press-submit' }],
  );
});

test('agent-device runner target accepts tap, longPress, focus, pinch, rotate, pressButton, pressKey, fill, typeText, and swipe metadata', () => {
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
    {
      id: 'long-press-ref',
      kind: 'gesture',
      driverAction: 'longPress',
      adapterOptions: {
        agentDevice: {
          durationMs: 700,
          ref: 'node-2',
        },
      },
    },
    {
      id: 'focus-search',
      kind: 'gesture',
      driverAction: 'focus',
      adapterOptions: {
        agentDevice: {
          x: 44,
          y: 88,
        },
      },
    },
    {
      id: 'pinch-map',
      kind: 'gesture',
      driverAction: 'pinch',
      adapterOptions: {
        agentDevice: {
          scale: 1.2,
          x: 120,
          y: 240,
        },
      },
    },
    {
      id: 'press-submit',
      kind: 'gesture',
      driverAction: 'pressButton',
      selector: {
        kind: 'accessibilityLabel',
        value: 'Submit',
      },
    },
    {
      id: 'rotate-landscape',
      kind: 'gesture',
      driverAction: 'rotate',
      adapterOptions: {
        agentDevice: {
          orientation: 'landscape-left',
        },
      },
    },
    {
      id: 'press-system-back',
      kind: 'gesture',
      driverAction: 'pressKey',
      adapterOptions: {
        agentDevice: {
          key: 'systemBack',
        },
      },
    },
    {
      id: 'fill-search',
      kind: 'gesture',
      driverAction: 'fill',
      selector: {
        kind: 'accessibilityLabel',
        value: 'Search',
      },
      adapterOptions: {
        agentDevice: {
          text: 'search term',
        },
      },
    },
    {
      id: 'swipe-card',
      kind: 'gesture',
      driverAction: 'swipe',
      adapterOptions: {
        agentDevice: {
          endX: 200,
          endY: 300,
          startX: 20,
          startY: 30,
        },
      },
    },
    {
      id: 'type-search',
      kind: 'gesture',
      driverAction: 'typeText',
      adapterOptions: {
        agentDevice: {
          text: 'search term',
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

test('agent-device runner target rejects rotate without orientation', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-android.json');
  scenario.steps.push({
    id: 'rotate-device',
    kind: 'gesture',
    driverAction: 'rotate',
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
    [{ adapter: 'agentDevice', field: 'orientation', stepId: 'rotate-device' }],
  );
});

test('agent-device runner target rejects fill without target or text', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push(
    {
      id: 'fill-missing-target',
      kind: 'gesture',
      driverAction: 'fill',
      adapterOptions: {
        agentDevice: {
          text: 'search term',
        },
      },
    },
    {
      id: 'fill-missing-text',
      kind: 'gesture',
      driverAction: 'fill',
      selector: {
        kind: 'accessibilityLabel',
        value: 'Search',
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
      { adapter: 'agentDevice', field: 'selector/ref/x/y', stepId: 'fill-missing-target' },
      { adapter: 'agentDevice', field: 'text', stepId: 'fill-missing-text' },
    ],
  );
});

test('agent-device runner target rejects pressKey without a supported key', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-ios.json');
  scenario.steps.push(
    {
      id: 'press-key-missing',
      kind: 'gesture',
      driverAction: 'pressKey',
    },
    {
      id: 'press-key-unsupported',
      kind: 'gesture',
      driverAction: 'pressKey',
      adapterOptions: {
        agentDevice: {
          key: 'escape',
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
      { adapter: 'agentDevice', field: 'key', stepId: 'press-key-missing' },
      { adapter: 'agentDevice', field: 'key', stepId: 'press-key-unsupported' },
    ],
  );
});

test('agent-device runner target rejects swipe without explicit coordinates', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/agent-device-android.json');
  scenario.steps.push({
    id: 'swipe-card',
    kind: 'gesture',
    driverAction: 'swipe',
    adapterOptions: {
      agentDevice: {
        startX: 20,
        startY: 30,
      },
    },
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
    [{ adapter: 'agentDevice', field: 'startX/startY/endX/endY', stepId: 'swipe-card' }],
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
  scenario.steps.push(
    {
      id: 'tap-contains',
      kind: 'gesture',
      driverAction: 'tap',
      selector: {
        kind: 'text',
        match: 'contains',
        value: 'Ready',
      },
    },
    {
      id: 'long-press-contains',
      kind: 'gesture',
      driverAction: 'longPress',
      selector: {
        kind: 'text',
        match: 'contains',
        value: 'Actions',
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
      { adapter: 'agentDevice', field: 'selector.match', stepId: 'tap-contains' },
      { adapter: 'agentDevice', field: 'selector.match', stepId: 'long-press-contains' },
    ],
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
      id: 'long-press-missing',
      kind: 'gesture',
      driverAction: 'longPress',
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
      id: 'swipe-missing',
      kind: 'gesture',
      driverAction: 'swipe',
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
      { adapter: 'argent', field: 'x/y', stepId: 'long-press-missing' },
      { adapter: 'argent', field: 'startX/startY/endX/endY', stepId: 'scroll-missing' },
      { adapter: 'argent', field: 'startX/startY/endX/endY', stepId: 'swipe-missing' },
      { adapter: 'argent', field: 'selector', stepId: 'assert-missing' },
      { adapter: 'argent', field: 'durationMs', stepId: 'tap-bad-duration' },
    ],
  );
});

test('argent runner target accepts portable visibility selector match modes', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/argent-ios.json');
  scenario.steps.push(
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
      id: 'assert-regex',
      kind: 'assertUi',
      driverAction: 'assertVisible',
      selector: {
        kind: 'text',
        match: 'regex',
        value: 'Ready|Loaded',
      },
    },
  );

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'ios' });

  assert.equal(result.compatible, true);
  assert.deepEqual(result.errors, []);
});

test('argent runner target accepts coordinate-backed tap and rich gesture metadata', () => {
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
      id: 'long-press-card',
      kind: 'gesture',
      driverAction: 'longPress',
      adapterOptions: {
        argent: {
          durationMs: 800,
          x: 0.5,
          y: 0.4,
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
    {
      id: 'drag-card',
      kind: 'gesture',
      driverAction: 'drag',
      adapterOptions: {
        argent: {
          startX: 0.2,
          startY: 0.3,
          endX: 0.7,
          endY: 0.8,
          durationMs: 450,
        },
      },
    },
    {
      id: 'pinch-map',
      kind: 'gesture',
      driverAction: 'pinch',
      adapterOptions: {
        argent: {
          centerX: 0.5,
          centerY: 0.5,
          startDistance: 0.2,
          endDistance: 0.6,
          angle: 15,
          durationMs: 400,
        },
      },
    },
    {
      id: 'rotate-map',
      kind: 'gesture',
      driverAction: 'rotateGesture',
      adapterOptions: {
        argent: {
          centerX: 0.5,
          centerY: 0.5,
          radius: 0.2,
          startAngle: 0,
          endAngle: 90,
          durationMs: 500,
        },
      },
    },
    {
      id: 'swipe-card',
      kind: 'gesture',
      driverAction: 'swipe',
      adapterOptions: {
        argent: {
          startX: 0.25,
          startY: 0.3,
          endX: 0.75,
          endY: 0.8,
          durationMs: 175,
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
  assert.ok(result.matched.driverActions.includes('longPress'));
  assert.ok(result.matched.driverActions.includes('drag'));
  assert.ok(result.matched.driverActions.includes('pinch'));
  assert.ok(result.matched.driverActions.includes('rotateGesture'));
});

test('argent runner target rejects rich gestures without required metadata', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/argent-android.json');
  scenario.steps.push(
    {
      id: 'drag-card',
      kind: 'gesture',
      driverAction: 'drag',
    },
    {
      id: 'pinch-map',
      kind: 'gesture',
      driverAction: 'pinch',
    },
    {
      id: 'rotate-map',
      kind: 'gesture',
      driverAction: 'rotateGesture',
    },
  );

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
    [
      { adapter: 'argent', field: 'startX/startY/endX/endY', stepId: 'drag-card' },
      { adapter: 'argent', field: 'centerX/centerY/startDistance/endDistance', stepId: 'pinch-map' },
      { adapter: 'argent', field: 'centerX/centerY/radius/startAngle/endAngle', stepId: 'rotate-map' },
    ],
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
  assert.ok(
    result.downgradePolicy.warnings.some(
      (entry: JsonRecord) =>
        entry.code === 'missing_optional_driver_action' &&
        entry.kind === 'driverAction' &&
        entry.name === 'collectPerfSignals' &&
        entry.status === 'warning',
    ),
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

test('warns when repeated command gate drifts from milestone budget interval anchors', () => {
  const scenario = {
    id: 'pagination-contract',
    platforms: ['android'],
    requiredCapabilities: ['launch', 'sessionControl', 'command', 'logCapture', 'artifactWrite'],
    cycles: {
      iterations: 4,
      bodyStepIds: ['scroll-to-end'],
    },
    milestones: [
      { id: 'scrollSettled', event: 'feed_scroll_settled' },
      { id: 'paginationRequested', event: 'feed_pagination_requested' },
      { id: 'paginationEnded', event: 'feed_pagination_ended' },
    ],
    budgets: [
      {
        name: 'pagination request-to-end p95',
        source: 'milestone',
        metric: 'p95',
        unit: 'ms',
        limit: 5000,
        fromMilestone: 'paginationRequested',
        toMilestone: 'paginationEnded',
      },
    ],
    steps: [
      { id: 'launch', kind: 'launch' },
      { id: 'scroll-to-end', kind: 'command', command: 'scroll-to-feed-end' },
      { id: 'wait-scroll-settled', kind: 'waitForMilestone', milestone: 'scrollSettled', timeoutMs: 5000 },
      { id: 'wait-pagination-requested', kind: 'waitForMilestone', milestone: 'paginationRequested', timeoutMs: 5000 },
      { id: 'wait-pagination-ended', kind: 'waitForMilestone', milestone: 'paginationEnded', timeoutMs: 5000 },
    ],
  };
  const runner = readJson('examples/runners/adb-android.json');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });
  const warning = result.warnings.find((entry: PlannerIssue) => entry.code === 'command_gate_budget_drift');

  assert.equal(result.compatible, true);
  assert.equal(warning?.stepId, 'scroll-to-end');
  assert.equal(warning?.command, 'scroll-to-feed-end');
  assert.equal(warning?.waitForMilestone, 'scrollSettled');
  assert.equal(warning?.gateEvent, 'feed_scroll_settled');
  assert.deepEqual(warning?.budgetEvents, ['feed_pagination_ended', 'feed_pagination_requested']);
  assert.deepEqual(warning?.budgetNames, ['pagination request-to-end p95']);
  assert.match(String(warning?.nextAction), /align body command gates/u);
});

test('does not warn when repeated command gates match milestone budget interval anchors', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  const runner = readJson('examples/runners/adb-android.json');

  const result = evaluateRunnerCompatibility({ scenario, runner, platform: 'android' });

  assert.equal(result.compatible, true);
  assert.deepEqual(
    result.warnings.filter((entry: PlannerIssue) => entry.code === 'command_gate_budget_drift'),
    [],
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
  assert.equal(result.downgradePolicy.mode, 'no-silent-downgrade');
  assert.deepEqual(result.downgradePolicy.allowedSubstitutions, []);
  assert.deepEqual(result.downgradePolicy.substitutions, []);
  assert.deepEqual(result.downgradePolicy.unsupported, [
    {
      code: 'missing_required_artifact',
      kind: 'artifact',
      name: 'profiler',
      status: 'unsupported',
    },
  ]);
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
    ['assertVisible', 'collectPerfSignals', 'inspectTree', 'longPress', 'pressKey', 'readLogs', 'record', 'screenshot', 'scroll', 'swipe', 'tap'],
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
  assert.ok(health.matched.uiContexts.includes('app'));
  assert.deepEqual(health.matched.manifestVersions, [
    {
      kind: 'primary',
      runnerId: 'xcodebuildmcp-ios',
      schemaVersion: '1.0.0',
    },
  ]);
  assert.deepEqual(health.downgradePolicy, {
    allowedSubstitutions: [],
    mode: 'no-silent-downgrade',
    substitutions: [],
    unsupported: [],
    warnings: [],
  });
});

test('planner compatibility health records active provider manifest versions', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  const provider = readJson('examples/runners/axe-accessibility-provider.json');
  const compatibility = evaluateRunnerCompatibility({
    scenario,
    runner,
    evidenceProviders: [provider],
    platform: 'ios',
  });

  const health = buildCompatibilityHealth({
    scenario,
    runId: 'run-provider-version',
    compatibility,
  });

  assert.deepEqual(health.matched.manifestVersions, [
    {
      kind: 'primary',
      runnerId: 'xcodebuildmcp-ios',
      schemaVersion: '1.0.0',
    },
    {
      kind: 'evidenceProvider',
      runnerId: 'axe-accessibility-provider',
      schemaVersion: '1.0.0',
    },
  ]);
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
  assert.deepEqual(health.downgradePolicy.warnings, [
    {
      code: 'missing_optional_capability',
      kind: 'capability',
      name: 'video',
      status: 'warning',
    },
    {
      code: 'missing_optional_artifact',
      kind: 'artifact',
      name: 'video',
      status: 'warning',
    },
  ]);
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
  assert.ok(
    health.downgradePolicy.unsupported.some(
      (entry: JsonRecord) => entry.kind === 'capability' && entry.name === 'launch',
    ),
  );
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
