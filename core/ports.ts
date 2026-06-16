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
  'assertVisible',
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
function missingPortMethods(implementation: PortImplementation, requiredMethods: string[]): string[] {
  return requiredMethods.filter((methodName) => typeof implementation?.[methodName] !== 'function');
}

/**
 * Returns callable method names exposed by an implementation object.
 *
 * @param {Record<string, unknown>} implementation
 * @returns {string[]}
 */
function implementedPortMethods(implementation: PortImplementation): string[] {
  if (!implementation || typeof implementation !== 'object') {
    return [];
  }

  return Object.keys(implementation)
    .filter((methodName) => typeof implementation[methodName] === 'function')
    .sort();
}

/**
 * Builds a stable human-readable port validation message.
 *
 * @param {{name: string, missingMethods: string[]}} options
 * @returns {string}
 */
function buildPortValidationMessage({
  name,
  missingMethods,
}: {
  name: string;
  missingMethods: string[];
}): string {
  if (missingMethods.length === 0) {
    return `${name} satisfies the required port methods.`;
  }

  return `${name} is missing required method(s): ${missingMethods.join(', ')}`;
}

/**
 * Validates whether an implementation satisfies a named port.
 *
 * @param {{name: string, implementation: Record<string, unknown>, requiredMethods: string[]}} options
 * @returns {{valid: boolean, name: string, expectedMethods: string[], implementedMethods: string[], missingMethods: string[], message: string}}
 */
function validatePortImplementation({
  name,
  implementation,
  requiredMethods,
}: {
  name: string;
  implementation: PortImplementation;
  requiredMethods: string[];
}): PortValidationResult {
  const missingMethods = missingPortMethods(implementation, requiredMethods);
  const implementedMethods = implementedPortMethods(implementation);
  return {
    valid: missingMethods.length === 0,
    name,
    expectedMethods: [...requiredMethods],
    implementedMethods,
    missingMethods,
    message: buildPortValidationMessage({ name, missingMethods }),
  };
}

/**
 * Asserts that an implementation satisfies a named port.
 *
 * @param {{name: string, implementation: Record<string, unknown>, requiredMethods: string[]}} options
 * @returns {Record<string, unknown>}
 */
function assertPortImplementation({
  name,
  implementation,
  requiredMethods,
}: {
  name: string;
  implementation: PortImplementation;
  requiredMethods: string[];
}): PortImplementation {
  const result = validatePortImplementation({ name, implementation, requiredMethods });
  if (!result.valid) {
    throw new Error(result.message);
  }

  return implementation;
}

export {
  ARTIFACT_WRITER_PORT,
  DRIVER_PORT,
  EVIDENCE_PROVIDER_PORT,
  INTERPRETER_PORT,
  PRIMARY_RUNNER_PORT,
  assertPortImplementation,
  buildPortValidationMessage,
  implementedPortMethods,
  missingPortMethods,
  validatePortImplementation,
};

export type {
  PortImplementation,
  PortValidationResult,
};
type PortImplementation = Record<string, unknown>;

type PortValidationResult = {
  expectedMethods: string[];
  implementedMethods: string[];
  message: string;
  missingMethods: string[];
  valid: boolean;
  name: string;
};
