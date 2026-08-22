import { types as nodeTypes } from "node:util";

import { buildScenarioClaimHash } from "./claim-contract.js";
import type {
  AbsenceResult,
  ArtifactKind,
  BoundedCountResult,
  ClaimAssertionResult,
  ClaimEvidenceReference,
  ClaimObservationWindow,
  ClaimScalar,
  EventOccurrenceResult,
  EventOrderResult,
  NotEvaluableReasonCode,
  ScenarioClaimAssertion,
  ScenarioClaimDefinition,
  TerminalStateResult,
  ValidatedEvidenceResult,
} from "./claim-contract.js";

export type ClaimAssertionKind = ScenarioClaimAssertion["kind"];

export type ClaimAssertionCandidateEnvelope = {
  readonly candidateId: string;
  readonly claimId: string;
  readonly claimHash: string;
  readonly assertionId: string;
  readonly assertionKind: ClaimAssertionKind;
  readonly result: ClaimAssertionResult;
};

export type ClaimAssertionResultSetInspection =
  | {
      readonly status: "complete";
      readonly claimId: string;
      readonly claimHash: string;
      readonly results: readonly ClaimAssertionResult[];
      readonly candidates: readonly ClaimAssertionCandidateEnvelope[];
    }
  | {
      readonly status: "incoherent";
      readonly reasons: readonly string[];
      readonly candidates: readonly ClaimAssertionCandidateEnvelope[];
    }
  | {
      readonly status: "outside_contract";
      readonly reasons: readonly string[];
    };

const ASSERTION_KINDS: readonly ClaimAssertionKind[] = [
  "eventOccurrence",
  "eventOrder",
  "terminalState",
  "boundedCount",
  "absence",
  "validatedEvidence",
];

const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  "logs",
  "screenshot",
  "video",
  "uiTree",
  "memory",
  "nativePerformance",
  "network",
  "profiler",
  "accessibility",
  "signals",
];

const NOT_EVALUABLE_REASON_CODES: readonly NotEvaluableReasonCode[] = [
  "health_gate_failed",
  "missing_authoritative_evidence",
  "partial_evidence",
  "ambiguous_evidence",
  "identity_mismatch",
  "identity_capability_unavailable",
  "authoritative_evidence_conflict",
  "unsupported_authority_path",
  "incomplete_observation_window",
  "invalid_evidence",
  "cleanup_incomplete",
];

const OWN_PROPERTY = Object.prototype.hasOwnProperty;

function ownKeys(value: object): string[] {
  return Reflect.ownKeys(value).filter((key): key is string => typeof key === "string");
}

function hasOwn(value: object, key: string): boolean {
  return OWN_PROPERTY.call(value, key);
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

const STABLE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && STABLE_ID.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function isRunRelativePosixPath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value !== value.trim()) {
    return false;
  }
  if (hasAsciiControlCharacter(value)) {
    return false;
  }
  if (value.includes("\\") || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(value) || value.toLowerCase().startsWith("file:")) {
    return false;
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

function hasUniqueItems<T>(items: readonly T[], keyOf: (item: T) => string): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function evidenceReferenceKey(reference: ClaimEvidenceReference): string {
  const pathJson = JSON.stringify(reference.path);
  if (hasOwn(reference, "sha256")) {
    return `path:${pathJson}|sha256:${JSON.stringify(reference.sha256 as string)}`;
  }
  return `path:${pathJson}`;
}

function isClaimScalar(value: unknown): value is ClaimScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isAssertionKind(value: unknown): value is ClaimAssertionKind {
  return ASSERTION_KINDS.some((kind) => kind === value);
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return ARTIFACT_KINDS.some((kind) => kind === value);
}

function isNotEvaluableReasonCode(value: unknown): value is NotEvaluableReasonCode {
  return NOT_EVALUABLE_REASON_CODES.some((code) => code === value);
}

function isObservationWindow(value: unknown): value is ClaimObservationWindow {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (keys.join(",") !== "completeSourceRequired,from,to") {
    return false;
  }
  return (
    isNonEmptyString(value.from) &&
    isNonEmptyString(value.to) &&
    value.completeSourceRequired === true
  );
}

function isEvidenceReference(value: unknown): value is ClaimEvidenceReference {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (keys.join(",") !== "path" && keys.join(",") !== "path,sha256") {
    return false;
  }
  if (!isRunRelativePosixPath(value.path)) {
    return false;
  }
  if (hasOwn(value, "sha256") && !isSha256Hex(value.sha256)) {
    return false;
  }
  return true;
}

function isEvidenceReferenceArray(value: unknown): value is ClaimEvidenceReference[] {
  return (
    Array.isArray(value) &&
    value.every(isEvidenceReference) &&
    hasUniqueItems(value.filter(isEvidenceReference), evidenceReferenceKey)
  );
}

function isNonEmptyEvidenceReferences(value: unknown): value is [ClaimEvidenceReference, ...ClaimEvidenceReference[]] {
  return isEvidenceReferenceArray(value) && value.length > 0;
}

function isEmptyStringArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0;
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && hasUniqueItems(value, (item) => String(item));
}

