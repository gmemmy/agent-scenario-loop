const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

const {
  assertCiEvidencePackRunRelativePath,
  assertCiEvidencePackSemantics,
} = require('./ci-evidence-pack');
const { SCHEMAS, assertValidJson } = require('./schema-validator');
import type { JsonSchema } from './schema-validator';
import type {
  CiEvidencePack,
  CiEvidencePackArtifactKind,
  CiEvidencePackAssemblyStatus,
  CiEvidencePackComparisonStatus,
  CiEvidencePackCompletenessStatus,
  CiEvidencePackMechanismStatus,
  CiEvidencePackPlatform,
  CiEvidencePackSource,
  CiEvidencePackTwoPlatformClaimStatus,
} from './ci-evidence-pack';

const CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION = '1.0.0' as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type CiEvidencePublicationReceiptSchemaVersion =
  typeof CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION;
export type CiEvidencePublicationProviderKind = 'ci_workflow' | 'local' | 'unspecified';
export type CiEvidencePublicationPackArtifact = 'ci_evidence_pack' | 'live_proof_set';
export type CiEvidencePublicationTargetKind = 'pack_artifact' | 'evidence';
export type CiEvidencePublicationVisibility = 'public' | 'restricted';
export type CiEvidencePublicationPublishedStatus = 'published';
export type CiEvidencePublicationNonPublishedStatus =
  | 'omitted'
  | 'rejected'
  | 'private'
  | 'not_available'
  | 'failed'
  | 'invalid';
export type CiEvidencePublicationItemStatus =
  | CiEvidencePublicationPublishedStatus
  | CiEvidencePublicationNonPublishedStatus;
export type CiEvidencePublicationStatus = 'published' | 'partial' | 'failed' | 'not_published';

class CiEvidencePublicationReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CiEvidencePublicationReceiptError';
  }
}

export interface CiEvidencePublicationPublisher {
  providerId: string;
  providerKind: CiEvidencePublicationProviderKind;
  runId: string;
  workflowId?: string;
  jobId?: string;
  attemptNumber: number;
}

export interface CiEvidencePublicationPackBinding {
  packId: string;
  schemaVersion: '1.0.0';
  sha256: string;
  byteSize: number;
  packRelativePath: string;
  source: CiEvidencePackSource;
  liveProofSet: {
    relativePath: string;
    sha256: string;
    byteSize: number;
    runId: string;
    status: 'passed' | 'failed';
  };
  requiredPlatforms: CiEvidencePackPlatform[];
  requiredEvidenceKinds: CiEvidencePackArtifactKind[];
  mechanismStatus: CiEvidencePackMechanismStatus;
  twoPlatformClaim: {
    status: CiEvidencePackTwoPlatformClaimStatus;
    reasons: string[];
  };
  comparisonStatus: CiEvidencePackComparisonStatus;
  completeness: {
    status: CiEvidencePackCompletenessStatus;
    reasons: string[];
  };
  assembly: {
    status: CiEvidencePackAssemblyStatus;
    reasons: string[];
  };
}

export interface CiEvidencePublicationPackArtifactTarget {
  requestId: string;
  targetKind: 'pack_artifact';
  packArtifact: CiEvidencePublicationPackArtifact;
}

export interface CiEvidencePublicationEvidenceTarget {
  requestId: string;
  targetKind: 'evidence';
  evidenceId: string;
}

export type CiEvidencePublicationRequestedItem =
  | CiEvidencePublicationPackArtifactTarget
  | CiEvidencePublicationEvidenceTarget;

export interface CiEvidencePublicationPublishedOutcome {
  requestId: string;
  status: 'published';
  url: string;
  visibility: CiEvidencePublicationVisibility;
  publishedAt: string;
}

export interface CiEvidencePublicationNonPublishedOutcome {
  requestId: string;
  status: CiEvidencePublicationNonPublishedStatus;
  reason: string;
}

export type CiEvidencePublicationItemOutcome =
  | CiEvidencePublicationPublishedOutcome
  | CiEvidencePublicationNonPublishedOutcome;

export interface CiEvidencePublicationReceiptFacts {
  receiptId: string;
  createdAt: string;
  packRelativePath: string;
  publisher: CiEvidencePublicationPublisher;
  requestedItems: CiEvidencePublicationRequestedItem[];
  outcomes: CiEvidencePublicationItemOutcome[];
}

