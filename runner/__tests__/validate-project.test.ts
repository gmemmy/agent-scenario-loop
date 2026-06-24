const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initProject } = require('../init-project');
const {
  buildValidationRunId,
  formatResult,
  listScenarioFiles,
  resolveScenarioDirectories,
  parseArgs,
  resolvePlatforms,
  validateConfigPlaceholders,
  validateGitignore,
  validateAppHelper,
  validatePackageJsonScripts,
  validatePackageScriptShape,
  validatePackageScripts,
  validateProjectConfig,
  validateProviderCommandReferences,
  validateProject,
} = require('../validate-project');

type TestContext = import('node:test').TestContext;

const ROOT = path.join(__dirname, '..', '..', '..');

function actionCodes(result: { nextActions: Array<{ code: string }> }): string[] {
  return result.nextActions.map((action) => action.code).sort();
}

async function readJsonFile(filePath: string): Promise<Record<string, any>> {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function writeJsonFile(filePath: string, value: Record<string, any>): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeMergedPackageJson(rootDir: string): Promise<void> {
  const generatedScripts = JSON.parse(
    await fsp.readFile(path.join(rootDir, 'asl', 'package-scripts.json'), 'utf8'),
  ) as Record<string, string>;
  await fsp.writeFile(
    path.join(rootDir, 'package.json'),
    `${JSON.stringify({
      name: 'consumer-app',
      private: true,
      scripts: generatedScripts,
    }, null, 2)}\n`,
    'utf8',
  );
}

test('parses project validation arguments', () => {
  assert.deepEqual(parseArgs(['--root', 'app', '--config', 'tools/asl/project.config.json', '--platform', 'ios', '--out', 'artifacts/validation']), {
    config: 'tools/asl/project.config.json',
    out: 'artifacts/validation',
    platform: 'ios',
    root: 'app',
  });
});

test('resolves validation platforms from scenario manifests', () => {
  assert.deepEqual(resolvePlatforms({
    requestedPlatform: 'ios',
    scenario: { platforms: ['ios', 'android'] },
  }), ['ios']);
  assert.deepEqual(resolvePlatforms({
    requestedPlatform: 'all',
    scenario: { platforms: ['ios', 'android'] },
  }), ['ios', 'android']);
  assert.deepEqual(resolvePlatforms({
    requestedPlatform: 'all',
    scenario: {},
  }), ['ios', 'android']);
  assert.equal(buildValidationRunId({ platform: 'android', scenarioId: 'checkout-submit' }), 'validate-android-checkout-submit');
});

test('discovers configured platform scenario roots', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-configured-scenarios-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await writeJsonFile(path.join(targetDir, 'asl.config.json'), {
    paths: {
      androidScenarioRoot: 'scenario-fixtures/android',
      iosScenarioRoot: 'scenario-fixtures/ios',
      scenarioRoot: 'scenario-fixtures/shared',
    },
  });
  await writeJsonFile(path.join(targetDir, 'scenario-fixtures', 'android', 'android-only.json'), {});
  await writeJsonFile(path.join(targetDir, 'scenario-fixtures', 'ios', 'ios-only.json'), {});
  await writeJsonFile(path.join(targetDir, 'scenario-fixtures', 'shared', 'mobile', 'shared.json'), {});

  assert.deepEqual(
    listScenarioFiles({
      configPath: path.join(targetDir, 'asl.config.json'),
      requestedPlatform: 'ios',
      rootDir: targetDir,
    }).map((filePath: string) => path.relative(targetDir, filePath)),
    [
      path.join('scenario-fixtures', 'ios', 'ios-only.json'),
      path.join('scenario-fixtures', 'shared', 'mobile', 'shared.json'),
    ],
  );
  assert.deepEqual(
    listScenarioFiles({
      configPath: path.join(targetDir, 'asl.config.json'),
      requestedPlatform: 'android',
      rootDir: targetDir,
    }).map((filePath: string) => path.relative(targetDir, filePath)),
    [
      path.join('scenario-fixtures', 'android', 'android-only.json'),
      path.join('scenario-fixtures', 'shared', 'mobile', 'shared.json'),
    ],
  );
  assert.deepEqual(
    resolveScenarioDirectories({
      configPath: path.join(targetDir, 'asl.config.json'),
      requestedPlatform: 'all',
      rootDir: targetDir,
    }).map((directory: string) => path.relative(targetDir, directory)),
    [
      path.join('scenario-fixtures', 'android'),
      path.join('scenario-fixtures', 'ios'),
      path.join('scenario-fixtures', 'shared'),
      path.join('scenario-fixtures', 'shared', 'mobile'),
    ],
  );
});

