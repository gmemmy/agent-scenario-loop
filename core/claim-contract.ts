const crypto = require('node:crypto');

const CLAIM_CONTRACT_SCHEMA_VERSION = '1.1.0' as const;
const LEGACY_SCENARIO_SCHEMA_VERSION = '1.0.0' as const;

type ClaimRole = 'mandatory' | 'supplemental';
type ClaimStatus = 'supported' | 'rejected' | 'not_evaluable';
type ClaimAuthorityRole = 'app' | 'runner' | 'adapter' | 'provider' | 'comparator';
type ClaimIdentityStrength = 'observed' | 'verified';
type ClaimEvidenceCompleteness = 'point' | 'bounded' | 'continuous-complete';
type ScenarioSafetyClass =
  | 'read_only'
  | 'local_mutation'
  | 'reversible_backend_mutation'
  | 'destructive';
type ArtifactKind =
  | 'logs'
  | 'screenshot'
  | 'video'
  | 'uiTree'
  | 'memory'
  | 'nativePerformance'
  | 'network'
  | 'profiler'
  | 'accessibility'
  | 'signals';
type NonEmptyArray<T> = [T, ...T[]];
type ClaimNextActionOwner =
  | 'app_truth'
  | 'asl_runner'
  | 'product_optimization'
  | 'provider_tooling'
  | 'runtime_environment'
  | 'scenario_contract'
  | 'unresolved';
type ClaimReasonCode =
  | 'all_assertions_supported'
  | 'authoritative_evidence_rejected'
  | 'health_gate_failed'
  | 'missing_authoritative_evidence'
  | 'partial_evidence'
  | 'ambiguous_evidence'
  | 'identity_mismatch'
  | 'identity_capability_unavailable'
  | 'authoritative_evidence_conflict'
  | 'unsupported_authority_path'
  | 'incomplete_observation_window'
  | 'invalid_evidence'
  | 'cleanup_incomplete';
type NotEvaluableReasonCode = Exclude<
  ClaimReasonCode,
  'all_assertions_supported' | 'authoritative_evidence_rejected'
>;
type ClaimOutcome =
  | { status: 'supported'; reasonCode: 'all_assertions_supported' }
  | { status: 'rejected'; reasonCode: 'authoritative_evidence_rejected' }
  | { status: 'not_evaluable'; reasonCode: NotEvaluableReasonCode };

type ClaimScalar = string | number | boolean | null;

type ClaimAuthority = {
  role: ClaimAuthorityRole;
  producerId: string;
  evidenceSelector: string;
  requiredStrength: ClaimIdentityStrength;
  completeness: ClaimEvidenceCompleteness;
};

type ClaimObservationWindow = {
  from: string;
  to: string;
  completeSourceRequired: true;
};

type ClaimAssertionBase = {
  id: string;
  authority: ClaimAuthority;
};

type WindowedClaimAuthority = ClaimAuthority & {
  completeness: Exclude<ClaimEvidenceCompleteness, 'point'>;
};

type EventOccurrenceAssertion = ClaimAssertionBase & {
  kind: 'eventOccurrence';
  event: string;
};

type EventOrderAssertion = ClaimAssertionBase & {
  kind: 'eventOrder';
  beforeEvent: string;
  afterEvent: string;
};

type TerminalStateAssertion = ClaimAssertionBase & {
  kind: 'terminalState';
  path: string;
  expected: ClaimScalar;
};

type BoundedCountBounds =
  | { minimum: number; maximum?: number }
  | { minimum?: number; maximum: number };

type BoundedCountAssertion = Omit<ClaimAssertionBase, 'authority'> & BoundedCountBounds & {
  kind: 'boundedCount';
  authority: WindowedClaimAuthority;
  selector: string;
  observationWindow: ClaimObservationWindow;
};

type AbsenceAssertion = Omit<ClaimAssertionBase, 'authority'> & {
  kind: 'absence';
  authority: WindowedClaimAuthority;
  selector: string;
  observationWindow: ClaimObservationWindow;
};

type ValidatedEvidenceAssertion = ClaimAssertionBase & {
  kind: 'validatedEvidence';
  artifactKind: ArtifactKind;
  validationContract: string;
};