export interface CiEvidencePublicationReceiptBuildInput {
  packBytes: Uint8Array;
  facts: CiEvidencePublicationReceiptFacts;
}

export interface CiEvidencePublicationReceipt {
  schemaVersion: CiEvidencePublicationReceiptSchemaVersion;
  receiptId: string;
  createdAt: string;
  publisher: CiEvidencePublicationPublisher;
  pack: CiEvidencePublicationPackBinding;
  requestedItems: CiEvidencePublicationRequestedItem[];
  outcomes: CiEvidencePublicationItemOutcome[];
  publicationStatus: CiEvidencePublicationStatus;
  reasons: string[];
  summary: string;
  nextAction: string;
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

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FACTS_OWN_KEYS = [
  'receiptId',
  'createdAt',
  'packRelativePath',
  'publisher',
  'requestedItems',
  'outcomes',
] as const;
const PUBLISHER_REQUIRED_KEYS = ['providerId', 'providerKind', 'runId', 'attemptNumber'] as const;
const PUBLISHER_OPTIONAL_KEYS = ['workflowId', 'jobId'] as const;
const UNSAFE_URL_CHAR_PATTERN = /[\u0000-\u0020\u007F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const MARKDOWN_UNSAFE_URL_CHAR_PATTERN = /[()[\]<>"'`|]/;

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!jsonValuesEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) {
      return false;
    }
  }
  for (const key of leftKeys) {
    if (!jsonValuesEqual(leftRecord[key], rightRecord[key])) {
      return false;
    }
  }
  return true;
}

function assertOwnKeys(value: object, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new CiEvidencePublicationReceiptError(`unknown field ${key}`);
    }
  }
}

function admitJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) {
    throw new CiEvidencePublicationReceiptError('facts must not contain undefined');
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new CiEvidencePublicationReceiptError('facts must be closed plain JSON');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new CiEvidencePublicationReceiptError('facts must not contain non-finite numbers');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    throw new CiEvidencePublicationReceiptError('facts must not contain cycles');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new CiEvidencePublicationReceiptError('facts arrays must be plain arrays');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CiEvidencePublicationReceiptError('facts must not contain symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new CiEvidencePublicationReceiptError('facts must not contain symbol keys');
      }
      if (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) {
        throw new CiEvidencePublicationReceiptError('facts arrays must not have non-index properties');
      }
    }
    const cloned: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined) {
        throw new CiEvidencePublicationReceiptError('facts arrays must not be sparse');
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new CiEvidencePublicationReceiptError('facts must not contain accessors');
      }
      if (!descriptor.enumerable) {
        throw new CiEvidencePublicationReceiptError('facts array indices must be enumerable');
      }
      cloned.push(admitJsonValue(descriptor.value, seen));
    }
    return cloned;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CiEvidencePublicationReceiptError('facts objects must be closed plain JSON objects');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CiEvidencePublicationReceiptError('facts must not contain symbol keys');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new CiEvidencePublicationReceiptError(`facts must not contain ${key}`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      throw new CiEvidencePublicationReceiptError(`facts missing descriptor for ${key}`);
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new CiEvidencePublicationReceiptError('facts must not contain accessors');
    }
    if (!descriptor.enumerable) {
      throw new CiEvidencePublicationReceiptError('facts must not contain non-enumerable fields');
    }
    cloned[key] = admitJsonValue(descriptor.value, seen);
  }
  return cloned;
}

