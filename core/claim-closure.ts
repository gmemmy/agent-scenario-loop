import { CLAIM_CONTRACT_SCHEMA_VERSION } from './claim-contract';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_CLOSURE_INSPECTION_VERSION = '1.0.0' as const;

type ClaimClosurePlatform = 'ios' | 'android';
type JourneyCoverageKind = 'product' | 'recovery';
type ClaimClosureStatus = 'closed' | 'not_closed' | 'outside_contract';
type ClaimClosureCheckOutcome = 'satisfied' | 'violated';
type ClaimClosureCheckId =
  | 'phase_identity'
  | 'terminal_invariant_identity'
  | 'journey_node_identity'
  | 'claim_identity'
  | 'assertion_identity'
  | 'closure_reference_integrity'
  | 'applicable_claim_integrity'
  | 'mandatory_phase_closure'
  | 'terminal_invariant_closure'
  | 'recovery_contract_consistency';
type ClaimClosureReasonCode =
  | 'scenario_schema_outside_contract'
  | 'scenario_schema_invalid'
  | 'selected_platform_outside_contract'
  | 'duplicate_phase_id'
  | 'duplicate_terminal_invariant_id'
  | 'duplicate_recovery_variant_id'
  | 'journey_node_id_collision'
  | 'journey_recovery_variant_id_collision'
  | 'duplicate_claim_id'
  | 'duplicate_assertion_id'
  | 'unknown_phase_reference'
  | 'unknown_terminal_invariant_reference'
  | 'applicable_claim_has_no_resolved_closure'
  | 'mandatory_phase_not_closed'
  | 'terminal_invariant_not_closed'
  | 'required_recovery_has_no_variant'
  | 'required_recovery_has_no_owned_node'
  | 'recovery_variant_kind_mismatch'
  | 'not_required_recovery_has_variant'
  | 'not_required_recovery_has_owned_node';

type ClaimClosureSelection = {
  platform: ClaimClosurePlatform;
  variant?: string;
};

type ScenarioClaimClosureCheck = {
  id: ClaimClosureCheckId;
  outcome: ClaimClosureCheckOutcome;
  reasonCodes: ClaimClosureReasonCode[];
  affectedIds: string[];
};

type ScenarioClaimClosureBlockingReason = {
  code: ClaimClosureReasonCode;
  checkId?: ClaimClosureCheckId;
  message: string;
  affectedIds: string[];
};

type ScenarioClaimClosureInspection = {
  contractVersion: typeof CLAIM_CLOSURE_INSPECTION_VERSION;
  scenarioSchemaVersion?: string;
  platform: ClaimClosurePlatform;
  variant?: string;
  claimClosure: ClaimClosureStatus;
  checks: ScenarioClaimClosureCheck[];
  blockingReasons: ScenarioClaimClosureBlockingReason[];
};

type JourneyNode = {
  id: string;
  coverageKind: JourneyCoverageKind;
};

type RecoveryContract = {
  status: 'required' | 'not_required';
  variants?: JourneyNode[];
};

type ClaimDefinition = {
  id: string;
  role: 'mandatory' | 'supplemental';
  applicability: {
    platforms: ClaimClosurePlatform[];
    variants?: string[];
  };
  closes: {
    phases?: string[];
    terminalInvariants?: string[];
  };
  assertions: Array<{ id: string }>;
};

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  platforms: ClaimClosurePlatform[];
  journey: {
    phases: JourneyNode[];
    terminalInvariants: JourneyNode[];
    recovery: RecoveryContract;
  };
  claims: ClaimDefinition[];
};

