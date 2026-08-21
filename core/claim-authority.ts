import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  type ArtifactKind,
  type ClaimAuthorityRole,
  type ClaimEvidenceCompleteness,
  type ClaimIdentityStrength,
  type ClaimRole,
  type ScenarioClaimAssertion,
  type ScenarioClaimDefinition,
  type ScenarioClaimDependency,
} from './claim-contract';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_AUTHORITY_INSPECTION_VERSION = '1.0.0' as const;
const AUTHORITY_CAPABILITIES_SCHEMA_VERSION = '1.0.0' as const;

type ClaimAuthorityPlatform = 'ios' | 'android';
type ClaimAssertionKind = ScenarioClaimAssertion['kind'];
type ClaimAuthorityCompatibility = 'compatible' | 'incompatible' | 'outside_contract';
type ClaimAuthorityCheckOutcome = 'matched' | 'not_matched';
type ClaimAuthorityReasonCode =
  | 'scenario_schema_outside_contract'
  | 'scenario_schema_invalid'
  | 'selected_platform_outside_contract'
  | 'authority_declaration_invalid'
  | 'duplicate_authority_declaration'
  | 'authority_path_missing'
  | 'authority_platform_unsupported'
  | 'assertion_kind_unsupported'
  | 'evidence_selector_unsupported'
  | 'artifact_kind_unsupported'
  | 'validation_contract_unsupported'
  | 'identity_strength_insufficient'
  | 'evidence_completeness_insufficient';
type ClaimAuthorityNextAction =
  | 'repair_scenario_contract'
  | 'repair_authority_catalog'
  | 'declare_compatible_authority_paths'
  | 'authority_inspection_complete';

type ClaimAuthoritySelection = {
  platform: ClaimAuthorityPlatform;
  variant?: string;
};

type AuthorityCapabilities = {
  schemaVersion: typeof AUTHORITY_CAPABILITIES_SCHEMA_VERSION;
  declarationId: string;
  role: ClaimAuthorityRole;
  producerId: string;
  platforms: [ClaimAuthorityPlatform, ...ClaimAuthorityPlatform[]];
  assertionKinds: [ClaimAssertionKind, ...ClaimAssertionKind[]];
  evidenceSelectors: [string, ...string[]];
  maxStrength: ClaimIdentityStrength;
  maxCompleteness: ClaimEvidenceCompleteness;
  artifactKinds?: [ArtifactKind, ...ArtifactKind[]];
  validationContracts?: [string, ...string[]];
};

type ScenarioClaimAuthorityCheckBase = {
  assertionKind: ClaimAssertionKind;
  authorityRole: ClaimAuthorityRole;
  producerId: string;
  outcome: ClaimAuthorityCheckOutcome;
  reasonCodes: ClaimAuthorityReasonCode[];
  declarationId?: string;
};

type ScenarioClaimAuthorityCheck = ScenarioClaimAuthorityCheckBase & (
  | {
      subjectKind: 'claim_assertion';
      claimId: string;
      claimRole: ClaimRole;
      assertionId: string;
    }
  | {
      subjectKind: 'dependency_predicate';
      dependencyId: string;
      dependencyKind: ScenarioClaimDependency['kind'];
      predicateId: string;
      claimIds?: string[];
    }
);

type ScenarioClaimAuthorityBlockingReason = {
  code: ClaimAuthorityReasonCode;
  message: string;
  affectedIds: string[];
  claimId?: string;
  assertionId?: string;
  dependencyId?: string;
  predicateId?: string;
};

type ScenarioClaimAuthorityInspection = {
  contractVersion: typeof CLAIM_AUTHORITY_INSPECTION_VERSION;
  scenarioSchemaVersion?: string;
  platform: ClaimAuthorityPlatform;
  variant?: string;
  authorityCompatibility: ClaimAuthorityCompatibility;
  checks: ScenarioClaimAuthorityCheck[];
  blockingReasons: ScenarioClaimAuthorityBlockingReason[];
  nextAction: ClaimAuthorityNextAction;
};

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  platforms: ClaimAuthorityPlatform[];
  claims: ScenarioClaimDefinition[];
  dependencies: ScenarioClaimDependency[];
};

