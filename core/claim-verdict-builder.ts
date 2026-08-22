import { types as nodeTypes } from "node:util";
import {
  buildScenarioClaimHash,
  type ClaimAssertionResult,
  type ClaimResult,
  type ScenarioClaimDefinition,
} from "./claim-contract";
import {
  inspectScenarioClaimVerdictReduction,
  type ClaimVerdictReductionPlatform,
} from "./claim-verdict-reduction";
import {
  reduceMandatoryJourneyStatus,
  type ClaimReductionHealthStatus,
} from "./claim-reduction-policy";
import { SCHEMAS, validateJson } from "./schema-validator";

export type ArtifactHealthStatus = "passed" | "failed" | "partial";

export interface PreRuntimeClaimSelection {
  platform: ClaimVerdictReductionPlatform;
  variant?: string;
  applicableClaimIds: readonly string[];
  excludedClaimIds: readonly string[];
}

export interface ClaimCompleteVerdictInput {
  scenario: Record<string, unknown>;
  runId: string;
  healthStatus: ClaimReductionHealthStatus;
  selection: PreRuntimeClaimSelection;
  claimResults: readonly ClaimResult[];
}

export interface ClaimCompleteVerdictCandidate {
  schemaVersion: "1.1.0";
  runId: string;
  scenarioId: string;
  verdictStatus: "passed" | "failed" | "inconclusive";
  healthStatus: ArtifactHealthStatus;
  claimResults: readonly ClaimResult[];
}

const INPUT_KEYS = ["scenario", "runId", "healthStatus", "selection", "claimResults"] as const;
const SELECTION_REQUIRED_KEYS = ["platform", "applicableClaimIds", "excludedClaimIds"] as const;
const SELECTION_OPTIONAL_KEYS = ["variant"] as const;
const CLAIM_RESULT_KEYS = [
  "claimId",
  "claimHash",
  "role",
  "status",
  "reasonCode",
  "assertionResults",
  "evidenceReferences",
  "missingProof",
  "nextActionOwner",
  "nextAction",
] as const;

function ownKeys(value: object): Array<string | symbol> {
  return Reflect.ownKeys(value);
}

function assertNoProxy(value: unknown, label: string): void {
  if (value !== null && (typeof value === "object" || typeof value === "function") && nodeTypes.isProxy(value)) {
    throw new Error(`${label} must not be a Proxy`);
  }
}

function isPlainArray(value: object): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

function assertEnumerableDataProperties(value: object, label: string): void {
  const array = isPlainArray(value);
  for (const key of ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new Error(`${label} must not have symbol keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new Error(`${label} is missing a property descriptor`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`${label} must not have accessor properties`);
    }
    if (array && key === "length") {
      continue;
    }
    if (!descriptor.enumerable) {
      throw new Error(`${label} must expose only enumerable data properties`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  assertNoProxy(value, label);
  if (!isPlainRecord(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  assertEnumerableDataProperties(value, label);
  return value;
}

function requireExactOwnKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`${label} must not have symbol keys`);
  }
  const stringKeys = keys.filter((key): key is string => typeof key === "string").sort();
  const expected = [...allowed].sort();
  if (stringKeys.length !== expected.length || stringKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected own keys`);
  }
}

