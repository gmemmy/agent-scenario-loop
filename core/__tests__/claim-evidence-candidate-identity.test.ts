const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION,
  InvalidScenarioClaimEvidenceRunIdentityError,
  buildScenarioClaimEvidenceRunIdentityHash,
  inspectScenarioClaimEvidenceCandidateIdentity,
} = require('../claim-evidence-candidate-identity');
const { inspectScenarioClaimAdmission } = require('../claim-admission');
const {
  assertScenarioExecutionContractSupported,
  buildScenarioClaimHash,
} = require('../claim-contract');
const {
  buildScenarioClaimCompleteContractHash,
} = require('../scenario-claim-approval');

const ROOT = path.join(__dirname, '..', '..', '..');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

type JsonRecord = Record<string, any>;

function readJson(relativePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function assertExactKeySet(value: JsonRecord, expected: readonly string[]): void {
  assert.deepEqual([...Object.keys(value)].sort(), [...expected].sort());
}

function scenarioWithAssertion(assertion: JsonRecord = eventAssertion()): JsonRecord {
  const scenario = readJson('examples/scenarios/mobile/app-startup.json');
  scenario.schemaVersion = '1.1.0';
  scenario.platforms = ['ios', 'android'];
  scenario.description = 'Bind one evidence candidate without evaluating product truth.';
  scenario.journey = {
    name: 'Evidence identity journey',
    intent: 'Preserve one coherent product intent.',
    actor: 'returning user',
    startState: 'the app is ready',
    endState: 'the intended state is stable',
    phases: [{ id: 'complete-intent', description: 'Complete the intent.', coverageKind: 'product' }],
    terminalInvariants: [{ id: 'state-stable', description: 'State remains stable.', coverageKind: 'product' }],
    recovery: { status: 'not_required', rationale: 'No interruption is required.' },
  };
  scenario.claims = [{
    id: 'journey-completes',
    role: 'mandatory',
    applicability: { platforms: ['ios', 'android'] },
    closes: { phases: ['complete-intent'], terminalInvariants: ['state-stable'] },
    assertions: [assertion],
  }];
  scenario.safety = {
    class: 'read_only',
    rationale: 'This scenario observes without mutation.',
    allowedOperations: ['observe'],
  };
  scenario.dependencies = [];
  return scenario;
}

function eventAssertion(role = 'app', producerId = 'app-profile-session'): JsonRecord {
  return {
    id: 'journey-completed-event',
    kind: 'eventOccurrence',
    event: 'journey_completed',
    authority: {
      role,
      producerId,
      evidenceSelector: 'profileEvents.journey_completed',
      requiredStrength: 'verified',
      completeness: 'point',
    },
  };
}

function authorityFor(assertion: JsonRecord): JsonRecord {
  return {
    schemaVersion: '1.0.0',
    declarationId: `${assertion.authority.producerId}-authority`,
    role: assertion.authority.role,
    producerId: assertion.authority.producerId,
    platforms: ['ios', 'android'],
    assertionKinds: [assertion.kind],
    evidenceSelectors: [assertion.authority.evidenceSelector],
    maxStrength: 'verified',
    maxCompleteness: 'continuous-complete',
    ...(assertion.kind === 'validatedEvidence'
      ? {
          artifactKinds: [assertion.artifactKind],
          validationContracts: [assertion.validationContract],
        }
      : {}),
  };
}

function selection(variant?: string): JsonRecord {
  return { platform: 'ios', ...(variant === undefined ? {} : { variant }) };
}

function admit(scenario: JsonRecord, selected = selection()): JsonRecord {
  const scenarioHash = buildScenarioClaimCompleteContractHash(scenario);
  const assertion = scenario.claims[0].assertions[0];
  return inspectScenarioClaimAdmission({
    scenario,
    selection: selected,
    authorityCatalog: [authorityFor(assertion)],
    authorizationRequest: {
      goalId: 'inspect-evidence-identity',
      operations: ['observe'],
      targetResource: 'mobile-target:ios:simulator-1',
      nowMs: Date.parse('2026-08-21T12:00:00.000Z'),
    },
    authorizationGrant: {
      schemaVersion: '1.0.0',
      grantId: 'evidence-identity-grant',
      scenarioId: scenario.id,
      scenarioHash,
      selection: selected,
      safetyClass: 'read_only',
      goalId: 'inspect-evidence-identity',
      operations: ['observe'],
      targetResource: 'mobile-target:ios:simulator-1',
      expiresAt: '2026-08-21T12:00:01.000Z',
      delegationChain: ['local-owner'],
    },
    approval: {
      schemaVersion: '1.0.0',
      approvalId: 'evidence-identity-approval',
      scenarioId: scenario.id,
      scenarioHash,
      selection: selected,
      decision: 'approved',
      approvedAt: '2026-08-21T12:00:00Z',
      approverRef: 'local-review',
    },
  });
}

function runIdentity(scenario: JsonRecord, selected = selection()): JsonRecord {
  const assertion = scenario.claims[0].assertions[0];
  return {
    schemaVersion: '1.0.0',
    scenarioId: scenario.id,
    scenarioHash: buildScenarioClaimCompleteContractHash(scenario),
    runId: 'run-evidence-identity',
    attemptId: 'attempt-1',
    selection: selected,
    source: { gitSha: 'c156f784600e8b5245cfedbcdbd2a48376704f70' },
    package: { name: 'agent-scenario-loop', version: '0.1.18', sha256: SHA_A },
    target: { resourceId: 'mobile-target:ios:simulator-1', deviceId: 'simulator-1', runtimeId: 'ios-26' },
    installedApp: { appId: 'dev.example.app', version: '1.0.0', buildId: '1', sha256: SHA_B },
    runner: { id: 'asl-ios-simctl', version: '0.1.18' },
    adapter: { id: 'simctl', version: '26.0' },
    transport: { id: 'profile-session-deeplink', version: '1.0.0' },
    appHelper: { payloadId: 'profile-session-helper@1.1.0', sha256: SHA_C },
    environment: { id: 'local-production-fixture', cohortHash: SHA_A },
    producers: [{
      role: assertion.authority.role,
      producerId: assertion.authority.producerId,
      version: '1.0.0',
      sha256: SHA_B,
    }],
  };
}

function candidateFor(scenario: JsonRecord, identity: JsonRecord): JsonRecord {
  const claim = scenario.claims[0];
  const assertion = claim.assertions[0];
  const candidate: JsonRecord = {
    schemaVersion: '1.0.0',
    candidateId: 'candidate-1',
    runIdentityHash: buildScenarioClaimEvidenceRunIdentityHash(identity),
    claimId: claim.id,
    claimHash: buildScenarioClaimHash(claim),
    assertionId: assertion.id,
    assertionKind: assertion.kind,
    authority: {
      declarationId: `${assertion.authority.producerId}-authority`,
      role: assertion.authority.role,
      producerId: assertion.authority.producerId,
      evidenceSelector: assertion.authority.evidenceSelector,
      producerVersion: '1.0.0',
      producerSha256: SHA_B,
      strength: assertion.authority.requiredStrength,
      completeness: assertion.authority.completeness,
    },
    captureStatus: 'produced',
    evidence: { path: 'raw/profile-events.json', sha256: SHA_C },
    cleanupStatus: 'finalized',
    redactionStatus: 'not-redacted',
  };
  if (assertion.kind === 'validatedEvidence') {
    candidate.artifactKind = assertion.artifactKind;
    candidate.validationContract = assertion.validationContract;
  }
  if (assertion.kind === 'boundedCount' || assertion.kind === 'absence') {
    candidate.observationWindow = clone(assertion.observationWindow);
  }
  return candidate;
}

function inspect(scenario: JsonRecord, overrides: JsonRecord = {}): JsonRecord {
  const selected = overrides.selection ?? selection();
  const admission = overrides.admission ?? admit(scenario, selected);
  const identity = overrides.runIdentity ?? runIdentity(scenario, selected);
  const candidate = overrides.candidate ?? candidateFor(scenario, identity);
  return inspectScenarioClaimEvidenceCandidateIdentity({
    admission,
    scenario,
    runIdentity: identity,
    claimId: overrides.claimId ?? scenario.claims[0].id,
    assertionId: overrides.assertionId ?? scenario.claims[0].assertions[0].id,
    candidate,
  });
}

function inspectRaw(input: unknown): JsonRecord {
  return inspectScenarioClaimEvidenceCandidateIdentity(input as never);
}

function coercible(value: string): unknown {
  return {
    toString() {
      return value;
    },
  };
}

test('admits exact app evidence for future evaluation without enabling execution', () => {
  const scenario = scenarioWithAssertion();
  const result = inspect(scenario);

  assert.equal(CLAIM_EVIDENCE_CANDIDATE_IDENTITY_INSPECTION_VERSION, '1.0.0');
  assert.equal(result.status, 'eligible');
  assert.deepEqual(result.gateSummaries.map((gate: JsonRecord) => [gate.gate, gate.status]), [
    ['run_identity', 'matched'],
    ['assertion_identity', 'matched'],
    ['authority_binding', 'matched'],
    ['evidence_binding', 'matched'],
    ['lifecycle', 'matched'],
  ]);
  assert.deepEqual(result.blockingGates, []);
  assert.equal(Object.hasOwn(result, 'firstBlockingGate'), false);
  assert.equal(Object.hasOwn(result, 'nextAction'), false);
  assert.equal(Object.hasOwn(result, 'eligibleCandidate'), true);
  assert.equal(result.eligibleCandidate.captureStatus, 'produced');
  assert.equal(result.eligibleCandidate.cleanupStatus, 'finalized');
  assert.equal(result.eligibleCandidate.assertionKind, 'eventOccurrence');
  assert.equal(Object.hasOwn(result.eligibleCandidate, 'artifactKind'), false);
  assert.equal(Object.hasOwn(result.eligibleCandidate, 'validationContract'), false);
  assert.equal(Object.hasOwn(result.eligibleCandidate, 'observationWindow'), false);
  assert.throws(() => assertScenarioExecutionContractSupported(scenario), /reader-only/u);
});

test('binds an exact selected variant', () => {
  const scenario = scenarioWithAssertion();
  scenario.claims[0].applicability.variants = ['signed-in'];
  const selected = selection('signed-in');
  assert.equal(inspect(scenario, {
    selection: selected,
    admission: admit(scenario, selected),
    runIdentity: runIdentity(scenario, selected),
  }).status, 'eligible');
});

test('supports each authority role without converting eligibility into product truth', () => {
  for (const [role, producerId] of [
    ['app', 'app-profile-session'],
    ['runner', 'runner-observer'],
    ['adapter', 'adapter-observer'],
    ['provider', 'native-provider'],
    ['comparator', 'validated-comparator'],
  ]) {
    const scenario = scenarioWithAssertion(eventAssertion(role, producerId));
    const result = inspect(scenario);
    assert.equal(result.status, 'eligible', `${role}:${producerId}`);
  }
});

test('keeps semantic evidence binding matched by construction', () => {
  for (const assertion of [
    {
      id: 'event-order', kind: 'eventOrder', beforeEvent: 'journey_started', afterEvent: 'journey_completed',
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.order',
        requiredStrength: 'verified', completeness: 'point',
      },
    },
    {
      id: 'terminal-state', kind: 'terminalState', path: 'navigation.route', expected: 'complete',
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.terminal',
        requiredStrength: 'verified', completeness: 'point',
      },
    },
  ]) {
    const scenario = scenarioWithAssertion(assertion);
    const identity = runIdentity(scenario);
    const candidate = candidateFor(scenario, identity);
    candidate.cleanupStatus = 'not_required';
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'eligible', assertion.kind);
    assert.deepEqual(
      result.gateSummaries.find((gate: JsonRecord) => gate.gate === 'evidence_binding'),
      { gate: 'evidence_binding', status: 'matched', reasonCodes: [] },
    );
  }
});

