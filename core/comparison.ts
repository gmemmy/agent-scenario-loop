const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createArtifactLayout } = require('./artifact-layout');
const { classifyNativePerformanceComparisonReadiness } = require('./native-performance');
const {
  buildExplanation,
  buildNotComparableNativePerformanceComparison,
  compareNativePerformanceEvidencePair,
  isNativePerformanceRegressed,
} = require('./native-performance-comparison');
const { readRunIndexEntry } = require('./run-index');
const { SCHEMAS, assertValidJson } = require('./schema-validator');

import type { RunIndexEntry } from './run-index';
import type { NativePerformanceComparisonSection } from './native-performance-comparison';

type ComparisonRecord = Record<string, any>;
type NativePerformanceAttachmentRecord = {
  path: string;
  providerId?: string;
};
type OptionalArtifactRecord = {
  error?: string;
  value?: ComparisonRecord;
};
type ComparisonRunArtifacts = {
  health: ComparisonRecord;
  manifest: ComparisonRecord | null;
  nativePerformance: {
    attachmentCount: number;
    attachments: NativePerformanceAttachmentRecord[];
    attachmentPath?: string;
    inventoried: boolean;
    providerId?: string;
    readError?: string;
    validationError?: string;
    value?: ComparisonRecord;
  };
  verdict: ComparisonRecord;
};

type ComparisonBudgetCheck = {
  actual: number | boolean | null;
  name: string;
  pass: boolean;
  unit: 'ms' | 'count' | 'bytes' | 'percent' | 'boolean';
};

type MetricComparison = {
  name: string;
  unit: ComparisonBudgetCheck['unit'];
  baseline: number | boolean | null;
  current: number | boolean | null;
  delta: number | null;
  status: 'better' | 'worse' | 'unchanged' | 'inconclusive' | 'low_confidence';
  notes?: string;
};

type ComparisonStatus = MetricComparison['status'] | 'mixed';

type ComparisonBasisStrategy = 'explicit' | 'latest_trusted_prior';

type ComparisonRunBasis = {
  healthStatus?: string;
  runDir?: string;
  runId: string;
  verdictStatus?: string;
};

type ComparisonSelectionBasis = {
  artifactRoot?: string;
  candidatesInspected?: number;
  cohortHash?: string;
  comparisonLane?: string;
  scenarioId?: string;
  scenarioHash?: string;
  selectedRunDir?: string;
  selectedRunId?: string;
  skippedCurrentRun?: boolean;
  trustedCohortCandidates?: number;
  trustedComparableCandidates?: number;
  trustedCandidates?: number;
  trustedPriorCandidates?: number;
  trustedScenarioContractCandidates?: number;
};

type ComparisonBasis = {
  baseline: ComparisonRunBasis;
  current: ComparisonRunBasis;
  selection?: ComparisonSelectionBasis;
  strategy: ComparisonBasisStrategy;
};
type MeasurementPolicy = {
  baselineSelection: {
    mode: 'explicit' | 'latestTrustedPrior';
    poisoningProtection: {
      requirePassedHealth: boolean;
      requirePassedVerdict: boolean;
      requireMatchingScenarioId: boolean;
      comparisonLane?: string;
      scenarioHash?: string;
      cohortHash?: string;
    };
  };
  samples: {
    baseline: {
      validSamples: number;
      warmupSamples: number;
      outliersExcluded: number;
    };
    current: {
      validSamples: number;
      warmupSamples: number;
      outliersExcluded: number;
    };
  };
  tolerance: {
    timing: {
      absoluteMs: number;
      relative: number;
    };
  };
  confidence: {
    level: 'single_run' | 'multi_sample' | 'insufficient' | 'low_confidence';
    minValidSamples: number;
    reason?: string;
  };
};

type BuildComparisonOptions = {
  baselineHealth: ComparisonRecord;
  baselineManifest?: ComparisonRecord | null;
  baselineVerdict: ComparisonRecord;
  comparisonBasis?: ComparisonBasis;
  currentHealth: ComparisonRecord;
  currentManifest?: ComparisonRecord | null;
  currentVerdict: ComparisonRecord;
  nativeComparison?: NativePerformanceComparisonSection;
};

type CompareRunDirectoriesOptions = {
  baselineDir: string;
  currentDir: string;
  selection?: ComparisonSelectionBasis;
  strategy?: ComparisonBasisStrategy;
};

const MIN_MS_COMPARISON_TOLERANCE = 16;
const RELATIVE_MS_COMPARISON_TOLERANCE = 0.05;

function readNativePerformanceArtifact({
  nativeAttachment,
  runDir,
}: {
  nativeAttachment: NativePerformanceAttachmentRecord | undefined;
  runDir: string;
}): OptionalArtifactRecord {
  if (!nativeAttachment?.path) {
    return {};
  }

  const resolvedPath = resolveContainedRunArtifactPath({
    runDir,
    runRelativePath: nativeAttachment.path,
  });
  if (resolvedPath.filePath) {
    return readOptionalArtifact(resolvedPath.filePath);
  }

  if (resolvedPath.error) {
    return {
      error: resolvedPath.error,
    };
  }

  return {};
}

/**
 * Reads and validates the health and verdict artifacts from a run directory.
 *
 * @param {string} runDir
 * @returns {ComparisonRunArtifacts}
 */
