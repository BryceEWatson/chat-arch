/**
 * Shallow markdown-syntax stripper for preview / rationale / excerpt
 * contexts where the LLM (or a copy-paste from another doc) may have
 * embedded markdown but we want to render the text inline. This is NOT
 * a markdown renderer — it produces plain text. Use a parser if you
 * need actual formatted output. Mirrors the rule set previously inlined
 * inside `SessionCard.tsx` and now reused across CorrectionPatternCard
 * and CuratorFeed.
 *
 * Handles bold (`**x**` / `__x__`), italic (`*x*` / `_x_`),
 * inline code (`` `x` ``), inline links (`[text](url)` → `text`),
 * reference-style links (`[text][ref]` → `text`), and horizontal rules
 * (`---` on a line of its own). Stripped char-by-char: heading hashes,
 * blockquote markers, table pipes, leftover backticks/asterisks.
 */
export function stripMarkdown(s: string): string {
  return (
    s
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
      .replace(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '')
      .replace(/[#*`>|]/g, '')
  );
}