test('binds validated and windowed assertion contracts exactly', () => {
  const validated = scenarioWithAssertion({
    id: 'video-valid',
    kind: 'validatedEvidence',
    artifactKind: 'video',
    validationContract: 'video-structure-v1',
    authority: {
      role: 'comparator', producerId: 'video-comparator', evidenceSelector: 'captures.video',
      requiredStrength: 'verified', completeness: 'bounded',
    },
  });
  assert.equal(inspect(validated).status, 'eligible');
  const wrongValidated = candidateFor(validated, runIdentity(validated));
  wrongValidated.validationContract = 'other-contract';
  const validatedResult = inspect(validated, { candidate: wrongValidated });
  assert.equal(validatedResult.status, 'blocked');
  assert.deepEqual(validatedResult.blockingGates, ['evidence_binding']);

  for (const kind of ['boundedCount', 'absence']) {
    const assertion: JsonRecord = {
      id: kind === 'boundedCount' ? 'bounded-count-assertion' : 'absence-assertion',
      kind,
      selector: 'events.item',
      observationWindow: { from: 'window-start', to: 'window-end', completeSourceRequired: true },
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.items',
        requiredStrength: 'verified',
        completeness: kind === 'absence' ? 'continuous-complete' : 'bounded',
      },
    };
    if (kind === 'boundedCount') assertion.minimum = 1;
    const scenario = scenarioWithAssertion(assertion);
    assert.equal(inspect(scenario).status, 'eligible');
    const identity = runIdentity(scenario);
    const candidate = candidateFor(scenario, identity);
    candidate.observationWindow.to = 'wrong-end';
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.blockingGates, ['evidence_binding']);
  }
});

