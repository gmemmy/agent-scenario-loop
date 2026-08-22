const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  AUTHORITY_CAPABILITIES_SCHEMA_VERSION,
  CLAIM_AUTHORITY_INSPECTION_VERSION,
  inspectScenarioClaimAuthority,
} = require('../claim-authority');
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
      { id: 'enter-journey', description: 'Enter the journey.', coverageKind: 'product' },
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
        phases: ['enter-journey'],
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
  return scenario;
}

function sampleDeclaration(): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    declarationId: 'app-profile-authority',
    role: 'app',
    producerId: 'app-profile-session',
    platforms: ['ios', 'android'],
    assertionKinds: ['eventOccurrence'],
    evidenceSelectors: ['profileEvents.journey_completed'],
    maxStrength: 'verified',
    maxCompleteness: 'continuous-complete',
  };
}

function reasonCodes(result: JsonRecord): string[] {
  return result.blockingReasons.map((reason: JsonRecord) => reason.code);
}

test('validates and ships the authority capabilities template', () => {
  const template = readJson('templates/authority-capabilities.json');
  const result = validateJson(
    template,
    SCHEMAS.authorityCapabilities,
    'templates/authority-capabilities.json',
  );

  assert.equal(AUTHORITY_CAPABILITIES_SCHEMA_VERSION, '1.0.0');
  assert.equal(result.valid, true, result.message);
});

test('matches every applicable mandatory and supplemental assertion exactly', () => {
  const scenario = sampleScenario();
  scenario.claims.push({
    id: 'journey-diagnostic',
    role: 'supplemental',
    applicability: { platforms: ['ios'] },
    closes: { phases: ['enter-journey'] },
    assertions: [
      {
        id: 'journey-order',
        kind: 'eventOrder',
        beforeEvent: 'journey_started',
        afterEvent: 'journey_completed',
        authority: {
          role: 'app',
          producerId: 'app-profile-session',
          evidenceSelector: 'profileEvents.journey_order',
          requiredStrength: 'verified',
          completeness: 'bounded',
        },
      },
    ],
  });
  const declaration = sampleDeclaration();
  declaration.assertionKinds.push('eventOrder');
  declaration.evidenceSelectors.push('profileEvents.journey_order');

  const result = inspectScenarioClaimAuthority(scenario, { platform: 'ios' }, [declaration]);

  assert.equal(CLAIM_AUTHORITY_INSPECTION_VERSION, '1.0.0');
  assert.equal(result.authorityCompatibility, 'compatible');
  assert.equal(result.nextAction, 'authority_inspection_complete');
  assert.deepEqual(result.blockingReasons, []);
  assert.deepEqual(
    result.checks.map((check: JsonRecord) => [check.claimId, check.assertionId, check.outcome]),
    [
      ['journey-completes', 'journey-completed-event', 'matched'],
      ['journey-diagnostic', 'journey-order', 'matched'],
    ],
  );
});

test('matches validated evidence only with its artifact kind and validation contract', () => {
  const scenario = sampleScenario();
  scenario.claims[0].assertions = [
    {
      id: 'validated-tree',
      kind: 'validatedEvidence',
      artifactKind: 'uiTree',
      validationContract: 'ui-tree-contract-v1',
      authority: {
        role: 'comparator',
        producerId: 'ui-tree-comparator',
        evidenceSelector: 'captures.uiTree',
        requiredStrength: 'verified',
        completeness: 'bounded',
      },
    },
  ];
  const declaration = {
    ...sampleDeclaration(),
    declarationId: 'ui-tree-comparator-authority',
    role: 'comparator',
    producerId: 'ui-tree-comparator',
    assertionKinds: ['validatedEvidence'],
    evidenceSelectors: ['captures.uiTree'],
    artifactKinds: ['uiTree'],
    validationContracts: ['ui-tree-contract-v1'],
  };

  const result = inspectScenarioClaimAuthority(scenario, { platform: 'ios' }, [declaration]);

  assert.equal(result.authorityCompatibility, 'compatible');
  assert.equal(result.checks[0].declarationId, 'ui-tree-comparator-authority');
});

