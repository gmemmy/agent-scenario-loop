import {
  buildProviderResourceId,
  buildTcpPortResourceId,
} from './resource-lease';

type ProviderExclusiveResourcePlatform = 'android' | 'ios';
type ProviderExclusiveResourcePhase = 'startWindow' | 'afterCapture' | 'stopWindow' | 'postRun' | 'finalize';
type ProviderExclusiveResourceTargetBinding = 'selected-target';

type ProviderExclusiveResourceClaim = {
  acquireAt: ProviderExclusiveResourcePhase;
  id: string;
  platforms?: ProviderExclusiveResourcePlatform[];
  releaseAfter: ProviderExclusiveResourcePhase;
  resource: ProviderExclusiveResourceDescriptor;
};

type ProviderExclusiveResourceDescriptor =
  | {
      kind: 'provider';
      providerId: string;
      target?: ProviderExclusiveResourceTargetBinding;
    }
  | {
      host: string;
      kind: 'tcpPort';
      port: number;
    };

type ProviderManifestExclusiveResourceShape = {
  exclusiveResources?: ProviderExclusiveResourceClaim[];
  kind?: string;
  platforms?: string[];
  runnerId?: string;
  schemaVersion?: string;
};

type ValidatedProviderExclusiveResourceClaim = ProviderExclusiveResourceClaim;

type ResolvedProviderExclusiveResourceClaim =
  & ValidatedProviderExclusiveResourceClaim
  & {
    providerId: string;
    resourceId: string;
    resolvedResource: (
      | {
          kind: 'provider';
          providerId: string;
          targetId?: string;
        }
      | {
          host: string;
          kind: 'tcpPort';
          port: number;
        }
    );
  };

const PROVIDER_EXCLUSIVE_RESOURCE_PHASES = [
  'startWindow',
  'afterCapture',
  'stopWindow',
  'postRun',
  'finalize',
] as const satisfies readonly ProviderExclusiveResourcePhase[];

const PROVIDER_EXCLUSIVE_RESOURCE_PHASE_ORDER = new Map(
  PROVIDER_EXCLUSIVE_RESOURCE_PHASES.map((phase, index) => [phase, index]),
);

function safeProviderSegment(value: string): string {
  return value.replace(/[^a-z0-9-]+/giu, '-').replace(/^-|-$/gu, '') || 'provider';
}

function resolveEvidenceProviderId({
  manifestPath,
  runnerId,
}: {
  manifestPath: string;
  runnerId?: string;
}): string {
  const fileName = manifestPath.replace(/^.*[\\/]/u, '').replace(/\.json$/u, '');
  return safeProviderSegment(String(runnerId ?? fileName));
}

function ensureNonEmptyString(value: string, label: string, providerId: string, claimId: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Evidence provider \`${providerId}\` exclusiveResources[${claimId}] requires string ${label}.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Evidence provider \`${providerId}\` exclusiveResources[${claimId}] requires non-empty ${label}.`);
  }
  return normalized;
}

function ensureIntegerInRange({
  claimId,
  label,
  max,
  min,
  providerId,
  value,
}: {
  claimId: string;
  label: string;
  max: number;
  min: number;
  providerId: string;
  value: unknown;
}): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `Evidence provider \`${providerId}\` exclusiveResources[${claimId}] requires integer ${label} between ${min} and ${max}.`,
    );
  }
  return value;
}

function normalizePlatforms(
  platforms: readonly string[] | undefined,
  providerId: string,
  claimId: string,
): ProviderExclusiveResourcePlatform[] | undefined {
  if (platforms === undefined) {
    return undefined;
  }
  const normalized = platforms.map((platform) => {
    if (platform !== 'android' && platform !== 'ios') {
      throw new Error(
        `Evidence provider \`${providerId}\` exclusiveResources[${claimId}] declares unsupported platform \`${platform}\`.`,
      );
    }
    return platform;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Evidence provider \`${providerId}\` exclusiveResources[${claimId}] declares duplicate platforms.`);
  }
  return normalized;
}

