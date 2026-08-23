const { SCHEMAS, assertValidJson } = require('./schema-validator');
import type {
  CiEvidencePublicationItemOutcome,
  CiEvidencePublicationPublisher,
  CiEvidencePublicationRequestedItem,
} from './ci-evidence-publication-receipt';

export type CiEvidenceGithubPublicationPublisher = Omit<
  CiEvidencePublicationPublisher,
  'providerKind'
> & {
  providerKind: 'ci_workflow';
};

const CI_EVIDENCE_GITHUB_PUBLICATION_SCHEMA_VERSION = '1.0.0' as const;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type CiEvidenceGithubPublicationSchemaVersion =
  typeof CI_EVIDENCE_GITHUB_PUBLICATION_SCHEMA_VERSION;

export interface CiEvidenceGithubRepository {
  owner: string;
  repo: string;
}

export interface CiEvidenceGithubPublicationContext {
  repository: CiEvidenceGithubRepository;
  eventName: string;
  headSha: string;
  ref?: string;
  pullRequestNumber?: number;
}

export interface CiEvidenceGithubPublicationFacts {
  schemaVersion: CiEvidenceGithubPublicationSchemaVersion;
  receiptId: string;
  createdAt: string;
  packRelativePath: string;
  context: CiEvidenceGithubPublicationContext;
  publisher: CiEvidenceGithubPublicationPublisher;
  requestedItems: CiEvidencePublicationRequestedItem[];
  outcomes: CiEvidencePublicationItemOutcome[];
}

export class CiEvidenceGithubPublicationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CiEvidenceGithubPublicationInputError';
  }
}

function rejectClosedJson(message: string): never {
  throw new CiEvidenceGithubPublicationInputError(message);
}

function admitClosedJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) {
    rejectClosedJson('GitHub publication input rejected undefined');
  }
  if (typeof value === 'function') {
    rejectClosedJson('GitHub publication input rejected function');
  }
  if (typeof value === 'symbol') {
    rejectClosedJson('GitHub publication input rejected symbol');
  }
  if (typeof value === 'bigint') {
    rejectClosedJson('GitHub publication input rejected bigint');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    rejectClosedJson('GitHub publication input rejected nonfinite number');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    rejectClosedJson('GitHub publication input rejected cycle');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      rejectClosedJson('GitHub publication input rejected custom prototype');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      rejectClosedJson('GitHub publication input rejected symbol key');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        rejectClosedJson('GitHub publication input rejected symbol key');
      }
      if (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) {
        rejectClosedJson('GitHub publication input rejected extra fields');
      }
    }
    const cloned: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined) {
        rejectClosedJson('GitHub publication input rejected sparse array');
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        rejectClosedJson('GitHub publication input rejected accessor');
      }
      if (!descriptor.enumerable) {
        rejectClosedJson('GitHub publication input rejected extra fields');
      }
      cloned.push(admitClosedJson(descriptor.value, seen));
    }
    return cloned;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype) {
    rejectClosedJson('GitHub publication input rejected custom prototype');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    rejectClosedJson('GitHub publication input rejected symbol key');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      rejectClosedJson(`GitHub publication input rejected forbidden key ${key}`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      rejectClosedJson('GitHub publication input rejected extra fields');
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      rejectClosedJson('GitHub publication input rejected accessor');
    }
    if (!descriptor.enumerable) {
      rejectClosedJson('GitHub publication input rejected extra fields');
    }
    cloned[key] = admitClosedJson(descriptor.value, seen);
  }
  return cloned;
}

function asPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CiEvidenceGithubPublicationInputError(
      `GitHub publication input ${label} must be a closed plain JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function assertSchemaVersion(facts: Record<string, unknown>): void {
  if (facts.schemaVersion !== CI_EVIDENCE_GITHUB_PUBLICATION_SCHEMA_VERSION) {
    throw new CiEvidenceGithubPublicationInputError(
      'GitHub publication input schemaVersion must be 1.0.0',
    );
  }
}

function assertCiWorkflowPublisher(facts: Record<string, unknown>): void {
  const publisher = asPlainObject(facts.publisher, 'publisher');
  if (publisher.providerKind !== 'ci_workflow') {
    throw new CiEvidenceGithubPublicationInputError(
      'GitHub publication input publisher.providerKind must be ci_workflow',
    );
  }
}

export function admitCiEvidenceGithubPublicationFacts(
  value: unknown,
): CiEvidenceGithubPublicationFacts {
  const copied = admitClosedJson(value, new WeakSet<object>());
  const facts = asPlainObject(copied, 'value');
  assertSchemaVersion(facts);
  assertCiWorkflowPublisher(facts);

  try {
    assertValidJson(copied, SCHEMAS.ciEvidenceGithubPublicationInput, 'GitHub publication input');
  } catch (error) {
    if (error instanceof CiEvidenceGithubPublicationInputError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'schema validation failed';
    throw new CiEvidenceGithubPublicationInputError(message);
  }

  return copied as CiEvidenceGithubPublicationFacts;
}

export { CI_EVIDENCE_GITHUB_PUBLICATION_SCHEMA_VERSION };
