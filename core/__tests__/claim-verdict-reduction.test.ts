const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildScenarioClaimHash,
  inspectScenarioClaimVerdictReduction,
} = require('../../index');

const ROOT = path.join(__dirname, '..', '..', '..');
const EVIDENCE = [{ path: 'raw/profile-events.json', sha256: 'b'.repeat(64) }];

type JsonRecord = Record<string, any>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function scenarioFixture(): JsonRecord {
  const scenario = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'examples/scenarios/mobile/app-startup.json'), 'utf8'),
  );
  scenario.schemaVersion = '1.1.0';
  scenario.journey = {
    name: 'Inspect claim reduction',
    intent: 'Prove one complete selected journey without trusting caller result inventory.',
    actor: 'returning user',
    startState: 'app not running',
    endState: 'first usable screen visible',
    phases: [
      { id: 'launch-app', description: 'Launch the app.', coverageKind: 'product' },
      { id: 'reach-ready', description: 'Reach ready state.', coverageKind: 'product' },
    ],
    terminalInvariants: [
      { id: 'ready', description: 'Ready state remains visible.', coverageKind: 'product' },
    ],
    recovery: {
      status: 'not_required',
      rationale: 'This fixture has no recovery branch.',
    },
  };
  const authority = {
    role: 'app',
    producerId: 'app-profile-session',
    evidenceSelector: 'profileEvents',
    requiredStrength: 'observed',
    completeness: 'continuous-complete',
  };
  scenario.claims = [
    {
      id: 'primary-journey',
      role: 'mandatory',
      applicability: { platforms: ['ios', 'android'] },
      closes: {
        phases: ['launch-app', 'reach-ready'],
        terminalInvariants: ['ready'],
      },
      assertions: [
        {
          id: 'occurrence',
          kind: 'eventOccurrence',
          event: 'app_ready',
          authority: { ...authority, completeness: 'point' },
        },
        {
          id: 'order',
          kind: 'eventOrder',
          beforeEvent: 'app_launch',
          afterEvent: 'app_ready',
          authority: { ...authority, completeness: 'point' },
        },
        {
          id: 'terminal',
          kind: 'terminalState',
          path: 'navigation.route',
          expected: 'home',
          authority: { ...authority, completeness: 'point' },
        },
        {
          id: 'count',
          kind: 'boundedCount',
          selector: 'events.error',
          minimum: 0,
          maximum: 1,
          observationWindow: {
            from: 'app_launch',
            to: 'app_ready',
            completeSourceRequired: true,
          },
          authority,
        },
        {
          id: 'absence',
          kind: 'absence',
          selector: 'events.fatal_error',
          observationWindow: {
            from: 'app_launch',
            to: 'app_ready',
            completeSourceRequired: true,
          },
          authority,
        },
        {
          id: 'evidence',
          kind: 'validatedEvidence',
          artifactKind: 'video',
          validationContract: 'video/decodable-v1',
          authority: { ...authority, role: 'provider', producerId: 'video-provider' },
        },
      ],
    },
    {
      id: 'secondary-mandatory',
      role: 'mandatory',
      applicability: { platforms: ['ios', 'android'] },
      closes: { terminalInvariants: ['ready'] },
      assertions: [
        {
          id: 'secondary-occurrence',
          kind: 'eventOccurrence',
          event: 'app_stable',
          authority: { ...authority, completeness: 'point' },
        },
      ],
    },
    {
      id: 'supplemental-order',
      role: 'supplemental',
      applicability: { platforms: ['ios', 'android'] },
      closes: { phases: ['reach-ready'] },
      assertions: [
        {
          id: 'supplemental-order-assertion',
          kind: 'eventOrder',
          beforeEvent: 'content_requested',
          afterEvent: 'content_ready',
          authority: { ...authority, completeness: 'point' },
        },
      ],
    },
    {
      id: 'android-only',
      role: 'supplemental',
      applicability: { platforms: ['android'] },
      closes: { phases: ['reach-ready'] },
      assertions: [
        {
          id: 'android-event',
          kind: 'eventOccurrence',
          event: 'android_ready',
          authority: { ...authority, completeness: 'point' },
        },
      ],
    },
    {
      id: 'beta-only',
      role: 'supplemental',
      applicability: { platforms: ['ios'], variants: ['beta'] },
      closes: { phases: ['reach-ready'] },
      assertions: [
        {
          id: 'beta-event',
          kind: 'eventOccurrence',
          event: 'beta_ready',
          authority: { ...authority, completeness: 'point' },
        },
      ],
    },
  ];
  scenario.safety = {
    class: 'read_only',
    rationale: 'The fixture inspects already supplied result inventory.',
    allowedOperations: ['observe'],
  };
  scenario.dependencies = [];
  return scenario;
}

