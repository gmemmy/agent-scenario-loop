import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildScenarioClaimHash } from "../claim-contract.js";
import type {
  ClaimAssertionResult,
  ClaimEvidenceReference,
  ClaimResult,
  ScenarioClaimAssertion,
  ScenarioClaimDefinition,
} from "../claim-contract.js";
import { inspectClaimAssertionResultSet } from "../claim-assertion-result-set.js";
import type { ClaimAssertionCandidateEnvelope } from "../claim-assertion-result-set.js";
import { inspectScenarioClaimVerdictReduction } from "../claim-verdict-reduction.js";
import { buildClaimResult } from "../claim-result-builder.js";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROOT = path.join(__dirname, "..", "..", "..");

const AUTHORITY = {
  role: "app" as const,
  producerId: "app.truth",
  evidenceSelector: "signals.events",
  requiredStrength: "observed" as const,
  completeness: "point" as const,
};

const WINDOWED_AUTHORITY = {
  ...AUTHORITY,
  completeness: "bounded" as const,
};

const WINDOW = {
  from: "session.start",
  to: "session.end",
  completeSourceRequired: true as const,
};

function claimDefinition(): ScenarioClaimDefinition {
  return {
    id: "login-ready",
    role: "mandatory",
    applicability: { platforms: ["ios"] },
    closes: { phases: ["ready"] },
    assertions: [
      {
        id: "saw-ready",
        kind: "eventOccurrence",
        authority: AUTHORITY,
        event: "ready",
      },
      {
        id: "order-ok",
        kind: "eventOrder",
        authority: AUTHORITY,
        beforeEvent: "start",
        afterEvent: "ready",
      },
      {
        id: "state-ok",
        kind: "terminalState",
        authority: AUTHORITY,
        path: "session.ready",
        expected: true,
      },
    ],
  };
}

function supportedEvent(id: string, event: string, path: string): ClaimAssertionResult {
  return {
    assertionId: id,
    assertionKind: "eventOccurrence",
    status: "supported",
    reasonCode: "all_assertions_supported",
    expected: { event },
    observed: { event, matchedEvidence: path },
    evidenceReferences: [{ path, sha256: HASH_A }],
    rejectedEvidence: [],
    missingProof: [],
  };
}

function supportedOrder(id: string): ClaimAssertionResult {
  return {
    assertionId: id,
    assertionKind: "eventOrder",
    status: "supported",
    reasonCode: "all_assertions_supported",
    expected: { beforeEvent: "start", afterEvent: "ready" },
    observed: {
      beforeEvidence: "signals/start.json",
      afterEvidence: "signals/ready.json",
      relation: "before",
    },
    evidenceReferences: [{ path: "signals/order.json" }],
    rejectedEvidence: [],
    missingProof: [],
  };
}

function rejectedOrder(id: string): ClaimAssertionResult {
  return {
    assertionId: id,
    assertionKind: "eventOrder",
    status: "rejected",
    reasonCode: "authoritative_evidence_rejected",
    expected: { beforeEvent: "start", afterEvent: "ready" },
    observed: {
      beforeEvidence: "signals/ready.json",
      afterEvidence: "signals/start.json",
      relation: "after",
    },
    evidenceReferences: [{ path: "signals/order.json" }],
    rejectedEvidence: ["signals/order.json"],
    missingProof: [],
  };
}

function supportedState(id: string): ClaimAssertionResult {
  return {
    assertionId: id,
    assertionKind: "terminalState",
    status: "supported",
    reasonCode: "all_assertions_supported",
    expected: { path: "session.ready", value: true },
    observed: { path: "session.ready", value: true },
    evidenceReferences: [{ path: "signals/state.json", sha256: HASH_B }],
    rejectedEvidence: [],
    missingProof: [],
  };
}

function notEvaluableState(id: string): ClaimAssertionResult {
  return {
    assertionId: id,
    assertionKind: "terminalState",
    status: "not_evaluable",
    reasonCode: "missing_authoritative_evidence",
    expected: { path: "session.ready", value: true },
    observed: null,
    evidenceReferences: [{ path: "signals/state.json" }],
    rejectedEvidence: [],
    missingProof: ["missing state proof"],
  };
}

