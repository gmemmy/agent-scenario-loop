const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  asyncStorageFileNameForKey,
  formatStoredProfileEventLog,
  parseArgs,
  parseSimctlDevices,
  readAsyncStorageValueSync,
  resolveAsyncStorageDirectory,
  runIosSimctlCapture,
  seedProfileSessionStorage,
  selectSimulator,
} = require('../ios-simctl');

type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};
type TestContext = import('node:test').TestContext;

/**
 * Creates a fake xcrun executor from argument-keyed responses.
 *
 * @param {Record<string, Partial<CommandResult>>} responses
 * @returns {(command: string, args: string[]) => Promise<CommandResult>}
 */
function createExecutor(responses: Record<string, Partial<CommandResult>>) {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
}

test('parses and selects booted iOS simulators', () => {
  const simulators = parseSimctlDevices([
    '== Devices ==',
    '-- iOS 26.3 --',
    '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
    '    iPhone 17e (209480D9-7F23-4C6D-911E-52B228783B69) (Shutdown)',
    '',
  ].join('\n'));

  assert.deepEqual(simulators[0], {
    name: 'iPhone 17 Pro Max',
    state: 'Booted',
    udid: 'A692ED28-893E-453F-8866-C69331AE757F',
  });
  assert.equal(selectSimulator(simulators, null)?.udid, 'A692ED28-893E-453F-8866-C69331AE757F');
  assert.equal(selectSimulator(simulators, '209480D9-7F23-4C6D-911E-52B228783B69')?.state, 'Shutdown');
});

test('ignores package-manager argument separator', () => {
  assert.deepEqual(parseArgs(['--', '--xcrun', 'fake-xcrun', '--run-id', 'run-1']), {
    xcrun: 'fake-xcrun',
    'run-id': 'run-1',
  });
});

test('writes next-action hints when no iOS simulator is booted', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-missing-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Shutdown)',
      ].join('\n'),
    },
  });

  const result = await runIosSimctlCapture({
    executor,
    launch: true,
    outputDir,
    runId: 'ios-missing-sim',
  });
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(result.verdict.verdictStatus, 'inconclusive');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_simulator_missing' && check.metadata?.nextActionCode === 'boot_ios_simulator',
    ),
  );
  assert.match(summary, /Next action `boot_ios_simulator`/u);
});

test('explains agent sandbox access when simctl listing is unavailable', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-unavailable-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      exitCode: 1,
      stderr: 'Operation not permitted',
    },
  });

  const result = await runIosSimctlCapture({
    executor,
    outputDir,
    runId: 'ios-simctl-unavailable',
  });
  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextAction?: string; nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_simctl_unavailable'
        && check.metadata?.nextActionCode === 'fix_xcrun_simctl'
        && /agent sandbox/u.test(check.metadata.nextAction ?? ''),
    ),
  );
  assert.match(summary, /agent sandbox/u);
});

