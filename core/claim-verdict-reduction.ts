import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  buildScenarioClaimHash,
  canonicalizeClaimValue,
  type ClaimAssertionResult,
  type ClaimResult,
  type ScenarioClaimAssertion,
  type ScenarioClaimDefinition,
} from './claim-contract';
import {
  reduceClaimStatus,
  reduceMandatoryJourneyStatus,
} from './claim-reduction-policy';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_VERDICT_REDUCTION_INSPECTION_VERSION = '1.0.0' as const;
const CLAIM_VERDICT_REDUCTION_TRUST = 'inventory_reduction_only' as const;

type ClaimVerdictReductionPlatform = 'ios' | 'android';
type ClaimVerdictReductionStatus = 'reduced' | 'incoherent' | 'outside_contract';
type ClaimVerdictReductionCheckId =
  | 'scenario_contract'
  | 'selected_platform'
  | 'verdict_contract'
  | 'scenario_identity'
  | 'claim_inventory'
  | 'claim_identity'
  | 'assertion_inventory'
  | 'assertion_identity'
  | 'authored_expectation'
  | 'health_gate'
  | 'claim_reduction'
  | 'journey_reduction';
type ClaimVerdictReductionReasonCode =
  | 'scenario_schema_outside_contract'
  | 'scenario_schema_invalid'
  | 'selected_platform_outside_contract'
  | 'selection_has_no_mandatory_claim'
  | 'verdict_schema_outside_contract'
  | 'verdict_schema_invalid'
  | 'scenario_id_mismatch'
  | 'duplicate_claim_result'
  | 'missing_claim_result'
  | 'extra_claim_result'
  | 'excluded_claim_result'
  | 'claim_hash_mismatch'
  | 'claim_role_mismatch'
  | 'duplicate_assertion_result'
  | 'missing_assertion_result'
  | 'extra_assertion_result'
  | 'assertion_kind_mismatch'
  | 'authored_expectation_mismatch'
  | 'health_gate_mismatch'
  | 'claim_reduction_mismatch'
  | 'journey_reduction_mismatch';
type ClaimVerdictReductionNextAction =
  | 'supply_supported_claim_contracts'
  | 'repair_candidate_inventory_or_reduction'
  | 'retain_as_untrusted_inventory_only';

type ClaimVerdictReductionSelection = {
  platform: ClaimVerdictReductionPlatform;
  variant?: string;
};

type ClaimVerdictReductionCheck = {
  id: ClaimVerdictReductionCheckId;
  outcome: 'satisfied' | 'violated';
  reasonCodes: ClaimVerdictReductionReasonCode[];
  affectedIds: string[];
};

type ClaimVerdictReductionBlockingReason = {
  code: ClaimVerdictReductionReasonCode;
  checkId: ClaimVerdictReductionCheckId;
  message: string;
  affectedIds: string[];
};

type ScenarioClaimVerdictReductionInspection = {
  contractVersion: typeof CLAIM_VERDICT_REDUCTION_INSPECTION_VERSION;
  trust: typeof CLAIM_VERDICT_REDUCTION_TRUST;
  reductionStatus: ClaimVerdictReductionStatus;
  scenarioSchemaVersion?: string;
  verdictSchemaVersion?: string;
  scenarioId?: string;
  candidateRunId?: string;
  platform: ClaimVerdictReductionPlatform;
  variant?: string;
  healthStatus?: 'passed' | 'failed' | 'partial';
  candidateVerdictStatus?: 'passed' | 'failed' | 'inconclusive';
  reducedVerdictStatus?: 'passed' | 'failed' | 'inconclusive';
  applicableClaimIds: string[];
  excludedClaimIds: string[];
  mandatoryClaimIds: string[];
  supplementalClaimIds: string[];
  checks: ClaimVerdictReductionCheck[];
  blockingReasons: ClaimVerdictReductionBlockingReason[];
  nextAction: ClaimVerdictReductionNextAction;
};

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  id: string;
  platforms: ClaimVerdictReductionPlatform[];
  claims: ScenarioClaimDefinition[];
};

type ClaimCompleteVerdict = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  scenarioId: string;
  runId: string;
  healthStatus: 'passed' | 'failed' | 'partial';
  verdictStatus: 'passed' | 'failed' | 'inconclusive';
  claimResults: ClaimResult[];
};

