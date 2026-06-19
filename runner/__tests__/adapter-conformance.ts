const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCHEMAS, validateJson } = require('../../core/schema-validator');

type ArtifactResult = {
  captures?: Record<string, unknown>;
  health?: Record<string, unknown>;
  runDir: string;
  verdict?: Record<string, unknown>;
};

/**
 * Reads a JSON artifact from a run directory.
 *
 * @param {string} runDir
 * @param {string} relativePath
 * @returns {Record<string, any>}
 */
function readRunJson(runDir: string, relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(runDir, relativePath), 'utf8'));
}

/**
 * Asserts an adapter wrote the common ASL artifact set and schema-valid JSON.
 *
 * @param {ArtifactResult} result
 * @param {{expectedHealthStatus?: string, rawArtifacts?: string[]}} options
 * @returns {{health: Record<string, any>, verdict: Record<string, any>}}
 */
function assertAdapterArtifactConformance(
  result: ArtifactResult,
  {
    expectedHealthStatus,
    rawArtifacts = [],
  }: {
    expectedHealthStatus?: string;
    rawArtifacts?: string[];
  } = {},
): {health: Record<string, any>; verdict: Record<string, any>} {
  const healthPath = path.join(result.runDir, 'health.json');
  const verdictPath = path.join(result.runDir, 'verdict.json');
  const summaryPath = path.join(result.runDir, 'agent-summary.md');

  assert.equal(fs.existsSync(healthPath), true, 'adapter wrote health.json');
  assert.equal(fs.existsSync(verdictPath), true, 'adapter wrote verdict.json');
  assert.equal(fs.existsSync(summaryPath), true, 'adapter wrote agent-summary.md');

  const health = readRunJson(result.runDir, 'health.json');
  const verdict = readRunJson(result.runDir, 'verdict.json');
  const healthValidation = validateJson(health, SCHEMAS.health, 'Health artifact');
  const verdictValidation = validateJson(verdict, SCHEMAS.verdict, 'Verdict artifact');

  assert.equal(healthValidation.valid, true, healthValidation.message);
  assert.equal(verdictValidation.valid, true, verdictValidation.message);
  assert.deepEqual(result.health, health, 'returned health matches written health.json');
  assert.deepEqual(result.verdict, verdict, 'returned verdict matches written verdict.json');
  assert.equal(verdict.healthStatus, health.healthStatus);
  if (expectedHealthStatus) {
    assert.equal(health.healthStatus, expectedHealthStatus);
  }

  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /Scenario health/u);

  for (const rawArtifact of rawArtifacts) {
    assert.equal(
      fs.existsSync(path.join(result.runDir, rawArtifact)),
      true,
      `adapter wrote ${rawArtifact}`,
    );
  }

  return { health, verdict };
}

/**
 * Asserts capture paths returned by an adapter point at files in the run dir.
 *
 * @param {ArtifactResult} result
 */
function assertReportedCaptureArtifactsExist(result: ArtifactResult): void {
  for (const capturePath of collectCapturePaths(result.captures)) {
    assert.equal(
      fs.existsSync(path.join(result.runDir, capturePath)),
      true,
      `reported capture exists: ${capturePath}`,
    );
  }
}

/**
 * Asserts every capturePath in raw adapter metadata points at a written file.
 *
 * @param {string} runDir
 * @param {string} metadataRelativePath
 */
function assertMetadataCapturePathsExist(runDir: string, metadataRelativePath: string): void {
  const metadata = readRunJson(runDir, metadataRelativePath);
  for (const capturePath of collectCapturePaths(metadata)) {
    assert.equal(
      fs.existsSync(path.join(runDir, capturePath)),
      true,
      `metadata capture exists: ${capturePath}`,
    );
  }
}

/**
 * Asserts failed health exposes an actionable next action for the named check.
 *
 * @param {Record<string, any>} health
 * @param {{checkName?: string, checkCode?: string}} options
 * @returns {Record<string, any>}
 */
function assertFailedHealthHasActionableMetadata(
  health: Record<string, any>,
  {
    checkCode,
    checkName,
  }: {
    checkCode?: string;
    checkName?: string;
  } = {},
): Record<string, any> {
  assert.equal(health.healthStatus, 'failed');
  const check = (health.checks ?? []).find((item: Record<string, any>) => (
    (!checkName || item.name === checkName) && (!checkCode || item.code === checkCode)
  ));
  assert.ok(check, `failed health includes check ${checkName ?? checkCode ?? '<any>'}`);
  assert.equal(check.status, 'failed');
  assert.equal(typeof check.metadata?.nextActionCode, 'string');
  assert.notEqual(check.metadata.nextActionCode, '');
  return check;
}

/**
 * Recursively collects relative capture paths from common adapter result/metadata shapes.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function collectCapturePaths(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('captures/') ? [value] : [];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectCapturePaths(item));
  }

  const source = value as Record<string, unknown>;
  const ownCapturePath = typeof source.capturePath === 'string' ? [source.capturePath] : [];
  const nested = Object.values(source).flatMap((item) => collectCapturePaths(item));
  return [...ownCapturePath, ...nested]
    .filter((item) => item.startsWith('captures/'));
}

export {
  assertAdapterArtifactConformance,
  assertFailedHealthHasActionableMetadata,
  assertMetadataCapturePathsExist,
  assertReportedCaptureArtifactsExist,
};
