const crypto = require('node:crypto');

import {
  buildScenarioClaimHash,
  canonicalizeClaimValue,
  type ArtifactKind,
  type ClaimAuthorityRole,
  type ClaimEvidenceCompleteness,
  type ClaimEvidenceReference,
  type ClaimIdentityStrength,
  type ClaimObservationWindow,
  type ScenarioClaimAssertion,
  type ScenarioClaimDefinition,
} from './claim-contract';
import {
  buildScenarioClaimCompleteContractHash,
} from './scenario-claim-approval';
import {
  type ScenarioClaimAdmissionAdmitted,
  type ScenarioClaimAdmissionSelection,
} from './claim-admission';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_EVIDENCE_RUN_IDENTITY_VERSION = '1.0.0' as const;
const CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION = '1.0.0' as const;
const CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION = '1.0.0' as const;
const RUN_IDENTITY_HASH_DOMAIN = 'asl-claim-evidence-run-identity-v1' as const;

type ClaimEvidencePlatform = 'ios' | 'android';
type Sha256Hex = string;

type ScenarioClaimEvidenceSelection = {
  platform: ClaimEvidencePlatform;
  variant?: string;
};

type ScenarioClaimEvidenceProducerIdentity = {
  role: ClaimAuthorityRole;
  producerId: string;
  version: string;
  sha256: Sha256Hex;
};

type ScenarioClaimEvidenceRunIdentity = {
  schemaVersion: typeof CLAIM_EVIDENCE_RUN_IDENTITY_VERSION;
  scenarioId: string;
  scenarioHash: Sha256Hex;
  runId: string;
  attemptId: string;
  selection: ScenarioClaimEvidenceSelection;
  source: { gitSha: string };
  package: { name: string; version: string; sha256: Sha256Hex };
  target: { resourceId: string; deviceId: string; runtimeId: string };
  installedApp: { appId: string; version: string; buildId: string; sha256: Sha256Hex };
  runner: { id: string; version: string };
  adapter: { id: string; version: string };
  transport: { id: string; version: string };
  appHelper: { payloadId: string; sha256: Sha256Hex };
  environment: { id: string; cohortHash: Sha256Hex };
  producers: [
    ScenarioClaimEvidenceProducerIdentity,
    ...ScenarioClaimEvidenceProducerIdentity[],
  ];
};

type ScenarioClaimEvidenceCandidateAuthority = {
  declarationId: string;
  role: ClaimAuthorityRole;
  producerId: string;
  evidenceSelector: string;
  producerVersion: string;
  producerSha256: Sha256Hex;
  strength: ClaimIdentityStrength;
  completeness: ClaimEvidenceCompleteness;
};

type ScenarioClaimEvidenceCandidateBase<K extends ScenarioClaimAssertion['kind']> = {
  schemaVersion: typeof CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION;
  candidateId: string;
  runIdentityHash: Sha256Hex;
  claimId: string;
  claimHash: Sha256Hex;
  assertionId: string;
  assertionKind: K;
  authority: ScenarioClaimEvidenceCandidateAuthority;
  cleanupStatus: 'finalized' | 'incomplete' | 'not_required';
  redactionStatus: 'not-redacted' | 'redacted' | 'private';
};

type ProducedCapture = {
  captureStatus: 'produced';
  evidence: ClaimEvidenceReference & { sha256: Sha256Hex };
};

type NonProducedCapture =
  | { captureStatus: 'partial' | 'rejected'; evidence?: ClaimEvidenceReference & { sha256: Sha256Hex } }
  | { captureStatus: 'missing'; evidence?: never };

type ScenarioClaimSemanticEvidenceCandidate = ScenarioClaimEvidenceCandidateBase<
  'eventOccurrence' | 'eventOrder' | 'terminalState'
> & (ProducedCapture | NonProducedCapture) & {
  artifactKind?: never;
  validationContract?: never;
  observationWindow?: never;
};

type ScenarioClaimWindowedEvidenceCandidate = ScenarioClaimEvidenceCandidateBase<
  'boundedCount' | 'absence'
> & (ProducedCapture | NonProducedCapture) & {
  observationWindow: ClaimObservationWindow;
  artifactKind?: never;
  validationContract?: never;
};

type ScenarioClaimValidatedEvidenceCandidate = ScenarioClaimEvidenceCandidateBase<
  'validatedEvidence'
> & (ProducedCapture | NonProducedCapture) & {
  artifactKind: ArtifactKind;
  validationContract: string;
  observationWindow?: never;
};

type ScenarioClaimEvidenceCandidate =
  | ScenarioClaimSemanticEvidenceCandidate
  | ScenarioClaimWindowedEvidenceCandidate
  | ScenarioClaimValidatedEvidenceCandidate;

