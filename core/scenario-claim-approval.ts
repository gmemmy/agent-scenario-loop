const crypto = require('node:crypto');

import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  LEGACY_SCENARIO_SCHEMA_VERSION,
  canonicalizeClaimValue,
} from './claim-contract';
import { SCHEMAS, validateJson } from './schema-validator';

const SCENARIO_CLAIM_APPROVAL_SCHEMA_VERSION = '1.0.0' as const;
const SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION = '1.0.0' as const;

type ScenarioClaimApprovalPlatform = 'ios' | 'android';
type ScenarioClaimApprovalSelection = {
  platform: ScenarioClaimApprovalPlatform;
  variant?: string;
};
type ScenarioClaimApprovalBinding = 'bound' | 'invalidated' | 'outside_contract';
type ScenarioClaimApprovalTrust = 'exact_hash_attestation_only';
type ScenarioClaimApprovalCheckCode =
  | 'scenario_claim_complete_schema'
  | 'selection_platform_declared'
  | 'approval_record_structure'
  | 'scenario_identity'
  | 'scenario_contract_hash'
  | 'selection_binding';
type ScenarioClaimApprovalCheckStatus = 'satisfied' | 'failed' | 'not_evaluated';
type ScenarioClaimApprovalReasonCode =
  | 'legacy_scenario_schema'
  | 'unknown_scenario_schema'
  | 'malformed_scenario'
  | 'undeclared_platform'
  | 'malformed_approval_record'
  | 'scenario_id_mismatch'
  | 'scenario_hash_mismatch'
  | 'selection_platform_mismatch'
  | 'selection_variant_mismatch';
type ScenarioClaimApprovalNextAction =
  | 'supply_claim_complete_scenario'
  | 'declare_selected_platform'
  | 'supply_valid_approval_record'
  | 'reapprove_current_scenario_selection'
  | 'approval_binding_complete';

type ScenarioClaimApprovalRecord = {
  schemaVersion: typeof SCENARIO_CLAIM_APPROVAL_SCHEMA_VERSION;
  approvalId: string;
  scenarioId: string;
  scenarioHash: string;
  selection: ScenarioClaimApprovalSelection;
  decision: 'approved';
  approvedAt: string;
  approverRef: string;
  note?: string;
};

type ScenarioClaimApprovalCheck = {
  code: ScenarioClaimApprovalCheckCode;
  status: ScenarioClaimApprovalCheckStatus;
  reasonCodes: ScenarioClaimApprovalReasonCode[];
};

type ScenarioClaimApprovalBlockingReason = {
  code: ScenarioClaimApprovalReasonCode;
  message: string;
  affectedIds: string[];
};

type ScenarioClaimApprovalInspection = {
  contractVersion: typeof SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION;
  scenarioSchemaVersion?: string;
  platform: ScenarioClaimApprovalPlatform;
  variant?: string;
  approvalBinding: ScenarioClaimApprovalBinding;
  trust: ScenarioClaimApprovalTrust;
  computedScenarioHash?: string;
  approvalId?: string;
  checks: ScenarioClaimApprovalCheck[];
  blockingReasons: ScenarioClaimApprovalBlockingReason[];
  nextAction: ScenarioClaimApprovalNextAction;
};

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  id: string;
  platforms: ScenarioClaimApprovalPlatform[];
};

class ScenarioClaimCompleteContractError extends Error {
  readonly code = 'invalid_scenario_claim_complete_contract' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ScenarioClaimCompleteContractError';
  }
}

