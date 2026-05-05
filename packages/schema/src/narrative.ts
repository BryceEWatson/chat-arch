import type { Sentiment, NarrativeAction } from './sentiment.js';
import { UNASSIGNED_PROJECT_ID } from './project.js';

export interface NarrativeEvidence {
  sessionId: string;
  anchor?: string;
  excerpt?: string;
}

export interface Narrative {
  id: string;
  projectId: string;
  sessionIds: readonly string[];
  sentiment: Sentiment;
  title: string;
  body: string;
  evidence: readonly NarrativeEvidence[];
  generatedAt: string;
  actionType: NarrativeAction;
}

export class InvalidNarrativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNarrativeError';
  }
}

export function validateNarrative(n: Narrative): void {
  if (n.projectId === UNASSIGNED_PROJECT_ID) {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} has projectId === ${UNASSIGNED_PROJECT_ID}; the unassigned pseudo-project does not bear narratives (spec §4.3, decision D8).`,
    );
  }
  if (n.sentiment === 'neutral') {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} has neutral sentiment; only positive/negative narratives are emitted (spec §4.4).`,
    );
  }
  const expected: NarrativeAction =
    n.sentiment === 'positive' ? 'encode-as-pattern' : 'generate-corrective-prompt';
  if (n.actionType !== expected) {
    throw new InvalidNarrativeError(
      `Narrative ${n.id} actionType ${n.actionType} mismatches sentiment ${n.sentiment} (expected ${expected}).`,
    );
  }
}