test('validates an initialized project for iOS and Android', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });
  await writeMergedPackageJson(targetDir);

  const result = await validateProject({ rootDir: targetDir });

  assert.equal(result.status, 'passed');
  assert.equal(result.config.status, 'present');
  assert.deepEqual(result.config.customDrivers, []);
  assert.deepEqual(result.config.externalTargetDrivers, ['xcodebuildmcp']);
  assert.deepEqual(result.config.missingSupportedDrivers, []);
  assert.deepEqual(result.config.packageSupportedDrivers, ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl']);
  assert.deepEqual(result.config.supportedDrivers, ['adb', 'agent-device', 'argent', 'fixture-log-ingest', 'ios-simctl', 'xcodebuildmcp']);
  assert.equal(result.appHelper.status, 'present');
  assert.equal(result.gitignore.status, 'missing');
  assert.equal(result.scripts.status, 'present');
  assert.equal(result.scripts.packageJsonStatus, 'present');
  assert.equal(result.scripts.scriptNames.includes('asl:validate'), true);
  assert.equal(result.scripts.scriptNames.includes('asl:host:doctor'), true);
  assert.equal(result.warnings.some((warning: string) => warning.includes('projectName')), true);
  assert.equal(result.warnings.some((warning: string) => warning.includes('Runtime artifact gitignore')), true);
  assert.deepEqual(actionCodes(result), ['ignore_runtime_artifacts', 'replace_config_placeholders']);
  assert.deepEqual(
    result.scenarioCandidateDirectories.map((directory: string) => path.relative(targetDir, directory)),
    [
      'scenarios',
      path.join('scenarios', 'mobile'),
    ],
  );
  assert.equal(result.scenarioPaths.length, 1);
  assert.equal(result.providerPaths.length, 1);
  assert.deepEqual(
    result.plans.map((plan: { healthStatus: string; platform: string; scenarioId: string }) => ({
      healthStatus: plan.healthStatus,
      platform: plan.platform,
      scenarioId: plan.scenarioId,
    })).sort((
      left: { healthStatus: string; platform: string; scenarioId: string },
      right: { healthStatus: string; platform: string; scenarioId: string },
    ) => left.platform.localeCompare(right.platform)),
    [
      { healthStatus: 'passed', platform: 'android', scenarioId: 'checkout-submit' },
      { healthStatus: 'passed', platform: 'ios', scenarioId: 'checkout-submit' },
    ],
  );
  assert.match(formatResult(result), /project validation passed/u);
  assert.match(formatResult(result), /Warnings:/u);
  assert.match(formatResult(result), /Next actions:/u);
});

