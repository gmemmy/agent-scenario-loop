type AndroidAdbCommandResult = {
  action: string;
  args: string[];
  command: string;
  exitCode: number;
  rawFileName: string;
  stderr: string;
  stdout: string;
};

type AndroidAdbDriver = {
  clearLogs: () => Promise<AndroidAdbCommandResult>;
  launchPackage: (packageName: string) => Promise<AndroidAdbCommandResult>;
  openDeepLink: (options: AndroidAdbDeepLinkOptions) => Promise<AndroidAdbCommandResult>;
  readLogs: (options?: AndroidAdbReadLogsOptions) => Promise<AndroidAdbCommandResult>;
};

type AndroidAdbDriverOptions = {
  adbPath: string;
  deviceSerial: string;
  executor: AndroidAdbCommandExecutor;
};

type AndroidAdbCommandExecutor = (command: string, args: string[]) => Promise<{
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type AndroidAdbDeepLinkOptions = {
  packageName?: string | null;
  rawFileName?: string;
  url: string;
};

type AndroidAdbReadLogsOptions = {
  lines?: number;
  rawFileName?: string;
};

/**
 * Quotes one argument for the Android device shell.
 *
 * `adb shell` still lets the device shell interpret metacharacters in later
 * tokens, so deep-link URLs with `&` must be quoted before execution.
 *
 * @param {string} value
 * @returns {string}
 */
function quoteAndroidShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Adds stable driver metadata to one adb command result.
 *
 * @param {{action: string, rawFileName: string, result: Awaited<ReturnType<AndroidAdbCommandExecutor>>}} options
 * @returns {AndroidAdbCommandResult}
 */
function buildDriverResult({
  action,
  rawFileName,
  result,
}: {
  action: string;
  rawFileName: string;
  result: Awaited<ReturnType<AndroidAdbCommandExecutor>>;
}): AndroidAdbCommandResult {
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
function formatAndroidAdbRawOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/**
 * Creates a small adb-backed Android driver for lifecycle helpers and log capture.
 *
 * The generic driver capability exposed here is `readLogs`. Launching packages,
 * clearing logcat, and opening deep links are Android lifecycle helpers used by
 * built-in runners; they are intentionally not advertised as portable driver
 * actions.
 *
 * @param {AndroidAdbDriverOptions} options
 * @returns {AndroidAdbDriver}
 */
function createAndroidAdbDriver({
  adbPath,
  deviceSerial,
  executor,
}: AndroidAdbDriverOptions): AndroidAdbDriver {
  return {
    async clearLogs(): Promise<AndroidAdbCommandResult> {
      const rawFileName = 'adb-logcat-clear.txt';
      const result = await executor(adbPath, ['-s', deviceSerial, 'logcat', '-c']);
      return buildDriverResult({ action: 'clearLogs', rawFileName, result });
    },

    async launchPackage(packageName: string): Promise<AndroidAdbCommandResult> {
      const rawFileName = 'adb-launch.txt';
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        'monkey',
        '-p',
        packageName,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);
      return buildDriverResult({ action: 'launchPackage', rawFileName, result });
    },

    async openDeepLink({
      packageName = null,
      rawFileName = 'adb-deep-link.txt',
      url,
    }: AndroidAdbDeepLinkOptions): Promise<AndroidAdbCommandResult> {
      const deepLinkCommand = [
        'am',
        'start',
        '-a',
        quoteAndroidShellArg('android.intent.action.VIEW'),
        '-d',
        quoteAndroidShellArg(url),
        ...(packageName ? ['-p', quoteAndroidShellArg(packageName)] : []),
      ].join(' ');
      const result = await executor(adbPath, ['-s', deviceSerial, 'shell', deepLinkCommand]);
      return buildDriverResult({ action: 'openDeepLink', rawFileName, result });
    },

    async readLogs({
      lines = 1000,
      rawFileName = 'adb-logcat.txt',
    }: AndroidAdbReadLogsOptions = {}): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'logcat',
        '-d',
        '-v',
        'time',
        '-t',
        String(lines),
      ]);
      return buildDriverResult({ action: 'readLogs', rawFileName, result });
    },
  };
}

export {
  createAndroidAdbDriver,
  formatAndroidAdbRawOutput,
  quoteAndroidShellArg,
};

export type {
  AndroidAdbCommandExecutor,
  AndroidAdbCommandResult,
  AndroidAdbDeepLinkOptions,
  AndroidAdbDriver,
  AndroidAdbDriverOptions,
  AndroidAdbReadLogsOptions,
};
