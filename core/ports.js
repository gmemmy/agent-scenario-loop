const PRIMARY_RUNNER_PORT = [
  'prepare',
  'launch',
  'startSession',
  'executeStep',
  'waitForTruthEvent',
  'captureEvidence',
  'stopSession',
  'finalize',
];

const EVIDENCE_PROVIDER_PORT = [
  'prepare',
  'startWindow',
  'capture',
  'stopWindow',
  'finalize',
];

const DRIVER_PORT = [
  'tap',
  'scroll',
  'inspectTree',
  'screenshot',
  'record',
  'readLogs',
  'collectPerfSignals',
];

const ARTIFACT_WRITER_PORT = [
  'writeJson',
  'writeText',
  'copyRaw',
];

const INTERPRETER_PORT = [
  'interpret',
];

/**
 * Returns method names missing from an implementation object.
 *
 * @param {Record<string, unknown>} implementation
 * @param {string[]} requiredMethods
 * @returns {string[]}
 */
function missingPortMethods(implementation, requiredMethods) {
  return requiredMethods.filter((methodName) => typeof implementation?.[methodName] !== 'function');
}

/**
 * Validates whether an implementation satisfies a named port.
 *
 * @param {{name: string, implementation: Record<string, unknown>, requiredMethods: string[]}} options
 * @returns {{valid: boolean, name: string, missingMethods: string[]}}
 */
function validatePortImplementation({ name, implementation, requiredMethods }) {
  const missingMethods = missingPortMethods(implementation, requiredMethods);
  return {
    valid: missingMethods.length === 0,
    name,
    missingMethods,
  };
}

/**
 * Asserts that an implementation satisfies a named port.
 *
 * @param {{name: string, implementation: Record<string, unknown>, requiredMethods: string[]}} options
 * @returns {Record<string, unknown>}
 */
function assertPortImplementation({ name, implementation, requiredMethods }) {
  const result = validatePortImplementation({ name, implementation, requiredMethods });
  if (!result.valid) {
    throw new Error(`${name} is missing required method(s): ${result.missingMethods.join(', ')}`);
  }

  return implementation;
}

module.exports = {
  ARTIFACT_WRITER_PORT,
  DRIVER_PORT,
  EVIDENCE_PROVIDER_PORT,
  INTERPRETER_PORT,
  PRIMARY_RUNNER_PORT,
  assertPortImplementation,
  missingPortMethods,
  validatePortImplementation,
};
