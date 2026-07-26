#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  buildAndroidNativePerformanceEvidence,
  buildIosNativePerformanceEvidence,
  parseIosMetricKitSummaryText,
  parseIosXctraceSummaryText,
} = require('agent-scenario-loop');
const RUNNER_ACTIVE_LOOP_WINDOW_RELATIVE_PATH = 'raw/runner-active-loop-window.json';

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

function optionalStringArg(args, key, envKey) {
  const value = args[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  const envValue = process.env[envKey];
  return typeof envValue === 'string' && envValue.length > 0 ? envValue : undefined;
}

function parsePositiveInteger(value, fallback) {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStrictPositiveInteger(value, fallback, label) {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

function toRunRelativePath(runDir, value) {
  const relativePath = path.relative(runDir, value);
  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`Native-performance provider output must remain inside --run-dir: ${value}`);
  }
  return toPortablePath(relativePath);
}

/**
 * Resolves the selected provider identity from the runner-owned output path.
 *
 * Generated provider commands write beneath
 * `<runDir>/raw/providers/<providerId>/...`, where `<providerId>` comes from
 * the validated provider manifest `runnerId`.
 *
 * @param {{outPath: string, runDir: string}} options
 * @returns {string}
 */
function resolveProviderId({ outPath, runDir }) {
  const providersDir = path.resolve(runDir, 'raw', 'providers');
  const relativePath = path.relative(providersDir, path.resolve(outPath));
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error('Native-performance provider output must identify a provider beneath <run-dir>/raw/providers/.');
  }

  const segments = relativePath.split(path.sep);
  const providerId = segments.length > 1 ? segments[0] : undefined;
  if (!providerId) {
    throw new Error('Native-performance provider output is missing its provider identity directory.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(providerId)) {
    throw new Error(`Native-performance provider identity "${providerId}" is invalid.`);
  }
  return providerId;
}

function resolvePositionalAction(argv) {
  const firstToken = argv[0];
  if (!firstToken || firstToken.startsWith('--')) {
    return {
      action: 'normalize',
      args: argv,
    };
  }

  return {
    action: firstToken,
    args: argv.slice(1),
  };
}

function isValidProviderId(value) {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function resolveLifecycleProviderId({ args, providerDir }) {
  const configuredProviderId = optionalStringArg(args, 'provider-id', 'ASL_PROVIDER_ID');
  if (configuredProviderId) {
    if (!isValidProviderId(configuredProviderId)) {
      throw new Error(`Native-performance provider identity "${configuredProviderId}" is invalid.`);
    }
    return configuredProviderId;
  }

  const providerId = path.basename(providerDir);
  if (!isValidProviderId(providerId)) {
    throw new Error(`Native-performance provider identity "${providerId}" is invalid.`);
  }
  return providerId;
}

function resolveRequestedAppId(args, platform) {
  const genericAppId = optionalStringArg(args, 'app-id', 'ASL_APP_ID');
  if (genericAppId) {
    return genericAppId;
  }

  if (platform === 'ios') {
    return optionalStringArg(args, 'bundle', 'ASL_IOS_APP_ID');
  }

  return optionalStringArg(args, 'app', 'ASL_ANDROID_APP_ID');
}

function resolveRequestedTargetId(args, platform) {
  const genericTargetId = optionalStringArg(args, 'target-id', 'ASL_TARGET_ID');
  if (genericTargetId) {
    return genericTargetId;
  }

  if (platform === 'ios') {
    return optionalStringArg(args, 'device', 'ASL_IOS_UDID');
  }

  return optionalStringArg(args, 'device', 'ASL_ANDROID_SERIAL');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonArtifactIfAvailable(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function resolveLifecycleProviderDir(args) {
  const providerDir = optionalStringArg(args, 'provider-dir', 'ASL_PROVIDER_DIR');
  if (!providerDir) {
    throw new Error('Native-performance lifecycle actions require --provider-dir or ASL_PROVIDER_DIR.');
  }
  return providerDir;
}

function resolveTargetBindingArtifactPath({ args, providerDir }) {
  return optionalStringArg(args, 'target-binding', 'ASL_NATIVE_TARGET_BINDING') ?? path.join(providerDir, 'target-binding.json');
}

function resolveNativePerformanceRequestPath(args, runDir) {
  const requestPath = optionalStringArg(args, 'request', 'ASL_NATIVE_PERFORMANCE_REQUEST');
  if (!requestPath) {
    return null;
  }
  toRunRelativePath(runDir, requestPath);
  return requestPath;
}

function resolveNativePerformanceRequestSha256(args) {
  return optionalStringArg(args, 'request-sha256', 'ASL_NATIVE_PERFORMANCE_REQUEST_SHA256');
}

function validateNativePerformanceRequest({
  args,
  platform,
  required = false,
  requestedAppId,
  requestedTargetId,
  runDir,
  runId,
  scenarioId,
}) {
  const requestPath = resolveNativePerformanceRequestPath(args, runDir);
  const requestSha256 = resolveNativePerformanceRequestSha256(args);
  if (requestSha256 && !requestPath) {
    throw new Error('Native-performance request sha256 requires a matching request path.');
  }
  if (!requestPath) {
    if (required) {
      throw new Error('Native-performance request is required for native lifecycle capture.');
    }
    return null;
  }
  if (!requestSha256) {
    throw new Error(
      `Native-performance request at ${toRunRelativePath(runDir, requestPath)} requires a matching sha256.`,
    );
  }
  if (sha256File(requestPath) !== requestSha256) {
    throw new Error(
      `Native-performance request hash mismatch at ${toRunRelativePath(runDir, requestPath)}.`,
    );
  }

  const record = readJsonArtifactIfAvailable(requestPath);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Native-performance request is missing or invalid at ${toRunRelativePath(runDir, requestPath)}.`);
  }

  const normalizedPlatform = normalizePlatform(platform);
  if (record.schemaVersion !== '1.0.0') {
    throw new Error(`Native-performance request at ${toRunRelativePath(runDir, requestPath)} must declare schemaVersion "1.0.0".`);
  }
  if (record.platform !== normalizedPlatform) {
    throw new Error(`Native-performance request platform mismatch: expected ${normalizedPlatform}, received ${String(record.platform)}.`);
  }
  if (record.runId !== runId || record.scenarioId !== scenarioId) {
    throw new Error(
      `Native-performance request run identity mismatch: expected ${scenarioId}/${runId}, received ${String(record.scenarioId)}/${String(record.runId)}.`,
    );
  }
  if (record.requestedAppId !== requestedAppId || record.requestedTargetId !== requestedTargetId) {
    throw new Error(
      `Native-performance request target identity mismatch: expected ${requestedAppId}/${requestedTargetId}, received ${String(record.requestedAppId)}/${String(record.requestedTargetId)}.`,
    );
  }
  if (!record.target || typeof record.target !== 'object' || Array.isArray(record.target)) {
    throw new Error(`Native-performance request at ${toRunRelativePath(runDir, requestPath)} is missing its target identity payload.`);
  }
  if (record.target.appId !== requestedAppId || record.target.targetId !== requestedTargetId) {
    throw new Error(
      `Native-performance request target payload does not match expected ${requestedAppId}/${requestedTargetId}.`,
    );
  }
  if (
    normalizedPlatform === 'android' &&
    (
      record.target.packageName !== requestedAppId ||
      record.target.serial !== requestedTargetId
    )
  ) {
    throw new Error(
      `Native-performance request Android target does not match expected ${requestedAppId}/${requestedTargetId}.`,
    );
  }
  if (
    normalizedPlatform === 'ios' &&
    (
      record.target.bundleId !== requestedAppId ||
      record.target.udid !== requestedTargetId
    )
  ) {
    throw new Error(
      `Native-performance request iOS target does not match expected ${requestedAppId}/${requestedTargetId}.`,
    );
  }
  if (
    !record.activeLoopWindow
    || typeof record.activeLoopWindow !== 'object'
    || Array.isArray(record.activeLoopWindow)
    || record.activeLoopWindow.phase !== 'activeLoop'
    || record.activeLoopWindow.status !== 'pending'
    || record.activeLoopWindow.exactMatchRequired !== true
    || record.activeLoopWindow.runnerActiveLoopPath !== RUNNER_ACTIVE_LOOP_WINDOW_RELATIVE_PATH
  ) {
    throw new Error(
      `Native-performance request at ${toRunRelativePath(runDir, requestPath)} must point at the runner-owned activeLoop window policy.`,
    );
  }
  return {
    path: requestPath,
    record,
  };
}

function resolveLifecycleStatePath(providerDir) {
  return path.join(providerDir, 'native-window-session.json');
}

function buildLifecycleWindowRecord(sessionState) {
  const startedAt = typeof sessionState.startedAt === 'string' ? sessionState.startedAt : undefined;
  const endedAt = typeof sessionState.endedAt === 'string' ? sessionState.endedAt : undefined;
  let durationMs;
  if (startedAt && endedAt) {
    const startedMs = Date.parse(startedAt);
    const endedMs = Date.parse(endedAt);
    if (Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs > startedMs) {
      durationMs = endedMs - startedMs;
    }
  }

  return {
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(endedAt ? { endedAt } : {}),
    phase: 'activeLoop',
    ...(startedAt ? { startedAt } : {}),
  };
}

function readRunnerActiveLoopWindowRecord(runDir) {
  const filePath = path.join(runDir, RUNNER_ACTIVE_LOOP_WINDOW_RELATIVE_PATH);
  const record = readJsonArtifactIfAvailable(filePath);
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    record.phase !== 'activeLoop' ||
    typeof record.startedAt !== 'string' ||
    typeof record.endedAt !== 'string' ||
    typeof record.durationMs !== 'number' ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs <= 0
  ) {
    return null;
  }
  return record;
}

function readLifecycleStateRecord(providerDir) {
  const record = readJsonArtifactIfAvailable(resolveLifecycleStatePath(providerDir));
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record
    : null;
}

function readExistingActiveLoopWindowRecord(targetBindingRecord) {
  const windowRecord = (
    targetBindingRecord &&
    typeof targetBindingRecord === 'object' &&
    !Array.isArray(targetBindingRecord) &&
    targetBindingRecord.window &&
    typeof targetBindingRecord.window === 'object' &&
    !Array.isArray(targetBindingRecord.window)
  )
    ? targetBindingRecord.window
    : null;
  return windowRecord && windowRecord.phase === 'activeLoop'
    ? windowRecord
    : null;
}

function resolveTargetBindingWindowRecord({
  existingTargetBinding,
  providerDir,
  runDir,
}) {
  const runnerWindow = readRunnerActiveLoopWindowRecord(runDir);
  if (runnerWindow) {
    return runnerWindow;
  }

  const lifecycleState = readLifecycleStateRecord(providerDir);
  if (lifecycleState) {
    const lifecycleWindow = buildLifecycleWindowRecord(lifecycleState);
    if (typeof lifecycleWindow.startedAt === 'string') {
      return lifecycleWindow;
    }
  }

  return readExistingActiveLoopWindowRecord(existingTargetBinding);
}

function buildLifecycleCommandDefinitions(platform, includeFinalize = false) {
  const android = normalizePlatform(platform) === 'android';
  const definitions = [
    {
      actionArg: 'start-window',
      commandId: android ? 'start-android-native-window' : 'start-native-window',
      phase: 'startWindow',
      sourceId: 'start-window',
    },
    {
      actionArg: 'stop-window',
      commandId: android ? 'stop-android-native-window' : 'stop-native-window',
      phase: 'stopWindow',
      sourceId: 'stop-window',
    },
    { actionArg: 'normalize', commandId: 'capture-native-performance', phase: 'afterCapture', sourceId: 'normalize' },
  ];
  if (includeFinalize) {
    definitions.push({
      actionArg: 'finalize',
      commandId: 'finalize-native-window',
      phase: 'finalize',
      sourceId: 'finalize',
    });
  }
  return definitions;
}

function removeOptionWithValue(args, optionName) {
  const nextArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === optionName) {
      index += 1;
      continue;
    }
    nextArgs.push(value);
  }
  return nextArgs;
}

function setOptionWithValue(args, optionName, optionValue) {
  const nextArgs = removeOptionWithValue(args, optionName);
  nextArgs.push(optionName, optionValue);
  return nextArgs;
}

function buildLifecycleCommandArgs({
  actionArg,
  baseArgs,
  normalizeOutputPath,
}) {
  const commandArgs = Array.isArray(baseArgs) && baseArgs.length > 0
    ? [...baseArgs]
    : [actionArg];
  commandArgs[0] = actionArg;
  const argsWithoutOut = removeOptionWithValue(commandArgs, '--out');
  if (actionArg === 'normalize') {
    return setOptionWithValue(argsWithoutOut, '--out', normalizeOutputPath);
  }
  return argsWithoutOut;
}

function buildLifecycleSourceCommands({
  baseArgs,
  completedCommandIds = new Set(),
  includeFinalize = false,
  normalizeOutputPath,
  providerId,
  platform,
  runDir,
  targetBindingPath,
}) {
  return buildLifecycleCommandDefinitions(platform, includeFinalize).map(({ actionArg, commandId, phase, sourceId }) => {
    const completedRecordRelativePath = `raw/provider-commands/${providerId}-${commandId}.json`;
    const startedRecordRelativePath = `raw/provider-commands/${providerId}-${commandId}.started.json`;
    const completedRecord = readJsonArtifactIfAvailable(path.join(runDir, completedRecordRelativePath));
    const startedRecord = readJsonArtifactIfAvailable(path.join(runDir, startedRecordRelativePath));
    const command = startedRecord && typeof startedRecord.command === 'string'
      ? startedRecord.command
      : path.basename(process.argv[0]);
    const fallbackArgs = buildLifecycleCommandArgs({
      actionArg,
      baseArgs,
      normalizeOutputPath,
    });
    const commandArgs = startedRecord &&
      Array.isArray(startedRecord.args) &&
      startedRecord.args.every((arg) => typeof arg === 'string')
      ? startedRecord.args
      : fallbackArgs;
    const requestPath = typeof startedRecord?.requestPath === 'string'
      ? startedRecord.requestPath
      : typeof completedRecord?.requestPath === 'string'
        ? completedRecord.requestPath
        : undefined;
    const requestSha256 = typeof startedRecord?.requestSha256 === 'string'
      ? startedRecord.requestSha256
      : typeof completedRecord?.requestSha256 === 'string'
        ? completedRecord.requestSha256
        : undefined;
    return {
      args: startedRecord ? [...commandArgs] : commandArgs.map((arg) => normalizeCommandArgForEvidence(runDir, arg)),
      command,
      commandId,
      phase,
      recordPath: completedRecordRelativePath,
      startedRecordPath: startedRecordRelativePath,
      sourceId,
      status: completedCommandIds.has(commandId) ? 'completed' : 'unknown',
      stderrPath: `raw/provider-commands/${providerId}-${commandId}.stderr.txt`,
      stdoutPath: `raw/provider-commands/${providerId}-${commandId}.stdout.txt`,
      ...(typeof completedRecord?.exitCode === 'number' ? { exitCode: completedRecord.exitCode } : {}),
      ...(completedRecord?.signal === null || typeof completedRecord?.signal === 'string'
        ? { signal: completedRecord.signal }
        : {}),
      ...(typeof completedRecord?.stderrSha256 === 'string' ? { stderrSha256: completedRecord.stderrSha256 } : {}),
      ...(typeof completedRecord?.stdoutSha256 === 'string' ? { stdoutSha256: completedRecord.stdoutSha256 } : {}),
      ...(typeof requestPath === 'string' && requestPath.length > 0
        ? { requestPath }
        : {}),
      ...(typeof requestSha256 === 'string' && requestSha256.length > 0
        ? { requestSha256 }
        : {}),
      ...(commandId === 'capture-native-performance' && completedCommandIds.has(commandId)
        ? { outputPath: toRunRelativePath(runDir, targetBindingPath) }
        : {}),
    };
  });
}

function stringArraysEqual(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === 'string' && value === right[index]);
}

function runnerLifecycleStartedRecordMatches({ commandId, phase, providerId, startedRecord }) {
  return Boolean(
    startedRecord &&
    typeof startedRecord === 'object' &&
    !Array.isArray(startedRecord) &&
    startedRecord.providerId === providerId &&
    startedRecord.phase === phase &&
    startedRecord.status === 'started' &&
    typeof startedRecord.command === 'string' &&
    startedRecord.command.length > 0 &&
    Array.isArray(startedRecord.args) &&
    startedRecord.args.every((arg) => typeof arg === 'string') &&
    startedRecord.startedRecordPath === `raw/provider-commands/${providerId}-${commandId}.started.json` &&
    startedRecord.stdoutPath === `raw/provider-commands/${providerId}-${commandId}.stdout.txt` &&
    startedRecord.stderrPath === `raw/provider-commands/${providerId}-${commandId}.stderr.txt`,
  );
}

function runnerLifecycleCompletedRecordMatches({ commandId, completedRecord, phase, providerId, startedRecord }) {
  return runnerLifecycleStartedRecordMatches({ commandId, phase, providerId, startedRecord }) && Boolean(
    completedRecord &&
    typeof completedRecord === 'object' &&
    !Array.isArray(completedRecord) &&
    completedRecord.providerId === providerId &&
    completedRecord.phase === phase &&
    completedRecord.status === 'completed' &&
    completedRecord.exitCode === 0 &&
    completedRecord.timedOut === false &&
    completedRecord.signal === null &&
    completedRecord.command === startedRecord.command &&
    stringArraysEqual(completedRecord.args, startedRecord.args) &&
    completedRecord.startedRecordPath === startedRecord.startedRecordPath &&
    completedRecord.stdoutPath === startedRecord.stdoutPath &&
    completedRecord.stderrPath === startedRecord.stderrPath &&
    completedRecord.requestPath === startedRecord.requestPath &&
    completedRecord.requestSha256 === startedRecord.requestSha256,
  );
}

function buildLifecycleSourceCommandUpdates({
  baseArgs,
  commandIds,
  includeFinalize = false,
  normalizeOutputPath,
  providerId,
  platform,
  runDir,
  targetBindingPath,
}) {
  const commandIdSet = new Set(commandIds);
  return buildLifecycleSourceCommands({
    baseArgs,
    completedCommandIds: commandIdSet,
    includeFinalize,
    normalizeOutputPath,
    providerId,
    platform,
    runDir,
    targetBindingPath,
  }).filter((command) => commandIdSet.has(command.commandId));
}

function targetBindingSourceCommandKey(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return null;
  }
  if (typeof command.commandId === 'string' && command.commandId.length > 0) {
    return `command:${command.commandId}`;
  }
  if (typeof command.sourceId === 'string' && command.sourceId.length > 0) {
    return `source:${command.sourceId}`;
  }
  return null;
}

function mergeTargetBindingSourceCommands(...commandSets) {
  const mergedCommands = new Map();
  for (const commandSet of commandSets) {
    if (!Array.isArray(commandSet)) {
      continue;
    }
    for (const command of commandSet) {
      const key = targetBindingSourceCommandKey(command);
      if (!key) {
        continue;
      }
      mergedCommands.set(key, {
        ...(mergedCommands.get(key) ?? {}),
        ...command,
      });
    }
  }
  return Array.from(mergedCommands.values());
}

function readTargetBindingSourceCommands(record) {
  return record && typeof record === 'object' && !Array.isArray(record) && Array.isArray(record.sourceCommands)
    ? record.sourceCommands
    : [];
}

function hasLifecycleSourceCommands(commands) {
  return commands.some((command) => (
    command && typeof command === 'object' && !Array.isArray(command) && (
      command.commandId === 'start-native-window'
      || command.commandId === 'start-android-native-window'
      || command.commandId === 'stop-native-window'
      || command.commandId === 'stop-android-native-window'
      || command.commandId === 'capture-native-performance'
      || command.commandId === 'finalize-native-window'
    )
  ));
}

function readRecordedLifecycleCommandCompletion({
  includeFinalize = false,
  platform,
  providerId,
  runDir,
}) {
  const completedCommandIds = new Set();
  let hasRecordedLifecycleCommand = false;

  for (const { commandId, phase } of buildLifecycleCommandDefinitions(platform, includeFinalize)) {
    const startedRecord = readJsonArtifactIfAvailable(path.join(runDir, `raw/provider-commands/${providerId}-${commandId}.started.json`));
    if (startedRecord) {
      hasRecordedLifecycleCommand = true;
    }

    const completedRecord = readJsonArtifactIfAvailable(path.join(runDir, `raw/provider-commands/${providerId}-${commandId}.json`));
    if (completedRecord) {
      hasRecordedLifecycleCommand = true;
      if (runnerLifecycleCompletedRecordMatches({
        commandId,
        completedRecord,
        phase,
        providerId,
        startedRecord,
      })) {
        completedCommandIds.add(commandId);
      }
    }

    if (
      commandId === 'capture-native-performance' &&
      runnerLifecycleStartedRecordMatches({ commandId, phase, providerId, startedRecord })
    ) {
      completedCommandIds.add(commandId);
    }
  }

  return {
    completedCommandIds,
    hasRecordedLifecycleCommand,
  };
}

function buildLifecycleCompletedCommandIdsFromState({
  includeCaptureCommand = false,
  includeFinalize = false,
  lifecycleState,
  platform,
}) {
  const completedCommandIds = new Set();
  if (!lifecycleState || typeof lifecycleState !== 'object' || Array.isArray(lifecycleState)) {
    return completedCommandIds;
  }

  const android = normalizePlatform(platform) === 'android';
  if (typeof lifecycleState.startedAt === 'string') {
    completedCommandIds.add(android ? 'start-android-native-window' : 'start-native-window');
  }
  if (typeof lifecycleState.endedAt === 'string') {
    completedCommandIds.add(android ? 'stop-android-native-window' : 'stop-native-window');
  }
  if (includeCaptureCommand) {
    completedCommandIds.add('capture-native-performance');
  }
  if (includeFinalize && typeof lifecycleState.finalizedAt === 'string') {
    completedCommandIds.add('finalize-native-window');
  }
  return completedCommandIds;
}

function buildLifecycleSourceCommandsForTargetBinding({
  baseArgs,
  includeCaptureCommand = false,
  includeFinalize = false,
  normalizeOutputPath,
  providerDir,
  providerId,
  platform,
  runDir,
  targetBindingPath,
}) {
  const lifecycleState = readLifecycleStateRecord(providerDir);
  const recordedCompletion = readRecordedLifecycleCommandCompletion({
    includeFinalize,
    platform,
    providerId,
    runDir,
  });
  const fallbackCompletedCommandIds = buildLifecycleCompletedCommandIdsFromState({
    includeCaptureCommand,
    includeFinalize,
    lifecycleState,
    platform,
  });
  const hasLifecycleContext = recordedCompletion.hasRecordedLifecycleCommand || fallbackCompletedCommandIds.size > 0;
  if (!hasLifecycleContext) {
    return [];
  }

  const completedCommandIds = recordedCompletion.hasRecordedLifecycleCommand
    ? recordedCompletion.completedCommandIds
    : fallbackCompletedCommandIds;

  return buildLifecycleSourceCommands({
    baseArgs,
    completedCommandIds,
    includeFinalize,
    normalizeOutputPath,
    providerId,
    platform,
    runDir,
    targetBindingPath,
  });
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const maxBufferBytes = 8 * 1024 * 1024;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let terminationRequested = false;
    let errorCode = null;
    let errorMessage = null;
    let forceKillTimer = null;
    let forceSettleTimer = null;
    const child = spawn(command, args, {
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function killChildTree(signal) {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child when the process group is already gone.
        }
      }
      child.kill(signal);
    }

    function finish(exitCode, signal) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
      }
      resolve({
        args,
        command,
        errorCode,
        errorMessage,
        exitCode: timedOut ? 124 : exitCode,
        signal,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        timedOut,
      });
    }

    function terminate() {
      if (terminationRequested) {
        return;
      }
      terminationRequested = true;
      killChildTree('SIGTERM');
      forceKillTimer = setTimeout(() => {
        killChildTree('SIGKILL');
        forceSettleTimer = setTimeout(() => {
          finish(timedOut ? 124 : 1, 'SIGKILL');
        }, 100);
        forceSettleTimer.unref();
      }, 1_000);
      forceKillTimer.unref();
    }

    function captureChunk(chunks, byteCount, chunk, streamName) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = Math.max(maxBufferBytes - byteCount, 0);
      if (remainingBytes > 0) {
        chunks.push(buffer.subarray(0, remainingBytes));
      }
      const nextByteCount = byteCount + buffer.length;
      if (nextByteCount > maxBufferBytes && !errorCode) {
        errorCode = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        errorMessage = `${streamName} exceeded the ${maxBufferBytes} byte provider command buffer.`;
        terminate();
      }
      return nextByteCount;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes = captureChunk(stdoutChunks, stdoutBytes, chunk, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = captureChunk(stderrChunks, stderrBytes, chunk, 'stderr');
    });
    child.on('error', (error) => {
      errorCode = error.code ?? 'UNKNOWN';
      errorMessage = error.message;
      finish(1, error.signal ?? null);
    });
    child.on('close', (exitCode, signal) => {
      const normalizedExitCode = typeof exitCode === 'number' ? exitCode : 1;
      finish(normalizedExitCode, signal);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
  });
}

function commandSucceeded(result) {
  return !result.timedOut && !result.errorCode && result.exitCode === 0;
}

const IOS_XCTRACE_SESSION_START_TIMEOUT_MS = 2_000;
const IOS_XCTRACE_SESSION_STOP_TIMEOUT_MS = 30_000;
const IOS_XCTRACE_SESSION_FORCE_KILL_WAIT_MS = 1_000;
const IOS_XCTRACE_SESSION_STREAM_LIMIT_BYTES = 256 * 1024;
const IOS_XCTRACE_SESSION_STREAM_TRUNCATED_MARKER = '\n[output truncated at 262144 bytes]';

function appendBoundedSessionOutput(current, chunk) {
  if (Buffer.byteLength(current) >= IOS_XCTRACE_SESSION_STREAM_LIMIT_BYTES) {
    return current.endsWith(IOS_XCTRACE_SESSION_STREAM_TRUNCATED_MARKER)
      ? current
      : current + IOS_XCTRACE_SESSION_STREAM_TRUNCATED_MARKER;
  }
  const remainingBytes = IOS_XCTRACE_SESSION_STREAM_LIMIT_BYTES - Buffer.byteLength(current);
  const next = Buffer.from(chunk);
  if (next.byteLength <= remainingBytes) {
    return current + next.toString('utf8');
  }
  return current + next.subarray(0, remainingBytes).toString('utf8') + IOS_XCTRACE_SESSION_STREAM_TRUNCATED_MARKER;
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCondition({
  check,
  pollMs = 25,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

function readJsonArtifactIfExists(filePath) {
  const record = readJsonArtifactIfAvailable(filePath);
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record
    : null;
}

function resolveIosXctraceCaptureContext({
  args,
  outPath,
  providerId,
  requireRequest,
  runId,
  scenarioId,
}) {
  const bundleId = resolveRequestedAppId(args, 'ios');
  const deviceId = resolveRequestedTargetId(args, 'ios');
  if (!bundleId || !deviceId) {
    throw new Error('iOS xctrace capture requires --app-id or --bundle plus --target-id or --device.');
  }

  const xcrunPath = optionalStringArg(args, 'xcrun', 'ASL_XCRUN_PATH') ?? 'xcrun';
  const runDir = optionalStringArg(args, 'run-dir', 'ASL_RUN_DIR');
  if (!runDir) {
    throw new Error('iOS xctrace capture requires --run-dir so evidence paths can remain durable and run-relative.');
  }
  validateNativePerformanceRequest({
    args,
    platform: 'ios',
    required: requireRequest,
    requestedAppId: bundleId,
    requestedTargetId: deviceId,
    runDir,
    runId,
    scenarioId,
  });
  toRunRelativePath(runDir, outPath);

  const xctraceTemplate = optionalStringArg(args, 'ios-xctrace-template', 'ASL_NATIVE_PERFORMANCE_IOS_XCTRACE_TEMPLATE') ?? 'Time Profiler';
  const commandTimeoutMs = parseStrictPositiveInteger(
    optionalStringArg(args, 'ios-command-timeout-ms', 'ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS'),
    IOS_XCTRACE_SESSION_STOP_TIMEOUT_MS,
    '--ios-command-timeout-ms/ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS',
  );
  const captureDir = path.join(path.dirname(outPath), 'ios-xctrace');
  const traceBundlePath = path.join(captureDir, 'capture.trace');
  const tocPath = path.join(captureDir, 'xctrace-toc.xml');
  const traceInventoryPath = path.join(captureDir, 'trace-bundle-inventory.json');
  const sessionStatusPath = path.join(captureDir, 'xctrace-session.json');
  const startWindowCommandPath = path.join(captureDir, 'start-window.command.json');
  const stopWindowCommandPath = path.join(captureDir, 'stop-window.command.json');
  const recordStdoutPath = path.join(captureDir, 'xctrace-record.stdout.txt');
  const recordStderrPath = path.join(captureDir, 'xctrace-record.stderr.txt');

  return {
    bundleId,
    captureDir,
    commandTimeoutMs,
    deviceId,
    providerId,
    recordStderrPath,
    recordStdoutPath,
    runDir,
    sessionStatusPath,
    startWindowCommandPath,
    stopWindowCommandPath,
    tocPath,
    traceBundlePath,
    traceInventoryPath,
    xcrunPath,
    xctraceTemplate,
  };
}

function buildIosXctraceStartWindowDefinitions({ bundleId, deviceId }) {
  return [
    { id: 'simctl-list-devices', args: ['simctl', 'list', 'devices', '--json'], phase: 'startWindow' },
    { id: 'simctl-get-app-container', args: ['simctl', 'get_app_container', deviceId, bundleId, 'app'], phase: 'startWindow' },
    { id: 'simctl-launchctl-list', args: ['simctl', 'spawn', deviceId, 'launchctl', 'list'], phase: 'startWindow' },
  ];
}

function buildIosXctraceStopWindowDefinitions(context) {
  return [
    {
      id: 'xctrace-record',
      args: [
        'xctrace',
        'record',
        '--template',
        context.xctraceTemplate,
        '--device',
        context.deviceId,
        '--attach',
        '<pid>',
        '--output',
        context.traceBundlePath,
        '--no-prompt',
      ],
      phase: 'startWindow',
    },
    { id: 'xctrace-export-toc', args: ['xctrace', 'export', '--input', context.traceBundlePath, '--toc'], phase: 'stopWindow' },
  ];
}

async function startManagedIosXctraceWindow(context) {
  fs.rmSync(context.captureDir, { force: true, recursive: true });
  fs.mkdirSync(context.captureDir, { recursive: true });

  const captures = new Map();
  for (const definition of buildIosXctraceStartWindowDefinitions(context)) {
    const result = await runCommand(context.xcrunPath, definition.args, context.commandTimeoutMs);
    captures.set(definition.id, {
      result,
      paths: writeCommandArtifacts({
        captureDir: context.captureDir,
        id: definition.id,
        phase: definition.phase,
        providerId: context.providerId,
        result,
        runDir: context.runDir,
      }),
    });
  }

  const bootedDeviceCapture = captures.get('simctl-list-devices').result;
  const appContainerCapture = captures.get('simctl-get-app-container').result;
  const launchctlCapture = captures.get('simctl-launchctl-list').result;
  const bootedDeviceObservation = commandSucceeded(bootedDeviceCapture)
    ? readBootedDeviceObservation(bootedDeviceCapture.stdout, context.deviceId)
    : { status: 'failed' };
  const appContainerAvailable = commandSucceeded(appContainerCapture) && appContainerCapture.stdout.trim().length > 0;
  const launchctlProcess = commandSucceeded(launchctlCapture)
    ? readLaunchctlProcessObservation(launchctlCapture.stdout, context.bundleId)
    : { status: 'failed' };
  const requestedPid = launchctlProcess.status === 'observed' ? launchctlProcess.pid : 0;
  if (
    bootedDeviceObservation.status !== 'observed' ||
    bootedDeviceObservation.matchesRequestedDevice !== true ||
    !appContainerAvailable ||
    launchctlProcess.status !== 'observed' ||
    requestedPid <= 0
  ) {
    return false;
  }

  const helperArgs = [
    process.argv[1],
    '__internal-ios-xctrace-session',
    '--xcrun', context.xcrunPath,
    '--device', context.deviceId,
    '--bundle', context.bundleId,
    '--pid', String(requestedPid),
    '--template', context.xctraceTemplate,
    '--trace-bundle', context.traceBundlePath,
    '--stdout-path', context.recordStdoutPath,
    '--stderr-path', context.recordStderrPath,
    '--status-path', context.sessionStatusPath,
    '--stop-timeout-ms', String(context.commandTimeoutMs),
  ];
  const child = spawn(process.execPath, helperArgs, {
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();

  const startedStatus = await waitForCondition({
    timeoutMs: IOS_XCTRACE_SESSION_START_TIMEOUT_MS,
    check: async () => {
      const status = readJsonArtifactIfExists(context.sessionStatusPath);
      return status?.status === 'started' ? status : null;
    },
  });
  if (!startedStatus || !isProcessAlive(startedStatus.helperPid)) {
    return false;
  }

  writeJsonArtifact(context.startWindowCommandPath, {
    args: helperArgs.slice(2),
    bundleId: context.bundleId,
    command: process.execPath,
    helperPid: startedStatus.helperPid,
    pid: requestedPid,
    providerId: context.providerId,
    startedAt: startedStatus.startedAt,
    status: 'started',
    traceBundlePath: toRunRelativePath(context.runDir, context.traceBundlePath),
    xcrun: context.xcrunPath,
  });
  return true;
}

function signalProcess(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopManagedIosXctraceWindow(context) {
  const sessionStatus = readJsonArtifactIfExists(context.sessionStatusPath);
  const helperPid = Number.isSafeInteger(sessionStatus?.helperPid) ? sessionStatus.helperPid : 0;
  if (helperPid > 0) {
    signalProcess(helperPid, 'SIGINT');
  }

  const completedStatus = await waitForCondition({
    timeoutMs: context.commandTimeoutMs + IOS_XCTRACE_SESSION_FORCE_KILL_WAIT_MS,
    check: async () => {
      const status = readJsonArtifactIfExists(context.sessionStatusPath);
      return status?.status === 'completed' ? status : null;
    },
  });
  if (!completedStatus) {
    return false;
  }

  writeJsonArtifact(path.join(context.captureDir, 'xctrace-record.command.json'), {
    args: Array.isArray(completedStatus.args)
      ? completedStatus.args.map((arg) => normalizeCommandArgForEvidence(context.runDir, arg))
      : [],
    command: typeof completedStatus.command === 'string'
      ? path.basename(completedStatus.command)
      : path.basename(context.xcrunPath),
    endedAt: completedStatus.endedAt,
    errorCode: completedStatus.errorCode ?? null,
    errorMessage: completedStatus.errorMessage ?? null,
    exitCode: completedStatus.exitCode,
    phase: 'startWindow',
    providerId: context.providerId,
    startedAt: completedStatus.startedAt,
    status: completedStatus.exitCode === 0 && completedStatus.timedOut !== true ? 'completed' : 'failed',
    stderrPath: toRunRelativePath(context.runDir, context.recordStderrPath),
    stderrSha256: sha256File(context.recordStderrPath),
    stdoutPath: toRunRelativePath(context.runDir, context.recordStdoutPath),
    stdoutSha256: sha256File(context.recordStdoutPath),
    timedOut: completedStatus.timedOut === true,
    ...(typeof completedStatus.signal === 'string' ? { signal: completedStatus.signal } : {}),
  });

  const exportArgs = ['xctrace', 'export', '--input', context.traceBundlePath, '--toc'];
  const exportResult = await runCommand(context.xcrunPath, exportArgs, context.commandTimeoutMs);
  writeCommandArtifacts({
    captureDir: context.captureDir,
    id: 'xctrace-export-toc',
    phase: 'stopWindow',
    providerId: context.providerId,
    result: exportResult,
    runDir: context.runDir,
  });
  writeTextArtifact(context.tocPath, exportResult.stdout);
  writeJsonArtifact(context.traceInventoryPath, {
    ...buildTraceBundleInventory(context.traceBundlePath),
    traceBundlePath: toRunRelativePath(context.runDir, context.traceBundlePath),
  });
  writeJsonArtifact(context.stopWindowCommandPath, {
    endedAt: completedStatus.endedAt,
    exitCode: completedStatus.exitCode,
    providerId: context.providerId,
    signal: completedStatus.signal,
    status: completedStatus.exitCode === 0 && completedStatus.timedOut !== true ? 'completed' : 'failed',
    timedOut: completedStatus.timedOut === true,
    traceBundlePath: toRunRelativePath(context.runDir, context.traceBundlePath),
  });
  return completedStatus.exitCode === 0 && completedStatus.timedOut !== true && commandSucceeded(exportResult);
}

function readPreservedIosCommandCapture({ captureDir, id, phase, providerId, runDir }) {
  const stdoutPath = path.join(captureDir, `${id}.stdout.txt`);
  const stderrPath = path.join(captureDir, `${id}.stderr.txt`);
  const recordPath = path.join(captureDir, `${id}.command.json`);
  const record = readJsonArtifactIfAvailable(recordPath);
  if (!record || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) {
    return null;
  }
  const result = {
    args: Array.isArray(record.args) && record.args.every((arg) => typeof arg === 'string') ? record.args : [],
    command: typeof record.command === 'string' ? record.command : '',
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : null,
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : null,
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : 1,
    signal: record.signal === null || typeof record.signal === 'string' ? record.signal : null,
    stderr: fs.readFileSync(stderrPath, 'utf8'),
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    timedOut: record.timedOut === true,
  };
  if (
    record.providerId !== providerId ||
    record.phase !== phase ||
    record.stdoutPath !== toRunRelativePath(runDir, stdoutPath) ||
    record.stderrPath !== toRunRelativePath(runDir, stderrPath)
  ) {
    return null;
  }
  return {
    result,
    paths: {
      recordPath,
      stderrPath,
      stderrSha256: sha256File(stderrPath),
      stdoutPath,
      stdoutSha256: sha256File(stdoutPath),
    },
  };
}

function readTrustedIosStopOutputs({ context }) {
  const commandId = 'stop-native-window';
  const completedRecord = readJsonArtifactIfAvailable(
    path.join(context.runDir, `raw/provider-commands/${context.providerId}-${commandId}.json`),
  );
  const startedRecord = readJsonArtifactIfAvailable(
    path.join(context.runDir, `raw/provider-commands/${context.providerId}-${commandId}.started.json`),
  );
  if (!runnerLifecycleCompletedRecordMatches({
    commandId,
    completedRecord,
    phase: 'stopWindow',
    providerId: context.providerId,
    startedRecord,
  }) || !providerCommandOutputsEqual(startedRecord.outputs, completedRecord.outputs)) {
    return new Set();
  }

  const expectedOutputs = new Map([
    [toRunRelativePath(context.runDir, context.tocPath), 'logs'],
    [toRunRelativePath(context.runDir, context.traceInventoryPath), 'signals'],
  ]);
  if (completedRecord.outputs.length !== expectedOutputs.size) {
    return new Set();
  }

  const trustedPaths = new Set();
  for (const output of completedRecord.outputs) {
    const expectedKind = expectedOutputs.get(output.runRelativePath);
    if (
      output.channel !== 'provider' ||
      output.kind !== expectedKind ||
      output.status !== 'captured' ||
      output.stale !== false ||
      !expectedKind
    ) {
      return new Set();
    }
    const outputPath = path.join(context.runDir, output.runRelativePath);
    if (!fs.existsSync(outputPath) || (fs.statSync(outputPath).isFile() && output.sha256 !== sha256File(outputPath))) {
      return new Set();
    }
    trustedPaths.add(output.runRelativePath);
  }
  return trustedPaths.size === expectedOutputs.size ? trustedPaths : new Set();
}

async function runInternalIosXctraceSession(args) {
  const xcrunPath = requireStringArg(args, 'xcrun');
  const deviceId = requireStringArg(args, 'device');
  const bundleId = requireStringArg(args, 'bundle');
  const pid = requireStringArg(args, 'pid');
  const xctraceTemplate = requireStringArg(args, 'template');
  const traceBundlePath = requireStringArg(args, 'trace-bundle');
  const stdoutPath = requireStringArg(args, 'stdout-path');
  const stderrPath = requireStringArg(args, 'stderr-path');
  const statusPath = requireStringArg(args, 'status-path');
  const stopTimeoutMs = parseStrictPositiveInteger(
    optionalStringArg(args, 'stop-timeout-ms', 'ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS'),
    IOS_XCTRACE_SESSION_STOP_TIMEOUT_MS,
    '--stop-timeout-ms/ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS',
  );
  fs.rmSync(traceBundlePath, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(traceBundlePath), { recursive: true });

  const recordArgs = [
    'xctrace',
    'record',
    '--template',
    xctraceTemplate,
    '--device',
    deviceId,
    '--attach',
    pid,
    '--output',
    traceBundlePath,
    '--no-prompt',
  ];
  const child = spawn(xcrunPath, recordArgs, {
    detached: false,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const startedAt = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timedOut = false;
  let exitCode = 1;
  let exitSignal = null;
  let errorCode = null;
  let errorMessage = null;
  let closeResolver;
  const closePromise = new Promise((resolve) => {
    closeResolver = resolve;
  });

  child.stdout?.on('data', (chunk) => {
    stdout = appendBoundedSessionOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendBoundedSessionOutput(stderr, chunk);
  });

  const writeStatus = (status, overrides = {}) => {
    writeJsonArtifact(statusPath, {
      args: recordArgs,
      bundleId,
      command: xcrunPath,
      deviceId,
      helperPid: process.pid,
      pid,
      startedAt,
      status,
      stderrPath,
      stdoutPath,
      traceBundlePath,
      ...overrides,
    });
  };
  writeStatus('started', {
    childPid: child.pid ?? null,
    template: xctraceTemplate,
  });

  const finalize = (overrides = {}) => {
    if (settled) {
      return;
    }
    settled = true;
    writeTextArtifact(stdoutPath, stdout);
    writeTextArtifact(stderrPath, stderr);
    writeStatus('completed', {
      endedAt: new Date().toISOString(),
      errorCode,
      errorMessage,
      exitCode,
      signal: exitSignal,
      stderrSha256: sha256File(stderrPath),
      stdoutSha256: sha256File(stdoutPath),
      timedOut,
      ...overrides,
    });
    closeResolver();
  };

  const signalChild = (signal) => {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  };

  const waitForChild = async (timeoutMs) => Promise.race([
    closePromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

  const stopChild = async () => {
    if (settled) {
      return;
    }
    signalChild('SIGINT');
    let exited = await waitForChild(stopTimeoutMs);
    if (!exited) {
      signalChild('SIGTERM');
      exited = await waitForChild(IOS_XCTRACE_SESSION_FORCE_KILL_WAIT_MS);
    }
    if (!exited) {
      timedOut = true;
      signalChild('SIGKILL');
      await waitForChild(IOS_XCTRACE_SESSION_FORCE_KILL_WAIT_MS);
    }
    if (!settled) {
      exitCode = timedOut ? 124 : 1;
      exitSignal = timedOut ? 'SIGKILL' : 'SIGTERM';
      finalize();
    }
  };

  process.on('SIGINT', () => {
    void stopChild();
  });
  process.on('SIGTERM', () => {
    void stopChild();
  });
  child.on('error', (error) => {
    errorCode = error.code ?? 'UNKNOWN';
    errorMessage = error.message;
    exitCode = 1;
    exitSignal = null;
    finalize();
  });
  child.on('close', (code, signal) => {
    exitCode = typeof code === 'number' ? code : 1;
    exitSignal = signal;
    finalize();
  });

  await closePromise;
}

function commandStatus(result) {
  if (result.timedOut) {
    return 'timeout';
  }
  if (!commandSucceeded(result)) {
    return 'failed';
  }
  return result.stdout.trim().length > 0 ? 'captured' : 'partial';
}

function commandRecordStatus(result) {
  if (result.timedOut) {
    return 'timeout';
  }
  if (!commandSucceeded(result)) {
    return 'failed';
  }
  return result.stdout.trim().length > 0 ? 'completed' : 'partial';
}

function writeTextArtifact(outPath, value) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, value, 'utf8');
}

function writeCommandArtifacts({ captureDir, id, phase, providerId, result, runDir }) {
  const stdoutPath = path.join(captureDir, `${id}.stdout.txt`);
  const stderrPath = path.join(captureDir, `${id}.stderr.txt`);
  const recordPath = path.join(captureDir, `${id}.command.json`);
  const normalizedStdoutPath = runDir ? toRunRelativePath(runDir, stdoutPath) : path.basename(stdoutPath);
  const normalizedStderrPath = runDir ? toRunRelativePath(runDir, stderrPath) : path.basename(stderrPath);
  writeTextArtifact(stdoutPath, result.stdout);
  writeTextArtifact(stderrPath, result.stderr);
  const stdoutSha256 = sha256File(stdoutPath);
  const stderrSha256 = sha256File(stderrPath);
  const commandRecord = {
    args: runDir
      ? result.args.map((arg) => normalizeCommandArgForEvidence(runDir, arg))
      : result.args,
    command: runDir ? path.basename(result.command) : result.command,
    exitCode: result.exitCode,
    ...(phase ? { phase } : {}),
    ...(providerId ? { providerId } : {}),
    status: commandRecordStatus(result),
    stderrPath: normalizedStderrPath,
    stderrSha256,
    stdoutPath: normalizedStdoutPath,
    stdoutSha256,
    timedOut: result.timedOut,
  };
  if (typeof result.errorCode === 'string') {
    commandRecord.errorCode = result.errorCode;
  }
  if (typeof result.errorMessage === 'string') {
    commandRecord.errorMessage = result.errorMessage;
  }
  if (typeof result.signal === 'string') {
    commandRecord.signal = result.signal;
  }
  writeJsonArtifact(recordPath, commandRecord);
  return {
    recordPath,
    stderrPath,
    stderrSha256,
    stdoutPath,
    stdoutSha256,
  };
}

function buildTargetBindingSourceCommand({
  capture,
  outputPath,
  phase,
  runDir,
  sourceId,
}) {
  const status = commandStatus(capture.result);
  const commandEntry = {
    args: capture.result.args.map((arg) => normalizeCommandArgForEvidence(runDir, arg)),
    command: path.basename(capture.result.command),
    phase,
    recordPath: toRunRelativePath(runDir, capture.paths.recordPath),
    sourceId,
    startedRecordPath: undefined,
    status: commandRecordStatus(capture.result),
    stderrPath: toRunRelativePath(runDir, capture.paths.stderrPath),
    stderrSha256: capture.paths.stderrSha256,
    stdoutPath: toRunRelativePath(runDir, capture.paths.stdoutPath),
    stdoutSha256: capture.paths.stdoutSha256,
    ...(capture.result.exitCode !== undefined ? { exitCode: capture.result.exitCode } : {}),
    ...(capture.result.signal !== undefined ? { signal: capture.result.signal } : {}),
  };

  if (!outputPath || !fs.existsSync(outputPath) || !fs.statSync(outputPath).isFile()) {
    return commandEntry;
  }

  return {
    ...commandEntry,
    outputPath: toRunRelativePath(runDir, outputPath),
    outputSha256: sha256File(outputPath),
  };
}

function buildCapturedSource({ dataClasses, id, result, runDir, stdoutPath, toolName }) {
  const status = commandStatus(result);
  let reason;
  if (result.timedOut) {
    reason = 'The provider command exceeded its bounded timeout.';
  } else if (!commandSucceeded(result)) {
    reason = result.errorMessage
      ? `The provider command failed: ${result.errorMessage}`
      : `The provider command exited with status ${result.exitCode}.`;
  } else {
    reason = 'The provider command exited successfully but produced no stdout evidence.';
  }
  return {
    sourceId: id,
    status,
    tool: {
      name: toolName,
      command: ['adb', ...result.args].join(' '),
    },
    dataClasses,
    path: toRunRelativePath(runDir, stdoutPath),
    ...(status === 'captured'
      ? {}
      : {
          reason,
          nextAction: `Inspect the preserved command record and stderr, repair ${toolName}, then rerun the provider capture.`,
        }),
  };
}

function resolveAndroidAdbCaptureContext({ args, outPath, providerId, requireRequest, runId, scenarioId }) {
  const appId = resolveRequestedAppId(args, 'android');
  const deviceId = resolveRequestedTargetId(args, 'android');
  if (!appId || !deviceId) {
    throw new Error('Android adb capture requires --app-id or --app plus --target-id or --device.');
  }

  const adbPath = optionalStringArg(args, 'adb', 'ASL_ADB_PATH') ?? 'adb';
  const runDir = optionalStringArg(args, 'run-dir', 'ASL_RUN_DIR');
  if (!runDir) {
    throw new Error('Android adb capture requires --run-dir so evidence paths can remain durable and run-relative.');
  }
  validateNativePerformanceRequest({
    args,
    platform: 'android',
    required: requireRequest,
    requestedAppId: appId,
    requestedTargetId: deviceId,
    runDir,
    runId,
    scenarioId,
  });
  toRunRelativePath(runDir, outPath);
  const timeoutMs = parsePositiveInteger(
    optionalStringArg(args, 'command-timeout-ms', 'ASL_NATIVE_PERFORMANCE_COMMAND_TIMEOUT_MS'),
    10_000,
  );
  const captureDir = path.join(path.dirname(outPath), 'android-adb');
  fs.mkdirSync(captureDir, { recursive: true });

  return {
    adbPath,
    appId,
    captureDir,
    deviceId,
    providerId,
    runDir,
    timeoutMs,
  };
}

function buildAndroidAdbStopWindowDefinitions({ appId, deviceId }) {
  return [
    { id: 'target-serial', args: ['-s', deviceId, 'get-serialno'], phase: 'stopWindow' },
    { id: 'target-package', args: ['-s', deviceId, 'shell', 'pm', 'path', appId], phase: 'stopWindow' },
    { id: 'target-process', args: ['-s', deviceId, 'shell', 'pidof', appId], phase: 'stopWindow' },
    { id: 'gfxinfo', args: ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', appId], phase: 'stopWindow' },
    { id: 'framestats', args: ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', appId, 'framestats'], phase: 'stopWindow' },
    { id: 'meminfo', args: ['-s', deviceId, 'shell', 'dumpsys', 'meminfo', appId], phase: 'stopWindow' },
  ];
}

async function resetAndroidAdbWindow(context) {
  fs.rmSync(context.captureDir, { force: true, recursive: true });
  fs.mkdirSync(context.captureDir, { recursive: true });
  const result = await runCommand(
    context.adbPath,
    ['-s', context.deviceId, 'shell', 'dumpsys', 'gfxinfo', context.appId, 'reset'],
    context.timeoutMs,
  );
  writeCommandArtifacts({
    captureDir: context.captureDir,
    id: 'gfxinfo-reset',
    phase: 'startWindow',
    providerId: context.providerId,
    result,
    runDir: context.runDir,
  });
  return commandSucceeded(result);
}

async function captureAndroidAdbWindow(context) {
  let succeeded = true;
  for (const definition of buildAndroidAdbStopWindowDefinitions(context)) {
    const result = await runCommand(context.adbPath, definition.args, context.timeoutMs);
    writeCommandArtifacts({
      captureDir: context.captureDir,
      id: definition.id,
      phase: definition.phase,
      providerId: context.providerId,
      result,
      runDir: context.runDir,
    });
    if (!commandSucceeded(result) || result.stdout.length === 0) {
      succeeded = false;
    }
  }
  return succeeded;
}

function readPreservedAndroidAdbCapture({ context, definition }) {
  const recordPath = path.join(context.captureDir, `${definition.id}.command.json`);
  const stdoutPath = path.join(context.captureDir, `${definition.id}.stdout.txt`);
  const stderrPath = path.join(context.captureDir, `${definition.id}.stderr.txt`);
  const record = readJsonArtifactIfAvailable(recordPath);
  if (!record || !fs.existsSync(stdoutPath) || !fs.existsSync(stderrPath)) {
    return null;
  }

  const expectedArgs = definition.args.map((arg) => normalizeCommandArgForEvidence(context.runDir, arg));
  const stdoutSha256 = sha256File(stdoutPath);
  const stderrSha256 = sha256File(stderrPath);
  const recordedResult = {
    args: Array.isArray(record.args) && record.args.every((arg) => typeof arg === 'string') ? record.args : [],
    command: typeof record.command === 'string' ? record.command : path.basename(context.adbPath),
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : null,
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : null,
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : 1,
    signal: typeof record.signal === 'string' ? record.signal : null,
    stderr: fs.readFileSync(stderrPath, 'utf8'),
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    timedOut: record.timedOut === true,
  };
  const metadataMatches = (
    record.providerId === context.providerId &&
    record.phase === definition.phase &&
    record.command === path.basename(context.adbPath) &&
    stringArraysEqual(recordedResult.args, expectedArgs) &&
    record.stdoutPath === toRunRelativePath(context.runDir, stdoutPath) &&
    record.stderrPath === toRunRelativePath(context.runDir, stderrPath) &&
    record.stdoutSha256 === stdoutSha256 &&
    record.stderrSha256 === stderrSha256 &&
    record.status === commandRecordStatus(recordedResult)
  );
  if (!metadataMatches) {
    recordedResult.errorCode = 'ERR_CAPTURE_SOURCE_PROVENANCE_MISMATCH';
    recordedResult.errorMessage = `The preserved ${definition.id} bytes do not match their stopWindow command record.`;
    recordedResult.exitCode = 1;
  }

  return {
    result: recordedResult,
    paths: {
      recordPath,
      stderrPath,
      stderrSha256,
      stdoutPath,
      stdoutSha256,
    },
  };
}

function providerCommandOutputsEqual(startedOutputs, completedOutputs) {
  return Array.isArray(startedOutputs) &&
    Array.isArray(completedOutputs) &&
    startedOutputs.length === completedOutputs.length &&
    startedOutputs.every((startedOutput, index) => {
      const completedOutput = completedOutputs[index];
      return startedOutput &&
        completedOutput &&
        startedOutput.channel === completedOutput.channel &&
        startedOutput.kind === completedOutput.kind &&
        startedOutput.path === completedOutput.path &&
        startedOutput.required === completedOutput.required &&
        startedOutput.runRelativePath === completedOutput.runRelativePath;
    });
}

function readTrustedAndroidStopOutputs({ context }) {
  const commandId = 'stop-android-native-window';
  const phase = 'stopWindow';
  const startedRecord = readJsonArtifactIfAvailable(
    path.join(context.runDir, `raw/provider-commands/${context.providerId}-${commandId}.started.json`),
  );
  const completedRecord = readJsonArtifactIfAvailable(
    path.join(context.runDir, `raw/provider-commands/${context.providerId}-${commandId}.json`),
  );
  if (!runnerLifecycleCompletedRecordMatches({
    commandId,
    completedRecord,
    phase,
    providerId: context.providerId,
    startedRecord,
  }) || !providerCommandOutputsEqual(startedRecord.outputs, completedRecord.outputs)) {
    return new Set();
  }

  const expectedPaths = new Set(buildAndroidAdbStopWindowDefinitions(context).map(
    ({ id }) => toRunRelativePath(context.runDir, path.join(context.captureDir, `${id}.stdout.txt`)),
  ));
  if (completedRecord.outputs.length !== expectedPaths.size) {
    return new Set();
  }

  const trustedPaths = new Set();
  for (const output of completedRecord.outputs) {
    if (
      output.channel !== 'provider' ||
      output.kind !== 'logs' ||
      output.status !== 'captured' ||
      output.stale !== false ||
      !expectedPaths.has(output.runRelativePath)
    ) {
      return new Set();
    }
    const outputPath = path.join(context.runDir, output.runRelativePath);
    if (!fs.existsSync(outputPath) || output.sha256 !== sha256File(outputPath)) {
      return new Set();
    }
    trustedPaths.add(output.runRelativePath);
  }
  return trustedPaths.size === expectedPaths.size ? trustedPaths : new Set();
}

async function captureAndroidAdbEvidence({ args, outPath, providerId, rawInvocationArgs, requireRequest = false, runId, scenarioId }) {
  const context = resolveAndroidAdbCaptureContext({
    args,
    outPath,
    providerId,
    requireRequest,
    runId,
    scenarioId,
  });
  if (!requireRequest && !fs.existsSync(path.join(context.captureDir, 'gfxinfo.command.json'))) {
    await captureAndroidAdbWindow(context);
  }

  const captures = new Map(buildAndroidAdbStopWindowDefinitions(context).map((definition) => [
    definition.id,
    readPreservedAndroidAdbCapture({ context, definition }),
  ]));

  const serialCapture = captures.get('target-serial');
  const packageCapture = captures.get('target-package');
  const processCapture = captures.get('target-process');
  const observedDeviceId = serialCapture && commandSucceeded(serialCapture.result) ? serialCapture.result.stdout.trim() : '';
  const serialMatches = observedDeviceId === context.deviceId;
  const packageMatches = Boolean(packageCapture && commandSucceeded(packageCapture.result) && packageCapture.result.stdout.split(/\r?\n/u).some((line) => line.startsWith('package:')));
  const observedPidTokens = processCapture && commandSucceeded(processCapture.result)
    ? processCapture.result.stdout.trim().split(/\s+/u).filter(Boolean)
    : [];
  const observedPid = observedPidTokens.length === 1
    ? Number.parseInt(observedPidTokens[0] ?? '', 10)
    : Number.NaN;
  const processMatches = Number.isSafeInteger(observedPid) && observedPid > 0;
  const observedAppId = packageMatches ? context.appId : undefined;
  const trustedStopOutputs = readTrustedAndroidStopOutputs({ context });
  let targetProofStatus = 'unverified';
  if (observedDeviceId && observedDeviceId !== context.deviceId) {
    targetProofStatus = 'mismatch';
  } else if (serialMatches && packageMatches && processMatches && trustedStopOutputs.size > 0) {
    targetProofStatus = 'verified';
  }
  const targetProofPath = resolveTargetBindingArtifactPath({
    args,
    providerDir: path.dirname(outPath),
  });
  toRunRelativePath(context.runDir, targetProofPath);
  const providerDir = path.dirname(outPath);
  const existingTargetProof = readJsonArtifactIfAvailable(targetProofPath);
  const lifecycleSourceCommands = buildLifecycleSourceCommandsForTargetBinding({
    baseArgs: rawInvocationArgs,
    includeCaptureCommand: true,
    normalizeOutputPath: outPath,
    platform: 'android',
    providerDir,
    providerId,
    runDir: context.runDir,
    targetBindingPath: targetProofPath,
  });
  const targetWindow = resolveTargetBindingWindowRecord({
    existingTargetBinding: existingTargetProof,
    providerDir,
    runDir: context.runDir,
  });
  const observedSourceCommands = [
    'target-serial',
    'target-package',
    'target-process',
    'gfxinfo',
    'framestats',
    'meminfo',
  ].flatMap((sourceId) => {
    const capture = captures.get(sourceId);
    return capture ? [buildTargetBindingSourceCommand({
      capture,
      phase: 'stopWindow',
      runDir: context.runDir,
      sourceId,
    })] : [];
  });
  const captureArtifacts = ['gfxinfo', 'framestats', 'meminfo'].flatMap((sourceId) => {
    const capture = captures.get(sourceId);
    if (!capture || !commandSucceeded(capture.result) || capture.result.stdout.length === 0) {
      return [];
    }
    const runRelativePath = toRunRelativePath(context.runDir, capture.paths.stdoutPath);
    return trustedStopOutputs.has(runRelativePath)
      ? [{ commandId: 'stop-android-native-window', path: runRelativePath }]
      : [];
  });
  writeJsonArtifact(targetProofPath, {
    ...(captureArtifacts.length > 0 ? { captureArtifacts } : {}),
    capturedAt: new Date().toISOString(),
    observedAppId,
    ...(observedDeviceId ? { observedTargetId: observedDeviceId } : {}),
    ...(processMatches ? { observedProcessName: context.appId, observedProcessPid: observedPid } : {}),
    packageCommand: packageCapture?.result.args ?? [],
    packageMatched: packageMatches,
    observedDeviceId: observedDeviceId || null,
    platform: 'android',
    providerId,
    requestedAppId: context.appId,
    requestedDeviceId: context.deviceId,
    requestedTargetId: context.deviceId,
    runId,
    scenarioId,
    schemaVersion: '1.0.0',
    serialCommand: serialCapture?.result.args ?? [],
    serialMatched: serialMatches,
    sourceCommands: mergeTargetBindingSourceCommands(lifecycleSourceCommands, observedSourceCommands),
    status: targetProofStatus,
    window: targetWindow ?? {
      phase: 'afterCapture',
    },
  });
  const targetEvidencePath = toRunRelativePath(context.runDir, targetProofPath);

  const sourceDefinitions = [
    { id: 'gfxinfo', dataClasses: ['frames', 'jank', 'render'], toolName: 'adb dumpsys gfxinfo' },
    { id: 'framestats', dataClasses: ['frames', 'jank'], toolName: 'adb dumpsys gfxinfo framestats' },
    { id: 'meminfo', dataClasses: ['memory'], toolName: 'adb dumpsys meminfo' },
  ];
  const diagnosticSources = sourceDefinitions.map((definition) => {
    const capture = captures.get(definition.id);
    return capture ? buildCapturedSource({
      ...definition,
      result: capture.result,
      runDir: context.runDir,
      stdoutPath: capture.paths.stdoutPath,
    }) : buildUnverifiedSource(
      definition.id,
      definition.toolName,
      definition.dataClasses,
      `Run the Android stopWindow provider command to preserve ${definition.id} before normalization.`,
    );
  });
  const sourceCapture = Object.fromEntries(sourceDefinitions.map(({ id }) => [id, captures.get(id)]));
  const commandFailed = Array.from(captures.values()).some((capture) => !capture || !commandSucceeded(capture.result));
  const sourceOutputMissing = sourceDefinitions.some(({ id }) => !sourceCapture[id]?.result.stdout.length);
  const provenanceMissing = requireRequest && captureArtifacts.length !== sourceDefinitions.length;
  const captureFailed = commandFailed || sourceOutputMissing || !serialMatches || !packageMatches || !processMatches || provenanceMissing;
  const attachments = sourceDefinitions.flatMap(({ id }) => {
    const stdoutPath = sourceCapture[id]?.paths.stdoutPath;
    return stdoutPath && fs.existsSync(stdoutPath) ? [{
      kind: `raw-${id}`,
      path: toRunRelativePath(context.runDir, stdoutPath),
      sizeBytes: fs.statSync(stdoutPath).size,
    }] : [];
  });
  attachments.push({
    kind: 'android-target-binding',
    path: targetEvidencePath,
    sizeBytes: fs.statSync(targetProofPath).size,
  });

  let targetBinding;
  if (observedDeviceId && observedDeviceId !== context.deviceId) {
    targetBinding = {
      status: 'mismatch',
      appId: context.appId,
      deviceId: context.deviceId,
      source: 'provider adb target verification',
      reason: `adb observed device ${observedDeviceId}, but the provider requested ${context.deviceId}.`,
      candidateTargets: [
        {
          appId: context.appId,
          bindingStatus: 'expected',
          deviceId: context.deviceId,
          evidencePath: targetEvidencePath,
          platform: 'android',
          source: 'provider request',
        },
        {
          ...(packageMatches ? { appId: context.appId } : {}),
          bindingStatus: 'observed',
          deviceId: observedDeviceId,
          evidencePath: targetEvidencePath,
          platform: 'android',
          source: 'adb get-serialno',
        },
      ],
    };
  } else if (targetProofStatus === 'verified') {
    targetBinding = {
      status: 'verified',
      appId: context.appId,
      deviceId: context.deviceId,
      source: 'provider adb target verification',
      candidateTargets: [{
        appId: context.appId,
        bindingStatus: 'observed',
        deviceId: context.deviceId,
        evidencePath: targetEvidencePath,
        platform: 'android',
        source: 'adb serial, package, and pidof verification',
      }],
    };
  } else {
    targetBinding = {
      status: 'unverified',
      appId: context.appId,
      deviceId: context.deviceId,
      source: 'provider adb target verification',
      reason: 'The provider did not verify the exact device, package, process, and immutable stopWindow output provenance.',
    };
  }

  const evidence = buildAndroidNativePerformanceEvidence({
    appId: context.appId,
    attachments,
    capturedAt: new Date().toISOString(),
    claimSufficiency: {
      status: 'insufficient-for-claim',
      claim: 'Comparable Android native-performance measurement.',
      reason: 'The provider captured active-window diagnostics but no compatible baseline and comparison policy were supplied.',
      supportingEvidence: diagnosticSources.filter((source) => source.status === 'captured').map((source) => source.sourceId),
      missingEvidence: ['compatible comparison policy', 'comparable baseline'],
      nextAction: 'Keep this evidence diagnostic-only until an independently compatible baseline and comparison policy are available.',
    },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Active-window attribution alone does not establish same-condition baseline compatibility.',
      policy: 'Use this evidence for diagnosis only until comparison policy and baseline compatibility are independently proven.',
    },
    completenessStatus: 'partial',
    deviceId: context.deviceId,
    diagnosticSources,
    framestatsText: sourceCapture.framestats && commandSucceeded(sourceCapture.framestats.result) ? sourceCapture.framestats.result.stdout : undefined,
    gfxinfoText: sourceCapture.gfxinfo && commandSucceeded(sourceCapture.gfxinfo.result) ? sourceCapture.gfxinfo.result.stdout : undefined,
    meminfoText: sourceCapture.meminfo && commandSucceeded(sourceCapture.meminfo.result) ? sourceCapture.meminfo.result.stdout : undefined,
    providerId,
    runId,
    scenarioId,
    targetBinding,
  });
  writeJsonArtifact(outPath, evidence);
  if (captureFailed) {
    process.exitCode = 1;
  }
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && typeof match[1] === 'string' && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}

function parseDurationMs(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const isoMatch = /^PT([\d.]+)S$/iu.exec(trimmed);
  if (isoMatch) {
    const seconds = Number.parseFloat(isoMatch[1]);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const durationMatch = /^([\d.]+)\s*(ms|s|sec|secs|seconds?)?$/iu.exec(trimmed);
  if (!durationMatch) {
    return undefined;
  }
  const numeric = Number.parseFloat(durationMatch[1]);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  const unit = durationMatch[2]?.toLowerCase() ?? 'ms';
  if (unit === 'ms') {
    return Math.round(numeric);
  }
  return Math.round(numeric * 1000);
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsedMs = Date.parse(value.trim());
  if (!Number.isFinite(parsedMs)) {
    return undefined;
  }
  return new Date(parsedMs).toISOString();
}

function parseXctraceTocSummary(tocText) {
  const startAt = parseIsoTimestamp(firstMatch(tocText, [
    /<start[-_ ](?:date|time)?[^>]*>([^<]+)<\/start[-_ ](?:date|time)?>/iu,
    /\bstart(?:Date|Time)?\s*=\s*"([^"]+)"/iu,
  ]));
  const endAt = parseIsoTimestamp(firstMatch(tocText, [
    /<end[-_ ](?:date|time)?[^>]*>([^<]+)<\/end[-_ ](?:date|time)?>/iu,
    /\bend(?:Date|Time)?\s*=\s*"([^"]+)"/iu,
  ]));
  const durationElement = firstMatch(tocText, [/<duration[^>]*>([^<]+)<\/duration>/iu]);
  const durationFromElement = durationElement ? parseDurationMs(`${durationElement}s`) : undefined;
  const durationFromAttribute = parseDurationMs(firstMatch(tocText, [
    /\bdurationMs\s*=\s*"([^"]+)"/iu,
    /<trace-window[^>]*\bduration\s*=\s*"([^"]+)"/iu,
  ]));
  const startMs = startAt ? Date.parse(startAt) : undefined;
  const endMs = endAt ? Date.parse(endAt) : undefined;
  let durationMs = durationFromElement ?? durationFromAttribute;
  if (durationMs === undefined && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    durationMs = Math.round(endMs - startMs);
  }

  const processPid = Number.parseInt(firstMatch(tocText, [
    /<(?:target-process|process)[^>]*\bpid\s*=\s*"(\d+)"/iu,
    /\bprocessPid\s*=\s*"(\d+)"/iu,
    /<pid[^>]*>(\d+)<\/pid>/iu,
  ]) ?? '', 10);
  const parsedPid = Number.isSafeInteger(processPid) && processPid > 0 ? processPid : undefined;

  return {
    startAt,
    endAt,
    durationMs,
    windowStartMs: durationMs !== undefined ? 0 : undefined,
    windowEndMs: durationMs,
    toolVersion: firstMatch(tocText, [
      /<instruments-version[^>]*>([^<]+)<\/instruments-version>/iu,
      /<(?:instruments|tool)[^>]*\bversion\s*=\s*"([^"]+)"/iu,
      /\btoolVersion\s*=\s*"([^"]+)"/iu,
    ]),
    template: firstMatch(tocText, [
      /<template-name[^>]*>([^<]+)<\/template-name>/iu,
      /<(?:trace-template|template)[^>]*\bname\s*=\s*"([^"]+)"/iu,
      /\btemplate(?:Name)?\s*=\s*"([^"]+)"/iu,
    ]),
    endReason: firstMatch(tocText, [
      /<(?:trace-window|recording)[^>]*\bend(?:-reason|Reason)\s*=\s*"([^"]+)"/iu,
      /<end-reason[^>]*>([^<]+)<\/end-reason>/iu,
    ]),
    deviceId: firstMatch(tocText, [
      /<(?:target-device|device)[^>]*\b(?:udid|uuid|identifier|device-id)\s*=\s*"([^"]+)"/iu,
      /\bdevice(?:Udid|Id|Identifier)\s*=\s*"([^"]+)"/iu,
    ]),
    devicePlatform: firstMatch(tocText, [
      /<(?:target-device|device)[^>]*\bplatform\s*=\s*"([^"]+)"/iu,
      /\bdevicePlatform\s*=\s*"([^"]+)"/iu,
    ]),
    processPid: parsedPid,
    processName: firstMatch(tocText, [
      /<(?:target-process|process)[^>]*\bname\s*=\s*"([^"]+)"/iu,
      /\bprocessName\s*=\s*"([^"]+)"/iu,
    ]),
  };
}

function readBootedDeviceObservation(devicesJsonText, requestedDeviceId) {
  try {
    const parsed = JSON.parse(devicesJsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 'failed' };
    }
    const runtimes = parsed.devices;
    if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) {
      return { status: 'failed' };
    }
    for (const [runtime, devices] of Object.entries(runtimes)) {
      if (!Array.isArray(devices)) {
        continue;
      }
      for (const entry of devices) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        if (entry.udid === requestedDeviceId) {
          return {
            status: 'observed',
            matchesRequestedDevice: entry.state === 'Booted',
            state: typeof entry.state === 'string' ? entry.state : null,
            name: typeof entry.name === 'string' ? entry.name : null,
            runtime,
          };
        }
      }
    }
  } catch {
    return { status: 'failed' };
  }
  return { status: 'missing' };
}

function readLaunchctlProcessObservation(launchctlText, bundleId) {
  for (const line of launchctlText.split(/\r?\n/u)) {
    const tokens = line.trim().split(/\s+/u);
    if (tokens.length < 3) {
      continue;
    }
    const label = tokens[tokens.length - 1];
    const labelMatchesBundle = label === bundleId || label.includes(`:${bundleId}[`);
    if (!labelMatchesBundle) {
      continue;
    }
    const pid = Number.parseInt(tokens[0], 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      return { status: 'observed', pid, label };
    }
  }
  return { status: 'missing' };
}

function buildTraceBundleInventory(traceBundlePath) {
  if (!fs.existsSync(traceBundlePath)) {
    return {
      exists: false,
      files: [],
      kind: 'xctrace-trace-bundle-inventory',
      traceBundle: path.basename(traceBundlePath),
      fileCount: 0,
      totalSizeBytes: 0,
    };
  }
  if (!fs.statSync(traceBundlePath).isDirectory()) {
    return {
      exists: true,
      files: [],
      kind: 'xctrace-trace-bundle-inventory',
      traceBundle: path.basename(traceBundlePath),
      fileCount: 0,
      totalSizeBytes: 0,
      reason: 'Expected a directory-backed .trace bundle.',
    };
  }

  const files = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDir = pending.pop();
    const absoluteDir = path.join(traceBundlePath, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      const absolutePath = path.join(traceBundlePath, relativePath);
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      files.push({
        path: toPortablePath(relativePath),
        sizeBytes: fs.statSync(absolutePath).size,
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const totalSizeBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  return {
    exists: true,
    files,
    kind: 'xctrace-trace-bundle-inventory',
    traceBundle: path.basename(traceBundlePath),
    fileCount: files.length,
    totalSizeBytes,
  };
}

function normalizeCommandArgForEvidence(runDir, arg) {
  if (!path.isAbsolute(arg)) {
    return arg;
  }
  try {
    return toRunRelativePath(runDir, arg);
  } catch {
    return path.basename(arg);
  }
}

function buildIosDiagnosticSource({ commandResults, dataClasses, path: sourcePath, reason, runDir, sourceId, status, toolName }) {
  const command = commandResults
    .map((result) => [
      typeof result.command === 'string' && result.command.length > 0
        ? path.basename(result.command)
        : toolName,
      ...(Array.isArray(result.args)
        ? result.args
          .filter((arg) => typeof arg === 'string')
          .map((arg) => normalizeCommandArgForEvidence(runDir, arg))
        : []),
    ].join(' '))
    .join(' / ');
  return {
    sourceId,
    status,
    tool: {
      name: toolName,
      command,
    },
    dataClasses,
    ...(sourcePath
      ? { path: toRunRelativePath(runDir, sourcePath) }
      : {}),
    ...(status === 'captured'
      ? {}
      : {
          reason,
          nextAction: 'Inspect provider command records, repair simctl/xctrace capture, and rerun the provider.',
        }),
  };
}

function combinedCommandStatus(results, evidenceValid) {
  if (results.some((result) => result.timedOut)) {
    return 'timeout';
  }
  if (results.some((result) => !commandSucceeded(result))) {
    return 'failed';
  }
  return evidenceValid ? 'captured' : 'partial';
}

async function captureIosXctraceEvidence({ args, outPath, providerId, rawInvocationArgs, requireRequest = false, runId, scenarioId }) {
  const bundleId = resolveRequestedAppId(args, 'ios');
  const deviceId = resolveRequestedTargetId(args, 'ios');
  if (!bundleId || !deviceId) {
    throw new Error('iOS xctrace capture requires --app-id or --bundle plus --target-id or --device.');
  }

  const runDir = optionalStringArg(args, 'run-dir', 'ASL_RUN_DIR');
  if (!runDir) {
    throw new Error('iOS xctrace capture requires --run-dir so evidence paths can remain durable and run-relative.');
  }
  validateNativePerformanceRequest({
    args,
    platform: 'ios',
    required: requireRequest,
    requestedAppId: bundleId,
    requestedTargetId: deviceId,
    runDir,
    runId,
    scenarioId,
  });
  toRunRelativePath(runDir, outPath);
  const xcrunPath = optionalStringArg(args, 'xcrun', 'ASL_XCRUN_PATH') ?? 'xcrun';
  const captureDurationSeconds = parseStrictPositiveInteger(
    optionalStringArg(args, 'ios-capture-duration-seconds', 'ASL_NATIVE_PERFORMANCE_IOS_CAPTURE_DURATION_SECONDS'),
    10,
    '--ios-capture-duration-seconds/ASL_NATIVE_PERFORMANCE_IOS_CAPTURE_DURATION_SECONDS',
  );
  const timeoutValue = optionalStringArg(args, 'ios-command-timeout-ms', 'ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS');
  const timeoutMs = parseStrictPositiveInteger(
    timeoutValue,
    (captureDurationSeconds * 1_000) + 30_000,
    '--ios-command-timeout-ms/ASL_NATIVE_PERFORMANCE_IOS_COMMAND_TIMEOUT_MS',
  );
  const xctraceTemplate = optionalStringArg(args, 'ios-xctrace-template', 'ASL_NATIVE_PERFORMANCE_IOS_XCTRACE_TEMPLATE') ?? 'Time Profiler';
  const captureDir = path.join(path.dirname(outPath), 'ios-xctrace');
  fs.mkdirSync(captureDir, { recursive: true });
  const traceBundlePath = path.join(captureDir, 'capture.trace');

  const captures = new Map();
  const preflightDefinitions = [
    { id: 'simctl-list-devices', args: ['simctl', 'list', 'devices', '--json'], phase: 'afterCapture' },
    { id: 'simctl-get-app-container', args: ['simctl', 'get_app_container', deviceId, bundleId, 'app'], phase: 'afterCapture' },
    { id: 'simctl-launchctl-list', args: ['simctl', 'spawn', deviceId, 'launchctl', 'list'], phase: 'afterCapture' },
  ];
  for (const definition of preflightDefinitions) {
    const result = await runCommand(xcrunPath, definition.args, timeoutMs);
    captures.set(definition.id, {
      result,
      paths: writeCommandArtifacts({
        captureDir,
        id: definition.id,
        phase: definition.phase,
        providerId,
        result,
        runDir,
      }),
    });
  }

  const bootedDeviceCapture = captures.get('simctl-list-devices').result;
  const appContainerCapture = captures.get('simctl-get-app-container').result;
  const launchctlCapture = captures.get('simctl-launchctl-list').result;
  const bootedDeviceObservation = commandSucceeded(bootedDeviceCapture)
    ? readBootedDeviceObservation(bootedDeviceCapture.stdout, deviceId)
    : { status: 'failed' };
  const appContainerAvailable = commandSucceeded(appContainerCapture) && appContainerCapture.stdout.trim().length > 0;
  const launchctlProcess = commandSucceeded(launchctlCapture)
    ? readLaunchctlProcessObservation(launchctlCapture.stdout, bundleId)
    : { status: 'failed' };
  const requestedPid = launchctlProcess.status === 'observed' ? launchctlProcess.pid : 0;

  const recordArgs = [
    'xctrace',
    'record',
    '--template',
    xctraceTemplate,
    '--device',
    deviceId,
    '--attach',
    String(requestedPid),
    '--time-limit',
    `${captureDurationSeconds}s`,
    '--output',
    traceBundlePath,
    '--no-prompt',
  ];
  const recordResult = await runCommand(xcrunPath, recordArgs, timeoutMs);
  captures.set('xctrace-record', {
    result: recordResult,
    paths: writeCommandArtifacts({
      captureDir,
      id: 'xctrace-record',
      phase: 'afterCapture',
      providerId,
      result: recordResult,
      runDir,
    }),
  });

  const exportArgs = ['xctrace', 'export', '--input', traceBundlePath, '--toc'];
  const exportResult = await runCommand(xcrunPath, exportArgs, timeoutMs);
  captures.set('xctrace-export-toc', {
    result: exportResult,
    paths: writeCommandArtifacts({
      captureDir,
      id: 'xctrace-export-toc',
      phase: 'afterCapture',
      providerId,
      result: exportResult,
      runDir,
    }),
  });

  const tocPath = path.join(captureDir, 'xctrace-toc.xml');
  writeTextArtifact(tocPath, exportResult.stdout);
  const traceInventoryPath = path.join(captureDir, 'trace-bundle-inventory.json');
  const traceInventory = {
    ...buildTraceBundleInventory(traceBundlePath),
    traceBundlePath: toRunRelativePath(runDir, traceBundlePath),
  };
  writeJsonArtifact(traceInventoryPath, traceInventory);

  const tocSummary = commandSucceeded(exportResult) && exportResult.stdout.trim().length > 0
    ? parseXctraceTocSummary(exportResult.stdout)
    : {};
  const tocVerified = Boolean(
    tocSummary.startAt
      && tocSummary.endAt
      && tocSummary.durationMs !== undefined
      && tocSummary.template
      && tocSummary.toolVersion
      && tocSummary.endReason
      && tocSummary.deviceId
      && tocSummary.processPid !== undefined
      && tocSummary.processName,
  );
  const startMs = tocSummary.startAt ? Date.parse(tocSummary.startAt) : Number.NaN;
  const endMs = tocSummary.endAt ? Date.parse(tocSummary.endAt) : Number.NaN;
  const elapsedMs = endMs - startMs;
  const durationToleranceMs = Math.max(1, elapsedMs * 0.01);
  const requestedDurationMs = captureDurationSeconds * 1_000;
  const captureLimitToleranceMs = Math.max(2_000, requestedDurationMs * 0.1);
  const windowVerified = tocVerified
    && Number.isFinite(elapsedMs)
    && elapsedMs > 0
    && tocSummary.durationMs > 0
    && tocSummary.durationMs <= requestedDurationMs + captureLimitToleranceMs
    && Math.abs(tocSummary.durationMs - elapsedMs) <= durationToleranceMs;
  const observedDeviceId = typeof tocSummary.deviceId === 'string' ? tocSummary.deviceId : null;
  const observedPid = Number.isSafeInteger(tocSummary.processPid) ? tocSummary.processPid : null;
  const observedProcessName = typeof tocSummary.processName === 'string' ? tocSummary.processName : null;
  const recordedSimulator = typeof tocSummary.devicePlatform === 'string' && /simulator/iu.test(tocSummary.devicePlatform);
  const deviceMismatch = observedDeviceId && observedDeviceId !== deviceId;
  const pidMismatch = launchctlProcess.status === 'observed'
    && observedPid !== null
    && observedPid !== requestedPid;

  let targetStatus = 'unverified';
  if (
    commandSucceeded(recordResult)
    && commandSucceeded(exportResult)
    && bootedDeviceObservation.status === 'observed'
    && bootedDeviceObservation.matchesRequestedDevice === true
    && appContainerAvailable
    && launchctlProcess.status === 'observed'
    && windowVerified
    && recordedSimulator
    && !deviceMismatch
    && !pidMismatch
  ) {
    targetStatus = 'verified';
  } else if (deviceMismatch || pidMismatch) {
    targetStatus = 'mismatch';
  }

  const targetProofPath = resolveTargetBindingArtifactPath({
    args,
    providerDir: path.dirname(outPath),
  });
  toRunRelativePath(runDir, targetProofPath);
  const providerDir = path.dirname(outPath);
  const existingTargetProof = readJsonArtifactIfAvailable(targetProofPath);
  const lifecycleSourceCommands = buildLifecycleSourceCommandsForTargetBinding({
    baseArgs: rawInvocationArgs,
    includeCaptureCommand: true,
    normalizeOutputPath: outPath,
    platform: 'ios',
    providerDir,
    providerId,
    runDir,
    targetBindingPath: targetProofPath,
  });
  const targetWindow = resolveTargetBindingWindowRecord({
    existingTargetBinding: existingTargetProof,
    providerDir,
    runDir,
  });
  const observedSourceCommands = [
    'simctl-list-devices',
    'simctl-get-app-container',
    'simctl-launchctl-list',
    'xctrace-record',
    'xctrace-export-toc',
  ].map((sourceId) => buildTargetBindingSourceCommand({
    capture: captures.get(sourceId),
    outputPath: sourceId === 'xctrace-export-toc'
      ? tocPath
      : undefined,
    phase: 'afterCapture',
    runDir,
    sourceId,
  }));
  writeJsonArtifact(targetProofPath, {
    capturedAt: new Date().toISOString(),
    observedDevice: bootedDeviceObservation,
    observedLaunchctlProcess: launchctlProcess,
    ...(observedDeviceId ? { observedTargetId: observedDeviceId } : {}),
    ...(observedProcessName ? { observedProcessName } : {}),
    ...(observedPid !== null ? { observedProcessPid: observedPid } : {}),
    ...(typeof tocSummary.devicePlatform === 'string' ? { observedTargetPlatform: tocSummary.devicePlatform } : {}),
    ...(typeof tocSummary.template === 'string' ? { observedTemplate: tocSummary.template } : {}),
    ...(typeof tocSummary.toolVersion === 'string' ? { observedToolVersion: tocSummary.toolVersion } : {}),
    platform: 'ios',
    providerId,
    requestedAppId: bundleId,
    requestedDeviceId: deviceId,
    requestedPid,
    requestedTargetId: deviceId,
    runId,
    scenarioId,
    schemaVersion: '1.0.0',
    bundleId,
    observedAppContainerName: appContainerAvailable ? path.basename(appContainerCapture.stdout.trim()) : null,
    recordedDeviceId: observedDeviceId,
    recordedDevicePlatform: tocSummary.devicePlatform ?? null,
    recordedProcessName: observedProcessName,
    recordedProcessPid: observedPid,
    status: targetStatus,
    template: tocSummary.template ?? null,
    toolVersion: tocSummary.toolVersion ?? null,
    endReason: tocSummary.endReason ?? null,
    sourceCommands: mergeTargetBindingSourceCommands(lifecycleSourceCommands, observedSourceCommands),
    tocVerified,
    windowVerified,
    window: targetWindow ?? {
      ...(tocSummary.durationMs !== undefined ? { durationMs: tocSummary.durationMs } : {}),
      ...(tocSummary.endAt ? { endedAt: tocSummary.endAt } : {}),
      phase: 'afterCapture',
      ...(tocSummary.startAt ? { startedAt: tocSummary.startAt } : {}),
    },
    traceBundleObserved: traceInventory.exists && traceInventory.fileCount > 0,
  });

  const attachmentEntries = [
    { kind: 'xctrace-export', path: tocPath },
    { kind: 'ios-target-binding', path: targetProofPath },
    { kind: 'xctrace-trace-bundle-inventory', path: traceInventoryPath },
  ];
  const attachments = attachmentEntries.map((entry) => ({
    kind: entry.kind,
    path: toRunRelativePath(runDir, entry.path),
    sizeBytes: fs.statSync(entry.path).size,
  }));

  const xctraceCaptured = commandSucceeded(recordResult)
    && commandSucceeded(exportResult)
    && windowVerified
    && recordedSimulator
    && traceInventory.exists
    && traceInventory.fileCount > 0;
  const simctlCaptured = commandSucceeded(bootedDeviceCapture)
    && commandSucceeded(appContainerCapture)
    && commandSucceeded(launchctlCapture)
    && bootedDeviceObservation.status === 'observed'
    && bootedDeviceObservation.matchesRequestedDevice === true
    && appContainerAvailable
    && launchctlProcess.status === 'observed';

  const diagnosticSources = [
    buildIosDiagnosticSource({
      commandResults: [recordResult, exportResult],
      dataClasses: ['cpu', 'thread-scheduling', 'native-trace'],
      path: tocPath,
      reason: tocVerified
        ? 'The provider captured xctrace output but did not verify full target/window binding.'
        : 'The provider could not verify bounded xctrace TOC facts for target/window evidence.',
      runDir,
      sourceId: 'xctrace',
      status: combinedCommandStatus([recordResult, exportResult], xctraceCaptured),
      toolName: 'xctrace',
    }),
    buildIosDiagnosticSource({
      commandResults: [bootedDeviceCapture, appContainerCapture, launchctlCapture],
      dataClasses: ['unknown'],
      path: targetProofPath,
      reason: 'The provider could not verify the requested simulator, installed app container, and launchctl process binding.',
      runDir,
      sourceId: 'simctl',
      status: combinedCommandStatus([bootedDeviceCapture, appContainerCapture, launchctlCapture], simctlCaptured),
      toolName: 'xcrun simctl',
    }),
  ];

  let targetBinding;
  const targetEvidencePath = toRunRelativePath(runDir, targetProofPath);
  if (targetStatus === 'verified') {
    targetBinding = {
      status: 'verified',
      appId: bundleId,
      deviceId,
      source: 'provider simctl/xctrace target verification',
      candidateTargets: [{
        appId: bundleId,
        bindingStatus: 'observed',
        deviceId,
        evidencePath: targetEvidencePath,
        platform: 'ios',
        source: 'simctl launchctl list plus xctrace TOC verification',
      }],
    };
  } else if (targetStatus === 'mismatch') {
    targetBinding = {
      status: 'mismatch',
      appId: bundleId,
      deviceId,
      source: 'provider simctl/xctrace target verification',
      reason: 'xctrace recorded a device or pid that does not match the requested simulator launchctl target.',
      candidateTargets: [
        {
          appId: bundleId,
          bindingStatus: 'expected',
          deviceId,
          evidencePath: targetEvidencePath,
          platform: 'ios',
          source: 'provider request',
        },
        {
          bindingStatus: 'observed',
          ...(observedDeviceId ? { deviceId: observedDeviceId } : {}),
          evidencePath: targetEvidencePath,
          platform: 'ios',
          source: 'xctrace TOC',
        },
      ],
    };
  } else {
    targetBinding = {
      status: 'unverified',
      appId: bundleId,
      deviceId,
      source: 'provider simctl/xctrace target verification',
      reason: 'The provider could not verify all requested simulator/app/process/xctrace binding surfaces.',
    };
  }

  const allCommandsSucceeded = Array.from(captures.values()).every(({ result }) => commandSucceeded(result));
  const captureSucceeded = allCommandsSucceeded && xctraceCaptured && simctlCaptured && targetStatus === 'verified';
  const evidence = buildIosNativePerformanceEvidence({
    appId: bundleId,
    attachments,
    bundleId,
    captureMode: 'session',
    capturedAt: tocSummary.startAt ?? new Date().toISOString(),
    claimSufficiency: captureSucceeded
      ? {
          status: 'sufficient-for-diagnosis',
          claim: 'iOS simulator native-performance diagnosis from bounded xctrace capture.',
          reason: 'The provider verified simulator/app/process/window ownership but did not export structured comparison metrics.',
          supportingEvidence: ['xctrace', 'simctl', 'targetBinding'],
          missingEvidence: ['structured performance sample suitable for comparison baselines'],
          nextAction: 'Export structured xctrace performance samples before making comparison or release claims.',
        }
      : {
          status: 'insufficient-for-claim',
          claim: 'iOS simulator native-performance diagnosis from bounded xctrace capture.',
          reason: 'One or more bounded simctl/xctrace capture, export, or binding verification steps failed or remained unverified.',
          supportingEvidence: ['xctrace-toc', 'target-binding'],
          missingEvidence: ['verified simulator/app/process binding', 'verified bounded xctrace TOC metadata'],
          nextAction: 'Repair the failed step, rerun capture, and inspect preserved command records and raw outputs.',
        },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Trace-window metadata and target proof alone do not provide structured comparable native-performance samples.',
      policy: 'Use this capture for diagnosis and target/window trust checks, not baseline comparison selection.',
    },
    completenessStatus: captureSucceeded ? 'complete' : 'partial',
    deviceId,
    diagnosticSources,
    lifecycle: xctraceCaptured
      ? {
          durationMs: tocSummary.durationMs,
          endedAt: tocSummary.endAt,
          perturbsTiming: true,
          phase: 'afterCapture',
          startedAt: tocSummary.startAt,
        }
      : {
          perturbsTiming: true,
          phase: 'afterCapture',
        },
    providerId,
    runId,
    scenarioId,
    targetBinding,
    xctraceSummary: xctraceCaptured
      ? {
          durationMs: tocSummary.durationMs,
          traceId: `${runId}-xctrace`,
          windowEndMs: tocSummary.windowEndMs,
          windowStartMs: tocSummary.windowStartMs,
        }
      : undefined,
  });
  writeJsonArtifact(outPath, evidence);
  if (!captureSucceeded) {
    process.exitCode = 1;
  }
}

async function normalizeManagedIosXctraceEvidence({ args, outPath, providerId, rawInvocationArgs, runId, scenarioId }) {
  const context = resolveIosXctraceCaptureContext({
    args,
    outPath,
    providerId,
    requireRequest: true,
    runId,
    scenarioId,
  });
  const captures = new Map();
  for (const definition of buildIosXctraceStartWindowDefinitions(context)) {
    captures.set(
      definition.id,
      readPreservedIosCommandCapture({
        captureDir: context.captureDir,
        id: definition.id,
        phase: definition.phase,
        providerId: context.providerId,
        runDir: context.runDir,
      }),
    );
  }
  for (const definition of buildIosXctraceStopWindowDefinitions(context)) {
    captures.set(
      definition.id,
      readPreservedIosCommandCapture({
        captureDir: context.captureDir,
        id: definition.id,
        phase: definition.phase,
        providerId: context.providerId,
        runDir: context.runDir,
      }),
    );
  }

  const bootedDeviceCapture = captures.get('simctl-list-devices')?.result;
  const appContainerCapture = captures.get('simctl-get-app-container')?.result;
  const launchctlCapture = captures.get('simctl-launchctl-list')?.result;
  const recordCapture = captures.get('xctrace-record')?.result;
  const exportCapture = captures.get('xctrace-export-toc')?.result;
  const bootedDeviceObservation = bootedDeviceCapture && commandSucceeded(bootedDeviceCapture)
    ? readBootedDeviceObservation(bootedDeviceCapture.stdout, context.deviceId)
    : { status: 'failed' };
  const appContainerAvailable = Boolean(appContainerCapture && commandSucceeded(appContainerCapture) && appContainerCapture.stdout.trim().length > 0);
  const launchctlProcess = launchctlCapture && commandSucceeded(launchctlCapture)
    ? readLaunchctlProcessObservation(launchctlCapture.stdout, context.bundleId)
    : { status: 'failed' };
  const requestedPid = launchctlProcess.status === 'observed' ? launchctlProcess.pid : 0;
  const tocText = fs.existsSync(context.tocPath) ? fs.readFileSync(context.tocPath, 'utf8') : '';
  const tocSummary = exportCapture && commandSucceeded(exportCapture) && tocText.trim().length > 0
    ? parseXctraceTocSummary(tocText)
    : {};
  const traceInventory = readJsonArtifactIfAvailable(context.traceInventoryPath) ?? {
    ...buildTraceBundleInventory(context.traceBundlePath),
    traceBundlePath: toRunRelativePath(context.runDir, context.traceBundlePath),
  };
  if (!fs.existsSync(context.traceInventoryPath)) {
    writeJsonArtifact(context.traceInventoryPath, traceInventory);
  }

  const tocVerified = Boolean(
    tocSummary.startAt &&
    tocSummary.endAt &&
    tocSummary.durationMs !== undefined &&
    tocSummary.template &&
    tocSummary.toolVersion &&
    tocSummary.endReason &&
    tocSummary.deviceId &&
    tocSummary.processPid !== undefined &&
    tocSummary.processName
  );
  const startMs = tocSummary.startAt ? Date.parse(tocSummary.startAt) : Number.NaN;
  const endMs = tocSummary.endAt ? Date.parse(tocSummary.endAt) : Number.NaN;
  const elapsedMs = endMs - startMs;
  const durationToleranceMs = Math.max(1, elapsedMs * 0.01);
  const observedDeviceId = typeof tocSummary.deviceId === 'string' ? tocSummary.deviceId : null;
  const observedPid = Number.isSafeInteger(tocSummary.processPid) ? tocSummary.processPid : null;
  const observedProcessName = typeof tocSummary.processName === 'string' ? tocSummary.processName : null;
  const recordedSimulator = typeof tocSummary.devicePlatform === 'string' && /simulator/iu.test(tocSummary.devicePlatform);
  const runnerWindow = readRunnerActiveLoopWindowRecord(context.runDir);
  const windowVerified = tocVerified &&
    Number.isFinite(elapsedMs) &&
    elapsedMs > 0 &&
    tocSummary.durationMs > 0 &&
    (
      runnerWindow
        ? (
            tocSummary.startAt === runnerWindow.startedAt &&
            tocSummary.endAt === runnerWindow.endedAt &&
            Math.abs(tocSummary.durationMs - runnerWindow.durationMs) <= durationToleranceMs
          )
        : Math.abs(tocSummary.durationMs - elapsedMs) <= durationToleranceMs
    );
  const deviceMismatch = observedDeviceId && observedDeviceId !== context.deviceId;
  const pidMismatch = launchctlProcess.status === 'observed' && observedPid !== null && observedPid !== requestedPid;

  let targetStatus = 'unverified';
  if (
    recordCapture && commandSucceeded(recordCapture) &&
    exportCapture && commandSucceeded(exportCapture) &&
    bootedDeviceObservation.status === 'observed' &&
    bootedDeviceObservation.matchesRequestedDevice === true &&
    appContainerAvailable &&
    launchctlProcess.status === 'observed' &&
    windowVerified &&
    recordedSimulator &&
    !deviceMismatch &&
    !pidMismatch
  ) {
    targetStatus = 'verified';
  } else if (deviceMismatch || pidMismatch) {
    targetStatus = 'mismatch';
  }

  const targetProofPath = resolveTargetBindingArtifactPath({
    args,
    providerDir: path.dirname(outPath),
  });
  toRunRelativePath(context.runDir, targetProofPath);
  const existingTargetProof = readJsonArtifactIfAvailable(targetProofPath);
  const lifecycleSourceCommands = buildLifecycleSourceCommandsForTargetBinding({
    baseArgs: rawInvocationArgs,
    includeCaptureCommand: true,
    normalizeOutputPath: outPath,
    platform: 'ios',
    providerDir: path.dirname(outPath),
    providerId,
    runDir: context.runDir,
    targetBindingPath: targetProofPath,
  });
  const targetWindow = resolveTargetBindingWindowRecord({
    existingTargetBinding: existingTargetProof,
    providerDir: path.dirname(outPath),
    runDir: context.runDir,
  });
  const observedSourceCommands = [
    ['simctl-list-devices', 'startWindow', undefined],
    ['simctl-get-app-container', 'startWindow', undefined],
    ['simctl-launchctl-list', 'startWindow', undefined],
    ['xctrace-record', 'startWindow', undefined],
    ['xctrace-export-toc', 'stopWindow', context.tocPath],
  ].flatMap(([sourceId, phase, outputPath]) => {
    const capture = captures.get(sourceId);
    return capture ? [buildTargetBindingSourceCommand({
      capture,
      outputPath,
      phase,
      runDir: context.runDir,
      sourceId,
    })] : [];
  });

  const trustedStopOutputs = readTrustedIosStopOutputs({ context });
  const captureArtifacts = [
    context.tocPath,
    context.traceInventoryPath,
  ].flatMap((artifactPath) => {
    const runRelativePath = toRunRelativePath(context.runDir, artifactPath);
    return trustedStopOutputs.has(runRelativePath)
      ? [{ commandId: 'stop-native-window', path: runRelativePath }]
      : [];
  });

  writeJsonArtifact(targetProofPath, {
    ...(captureArtifacts.length > 0 ? { captureArtifacts } : {}),
    capturedAt: new Date().toISOString(),
    observedDevice: bootedDeviceObservation,
    observedLaunchctlProcess: launchctlProcess,
    ...(observedDeviceId ? { observedTargetId: observedDeviceId } : {}),
    ...(observedProcessName ? { observedProcessName } : {}),
    ...(observedPid !== null ? { observedProcessPid: observedPid } : {}),
    ...(typeof tocSummary.devicePlatform === 'string' ? { observedTargetPlatform: tocSummary.devicePlatform } : {}),
    ...(typeof tocSummary.template === 'string' ? { observedTemplate: tocSummary.template } : {}),
    ...(typeof tocSummary.toolVersion === 'string' ? { observedToolVersion: tocSummary.toolVersion } : {}),
    bundleId: context.bundleId,
    endReason: tocSummary.endReason ?? null,
    observedAppContainerName: appContainerAvailable ? path.basename(appContainerCapture.stdout.trim()) : null,
    platform: 'ios',
    providerId,
    recordedDeviceId: observedDeviceId,
    recordedDevicePlatform: tocSummary.devicePlatform ?? null,
    recordedProcessName: observedProcessName,
    recordedProcessPid: observedPid,
    requestedAppId: context.bundleId,
    requestedDeviceId: context.deviceId,
    requestedPid,
    requestedTargetId: context.deviceId,
    runId,
    scenarioId,
    schemaVersion: '1.0.0',
    sourceCommands: mergeTargetBindingSourceCommands(lifecycleSourceCommands, observedSourceCommands),
    status: targetStatus,
    template: tocSummary.template ?? null,
    tocVerified,
    toolVersion: tocSummary.toolVersion ?? null,
    traceBundleObserved: traceInventory.exists && traceInventory.fileCount > 0,
    windowVerified,
    window: targetWindow ?? {
      ...(tocSummary.durationMs !== undefined ? { durationMs: tocSummary.durationMs } : {}),
      ...(tocSummary.endAt ? { endedAt: tocSummary.endAt } : {}),
      phase: 'activeLoop',
      ...(tocSummary.startAt ? { startedAt: tocSummary.startAt } : {}),
    },
  });

  const attachments = [
    {
      kind: 'xctrace-export',
      path: toRunRelativePath(context.runDir, context.tocPath),
      sizeBytes: fs.statSync(context.tocPath).size,
    },
    {
      kind: 'ios-target-binding',
      path: toRunRelativePath(context.runDir, targetProofPath),
      sizeBytes: fs.statSync(targetProofPath).size,
    },
    {
      kind: 'xctrace-trace-bundle-inventory',
      path: toRunRelativePath(context.runDir, context.traceInventoryPath),
      sizeBytes: fs.statSync(context.traceInventoryPath).size,
    },
  ];

  const xctraceCaptured = Boolean(
    recordCapture &&
    commandSucceeded(recordCapture) &&
    exportCapture &&
    commandSucceeded(exportCapture) &&
    windowVerified &&
    recordedSimulator &&
    traceInventory.exists &&
    traceInventory.fileCount > 0
  );
  const simctlCaptured = Boolean(
    bootedDeviceCapture &&
    commandSucceeded(bootedDeviceCapture) &&
    appContainerCapture &&
    commandSucceeded(appContainerCapture) &&
    launchctlCapture &&
    commandSucceeded(launchctlCapture) &&
    bootedDeviceObservation.status === 'observed' &&
    bootedDeviceObservation.matchesRequestedDevice === true &&
    appContainerAvailable &&
    launchctlProcess.status === 'observed'
  );
  const diagnosticSources = [
    buildIosDiagnosticSource({
      commandResults: [recordCapture ?? { exitCode: 1, timedOut: false }, exportCapture ?? { exitCode: 1, timedOut: false }],
      dataClasses: ['cpu', 'thread-scheduling', 'native-trace'],
      path: context.tocPath,
      reason: tocVerified
        ? 'The provider preserved managed xctrace output but did not verify full target/window binding.'
        : 'The provider could not verify bounded xctrace TOC facts for target/window evidence.',
      runDir: context.runDir,
      sourceId: 'xctrace',
      status: combinedCommandStatus(
        [recordCapture ?? { timedOut: false, exitCode: 1 }, exportCapture ?? { timedOut: false, exitCode: 1 }],
        xctraceCaptured,
      ),
      toolName: 'xctrace',
    }),
    buildIosDiagnosticSource({
      commandResults: [
        bootedDeviceCapture ?? { timedOut: false, exitCode: 1 },
        appContainerCapture ?? { timedOut: false, exitCode: 1 },
        launchctlCapture ?? { timedOut: false, exitCode: 1 },
      ],
      dataClasses: ['unknown'],
      path: targetProofPath,
      reason: 'The provider could not verify the requested simulator, installed app container, and launchctl process binding.',
      runDir: context.runDir,
      sourceId: 'simctl',
      status: combinedCommandStatus(
        [
          bootedDeviceCapture ?? { timedOut: false, exitCode: 1 },
          appContainerCapture ?? { timedOut: false, exitCode: 1 },
          launchctlCapture ?? { timedOut: false, exitCode: 1 },
        ],
        simctlCaptured,
      ),
      toolName: 'xcrun simctl',
    }),
  ];

  let targetBinding;
  const targetEvidencePath = toRunRelativePath(context.runDir, targetProofPath);
  if (targetStatus === 'verified') {
    targetBinding = {
      status: 'verified',
      appId: context.bundleId,
      deviceId: context.deviceId,
      source: 'provider simctl/xctrace target verification',
      candidateTargets: [{
        appId: context.bundleId,
        bindingStatus: 'observed',
        deviceId: context.deviceId,
        evidencePath: targetEvidencePath,
        platform: 'ios',
        source: 'simctl launchctl list plus xctrace TOC verification',
      }],
    };
  } else if (targetStatus === 'mismatch') {
    targetBinding = {
      status: 'mismatch',
      appId: context.bundleId,
      deviceId: context.deviceId,
      source: 'provider simctl/xctrace target verification',
      reason: 'xctrace recorded a device or pid that does not match the requested simulator launchctl target.',
      candidateTargets: [
        {
          appId: context.bundleId,
          bindingStatus: 'expected',
          deviceId: context.deviceId,
          evidencePath: targetEvidencePath,
          platform: 'ios',
          source: 'provider request',
        },
        {
          bindingStatus: 'observed',
          ...(observedDeviceId ? { deviceId: observedDeviceId } : {}),
          evidencePath: targetEvidencePath,
          platform: 'ios',
          source: 'xctrace TOC',
        },
      ],
    };
  } else {
    targetBinding = {
      status: 'unverified',
      appId: context.bundleId,
      deviceId: context.deviceId,
      source: 'provider simctl/xctrace target verification',
      reason: 'The provider could not verify all requested simulator/app/process/xctrace binding surfaces.',
    };
  }

  const allCommandsSucceeded = [
    bootedDeviceCapture,
    appContainerCapture,
    launchctlCapture,
    recordCapture,
    exportCapture,
  ].every((capture) => capture && commandSucceeded(capture));
  const captureSucceeded = allCommandsSucceeded && xctraceCaptured && simctlCaptured && targetStatus === 'verified';
  const evidence = buildIosNativePerformanceEvidence({
    appId: context.bundleId,
    attachments,
    bundleId: context.bundleId,
    captureMode: 'session',
    capturedAt: targetWindow?.startedAt ?? tocSummary.startAt ?? new Date().toISOString(),
    claimSufficiency: captureSucceeded
      ? {
          status: 'sufficient-for-diagnosis',
          claim: 'iOS simulator native-performance diagnosis from managed active-loop xctrace capture.',
          reason: 'The provider verified simulator/app/process/window ownership but did not export structured comparison metrics.',
          supportingEvidence: ['xctrace', 'simctl', 'targetBinding'],
          missingEvidence: ['structured performance sample suitable for comparison baselines'],
          nextAction: 'Export structured xctrace performance samples before making comparison or release claims.',
        }
      : {
          status: 'insufficient-for-claim',
          claim: 'iOS simulator native-performance diagnosis from managed active-loop xctrace capture.',
          reason: 'One or more managed simctl/xctrace capture, export, or binding verification steps failed or remained unverified.',
          supportingEvidence: ['xctrace-toc', 'target-binding'],
          missingEvidence: ['verified simulator/app/process binding', 'verified bounded xctrace TOC metadata'],
          nextAction: 'Repair the failed lifecycle step, rerun capture, and inspect preserved command records and raw outputs.',
        },
    comparability: {
      status: 'diagnostic-only',
      reason: 'Simulator xctrace metadata and target proof are useful for diagnosis but do not supply structured comparable native-performance samples.',
      policy: 'Use this capture for diagnosis and target/window trust checks, not baseline comparison selection.',
    },
    completenessStatus: captureSucceeded ? 'complete' : 'partial',
    deviceId: context.deviceId,
    diagnosticSources,
    lifecycle: targetWindow
      ? {
          durationMs: targetWindow.durationMs,
          endedAt: targetWindow.endedAt,
          perturbsTiming: true,
          phase: 'activeLoop',
          startedAt: targetWindow.startedAt,
        }
      : {
          perturbsTiming: true,
          phase: 'afterCapture',
        },
    providerId,
    runId,
    scenarioId,
    targetBinding,
    xctraceSummary: xctraceCaptured
      ? {
          durationMs: targetWindow?.durationMs ?? tocSummary.durationMs,
          traceId: `${runId}-xctrace`,
          windowEndMs: targetWindow?.durationMs ?? tocSummary.windowEndMs,
          windowStartMs: 0,
        }
      : undefined,
  });
  writeJsonArtifact(outPath, evidence);
  if (!captureSucceeded) {
    process.exitCode = 1;
  }
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

async function runLifecycleAction({ action, args, platform, rawInvocationArgs }) {
  const runDir = requireStringArg(args, 'run-dir');
  const runId = requireStringArg(args, 'run-id');
  const scenarioId = requireStringArg(args, 'scenario');
  const providerDir = resolveLifecycleProviderDir(args);
  const requestedAppId = resolveRequestedAppId(args, platform);
  const requestedTargetId = resolveRequestedTargetId(args, platform);
  if (!requestedAppId || !requestedTargetId) {
    throw new Error(`Native-performance lifecycle action "${action}" requires both an app id and target id.`);
  }
  validateNativePerformanceRequest({
    args,
    platform,
    required: true,
    requestedAppId,
    requestedTargetId,
    runDir,
    runId,
    scenarioId,
  });

  fs.mkdirSync(providerDir, { recursive: true });
  const providerId = resolveLifecycleProviderId({ args, providerDir });
  const lifecycleStatePath = resolveLifecycleStatePath(providerDir);
  const targetBindingPath = resolveTargetBindingArtifactPath({ args, providerDir });
  const normalizeOutputPath = path.join(providerDir, 'native-performance.json');
  toRunRelativePath(runDir, targetBindingPath);
  const previousState = readJsonArtifactIfAvailable(lifecycleStatePath) ?? {};
  const now = new Date().toISOString();
  const androidCaptureEnabled = (
    normalizePlatform(platform) === 'android' &&
    (args['capture-android-adb'] === true || process.env.ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE === '1')
  );
  const iosCaptureEnabled = (
    normalizePlatform(platform) === 'ios' &&
    (args['capture-ios-xctrace'] === true || process.env.ASL_NATIVE_PERFORMANCE_IOS_CAPTURE === '1')
  );
  const androidContext = androidCaptureEnabled
    ? resolveAndroidAdbCaptureContext({
        args,
        outPath: normalizeOutputPath,
        providerId,
        requireRequest: true,
        runId,
        scenarioId,
      })
    : null;
  const iosContext = iosCaptureEnabled
    ? resolveIosXctraceCaptureContext({
        args,
        outPath: normalizeOutputPath,
        providerId,
        requireRequest: true,
        runId,
        scenarioId,
      })
    : null;
  const nextState = {
    ...previousState,
    platform: normalizePlatform(platform),
    providerId,
    requestedAppId,
    requestedTargetId,
    runId,
    scenarioId,
  };

  if (action === 'start-window') {
    const actionSucceeded = androidContext
      ? await resetAndroidAdbWindow(androidContext)
      : iosContext
        ? await startManagedIosXctraceWindow(iosContext)
        : true;
    nextState.startedAt = now;
    nextState.startWindowStatus = actionSucceeded ? 'completed' : 'failed';
    delete nextState.endedAt;
    delete nextState.finalizedAt;
    delete nextState.stopWindowStatus;
    if (!actionSucceeded) {
      process.exitCode = 1;
    }
  } else if (action === 'stop-window') {
    const actionSucceeded = androidContext
      ? await captureAndroidAdbWindow(androidContext)
      : iosContext
        ? await stopManagedIosXctraceWindow(iosContext)
        : true;
    nextState.startedAt = typeof nextState.startedAt === 'string' ? nextState.startedAt : now;
    nextState.endedAt = now;
    nextState.stopWindowStatus = actionSucceeded ? 'completed' : 'failed';
    if (!actionSucceeded) {
      process.exitCode = 1;
    }
  } else {
    nextState.finalizedAt = now;
    nextState.startedAt = typeof nextState.startedAt === 'string' ? nextState.startedAt : now;
    nextState.endedAt = typeof nextState.endedAt === 'string' ? nextState.endedAt : now;
  }

  writeJsonArtifact(lifecycleStatePath, nextState);
  if (action === 'finalize') {
    return;
  }
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
 * Reads an optional text artifact path.
 *
 * @param {Record<string, string | boolean>} args
 * @param {string} key
 * @returns {string | undefined}
 */
function readOptionalText(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || !fs.existsSync(value)) {
    return undefined;
  }
  return fs.readFileSync(value, 'utf8');
}

/**
 * Reads an optional JSON object artifact path.
 *
 * @param {Record<string, string | boolean>} args
 * @param {string} key
 * @returns {Record<string, unknown> | undefined}
 */
function readOptionalJsonObject(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0 || !fs.existsSync(value)) {
    return undefined;
  }

  const parsed = JSON.parse(fs.readFileSync(value, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected --${key} to point at a JSON object.`);
  }
  return parsed;
}

/**
 * Builds optional raw attachment metadata for provider-owned text captures.
 *
 * @param {Record<string, string | boolean>} args
 * @returns {Array<{kind: string, path: string, sizeBytes: number}>}
 */
function buildNativePerformanceAttachments(args) {
  const attachments = [];
  for (const entry of [
    { arg: 'gfxinfo', kind: 'raw-gfxinfo' },
    { arg: 'framestats', kind: 'raw-framestats' },
    { arg: 'meminfo', kind: 'raw-meminfo' },
    { arg: 'trace-processor-summary', kind: 'trace-processor-summary' },
    { arg: 'xctrace-summary', kind: 'xctrace-summary' },
    { arg: 'metrickit-summary', kind: 'metrickit-summary' },
  ]) {
    const value = args[entry.arg];
    if (typeof value !== 'string' || value.length === 0 || !fs.existsSync(value)) {
      continue;
    }
    attachments.push({
      kind: entry.kind,
      path: value,
      sizeBytes: fs.statSync(value).size,
    });
  }
  return attachments;
}

/**
 * Writes deterministic scaffold native-performance evidence for uncaptured lanes.
 *
 * @param {{outPath: string, platform: string, providerId: string, runId: string, scenarioId: string}} options
 * @returns {void}
 */
function writeNativePerformanceScaffold({
  outPath,
  platform,
  providerId,
  runId,
  scenarioId,
}) {
  const normalizedPlatform = normalizePlatform(platform);
  const diagnosticSources = buildDiagnosticSources(normalizedPlatform);
  writeJsonArtifact(outPath, {
    schemaVersion: '1.0.0',
    providerId,
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
 * @returns {Promise<void>}
 */
async function main() {
  const invocation = resolvePositionalAction(process.argv.slice(2));
  if (invocation.action === '__internal-ios-xctrace-session') {
    await runInternalIosXctraceSession(parseArgs(invocation.args));
    return;
  }
  const args = parseArgs(invocation.args);
  const platform = requireStringArg(args, 'platform');
  if (
    invocation.action === 'start-window'
    || invocation.action === 'stop-window'
    || invocation.action === 'finalize'
  ) {
    await runLifecycleAction({
      action: invocation.action,
      args,
      platform,
      rawInvocationArgs: invocation.args,
    });
    return;
  }

  if (invocation.action !== 'normalize') {
    throw new Error(`Unsupported native-performance provider action "${invocation.action}".`);
  }

  const outPath = requireStringArg(args, 'out');
  const runDir = requireStringArg(args, 'run-dir');
  const providerId = resolveProviderId({ outPath, runDir });
  const runId = requireStringArg(args, 'run-id');
  const scenarioId = requireStringArg(args, 'scenario');
  const requireManagedRequest = typeof args['provider-id'] === 'string' || typeof args['provider-dir'] === 'string';
  if (platform === 'android') {
    const liveAdbCapture = args['capture-android-adb'] === true || process.env.ASL_NATIVE_PERFORMANCE_ANDROID_CAPTURE === '1';
    if (liveAdbCapture) {
      await captureAndroidAdbEvidence({
        args,
        outPath,
        providerId,
        rawInvocationArgs: invocation.args,
        requireRequest: requireManagedRequest,
        runId,
        scenarioId,
      });
      return;
    }
    writeJsonArtifact(outPath, buildAndroidNativePerformanceEvidence({
      appId: typeof args.app === 'string' ? args.app : undefined,
      attachments: buildNativePerformanceAttachments(args),
      deviceId: typeof args.device === 'string' ? args.device : undefined,
      framestatsText: readOptionalText(args, 'framestats'),
      gfxinfoText: readOptionalText(args, 'gfxinfo'),
      meminfoText: readOptionalText(args, 'meminfo'),
      providerId,
      runId,
      scenarioId,
      traceProcessorSummary: readOptionalJsonObject(args, 'trace-processor-summary'),
    }));
    return;
  }

  if (platform === 'ios') {
    const liveXctraceCapture = args['capture-ios-xctrace'] === true || process.env.ASL_NATIVE_PERFORMANCE_IOS_CAPTURE === '1';
    if (liveXctraceCapture) {
      if (requireManagedRequest) {
        await normalizeManagedIosXctraceEvidence({
          args,
          outPath,
          providerId,
          rawInvocationArgs: invocation.args,
          runId,
          scenarioId,
        });
      } else {
        await captureIosXctraceEvidence({
          args,
          outPath,
          providerId,
          rawInvocationArgs: invocation.args,
          requireRequest: false,
          runId,
          scenarioId,
        });
      }
      return;
    }
    const metricKitText = readOptionalText(args, 'metrickit-summary');
    const xctraceText = readOptionalText(args, 'xctrace-summary');
    writeJsonArtifact(outPath, buildIosNativePerformanceEvidence({
      appId: typeof args.app === 'string' ? args.app : undefined,
      attachments: buildNativePerformanceAttachments(args),
      bundleId: typeof args.bundle === 'string' ? args.bundle : undefined,
      deviceId: typeof args.device === 'string' ? args.device : undefined,
      metricKitSummary: metricKitText ? parseIosMetricKitSummaryText(metricKitText) : undefined,
      providerId,
      runId,
      scenarioId,
      xctraceSummary: xctraceText ? parseIosXctraceSummaryText(xctraceText) : undefined,
    }));
    return;
  }

  writeNativePerformanceScaffold({
    outPath,
    platform,
    providerId,
    runId,
    scenarioId,
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
