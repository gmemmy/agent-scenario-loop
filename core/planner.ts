type ManifestRecord = Record<string, unknown>;

type PlannerIssue = {
  code: string;
  message: string;
  [key: string]: unknown;
};

type CompatibilityResult = {
  compatible: boolean;
  errors: PlannerIssue[];
  warnings: PlannerIssue[];
  matched: {
    platforms: string[];
    capabilities: string[];
    driverActions: string[];
    artifacts: string[];
    evidenceProviders: string[];
  };
};

type ScenarioStep = ManifestRecord & {
  driverAction?: unknown;
  required?: unknown;
};

type ScenarioManifest = ManifestRecord & {
  id?: string;
  name?: string;
  flowId?: string;
  platforms?: unknown[];
  requiredCapabilities?: unknown[];
  optionalCapabilities?: unknown[];
  steps?: ScenarioStep[];
  artifacts?: {
    required?: unknown[];
    optional?: unknown[];
  };
};

type RunnerManifest = ManifestRecord & {
  runnerId?: string;
  name?: string;
  kind?: string;
  platforms?: unknown[];
  capabilities?: unknown[];
  driverActions?: unknown[];
  artifactOutputs?: unknown[];
};

/**
 * Returns `value` when it is already an array; otherwise returns an empty array.
 *
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Returns non-empty string values with duplicates removed and deterministic ordering.
 *
 * @param {unknown[]} values
 * @returns {string[]}
 */
function uniqueSorted(values: unknown[]): string[] {
  const strings = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return [...new Set(strings)].sort();
}

/**
 * Finds the unique string values shared by two arrays.
 *
 * @param {unknown[]} left
 * @param {unknown[]} right
 * @returns {string[]}
 */
function intersection(left: unknown[], right: unknown[]): string[] {
  const rightSet = new Set(asArray(right));
  return uniqueSorted(asArray(left).filter((value) => rightSet.has(value)));
}

/**
 * Returns required values that are absent from the available set.
 *
 * @param {unknown[]} available
 * @param {unknown[]} required
 * @returns {unknown[]}
 */
function includesAll(available: unknown[], required: unknown[]): unknown[] {
  const availableSet = new Set(asArray(available));
  return asArray(required).filter((item) => !availableSet.has(item));
}

/**
 * Creates a structured planner issue.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [metadata]
 * @returns {Record<string, unknown>}
 */
function createIssue(code: string, message: string, metadata: ManifestRecord = {}): PlannerIssue {
  return {
    code,
    message,
    ...metadata,
  };
}

/**
 * Resolves the stable scenario identifier used in generated artifacts.
 *
 * @param {Record<string, unknown> | null | undefined} scenario
 * @returns {string}
 */
function getScenarioId(scenario: ScenarioManifest | null | undefined): string {
  return scenario?.id ?? scenario?.name ?? 'unknown-scenario';
}

/**
 * Resolves the stable runner identifier used in planner errors.
 *
 * @param {Record<string, unknown> | null | undefined} runner
 * @returns {string}
 */
function getRunnerId(runner: RunnerManifest | null | undefined): string {
  return runner?.runnerId ?? runner?.name ?? 'unknown-runner';
}

/**
 * Keeps only scalar issue metadata so health artifacts remain schema-safe.
 *
 * @param {Record<string, unknown>} issue
 * @returns {Record<string, string | number | boolean | null>}
 */
function getIssueMetadata(issue: PlannerIssue): Record<string, string | number | boolean | null> {
  return Object.keys(issue)
    .filter((key) => key !== 'code' && key !== 'message')
    .sort()
    .reduce<Record<string, string | number | boolean | null>>((metadata, key) => {
      const value = issue[key];
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        metadata[key] = value;
      }
      return metadata;
    }, {});
}

/**
 * Converts a planner issue into a `health.json` check entry.
 *
 * @param {Record<string, unknown>} issue
 * @param {'failed' | 'warning'} status
 * @returns {Record<string, unknown>}
 */