function buildScenarioClaimCompleteContractHash(scenario: unknown): string {
  try {
    const canonical = canonicalizeClaimValue(scenario);
    const schemaVersion = readScenarioSchemaVersion(scenario);
    if (schemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
      throw new Error('Claim-complete contract hashing requires scenario schemaVersion 1.1.0.');
    }

    const result = validateJson(scenario, SCHEMAS.scenario, 'Claim-complete scenario');
    if (!result.valid) {
      throw new Error(result.message);
    }

    return crypto.createHash('sha256').update(canonical).digest('hex');
  } catch (error) {
    if (error instanceof ScenarioClaimCompleteContractError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ScenarioClaimCompleteContractError(message);
  }
}

function inspectScenarioClaimApproval(
  scenario: unknown,
  selection: ScenarioClaimApprovalSelection,
  approval: unknown,
): ScenarioClaimApprovalInspection {
  assertSelection(selection);
  const scenarioSchemaVersion = readScenarioSchemaVersion(scenario);
  const base = {
    contractVersion: SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION,
    ...(scenarioSchemaVersion ? { scenarioSchemaVersion } : {}),
    platform: selection.platform,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    trust: 'exact_hash_attestation_only' as const,
  };
  const checks = createChecks();
  const blockingReasons: ScenarioClaimApprovalBlockingReason[] = [];
  const approvalResult = parseApprovalRecord(approval);

  setCheck(
    checks,
    'approval_record_structure',
    approvalResult.valid ? 'satisfied' : 'failed',
    approvalResult.valid ? [] : ['malformed_approval_record'],
  );

  if (scenarioSchemaVersion === LEGACY_SCENARIO_SCHEMA_VERSION) {
    addReason(
      blockingReasons,
      'legacy_scenario_schema',
      'Scenario approval inspection applies only to claim-complete scenario schemaVersion 1.1.0.',
      [LEGACY_SCENARIO_SCHEMA_VERSION],
    );
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', ['legacy_scenario_schema']);
    return outsideContract(base, checks, blockingReasons, approvalResult);
  }

  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    const reasonCode = scenarioSchemaVersion ? 'unknown_scenario_schema' : 'malformed_scenario';
    addReason(
      blockingReasons,
      reasonCode,
      scenarioSchemaVersion
        ? `Scenario schemaVersion ${scenarioSchemaVersion} is outside the claim-complete approval contract.`
        : 'Scenario does not expose a valid schemaVersion.',
      scenarioSchemaVersion ? [scenarioSchemaVersion] : [],
    );
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', [reasonCode]);
    return outsideContract(base, checks, blockingReasons, approvalResult);
  }

  let computedScenarioHash: string;
  try {
    computedScenarioHash = buildScenarioClaimCompleteContractHash(scenario);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addReason(blockingReasons, 'malformed_scenario', message, []);
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', ['malformed_scenario']);
    return outsideContract(base, checks, blockingReasons, approvalResult);
  }

  setCheck(checks, 'scenario_claim_complete_schema', 'satisfied', []);
  const candidate = scenario as ClaimCompleteScenario;
  if (!candidate.platforms.includes(selection.platform)) {
    addReason(
      blockingReasons,
      'undeclared_platform',
      `Scenario does not declare selected platform ${selection.platform}.`,
      [selection.platform],
    );
    setCheck(checks, 'selection_platform_declared', 'failed', ['undeclared_platform']);
    return outsideContract(
      { ...base, computedScenarioHash },
      checks,
      blockingReasons,
      approvalResult,
    );
  }

  setCheck(checks, 'selection_platform_declared', 'satisfied', []);
  if (!approvalResult.valid) {
    addReason(
      blockingReasons,
      'malformed_approval_record',
      approvalResult.message,
      [],
    );
    return outsideContract(
      { ...base, computedScenarioHash },
      checks,
      blockingReasons,
      approvalResult,
    );
  }

  const record = approvalResult.record;
  const identityMatches = record.scenarioId === candidate.id;
  setCheck(
    checks,
    'scenario_identity',
    identityMatches ? 'satisfied' : 'failed',
    identityMatches ? [] : ['scenario_id_mismatch'],
  );
  if (!identityMatches) {
    addReason(
      blockingReasons,
      'scenario_id_mismatch',
      `Approval scenario ${record.scenarioId} does not match scenario ${candidate.id}.`,
      [record.scenarioId, candidate.id],
    );
  }

  const hashMatches = record.scenarioHash === computedScenarioHash;
  setCheck(
    checks,
    'scenario_contract_hash',
    hashMatches ? 'satisfied' : 'failed',
    hashMatches ? [] : ['scenario_hash_mismatch'],
  );
  if (!hashMatches) {
    addReason(
      blockingReasons,
      'scenario_hash_mismatch',
      'Approval hash does not match the complete current scenario contract.',
      [record.scenarioHash, computedScenarioHash],
    );
  }

  const platformMatches = record.selection.platform === selection.platform;
  const variantMatches = record.selection.variant === selection.variant;
  const selectionReasons: ScenarioClaimApprovalReasonCode[] = [];
  if (!platformMatches) {
    selectionReasons.push('selection_platform_mismatch');
    addReason(
      blockingReasons,
      'selection_platform_mismatch',
      `Approval platform ${record.selection.platform} does not match selected platform ${selection.platform}.`,
      [record.selection.platform, selection.platform],
    );
  }
  if (!variantMatches) {
    selectionReasons.push('selection_variant_mismatch');
    addReason(
      blockingReasons,
      'selection_variant_mismatch',
      'Approval variant does not match the exact selected variant.',
      [record.selection.variant ?? '<omitted>', selection.variant ?? '<omitted>'],
    );
  }
  setCheck(
    checks,
    'selection_binding',
    selectionReasons.length === 0 ? 'satisfied' : 'failed',
    selectionReasons,
  );

  return {
    ...base,
    approvalBinding: blockingReasons.length === 0 ? 'bound' : 'invalidated',
    computedScenarioHash,
    approvalId: record.approvalId,
    checks,
    blockingReasons,
    nextAction:
      blockingReasons.length === 0
        ? 'approval_binding_complete'
        : 'reapprove_current_scenario_selection',
  };
}