type AssertionContext =
  | {
      subjectKind: 'claim_assertion';
      claim: ScenarioClaimDefinition;
      assertion: ScenarioClaimAssertion;
    }
  | {
      subjectKind: 'dependency_predicate';
      dependency: ScenarioClaimDependency;
      assertion: ScenarioClaimAssertion;
    };

type AssertionMismatch = {
  code: ClaimAuthorityReasonCode;
  message: string;
};

const IDENTITY_STRENGTH_RANK: Record<ClaimIdentityStrength, number> = {
  observed: 0,
  verified: 1,
};

const EVIDENCE_COMPLETENESS_RANK: Record<ClaimEvidenceCompleteness, number> = {
  point: 0,
  bounded: 1,
  'continuous-complete': 2,
};

function inspectScenarioClaimAuthority(
  scenario: unknown,
  selection: ClaimAuthoritySelection,
  declarations: readonly unknown[],
): ScenarioClaimAuthorityInspection {
  const scenarioSchemaVersion = readScenarioSchemaVersion(scenario);
  const base = {
    contractVersion: CLAIM_AUTHORITY_INSPECTION_VERSION,
    ...(scenarioSchemaVersion ? { scenarioSchemaVersion } : {}),
    platform: selection.platform,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  };

  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    return outsideContract(base, {
      code: 'scenario_schema_outside_contract',
      message: 'Claim authority inspection applies only to scenario schemaVersion 1.1.0.',
      affectedIds: [],
    });
  }

  const scenarioResult = validateJson(scenario, SCHEMAS.scenario, 'Claim-complete scenario');
  if (!scenarioResult.valid) {
    return outsideContract(base, {
      code: 'scenario_schema_invalid',
      message: scenarioResult.message,
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

  const declarationResult = validateAuthorityDeclarations(declarations);
  if (!declarationResult.valid) {
    return {
      ...base,
      authorityCompatibility: 'outside_contract',
      checks: [],
      blockingReasons: declarationResult.reasons,
      nextAction: 'repair_authority_catalog',
    };
  }

  const duplicateReasons = findOverlappingDeclarationReasons(
    declarationResult.declarations,
    selection.platform,
  );
  if (duplicateReasons.length > 0) {
    return {
      ...base,
      authorityCompatibility: 'incompatible',
      checks: [],
      blockingReasons: duplicateReasons,
      nextAction: 'repair_authority_catalog',
    };
  }

  const applicableClaimAssertions: AssertionContext[] = candidate.claims
    .filter((claim) => claimApplies(claim, selection))
    .flatMap((claim) => claim.assertions.map((assertion) => ({
      subjectKind: 'claim_assertion' as const,
      claim,
      assertion,
    })));
  const applicableDependencyPredicates: AssertionContext[] = candidate.dependencies
    .filter((dependency) => applicabilityMatches(dependency.applicability, selection))
    .map((dependency) => ({
      subjectKind: 'dependency_predicate' as const,
      dependency,
      assertion: dependency.predicate,
    }));
  const applicableAssertions = [
    ...applicableClaimAssertions,
    ...applicableDependencyPredicates,
  ];
  const checks: ScenarioClaimAuthorityCheck[] = [];
  const blockingReasons: ScenarioClaimAuthorityBlockingReason[] = [];

  for (const context of applicableAssertions) {
    const result = inspectAssertionAuthority(
      context,
      selection.platform,
      declarationResult.declarations,
    );
    checks.push(result.check);
    blockingReasons.push(...result.reasons);
  }

  if (blockingReasons.length > 0) {
    return {
      ...base,
      authorityCompatibility: 'incompatible',
      checks,
      blockingReasons,
      nextAction: 'declare_compatible_authority_paths',
    };
  }

  return {
    ...base,
    authorityCompatibility: 'compatible',
    checks,
    blockingReasons: [],
    nextAction: 'authority_inspection_complete',
  };
}

function validateAuthorityDeclarations(declarations: readonly unknown[]):
  | { valid: true; declarations: AuthorityCapabilities[] }
  | { valid: false; reasons: ScenarioClaimAuthorityBlockingReason[] } {
  const validDeclarations: AuthorityCapabilities[] = [];
  const reasons: ScenarioClaimAuthorityBlockingReason[] = [];

  for (const [index, declaration] of declarations.entries()) {
    const result = validateJson(
      declaration,
      SCHEMAS.authorityCapabilities,
      `Authority capabilities declaration ${index}`,
    );
    if (!result.valid) {
      reasons.push({
        code: 'authority_declaration_invalid',
        message: result.message,
        affectedIds: [`declaration-${index}`],
      });
    } else {
      validDeclarations.push(declaration as AuthorityCapabilities);
    }
  }

  return reasons.length === 0
    ? { valid: true, declarations: validDeclarations }
    : { valid: false, reasons };
}

function findOverlappingDeclarationReasons(
  declarations: AuthorityCapabilities[],
  platform: ClaimAuthorityPlatform,
): ScenarioClaimAuthorityBlockingReason[] {
  const declarationsByAuthority = new Map<string, AuthorityCapabilities[]>();
  for (const declaration of declarations.filter((item) => item.platforms.includes(platform))) {
    const key = `${declaration.role}\u0000${declaration.producerId}`;
    declarationsByAuthority.set(key, [
      ...(declarationsByAuthority.get(key) ?? []),
      declaration,
    ]);
  }

  return [...declarationsByAuthority.values()]
    .filter((items) => items.length > 1)
    .map((items) => ({
      code: 'duplicate_authority_declaration' as const,
      message: `Authority ${items[0]?.role}:${items[0]?.producerId} has overlapping declarations for ${platform}.`,
      affectedIds: items.map((item) => item.declarationId),
    }));
}

function inspectAssertionAuthority(
  context: AssertionContext,
  platform: ClaimAuthorityPlatform,
  declarations: AuthorityCapabilities[],
): {
  check: ScenarioClaimAuthorityCheck;
  reasons: ScenarioClaimAuthorityBlockingReason[];
} {
  const { assertion } = context;
  const authorityDeclarations = declarations.filter(
    (declaration) =>
      declaration.role === assertion.authority.role &&
      declaration.producerId === assertion.authority.producerId,
  );
  const platformDeclaration = authorityDeclarations.find((declaration) =>
    declaration.platforms.includes(platform),
  );
  const mismatches = buildAssertionMismatches(assertion, authorityDeclarations, platformDeclaration);
  const reasons = mismatches.map((mismatch) => buildBlockingReason(context, mismatch));

  return {
    check: buildAuthorityCheck(
      context,
      {
        assertionKind: assertion.kind,
        authorityRole: assertion.authority.role,
        producerId: assertion.authority.producerId,
        outcome: reasons.length === 0 ? 'matched' : 'not_matched',
        reasonCodes: reasons.map((reason) => reason.code),
        ...(platformDeclaration ? { declarationId: platformDeclaration.declarationId } : {}),
      },
    ),
    reasons,
  };
}

function buildAuthorityCheck(
  context: AssertionContext,
  base: ScenarioClaimAuthorityCheckBase,
): ScenarioClaimAuthorityCheck {
  if (context.subjectKind === 'claim_assertion') {
    return {
      ...base,
      subjectKind: 'claim_assertion',
      claimId: context.claim.id,
      claimRole: context.claim.role,
      assertionId: context.assertion.id,
    };
  }
  return {
    ...base,
    subjectKind: 'dependency_predicate',
    dependencyId: context.dependency.id,
    dependencyKind: context.dependency.kind,
    predicateId: context.assertion.id,
    ...(context.dependency.kind === 'claim_scoped'
      ? { claimIds: [...context.dependency.claimIds] }
      : {}),
  };
}

function buildBlockingReason(
  context: AssertionContext,
  mismatch: AssertionMismatch,
): ScenarioClaimAuthorityBlockingReason {
  if (context.subjectKind === 'claim_assertion') {
    return {
      code: mismatch.code,
      message: mismatch.message,
      affectedIds: [context.claim.id, context.assertion.id],
      claimId: context.claim.id,
      assertionId: context.assertion.id,
    };
  }
  return {
    code: mismatch.code,
    message: mismatch.message,
    affectedIds: [context.dependency.id, context.assertion.id],
    dependencyId: context.dependency.id,
    predicateId: context.assertion.id,
  };
}

function buildAssertionMismatches(
  assertion: ScenarioClaimAssertion,
  authorityDeclarations: AuthorityCapabilities[],
  declaration: AuthorityCapabilities | undefined,
): AssertionMismatch[] {
  if (authorityDeclarations.length === 0) {
    return [
      {
        code: 'authority_path_missing',
        message: `No authority declaration names ${assertion.authority.role}:${assertion.authority.producerId}.`,
      },
    ];
  }

  if (!declaration) {
    return [
      {
        code: 'authority_platform_unsupported',
        message: `Authority ${assertion.authority.role}:${assertion.authority.producerId} does not declare the selected platform.`,
      },
    ];
  }

  const mismatches: AssertionMismatch[] = [];
  if (!declaration.assertionKinds.includes(assertion.kind)) {
    mismatches.push({
      code: 'assertion_kind_unsupported',
      message: `Declaration ${declaration.declarationId} does not declare assertion kind ${assertion.kind}.`,
    });
  }
  if (!declaration.evidenceSelectors.includes(assertion.authority.evidenceSelector)) {
    mismatches.push({
      code: 'evidence_selector_unsupported',
      message: `Declaration ${declaration.declarationId} does not declare evidence selector ${assertion.authority.evidenceSelector}.`,
    });
  }
  if (assertion.kind === 'validatedEvidence') {
    if (!declaration.artifactKinds?.includes(assertion.artifactKind)) {
      mismatches.push({
        code: 'artifact_kind_unsupported',
        message: `Declaration ${declaration.declarationId} does not declare artifact kind ${assertion.artifactKind}.`,
      });
    }
    if (!declaration.validationContracts?.includes(assertion.validationContract)) {
      mismatches.push({
        code: 'validation_contract_unsupported',
        message: `Declaration ${declaration.declarationId} does not declare validation contract ${assertion.validationContract}.`,
      });
    }
  }
  if (
    IDENTITY_STRENGTH_RANK[declaration.maxStrength] <
    IDENTITY_STRENGTH_RANK[assertion.authority.requiredStrength]
  ) {
    mismatches.push({
      code: 'identity_strength_insufficient',
      message: `Declaration ${declaration.declarationId} does not meet required identity strength ${assertion.authority.requiredStrength}.`,
    });
  }
  if (
    EVIDENCE_COMPLETENESS_RANK[declaration.maxCompleteness] <
    EVIDENCE_COMPLETENESS_RANK[assertion.authority.completeness]
  ) {
    mismatches.push({
      code: 'evidence_completeness_insufficient',
      message: `Declaration ${declaration.declarationId} does not meet required completeness ${assertion.authority.completeness}.`,
    });
  }

  return mismatches;
}

function claimApplies(
  claim: ScenarioClaimDefinition,
  selection: ClaimAuthoritySelection,
): boolean {
  return applicabilityMatches(claim.applicability, selection);
}

function applicabilityMatches(
  applicability: ScenarioClaimDefinition['applicability'],
  selection: ClaimAuthoritySelection,
): boolean {
  if (!applicability.platforms.includes(selection.platform)) {
    return false;
  }
  if (!applicability.variants) {
    return true;
  }
  return selection.variant === undefined
    ? false
    : applicability.variants.includes(selection.variant);
}

function outsideContract(
  base: Pick<
    ScenarioClaimAuthorityInspection,
    'contractVersion' | 'scenarioSchemaVersion' | 'platform' | 'variant'
  >,
  reason: ScenarioClaimAuthorityBlockingReason,
): ScenarioClaimAuthorityInspection {
  return {
    ...base,
    authorityCompatibility: 'outside_contract',
    checks: [],
    blockingReasons: [reason],
    nextAction: 'repair_scenario_contract',
  };
}

function readScenarioSchemaVersion(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  return typeof schemaVersion === 'string' ? schemaVersion : undefined;
}

export {
  AUTHORITY_CAPABILITIES_SCHEMA_VERSION,
  CLAIM_AUTHORITY_INSPECTION_VERSION,
  inspectScenarioClaimAuthority,
};

export type {
  AuthorityCapabilities,
  ClaimAssertionKind,
  ClaimAuthorityCheckOutcome,
  ClaimAuthorityCompatibility,
  ClaimAuthorityNextAction,
  ClaimAuthorityPlatform,
  ClaimAuthorityReasonCode,
  ClaimAuthoritySelection,
  ScenarioClaimAuthorityBlockingReason,
  ScenarioClaimAuthorityCheck,
  ScenarioClaimAuthorityInspection,
};
