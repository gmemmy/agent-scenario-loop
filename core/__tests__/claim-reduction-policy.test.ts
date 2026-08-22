const assert = require('node:assert/strict');
const test = require('node:test');

const {
  reduceClaimStatus,
  reduceMandatoryJourneyStatus,
} = require('../claim-reduction-policy');

type ClaimStatus = 'supported' | 'rejected' | 'not_evaluable';
type HealthStatus = 'passed' | 'failed' | 'partial';

const ASSERTION_STATUSES: ClaimStatus[] = ['supported', 'rejected', 'not_evaluable'];
const HEALTH_STATUSES: HealthStatus[] = ['passed', 'failed', 'partial'];

function expectedClaimStatus(
  healthStatus: HealthStatus,
  assertionStatuses: readonly ClaimStatus[],
): ClaimStatus {
  if (healthStatus !== 'passed') {
    return 'not_evaluable';
  }
  if (assertionStatuses.length === 0) {
    return 'not_evaluable';
  }
  if (assertionStatuses.some((status) => status === 'rejected')) {
    return 'rejected';
  }
  if (assertionStatuses.some((status) => status === 'not_evaluable')) {
    return 'not_evaluable';
  }
  return 'supported';
}

test('claim reduction health gate yields not_evaluable unless health passed', () => {
  for (const healthStatus of HEALTH_STATUSES) {
    for (const status of ASSERTION_STATUSES) {
      assert.equal(
        reduceClaimStatus(healthStatus, [status]),
        expectedClaimStatus(healthStatus, [status]),
      );
    }
  }
});

test('claim reduction truth table for passed health assertion combinations', () => {
  const combinations: ClaimStatus[][] = [
    ['supported'],
    ['rejected'],
    ['not_evaluable'],
    ['supported', 'supported'],
    ['supported', 'rejected'],
    ['supported', 'not_evaluable'],
    ['rejected', 'not_evaluable'],
    ['rejected', 'supported'],
    ['not_evaluable', 'supported'],
    ['not_evaluable', 'rejected'],
    ['supported', 'rejected', 'not_evaluable'],
    ['not_evaluable', 'supported', 'rejected'],
    ['rejected', 'not_evaluable', 'supported'],
  ];

  for (const assertionStatuses of combinations) {
    assert.equal(
      reduceClaimStatus('passed', assertionStatuses),
      expectedClaimStatus('passed', assertionStatuses),
      `failed for ${assertionStatuses.join(',')}`,
    );
  }
});

test('empty or missing assertion inventory fails closed and never reduces to supported', () => {
  assert.equal(reduceClaimStatus('passed', []), 'not_evaluable');
  assert.equal(reduceClaimStatus('passed', undefined), 'not_evaluable');
  assert.equal(reduceClaimStatus('failed', []), 'not_evaluable');
  assert.equal(reduceClaimStatus('partial', undefined), 'not_evaluable');
  assert.notEqual(reduceClaimStatus('passed', []), 'supported');
  assert.notEqual(reduceClaimStatus('passed', undefined), 'supported');
});

test('mandatory journey reduction truth table', () => {
  const cases: Array<{ input: ClaimStatus[]; expected: string }> = [
    { input: ['supported'], expected: 'passed' },
    { input: ['supported', 'supported'], expected: 'passed' },
    { input: ['rejected'], expected: 'failed' },
    { input: ['rejected', 'supported'], expected: 'failed' },
    { input: ['supported', 'rejected'], expected: 'failed' },
    { input: ['not_evaluable'], expected: 'inconclusive' },
    { input: ['supported', 'not_evaluable'], expected: 'inconclusive' },
    { input: ['not_evaluable', 'supported'], expected: 'inconclusive' },
    { input: ['rejected', 'not_evaluable'], expected: 'failed' },
    { input: ['not_evaluable', 'rejected'], expected: 'failed' },
    { input: ['supported', 'rejected', 'not_evaluable'], expected: 'failed' },
    { input: ['not_evaluable', 'supported', 'rejected'], expected: 'failed' },
  ];

  for (const entry of cases) {
    assert.equal(
      reduceMandatoryJourneyStatus(entry.input),
      entry.expected,
      `failed for ${entry.input.join(',')}`,
    );
  }
});

test('mandatory journey reduction is order-independent', () => {
  const permutations: ClaimStatus[][] = [
    ['supported', 'rejected', 'not_evaluable'],
    ['rejected', 'not_evaluable', 'supported'],
    ['not_evaluable', 'supported', 'rejected'],
    ['rejected', 'supported', 'not_evaluable'],
  ];
  for (const input of permutations) {
    assert.equal(reduceMandatoryJourneyStatus(input), 'failed');
  }

  const inconclusivePermutations: ClaimStatus[][] = [
    ['supported', 'not_evaluable'],
    ['not_evaluable', 'supported'],
  ];
  for (const input of inconclusivePermutations) {
    assert.equal(reduceMandatoryJourneyStatus(input), 'inconclusive');
  }
});

test('empty or missing mandatory inventory fails closed and never reduces to passed or inconclusive', () => {
  assert.equal(reduceMandatoryJourneyStatus([]), 'missing_inventory');
  assert.equal(reduceMandatoryJourneyStatus(undefined), 'missing_inventory');
  assert.notEqual(reduceMandatoryJourneyStatus([]), 'passed');
  assert.notEqual(reduceMandatoryJourneyStatus([]), 'inconclusive');
  assert.notEqual(reduceMandatoryJourneyStatus(undefined), 'passed');
  assert.notEqual(reduceMandatoryJourneyStatus(undefined), 'inconclusive');
});

test('supplemental statuses cannot enter or alter mandatory journey reduction', () => {
  const mandatory: ClaimStatus[] = ['supported', 'supported'];
  const withSupplementalRejected: ClaimStatus[] = [...mandatory];
  assert.equal(reduceMandatoryJourneyStatus(mandatory), 'passed');
  assert.equal(reduceMandatoryJourneyStatus(withSupplementalRejected), 'passed');

  const arity = reduceMandatoryJourneyStatus.length;
  assert.equal(arity, 1);

  const rejectedMandatory: ClaimStatus[] = ['rejected'];
  assert.equal(reduceMandatoryJourneyStatus(rejectedMandatory), 'failed');
});

test('caller mutation cannot change returned claim or journey state', () => {
  const assertionStatuses: ClaimStatus[] = ['supported', 'supported'];
  const claimStatus = reduceClaimStatus('passed', assertionStatuses);
  assertionStatuses[0] = 'rejected';
  assertionStatuses[1] = 'rejected';
  assert.equal(claimStatus, 'supported');
  assert.equal(reduceClaimStatus('passed', assertionStatuses), 'rejected');

  const mandatory: ClaimStatus[] = ['supported', 'supported'];
  const journeyStatus = reduceMandatoryJourneyStatus(mandatory);
  mandatory[0] = 'rejected';
  assert.equal(journeyStatus, 'passed');
  assert.equal(reduceMandatoryJourneyStatus(mandatory), 'failed');
});