function cloneFacts(facts: CiEvidencePublicationReceiptFacts): CiEvidencePublicationReceiptFacts {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new CiEvidencePublicationReceiptError('facts must be a closed plain JSON object');
  }
  let admitted: Record<string, unknown>;
  try {
    admitted = admitJsonValue(facts, new WeakSet()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CiEvidencePublicationReceiptError) {
      throw error;
    }
    throw new CiEvidencePublicationReceiptError('facts must be closed plain JSON');
  }
  assertOwnKeys(admitted, FACTS_OWN_KEYS);
  for (const key of FACTS_OWN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(admitted, key)) {
      throw new CiEvidencePublicationReceiptError(`facts missing ${key}`);
    }
  }

  const publisher = admitted.publisher;
  if (publisher === null || typeof publisher !== 'object' || Array.isArray(publisher)) {
    throw new CiEvidencePublicationReceiptError('publisher must be a closed plain JSON object');
  }
  assertOwnKeys(publisher, [...PUBLISHER_REQUIRED_KEYS, ...PUBLISHER_OPTIONAL_KEYS]);

  const requestedItems = admitted.requestedItems;
  if (!Array.isArray(requestedItems)) {
    throw new CiEvidencePublicationReceiptError('requestedItems must be an array');
  }
  for (const item of requestedItems) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CiEvidencePublicationReceiptError('requested item must be a closed plain JSON object');
    }
    const record = item as Record<string, unknown>;
    if (record.targetKind === 'pack_artifact') {
      assertOwnKeys(record, ['requestId', 'targetKind', 'packArtifact']);
    } else if (record.targetKind === 'evidence') {
      assertOwnKeys(record, ['requestId', 'targetKind', 'evidenceId']);
    } else {
      throw new CiEvidencePublicationReceiptError('targetKind is unsupported');
    }
  }

  const outcomes = admitted.outcomes;
  if (!Array.isArray(outcomes)) {
    throw new CiEvidencePublicationReceiptError('outcomes must be an array');
  }
  for (const outcome of outcomes) {
    if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) {
      throw new CiEvidencePublicationReceiptError('outcome must be a closed plain JSON object');
    }
    const record = outcome as Record<string, unknown>;
    if (record.status === 'published') {
      assertOwnKeys(record, ['requestId', 'status', 'url', 'visibility', 'publishedAt']);
    } else {
      assertOwnKeys(record, ['requestId', 'status', 'reason']);
    }
  }

  return admitted as unknown as CiEvidencePublicationReceiptFacts;
}

function assertNonemptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CiEvidencePublicationReceiptError(`${label} must be a nonempty string`);
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(value).toISOString() !== value) {
    throw new CiEvidencePublicationReceiptError(`${label} must be a canonical ISO-8601 instant`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new CiEvidencePublicationReceiptError(`${label} must be a positive integer`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new CiEvidencePublicationReceiptError(`${label} must be lowercase 64-hex SHA-256`);
  }
}

function assertRunRelativePath(pathValue: string): void {
  try {
    assertCiEvidencePackRunRelativePath(pathValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePublicationReceiptError(message);
  }
}

function wrapSchemaValidation<T>(value: unknown, schema: JsonSchema, label: string): T {
  try {
    return assertValidJson(value, schema, label) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePublicationReceiptError(message);
  }
}

function hashExactBytes(bytes: Uint8Array): { sha256: string; byteSize: number } {
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
  };
}

function parsePackBytes(packBytes: Uint8Array): CiEvidencePack {
  if (!(packBytes instanceof Uint8Array)) {
    throw new CiEvidencePublicationReceiptError('packBytes must be a Uint8Array');
  }
  if (packBytes.byteLength < 1) {
    throw new CiEvidencePublicationReceiptError('packBytes must be nonempty');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(packBytes);
  } catch {
    throw new CiEvidencePublicationReceiptError('packBytes must be valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CiEvidencePublicationReceiptError('packBytes must be valid JSON');
  }
  let pack: CiEvidencePack;
  try {
    pack = wrapSchemaValidation<CiEvidencePack>(parsed, SCHEMAS.ciEvidencePack, 'ci-evidence-pack');
    assertCiEvidencePackSemantics(pack);
  } catch (error) {
    if (error instanceof CiEvidencePublicationReceiptError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePublicationReceiptError(`packBytes failed pack validation: ${message}`);
  }
  return pack;
}

function assertHttpsUrl(urlValue: string, label: string): void {
  assertNonemptyString(urlValue, label);
  if (UNSAFE_URL_CHAR_PATTERN.test(urlValue) || MARKDOWN_UNSAFE_URL_CHAR_PATTERN.test(urlValue)) {
    throw new CiEvidencePublicationReceiptError(
      `${label} must not contain control, bidi, whitespace, or markdown-unsafe characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new CiEvidencePublicationReceiptError(`${label} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new CiEvidencePublicationReceiptError(`${label} must use https`);
  }
  if (parsed.hostname.length < 1) {
    throw new CiEvidencePublicationReceiptError(`${label} must include a nonempty host`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CiEvidencePublicationReceiptError(`${label} must not include credentials`);
  }
}

function targetIdentity(item: CiEvidencePublicationRequestedItem): string {
  if (item.targetKind === 'pack_artifact') {
    return `pack_artifact:${item.packArtifact}`;
  }
  return `evidence:${item.evidenceId}`;
}

function uniqueOrThrow(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new CiEvidencePublicationReceiptError(`duplicate ${label}`);
  }
}

function assertPublisher(publisher: CiEvidencePublicationPublisher): void {
  assertNonemptyString(publisher.providerId, 'publisher.providerId');
  if (
    publisher.providerKind !== 'ci_workflow' &&
    publisher.providerKind !== 'local' &&
    publisher.providerKind !== 'unspecified'
  ) {
    throw new CiEvidencePublicationReceiptError('publisher.providerKind is unsupported');
  }
  assertNonemptyString(publisher.runId, 'publisher.runId');
  if (publisher.workflowId !== undefined) {
    assertNonemptyString(publisher.workflowId, 'publisher.workflowId');
  }
  if (publisher.jobId !== undefined) {
    assertNonemptyString(publisher.jobId, 'publisher.jobId');
  }
  assertPositiveInteger(publisher.attemptNumber, 'publisher.attemptNumber');
}

function assertRequestedItems(
  items: readonly CiEvidencePublicationRequestedItem[],
  pack: CiEvidencePack,
): void {
  uniqueOrThrow(
    items.map((item) => item.requestId),
    'requestId',
  );
  uniqueOrThrow(
    items.map((item) => targetIdentity(item)),
    'publication target',
  );

  const evidenceById = new Map(pack.evidence.map((record) => [record.evidenceId, record]));
  for (const item of items) {
    assertNonemptyString(item.requestId, 'requestId');
    if (item.targetKind === 'pack_artifact') {
      if (item.packArtifact !== 'ci_evidence_pack' && item.packArtifact !== 'live_proof_set') {
        throw new CiEvidencePublicationReceiptError('packArtifact is unsupported');
      }
      continue;
    }
    if (item.targetKind !== 'evidence') {
      throw new CiEvidencePublicationReceiptError('targetKind is unsupported');
    }
    assertNonemptyString(item.evidenceId, 'evidenceId');
    if (!evidenceById.has(item.evidenceId)) {
      throw new CiEvidencePublicationReceiptError(`unknown evidenceId ${item.evidenceId}`);
    }
  }
}

function assertOutcomes(
  items: readonly CiEvidencePublicationRequestedItem[],
  outcomes: readonly CiEvidencePublicationItemOutcome[],
  pack: CiEvidencePack,
): void {
  uniqueOrThrow(
    outcomes.map((outcome) => outcome.requestId),
    'outcome requestId',
  );
  const itemsById = new Map(items.map((item) => [item.requestId, item]));
  if (outcomes.length !== items.length) {
    throw new CiEvidencePublicationReceiptError('outcomes must cover every requested item exactly once');
  }
  const evidenceById = new Map(pack.evidence.map((record) => [record.evidenceId, record]));

  for (const outcome of outcomes) {
    const item = itemsById.get(outcome.requestId);
    if (item === undefined) {
      throw new CiEvidencePublicationReceiptError(`outcome references unknown requestId ${outcome.requestId}`);
    }
    if (outcome.status === 'published') {
      assertOwnKeys(outcome, ['requestId', 'status', 'url', 'visibility', 'publishedAt']);
      if ('reason' in outcome && (outcome as { reason?: unknown }).reason !== undefined) {
        throw new CiEvidencePublicationReceiptError('published outcome must not include reason');
      }
      assertHttpsUrl(outcome.url, `outcome ${outcome.requestId} url`);
      if (outcome.visibility !== 'public' && outcome.visibility !== 'restricted') {
        throw new CiEvidencePublicationReceiptError('visibility is unsupported');
      }
      assertIsoTimestamp(outcome.publishedAt, `outcome ${outcome.requestId} publishedAt`);
      if (item.targetKind === 'evidence') {
        const evidence = evidenceById.get(item.evidenceId);
        if (evidence === undefined || evidence.status !== 'present') {
          throw new CiEvidencePublicationReceiptError(
            `published evidence ${item.evidenceId} requires present pack evidence`,
          );
        }
      }
      continue;
    }

    const allowed: readonly CiEvidencePublicationNonPublishedStatus[] = [
      'omitted',
      'rejected',
      'private',
      'not_available',
      'failed',
      'invalid',
    ];
    if (!allowed.includes(outcome.status)) {
      throw new CiEvidencePublicationReceiptError(`unsupported publication outcome ${outcome.status}`);
    }
    assertOwnKeys(outcome, ['requestId', 'status', 'reason']);
    if ('url' in outcome && (outcome as { url?: unknown }).url !== undefined) {
      throw new CiEvidencePublicationReceiptError('nonpublished outcome must not include url');
    }
    if ('visibility' in outcome && (outcome as { visibility?: unknown }).visibility !== undefined) {
      throw new CiEvidencePublicationReceiptError('nonpublished outcome must not include visibility');
    }
    if ('publishedAt' in outcome && (outcome as { publishedAt?: unknown }).publishedAt !== undefined) {
      throw new CiEvidencePublicationReceiptError('nonpublished outcome must not include publishedAt');
    }
    assertNonemptyString(outcome.reason, `outcome ${outcome.requestId} reason`);
  }
}

function derivePublicationStatus(
  outcomes: readonly CiEvidencePublicationItemOutcome[],
): { status: CiEvidencePublicationStatus; reasons: string[] } {
  if (outcomes.length === 0) {
    return {
      status: 'not_published',
      reasons: ['no publication items were requested'],
    };
  }

  const published = outcomes.filter((outcome) => outcome.status === 'published');
  const nonpublished = outcomes.filter(
    (outcome): outcome is CiEvidencePublicationNonPublishedOutcome =>
      outcome.status !== 'published',
  );

  if (published.length === outcomes.length) {
    return { status: 'published', reasons: [] };
  }

  if (published.length > 0 && nonpublished.length > 0) {
    return {
      status: 'partial',
      reasons: nonpublished.map(
        (outcome) => `${outcome.requestId} ${outcome.status}: ${outcome.reason}`,
      ),
    };
  }

  const blocking = nonpublished.filter(
    (outcome) =>
      outcome.status === 'failed' ||
      outcome.status === 'invalid' ||
      outcome.status === 'rejected',
  );
  if (blocking.length > 0) {
    return {
      status: 'failed',
      reasons: nonpublished.map(
        (outcome) => `${outcome.requestId} ${outcome.status}: ${outcome.reason}`,
      ),
    };
  }

  return {
    status: 'not_published',
    reasons: nonpublished.map(
      (outcome) => `${outcome.requestId} ${outcome.status}: ${outcome.reason}`,
    ),
  };
}

function deriveSummary(
  status: CiEvidencePublicationStatus,
  pack: CiEvidencePublicationPackBinding,
): string {
  return `publication ${status}; pack mechanismStatus ${pack.mechanismStatus}; twoPlatformClaim ${pack.twoPlatformClaim.status}`;
}

function deriveNextAction(status: CiEvidencePublicationStatus): string {
  switch (status) {
    case 'published':
      return 'retain the receipt as the local publication binding; do not reinterpret pack mechanismStatus or twoPlatformClaim from publication success';
    case 'partial':
      return 'inspect nonpublished item reasons and republish only remaining requested items';
    case 'failed':
      return 'inspect failed, invalid, or rejected publication reasons before retrying';
    case 'not_published':
      return 'no items were published; inspect omitted, private, or not_available reasons before requesting publication again';
    default: {
      const exhaustive: never = status;
      return `unsupported publication status ${exhaustive}`;
    }
  }
}

function bindPack(
  pack: CiEvidencePack,
  digest: { sha256: string; byteSize: number },
  packRelativePath: string,
): CiEvidencePublicationPackBinding {
  return {
    packId: pack.packId,
    schemaVersion: pack.schemaVersion,
    sha256: digest.sha256,
    byteSize: digest.byteSize,
    packRelativePath,
    source: cloneSource(pack.source),
    liveProofSet: { ...pack.liveProofSet },
    requiredPlatforms: [...pack.requiredPlatforms],
    requiredEvidenceKinds: [...pack.requiredEvidenceKinds],
    mechanismStatus: pack.mechanismStatus,
    twoPlatformClaim: {
      status: pack.twoPlatformClaim.status,
      reasons: [...pack.twoPlatformClaim.reasons],
    },
    comparisonStatus: pack.comparisonStatus,
    completeness: {
      status: pack.completeness.status,
      reasons: [...pack.completeness.reasons],
    },
    assembly: {
      status: pack.assembly.status,
      reasons: [...pack.assembly.reasons],
    },
  };
}

function assertCopiedPackBinding(artifact: CiEvidencePublicationReceipt, pack: CiEvidencePack): void {
  // Copied pack fields only. sha256/byteSize are not re-hashed; this assertion has no pack bytes.
  if (artifact.pack.packId !== pack.packId) {
    throw new CiEvidencePublicationReceiptError('pack.packId must copy the bound pack');
  }
  if (artifact.pack.schemaVersion !== pack.schemaVersion) {
    throw new CiEvidencePublicationReceiptError('pack.schemaVersion must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.source, pack.source)) {
    throw new CiEvidencePublicationReceiptError('pack.source must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.liveProofSet, pack.liveProofSet)) {
    throw new CiEvidencePublicationReceiptError('pack.liveProofSet must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.requiredPlatforms, pack.requiredPlatforms)) {
    throw new CiEvidencePublicationReceiptError('pack.requiredPlatforms must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.requiredEvidenceKinds, pack.requiredEvidenceKinds)) {
    throw new CiEvidencePublicationReceiptError('pack.requiredEvidenceKinds must copy the bound pack');
  }
  if (artifact.pack.mechanismStatus !== pack.mechanismStatus) {
    throw new CiEvidencePublicationReceiptError('pack.mechanismStatus must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.twoPlatformClaim, pack.twoPlatformClaim)) {
    throw new CiEvidencePublicationReceiptError('pack.twoPlatformClaim must copy the bound pack');
  }
  if (artifact.pack.comparisonStatus !== pack.comparisonStatus) {
    throw new CiEvidencePublicationReceiptError('pack.comparisonStatus must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.completeness, pack.completeness)) {
    throw new CiEvidencePublicationReceiptError('pack.completeness must copy the bound pack');
  }
  if (!jsonValuesEqual(artifact.pack.assembly, pack.assembly)) {
    throw new CiEvidencePublicationReceiptError('pack.assembly must copy the bound pack');
  }
}

function assertCiEvidencePublicationReceiptForPack(
  receipt: CiEvidencePublicationReceipt,
  pack: CiEvidencePack,
): void {
  wrapSchemaValidation(receipt, SCHEMAS.ciEvidencePublicationReceipt, 'ci-evidence-publication-receipt');
  wrapSchemaValidation(pack, SCHEMAS.ciEvidencePack, 'ci-evidence-pack');
  try {
    assertCiEvidencePackSemantics(pack);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePublicationReceiptError(`pack failed pack validation: ${message}`);
  }
  assertReceiptSemantics(receipt, pack);
}

function assertCiEvidencePublicationReceiptForExactPackBytes(
  receipt: CiEvidencePublicationReceipt,
  pack: CiEvidencePack,
  packBytes: Uint8Array,
): void {
  if (!(packBytes instanceof Uint8Array)) {
    throw new CiEvidencePublicationReceiptError('packBytes must be a Uint8Array');
  }
  const parsedFromBytes = parsePackBytes(packBytes);
  const digest = hashExactBytes(packBytes);
  if (receipt.pack.sha256 !== digest.sha256) {
    throw new CiEvidencePublicationReceiptError('pack.sha256 must match exact pack bytes');
  }
  if (receipt.pack.byteSize !== digest.byteSize) {
    throw new CiEvidencePublicationReceiptError('pack.byteSize must match exact pack bytes');
  }
  if (!jsonValuesEqual(parsedFromBytes, pack)) {
    throw new CiEvidencePublicationReceiptError('parsed pack bytes must match the supplied pack');
  }
  assertCiEvidencePublicationReceiptForPack(receipt, pack);
}

function assertReceiptSemantics(artifact: CiEvidencePublicationReceipt, pack: CiEvidencePack): void {
  if (artifact.schemaVersion !== CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION) {
    throw new CiEvidencePublicationReceiptError('unsupported schemaVersion');
  }
  assertNonemptyString(artifact.receiptId, 'receiptId');
  assertIsoTimestamp(artifact.createdAt, 'createdAt');
  assertPublisher(artifact.publisher);
  assertRunRelativePath(artifact.pack.packRelativePath);
  assertSha256(artifact.pack.sha256, 'pack.sha256');
  assertPositiveInteger(artifact.pack.byteSize, 'pack.byteSize');
  assertRequestedItems(artifact.requestedItems, pack);
  assertOutcomes(artifact.requestedItems, artifact.outcomes, pack);

  const derived = derivePublicationStatus(artifact.outcomes);
  if (artifact.publicationStatus !== derived.status) {
    throw new CiEvidencePublicationReceiptError('publicationStatus does not match derivation');
  }
  if (!jsonValuesEqual(artifact.reasons, derived.reasons)) {
    throw new CiEvidencePublicationReceiptError('publication reasons do not match derivation');
  }
  const expectedSummary = deriveSummary(derived.status, artifact.pack);
  if (artifact.summary !== expectedSummary) {
    throw new CiEvidencePublicationReceiptError('summary does not match derivation');
  }
  if (artifact.nextAction !== deriveNextAction(derived.status)) {
    throw new CiEvidencePublicationReceiptError('nextAction does not match derivation');
  }
  assertCopiedPackBinding(artifact, pack);
}

function buildCiEvidencePublicationReceipt(
  input: CiEvidencePublicationReceiptBuildInput,
): CiEvidencePublicationReceipt {
  const facts = cloneFacts(input.facts);
  const packBytes = Uint8Array.from(input.packBytes);
  const pack = parsePackBytes(packBytes);
  const digest = hashExactBytes(packBytes);
  assertRunRelativePath(facts.packRelativePath);

  const packBinding = bindPack(pack, digest, facts.packRelativePath);
  const derived = derivePublicationStatus(facts.outcomes);
  const artifact: CiEvidencePublicationReceipt = {
    schemaVersion: CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION,
    receiptId: facts.receiptId,
    createdAt: facts.createdAt,
    publisher: facts.publisher,
    pack: packBinding,
    requestedItems: facts.requestedItems,
    outcomes: facts.outcomes,
    publicationStatus: derived.status,
    reasons: derived.reasons,
    summary: deriveSummary(derived.status, packBinding),
    nextAction: deriveNextAction(derived.status),
  };
  wrapSchemaValidation(artifact, SCHEMAS.ciEvidencePublicationReceipt, 'ci-evidence-publication-receipt');
  assertReceiptSemantics(artifact, pack);
  return artifact;
}

function decodeReceiptUtf8Bytes(bytes: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePublicationReceiptError(`receipt file is not valid UTF-8: ${message}`);
  }
}

function readCiEvidencePublicationReceipt(
  filePath: string,
  packBytes: Uint8Array,
): CiEvidencePublicationReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(decodeReceiptUtf8Bytes(readFileSync(filePath)));
  } catch (error) {
    if (error instanceof CiEvidencePublicationReceiptError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CiEvidencePublicationReceiptError(`receipt file is not valid JSON: ${message}`);
  }
  const artifact = wrapSchemaValidation<CiEvidencePublicationReceipt>(
    raw,
    SCHEMAS.ciEvidencePublicationReceipt,
    'ci-evidence-publication-receipt',
  );
  if (artifact.schemaVersion !== CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION) {
    throw new CiEvidencePublicationReceiptError('unsupported schemaVersion');
  }
  assertNonemptyString(artifact.receiptId, 'receiptId');
  assertIsoTimestamp(artifact.createdAt, 'createdAt');
  assertPublisher(artifact.publisher);
  assertRunRelativePath(artifact.pack.packRelativePath);
  assertSha256(artifact.pack.sha256, 'pack.sha256');
  assertPositiveInteger(artifact.pack.byteSize, 'pack.byteSize');
  uniqueOrThrow(
    artifact.requestedItems.map((item) => item.requestId),
    'requestId',
  );
  uniqueOrThrow(
    artifact.requestedItems.map((item) => targetIdentity(item)),
    'publication target',
  );
  uniqueOrThrow(
    artifact.outcomes.map((outcome) => outcome.requestId),
    'outcome requestId',
  );
  if (artifact.outcomes.length !== artifact.requestedItems.length) {
    throw new CiEvidencePublicationReceiptError('outcomes must cover every requested item exactly once');
  }
  const itemsById = new Map(artifact.requestedItems.map((item) => [item.requestId, item]));
  for (const item of artifact.requestedItems) {
    if (item.targetKind === 'pack_artifact') {
      assertOwnKeys(item, ['requestId', 'targetKind', 'packArtifact']);
      if (item.packArtifact !== 'ci_evidence_pack' && item.packArtifact !== 'live_proof_set') {
        throw new CiEvidencePublicationReceiptError('packArtifact is unsupported');
      }
    } else if (item.targetKind === 'evidence') {
      assertOwnKeys(item, ['requestId', 'targetKind', 'evidenceId']);
      assertNonemptyString(item.evidenceId, 'evidenceId');
    } else {
      throw new CiEvidencePublicationReceiptError('targetKind is unsupported');
    }
  }
  const allowedNonPublished: readonly CiEvidencePublicationNonPublishedStatus[] = [
    'omitted',
    'rejected',
    'private',
    'not_available',
    'failed',
    'invalid',
  ];
  for (const outcome of artifact.outcomes) {
    const item = itemsById.get(outcome.requestId);
    if (item === undefined) {
      throw new CiEvidencePublicationReceiptError(`outcome references unknown requestId ${outcome.requestId}`);
    }
    if (outcome.status === 'published') {
      assertOwnKeys(outcome, ['requestId', 'status', 'url', 'visibility', 'publishedAt']);
      if ('reason' in outcome && (outcome as { reason?: unknown }).reason !== undefined) {
        throw new CiEvidencePublicationReceiptError('published outcome must not include reason');
      }
      assertHttpsUrl(outcome.url, `outcome ${outcome.requestId} url`);
      if (outcome.visibility !== 'public' && outcome.visibility !== 'restricted') {
        throw new CiEvidencePublicationReceiptError('visibility is unsupported');
      }
      assertIsoTimestamp(outcome.publishedAt, `outcome ${outcome.requestId} publishedAt`);
    } else {
      if (!allowedNonPublished.includes(outcome.status)) {
        throw new CiEvidencePublicationReceiptError(`unsupported publication outcome ${outcome.status}`);
      }
      assertOwnKeys(outcome, ['requestId', 'status', 'reason']);
      if ('url' in outcome && (outcome as { url?: unknown }).url !== undefined) {
        throw new CiEvidencePublicationReceiptError('nonpublished outcome must not include url');
      }
      if ('visibility' in outcome && (outcome as { visibility?: unknown }).visibility !== undefined) {
        throw new CiEvidencePublicationReceiptError('nonpublished outcome must not include visibility');
      }
      if ('publishedAt' in outcome && (outcome as { publishedAt?: unknown }).publishedAt !== undefined) {
        throw new CiEvidencePublicationReceiptError('nonpublished outcome must not include publishedAt');
      }
      assertNonemptyString(outcome.reason, `outcome ${outcome.requestId} reason`);
    }
  }
  const derived = derivePublicationStatus(artifact.outcomes);
  if (artifact.publicationStatus !== derived.status) {
    throw new CiEvidencePublicationReceiptError('publicationStatus does not match derivation');
  }
  if (!jsonValuesEqual(artifact.reasons, derived.reasons)) {
    throw new CiEvidencePublicationReceiptError('publication reasons do not match derivation');
  }
  const expectedSummary = deriveSummary(derived.status, artifact.pack);
  if (artifact.summary !== expectedSummary) {
    throw new CiEvidencePublicationReceiptError('summary does not match derivation');
  }
  if (artifact.nextAction !== deriveNextAction(derived.status)) {
    throw new CiEvidencePublicationReceiptError('nextAction does not match derivation');
  }
  if (!(packBytes instanceof Uint8Array)) {
    throw new CiEvidencePublicationReceiptError('packBytes must be a Uint8Array');
  }
  const pack = parsePackBytes(packBytes);
  assertCiEvidencePublicationReceiptForExactPackBytes(artifact, pack, packBytes);
  return artifact;
}

export {
  CI_EVIDENCE_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  CiEvidencePublicationReceiptError,
  assertCiEvidencePublicationReceiptForExactPackBytes,
  assertCiEvidencePublicationReceiptForPack,
  buildCiEvidencePublicationReceipt,
  readCiEvidencePublicationReceipt,
};
// Pack-binding assertion copies fields only and does not re-hash sha256/byteSize.
