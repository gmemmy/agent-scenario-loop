const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLAIM_SAFETY_INSPECTION_VERSION,
  inspectScenarioClaimSafety,
} = require('../claim-safety');
const { SCHEMAS, validateJson } = require('../schema-validator');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function sampleScenario(): JsonRecord {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.schemaVersion = '1.1.0';
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
  scenario.safety = {
    class: 'read_only',
    rationale: 'The scenario observes product behavior without mutation.',
    allowedOperations: ['observe'],
  };
  return scenario;
}

function mutatingSafety(safetyClass: string): JsonRecord {
  const required = {
    status: 'required',
    rationale: 'The action is required to restore trustworthy state.',
    assertionIds: ['journey-completed-event'],
  };
  return {
    class: safetyClass,
    rationale: 'The scenario performs one declared bounded mutation.',
    allowedOperations: ['create-test-record'],
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

function reasonCodes(result: JsonRecord): string[] {
  return result.blockingReasons.map((reason: JsonRecord) => reason.code);
}

test('accepts a schema-valid read-only safety declaration as statically complete', () => {
  const scenario = sampleScenario();
  const result = inspectScenarioClaimSafety(scenario, { platform: 'ios' });

  assert.equal(CLAIM_SAFETY_INSPECTION_VERSION, '1.0.0');
  assert.equal(validateJson(scenario, SCHEMAS.scenario, 'scenario').valid, true);
  assert.equal(result.safetyClass, 'read_only');
  assert.equal(result.safetyContract, 'complete');
  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.blockingReasons, []);
});

test('accepts each schema-valid mutating class when mandatory claims bind its safeguards', () => {
  for (const safetyClass of [
    'local_mutation',
    'reversible_backend_mutation',
    'destructive',
  ]) {
    const scenario = sampleScenario();
    scenario.safety = mutatingSafety(safetyClass);

    const result = inspectScenarioClaimSafety(scenario, { platform: 'ios' });

    assert.equal(validateJson(scenario, SCHEMAS.scenario, safetyClass).valid, true);
    assert.equal(result.safetyContract, 'complete');
    assert.equal(result.checks.length, 4);
    assert.equal(result.checks.every((check: JsonRecord) => check.outcome === 'satisfied'), true);
  }
});

test('keeps legacy, malformed, and unselected platform input outside the contract', () => {
  const legacy = readJson('examples/scenarios/mobile/app-startup.json');
  const legacyWithSafety = clone(legacy);
  legacyWithSafety.safety = sampleScenario().safety;
  const missingSafety = sampleScenario();
  delete missingSafety.safety;
  const iosOnly = sampleScenario();
  iosOnly.platforms = ['ios'];

  assert.equal(validateJson(legacy, SCHEMAS.scenario, 'legacy').valid, true);
  assert.equal(validateJson(legacyWithSafety, SCHEMAS.scenario, 'legacy').valid, false);
  assert.deepEqual(reasonCodes(inspectScenarioClaimSafety(legacy, { platform: 'ios' })), [
    'scenario_schema_outside_contract',
  ]);
  assert.deepEqual(reasonCodes(inspectScenarioClaimSafety(missingSafety, { platform: 'ios' })), [
    'scenario_schema_invalid',
  ]);
  assert.deepEqual(reasonCodes(inspectScenarioClaimSafety(iosOnly, { platform: 'android' })), [
    'selected_platform_outside_contract',
  ]);
});

test('enforces class-specific rollback and cleanup policy in the scenario schema', () => {
  const local = sampleScenario();
  local.safety = mutatingSafety('local_mutation');
  local.safety.rollback = { status: 'not_required', rationale: 'No rollback.' };
  local.safety.cleanup = { status: 'not_required', rationale: 'No cleanup.' };
  const reversible = sampleScenario();
  reversible.safety = mutatingSafety('reversible_backend_mutation');
  reversible.safety.rollback = { status: 'not_required', rationale: 'No rollback.' };
  const destructive = sampleScenario();
  destructive.safety = mutatingSafety('destructive');
  destructive.safety.cleanup = { status: 'not_required', rationale: 'No cleanup.' };

  assert.equal(validateJson(local, SCHEMAS.scenario, 'local').valid, false);
  assert.equal(validateJson(reversible, SCHEMAS.scenario, 'reversible').valid, false);
  assert.equal(validateJson(destructive, SCHEMAS.scenario, 'destructive').valid, false);
});

test('accepts class-specific optional safeguards without claiming their authority', () => {
  const localRollback = sampleScenario();
  localRollback.safety = mutatingSafety('local_mutation');
  localRollback.safety.cleanup = { status: 'not_required', rationale: 'No cleanup is needed.' };
  const localCleanup = sampleScenario();
  localCleanup.safety = mutatingSafety('local_mutation');
  localCleanup.safety.rollback = { status: 'not_required', rationale: 'No rollback is needed.' };
  const reversible = sampleScenario();
  reversible.safety = mutatingSafety('reversible_backend_mutation');
  reversible.safety.cleanup = { status: 'not_required', rationale: 'No cleanup is needed.' };
  const destructive = sampleScenario();
  destructive.safety = mutatingSafety('destructive');
  destructive.safety.rollback = { status: 'not_required', rationale: 'No rollback is possible.' };

  for (const scenario of [localRollback, localCleanup, reversible, destructive]) {
    const result = inspectScenarioClaimSafety(scenario, { platform: 'ios' });
    assert.equal(validateJson(scenario, SCHEMAS.scenario, 'optional safeguard').valid, true);
    assert.equal(result.safetyContract, 'complete');
    assert.equal(result.checks.some((check: JsonRecord) => check.outcome === 'not_required'), true);
  }
});

test('rejects mutation fields and runtime authorization fields from read-only safety', () => {
  const mutation = sampleScenario();
  mutation.safety.mutationIdentity = {
    id: 'unexpected-mutation',
    assertionIds: ['journey-completed-event'],
  };
  const authorization = sampleScenario();
  authorization.safety.authorization = { status: 'not_required' };
  const mutatingAuthorization = sampleScenario();
  mutatingAuthorization.safety = mutatingSafety('destructive');
  mutatingAuthorization.safety.authorization = { status: 'approved' };

  assert.equal(validateJson(mutation, SCHEMAS.scenario, 'mutation').valid, false);
  assert.equal(validateJson(authorization, SCHEMAS.scenario, 'authorization').valid, false);
  assert.equal(
    inspectScenarioClaimSafety(authorization, { platform: 'ios' }).safetyContract,
    'outside_contract',
  );
  assert.equal(
    inspectScenarioClaimSafety(mutatingAuthorization, { platform: 'ios' }).safetyContract,
    'outside_contract',
  );
});

test('reports unknown assertion and terminal-invariant references deterministically', () => {
  const scenario = sampleScenario();
  scenario.safety = mutatingSafety('reversible_backend_mutation');
  scenario.safety.mutationIdentity.assertionIds = ['missing-mutation'];
  scenario.safety.rollback.assertionIds = ['missing-rollback'];
  scenario.safety.cleanup.assertionIds = ['missing-cleanup'];
  scenario.safety.reconciliation.assertionIds = ['missing-reconciliation'];
  scenario.safety.reconciliation.terminalInvariantIds = ['missing-terminal'];

  const result = inspectScenarioClaimSafety(scenario, { platform: 'ios' });

  assert.equal(result.safetyContract, 'incomplete');
  assert.deepEqual(reasonCodes(result), [
    'unknown_mutation_identity_assertion',
    'unknown_rollback_assertion',
    'unknown_cleanup_assertion',
    'unknown_reconciliation_assertion',
    'unknown_reconciliation_terminal_invariant',
  ]);
});

test('requires safety assertions to belong to an applicable mandatory claim', () => {
  const scenario = sampleScenario();
  scenario.claims[0].role = 'supplemental';
  scenario.claims.push({
    ...clone(scenario.claims[0]),
    id: 'mandatory-observation',
    role: 'mandatory',
    assertions: [
      {
        ...clone(scenario.claims[0].assertions[0]),
        id: 'mandatory-observation-event',
      },
    ],
  });
  scenario.safety = mutatingSafety('reversible_backend_mutation');

  const result = inspectScenarioClaimSafety(scenario, { platform: 'ios' });

  assert.equal(result.safetyContract, 'incomplete');
  assert.deepEqual(
    [...new Set(reasonCodes(result))],
    ['safety_assertion_not_mandatory'],
  );
});

test('rejects safety assertion identities with more than one applicable claim owner', () => {
  const scenario = sampleScenario();
  scenario.claims.push({
    ...clone(scenario.claims[0]),
    id: 'duplicate-owner',
  });
  scenario.safety = mutatingSafety('destructive');

  const result = inspectScenarioClaimSafety(scenario, { platform: 'ios' });

  assert.equal(result.safetyContract, 'incomplete');
  assert.deepEqual([...new Set(reasonCodes(result))], ['ambiguous_safety_assertion']);
});

test('keeps platform and variant assertion authority exact', () => {
  const platform = sampleScenario();
  platform.claims[0].applicability.platforms = ['android'];
  platform.safety = mutatingSafety('destructive');
  const variant = sampleScenario();
  variant.claims[0].applicability.variants = ['reopen'];
  variant.safety = mutatingSafety('destructive');

  assert.equal(
    reasonCodes(inspectScenarioClaimSafety(platform, { platform: 'ios' })).includes(
      'unknown_mutation_identity_assertion',
    ),
    true,
  );
  assert.equal(
    inspectScenarioClaimSafety(variant, { platform: 'ios', variant: 'reopen' }).safetyContract,
    'complete',
  );
  assert.equal(
    inspectScenarioClaimSafety(variant, { platform: 'ios', variant: 'interrupt' }).safetyContract,
    'incomplete',
  );
  assert.equal(
    inspectScenarioClaimSafety(variant, { platform: 'ios' }).safetyContract,
    'incomplete',
  );
});
