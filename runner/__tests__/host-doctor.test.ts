const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseExclusiveProcessTargets,
  parseDiskSpaceTargets,
  parseLeaseTargets,
  parseOrphanProcessTargets,
  parseTcpPortTargets,
  parseRequirements,
  runHostDoctor,
} = require('../host-doctor');
const { findExclusiveProcessMatches } = require('../host-process-matching');

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

test('exclusive process matcher ignores current pid when it is the only candidate', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = '710 xctrace record --template Time\\ Profiler';
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 710,
    processListText: fixture,
    target,
  }), []);
});

test('exclusive process matcher suppresses host-doctor echoes across supported command-position forms', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixtures = [
    '400 asl-host-doctor --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor',
    '401 pnpm asl-host-doctor --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor',
    '402 pnpm exec asl-host-doctor --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor',
    '403 node dist/runner/host-doctor.js --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor',
    '404 sh -lc pnpm asl-host-doctor --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor',
    '405 sh -lc "pnpm asl-host-doctor --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor"',
    '406 ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES=xctrace:xctrace pnpm exec asl-host-doctor --out artifacts/asl/host-doctor',
  ];
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixtures.join('\n'),
    target,
  }), []);
});

test('exclusive process matcher suppresses wrapper-only host-doctor --exclusive-process echoes', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const wrapperOnlyFixture = [
    '410 /bin/sh -lc pnpm asl-host-doctor --exclusive-process xctrace:xctrace --out artifacts/asl/host-doctor',
    '411 node runner/host-doctor.js --exclusive-process xctrace:xctrace --run-id host-doctor',
  ].join('\n');
  const oldPolicyMatches = wrapperOnlyFixture
    .split('\n')
    .filter(Boolean)
    .filter((line) => line.toLowerCase().includes(target.pattern.toLowerCase()));
  assert.equal(oldPolicyMatches.length, 2);
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: wrapperOnlyFixture,
    target,
  }), []);
});

test('exclusive process matcher suppresses quoted host-doctor --exclusive-process echoes', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 777,
    processListText: [
      '610 /bin/sh -lc pnpm asl-host-doctor --exclusive-process xctrace:xctrace',
      '611 bash -lc node runner/host-doctor.js --exclusive-process "xctrace:xctrace"',
    ].join('\n'),
    target,
  }), []);
});

test('exclusive process matcher keeps one genuine non-wrapper match', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 710,
    processListText: [
      '710 xctrace record --template Time\\ Profiler',
      '711 xctrace screenshot --output /tmp/frame.png',
    ].join('\n'),
    target,
  }), [
    { command: 'xctrace screenshot --output /tmp/frame.png', pid: 711 },
  ]);
});

test('exclusive process matcher keeps multiple genuine matches and ignores malformed rows', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    'not-a-process-line',
    '510 /bin/sh -lc pnpm asl-host-doctor --exclusive-process xctrace:xctrace',
    '511 xctrace record --template Time\\ Profiler',
    '512 xctrace screenshot --output /tmp/frame.png',
    '513 xctrace record --template Time\\ Profiler --note xctrace:xctrace',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 511,
    processListText: fixture,
    target,
  }), [
    { command: 'xctrace screenshot --output /tmp/frame.png', pid: 512 },
    { command: 'xctrace record --template Time\\ Profiler --note xctrace:xctrace', pid: 513 },
  ]);
});

test('exclusive process matcher keeps unrelated literal hits outside host-doctor carriers', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '801 xctrace:xctrace',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), [
    { command: 'xctrace:xctrace', pid: 801 },
  ]);
});

test('exclusive process matcher does not sanitize non-host config text containing host-doctor literals', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '801 other-cli --config asl-host-doctor --exclusive-process xctrace:xctrace',
    '802 other-cli --config host-doctor.js --exclusive-process xctrace:xctrace',
    '803 node tools/other-cli.js --exclusive-process xctrace:xctrace --config host-doctor-notes',
    '804 node tools/other-cli.js --exclusive-process xctrace:xctrace --config host-doctor.js',
    '805 node tools/other-cli.js --config node host-doctor.js --exclusive-process xctrace:xctrace',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), [
    { command: 'other-cli --config asl-host-doctor --exclusive-process xctrace:xctrace', pid: 801 },
    { command: 'other-cli --config host-doctor.js --exclusive-process xctrace:xctrace', pid: 802 },
    { command: 'node tools/other-cli.js --exclusive-process xctrace:xctrace --config host-doctor-notes', pid: 803 },
    { command: 'node tools/other-cli.js --exclusive-process xctrace:xctrace --config host-doctor.js', pid: 804 },
    { command: 'node tools/other-cli.js --config node host-doctor.js --exclusive-process xctrace:xctrace', pid: 805 },
  ]);
});

