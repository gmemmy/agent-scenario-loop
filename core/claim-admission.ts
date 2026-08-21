import {
  inspectScenarioClaimAuthority,
  type AuthorityCapabilities,
  type ScenarioClaimAuthorityInspection,
} from './claim-authority';
import {
  inspectScenarioClaimClosure,
  type ScenarioClaimClosureInspection,
} from './claim-closure';
import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  canonicalizeClaimValue,
} from './claim-contract';
import {
  inspectScenarioClaimDependencies,
  type ScenarioClaimDependencyInspection,
} from './claim-dependencies';
import {
  inspectScenarioClaimSafety,
  type ClaimSafetyNextAction,
  type ScenarioClaimSafetyInspection,
} from './claim-safety';
import {
  buildScenarioClaimCompleteContractHash,
  inspectScenarioClaimApproval,
  type ScenarioClaimApprovalInspection,
  type ScenarioClaimApprovalNextAction,
} from './scenario-claim-approval';
import {
  inspectScenarioClaimAuthorization,
  type ScenarioClaimAuthorizationGrant,
  type ScenarioClaimAuthorizationInspection,
  type ScenarioClaimAuthorizationNextAction,
  type ScenarioClaimAuthorizationRequest,
} from './scenario-claim-authorization';
import { SCHEMAS, validateJson } from './schema-validator';

const CLAIM_ADMISSION_INSPECTION_VERSION = '1.0.0' as const;

type ScenarioClaimAdmissionPlatform = 'ios' | 'android';
type ScenarioClaimAdmissionSelection = {
  platform: ScenarioClaimAdmissionPlatform;
  variant?: string;
};
type ScenarioClaimAdmissionInput = {
  scenario: unknown;
  selection: ScenarioClaimAdmissionSelection;
  authorityCatalog: readonly AuthorityCapabilities[];
  authorizationRequest: ScenarioClaimAuthorizationRequest;
  authorizationGrant: ScenarioClaimAuthorizationGrant;
  approval: unknown;
};
type ScenarioClaimAdmissionGate =
  | 'schema_and_selection'
  | 'closure'
  | 'authority'
  | 'safety'
  | 'authorization'
  | 'approval'
  | 'dependencies';
type ScenarioClaimAdmissionOwnerGate = Exclude<
  ScenarioClaimAdmissionGate,
  'schema_and_selection'
>;
type ScenarioClaimAdmissionOutsideNextAction =
  | 'supply_claim_complete_scenario'
  | 'supply_valid_admission_selection'
  | 'declare_selected_platform';
type ScenarioClaimAdmissionBlockedNextAction =
  | ClaimSafetyNextAction
  | ScenarioClaimApprovalNextAction
  | ScenarioClaimAuthorizationNextAction
  | ScenarioClaimDependencyInspection['nextAction']
  | ScenarioClaimAuthorityInspection['nextAction']
  | 'resolve_first_blocking_admission_gate';

type ScenarioClaimAdmissionInspections = {
  closure: ScenarioClaimClosureInspection;
  authority: ScenarioClaimAuthorityInspection;
  safety: ScenarioClaimSafetyInspection;
  authorization: ScenarioClaimAuthorizationInspection;
  approval: ScenarioClaimApprovalInspection;
  dependencies: ScenarioClaimDependencyInspection;
};

type ScenarioClaimAdmissionGateSummary =
  | { gate: 'schema_and_selection'; status: 'failed' }
  | { gate: 'closure'; status: ScenarioClaimClosureInspection['claimClosure'] }
  | { gate: 'authority'; status: ScenarioClaimAuthorityInspection['authorityCompatibility'] }
  | { gate: 'safety'; status: ScenarioClaimSafetyInspection['safetyContract'] }
  | {
      gate: 'authorization';
      status: ScenarioClaimAuthorizationInspection['authorizationCompatibility'];
    }
  | { gate: 'approval'; status: ScenarioClaimApprovalInspection['approvalBinding'] }
  | { gate: 'dependencies'; status: ScenarioClaimDependencyInspection['dependencyContract'] };

type ScenarioClaimAdmissionOwnerGateSummaries = [
  Extract<ScenarioClaimAdmissionGateSummary, { gate: 'closure' }>,
  Extract<ScenarioClaimAdmissionGateSummary, { gate: 'authority' }>,
  Extract<ScenarioClaimAdmissionGateSummary, { gate: 'safety' }>,
  Extract<ScenarioClaimAdmissionGateSummary, { gate: 'authorization' }>,
  Extract<ScenarioClaimAdmissionGateSummary, { gate: 'approval' }>,
  Extract<ScenarioClaimAdmissionGateSummary, { gate: 'dependencies' }>,
];

type ScenarioClaimAdmissionSuccessGateSummaries = [
  { gate: 'closure'; status: 'closed' },
  { gate: 'authority'; status: 'compatible' },
  { gate: 'safety'; status: 'complete' },
  { gate: 'authorization'; status: 'compatible' },
  { gate: 'approval'; status: 'bound' },
  { gate: 'dependencies'; status: 'complete' },
];

