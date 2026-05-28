import { useCallback, useEffect, useState } from 'react';

/**
 * Hook that encapsulates the `/api/move-to-project` dance (Project
 * Identity v2 PR2). Mirrors {@link useRescan}'s availability-probe
 * contract.
 *
 * On mount, GETs `/api/move-to-project` to see whether the endpoint is
 * live. The endpoint only exists when the user is running the Astro dev
 * server (per-route SSR). The hosted static build doesn't ship it, so
 * the GET 404s → `available === false` → the caller hides the
 * MOVE TO PROJECT affordance.
 *
 * `move()` POSTs `{ sessionId, projectId, displayName? }`. The endpoint
 * appends to `chat-arch-data/projectOverrides.json` (consumed by the v2
 * cascade rule 0); a rescan is needed before the change takes effect.
 */

export interface MoveToProjectResponse {
  ok: boolean;
  projectId?: string;
  sessionId?: string;
  overridesCount?: number;
  note?: string;
  error?: string;
}

export type MoveStatus = 'idle' | 'moving' | 'error' | 'ok';

export interface UseMoveToProjectResult {
  /**
   * Whether the `/api/move-to-project` endpoint was reachable on mount.
   * Tri-state to avoid mount-flicker, mirroring {@link useRescan}:
   * 'probing' means "optimistically local-dev" — render the affordance
   * until the probe resolves to a definitive `false`. Helper:
   * `available !== false` ⇒ treat as local dev.
   */
  available: boolean | 'probing';
  status: MoveStatus;
  /** Response payload from the most recent attempt; cleared on next move. */
  last: MoveToProjectResponse | null;
  /**
   * Trigger a move. Resolves to the response payload. `projectId` is the
   * raw key the cascade re-slugs (see DetailMode's picker comment for the
   * proj_-prefix-stripping convention); `displayName` is only sent for a
   * freshly-typed project name.
   */
  move: (
    sessionId: string,
    projectId: string,
    displayName?: string,
  ) => Promise<MoveToProjectResponse | null>;
}

const MOVE_PATH = '/api/move-to-project';

export function useMoveToProject(): UseMoveToProjectResult {
  const [available, setAvailable] = useState<boolean | 'probing'>('probing');
  const [status, setStatus] = useState<MoveStatus>('idle');
  const [last, setLast] = useState<MoveToProjectResponse | null>(null);

  // Probe once on mount. Network + 404 + HTML fallbacks all mean "not
  // available" so we keep the affordance hidden rather than showing it
  // in a broken state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(MOVE_PATH, { method: 'GET' });
        if (cancelled) return;
        const ct = res.headers.get('content-type') ?? '';
        if (!res.ok || !ct.includes('application/json')) {
          setAvailable(false);
          return;
        }
        const body = (await res.json()) as { available?: boolean };
        setAvailable(body.available === true);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const move = useCallback(
    async (
      sessionId: string,
      projectId: string,
      displayName?: string,
    ): Promise<MoveToProjectResponse | null> => {
      if (status === 'moving') return null;
      setStatus('moving');
      setLast(null);

      const fail = (error: string): MoveToProjectResponse => {
        const payload: MoveToProjectResponse = { ok: false, error };
        setLast(payload);
        setStatus('error');
        return payload;
      };

      try {
        // X-Requested-With is the same CSRF gate the rescan endpoint uses:
        // a hostile cross-origin page cannot set custom headers on a simple
        // form POST. Keep in sync with
        // `apps/standalone/src/pages/api/move-to-project.ts`.
        const res = await fetch(MOVE_PATH, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'chat-arch-move-to-project',
          },
          body: JSON.stringify({
            sessionId,
            projectId,
            ...(displayName !== undefined ? { displayName } : {}),
          }),
        });
        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('application/json')) {
          const text = await res.text();
          return fail(`Unexpected response (status ${res.status}): ${text.slice(0, 200)}`);
        }
        const body = (await res.json()) as MoveToProjectResponse;
        setLast(body);
        setStatus(body.ok ? 'ok' : 'error');
        return body;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
    [status],
  );

  // After a terminal state, reset to idle so the affordance re-enables.
  // Longer on error (8s) than on success (4s) so the copy stays readable.
  useEffect(() => {
    if (status !== 'ok' && status !== 'error') return undefined;
    const delay = status === 'error' ? 8000 : 4000;
    const id = window.setTimeout(() => setStatus('idle'), delay);
    return () => window.clearTimeout(id);
  }, [status]);

  return { available, status, last, move };
}
