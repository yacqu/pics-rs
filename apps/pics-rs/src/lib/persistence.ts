import { get, set, del } from "idb-keyval";

/**
 * Thin typed wrapper over idb-keyval. Per spec §6/§8.14, IndexedDB is used for
 * low-stakes, regenerable client-side state (preferences, UI layout, cache
 * metadata) — never for anything the user would be upset to lose. Keep the API
 * surface tiny so it is easy to swap for a file under the Tauri app-data
 * directory later if durability ever matters.
 */

const KEY_PREFIX = "pics-rs:";

export async function loadState<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await get<T>(KEY_PREFIX + key);
    return value ?? fallback;
  } catch {
    // IndexedDB can be unavailable/cleared in some WebViews (spec §8.14).
    return fallback;
  }
}

export async function saveState<T>(key: string, value: T): Promise<void> {
  try {
    await set(KEY_PREFIX + key, value);
  } catch {
    // Persistence is best-effort; never let a storage failure break the UI.
  }
}

export async function clearState(key: string): Promise<void> {
  try {
    await del(KEY_PREFIX + key);
  } catch {
    /* best-effort */
  }
}