test('validates an initialized project with config outside the project root default', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-custom-config-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });
  await writeMergedPackageJson(targetDir);

  const defaultConfigPath = path.join(targetDir, 'asl.config.json');
  const customConfigPath = path.join(targetDir, 'tools', 'mobile-agent-profile-loop', 'project.config.json');
  const customConfigScriptPath = path.join('tools', 'mobile-agent-profile-loop', 'project.config.json');
  await fsp.mkdir(path.dirname(customConfigPath), { recursive: true });
  await fsp.rename(defaultConfigPath, customConfigPath);
  const generatedScripts = await readJsonFile(path.join(targetDir, 'asl', 'package-scripts.json')) as Record<string, string>;
  const customScripts = Object.fromEntries(
    Object.entries(generatedScripts).map(([scriptName, command]) => [
      scriptName,
      typeof command === 'string' ? command.replace(/asl\.config\.json/gu, customConfigScriptPath) : command,
    ]),
  );
  await writeJsonFile(path.join(targetDir, 'asl', 'package-scripts.json'), customScripts);
  await fsp.writeFile(
    path.join(targetDir, 'package.json'),
    `${JSON.stringify({
      name: 'consumer-app',
      private: true,
      scripts: customScripts,
    }, null, 2)}\n`,
    'utf8',
  );

  const result = await validateProject({
    configPath: customConfigPath,
    rootDir: targetDir,
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.configPath, customConfigPath);
  assert.equal(result.config.path, customConfigPath);
  assert.equal(result.errors.some((error: string) => error.includes('Missing config')), false);
  assert.deepEqual(
    result.scenarioCandidateDirectories.map((directory: string) => path.relative(targetDir, directory)),
    [
      'scenarios',
      path.join('scenarios', 'mobile'),
    ],
  );
});

test('validates project scenarios from configured platform roots', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-platform-roots-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });
  await writeMergedPackageJson(targetDir);

  const configPath = path.join(targetDir, 'asl.config.json');
  const config = await readJsonFile(configPath);
  config.paths = {
    ...(config.paths ?? {}),
    androidScenarioRoot: 'scenarios/android',
    iosScenarioRoot: 'scenarios/ios',
    scenarioRoot: 'scenarios/mobile',
  };
  await writeJsonFile(configPath, config);

  const portableScenarioPath = path.join(targetDir, 'scenarios', 'mobile', 'checkout-submit.json');
  const portableScenario = await readJsonFile(portableScenarioPath);
  await writeJsonFile(path.join(targetDir, 'scenarios', 'ios', 'checkout-submit-ios.json'), {
    ...portableScenario,
    flowId: 'checkout-submit-ios',
    id: 'checkout-submit-ios',
    platforms: ['ios'],
  });
  await writeJsonFile(path.join(targetDir, 'scenarios', 'android', 'checkout-submit-android.json'), {
    ...portableScenario,
    flowId: 'checkout-submit-android',
    id: 'checkout-submit-android',
    platforms: ['android'],
  });

  const result = await validateProject({ rootDir: targetDir });

  assert.equal(result.status, 'passed');
  assert.deepEqual(
    result.scenarioCandidateDirectories.map((directory: string) => path.relative(targetDir, directory)),
    [
      'scenarios',
      path.join('scenarios', 'android'),
      path.join('scenarios', 'ios'),
      path.join('scenarios', 'mobile'),
    ],
  );
  assert.deepEqual(
    result.scenarioPaths.map((scenarioPath: string) => path.relative(targetDir, scenarioPath)),
    [
      path.join('scenarios', 'android', 'checkout-submit-android.json'),
      path.join('scenarios', 'ios', 'checkout-submit-ios.json'),
      path.join('scenarios', 'mobile', 'checkout-submit.json'),
    ],
  );
  assert.deepEqual(
    result.plans.map((plan: { platform: string; scenarioId: string }) => ({
      platform: plan.platform,
      scenarioId: plan.scenarioId,
    })).sort((
      left: { platform: string; scenarioId: string },
      right: { platform: string; scenarioId: string },
    ) => left.platform.localeCompare(right.platform) || left.scenarioId.localeCompare(right.scenarioId)),
    [
      { platform: 'android', scenarioId: 'checkout-submit' },
      { platform: 'android', scenarioId: 'checkout-submit-android' },
      { platform: 'ios', scenarioId: 'checkout-submit' },
      { platform: 'ios', scenarioId: 'checkout-submit-ios' },
    ],
  );
});

