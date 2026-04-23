/**
 * Popup-persistent settings stored in `chrome.storage.local`.
 *
 * These are user preferences, not transient state — they must survive
 * browser restart + extension reload. Compare `chrome.storage.session`,
 * which we use for the tab-id cache (fine to lose on restart).
 */

const SETTINGS_KEY = "popup_settings";

export interface PopupSettings {
  /**
   * When true (default), the popup's Open button reuses an existing
   * Twitter tab — first trying the last helper-managed tab id, then
   * any currently-open twitter.com/x.com tab — rather than spawning a
   * fresh tab on every click. Set to false to always open a new tab.
   */
  reuseTab: boolean;
}

const DEFAULTS: PopupSettings = { reuseTab: true };

export async function getSettings(): Promise<PopupSettings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = stored[SETTINGS_KEY] as Partial<PopupSettings> | undefined;
    if (typeof raw !== "object" || raw === null) return { ...DEFAULTS };
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function setSettings(
  patch: Partial<PopupSettings>,
): Promise<void> {
  const current = await getSettings();
  const next: PopupSettings = { ...current, ...patch };
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  } catch {
    // Fail-soft: losing the write means the next render falls back
    // to defaults. No user-visible breakage beyond the setting not
    // sticking across sessions.
  }
}
