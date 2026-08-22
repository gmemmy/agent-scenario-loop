import { types as nodeTypes } from "node:util";
import type { ValidatedEvidenceAssertion } from "./claim-contract.js";
import {
  isLowerSha256,
  isSafeRunRelativePath,
  isTrimmedControlFreeIdentity,
  isValidatedEvidenceResultArtifactKind,
} from "./claim-validated-evidence-result-admission.js";

export const CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND =
  "asl.claim.validated_evidence_result_interpretation" as const;

export const CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION =
  "1.0.0" as const;

export type ValidatedEvidenceValidationStatus =
  | "passed"
  | "failed"
  | "not_evaluable";

export type ClaimValidatedEvidenceResultInterpretationOutcome =
  | "supported"
  | "rejected"
  | "not_evaluable"
  | "outside_contract";

export type AdmittedValidatorResultProjection = {
  readonly assertionId: string;
  readonly validationContract: string;
  readonly artifactKind: string;
  readonly validatorProducer: string;
  readonly validatorVersion: string;
  readonly validatorHash: string;
  readonly subjectPath: string;
  readonly subjectHash: string;
  readonly reportPath: string;
  readonly reportHash: string;
  readonly resultPath: string;
  readonly resultHash: string;
  readonly terminalStatus: ValidatedEvidenceValidationStatus;
  readonly reason: string;
};

export type ValidatedEvidenceMatchedEvidence = {
  readonly kind: "validated_evidence";
  readonly validationContract: string;
  readonly subjectPath: string;
  readonly subjectHash: string;
  readonly reportPath: string;
  readonly reportHash: string;
  readonly resultPath: string;
  readonly resultHash: string;
};

export type ValidatedEvidenceRejectedEvidence = {
  readonly kind: "validated_evidence";
  readonly validationContract: string;
  readonly subjectPath: string;
  readonly subjectHash: string;
  readonly reportPath: string;
  readonly reportHash: string;
  readonly resultPath: string;
  readonly resultHash: string;
  readonly reason: string;
};

export type ValidatedEvidenceMissingProof = {
  readonly kind: "validated_evidence";
  readonly validationContract: string;
  readonly subjectPath: string;
  readonly subjectHash: string;
  readonly reportPath: string;
  readonly reportHash: string;
  readonly resultPath: string;
  readonly resultHash: string;
  readonly reason: string;
};

export type ValidatedEvidenceInterpretationProvenance = {
  readonly aslRole: "admitted_and_projected_external_validator_truth";
  readonly validatorExecutedByAsl: false;
  readonly validatorProducer: string;
  readonly validatorVersion: string;
  readonly validatorHash: string;
};

export type SupportedValidatedEvidenceResult = {
  readonly kind: "supported";
  readonly observedKind: "validated_evidence";
  readonly validationContract: string;
  readonly validationStatus: "passed";
  readonly matchedEvidence: readonly ValidatedEvidenceMatchedEvidence[];
  readonly provenance: ValidatedEvidenceInterpretationProvenance;
};

export type RejectedValidatedEvidenceResult = {
  readonly kind: "rejected";
  readonly observedKind: "validated_evidence";
  readonly validationContract: string;
  readonly validationStatus: "failed";
  readonly rejectedEvidence: readonly ValidatedEvidenceRejectedEvidence[];
  readonly provenance: ValidatedEvidenceInterpretationProvenance;
};

export type NotEvaluableValidatedEvidenceResult = {
  readonly kind: "not_evaluable";
  readonly observedKind: "validated_evidence";
  readonly validationContract: string;
  readonly validationStatus: "not_evaluable";
  readonly reason: string;
  readonly missingProof: readonly ValidatedEvidenceMissingProof[];
  readonly provenance: ValidatedEvidenceInterpretationProvenance;
};

export type ValidatedEvidenceResult =
  | SupportedValidatedEvidenceResult
  | RejectedValidatedEvidenceResult
  | NotEvaluableValidatedEvidenceResult;

export type ClaimValidatedEvidenceResultInterpretation =
  | {
      readonly interpretationKind: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND;
      readonly interpretationContractVersion: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION;
      readonly outcome: "supported" | "rejected" | "not_evaluable";
      readonly result: ValidatedEvidenceResult;
    }
  | {
      readonly interpretationKind: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND;
      readonly interpretationContractVersion: typeof CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION;
      readonly outcome: "outside_contract";
      readonly result: null;
      readonly reason: string;
    };

const REQUIRED_PROJECTION_KEYS = [
  "assertionId",
  "validationContract",
  "artifactKind",
  "validatorProducer",
  "validatorVersion",
  "validatorHash",
  "subjectPath",
  "subjectHash",
  "reportPath",
  "reportHash",
  "resultPath",
  "resultHash",
  "terminalStatus",
  "reason",
] as const;