type ScenarioClaimAssertion =
  | EventOccurrenceAssertion
  | EventOrderAssertion
  | TerminalStateAssertion
  | BoundedCountAssertion
  | AbsenceAssertion
  | ValidatedEvidenceAssertion;

type ClaimClosure =
  | {
      phases: NonEmptyArray<string>;
      terminalInvariants?: NonEmptyArray<string>;
    }
  | {
      phases?: NonEmptyArray<string>;
      terminalInvariants: NonEmptyArray<string>;
    };

type ScenarioClaimDefinition = {
  id: string;
  role: ClaimRole;
  applicability: {
    platforms: NonEmptyArray<'ios' | 'android'>;
    variants?: NonEmptyArray<string>;
  };
  closes: ClaimClosure;
  assertions: NonEmptyArray<ScenarioClaimAssertion>;
};

type RequiredSafetyAction = {
  status: 'required';
  rationale: string;
  assertionIds: NonEmptyArray<string>;
};

type NotRequiredSafetyAction = {
  status: 'not_required';
  rationale: string;
};

type ScenarioSafetyAction = RequiredSafetyAction | NotRequiredSafetyAction;

type ScenarioMutationIdentity = {
  id: string;
  assertionIds: NonEmptyArray<string>;
};

type ScenarioSafetyReconciliation = {
  terminalInvariantIds: NonEmptyArray<string>;
  assertionIds: NonEmptyArray<string>;
};

type ReadOnlyScenarioSafety = {
  class: 'read_only';
  rationale: string;
  allowedOperations: NonEmptyArray<string>;
};

type MutatingScenarioSafetyBase = {
  rationale: string;
  allowedOperations: NonEmptyArray<string>;
  mutationIdentity: ScenarioMutationIdentity;
  reconciliation: ScenarioSafetyReconciliation;
};

type LocalMutationScenarioSafety = MutatingScenarioSafetyBase & {
  class: 'local_mutation';
} & (
    | { rollback: RequiredSafetyAction; cleanup: ScenarioSafetyAction }
    | { rollback: ScenarioSafetyAction; cleanup: RequiredSafetyAction }
  );

type ReversibleBackendMutationScenarioSafety = MutatingScenarioSafetyBase & {
  class: 'reversible_backend_mutation';
  rollback: RequiredSafetyAction;
  cleanup: ScenarioSafetyAction;
};

type DestructiveScenarioSafety = MutatingScenarioSafetyBase & {
  class: 'destructive';
  rollback: ScenarioSafetyAction;
  cleanup: RequiredSafetyAction;
};

type ScenarioSafetyDeclaration =
  | ReadOnlyScenarioSafety
  | LocalMutationScenarioSafety
  | ReversibleBackendMutationScenarioSafety
  | DestructiveScenarioSafety;

type ClaimEvidenceReference = {
  path: string;
  sha256?: string;
};

type ClaimAssertionResultBase<K extends ScenarioClaimAssertion['kind'], E> = {
  assertionId: string;
  assertionKind: K;
  expected: E;
  evidenceReferences: ClaimEvidenceReference[];
  rejectedEvidence: string[];
};

type SupportedAssertionResult<K extends ScenarioClaimAssertion['kind'], E, O> =
  ClaimAssertionResultBase<K, E> & {
    status: 'supported';
    reasonCode: 'all_assertions_supported';
    observed: O;
    evidenceReferences: NonEmptyArray<ClaimEvidenceReference>;
    rejectedEvidence: [];
    missingProof: [];
  };

type RejectedAssertionResult<K extends ScenarioClaimAssertion['kind'], E, O> =
  ClaimAssertionResultBase<K, E> & {
    status: 'rejected';
    reasonCode: 'authoritative_evidence_rejected';
    observed: O;
    evidenceReferences: NonEmptyArray<ClaimEvidenceReference>;
    rejectedEvidence: NonEmptyArray<string>;
    missingProof: [];
  };