type ScenarioClaimEligibleEvidenceCandidateBase<K extends ScenarioClaimAssertion['kind']> = {
  schemaVersion: typeof CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION;
  candidateId: string;
  runIdentityHash: Sha256Hex;
  claimId: string;
  claimHash: Sha256Hex;
  assertionId: string;
  assertionKind: K;
  authority: ScenarioClaimEvidenceCandidateAuthority;
  captureStatus: 'produced';
  evidence: ClaimEvidenceReference & { sha256: Sha256Hex };
  cleanupStatus: 'finalized' | 'not_required';
  redactionStatus: 'not-redacted' | 'redacted' | 'private';
};

type ScenarioClaimEligibleSemanticEvidenceCandidate = ScenarioClaimEligibleEvidenceCandidateBase<
  'eventOccurrence' | 'eventOrder' | 'terminalState'
> & {
  artifactKind?: never;
  validationContract?: never;
  observationWindow?: never;
};

type ScenarioClaimEligibleWindowedEvidenceCandidate = ScenarioClaimEligibleEvidenceCandidateBase<
  'boundedCount' | 'absence'
> & {
  observationWindow: ClaimObservationWindow;
  artifactKind?: never;
  validationContract?: never;
};

type ScenarioClaimEligibleValidatedEvidenceCandidate = ScenarioClaimEligibleEvidenceCandidateBase<
  'validatedEvidence'
> & {
  artifactKind: ArtifactKind;
  validationContract: string;
  observationWindow?: never;
};

type ScenarioClaimEligibleEvidenceCandidate =
  | ScenarioClaimEligibleSemanticEvidenceCandidate
  | ScenarioClaimEligibleWindowedEvidenceCandidate
  | ScenarioClaimEligibleValidatedEvidenceCandidate;

type ScenarioClaimEvidenceCandidateIdentityInput = {
  admission: ScenarioClaimAdmissionAdmitted;
  scenario: unknown;
  runIdentity: unknown;
  claimId: string;
  assertionId: string;
  candidate: unknown;
};

type ScenarioClaimEvidenceCandidateGate =
  | 'run_identity'
  | 'assertion_identity'
  | 'authority_binding'
  | 'evidence_binding'
  | 'lifecycle';

type ScenarioClaimEvidenceCandidateOutsideReason =
  | 'admission_not_admitted'
  | 'scenario_binding_invalid'
  | 'run_identity_invalid'
  | 'assertion_outside_selection'
  | 'candidate_invalid';

type ScenarioClaimEvidenceCandidateBlockedReason =
  | 'run_identity_hash_mismatch'
  | 'producer_identity_missing'
  | 'producer_version_mismatch'
  | 'producer_hash_mismatch'
  | 'claim_identity_mismatch'
  | 'claim_hash_mismatch'
  | 'assertion_identity_mismatch'
  | 'assertion_kind_mismatch'
  | 'authority_check_missing'
  | 'authority_check_ambiguous'
  | 'authority_declaration_mismatch'
  | 'authority_role_mismatch'
  | 'authority_producer_mismatch'
  | 'authority_selector_mismatch'
  | 'evidence_strength_mismatch'
  | 'evidence_completeness_mismatch'
  | 'artifact_kind_mismatch'
  | 'validation_contract_mismatch'
  | 'observation_window_mismatch'
  | 'capture_partial'
  | 'capture_missing'
  | 'capture_rejected'
  | 'cleanup_incomplete';

type ScenarioClaimEvidenceCandidateOutsideNextAction =
  | 'supply_admitted_scenario'
  | 'supply_valid_run_identity'
  | 'supply_applicable_assertion'
  | 'supply_valid_evidence_candidate';

type ScenarioClaimEvidenceCandidateBlockedNextAction =
  | 'repair_run_identity_binding'
  | 'repair_assertion_identity'
  | 'rebind_authority_identity'
  | 'supply_eligible_evidence'
  | 'finalize_evidence_lifecycle';

type ScenarioClaimEvidenceCandidateGateSummary = {
  gate: ScenarioClaimEvidenceCandidateGate;
  status: 'matched' | 'blocked';
  reasonCodes: ScenarioClaimEvidenceCandidateBlockedReason[];
};

type ScenarioClaimEvidenceCandidateOutsideContract = {
  contractVersion: typeof CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION;
  status: 'outside_contract';
  reasonCodes: [
    ScenarioClaimEvidenceCandidateOutsideReason,
    ...ScenarioClaimEvidenceCandidateOutsideReason[],
  ];
  nextAction: ScenarioClaimEvidenceCandidateOutsideNextAction;
};

type ScenarioClaimEvidenceCandidateInspectionBase = {
  contractVersion: typeof CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION;
  scenarioSchemaVersion: '1.1.0';
  selection: ScenarioClaimAdmissionSelection;
  scenarioHash: Sha256Hex;
  runIdentityHash: Sha256Hex;
  candidateId: string;
  claimId: string;
  assertionId: string;
  gateSummaries: [
    ScenarioClaimEvidenceCandidateGateSummary,
    ScenarioClaimEvidenceCandidateGateSummary,
    ScenarioClaimEvidenceCandidateGateSummary,
    ScenarioClaimEvidenceCandidateGateSummary,
    ScenarioClaimEvidenceCandidateGateSummary,
  ];
};

