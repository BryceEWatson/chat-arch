// Re-export everything from the SDK modules. Phase Rev3-A.A8 entry
// point; downstream phases import from `@chat-arch/exporter/db/sdk`
// rather than from individual sub-modules.

export type * from './types.js';
export { NotFoundError, UniqueViolationError, isUniqueViolation } from './errors.js';

export * from './analyzers.js';
export * from './projects.js';
export * from './topics.js';
export * from './sessions.js';
export * from './sessionMessages.js';
export * from './sessionRevisions.js';
export * from './narratives.js';
export * from './narrativeEvidence.js';
export * from './patterns.js';
export * from './findings.js';
export * from './junctions.js';
export * from './entityStates.js';

// Re-export the canonical seed fixture so cross-package gate tests
// (e.g. @chat-arch/mcp-server Phase Rev3-H H5) can share the same
// deterministic corpus the in-package tests use, instead of
// duplicating ~50 row inserts.
export {
  SEED_IDS,
  SEED_SESSION_KEYS,
  seedRev3Fixture,
} from './seedFixture.js';
