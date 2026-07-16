#!/usr/bin/env node

const path = require('node:path');

const { buildAgentSummaryMarkdown } = require('../core/agent-summary');
const {
  compareRunDirectories,
  readRunArtifacts,
  resolveComparisonRegressionSource,
} = require('../core/comparison');
const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  baseline?: string | boolean;
  current?: string | boolean;
  'fail-on-regression'?: string | boolean;
  out?: string | boolean;
  [key: string]: string | boolean | undefined;
};

/**
 * Prints CLI usage to stderr.
 *
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-compare --baseline <run-dir> --current <run-dir> [--out <comparison.json|run-dir>] [--fail-on-regression]',
    '',
    'Without --out, prints comparison.json to stdout.',
    'When --out points at a directory, writes comparison.json and agent-summary.md there.',
    'Use --fail-on-regression to exit nonzero after writing evidence when ordinary or trusted native-performance comparison regresses.',
  ], output);
}

/**
 * Parses `--key value` arguments for the comparison CLI.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
}

/**
 * Resolves `--out` as either an explicit JSON file or a run directory.
 *
 * @param {string} out
 * @returns {{comparisonPath: string, summaryPath: string | null, printedPath: string}}
 */
function resolveOutput(out: string): { comparisonPath: string; summaryPath: string | null; printedPath: string } {
  const resolved = path.resolve(out);
  if (path.extname(resolved) === '.json') {
    return {
      comparisonPath: resolved,
      summaryPath: null,
      printedPath: resolved,
    };
  }

  const layout = createArtifactLayout({ outputDir: resolved });
  return {
    comparisonPath: layout.comparison,
    summaryPath: layout.agentSummary,
    printedPath: resolved,
  };
}

/**
 * Returns whether a boolean CLI flag was provided.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

function describeRegressionSource(
  regressionSource: ReturnType<typeof resolveComparisonRegressionSource>,
): string {
  switch (regressionSource) {
    case 'ordinary':
      return 'ordinary comparison';
    case 'native-performance':
      return 'native-performance comparison';
    case 'both':
      return 'ordinary and native-performance comparison';
    default:
      return 'comparison';
  }
}

/**
 * Throws when a comparison result should fail a strict regression gate.
 *
 * @param {{comparison: Record<string, unknown>, evidencePath?: string}} options
 * @returns {void}
 */
function assertNoRegressedComparison({
  comparison,
  evidencePath,
}: {
  comparison: Record<string, unknown>;
  evidencePath?: string;
}): void {
  const regressionSource = resolveComparisonRegressionSource(comparison);
  if (!regressionSource) {
    return;
  }

  const runId = typeof comparison.runId === 'string' ? comparison.runId : 'current run';
  const evidenceHint = evidencePath ? ` Inspect ${evidencePath}.` : '';
  const sourceDetail = describeRegressionSource(regressionSource);
  throw new Error(`Comparison regressed for ${runId} via ${sourceDetail}.${evidenceHint}`);
}

/**
 * Runs the compare CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  const args = parseArgs(argv);
  if (typeof args.baseline !== 'string' || typeof args.current !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  const baselineDir = path.resolve(args.baseline);
  const currentDir = path.resolve(args.current);
  const comparison = compareRunDirectories({ baselineDir, currentDir });
  const failOnRegression = isEnabledFlag(args['fail-on-regression']);

  if (typeof args.out === 'string' && args.out.length > 0) {
    const { comparisonPath, summaryPath, printedPath } = resolveOutput(args.out);
    await writeJsonArtifact({
      filePath: comparisonPath,
      value: comparison,
      schema: SCHEMAS.comparison,
      label: 'Comparison artifact',
    });

    if (summaryPath) {
      const current = readRunArtifacts(currentDir);
      await writeTextArtifact({
        filePath: summaryPath,
        content: buildAgentSummaryMarkdown({
          health: current.health,
          verdict: current.verdict,
          comparison,
        }),
      });
    }

    process.stdout.write(`${printedPath}\n`);
    if (failOnRegression) {
      assertNoRegressedComparison({ comparison, evidencePath: printedPath });
    }
    return;
  }

  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  if (failOnRegression) {
    assertNoRegressedComparison({ comparison });
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertNoRegressedComparison,
  isEnabledFlag,
  main,
  parseArgs,
  resolveOutput,
  usage,
};