function isNonEmptyStringArray(value: unknown): value is [string, ...string[]] {
  return isUniqueStringArray(value) && value.length > 0;
}

function isUniqueStableIdArray(value: unknown): value is [string, ...string[]] {
  return Array.isArray(value) && value.length > 0 && value.every(isStableId) && hasUniqueItems(value, (item) => String(item));
}

function isBoundedCountBounds(value: Record<string, unknown>): boolean {
  const hasMinimum = hasOwn(value, "minimum");
  const hasMaximum = hasOwn(value, "maximum");
  if (!hasMinimum && !hasMaximum) {
    return false;
  }
  if (hasMinimum && !isNonNegativeInteger(value.minimum)) {
    return false;
  }
  if (hasMaximum && !isNonNegativeInteger(value.maximum)) {
    return false;
  }
  if (hasMinimum && hasMaximum && (value.minimum as number) > (value.maximum as number)) {
    return false;
  }
  return true;
}

function terminalStateStatusMatchesValues(
  expectedValue: ClaimScalar,
  observedValue: ClaimScalar,
  status: "supported" | "rejected",
): boolean {
  const valuesEqual = Object.is(expectedValue, observedValue);
  if (status === "supported") {
    return valuesEqual;
  }
  return !valuesEqual;
}

function countSatisfiesInclusiveBounds(count: number, expected: Record<string, unknown>): boolean {
  if (hasOwn(expected, "minimum") && count < (expected.minimum as number)) {
    return false;
  }
  if (hasOwn(expected, "maximum") && count > (expected.maximum as number)) {
    return false;
  }
  return true;
}

function resultBaseKeysMatch(value: Record<string, unknown>, extra: readonly string[]): boolean {
  const expected = [
    "assertionId",
    "assertionKind",
    "evidenceReferences",
    "expected",
    "missingProof",
    "observed",
    "reasonCode",
    "rejectedEvidence",
    "status",
    ...extra,
  ].sort();
  return ownKeys(value).sort().join(",") === expected.join(",");
}

function hasCommonResultFields(value: Record<string, unknown>): boolean {
  return isStableId(value.assertionId) && isAssertionKind(value.assertionKind);
}

function isSupportedCommon(value: Record<string, unknown>): boolean {
  return (
    value.status === "supported" &&
    value.reasonCode === "all_assertions_supported" &&
    isNonEmptyEvidenceReferences(value.evidenceReferences) &&
    isEmptyStringArray(value.rejectedEvidence) &&
    isEmptyStringArray(value.missingProof)
  );
}

function isRejectedCommon(value: Record<string, unknown>): boolean {
  return (
    value.status === "rejected" &&
    value.reasonCode === "authoritative_evidence_rejected" &&
    isNonEmptyEvidenceReferences(value.evidenceReferences) &&
    isNonEmptyStringArray(value.rejectedEvidence) &&
    isEmptyStringArray(value.missingProof)
  );
}

function isNotEvaluableCommon(value: Record<string, unknown>): boolean {
  return (
    value.status === "not_evaluable" &&
    isNotEvaluableReasonCode(value.reasonCode) &&
    value.observed === null &&
    isEvidenceReferenceArray(value.evidenceReferences) &&
    isUniqueStringArray(value.rejectedEvidence) &&
    isNonEmptyStringArray(value.missingProof)
  );
}

