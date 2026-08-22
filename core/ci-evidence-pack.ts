const { readFileSync } = require('node:fs');

const { SCHEMAS, assertValidJson } = require('./schema-validator');

const CI_EVIDENCE_PACK_SCHEMA_VERSION = '1.0.0' as const;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type CiEvidencePackSchemaVersion = typeof CI_EVIDENCE_PACK_SCHEMA_VERSION;
export type CiEvidencePackPlatform = 'android' | 'ios';
export type CiEvidencePackSourceStatus = 'current' | 'stale' | 'missing' | 'mismatch';
export type CiEvidencePackAuthorityStatus = 'supported' | 'unsupported';
export type CiEvidencePackEvaluationStatus = 'passed' | 'failed' | 'not_evaluable';
export type CiEvidencePackAttemptStatus =
  | 'passed'
  | 'failed'
  | 'partial'
  | 'unsupported'
  | 'cancelled'
  | 'timed_out'
  | 'rejected'
  | 'incomplete';
export type CiEvidencePackArtifactKind =
  | 'recording'
  | 'screenshot'
  | 'log'
  | 'metrics'
  | 'health'
  | 'verdict'
  | 'comparison'
  | 'summary'
  | 'other';
export type CiEvidencePackArtifactState =
  | 'present'
  | 'missing'
  | 'invalid'
  | 'not_available'
  | 'rejected';
export type CiEvidencePackCompletenessStatus = 'complete' | 'incomplete';
export type CiEvidencePackAssemblyStatus = 'succeeded' | 'failed';
export type CiEvidencePackMechanismStatus = 'succeeded' | 'failed';
export type CiEvidencePackComparisonStatus = 'comparable' | 'not_evaluable' | 'not_available';
export type CiEvidencePackProductVerdictStatus =
  | 'passed'
  | 'failed'
  | 'inconclusive'
  | 'not_evaluated';
export type CiEvidencePackTwoPlatformClaimStatus = 'passed' | 'failed' | 'not_evaluable';
export type CiEvidencePackLiveProofSetStatus = 'passed' | 'failed';

class CiEvidencePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CiEvidencePackError';
  }
}

export interface CiEvidencePackSource {
  expectedSha: string;
  observedSha?: string;
  status: CiEvidencePackSourceStatus;
}

export interface CiEvidencePackLiveProofSet {
  relativePath: string;
  sha256: string;
  byteSize: number;
  runId: string;
  status: CiEvidencePackLiveProofSetStatus;
}

export interface CiEvidencePackPlatformRecord {
  platform: CiEvidencePackPlatform;
  authorityStatus: CiEvidencePackAuthorityStatus;
  evaluationStatus: CiEvidencePackEvaluationStatus;
  selectedAttemptId?: string;
}

export interface CiEvidencePackAttemptRecord {
  attemptId: string;
  platform: CiEvidencePackPlatform;
  scenarioId: string;
  runId: string;
  status: CiEvidencePackAttemptStatus;
  startedAt: string;
  endedAt?: string;
  predecessorAttemptId?: string;
  evidenceIds: string[];
}

export interface CiEvidencePackPresentEvidence {
  evidenceId: string;
  attemptId: string;
  platform: CiEvidencePackPlatform;
  kind: CiEvidencePackArtifactKind;
  status: 'present';
  relativePath: string;
  sha256: string;
  byteSize: number;
}

export interface CiEvidencePackNonPresentEvidence {
  evidenceId: string;
  attemptId: string;
  platform: CiEvidencePackPlatform;
  kind: CiEvidencePackArtifactKind;
  status: Exclude<CiEvidencePackArtifactState, 'present'>;
  reason: string;
}

export type CiEvidencePackEvidenceRecord =
  | CiEvidencePackPresentEvidence
  | CiEvidencePackNonPresentEvidence;

export interface CiEvidencePackVerdictPointer {
  scenarioId: string;
  runId: string;
  platform: CiEvidencePackPlatform;
  status: CiEvidencePackProductVerdictStatus;
  evidenceId: string;
}

