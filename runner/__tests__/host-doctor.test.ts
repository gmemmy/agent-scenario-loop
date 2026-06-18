const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseRequirements,
  runHostDoctor,
} = require('../host-doctor');

type TestContext = import('node:test').TestContext;

/**
 * Reads a JSON file from disk.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Builds a minimal child preflight result for the host doctor.
 *
 * @param {{healthStatus?: 'failed' | 'passed', runDir: string}} options
 * @returns {Record<string, unknown>}
 */
function childPreflight({
  healthStatus = 'passed',
  runDir,
}: {
  healthStatus?: 'failed' | 'passed';
  runDir: string;
}): Record<string, unknown> {
  return {
    health: {
      schemaVersion: '1.0.0',
      scenarioId: 'child-preflight',
      runId: path.basename(runDir),
      healthStatus,
      checks: [
        {
          name: 'child_check',
          status: healthStatus,
          source: 'runner',
          code: healthStatus === 'passed' ? 'child_passed' : 'child_failed',
          message: healthStatus === 'passed' ? 'child passed' : 'child failed',
          ...(healthStatus === 'failed'
            ? {
                metadata: {
                  nextAction: 'Rerun with host access.',
                  nextActionCode: 'rerun_with_host_access',
                },
              }
            : {}),
        },
      ],
    },
    runDir,
    verdict: {
      schemaVersion: '1.0.0',
      scenarioId: 'child-preflight',
      runId: path.basename(runDir),
      healthStatus,
      verdictStatus: healthStatus === 'passed' ? 'not_evaluated' : 'inconclusive',
      budgetChecks: [],
      summary: 'child preflight',
    },
  };
}

test('host doctor writes passed ASL artifacts for requested host lanes', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-passed-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const result = await runHostDoctor({
    agentDeviceAvailability: async () => ({
      agentDevicePath: 'agent-device',
      checks: [],
      devices: [],
      requiredCommands: [],
      requiredPlatforms: ['android', 'ios'],
      status: 'passed',
    }),
    androidPreflight: async (options: {outputDir: string}) => childPreflight({ runDir: options.outputDir }),
    argentAvailability: async () => ({
      argentCommand: 'pnpm',
      baseArgs: ['dlx', '@swmansion/argent', 'run'],
      checks: [],
      requiredTools: [],
      status: 'passed',
    }),
    iosPreflight: async (options: {outputDir: string}) => childPreflight({ runDir: options.outputDir }),
    outputDir: tempDir,
    requirements: ['android', 'ios', 'agent-device', 'argent'],
    runId: 'host-doctor-pass',
  });

  assert.equal(result.runDir, tempDir);
  assert.equal(result.health.healthStatus, 'passed');
  assert.equal(readJson(path.join(tempDir, 'health.json')).healthStatus, 'passed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'not_evaluated');
  assert.equal(fs.existsSync(path.join(tempDir, 'agent-summary.md')), true);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /## host checks/u);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /android_adb: passed/u);
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /argent: passed/u);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'host-doctor.json')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'agent-device-check.json')), true);
  assert.equal(fs.existsSync(path.join(tempDir, 'raw', 'argent-check.json')), true);
  assert.deepEqual(
    (result.health.checks as Array<{name: string; status: string}>).map((check) => [check.name, check.status]),
    [
      ['android_adb', 'passed'],
      ['ios_simctl', 'passed'],
      ['agent_device', 'passed'],
      ['argent', 'passed'],
    ],
  );
});

test('host doctor fails health when a required sidecar command surface fails', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-failed-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const result = await runHostDoctor({
    agentDeviceAvailability: async () => ({
      agentDevicePath: 'agent-device',
      checks: [
        {
          args: ['devices', '--json'],
          code: 'agent_device_devices_available',
          command: 'agent-device',
          exitCode: 1,
          message: 'agent-device did not return any discoverable devices.',
          name: 'agent_device_devices',
          status: 'failed',
        },
      ],
      devices: [],
      requiredCommands: [],
      requiredPlatforms: ['android'],
      status: 'failed',
    }),
    androidPreflight: async (options: {outputDir: string}) => childPreflight({ runDir: options.outputDir }),
    outputDir: tempDir,
    requirements: ['android', 'agent-device'],
    runId: 'host-doctor-failed',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'inconclusive');
  assert.match(fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8'), /Do not optimize from this run/u);
  assert.deepEqual(
    (health.checks as Array<{name: string; status: string}>).map((check) => [check.name, check.status]),
    [
      ['android_adb', 'passed'],
      ['agent_device', 'failed'],
    ],
  );
  assert.equal(readJson(path.join(tempDir, 'raw', 'agent-device-check.json')).status, 'failed');
});

test('host doctor requirement parser defaults to platform lanes and rejects unknown lanes', () => {
  assert.deepEqual(parseRequirements(undefined), ['android', 'ios']);
  assert.deepEqual(parseRequirements('android,ios,agent-device,argent'), ['android', 'ios', 'agent-device', 'argent']);
  assert.throws(() => parseRequirements('android,maestro'), /Unsupported host doctor requirement/u);
});
