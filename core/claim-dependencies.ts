import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  LEGACY_SCENARIO_SCHEMA_VERSION,
  canonicalizeClaimValue,
  type ClaimApplicability,
  type ScenarioClaimDefinition,
  type ScenarioClaimDependency,
} from './claim-contract';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_DEPENDENCY_INSPECTION_VERSION = '1.0.0' as const;

type ClaimDependencyPlatform = 'ios' | 'android';
type ClaimDependencySelection = {
  platform: ClaimDependencyPlatform;
  variant?: string;
};
type ClaimDependencyContractStatus = 'complete' | 'incomplete' | 'outside_contract';
type ClaimDependencyCheckCode =
  | 'scenario_claim_complete_schema'
  | 'selection_platform_declared'
  | 'dependency_identity'
  | 'claim_reference_integrity'
  | 'dependency_applicability_integrity'
  | 'selected_dependency_inventory';
type ClaimDependencyCheckStatus = 'satisfied' | 'failed' | 'not_evaluated';
type ClaimDependencyReasonCode =
  | 'legacy_scenario_schema'
  | 'unknown_scenario_schema'
  | 'malformed_scenario'
  | 'malformed_selection'
  | 'undeclared_platform'
  | 'duplicate_dependency_id'
  | 'unknown_claim_reference'
  | 'dependency_platform_outside_scenario'
  | 'dependency_platform_outside_claim'
  | 'dependency_variant_outside_claim';
type ClaimDependencyNextAction =
  | 'supply_claim_complete_scenario'
  | 'supply_valid_dependency_selection'
  | 'declare_selected_platform'
  | 'repair_dependency_identity'
  | 'repair_dependency_claim_references'
  | 'narrow_dependency_applicability'
  | 'dependency_inspection_complete';
type ClaimDependencyCheck = {
  code: ClaimDependencyCheckCode;
  status: ClaimDependencyCheckStatus;
  reasonCodes: ClaimDependencyReasonCode[];
  affectedIds: string[];
};
type ClaimDependencyBlockingReason = {
  code: ClaimDependencyReasonCode;
  message: string;
  affectedIds: string[];
  dependencyId?: string;
  claimId?: string;
};
type ScenarioClaimDependencyInspection = {
  contractVersion: typeof CLAIM_DEPENDENCY_INSPECTION_VERSION;
  scenarioSchemaVersion?: string;
  platform?: ClaimDependencyPlatform;
  variant?: string;
  dependencyContract: ClaimDependencyContractStatus;
  applicableDependencyIds: string[];
  checks: ClaimDependencyCheck[];
  blockingReasons: ClaimDependencyBlockingReason[];
  nextAction: ClaimDependencyNextAction;
};

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  platforms: ClaimDependencyPlatform[];
  claims: ScenarioClaimDefinition[];
  dependencies: ScenarioClaimDependency[];
};

const CHECK_ORDER: readonly ClaimDependencyCheckCode[] = [
  'scenario_claim_complete_schema',
  'selection_platform_declared',
  'dependency_identity',
  'claim_reference_integrity',
  'dependency_applicability_integrity',
  'selected_dependency_inventory',
];