type ReductionInspectionBase = Omit<
  ScenarioClaimVerdictReductionInspection,
  'reductionStatus' | 'checks' | 'blockingReasons' | 'nextAction'
>;

/**
 * Inspects whether an untrusted claim-complete verdict candidate has the exact
 * authored inventory and deterministic status reduction for one selection.
 */
function inspectScenarioClaimVerdictReduction(
  scenario: unknown,
  selection: ClaimVerdictReductionSelection,
  candidateVerdict: unknown,
): ScenarioClaimVerdictReductionInspection {
  const scenarioSchemaVersion = readStringProperty(scenario, 'schemaVersion');
  const base: ReductionInspectionBase = {
    contractVersion: CLAIM_VERDICT_REDUCTION_INSPECTION_VERSION,
    trust: CLAIM_VERDICT_REDUCTION_TRUST,
    ...(scenarioSchemaVersion === undefined ? {} : { scenarioSchemaVersion }),
    platform: selection.platform,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    applicableClaimIds: [],
    excludedClaimIds: [],
    mandatoryClaimIds: [],
    supplementalClaimIds: [],
  };

  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    return outsideContract(base, {
      code: 'scenario_schema_outside_contract',
      checkId: 'scenario_contract',
      message: 'Claim verdict reduction applies only to scenario schemaVersion 1.1.0.',
      affectedIds: scenarioSchemaVersion === undefined ? [] : [scenarioSchemaVersion],
    });
  }

  const scenarioValidation = validateJson(
    scenario,
    SCHEMAS.scenario,
    'Claim-complete scenario',
  );
  if (!scenarioValidation.valid) {
    return outsideContract(base, {
      code: 'scenario_schema_invalid',
      checkId: 'scenario_contract',
      message: scenarioValidation.message,
      affectedIds: [],
    });
  }

  const candidateScenario = scenario as ClaimCompleteScenario;
  const scenarioBase: ReductionInspectionBase = {
    ...base,
    scenarioId: candidateScenario.id,
  };
  if (!candidateScenario.platforms.includes(selection.platform)) {
    return outsideContract(scenarioBase, {
      code: 'selected_platform_outside_contract',
      checkId: 'selected_platform',
      message: `Scenario does not declare platform ${selection.platform}.`,
      affectedIds: [selection.platform],
    });
  }

  const applicableClaims = candidateScenario.claims.filter((claim) =>
    claimApplies(claim, selection),
  );
  const excludedClaims = candidateScenario.claims.filter(
    (claim) => !claimApplies(claim, selection),
  );
  const mandatoryClaims = applicableClaims.filter((claim) => claim.role === 'mandatory');
  const supplementalClaims = applicableClaims.filter((claim) => claim.role === 'supplemental');
  const inventoryBase: ReductionInspectionBase = {
    ...scenarioBase,
    applicableClaimIds: applicableClaims.map((claim) => claim.id),
    excludedClaimIds: excludedClaims.map((claim) => claim.id),
    mandatoryClaimIds: mandatoryClaims.map((claim) => claim.id),
    supplementalClaimIds: supplementalClaims.map((claim) => claim.id),
  };
  if (mandatoryClaims.length === 0) {
    return outsideContract(inventoryBase, {
      code: 'selection_has_no_mandatory_claim',
      checkId: 'claim_inventory',
      message: 'The selected platform and variant have no applicable mandatory claim.',
      affectedIds: [],
    });
  }

  const verdictSchemaVersion = readStringProperty(candidateVerdict, 'schemaVersion');
  const verdictBase: ReductionInspectionBase = {
    ...inventoryBase,
    ...(verdictSchemaVersion === undefined ? {} : { verdictSchemaVersion }),
  };
  if (verdictSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    return outsideContract(verdictBase, {
      code: 'verdict_schema_outside_contract',
      checkId: 'verdict_contract',
      message: 'Claim verdict reduction applies only to verdict schemaVersion 1.1.0.',
      affectedIds: verdictSchemaVersion === undefined ? [] : [verdictSchemaVersion],
    });
  }

  const verdictValidation = validateJson(
    candidateVerdict,
    SCHEMAS.verdict,
    'Claim-complete verdict candidate',
  );
  if (!verdictValidation.valid) {
    return outsideContract(verdictBase, {
      code: 'verdict_schema_invalid',
      checkId: 'verdict_contract',
      message: verdictValidation.message,
      affectedIds: [],
    });
  }

  const verdict = candidateVerdict as ClaimCompleteVerdict;
  const completeBase: ReductionInspectionBase = {
    ...verdictBase,
    candidateRunId: verdict.runId,
    healthStatus: verdict.healthStatus,
    candidateVerdictStatus: verdict.verdictStatus,
  };
  const reasons: ClaimVerdictReductionBlockingReason[] = [];
  const reason = (
    code: ClaimVerdictReductionReasonCode,
    checkId: ClaimVerdictReductionCheckId,
    message: string,
    affectedIds: string[],
  ): void => {
    reasons.push({ code, checkId, message, affectedIds });
  };

  if (verdict.scenarioId !== candidateScenario.id) {
    reason(
      'scenario_id_mismatch',
      'scenario_identity',
      `Candidate scenarioId ${verdict.scenarioId} does not match ${candidateScenario.id}.`,
      [verdict.scenarioId, candidateScenario.id],
    );
  }

  const resultGroups = groupBy(verdict.claimResults, (result) => result.claimId);
  for (const [claimId, results] of resultGroups) {
    if (results.length > 1) {
      reason(
        'duplicate_claim_result',
        'claim_inventory',
        `Candidate contains more than one result for claim ${claimId}.`,
        [claimId],
      );
    }
  }

  const applicableIds = new Set(applicableClaims.map((claim) => claim.id));
  const excludedIds = new Set(excludedClaims.map((claim) => claim.id));
  for (const claim of applicableClaims) {
    if (!resultGroups.has(claim.id)) {
      reason(
        'missing_claim_result',
        'claim_inventory',
        `Candidate omits applicable claim ${claim.id}.`,
        [claim.id],
      );
    }
  }
  for (const claimId of resultGroups.keys()) {
    if (excludedIds.has(claimId)) {
      reason(
        'excluded_claim_result',
        'claim_inventory',
        `Candidate includes pre-runtime excluded claim ${claimId}.`,
        [claimId],
      );
    } else if (!applicableIds.has(claimId)) {
      reason(
        'extra_claim_result',
        'claim_inventory',
        `Candidate includes unknown claim ${claimId}.`,
        [claimId],
      );
    }
  }

  const derivedClaimStatuses = new Map<string, ClaimResult['status']>();
  for (const claim of applicableClaims) {
    const results = resultGroups.get(claim.id);
    if (!results || results.length !== 1) {
      continue;
    }
    const result = results[0];
    if (!result) {
      continue;
    }

    const expectedHash = buildScenarioClaimHash(claim);
    if (result.claimHash !== expectedHash) {
      reason(
        'claim_hash_mismatch',
        'claim_identity',
        `Candidate claim ${claim.id} does not preserve its canonical hash.`,
        [claim.id],
      );
    }
    if (result.role !== claim.role) {
      reason(
        'claim_role_mismatch',
        'claim_identity',
        `Candidate claim ${claim.id} does not preserve authored role ${claim.role}.`,
        [claim.id],
      );
    }

    inspectAssertionInventory(claim, result, reason);
    inspectHealthGate(verdict.healthStatus, claim, result, reason);

    const derivedStatus = reduceClaimStatus(
      verdict.healthStatus,
      result.assertionResults.map((assertion) => assertion.status),
    );
    derivedClaimStatuses.set(claim.id, derivedStatus);
    if (result.status !== derivedStatus) {
      reason(
        'claim_reduction_mismatch',
        'claim_reduction',
        `Candidate claim ${claim.id} status ${result.status} does not reduce to ${derivedStatus}.`,
        [claim.id],
      );
    }
  }

  const mandatoryClaimStatuses = mandatoryClaims.map((claim) =>
    derivedClaimStatuses.get(claim.id),
  );
  const journeyReduction = reduceMandatoryJourneyStatus(
    mandatoryClaimStatuses.every(
      (status): status is ClaimResult['status'] => status !== undefined,
    )
      ? mandatoryClaimStatuses
      : undefined,
  );
  // Inventory checks already keep missing mandatory claims off this path.
  // missing_inventory must not become passed or inconclusive.
  const reducedVerdictStatus =
    journeyReduction === 'missing_inventory' ? undefined : journeyReduction;
  if (
    reducedVerdictStatus !== undefined &&
    verdict.verdictStatus !== reducedVerdictStatus
  ) {
    reason(
      'journey_reduction_mismatch',
      'journey_reduction',
      `Candidate verdict status ${verdict.verdictStatus} does not reduce to ${reducedVerdictStatus}.`,
      mandatoryClaims.map((claim) => claim.id),
    );
  }

  const sortedReasons = sortReasons(reasons);
  const checks = buildChecks(sortedReasons);
  if (sortedReasons.length > 0) {
    return {
      ...completeBase,
      reductionStatus: 'incoherent',
      checks,
      blockingReasons: sortedReasons,
      nextAction: 'repair_candidate_inventory_or_reduction',
    };
  }

  return {
    ...completeBase,
    ...(reducedVerdictStatus === undefined ? {} : { reducedVerdictStatus }),
    reductionStatus: 'reduced',
    checks,
    blockingReasons: [],
    nextAction: 'retain_as_untrusted_inventory_only',
  };
}

