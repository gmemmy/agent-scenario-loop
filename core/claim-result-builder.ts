import { types as nodeTypes } from "node:util";

import { buildScenarioClaimHash } from "./claim-contract.js";
import type {
  ClaimAssertionResult,
  ClaimEvidenceReference,
  ClaimNextActionOwner,
  ClaimReasonCode,
  ClaimResult,
  ClaimRole,
  NotEvaluableReasonCode,
  ScenarioClaimDefinition,
} from "./claim-contract.js";
import { reduceClaimStatus } from "./claim-reduction-policy.js";
import type { ClaimReductionHealthStatus } from "./claim-reduction-policy.js";
import type { ClaimAssertionResultSetInspection } from "./claim-assertion-result-set.js";

export type ClaimResultBuilderInspection =
  | {
      readonly status: "complete";
      readonly result: ClaimResult;
    }
  | {
      readonly status: "incoherent";
      readonly reasons: readonly string[];
    }
  | {
      readonly status: "outside_contract";
      readonly reasons: readonly string[];
    };

const HEALTH_STATUSES: readonly ClaimReductionHealthStatus[] = ["passed", "failed", "partial"];
const CLAIM_ROLES: readonly ClaimRole[] = ["mandatory", "supplemental"];
const OWN_PROPERTY = Object.prototype.hasOwnProperty;
const STABLE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const HEALTH_GATE_MISSING_PROOF_PREFIX = "Trusted scenario health is required before evaluating assertion ";

function ownKeys(value: object): string[] {
  return Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
}

function hasOwn(value: object, key: string): boolean {
  return OWN_PROPERTY.call(value, key);
}

function hasOnlyEnumerableDataProperties(value: object): boolean {
  if (nodeTypes.isProxy(value)) {
    return false;
  }
  const isArray = Array.isArray(value);
  for (const key of Reflect.ownKeys(value)) {
    if (isArray && key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return false;
    }
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return hasOnlyEnumerableDataProperties(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isHealthStatus(value: unknown): value is ClaimReductionHealthStatus {
  return HEALTH_STATUSES.some((status) => status === value);
}

function isClaimRole(value: unknown): value is ClaimRole {
  return CLAIM_ROLES.some((role) => role === value);
}

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeDeep(item);
    }
    Object.freeze(value);
    return;
  }
  if (!isPlainRecord(value)) {
    Object.freeze(value);
    return;
  }
  for (const key of ownKeys(value)) {
    freezeDeep(value[key]);
  }
  Object.freeze(value);
}

function clonePlain(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("non-finite number");
    }
    return value;
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError("proxy");
  }
  if (Array.isArray(value)) {
    if (!hasOnlyEnumerableDataProperties(value)) {
      throw new TypeError("array accessors");
    }
    return value.map((item) => clonePlain(item));
  }
  if (!isPlainRecord(value)) {
    throw new TypeError("spoofed object");
  }
  const clone: Record<string, unknown> = {};
  for (const key of ownKeys(value)) {
    clone[key] = clonePlain(value[key]);
  }
  return clone;
}

function evidenceReferenceKey(reference: ClaimEvidenceReference): string {
  const pathJson = JSON.stringify(reference.path);
  if (hasOwn(reference, "sha256")) {
    return `path:${pathJson}|sha256:${JSON.stringify(reference.sha256 as string)}`;
  }
  return `path:${pathJson}`;
}

function cloneEvidenceReference(reference: ClaimEvidenceReference): ClaimEvidenceReference {
  const cloned: ClaimEvidenceReference = { path: reference.path };
  if (hasOwn(reference, "sha256") && reference.sha256 !== undefined) {
    cloned.sha256 = reference.sha256;
  }
  return cloned;
}

function unionEvidenceReferences(results: readonly ClaimAssertionResult[]): ClaimEvidenceReference[] {
  const seen = new Set<string>();
  const union: ClaimEvidenceReference[] = [];
  for (const result of results) {
    for (const reference of result.evidenceReferences) {
      const key = evidenceReferenceKey(reference);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      union.push(cloneEvidenceReference(reference));
    }
  }
  return union;
}

