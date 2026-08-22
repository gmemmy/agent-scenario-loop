import assert from "node:assert/strict";
import test from "node:test";
import type { ValidatedEvidenceAssertion } from "../claim-contract.js";
import {
  CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
  CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
  interpretAdmittedValidatedEvidenceResult,
} from "../claim-validated-evidence-result-interpretation.js";

const assertion: ValidatedEvidenceAssertion = {
  id: "assertion.validated.alpha",
  kind: "validatedEvidence",
  artifactKind: "video",
  validationContract: "asl.validation.contract.v1",
  authority: {
    role: "provider",
    producerId: "media-validator",
    evidenceSelector: "validated-evidence-result",
    requiredStrength: "verified",
    completeness: "point",
  },
};

const EVIDENCE_IDENTITY_KEYS = [
  "kind",
  "validationContract",
  "subjectPath",
  "subjectHash",
  "reportPath",
  "reportHash",
  "resultPath",
  "resultHash",
] as const;

function admittedProjection(overrides: Record<string, unknown> = {}) {
  return {
    assertionId: "assertion.validated.alpha",
    validationContract: "asl.validation.contract.v1",
    validatorProducer: "external.validator",
    validatorVersion: "1.0.0",
    validatorHash: "hash.validator",
    subjectPath: "evidence/subject.json",
    subjectHash: "hash.subject",
    reportPath: "evidence/report.json",
    reportHash: "hash.report",
    resultPath: "evidence/result.json",
    resultHash: "hash.result",
    terminalStatus: "passed",
    reason: "validator passed",
    ...overrides,
  };
}

function assertContractIdentity(
  interpreted: ReturnType<typeof interpretAdmittedValidatedEvidenceResult>,
): void {
  assert.equal(
    interpreted.interpretationKind,
    CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_KIND,
  );
  assert.equal(
    interpreted.interpretationContractVersion,
    CLAIM_VALIDATED_EVIDENCE_RESULT_INTERPRETATION_CONTRACT_VERSION,
  );
}

function assertEvidenceOrder(record: {
  readonly subjectPath: string;
  readonly reportPath: string;
  readonly resultPath: string;
}): void {
  assert.equal(record.subjectPath, "evidence/subject.json");
  assert.equal(record.reportPath, "evidence/report.json");
  assert.equal(record.resultPath, "evidence/result.json");
}

test("exact admitted passed projection becomes supported with matched evidence", () => {
  const interpreted = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection(),
  });
  assertContractIdentity(interpreted);
  assert.equal(interpreted.outcome, "supported");
  if (interpreted.outcome !== "supported") {
    throw new Error("expected supported");
  }
  assert.equal(interpreted.result.kind, "supported");
  if (interpreted.result.kind !== "supported") {
    throw new Error("expected supported");
  }
  assert.equal(interpreted.result.validationStatus, "passed");
  assert.equal(interpreted.result.observedKind, "validated_evidence");
  assert.equal(interpreted.result.matchedEvidence.length, 1);
  assert.equal(interpreted.result.provenance.validatorExecutedByAsl, false);
  assert.equal(
    interpreted.result.provenance.aslRole,
    "admitted_and_projected_external_validator_truth",
  );
  assert.equal(
    interpreted.result.provenance.validatorProducer,
    "external.validator",
  );
  assert.equal(interpreted.result.provenance.validatorVersion, "1.0.0");
  assert.equal(interpreted.result.provenance.validatorHash, "hash.validator");
});

test("exact admitted failed projection becomes rejected with nonempty rejected evidence", () => {
  const interpreted = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({
      terminalStatus: "failed",
      reason: "schema mismatch",
    }),
  });
  assertContractIdentity(interpreted);
  assert.equal(interpreted.outcome, "rejected");
  if (interpreted.outcome !== "rejected") {
    throw new Error("expected rejected");
  }
  assert.equal(interpreted.result.validationStatus, "failed");
  assert.equal(interpreted.result.rejectedEvidence.length, 1);
  assert.equal(interpreted.result.rejectedEvidence[0]?.reason, "schema mismatch");
  assertEvidenceOrder(interpreted.result.rejectedEvidence[0]!);
  assert.deepEqual(
    Object.keys(interpreted.result.rejectedEvidence[0] ?? {}).slice(0, 8),
    [...EVIDENCE_IDENTITY_KEYS],
  );
  assert.equal(interpreted.result.provenance.validatorExecutedByAsl, false);
});

test("exact admitted not_evaluable projection becomes not-evaluable with missing proof", () => {
  const interpreted = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({
      terminalStatus: "not_evaluable",
      reason: "subject unavailable",
    }),
  });
  assertContractIdentity(interpreted);
  assert.equal(interpreted.outcome, "not_evaluable");
  if (interpreted.outcome !== "not_evaluable") {
    throw new Error("expected not_evaluable");
  }
  if (interpreted.result.kind !== "not_evaluable") {
    throw new Error("expected not_evaluable");
  }
  assert.equal(interpreted.result.reason, "subject unavailable");
  assert.equal(interpreted.result.missingProof.length, 1);
  assert.equal(
    interpreted.result.missingProof[0]?.reason,
    "subject unavailable",
  );
  assertEvidenceOrder(interpreted.result.missingProof[0]!);
  assert.deepEqual(
    Object.keys(interpreted.result.missingProof[0] ?? {}).slice(0, 8),
    [...EVIDENCE_IDENTITY_KEYS],
  );
  assert.equal(interpreted.result.provenance.validatorExecutedByAsl, false);
});