test('hashes producer order canonically without mutating caller input', () => {
  const scenario = scenarioWithAssertion();
  const left = runIdentity(scenario);
  left.producers.push({ role: 'provider', producerId: 'provider-z', version: '1', sha256: SHA_C });
  const right = clone(left);
  right.producers.reverse();
  const before = JSON.stringify(right.producers);

  assert.equal(
    buildScenarioClaimEvidenceRunIdentityHash(left),
    buildScenarioClaimEvidenceRunIdentityHash(right),
  );
  assert.equal(JSON.stringify(right.producers), before);
});

test('rejects malformed run identities and maps them outside contract', () => {
  const scenario = scenarioWithAssertion();
  const invalids = [
    { mutate: (identity: JsonRecord) => { identity.package.sha256 = 'not-a-hash'; } },
    { mutate: (identity: JsonRecord) => { identity.target.deviceId = '/absolute/device'; } },
    { mutate: (identity: JsonRecord) => { identity.target.deviceId = 'C:\\device'; } },
    { mutate: (identity: JsonRecord) => { identity.target.deviceId = '../device'; } },
    { mutate: (identity: JsonRecord) => { identity.target.deviceId = 'file:device'; } },
    { mutate: (identity: JsonRecord) => { identity.target.deviceId = ' padded-device'; } },
    { mutate: (identity: JsonRecord) => { identity.target.deviceId = 'device\u0000suffix'; } },
    { mutate: (identity: JsonRecord) => { identity.producers.push(clone(identity.producers[0])); } },
    { mutate: (identity: JsonRecord) => { identity.extra = true; } },
    { mutate: (identity: JsonRecord) => { identity.runId = undefined; } },
  ];
  for (const { mutate } of invalids) {
    const identity = runIdentity(scenario);
    mutate(identity);
    assert.throws(
      () => buildScenarioClaimEvidenceRunIdentityHash(identity),
      InvalidScenarioClaimEvidenceRunIdentityError,
    );
    const result = inspect(scenario, { runIdentity: identity, candidate: candidateFor(scenario, runIdentity(scenario)) });
    assert.equal(result.status, 'outside_contract');
    assert.deepEqual(result.reasonCodes, ['run_identity_invalid']);
    assert.equal(Object.hasOwn(result, 'scenarioHash'), false);
  }

  const cyclic = runIdentity(scenario);
  cyclic.self = cyclic;
  assert.throws(() => buildScenarioClaimEvidenceRunIdentityHash(cyclic), InvalidScenarioClaimEvidenceRunIdentityError);
  assert.equal(inspect(scenario, {
    runIdentity: cyclic,
    candidate: candidateFor(scenario, runIdentity(scenario)),
  }).status, 'outside_contract');

  const nonPlain = runIdentity(scenario);
  nonPlain.source = new Date();
  assert.throws(() => buildScenarioClaimEvidenceRunIdentityHash(nonPlain), InvalidScenarioClaimEvidenceRunIdentityError);
});