test('captures bounded iOS simulator log evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const screenshotPath = path.join(outputDir, 'captures', 'ios-screenshot.jpeg');
    if (key === `simctl io A692ED28-893E-453F-8866-C69331AE757F screenshot --type=jpeg --display=Internal-1 --mask=black ${screenshotPath}`) {
      await fsp.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fsp.writeFile(screenshotPath, 'PNG', 'utf8');
      return {
        args,
        command,
        exitCode: 0,
        stderr: '',
        stdout: 'Wrote screenshot\n',
      };
    }
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?scenario=app-startup&runId=ios-live': {
        stdout: '',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: '[profile-event] scenario=app-startup runId=ios-live event=home_ready timestamp=1\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
  const waits: number[] = [];

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
      },
    ],
    delay: async (ms: number) => {
      waits.push(ms);
    },
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-live',
    screenshot: true,
    screenshotDisplay: 'Internal-1',
    screenshotMask: 'black',
    screenshotType: 'jpeg',
    waitMs: 250,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.deepEqual(waits, [250]);
  assert.equal(result.captures.screenshot, 'captures/ios-screenshot.jpeg');
  assert.deepEqual((result.metadata.deepLinkResults as Array<Record<string, unknown>>)[0], {
    args: [
      'simctl',
      'openurl',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
    ],
    exitCode: 0,
    label: 'profile-session-start',
    rawPath: 'raw/ios-deep-link-1.txt',
    url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-live',
    waitMs: 0,
  });
  assert.deepEqual(result.metadata.screenshot, {
    args: [
      'simctl',
      'io',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'screenshot',
      '--type=jpeg',
      '--display=Internal-1',
      '--mask=black',
      path.join(outputDir, 'captures', 'ios-screenshot.jpeg'),
    ],
    capturePath: 'captures/ios-screenshot.jpeg',
    exitCode: 0,
    options: {
      display: 'Internal-1',
      mask: 'black',
      type: 'jpeg',
    },
    rawPath: 'raw/ios-screenshot.txt',
  });
  assert.ok(fs.existsSync(path.join(outputDir, 'captures', 'ios-screenshot.jpeg')));
  assert.ok(fs.readFileSync(path.join(outputDir, 'raw', 'ios-simctl-log.txt'), 'utf8').includes('[profile-event]'));
  assert.ok(calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') < calls.indexOf('simctl openurl A692ED28-893E-453F-8866-C69331AE757F asl-example://profile-session/start?scenario=app-startup&runId=ios-live'));
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some((check) => check.code === 'ios_logs_captured'),
  );
});

test('fails iOS capture when launched app exits during the capture window', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-crash-'));
  const diagnosticReportsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-diagnostic-reports-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(diagnosticReportsDir, { recursive: true, force: true });
  });
  const crashReportPath = path.join(diagnosticReportsDir, 'ASLExampleMobile-2026-06-18-194524.ips');
  await fsp.writeFile(
    crashReportPath,
    '{"app_name":"ASLExampleMobile","timestamp":"2026-06-18 19:45:24.00 +0100","bundleID":"dev.agent-scenario-loop.example","exception":{"type":"EXC_BAD_ACCESS","signal":"SIGSEGV"}}\n',
    'utf8',
  );
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 74759\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "74759"': {
      stdout: [
        'SpringBoard Process exited: <FBApplicationProcess; app<dev.agent-scenario-loop.example>:74759> -> <RBSProcessExitContext| specific, status:<RBSProcessExitStatus| domain:signal(2) code:SIGSEGV(11)>>',
        'runningboardd app<dev.agent-scenario-loop.example>:74759 exited with context signal SIGSEGV',
      ].join('\n'),
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    diagnosticReportsDir,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-crash',
  });

  const summary = fs.readFileSync(path.join(outputDir, 'agent-summary.md'), 'utf8');
  const lifecycleLog = fs.readFileSync(path.join(outputDir, 'raw', 'ios-app-lifecycle-log.txt'), 'utf8');
  const attachedCrashReport = fs.readFileSync(
    path.join(outputDir, 'raw', 'ios-host-diagnostic-report-dev.agent-scenario-loop.example.ips'),
    'utf8',
  );
  const appLifecycle = result.metadata.appLifecycle as {
    hostDiagnosticReport: { modifiedAt: string };
  };

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(lifecycleLog.includes('SIGSEGV'));
  assert.ok(attachedCrashReport.includes('EXC_BAD_ACCESS'));
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextAction?: string; nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_app_exited_during_capture'
        && check.metadata?.nextActionCode === 'inspect_ios_app_crash'
        && /ios-host-diagnostic-report/u.test(check.metadata.nextAction ?? ''),
    ),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string }>).some(
      (check) => check.code === 'ios_host_diagnostic_report_attached',
    ),
  );
  assert.match(summary, /inspect_ios_app_crash/u);
  assert.deepEqual(result.metadata.appLifecycle, {
    args: [
      'simctl',
      'spawn',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      '1m',
      '--predicate',
      'eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "74759"',
    ],
    exitCode: 0,
    hostDiagnosticReport: {
      matched: true,
      modifiedAt: appLifecycle.hostDiagnosticReport.modifiedAt,
      rawPath: 'raw/ios-host-diagnostic-report-dev.agent-scenario-loop.example.ips',
      reportPath: crashReportPath,
      searchRawPath: 'raw/ios-host-diagnostic-report-search.txt',
    },
    pid: '74759',
    rawPath: 'raw/ios-app-lifecycle-log.txt',
  });
});

