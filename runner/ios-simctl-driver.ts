type IosSimctlCommandResult = {
  action: string;
  args: string[];
  command: string;
  exitCode: number;
  rawFileName: string;
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
  xcrunPath: string;
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
  launchBundle: (bundleId: string) => Promise<IosSimctlCommandResult>;
  openDeepLink: (options: IosSimctlDeepLinkOptions) => Promise<IosSimctlCommandResult>;
  readLogs: (options?: IosSimctlReadLogsOptions) => Promise<IosSimctlCommandResult>;
  screenshot: (options: IosSimctlScreenshotOptions) => Promise<IosSimctlCommandResult>;
  terminateBundle: (bundleId: string) => Promise<IosSimctlCommandResult>;
};

const PROFILE_LOG_PREDICATE = 'eventMessage CONTAINS "[profile-event]" OR eventMessage CONTAINS "[profile-session]"';

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
 * The generic driver capabilities exposed here are `readLogs` and `screenshot`.
 * Launching bundles, terminating bundles, and opening deep links remain
 * lifecycle helpers used by built-in runners.
 *
 * @param {IosSimctlDriverOptions} options
 * @returns {IosSimctlDriver}
 */
function createIosSimctlDriver({
  deviceUdid,
  executor,
  xcrunPath,
}: IosSimctlDriverOptions): IosSimctlDriver {
  return {
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
  IosSimctlScreenshotOptions,
};
