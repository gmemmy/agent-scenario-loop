import {
  CLAIM_CONTRACT_SCHEMA_VERSION,
  LEGACY_SCENARIO_SCHEMA_VERSION,
  canonicalizeClaimValue,
  type ScenarioSafetyClass,
  type ScenarioSafetyDeclaration,
} from './claim-contract';
import { inspectScenarioClaimSafety } from './claim-safety';
import { buildScenarioClaimCompleteContractHash } from './scenario-claim-approval';
import { SCHEMAS, validateJson } from './schema-validator';

const SCENARIO_CLAIM_AUTHORIZATION_GRANT_SCHEMA_VERSION = '1.0.0' as const;
const SCENARIO_CLAIM_AUTHORIZATION_INSPECTION_VERSION = '1.0.0' as const;

type ScenarioClaimAuthorizationPlatform = 'ios' | 'android';
type ScenarioClaimAuthorizationSelection = {
  platform: ScenarioClaimAuthorizationPlatform;
  variant?: string;
};
type ScenarioClaimAuthorizationGrantBase = {
  schemaVersion: typeof SCENARIO_CLAIM_AUTHORIZATION_GRANT_SCHEMA_VERSION;
  grantId: string;
  scenarioId: string;
  scenarioHash: string;
  selection: ScenarioClaimAuthorizationSelection;
  goalId: string;
  operations: [string, ...string[]];
  targetResource: string;
  expiresAt: string;
  delegationChain: [string, ...string[]];
};
type ScenarioClaimAuthorizationGrant =
  | (ScenarioClaimAuthorizationGrantBase & { safetyClass: 'read_only' })
  | (ScenarioClaimAuthorizationGrantBase & {
      safetyClass: Exclude<ScenarioSafetyClass, 'read_only'>;
      mutationIdentityId: string;
    });
type ScenarioClaimAuthorizationRequest = {
  goalId: string;
  operations: readonly string[];
  targetResource: string;
  nowMs: number;
};
type ScenarioClaimAuthorizationCompatibility =
  | 'compatible'
  | 'incompatible'
  | 'outside_contract';
type ScenarioClaimAuthorizationCheckCode =
  | 'scenario_claim_complete_schema'
  | 'selection_platform_declared'
  | 'static_safety_contract'
  | 'authorization_request_structure'
  | 'authorization_grant_structure'
  | 'scenario_identity'
  | 'scenario_contract_hash'
  | 'selection_binding'
  | 'safety_class_binding'
  | 'mutation_identity_binding'
  | 'goal_binding'
  | 'target_resource_binding'
  | 'operation_scope_binding'
  | 'expiry_binding';
type ScenarioClaimAuthorizationCheckStatus = 'satisfied' | 'failed' | 'not_evaluated';
type ScenarioClaimAuthorizationReasonCode =
  | 'legacy_scenario_schema'
  | 'unknown_scenario_schema'
  | 'malformed_scenario'
  | 'malformed_selection'
  | 'undeclared_platform'
  | 'incomplete_safety_contract'
  | 'malformed_authorization_request'
  | 'malformed_authorization_grant'
  | 'credential_field_forbidden'
  | 'scenario_id_mismatch'
  | 'scenario_hash_mismatch'
  | 'selection_platform_mismatch'
  | 'selection_variant_mismatch'
  | 'safety_class_mismatch'
  | 'mutation_identity_mismatch'
  | 'goal_id_mismatch'
  | 'target_resource_mismatch'
  | 'operation_scope_under_scoped'
  | 'operation_scope_over_scoped'
  | 'authorization_expired';
type ScenarioClaimAuthorizationNextAction =
  | 'supply_claim_complete_scenario'
  | 'supply_valid_authorization_selection'
  | 'declare_selected_platform'
  | 'repair_static_safety_contract'
  | 'supply_valid_authorization_request'
  | 'supply_valid_authorization_grant'
  | 'reissue_authorization_for_scenario_identity'
  | 'reissue_authorization_for_selection'
  | 'reissue_authorization_for_safety'
  | 'reissue_authorization_for_mutation_identity'
  | 'reissue_authorization_for_goal'
  | 'reissue_authorization_for_target_resource'
  | 'reissue_authorization_for_exact_operations'
  | 'reissue_unexpired_authorization'
  | 'authorization_inspection_complete';
