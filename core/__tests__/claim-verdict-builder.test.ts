import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildScenarioClaimHash,
  type ClaimAssertionResult,
  type ClaimResult,
  type ScenarioClaimDefinition,
} from "../claim-contract";
import { buildClaimCompleteVerdict } from "../claim-verdict-builder";
import { inspectScenarioClaimVerdictReduction } from "../claim-verdict-reduction";
import { SCHEMAS, validateJson } from "../schema-validator";

const ROOT = path.join(__dirname, "..", "..", "..");

const POINT_AUTHORITY = {
  role: "app" as const,
  producerId: "app-profile-session",
  evidenceSelector: "profileEvents",
  requiredStrength: "observed" as const,
  completeness: "point" as const,
};

const EVIDENCE_REF = {
  path: "raw/profile-events.json",
  sha256: "b".repeat(64),
};

const STATE_EVIDENCE_REF = { path: "raw/state.json" };

type ClaimPlatform = "ios" | "android";
type ClaimPlatforms = [ClaimPlatform, ...ClaimPlatform[]];

function eventOccurrenceClaim(
  id: string,
  assertionId: string,
  role: ScenarioClaimDefinition["role"],
  platforms: ClaimPlatforms,
  variants?: [string, ...string[]],
): ScenarioClaimDefinition {
  return {
    id,
    role,
    applicability: variants === undefined ? { platforms } : { platforms, variants },
    closes: { phases: ["launch-app"], terminalInvariants: ["ready"] },
    assertions: [
      {
        id: assertionId,
        kind: "eventOccurrence",
        event: "app_ready",
        authority: POINT_AUTHORITY,
      },
    ],
  };
}

function terminalStateClaim(
  id: string,
  role: ScenarioClaimDefinition["role"],
  platforms: ClaimPlatforms,
): ScenarioClaimDefinition {
  return {
    id,
    role,
    applicability: { platforms },
    closes: { phases: ["launch-app"], terminalInvariants: ["ready"] },
    assertions: [
      {
        id: "state",
        kind: "terminalState",
        path: "navigation.route",
        expected: "home",
        authority: POINT_AUTHORITY,
      },
    ],
  };
}

function primaryClaim(): ScenarioClaimDefinition {
  return {
    id: "primary-journey",
    role: "mandatory",
    applicability: { platforms: ["ios", "android"] },
    closes: { phases: ["launch-app"], terminalInvariants: ["ready"] },
    assertions: [
      {
        id: "primary-ready",
        kind: "eventOccurrence",
        event: "app_ready",
        authority: POINT_AUTHORITY,
      },
    ],
  };
}

function secondaryClaim(): ScenarioClaimDefinition {
  return eventOccurrenceClaim("secondary-mandatory", "secondary-ready", "mandatory", ["ios", "android"]);
}

function supplementalClaim(): ScenarioClaimDefinition {
  return eventOccurrenceClaim("supplemental-ready", "supplemental-ready", "supplemental", ["ios", "android"]);
}

function androidOnlyClaim(): ScenarioClaimDefinition {
  return eventOccurrenceClaim("android-only", "android-ready", "mandatory", ["android"]);
}

function variantClaim(id: string, variant: string): ScenarioClaimDefinition {
  return eventOccurrenceClaim(id, `${id}-ready`, "mandatory", ["ios"], [variant] as [string, ...string[]]);
}

function scenarioFixture(
  claims: ScenarioClaimDefinition[] = [primaryClaim(), secondaryClaim(), supplementalClaim(), androidOnlyClaim()],
): Record<string, unknown> {
  const scenario = JSON.parse(
    fs.readFileSync(path.join(ROOT, "examples/scenarios/mobile/app-startup.json"), "utf8"),
  ) as Record<string, unknown>;
  scenario.schemaVersion = "1.1.0";
  scenario.id = "scenario-claim-complete";
  scenario.journey = {
    name: "App startup",
    intent: "Reach ready.",
    actor: "operator",
    startState: "cold",
    endState: "ready",
    phases: [
      { id: "launch-app", description: "Launch.", coverageKind: "product" },
      { id: "reach-ready", description: "Ready.", coverageKind: "product" },
    ],
    terminalInvariants: [{ id: "ready", description: "Ready remains visible.", coverageKind: "product" }],
    recovery: { status: "not_required", rationale: "No recovery branch." },
  };
  scenario.safety = {
    class: "read_only",
    rationale: "Inspect supplied results.",
    allowedOperations: ["observe"],
  };
  scenario.dependencies = [];
  scenario.claims = claims;
  return scenario;
}

