const ANDROID_ADB_PRESS_KEYS = [
  'appBack',
  'appSwitcher',
  'back',
  'home',
  'keyboardDismiss',
  'systemBack',
] as const;

type AndroidAdbPressKey = (typeof ANDROID_ADB_PRESS_KEYS)[number];

const ANDROID_ADB_PRESS_KEY_SET: ReadonlySet<string> = new Set(ANDROID_ADB_PRESS_KEYS);

/**
 * Returns true when a scenario key maps to a supported Android adb keyevent.
 *
 * @param {unknown} key
 * @returns {key is AndroidAdbPressKey}
 */
function isAndroidAdbPressKey(key: unknown): key is AndroidAdbPressKey {
  return typeof key === 'string' && ANDROID_ADB_PRESS_KEY_SET.has(key);
}

/**
 * Formats the public Android adb press-key vocabulary for validation messages.
 *
 * @returns {string}
 */
function formatAndroidAdbPressKeys(): string {
  return ANDROID_ADB_PRESS_KEYS.join(', ');
}

export {
  ANDROID_ADB_PRESS_KEY_SET,
  ANDROID_ADB_PRESS_KEYS,
  formatAndroidAdbPressKeys,
  isAndroidAdbPressKey,
};

export type { AndroidAdbPressKey };