test('fails validation when initialized project files are missing', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-missing-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  const result = await validateProject({ rootDir: targetDir });

  assert.equal(result.status, 'failed');
  assert.ok(result.errors.some((error: string) => error.includes('Missing config')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing primary runner manifest')));
  assert.ok(result.errors.some((error: string) => error.includes('No scenario manifests found')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing app profile-session helper')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing package-script snippets')));
  assert.ok(result.errors.some((error: string) => error.includes('Missing app package.json')));
  assert.deepEqual(actionCodes(result), [
    'add_mobile_scenario',
    'add_package_script_snippets',
    'add_primary_runner_manifest',
    'add_profile_session_helper',
    'add_project_config',
    'ignore_runtime_artifacts',
    'merge_package_scripts',
  ]);
});

test('validates platform-specific project config fields', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-config-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });
  await writeMergedPackageJson(targetDir);

  const configPath = path.join(targetDir, 'asl.config.json');
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8')) as {
    app: {
      androidPackage?: string | number;
      iosBundleId?: string;
      iosConflictingBundleIds?: unknown;
      profileSessionScheme?: string;
    };
    androidDrivers?: { supported?: unknown };
    drivers: { supported?: unknown };
    paths: {
      androidArtifactsRoot?: string | number;
      androidScenarioRoot?: string | number;
      artifactRoot?: string | number;
      iosArtifactsRoot?: string | number;
      iosScenarioRoot?: string | number;
      scenarioRoot?: string | number;
    };
  };
  delete config.app.androidPackage;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  assert.deepEqual(validateProjectConfig({
    configPath,
    requestedPlatform: 'all',
  }).missingFields, ['app.androidPackage']);
  assert.equal(validateProjectConfig({
    configPath,
    requestedPlatform: 'ios',
  }).status, 'present');

  let result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.config.status, 'incomplete');
  assert.deepEqual(result.config.missingFields, ['app.androidPackage']);
  assert.equal(result.errors.some((error: string) => error.includes('Project config is missing required field(s): app.androidPackage')), true);
  assert.equal(actionCodes(result).includes('fix_project_config'), true);

  config.app.androidPackage = 42;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir, platform: 'android' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.config.invalidFields, ['app.androidPackage']);

  config.app.androidPackage = 'com.example.app';
  delete config.paths.scenarioRoot;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.config.missingFields, [
    'paths.scenarioRoot or paths.iosScenarioRoot',
    'paths.scenarioRoot or paths.androidScenarioRoot',
  ]);

  config.paths.scenarioRoot = 42;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir, platform: 'ios' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.config.invalidFields, ['paths.scenarioRoot']);

  config.paths.scenarioRoot = 'scenarios/mobile';
  config.paths.androidArtifactsRoot = 42;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir, platform: 'android' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.config.invalidFields, ['paths.androidArtifactsRoot']);

  config.paths.androidArtifactsRoot = 'artifacts/android';
  delete config.paths.artifactRoot;
  config.app.androidPackage = 'com.example.app';
  config.drivers.supported = ['fixture-log-ingest', 'adb', 'ios-simctl'];
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'passed');
  assert.equal(result.config.status, 'present');
  assert.deepEqual(result.config.missingSupportedDrivers, ['agent-device', 'argent']);
  assert.equal(
    result.warnings.some((warning: string) =>
      warning.includes('Project config drivers.supported does not list optional package driver(s): agent-device, argent.')),
    true,
  );
  assert.equal(actionCodes(result).includes('fix_project_config'), false);

  config.drivers.supported = ['fixture-log-ingest', 'adb', 'ios-simctl', 'agent-device', 'argent', 'custom-driver'];
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.config.customDrivers, ['custom-driver']);

  config.drivers.supported = ['agent-device', 'argent', 'axe', 'xcodebuildmcp'];
  config.androidDrivers = { supported: ['adb', 'argent'] };
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.config.externalTargetDrivers, ['axe', 'xcodebuildmcp']);
  assert.deepEqual(result.config.packageSupportedDrivers, ['adb', 'agent-device', 'argent']);
  assert.deepEqual(result.config.missingSupportedDrivers, ['fixture-log-ingest', 'ios-simctl']);

  config.drivers.supported = ['fixture-log-ingest', 'adb', 'ios-simctl'];
  delete config.androidDrivers;
  config.app.iosConflictingBundleIds = ['com.example.app.beta', 42];
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.config.invalidFields, ['app.iosConflictingBundleIds']);

  config.drivers.supported = 'adb';
  config.app.iosConflictingBundleIds = [];
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.config.invalidFields, ['drivers.supported']);
});

