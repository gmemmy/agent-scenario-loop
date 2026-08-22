import { types as nodeTypes } from "node:util";
import type { ValidatedEvidenceAssertion } from "./claim-contract.js";

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

const OUTSIDE_CONTRACT_MALFORMED =
  "admitted projection is malformed, synthesized, foreign, or not an exact admitted validator-result record";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    !isNonemptyString(assertionId) ||
    !isNonemptyString(validationContract) ||
    !isNonemptyString(validatorProducer) ||
    !isNonemptyString(validatorVersion) ||
    !isNonemptyString(validatorHash) ||
    !isNonemptyString(subjectPath) ||
    !isNonemptyString(subjectHash) ||
    !isNonemptyString(reportPath) ||
    !isNonemptyString(reportHash) ||
    !isNonemptyString(resultPath) ||
    !isNonemptyString(resultHash) ||
    !isNonemptyString(reason)
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
    assertionId,
    validationContract,
    validatorProducer,
    validatorVersion,
    validatorHash,
    subjectPath,
    subjectHash,
    reportPath,
    reportHash,
    resultPath,
    resultHash,
    terminalStatus,
    reason,
  };
}

function assertionBindsProjection(
  assertion: ValidatedEvidenceAssertion,
  projection: AdmittedValidatorResultProjection,
): boolean {
  return (
    assertion.id === projection.assertionId &&
    assertion.validationContract === projection.validationContract
  );
}

function evidenceIdentities(
  projection: AdmittedValidatorResultProjection,
): ValidatedEvidenceMatchedEvidence {
  return {
    kind: "validated_evidence",
    validationContract: projection.validationContract,
    subjectPath: projection.subjectPath,
    subjectHash: projection.subjectHash,
    reportPath: projection.reportPath,
    reportHash: projection.reportHash,
    resultPath: projection.resultPath,
    resultHash: projection.resultHash,
  };
}

function provenance(
  projection: AdmittedValidatorResultProjection,
): ValidatedEvidenceInterpretationProvenance {
  return {
    aslRole: "admitted_and_projected_external_validator_truth",
    validatorExecutedByAsl: false,
    validatorProducer: projection.validatorProducer,
    validatorVersion: projection.validatorVersion,
    validatorHash: projection.validatorHash,
  };
}

function outsideContract(
  reason: string,
): ClaimValidatedEvidenceResultInterpretation {
  return {
    interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
    interpretationContractVersion:
      CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
    outcome: "outside_contract",
    result: null,
    reason,
  };
}

export function interpretAdmittedValidatedEvidenceResult(input: {
  readonly assertion: ValidatedEvidenceAssertion;
  readonly admittedProjection: unknown;
}): ClaimValidatedEvidenceResultInterpretation {
  if (!isPlainObject(input) || !isPlainObject(input.assertion as unknown)) {
    return outsideContract(
      "input is not an authored assertion with a detached admitted projection",
    );
  }

  const assertion = input.assertion;
  const snapshot = snapshotAdmittedProjection(input.admittedProjection);
  if (snapshot === null) {
    return outsideContract(OUTSIDE_CONTRACT_MALFORMED);
  }

  if (!assertionBindsProjection(assertion, snapshot)) {
    return outsideContract(
      "assertion id or validation contract does not bind the admitted projection",
    );
  }

  const identities = evidenceIdentities(snapshot);
  const recordProvenance = provenance(snapshot);

  switch (snapshot.terminalStatus) {
    case "passed":
      return {
        interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
        interpretationContractVersion:
          CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
        outcome: "supported",
        result: {
          kind: "supported",
          observedKind: "validated_evidence",
          validationContract: snapshot.validationContract,
          validationStatus: "passed",
          matchedEvidence: [identities],
          provenance: recordProvenance,
        },
      };
    case "failed":
      return {
        interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
        interpretationContractVersion:
          CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
        outcome: "rejected",
        result: {
          kind: "rejected",
          observedKind: "validated_evidence",
          validationContract: snapshot.validationContract,
          validationStatus: "failed",
          rejectedEvidence: [
            {
              ...identities,
              reason: snapshot.reason,
            },
          ],
          provenance: recordProvenance,
        },
      };
    case "not_evaluable":
      return {
        interpretationKind: CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
        interpretationContractVersion:
          CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
        outcome: "not_evaluable",
        result: {
          kind: "not_evaluable",
          observedKind: "validated_evidence",
          validationContract: snapshot.validationContract,
          validationStatus: "not_evaluable",
          reason: snapshot.reason,
          missingProof: [
            {
              ...identities,
              reason: snapshot.reason,
            },
          ],
          provenance: recordProvenance,
        },
      };
    default: {
      const _exhaustive: never = snapshot.terminalStatus;
      void _exhaustive;
      return outsideContract(OUTSIDE_CONTRACT_MALFORMED);
    }
  }
}
