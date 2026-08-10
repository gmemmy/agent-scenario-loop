const path = require('node:path');

const { writeJsonArtifact, writeTextArtifact } = require('./artifact-writer');
const { SCHEMAS } = require('./schema-validator');

type QuickProofTier = 'trusted-automated' | 'degraded-direct' | 'manual-assisted';
type IdentityStatus = 'observed' | 'unresolved-until-observed' | 'mismatched' | 'unavailable';
type PhaseStatus = 'passed' | 'failed';

type QuickProofIdentity = {
  name: string;
  status: IdentityStatus;
  expected?: string;
  observed?: string;
  reason?: string;
};

type QuickProofIdentityObservation = QuickProofIdentity & {
  adapterId: string;
  attempt: number;
  phase: 'discovery' | 'preflight';
};

type QuickProofOperationRequirement = {
  operation: string;
  requiredArguments: string[];
};

type QuickProofCapability = {
  operation: string;
  supportedArguments: string[];
};

type QuickProofAuthorizationGrant = {
  grantId: string;
  goalId: string;
  operations: string[];
  expiresAt: string;
  delegationChain: string[];
  targetResource?: string;
};

type QuickProofAuthorizationResult = {
  status: 'authorized' | 'denied';
  reason?: string;
};

type QuickProofLease = {
  leaseId: string;
  resource: string;
  status: 'trusted' | 'untrusted';
  acquiredAt: string;
  expiresAt: string;
  reason?: string;
};

type QuickProofLeaseRelease = {
  status: 'released' | 'failed';
  reason?: string;
};

type QuickProofLeaseReference = {
  leaseId: string;
  resource: string;
};

type QuickProofSourceIdentity = {
  revision: string;
  packageName: string;
  packageVersion: string;
  packageIntegrity: string;
  helperIdentity?: string;
};

type QuickProofContext = {
  runId: string;
  scenarioId: string;
  goalId: string;
  source: QuickProofSourceIdentity;
  authorization: QuickProofAuthorizationGrant;
  requirements: QuickProofOperationRequirement[];
  lease?: QuickProofLease;
  signal?: AbortSignal;
};

type QuickProofProductContext = QuickProofContext & {
  beginProductAction: () => Promise<void>;
};

type QuickProofDiscoveryResult = {
  status: 'passed' | 'failed';
  capabilities: QuickProofCapability[];
  identities: QuickProofIdentity[];
  reason?: string;
};

type QuickProofPreflightResult = {
  status: 'passed' | 'failed';
  identities: QuickProofIdentity[];
  reason?: string;
};

type QuickProofProductResult = {
  status: 'passed' | 'failed';
  productActionStarted: boolean;
  reason?: string;
};

type QuickProofCleanupResult = {
  status: 'passed' | 'failed';
  reason?: string;
};

type QuickProofAdapter = {
  id: string;
  tier: QuickProofTier;
  discover(context: QuickProofContext): Promise<QuickProofDiscoveryResult>;
  preflight(context: QuickProofContext): Promise<QuickProofPreflightResult>;
  runProduct(context: QuickProofProductContext): Promise<QuickProofProductResult>;
  cleanup(context: QuickProofContext): Promise<QuickProofCleanupResult>;
};

type QuickProofAuthorizationPort = {
  validate(input: {
    grant: QuickProofAuthorizationGrant;
    goalId: string;
    operations: string[];
    targetResource?: string;
    nowMs: number;
    signal: AbortSignal;
  }): Promise<QuickProofAuthorizationResult>;
};

type QuickProofLeasePort = {
  acquire(input: {
    resource: string;
    authorization: QuickProofAuthorizationGrant;
    signal: AbortSignal;
    registerAcquiredLease(lease: QuickProofLease): void;
  }): Promise<QuickProofLease>;
  release(lease: QuickProofLeaseReference, signal: AbortSignal): Promise<QuickProofLeaseRelease>;
};

type QuickProofPhase = {
  name: string;
  adapterId: string;
  attempt: number;
  status: PhaseStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  reason?: string;
};

type QuickProofArtifact = {
  schemaVersion: '1.0.0';
  artifactType: 'quick-proof';
  runId: string;
  scenarioId: string;
  goalId: string;
  source: QuickProofSourceIdentity;
  startedAt: string;
  endedAt: string;
  status: 'setup-only' | 'product-executed' | 'inconclusive';
  proofTier: QuickProofTier | null;
  budgets: {
    setupMs: number;
    totalMs: number;
    minimumProductRatio: number;
    setupDurationMs: number | null;
    totalDurationMs: number;
    timeToFirstProductActionMs: number | null;
  };
  authorization: {
    status: 'authorized' | 'denied';
    grantId: string;
    goalId: string;
    operations: string[];
    delegationDepth: number;
    targetResource?: string;
    reason?: string;
  };
  lease: {
    status: 'not-required' | 'not-acquired' | 'released' | 'release-failed';
    resource?: string;
    leaseId?: string;
    reason?: string;
  };
  identities: QuickProofIdentity[];
  identityObservations: QuickProofIdentityObservation[];
  phases: QuickProofPhase[];
  adapters: Array<{
    adapterId: string;
    tier: QuickProofTier;
    attempts: number;
    status: 'not-attempted' | 'failed' | 'selected';
    reason?: string;
  }>;
  decision: {
    code:
      | 'product-completed'
      | 'product-failed'
      | 'setup-budget-exceeded'
      | 'product-budget-reserve-insufficient'
      | 'authorization-denied'
      | 'capability-unavailable'
      | 'identity-unresolved'
      | 'lease-unavailable'
      | 'manual-required'
      | 'adapter-paths-exhausted';
    reason: string;
  };
  product: {
    started: boolean | 'unknown';
    startedAt?: string;
    detectedAt?: string;
    timingStatus?: 'exact' | 'observed-late';
    status?: 'passed' | 'failed';
  };
  cleanup: {
    status: 'passed' | 'failed';
    failures: string[];
  };
};

type QuickProofOptions = {
  runId: string;
  scenarioId: string;
  goalId: string;
  source: QuickProofSourceIdentity;
  authorization: QuickProofAuthorizationGrant;
  authorizationPort?: QuickProofAuthorizationPort;
  leasePort?: QuickProofLeasePort;
  targetResource?: string;
  requirements: {
    operations: QuickProofOperationRequirement[];
    identities: Array<{ name: string; expected?: string }>;
  };
  budgets: {
    setupMs: number;
    totalMs: number;
    minimumProductRatio: number;
  };
  adapters: QuickProofAdapter[];
  now?: () => number;
};

const TIER_ORDER: Record<QuickProofTier, number> = {
  'trusted-automated': 0,
  'degraded-direct': 1,
  'manual-assisted': 2,
};

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function hasForbiddenCredentialField(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenCredentialField(entry));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
    if (/(password|secret|token|credential)/iu.test(key)) {
      return true;
    }
    return hasForbiddenCredentialField(entry);
  });
}

const AUTHORIZATION_GRANT_KEYS = new Set([
  'grantId',
  'goalId',
  'operations',
  'expiresAt',
  'delegationChain',
  'targetResource',
]);

const SOURCE_IDENTITY_KEYS = new Set([
  'revision',
  'packageName',
  'packageVersion',
  'packageIntegrity',
  'helperIdentity',
]);

function hasUnexpectedAuthorizationField(grant: QuickProofAuthorizationGrant): boolean {
  return Object.keys(grant).some((key) => !AUTHORIZATION_GRANT_KEYS.has(key));
}

function sanitizeAuthorizationGrant(grant: QuickProofAuthorizationGrant): QuickProofAuthorizationGrant {
  return {
    grantId: grant.grantId,
    goalId: grant.goalId,
    operations: [...grant.operations],
    expiresAt: grant.expiresAt,
    delegationChain: [...grant.delegationChain],
    ...(grant.targetResource ? { targetResource: grant.targetResource } : {}),
  };
}

