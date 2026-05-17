/**
 * Browser-safe analysis kernel — shared by the Node CLI exporter and the
 * browser viewer.
 *
 * Everything here is pure, side-effect-free, and must NOT introduce any
 * Node-only imports. The architectural guarantee of this package is that
 * both runtimes consume the same implementations, so duplicates/zombies/
 * cost computed in-page against an uploaded ZIP match what the exporter
 * writes to `analysis/*.json` on disk. Adding `node:fs`, `node:crypto`,
 * or similar here would break that contract and force a re-forking of
 * the pipelines.
 */

export {
  allHumanText,
  buildCloudEntries,
  buildEntry,
  compileProjectPatterns,
  firstHumanText,
  type CloudMappingResult,
  type CloudSourceData,
} from './cloud-mapping.js';

export {
  DEFAULT_MIN_NORMALIZED_LEN,
  buildDuplicateClusters,
  buildDuplicatesFile,
  normalizeForHash,
  sha256Hex,
  type BuildClustersOptions,
  type DuplicateCluster,
  type DuplicateInput,
  type DuplicatesFile,
} from './duplicatesExact.js';

export {
  PROBE_REGEX,
  SILENT_ZOMBIE_DAYS,
  buildZombieProjects,
  buildZombiesFile,
  classifyProject,
  type BurstWindow,
  type Classification,
  type ZombieProjectEntry,
  type ZombiesFile,
} from './zombiesHeuristic.js';

export {
  PROJECTS_FILE,
  extractBasename,
  inferProject,
  type InferenceSource,
  type InferredProject,
  type ProjectDef,
  type ProjectsFile,
} from './inferProject.js';

export {
  DEFAULT_MODEL_ID,
  RATE_TABLE,
  collectUnknownModels,
  estimateCost,
  pickModelForRate,
  type CostBreakdown,
  type EstimateResult,
  type ModelRate,
  type RateTable,
} from './cost/estimate.js';

export {
  classifyBatch,
  classifyChunksOfOne,
  classifyOne,
  cosineSimilarityNormalized,
  type ClassificationResult,
  type ClassifyOptions,
  type Embedding,
  type ProjectCentroid,
} from './classifyByEmbedding.js';

export {
  discoverClusters,
  discoverClustersAsync,
  pickDistinctiveTerms,
  type ClusterInput,
  type DiscoverOptions,
  type DiscoverOptionsAsync,
  type DiscoveredCluster,
} from './discoverClusters.js';

export {
  reduceOutliers,
  type ReduceOutliersAssignment,
  type ReduceOutliersLabelEntry,
  type ReduceOutliersOptions,
  type ReduceOutliersResult,
} from './reduceOutliers.js';

export {
  computeCoherence,
  type CoherenceOptions,
  type CoherenceScores,
} from './coherence.js';

export {
  mulberry32,
  umapProject,
  type UmapProjectOptions,
} from './umapProject.js';

export {
  scoreSentiment,
  type SentimentScore,
} from './sentimentHeuristic.js';

export {
  discoverProjects,
  type DiscoverProjectsOptions,
  type DiscoverProjectsResult,
} from './discoverProjects.js';

export {
  discoverTopics,
  type DiscoverTopicsOptions,
  type DiscoverTopicsResult,
} from './discoverTopics.js';

export {
  discoverNarratives,
  type DiscoverNarrativesOptions,
  type DiscoverNarrativesResult,
} from './discoverNarratives.js';

export {
  kmeansCluster,
  type KmeansClusterInput,
  type KmeansClusterOptions,
} from './kmeansCluster.js';

export {
  HEURISTIC_RECALL_VERSION,
  detectCorrectionCandidates,
  type TurnPair,
} from './detectCorrectionCandidates.js';

export { clusterByThreshold } from './clusterRules.js';

export {
  buildContinuumHealth,
  type BuildContinuumHealthOptions,
} from './continuumHealth.js';

export {
  DEFAULT_DISCOVERY_WEIGHTS,
  DEFAULT_TOKEN_INTENSITY_CAP,
  DEFAULT_TOOL_DIVERSITY_CAP,
  computeDiscoveryScore,
  scoreManifest,
  type AppliedImprovementLite,
  type DiscoveryScoreContext,
  type DiscoveryScoreOptions,
  type DiscoveryScoreResult,
  type DiscoveryScoreWeights,
} from './discoveryScore.js';

export {
  AUDIT_CONFIG_VERSION,
  CLAIM_PATTERNS,
  DEFAULT_VERIFIER_WINDOWS,
  PUSHBACK_PATTERNS,
  SURROUNDING_CONTEXT_CHARS,
  type ClaimPattern,
  type VerifierWindows,
} from './auditConfig.js';

export {
  extractClaims,
  type AssistantMessage,
  type ExtractClaimsResult,
} from './auditClaims.js';

export {
  DEFAULT_SEMANTIC_DUP_THRESHOLD,
  buildSemanticDuplicates,
  type BuildSemanticDuplicatesOptions,
  type SemanticDupInput,
} from './duplicatesSemantic.js';

export {
  discoverTopicsLocal,
  type DiscoverTopicsLocalOptions,
  type DiscoverTopicsLocalResult,
} from './discoverTopicsLocal.js';

export {
  buildUpgradeOutcomes,
  type BuildUpgradeOutcomesOptions,
} from './upgradeOutcomes.js';
