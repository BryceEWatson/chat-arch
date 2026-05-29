import type { LocalTranscriptEntry } from '../types.js';
import { lineTextPreview, lineFullBody, shouldExpand } from '../data/transcriptParse.js';

export interface TranscriptListProps {
  entries: readonly LocalTranscriptEntry[];
}

function entryType(entry: LocalTranscriptEntry): string {
  if (entry.type === '_malformed') return '_malformed';
  return String(entry.line['type'] ?? 'unknown');
}

function entryTimestamp(entry: LocalTranscriptEntry): string {
  if (entry.type === '_malformed') return '';
  const ts = entry.line['timestamp'];
  return typeof ts === 'string' ? ts : '';
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour12: false });
}

// Underscore-bearing type strings (`tool_use`, `_malformed`) read as
// "underscore" on NVDA + VoiceOver. Show the same word visually (CSS
// uppercases via the chrome rule) but expose a clean space-separated
// form to the DOM so the SR rendering is unambiguous.
function visibleType(rawType: string): string {
  return rawType.replace(/_/g, ' ').trim();
}

export function TranscriptList({ entries }: TranscriptListProps) {
  if (entries.length === 0) {
    return (
      <div className="lcars-transcript-list__empty">
        (transcript has no parsed lines)
      </div>
    );
  }
  return (
    <ol className="lcars-transcript-list">
      {entries.map((entry, idx) => {
        const type = entryType(entry);
        const ts = entryTimestamp(entry);
        const isMalformed = entry.type === '_malformed';
        const preview = entry.type === 'known' ? lineTextPreview(entry.line) : entry.raw;
        const full = entry.type === 'known' ? lineFullBody(entry.line) : entry.raw;
        // Only show the expander for genuinely large bodies —
        // `shouldExpand` gates on both (a) full differs from preview
        // AND (b) full exceeds the min-char threshold, so short
        // tool_use/tool_result rows don't clutter the list with a
        // "show full content" button that just repeats the same
        // information in pretty-JSON form.
        const hasMore = shouldExpand(preview, full);
        const className = `lcars-transcript-entry lcars-transcript-entry--${type}${
          isMalformed ? ' lcars-transcript-entry--malformed' : ''
        }`;
        const displayType = visibleType(type);
        return (
          <li key={idx} className={className}>
            <div className="lcars-transcript-entry__header">
              <span className="lcars-transcript-entry__type">{displayType}</span>
              {ts && (
                <time
                  className="lcars-transcript-entry__time"
                  dateTime={ts}
                  aria-label={ts}
                >
                  {formatTimeOfDay(ts)}
                </time>
              )}
              {isMalformed && entry.type === '_malformed' && (
                <span className="lcars-transcript-entry__err">
                  <span className="lcars-sr-only">parse error: </span>
                  {entry.error}
                </span>
              )}
            </div>
            {preview && <pre className="lcars-transcript-entry__body">{preview}</pre>}
            {hasMore && (
              <details className="lcars-transcript-entry__details">
                <summary
                  className="lcars-transcript-entry__summary"
                  aria-label={`full content for ${displayType} entry ${idx + 1}`}
                >
                  full content
                </summary>
                <pre className="lcars-transcript-entry__full" tabIndex={0}>{full}</pre>
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}
