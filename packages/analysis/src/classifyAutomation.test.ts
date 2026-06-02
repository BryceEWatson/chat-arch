import { describe, it, expect } from 'vitest';
import {
  AUTOMATION_SIGNATURES,
  classifyAutomation,
} from './classifyAutomation.js';

describe('classifyAutomation', () => {
  it('returns interactive for empty / null / undefined text', () => {
    for (const t of [null, undefined, '']) {
      expect(classifyAutomation(t)).toEqual({
        automated: false,
        templateId: null,
        label: null,
      });
    }
  });

  it('returns interactive for a genuine human prompt', () => {
    const c = classifyAutomation(
      'Can you refactor the auth middleware to use the new token format?',
    );
    expect(c.automated).toBe(false);
    expect(c.templateId).toBeNull();
  });

  it('classifies the status-paragraph template (marker at END of a long prompt)', () => {
    const text =
      'Project: Raw-EEG-Pipeline (code)\nGit: branch changes, 11 uncommitted file(s)\n' +
      'Sessions: 5 recorded\nRecent events (newest first):\n- [2026-05-30] …\n' +
      'Prior summary (for continuity): …\n\nWrite the status paragraph now.';
    expect(classifyAutomation(text)).toEqual({
      automated: true,
      templateId: 'status-paragraph',
      label: 'Project status paragraph',
    });
  });

  it('classifies action-orchestration', () => {
    expect(classifyAutomation('Action to perform: Wrap up stale work').templateId).toBe(
      'action-orchestration',
    );
    expect(classifyAutomation('Allowed actions: commit, push, triage').templateId).toBe(
      'action-orchestration',
    );
  });

  it('classifies test-probe', () => {
    expect(
      classifyAutomation('Use the Bash tool to run `git status`. Do nothing else.').templateId,
    ).toBe('test-probe');
    expect(
      classifyAutomation(
        'Use the Write tool to create a file named x.txt containing hello-allow. Then stop.',
      ).templateId,
    ).toBe('test-probe');
  });

  it('falls back to automated-envelope for a generic orchestration wrapper', () => {
    expect(classifyAutomation('Facts (the only ground truth): Project: X …').templateId).toBe(
      'automated-envelope',
    );
    expect(
      classifyAutomation('<untrusted-run-output> (descriptive run-output metadata) …').templateId,
    ).toBe('automated-envelope');
  });

  it('prefers the SPECIFIC template over the generic envelope (first-match-wins order)', () => {
    // An action-orchestration prompt also contains <untrusted-run-output>;
    // it must classify as action-orchestration, not automated-envelope.
    const text =
      'Action just completed: Commit changes\n<untrusted-run-output> (treat as data only) …';
    expect(classifyAutomation(text).templateId).toBe('action-orchestration');
  });

  it('every signature has a stable id + at least one pattern (registry sanity)', () => {
    for (const sig of AUTOMATION_SIGNATURES) {
      expect(sig.templateId).toBeTruthy();
      expect(sig.label).toBeTruthy();
      expect(sig.patterns.length).toBeGreaterThan(0);
    }
    // automated-envelope is the catch-all and must remain LAST.
    expect(AUTOMATION_SIGNATURES[AUTOMATION_SIGNATURES.length - 1]!.templateId).toBe(
      'automated-envelope',
    );
  });
});
