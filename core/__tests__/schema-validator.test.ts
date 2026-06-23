const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SCHEMAS,
  SchemaValidationError,
  assertValidJson,
  validateJson,
} = require('../schema-validator');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;
type ValidationIssue = {
  code?: string;
  path?: string;
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

function unknownLifecycleAssertion() {
  return {
    evidence: 'not-asserted',
    value: 'unknown',
  };
}

function sampleEnvironmentLifecycle() {
  return {
    postconditions: {
      appState: unknownLifecycleAssertion(),
      artifactState: unknownLifecycleAssertion(),
      lifecyclePhase: unknownLifecycleAssertion(),
      cleanupState: unknownLifecycleAssertion(),
      dataState: unknownLifecycleAssertion(),
    },
    preconditions: {
      animations: unknownLifecycleAssertion(),
      appDataState: unknownLifecycleAssertion(),
      authState: unknownLifecycleAssertion(),
      deviceLockState: unknownLifecycleAssertion(),
      fontScale: unknownLifecycleAssertion(),
      foregroundState: unknownLifecycleAssertion(),
      lifecyclePhase: unknownLifecycleAssertion(),
      initialRoute: unknownLifecycleAssertion(),
      installedState: unknownLifecycleAssertion(),
      locale: unknownLifecycleAssertion(),
      networkState: unknownLifecycleAssertion(),
      orientation: unknownLifecycleAssertion(),
      permissions: unknownLifecycleAssertion(),
      theme: unknownLifecycleAssertion(),
      timezone: unknownLifecycleAssertion(),
    },
  };
}

function sampleEnvironment(): JsonRecord {
  return {
    platform: 'android',
    bundleId: 'com.example.app',
    runtimeTarget: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    nodeVersion: 'v25.0.0',
    ...sampleEnvironmentLifecycle(),
  };
}

function sampleDiagnostics(): JsonRecord[] {
  return [
    {
      kind: 'logs',
      name: 'device-log',
      status: 'captured',
      required: true,
      path: 'raw/device.log',
      reason: 'Device log evidence was captured.',
    },
    {
      kind: 'video',
      status: 'not_requested',
      required: false,
      reason: 'Scenario did not request this optional diagnostic surface.',
    },
  ];
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

test('accepts all canonical mobile scenario manifests', () => {
  for (const fixture of listJsonFiles('examples/scenarios/mobile')) {
    const result = validateJson(readJson(fixture), SCHEMAS.scenario, fixture);
    assert.equal(result.valid, true, result.message);
  }
});

test('canonical mobile scenarios expose journey, milestones, cycles, and expected events', () => {
  for (const fixture of listJsonFiles('examples/scenarios/mobile')) {
    const scenario = readJson(fixture);

    assert.equal(typeof scenario.journey?.intent, 'string', `${fixture} is missing journey intent`);
    assert.ok(Array.isArray(scenario.milestones), `${fixture} is missing milestones`);
    assert.ok(Array.isArray(scenario.expectedEvents), `${fixture} is missing expectedEvents`);
    assert.equal(typeof scenario.cycles?.iterations, 'number', `${fixture} is missing cycle iterations`);
  }
});

test('accepts all runner capability manifests', () => {
  for (const fixture of listJsonFiles('examples/runners')) {
    const result = validateJson(readJson(fixture), SCHEMAS.runnerCapabilities, fixture);
    assert.equal(result.valid, true, result.message);
  }
});

test('documents every shipped runner and provider target manifest', () => {
  const manifestNames = listJsonFiles('examples/runners')
    .map((fixture: string) => path.basename(fixture))
    .sort();
  const readme = fs.readFileSync(path.join(ROOT, 'examples', 'runners', 'README.md'), 'utf8');
  const documentedNames: string[] = [];
  for (const match of readme.matchAll(/`([^`]+\.json)`/gu)) {
    const name = match[1];
    if (typeof name === 'string') {
      documentedNames.push(name);
    }
  }
  documentedNames.sort();

  assert.deepEqual(documentedNames, manifestNames);
});

test('script provider examples declare command-backed evidence outputs', () => {
  const expected = new Map([
    ['examples/runners/script-accessibility-provider.json', 'accessibility'],
    ['examples/runners/script-memory-provider.json', 'memory'],
    ['examples/runners/script-native-performance-provider.json', 'nativePerformance'],
    ['examples/runners/script-network-provider.json', 'network'],
    ['examples/runners/script-profiler-provider.json', 'profiler'],
  ]);

  for (const [fixture, capability] of expected.entries()) {
    const provider = readJson(fixture);
    assert.equal(provider.kind, 'evidenceProvider');
    assert.ok(provider.capabilities.includes(capability), `${fixture} does not declare ${capability}`);
    assert.ok(Array.isArray(provider.providerCommands), `${fixture} is missing providerCommands`);
    assert.ok(provider.providerCommands.length > 0, `${fixture} has no provider commands`);
    assert.ok(
      provider.providerCommands.every((command: JsonRecord) => Array.isArray(command.outputs) && command.outputs.length > 0),
      `${fixture} has a command without outputs`,
    );
  }
});

test('accepts shipped authoring templates', () => {
  const scenario = validateJson(readJson('templates/mobile-scenario.json'), SCHEMAS.scenario, 'templates/mobile-scenario.json');
  const primaryRunner = validateJson(readJson('templates/primary-runner.json'), SCHEMAS.runnerCapabilities, 'templates/primary-runner.json');
  const evidenceProvider = validateJson(readJson('templates/evidence-provider.json'), SCHEMAS.runnerCapabilities, 'templates/evidence-provider.json');

  assert.equal(scenario.valid, true, scenario.message);
  assert.equal(primaryRunner.valid, true, primaryRunner.message);
  assert.equal(evidenceProvider.valid, true, evidenceProvider.message);
});

test('accepts canonical mobile scenario manifests', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('accepts scenario-authored comparison lanes', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.comparisonLane = 'example-android-live+agent-device';

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('accepts aggregate live proof set artifacts', () => {
  const artifact = {
    schemaVersion: '1.0.0',
    runId: 'live-proof-set',
    status: 'passed',
    proofCount: 2,
    requiredPlatforms: ['android', 'ios'],
    presentPlatforms: ['android', 'ios'],
    missingPlatforms: [],
    proofs: [
      {
        filePath: '/tmp/android/live-proof.json',
        platform: 'android',
        runId: 'android-live-proof',
        status: 'passed',
        comparisonStatus: 'not_compared',
        summaryPath: '/tmp/android/agent-summary.md',
        profileCount: 3,
        interactionProofCount: 1,
        interactionWarningCount: 0,
        nextAction: {
          code: 'inspect_summary',
          summary: 'Inspect linked evidence.',
        },
      },
      {
        filePath: '/tmp/ios/live-proof.json',
        platform: 'ios',
        runId: 'ios-live-proof',
        status: 'passed',
        comparisonStatus: 'not_compared',
        summaryPath: '/tmp/ios/agent-summary.md',
        profileCount: 3,
        interactionProofCount: 1,
        interactionWarningCount: 1,
        nextAction: {
          code: 'inspect_summary',
          summary: 'Inspect linked evidence.',
        },
      },
    ],
    failureReasons: [],
    nextAction: {
      code: 'inspect_summary',
      summary: 'Platform proof set is complete; inspect linked artifacts for detail.',
    },
    summary: 'live proof set passed for android, ios.',
  };

  const result = validateJson(artifact, SCHEMAS.liveProofSet, 'Live proof set artifact');

  assert.equal(result.valid, true, result.message);
  assert.deepEqual(result.errors, []);
});

test('rejects missing required scenario properties', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  delete scenario.truthEvents;

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((error: ValidationIssue) => error.code),
    ['missing_required_property'],
  );
  assert.equal(result.errors[0].path, '$.truthEvents');
});

test('rejects invalid enum values through local schema refs', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.requiredCapabilities.push('telepathy');

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.requiredCapabilities[4]'));
  assert.ok(result.message.includes('telepathy') === false);
});

test('rejects invalid scenario driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps[0].driverAction = 'shake';

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.steps[0].driverAction'));
});

test('accepts rich portable scenario driver actions', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps.push(
    { id: 'long-press-link', kind: 'gesture', driverAction: 'longPress' },
    { id: 'pinch-map', kind: 'gesture', driverAction: 'pinch' },
    { id: 'type-search', kind: 'gesture', driverAction: 'typeText' },
    { id: 'press-enter', kind: 'gesture', driverAction: 'pressKey' },
    { id: 'custom-two-finger', kind: 'gesture', driverAction: 'customGesture' },
    { id: 'bounded-sequence', kind: 'gesture', driverAction: 'runSequence' },
  );

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, true, result.message);
});

test('accepts portable scenario step selectors', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps[1].selector = {
    kind: 'accessibilityLabel',
    match: 'contains',
    platforms: ['ios', 'android'],
    value: 'Start',
  };

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, true, result.message);
});

test('rejects invalid scenario step selectors', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.steps[1].selector = {
    kind: 'css',
    value: 'button.primary',
  };

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.steps[1].selector.kind'));
});

test('rejects invalid runner driver actions', () => {
  const runner = readJson('examples/runners/adb-android.json');
  runner.driverActions.push('teleport');

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === `$.driverActions[${runner.driverActions.length - 1}]`));
});

test('accepts rich portable runner driver actions', () => {
  const runner = readJson('examples/runners/argent-ios.json');
  runner.runnerId = 'rich-gesture-runner';
  runner.driverActions.push('longPress', 'swipe', 'drag', 'pinch', 'rotate', 'typeText', 'pressButton');

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, true, result.message);
});

test('rejects provider commands on primary runner manifests', () => {
  const runner = readJson('templates/primary-runner.json');
  runner.providerCommands = [
    {
      id: 'capture-profiler',
      phase: 'capture',
      command: 'capture-profiler',
      outputs: [
        {
          channel: 'provider',
          kind: 'profiler',
          path: '{providerDir}/profiler.json',
        },
      ],
    },
  ];

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors
      .filter((error: ValidationIssue) => error.code === 'schema_not')
      .map((error: ValidationIssue) => error.path),
    ['$'],
  );
  assert.match(result.message, /Primary runner manifests cannot declare providerCommands/u);
});

test('accepts required provider command outputs', () => {
  const provider = readJson('templates/evidence-provider.json');
  provider.providerCommands = [
    {
      id: 'capture-memory',
      phase: 'postRun',
      command: 'capture-memory',
      outputs: [
        {
          channel: 'signal',
          kind: 'memory',
          path: '{providerDir}/memory.json',
          required: true,
        },
      ],
    },
  ];

  const result = validateJson(provider, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, true, result.message);
  assert.deepEqual(result.errors, []);
});

test('validates structured profiler evidence envelopes', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'rn-profiler',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    tool: {
      name: 'react-native-profiler',
      version: '1.0.0',
    },
    completenessStatus: 'complete',
    metrics: {
      commitCount: 12,
      jsLongTaskCount: 1,
    },
    samples: [],
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('validates lifecycle-owned profiler evidence envelopes', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    captureMode: 'session',
    profileKind: 'cpu-summary',
    dataClasses: ['cpu-samples', 'react-commits'],
    tool: {
      name: 'react-native-profiler',
      version: '1.0.0',
    },
    lifecycle: {
      phase: 'activeLoop',
      startedAt: '2026-06-21T12:50:33.000Z',
      endedAt: '2026-06-21T12:50:53.000Z',
      durationMs: 20000,
      perturbsTiming: true,
      events: [
        {
          name: 'profiler-start',
          at: '2026-06-21T12:50:33.000Z',
          status: 'completed',
        },
        {
          name: 'profiler-stop',
          at: '2026-06-21T12:50:53.000Z',
          status: 'completed',
        },
      ],
    },
    targetBinding: {
      status: 'verified',
      deviceId: 'booted',
      appId: 'dev.agent-scenario-loop.example',
      source: 'debugger-status',
    },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Profiler session ran inside the measured loop and may perturb timing budgets.',
      policy: 'Use for diagnosis, not budget comparison.',
    },
    completenessStatus: 'complete',
    metrics: {
      sampleCount: 1457,
      durationMs: 20380,
    },
    attachments: [
      {
        kind: 'raw-cpu-profile',
        path: 'raw/providers/react-profiler/cpu.json',
      },
      {
        kind: 'react-commits',
        path: 'raw/providers/react-profiler/commits.json',
      },
      {
        kind: 'report',
        path: 'raw/providers/react-profiler/report.md',
      },
    ],
    summary: 'Profiler session captured CPU samples and preserved raw attachments.',
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects comparable profiler evidence without verified claim support', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    captureMode: 'unknown',
    comparability: {
      status: 'comparable',
    },
    completenessStatus: 'partial',
    targetBinding: {
      status: 'ambiguous',
      reason: 'Debugger status returned a different attached runtime.',
    },
    metrics: {
      sampleCount: 1457,
    },
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.tool'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.captureMode'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.completenessStatus'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.status'));
});

test('accepts profiler target binding candidates for ambiguous provider sessions', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    captureMode: 'session',
    profileKind: 'cpu-summary',
    completenessStatus: 'partial',
    targetBinding: {
      status: 'ambiguous',
      source: 'debugger-status',
      reason: 'Debugger status reported multiple attached runtimes.',
      candidateTargets: [
        {
          platform: 'ios',
          deviceId: 'A692ED28-893E-453F-8866-C69331AE757F',
          deviceName: 'iPhone 17 Pro Max',
          appId: 'dev.agent-scenario-loop.example.ios',
          source: 'requested-target',
          bindingStatus: 'expected',
        },
        {
          platform: 'android',
          deviceId: 'emulator-5554',
          deviceName: 'sdk_gphone64_arm64',
          appId: 'dev.agent-scenario-loop.example.android',
          source: 'debugger-status',
          evidencePath: 'raw/providers/react-profiler/debugger-status.json',
          bindingStatus: 'conflicting',
          reason: 'Provider status was bound to the active Android debugger runtime.',
        },
      ],
    },
    comparability: {
      status: 'captured-not-comparable',
      reason: 'Target binding was ambiguous; use the profile only to diagnose provider binding.',
    },
    metrics: {
      sampleCount: 1457,
    },
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts comparable profiler evidence with verified claim support', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'startup',
    captureMode: 'session',
    profileKind: 'cpu-summary',
    tool: {
      name: 'argent',
      version: '0.12.1',
    },
    comparability: {
      status: 'comparable',
      policy: 'Same isolated runtime, app build, scenario hash, and profiler window cohort.',
    },
    completenessStatus: 'complete',
    targetBinding: {
      status: 'verified',
      deviceId: 'emulator-5554',
      appId: 'dev.agent-scenario-loop.example',
      source: 'debugger-status',
    },
    metrics: {
      sampleCount: 2084,
      durationMs: 23100,
    },
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects invalid profiler target binding candidates', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    targetBinding: {
      status: 'ambiguous',
      candidateTargets: [
        {
          platform: 'web',
          bindingStatus: 'selected',
        },
      ],
    },
    summary: 'Invalid candidate target metadata.',
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.candidateTargets[0].platform'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.candidateTargets[0].bindingStatus'));
});

test('rejects ambiguous profiler target binding without candidates', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    targetBinding: {
      status: 'ambiguous',
      reason: 'Provider reported multiple possible runtime sessions.',
    },
    summary: 'Missing candidate target metadata.',
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.candidateTargets'));
});

test('rejects empty profiler target binding candidates', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    targetBinding: {
      status: 'ambiguous',
      candidateTargets: [{}],
    },
    summary: 'Empty candidate target metadata.',
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.candidateTargets[0]'));
});

test('validates native performance evidence envelopes', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'feed-scroll',
    captureMode: 'afterCapture',
    evidenceKind: 'gfxinfo',
    dataClasses: ['frames', 'jank', 'memory'],
    tool: {
      name: 'adb',
      command: 'dumpsys gfxinfo',
    },
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding: {
      status: 'verified',
      deviceId: 'emulator-5554',
      appId: 'dev.agent-scenario-loop.example',
      source: 'adb',
    },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Native frame summary was captured after the ASL loop.',
      policy: 'Use for diagnosis until cohort-aware native metric comparison is configured.',
    },
    claimSufficiency: {
      status: 'sufficient-for-diagnosis',
      claim: 'Explain native frame and memory pressure after a profile run.',
      reason: 'Captured frame and memory surfaces are present, but this evidence was not collected under a comparable native-performance baseline.',
      supportingEvidence: ['frames', 'memory', 'attachments'],
      missingEvidence: ['comparable native-performance cohort'],
    },
    completenessStatus: 'complete',
    frames: {
      total: 180,
      janky: 3,
      p95Ms: 12.4,
    },
    memory: {
      rssBytes: 12345678,
    },
    attachments: [
      {
        kind: 'raw-gfxinfo',
        path: 'raw/providers/native-performance/gfxinfo.txt',
      },
      {
        kind: 'meminfo',
        path: 'raw/providers/native-performance/meminfo.txt',
      },
    ],
    summary: 'Captured Android native frame and memory diagnostics.',
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts native performance target binding candidates for mismatched diagnostics', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'video-handoff',
    captureMode: 'afterCapture',
    evidenceKind: 'mixed',
    dataClasses: ['frames', 'memory'],
    completenessStatus: 'partial',
    targetBinding: {
      status: 'mismatch',
      source: 'provider-session-status',
      reason: 'Native diagnostics were captured from a provider session that did not match the requested app.',
      candidateTargets: [
        {
          platform: 'android',
          deviceId: 'emulator-5554',
          appId: 'dev.agent-scenario-loop.expected',
          source: 'runner-request',
          bindingStatus: 'expected',
        },
        {
          platform: 'android',
          deviceId: 'emulator-5554',
          appId: 'dev.agent-scenario-loop.other',
          source: 'provider-session-status',
          evidencePath: 'raw/providers/native-performance/session-status.json',
          bindingStatus: 'observed',
        },
      ],
    },
    comparability: {
      status: 'captured-not-comparable',
      reason: 'Target app mismatch prevents native-performance comparison.',
    },
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Native performance release readiness.',
      reason: 'Useful frame and memory outputs were preserved, but target binding did not match the requested app.',
      supportingEvidence: ['frames', 'memory'],
      missingEvidence: ['verified target binding'],
      nextAction: 'Fix provider target binding and rerun before making a product claim.',
    },
    frames: {
      droppedFramePercent: 10.6,
    },
    memory: {
      totalPssKb: 1264994,
    },
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects profiler evidence with invalid lifecycle vocabulary', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'react-profiler-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'startup',
    captureMode: 'magic',
    completenessStatus: 'complete',
    summary: 'Invalid profiler capture mode.',
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.captureMode'));
});

test('rejects profiler evidence without source and content envelope', () => {
  const result = validateJson({
    samples: [],
  }, SCHEMAS.profiler, 'Profiler evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.providerId'));
});

test('rejects native performance evidence without source and content envelope', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'feed-scroll',
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$'));
});

test('accepts diagnostic-only native performance evidence without comparable claim fields', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'feed-scroll',
    comparability: {
      status: 'diagnostic-only',
      reason: 'Post-run native counters are useful for diagnosis but not a product budget.',
    },
    summary: 'Captured post-run native diagnostics.',
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts partial native performance evidence with explicit claim insufficiency', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'video-handoff',
    captureMode: 'afterCapture',
    evidenceKind: 'mixed',
    dataClasses: ['frames', 'memory'],
    completenessStatus: 'partial',
    targetBinding: {
      status: 'verified',
      deviceId: 'emulator-5554',
      appId: 'dev.agent-scenario-loop.example',
      source: 'adb',
    },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Accessibility capture failed, but native frame and memory evidence survived.',
    },
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Native performance release readiness.',
      reason: 'The evidence can explain jank and memory pressure but is missing a complete comparable native trace.',
      supportingEvidence: ['frames', 'memory'],
      missingEvidence: ['complete provider diagnostics', 'comparable baseline'],
      nextAction: 'Use this as diagnosis only; rerun a complete comparable native-performance lane before making a release claim.',
    },
    frames: {
      total: 7574,
      droppedFramePercent: 10.6,
    },
    memory: {
      totalPssKb: 1264994,
    },
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts iOS native performance diagnostic source inventories', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'link-preview',
    captureMode: 'afterCapture',
    evidenceKind: 'mixed',
    dataClasses: ['frames', 'jank', 'memory', 'cpu', 'native-trace'],
    completenessStatus: 'partial',
    targetBinding: {
      status: 'unverified',
      reason: 'iOS native diagnostics were scaffolded but not bound to a simulator/app target.',
    },
    comparability: {
      status: 'diagnostic-only',
      reason: 'The scaffold declares iOS source lanes but does not capture comparable native evidence.',
    },
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'iOS native performance release readiness.',
      reason: 'No Instruments, xctrace, MetricKit, or simctl-derived native-performance source has been captured yet.',
      supportingEvidence: ['diagnosticSources'],
      missingEvidence: ['captured iOS native diagnostic source', 'verified target binding'],
      nextAction: 'Capture a bounded iOS native-performance source and preserve raw attachments before making a claim.',
    },
    diagnosticSources: [
      {
        sourceId: 'instruments',
        status: 'unverified',
        tool: {
          name: 'Instruments',
        },
        dataClasses: ['frames', 'jank', 'cpu', 'memory', 'native-trace'],
        reason: 'Not captured by this scaffold provider.',
        nextAction: 'Capture an Instruments trace or exported summary.',
      },
      {
        sourceId: 'xctrace',
        status: 'available-unproven',
        tool: {
          name: 'xctrace',
          command: 'xctrace record',
        },
        dataClasses: ['cpu', 'thread-scheduling', 'memory', 'native-trace'],
        reason: 'The lane is declared, but runtime target binding and output parsing are not proven.',
      },
      {
        sourceId: 'metrickit',
        status: 'not-requested',
        tool: {
          name: 'MetricKit',
        },
        dataClasses: ['frames', 'jank', 'cpu', 'memory', 'thermal', 'battery'],
        reason: 'MetricKit payload ingestion was not requested for this run.',
      },
    ],
    summary: 'iOS native-performance source inventory is explicit but not claim-sufficient.',
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts native performance diagnostic source inventory as the only content surface', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'feed-scroll',
    diagnosticSources: [
      {
        sourceId: 'gfxinfo',
        status: 'timeout',
        tool: {
          name: 'adb dumpsys gfxinfo',
        },
        dataClasses: ['frames', 'jank', 'render'],
        reason: 'The device did not return gfxinfo output before the provider timeout.',
        nextAction: 'Retry after stabilizing the target app or mark frame evidence unavailable for this run.',
      },
      {
        sourceId: 'meminfo',
        status: 'not-requested',
        dataClasses: ['memory'],
        reason: 'Memory capture was not requested by this provider lane.',
      },
    ],
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects native performance diagnostic source inventories with unknown source status', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'ios',
    runId: 'profile-run',
    scenarioId: 'link-preview',
    diagnosticSources: [
      {
        sourceId: 'xctrace',
        status: 'magical',
      },
    ],
    summary: 'Invalid source status.',
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.diagnosticSources[0].status'));
});

test('rejects native performance claim sufficiency without comparable support', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'video-handoff',
    completenessStatus: 'partial',
    targetBinding: {
      status: 'unverified',
    },
    comparability: {
      status: 'diagnostic-only',
    },
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      claim: 'Native performance release readiness.',
    },
    frames: {
      droppedFramePercent: 10.6,
    },
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.comparability.status'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.completenessStatus'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.status'));
});

test('rejects comparable native performance evidence without verified claim support', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'feed-scroll',
    captureMode: 'unknown',
    comparability: {
      status: 'comparable',
    },
    completenessStatus: 'partial',
    targetBinding: {
      status: 'unverified',
    },
    frames: {
      janky: 42,
    },
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.tool'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.captureMode'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.completenessStatus'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.targetBinding.status'));
});

test('accepts comparable native performance evidence with verified claim support', () => {
  const result = validateJson({
    schemaVersion: '1.0.0',
    providerId: 'native-performance-provider',
    platform: 'android',
    runId: 'profile-run',
    scenarioId: 'feed-scroll',
    tool: {
      name: 'trace-processor',
      command: 'trace_processor_shell',
    },
    captureMode: 'session',
    evidenceKind: 'trace-processor',
    comparability: {
      status: 'comparable',
      policy: 'Same device, app build, scenario hash, and trace window cohort.',
    },
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      claim: 'Compare native frame timing against the matching cohort baseline.',
      reason: 'Trace summary is complete, comparable, and bound to the expected target.',
      supportingEvidence: ['frames'],
    },
    completenessStatus: 'complete',
    targetBinding: {
      status: 'verified',
      deviceId: 'emulator-5554',
      appId: 'dev.agent-scenario-loop.example',
      source: 'adb',
    },
    frames: {
      total: 180,
      janky: 3,
      p95Ms: 12.4,
    },
  }, SCHEMAS.nativePerformance, 'Native performance evidence artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects invalid scenario cycle counts', () => {
  const scenario = readJson('examples/scenarios/mobile/open-close-cycle.json');
  scenario.cycles.iterations = 0;

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.cycles.iterations'));
});

test('rejects duplicate unique array items', () => {
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.platforms.push('ios');

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'duplicate_item'));
});

test('applies conditional schema constraints', () => {
  const schema = {
    type: 'object',
    allOf: [
      {
        if: {
          properties: {
            kind: {
              const: 'primary',
            },
          },
          required: ['kind'],
        },
        then: {
          not: {
            description: 'primary values cannot include providerOnly',
            required: ['providerOnly'],
          },
        },
      },
    ],
    properties: {
      kind: {
        enum: ['primary', 'evidenceProvider'],
        type: 'string',
      },
      providerOnly: {
        type: 'boolean',
      },
    },
    required: ['kind'],
  };

  assert.deepEqual(validateJson({ kind: 'primary' }, schema, 'Conditional fixture').errors, []);
  assert.deepEqual(validateJson({ kind: 'evidenceProvider', providerOnly: true }, schema, 'Conditional fixture').errors, []);
  const result = validateJson({ kind: 'primary', providerOnly: true }, schema, 'Conditional fixture');

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error: ValidationIssue) => error.code), ['schema_not']);
  assert.match(result.message, /primary values cannot include providerOnly/u);
});

test('rejects additional properties in strict objects', () => {
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.experimental = true;

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors
      .filter((error: ValidationIssue) => error.code === 'additional_property')
      .map((error: ValidationIssue) => error.path),
    ['$.experimental'],
  );
});

test('accepts comparison artifacts with metric and evidence details', () => {
  const comparison = {
    schemaVersion: '1.0.0',
    scenarioId: 'open-close-cycle',
    flowId: 'open-close-cycle',
    runId: 'current-run',
    baselineRunId: 'baseline-run',
    comparisonStatus: 'better',
    healthStatus: 'passed',
    verdictStatus: 'passed',
    comparisonBasis: {
      strategy: 'latest_trusted_prior',
      baseline: {
        runId: 'baseline-run',
        runDir: 'artifacts/asl/android/open-close-cycle/baseline-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      current: {
        runId: 'current-run',
        runDir: 'artifacts/asl/android/open-close-cycle/current-run',
        healthStatus: 'passed',
        verdictStatus: 'passed',
      },
      selection: {
        artifactRoot: 'artifacts/asl/android',
        candidatesInspected: 4,
        scenarioId: 'open-close-cycle',
        selectedRunDir: 'artifacts/asl/android/open-close-cycle/baseline-run',
        selectedRunId: 'baseline-run',
        skippedCurrentRun: true,
        trustedCandidates: 3,
        trustedPriorCandidates: 2,
      },
    },
    metricComparisons: [
      {
        name: 'open p95',
        unit: 'ms',
        baseline: 1200,
        current: 980,
        delta: -220,
        status: 'better',
      },
    ],
    evidence: {
      missingRequired: [],
      warnings: ['video artifact not captured'],
    },
    summary: 'Current run improved against the explicit baseline.',
  };

  const result = validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts manifest and metrics profile artifacts', () => {
  const manifest: JsonRecord = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {
      node: 'v25.0.0',
    },
    provenance: {
      gitSha: 'unknown',
      toolVersions: {
        node: 'v25.0.0',
      },
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'passed',
      terminalState: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'none',
      },
      cleanup: {
        status: 'not-required',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
    environment: sampleEnvironment(),
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
    },
    failureReason: null,
  };
  const metrics = {
    scenario: 'app-startup',
    runId: 'run-1',
    status: 'passed',
    iterations: 1,
    durationsMs: [1000],
    p50Ms: 1000,
    p95Ms: 1000,
    failures: 0,
    timeouts: 0,
    openDurationsMs: [800],
    closeDurationsMs: [100],
    incompleteIterations: [],
    artifacts: {},
    budgetEvaluation: {
      metric: 'startup',
      pass: true,
      checks: [
        {
          name: 'cycle p95',
          actual: 1000,
          limit: 1500,
          pass: true,
          unit: 'ms',
        },
      ],
      failedChecks: [],
    },
  };

  assert.equal(validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact').valid, true);
  assert.equal(validateJson(metrics, SCHEMAS.metrics, 'Metrics artifact').valid, true);
});

test('rejects malformed manifest attempt semantics', () => {
  const manifest = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {
      node: 'v25.0.0',
    },
    provenance: {
      gitSha: 'unknown',
      toolVersions: {
        node: 'v25.0.0',
      },
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'failed',
      terminalState: 'hung',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'timeout',
      },
      cleanup: {
        status: 'partial',
      },
      partialArtifacts: {
        valid: true,
      },
    },
    environment: sampleEnvironment(),
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
    },
    failureReason: 'Timed out waiting for milestone.',
  };

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.attempt.terminalState'), result.message);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.attempt.partialArtifacts.reason'), result.message);
});

test('rejects malformed manifest environment preconditions', () => {
  const manifest: JsonRecord = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {
      node: 'v25.0.0',
    },
    provenance: {
      gitSha: 'unknown',
      toolVersions: {
        node: 'v25.0.0',
      },
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'passed',
      terminalState: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'none',
      },
      cleanup: {
        status: 'not-required',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
    environment: {
      ...sampleEnvironment(),
      preconditions: {
        ...sampleEnvironment().preconditions,
        networkState: {
          evidence: 'wifi-ish',
          value: 'online',
        },
      },
    },
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
    },
    failureReason: null,
  };
  const malformedEnvironment = manifest.environment as JsonRecord;
  delete (malformedEnvironment.postconditions as JsonRecord).artifactState;

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.environment.preconditions.networkState.evidence'), result.message);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.environment.postconditions.artifactState'), result.message);
});

test('accepts manifest lifecycle phase and expanded terminal vocabulary', () => {
  const manifest = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'failed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {
      node: 'v25.0.0',
    },
    provenance: {
      gitSha: 'unknown',
      toolVersions: {
        node: 'v25.0.0',
      },
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'failed',
      terminalState: 'unsupported',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'environment',
      },
      cleanup: {
        status: 'unknown',
      },
      partialArtifacts: {
        valid: true,
        reason: 'unsupported lifecycle proof preserved diagnostic artifacts',
      },
    },
    environment: {
      ...sampleEnvironment(),
      preconditions: {
        ...sampleEnvironment().preconditions,
        lifecyclePhase: {
          value: 'resume',
          evidence: 'asserted',
          source: 'scenario precondition',
        },
      },
      postconditions: {
        ...sampleEnvironment().postconditions,
        lifecyclePhase: {
          value: 'foreground',
          evidence: 'observed',
          artifact: 'raw/device.log',
        },
      },
    },
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
    },
    failureReason: 'Lifecycle proof is unsupported on this runner.',
  };

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects unknown manifest lifecycle phase values', () => {
  const manifest: JsonRecord = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {
      node: 'v25.0.0',
    },
    provenance: {
      gitSha: 'unknown',
      toolVersions: {
        node: 'v25.0.0',
      },
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'passed',
      terminalState: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'none',
      },
      cleanup: {
        status: 'not-required',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
    environment: {
      ...sampleEnvironment(),
      postconditions: {
        ...sampleEnvironment().postconditions,
        lifecyclePhase: {
          value: 'half-awake',
          evidence: 'observed',
        },
      },
    },
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
    },
    failureReason: null,
  };

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.environment.postconditions.lifecyclePhase.value'), result.message);
});

test('rejects unstable evidence attachment inventory entries', () => {
  const attachment = {
    channel: 'provider',
    completenessStatus: 'complete',
    corruptionStatus: 'valid',
    kind: 'accessibility',
    path: 'raw/providers/axe/accessibility.json',
    redactionPolicy: {
      authority: 'provider-declared',
      reason: 'Provider declared this output is not redacted.',
      sensitivity: 'may-contain-sensitive-data',
      status: 'not-redacted',
    },
    redactionStatus: 'not-redacted',
    sha256: 'a'.repeat(64),
    sizeBytes: 42,
    sourceFileName: 'accessibility.json',
    transformations: ['copied'],
  };
  const manifest = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {
      node: 'v25.0.0',
    },
    provenance: {
      gitSha: 'unknown',
      toolVersions: {
        node: 'v25.0.0',
      },
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'passed',
      terminalState: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'none',
      },
      cleanup: {
        status: 'not-required',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
    environment: sampleEnvironment(),
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
      evidenceAttachments: [
        attachment,
        { ...attachment },
        {
          ...attachment,
          path: '',
          sourceFileName: '',
          completenessStatus: 'partial',
          redactionPolicy: {
            authority: 'consumer-declared',
            reason: '',
            sensitivity: 'private',
            status: 'scrubbed',
          },
          transformations: [],
        },
      ],
    },
    failureReason: null,
  };

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'duplicate_item' && error.path === '$.artifacts.evidenceAttachments'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_short' && error.path === '$.artifacts.evidenceAttachments[2].path'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_short' && error.path === '$.artifacts.evidenceAttachments[2].sourceFileName'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].completenessStatus'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.authority'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_short' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.reason'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.sensitivity'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.status'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_few_items' && error.path === '$.artifacts.evidenceAttachments[2].transformations'));
});

test('rejects unstable causal-run evidence attachment inventory entries', () => {
  const attachment = {
    channel: 'signal',
    completenessStatus: 'complete',
    corruptionStatus: 'valid',
    kind: 'js',
    path: 'signals/js/profile.json',
    redactionPolicy: {
      authority: 'operator-declared',
      reason: 'Operator declared this fixture is not redacted.',
      sensitivity: 'may-contain-sensitive-data',
      status: 'not-redacted',
    },
    redactionStatus: 'not-redacted',
    sha256: 'b'.repeat(64),
    sizeBytes: 42,
    sourceFileName: 'profile.json',
    transformations: ['copied'],
  };
  const causalRun = {
    schemaVersion: '1.0.0',
    flowId: 'startup',
    runId: 'run-1',
    platform: 'android',
    buildFlavor: 'unknown',
    scenario: {
      id: 'app-startup',
      driver: 'adb-logcat',
    },
    trigger: {
      kind: 'unknown',
      label: 'startup',
    },
    budgets: {
      cycleP95Ms: {
        metric: 'cycleP95Ms',
        unit: 'ms',
        limit: 1500,
      },
    },
    timeline: [],
    artifacts: {
      summary: 'summary.md',
      signals: {
        js: ['signals/js/profile.json'],
        memory: [],
        network: [],
      },
      evidenceAttachments: [
        attachment,
        { ...attachment },
        {
          ...attachment,
          path: '',
          sourceFileName: '',
          redactionPolicy: {
            authority: 'consumer-declared',
            reason: '',
            sensitivity: 'private',
            status: 'scrubbed',
          },
          redactionStatus: 'scrubbed',
          transformations: ['copied', 'copied'],
        },
      ],
    },
  };

  const result = validateJson(causalRun, SCHEMAS.causalRun, 'Causal run artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'duplicate_item' && error.path === '$.artifacts.evidenceAttachments'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_short' && error.path === '$.artifacts.evidenceAttachments[2].path'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_short' && error.path === '$.artifacts.evidenceAttachments[2].sourceFileName'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.authority'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'too_short' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.reason'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.sensitivity'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionPolicy.status'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'invalid_enum' && error.path === '$.artifacts.evidenceAttachments[2].redactionStatus'));
  assert.ok(result.errors.some((error: ValidationIssue) => error.code === 'duplicate_item' && error.path === '$.artifacts.evidenceAttachments[2].transformations'));
});

test('accepts aggregate live proof artifacts', () => {
  const liveProof = {
    schemaVersion: '1.0.0',
    platform: 'android',
    runId: 'android-live-proof-after-change',
    status: 'passed',
    outputDir: 'artifacts/example-mobile-app/android',
    preflight: {
      healthStatus: 'passed',
      runId: 'android-live-preflight-after-change',
      runDir: 'artifacts/example-mobile-app/android/_preflight/android-live-preflight-after-change',
      summaryPath: 'artifacts/example-mobile-app/android/_preflight/android-live-preflight-after-change/agent-summary.md',
      verdictStatus: 'not_evaluated',
    },
    profiles: [
      {
        healthStatus: 'passed',
        label: 'startup',
        scenarioId: 'app-startup',
        runId: 'android-live-startup-after-change',
        runDir: 'artifacts/example-mobile-app/android/app-startup/android-live-startup-after-change',
        summaryPath: 'artifacts/example-mobile-app/android/app-startup/android-live-startup-after-change/agent-summary.md',
        verdictStatus: 'passed',
      },
    ],
    comparisonCounts: {
      better: 1,
      inconclusive: 0,
      low_confidence: 0,
      mixed: 0,
      skipped: 1,
      unchanged: 0,
      worse: 0,
    },
    comparisonStatus: 'inconclusive',
    nextAction: {
      code: 'inspect_inconclusive',
      summary: 'Some comparisons are incomplete; inspect linked evidence.',
    },
    comparisons: [
      {
        label: 'startup',
        scenarioId: 'app-startup',
        runId: 'android-live-startup-after-change',
        status: 'better',
        baselineDir: 'artifacts/example-mobile-app/android/app-startup/android-live-startup',
        comparisonDir: 'artifacts/example-mobile-app/android/comparisons/app-startup/android-live-startup-after-change',
        summaryPath: 'artifacts/example-mobile-app/android/comparisons/app-startup/android-live-startup-after-change/agent-summary.md',
        reason: null,
        metricSummary: {
          counts: {
            better: 1,
            worse: 0,
            unchanged: 3,
            inconclusive: 0,
            low_confidence: 0,
          },
          notableMetrics: [
            {
              name: 'startup p95',
              status: 'better',
              unit: 'ms',
              baseline: 1200,
              current: 980,
              delta: -220,
            },
          ],
        },
      },
      {
        label: 'scroll',
        scenarioId: 'scroll-settle',
        runId: 'android-live-scroll-after-change',
        status: 'skipped',
        baselineDir: null,
        comparisonDir: null,
        summaryPath: null,
        reason: 'No trusted prior run found for scenario scroll-settle.',
      },
    ],
    summary: 'android live proof passed 1 profile run(s) with 2 comparison result(s).',
  };

  const result = validateJson(liveProof, SCHEMAS.liveProof, 'Live proof artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts project validation artifacts', () => {
  const validation = {
    appHelper: {
      missingExports: [],
      path: '/app/src/devtools/profile-session.ts',
      status: 'present',
    },
    config: {
      customDrivers: [],
      externalTargetDrivers: ['xcodebuildmcp'],
      invalidFields: [],
      missingFields: [],
      missingSupportedDrivers: [],
      packageSupportedDrivers: ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl'],
      path: '/app/asl.config.json',
      status: 'present',
      supportedDrivers: ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl', 'xcodebuildmcp'],
    },
    configPath: '/app/asl.config.json',
    errors: [],
    gitignore: {
      missingPatterns: [],
      path: '/app/.gitignore',
      snippetPath: '/app/asl/gitignore-snippet',
      status: 'present',
    },
    nextActions: [
      {
        code: 'replace_config_placeholders',
        message: 'Replace scaffold placeholder values in asl.config.json before relying on live device proof.',
        severity: 'warning',
        target: '/app/asl.config.json',
      },
    ],
    platform: 'all',
    plans: [
      {
        healthStatus: 'passed',
        platform: 'ios',
        runId: 'validate-ios-checkout-submit',
        scenarioId: 'checkout-submit',
        scenarioPath: '/app/scenarios/mobile/checkout-submit.json',
      },
    ],
    providerPaths: ['/app/runner-manifests/evidence-provider.json'],
    rootDir: '/app',
    runnerPath: '/app/runner-manifests/primary-runner.json',
    scripts: {
      invalidPackageJsonScripts: [],
      invalidScripts: [],
      missingPaths: [],
      missingPackageJsonScripts: [],
      mismatchedPackageJsonScripts: [],
      missingScripts: [],
      packageJsonPath: '/app/package.json',
      packageJsonStatus: 'present',
      path: '/app/asl/package-scripts.json',
      scriptNames: ['asl:check:ios', 'asl:validate'],
      status: 'present',
      unknownCommands: [],
    },
    scenarioCandidateDirectories: ['/app/scenarios', '/app/scenarios/mobile'],
    scenarioPaths: ['/app/scenarios/mobile/checkout-submit.json'],
    status: 'passed',
    warnings: ['Config field projectName still uses placeholder value \'replace-me\'.'],
  };

  const result = validateJson(validation, SCHEMAS.projectValidation, 'Project validation artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts null schema types', () => {
  const environmentWithoutNode = sampleEnvironment();
  delete environmentWithoutNode.nodeVersion;
  const manifest = {
    scenario: 'app-startup',
    runId: 'run-1',
    platform: 'android',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    interactionDriver: 'adb-logcat',
    simulator: {
      name: 'Pixel',
      udid: 'emulator-5554',
    },
    bundleId: 'com.example.app',
    gitSha: 'unknown',
    toolVersions: {},
    provenance: {
      gitSha: 'unknown',
      toolVersions: {},
    },
    attempt: {
      attemptId: 'attempt-1',
      runId: 'run-1',
      status: 'passed',
      terminalState: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      interactionDriver: 'adb-logcat',
      classification: {
        category: 'none',
      },
      cleanup: {
        status: 'not-required',
      },
      partialArtifacts: {
        valid: false,
        reason: 'complete successful run artifacts are present',
      },
    },
    environment: environmentWithoutNode,
    artifacts: {
      causalRun: 'causal-run.json',
      budgetVerdict: 'budget-verdict.json',
      manifest: 'manifest.json',
      metrics: 'metrics.json',
      summary: 'summary.md',
      scenario: 'scenarios/android/app-startup.json',
      raw: {
        interactionLog: 'raw/adb-logcat.txt',
        deviceLog: 'raw/device.log',
      },
      captures: {
        video: 'captures/run.mp4',
        uiTree: 'captures/ui-tree.json',
      },
      signals: {
        js: [],
        memory: [],
        network: [],
      },
      diagnostics: sampleDiagnostics(),
    },
    failureReason: null,
  };

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, true, result.message);
});

test('accepts health artifacts with downgrade policy', () => {
  const health = {
    schemaVersion: '1.0.0',
    scenarioId: 'app-startup',
    runId: 'run-1',
    healthStatus: 'passed',
    checks: [
      {
        name: 'planner_compatibility',
        status: 'passed',
        source: 'planner',
      },
    ],
    downgradePolicy: {
      mode: 'no-silent-downgrade',
      allowedSubstitutions: [],
      substitutions: [],
      unsupported: [],
      warnings: [
        {
          kind: 'artifact',
          name: 'video',
          status: 'warning',
          code: 'missing_optional_artifact',
        },
      ],
    },
  };

  const result = validateJson(health, SCHEMAS.health, 'Health artifact');

  assert.equal(result.valid, true, result.message);
});

test('rejects malformed health downgrade policy entries', () => {
  const health = {
    schemaVersion: '1.0.0',
    scenarioId: 'app-startup',
    runId: 'run-1',
    healthStatus: 'passed',
    checks: [
      {
        name: 'planner_compatibility',
        status: 'passed',
        source: 'planner',
      },
    ],
    downgradePolicy: {
      mode: 'silent-downgrade-ok',
      allowedSubstitutions: [],
      substitutions: [],
      unsupported: [
        {
          kind: 'capability',
          name: '',
          status: 'unsupported',
          code: 'missing_required_capability',
        },
      ],
      warnings: [],
    },
  };

  const result = validateJson(health, SCHEMAS.health, 'Health artifact');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.downgradePolicy.mode'), result.message);
  assert.ok(result.errors.some((error: ValidationIssue) => error.path === '$.downgradePolicy.unsupported[0].name'), result.message);
});

test('rejects comparison artifacts with unknown comparison status', () => {
  const comparison = {
    schemaVersion: '1.0.0',
    scenarioId: 'open-close-cycle',
    runId: 'current-run',
    baselineRunId: 'baseline-run',
    comparisonStatus: 'faster-ish',
    healthStatus: 'passed',
    verdictStatus: 'passed',
    summary: 'Invalid status.',
  };

  const result = validateJson(comparison, SCHEMAS.comparison, 'Comparison artifact');

  assert.equal(result.valid, false);
  assert.equal(result.errors[0].path, '$.comparisonStatus');
});

test('assertValidJson throws a path-specific schema error', () => {
  const scenario = clone(readJson('examples/scenarios/mobile/app-startup.json'));
  scenario.steps[1].timeoutMs = 0;

  assert.throws(
    () => assertValidJson(scenario, SCHEMAS.scenario, 'Scenario manifest'),
    (error: unknown) => {
      assert.ok(error instanceof SchemaValidationError);
      const validationError = error as Error & { errors: ValidationIssue[] };
      assert.equal(validationError.errors[0]?.path, '$.steps[1].timeoutMs');
      assert.match(validationError.message, /Expected value to be >= 1/u);
      return true;
    },
  );
});