function createQuickProofAuthorizationPort(): QuickProofAuthorizationPort {
  return {
    async validate({ grant, goalId, operations, targetResource, nowMs }) {
      if (hasUnexpectedAuthorizationField(grant) || hasForbiddenCredentialField(grant)) {
        return { status: 'denied', reason: 'Authorization grants may contain only the documented credential-free fields.' };
      }
      if (grant.goalId !== goalId) {
        return { status: 'denied', reason: `Authorization goal ${grant.goalId} does not match ${goalId}.` };
      }
      if (grant.delegationChain.length === 0) {
        return { status: 'denied', reason: 'Authorization delegation chain is empty.' };
      }
      const expiresAtMs = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        return { status: 'denied', reason: 'Authorization grant is expired or malformed.' };
      }
      const missingOperation = operations.find((operation) => !grant.operations.includes(operation));
      if (missingOperation) {
        return { status: 'denied', reason: `Authorization does not allow operation ${missingOperation}.` };
      }
      if (grant.targetResource !== undefined && grant.targetResource !== targetResource) {
        return { status: 'denied', reason: 'Authorization target resource does not match the requested resource.' };
      }
      return { status: 'authorized' };
    },
  };
}

function validateQuickProofOptions(options: QuickProofOptions): void {
  const requireNonEmptyString = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`quick-proof ${label} must be a non-empty string`);
    }
    return value;
  };
  const requireStringArray = (value: unknown, label: string, requireEntry = false): string[] => {
    if (!Array.isArray(value) || (requireEntry && value.length === 0)) {
      throw new Error(`quick-proof ${label} must be ${requireEntry ? 'a non-empty' : 'an'} array`);
    }
    const entries = value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
    if (new Set(entries).size !== entries.length) {
      throw new Error(`quick-proof ${label} entries must be unique`);
    }
    return entries;
  };

  if (!options || typeof options !== 'object') {
    throw new Error('quick-proof options must be an object');
  }
  requireNonEmptyString(options.runId, 'runId');
  requireNonEmptyString(options.scenarioId, 'scenarioId');
  requireNonEmptyString(options.goalId, 'goalId');
  if (!options.source || typeof options.source !== 'object' || Array.isArray(options.source)) {
    throw new Error('quick-proof source must be an object');
  }
  if (Object.keys(options.source).some((key) => !SOURCE_IDENTITY_KEYS.has(key)) ||
    hasForbiddenCredentialField(options.source)) {
    throw new Error('quick-proof source may contain only the documented credential-free identity fields');
  }
  requireNonEmptyString(options.source.revision, 'source.revision');
  requireNonEmptyString(options.source.packageName, 'source.packageName');
  requireNonEmptyString(options.source.packageVersion, 'source.packageVersion');
  requireNonEmptyString(options.source.packageIntegrity, 'source.packageIntegrity');
  if (options.source.helperIdentity !== undefined) {
    requireNonEmptyString(options.source.helperIdentity, 'source.helperIdentity');
  }
  if (!options.authorization || typeof options.authorization !== 'object' || Array.isArray(options.authorization)) {
    throw new Error('quick-proof authorization must be an object');
  }
  requireNonEmptyString(options.authorization.grantId, 'authorization.grantId');
  requireNonEmptyString(options.authorization.goalId, 'authorization.goalId');
  requireNonEmptyString(options.authorization.expiresAt, 'authorization.expiresAt');
  requireStringArray(options.authorization.operations, 'authorization.operations');
  if (!Array.isArray(options.authorization.delegationChain) || options.authorization.delegationChain.length === 0) {
    throw new Error('quick-proof authorization.delegationChain must be a non-empty array');
  }
  options.authorization.delegationChain.forEach((entry, index) => {
    requireNonEmptyString(entry, `authorization.delegationChain[${index}]`);
  });
  if (options.authorization.targetResource !== undefined) {
    requireNonEmptyString(options.authorization.targetResource, 'authorization.targetResource');
  }
  if (options.targetResource !== undefined) {
    requireNonEmptyString(options.targetResource, 'targetResource');
  }
  if (!options.requirements || typeof options.requirements !== 'object' || Array.isArray(options.requirements)) {
    throw new Error('quick-proof requirements must be an object');
  }
  if (!Array.isArray(options.requirements.operations) || options.requirements.operations.length === 0) {
    throw new Error('quick-proof requirements.operations must be a non-empty array');
  }
  const requiredOperations = options.requirements.operations.map((requirement, index) => {
    if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw new Error(`quick-proof requirements.operations[${index}] must be an object`);
    }
    const operation = requireNonEmptyString(requirement.operation, `requirements.operations[${index}].operation`);
    requireStringArray(requirement.requiredArguments, `requirements.operations[${index}].requiredArguments`);
    return operation;
  });
  if (new Set(requiredOperations).size !== requiredOperations.length) {
    throw new Error('quick-proof requirement operations must be unique');
  }
  if (!Array.isArray(options.requirements.identities)) {
    throw new Error('quick-proof requirements.identities must be an array');
  }
  const requiredIdentities = options.requirements.identities.map((identity, index) => {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new Error(`quick-proof requirements.identities[${index}] must be an object`);
    }
    const name = requireNonEmptyString(identity.name, `requirements.identities[${index}].name`);
    if (identity.expected !== undefined) {
      requireNonEmptyString(identity.expected, `requirements.identities[${index}].expected`);
    }
    return name;
  });
  if (new Set(requiredIdentities).size !== requiredIdentities.length) {
    throw new Error('quick-proof requirement identity names must be unique');
  }
  for (const [name, value] of Object.entries({
    setupMs: options.budgets.setupMs,
    totalMs: options.budgets.totalMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`quick-proof ${name} must be a positive finite number`);
    }
  }
  if (
    !Number.isFinite(options.budgets.minimumProductRatio) ||
    options.budgets.minimumProductRatio < 0 ||
    options.budgets.minimumProductRatio > 1
  ) {
    throw new Error('quick-proof minimumProductRatio must be between 0 and 1');
  }
  if (options.budgets.setupMs > options.budgets.totalMs) {
    throw new Error('quick-proof setupMs must not exceed totalMs');
  }
  if (options.adapters.length === 0) {
    throw new Error('quick-proof requires at least one adapter path');
  }
  for (const [index, adapter] of options.adapters.entries()) {
    requireNonEmptyString(adapter?.id, `adapters[${index}].id`);
    if (!adapter || !Object.hasOwn(TIER_ORDER, adapter.tier)) {
      throw new Error(`quick-proof adapters[${index}].tier is unsupported`);
    }
    for (const method of ['discover', 'preflight', 'runProduct', 'cleanup'] as const) {
      if (typeof adapter[method] !== 'function') {
        throw new Error(`quick-proof adapters[${index}].${method} must be a function`);
      }
    }
  }
  if (new Set(options.adapters.map((adapter) => adapter.id)).size !== options.adapters.length) {
    throw new Error('quick-proof adapter ids must be unique');
  }
  if (options.authorizationPort !== undefined && typeof options.authorizationPort.validate !== 'function') {
    throw new Error('quick-proof authorizationPort.validate must be a function');
  }
  if (options.leasePort !== undefined &&
    (typeof options.leasePort.acquire !== 'function' || typeof options.leasePort.release !== 'function')) {
    throw new Error('quick-proof leasePort must provide acquire and release functions');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new Error('quick-proof now must be a function');
  }
}

