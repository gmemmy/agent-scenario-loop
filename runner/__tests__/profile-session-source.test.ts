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
  assert.match(
    source,
    /const targetDispatched = dispatchProfileCommandTarget\(command\);\s+if \(targetDispatched\) \{\s+return;\s+\}/u,
  );
  assert.match(
    source,
    /source: 'deeplink' as const/u,
  );
  assert.match(
    source,
    /const storageCommand = \{\s+\.\.\.command,\s+source: 'storage' as const,\s+\};\s+if \(hasProcessedProfileCommandId\(storageCommand\)\) \{\s+continue;\s+\}\s+markProfileCommandIdProcessed\(storageCommand\);\s+logProfileSession\('command', storageCommand\);\s+notifyProfileCommandListeners\(storageCommand\);/u,
  );
});

test('example app consumes the package profile-session helper as its single source', () => {
  const source = readSource('examples/mobile-app/src/devtools/profile-session.ts');

  assert.match(source, /from '\.\.\/\.\.\/\.\.\/\.\.\/app\/profile-session';/u);
});