export interface CiEvidencePackStatusReasons<TStatus extends string> {
  status: TStatus;
  reasons: string[];
}

export interface CiEvidencePack {
  schemaVersion: CiEvidencePackSchemaVersion;
  packId: string;
  createdAt: string;
  source: CiEvidencePackSource;
  liveProofSet: CiEvidencePackLiveProofSet;
  requiredPlatforms: CiEvidencePackPlatform[];
  requiredEvidenceKinds: CiEvidencePackArtifactKind[];
  platforms: CiEvidencePackPlatformRecord[];
  attempts: CiEvidencePackAttemptRecord[];
  evidence: CiEvidencePackEvidenceRecord[];
  verdicts: CiEvidencePackVerdictPointer[];
  comparisonStatus: CiEvidencePackComparisonStatus;
  completeness: CiEvidencePackStatusReasons<CiEvidencePackCompletenessStatus>;
  assembly: CiEvidencePackStatusReasons<CiEvidencePackAssemblyStatus>;
  mechanismStatus: CiEvidencePackMechanismStatus;
  twoPlatformClaim: CiEvidencePackStatusReasons<CiEvidencePackTwoPlatformClaimStatus>;
  summary: string;
  nextAction: string;
}

export type CiEvidencePackBuildInput = Omit<CiEvidencePack, 'mechanismStatus' | 'twoPlatformClaim'>;

type InventoryMaps = {
  platformsById: Map<CiEvidencePackPlatform, CiEvidencePackPlatformRecord>;
  attemptsById: Map<string, CiEvidencePackAttemptRecord>;
  evidenceById: Map<string, CiEvidencePackEvidenceRecord>;
};

type PlatformClaimContribution =
  | { kind: 'passed' }
  | { kind: 'failed'; reasons: string[] }
  | { kind: 'not_evaluable'; reasons: string[] };

function assertCiEvidencePackRunRelativePath(pathValue: string): void {
  if (pathValue.length === 0) {
    throw new CiEvidencePackError('run-relative path must be nonempty');
  }
  if (pathValue.startsWith('/') || pathValue.startsWith('\\')) {
    throw new CiEvidencePackError(`run-relative path must not be absolute: ${pathValue}`);
  }
  if (pathValue.includes('\\')) {
    throw new CiEvidencePackError(`run-relative path must be POSIX without backslash: ${pathValue}`);
  }
  if (/^[A-Za-z]:/.test(pathValue)) {
    throw new CiEvidencePackError(`run-relative path must not be drive-qualified: ${pathValue}`);
  }
  const segments = pathValue.split('/');
  if (segments.some((segment) => segment === '..' || segment.length === 0)) {
    throw new CiEvidencePackError(
      `run-relative path must not traverse or be empty-segmented: ${pathValue}`,
    );
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new CiEvidencePackError(`${label} must be lowercase 64-hex SHA-256`);
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(value).toISOString() !== value) {
    throw new CiEvidencePackError(`${label} must be a canonical ISO-8601 instant`);
  }
}

function assertSourceSha(value: string, label: string): void {
  if (!SOURCE_SHA_PATTERN.test(value)) {
    throw new CiEvidencePackError(`${label} must be lowercase 40-64 hex`);
  }
}

function uniqueOrThrow<T>(values: T[], label: string): void {
  if (new Set(values.map((value) => String(value))).size !== values.length) {
    throw new CiEvidencePackError(`duplicate ${label}`);
  }
}

function cloneSource(source: CiEvidencePackSource): CiEvidencePackSource {
  const cloned: CiEvidencePackSource = {
    expectedSha: source.expectedSha,
    status: source.status,
  };
  if (source.observedSha !== undefined) {
    cloned.observedSha = source.observedSha;
  }
  return cloned;
}