function issueToHealthCheck(issue: PlannerIssue, status: 'failed' | 'warning'): ManifestRecord {
  const metadata = getIssueMetadata(issue);
  return {
    name: issue.code,
    status,
    source:
      issue.code?.includes('artifact') || issue.code?.includes('evidence')
        ? 'evidence'
        : 'planner',
    code: issue.code,
    message: issue.message,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * Returns whether a provider can participate in the selected platform set.
 *
 * @param {Record<string, unknown>} provider
 * @param {string[]} effectivePlatforms
 * @returns {boolean}
 */
function isProviderActiveForPlatforms(provider: RunnerManifest, effectivePlatforms: string[]): boolean {
  return intersection(asArray(provider?.platforms), effectivePlatforms).length > 0;
}

/**
 * Collects artifacts available from the primary runner and active evidence providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {{activeProviders: Record<string, unknown>[], artifacts: string[]}}
 */
function collectProvidedArtifacts({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): { activeProviders: RunnerManifest[]; artifacts: string[] } {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return {
    activeProviders,
    artifacts: uniqueSorted([
      ...asArray(runner?.artifactOutputs),
      ...activeProviders.flatMap((provider) => asArray(provider?.artifactOutputs)),
    ]),
  };
}

/**
 * Collects capabilities available from the primary runner and active evidence providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {string[]}
 */
function collectProvidedCapabilities({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): string[] {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return uniqueSorted([
    ...asArray(runner?.capabilities),
    ...activeProviders.flatMap((provider) => asArray(provider?.capabilities)),
  ]);
}

/**
 * Collects driver operations available from the primary runner and active providers.
 *
 * @param {{runner: Record<string, unknown>, evidenceProviders: Record<string, unknown>[], effectivePlatforms: string[]}} options
 * @returns {string[]}
 */
function collectProvidedDriverActions({
  runner,
  evidenceProviders,
  effectivePlatforms,
}: {
  runner: RunnerManifest;
  evidenceProviders: RunnerManifest[];
  effectivePlatforms: string[];
}): string[] {
  const activeProviders = evidenceProviders.filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return uniqueSorted([
    ...asArray(runner?.driverActions),
    ...activeProviders.flatMap((provider) => asArray(provider?.driverActions)),
  ]);
}

/**
 * Collects driver operations required by scenario steps.
 *
 * @param {Record<string, unknown>} scenario
 * @returns {{required: string[], optional: string[]}}
 */
function collectScenarioDriverActions(scenario: ScenarioManifest): { required: string[]; optional: string[] } {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const required: unknown[] = [];
  const optional: unknown[] = [];

  for (const step of steps) {
    if (!step || typeof step !== 'object' || typeof step.driverAction !== 'string') {
      continue;
    }

    if (step.required === false) {
      optional.push(step.driverAction);
    } else {
      required.push(step.driverAction);
    }
  }

  return {
    required: uniqueSorted(required),
    optional: uniqueSorted(optional),
  };
}

/**
 * Adds planner errors when the selected runner cannot own a run lifecycle.
 *
 * @param {{runner: Record<string, unknown>, errors: Record<string, unknown>[]}} options
 * @returns {void}
 */
function validatePrimaryRunner({
  runner,
  errors,
}: {
  runner?: RunnerManifest | undefined;
  errors: PlannerIssue[];
}): void {
  if (!runner || typeof runner !== 'object') {
    errors.push(createIssue('runner_missing', 'A primary runner capability manifest is required.'));
    return;
  }

  if (runner.kind && runner.kind !== 'primary') {
    errors.push(
      createIssue('runner_not_primary', 'The selected runner must have kind `primary`.', {
        runnerId: getRunnerId(runner),
        kind: runner.kind,
      }),
    );
  }
}

/**
 * Determines the platform set a plan should evaluate and records platform mismatches.
 *
 * @param {{scenario: Record<string, unknown>, runner: Record<string, unknown>, platform?: string | null, errors: Record<string, unknown>[]}} options
 * @returns {string[]}
 */
function resolveEffectivePlatforms({
  scenario,
  runner,
  platform,
  errors,
}: {
  scenario: ScenarioManifest;
  runner: RunnerManifest;
  platform?: string | null;
  errors: PlannerIssue[];
}): string[] {
  const scenarioPlatforms = asArray(scenario?.platforms);
  const runnerPlatforms = asArray(runner?.platforms);

  if (platform) {
    if (!scenarioPlatforms.includes(platform)) {
      errors.push(
        createIssue('platform_not_supported_by_scenario', 'The scenario does not support the selected platform.', {
          scenarioId: getScenarioId(scenario),
          platform,
          supportedPlatforms: uniqueSorted(scenarioPlatforms),
        }),
      );
    }

    if (!runnerPlatforms.includes(platform)) {
      errors.push(
        createIssue('platform_not_supported_by_runner', 'The runner does not support the selected platform.', {
          runnerId: getRunnerId(runner),
          platform,
          supportedPlatforms: uniqueSorted(runnerPlatforms),
        }),
      );
    }

    return [platform];
  }

  const commonPlatforms = intersection(scenarioPlatforms, runnerPlatforms);
  if (commonPlatforms.length === 0) {
    errors.push(
      createIssue('platform_mismatch', 'The scenario and runner do not share a supported platform.', {
        scenarioId: getScenarioId(scenario),
        runnerId: getRunnerId(runner),
        scenarioPlatforms: uniqueSorted(scenarioPlatforms),
        runnerPlatforms: uniqueSorted(runnerPlatforms),
      }),
    );
  }

  return commonPlatforms;
}

/**
 * Evaluates whether a scenario can be served by a primary runner plus evidence providers.
 *
 * @param {{scenario?: Record<string, unknown>, runner?: Record<string, unknown>, evidenceProviders?: Record<string, unknown>[], platform?: string | null}} [options]
 * @returns {{compatible: boolean, errors: Record<string, unknown>[], warnings: Record<string, unknown>[], matched: {platforms: string[], capabilities: string[], driverActions: string[], artifacts: string[], evidenceProviders: string[]}}}
 */
function evaluateRunnerCompatibility({
  scenario,
  runner,
  evidenceProviders = [],
  platform = null,
}: {
  scenario?: ScenarioManifest;
  runner?: RunnerManifest;
  evidenceProviders?: RunnerManifest[];
  platform?: string | null;
} = {}): CompatibilityResult {
  const errors: PlannerIssue[] = [];
  const warnings: PlannerIssue[] = [];

  validatePrimaryRunner({ runner, errors });
  const primaryRunner = runner ?? {};

  if (!scenario || typeof scenario !== 'object') {
    errors.push(createIssue('scenario_missing', 'A scenario manifest is required.'));
    return {
      compatible: false,
      errors,
      warnings,
      matched: {
        platforms: [],
        capabilities: [],
        driverActions: [],
        artifacts: [],
        evidenceProviders: [],
      },
    };
  }

  const effectivePlatforms = resolveEffectivePlatforms({ scenario, runner: primaryRunner, platform, errors });
  const runnerCapabilities = uniqueSorted(asArray(primaryRunner.capabilities));
  const missingRequiredCapabilities = includesAll(
    runnerCapabilities,
    asArray(scenario.requiredCapabilities),
  );

  for (const capability of missingRequiredCapabilities) {
    errors.push(
      createIssue(
        'missing_required_capability',
        `Runner \`${getRunnerId(primaryRunner)}\` is missing required capability \`${capability}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          capability,
        },
      ),
    );
  }

  const providedCapabilities = collectProvidedCapabilities({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const missingOptionalCapabilities = includesAll(
    providedCapabilities,
    asArray(scenario.optionalCapabilities),
  );

  for (const capability of missingOptionalCapabilities) {
    warnings.push(
      createIssue('missing_optional_capability', `No active runner or provider declares optional capability \`${capability}\`.`, {
        scenarioId: getScenarioId(scenario),
        capability,
      }),
    );
  }

  const providedDriverActions = collectProvidedDriverActions({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const scenarioDriverActions = collectScenarioDriverActions(scenario);
  for (const driverAction of includesAll(providedDriverActions, scenarioDriverActions.required)) {
    errors.push(
      createIssue(
        'missing_required_driver_action',
        `No active runner or provider declares required driver action \`${driverAction}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          driverAction,
        },
      ),
    );
  }

  for (const driverAction of includesAll(providedDriverActions, scenarioDriverActions.optional)) {
    warnings.push(
      createIssue(
        'missing_optional_driver_action',
        `No active runner or provider declares optional driver action \`${driverAction}\`.`,
        {
          runnerId: getRunnerId(primaryRunner),
          scenarioId: getScenarioId(scenario),
          driverAction,
        },
      ),
    );
  }

  const { activeProviders, artifacts } = collectProvidedArtifacts({
    runner: primaryRunner,
    evidenceProviders,
    effectivePlatforms,
  });
  const requiredArtifacts = asArray(scenario.artifacts?.required);
  const optionalArtifacts = asArray(scenario.artifacts?.optional);

  for (const artifact of includesAll(artifacts, requiredArtifacts)) {
    errors.push(
      createIssue('missing_required_artifact', `No active runner or evidence provider can produce required artifact \`${artifact}\`.`, {
        scenarioId: getScenarioId(scenario),
        artifact,
      }),
    );
  }

  for (const artifact of includesAll(artifacts, optionalArtifacts)) {
    warnings.push(
      createIssue('missing_optional_artifact', `No active runner or evidence provider declares optional artifact \`${artifact}\`.`, {
        scenarioId: getScenarioId(scenario),
        artifact,
      }),
    );
  }

  return {
    compatible: errors.length === 0,
    errors,
    warnings,
    matched: {
      platforms: effectivePlatforms,
      capabilities: providedCapabilities,
      driverActions: providedDriverActions,
      artifacts,
      evidenceProviders: activeProviders.map((provider) => getRunnerId(provider)),
    },
  };
}

/**
 * Builds the initial `health.json` artifact from planner compatibility results.
 *
 * @param {{scenario: Record<string, unknown>, runId?: string, compatibility: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildCompatibilityHealth({
  scenario,
  runId,
  compatibility,
}: {
  scenario: ScenarioManifest;
  runId?: string;
  compatibility: CompatibilityResult;
}): ManifestRecord {
  const scenarioId = getScenarioId(scenario);
  const resolvedRunId = typeof runId === 'string' && runId.length > 0 ? runId : 'unknown-run';
  const errors = compatibility.errors;
  const warnings = compatibility.warnings;
  const failedChecks = errors.map((issue) => issueToHealthCheck(issue, 'failed'));
  const warningChecks = warnings.map((issue) => issueToHealthCheck(issue, 'warning'));
  const checks =
    failedChecks.length > 0
      ? failedChecks
      : [
          {
            name: 'planner_compatibility',
            status: 'passed',
            source: 'planner',
            code: 'planner_compatible',
            message: 'Scenario requirements are compatible with the selected runner and evidence providers.',
          },
        ];

  return {
    schemaVersion: '1.0.0',
    scenarioId,
    ...(typeof scenario?.flowId === 'string' ? { flowId: scenario.flowId } : {}),
    runId: resolvedRunId,
    healthStatus: failedChecks.length > 0 ? 'failed' : 'passed',
    checks,
    ...(warningChecks.length > 0 ? { warnings: warningChecks } : {}),
    matched: {
      platforms: uniqueSorted(asArray(compatibility?.matched?.platforms)),
      capabilities: uniqueSorted(asArray(compatibility?.matched?.capabilities)),
      driverActions: uniqueSorted(asArray(compatibility?.matched?.driverActions)),
      artifacts: uniqueSorted(asArray(compatibility?.matched?.artifacts)),
      evidenceProviders: uniqueSorted(asArray(compatibility?.matched?.evidenceProviders)),
    },
  };
}

/**
 * Builds a pre-budget `verdict.json` artifact from scenario health.
 *
 * @param {{scenario: Record<string, unknown>, runId?: string, health: Record<string, unknown>}} options
 * @returns {Record<string, unknown>}
 */
function buildUnevaluatedVerdict({
  scenario,
  runId,
  health,
}: {
  scenario: ScenarioManifest;
  runId?: string;
  health: ManifestRecord;
}): ManifestRecord {
  const healthStatus = health?.healthStatus ?? 'failed';
  const scenarioId = health?.scenarioId ?? getScenarioId(scenario);
  const resolvedRunId =
    typeof health?.runId === 'string' && health.runId.length > 0
      ? health.runId
      : typeof runId === 'string' && runId.length > 0
        ? runId
        : 'unknown-run';
  const canEvaluateBudgets = healthStatus === 'passed';

  return {
    schemaVersion: '1.0.0',
    scenarioId,
    ...(typeof health?.flowId === 'string'
      ? { flowId: health.flowId }
      : typeof scenario?.flowId === 'string'
        ? { flowId: scenario.flowId }
        : {}),
    runId: resolvedRunId,
    healthStatus,
    verdictStatus: canEvaluateBudgets ? 'not_evaluated' : 'inconclusive',
    budgetChecks: [],
    summary: canEvaluateBudgets
      ? 'Scenario health passed; budget evaluation has not run yet.'
      : 'Scenario health did not pass; do not optimize from this run.',
  };
}

export {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  collectProvidedDriverActions,
  collectScenarioDriverActions,
  evaluateRunnerCompatibility,
  intersection,
  uniqueSorted,
};

export type {
  CompatibilityResult,
  ManifestRecord,
  PlannerIssue,
  RunnerManifest,
  ScenarioManifest,
};