test('warns instead of failing when iOS lifecycle exit is not confirmed by crash evidence', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-ambiguous-exit-'));
  const diagnosticReportsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-empty-diagnostic-reports-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(diagnosticReportsDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 74759\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "74759"': {
      stdout: 'runningboardd app<dev.agent-scenario-loop.example>:74759 exited with context unknown',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    diagnosticReportsDir,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-ambiguous-exit',
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(
    (result.health.checks as Array<{ code: string; status: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_app_lifecycle_exit_unconfirmed'
        && check.status === 'warning'
        && check.metadata?.nextActionCode === 'confirm_ios_app_lifecycle',
    ),
  );
  assert.ok(
    (result.health.checks as Array<{ code: string; status: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_target_app_state_unknown'
        && check.status === 'warning'
        && check.metadata?.nextActionCode === 'confirm_ios_target_foreground',
    ),
  );
});

test('ignores WebKit helper lifecycle noise when app remains foreground', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-webkit-noise-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 89365\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "89365"': {
      stdout: [
        'SpringBoard RX dev.agent-scenario-loop.example(89365) signalKeyboardChanged',
        'runningboardd [xpcservice<com.apple.WebKit.WebContent([app<dev.agent-scenario-loop.example((null))>:89365])>:89543] reported to RB as running',
        'runningboardd Invalidating assertion 39338-89365-15099 (target:[xpcservice<com.apple.WebKit.WebContent([app<dev.agent-scenario-loop.example((null))>:89365])>:89543])',
        'SpringBoard Asked to bootstrap a new process for handle: [xpcservice<com.apple.WebKit.Networking([app<dev.agent-scenario-loop.example((null))>:89365])>:89542]',
      ].join('\n'),
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"ApplicationState":"ForegroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-webkit-noise',
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(
    (result.health.checks as Array<{ code: string; status: string }>).some(
      (check) => check.code === 'ios_app_lifecycle_stable' && check.status === 'passed',
    ),
  );
});

test('fails iOS capture when launched target app is not foreground after capture', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-backgrounded-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const executor = createExecutor({
    'simctl list devices': {
      stdout: [
        '== Devices ==',
        '-- iOS 26.3 --',
        '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
      ].join('\n'),
    },
    'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
      stdout: '/tmp/ASLExampleMobile.app\n',
    },
    'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: 'dev.agent-scenario-loop.example: 1234\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
    'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
      stdout: '{"ApplicationState":"BackgroundRunning","Bundle":"dev.agent-scenario-loop.example"}\n',
    },
    'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
      stdout: 'Timestamp Ty Process[PID:TID]\n',
    },
  });

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    runId: 'ios-backgrounded',
  });

  const appInfo = result.metadata.appInfo as { applicationState: string; rawPath: string };

  assert.equal(result.health.healthStatus, 'failed');
  assert.deepEqual(appInfo, {
    applicationState: 'BackgroundRunning',
    args: [
      'simctl',
      'appinfo',
      'A692ED28-893E-453F-8866-C69331AE757F',
      'dev.agent-scenario-loop.example',
    ],
    exitCode: 0,
    rawPath: 'raw/ios-app-info.txt',
  });
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_target_app_backgrounded'
        && check.metadata?.nextActionCode === 'restore_ios_target_foreground',
    ),
  );
  assert.match(
    fs.readFileSync(path.join(outputDir, 'raw', 'ios-app-info.txt'), 'utf8'),
    /BackgroundRunning/u,
  );
});