function isEventOccurrenceResult(value: unknown): value is EventOccurrenceResult {
  if (!isPlainRecord(value) || !hasCommonResultFields(value) || value.assertionKind !== "eventOccurrence") {
    return false;
  }
  if (!resultBaseKeysMatch(value, [])) {
    return false;
  }
  if (!isPlainRecord(value.expected) || ownKeys(value.expected).join(",") !== "event" || !isNonEmptyString(value.expected.event)) {
    return false;
  }
  if (isSupportedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "event,matchedEvidence" &&
      value.observed.event === value.expected.event &&
      isNonEmptyString(value.observed.matchedEvidence)
    );
  }
  return isNotEvaluableCommon(value);
}

function isEventOrderResult(value: unknown): value is EventOrderResult {
  if (!isPlainRecord(value) || !hasCommonResultFields(value) || value.assertionKind !== "eventOrder") {
    return false;
  }
  if (!resultBaseKeysMatch(value, [])) {
    return false;
  }
  if (!isPlainRecord(value.expected)) {
    return false;
  }
  const expectedKeys = ownKeys(value.expected).sort();
  if (
    expectedKeys.join(",") !== "afterEvent,beforeEvent" ||
    !isNonEmptyString(value.expected.beforeEvent) ||
    !isNonEmptyString(value.expected.afterEvent)
  ) {
    return false;
  }
  if (isSupportedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "afterEvidence,beforeEvidence,relation" &&
      isNonEmptyString(value.observed.beforeEvidence) &&
      isNonEmptyString(value.observed.afterEvidence) &&
      value.observed.relation === "before"
    );
  }
  if (isRejectedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "afterEvidence,beforeEvidence,relation" &&
      isNonEmptyString(value.observed.beforeEvidence) &&
      isNonEmptyString(value.observed.afterEvidence) &&
      value.observed.relation === "after"
    );
  }
  return isNotEvaluableCommon(value);
}

function isTerminalStateResult(value: unknown): value is TerminalStateResult {
  if (!isPlainRecord(value) || !hasCommonResultFields(value) || value.assertionKind !== "terminalState") {
    return false;
  }
  if (!resultBaseKeysMatch(value, [])) {
    return false;
  }
  if (!isPlainRecord(value.expected)) {
    return false;
  }
  const expectedKeys = ownKeys(value.expected).sort();
  if (
    expectedKeys.join(",") !== "path,value" ||
    !isNonEmptyString(value.expected.path) ||
    !isClaimScalar(value.expected.value)
  ) {
    return false;
  }
  if (isSupportedCommon(value) || isRejectedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    if (
      keys.join(",") !== "path,value" ||
      !isNonEmptyString(value.observed.path) ||
      !isClaimScalar(value.observed.value) ||
      value.observed.path !== value.expected.path
    ) {
      return false;
    }
    if (isSupportedCommon(value)) {
      return terminalStateStatusMatchesValues(value.expected.value, value.observed.value, "supported");
    }
    return terminalStateStatusMatchesValues(value.expected.value, value.observed.value, "rejected");
  }
  return isNotEvaluableCommon(value);
}

function isBoundedCountResult(value: unknown): value is BoundedCountResult {
  if (!isPlainRecord(value) || !hasCommonResultFields(value) || value.assertionKind !== "boundedCount") {
    return false;
  }
  if (!resultBaseKeysMatch(value, [])) {
    return false;
  }
  if (!isPlainRecord(value.expected) || !isBoundedCountBounds(value.expected)) {
    return false;
  }
  const expectedKeys = ownKeys(value.expected).sort();
  const allowed =
    expectedKeys.join(",") === "minimum,observationWindow,selector" ||
    expectedKeys.join(",") === "maximum,observationWindow,selector" ||
    expectedKeys.join(",") === "maximum,minimum,observationWindow,selector";
  if (
    !allowed ||
    !isNonEmptyString(value.expected.selector) ||
    !isObservationWindow(value.expected.observationWindow)
  ) {
    return false;
  }
  if (isSupportedCommon(value) || isRejectedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    if (
      keys.join(",") !== "count,selector" ||
      !isNonEmptyString(value.observed.selector) ||
      value.observed.selector !== value.expected.selector ||
      !isNonNegativeInteger(value.observed.count)
    ) {
      return false;
    }
    const withinBounds = countSatisfiesInclusiveBounds(value.observed.count, value.expected);
    if (isSupportedCommon(value)) {
      return withinBounds;
    }
    return !withinBounds;
  }
  return isNotEvaluableCommon(value);
}

