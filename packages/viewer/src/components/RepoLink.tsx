/**
 * Small "view source" chip linking out to the open-source repo. Lives
 * in two places:
 *
 *   - Bottom of the primary sidebar, under the CMD/TIM/ANL/CST nav.
 *     Anchored via an elbow footer so it reads as part of the LCARS
 *     chrome rather than floating UI.
 *   - Inline in the landing TrustStrip, next to the local-first
 *     pledge, so a first-time visitor can verify the promise by
 *     clicking through to the code before any data is loaded.
 *
 * `{ }` glyph — not a GitHub logo — keeps the affordance feeling like
 * source code without importing a third-party brand asset into an
 * LCARS-skinned UI.
 */
const REPO_URL = 'https://github.com/BryceEWatson/chat-arch';

export interface RepoLinkProps {
  /** Visual variant. `chip` is the sidebar footer; `inline` is in-copy. */
  variant?: 'chip' | 'inline';
  /** Override label text. Defaults to "SOURCE". */
  label?: string;
}

export function RepoLink({ variant = 'chip', label = 'SOURCE' }: RepoLinkProps) {
  const className =
    variant === 'chip'
      ? 'lcars-repo-link lcars-repo-link--chip'
      : 'lcars-repo-link lcars-repo-link--inline';
  return (
    <a
      className={className}
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="view Chat Archaeologist source code on GitHub (opens in new tab)"
    >
      <span className="lcars-repo-link__glyph" aria-hidden="true">
        {'{ }'}
      </span>
      <span className="lcars-repo-link__label">{label}</span>
      <span className="lcars-repo-link__arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
