import {
  RESOURCE_LEASE_SCHEMA_VERSION,
  acquireResourceLeaseInternal,
  heartbeatResourceLeaseInternal,
  inspectResourceLeaseInternal,
  releaseResourceLeaseInternal,
  runWithResourceLeaseInternal,
} from './resource-lease-internal';

import type {
  ResourceLeaseAcquireOptions,
  ResourceLeaseAcquireResult,
  ResourceLeaseError,
  ResourceLeaseHeartbeatOptions,
  ResourceLeaseHeartbeatResult,
  ResourceLeaseInspectOptions,
  ResourceLeaseInspection,
  ResourceLeasePidLiveness,
  ResourceLeaseRecord,
  ResourceLeaseReleaseOptions,
  ResourceLeaseReleaseResult,
  RunWithResourceLeaseOptions,
  RunWithResourceLeaseResult,
} from './resource-lease-internal';

async function inspectResourceLease(options: ResourceLeaseInspectOptions): Promise<ResourceLeaseInspection> {
  return inspectResourceLeaseInternal(options);
}

async function acquireResourceLease(options: ResourceLeaseAcquireOptions): Promise<ResourceLeaseAcquireResult> {
  return acquireResourceLeaseInternal(options);
}

async function heartbeatResourceLease(options: ResourceLeaseHeartbeatOptions): Promise<ResourceLeaseHeartbeatResult> {
  return heartbeatResourceLeaseInternal(options);
}

async function releaseResourceLease(options: ResourceLeaseReleaseOptions): Promise<ResourceLeaseReleaseResult> {
  return releaseResourceLeaseInternal(options);
}

async function runWithResourceLease<T>(options: RunWithResourceLeaseOptions<T>): Promise<RunWithResourceLeaseResult<T>> {
  return runWithResourceLeaseInternal(options);
}

export { RESOURCE_LEASE_SCHEMA_VERSION, acquireResourceLease, heartbeatResourceLease, inspectResourceLease, releaseResourceLease, runWithResourceLease };

export type {
  ResourceLeaseAcquireOptions,
  ResourceLeaseAcquireResult,
  ResourceLeaseError,
  ResourceLeaseHeartbeatOptions,
  ResourceLeaseHeartbeatResult,
  ResourceLeaseInspectOptions,
  ResourceLeaseInspection,
  ResourceLeasePidLiveness,
  ResourceLeaseRecord,
  ResourceLeaseReleaseOptions,
  ResourceLeaseReleaseResult,
  RunWithResourceLeaseOptions,
  RunWithResourceLeaseResult,
};
