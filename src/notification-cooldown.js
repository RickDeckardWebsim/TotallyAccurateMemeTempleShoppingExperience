// Suppress repeated toasts, not distinct events or dialogs requiring an answer.
export const REPEAT_TOAST_DELAY_MS = 15000;
export function createNotificationCooldown(delayMs = REPEAT_TOAST_DELAY_MS, maxEntries = 128) {
  const shown = new Map();
  return {
    allow(message, now = performance.now()) {
      const key = String(message).trim().replace(/\s+/g, ' ').toLowerCase();
      if (!key) return false;
      const previous = shown.get(key);
      // Suppressed calls don't extend the delay, so persistent warnings can recur.
      if (previous !== undefined && now - previous < delayMs) return false;
      shown.delete(key);
      if (shown.size >= maxEntries) {
        for (const [oldKey, time] of shown) if (now - time >= delayMs) shown.delete(oldKey);
        if (shown.size >= maxEntries) shown.delete(shown.keys().next().value);
      }
      shown.set(key, now);
      return true;
    },
    clear() { shown.clear(); },
    get size() { return shown.size; }
  };
}