function requireExactOwnKeySet(value: object, required: readonly string[], optional: readonly string[], label: string): void {
  const keys = ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`${label} must not have symbol keys`);
  }
  const stringKeys = new Set(keys.filter((key): key is string => typeof key === "string"));
  for (const key of required) {
    if (!stringKeys.has(key)) {
      throw new Error(`${label} is missing required key ${key}`);
    }
  }
  for (const key of stringKeys) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${label} has unexpected own keys`);
    }
  }
}

function requirePlainIndexCompleteArray(value: unknown, label: string): unknown[] {
  assertNoProxy(value, label);
  if (!Array.isArray(value) || !isPlainArray(value)) {
    throw new Error(`${label} must be a plain array`);
  }
  assertEnumerableDataProperties(value, label);
  const length = value.length;
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) {
    allowed.add(String(index));
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error(`${label} must not be sparse`);
    }
  }
  for (const key of ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new Error(`${label} must not have symbol keys`);
    }
    if (!allowed.has(key)) {
      throw new Error(`${label} has unexpected own keys`);
    }
  }
  return value;
}

function clonePlain(value: unknown, label: string): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  assertNoProxy(value, label);
  if (Array.isArray(value)) {
    const array = requirePlainIndexCompleteArray(value, label);
    const cloned: unknown[] = [];
    for (let index = 0; index < array.length; index += 1) {
      cloned[index] = clonePlain(array[index], `${label}[${index}]`);
    }
    return cloned;
  }
  const record = requirePlainRecord(value, label);
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    cloned[key] = clonePlain(record[key], `${label}.${key}`);
  }
  return cloned;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    if (Array.isArray(value)) {
      for (const nested of value) {
        freezeDeep(nested);
      }
    } else {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        freezeDeep(nested);
      }
    }
  }
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  const array = requirePlainIndexCompleteArray(value, label);
  const strings: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    strings[index] = requireNonemptyString(array[index], `${label}[${index}]`);
  }
  return strings;
}

type ShippedAssertionKind =
  | "eventOccurrence"
  | "eventOrder"
  | "terminalState"
  | "boundedCount"
  | "absence"
  | "validatedEvidence";

function requireShippedAssertionKind(value: unknown, label: string): ShippedAssertionKind {
  switch (value) {
    case "eventOccurrence":
    case "eventOrder":
    case "terminalState":
    case "boundedCount":
    case "absence":
    case "validatedEvidence":
      return value;
    default:
      throw new TypeError(`${label} has unexpected assertion kind: ${String(value)}`);
  }
}

function requireClaimVerdictReductionPlatform(value: string): ClaimVerdictReductionPlatform {
  if (value === "ios" || value === "android") {
    return value;
  }
  throw new Error("selection.platform must be ios or android");
}

function requireHealthStatus(value: unknown): ClaimReductionHealthStatus {
  if (value === "passed" || value === "failed" || value === "partial") {
    return value;
  }
  throw new Error("healthStatus must be passed, failed, or partial");
}

function stringInventory(value: unknown, label: string): string[] {
  const array = requirePlainIndexCompleteArray(value, label);
  const strings: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    strings[index] = String(array[index]);
  }
  return strings;
}

function claimPlatforms(claim: Record<string, unknown>): string[] {
  const applicability = isPlainRecord(claim.applicability) ? claim.applicability : undefined;
  if (!applicability || !Array.isArray(applicability.platforms)) {
    return [];
  }
  return stringInventory(applicability.platforms, "claim.applicability.platforms");
}

function claimVariants(claim: Record<string, unknown>): string[] {
  const applicability = isPlainRecord(claim.applicability) ? claim.applicability : undefined;
  if (!applicability || !Array.isArray(applicability.variants)) {
    return [];
  }
  return stringInventory(applicability.variants, "claim.applicability.variants");
}

function claimApplies(claim: Record<string, unknown>, selection: PreRuntimeClaimSelection): boolean {
  const platforms = claimPlatforms(claim);
  if (!platforms.includes(selection.platform)) {
    return false;
  }
  const variants = claimVariants(claim);
  if (variants.length === 0) {
    return true;
  }
  return selection.variant !== undefined && variants.includes(selection.variant);
}

function requireAuthoredClaims(scenario: Record<string, unknown>): Record<string, unknown>[] {
  const claims = requirePlainIndexCompleteArray(scenario.claims, "scenario.claims");
  if (claims.length === 0) {
    throw new Error("scenario.claims must not be empty");
  }
  const records: Record<string, unknown>[] = [];
  for (let index = 0; index < claims.length; index += 1) {
    records[index] = requirePlainRecord(claims[index], `scenario.claims[${index}]`);
  }
  return records;
}

function authoredApplicability(scenario: Record<string, unknown>, selection: PreRuntimeClaimSelection) {
  const claims = requireAuthoredClaims(scenario);
  const applicable: string[] = [];
  const excluded: string[] = [];
  for (let index = 0; index < claims.length; index += 1) {
    const record = claims[index];
    if (!record) {
      throw new Error(`scenario.claims[${index}] is missing`);
    }
    const id = requireNonemptyString(record.id, "claim.id");
    if (claimApplies(record, selection)) {
      applicable.push(id);
    } else {
      excluded.push(id);
    }
  }
  return { applicable, excluded };
}

function assertSelectionMatchesAuthored(
  authored: { applicable: string[]; excluded: string[] },
  selection: PreRuntimeClaimSelection,
): void {
  if (selection.applicableClaimIds.join("\0") !== authored.applicable.join("\0")) {
    throw new Error("selection applicableClaimIds do not match authored applicability");
  }
  if (selection.excludedClaimIds.join("\0") !== authored.excluded.join("\0")) {
    throw new Error("selection excludedClaimIds do not match authored applicability");
  }
}

function requireClaimResultRecord(value: unknown, label: string): ClaimResult {
  const record = requirePlainRecord(value, label);
  requireExactOwnKeys(record, CLAIM_RESULT_KEYS, label);
  const assertionResults = requirePlainIndexCompleteArray(record.assertionResults, `${label}.assertionResults`);
  if (assertionResults.length === 0) {
    throw new Error(`${label}.assertionResults must not be empty`);
  }
  for (let index = 0; index < assertionResults.length; index += 1) {
    const assertion = requirePlainRecord(assertionResults[index], `${label}.assertionResults[${index}]`);
    requireShippedAssertionKind(assertion.assertionKind, `${label}.assertionResults[${index}]`);
  }
  return clonePlain(record, label) as ClaimResult;
}

function indexResults(results: unknown, label: string): Map<string, ClaimResult> {
  const array = requirePlainIndexCompleteArray(results, label);
  const index = new Map<string, ClaimResult>();
  for (let offset = 0; offset < array.length; offset += 1) {
    const cloned = requireClaimResultRecord(array[offset], `${label}[${offset}]`);
    const id = requireNonemptyString(cloned.claimId, "claimResult.claimId");
    if (index.has(id)) {
      throw new Error(`duplicate claim result id: ${id}`);
    }
    if (cloned.assertionResults.length === 0) {
      throw new Error(`claim ${id} is missing assertion inventory`);
    }
    index.set(id, cloned);
  }
  return index;
}

function authoredClaimDefinition(claim: Record<string, unknown>): ScenarioClaimDefinition {
  return claim as ScenarioClaimDefinition;
}

function orderedApplicableResults(
  scenario: Record<string, unknown>,
  selection: PreRuntimeClaimSelection,
  results: readonly ClaimResult[],
): ClaimResult[] {
  const authored = authoredApplicability(scenario, selection);
  assertSelectionMatchesAuthored(authored, selection);
  const byId = indexResults(results, "claimResults");
  const claims = requireAuthoredClaims(scenario);
  const claimById = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (!claim) {
      throw new Error(`scenario.claims[${index}] is missing`);
    }
    claimById.set(requireNonemptyString(claim.id, "claim.id"), claim);
  }
  const ordered: ClaimResult[] = [];
  for (const id of authored.applicable) {
    const result = byId.get(id);
    if (!result) {
      throw new Error(`missing claim result for applicable claim ${id}`);
    }
    if (result.assertionResults.length === 0) {
      throw new Error(`claim ${id} is missing assertion inventory`);
    }
    const authoredClaim = claimById.get(id);
    if (!authoredClaim) {
      throw new Error(`missing authored claim ${id}`);
    }
    const definition = authoredClaimDefinition(authoredClaim);
    if (definition.role !== result.role) {
      throw new Error(`role mismatch for claim ${id}`);
    }
    if (buildScenarioClaimHash(definition) !== result.claimHash) {
      throw new Error(`hash mismatch for claim ${id}`);
    }
    if (result.claimId !== id) {
      throw new Error(`wrong claim id on result for ${id}`);
    }
    ordered.push(result);
    byId.delete(id);
  }
  for (const leftover of byId.keys()) {
    if (authored.excluded.includes(leftover)) {
      throw new Error(`result supplied for excluded claim ${leftover}`);
    }
    throw new Error(`foreign claim result ${leftover}`);
  }
  return ordered;
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected assertion kind: ${String(value)}`);
}

