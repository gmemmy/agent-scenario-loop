import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildScenarioClaimHash } from "../claim-contract.js";
import type {
  BoundedCountExpectation,
  ClaimAssertionResult,
  ClaimAuthority,
  ClaimObservationWindow,
  ScenarioClaimAssertion,
  ScenarioClaimDefinition,
  WindowedClaimAuthority,
} from "../claim-contract.js";
import {
  inspectClaimAssertionResultSet,
  type ClaimAssertionCandidateEnvelope,
  type ClaimAssertionKind,
} from "../claim-assertion-result-set.js";

const POINT_AUTHORITY: ClaimAuthority = {
  role: "app",
  producerId: "truth",
  evidenceSelector: "events",
  requiredStrength: "observed",
  completeness: "point",
};

const WINDOWED_AUTHORITY: WindowedClaimAuthority = {
  role: "runner",
  producerId: "observer",
  evidenceSelector: "counts",
  requiredStrength: "verified",
  completeness: "bounded",
};

const WINDOW: ClaimObservationWindow = {
  from: "start",
  to: "end",
  completeSourceRequired: true,
};

const KINDS: readonly ClaimAssertionKind[] = [
  "eventOccurrence",
  "eventOrder",
  "terminalState",
  "boundedCount",
  "absence",
  "validatedEvidence",
];

function makeAssertions(): ScenarioClaimAssertion[] {
  return [
    {
      id: "a1",
      kind: "eventOccurrence",
      authority: POINT_AUTHORITY,
      event: "opened",
    },
    {
      id: "a2",
      kind: "eventOrder",
      authority: POINT_AUTHORITY,
      beforeEvent: "opened",
      afterEvent: "closed",
    },
    {
      id: "a3",
      kind: "terminalState",
      authority: POINT_AUTHORITY,
      path: "status",
      expected: "ready",
    },
    {
      id: "a4",
      kind: "boundedCount",
      authority: WINDOWED_AUTHORITY,
      selector: "retry",
      observationWindow: WINDOW,
      minimum: 0,
      maximum: 2,
    },
    {
      id: "a5",
      kind: "absence",
      authority: WINDOWED_AUTHORITY,
      selector: "error",
      observationWindow: WINDOW,
    },
    {
      id: "a6",
      kind: "validatedEvidence",
      authority: POINT_AUTHORITY,
      artifactKind: "logs",
      validationContract: "log-schema",
    },
  ];
}

function makeClaim(): ScenarioClaimDefinition {
  const assertions = makeAssertions();
  const first = assertions[0];
  if (first === undefined) {
    throw new Error("expected assertions");
  }
  return {
    id: "claim-inventory",
    role: "mandatory",
    applicability: { platforms: ["ios"] },
    closes: { phases: ["done"] },
    assertions: [first, ...assertions.slice(1)],
  };
}

function evidence(): [{ path: string }] {
  return [{ path: "evidence/log.json" }];
}

function makeResult(kind: ClaimAssertionKind, assertionId: string): ClaimAssertionResult {
  switch (kind) {
    case "eventOccurrence":
      return {
        assertionId,
        assertionKind: "eventOccurrence",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { event: "opened" },
        observed: { event: "opened", matchedEvidence: "evt-1" },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      };
    case "eventOrder":
      return {
        assertionId,
        assertionKind: "eventOrder",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { beforeEvent: "opened", afterEvent: "closed" },
        observed: { beforeEvidence: "evt-1", afterEvidence: "evt-2", relation: "before" },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      };
    case "terminalState":
      return {
        assertionId,
        assertionKind: "terminalState",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { path: "status", value: "ready" },
        observed: { path: "status", value: "ready" },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      };
    case "boundedCount":
      return {
        assertionId,
        assertionKind: "boundedCount",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: {
          selector: "retry",
          observationWindow: WINDOW,
          minimum: 0,
          maximum: 2,
        },
        observed: { selector: "retry", count: 1 },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      };
    case "absence":
      return {
        assertionId,
        assertionKind: "absence",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { selector: "error", observationWindow: WINDOW },
        observed: { selector: "error", count: 0 },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      };
    case "validatedEvidence":
      return {
        assertionId,
        assertionKind: "validatedEvidence",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { artifactKind: "logs", validationContract: "log-schema" },
        observed: {
          artifactKind: "logs",
          validationContract: "log-schema",
          matchedEvidence: "logs.json",
          validationStatus: "passed",
        },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      };
  }
}

function makeCandidate(
  claim: ScenarioClaimDefinition,
  assertionIndex: number,
  overrides: Partial<ClaimAssertionCandidateEnvelope> = {},
): ClaimAssertionCandidateEnvelope {
  const assertion = claim.assertions[assertionIndex];
  if (assertion === undefined) {
    throw new Error("missing assertion");
  }
  const result = overrides.result ?? makeResult(assertion.kind, assertion.id);
  return {
    candidateId: overrides.candidateId ?? `c${assertionIndex + 1}`,
    claimId: overrides.claimId ?? claim.id,
    claimHash: overrides.claimHash ?? buildScenarioClaimHash(claim),
    assertionId: overrides.assertionId ?? assertion.id,
    assertionKind: overrides.assertionKind ?? assertion.kind,
    result,
  };
}

function completeCandidates(
  claim: ScenarioClaimDefinition,
  resultOverrides: { readonly [index: number]: ClaimAssertionResult | undefined } = {},
): ClaimAssertionCandidateEnvelope[] {
  return claim.assertions.map((_, index) => {
    const result = resultOverrides[index];
    if (result === undefined) {
      return makeCandidate(claim, index);
    }
    return makeCandidate(claim, index, { result });
  });
}

function boundedCountAssertion(
  minimum: number | undefined,
  maximum: number | undefined,
): ScenarioClaimAssertion {
  if (minimum !== undefined && maximum !== undefined) {
    return {
      id: "a4",
      kind: "boundedCount",
      authority: WINDOWED_AUTHORITY,
      selector: "retry",
      observationWindow: WINDOW,
      minimum,
      maximum,
    };
  }
  if (minimum !== undefined) {
    return {
      id: "a4",
      kind: "boundedCount",
      authority: WINDOWED_AUTHORITY,
      selector: "retry",
      observationWindow: WINDOW,
      minimum,
    };
  }
  if (maximum !== undefined) {
    return {
      id: "a4",
      kind: "boundedCount",
      authority: WINDOWED_AUTHORITY,
      selector: "retry",
      observationWindow: WINDOW,
      maximum,
    };
  }
  throw new Error("boundedCount requires a bound");
}