test('keeps foundational admission, scenario, selection, and candidate failures outside', () => {
  const scenario = scenarioWithAssertion();
  const blockedAdmission = clone(admit(scenario));
  blockedAdmission.status = 'blocked';
  assert.deepEqual(inspect(scenario, { admission: blockedAdmission }).reasonCodes, ['admission_not_admitted']);

  const malformedAdmission = clone(admit(scenario));
  malformedAdmission.inspections.authority.checks = [null];
  assert.deepEqual(inspect(scenario, { admission: malformedAdmission }).reasonCodes, ['admission_not_admitted']);

  const openSelectionAdmission = clone(admit(scenario));
  openSelectionAdmission.selection.extra = 'ignored-by-loose-readers';
  assert.deepEqual(inspect(scenario, { admission: openSelectionAdmission }).reasonCodes, ['admission_not_admitted']);

  const incompleteOwnerInventory = clone(admit(scenario));
  delete incompleteOwnerInventory.inspections.safety;
  assert.deepEqual(inspect(scenario, { admission: incompleteOwnerInventory }).reasonCodes, ['admission_not_admitted']);

  const drifted = clone(scenario);
  drifted.description = 'Hash drift.';
  assert.deepEqual(inspect(drifted, { admission: admit(scenario) }).reasonCodes, ['scenario_binding_invalid']);

  assert.deepEqual(inspect(scenario, { claimId: 'missing-claim' }).reasonCodes, ['assertion_outside_selection']);

  const identity = runIdentity(scenario);
  const malformed = candidateFor(scenario, identity);
  malformed.evidence.path = '..\\secret.json';
  assert.deepEqual(inspect(scenario, { candidate: malformed }).reasonCodes, ['candidate_invalid']);
});