function inspectScenarioClaimClosure(
  scenario: unknown,
  selection: ClaimClosureSelection,
): ScenarioClaimClosureInspection {
  const scenarioSchemaVersion = readScenarioSchemaVersion(scenario);
  const base = {
    contractVersion: CLAIM_CLOSURE_INSPECTION_VERSION,
    ...(scenarioSchemaVersion ? { scenarioSchemaVersion } : {}),
    platform: selection.platform,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  };

  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    return {
      ...base,
      claimClosure: 'outside_contract',
      checks: [],
      blockingReasons: [
        {
          code: 'scenario_schema_outside_contract',
          message: 'Claim closure inspection applies only to scenario schemaVersion 1.1.0.',
          affectedIds: [],
        },
      ],
    };
  }

  const schemaResult = validateJson(scenario, SCHEMAS.scenario, 'Claim-complete scenario');
  if (!schemaResult.valid) {
    return {
      ...base,
      claimClosure: 'outside_contract',
      checks: [],
      blockingReasons: [
        {
          code: 'scenario_schema_invalid',
          message: schemaResult.message,
          affectedIds: [],
        },
      ],
    };
  }

  const candidate = scenario as ClaimCompleteScenario;
  if (!candidate.platforms.includes(selection.platform)) {
    return {
      ...base,
      claimClosure: 'outside_contract',
      checks: [],
      blockingReasons: [
        {
          code: 'selected_platform_outside_contract',
          message: `Scenario does not declare platform ${selection.platform}.`,
          affectedIds: [selection.platform],
        },
      ],
    };
  }

  const checks: ScenarioClaimClosureCheck[] = [];
  const blockingReasons: ScenarioClaimClosureBlockingReason[] = [];
  const addCheck = (
    id: ClaimClosureCheckId,
    reasons: ScenarioClaimClosureBlockingReason[],
  ): void => {
    blockingReasons.push(...reasons);
    checks.push({
      id,
      outcome: reasons.length === 0 ? 'satisfied' : 'violated',
      reasonCodes: uniqueStrings(reasons.map((reason) => reason.code)),
      affectedIds: uniqueStrings(reasons.flatMap((reason) => reason.affectedIds)),
    });
  };

  const phases = candidate.journey.phases;
  const terminalInvariants = candidate.journey.terminalInvariants;
  const phaseIds = phases.map((phase) => phase.id);
  const terminalInvariantIds = terminalInvariants.map((invariant) => invariant.id);
  const recoveryVariantIds = (candidate.journey.recovery.variants ?? []).map(
    (variant) => variant.id,
  );
  const phaseIdSet = new Set(phaseIds);
  const terminalInvariantIdSet = new Set(terminalInvariantIds);

  addCheck(
    'phase_identity',
    duplicateReasons('duplicate_phase_id', 'phase_identity', phaseIds, 'Duplicate journey phase ID'),
  );
  addCheck(
    'terminal_invariant_identity',
    duplicateReasons(
      'duplicate_terminal_invariant_id',
      'terminal_invariant_identity',
      terminalInvariantIds,
      'Duplicate terminal invariant ID',
    ),
  );

  const nodeCollisions = uniqueStrings(phaseIds.filter((id) => terminalInvariantIdSet.has(id)));
  const recoveryVariantCollisions = uniqueStrings(
    recoveryVariantIds.filter((id) => phaseIdSet.has(id) || terminalInvariantIdSet.has(id)),
  );
  addCheck(
    'journey_node_identity',
    [
      ...nodeCollisions.map((id) => ({
        code: 'journey_node_id_collision' as const,
        checkId: 'journey_node_identity' as const,
        message: `Journey node ID ${id} is used by both a phase and a terminal invariant.`,
        affectedIds: [id],
      })),
      ...duplicateReasons(
        'duplicate_recovery_variant_id',
        'journey_node_identity',
        recoveryVariantIds,
        'Duplicate recovery variant ID',
      ),
      ...recoveryVariantCollisions.map((id) => ({
        code: 'journey_recovery_variant_id_collision' as const,
        checkId: 'journey_node_identity' as const,
        message: `Journey node ID ${id} is also used by a recovery variant.`,
        affectedIds: [id],
      })),
    ],
  );

  addCheck(
    'claim_identity',
    duplicateReasons(
      'duplicate_claim_id',
      'claim_identity',
      candidate.claims.map((claim) => claim.id),
      'Duplicate claim ID',
    ),
  );

  const assertionIdentityReasons = candidate.claims.flatMap((claim) =>
    duplicateReasons(
      'duplicate_assertion_id',
      'assertion_identity',
      claim.assertions.map((assertion) => assertion.id),
      `Duplicate assertion ID in claim ${claim.id}`,
    ).map((reason) => ({
      ...reason,
      affectedIds: [claim.id, ...reason.affectedIds],
    })),
  );
  addCheck('assertion_identity', assertionIdentityReasons);

  const applicableClaims = candidate.claims.filter((claim) => claimApplies(claim, selection));
  const closureReferenceReasons: ScenarioClaimClosureBlockingReason[] = [];
  const applicableClaimIntegrityReasons: ScenarioClaimClosureBlockingReason[] = [];

  for (const claim of applicableClaims) {
    const phaseReferences = claim.closes.phases ?? [];
    const terminalReferences = claim.closes.terminalInvariants ?? [];
    const resolvedPhaseReferences = phaseReferences.filter((id) => phaseIdSet.has(id));
    const resolvedTerminalReferences = terminalReferences.filter((id) => terminalInvariantIdSet.has(id));

    for (const id of phaseReferences.filter((candidateId) => !phaseIdSet.has(candidateId))) {
      closureReferenceReasons.push({
        code: 'unknown_phase_reference',
        checkId: 'closure_reference_integrity',
        message: `Claim ${claim.id} references unknown journey phase ${id}.`,
        affectedIds: [claim.id, id],
      });
    }
    for (const id of terminalReferences.filter((candidateId) => !terminalInvariantIdSet.has(candidateId))) {
      closureReferenceReasons.push({
        code: 'unknown_terminal_invariant_reference',
        checkId: 'closure_reference_integrity',
        message: `Claim ${claim.id} references unknown terminal invariant ${id}.`,
        affectedIds: [claim.id, id],
      });
    }

    if (resolvedPhaseReferences.length + resolvedTerminalReferences.length === 0) {
      applicableClaimIntegrityReasons.push({
        code: 'applicable_claim_has_no_resolved_closure',
        checkId: 'applicable_claim_integrity',
        message: `Applicable claim ${claim.id} does not close an authored journey node.`,
        affectedIds: [claim.id],
      });
    }
  }

  addCheck('closure_reference_integrity', closureReferenceReasons);
  addCheck('applicable_claim_integrity', applicableClaimIntegrityReasons);

  const mandatoryClaims = applicableClaims.filter((claim) => claim.role === 'mandatory');
  const closedPhaseIds = new Set(mandatoryClaims.flatMap((claim) => claim.closes.phases ?? []));
  const closedTerminalInvariantIds = new Set(
    mandatoryClaims.flatMap((claim) => claim.closes.terminalInvariants ?? []),
  );
  const uncoveredPhaseIds = uniqueStrings(phaseIds.filter((id) => !closedPhaseIds.has(id)));
  addCheck(
    'mandatory_phase_closure',
    uncoveredPhaseIds.map((id) => ({
      code: 'mandatory_phase_not_closed',
      checkId: 'mandatory_phase_closure',
      message: `Journey phase ${id} is not closed by an applicable mandatory claim.`,
      affectedIds: [id],
    })),
  );

  const uncoveredTerminalInvariantIds = uniqueStrings(
    terminalInvariantIds.filter((id) => !closedTerminalInvariantIds.has(id)),
  );
  addCheck(
    'terminal_invariant_closure',
    uncoveredTerminalInvariantIds.map((id) => ({
      code: 'terminal_invariant_not_closed',
      checkId: 'terminal_invariant_closure',
      message: `Terminal invariant ${id} is not closed by an applicable mandatory claim.`,
      affectedIds: [id],
    })),
  );

  addCheck(
    'recovery_contract_consistency',
    buildRecoveryReasons(candidate.journey.recovery, phases, terminalInvariants),
  );

  return {
    ...base,
    claimClosure: blockingReasons.length === 0 ? 'closed' : 'not_closed',
    checks,
    blockingReasons,
  };
}