test('validates runtime artifact gitignore patterns', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-gitignore-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  let gitignore = validateGitignore(targetDir);
  assert.equal(gitignore.status, 'missing');
  assert.equal(gitignore.missingPatterns.includes('artifacts/asl/'), false);
  assert.deepEqual(gitignore.requiredPatterns, [
    '*.memgraph',
    '*.trace',
    '*.xcresult',
    '.asl.local.env',
  ]);

  await fsp.writeFile(path.join(targetDir, '.gitignore'), 'node_modules/\nartifacts/asl/\n', 'utf8');
  gitignore = validateGitignore(targetDir);
  assert.equal(gitignore.status, 'incomplete');
  assert.deepEqual(gitignore.missingPatterns, [
    '*.memgraph',
    '*.trace',
    '*.xcresult',
    '.asl.local.env',
  ]);

  await fsp.writeFile(
    path.join(targetDir, '.gitignore'),
    [
      'node_modules/',
      '.asl.local.env',
      '*.memgraph',
      '*.trace',
      '*.xcresult',
      '',
    ].join('\n'),
    'utf8',
  );
  gitignore = validateGitignore(targetDir);
  assert.equal(gitignore.status, 'present');
  assert.deepEqual(gitignore.missingPatterns, []);
});

test('validates config artifact roots against runtime artifact gitignore patterns', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-config-gitignore-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  const configPath = path.join(targetDir, 'asl.config.json');
  await writeJsonFile(configPath, {
    paths: {
      artifactRoot: 'artifacts/custom',
      androidArtifactsRoot: 'artifacts/custom/android',
      iosArtifactsRoot: 'artifacts/custom/ios',
    },
  });

  await fsp.writeFile(
    path.join(targetDir, '.gitignore'),
    [
      'node_modules/',
      '.asl.local.env',
      'artifacts/asl/',
      'artifacts/example-mobile-app/',
      '*.memgraph',
      '*.trace',
      '*.xcresult',
      '',
    ].join('\n'),
    'utf8',
  );
  let gitignore = validateGitignore(targetDir, configPath);
  assert.equal(gitignore.status, 'incomplete');
  assert.deepEqual(gitignore.configArtifactPatterns, ['artifacts/custom/']);
  assert.deepEqual(gitignore.missingConfigArtifactPatterns, ['artifacts/custom/']);
  assert.deepEqual(gitignore.missingPatterns, ['artifacts/custom/']);

  await fsp.writeFile(
    path.join(targetDir, '.gitignore'),
    [
      'node_modules/',
      '.asl.local.env',
      'artifacts/custom/',
      'artifacts/asl/',
      'artifacts/example-mobile-app/',
      '*.memgraph',
      '*.trace',
      '*.xcresult',
      '',
    ].join('\n'),
    'utf8',
  );
  gitignore = validateGitignore(targetDir, configPath);
  assert.equal(gitignore.status, 'present');
  assert.deepEqual(gitignore.missingConfigArtifactPatterns, []);
  assert.deepEqual(gitignore.missingPatterns, []);
});

