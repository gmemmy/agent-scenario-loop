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
  assert.match(
    source,
    /import \{ PROFILE_SESSION_STORAGE_KEYS as PROFILE_SESSION_STORAGE_KEY_VALUES \} from '\.\/profile-session-storage';/u,
  );
  assert.match(source, /const PROFILE_SESSION_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES\.session;/u);
  assert.match(source, /const PROFILE_SESSION_ENTRIES_STORAGE_KEY = PROFILE_SESSION_STORAGE_KEY_VALUES\.sessionEntries;/u);
  assert.match(source, /export const PROFILE_SESSION_STORAGE_KEYS = Object\.freeze/u);
  assert.match(source, /export const PROFILE_SESSION_HELPER_VERSION = '1\.1\.0';/u);
  assert.match(source, /const PROFILE_COMMAND_DUPLICATE_WINDOW_MS = 750;/u);
  assert.match(source, /reason: 'duplicate-command-window'/u);
  assert.match(source, /command\.queueId \?\? ''/u);
  assert.match(source, /command\.commandId \?\? command\.id/u);
  assert.match(source, /typeof command\.sequence === 'number' \? String\(command\.sequence\) : ''/u);
  assert.match(
    source,
    /if \(command\.source === 'storage'\) \{\s+return false;\s+\}/u,
  );
  assert.match(source, /entry\.commandId = payload\.commandId;/u);
  assert.match(source, /else if \(typeof payload\.id === 'string'\)/u);
  assert.match(source, /entry\.dependsOnMilestones = dependsOnMilestones;/u);
  assert.match(source, /entry\.queueId = payload\.queueId;/u);
  assert.match(source, /entry\.sequence = payload\.sequence;/u);
  assert.match(source, /entry\.waitForMilestone = payload\.waitForMilestone;/u);
  assert.match(source, /entry\.stopOnFailure = payload\.stopOnFailure;/u);
  assert.match(source, /entry\.continuationReason = payload\.continuationReason;/u);
  assert.match(source, /entry\.minimumSettleMs = payload\.minimumSettleMs;/u);
  assert.match(source, /entry\.plannedSettleMs = payload\.plannedSettleMs;/u);
  assert.match(source, /entry\.maxReadinessWaitMs = payload\.maxReadinessWaitMs;/u);
  assert.match(source, /entry\.readinessWaitMs = payload\.readinessWaitMs;/u);
  assert.match(source, /entry\.actualWaitMs = payload\.actualWaitMs;/u);
  assert.match(source, /entry\.settleOverlapSavedMs = payload\.settleOverlapSavedMs;/u);
  assert.match(source, /entry\.timeoutAvoided = payload\.timeoutAvoided;/u);
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
  assert.match(source, /type ProfileCommandDispatchOutcome = 'dispatched' \| 'queued' \| 'skipped';/u);
  assert.match(source, /handler\(command\);/u);
  assert.match(source, /function dispatchProfileCommand\(command: ProfileSessionCommand\): boolean/u);
  assert.match(source, /if \(dispatchOutcome === 'skipped'\)/u);
  assert.match(
    source,
    /source: 'deeplink' as const/u,
  );
  assert.match(source, /const sequencedProfileCommands: ProfileSessionCommand\[\] = \[\];/u);
  assert.match(source, /const observedProfileEvents: StoredProfileEvent\[\] = \[\];/u);
  assert.match(source, /const profileSessionDependencyMilestoneFacts = createProfileSessionDependencyMilestoneFacts\(\);/u);
  assert.match(source, /const processedProfileCommandIds = createProfileSessionProcessedCommandIds\(\);/u);
  assert.match(source, /let profileCommandMilestoneGate: ProfileCommandMilestoneGate \| null = null;/u);
  assert.match(source, /const profileCommandDependencyController = createProfileCommandDependencyController<ProfileSessionCommand>\(\);/u);
  assert.match(source, /let profileCommandProcessingTimeoutId: ReturnType<typeof setTimeout> \| null = null;/u);
  assert.match(source, /let profileCommandProcessingAvailableAt = 0;/u);
  assert.match(source, /from '\.\/profile-session-command-ordering';/u);
  assert.match(source, /resolveRemainingProfileCommandSettleMs/u);
  assert.match(source, /profileSessionDependencyMilestoneFacts\.snapshot\(\)/u);
  assert.match(source, /sequencedProfileCommands\.sort\(compareProfileCommands\);/u);
  assert.match(source, /function processSequencedProfileCommands/u);
  assert.match(source, /const queueBlocker = resolveProfileCommandQueueBlocker/u);
  assert.match(source, /case 'active-readiness-gate':\s+case 'scheduled-settle':\s+return;/u);
  assert.match(source, /installProfileCommandWait\(resolvedCommand, nextGate, commandReleasedAtMs\);/u);
  assert.match(source, /typeof command\.waitTimeoutMs !== 'number' \|\| command\.waitTimeoutMs <= 0/u);
  assert.match(source, /const dispatchOutcome = notifyProfileCommandListeners\(resolvedCommand\);/u);
  assert.match(source, /if \(dispatchOutcome === 'skipped'\) \{\s+clearProfileCommandMilestoneGate\(\);\s+continue;\s+\}/u);
  assert.match(source, /if \(dispatchOutcome === 'queued'\) \{\s+clearProfileCommandMilestoneGate\(\);\s+return;\s+\}/u);
  assert.match(source, /if \(nextGate\) \{\s+return;\s+\}/u);
  assert.match(source, /function installProfileCommandWait/u);
  assert.match(source, /function scheduleProfileCommandSettle/u);
  assert.match(orderingSource, /typeof command\.sequence === 'number' && command\.sequence > 1/u);
  assert.match(orderingSource, /export function hasObservedProfileCommandDependencies/u);
  assert.match(orderingSource, /export function buildProfileCommandDependencyGate/u);
  assert.match(orderingSource, /export function resolveMissingProfileCommandDependencies/u);
  assert.match(orderingSource, /export function resolveProfileCommandDependencyTimeoutOutcome/u);
  assert.match(orderingSource, /doesProfileEventMatchCommandDependency/u);
  assert.match(source, /appendBoundedProfileEventHistory\(/u);
  assert.match(source, /profileSessionAuthoritativeStorage\.appendEvent\(event\);/u);
  assert.match(source, /profileSessionAuthoritativeStorage\.appendSessionEntry\(entry, forceMaterialize\);/u);
  assert.match(source, /profileSessionAuthoritativeStorage\.recover\(authoritySession\)/u);
  assert.match(source, /recoverProfileSessionInternal\(recoveredState, recovery\);/u);
  assert.match(source, /profileSessionAuthoritativeStorage\.barrier\(\)/u);
  assert.match(source, /profileSessionAuthoritativeStorage\.isAvailable\(\)/u);
  assert.match(source, /normalizeProfileSessionAuthorityIdentity\(/u);
  assert.match(source, /await writeStoredJson\(PROFILE_SESSION_STORAGE_KEY, normalizedSession\);/u);
  assert.match(source, /reason: 'profile-storage-write-failed'/u);
  assert.match(source, /resumingDeliveredProfileCommandTimestamps/u);
  assert.match(source, /profileSessionDependencyMilestoneFacts\.observe\(eventPayload\);/u);
  assert.match(source, /hasObservedProfileCommandMilestone\(\s+command,\s+profileSessionDependencyMilestoneFacts\.snapshot\(\),\s+\)/u);
  assert.match(source, /hasObservedDeliveredProfileCommandMilestone\(\s+command,\s+profileSessionDependencyMilestoneFacts\.snapshot\(\),\s+\)/u);
  assert.match(declarationSource, /export const PROFILE_SESSION_HELPER_VERSION: '1\.1\.0';/u);
  assert.match(declarationSource, /dependsOnMilestones\?: string\[\];/u);
  assert.match(declarationSource, /handler: \(command: ProfileSessionCommand\) => void/u);
  assert.match(source, /observedProfileEvents\.length = 0;/u);
  assert.match(source, /profileSessionDependencyMilestoneFacts\.reset\(\);/u);
  assert.doesNotMatch(source, /PROCESSED_PROFILE_COMMAND_ID_LIMIT/u);
  assert.doesNotMatch(source, /MAX_STORED_PROFILE_SESSION_ENTRIES/u);
  assert.match(source, /const MAX_DIAGNOSTIC_PROFILE_EVENTS = 300;/u);
  assert.doesNotMatch(source, /MAX_STORED_PROFILE_EVENTS/u);
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
  assert.match(source, /scheduleProfileCommandSettle\(resolvedCommand, commandReleasedAtMs\);/u);
  assert.match(source, /const commandReleasedAtMs = Date\.now\(\);/u);
  assert.match(source, /scheduleProfileCommandProcessing\(remainingSettleMs\);/u);
  assert.match(source, /enqueueSequencedProfileCommands\(nextCommands\);/u);
  assert.match(source, /function startProfileCommandMilestoneTimeout/u);
  assert.match(source, /reason: 'wait-for-milestone-timeout'/u);
  assert.match(source, /reason: 'prior-command-failure'/u);
  assert.match(source, /reason: 'dependency-milestone-timeout'/u);
  assert.match(source, /continuationReason: 'dependency-timeout-stop'/u);
  assert.match(source, /missingDependencies: currentGate\.missingDependencies/u);
  assert.match(source, /resolveProfileCommandMilestoneTimeoutOutcome/u);
  assert.match(source, /resolveProfileCommandCadenceOutcome/u);
  assert.match(source, /resolveProfileCommandSettleOutcome/u);
  assert.match(source, /result: 'cadence-settled'/u);
  assert.match(source, /logProfileCommandCadenceObservation\(cadenceObservation, Date\.now\(\)\)/u);
  assert.match(source, /clearProfileCommandMilestoneGate\(\);/u);
  assert.match(source, /clearProfileCommandDependencyGate\(\);/u);
  assert.match(source, /function suspendProfileCommandQueueForBootstrapUnmount/u);
  assert.match(source, /profileCommandDependencyController\.suspend\(\);/u);
  assert.match(source, /startProfileSessionInternal\(\{\s+active: true,\s+scenario: route\.scenario,\s+runId: route\.runId,/u);
  assert.match(source, /doesProfileCommandMatchDependencyGate\(gate, currentCommand\)/u);
  assert.match(source, /clearInterval\(storagePollInterval\);\s+suspendProfileCommandQueueForBootstrapUnmount\(\);/u);
  assert.doesNotMatch(
    source,
    /profileSessionLifecycleController\.invalidate\(\);\s+profileSessionDependencyMilestoneFacts\.reset\(\);\s+subscription\.remove\(\);/u,
  );
  assert.match(source, /if \(nextCommands\.length > 0\) \{\s+sequencedProfileCommands\.push/u);
  assert.match(source, /const queueTransition = resolveDependencyTimeoutQueueTransition/u);
  assert.match(source, /stopOnFailure: timeoutOutcome\.kind === 'terminal'/u);
  assert.match(source, /clearProfileCommandMilestoneGate\(\);\s+pendingProfileCommands\.length = 0;/u);
  assert.match(source, /const command = takeNextPendingProfileCommand\(\);/u);
  assert.match(source, /restorePendingProfileCommand\(command\);/u);
  assert.match(source, /if \(pendingProfileCommands\.length > 0\) \{\s+clearProfileCommandDependencyGate\(\);\s+flushPendingProfileCommands\(\);\s+return;\s+\}/u);
  assert.match(source, /type ProfileCommandClearStoragePolicy = 'preserve-storage' \| 'remove-storage';/u);
  assert.match(source, /clearPendingProfileCommands\(storagePolicy: ProfileCommandClearStoragePolicy = 'remove-storage'\)/u);
  assert.match(source, /if \(storagePolicy === 'preserve-storage'\) \{\s+return;\s+\}/u);
  assert.match(source, /\{ commandStoragePolicy: 'preserve-storage' \}/u);
  assert.match(source, /profileCommandListeners\.add\(listener\);\s+processSequencedProfileCommands\(\);/u);
  assert.match(source, /profileCommandTargetHandlers\.set\(targetId, handler\);\s+processSequencedProfileCommands\(\);/u);
  assert.doesNotMatch(source, /profileCommandListeners\.add\(listener\);\s+flushPendingProfileCommands\(\);/u);
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
