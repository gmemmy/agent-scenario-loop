import { admitCiEvidenceGithubPublicationFacts } from './ci-evidence-github-publication-input';
import { parseCiEvidencePackBytes } from './ci-evidence-pack';
import { buildCiEvidencePublicationReceipt } from './ci-evidence-publication-receipt';
import { evaluateCiEvidencePublicationSummary } from './ci-evidence-publication-summary';
import type { CiEvidencePublicationReceiptFacts } from './ci-evidence-publication-receipt';
import type { CiEvidencePublicationSummaryEvaluation } from './ci-evidence-publication-summary';

export class CiEvidenceGithubPublicationGateError extends Error {
  override readonly name = 'CiEvidenceGithubPublicationGateError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export type CiEvidenceGithubPublicationGateStatus = 'passed' | 'failed';

export interface CiEvidenceGithubPublicationGateEvaluation {
  readonly status: CiEvidenceGithubPublicationGateStatus;
  readonly reasons: readonly string[];
}

export interface CiEvidenceGithubPublicationGateResult {
  readonly pack: ReturnType<typeof parseCiEvidencePackBytes>;
  readonly receipt: ReturnType<typeof buildCiEvidencePublicationReceipt>;
  readonly evaluation: CiEvidenceGithubPublicationGateEvaluation;
}

const GATE_REASON_ORDER = [
  'pack.source.status',
  'pack.source.expectedSha',
  'pack.source.observedSha',
  'pack.liveProofSet.status',
  'pack.completeness.status',
  'pack.assembly.status',
  'pack.mechanismStatus',
  'pack.twoPlatformClaim.status',
  'publication.evaluation.status',
] as const;

type GateReasonKey = (typeof GATE_REASON_ORDER)[number];

function unexpectedStatus(label: string, actual: string, expected: string): string {
  return `${label} is ${actual}, expected ${expected}`;
}

function shaMismatchReason(
  label: string,
  actual: string | undefined,
  expected: string,
): string | undefined {
  if (actual === expected) {
    return undefined;
  }
  return `${label} is ${actual ?? 'absent'}, expected ${expected}`;
}

function wrapBoundaryError(error: unknown, prefix: string): never {
  if (error instanceof CiEvidenceGithubPublicationGateError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new CiEvidenceGithubPublicationGateError(`${prefix}: ${message}`, {
    cause: error,
  });
}

function toPublicationReceiptFacts(
  facts: ReturnType<typeof admitCiEvidenceGithubPublicationFacts>,
): CiEvidencePublicationReceiptFacts {
  const publisher: CiEvidencePublicationReceiptFacts['publisher'] = {
    providerId: facts.publisher.providerId,
    providerKind: facts.publisher.providerKind,
    runId: facts.publisher.runId,
    attemptNumber: facts.publisher.attemptNumber,
  };
  if (facts.publisher.workflowId !== undefined) {
    publisher.workflowId = facts.publisher.workflowId;
  }
  if (facts.publisher.jobId !== undefined) {
    publisher.jobId = facts.publisher.jobId;
  }
  return {
    receiptId: facts.receiptId,
    createdAt: facts.createdAt,
    packRelativePath: facts.packRelativePath,
    publisher,
    requestedItems: facts.requestedItems,
    outcomes: facts.outcomes,
  };
}

function collectGateReasons(
  pack: ReturnType<typeof parseCiEvidencePackBytes>,
  publicationFacts: ReturnType<typeof admitCiEvidenceGithubPublicationFacts>,
  publicationEvaluation: CiEvidencePublicationSummaryEvaluation,
): string[] {
  const headSha = publicationFacts.context.headSha;
  const candidates: Record<GateReasonKey, string | undefined> = {
    'pack.source.status':
      pack.source.status === 'current'
        ? undefined
        : unexpectedStatus('pack.source.status', pack.source.status, 'current'),
    'pack.source.expectedSha': shaMismatchReason(
      'pack.source.expectedSha',
      pack.source.expectedSha,
      headSha,
    ),
    'pack.source.observedSha': shaMismatchReason(
      'pack.source.observedSha',
      pack.source.observedSha,
      headSha,
    ),
    'pack.liveProofSet.status':
      pack.liveProofSet.status === 'passed'
        ? undefined
        : unexpectedStatus('pack.liveProofSet.status', pack.liveProofSet.status, 'passed'),
    'pack.completeness.status':
      pack.completeness.status === 'complete'
        ? undefined
        : unexpectedStatus('pack.completeness.status', pack.completeness.status, 'complete'),
    'pack.assembly.status':
      pack.assembly.status === 'succeeded'
        ? undefined
        : unexpectedStatus('pack.assembly.status', pack.assembly.status, 'succeeded'),
    'pack.mechanismStatus':
      pack.mechanismStatus === 'succeeded'
        ? undefined
        : unexpectedStatus('pack.mechanismStatus', pack.mechanismStatus, 'succeeded'),
    'pack.twoPlatformClaim.status':
      pack.twoPlatformClaim.status === 'passed'
        ? undefined
        : unexpectedStatus('pack.twoPlatformClaim.status', pack.twoPlatformClaim.status, 'passed'),
    'publication.evaluation.status':
      publicationEvaluation.status === 'passed'
        ? undefined
        : unexpectedStatus('publication.evaluation.status', publicationEvaluation.status, 'passed'),
  };

  const reasons: string[] = [];
  for (const key of GATE_REASON_ORDER) {
    const reason = candidates[key];
    if (reason !== undefined) {
      reasons.push(reason);
    }
  }
  if (publicationEvaluation.status !== 'passed') {
    for (const reason of publicationEvaluation.reasons) {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }
  return reasons;
}

export function evaluateCiEvidenceGithubPublicationGate(
  exactPackBytes: Uint8Array,
  publicationFacts: unknown,
): CiEvidenceGithubPublicationGateResult {
  let admittedFacts: ReturnType<typeof admitCiEvidenceGithubPublicationFacts>;
  try {
    admittedFacts = admitCiEvidenceGithubPublicationFacts(publicationFacts);
  } catch (error) {
    wrapBoundaryError(error, 'unadmitted GitHub publication facts');
  }

  let pack: ReturnType<typeof parseCiEvidencePackBytes>;
  try {
    pack = parseCiEvidencePackBytes(exactPackBytes);
  } catch (error) {
    wrapBoundaryError(error, 'malformed CI evidence pack bytes');
  }

  let receipt: ReturnType<typeof buildCiEvidencePublicationReceipt>;
  try {
    receipt = buildCiEvidencePublicationReceipt({
      packBytes: exactPackBytes,
      facts: toPublicationReceiptFacts(admittedFacts),
    });
  } catch (error) {
    wrapBoundaryError(error, 'CI evidence publication receipt binding');
  }

  let publicationEvaluation: CiEvidencePublicationSummaryEvaluation;
  try {
    publicationEvaluation = evaluateCiEvidencePublicationSummary(
      pack,
      receipt,
      exactPackBytes,
      { audience: 'authenticated_reviewer' },
    );
  } catch (error) {
    wrapBoundaryError(error, 'CI evidence publication evaluation');
  }

  const reasons = collectGateReasons(pack, admittedFacts, publicationEvaluation);
  const evaluation: CiEvidenceGithubPublicationGateEvaluation = {
    status: reasons.length === 0 ? 'passed' : 'failed',
    reasons,
  };

  return { pack, receipt, evaluation };
}