function capabilityFailure(
  requirements: QuickProofOperationRequirement[],
  capabilities: QuickProofCapability[],
): string | null {
  const seenOperations = new Set<string>();
  for (const capability of capabilities) {
    if (seenOperations.has(capability.operation)) {
      return `Operation ${capability.operation} was declared more than once; capability evidence is ambiguous.`;
    }
    seenOperations.add(capability.operation);
  }
  for (const requirement of requirements) {
    const capability = capabilities.find((entry) => entry.operation === requirement.operation);
    if (!capability) {
      return `Operation ${requirement.operation} is unavailable.`;
    }
    const missingArgument = requirement.requiredArguments.find(
      (argument) => !capability.supportedArguments.includes(argument),
    );
    if (missingArgument) {
      return `Operation ${requirement.operation} does not support argument ${missingArgument}.`;
    }
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0) &&
    new Set(value).size === value.length;
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

const IDENTITY_KEYS = new Set(['name', 'status', 'expected', 'observed', 'reason']);

function isIdentity(value: unknown): value is QuickProofIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const identity = value as Partial<QuickProofIdentity>;
  const observedIdentityIsComplete = identity.status !== 'observed' ||
    (typeof identity.observed === 'string' && identity.observed.length > 0);
  return Object.keys(value).every((key) => IDENTITY_KEYS.has(key)) &&
    typeof identity.name === 'string' && identity.name.length > 0 &&
    ['observed', 'unresolved-until-observed', 'mismatched', 'unavailable'].includes(identity.status ?? '') &&
    (identity.expected === undefined || (typeof identity.expected === 'string' && identity.expected.length > 0)) &&
    (identity.observed === undefined || (typeof identity.observed === 'string' && identity.observed.length > 0)) &&
    (identity.reason === undefined || (typeof identity.reason === 'string' && identity.reason.length > 0)) &&
    observedIdentityIsComplete;
}

function isCapability(value: unknown): value is QuickProofCapability {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const capability = value as Partial<QuickProofCapability>;
  return Object.keys(value).every((key) => key === 'operation' || key === 'supportedArguments') &&
    typeof capability.operation === 'string' && capability.operation.length > 0 &&
    isStringArray(capability.supportedArguments);
}

function isDiscoveryResult(value: unknown): value is QuickProofDiscoveryResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<QuickProofDiscoveryResult>;
  return ['passed', 'failed'].includes(result.status ?? '') &&
    Array.isArray(result.capabilities) && result.capabilities.every(isCapability) &&
    Array.isArray(result.identities) && result.identities.every(isIdentity) &&
    isOptionalNonEmptyString(result.reason);
}

function isPreflightResult(value: unknown): value is QuickProofPreflightResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<QuickProofPreflightResult>;
  return ['passed', 'failed'].includes(result.status ?? '') &&
    Array.isArray(result.identities) && result.identities.every(isIdentity) &&
    isOptionalNonEmptyString(result.reason);
}

function isProductResult(value: unknown): value is QuickProofProductResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<QuickProofProductResult>;
  return ['passed', 'failed'].includes(result.status ?? '') &&
    typeof result.productActionStarted === 'boolean' &&
    isOptionalNonEmptyString(result.reason);
}

function isCleanupResult(value: unknown): value is QuickProofCleanupResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<QuickProofCleanupResult>;
  return ['passed', 'failed'].includes(result.status ?? '') &&
    isOptionalNonEmptyString(result.reason);
}

function isAuthorizationResult(value: unknown): value is QuickProofAuthorizationResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const result = value as Partial<QuickProofAuthorizationResult>;
  return ['authorized', 'denied'].includes(result.status ?? '') &&
    isOptionalNonEmptyString(result.reason);
}

const LEASE_KEYS = new Set(['leaseId', 'resource', 'status', 'acquiredAt', 'expiresAt', 'reason']);

function isLease(value: unknown): value is QuickProofLease {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const lease = value as Partial<QuickProofLease>;
  return Object.keys(value).every((key) => LEASE_KEYS.has(key)) &&
    typeof lease.leaseId === 'string' && lease.leaseId.length > 0 &&
    typeof lease.resource === 'string' && lease.resource.length > 0 &&
    ['trusted', 'untrusted'].includes(lease.status ?? '') &&
    typeof lease.acquiredAt === 'string' && lease.acquiredAt.length > 0 &&
    typeof lease.expiresAt === 'string' && lease.expiresAt.length > 0 &&
    isOptionalNonEmptyString(lease.reason);
}

function leaseReferenceFrom(value: unknown): QuickProofLeaseReference | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const lease = value as Partial<QuickProofLeaseReference>;
  return typeof lease.leaseId === 'string' && lease.leaseId.length > 0 &&
    typeof lease.resource === 'string' && lease.resource.length > 0
    ? { leaseId: lease.leaseId, resource: lease.resource }
    : null;
}

function isLeaseRelease(value: unknown): value is QuickProofLeaseRelease {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const release = value as Partial<QuickProofLeaseRelease>;
  return ['released', 'failed'].includes(release.status ?? '') &&
    isOptionalNonEmptyString(release.reason);
}

function leaseFailure(lease: QuickProofLease, expectedResource: string, nowMs: number): string | null {
  if (lease.status !== 'trusted') {
    return lease.reason ?? 'The acquired resource lease is untrusted.';
  }
  if (lease.resource !== expectedResource) {
    return 'The acquired resource lease does not match the requested resource.';
  }
  const acquiredAtMs = Date.parse(lease.acquiredAt);
  const expiresAtMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(acquiredAtMs) || !Number.isFinite(expiresAtMs)) {
    return 'The acquired resource lease has malformed lifetime evidence.';
  }
  if (acquiredAtMs > nowMs || expiresAtMs <= nowMs) {
    return 'The acquired resource lease is not active at the mutable boundary.';
  }
  return null;
}

function resultReason(value: unknown, malformedReason?: string): string | undefined {
  if (value && typeof value === 'object' &&
    typeof (value as { reason?: unknown }).reason === 'string' &&
    (value as { reason: string }).reason.length > 0) {
    return (value as { reason: string }).reason;
  }
  return malformedReason;
}

function phaseResultReason(
  value: unknown,
  ok: boolean,
  isValid: (candidate: unknown) => boolean,
  negativeReason: string,
  malformedReason: string,
): string | undefined {
  const explicitReason = resultReason(value);
  if (explicitReason || ok) {
    return explicitReason;
  }
  return isValid(value) ? negativeReason : malformedReason;
}

function errorReason(error: unknown, fallback: string): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.length > 0 ? reason : fallback;
}

function mergeIdentities(current: QuickProofIdentity[], next: QuickProofIdentity[]): QuickProofIdentity[] {
  const merged = new Map(current.map((identity) => [identity.name, { ...identity }]));
  for (const identity of next) {
    const existing = merged.get(identity.name);
    if (existing?.status === 'mismatched' || existing?.status === 'unavailable') {
      continue;
    }
    if (existing?.expected !== undefined && identity.expected !== undefined &&
      existing.expected !== identity.expected) {
      merged.set(identity.name, {
        ...identity,
        status: 'mismatched',
        expected: existing.expected,
        reason: `Adapter expected identity ${identity.expected}, which conflicts with the coordinator expectation.`,
      });
      continue;
    }
    if (existing?.expected !== undefined && identity.status === 'observed' &&
      identity.observed !== existing.expected) {
      merged.set(identity.name, {
        ...identity,
        status: 'mismatched',
        expected: existing.expected,
        reason: `Observed identity ${identity.observed ?? 'unknown'} does not match the coordinator expectation.`,
      });
      continue;
    }
    if (existing?.status === 'observed' && identity.status === 'observed' &&
      existing.observed !== identity.observed) {
      merged.set(identity.name, {
        ...identity,
        status: 'mismatched',
        ...(existing.expected === undefined ? {} : { expected: existing.expected }),
        reason: `Observed identity changed from ${existing.observed} to ${identity.observed} during one adapter attempt.`,
      });
      continue;
    }
    merged.set(identity.name, {
      ...identity,
      ...(existing?.expected === undefined ? {} : { expected: existing.expected }),
    });
  }
  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
}

function identityFailure(
  requirements: Array<{ name: string; expected?: string }>,
  identities: QuickProofIdentity[],
): string | null {
  for (const requirement of requirements) {
    const identity = identities.find((entry) => entry.name === requirement.name);
    if (!identity || identity.status === 'unresolved-until-observed') {
      return `Identity ${requirement.name} remained unresolved after preflight.`;
    }
    if (identity.status !== 'observed') {
      return identity.reason ?? `Identity ${requirement.name} is ${identity.status}.`;
    }
    if (requirement.expected !== undefined && identity.observed !== requirement.expected) {
      return `Identity ${requirement.name} does not match the expected value.`;
    }
  }
  return null;
}

