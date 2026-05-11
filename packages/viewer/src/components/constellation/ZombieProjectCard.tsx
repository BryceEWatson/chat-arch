/**
 * Zombie-project payload shape from `analysis/zombies.heuristic.json`.
 *
 * Phase 3 cut the CONSTELLATION surface that rendered these as cards;
 * the type still lives here because PracticeMode + the practice-audit
 * kernel consume the structure when surfacing zombie-driven findings.
 * Path is preserved (rather than relocated) to avoid churning every
 * import site for a single-file move.
 */

export interface ZombieProject {
  id: string;
  displayName: string;
  sessionCount: number;
  firstActiveAt: number;
  lastActiveAt: number;
  daysSinceLast: number;
  classification: 'active' | 'dormant' | 'zombie';
  probeSessionIds: readonly string[];
  burstWindows: ReadonlyArray<{ start: number; end: number; count: number }>;
  inferenceSource: 'project_field' | 'cwd_basename' | 'title_keyword';
}
