#!/usr/bin/env node

const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');

const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { checkAgentDeviceAvailability, parseRequiredPlatforms } = require('./agent-device');
const { runAndroidAdbPreflight } = require('./android-adb');
const { checkArgentAvailability, parseBaseArgs } = require('./argent');
const { hasHelpFlag, writeUsage } = require('./cli');
const { runIosSimctlCapture } = require('./ios-simctl');
const { loadAslLocalEnv, readStringArgOrEnv } = require('./local-env');

type HostDoctorRequirement = 'agent-device' | 'android' | 'argent' | 'ios';
type CliArgs = {
  adb?: string | boolean;
  'agent-device'?: string | boolean;
  'agent-device-require-platforms'?: string | boolean;
  'android-package'?: string | boolean;
  'android-serial'?: string | boolean;
  argent?: string | boolean;
  'base-args'?: string | boolean;
  'command-timeout-ms'?: string | boolean;
  'ios-bundle'?: string | boolean;
  'ios-device'?: string | boolean;
  'min-free-disk'?: string | boolean;
  'orphan-process'?: string | boolean;
  out?: string | boolean;
  'exclusive-process'?: string | boolean;
  require?: string | boolean;
  'run-id'?: string | boolean;
  'tcp-port'?: string | boolean;
  xcrun?: string | boolean;
  [key: string]: string | boolean | undefined;
};
type HostDoctorChildResult = {
  health?: Record<string, unknown>;
  runDir: string;
  verdict?: Record<string, unknown>;
};
type HostDoctorOptions = {
  adbPath?: string;
  agentDevicePath?: string;
  agentDeviceRequiredPlatforms?: import('./agent-device-driver').AgentDevicePlatform[];
  androidPackageName?: string | null;
  androidPreflight?: (options: Record<string, unknown>) => Promise<HostDoctorChildResult>;
  androidSerial?: string | null;
  argentAvailability?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  argentCommand?: string;
  argentBaseArgs?: string[];
  commandTimeoutMs?: number;
  iosBundleId?: string | null;
  iosDevice?: string | null;
  iosPreflight?: (options: Record<string, unknown>) => Promise<HostDoctorChildResult>;
  diskSpaceProbe?: (target: DiskSpaceTarget) => Promise<DiskSpaceProbeResult>;
  diskSpaceTargets?: DiskSpaceTarget[];
  exclusiveProcessProbe?: (target: ExclusiveProcessTarget) => Promise<ExclusiveProcessProbeResult>;
  exclusiveProcessTargets?: ExclusiveProcessTarget[];
  orphanProcessProbe?: (target: OrphanProcessTarget) => Promise<OrphanProcessProbeResult>;
  orphanProcessTargets?: OrphanProcessTarget[];
  outputDir?: string;
  requirements?: HostDoctorRequirement[];
  runId?: string;
  agentDeviceAvailability?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  tcpPortProbe?: (target: TcpPortTarget, timeoutMs: number) => Promise<TcpPortProbeResult>;
  tcpPortTargets?: TcpPortTarget[];
  xcrunPath?: string;
};
type TcpPortProbeResult = {
  elapsedMs?: number;
  errorMessage?: string;
  status: 'failed' | 'passed';
};
type DiskSpaceProbeResult = {
  availableBytes?: number;
  errorMessage?: string;
  status: 'failed' | 'passed';
};
type ExclusiveProcessProbeResult = {
  errorMessage?: string;
  matches?: ProcessMatch[];
  status: 'failed' | 'passed';
};
type OrphanProcessProbeResult = {
  command?: string[];
  errorMessage?: string;
  matches?: ProcessMatch[];
  platform?: string;
  status: 'error' | 'failed' | 'passed';
};
type DiskSpaceTarget = {
  label: string;
  minFreeBytes: number;
  path: string;
};
type ExclusiveProcessTarget = {
  label: string;
  pattern: string;
};
type OrphanProcessTarget = {
  label: string;
  pattern: string;
};
type ProcessMatch = {
  command: string;
  pid: number;
};
type TcpPortTarget = {
  host: string;
  label: string;
  port: number;
};
type HostDoctorCheck = {
  code: string;
  message: string;
  metadata?: Record<string, string | number | boolean | null>;
  name: string;
  source: 'runner';
  status: 'failed' | 'passed';
};
type HostDoctorResult = {
  agentSummary: string;
  health: Record<string, unknown>;
  raw: Record<string, unknown>;
  runDir: string;
  verdict: Record<string, unknown>;
};

const DEFAULT_REQUIREMENTS: HostDoctorRequirement[] = ['android', 'ios'];
const REQUIREMENT_SET = new Set<HostDoctorRequirement>(['agent-device', 'android', 'argent', 'ios']);
const execFileAsync = promisify(execFile);

/**
 * Prints CLI usage.
 *
 * @param {{write: (message: string) => unknown}} output
 * @returns {void}
 */
function usage(output: {write: (message: string) => unknown} = process.stderr): void {
  writeUsage([
    'Usage: asl-host-doctor [--require android,ios[,agent-device,argent]] [--out <dir>]',
    '',
    'Runs host/device preflight checks before mobile live proof commands.',
    'Writes health.json, verdict.json, agent-summary.md, and raw child preflight artifacts.',
    'Default requirements are android and ios; add agent-device or Argent when sidecar proofs must be available.',
    'Use --android-package, --android-serial, --ios-bundle, and --ios-device to target an installed app or specific target.',
    'Use --agent-device-require-platforms ios,android when agent-device discovery must prove booted OS targets.',
    'Use --argent <binary> and --base-args "<args>" to verify a non-global Argent command shape.',
    'Use --tcp-port <host:port[,host:port]> to verify local services such as Metro before live proof.',
    'Use --min-free-disk <path:mb[,path:mb]> to verify artifact storage capacity before trace-heavy proof.',
    'Use --exclusive-process <label:pattern[,label:pattern]> to fail when an exclusive profiler or trace tool is already running.',
    'Use --orphan-process <label:pattern[,label:pattern]> to report stale tool processes before live proof.',
    'Use --command-timeout-ms <ms> to bound agent-device and Argent availability checks.',
  ], output);
}

