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

const VALIDATOR_HASH = "11".repeat(32);
const SUBJECT_HASH = "22".repeat(32);
const REPORT_HASH = "33".repeat(32);
const RESULT_HASH = "44".repeat(32);

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
    artifactKind: "video",
    validatorProducer: "external.validator",
    validatorVersion: "1.0.0",
    validatorHash: VALIDATOR_HASH,
    subjectPath: "evidence/subject.json",
    subjectHash: SUBJECT_HASH,
    reportPath: "evidence/report.json",
    reportHash: REPORT_HASH,
    resultPath: "evidence/result.json",
    resultHash: RESULT_HASH,
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
  assert.equal(interpreted.result.provenance.validatorHash, VALIDATOR_HASH);
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
  assert.equal(interpreted.result.kind, "rejected");
  if (interpreted.result.kind !== "rejected") {
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
    "assertion id, kind, artifact kind, or validation contract does not bind the admitted projection",
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

function assertRecursivelyFrozen(value: object): void {
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) {
    if (nested !== null && typeof nested === "object") {
      assertRecursivelyFrozen(nested);
    }
  }
}

test("every interpretation outcome is recursively frozen and detached from input", () => {
  const passedSource = admittedProjection();
  const passed = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: passedSource,
  });
  assert.equal(passed.outcome, "supported");
  assertRecursivelyFrozen(passed);
  passedSource.subjectPath = "mutated/subject.json";
  passedSource.validatorProducer = "mutated.validator";
  if (passed.outcome !== "supported") {
    throw new Error("expected supported");
  }
  const passedResult = passed.result;
  assert.equal(passedResult.kind, "supported");
  if (passedResult.kind !== "supported") {
    throw new Error("expected supported");
  }
  assert.equal(
    passedResult.matchedEvidence[0]?.subjectPath,
    "evidence/subject.json",
  );
  assert.equal(passedResult.provenance.validatorProducer, "external.validator");
  assert.throws(() => {
    (passedResult.matchedEvidence as unknown as { push: (value: unknown) => void }).push(
      {},
    );
  }, TypeError);
  assert.throws(() => {
    (passedResult.matchedEvidence[0] as { subjectPath: string }).subjectPath =
      "mutated";
  }, TypeError);
  assert.throws(() => {
    (passedResult.provenance as { validatorProducer: string }).validatorProducer =
      "x";
  }, TypeError);

  const failedSource = admittedProjection({
    terminalStatus: "failed",
    reason: "schema mismatch",
  });
  const rejected = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: failedSource,
  });
  assert.equal(rejected.outcome, "rejected");
  assertRecursivelyFrozen(rejected);
  failedSource.reason = "mutated";
  if (rejected.outcome !== "rejected") {
    throw new Error("expected rejected");
  }
  const rejectedResult = rejected.result;
  assert.equal(rejectedResult.kind, "rejected");
  if (rejectedResult.kind !== "rejected") {
    throw new Error("expected rejected");
  }
  assert.equal(rejectedResult.rejectedEvidence[0]?.reason, "schema mismatch");
  assert.throws(() => {
    (rejectedResult.rejectedEvidence[0] as { reason: string }).reason = "x";
  }, TypeError);

  const missingSource = admittedProjection({
    terminalStatus: "not_evaluable",
    reason: "subject unavailable",
  });
  const missing = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: missingSource,
  });
  assert.equal(missing.outcome, "not_evaluable");
  assertRecursivelyFrozen(missing);
  missingSource.reason = "mutated";
  if (missing.outcome !== "not_evaluable") {
    throw new Error("expected not_evaluable");
  }
  const missingResult = missing.result;
  assert.equal(missingResult.kind, "not_evaluable");
  if (missingResult.kind !== "not_evaluable") {
    throw new Error("expected not_evaluable");
  }
  assert.equal(missingResult.reason, "subject unavailable");
  assert.equal(missingResult.missingProof[0]?.reason, "subject unavailable");
  assert.throws(() => {
    (missingResult.missingProof as unknown as { push: (value: unknown) => void }).push({});
  }, TypeError);

  const outside = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: null,
  });
  assert.equal(outside.outcome, "outside_contract");
  assertRecursivelyFrozen(outside);
  assert.throws(() => {
    (outside as { reason: string }).reason = "mutated";
  }, TypeError);
});

test("wrong assertion kind and artifactKind mismatch are outside-contract", () => {
  const wrongKind = interpretAdmittedValidatedEvidenceResult({
    assertion: {
      ...assertion,
      kind: "presence",
    } as unknown as ValidatedEvidenceAssertion,
    admittedProjection: admittedProjection(),
  });
  assertContractIdentity(wrongKind);
  assert.equal(wrongKind.outcome, "outside_contract");
  assert.equal(wrongKind.result, null);

  const artifactKindMismatch = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection({ artifactKind: "logs" }),
  });
  assertContractIdentity(artifactKindMismatch);
  assert.equal(artifactKindMismatch.outcome, "outside_contract");
  assert.equal(artifactKindMismatch.result, null);
  assert.equal(
    artifactKindMismatch.reason,
    "assertion id, kind, artifact kind, or validation contract does not bind the admitted projection",
  );
});

test("omitted artifactKind cannot bind and exact artifactKind still binds", () => {
  const omitted = { ...assertion };
  delete (omitted as { artifactKind?: string }).artifactKind;
  const omittedInterpreted = interpretAdmittedValidatedEvidenceResult({
    assertion: omitted as ValidatedEvidenceAssertion,
    admittedProjection: admittedProjection(),
  });
  assertContractIdentity(omittedInterpreted);
  assert.equal(omittedInterpreted.outcome, "outside_contract");
  assert.equal(omittedInterpreted.result, null);

  const bound = interpretAdmittedValidatedEvidenceResult({
    assertion,
    admittedProjection: admittedProjection(),
  });
  assertContractIdentity(bound);
  assert.equal(bound.outcome, "supported");
  if (bound.outcome !== "supported") {
    throw new Error("expected supported");
  }
  assert.equal(bound.result.kind, "supported");
});

