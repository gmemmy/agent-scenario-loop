const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SCENARIO_CLAIM_AUTHORIZATION_GRANT_SCHEMA_VERSION,
  SCENARIO_CLAIM_AUTHORIZATION_INSPECTION_VERSION,
  inspectScenarioClaimAuthorization,
} = require('../scenario-claim-authorization');
const {
  assertScenarioExecutionContractSupported,
} = require('../claim-contract');
const {
  buildScenarioClaimCompleteContractHash,
} = require('../scenario-claim-approval');
const { SCHEMAS, validateJson } = require('../schema-validator');

const ROOT = path.join(__dirname, '..', '..', '..');
const CHECK_ORDER = [
  'scenario_claim_complete_schema',
  'selection_platform_declared',
  'static_safety_contract',
  'authorization_request_structure',
  'authorization_grant_structure',
  'scenario_identity',
  'scenario_contract_hash',
  'selection_binding',
  'safety_class_binding',
  'mutation_identity_binding',
  'goal_binding',
  'target_resource_binding',
  'operation_scope_binding',
  'expiry_binding',
];

type JsonRecord = Record<string, any>;

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function sampleScenario(safetyClass = 'read_only'): JsonRecord {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.schemaVersion = '1.1.0';
  scenario.platforms = ['ios', 'android'];
  scenario.description = 'Complete one coherent authorized journey.';
  scenario.journey = {
    name: 'Complete one coherent journey',
    intent: 'Reach and preserve the intended terminal product state.',
    actor: 'returning user',
    startState: 'the app is ready at the journey entry surface',
    endState: 'the intended product result is visible and stable',
    phases: [
      { id: 'complete-intent', description: 'Complete the product intent.', coverageKind: 'product' },
    ],
    terminalInvariants: [
      {
        id: 'terminal-state-stable',
        description: 'The terminal product state remains stable.',
        coverageKind: 'product',
      },
    ],
    recovery: {
      status: 'not_required',
      rationale: 'This bounded contract does not include an interruption.',
    },
  };
  scenario.claims = [
    {
      id: 'journey-completes',
      role: 'mandatory',
      applicability: { platforms: ['ios', 'android'] },
      closes: {
        phases: ['complete-intent'],
        terminalInvariants: ['terminal-state-stable'],
      },
      assertions: [
        {
          id: 'journey-completed-event',
          kind: 'eventOccurrence',
          event: 'journey_completed',
          authority: {
            role: 'app',
            producerId: 'app-profile-session',
            evidenceSelector: 'profileEvents.journey_completed',
            requiredStrength: 'observed',
            completeness: 'point',
          },
        },
      ],
    },
  ];
  if (safetyClass === 'read_only') {
    scenario.safety = {
      class: 'read_only',
      rationale: 'The scenario observes product behavior without mutation.',
      allowedOperations: ['observe', 'navigate'],
    };
  } else {
    const required = {
      status: 'required',
      rationale: 'Restore trustworthy state.',
      assertionIds: ['journey-completed-event'],
    };
    scenario.safety = {
      class: safetyClass,
      rationale: 'The scenario performs one declared bounded mutation.',
      allowedOperations: ['create-test-record', 'remove-test-record'],
      mutationIdentity: {
        id: 'test-record',
        assertionIds: ['journey-completed-event'],
      },
      rollback: clone(required),
      cleanup: clone(required),
      reconciliation: {
        terminalInvariantIds: ['terminal-state-stable'],
        assertionIds: ['journey-completed-event'],
      },
    };
  }
  return scenario;
}

function requestFor(scenario: JsonRecord, overrides: JsonRecord = {}): JsonRecord {
  return {
    goalId: 'verify-product-intent',
    operations: [...scenario.safety.allowedOperations],
    targetResource: 'mobile-target:ios:simulator-1',
    nowMs: Date.parse('2026-08-21T12:00:00.000Z'),
    ...overrides,
  };
}

function grantFor(scenario: JsonRecord, overrides: JsonRecord = {}): JsonRecord {
  const grant: JsonRecord = {
    schemaVersion: '1.0.0',
    grantId: 'claim-run-grant',
    scenarioId: scenario.id,
    scenarioHash: buildScenarioClaimCompleteContractHash(scenario),
    selection: { platform: 'ios' },
    safetyClass: scenario.safety.class,
    goalId: 'verify-product-intent',
    operations: [...scenario.safety.allowedOperations],
    targetResource: 'mobile-target:ios:simulator-1',
    expiresAt: '2026-08-21T12:00:01.000Z',
    delegationChain: ['local-owner', 'bounded-worker'],
  };
  if (scenario.safety.class !== 'read_only') {
    grant.mutationIdentityId = scenario.safety.mutationIdentity.id;
  }
  return { ...grant, ...overrides };
}

