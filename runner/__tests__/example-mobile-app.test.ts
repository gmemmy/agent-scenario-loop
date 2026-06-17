const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');
const PROFILE_ANDROID = path.join(DIST_ROOT, 'runner', 'profile-android.js');
const PROFILE_IOS = path.join(DIST_ROOT, 'runner', 'profile-ios.js');
const {
  resolveAndroidAdbDriverSteps,
} = require('../profile-android');
const {
  validateProject,
} = require('../validate-project');

type ExecOutput = {
  stdout: string;
  stderr: string;
};
type ExecFailure = Error & ExecOutput;
type TestContext = import('node:test').TestContext;

const EXAMPLE_RUNS = [
  {
    eventLog: 'examples/mobile-app/event-logs/app-startup.log',
    platform: 'ios',
    profileRunner: PROFILE_IOS,
    runId: 'example-startup',
    scenario: 'examples/mobile-app/scenarios/mobile/app-startup.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/open-close-cycle.log',
    platform: 'ios',
    profileRunner: PROFILE_IOS,
    runId: 'example-open-close',
    scenario: 'examples/mobile-app/scenarios/mobile/open-close-cycle.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/scroll-settle.log',
    platform: 'ios',
    profileRunner: PROFILE_IOS,
    runId: 'example-scroll',
    scenario: 'examples/mobile-app/scenarios/mobile/scroll-settle.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/android-app-startup.log',
    platform: 'android',
    profileRunner: PROFILE_ANDROID,
    runId: 'android-example-startup',
    scenario: 'examples/mobile-app/scenarios/mobile/app-startup.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/android-open-close-cycle.log',
    platform: 'android',
    profileRunner: PROFILE_ANDROID,
    runId: 'android-example-open-close',
    scenario: 'examples/mobile-app/scenarios/mobile/open-close-cycle.json',
  },
  {
    eventLog: 'examples/mobile-app/event-logs/android-scroll-settle.log',
    platform: 'android',
    profileRunner: PROFILE_ANDROID,
    runId: 'android-example-scroll',
    scenario: 'examples/mobile-app/scenarios/mobile/scroll-settle.json',
  },
];

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
 * Resolves a repository fixture path.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function fixturePath(relativePath: string): string {
  return path.join(ROOT, relativePath);
}