test("assertion and validation-contract mismatch is outside-contract", () => {
  const mismatched = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({
      assertionId: "foreign.assertion",
    }),
  });
  assertContractIdentity(mismatched);
  assert.equal(mismatched.outcome, "outside_contract");
  assert.equal(mismatched.result, null);

  const contractMismatch = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({
      validationContract: "foreign.contract",
    }),
  });
  assertContractIdentity(contractMismatch);
  assert.equal(contractMismatch.outcome, "outside_contract");
  assert.equal(
    contractMismatch.reason,
    "assertion id or validation contract does not bind the admitted projection",
  );
});

test("malformed extra missing keys wrong status and proxy inputs are outside-contract", () => {
  const extra = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({ extra: true }),
  });
  assert.equal(extra.outcome, "outside_contract");
  assert.equal(
    extra.reason,
    "admitted projection is malformed, synthesized, foreign, or not an exact admitted validator-result record",
  );

  const missing = admittedProjection();
  delete (missing as { reason?: string }).reason;
  assert.equal(
    interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: missing,
    }).outcome,
    "outside_contract",
  );

  assert.equal(
    interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjection({ terminalStatus: "not_applicable" }),
    }).outcome,
    "outside_contract",
  );

  assert.equal(
    interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjection({ terminalStatus: "changed" }),
    }).outcome,
    "outside_contract",
  );

  const spoof = {
    get assertionId() {
      return "assertion.validated.alpha";
    },
  };
  assert.equal(
    interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: spoof,
    }).outcome,
    "outside_contract",
  );
});

test("exact-key getters proxies and mutation attempts cannot become supported", () => {
  const getterProjection: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(admittedProjection())) {
    Object.defineProperty(getterProjection, key, {
      enumerable: true,
      configurable: true,
      get() {
        return value;
      },
    });
  }
  const getterInterpreted = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: getterProjection,
  });
  assert.equal(getterInterpreted.outcome, "outside_contract");
  assert.equal(getterInterpreted.result, null);

  const mutating: Record<string, unknown> = admittedProjection({
    terminalStatus: "failed",
    reason: "will mutate",
  });
  const proxy = new Proxy(mutating, {
    get(target, property, receiver) {
      if (property === "terminalStatus") {
        target.terminalStatus = "passed";
        return "passed";
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const proxyInterpreted = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: proxy,
  });
  assert.equal(proxyInterpreted.outcome, "outside_contract");
  assert.notEqual(proxyInterpreted.outcome, "supported");

  const hostile = Object.create({
    assertionId: "assertion.validated.alpha",
  });
  Object.assign(hostile, admittedProjection());
  assert.equal(
    interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: hostile,
    }).outcome,
    "outside_contract",
  );
});

test("null array primitive empty and whitespace identity fields are outside-contract", () => {
  for (const admittedProjectionInput of [null, [], "passed", 1, true, undefined]) {
    const interpreted = interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjectionInput,
    });
    assert.equal(interpreted.outcome, "outside_contract");
    assert.equal(interpreted.result, null);
  }

  for (const key of [
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
    "reason",
  ] as const) {
    const empty = interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjection({ [key]: "" }),
    });
    assert.equal(empty.outcome, "outside_contract");

    const whitespace = interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjection({ [key]: "   " }),
    });
    assert.equal(whitespace.outcome, "outside_contract");
  }
});

test("evidence identities stay detached and stably ordered from admitted subject report result", () => {
  const source = admittedProjection();
  const interpreted = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: source,
  });
  if (interpreted.outcome !== "supported") {
    throw new Error("expected supported");
  }
  if (interpreted.result.kind !== "supported") {
    throw new Error("expected supported");
  }
  source.subjectPath = "mutated/subject.json";
  source.reportPath = "mutated/report.json";
  source.resultPath = "mutated/result.json";
  const [first] = interpreted.result.matchedEvidence;
  assertEvidenceOrder(first!);
  assert.deepEqual(Object.keys(first ?? {}), [...EVIDENCE_IDENTITY_KEYS]);
  assertContractIdentity(interpreted);
});

test("terminal status exhaustiveness never falls through to a real not-evaluable result", () => {
  for (const status of ["passed", "failed", "not_evaluable"] as const) {
    const interpreted = interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjection({
        terminalStatus: status,
        reason: "status coverage",
      }),
    });
    assert.notEqual(interpreted.outcome, "outside_contract");
    if (status === "passed") {
      assert.equal(interpreted.outcome, "supported");
    } else if (status === "failed") {
      assert.equal(interpreted.outcome, "rejected");
    } else {
      assert.equal(interpreted.outcome, "not_evaluable");
    }
  }

  const impossible = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({
      terminalStatus: "not_applicable",
    }),
  });
  assert.equal(impossible.outcome, "outside_contract");
  assert.equal(impossible.result, null);
});