function clonePlatformRecord(record: CiEvidencePackPlatformRecord): CiEvidencePackPlatformRecord {
  const cloned: CiEvidencePackPlatformRecord = {
    platform: record.platform,
    authorityStatus: record.authorityStatus,
    evaluationStatus: record.evaluationStatus,
  };
  if (record.selectedAttemptId !== undefined) {
    cloned.selectedAttemptId = record.selectedAttemptId;
  }
  return cloned;
}

function cloneAttemptRecord(record: CiEvidencePackAttemptRecord): CiEvidencePackAttemptRecord {
  const cloned: CiEvidencePackAttemptRecord = {
    attemptId: record.attemptId,
    platform: record.platform,
    scenarioId: record.scenarioId,
    runId: record.runId,
    status: record.status,
    startedAt: record.startedAt,
    evidenceIds: [...record.evidenceIds],
  };
  if (record.endedAt !== undefined) {
    cloned.endedAt = record.endedAt;
  }
  if (record.predecessorAttemptId !== undefined) {
    cloned.predecessorAttemptId = record.predecessorAttemptId;
  }
  return cloned;
}

function cloneEvidenceRecord(record: CiEvidencePackEvidenceRecord): CiEvidencePackEvidenceRecord {
  if (record.status === 'present') {
    return {
      evidenceId: record.evidenceId,
      attemptId: record.attemptId,
      platform: record.platform,
      kind: record.kind,
      status: 'present',
      relativePath: record.relativePath,
      sha256: record.sha256,
      byteSize: record.byteSize,
    };
  }
  return {
    evidenceId: record.evidenceId,
    attemptId: record.attemptId,
    platform: record.platform,
    kind: record.kind,
    status: record.status,
    reason: record.reason,
  };
}

function toBuildInput(artifact: CiEvidencePackBuildInput): CiEvidencePackBuildInput {
  return {
    schemaVersion: artifact.schemaVersion,
    packId: artifact.packId,
    createdAt: artifact.createdAt,
    source: cloneSource(artifact.source),
    liveProofSet: { ...artifact.liveProofSet },
    requiredPlatforms: [...artifact.requiredPlatforms],
    requiredEvidenceKinds: [...artifact.requiredEvidenceKinds],
    platforms: artifact.platforms.map(clonePlatformRecord),
    attempts: artifact.attempts.map(cloneAttemptRecord),
    evidence: artifact.evidence.map(cloneEvidenceRecord),
    verdicts: artifact.verdicts.map((verdict) => ({ ...verdict })),
    comparisonStatus: artifact.comparisonStatus,
    completeness: {
      status: artifact.completeness.status,
      reasons: [...artifact.completeness.reasons],
    },
    assembly: {
      status: artifact.assembly.status,
      reasons: [...artifact.assembly.reasons],
    },
    summary: artifact.summary,
    nextAction: artifact.nextAction,
  };
}

function inventoryMaps(artifact: CiEvidencePackBuildInput): InventoryMaps {
  uniqueOrThrow(
    artifact.platforms.map((record) => record.platform),
    'platform',
  );
  uniqueOrThrow(
    artifact.attempts.map((record) => record.attemptId),
    'attemptId',
  );
  uniqueOrThrow(
    artifact.evidence.map((record) => record.evidenceId),
    'evidenceId',
  );
  uniqueOrThrow(artifact.requiredPlatforms, 'requiredPlatform');
  uniqueOrThrow(artifact.requiredEvidenceKinds, 'requiredEvidenceKind');

  return {
    platformsById: new Map(artifact.platforms.map((record) => [record.platform, record])),
    attemptsById: new Map(artifact.attempts.map((record) => [record.attemptId, record])),
    evidenceById: new Map(artifact.evidence.map((record) => [record.evidenceId, record])),
  };
}

function assertSourceSemantics(source: CiEvidencePackSource): void {
  assertSourceSha(source.expectedSha, 'expectedSha');
  if (source.observedSha !== undefined) {
    assertSourceSha(source.observedSha, 'observedSha');
  }
  const observedEqualsExpected =
    source.observedSha !== undefined && source.observedSha === source.expectedSha;
  if (observedEqualsExpected && source.status !== 'current') {
    throw new CiEvidencePackError('equal expected and observed SHA must be marked current');
  }
  if (source.status === 'current') {
    if (source.observedSha === undefined || source.observedSha !== source.expectedSha) {
      throw new CiEvidencePackError('current source requires observedSha equal to expectedSha');
    }
  }
}