function normalizeClaimResource({
  claim,
  providerId,
}: {
  claim: ProviderExclusiveResourceClaim;
  providerId: string;
}): ProviderExclusiveResourceDescriptor {
  if (claim.resource.kind === 'provider') {
    const resourceProviderId = ensureNonEmptyString(claim.resource.providerId, 'resource.providerId', providerId, claim.id);
    if (claim.resource.target !== undefined && claim.resource.target !== 'selected-target') {
      throw new Error(
        `Evidence provider \`${providerId}\` exclusiveResources[${claim.id}] declares unsupported provider target binding \`${String(claim.resource.target)}\`.`,
      );
    }
    return {
      kind: 'provider',
      providerId: resourceProviderId,
      ...(claim.resource.target ? { target: claim.resource.target } : {}),
    };
  }

  const host = ensureNonEmptyString(claim.resource.host, 'resource.host', providerId, claim.id);
  const port = ensureIntegerInRange({
    claimId: claim.id,
    label: 'resource.port',
    max: 65_535,
    min: 1,
    providerId,
    value: claim.resource.port,
  });
  return {
    kind: 'tcpPort',
    host,
    port,
  };
}

function normalizeProviderExclusiveResourceClaim({
  claim,
  manifestPlatforms,
  providerId,
}: {
  claim: ProviderExclusiveResourceClaim;
  manifestPlatforms: readonly string[] | undefined;
  providerId: string;
}): ValidatedProviderExclusiveResourceClaim {
  ensureNonEmptyString(claim.id, 'id', providerId, claim.id || '<unknown>');
  const claimPlatforms = normalizePlatforms(claim.platforms, providerId, claim.id);
  if (claimPlatforms && Array.isArray(manifestPlatforms)) {
    const unsupportedPlatform = claimPlatforms.find((platform) => !manifestPlatforms.includes(platform));
    if (unsupportedPlatform) {
      throw new Error(
        `Evidence provider \`${providerId}\` exclusiveResources[${claim.id}] platform \`${unsupportedPlatform}\` is outside manifest.platforms.`,
      );
    }
  }
  const acquireOrder = PROVIDER_EXCLUSIVE_RESOURCE_PHASE_ORDER.get(claim.acquireAt);
  const releaseOrder = PROVIDER_EXCLUSIVE_RESOURCE_PHASE_ORDER.get(claim.releaseAfter);
  if (acquireOrder === undefined || releaseOrder === undefined) {
    throw new Error(
      `Evidence provider \`${providerId}\` exclusiveResources[${claim.id}] must use live-window phases ${PROVIDER_EXCLUSIVE_RESOURCE_PHASES.join(', ')}.`,
    );
  }
  if (acquireOrder > releaseOrder) {
    throw new Error(
      `Evidence provider \`${providerId}\` exclusiveResources[${claim.id}] cannot release before it acquires (${claim.acquireAt} -> ${claim.releaseAfter}).`,
    );
  }
  const resource = normalizeClaimResource({ claim, providerId });
  if (resource.kind === 'provider' && resource.providerId === 'self') {
    return {
      ...claim,
      resource: {
        ...resource,
        providerId: 'self',
      },
      ...(claimPlatforms ? { platforms: claimPlatforms } : {}),
    };
  }
  if (resource.kind === 'provider') {
    return {
      ...claim,
      resource,
      ...(claimPlatforms ? { platforms: claimPlatforms } : {}),
    };
  }
  buildTcpPortResourceId({ host: resource.host, port: resource.port });
  return {
    ...claim,
    resource,
    ...(claimPlatforms ? { platforms: claimPlatforms } : {}),
  };
}

function resolveStaticClaimKey({
  claim,
  providerId,
}: {
  claim: ValidatedProviderExclusiveResourceClaim;
  providerId: string;
}): string {
  const resourceKey = claim.resource.kind === 'provider'
    ? `provider:${claim.resource.providerId === 'self' ? providerId : claim.resource.providerId}:${claim.resource.target ?? 'provider-wide'}`
    : `tcp-port:${claim.resource.host.trim().toLowerCase()}:${claim.resource.port}`;
  const platformsKey = claim.platforms ? [...claim.platforms].sort().join(',') : 'all-platforms';
  return `${resourceKey}:${claim.acquireAt}:${claim.releaseAfter}:${platformsKey}`;
}