/**
 * Parses `--key value` CLI arguments.
 *
 * @param {string[]} argv
 * @returns {CliArgs}
 */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      continue;
    }
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
 * Creates a short random run id.
 *
 * @returns {string}
 */
function createRunId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Parses the comma-separated host doctor requirements.
 *
 * @param {unknown} value
 * @returns {HostDoctorRequirement[]}
 */
function parseRequirements(value: unknown): HostDoctorRequirement[] {
  if (value === undefined || value === false) {
    return [...DEFAULT_REQUIREMENTS];
  }
  if (value === true || typeof value !== 'string') {
    throw new Error('--require must be a comma-separated list of android, ios, agent-device, and argent.');
  }

  const requirements = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = requirements.find((requirement) => !REQUIREMENT_SET.has(requirement as HostDoctorRequirement));
  if (invalid) {
    throw new Error(`Unsupported host doctor requirement: ${invalid}.`);
  }
  return Array.from(new Set(requirements as HostDoctorRequirement[]));
}

/**
 * Reads a positive integer from CLI values.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Makes a host/port label safe for a health check name.
 *
 * @param {string} value
 * @returns {string}
 */
function safeCheckSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '') || 'target';
}

/**
 * Parses comma-separated TCP host/port targets.
 *
 * @param {unknown} value
 * @returns {TcpPortTarget[]}
 */
function parseTcpPortTargets(value: unknown): TcpPortTarget[] {
  if (value === undefined || value === false) {
    return [];
  }
  if (value === true || typeof value !== 'string') {
    throw new Error('--tcp-port must be a comma-separated list of <host:port> or <port> targets.');
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split(':');
      const host = parts.length > 1 ? parts.slice(0, -1).join(':').trim() : 'localhost';
      const portText = parts[parts.length - 1]?.trim() ?? '';
      const port = Number(portText);
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`Invalid --tcp-port target: ${item}.`);
      }
      return {
        host,
        label: `${host}:${port}`,
        port,
      };
    });
}

/**
 * Parses comma-separated disk free-space targets.
 *
 * @param {unknown} value
 * @returns {DiskSpaceTarget[]}
 */
function parseDiskSpaceTargets(value: unknown): DiskSpaceTarget[] {
  if (value === undefined || value === false) {
    return [];
  }
  if (value === true || typeof value !== 'string') {
    throw new Error('--min-free-disk must be a comma-separated list of <path:mb> targets.');
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.lastIndexOf(':');
      if (separatorIndex <= 0 || separatorIndex >= item.length - 1) {
        throw new Error(`Invalid --min-free-disk target: ${item}.`);
      }
      const targetPath = item.slice(0, separatorIndex).trim();
      const minFreeMb = Number(item.slice(separatorIndex + 1).trim());
      if (!targetPath || !Number.isFinite(minFreeMb) || minFreeMb <= 0) {
        throw new Error(`Invalid --min-free-disk target: ${item}.`);
      }
      const resolvedPath = path.resolve(targetPath);
      return {
        label: `${resolvedPath}:${minFreeMb}mb`,
        minFreeBytes: Math.ceil(minFreeMb * 1024 * 1024),
        path: resolvedPath,
      };
    });
}

/**
 * Parses comma-separated process exclusivity targets.
 *
 * @param {unknown} value
 * @returns {ExclusiveProcessTarget[]}
 */
function parseExclusiveProcessTargets(value: unknown): ExclusiveProcessTarget[] {
  if (value === undefined || value === false) {
    return [];
  }
  if (value === true || typeof value !== 'string') {
    throw new Error('--exclusive-process must be a comma-separated list of <label:pattern> targets.');
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf(':');
      if (separatorIndex <= 0 || separatorIndex >= item.length - 1) {
        throw new Error(`Invalid --exclusive-process target: ${item}.`);
      }
      const label = item.slice(0, separatorIndex).trim();
      const pattern = item.slice(separatorIndex + 1).trim();
      if (!label || !pattern) {
        throw new Error(`Invalid --exclusive-process target: ${item}.`);
      }
      return { label, pattern };
    });
}

/**
 * Parses comma-separated stale process probes.
 *
 * @param {unknown} value
 * @returns {OrphanProcessTarget[]}
 */
function parseOrphanProcessTargets(value: unknown): OrphanProcessTarget[] {
  if (value === undefined || value === false) {
    return [];
  }
  if (value === true || typeof value !== 'string') {
    throw new Error('--orphan-process must be a comma-separated list of <label:pattern> targets.');
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf(':');
      if (separatorIndex <= 0 || separatorIndex >= item.length - 1) {
        throw new Error(`Invalid --orphan-process target: ${item}.`);
      }
      const label = item.slice(0, separatorIndex).trim();
      const pattern = item.slice(separatorIndex + 1).trim();
      if (!label || !pattern) {
        throw new Error(`Invalid --orphan-process target: ${item}.`);
      }
      if (pattern.length < 3) {
        throw new Error(`Invalid --orphan-process target: ${item}. Pattern must be at least 3 characters.`);
      }
      return { label, pattern };
    });
}