function buildRecoveryReasons(
  recovery: RecoveryContract,
  phases: JourneyNode[],
  terminalInvariants: JourneyNode[],
): ScenarioClaimClosureBlockingReason[] {
  const reasons: ScenarioClaimClosureBlockingReason[] = [];
  const variants = recovery.variants ?? [];
  const recoveryNodeIds = [...phases, ...terminalInvariants]
    .filter((node) => node.coverageKind === 'recovery')
    .map((node) => node.id);

  if (recovery.status === 'required') {
    if (variants.length === 0) {
      reasons.push({
        code: 'required_recovery_has_no_variant',
        checkId: 'recovery_contract_consistency',
        message: 'Required recovery declares no explicit recovery variant.',
        affectedIds: [],
      });
    }
    if (recoveryNodeIds.length === 0) {
      reasons.push({
        code: 'required_recovery_has_no_owned_node',
        checkId: 'recovery_contract_consistency',
        message: 'Required recovery declares no recovery-owned phase or terminal invariant.',
        affectedIds: [],
      });
    }
    const mismatchedVariantIds = variants
      .filter((variant) => variant.coverageKind !== 'recovery')
      .map((variant) => variant.id);
    if (mismatchedVariantIds.length > 0) {
      reasons.push({
        code: 'recovery_variant_kind_mismatch',
        checkId: 'recovery_contract_consistency',
        message: 'Required recovery variants must use coverageKind recovery.',
        affectedIds: mismatchedVariantIds,
      });
    }
  } else {
    if (variants.length > 0) {
      reasons.push({
        code: 'not_required_recovery_has_variant',
        checkId: 'recovery_contract_consistency',
        message: 'Recovery marked not_required cannot declare recovery variants.',
        affectedIds: variants.map((variant) => variant.id),
      });
    }
    if (recoveryNodeIds.length > 0) {
      reasons.push({
        code: 'not_required_recovery_has_owned_node',
        checkId: 'recovery_contract_consistency',
        message: 'Recovery marked not_required cannot declare recovery-owned journey nodes.',
        affectedIds: recoveryNodeIds,
      });
    }
  }

  return reasons;
}