function expectation(assertion: JsonRecord): JsonRecord {
  switch (assertion.kind) {
    case 'eventOccurrence':
      return { event: assertion.event };
    case 'eventOrder':
      return { beforeEvent: assertion.beforeEvent, afterEvent: assertion.afterEvent };
    case 'terminalState':
      return { path: assertion.path, value: assertion.expected };
    case 'boundedCount':
      return {
        selector: assertion.selector,
        minimum: assertion.minimum,
        maximum: assertion.maximum,
        observationWindow: assertion.observationWindow,
      };
    case 'absence':
      return { selector: assertion.selector, observationWindow: assertion.observationWindow };
    case 'validatedEvidence':
      return {
        artifactKind: assertion.artifactKind,
        validationContract: assertion.validationContract,
      };
    default:
      throw new Error(`Unknown assertion kind ${assertion.kind}`);
  }
}

function supportedAssertion(assertion: JsonRecord): JsonRecord {
  const observedByKind: Record<string, JsonRecord> = {
    eventOccurrence: { event: assertion.event, matchedEvidence: `${assertion.id}-event` },
    eventOrder: {
      beforeEvidence: `${assertion.id}-before`,
      afterEvidence: `${assertion.id}-after`,
      relation: 'before',
    },
    terminalState: { path: assertion.path, value: assertion.expected },
    boundedCount: { selector: assertion.selector, count: 0 },
    absence: { selector: assertion.selector, count: 0 },
    validatedEvidence: {
      artifactKind: assertion.artifactKind,
      validationContract: assertion.validationContract,
      matchedEvidence: `${assertion.id}-artifact`,
      validationStatus: 'passed',
    },
  };
  return {
    assertionId: assertion.id,
    assertionKind: assertion.kind,
    status: 'supported',
    reasonCode: 'all_assertions_supported',
    expected: expectation(assertion),
    observed: observedByKind[assertion.kind],
    evidenceReferences: EVIDENCE,
    rejectedEvidence: [],
    missingProof: [],
  };
}

function rejectedAssertion(assertion: JsonRecord): JsonRecord {
  assert.notEqual(assertion.kind, 'eventOccurrence');
  const observedByKind: Record<string, JsonRecord> = {
    eventOrder: {
      beforeEvidence: `${assertion.id}-before`,
      afterEvidence: `${assertion.id}-after`,
      relation: 'after',
    },
    terminalState: { path: assertion.path, value: 'unexpected' },
    boundedCount: { selector: assertion.selector, count: 3 },
    absence: { selector: assertion.selector, count: 1 },
    validatedEvidence: {
      artifactKind: assertion.artifactKind,
      validationContract: assertion.validationContract,
      matchedEvidence: `${assertion.id}-artifact`,
      validationStatus: 'failed',
    },
  };
  return {
    assertionId: assertion.id,
    assertionKind: assertion.kind,
    status: 'rejected',
    reasonCode: 'authoritative_evidence_rejected',
    expected: expectation(assertion),
    observed: observedByKind[assertion.kind],
    evidenceReferences: EVIDENCE,
    rejectedEvidence: [`${assertion.id} contradicted`],
    missingProof: [],
  };
}

function notEvaluableAssertion(assertion: JsonRecord, reasonCode = 'missing_authoritative_evidence') {
  return {
    assertionId: assertion.id,
    assertionKind: assertion.kind,
    status: 'not_evaluable',
    reasonCode,
    expected: expectation(assertion),
    observed: null,
    evidenceReferences: [],
    rejectedEvidence: [],
    missingProof: [`missing ${assertion.id}`],
  };
}

