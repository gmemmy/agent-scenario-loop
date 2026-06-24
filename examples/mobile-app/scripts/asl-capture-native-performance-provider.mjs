#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildAndroidNativePerformanceEvidence, buildIosNativePerformanceEvidence } = require('../../..');
const PROVIDER_ID = 'example-mobile-app-evidence-provider';

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
 * Writes a provider-local text artifact.
 *
 * @param {string} outPath
 * @param {string} fileName
 * @param {string} content
 * @returns {{path: string, sizeBytes: number}}
 */
function writeProviderTextAttachment(outPath, fileName, content) {
  const providerDir = path.dirname(outPath);
  const artifactPath = path.join(providerDir, fileName);
  fs.mkdirSync(providerDir, { recursive: true });
  fs.writeFileSync(artifactPath, content, 'utf8');
  return {
    path: `raw/providers/${PROVIDER_ID}/${fileName}`,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

/**
 * Builds deterministic Android native diagnostic text for package rehearsal.
 *
 * @returns {{gfxinfoText: string, meminfoText: string}}
 */
function buildAndroidFixtureText() {
  return {
    gfxinfoText: [
      'Total frames rendered: 120',
      'Janky frames: 6 (5.00%)',
      'p50: 12ms',
      'p90: 21ms',
      'p95: 29ms',
      'p99: 48ms',
      'Slow UI thread: 2',
      'Slow bitmap uploads: 1',
      'Slow issue draw commands: 3',
      'Frame deadline missed: 6',
      '',
    ].join('\n'),
    meminfoText: [
      'TOTAL PSS: 180000 KB',
      'Native Heap PSS: 64000 KB',
      'Native Heap Alloc: 71000 KB',
      'Views: 42',
      'Activities: 1',
      'WebViews: 0',
      '',
    ].join('\n'),
  };
}

/**
 * Builds deterministic iOS scaffold evidence for package rehearsal.
 *
 * @param {{runId: string, scenarioId: string}} options
 * @returns {Record<string, unknown>}
 */
function buildIosScaffoldEvidence({ runId, scenarioId }) {
  // Intentionally pass no summaries: list source lanes, but keep top-level dataClasses unknown until real counters exist.
  return buildIosNativePerformanceEvidence({
    capturedAt: new Date(0).toISOString(),
    providerId: PROVIDER_ID,
    scenarioId,
    runId,
  });
}

/**
 * Writes deterministic native-performance evidence for the example-app provider command.
 *
 * @param {{outPath: string, platform: string, runId: string, scenarioId: string}} options
 * @returns {void}
 */
function writeNativePerformanceEvidence({
  outPath,
  platform,
  runId,
  scenarioId,
}) {
  if (platform === 'android') {
    const { gfxinfoText, meminfoText } = buildAndroidFixtureText();
    const gfxinfoAttachment = writeProviderTextAttachment(outPath, 'native-performance-gfxinfo.txt', gfxinfoText);
    const meminfoAttachment = writeProviderTextAttachment(outPath, 'native-performance-meminfo.txt', meminfoText);
    writeJsonArtifact(outPath, buildAndroidNativePerformanceEvidence({
      appId: 'dev.agentscenarioloop.example',
      attachments: [
        {
          kind: 'raw-gfxinfo',
          ...gfxinfoAttachment,
        },
        {
          kind: 'raw-meminfo',
          ...meminfoAttachment,
        },
      ],
      capturedAt: new Date(0).toISOString(),
      deviceId: 'example-device',
      gfxinfoText,
      meminfoText,
      providerId: PROVIDER_ID,
      runId,
      scenarioId,
    }));
    return;
  }

  writeJsonArtifact(outPath, buildIosScaffoldEvidence({ runId, scenarioId }));
}

/**
 * Runs the provider script.
 *
 * @returns {void}
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  writeNativePerformanceEvidence({
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
