const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION,
  ScenarioClaimCompleteContractError,
  buildScenarioClaimCompleteContractHash,
  inspectScenarioClaimApproval,
} = require('../scenario-claim-approval');
const { assertScenarioExecutionContractSupported } = require('../claim-contract');
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
    {
      id: 'android-diagnostic',
      role: 'supplemental',
      applicability: { platforms: ['android'] },
      closes: { phases: ['complete-intent'] },
      assertions: [
        {
          id: 'android-log-evidence',
          kind: 'validatedEvidence',
          artifactKind: 'logs',
          validationContract: 'logs-v1',
          authority: {
            role: 'runner',
            producerId: 'android-runner',
            evidenceSelector: 'artifacts.logs',
            requiredStrength: 'verified',
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
  scenario.dependencies = [];
  return scenario;
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvalFor(
  scenario: JsonRecord,
  selection: { platform: 'ios' | 'android'; variant?: string } = { platform: 'ios' },
): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    approvalId: 'approval-one',
    scenarioId: scenario.id,
    scenarioHash: buildScenarioClaimCompleteContractHash(scenario),
    selection,
    decision: 'approved',
    approvedAt: '2026-08-21T12:00:00Z',
    approverRef: 'local-human-review',
  };
}

function reasonCodes(result: JsonRecord): string[] {
  return result.blockingReasons.map((reason: JsonRecord) => reason.code);
}

function check(result: JsonRecord, code: string): JsonRecord {
  return result.checks.find((candidate: JsonRecord) => candidate.code === code);
}

function assertAttestationOnly(result: JsonRecord): void {
  assert.equal(result.trust, 'exact_hash_attestation_only');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'verdict'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'authorized'), false);
}

test('hashes the complete schema-valid 1.1 scenario with profile-compatible canonical JSON', () => {
  const scenario = sampleScenario();
  const expected = crypto.createHash('sha256').update(stableJsonStringify(scenario)).digest('hex');

  assert.equal(fs.existsSync(path.join(ROOT, 'examples/scenarios/mobile/app-startup.json')), true);
  assert.equal(validateJson(scenario, SCHEMAS.scenario, 'scenario').valid, true);
  assert.equal(buildScenarioClaimCompleteContractHash(scenario), expected);
  assert.match(expected, /^[a-f0-9]{64}$/u);
});

test('keeps object-key order irrelevant and authored array order significant', () => {
  const scenario = sampleScenario();
  const reordered = Object.fromEntries(Object.entries(scenario).reverse());
  const nestedReordered = clone(scenario);
  nestedReordered.claims[0] = Object.fromEntries(Object.entries(nestedReordered.claims[0]).reverse());
  const claimsReordered = clone(scenario);
  claimsReordered.claims.reverse();

  assert.equal(buildScenarioClaimCompleteContractHash(reordered), buildScenarioClaimCompleteContractHash(scenario));
  assert.equal(buildScenarioClaimCompleteContractHash(nestedReordered), buildScenarioClaimCompleteContractHash(scenario));
  assert.notEqual(buildScenarioClaimCompleteContractHash(claimsReordered), buildScenarioClaimCompleteContractHash(scenario));
});

test('invalidates the full-object hash for descriptive, operational, safety, and claim edits', () => {
  const scenario = sampleScenario();
  const baseline = buildScenarioClaimCompleteContractHash(scenario);
  const edits: Array<(candidate: JsonRecord) => void> = [
    (candidate) => { candidate.description = `${candidate.description ?? ''} changed`; },
    (candidate) => { candidate.steps[0].id = `${candidate.steps[0].id}-changed`; },
    (candidate) => { candidate.safety.rationale = 'Changed safety rationale.'; },
    (candidate) => { candidate.journey.intent = 'Changed product intent.'; },
    (candidate) => { candidate.claims[0].assertions[0].event = 'different_event'; },
    (candidate) => { candidate.claims[1].assertions[0].validationContract = 'logs-v2'; },
    (candidate) => { candidate.requiredCapabilities.reverse(); },
    (candidate) => { candidate.artifacts.required.reverse(); },
  ];

  for (const edit of edits) {
    const candidate = clone(scenario);
    edit(candidate);
    assert.notEqual(buildScenarioClaimCompleteContractHash(candidate), baseline);
  }
});

