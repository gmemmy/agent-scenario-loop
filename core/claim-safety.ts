import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  type RequiredSafetyAction,
  type ScenarioClaimDefinition,
  type ScenarioSafetyClass,
  type ScenarioSafetyDeclaration,
} from './claim-contract';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_SAFETY_INSPECTION_VERSION = '1.0.0' as const;

type ClaimSafetyPlatform = 'ios' | 'android';
type ClaimSafetyStatus = 'complete' | 'incomplete' | 'outside_contract';
type ClaimSafetyCheckOutcome = 'satisfied' | 'violated' | 'not_required';
type ClaimSafetyCheckId =
  | 'mutation_identity_authority'
  | 'rollback_authority'
  | 'cleanup_authority'
  | 'terminal_reconciliation';
type ClaimSafetyReasonCode =
  | 'scenario_schema_outside_contract'
  | 'scenario_schema_invalid'
  | 'selected_platform_outside_contract'
  | 'unknown_mutation_identity_assertion'
  | 'unknown_rollback_assertion'
  | 'unknown_cleanup_assertion'
  | 'unknown_reconciliation_assertion'
  | 'unknown_reconciliation_terminal_invariant'
  | 'ambiguous_safety_assertion'
  | 'safety_assertion_not_mandatory';
type ClaimSafetyNextAction =
  | 'repair_scenario_contract'
  | 'repair_safety_contract'
  | 'safety_inspection_complete';

type ClaimSafetySelection = {
  platform: ClaimSafetyPlatform;
  variant?: string;
};

type ScenarioClaimSafetyCheck = {
  id: ClaimSafetyCheckId;
  outcome: ClaimSafetyCheckOutcome;
  reasonCodes: ClaimSafetyReasonCode[];
  affectedIds: string[];
};

type ScenarioClaimSafetyBlockingReason = {
  code: ClaimSafetyReasonCode;
  checkId?: ClaimSafetyCheckId;
  message: string;
  affectedIds: string[];
};

type ScenarioClaimSafetyInspection = {
  contractVersion: typeof CLAIM_SAFETY_INSPECTION_VERSION;
  scenarioSchemaVersion?: string;
  platform: ClaimSafetyPlatform;
  variant?: string;
  safetyClass?: ScenarioSafetyClass;
  safetyContract: ClaimSafetyStatus;
  checks: ScenarioClaimSafetyCheck[];
  blockingReasons: ScenarioClaimSafetyBlockingReason[];
  nextAction: ClaimSafetyNextAction;
};

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  platforms: ClaimSafetyPlatform[];
  journey: {
    terminalInvariants: Array<{ id: string }>;
  };
  claims: ScenarioClaimDefinition[];
  safety: ScenarioSafetyDeclaration;
};

type AssertionOwner = {
  claimId: string;
  claimRole: 'mandatory' | 'supplemental';
};

function inspectScenarioClaimSafety(
  scenario: unknown,
  selection: ClaimSafetySelection,
): ScenarioClaimSafetyInspection {
  const scenarioSchemaVersion = readScenarioSchemaVersion(scenario);
  const base = {
    contractVersion: CLAIM_SAFETY_INSPECTION_VERSION,
    ...(scenarioSchemaVersion ? { scenarioSchemaVersion } : {}),
    platform: selection.platform,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  };

  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    return outsideContract(base, {
      code: 'scenario_schema_outside_contract',
      message: 'Claim safety inspection applies only to scenario schemaVersion 1.1.0.',
      affectedIds: [],
    });
  }

  const schemaResult = validateJson(scenario, SCHEMAS.scenario, 'Claim-complete scenario');
  if (!schemaResult.valid) {
    return outsideContract(base, {
      code: 'scenario_schema_invalid',
      message: schemaResult.message,
      affectedIds: [],
    });
  }

  const candidate = scenario as ClaimCompleteScenario;
  if (!candidate.platforms.includes(selection.platform)) {
    return outsideContract(base, {
      code: 'selected_platform_outside_contract',
      message: `Scenario does not declare platform ${selection.platform}.`,
      affectedIds: [selection.platform],
    });
  }

  const safety = candidate.safety;
  const inspectionBase = {
    ...base,
    safetyClass: safety.class,
  };
  if (safety.class === 'read_only') {
    return {
      ...inspectionBase,
      safetyContract: 'complete',
      checks: [],
      blockingReasons: [],
      nextAction: 'safety_inspection_complete',
    };
  }

  const applicableClaims = candidate.claims.filter((claim) => claimApplies(claim, selection));
  const assertionOwners = buildAssertionOwners(applicableClaims);
  const terminalInvariantIds = new Set(
    candidate.journey.terminalInvariants.map((invariant) => invariant.id),
  );
  const checks: ScenarioClaimSafetyCheck[] = [];
  const blockingReasons: ScenarioClaimSafetyBlockingReason[] = [];
  const addCheck = (
    id: ClaimSafetyCheckId,
    reasons: ScenarioClaimSafetyBlockingReason[],
    notRequired = false,
  ): void => {
    let outcome: ClaimSafetyCheckOutcome = 'satisfied';
    if (notRequired) {
      outcome = 'not_required';
    } else if (reasons.length > 0) {
      outcome = 'violated';
    }
    blockingReasons.push(...reasons);
    checks.push({
      id,
      outcome,
      reasonCodes: uniqueStrings(reasons.map((reason) => reason.code)),
      affectedIds: uniqueStrings(reasons.flatMap((reason) => reason.affectedIds)),
    });
  };

  addCheck(
    'mutation_identity_authority',
    buildAssertionReferenceReasons(
      safety.mutationIdentity.assertionIds,
      assertionOwners,
      'mutation_identity_authority',
      'unknown_mutation_identity_assertion',
      'Mutation identity',
    ),
  );
  addCheck(
    'rollback_authority',
    buildSafetyActionReasons(
      safety.rollback,
      assertionOwners,
      'rollback_authority',
      'unknown_rollback_assertion',
      'Rollback',
    ),
    safety.rollback.status === 'not_required',
  );
  addCheck(
    'cleanup_authority',
    buildSafetyActionReasons(
      safety.cleanup,
      assertionOwners,
      'cleanup_authority',
      'unknown_cleanup_assertion',
      'Cleanup',
    ),
    safety.cleanup.status === 'not_required',
  );

  const reconciliationReasons = buildAssertionReferenceReasons(
    safety.reconciliation.assertionIds,
    assertionOwners,
    'terminal_reconciliation',
    'unknown_reconciliation_assertion',
    'Terminal reconciliation',
  );
  for (const id of safety.reconciliation.terminalInvariantIds) {
    if (!terminalInvariantIds.has(id)) {
      reconciliationReasons.push({
        code: 'unknown_reconciliation_terminal_invariant',
        checkId: 'terminal_reconciliation',
        message: `Terminal reconciliation references unknown terminal invariant ${id}.`,
        affectedIds: [id],
      });
    }
  }
  addCheck('terminal_reconciliation', reconciliationReasons);

  return {
    ...inspectionBase,
    safetyContract: blockingReasons.length === 0 ? 'complete' : 'incomplete',
    checks,
    blockingReasons,
    nextAction:
      blockingReasons.length === 0
        ? 'safety_inspection_complete'
        : 'repair_safety_contract',
  };
}