test('rejects non-string closed vocabularies as candidate_invalid', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  const mutations: Array<(candidate: JsonRecord) => void> = [
    (candidate) => { candidate.captureStatus = coercible('produced'); },
    (candidate) => { candidate.cleanupStatus = coercible('finalized'); },
    (candidate) => { candidate.redactionStatus = coercible('not-redacted'); },
    (candidate) => { candidate.assertionKind = coercible('eventOccurrence'); },
    (candidate) => { candidate.authority.role = coercible('app'); },
    (candidate) => { candidate.authority.completeness = coercible('point'); },
    (candidate) => { candidate.captureStatus = Object('produced'); },
    (candidate) => { candidate.assertionKind = 0; },
    (candidate) => { candidate.authority.role = { toString: () => 'app' }; },
  ];
  for (const mutate of mutations) {
    const candidate = candidateFor(scenario, identity);
    mutate(candidate);
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'outside_contract');
    assert.deepEqual(result.reasonCodes, ['candidate_invalid']);
  }

  const validated = scenarioWithAssertion({
    id: 'video-valid',
    kind: 'validatedEvidence',
    artifactKind: 'video',
    validationContract: 'video-structure-v1',
    authority: {
      role: 'comparator', producerId: 'video-comparator', evidenceSelector: 'captures.video',
      requiredStrength: 'verified', completeness: 'bounded',
    },
  });
  const validatedCandidate = candidateFor(validated, runIdentity(validated));
  validatedCandidate.artifactKind = coercible('video');
  const validatedResult = inspect(validated, { candidate: validatedCandidate });
  assert.equal(validatedResult.status, 'outside_contract');
  assert.deepEqual(validatedResult.reasonCodes, ['candidate_invalid']);
});

test('rejects evidence paths that violate identity-string constraints', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  assert.equal(inspect(scenario).status, 'eligible');
  for (const path of [
    ' raw/profile-events.json',
    'raw/profile-events.json ',
    'raw/\u0001profile-events.json',
    'raw/profile-events.json\u007f',
  ]) {
    const candidate = candidateFor(scenario, identity);
    candidate.evidence.path = path;
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'outside_contract', path);
    assert.deepEqual(result.reasonCodes, ['candidate_invalid'], path);
  }
});

test('treats untrusted inspector envelopes as outside contract', () => {
  const scenario = scenarioWithAssertion();
  const admission = admit(scenario);
  const identity = runIdentity(scenario);
  const candidate = candidateFor(scenario, identity);
  const valid = {
    admission,
    scenario,
    runIdentity: identity,
    claimId: scenario.claims[0].id,
    assertionId: scenario.claims[0].assertions[0].id,
    candidate,
  };

  for (const input of [null, undefined, [], 'envelope', 1, true]) {
    const result = inspectRaw(input);
    assert.equal(result.status, 'outside_contract');
    assert.deepEqual(result.reasonCodes, ['admission_not_admitted']);
    assert.equal(result.nextAction, 'supply_admitted_scenario');
  }

  const extraKey = inspectRaw({ ...valid, extra: true });
  assert.equal(extraKey.status, 'outside_contract');
  assert.deepEqual(extraKey.reasonCodes, ['admission_not_admitted']);

  const missingAdmission = { ...valid } as JsonRecord;
  delete missingAdmission.admission;
  assert.deepEqual(inspectRaw(missingAdmission).reasonCodes, ['admission_not_admitted']);

  const missingScenario = { ...valid } as JsonRecord;
  delete missingScenario.scenario;
  assert.deepEqual(inspectRaw(missingScenario).reasonCodes, ['scenario_binding_invalid']);

  const missingRunIdentity = { ...valid } as JsonRecord;
  delete missingRunIdentity.runIdentity;
  assert.deepEqual(inspectRaw(missingRunIdentity).reasonCodes, ['run_identity_invalid']);

  const missingClaimId = { ...valid } as JsonRecord;
  delete missingClaimId.claimId;
  assert.deepEqual(inspectRaw(missingClaimId).reasonCodes, ['assertion_outside_selection']);

  const missingCandidate = { ...valid } as JsonRecord;
  delete missingCandidate.candidate;
  assert.deepEqual(inspectRaw(missingCandidate).reasonCodes, ['candidate_invalid']);
});

