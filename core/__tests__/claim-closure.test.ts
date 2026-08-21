const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLAIM_CLOSURE_INSPECTION_VERSION,
  inspectScenarioClaimClosure,
} = require('../claim-closure');

const ROOT = path.join(__dirname, '..', '..', '..');

type JsonRecord = Record<string, any>;

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
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
      { id: 'enter-journey', description: 'Enter the journey.', coverageKind: 'product' },
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
        phases: ['enter-journey', 'complete-intent'],
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

function reasonCodes(result: JsonRecord): string[] {
  return result.blockingReasons.map((reason: JsonRecord) => reason.code);
}

test('reports a complete applicable mandatory graph as closed', () => {
  const result = inspectScenarioClaimClosure(sampleScenario(), { platform: 'ios' });

  assert.equal(CLAIM_CLOSURE_INSPECTION_VERSION, '1.0.0');
  assert.equal(result.claimClosure, 'closed');
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.checks.length, 10);
  assert.equal(result.checks.every((check: JsonRecord) => check.outcome === 'satisfied'), true);
});

test('keeps legacy, unknown, malformed, and unselected platform input outside the contract', () => {
  const legacy = sampleScenario();
  legacy.schemaVersion = '1.0.0';
  const unknown = sampleScenario();
  unknown.schemaVersion = '2.0.0';
  const malformed = sampleScenario();
  delete malformed.claims;
  const iosOnly = sampleScenario();
  iosOnly.platforms = ['ios'];

  assert.deepEqual(reasonCodes(inspectScenarioClaimClosure(legacy, { platform: 'ios' })), [
    'scenario_schema_outside_contract',
  ]);
  assert.deepEqual(reasonCodes(inspectScenarioClaimClosure(unknown, { platform: 'ios' })), [
    'scenario_schema_outside_contract',
  ]);
  assert.deepEqual(reasonCodes(inspectScenarioClaimClosure(malformed, { platform: 'ios' })), [
    'scenario_schema_invalid',
  ]);
  assert.deepEqual(reasonCodes(inspectScenarioClaimClosure(iosOnly, { platform: 'android' })), [
    'selected_platform_outside_contract',
  ]);
});

test('reports duplicate and colliding journey identities deterministically', () => {
  const scenario = sampleScenario();
  scenario.journey.phases.push({
    id: 'enter-journey',
    description: 'Duplicate phase.',
    coverageKind: 'product',
  });
  scenario.journey.terminalInvariants.push({
    id: 'terminal-state-stable',
    description: 'Duplicate invariant.',
    coverageKind: 'product',
  });
  scenario.journey.terminalInvariants.push({
    id: 'complete-intent',
    description: 'Colliding invariant.',
    coverageKind: 'product',
  });
  scenario.journey.recovery = {
    status: 'required',
    rationale: 'The journey includes recovery.',
    variants: [
      { id: 'reverse', description: 'Reverse interruption.', coverageKind: 'recovery' },
      { id: 'reverse', description: 'Duplicate reversal.', coverageKind: 'recovery' },
      {
        id: 'enter-journey',
        description: 'Colliding recovery variant.',
        coverageKind: 'recovery',
      },
    ],
  };

  const result = inspectScenarioClaimClosure(scenario, { platform: 'ios' });

  assert.equal(result.claimClosure, 'not_closed');
  assert.deepEqual(reasonCodes(result).slice(0, 5), [
    'duplicate_phase_id',
    'duplicate_terminal_invariant_id',
    'journey_node_id_collision',
    'duplicate_recovery_variant_id',
    'journey_recovery_variant_id_collision',
  ]);
});

test('reports duplicate claim and per-claim assertion identities', () => {
  const scenario = sampleScenario();
  scenario.claims[0].assertions.push({ ...scenario.claims[0].assertions[0] });
  scenario.claims.push({ ...scenario.claims[0], assertions: [scenario.claims[0].assertions[0]] });

  const result = inspectScenarioClaimClosure(scenario, { platform: 'ios' });

  assert.equal(result.claimClosure, 'not_closed');
  assert.equal(reasonCodes(result).includes('duplicate_claim_id'), true);
  assert.equal(reasonCodes(result).includes('duplicate_assertion_id'), true);
});

test('reports unresolved phase and terminal-invariant references', () => {
  const scenario = sampleScenario();
  scenario.claims[0].closes = {
    phases: ['missing-phase'],
    terminalInvariants: ['missing-invariant'],
  };

  const result = inspectScenarioClaimClosure(scenario, { platform: 'ios' });

  assert.equal(result.claimClosure, 'not_closed');
  assert.deepEqual(reasonCodes(result).slice(0, 3), [
    'unknown_phase_reference',
    'unknown_terminal_invariant_reference',
    'applicable_claim_has_no_resolved_closure',
  ]);
});

