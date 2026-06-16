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

test('accepts canonical mobile scenario manifests', () => {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, true);
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

test('accepts manifest and metrics transition artifacts', () => {
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

test('accepts null schema types', () => {
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
    },
    failureReason: null,
  };

  const result = validateJson(manifest, SCHEMAS.manifest, 'Manifest artifact');

  assert.equal(result.valid, true, result.message);
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