const CLOSED_INPUT_KEYS = ["assertion", "admittedProjection"] as const;

const OUTSIDE_CONTRACT_MALFORMED =
  "admitted projection is malformed, synthesized, foreign, or not an exact admitted validator-result record";
const OUTSIDE_CONTRACT_INPUT =
  "input is not an authored assertion with a detached admitted projection";
const OUTSIDE_CONTRACT_BIND =
  "assertion id, kind, artifact kind, or validation contract does not bind the admitted projection";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (nodeTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype;
}

function hasExactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length) {
    return false;
  }
  return expected.every((key) => keys.includes(key));
}

function copyString(value: string): string {
  return value.slice();
}

function ownDataValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value")
  ) {
    return undefined;
  }
  return descriptor.value;
}

type AssertionBinding = {
  readonly id: string;
  readonly kind: string;
  readonly validationContract: string;
  readonly artifactKind: string;
};

function snapshotAssertionBinding(value: unknown): AssertionBinding | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const id = ownDataValue(value, "id");
  const kind = ownDataValue(value, "kind");
  const validationContract = ownDataValue(value, "validationContract");
  const artifactKind = ownDataValue(value, "artifactKind");
  if (
    typeof id !== "string" ||
    typeof kind !== "string" ||
    typeof validationContract !== "string" ||
    typeof artifactKind !== "string"
  ) {
    return null;
  }

  return {
    id: copyString(id),
    kind: copyString(kind),
    validationContract: copyString(validationContract),
    artifactKind: copyString(artifactKind),
  };
}

function snapshotAdmittedProjection(
  value: unknown,
): AdmittedValidatorResultProjection | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== REQUIRED_PROJECTION_KEYS.length) {
    return null;
  }

  const expected = new Set<string>(REQUIRED_PROJECTION_KEYS);
  const copied: Record<string, unknown> = {};
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) {
      return null;
    }
    copied[key] = ownDataValue(value, key);
  }

  const assertionId = copied.assertionId;
  const validationContract = copied.validationContract;
  const artifactKind = copied.artifactKind;
  const validatorProducer = copied.validatorProducer;
  const validatorVersion = copied.validatorVersion;
  const validatorHash = copied.validatorHash;
  const subjectPath = copied.subjectPath;
  const subjectHash = copied.subjectHash;
  const reportPath = copied.reportPath;
  const reportHash = copied.reportHash;
  const resultPath = copied.resultPath;
  const resultHash = copied.resultHash;
  const terminalStatus = copied.terminalStatus;
  const reason = copied.reason;

  if (
    !isTrimmedControlFreeIdentity(assertionId) ||
    !isTrimmedControlFreeIdentity(validationContract) ||
    !isValidatedEvidenceResultArtifactKind(artifactKind) ||
    !isTrimmedControlFreeIdentity(validatorProducer) ||
    !isTrimmedControlFreeIdentity(validatorVersion) ||
    !isLowerSha256(validatorHash) ||
    !isSafeRunRelativePath(subjectPath) ||
    !isLowerSha256(subjectHash) ||
    !isSafeRunRelativePath(reportPath) ||
    !isLowerSha256(reportHash) ||
    !isSafeRunRelativePath(resultPath) ||
    !isLowerSha256(resultHash) ||
    !isTrimmedControlFreeIdentity(reason)
  ) {
    return null;
  }

  if (
    terminalStatus !== "passed" &&
    terminalStatus !== "failed" &&
    terminalStatus !== "not_evaluable"
  ) {
    return null;
  }

  return {
    assertionId: copyString(assertionId),
    validationContract: copyString(validationContract),
    artifactKind: copyString(artifactKind),
    validatorProducer: copyString(validatorProducer),
    validatorVersion: copyString(validatorVersion),
    validatorHash: copyString(validatorHash),
    subjectPath: copyString(subjectPath),
    subjectHash: copyString(subjectHash),
    reportPath: copyString(reportPath),
    reportHash: copyString(reportHash),
    resultPath: copyString(resultPath),
    resultHash: copyString(resultHash),
    terminalStatus,
    reason: copyString(reason),
  };
}

function assertionBindsProjection(
  assertion: AssertionBinding,
  projection: AdmittedValidatorResultProjection,
): boolean {
  return (
    assertion.kind === "validatedEvidence" &&
    assertion.id === projection.assertionId &&
    assertion.validationContract === projection.validationContract &&
    assertion.artifactKind === projection.artifactKind
  );
}

function freezeMatchedEvidence(
  projection: AdmittedValidatorResultProjection,
): ValidatedEvidenceMatchedEvidence {
  return Object.freeze({
    kind: "validated_evidence",
    validationContract: copyString(projection.validationContract),
    subjectPath: copyString(projection.subjectPath),
    subjectHash: copyString(projection.subjectHash),
    reportPath: copyString(projection.reportPath),
    reportHash: copyString(projection.reportHash),
    resultPath: copyString(projection.resultPath),
    resultHash: copyString(projection.resultHash),
  });
}

