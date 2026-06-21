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
 * Writes a formatted JSON artifact.
 *
 * @param {string} outPath
 * @param {Record<string, unknown>} payload
 * @returns {void}
 */
function writeJsonArtifact(outPath, payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Writes deterministic evidence for a scaffolded provider command.
 *
 * @param {{memoryOutPath: string, networkOutPath: string, outPath: string, platform: string, runId: string, scenarioId: string}} options
 * @returns {void}
 */
function writeProviderEvidence({
  memoryOutPath,
  networkOutPath,
  outPath,
  platform,
  runId,
  scenarioId,
}) {
  const shared = {
    platform,
    providerId: 'example-evidence-provider',
    runId,
    scenarioId,
    schemaVersion: '1.0.0',
  };

  writeJsonArtifact(outPath, {
    ...shared,
    captureMode: 'afterCapture',
    completenessStatus: 'partial',
    comparability: {
      status: 'diagnostic-only',
      reason: 'Scaffold evidence is collected after the profile window and is not comparable timing data.',
    },
    dataClasses: ['unknown'],
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    profileKind: 'diagnostic-summary',
    targetBinding: {
      status: 'unverified',
      reason: 'Replace this scaffold provider with a project-local profiler that verifies its target device and app.',
    },
    tool: {
      name: 'agent-scenario-loop scaffold profiler',
      version: '1.0.0',
    },
    samples: [],
    summary: 'Replace this scaffold provider with a project-local profiler command when real profiler data is available.',
  });
  writeJsonArtifact(memoryOutPath, {
    ...shared,
    jsHeapBytes: null,
    nativeHeapBytes: null,
    summary: 'Replace this scaffold memory signal with device or runtime memory evidence.',
  });
  writeJsonArtifact(networkOutPath, {
    log: {
      creator: {
        name: 'agent-scenario-loop scaffold provider',
        version: '1.0.0',
      },
      entries: [],
      version: '1.2',
    },
    ...shared,
  });
}

/**
 * Runs the provider script.
 *
 * @returns {void}
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  writeProviderEvidence({
    memoryOutPath: requireStringArg(args, 'memory-out'),
    networkOutPath: requireStringArg(args, 'network-out'),
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