function inspectAssertionInventory(
  claim: ScenarioClaimDefinition,
  result: ClaimResult,
  addReason: (
    code: ClaimVerdictReductionReasonCode,
    checkId: ClaimVerdictReductionCheckId,
    message: string,
    affectedIds: string[],
  ) => void,
): void {
  const resultGroups = groupBy(result.assertionResults, (assertion) => assertion.assertionId);
  for (const [assertionId, results] of resultGroups) {
    if (results.length > 1) {
      addReason(
        'duplicate_assertion_result',
        'assertion_inventory',
        `Claim ${claim.id} contains more than one result for assertion ${assertionId}.`,
        [claim.id, assertionId],
      );
    }
  }

  const authoredAssertions = new Map(claim.assertions.map((assertion) => [assertion.id, assertion]));
  for (const assertion of claim.assertions) {
    const results = resultGroups.get(assertion.id);
    if (!results) {
      addReason(
        'missing_assertion_result',
        'assertion_inventory',
        `Claim ${claim.id} omits assertion result ${assertion.id}.`,
        [claim.id, assertion.id],
      );
      continue;
    }
    if (results.length !== 1) {
      continue;
    }
    const assertionResult = results[0];
    if (!assertionResult) {
      continue;
    }
    if (assertionResult.assertionKind !== assertion.kind) {
      addReason(
        'assertion_kind_mismatch',
        'assertion_identity',
        `Assertion ${assertion.id} kind ${assertionResult.assertionKind} does not match ${assertion.kind}.`,
        [claim.id, assertion.id],
      );
      continue;
    }

    const expected = buildAuthoredExpectation(assertion);
    if (canonicalizeClaimValue(assertionResult.expected) !== canonicalizeClaimValue(expected)) {
      addReason(
        'authored_expectation_mismatch',
        'authored_expectation',
        `Assertion ${assertion.id} does not preserve its authored expectation.`,
        [claim.id, assertion.id],
      );
    }
  }

  for (const assertionId of resultGroups.keys()) {
    if (!authoredAssertions.has(assertionId)) {
      addReason(
        'extra_assertion_result',
        'assertion_inventory',
        `Claim ${claim.id} contains unknown assertion result ${assertionId}.`,
        [claim.id, assertionId],
      );
    }
  }
}

