#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parses simple `--key value` CLI arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) {
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
 * Reads a required string CLI argument.
 *
 * @param {Record<string, string | boolean>} args
 * @param {string} key
 * @returns {string}
 */
function requireStringArg(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required --${key} value.`);
  }
  return value;
}

/**
 * Writes deterministic profiler evidence for the example-app provider command.
 *
 * @param {{outPath: string, platform: string, runId: string, scenarioId: string}} options
 * @returns {void}
 */
function writeProfilerEvidence({
  outPath,
  platform,
  runId,
  scenarioId,
}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    `${JSON.stringify({
      schemaVersion: '1.0.0',
      providerId: 'example-mobile-app-profiler-provider',
      platform,
      scenarioId,
      runId,
      samples: [],
      summary: 'Deterministic example profiler evidence for package and consumer rehearsal.',
    }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Runs the provider script.
 *
 * @returns {void}
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  writeProfilerEvidence({
    outPath: requireStringArg(args, 'out'),
    platform: requireStringArg(args, 'platform'),
    runId: requireStringArg(args, 'run-id'),
    scenarioId: requireStringArg(args, 'scenario'),
  });
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
