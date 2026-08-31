const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AdapterLiveProofError,
  buildAdapterLiveProof,
} = require('../adapter-live-proof') as typeof import('../adapter-live-proof');
const { buildLiveProofSetArtifact } = require('../live-proof') as typeof import('../live-proof');

type TestContext = import('node:test').TestContext;

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRun(
  runDir: string,
  options: {
    flowId?: string;
    healthStatus?: 'failed' | 'passed' | 'partial';
    runId: string;
    scenarioId: string;
    verdictStatus?: 'failed' | 'inconclusive' | 'not_evaluated' | 'passed';
  },
): Promise<void> {
  const healthStatus = options.healthStatus ?? 'passed';
  await writeJson(path.join(runDir, 'health.json'), {
    schemaVersion: '1.0.0',
    flowId: options.flowId ?? options.scenarioId,
    scenarioId: options.scenarioId,
    runId: options.runId,
    healthStatus,
    checks: [{
      name: 'fixture',
      status: healthStatus,
      source: 'runner',
    }],
  });
  await writeJson(path.join(runDir, 'verdict.json'), {
    schemaVersion: '1.0.0',
    flowId: options.flowId ?? options.scenarioId,
    scenarioId: options.scenarioId,
    runId: options.runId,
    healthStatus,
    verdictStatus: options.verdictStatus ?? 'not_evaluated',
    budgetChecks: [],
    summary: 'Fixture adapter verdict; no product assertion was evaluated.',
  });
  await fsp.writeFile(path.join(runDir, 'agent-summary.md'), '# fixture run\n', 'utf8');
}

async function fixture(t: TestContext): Promise<{
  interactionDir: string;
  outputDir: string;
  preflightDir: string;
  request: Record<string, unknown>;
  tempDir: string;
}> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-adapter-live-proof-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const preflightDir = path.join(tempDir, 'preflight');
  const interactionDir = path.join(tempDir, 'interaction');
  const outputDir = path.join(tempDir, 'output');
  await writeRun(preflightDir, {
    runId: 'preflight-run',
    scenarioId: 'category-discovery',
    flowId: 'category-discovery-flow',
  });
  await writeJson(path.join(preflightDir, 'raw', 'agent-device-availability.json'), {
    flowId: 'category-discovery-flow',
    requiredCommands: ['click', 'devices', 'session list'],
    scenarioId: 'category-discovery',
    status: 'passed',
    targetBinding: {
      leaseRunId: 'lease-run-1',
      leaseStatus: 'trusted',
      platform: 'ios',
      requestedSession: 'session-1',
      requestedTarget: 'SIM-1',
      selectedDevice: 'SIM-1',
      selectedSession: 'session-1',
      status: 'bound',
    },
  });
  await writeRun(interactionDir, {
    runId: 'interaction-run',
    scenarioId: 'category-discovery',
    flowId: 'category-discovery-flow',
  });
  await writeJson(path.join(interactionDir, 'raw', 'agent-device-metadata.json'), {
    runId: 'interaction-run',
    leaseRunId: 'lease-run-1',
    leaseStatus: 'trusted',
    platform: 'ios',
    flowId: 'category-discovery-flow',
    requiredCommands: ['click', 'devices', 'session list'],
    requestedTarget: 'SIM-1',
    scenarioId: 'category-discovery',
    session: 'session-1',
  });
  await fsp.mkdir(path.join(interactionDir, 'captures'), { recursive: true });
  await fsp.writeFile(path.join(interactionDir, 'captures', 'journey.mov'), 'video-bytes', 'utf8');
  await fsp.writeFile(path.join(interactionDir, 'raw', 'ui-tree.json'), '{"nodes":[]}', 'utf8');
  return {
    interactionDir,
    outputDir,
    preflightDir,
    request: {
      schemaVersion: '1.0.0',
      platform: 'ios',
      runId: 'aggregate-run',
      outputDir,
      preflight: {
        runnerId: 'agent-device',
        runDir: preflightDir,
        runId: 'preflight-run',
        leaseRunId: 'lease-run-1',
        target: 'SIM-1',
        session: 'session-1',
        requireLease: true,
      },
      interactionProof: {
        label: 'direct adapter journey',
        runnerId: 'agent-device',
        scenarioId: 'category-discovery',
        runId: 'interaction-run',
        runDir: interactionDir,
      },
      sidecars: [
        {
          kind: 'recording',
          required: true,
          status: 'present',
          relativePath: 'captures/journey.mov',
        },
        {
          kind: 'uiTree',
          required: true,
          status: 'present',
          relativePath: 'raw/ui-tree.json',
        },
        {
          kind: 'log',
          required: false,
          status: 'not_available',
          reason: 'The direct adapter did not expose scoped native logs.',
        },
      ],
    },
    tempDir,
  };
}