function claimApplies(claim: ClaimDefinition, selection: ClaimClosureSelection): boolean {
  if (!claim.applicability.platforms.includes(selection.platform)) {
    return false;
  }

  const variants = claim.applicability.variants;
  if (!variants) {
    return true;
  }

  return selection.variant === undefined ? false : variants.includes(selection.variant);
}

function duplicateReasons(
  code: ClaimClosureReasonCode,
  checkId: ClaimClosureCheckId,
  values: string[],
  label: string,
): ScenarioClaimClosureBlockingReason[] {
  return duplicateStrings(values).map((id) => ({
    code,
    checkId,
    message: `${label}: ${id}.`,
    affectedIds: [id],
  }));
}

function duplicateStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    } else {
      seen.add(value);
    }
  }
  return [...duplicates];
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function readScenarioSchemaVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  return typeof schemaVersion === 'string' ? schemaVersion : undefined;
}

export {
  CLAIM_CLOSURE_INSPECTION_VERSION,
  inspectScenarioClaimClosure,
};

export type {
  ClaimClosureCheckId,
  ClaimClosureCheckOutcome,
  ClaimClosurePlatform,
  ClaimClosureReasonCode,
  ClaimClosureSelection,
  ClaimClosureStatus,
  JourneyCoverageKind,
  ScenarioClaimClosureBlockingReason,
  ScenarioClaimClosureCheck,
  ScenarioClaimClosureInspection,
};
