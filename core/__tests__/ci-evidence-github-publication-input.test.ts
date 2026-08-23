const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

import type { CiEvidenceGithubPublicationFacts } from '../ci-evidence-github-publication-input';

const {
  admitCiEvidenceGithubPublicationFacts,
  CiEvidenceGithubPublicationInputError,
} = require('../ci-evidence-github-publication-input');

const SOURCE_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'core',
  'ci-evidence-github-publication-input.ts',
);

function validFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    receiptId: 'receipt-pr-1',
    createdAt: '2026-08-23T12:00:00.000Z',
    packRelativePath: 'packs/ci-evidence.json',
    context: {
      repository: { owner: 'acme', repo: 'asl' },
      eventName: 'pull_request',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ref: 'refs/pull/12/head',
      pullRequestNumber: 12,
    },
    publisher: {
      providerKind: 'ci_workflow',
      providerId: 'github-actions',
      runId: 'run-1',
      workflowId: 'ci.yml',
      jobId: 'publish',
      attemptNumber: 1,
    },
    requestedItems: [
      {
        requestId: 'req-pack',
        targetKind: 'pack_artifact',
        packArtifact: 'ci_evidence_pack',
      },
    ],
    outcomes: [
      {
        requestId: 'req-pack',
        status: 'published',
        url: 'https://github.com/acme/asl/actions/runs/1',
        visibility: 'restricted',
        publishedAt: '2026-08-23T12:00:01.000Z',
      },
    ],
    ...overrides,
  };
}

function expectRejected(value: unknown): void {
  assert.throws(
    () => admitCiEvidenceGithubPublicationFacts(value),
    CiEvidenceGithubPublicationInputError,
  );
}

