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
 * Returns the schema platform value used by scaffold evidence.
 *
 * @param {string} platform
 * @returns {'android' | 'ios' | 'unknown'}
 */
function normalizePlatform(platform) {
  if (platform === 'android' || platform === 'ios') {
    return platform;
  }
  return 'unknown';
}

/**
 * Builds a source inventory entry for a platform-native diagnostic lane.
 *
 * @param {string} sourceId
 * @param {string} toolName
 * @param {string[]} dataClasses
 * @param {string} nextAction
 * @returns {Record<string, unknown>}
 */
function buildUnverifiedSource(sourceId, toolName, dataClasses, nextAction) {
  return {
    sourceId,
    status: 'unverified',
    tool: {
      name: toolName,
    },
    dataClasses,
    reason: 'This scaffold provider did not execute the native diagnostic source.',
    nextAction,
  };
}

/**
 * Builds platform-specific native diagnostic source inventory.
 *
 * @param {'android' | 'ios' | 'unknown'} platform
 * @returns {Record<string, unknown>[]}
 */
function buildDiagnosticSources(platform) {
  if (platform === 'android') {
    return [
      buildUnverifiedSource('gfxinfo', 'adb dumpsys gfxinfo', ['frames', 'jank', 'render'], 'Capture and parse gfxinfo or framestats output for Android frame evidence.'),
      buildUnverifiedSource('framestats', 'adb dumpsys gfxinfo framestats', ['frames', 'jank'], 'Capture and parse Android framestats for frame deadline and jank evidence.'),
      buildUnverifiedSource('meminfo', 'adb dumpsys meminfo', ['memory'], 'Capture and parse meminfo output for Android native memory evidence.'),
      buildUnverifiedSource('perfetto', 'perfetto', ['frames', 'jank', 'cpu', 'thread-scheduling', 'native-trace'], 'Capture a bounded Perfetto trace and attach the raw trace plus a structured summary.'),
      buildUnverifiedSource('trace-processor', 'trace_processor_shell', ['frames', 'jank', 'cpu', 'thread-scheduling'], 'Summarize Perfetto trace data with trace-processor SQL before making comparable claims.'),
      buildUnverifiedSource('logcat-render', 'adb logcat', ['render'], 'Preserve render or runtime markers from logcat when they explain the native-performance run.'),
    ];
  }

  if (platform === 'ios') {
    return [
      buildUnverifiedSource('instruments', 'Instruments', ['frames', 'jank', 'cpu', 'memory', 'native-trace'], 'Capture an Instruments trace or exported summary for iOS native performance evidence.'),
      buildUnverifiedSource('xctrace', 'xctrace', ['cpu', 'thread-scheduling', 'memory', 'native-trace'], 'Run a bounded xctrace capture/export and attach raw trace references plus structured metrics.'),
      buildUnverifiedSource('metrickit', 'MetricKit', ['frames', 'jank', 'cpu', 'memory', 'thermal', 'battery'], 'Ingest MetricKit payloads only when app/build/run identity and time window are bound.'),
      buildUnverifiedSource('simctl', 'xcrun simctl', ['render', 'memory', 'cpu'], 'Use simctl-derived logs or process state as diagnostic evidence, not as comparable native performance by itself.'),
    ];
  }

  return [
    buildUnverifiedSource('custom', 'project-local native diagnostics', ['unknown'], 'Replace this scaffold with a platform-specific native-performance capture provider.'),
  ];
}

/**
 * Returns the top-level evidence kind for a scaffolded platform.
 *
 * @param {'android' | 'ios' | 'unknown'} platform
 * @returns {string}
 */
function getEvidenceKind(platform) {
  if (platform === 'unknown') {
    return 'unknown';
  }
  return 'mixed';
}

/**
 * Returns the platform-specific scaffold summary.
 *
 * @param {'android' | 'ios' | 'unknown'} platform
 * @returns {string}
 */
function getSummary(platform) {
  if (platform === 'android') {
    return 'Scaffold Android native-performance evidence. Replace with Perfetto, trace-processor, gfxinfo, framestats, meminfo, or logcat-derived summaries before making performance claims.';
  }

  if (platform === 'ios') {
    return 'Scaffold iOS native-performance evidence. Replace with Instruments, xctrace, MetricKit, simctl-derived summaries, or equivalent project-local output before making performance claims.';
  }

  return 'Scaffold native-performance evidence. Replace with platform-native diagnostics before making performance claims.';
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
  const normalizedPlatform = normalizePlatform(platform);
  const diagnosticSources = buildDiagnosticSources(normalizedPlatform);
  writeJsonArtifact(outPath, {
    schemaVersion: '1.0.0',
    providerId: 'example-evidence-provider',
    platform: normalizedPlatform,
    runId,
    scenarioId,
    tool: {
      name: 'agent-scenario-loop scaffold native performance provider',
      version: '1.0.0',
      command: 'scripts/asl-capture-native-performance-provider.mjs',
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
    dataClasses: ['frames', 'memory', 'render'],
    diagnosticSources,
    evidenceKind: getEvidenceKind(normalizedPlatform),
    lifecycle: {
      phase: 'afterCapture',
      perturbsTiming: false,
    },
    targetBinding: {
      status: 'unverified',
      reason: 'Replace this scaffold provider with a platform-native capture that verifies device and app binding.',
    },
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Native performance release or optimization claim.',
      reason: 'The scaffold records expected source lanes but does not capture verified native evidence.',
      supportingEvidence: ['diagnosticSources'],
      missingEvidence: ['verified target binding', 'captured native diagnostic source', 'comparable baseline'],
      nextAction: 'Implement the platform source capture listed in diagnosticSources and rerun before making native-performance claims.',
    },
    frames: {
      total: null,
      janky: null,
      p50Ms: null,
      p95Ms: null,
    },
    memory: {
      totalPssKb: null,
      nativeHeapKb: null,
    },
    summary: getSummary(normalizedPlatform),
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
