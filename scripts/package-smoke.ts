#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

type RunOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type ExampleProfileRun = {
  binaryName: string;
  eventLog: string;
  platform: string;
  runId: string;
  scenario: string;
};

const EXAMPLE_PROFILE_RUNS: ExampleProfileRun[] = [
  {
    binaryName: 'asl-profile-ios',
    eventLog: 'app-startup.log',
    platform: 'ios',
    runId: 'example-startup',
    scenario: 'app-startup.json',
  },
  {
    binaryName: 'asl-profile-ios',
    eventLog: 'open-close-cycle.log',
    platform: 'ios',
    runId: 'example-open-close',
    scenario: 'open-close-cycle.json',
  },
  {
    binaryName: 'asl-profile-ios',
    eventLog: 'scroll-settle.log',
    platform: 'ios',
    runId: 'example-scroll',
    scenario: 'scroll-settle.json',
  },
  {
    binaryName: 'asl-profile-android',
    eventLog: 'android-app-startup.log',
    platform: 'android',
    runId: 'android-example-startup',
    scenario: 'app-startup.json',
  },
  {
    binaryName: 'asl-profile-android',
    eventLog: 'android-open-close-cycle.log',
    platform: 'android',
    runId: 'android-example-open-close',
    scenario: 'open-close-cycle.json',
  },
  {
    binaryName: 'asl-profile-android',
    eventLog: 'android-scroll-settle.log',
    platform: 'android',
    runId: 'android-example-scroll',
    scenario: 'scroll-settle.json',
  },
];

/**
 * Lists every file under a directory using relative POSIX-style paths.
 *
 * @param {string} rootDir
 * @param {string} [relativeDir]
 * @returns {string[]}
 */
function listFiles(rootDir: string, relativeDir = ''): string[] {
  const absoluteDir = path.join(rootDir, relativeDir);
  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry: import('node:fs').Dirent) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listFiles(rootDir, relativePath);
    }

    if (!entry.isFile()) {
      return [];
    }

    return [relativePath.split(path.sep).join('/')];
  });
}

/**
 * Creates a clean npm environment for repeatable package smoke checks.
 *
 * @param {string} tempRoot
 * @returns {NodeJS.ProcessEnv}
 */
function createSmokeEnv(tempRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_config_')) {
      delete env[key];
    }
  }

  env.npm_config_audit = 'false';
  env.npm_config_cache = path.join(tempRoot, 'npm-cache');
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  return env;
}

/**
 * Runs a command and returns stdout while preserving stderr for failures.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {string}
 */
function run(command: string, args: string[], options: RunOptions): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * Returns the platform-specific path for a package binary in a temp install.
 *
 * @param {string} installDir
 * @param {string} name
 * @returns {string}
 */
function packageBinPath(installDir: string, name: string): string {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return path.join(installDir, 'node_modules', '.bin', `${name}${suffix}`);
}

/**
 * Packs, installs, and exercises the public package surface from a temp project.
 *
 * @returns {void}
 */
