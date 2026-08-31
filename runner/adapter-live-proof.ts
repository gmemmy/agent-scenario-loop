#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const {
  StableContainedFileError,
  readStableContainedFile,
  resolveStableDirectory,
} = require('../core/stable-contained-file') as typeof import('../core/stable-contained-file');
const { hasHelpFlag, writeUsage } = require('./cli');
const { writeLiveProofSummary } = require('./live-proof-summary') as typeof import('./live-proof-summary');

type AdapterLiveProofSidecarRequest = {
  kind: 'recording' | 'screenshot' | 'uiTree' | 'actionTranscript' | 'log' | 'metrics' | 'health' | 'verdict' | 'summary' | 'other';
  reason?: string;
  relativePath?: string;
  required: boolean;
  status: 'present' | 'not_available';
};

type AdapterLiveProofRequest = {
  schemaVersion: '1.0.0';
  platform: 'android' | 'ios';
  runId: string;
  outputDir: string;
  preflight: {
    leaseRunId: string;
    requireLease: true;
    runDir: string;
    runId: string;
    runnerId: 'agent-device';
    session: string;
    target: string;
  };
  interactionProof: {
    label: string;
    runDir: string;
    runId: string;
    runnerId: 'agent-device';
    scenarioId: string;
  };
  sidecars: AdapterLiveProofSidecarRequest[];
};

type AdapterLiveProofSidecar = {
  byteSize?: number;
  kind: AdapterLiveProofSidecarRequest['kind'];
  reason?: string;
  relativePath?: string;
  required: boolean;
  sha256?: string;
  status: 'present' | 'missing' | 'invalid' | 'not_available' | 'rejected';
};

type AdapterLiveProofResult = {
  liveProofDir: string;
  liveProofPath: string;
  status: 'failed' | 'passed';
  summaryPath: string;
};

type StableContainedFileErrorInstance = import('../core/stable-contained-file').StableContainedFileError;

type CanonicalRunArtifacts = {
  flowId: string;
  health: Record<string, unknown>;
  healthStatus: string;
  scenarioId: string;
  verdict: Record<string, unknown>;
  verdictStatus: string;
};

export class AdapterLiveProofError extends Error {
  code: 'identity-mismatch' | 'invalid-request' | 'invalid-run' | 'output-exists' | 'target-unbound';

  constructor(code: AdapterLiveProofError['code'], message: string) {
    super(message);
    this.name = 'AdapterLiveProofError';
    this.code = code;
  }
}

function usage(stream: NodeJS.WritableStream): void {
  writeUsage([
    'Usage: asl-adapter-live-proof --request <adapter-live-proof-request.json>',
    '',
    'Builds one platform live-proof artifact from an exact target-bound agent-device preflight and capture.',
    'Declared sidecars are verified from the capture run directory; missing required sidecars fail the live proof.',
    'A passed bridge proves evidence completeness and runner health only. The direct adapter product verdict remains not_evaluated.',
  ], stream);
}

function parseRequestArg(argv: string[]): string {
  const index = argv.indexOf('--request');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    throw new AdapterLiveProofError('invalid-request', '--request must name one JSON request file.');
  }
  if (argv.length !== 2 || index !== 0) {
    throw new AdapterLiveProofError('invalid-request', 'Only --request <file> is supported.');
  }
  return value;
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new AdapterLiveProofError('invalid-run', `${label} is not valid UTF-8 JSON.`);
  }
}

function readRequest(requestPath: string): AdapterLiveProofRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(requestPath), 'utf8'));
  } catch {
    throw new AdapterLiveProofError('invalid-request', 'The adapter live-proof request is missing or invalid JSON.');
  }
  return assertValidJson(
    parsed,
    SCHEMAS.adapterLiveProofRequest,
    'Adapter live-proof request',
  ) as AdapterLiveProofRequest;
}