type ScenarioClaimEvidenceCandidateBlocked = ScenarioClaimEvidenceCandidateInspectionBase & {
  status: 'blocked';
  firstBlockingGate: ScenarioClaimEvidenceCandidateGate;
  blockingGates: [
    ScenarioClaimEvidenceCandidateGate,
    ...ScenarioClaimEvidenceCandidateGate[],
  ];
  nextAction: ScenarioClaimEvidenceCandidateBlockedNextAction;
};

type ScenarioClaimEvidenceCandidateEligible = ScenarioClaimEvidenceCandidateInspectionBase & {
  status: 'eligible';
  blockingGates: [];
  eligibleCandidate: ScenarioClaimEligibleEvidenceCandidate;
};

type ScenarioClaimEvidenceCandidateIdentityInspection =
  | ScenarioClaimEvidenceCandidateOutsideContract
  | ScenarioClaimEvidenceCandidateBlocked
  | ScenarioClaimEvidenceCandidateEligible;

type ClaimCompleteScenario = {
  schemaVersion: '1.1.0';
  id: string;
  platforms: ClaimEvidencePlatform[];
  claims: ScenarioClaimDefinition[];
};

type ParsedContext = {
  admission: ScenarioClaimAdmissionAdmitted;
  scenario: ClaimCompleteScenario;
  scenarioHash: string;
  runIdentity: ScenarioClaimEvidenceRunIdentity;
  runIdentityHash: string;
  claim: ScenarioClaimDefinition;
  assertion: ScenarioClaimAssertion;
  candidate: ScenarioClaimEvidenceCandidate;
};

class InvalidScenarioClaimEvidenceRunIdentityError extends Error {
  readonly code = 'invalid_scenario_claim_evidence_run_identity' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidScenarioClaimEvidenceRunIdentityError';
  }
}

function buildScenarioClaimEvidenceRunIdentityHash(value: unknown): string {
  try {
    const identity = parseRunIdentity(value);
    const normalized = {
      ...identity,
      producers: [...identity.producers].sort(compareProducerIdentity),
    };
    return crypto
      .createHash('sha256')
      .update(canonicalizeClaimValue({ contract: RUN_IDENTITY_HASH_DOMAIN, identity: normalized }))
      .digest('hex');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidScenarioClaimEvidenceRunIdentityError(message);
  }
}

function inspectScenarioClaimEvidenceCandidateIdentity(
  input: ScenarioClaimEvidenceCandidateIdentityInput,
): ScenarioClaimEvidenceCandidateIdentityInspection {
  const parsed = parseInspectionContext(input as unknown);
  if (!parsed.valid) {
    return outsideContract(parsed.reasons);
  }

  const context = parsed.context;
  const gateSummaries = buildGateSummaries(context);
  const blockingGates = gateSummaries
    .filter((summary) => summary.status === 'blocked')
    .map((summary) => summary.gate);
  const base: ScenarioClaimEvidenceCandidateInspectionBase = {
    contractVersion: CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION,
    scenarioSchemaVersion: '1.1.0',
    selection: context.admission.selection,
    scenarioHash: context.scenarioHash,
    runIdentityHash: context.runIdentityHash,
    candidateId: context.candidate.candidateId,
    claimId: context.claim.id,
    assertionId: context.assertion.id,
    gateSummaries,
  };
  const firstBlockingGate = blockingGates[0];
  if (firstBlockingGate === undefined) {
    return {
      ...base,
      status: 'eligible',
      blockingGates: [],
      eligibleCandidate: projectEligibleCandidate(context.candidate),
    };
  }
  return {
    ...base,
    status: 'blocked',
    firstBlockingGate,
    blockingGates: [firstBlockingGate, ...blockingGates.slice(1)],
    nextAction: nextActionForGate(firstBlockingGate),
  };
}

