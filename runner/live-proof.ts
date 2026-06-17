#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { SCHEMAS, assertValidJson } = require('../core/schema-validator');
const { hasHelpFlag, writeUsage } = require('./cli');

type CliArgs = {
  file?: string | boolean;
  'fail-on-regression'?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type LiveProofArtifact = {
  comparisonStatus: string;
  comparisons: unknown[];
  nextAction: {
    code: string;
    summary: string;
  };
  platform: string;
  profiles: Array<{
    healthStatus: string;
    label: string;
    runId: string;
    scenarioId: string;
    verdictStatus: string;
  }>;
  runId: string;
  status: string;
  summary: string;
};

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} [output]
 * @returns {void}
 */
function usage(output: { write: (message: string) => unknown } = process.stderr): void {
  writeUsage([
    'Usage: asl-live-proof --file <live-proof.json> [--fail-on-regression]',
    '',
    'Validates an aggregate live-proof artifact and prints its status and next action.',
    'Use --fail-on-regression to exit nonzero when comparisonStatus is regressed.',
  ], output);
}

/**
 * Parses a small flag set for the live-proof CLI.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

/**
 * Reads and validates a live-proof artifact.
 *
 * @param {string} filePath
 * @returns {LiveProofArtifact}
 */
function readLiveProof(filePath: string): LiveProofArtifact {
  const proof = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return assertValidJson(proof, SCHEMAS.liveProof, 'Live proof artifact') as LiveProofArtifact;
}

/**
 * Formats a live-proof artifact for CLI output.
 *
 * @param {LiveProofArtifact} proof
 * @returns {string}
 */
function formatLiveProof(proof: LiveProofArtifact): string {
  return [
    `Live proof: ${proof.platform} ${proof.runId}`,
    `Status: ${proof.status}`,
    `Comparison status: ${proof.comparisonStatus}`,
    `Profiles: ${proof.profiles.length}`,
    ...proof.profiles.map((profile) => (
      `- ${profile.label} (${profile.scenarioId}/${profile.runId}): health=${profile.healthStatus} verdict=${profile.verdictStatus}`
    )),
    `Comparisons: ${proof.comparisons.length}`,
    `Next action: ${proof.nextAction.code} - ${proof.nextAction.summary}`,
    `Summary: ${proof.summary}`,
  ].join('\n');
}

/**
 * Returns whether the caller requested a regression gate and the proof regressed.
 *
 * @param {{failOnRegression: boolean, proof: LiveProofArtifact}} options
 * @returns {boolean}
 */
function shouldFailOnRegression({
  failOnRegression,
  proof,
}: {
  failOnRegression: boolean;
  proof: LiveProofArtifact;
}): boolean {
  return failOnRegression && proof.comparisonStatus === 'regressed';
}

/**
 * Runs the live-proof inspection CLI.
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
  if (typeof args.file !== 'string') {
    usage();
    process.exitCode = 1;
    return;
  }

  const proof = readLiveProof(args.file);
  process.stdout.write(`${formatLiveProof(proof)}\n`);
  if (shouldFailOnRegression({
    failOnRegression: args['fail-on-regression'] === true || args['fail-on-regression'] === 'true',
    proof,
  })) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  formatLiveProof,
  main,
  parseArgs,
  readLiveProof,
  shouldFailOnRegression,
  usage,
};

export type {
  CliArgs,
  LiveProofArtifact,
};
