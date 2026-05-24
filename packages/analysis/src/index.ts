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
  type ClassificationResult,
  type ClassifyOptions,
  type Embedding,
  type ProjectCentroid,
} from './classifyByEmbedding.js';
// cosineSimilarityNormalized lives in stats.ts (D2 consolidation);
// re-export below.

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
  discoverClustersDbscan,
  type DiscoverClustersDbscanOptions,
  type DiscoverClustersDbscanResult,
} from './discoverClustersDbscan.js';

export {
  reduceOutliers,
  type ReduceOutliersAssignment,
  type ReduceOutliersLabelEntry,
  type ReduceOutliersOptions,
  type ReduceOutliersResult,
} from './reduceOutliers.js';

export {
  computeCoherence,
  type CoherenceMetric,
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
  CORRECTION_LFS,
  HEURISTIC_RECALL_VERSION,
  computeLfFiringStats,
  detectCorrectionCandidates,
  runLabelingFunction,
  type LabelingFunction,
  type TurnPair,
} from './detectCorrectionCandidates.js';

export {
  PLAYBOOK_HEURISTIC_VERSION,
  PLAYBOOK_PATTERN_META,
  detectPlaybookCandidates,
  type PlaybookTurnInput,
  type PlaybookKernelHit,
} from './detectPlaybookCandidates.js';

export {
  DECISION_HEURISTIC_VERSION,
  DECISION_LFS,
  detectDecisions,
  runLabelingFunction as runDecisionLabelingFunction,
  type DecisionLabelingFunction,
  type DecisionTurnPair,
} from './detectDecisions.js';

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
  AFFIRMATION_PATTERNS,
  AUDIT_CONFIG_VERSION,
  CLAIM_PATTERNS,
  DEFAULT_VERIFIER_WINDOWS,
  PUSHBACK_PATTERNS,
  SURROUNDING_CONTEXT_CHARS,
  type ClaimPattern,
  type VerifierWindows,
} from './auditConfig.js';

export {
  binaryFromScore,
  composeOutcome,
  extractPrimitives,
  logitFromPrimitives,
  weightsHashFnv,
  type ComposeOutcomeOptions,
  type CompositePrimitives,
  type LogitContributions,
  type UpgradeOutcomeMetricsSnapshot,
} from './composeOutcome.js';

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
  type SemanticDupLinkage,
} from './duplicatesSemantic.js';

export {
  DEFAULT_P_NEAR_DUP_TARGET,
  ISOTONIC_MIN_LABELS,
  MIN_LABELS_FOR_FIT,
  MIN_PER_CLASS_FOR_FIT,
  evaluateCalibration,
  fitCalibration,
  fitIsotonic,
  fitPlatt,
  sampleByCurveUncertainty,
  type CalibrationCurve,
  type CalibrationKnot,
  type IsotonicCurve,
  type LabelPoint,
  type PlattCurve,
} from './calibration.js';

export {
  DEFAULT_NUM_PERM,
  buildMinhashDuplicates,
  buildPermutationCoefficients,
  buildSignature as buildMinhashSignature,
  estimateJaccard,
  murmurhash3_32,
  shingles,
  type BuildMinhashDuplicatesOptions,
  type DuplicatesMinhashCluster,
  type DuplicatesMinhashFile,
  type MinhashInput,
  type MinhashSignature,
} from './duplicatesMinhash.js';

export {
  discoverTopicsLocal,
  type DiscoverTopicsLocalOptions,
  type DiscoverTopicsLocalResult,
} from './discoverTopicsLocal.js';

export {
  buildUpgradeOutcomes,
  type BuildUpgradeOutcomesOptions,
} from './upgradeOutcomes.js';

export {
  verifyOneClaim,
  verifySessions,
  type TimelineEvent,
  type VerifyClaimsOptions,
  type VerifyResult,
  type VerifySessionInput,
} from './auditEvidence.js';

export {
  buildDailyBrief,
  type BriefThresholds,
  type DailyBriefInputs,
  type DailyBriefResult,
} from './dailyBrief.js';

export {
  THRESHOLDS,
  type Thresholds,
} from './thresholds.js';

export {
  computeConfidence,
  effectivePriorForKernel,
  narrativePriorPenalty,
  narrativeSaturation,
  narrativeTier,
  type EffectivePriorOptions,
  type NarrativeSaturation,
} from './narrativeRung.js';

export {
  bhFdrAdjust,
  cosineSimilarity,
  cosineSimilarityNormalized,
  euclidean,
  ewma,
  expectedCellCounts2x2,
  fisherExactPValue2x2,
  matchedPair1NN,
  mcnemarPValue,
  mean,
  normalCdf,
  sigmoid,
  twoProportionPValue,
  variance,
  wilsonCI,
  type McNemarMethod,
  type NumericVector,
} from './stats.js';

export {
  DEFAULT_BLOG_CLUSTER_THRESHOLD,
  DEFAULT_BLOG_DISCOVERY_THRESHOLD,
  DEFAULT_MIN_CLUSTER_SIZE,
  DEFAULT_NARRATIVE_ARC_DAYS,
  buildBlogCandidates,
  type BuildBlogCandidatesOptions,
} from './blogCandidates.js';

export {
  runItsAnalysis,
  type ItsConfigCommit,
  type ItsOutcomeInput,
  type ItsResult,
  type ItsSnapshot,
  type RunItsAnalysisOptions,
} from './itsAnalysis.js';

export {
  detectKnowledgeDebt,
  renderObsidianMarkdown,
  type DetectKnowledgeDebtOptions,
  type KnowledgeDebtCluster,
  type KnowledgeDebtEntry,
} from './detectKnowledgeDebt.js';

export {
  computeReflexive,
  type CovariateFn,
  type EValueStatus,
  type ReflexiveEntry,
  type ReflexivePair,
  type ReflexiveResult,
} from './computeReflexive.js';

export {
  detectArchetypes,
  type ArchetypeCentroid,
  type ArchetypesResult,
  type DetectArchetypesOptions,
  type SessionToolStats,
} from './detectArchetypes.js';

export {
  bootstrapSlope,
  politisWhiteBlockLength,
  theilSen,
  type BootstrapResult,
  type BootstrapSlopeOptions,
  type BootstrapStatus,
} from './trajectoryBootstrap.js';

export {
  analyzeSkillCurves,
  mannKendall,
  type AnalyzeSkillCurvesOptions,
  type SkillCurveClassification,
  type SkillCurvePoint,
  type SkillCurveResult,
  type SkillCurveSeries,
} from './skillCurve.js';