test('exclusive process matcher strips only the exact configured entry from quoted list carriers', () => {
  const target = { label: 'xctrace', pattern: 'xctrace record' };
  const fixture = [
    '804 node runner/host-doctor.js --exclusive-process "perfetto:perfetto,xctrace:xctrace record"',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), []);
});

test('exclusive process matcher strips ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES on real host-doctor invocation', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '805 ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES=xctrace:xctrace pnpm exec asl-host-doctor --out artifacts/host-doctor',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), []);
});

test('exclusive process matcher keeps pnpm --dir command matches as genuine processes', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '806 pnpm --dir asl-host-doctor --exclusive-process xctrace:xctrace',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), [
    { command: 'pnpm --dir asl-host-doctor --exclusive-process xctrace:xctrace', pid: 806 },
  ]);
});

test('exclusive process matcher treats pnpm --filter invocation as non-host command', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '807 pnpm --filter asl-host-doctor --exclusive-process xctrace:xctrace',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), [
    { command: 'pnpm --filter asl-host-doctor --exclusive-process xctrace:xctrace', pid: 807 },
  ]);
});

test('exclusive process matcher keeps genuine command matches plus host-doctor config echoes', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '901 xctrace record --template Time\\ Profiler && pnpm asl-host-doctor --exclusive-process xctrace:xctrace',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), [
    {
      command: 'xctrace record --template Time\\ Profiler && pnpm asl-host-doctor --exclusive-process xctrace:xctrace',
      pid: 901,
    },
  ]);
});

test('exclusive process matcher returns no matches when no command contains pattern', () => {
  const target = { label: 'xctrace', pattern: 'xctrace' };
  const fixture = [
    '1001 perfetto --version',
    '1002 trace_processor_shell --httpd',
  ].join('\n');
  assert.deepEqual(findExclusiveProcessMatches({
    currentPid: 999,
    processListText: fixture,
    target,
  }), []);
});

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
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /# host doctor/u);
  assert.match(summary, /Host\/device preflight passed/u);
  assert.match(summary, /## host checks/u);
  assert.match(summary, /android_adb: passed/u);
  assert.match(summary, /argent: passed/u);
  assert.doesNotMatch(summary, /Scenario health passed/u);
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
          metadata: {
            failureClass: 'host_access',
            nextAction: 'Rerun agent-device availability with host/device access before treating this as an app, scenario, or runner regression.',
            nextActionCode: 'rerun_with_host_access',
          },
          name: 'agent_device_devices',
          stderrPreview: 'adb server cannot bind smartsocket: Operation not permitted',
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
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /Do not start live proof from this host state/u);
  assert.match(summary, /Next action `rerun_with_host_access`/u);
  assert.match(summary, /host\/device access/u);
  assert.doesNotMatch(summary, /Do not optimize from this run/u);
  const agentDeviceCheck = (health.checks as Array<{metadata?: Record<string, unknown>; name: string}>)
    .find((check) => check.name === 'agent_device');
  assert.equal(agentDeviceCheck?.metadata?.failureClass, 'host_access');
  assert.equal(agentDeviceCheck?.metadata?.nextActionCode, 'rerun_with_host_access');
  assert.equal(agentDeviceCheck?.metadata?.failedCheckCode, 'agent_device_devices_available');
  assert.equal(
    agentDeviceCheck?.metadata?.stderrPreview,
    'adb server cannot bind smartsocket: Operation not permitted',
  );
  assert.deepEqual(
    (health.checks as Array<{name: string; status: string}>).map((check) => [check.name, check.status]),
    [
      ['android_adb', 'passed'],
      ['agent_device', 'failed'],
    ],
  );
  assert.equal(readJson(path.join(tempDir, 'raw', 'agent-device-check.json')).status, 'failed');
});