function claimResult(claim: JsonRecord, assertionResults?: JsonRecord[]): JsonRecord {
  const results: JsonRecord[] = assertionResults ?? claim.assertions.map(supportedAssertion);
  const status = results.every((result) => result.status === 'supported')
    ? 'supported'
    : results.some((result) => result.status === 'rejected')
      ? 'rejected'
      : 'not_evaluable';
  const reasonCode =
    status === 'supported'
      ? 'all_assertions_supported'
      : status === 'rejected'
        ? 'authoritative_evidence_rejected'
        : results.find((result) => result.status === 'not_evaluable')?.reasonCode;
  return {
    claimId: claim.id,
    claimHash: buildScenarioClaimHash(claim),
    role: claim.role,
    status,
    reasonCode,
    assertionResults: results,
    evidenceReferences: results.some((result) => result.evidenceReferences.length > 0)
      ? EVIDENCE
      : [],
    missingProof: results.flatMap((result) => result.missingProof),
    nextActionOwner: status === 'supported' ? 'product_optimization' : 'app_truth',
    nextAction: status === 'supported' ? 'Retain evidence.' : 'Inspect missing or rejected proof.',
  };
}

function verdictFixture(scenario: JsonRecord): JsonRecord {
  return verdictForSelection(scenario, { platform: 'ios' });
}

function verdictForSelection(
  scenario: JsonRecord,
  selection: { platform: 'ios' | 'android'; variant?: string },
): JsonRecord {
  const applicable = scenario.claims.filter((claim: JsonRecord) => {
    if (!claim.applicability.platforms.includes(selection.platform)) {
      return false;
    }
    const variants = claim.applicability.variants;
    return !variants || (selection.variant !== undefined && variants.includes(selection.variant));
  });
  return {
    schemaVersion: '1.1.0',
    scenarioId: scenario.id,
    runId: 'claim-reduction-run',
    healthStatus: 'passed',
    verdictStatus: 'passed',
    claimResults: applicable.map((claim: JsonRecord) => claimResult(claim)),
  };
}

function findClaim(scenario: JsonRecord, id: string): JsonRecord {
  return scenario.claims.find((claim: JsonRecord) => claim.id === id);
}

function resultFor(verdict: JsonRecord, id: string): JsonRecord {
  return verdict.claimResults.find((result: JsonRecord) => result.claimId === id);
}

function reasonCodes(inspection: JsonRecord): string[] {
  return inspection.blockingReasons.map((reason: JsonRecord) => reason.code);
}

test('claim verdict reduction preserves untrusted inventory-only status for a coherent candidate', () => {
  const scenario = scenarioFixture();
  const verdict = verdictFixture(scenario);
  const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);

  assert.equal(inspection.reductionStatus, 'reduced');
  assert.equal(inspection.trust, 'inventory_reduction_only');
  assert.equal(inspection.contractVersion, '1.0.0');
  assert.equal(inspection.nextAction, 'retain_as_untrusted_inventory_only');
  assert.equal(inspection.reducedVerdictStatus, 'passed');
  assert.deepEqual(inspection.applicableClaimIds, [
    'primary-journey',
    'secondary-mandatory',
    'supplemental-order',
  ]);
  assert.deepEqual(inspection.excludedClaimIds, ['android-only', 'beta-only']);
  assert.equal(Object.prototype.hasOwnProperty.call(inspection, 'verdict'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(inspection, 'claimResults'), false);
});

test('claim verdict reduction applies mandatory conjunction and supplemental non-gating rules', async (t: any) => {
  await t.test('mandatory rejection outranks a not-evaluable sibling after health passes', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    const claim = findClaim(scenario, 'primary-journey');
    const results = claim.assertions.map(supportedAssertion);
    results[1] = rejectedAssertion(claim.assertions[1]);
    results[2] = notEvaluableAssertion(claim.assertions[2]);
    const replacement = claimResult(claim, results);
    Object.assign(resultFor(verdict, claim.id), replacement);
    verdict.verdictStatus = 'failed';

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'reduced');
    assert.equal(inspection.reducedVerdictStatus, 'failed');
  });

  await t.test('mandatory not-evaluable result makes the journey inconclusive', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    const claim = findClaim(scenario, 'primary-journey');
    const results = claim.assertions.map(supportedAssertion);
    results[0] = notEvaluableAssertion(claim.assertions[0]);
    Object.assign(resultFor(verdict, claim.id), claimResult(claim, results));
    verdict.verdictStatus = 'inconclusive';

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'reduced');
    assert.equal(inspection.reducedVerdictStatus, 'inconclusive');
  });

  await t.test('supplemental rejection remains visible without gating the journey', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    const claim = findClaim(scenario, 'supplemental-order');
    Object.assign(
      resultFor(verdict, claim.id),
      claimResult(claim, [rejectedAssertion(claim.assertions[0])]),
    );

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'reduced');
    assert.equal(inspection.reducedVerdictStatus, 'passed');
  });
});