test('keeps legacy, malformed, and unselected platform scenarios outside the contract', () => {
  const legacy = sampleScenario();
  legacy.schemaVersion = '1.0.0';
  const malformed = sampleScenario();
  delete malformed.claims;
  const iosOnly = sampleScenario();
  iosOnly.platforms = ['ios'];

  assert.deepEqual(
    reasonCodes(inspectScenarioClaimAuthority(legacy, { platform: 'ios' }, [])),
    ['scenario_schema_outside_contract'],
  );
  assert.deepEqual(
    reasonCodes(inspectScenarioClaimAuthority(malformed, { platform: 'ios' }, [])),
    ['scenario_schema_invalid'],
  );
  assert.deepEqual(
    reasonCodes(inspectScenarioClaimAuthority(iosOnly, { platform: 'android' }, [])),
    ['selected_platform_outside_contract'],
  );
});

test('fails invalid authority catalogs outside the contract before grading assertions', () => {
  const invalid = sampleDeclaration();
  invalid.unknown = true;
  const runnerManifest = readJson('templates/primary-runner.json');

  const invalidResult = inspectScenarioClaimAuthority(
    sampleScenario(),
    { platform: 'ios' },
    [invalid],
  );
  const runnerResult = inspectScenarioClaimAuthority(
    sampleScenario(),
    { platform: 'ios' },
    [runnerManifest],
  );

  assert.equal(invalidResult.authorityCompatibility, 'outside_contract');
  assert.equal(invalidResult.nextAction, 'repair_authority_catalog');
  assert.deepEqual(reasonCodes(invalidResult), ['authority_declaration_invalid']);
  assert.deepEqual(invalidResult.checks, []);
  assert.deepEqual(reasonCodes(runnerResult), ['authority_declaration_invalid']);
});

test('requires validated evidence declarations to name artifact and validation contracts', () => {
  const declaration = sampleDeclaration();
  declaration.assertionKinds = ['validatedEvidence'];

  const result = validateJson(
    declaration,
    SCHEMAS.authorityCapabilities,
    'Authority capabilities',
  );

  assert.equal(result.valid, false);
  assert.match(result.message, /artifactKinds/u);
  assert.match(result.message, /validationContracts/u);
});

test('reports missing named and platform authority paths without retroactive non-applicability', () => {
  const missing = inspectScenarioClaimAuthority(sampleScenario(), { platform: 'ios' }, []);
  const androidOnly = sampleDeclaration();
  androidOnly.platforms = ['android'];
  const unsupportedPlatform = inspectScenarioClaimAuthority(
    sampleScenario(),
    { platform: 'ios' },
    [androidOnly],
  );

  assert.equal(missing.authorityCompatibility, 'incompatible');
  assert.deepEqual(reasonCodes(missing), ['authority_path_missing']);
  assert.deepEqual(reasonCodes(unsupportedPlatform), ['authority_platform_unsupported']);
  assert.equal(unsupportedPlatform.nextAction, 'declare_compatible_authority_paths');
});

test('reports every deterministic declaration mismatch for an assertion', () => {
  const scenario = sampleScenario();
  scenario.claims[0].assertions[0].authority.requiredStrength = 'verified';
  scenario.claims[0].assertions[0].authority.completeness = 'continuous-complete';
  const declaration = sampleDeclaration();
  declaration.assertionKinds = ['terminalState'];
  declaration.evidenceSelectors = ['profileEvents.other'];
  declaration.maxStrength = 'observed';
  declaration.maxCompleteness = 'point';

  const result = inspectScenarioClaimAuthority(scenario, { platform: 'ios' }, [declaration]);

  assert.deepEqual(reasonCodes(result), [
    'assertion_kind_unsupported',
    'evidence_selector_unsupported',
    'identity_strength_insufficient',
    'evidence_completeness_insufficient',
  ]);
  assert.deepEqual(result.checks[0].reasonCodes, reasonCodes(result));
});