test('host doctor checks required TCP services before live proof', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-tcp-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const tcpPortProbe = async (
    target: {port: number},
  ): Promise<{elapsedMs: number; errorMessage?: string; status: 'failed' | 'passed'}> => {
    if (target.port === 8081) {
      return { elapsedMs: 12, status: 'passed' };
    }
    return {
      elapsedMs: 12,
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:8097',
      status: 'failed',
    };
  };

  const result = await runHostDoctor({
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-tcp',
    tcpPortProbe,
    tcpPortTargets: [
      { host: 'localhost', label: 'localhost:8081', port: 8081 },
      { host: 'localhost', label: 'localhost:8097', port: 8097 },
    ],
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  assert.equal(readJson(path.join(tempDir, 'verdict.json')).verdictStatus, 'inconclusive');
  const checks = health.checks as Array<{metadata?: Record<string, unknown>; name: string; status: string}>;
  assert.deepEqual(checks.map((check) => [check.name, check.status]), [
    ['tcp_port_localhost_8081', 'passed'],
    ['tcp_port_localhost_8097', 'failed'],
  ]);
  assert.equal(checks[1]?.metadata?.nextActionCode, 'start_required_tcp_service');
  assert.equal(checks[1]?.metadata?.port, 8097);
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /tcp_port_localhost_8097: failed/u);
  assert.match(summary, /start_required_tcp_service/u);
});

test('host doctor checks artifact disk capacity before live proof', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-disk-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const diskSpaceProbe = async (
    target: {path: string},
  ): Promise<{availableBytes: number; status: 'failed' | 'passed'}> => {
    if (target.path.endsWith('ample')) {
      return { availableBytes: 750 * 1024 * 1024, status: 'passed' };
    }
    return { availableBytes: 64 * 1024 * 1024, status: 'failed' };
  };
  const amplePath = path.join(tempDir, 'ample');
  const tightPath = path.join(tempDir, 'tight');

  const result = await runHostDoctor({
    diskSpaceProbe,
    diskSpaceTargets: [
      { label: `${amplePath}:500mb`, minFreeBytes: 500 * 1024 * 1024, path: amplePath },
      { label: `${tightPath}:500mb`, minFreeBytes: 500 * 1024 * 1024, path: tightPath },
    ],
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-disk',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  const checks = health.checks as Array<{metadata?: Record<string, unknown>; name: string; status: string}>;
  assert.deepEqual(checks.map((check) => [check.name, check.status]), [
    [`disk_space_${amplePath.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '')}`, 'passed'],
    [`disk_space_${tightPath.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '')}`, 'failed'],
  ]);
  assert.equal(checks[1]?.metadata?.nextActionCode, 'free_artifact_disk_space');
  assert.equal(checks[1]?.metadata?.minFreeMib, 500);
  assert.equal(checks[1]?.metadata?.availableMib, 64);
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /free_artifact_disk_space/u);
});

test('host doctor checks exclusive process ownership before heavy proof', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-exclusive-process-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const exclusiveProcessProbe = async (
    target: {label: string},
  ): Promise<{matches?: Array<{command: string; pid: number}>; status: 'failed' | 'passed'}> => {
    if (target.label === 'xctrace') {
      return {
        matches: [{ command: 'xctrace record --template Time Profiler', pid: 1234 }],
        status: 'failed',
      };
    }
    return { status: 'passed' };
  };

  const result = await runHostDoctor({
    exclusiveProcessProbe,
    exclusiveProcessTargets: [
      { label: 'perfetto', pattern: 'perfetto' },
      { label: 'xctrace', pattern: 'xctrace record' },
    ],
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-exclusive-process',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  const checks = health.checks as Array<{metadata?: Record<string, unknown>; name: string; status: string}>;
  assert.deepEqual(checks.map((check) => [check.name, check.status]), [
    ['exclusive_process_perfetto', 'passed'],
    ['exclusive_process_xctrace', 'failed'],
  ]);
  assert.equal(checks[1]?.metadata?.nextActionCode, 'stop_conflicting_process');
  assert.equal(checks[1]?.metadata?.matchCount, 1);
  assert.equal(checks[1]?.metadata?.matchingPids, '1234');
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /exclusive_process_xctrace: failed/u);
  assert.match(summary, /stop_conflicting_process/u);
});

