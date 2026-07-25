const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { SCHEMAS, validateJson } = require('../../core/schema-validator');
const {
  resolveProviderExclusiveResourceClaims,
  validateProviderExclusiveResources,
} = require('../provider-exclusive-resources');

test('runner capabilities schema keeps 1.0.0 providers compatible and accepts 1.1.0 exclusive resources', () => {
  const providerV100 = {
    schemaVersion: '1.0.0',
    runnerId: 'legacy-provider',
    kind: 'evidenceProvider',
    platforms: ['android'],
    capabilities: ['profiler'],
    lifecycle: ['capture'],
    providerCommands: [
      {
        id: 'capture-profiler',
        phase: 'capture',
        command: 'node',
        outputs: [],
      },
    ],
  };
  const providerV110 = {
    schemaVersion: '1.1.0',
    runnerId: 'exclusive-provider',
    kind: 'evidenceProvider',
    platforms: ['android'],
    capabilities: ['profiler'],
    lifecycle: ['startWindow', 'stopWindow'],
    exclusiveResources: [
      {
        id: 'provider-target',
        acquireAt: 'startWindow',
        releaseAfter: 'stopWindow',
        resource: {
          kind: 'provider',
          providerId: 'self',
          target: 'selected-target',
        },
      },
    ],
    providerCommands: [
      {
        id: 'start-profiler',
        phase: 'startWindow',
        command: 'node',
        outputs: [],
      },
      {
        id: 'stop-profiler',
        phase: 'stopWindow',
        command: 'node',
        outputs: [],
      },
    ],
  };

  assert.equal(validateJson(providerV100, SCHEMAS.runnerCapabilities, 'provider-v100').valid, true);
  assert.equal(validateJson(providerV110, SCHEMAS.runnerCapabilities, 'provider-v110').valid, true);
});

test('runner capabilities schema rejects exclusive resources on primary manifests and version 1.0.0 manifests', () => {
  const primaryManifest = {
    schemaVersion: '1.1.0',
    runnerId: 'primary-runner',
    kind: 'primary',
    platforms: ['ios'],
    capabilities: ['launch'],
    exclusiveResources: [
      {
        id: 'bad-primary-claim',
        acquireAt: 'startWindow',
        releaseAfter: 'stopWindow',
        resource: {
          kind: 'provider',
          providerId: 'self',
        },
      },
    ],
  };
  const legacyProviderManifest = {
    schemaVersion: '1.0.0',
    runnerId: 'legacy-provider',
    kind: 'evidenceProvider',
    platforms: ['ios'],
    capabilities: ['profiler'],
    exclusiveResources: [
      {
        id: 'too-new',
        acquireAt: 'startWindow',
        releaseAfter: 'stopWindow',
        resource: {
          kind: 'provider',
          providerId: 'self',
        },
      },
    ],
  };

  const primaryValidation = validateJson(primaryManifest, SCHEMAS.runnerCapabilities, 'primary');
  const legacyValidation = validateJson(legacyProviderManifest, SCHEMAS.runnerCapabilities, 'legacy');
  assert.equal(primaryValidation.valid, false);
  assert.match(primaryValidation.message, /exclusiveResources/u);
  assert.equal(legacyValidation.valid, false);
  assert.match(legacyValidation.message, /exclusiveResources/u);
});

test('exclusive resource validation rejects duplicate claims', () => {
  assert.throws(
    () => validateProviderExclusiveResources({
      manifest: {
        schemaVersion: '1.1.0',
        runnerId: 'dup-provider',
        kind: 'evidenceProvider',
        platforms: ['android'],
        exclusiveResources: [
          {
            id: 'same-resource-a',
            acquireAt: 'startWindow',
            releaseAfter: 'stopWindow',
            resource: {
              kind: 'provider',
              providerId: 'self',
              target: 'selected-target',
            },
          },
          {
            id: 'same-resource-b',
            acquireAt: 'startWindow',
            releaseAfter: 'stopWindow',
            resource: {
              kind: 'provider',
              providerId: 'dup-provider',
              target: 'selected-target',
            },
          },
        ],
      },
      manifestPath: path.join('/tmp', 'provider.json'),
      providerId: 'dup-provider',
    }),
    /duplicate exclusive resource claim/u,
  );
});