test('claim verdict reduction enforces failed and partial health without synthesizing truth', async (t: any) => {
  for (const healthStatus of ['failed', 'partial']) {
    await t.test(`${healthStatus} health accepts only caller-supplied health-gated results`, () => {
      const scenario = scenarioFixture();
      const verdict = verdictFixture(scenario);
      verdict.healthStatus = healthStatus;
      verdict.verdictStatus = 'inconclusive';
      verdict.claimResults = verdict.claimResults.map((result: JsonRecord) => {
        const claim = findClaim(scenario, result.claimId);
        const assertions = claim.assertions.map((assertion: JsonRecord) =>
          notEvaluableAssertion(assertion, 'health_gate_failed'),
        );
        const replacement = claimResult(claim, assertions);
        replacement.reasonCode = 'health_gate_failed';
        return replacement;
      });

      const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
      assert.equal(inspection.reductionStatus, 'reduced');
      assert.equal(inspection.reducedVerdictStatus, 'inconclusive');
    });
  }

  await t.test('unhealthy supported result is incoherent', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    verdict.healthStatus = 'failed';
    verdict.verdictStatus = 'inconclusive';
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'incoherent');
    assert.equal(inspection.trust, 'inventory_reduction_only');
    assert.equal(inspection.nextAction, 'repair_candidate_inventory_or_reduction');
    assert.equal(inspection.reducedVerdictStatus, undefined);
    assert.ok(reasonCodes(inspection).includes('health_gate_mismatch'));
  });

  for (const healthStatus of ['failed', 'partial']) {
    await t.test(`${healthStatus} health rejects a non-health-gate not-evaluable reason`, () => {
      const scenario = scenarioFixture();
      const verdict = verdictFixture(scenario);
      verdict.healthStatus = healthStatus;
      verdict.verdictStatus = 'inconclusive';
      verdict.claimResults = verdict.claimResults.map((result: JsonRecord) => {
        const claim = findClaim(scenario, result.claimId);
        return claimResult(
          claim,
          claim.assertions.map((assertion: JsonRecord) => notEvaluableAssertion(assertion)),
        );
      });

      const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
      assert.equal(inspection.reductionStatus, 'incoherent');
      assert.equal(inspection.reducedVerdictStatus, undefined);
      assert.ok(reasonCodes(inspection).includes('health_gate_mismatch'));
    });
  }

  await t.test('passed health rejects stale health-gate reasons', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    const claim = findClaim(scenario, 'primary-journey');
    const assertions = claim.assertions.map(supportedAssertion);
    assertions[0] = notEvaluableAssertion(claim.assertions[0], 'health_gate_failed');
    const replacement = claimResult(claim, assertions);
    replacement.reasonCode = 'health_gate_failed';
    Object.assign(resultFor(verdict, claim.id), replacement);
    verdict.verdictStatus = 'inconclusive';

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'incoherent');
    assert.ok(reasonCodes(inspection).includes('health_gate_mismatch'));
  });
});