function terminalIdentityFailure(
  requirements: Array<{ name: string; expected?: string }>,
  identities: QuickProofIdentity[],
): string | null {
  const identity = identities.find((entry) =>
    requirements.some((requirement) => requirement.name === entry.name) &&
    (entry.status === 'mismatched' || entry.status === 'unavailable'));
  return identity ? identity.reason ?? `Identity ${identity.name} is ${identity.status}.` : null;
}

function buildQuickProofSummary(artifact: QuickProofArtifact): string {
  const productLine = artifact.product.started === true
    ? `Product action: started (${artifact.product.status ?? 'unknown'})`
    : artifact.product.started === 'unknown'
      ? 'Product action: start state unknown'
      : 'Product action: not started';
  const setupDuration = artifact.budgets.setupDurationMs === null
    ? 'unknown'
    : `${artifact.budgets.setupDurationMs}`;
  const timeToFirstProductAction = artifact.budgets.timeToFirstProductActionMs !== null
    ? `${artifact.budgets.timeToFirstProductActionMs} ms`
    : artifact.product.started === false
      ? 'not started'
      : artifact.product.timingStatus === 'observed-late'
        ? 'observed late; exact time unknown'
        : 'unknown';
  return [
    '# Quick Proof Summary',
    '',
    `Status: ${artifact.status}`,
    `Decision: ${artifact.decision.code}`,
    `Proof tier: ${artifact.proofTier ?? 'none'}`,
    productLine,
    `Time to first product action: ${timeToFirstProductAction}`,
    `Setup duration: ${setupDuration} / ${artifact.budgets.setupMs} ms`,
    `Total duration: ${artifact.budgets.totalDurationMs} / ${artifact.budgets.totalMs} ms`,
    `Cleanup: ${artifact.cleanup.status}`,
    '',
    artifact.status === 'setup-only'
      ? 'This artifact records setup friction only. It is not a product health, runtime, performance, or release verdict.'
      : artifact.status === 'inconclusive'
        ? 'This artifact records an unknown product-start boundary. It is neither setup-only nor product acceptance, and no retry or fallback is allowed.'
        : 'This artifact records coordinator execution only. Product interpretation remains in the scenario health and verdict artifacts.',
    '',
    artifact.decision.reason,
    '',
  ].join('\n');
}

async function writeQuickProofArtifacts(input: {
  outDir: string;
  artifact: QuickProofArtifact;
}): Promise<{ artifactPath: string; summaryPath: string }> {
  const artifactPath = path.join(input.outDir, 'quick-proof.json');
  const summaryPath = path.join(input.outDir, 'agent-summary.md');
  await writeJsonArtifact({
    filePath: artifactPath,
    value: input.artifact,
    schema: SCHEMAS.quickProof,
    label: 'Quick-proof artifact',
  });
  await writeTextArtifact({ filePath: summaryPath, content: buildQuickProofSummary(input.artifact) });
  return { artifactPath, summaryPath };
}

