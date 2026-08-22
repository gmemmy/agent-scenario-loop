const assert = require('node:assert/strict');
const test = require('node:test');

const {
  reduceClaimStatus,
  reduceMandatoryJourneyStatus,
} = require('../claim-reduction-policy');

type ClaimStatus = 'supported' | 'rejected' | 'not_evaluable';
type HealthStatus = 'passed' | 'failed' | 'partial';
type JourneyResult = 'passed' | 'failed' | 'inconclusive' | 'missing_inventory';

test('claim reduction health gate yields not_evaluable unless health passed', () => {
  const cases: Array<{
    healthStatus: HealthStatus;
    assertionStatuses: ClaimStatus[];
    expected: ClaimStatus;
  }> = [
    { healthStatus: 'passed', assertionStatuses: ['supported'], expected: 'supported' },
    { healthStatus: 'passed', assertionStatuses: ['rejected'], expected: 'rejected' },
    { healthStatus: 'passed', assertionStatuses: ['not_evaluable'], expected: 'not_evaluable' },
    { healthStatus: 'failed', assertionStatuses: ['supported'], expected: 'not_evaluable' },
    { healthStatus: 'failed', assertionStatuses: ['rejected'], expected: 'not_evaluable' },
    { healthStatus: 'failed', assertionStatuses: ['not_evaluable'], expected: 'not_evaluable' },
    { healthStatus: 'partial', assertionStatuses: ['supported'], expected: 'not_evaluable' },
    { healthStatus: 'partial', assertionStatuses: ['rejected'], expected: 'not_evaluable' },
    { healthStatus: 'partial', assertionStatuses: ['not_evaluable'], expected: 'not_evaluable' },
  ];

  for (const entry of cases) {
    assert.equal(
      reduceClaimStatus(entry.healthStatus, entry.assertionStatuses),
      entry.expected,
      `failed for health=${entry.healthStatus} assertions=${entry.assertionStatuses.join(',')}`,
    );
  }
});

test('claim reduction truth table for passed health assertion combinations', () => {
  const combinations: Array<{ assertionStatuses: ClaimStatus[]; expected: ClaimStatus }> = [
    { assertionStatuses: ['supported'], expected: 'supported' },
    { assertionStatuses: ['rejected'], expected: 'rejected' },
    { assertionStatuses: ['not_evaluable'], expected: 'not_evaluable' },
    { assertionStatuses: ['supported', 'supported'], expected: 'supported' },
    { assertionStatuses: ['supported', 'rejected'], expected: 'rejected' },
    { assertionStatuses: ['supported', 'not_evaluable'], expected: 'not_evaluable' },
    { assertionStatuses: ['rejected', 'not_evaluable'], expected: 'rejected' },
    { assertionStatuses: ['rejected', 'supported'], expected: 'rejected' },
    { assertionStatuses: ['not_evaluable', 'supported'], expected: 'not_evaluable' },
    { assertionStatuses: ['not_evaluable', 'rejected'], expected: 'rejected' },
    { assertionStatuses: ['supported', 'rejected', 'not_evaluable'], expected: 'rejected' },
    { assertionStatuses: ['not_evaluable', 'supported', 'rejected'], expected: 'rejected' },
    { assertionStatuses: ['rejected', 'not_evaluable', 'supported'], expected: 'rejected' },
  ];

  for (const entry of combinations) {
    assert.equal(
      reduceClaimStatus('passed', entry.assertionStatuses),
      entry.expected,
      `failed for ${entry.assertionStatuses.join(',')}`,
    );
  }
});

test('unknown assertion status tokens fail closed and never reduce to supported', () => {
  const unknownOnly = ['mystery'] as unknown as ClaimStatus[];
  const supportedUnknown = ['supported', 'mystery'] as unknown as ClaimStatus[];
  const rejectedUnknown = ['rejected', 'mystery'] as unknown as ClaimStatus[];
  const notEvaluableUnknown = ['not_evaluable', 'mystery'] as unknown as ClaimStatus[];

  assert.equal(reduceClaimStatus('passed', unknownOnly), 'not_evaluable');
  assert.notEqual(reduceClaimStatus('passed', unknownOnly), 'supported');
  assert.equal(reduceClaimStatus('passed', supportedUnknown), 'not_evaluable');
  assert.notEqual(reduceClaimStatus('passed', supportedUnknown), 'supported');
  assert.equal(reduceClaimStatus('passed', rejectedUnknown), 'rejected');
  assert.equal(reduceClaimStatus('passed', notEvaluableUnknown), 'not_evaluable');
  assert.equal(reduceClaimStatus('failed', unknownOnly), 'not_evaluable');
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
  const cases: Array<{ input: ClaimStatus[]; expected: JourneyResult }> = [
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

test('unknown claim status tokens fail closed and never reduce to passed', () => {
  const unknownOnly = ['mystery'] as unknown as ClaimStatus[];
  const supportedUnknown = ['supported', 'mystery'] as unknown as ClaimStatus[];
  const rejectedUnknown = ['rejected', 'mystery'] as unknown as ClaimStatus[];
  const notEvaluableUnknown = ['not_evaluable', 'mystery'] as unknown as ClaimStatus[];

  assert.equal(reduceMandatoryJourneyStatus(unknownOnly), 'missing_inventory');
  assert.notEqual(reduceMandatoryJourneyStatus(unknownOnly), 'passed');
  assert.equal(reduceMandatoryJourneyStatus(supportedUnknown), 'missing_inventory');
  assert.notEqual(reduceMandatoryJourneyStatus(supportedUnknown), 'passed');
  assert.equal(reduceMandatoryJourneyStatus(rejectedUnknown), 'failed');
  assert.equal(reduceMandatoryJourneyStatus(notEvaluableUnknown), 'inconclusive');
  assert.notEqual(reduceMandatoryJourneyStatus(unknownOnly), 'inconclusive');
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
  const mandatoryPassed: ClaimStatus[] = ['supported', 'supported'];
  const mandatoryFailed: ClaimStatus[] = ['rejected'];
  const supplementalRejected: ClaimStatus[] = ['rejected'];
  const supplementalSupported: ClaimStatus[] = ['supported'];

  assert.equal(reduceMandatoryJourneyStatus.length, 1);
  assert.equal(reduceMandatoryJourneyStatus(mandatoryPassed), 'passed');
  assert.equal(
    reduceMandatoryJourneyStatus(mandatoryPassed, supplementalRejected),
    'passed',
  );
  assert.equal(reduceMandatoryJourneyStatus(mandatoryFailed), 'failed');
  assert.equal(
    reduceMandatoryJourneyStatus(mandatoryFailed, supplementalSupported),
    'failed',
  );

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
