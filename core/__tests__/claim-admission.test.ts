const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLAIM_ADMISSION_INSPECTION_VERSION,
  inspectScenarioClaimAdmission,
} = require('../claim-admission');
const {
  assertScenarioExecutionContractSupported,
} = require('../claim-contract');
const {
  buildScenarioClaimCompleteContractHash,
} = require('../scenario-claim-approval');

const ROOT = path.join(__dirname, '..', '..', '..');

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
  scenario.description = 'Complete one coherent admitted journey.';
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
      allowedOperations: ['observe'],
    };
  } else {
    scenario.safety = {
      class: safetyClass,
      rationale: 'The scenario performs one declared bounded mutation.',
      allowedOperations: ['create-test-record'],
      mutationIdentity: {
        id: 'test-record',
        assertionIds: ['journey-completed-event'],
      },
      rollback: {
        status: 'required',
        rationale: 'Restore the prior state.',
        assertionIds: ['journey-completed-event'],
      },
      cleanup: {
        status: 'required',
        rationale: 'Remove the bounded test record.',
        assertionIds: ['journey-completed-event'],
      },
      reconciliation: {
        terminalInvariantIds: ['terminal-state-stable'],
        assertionIds: ['journey-completed-event'],
      },
    };
  }
  scenario.dependencies = [];
  return scenario;
}

function authorityCatalog(): JsonRecord[] {
  return [
    {
      schemaVersion: '1.0.0',
      declarationId: 'app-profile-authority',
      role: 'app',
      producerId: 'app-profile-session',
      platforms: ['ios', 'android'],
      assertionKinds: ['eventOccurrence'],
      evidenceSelectors: [
        'profileEvents.journey_completed',
        'profileEvents.entry_ready',
      ],
      maxStrength: 'verified',
      maxCompleteness: 'continuous-complete',
    },
  ];
}

function selection(variant?: string): JsonRecord {
  return {
    platform: 'ios',
    ...(variant === undefined ? {} : { variant }),
  };
}

function approvalFor(scenario: JsonRecord, selected = selection()): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    approvalId: 'admission-approval',
    scenarioId: scenario.id,
    scenarioHash: buildScenarioClaimCompleteContractHash(scenario),
    selection: selected,
    decision: 'approved',
    approvedAt: '2026-08-21T12:00:00Z',
    approverRef: 'local-human-review',
  };
}

function requestFor(scenario: JsonRecord): JsonRecord {
  return {
    goalId: 'verify-product-intent',
    operations: [...scenario.safety.allowedOperations],
    targetResource: 'mobile-target:ios:simulator-1',
    nowMs: Date.parse('2026-08-21T12:00:00.000Z'),
  };
}