test('rejects legacy, future, malformed, non-plain, cyclic, and non-finite hash inputs', () => {
  const legacy = sampleScenario();
  legacy.schemaVersion = '1.0.0';
  delete legacy.claims;
  delete legacy.safety;
  const future = sampleScenario();
  future.schemaVersion = '2.0.0';
  const malformed = sampleScenario();
  delete malformed.safety;
  const cyclic = sampleScenario();
  cyclic.self = cyclic;
  const nonFinite = sampleScenario();
  nonFinite.adapterOptions = { timeout: Number.POSITIVE_INFINITY };

  for (const candidate of [legacy, future, malformed, new Date(), cyclic, nonFinite]) {
    assert.throws(
      () => buildScenarioClaimCompleteContractHash(candidate),
      ScenarioClaimCompleteContractError,
    );
  }
});

test('binds an exact caller approval without promoting it beyond attestation', () => {
  const scenario = sampleScenario();
  const result = inspectScenarioClaimApproval(scenario, { platform: 'ios' }, approvalFor(scenario));

  assert.equal(SCENARIO_CLAIM_APPROVAL_INSPECTION_VERSION, '1.0.0');
  assert.equal(result.approvalBinding, 'bound');
  assert.equal(result.trust, 'exact_hash_attestation_only');
  assert.equal(result.approvalId, 'approval-one');
  assert.equal(result.computedScenarioHash, buildScenarioClaimCompleteContractHash(scenario));
  assert.deepEqual(result.blockingReasons, []);
  assert.equal(result.nextAction, 'approval_binding_complete');
  assert.equal(result.checks.every((entry: JsonRecord) => entry.status === 'satisfied'), true);
  assertAttestationOnly(result);
  assert.throws(() => assertScenarioExecutionContractSupported(scenario), /reader-only/u);
});

test('classifies legacy, future, and malformed scenarios outside contract', () => {
  const scenario = sampleScenario();
  const approval = approvalFor(scenario);
  const cases: Array<[JsonRecord, string]> = [];
  const legacy = clone(scenario);
  legacy.schemaVersion = '1.0.0';
  delete legacy.claims;
  delete legacy.safety;
  cases.push([legacy, 'legacy_scenario_schema']);
  const future = clone(scenario);
  future.schemaVersion = '2.0.0';
  cases.push([future, 'unknown_scenario_schema']);
  const malformed = clone(scenario);
  delete malformed.safety;
  cases.push([malformed, 'malformed_scenario']);

  for (const [candidate, reason] of cases) {
    const result = inspectScenarioClaimApproval(candidate, { platform: 'ios' }, approval);
    assert.equal(result.approvalBinding, 'outside_contract');
    assert.equal(reasonCodes(result).includes(reason), true);
    assert.equal(check(result, 'scenario_claim_complete_schema').status, 'failed');
    assert.equal(check(result, 'scenario_identity').status, 'not_evaluated');
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'computedScenarioHash'), false);
    assertAttestationOnly(result);
  }
});

test('maps cyclic, non-plain, non-finite, null, and array scenarios outside contract without throwing', () => {
  const scenario = sampleScenario();
  const approval = approvalFor(scenario);
  const cyclic = sampleScenario();
  cyclic.self = cyclic;
  const nonFinite = sampleScenario();
  nonFinite.adapterOptions = { timeout: Number.POSITIVE_INFINITY };

  for (const candidate of [cyclic, new Date(), nonFinite, null, []]) {
    const result = inspectScenarioClaimApproval(candidate, { platform: 'ios' }, approval);
    assert.equal(result.approvalBinding, 'outside_contract');
    assert.equal(reasonCodes(result).includes('malformed_scenario'), true);
    assertAttestationOnly(result);
  }
});

test('rejects a selected platform outside the scenario contract before binding', () => {
  const scenario = sampleScenario();
  scenario.platforms = ['ios'];
  const result = inspectScenarioClaimApproval(
    scenario,
    { platform: 'android' },
    approvalFor(scenario, { platform: 'android' }),
  );

  assert.equal(result.approvalBinding, 'outside_contract');
  assert.deepEqual(reasonCodes(result), ['undeclared_platform']);
  assert.equal(result.nextAction, 'declare_selected_platform');
  assert.equal(check(result, 'selection_platform_declared').status, 'failed');
  assert.equal(typeof result.computedScenarioHash, 'string');
  assertAttestationOnly(result);
});

