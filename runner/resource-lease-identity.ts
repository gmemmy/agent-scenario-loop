import { createHash } from 'node:crypto';
import path from 'node:path';

type MobileTargetPlatform = 'android' | 'ios';

function requireIdentitySegment(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return encodeURIComponent(normalized);
}

function buildMobileTargetResourceId({
  platform,
  targetId,
}: {
  platform: MobileTargetPlatform;
  targetId: string;
}): string {
  return `mobile-target:${platform}:${requireIdentitySegment(targetId, 'targetId')}`;
}

function buildTcpPortResourceId({ host, port }: { host: string; port: number }): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer between 1 and 65535.');
  }
  const normalizedHost = host.trim().replace(/^\[|\]$/gu, '').toLowerCase();
  return `tcp-port:${requireIdentitySegment(normalizedHost, 'host')}:${port}`;
}

function buildProviderResourceId({
  providerId,
  targetId,
}: {
  providerId: string;
  targetId?: string;
}): string {
  const providerSegment = requireIdentitySegment(providerId, 'providerId');
  return targetId
    ? `provider:${providerSegment}:${requireIdentitySegment(targetId, 'targetId')}`
    : `provider:${providerSegment}`;
}

function resolveResourceLeasePath({ leaseRoot, resourceId }: { leaseRoot: string; resourceId: string }): string {
  const normalizedRoot = leaseRoot.trim();
  if (normalizedRoot.length === 0) {
    throw new Error('leaseRoot must be a non-empty string.');
  }
  const normalizedResourceId = resourceId.trim();
  if (normalizedResourceId.length === 0) {
    throw new Error('resourceId must be a non-empty string.');
  }
  const digest = createHash('sha256').update(normalizedResourceId, 'utf8').digest('hex');
  return path.join(normalizedRoot, `${digest}.json`);
}

export {
  buildMobileTargetResourceId,
  buildProviderResourceId,
  buildTcpPortResourceId,
  resolveResourceLeasePath,
};

export type { MobileTargetPlatform };