function grantFor(scenario: JsonRecord, selected = selection()): JsonRecord {
  const grant: JsonRecord = {
    schemaVersion: '1.0.0',
    grantId: 'admission-grant',
    scenarioId: scenario.id,
    scenarioHash: buildScenarioClaimCompleteContractHash(scenario),
    selection: selected,
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
  return grant;
}

function inputFor(
  scenario: JsonRecord,
  overrides: JsonRecord = {},
  selected = selection(),
): JsonRecord {
  return {
    scenario,
    selection: selected,
    authorityCatalog: authorityCatalog(),
    authorizationRequest: requestFor(scenario),
    authorizationGrant: grantFor(scenario, selected),
    approval: approvalFor(scenario, selected),
    ...overrides,
  };
}

function statuses(result: JsonRecord): Array<[string, string]> {
  return result.gateSummaries.map((summary: JsonRecord) => [summary.gate, summary.status]);
}

test('admits a complete read-only scenario without enabling execution', () => {
  const scenario = sampleScenario();
  const result = inspectScenarioClaimAdmission(inputFor(scenario));

  assert.equal(CLAIM_ADMISSION_INSPECTION_VERSION, '1.0.0');
  assert.equal(result.status, 'admitted');
  assert.equal(result.scenarioSchemaVersion, '1.1.0');
  assert.equal(result.scenarioHash, buildScenarioClaimCompleteContractHash(scenario));
  assert.deepEqual(result.selection, { platform: 'ios' });
  assert.deepEqual(statuses(result), [
    ['closure', 'closed'],
    ['authority', 'compatible'],
    ['safety', 'complete'],
    ['authorization', 'compatible'],
    ['approval', 'bound'],
    ['dependencies', 'complete'],
  ]);
  assert.deepEqual(result.blockingGates, []);
  assert.equal(Object.hasOwn(result, 'firstBlockingGate'), false);
  assert.equal(Object.hasOwn(result, 'nextAction'), false);
  assert.throws(() => assertScenarioExecutionContractSupported(scenario), /reader-only/u);
});

test('admits exact variants, explicit empty dependencies, and complete mutation safety', () => {
  const readOnly = sampleScenario();
  const selected = selection('compact');
  const readOnlyResult = inspectScenarioClaimAdmission(inputFor(readOnly, {}, selected));
  assert.equal(readOnlyResult.status, 'admitted');
  assert.deepEqual(readOnlyResult.selection, selected);

  const mutating = sampleScenario('local_mutation');
  const mutatingResult = inspectScenarioClaimAdmission(inputFor(mutating));
  assert.equal(mutatingResult.status, 'admitted');
  assert.equal(mutatingResult.inspections.safety.safetyContract, 'complete');
  assert.equal(mutatingResult.inspections.authorization.authorizationCompatibility, 'compatible');
});

test('fails gate one without touching owner inputs', () => {
  const legacy = readJson('examples/scenarios/mobile/app-startup.json');
  const poison = (): never => {
    throw new Error('owner input was read');
  };
  const poisonedInput: JsonRecord = {
    scenario: legacy,
    selection: { platform: 'ios' },
    get authorityCatalog() { return poison(); },
    get authorizationRequest() { return poison(); },
    get authorizationGrant() { return poison(); },
    get approval() { return poison(); },
  };

  const legacyResult = inspectScenarioClaimAdmission(poisonedInput);
  assert.equal(legacyResult.status, 'outside_contract');
  assert.equal(legacyResult.nextAction, 'supply_claim_complete_scenario');
  assert.deepEqual(legacyResult.gateSummaries, [
    { gate: 'schema_and_selection', status: 'failed' },
  ]);
  assert.equal(Object.hasOwn(legacyResult, 'scenarioHash'), false);
  assert.equal(Object.hasOwn(legacyResult, 'inspections'), false);

  const malformedInput: JsonRecord = {
    scenario: legacy,
    selection: { platform: 'ios', extra: true },
    get authorityCatalog() { return poison(); },
    get authorizationRequest() { return poison(); },
    get authorizationGrant() { return poison(); },
    get approval() { return poison(); },
  };
  const malformedSelection = inspectScenarioClaimAdmission(malformedInput);
  assert.equal(malformedSelection.nextAction, 'supply_valid_admission_selection');

  const undeclared = sampleScenario();
  undeclared.platforms = ['ios'];
  const undeclaredInput: JsonRecord = {
    scenario: undeclared,
    selection: { platform: 'android' },
    get authorityCatalog() { return poison(); },
    get authorizationRequest() { return poison(); },
    get authorizationGrant() { return poison(); },
    get approval() { return poison(); },
  };
  const undeclaredResult = inspectScenarioClaimAdmission(undeclaredInput);
  assert.equal(undeclaredResult.status, 'outside_contract');
  assert.equal(undeclaredResult.nextAction, 'declare_selected_platform');
  assert.equal(Object.hasOwn(undeclaredResult, 'scenarioHash'), false);

  const cyclic = sampleScenario();
  cyclic.self = cyclic;
  const cyclicInput: JsonRecord = {
    scenario: cyclic,
    selection: { platform: 'ios' },
    get authorityCatalog() { return poison(); },
    get authorizationRequest() { return poison(); },
    get authorizationGrant() { return poison(); },
    get approval() { return poison(); },
  };
  const cyclicResult = inspectScenarioClaimAdmission(cyclicInput);
  assert.equal(cyclicResult.status, 'outside_contract');
  assert.equal(cyclicResult.nextAction, 'supply_claim_complete_scenario');
});

test('rejects malformed selection variants before scenario inspection', () => {
  for (const selected of [
    null,
    [],
    {},
    { platform: 'web' },
    { platform: 'ios', variant: '' },
    { platform: 'ios', variant: '   ' },
    { platform: 'ios', unknown: true },
  ]) {
    const result = inspectScenarioClaimAdmission({
      scenario: sampleScenario(),
      selection: selected,
    } as JsonRecord);
    assert.equal(result.status, 'outside_contract');
    assert.equal(result.nextAction, 'supply_valid_admission_selection');
    assert.equal(Object.hasOwn(result, 'scenarioSchemaVersion'), false);
  }
});

test('preserves every owner failure and chooses the doctrine-first blocker', () => {
  const scenario = sampleScenario();
  scenario.claims[0].closes.phases = ['missing-phase'];
  const input = inputFor(scenario, {
    authorityCatalog: [],
    authorizationGrant: grantFor(scenario),
    approval: approvalFor(scenario),
  });
  input.authorizationGrant.expiresAt = '2026-08-21T11:59:59.000Z';
  input.approval.scenarioHash = '0'.repeat(64);

  const result = inspectScenarioClaimAdmission(input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.firstBlockingGate, 'closure');
  assert.deepEqual(result.blockingGates, [
    'closure',
    'authority',
    'authorization',
    'approval',
  ]);
  assert.equal(result.nextAction, 'resolve_first_blocking_admission_gate');
  assert.equal(result.inspections.safety.safetyContract, 'complete');
  assert.equal(result.inspections.dependencies.dependencyContract, 'complete');
});

test('keeps dependency predicate authority separate from dependency integrity', () => {
  const authorityMissing = sampleScenario();
  authorityMissing.dependencies = [
    {
      id: 'entry-ready',
      kind: 'journey_entry',
      applicability: { platforms: ['ios'] },
      predicate: {
        id: 'entry-ready-event',
        kind: 'eventOccurrence',
        event: 'entry_ready',
        authority: {
          role: 'app',
          producerId: 'missing-producer',
          evidenceSelector: 'profileEvents.missing_entry',
          requiredStrength: 'observed',
          completeness: 'point',
        },
      },
    },
  ];
  const authorityResult = inspectScenarioClaimAdmission(inputFor(authorityMissing));
  assert.equal(authorityResult.status, 'blocked');
  assert.equal(authorityResult.firstBlockingGate, 'authority');
  assert.equal(authorityResult.inspections.dependencies.dependencyContract, 'complete');
  assert.equal(JSON.stringify(authorityResult).includes('not_applicable'), false);

  const invalidDependency = sampleScenario();
  invalidDependency.dependencies = [
    {
      id: 'claim-entry',
      kind: 'claim_scoped',
      applicability: { platforms: ['ios'] },
      claimIds: ['unknown-claim'],
      predicate: {
        id: 'entry-ready-event',
        kind: 'eventOccurrence',
        event: 'entry_ready',
        authority: {
          role: 'app',
          producerId: 'app-profile-session',
          evidenceSelector: 'profileEvents.entry_ready',
          requiredStrength: 'observed',
          completeness: 'point',
        },
      },
    },
  ];
  const dependencyResult = inspectScenarioClaimAdmission(inputFor(invalidDependency));
  assert.equal(dependencyResult.status, 'blocked');
  assert.equal(dependencyResult.firstBlockingGate, 'dependencies');
  assert.equal(dependencyResult.inspections.authority.authorityCompatibility, 'compatible');
  assert.deepEqual(dependencyResult.blockingGates, ['dependencies']);
});

test('keeps selected-platform assertion authority absence blocking', () => {
  const scenario = sampleScenario();
  const result = inspectScenarioClaimAdmission(inputFor(scenario, { authorityCatalog: [] }));

  assert.equal(result.status, 'blocked');
  assert.equal(result.firstBlockingGate, 'authority');
  assert.deepEqual(result.blockingGates, ['authority']);
  assert.equal(result.inspections.authority.authorityCompatibility, 'incompatible');
  assert.equal(JSON.stringify(result).includes('not_applicable'), false);
});

test('keeps mutation safety and authorization as separate ordered blockers', () => {
  const scenario = sampleScenario('local_mutation');
  scenario.safety.mutationIdentity.assertionIds = ['missing-assertion'];
  const result = inspectScenarioClaimAdmission(inputFor(scenario));

  assert.equal(result.status, 'blocked');
  assert.equal(result.firstBlockingGate, 'safety');
  assert.deepEqual(result.blockingGates.slice(0, 2), ['safety', 'authorization']);
  assert.equal(result.inspections.safety.safetyContract, 'incomplete');
  assert.equal(result.inspections.authorization.authorizationCompatibility, 'outside_contract');
});

test('preserves authorization and approval invalidation after dependency hash drift', () => {
  const scenario = sampleScenario();
  const input = inputFor(scenario);
  scenario.dependencies = [
    {
      id: 'entry-ready',
      kind: 'journey_entry',
      applicability: { platforms: ['ios'] },
      predicate: {
        id: 'entry-ready-event',
        kind: 'eventOccurrence',
        event: 'entry_ready',
        authority: {
          role: 'app',
          producerId: 'app-profile-session',
          evidenceSelector: 'profileEvents.entry_ready',
          requiredStrength: 'observed',
          completeness: 'point',
        },
      },
    },
  ];

  const result = inspectScenarioClaimAdmission(input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.firstBlockingGate, 'authorization');
  assert.deepEqual(result.blockingGates, ['authorization', 'approval']);
  assert.equal(result.inspections.authorization.authorizationCompatibility, 'incompatible');
  assert.equal(result.inspections.approval.approvalBinding, 'invalidated');
  assert.equal(result.inspections.dependencies.dependencyContract, 'complete');
});
