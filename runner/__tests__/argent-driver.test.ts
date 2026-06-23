const assert = require('node:assert/strict');
const test = require('node:test');

const {
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
} = require('../argent-driver');

type CommandResult = {
  args: string[];
  command: string;
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Creates a fake Argent executor from argument-keyed responses.
 *
 * @param {Record<string, Partial<CommandResult>>} responses
 * @returns {(command: string, args: string[]) => Promise<CommandResult>}
 */
function createExecutor(responses: Record<string, Partial<CommandResult>>) {
  return async (command: string, args: string[]): Promise<CommandResult> => {
    const key = args.join(' ');
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      command,
      args,
      exitCode: response.exitCode ?? 0,
      stderr: response.stderr ?? '',
      stdout: response.stdout ?? '',
    };
  };
}

test('argent driver builds stable run args for npx and global binaries', () => {
  assert.deepEqual(
    buildArgentRunArgs({
      argentCommand: 'npx',
      baseArgs: ['--yes', '@swmansion/argent', 'run'],
      deviceId: 'SIM-123',
      executor: createExecutor({}),
    }, 'screenshot', ['--includeImageInContext', 'false']),
    ['--yes', '@swmansion/argent', 'run', 'screenshot', '--udid', 'SIM-123', '--includeImageInContext', 'false'],
  );

  assert.deepEqual(
    buildArgentRunArgs({
      argentCommand: 'argent',
      deviceId: 'emulator-5554',
      executor: createExecutor({}),
    }, 'gesture-tap', ['--x', '0.5', '--y', '0.25']),
    ['run', 'gesture-tap', '--udid', 'emulator-5554', '--x', '0.5', '--y', '0.25'],
  );

  assert.deepEqual(
    buildArgentRunArgs({
      argentCommand: 'argent',
      deviceFlag: '--serial',
      deviceId: 'legacy-emulator',
      executor: createExecutor({}),
    }, 'gesture-tap', ['--x', '0.5', '--y', '0.25']),
    ['run', 'gesture-tap', '--serial', 'legacy-emulator', '--x', '0.5', '--y', '0.25'],
  );
});

test('argent driver normalizes pixel coordinates when screen size is known', () => {
  assert.deepEqual(
    normalizeArgentPoint({ screenSize: { height: 2000, width: 1000 }, x: 500, y: 250 }),
    { x: 0.5, y: 0.125 },
  );
  assert.deepEqual(normalizeArgentPoint({ x: 0.5, y: 0.125 }), { x: 0.5, y: 0.125 });
  assert.throws(
    () => normalizeArgentPoint({ screenSize: { height: 0, width: 1000 }, x: 1, y: 1 }),
    /screen size must have positive width and height/u,
  );
});

test('argent driver parses structured output and screenshot paths', () => {
  assert.deepEqual(parseArgentRunJson('{"description":"Ready"}\n'), { description: 'Ready' });
  assert.equal(extractArgentScreenshotPath('Saved screenshot: /tmp/argent-screen.png\n'), '/tmp/argent-screen.png');
  assert.equal(extractArgentScreenshotPath('{"path":"/tmp/argent-json.png"}'), '/tmp/argent-json.png');
  assert.equal(extractArgentScreenshotPath('{"image":"/tmp/argent-image.png"}'), '/tmp/argent-image.png');
  assert.equal(isArgentRootOnlyDescription('{"description":"ROOT"}'), true);
  assert.equal(isArgentRootOnlyDescription('{"description":"Ready"}'), false);
});

test('argent driver treats completed output before wrapper timeout as successful', async () => {
  const driver = createArgentDriver({
    appId: 'dev.example.app',
    argentCommand: 'npx',
    baseArgs: ['--yes', '@swmansion/argent', 'run'],
    deviceId: 'SIM-123',
    executor: createExecutor({
      '--yes @swmansion/argent run launch-app --udid SIM-123 --bundleId dev.example.app': {
        exitCode: 1,
        stderr: 'Argent command timed out after 1000ms.',
        stdout: '{"launched":true,"bundleId":"dev.example.app"}\n',
      },
      '--yes @swmansion/argent run screenshot --udid SIM-123 --includeImageInContext false': {
        exitCode: 1,
        stderr: 'Argent command timed out after 1000ms.',
        stdout: '{"image":"/tmp/argent-image.png"}\n',
      },
    }),
  });

  const launch = await driver.launchApp();
  const screenshot = await driver.screenshot();

  assert.equal(launch.exitCode, 0);
  assert.equal(screenshot.exitCode, 0);
  assert.equal(screenshot.capturePath, '/tmp/argent-image.png');
  assert.equal(hasCompletedArgentOutput('launch', launch.stdout), true);
  assert.equal(
    normalizeArgentResultExitCode({
      action: 'tap',
      args: [],
      command: 'argent',
      exitCode: 1,
      rawFileName: 'tap.txt',
      stderr: 'Argent command timed out after 1000ms.',
      stdout: '',
    }).exitCode,
    1,
  );
});