/**
 * Reads a JSON object if the child artifact exists.
 *
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function readJsonIfPresent(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reads health from a child preflight result or its artifact directory.
 *
 * @param {HostDoctorChildResult} result
 * @returns {Record<string, unknown>}
 */
function readChildHealth(result: HostDoctorChildResult): Record<string, unknown> {
  return result.health ?? readJsonIfPresent(path.join(result.runDir, 'health.json')) ?? {};
}

/**
 * Reads the first next-action hint from a failed child health artifact.
 *
 * @param {Record<string, unknown>} health
 * @returns {Record<string, string> | null}
 */
function readChildNextAction(health: Record<string, unknown>): Record<string, string> | null {
  const checks = Array.isArray(health.checks) ? health.checks : [];
  for (const check of checks) {
    if (!check || typeof check !== 'object') {
      continue;
    }
    const record = check as Record<string, unknown>;
    const metadata = record.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      continue;
    }
    const metadataRecord = metadata as Record<string, unknown>;
    if (typeof metadataRecord.nextAction === 'string') {
      return {
        nextAction: metadataRecord.nextAction,
        ...(typeof metadataRecord.nextActionCode === 'string' ? { nextActionCode: metadataRecord.nextActionCode } : {}),
      };
    }
  }
  return null;
}

/**
 * Builds a scalar ASL health check from a child preflight run.
 *
 * @param {{health: Record<string, unknown>, label: string, name: string, runDir: string}} options
 * @returns {HostDoctorCheck}
 */
function buildChildRunCheck({
  health,
  label,
  name,
  runDir,
}: {
  health: Record<string, unknown>;
  label: string;
  name: string;
  runDir: string;
}): HostDoctorCheck {
  const passed = health.healthStatus === 'passed';
  const nextAction = passed ? null : readChildNextAction(health);
  return {
    code: passed ? `${name}_host_ready` : `${name}_host_unavailable`,
    message: passed
      ? `${label} host preflight passed.`
      : `${label} host preflight failed; inspect ${path.join(runDir, 'agent-summary.md')}.`,
    metadata: {
      childRunDir: runDir,
      ...(nextAction ?? {}),
    },
    name,
    source: 'runner',
    status: passed ? 'passed' : 'failed',
  };
}

/**
 * Reads the first failed command-surface check from an availability result.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown> | null}
 */
function readFailedAvailabilityCheck(result: Record<string, unknown>): Record<string, unknown> | null {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  for (const check of checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      continue;
    }
    const record = check as Record<string, unknown>;
    if (record.status === 'failed') {
      return record;
    }
  }
  return null;
}

/**
 * Builds scalar metadata from a failed command-surface check.
 *
 * @param {{failedCheck: Record<string, unknown>, label: string, name: string, rawPath: string}} options
 * @returns {Record<string, string>}
 */
function buildAvailabilityFailureMetadata({
  failedCheck,
  label,
  name,
  rawPath,
}: {
  failedCheck: Record<string, unknown>;
  label: string;
  name: string;
  rawPath: string;
}): Record<string, string> {
  const failedCheckName = typeof failedCheck.name === 'string' ? failedCheck.name : `${name}_availability`;
  const failedCheckCode = typeof failedCheck.code === 'string' ? failedCheck.code : `${name}_availability_failed`;
  const failedCheckMessage = typeof failedCheck.message === 'string' ? failedCheck.message : `${label} availability check failed.`;
  const stderrPreview = typeof failedCheck.stderrPreview === 'string' ? failedCheck.stderrPreview : '';
  const stdoutPreview = typeof failedCheck.stdoutPreview === 'string' ? failedCheck.stdoutPreview : '';
  const checkMetadata = failedCheck.metadata && typeof failedCheck.metadata === 'object' && !Array.isArray(failedCheck.metadata)
    ? failedCheck.metadata as Record<string, unknown>
    : {};
  const classifiedNextActionCode = typeof checkMetadata.nextActionCode === 'string'
    ? checkMetadata.nextActionCode
    : null;
  const classifiedNextAction = typeof checkMetadata.nextAction === 'string'
    ? checkMetadata.nextAction
    : null;
  const failureClass = typeof checkMetadata.failureClass === 'string'
    ? checkMetadata.failureClass
    : null;
  const diagnostic = `${failedCheckMessage}\n${stderrPreview}\n${stdoutPreview}`;
  const hostAccessFailure = /operation not permitted|permission denied|sandbox|daemon|smartsocket|cannot bind/iu.test(diagnostic);
  const timedOut = /timed out|timeout/iu.test(diagnostic);
  const nextActionCode = classifiedNextActionCode ?? (hostAccessFailure
    ? 'rerun_with_host_access'
    : timedOut
      ? `increase_${name}_timeout`
      : `inspect_${name}_availability`);
  const nextAction = classifiedNextAction ?? (hostAccessFailure
    ? `Rerun the host doctor outside the restricted sandbox or grant host/device access before treating ${label} failures as app or scenario regressions.`
    : timedOut
      ? `Confirm ${label} can run without prompts, increase --command-timeout-ms if it is legitimately slow, then rerun the host doctor.`
      : `Inspect ${rawPath}, fix the ${label} command surface, then rerun the host doctor before starting live proof.`);

  return {
    failedCheckCode,
    failedCheckMessage,
    failedCheckName,
    ...(failureClass ? { failureClass } : {}),
    nextAction,
    nextActionCode,
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}

/**
 * Builds a scalar ASL health check from a command-surface availability result.
 *
 * @param {{label: string, name: string, rawPath: string, result: Record<string, unknown>}} options
 * @returns {HostDoctorCheck}
 */
function buildAvailabilityCheck({
  label,
  name,
  rawPath,
  result,
}: {
  label: string;
  name: string;
  rawPath: string;
  result: Record<string, unknown>;
}): HostDoctorCheck {
  const passed = result.status === 'passed';
  const failedCheck = passed ? null : readFailedAvailabilityCheck(result);
  return {
    code: passed ? `${name}_available` : `${name}_unavailable`,
    message: passed
      ? `${label} command surface is available.`
      : `${label} command surface failed; inspect ${rawPath}.`,
    metadata: {
      rawPath,
      ...(failedCheck
        ? buildAvailabilityFailureMetadata({ failedCheck, label, name, rawPath })
        : {}),
    },
    name,
    source: 'runner',
    status: passed ? 'passed' : 'failed',
  };
}

/**
 * Builds a failed health check from an unexpected host doctor exception.
 *
 * @param {{error: unknown, name: string}} options
 * @returns {HostDoctorCheck}
 */
function buildExceptionCheck({
  error,
  name,
}: {
  error: unknown;
  name: string;
}): HostDoctorCheck {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: `${name}_doctor_exception`,
    message: `${name} preflight threw before writing complete evidence.`,
    metadata: {
      errorMessage: message,
      nextAction: 'Inspect the command configuration and rerun the host doctor with host/device access before starting live proof.',
      nextActionCode: 'rerun_host_doctor',
    },
    name,
    source: 'runner',
    status: 'failed',
  };
}