function inspect(
  scenario: JsonRecord,
  grant = grantFor(scenario),
  request = requestFor(scenario),
  selection: JsonRecord = { platform: 'ios' },
): JsonRecord {
  return inspectScenarioClaimAuthorization(scenario, selection, request, grant);
}

function reasonCodes(result: JsonRecord): string[] {
  return result.blockingReasons.map((reason: JsonRecord) => reason.code);
}

test('binds an exact read-only grant without claiming runtime admission', () => {
  const scenario = sampleScenario();
  const grant = grantFor(scenario);
  const result = inspect(scenario, grant);

  assert.equal(SCENARIO_CLAIM_AUTHORIZATION_GRANT_SCHEMA_VERSION, '1.0.0');
  assert.equal(SCENARIO_CLAIM_AUTHORIZATION_INSPECTION_VERSION, '1.0.0');
  assert.equal(validateJson(grant, SCHEMAS.scenarioClaimAuthorizationGrant, 'grant').valid, true);
  assert.equal(result.authorizationCompatibility, 'compatible');
  assert.equal(result.nextAction, 'authorization_inspection_complete');
  assert.deepEqual(result.blockingReasons, []);
  assert.deepEqual(result.checks.map((check: JsonRecord) => check.code), CHECK_ORDER);
  assert.equal(result.checks.every((check: JsonRecord) => check.status === 'satisfied'), true);
  assert.equal(Object.hasOwn(result, 'admitted'), false);
  assert.equal(Object.hasOwn(result, 'authorized'), false);
  assert.throws(() => assertScenarioExecutionContractSupported(scenario), /reader-only/u);
});

test('binds every mutating safety class only with the authored mutation identity', () => {
  for (const safetyClass of [
    'local_mutation',
    'reversible_backend_mutation',
    'destructive',
  ]) {
    const scenario = sampleScenario(safetyClass);
    const result = inspect(scenario);
    assert.equal(result.authorizationCompatibility, 'compatible', safetyClass);

    const mismatch = inspect(scenario, grantFor(scenario, { mutationIdentityId: 'other-record' }));
    assert.equal(mismatch.authorizationCompatibility, 'incompatible');
    assert.deepEqual(reasonCodes(mismatch), ['mutation_identity_mismatch']);
  }
});

test('keeps malformed selection and undeclared platforms outside the contract', () => {
  const scenario = sampleScenario();
  const malformed = inspect(scenario, grantFor(scenario), requestFor(scenario), {
    platform: 'ios',
    extra: true,
  });
  assert.equal(malformed.authorizationCompatibility, 'outside_contract');
  assert.equal(Object.hasOwn(malformed, 'platform'), false);
  assert.deepEqual(reasonCodes(malformed), ['malformed_selection']);
  assert.equal(malformed.nextAction, 'supply_valid_authorization_selection');
  assert.equal(malformed.checks[1].status, 'failed');
  assert.equal(malformed.checks.filter((check: JsonRecord) => check.status === 'satisfied').length, 0);

  const iosOnly = sampleScenario();
  iosOnly.platforms = ['ios'];
  const undeclared = inspect(
    iosOnly,
    grantFor(iosOnly, { selection: { platform: 'android' } }),
    requestFor(iosOnly, { targetResource: 'mobile-target:android:emulator-1' }),
    { platform: 'android' },
  );
  assert.deepEqual(reasonCodes(undeclared), ['undeclared_platform']);
  assert.equal(undeclared.nextAction, 'declare_selected_platform');
  assert.equal(undeclared.checks[0].status, 'satisfied');
  assert.equal(undeclared.checks[1].status, 'failed');
  assert.equal(undeclared.checks[2].status, 'not_evaluated');
});

test('classifies legacy, future, malformed, cyclic, and nonfinite scenarios', () => {
  const valid = sampleScenario();
  const legacy = readJson('examples/scenarios/mobile/app-startup.json');
  const future = { ...valid, schemaVersion: '2.0.0' };
  const malformed = { ...valid };
  delete malformed.claims;
  const cyclic = clone(valid);
  cyclic.self = cyclic;
  const nonfinite = clone(valid);
  nonfinite.adapterOptions = { sample: Number.POSITIVE_INFINITY };
  const cases: Array<[JsonRecord, string]> = [
    [legacy, 'legacy_scenario_schema'],
    [future, 'unknown_scenario_schema'],
    [malformed, 'malformed_scenario'],
    [cyclic, 'malformed_scenario'],
    [nonfinite, 'malformed_scenario'],
  ];
  for (const [scenario, code] of cases) {
    const result = inspectScenarioClaimAuthorization(
      scenario,
      { platform: 'ios' },
      requestFor(valid),
      grantFor(valid),
    );
    assert.equal(result.authorizationCompatibility, 'outside_contract', code);
    assert.deepEqual(reasonCodes(result), [code]);
    assert.equal(result.checks[0].status, 'failed');
    assert.equal(result.checks[1].status, 'not_evaluated');
  }
});

