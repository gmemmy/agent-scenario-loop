const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

type IosSimctlProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | string;

type IosSimctlCommandResult = {
  action: string;
  args: string[];
  command: string;
  exitCode: number;
  rawFileName: string;
  signal?: IosSimctlProcessSignal | null;
  stderr: string;
  stdout: string;
};

type IosSimctlCommandExecutor = (command: string, args: string[]) => Promise<{
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type IosSimctlDriverOptions = {
  deviceUdid: string;
  executor: IosSimctlCommandExecutor;
  recorderFactory?: IosSimctlRecorderFactory;
  xcrunPath: string;
};

type IosSimctlRecorderState =
  | 'starting'
  | 'active'
  | 'stopping'
  | 'finalizing'
  | 'finalized'
  | 'failed'
  | 'timed_out'
  | 'cancelled';
type IosSimctlRecorderProcess = {
  kill: (signal: IosSimctlProcessSignal) => boolean;
  pid?: number;
  on: (event: 'close' | 'error' | 'exit', listener: (...args: any[]) => void) => void;
  stderr?: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null;
  stdout?: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null;
};
type IosSimctlRecorderFactory = (command: string, args: string[]) => IosSimctlRecorderProcess;
type IosSimctlRecordOptions = {
  finalizeTimeoutMs?: number;
  outputPath: string;
  rawFileName?: string;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
};
type IosSimctlVideoValidationReason =
  | 'valid'
  | 'missing'
  | 'not-file'
  | 'zero-bytes'
  | 'truncated-header'
  | 'missing-ftyp'
  | 'unsupported-ftyp-brand'
  | 'read-error';
type IosSimctlVideoValidation = {
  compatibleBrands: string[];
  exists: boolean;
  hasFtyp: boolean;
  majorBrand: string | null;
  reason: IosSimctlVideoValidationReason;
  sizeBytes: number | null;
  valid: boolean;
};
type IosSimctlRecorderTimelineEntry = {
  at: string;
  reason?: string;
  state: IosSimctlRecorderState;
};
type IosSimctlRecorderCleanup = {
  orphaned: boolean;
  signals: IosSimctlProcessSignal[];
};
type IosSimctlRecordResult = IosSimctlCommandResult & {
  capturePath?: string;
  cleanup: IosSimctlRecorderCleanup;
  state: IosSimctlRecorderState;
  timeline: IosSimctlRecorderTimelineEntry[];
  validation: IosSimctlVideoValidation;
};
type IosSimctlRecording = {
  args: string[];
  command: string;
  outputPath: string;
  rawFileName: string;
  state: IosSimctlRecorderState;
  stop: (reason?: 'cancelled' | 'completed') => Promise<IosSimctlRecordResult>;
};

type IosSimctlDeepLinkOptions = {
  rawFileName?: string;
  url: string;
};

type IosSimctlReadLogsOptions = {
  last?: string;
  predicate?: string;
  rawFileName?: string;
};

type IosSimctlScreenshotOptions = {
  display?: string;
  imageType?: string;
  mask?: string;
  outputPath: string;
  rawFileName?: string;
};

type IosSimctlDriver = {
  appInfo: (bundleId: string) => Promise<IosSimctlCommandResult>;
  launchBundle: (bundleId: string) => Promise<IosSimctlCommandResult>;
  openDeepLink: (options: IosSimctlDeepLinkOptions) => Promise<IosSimctlCommandResult>;
  readLogs: (options?: IosSimctlReadLogsOptions) => Promise<IosSimctlCommandResult>;
  startRecording: (options: IosSimctlRecordOptions) => Promise<IosSimctlRecording>;
  screenshot: (options: IosSimctlScreenshotOptions) => Promise<IosSimctlCommandResult>;
  terminateBundle: (bundleId: string) => Promise<IosSimctlCommandResult>;
};

const PROFILE_LOG_PREDICATE = 'eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"';
const DEFAULT_IOS_RECORD_START_TIMEOUT_MS = 10;
const DEFAULT_IOS_RECORD_STOP_TIMEOUT_MS = 2000;
const DEFAULT_IOS_RECORD_FINALIZE_TIMEOUT_MS = 2000;
const IOS_RECORD_FORCE_KILL_WAIT_MS = 500;
const IOS_RECORD_STREAM_LIMIT_BYTES = 256 * 1024;
const IOS_RECORD_STREAM_TRUNCATED_MARKER = '\n[output truncated at 262144 bytes]';
const IOS_SIMCTL_VIDEO_BRANDS = new Set([
  '3gp4',
  'M4A ',
  'M4B ',
  'M4P ',
  'M4V ',
  'avc1',
  'dash',
  'hev1',
  'hvc1',
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'qt  ',
]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRecordTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function appendBoundedRecorderOutput(current: string, chunk: unknown): string {
  if (Buffer.byteLength(current) >= IOS_RECORD_STREAM_LIMIT_BYTES) {
    return current.endsWith(IOS_RECORD_STREAM_TRUNCATED_MARKER)
      ? current
      : current + IOS_RECORD_STREAM_TRUNCATED_MARKER;
  }
  const remainingBytes = IOS_RECORD_STREAM_LIMIT_BYTES - Buffer.byteLength(current);
  const next = Buffer.from(String(chunk));
  if (next.byteLength <= remainingBytes) return current + next.toString();
  return current + next.subarray(0, remainingBytes).toString() + IOS_RECORD_STREAM_TRUNCATED_MARKER;
}

function isKnownVideoBrand(brand: string | null): boolean {
  return Boolean(brand && IOS_SIMCTL_VIDEO_BRANDS.has(brand));
}

async function validateIosRecordedVideo(outputPath: string): Promise<IosSimctlVideoValidation> {
  const stat = await fsp.stat(outputPath).catch(() => null);
  if (!stat) {
    return {
      compatibleBrands: [],
      exists: false,
      hasFtyp: false,
      majorBrand: null,
      reason: 'missing',
      sizeBytes: null,
      valid: false,
    };
  }

  if (!stat.isFile()) {
    return {
      compatibleBrands: [],
      exists: true,
      hasFtyp: false,
      majorBrand: null,
      reason: 'not-file',
      sizeBytes: stat.size,
      valid: false,
    };
  }

  if (stat.size === 0) {
    return {
      compatibleBrands: [],
      exists: true,
      hasFtyp: false,
      majorBrand: null,
      reason: 'zero-bytes',
      sizeBytes: stat.size,
      valid: false,
    };
  }

  const file = await fsp.open(outputPath, 'r').catch(() => null);
  if (!file) {
    return {
      compatibleBrands: [],
      exists: true,
      hasFtyp: false,
      majorBrand: null,
      reason: 'read-error',
      sizeBytes: stat.size,
      valid: false,
    };
  }

  const header = Buffer.alloc(16);
  const headerRead = await file.read(header, 0, header.length, 0).catch(() => null);
  if (!headerRead || headerRead.bytesRead < header.length) {
    await file.close();
    return {
      compatibleBrands: [],
      exists: true,
      hasFtyp: false,
      majorBrand: null,
      reason: 'truncated-header',
      sizeBytes: stat.size,
      valid: false,
    };
  }

  const hasFtyp = header.toString('ascii', 4, 8) === 'ftyp';
  if (!hasFtyp) {
    await file.close();
    return {
      compatibleBrands: [],
      exists: true,
      hasFtyp: false,
      majorBrand: null,
      reason: 'missing-ftyp',
      sizeBytes: stat.size,
      valid: false,
    };
  }

  const boxSize = header.readUInt32BE(0);
  if (boxSize < 16 || boxSize > stat.size || (boxSize - 16) % 4 !== 0) {
    await file.close();
    return {
      compatibleBrands: [], exists: true, hasFtyp: true, majorBrand: null,
      reason: 'truncated-header', sizeBytes: stat.size, valid: false,
    };
  }
  const majorBrand = header.toString('ascii', 8, 12);
  const compatibleBrands: string[] = [];
  let compatibleBrandKnown = false;
  const chunk = Buffer.alloc(64 * 1024);
  for (let position = 16; position < boxSize;) {
    const length = Math.min(chunk.length, boxSize - position);
    const result = await file.read(chunk, 0, length, position).catch(() => null);
    if (!result || result.bytesRead !== length) {
      await file.close();
      return {
        compatibleBrands, exists: true, hasFtyp: true, majorBrand,
        reason: 'read-error', sizeBytes: stat.size, valid: false,
      };
    }
    for (let offset = 0; offset < length; offset += 4) {
      const brand = chunk.toString('ascii', offset, offset + 4);
      if (compatibleBrands.length < 64) compatibleBrands.push(brand);
      compatibleBrandKnown ||= isKnownVideoBrand(brand);
    }
    position += length;
  }
  await file.close();
  const valid = isKnownVideoBrand(majorBrand) || compatibleBrandKnown;

  return {
    compatibleBrands,
    exists: true,
    hasFtyp: true,
    majorBrand,
    reason: valid ? 'valid' : 'unsupported-ftyp-brand',
    sizeBytes: stat.size,
    valid,
  };
}

/**
 * Adds stable driver metadata to one simctl command result.
 *
 * @param {{action: string, rawFileName: string, result: Awaited<ReturnType<IosSimctlCommandExecutor>>}} options
 * @returns {IosSimctlCommandResult}
 */
function buildDriverResult({
  action,
  rawFileName,
  result,
}: {
  action: string;
  rawFileName: string;
  result: Awaited<ReturnType<IosSimctlCommandExecutor>>;
}): IosSimctlCommandResult {
  return {
    action,
    args: result.args,
    command: result.command,
    exitCode: result.exitCode,
    rawFileName,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/**
 * Combines stdout and stderr into the raw evidence text written by callers.
 *
 * @param {{stdout: string, stderr: string}} result
 * @returns {string}
 */
function formatIosSimctlRawOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/**
 * Creates a small simctl-backed iOS driver for lifecycle helpers and evidence capture.
 *
 * The generic driver capabilities exposed here are `readLogs`, `record`, and `screenshot`.
 * Launching bundles, terminating bundles, and opening deep links remain
 * lifecycle helpers used by built-in runners.
 *
 * @param {IosSimctlDriverOptions} options
 * @returns {IosSimctlDriver}
 */
function createIosSimctlDriver({
  deviceUdid,
  executor,
  recorderFactory = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  xcrunPath,
}: IosSimctlDriverOptions): IosSimctlDriver {
  return {
    async appInfo(bundleId: string): Promise<IosSimctlCommandResult> {
      const rawFileName = 'ios-app-info.txt';
      const result = await executor(xcrunPath, ['simctl', 'appinfo', deviceUdid, bundleId]);
      return buildDriverResult({ action: 'appInfo', rawFileName, result });
    },

    async launchBundle(bundleId: string): Promise<IosSimctlCommandResult> {
      const rawFileName = 'ios-launch.txt';
      const result = await executor(xcrunPath, ['simctl', 'launch', deviceUdid, bundleId]);
      return buildDriverResult({ action: 'launchBundle', rawFileName, result });
    },

    async openDeepLink({
      rawFileName = 'ios-deep-link.txt',
      url,
    }: IosSimctlDeepLinkOptions): Promise<IosSimctlCommandResult> {
      const result = await executor(xcrunPath, ['simctl', 'openurl', deviceUdid, url]);
      return buildDriverResult({ action: 'openDeepLink', rawFileName, result });
    },

    async readLogs({
      last = '2m',
      predicate = PROFILE_LOG_PREDICATE,
      rawFileName = 'ios-simctl-log.txt',
    }: IosSimctlReadLogsOptions = {}): Promise<IosSimctlCommandResult> {
      const result = await executor(xcrunPath, [
        'simctl',
        'spawn',
        deviceUdid,
        'log',
        'show',
        '--style',
        'compact',
        '--last',
        last,
        '--predicate',
        predicate,
      ]);
      return buildDriverResult({ action: 'readLogs', rawFileName, result });
    },

    async startRecording({
      finalizeTimeoutMs,
      outputPath,
      rawFileName = 'ios-record-video.txt',
      startTimeoutMs,
      stopTimeoutMs,
    }: IosSimctlRecordOptions): Promise<IosSimctlRecording> {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      await fsp.rm(outputPath, { force: true });
      const args = ['simctl', 'io', deviceUdid, 'recordVideo', outputPath];
      const startBudgetMs = normalizeRecordTimeout(startTimeoutMs, DEFAULT_IOS_RECORD_START_TIMEOUT_MS);
      const stopBudgetMs = normalizeRecordTimeout(stopTimeoutMs, DEFAULT_IOS_RECORD_STOP_TIMEOUT_MS);
      const finalizeBudgetMs = normalizeRecordTimeout(finalizeTimeoutMs, DEFAULT_IOS_RECORD_FINALIZE_TIMEOUT_MS);
      let child: IosSimctlRecorderProcess;
      try {
        child = recorderFactory(xcrunPath, args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timeline: IosSimctlRecorderTimelineEntry[] = [
          { at: new Date().toISOString(), state: 'starting' },
          { at: new Date().toISOString(), reason: message, state: 'failed' },
        ];
        return {
          args,
          command: xcrunPath,
          outputPath,
          rawFileName,
          state: 'failed',
          async stop(reason = 'completed') {
            const validation = await validateIosRecordedVideo(outputPath);
            const state: IosSimctlRecorderState = reason === 'cancelled' ? 'cancelled' : 'failed';
            return {
              action: 'record',
              args,
              command: xcrunPath,
              cleanup: { orphaned: false, signals: [] },
              exitCode: 1,
              rawFileName,
              signal: null,
              stderr: message,
              stdout: [
                `state=${state}`,
                `validationReason=${validation.reason}`,
                `startTimeoutMs=${startBudgetMs}`,
                `stopTimeoutMs=${stopBudgetMs}`,
                `finalizeTimeoutMs=${finalizeBudgetMs}`,
              ].join('\n'),
              state,
              timeline,
              validation,
            };
          },
        };
      }

      let state: IosSimctlRecorderState = 'starting';
      let stdout = '';
      let stderr = '';
      let settled = false;
      let exitCode: number | null = null;
      let signal: IosSimctlProcessSignal | null = null;
      const signals: IosSimctlProcessSignal[] = [];
      let orphaned = false;
      let stopPromise: Promise<IosSimctlRecordResult> | null = null;
      const timeline: IosSimctlRecorderTimelineEntry[] = [
        { at: new Date().toISOString(), state: 'starting' },
      ];
      const transition = (nextState: IosSimctlRecorderState, reason?: string): void => {
        state = nextState;
        timeline.push({ at: new Date().toISOString(), ...(reason ? { reason } : {}), state: nextState });
      };
      let resolveExit: (() => void) | null = null;
      const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
      const markSettled = ({
        code,
        error,
        exitSignal,
      }: {
        code: number | null;
        error?: Error;
        exitSignal: IosSimctlProcessSignal | null;
      }): void => {
        if (settled) {
          return;
        }
        settled = true;
        exitCode = code;
        signal = exitSignal;
        if (error) {
          stderr = [stderr, error.message].filter(Boolean).join('\n');
        }
        resolveExit?.();
      };
      const sendSignal = (nextSignal: IosSimctlProcessSignal): boolean => {
        signals.push(nextSignal);
        try {
          return child.kill(nextSignal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr = [stderr, `kill(${nextSignal}) failed: ${message}`].filter(Boolean).join('\n');
          return false;
        }
      };
      const waitForExit = async (timeoutMs: number): Promise<boolean> => {
        if (settled) {
          return true;
        }
        return Promise.race([
          exited.then(() => true),
          delay(timeoutMs).then(() => false as const),
        ]);
      };

      child.stdout?.on('data', (chunk) => { stdout = appendBoundedRecorderOutput(stdout, chunk); });
      child.stderr?.on('data', (chunk) => { stderr = appendBoundedRecorderOutput(stderr, chunk); });
      child.on('error', (error: Error) => {
        transition('failed', error.message);
        markSettled({ code: 1, error, exitSignal: null });
      });
      child.on('exit', (code: number | null, exitSignal: IosSimctlProcessSignal | null) => {
        exitCode = code;
        signal = exitSignal;
      });
      child.on('close', (code: number | null, exitSignal: IosSimctlProcessSignal | null) => {
        markSettled({ code, exitSignal });
      });

      const exitedDuringStart = await waitForExit(startBudgetMs);
      if (!exitedDuringStart && state === 'starting') {
        transition('active', 'start-window-elapsed');
      } else if (state === 'starting') {
        transition('failed', 'recorder-exited-before-active');
      }

      const recording: IosSimctlRecording = {
        args,
        command: xcrunPath,
        outputPath,
        rawFileName,
        state,
        async stop(reason = 'completed') {
          if (stopPromise) {
            return stopPromise;
          }
          stopPromise = (async (): Promise<IosSimctlRecordResult> => {
            if (!settled) {
              transition('stopping', reason === 'cancelled' ? 'stop-requested-cancelled' : 'stop-requested');
              sendSignal('SIGINT');
              const stoppedAfterSigint = await waitForExit(stopBudgetMs);
              if (!stoppedAfterSigint) {
                transition('finalizing', 'sigint-timeout');
                sendSignal('SIGTERM');
                const stoppedAfterSigterm = await waitForExit(finalizeBudgetMs);
                if (!stoppedAfterSigterm) {
                  transition('timed_out', 'sigterm-timeout');
                  sendSignal('SIGKILL');
                  const stoppedAfterSigkill = await waitForExit(IOS_RECORD_FORCE_KILL_WAIT_MS);
                  if (!stoppedAfterSigkill) {
                    orphaned = true;
                    stderr = [stderr, 'recordVideo process did not exit after SIGKILL'].filter(Boolean).join('\n');
                  }
                }
              }
            }

            const validation = await validateIosRecordedVideo(outputPath);
            if (state !== 'timed_out' && state !== 'failed') {
              if (reason === 'cancelled') {
                transition('cancelled', reason);
              } else if (exitCode === 0 && validation.valid) {
                transition('finalized', 'finalized-valid-output');
              } else {
                transition('failed', validation.reason);
              }
            }
            recording.state = state;

            const stdoutSummary = [
              stdout,
              `state=${state}`,
              `exitCode=${exitCode ?? 'null'}`,
              `signal=${signal ?? 'null'}`,
              `pid=${child.pid ?? 'null'}`,
              `validationReason=${validation.reason}`,
              `startTimeoutMs=${startBudgetMs}`,
              `stopTimeoutMs=${stopBudgetMs}`,
              `finalizeTimeoutMs=${finalizeBudgetMs}`,
              `cleanupSignals=${signals.join(',') || 'none'}`,
              `cleanupOrphaned=${String(orphaned)}`,
              ...(validation.majorBrand ? [`majorBrand=${validation.majorBrand}`] : []),
              ...(validation.compatibleBrands.length > 0 ? [`compatibleBrands=${validation.compatibleBrands.join(',')}`] : []),
            ].filter(Boolean).join('\n');

            return {
              action: 'record',
              args,
              command: xcrunPath,
              cleanup: { orphaned, signals: [...signals] },
              exitCode: state === 'finalized' ? 0 : Math.max(exitCode ?? 1, 1),
              rawFileName,
              signal,
              stderr,
              stdout: stdoutSummary,
              state,
              timeline: [...timeline],
              validation,
              ...(validation.valid ? { capturePath: outputPath } : {}),
            };
          })();
          return stopPromise;
        },
      };
      return recording;
    },

    async screenshot({
      display,
      imageType,
      mask,
      outputPath,
      rawFileName = 'ios-screenshot.txt',
    }: IosSimctlScreenshotOptions): Promise<IosSimctlCommandResult> {
      const args = ['simctl', 'io', deviceUdid, 'screenshot'];
      if (imageType) {
        args.push(`--type=${imageType}`);
      }
      if (display) {
        args.push(`--display=${display}`);
      }
      if (mask) {
        args.push(`--mask=${mask}`);
      }
      args.push(outputPath);
      const result = await executor(xcrunPath, args);
      return buildDriverResult({ action: 'screenshot', rawFileName, result });
    },

    async terminateBundle(bundleId: string): Promise<IosSimctlCommandResult> {
      const rawFileName = 'ios-terminate.txt';
      const result = await executor(xcrunPath, ['simctl', 'terminate', deviceUdid, bundleId]);
      return buildDriverResult({ action: 'terminateBundle', rawFileName, result });
    },
  };
}

export {
  PROFILE_LOG_PREDICATE,
  createIosSimctlDriver,
  formatIosSimctlRawOutput,
};

export type {
  IosSimctlCommandExecutor,
  IosSimctlCommandResult,
  IosSimctlDeepLinkOptions,
  IosSimctlDriver,
  IosSimctlDriverOptions,
  IosSimctlReadLogsOptions,
  IosSimctlRecorderFactory,
  IosSimctlRecorderProcess,
  IosSimctlRecorderState,
  IosSimctlRecording,
  IosSimctlRecordOptions,
  IosSimctlScreenshotOptions,
  IosSimctlVideoValidation,
  IosSimctlVideoValidationReason,
};
