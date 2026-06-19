const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const DIST_ROOT = path.join(__dirname, '..', '..');
const ROOT = path.join(DIST_ROOT, '..');

/**
 * Reads a repository source file from the current test build.
 *
 * @param {string} relativePath
 * @returns {string}
 */
function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('profile-session helper keeps storage-backed command control safeguards', () => {
  const source = readSource('app/profile-session.ts');

  assert.match(source, /const PROFILE_SESSION_MAX_AGE_MS = 2 \* 60 \* 60_000;/u);
  assert.match(source, /export function isProfileSessionFresh/u);
  assert.match(source, /const PROFILE_COMMAND_DUPLICATE_WINDOW_MS = 750;/u);
  assert.match(source, /reason: 'duplicate-command-window'/u);
  assert.match(
    source,
    /if \(command\.source === 'storage'\) \{\s+return false;\s+\}/u,
  );
  assert.match(source, /entry\.commandId = payload\.commandId;/u);
  assert.match(source, /else if \(typeof payload\.id === 'string'\)/u);
  assert.match(source, /entry\.queueId = payload\.queueId;/u);
  assert.match(source, /entry\.sequence = payload\.sequence;/u);
  assert.match(source, /entry\.waitForMilestone = payload\.waitForMilestone;/u);
  assert.match(source, /entry\.waitTimeoutMs = payload\.waitTimeoutMs;/u);
  assert.match(source, /status: 'received'/u);
  assert.match(source, /status: 'queued'/u);
  assert.match(source, /status: 'delivered'/u);
  assert.match(source, /status: 'completed'/u);
  assert.match(source, /result: 'target-dispatched'/u);
  assert.match(source, /result: 'listener-notified'/u);
  assert.match(
    source,
    /source: 'deeplink' as const/u,
  );
  assert.match(
    source,
    /const storageCommand = \{\s+\.\.\.command,\s+source: 'storage' as const,\s+\};\s+if \(hasProcessedProfileCommandId\(storageCommand\)\) \{\s+continue;\s+\}\s+markProfileCommandIdProcessed\(storageCommand\);\s+logProfileSession\('command', \{\s+\.\.\.storageCommand,\s+status: 'received',\s+\}\);\s+notifyProfileCommandListeners\(storageCommand\);/u,
  );
});

test('example app consumes the package profile-session helper as its single source', () => {
  const source = readSource('examples/mobile-app/src/devtools/profile-session.ts');

  assert.match(source, /from '\.\.\/\.\.\/\.\.\/\.\.\/app\/profile-session';/u);
});
