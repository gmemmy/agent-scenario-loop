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
  const declarationSource = readSource('app/profile-session.d.ts');
  const orderingSource = readSource('app/profile-session-command-ordering.ts');

  assert.match(source, /const PROFILE_SESSION_MAX_AGE_MS = 2 \* 60 \* 60_000;/u);
  assert.match(source, /export function isProfileSessionFresh/u);
  assert.match(source, /import \{ PROFILE_SESSION_STORAGE_KEYS \} from '\.\/profile-session-storage';/u);
  assert.match(source, /const PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.session;/u);
  assert.match(source, /const PROFILE_SESSION_ENTRIES_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.sessionEntries;/u);
  assert.match(source, /export const PROFILE_SESSION_HELPER_VERSION = '1\.0\.0';/u);
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
  assert.match(source, /entry\.waitMs = payload\.waitMs;/u);
  assert.match(source, /entry\.waitTimeoutMs = payload\.waitTimeoutMs;/u);
  assert.match(source, /const sessionStartedAt = readProfileSessionStartedAt\(profileSessionState\);/u);
  assert.match(source, /function resolveProfileSessionElapsedAtMs/u);
  assert.match(source, /const atMs = resolveProfileSessionElapsedAtMs\(timestamp, payload\.atMs, sessionStartedAt\);/u);
  assert.match(source, /writeProfileLog\(buildLogLine\('profile-session', logPayload\)\);/u);
  assert.match(source, /helperVersion: PROFILE_SESSION_HELPER_VERSION/u);
  assert.match(source, /\.\.\.\(atMs !== undefined \? \{ atMs \} : \{\}\),/u);
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
  assert.match(source, /const sequencedProfileCommands: ProfileSessionCommand\[\] = \[\];/u);
  assert.match(source, /const observedProfileEvents: StoredProfileEvent\[\] = \[\];/u);
  assert.match(source, /let profileCommandMilestoneGate: ProfileCommandMilestoneGate \| null = null;/u);
  assert.match(source, /let profileCommandProcessingTimeoutId: ReturnType<typeof setTimeout> \| null = null;/u);
  assert.match(source, /let profileCommandProcessingAvailableAt = 0;/u);
  assert.match(source, /from '\.\/profile-session-command-ordering';/u);
  assert.match(source, /sequencedProfileCommands\.sort\(compareProfileCommands\);/u);
  assert.match(source, /function processSequencedProfileCommands/u);
  assert.match(source, /profileCommandMilestoneGate = nextGate;/u);
  assert.match(orderingSource, /typeof command\.sequence === 'number' && command\.sequence > 1/u);
  assert.match(source, /hasObservedProfileCommandMilestone\(command, observedProfileEvents\)/u);
  assert.match(source, /observedProfileEvents\.push\(eventPayload\);/u);
  assert.match(declarationSource, /export const PROFILE_SESSION_HELPER_VERSION: '1\.0\.0';/u);
  assert.match(source, /observedProfileEvents\.length = 0;/u);
  assert.doesNotMatch(source, /command\.timestamp < activeSession\.startedAt/u);
  assert.match(source, /runId\?: string;/u);
  assert.match(source, /scenario\?: string;/u);
  assert.match(source, /function releaseProfileCommandMilestoneGate\(eventPayload: StoredProfileEvent\)/u);
  assert.match(source, /doesProfileEventReleaseCommandGate\(profileCommandMilestoneGate, eventPayload\)/u);
  assert.match(source, /let profileCommandProcessingScheduled = false;/u);
  assert.match(source, /function scheduleProfileCommandProcessing\(waitMs = 0\)/u);
  assert.match(source, /profileCommandProcessingAvailableAt = availableAt;/u);
  assert.match(source, /profileCommandProcessingAvailableAt - Date\.now\(\)/u);
  assert.match(source, /profileCommandProcessingTimeoutId = setTimeout\(run, delayMs\);/u);
  assert.match(source, /queueMicrotask\(run\);/u);
  assert.match(source, /releaseProfileCommandMilestoneGate\(eventPayload\);/u);
  assert.match(source, /scheduleProfileCommandProcessing\(command\.waitMs\);/u);
  assert.match(source, /scheduleProfileCommandProcessing\(waitMs\);/u);
  assert.match(source, /enqueueSequencedProfileCommands\(nextCommands\);/u);
  assert.match(source, /function startProfileCommandMilestoneTimeout/u);
  assert.match(source, /reason: 'wait-for-milestone-timeout'/u);
  assert.match(source, /clearProfileCommandMilestoneGate\(\);/u);
});

test('runner default profile-session storage keys match the app helper contract', () => {
  const rootSource = readSource('profile-session-storage.ts');
  const appStorageSource = readSource('app/profile-session-storage.ts');
  const androidSource = readSource('runner/profile-android.ts');
  const iosProfileSource = readSource('runner/profile-ios.ts');
  const iosSimctlSource = readSource('runner/ios-simctl.ts');

  assert.match(appStorageSource, /export const PROFILE_SESSION_STORAGE_KEYS = Object\.freeze/u);
  assert.match(rootSource, /from '\.\/app\/profile-session-storage';/u);
  assert.match(androidSource, /require\('\.\.\/profile-session-storage'\)/u);
  assert.match(androidSource, /DEFAULT_ANDROID_PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.session/u);
  assert.match(androidSource, /DEFAULT_ANDROID_PROFILE_COMMAND_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.command/u);
  assert.match(iosProfileSource, /require\('\.\.\/profile-session-storage'\)/u);
  assert.match(iosProfileSource, /DEFAULT_IOS_PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.session/u);
  assert.match(iosProfileSource, /DEFAULT_IOS_PROFILE_COMMAND_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.command/u);
  assert.match(iosProfileSource, /DEFAULT_IOS_PROFILE_EVENT_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.event/u);
  assert.match(iosProfileSource, /DEFAULT_IOS_PROFILE_SIGNAL_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.signal/u);
  assert.match(iosProfileSource, /DEFAULT_IOS_PROFILE_SESSION_ENTRIES_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEYS\.sessionEntries/u);
  assert.match(iosSimctlSource, /require\('\.\.\/profile-session-storage'\)/u);
  assert.match(iosSimctlSource, /PROFILE_STORAGE_RESET_KEYS/u);
  assert.match(iosSimctlSource, /command: PROFILE_SESSION_STORAGE_KEYS\.command/u);
  assert.match(iosSimctlSource, /event: PROFILE_SESSION_STORAGE_KEYS\.event/u);
  assert.match(iosSimctlSource, /session: PROFILE_SESSION_STORAGE_KEYS\.session/u);
  assert.match(iosSimctlSource, /sessionEntries: PROFILE_SESSION_STORAGE_KEYS\.sessionEntries/u);
  assert.match(iosSimctlSource, /signal: PROFILE_SESSION_STORAGE_KEYS\.signal/u);
});

test('example app consumes the package profile-session helper as its single source', () => {
  const source = readSource('examples/mobile-app/src/devtools/profile-session.ts');

  assert.match(source, /from '\.\.\/\.\.\/\.\.\/\.\.\/app\/profile-session';/u);
});