type ScenarioClaimAdmissionOutsideContract = {
  contractVersion: typeof CLAIM_ADMISSION_INSPECTION_VERSION;
  status: 'outside_contract';
  scenarioSchemaVersion?: string;
  selection?: ScenarioClaimAdmissionSelection;
  gateSummaries: [{ gate: 'schema_and_selection'; status: 'failed' }];
  nextAction: ScenarioClaimAdmissionOutsideNextAction;
};

type ScenarioClaimAdmissionBlocked = {
  contractVersion: typeof CLAIM_ADMISSION_INSPECTION_VERSION;
  status: 'blocked';
  scenarioSchemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  selection: ScenarioClaimAdmissionSelection;
  scenarioHash: string;
  inspections: ScenarioClaimAdmissionInspections;
  gateSummaries: ScenarioClaimAdmissionOwnerGateSummaries;
  firstBlockingGate: ScenarioClaimAdmissionOwnerGate;
  blockingGates: [ScenarioClaimAdmissionOwnerGate, ...ScenarioClaimAdmissionOwnerGate[]];
  nextAction: ScenarioClaimAdmissionBlockedNextAction;
};

type ScenarioClaimAdmissionAdmitted = {
  contractVersion: typeof CLAIM_ADMISSION_INSPECTION_VERSION;
  status: 'admitted';
  scenarioSchemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  selection: ScenarioClaimAdmissionSelection;
  scenarioHash: string;
  inspections: ScenarioClaimAdmissionInspections;
  gateSummaries: ScenarioClaimAdmissionSuccessGateSummaries;
  blockingGates: [];
};

type ScenarioClaimAdmissionInspection =
  | ScenarioClaimAdmissionOutsideContract
  | ScenarioClaimAdmissionBlocked
  | ScenarioClaimAdmissionAdmitted;

type SelectionParseResult =
  | { valid: true; selection: ScenarioClaimAdmissionSelection }
  | { valid: false };

type ClaimCompleteScenarioIdentity = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  platforms: ScenarioClaimAdmissionPlatform[];
};

function inspectScenarioClaimAdmission(
  input: ScenarioClaimAdmissionInput,
): ScenarioClaimAdmissionInspection {
  const selectionResult = parseSelection(input.selection);
  if (!selectionResult.valid) {
    return outsideContract('supply_valid_admission_selection');
  }

  const selection = selectionResult.selection;
  const scenarioSchemaVersion = readScenarioSchemaVersion(input.scenario);
  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    return outsideContract(
      'supply_claim_complete_scenario',
      selection,
      scenarioSchemaVersion,
    );
  }

  // Gate one must prove the complete scenario shape before any owner input is read.
  try {
    canonicalizeClaimValue(input.scenario);
  } catch {
    return outsideContract(
      'supply_claim_complete_scenario',
      selection,
      scenarioSchemaVersion,
    );
  }

  const schemaResult = validateJson(
    input.scenario,
    SCHEMAS.scenario,
    'Claim-complete admission scenario',
  );
  if (!schemaResult.valid) {
    return outsideContract(
      'supply_claim_complete_scenario',
      selection,
      scenarioSchemaVersion,
    );
  }

  const scenario = input.scenario as ClaimCompleteScenarioIdentity;
  if (!scenario.platforms.includes(selection.platform)) {
    return outsideContract('declare_selected_platform', selection, scenarioSchemaVersion);
  }

  const scenarioHash = buildScenarioClaimCompleteContractHash(input.scenario);
  const inspections = inspectAllOwners(input, selection);
  const gateSummaries = buildGateSummaries(inspections);
  const blockingGates = collectBlockingGates(gateSummaries);
  const base = {
    contractVersion: CLAIM_ADMISSION_INSPECTION_VERSION,
    scenarioSchemaVersion: CLAIM_CONTRACT_SCHEMA_VERSION,
    selection,
    scenarioHash,
    inspections,
  };

  const firstBlockingGate = blockingGates[0];
  if (firstBlockingGate === undefined) {
    return {
      ...base,
      status: 'admitted',
      gateSummaries: buildSuccessGateSummaries(),
      blockingGates: [],
    };
  }

  return {
    ...base,
    status: 'blocked',
    gateSummaries,
    firstBlockingGate,
    blockingGates: [firstBlockingGate, ...blockingGates.slice(1)],
    nextAction: selectNextAction(firstBlockingGate, inspections),
  };
}

function inspectAllOwners(
  input: ScenarioClaimAdmissionInput,
  selection: ScenarioClaimAdmissionSelection,
): ScenarioClaimAdmissionInspections {
  return {
    closure: inspectScenarioClaimClosure(input.scenario, selection),
    authority: inspectScenarioClaimAuthority(
      input.scenario,
      selection,
      input.authorityCatalog,
    ),
    safety: inspectScenarioClaimSafety(input.scenario, selection),
    authorization: inspectScenarioClaimAuthorization(
      input.scenario,
      selection,
      input.authorizationRequest,
      input.authorizationGrant,
    ),
    approval: inspectScenarioClaimApproval(input.scenario, selection, input.approval),
    dependencies: inspectScenarioClaimDependencies(input.scenario, selection),
  };
}

