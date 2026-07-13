const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseAndroidFramestatsSummary } = require('../../core/native-performance');
const { initProject } = require('../init-project');

type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');

function execFileResult(command: string, args: string[], options: Record<string, unknown>): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve) => {
    execFile(command, args, options, (error: NodeJS.ErrnoException & {code?: number} | null, stdout: string, stderr: string) => {
      let exitCode = 0;
      if (error) {
        exitCode = typeof error.code === 'number' ? error.code : 1;
      }
      resolve({
        exitCode,
        stderr,
        stdout,
      });
    });
  });
}

async function createGeneratedProvider(t: TestContext): Promise<{
  fakeAdbPath: string;
  runDir: string;
  scriptPath: string;
  targetDir: string;
}> {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-native-provider-template-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });
  await initProject({ outDir: targetDir, packageRoot: ROOT, scenarioId: 'Native Capture' });
  await fsp.mkdir(path.join(targetDir, 'node_modules'), { recursive: true });
  await fsp.symlink(ROOT, path.join(targetDir, 'node_modules', 'agent-scenario-loop'), 'dir');
  const fakeAdbPath = path.join(targetDir, 'fake-adb');
  await fsp.writeFile(fakeAdbPath, `#!/bin/sh
command="$*"
if [ -n "$FAKE_ADB_LOG" ]; then printf '%s\\n' "$command" >> "$FAKE_ADB_LOG"; fi
source=unknown
case "$command" in
  *" framestats") source=framestats ;;
  *" meminfo "*) source=meminfo ;;
  *" gfxinfo "*) source=gfxinfo ;;
  *" get-serialno") source=target-serial ;;
  *" pm path "*) source=target-package ;;
esac
if [ "$FAKE_ADB_TIMEOUT" = "$source" ]; then sleep 2; fi
if [ "$FAKE_ADB_IGNORE_TERM" = "$source" ]; then trap '' TERM; while :; do :; done; fi
if [ "$FAKE_ADB_OVERFLOW" = "$source" ]; then
  trap 'exit 0' TERM
  if [ "$source" = target-serial ]; then printf 'emulator-5554\\n'; fi
  if [ "$source" = target-package ]; then printf 'package:/data/app/com.example.app/base.apk\\n'; fi
  if [ "$source" = framestats ]; then printf '%s\\n' '---PROFILEDATA---' 'Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted' '0,1000000000,1000000000,0,0,0,0,0,0,0,0,0,0,1010000000,0,0,0' '---PROFILEDATA---'; fi
  while :; do printf '0123456789abcdef'; done
fi
if [ "$FAKE_ADB_FAIL" = "$source" ]; then printf 'forced %s failure\\n' "$source" >&2; exit 7; fi
if [ "$FAKE_ADB_EMPTY" = "$source" ]; then exit 0; fi
serial=emulator-5554
if [ -n "$FAKE_ADB_SERIAL" ]; then serial="$FAKE_ADB_SERIAL"; fi
if [ "$source" = target-serial ]; then printf '%s\\n' "$serial"; fi
if [ "$source" = target-package ]; then printf 'package:/data/app/com.example.app/base.apk\\n'; fi
if [ "$source" = gfxinfo ]; then printf 'Total frames rendered: 120\\nJanky frames: 6 (5.00%%)\\n50th percentile: 8ms\\n95th percentile: 18ms\\n'; fi
if [ "$source" = framestats ]; then printf '%s\\n' '---PROFILEDATA---' 'Flags,IntendedVsync,Vsync,FrameCompleted' '0,1000000,1000000,17000000' '---PROFILEDATA---'; fi
if [ "$source" = meminfo ]; then printf 'TOTAL PSS: 180000 KB\\nNative Heap: 42000 KB\\n'; fi
`, 'utf8');
  await fsp.chmod(fakeAdbPath, 0o755);
  const runDir = path.join(targetDir, 'artifacts', 'run-1');
  await fsp.mkdir(path.join(runDir, 'raw', 'providers', 'example-evidence-provider'), { recursive: true });
  return {
    fakeAdbPath,
    runDir,
    scriptPath: path.join(targetDir, 'scripts', 'asl-capture-native-performance-provider.mjs'),
    targetDir,
  };
}