function validateProviderExclusiveResources({
  manifest,
  manifestPath,
  providerId,
}: {
  manifest: ProviderManifestExclusiveResourceShape;
  manifestPath: string;
  providerId?: string;
}): ValidatedProviderExclusiveResourceClaim[] {
  const resolvedProviderId = providerId ?? resolveEvidenceProviderId({
    manifestPath,
    ...(manifest.runnerId ? { runnerId: manifest.runnerId } : {}),
  });
  const claims = Array.isArray(manifest.exclusiveResources) ? manifest.exclusiveResources : [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const normalizedClaims: ValidatedProviderExclusiveResourceClaim[] = [];

  for (const rawClaim of claims) {
    const claim = normalizeProviderExclusiveResourceClaim({
      claim: rawClaim,
      manifestPlatforms: manifest.platforms,
      providerId: resolvedProviderId,
    });
    if (seenIds.has(claim.id)) {
      throw new Error(`Evidence provider \`${resolvedProviderId}\` declares duplicate exclusiveResources id \`${claim.id}\`.`);
    }
    seenIds.add(claim.id);
    const staticKey = resolveStaticClaimKey({ claim, providerId: resolvedProviderId });
    if (seenKeys.has(staticKey)) {
      throw new Error(
        `Evidence provider \`${resolvedProviderId}\` declares duplicate exclusive resource claim \`${claim.id}\` for the same resource window.`,
      );
    }
    seenKeys.add(staticKey);
    normalizedClaims.push(claim);
  }

  return normalizedClaims;
}

function claimAppliesToPlatform(
  claim: ValidatedProviderExclusiveResourceClaim,
  platform: ProviderExclusiveResourcePlatform,
): boolean {
  return claim.platforms === undefined || claim.platforms.includes(platform);
}

function resolveProviderExclusiveResourceClaims({
  claims,
  platform,
  providerId,
  targetId,
}: {
  claims: readonly ValidatedProviderExclusiveResourceClaim[];
  platform: ProviderExclusiveResourcePlatform;
  providerId: string;
  targetId?: string;
}): ResolvedProviderExclusiveResourceClaim[] {
  return claims
    .filter((claim) => claimAppliesToPlatform(claim, platform))
    .map((claim) => {
      if (claim.resource.kind === 'provider') {
        const resolvedProviderId = claim.resource.providerId === 'self'
          ? providerId
          : claim.resource.providerId;
        if (claim.resource.target === 'selected-target') {
          const resolvedTargetId = targetId?.trim();
          if (!resolvedTargetId) {
            throw new Error(
              `Evidence provider \`${providerId}\` exclusiveResources[${claim.id}] requires an exact selected target identity.`,
            );
          }
          return {
            ...claim,
            providerId,
            resolvedResource: {
              kind: 'provider' as const,
              providerId: resolvedProviderId,
              targetId: resolvedTargetId,
            },
            resourceId: buildProviderResourceId({
              providerId: resolvedProviderId,
              targetId: resolvedTargetId,
            }),
          };
        }
        return {
          ...claim,
          providerId,
          resolvedResource: {
            kind: 'provider' as const,
            providerId: resolvedProviderId,
          },
          resourceId: buildProviderResourceId({ providerId: resolvedProviderId }),
        };
      }

      return {
        ...claim,
        providerId,
        resolvedResource: {
          host: claim.resource.host,
          kind: 'tcpPort' as const,
          port: claim.resource.port,
        },
        resourceId: buildTcpPortResourceId({
          host: claim.resource.host,
          port: claim.resource.port,
        }),
      };
    })
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
}

export {
  PROVIDER_EXCLUSIVE_RESOURCE_PHASES,
  resolveEvidenceProviderId,
  resolveProviderExclusiveResourceClaims,
  validateProviderExclusiveResources,
};

export type {
  ProviderExclusiveResourceClaim,
  ProviderExclusiveResourceDescriptor,
  ProviderExclusiveResourcePhase,
  ProviderExclusiveResourcePlatform,
  ProviderExclusiveResourceTargetBinding,
  ProviderManifestExclusiveResourceShape,
  ResolvedProviderExclusiveResourceClaim,
  ValidatedProviderExclusiveResourceClaim,
};
