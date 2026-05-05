/**
 * Rule-based sentiment classifier — spec §15, decision D9.
 *
 * Pure: takes a single text blob (typically title + preview + summary
 * concatenated by the caller) and returns a Sentiment. No I/O, no embed.
 *
 * LLM-based sentiment is descoped to v2.1 (D7).
 */

import type { Sentiment } from '@chat-arch/schema';

// Apostrophe class: ASCII (U+0027) + Unicode curly variants (U+2018, U+2019).
// Built via String.fromCharCode so the source file stays free of literal smart
// quotes (which can be ambiguous in single-quoted strings).
const APOS_CLASS =
  '[' +
  String.fromCharCode(0x27) +
  String.fromCharCode(0x2018) +
  String.fromCharCode(0x2019) +
  ']';

const POSITIVE_MARKERS: readonly RegExp[] = [
  // Note: "work"/"works" intentionally excluded — too easily appears inside
  // negative phrases ("doesn't work", "not working") and the literal-form
  // "doesn't" matcher only fires on that exact phrase.
  /\bworked\b/i,
  /\bworking\s+(now|fine|well|great)\b/i,
  /\bshipped?\b/i,
  /\btests?\s+pass/i,
  /\ball\s+green\b/i,
  /\bmerged?\b/i,
  /\bdeploy(ed)?\s+(success|succeeded|ok)/i,
  /\bsuccess(ful)?\b/i,
  /\bfixed\b/i,
  /\bresolved\b/i,
  /\bcompleted?\b/i,
  /\bperfect\b/i,
  /\bnice\b/i,
];

const NEGATIVE_MARKERS: readonly RegExp[] = [
  new RegExp(`\\bdoesn${APOS_CLASS}?t\\s+work\\b`, 'i'),
  new RegExp(`\\bdidn${APOS_CLASS}?t\\s+work\\b`, 'i'),
  /\bnot\s+work(ing)?\b/i,
  /\bbroken?\b/i,
  /\bbreaks?\b/i,
  /\bfailed?\b/i,
  /\bfailing\b/i,
  /\bstuck\b/i,
  /\berror(s|ed)?\b/i,
  /\bbug(s|gy)?\b/i,
  /\bcrash(ed|ing)?\b/i,
  /\bregression\b/i,
  /\babandoned?\b/i,
  /\bgave\s+up\b/i,
];

export interface SentimentScore {
  sentiment: Sentiment;
  positiveHits: number;
  negativeHits: number;
}

export function scoreSentiment(text: string): SentimentScore {
  if (!text || text.length === 0) {
    return { sentiment: 'neutral', positiveHits: 0, negativeHits: 0 };
  }
  let positiveHits = 0;
  let negativeHits = 0;
  for (const re of POSITIVE_MARKERS) if (re.test(text)) positiveHits += 1;
  for (const re of NEGATIVE_MARKERS) if (re.test(text)) negativeHits += 1;

  let sentiment: Sentiment = 'neutral';
  if (positiveHits > negativeHits) sentiment = 'positive';
  else if (negativeHits > positiveHits) sentiment = 'negative';
  return { sentiment, positiveHits, negativeHits };
}