/**
 * Checks whether a TCP service accepts a bounded connection.
 *
 * @param {TcpPortTarget} target
 * @param {number} timeoutMs
 * @returns {Promise<TcpPortProbeResult>}
 */
function probeTcpPort(target: TcpPortTarget, timeoutMs: number): Promise<TcpPortProbeResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host: target.host, port: target.port });
    const finish = (result: TcpPortProbeResult): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        ...result,
        elapsedMs: Date.now() - startedAt,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ status: 'passed' }));
    socket.once('error', (error: Error) => finish({ errorMessage: error.message, status: 'failed' }));
    socket.once('timeout', () => finish({
      errorMessage: `Timed out after ${timeoutMs}ms.`,
      status: 'failed',
    }));
  });
}

/**
 * Builds a host health check for one required TCP service.
 *
 * @param {{result: TcpPortProbeResult, target: TcpPortTarget}} options
 * @returns {HostDoctorCheck}
 */
function buildTcpPortCheck({
  result,
  target,
}: {
  result: TcpPortProbeResult;
  target: TcpPortTarget;
}): HostDoctorCheck {
  const name = `tcp_port_${safeCheckSegment(target.label)}`;
  const passed = result.status === 'passed';
  return {
    code: passed ? 'tcp_port_available' : 'tcp_port_unavailable',
    message: passed
      ? `TCP service ${target.label} accepted a connection.`
      : `TCP service ${target.label} did not accept a connection.`,
    metadata: {
      host: target.host,
      label: target.label,
      nextAction: passed
        ? 'No action required.'
        : `Start or restart the expected service on ${target.label}, then rerun the host doctor before live proof.`,
      nextActionCode: passed ? 'none' : 'start_required_tcp_service',
      port: target.port,
      ...(typeof result.elapsedMs === 'number' ? { elapsedMs: result.elapsedMs } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    },
    name,
    source: 'runner',
    status: passed ? 'passed' : 'failed',
  };
}

/**
 * Checks available bytes for an artifact storage path.
 *
 * @param {DiskSpaceTarget} target
 * @returns {Promise<DiskSpaceProbeResult>}
 */
async function probeDiskSpace(target: DiskSpaceTarget): Promise<DiskSpaceProbeResult> {
  try {
    const stats = await fsp.statfs(target.path);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      availableBytes,
      status: availableBytes >= target.minFreeBytes ? 'passed' : 'failed',
    };
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
      status: 'failed',
    };
  }
}

/**
 * Formats a byte count as MiB for scalar health metadata.
 *
 * @param {number} bytes
 * @returns {number}
 */
function bytesToMib(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/**
 * Builds a host health check for one required disk capacity target.
 *
 * @param {{result: DiskSpaceProbeResult, target: DiskSpaceTarget}} options
 * @returns {HostDoctorCheck}
 */
function buildDiskSpaceCheck({
  result,
  target,
}: {
  result: DiskSpaceProbeResult;
  target: DiskSpaceTarget;
}): HostDoctorCheck {
  const name = `disk_space_${safeCheckSegment(target.path)}`;
  const passed = result.status === 'passed';
  const minFreeMib = bytesToMib(target.minFreeBytes);
  const availableMib = typeof result.availableBytes === 'number'
    ? bytesToMib(result.availableBytes)
    : null;
  return {
    code: passed ? 'disk_space_available' : 'disk_space_insufficient',
    message: passed
      ? `Disk target ${target.path} has at least ${minFreeMib} MiB free.`
      : `Disk target ${target.path} does not have the required ${minFreeMib} MiB free.`,
    metadata: {
      label: target.label,
      minFreeMib,
      path: target.path,
      nextAction: passed
        ? 'No action required.'
        : `Free disk space for ${target.path}, choose a larger artifact root, or lower --min-free-disk only if the run does not need heavy traces.`,
      nextActionCode: passed ? 'none' : 'free_artifact_disk_space',
      ...(availableMib !== null ? { availableMib } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    },
    name,
    source: 'runner',
    status: passed ? 'passed' : 'failed',
  };
}

/**
 * Parses `ps` output into process records.
 *
 * @param {string} stdout
 * @returns {ProcessMatch[]}
 */
function parseProcessList(stdout: string): ProcessMatch[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/u.exec(line);
      if (!match) {
        return null;
      }
      return {
        command: match[2] ?? '',
        pid: Number(match[1]),
      };
    })
    .filter((match): match is ProcessMatch => (
      !!match &&
      Number.isInteger(match.pid) &&
      match.pid > 0 &&
      Boolean(match.command)
    ));
}