function selectionFixture() {
  return {
    platform: "ios" as const,
    applicableClaimIds: ["primary-journey", "secondary-mandatory", "supplemental-ready"],
    excludedClaimIds: ["android-only"],
  };
}

function supportedAssertionResult(claim: ScenarioClaimDefinition): ClaimResult["assertionResults"][number] {
  const assertion = claim.assertions[0];
  if (!assertion || assertion.kind !== "eventOccurrence") {
    throw new Error("supported fixture expects eventOccurrence");
  }
  return {
    assertionId: assertion.id,
    assertionKind: "eventOccurrence",
    status: "supported",
    reasonCode: "all_assertions_supported",
    expected: { event: assertion.event },
    observed: { event: assertion.event, matchedEvidence: `${assertion.id}-event` },
    evidenceReferences: [EVIDENCE_REF],
    rejectedEvidence: [],
    missingProof: [],
  };
}

function rejectedAssertionResult(): ClaimResult["assertionResults"][number] {
  return {
    assertionId: "state",
    assertionKind: "terminalState",
    status: "rejected",
    reasonCode: "authoritative_evidence_rejected",
    expected: { path: "navigation.route", value: "home" },
    observed: { path: "navigation.route", value: "unexpected" },
    evidenceReferences: [STATE_EVIDENCE_REF],
    rejectedEvidence: ["raw/state.json"],
    missingProof: [],
  };
}

function notEvaluableAssertionResult(claim: ScenarioClaimDefinition): ClaimResult["assertionResults"][number] {
  const assertion = claim.assertions[0];
  if (!assertion) {
    throw new Error("fixture claim is missing assertions");
  }
  if (assertion.kind === "eventOccurrence") {
    return {
      assertionId: assertion.id,
      assertionKind: "eventOccurrence",
      status: "not_evaluable",
      reasonCode: "missing_authoritative_evidence",
      expected: { event: assertion.event },
      observed: null,
      evidenceReferences: [],
      rejectedEvidence: [],
      missingProof: ["authoritative-evidence"],
    };
  }
  if (assertion.kind === "terminalState") {
    return {
      assertionId: assertion.id,
      assertionKind: "terminalState",
      status: "not_evaluable",
      reasonCode: "missing_authoritative_evidence",
      expected: { path: assertion.path, value: assertion.expected },
      observed: null,
      evidenceReferences: [],
      rejectedEvidence: [],
      missingProof: ["authoritative-evidence"],
    };
  }
  throw new Error(`unsupported fixture assertion kind ${assertion.kind}`);
}

function nextActionOwnerFor(status: ClaimResult["status"]): ClaimResult["nextActionOwner"] {
  if (status === "supported") {
    return "product_optimization";
  }
  if (status === "rejected") {
    return "app_truth";
  }
  return "unresolved";
}

function nextActionFor(status: ClaimResult["status"]): string {
  if (status === "supported") {
    return "Keep the current product path.";
  }
  if (status === "rejected") {
    return "Repair app-owned truth evidence.";
  }
  return "Supply missing authoritative evidence.";
}

function assertionResultsFor(
  claim: ScenarioClaimDefinition,
  status: ClaimResult["status"],
): ClaimResult["assertionResults"] {
  if (status === "supported") {
    return [supportedAssertionResult(claim)];
  }
  if (status === "rejected") {
    return [rejectedAssertionResult()];
  }
  return [notEvaluableAssertionResult(claim)];
}

