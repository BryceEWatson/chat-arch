/**
 * Client for `POST /api/apply-correction`. Mirrors
 * `mineCorrectionsClient.ts` for probe + error-handling shape so the
 * panel can hide the APPLY action gracefully on production static
 * builds where the dev-server endpoint isn't bundled.
 */

import type { ProposedUpgrade } from '@chat-arch/schema';
import { errorToUserMessage } from '../util/errorMessage.js';

const APPLY_PATH = '/api/apply-correction';
const REQUIRED_HEADER_VALUE = 'chat-arch-apply-correction';

export interface ApplyCorrectionRequest {
  patternId: string;
  proposedUpgrade: ProposedUpgrade;
  ruleSummary: string;
  targetFiles?: string[];
  notes?: string;
}

export interface ApplyCorrectionResult {
  ok: boolean;
  /** Set when ok === true. */
  appliedImprovementId?: string;
  /** Set when ok === true. */
  ledgerPath?: string;
  /** Set when ok === true. */
  entriesCount?: number;
  /** Set when ok === false. */
  error?: string;
}

/**
 * GET probe. Returns true when the endpoint exists (dev server) and
 * false otherwise (static production build). Networks failures also
 * fall through to false — the panel hides APPLY in that case.
 */
export async function probeApplyCorrection(): Promise<boolean> {
  try {
    const res = await fetch(APPLY_PATH, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * POST the apply request. Always resolves to a result object — never
 * throws — so callers can drive a state machine without a try/catch.
 */
export async function applyCorrection(
  req: ApplyCorrectionRequest,
): Promise<ApplyCorrectionResult> {
  let res: Response;
  try {
    res = await fetch(APPLY_PATH, {
      method: 'POST',
      headers: {
        'X-Requested-With': REQUIRED_HEADER_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify(req),
    });
  } catch (err) {
    return {
      ok: false,
      error: errorToUserMessage(err, { context: 'apply the correction' }),
    };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    // 409 is the "another apply is in flight" gate from the server.
    // Surface a friendly message rather than the raw status string —
    // UpgradeRow renders this verbatim in its error state.
    if (res.status === 409) {
      return {
        ok: false,
        error: 'Another apply is in flight. Try again in a moment.',
      };
    }
    const serverError =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error?: unknown }).error)
        : null;
    const errMsg = errorToUserMessage(
      serverError ?? `HTTP ${res.status}`,
      { context: 'apply the correction' },
    );
    return { ok: false, error: errMsg };
  }
  if (parsed && typeof parsed === 'object') {
    const p = parsed as {
      ok?: boolean;
      appliedImprovementId?: string;
      ledgerPath?: string;
      entriesCount?: number;
      error?: string;
    };
    if (p.ok === true && typeof p.appliedImprovementId === 'string') {
      return {
        ok: true,
        appliedImprovementId: p.appliedImprovementId,
        ...(typeof p.ledgerPath === 'string' ? { ledgerPath: p.ledgerPath } : {}),
        ...(typeof p.entriesCount === 'number'
          ? { entriesCount: p.entriesCount }
          : {}),
      };
    }
    return { ok: false, error: p.error ?? 'apply-correction returned unexpected body' };
  }
  return { ok: false, error: 'apply-correction returned no body' };
}
