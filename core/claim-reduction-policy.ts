import type { ClaimStatus } from './claim-contract';

type ClaimReductionHealthStatus = 'passed' | 'failed' | 'partial';
type ClaimReductionJourneyStatus = 'passed' | 'failed' | 'inconclusive';
type ClaimReductionMissingInventory = 'missing_inventory';
type ClaimReductionJourneyResult =
  | ClaimReductionJourneyStatus
  | ClaimReductionMissingInventory;

/**
 * Reduces assertion statuses to a claim status under the health gate.
 * Empty or missing assertion inventory fails closed to not_evaluable.
 */
function reduceClaimStatus(
  healthStatus: ClaimReductionHealthStatus,
  assertionStatuses: readonly ClaimStatus[] | undefined,
): ClaimStatus {
  if (healthStatus !== 'passed') {
    return 'not_evaluable';
  }
  if (assertionStatuses === undefined || assertionStatuses.length === 0) {
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

/**
 * Reduces applicable mandatory claim statuses to a journey status.
 * Missing or empty mandatory inventory fails closed as missing_inventory.
 * Supplemental statuses are not an input.
 */
function reduceMandatoryJourneyStatus(
  mandatoryClaimStatuses: readonly ClaimStatus[] | undefined,
): ClaimReductionJourneyResult {
  if (mandatoryClaimStatuses === undefined || mandatoryClaimStatuses.length === 0) {
    return 'missing_inventory';
  }
  if (mandatoryClaimStatuses.some((status) => status === 'rejected')) {
    return 'failed';
  }
  if (mandatoryClaimStatuses.some((status) => status === 'not_evaluable')) {
    return 'inconclusive';
  }
  return 'passed';
}

export { reduceClaimStatus, reduceMandatoryJourneyStatus };

export type {
  ClaimReductionHealthStatus,
  ClaimReductionJourneyResult,
  ClaimReductionJourneyStatus,
  ClaimReductionMissingInventory,
};