test('argent driver maps lifecycle, gestures, screenshots, and descriptions', async () => {
  const executor = createExecutor({
    '--yes @swmansion/argent run launch-app --udid SIM-123 --bundleId dev.example.app': {
      stdout: '{"success":true}\n',
    },
    '--yes @swmansion/argent run open-url --udid SIM-123 --url example://profile/start': {
      stdout: '{"success":true}\n',
    },
    '--yes @swmansion/argent run gesture-tap --udid SIM-123 --x 0.5 --y 0.25': {
      stdout: '{"success":true}\n',
    },
    '--yes @swmansion/argent run gesture-custom --udid SIM-123 --events-json [{"type":"Down","x":0.5,"y":0.25},{"delayMs":900,"type":"Up","x":0.5,"y":0.25}]': {
      stdout: '{"events":2}\n',
    },
    '--yes @swmansion/argent run gesture-swipe --udid SIM-123 --fromX 0.5 --fromY 0.8 --toX 0.5 --toY 0.2 --durationMs 250': {
      stdout: '{"success":true}\n',
    },
    '--yes @swmansion/argent run gesture-swipe --udid SIM-123 --fromX 0.25 --fromY 0.3 --toX 0.75 --toY 0.8 --durationMs 175': {
      stdout: '{"success":true}\n',
    },
    '--yes @swmansion/argent run screenshot --udid SIM-123 --includeImageInContext false': {
      stdout: 'Saved screenshot: /tmp/argent-screen.png\n',
    },
    '--yes @swmansion/argent run describe --udid SIM-123 --bundleId dev.example.app': {
      stdout: '{"description":"Home Ready"}\n',
    },
  });
  const driver = createArgentDriver({
    appId: 'dev.example.app',
    argentCommand: 'npx',
    baseArgs: ['--yes', '@swmansion/argent', 'run'],
    deviceId: 'SIM-123',
    executor,
    screenSize: { height: 2000, width: 1000 },
  });

  const launch = await driver.launchApp();
  const openUrl = await driver.openUrl({ url: 'example://profile/start' });
  const tap = await driver.tap({ x: 500, y: 500 });
  const longPress = await driver.longPress({ durationMs: 900, x: 500, y: 500 });
  const scroll = await driver.scroll({ durationMs: 250, endX: 500, endY: 400, startX: 500, startY: 1600 });
  const swipe = await driver.swipe({ durationMs: 175, endX: 750, endY: 1600, startX: 250, startY: 600 });
  const screenshot = await driver.screenshot();
  const tree = await driver.inspectTree();
  const visible = await driver.assertVisible({ selector: { kind: 'text', value: 'Ready' } });

  assert.equal(launch.action, 'launch');
  assert.equal(openUrl.action, 'openUrl');
  assert.equal(tap.rawFileName, 'argent-tap.txt');
  assert.equal(longPress.action, 'longPress');
  assert.equal(scroll.action, 'scroll');
  assert.equal(swipe.action, 'swipe');
  assert.equal(swipe.rawFileName, 'argent-swipe.txt');
  assert.equal(screenshot.capturePath, '/tmp/argent-screen.png');
  assert.equal(tree.action, 'inspectTree');
  assert.equal(visible.exitCode, 0);
  assert.match(formatArgentRawOutput(tree), /Home Ready/u);
});

test('argent driver fails assertVisible when description cannot prove the selector', async () => {
  const driver = createArgentDriver({
    appId: 'dev.example.app',
    argentCommand: 'argent',
    deviceId: 'SIM-123',
    executor: createExecutor({
      'run describe --udid SIM-123 --bundleId dev.example.app': {
        stdout: '{"description":"Home"}\n',
      },
    }),
  });

  const result = await driver.assertVisible({ selector: { kind: 'text', value: 'Ready' } });

  assert.equal(result.action, 'assertVisible');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /did not include text `Ready`/u);
  assert.equal(matchesArgentSelector({ description: 'Home Ready', selector: { kind: 'text', value: 'Ready' } }), true);
  assert.equal(
    matchesArgentSelector({ description: 'Home Ready', selector: { kind: 'text', match: 'contains', value: 'Ready' } }),
    true,
  );
  assert.equal(
    matchesArgentSelector({ description: 'Home Ready', selector: { kind: 'text', match: 'regex', value: 'Home\\s+Ready' } }),
    true,
  );
  assert.equal(
    matchesArgentSelector({ description: 'Home Ready', selector: { kind: 'text', match: 'regex', value: '[' } }),
    false,
  );
});

test('argent driver accepts assertVisible evidence emitted on stderr', async () => {
  const driver = createArgentDriver({
    appId: 'dev.example.app',
    argentCommand: 'argent',
    deviceId: 'SIM-123',
    executor: createExecutor({
      'run describe --udid SIM-123 --bundleId dev.example.app': {
        exitCode: 1,
        stderr: '{"description":"ViewGroup id=\\"home-screen\\""}\n',
      },
    }),
  });

  const result = await driver.assertVisible({
    selector: { kind: 'regex', match: 'regex', value: 'app-entry-root|home-screen|auth-gate-root' },
  });

  assert.equal(result.action, 'assertVisible');
  assert.equal(result.exitCode, 0);
});

test('argent driver accepts Argent-specific regex selector kind', async () => {
  const driver = createArgentDriver({
    appId: 'dev.example.app',
    argentCommand: 'argent',
    deviceId: 'SIM-123',
    executor: createExecutor({
      'run describe --udid SIM-123 --bundleId dev.example.app': {
        stdout: '{"description":"ViewGroup id=\\"home-screen\\""}\n',
      },
    }),
  });

  const result = await driver.assertVisible({
    selector: { kind: 'regex', value: 'app-entry-root|home-screen|auth-gate-root' },
  });

  assert.equal(result.action, 'assertVisible');
  assert.equal(result.exitCode, 0);
  assert.equal(
    matchesArgentSelector({
      description: 'ViewGroup id="home-screen"',
      selector: { kind: 'regex', value: 'app-entry-root|home-screen|auth-gate-root' },
    }),
    true,
  );
});
