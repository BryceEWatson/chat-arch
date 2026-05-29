import { describe, it, expect } from 'vitest';
import type { Decision, DecisionsFile } from '@chat-arch/schema';
import { isDecisionSidecar, resetDecisionsFile } from '../../src/pages/api/clear-decisions.js';

function candidate(id: string, sessionId = 'sessA') {
  return {
    id,
    sessionId,
    userTurnIndex: 0,
    kind: 'explicit-go-with' as const,
    span: { phrase: "let's go with X", startOffset: 0 },
    surroundingContext: "let's go with X instead of Y",
    precedingAssistantExcerpt: 'I recommend X',
  };
}

function classifiedRow(id: string): Decision {
  return {
    candidate: candidate(id),
    classification: {
      kind: 'explicit-go-with',
      distilledDecision: 'use X',
      chosen: ['X'],
      rejected: ['Y'],
      rationale: 'X is simpler',
      confidence: 0.9,
      actionable: true,
    },
    outcomeRef: { sessionId: 'sessA', compositeScore: 0.8, binaryClass: 'good' },
    trustCalibration: { acceptedAssistant: true, landed: true },
  };
}

describe('resetDecisionsFile', () => {
  it('strips classification + trustCalibration but preserves candidate + outcomeRef', () => {
    const file: DecisionsFile = {
      generatedAt: 1000,
      decisionHeuristicVersion: 2,
      decisions: [
        classifiedRow('dec_1'),
        { candidate: candidate('dec_2', 'sessB'), classification: null, outcomeRef: null },
      ],
      scannedSessionIds: ['sessA', 'sessB'],
    };
    const out = resetDecisionsFile(file, 5000);

    expect(out.generatedAt).toBe(5000);
    expect(out.decisionHeuristicVersion).toBe(2);
    expect(out.scannedSessionIds).toEqual(['sessA', 'sessB']);
    expect(out.decisions).toHaveLength(2);

    const [r1, r2] = out.decisions;
    expect(r1?.classification).toBeNull();
    expect(r1?.candidate.id).toBe('dec_1');
    expect(r1?.candidate.precedingAssistantExcerpt).toBe('I recommend X');
    expect(r1?.outcomeRef).toEqual({
      sessionId: 'sessA',
      compositeScore: 0.8,
      binaryClass: 'good',
    });
    expect(r1?.trustCalibration).toBeUndefined();
    expect(r2?.classification).toBeNull();
  });
});

describe('isDecisionSidecar', () => {
  it('matches the skill-output sidecars', () => {
    expect(isDecisionSidecar('decision-clusters.json')).toBe(true);
    expect(isDecisionSidecar('decision-status-abc-123.json')).toBe(true);
    expect(isDecisionSidecar('decisions.json.tmp.req9')).toBe(true);
  });

  it('does NOT match decisions.json itself (rewritten, not deleted)', () => {
    expect(isDecisionSidecar('decisions.json')).toBe(false);
  });

  it('does NOT match unrelated or corrections files', () => {
    expect(isDecisionSidecar('corrections.json')).toBe(false);
    expect(isDecisionSidecar('decision-candidates.json')).toBe(false);
    expect(isDecisionSidecar('narratives.json')).toBe(false);
  });

  it('rejects names with path separators or empty names', () => {
    // readdir only yields flat entries, but reject separators defensively
    // (matches the corrections isMiningArtifact guard).
    expect(isDecisionSidecar('../decisions.json.tmp.x')).toBe(false);
    expect(isDecisionSidecar('sub/decision-clusters.json')).toBe(false);
    expect(isDecisionSidecar('sub\\decision-clusters.json')).toBe(false);
    expect(isDecisionSidecar('')).toBe(false);
  });
});
