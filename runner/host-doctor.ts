#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { createArtifactLayout } = require('../core/artifact-layout');
const { writeJsonArtifact, writeTextArtifact } = require('../core/artifact-writer');
const { SCHEMAS } = require('../core/schema-validator');
const { checkAgentDeviceAvailability, parseRequiredPlatforms } = require('./agent-device');
const { runAndroidAdbPreflight } = require('./android-adb');
const { checkArgentAvailability, parseBaseArgs } = require('./argent');
const { hasHelpFlag, writeUsage } = require('./cli');
const { runIosSimctlCapture } = require('./ios-simctl');

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
  out?: string | boolean;
  require?: string | boolean;
  'run-id'?: string | boolean;
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
  outputDir?: string;
  requirements?: HostDoctorRequirement[];
  runId?: string;
  agentDeviceAvailability?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  xcrunPath?: string;
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
  outputDir = path.resolve('artifacts/host-doctor'),
  requirements = DEFAULT_REQUIREMENTS,
  runId = createRunId(),
  xcrunPath = 'xcrun',
}: HostDoctorOptions = {}): Promise<HostDoctorResult> {
  const runDir = path.resolve(outputDir);
  const layout = createArtifactLayout({ outputDir: runDir });
  await fsp.mkdir(layout.raw, { recursive: true });

  const checks: HostDoctorCheck[] = [];
  const raw: Record<string, unknown> = {
    requirements,
    runId,
  };

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

  const args = parseArgs(argv);
  const requirements = parseRequirements(args.require);
  const agentDeviceRequiredPlatforms = typeof args['agent-device-require-platforms'] === 'string'
    ? parseRequiredPlatforms(args['agent-device-require-platforms'])
    : [];
  const argentBaseArgs = typeof args['base-args'] === 'string'
    ? parseBaseArgs(args['base-args'])
    : null;
  const result = await runHostDoctor({
    ...(typeof args.adb === 'string' ? { adbPath: args.adb } : {}),
    ...(typeof args['agent-device'] === 'string' ? { agentDevicePath: args['agent-device'] } : {}),
    agentDeviceRequiredPlatforms,
    ...(typeof args['android-package'] === 'string' ? { androidPackageName: args['android-package'] } : {}),
    ...(typeof args['android-serial'] === 'string' ? { androidSerial: args['android-serial'] } : {}),
    ...(typeof args.argent === 'string' ? { argentCommand: args.argent } : {}),
    ...(argentBaseArgs ? { argentBaseArgs } : {}),
    commandTimeoutMs: parsePositiveInteger(args['command-timeout-ms'], 30_000),
    ...(typeof args['ios-bundle'] === 'string' ? { iosBundleId: args['ios-bundle'] } : {}),
    ...(typeof args['ios-device'] === 'string' ? { iosDevice: args['ios-device'] } : {}),
    ...(typeof args.out === 'string' ? { outputDir: args.out } : {}),
    requirements,
    ...(typeof args['run-id'] === 'string' ? { runId: args['run-id'] } : {}),
    ...(typeof args.xcrun === 'string' ? { xcrunPath: args.xcrun } : {}),
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
  buildHostDoctorSummary,
  main,
  parseArgs,
  parseRequirements,
  runHostDoctor,
  usage,
};

export type {
  CliArgs,
  HostDoctorCheck,
  HostDoctorOptions,
  HostDoctorRequirement,
  HostDoctorResult,
};