test('claim verdict reduction rejects claim inventory and identity drift', async (t: any) => {
  const cases = [
    {
      name: 'missing applicable claim',
      code: 'missing_claim_result',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        verdict.claimResults = verdict.claimResults.filter(
          (result: JsonRecord) => result.claimId !== 'secondary-mandatory',
        );
      },
    },
    {
      name: 'duplicate claim',
      code: 'duplicate_claim_result',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        verdict.claimResults.push(clone(resultFor(verdict, 'secondary-mandatory')));
      },
    },
    {
      name: 'unknown extra claim',
      code: 'extra_claim_result',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        const extra = clone(resultFor(verdict, 'supplemental-order'));
        extra.claimId = 'unknown-claim';
        verdict.claimResults.push(extra);
      },
    },
    {
      name: 'excluded platform claim',
      code: 'excluded_claim_result',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        verdict.claimResults.push(claimResult(findClaim(scenario, 'android-only')));
      },
    },
    {
      name: 'excluded variant claim',
      code: 'excluded_claim_result',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        verdict.claimResults.push(claimResult(findClaim(scenario, 'beta-only')));
      },
    },
    {
      name: 'wrong hash',
      code: 'claim_hash_mismatch',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        resultFor(verdict, 'primary-journey').claimHash = 'f'.repeat(64);
      },
    },
    {
      name: 'wrong role',
      code: 'claim_role_mismatch',
      mutate(scenario: JsonRecord, verdict: JsonRecord) {
        resultFor(verdict, 'primary-journey').role = 'supplemental';
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const scenario = scenarioFixture();
      const verdict = verdictFixture(scenario);
      entry.mutate(scenario, verdict);
      const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
      assert.equal(inspection.reductionStatus, 'incoherent');
      assert.ok(reasonCodes(inspection).includes(entry.code));
    });
  }
});

test('claim verdict reduction rejects assertion inventory and identity drift', async (t: any) => {
  const cases = [
    {
      name: 'missing assertion',
      code: 'missing_assertion_result',
      mutate(result: JsonRecord) {
        result.assertionResults.splice(1, 1);
      },
    },
    {
      name: 'duplicate assertion',
      code: 'duplicate_assertion_result',
      mutate(result: JsonRecord) {
        result.assertionResults.push(clone(result.assertionResults[1]));
      },
    },
    {
      name: 'unknown extra assertion',
      code: 'extra_assertion_result',
      mutate(result: JsonRecord) {
        const extra = clone(result.assertionResults[0]);
        extra.assertionId = 'unknown-assertion';
        result.assertionResults.push(extra);
      },
    },
    {
      name: 'schema-valid wrong assertion kind',
      code: 'assertion_kind_mismatch',
      mutate(result: JsonRecord, scenario: JsonRecord) {
        const authored = findClaim(scenario, 'primary-journey').assertions[0];
        const replacement = supportedAssertion(authored);
        replacement.assertionId = 'order';
        result.assertionResults[1] = replacement;
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const scenario = scenarioFixture();
      const verdict = verdictFixture(scenario);
      const result = resultFor(verdict, 'primary-journey');
      entry.mutate(result, scenario);
      const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
      assert.equal(inspection.reductionStatus, 'incoherent');
      assert.ok(reasonCodes(inspection).includes(entry.code));
    });
  }
});

test('claim verdict reduction binds authored expectations for all six assertion kinds', async (t: any) => {
  const mutations: Record<string, (expected: JsonRecord) => void> = {
    eventOccurrence: (expected) => {
      expected.event = 'different-event';
    },
    eventOrder: (expected) => {
      expected.afterEvent = 'different-event';
    },
    terminalState: (expected) => {
      expected.value = 'different-route';
    },
    boundedCount: (expected) => {
      expected.maximum = 2;
    },
    absence: (expected) => {
      expected.selector = 'events.warning';
    },
    validatedEvidence: (expected) => {
      expected.validationContract = 'video/different';
    },
  };

  for (const [kind, mutate] of Object.entries(mutations)) {
    await t.test(kind, () => {
      const scenario = scenarioFixture();
      const verdict = verdictFixture(scenario);
      const result = resultFor(verdict, 'primary-journey');
      const assertionResult = result.assertionResults.find(
        (assertion: JsonRecord) => assertion.assertionKind === kind,
      );
      mutate(assertionResult.expected);

      const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
      assert.equal(inspection.reductionStatus, 'incoherent');
      assert.ok(reasonCodes(inspection).includes('authored_expectation_mismatch'));
    });
  }
});

test('claim verdict reduction rejects incorrect claim and journey arithmetic', async (t: any) => {
  await t.test('claim status must reduce from its assertions', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    const result = resultFor(verdict, 'primary-journey');
    result.status = 'not_evaluable';
    result.reasonCode = 'missing_authoritative_evidence';

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'incoherent');
    assert.ok(reasonCodes(inspection).includes('claim_reduction_mismatch'));
  });

  await t.test('top-level verdict must reduce from mandatory claims', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    verdict.verdictStatus = 'failed';

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'incoherent');
    assert.ok(reasonCodes(inspection).includes('journey_reduction_mismatch'));
  });
});

