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
  'longPress',
  'typeText',
  'scroll',
  'swipe',
  'pinch',
  'pressButton',
  'focus',
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

type ScenarioExecutionStep = import('./execution-plan').ScenarioExecutionStep;

type MaybePromise<T> = T | Promise<T>;

type PortMetadataValue = string | number | boolean | null | string[] | number[] | boolean[];

type PortMetadata = Record<string, PortMetadataValue>;

type PortStatus = 'passed' | 'failed' | 'partial' | 'skipped';

type PortArtifactMap = Record<string, string | string[] | null>;

type PortResult = {
  artifacts?: PortArtifactMap;
  message?: string;
  metadata?: PortMetadata;
  status: PortStatus;
};

type PortContext = {
  artifactRoot?: string;
  config?: Record<string, unknown>;
  metadata?: PortMetadata;
  platform: string;
  runDir?: string;
  runId: string;
  runner?: Record<string, unknown>;
  scenario?: Record<string, unknown>;
  scenarioId: string;
};

type PrimaryRunnerContext = PortContext & {
  executionPlan?: {
    steps: ScenarioExecutionStep[];
  };
};

type PrimaryRunnerStepContext = PrimaryRunnerContext & {
  step: ScenarioExecutionStep;
};

type EvidenceProviderPhase = 'prepare' | 'startWindow' | 'capture' | 'stopWindow' | 'finalize';

type EvidenceProviderContext = PortContext & {
  phase?: EvidenceProviderPhase;
  provider?: Record<string, unknown>;
  providerId?: string;
};

type DriverActionName =
  | 'tap'
  | 'longPress'
  | 'typeText'
  | 'scroll'
  | 'swipe'
  | 'pinch'
  | 'pressButton'
  | 'focus'
  | 'assertVisible'
  | 'inspectTree'
  | 'screenshot'
  | 'record'
  | 'readLogs'
  | 'collectPerfSignals';

type DriverActionInput = {
  action: string;
  artifactPath?: string;
  metadata?: PortMetadata;
  platform: string;
  selector?: Record<string, unknown>;
  step?: ScenarioExecutionStep;
  timeoutMs?: number;
};

type DriverActionResult = PortResult & {
  outputPath?: string;
  value?: unknown;
};

type ArtifactWriterJsonInput = {
  filePath: string;
  label?: string;
  schema?: unknown;
  value: unknown;
};

type ArtifactWriterTextInput = {
  content: string;
  filePath: string;
};

type ArtifactWriterCopyInput = {
  destinationPath: string;
  sourcePath: string;
};

type InterpreterContext = {
  comparison?: Record<string, unknown>;
  evidence: Record<string, unknown>;
  metadata?: PortMetadata;
  profile?: Record<string, unknown>;
  scenarioHealthPassed: boolean;
};

type InterpreterResult = {
  likelyCauses: string[];
  metadata?: PortMetadata;
  notes: string[];
  summary: string;
  trusted: boolean;
};

type PrimaryRunnerPort = {
  captureEvidence(context: PrimaryRunnerStepContext): MaybePromise<PortResult>;
  executeStep(context: PrimaryRunnerStepContext): MaybePromise<PortResult>;
  finalize(context: PrimaryRunnerContext): MaybePromise<PortResult>;
  launch(context: PrimaryRunnerContext): MaybePromise<PortResult>;
  prepare(context: PrimaryRunnerContext): MaybePromise<PortResult>;
  startSession(context: PrimaryRunnerContext): MaybePromise<PortResult>;
  stopSession(context: PrimaryRunnerContext): MaybePromise<PortResult>;
  waitForTruthEvent(context: PrimaryRunnerStepContext): MaybePromise<PortResult>;
};

type EvidenceProviderPort = {
  capture(context: EvidenceProviderContext): MaybePromise<PortResult>;
  finalize(context: EvidenceProviderContext): MaybePromise<PortResult>;
  prepare(context: EvidenceProviderContext): MaybePromise<PortResult>;
  startWindow(context: EvidenceProviderContext): MaybePromise<PortResult>;
  stopWindow(context: EvidenceProviderContext): MaybePromise<PortResult>;
};

type DriverPort = {
  assertVisible(input: DriverActionInput): MaybePromise<DriverActionResult>;
  collectPerfSignals(input: DriverActionInput): MaybePromise<DriverActionResult>;
  focus(input: DriverActionInput): MaybePromise<DriverActionResult>;
  inspectTree(input: DriverActionInput): MaybePromise<DriverActionResult>;
  longPress(input: DriverActionInput): MaybePromise<DriverActionResult>;
  pinch(input: DriverActionInput): MaybePromise<DriverActionResult>;
  pressButton(input: DriverActionInput): MaybePromise<DriverActionResult>;
  readLogs(input: DriverActionInput): MaybePromise<DriverActionResult>;
  record(input: DriverActionInput): MaybePromise<DriverActionResult>;
  screenshot(input: DriverActionInput): MaybePromise<DriverActionResult>;
  scroll(input: DriverActionInput): MaybePromise<DriverActionResult>;
  swipe(input: DriverActionInput): MaybePromise<DriverActionResult>;
  tap(input: DriverActionInput): MaybePromise<DriverActionResult>;
  typeText(input: DriverActionInput): MaybePromise<DriverActionResult>;
};

type ArtifactWriterPort = {
  copyRaw(input: ArtifactWriterCopyInput): MaybePromise<string>;
  writeJson(input: ArtifactWriterJsonInput): MaybePromise<void>;
  writeText(input: ArtifactWriterTextInput): MaybePromise<void>;
};

type InterpreterPort = {
  interpret(context: InterpreterContext): MaybePromise<InterpreterResult>;
};

/**
 * Returns true when a scenario action maps to the stable driver port surface.
 *
 * @param {string} action
 * @returns {boolean}
 */
function isDriverActionName(action: string): action is DriverActionName {
  return DRIVER_PORT.includes(action);
}

/**
 * Dispatches one normalized scenario driver action to a swappable driver.
 *
 * Runners should call this after planner compatibility has passed. The runtime
 * guard still fails explicitly so missing adapter capabilities do not degrade
 * into silent no-ops.
 *
 * @param {{driver: Partial<DriverPort> & Record<string, unknown>, input: DriverActionInput}} options
 * @returns {Promise<DriverActionResult>}
 */
async function dispatchDriverAction({
  driver,
  input,
}: {
  driver: Partial<DriverPort> & PortImplementation;
  input: DriverActionInput;
}): Promise<DriverActionResult> {
  if (!isDriverActionName(input.action)) {
    throw new Error(`Unsupported driver action \`${input.action}\`.`);
  }

  const method = driver[input.action];
  if (typeof method !== 'function') {
    throw new Error(`Driver is missing action \`${input.action}\`.`);
  }

  return method(input);
}

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
  dispatchDriverAction,
  implementedPortMethods,
  isDriverActionName,
  missingPortMethods,
  validatePortImplementation,
};

export type {
  ArtifactWriterCopyInput,
  ArtifactWriterJsonInput,
  ArtifactWriterPort,
  ArtifactWriterTextInput,
  DriverActionName,
  DriverActionInput,
  DriverActionResult,
  DriverPort,
  EvidenceProviderContext,
  EvidenceProviderPhase,
  EvidenceProviderPort,
  InterpreterContext,
  InterpreterPort,
  InterpreterResult,
  MaybePromise,
  PortArtifactMap,
  PortContext,
  PortImplementation,
  PortMetadata,
  PortMetadataValue,
  PortResult,
  PortStatus,
  PrimaryRunnerContext,
  PrimaryRunnerPort,
  PrimaryRunnerStepContext,
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