function envelope(
  claim: ScenarioClaimDefinition,
  result: ClaimAssertionResult,
  candidateId: string,
): ClaimAssertionCandidateEnvelope {
  return {
    candidateId,
    claimId: claim.id,
    claimHash: buildScenarioClaimHash(claim),
    assertionId: result.assertionId,
    assertionKind: result.assertionKind,
    result,
  };
}

function completeSet(
  claim: ScenarioClaimDefinition,
  results: ClaimAssertionResult[],
) {
  const candidates = results.map((result, index) =>
    envelope(claim, result, `candidates/a${index}.json`),
  );
  return inspectClaimAssertionResultSet({ claim, candidates });
}

test("passed health with all supported assertions yields supported claim", () => {
  const claim = claimDefinition();
  const results = [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ];
  const resultSet = completeSet(claim, results);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  assert.equal(inspection.result.status, "supported");
  assert.equal(inspection.result.reasonCode, "all_assertions_supported");
  assert.equal(inspection.result.claimId, claim.id);
  assert.equal(inspection.result.claimHash, buildScenarioClaimHash(claim));
  assert.equal(inspection.result.role, "mandatory");
  assert.equal(inspection.result.nextActionOwner, "product_optimization");
  assert.equal(inspection.result.nextAction, "Retain trusted evidence for claim login-ready.");
  assert.equal(inspection.result.assertionResults.length, 3);
  assert.deepEqual(
    inspection.result.assertionResults.map((item) => item.assertionId),
    ["saw-ready", "order-ok", "state-ok"],
  );
  assert.equal(Object.isFrozen(inspection.result), true);
});

test("passed health with one rejected assertion yields rejected claim", () => {
  const claim = claimDefinition();
  const results = [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    rejectedOrder("order-ok"),
    supportedState("state-ok"),
  ];
  const resultSet = completeSet(claim, results);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  assert.equal(inspection.result.status, "rejected");
  assert.equal(inspection.result.reasonCode, "authoritative_evidence_rejected");
  assert.equal(inspection.result.nextActionOwner, "app_truth");
  assert.equal(
    inspection.result.nextAction,
    "Inspect rejected authoritative evidence for claim login-ready.",
  );
});

test("passed health with one not-evaluable assertion preserves first reason", () => {
  const claim = claimDefinition();
  const results = [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    notEvaluableState("state-ok"),
  ];
  const resultSet = completeSet(claim, results);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  assert.equal(inspection.result.status, "not_evaluable");
  assert.equal(inspection.result.reasonCode, "missing_authoritative_evidence");
  assert.equal(inspection.result.nextActionOwner, "unresolved");
  assert.equal(
    inspection.result.nextAction,
    "Resolve missing or insufficient authoritative evidence for claim login-ready.",
  );
  assert.deepEqual(inspection.result.missingProof, ["missing state proof"]);
});

test("passed health mixed rejected and not-evaluable prefers rejected", () => {
  const claim = claimDefinition();
  const results = [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    rejectedOrder("order-ok"),
    notEvaluableState("state-ok"),
  ];
  const resultSet = completeSet(claim, results);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  assert.equal(inspection.result.status, "rejected");
  assert.equal(inspection.result.reasonCode, "authoritative_evidence_rejected");
});