function buildGateSummaries(
  inspections: ScenarioClaimAdmissionInspections,
): ScenarioClaimAdmissionOwnerGateSummaries {
  return [
    { gate: 'closure', status: inspections.closure.claimClosure },
    { gate: 'authority', status: inspections.authority.authorityCompatibility },
    { gate: 'safety', status: inspections.safety.safetyContract },
    {
      gate: 'authorization',
      status: inspections.authorization.authorizationCompatibility,
    },
    { gate: 'approval', status: inspections.approval.approvalBinding },
    { gate: 'dependencies', status: inspections.dependencies.dependencyContract },
  ];
}

function buildSuccessGateSummaries(): ScenarioClaimAdmissionSuccessGateSummaries {
  return [
    { gate: 'closure', status: 'closed' },
    { gate: 'authority', status: 'compatible' },
    { gate: 'safety', status: 'complete' },
    { gate: 'authorization', status: 'compatible' },
    { gate: 'approval', status: 'bound' },
    { gate: 'dependencies', status: 'complete' },
  ];
}

function collectBlockingGates(
  summaries: ScenarioClaimAdmissionOwnerGateSummaries,
): ScenarioClaimAdmissionOwnerGate[] {
  const blockers: ScenarioClaimAdmissionOwnerGate[] = [];
  for (const summary of summaries) {
    if (!gateSucceeded(summary)) {
      blockers.push(summary.gate);
    }
  }
  return blockers;
}

function gateSucceeded(summary: ScenarioClaimAdmissionGateSummary): boolean {
  switch (summary.gate) {
    case 'schema_and_selection':
      return false;
    case 'closure':
      return summary.status === 'closed';
    case 'authority':
      return summary.status === 'compatible';
    case 'safety':
      return summary.status === 'complete';
    case 'authorization':
      return summary.status === 'compatible';
    case 'approval':
      return summary.status === 'bound';
    case 'dependencies':
      return summary.status === 'complete';
  }
}

function selectNextAction(
  gate: ScenarioClaimAdmissionOwnerGate,
  inspections: ScenarioClaimAdmissionInspections,
): ScenarioClaimAdmissionBlockedNextAction {
  switch (gate) {
    case 'closure':
      return 'resolve_first_blocking_admission_gate';
    case 'authority':
      return inspections.authority.nextAction;
    case 'safety':
      return inspections.safety.nextAction;
    case 'authorization':
      return inspections.authorization.nextAction;
    case 'approval':
      return inspections.approval.nextAction;
    case 'dependencies':
      return inspections.dependencies.nextAction;
  }
}

function outsideContract(
  nextAction: ScenarioClaimAdmissionOutsideNextAction,
  selection?: ScenarioClaimAdmissionSelection,
  scenarioSchemaVersion?: string,
): ScenarioClaimAdmissionOutsideContract {
  return {
    contractVersion: CLAIM_ADMISSION_INSPECTION_VERSION,
    status: 'outside_contract',
    ...(scenarioSchemaVersion === undefined ? {} : { scenarioSchemaVersion }),
    ...(selection === undefined ? {} : { selection }),
    gateSummaries: [{ gate: 'schema_and_selection', status: 'failed' }],
    nextAction,
  };
}

function parseSelection(value: unknown): SelectionParseResult {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['platform', 'variant'])) {
    return { valid: false };
  }
  if (value.platform !== 'ios' && value.platform !== 'android') {
    return { valid: false };
  }
  if (
    value.variant !== undefined &&
    (typeof value.variant !== 'string' || value.variant.trim().length === 0)
  ) {
    return { valid: false };
  }
  return {
    valid: true,
    selection: {
      platform: value.platform,
      ...(value.variant === undefined ? {} : { variant: value.variant }),
    },
  };
}

function readScenarioSchemaVersion(value: unknown): string | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  return typeof value.schemaVersion === 'string' && value.schemaVersion.length > 0
    ? value.schemaVersion
    : undefined;
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

export {
  CLAIM_ADMISSION_INSPECTION_VERSION,
  inspectScenarioClaimAdmission,
};

export type {
  ScenarioClaimAdmissionAdmitted,
  ScenarioClaimAdmissionBlocked,
  ScenarioClaimAdmissionBlockedNextAction,
  ScenarioClaimAdmissionGate,
  ScenarioClaimAdmissionGateSummary,
  ScenarioClaimAdmissionInput,
  ScenarioClaimAdmissionInspection,
  ScenarioClaimAdmissionInspections,
  ScenarioClaimAdmissionOutsideContract,
  ScenarioClaimAdmissionOutsideNextAction,
  ScenarioClaimAdmissionOwnerGate,
  ScenarioClaimAdmissionPlatform,
  ScenarioClaimAdmissionSelection,
};