function inspectScenarioClaimDependencies(
  scenario: unknown,
  selection: ClaimDependencySelection,
): ScenarioClaimDependencyInspection {
  const checks = createChecks();
  const blockingReasons: ClaimDependencyBlockingReason[] = [];
  const parsedSelection = parseSelection(selection);
  if (!parsedSelection.valid) {
    setCheck(checks, 'scenario_claim_complete_schema', 'not_evaluated', [], []);
    setCheck(checks, 'selection_platform_declared', 'failed', ['malformed_selection'], []);
    blockingReasons.push({
      code: 'malformed_selection',
      message: parsedSelection.message,
      affectedIds: [],
    });
    return buildInspection({}, [], checks, blockingReasons);
  }

  const validSelection = parsedSelection.selection;
  const selectionBase = {
    platform: validSelection.platform,
    ...(validSelection.variant === undefined ? {} : { variant: validSelection.variant }),
  };
  const scenarioSchemaVersion = readScenarioSchemaVersion(scenario);
  const base = {
    ...selectionBase,
    ...(scenarioSchemaVersion === undefined ? {} : { scenarioSchemaVersion }),
  };

  try {
    canonicalizeClaimValue(scenario);
  } catch (error) {
    failScenario(checks, blockingReasons, 'malformed_scenario', errorMessage(error));
    return buildInspection(base, [], checks, blockingReasons);
  }

  if (scenarioSchemaVersion === LEGACY_SCENARIO_SCHEMA_VERSION) {
    failScenario(
      checks,
      blockingReasons,
      'legacy_scenario_schema',
      'Claim dependency inspection applies only to scenario schemaVersion 1.1.0.',
    );
    return buildInspection(base, [], checks, blockingReasons);
  }
  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    const code = scenarioSchemaVersion === undefined
      ? 'malformed_scenario'
      : 'unknown_scenario_schema';
    failScenario(
      checks,
      blockingReasons,
      code,
      scenarioSchemaVersion === undefined
        ? 'Scenario does not expose a valid schemaVersion.'
        : `Scenario schemaVersion ${scenarioSchemaVersion} is outside the claim dependency contract.`,
    );
    return buildInspection(base, [], checks, blockingReasons);
  }

  const schemaResult = validateJson(scenario, SCHEMAS.scenario, 'Claim-complete scenario');
  if (!schemaResult.valid) {
    failScenario(checks, blockingReasons, 'malformed_scenario', schemaResult.message);
    return buildInspection(base, [], checks, blockingReasons);
  }
  setCheck(checks, 'scenario_claim_complete_schema', 'satisfied', [], []);

  const candidate = scenario as ClaimCompleteScenario;
  if (!candidate.platforms.includes(validSelection.platform)) {
    setCheck(
      checks,
      'selection_platform_declared',
      'failed',
      ['undeclared_platform'],
      [validSelection.platform],
    );
    blockingReasons.push({
      code: 'undeclared_platform',
      message: `Scenario does not declare selected platform ${validSelection.platform}.`,
      affectedIds: [validSelection.platform],
    });
    return buildInspection(base, [], checks, blockingReasons);
  }
  setCheck(checks, 'selection_platform_declared', 'satisfied', [], []);

  const duplicateIds = duplicateValues(candidate.dependencies.map((dependency) => dependency.id));
  for (const dependencyId of duplicateIds) {
    blockingReasons.push({
      code: 'duplicate_dependency_id',
      message: `Dependency ID ${dependencyId} is declared more than once.`,
      affectedIds: [dependencyId],
      dependencyId,
    });
  }
  setCheck(
    checks,
    'dependency_identity',
    duplicateIds.length === 0 ? 'satisfied' : 'failed',
    duplicateIds.length === 0 ? [] : ['duplicate_dependency_id'],
    duplicateIds,
  );

  const claimsById = new Map(candidate.claims.map((claim) => [claim.id, claim]));
  const unknownReferences: Array<{ dependencyId: string; claimId: string }> = [];
  for (const dependency of candidate.dependencies) {
    if (dependency.kind !== 'claim_scoped') {
      continue;
    }
    for (const claimId of dependency.claimIds) {
      if (!claimsById.has(claimId)) {
        unknownReferences.push({ dependencyId: dependency.id, claimId });
        blockingReasons.push({
          code: 'unknown_claim_reference',
          message: `Dependency ${dependency.id} references unknown claim ${claimId}.`,
          affectedIds: [dependency.id, claimId],
          dependencyId: dependency.id,
          claimId,
        });
      }
    }
  }
  setCheck(
    checks,
    'claim_reference_integrity',
    unknownReferences.length === 0 ? 'satisfied' : 'failed',
    unknownReferences.length === 0 ? [] : ['unknown_claim_reference'],
    uniqueStrings(unknownReferences.flatMap((reference) => [reference.dependencyId, reference.claimId])),
  );

  const applicabilityReasons = inspectApplicability(candidate, claimsById);
  blockingReasons.push(...applicabilityReasons);
  setCheck(
    checks,
    'dependency_applicability_integrity',
    applicabilityReasons.length === 0 ? 'satisfied' : 'failed',
    uniqueReasonCodes(applicabilityReasons),
    uniqueStrings(applicabilityReasons.flatMap((reason) => reason.affectedIds)),
  );

  const applicableDependencyIds = candidate.dependencies
    .filter((dependency) => appliesToSelection(dependency.applicability, validSelection))
    .map((dependency) => dependency.id);
  setCheck(
    checks,
    'selected_dependency_inventory',
    'satisfied',
    [],
    applicableDependencyIds,
  );
  return buildInspection(base, applicableDependencyIds, checks, blockingReasons);
}