function claimResultFor(claim: ScenarioClaimDefinition, status: ClaimResult["status"]): ClaimResult {
  const assertionResults = assertionResultsFor(claim, status);
  const first = assertionResults[0];
  if (!first) {
    throw new Error(`missing assertion result for ${claim.id}`);
  }
  const shared = {
    claimId: claim.id,
    claimHash: buildScenarioClaimHash(claim),
    role: claim.role,
    assertionResults,
    evidenceReferences: first.evidenceReferences,
    missingProof: first.missingProof,
    nextActionOwner: nextActionOwnerFor(status),
    nextAction: nextActionFor(status),
  };
  if (status === "supported") {
    return {
      ...shared,
      status: "supported",
      reasonCode: "all_assertions_supported",
    };
  }
  if (status === "rejected") {
    return {
      ...shared,
      status: "rejected",
      reasonCode: "authoritative_evidence_rejected",
    };
  }
  return {
    ...shared,
    status: "not_evaluable",
    reasonCode: "missing_authoritative_evidence",
  };
}

function supportedResults(): ClaimResult[] {
  return [
    claimResultFor(primaryClaim(), "supported"),
    claimResultFor(secondaryClaim(), "supported"),
    claimResultFor(supplementalClaim(), "supported"),
  ];
}

function rejectedSecondaryClaim(): ScenarioClaimDefinition {
  return terminalStateClaim("secondary-mandatory", "mandatory", ["ios", "android"]);
}

function rejectedSupplementalClaim(): ScenarioClaimDefinition {
  return terminalStateClaim("supplemental-ready", "supplemental", ["ios", "android"]);
}

function rejectedMandatoryScenario(): Record<string, unknown> {
  return scenarioFixture([primaryClaim(), rejectedSecondaryClaim(), supplementalClaim(), androidOnlyClaim()]);
}

function supplementalRejectedScenario(): Record<string, unknown> {
  return scenarioFixture([primaryClaim(), secondaryClaim(), rejectedSupplementalClaim(), androidOnlyClaim()]);
}

function rejectedMandatoryResults(): ClaimResult[] {
  return [
    claimResultFor(primaryClaim(), "supported"),
    claimResultFor(rejectedSecondaryClaim(), "rejected"),
    claimResultFor(supplementalClaim(), "supported"),
  ];
}

function notEvaluableMandatoryResults(): ClaimResult[] {
  return [
    claimResultFor(primaryClaim(), "not_evaluable"),
    claimResultFor(secondaryClaim(), "supported"),
    claimResultFor(supplementalClaim(), "supported"),
  ];
}

function supplementalRejectedResults(): ClaimResult[] {
  return [
    claimResultFor(primaryClaim(), "supported"),
    claimResultFor(secondaryClaim(), "supported"),
    claimResultFor(rejectedSupplementalClaim(), "rejected"),
  ];
}

function supplementalNotEvaluableResults(): ClaimResult[] {
  return [
    claimResultFor(primaryClaim(), "supported"),
    claimResultFor(secondaryClaim(), "supported"),
    claimResultFor(supplementalClaim(), "not_evaluable"),
  ];
}

function extraKey<T extends object>(value: T, key: string, extra: unknown): T {
  return { ...value, [key]: extra };
}

function accessorRecord<T extends object>(base: T, key: string): T {
  const clone = { ...base } as T;
  Object.defineProperty(clone, key, {
    get() {
      return (base as Record<string, unknown>)[key];
    },
    enumerable: true,
  });
  return clone;
}

class ForeignRecord {}

function foreignRecord<T extends object>(base: T): T {
  return Object.assign(Object.create(ForeignRecord.prototype), base) as T;
}

function assertHealthGated(result: ClaimResult): void {
  assert.equal(result.status, "not_evaluable");
  assert.equal(result.reasonCode, "health_gate_failed");
  assert.ok(result.assertionResults.length > 0);
  for (const assertion of result.assertionResults) {
    assert.equal(assertion.status, "not_evaluable");
    assert.equal(assertion.reasonCode, "health_gate_failed");
  }
}

const WINDOWED_AUTHORITY = {
  ...POINT_AUTHORITY,
  completeness: "bounded" as const,
};

const OBSERVATION_WINDOW = {
  from: "app_launch",
  to: "app_ready",
  completeSourceRequired: true as const,
};

