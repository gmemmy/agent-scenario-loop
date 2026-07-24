const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  buildMobileTargetResourceId,
  buildProviderResourceId,
  buildTcpPortResourceId,
  resolveResourceLeasePath,
} = require('../resource-lease');

test('resource identities are canonical and product-neutral', () => {
  assert.equal(
    buildMobileTargetResourceId({ platform: 'android', targetId: ' emulator-5554 ' }),
    'mobile-target:android:emulator-5554',
  );
  assert.equal(
    buildMobileTargetResourceId({ platform: 'ios', targetId: 'A B/C' }),
    'mobile-target:ios:A%20B%2FC',
  );
  assert.equal(
    buildTcpPortResourceId({ host: '[LOCALHOST]', port: 8081 }),
    'tcp-port:localhost:8081',
  );
  assert.equal(buildProviderResourceId({ providerId: 'xctrace' }), 'provider:xctrace');
  assert.equal(
    buildProviderResourceId({ providerId: 'native profiler', targetId: 'device/1' }),
    'provider:native%20profiler:device%2F1',
  );
});

test('resource lease paths are stable hashes without raw resource identifiers', () => {
  const leaseRoot = path.join('/tmp', 'asl-resource-leases');
  const resourceId = buildMobileTargetResourceId({ platform: 'android', targetId: 'emulator-5554' });
  const first = resolveResourceLeasePath({ leaseRoot, resourceId });
  const second = resolveResourceLeasePath({ leaseRoot, resourceId });
  const other = resolveResourceLeasePath({
    leaseRoot,
    resourceId: buildMobileTargetResourceId({ platform: 'android', targetId: 'emulator-5556' }),
  });

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(path.dirname(first), leaseRoot);
  assert.match(path.basename(first), /^[a-f0-9]{64}\.json$/u);
  assert.equal(first.includes('emulator-5554'), false);
});

test('resource identity builders reject ambiguous input', () => {
  assert.throws(() => buildMobileTargetResourceId({ platform: 'ios', targetId: '  ' }), /targetId/u);
  assert.throws(() => buildTcpPortResourceId({ host: '', port: 8081 }), /host/u);
  assert.throws(() => buildTcpPortResourceId({ host: 'localhost', port: 0 }), /port/u);
  assert.throws(() => buildProviderResourceId({ providerId: '' }), /providerId/u);
});