test('rejects malformed approval records including runtime authorization fields', () => {
  const scenario = sampleScenario();
  const base = approvalFor(scenario);
  const malformed: JsonRecord[] = [
    { ...base, scenarioHash: 'ABC' },
    { ...base, approvedAt: 'not-a-date' },
    { ...base, decision: 'pending' },
    { ...base, expiresAt: '2026-08-22T12:00:00Z' },
    { ...base, credentials: 'forbidden' },
    { ...base, approverRef: '' },
  ];
  const missing = clone(base);
  delete missing.approvalId;
  malformed.push(missing);
  const cyclic = clone(base);
  cyclic.self = cyclic;
  malformed.push(cyclic);

  for (const approval of malformed) {
    const result = inspectScenarioClaimApproval(scenario, { platform: 'ios' }, approval);
    assert.equal(result.approvalBinding, 'outside_contract');
    assert.deepEqual(reasonCodes(result), ['malformed_approval_record']);
    assert.equal(result.nextAction, 'supply_valid_approval_record');
    assert.equal(check(result, 'approval_record_structure').status, 'failed');
    assertAttestationOnly(result);
  }
});

test('reports each exact binding mismatch and all combined mismatches', () => {
  const scenario = sampleScenario();
  const base = approvalFor(scenario);
  const cases: Array<[JsonRecord, string]> = [
    [{ ...base, scenarioId: 'different-scenario' }, 'scenario_id_mismatch'],
    [{ ...base, scenarioHash: 'a'.repeat(64) }, 'scenario_hash_mismatch'],
    [{ ...base, selection: { platform: 'android' } }, 'selection_platform_mismatch'],
    [{ ...base, selection: { platform: 'ios', variant: 'beta' } }, 'selection_variant_mismatch'],
  ];

  for (const [approval, reason] of cases) {
    const result = inspectScenarioClaimApproval(scenario, { platform: 'ios' }, approval);
    assert.equal(result.approvalBinding, 'invalidated');
    assert.deepEqual(reasonCodes(result), [reason]);
    assert.equal(result.nextAction, 'reapprove_current_scenario_selection');
    assertAttestationOnly(result);
  }

  const combined = inspectScenarioClaimApproval(scenario, { platform: 'ios' }, {
    ...base,
    scenarioId: 'different-scenario',
    scenarioHash: 'a'.repeat(64),
    selection: { platform: 'android', variant: 'beta' },
  });
  assert.deepEqual(reasonCodes(combined), [
    'scenario_id_mismatch',
    'scenario_hash_mismatch',
    'selection_platform_mismatch',
    'selection_variant_mismatch',
  ]);
});

test('binds explicit variants exactly and distinguishes omitted variants', () => {
  const scenario = sampleScenario();
  scenario.claims[0].applicability.variants = ['beta'];
  const beta = approvalFor(scenario, { platform: 'ios', variant: 'beta' });

  assert.equal(
    inspectScenarioClaimApproval(scenario, { platform: 'ios', variant: 'beta' }, beta).approvalBinding,
    'bound',
  );
  assert.equal(
    inspectScenarioClaimApproval(scenario, { platform: 'ios' }, beta).approvalBinding,
    'invalidated',
  );
});

test('invalidates a prior approval after any full scenario edit', () => {
  const scenario = sampleScenario();
  const approval = approvalFor(scenario);
  const edited = clone(scenario);
  edited.description = 'A new description invalidates conservative V1 approval.';

  const result = inspectScenarioClaimApproval(edited, { platform: 'ios' }, approval);
  assert.equal(result.approvalBinding, 'invalidated');
  assert.deepEqual(reasonCodes(result), ['scenario_hash_mismatch']);
});

test('throws only for invalid programmer selection input', () => {
  const scenario = sampleScenario();
  const approval = approvalFor(scenario);

  assert.throws(
    () => inspectScenarioClaimApproval(scenario, { platform: 'web' } as any, approval),
    /selection\.platform/u,
  );
  assert.throws(
    () => inspectScenarioClaimApproval(scenario, { platform: 'ios', variant: '' }, approval),
    /selection\.variant/u,
  );
});