function isAbsenceResult(value: unknown): value is AbsenceResult {
  if (!isPlainRecord(value) || !hasCommonResultFields(value) || value.assertionKind !== "absence") {
    return false;
  }
  if (!resultBaseKeysMatch(value, [])) {
    return false;
  }
  if (!isPlainRecord(value.expected)) {
    return false;
  }
  const expectedKeys = ownKeys(value.expected).sort();
  if (
    expectedKeys.join(",") !== "observationWindow,selector" ||
    !isNonEmptyString(value.expected.selector) ||
    !isObservationWindow(value.expected.observationWindow)
  ) {
    return false;
  }
  if (isSupportedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "count,selector" &&
      isNonEmptyString(value.observed.selector) &&
      value.observed.selector === value.expected.selector &&
      value.observed.count === 0
    );
  }
  if (isRejectedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "count,selector" &&
      isNonEmptyString(value.observed.selector) &&
      value.observed.selector === value.expected.selector &&
      isPositiveInteger(value.observed.count)
    );
  }
  return isNotEvaluableCommon(value);
}

function isValidatedEvidenceResult(value: unknown): value is ValidatedEvidenceResult {
  if (!isPlainRecord(value) || !hasCommonResultFields(value) || value.assertionKind !== "validatedEvidence") {
    return false;
  }
  if (!resultBaseKeysMatch(value, [])) {
    return false;
  }
  if (!isPlainRecord(value.expected)) {
    return false;
  }
  const expectedKeys = ownKeys(value.expected).sort();
  if (
    expectedKeys.join(",") !== "artifactKind,validationContract" ||
    !isArtifactKind(value.expected.artifactKind) ||
    !isNonEmptyString(value.expected.validationContract)
  ) {
    return false;
  }
  if (isSupportedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "artifactKind,matchedEvidence,validationContract,validationStatus" &&
      value.observed.artifactKind === value.expected.artifactKind &&
      value.observed.validationContract === value.expected.validationContract &&
      isNonEmptyString(value.observed.matchedEvidence) &&
      value.observed.validationStatus === "passed"
    );
  }
  if (isRejectedCommon(value)) {
    if (!isPlainRecord(value.observed)) {
      return false;
    }
    const keys = ownKeys(value.observed).sort();
    return (
      keys.join(",") === "artifactKind,matchedEvidence,validationContract,validationStatus" &&
      value.observed.artifactKind === value.expected.artifactKind &&
      value.observed.validationContract === value.expected.validationContract &&
      isNonEmptyString(value.observed.matchedEvidence) &&
      value.observed.validationStatus === "failed"
    );
  }
  return isNotEvaluableCommon(value);
}

function isClaimAssertionResult(value: unknown): value is ClaimAssertionResult {
  return (
    isEventOccurrenceResult(value) ||
    isEventOrderResult(value) ||
    isTerminalStateResult(value) ||
    isBoundedCountResult(value) ||
    isAbsenceResult(value) ||
    isValidatedEvidenceResult(value)
  );
}

function isCandidateEnvelope(value: unknown): value is ClaimAssertionCandidateEnvelope {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (
    keys.join(",") !==
    "assertionId,assertionKind,candidateId,claimHash,claimId,result"
  ) {
    return false;
  }
  if (
    !isRunRelativePosixPath(value.candidateId) ||
    !isStableId(value.claimId) ||
    !isSha256Hex(value.claimHash) ||
    !isStableId(value.assertionId) ||
    !isAssertionKind(value.assertionKind)
  ) {
    return false;
  }
  return isClaimAssertionResult(value.result);
}

function isNonEmptyArray<T>(value: unknown, predicate: (item: unknown) => item is T): value is [T, ...T[]] {
  return Array.isArray(value) && value.length > 0 && value.every(predicate);
}