function assertInventoryCoherence(artifact: CiEvidencePackBuildInput): void {
  if (artifact.schemaVersion !== CI_EVIDENCE_PACK_SCHEMA_VERSION) {
    throw new CiEvidencePackError('unsupported schemaVersion');
  }
  if (artifact.requiredPlatforms.length === 0) {
    throw new CiEvidencePackError('requiredPlatforms must be nonempty');
  }
  if (artifact.requiredEvidenceKinds.length === 0) {
    throw new CiEvidencePackError('requiredEvidenceKinds must be nonempty');
  }

  assertSourceSemantics(artifact.source);
  assertIsoTimestamp(artifact.createdAt, 'createdAt');
  assertCiEvidencePackRunRelativePath(artifact.liveProofSet.relativePath);
  assertSha256(artifact.liveProofSet.sha256, 'liveProofSet.sha256');

  const { attemptsById, evidenceById } = inventoryMaps(artifact);

  for (const platformRecord of artifact.platforms) {
    if (platformRecord.selectedAttemptId === undefined) {
      continue;
    }
    const selected = attemptsById.get(platformRecord.selectedAttemptId);
    if (selected === undefined) {
      throw new CiEvidencePackError(
        `platform ${platformRecord.platform} references unknown selectedAttemptId`,
      );
    }
    if (selected.platform !== platformRecord.platform) {
      throw new CiEvidencePackError(
        `selected attempt ${selected.attemptId} does not belong to ${platformRecord.platform}`,
      );
    }
  }

  for (const attempt of artifact.attempts) {
    assertIsoTimestamp(attempt.startedAt, `attempt ${attempt.attemptId} startedAt`);
    if (attempt.endedAt !== undefined) {
      assertIsoTimestamp(attempt.endedAt, `attempt ${attempt.attemptId} endedAt`);
      if (Date.parse(attempt.endedAt) < Date.parse(attempt.startedAt)) {
        throw new CiEvidencePackError(
          `attempt ${attempt.attemptId} endedAt must not precede startedAt`,
        );
      }
    }
    uniqueOrThrow(attempt.evidenceIds, `evidenceIds for ${attempt.attemptId}`);
    if (attempt.predecessorAttemptId !== undefined) {
      if (attempt.predecessorAttemptId === attempt.attemptId) {
        throw new CiEvidencePackError(`attempt ${attempt.attemptId} cannot precede itself`);
      }
      if (!attemptsById.has(attempt.predecessorAttemptId)) {
        throw new CiEvidencePackError(`attempt ${attempt.attemptId} references unknown predecessor`);
      }
    }
    for (const evidenceId of attempt.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence === undefined) {
        throw new CiEvidencePackError(
          `attempt ${attempt.attemptId} references unknown evidence ${evidenceId}`,
        );
      }
      if (evidence.attemptId !== attempt.attemptId) {
        throw new CiEvidencePackError(
          `attempt ${attempt.attemptId} references evidence owned by another attempt`,
        );
      }
      if (evidence.platform !== attempt.platform) {
        throw new CiEvidencePackError(`attempt ${attempt.attemptId} evidence platform mismatch`);
      }
    }
  }

  for (const evidence of artifact.evidence) {
    const attempt = attemptsById.get(evidence.attemptId);
    if (attempt === undefined) {
      throw new CiEvidencePackError(`evidence ${evidence.evidenceId} references unknown attempt`);
    }
    if (attempt.platform !== evidence.platform) {
      throw new CiEvidencePackError(
        `evidence ${evidence.evidenceId} platform does not match attempt`,
      );
    }
    if (!attempt.evidenceIds.includes(evidence.evidenceId)) {
      throw new CiEvidencePackError(
        `evidence ${evidence.evidenceId} is not listed on its attempt`,
      );
    }
    if (evidence.status === 'present') {
      assertCiEvidencePackRunRelativePath(evidence.relativePath);
      assertSha256(evidence.sha256, `evidence ${evidence.evidenceId} sha256`);
    }
  }

  for (const verdict of artifact.verdicts) {
    const evidence = evidenceById.get(verdict.evidenceId);
    if (evidence === undefined) {
      throw new CiEvidencePackError(`verdict references unknown evidence ${verdict.evidenceId}`);
    }
    if (evidence.status !== 'present' || evidence.kind !== 'verdict') {
      throw new CiEvidencePackError(
        `verdict ${verdict.evidenceId} must point at present verdict evidence`,
      );
    }
    if (evidence.platform !== verdict.platform) {
      throw new CiEvidencePackError('verdict platform does not match evidence');
    }
    const attempt = attemptsById.get(evidence.attemptId);
    if (attempt === undefined || attempt.runId !== verdict.runId) {
      throw new CiEvidencePackError('verdict runId does not match attempt');
    }
    if (attempt.scenarioId !== verdict.scenarioId) {
      throw new CiEvidencePackError('verdict scenarioId does not match attempt');
    }
  }
}