type ScenarioClaimAuthorizationCheck = {
  code: ScenarioClaimAuthorizationCheckCode;
  status: ScenarioClaimAuthorizationCheckStatus;
  reasonCodes: ScenarioClaimAuthorizationReasonCode[];
};
type ScenarioClaimAuthorizationBlockingReason = {
  code: ScenarioClaimAuthorizationReasonCode;
  message: string;
  affectedIds: string[];
};
type ScenarioClaimAuthorizationInspection = {
  contractVersion: typeof SCENARIO_CLAIM_AUTHORIZATION_INSPECTION_VERSION;
  scenarioSchemaVersion?: string;
  platform?: ScenarioClaimAuthorizationPlatform;
  variant?: string;
  safetyClass?: ScenarioSafetyClass;
  computedScenarioHash?: string;
  grantId?: string;
  authorizationCompatibility: ScenarioClaimAuthorizationCompatibility;
  checks: ScenarioClaimAuthorizationCheck[];
  blockingReasons: ScenarioClaimAuthorizationBlockingReason[];
  nextAction: ScenarioClaimAuthorizationNextAction;
};

const CHECK_ORDER: readonly ScenarioClaimAuthorizationCheckCode[] = [
  'scenario_claim_complete_schema',
  'selection_platform_declared',
  'static_safety_contract',
  'authorization_request_structure',
  'authorization_grant_structure',
  'scenario_identity',
  'scenario_contract_hash',
  'selection_binding',
  'safety_class_binding',
  'mutation_identity_binding',
  'goal_binding',
  'target_resource_binding',
  'operation_scope_binding',
  'expiry_binding',
];

const CREDENTIAL_FIELD_NAMES = new Set([
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'idtoken',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'session',
  'token',
  'accesstoken',
]);

type ClaimCompleteScenario = {
  schemaVersion: typeof CLAIM_CONTRACT_SCHEMA_VERSION;
  id: string;
  platforms: ScenarioClaimAuthorizationPlatform[];
  safety: ScenarioSafetyDeclaration;
};
type ParsedGrant = {
  grant: ScenarioClaimAuthorizationGrant;
  expiresAtMs: number;
};