test('blocks lifecycle mutation when simulator launch environment is contaminated', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-launch-env-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
        stdout: '/tmp/libInjectedRunner.dylib\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
        stdout: '/tmp/runner.sock\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-contaminated',
      },
    ],
    executor,
    launch: true,
    outputDir,
    runId: 'ios-contaminated',
    terminateBeforeLaunch: true,
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.equal(calls.some((call) => call.includes('simctl terminate ')), false);
  assert.equal(calls.some((call) => call.includes('simctl launch ')), false);
  assert.equal(calls.some((call) => call.includes('simctl openurl ')), false);
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_simulator_launch_environment_contaminated'
        && check.metadata?.nextActionCode === 'clear_ios_simulator_launch_environment',
    ),
  );
  assert.match(
    fs.readFileSync(path.join(outputDir, 'raw', 'ios-launch-env-dyld-insert-libraries.txt'), 'utf8'),
    /libInjectedRunner/u,
  );
});

test('fails iOS capture when configured sibling bundle variants are installed', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-conflict-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.beta app': {
        stdout: '/tmp/ASLExampleMobileBeta.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.prod app': {
        exitCode: 1,
        stderr: 'An error was encountered processing the command',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 2m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    conflictingBundleIds: [
      'dev.agent-scenario-loop.example',
      'dev.agent-scenario-loop.beta',
      'dev.agent-scenario-loop.prod',
    ],
    deepLinks: [
      {
        label: 'profile-session-start',
        url: 'asl-example://profile-session/start?scenario=app-startup&runId=ios-conflict',
      },
    ],
    executor,
    launch: true,
    outputDir,
    runId: 'ios-conflict',
    terminateBeforeLaunch: true,
  });

  assert.equal(result.health.healthStatus, 'failed');
  assert.ok(
    (result.health.checks as Array<{ code: string; metadata?: { nextActionCode?: string } }>).some(
      (check) => check.code === 'ios_conflicting_bundles_installed'
        && check.metadata?.nextActionCode === 'uninstall_ios_conflicting_bundles',
    ),
  );
  assert.equal(calls.some((call) => call.includes('simctl launch ')), false);
  assert.equal(calls.some((call) => call.includes('simctl openurl ')), false);
  assert.equal(calls.some((call) => call.includes('simctl terminate ')), false);
  assert.deepEqual((result.metadata.conflictingBundleIds as { installed: string[] }).installed, [
    'dev.agent-scenario-loop.beta',
  ]);
});