test('host doctor reports stale orphan processes before live proof', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-orphan-process-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const orphanProcessProbe = async (
    target: {label: string},
  ): Promise<{matches?: Array<{command: string; pid: number}>; platform: string; status: 'failed' | 'passed'}> => {
    if (target.label === 'trace') {
      return {
        matches: [{ command: 'trace_processor_shell --httpd', pid: 4321 }],
        platform: 'darwin',
        status: 'failed',
      };
    }
    return { matches: [], platform: 'darwin', status: 'passed' };
  };

  const result = await runHostDoctor({
    orphanProcessProbe,
    orphanProcessTargets: [
      { label: 'profiler', pattern: 'profiler-daemon' },
      { label: 'trace', pattern: 'trace_processor' },
    ],
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-orphan-process',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  const checks = health.checks as Array<{metadata?: Record<string, unknown>; name: string; status: string}>;
  assert.deepEqual(checks.map((check) => [check.name, check.status]), [
    ['orphan_process_profiler', 'passed'],
    ['orphan_process_trace', 'failed'],
  ]);
  assert.equal(checks[1]?.metadata?.nextActionCode, 'resolve_orphan_process');
  assert.equal(checks[1]?.metadata?.matchCount, 1);
  assert.equal(checks[1]?.metadata?.matchedPids, '4321');
  assert.equal(checks[1]?.metadata?.firstPid, 4321);
  assert.equal(checks[1]?.metadata?.firstCommand, 'trace_processor_shell --httpd');
  const raw = readJson(path.join(tempDir, 'raw', 'host-doctor.json'));
  assert.deepEqual(raw.orphanProcessTargets, [
    { label: 'profiler', pattern: 'profiler-daemon' },
    { label: 'trace', pattern: 'trace_processor' },
  ]);
  assert.equal((raw['orphanProcess:trace'] as Record<string, unknown>).status, 'failed');
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /orphan_process_trace: failed/u);
  assert.match(summary, /resolve_orphan_process/u);
});

test('host doctor reports active durable lease records before live proof', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-lease-active-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const leasePath = path.join(tempDir, 'android-emulator-5554.json');
  await fsp.writeFile(leasePath, JSON.stringify({
    holder: 'home-feed-scroll-native-fidelity',
    owner: 'worker-7',
    pid: 8765,
    expiresAtMs: 2_000,
  }), 'utf8');

  const result = await runHostDoctor({
    leaseTargets: [
      { label: 'android-emulator-5554', path: leasePath },
    ],
    nowMs: 1_000,
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-active-lease',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(health.healthStatus, 'failed');
  const checks = health.checks as Array<{metadata?: Record<string, unknown>; name: string; status: string}>;
  assert.deepEqual(checks.map((check) => [check.name, check.status]), [
    ['lease_android_emulator_5554', 'failed'],
  ]);
  assert.equal(checks[0]?.metadata?.nextActionCode, 'resolve_lease_record');
  assert.equal(checks[0]?.metadata?.reason, 'lease_active');
  assert.equal(checks[0]?.metadata?.holder, 'home-feed-scroll-native-fidelity');
  assert.equal(checks[0]?.metadata?.owner, 'worker-7');
  assert.equal(checks[0]?.metadata?.pid, 8765);
  const raw = readJson(path.join(tempDir, 'raw', 'host-doctor.json'));
  assert.equal((raw['lease:android-emulator-5554'] as Record<string, unknown>).status, 'active');
  assert.deepEqual((raw['lease:android-emulator-5554'] as Record<string, unknown>).recordKeys, [
    'expiresAtMs',
    'holder',
    'owner',
    'pid',
  ]);
  const summary = fs.readFileSync(path.join(tempDir, 'agent-summary.md'), 'utf8');
  assert.match(summary, /lease_android_emulator_5554: failed/u);
  assert.match(summary, /resolve_lease_record/u);
});

test('host doctor treats missing and expired lease records as available', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-lease-available-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const expiredPath = path.join(tempDir, 'expired.json');
  await fsp.writeFile(expiredPath, JSON.stringify({
    holder: 'old-run',
    createdAtMs: 1_000,
    ttlMs: 250,
  }), 'utf8');

  const result = await runHostDoctor({
    leaseTargets: [
      { label: 'missing', path: path.join(tempDir, 'missing.json') },
      { label: 'expired', path: expiredPath },
    ],
    nowMs: 2_000,
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-available-leases',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'passed');
  assert.deepEqual((health.checks as Array<{name: string; status: string}>).map((check) => [check.name, check.status]), [
    ['lease_missing', 'passed'],
    ['lease_expired', 'passed'],
  ]);
  const checks = health.checks as Array<{metadata?: Record<string, unknown>}>;
  assert.equal(checks[0]?.metadata?.reason, 'lease_file_missing');
  assert.equal(checks[1]?.metadata?.reason, 'lease_expired');
});

test('host doctor fails malformed durable lease records as host evidence', async (t: TestContext) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-host-doctor-lease-error-'));
  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });
  const leasePath = path.join(tempDir, 'bad.json');
  await fsp.writeFile(leasePath, '{not-json', 'utf8');

  const result = await runHostDoctor({
    leaseTargets: [
      { label: 'ios-simulator', path: leasePath },
    ],
    outputDir: tempDir,
    requirements: [],
    runId: 'host-doctor-bad-lease',
  });

  const health = readJson(path.join(tempDir, 'health.json'));
  assert.equal(result.health.healthStatus, 'failed');
  const checks = health.checks as Array<{metadata?: Record<string, unknown>; name: string; status: string}>;
  assert.equal(checks[0]?.name, 'lease_ios_simulator');
  assert.equal(checks[0]?.metadata?.nextActionCode, 'inspect_lease_record');
  assert.equal(checks[0]?.metadata?.reason, 'lease_json_invalid');
});