function inspectScenarioClaimAuthorization(
  scenario: unknown,
  selection: ScenarioClaimAuthorizationSelection,
  request: ScenarioClaimAuthorizationRequest,
  grant: unknown,
): ScenarioClaimAuthorizationInspection {
  const checks = createChecks();
  const blockingReasons: ScenarioClaimAuthorizationBlockingReason[] = [];
  const parsedSelection = parseSelection(selection);
  if (!parsedSelection.valid) {
    setCheck(checks, 'selection_platform_declared', 'failed', ['malformed_selection']);
    addReason(blockingReasons, 'malformed_selection', parsedSelection.message, []);
    return buildInspection({}, checks, blockingReasons);
  }

  const validSelection = parsedSelection.selection;
  const base = {
    platform: validSelection.platform,
    ...(validSelection.variant === undefined ? {} : { variant: validSelection.variant }),
  };
  const scenarioSchemaVersion = readScenarioSchemaVersion(scenario);
  const versionBase = {
    ...base,
    ...(scenarioSchemaVersion === undefined ? {} : { scenarioSchemaVersion }),
  };

  try {
    canonicalizeClaimValue(scenario);
  } catch (error) {
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', ['malformed_scenario']);
    addReason(blockingReasons, 'malformed_scenario', errorMessage(error), []);
    return buildInspection(versionBase, checks, blockingReasons);
  }

  if (scenarioSchemaVersion === LEGACY_SCENARIO_SCHEMA_VERSION) {
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', ['legacy_scenario_schema']);
    addReason(
      blockingReasons,
      'legacy_scenario_schema',
      'Claim authorization inspection applies only to scenario schemaVersion 1.1.0.',
      [LEGACY_SCENARIO_SCHEMA_VERSION],
    );
    return buildInspection(versionBase, checks, blockingReasons);
  }
  if (scenarioSchemaVersion !== CLAIM_CONTRACT_SCHEMA_VERSION) {
    const code = scenarioSchemaVersion === undefined
      ? 'malformed_scenario'
      : 'unknown_scenario_schema';
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', [code]);
    addReason(
      blockingReasons,
      code,
      scenarioSchemaVersion === undefined
        ? 'Scenario does not expose a valid schemaVersion.'
        : `Scenario schemaVersion ${scenarioSchemaVersion} is outside the claim authorization contract.`,
      scenarioSchemaVersion === undefined ? [] : [scenarioSchemaVersion],
    );
    return buildInspection(versionBase, checks, blockingReasons);
  }

  const scenarioResult = validateJson(scenario, SCHEMAS.scenario, 'Claim-complete scenario');
  if (!scenarioResult.valid) {
    setCheck(checks, 'scenario_claim_complete_schema', 'failed', ['malformed_scenario']);
    addReason(blockingReasons, 'malformed_scenario', scenarioResult.message, []);
    return buildInspection(versionBase, checks, blockingReasons);
  }
  setCheck(checks, 'scenario_claim_complete_schema', 'satisfied', []);

  const candidate = scenario as ClaimCompleteScenario;
  const computedScenarioHash = buildScenarioClaimCompleteContractHash(scenario);
  const scenarioBase = { ...versionBase, computedScenarioHash };
  if (!candidate.platforms.includes(validSelection.platform)) {
    setCheck(checks, 'selection_platform_declared', 'failed', ['undeclared_platform']);
    addReason(
      blockingReasons,
      'undeclared_platform',
      `Scenario does not declare selected platform ${validSelection.platform}.`,
      [validSelection.platform],
    );
    return buildInspection(scenarioBase, checks, blockingReasons);
  }
  setCheck(checks, 'selection_platform_declared', 'satisfied', []);

  const safetyInspection = inspectScenarioClaimSafety(candidate, validSelection);
  const safetyBase = {
    ...scenarioBase,
    ...(safetyInspection.safetyClass === undefined
      ? {}
      : { safetyClass: safetyInspection.safetyClass }),
  };
  if (safetyInspection.safetyContract !== 'complete') {
    setCheck(checks, 'static_safety_contract', 'failed', ['incomplete_safety_contract']);
    addReason(
      blockingReasons,
      'incomplete_safety_contract',
      'Scenario static safety contract is not complete for the selected run.',
      safetyInspection.blockingReasons.flatMap((reason) => reason.affectedIds),
    );
    return buildInspection(safetyBase, checks, blockingReasons);
  }
  setCheck(checks, 'static_safety_contract', 'satisfied', []);

  const requestResult = parseRequest(request);
  if (!requestResult.valid) {
    setCheck(
      checks,
      'authorization_request_structure',
      'failed',
      ['malformed_authorization_request'],
    );
    addReason(
      blockingReasons,
      'malformed_authorization_request',
      requestResult.message,
      [],
    );
    return buildInspection(safetyBase, checks, blockingReasons);
  }
  setCheck(checks, 'authorization_request_structure', 'satisfied', []);

  const grantResult = parseGrant(grant);
  if (!grantResult.valid) {
    setCheck(checks, 'authorization_grant_structure', 'failed', [grantResult.code]);
    addReason(blockingReasons, grantResult.code, grantResult.message, []);
    return buildInspection(safetyBase, checks, blockingReasons);
  }
  setCheck(checks, 'authorization_grant_structure', 'satisfied', []);

  const validGrant = grantResult.value.grant;
  const inspectionBase = { ...safetyBase, grantId: validGrant.grantId };
  inspectBinding(
    checks,
    blockingReasons,
    'scenario_identity',
    validGrant.scenarioId === candidate.id,
    'scenario_id_mismatch',
    'Authorization grant scenario ID does not match the current scenario.',
    [validGrant.grantId, candidate.id],
  );
  inspectBinding(
    checks,
    blockingReasons,
    'scenario_contract_hash',
    validGrant.scenarioHash === computedScenarioHash,
    'scenario_hash_mismatch',
    'Authorization grant scenario hash does not match the current scenario contract.',
    [validGrant.grantId, candidate.id],
  );

  const selectionReasons: ScenarioClaimAuthorizationReasonCode[] = [];
  if (validGrant.selection.platform !== validSelection.platform) {
    selectionReasons.push('selection_platform_mismatch');
    addReason(
      blockingReasons,
      'selection_platform_mismatch',
      'Authorization grant platform does not match the selected platform.',
      [validGrant.grantId, validSelection.platform],
    );
  }
  if (validGrant.selection.variant !== validSelection.variant) {
    selectionReasons.push('selection_variant_mismatch');
    addReason(
      blockingReasons,
      'selection_variant_mismatch',
      'Authorization grant variant does not match the selected variant.',
      [validGrant.grantId],
    );
  }
  setCheck(
    checks,
    'selection_binding',
    selectionReasons.length === 0 ? 'satisfied' : 'failed',
    selectionReasons,
  );

  inspectBinding(
    checks,
    blockingReasons,
    'safety_class_binding',
    validGrant.safetyClass === candidate.safety.class,
    'safety_class_mismatch',
    'Authorization grant safety class does not match the scenario safety class.',
    [validGrant.grantId, candidate.safety.class],
  );

  const expectedMutationId = candidate.safety.class === 'read_only'
    ? undefined
    : candidate.safety.mutationIdentity.id;
  const observedMutationId = validGrant.safetyClass === 'read_only'
    ? undefined
    : validGrant.mutationIdentityId;
  inspectBinding(
    checks,
    blockingReasons,
    'mutation_identity_binding',
    observedMutationId === expectedMutationId,
    'mutation_identity_mismatch',
    'Authorization grant mutation identity does not match the scenario mutation identity.',
    [validGrant.grantId, ...(expectedMutationId === undefined ? [] : [expectedMutationId])],
  );
  inspectBinding(
    checks,
    blockingReasons,
    'goal_binding',
    validGrant.goalId === requestResult.value.goalId,
    'goal_id_mismatch',
    'Authorization grant goal does not match the requested goal.',
    [validGrant.grantId, requestResult.value.goalId],
  );
  inspectBinding(
    checks,
    blockingReasons,
    'target_resource_binding',
    validGrant.targetResource === requestResult.value.targetResource,
    'target_resource_mismatch',
    'Authorization grant target resource does not match the requested target resource.',
    [validGrant.grantId, requestResult.value.targetResource],
  );

  const operationReasons = inspectOperationScope(
    candidate.safety.allowedOperations,
    requestResult.value.operations,
    validGrant.operations,
  );
  setCheck(
    checks,
    'operation_scope_binding',
    operationReasons.length === 0 ? 'satisfied' : 'failed',
    operationReasons,
  );
  for (const code of operationReasons) {
    addReason(
      blockingReasons,
      code,
      code === 'operation_scope_under_scoped'
        ? 'Authorization request or grant omits a scenario safety operation.'
        : 'Authorization request or grant exceeds the scenario safety operation set.',
      [validGrant.grantId, candidate.id],
    );
  }

  inspectBinding(
    checks,
    blockingReasons,
    'expiry_binding',
    requestResult.value.nowMs < grantResult.value.expiresAtMs,
    'authorization_expired',
    'Authorization grant is expired at the caller-supplied inspection time.',
    [validGrant.grantId],
  );

  return buildInspection(inspectionBase, checks, blockingReasons);
}