test('runner capabilities schema rejects invalid phases and mobile-target redeclaration', () => {
  const invalidPhaseManifest = {
    schemaVersion: '1.1.0',
    runnerId: 'phase-provider',
    kind: 'evidenceProvider',
    platforms: ['android'],
    capabilities: ['profiler'],
    exclusiveResources: [
      {
        id: 'invalid-phase',
        acquireAt: 'prepare',
        releaseAfter: 'stopWindow',
        resource: {
          kind: 'provider',
          providerId: 'self',
        },
      },
    ],
  };
  const mobileTargetManifest = {
    schemaVersion: '1.1.0',
    runnerId: 'target-provider',
    kind: 'evidenceProvider',
    platforms: ['ios'],
    capabilities: ['profiler'],
    exclusiveResources: [
      {
        id: 'bad-kind',
        acquireAt: 'startWindow',
        releaseAfter: 'finalize',
        resource: {
          kind: 'mobileTarget',
          targetId: 'booted',
        },
      },
    ],
  };

  const invalidPhase = validateJson(invalidPhaseManifest, SCHEMAS.runnerCapabilities, 'invalid-phase');
  const mobileTarget = validateJson(mobileTargetManifest, SCHEMAS.runnerCapabilities, 'mobile-target');
  assert.equal(invalidPhase.valid, false);
  assert.match(invalidPhase.message, /startWindow/u);
  assert.equal(mobileTarget.valid, false);
  assert.match(mobileTarget.message, /provider|tcpPort/u);
});

test('runner capabilities schema rejects malformed exclusive resource descriptors and runtime validation fails closed', () => {
  const missingProviderIdManifest = {
    schemaVersion: '1.1.0',
    runnerId: 'missing-provider-id',
    kind: 'evidenceProvider',
    platforms: ['android'],
    capabilities: ['profiler'],
    exclusiveResources: [
      {
        id: 'provider-without-id',
        acquireAt: 'startWindow',
        releaseAfter: 'stopWindow',
        resource: {
          kind: 'provider',
        },
      },
    ],
  };
  const missingTcpPortFieldsManifest = {
    schemaVersion: '1.1.0',
    runnerId: 'missing-tcp-port-fields',
    kind: 'evidenceProvider',
    platforms: ['android'],
    capabilities: ['profiler'],
    exclusiveResources: [
      {
        id: 'port-without-host',
        acquireAt: 'startWindow',
        releaseAfter: 'stopWindow',
        resource: {
          kind: 'tcpPort',
        },
      },
    ],
  };

  const providerSchemaValidation = validateJson(
    missingProviderIdManifest,
    SCHEMAS.runnerCapabilities,
    'missing-provider-id',
  );
  const tcpPortSchemaValidation = validateJson(
    missingTcpPortFieldsManifest,
    SCHEMAS.runnerCapabilities,
    'missing-tcp-port-fields',
  );
  assert.equal(providerSchemaValidation.valid, false);
  assert.equal(tcpPortSchemaValidation.valid, false);
  assert.match(providerSchemaValidation.message, /providerId/u);
  assert.match(tcpPortSchemaValidation.message, /host|port/u);

  assert.throws(
    () => validateProviderExclusiveResources({
      manifest: missingProviderIdManifest,
      manifestPath: path.join('/tmp', 'missing-provider-id.json'),
      providerId: 'missing-provider-id',
    }),
    /requires string resource\.providerId/u,
  );
  assert.throws(
    () => validateProviderExclusiveResources({
      manifest: missingTcpPortFieldsManifest,
      manifestPath: path.join('/tmp', 'missing-tcp-port-fields.json'),
      providerId: 'missing-tcp-port-fields',
    }),
    /requires string resource\.host/u,
  );
});

test('exclusive resource resolution rejects impossible selected-target binding', () => {
  const claims = validateProviderExclusiveResources({
    manifest: {
      schemaVersion: '1.1.0',
      runnerId: 'binding-provider',
      kind: 'evidenceProvider',
      platforms: ['android'],
      exclusiveResources: [
        {
          id: 'needs-target',
          acquireAt: 'startWindow',
          releaseAfter: 'finalize',
          resource: {
            kind: 'provider',
            providerId: 'self',
            target: 'selected-target',
          },
        },
      ],
    },
    manifestPath: path.join('/tmp', 'binding-provider.json'),
    providerId: 'binding-provider',
  });

  assert.throws(
    () => resolveProviderExclusiveResourceClaims({
      claims,
      platform: 'android',
      providerId: 'binding-provider',
    }),
    /exact selected target identity/u,
  );
});