test("padded control unsafe path malformed hash and throwing accessors are outside-contract", () => {
  const cases: Array<readonly [string, string]> = [
    ["assertionId", " assertion.validated.alpha"],
    ["assertionId", "assertion.validated.alpha "],
    ["assertionId", "assertion.validated.alpha\u0007"],
    ["subjectPath", "../evidence/subject.json"],
    ["subjectPath", "evidence/subject.json/"],
    ["subjectPath", "evidence/./subject.json"],
    ["subjectPath", "."],
    ["subjectPath", ".."],
    ["subjectPath", "evidence//subject.json"],
    ["subjectPath", "/evidence/subject.json"],
    ["subjectPath", "C:/evidence/subject.json"],
    ["subjectPath", "evidence\\subject.json"],
    ["subjectPath", "file:evidence/subject.json"],
    ["subjectHash", "AA".repeat(32)],
    ["subjectHash", "zz".repeat(32)],
    ["subjectHash", "22".repeat(31)],
    ["validatorHash", "hash.validator"],
    ["reason", " validator passed"],
  ];
  for (const [key, value] of cases) {
    const interpreted = interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admittedProjection({ [key]: value }),
    });
    assert.equal(interpreted.outcome, "outside_contract", `${key}=${value}`);
    assert.equal(interpreted.result, null);
  }

  const throwingInput: Record<string, unknown> = {};
  Object.defineProperty(throwingInput, "assertion", {
    enumerable: true,
    get() {
      throw new Error("assertion accessor");
    },
  });
  Object.defineProperty(throwingInput, "admittedProjection", {
    enumerable: true,
    get() {
      throw new Error("projection accessor");
    },
  });
  const interpreted = interpretAdmittedValidatedEvidenceResult(
    throwingInput as {
      readonly assertion: ValidatedEvidenceAssertion;
      readonly admittedProjection: unknown;
    },
  );
  assert.equal(interpreted.outcome, "outside_contract");
  assert.equal(interpreted.result, null);
});

test("identity legal under identity rules but not path rules remains interpretable when bound", () => {
  const identityLegalId = "file:assertion.validated.alpha";
  const identityLegalContract = "C:asl.validation.contract.v1";
  const identityLegalProducer = "external.validator/";
  const identityLegalVersion = "1.0.0/./build";
  const interpreted = interpretAdmittedValidatedEvidenceResult({
    assertion: {
      ...assertion,
      id: identityLegalId,
      validationContract: identityLegalContract,
    },
    admittedProjection: admittedProjection({
      assertionId: identityLegalId,
      validationContract: identityLegalContract,
      validatorProducer: identityLegalProducer,
      validatorVersion: identityLegalVersion,
    }),
  });
  assertContractIdentity(interpreted);
  assert.equal(interpreted.outcome, "supported");
  if (interpreted.outcome !== "supported") {
    throw new Error("expected supported");
  }
  assert.equal(
    interpreted.result.provenance.validatorProducer,
    identityLegalProducer,
  );
  assert.equal(interpreted.result.provenance.validatorVersion, identityLegalVersion);
  assert.equal(interpreted.result.validationContract, identityLegalContract);
});

test("null-prototype class-instance and proxy inputs stay outside-contract without throwing", () => {
  class ProjectionHost {}
  const classInstance = Object.assign(new ProjectionHost(), admittedProjection());
  const nullPrototype = Object.assign(
    Object.create(null) as Record<string, unknown>,
    admittedProjection(),
  );
  const proxyProjection = new Proxy(admittedProjection(), {});
  const classAssertion = Object.assign(new ProjectionHost(), assertion);
  const nullPrototypeAssertion = Object.assign(
    Object.create(null) as Record<string, unknown>,
    assertion,
  );
  const proxyAssertion = new Proxy(assertion, {});
  const nullPrototypeInput = Object.assign(Object.create(null) as Record<string, unknown>, {
    assertion,
    admittedProjection: admittedProjection(),
  });
  const classInput = Object.assign(new ProjectionHost(), {
    assertion,
    admittedProjection: admittedProjection(),
  });
  const proxyInput = new Proxy(
    { assertion, admittedProjection: admittedProjection() },
    {},
  );

  for (const admitted of [classInstance, nullPrototype, proxyProjection]) {
    const interpreted = interpretAdmittedValidatedEvidenceResult({
      assertion,
      admittedProjection: admitted,
    });
    assert.equal(interpreted.outcome, "outside_contract");
    assert.equal(interpreted.result, null);
  }

  for (const nestedAssertion of [classAssertion, nullPrototypeAssertion, proxyAssertion]) {
    const interpreted = interpretAdmittedValidatedEvidenceResult({
      assertion: nestedAssertion as ValidatedEvidenceAssertion,
      admittedProjection: admittedProjection(),
    });
    assert.equal(interpreted.outcome, "outside_contract");
    assert.equal(interpreted.result, null);
  }

  for (const input of [nullPrototypeInput, classInput, proxyInput]) {
    const interpreted = interpretAdmittedValidatedEvidenceResult(
      input as {
        readonly assertion: ValidatedEvidenceAssertion;
        readonly admittedProjection: unknown;
      },
    );
    assert.equal(interpreted.outcome, "outside_contract");
    assert.equal(interpreted.result, null);
  }
}); // fail-closed hostile objects