function parseInspectionContext(input: unknown):
  | { valid: true; context: ParsedContext }
  | { valid: false; reasons: [ScenarioClaimEvidenceCandidateOutsideReason, ...ScenarioClaimEvidenceCandidateOutsideReason[]] } {
  if (
    !isPlainRecord(input)
    || !hasOnlyKeys(input, [
      'admission',
      'scenario',
      'runIdentity',
      'claimId',
      'assertionId',
      'candidate',
    ])
  ) {
    return { valid: false, reasons: ['admission_not_admitted'] };
  }
  if (!isAdmitted(input.admission)) {
    return { valid: false, reasons: ['admission_not_admitted'] };
  }
  const admission = input.admission;

  const scenarioResult = validateJson(input.scenario, SCHEMAS.scenario, 'Claim-complete evidence scenario');
  if (!scenarioResult.valid || !isPlainRecord(input.scenario) || input.scenario.schemaVersion !== '1.1.0') {
    return { valid: false, reasons: ['scenario_binding_invalid'] };
  }
  const scenario = input.scenario as ClaimCompleteScenario;
  let scenarioHash: string;
  try {
    scenarioHash = buildScenarioClaimCompleteContractHash(scenario);
  } catch {
    return { valid: false, reasons: ['scenario_binding_invalid'] };
  }
  if (
    scenarioHash !== admission.scenarioHash ||
    !scenario.platforms.includes(admission.selection.platform)
  ) {
    return { valid: false, reasons: ['scenario_binding_invalid'] };
  }

  let runIdentity: ScenarioClaimEvidenceRunIdentity;
  let runIdentityHash: string;
  try {
    runIdentity = parseRunIdentity(input.runIdentity);
    runIdentityHash = buildScenarioClaimEvidenceRunIdentityHash(runIdentity);
  } catch {
    return { valid: false, reasons: ['run_identity_invalid'] };
  }
  if (
    runIdentity.scenarioId !== scenario.id ||
    runIdentity.scenarioHash !== scenarioHash ||
    !sameSelection(runIdentity.selection, admission.selection)
  ) {
    return { valid: false, reasons: ['run_identity_invalid'] };
  }

  if (!isIdentityString(input.claimId) || !isIdentityString(input.assertionId)) {
    return { valid: false, reasons: ['assertion_outside_selection'] };
  }
  const claims = scenario.claims.filter(
    (claim) => claim.id === input.claimId && claimApplies(claim, admission.selection),
  );
  const assertions = claims.flatMap((claim) =>
    claim.assertions.filter((assertion) => assertion.id === input.assertionId)
      .map((assertion) => ({ claim, assertion })),
  );
  const selected = assertions[0];
  if (assertions.length !== 1 || selected === undefined) {
    return { valid: false, reasons: ['assertion_outside_selection'] };
  }

  const candidate = parseCandidate(input.candidate);
  if (candidate === null) {
    return { valid: false, reasons: ['candidate_invalid'] };
  }

  return {
    valid: true,
    context: {
      admission,
      scenario,
      scenarioHash,
      runIdentity,
      runIdentityHash,
      claim: selected.claim,
      assertion: selected.assertion,
      candidate,
    },
  };
}

function buildGateSummaries(context: ParsedContext): ScenarioClaimEvidenceCandidateInspectionBase['gateSummaries'] {
  return [
    gateSummary('run_identity', inspectRunIdentity(context)),
    gateSummary('assertion_identity', inspectAssertionIdentity(context)),
    gateSummary('authority_binding', inspectAuthorityBinding(context)),
    gateSummary('evidence_binding', inspectEvidenceBinding(context)),
    gateSummary('lifecycle', inspectLifecycle(context.candidate)),
  ];
}

function inspectRunIdentity(context: ParsedContext): ScenarioClaimEvidenceCandidateBlockedReason[] {
  const reasons: ScenarioClaimEvidenceCandidateBlockedReason[] = [];
  if (context.candidate.runIdentityHash !== context.runIdentityHash) {
    reasons.push('run_identity_hash_mismatch');
  }
  const producer = context.runIdentity.producers.find(
    (item) =>
      item.role === context.assertion.authority.role &&
      item.producerId === context.assertion.authority.producerId,
  );
  if (!producer) {
    reasons.push('producer_identity_missing');
    return reasons;
  }
  if (context.candidate.authority.producerVersion !== producer.version) {
    reasons.push('producer_version_mismatch');
  }
  if (context.candidate.authority.producerSha256 !== producer.sha256) {
    reasons.push('producer_hash_mismatch');
  }
  return reasons;
}

function inspectAssertionIdentity(context: ParsedContext): ScenarioClaimEvidenceCandidateBlockedReason[] {
  const reasons: ScenarioClaimEvidenceCandidateBlockedReason[] = [];
  if (context.candidate.claimId !== context.claim.id) reasons.push('claim_identity_mismatch');
  if (context.candidate.claimHash !== buildScenarioClaimHash(context.claim)) reasons.push('claim_hash_mismatch');
  if (context.candidate.assertionId !== context.assertion.id) reasons.push('assertion_identity_mismatch');
  if (context.candidate.assertionKind !== context.assertion.kind) reasons.push('assertion_kind_mismatch');
  return reasons;
}

function inspectAuthorityBinding(context: ParsedContext): ScenarioClaimEvidenceCandidateBlockedReason[] {
  const reasons: ScenarioClaimEvidenceCandidateBlockedReason[] = [];
  const checks = context.admission.inspections.authority.checks.filter(
    (check) =>
      check.subjectKind === 'claim_assertion' &&
      check.claimId === context.claim.id &&
      check.assertionId === context.assertion.id &&
      check.outcome === 'matched',
  );
  const check = checks[0];
  if (checks.length === 0 || check === undefined || check.declarationId === undefined) {
    reasons.push('authority_check_missing');
  } else if (checks.length > 1) {
    reasons.push('authority_check_ambiguous');
  } else if (context.candidate.authority.declarationId !== check.declarationId) {
    reasons.push('authority_declaration_mismatch');
  }
  if (context.candidate.authority.role !== context.assertion.authority.role) {
    reasons.push('authority_role_mismatch');
  }
  if (context.candidate.authority.producerId !== context.assertion.authority.producerId) {
    reasons.push('authority_producer_mismatch');
  }
  if (context.candidate.authority.evidenceSelector !== context.assertion.authority.evidenceSelector) {
    reasons.push('authority_selector_mismatch');
  }
  if (context.candidate.authority.strength !== context.assertion.authority.requiredStrength) {
    reasons.push('evidence_strength_mismatch');
  }
  if (context.candidate.authority.completeness !== context.assertion.authority.completeness) {
    reasons.push('evidence_completeness_mismatch');
  }
  return reasons;
}