test('validates app profile-session helper exports', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-helper-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });
  const helperDir = path.join(targetDir, 'src', 'devtools');
  await fsp.mkdir(helperDir, { recursive: true });
  const helperPath = path.join(helperDir, 'profile-session.ts');
  await fsp.writeFile(helperPath, 'export function emitProfileEvent() {}\n', 'utf8');

  let helper = validateAppHelper(targetDir);

  assert.equal(helper.status, 'incomplete');
  assert.deepEqual(helper.missingExports, [
    'PROFILE_SESSION_STORAGE_KEYS',
    'registerProfileCommandTargetHandler',
    'useProfileSessionBootstrap',
  ]);
  assert.equal(fs.existsSync(helper.path), true);

  await fsp.writeFile(
    helperPath,
    [
      '// registerProfileCommandTargetHandler and useProfileSessionBootstrap are mentioned here only.',
      'export function emitProfileEvent() {}',
      '',
    ].join('\n'),
    'utf8',
  );
  helper = validateAppHelper(targetDir);
  assert.equal(helper.status, 'incomplete');
  assert.deepEqual(helper.missingExports, [
    'PROFILE_SESSION_STORAGE_KEYS',
    'registerProfileCommandTargetHandler',
    'useProfileSessionBootstrap',
  ]);

  await fsp.writeFile(
    helperPath,
    [
      'export {',
      '  emitProfileEvent,',
      '  PROFILE_SESSION_STORAGE_KEYS,',
      '  registerProfileCommandTargetHandler,',
      '  useProfileSessionBootstrap,',
      "} from 'agent-scenario-loop/app/profile-session';",
      '',
    ].join('\n'),
    'utf8',
  );
  helper = validateAppHelper(targetDir);
  assert.equal(helper.status, 'present');
  assert.deepEqual(helper.missingExports, []);

  await fsp.writeFile(
    helperPath,
    "export * from 'agent-scenario-loop/app/profile-session';\n",
    'utf8',
  );
  helper = validateAppHelper(targetDir);
  assert.equal(helper.status, 'present');
  assert.deepEqual(helper.missingExports, []);

  await fsp.writeFile(
    helperPath,
    "export * from '../../node_modules/agent-scenario-loop/app/profile-session';\n",
    'utf8',
  );
  helper = validateAppHelper(targetDir);
  assert.equal(helper.status, 'present');
  assert.deepEqual(helper.missingExports, []);
});

test('validates generated package-script snippets', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-scripts-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });
  const scriptsDir = path.join(targetDir, 'asl');
  await fsp.mkdir(scriptsDir, { recursive: true });
  await fsp.writeFile(
    path.join(scriptsDir, 'package-scripts.json'),
    `${JSON.stringify({
      'asl:check:ios': 'asl-check-plan --scenario scenarios/mobile/missing.json --runner runner-manifests/primary-runner.json --platform ios',
      'asl:validate': 'not-an-asl-bin --root . --platform all',
    }, null, 2)}\n`,
    'utf8',
  );

  const scripts = validatePackageScripts({ packageRoot: ROOT, rootDir: targetDir });

  assert.equal(scripts.status, 'incomplete');
  assert.equal(scripts.packageJsonStatus, 'missing');
  assert.deepEqual(scripts.invalidScripts, [
    'asl:check:ios is missing required flag(s): --provider, --out.',
    'asl:validate should start with asl-validate-project.',
  ]);
  assert.deepEqual(scripts.missingScripts, [
    'asl:check:android',
    'asl:host:doctor',
    'asl:profile:ios',
    'asl:profile:android',
    'asl:profile:ios:provider',
    'asl:profile:android:provider',
    'asl:agent-device:check',
    'asl:agent-device:ios',
    'asl:agent-device:android',
    'asl:argent:check',
    'asl:argent:ios',
    'asl:argent:android',
    'asl:ios:live',
    'asl:android:live',
    'asl:ios:live:agent-device',
    'asl:android:live:agent-device',
    'asl:ios:live:argent',
    'asl:android:live:argent',
    'asl:ios:live:runners',
    'asl:android:live:runners',
    'asl:profile:ios:live',
    'asl:profile:android:live',
    'asl:compare:ios',
    'asl:compare:android',
    'asl:live-proof:ios',
    'asl:live-proof:android',
    'asl:live-proof:both',
    'asl:live-proof',
  ]);
  assert.deepEqual(scripts.unknownCommands, ['not-an-asl-bin']);
  assert.equal(scripts.missingPaths.some((missingPath: string) => missingPath.endsWith('scenarios/mobile/missing.json')), true);
});