function freezeReasonedEvidence(
  projection: AdmittedValidatorResultProjection,
): ValidatedEvidenceRejectedEvidence {
  return Object.freeze({
    kind: "validated_evidence",
    validationContract: copyString(projection.validationContract),
    subjectPath: copyString(projection.subjectPath),
    subjectHash: copyString(projection.subjectHash),
    reportPath: copyString(projection.reportPath),
    reportHash: copyString(projection.reportHash),
    resultPath: copyString(projection.resultPath),
    resultHash: copyString(projection.resultHash),
    reason: copyString(projection.reason),
  });
}

function freezeProvenance(
  projection: AdmittedValidatorResultProjection,
): ValidatedEvidenceInterpretationProvenance {
  return Object.freeze({
    aslRole: "admitted_and_projected_external_validator_truth",
    validatorExecutedByAsl: false,
    validatorProducer: copyString(projection.validatorProducer),
    validatorVersion: copyString(projection.validatorVersion),
    validatorHash: copyString(projection.validatorHash),
  });
}

function outsideContract(
  reason: string,
): ClaimValidatedEvidenceResultInterpretation {
  return Object.freeze({
    interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
    interpretationContractVersion:
      CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
    outcome: "outside_contract",
    result: null,
    reason: copyString(reason),
  });
}

function freezeSupported(
  projection: AdmittedValidatorResultProjection,
): ClaimValidatedEvidenceResultInterpretation {
  return Object.freeze({
    interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
    interpretationContractVersion:
      CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
    outcome: "supported",
    result: Object.freeze({
      kind: "supported",
      observedKind: "validated_evidence",
      validationContract: copyString(projection.validationContract),
      validationStatus: "passed",
      matchedEvidence: Object.freeze([freezeMatchedEvidence(projection)]),
      provenance: freezeProvenance(projection),
    }),
  });
}

function freezeRejected(
  projection: AdmittedValidatorResultProjection,
): ClaimValidatedEvidenceResultInterpretation {
  return Object.freeze({
    interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
    interpretationContractVersion:
      CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
    outcome: "rejected",
    result: Object.freeze({
      kind: "rejected",
      observedKind: "validated_evidence",
      validationContract: copyString(projection.validationContract),
      validationStatus: "failed",
      rejectedEvidence: Object.freeze([freezeReasonedEvidence(projection)]),
      provenance: freezeProvenance(projection),
    }),
  });
}

function freezeNotEvaluable(
  projection: AdmittedValidatorResultProjection,
): ClaimValidatedEvidenceResultInterpretation {
  return Object.freeze({
    interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
    interpretationContractVersion:
      CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
    outcome: "not_evaluable",
    result: Object.freeze({
      kind: "not_evaluable",
      observedKind: "validated_evidence",
      validationContract: copyString(projection.validationContract),
      validationStatus: "not_evaluable",
      reason: copyString(projection.reason),
      missingProof: Object.freeze([freezeReasonedEvidence(projection)]),
      provenance: freezeProvenance(projection),
    }),
  });
}

export function interpretAdmittedValidatedEvidenceResult(input: {
  readonly assertion: ValidatedEvidenceAssertion;
  readonly admittedProjection: unknown;
}): ClaimValidatedEvidenceResultInterpretation {
  try {
    if (!isPlainObject(input) || !hasExactOwnKeys(input, CLOSED_INPUT_KEYS)) {
      return outsideContract(OUTSIDE_CONTRACT_INPUT);
    }
    const assertion = snapshotAssertionBinding(ownDataValue(input, "assertion"));
    const snapshot = snapshotAdmittedProjection(
      ownDataValue(input, "admittedProjection"),
    );
    if (assertion === null) {
      return outsideContract(OUTSIDE_CONTRACT_INPUT);
    }
    if (snapshot === null) {
      return outsideContract(OUTSIDE_CONTRACT_MALFORMED);
    }
    if (!assertionBindsProjection(assertion, snapshot)) {
      return outsideContract(OUTSIDE_CONTRACT_BIND);
    }
    switch (snapshot.terminalStatus) {
      case "passed":
        return freezeSupported(snapshot);
      case "failed":
        return freezeRejected(snapshot);
      case "not_evaluable":
        return freezeNotEvaluable(snapshot);
      default: {
        const _exhaustive: never = snapshot.terminalStatus;
        void _exhaustive;
        return outsideContract(OUTSIDE_CONTRACT_MALFORMED);
      }
    }
  } catch {
    return outsideContract(OUTSIDE_CONTRACT_INPUT);
  }
}
