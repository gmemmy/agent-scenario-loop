const fsp = require('node:fs/promises');
const path = require('node:path');

type AndroidAdbCommandResult = {
  action: string;
  args: string[];
  capturePath?: string;
  command: string;
  errorCode?: number | string;
  errorMessage?: string;
  elapsedMs?: number;
  exitCode: number;
  maxBufferBytes?: number;
  outputLimitExceeded?: boolean;
  pollCount?: number;
  rawFileName: string;
  stderr: string;
  stdout: string;
  stdoutBuffer?: Uint8Array;
  timedOut?: boolean;
  timeoutMs?: number;
};

type AndroidAdbDriver = {
  assertVisible: (options: AndroidAdbAssertVisibleOptions) => Promise<AndroidAdbCommandResult>;
  clearLogs: () => Promise<AndroidAdbCommandResult>;
  inspectTree: (options?: AndroidAdbInspectTreeOptions) => Promise<AndroidAdbCommandResult>;
  launchPackage: (packageName: string) => Promise<AndroidAdbCommandResult>;
  longPress: (options: AndroidAdbLongPressOptions) => Promise<AndroidAdbCommandResult>;
  openDeepLink: (options: AndroidAdbDeepLinkOptions) => Promise<AndroidAdbCommandResult>;
  pressKey: (options: AndroidAdbPressKeyOptions) => Promise<AndroidAdbCommandResult>;
  readLogs: (options?: AndroidAdbReadLogsOptions) => Promise<AndroidAdbCommandResult>;
  record: (options: AndroidAdbRecordOptions) => Promise<AndroidAdbCommandResult>;
  screenshot: (options?: AndroidAdbScreenshotOptions) => Promise<AndroidAdbCommandResult>;
  scroll: (options: AndroidAdbScrollOptions) => Promise<AndroidAdbCommandResult>;
  swipe: (options: AndroidAdbSwipeOptions) => Promise<AndroidAdbCommandResult>;
  tap: (options: AndroidAdbTapOptions) => Promise<AndroidAdbCommandResult>;
};

type AndroidAdbBounds = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

type AndroidAdbDriverOptions = {
  adbPath: string;
  deviceSerial: string;
  executor: AndroidAdbCommandExecutor;
};

type AndroidAdbCommandExecutor = (
  command: string,
  args: string[],
  options?: { encoding?: 'buffer' | 'utf8'; maxBuffer?: number },
) => Promise<{
  args: string[];
  command: string;
  errorCode?: number | string;
  errorMessage?: string;
  exitCode: number;
  maxBufferBytes?: number;
  outputLimitExceeded?: boolean;
  stderr: string;
  stdout: string;
  stdoutBuffer?: Uint8Array;
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

type AndroidAdbRecordOptions = {
  durationSeconds?: number;
  outputPath: string;
  rawFileName?: string;
  remotePath?: string;
};

type AndroidAdbInspectTreeOptions = {
  rawFileName?: string;
};

type AndroidAdbAssertVisibleOptions = {
  rawFileName?: string;
  selector: AndroidSelector;
};

type AndroidAdbScreenshotOptions = {
  rawFileName?: string;
};

type AndroidAdbScrollOptions = {
  durationMs?: number;
  endX: number;
  endY: number;
  rawFileName?: string;
  startX: number;
  startY: number;
};

type AndroidAdbSwipeOptions = {
  durationMs?: number;
  endX: number;
  endY: number;
  rawFileName?: string;
  startX: number;
  startY: number;
};

type AndroidAdbTapOptions = {
  rawFileName?: string;
  x: number;
  y: number;
};

type AndroidAdbLongPressOptions = {
  durationMs?: number;
  rawFileName?: string;
  x: number;
  y: number;
};

type AndroidAdbPressKey = import('../core/android-adb-press-keys').AndroidAdbPressKey;

type AndroidAdbPressKeyOptions = {
  key: AndroidAdbPressKey;
  rawFileName?: string;
};

type AndroidSelector = {
  kind: string;
  match?: string;
  value: string;
};

type AndroidUiNode = {
  attributes: Record<string, string>;
  bounds: AndroidAdbBounds;
};

type AndroidSelectorResolution = {
  bounds: AndroidAdbBounds;
  centerX: number;
  centerY: number;
  node: AndroidUiNode;
};

const UI_AUTOMATOR_DUMP_PATH = '/sdcard/agent-scenario-loop-ui.xml';

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
 * Builds a shell command that returns UIAutomator XML on stdout.
 *
 * Some emulator images do not stream XML for `uiautomator dump /dev/tty`;
 * dumping to a remote file and then reading it gives the selector resolver a
 * stable XML payload.
 *
 * @returns {string}
 */
function buildUiAutomatorDumpCommand(): string {
  return [
    `rm -f ${UI_AUTOMATOR_DUMP_PATH}`,
    `uiautomator dump ${UI_AUTOMATOR_DUMP_PATH} >/dev/null`,
    `cat ${UI_AUTOMATOR_DUMP_PATH}`,
    'status=$?',
    `rm -f ${UI_AUTOMATOR_DUMP_PATH}`,
    'exit $status',
  ].join('; ');
}

/**
 * Maps ASL's portable key names to Android keyevent names.
 *
 * @param {AndroidAdbPressKey} key
 * @returns {string}
 */
function androidKeyEventForPortableKey(key: AndroidAdbPressKey): string {
  switch (key) {
    case 'appBack':
    case 'back':
    case 'keyboardDismiss':
    case 'systemBack':
      return 'KEYCODE_BACK';
    case 'appSwitcher':
      return 'KEYCODE_APP_SWITCH';
    case 'home':
      return 'KEYCODE_HOME';
    default: {
      const exhaustive: never = key;
      throw new Error(`Unsupported Android adb pressKey \`${String(exhaustive)}\`.`);
    }
  }
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
    ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    exitCode: result.exitCode,
    ...(typeof result.maxBufferBytes === 'number' ? { maxBufferBytes: result.maxBufferBytes } : {}),
    ...(result.outputLimitExceeded ? { outputLimitExceeded: true } : {}),
    rawFileName,
    stderr: result.stderr,
    stdout: result.stdout,
    ...(result.stdoutBuffer ? { stdoutBuffer: result.stdoutBuffer } : {}),
  };
}