function inspectApplicability(
  scenario: ClaimCompleteScenario,
  claimsById: Map<string, ScenarioClaimDefinition>,
): ClaimDependencyBlockingReason[] {
  const reasons: ClaimDependencyBlockingReason[] = [];
  const scenarioPlatforms = new Set(scenario.platforms);
  for (const dependency of scenario.dependencies) {
    const outsideScenario = dependency.applicability.platforms.filter(
      (platform) => !scenarioPlatforms.has(platform),
    );
    if (outsideScenario.length > 0) {
      reasons.push({
        code: 'dependency_platform_outside_scenario',
        message: `Dependency ${dependency.id} declares a platform outside the scenario.`,
        affectedIds: [dependency.id, ...outsideScenario],
        dependencyId: dependency.id,
      });
    }
    if (dependency.kind !== 'claim_scoped') {
      continue;
    }
    for (const claimId of dependency.claimIds) {
      const claim = claimsById.get(claimId);
      if (!claim) {
        continue;
      }
      const claimPlatforms = new Set(claim.applicability.platforms);
      const outsideClaim = dependency.applicability.platforms.filter(
        (platform) => !claimPlatforms.has(platform),
      );
      if (outsideClaim.length > 0) {
        reasons.push({
          code: 'dependency_platform_outside_claim',
          message: `Dependency ${dependency.id} is broader than referenced claim ${claimId}.`,
          affectedIds: [dependency.id, claimId, ...outsideClaim],
          dependencyId: dependency.id,
          claimId,
        });
      }
      const dependencyVariants = dependency.applicability.variants;
      const claimVariants = claim.applicability.variants;
      const variantsAreWider = claimVariants !== undefined && (
        dependencyVariants === undefined ||
        dependencyVariants.some((variant) => !claimVariants.includes(variant))
      );
      if (variantsAreWider) {
        reasons.push({
          code: 'dependency_variant_outside_claim',
          message: `Dependency ${dependency.id} variant scope is broader than referenced claim ${claimId}.`,
          affectedIds: [dependency.id, claimId, ...(dependencyVariants ?? [])],
          dependencyId: dependency.id,
          claimId,
        });
      }
    }
  }
  return reasons;
}

function appliesToSelection(
  applicability: ClaimApplicability,
  selection: ClaimDependencySelection,
): boolean {
  if (!applicability.platforms.includes(selection.platform)) {
    return false;
  }
  if (!applicability.variants) {
    return true;
  }
  return selection.variant !== undefined && applicability.variants.includes(selection.variant);
}

function failScenario(
  checks: ClaimDependencyCheck[],
  reasons: ClaimDependencyBlockingReason[],
  code: Extract<
    ClaimDependencyReasonCode,
    'legacy_scenario_schema' | 'unknown_scenario_schema' | 'malformed_scenario'
  >,
  message: string,
): void {
  setCheck(checks, 'scenario_claim_complete_schema', 'failed', [code], []);
  reasons.push({ code, message, affectedIds: [] });
}

function createChecks(): ClaimDependencyCheck[] {
  return CHECK_ORDER.map((code) => ({
    code,
    status: 'not_evaluated',
    reasonCodes: [],
    affectedIds: [],
  }));
}

function setCheck(
  checks: ClaimDependencyCheck[],
  code: ClaimDependencyCheckCode,
  status: ClaimDependencyCheckStatus,
  reasonCodes: ClaimDependencyReasonCode[],
  affectedIds: string[],
): void {
  const check = checks.find((candidate) => candidate.code === code);
  if (!check) {
    throw new Error(`Unknown claim dependency check ${code}.`);
  }
  check.status = status;
  check.reasonCodes = uniqueStrings(reasonCodes);
  check.affectedIds = uniqueStrings(affectedIds);
}