function healthGatedAssertionResult(assertion: ClaimAssertionResult): ClaimAssertionResult {
  const kind = requireShippedAssertionKind(assertion.assertionKind, "assertionResult");
  switch (kind) {
    case "eventOccurrence":
    case "eventOrder":
    case "terminalState":
    case "boundedCount":
    case "absence":
    case "validatedEvidence":
      return {
        assertionId: assertion.assertionId,
        assertionKind: kind,
        status: "not_evaluable",
        reasonCode: "health_gate_failed",
        expected: assertion.expected,
        observed: null,
        evidenceReferences: [],
        rejectedEvidence: [],
        missingProof: ["health_gate_failed"],
      } as ClaimAssertionResult;
    default:
      return assertNever(kind);
  }
}

function healthGatedClaimResult(result: ClaimResult): ClaimResult {
  const first = result.assertionResults[0];
  if (!first) {
    throw new Error(`claim ${result.claimId} is missing assertion inventory`);
  }
  const assertionResults: ClaimResult["assertionResults"] = [healthGatedAssertionResult(first)];
  for (let index = 1; index < result.assertionResults.length; index += 1) {
    const assertion = result.assertionResults[index];
    if (!assertion) {
      throw new Error(`claim ${result.claimId} is missing assertion inventory`);
    }
    assertionResults[index] = healthGatedAssertionResult(assertion);
  }
  return {
    claimId: result.claimId,
    claimHash: result.claimHash,
    role: result.role,
    status: "not_evaluable",
    reasonCode: "health_gate_failed",
    assertionResults,
    evidenceReferences: [],
    missingProof: assertionResults.flatMap((assertion) => assertion.missingProof),
    nextActionOwner: "unresolved",
    nextAction: "Restore trusted scenario health before reducing claims.",
  };
}

