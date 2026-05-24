/**
 * Phase Rev3-F F6 — viewer-side `ANTHROPIC_API_KEY` opt-in toggle.
 *
 * Two-rail design:
 *   - This file (viewer) — per-user comfort. Defaults to OFF.
 *   - `apps/standalone/src/lib/curatorClaude.ts` (server) — deployment
 *     policy, checked via env var. Defaults to OFF.
 *
 * Both rails must be ON for the API-key fallback to fire (default-
 * deny). The viewer reads the flag here, mirrors it in the request
 * body to `/api/curate` and `/api/falsify`, and the server-side
 * helper makes the final spawn decision.
 *
 * Why localStorage: the toggle is a per-machine user preference,
 * not corpus-derived data. No need to put it in IndexedDB or persist
 * to the SQLite substrate; localStorage gives synchronous reads
 * which keep the toggle UI snappy.
 *
 * Plan-billing posture: `feedback_claude_code_not_api` — default to
 * plan usage (claude -p subprocess); API-key is a paid fallback the
 * user explicitly opts into.
 */

// Same `chat-arch:` colon-prefix as the embed-device-pref store so
// NuclearReset's wipe (which targets `chat-arch:`-prefixed keys)
// clears this toggle alongside everything else corpus-adjacent.
const KEY = 'chat-arch:curator-api-key-opt-in-v1';

export interface CuratorApiKeyOptInState {
  /** True iff the user has ticked the opt-in checkbox. Default false. */
  readonly optedIn: boolean;
  /** ms-since-epoch of the last toggle, used by the audit log. */
  readonly toggledAt: number;
}

const DEFAULT_STATE: CuratorApiKeyOptInState = {
  optedIn: false,
  toggledAt: 0,
};

/**
 * Read the current opt-in state. Returns the default-off state when
 * localStorage is unavailable (SSR, private-mode browsers) or the
 * stored value is malformed.
 *
 * The "is the user opted in?" check is exposed separately as a
 * convenience because most callers don't care about the timestamp.
 */
export function loadCuratorApiKeyOptIn(): CuratorApiKeyOptInState {
  if (typeof localStorage === 'undefined') return DEFAULT_STATE;
  const raw = localStorage.getItem(KEY);
  if (raw === null) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<CuratorApiKeyOptInState>;
    if (typeof parsed.optedIn !== 'boolean') return DEFAULT_STATE;
    const toggledAt =
      typeof parsed.toggledAt === 'number' && Number.isFinite(parsed.toggledAt)
        ? parsed.toggledAt
        : 0;
    return { optedIn: parsed.optedIn, toggledAt };
  } catch {
    return DEFAULT_STATE;
  }
}

/** Convenience read — strict boolean for the common "is it on?" check. */
export function isCuratorApiKeyOptInEnabled(): boolean {
  return loadCuratorApiKeyOptIn().optedIn;
}

/**
 * Set the opt-in flag. Returns the new state. Side-effect-free
 * outside localStorage; callers that need to react to the change
 * (re-fetch curator banner state, surface a toast) should subscribe
 * to the StorageEvent on the window.
 *
 * No-op when localStorage is unavailable (returns the would-be state
 * so the UI can still render based on the intent, even if it doesn't
 * persist).
 */
export function setCuratorApiKeyOptIn(
  optedIn: boolean,
  now: number = Date.now(),
): CuratorApiKeyOptInState {
  const next: CuratorApiKeyOptInState = { optedIn, toggledAt: now };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Quota / locked storage — preserve the in-memory intent for
      // the immediate render even though we couldn't persist.
    }
  }
  return next;
}

/** For NuclearReset / test cleanup. */
export function clearCuratorApiKeyOptIn(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
