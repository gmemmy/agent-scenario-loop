type AgentDevicePlatform = 'android' | 'apple' | 'ios' | 'linux' | 'macos';

type AgentDeviceCommandResult = {
  action: string;
  args: string[];
  capturePath?: string;
  command: string;
  exitCode: number;
  rawFileName: string;
  stderr: string;
  stdout: string;
};

type AgentDeviceCommandExecutor = (command: string, args: string[]) => Promise<{
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type AgentDeviceDriverOptions = {
  agentDevicePath: string;
  device?: string;
  executor: AgentDeviceCommandExecutor;
  extraArgs?: string[];
  json?: boolean;
  platform: AgentDevicePlatform;
  serial?: string;
  session?: string;
  target?: 'desktop' | 'mobile' | 'tv';
  udid?: string;
};

type AgentDeviceSelector = {
  kind: string;
  match?: string;
  value: string;
};

type AgentDeviceAlertAction = 'accept' | 'dismiss' | 'get' | 'wait';

type AgentDeviceAlertOptions = {
  action?: AgentDeviceAlertAction;
  rawFileName?: string;
  timeoutMs?: number;
};

type AgentDeviceAssertVisibleOptions = {
  rawFileName?: string;
  selector: AgentDeviceSelector;
};

type AgentDeviceInspectTreeOptions = {
  interactive?: boolean;
  rawFileName?: string;
};

type AgentDeviceOpenOptions = {
  appOrUrl: string;
  rawFileName?: string;
  url?: string;
};

type AgentDevicePinchOptions = {
  rawFileName?: string;
  scale: number;
  x?: number;
  y?: number;
};

type AgentDeviceFocusOptions = {
  rawFileName?: string;
  x: number;
  y: number;
};

type AgentDevicePressButtonOptions = {
  rawFileName?: string;
  ref?: string;
  selector?: AgentDeviceSelector;
  x?: number;
  y?: number;
};

type AgentDeviceReadLogsOptions = {
  rawFileName?: string;
};

type AgentDeviceScreenshotOptions = {
  outputPath: string;
  rawFileName?: string;
};

type AgentDeviceScrollOptions = {
  amount?: string;
  direction?: string;
  durationMs?: number;
  endX?: number;
  endY?: number;
  pixels?: number;
  rawFileName?: string;
  startX?: number;
  startY?: number;
};

type AgentDeviceSwipeOptions = {
  durationMs?: number;
  endX: number;
  endY: number;
  rawFileName?: string;
  startX: number;
  startY: number;
};

type AgentDeviceLongPressOptions = {
  durationMs?: number;
  rawFileName?: string;
  ref?: string;
  selector?: AgentDeviceSelector;
  x?: number;
  y?: number;
};

type AgentDeviceTapOptions = {
  rawFileName?: string;
  ref?: string;
  selector?: AgentDeviceSelector;
  x?: number;
  y?: number;
};

type AgentDeviceTypeTextOptions = {
  delayMs?: number;
  rawFileName?: string;
  text: string;
};

type AgentDeviceDriver = {
  alert: (options?: AgentDeviceAlertOptions) => Promise<AgentDeviceCommandResult>;
  assertVisible: (options: AgentDeviceAssertVisibleOptions) => Promise<AgentDeviceCommandResult>;
  close: (app: string) => Promise<AgentDeviceCommandResult>;
  focus: (options: AgentDeviceFocusOptions) => Promise<AgentDeviceCommandResult>;
  inspectTree: (options?: AgentDeviceInspectTreeOptions) => Promise<AgentDeviceCommandResult>;
  longPress: (options: AgentDeviceLongPressOptions) => Promise<AgentDeviceCommandResult>;
  open: (options: AgentDeviceOpenOptions) => Promise<AgentDeviceCommandResult>;
  pinch: (options: AgentDevicePinchOptions) => Promise<AgentDeviceCommandResult>;
  pressButton: (options: AgentDevicePressButtonOptions) => Promise<AgentDeviceCommandResult>;
  readLogs: (options?: AgentDeviceReadLogsOptions) => Promise<AgentDeviceCommandResult>;
  screenshot: (options: AgentDeviceScreenshotOptions) => Promise<AgentDeviceCommandResult>;
  scroll: (options?: AgentDeviceScrollOptions) => Promise<AgentDeviceCommandResult>;
  swipe: (options: AgentDeviceSwipeOptions) => Promise<AgentDeviceCommandResult>;
  tap: (options: AgentDeviceTapOptions) => Promise<AgentDeviceCommandResult>;
  typeText: (options: AgentDeviceTypeTextOptions) => Promise<AgentDeviceCommandResult>;
};

/**
 * Adds stable driver metadata to one agent-device command result.
 *
 * @param {{action: string, capturePath?: string, rawFileName: string, result: Awaited<ReturnType<AgentDeviceCommandExecutor>>}} options
 * @returns {AgentDeviceCommandResult}
 */
function buildAgentDeviceResult({
  action,
  capturePath,
  rawFileName,
  result,
}: {
  action: string;
  capturePath?: string;
  rawFileName: string;
  result: Awaited<ReturnType<AgentDeviceCommandExecutor>>;
}): AgentDeviceCommandResult {
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
 * Builds global CLI flags shared by all agent-device driver actions.
 *
 * @param {AgentDeviceDriverOptions} options
 * @returns {string[]}
 */
function buildAgentDeviceGlobalArgs(options: AgentDeviceDriverOptions): string[] {
  const args = ['--platform', options.platform];
  if (options.target) {
    args.push('--target', options.target);
  }
  if (options.device) {
    args.push('--device', options.device);
  }
  if (options.udid) {
    args.push('--udid', options.udid);
  }
  if (options.serial) {
    args.push('--serial', options.serial);
  }
  if (options.session) {
    args.push('--session', options.session);
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }
  if (options.json !== false) {
    args.push('--json');
  }
  return args;
}

/**
 * Formats one portable selector as an agent-device selector expression.
 *
 * @param {AgentDeviceSelector} selector
 * @returns {string}
 */
function formatAgentDeviceSelector(selector: AgentDeviceSelector): string {
  if (selector.match && selector.match !== 'exact') {
    throw new Error(`agent-device selector match \`${selector.match}\` is not supported yet.`);
  }

  const escapedValue = selector.value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  if (selector.kind === 'accessibilityId' || selector.kind === 'resourceId' || selector.kind === 'testId') {
    return `id="${escapedValue}"`;
  }
  if (selector.kind === 'accessibilityLabel') {
    return `label="${escapedValue}"`;
  }
  if (selector.kind === 'text') {
    return `text="${escapedValue}"`;
  }
  if (selector.kind === 'xpath') {
    return `xpath="${escapedValue}"`;
  }
  throw new Error(`Unsupported agent-device selector kind \`${selector.kind}\`.`);
}

/**
 * Combines stdout and stderr into the raw evidence text written by callers.
 *
 * @param {{stdout: string, stderr: string}} result
 * @returns {string}
 */
function formatAgentDeviceRawOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

/**
 * Creates an agent-device-backed driver for portable mobile actions.
 *
 * The adapter shells out through an injected executor so consumers can choose
 * local, remote, or test doubles without making agent-device a package dependency.
 *
 * @param {AgentDeviceDriverOptions} options
 * @returns {AgentDeviceDriver}
 */
function createAgentDeviceDriver(options: AgentDeviceDriverOptions): AgentDeviceDriver {
  const globalArgs = buildAgentDeviceGlobalArgs(options);

  const run = async (
    action: string,
    rawFileName: string,
    commandArgs: string[],
    capturePath?: string,
  ): Promise<AgentDeviceCommandResult> => {
    const result = await options.executor(options.agentDevicePath, [...commandArgs, ...globalArgs]);
    return buildAgentDeviceResult({
      action,
      rawFileName,
      result,
      ...(capturePath ? { capturePath } : {}),
    });
  };

  return {
    async alert({
      action = 'get',
      rawFileName = 'agent-device-alert.txt',
      timeoutMs,
    }: AgentDeviceAlertOptions = {}): Promise<AgentDeviceCommandResult> {
      const args = ['alert', action];
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
        args.push(String(timeoutMs));
      }
      return run('alert', rawFileName, args);
    },

    async assertVisible({
      rawFileName = 'agent-device-assert-visible.txt',
      selector,
    }: AgentDeviceAssertVisibleOptions): Promise<AgentDeviceCommandResult> {
      return run('assertVisible', rawFileName, ['is', 'visible', formatAgentDeviceSelector(selector)]);
    },

    async close(app: string): Promise<AgentDeviceCommandResult> {
      return run('close', 'agent-device-close.txt', ['close', app]);
    },

    async inspectTree({
      interactive = true,
      rawFileName = 'agent-device-snapshot.txt',
    }: AgentDeviceInspectTreeOptions = {}): Promise<AgentDeviceCommandResult> {
      return run('inspectTree', rawFileName, ['snapshot', ...(interactive ? ['-i'] : [])]);
    },

    async open({
      appOrUrl,
      rawFileName = 'agent-device-open.txt',
      url,
    }: AgentDeviceOpenOptions): Promise<AgentDeviceCommandResult> {
      return run('open', rawFileName, ['open', appOrUrl, ...(url ? [url] : [])]);
    },

    async readLogs({
      rawFileName = 'agent-device-logs.txt',
    }: AgentDeviceReadLogsOptions = {}): Promise<AgentDeviceCommandResult> {
      return run('readLogs', rawFileName, ['logs', 'path']);
    },

    async screenshot({
      outputPath,
      rawFileName = 'agent-device-screenshot.txt',
    }: AgentDeviceScreenshotOptions): Promise<AgentDeviceCommandResult> {
      return run('screenshot', rawFileName, ['screenshot', outputPath], outputPath);
    },

    async swipe({
      durationMs,
      endX,
      endY,
      rawFileName = 'agent-device-swipe.txt',
      startX,
      startY,
    }: AgentDeviceSwipeOptions): Promise<AgentDeviceCommandResult> {
      return run('swipe', rawFileName, [
        'swipe',
        String(startX),
        String(startY),
        String(endX),
        String(endY),
        ...(typeof durationMs === 'number' ? [String(durationMs)] : []),
      ]);
    },

    async scroll({
      amount,
      direction = 'down',
      durationMs,
      endX,
      endY,
      pixels,
      rawFileName = 'agent-device-scroll.txt',
      startX,
      startY,
    }: AgentDeviceScrollOptions = {}): Promise<AgentDeviceCommandResult> {
      const hasCoordinates = [startX, startY, endX, endY].every((value) => typeof value === 'number');
      if (hasCoordinates) {
        return run('scroll', rawFileName, [
          'swipe',
          String(startX),
          String(startY),
          String(endX),
          String(endY),
          ...(typeof durationMs === 'number' ? [String(durationMs)] : []),
        ]);
      }

      return run('scroll', rawFileName, [
        'scroll',
        direction,
        ...(amount ? [amount] : []),
        ...(typeof pixels === 'number' ? ['--pixels', String(pixels)] : []),
      ]);
    },

    async longPress({
      durationMs,
      rawFileName = 'agent-device-long-press.txt',
      ref,
      selector,
      x,
      y,
    }: AgentDeviceLongPressOptions): Promise<AgentDeviceCommandResult> {
      const durationArg = typeof durationMs === 'number' ? [String(durationMs)] : [];
      if (selector) {
        return run('longPress', rawFileName, ['longpress', formatAgentDeviceSelector(selector), ...durationArg]);
      }
      if (ref) {
        return run('longPress', rawFileName, ['longpress', ref.startsWith('@') ? ref : `@${ref}`, ...durationArg]);
      }
      if (typeof x === 'number' && typeof y === 'number') {
        return run('longPress', rawFileName, ['longpress', String(x), String(y), ...durationArg]);
      }
      throw new Error('agent-device longPress requires a selector, ref, or x/y coordinates.');
    },

    async pinch({
      rawFileName = 'agent-device-pinch.txt',
      scale,
      x,
      y,
    }: AgentDevicePinchOptions): Promise<AgentDeviceCommandResult> {
      const centerArgs = typeof x === 'number' && typeof y === 'number' ? [String(x), String(y)] : [];
      return run('pinch', rawFileName, ['pinch', String(scale), ...centerArgs]);
    },

    async focus({
      rawFileName = 'agent-device-focus.txt',
      x,
      y,
    }: AgentDeviceFocusOptions): Promise<AgentDeviceCommandResult> {
      return run('focus', rawFileName, ['focus', String(x), String(y)]);
    },

    async pressButton({
      rawFileName = 'agent-device-press-button.txt',
      ref,
      selector,
      x,
      y,
    }: AgentDevicePressButtonOptions): Promise<AgentDeviceCommandResult> {
      if (selector) {
        return run('pressButton', rawFileName, ['press', formatAgentDeviceSelector(selector)]);
      }
      if (ref) {
        return run('pressButton', rawFileName, ['press', ref.startsWith('@') ? ref : `@${ref}`]);
      }
      if (typeof x === 'number' && typeof y === 'number') {
        return run('pressButton', rawFileName, ['press', String(x), String(y)]);
      }
      throw new Error('agent-device pressButton requires a selector, ref, or x/y coordinates.');
    },

    async tap({
      rawFileName = 'agent-device-tap.txt',
      ref,
      selector,
      x,
      y,
    }: AgentDeviceTapOptions): Promise<AgentDeviceCommandResult> {
      if (selector) {
        return run('tap', rawFileName, ['click', formatAgentDeviceSelector(selector)]);
      }
      if (ref) {
        return run('tap', rawFileName, ['click', ref.startsWith('@') ? ref : `@${ref}`]);
      }
      if (typeof x === 'number' && typeof y === 'number') {
        return run('tap', rawFileName, ['click', String(x), String(y)]);
      }
      throw new Error('agent-device tap requires a selector, ref, or x/y coordinates.');
    },

    async typeText({
      delayMs,
      rawFileName = 'agent-device-type-text.txt',
      text,
    }: AgentDeviceTypeTextOptions): Promise<AgentDeviceCommandResult> {
      return run('typeText', rawFileName, [
        'type',
        text,
        ...(typeof delayMs === 'number' ? ['--delay-ms', String(delayMs)] : []),
      ]);
    },
  };
}

export {
  buildAgentDeviceGlobalArgs,
  createAgentDeviceDriver,
  formatAgentDeviceRawOutput,
  formatAgentDeviceSelector,
};

export type {
  AgentDeviceAlertAction,
  AgentDeviceAlertOptions,
  AgentDeviceAssertVisibleOptions,
  AgentDeviceCommandExecutor,
  AgentDeviceCommandResult,
  AgentDeviceDriver,
  AgentDeviceDriverOptions,
  AgentDeviceFocusOptions,
  AgentDeviceInspectTreeOptions,
  AgentDeviceLongPressOptions,
  AgentDeviceOpenOptions,
  AgentDevicePinchOptions,
  AgentDevicePressButtonOptions,
  AgentDevicePlatform,
  AgentDeviceReadLogsOptions,
  AgentDeviceScreenshotOptions,
  AgentDeviceScrollOptions,
  AgentDeviceSelector,
  AgentDeviceSwipeOptions,
  AgentDeviceTapOptions,
  AgentDeviceTypeTextOptions,
};