function kindToKebabId(kind: ClaimAssertionResult["assertionKind"]): string {
  return kind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function kindClaim(kind: ClaimAssertionResult["assertionKind"]): ScenarioClaimDefinition {
  const shared = {
    id: kindToKebabId(kind),
    role: "mandatory" as const,
    applicability: { platforms: ["ios"] as ClaimPlatforms },
    closes: {
      phases: ["launch-app"] as [string, ...string[]],
      terminalInvariants: ["ready"] as [string, ...string[]],
    },
  };
  switch (kind) {
    case "eventOccurrence":
      return {
        ...shared,
        assertions: [{ id: "a", kind, event: "app_ready", authority: POINT_AUTHORITY }],
      };
    case "eventOrder":
      return {
        ...shared,
        assertions: [
          {
            id: "a",
            kind,
            beforeEvent: "app_launch",
            afterEvent: "app_ready",
            authority: POINT_AUTHORITY,
          },
        ],
      };
    case "terminalState":
      return {
        ...shared,
        assertions: [
          { id: "a", kind, path: "navigation.route", expected: "home", authority: POINT_AUTHORITY },
        ],
      };
    case "boundedCount":
      return {
        ...shared,
        assertions: [
          {
            id: "a",
            kind,
            selector: "events.error",
            minimum: 1,
            maximum: 1,
            observationWindow: OBSERVATION_WINDOW,
            authority: WINDOWED_AUTHORITY,
          },
        ],
      };
    case "absence":
      return {
        ...shared,
        assertions: [
          {
            id: "a",
            kind,
            selector: "events.fatal_error",
            observationWindow: OBSERVATION_WINDOW,
            authority: WINDOWED_AUTHORITY,
          },
        ],
      };
    case "validatedEvidence":
      return {
        ...shared,
        assertions: [
          {
            id: "a",
            kind,
            artifactKind: "screenshot",
            validationContract: "screenshot/present-v1",
            authority: POINT_AUTHORITY,
          },
        ],
      };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled kind ${String(exhaustive)}`);
    }
  }
}

function supportedResultForKind(claim: ScenarioClaimDefinition): ClaimResult {
  const assertion = claim.assertions[0];
  if (!assertion) {
    throw new Error("missing assertion");
  }
  let assertionResult: ClaimAssertionResult;
  switch (assertion.kind) {
    case "eventOccurrence":
      assertionResult = {
        assertionId: assertion.id,
        assertionKind: "eventOccurrence",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { event: assertion.event },
        observed: { event: assertion.event, matchedEvidence: `${assertion.id}-event` },
        evidenceReferences: [EVIDENCE_REF],
        rejectedEvidence: [],
        missingProof: [],
      };
      break;
    case "eventOrder":
      assertionResult = {
        assertionId: assertion.id,
        assertionKind: "eventOrder",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { beforeEvent: assertion.beforeEvent, afterEvent: assertion.afterEvent },
        observed: {
          beforeEvidence: "signals/start.json",
          afterEvidence: "signals/ready.json",
          relation: "before",
        },
        evidenceReferences: [EVIDENCE_REF],
        rejectedEvidence: [],
        missingProof: [],
      };
      break;
    case "terminalState":
      assertionResult = {
        assertionId: assertion.id,
        assertionKind: "terminalState",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: { path: assertion.path, value: assertion.expected },
        observed: { path: assertion.path, value: assertion.expected },
        evidenceReferences: [EVIDENCE_REF],
        rejectedEvidence: [],
        missingProof: [],
      };
      break;
    case "boundedCount":
      assertionResult = {
        assertionId: assertion.id,
        assertionKind: "boundedCount",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: {
          selector: assertion.selector,
          minimum: 1,
          maximum: 1,
          observationWindow: assertion.observationWindow,
        },
        observed: { selector: assertion.selector, count: 1 },
        evidenceReferences: [EVIDENCE_REF],
        rejectedEvidence: [],
        missingProof: [],
      };
      break;
    case "absence":
      assertionResult = {
        assertionId: assertion.id,
        assertionKind: "absence",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: {
          selector: assertion.selector,
          observationWindow: assertion.observationWindow,
        },
        observed: { selector: assertion.selector, count: 0 },
        evidenceReferences: [EVIDENCE_REF],
        rejectedEvidence: [],
        missingProof: [],
      };
      break;
    case "validatedEvidence":
      assertionResult = {
        assertionId: assertion.id,
        assertionKind: "validatedEvidence",
        status: "supported",
        reasonCode: "all_assertions_supported",
        expected: {
          artifactKind: assertion.artifactKind,
          validationContract: assertion.validationContract,
        },
        observed: {
          artifactKind: assertion.artifactKind,
          validationContract: assertion.validationContract,
          matchedEvidence: "raw/screenshot.png",
          validationStatus: "passed",
        },
        evidenceReferences: [EVIDENCE_REF],
        rejectedEvidence: [],
        missingProof: [],
      };
      break;
    default: {
      const exhaustive: never = assertion;
      throw new Error(`unhandled ${String(exhaustive)}`);
    }
  }
  return {
    claimId: claim.id,
    claimHash: buildScenarioClaimHash(claim),
    role: claim.role,
    status: "supported",
    reasonCode: "all_assertions_supported",
    assertionResults: [assertionResult],
    evidenceReferences: [EVIDENCE_REF],
    missingProof: [],
    nextActionOwner: "product_optimization",
    nextAction: "Keep the current product path.",
  };
}

describe("buildClaimCompleteVerdict", () => {
  it("passes when all mandatory claims are supported", () => {
    const scenario = scenarioFixture();
    const selection = selectionFixture();
    const output = buildClaimCompleteVerdict({
      scenario,
      runId: "run-1",
      healthStatus: "passed",
      selection,
      claimResults: supportedResults(),
    });
    assert.equal(output.verdictStatus, "passed");
    assert.equal(output.schemaVersion, "1.1.0");
    const validation = validateJson(output, SCHEMAS.verdict, "claim-complete verdict");
    assert.equal(validation.valid, true);
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: "ios" }, output);
    assert.equal(inspection.reductionStatus, "reduced");
  });

  it("fails when one mandatory claim is rejected", () => {
    const output = buildClaimCompleteVerdict({
      scenario: rejectedMandatoryScenario(),
      runId: "run-1",
      healthStatus: "passed",
      selection: selectionFixture(),
      claimResults: rejectedMandatoryResults(),
    });
    assert.equal(output.verdictStatus, "failed");
  });

  it("is inconclusive when one mandatory claim is not_evaluable", () => {
    const output = buildClaimCompleteVerdict({
      scenario: scenarioFixture(),
      runId: "run-1",
      healthStatus: "passed",
      selection: selectionFixture(),
      claimResults: notEvaluableMandatoryResults(),
    });
    assert.equal(output.verdictStatus, "inconclusive");
  });

  it("keeps supplemental rejected visible without changing mandatory passed", () => {
    const output = buildClaimCompleteVerdict({
      scenario: supplementalRejectedScenario(),
      runId: "run-1",
      healthStatus: "passed",
      selection: selectionFixture(),
      claimResults: supplementalRejectedResults(),
    });
    assert.equal(output.verdictStatus, "passed");
    assert.equal(output.claimResults[2]?.status, "rejected");
  });

  it("keeps supplemental not_evaluable visible without changing mandatory passed", () => {
    const output = buildClaimCompleteVerdict({
      scenario: scenarioFixture(),
      runId: "run-1",
      healthStatus: "passed",
      selection: selectionFixture(),
      claimResults: supplementalNotEvaluableResults(),
    });
    assert.equal(output.verdictStatus, "passed");
    assert.equal(output.claimResults[2]?.status, "not_evaluable");
  });

  it("health-gates failed health to inconclusive and rewrites every claim and assertion", () => {
    const scenario = rejectedMandatoryScenario();
    const output = buildClaimCompleteVerdict({
      scenario,
      runId: "run-1",
      healthStatus: "failed",
      selection: selectionFixture(),
      claimResults: rejectedMandatoryResults(),
    });
    assert.equal(output.verdictStatus, "inconclusive");
    assert.equal(output.claimResults.length, 3);
    for (const result of output.claimResults) {
      assertHealthGated(result);
    }
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: "ios" }, output);
    assert.equal(inspection.reductionStatus, "reduced");
  });

  it("health-gates partial health to inconclusive and rewrites nested assertions", () => {
    const scenario = scenarioFixture();
    const output = buildClaimCompleteVerdict({
      scenario,
      runId: "run-1",
      healthStatus: "partial",
      selection: selectionFixture(),
      claimResults: supportedResults(),
    });
    assert.equal(output.verdictStatus, "inconclusive");
    for (const result of output.claimResults) {
      assertHealthGated(result);
    }
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: "ios" }, output);
    assert.equal(inspection.reductionStatus, "reduced");
  });

  it("rejects missing applicable results", () => {
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: supportedResults().slice(0, 2),
      }),
    );
  });

  it("rejects duplicate results", () => {
    const results = [...supportedResults(), supportedResults()[0]!];
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: results,
      }),
    );
  });

  it("rejects foreign results", () => {
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: [
          ...supportedResults(),
          claimResultFor(eventOccurrenceClaim("unknown-claim", "unknown-ready", "mandatory", ["ios"]), "supported"),
        ],
      }),
    );
  });

  it("rejects excluded results", () => {
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: [...supportedResults(), claimResultFor(androidOnlyClaim(), "supported")],
      }),
    );
  });

  it("rejects wrong role", () => {
    const supported = claimResultFor(primaryClaim(), "supported");
    const results: ClaimResult[] = [
      {
        ...supported,
        role: "supplemental",
      },
      claimResultFor(secondaryClaim(), "supported"),
      claimResultFor(supplementalClaim(), "supported"),
    ];
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: results,
      }),
    );
  });

  it("rejects wrong hash", () => {
    const supported = claimResultFor(primaryClaim(), "supported");
    const results: ClaimResult[] = [
      {
        ...supported,
        claimHash: buildScenarioClaimHash(androidOnlyClaim()),
      },
      claimResultFor(secondaryClaim(), "supported"),
      claimResultFor(supplementalClaim(), "supported"),
    ];
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: results,
      }),
    );
  });

  it("rejects wrong platform selection", () => {
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: { ...selectionFixture(), platform: "android" },
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects empty assertion inventory before passed-health reduction", () => {
    const empty = {
      ...claimResultFor(primaryClaim(), "supported"),
      assertionResults: [],
    } as unknown as ClaimResult;
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: [empty, claimResultFor(secondaryClaim(), "supported"), claimResultFor(supplementalClaim(), "supported")],
      }),
    );
  });

  it("rejects empty assertion inventory before unhealthy projection", () => {
    const empty = {
      ...claimResultFor(primaryClaim(), "supported"),
      assertionResults: [],
    } as unknown as ClaimResult;
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "failed",
        selection: selectionFixture(),
        claimResults: [empty, claimResultFor(secondaryClaim(), "supported"), claimResultFor(supplementalClaim(), "supported")],
      }),
    );
  });

  it("accepts omitted variant when claims have no variant constraint", () => {
    const output = buildClaimCompleteVerdict({
      scenario: scenarioFixture(),
      runId: "run-1",
      healthStatus: "passed",
      selection: selectionFixture(),
      claimResults: supportedResults(),
    });
    assert.equal(output.verdictStatus, "passed");
  });

  it("accepts matching variant inventory", () => {
    const claims = [variantClaim("variant-a", "beta"), androidOnlyClaim()];
    const scenario = scenarioFixture(claims);
    const selection = {
      platform: "ios" as const,
      variant: "beta",
      applicableClaimIds: ["variant-a"],
      excludedClaimIds: ["android-only"],
    };
    const output = buildClaimCompleteVerdict({
      scenario,
      runId: "run-1",
      healthStatus: "passed",
      selection,
      claimResults: [claimResultFor(claims[0]!, "supported")],
    });
    assert.equal(output.verdictStatus, "passed");
    assert.equal(output.claimResults[0]?.claimId, "variant-a");
  });

  it("rejects nonmatching variant inventory as excluded, never runtime not_applicable", () => {
    const claims = [variantClaim("variant-a", "beta"), androidOnlyClaim()];
    const scenario = scenarioFixture(claims);
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: {
          platform: "ios",
          variant: "gamma",
          applicableClaimIds: ["variant-a"],
          excludedClaimIds: ["android-only"],
        },
        claimResults: [claimResultFor(claims[0]!, "supported")],
      }),
    );
  });

  it("rejects wrong variant inventory", () => {
    const claims = [variantClaim("variant-a", "beta"), primaryClaim()];
    const scenario = scenarioFixture(claims);
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: {
          platform: "ios",
          variant: "beta",
          applicableClaimIds: ["primary-journey"],
          excludedClaimIds: ["variant-a"],
        },
        claimResults: [claimResultFor(primaryClaim(), "supported")],
      }),
    );
  });

  it("rejects exact schema version isolation for legacy 1.0.0", () => {
    const scenario = scenarioFixture();
    scenario.schemaVersion = "1.0.0";
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects exact schema version isolation for unknown version", () => {
    const scenario = scenarioFixture();
    scenario.schemaVersion = "9.9.9";
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects exact schema version isolation for missing version", () => {
    const scenario = scenarioFixture();
    delete scenario.schemaVersion;
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects sparse claimResults", () => {
    const results = supportedResults();
    const sparse: ClaimResult[] = [];
    sparse[0] = results[0]!;
    sparse[2] = results[2]!;
    sparse.length = 3;
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: sparse as ClaimResult[],
      }),
    );
  });

  it("rejects sparse applicable inventory", () => {
    const selection = selectionFixture();
    const sparse: string[] = [];
    sparse[0] = selection.applicableClaimIds[0]!;
    sparse[2] = selection.applicableClaimIds[2]!;
    sparse.length = 3;
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: { ...selection, applicableClaimIds: sparse },
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects sparse excluded inventory", () => {
    const selection = selectionFixture();
    const sparse: string[] = [];
    sparse.length = 1;
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: { ...selection, excludedClaimIds: sparse },
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects empty claims-array", () => {
    const scenario = scenarioFixture([]);
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: {
          platform: "ios",
          applicableClaimIds: [],
          excludedClaimIds: [],
        },
        claimResults: [],
      }),
    );
  });

  it("rejects malformed authored claim before hash reduction", () => {
    const scenario = scenarioFixture();
    (scenario.claims as unknown[])[0] = { id: "primary-journey" };
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: supportedResults(),
      }),
    );
  });

  it("rejects matching selection with no applicable mandatory claim", () => {
    const claims = [eventOccurrenceClaim("only-supplemental", "ready", "supplemental", ["ios"]), androidOnlyClaim()];
    const scenario = scenarioFixture(claims);
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "passed",
        selection: {
          platform: "ios",
          applicableClaimIds: ["only-supplemental"],
          excludedClaimIds: ["android-only"],
        },
        claimResults: [claimResultFor(claims[0]!, "supported")],
      }),
    );
  });

  it("rejects extra keys on input, selection, and claim results", () => {
    assert.throws(() =>
      buildClaimCompleteVerdict(
        extraKey(
          {
            scenario: scenarioFixture(),
            runId: "run-1",
            healthStatus: "passed",
            selection: selectionFixture(),
            claimResults: supportedResults(),
          },
          "extra",
          true,
        ) as never,
      ),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: extraKey(selectionFixture(), "extra", true) as never,
        claimResults: supportedResults(),
      }),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        scenario: scenarioFixture(),
        runId: "run-1",
        healthStatus: "passed",
        selection: selectionFixture(),
        claimResults: [extraKey(supportedResults()[0]!, "extra", true) as never, ...supportedResults().slice(1)],
      }),
    );
  });

  it("rejects accessor, proxy, and foreign records on input, selection, and claim results", () => {
    const baseInput = {
      scenario: scenarioFixture(),
      runId: "run-1",
      healthStatus: "passed" as const,
      selection: selectionFixture(),
      claimResults: supportedResults(),
    };
    assert.throws(() => buildClaimCompleteVerdict(accessorRecord(baseInput, "runId") as never));
    assert.throws(() => buildClaimCompleteVerdict(new Proxy(baseInput, {}) as never));
    assert.throws(() => buildClaimCompleteVerdict(foreignRecord(baseInput) as never));
    assert.throws(() =>
      buildClaimCompleteVerdict({
        ...baseInput,
        selection: accessorRecord(selectionFixture(), "platform") as never,
      }),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        ...baseInput,
        selection: new Proxy(selectionFixture(), {}) as never,
      }),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        ...baseInput,
        selection: foreignRecord(selectionFixture()) as never,
      }),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        ...baseInput,
        claimResults: [accessorRecord(supportedResults()[0]!, "claimId") as never, ...supportedResults().slice(1)],
      }),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        ...baseInput,
        claimResults: [new Proxy(supportedResults()[0]!, {}) as never, ...supportedResults().slice(1)],
      }),
    );
    assert.throws(() =>
      buildClaimCompleteVerdict({
        ...baseInput,
        claimResults: [foreignRecord(supportedResults()[0]!) as never, ...supportedResults().slice(1)],
      }),
    );
  });

  it("freezes nested claimResults and assertionResults", () => {
    const output = buildClaimCompleteVerdict({
      scenario: scenarioFixture(),
      runId: "run-1",
      healthStatus: "passed",
      selection: selectionFixture(),
      claimResults: supportedResults(),
    });
    const before = JSON.stringify(output);
    assert.throws(() => {
      (output.claimResults as ClaimResult[]).push(output.claimResults[0]!);
    });
    assert.throws(() => {
      (output.claimResults[0] as { status: string }).status = "rejected";
    });
    assert.throws(() => {
      (output.claimResults[0]!.assertionResults as ClaimAssertionResult[]).pop();
    });
    assert.throws(() => {
      (output.claimResults[0]!.assertionResults[0] as { status: string }).status = "rejected";
    });
    assert.equal(JSON.stringify(output), before);
  });

  it("health-gates every shipped assertion kind and rejects corrupt kinds", () => {
    const kinds: ClaimAssertionResult["assertionKind"][] = [
      "eventOccurrence",
      "eventOrder",
      "terminalState",
      "boundedCount",
      "absence",
      "validatedEvidence",
    ];
    for (const kind of kinds) {
      const claim = kindClaim(kind);
      const scenario = scenarioFixture([claim]);
      const output = buildClaimCompleteVerdict({
        scenario,
        runId: "run-1",
        healthStatus: "failed",
        selection: {
          platform: "ios",
          applicableClaimIds: [claim.id],
          excludedClaimIds: [],
        },
        claimResults: [supportedResultForKind(claim)],
      });
      assert.equal(output.verdictStatus, "inconclusive");
      assertHealthGated(output.claimResults[0]!);
      assert.equal(output.claimResults[0]?.assertionResults[0]?.assertionKind, kind);
    }
    const corruptClaim = kindClaim("eventOccurrence");
    assert.equal(corruptClaim.id, "event-occurrence");
    const corruptResult = supportedResultForKind(corruptClaim);
    (corruptResult.assertionResults[0] as { assertionKind: string }).assertionKind = "not-a-kind";
    assert.throws(
      () =>
        buildClaimCompleteVerdict({
          scenario: scenarioFixture([corruptClaim]),
          runId: "run-1",
          healthStatus: "failed",
          selection: {
            platform: "ios",
            applicableClaimIds: [corruptClaim.id],
            excludedClaimIds: [],
          },
          claimResults: [corruptResult],
        }),
      (error: unknown) => error instanceof TypeError,
    );
  });

  it("rejects passed-health corrupt assertion kind as TypeError", () => {
    const corruptClaim = kindClaim("eventOccurrence");
    const corruptResult = supportedResultForKind(corruptClaim);
    (corruptResult.assertionResults[0] as { assertionKind: string }).assertionKind = "not-a-kind";
    assert.throws(
      () =>
        buildClaimCompleteVerdict({
          scenario: scenarioFixture([corruptClaim]),
          runId: "run-1",
          healthStatus: "passed",
          selection: {
            platform: "ios",
            applicableClaimIds: [corruptClaim.id],
            excludedClaimIds: [],
          },
          claimResults: [corruptResult],
        }),
      (error: unknown) => error instanceof TypeError,
    );
  });

  it("preserves authored applicable order and isolates mutation", () => {
    const scenario = scenarioFixture();
    const selection = selectionFixture();
    const results = supportedResults().reverse();
    const output = buildClaimCompleteVerdict({
      scenario,
      runId: "run-1",
      healthStatus: "passed",
      selection,
      claimResults: results,
    });
    assert.deepEqual(
      output.claimResults.map((result) => result.claimId),
      ["primary-journey", "secondary-mandatory", "supplemental-ready"],
    );
    const mutableInput = results[0] as { status: ClaimResult["status"] };
    mutableInput.status = "rejected";
    assert.equal(output.claimResults[0]?.status, "supported");
    assert.throws(() => {
      (output as { verdictStatus: string }).verdictStatus = "failed";
    });
  });
});
