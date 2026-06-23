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
 * Builds platform-specific scaffold guidance for native-performance evidence.
 *
 * @param {string} platform
 * @returns {{dataClasses: string[], evidenceKind: string, frames: Record<string, unknown>, memory: Record<string, unknown>, missingEvidence: string[], summary: string}}
 */
function buildNativePerformanceScaffold(platform) {
  switch (platform) {
    case 'android':
      return {
        evidenceKind: 'mixed',
        dataClasses: ['frames', 'jank', 'render', 'memory', 'native-trace'],
        frames: {
          gfxinfoFrameStatsCaptured: false,
          perfettoTraceCaptured: false,
          traceProcessorSummaryCaptured: false,
        },
        memory: {
          meminfoCaptured: false,
        },
        missingEvidence: [
          'Perfetto or trace-processor summary',
          'gfxinfo or framestats summary',
          'meminfo summary',
          'target-bound Android package/device identity',
        ],
        summary: 'Replace this scaffold with Android Perfetto, trace-processor, gfxinfo/framestats, meminfo, or logcat-derived render output.',
      };
    case 'ios':
      return {
        evidenceKind: 'mixed',
        dataClasses: ['frames', 'jank', 'render', 'memory', 'native-trace'],
        frames: {
          instrumentsTraceCaptured: false,
          metricKitPayloadCaptured: false,
          xctraceSummaryCaptured: false,
        },
        memory: {
          instrumentsMemoryCaptured: false,
        },
        missingEvidence: [
          'Instruments or xctrace summary',
          'MetricKit payload where available',
          'simctl or OS log native-performance summary',
          'target-bound iOS bundle/simulator/device identity',
        ],
        summary: 'Replace this scaffold with iOS Instruments/xctrace, MetricKit, simctl log, or OS native-performance output.',
      };
    default:
      return {
        evidenceKind: 'unknown',
        dataClasses: ['unknown'],
        frames: {
          platformFrameSummaryCaptured: false,
        },
        memory: {
          platformMemorySummaryCaptured: false,
        },
        missingEvidence: [
          'platform-native frame summary',
          'platform-native memory summary',
          'target-bound app/device identity',
        ],
        summary: 'Replace this scaffold with platform-native frame, render, memory, or trace output.',
      };
  }
}

/**
 * Writes deterministic native-performance evidence for a scaffolded provider command.
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
  const scaffold = buildNativePerformanceScaffold(platform);
  writeJsonArtifact(outPath, {
    schemaVersion: '1.0.0',
    providerId: 'example-evidence-provider',
    platform,
    runId,
    scenarioId,
    tool: {
      name: 'agent-scenario-loop scaffold native performance provider',
      version: '1.0.0',
    },
    capturedAt: new Date(0).toISOString(),
    captureMode: 'afterCapture',
    clockDomain: 'host',
    completenessStatus: 'partial',
    comparability: {
      status: 'diagnostic-only',
      reason: 'Scaffold evidence is collected after the profile window and does not verify native metric comparability.',
      policy: 'Replace this scaffold with project-local native diagnostics before making performance claims.',
    },
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Native performance release readiness.',
      reason: 'This scaffold declares the native-performance evidence shape but does not capture comparable platform-native diagnostics.',
      missingEvidence: scaffold.missingEvidence,
      nextAction: scaffold.summary,
    },
    dataClasses: scaffold.dataClasses,
    evidenceKind: scaffold.evidenceKind,
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding: {
      status: 'unverified',
      reason: 'Replace this scaffold provider with a platform-native capture that verifies device and app binding.',
    },
    frames: scaffold.frames,
    memory: scaffold.memory,
    summary: scaffold.summary,
  });
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
