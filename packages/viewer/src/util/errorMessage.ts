/**
 * Client-side error translator. Takes whatever a fetch / parse /
 * domain error path threw and produces a user-facing string suitable
 * for rendering in an ErrorState `detail` prop, a banner, or a
 * tooltip.
 *
 * Rules:
 *   - Filters internal route paths (`/api/...`) out of network-error
 *     messages — surfacing those tells the user something they can't
 *     act on. The translator says "the local backend isn't reachable"
 *     instead.
 *   - Translates known browser network failure strings (`Failed to
 *     fetch`, `NetworkError when attempting to fetch resource.`)
 *     into "the local backend isn't reachable — check that pnpm dev
 *     is running" form. Without this, mobile Safari users get the
 *     opaque "Load failed" string.
 *   - Translates the `HTTP N` family ("HTTP 500", "status 500") into
 *     "the server responded with N — that's a server-side error;
 *     check the dev-server console for the traceback" form. Status
 *     code is preserved as evidence; the burden of next-action shifts
 *     to the right log.
 *   - Falls back to the raw message if nothing matches, so genuinely
 *     bespoke errors still propagate.
 *
 * Use at the boundary where the error is rendered — NOT at the
 * throw site, because rethrowing translated errors loses the
 * original `cause` for diagnostics.
 */

const FETCH_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /^Failed to fetch$/i,
  /NetworkError when attempting to fetch/i,
  /^Load failed$/i, // mobile Safari
  /^TypeError: Failed to fetch$/i,
];

const HTTP_STATUS_RE = /\bHTTP\s+(\d{3})\b|\bstatus\s+(\d{3})\b/i;

const STATUS_HINT: Record<string, string> = {
  '400': "the server rejected the request as malformed.",
  '401': "the server requires sign-in to perform this action.",
  '403': "the server refused the action for permission reasons.",
  '404': "the server couldn't find what was requested. The endpoint may be missing from this build (the hosted version is static and omits the local-only API routes).",
  '409': "the server is busy with another request — try again in a moment.",
  '500':
    "the server hit an internal error. If you're running the dev server, check its terminal output for the full traceback.",
  '502':
    "the proxy in front of the server couldn't reach it. Check that pnpm dev is still running.",
  '503':
    "the server is temporarily unavailable. Try again in a moment.",
};

export interface ErrorMessageOptions {
  /**
   * Short label for the surface where the error happened, e.g.
   * "applying the correction" or "loading the chat answer". Used
   * to give a verb-led opening sentence ("Couldn't apply the
   * correction:").
   */
  context?: string;
}

export function errorToUserMessage(
  err: unknown,
  opts: ErrorMessageOptions = {},
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown error.';
  const lead = opts.context ? `Couldn't ${opts.context}.` : '';

  if (FETCH_FAILURE_PATTERNS.some((re) => re.test(raw))) {
    return [
      lead,
      "The local backend isn't reachable. If you're running locally, check that pnpm dev is still running in your terminal.",
    ]
      .filter(Boolean)
      .join(' ');
  }

  const httpMatch = HTTP_STATUS_RE.exec(raw);
  if (httpMatch) {
    const status = (httpMatch[1] ?? httpMatch[2]) as string;
    const hint =
      STATUS_HINT[status] ??
      `the server responded with HTTP ${status}.`;
    return [lead, hint].filter(Boolean).join(' ');
  }

  // Strip internal route paths from the surfaced message so the user
  // doesn't see "/api/chat-answer" — that's a developer-only locator.
  const sanitized = raw.replace(/\/api\/[a-z0-9\-_]+/gi, 'the local backend');

  return [lead, sanitized].filter(Boolean).join(' ');
}