function inspectEvidenceBinding(context: ParsedContext): ScenarioClaimEvidenceCandidateBlockedReason[] {
  const reasons: ScenarioClaimEvidenceCandidateBlockedReason[] = [];
  const candidate = context.candidate;
  const assertion = context.assertion;
  if (assertion.kind === 'validatedEvidence') {
    if (candidate.assertionKind !== 'validatedEvidence' || candidate.artifactKind !== assertion.artifactKind) {
      reasons.push('artifact_kind_mismatch');
    }
    if (candidate.assertionKind !== 'validatedEvidence' || candidate.validationContract !== assertion.validationContract) {
      reasons.push('validation_contract_mismatch');
    }
  }
  if (assertion.kind === 'boundedCount' || assertion.kind === 'absence') {
    if (
      (candidate.assertionKind !== 'boundedCount' && candidate.assertionKind !== 'absence') ||
      !sameObservationWindow(candidate.observationWindow, assertion.observationWindow)
    ) {
      reasons.push('observation_window_mismatch');
    }
  }
  return reasons;
}

function projectEligibleCandidate(
  candidate: ScenarioClaimEvidenceCandidate,
): ScenarioClaimEligibleEvidenceCandidate {
  const cleanupStatus = candidate.cleanupStatus;
  if (candidate.captureStatus !== 'produced' || cleanupStatus === 'incomplete') {
    throw new Error('Eligible projection requires produced capture and finalized or not-required cleanup.');
  }

  const authority: ScenarioClaimEvidenceCandidateAuthority = {
    declarationId: candidate.authority.declarationId,
    role: candidate.authority.role,
    producerId: candidate.authority.producerId,
    evidenceSelector: candidate.authority.evidenceSelector,
    producerVersion: candidate.authority.producerVersion,
    producerSha256: candidate.authority.producerSha256,
    strength: candidate.authority.strength,
    completeness: candidate.authority.completeness,
  };
  const evidence = {
    path: candidate.evidence.path,
    sha256: candidate.evidence.sha256,
  };
  const common = {
    schemaVersion: candidate.schemaVersion,
    candidateId: candidate.candidateId,
    runIdentityHash: candidate.runIdentityHash,
    claimId: candidate.claimId,
    claimHash: candidate.claimHash,
    assertionId: candidate.assertionId,
    authority,
    captureStatus: 'produced' as const,
    evidence,
    cleanupStatus,
    redactionStatus: candidate.redactionStatus,
  };

  switch (candidate.assertionKind) {
    case 'validatedEvidence':
      return {
        ...common,
        assertionKind: 'validatedEvidence',
        artifactKind: candidate.artifactKind,
        validationContract: candidate.validationContract,
      };
    case 'boundedCount':
    case 'absence':
      return {
        ...common,
        assertionKind: candidate.assertionKind,
        observationWindow: {
          from: candidate.observationWindow.from,
          to: candidate.observationWindow.to,
          completeSourceRequired: candidate.observationWindow.completeSourceRequired,
        },
      };
    case 'eventOccurrence':
    case 'eventOrder':
    case 'terminalState':
      return {
        ...common,
        assertionKind: candidate.assertionKind,
      };
  }
}

function inspectLifecycle(candidate: ScenarioClaimEvidenceCandidate): ScenarioClaimEvidenceCandidateBlockedReason[] {
  const reasons: ScenarioClaimEvidenceCandidateBlockedReason[] = [];
  if (candidate.captureStatus === 'partial') reasons.push('capture_partial');
  if (candidate.captureStatus === 'missing') reasons.push('capture_missing');
  if (candidate.captureStatus === 'rejected') reasons.push('capture_rejected');
  if (candidate.cleanupStatus === 'incomplete') reasons.push('cleanup_incomplete');
  return reasons;
}

function gateSummary(
  gate: ScenarioClaimEvidenceCandidateGate,
  reasonCodes: ScenarioClaimEvidenceCandidateBlockedReason[],
): ScenarioClaimEvidenceCandidateGateSummary {
  return { gate, status: reasonCodes.length === 0 ? 'matched' : 'blocked', reasonCodes };
}

function outsideContract(
  reasons: [ScenarioClaimEvidenceCandidateOutsideReason, ...ScenarioClaimEvidenceCandidateOutsideReason[]],
): ScenarioClaimEvidenceCandidateOutsideContract {
  return {
    contractVersion: CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION,
    status: 'outside_contract',
    reasonCodes: reasons,
    nextAction: outsideNextAction(reasons[0]),
  };
}

