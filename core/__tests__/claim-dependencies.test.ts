const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLAIM_DEPENDENCY_INSPECTION_VERSION,
  inspectScenarioClaimDependencies,
} = require('../claim-dependencies');
const {
  buildScenarioClaimCompleteContractHash,
  inspectScenarioClaimApproval,
} = require('../scenario-claim-approval');
const { SCHEMAS, validateJson } = require('../schema-validator');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function predicate(id: string, selector: string): JsonRecord {
  return {
    id,
    kind: 'eventOccurrence',
    event: id.replaceAll('-', '_'),
    authority: {
      role: 'app',
      producerId: 'app-profile-session',
      evidenceSelector: selector,
      requiredStrength: 'observed',
      completeness: 'point',
    },
  };
}

function sampleScenario(): JsonRecord {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.schemaVersion = '1.1.0';
  scenario.platforms = ['ios', 'android'];
  scenario.journey = {
    name: 'Complete one coherent journey',
    intent: 'Reach and preserve the intended terminal product state.',
    actor: 'returning user',
    startState: 'the app is ready at the journey entry surface',
    endState: 'the intended product result is visible and stable',
    phases: [
      { id: 'complete-intent', description: 'Complete the intent.', coverageKind: 'product' },
    ],
    terminalInvariants: [
      { id: 'terminal-stable', description: 'Terminal state is stable.', coverageKind: 'product' },
    ],
    recovery: {
      status: 'not_required',
      rationale: 'No interruption is authored.',
    },
  };
  scenario.claims = [
    {
      id: 'journey-completes',
      role: 'mandatory',
      applicability: { platforms: ['ios', 'android'] },
      closes: { phases: ['complete-intent'], terminalInvariants: ['terminal-stable'] },
      assertions: [predicate('journey-completed', 'events.journey_completed')],
    },
    {
      id: 'journey-diagnostic',
      role: 'supplemental',
      applicability: { platforms: ['ios'], variants: ['reopen'] },
      closes: { phases: ['complete-intent'] },
      assertions: [predicate('diagnostic-observed', 'events.diagnostic_observed')],
    },
  ];
  scenario.safety = {
    class: 'read_only',
    rationale: 'The scenario observes product behavior without mutation.',
    allowedOperations: ['observe'],
  };
  scenario.dependencies = [];
  return scenario;
}

function entryDependency(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'app-ready',
    kind: 'journey_entry',
    applicability: { platforms: ['ios', 'android'] },
    predicate: predicate('app-ready-predicate', 'events.app_ready'),
    ...overrides,
  };
}

function claimDependency(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'conversation-loaded',
    kind: 'claim_scoped',
    applicability: { platforms: ['ios'] },
    claimIds: ['journey-completes'],
    predicate: predicate('conversation-loaded-predicate', 'events.conversation_loaded'),
    ...overrides,
  };
}

function reasonCodes(result: JsonRecord): string[] {
  return result.blockingReasons.map((reason: JsonRecord) => reason.code);
}

test('requires an explicit dependency inventory while preserving legacy isolation', () => {
  const explicitEmpty = sampleScenario();
  const omitted = sampleScenario();
  delete omitted.dependencies;
  const legacy = readJson('examples/scenarios/mobile/app-startup.json');
  const legacyWithDependencies = clone(legacy);
  legacyWithDependencies.dependencies = [];

  assert.equal(validateJson(explicitEmpty, SCHEMAS.scenario, 'explicit empty').valid, true);
  assert.equal(validateJson(omitted, SCHEMAS.scenario, 'omitted').valid, false);
  assert.equal(validateJson(legacyWithDependencies, SCHEMAS.scenario, 'legacy').valid, false);

  const inspection = inspectScenarioClaimDependencies(explicitEmpty, { platform: 'ios' });
  assert.equal(CLAIM_DEPENDENCY_INSPECTION_VERSION, '1.0.0');
  assert.equal(inspection.dependencyContract, 'complete');
  assert.deepEqual(inspection.applicableDependencyIds, []);
  assert.equal(inspection.checks.every((check: JsonRecord) => check.status === 'satisfied'), true);

  const legacyInspection = inspectScenarioClaimDependencies(legacy, { platform: 'ios' });
  assert.equal(legacyInspection.dependencyContract, 'outside_contract');
  assert.deepEqual(reasonCodes(legacyInspection), ['legacy_scenario_schema']);
  assert.equal(legacyInspection.nextAction, 'supply_claim_complete_scenario');

  const omittedInspection = inspectScenarioClaimDependencies(omitted, { platform: 'ios' });
  assert.equal(omittedInspection.dependencyContract, 'outside_contract');
  assert.deepEqual(reasonCodes(omittedInspection), ['malformed_scenario']);
  assert.equal(omittedInspection.nextAction, 'supply_claim_complete_scenario');
  assert.deepEqual(
    omittedInspection.checks.map((check: JsonRecord) => check.status),
    ['failed', 'not_evaluated', 'not_evaluated', 'not_evaluated', 'not_evaluated', 'not_evaluated'],
  );
});