describe('admitCiEvidenceGithubPublicationFacts', () => {
  it('accepts a valid pull_request fact set with a restricted published artifact', () => {
    const admitted = admitCiEvidenceGithubPublicationFacts(validFacts());
    assert.equal(admitted.schemaVersion, '1.0.0');
    assert.equal(admitted.context.eventName, 'pull_request');
    assert.equal(admitted.context.pullRequestNumber, 12);
    assert.equal(admitted.requestedItems[0]?.targetKind, 'pack_artifact');
    assert.equal(admitted.outcomes[0]?.status, 'published');
    const published = admitted.outcomes[0];
    assert.ok(published && published.status === 'published');
    assert.equal(published.visibility, 'restricted');
    const facts: CiEvidenceGithubPublicationFacts = admitted;
    const providerKind: 'ci_workflow' = facts.publisher.providerKind;
    assert.equal(providerKind, 'ci_workflow');
    assert.equal(admitted.publisher.providerKind, 'ci_workflow');
  });

  it('accepts a valid visibility: public HTTPS published outcome', () => {
    const admitted = admitCiEvidenceGithubPublicationFacts(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'published',
            url: 'https://example.com/artifacts/ci-evidence.json',
            visibility: 'public',
            publishedAt: '2026-08-23T12:00:01.000Z',
          },
        ],
      }),
    );
    const published = admitted.outcomes[0];
    assert.ok(published && published.status === 'published');
    assert.equal(published.visibility, 'public');
    assert.equal(published.url, 'https://example.com/artifacts/ci-evidence.json');
    assert.equal(admitted.publisher.providerKind, 'ci_workflow');
  });

  it('accepts workflow_dispatch without pullRequestNumber', () => {
    const admitted = admitCiEvidenceGithubPublicationFacts(
      validFacts({
        receiptId: 'receipt-dispatch',
        context: {
          repository: { owner: 'acme', repo: 'asl' },
          eventName: 'workflow_dispatch',
          headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        requestedItems: [
          {
            requestId: 'req-evidence',
            targetKind: 'evidence',
            evidenceId: 'ev-1',
          },
        ],
        outcomes: [
          {
            requestId: 'req-evidence',
            status: 'omitted',
            reason: 'workflow_dispatch does not publish evidence files',
          },
        ],
      }),
    );
    assert.equal(admitted.context.eventName, 'workflow_dispatch');
    assert.equal(Object.prototype.hasOwnProperty.call(admitted.context, 'pullRequestNumber'), false);
    assert.equal(admitted.requestedItems[0]?.targetKind, 'evidence');
    assert.equal(admitted.outcomes[0]?.status, 'omitted');
  });

  it('preserves distinct receiptId/runId/attemptNumber across retries and does not mutate the first result', () => {
    const firstInput = validFacts({
      receiptId: 'receipt-attempt-1',
      publisher: {
        providerKind: 'ci_workflow',
        providerId: 'github-actions',
        runId: 'run-retry',
        attemptNumber: 1,
      },
    });
    const first = admitCiEvidenceGithubPublicationFacts(firstInput);
    const second = admitCiEvidenceGithubPublicationFacts(
      validFacts({
        receiptId: 'receipt-attempt-2',
        publisher: {
          providerKind: 'ci_workflow',
          providerId: 'github-actions',
          runId: 'run-retry',
          attemptNumber: 2,
        },
      }),
    );
    assert.equal(first.receiptId, 'receipt-attempt-1');
    assert.equal(first.publisher.runId, 'run-retry');
    assert.equal(first.publisher.attemptNumber, 1);
    assert.equal(second.receiptId, 'receipt-attempt-2');
    assert.equal(second.publisher.runId, 'run-retry');
    assert.equal(second.publisher.attemptNumber, 2);
    firstInput.receiptId = 'mutated-source';
    assert.equal(first.receiptId, 'receipt-attempt-1');
  });

  it('rejects non-ci_workflow provider', () => {
    expectRejected(
      validFacts({
        publisher: {
          providerKind: 'local',
          providerId: 'github-actions',
          runId: 'run-1',
          attemptNumber: 1,
        },
      }),
    );
  });

  it('rejects invalid head SHA', () => {
    expectRejected(
      validFacts({
        context: {
          repository: { owner: 'acme', repo: 'asl' },
          eventName: 'pull_request',
          headSha: 'NOT-A-SHA',
        },
      }),
    );
    expectRejected(
      validFacts({
        context: {
          repository: { owner: 'acme', repo: 'asl' },
          eventName: 'pull_request',
          headSha: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      }),
    );
  });

  it('rejects invalid PR number', () => {
    expectRejected(
      validFacts({
        context: {
          repository: { owner: 'acme', repo: 'asl' },
          eventName: 'pull_request',
          headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pullRequestNumber: 0,
        },
      }),
    );
  });

  it('rejects unsafe packRelativePath', () => {
    expectRejected(validFacts({ packRelativePath: '../secret.json' }));
    expectRejected(validFacts({ packRelativePath: '/absolute/pack.json' }));
  });

  it('rejects unsafe/non-HTTPS URL', () => {
    expectRejected(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'published',
            url: 'http://example.com/artifact',
            visibility: 'public',
            publishedAt: '2026-08-23T12:00:01.000Z',
          },
        ],
      }),
    );
    expectRejected(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'published',
            url: 'https://example.com/artifact with space',
            visibility: 'public',
            publishedAt: '2026-08-23T12:00:01.000Z',
          },
        ],
      }),
    );
  });

  it('rejects extra fields', () => {
    expectRejected({
      ...validFacts(),
      extra: true,
    });
    const nested = validFacts();
    const context = nested.context as Record<string, unknown>;
    context.extra = 'nope';
    expectRejected(nested);
  });

  it('rejects extra fields on publisher, requested item, and outcome', () => {
    expectRejected(
      validFacts({
        publisher: {
          providerKind: 'ci_workflow',
          providerId: 'github-actions',
          runId: 'run-1',
          workflowId: 'ci.yml',
          jobId: 'publish',
          attemptNumber: 1,
          extra: true,
        },
      }),
    );
    expectRejected(
      validFacts({
        requestedItems: [
          {
            requestId: 'req-pack',
            targetKind: 'pack_artifact',
            packArtifact: 'ci_evidence_pack',
            extra: true,
          },
        ],
      }),
    );
    expectRejected(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'published',
            url: 'https://github.com/acme/asl/actions/runs/1',
            visibility: 'restricted',
            publishedAt: '2026-08-23T12:00:01.000Z',
            extra: true,
          },
        ],
      }),
    );
  });

  it('rejects pack_artifact carrying evidenceId', () => {
    expectRejected(
      validFacts({
        requestedItems: [
          {
            requestId: 'req-pack',
            targetKind: 'pack_artifact',
            packArtifact: 'ci_evidence_pack',
            evidenceId: 'ev-1',
          },
        ],
      }),
    );
  });

  it('rejects evidence target missing evidenceId', () => {
    expectRejected(
      validFacts({
        requestedItems: [
          {
            requestId: 'req-evidence',
            targetKind: 'evidence',
          },
        ],
      }),
    );
  });

  it('rejects published outcome missing URL', () => {
    expectRejected(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'published',
            visibility: 'restricted',
            publishedAt: '2026-08-23T12:00:01.000Z',
          },
        ],
      }),
    );
  });

  it('rejects published outcome carrying reason', () => {
    expectRejected(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'published',
            url: 'https://github.com/acme/asl/actions/runs/1',
            visibility: 'restricted',
            publishedAt: '2026-08-23T12:00:01.000Z',
            reason: 'should not be present when published',
          },
        ],
      }),
    );
  });

  it('rejects nonpublished outcome carrying URL', () => {
    expectRejected(
      validFacts({
        outcomes: [
          {
            requestId: 'req-pack',
            status: 'omitted',
            reason: 'not published',
            url: 'https://example.com/should-not-be-present',
          },
        ],
      }),
    );
  });

  it('rejects empty requestedItems and outcomes', () => {
    expectRejected(validFacts({ requestedItems: [] }));
    expectRejected(validFacts({ outcomes: [] }));
  });

  it('rejects malformed timestamp', () => {
    expectRejected(validFacts({ createdAt: '2026-08-23T12:00:00Z' }));
  });

  it('rejects unsupported schema version', () => {
    expectRejected(validFacts({ schemaVersion: '0.0.1' }));
  });

  it('rejects accessors without invoking them', () => {
    const input = validFacts();
    Object.defineProperty(input, 'trap', {
      enumerable: true,
      get() {
        throw new Error('accessor invoked');
      },
    });
    assert.throws(
      () => admitCiEvidenceGithubPublicationFacts(input),
      (error: unknown) => {
        if (!(error instanceof Error)) {
          return false;
        }
        const isInputError =
          typeof CiEvidenceGithubPublicationInputError === 'function' &&
          error instanceof CiEvidenceGithubPublicationInputError;
        if (!isInputError) {
          return false;
        }
        assert.match(error.message, /accessor/);
        return true;
      },
    );
  });

  it('rejects symbol keys, custom prototypes, cycles, sparse arrays, undefined, nonfinite values, and forbidden keys', () => {
    const withSymbol = validFacts();
    Object.defineProperty(withSymbol, Symbol('hidden'), {
      enumerable: true,
      value: 'nope',
    });
    expectRejected(withSymbol);

    const customProto = Object.assign(Object.create({ marker: true }), validFacts());
    expectRejected(customProto);

    const cyclic = validFacts();
    cyclic.self = cyclic;
    expectRejected(cyclic);

    const sparseItems: unknown[] = [];
    sparseItems[1] = {
      requestId: 'req-pack',
      targetKind: 'pack_artifact',
      packArtifact: 'ci_evidence_pack',
    };
    expectRejected(validFacts({ requestedItems: sparseItems }));

    expectRejected(validFacts({ receiptId: undefined }));

    const nonfinite = validFacts();
    const publisher = nonfinite.publisher as Record<string, unknown>;
    publisher.attemptNumber = Number.POSITIVE_INFINITY;
    expectRejected(nonfinite);

    expectRejected({
      ...validFacts(),
      __proto__: { polluted: true },
    });

    const withConstructor = validFacts();
    Object.defineProperty(withConstructor, 'constructor', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'nope',
    });
    expectRejected(withConstructor);

    const withPrototype = validFacts();
    Object.defineProperty(withPrototype, 'prototype', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 'nope',
    });
    expectRejected(withPrototype);
  });

  it('deeply isolates the returned value from later mutations of nested repository, publisher, arrays, items, and outcomes', () => {
    const input = validFacts();
    const admitted = admitCiEvidenceGithubPublicationFacts(input);
    const context = input.context as {
      repository: { owner: string };
    };
    const publisher = input.publisher as { providerId: string };
    const requestedItems = input.requestedItems as Array<Record<string, unknown>>;
    const outcomes = input.outcomes as Array<Record<string, unknown>>;

    context.repository.owner = 'mutated-owner';
    publisher.providerId = 'mutated-provider';
    requestedItems.push({
      requestId: 'extra',
      targetKind: 'evidence',
      evidenceId: 'ev-1',
    });
    const firstItem = requestedItems[0];
    if (firstItem) {
      firstItem.requestId = 'mutated-request';
    }
    const firstOutcome = outcomes[0];
    if (firstOutcome) {
      firstOutcome.url = 'https://example.com/mutated';
    }

    assert.equal(admitted.context.repository.owner, 'acme');
    assert.equal(admitted.publisher.providerId, 'github-actions');
    assert.equal(admitted.requestedItems.length, 1);
    assert.equal(admitted.requestedItems[0]?.requestId, 'req-pack');
    const published = admitted.outcomes[0];
    assert.ok(published && published.status === 'published');
    assert.equal(published.url, 'https://github.com/acme/asl/actions/runs/1');
  });

  it('source module contains no GitHub API, upload, filesystem, device, or runtime execution imports or commands', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    assert.doesNotMatch(source, /\bchild_process\b/);
    assert.doesNotMatch(source, /require\(['"]node:fs['"]\)/);
    assert.doesNotMatch(source, /\boctokit\b/i);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /\bexecFile\b/);
    assert.doesNotMatch(source, /\badb\b/);
    assert.doesNotMatch(source, /\bsimctl\b/);
    assert.doesNotMatch(source, /\bprocess\.env\b/);
    assert.doesNotMatch(source, /github\.com\/.*\/(uploads|git\/blobs)/i);
  });
});
