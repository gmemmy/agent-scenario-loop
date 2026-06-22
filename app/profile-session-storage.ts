export const PROFILE_STORAGE_PREFIX = 'agent-scenario-loop';
export const PROFILE_STORAGE_SCHEMA = '1';

export const PROFILE_SESSION_STORAGE_KEYS = Object.freeze({
  command: `${PROFILE_STORAGE_PREFIX}.profile-commands.${PROFILE_STORAGE_SCHEMA}`,
  event: `${PROFILE_STORAGE_PREFIX}.profile-events.${PROFILE_STORAGE_SCHEMA}`,
  session: `${PROFILE_STORAGE_PREFIX}.profile-session.${PROFILE_STORAGE_SCHEMA}`,
  sessionEntries: `${PROFILE_STORAGE_PREFIX}.profile-session-entries.${PROFILE_STORAGE_SCHEMA}`,
  signal: `${PROFILE_STORAGE_PREFIX}.profile-signals.${PROFILE_STORAGE_SCHEMA}`,
});

export const PROFILE_STORAGE_RESET_KEYS = Object.freeze([
  PROFILE_SESSION_STORAGE_KEYS.event,
  PROFILE_SESSION_STORAGE_KEYS.signal,
  PROFILE_SESSION_STORAGE_KEYS.command,
  PROFILE_SESSION_STORAGE_KEYS.sessionEntries,
]);