function outsideNextAction(reason: ScenarioClaimEvidenceCandidateOutsideReason): ScenarioClaimEvidenceCandidateOutsideNextAction {
  switch (reason) {
    case 'admission_not_admitted':
    case 'scenario_binding_invalid':
      return 'supply_admitted_scenario';
    case 'run_identity_invalid':
      return 'supply_valid_run_identity';
    case 'assertion_outside_selection':
      return 'supply_applicable_assertion';
    case 'candidate_invalid':
      return 'supply_valid_evidence_candidate';
  }
}

function nextActionForGate(gate: ScenarioClaimEvidenceCandidateGate): ScenarioClaimEvidenceCandidateBlockedNextAction {
  switch (gate) {
    case 'run_identity': return 'repair_run_identity_binding';
    case 'assertion_identity': return 'repair_assertion_identity';
    case 'authority_binding': return 'rebind_authority_identity';
    case 'evidence_binding': return 'supply_eligible_evidence';
    case 'lifecycle': return 'finalize_evidence_lifecycle';
  }
}

function parseRunIdentity(value: unknown): ScenarioClaimEvidenceRunIdentity {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'scenarioId', 'scenarioHash', 'runId', 'attemptId', 'selection',
    'source', 'package', 'target', 'installedApp', 'runner', 'adapter', 'transport',
    'appHelper', 'environment', 'producers',
  ])) throw new Error('Run identity must be one closed object.');
  if (value.schemaVersion !== CLAIM_EVIDENCE_RUN_IDENTITY_VERSION) throw new Error('Unsupported run identity version.');
  for (const key of ['scenarioId', 'runId', 'attemptId'] as const) requireIdentityString(value[key], key);
  requireSha256(value.scenarioHash, 'scenarioHash');
  parseSelection(value.selection);
  parseClosedStrings(value.source, ['gitSha'], 'source');
  parseClosedStrings(value.package, ['name', 'version', 'sha256'], 'package', ['sha256']);
  parseClosedStrings(value.target, ['resourceId', 'deviceId', 'runtimeId'], 'target');
  parseClosedStrings(value.installedApp, ['appId', 'version', 'buildId', 'sha256'], 'installedApp', ['sha256']);
  parseClosedStrings(value.runner, ['id', 'version'], 'runner');
  parseClosedStrings(value.adapter, ['id', 'version'], 'adapter');
  parseClosedStrings(value.transport, ['id', 'version'], 'transport');
  parseClosedStrings(value.appHelper, ['payloadId', 'sha256'], 'appHelper', ['sha256']);
  parseClosedStrings(value.environment, ['id', 'cohortHash'], 'environment', ['cohortHash']);
  if (!Array.isArray(value.producers) || value.producers.length === 0) throw new Error('Run identity producers must be nonempty.');
  const producerKeys = new Set<string>();
  for (const [index, producer] of value.producers.entries()) {
    if (!isPlainRecord(producer) || !hasOnlyKeys(producer, ['role', 'producerId', 'version', 'sha256'])) {
      throw new Error(`Producer ${index} is not a closed identity.`);
    }
    requireAuthorityRole(producer.role);
    requireIdentityString(producer.producerId, `producers[${index}].producerId`);
    requireIdentityString(producer.version, `producers[${index}].version`);
    requireSha256(producer.sha256, `producers[${index}].sha256`);
    const key = `${producer.role}\u0000${producer.producerId}`;
    if (producerKeys.has(key)) throw new Error(`Duplicate producer identity ${key}.`);
    producerKeys.add(key);
  }
  return value as ScenarioClaimEvidenceRunIdentity;
}

function parseCandidate(value: unknown): ScenarioClaimEvidenceCandidate | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion', 'candidateId', 'runIdentityHash', 'claimId', 'claimHash',
    'assertionId', 'assertionKind', 'authority', 'captureStatus', 'evidence',
    'cleanupStatus', 'redactionStatus', 'artifactKind', 'validationContract',
    'observationWindow',
  ])) return null;
  if (value.schemaVersion !== CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION) return null;
  for (const key of ['candidateId', 'claimId', 'assertionId'] as const) {
    if (!isIdentityString(value[key])) return null;
  }
  if (!isSha256(value.runIdentityHash) || !isSha256(value.claimHash)) return null;
  if (!isAssertionKind(value.assertionKind) || !parseAuthority(value.authority)) return null;
  if (!isClosedVocabulary(value.captureStatus, ['produced', 'partial', 'missing', 'rejected'])) return null;
  if (!isClosedVocabulary(value.cleanupStatus, ['finalized', 'incomplete', 'not_required'])) return null;
  if (!isClosedVocabulary(value.redactionStatus, ['not-redacted', 'redacted', 'private'])) return null;
  const hasEvidence = value.evidence !== undefined;
  if (value.captureStatus === 'produced' && !hasEvidence) return null;
  if (value.captureStatus === 'missing' && hasEvidence) return null;
  if (hasEvidence && !isEvidenceReference(value.evidence)) return null;
  if (value.assertionKind === 'validatedEvidence') {
    if (!isArtifactKind(value.artifactKind) || !isIdentityString(value.validationContract) || value.observationWindow !== undefined) return null;
  } else if (value.assertionKind === 'boundedCount' || value.assertionKind === 'absence') {
    if (!isObservationWindow(value.observationWindow) || value.artifactKind !== undefined || value.validationContract !== undefined) return null;
  } else if (value.artifactKind !== undefined || value.validationContract !== undefined || value.observationWindow !== undefined) {
    return null;
  }
  return value as ScenarioClaimEvidenceCandidate;
}

