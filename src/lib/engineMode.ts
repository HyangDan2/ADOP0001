/**
 * WO-11 — the engine mode that every tool shares.
 *
 * The app has exactly two ways to produce an artifact:
 *
 *   Mode A `local`  — ローカル解析. The deterministic engine runs in the tab and
 *                     nothing is ever sent. Typing, sample loading, workspace
 *                     files and every re-run stay in this mode.
 *   Mode B `hybrid`— AI ハイブリッド解析. The same local result, plus an optional
 *                     AI supplement that the operator must preview and approve
 *                     for every single request.
 *
 * Mode A is the default: a user who never chooses Mode B cannot cause an external
 * request, however they type. Mode B is an explicit, per-user choice that is
 * remembered (it is a preference, not a secret), and it is checked again by the
 * orchestrator so a stale screen cannot send anything after the switch back.
 */
import { useSyncExternalStore } from 'react';

export type EngineMode = 'local' | 'hybrid';

export const ENGINE_MODE_KEY = 'adop0001.engine.mode';

export const DEFAULT_ENGINE_MODE: EngineMode = 'local';

/** Full label, as shown in the mode switch and the hybrid bar. */
export const ENGINE_MODE_LABEL: Record<EngineMode, string> = {
  local: 'Mode A · ローカル解析（完全オフライン）',
  hybrid: 'Mode B · AI ハイブリッド解析',
};

/** Compact label for the top bar and badges. */
export const ENGINE_MODE_SHORT: Record<EngineMode, string> = {
  local: 'A ローカル',
  hybrid: 'B ハイブリッド',
};

/** Status-bar sentence for the current mode. */
export const ENGINE_MODE_STATUS: Record<EngineMode, string> = {
  local: 'ローカル静的解析（外部送信なし）',
  hybrid: 'AI ハイブリッド（送信は毎回承認）',
};

export function normalizeEngineMode(value: unknown): EngineMode {
  return value === 'hybrid' ? 'hybrid' : 'local';
}

function storageOrNull(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readFromStorage(): EngineMode {
  const storage = storageOrNull();
  if (!storage) return DEFAULT_ENGINE_MODE;
  try {
    return normalizeEngineMode(storage.getItem(ENGINE_MODE_KEY));
  } catch {
    return DEFAULT_ENGINE_MODE;
  }
}

let current: EngineMode = readFromStorage();
const listeners = new Set<() => void>();

export function getEngineMode(): EngineMode {
  return current;
}

/** Persists the mode and notifies every subscriber. */
export function setEngineMode(mode: EngineMode): EngineMode {
  const next = normalizeEngineMode(mode);
  if (next === current) return current;
  current = next;
  const storage = storageOrNull();
  try {
    storage?.setItem(ENGINE_MODE_KEY, next);
  } catch {
    /* a full or refused store keeps the mode for this tab only */
  }
  for (const listener of listeners) listener();
  return current;
}

export function subscribeEngineMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-reads the stored value (used by tests and by a reload of the tab). */
export function reloadEngineMode(): EngineMode {
  current = readFromStorage();
  for (const listener of listeners) listener();
  return current;
}

/** React binding: re-renders a pane when the shared mode changes. */
export function useEngineMode(): EngineMode {
  return useSyncExternalStore(subscribeEngineMode, getEngineMode, getEngineMode);
}