test('seeds profile-session AsyncStorage while preserving unrelated app keys', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({
    'agent-scenario-loop.profile-events.1': null,
    'unrelated.key': 'keep-me',
  }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1')), '[]', 'utf8');

  await seedProfileSessionStorage({
    bundleId: 'dev.agent-scenario-loop.example',
    commands: [
      { command: 'activate-target:example-card-1', id: 'open-card' },
      { command: 'activate-target:close-card', id: 'close-card' },
    ],
    dataContainer,
    runId: 'ios-live-startup',
    scenario: 'app-startup',
    startedAt: 123,
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
  const session = JSON.parse(manifest['agent-scenario-loop.profile-session.1']);
  const commands = JSON.parse(manifest['agent-scenario-loop.profile-commands.1']);

  assert.equal(manifest['unrelated.key'], 'keep-me');
  assert.equal(manifest['agent-scenario-loop.profile-events.1'], undefined);
  assert.equal(fs.existsSync(path.join(storageDir, asyncStorageFileNameForKey('agent-scenario-loop.profile-events.1'))), false);
  assert.deepEqual(session, {
    active: true,
    scenario: 'app-startup',
    runId: 'ios-live-startup',
    startedAt: 123,
  });
  assert.deepEqual(commands, [
    {
      id: 'open-card',
      scenario: 'app-startup',
      runId: 'ios-live-startup',
      command: 'activate-target:example-card-1',
      timestamp: 124,
    },
    {
      id: 'close-card',
      scenario: 'app-startup',
      runId: 'ios-live-startup',
      command: 'activate-target:close-card',
      timestamp: 125,
    },
  ]);
});

test('seeds profile-session AsyncStorage with app-owned storage keys', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-custom-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'com.helpbnk.ios.dev',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({
    'helpbnk.profile-events.v1': null,
    'unrelated.key': 'keep-me',
  }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey('helpbnk.profile-events.v1')), '[]', 'utf8');

  await seedProfileSessionStorage({
    bundleId: 'com.helpbnk.ios.dev',
    dataContainer,
    profileStorageKeys: {
      command: 'helpbnk.profile-commands.v1',
      event: 'helpbnk.profile-events.v1',
      session: 'helpbnk.profile-session.v1',
      sessionEntries: 'helpbnk.profile-session-entries.v1',
      signal: 'helpbnk.profile-signals.v1',
    },
    runId: 'helpbnk-ios-live-startup',
    scenario: 'app-startup',
    startedAt: 456,
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
  const session = JSON.parse(manifest['helpbnk.profile-session.v1']);

  assert.equal(manifest['unrelated.key'], 'keep-me');
  assert.equal(manifest['helpbnk.profile-events.v1'], undefined);
  assert.equal(manifest['agent-scenario-loop.profile-session.1'], undefined);
  assert.equal(fs.existsSync(path.join(storageDir, asyncStorageFileNameForKey('helpbnk.profile-events.v1'))), false);
  assert.deepEqual(session, {
    active: true,
    scenario: 'app-startup',
    runId: 'helpbnk-ios-live-startup',
    startedAt: 456,
  });
});

test('reads inline and spilled AsyncStorage profile event values', async (t: TestContext) => {
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-storage-read-'));
  t.after(async () => {
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const storageDir = resolveAsyncStorageDirectory({
    bundleId: 'dev.agent-scenario-loop.example',
    dataContainer,
  });
  await fsp.mkdir(storageDir, { recursive: true });
  const eventKey = 'agent-scenario-loop.profile-events.1';
  const spilledValue = JSON.stringify([
    { event: 'home_ready', scenario: 'app-startup', runId: 'ios-live-startup', timestamp: 123 },
  ]);
  await fsp.writeFile(path.join(storageDir, 'manifest.json'), JSON.stringify({ [eventKey]: null }), 'utf8');
  await fsp.writeFile(path.join(storageDir, asyncStorageFileNameForKey(eventKey)), spilledValue, 'utf8');

  assert.equal(readAsyncStorageValueSync({ key: eventKey, storageDir }), spilledValue);
  assert.ok(formatStoredProfileEventLog(JSON.parse(spilledValue)).includes('[profile-event] {"event":"home_ready"'));
});

test('captures stored iOS profile events from app data container', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-storage-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-data-container-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const calls: string[] = [];
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    calls.push(key);
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example app': {
        stdout: '/tmp/ASLExampleMobile.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example data': {
        stdout: `${dataContainer}\n`,
      },
      'simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stderr: 'Simulator device failed to terminate dev.agent-scenario-loop.example.\nfound nothing to terminate\n',
        exitCode: 3,
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example': {
        stdout: 'dev.agent-scenario-loop.example: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "dev.agent-scenario-loop.example" AND eventMessage CONTAINS "1234"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };

  const wait = async () => {
    const storageDir = resolveAsyncStorageDirectory({
      bundleId: 'dev.agent-scenario-loop.example',
      dataContainer,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
    manifest['agent-scenario-loop.profile-events.1'] = JSON.stringify([
      {
        event: 'home_ready',
        scenario: 'app-startup',
        runId: 'ios-live-startup',
        timestamp: 123,
      },
    ]);
    fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  };

  const result = await runIosSimctlCapture({
    bundleId: 'dev.agent-scenario-loop.example',
    collectProfileStorage: true,
    delay: wait,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    profileSessionStorage: {
      runId: 'ios-live-startup',
      scenario: 'app-startup',
      startedAt: 123,
    },
    runId: 'ios-live-startup',
    terminateBeforeLaunch: true,
    waitMs: 25,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(calls.indexOf('simctl terminate A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example') < calls.indexOf('simctl launch A692ED28-893E-453F-8866-C69331AE757F dev.agent-scenario-loop.example'));
  assert.ok(
    fs
      .readFileSync(path.join(outputDir, 'raw', 'ios-profile-events.log'), 'utf8')
      .includes('[profile-event] {"event":"home_ready"'),
  );
  const metadataText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-metadata.json'), 'utf8');
  const seedText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-seed.json'), 'utf8');
  assert.match(seedText, /ios-live-startup/u);
  assert.equal(metadataText.includes(dataContainer), false);
  assert.equal(seedText.includes(dataContainer), false);
});

test('captures stored iOS profile events from app-owned storage keys', async (t: TestContext) => {
  const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-simctl-storage-custom-'));
  const dataContainer = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-ios-data-container-custom-'));
  t.after(async () => {
    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rm(dataContainer, { recursive: true, force: true });
  });
  const executor = async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const responses: Record<string, Partial<CommandResult>> = {
      'simctl list devices': {
        stdout: [
          '== Devices ==',
          '-- iOS 26.3 --',
          '    iPhone 17 Pro Max (A692ED28-893E-453F-8866-C69331AE757F) (Booted)',
        ].join('\n'),
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv DYLD_INSERT_LIBRARIES': {
        stdout: '',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F launchctl getenv NATIVE_DEVTOOLS_IOS_CDP_SOCKET': {
        stdout: '',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F com.helpbnk.ios.dev app': {
        stdout: '/tmp/HelpBnk.app\n',
      },
      'simctl get_app_container A692ED28-893E-453F-8866-C69331AE757F com.helpbnk.ios.dev data': {
        stdout: `${dataContainer}\n`,
      },
      'simctl launch A692ED28-893E-453F-8866-C69331AE757F com.helpbnk.ios.dev': {
        stdout: 'com.helpbnk.ios.dev: 1234\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "com.helpbnk.ios.dev" AND eventMessage CONTAINS "1234"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
      'simctl appinfo A692ED28-893E-453F-8866-C69331AE757F com.helpbnk.ios.dev': {
        stdout: '{"ApplicationState":"ForegroundRunning","Bundle":"com.helpbnk.ios.dev"}\n',
      },
      'simctl spawn A692ED28-893E-453F-8866-C69331AE757F log show --style compact --last 1m --predicate eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"': {
        stdout: 'Timestamp Ty Process[PID:TID]\n',
      },
    };
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
  const profileStorageKeys = {
    command: 'helpbnk.profile-commands.v1',
    event: 'helpbnk.profile-events.v1',
    session: 'helpbnk.profile-session.v1',
    sessionEntries: 'helpbnk.profile-session-entries.v1',
    signal: 'helpbnk.profile-signals.v1',
  };
  const wait = async () => {
    const storageDir = resolveAsyncStorageDirectory({
      bundleId: 'com.helpbnk.ios.dev',
      dataContainer,
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(storageDir, 'manifest.json'), 'utf8'));
    manifest['helpbnk.profile-events.v1'] = JSON.stringify([
      {
        event: 'app_first_usable_screen',
        scenario: 'app-startup',
        runId: 'helpbnk-ios-live-startup',
        timestamp: 789,
      },
    ]);
    fs.writeFileSync(path.join(storageDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  };

  const result = await runIosSimctlCapture({
    bundleId: 'com.helpbnk.ios.dev',
    collectProfileStorage: true,
    delay: wait,
    executor,
    launch: true,
    logLast: '1m',
    outputDir,
    profileSessionStorage: {
      runId: 'helpbnk-ios-live-startup',
      scenario: 'app-startup',
      startedAt: 456,
    },
    profileStorageKeys,
    runId: 'helpbnk-ios-live-startup',
    waitMs: 25,
  });

  assert.equal(result.health.healthStatus, 'passed', JSON.stringify(result.health.checks, null, 2));
  assert.ok(
    fs
      .readFileSync(path.join(outputDir, 'raw', 'ios-profile-events.log'), 'utf8')
      .includes('[profile-event] {"event":"app_first_usable_screen"'),
  );
  const seedText = fs.readFileSync(path.join(outputDir, 'raw', 'ios-profile-session-seed.json'), 'utf8');
  assert.match(seedText, /helpbnk-ios-live-startup/u);
  assert.equal(seedText.includes(dataContainer), false);
});