function readRunArtifacts(runDir: string): ComparisonRunArtifacts {
  const layout = createArtifactLayout({ outputDir: runDir });
  const health = JSON.parse(fs.readFileSync(layout.health, 'utf8'));
  const verdict = JSON.parse(fs.readFileSync(layout.verdict, 'utf8'));
  const manifestResult = readOptionalArtifact(layout.profile.manifest);
  const manifest = manifestResult.value ?? null;
  const nativeAttachments = readNativePerformanceAttachments(manifest);
  const nativeAttachment = nativeAttachments.length === 1 ? nativeAttachments[0] : undefined;
  const nativeArtifact = readNativePerformanceArtifact({
    nativeAttachment,
    runDir,
  });
  let nativeValidationError: string | undefined;
  let nativeValue: ComparisonRecord | undefined;
  if (nativeArtifact.value) {
    try {
      nativeValue = assertValidJson(
        nativeArtifact.value,
        SCHEMAS.nativePerformance,
        'Native performance evidence artifact',
      ) as ComparisonRecord;
    } catch (error) {
      nativeValidationError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    health: assertValidJson(health, SCHEMAS.health, 'Health artifact') as ComparisonRecord,
    manifest,
    nativePerformance: {
      attachmentCount: nativeAttachments.length,
      attachments: nativeAttachments,
      ...(nativeAttachment ? { attachmentPath: nativeAttachment.path } : {}),
      inventoried: hasNativePerformanceInventory(manifest),
      ...(nativeAttachment?.providerId ? { providerId: nativeAttachment.providerId } : {}),
      ...(nativeArtifact.error ? { readError: nativeArtifact.error } : {}),
      ...(nativeValidationError ? { validationError: nativeValidationError } : {}),
      ...(nativeValue ? { value: nativeValue } : {}),
    },
    verdict: assertValidJson(verdict, SCHEMAS.verdict, 'Verdict artifact') as ComparisonRecord,
  };
}

function readOptionalArtifact(filePath: string): OptionalArtifactRecord {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        error: `Artifact ${filePath} must contain a JSON object.`,
      };
    }
    return {
      value: parsed as ComparisonRecord,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveContainedRunArtifactPath({
  runDir,
  runRelativePath,
}: {
  runDir: string;
  runRelativePath: string;
}): { error?: string; filePath?: string } {
  if (path.isAbsolute(runRelativePath)) {
    return {
      error: `Attachment path ${runRelativePath} must be run-relative.`,
    };
  }

  const segments = runRelativePath.split(/[\\/]/u);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return {
      error: `Attachment path ${runRelativePath} must not contain empty, "." , or ".." segments.`,
    };
  }

  const resolvedRunDir = path.resolve(runDir);
  const resolvedTargetPath = path.resolve(resolvedRunDir, runRelativePath);
  const relativeToRunDir = path.relative(resolvedRunDir, resolvedTargetPath);
  if (
    relativeToRunDir.length === 0 ||
    relativeToRunDir.startsWith('..') ||
    path.isAbsolute(relativeToRunDir)
  ) {
    return {
      error: `Attachment path ${runRelativePath} must stay within the run directory.`,
    };
  }

  let targetStatus: ReturnType<typeof fs.lstatSync> | null = null;
  try {
    targetStatus = fs.lstatSync(resolvedTargetPath);
  } catch {
    targetStatus = null;
  }
  if (targetStatus && (targetStatus.isSymbolicLink() || !targetStatus.isFile())) {
    return {
      error: `Attachment path ${runRelativePath} must resolve to a regular file inside the run directory.`,
    };
  }

  if (targetStatus) {
    const realRunDir = fs.realpathSync(resolvedRunDir);
    const realTargetPath = fs.realpathSync(resolvedTargetPath);
    const realRelativePath = path.relative(realRunDir, realTargetPath);
    if (
      realRelativePath.length === 0 ||
      realRelativePath.startsWith('..') ||
      path.isAbsolute(realRelativePath)
    ) {
      return {
        error: `Attachment path ${runRelativePath} must resolve inside the real run directory.`,
      };
    }
    return {
      filePath: realTargetPath,
    };
  }

  return {
    filePath: resolvedTargetPath,
  };
}

function isContainedRunArtifactFile({
  runDir,
  runRelativePath,
}: {
  runDir: string;
  runRelativePath: string;
}): boolean {
  const resolved = resolveContainedRunArtifactPath({
    runDir,
    runRelativePath,
  });
  if (!resolved.filePath) {
    return false;
  }

  try {
    return fs.lstatSync(resolved.filePath).isFile();
  } catch {
    return false;
  }
}

function readContainedRunArtifactJson({
  runDir,
  runRelativePath,
}: {
  runDir: string;
  runRelativePath: string;
}): unknown {
  const resolved = resolveContainedRunArtifactPath({
    runDir,
    runRelativePath,
  });
  if (!resolved.filePath) {
    throw new Error(resolved.error ?? `Attachment path ${runRelativePath} is not a readable run artifact.`);
  }

  return JSON.parse(fs.readFileSync(resolved.filePath, 'utf8'));
}

function readContainedRunArtifactSha256({
  runDir,
  runRelativePath,
}: {
  runDir: string;
  runRelativePath: string;
}): string {
  const resolved = resolveContainedRunArtifactPath({
    runDir,
    runRelativePath,
  });
  if (!resolved.filePath) {
    throw new Error(resolved.error ?? `Attachment path ${runRelativePath} is not a readable run artifact.`);
  }

  return crypto.createHash('sha256').update(fs.readFileSync(resolved.filePath)).digest('hex');
}

function readNativePerformanceAttachments(manifest: ComparisonRecord | null): NativePerformanceAttachmentRecord[] {
  const evidenceAttachments = Array.isArray(manifest?.artifacts?.evidenceAttachments)
    ? manifest?.artifacts?.evidenceAttachments
    : [];
  return evidenceAttachments
    .map((attachment: unknown) => {
      if (!attachment || typeof attachment !== 'object') {
        return null;
      }
      const record = attachment as { kind?: unknown; path?: unknown };
      const providerId = record.kind === 'nativePerformance' && typeof record.path === 'string'
        ? readProviderIdFromAttachmentPath(record.path)
        : undefined;
      return record.kind === 'nativePerformance' && typeof record.path === 'string'
        ? {
            path: record.path,
            ...(providerId
              ? { providerId }
              : {}),
          }
        : null;
    })
    .filter((attachmentEntry: NativePerformanceAttachmentRecord | null): attachmentEntry is NativePerformanceAttachmentRecord => Boolean(attachmentEntry));
}