function buildInspection(
  base: Pick<
    ScenarioClaimDependencyInspection,
    'scenarioSchemaVersion' | 'platform' | 'variant'
  >,
  applicableDependencyIds: string[],
  checks: ClaimDependencyCheck[],
  blockingReasons: ClaimDependencyBlockingReason[],
): ScenarioClaimDependencyInspection {
  const hasOutsideContractFailure = checks
    .slice(0, 2)
    .some((check) => check.status === 'failed');
  const hasFailure = checks.some((check) => check.status === 'failed');
  const allSatisfied = checks.every((check) => check.status === 'satisfied');
  let dependencyContract: ClaimDependencyContractStatus = 'outside_contract';
  if (!hasOutsideContractFailure && hasFailure) {
    dependencyContract = 'incomplete';
  } else if (allSatisfied && blockingReasons.length === 0) {
    dependencyContract = 'complete';
  }
  return {
    contractVersion: CLAIM_DEPENDENCY_INSPECTION_VERSION,
    ...base,
    dependencyContract,
    applicableDependencyIds,
    checks,
    blockingReasons,
    nextAction: selectNextAction(blockingReasons),
  };
}

function selectNextAction(
  reasons: ClaimDependencyBlockingReason[],
): ClaimDependencyNextAction {
  const codes = new Set(reasons.map((reason) => reason.code));
  if (
    codes.has('legacy_scenario_schema') ||
    codes.has('unknown_scenario_schema') ||
    codes.has('malformed_scenario')
  ) {
    return 'supply_claim_complete_scenario';
  }
  if (codes.has('malformed_selection')) {
    return 'supply_valid_dependency_selection';
  }
  if (codes.has('undeclared_platform')) {
    return 'declare_selected_platform';
  }
  if (codes.has('duplicate_dependency_id')) {
    return 'repair_dependency_identity';
  }
  if (codes.has('unknown_claim_reference')) {
    return 'repair_dependency_claim_references';
  }
  if (
    codes.has('dependency_platform_outside_scenario') ||
    codes.has('dependency_platform_outside_claim') ||
    codes.has('dependency_variant_outside_claim')
  ) {
    return 'narrow_dependency_applicability';
  }
  return 'dependency_inspection_complete';
}

type SelectionParseResult =
  | { valid: true; selection: ClaimDependencySelection }
  | { valid: false; message: string };

function parseSelection(selection: unknown): SelectionParseResult {
  try {
    canonicalizeClaimValue(selection);
  } catch (error) {
    return { valid: false, message: errorMessage(error) };
  }
  if (!isPlainRecord(selection) || !hasOnlyKeys(selection, ['platform', 'variant'])) {
    return { valid: false, message: 'Dependency selection must be a closed plain object.' };
  }
  if (selection.platform !== 'ios' && selection.platform !== 'android') {
    return { valid: false, message: 'Dependency selection.platform must be ios or android.' };
  }
  if (selection.variant !== undefined && !isNonBlankString(selection.variant)) {
    return { valid: false, message: 'Dependency selection.variant must be non-blank when supplied.' };
  }
  return {
    valid: true,
    selection: {
      platform: selection.platform,
      ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    },
  };
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

function uniqueReasonCodes(
  reasons: readonly ClaimDependencyBlockingReason[],
): ClaimDependencyReasonCode[] {
  return uniqueStrings(reasons.map((reason) => reason.code));
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readScenarioSchemaVersion(value: unknown): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  return typeof value.schemaVersion === 'string' && value.schemaVersion.length > 0
    ? value.schemaVersion
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  CLAIM_DEPENDENCY_INSPECTION_VERSION,
  inspectScenarioClaimDependencies,
};

export type {
  ClaimDependencyBlockingReason,
  ClaimDependencyCheck,
  ClaimDependencyCheckCode,
  ClaimDependencyCheckStatus,
  ClaimDependencyContractStatus,
  ClaimDependencyNextAction,
  ClaimDependencyPlatform,
  ClaimDependencyReasonCode,
  ClaimDependencySelection,
  ScenarioClaimDependencyInspection,
};