const CHECK_ORDER: ScenarioClaimApprovalCheckCode[] = [
  'scenario_claim_complete_schema',
  'selection_platform_declared',
  'approval_record_structure',
  'scenario_identity',
  'scenario_contract_hash',
  'selection_binding',
];

function createChecks(): ScenarioClaimApprovalCheck[] {
  return CHECK_ORDER.map((code) => ({ code, status: 'not_evaluated', reasonCodes: [] }));
}

function setCheck(
  checks: ScenarioClaimApprovalCheck[],
  code: ScenarioClaimApprovalCheckCode,
  status: ScenarioClaimApprovalCheckStatus,
  reasonCodes: ScenarioClaimApprovalReasonCode[],
): void {
  const check = checks.find((candidate) => candidate.code === code);
  if (!check) {
    throw new Error(`Unknown scenario claim approval check ${code}.`);
  }
  check.status = status;
  check.reasonCodes = reasonCodes;
}

function addReason(
  reasons: ScenarioClaimApprovalBlockingReason[],
  code: ScenarioClaimApprovalReasonCode,
  message: string,
  affectedIds: string[],
): void {
  reasons.push({ code, message, affectedIds });
}

function outsideContract(
  base: {
    contractVersion: typeof SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION;
    scenarioSchemaVersion?: string;
    platform: ScenarioClaimApprovalPlatform;
    variant?: string;
    trust: ScenarioClaimApprovalTrust;
    computedScenarioHash?: string;
  },
  checks: ScenarioClaimApprovalCheck[],
  blockingReasons: ScenarioClaimApprovalBlockingReason[],
  approvalResult: ApprovalParseResult,
): ScenarioClaimApprovalInspection {
  if (!approvalResult.valid && !blockingReasons.some((reason) => reason.code === 'malformed_approval_record')) {
    addReason(blockingReasons, 'malformed_approval_record', approvalResult.message, []);
  }
  return {
    ...base,
    approvalBinding: 'outside_contract',
    ...(approvalResult.valid ? { approvalId: approvalResult.record.approvalId } : {}),
    checks,
    blockingReasons,
    nextAction: selectOutsideContractNextAction(blockingReasons),
  };
}

function selectOutsideContractNextAction(
  reasons: ScenarioClaimApprovalBlockingReason[],
): ScenarioClaimApprovalNextAction {
  if (reasons.some((reason) => [
    'legacy_scenario_schema',
    'unknown_scenario_schema',
    'malformed_scenario',
  ].includes(reason.code))) {
    return 'supply_claim_complete_scenario';
  }
  if (reasons.some((reason) => reason.code === 'undeclared_platform')) {
    return 'declare_selected_platform';
  }
  return 'supply_valid_approval_record';
}

type ApprovalParseResult =
  | { valid: true; record: ScenarioClaimApprovalRecord }
  | { valid: false; message: string };

function parseApprovalRecord(approval: unknown): ApprovalParseResult {
  try {
    canonicalizeClaimValue(approval);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, message };
  }

  const result = validateJson(
    approval,
    SCHEMAS.scenarioClaimApproval,
    'Scenario claim approval',
  );
  if (!result.valid) {
    return { valid: false, message: result.message };
  }

  const record = approval as ScenarioClaimApprovalRecord;
  if (!Number.isFinite(Date.parse(record.approvedAt))) {
    return { valid: false, message: 'Scenario claim approval approvedAt must be a real date-time.' };
  }

  return { valid: true, record };
}

function assertSelection(selection: ScenarioClaimApprovalSelection): void {
  if (!selection || (selection.platform !== 'ios' && selection.platform !== 'android')) {
    throw new TypeError('Scenario claim approval selection.platform must be ios or android.');
  }
  if (selection.variant !== undefined && (
    typeof selection.variant !== 'string' || selection.variant.length === 0
  )) {
    throw new TypeError('Scenario claim approval selection.variant must be a non-empty string when supplied.');
  }
}

function readScenarioSchemaVersion(scenario: unknown): string | undefined {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return undefined;
  }
  const value = (scenario as Record<string, unknown>).schemaVersion;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export {
  SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION,
  SCENARIO_CLAIM_APPROVAL_SCHEMA_VERSION,
  ScenarioClaimCompleteContractError,
  buildScenarioClaimCompleteContractHash,
  inspectScenarioClaimApproval,
};

export type {
  ScenarioClaimApprovalBinding,
  ScenarioClaimApprovalBlockingReason,
  ScenarioClaimApprovalCheck,
  ScenarioClaimApprovalCheckCode,
  ScenarioClaimApprovalCheckStatus,
  ScenarioClaimApprovalInspection,
  ScenarioClaimApprovalNextAction,
  ScenarioClaimApprovalPlatform,
  ScenarioClaimApprovalReasonCode,
  ScenarioClaimApprovalRecord,
  ScenarioClaimApprovalSelection,
  ScenarioClaimApprovalTrust,
};