test('host doctor requirement parser defaults to platform lanes and rejects unknown lanes', () => {
  assert.deepEqual(parseRequirements(undefined), ['android', 'ios']);
  assert.deepEqual(parseRequirements('android,ios,agent-device,argent'), ['android', 'ios', 'agent-device', 'argent']);
  assert.throws(() => parseRequirements('android,maestro'), /Unsupported host doctor requirement/u);
});

test('host doctor TCP target parser accepts ports and host ports', () => {
  assert.deepEqual(parseTcpPortTargets(undefined), []);
  assert.deepEqual(parseTcpPortTargets('8081,127.0.0.1:8097'), [
    { host: 'localhost', label: 'localhost:8081', port: 8081 },
    { host: '127.0.0.1', label: '127.0.0.1:8097', port: 8097 },
  ]);
  assert.throws(() => parseTcpPortTargets('localhost:not-a-port'), /Invalid --tcp-port target/u);
});

test('host doctor disk target parser accepts path and mib requirements', () => {
  const artifactPath = path.resolve('artifacts/asl');
  assert.deepEqual(parseDiskSpaceTargets(undefined), []);
  assert.deepEqual(parseDiskSpaceTargets('artifacts/asl:512'), [
    { label: `${artifactPath}:512mb`, minFreeBytes: 512 * 1024 * 1024, path: artifactPath },
  ]);
  assert.throws(() => parseDiskSpaceTargets('artifacts/asl:not-a-size'), /Invalid --min-free-disk target/u);
});

test('host doctor exclusive process parser accepts labeled patterns', () => {
  assert.deepEqual(parseExclusiveProcessTargets(undefined), []);
  assert.deepEqual(parseExclusiveProcessTargets('perfetto:perfetto,xctrace:xctrace record'), [
    { label: 'perfetto', pattern: 'perfetto' },
    { label: 'xctrace', pattern: 'xctrace record' },
  ]);
  assert.throws(() => parseExclusiveProcessTargets('xctrace'), /Invalid --exclusive-process target/u);
});

test('host doctor orphan process parser accepts labeled literal patterns', () => {
  assert.deepEqual(parseOrphanProcessTargets(undefined), []);
  assert.deepEqual(parseOrphanProcessTargets('trace:trace_processor,profiler:profiler daemon'), [
    { label: 'trace', pattern: 'trace_processor' },
    { label: 'profiler', pattern: 'profiler daemon' },
  ]);
  assert.throws(() => parseOrphanProcessTargets('trace'), /Invalid --orphan-process target/u);
  assert.throws(() => parseOrphanProcessTargets('trace:ps'), /Pattern must be at least 3 characters/u);
});

test('host doctor lease target parser accepts labels and paths', () => {
  const leasePath = path.resolve('artifacts/asl/leases/android.json');
  assert.deepEqual(parseLeaseTargets(undefined), []);
  assert.deepEqual(parseLeaseTargets('android:artifacts/asl/leases/android.json'), [
    { label: 'android', path: leasePath },
  ]);
  assert.throws(() => parseLeaseTargets('android'), /Invalid --lease target/u);
});