function createChecks(): ScenarioClaimAuthorizationCheck[] {
  return CHECK_ORDER.map((code) => ({ code, status: 'not_evaluated', reasonCodes: [] }));
}

function setCheck(
  checks: ScenarioClaimAuthorizationCheck[],
  code: ScenarioClaimAuthorizationCheckCode,
  status: ScenarioClaimAuthorizationCheckStatus,
  reasonCodes: ScenarioClaimAuthorizationReasonCode[],
): void {
  const check = checks.find((candidate) => candidate.code === code);
  if (!check) {
    throw new Error(`Unknown scenario claim authorization check ${code}.`);
  }
  check.status = status;
  check.reasonCodes = [...new Set(reasonCodes)];
}

function addReason(
  reasons: ScenarioClaimAuthorizationBlockingReason[],
  code: ScenarioClaimAuthorizationReasonCode,
  message: string,
  affectedIds: string[],
): void {
  if (reasons.some((reason) => reason.code === code)) {
    return;
  }
  reasons.push({ code, message, affectedIds: [...new Set(affectedIds)] });
}

function inspectBinding(
  checks: ScenarioClaimAuthorizationCheck[],
  reasons: ScenarioClaimAuthorizationBlockingReason[],
  checkCode: ScenarioClaimAuthorizationCheckCode,
  matches: boolean,
  reasonCode: ScenarioClaimAuthorizationReasonCode,
  message: string,
  affectedIds: string[],
): void {
  setCheck(checks, checkCode, matches ? 'satisfied' : 'failed', matches ? [] : [reasonCode]);
  if (!matches) {
    addReason(reasons, reasonCode, message, affectedIds);
  }
}