function parseAuthority(value: unknown): value is ScenarioClaimEvidenceCandidateAuthority {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'declarationId', 'role', 'producerId', 'evidenceSelector', 'producerVersion',
    'producerSha256', 'strength', 'completeness',
  ])) return false;
  if (!['declarationId', 'producerId', 'evidenceSelector', 'producerVersion'].every((key) => isIdentityString(value[key]))) return false;
  return isAuthorityRole(value.role) && isSha256(value.producerSha256) &&
    (value.strength === 'observed' || value.strength === 'verified') &&
    isClosedVocabulary(value.completeness, ['point', 'bounded', 'continuous-complete']);
}

function parseSelection(value: unknown): asserts value is ScenarioClaimEvidenceSelection {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['platform', 'variant'])) throw new Error('Selection is invalid.');
  if (value.platform !== 'ios' && value.platform !== 'android') throw new Error('Selection platform is invalid.');
  if (value.variant !== undefined) requireIdentityString(value.variant, 'selection.variant');
}

function parseClosedStrings(value: unknown, keys: string[], label: string, shaKeys: string[] = []): void {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, keys)) throw new Error(`${label} identity is not closed.`);
  for (const key of keys) {
    if (shaKeys.includes(key)) requireSha256(value[key], `${label}.${key}`);
    else requireIdentityString(value[key], `${label}.${key}`);
  }
}

function compareProducerIdentity(left: ScenarioClaimEvidenceProducerIdentity, right: ScenarioClaimEvidenceProducerIdentity): number {
  const leftKey = `${left.role}\u0000${left.producerId}`;
  const rightKey = `${right.role}\u0000${right.producerId}`;
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function isAdmitted(value: unknown): value is ScenarioClaimAdmissionAdmitted {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'contractVersion',
    'status',
    'scenarioSchemaVersion',
    'selection',
    'scenarioHash',
    'inspections',
    'gateSummaries',
    'blockingGates',
  ])) return false;
  if (
    value.contractVersion !== '1.0.0' ||
    value.status !== 'admitted' ||
    value.scenarioSchemaVersion !== '1.1.0' ||
    !isEvidenceSelection(value.selection) ||
    !isSha256(value.scenarioHash) ||
    !Array.isArray(value.blockingGates) ||
    value.blockingGates.length !== 0 ||
    !hasSuccessfulAdmissionGates(value.gateSummaries) ||
    !isPlainRecord(value.inspections) ||
    !hasOnlyKeys(value.inspections, [
      'closure',
      'authority',
      'safety',
      'authorization',
      'approval',
      'dependencies',
    ]) ||
    !hasEveryKey(value.inspections, [
      'closure',
      'authority',
      'safety',
      'authorization',
      'approval',
      'dependencies',
    ]) ||
    !isPlainRecord(value.inspections.authority) ||
    value.inspections.authority.authorityCompatibility !== 'compatible' ||
    !Array.isArray(value.inspections.authority.checks) ||
    !value.inspections.authority.checks.every(isAdmittedAuthorityCheck)
  ) return false;
  return true;
}

function isEvidenceSelection(value: unknown): value is ScenarioClaimEvidenceSelection {
  return isPlainRecord(value) && hasOnlyKeys(value, ['platform', 'variant']) &&
    (value.platform === 'ios' || value.platform === 'android') &&
    (value.variant === undefined || isIdentityString(value.variant));
}

function hasSuccessfulAdmissionGates(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 6) return false;
  const expected = [
    ['closure', 'closed'],
    ['authority', 'compatible'],
    ['safety', 'complete'],
    ['authorization', 'compatible'],
    ['approval', 'bound'],
    ['dependencies', 'complete'],
  ];
  return value.every((gate, index) => {
    const pair = expected[index];
    return pair !== undefined && isPlainRecord(gate) && hasOnlyKeys(gate, ['gate', 'status']) &&
      gate.gate === pair[0] && gate.status === pair[1];
  });
}

