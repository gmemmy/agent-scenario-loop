#!/usr/bin/env node

const { hasHelpFlag } = require('./cli');
const {
  parseArgs,
  runProfileCli,
  runProfileMobile,
  usage,
} = require('./profile-mobile');

/**
 * Runs the Android log-ingest profile artifact pipeline.
 *
 * @param {import('./profile-mobile').CliArgs} args
 * @returns {Promise<import('./profile-mobile').ProfileRunResult>}
 */
function runProfileAndroid(args: import('./profile-mobile').CliArgs): Promise<import('./profile-mobile').ProfileRunResult> {
  return runProfileMobile(args, {
    defaultDriver: 'adb-logcat',
    platform: 'android',
  });
}

/**
 * Runs the profile-android CLI.
 *
 * @returns {Promise<void>}
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    usage({ binaryName: 'asl-profile-android', output: process.stdout, platform: 'android' });
    return;
  }

  await runProfileCli({
    argv,
    binaryName: 'asl-profile-android',
    defaultDriver: 'adb-logcat',
    platform: 'android',
  });
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
  runProfileAndroid,
  usage,
};