function selectedAttemptForPlatform(
  input: CiEvidencePackBuildInput,
  platform: CiEvidencePackPlatform,
): CiEvidencePackAttemptRecord | undefined {
  const record = input.platforms.find((item) => item.platform === platform);
  if (record?.selectedAttemptId === undefined) {
    return undefined;
  }
  return input.attempts.find((attempt) => attempt.attemptId === record.selectedAttemptId);
}

function verdictForAttempt(
  input: CiEvidencePackBuildInput,
  attempt: CiEvidencePackAttemptRecord,
): CiEvidencePackVerdictPointer | undefined {
  return input.verdicts.find(
    (verdict) =>
      verdict.platform === attempt.platform &&
      verdict.runId === attempt.runId &&
      verdict.scenarioId === attempt.scenarioId,
  );
}

function combinePlatformContribution(
  failedReasons: string[],
  notEvaluableReasons: string[],
): PlatformClaimContribution {
  if (failedReasons.length > 0) {
    return { kind: 'failed', reasons: [...failedReasons, ...notEvaluableReasons] };
  }
  if (notEvaluableReasons.length > 0) {
    return { kind: 'not_evaluable', reasons: notEvaluableReasons };
  }
  return { kind: 'passed' };
}

function classifySelectedAttempt(
  attempt: CiEvidencePackAttemptRecord,
): PlatformClaimContribution {
  switch (attempt.status) {
    case 'passed':
      return { kind: 'passed' };
    case 'unsupported':
      return {
        kind: 'not_evaluable',
        reasons: [`selected attempt ${attempt.attemptId} is unsupported`],
      };
    case 'failed':
    case 'partial':
    case 'cancelled':
    case 'timed_out':
    case 'rejected':
    case 'incomplete':
      return {
        kind: 'failed',
        reasons: [`selected attempt ${attempt.attemptId} is ${attempt.status}`],
      };
    default: {
      const exhaustive: never = attempt.status;
      return { kind: 'failed', reasons: [`selected attempt has unknown status ${exhaustive}`] };
    }
  }
}

function classifyRequiredEvidence(
  input: CiEvidencePackBuildInput,
  attempt: CiEvidencePackAttemptRecord,
): PlatformClaimContribution {
  const failedReasons: string[] = [];
  const notEvaluableReasons: string[] = [];

  for (const kind of input.requiredEvidenceKinds) {
    const match = input.evidence.find(
      (evidence) => evidence.attemptId === attempt.attemptId && evidence.kind === kind,
    );
    if (
      match === undefined ||
      match.status === 'missing' ||
      match.status === 'invalid' ||
      match.status === 'rejected'
    ) {
      failedReasons.push(
        `required ${kind} evidence missing/invalid/rejected for ${attempt.attemptId}`,
      );
      continue;
    }
    if (match.status !== 'present') {
      notEvaluableReasons.push(
        `required ${kind} evidence is ${match.status} for ${attempt.attemptId}`,
      );
    }
  }

  return combinePlatformContribution(failedReasons, notEvaluableReasons);
}

