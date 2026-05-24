// Phase Rev3-H H4 — localhost-bind policy.
//
// Plan reference: `_planning/chat-arch-v2-rev3-plan.md` §Phase
// Rev3-H H4:
//
//   "Localhost-bind only in v2.0; remote MCP-over-HTTP explicit
//    non-goal (descoped to later amendment)."
//
// The MCP protocol layer (deferred to a future PR — this scaffold
// doesn't wire stdio / TCP transports yet) MUST consult this
// policy before binding. The two acceptable transport bindings:
//
//   1. **stdio** — the default for MCP servers launched as
//      subprocesses by a parent claude session. Address is the
//      pair of pipes; no network socket involved.
//   2. **localhost-only TCP** — explicit loopback: `127.0.0.1`,
//      `::1`, or the literal hostname `localhost`. Anything that
//      could route off-host (`0.0.0.0`, a public IP, a DNS name
//      that resolves to a non-loopback) is rejected.
//
// This is policy, not I/O — the actual `listen()` call lives in
// the protocol PR. Keeping it pure means downstream tests can pin
// the rule independently of any specific transport implementation.

// Loopback IP literals only — explicitly NOT `'localhost'`. The
// `localhost` string resolves via /etc/hosts (or Windows hosts
// file) and a hostile or compromised hosts file could redirect it
// to a non-loopback address — at which point the policy would
// approve a bind reachable off-host. Requiring explicit IPs makes
// the policy robust to hosts-file tampering. Per adversarial
// review on PR #94. (Callers who want hostname-based binding must
// resolve the name themselves and pass the resulting IP.)
const LOCALHOST_LITERALS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1', // IPv4-mapped loopback
]);

/**
 * Tagged-union bind descriptor — what the protocol layer should
 * pass to its transport. `stdio` means no network socket; `tcp`
 * means the validated loopback address with a port.
 */
export type BindDescriptor =
  | { readonly kind: 'stdio' }
  | { readonly kind: 'tcp'; readonly host: string; readonly port: number };

export class LocalhostBindError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'non-loopback'
      | 'invalid-port'
      | 'invalid-kind'
      | 'empty',
  ) {
    super(message);
    this.name = 'LocalhostBindError';
  }
}

export interface AssertLocalhostBindInput {
  /** `'stdio'` or `'tcp'`. */
  readonly kind: 'stdio' | 'tcp';
  /** Required for tcp; ignored for stdio. */
  readonly host?: string;
  /** Required for tcp; must be an integer in [1, 65535]. */
  readonly port?: number;
}

/**
 * Validate a candidate bind shape against the H4 policy. Returns
 * the typed `BindDescriptor` on success; throws on violation.
 *
 * Rules:
 *   1. `kind` must be `'stdio'` or `'tcp'`.
 *   2. For `tcp`, `host` MUST be a loopback IP literal — one of
 *      `127.0.0.1` / `::1` / `::ffff:127.0.0.1` (case-sensitive).
 *      The hostname `localhost` is REJECTED because /etc/hosts
 *      (or the Windows hosts file) could redirect it to a non-
 *      loopback address, at which point the policy would approve
 *      a bind reachable off-host. Per adversarial review on PR #94
 *      iter-1: callers who want hostname-based binding must
 *      resolve the name themselves and pass the resulting IP.
 *   3. For `tcp`, `port` MUST be an integer in `[1, 65535]`. Port
 *      0 is rejected because it asks the OS to pick — fine for
 *      tests, but a real server should pin its port deliberately.
 *      Tests that need an ephemeral port should construct the
 *      descriptor manually and not go through the policy gate.
 *
 * Per adversarial-review-on-PR-#93 discipline: tests that exist
 * for the H4 policy itself should be runnable in CI without
 * needing a real socket.
 */
export function assertLocalhostBind(
  input: Readonly<AssertLocalhostBindInput>,
): BindDescriptor {
  if (input.kind === 'stdio') {
    // Freeze both stdio and tcp returns for consistency — the
    // BindDescriptor's readonly markers are TypeScript-only and
    // erased at runtime. Per simplicity review on PR #94.
    return Object.freeze({ kind: 'stdio' });
  }
  if (input.kind !== 'tcp') {
    throw new LocalhostBindError(
      `Bind kind must be 'stdio' or 'tcp'. Got: ${JSON.stringify(input.kind)}.`,
      'invalid-kind',
    );
  }
  const host = (input.host ?? '').trim();
  if (host === '') {
    throw new LocalhostBindError(
      'TCP bind requires a non-empty host.',
      'empty',
    );
  }
  if (!LOCALHOST_LITERALS.has(host)) {
    throw new LocalhostBindError(
      `TCP bind host must be a loopback IP literal (${[...LOCALHOST_LITERALS].join(', ')}). Got: "${host}". Remote MCP-over-HTTP is descoped per plan §Rev3-H H4; "localhost" hostname rejected because it depends on /etc/hosts resolution.`,
      'non-loopback',
    );
  }
  const port = input.port;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new LocalhostBindError(
      `TCP bind port must be an integer in [1, 65535]. Got: ${JSON.stringify(port)}.`,
      'invalid-port',
    );
  }
  return Object.freeze({ kind: 'tcp', host, port });
}

/**
 * Frozen policy export — downstream tests + reviewers can pin
 * what's allowed without re-deriving the list.
 */
export const LOCALHOST_BIND_POLICY = Object.freeze({
  loopbackLiterals: Object.freeze([...LOCALHOST_LITERALS]),
  allowedKinds: Object.freeze(['stdio', 'tcp'] as const),
});