type NotEvaluableAssertionResult<K extends ScenarioClaimAssertion['kind'], E> =
  ClaimAssertionResultBase<K, E> & {
    status: 'not_evaluable';
    reasonCode: NotEvaluableReasonCode;
    observed: null;
    missingProof: NonEmptyArray<string>;
  };

type EventOccurrenceExpectation = {
  event: string;
};

type EventOccurrenceObservation = EventOccurrenceExpectation & {
  matchedEvidence: string;
};

type EventOccurrenceResult =
  | SupportedAssertionResult<'eventOccurrence', EventOccurrenceExpectation, EventOccurrenceObservation>
  | NotEvaluableAssertionResult<'eventOccurrence', EventOccurrenceExpectation>;

type EventOrderExpectation = {
  beforeEvent: string;
  afterEvent: string;
};

type EventOrderObservation = {
  beforeEvidence: string;
  afterEvidence: string;
  relation: 'before' | 'after';
};

type EventOrderResult =
  | SupportedAssertionResult<
      'eventOrder',
      EventOrderExpectation,
      EventOrderObservation & { relation: 'before' }
    >
  | RejectedAssertionResult<
      'eventOrder',
      EventOrderExpectation,
      EventOrderObservation & { relation: 'after' }
    >
  | NotEvaluableAssertionResult<'eventOrder', EventOrderExpectation>;

type TerminalStateExpectation = {
  path: string;
  value: ClaimScalar;
};

type TerminalStateObservation = TerminalStateExpectation;

type TerminalStateResult =
  | SupportedAssertionResult<'terminalState', TerminalStateExpectation, TerminalStateObservation>
  | RejectedAssertionResult<'terminalState', TerminalStateExpectation, TerminalStateObservation>
  | NotEvaluableAssertionResult<'terminalState', TerminalStateExpectation>;

type BoundedCountExpectation = BoundedCountBounds & {
  selector: string;
  observationWindow: ClaimObservationWindow;
};

type BoundedCountObservation = {
  selector: string;
  count: number;
};

type BoundedCountResult =
  | SupportedAssertionResult<'boundedCount', BoundedCountExpectation, BoundedCountObservation>
  | RejectedAssertionResult<'boundedCount', BoundedCountExpectation, BoundedCountObservation>
  | NotEvaluableAssertionResult<'boundedCount', BoundedCountExpectation>;

type AbsenceExpectation = {
  selector: string;
  observationWindow: ClaimObservationWindow;
};

type AbsenceResult =
  | SupportedAssertionResult<'absence', AbsenceExpectation, { selector: string; count: 0 }>
  | RejectedAssertionResult<'absence', AbsenceExpectation, { selector: string; count: number }>
  | NotEvaluableAssertionResult<'absence', AbsenceExpectation>;

type ValidatedEvidenceExpectation = {
  artifactKind: ArtifactKind;
  validationContract: string;
};

type ValidatedEvidenceObservation = ValidatedEvidenceExpectation & {
  matchedEvidence: string;
  validationStatus: 'passed' | 'failed';
};

type ValidatedEvidenceResult =
  | SupportedAssertionResult<
      'validatedEvidence',
      ValidatedEvidenceExpectation,
      ValidatedEvidenceObservation & { validationStatus: 'passed' }
    >
  | RejectedAssertionResult<
      'validatedEvidence',
      ValidatedEvidenceExpectation,
      ValidatedEvidenceObservation & { validationStatus: 'failed' }
    >
  | NotEvaluableAssertionResult<'validatedEvidence', ValidatedEvidenceExpectation>;

type ClaimAssertionResult =
  | EventOccurrenceResult
  | EventOrderResult
  | TerminalStateResult
  | BoundedCountResult
  | AbsenceResult
  | ValidatedEvidenceResult;

type ClaimResult = ClaimOutcome & {
  claimId: string;
  claimHash: string;
  role: ClaimRole;
  assertionResults: NonEmptyArray<ClaimAssertionResult>;
  evidenceReferences: ClaimEvidenceReference[];
  missingProof: string[];
  nextActionOwner: ClaimNextActionOwner;
  nextAction: string;
};

/**
 * Canonicalizes JSON-compatible claim definitions with stable object-key order.
 */
