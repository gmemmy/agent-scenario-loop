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
  inspectTree: (options?: AndroidAdbInspectTreeOptions) => Promise<AndroidAdbCommandResult>;
  launchPackage: (packageName: string) => Promise<AndroidAdbCommandResult>;
  openDeepLink: (options: AndroidAdbDeepLinkOptions) => Promise<AndroidAdbCommandResult>;
  readLogs: (options?: AndroidAdbReadLogsOptions) => Promise<AndroidAdbCommandResult>;
  screenshot: (options?: AndroidAdbScreenshotOptions) => Promise<AndroidAdbCommandResult>;
  scroll: (options: AndroidAdbScrollOptions) => Promise<AndroidAdbCommandResult>;
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

type AndroidAdbInspectTreeOptions = {
  rawFileName?: string;
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

type AndroidAdbTapOptions = {
  rawFileName?: string;
  x: number;
  y: number;
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
        'uiautomator',
        'dump',
        '/dev/tty',
      ]);
      return buildDriverResult({ action: 'inspectTree', rawFileName, result });
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

    async screenshot({
      rawFileName = 'adb-screenshot.png',
    }: AndroidAdbScreenshotOptions = {}): Promise<AndroidAdbCommandResult> {
      const result = await executor(adbPath, ['-s', deviceSerial, 'exec-out', 'screencap', '-p']);
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
  AndroidAdbInspectTreeOptions,
  AndroidAdbReadLogsOptions,
  AndroidAdbScreenshotOptions,
  AndroidAdbScrollOptions,
  AndroidSelector,
  AndroidSelectorResolution,
  AndroidUiNode,
  AndroidAdbTapOptions,
};