function readCanonicalRunArtifacts(
  runDir: string,
  expectedRunId: string,
  expectedScenarioId?: string,
): CanonicalRunArtifacts {
  const root = resolveStableDirectory(runDir, 'run directory');
  const health = assertValidJson(
    parseJsonBytes(readStableContainedFile(root, 'health.json', 'health artifact').bytes, 'health artifact'),
    SCHEMAS.health,
    'Health artifact',
  ) as Record<string, unknown>;
  const verdict = assertValidJson(
    parseJsonBytes(readStableContainedFile(root, 'verdict.json', 'verdict artifact').bytes, 'verdict artifact'),
    SCHEMAS.verdict,
    'Verdict artifact',
  ) as Record<string, unknown>;
  const summary = readStableContainedFile(root, 'agent-summary.md', 'agent summary');
  if (summary.byteSize === 0) {
    throw new AdapterLiveProofError('invalid-run', 'agent summary must not be empty.');
  }
  if (health.runId !== expectedRunId || verdict.runId !== expectedRunId) {
    throw new AdapterLiveProofError('identity-mismatch', 'runId does not match the declared run evidence.');
  }
  if (expectedScenarioId && (
    health.scenarioId !== expectedScenarioId || verdict.scenarioId !== expectedScenarioId
  )) {
    throw new AdapterLiveProofError('identity-mismatch', 'scenarioId does not match the declared interaction proof.');
  }
  if (
    typeof health.flowId !== 'string' || health.flowId.length === 0 ||
    health.flowId !== verdict.flowId ||
    health.scenarioId !== verdict.scenarioId ||
    health.healthStatus !== verdict.healthStatus
  ) {
    throw new AdapterLiveProofError('identity-mismatch', 'health and verdict identities do not agree.');
  }
  return {
    flowId: health.flowId,
    health,
    healthStatus: String(health.healthStatus),
    scenarioId: String(health.scenarioId),
    verdict,
    verdictStatus: String(verdict.verdictStatus),
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ? value
    : null;
}

function verifyTargetBoundAgentDeviceEvidence(
  request: AdapterLiveProofRequest,
  expectedFlowId: string,
): void {
  const preflightRoot = resolveStableDirectory(request.preflight.runDir, 'preflight run directory');
  const availability = readObject(parseJsonBytes(
    readStableContainedFile(
      preflightRoot,
      'raw/agent-device-availability.json',
      'agent-device availability evidence',
    ).bytes,
    'agent-device availability evidence',
  ));
  const targetBinding = readObject(availability?.targetBinding);
  const preflightRequiredCommands = readStringArray(availability?.requiredCommands);
  if (
    availability?.status !== 'passed' ||
    availability.scenarioId !== request.interactionProof.scenarioId ||
    availability.flowId !== expectedFlowId ||
    targetBinding?.status !== 'bound' ||
    targetBinding.platform !== request.platform ||
    targetBinding.leaseRunId !== request.preflight.leaseRunId ||
    targetBinding.requestedTarget !== request.preflight.target ||
    targetBinding.selectedDevice !== request.preflight.target
  ) {
    throw new AdapterLiveProofError(
      'target-unbound',
      'agent-device preflight is not bound to the declared target.',
    );
  }
  const expectedSession = request.preflight.session;
  if (
    targetBinding.requestedSession !== expectedSession ||
    targetBinding.selectedSession !== expectedSession
  ) {
    throw new AdapterLiveProofError(
      'target-unbound',
      'agent-device preflight session does not match the declared session.',
    );
  }
  if (request.preflight.requireLease && targetBinding.leaseStatus !== 'trusted') {
    throw new AdapterLiveProofError(
      'target-unbound',
      'agent-device preflight does not include a trusted active lease.',
    );
  }

  const interactionRoot = resolveStableDirectory(request.interactionProof.runDir, 'interaction run directory');
  const metadata = readObject(parseJsonBytes(
    readStableContainedFile(
      interactionRoot,
      'raw/agent-device-metadata.json',
      'agent-device interaction metadata',
    ).bytes,
    'agent-device interaction metadata',
  ));
  const interactionRequiredCommands = readStringArray(metadata?.requiredCommands);
  if (
    metadata?.platform !== request.platform ||
    metadata.runId !== request.interactionProof.runId ||
    metadata.leaseRunId !== request.preflight.leaseRunId ||
    metadata.leaseStatus !== 'trusted' ||
    metadata.requestedTarget !== request.preflight.target ||
    metadata.scenarioId !== request.interactionProof.scenarioId ||
    metadata.flowId !== expectedFlowId ||
    metadata.session !== expectedSession
  ) {
    throw new AdapterLiveProofError(
      'identity-mismatch',
      'agent-device interaction metadata does not match the declared platform, target, session, and scenario.',
    );
  }
  if (
    !preflightRequiredCommands ||
    !interactionRequiredCommands ||
    interactionRequiredCommands.some((command) => !preflightRequiredCommands.includes(command))
  ) {
    throw new AdapterLiveProofError(
      'identity-mismatch',
      'agent-device preflight did not validate every command required by the interaction capture.',
    );
  }
}

function sidecarFailure(
  request: AdapterLiveProofSidecarRequest,
  cause: StableContainedFileErrorInstance,
): AdapterLiveProofSidecar {
  const status = cause.code === 'missing' ? 'missing' : 'invalid';
  return {
    kind: request.kind,
    reason: cause.code === 'missing'
      ? 'The declared sidecar was not produced.'
      : `The declared sidecar was rejected (${cause.code}).`,
    required: request.required,
    status,
  };
}

function verifySidecars(
  runDir: string,
  requests: AdapterLiveProofSidecarRequest[],
): AdapterLiveProofSidecar[] {
  const seen = new Set<string>();
  const unavailableKinds = new Set<string>();
  return requests.map((request, index) => {
    const key = `${request.kind}:${request.relativePath ?? request.status}`;
    if (seen.has(key)) {
      throw new AdapterLiveProofError(
        'invalid-request',
        `sidecars[${index}] duplicates an earlier declaration.`,
      );
    }
    seen.add(key);
    if (request.status === 'not_available') {
      if (unavailableKinds.has(request.kind) || requests.some((candidate) => (
        candidate.kind === request.kind && candidate.status === 'present'
      ))) {
        throw new AdapterLiveProofError(
          'invalid-request',
          `sidecars[${index}] conflicts with another ${request.kind} declaration.`,
        );
      }
      unavailableKinds.add(request.kind);
      return {
        kind: request.kind,
        reason: request.reason ?? 'The sidecar is not available from this adapter.',
        required: request.required,
        status: 'not_available',
      };
    }

    try {
      const relativePath = request.relativePath;
      if (!relativePath) {
        throw new AdapterLiveProofError(
          'invalid-request',
          `sidecars[${index}] must declare relativePath when status is present.`,
        );
      }
      const snapshot = readStableContainedFile(
        runDir,
        relativePath,
        `sidecars[${index}]`,
      );
      if (snapshot.byteSize === 0) {
        return {
          kind: request.kind,
          reason: 'The declared sidecar is empty.',
          required: request.required,
          status: 'invalid',
        };
      }
      return {
        byteSize: snapshot.byteSize,
        kind: request.kind,
        relativePath,
        required: request.required,
        sha256: snapshot.sha256,
        status: 'present',
      };
    } catch (cause) {
      if (cause instanceof StableContainedFileError) {
        return sidecarFailure(request, cause);
      }
      throw cause;
    }
  });
}

export async function buildAdapterLiveProof(
  requestInput: unknown,
): Promise<AdapterLiveProofResult> {
  const request = assertValidJson(
    requestInput,
    SCHEMAS.adapterLiveProofRequest,
    'Adapter live-proof request',
  ) as AdapterLiveProofRequest;
  const liveProofDir = path.join(path.resolve(request.outputDir), '_live-proof', request.runId);
  if (fs.existsSync(liveProofDir)) {
    throw new AdapterLiveProofError(
      'output-exists',
      'The adapter live-proof output already exists; use a new runId or output directory.',
    );
  }

  const preflightArtifacts = readCanonicalRunArtifacts(
    request.preflight.runDir,
    request.preflight.runId,
    request.interactionProof.scenarioId,
  );
  const interactionArtifacts = readCanonicalRunArtifacts(
    request.interactionProof.runDir,
    request.interactionProof.runId,
    request.interactionProof.scenarioId,
  );
  if (
    preflightArtifacts.flowId !== interactionArtifacts.flowId ||
    preflightArtifacts.healthStatus !== 'passed' ||
    preflightArtifacts.verdictStatus !== 'not_evaluated' ||
    interactionArtifacts.healthStatus !== 'passed' ||
    interactionArtifacts.verdictStatus !== 'not_evaluated'
  ) {
    throw new AdapterLiveProofError(
      'invalid-run',
      'Adapter live-proof input must be healthy and retain the direct adapter not_evaluated product verdict.',
    );
  }
  verifyTargetBoundAgentDeviceEvidence(request, preflightArtifacts.flowId);
  const sidecars = verifySidecars(request.interactionProof.runDir, request.sidecars);
  const result = await writeLiveProofSummary({
    comparisons: [],
    interactionProofs: [{
      ...request.interactionProof,
      healthStatus: interactionArtifacts.healthStatus,
      sidecars,
      verdictStatus: interactionArtifacts.verdictStatus,
    }],
    outputDir: path.resolve(request.outputDir),
    platform: request.platform,
    preflightDir: path.resolve(request.preflight.runDir),
    preflightStatus: {
      healthStatus: preflightArtifacts.healthStatus,
      verdictStatus: preflightArtifacts.verdictStatus,
    },
    preflightRunId: request.preflight.runId,
    profiles: [],
    runId: request.runId,
  });
  const artifact = assertValidJson(
    parseJsonBytes(
      readStableContainedFile(result.liveProofDir, 'live-proof.json', 'live-proof artifact').bytes,
      'live-proof artifact',
    ),
    SCHEMAS.liveProof,
    'Live proof artifact',
  ) as Record<string, unknown>;
  return {
    ...result,
    status: artifact.status === 'passed' ? 'passed' : 'failed',
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }
  const requestPath = parseRequestArg(argv);
  const result = await buildAdapterLiveProof(readRequest(requestPath));
  process.stdout.write(`${JSON.stringify({
    artifact: result.liveProofPath,
    phase: 'adapter-live-proof',
    status: result.status,
  })}\n`);
  if (result.status !== 'passed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof AdapterLiveProofError ? 2 : 1;
  });
}

module.exports = {
  AdapterLiveProofError,
  buildAdapterLiveProof,
  main,
};
