const SCAFFOLD_APP_IDS = new Set(['com.example.app']);

/**
 * Fails live device proof before a scaffold placeholder app id can touch a device.
 *
 * @param {{appId: string | null | undefined, appIdKind: string, platform: 'android' | 'ios', replacementHint: string}} options
 * @returns {void}
 */
function assertConcreteMobileAppId({
  appId,
  appIdKind,
  platform,
  replacementHint,
}: {
  appId: string | null | undefined;
  appIdKind: string;
  platform: 'android' | 'ios';
  replacementHint: string;
}): void {
  if (typeof appId !== 'string' || !SCAFFOLD_APP_IDS.has(appId)) {
    return;
  }

  throw new Error(
    `${platform} live proof resolved scaffold placeholder ${appIdKind} "${appId}". Replace it with the target app id before collecting device evidence. ${replacementHint}`,
  );
}

module.exports = {
  assertConcreteMobileAppId,
};