test('accepts entry and claim-scoped dependencies in authored selected order', () => {
  const scenario = sampleScenario();
  scenario.dependencies = [
    entryDependency(),
    claimDependency(),
    claimDependency({
      id: 'reopen-ready',
      applicability: { platforms: ['ios'], variants: ['reopen'] },
      claimIds: ['journey-diagnostic'],
      predicate: predicate('reopen-ready-predicate', 'events.reopen_ready'),
    }),
  ];

  const ios = inspectScenarioClaimDependencies(scenario, { platform: 'ios' });
  const reopen = inspectScenarioClaimDependencies(scenario, {
    platform: 'ios',
    variant: 'reopen',
  });
  const android = inspectScenarioClaimDependencies(scenario, { platform: 'android' });

  assert.equal(ios.dependencyContract, 'complete');
  assert.deepEqual(ios.applicableDependencyIds, ['app-ready', 'conversation-loaded']);
  assert.deepEqual(reopen.applicableDependencyIds, [
    'app-ready',
    'conversation-loaded',
    'reopen-ready',
  ]);
  assert.deepEqual(android.applicableDependencyIds, ['app-ready']);
});

test('keeps the dependency discriminator and claimIds rules structural', () => {
  const entryWithClaims = sampleScenario();
  entryWithClaims.dependencies = [entryDependency({ claimIds: ['journey-completes'] })];
  const claimWithoutClaims = sampleScenario();
  const dependency = claimDependency();
  delete dependency.claimIds;
  claimWithoutClaims.dependencies = [dependency];
  const claimWithEmptyClaims = sampleScenario();
  claimWithEmptyClaims.dependencies = [claimDependency({ claimIds: [] })];
  const claimWithDuplicateClaims = sampleScenario();
  claimWithDuplicateClaims.dependencies = [claimDependency({
    claimIds: ['journey-completes', 'journey-completes'],
  })];

  for (const candidate of [
    entryWithClaims,
    claimWithoutClaims,
    claimWithEmptyClaims,
    claimWithDuplicateClaims,
  ]) {
    assert.equal(validateJson(candidate, SCHEMAS.scenario, 'dependency shape').valid, false);
    assert.equal(
      inspectScenarioClaimDependencies(candidate, { platform: 'ios' }).dependencyContract,
      'outside_contract',
    );
  }
});

test('routes isolated unknown claim references to contract repair', () => {
  const scenario = sampleScenario();
  scenario.dependencies = [claimDependency({ claimIds: ['missing-claim'] })];

  const result = inspectScenarioClaimDependencies(scenario, { platform: 'ios' });

  assert.equal(result.dependencyContract, 'incomplete');
  assert.deepEqual(reasonCodes(result), ['unknown_claim_reference']);
  assert.equal(result.nextAction, 'repair_dependency_claim_references');
});

test('keeps unknown scenario versions outside the dependency contract', () => {
  const scenario = sampleScenario();
  scenario.schemaVersion = '2.0.0';

  const result = inspectScenarioClaimDependencies(scenario, { platform: 'ios' });

  assert.equal(result.dependencyContract, 'outside_contract');
  assert.deepEqual(reasonCodes(result), ['unknown_scenario_schema']);
  assert.equal(result.nextAction, 'supply_claim_complete_scenario');
});

test('reports duplicate dependency IDs and unknown claim references deterministically', () => {
  const scenario = sampleScenario();
  scenario.dependencies = [
    entryDependency(),
    entryDependency({ predicate: predicate('other-ready', 'events.other_ready') }),
    claimDependency({ claimIds: ['missing-claim'] }),
  ];

  const result = inspectScenarioClaimDependencies(scenario, { platform: 'ios' });

  assert.equal(result.dependencyContract, 'incomplete');
  assert.deepEqual(reasonCodes(result), [
    'duplicate_dependency_id',
    'unknown_claim_reference',
  ]);
  assert.equal(result.nextAction, 'repair_dependency_identity');
  assert.deepEqual(result.checks.map((check: JsonRecord) => check.code), [
    'scenario_claim_complete_schema',
    'selection_platform_declared',
    'dependency_identity',
    'claim_reference_integrity',
    'dependency_applicability_integrity',
    'selected_dependency_inventory',
  ]);
});