function main(): void {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asl-package-smoke-'));
  const packDir = path.join(tempRoot, 'pack');
  const installDir = path.join(tempRoot, 'install');
  const artifactDir = path.join(tempRoot, 'artifacts', 'plan', 'app-startup');
  const env = createSmokeEnv(tempRoot);

  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  try {
    const packOutput = run('npm', ['pack', '--pack-destination', packDir], {
      cwd: repoRoot,
      env,
    });
    const tarballName = packOutput.trim().split(/\n/u).pop();
    assert.ok(tarballName, 'npm pack did not print a tarball name');
    const tarballPath = path.join(packDir, tarballName);
    assert.equal(fs.existsSync(tarballPath), true, `missing packed tarball: ${tarballPath}`);

    run('npm', ['install', tarballPath, '--ignore-scripts'], {
      cwd: installDir,
      env,
    });

    const packageRoot = path.join(installDir, 'node_modules', 'agent-scenario-loop');
    const packedFiles = listFiles(packageRoot);
    const forbiddenPathPatterns = [
      /^\.github\//u,
      /^artifacts\//u,
      /^dist\/scripts\//u,
      /^node_modules\//u,
      /^runner\/__tests__\//u,
      /^scripts\//u,
      /internal-roadmap/u,
    ];
    for (const filePath of packedFiles) {
      assert.equal(
        forbiddenPathPatterns.some((pattern) => pattern.test(filePath)),
        false,
        `unexpected file shipped in package: ${filePath}`,
      );
    }

    for (const filePath of packedFiles) {
      const content = fs.readFileSync(path.join(packageRoot, filePath), 'utf8');
      const productName = ['Help', 'Bnk'].join('');
      const productSlug = ['help', 'bnk'].join('');
      const applicationsPath = ['/', 'Applications'].join('');
      const localUserPath = ['/', 'Users', 'sensei'].join('/');
      const privateTempPath = ['private', 'tmp'].join('/');
      const forbiddenContentPattern = new RegExp(
        `${productName}|${productSlug}|${applicationsPath}|${localUserPath}|${privateTempPath}`,
        'u',
      );
      assert.equal(
        forbiddenContentPattern.test(content),
        false,
        `local or product-specific content leaked into ${filePath}`,
      );
    }

    const scenarioPath = path.join(packageRoot, 'examples', 'scenarios', 'mobile', 'app-startup.json');
    const runnerPath = path.join(packageRoot, 'examples', 'runners', 'xcodebuildmcp-ios.json');
    const exampleAppRoot = path.join(packageRoot, 'examples', 'mobile-app');
    run(packageBinPath(installDir, 'asl-check-plan'), [
      '--scenario',
      scenarioPath,
      '--runner',
      runnerPath,
      '--platform',
      'ios',
      '--run-id',
      'package-smoke',
      '--out',
      artifactDir,
    ], {
      cwd: installDir,
      env,
    });

    for (const binaryName of [
      'agent-scenario-loop',
      'asl-android-adb',
      'asl-check-plan',
      'asl-compare',
      'asl-demo-loop',
      'asl-profile-android',
      'asl-profile-ios',
    ]) {
      const helpText = run(packageBinPath(installDir, binaryName), ['--help'], {
        cwd: installDir,
        env,
      });
      assert.match(helpText, /Usage:/u, `${binaryName} did not print usage`);
    }

    for (const exampleRun of EXAMPLE_PROFILE_RUNS) {
      const output = run(packageBinPath(installDir, exampleRun.binaryName), [
        '--config',
        path.join(exampleAppRoot, 'asl.config.json'),
        '--scenario',
        path.join(exampleAppRoot, 'scenarios', exampleRun.platform, exampleRun.scenario),
        '--events',
        path.join(exampleAppRoot, 'event-logs', exampleRun.eventLog),
        '--out',
        path.join(tempRoot, 'example-mobile-app-artifacts', exampleRun.platform),
        '--run-id',
        exampleRun.runId,
      ], {
        cwd: installDir,
        env,
      });
      const runDir = output.trim();
      const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
      const health = JSON.parse(fs.readFileSync(path.join(runDir, 'health.json'), 'utf8'));
      const verdict = JSON.parse(fs.readFileSync(path.join(runDir, 'verdict.json'), 'utf8'));
      assert.equal(manifest.platform, exampleRun.platform);
      assert.equal(health.healthStatus, 'passed');
      assert.equal(verdict.verdictStatus, 'passed');
    }

    const health = JSON.parse(fs.readFileSync(path.join(artifactDir, 'health.json'), 'utf8'));
    assert.equal(health.scenarioId, 'app-startup');
    assert.equal(health.runId, 'package-smoke');
    assert.equal(health.healthStatus, 'passed');

    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.private, false);
    assert.equal(packageJson.publishConfig?.access, 'public');
    assert.equal(packageJson.scripts?.prepublishOnly, 'pnpm release:check');

    const resolveSmokeScript = [
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const asl = require('agent-scenario-loop');",
      "assert.equal(asl.ARTIFACT_LAYOUT_VERSION, '1.0.0');",
      "assert.equal(asl.ARTIFACT_FILENAMES.health, 'health.json');",
      "assert.equal(typeof asl.createArtifactLayout, 'function');",
      "assert.equal(typeof asl.buildAgentSummaryMarkdown, 'function');",
      "assert.equal(typeof asl.evaluateRunnerCompatibility, 'function');",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'V1_ARTIFACT_LAYOUT_VERSION'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(asl, 'V1_ARTIFACT_FILENAMES'), false);",
      "require.resolve('agent-scenario-loop/schemas/scenario.schema.json');",
      "require.resolve('agent-scenario-loop/examples/scenarios/mobile/app-startup.json');",
      "require.resolve('agent-scenario-loop/examples/mobile-app/asl.config.json');",
      "require.resolve('agent-scenario-loop/runner/profile-android');",
      "require.resolve('agent-scenario-loop/runner/profile-ios');",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/app/profile-session.ts'), true);",
      "assert.equal(fs.existsSync('node_modules/agent-scenario-loop/core/config-template.json'), true);",
    ].join('\n');
    run(process.execPath, ['-e', resolveSmokeScript], {
      cwd: installDir,
      env,
    });

    process.stdout.write(`package smoke passed: ${tarballPath}\n`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    console.error(`package smoke temp kept at: ${tempRoot}`);
    throw error;
  }
}

if (require.main === module) {
  main();
}

export {
  createSmokeEnv,
  listFiles,
  main,
  packageBinPath,
  run,
};
