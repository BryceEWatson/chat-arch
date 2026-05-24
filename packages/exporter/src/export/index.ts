/**
 * Public surface of the markdown / Obsidian export submodule.
 *
 * Phase 4 of the outcome-substrate roadmap — pure generators that emit
 * Obsidian-flavored markdown plus a sidecar `manifest.json` indexing
 * every produced file. The viewer's Wave-4 export panel invokes these
 * via the standalone API (manual-trigger only; no auto-publish).
 *
 * Re-exports the post-mortem generator (#12), the export manifest
 * writer, and the YAML frontmatter serializer. Future exporters
 * (knowledge-debt, archetype summaries, etc.) plug in here.
 */

export {
  serializeFrontmatter,
  type FrontmatterObject,
  type FrontmatterScalar,
  type FrontmatterValue,
} from './obsidianFrontmatter.js';

export {
  EXPORT_MANIFEST_VERSION,
  buildExportManifest,
  writeExportManifest,
  type ExportManifest,
  type ExportManifestEntry,
  type WriteExportManifestResult,
} from './manifest.js';

export {
  POST_MORTEM_PERCENTILE_FLOOR,
  buildPostMortemFrontmatter,
  buildSummaryPrompt,
  checkEligibility,
  generatePostMortem,
  renderPostMortemBody,
  summarizeViaClaudeCli,
  type PostMortemDocument,
  type PostMortemEligibility,
  type PostMortemEligibilityInputs,
  type PostMortemGenerateInputs,
  type PostMortemReviewSignals,
} from './postMortemGenerator.js';
