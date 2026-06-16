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

/**
 * Reads a repo-local JSON fixture.
 *
 * @param {string} relativePath
 * @returns {unknown}
 */
function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8'));
}

/**
 * Deep-clones JSON-compatible test data.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Lists JSON fixture paths under a repo-local directory.
 *
 * @param {string} relativeDir
 * @returns {string[]}
 */
function listJsonFiles(relativeDir) {
  const absoluteDir = path.join(__dirname, '..', '..', relativeDir);
  return fs
    .readdirSync(absoluteDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(relativeDir, name));
}

test('accepts all canonical v1 scenario manifests', () => {
  for (const fixture of listJsonFiles('examples/scenarios/v1')) {
    const result = validateJson(readJson(fixture), SCHEMAS.scenario, fixture);
    assert.equal(result.valid, true, result.message);
  }
});

test('accepts all runner capability manifests', () => {
  for (const fixture of listJsonFiles('examples/runners')) {
    const result = validateJson(readJson(fixture), SCHEMAS.runnerCapabilities, fixture);
    assert.equal(result.valid, true, result.message);
  }
});

test('accepts canonical v1 scenario manifests', () => {
  const scenario = readJson('examples/scenarios/v1/app-startup.json');

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('rejects missing required scenario properties', () => {
  const scenario = readJson('examples/scenarios/v1/app-startup.json');
  delete scenario.truthEvents;

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map((error) => error.code),
    ['missing_required_property'],
  );
  assert.equal(result.errors[0].path, '$.truthEvents');
});

test('rejects invalid enum values through local schema refs', () => {
  const scenario = readJson('examples/scenarios/v1/app-startup.json');
  scenario.requiredCapabilities.push('telepathy');

  const result = validateJson(scenario, SCHEMAS.scenario, 'Scenario manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.path === '$.requiredCapabilities[4]'));
  assert.ok(result.message.includes('telepathy') === false);
});

test('rejects duplicate unique array items', () => {
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.platforms.push('ios');

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === 'duplicate_item'));
});

test('rejects additional properties in strict objects', () => {
  const runner = readJson('examples/runners/xcodebuildmcp-ios.json');
  runner.experimental = true;

  const result = validateJson(runner, SCHEMAS.runnerCapabilities, 'Runner capability manifest');

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.filter((error) => error.code === 'additional_property').map((error) => error.path),
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
  const scenario = clone(readJson('examples/scenarios/v1/app-startup.json'));
  scenario.steps[1].timeoutMs = 0;

  assert.throws(
    () => assertValidJson(scenario, SCHEMAS.scenario, 'Scenario manifest'),
    (error) => {
      assert.ok(error instanceof SchemaValidationError);
      assert.equal(error.errors[0].path, '$.steps[1].timeoutMs');
      assert.match(error.message, /Expected value to be >= 1/u);
      return true;
    },
  );
});