function inspectHealthGate(
  healthStatus: ClaimCompleteVerdict['healthStatus'],
  claim: ScenarioClaimDefinition,
  result: ClaimResult,
  addReason: (
    code: ClaimVerdictReductionReasonCode,
    checkId: ClaimVerdictReductionCheckId,
    message: string,
    affectedIds: string[],
  ) => void,
): void {
  if (healthStatus === 'passed') {
    const healthGatedAssertions = result.assertionResults.filter(
      (assertion) => assertion.reasonCode === 'health_gate_failed',
    );
    if (result.reasonCode === 'health_gate_failed' || healthGatedAssertions.length > 0) {
      addReason(
        'health_gate_mismatch',
        'health_gate',
        `Passed health cannot use health_gate_failed for claim ${claim.id}.`,
        [claim.id, ...healthGatedAssertions.map((assertion) => assertion.assertionId)],
      );
    }
    return;
  }

  const ungatedAssertions = result.assertionResults.filter(
    (assertion) =>
      assertion.status !== 'not_evaluable' || assertion.reasonCode !== 'health_gate_failed',
  );
  if (
    result.status !== 'not_evaluable' ||
    result.reasonCode !== 'health_gate_failed' ||
    ungatedAssertions.length > 0
  ) {
    addReason(
      'health_gate_mismatch',
      'health_gate',
      `${healthStatus} health requires claim ${claim.id} and every assertion to be health-gated not-evaluable.`,
      [claim.id, ...ungatedAssertions.map((assertion) => assertion.assertionId)],
    );
  }
}

