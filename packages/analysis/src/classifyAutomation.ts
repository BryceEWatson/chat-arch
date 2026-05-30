/**
 * Automation classifier — labels a session as an automated / templated
 * orchestration run vs a genuine interactive session, by matching the
 * first-user-turn against a versioned list of envelope signatures.
 *
 * Motivation: tooling that spawns `claude` programmatically (e.g. Bryce's
 * "Command" orchestration tool) writes hundreds-to-thousands of near-
 * identical transcripts — "Write the status paragraph now", "Action to
 * perform: …", etc. Ingested raw, these dominate every per-session metric
 * (session counts, top-project, cost, archetypes). There is NO transcript
 * METADATA marker that distinguishes them from human sessions (`entrypoint`
 * = `claude-vscode`, `userType` = `external`, `isSidechain` = false are all
 * identical), so classification is necessarily content-based. The signatures
 * below matched 1,329/1,359 sessions in the Command project and ZERO sessions
 * in any other project dir across the corpus — perfect precision at the time
 * of authoring.
 *
 * The classification drives two downstream behaviors (see the collapse
 * builder + the per-session kernels): (1) near-identical automated runs in a
 * project COLLAPSE into a single "activity" row carrying an instance count +
 * aggregate cost, so counts de-pollute while the frequency/cost signal is
 * preserved; (2) the analytical kernels (composite / decisions / trust /
 * archetypes / skill-curves) EXCLUDE automated runs — a templated status
 * paragraph is not a decision, correction, or skill.
 *
 * Pure / deterministic / React-free. Extend by adding a signature (and
 * bumping {@link AUTOMATION_CLASSIFIER_VERSION} so the exporter cache
 * self-invalidates). First-match-wins, so order specific → generic.
 */

export const AUTOMATION_CLASSIFIER_VERSION = 1;

export type AutomationTemplateId =
  | 'status-paragraph'
  | 'action-orchestration'
  | 'test-probe'
  | 'automated-envelope';

export interface AutomationSignature {
  /** Stable id stored on the entry + used as the collapse grouping key. */
  readonly templateId: AutomationTemplateId;
  /** Human-readable label for the collapsed-activity row. */
  readonly label: string;
  /**
   * Patterns tested against the FULL first-user-text (not the truncated
   * preview — the load-bearing marker, e.g. "Write the status paragraph
   * now", often sits at the END of a long templated prompt). A match on
   * ANY pattern classifies the session under this template.
   */
  readonly patterns: readonly RegExp[];
}

/**
 * Ordered specific → generic — first match wins. `automated-envelope` is the
 * catch-all and MUST stay last (action-orchestration prompts also contain
 * `<untrusted-run-output>`, but should classify as the more specific kind).
 */
export const AUTOMATION_SIGNATURES: readonly AutomationSignature[] = [
  {
    templateId: 'status-paragraph',
    label: 'Project status paragraph',
    patterns: [/Write the status paragraph now/i],
  },
  {
    templateId: 'action-orchestration',
    label: 'Action orchestration',
    patterns: [
      /Action to perform:/i,
      /Allowed actions:/i,
      /Action just completed:/i,
      /Base intent \(rewrite this/i,
    ],
  },
  {
    templateId: 'test-probe',
    label: 'Automated test probe',
    patterns: [
      /Use the (?:Bash|Write) tool to (?:run|create)\b/i,
      /\bhello-(?:allow|deny)\b/,
    ],
  },
  {
    templateId: 'automated-envelope',
    label: 'Automated orchestration',
    patterns: [
      /<untrusted-run-output>/i,
      /<untrusted-repo-files>/i,
      /BASE_TEMPLATE_SENTINEL/,
      /Facts \(the only ground truth\):/i,
    ],
  },
];

export interface AutomationClassification {
  /** True iff the first-user-text matched an automation signature. */
  readonly automated: boolean;
  /** The matched template id, or null when interactive. */
  readonly templateId: AutomationTemplateId | null;
  /** The matched template's display label, or null when interactive. */
  readonly label: string | null;
}

const INTERACTIVE: AutomationClassification = {
  automated: false,
  templateId: null,
  label: null,
};

/**
 * Classify a session by its first-user-text. Returns `INTERACTIVE`
 * (`automated: false`) when the text is empty/absent or matches no
 * signature. Pass the FULL first-user-text, not the truncated preview.
 */
export function classifyAutomation(
  firstUserText: string | null | undefined,
): AutomationClassification {
  if (typeof firstUserText !== 'string' || firstUserText.length === 0) {
    return INTERACTIVE;
  }
  for (const sig of AUTOMATION_SIGNATURES) {
    if (sig.patterns.some((re) => re.test(firstUserText))) {
      return { automated: true, templateId: sig.templateId, label: sig.label };
    }
  }
  return INTERACTIVE;
}