test('rejects extra-key authority checks while preserving valid subject kinds', () => {
  const scenario = scenarioWithAssertion();
  const extraClaimCheck = clone(admit(scenario));
  extraClaimCheck.inspections.authority.checks[0].extra = 'not-in-contract';
  assert.deepEqual(
    inspect(scenario, { admission: extraClaimCheck }).reasonCodes,
    ['admission_not_admitted'],
  );

  const assertion = eventAssertion();
  scenario.dependencies = [{
    id: 'entry-ready',
    kind: 'journey_entry',
    applicability: { platforms: ['ios', 'android'] },
    predicate: {
      id: 'entry-ready-event',
      kind: assertion.kind,
      event: assertion.event,
      authority: { ...assertion.authority },
    },
  }];
  const admitted = admit(scenario);
  assert.equal(inspect(scenario, { admission: admitted }).status, 'eligible');
  assert.equal(
    admitted.inspections.authority.checks.some((check: JsonRecord) => check.subjectKind === 'dependency_predicate'),
    true,
  );

  const extraDependencyCheck = clone(admitted);
  const dependencyCheck = extraDependencyCheck.inspections.authority.checks.find(
    (check: JsonRecord) => check.subjectKind === 'dependency_predicate',
  );
  dependencyCheck.extra = 'not-in-contract';
  assert.deepEqual(
    inspect(scenario, { admission: extraDependencyCheck }).reasonCodes,
    ['admission_not_admitted'],
  );
});

test('preserves all candidate identity blockers in doctrine order', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  const candidate = candidateFor(scenario, identity);
  candidate.runIdentityHash = SHA_C;
  candidate.claimId = 'wrong-claim';
  candidate.claimHash = SHA_C;
  candidate.assertionId = 'wrong-assertion';
  candidate.assertionKind = 'terminalState';
  candidate.authority.declarationId = 'wrong-declaration';
  candidate.authority.role = 'provider';
  candidate.authority.producerId = 'wrong-producer';
  candidate.authority.evidenceSelector = 'wrong.selector';
  candidate.authority.producerVersion = 'wrong-version';
  candidate.authority.producerSha256 = SHA_C;
  candidate.authority.strength = 'observed';
  candidate.authority.completeness = 'bounded';
  candidate.captureStatus = 'partial';
  candidate.cleanupStatus = 'incomplete';

  const result = inspect(scenario, { candidate });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockingGates, [
    'run_identity',
    'assertion_identity',
    'authority_binding',
    'lifecycle',
  ]);
  assert.equal(result.firstBlockingGate, 'run_identity');
  assert.equal(result.nextAction, 'repair_run_identity_binding');
  assert.equal(JSON.stringify(result).includes('not_applicable'), false);
});

test('keeps sibling claims isolated from one candidate mismatch', () => {
  const scenario = scenarioWithAssertion();
  const sibling = clone(scenario.claims[0]);
  sibling.id = 'sibling-claim';
  sibling.assertions[0].id = 'sibling-event';
  scenario.claims.push(sibling);
  const admission = admit(scenario);
  const identity = runIdentity(scenario);

  const first = candidateFor(scenario, identity);
  first.claimHash = SHA_C;
  const firstResult = inspect(scenario, { admission, runIdentity: identity, candidate: first });
  assert.equal(firstResult.status, 'blocked');
  assert.deepEqual(firstResult.blockingGates, ['assertion_identity']);

  const siblingScenario = clone(scenario);
  siblingScenario.claims = [siblingScenario.claims[1]];
  const siblingIdentity = runIdentity(siblingScenario);
  assert.equal(inspect(siblingScenario, { runIdentity: siblingIdentity }).status, 'eligible');
});