test('rejects dependency applicability wider than scenario or every referenced claim', () => {
  const scenario = sampleScenario();
  scenario.platforms = ['ios'];
  scenario.claims[0].applicability.platforms = ['ios'];
  scenario.dependencies = [
    entryDependency({ applicability: { platforms: ['ios', 'android'] } }),
    claimDependency({ applicability: { platforms: ['ios', 'android'] } }),
    claimDependency({
      id: 'variant-wider',
      applicability: { platforms: ['ios'] },
      claimIds: ['journey-diagnostic'],
      predicate: predicate('variant-wider-predicate', 'events.variant_wider'),
    }),
    claimDependency({
      id: 'variant-outside',
      applicability: { platforms: ['ios'], variants: ['other'] },
      claimIds: ['journey-diagnostic'],
      predicate: predicate('variant-outside-predicate', 'events.variant_outside'),
    }),
  ];

  const result = inspectScenarioClaimDependencies(scenario, { platform: 'ios' });

  assert.equal(result.dependencyContract, 'incomplete');
  assert.deepEqual(reasonCodes(result), [
    'dependency_platform_outside_scenario',
    'dependency_platform_outside_scenario',
    'dependency_platform_outside_claim',
    'dependency_variant_outside_claim',
    'dependency_variant_outside_claim',
  ]);
  assert.equal(result.nextAction, 'narrow_dependency_applicability');
});

test('allows a dependency variant when every referenced claim applies to all variants', () => {
  const scenario = sampleScenario();
  scenario.dependencies = [
    claimDependency({ applicability: { platforms: ['ios'], variants: ['reopen'] } }),
  ];

  const result = inspectScenarioClaimDependencies(scenario, {
    platform: 'ios',
    variant: 'reopen',
  });

  assert.equal(result.dependencyContract, 'complete');
  assert.deepEqual(result.applicableDependencyIds, ['conversation-loaded']);
});

test('keeps malformed selections and non-selected scenario platforms outside the contract', () => {
  const scenario = sampleScenario();
  scenario.platforms = ['ios'];
  const malformed = inspectScenarioClaimDependencies(scenario, {
    platform: 'ios',
    extra: true,
  });
  const unselected = inspectScenarioClaimDependencies(scenario, { platform: 'android' });

  assert.equal(malformed.dependencyContract, 'outside_contract');
  assert.equal(Object.hasOwn(malformed, 'platform'), false);
  assert.deepEqual(reasonCodes(malformed), ['malformed_selection']);
  assert.equal(unselected.dependencyContract, 'outside_contract');
  assert.deepEqual(reasonCodes(unselected), ['undeclared_platform']);
});

test('dependency edits invalidate the full scenario hash and exact approval', () => {
  const scenario = sampleScenario();
  scenario.dependencies = [entryDependency(), claimDependency()];
  const originalHash = buildScenarioClaimCompleteContractHash(scenario);
  const approval = {
    schemaVersion: '1.0.0',
    approvalId: 'dependency-approval',
    scenarioId: scenario.id,
    scenarioHash: originalHash,
    selection: { platform: 'ios' },
    decision: 'approved',
    approvedAt: '2026-08-21T12:00:00Z',
    approverRef: 'local-review',
  };
  assert.equal(
    inspectScenarioClaimApproval(scenario, { platform: 'ios' }, approval).approvalBinding,
    'bound',
  );

  for (const mutate of [
    (candidate: JsonRecord) => { candidate.dependencies[0].id = 'other-ready'; },
    (candidate: JsonRecord) => { candidate.dependencies[0].applicability.platforms = ['ios']; },
    (candidate: JsonRecord) => { candidate.dependencies[0].predicate.event = 'other_event'; },
    (candidate: JsonRecord) => { candidate.dependencies[0].predicate.authority.requiredStrength = 'verified'; },
    (candidate: JsonRecord) => { candidate.dependencies[0] = claimDependency({ id: 'app-ready' }); },
    (candidate: JsonRecord) => {
      candidate.dependencies[1].claimIds = ['journey-diagnostic'];
      candidate.dependencies[1].applicability.variants = ['reopen'];
    },
    (candidate: JsonRecord) => { candidate.dependencies[0].predicate.id = 'other-predicate'; },
    (candidate: JsonRecord) => {
      candidate.dependencies.push(entryDependency({ id: 'another-entry' }));
    },
    (candidate: JsonRecord) => { candidate.dependencies = []; },
  ]) {
    const edited = clone(scenario);
    mutate(edited);
    assert.equal(validateJson(edited, SCHEMAS.scenario, 'edited dependency scenario').valid, true);
    assert.notEqual(buildScenarioClaimCompleteContractHash(edited), originalHash);
    assert.equal(
      inspectScenarioClaimApproval(edited, { platform: 'ios' }, approval).approvalBinding,
      'invalidated',
    );
  }
});