function isClaimAuthority(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (
    keys.join(",") !==
    "completeness,evidenceSelector,producerId,requiredStrength,role"
  ) {
    return false;
  }
  return (
    (value.role === "app" ||
      value.role === "runner" ||
      value.role === "adapter" ||
      value.role === "provider" ||
      value.role === "comparator") &&
    isNonEmptyString(value.producerId) &&
    isNonEmptyString(value.evidenceSelector) &&
    (value.requiredStrength === "observed" || value.requiredStrength === "verified") &&
    (value.completeness === "point" ||
      value.completeness === "bounded" ||
      value.completeness === "continuous-complete")
  );
}

function isWindowedAuthority(value: unknown): boolean {
  return isClaimAuthority(value) && isPlainRecord(value) && value.completeness !== "point";
}

function assertionKeysMatch(value: Record<string, unknown>, extra: readonly string[]): boolean {
  const expected = ["authority", "id", "kind", ...extra].sort();
  return ownKeys(value).sort().join(",") === expected.join(",");
}

function isScenarioClaimAssertion(value: unknown): value is ScenarioClaimAssertion {
  if (!isPlainRecord(value) || !isStableId(value.id) || !isAssertionKind(value.kind)) {
    return false;
  }
  switch (value.kind) {
    case "eventOccurrence":
      return (
        assertionKeysMatch(value, ["event"]) &&
        isClaimAuthority(value.authority) &&
        isNonEmptyString(value.event)
      );
    case "eventOrder":
      return (
        assertionKeysMatch(value, ["afterEvent", "beforeEvent"]) &&
        isClaimAuthority(value.authority) &&
        isNonEmptyString(value.beforeEvent) &&
        isNonEmptyString(value.afterEvent)
      );
    case "terminalState":
      return (
        assertionKeysMatch(value, ["expected", "path"]) &&
        isClaimAuthority(value.authority) &&
        isNonEmptyString(value.path) &&
        isClaimScalar(value.expected)
      );
    case "boundedCount": {
      const extra = ["observationWindow", "selector"];
      if (hasOwn(value, "minimum")) {
        extra.push("minimum");
      }
      if (hasOwn(value, "maximum")) {
        extra.push("maximum");
      }
      return (
        assertionKeysMatch(value, extra) &&
        isWindowedAuthority(value.authority) &&
        isNonEmptyString(value.selector) &&
        isObservationWindow(value.observationWindow) &&
        isBoundedCountBounds(value)
      );
    }
    case "absence":
      return (
        assertionKeysMatch(value, ["observationWindow", "selector"]) &&
        isWindowedAuthority(value.authority) &&
        isNonEmptyString(value.selector) &&
        isObservationWindow(value.observationWindow)
      );
    case "validatedEvidence":
      return (
        assertionKeysMatch(value, ["artifactKind", "validationContract"]) &&
        isClaimAuthority(value.authority) &&
        isArtifactKind(value.artifactKind) &&
        isNonEmptyString(value.validationContract)
      );
    default:
      return false;
  }
}

function isPlatform(value: unknown): value is "ios" | "android" {
  return value === "ios" || value === "android";
}

function isClaimClosure(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  const allowed =
    keys.join(",") === "phases" ||
    keys.join(",") === "terminalInvariants" ||
    keys.join(",") === "phases,terminalInvariants";
  if (!allowed) {
    return false;
  }
  if (hasOwn(value, "phases") && !isUniqueStableIdArray(value.phases)) {
    return false;
  }
  if (hasOwn(value, "terminalInvariants") && !isUniqueStableIdArray(value.terminalInvariants)) {
    return false;
  }
  return true;
}

function isApplicability(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (keys.join(",") !== "platforms" && keys.join(",") !== "platforms,variants") {
    return false;
  }
  if (!isNonEmptyArray(value.platforms, isPlatform) || !hasUniqueItems(value.platforms, (item) => String(item))) {
    return false;
  }
  if (hasOwn(value, "variants") && !isNonEmptyStringArray(value.variants)) {
    return false;
  }
  return true;
}

