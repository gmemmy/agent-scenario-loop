type ArgentCommandResult = {
  action: string;
  args: string[];
  capturePath?: string;
  command: string;
  exitCode: number;
  rawFileName: string;
  stderr: string;
  stdout: string;
};

type ArgentCommandExecutor = (command: string, args: string[]) => Promise<{
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type ArgentDriverOptions = {
  appFlag?: string;
  appId?: string;
  argentCommand: string;
  baseArgs?: string[];
  deviceFlag?: string;
  deviceId: string;
  executor: ArgentCommandExecutor;
  extraArgs?: string[];
  screenSize?: ArgentScreenSize;
};

type ArgentDriver = {
  assertVisible: (options: ArgentAssertVisibleOptions) => Promise<ArgentCommandResult>;
  inspectTree: (options?: ArgentInspectTreeOptions) => Promise<ArgentCommandResult>;
  launchApp: (options?: ArgentLaunchAppOptions) => Promise<ArgentCommandResult>;
  openUrl: (options: ArgentOpenUrlOptions) => Promise<ArgentCommandResult>;
  screenshot: (options?: ArgentScreenshotOptions) => Promise<ArgentCommandResult>;
  scroll: (options: ArgentScrollOptions) => Promise<ArgentCommandResult>;
  tap: (options: ArgentTapOptions) => Promise<ArgentCommandResult>;
};

type ArgentScreenSize = {
  height: number;
  width: number;
};

type ArgentPointInput = {
  screenSize?: ArgentScreenSize;
  x: number;
  y: number;
};

type ArgentNormalizedPoint = {
  x: number;
  y: number;
};

type ArgentSelector = {
  kind: string;
  match?: string;
  value: string;
};

type ArgentAssertVisibleOptions = {
  appId?: string;
  rawFileName?: string;
  selector: ArgentSelector;
};

type ArgentInspectTreeOptions = {
  appId?: string;
  rawFileName?: string;
};

type ArgentLaunchAppOptions = {
  appId?: string;
  rawFileName?: string;
};

type ArgentOpenUrlOptions = {
  rawFileName?: string;
  url: string;
};

type ArgentScreenshotOptions = {
  rawFileName?: string;
};

type ArgentScrollOptions = {
  durationMs?: number;
  endX: number;
  endY: number;
  rawFileName?: string;
  screenSize?: ArgentScreenSize;
  startX: number;
  startY: number;
};

type ArgentTapOptions = {
  rawFileName?: string;
  screenSize?: ArgentScreenSize;
  x: number;
  y: number;
};

/**
 * Adds stable driver metadata to one Argent command result.
 *
 * @param {{action: string, capturePath?: string, rawFileName: string, result: Awaited<ReturnType<ArgentCommandExecutor>>}} options
 * @returns {ArgentCommandResult}
 */
function buildArgentResult({
  action,
  capturePath,
  rawFileName,
  result,
}: {
  action: string;
  capturePath?: string;
  rawFileName: string;
  result: Awaited<ReturnType<ArgentCommandExecutor>>;
}): ArgentCommandResult {
  return {
    action,
    args: result.args,
    command: result.command,
    exitCode: result.exitCode,
    rawFileName,
    stderr: result.stderr,
    stdout: result.stdout,
    ...(capturePath ? { capturePath } : {}),
  };
}

/**
 * Returns true when Argent emitted a complete action result before a wrapper timeout.
 *
 * @param {string} action
 * @param {string} stdout
 * @param {string | undefined} capturePath
 * @returns {boolean}
 */
function hasCompletedArgentOutput(action: string, stdout: string, capturePath?: string): boolean {
  const parsed = parseArgentRunJson(stdout);
  if (action === 'screenshot') {
    return typeof capturePath === 'string' && capturePath.length > 0;
  }
  if (['assertVisible', 'inspectTree'].includes(action)) {
    return readArgentDescription(stdout).trim().length > 0;
  }
  if (parsed?.success === true || parsed?.launched === true) {
    return true;
  }
  if (action === 'launch' && typeof parsed?.bundleId === 'string') {
    return true;
  }
  return false;
}

/**
 * Keeps successful Argent output from being failed only because a wrapper helper lingered.
 *
 * @param {ArgentCommandResult} result
 * @returns {ArgentCommandResult}
 */
function normalizeArgentResultExitCode(result: ArgentCommandResult): ArgentCommandResult {
  if (
    result.exitCode !== 0 &&
    /timed out after \d+ms/iu.test(result.stderr) &&
    hasCompletedArgentOutput(result.action, result.stdout, result.capturePath)
  ) {
    return {
      ...result,
      exitCode: 0,
    };
  }
  return result;
}

/**
 * Combines stdout and stderr into raw evidence text.
 *
 * @param {{stdout: string, stderr: string}} result
 * @returns {string}
 */
function formatArgentRawOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/**
 * Builds the command argv for one `argent run <tool>` style invocation.
 *
 * @param {ArgentDriverOptions} options
 * @param {string} tool
 * @param {string[]} [args]
 * @returns {string[]}
 */
function buildArgentRunArgs(options: ArgentDriverOptions, tool: string, args: string[] = []): string[] {
  return [
    ...(options.baseArgs ?? ['run']),
    tool,
    options.deviceFlag ?? '--udid',
    options.deviceId,
    ...args,
    ...(options.extraArgs ?? []),
  ];
}

/**
 * Extracts a local screenshot path from common Argent CLI output.
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractArgentScreenshotPath(text: string): string | null {
  const parsed = parseArgentRunJson(text);
  for (const key of ['path', 'image']) {
    const jsonPath = parsed?.[key];
    if (typeof jsonPath === 'string' && jsonPath.length > 0) {
      return jsonPath;
    }
  }

  const savedMatch = /(?:Saved screenshot|Screenshot saved(?: to)?):\s*(?<path>\S.+)$/imu.exec(text);
  return savedMatch?.groups?.path?.trim() ?? null;
}

/**
 * Parses a JSON object from Argent output when the tool returns structured data.
 *
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function parseArgentRunJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns the Argent description text from either plain or JSON command output.
 *
 * @param {string} text
 * @returns {string}
 */
function readArgentDescription(text: string): string {
  const parsed = parseArgentRunJson(text);
  return typeof parsed?.description === 'string' ? parsed.description : text;
}

/**
 * Detects collapsed UI descriptions that should fail scenario health upstream.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isArgentRootOnlyDescription(text: string): boolean {
  const description = readArgentDescription(text).trim();
  return /^root$/iu.test(description) || /^<root\s*\/?>$/iu.test(description);
}

/**
 * Converts pixel coordinates into Argent's normalized 0-1 coordinate space.
 *
 * @param {ArgentPointInput} point
 * @returns {ArgentNormalizedPoint}
 */
function normalizeArgentPoint({ screenSize, x, y }: ArgentPointInput): ArgentNormalizedPoint {
  if (!screenSize) {
    return { x, y };
  }

  if (
    !Number.isFinite(screenSize.width) ||
    !Number.isFinite(screenSize.height) ||
    screenSize.width <= 0 ||
    screenSize.height <= 0
  ) {
    throw new Error('Argent screen size must have positive width and height.');
  }

  return {
    x: Math.min(Math.max(x / screenSize.width, 0), 1),
    y: Math.min(Math.max(y / screenSize.height, 0), 1),
  };
}

/**
 * Normalizes a point while preserving exact optional property semantics.
 *
 * @param {{screenSize?: ArgentScreenSize, x: number, y: number}} point
 * @returns {ArgentNormalizedPoint}
 */
function normalizeArgentPointWithOptionalScreenSize({
  screenSize,
  x,
  y,
}: {
  screenSize?: ArgentScreenSize;
  x: number;
  y: number;
}): ArgentNormalizedPoint {
  return screenSize
    ? normalizeArgentPoint({ screenSize, x, y })
    : normalizeArgentPoint({ x, y });
}

/**
 * Checks whether an Argent UI description contains a portable selector target.
 *
 * @param {{description: string, selector: ArgentSelector}} options
 * @returns {boolean}
 */
function matchesArgentSelector({
  description,
  selector,
}: {
  description: string;
  selector: ArgentSelector;
}): boolean {
  if (selector.match && selector.match !== 'exact') {
    throw new Error(`Argent selector match \`${selector.match}\` is not supported yet.`);
  }

  return readArgentDescription(description).includes(selector.value);
}

/**
 * Creates an Argent-backed driver for portable interaction actions.
 *
 * The adapter shells out through an injected executor so consumers can use a
 * global `argent` binary, `npx --yes @swmansion/argent run`, or a test double
 * without making Argent a package dependency.
 *
 * @param {ArgentDriverOptions} options
 * @returns {ArgentDriver}
 */
function createArgentDriver(options: ArgentDriverOptions): ArgentDriver {
  const run = async (
    action: string,
    tool: string,
    rawFileName: string,
    args: string[] = [],
    capturePath?: string,
  ): Promise<ArgentCommandResult> => {
    const result = await options.executor(options.argentCommand, buildArgentRunArgs(options, tool, args));
    return normalizeArgentResultExitCode(buildArgentResult({
      action,
      rawFileName,
      result,
      ...(capturePath ? { capturePath } : {}),
    }));
  };

  const appArgs = (appId?: string): string[] => {
    const resolvedAppId = appId ?? options.appId;
    return resolvedAppId ? [options.appFlag ?? '--bundleId', resolvedAppId] : [];
  };

  return {
    async assertVisible({
      appId,
      rawFileName = 'argent-assert-visible.txt',
      selector,
    }: ArgentAssertVisibleOptions): Promise<ArgentCommandResult> {
      const result = await run('assertVisible', 'describe', rawFileName, appArgs(appId));
      if (!matchesArgentSelector({ description: result.stdout, selector })) {
        return {
          ...result,
          exitCode: result.exitCode === 0 ? 1 : result.exitCode,
          stderr: [result.stderr, `Argent description did not include ${selector.kind} \`${selector.value}\`.`]
            .filter(Boolean)
            .join('\n'),
        };
      }
      return result;
    },

    async inspectTree({
      appId,
      rawFileName = 'argent-describe.txt',
    }: ArgentInspectTreeOptions = {}): Promise<ArgentCommandResult> {
      return run('inspectTree', 'describe', rawFileName, appArgs(appId));
    },

    async launchApp({
      appId,
      rawFileName = 'argent-launch-app.txt',
    }: ArgentLaunchAppOptions = {}): Promise<ArgentCommandResult> {
      return run('launch', 'launch-app', rawFileName, appArgs(appId));
    },

    async openUrl({
      rawFileName = 'argent-open-url.txt',
      url,
    }: ArgentOpenUrlOptions): Promise<ArgentCommandResult> {
      return run('openUrl', 'open-url', rawFileName, ['--url', url]);
    },

    async screenshot({
      rawFileName = 'argent-screenshot.txt',
    }: ArgentScreenshotOptions = {}): Promise<ArgentCommandResult> {
      const result = await run('screenshot', 'screenshot', rawFileName, ['--includeImageInContext', 'false']);
      const capturePath = extractArgentScreenshotPath(result.stdout);
      return normalizeArgentResultExitCode(capturePath ? { ...result, capturePath } : result);
    },

    async scroll({
      durationMs = 300,
      endX,
      endY,
      rawFileName = 'argent-swipe.txt',
      screenSize,
      startX,
      startY,
    }: ArgentScrollOptions): Promise<ArgentCommandResult> {
      const from = normalizeArgentPointWithOptionalScreenSize({
        ...(screenSize ?? options.screenSize ? { screenSize: screenSize ?? options.screenSize } : {}),
        x: startX,
        y: startY,
      });
      const to = normalizeArgentPointWithOptionalScreenSize({
        ...(screenSize ?? options.screenSize ? { screenSize: screenSize ?? options.screenSize } : {}),
        x: endX,
        y: endY,
      });
      return run('scroll', 'gesture-swipe', rawFileName, [
        '--fromX',
        String(from.x),
        '--fromY',
        String(from.y),
        '--toX',
        String(to.x),
        '--toY',
        String(to.y),
        '--durationMs',
        String(durationMs),
      ]);
    },

    async tap({
      rawFileName = 'argent-tap.txt',
      screenSize,
      x,
      y,
    }: ArgentTapOptions): Promise<ArgentCommandResult> {
      const point = normalizeArgentPointWithOptionalScreenSize({
        ...(screenSize ?? options.screenSize ? { screenSize: screenSize ?? options.screenSize } : {}),
        x,
        y,
      });
      return run('tap', 'gesture-tap', rawFileName, ['--x', String(point.x), '--y', String(point.y)]);
    },
  };
}

export {
  buildArgentRunArgs,
  createArgentDriver,
  extractArgentScreenshotPath,
  formatArgentRawOutput,
  hasCompletedArgentOutput,
  isArgentRootOnlyDescription,
  matchesArgentSelector,
  normalizeArgentPoint,
  normalizeArgentResultExitCode,
  parseArgentRunJson,
  readArgentDescription,
};

export type {
  ArgentAssertVisibleOptions,
  ArgentCommandExecutor,
  ArgentCommandResult,
  ArgentDriver,
  ArgentDriverOptions,
  ArgentInspectTreeOptions,
  ArgentLaunchAppOptions,
  ArgentNormalizedPoint,
  ArgentOpenUrlOptions,
  ArgentPointInput,
  ArgentScreenshotOptions,
  ArgentScreenSize,
  ArgentScrollOptions,
  ArgentSelector,
  ArgentTapOptions,
};