async function coordinateQuickProof(options: QuickProofOptions): Promise<QuickProofArtifact> {
  validateQuickProofOptions(options);
  const now = options.now ?? Date.now;
  const runId = options.runId;
  const scenarioId = options.scenarioId;
  const goalId = options.goalId;
  const source: QuickProofSourceIdentity = {
    revision: options.source.revision,
    packageName: options.source.packageName,
    packageVersion: options.source.packageVersion,
    packageIntegrity: options.source.packageIntegrity,
    ...(options.source.helperIdentity ? { helperIdentity: options.source.helperIdentity } : {}),
  };
  const targetResource = options.targetResource;
  const budgets = { ...options.budgets };
  const authorizationPort = options.authorizationPort
    ? { validate: options.authorizationPort.validate.bind(options.authorizationPort) }
    : undefined;
  const leasePort = options.leasePort
    ? {
        acquire: options.leasePort.acquire.bind(options.leasePort),
        release: options.leasePort.release.bind(options.leasePort),
      }
    : undefined;
  const adapters: QuickProofAdapter[] = options.adapters.map((adapter) => ({
    id: adapter.id,
    tier: adapter.tier,
    discover: adapter.discover.bind(adapter),
    preflight: adapter.preflight.bind(adapter),
    runProduct: adapter.runProduct.bind(adapter),
    cleanup: adapter.cleanup.bind(adapter),
  }));
  const startedMs = now();
  const phases: QuickProofPhase[] = [];
  const identityObservations: QuickProofIdentityObservation[] = [];
  const cleanupFailures: string[] = [];
  const adapterStates: QuickProofArtifact['adapters'] = adapters.map((adapter) => ({
    adapterId: adapter.id,
    tier: adapter.tier,
    attempts: 0,
    status: 'not-attempted',
  }));
  const identityRequirements = options.requirements.identities.map((identity) => ({ ...identity }));
  let identities: QuickProofIdentity[] = identityRequirements.map((identity) => ({
    ...identity,
    status: 'unresolved-until-observed' as const,
  }));
  let authorizationResult: QuickProofAuthorizationResult = { status: 'denied', reason: 'Authorization was not checked.' };
  let leaseState: QuickProofArtifact['lease'] = targetResource
    ? { status: 'not-acquired', resource: targetResource }
    : { status: 'not-required' };
  let selectedTier: QuickProofTier | null = null;
  let productStarted = false;
  let productStartUnknown = false;
  let productStartedAt: number | null = null;
  let productDetectedAt: number | null = null;
  let productTimingStatus: 'exact' | 'observed-late' | null = null;
  let productStatus: 'passed' | 'failed' | undefined;
  const authorizationInput = {
    ...options.authorization,
    operations: [...options.authorization.operations],
    delegationChain: [...options.authorization.delegationChain],
  };
  const authorizationGrant = sanitizeAuthorizationGrant(authorizationInput);
  const operationRequirements = options.requirements.operations.map((requirement) => ({
    operation: requirement.operation,
    requiredArguments: [...requirement.requiredArguments],
  }));

  const record = async <T>(input: {
    name: string;
    adapterId: string;
    attempt: number;
    timeoutMs: number;
    action: (signal: AbortSignal) => Promise<T>;
    success: (value: T) => boolean;
    reason: (value: T, ok: boolean) => string | undefined;
  }): Promise<{ ok: boolean; value?: T; reason?: string; startedMs: number; timedOut: boolean }> => {
    const phaseStarted = now();
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`${input.name} exceeded its ${input.timeoutMs} ms deadline`));
        }, Math.max(1, input.timeoutMs));
      });
      const value = await Promise.race([input.action(controller.signal), timeoutPromise]);
      const phaseEnded = now();
      const ok = input.success(value);
      const reason = input.reason(value, ok) ?? `${input.name} ${ok ? 'passed' : 'failed'}.`;
      phases.push({
        name: input.name,
        adapterId: input.adapterId,
        attempt: input.attempt,
        status: ok ? 'passed' : 'failed',
        startedAt: iso(phaseStarted),
        endedAt: iso(phaseEnded),
        durationMs: Math.max(0, phaseEnded - phaseStarted),
        reason,
      });
      return { ok, value, reason, startedMs: phaseStarted, timedOut: false };
    } catch (error) {
      const phaseEnded = now();
      const reason = errorReason(error, `${input.name} failed without a reason.`);
      phases.push({
        name: input.name,
        adapterId: input.adapterId,
        attempt: input.attempt,
        status: 'failed',
        startedAt: iso(phaseStarted),
        endedAt: iso(phaseEnded),
        durationMs: Math.max(0, phaseEnded - phaseStarted),
        reason,
      });
      return { ok: false, reason, startedMs: phaseStarted, timedOut };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  const elapsed = () => Math.max(0, now() - startedMs);
  const setupRemaining = () => Math.max(1, Math.min(
    budgets.setupMs - elapsed(),
    budgets.totalMs - elapsed(),
  ));
  const totalRemaining = () => Math.max(1, budgets.totalMs - elapsed());
  const setupBudgetFailure = (): QuickProofArtifact['decision'] | null => {
    if (elapsed() >= budgets.setupMs) {
      return { code: 'setup-budget-exceeded', reason: 'Setup exceeded its declared deadline before product work began.' };
    }
    const remainingRatio = Math.max(0, budgets.totalMs - elapsed()) / budgets.totalMs;
    if (remainingRatio < budgets.minimumProductRatio) {
      return {
        code: 'product-budget-reserve-insufficient',
        reason: 'Starting product work would violate the minimum reserved product budget.',
      };
    }
    return null;
  };
  const setupPhaseTimeoutFailure = (phase: { timedOut: boolean }): QuickProofArtifact['decision'] | null => {
    if (!phase.timedOut) {
      return null;
    }
    return setupBudgetFailure() ?? {
      code: 'setup-budget-exceeded',
      reason: 'A bounded setup phase reached its deadline before product work began.',
    };
  };

  const finish = (decision: QuickProofArtifact['decision']): QuickProofArtifact => {
    const endedMs = now();
    return {
      schemaVersion: '1.0.0',
      artifactType: 'quick-proof',
      runId,
      scenarioId,
      goalId,
      source,
      startedAt: iso(startedMs),
      endedAt: iso(endedMs),
      status: productStarted ? 'product-executed' : productStartUnknown ? 'inconclusive' : 'setup-only',
      proofTier: selectedTier,
      budgets: {
        setupMs: budgets.setupMs,
        totalMs: budgets.totalMs,
        minimumProductRatio: budgets.minimumProductRatio,
        setupDurationMs: productStartUnknown || productTimingStatus === 'observed-late'
          ? null
          : productStartedAt === null ? Math.max(0, endedMs - startedMs) : productStartedAt - startedMs,
        totalDurationMs: Math.max(0, endedMs - startedMs),
        timeToFirstProductActionMs: productTimingStatus === 'exact' && productStartedAt !== null
          ? productStartedAt - startedMs
          : null,
      },
      authorization: {
        status: authorizationResult.status,
        grantId: authorizationGrant.grantId,
        goalId: authorizationGrant.goalId,
        operations: Array.from(new Set(authorizationGrant.operations)).sort(),
        delegationDepth: authorizationGrant.delegationChain.length,
        ...(authorizationGrant.targetResource ? { targetResource: authorizationGrant.targetResource } : {}),
        ...(authorizationResult.reason ? { reason: authorizationResult.reason } : {}),
      },
      lease: leaseState,
      identities: identities.map((identity) => ({ ...identity })),
      identityObservations: identityObservations.map((identity) => ({ ...identity })),
      phases: phases.map((phase) => ({ ...phase })),
      adapters: adapterStates.map((state) => ({ ...state })),
      decision,
      product: {
        started: productStartUnknown ? 'unknown' : productStarted,
        ...(productStartedAt === null ? {} : { startedAt: iso(productStartedAt) }),
        ...(productDetectedAt === null ? {} : { detectedAt: iso(productDetectedAt) }),
        ...(productTimingStatus === null ? {} : { timingStatus: productTimingStatus }),
        ...(productStatus ? { status: productStatus } : {}),
      },
      cleanup: {
        status: cleanupFailures.length === 0 ? 'passed' : 'failed',
        failures: [...cleanupFailures],
      },
    };
  };

  const defaultAuthorizationPort = createQuickProofAuthorizationPort();
  const validateAuthorization = async (signal: AbortSignal): Promise<QuickProofAuthorizationResult> => {
    const input = {
      grant: {
        ...authorizationInput,
        operations: [...authorizationInput.operations],
        delegationChain: [...authorizationInput.delegationChain],
      },
      goalId,
      operations: operationRequirements.map((entry) => entry.operation),
      ...(targetResource ? { targetResource } : {}),
      nowMs: now(),
      signal,
    };
    const baseline = await defaultAuthorizationPort.validate(input);
    if (baseline.status === 'denied' || !authorizationPort) {
      return baseline;
    }
    return authorizationPort.validate({ ...input, grant: sanitizeAuthorizationGrant(authorizationGrant) });
  };
  const authPhase = await record({
    name: 'authorization',
    adapterId: 'coordinator',
    attempt: 1,
    timeoutMs: setupRemaining(),
    action: validateAuthorization,
    success: (value) => isAuthorizationResult(value) && value.status === 'authorized',
    reason: (value, ok) => phaseResultReason(
      value, ok, isAuthorizationResult, 'Authorization was denied.', 'Authorization returned a malformed result.'),
  });
  authorizationResult = isAuthorizationResult(authPhase.value)
    ? { ...authPhase.value }
    : { status: 'denied', reason: authPhase.reason ?? 'Authorization validation failed.' };
  if (authPhase.timedOut) {
    return finish({
      code: 'authorization-denied',
      reason: authPhase.reason ?? 'Authorization validation reached its deadline.',
    });
  }
  if (!authPhase.ok) {
    return finish({ code: 'authorization-denied', reason: authorizationResult.reason ?? 'Authorization was denied.' });
  }

  const orderedAdapters = adapters
    .map((adapter, index) => ({ adapter, index }))
    .sort((left, right) => TIER_ORDER[left.adapter.tier] - TIER_ORDER[right.adapter.tier] || left.index - right.index);
  let lastDecision: QuickProofArtifact['decision'] = {
    code: 'adapter-paths-exhausted',
    reason: 'All compatible adapter paths were exhausted before product work began.',
  };

  for (const { adapter } of orderedAdapters) {
    const state = adapterStates.find((entry) => entry.adapterId === adapter.id);
    if (!state) {
      throw new Error(`quick-proof adapter state missing for ${adapter.id}`);
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const openingBudgetFailure = setupBudgetFailure();
      if (openingBudgetFailure) {
        return finish(openingBudgetFailure);
      }
      state.attempts = attempt;
      state.status = 'failed';
      let lease: QuickProofLease | undefined;
      let leaseReference: QuickProofLeaseReference | undefined;
      let leaseRegistrationOpen = true;
      let acquisitionSettled = true;
      let acquisitionTimedOut = false;
      let acquisitionPromise: Promise<QuickProofLease> | undefined;
      const registeredLeaseReferences = new Map<string, QuickProofLeaseReference>();
      type LeaseReleaseResult = {
        reference: QuickProofLeaseReference;
        ok: boolean;
        reason?: string;
      };
      const leaseReleaseTasks = new Map<string, Promise<LeaseReleaseResult>>();
      const leaseReferenceKey = (reference: QuickProofLeaseReference): string =>
        `${reference.resource}\u0000${reference.leaseId}`;
      const releaseRegisteredLease = (reference: QuickProofLeaseReference): Promise<LeaseReleaseResult> => {
        const key = leaseReferenceKey(reference);
        const current = leaseReleaseTasks.get(key);
        if (current) {
          return current;
        }
        if (!leasePort) {
          const result = Promise.resolve({
            reference,
            ok: false,
            reason: 'No lease port was available to release registered ownership.',
          });
          leaseReleaseTasks.set(key, result);
          return result;
        }
        const task = record({
          name: 'lease-release', adapterId: adapter.id, attempt,
          timeoutMs: Math.min(5000, totalRemaining()),
          action: (signal) => leasePort.release({ ...reference }, signal),
          success: (value) => isLeaseRelease(value) && value.status === 'released',
          reason: (value, ok) => phaseResultReason(
            value, ok, isLeaseRelease, 'Lease release failed.', 'Lease release returned a malformed result.'),
        }).then((release) => ({
          reference,
          ok: release.ok,
          ...(release.reason ? { reason: release.reason } : {}),
        }));
        leaseReleaseTasks.set(key, task);
        return task;
      };
      const registerLeaseReference = (acquiredLease: unknown): void => {
        const reference = leaseReferenceFrom(acquiredLease);
        if (!reference) {
          return;
        }
        registeredLeaseReferences.set(leaseReferenceKey(reference), reference);
        leaseReference ??= reference;
        if (!leaseRegistrationOpen) {
          void releaseRegisteredLease(reference);
        }
      };
      let attemptIdentities: QuickProofIdentity[] = identityRequirements.map((identity) => ({
        ...identity,
        status: 'unresolved-until-observed' as const,
      }));
      identities = attemptIdentities;
      const mergeAndRecordIdentityObservations = (
        phase: QuickProofIdentityObservation['phase'],
        phaseIdentities: QuickProofIdentity[],
      ): void => {
        attemptIdentities = mergeIdentities(attemptIdentities, phaseIdentities);
        identities = attemptIdentities;
        for (const phaseIdentity of phaseIdentities) {
          const interpreted = attemptIdentities.find((identity) => identity.name === phaseIdentity.name);
          if (interpreted) {
            identityObservations.push({
              ...interpreted,
              adapterId: adapter.id,
              attempt,
              phase,
            });
          }
        }
      };
      const context = (input: { signal?: AbortSignal } = {}): QuickProofContext => ({
        runId,
        scenarioId,
        goalId,
        source: { ...source },
        authorization: sanitizeAuthorizationGrant(authorizationGrant),
        requirements: operationRequirements.map((requirement) => ({
          operation: requirement.operation,
          requiredArguments: [...requirement.requiredArguments],
        })),
        ...(lease ? { lease: { ...lease } } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const executeAttempt = async (): Promise<{
        terminalDecision?: QuickProofArtifact['decision'];
        fallbackDecision?: QuickProofArtifact['decision'];
      }> => {
        const discovery = await record({
          name: 'capability-discovery',
          adapterId: adapter.id,
          attempt,
          timeoutMs: setupRemaining(),
          action: (signal) => adapter.discover(context({ signal })),
          success: (value) => isDiscoveryResult(value) && value.status === 'passed',
          reason: (value, ok) => phaseResultReason(
            value, ok, isDiscoveryResult, 'Capability discovery failed.',
            'Capability discovery returned a malformed result.'),
        });
        const discoveryTimeoutFailure = setupPhaseTimeoutFailure(discovery);
        if (discoveryTimeoutFailure) {
          return { terminalDecision: discoveryTimeoutFailure };
        }
        if (isDiscoveryResult(discovery.value)) {
          mergeAndRecordIdentityObservations('discovery', discovery.value.identities);
          const terminalFailure = terminalIdentityFailure(identityRequirements, attemptIdentities);
          if (terminalFailure) {
            return { terminalDecision: { code: 'identity-unresolved', reason: terminalFailure } };
          }
        }
        if (!discovery.ok || !isDiscoveryResult(discovery.value)) {
          const reason = discovery.reason ?? 'Capability discovery failed.';
          return { fallbackDecision: { code: 'capability-unavailable', reason } };
        }
        const missingCapability = capabilityFailure(operationRequirements, discovery.value.capabilities);
        if (missingCapability) {
          const recordedAt = now();
          phases.push({
            name: 'capability-validation', adapterId: adapter.id, attempt, status: 'failed',
            startedAt: iso(recordedAt), endedAt: iso(recordedAt), durationMs: 0, reason: missingCapability,
          });
          return { fallbackDecision: { code: 'capability-unavailable', reason: missingCapability } };
        }
        const capabilityRecordedAt = now();
        phases.push({
          name: 'capability-validation', adapterId: adapter.id, attempt, status: 'passed',
          startedAt: iso(capabilityRecordedAt), endedAt: iso(capabilityRecordedAt), durationMs: 0,
          reason: 'Required operation and argument capabilities are available.',
        });

        const discoveryBudgetFailure = setupBudgetFailure();
        if (discoveryBudgetFailure) {
          return { terminalDecision: discoveryBudgetFailure };
        }

        const preflight = await record({
          name: 'preflight', adapterId: adapter.id, attempt,
          timeoutMs: setupRemaining(),
          action: (signal) => adapter.preflight(context({ signal })),
          success: (value) => isPreflightResult(value) && value.status === 'passed',
          reason: (value, ok) => phaseResultReason(
            value, ok, isPreflightResult, 'Adapter preflight failed.', 'Preflight returned a malformed result.'),
        });
        const preflightTimeoutFailure = setupPhaseTimeoutFailure(preflight);
        if (preflightTimeoutFailure) {
          return { terminalDecision: preflightTimeoutFailure };
        }
        if (isPreflightResult(preflight.value)) {
          mergeAndRecordIdentityObservations('preflight', preflight.value.identities);
          const terminalFailure = terminalIdentityFailure(identityRequirements, attemptIdentities);
          if (terminalFailure) {
            return { terminalDecision: { code: 'identity-unresolved', reason: terminalFailure } };
          }
        }
        if (!preflight.ok || !isPreflightResult(preflight.value)) {
          const reason = preflight.reason ?? 'Adapter preflight failed.';
          return { fallbackDecision: { code: 'identity-unresolved', reason } };
        }
        const unresolvedIdentity = identityFailure(identityRequirements, attemptIdentities);
        if (unresolvedIdentity) {
          const decision = { code: 'identity-unresolved' as const, reason: unresolvedIdentity };
          return { fallbackDecision: decision };
        }

        const preflightBudgetFailure = setupBudgetFailure();
        if (preflightBudgetFailure) {
          return { terminalDecision: preflightBudgetFailure };
        }

        if (adapter.tier === 'manual-assisted') {
          selectedTier = adapter.tier;
          state.status = 'selected';
          return {
            terminalDecision: {
              code: 'manual-required',
              reason: 'Manual-assisted execution is required and no automated product action was started.',
            },
          };
        }

        if (targetResource) {
          if (!leasePort) {
            const reason = 'No lease port was supplied for the required resource.';
            return { fallbackDecision: { code: 'lease-unavailable', reason } };
          }
          const preLeaseAuthorization = await record({
            name: 'authorization-pre-lease-revalidation', adapterId: adapter.id, attempt,
            timeoutMs: setupRemaining(),
            action: validateAuthorization,
            success: (value) => isAuthorizationResult(value) && value.status === 'authorized',
            reason: (value, ok) => phaseResultReason(
              value, ok, isAuthorizationResult, 'Authorization revalidation was denied before lease acquisition.',
              'Authorization revalidation returned a malformed result before lease acquisition.'),
          });
          authorizationResult = isAuthorizationResult(preLeaseAuthorization.value)
            ? { ...preLeaseAuthorization.value }
            : {
                status: 'denied',
                reason: preLeaseAuthorization.reason ?? 'Authorization revalidation failed before lease acquisition.',
              };
          if (preLeaseAuthorization.timedOut) {
            return {
              terminalDecision: {
                code: 'authorization-denied',
                reason: preLeaseAuthorization.reason ??
                  'Authorization revalidation reached its deadline before lease acquisition.',
              },
            };
          }
          if (!preLeaseAuthorization.ok) {
            return {
              terminalDecision: {
                code: 'authorization-denied',
                reason: authorizationResult.reason ?? 'Authorization was not valid before lease acquisition.',
              },
            };
          }
          const leasePhase = await record({
            name: 'lease-acquisition', adapterId: adapter.id, attempt,
            timeoutMs: setupRemaining(),
            action: (signal) => {
              acquisitionSettled = false;
              acquisitionPromise = leasePort.acquire({
                resource: targetResource,
                authorization: sanitizeAuthorizationGrant(authorizationGrant),
                signal,
                registerAcquiredLease: registerLeaseReference,
              }).then((value) => {
                acquisitionSettled = true;
                registerLeaseReference(value);
                return value;
              }, (error) => {
                acquisitionSettled = true;
                throw error;
              });
              return acquisitionPromise;
            },
            success: (value) => isLease(value) && leaseFailure(value, targetResource, now()) === null,
            reason: (value) => isLease(value)
              ? leaseFailure(value, targetResource, now()) ?? 'Trusted resource lease acquired.'
              : 'Lease acquisition returned a malformed result.',
          });
          leaseRegistrationOpen = false;
          acquisitionTimedOut = !leasePhase.ok && /deadline/u.test(leasePhase.reason ?? '');
          const acquiredReference = leaseReferenceFrom(leasePhase.value);
          if (acquiredReference) {
            registeredLeaseReferences.set(leaseReferenceKey(acquiredReference), acquiredReference);
            leaseReference ??= acquiredReference;
          }
          if (registeredLeaseReferences.size > 1) {
            return {
              terminalDecision: {
                code: 'lease-unavailable',
                reason: 'Lease acquisition registered multiple ownership references for one requested resource.',
              },
            };
          }
          if (isLease(leasePhase.value)) {
            lease = {
              leaseId: leasePhase.value.leaseId,
              resource: leasePhase.value.resource,
              status: leasePhase.value.status,
              acquiredAt: leasePhase.value.acquiredAt,
              expiresAt: leasePhase.value.expiresAt,
              ...(leasePhase.value.reason ? { reason: leasePhase.value.reason } : {}),
            };
          }
          const leaseTimeoutFailure = setupPhaseTimeoutFailure(leasePhase);
          if (leaseTimeoutFailure) {
            return { terminalDecision: leaseTimeoutFailure };
          }
          if (!leasePhase.ok || !lease) {
            const reason = leasePhase.reason ?? 'The required resource lease was not trusted.';
            leaseState = { status: 'not-acquired', resource: targetResource, reason };
            return { fallbackDecision: { code: 'lease-unavailable', reason } };
          }
        }

        const postLeaseBudgetFailure = setupBudgetFailure();
        if (postLeaseBudgetFailure) {
          return { terminalDecision: postLeaseBudgetFailure };
        }
        const reauthorization = await record({
          name: 'authorization-revalidation', adapterId: adapter.id, attempt,
          timeoutMs: setupRemaining(),
          action: validateAuthorization,
          success: (value) => isAuthorizationResult(value) && value.status === 'authorized',
          reason: (value, ok) => phaseResultReason(
            value, ok, isAuthorizationResult, 'Authorization revalidation was denied.',
            'Authorization revalidation returned a malformed result.'),
        });
        authorizationResult = isAuthorizationResult(reauthorization.value)
          ? { ...reauthorization.value }
          : { status: 'denied', reason: reauthorization.reason ?? 'Authorization revalidation failed.' };
        if (reauthorization.timedOut) {
          return {
            terminalDecision: {
              code: 'authorization-denied',
              reason: reauthorization.reason ?? 'Authorization revalidation reached its deadline.',
            },
          };
        }
        if (!reauthorization.ok) {
          return {
            terminalDecision: {
              code: 'authorization-denied',
              reason: authorizationResult.reason ?? 'Authorization was not valid at the mutable boundary.',
            },
          };
        }
        if (lease && targetResource) {
          const staleLeaseReason = leaseFailure(lease, targetResource, now());
          if (staleLeaseReason) {
            return {
              terminalDecision: { code: 'lease-unavailable', reason: staleLeaseReason },
            };
          }
        }
        const productBudgetFailure = setupBudgetFailure();
        if (productBudgetFailure) {
          return { terminalDecision: productBudgetFailure };
        }

        selectedTier = adapter.tier;
        let markedProductStartedAt: number | null = null;
        let boundaryDecision: QuickProofArtifact['decision'] | null = null;
        let mutableBoundaryOpen = true;
        let mutableBoundaryPromise: Promise<void> | null = null;
        const validateMutableBoundary = (signal: AbortSignal): Promise<void> => {
          if (!mutableBoundaryOpen) {
            return Promise.reject(new Error('The mutable-boundary callback is no longer active for this adapter attempt.'));
          }
          if (mutableBoundaryPromise) {
            return mutableBoundaryPromise;
          }
          mutableBoundaryPromise = (async () => {
            if (!mutableBoundaryOpen) {
              throw new Error('The mutable-boundary callback is no longer active for this adapter attempt.');
            }
            const boundaryStarted = now();
            const failBoundary = (decision: QuickProofArtifact['decision']): never => {
              boundaryDecision = decision;
              const boundaryEnded = now();
              phases.push({
                name: 'mutable-boundary-validation', adapterId: adapter.id, attempt, status: 'failed',
                startedAt: iso(boundaryStarted), endedAt: iso(boundaryEnded),
                durationMs: Math.max(0, boundaryEnded - boundaryStarted), reason: decision.reason,
              });
              throw new Error(decision.reason);
            };
            const boundaryBudgetFailure = setupBudgetFailure();
            if (boundaryBudgetFailure) {
              failBoundary(boundaryBudgetFailure);
            }
            const boundaryAuthorizationPhase = await record({
              name: 'mutable-boundary-authorization', adapterId: adapter.id, attempt,
              timeoutMs: setupRemaining(),
              action: validateAuthorization,
              success: (value) => isAuthorizationResult(value) && value.status === 'authorized',
              reason: (value, ok) => phaseResultReason(
                value, ok, isAuthorizationResult, 'Authorization revalidation was denied at the mutable boundary.',
                'Authorization revalidation returned a malformed result at the mutable boundary.'),
            });
            if (!mutableBoundaryOpen) {
              throw new Error('The mutable-boundary callback expired while authorization was being revalidated.');
            }
            authorizationResult = isAuthorizationResult(boundaryAuthorizationPhase.value)
              ? { ...boundaryAuthorizationPhase.value }
              : {
                  status: 'denied',
                  reason: boundaryAuthorizationPhase.reason ??
                    'Authorization revalidation failed at the mutable boundary.',
                };
            if (!boundaryAuthorizationPhase.ok) {
              failBoundary({
                code: 'authorization-denied',
                reason: authorizationResult.reason ?? 'Authorization was not valid at the mutable boundary.',
              });
            }
            if (lease && targetResource) {
              const boundaryLeaseFailure = leaseFailure(lease, targetResource, now());
              if (boundaryLeaseFailure) {
                failBoundary({ code: 'lease-unavailable', reason: boundaryLeaseFailure });
              }
            }
            const postAuthorizationBudgetFailure = setupBudgetFailure();
            if (postAuthorizationBudgetFailure) {
              failBoundary(postAuthorizationBudgetFailure);
            }
            markedProductStartedAt = now();
            phases.push({
              name: 'mutable-boundary-validation', adapterId: adapter.id, attempt, status: 'passed',
              startedAt: iso(boundaryStarted), endedAt: iso(markedProductStartedAt),
              durationMs: Math.max(0, markedProductStartedAt - boundaryStarted),
              reason: 'Authorization, lease, and budget reserve were valid at the mutable boundary.',
            });
          })();
          return mutableBoundaryPromise;
        };
        const productPhaseStarted = now();
        const productController = new AbortController();
        let productDeadline: NodeJS.Timeout | undefined;
        let rejectProductDeadline: ((error: Error) => void) | undefined;
        let deadlineLabel = 'pre-boundary setup';
        let productDeadlineDecision: QuickProofArtifact['decision'] | null = null;
        const productDeadlinePromise = new Promise<never>((_resolve, reject) => {
          rejectProductDeadline = reject;
        });
        const armProductDeadline = (timeoutMs: number, label: string): void => {
          if (productDeadline) {
            clearTimeout(productDeadline);
          }
          deadlineLabel = label;
          productDeadline = setTimeout(() => {
            if (markedProductStartedAt === null) {
              productDeadlineDecision = setupBudgetFailure() ?? {
                code: 'setup-budget-exceeded',
                reason: 'Product setup reached its deadline before the mutable boundary was crossed.',
              };
            }
            productController.abort();
            rejectProductDeadline?.(new Error(`${label} exceeded its ${timeoutMs} ms deadline`));
          }, Math.max(1, timeoutMs));
        };
        armProductDeadline(setupRemaining(), deadlineLabel);
        let productValue: unknown;
        let productReason: string;
        try {
          productValue = await Promise.race([
            adapter.runProduct({
              ...context({ signal: productController.signal }),
              beginProductAction: async () => {
                if (productDeadline) {
                  clearTimeout(productDeadline);
                  productDeadline = undefined;
                }
                try {
                  await validateMutableBoundary(productController.signal);
                  armProductDeadline(totalRemaining(), 'product execution');
                } catch (error) {
                  if (mutableBoundaryOpen) {
                    armProductDeadline(totalRemaining(), 'post-boundary failure handling');
                  }
                  throw error;
                }
              },
            }),
            productDeadlinePromise,
          ]);
          productReason = isProductResult(productValue)
            ? productValue.reason ?? `Product execution ${productValue.status}.`
            : resultReason(productValue, 'Product execution returned a malformed result.') ??
              'Product execution returned a malformed result.';
        } catch (error) {
          productReason = errorReason(error, 'Product execution failed without a reason.');
        } finally {
          mutableBoundaryOpen = false;
          if (productDeadline) {
            clearTimeout(productDeadline);
          }
        }
        const productPhaseEnded = now();
        const productPhasePassed = isProductResult(productValue) && productValue.status === 'passed' &&
          productValue.productActionStarted && markedProductStartedAt !== null;
        phases.push({
          name: 'product-execution', adapterId: adapter.id, attempt,
          status: productPhasePassed ? 'passed' : 'failed',
          startedAt: iso(productPhaseStarted), endedAt: iso(productPhaseEnded),
          durationMs: Math.max(0, productPhaseEnded - productPhaseStarted),
          reason: productReason,
        });
        const productPhase = { value: productValue, reason: productReason, startedMs: productPhaseStarted };
        const result = productPhase.value;
        const reportedUnmarkedMutation = result && typeof result === 'object' &&
          (result as { productActionStarted?: unknown }).productActionStarted === true &&
          markedProductStartedAt === null;
        if (reportedUnmarkedMutation) {
          productStarted = true;
          productDetectedAt = now();
          productTimingStatus = 'observed-late';
          productStatus = 'failed';
          state.status = 'selected';
          return {
            terminalDecision: {
              code: 'product-failed',
              reason: 'Adapter reported product mutation without passing the mutable-boundary validation callback.',
            },
          };
        }
        if (boundaryDecision) {
          selectedTier = null;
          return { terminalDecision: boundaryDecision };
        }
        if (markedProductStartedAt === null && !isProductResult(result)) {
          selectedTier = null;
          productStartUnknown = true;
          const deadlineDecision = productDeadlineDecision as QuickProofArtifact['decision'] | null;
          const unknownReason = deadlineDecision
            ? `${deadlineDecision.reason} Product-start state is unknown, so retry and fallback are blocked.`
            : `${productPhase.reason} Product-start state is unknown, so retry and fallback are blocked.`;
          return {
            terminalDecision: {
              code: 'adapter-paths-exhausted',
              reason: unknownReason,
            },
          };
        }
        if (markedProductStartedAt === null) {
          selectedTier = null;
          const reason = productPhase.reason ?? 'Adapter returned before any product action started.';
          return { fallbackDecision: { code: 'adapter-paths-exhausted', reason } };
        }
        if (!isProductResult(result) || result.productActionStarted !== true) {
          selectedTier = null;
          productStartUnknown = true;
          productStartedAt = null;
          productTimingStatus = null;
          productStatus = undefined;
          return {
            terminalDecision: {
              code: 'adapter-paths-exhausted',
              reason: `${productPhase.reason} Mutable-boundary validation completed, but the adapter did not confirm that product mutation started.`,
            },
          };
        }
        productStarted = true;
        productStartedAt = markedProductStartedAt;
        productTimingStatus = 'exact';
        productStatus = isProductResult(result) && result.status === 'passed' && result.productActionStarted
          ? 'passed'
          : 'failed';
        state.status = 'selected';
        const reason = isProductResult(result)
          ? result.reason ?? `Product execution ${result.status}.`
          : productPhase.reason ?? 'Product execution failed after the mutable boundary.';
        return {
          terminalDecision: {
            code: productStatus === 'passed' ? 'product-completed' : 'product-failed',
            reason,
          },
        };
      };

      let outcome: {
        terminalDecision?: QuickProofArtifact['decision'];
        fallbackDecision?: QuickProofArtifact['decision'];
      };
      try {
        outcome = await executeAttempt();
      } catch (error) {
        const reason = errorReason(error, 'Adapter attempt failed without a reason.');
        const recordedAt = now();
        phases.push({
          name: 'adapter-result-validation', adapterId: adapter.id, attempt, status: 'failed',
          startedAt: iso(recordedAt), endedAt: iso(recordedAt), durationMs: 0, reason,
        });
        outcome = { fallbackDecision: { code: 'adapter-paths-exhausted', reason } };
      }
      const cleanupFailureCountBefore = cleanupFailures.length;
      const cleanup = await record({
        name: 'adapter-cleanup', adapterId: adapter.id, attempt,
        timeoutMs: Math.min(5000, totalRemaining()),
        action: (signal) => adapter.cleanup(context({ signal })),
        success: (value) => isCleanupResult(value) && value.status === 'passed',
        reason: (value, ok) => phaseResultReason(
          value, ok, isCleanupResult, 'Adapter cleanup failed.', 'Adapter cleanup returned a malformed result.'),
      });
      if (!cleanup.ok) {
        cleanupFailures.push(`${adapter.id} attempt ${attempt}: ${cleanup.reason ?? 'cleanup failed'}`);
      }
      leaseRegistrationOpen = false;
      if (acquisitionPromise && !acquisitionSettled) {
        let acquisitionCleanupTimeout: NodeJS.Timeout | undefined;
        await Promise.race([
          acquisitionPromise.catch(() => undefined),
          new Promise<void>((resolve) => {
            acquisitionCleanupTimeout = setTimeout(resolve, Math.min(5000, totalRemaining()));
          }),
        ]);
        if (acquisitionCleanupTimeout) {
          clearTimeout(acquisitionCleanupTimeout);
        }
        if ((acquisitionTimedOut || !acquisitionSettled) && registeredLeaseReferences.size === 0) {
          cleanupFailures.push(
            `${adapter.id} attempt ${attempt}: timed-out lease acquisition did not settle during cleanup; any late registration will be released immediately.`,
          );
        }
      }
      if (registeredLeaseReferences.size > 1) {
        cleanupFailures.push(`${adapter.id} attempt ${attempt}: lease acquisition registered multiple ownership references.`);
      }
      const releases = await Promise.all(
        Array.from(registeredLeaseReferences.values(), (reference) => releaseRegisteredLease(reference)),
      );
      const failedRelease = releases.find((release) => !release.ok);
      if (leaseReference && releases.length > 0 && !failedRelease) {
        leaseState = { status: 'released', resource: leaseReference.resource, leaseId: leaseReference.leaseId };
      } else if (failedRelease) {
        const reason = failedRelease.reason ?? 'lease release failed';
        leaseState = {
          status: 'release-failed',
          resource: failedRelease.reference.resource,
          leaseId: failedRelease.reference.leaseId,
          reason,
        };
        cleanupFailures.push(`${adapter.id} attempt ${attempt}: ${reason}`);
      }
      if (outcome.terminalDecision) {
        return finish(outcome.terminalDecision);
      }
      if (outcome.fallbackDecision && cleanupFailures.length > cleanupFailureCountBefore) {
        return finish({
          code: 'adapter-paths-exhausted',
          reason: 'Cleanup or lease release failed; fallback is blocked until ownership is resolved.',
        });
      }
      if (outcome.fallbackDecision) {
        lastDecision = outcome.fallbackDecision;
      }
      state.status = 'failed';
      if (outcome.fallbackDecision?.reason) {
        state.reason = outcome.fallbackDecision.reason;
      }
    }
  }

  return finish(lastDecision);
}

export {
  buildQuickProofSummary,
  coordinateQuickProof,
  createQuickProofAuthorizationPort,
  writeQuickProofArtifacts,
};

export type {
  QuickProofAdapter,
  QuickProofArtifact,
  QuickProofAuthorizationGrant,
  QuickProofAuthorizationPort,
  QuickProofCapability,
  QuickProofCleanupResult,
  QuickProofContext,
  QuickProofProductContext,
  QuickProofSourceIdentity,
  QuickProofDiscoveryResult,
  QuickProofIdentity,
  QuickProofIdentityObservation,
  QuickProofLease,
  QuickProofLeaseReference,
  QuickProofLeasePort,
  QuickProofLeaseRelease,
  QuickProofOperationRequirement,
  QuickProofOptions,
  QuickProofPreflightResult,
  QuickProofProductResult,
  QuickProofTier,
};