function buildInspection(
  base: Omit<
    ScenarioClaimAuthorizationInspection,
    'contractVersion' | 'authorizationCompatibility' | 'checks' | 'blockingReasons' | 'nextAction'
  >,
  checks: ScenarioClaimAuthorizationCheck[],
  blockingReasons: ScenarioClaimAuthorizationBlockingReason[],
): ScenarioClaimAuthorizationInspection {
  const hasOutsideContractFailure = checks
    .slice(0, 5)
    .some((check) => check.status === 'failed');
  const hasFailure = checks.some((check) => check.status === 'failed');
  const allSatisfied = checks.every((check) => check.status === 'satisfied');
  let authorizationCompatibility: ScenarioClaimAuthorizationCompatibility = 'outside_contract';
  if (!hasOutsideContractFailure && hasFailure) {
    authorizationCompatibility = 'incompatible';
  } else if (allSatisfied && blockingReasons.length === 0) {
    authorizationCompatibility = 'compatible';
  }
  return {
    contractVersion: SCENARIO_CLAIM_AUTHORIZATION_INSPECTION_VERSION,
    ...base,
    authorizationCompatibility,
    checks,
    blockingReasons,
    nextAction: selectNextAction(blockingReasons),
  };
}

function selectNextAction(
  reasons: ScenarioClaimAuthorizationBlockingReason[],
): ScenarioClaimAuthorizationNextAction {
  const codes = new Set(reasons.map((reason) => reason.code));
  const mappings: Array<[
    readonly ScenarioClaimAuthorizationReasonCode[],
    ScenarioClaimAuthorizationNextAction,
  ]> = [
    [['legacy_scenario_schema', 'unknown_scenario_schema', 'malformed_scenario'], 'supply_claim_complete_scenario'],
    [['malformed_selection'], 'supply_valid_authorization_selection'],
    [['undeclared_platform'], 'declare_selected_platform'],
    [['incomplete_safety_contract'], 'repair_static_safety_contract'],
    [['malformed_authorization_request'], 'supply_valid_authorization_request'],
    [['malformed_authorization_grant', 'credential_field_forbidden'], 'supply_valid_authorization_grant'],
    [['scenario_id_mismatch', 'scenario_hash_mismatch'], 'reissue_authorization_for_scenario_identity'],
    [['selection_platform_mismatch', 'selection_variant_mismatch'], 'reissue_authorization_for_selection'],
    [['safety_class_mismatch'], 'reissue_authorization_for_safety'],
    [['mutation_identity_mismatch'], 'reissue_authorization_for_mutation_identity'],
    [['goal_id_mismatch'], 'reissue_authorization_for_goal'],
    [['target_resource_mismatch'], 'reissue_authorization_for_target_resource'],
    [['operation_scope_under_scoped', 'operation_scope_over_scoped'], 'reissue_authorization_for_exact_operations'],
    [['authorization_expired'], 'reissue_unexpired_authorization'],
  ];
  for (const [reasonCodes, action] of mappings) {
    if (reasonCodes.some((code) => codes.has(code))) {
      return action;
    }
  }
  return 'authorization_inspection_complete';
}

type SelectionParseResult =
  | { valid: true; selection: ScenarioClaimAuthorizationSelection }
  | { valid: false; message: string };

function parseSelection(selection: unknown): SelectionParseResult {
  try {
    canonicalizeClaimValue(selection);
  } catch (error) {
    return { valid: false, message: errorMessage(error) };
  }
  if (!isPlainRecord(selection) || !hasOnlyKeys(selection, ['platform', 'variant'])) {
    return { valid: false, message: 'Authorization selection must be a closed plain object.' };
  }
  if (selection.platform !== 'ios' && selection.platform !== 'android') {
    return { valid: false, message: 'Authorization selection.platform must be ios or android.' };
  }
  if (selection.variant !== undefined && !isNonBlankString(selection.variant)) {
    return { valid: false, message: 'Authorization selection.variant must be non-blank when supplied.' };
  }
  return {
    valid: true,
    selection: {
      platform: selection.platform,
      ...(selection.variant === undefined ? {} : { variant: selection.variant }),
    },
  };
}

type RequestParseResult =
  | { valid: true; value: ScenarioClaimAuthorizationRequest }
  | { valid: false; message: string };