test('requires a complete static safety contract before inspecting authorization', () => {
  const scenario = sampleScenario('local_mutation');
  scenario.safety.mutationIdentity.assertionIds = ['missing-assertion'];
  const result = inspect(scenario);
  assert.equal(validateJson(scenario, SCHEMAS.scenario, 'scenario').valid, true);
  assert.equal(result.authorizationCompatibility, 'outside_contract');
  assert.deepEqual(reasonCodes(result), ['incomplete_safety_contract']);
  assert.equal(result.checks[2].status, 'failed');
  assert.equal(result.checks[3].status, 'not_evaluated');
});

test('rejects malformed closed requests without evaluating grants', () => {
  const scenario = sampleScenario();
  const requests = [
    requestFor(scenario, { extra: true }),
    requestFor(scenario, { operations: [] }),
    requestFor(scenario, { operations: ['observe', 'observe'] }),
    requestFor(scenario, { operations: ['observe', ' '] }),
    requestFor(scenario, { targetResource: '' }),
    requestFor(scenario, { nowMs: Number.NaN }),
  ];
  for (const request of requests) {
    const result = inspect(scenario, grantFor(scenario), request);
    assert.equal(result.authorizationCompatibility, 'outside_contract');
    assert.deepEqual(reasonCodes(result), ['malformed_authorization_request']);
    assert.equal(result.checks[3].status, 'failed');
    assert.equal(result.checks[4].status, 'not_evaluated');
  }
});

test('rejects malformed grants, impossible dates, and credential fields without leakage', () => {
  const scenario = sampleScenario();
  const valid = grantFor(scenario);
  const missing = clone(valid);
  delete missing.targetResource;
  const cyclic = clone(valid);
  cyclic.self = cyclic;
  const cases = [
    missing,
    { ...valid, extra: true },
    { ...valid, scenarioHash: 'A'.repeat(64) },
    { ...valid, expiresAt: '2026-02-30T00:00:00Z' },
    { ...valid, operations: [] },
    { ...valid, operations: ['observe', 'observe'] },
    { ...valid, delegationChain: [] },
    { ...valid, delegationChain: ['owner', 'owner'] },
    cyclic,
  ];
  for (const grant of cases) {
    const result = inspect(scenario, grant);
    assert.equal(result.authorizationCompatibility, 'outside_contract');
    assert.deepEqual(reasonCodes(result), ['malformed_authorization_grant']);
  }

  const secret = 'must-not-appear';
  const credential = inspect(scenario, { ...valid, accessToken: secret });
  assert.deepEqual(reasonCodes(credential), ['credential_field_forbidden']);
  assert.equal(JSON.stringify(credential).includes(secret), false);

  const malformedCredential = inspect(scenario, {
    ...valid,
    delegationChain: [],
    nested: { password: secret },
  });
  assert.deepEqual(reasonCodes(malformedCredential), ['credential_field_forbidden']);
  assert.equal(JSON.stringify(malformedCredential).includes(secret), false);

  const cyclicCredential = clone(valid);
  cyclicCredential.accessToken = secret;
  cyclicCredential.self = cyclicCredential;
  const cyclicCredentialResult = inspect(scenario, cyclicCredential);
  assert.deepEqual(reasonCodes(cyclicCredentialResult), ['malformed_authorization_grant']);
  assert.equal(JSON.stringify(cyclicCredentialResult).includes(secret), false);

  const readOnlyMutation = inspect(scenario, { ...valid, mutationIdentityId: 'test-record' });
  assert.deepEqual(reasonCodes(readOnlyMutation), ['malformed_authorization_grant']);
  const mutating = sampleScenario('local_mutation');
  const missingIdentity = grantFor(mutating);
  delete missingIdentity.mutationIdentityId;
  assert.deepEqual(reasonCodes(inspect(mutating, missingIdentity)), ['malformed_authorization_grant']);
});