test('bridges an exact target-bound direct adapter run without promoting its product verdict', async (t: TestContext) => {
  const setup = await fixture(t);
  const result = await buildAdapterLiveProof(setup.request);
  assert.equal(result.status, 'passed');
  const artifact = JSON.parse(fs.readFileSync(result.liveProofPath, 'utf8')) as Record<string, unknown>;
  const [proof] = artifact.interactionProofs as Array<Record<string, unknown>>;
  const sidecars = proof?.sidecars as Array<Record<string, unknown>>;
  assert.equal(proof?.scenarioId, 'category-discovery');
  assert.equal(proof?.verdictStatus, 'not_evaluated');
  assert.deepEqual(sidecars.map((sidecar) => sidecar.status), ['present', 'present', 'not_available']);
  assert.equal(sidecars[0]?.sha256, sha256('video-bytes'));
  assert.equal(artifact.status, 'passed');
  assert.match(String(artifact.summary), /1 passed interaction proof/iu);
  const proofSet = buildLiveProofSetArtifact({
    failOnRegression: false,
    files: [result.liveProofPath],
    proofs: [artifact as Parameters<typeof buildLiveProofSetArtifact>[0]['proofs'][number]],
    requiredPlatforms: ['ios'],
    runId: 'adapter-proof-set',
  });
  assert.equal(proofSet.status, 'passed');
  assert.deepEqual(proofSet.presentPlatforms, ['ios']);
  assert.equal(proofSet.proofs[0]?.runId, 'aggregate-run');
});

test('fails the live proof when a required sidecar is unavailable while preserving explicit evidence', async (t: TestContext) => {
  const setup = await fixture(t);
  const request = setup.request as { sidecars: Array<Record<string, unknown>> };
  request.sidecars[0] = {
    kind: 'recording',
    required: true,
    status: 'not_available',
    reason: 'The adapter has no recording bridge.',
  };
  const result = await buildAdapterLiveProof(request);
  assert.equal(result.status, 'failed');
  const artifact = JSON.parse(fs.readFileSync(result.liveProofPath, 'utf8')) as Record<string, unknown>;
  const [proof] = artifact.interactionProofs as Array<Record<string, unknown>>;
  const [recording] = proof?.sidecars as Array<Record<string, unknown>>;
  assert.deepEqual(recording, {
    kind: 'recording',
    reason: 'The adapter has no recording bridge.',
    required: true,
    status: 'not_available',
  });
  assert.equal(proof?.verdictStatus, 'not_evaluated');
  assert.equal((artifact.nextAction as Record<string, unknown>).owner, 'asl_runner');
});

test('marks a missing required declared sidecar as missing instead of synthesizing it', async (t: TestContext) => {
  const setup = await fixture(t);
  const request = setup.request as { sidecars: Array<Record<string, unknown>> };
  request.sidecars[0] = {
    kind: 'recording',
    required: true,
    status: 'present',
    relativePath: 'captures/missing.mov',
  };
  const result = await buildAdapterLiveProof(request);
  assert.equal(result.status, 'failed');
  const artifact = JSON.parse(fs.readFileSync(result.liveProofPath, 'utf8')) as Record<string, unknown>;
  const [proof] = artifact.interactionProofs as Array<Record<string, unknown>>;
  const [recording] = proof?.sidecars as Array<Record<string, unknown>>;
  assert.equal(recording?.status, 'missing');
  assert.equal('relativePath' in (recording ?? {}), false);
  assert.equal(fs.existsSync(path.join(setup.interactionDir, 'captures', 'missing.mov')), false);
});

