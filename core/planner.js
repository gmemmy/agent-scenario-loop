function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))].sort();
}

function intersection(left, right) {
  const rightSet = new Set(asArray(right));
  return uniqueSorted(asArray(left).filter((value) => rightSet.has(value)));
}

function includesAll(available, required) {
  const availableSet = new Set(asArray(available));
  return asArray(required).filter((item) => !availableSet.has(item));
}

function createIssue(code, message, metadata = {}) {
  return {
    code,
    message,
    ...metadata,
  };
}

function getScenarioId(scenario) {
  return scenario?.id ?? scenario?.name ?? 'unknown-scenario';
}

function getRunnerId(runner) {
  return runner?.runnerId ?? runner?.name ?? 'unknown-runner';
}

function getIssueMetadata(issue) {
  return Object.keys(issue)
    .filter((key) => key !== 'code' && key !== 'message')
    .sort()
    .reduce((metadata, key) => {
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

function issueToHealthCheck(issue, status) {
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

function isProviderActiveForPlatforms(provider, effectivePlatforms) {
  return intersection(provider?.platforms, effectivePlatforms).length > 0;
}

function collectProvidedArtifacts({ runner, evidenceProviders, effectivePlatforms }) {
  const activeProviders = asArray(evidenceProviders).filter((provider) =>
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

function collectProvidedCapabilities({ runner, evidenceProviders, effectivePlatforms }) {
  const activeProviders = asArray(evidenceProviders).filter((provider) =>
    isProviderActiveForPlatforms(provider, effectivePlatforms),
  );

  return uniqueSorted([
    ...asArray(runner?.capabilities),
    ...activeProviders.flatMap((provider) => asArray(provider?.capabilities)),
  ]);
}

function validatePrimaryRunner({ runner, errors }) {
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

function resolveEffectivePlatforms({ scenario, runner, platform, errors }) {
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

function evaluateRunnerCompatibility({
  scenario,
  runner,
  evidenceProviders = [],
  platform = null,
} = {}) {
  const errors = [];
  const warnings = [];

  validatePrimaryRunner({ runner, errors });

  if (!scenario || typeof scenario !== 'object') {
    errors.push(createIssue('scenario_missing', 'A scenario manifest is required.'));
    return {
      compatible: false,
      errors,
      warnings,
      matched: {
        platforms: [],
        capabilities: [],
        artifacts: [],
        evidenceProviders: [],
      },
    };
  }

  const effectivePlatforms = resolveEffectivePlatforms({ scenario, runner, platform, errors });
  const runnerCapabilities = uniqueSorted(asArray(runner?.capabilities));
  const missingRequiredCapabilities = includesAll(
    runnerCapabilities,
    asArray(scenario.requiredCapabilities),
  );

  for (const capability of missingRequiredCapabilities) {
    errors.push(
      createIssue(
        'missing_required_capability',
        `Runner \`${getRunnerId(runner)}\` is missing required capability \`${capability}\`.`,
        {
          runnerId: getRunnerId(runner),
          scenarioId: getScenarioId(scenario),
          capability,
        },
      ),
    );
  }

  const providedCapabilities = collectProvidedCapabilities({
    runner,
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

  const { activeProviders, artifacts } = collectProvidedArtifacts({
    runner,
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
      artifacts,
      evidenceProviders: activeProviders.map((provider) => getRunnerId(provider)),
    },
  };
}

function buildCompatibilityHealth({
  scenario,
  runId,
  compatibility,
}) {
  const scenarioId = getScenarioId(scenario);
  const resolvedRunId = typeof runId === 'string' && runId.length > 0 ? runId : 'unknown-run';
  const errors = asArray(compatibility?.errors);
  const warnings = asArray(compatibility?.warnings);
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
      artifacts: uniqueSorted(asArray(compatibility?.matched?.artifacts)),
      evidenceProviders: uniqueSorted(asArray(compatibility?.matched?.evidenceProviders)),
    },
  };
}

function buildUnevaluatedVerdict({ scenario, runId, health }) {
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

module.exports = {
  buildCompatibilityHealth,
  buildUnevaluatedVerdict,
  evaluateRunnerCompatibility,
  intersection,
  uniqueSorted,
};