test('claim verdict reduction keeps unsupported contracts outside the inspector boundary', async (t: any) => {
  await t.test('legacy scenario', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    scenario.schemaVersion = '1.0.0';
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'outside_contract');
    assert.equal(inspection.trust, 'inventory_reduction_only');
    assert.equal(inspection.nextAction, 'supply_supported_claim_contracts');
    assert.ok(reasonCodes(inspection).includes('scenario_schema_outside_contract'));
  });

  await t.test('legacy verdict', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    verdict.schemaVersion = '1.0.0';
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'outside_contract');
    assert.ok(reasonCodes(inspection).includes('verdict_schema_outside_contract'));
  });

  await t.test('structurally invalid scenario', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    delete scenario.safety;
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'outside_contract');
    assert.ok(reasonCodes(inspection).includes('scenario_schema_invalid'));
  });

  await t.test('structurally invalid verdict', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    delete verdict.claimResults[0].nextAction;
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'outside_contract');
    assert.ok(reasonCodes(inspection).includes('verdict_schema_invalid'));
  });

  await t.test('selected platform outside scenario', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    scenario.platforms = ['ios'];
    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'android' }, verdict);
    assert.equal(inspection.reductionStatus, 'outside_contract');
    assert.ok(reasonCodes(inspection).includes('selected_platform_outside_contract'));
  });

  await t.test('selection with no applicable mandatory claim is outside contract', () => {
    const scenario = scenarioFixture();
    const verdict = verdictFixture(scenario);
    findClaim(scenario, 'primary-journey').applicability.platforms = ['android'];
    findClaim(scenario, 'secondary-mandatory').applicability.platforms = ['android'];

    const inspection = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
    assert.equal(inspection.reductionStatus, 'outside_contract');
    assert.ok(reasonCodes(inspection).includes('selection_has_no_mandatory_claim'));
  });
});

test('claim verdict reduction applies exact positive and nonmatching variant selection', async (t: any) => {
  await t.test('selected beta includes unscoped and beta-only claims', () => {
    const scenario = scenarioFixture();
    const selection = { platform: 'ios' as const, variant: 'beta' };
    const verdict = verdictForSelection(scenario, selection);

    const inspection = inspectScenarioClaimVerdictReduction(scenario, selection, verdict);
    assert.equal(inspection.reductionStatus, 'reduced');
    assert.deepEqual(inspection.applicableClaimIds, [
      'primary-journey',
      'secondary-mandatory',
      'supplemental-order',
      'beta-only',
    ]);
    assert.deepEqual(inspection.excludedClaimIds, ['android-only']);
  });

  await t.test('nonmatching variant preserves unscoped claims and excludes beta-only', () => {
    const scenario = scenarioFixture();
    const selection = { platform: 'ios' as const, variant: 'stable' };
    const verdict = verdictForSelection(scenario, selection);

    const inspection = inspectScenarioClaimVerdictReduction(scenario, selection, verdict);
    assert.equal(inspection.reductionStatus, 'reduced');
    assert.deepEqual(inspection.applicableClaimIds, [
      'primary-journey',
      'secondary-mandatory',
      'supplemental-order',
    ]);
    assert.deepEqual(inspection.excludedClaimIds, ['android-only', 'beta-only']);
  });
});

test('claim verdict reduction reports scenario identity mismatch without mutating input', () => {
  const scenario = scenarioFixture();
  const verdict = verdictFixture(scenario);
  verdict.scenarioId = 'different-scenario';
  const beforeScenario = JSON.stringify(scenario);
  const beforeVerdict = JSON.stringify(verdict);

  const first = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);
  const second = inspectScenarioClaimVerdictReduction(scenario, { platform: 'ios' }, verdict);

  assert.equal(first.reductionStatus, 'incoherent');
  assert.ok(reasonCodes(first).includes('scenario_id_mismatch'));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(scenario), beforeScenario);
  assert.equal(JSON.stringify(verdict), beforeVerdict);
});