/**
 * Reads a JSON artifact.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('example mobile app config matches Expo app identity', () => {
  const appJson = readJson(fixturePath('examples/mobile-app/app.json'));
  const aslConfig = readJson(fixturePath('examples/mobile-app/asl.config.json'));
  const expo = appJson.expo as { android?: { package?: string }; ios?: { bundleIdentifier?: string } };
  const app = aslConfig.app as { androidPackage?: string; iosBundleId?: string };

  assert.equal(app.androidPackage, expo.android?.package);
  assert.equal(app.iosBundleId, expo.ios?.bundleIdentifier);
});

test('example mobile app satisfies initialized consumer validation', async () => {
  const result = await validateProject({
    packageRoot: ROOT,
    rootDir: fixturePath('examples/mobile-app'),
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.appHelper.status, 'present');
  assert.equal(result.scripts.status, 'present');
  assert.equal(result.scenarioPaths.length, 3);
  assert.equal(result.providerPaths.length, 1);
  assert.deepEqual(
    result.plans.map((plan: { healthStatus: string; platform: string; scenarioId: string }) => ({
      healthStatus: plan.healthStatus,
      platform: plan.platform,
      scenarioId: plan.scenarioId,
    })).sort((
      left: { platform: string; scenarioId: string },
      right: { platform: string; scenarioId: string },
    ) => left.platform.localeCompare(right.platform) || left.scenarioId.localeCompare(right.scenarioId)),
    [
      { healthStatus: 'passed', platform: 'android', scenarioId: 'app-startup' },
      { healthStatus: 'passed', platform: 'android', scenarioId: 'open-close-cycle' },
      { healthStatus: 'passed', platform: 'android', scenarioId: 'scroll-settle' },
      { healthStatus: 'passed', platform: 'ios', scenarioId: 'app-startup' },
      { healthStatus: 'passed', platform: 'ios', scenarioId: 'open-close-cycle' },
      { healthStatus: 'passed', platform: 'ios', scenarioId: 'scroll-settle' },
    ],
  );
});

test('example mobile app exposes consumer package scripts', () => {
  const packageJson = readJson(fixturePath('examples/mobile-app/package.json'));
  const snippetScripts = readJson(fixturePath('examples/mobile-app/asl/package-scripts.json')) as Record<string, string>;
  const templateScripts = readJson(fixturePath('templates/package-scripts.json')) as Record<string, string>;
  const scripts = packageJson.scripts as Record<string, string>;

  for (const scriptName of [
    'asl:validate',
    'asl:check:ios',
    'asl:check:android',
    'asl:profile:ios',
    'asl:profile:android',
    'asl:profile:ios:provider',
    'asl:profile:android:provider',
    'asl:profile:ios:live',
    'asl:profile:android:live',
    'asl:compare:ios',
    'asl:compare:android',
    'asl:live-proof',
    'asl:agent-device:ios',
    'asl:agent-device:android',
    'asl:argent:check',
    'asl:argent:ios',
    'asl:argent:android',
    'asl:android:live',
    'asl:android:live:agent-device',
    'asl:android:live:argent',
    'asl:android:live:runners',
    'asl:ios:live',
    'asl:ios:live:agent-device',
    'asl:ios:live:argent',
    'asl:ios:live:runners',
    'asl:live-proof:android',
    'asl:live-proof:ios',
    'ios:prebuild',
  ]) {
    assert.equal(typeof scripts[scriptName], 'string', `${scriptName} should be defined`);
  }

  for (const scriptName of [
    'asl:android:live',
    'asl:android:live:agent-device',
    'asl:android:live:argent',
    'asl:android:live:runners',
    'asl:ios:live',
    'asl:ios:live:agent-device',
    'asl:ios:live:argent',
    'asl:ios:live:runners',
    'asl:live-proof:android',
    'asl:live-proof:ios',
  ]) {
    assert.match(scripts[scriptName], /--fail-on-regression/u, `${scriptName} should fail strict gates on regressions`);
  }

  const appAslScripts = Object.keys(scripts).filter((scriptName) => scriptName.startsWith('asl:')).sort();
  assert.deepEqual(
    Object.keys(snippetScripts).sort(),
    appAslScripts,
    'public ASL package-script snippets should cover every app-local asl:* script',
  );
  for (const [scriptName, command] of Object.entries(snippetScripts)) {
    assert.doesNotMatch(command, /\.\.\/\.\.|dist\/runner|pnpm --dir/u, `${scriptName} should use public package commands`);
  }
  assert.match(snippetScripts['asl:android:live'], /--compare-latest --fail-on-regression/u);
  assert.match(snippetScripts['asl:ios:live'], /--compare-latest --fail-on-regression/u);
  assert.match(snippetScripts['asl:android:live:runners'], /--agent-device-proof --argent-proof --compare-latest --fail-on-regression/u);
  assert.match(snippetScripts['asl:ios:live:runners'], /--agent-device-proof --argent-proof --compare-latest --fail-on-regression/u);

  assert.deepEqual(
    Object.keys(templateScripts).sort(),
    Object.keys(snippetScripts).sort(),
    'example package-script snippets should expose the same public script names as the scaffold template',
  );
});

test('example mobile app declares reproducible iOS build compatibility inputs', () => {
  const appJson = readJson(fixturePath('examples/mobile-app/app.json'));
  const packageJson = readJson(fixturePath('examples/mobile-app/package.json'));
  const expo = appJson.expo as { plugins?: string[] };
  const dependencies = packageJson.dependencies as Record<string, string>;
  const pnpm = packageJson.pnpm as { patchedDependencies?: Record<string, string> };

  assert.ok(
    expo.plugins?.includes('./plugins/with-ios-build-compat'),
    'iOS build compatibility plugin should run during Expo prebuild',
  );
  assert.equal(
    dependencies['@expo/metro-runtime'],
    '56.0.15',
    'strict pnpm installs need the Metro runtime package at the app boundary',
  );
  assert.equal(
    pnpm.patchedDependencies?.['expo-modules-jsi@56.0.10'],
    'patches/expo-modules-jsi@56.0.10.patch',
  );
  assert.ok(fs.existsSync(fixturePath('examples/mobile-app/plugins/with-ios-build-compat.js')));
  assert.ok(fs.existsSync(fixturePath('examples/mobile-app/patches/expo-modules-jsi@56.0.10.patch')));
});

test('example Android video scenario maps to optional adb record capture', () => {
  const scenario = readJson(fixturePath('examples/mobile-app/scenarios/android/app-startup-video.json'));
  const driverSteps = resolveAndroidAdbDriverSteps(scenario);

  assert.deepEqual(driverSteps, [
    {
      driverAction: 'readLogs',
      lines: 1000,
      rawFileName: 'adb-logcat.txt',
      required: true,
      stepId: 'capture-log-window',
      waitMs: 0,
    },
    {
      captureFileName: 'app-startup-video.mp4',
      driverAction: 'record',
      durationSeconds: 5,
      rawFileName: 'adb-record-startup.txt',
      remotePath: '/sdcard/asl-app-startup-video.mp4',
      required: false,
      stepId: 'record-startup-window',
      waitMs: 0,
    },
  ]);
});

test('example mobile app scenarios produce passed artifacts from committed evidence', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-mobile-app-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });

  for (const exampleRun of EXAMPLE_RUNS) {
    const { stdout } = await execFileAsync(process.execPath, [
      exampleRun.profileRunner,
      '--config',
      fixturePath('examples/mobile-app/asl.config.json'),
      '--scenario',
      fixturePath(exampleRun.scenario),
      '--events',
      fixturePath(exampleRun.eventLog),
      '--out',
      artifactRoot,
      '--run-id',
      exampleRun.runId,
    ]);

    const runDir = stdout.trim();
    const health = readJson(path.join(runDir, 'health.json'));
    const manifest = readJson(path.join(runDir, 'manifest.json'));
    const verdict = readJson(path.join(runDir, 'verdict.json'));
    const summary = fs.readFileSync(path.join(runDir, 'agent-summary.md'), 'utf8');

    assert.equal(manifest.platform, exampleRun.platform);
    assert.equal(health.healthStatus, 'passed');
    assert.equal(verdict.verdictStatus, 'passed');
    assert.match(summary, /Scenario health passed/u);
  }
});

test('example mobile app provider manifest writes stable evidence attachments', async (t: TestContext) => {
  const artifactRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-example-mobile-provider-'));
  t.after(async () => {
    await fsp.rm(artifactRoot, { recursive: true, force: true });
  });

  for (const exampleRun of [
    {
      eventLog: 'examples/mobile-app/event-logs/app-startup.log',
      profileRunner: PROFILE_IOS,
      runId: 'ios-provider-proof',
      scenario: 'examples/mobile-app/scenarios/ios/app-startup.json',
    },
    {
      eventLog: 'examples/mobile-app/event-logs/android-app-startup.log',
      profileRunner: PROFILE_ANDROID,
      runId: 'android-provider-proof',
      scenario: 'examples/mobile-app/scenarios/android/app-startup.json',
    },
  ]) {
    const { stdout } = await execFileAsync(process.execPath, [
      exampleRun.profileRunner,
      '--config',
      fixturePath('examples/mobile-app/asl.config.json'),
      '--scenario',
      fixturePath(exampleRun.scenario),
      '--events',
      fixturePath(exampleRun.eventLog),
      '--provider',
      fixturePath('examples/mobile-app/runner-manifests/evidence-provider.json'),
      '--out',
      artifactRoot,
      '--run-id',
      exampleRun.runId,
    ]);

    const runDir = stdout.trim();
    const manifest = readJson(path.join(runDir, 'manifest.json')) as {
      artifacts?: {
        evidenceAttachments?: Array<{ channel: string; kind: string; path: string; sourceFileName: string }>;
        signals?: { js?: string[]; memory?: string[]; network?: string[] };
      };
    };
    const commandRecord = readJson(
      path.join(runDir, 'raw', 'provider-commands', 'example-mobile-app-evidence-provider-capture-profiler.json'),
    ) as { exitCode?: number };
    const accessibilityCommandRecord = readJson(
      path.join(runDir, 'raw', 'provider-commands', 'example-mobile-app-evidence-provider-capture-accessibility.json'),
    ) as { exitCode?: number };
    const accessibilityEvidence = readJson(
      path.join(runDir, 'raw', 'providers', 'example-mobile-app-evidence-provider', 'accessibility.json'),
    ) as { providerId?: string; violations?: unknown[] };

    assert.equal(commandRecord.exitCode, 0);
    assert.equal(accessibilityCommandRecord.exitCode, 0);
    assert.equal(accessibilityEvidence.providerId, 'example-mobile-app-evidence-provider');
    assert.deepEqual(accessibilityEvidence.violations, []);
    assert.deepEqual(manifest.artifacts?.signals?.js, ['signals/js/profiler.json']);
    assert.deepEqual(manifest.artifacts?.signals?.memory, ['signals/memory/memory.json']);
    assert.deepEqual(manifest.artifacts?.signals?.network, ['signals/network/network.har']);
    assert.deepEqual(
      manifest.artifacts?.evidenceAttachments?.map((attachment) => ({
        channel: attachment.channel,
        kind: attachment.kind,
        path: attachment.path,
        sourceFileName: attachment.sourceFileName,
      })),
      [
        {
          channel: 'provider',
          kind: 'accessibility',
          path: 'raw/providers/example-mobile-app-evidence-provider/accessibility.json',
          sourceFileName: 'accessibility.json',
        },
        {
          channel: 'provider',
          kind: 'profiler',
          path: 'raw/providers/example-mobile-app-evidence-provider/profiler.json',
          sourceFileName: 'profiler.json',
        },
        {
          channel: 'signal',
          kind: 'js',
          path: 'signals/js/profiler.json',
          sourceFileName: 'profiler.json',
        },
        {
          channel: 'signal',
          kind: 'memory',
          path: 'signals/memory/memory.json',
          sourceFileName: 'memory.json',
        },
        {
          channel: 'signal',
          kind: 'network',
          path: 'signals/network/network.har',
          sourceFileName: 'network.har',
        },
      ],
    );
  }
});