test('validates app package json exposes generated package scripts', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-project-package-json-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });

  let result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.scripts.packageJsonStatus, 'missing');
  assert.equal(actionCodes(result).includes('merge_package_scripts'), true);

  await writeMergedPackageJson(targetDir);
  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'passed');
  assert.equal(result.scripts.packageJsonStatus, 'present');
  assert.equal(validatePackageJsonScripts({
    expectedScripts: JSON.parse(await fsp.readFile(path.join(targetDir, 'asl', 'package-scripts.json'), 'utf8')),
    packageJsonPath: path.join(targetDir, 'package.json'),
  }).packageJsonStatus, 'present');

  const packageJsonPath = path.join(targetDir, 'package.json');
  const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8')) as {
    scripts: Record<string, string | number>;
  };

  packageJson.scripts['asl:profile:android'] = 'asl-profile-android --config asl.config.json --scenario scenarios/mobile/checkout-submit.json --comparison-lane stale --out artifacts/asl/android/stale --run-id stale';
  await fsp.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.scripts.packageJsonStatus, 'incomplete');
  assert.deepEqual(result.scripts.mismatchedPackageJsonScripts, ['asl:profile:android']);
  assert.equal(result.errors.some((error: string) => error.includes('App package.json ASL script(s) differ from asl/package-scripts.json: asl:profile:android')), true);

  delete packageJson.scripts['asl:validate'];
  packageJson.scripts['asl:check:ios'] = 42;
  packageJson.scripts['asl:profile:android'] = JSON.parse(
    await fsp.readFile(path.join(targetDir, 'asl', 'package-scripts.json'), 'utf8'),
  )['asl:profile:android'];
  await fsp.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.scripts.packageJsonStatus, 'incomplete');
  assert.deepEqual(result.scripts.missingPackageJsonScripts, ['asl:validate']);
  assert.deepEqual(result.scripts.invalidPackageJsonScripts, ['asl:check:ios']);
  assert.equal(result.errors.some((error: string) => error.includes('App package.json is missing ASL script(s): asl:validate')), true);
  assert.equal(result.errors.some((error: string) => error.includes('App package.json has non-string ASL script(s): asl:check:ios')), true);
});