/**
 * Combines stdout and stderr into the raw evidence text written by callers.
 *
 * @param {{stdout: string, stderr: string}} result
 * @returns {string}
 */
function formatAndroidAdbRawOutput(result: { stdout: string; stderr: string; stdoutBuffer?: Uint8Array }): string | Uint8Array {
  if (result.stdoutBuffer && !result.stderr) {
    return result.stdoutBuffer;
  }

  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/**
 * Joins command output from a multi-command adb driver action.
 *
 * @param {Array<{args: string[], exitCode: number, stderr: string, stdout: string}>} results
 * @returns {string}
 */
function formatAndroidAdbCommandTranscript(
  results: Array<{args: string[]; exitCode: number; stderr: string; stdout: string}>,
): string {
  return results
    .map((result) => [
      `$ adb ${result.args.join(' ')}`,
      `exitCode=${result.exitCode}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

function buildAssertVisibleCommandResult({
  resolution,
  result,
  selector,
}: {
  resolution: AndroidSelectorResolution | null;
  result: Awaited<ReturnType<AndroidAdbCommandExecutor>>;
  selector: AndroidSelector;
}): Awaited<ReturnType<AndroidAdbCommandExecutor>> {
  if (resolution) {
    return {
      ...result,
      exitCode: 0,
    };
  }

  if (result.exitCode !== 0) {
    return result;
  }

  return {
    ...result,
    exitCode: 1,
    stderr: [result.stderr, `Android selector ${selector.kind}=${selector.value} was not visible.`]
      .filter(Boolean)
      .join('\n'),
  };
}

/**
 * Decodes XML attribute entities emitted by `uiautomator dump`.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

/**
 * Parses Android UIAutomator bounds such as `[0,100][300,240]`.
 *
 * @param {unknown} value
 * @returns {AndroidAdbBounds | null}
 */
function parseAndroidAdbBounds(value: unknown): AndroidAdbBounds | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^\[(?<left>-?\d+),(?<top>-?\d+)\]\[(?<right>-?\d+),(?<bottom>-?\d+)\]$/u.exec(value);
  if (!match?.groups) {
    return null;
  }

  const bounds = {
    bottom: Number(match.groups.bottom),
    left: Number(match.groups.left),
    right: Number(match.groups.right),
    top: Number(match.groups.top),
  };
  if (
    !Number.isFinite(bounds.left) ||
    !Number.isFinite(bounds.top) ||
    !Number.isFinite(bounds.right) ||
    !Number.isFinite(bounds.bottom) ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  ) {
    return null;
  }

  return bounds;
}

/**
 * Extracts UIAutomator nodes that have usable bounds.
 *
 * @param {string} xml
 * @returns {AndroidUiNode[]}
 */
function parseAndroidUiAutomatorNodes(xml: string): AndroidUiNode[] {
  const nodes: AndroidUiNode[] = [];
  for (const nodeMatch of String(xml).matchAll(/<node\b(?<attributes>[^>]*)\/?>/gu)) {
    const attributesText = nodeMatch.groups?.attributes ?? '';
    const attributes: Record<string, string> = {};
    for (const attributeMatch of attributesText.matchAll(/\s(?<name>[\w:-]+)="(?<value>[^"]*)"/gu)) {
      if (attributeMatch.groups?.name && attributeMatch.groups.value !== undefined) {
        attributes[attributeMatch.groups.name] = decodeXmlAttribute(attributeMatch.groups.value);
      }
    }

    const bounds = parseAndroidAdbBounds(attributes.bounds);
    if (bounds) {
      nodes.push({ attributes, bounds });
    }
  }

  return nodes;
}

/**
 * Returns true when a UI attribute satisfies a portable selector match.
 *
 * @param {{actual: string | undefined, expected: string, match: string | undefined}} options
 * @returns {boolean}
 */
function matchesSelectorValue({
  actual = '',
  expected,
  match = 'exact',
}: {
  actual: string | undefined;
  expected: string;
  match: string | undefined;
}): boolean {
  if (match === 'contains') {
    return actual.includes(expected);
  }
  if (match === 'regex') {
    try {
      return new RegExp(expected, 'u').test(actual);
    } catch {
      return false;
    }
  }

  return actual === expected;
}

/**
 * Resolves a portable selector against Android UIAutomator XML.
 *
 * @param {{selector: AndroidSelector, uiTreeXml: string}} options
 * @returns {AndroidSelectorResolution | null}
 */
function resolveAndroidSelectorFromUiTree({
  selector,
  uiTreeXml,
}: {
  selector: AndroidSelector;
  uiTreeXml: string;
}): AndroidSelectorResolution | null {
  const nodes = parseAndroidUiAutomatorNodes(uiTreeXml);
  const node = nodes.find((candidate) => {
    if (selector.kind === 'resourceId') {
      return matchesSelectorValue({
        actual: candidate.attributes['resource-id'],
        expected: selector.value,
        match: selector.match,
      });
    }

    if (selector.kind === 'testId') {
      const resourceId = candidate.attributes['resource-id'] ?? '';
      return matchesSelectorValue({
        actual: resourceId,
        expected: selector.value,
        match: selector.match,
      }) || resourceId.endsWith(`:id/${selector.value}`);
    }

    if (selector.kind === 'accessibilityId' || selector.kind === 'accessibilityLabel') {
      return matchesSelectorValue({
        actual: candidate.attributes['content-desc'],
        expected: selector.value,
        match: selector.match,
      });
    }

    if (selector.kind === 'text') {
      return matchesSelectorValue({
        actual: candidate.attributes.text,
        expected: selector.value,
        match: selector.match,
      });
    }

    return false;
  });
  if (!node) {
    return null;
  }

  return {
    bounds: node.bounds,
    centerX: Math.round((node.bounds.left + node.bounds.right) / 2),
    centerY: Math.round((node.bounds.top + node.bounds.bottom) / 2),
    node,
  };
}

/**
 * Derives an in-bounds vertical scroll gesture from one resolved selector.
 *
 * @param {AndroidAdbBounds} bounds
 * @returns {{endX: number, endY: number, startX: number, startY: number}}
 */
function buildAndroidScrollCoordinatesFromBounds(bounds: AndroidAdbBounds): {
  endX: number;
  endY: number;
  startX: number;
  startY: number;
} {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const x = Math.round(bounds.left + width / 2);

  return {
    endX: x,
    endY: Math.round(bounds.top + height * 0.2),
    startX: x,
    startY: Math.round(bounds.top + height * 0.8),
  };
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

    async inspectTree({
      rawFileName = 'adb-ui-tree.xml',
    }: AndroidAdbInspectTreeOptions = {}): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        buildUiAutomatorDumpCommand(),
      ]);
      return buildDriverResult({ action: 'inspectTree', rawFileName, result });
    },

    async assertVisible({
      rawFileName = 'adb-assert-visible.xml',
      selector,
    }: AndroidAdbAssertVisibleOptions): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        buildUiAutomatorDumpCommand(),
      ]);
      const resolution = result.exitCode === 0
        ? resolveAndroidSelectorFromUiTree({ selector, uiTreeXml: result.stdout })
        : null;
      return buildDriverResult({
        action: 'assertVisible',
        rawFileName,
        result: buildAssertVisibleCommandResult({ resolution, result, selector }),
      });
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

    async longPress({
      durationMs = 700,
      rawFileName = 'adb-longPress.txt',
      x,
      y,
    }: AndroidAdbLongPressOptions): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        'input',
        'swipe',
        String(x),
        String(y),
        String(x),
        String(y),
        String(durationMs),
      ]);
      return buildDriverResult({ action: 'longPress', rawFileName, result });
    },

    async pressKey({
      key,
      rawFileName = 'adb-pressKey.txt',
    }: AndroidAdbPressKeyOptions): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        'input',
        'keyevent',
        androidKeyEventForPortableKey(key),
      ]);
      return buildDriverResult({ action: 'pressKey', rawFileName, result });
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

    async record({
      durationSeconds = 5,
      outputPath,
      rawFileName = 'adb-record.txt',
      remotePath = `/sdcard/agent-scenario-loop-${Date.now()}.mp4`,
    }: AndroidAdbRecordOptions): Promise<AndroidAdbCommandResult> {
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });
      const recordResult = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        'screenrecord',
        '--time-limit',
        String(durationSeconds),
        remotePath,
      ]);
      const pullResult = recordResult.exitCode === 0
        ? await executor(adbPath, ['-s', deviceSerial, 'pull', remotePath, outputPath])
        : null;
      const cleanupResult = await executor(adbPath, ['-s', deviceSerial, 'shell', 'rm', '-f', remotePath]);
      const outputFile = pullResult?.exitCode === 0 ? await fsp.stat(outputPath).catch(() => null) : null;
      const outputCheckResult = pullResult?.exitCode === 0 && !outputFile?.isFile()
        ? {
            args: ['verify-output', outputPath],
            command: adbPath,
            exitCode: 1,
            stderr: `Android screenrecord output was not found at ${outputPath}.`,
            stdout: '',
          }
        : null;
      const results = [recordResult, ...(pullResult ? [pullResult] : []), ...(outputCheckResult ? [outputCheckResult] : []), cleanupResult];
      const failedResult = [recordResult, pullResult, outputCheckResult].find((result) => result && result.exitCode !== 0);

      return {
        ...buildDriverResult({
          action: 'record',
          rawFileName,
          result: {
            args: recordResult.args,
            command: recordResult.command,
            exitCode: failedResult?.exitCode ?? 0,
            stderr: '',
            stdout: formatAndroidAdbCommandTranscript(results),
          },
        }),
        ...(failedResult ? {} : { capturePath: outputPath }),
      };
    },

    async screenshot({
      rawFileName = 'adb-screenshot.png',
    }: AndroidAdbScreenshotOptions = {}): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, ['-s', deviceSerial, 'exec-out', 'screencap', '-p'], {
        encoding: 'buffer',
      });
      return buildDriverResult({ action: 'screenshot', rawFileName, result });
    },

    async scroll({
      durationMs = 300,
      endX,
      endY,
      rawFileName = 'adb-scroll.txt',
      startX,
      startY,
    }: AndroidAdbScrollOptions): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        'input',
        'swipe',
        String(startX),
        String(startY),
        String(endX),
        String(endY),
        String(durationMs),
      ]);
      return buildDriverResult({ action: 'scroll', rawFileName, result });
    },

    async swipe({
      durationMs = 300,
      endX,
      endY,
      rawFileName = 'adb-swipe.txt',
      startX,
      startY,
    }: AndroidAdbSwipeOptions): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, [
        '-s',
        deviceSerial,
        'shell',
        'input',
        'swipe',
        String(startX),
        String(startY),
        String(endX),
        String(endY),
        String(durationMs),
      ]);
      return buildDriverResult({ action: 'swipe', rawFileName, result });
    },

    async tap({
      rawFileName = 'adb-tap.txt',
      x,
      y,
    }: AndroidAdbTapOptions): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, ['-s', deviceSerial, 'shell', 'input', 'tap', String(x), String(y)]);
      return buildDriverResult({ action: 'tap', rawFileName, result });
    },
  };
}

export {
  buildAndroidScrollCoordinatesFromBounds,
  createAndroidAdbDriver,
  formatAndroidAdbCommandTranscript,
  formatAndroidAdbRawOutput,
  parseAndroidAdbBounds,
  parseAndroidUiAutomatorNodes,
  quoteAndroidShellArg,
  resolveAndroidSelectorFromUiTree,
};

export type {
  AndroidAdbBounds,
  AndroidAdbCommandExecutor,
  AndroidAdbCommandResult,
  AndroidAdbDeepLinkOptions,
  AndroidAdbDriver,
  AndroidAdbDriverOptions,
  AndroidAdbAssertVisibleOptions,
  AndroidAdbInspectTreeOptions,
  AndroidAdbLongPressOptions,
  AndroidAdbPressKey,
  AndroidAdbPressKeyOptions,
  AndroidAdbReadLogsOptions,
  AndroidAdbRecordOptions,
  AndroidAdbScreenshotOptions,
  AndroidAdbScrollOptions,
  AndroidAdbSwipeOptions,
  AndroidSelector,
  AndroidSelectorResolution,
  AndroidUiNode,
  AndroidAdbTapOptions,
};