function claimWithBoundedCount(
  minimum: number | undefined,
  maximum: number | undefined,
): ScenarioClaimDefinition {
  const base = makeClaim();
  const first = base.assertions[0];
  if (first === undefined) {
    throw new Error("expected assertions");
  }
  return {
    ...base,
    assertions: [first, ...base.assertions.slice(1, 3), boundedCountAssertion(minimum, maximum), ...base.assertions.slice(4)],
  };
}

function boundedCountExpected(
  minimum: number | undefined,
  maximum: number | undefined,
  selector: string,
): BoundedCountExpectation {
  if (minimum !== undefined && maximum !== undefined) {
    return { selector, observationWindow: WINDOW, minimum, maximum };
  }
  if (minimum !== undefined) {
    return { selector, observationWindow: WINDOW, minimum };
  }
  if (maximum !== undefined) {
    return { selector, observationWindow: WINDOW, maximum };
  }
  throw new Error("boundedCount requires a bound");
}

function boundedCountResult(
  status: "supported" | "rejected",
  count: number,
  minimum: number | undefined,
  maximum: number | undefined,
  selector = "retry",
): ClaimAssertionResult {
  const expected = boundedCountExpected(minimum, maximum, selector);
  if (status === "supported") {
    return {
      assertionId: "a4",
      assertionKind: "boundedCount",
      status: "supported",
      reasonCode: "all_assertions_supported",
      expected,
      observed: { selector, count },
      evidenceReferences: evidence(),
      rejectedEvidence: [],
      missingProof: [],
    };
  }
  return {
    assertionId: "a4",
    assertionKind: "boundedCount",
    status: "rejected",
    reasonCode: "authoritative_evidence_rejected",
    expected,
    observed: { selector, count },
    evidenceReferences: evidence(),
    rejectedEvidence: ["count-out-of-bounds"],
    missingProof: [],
  };
}