test('binds the exact admission authority check and producer identity', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  const candidate = candidateFor(scenario, identity);
  candidate.authority.declarationId = 'other-declaration';
  candidate.authority.producerVersion = 'other-version';
  candidate.authority.producerSha256 = SHA_C;
  candidate.authority.strength = 'observed';
  candidate.authority.completeness = 'continuous-complete';

  const result = inspect(scenario, { candidate });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockingGates, ['run_identity', 'authority_binding']);
  assert.deepEqual(
    result.gateSummaries.find((gate: JsonRecord) => gate.gate === 'authority_binding').reasonCodes,
    ['authority_declaration_mismatch', 'evidence_strength_mismatch', 'evidence_completeness_mismatch'],
  );

  const missing = admit(scenario);
  missing.inspections.authority.checks = [];
  const missingResult = inspect(scenario, { admission: missing });
  assert.equal(missingResult.status, 'blocked');
  assert.deepEqual(missingResult.blockingGates, ['authority_binding']);

  const ambiguous = admit(scenario);
  ambiguous.inspections.authority.checks.push(clone(ambiguous.inspections.authority.checks[0]));
  const ambiguousResult = inspect(scenario, { admission: ambiguous });
  assert.equal(ambiguousResult.status, 'blocked');
  assert.deepEqual(
    ambiguousResult.gateSummaries.find((gate: JsonRecord) => gate.gate === 'authority_binding').reasonCodes,
    ['authority_check_ambiguous'],
  );
});

test('preserves capture and cleanup ineligibility while allowing private evidence locally', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  for (const [status, reason] of [
    ['partial', 'capture_partial'],
    ['missing', 'capture_missing'],
    ['rejected', 'capture_rejected'],
  ]) {
    const candidate = candidateFor(scenario, identity);
    candidate.captureStatus = status;
    if (status === 'missing') delete candidate.evidence;
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(
      result.gateSummaries.find((gate: JsonRecord) => gate.gate === 'lifecycle').reasonCodes,
      [reason],
    );
  }

  const cleanup = candidateFor(scenario, identity);
  cleanup.cleanupStatus = 'incomplete';
  assert.deepEqual(inspect(scenario, { candidate: cleanup }).blockingGates, ['lifecycle']);

  for (const redactionStatus of ['private', 'redacted']) {
    const candidate = candidateFor(scenario, identity);
    candidate.redactionStatus = redactionStatus;
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'eligible');
    assert.equal(result.eligibleCandidate.redactionStatus, redactionStatus);
    assert.notEqual(result.eligibleCandidate, candidate);
  }
});

test('projects a detached eligible candidate without retaining caller objects', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  const candidate = candidateFor(scenario, identity);
  const originalAuthority = candidate.authority;
  const originalEvidence = candidate.evidence;
  const result = inspect(scenario, { candidate });

  assert.equal(result.status, 'eligible');
  assert.notEqual(result.eligibleCandidate, candidate);
  assert.notEqual(result.eligibleCandidate.authority, originalAuthority);
  assert.notEqual(result.eligibleCandidate.evidence, originalEvidence);
  assert.deepEqual(result.eligibleCandidate.authority, originalAuthority);
  assert.deepEqual(result.eligibleCandidate.evidence, originalEvidence);

  candidate.candidateId = 'mutated-candidate';
  candidate.claimId = 'mutated-claim';
  candidate.authority.producerId = 'mutated-producer';
  candidate.evidence.path = 'mutated/path.json';
  candidate.cleanupStatus = 'incomplete';
  candidate.redactionStatus = 'redacted';

  assert.equal(result.eligibleCandidate.candidateId, 'candidate-1');
  assert.equal(result.eligibleCandidate.claimId, 'journey-completes');
  assert.equal(result.eligibleCandidate.authority.producerId, 'app-profile-session');
  assert.equal(result.eligibleCandidate.evidence.path, 'raw/profile-events.json');
  assert.equal(result.eligibleCandidate.cleanupStatus, 'finalized');
  assert.equal(result.eligibleCandidate.redactionStatus, 'not-redacted');
});

test('deep-copies observation windows onto eligible windowed projections', () => {
  for (const kind of ['boundedCount', 'absence']) {
    const assertion: JsonRecord = {
      id: kind === 'boundedCount' ? 'bounded-count-assertion' : 'absence-assertion',
      kind,
      selector: 'events.item',
      observationWindow: { from: 'window-start', to: 'window-end', completeSourceRequired: true },
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.items',
        requiredStrength: 'verified',
        completeness: kind === 'absence' ? 'continuous-complete' : 'bounded',
      },
    };
    if (kind === 'boundedCount') assertion.minimum = 1;
    const scenario = scenarioWithAssertion(assertion);
    const identity = runIdentity(scenario);
    const candidate = candidateFor(scenario, identity);
    const originalWindow = candidate.observationWindow;
    const result = inspect(scenario, { candidate });

    assert.equal(result.status, 'eligible', kind);
    assert.notEqual(result.eligibleCandidate.observationWindow, originalWindow);
    assert.deepEqual(result.eligibleCandidate.observationWindow, {
      from: 'window-start',
      to: 'window-end',
      completeSourceRequired: true,
    });

    candidate.observationWindow.from = 'mutated-start';
    candidate.observationWindow.to = 'mutated-end';
    candidate.observationWindow.completeSourceRequired = false;

    assert.deepEqual(result.eligibleCandidate.observationWindow, {
      from: 'window-start',
      to: 'window-end',
      completeSourceRequired: true,
    });
  }
});