test('validates project-local provider command script references', async (t: TestContext) => {
  const targetDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asl-validate-provider-commands-'));
  t.after(async () => {
    await fsp.rm(targetDir, { recursive: true, force: true });
  });

  await initProject({
    outDir: targetDir,
    packageRoot: ROOT,
    scenarioId: 'Checkout Submit',
  });
  await writeMergedPackageJson(targetDir);

  const providerPath = path.join(targetDir, 'runner-manifests', 'evidence-provider.json');
  assert.deepEqual(validateProviderCommandReferences({ providerPaths: [providerPath] }), []);

  await fsp.rm(path.join(targetDir, 'scripts', 'asl-capture-accessibility-provider.mjs'));
  const missingPaths = validateProviderCommandReferences({ providerPaths: [providerPath] });
  assert.equal(missingPaths.length, 1);
  assert.equal(missingPaths[0].endsWith('scripts/asl-capture-accessibility-provider.mjs'), true);

  const result = await validateProject({ rootDir: targetDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.errors.some((error: string) => error.includes('Provider commands reference missing path(s)')), true);
  assert.equal(actionCodes(result).includes('fix_provider_command_paths'), true);
});

test('validates required package-script lifecycle shapes', () => {
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:profile:ios:provider',
    command: 'asl-profile-ios --config asl.config.json --scenario scenarios/mobile/checkout.json --provider runner-manifests/evidence-provider.json --comparison-lane checkout-ios-provider --out artifacts/asl/ios --run-id checkout-ios-provider',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:profile:android:provider',
    command: 'asl-profile-android --config asl.config.json --scenario scenarios/mobile/checkout.json --comparison-lane checkout-android-provider --out artifacts/asl/android --run-id checkout-android-provider',
  }), 'asl:profile:android:provider is missing required flag(s): --provider.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:host:doctor',
    command: 'asl-host-doctor --out artifacts/asl/host-doctor',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:host:doctor',
    command: 'asl-host-doctor --require android,ios',
  }), 'asl:host:doctor is missing required flag(s): --out.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:agent-device:check',
    command: 'asl-agent-device --check --out artifacts/asl/agent-device-check',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:agent-device:check',
    command: 'asl-agent-device --check',
  }), 'asl:agent-device:check is missing required flag(s): --out.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:agent-device:ios',
    command: 'asl-agent-device --platform ios --scenario scenarios/mobile/checkout.json --app com.example.app --open --out artifacts/asl/agent-device-ios --run-id checkout-ios-agent-device',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:agent-device:android',
    command: 'asl-agent-device --platform ios --scenario scenarios/mobile/checkout.json --app com.example.app --open --out artifacts/asl/agent-device-android --run-id checkout-android-agent-device',
  }), 'asl:agent-device:android has incorrect required value(s): --platform=android.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:argent:check',
    command: 'asl-argent --check --out artifacts/asl/argent-check',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:argent:check',
    command: 'asl-argent --check',
  }), 'asl:argent:check is missing required flag(s): --out.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:argent:ios',
    command: 'asl-argent --platform ios --scenario scenarios/mobile/checkout.json --app com.example.app --device booted --out artifacts/asl/argent-ios --run-id checkout-ios-argent',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:argent:android',
    command: 'asl-argent --platform ios --scenario scenarios/mobile/checkout.json --app com.example.app --device emulator-5554 --out artifacts/asl/argent-android --run-id checkout-android-argent',
  }), 'asl:argent:android has incorrect required value(s): --platform=android.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:ios:live',
    command: 'asl-live-ios --config asl.config.json --scenario scenarios/mobile/checkout.json --out artifacts/asl/ios-live',
  }), 'asl:ios:live is missing required flag(s): --compare-latest, --fail-on-regression.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:android:live',
    command: 'asl-live-android --config asl.config.json --scenario scenarios/mobile/checkout.json --out artifacts/asl/android-live --compare-latest --fail-on-regression',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:profile:ios:live',
    command: 'asl-profile-ios --config asl.config.json --scenario scenarios/mobile/checkout.json --simctl-capture --profile-session --launch --comparison-lane checkout-ios-live --out artifacts/asl/ios --run-id checkout-ios-live',
  }), null);
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:profile:android:live',
    command: 'asl-profile-android --config asl.config.json --scenario scenarios/mobile/checkout.json --profile-session --launch --out artifacts/asl/android --run-id checkout-android-live',
  }), 'asl:profile:android:live is missing required flag(s): --adb-capture, --comparison-lane.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:compare:android',
    command: 'asl-compare-latest --root artifacts/asl/android --scenario checkout --current artifacts/asl/android/checkout-live --out artifacts/asl/android/comparisons/checkout',
  }), 'asl:compare:android is missing required flag(s): --fail-on-regression.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:check:ios',
    command: 'asl-check-plan --scenario scenarios/mobile/checkout.json --runner runner-manifests/primary-runner.json --provider runner-manifests/evidence-provider.json --platform android --out artifacts/asl/plan/checkout-ios',
  }), 'asl:check:ios has incorrect required value(s): --platform=ios.');
  assert.equal(validatePackageScriptShape({
    scriptName: 'asl:live-proof',
    command: 'asl-live-proof --file artifacts/asl/ios/_live-proof/ios-live-proof/live-proof.json',
  }), 'asl:live-proof is missing required flag(s): --fail-on-regression.');
});

test('warns when config values still use scaffold placeholders', () => {
  const warnings = validateConfigPlaceholders({
    app: {
      androidPackage: 'com.example.app',
      displayName: 'Example App',
      iosBundleId: 'dev.real.app',
      profileSessionScheme: 'real-app',
      scheme: 'example-app',
    },
    projectName: 'replace-me',
  });

  assert.deepEqual(warnings, [
    "Config field projectName still uses placeholder value 'replace-me'.",
    "Config field app.displayName still uses placeholder value 'Example App'.",
    "Config field app.scheme still uses placeholder value 'example-app'.",
    "Config field app.androidPackage still uses placeholder value 'com.example.app'.",
  ]);
});