function applyHealthGateToResults(
  healthStatus: ClaimReductionHealthStatus,
  results: readonly ClaimResult[],
): ClaimResult[] {
  const next: ClaimResult[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (!result) {
      throw new Error(`claimResults[${index}] is missing`);
    }
    if (healthStatus === "passed") {
      next[index] = result;
    } else {
      next[index] = healthGatedClaimResult(result);
    }
  }
  return next;
}

function parseSelection(value: unknown): PreRuntimeClaimSelection {
  const record = requirePlainRecord(value, "selection");
  requireExactOwnKeySet(record, SELECTION_REQUIRED_KEYS, SELECTION_OPTIONAL_KEYS, "selection");
  const platform = requireClaimVerdictReductionPlatform(
    requireNonemptyString(record.platform, "selection.platform"),
  );
  const applicableClaimIds = requireStringArray(record.applicableClaimIds, "selection.applicableClaimIds");
  const excludedClaimIds = requireStringArray(record.excludedClaimIds, "selection.excludedClaimIds");
  const selection: PreRuntimeClaimSelection = {
    platform,
    applicableClaimIds,
    excludedClaimIds,
  };
  if (record.variant !== undefined) {
    selection.variant = requireNonemptyString(record.variant, "selection.variant");
  }
  return selection;
}

function reductionSelectionFromInput(selection: PreRuntimeClaimSelection): {
  platform: ClaimVerdictReductionPlatform;
  variant?: string;
} {
  const reductionSelection: {
    platform: ClaimVerdictReductionPlatform;
    variant?: string;
  } = { platform: selection.platform };
  if (selection.variant !== undefined) {
    reductionSelection.variant = selection.variant;
  }
  return reductionSelection;
}

export function buildClaimCompleteVerdict(input: ClaimCompleteVerdictInput): ClaimCompleteVerdictCandidate {
  const record = requirePlainRecord(input, "input");
  requireExactOwnKeys(record, INPUT_KEYS, "input");
  const scenario = requirePlainRecord(record.scenario, "scenario");
  if (scenario.schemaVersion !== "1.1.0") {
    throw new Error('scenario.schemaVersion must be exactly "1.1.0"');
  }
  const runId = requireNonemptyString(record.runId, "runId");
  const healthStatus = requireHealthStatus(record.healthStatus);
  const selection = parseSelection(record.selection);
  const scenarioId = requireNonemptyString(scenario.id, "scenario.id");
  const orderedResults = orderedApplicableResults(scenario, selection, record.claimResults as readonly ClaimResult[]);
  const claimResults = applyHealthGateToResults(healthStatus, orderedResults);
  const mandatory = claimResults.filter((result) => result.role === "mandatory");
  if (mandatory.length === 0) {
    throw new Error("mandatory applicable inventory is empty");
  }
  let verdictStatus: "passed" | "failed" | "inconclusive";
  if (healthStatus === "failed" || healthStatus === "partial") {
    verdictStatus = "inconclusive";
  } else {
    const reduced = reduceMandatoryJourneyStatus(mandatory.map((result) => result.status));
    if (reduced === "missing_inventory") {
      throw new Error("mandatory applicable inventory is empty");
    }
    verdictStatus = reduced;
  }
  const candidate: ClaimCompleteVerdictCandidate = {
    schemaVersion: "1.1.0",
    runId,
    scenarioId,
    verdictStatus,
    healthStatus,
    claimResults,
  };
  const validation = validateJson(candidate, SCHEMAS.verdict, "claim-complete verdict");
  if (!validation.valid) {
    throw new Error(validation.message);
  }
  const inspection = inspectScenarioClaimVerdictReduction(
    scenario,
    reductionSelectionFromInput(selection),
    candidate,
  );
  if (inspection.reductionStatus !== "reduced") {
    throw new Error("verdict reduction inspector did not accept output as reduced");
  }
  return freezeDeep(clonePlain(candidate, "verdict") as ClaimCompleteVerdictCandidate);
}

export type { ClaimResult };
