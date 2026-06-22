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
 * Returns the platform-specific scaffold policy for native-performance evidence.
 *
 * @param {string} platform
 * @returns {{
 *   dataClasses: string[],
 *   evidenceKind: string,
 *   frames: Record<string, number | null>,
 *   memory: Record<string, number | null>,
 *   metrics: Record<string, number | string | null>,
 *   missingEvidence: string[],
 *   nextAction: string,
 *   summary: string,
 *   targetBindingReason: string,
 *   toolName: string,
 *   traces: Record<string, string>[]
 * }}
 */
function resolveNativePerformanceScaffold(platform) {
  switch (platform) {
    case 'android':
      return {
        dataClasses: ['frames', 'jank', 'render', 'memory', 'cpu', 'thread-scheduling', 'native-trace'],
        evidenceKind: 'mixed',
        frames: {
          total: null,
          janky: null,
          missedDeadline: null,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
        },
        memory: {
          totalPssKb: null,
          nativeHeapKb: null,
          javaHeapKb: null,
        },
        metrics: {
          sampleWindowMs: null,
          droppedFramePercent: null,
          cpuPercent: null,
        },
        missingEvidence: [
          'verified Android device and app binding',
          'Perfetto or trace-processor summary',
          'gfxinfo or framestats summary',
          'meminfo summary',
          'native-performance baseline policy',
        ],
        nextAction: 'Replace this scaffold with an Android provider that captures Perfetto, gfxinfo/framestats, meminfo, logcat render signals, and target binding.',
        summary: 'Android native-performance scaffold only. Replace with project-local Perfetto, gfxinfo/framestats, meminfo, and logcat-derived render evidence before making product claims.',
        targetBindingReason: 'Scaffold output has not verified the selected Android device, foreground app, package id, or trace window.',
        toolName: 'agent-scenario-loop Android native-performance scaffold provider',
        traces: [
          {
            kind: 'perfetto-or-trace-processor',
            status: 'not-captured',
            reason: 'The scaffold does not capture native traces.',
          },
        ],
      };
    case 'ios':
      return {
        dataClasses: ['frames', 'render', 'memory', 'cpu', 'native-trace'],
        evidenceKind: 'mixed',
        frames: {
          total: null,
          janky: null,
          p50Ms: null,
          p95Ms: null,
          p99Ms: null,
        },
        memory: {
          residentSizeBytes: null,
          physicalFootprintBytes: null,
        },
        metrics: {
          sampleWindowMs: null,
          hangCount: null,
          cpuPercent: null,
        },
        missingEvidence: [
          'verified iOS simulator or device and app binding',
          'Instruments or xctrace summary',
          'MetricKit summary where available',
          'simctl log native-performance signals',
          'native-performance baseline policy',
        ],
        nextAction: 'Replace this scaffold with an iOS provider that captures xctrace/Instruments, MetricKit-style summaries where available, simctl logs, and target binding.',
        summary: 'iOS native-performance scaffold only. Replace with project-local xctrace/Instruments, MetricKit-style, or simctl-derived native evidence before making product claims.',
        targetBindingReason: 'Scaffold output has not verified the selected iOS simulator or device, bundle id, runtime, or trace window.',
        toolName: 'agent-scenario-loop iOS native-performance scaffold provider',
        traces: [
          {
            kind: 'xctrace-or-instruments',
            status: 'not-captured',
            reason: 'The scaffold does not capture native traces.',
          },
        ],
      };
    default:
      return {
        dataClasses: ['unknown'],
        evidenceKind: 'unknown',
        frames: {
          total: null,
          janky: null,
          p95Ms: null,
        },
        memory: {
          totalBytes: null,
        },
        metrics: {
          sampleWindowMs: null,
        },
        missingEvidence: [
          'verified platform binding',
          'platform-native frame or trace summary',
          'platform-native memory summary',
          'native-performance baseline policy',
        ],
        nextAction: 'Replace this scaffold with a platform-native provider that captures target binding, frame/render evidence, memory evidence, and comparability policy.',
        summary: 'Unknown-platform native-performance scaffold only. Replace with platform-native evidence before making product claims.',
        targetBindingReason: 'Scaffold output cannot verify platform, target device, app identity, or trace window.',
        toolName: 'agent-scenario-loop native-performance scaffold provider',
        traces: [
          {
            kind: 'platform-native-trace',
            status: 'not-captured',
            reason: 'The scaffold does not capture native traces.',
          },
        ],
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
  const scaffold = resolveNativePerformanceScaffold(platform);

  writeJsonArtifact(outPath, {
    schemaVersion: '1.0.0',
    providerId: 'example-evidence-provider',
    platform,
    runId,
    scenarioId,
    tool: {
      name: scaffold.toolName,
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
      claim: 'Native performance product claim.',
      reason: 'Scaffold native-performance evidence proves provider wiring only; it has no verified target binding, real platform counters, or comparable baseline.',
      supportingEvidence: ['schema-compatible nativePerformance envelope'],
      missingEvidence: scaffold.missingEvidence,
      nextAction: scaffold.nextAction,
    },
    dataClasses: scaffold.dataClasses,
    evidenceKind: scaffold.evidenceKind,
    integrity: {
      status: 'unknown',
      redactionStatus: 'unknown',
      corruptionStatus: 'unknown',
    },
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding: {
      status: 'unverified',
      reason: scaffold.targetBindingReason,
    },
    frames: scaffold.frames,
    memory: scaffold.memory,
    metrics: scaffold.metrics,
    traces: scaffold.traces,
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