test('reports every independent identity, selection, safety, goal, and target mismatch', () => {
  const scenario = sampleScenario('local_mutation');
  const result = inspect(
    scenario,
    grantFor(scenario, {
      scenarioId: 'other-scenario',
      scenarioHash: 'b'.repeat(64),
      selection: { platform: 'android', variant: 'other' },
      safetyClass: 'destructive',
      mutationIdentityId: 'other-record',
      goalId: 'other-goal',
      targetResource: 'mobile-target:ios:other',
    }),
    requestFor(scenario),
    { platform: 'ios' },
  );
  assert.equal(result.authorizationCompatibility, 'incompatible');
  assert.deepEqual(reasonCodes(result), [
    'scenario_id_mismatch',
    'scenario_hash_mismatch',
    'selection_platform_mismatch',
    'selection_variant_mismatch',
    'safety_class_mismatch',
    'mutation_identity_mismatch',
    'goal_id_mismatch',
    'target_resource_mismatch',
  ]);
  assert.equal(result.nextAction, 'reissue_authorization_for_scenario_identity');
  assert.equal(result.checks.slice(5, 12).every((check: JsonRecord) => check.status === 'failed'), true);
  assert.equal(result.checks[12].status, 'satisfied');
  assert.equal(result.checks[13].status, 'satisfied');
});

test('requires exact operation sets while ignoring authored order', () => {
  const scenario = sampleScenario();
  const under = inspect(
    scenario,
    grantFor(scenario, { operations: ['observe'] }),
    requestFor(scenario),
  );
  assert.deepEqual(reasonCodes(under), ['operation_scope_under_scoped']);

  const over = inspect(
    scenario,
    grantFor(scenario, { operations: ['observe', 'navigate', 'delete'] }),
    requestFor(scenario),
  );
  assert.deepEqual(reasonCodes(over), ['operation_scope_over_scoped']);

  const both = inspect(
    scenario,
    grantFor(scenario, { operations: ['observe', 'delete'] }),
    requestFor(scenario),
  );
  assert.deepEqual(reasonCodes(both), [
    'operation_scope_under_scoped',
    'operation_scope_over_scoped',
  ]);

  const reordered = inspect(
    scenario,
    grantFor(scenario, { operations: ['navigate', 'observe'] }),
    requestFor(scenario),
  );
  assert.equal(reordered.authorizationCompatibility, 'compatible');

  const reorderedRequest = inspect(
    scenario,
    grantFor(scenario),
    requestFor(scenario, { operations: ['navigate', 'observe'] }),
  );
  assert.equal(reorderedRequest.authorizationCompatibility, 'compatible');
});

test('uses the caller clock and expires at the exact boundary', () => {
  const scenario = sampleScenario();
  const grant = grantFor(scenario, { expiresAt: '2026-08-21T12:00:00.123Z' });
  const before = inspect(
    scenario,
    grant,
    requestFor(scenario, { nowMs: Date.parse('2026-08-21T12:00:00.122Z') }),
  );
  assert.equal(before.authorizationCompatibility, 'compatible');

  const boundary = inspect(
    scenario,
    grant,
    requestFor(scenario, { nowMs: Date.parse('2026-08-21T12:00:00.123Z') }),
  );
  assert.equal(boundary.authorizationCompatibility, 'incompatible');
  assert.deepEqual(reasonCodes(boundary), ['authorization_expired']);
  assert.equal(boundary.nextAction, 'reissue_unexpired_authorization');
});

test('binds the complete scenario hash with stable object order and significant array order', () => {
  const scenario = sampleScenario();
  const originalHash = buildScenarioClaimCompleteContractHash(scenario);
  const reorderedObject = Object.fromEntries(Object.entries(scenario).reverse());
  assert.equal(buildScenarioClaimCompleteContractHash(reorderedObject), originalHash);

  const reorderedArray = clone(scenario);
  reorderedArray.platforms.reverse();
  assert.notEqual(buildScenarioClaimCompleteContractHash(reorderedArray), originalHash);

  for (const mutate of [
    (candidate: JsonRecord) => { candidate.description = 'Edited description.'; },
    (candidate: JsonRecord) => { candidate.steps[0].id = 'edited-step'; },
    (candidate: JsonRecord) => { candidate.safety.rationale = 'Edited safety rationale.'; },
    (candidate: JsonRecord) => { candidate.claims[0].assertions[0].event = 'edited_event'; },
  ]) {
    const edited = clone(scenario);
    mutate(edited);
    const result = inspect(edited, grantFor(scenario), requestFor(edited));
    assert.equal(result.authorizationCompatibility, 'incompatible');
    assert.deepEqual(reasonCodes(result), ['scenario_hash_mismatch']);
  }
});
