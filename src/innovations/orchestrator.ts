/**
 * Innovation Orchestrator
 *
 * Wires all innovation subsystems together into a single integration
 * layer. Provides lifecycle hooks (onToolExecutionStart, onToolExecutionComplete,
 * onNewMessage) that the main tool-execution pipeline can call.
 */

import { TrustStore } from './trust-escalation/trustStore.js'
import { TrustPolicy } from './trust-escalation/trustPolicy.js'
import { createTrustEscalation, type TrustEscalation } from './trust-escalation/trustIntegration.js'
import type { TrustDecision } from './trust-escalation/trustPolicy.js'

import { ContextPredictor, type PreemptiveCompactDecision } from './predictive-context/contextPredictor.js'

import { KnowledgeGraph } from './agent-mesh/knowledgeGraph.js'
import { AgentBus } from './agent-mesh/agentBus.js'
import { ConflictResolver } from './agent-mesh/conflictResolver.js'
import { MeshCoordinator } from './agent-mesh/meshCoordinator.js'

import {
  ComplexityAnalyzer,
  type TaskComplexity,
} from './model-router/complexityAnalyzer.js'
import { RoutingPolicy, type RoutingDecision, type ModelConfig } from './model-router/routingPolicy.js'

import { ToolFeedbackSystem, type ToolFeedbackStats } from './tool-feedback/feedbackIntegration.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type OrchestratorConfig = {
  /** Workspace root path (used for trust scoping) */
  workspacePath: string
  /** Path to persist trust scores (defaults to ~/.claude/trust-scores.json) */
  trustStorePath?: string
  /** Enable local model routing */
  enableLocalModels?: boolean
  /** Local model server endpoint (e.g. http://localhost:11434) */
  localModelEndpoint?: string
  /** Context window size in tokens (defaults to 200_000) */
  contextWindowSize?: number
  /** Available models for routing (optional, uses defaults if omitted) */
  modelConfigs?: ModelConfig[]
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type OrchestratorStatus = {
  trust: {
    totalEntries: number
    recentDecisions: TrustDecision[]
  }
  feedback: ToolFeedbackStats
  context: {
    turnCount: number
    averageGrowthRate: number
    lastCompactionDecision: PreemptiveCompactDecision | null
  }
  mesh: {
    graphNodes: number
    graphEdges: number
    activeAgents: string[]
  }
  routing: {
    availableTiers: string[]
    lastComplexity: TaskComplexity | null
    lastRoutingDecision: RoutingDecision | null
  }
}

// ---------------------------------------------------------------------------
// Pre-tool execution result
// ---------------------------------------------------------------------------

export type PreToolResult = {
  preHints: string[]
  routingDecision?: RoutingDecision
  trustDecision?: TrustDecision
}