function unionMissingProof(results: readonly ClaimAssertionResult[]): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const result of results) {
    for (const message of result.missingProof) {
      if (seen.has(message)) {
        continue;
      }
      seen.add(message);
      union.push(message);
    }
  }
  return union;
}

function cloneAssertionResult(result: ClaimAssertionResult): ClaimAssertionResult {
  return clonePlain(result) as ClaimAssertionResult;
}

function healthGateMissingProof(assertionId: string): [string, ...string[]] {
  return [`${HEALTH_GATE_MISSING_PROOF_PREFIX}${assertionId}.`];
}

function projectHealthGatedAssertion(result: ClaimAssertionResult): ClaimAssertionResult {
  const projected = {
    assertionId: result.assertionId,
    assertionKind: result.assertionKind,
    status: "not_evaluable" as const,
    reasonCode: "health_gate_failed" as const,
    expected: clonePlain(result.expected),
    observed: null,
    evidenceReferences: result.evidenceReferences.map(cloneEvidenceReference),
    rejectedEvidence: [...result.rejectedEvidence],
    missingProof: healthGateMissingProof(result.assertionId),
  };
  return projected as ClaimAssertionResult;
}

function nextActionFor(
  status: ClaimResult["status"],
  reasonCode: ClaimReasonCode,
  claimId: string,
): { nextActionOwner: ClaimNextActionOwner; nextAction: string } {
  if (status === "supported") {
    return {
      nextActionOwner: "product_optimization",
      nextAction: `Retain trusted evidence for claim ${claimId}.`,
    };
  }
  if (status === "rejected") {
    return {
      nextActionOwner: "app_truth",
      nextAction: `Inspect rejected authoritative evidence for claim ${claimId}.`,
    };
  }
  if (reasonCode === "health_gate_failed") {
    return {
      nextActionOwner: "runtime_environment",
      nextAction: `Restore trusted scenario health before evaluating claim ${claimId}.`,
    };
  }
  return {
    nextActionOwner: "unresolved",
    nextAction: `Resolve missing or insufficient authoritative evidence for claim ${claimId}.`,
  };
}

function firstNotEvaluableReason(results: readonly ClaimAssertionResult[]): NotEvaluableReasonCode {
  for (const result of results) {
    if (result.status === "not_evaluable") {
      return result.reasonCode;
    }
  }
  return "missing_authoritative_evidence";
}

function inspectInputKeysMatch(value: object): boolean {
  const keys = ownKeys(value).sort();
  return keys.join(",") === "claim,healthStatus,resultSet";
}

function freezeInspection(inspection: ClaimResultBuilderInspection): ClaimResultBuilderInspection {
  freezeDeep(inspection);
  return inspection;
}

function outsideContract(reasons: readonly string[]): ClaimResultBuilderInspection {
  return freezeInspection({
    status: "outside_contract",
    reasons: Object.freeze([...reasons]),
  });
}

function incoherent(reasons: readonly string[]): ClaimResultBuilderInspection {
  return freezeInspection({
    status: "incoherent",
    reasons: Object.freeze([...reasons]),
  });
}

function isCompleteResultSet(
  value: unknown,
): value is Extract<ClaimAssertionResultSetInspection, { status: "complete" }> {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (keys.join(",") !== "candidates,claimHash,claimId,results,status") {
    return false;
  }
  return (
    value.status === "complete" &&
    isStableId(value.claimId) &&
    isSha256Hex(value.claimHash) &&
    Array.isArray(value.results) &&
    value.results.length > 0 &&
    Array.isArray(value.candidates)
  );
}

function isScenarioClaimLike(value: unknown): value is ScenarioClaimDefinition {
  if (!isPlainRecord(value)) {
    return false;
  }
  return isStableId(value.id) && isClaimRole(value.role) && Array.isArray(value.assertions);
}

/**
 * Builds one detached ClaimResult from an exact authored claim, trusted health,
 * and a complete B1 assertion-result set inspection.
 */
