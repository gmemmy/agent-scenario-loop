const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DRIVER_PORT,
  EVIDENCE_PROVIDER_PORT,
  PRIMARY_RUNNER_PORT,
  assertPortImplementation,
  dispatchDriverAction,
  implementedPortMethods,
  isDriverActionName,
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
  assert.deepEqual(result.expectedMethods, PRIMARY_RUNNER_PORT);
  assert.deepEqual(result.implementedMethods, [...PRIMARY_RUNNER_PORT].sort());
  assert.deepEqual(result.missingMethods, []);
  assert.equal(result.message, 'primary runner satisfies the required port methods.');
});

test('reports missing driver methods', () => {
  const implementation = {
    tap() {},
    screenshot() {},
  };

  assert.deepEqual(
    missingPortMethods(implementation, DRIVER_PORT),
    ['scroll', 'swipe', 'assertVisible', 'inspectTree', 'record', 'readLogs', 'collectPerfSignals'],
  );
});

test('reports implemented methods in stable sorted order', () => {
  const implementation = {
    screenshot() {},
    tap() {},
    label: 'driver',
    scroll() {},
    swipe() {},
  };

  assert.deepEqual(implementedPortMethods(implementation), ['screenshot', 'scroll', 'swipe', 'tap']);
});

test('dispatches normalized driver actions to a swappable driver', async () => {
  const driver = {
    async tap(input: { action: string; platform: string; selector?: Record<string, unknown> }) {
      return {
        status: 'passed',
        value: {
          action: input.action,
          platform: input.platform,
          selector: input.selector,
        },
      };
    },
  };

  assert.equal(isDriverActionName('tap'), true);
  assert.equal(isDriverActionName('swipe'), true);
  assert.equal(isDriverActionName('pinch'), false);
  assert.equal(isDriverActionName('unknown'), false);

  const result = await dispatchDriverAction({
    driver,
    input: {
      action: 'tap',
      platform: 'android',
      selector: { kind: 'testId', value: 'open-card' },
    },
  });

  assert.deepEqual(result, {
    status: 'passed',
    value: {
      action: 'tap',
      platform: 'android',
      selector: { kind: 'testId', value: 'open-card' },
    },
  });
});

test('rejects unknown or missing driver actions', async () => {
  await assert.rejects(
    () =>
      dispatchDriverAction({
        driver: {},
        input: {
          action: 'pinch',
          platform: 'ios',
        },
      }),
    /Unsupported driver action `pinch`/u,
  );

  await assert.rejects(
    () =>
      dispatchDriverAction({
        driver: {
          screenshot() {
            return { status: 'passed' };
          },
        },
        input: {
          action: 'scroll',
          platform: 'android',
        },
      }),
    /Driver is missing action `scroll`/u,
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