function classifyProductVerdict(
  input: CiEvidencePackBuildInput,
  attempt: CiEvidencePackAttemptRecord,
): PlatformClaimContribution {
  const verdict = verdictForAttempt(input, attempt);
  if (verdict === undefined) {
    return {
      kind: 'not_evaluable',
      reasons: [`no verdict pointer for selected attempt ${attempt.attemptId}`],
    };
  }
  switch (verdict.status) {
    case 'passed':
      return { kind: 'passed' };
    case 'failed':
      return { kind: 'failed', reasons: [`product verdict failed for ${attempt.platform}`] };
    case 'inconclusive':
    case 'not_evaluated':
      return {
        kind: 'not_evaluable',
        reasons: [`product verdict ${verdict.status} for ${attempt.platform}`],
      };
    default: {
      const exhaustive: never = verdict.status;
      return { kind: 'failed', reasons: [`product verdict has unknown status ${exhaustive}`] };
    }
  }
}

function mergeContributions(contributions: PlatformClaimContribution[]): PlatformClaimContribution {
  const failedReasons: string[] = [];
  const notEvaluableReasons: string[] = [];
  for (const contribution of contributions) {
    if (contribution.kind === 'failed') {
      failedReasons.push(...contribution.reasons);
    } else if (contribution.kind === 'not_evaluable') {
      notEvaluableReasons.push(...contribution.reasons);
    }
  }
  return combinePlatformContribution(failedReasons, notEvaluableReasons);
}

function evaluateRequiredPlatformClaim(
  input: CiEvidencePackBuildInput,
  platform: CiEvidencePackPlatform,
): PlatformClaimContribution {
  const record = input.platforms.find((item) => item.platform === platform);
  if (record === undefined) {
    return { kind: 'failed', reasons: [`missing required platform record: ${platform}`] };
  }

  const contributions: PlatformClaimContribution[] = [];
  if (record.authorityStatus === 'unsupported') {
    contributions.push({
      kind: 'not_evaluable',
      reasons: [`${platform} authority is unsupported`],
    });
  }
  if (record.evaluationStatus === 'failed') {
    contributions.push({ kind: 'failed', reasons: [`${platform} evaluation failed`] });
  } else if (record.evaluationStatus === 'not_evaluable') {
    contributions.push({
      kind: 'not_evaluable',
      reasons: [`${platform} evaluation is not_evaluable`],
    });
  }

  const attempt = selectedAttemptForPlatform(input, platform);
  if (attempt === undefined) {
    contributions.push({
      kind: 'not_evaluable',
      reasons: [`${platform} has no selected attempt`],
    });
    return mergeContributions(contributions);
  }

  contributions.push(classifySelectedAttempt(attempt));
  contributions.push(classifyRequiredEvidence(input, attempt));
  contributions.push(classifyProductVerdict(input, attempt));

  const combined = mergeContributions(contributions);
  if (combined.kind !== 'passed') {
    return combined;
  }
  if (
    record.authorityStatus !== 'supported' ||
    record.evaluationStatus !== 'passed' ||
    attempt.status !== 'passed'
  ) {
    return {
      kind: 'not_evaluable',
      reasons: [`${platform} is not a passed supported evaluation`],
    };
  }
  return { kind: 'passed' };
}

function deriveCiEvidencePackMechanismStatus(
  input: CiEvidencePackBuildInput,
): CiEvidencePackMechanismStatus {
  try {
    assertInventoryCoherence(input);
  } catch (error) {
    if (error instanceof CiEvidencePackError) {
      return 'failed';
    }
    throw error;
  }
  if (input.assembly.status !== 'succeeded') {
    return 'failed';
  }
  return 'succeeded';
}