test('exposes only legal projection fields for each assertion family', () => {
  const semanticKeys = [
    'schemaVersion', 'candidateId', 'runIdentityHash', 'claimId', 'claimHash',
    'assertionId', 'assertionKind', 'authority', 'captureStatus', 'evidence',
    'cleanupStatus', 'redactionStatus',
  ];

  for (const assertion of [
    {
      id: 'event-order', kind: 'eventOrder', beforeEvent: 'journey_started', afterEvent: 'journey_completed',
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.order',
        requiredStrength: 'verified', completeness: 'point',
      },
    },
    {
      id: 'terminal-state', kind: 'terminalState', path: 'navigation.route', expected: 'complete',
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.terminal',
        requiredStrength: 'verified', completeness: 'point',
      },
    },
  ]) {
    const scenario = scenarioWithAssertion(assertion);
    const identity = runIdentity(scenario);
    const candidate = candidateFor(scenario, identity);
    candidate.cleanupStatus = 'not_required';
    const result = inspect(scenario, { candidate });
    assert.equal(result.status, 'eligible', assertion.kind);
    assertExactKeySet(result.eligibleCandidate, semanticKeys);
    assert.equal(result.eligibleCandidate.cleanupStatus, 'not_required');
    assert.equal(Object.hasOwn(result.eligibleCandidate, 'artifactKind'), false);
    assert.equal(Object.hasOwn(result.eligibleCandidate, 'validationContract'), false);
    assert.equal(Object.hasOwn(result.eligibleCandidate, 'observationWindow'), false);
  }

  const validated = scenarioWithAssertion({
    id: 'video-valid',
    kind: 'validatedEvidence',
    artifactKind: 'video',
    validationContract: 'video-structure-v1',
    authority: {
      role: 'comparator', producerId: 'video-comparator', evidenceSelector: 'captures.video',
      requiredStrength: 'verified', completeness: 'bounded',
    },
  });
  const validatedResult = inspect(validated);
  assert.equal(validatedResult.status, 'eligible');
  assertExactKeySet(validatedResult.eligibleCandidate, [...semanticKeys, 'artifactKind', 'validationContract']);
  assert.equal(validatedResult.eligibleCandidate.artifactKind, 'video');
  assert.equal(validatedResult.eligibleCandidate.validationContract, 'video-structure-v1');
  assert.equal(Object.hasOwn(validatedResult.eligibleCandidate, 'observationWindow'), false);

  for (const kind of ['boundedCount', 'absence']) {
    const assertion: JsonRecord = {
      id: kind === 'boundedCount' ? 'bounded-count-assertion' : 'absence-assertion',
      kind,
      selector: 'events.item',
      observationWindow: { from: 'window-start', to: 'window-end', completeSourceRequired: true },
      authority: {
        role: 'app', producerId: 'app-profile-session', evidenceSelector: 'profileEvents.items',
        requiredStrength: 'verified',
        completeness: kind === 'absence' ? 'continuous-complete' : 'bounded',
      },
    };
    if (kind === 'boundedCount') assertion.minimum = 1;
    const result = inspect(scenarioWithAssertion(assertion));
    assert.equal(result.status, 'eligible', kind);
    assertExactKeySet(result.eligibleCandidate, [...semanticKeys, 'observationWindow']);
    assert.equal(Object.hasOwn(result.eligibleCandidate, 'artifactKind'), false);
    assert.equal(Object.hasOwn(result.eligibleCandidate, 'validationContract'), false);
  }
});

test('omits eligible projection from blocked and outside-contract results', () => {
  const scenario = scenarioWithAssertion();
  const identity = runIdentity(scenario);
  const blockedCandidate = candidateFor(scenario, identity);
  blockedCandidate.runIdentityHash = SHA_C;
  const blocked = inspect(scenario, { candidate: blockedCandidate });
  assert.equal(blocked.status, 'blocked');
  assert.equal(Object.hasOwn(blocked, 'eligibleCandidate'), false);

  const outside = inspect(scenario, { claimId: 'missing-claim' });
  assert.equal(outside.status, 'outside_contract');
  assert.equal(Object.hasOwn(outside, 'eligibleCandidate'), false);
});
