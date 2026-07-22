const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const COMPARE = path.join(DIST_ROOT, 'runner', 'compare.js');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;
const NATIVE_PERFORMANCE_REQUEST_PATH = 'raw/native-performance-request.json';
const RUNNER_ACTIVE_LOOP_WINDOW_PATH = 'raw/runner-active-loop-window.json';
const SCENARIO_HASH = sha256Text('open-close-cycle');

function sha256Text(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildNativePerformanceRequestRecord(runId: string): Record<string, unknown> {
  return {
    captureMode: 'session',
    kind: 'nativePerformanceRequest',
    lifecycle: {
      finalizePhase: 'finalize',
      normalizePhase: 'afterCapture',
      startPhase: 'startWindow',
      stopPhase: 'stopWindow',
      supportMode: 'live-window',
    },
    platform: 'android',
    requestedAppId: 'dev.agent-scenario-loop.example',
    requestedPackageName: 'dev.agent-scenario-loop.example',
    requestedSerial: 'emulator-5554',
    requestedTargetId: 'emulator-5554',
    runId,
    runnerId: 'android-adb-profile-runner',
    scenarioId: 'open-close-cycle',
    schemaVersion: '1.0.0',
    targetBindingPolicy: {
      outputPathTemplate: 'raw/providers/<providerId>/target-binding.json',
      requiresExactRunnerIdentity: true,
      requiresHashBoundCommandRecords: true,
      sourceCommandsDir: 'raw/provider-commands',
    },
    windowPolicy: {
      phase: 'activeLoop',
      recordPath: RUNNER_ACTIVE_LOOP_WINDOW_PATH,
      requirement: 'copy-exact-runner-window',
      source: 'runner-active-loop-window',
    },
  };
}

function buildObservedTargetBindingRecord({
  runId,
  targetBindingPath,
}: {
  runId: string;
  targetBindingPath: string;
}): Record<string, unknown> {
  const capturePath = 'raw/providers/native-provider/active-window-capture.json';
  const requestRecord = buildNativePerformanceRequestRecord(runId);
  const requestSha256 = sha256Text(`${JSON.stringify(requestRecord)}\n`);
  const sourceCommands = [
    {
      args: ['start-window', '--target-binding', targetBindingPath],
      command: 'capture-native-performance',
      commandId: 'start-native-window',
      phase: 'startWindow',
      recordPath: 'raw/provider-commands/native-provider-start-native-window.json',
      startedRecordPath: 'raw/provider-commands/native-provider-start-native-window.started.json',
      sourceId: 'start-window',
      status: 'completed',
      stderrPath: 'raw/provider-commands/native-provider-start-native-window.stderr.txt',
      stderrSha256: sha256Text('start-native-window stderr\n'),
      stdoutPath: 'raw/provider-commands/native-provider-start-native-window.stdout.txt',
      stdoutSha256: sha256Text('start-native-window stdout\n'),
      requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
      requestSha256,
    },
    {
      args: ['stop-window', '--target-binding', targetBindingPath],
      command: 'capture-native-performance',
      commandId: 'stop-native-window',
      phase: 'stopWindow',
      recordPath: 'raw/provider-commands/native-provider-stop-native-window.json',
      startedRecordPath: 'raw/provider-commands/native-provider-stop-native-window.started.json',
      sourceId: 'stop-window',
      status: 'completed',
      stderrPath: 'raw/provider-commands/native-provider-stop-native-window.stderr.txt',
      stderrSha256: sha256Text('stop-native-window stderr\n'),
      stdoutPath: 'raw/provider-commands/native-provider-stop-native-window.stdout.txt',
      stdoutSha256: sha256Text('stop-native-window stdout\n'),
      requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
      requestSha256,
    },
    {
      args: ['normalize', '--target-binding', targetBindingPath],
      command: 'capture-native-performance',
      commandId: 'capture-native-performance',
      outputPath: targetBindingPath,
      phase: 'afterCapture',
      recordPath: 'raw/provider-commands/native-provider-capture-native-performance.json',
      startedRecordPath: 'raw/provider-commands/native-provider-capture-native-performance.started.json',
      sourceId: 'capture-native-performance',
      status: 'completed',
      stderrPath: 'raw/provider-commands/native-provider-capture-native-performance.stderr.txt',
      stderrSha256: sha256Text('capture-native-performance stderr\n'),
      stdoutPath: 'raw/provider-commands/native-provider-capture-native-performance.stdout.txt',
      stdoutSha256: sha256Text('capture-native-performance stdout\n'),
      requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
      requestSha256,
    },
  ];
  return {
    observedAppId: 'dev.agent-scenario-loop.example',
    observedProcessName: 'dev.agent-scenario-loop.example',
    observedProcessPid: 4242,
    observedTargetId: 'emulator-5554',
    platform: 'android',
    providerId: 'native-provider',
    requestedAppId: 'dev.agent-scenario-loop.example',
    requestedTargetId: 'emulator-5554',
    runId,
    scenarioId: 'open-close-cycle',
    schemaVersion: '1.0.0',
    captureArtifacts: [
      {
        commandId: 'stop-native-window',
        path: capturePath,
      },
    ],
    sourceCommands,
    status: 'verified',
    window: {
      durationMs: 11950,
      endedAt: '2026-07-15T10:00:12.000Z',
      phase: 'activeLoop',
      startedAt: '2026-07-15T10:00:00.050Z',
    },
  };
}

function buildNativePerformanceEvidence({
  p95FrameMs,
  runId,
}: {
  p95FrameMs: number;
  runId: string;
}): Record<string, unknown> {
  const capturePath = 'raw/providers/native-provider/active-window-capture.json';
  return {
    schemaVersion: '1.1.0',
    providerId: 'native-provider',
    platform: 'android',
    runId,
    scenarioId: 'open-close-cycle',
    tool: {
      name: 'native-trace-provider',
      version: '1.2.3',
    },
    capturedAt: '2026-07-15T10:00:00.000Z',
    captureMode: 'session',
    clockDomain: 'host',
    evidenceKind: 'trace-processor',
    dataClasses: ['frames', 'jank'],
    completenessStatus: 'complete',
    comparability: {
      status: 'comparable',
      policy: 'release-native-baseline-v1',
      reason: 'Provider captured a bounded same-condition native metric window.',
    },
    claimSufficiency: {
      status: 'sufficient-for-comparison',
      claim: 'android-native-performance',
      reason: 'Provider captured comparable native metrics.',
      supportingEvidence: ['bounded native summary'],
    },
    comparisonPolicy: {
      environment: [
        { name: 'device-class', value: 'emulator' },
        { name: 'thermal-state', value: 'nominal' },
      ],
      policyId: 'release-native-baseline-v1',
      providerVersion: '1.2.3',
      target: {
        buildMode: 'release',
        family: 'android-mobile-app',
      },
      window: {
        definitionId: 'startup-window',
        durationMs: 12000,
        kind: 'bounded-duration',
        phase: 'activeLoop',
      },
    },
    comparisonMetrics: [
      {
        aggregation: 'p95',
        budget: {
          operator: 'at-most',
          threshold: 20,
        },
        direction: 'lower-is-better',
        id: 'frame-p95',
        sample: 'p95FrameMs',
        surface: 'frames',
        tolerance: {
          absolute: 1,
          relative: 0.05,
        },
        unit: 'ms',
      },
    ],
    diagnosticSources: [
      {
        dataClasses: ['frames', 'jank'],
        path: 'raw/providers/native-provider/source.json',
        sourceId: 'trace-processor',
        status: 'captured',
      },
    ],
    frames: {
      jankyFrameCount: 2,
      p50FrameMs: 12,
      p90FrameMs: 16,
      p95FrameMs,
      p99FrameMs: Math.max(p95FrameMs + 4, 24),
      totalFrameCount: 120,
      worstFrameMs: p95FrameMs + 10,
    },
    lifecycle: {
      durationMs: 12000,
      endedAt: '2026-07-15T10:00:12.000Z',
      perturbsTiming: false,
      phase: 'activeLoop',
      startedAt: '2026-07-15T10:00:00.000Z',
    },
    targetBinding: {
      status: 'verified',
      appId: 'dev.agent-scenario-loop.example',
      deviceId: 'emulator-5554',
      source: 'provider-session-status',
      candidateTargets: [
        {
          appId: 'dev.agent-scenario-loop.example',
          bindingStatus: 'observed',
          deviceId: 'emulator-5554',
          evidencePath: 'raw/providers/native-provider/target-binding.json',
          platform: 'android',
          source: 'provider-session-status',
        },
      ],
    },
    attachments: [
      {
        kind: 'native-trace',
        path: capturePath,
      },
    ],
    traces: [
      {
        durationMs: 12000,
        traceId: `${runId}-trace`,
        windowEndMs: 12000,
        windowStartMs: 0,
      },
    ],
  };
}

/**
 * Runs a child process and returns captured output.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execFileAsync(command: string, args: string[], options: Record<string, unknown> = {}): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: ROOT, ...options }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        const execError = error as ExecFailure;
        execError.stdout = stdout;
        execError.stderr = stderr;
        reject(execError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Writes a minimal comparable run directory.
 *
 * @param {{root: string, runId: string, actual: number, healthStatus?: string, nativePerformanceAttachmentPath?: string, nativePerformanceP95Ms?: number}} options
 * @returns {Promise<string>}
 */
async function writeRun({
  root,
  runId,
  actual,
  healthStatus = 'passed',
  nativePerformanceAttachmentPath,
  nativePerformanceP95Ms,
}: {
  root: string;
  runId: string;
  actual: number;
  healthStatus?: string;
  nativePerformanceAttachmentPath?: string;
  nativePerformanceP95Ms?: number;
}): Promise<string> {
  const runDir = path.join(root, runId);
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(
    path.join(runDir, 'health.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'open-close-cycle',
      flowId: 'open-close-cycle',
      runId,
      healthStatus,
      checks: [{ name: 'truth_events_complete', status: healthStatus, source: 'truth' }],
    })}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(runDir, 'verdict.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      scenarioId: 'open-close-cycle',
      flowId: 'open-close-cycle',
      runId,
      healthStatus,
      verdictStatus: actual <= 1000 ? 'passed' : 'failed',
      budgetChecks: [
        {
          name: 'open p95',
          source: 'milestone',
          metric: 'p95',
          unit: 'ms',
          expected: 1000,
          actual,
          pass: actual <= 1000,
        },
      ],
    })}\n`,
    'utf8',
  );
  await fsp.writeFile(
    path.join(runDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      runId,
      scenario: 'open-close-cycle',
      scenarioHash: SCENARIO_HASH,
      platform: 'android',
      interactionDriver: 'adb-logcat',
      comparisonLane: 'android-native-release',
      provenance: {
        cohortHash: 'cohort-a',
      },
      startedAt: '2026-07-15T10:00:00.000Z',
      endedAt: '2026-07-15T10:00:12.000Z',
      durationMs: 12000,
      artifacts: {
        raw: {},
        evidenceAttachments: nativePerformanceP95Ms === undefined
          ? []
          : [
              {
                kind: 'nativePerformance',
                path: nativePerformanceAttachmentPath ?? 'raw/providers/native-provider/native-performance.json',
              },
            ],
      },
    })}\n`,
    'utf8',
  );
  if (nativePerformanceP95Ms !== undefined) {
    const providerDir = path.join(runDir, 'raw', 'providers', 'native-provider');
    const providerCommandDir = path.join(runDir, 'raw', 'provider-commands');
    const capturePath = 'raw/providers/native-provider/active-window-capture.json';
    const targetBindingPath = 'raw/providers/native-provider/target-binding.json';
    const nativePerformanceRequestRecord = buildNativePerformanceRequestRecord(runId);
    const nativePerformanceRequestJson = `${JSON.stringify(nativePerformanceRequestRecord)}\n`;
    const nativePerformanceRequestSha256 = sha256Text(nativePerformanceRequestJson);
    await fsp.mkdir(providerDir, { recursive: true });
    await fsp.mkdir(providerCommandDir, { recursive: true });
    await fsp.writeFile(
      path.join(providerDir, 'active-window-capture.json'),
      'active-window capture\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerDir, 'source.json'),
      '{"status":"captured"}\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(runDir, RUNNER_ACTIVE_LOOP_WINDOW_PATH),
      `${JSON.stringify({
        durationMs: 11950,
        endedAt: '2026-07-15T10:00:12.000Z',
        phase: 'activeLoop',
        platform: 'android',
        runnerId: 'android-adb-profile-runner',
        schemaVersion: '1.0.0',
        startedAt: '2026-07-15T10:00:00.050Z',
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(runDir, NATIVE_PERFORMANCE_REQUEST_PATH),
      nativePerformanceRequestJson,
      'utf8',
    );
    const targetBindingRecord = buildObservedTargetBindingRecord({
      runId,
      targetBindingPath,
    });
    await fsp.writeFile(
      path.join(providerDir, 'target-binding.json'),
      `${JSON.stringify(targetBindingRecord)}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-start-native-window.started.json'),
      `${JSON.stringify({
        args: ['start-window', '--target-binding', targetBindingPath],
        command: 'capture-native-performance',
        commandId: 'start-native-window',
        phase: 'startWindow',
        providerId: 'native-provider',
        outputs: [],
        requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
        requestSha256: nativePerformanceRequestSha256,
        startedAt: '2026-07-15T10:00:00.000Z',
        startedRecordPath: 'raw/provider-commands/native-provider-start-native-window.started.json',
        status: 'started',
        stderrPath: 'raw/provider-commands/native-provider-start-native-window.stderr.txt',
        stdoutPath: 'raw/provider-commands/native-provider-start-native-window.stdout.txt',
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-start-native-window.json'),
      `${JSON.stringify({
        args: ['start-window', '--target-binding', targetBindingPath],
        command: 'capture-native-performance',
        commandId: 'start-native-window',
        endedAt: '2026-07-15T10:00:00.050Z',
        exitCode: 0,
        outputs: [],
        phase: 'startWindow',
        providerId: 'native-provider',
        requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
        requestSha256: nativePerformanceRequestSha256,
        startedAt: '2026-07-15T10:00:00.000Z',
        startedRecordPath: 'raw/provider-commands/native-provider-start-native-window.started.json',
        status: 'completed',
        stderrPath: 'raw/provider-commands/native-provider-start-native-window.stderr.txt',
        stderrSha256: sha256Text('start-native-window stderr\n'),
        stdoutPath: 'raw/provider-commands/native-provider-start-native-window.stdout.txt',
        stdoutSha256: sha256Text('start-native-window stdout\n'),
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-start-native-window.stdout.txt'),
      'start-native-window stdout\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-start-native-window.stderr.txt'),
      'start-native-window stderr\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-stop-native-window.started.json'),
      `${JSON.stringify({
        args: ['stop-window', '--target-binding', targetBindingPath],
        command: 'capture-native-performance',
        commandId: 'stop-native-window',
        outputs: [
          {
            channel: 'provider',
            kind: 'logs',
            path: '{providerDir}/active-window-capture.json',
            required: false,
            runRelativePath: capturePath,
          },
        ],
        phase: 'stopWindow',
        providerId: 'native-provider',
        requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
        requestSha256: nativePerformanceRequestSha256,
        startedAt: '2026-07-15T10:00:12.000Z',
        startedRecordPath: 'raw/provider-commands/native-provider-stop-native-window.started.json',
        status: 'started',
        stderrPath: 'raw/provider-commands/native-provider-stop-native-window.stderr.txt',
        stdoutPath: 'raw/provider-commands/native-provider-stop-native-window.stdout.txt',
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-stop-native-window.json'),
      `${JSON.stringify({
        args: ['stop-window', '--target-binding', targetBindingPath],
        command: 'capture-native-performance',
        commandId: 'stop-native-window',
        endedAt: '2026-07-15T10:00:12.050Z',
        exitCode: 0,
        outputs: [
          {
            channel: 'provider',
            kind: 'logs',
            path: '{providerDir}/active-window-capture.json',
            required: false,
            runRelativePath: capturePath,
            sha256: sha256Text('active-window capture\n'),
            stale: false,
            status: 'captured',
          },
        ],
        phase: 'stopWindow',
        providerId: 'native-provider',
        requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
        requestSha256: nativePerformanceRequestSha256,
        startedAt: '2026-07-15T10:00:12.000Z',
        startedRecordPath: 'raw/provider-commands/native-provider-stop-native-window.started.json',
        status: 'completed',
        stderrPath: 'raw/provider-commands/native-provider-stop-native-window.stderr.txt',
        stderrSha256: sha256Text('stop-native-window stderr\n'),
        stdoutPath: 'raw/provider-commands/native-provider-stop-native-window.stdout.txt',
        stdoutSha256: sha256Text('stop-native-window stdout\n'),
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-stop-native-window.stdout.txt'),
      'stop-native-window stdout\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-stop-native-window.stderr.txt'),
      'stop-native-window stderr\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-capture-native-performance.started.json'),
      `${JSON.stringify({
        args: ['normalize', '--target-binding', targetBindingPath],
        command: 'capture-native-performance',
        commandId: 'capture-native-performance',
        outputs: [],
        phase: 'afterCapture',
        providerId: 'native-provider',
        requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
        requestSha256: nativePerformanceRequestSha256,
        startedAt: '2026-07-15T10:00:12.100Z',
        startedRecordPath: 'raw/provider-commands/native-provider-capture-native-performance.started.json',
        status: 'started',
        stderrPath: 'raw/provider-commands/native-provider-capture-native-performance.stderr.txt',
        stdoutPath: 'raw/provider-commands/native-provider-capture-native-performance.stdout.txt',
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-capture-native-performance.json'),
      `${JSON.stringify({
        args: ['normalize', '--target-binding', targetBindingPath],
        command: 'capture-native-performance',
        commandId: 'capture-native-performance',
        endedAt: '2026-07-15T10:00:12.200Z',
        exitCode: 0,
        outputPath: targetBindingPath,
        outputSha256: sha256Text(`${JSON.stringify(targetBindingRecord)}\n`),
        outputs: [],
        phase: 'afterCapture',
        providerId: 'native-provider',
        requestPath: NATIVE_PERFORMANCE_REQUEST_PATH,
        requestSha256: nativePerformanceRequestSha256,
        startedAt: '2026-07-15T10:00:12.100Z',
        startedRecordPath: 'raw/provider-commands/native-provider-capture-native-performance.started.json',
        status: 'completed',
        stderrPath: 'raw/provider-commands/native-provider-capture-native-performance.stderr.txt',
        stderrSha256: sha256Text('capture-native-performance stderr\n'),
        stdoutPath: 'raw/provider-commands/native-provider-capture-native-performance.stdout.txt',
        stdoutSha256: sha256Text('capture-native-performance stdout\n'),
      })}\n`,
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-capture-native-performance.stdout.txt'),
      'capture-native-performance stdout\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerCommandDir, 'native-provider-capture-native-performance.stderr.txt'),
      'capture-native-performance stderr\n',
      'utf8',
    );
    await fsp.writeFile(
      path.join(providerDir, 'native-performance.json'),
      `${JSON.stringify(buildNativePerformanceEvidence({
        p95FrameMs: nativePerformanceP95Ms,
        runId,
      }))}\n`,
      'utf8',
    );
  }
  return runDir;
}

test('prints comparison JSON for two trusted run directories', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({ root: outputDir, runId: 'baseline-run', actual: 1200 });
  const currentDir = await writeRun({ root: outputDir, runId: 'current-run', actual: 900 });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.comparisonStatus, 'better');
  assert.equal(comparison.metricComparisons[0].delta, -300);
  assert.deepEqual(comparison.comparisonBasis, {
    strategy: 'explicit',
    scenarioContract: {
      baselineHash: SCENARIO_HASH,
      currentHash: SCENARIO_HASH,
      status: 'exact',
      reason: 'scenario_hash_match',
    },
    baseline: {
      runId: 'baseline-run',
      runDir: baselineDir,
      healthStatus: 'passed',
      verdictStatus: 'failed',
    },
    current: {
      runId: 'current-run',
      runDir: currentDir,
      healthStatus: 'passed',
      verdictStatus: 'passed',
    },
  });
});

test('writes comparison and agent summary when output is a run directory', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-out-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({ root: outputDir, runId: 'baseline-run', actual: 900 });
  const currentDir = await writeRun({ root: outputDir, runId: 'current-run', actual: 1200 });
  const comparisonDir = path.join(outputDir, 'comparison');

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
    '--out',
    comparisonDir,
  ]);

  const comparison = JSON.parse(fs.readFileSync(path.join(comparisonDir, 'comparison.json'), 'utf8'));
  const summary = fs.readFileSync(path.join(comparisonDir, 'agent-summary.md'), 'utf8');
  assert.equal(stdout.trim(), comparisonDir);
  assert.equal(comparison.comparisonStatus, 'worse');
  assert.match(summary, /Comparison: worse/u);
  assert.match(summary, /Current run regressed/u);
});

test('fail-on-regression exits nonzero after writing comparison artifacts', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-regression-gate-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({ root: outputDir, runId: 'baseline-run', actual: 900 });
  const currentDir = await writeRun({ root: outputDir, runId: 'current-run', actual: 1200 });
  const comparisonDir = path.join(outputDir, 'comparison');

  await assert.rejects(
    execFileAsync(process.execPath, [
      COMPARE,
      '--baseline',
      baselineDir,
      '--current',
      currentDir,
      '--out',
      comparisonDir,
      '--fail-on-regression',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.equal(execError.stdout.trim(), comparisonDir);
      assert.match(execError.stderr, /Comparison regressed for current-run/u);
      assert.match(execError.stderr, /Inspect .*comparison/u);
      return true;
    },
  );

  const comparison = JSON.parse(fs.readFileSync(path.join(comparisonDir, 'comparison.json'), 'utf8'));
  const summary = fs.readFileSync(path.join(comparisonDir, 'agent-summary.md'), 'utf8');
  assert.equal(comparison.comparisonStatus, 'worse');
  assert.match(summary, /Current run regressed/u);
});

test('fail-on-regression exits nonzero for native-performance-only regressions', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-native-regression-gate-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({
    root: outputDir,
    runId: 'baseline-run',
    actual: 900,
    nativePerformanceP95Ms: 18,
  });
  const currentDir = await writeRun({
    root: outputDir,
    runId: 'current-run',
    actual: 900,
    nativePerformanceP95Ms: 30,
  });
  const comparisonDir = path.join(outputDir, 'comparison');

  await assert.rejects(
    execFileAsync(process.execPath, [
      COMPARE,
      '--baseline',
      baselineDir,
      '--current',
      currentDir,
      '--out',
      comparisonDir,
      '--fail-on-regression',
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const execError = error as ExecFailure;
      assert.equal(execError.stdout.trim(), comparisonDir);
      assert.match(execError.stderr, /native-performance comparison/u);
      return true;
    },
  );

  const comparison = JSON.parse(fs.readFileSync(path.join(comparisonDir, 'comparison.json'), 'utf8'));
  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'regressed');
});

test('rejects a faster-looking native candidate when target binding is invalid', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-native-faster-invalid-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({
    root: outputDir,
    runId: 'baseline-run',
    actual: 900,
    nativePerformanceP95Ms: 30,
  });
  const currentDir = await writeRun({
    root: outputDir,
    runId: 'current-run',
    actual: 900,
    nativePerformanceP95Ms: 12,
  });
  const currentNativePerformancePath = path.join(
    currentDir,
    'raw',
    'providers',
    'native-provider',
    'native-performance.json',
  );
  const currentNativePerformance = JSON.parse(
    await fsp.readFile(currentNativePerformancePath, 'utf8'),
  ) as Record<string, unknown>;
  const targetBinding = currentNativePerformance.targetBinding as Record<string, unknown>;
  const candidateTargets = Array.isArray(targetBinding?.candidateTargets)
    ? targetBinding.candidateTargets
    : [];
  if (candidateTargets.length > 0) {
    const firstCandidate = candidateTargets[0] as Record<string, unknown>;
    candidateTargets[0] = {
      ...firstCandidate,
      appId: 'dev.agent-scenario-loop.other-app',
    };
  }
  await fsp.writeFile(
    currentNativePerformancePath,
    `${JSON.stringify({
      ...currentNativePerformance,
      targetBinding: {
        ...targetBinding,
        candidateTargets,
      },
    })}\n`,
    'utf8',
  );

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
    '--fail-on-regression',
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some(
      (entry: { field?: string; phase?: string }) => (
        entry.field === 'targetBinding' && entry.phase === 'current'
      ),
    ),
  );
});

test('rejects native-performance attachment paths that escape the run directory', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-native-path-traversal-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({
    root: outputDir,
    runId: 'baseline-run',
    actual: 900,
    nativePerformanceP95Ms: 18,
  });
  const currentDir = await writeRun({
    root: outputDir,
    runId: 'current-run',
    actual: 900,
    nativePerformanceAttachmentPath: 'raw/providers/native-provider/../../../../baseline-run/raw/providers/native-provider/native-performance.json',
    nativePerformanceP95Ms: 30,
  });

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.match(
    comparison.nativePerformance.explanations[0].reason,
    /must stay within the run directory|must not contain/u,
  );
});

test('rejects native-performance attachments that resolve through symlink escapes', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-native-symlink-attachment-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({
    root: outputDir,
    runId: 'baseline-run',
    actual: 900,
    nativePerformanceP95Ms: 18,
  });
  const currentDir = await writeRun({
    root: outputDir,
    runId: 'current-run',
    actual: 900,
    nativePerformanceP95Ms: 30,
  });
  const externalEvidenceDir = path.join(outputDir, 'external-native-evidence');
  await fsp.mkdir(externalEvidenceDir, { recursive: true });
  const externalEvidencePath = path.join(externalEvidenceDir, 'native-performance.json');
  await fsp.writeFile(
    externalEvidencePath,
    `${JSON.stringify(buildNativePerformanceEvidence({
      p95FrameMs: 30,
      runId: 'current-run',
    }))}\n`,
    'utf8',
  );
  const runEvidencePath = path.join(currentDir, 'raw', 'providers', 'native-provider', 'native-performance.json');
  await fsp.rm(runEvidencePath, { force: true });
  await fsp.symlink(externalEvidencePath, runEvidencePath);

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.match(
    comparison.nativePerformance.explanations[0].reason,
    /regular file inside the run directory|real run directory/u,
  );
});

test('rejects native-performance evidence whose supporting paths resolve through symlink escapes', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-compare-native-symlink-supporting-paths-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const baselineDir = await writeRun({
    root: outputDir,
    runId: 'baseline-run',
    actual: 900,
    nativePerformanceP95Ms: 18,
  });
  const currentDir = await writeRun({
    root: outputDir,
    runId: 'current-run',
    actual: 900,
    nativePerformanceP95Ms: 30,
  });
  const externalEvidenceDir = path.join(outputDir, 'external-native-supporting-paths');
  await fsp.mkdir(externalEvidenceDir, { recursive: true });
  const externalSourcePath = path.join(externalEvidenceDir, 'source.json');
  const externalTargetPath = path.join(externalEvidenceDir, 'target-binding.json');
  await fsp.writeFile(externalSourcePath, '{"status":"captured"}\n', 'utf8');
  await fsp.writeFile(
    externalTargetPath,
    `${JSON.stringify(buildObservedTargetBindingRecord({
      runId: 'current-run',
      targetBindingPath: 'raw/providers/native-provider/target-binding.json',
    }))}\n`,
    'utf8',
  );
  const runSourcePath = path.join(currentDir, 'raw', 'providers', 'native-provider', 'source.json');
  const runTargetPath = path.join(currentDir, 'raw', 'providers', 'native-provider', 'target-binding.json');
  await fsp.rm(runSourcePath, { force: true });
  await fsp.rm(runTargetPath, { force: true });
  await fsp.symlink(externalSourcePath, runSourcePath);
  await fsp.symlink(externalTargetPath, runTargetPath);

  const { stdout } = await execFileAsync(process.execPath, [
    COMPARE,
    '--baseline',
    baselineDir,
    '--current',
    currentDir,
  ]);

  const comparison = JSON.parse(stdout);
  assert.equal(comparison.comparisonStatus, 'unchanged');
  assert.equal(comparison.nativePerformance.status, 'not-comparable');
  assert.ok(
    comparison.nativePerformance.explanations.some((explanation: { reason?: string }) => (
      /durable captured source|observed target binding/u.test(String(explanation.reason))
    )),
  );
});