function readProviderIdFromAttachmentPath(runRelativePath: string): string | undefined {
  const segments = runRelativePath.split(/[\\/]/u).filter((segment) => segment.length > 0);
  if (segments.length < 4 || segments[0] !== 'raw' || segments[1] !== 'providers') {
    return undefined;
  }

  const providerId = segments[2];
  return typeof providerId === 'string' && providerId.length > 0 ? providerId : undefined;
}

function hasNativePerformanceInventory(manifest: ComparisonRecord | null): boolean {
  if (!manifest || typeof manifest !== 'object') {
    return false;
  }

  if (readNativePerformanceAttachments(manifest).length > 0) {
    return true;
  }

  const diagnostics = Array.isArray(manifest.artifacts?.diagnostics) ? manifest.artifacts?.diagnostics : [];
  return diagnostics.some((entry: unknown) => entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'nativePerformance');
}

function readRunIndexEntrySafely(runDir: string): { entry?: RunIndexEntry; error?: string } {
  try {
    return {
      entry: readRunIndexEntry(runDir),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isComparablePlatform(value: unknown): value is 'android' | 'ios' {
  return value === 'android' || value === 'ios';
}

function resolveRunScenarioId(artifacts: ComparisonRunArtifacts, fallback?: string): string {
  return String(artifacts.health.scenarioId ?? artifacts.verdict.scenarioId ?? fallback ?? 'unknown-scenario');
}

function resolveRunId(artifacts: ComparisonRunArtifacts, fallback?: string): string {
  return String(artifacts.health.runId ?? artifacts.verdict.runId ?? fallback ?? 'unknown-run');
}

function buildNativePerformanceReadinessExplanations({
  missingEvidence,
  phase,
}: {
  missingEvidence: string[];
  phase: 'baseline' | 'current';
}): Array<Record<string, unknown>> {
  const phaseLabel = phase === 'baseline' ? 'Baseline' : 'Current';
  return missingEvidence.map((gap) => {
    switch (gap) {
      case 'artifact-identity':
        return buildExplanation({
          code: 'untrusted-evidence',
          field: 'artifactPath',
          phase,
          reason: `${phaseLabel} native-performance evidence did not match the current run identity.`,
        });
      case 'bounded-capture-window':
        return buildExplanation({
          code: 'missing-evidence',
          field: 'lifecycle',
          phase,
          reason: `${phaseLabel} native-performance evidence did not prove a bounded capture window.`,
        });
      case 'captured-source':
        return buildExplanation({
          code: 'missing-evidence',
          field: 'diagnosticSources',
          phase,
          reason: `${phaseLabel} native-performance evidence did not preserve a durable captured source inside the run.`,
        });
      case 'capture-timestamp':
        return buildExplanation({
          code: 'missing-evidence',
          field: 'capturedAt',
          phase,
          reason: `${phaseLabel} native-performance evidence is missing a real capture timestamp.`,
        });
      case 'clock-domain':
        return buildExplanation({
          code: 'missing-evidence',
          field: 'clockDomain',
          phase,
          reason: `${phaseLabel} native-performance evidence is missing a capture clock domain.`,
        });
      case 'comparable-policy':
        return buildExplanation({
          code: 'policy-mismatch',
          field: 'comparability',
          phase,
          reason: `${phaseLabel} native-performance evidence did not prove a comparable-policy contract.`,
        });
      case 'comparison-claim':
        return buildExplanation({
          code: 'untrusted-evidence',
          field: 'claimSufficiency',
          phase,
          reason: `${phaseLabel} native-performance evidence did not prove a trusted comparison claim.`,
        });
      case 'complete-evidence':
        return buildExplanation({
          code: 'untrusted-evidence',
          field: 'completenessStatus',
          phase,
          reason: `${phaseLabel} native-performance evidence was not complete.`,
        });
      case 'measurable-samples':
        return buildExplanation({
          code: 'missing-evidence',
          field: 'frames',
          phase,
          reason: `${phaseLabel} native-performance evidence did not expose recognized measurable samples.`,
        });
      case 'observed-target-binding':
        return buildExplanation({
          code: 'untrusted-evidence',
          field: 'targetBinding',
          phase,
          reason: `${phaseLabel} native-performance evidence did not prove an observed target binding.`,
        });
      default:
        return buildExplanation({
          code: 'missing-evidence',
          field: gap,
          phase,
          reason: `${phaseLabel} native-performance evidence is missing required proof: ${gap}.`,
        });
    }
  });
}

function buildNativePerformanceTrustExplanations({
  baselineRunIndex,
  currentRunIndex,
}: {
  baselineRunIndex: { entry?: RunIndexEntry; error?: string };
  currentRunIndex: { entry?: RunIndexEntry; error?: string };
}): Array<Record<string, unknown>> {
  const explanations: Array<Record<string, unknown>> = [];
  for (const [phase, result] of [['baseline', baselineRunIndex], ['current', currentRunIndex]] as const) {
    const phaseLabel = phase === 'baseline' ? 'Baseline' : 'Current';
    if (result.error) {
      explanations.push(buildExplanation({
        code: 'untrusted-evidence',
        field: 'runIndex',
        phase,
        reason: `${phaseLabel} run could not be indexed for trust verification: ${result.error}`,
      }));
      continue;
    }
    if (!result.entry) {
      explanations.push(buildExplanation({
        code: 'untrusted-evidence',
        field: 'runIndex',
        phase,
        reason: `${phaseLabel} run did not expose index metadata for trust verification.`,
      }));
      continue;
    }
    if (!result.entry.trusted) {
      explanations.push(buildExplanation({
        code: 'untrusted-evidence',
        field: 'trusted',
        phase,
        reason: `${phaseLabel} run is not trusted for native-performance comparison (${result.entry.trustReason}).`,
      }));
    }
  }

  if (!baselineRunIndex.entry || !currentRunIndex.entry) {
    return explanations;
  }

  for (const field of [
    {
      name: 'scenarioId',
      baseline: baselineRunIndex.entry.scenarioId,
      current: currentRunIndex.entry.scenarioId,
      requireExplicit: true,
    },
    {
      name: 'scenarioHash',
      baseline: baselineRunIndex.entry.scenarioHash ?? null,
      current: currentRunIndex.entry.scenarioHash ?? null,
      requireExplicit: true,
    },
    {
      name: 'comparisonLane',
      baseline: baselineRunIndex.entry.comparisonLane ?? null,
      current: currentRunIndex.entry.comparisonLane ?? null,
      requireExplicit: true,
    },
    {
      name: 'cohortHash',
      baseline: baselineRunIndex.entry.cohortHash ?? null,
      current: currentRunIndex.entry.cohortHash ?? null,
      requireExplicit: true,
    },
  ] as const) {
    if (field.requireExplicit && (!field.baseline || !field.current)) {
      explanations.push(buildExplanation({
        code: 'incompatible-run',
        baseline: field.baseline,
        current: field.current,
        field: field.name,
        phase: 'pair',
        reason: `Trusted native-performance comparison requires an explicit ${field.name} on both baseline and current runs.`,
      }));
      continue;
    }
    if (field.baseline !== field.current) {
      explanations.push(buildExplanation({
        code: 'incompatible-run',
        baseline: field.baseline,
        current: field.current,
        field: field.name,
        phase: 'pair',
        reason: `Trusted native-performance comparison requires matching ${field.name} on baseline and current runs.`,
      }));
    }
  }

  return explanations;
}

function resolveNativePerformanceComparisonCandidate({
  artifacts,
  phase,
  runDir,
  runIndex,
}: {
  artifacts: ComparisonRunArtifacts;
  phase: 'baseline' | 'current';
  runDir: string;
  runIndex: { entry?: RunIndexEntry; error?: string };
}): {
  candidate?: {
    artifactPath: string;
    evidence: ComparisonRecord;
  };
  explanations: Array<Record<string, unknown>>;
} {
  const explanations: Array<Record<string, unknown>> = [];
  const phaseLabel = phase === 'baseline' ? 'Baseline' : 'Current';
  const nativeEvidence = artifacts.nativePerformance;

  if (nativeEvidence.attachmentCount === 0) {
    explanations.push(buildExplanation({
      code: 'missing-evidence',
      field: 'manifest.artifacts.evidenceAttachments',
      phase,
      reason: `${phaseLabel} run did not attach native-performance evidence for comparison.`,
    }));
    return { explanations };
  }

  if (nativeEvidence.attachmentCount > 1) {
    explanations.push(buildExplanation({
      code: 'ambiguous-evidence',
      baseline: nativeEvidence.attachmentCount,
      field: 'manifest.artifacts.evidenceAttachments',
      phase,
      reason: `${phaseLabel} run attached multiple native-performance artifacts; comparison requires exactly one.`,
    }));
    return { explanations };
  }

  if (!nativeEvidence.attachmentPath) {
    explanations.push(buildExplanation({
      code: 'missing-evidence',
      field: 'manifest.artifacts.evidenceAttachments',
      phase,
      reason: `${phaseLabel} run did not preserve a native-performance attachment path.`,
    }));
    return { explanations };
  }

  if (!nativeEvidence.providerId) {
    explanations.push(buildExplanation({
      code: 'untrusted-evidence',
      field: nativeEvidence.attachmentPath,
      phase,
      reason: `${phaseLabel} native-performance attachment path did not preserve runner-owned provider identity.`,
    }));
  }

  if (nativeEvidence.readError) {
    explanations.push(buildExplanation({
      code: 'missing-evidence',
      field: nativeEvidence.attachmentPath,
      phase,
      reason: `${phaseLabel} native-performance evidence could not be read: ${nativeEvidence.readError}`,
    }));
  }

  if (nativeEvidence.validationError) {
    explanations.push(buildExplanation({
      code: 'untrusted-evidence',
      field: nativeEvidence.attachmentPath,
      phase,
      reason: `${phaseLabel} native-performance evidence failed schema validation: ${nativeEvidence.validationError}`,
    }));
  }

  if (!nativeEvidence.value) {
    if (!nativeEvidence.readError && !nativeEvidence.validationError) {
      explanations.push(buildExplanation({
        code: 'missing-evidence',
        field: nativeEvidence.attachmentPath,
        phase,
        reason: `${phaseLabel} native-performance evidence did not yield a usable JSON artifact.`,
      }));
    }
    return { explanations };
  }

  const expectedPlatform = runIndex.entry?.platform;
  if (!isComparablePlatform(expectedPlatform)) {
    explanations.push(buildExplanation({
      code: 'untrusted-evidence',
      field: 'manifest.platform',
      phase,
      reason: `${phaseLabel} run did not record a supported platform for trusted native-performance comparison.`,
    }));
    return { explanations };
  }

  if (!nativeEvidence.providerId) {
    return { explanations };
  }

  const readiness = classifyNativePerformanceComparisonReadiness(nativeEvidence.value, {
    artifactPath: nativeEvidence.attachmentPath,
    evidencePathExists: (runRelativePath: string) => isContainedRunArtifactFile({
      runDir,
      runRelativePath,
    }),
    readEvidenceJson: (runRelativePath: string) => readContainedRunArtifactJson({
      runDir,
      runRelativePath,
    }),
    readEvidenceSha256: (runRelativePath: string) => readContainedRunArtifactSha256({
      runDir,
      runRelativePath,
    }),
    expectedPlatform,
    expectedProviderId: nativeEvidence.providerId,
    expectedRunId: resolveRunId(artifacts, runIndex.entry?.runId),
    expectedScenarioId: resolveRunScenarioId(artifacts, runIndex.entry?.scenarioId),
  });
  if (readiness.status !== 'comparison-ready') {
    explanations.push(...buildNativePerformanceReadinessExplanations({
      missingEvidence: readiness.missingEvidence,
      phase,
    }));
    return { explanations };
  }

  return {
    candidate: {
      artifactPath: nativeEvidence.attachmentPath,
      evidence: nativeEvidence.value,
    },
    explanations,
  };
}

function buildNativePerformanceComparison({
  baseline,
  baselineDir,
  baselineRunIndex,
  current,
  currentDir,
  currentRunIndex,
}: {
  baseline: ComparisonRunArtifacts;
  baselineDir: string;
  baselineRunIndex: { entry?: RunIndexEntry; error?: string };
  current: ComparisonRunArtifacts;
  currentDir: string;
  currentRunIndex: { entry?: RunIndexEntry; error?: string };
}): NativePerformanceComparisonSection | undefined {
  const hasNativeInventory = (
    baseline.nativePerformance.inventoried ||
    current.nativePerformance.inventoried ||
    baseline.nativePerformance.attachmentCount > 0 ||
    current.nativePerformance.attachmentCount > 0
  );
  if (!hasNativeInventory) {
    return undefined;
  }

  const trustExplanations = buildNativePerformanceTrustExplanations({
    baselineRunIndex,
    currentRunIndex,
  });
  const baselineCandidate = resolveNativePerformanceComparisonCandidate({
    artifacts: baseline,
    phase: 'baseline',
    runDir: baselineDir,
    runIndex: baselineRunIndex,
  });
  const currentCandidate = resolveNativePerformanceComparisonCandidate({
    artifacts: current,
    phase: 'current',
    runDir: currentDir,
    runIndex: currentRunIndex,
  });
  const explanations = [
    ...trustExplanations,
    ...baselineCandidate.explanations,
    ...currentCandidate.explanations,
  ];

  if (explanations.length > 0 || !baselineCandidate.candidate || !currentCandidate.candidate) {
    return buildNotComparableNativePerformanceComparison({
      explanations,
    });
  }

  return compareNativePerformanceEvidencePair({
    baselineEvidence: baselineCandidate.candidate.evidence,
    currentEvidence: currentCandidate.candidate.evidence,
  });
}

/**
 * Returns budget checks indexed by stable comparison key.
 *
 * @param {unknown} checks
 * @returns {Map<string, BudgetCheck>}
 */
function indexBudgetChecks(checks: unknown): Map<string, ComparisonBudgetCheck> {
  const indexed = new Map<string, ComparisonBudgetCheck>();
  if (!Array.isArray(checks)) {
    return indexed;
  }

  for (const check of checks) {
    if (!check || typeof check !== 'object') {
      continue;
    }

    const record = check as Partial<ComparisonBudgetCheck>;
    if (typeof record.name !== 'string' || typeof record.unit !== 'string') {
      continue;
    }

    indexed.set(`${record.name}\u0000${record.unit}`, record as ComparisonBudgetCheck);
  }

  return indexed;
}

/**
 * Returns the absolute delta that should still be treated as timing noise.
 *
 * @param {ComparisonBudgetCheck} baseline
 * @param {ComparisonBudgetCheck} current
 * @returns {number}
 */
function comparisonTolerance(baseline: ComparisonBudgetCheck, current: ComparisonBudgetCheck): number {
  if (baseline.unit !== 'ms' || current.unit !== 'ms') {
    return 0;
  }

  if (typeof baseline.actual !== 'number' || typeof current.actual !== 'number') {
    return 0;
  }

  const reference = Math.max(Math.abs(baseline.actual), Math.abs(current.actual));
  return Math.max(MIN_MS_COMPARISON_TOLERANCE, reference * RELATIVE_MS_COMPARISON_TOLERANCE);
}

/**
 * Compares one budget check when both runs expose a compatible actual value.
 *
 * @param {BudgetCheck} baseline
 * @param {BudgetCheck} current
 * @returns {MetricComparison}
 */
function compareBudgetCheck(baseline: ComparisonBudgetCheck, current: ComparisonBudgetCheck): MetricComparison {
  if (typeof baseline.actual !== 'number' || typeof current.actual !== 'number') {
    return {
      name: current.name,
      unit: current.unit,
      baseline: baseline.actual ?? null,
      current: current.actual ?? null,
      delta: null,
      status: baseline.actual === current.actual ? 'unchanged' : 'inconclusive',
      notes: 'Only numeric budget actuals are compared by direction.',
    };
  }

  const delta = current.actual - baseline.actual;
  const tolerance = comparisonTolerance(baseline, current);
  const crossedBudgetBoundary = baseline.pass !== current.pass;
  const withinTolerance = Math.abs(delta) <= tolerance;
  let status: MetricComparison['status'];
  if (crossedBudgetBoundary) {
    status = current.pass ? 'better' : 'worse';
  } else if (withinTolerance) {
    status = 'unchanged';
  } else {
    status = delta < 0 ? 'better' : 'worse';
  }

  return {
    name: current.name,
    unit: current.unit,
    baseline: baseline.actual,
    current: current.actual,
    delta,
    status,
    ...(status === 'unchanged' && delta !== 0 && tolerance > 0 && withinTolerance
      ? { notes: `Delta within ${tolerance}ms timing tolerance.` }
      : {}),
  };
}

/**
 * Returns whether a directional timing delta should be reported as low confidence.
 *
 * @param {MetricComparison} metric
 * @param {ComparisonBudgetCheck} baseline
 * @param {ComparisonBudgetCheck} current
 * @returns {boolean}
 */
function isLowConfidenceTimingMovement(
  metric: MetricComparison,
  baseline: ComparisonBudgetCheck,
  current: ComparisonBudgetCheck,
): boolean {
  return (
    metric.status === 'worse' &&
    baseline.unit === 'ms' &&
    current.unit === 'ms' &&
    baseline.pass === true &&
    current.pass === true
  );
}

/**
 * Collapses metric-level comparison statuses into the run-level comparison status.
 *
 * @param {MetricComparison[]} metricComparisons
 * @param {{baselineVerdictStatus?: unknown, currentVerdictStatus?: unknown}} verdicts
 * @returns {ComparisonStatus}
 */
function resolveComparisonStatus(
  metricComparisons: MetricComparison[],
  {
    baselineVerdictStatus,
    currentVerdictStatus,
  }: {
    baselineVerdictStatus?: unknown;
    currentVerdictStatus?: unknown;
  },
): ComparisonStatus {
  const hasBetterMetric = metricComparisons.some((metric) => metric.status === 'better');
  const hasWorseMetric = metricComparisons.some((metric) => metric.status === 'worse');
  const hasLowConfidenceMetric = metricComparisons.some((metric) => metric.status === 'low_confidence');

  if (hasBetterMetric && hasWorseMetric) {
    return 'mixed';
  }

  if (hasWorseMetric) {
    return 'worse';
  }

  if (hasBetterMetric) {
    return 'better';
  }

  if (hasLowConfidenceMetric) {
    return 'low_confidence';
  }

  if (metricComparisons.length > 0 && metricComparisons.every((metric) => metric.status === 'unchanged')) {
    return 'unchanged';
  }

  if (baselineVerdictStatus === 'failed' && currentVerdictStatus === 'passed') {
    return 'better';
  }

  if (baselineVerdictStatus === 'passed' && currentVerdictStatus === 'failed') {
    return 'worse';
  }

  return 'inconclusive';
}

function summarizeNativePerformanceComparison(
  nativeComparison: NativePerformanceComparisonSection | undefined,
): string | null {
  if (!nativeComparison) {
    return null;
  }

  switch (nativeComparison.status) {
    case 'improved':
      return 'Native performance improved under the trusted same-condition policy.';
    case 'regressed':
      return 'Native performance regressed under the trusted same-condition policy.';
    case 'mixed':
      return 'Native performance shows mixed movement under the trusted same-condition policy.';
    case 'unchanged':
      return 'Native performance matched the trusted same-condition baseline.';
    case 'not-comparable':
      return 'Native performance was not comparable under the trusted same-condition policy.';
    default:
      return null;
  }
}

function resolveComparisonRegressionSource(
  comparison: ComparisonRecord,
): 'both' | 'native-performance' | 'ordinary' | null {
  const ordinaryRegressed = comparison.comparisonStatus === 'worse';
  const nativeRegressed = isNativePerformanceRegressed(
    comparison.nativePerformance as NativePerformanceComparisonSection | undefined,
  );
  if (ordinaryRegressed && nativeRegressed) {
    return 'both';
  }
  if (ordinaryRegressed) {
    return 'ordinary';
  }
  if (nativeRegressed) {
    return 'native-performance';
  }
  return null;
}

function resolveEffectiveComparisonStatus(comparison: ComparisonRecord): ComparisonStatus {
  return resolveComparisonRegressionSource(comparison) ? 'worse' : comparison.comparisonStatus as ComparisonStatus;
}

/**
 * Builds the provenance block that explains which runs a comparison used.
 *
 * @param {{baselineDir: string, currentDir: string, baselineHealth: ComparisonRecord, baselineVerdict: ComparisonRecord, currentHealth: ComparisonRecord, currentVerdict: ComparisonRecord, selection?: ComparisonSelectionBasis, strategy: ComparisonBasisStrategy}} options
 * @returns {ComparisonBasis}
 */
function buildComparisonBasis({
  baselineDir,
  currentDir,
  baselineHealth,
  baselineVerdict,
  currentHealth,
  currentVerdict,
  selection,
  strategy,
}: {
  baselineDir: string;
  currentDir: string;
  baselineHealth: ComparisonRecord;
  baselineVerdict: ComparisonRecord;
  currentHealth: ComparisonRecord;
  currentVerdict: ComparisonRecord;
  selection?: ComparisonSelectionBasis;
  strategy: ComparisonBasisStrategy;
}): ComparisonBasis {
  const baselineRunId = String(baselineHealth.runId ?? baselineVerdict.runId ?? 'unknown-baseline');
  const currentRunId = String(currentHealth.runId ?? currentVerdict.runId ?? 'unknown-current');

  return {
    strategy,
    baseline: {
      runId: baselineRunId,
      runDir: baselineDir,
      ...(typeof baselineHealth.healthStatus === 'string' ? { healthStatus: baselineHealth.healthStatus } : {}),
      ...(typeof baselineVerdict.verdictStatus === 'string' ? { verdictStatus: baselineVerdict.verdictStatus } : {}),
    },
    current: {
      runId: currentRunId,
      runDir: currentDir,
      ...(typeof currentHealth.healthStatus === 'string' ? { healthStatus: currentHealth.healthStatus } : {}),
      ...(typeof currentVerdict.verdictStatus === 'string' ? { verdictStatus: currentVerdict.verdictStatus } : {}),
    },
    ...(selection ? { selection } : {}),
  };
}

/**
 * Counts valid numeric or boolean budget samples in a verdict artifact.
 *
 * @param {unknown} checks
 * @returns {number}
 */
function countValidBudgetSamples(checks: unknown): number {
  if (!Array.isArray(checks)) {
    return 0;
  }

  return checks.filter((check) => (
    check &&
    typeof check === 'object' &&
    (
      typeof (check as {actual?: unknown}).actual === 'number' ||
      typeof (check as {actual?: unknown}).actual === 'boolean'
    )
  )).length;
}

function resolveMeasurementConfidenceLevel({
  hasLowConfidenceMovement,
  validSamples,
}: {
  hasLowConfidenceMovement: boolean;
  validSamples: number;
}): MeasurementPolicy['confidence']['level'] {
  if (hasLowConfidenceMovement) {
    return 'low_confidence';
  }

  if (validSamples === 0) {
    return 'insufficient';
  }

  if (validSamples === 1) {
    return 'single_run';
  }

  return 'multi_sample';
}

/**
 * Builds the measurement policy block for a comparison artifact.
 *
 * @param {{baselineVerdict: Record<string, unknown>, comparisonBasis?: ComparisonBasis, currentVerdict: Record<string, unknown>, metricComparisons: MetricComparison[]}} options
 * @returns {MeasurementPolicy}
 */
function buildMeasurementPolicy({
  baselineVerdict,
  comparisonBasis,
  currentVerdict,
  metricComparisons,
}: {
  baselineVerdict: ComparisonRecord;
  comparisonBasis: ComparisonBasis | undefined;
  currentVerdict: ComparisonRecord;
  metricComparisons: MetricComparison[];
}): MeasurementPolicy {
  const selection = comparisonBasis?.selection;
  const validSamples = metricComparisons.length;
  const hasLowConfidenceMovement = metricComparisons.some((metric) => metric.status === 'low_confidence');
  const confidenceLevel = resolveMeasurementConfidenceLevel({
    hasLowConfidenceMovement,
    validSamples,
  });
  const poisoningProtection = {
    requirePassedHealth: true,
    requirePassedVerdict: comparisonBasis?.strategy === 'latest_trusted_prior',
    requireMatchingScenarioId: true,
    ...(typeof selection?.comparisonLane === 'string' ? { comparisonLane: selection.comparisonLane } : {}),
    ...(typeof selection?.scenarioHash === 'string' ? { scenarioHash: selection.scenarioHash } : {}),
    ...(typeof selection?.cohortHash === 'string' ? { cohortHash: selection.cohortHash } : {}),
  };

  return {
    baselineSelection: {
      mode: comparisonBasis?.strategy === 'latest_trusted_prior' ? 'latestTrustedPrior' : 'explicit',
      poisoningProtection,
    },
    samples: {
      baseline: {
        validSamples: countValidBudgetSamples(baselineVerdict.budgetChecks),
        warmupSamples: 0,
        outliersExcluded: 0,
      },
      current: {
        validSamples: countValidBudgetSamples(currentVerdict.budgetChecks),
        warmupSamples: 0,
        outliersExcluded: 0,
      },
    },
    tolerance: {
      timing: {
        absoluteMs: MIN_MS_COMPARISON_TOLERANCE,
        relative: RELATIVE_MS_COMPARISON_TOLERANCE,
      },
    },
    confidence: {
      level: confidenceLevel,
      minValidSamples: 1,
      ...(hasLowConfidenceMovement
        ? { reason: 'Single-run timing movement stayed within passing budgets; repeat or multi-sample proof is required before treating it as a regression.' }
        : {}),
    },
  };
}

function resolveComparisonFlowIdentity({
  currentHealth,
  currentVerdict,
}: {
  currentHealth: ComparisonRecord;
  currentVerdict: ComparisonRecord;
}): { flowId?: string } {
  if (typeof currentHealth.flowId === 'string') {
    return { flowId: currentHealth.flowId };
  }

  if (typeof currentVerdict.flowId === 'string') {
    return { flowId: currentVerdict.flowId };
  }

  return {};
}

/**
 * Builds a comparison artifact from two validated run artifact sets.
 *
 * @param {BuildComparisonOptions} options
 * @returns {Record<string, unknown>}
 */
function buildComparisonArtifact({
  baselineHealth,
  baselineVerdict,
  comparisonBasis,
  currentHealth,
  currentVerdict,
  nativeComparison,
}: BuildComparisonOptions): ComparisonRecord {
  const missingRequired: string[] = [];
  const warnings: string[] = [];
  const baselineScenarioId = String(baselineHealth.scenarioId ?? baselineVerdict.scenarioId ?? 'unknown-scenario');
  const currentScenarioId = String(currentHealth.scenarioId ?? currentVerdict.scenarioId ?? baselineScenarioId);
  const baselineRunId = String(baselineHealth.runId ?? baselineVerdict.runId ?? 'unknown-baseline');
  const currentRunId = String(currentHealth.runId ?? currentVerdict.runId ?? 'unknown-current');

  if (baselineHealth.healthStatus !== 'passed') {
    missingRequired.push('baseline health passed');
  }

  if (currentHealth.healthStatus !== 'passed') {
    missingRequired.push('current health passed');
  }

  if (baselineScenarioId !== currentScenarioId) {
    missingRequired.push('matching scenario id');
  }

  const canCompare = missingRequired.length === 0;
  const metricComparisons: MetricComparison[] = [];

  if (canCompare) {
    const baselineChecks = indexBudgetChecks(baselineVerdict.budgetChecks);
    const currentChecks = indexBudgetChecks(currentVerdict.budgetChecks);
    for (const [key, currentCheck] of currentChecks.entries()) {
      const baselineCheck = baselineChecks.get(key);
      if (!baselineCheck) {
        warnings.push(`No baseline budget check matched ${currentCheck.name}.`);
        continue;
      }
      const metricComparison = compareBudgetCheck(baselineCheck, currentCheck);
      if (
        comparisonBasis?.strategy === 'latest_trusted_prior' &&
        isLowConfidenceTimingMovement(metricComparison, baselineCheck, currentCheck)
      ) {
        metricComparisons.push({
          ...metricComparison,
          status: 'low_confidence',
          notes: 'Single-run timing movement stayed within passing budgets; repeat or multi-sample proof is required before treating it as a regression.',
        });
        continue;
      }
      metricComparisons.push(metricComparison);
    }

    if (metricComparisons.length === 0) {
      warnings.push('No comparable budget checks were available.');
    }
  }

  const comparisonStatus = canCompare
    ? resolveComparisonStatus(metricComparisons, {
        baselineVerdictStatus: baselineVerdict.verdictStatus,
        currentVerdictStatus: currentVerdict.verdictStatus,
      })
    : 'inconclusive';
  const nativeSummary = summarizeNativePerformanceComparison(nativeComparison);
  const comparison = {
    schemaVersion: '1.1.0',
    scenarioId: currentScenarioId,
    ...resolveComparisonFlowIdentity({ currentHealth, currentVerdict }),
    runId: currentRunId,
    baselineRunId,
    comparisonStatus,
    healthStatus: canCompare ? 'passed' : 'failed',
    verdictStatus: typeof currentVerdict.verdictStatus === 'string' ? currentVerdict.verdictStatus : 'inconclusive',
    ...(comparisonBasis ? { comparisonBasis } : {}),
    measurementPolicy: buildMeasurementPolicy({
      baselineVerdict,
      comparisonBasis,
      currentVerdict,
      metricComparisons,
    }),
    ...(metricComparisons.length > 0 ? { metricComparisons } : {}),
    ...(nativeComparison ? { nativePerformance: nativeComparison } : {}),
    evidence: {
      missingRequired,
      warnings,
    },
    summary: summarizeComparison({
      comparisonStatus,
      missingRequired,
      metricComparisons,
      nativeSummary,
      warnings,
    }),
  };

  return assertValidJson(comparison, SCHEMAS.comparison, 'Comparison artifact') as ComparisonRecord;
}

/**
 * Reads two run directories and builds a validated comparison artifact.
 *
 * @param {CompareRunDirectoriesOptions} options
 * @returns {Record<string, unknown>}
 */
function compareRunDirectories({
  baselineDir,
  currentDir,
  selection,
  strategy = 'explicit',
}: CompareRunDirectoriesOptions): ComparisonRecord {
  const baseline = readRunArtifacts(baselineDir);
  const current = readRunArtifacts(currentDir);
  const baselineRunIndex = readRunIndexEntrySafely(baselineDir);
  const currentRunIndex = readRunIndexEntrySafely(currentDir);
  const nativeComparison = buildNativePerformanceComparison({
    baseline,
    baselineDir,
    baselineRunIndex,
    current,
    currentDir,
    currentRunIndex,
  });

  return buildComparisonArtifact({
    baselineHealth: baseline.health,
    baselineManifest: baseline.manifest,
    baselineVerdict: baseline.verdict,
    comparisonBasis: buildComparisonBasis({
      baselineDir,
      currentDir,
      baselineHealth: baseline.health,
      baselineVerdict: baseline.verdict,
      currentHealth: current.health,
      currentVerdict: current.verdict,
      ...(selection ? { selection } : {}),
      strategy,
    }),
    currentHealth: current.health,
    currentManifest: current.manifest,
    currentVerdict: current.verdict,
    ...(nativeComparison ? { nativeComparison } : {}),
  });
}

/**
 * Builds the human-readable comparison summary.
 *
 * @param {{comparisonStatus: string, missingRequired: string[], metricComparisons: MetricComparison[], warnings: string[]}} options
 * @returns {string}
 */
function summarizeComparison({
  comparisonStatus,
  missingRequired,
  metricComparisons,
  nativeSummary,
  warnings,
}: {
  comparisonStatus: string;
  missingRequired: string[];
  metricComparisons: MetricComparison[];
  nativeSummary?: string | null;
  warnings: string[];
}): string {
  let summary: string;
  if (missingRequired.length > 0) {
    summary = `Comparison is inconclusive because required evidence is missing: ${missingRequired.join(', ')}.`;
  } else if (metricComparisons.length === 0) {
    summary = warnings.length > 0
      ? `Comparison is inconclusive: ${warnings.join(' ')}`
      : 'Comparison is inconclusive because there were no comparable metrics.';
  } else if (comparisonStatus === 'better') {
    summary = 'Current run improved against the explicit baseline.';
  } else if (comparisonStatus === 'worse') {
    summary = 'Current run regressed against the explicit baseline.';
  } else if (comparisonStatus === 'mixed') {
    summary = 'Current run has mixed metric movement against the explicit baseline.';
  } else if (comparisonStatus === 'low_confidence') {
    summary = 'Current run has low-confidence timing movement against the baseline; repeat or multi-sample proof is required before treating it as a regression.';
  } else if (comparisonStatus === 'unchanged') {
    summary = 'Current run matched the explicit baseline.';
  } else {
    summary = 'Comparison is inconclusive.';
  }

  return nativeSummary ? `${summary} ${nativeSummary}` : summary;
}

export {
  buildComparisonBasis,
  buildComparisonArtifact,
  compareBudgetCheck,
  compareRunDirectories,
  buildMeasurementPolicy,
  indexBudgetChecks,
  readRunArtifacts,
  resolveComparisonRegressionSource,
  resolveEffectiveComparisonStatus,
  resolveComparisonStatus,
  summarizeComparison,
};

export type {
  BuildComparisonOptions,
  ComparisonBasis,
  ComparisonBasisStrategy,
  CompareRunDirectoriesOptions,
  ComparisonBudgetCheck,
  ComparisonRecord,
  ComparisonStatus,
  MeasurementPolicy,
  MetricComparison,
};