function assertHealthGated(
  healthStatus: "failed" | "partial",
  preGate: ClaimAssertionResult[],
): void {
  const claim = claimDefinition();
  const resultSet = completeSet(claim, preGate);
  const snapshot = structuredClone(resultSet);
  const inspection = buildClaimResult({ claim, healthStatus, resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  assert.equal(inspection.result.status, "not_evaluable");
  assert.equal(inspection.result.reasonCode, "health_gate_failed");
  assert.equal(inspection.result.nextActionOwner, "runtime_environment");
  assert.equal(
    inspection.result.nextAction,
    "Restore trusted scenario health before evaluating claim login-ready.",
  );
  for (const [index, assertion] of inspection.result.assertionResults.entries()) {
    const original = preGate[index];
    assert.ok(original);
    assert.equal(assertion.status, "not_evaluable");
    assert.equal(assertion.reasonCode, "health_gate_failed");
    assert.equal(assertion.observed, null);
    assert.equal(assertion.assertionId, original.assertionId);
    assert.equal(assertion.assertionKind, original.assertionKind);
    assert.deepEqual(assertion.expected, original.expected);
    assert.deepEqual(assertion.evidenceReferences, original.evidenceReferences);
    assert.deepEqual(assertion.rejectedEvidence, original.rejectedEvidence);
    assert.deepEqual(assertion.missingProof, [
      `Trusted scenario health is required before evaluating assertion ${original.assertionId}.`,
    ]);
  }
  assert.deepEqual(resultSet, snapshot);
  if (resultSet.status === "complete") {
    assert.equal(resultSet.results[1]?.status, preGate[1]?.status);
  }
}

test("failed health projects previously supported assertions through the health gate", () => {
  assertHealthGated("failed", [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ]);
});

test("partial health projects previously rejected assertions through the health gate", () => {
  assertHealthGated("partial", [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    rejectedOrder("order-ok"),
    supportedState("state-ok"),
  ]);
});

test("failed health projects previously not-evaluable assertions through the health gate", () => {
  assertHealthGated("failed", [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    notEvaluableState("state-ok"),
  ]);
});

test("evidence references union in authored order without delimiter collisions", () => {
  const claim = claimDefinition();
  const collidingPath = 'signals/a|sha256:"dead".json';
  const first: ClaimAssertionResult = {
    ...supportedEvent("saw-ready", "ready", collidingPath),
    evidenceReferences: [{ path: collidingPath }],
  };
  const second: ClaimAssertionResult = {
    ...supportedOrder("order-ok"),
    evidenceReferences: [{ path: collidingPath, sha256: HASH_A }],
  };
  const third: ClaimAssertionResult = {
    ...supportedState("state-ok"),
    evidenceReferences: [
      { path: collidingPath },
      { path: "signals/state.json", sha256: HASH_B },
    ],
  };
  const resultSet = completeSet(claim, [first, second, third]);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  const refs: ClaimEvidenceReference[] = inspection.result.evidenceReferences;
  assert.equal(refs.length, 3);
  assert.equal(refs[0]?.path, collidingPath);
  assert.equal(refs[0]?.sha256, undefined);
  assert.equal(refs[1]?.path, collidingPath);
  assert.equal(refs[1]?.sha256, HASH_A);
  assert.equal(refs[2]?.path, "signals/state.json");
});

test("duplicate evidence and missing proof are unioned in authored order", () => {
  const claim = claimDefinition();
  const first: ClaimAssertionResult = {
    ...notEvaluableState("saw-ready"),
    assertionId: "saw-ready",
    assertionKind: "eventOccurrence",
    expected: { event: "ready" },
    evidenceReferences: [{ path: "signals/a.json" }],
    missingProof: ["shared", "first-only"],
  } as ClaimAssertionResult;
  const second: ClaimAssertionResult = {
    ...notEvaluableState("order-ok"),
    assertionId: "order-ok",
    assertionKind: "eventOrder",
    expected: { beforeEvent: "start", afterEvent: "ready" },
    evidenceReferences: [{ path: "signals/a.json" }, { path: "signals/b.json" }],
    missingProof: ["shared", "second-only"],
  } as ClaimAssertionResult;
  const third = notEvaluableState("state-ok");
  const resultSet = completeSet(claim, [first, second, third]);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  assert.deepEqual(
    inspection.result.evidenceReferences.map((item) => item.path),
    ["signals/a.json", "signals/b.json", "signals/state.json"],
  );
  assert.deepEqual(inspection.result.missingProof, [
    "shared",
    "first-only",
    "second-only",
    "missing state proof",
  ]);
});

test("claim identity mismatch is incoherent", () => {
  const claim = claimDefinition();
  const other: ScenarioClaimDefinition = { ...claim, id: "other-claim" };
  const resultSet = completeSet(other, [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ]);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "incoherent");
  if (inspection.status !== "incoherent") {
    return;
  }
  assert.ok(inspection.reasons.includes("claim_id_mismatch"));
});

test("claim hash mismatch is incoherent", () => {
  const claim = claimDefinition();
  const resultSet = completeSet(claim, [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ]);
  const mutated = {
    ...claim,
    assertions: [
      claim.assertions[0] as ScenarioClaimAssertion,
      claim.assertions[1] as ScenarioClaimAssertion,
      {
        ...(claim.assertions[2] as ScenarioClaimAssertion),
        path: "session.ready.mutated",
      },
    ],
  } as ScenarioClaimDefinition;
  const inspection = buildClaimResult({
    claim: mutated,
    healthStatus: "passed",
    resultSet,
  });
  assert.equal(inspection.status, "incoherent");
});

test("incomplete result set is not repaired", () => {
  const claim = claimDefinition();
  const inspection = buildClaimResult({
    claim,
    healthStatus: "passed",
    resultSet: { status: "incoherent", reasons: ["duplicate_assertion:saw-ready"], candidates: [] },
  });
  assert.equal(inspection.status, "incoherent");
  if (inspection.status !== "incoherent") {
    return;
  }
  assert.deepEqual(inspection.reasons, ["incomplete_result_set"]);
});

test("outside-contract result set is not repaired", () => {
  const claim = claimDefinition();
  const inspection = buildClaimResult({
    claim,
    healthStatus: "passed",
    resultSet: { status: "outside_contract", reasons: ["malformed_input"] },
  });
  assert.equal(inspection.status, "outside_contract");
});

test("malformed input, proxy, accessor, and foreign prototype are outside contract", () => {
  const claim = claimDefinition();
  const resultSet = completeSet(claim, [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ]);

  assert.equal(buildClaimResult(null as never).status, "outside_contract");
  assert.equal(
    buildClaimResult(new Proxy({ claim, healthStatus: "passed", resultSet }, {}) as never).status,
    "outside_contract",
  );

  const accessorClaim = {};
  Object.defineProperty(accessorClaim, "id", {
    get: () => "login-ready",
    enumerable: true,
  });
  assert.equal(
    buildClaimResult({
      claim: accessorClaim as never,
      healthStatus: "passed",
      resultSet,
    }).status,
    "outside_contract",
  );

  const foreign = Object.create({ id: "login-ready" });
  foreign.role = "mandatory";
  foreign.assertions = claim.assertions;
  foreign.applicability = claim.applicability;
  foreign.closes = claim.closes;
  assert.equal(
    buildClaimResult({
      claim: foreign as never,
      healthStatus: "passed",
      resultSet,
    }).status,
    "outside_contract",
  );
});

test("caller mutation of input after build does not change detached result", () => {
  const claim = claimDefinition();
  const results = [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ];
  const resultSet = completeSet(claim, results);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  claim.id = "mutated";
  results[0] = notEvaluableState("saw-ready");
  assert.equal(inspection.result.claimId, "login-ready");
  assert.equal(inspection.result.assertionResults[0]?.status, "supported");
});

test("constructed result is accepted by verdict-reduction inspector", () => {
  const claim = claimDefinition();
  const results = [
    supportedEvent("saw-ready", "ready", "signals/ready.json"),
    supportedOrder("order-ok"),
    supportedState("state-ok"),
  ];
  const resultSet = completeSet(claim, results);
  const inspection = buildClaimResult({ claim, healthStatus: "passed", resultSet });
  assert.equal(inspection.status, "complete");
  if (inspection.status !== "complete") {
    return;
  }
  const claimResult: ClaimResult = inspection.result;
  const scenario = JSON.parse(
    fs.readFileSync(path.join(ROOT, "examples/scenarios/mobile/app-startup.json"), "utf8"),
  ) as Record<string, unknown>;
  scenario.schemaVersion = "1.1.0";
  scenario.journey = {
    name: "Inspect claim result builder",
    intent: "Prove one complete selected journey without trusting caller result inventory.",
    actor: "returning user",
    startState: "app not running",
    endState: "first usable screen visible",
    phases: [{ id: "ready", description: "Reach ready state.", coverageKind: "product" }],
    terminalInvariants: [
      { id: "ready", description: "Ready state remains visible.", coverageKind: "product" },
    ],
    recovery: {
      status: "not_required",
      rationale: "This fixture has no recovery branch.",
    },
  };
  scenario.claims = [claim];
  scenario.safety = {
    class: "read_only",
    rationale: "The fixture inspects already supplied result inventory.",
    allowedOperations: ["observe"],
  };
  scenario.dependencies = [];
  const verdict = {
    schemaVersion: "1.1.0",
    scenarioId: scenario.id,
    runId: "run-1",
    healthStatus: "passed",
    verdictStatus: "passed",
    claimResults: [claimResult],
  };
  const reduced = inspectScenarioClaimVerdictReduction(scenario, { platform: "ios" }, verdict);
  assert.equal(reduced.reductionStatus, "reduced");
});