function parseRequest(request: unknown): RequestParseResult {
  try {
    canonicalizeClaimValue(request);
  } catch (error) {
    return { valid: false, message: errorMessage(error) };
  }
  if (!isPlainRecord(request) || !hasOnlyKeys(request, ['goalId', 'operations', 'targetResource', 'nowMs'])) {
    return { valid: false, message: 'Authorization request must be a closed plain object.' };
  }
  if (!isNonBlankString(request.goalId) || !isNonBlankString(request.targetResource)) {
    return { valid: false, message: 'Authorization request goalId and targetResource must be non-blank.' };
  }
  if (!isUniqueNonBlankStrings(request.operations) || !Number.isFinite(request.nowMs)) {
    return { valid: false, message: 'Authorization request operations and nowMs are malformed.' };
  }
  return {
    valid: true,
    value: {
      goalId: request.goalId,
      operations: [...request.operations],
      targetResource: request.targetResource,
      nowMs: request.nowMs as number,
    },
  };
}

type GrantParseResult =
  | { valid: true; value: ParsedGrant }
  | {
      valid: false;
      code: 'malformed_authorization_grant' | 'credential_field_forbidden';
      message: string;
    };

function parseGrant(grant: unknown): GrantParseResult {
  try {
    canonicalizeClaimValue(grant);
  } catch (error) {
    return {
      valid: false,
      code: 'malformed_authorization_grant',
      message: errorMessage(error),
    };
  }
  if (containsCredentialField(grant)) {
    return {
      valid: false,
      code: 'credential_field_forbidden',
      message: 'Authorization grants must not contain credential fields.',
    };
  }
  const result = validateJson(
    grant,
    SCHEMAS.scenarioClaimAuthorizationGrant,
    'Scenario claim authorization grant',
  );
  if (!result.valid) {
    return { valid: false, code: 'malformed_authorization_grant', message: result.message };
  }
  const candidate = grant as ScenarioClaimAuthorizationGrant;
  const expiresAtMs = parseUtcInstant(candidate.expiresAt);
  if (expiresAtMs === null) {
    return {
      valid: false,
      code: 'malformed_authorization_grant',
      message: 'Authorization grant expiresAt must be a real UTC date-time.',
    };
  }
  return { valid: true, value: { grant: candidate, expiresAtMs } };
}

function parseUtcInstant(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) {
    return null;
  }
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  const hourText = match[4];
  const minuteText = match[5];
  const secondText = match[6];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    return null;
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millisecond
  ) {
    return null;
  }
  return date.getTime();
}

function inspectOperationScope(
  scenarioOperations: readonly string[],
  requestedOperations: readonly string[],
  grantedOperations: readonly string[],
): ScenarioClaimAuthorizationReasonCode[] {
  const scenario = new Set(scenarioOperations);
  const requested = new Set(requestedOperations);
  const granted = new Set(grantedOperations);
  const underScoped = [...scenario].some((operation) =>
    !requested.has(operation) || !granted.has(operation));
  const overScoped = [...requested, ...granted].some((operation) => !scenario.has(operation));
  return [
    ...(underScoped ? ['operation_scope_under_scoped' as const] : []),
    ...(overScoped ? ['operation_scope_over_scoped' as const] : []),
  ];
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsCredentialField(entry));
  }
  if (!isPlainRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, entry]) => {
    const normalized = key.replace(/[_-]/gu, '').toLowerCase();
    return CREDENTIAL_FIELD_NAMES.has(normalized) || containsCredentialField(entry);
  });
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

function isUniqueNonBlankStrings(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonBlankString) &&
    new Set(value).size === value.length;
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
  SCENARIO_CLAIM_AUTHORIZATION_GRANT_SCHEMA_VERSION,
  SCENARIO_CLAIM_AUTHORIZATION_INSPECTION_VERSION,
  inspectScenarioClaimAuthorization,
};

export type {
  ScenarioClaimAuthorizationBlockingReason,
  ScenarioClaimAuthorizationCheck,
  ScenarioClaimAuthorizationCheckCode,
  ScenarioClaimAuthorizationCheckStatus,
  ScenarioClaimAuthorizationCompatibility,
  ScenarioClaimAuthorizationGrant,
  ScenarioClaimAuthorizationGrantBase,
  ScenarioClaimAuthorizationInspection,
  ScenarioClaimAuthorizationNextAction,
  ScenarioClaimAuthorizationPlatform,
  ScenarioClaimAuthorizationReasonCode,
  ScenarioClaimAuthorizationRequest,
  ScenarioClaimAuthorizationSelection,
};