test('rejects target, lease, and scenario identity mismatches before writing live proof output', async (t: TestContext) => {
  const setup = await fixture(t);
  const request = setup.request as {
    preflight: Record<string, unknown>;
    interactionProof: Record<string, unknown>;
  };
  request.preflight.target = 'SIM-OTHER';
  await assert.rejects(
    buildAdapterLiveProof(request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'target-unbound',
  );
  assert.equal(fs.existsSync(path.join(setup.outputDir, '_live-proof')), false);

  request.preflight.target = 'SIM-1';
  request.interactionProof.scenarioId = 'wrong-scenario';
  await assert.rejects(
    buildAdapterLiveProof(request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'identity-mismatch',
  );
  assert.equal(fs.existsSync(path.join(setup.outputDir, '_live-proof')), false);
});

test('rejects product verdict promotion and complete metadata identity drift', async (t: TestContext) => {
  const promoted = await fixture(t);
  const promotedVerdict = JSON.parse(
    fs.readFileSync(path.join(promoted.interactionDir, 'verdict.json'), 'utf8'),
  ) as Record<string, unknown>;
  promotedVerdict.verdictStatus = 'passed';
  await writeJson(path.join(promoted.interactionDir, 'verdict.json'), promotedVerdict);
  await assert.rejects(
    buildAdapterLiveProof(promoted.request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'invalid-run',
  );
  assert.equal(fs.existsSync(path.join(promoted.outputDir, '_live-proof')), false);

  const drifted = await fixture(t);
  const metadataPath = path.join(drifted.interactionDir, 'raw', 'agent-device-metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
  metadata.leaseRunId = 'other-lease-run';
  await writeJson(metadataPath, metadata);
  await assert.rejects(
    buildAdapterLiveProof(drifted.request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'identity-mismatch',
  );
  assert.equal(fs.existsSync(path.join(drifted.outputDir, '_live-proof')), false);
});

test('rejects capture commands that were not validated by the target-bound preflight', async (t: TestContext) => {
  const current = await fixture(t);
  const metadataPath = path.join(current.interactionDir, 'raw', 'agent-device-metadata.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  metadata.requiredCommands = ['devices', 'pinch', 'session list'];
  await writeJson(metadataPath, metadata);

  await assert.rejects(
    buildAdapterLiveProof(current.request),
    /did not validate every command required/iu,
  );
  assert.equal(fs.existsSync(current.outputDir), false);
});

test('rejects preflight and capture flow identity drift', async (t: TestContext) => {
  const current = await fixture(t);
  const metadataPath = path.join(current.interactionDir, 'raw', 'agent-device-metadata.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  metadata.flowId = 'other-flow';
  await writeJson(metadataPath, metadata);

  await assert.rejects(
    buildAdapterLiveProof(current.request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'identity-mismatch',
  );
  assert.equal(fs.existsSync(current.outputDir), false);
});

test('rejects raw flow identity that agrees internally but not with canonical run artifacts', async (t: TestContext) => {
  const current = await fixture(t);
  const availabilityPath = path.join(current.preflightDir, 'raw', 'agent-device-availability.json');
  const metadataPath = path.join(current.interactionDir, 'raw', 'agent-device-metadata.json');
  const availability = JSON.parse(await fsp.readFile(availabilityPath, 'utf8')) as Record<string, unknown>;
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  availability.flowId = 'other-flow';
  metadata.flowId = 'other-flow';
  await writeJson(availabilityPath, availability);
  await writeJson(metadataPath, metadata);

  await assert.rejects(
    buildAdapterLiveProof(current.request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'target-unbound',
  );
  assert.equal(fs.existsSync(current.outputDir), false);
});

test('rejects the legacy generic capture identity from aggregate proof', async (t: TestContext) => {
  const current = await fixture(t);
  const request = current.request as { interactionProof: Record<string, unknown> };
  request.interactionProof.scenarioId = 'agent-device-capture';

  await assert.rejects(buildAdapterLiveProof(request), /schema validation/iu);
  assert.equal(fs.existsSync(current.outputDir), false);
});

test('rejects unsafe sidecar paths and existing output without altering evidence', async (t: TestContext) => {
  const setup = await fixture(t);
  const request = setup.request as { sidecars: Array<Record<string, unknown>> };
  request.sidecars[0] = {
    kind: 'recording',
    required: true,
    status: 'present',
    relativePath: '../outside.mov',
  };
  await assert.rejects(buildAdapterLiveProof(request), /safe run-relative|expected value to match/iu);
  assert.equal(fs.existsSync(path.join(setup.outputDir, '_live-proof')), false);

  const clean = await fixture(t);
  const liveProofDir = path.join(clean.outputDir, '_live-proof', 'aggregate-run');
  await fsp.mkdir(liveProofDir, { recursive: true });
  await fsp.writeFile(path.join(liveProofDir, 'keep.txt'), 'keep', 'utf8');
  await assert.rejects(
    buildAdapterLiveProof(clean.request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'output-exists',
  );
  assert.equal(fs.readFileSync(path.join(liveProofDir, 'keep.txt'), 'utf8'), 'keep');
});

test('requires at least one mandatory sidecar declaration', async (t: TestContext) => {
  const setup = await fixture(t);
  const request = setup.request as { sidecars: Array<Record<string, unknown>> };
  request.sidecars = [{
    kind: 'log',
    required: false,
    status: 'not_available',
    reason: 'No log was requested.',
  }];
  await assert.rejects(buildAdapterLiveProof(request), /must contain|schema validation/iu);
  assert.equal(fs.existsSync(path.join(setup.outputDir, '_live-proof')), false);
});

test('rejects unsafe aggregate run ids and contradictory sidecar availability', async (t: TestContext) => {
  const unsafe = await fixture(t);
  unsafe.request.runId = '../outside';
  await assert.rejects(buildAdapterLiveProof(unsafe.request), /schema validation|expected value to match/iu);
  assert.equal(fs.existsSync(path.join(unsafe.outputDir, '_live-proof')), false);

  const contradictory = await fixture(t);
  const request = contradictory.request as { sidecars: Array<Record<string, unknown>> };
  request.sidecars.push({
    kind: 'recording',
    required: false,
    status: 'not_available',
    reason: 'Contradicts the present recording declaration.',
  });
  await assert.rejects(
    buildAdapterLiveProof(request),
    (error: unknown) => error instanceof AdapterLiveProofError && error.code === 'invalid-request',
  );
  assert.equal(fs.existsSync(path.join(contradictory.outputDir, '_live-proof')), false);
});

test('rejects symlinked declared sidecars as invalid evidence', async (t: TestContext) => {
  const setup = await fixture(t);
  const external = path.join(setup.tempDir, 'external.mov');
  const linked = path.join(setup.interactionDir, 'captures', 'linked.mov');
  await fsp.writeFile(external, 'external', 'utf8');
  await fsp.symlink(external, linked);
  const request = setup.request as { sidecars: Array<Record<string, unknown>> };
  request.sidecars[0] = {
    kind: 'recording',
    required: true,
    status: 'present',
    relativePath: 'captures/linked.mov',
  };
  const result = await buildAdapterLiveProof(request);
  assert.equal(result.status, 'failed');
  const artifact = JSON.parse(fs.readFileSync(result.liveProofPath, 'utf8')) as Record<string, unknown>;
  const [proof] = artifact.interactionProofs as Array<Record<string, unknown>>;
  const [recording] = proof?.sidecars as Array<Record<string, unknown>>;
  assert.equal(recording?.status, 'invalid');
  assert.match(String(recording?.reason), /symlink/iu);
});