// ---------------------------------------------------------------------------
// Default model configs
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: ModelConfig[] = [
  {
    tier: 'local_small',
    model: 'llama3:8b',
    endpoint: 'http://localhost:11434',
    maxTokens: 4096,
    latencyMs: 100,
    costPer1kTokens: 0,
    capabilities: ['code', 'chat'],
  },
  {
    tier: 'cloud_fast',
    model: 'claude-3-5-haiku-20241022',
    endpoint: 'https://api.anthropic.com',
    maxTokens: 8192,
    latencyMs: 400,
    costPer1kTokens: 0.001,
    capabilities: ['code', 'analysis', 'tool_use'],
  },
  {
    tier: 'cloud_standard',
    model: 'claude-sonnet-4-20250514',
    endpoint: 'https://api.anthropic.com',
    maxTokens: 8192,
    latencyMs: 800,
    costPer1kTokens: 0.009,
    capabilities: ['code', 'analysis', 'tool_use'],
  },
  {
    tier: 'cloud_thinking',
    model: 'claude-opus-4-20250514',
    endpoint: 'https://api.anthropic.com',
    maxTokens: 16384,
    latencyMs: 2000,
    costPer1kTokens: 0.045,
    capabilities: ['code', 'analysis', 'tool_use', 'reasoning'],
  },
]

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class InnovationOrchestrator {
  private config: OrchestratorConfig

  // Subsystems
  private trustStore!: TrustStore
  private trustEscalation!: TrustEscalation
  private feedbackSystem!: ToolFeedbackSystem
  private contextPredictor!: ContextPredictor
  private knowledgeGraph!: KnowledgeGraph
  private agentBus!: AgentBus
  private conflictResolver!: ConflictResolver
  private meshCoordinator!: MeshCoordinator
  private complexityAnalyzer!: ComplexityAnalyzer
  private routingPolicy!: RoutingPolicy

  // Tracking state
  private recentTrustDecisions: TrustDecision[] = []
  private lastCompactionDecision: PreemptiveCompactDecision | null = null
  private lastComplexity: TaskComplexity | null = null
  private lastRoutingDecision: RoutingDecision | null = null
  private contextWindowSize: number
  private currentTokenCount = 0
  private initialized = false

  constructor(config: OrchestratorConfig) {
    this.config = config
    this.contextWindowSize = config.contextWindowSize ?? 200_000
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize all subsystems. Must be called before using any hooks.
   */
  initialize(): void {
    if (this.initialized) return

    // Trust escalation
    this.trustStore = new TrustStore(this.config.trustStorePath)
    const trustPolicy = new TrustPolicy(this.trustStore)
    this.trustEscalation = createTrustEscalation(this.trustStore, trustPolicy)

    // Tool feedback
    this.feedbackSystem = new ToolFeedbackSystem()

    // Context prediction
    this.contextPredictor = new ContextPredictor({
      slidingWindowSize: 10,
      preemptiveThresholdFraction: 0.70,
      lookaheadTurns: 3,
    })

    // Agent mesh
    this.knowledgeGraph = new KnowledgeGraph()
    this.agentBus = new AgentBus()
    this.conflictResolver = new ConflictResolver()
    this.meshCoordinator = new MeshCoordinator(
      this.knowledgeGraph,
      this.agentBus,
      this.conflictResolver,
    )

    // Model routing
    this.complexityAnalyzer = new ComplexityAnalyzer()
    const models = this.config.modelConfigs ?? DEFAULT_MODELS
    this.routingPolicy = new RoutingPolicy(models)

    this.initialized = true
  }

  // -----------------------------------------------------------------------
  // Event Hooks
  // -----------------------------------------------------------------------

  /**
   * Called before a tool starts executing.
   * Returns pre-execution hints, the trust decision, and an optional routing decision.
   */
  onToolExecutionStart(toolName: string, input: string): PreToolResult {
    this.ensureInitialized()

    const hints: string[] = []

    // 1. Trust policy decision
    const trustDecision = this.trustEscalation.query(
      toolName,
      input,
      this.config.workspacePath,
    )
    this.recentTrustDecisions.push(trustDecision)
    if (this.recentTrustDecisions.length > 20) {
      this.recentTrustDecisions.shift()
    }

    if (trustDecision.reason) {
      hints.push(`[Trust] ${trustDecision.reason}`)
    }

    // 2. Pre-tool feedback hint
    const feedbackHint = this.feedbackSystem.getPreToolHint(toolName, input)
    if (feedbackHint) {
      hints.push(feedbackHint)
    }

    // 3. Routing decision (complexity analysis)
    const complexity = this.complexityAnalyzer.analyze(input)
    this.lastComplexity = complexity
    const routingDecision = this.routingPolicy.route(complexity)
    this.lastRoutingDecision = routingDecision

    return {
      preHints: hints,
      routingDecision,
      trustDecision,
    }
  }

  /**
   * Called after a tool finishes executing.
   * Records outcomes in trust, feedback, and context systems.
   */
  onToolExecutionComplete(
    toolName: string,
    input: string,
    output: string,
    success: boolean,
    error?: { type?: string; message?: string },
  ): void {
    this.ensureInitialized()

    // 1. Record trust outcome
    this.trustEscalation.recordOutcome(
      toolName,
      input,
      this.config.workspacePath,
      success,
    )

    // 2. Record tool feedback
    this.feedbackSystem.onToolComplete(
      toolName,
      input,
      output,
      success,
      error,
    )
  }

  /**
   * Called when a new message is added to the conversation.
   * Updates the context predictor and checks for preemptive compaction.
   */
  onNewMessage(
    _message: string,
    tokenCount: number,
  ): PreemptiveCompactDecision {
    this.ensureInitialized()

    this.currentTokenCount = tokenCount
    this.contextPredictor.recordTurn(tokenCount)

    const decision = this.contextPredictor.shouldPreemptivelyCompact(
      tokenCount,
      this.contextWindowSize,
    )
    this.lastCompactionDecision = decision
    return decision
  }

  // -----------------------------------------------------------------------
  // Prompt Augmentation
  // -----------------------------------------------------------------------

  /**
   * Collects system prompt additions from all subsystems.
   * Returns an array of strings to append to the system prompt.
   */
  getSystemPromptAdditions(): string[] {
    this.ensureInitialized()

    const additions: string[] = []

    // Trust hints for recent patterns
    for (const decision of this.recentTrustDecisions.slice(-3)) {
      if (decision.behavior === 'allow' && decision.score >= 80) {
        additions.push(
          `[Trust] Pattern is highly trusted (score ${decision.score}).`,
        )
      }
    }

    // Feedback system prompt addendum
    const feedbackAddendum = this.feedbackSystem.getSystemPromptAddendum()
    if (feedbackAddendum) {
      additions.push(feedbackAddendum)
    }

    // Context warnings
    if (this.lastCompactionDecision?.shouldCompact) {
      additions.push(
        `[Context] Warning: ${this.lastCompactionDecision.reason}`,
      )
    }

    return additions
  }

  // -----------------------------------------------------------------------
  // Agent Mesh Access
  // -----------------------------------------------------------------------

  /** Get the shared knowledge graph for direct use */
  getKnowledgeGraph(): KnowledgeGraph {
    this.ensureInitialized()
    return this.knowledgeGraph
  }

  /** Get the agent bus for subscribing agents */
  getAgentBus(): AgentBus {
    this.ensureInitialized()
    return this.agentBus
  }

  /** Get the mesh coordinator */
  getMeshCoordinator(): MeshCoordinator {
    this.ensureInitialized()
    return this.meshCoordinator
  }

  // -----------------------------------------------------------------------
  // Trust Access
  // -----------------------------------------------------------------------

  /** Query trust decision without recording anything */
  queryTrust(toolName: string, pattern: string): TrustDecision {
    this.ensureInitialized()
    return this.trustEscalation.query(
      toolName,
      pattern,
      this.config.workspacePath,
    )
  }

  // -----------------------------------------------------------------------
  // Status & Diagnostics
  // -----------------------------------------------------------------------

  /**
   * Get a full status snapshot across all subsystems.
   */
  getStatus(): OrchestratorStatus {
    this.ensureInitialized()

    return {
      trust: {
        totalEntries: this.trustStore.allEntries().length,
        recentDecisions: [...this.recentTrustDecisions].slice(-5),
      },
      feedback: this.feedbackSystem.getStats(),
      context: {
        turnCount: this.contextPredictor.turnCount,
        averageGrowthRate: this.contextPredictor.getAverageGrowthRate(),
        lastCompactionDecision: this.lastCompactionDecision,
      },
      mesh: {
        graphNodes: this.knowledgeGraph.nodeCount,
        graphEdges: this.knowledgeGraph.edgeCount,
        activeAgents: this.agentBus.getActiveAgents(),
      },
      routing: {
        availableTiers: this.routingPolicy.getAvailableTiers(),
        lastComplexity: this.lastComplexity,
        lastRoutingDecision: this.lastRoutingDecision,
      },
    }
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /**
   * Clean up all subsystems. Safe to call multiple times.
   */
  shutdown(): void {
    if (!this.initialized) return

    this.trustStore.save()
    this.agentBus.destroy()
    this.feedbackSystem.reset()

    this.initialized = false
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        'InnovationOrchestrator not initialized. Call initialize() first.',
      )
    }
  }
}