test('requires every authored phase and terminal invariant to be closed by a mandatory claim', () => {
  const missingPhase = sampleScenario();
  missingPhase.claims[0].closes.phases = ['enter-journey'];
  const missingInvariant = sampleScenario();
  delete missingInvariant.claims[0].closes.terminalInvariants;
  const supplementalOnly = sampleScenario();
  supplementalOnly.claims[0].closes = { phases: ['enter-journey'] };
  supplementalOnly.claims.push({
    ...supplementalOnly.claims[0],
    id: 'supplemental-observation',
    role: 'supplemental',
    closes: {
      phases: ['complete-intent'],
      terminalInvariants: ['terminal-state-stable'],
    },
    assertions: [{ ...supplementalOnly.claims[0].assertions[0], id: 'supplemental-event' }],
  });

  assert.equal(
    reasonCodes(inspectScenarioClaimClosure(missingPhase, { platform: 'ios' })).includes(
      'mandatory_phase_not_closed',
    ),
    true,
  );
  assert.equal(
    reasonCodes(inspectScenarioClaimClosure(missingInvariant, { platform: 'ios' })).includes(
      'terminal_invariant_not_closed',
    ),
    true,
  );
  assert.deepEqual(
    reasonCodes(inspectScenarioClaimClosure(supplementalOnly, { platform: 'ios' })).filter((code) =>
      code.startsWith('mandatory_') || code.startsWith('terminal_'),
    ),
    ['mandatory_phase_not_closed', 'terminal_invariant_not_closed'],
  );
});

test('does not combine platform-scoped claims', () => {
  const scenario = sampleScenario();
  scenario.claims[0].applicability.platforms = ['android'];

  const iosResult = inspectScenarioClaimClosure(scenario, { platform: 'ios' });
  const androidResult = inspectScenarioClaimClosure(scenario, { platform: 'android' });

  assert.equal(iosResult.claimClosure, 'not_closed');
  assert.equal(androidResult.claimClosure, 'closed');
});

test('does not combine variant-scoped claims or apply them without an exact variant selection', () => {
  const scenario = sampleScenario();
  scenario.claims[0].applicability.variants = ['reopen'];

  assert.equal(inspectScenarioClaimClosure(scenario, { platform: 'ios' }).claimClosure, 'not_closed');
  assert.equal(
    inspectScenarioClaimClosure(scenario, { platform: 'ios', variant: 'interrupt' }).claimClosure,
    'not_closed',
  );
  assert.equal(
    inspectScenarioClaimClosure(scenario, { platform: 'ios', variant: 'reopen' }).claimClosure,
    'closed',
  );
});

test('requires explicit recovery variants and recovery-owned journey nodes', () => {
  const noVariant = sampleScenario();
  noVariant.journey.recovery = {
    status: 'required',
    rationale: 'The journey includes recovery.',
  };
  const noOwnedNode = sampleScenario();
  noOwnedNode.journey.recovery = {
    status: 'required',
    rationale: 'The journey includes recovery.',
    variants: [{ id: 'reverse', description: 'Reverse interruption.', coverageKind: 'recovery' }],
  };
  const wrongVariantKind = sampleScenario();
  wrongVariantKind.journey.recovery = {
    status: 'required',
    rationale: 'The journey includes recovery.',
    variants: [{ id: 'reverse', description: 'Reverse interruption.', coverageKind: 'product' }],
  };

  assert.equal(
    reasonCodes(inspectScenarioClaimClosure(noVariant, { platform: 'ios' })).includes(
      'required_recovery_has_no_variant',
    ),
    true,
  );
  assert.equal(
    reasonCodes(inspectScenarioClaimClosure(noOwnedNode, { platform: 'ios' })).includes(
      'required_recovery_has_no_owned_node',
    ),
    true,
  );
  assert.equal(
    reasonCodes(inspectScenarioClaimClosure(wrongVariantKind, { platform: 'ios' })).includes(
      'recovery_variant_kind_mismatch',
    ),
    true,
  );
});

test('rejects recovery variants and recovery-owned nodes when recovery is not required', () => {
  const scenario = sampleScenario();
  scenario.journey.phases.push({
    id: 'recover-journey',
    description: 'Recover the journey.',
    coverageKind: 'recovery',
  });
  scenario.journey.recovery.variants = [
    { id: 'reverse', description: 'Reverse interruption.', coverageKind: 'recovery' },
  ];
  scenario.claims[0].closes.phases.push('recover-journey');

  const result = inspectScenarioClaimClosure(scenario, { platform: 'ios' });

  assert.equal(result.claimClosure, 'not_closed');
  assert.equal(reasonCodes(result).includes('not_required_recovery_has_variant'), true);
  assert.equal(reasonCodes(result).includes('not_required_recovery_has_owned_node'), true);
});

test('closes a required recovery contract only through mandatory recovery-owned truth', () => {
  const scenario = sampleScenario();
  scenario.journey.phases.push({
    id: 'recover-journey',
    description: 'Recover the journey after interruption.',
    coverageKind: 'recovery',
  });
  scenario.journey.terminalInvariants.push({
    id: 'recovery-state-stable',
    description: 'The recovered terminal state remains stable.',
    coverageKind: 'recovery',
  });
  scenario.journey.recovery = {
    status: 'required',
    rationale: 'The user can interrupt and resume this journey.',
    variants: [{ id: 'reverse', description: 'Reverse interruption.', coverageKind: 'recovery' }],
  };
  scenario.claims.push({
    ...scenario.claims[0],
    id: 'journey-recovers',
    applicability: { platforms: ['ios', 'android'] },
    closes: {
      phases: ['recover-journey'],
      terminalInvariants: ['recovery-state-stable'],
    },
    assertions: [{ ...scenario.claims[0].assertions[0], id: 'journey-recovered-event' }],
  });

  assert.equal(inspectScenarioClaimClosure(scenario, { platform: 'ios' }).claimClosure, 'closed');
});