/**
 * Checks whether a process pattern is already running.
 *
 * @param {ExclusiveProcessTarget} target
 * @returns {Promise<ExclusiveProcessProbeResult>}
 */
async function probeExclusiveProcess(target: ExclusiveProcessTarget): Promise<ExclusiveProcessProbeResult> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const pattern = target.pattern.toLowerCase();
    const matches = parseProcessList(stdout)
      .filter((processInfo) => (
        processInfo.pid !== process.pid &&
        processInfo.command.toLowerCase().includes(pattern)
      ));
    return {
      ...(matches.length > 0 ? { matches } : {}),
      status: matches.length > 0 ? 'failed' : 'passed',
    };
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
      status: 'failed',
    };
  }
}

/**
 * Builds a host health check for one exclusive process target.
 *
 * @param {{result: ExclusiveProcessProbeResult, target: ExclusiveProcessTarget}} options
 * @returns {HostDoctorCheck}
 */
function buildExclusiveProcessCheck({
  result,
  target,
}: {
  result: ExclusiveProcessProbeResult;
  target: ExclusiveProcessTarget;
}): HostDoctorCheck {
  const name = `exclusive_process_${safeCheckSegment(target.label)}`;
  const matches = result.matches ?? [];
  const passed = result.status === 'passed' && matches.length === 0;
  return {
    code: passed ? 'exclusive_process_clear' : 'exclusive_process_conflict',
    message: passed
      ? `No existing process matched exclusive target ${target.label}.`
      : `Existing process matched exclusive target ${target.label}.`,
    metadata: {
      label: target.label,
      matchCount: matches.length,
      nextAction: passed
        ? 'No action required.'
        : `Stop or isolate existing ${target.label} process ownership before starting heavy diagnostics.`,
      nextActionCode: passed ? 'none' : 'stop_conflicting_process',
      pattern: target.pattern,
      ...(matches.length > 0 ? { matchingPids: matches.slice(0, 5).map((match) => String(match.pid)).join(',') } : {}),
      ...(matches.length > 0 ? { matchingCommands: matches.slice(0, 3).map((match) => match.command).join('\n') } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    },
    name,
    source: 'runner',
    status: passed ? 'passed' : 'failed',
  };
}

/**
 * Lists processes whose command contains the configured target pattern.
 *
 * @param {OrphanProcessTarget} target
 * @returns {Promise<OrphanProcessProbeResult>}
 */
async function probeOrphanProcess(target: OrphanProcessTarget): Promise<OrphanProcessProbeResult> {
  const command = ['ps', '-axo', 'pid=,command='];
  const platform = process.platform;
  if (platform === 'win32') {
    return {
      command,
      errorMessage: 'Host process inspection requires a POSIX ps command.',
      platform,
      status: 'error',
    };
  }

  try {
    const { stdout } = await execFileAsync(command[0] ?? 'ps', command.slice(1), {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const matches = parseProcessList(stdout)
      .filter((processInfo) => (
        processInfo.pid !== process.pid &&
        processInfo.command.includes(target.pattern)
      ));
    return {
      command,
      matches,
      platform,
      status: matches.length === 0 ? 'passed' : 'failed',
    };
  } catch (error) {
    return {
      command,
      errorMessage: error instanceof Error ? error.message : String(error),
      platform,
      status: 'error',
    };
  }
}

type OrphanProcessCheckPolicy = {
  code: string;
  message: string;
  nextAction: string;
  nextActionCode: string;
  passed: boolean;
};

/**
 * Maps stale-process probe output to public host-doctor health vocabulary.
 *
 * @param {{errorMessage: string, matchCount: number, probeStatus: OrphanProcessProbeResult['status'], target: OrphanProcessTarget}} options
 * @returns {OrphanProcessCheckPolicy}
 */
function determineOrphanProcessCheckPolicy({
  errorMessage,
  matchCount,
  probeStatus,
  target,
}: {
  errorMessage: string;
  matchCount: number;
  probeStatus: OrphanProcessProbeResult['status'];
  target: OrphanProcessTarget;
}): OrphanProcessCheckPolicy {
  if (probeStatus === 'error' || errorMessage.length > 0) {
    return {
      code: 'orphan_process_probe_failed',
      message: `Unable to inspect ${target.label} process state.`,
      nextAction: 'Diagnose the host process inspection failure, then rerun the host doctor before live proof.',
      nextActionCode: 'retry_orphan_process_probe',
      passed: false,
    };
  }

  if (matchCount > 0) {
    return {
      code: 'orphan_process_detected',
      message: `Found ${matchCount} stale ${target.label} process(es) matching ${target.pattern}.`,
      nextAction: `Stop or account for stale ${target.label} process(es), then rerun the host doctor before live proof.`,
      nextActionCode: 'resolve_orphan_process',
      passed: false,
    };
  }

  return {
    code: 'orphan_process_absent',
    message: `No stale ${target.label} process matched ${target.pattern}.`,
    nextAction: 'No action required.',
    nextActionCode: 'none',
    passed: true,
  };
}

/**
 * Builds a host health check for one stale process probe.
 *
 * @param {{result: OrphanProcessProbeResult, target: OrphanProcessTarget}} options
 * @returns {HostDoctorCheck}
 */
function buildOrphanProcessCheck({
  result,
  target,
}: {
  result: OrphanProcessProbeResult;
  target: OrphanProcessTarget;
}): HostDoctorCheck {
  const name = `orphan_process_${safeCheckSegment(target.label)}`;
  const matches = result.matches ?? [];
  const firstMatch = matches[0];
  const errorMessage = typeof result.errorMessage === 'string' ? result.errorMessage.trim() : '';
  const firstCommand = typeof firstMatch?.command === 'string' ? firstMatch.command : '';
  const firstCommandPreview = firstCommand.slice(0, 240);
  const matchedPids = matches
    .map((match) => match.pid)
    .filter((pid) => Number.isInteger(pid))
    .slice(0, 10)
    .join(',');
  const policy = determineOrphanProcessCheckPolicy({
    errorMessage,
    matchCount: matches.length,
    probeStatus: result.status,
    target,
  });
  return {
    code: policy.code,
    message: policy.message,
    metadata: {
      label: target.label,
      matchCount: matches.length,
      nextAction: policy.nextAction,
      nextActionCode: policy.nextActionCode,
      pattern: target.pattern,
      probeStatus: result.status,
      ...(typeof result.platform === 'string' ? { platform: result.platform } : {}),
      ...(matchedPids ? { matchedPids } : {}),
      ...(typeof firstMatch?.pid === 'number' ? { firstPid: firstMatch.pid } : {}),
      ...(firstCommandPreview ? { firstCommand: firstCommandPreview } : {}),
      ...(firstCommand.length > firstCommandPreview.length ? { firstCommandTruncated: true } : {}),
      ...(errorMessage.length > 0 ? { errorMessage } : {}),
    },
    name,
    source: 'runner',
    status: policy.passed ? 'passed' : 'failed',
  };
}

/**
 * Reads a string field from an artifact record.
 *
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function readStringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * Formats a scalar value as inline markdown code.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatCode(value: unknown): string {
  const text = typeof value === 'string' && value.trim() ? value : 'unknown';
  return `\`${text.replace(/`/gu, '\\`')}\``;
}

/**
 * Reads string metadata from a host check.
 *
 * @param {Record<string, unknown>} check
 * @param {string} key
 * @returns {string | null}
 */
function readCheckMetadataString(check: Record<string, unknown>, key: string): string | null {
  const metadata = check.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Formats one host check for an agent-facing markdown summary.
 *
 * @param {unknown} check
 * @returns {string}
 */
function formatHostCheckLine(check: unknown): string {
  if (!check || typeof check !== 'object') {
    return '- unknown_host_check: unknown - No check details were recorded.';
  }
  const record = check as Record<string, unknown>;
  const name = readStringField(record, 'name', 'unknown_host_check');
  const status = readStringField(record, 'status', 'unknown');
  const message = readStringField(record, 'message', 'No message was recorded.');
  const nextAction = readCheckMetadataString(record, 'nextAction');
  const nextActionCode = readCheckMetadataString(record, 'nextActionCode');
  const suffix = nextAction
    ? ` Next action${nextActionCode ? ` ${formatCode(nextActionCode)}` : ''}: ${nextAction}`
    : '';
  return `- ${name}: ${status} - ${message}${suffix}`;
}

/**
 * Builds a host-specific agent summary for live-proof readiness.
 *
 * @param {{health: Record<string, unknown>, verdict: Record<string, unknown>}} options
 * @returns {string}
 */
function buildHostDoctorSummary({
  health,
  verdict,
}: {
  health: Record<string, unknown>;
  verdict: Record<string, unknown>;
}): string {
  const runId = readStringField(health, 'runId', readStringField(verdict, 'runId', 'unknown-run'));
  const healthStatus = readStringField(health, 'healthStatus', 'failed');
  const verdictStatus = readStringField(verdict, 'verdictStatus', 'inconclusive');
  const checks = Array.isArray(health.checks) ? health.checks : [];
  const checkLines = checks.length > 0
    ? checks.map(formatHostCheckLine)
    : ['- no_host_checks: unknown - No host checks were recorded.'];
  const gate = healthStatus === 'passed'
    ? 'Host/device preflight passed. Live proof can start with the requested host services.'
    : 'Do not start live proof from this host state. Fix failed host/device checks before treating runtime failures as app or scenario regressions.';

  return [
    '# host doctor',
    '',
    `- Run ID: ${formatCode(runId)}`,
    `- Health: ${healthStatus}`,
    `- Verdict: ${verdictStatus}`,
    '',
    '## gate',
    '',
    gate,
    '',
    '## host checks',
    '',
    ...checkLines,
    '',
  ].join('\n');
}

/**
 * Writes one raw JSON file under the doctor run directory.
 *
 * @param {{filePath: string, value: unknown}} options
 * @returns {Promise<string>}
 */
async function writeRawJson({
  filePath,
  value,
}: {
  filePath: string;
  value: unknown;
}): Promise<string> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * Runs host/device preflight checks and writes aggregate ASL artifacts.
 *
 * @param {HostDoctorOptions} options
 * @returns {Promise<HostDoctorResult>}
 */
async function runHostDoctor({
  adbPath = 'adb',
  agentDeviceAvailability = checkAgentDeviceAvailability,
  agentDevicePath = 'agent-device',
  agentDeviceRequiredPlatforms = [],
  androidPackageName = null,
  androidPreflight = runAndroidAdbPreflight,
  androidSerial = null,
  argentAvailability = checkArgentAvailability,
  argentBaseArgs,
  argentCommand = 'argent',
  commandTimeoutMs = 30_000,
  iosBundleId = null,
  iosDevice = null,
  iosPreflight = runIosSimctlCapture,
  diskSpaceProbe = probeDiskSpace,
  diskSpaceTargets = [],
  exclusiveProcessProbe = probeExclusiveProcess,
  exclusiveProcessTargets = [],
  orphanProcessProbe = probeOrphanProcess,
  orphanProcessTargets = [],
  outputDir = path.resolve('artifacts/host-doctor'),
  requirements = DEFAULT_REQUIREMENTS,
  runId = createRunId(),
  tcpPortProbe = probeTcpPort,
  tcpPortTargets = [],
  xcrunPath = 'xcrun',
}: HostDoctorOptions = {}): Promise<HostDoctorResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  await fsp.mkdir(layout.raw, { recursive: true });

  const checks: HostDoctorCheck[] = [];
  const raw: Record<string, unknown> = {
    diskSpaceTargets,
    exclusiveProcessTargets,
    orphanProcessTargets,
    requirements,
    runId,
    tcpPortTargets,
  };

  for (const target of diskSpaceTargets) {
    try {
      const result = await diskSpaceProbe(target);
      checks.push(buildDiskSpaceCheck({ result, target }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: `disk_space_${safeCheckSegment(target.path)}` }));
    }
  }

  for (const target of exclusiveProcessTargets) {
    try {
      const result = await exclusiveProcessProbe(target);
      checks.push(buildExclusiveProcessCheck({ result, target }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: `exclusive_process_${safeCheckSegment(target.label)}` }));
    }
  }

  for (const target of orphanProcessTargets) {
    try {
      const result = await orphanProcessProbe(target);
      checks.push(buildOrphanProcessCheck({ result, target }));
      raw[`orphanProcess:${target.label}`] = result;
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: `orphan_process_${safeCheckSegment(target.label)}` }));
    }
  }

  for (const target of tcpPortTargets) {
    try {
      const result = await tcpPortProbe(target, commandTimeoutMs);
      checks.push(buildTcpPortCheck({ result, target }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: `tcp_port_${safeCheckSegment(target.label)}` }));
    }
  }

  if (requirements.includes('android')) {
    try {
      const result = await androidPreflight({
        adbPath,
        ...(androidPackageName ? { packageName: androidPackageName } : {}),
        outputDir: path.join(layout.raw, 'android-adb-preflight'),
        ...(androidSerial ? { serial: androidSerial } : {}),
        runId: `${runId}-android-adb`,
      });
      const health = readChildHealth(result);
      raw.android = { healthStatus: health.healthStatus, runDir: result.runDir };
      checks.push(buildChildRunCheck({
        health,
        label: 'Android adb',
        name: 'android_adb',
        runDir: result.runDir,
      }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: 'android_adb' }));
    }
  }

  if (requirements.includes('ios')) {
    try {
      const result = await iosPreflight({
        ...(iosBundleId ? { bundleId: iosBundleId } : {}),
        ...(iosDevice ? { device: iosDevice } : {}),
        outputDir: path.join(layout.raw, 'ios-simctl-preflight'),
        runId: `${runId}-ios-simctl`,
        xcrunPath,
      });
      const health = readChildHealth(result);
      raw.ios = { healthStatus: health.healthStatus, runDir: result.runDir };
      checks.push(buildChildRunCheck({
        health,
        label: 'iOS simctl',
        name: 'ios_simctl',
        runDir: result.runDir,
      }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: 'ios_simctl' }));
    }
  }

  if (requirements.includes('agent-device')) {
    const rawPath = path.join(layout.raw, 'agent-device-check.json');
    try {
      const requiredPlatforms = agentDeviceRequiredPlatforms.length > 0
        ? agentDeviceRequiredPlatforms
        : requirements.filter((requirement) => requirement === 'android' || requirement === 'ios') as import('./agent-device-driver').AgentDevicePlatform[];
      const result = await agentDeviceAvailability({
        agentDevicePath,
        commandTimeoutMs,
        requiredPlatforms,
      });
      await writeRawJson({ filePath: rawPath, value: result });
      raw.agentDevice = { rawPath, status: result.status };
      checks.push(buildAvailabilityCheck({
        label: 'agent-device',
        name: 'agent_device',
        rawPath,
        result,
      }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: 'agent_device' }));
    }
  }

  if (requirements.includes('argent')) {
    const rawPath = path.join(layout.raw, 'argent-check.json');
    try {
      const result = await argentAvailability({
        argentCommand,
        ...(argentBaseArgs ? { baseArgs: argentBaseArgs } : {}),
        commandTimeoutMs,
      });
      await writeRawJson({ filePath: rawPath, value: result });
      raw.argent = { rawPath, status: result.status };
      checks.push(buildAvailabilityCheck({
        label: 'Argent',
        name: 'argent',
        rawPath,
        result,
      }));
    } catch (error) {
      checks.push(buildExceptionCheck({ error, name: 'argent' }));
    }
  }

  const healthStatus = checks.every((check) => check.status === 'passed') ? 'passed' : 'failed';
  const health = {
    schemaVersion: '1.0.0',
    scenarioId: 'host-doctor',
    flowId: 'host-doctor',
    runId,
    healthStatus,
    checks,
  };
  const verdict = {
    schemaVersion: '1.0.0',
    scenarioId: 'host-doctor',
    flowId: 'host-doctor',
    runId,
    healthStatus,
    verdictStatus: healthStatus === 'passed' ? 'not_evaluated' : 'inconclusive',
    budgetChecks: [],
    summary: healthStatus === 'passed'
      ? 'Host doctor passed; runtime proof can start with the requested host services.'
      : 'Host doctor failed; fix host/device access before treating live proof failures as app regressions.',
  };
  const agentSummary = buildHostDoctorSummary({ health, verdict });

  await writeJsonArtifact({
    filePath: layout.health,
    value: health,
    schema: SCHEMAS.health,
    label: 'Host doctor health',
  });
  await writeJsonArtifact({
    filePath: layout.verdict,
    value: verdict,
    schema: SCHEMAS.verdict,
    label: 'Host doctor verdict',
  });
  await writeRawJson({
    filePath: path.join(layout.raw, 'host-doctor.json'),
    value: raw,
  });
  await writeTextArtifact({
    filePath: layout.agentSummary,
    content: agentSummary,
  });

  return {
    agentSummary,
    health,
    raw,
    runDir,
    verdict,
  };
}

