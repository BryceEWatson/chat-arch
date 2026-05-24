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

// Note: `seedRev3Fixture` + `SEED_IDS` + `SEED_SESSION_KEYS` are
// deliberately NOT re-exported here. They live behind the
// `@chat-arch/exporter/db/fixtures` subpath instead — test
// fixtures don't belong on the production SDK surface (IntelliSense
// pollution + bundler ships fixture data into prod). Per design-
// coherence + adversarial review on PR #94.