export function buildClaimResult(input: {
  readonly claim: ScenarioClaimDefinition;
  readonly healthStatus: ClaimReductionHealthStatus;
  readonly resultSet: ClaimAssertionResultSetInspection;
}): ClaimResultBuilderInspection {
  if (!isPlainRecord(input) || !inspectInputKeysMatch(input)) {
    return outsideContract(["malformed_input"]);
  }
  if (!isHealthStatus(input.healthStatus)) {
    return outsideContract(["malformed_health_status"]);
  }
  if (!isScenarioClaimLike(input.claim)) {
    return outsideContract(["malformed_claim"]);
  }

  let claim: ScenarioClaimDefinition;
  try {
    claim = clonePlain(input.claim) as ScenarioClaimDefinition;
  } catch {
    return outsideContract(["malformed_claim"]);
  }

  if (!isPlainRecord(input.resultSet)) {
    return outsideContract(["malformed_result_set"]);
  }

  const resultSetStatus = input.resultSet.status;
  if (resultSetStatus === "outside_contract" || resultSetStatus === "incoherent") {
    return freezeInspection({
      status: resultSetStatus,
      reasons: Object.freeze(["incomplete_result_set"]),
    });
  }
  if (!isCompleteResultSet(input.resultSet)) {
    return outsideContract(["malformed_result_set"]);
  }

  let resultSet: Extract<ClaimAssertionResultSetInspection, { status: "complete" }>;
  try {
    resultSet = clonePlain(input.resultSet) as Extract<
      ClaimAssertionResultSetInspection,
      { status: "complete" }
    >;
  } catch {
    return outsideContract(["malformed_result_set"]);
  }

  const expectedHash = buildScenarioClaimHash(claim);
  const reasons: string[] = [];
  if (resultSet.claimId !== claim.id) {
    reasons.push("claim_id_mismatch");
  }
  if (resultSet.claimHash !== expectedHash) {
    reasons.push("claim_hash_mismatch");
  }

  const authoredIds = claim.assertions.map((assertion) => assertion.id);
  const resultIds = resultSet.results.map((result) => result.assertionId);
  if (authoredIds.length !== resultIds.length) {
    reasons.push("assertion_inventory_mismatch");
  } else {
    for (const [index, assertion] of claim.assertions.entries()) {
      const result = resultSet.results[index];
      if (result === undefined) {
        reasons.push("assertion_inventory_mismatch");
        break;
      }
      if (result.assertionId !== assertion.id) {
        reasons.push(`assertion_order_mismatch:${assertion.id}`);
      }
      if (result.assertionKind !== assertion.kind) {
        reasons.push(`assertion_kind_mismatch:${assertion.id}`);
      }
    }
  }

  if (reasons.length > 0) {
    return incoherent(reasons);
  }

  const healthStatus = input.healthStatus;
  const assertionResults: ClaimAssertionResult[] =
    healthStatus === "passed"
      ? resultSet.results.map(cloneAssertionResult)
      : resultSet.results.map(projectHealthGatedAssertion);

  const claimStatus = reduceClaimStatus(
    healthStatus,
    assertionResults.map((result) => result.status),
  );

  let reasonCode: ClaimReasonCode;
  if (claimStatus === "supported") {
    reasonCode = "all_assertions_supported";
  } else if (claimStatus === "rejected") {
    reasonCode = "authoritative_evidence_rejected";
  } else if (healthStatus !== "passed") {
    reasonCode = "health_gate_failed";
  } else {
    reasonCode = firstNotEvaluableReason(assertionResults);
  }

  const { nextActionOwner, nextAction } = nextActionFor(claimStatus, reasonCode, claim.id);
  const evidenceReferences = unionEvidenceReferences(assertionResults);
  const missingProof = unionMissingProof(assertionResults);

  const result: ClaimResult = {
    claimId: claim.id,
    claimHash: expectedHash,
    role: claim.role,
    status: claimStatus,
    reasonCode,
    assertionResults: assertionResults as ClaimResult["assertionResults"],
    evidenceReferences,
    missingProof,
    nextActionOwner,
    nextAction,
  } as ClaimResult;

  freezeDeep(result);
  return freezeInspection({
    status: "complete",
    result,
  });
}