function canonicalizeClaimValue(value: unknown): string {
  return canonicalizeClaimValueWithAncestors(value, new WeakSet<object>());
}

function canonicalizeClaimValueWithAncestors(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Claim definitions cannot contain non-finite numbers.');
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Claim definitions cannot contain cyclic values.');
    }
    ancestors.add(value);
    try {
      return `[${value.map((item) => canonicalizeClaimValueWithAncestors(item, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }

  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Claim definitions can contain only JSON objects and arrays.');
    }
    if (ancestors.has(value)) {
      throw new TypeError('Claim definitions cannot contain cyclic values.');
    }
    ancestors.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => {
          if (child === undefined) {
            throw new TypeError(`Claim definition property ${key} cannot be undefined.`);
          }
          return `${JSON.stringify(key)}:${canonicalizeClaimValueWithAncestors(child, ancestors)}`;
        });
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }

  throw new TypeError(`Claim definitions cannot contain ${typeof value} values.`);
}

/**
 * Returns the canonical SHA-256 identity for one complete claim definition.
 */
function buildScenarioClaimHash(claim: ScenarioClaimDefinition): string {
  return crypto.createHash('sha256').update(canonicalizeClaimValue(claim)).digest('hex');
}

/**
 * Prevents claim-complete scenarios from entering legacy planning or runtime paths.
 */
function assertScenarioExecutionContractSupported(scenario: unknown): void {
  if (!scenario || typeof scenario !== 'object') {
    return;
  }

  const candidate = scenario as Record<string, unknown>;
  if (candidate.schemaVersion === CLAIM_CONTRACT_SCHEMA_VERSION) {
    throw new Error(
      'Scenario schemaVersion 1.1.0 is reader-only until claim evaluation is available; execution is unsupported.',
    );
  }

  const readerOnlyFields = ['claims', 'safety'].filter((field) =>
    Object.prototype.hasOwnProperty.call(candidate, field),
  );
  if (readerOnlyFields.length > 0) {
    throw new Error(
      `Scenario claim-complete fields ${readerOnlyFields.join(', ')} are reader-only until claim evaluation is available; execution is unsupported.`,
    );
  }
}

export {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  LEGACY_SCENARIO_SCHEMA_VERSION,
  assertScenarioExecutionContractSupported,
  buildScenarioClaimHash,
  canonicalizeClaimValue,
};

export type {
  AbsenceAssertion,
  AbsenceExpectation,
  AbsenceResult,
  ArtifactKind,
  BoundedCountAssertion,
  BoundedCountExpectation,
  BoundedCountObservation,
  BoundedCountResult,
  ClaimAssertionResult,
  ClaimAuthority,
  ClaimAuthorityRole,
  ClaimClosure,
  ClaimEvidenceCompleteness,
  ClaimEvidenceReference,
  ClaimIdentityStrength,
  ClaimNextActionOwner,
  NotEvaluableReasonCode,
  ClaimObservationWindow,
  ClaimReasonCode,
  ClaimResult,
  ClaimRole,
  ClaimScalar,
  ClaimStatus,
  EventOccurrenceAssertion,
  EventOccurrenceExpectation,
  EventOccurrenceObservation,
  EventOccurrenceResult,
  EventOrderAssertion,
  EventOrderExpectation,
  EventOrderObservation,
  EventOrderResult,
  DestructiveScenarioSafety,
  LocalMutationScenarioSafety,
  NotRequiredSafetyAction,
  ReadOnlyScenarioSafety,
  RequiredSafetyAction,
  ReversibleBackendMutationScenarioSafety,
  ScenarioMutationIdentity,
  ScenarioSafetyAction,
  ScenarioSafetyClass,
  ScenarioSafetyDeclaration,
  ScenarioSafetyReconciliation,
  ScenarioClaimAssertion,
  ScenarioClaimDefinition,
  TerminalStateAssertion,
  TerminalStateExpectation,
  TerminalStateObservation,
  TerminalStateResult,
  ValidatedEvidenceAssertion,
  ValidatedEvidenceExpectation,
  ValidatedEvidenceObservation,
  ValidatedEvidenceResult,
  WindowedClaimAuthority,
};