function isScenarioClaimDefinition(value: unknown): value is ScenarioClaimDefinition {
  if (!isPlainRecord(value)) {
    return false;
  }
  const keys = ownKeys(value).sort();
  if (keys.join(",") !== "applicability,assertions,closes,id,role") {
    return false;
  }
  if (!isStableId(value.id)) {
    return false;
  }
  if (value.role !== "mandatory" && value.role !== "supplemental") {
    return false;
  }
  if (!isApplicability(value.applicability)) {
    return false;
  }
  if (!isClaimClosure(value.closes)) {
    return false;
  }
  if (!isNonEmptyArray(value.assertions, isScenarioClaimAssertion)) {
    return false;
  }
  return true;
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

function cloneValidated<T>(value: T, guard: (candidate: unknown) => candidate is T): T {
  const cloned = clonePlain(value);
  if (!guard(cloned)) {
    throw new TypeError("clone changed shape");
  }
  return cloned;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = ownKeys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function authoredExpectationFingerprint(assertion: ScenarioClaimAssertion): string {
  switch (assertion.kind) {
    case "eventOccurrence":
      return canonicalJson({ event: assertion.event });
    case "eventOrder":
      return canonicalJson({
        afterEvent: assertion.afterEvent,
        beforeEvent: assertion.beforeEvent,
      });
    case "terminalState":
      return canonicalJson({
        path: assertion.path,
        value: assertion.expected,
      });
    case "boundedCount": {
      const expected: Record<string, unknown> = {
        observationWindow: assertion.observationWindow,
        selector: assertion.selector,
      };
      if (hasOwn(assertion, "minimum")) {
        expected.minimum = assertion.minimum;
      }
      if (hasOwn(assertion, "maximum")) {
        expected.maximum = assertion.maximum;
      }
      return canonicalJson(expected);
    }
    case "absence":
      return canonicalJson({
        observationWindow: assertion.observationWindow,
        selector: assertion.selector,
      });
    case "validatedEvidence":
      return canonicalJson({
        artifactKind: assertion.artifactKind,
        validationContract: assertion.validationContract,
      });
  }
}

function resultFingerprint(result: ClaimAssertionResult): string {
  return canonicalJson(result);
}

function observedFingerprint(result: ClaimAssertionResult): string {
  return canonicalJson(result.observed);
}

function freezeInspection(inspection: ClaimAssertionResultSetInspection): ClaimAssertionResultSetInspection {
  freezeDeep(inspection);
  return inspection;
}

function duplicateAuthoredAssertionReasons(assertionIds: readonly string[]): readonly string[] | undefined {
  const seen = new Set<string>();
  let hasDuplicate = false;
  for (const id of assertionIds) {
    if (seen.has(id)) {
      hasDuplicate = true;
      break;
    }
    seen.add(id);
  }
  if (!hasDuplicate) {
    return undefined;
  }
  return ["duplicate_authored_assertion_id", "malformed_claim"];
}

function inspectInputKeysMatch(value: object): boolean {
  const keys = ownKeys(value).sort();
  return keys.length === 2 && keys[0] === "candidates" && keys[1] === "claim";
}

export function inspectClaimAssertionResultSet(input: {
  readonly claim: ScenarioClaimDefinition;
  readonly candidates: readonly ClaimAssertionCandidateEnvelope[];
}): ClaimAssertionResultSetInspection {
  if (!isPlainRecord(input) || !inspectInputKeysMatch(input)) {
    return freezeInspection({
      status: "outside_contract",
      reasons: Object.freeze(["malformed_input"]),
    });
  }
  if (!isScenarioClaimDefinition(input.claim)) {
    return freezeInspection({
      status: "outside_contract",
      reasons: Object.freeze(["malformed_claim"]),
    });
  }
  if (!Array.isArray(input.candidates) || nodeTypes.isProxy(input.candidates) || !hasOnlyEnumerableDataProperties(input.candidates)) {
    return freezeInspection({
      status: "outside_contract",
      reasons: Object.freeze(["malformed_candidates"]),
    });
  }

  let claim: ScenarioClaimDefinition;
  try {
    claim = cloneValidated(input.claim, isScenarioClaimDefinition);
  } catch {
    return freezeInspection({
      status: "outside_contract",
      reasons: Object.freeze(["malformed_claim"]),
    });
  }

  const authoredIds = claim.assertions.map((assertion) => assertion.id);
  const duplicateReasons = duplicateAuthoredAssertionReasons(authoredIds);
  if (duplicateReasons !== undefined) {
    return freezeInspection({
      status: "outside_contract",
      reasons: Object.freeze(duplicateReasons),
    });
  }

  const expectedHash = buildScenarioClaimHash(claim);
  const reasons: string[] = [];
  const detachedCandidates: ClaimAssertionCandidateEnvelope[] = [];

  for (const [index, candidate] of input.candidates.entries()) {
    if (!isCandidateEnvelope(candidate)) {
      return freezeInspection({
        status: "outside_contract",
        reasons: Object.freeze([`malformed_candidate:${index}`]),
      });
    }
    try {
      detachedCandidates.push(cloneValidated(candidate, isCandidateEnvelope));
    } catch {
      return freezeInspection({
        status: "outside_contract",
        reasons: Object.freeze([`malformed_candidate:${index}`]),
      });
    }
  }

  freezeDeep(claim);
  freezeDeep(detachedCandidates);

  const authoredIdSet = new Set(authoredIds);

  const byAssertion = new Map<string, ClaimAssertionCandidateEnvelope[]>();
  const seenCandidateIds = new Set<string>();

  for (const candidate of detachedCandidates) {
    if (seenCandidateIds.has(candidate.candidateId)) {
      reasons.push(`duplicate_candidate_id:${candidate.candidateId}`);
    }
    seenCandidateIds.add(candidate.candidateId);
    if (candidate.claimId !== claim.id) {
      reasons.push(`foreign_claim_id:${candidate.candidateId}`);
    }
    if (candidate.claimHash !== expectedHash) {
      reasons.push(`claim_hash_mismatch:${candidate.candidateId}`);
    }
    if (candidate.result.assertionId !== candidate.assertionId) {
      reasons.push(`assertion_id_mismatch:${candidate.candidateId}`);
    }
    if (candidate.result.assertionKind !== candidate.assertionKind) {
      reasons.push(`assertion_kind_mismatch:${candidate.candidateId}`);
    }
    if (!authoredIdSet.has(candidate.assertionId)) {
      reasons.push(`foreign_assertion:${candidate.candidateId}:${candidate.assertionId}`);
      continue;
    }
    const authored = claim.assertions.find((item) => item.id === candidate.assertionId);
    if (authored && authored.kind !== candidate.assertionKind) {
      reasons.push(`wrong_kind:${candidate.candidateId}:${candidate.assertionId}`);
    }
    if (
      authored &&
      authored.kind === candidate.assertionKind &&
      canonicalJson(candidate.result.expected) !== authoredExpectationFingerprint(authored)
    ) {
      reasons.push(`authored_expectation_mismatch:${candidate.candidateId}:${candidate.assertionId}`);
    }
    const existing = byAssertion.get(candidate.assertionId) ?? [];
    existing.push(candidate);
    byAssertion.set(candidate.assertionId, existing);
  }

  for (const assertion of claim.assertions) {
    const matches = byAssertion.get(assertion.id) ?? [];
    if (matches.length === 0) {
      reasons.push(`missing_assertion:${assertion.id}`);
      continue;
    }
    if (matches.length > 1) {
      reasons.push(`duplicate_assertion:${assertion.id}`);
    }
    const fingerprints = new Set(matches.map((item) => resultFingerprint(item.result)));
    if (fingerprints.size > 1) {
      const statuses = new Set(matches.map((item) => item.result.status));
      if (statuses.size > 1) {
        reasons.push(`conflicting_status:${assertion.id}`);
      }
      const observed = new Set(matches.map((item) => observedFingerprint(item.result)));
      if (observed.size > 1) {
        reasons.push(`conflicting_observed_value:${assertion.id}`);
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)].sort(compareStrings);
  if (uniqueReasons.length > 0) {
    return freezeInspection({
      status: "incoherent",
      reasons: Object.freeze(uniqueReasons),
      candidates: Object.freeze(detachedCandidates),
    });
  }

  const results = claim.assertions.map((assertion) => {
    const matches = byAssertion.get(assertion.id);
    const first = matches?.[0];
    if (first === undefined) {
      throw new Error("invariant: complete inventory missing authored assertion");
    }
    return first.result;
  });

  return freezeInspection({
    status: "complete",
    claimId: claim.id,
    claimHash: expectedHash,
    results: Object.freeze(results),
    candidates: Object.freeze(detachedCandidates),
  });
}