function providerArgs(options: {fakeAdbPath: string; runDir: string; scriptPath: string}, extra: string[] = []): string[] {
  return [
    options.scriptPath,
    '--platform', 'android',
    '--scenario', 'native-capture',
    '--run-id', 'run-1',
    '--out', path.join(options.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'),
    '--run-dir', options.runDir,
    '--adb', options.fakeAdbPath,
    '--app', 'com.example.app',
    '--device', 'emulator-5554',
    ...extra,
  ];
}

test('generated provider keeps Android adb capture opt-in', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'adb-commands.jsonl');
  const result = await execFileResult(process.execPath, providerArgs(provider), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_LOG: commandLog },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(commandLog), false);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'unverified');
  assert.equal(evidence.comparability.status, 'diagnostic-only');
});

test('generated provider captures Android adb diagnostics with bounded commands and durable target proof', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const commandLog = path.join(provider.targetDir, 'adb-commands.jsonl');
  const result = await execFileResult(process.execPath, providerArgs(provider), {
    cwd: provider.targetDir,
    env: { ...process.env, ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE: '1', FAKE_ADB_LOG: commandLog },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  const evidencePath = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json');
  const evidence = JSON.parse(await fsp.readFile(evidencePath, 'utf8'));
  assert.equal(evidence.targetBinding.status, 'verified');
  assert.equal(evidence.targetBinding.candidateTargets[0].bindingStatus, 'observed');
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, evidence.targetBinding.candidateTargets[0].evidencePath), 'utf8'));
  assert.deepEqual(targetProof.sourceCommands.map((command: Record<string, unknown>) => command.sourceId), ['gfxinfo', 'framestats', 'meminfo']);
  assert.equal(evidence.completenessStatus, 'partial');
  assert.equal(evidence.comparability.status, 'diagnostic-only');
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(evidence.frames.total, 120);
  assert.equal(evidence.memory.totalPssKb, 180000);
  for (const attachment of evidence.attachments) {
    assert.equal(path.isAbsolute(attachment.path), false);
    assert.equal(fs.existsSync(path.join(provider.runDir, attachment.path)), true, attachment.path);
  }
  const commands = (await fsp.readFile(commandLog, 'utf8')).trim().split('\n').map((line: string) => line.split(' '));
  assert.equal(commands.length, 5);
  assert.deepEqual(commands[0], ['-s', 'emulator-5554', 'get-serialno']);
  assert.deepEqual(commands[2], ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo', 'com.example.app']);
  assert.deepEqual(commands[3], ['-s', 'emulator-5554', 'shell', 'dumpsys', 'gfxinfo', 'com.example.app', 'framestats']);
  assert.deepEqual(commands[4], ['-s', 'emulator-5554', 'shell', 'dumpsys', 'meminfo', 'com.example.app']);
});

test('generated provider preserves partial Android evidence and exits nonzero after a source failure', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_FAIL: 'meminfo' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'gfxinfo').status, 'captured');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'failed');
  assert.equal(evidence.frames.total, 120);
  assert.equal(evidence.memory, undefined);
  assert.equal(evidence.claimSufficiency.status, 'insufficient-for-claim');
  assert.equal(fs.existsSync(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'meminfo.command.json')), true);
});

test('generated provider classifies Android adb command timeout and continues remaining capture', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, [
    '--capture-android-adb',
    '--command-timeout-ms', '1000',
  ]), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_TIMEOUT: 'framestats' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'framestats').status, 'timeout');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'captured');
});

test('generated provider rejects an empty successful Android diagnostic as partial evidence', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_EMPTY: 'meminfo' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  const meminfo = evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo');
  assert.equal(meminfo.status, 'partial');
  assert.match(meminfo.reason, /produced no stdout evidence/u);
  assert.equal(evidence.memory, undefined);
  const commandRecord = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'meminfo.command.json'), 'utf8'));
  assert.equal(commandRecord.status, 'partial');
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'target-binding.json'), 'utf8'));
  assert.equal(targetProof.sourceCommands.find((command: Record<string, unknown>) => command.sourceId === 'meminfo').status, 'partial');
});

test('generated provider escalates a resistant Android command and continues capture', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const startedAt = Date.now();
  const result = await execFileResult(process.execPath, providerArgs(provider, [
    '--capture-android-adb',
    '--command-timeout-ms', '1000',
  ]), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_IGNORE_TERM: 'framestats' },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - startedAt < 5_000, 'resistant command should be force-killed inside the bounded provider run');
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'framestats').status, 'timeout');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'captured');
  const commandRecord = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb', 'framestats.command.json'), 'utf8'));
  assert.equal(commandRecord.timedOut, true);
  assert.equal(commandRecord.signal, 'SIGKILL');
});