test('reports validated evidence artifact and validation contract mismatches independently', () => {
  const scenario = sampleScenario();
  scenario.claims[0].assertions = [
    {
      id: 'validated-tree',
      kind: 'validatedEvidence',
      artifactKind: 'uiTree',
      validationContract: 'ui-tree-contract-v1',
      authority: {
        role: 'comparator',
        producerId: 'ui-tree-comparator',
        evidenceSelector: 'captures.uiTree',
        requiredStrength: 'observed',
        completeness: 'point',
      },
    },
  ];
  const declaration = {
    ...sampleDeclaration(),
    declarationId: 'ui-tree-comparator-authority',
    role: 'comparator',
    producerId: 'ui-tree-comparator',
    assertionKinds: ['validatedEvidence'],
    evidenceSelectors: ['captures.uiTree'],
    artifactKinds: ['screenshot'],
    validationContracts: ['other-contract'],
  };

  const result = inspectScenarioClaimAuthority(scenario, { platform: 'ios' }, [declaration]);

  assert.deepEqual(reasonCodes(result), [
    'artifact_kind_unsupported',
    'validation_contract_unsupported',
  ]);
});

test('keeps supplemental assertion authority failures blocking', () => {
  const scenario = sampleScenario();
  scenario.claims.push({
    id: 'supplemental-network',
    role: 'supplemental',
    applicability: { platforms: ['ios'] },
    closes: { phases: ['enter-journey'] },
    assertions: [
      {
        id: 'network-evidence',
        kind: 'validatedEvidence',
        artifactKind: 'network',
        validationContract: 'har-v1',
        authority: {
          role: 'provider',
          producerId: 'network-provider',
          evidenceSelector: 'captures.network',
          requiredStrength: 'verified',
          completeness: 'bounded',
        },
      },
    ],
  });

  const result = inspectScenarioClaimAuthority(
    scenario,
    { platform: 'ios' },
    [sampleDeclaration()],
  );

  assert.equal(result.authorityCompatibility, 'incompatible');
  assert.equal(result.checks[0].outcome, 'matched');
  assert.equal(result.checks[1].claimRole, 'supplemental');
  assert.deepEqual(result.checks[1].reasonCodes, ['authority_path_missing']);
});

test('allows disjoint platform declarations and rejects overlaps before assertion grading', () => {
  const ios = sampleDeclaration();
  ios.platforms = ['ios'];
  const android = clone(ios);
  android.declarationId = 'app-profile-authority-android';
  android.platforms = ['android'];
  const overlap = clone(ios);
  overlap.declarationId = 'app-profile-authority-overlap';

  const disjointResult = inspectScenarioClaimAuthority(
    sampleScenario(),
    { platform: 'ios' },
    [ios, android],
  );
  const overlapResult = inspectScenarioClaimAuthority(
    sampleScenario(),
    { platform: 'ios' },
    [ios, overlap],
  );

  assert.equal(disjointResult.authorityCompatibility, 'compatible');
  assert.equal(overlapResult.authorityCompatibility, 'incompatible');
  assert.equal(overlapResult.nextAction, 'repair_authority_catalog');
  assert.deepEqual(reasonCodes(overlapResult), ['duplicate_authority_declaration']);
  assert.deepEqual(overlapResult.checks, []);
});

test('uses exact variant selection without mixing claims and allows a vacuous authority set', () => {
  const scenario = sampleScenario();
  scenario.claims[0].applicability.variants = ['compact'];

  const compact = inspectScenarioClaimAuthority(
    scenario,
    { platform: 'ios', variant: 'compact' },
    [sampleDeclaration()],
  );
  const expanded = inspectScenarioClaimAuthority(
    scenario,
    { platform: 'ios', variant: 'expanded' },
    [],
  );

  assert.equal(compact.authorityCompatibility, 'compatible');
  assert.equal(compact.checks.length, 1);
  assert.equal(expanded.authorityCompatibility, 'compatible');
  assert.deepEqual(expanded.checks, []);
  assert.deepEqual(expanded.blockingReasons, []);
});
