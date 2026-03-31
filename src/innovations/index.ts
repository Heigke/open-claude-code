/**
 * Innovation Modules - Master Export
 *
 * Re-exports all innovation subsystems from a single entry point.
 * Import from here rather than individual module paths.
 */

// ---------------------------------------------------------------------------
// 1. Progressive Trust Escalation
// ---------------------------------------------------------------------------
export {
  TrustStore,
  computeScore,
  TrustPolicy,
  TRUST_TIERS,
  wrapPermissionCheck,
  recordToolOutcome,
  createTrustEscalation,
} from './trust-escalation/index.js'

export type {
  TrustScore,
  TrustDecision,
  TrustTier,
  PermissionCheckFn,
  EnhancedPermissionResult,
  EnhancedPermissionCheckFn,
  TrustEscalation,
} from './trust-escalation/index.js'

// ---------------------------------------------------------------------------
// 2. Predictive Context Management
// ---------------------------------------------------------------------------
export {
  PriorityCalculator,
  buildConversationContext,
  ContextPredictor,
  SelectiveCompactor,
  createPredictiveContextManager,
} from './predictive-context/index.js'

export type {
  MessagePriority,
  ConversationContext as PredictiveConversationContext,
  CompactionUrgency,
  PreemptiveCompactDecision,
  TokenSnapshot,
  CompactionEvent,
  CompactionSelection,
  PredictiveContextManager,
} from './predictive-context/index.js'

// ---------------------------------------------------------------------------
// 3. Agent Mesh with Shared Knowledge Graph
// ---------------------------------------------------------------------------
export {
  KnowledgeGraph,
  ConflictResolver,
  AgentBus,
  MeshCoordinator,
  createAgentMesh,
} from './agent-mesh/index.js'

export type {
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeEdge,
  KnowledgeEdgeRelation,
  MergeResult,
  FileConflict,
  ConflictType,
  AgentChange,
  Resolution,
  MergeSuggestion,
  AgentMessage,
  AgentMessageType,
  MessageHandler,
  WorkItem,
  AgentStatus,
  MeshStatus,
  WorkResults,
  AgentMesh,
} from './agent-mesh/index.js'

// ---------------------------------------------------------------------------
// 4. Hybrid Local/Cloud Model Routing
// ---------------------------------------------------------------------------
export {
  ComplexityAnalyzer,
  RoutingPolicy,
  LocalModelBridge,
  LocalModelError,
  ModelRouter,
  createModelRouter,
} from './model-router/index.js'

export type {
  ComplexityLevel,
  ComplexityThresholds,
  ConversationContext as RouterConversationContext,
  ModelTier,
  TaskComplexity,
  ToolHistoryEntry,
  ModelConfig,
  RoutingConstraints,
  RoutingDecision,
  LocalApiFormat,
  LocalModelConfig,
  StreamEvent,
  CloudClientFn,
  RouterStats,
  RoutingRecord,
  CreateModelRouterOptions,
} from './model-router/index.js'

// ---------------------------------------------------------------------------
// 5. Tool Failure Feedback Loop
// ---------------------------------------------------------------------------
export {
  ExecutionTracker,
  FailureAnalyzer,
  AdaptivePromptInjector,
  ToolFeedbackSystem,
  createToolFeedbackSystem,
} from './tool-feedback/index.js'

export type {
  ToolExecution,
  ExecutionPattern,
  FailureInsight,
  FailureCategory,
  Confidence,
  AnalyzerFn,
  PromptInjection,
  InjectionPosition,
  ToolFeedbackStats,
} from './tool-feedback/index.js'

// ---------------------------------------------------------------------------
// 6. Structured Episodic Memory
// ---------------------------------------------------------------------------
export {
  EmbeddingStore,
  buildVocabulary,
  textToTfIdf,
  normalise,
  cosineSimilarity,
} from './episodic-memory/embeddingStore.js'

export type {
  EmbeddingVector,
  MemoryType,
  MemoryMetadata,
  MemoryEntry,
  ScoredEntry,
  SearchFilters,
} from './episodic-memory/embeddingStore.js'

// ---------------------------------------------------------------------------
// 7. Real-time Collaboration
// ---------------------------------------------------------------------------
export { SessionBroker } from './realtime-collab/sessionBroker.js'

export type {
  CursorPosition,
  Participant,
  Reaction,
  SharedMessage,
  SessionSettings,
} from './realtime-collab/sessionBroker.js'

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
export { InnovationOrchestrator } from './orchestrator.js'
export type { OrchestratorConfig, OrchestratorStatus } from './orchestrator.js'