/**
 * Runs the host doctor CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage(process.stdout);
    return;
  }

  loadAslLocalEnv();
  const args = parseArgs(argv);
  const requirements = parseRequirements(readStringArgOrEnv(args.require, ['ASL_HOST_DOCTOR_REQUIRE']));
  const agentDeviceRequiredPlatformsValue = readStringArgOrEnv(
    args['agent-device-require-platforms'],
    ['ASL_AGENT_DEVICE_REQUIRED_PLATFORMS'],
  );
  const agentDeviceRequiredPlatforms = agentDeviceRequiredPlatformsValue
    ? parseRequiredPlatforms(agentDeviceRequiredPlatformsValue)
    : [];
  const argentBaseArgsValue = readStringArgOrEnv(args['base-args'], ['ASL_ARGENT_BASE_ARGS']);
  const argentBaseArgs = argentBaseArgsValue
    ? parseBaseArgs(argentBaseArgsValue)
    : null;
  const adbPath = readStringArgOrEnv(args.adb, ['ASL_ANDROID_ADB_BIN']);
  const agentDevicePath = readStringArgOrEnv(args['agent-device'], ['ASL_AGENT_DEVICE_BIN']);
  const androidPackageName = readStringArgOrEnv(args['android-package'], [
    'ASL_ANDROID_APP_ID',
    'ASL_EXAMPLE_ANDROID_APP_ID',
  ]);
  const androidSerial = readStringArgOrEnv(args['android-serial'], [
    'ASL_ANDROID_SERIAL',
    'ASL_EXAMPLE_ANDROID_SERIAL',
  ]);
  const argentCommand = readStringArgOrEnv(args.argent, ['ASL_ARGENT_BIN']);
  const commandTimeoutMsValue = readStringArgOrEnv(
    args['command-timeout-ms'],
    ['ASL_HOST_DOCTOR_COMMAND_TIMEOUT_MS'],
  );
  const iosBundleId = readStringArgOrEnv(args['ios-bundle'], [
    'ASL_IOS_APP_ID',
    'ASL_EXAMPLE_IOS_APP_ID',
  ]);
  const iosDevice = readStringArgOrEnv(args['ios-device'], [
    'ASL_IOS_UDID',
    'ASL_EXAMPLE_IOS_UDID',
  ]);
  const xcrunPath = readStringArgOrEnv(args.xcrun, ['ASL_XCRUN_PATH', 'ASL_IOS_XCRUN_BIN']);
  const tcpPortTargets = parseTcpPortTargets(readStringArgOrEnv(args['tcp-port'], ['ASL_HOST_DOCTOR_TCP_PORTS']));
  const diskSpaceTargets = parseDiskSpaceTargets(readStringArgOrEnv(
    args['min-free-disk'],
    ['ASL_HOST_DOCTOR_MIN_FREE_DISK'],
  ));
  const exclusiveProcessTargets = parseExclusiveProcessTargets(readStringArgOrEnv(
    args['exclusive-process'],
    ['ASL_HOST_DOCTOR_EXCLUSIVE_PROCESSES'],
  ));
  const orphanProcessTargets = parseOrphanProcessTargets(readStringArgOrEnv(
    args['orphan-process'],
    ['ASL_HOST_DOCTOR_ORPHAN_PROCESSES'],
  ));
  const result = await runHostDoctor({
    ...(adbPath ? { adbPath } : {}),
    ...(agentDevicePath ? { agentDevicePath } : {}),
    agentDeviceRequiredPlatforms,
    ...(androidPackageName ? { androidPackageName } : {}),
    ...(androidSerial ? { androidSerial } : {}),
    ...(argentCommand ? { argentCommand } : {}),
    ...(argentBaseArgs ? { argentBaseArgs } : {}),
    commandTimeoutMs: parsePositiveInteger(commandTimeoutMsValue, 30_000),
    diskSpaceTargets,
    exclusiveProcessTargets,
    orphanProcessTargets,
    ...(iosBundleId ? { iosBundleId } : {}),
    ...(iosDevice ? { iosDevice } : {}),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    requirements,
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    tcpPortTargets,
    ...(xcrunPath ? { xcrunPath } : {}),
  });
  process.stdout.write(`${result.runDir}\n`);
  if (result.health.healthStatus !== 'passed') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  buildAvailabilityCheck,
  buildChildRunCheck,
  buildDiskSpaceCheck,
  buildExclusiveProcessCheck,
  buildHostDoctorSummary,
  buildOrphanProcessCheck,
  buildTcpPortCheck,
  main,
  parseArgs,
  parseDiskSpaceTargets,
  parseExclusiveProcessTargets,
  parseOrphanProcessTargets,
  parseRequirements,
  parseTcpPortTargets,
  probeDiskSpace,
  probeExclusiveProcess,
  probeOrphanProcess,
  probeTcpPort,
  runHostDoctor,
  usage,
};

export type {
  CliArgs,
  DiskSpaceProbeResult,
  DiskSpaceTarget,
  ExclusiveProcessProbeResult,
  ExclusiveProcessTarget,
  HostDoctorCheck,
  HostDoctorOptions,
  HostDoctorRequirement,
  HostDoctorResult,
  OrphanProcessProbeResult,
  OrphanProcessTarget,
  TcpPortProbeResult,
  TcpPortTarget,
};