function buildAuthoredExpectation(assertion: ScenarioClaimAssertion): ClaimAssertionResult['expected'] {
  switch (assertion.kind) {
    case 'eventOccurrence':
      return { event: assertion.event };
    case 'eventOrder':
      return { beforeEvent: assertion.beforeEvent, afterEvent: assertion.afterEvent };
    case 'terminalState':
      return { path: assertion.path, value: assertion.expected };
    case 'boundedCount':
      return {
        selector: assertion.selector,
        ...(assertion.minimum === undefined ? {} : { minimum: assertion.minimum }),
        ...(assertion.maximum === undefined ? {} : { maximum: assertion.maximum }),
        observationWindow: assertion.observationWindow,
      };
    case 'absence':
      return {
        selector: assertion.selector,
        observationWindow: assertion.observationWindow,
      };
    case 'validatedEvidence':
      return {
        artifactKind: assertion.artifactKind,
        validationContract: assertion.validationContract,
      };
  }
}

function claimApplies(
  claim: ScenarioClaimDefinition,
  selection: ClaimVerdictReductionSelection,
): boolean {
  if (!claim.applicability.platforms.includes(selection.platform)) {
    return false;
  }
  const variants = claim.applicability.variants;
  if (!variants) {
    return true;
  }
  return selection.variant === undefined ? false : variants.includes(selection.variant);
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function buildChecks(
  reasons: ClaimVerdictReductionBlockingReason[],
): ClaimVerdictReductionCheck[] {
  const ids: ClaimVerdictReductionCheckId[] = [
    'scenario_contract',
    'selected_platform',
    'verdict_contract',
    'scenario_identity',
    'claim_inventory',
    'claim_identity',
    'assertion_inventory',
    'assertion_identity',
    'authored_expectation',
    'health_gate',
    'claim_reduction',
    'journey_reduction',
  ];
  return ids.map((id) => {
    const checkReasons = reasons.filter((reason) => reason.checkId === id);
    return {
      id,
      outcome: checkReasons.length === 0 ? 'satisfied' : 'violated',
      reasonCodes: uniqueValues(checkReasons.map((reason) => reason.code)),
      affectedIds: uniqueValues(checkReasons.flatMap((reason) => reason.affectedIds)),
    };
  });
}

function outsideContract(
  base: ReductionInspectionBase,
  blockingReason: ClaimVerdictReductionBlockingReason,
): ScenarioClaimVerdictReductionInspection {
  return {
    ...base,
    reductionStatus: 'outside_contract',
    checks: [],
    blockingReasons: [blockingReason],
    nextAction: 'supply_supported_claim_contracts',
  };
}

function sortReasons(
  reasons: ClaimVerdictReductionBlockingReason[],
): ClaimVerdictReductionBlockingReason[] {
  return [...reasons].sort((left, right) => {
    const leftKey = `${left.code}\u0000${left.affectedIds.join('\u0000')}\u0000${left.message}`;
    const rightKey = `${right.code}\u0000${right.affectedIds.join('\u0000')}\u0000${right.message}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function uniqueValues<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}

export {
  CLAIM_VERDICT_REDUCTION_INSPECTION_VERSION,
  CLAIM_VERDICT_REDUCTION_TRUST,
  inspectScenarioClaimVerdictReduction,
};

export type {
  ClaimVerdictReductionBlockingReason,
  ClaimVerdictReductionCheck,
  ClaimVerdictReductionCheckId,
  ClaimVerdictReductionNextAction,
  ClaimVerdictReductionPlatform,
  ClaimVerdictReductionReasonCode,
  ClaimVerdictReductionSelection,
  ClaimVerdictReductionStatus,
  ScenarioClaimVerdictReductionInspection,
};
