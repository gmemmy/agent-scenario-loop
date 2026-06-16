const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DRIVER_PORT,
  EVIDENCE_PROVIDER_PORT,
  PRIMARY_RUNNER_PORT,
  assertPortImplementation,
  missingPortMethods,
  validatePortImplementation,
} = require('../ports');

test('validates a primary runner port implementation', () => {
  const implementation = Object.fromEntries(PRIMARY_RUNNER_PORT.map((methodName: string) => [methodName, () => {}]));

  const result = validatePortImplementation({
    name: 'primary runner',
    implementation,
    requiredMethods: PRIMARY_RUNNER_PORT,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.missingMethods, []);
});

test('reports missing driver methods', () => {
  const implementation = {
    tap() {},
    screenshot() {},
  };

  assert.deepEqual(
    missingPortMethods(implementation, DRIVER_PORT),
    ['scroll', 'inspectTree', 'record', 'readLogs', 'collectPerfSignals'],
  );
});

test('asserts evidence provider port implementations', () => {
  const implementation = {
    prepare() {},
    startWindow() {},
    capture() {},
    finalize() {},
  };

  assert.throws(
    () =>
      assertPortImplementation({
        name: 'evidence provider',
        implementation,
        requiredMethods: EVIDENCE_PROVIDER_PORT,
      }),
    /missing required method\(s\): stopWindow/u,
  );
});