test('generated provider preserves host execution errors for every attempted Android source', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const args = providerArgs(provider, ['--capture-android-adb']);
  const adbIndex = args.indexOf('--adb');
  args[adbIndex + 1] = path.join(provider.targetDir, 'missing-adb');
  const result = await execFileResult(process.execPath, args, {
    cwd: provider.targetDir,
    env: process.env,
  });
  assert.equal(result.exitCode, 1);
  const captureDir = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb');
  const records = await Promise.all(['target-serial', 'target-package', 'gfxinfo', 'framestats', 'meminfo'].map(async (sourceId) => (
    JSON.parse(await fsp.readFile(path.join(captureDir, `${sourceId}.command.json`), 'utf8'))
  )));
  assert.equal(records.length, 5);
  for (const record of records) {
    assert.equal(record.status, 'failed');
    assert.equal(record.errorCode, 'ENOENT');
    assert.match(record.errorMessage, /missing-adb/u);
  }
});

test('generated provider rejects truncated Android output even when the terminated command exits cleanly', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_OVERFLOW: 'framestats' },
  });
  assert.equal(result.exitCode, 1);
  const captureDir = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb');
  const commandRecord = JSON.parse(await fsp.readFile(path.join(captureDir, 'framestats.command.json'), 'utf8'));
  assert.equal(commandRecord.exitCode, 0);
  assert.equal(commandRecord.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.equal(commandRecord.status, 'failed');
  const truncatedStdout = await fsp.readFile(path.join(captureDir, 'framestats.stdout.txt'), 'utf8');
  assert.equal(parseAndroidFramestatsSummary(truncatedStdout).frameCount, 1, 'fixture must contain parseable framestats before overflow');
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'framestats').status, 'failed');
  assert.equal(evidence.diagnosticSources.find((source: Record<string, unknown>) => source.sourceId === 'meminfo').status, 'captured');
  assert.equal(evidence.frames.frameCount, undefined, 'truncated framestats must not contribute parsed metrics');
  assert.equal(evidence.frames.p50FrameMs, undefined, 'truncated framestats must not contribute frame timing');
});

test('generated provider does not verify target binding from truncated zero-exit target output', async (t: TestContext) => {
  for (const sourceId of ['target-serial', 'target-package']) {
    const provider = await createGeneratedProvider(t);
    const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
      cwd: provider.targetDir,
      env: { ...process.env, FAKE_ADB_OVERFLOW: sourceId },
    });
    assert.equal(result.exitCode, 1);
    const captureDir = path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'android-adb');
    const commandRecord = JSON.parse(await fsp.readFile(path.join(captureDir, `${sourceId}.command.json`), 'utf8'));
    assert.equal(commandRecord.exitCode, 0);
    assert.equal(commandRecord.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.equal(commandRecord.status, 'failed');
    const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
    assert.equal(evidence.targetBinding.status, 'unverified', sourceId);
  }
});

test('generated provider classifies an observed Android serial difference as target mismatch', async (t: TestContext) => {
  const provider = await createGeneratedProvider(t);
  const result = await execFileResult(process.execPath, providerArgs(provider, ['--capture-android-adb']), {
    cwd: provider.targetDir,
    env: { ...process.env, FAKE_ADB_SERIAL: 'emulator-5556' },
  });
  assert.equal(result.exitCode, 1);
  const evidence = JSON.parse(await fsp.readFile(path.join(provider.runDir, 'raw', 'providers', 'example-evidence-provider', 'native-performance.json'), 'utf8'));
  assert.equal(evidence.targetBinding.status, 'mismatch');
  assert.deepEqual(evidence.targetBinding.candidateTargets.map((candidate: Record<string, unknown>) => candidate.bindingStatus), ['expected', 'observed']);
  assert.equal(evidence.targetBinding.candidateTargets[1].deviceId, 'emulator-5556');
  const targetProof = JSON.parse(await fsp.readFile(path.join(provider.runDir, evidence.targetBinding.candidateTargets[1].evidencePath), 'utf8'));
  assert.equal(targetProof.status, 'mismatch');
  assert.equal(targetProof.observedDeviceId, 'emulator-5556');
});