describe("inspectClaimAssertionResultSet", () => {
  it("builds a complete authored-order inventory across all six kinds", () => {
    const claim = makeClaim();
    const candidates = [5, 4, 3, 2, 1, 0].map((index) => makeCandidate(claim, index));
    const inspection = inspectClaimAssertionResultSet({ claim, candidates });
    assert.equal(inspection.status, "complete");
    if (inspection.status !== "complete") {
      return;
    }
    assert.deepEqual(
      inspection.results.map((result) => result.assertionId),
      claim.assertions.map((assertion) => assertion.id),
    );
    assert.deepEqual(
      inspection.results.map((result) => result.assertionKind),
      KINDS,
    );
    assert.equal(inspection.candidates.length, 6);
    assert.equal(inspection.claimHash, buildScenarioClaimHash(claim));
  });

  it("fails closed on missing, duplicate, foreign, kind, hash, and id mismatches", () => {
    const claim = makeClaim();
    const candidates = [
      makeCandidate(claim, 0),
      makeCandidate(claim, 0, { candidateId: "dup" }),
      makeCandidate(claim, 1, {
        assertionKind: "absence",
        result: makeResult("absence", "a2"),
      }),
      makeCandidate(claim, 2, { claimId: "other" }),
      makeCandidate(claim, 3, {
        claimHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      makeCandidate(claim, 4, {
        assertionId: "foreign",
        result: makeResult("absence", "foreign"),
      }),
    ];
    const inspection = inspectClaimAssertionResultSet({ claim, candidates });
    assert.equal(inspection.status, "incoherent");
    if (inspection.status !== "incoherent") {
      return;
    }
    assert.ok(inspection.reasons.some((reason) => reason.startsWith("missing_assertion:")));
    assert.ok(inspection.reasons.includes("duplicate_assertion:a1"));
    assert.ok(inspection.reasons.some((reason) => reason.startsWith("foreign_assertion:")));
    assert.ok(inspection.reasons.some((reason) => reason.startsWith("wrong_kind:")));
    assert.ok(inspection.reasons.some((reason) => reason.startsWith("claim_hash_mismatch:")));
    assert.ok(inspection.reasons.some((reason) => reason.startsWith("foreign_claim_id:")));
    const sorted = [...inspection.reasons].sort();
    assert.deepEqual(inspection.reasons, sorted);
  });

  it("never selects a winner among conflicting statuses or observed values", () => {
    const claim = makeClaim();
    const rejectedOrder: ClaimAssertionResult = {
      assertionId: "a2",
      assertionKind: "eventOrder",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { beforeEvent: "opened", afterEvent: "closed" },
      observed: { beforeEvidence: "evt-2", afterEvidence: "evt-1", relation: "after" },
      evidenceReferences: evidence(),
      rejectedEvidence: ["order-reversed"],
      missingProof: [],
    };
    const countTwo: ClaimAssertionResult = {
      assertionId: "a4",
      assertionKind: "boundedCount",
      status: "supported",
      reasonCode: "all_assertions_supported",
      expected: {
        selector: "retry",
        observationWindow: WINDOW,
        minimum: 0,
        maximum: 2,
      },
      observed: { selector: "retry", count: 2 },
      evidenceReferences: evidence(),
      rejectedEvidence: [],
      missingProof: [],
    };
    const candidates = [
      makeCandidate(claim, 1, { result: makeResult("eventOrder", "a2") }),
      makeCandidate(claim, 1, { candidateId: "c2b", result: rejectedOrder }),
      makeCandidate(claim, 3, { result: makeResult("boundedCount", "a4") }),
      makeCandidate(claim, 3, { candidateId: "c4b", result: countTwo }),
      makeCandidate(claim, 0),
      makeCandidate(claim, 2),
      makeCandidate(claim, 4),
      makeCandidate(claim, 5),
    ];
    const inspection = inspectClaimAssertionResultSet({ claim, candidates });
    assert.equal(inspection.status, "incoherent");
    if (inspection.status !== "incoherent") {
      return;
    }
    assert.ok(inspection.reasons.includes("conflicting_status:a2"));
    assert.ok(inspection.reasons.includes("conflicting_observed_value:a4"));
    assert.ok(inspection.reasons.includes("duplicate_assertion:a2"));
    assert.ok(inspection.reasons.includes("duplicate_assertion:a4"));
  });

  it("detaches output from caller mutation and rejects malformed input", () => {
    const claim = makeClaim();
    const candidates = KINDS.map((_, index) => ({ ...makeCandidate(claim, index) }));
    const inspection = inspectClaimAssertionResultSet({ claim, candidates });
    const firstCandidate = candidates[0];
    claim.id = "mutated";
    if (firstCandidate !== undefined) {
      firstCandidate.candidateId = "mutated";
    }
    assert.equal(inspection.status, "complete");
    if (inspection.status === "complete") {
      assert.equal(inspection.claimId, "claim-inventory");
      assert.equal(inspection.candidates[0]?.candidateId, "c1");
    }
    const malformed = inspectClaimAssertionResultSet({
      claim: { id: "" } as ScenarioClaimDefinition,
      candidates: [],
    });
    assert.equal(malformed.status, "outside_contract");
    if (malformed.status === "outside_contract") {
      assert.deepEqual(malformed.reasons, ["malformed_claim"]);
    }
    assert.equal(Object.isFrozen(malformed), true);
    if (malformed.status === "outside_contract") {
      assert.equal(Object.isFrozen(malformed.reasons), true);
    }
  });

  it("rejects extra or missing inspect wrapper keys without reading unrelated values", () => {
    const claim = makeClaim();
    const candidates = KINDS.map((_, index) => makeCandidate(claim, index));
    let claimReads = 0;
    let candidateReads = 0;
    let extraReads = 0;
    const extraWrapper = new Proxy(
      { claim, candidates, extra: true },
      {
        get(target, property, receiver) {
          if (property === "claim") {
            claimReads += 1;
          }
          if (property === "candidates") {
            candidateReads += 1;
          }
          if (property === "extra") {
            extraReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as unknown as { claim: ScenarioClaimDefinition; candidates: ClaimAssertionCandidateEnvelope[] };
    const extra = inspectClaimAssertionResultSet(extraWrapper);
    assert.equal(extra.status, "outside_contract");
    if (extra.status === "outside_contract") {
      assert.deepEqual(extra.reasons, ["malformed_input"]);
    }
    assert.equal(claimReads, 0);
    assert.equal(candidateReads, 0);
    assert.equal(extraReads, 0);

    const extraPlain = inspectClaimAssertionResultSet({
      claim,
      candidates,
      extra: true,
    } as unknown as { claim: ScenarioClaimDefinition; candidates: ClaimAssertionCandidateEnvelope[] });
    assert.equal(extraPlain.status, "outside_contract");
    if (extraPlain.status === "outside_contract") {
      assert.deepEqual(extraPlain.reasons, ["malformed_input"]);
    }

    const missingCandidates = inspectClaimAssertionResultSet({
      claim,
    } as unknown as { claim: ScenarioClaimDefinition; candidates: ClaimAssertionCandidateEnvelope[] });
    assert.equal(missingCandidates.status, "outside_contract");
    if (missingCandidates.status === "outside_contract") {
      assert.deepEqual(missingCandidates.reasons, ["malformed_input"]);
    }

    const missingClaim = inspectClaimAssertionResultSet({
      candidates,
    } as unknown as { claim: ScenarioClaimDefinition; candidates: ClaimAssertionCandidateEnvelope[] });
    assert.equal(missingClaim.status, "outside_contract");
    if (missingClaim.status === "outside_contract") {
      assert.deepEqual(missingClaim.reasons, ["malformed_input"]);
    }
  });

  it("rejects authored boundedCount when minimum is greater than maximum and accepts equal bounds", () => {
    const base = makeClaim();
    const first = base.assertions[0];
    const bounded = base.assertions[3];
    if (first === undefined || bounded === undefined || bounded.kind !== "boundedCount") {
      throw new Error("expected boundedCount assertion");
    }
    const inverted = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [
          first,
          ...base.assertions.slice(1, 3),
          { ...bounded, minimum: 3, maximum: 1 },
          ...base.assertions.slice(4),
        ],
      },
      candidates: [],
    });
    assert.equal(inverted.status, "outside_contract");
    if (inverted.status === "outside_contract") {
      assert.deepEqual(inverted.reasons, ["malformed_claim"]);
    }

    const equalClaim: ScenarioClaimDefinition = {
      ...base,
      assertions: [
        first,
        ...base.assertions.slice(1, 3),
        { ...bounded, minimum: 2, maximum: 2 },
        ...base.assertions.slice(4),
      ],
    };
    const equalResult: ClaimAssertionResult = {
      assertionId: "a4",
      assertionKind: "boundedCount",
      status: "supported",
      reasonCode: "all_assertions_supported",
      expected: {
        selector: "retry",
        observationWindow: WINDOW,
        minimum: 2,
        maximum: 2,
      },
      observed: { selector: "retry", count: 2 },
      evidenceReferences: evidence(),
      rejectedEvidence: [],
      missingProof: [],
    };
    const equal = inspectClaimAssertionResultSet({
      claim: equalClaim,
      candidates: [
        makeCandidate(equalClaim, 0),
        makeCandidate(equalClaim, 1),
        makeCandidate(equalClaim, 2),
        makeCandidate(equalClaim, 3, { result: equalResult }),
        makeCandidate(equalClaim, 4),
        makeCandidate(equalClaim, 5),
      ],
    });
    assert.equal(equal.status, "complete");
  });

  it("freezes complete, incoherent, and outside_contract envelopes against caller mutation", () => {
    const claim = makeClaim();
    const complete = inspectClaimAssertionResultSet({
      claim,
      candidates: KINDS.map((_, index) => makeCandidate(claim, index)),
    });
    assert.equal(Object.isFrozen(complete), true);
    if (complete.status === "complete") {
      assert.equal(Object.isFrozen(complete.results), true);
      assert.equal(Object.isFrozen(complete.candidates), true);
      assert.throws(() => {
        (complete.results as ClaimAssertionResult[]).push(makeResult("eventOccurrence", "a1"));
      }, TypeError);
      assert.equal(complete.results.length, 6);
    }

    const incoherent = inspectClaimAssertionResultSet({
      claim,
      candidates: [
        makeCandidate(claim, 0),
        makeCandidate(claim, 0, { candidateId: "dup" }),
        makeCandidate(claim, 1),
        makeCandidate(claim, 2),
        makeCandidate(claim, 3),
        makeCandidate(claim, 4),
        makeCandidate(claim, 5),
      ],
    });
    assert.equal(Object.isFrozen(incoherent), true);
    if (incoherent.status === "incoherent") {
      assert.equal(Object.isFrozen(incoherent.reasons), true);
      assert.equal(Object.isFrozen(incoherent.candidates), true);
      assert.throws(() => {
        (incoherent.reasons as string[]).push("mutated");
      }, TypeError);
      assert.ok(!incoherent.reasons.includes("mutated"));
    }

    const outside = inspectClaimAssertionResultSet({
      claim: { id: "" } as ScenarioClaimDefinition,
      candidates: [],
    });
    assert.equal(outside.status, "outside_contract");
    assert.equal(Object.isFrozen(outside), true);
    if (outside.status === "outside_contract") {
      assert.equal(Object.isFrozen(outside.reasons), true);
      assert.deepEqual(outside.reasons, ["malformed_claim"]);
    }
  });

  it("does not collide evidence-reference uniqueness keys across schema-distinct path and sha pairs", () => {
    const claim = makeClaim();
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const collidingDelimiter = inspectClaimAssertionResultSet({
      claim,
      candidates: [
        makeCandidate(claim, 0, {
          result: {
            ...makeResult("eventOccurrence", "a1"),
            evidenceReferences: [
              { path: `evidence/log.json|${sha}` },
              { path: "evidence/log.json", sha256: sha },
            ],
          },
        }),
        makeCandidate(claim, 1),
        makeCandidate(claim, 2),
        makeCandidate(claim, 3),
        makeCandidate(claim, 4),
        makeCandidate(claim, 5),
      ],
    });
    assert.equal(collidingDelimiter.status, "complete");
  });

  it("rejects non-run-relative evidence paths and malformed sha256", () => {
    const claim = makeClaim();
    const invalidPaths = [
      "C:/evidence/log.json",
      "\\\\server\\share\\log.json",
      "/tmp/evidence/log.json",
      "../evidence/log.json",
      "evidence/../secret.json",
      "evidence\\log.json",
      "file:evidence/log.json",
      "FILE://evidence/log.json",
      " evidence/log.json",
      "evidence/log.json ",
      "",
    ];
    for (const path of invalidPaths) {
      const result = makeResult("eventOccurrence", "a1");
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, {
          0: { ...result, evidenceReferences: [{ path }] },
        }),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:0"]);
      }
    }
    const badSha = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, {
        0: {
          ...makeResult("eventOccurrence", "a1"),
          evidenceReferences: [
            {
              path: "evidence/log.json",
              sha256: "DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
            },
          ],
        },
      }),
    });
    assert.equal(badSha.status, "outside_contract");
    if (badSha.status === "outside_contract") {
      assert.deepEqual(badSha.reasons, ["malformed_candidate:0"]);
    }
  });

  it("rejects duplicate evidenceReferences, rejectedEvidence, and missingProof", () => {
    const claim = makeClaim();
    const supported = makeResult("eventOccurrence", "a1");
    const dupEvidence = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, {
        0: {
          ...supported,
          evidenceReferences: [{ path: "evidence/log.json" }, { path: "evidence/log.json" }],
        },
      }),
    });
    assert.equal(dupEvidence.status, "outside_contract");
    if (dupEvidence.status === "outside_contract") {
      assert.deepEqual(dupEvidence.reasons, ["malformed_candidate:0"]);
    }

    const rejected: ClaimAssertionResult = {
      assertionId: "a2",
      assertionKind: "eventOrder",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { beforeEvent: "opened", afterEvent: "closed" },
      observed: { beforeEvidence: "evt-2", afterEvidence: "evt-1", relation: "after" },
      evidenceReferences: evidence(),
      rejectedEvidence: ["order-reversed", "order-reversed"],
      missingProof: [],
    };
    const dupRejected = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 1: rejected }),
    });
    assert.equal(dupRejected.status, "outside_contract");
    if (dupRejected.status === "outside_contract") {
      assert.deepEqual(dupRejected.reasons, ["malformed_candidate:1"]);
    }

    const notEvaluable: ClaimAssertionResult = {
      assertionId: "a1",
      assertionKind: "eventOccurrence",
      status: "not_evaluable",
      reasonCode: "partial_evidence",
      expected: { event: "opened" },
      observed: null,
      evidenceReferences: [],
      rejectedEvidence: [],
      missingProof: ["window", "window"],
    };
    const dupMissing = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 0: notEvaluable }),
    });
    assert.equal(dupMissing.status, "outside_contract");
    if (dupMissing.status === "outside_contract") {
      assert.deepEqual(dupMissing.reasons, ["malformed_candidate:0"]);
    }
  });

  it("rejects fractional or negative bounded and absence counts", () => {
    const claim = makeClaim();
    const fractionalCount = {
      ...makeResult("boundedCount", "a4"),
      observed: { selector: "retry", count: 1.5 },
    } as ClaimAssertionResult;
    const fractional = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 3: fractionalCount }),
    });
    assert.equal(fractional.status, "outside_contract");
    if (fractional.status === "outside_contract") {
      assert.deepEqual(fractional.reasons, ["malformed_candidate:3"]);
    }

    const negativeCount = {
      ...makeResult("boundedCount", "a4"),
      observed: { selector: "retry", count: -1 },
    } as ClaimAssertionResult;
    const negative = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 3: negativeCount }),
    });
    assert.equal(negative.status, "outside_contract");
    if (negative.status === "outside_contract") {
      assert.deepEqual(negative.reasons, ["malformed_candidate:3"]);
    }

    const absenceZeroRejected: ClaimAssertionResult = {
      assertionId: "a5",
      assertionKind: "absence",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { selector: "error", observationWindow: WINDOW },
      observed: { selector: "error", count: 0 },
      evidenceReferences: evidence(),
      rejectedEvidence: ["present"],
      missingProof: [],
    };
    const zeroRejected = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 4: absenceZeroRejected }),
    });
    assert.equal(zeroRejected.status, "outside_contract");
    if (zeroRejected.status === "outside_contract") {
      assert.deepEqual(zeroRejected.reasons, ["malformed_candidate:4"]);
    }

    const absenceNegativeCount = {
      ...makeResult("absence", "a5"),
      observed: { selector: "error", count: -1 },
    } as ClaimAssertionResult;
    const absenceNegative = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 4: absenceNegativeCount }),
    });
    assert.equal(absenceNegative.status, "outside_contract");
    if (absenceNegative.status === "outside_contract") {
      assert.deepEqual(absenceNegative.reasons, ["malformed_candidate:4"]);
    }
  });

  it("rejects malformed authored claim identifiers, duplicates, and unknown keys", () => {
    const base = makeClaim();
    const badId = inspectClaimAssertionResultSet({
      claim: { ...base, id: "Claim.Inventory" },
      candidates: [],
    });
    assert.equal(badId.status, "outside_contract");
    if (badId.status === "outside_contract") {
      assert.deepEqual(badId.reasons, ["malformed_claim"]);
    }

    const dupPlatforms = inspectClaimAssertionResultSet({
      claim: { ...base, applicability: { platforms: ["ios", "ios"] } },
      candidates: [],
    });
    assert.equal(dupPlatforms.status, "outside_contract");
    if (dupPlatforms.status === "outside_contract") {
      assert.deepEqual(dupPlatforms.reasons, ["malformed_claim"]);
    }

    const emptyClosure = inspectClaimAssertionResultSet({
      claim: { ...base, closes: { phases: [] as unknown as [string, ...string[]] } },
      candidates: [],
    });
    assert.equal(emptyClosure.status, "outside_contract");
    if (emptyClosure.status === "outside_contract") {
      assert.deepEqual(emptyClosure.reasons, ["malformed_claim"]);
    }

    const unknownApplicability = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        applicability: { platforms: ["ios"], extra: true } as unknown as ScenarioClaimDefinition["applicability"],
      },
      candidates: [],
    });
    assert.equal(unknownApplicability.status, "outside_contract");
    if (unknownApplicability.status === "outside_contract") {
      assert.deepEqual(unknownApplicability.reasons, ["malformed_claim"]);
    }

    const firstAssertion = base.assertions[0];
    if (firstAssertion === undefined) {
      throw new Error("expected assertion");
    }
    const unknownAssertion = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [
          { ...firstAssertion, extra: "nope" } as unknown as ScenarioClaimAssertion,
          ...base.assertions.slice(1),
        ],
      },
      candidates: [],
    });
    assert.equal(unknownAssertion.status, "outside_contract");
    if (unknownAssertion.status === "outside_contract") {
      assert.deepEqual(unknownAssertion.reasons, ["malformed_claim"]);
    }

    const dupVariants = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        applicability: { platforms: ["ios"], variants: ["phone", "phone"] },
      },
      candidates: [],
    });
    assert.equal(dupVariants.status, "outside_contract");
    if (dupVariants.status === "outside_contract") {
      assert.deepEqual(dupVariants.reasons, ["malformed_claim"]);
    }

    const dupClosure = inspectClaimAssertionResultSet({
      claim: { ...base, closes: { phases: ["done", "done"] } },
      candidates: [],
    });
    assert.equal(dupClosure.status, "outside_contract");
    if (dupClosure.status === "outside_contract") {
      assert.deepEqual(dupClosure.reasons, ["malformed_claim"]);
    }

    const unknownClosure = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        closes: { phases: ["done"], extra: true } as unknown as ScenarioClaimDefinition["closes"],
      },
      candidates: [],
    });
    assert.equal(unknownClosure.status, "outside_contract");
    if (unknownClosure.status === "outside_contract") {
      assert.deepEqual(unknownClosure.reasons, ["malformed_claim"]);
    }

    const emptyVariants = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        applicability: { platforms: ["ios"], variants: [] as unknown as [string, ...string[]] },
      },
      candidates: [],
    });
    assert.equal(emptyVariants.status, "outside_contract");
    if (emptyVariants.status === "outside_contract") {
      assert.deepEqual(emptyVariants.reasons, ["malformed_claim"]);
    }

    const badAssertionId = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [{ ...firstAssertion, id: "A1" }, ...base.assertions.slice(1)],
      },
      candidates: [],
    });
    assert.equal(badAssertionId.status, "outside_contract");
    if (badAssertionId.status === "outside_contract") {
      assert.deepEqual(badAssertionId.reasons, ["malformed_claim"]);
    }
  });

  it("rejects candidateId values that are not run-relative POSIX paths", () => {
    const claim = makeClaim();
    const invalidIds = [
      "/tmp/c1",
      "C:/c1",
      "..",
      "../c1",
      "c1/../secret",
      "c1\\id",
      "file:c1",
      "FILE://c1",
      " c1",
      "c1 ",
      "",
    ];
    for (const candidateId of invalidIds) {
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim).map((candidate, index) =>
          index === 0 ? makeCandidate(claim, 0, { candidateId }) : candidate,
        ),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:0"]);
      }
    }
  });

  it("fails closed when the same candidateId is reused across authored assertions", () => {
    const claim = makeClaim();
    const candidates = [
      makeCandidate(claim, 0, { candidateId: "shared/id" }),
      makeCandidate(claim, 1, { candidateId: "shared/id" }),
      makeCandidate(claim, 2),
      makeCandidate(claim, 3),
      makeCandidate(claim, 4),
      makeCandidate(claim, 5),
    ];
    const inspection = inspectClaimAssertionResultSet({ claim, candidates });
    assert.equal(inspection.status, "incoherent");
    if (inspection.status !== "incoherent") {
      return;
    }
    assert.ok(inspection.reasons.includes("duplicate_candidate_id:shared/id"));
  });

  it("fails closed on authored expectation mismatches for every assertion kind", () => {
    const claim = makeClaim();
    const cases: Array<{ index: number; result: ClaimAssertionResult; candidateId: string; assertionId: string }> = [
      {
        index: 0,
        candidateId: "mismatch/a1",
        assertionId: "a1",
        result: {
          assertionId: "a1",
          assertionKind: "eventOccurrence",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: { event: "other" },
          observed: { event: "other", matchedEvidence: "evt-1" },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
      {
        index: 1,
        candidateId: "mismatch/a2",
        assertionId: "a2",
        result: {
          assertionId: "a2",
          assertionKind: "eventOrder",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: { beforeEvent: "opened", afterEvent: "other" },
          observed: { beforeEvidence: "evt-1", afterEvidence: "evt-2", relation: "before" },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
      {
        index: 2,
        candidateId: "mismatch/a3",
        assertionId: "a3",
        result: {
          assertionId: "a3",
          assertionKind: "terminalState",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: { path: "status", value: "other" },
          observed: { path: "status", value: "other" },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
      {
        index: 3,
        candidateId: "mismatch/a4-window",
        assertionId: "a4",
        result: {
          assertionId: "a4",
          assertionKind: "boundedCount",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: {
            selector: "retry",
            observationWindow: { from: "start", to: "elsewhere", completeSourceRequired: true },
            minimum: 0,
            maximum: 2,
          },
          observed: { selector: "retry", count: 1 },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
      {
        index: 3,
        candidateId: "mismatch/a4-bound",
        assertionId: "a4",
        result: {
          assertionId: "a4",
          assertionKind: "boundedCount",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: {
            selector: "retry",
            observationWindow: WINDOW,
            minimum: 0,
          },
          observed: { selector: "retry", count: 1 },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
      {
        index: 4,
        candidateId: "mismatch/a5",
        assertionId: "a5",
        result: {
          assertionId: "a5",
          assertionKind: "absence",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: { selector: "other", observationWindow: WINDOW },
          observed: { selector: "other", count: 0 },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
      {
        index: 5,
        candidateId: "mismatch/a6",
        assertionId: "a6",
        result: {
          assertionId: "a6",
          assertionKind: "validatedEvidence",
          status: "supported",
          reasonCode: "all_assertions_supported",
          expected: { artifactKind: "logs", validationContract: "other-schema" },
          observed: {
            artifactKind: "logs",
            validationContract: "other-schema",
            matchedEvidence: "logs.json",
            validationStatus: "passed",
          },
          evidenceReferences: evidence(),
          rejectedEvidence: [],
          missingProof: [],
        },
      },
    ];
    for (const testCase of cases) {
      const candidates = KINDS.map((_, index) =>
        index === testCase.index
          ? makeCandidate(claim, index, { candidateId: testCase.candidateId, result: testCase.result })
          : makeCandidate(claim, index),
      );
      const inspection = inspectClaimAssertionResultSet({ claim, candidates });
      assert.equal(inspection.status, "incoherent");
      if (inspection.status !== "incoherent") {
        continue;
      }
      assert.ok(
        inspection.reasons.includes(
          `authored_expectation_mismatch:${testCase.candidateId}:${testCase.assertionId}`,
        ),
      );
    }
  });

  it("rejects invalid candidate claim hashes", () => {
    const claim = makeClaim();
    const inspection = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim).map((candidate, index) =>
        index === 0 ? makeCandidate(claim, 0, { claimHash: "not-a-hash" }) : candidate,
      ),
    });
    assert.equal(inspection.status, "outside_contract");
    if (inspection.status === "outside_contract") {
      assert.deepEqual(inspection.reasons, ["malformed_candidate:0"]);
    }
  });

  it("does not treat equivalent key-order permutations as conflicting while duplicates remain incoherent", () => {
    const claim = makeClaim();
    const first = makeResult("eventOccurrence", "a1");
    const permuted = {
      reasonCode: first.reasonCode,
      missingProof: first.missingProof,
      rejectedEvidence: first.rejectedEvidence,
      evidenceReferences: first.evidenceReferences,
      observed: first.observed,
      expected: first.expected,
      status: first.status,
      assertionKind: first.assertionKind,
      assertionId: first.assertionId,
    } as ClaimAssertionResult;
    const candidates = [
      makeCandidate(claim, 0, { result: first }),
      makeCandidate(claim, 0, { candidateId: "c1b", result: permuted }),
      makeCandidate(claim, 1),
      makeCandidate(claim, 2),
      makeCandidate(claim, 3),
      makeCandidate(claim, 4),
      makeCandidate(claim, 5),
    ];
    const inspection = inspectClaimAssertionResultSet({ claim, candidates });
    assert.equal(inspection.status, "incoherent");
    if (inspection.status !== "incoherent") {
      return;
    }
    assert.ok(inspection.reasons.includes("duplicate_assertion:a1"));
    assert.ok(!inspection.reasons.includes("conflicting_status:a1"));
    assert.ok(!inspection.reasons.includes("conflicting_observed_value:a1"));
  });

  it("accepts supported and rejected terminalState results with matching paths and coherent values", () => {
    const claim = makeClaim();
    const supported = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim),
    });
    assert.equal(supported.status, "complete");

    const rejectedResult: ClaimAssertionResult = {
      assertionId: "a3",
      assertionKind: "terminalState",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { path: "status", value: "ready" },
      observed: { path: "status", value: "failed" },
      evidenceReferences: evidence(),
      rejectedEvidence: ["value-mismatch"],
      missingProof: [],
    };
    const rejected = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 2: rejectedResult }),
    });
    assert.equal(rejected.status, "complete");
    if (rejected.status === "complete") {
      assert.equal(rejected.results[2]?.status, "rejected");
      assert.deepEqual(rejected.results[2]?.observed, { path: "status", value: "failed" });
    }
  });

  it("rejects contradictory terminalState status and value pairings as outside_contract", () => {
    const claim = makeClaim();
    const contradictory: ClaimAssertionResult[] = [
      {
        assertionId: "a3",
        assertionKind: "terminalState",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { path: "status", value: "ready" },
        observed: { path: "status", value: "failed" },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      },
      {
        assertionId: "a3",
        assertionKind: "terminalState",
        status: "rejected",
        reasonCode: "authoritative_evidence_rejected",
        expected: { path: "status", value: "ready" },
        observed: { path: "status", value: "ready" },
        evidenceReferences: evidence(),
        rejectedEvidence: ["value-mismatch"],
        missingProof: [],
      },
      {
        assertionId: "a3",
        assertionKind: "terminalState",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { path: "status", value: "ready" },
        observed: { path: "other", value: "ready" },
        evidenceReferences: evidence(),
        rejectedEvidence: [],
        missingProof: [],
      },
      {
        assertionId: "a3",
        assertionKind: "terminalState",
        status: "rejected",
        reasonCode: "authoritative_evidence_rejected",
        expected: { path: "status", value: "ready" },
        observed: { path: "other", value: "failed" },
        evidenceReferences: evidence(),
        rejectedEvidence: ["value-mismatch"],
        missingProof: [],
      },
    ];
    for (const result of contradictory) {
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, { 2: result }),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:2"]);
      }
    }
  });

  it("accepts boundedCount min-only, max-only, and both-bound supported and rejected inventories", () => {
    const cases: Array<{
      minimum: number | undefined;
      maximum: number | undefined;
      status: "supported" | "rejected";
      count: number;
    }> = [
      { minimum: 1, maximum: undefined, status: "supported", count: 1 },
      { minimum: 1, maximum: undefined, status: "supported", count: 4 },
      { minimum: 1, maximum: undefined, status: "rejected", count: 0 },
      { minimum: undefined, maximum: 2, status: "supported", count: 0 },
      { minimum: undefined, maximum: 2, status: "supported", count: 2 },
      { minimum: undefined, maximum: 2, status: "rejected", count: 3 },
      { minimum: 0, maximum: 2, status: "supported", count: 0 },
      { minimum: 0, maximum: 2, status: "supported", count: 2 },
      { minimum: 0, maximum: 2, status: "rejected", count: 3 },
    ];
    for (const testCase of cases) {
      const claim = claimWithBoundedCount(testCase.minimum, testCase.maximum);
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, {
          3: boundedCountResult(testCase.status, testCase.count, testCase.minimum, testCase.maximum),
        }),
      });
      assert.equal(inspection.status, "complete");
      if (inspection.status === "complete") {
        assert.equal(inspection.results[3]?.status, testCase.status);
      }
    }
  });

  it("rejects boundedCount supported-outside and rejected-inside pairings as outside_contract", () => {
    const cases: Array<{
      minimum: number | undefined;
      maximum: number | undefined;
      status: "supported" | "rejected";
      count: number;
    }> = [
      { minimum: 1, maximum: undefined, status: "supported", count: 0 },
      { minimum: 1, maximum: undefined, status: "rejected", count: 4 },
      { minimum: undefined, maximum: 2, status: "supported", count: 5 },
      { minimum: undefined, maximum: 2, status: "rejected", count: 1 },
      { minimum: 0, maximum: 2, status: "supported", count: 3 },
      { minimum: 1, maximum: 2, status: "supported", count: 0 },
      { minimum: 0, maximum: 2, status: "rejected", count: 1 },
      { minimum: 0, maximum: 2, status: "rejected", count: 0 },
      { minimum: 0, maximum: 2, status: "rejected", count: 2 },
    ];
    for (const testCase of cases) {
      const claim = claimWithBoundedCount(testCase.minimum, testCase.maximum);
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, {
          3: boundedCountResult(testCase.status, testCase.count, testCase.minimum, testCase.maximum),
        }),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:3"]);
      }
    }
  });

  it("rejects selector mismatch for boundedCount and absence", () => {
    const claim = makeClaim();
    const boundedMismatch: ClaimAssertionResult = {
      assertionId: "a4",
      assertionKind: "boundedCount",
      status: "supported",
      reasonCode: "all_assertions_supported",
      expected: {
        selector: "retry",
        observationWindow: WINDOW,
        minimum: 0,
        maximum: 2,
      },
      observed: { selector: "other", count: 1 },
      evidenceReferences: evidence(),
      rejectedEvidence: [],
      missingProof: [],
    };
    const bounded = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 3: boundedMismatch }),
    });
    assert.equal(bounded.status, "outside_contract");
    if (bounded.status === "outside_contract") {
      assert.deepEqual(bounded.reasons, ["malformed_candidate:3"]);
    }

    const absenceSupportedMismatch: ClaimAssertionResult = {
      assertionId: "a5",
      assertionKind: "absence",
      status: "supported",
      reasonCode: "all_assertions_supported",
      expected: { selector: "error", observationWindow: WINDOW },
      observed: { selector: "other", count: 0 },
      evidenceReferences: evidence(),
      rejectedEvidence: [],
      missingProof: [],
    };
    const absenceSupported = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 4: absenceSupportedMismatch }),
    });
    assert.equal(absenceSupported.status, "outside_contract");
    if (absenceSupported.status === "outside_contract") {
      assert.deepEqual(absenceSupported.reasons, ["malformed_candidate:4"]);
    }

    const absenceRejectedMismatch: ClaimAssertionResult = {
      assertionId: "a5",
      assertionKind: "absence",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { selector: "error", observationWindow: WINDOW },
      observed: { selector: "other", count: 2 },
      evidenceReferences: evidence(),
      rejectedEvidence: ["present"],
      missingProof: [],
    };
    const absenceRejected = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, { 4: absenceRejectedMismatch }),
    });
    assert.equal(absenceRejected.status, "outside_contract");
    if (absenceRejected.status === "outside_contract") {
      assert.deepEqual(absenceRejected.reasons, ["malformed_candidate:4"]);
    }
  });

  it("rejects unsafe integer counts and bounds", () => {
    const claim = makeClaim();
    const unsafeValues = [Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5];
    for (const count of unsafeValues) {
      const unsafeCount = {
        ...makeResult("boundedCount", "a4"),
        observed: { selector: "retry", count },
      } as ClaimAssertionResult;
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, { 3: unsafeCount }),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:3"]);
      }

      const unsafeAbsence = {
        assertionId: "a5",
        assertionKind: "absence",
        status: "rejected",
        reasonCode: "authoritative_evidence_rejected",
        expected: { selector: "error", observationWindow: WINDOW },
        observed: { selector: "error", count },
        evidenceReferences: evidence(),
        rejectedEvidence: ["present"],
        missingProof: [],
      } as ClaimAssertionResult;
      const absenceInspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, { 4: unsafeAbsence }),
      });
      assert.equal(absenceInspection.status, "outside_contract");
      if (absenceInspection.status === "outside_contract") {
        assert.deepEqual(absenceInspection.reasons, ["malformed_candidate:4"]);
      }
    }

    const base = makeClaim();
    const first = base.assertions[0];
    const bounded = base.assertions[3];
    if (first === undefined || bounded === undefined || bounded.kind !== "boundedCount") {
      throw new Error("expected boundedCount assertion");
    }
    const unsafeBound = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [
          first,
          ...base.assertions.slice(1, 3),
          { ...bounded, minimum: Number.MAX_SAFE_INTEGER + 1, maximum: Number.MAX_SAFE_INTEGER + 1 },
          ...base.assertions.slice(4),
        ],
      },
      candidates: [],
    });
    assert.equal(unsafeBound.status, "outside_contract");
    if (unsafeBound.status === "outside_contract") {
      assert.deepEqual(unsafeBound.reasons, ["malformed_claim"]);
    }
    const fractionalBound = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [
          first,
          ...base.assertions.slice(1, 3),
          { ...bounded, minimum: 1.5, maximum: 2.5 },
          ...base.assertions.slice(4),
        ],
      },
      candidates: [],
    });
    assert.equal(fractionalBound.status, "outside_contract");
    if (fractionalBound.status === "outside_contract") {
      assert.deepEqual(fractionalBound.reasons, ["malformed_claim"]);
    }
    const negativeBound = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [
          first,
          ...base.assertions.slice(1, 3),
          { ...bounded, minimum: -1, maximum: 2 },
          ...base.assertions.slice(4),
        ],
      },
      candidates: [],
    });
    assert.equal(negativeBound.status, "outside_contract");
    if (negativeBound.status === "outside_contract") {
      assert.deepEqual(negativeBound.reasons, ["malformed_claim"]);
    }
  });

  it("rejects empty, dot, NUL, control, and trailing-slash run-relative path identities", () => {
    const claim = makeClaim();
    const invalidPaths = [
      ".",
      "./evidence/log.json",
      "evidence/./log.json",
      "evidence/.",
      "evidence/",
      "evidence//log.json",
      "evidence/log.json/",
      "evidence/log.json\0sidecar",
      "evidence/log.json\nlog",
      "evidence/log.json\tlog",
      `evidence/log.json${String.fromCharCode(0x7f)}log`,
    ];
    for (const path of invalidPaths) {
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim, {
          0: { ...makeResult("eventOccurrence", "a1"), evidenceReferences: [{ path }] },
        }),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:0"]);
      }
    }

    const invalidIds = [
      ".",
      "./c1",
      "c1/.",
      "c1/./nested",
      "c1/",
      "c1//nested",
      "c1\0hidden",
      "c1\nid",
      `c1${String.fromCharCode(0x7f)}id`,
    ];
    for (const candidateId of invalidIds) {
      const inspection = inspectClaimAssertionResultSet({
        claim,
        candidates: completeCandidates(claim).map((candidate, index) =>
          index === 0 ? makeCandidate(claim, 0, { candidateId }) : candidate,
        ),
      });
      assert.equal(inspection.status, "outside_contract");
      if (inspection.status === "outside_contract") {
        assert.deepEqual(inspection.reasons, ["malformed_candidate:0"]);
      }
    }
  });

  it("classifies duplicate authored assertion IDs as malformed_claim", () => {
    const base = makeClaim();
    const first = base.assertions[0];
    if (first === undefined) {
      throw new Error("expected assertion");
    }
    const inspection = inspectClaimAssertionResultSet({
      claim: {
        ...base,
        assertions: [first, ...base.assertions],
      },
      candidates: [],
    });
    assert.equal(inspection.status, "outside_contract");
    if (inspection.status === "outside_contract") {
      assert.deepEqual(inspection.reasons, [
        "duplicate_authored_assertion_id",
        "malformed_claim",
      ]);
    }
  });

  it("keeps a mixed-status authored inventory complete when rejected and not_evaluable results are coherent", () => {
    const claim = makeClaim();
    const notEvaluableOccurrence: ClaimAssertionResult = {
      assertionId: "a1",
      assertionKind: "eventOccurrence",
      status: "not_evaluable",
      reasonCode: "partial_evidence",
      expected: { event: "opened" },
      observed: null,
      evidenceReferences: [],
      rejectedEvidence: [],
      missingProof: ["event-log"],
    };
    const rejectedOrder: ClaimAssertionResult = {
      assertionId: "a2",
      assertionKind: "eventOrder",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { beforeEvent: "opened", afterEvent: "closed" },
      observed: { beforeEvidence: "evt-2", afterEvidence: "evt-1", relation: "after" },
      evidenceReferences: evidence(),
      rejectedEvidence: ["order-reversed"],
      missingProof: [],
    };
    const rejectedState: ClaimAssertionResult = {
      assertionId: "a3",
      assertionKind: "terminalState",
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
      expected: { path: "status", value: "ready" },
      observed: { path: "status", value: "blocked" },
      evidenceReferences: evidence(),
      rejectedEvidence: ["value-mismatch"],
      missingProof: [],
    };
    const notEvaluableEvidence: ClaimAssertionResult = {
      assertionId: "a6",
      assertionKind: "validatedEvidence",
      status: "not_evaluable",
      reasonCode: "missing_authoritative_evidence",
      expected: { artifactKind: "logs", validationContract: "log-schema" },
      observed: null,
      evidenceReferences: [],
      rejectedEvidence: [],
      missingProof: ["artifact"],
    };
    const inspection = inspectClaimAssertionResultSet({
      claim,
      candidates: completeCandidates(claim, {
        0: notEvaluableOccurrence,
        1: rejectedOrder,
        2: rejectedState,
        5: notEvaluableEvidence,
      }),
    });
    assert.equal(inspection.status, "complete");
    if (inspection.status !== "complete") {
      return;
    }
    assert.deepEqual(
      inspection.results.map((result) => result.assertionId),
      claim.assertions.map((assertion) => assertion.id),
    );
    assert.deepEqual(
      inspection.results.map((result) => result.status),
      ["not_evaluable", "rejected", "rejected", "supported", "supported", "not_evaluable"],
    );
  });
});