function buildSafetyActionReasons(
  action: { status: 'required' | 'not_required' },
  assertionOwners: Map<string, AssertionOwner[]>,
  checkId: ClaimSafetyCheckId,
  unknownCode: ClaimSafetyReasonCode,
  label: string,
): ScenarioClaimSafetyBlockingReason[] {
  if (action.status === 'not_required') {
    return [];
  }

  return buildAssertionReferenceReasons(
    (action as RequiredSafetyAction).assertionIds,
    assertionOwners,
    checkId,
    unknownCode,
    label,
  );
}

function buildAssertionReferenceReasons(
  assertionIds: string[],
  assertionOwners: Map<string, AssertionOwner[]>,
  checkId: ClaimSafetyCheckId,
  unknownCode: ClaimSafetyReasonCode,
  label: string,
): ScenarioClaimSafetyBlockingReason[] {
  const reasons: ScenarioClaimSafetyBlockingReason[] = [];
  for (const id of assertionIds) {
    const owners = assertionOwners.get(id) ?? [];
    if (owners.length === 0) {
      reasons.push({
        code: unknownCode,
        checkId,
        message: `${label} references assertion ${id}, which is not applicable to the selection.`,
        affectedIds: [id],
      });
      continue;
    }

    if (owners.length > 1) {
      reasons.push({
        code: 'ambiguous_safety_assertion',
        checkId,
        message: `${label} assertion ${id} has more than one applicable claim owner.`,
        affectedIds: [id, ...owners.map((owner) => owner.claimId)],
      });
      continue;
    }

    if (!owners.some((owner) => owner.claimRole === 'mandatory')) {
      reasons.push({
        code: 'safety_assertion_not_mandatory',
        checkId,
        message: `${label} assertion ${id} belongs only to supplemental claims.`,
        affectedIds: [id, ...owners.map((owner) => owner.claimId)],
      });
    }
  }
  return reasons;
}

function buildAssertionOwners(
  claims: ScenarioClaimDefinition[],
): Map<string, AssertionOwner[]> {
  const owners = new Map<string, AssertionOwner[]>();
  for (const claim of claims) {
    for (const assertion of claim.assertions) {
      owners.set(assertion.id, [
        ...(owners.get(assertion.id) ?? []),
        { claimId: claim.id, claimRole: claim.role },
      ]);
    }
  }
  return owners;
}

function claimApplies(
  claim: ScenarioClaimDefinition,
  selection: ClaimSafetySelection,
): boolean {
  if (!claim.applicability.platforms.includes(selection.platform)) {
    return false;
  }
  if (!claim.applicability.variants) {
    return true;
  }
  return selection.variant === undefined
    ? false
    : claim.applicability.variants.includes(selection.variant);
}

function outsideContract(
  base: Pick<
    ScenarioClaimSafetyInspection,
    'contractVersion' | 'scenarioSchemaVersion' | 'platform' | 'variant'
  >,
  reason: ScenarioClaimSafetyBlockingReason,
): ScenarioClaimSafetyInspection {
  return {
    ...base,
    safetyContract: 'outside_contract',
    checks: [],
    blockingReasons: [reason],
    nextAction: 'repair_scenario_contract',
  };
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
  CLAIM_SAFETY_INSPECTION_VERSION,
  inspectScenarioClaimSafety,
};

export type {
  ClaimSafetyCheckId,
  ClaimSafetyCheckOutcome,
  ClaimSafetyNextAction,
  ClaimSafetyPlatform,
  ClaimSafetyReasonCode,
  ClaimSafetySelection,
  ClaimSafetyStatus,
  ScenarioClaimSafetyBlockingReason,
  ScenarioClaimSafetyCheck,
  ScenarioClaimSafetyInspection,
};