function deriveCiEvidencePackTwoPlatformClaim(
  input: CiEvidencePackBuildInput,
): CiEvidencePackStatusReasons<CiEvidencePackTwoPlatformClaimStatus> {
  const contributions: PlatformClaimContribution[] = [];
  const requiredSet = new Set(input.requiredPlatforms);
  const hasAndroidAndIos =
    requiredSet.has('android') && requiredSet.has('ios') && requiredSet.size === 2;
  if (!hasAndroidAndIos) {
    contributions.push({
      kind: 'not_evaluable',
      reasons: ['requiredPlatforms must be exactly android and ios'],
    });
  }

  if (input.source.status !== 'current') {
    contributions.push({ kind: 'failed', reasons: [`source is ${input.source.status}`] });
  } else if (input.source.observedSha !== input.source.expectedSha) {
    contributions.push({
      kind: 'failed',
      reasons: ['source observedSha does not equal expectedSha'],
    });
  }

  if (input.liveProofSet.status === 'failed') {
    contributions.push({ kind: 'failed', reasons: ['liveProofSet failed'] });
  }
  if (input.completeness.status === 'incomplete') {
    contributions.push({ kind: 'failed', reasons: ['completeness is incomplete'] });
  }
  if (input.assembly.status === 'failed') {
    contributions.push({ kind: 'failed', reasons: ['assembly failed'] });
  }

  for (const platform of input.requiredPlatforms) {
    contributions.push(evaluateRequiredPlatformClaim(input, platform));
  }

  const combined = mergeContributions(contributions);
  if (combined.kind === 'failed') {
    return { status: 'failed', reasons: combined.reasons };
  }
  if (combined.kind === 'not_evaluable') {
    return { status: 'not_evaluable', reasons: combined.reasons };
  }
  return { status: 'passed', reasons: [] };
}

function assertCiEvidencePackSemantics(artifact: CiEvidencePack): void {
  const input = toBuildInput(artifact);
  assertInventoryCoherence(input);
  const mechanismStatus = deriveCiEvidencePackMechanismStatus(input);
  const twoPlatformClaim = deriveCiEvidencePackTwoPlatformClaim(input);
  if (artifact.mechanismStatus !== mechanismStatus) {
    throw new CiEvidencePackError('mechanismStatus does not match derivation');
  }
  if (
    artifact.twoPlatformClaim.status !== twoPlatformClaim.status ||
    JSON.stringify(artifact.twoPlatformClaim.reasons) !== JSON.stringify(twoPlatformClaim.reasons)
  ) {
    throw new CiEvidencePackError('twoPlatformClaim does not match derivation');
  }
}

function buildCiEvidencePack(input: CiEvidencePackBuildInput): CiEvidencePack {
  const normalized = toBuildInput(input);
  assertInventoryCoherence(normalized);
  const artifact: CiEvidencePack = {
    ...normalized,
    mechanismStatus: deriveCiEvidencePackMechanismStatus(normalized),
    twoPlatformClaim: deriveCiEvidencePackTwoPlatformClaim(normalized),
  };
  assertValidJson(artifact, SCHEMAS.ciEvidencePack, 'ci-evidence-pack');
  assertCiEvidencePackSemantics(artifact);
  return artifact;
}

function readCiEvidencePack(filePath: string): CiEvidencePack {
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  const artifact = assertValidJson(raw, SCHEMAS.ciEvidencePack, 'ci-evidence-pack') as CiEvidencePack;
  assertCiEvidencePackSemantics(artifact);
  return artifact;
}

export {
  CI_EVIDENCE_PACK_SCHEMA_VERSION,
  CiEvidencePackError,
  assertCiEvidencePackRunRelativePath,
  assertCiEvidencePackSemantics,
  buildCiEvidencePack,
  deriveCiEvidencePackMechanismStatus,
  deriveCiEvidencePackTwoPlatformClaim,
  readCiEvidencePack,
};