function isAdmittedAuthorityCheck(value: unknown): boolean {
  if (!isPlainRecord(value) || value.outcome !== 'matched' || !isIdentityString(value.declarationId)) {
    return false;
  }
  const baseKeys = [
    'assertionKind',
    'authorityRole',
    'producerId',
    'outcome',
    'reasonCodes',
    'declarationId',
    'subjectKind',
  ] as const;
  if (value.subjectKind === 'claim_assertion') {
    const keys = [...baseKeys, 'claimId', 'claimRole', 'assertionId'];
    return hasOnlyKeys(value, keys)
      && hasEveryKey(value, keys)
      && isIdentityString(value.claimId)
      && isIdentityString(value.assertionId);
  }
  if (value.subjectKind === 'dependency_predicate') {
    const required = [...baseKeys, 'dependencyId', 'dependencyKind', 'predicateId'];
    return hasOnlyKeys(value, [...required, 'claimIds'])
      && hasEveryKey(value, required)
      && isIdentityString(value.dependencyId)
      && isIdentityString(value.predicateId);
  }
  return false;
}

function claimApplies(claim: ScenarioClaimDefinition, selection: ScenarioClaimAdmissionSelection): boolean {
  if (!claim.applicability.platforms.includes(selection.platform)) return false;
  if (!claim.applicability.variants) return true;
  return selection.variant !== undefined && claim.applicability.variants.includes(selection.variant);
}

function sameSelection(left: ScenarioClaimEvidenceSelection, right: ScenarioClaimAdmissionSelection): boolean {
  return left.platform === right.platform && left.variant === right.variant;
}

function sameObservationWindow(left: ClaimObservationWindow, right: ClaimObservationWindow): boolean {
  return left.from === right.from && left.to === right.to &&
    left.completeSourceRequired === right.completeSourceRequired;
}

function isObservationWindow(value: unknown): value is ClaimObservationWindow {
  return isPlainRecord(value) && hasOnlyKeys(value, ['from', 'to', 'completeSourceRequired']) &&
    isIdentityString(value.from) && isIdentityString(value.to) && value.completeSourceRequired === true;
}

function isEvidenceReference(value: unknown): value is ClaimEvidenceReference & { sha256: string } {
  return isPlainRecord(value) && hasOnlyKeys(value, ['path', 'sha256']) &&
    isIdentityString(value.path) && isSha256(value.sha256);
}

function isRunRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  if (/^[a-zA-Z]:/u.test(value) || /^file:/iu.test(value)) return false;
  return !value.split('/').includes('..');
}

function requireIdentityString(value: unknown, label: string): asserts value is string {
  if (!isIdentityString(value)) throw new Error(`${label} must be a safe nonempty identity string.`);
}

function isIdentityString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value) && isRunRelativePath(value);
}

function requireSha256(value: unknown, label: string): asserts value is string {
  if (!isSha256(value)) throw new Error(`${label} must be lowercase SHA-256.`);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function requireAuthorityRole(value: unknown): asserts value is ClaimAuthorityRole {
  if (!isAuthorityRole(value)) throw new Error('Producer authority role is invalid.');
}

function isAuthorityRole(value: unknown): value is ClaimAuthorityRole {
  return isClosedVocabulary(value, ['app', 'runner', 'adapter', 'provider', 'comparator']);
}

function isAssertionKind(value: unknown): value is ScenarioClaimAssertion['kind'] {
  return isClosedVocabulary(value, [
    'eventOccurrence',
    'eventOrder',
    'terminalState',
    'boundedCount',
    'absence',
    'validatedEvidence',
  ]);
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return isClosedVocabulary(value, [
    'logs',
    'screenshot',
    'video',
    'uiTree',
    'memory',
    'nativePerformance',
    'network',
    'profiler',
    'accessibility',
    'signals',
  ]);
}

function isClosedVocabulary<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasEveryKey(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

export {
  CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION,
  CLAIM_EVIDENCE_CANDIDATE_IDENTITY_VERSION,
  CLAIM_EVIDENCE_RUN_IDENTITY_VERSION,
  InvalidScenarioClaimEvidenceRunIdentityError,
  buildScenarioClaimEvidenceRunIdentityHash,
  inspectScenarioClaimEvidenceCandidateIdentity,
};

export type {
  ScenarioClaimEligibleEvidenceCandidate,
  ScenarioClaimEvidenceCandidate,
  ScenarioClaimEvidenceCandidateAuthority,
  ScenarioClaimEvidenceCandidateBlocked,
  ScenarioClaimEvidenceCandidateBlockedNextAction,
  ScenarioClaimEvidenceCandidateBlockedReason,
  ScenarioClaimEvidenceCandidateEligible,
  ScenarioClaimEvidenceCandidateGate,
  ScenarioClaimEvidenceCandidateGateSummary,
  ScenarioClaimEvidenceCandidateIdentityInput,
  ScenarioClaimEvidenceCandidateIdentityInspection,
  ScenarioClaimEvidenceCandidateOutsideContract,
  ScenarioClaimEvidenceCandidateOutsideNextAction,
  ScenarioClaimEvidenceCandidateOutsideReason,
  ScenarioClaimEvidenceProducerIdentity,
  ScenarioClaimEvidenceRunIdentity,
  ScenarioClaimEvidenceSelection,
};
