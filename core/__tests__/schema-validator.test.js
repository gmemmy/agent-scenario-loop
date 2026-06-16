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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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
