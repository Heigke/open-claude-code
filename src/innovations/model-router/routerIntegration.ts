/**
 * Hybrid Local/Cloud Model Routing - Router Integration
 *
 * Top-level orchestrator that ties complexity analysis, routing policy,
 * local model bridge, and cloud API into a single execute-and-stream
 * interface. Tracks analytics and handles automatic escalation on failure.
 */

import {
  ComplexityAnalyzer,
  type ConversationContext,
  type ModelTier,
  type TaskComplexity,
  type ToolHistoryEntry,
} from './complexityAnalyzer.js'
import {
  LocalModelBridge,
  LocalModelError,
  type StreamEvent,
} from './localModelBridge.js'
import {
  RoutingPolicy,
  type RoutingConstraints,
  type RoutingDecision,
} from './routingPolicy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouterStats = {
  /** Total queries routed to local models */
  localQueries: number
  /** Total queries routed to cloud models */
  cloudQueries: number
  /** Average end-to-end latency in ms (across all queries) */
  avgLatency: number
  /** Estimated cumulative cost saved by routing to local models (USD) */
  costSaved: number
  /** Number of local failures that triggered cloud escalation */
  escalations: number
  /** Per-tier breakdown */
  tierCounts: Record<ModelTier, number>
}

export type RoutingRecord = {
  timestamp: number
  decision: RoutingDecision
  actualTier: ModelTier
  latencyMs: number
  escalated: boolean
}

/**
 * A cloud client adapter. The ModelRouter doesn't depend on the
 * Anthropic SDK directly; instead callers pass a function that
 * takes messages and yields StreamEvents. This keeps the module
 * testable without real API credentials.
 */
export type CloudClientFn = (
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: { model?: string; maxTokens?: number; systemPrompt?: string },
) => AsyncGenerator<StreamEvent>

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class ModelRouter {
  private analyzer: ComplexityAnalyzer
  private policy: RoutingPolicy
  private localBridge: LocalModelBridge | undefined
  private cloudClient: CloudClientFn | undefined
  private history: RoutingRecord[] = []
  private static readonly MAX_HISTORY = 500

  constructor(opts: {
    analyzer?: ComplexityAnalyzer
    policy: RoutingPolicy
    localBridge?: LocalModelBridge
    cloudClient?: CloudClientFn
  }) {
    this.analyzer = opts.analyzer ?? new ComplexityAnalyzer()
    this.policy = opts.policy
    this.localBridge = opts.localBridge
    this.cloudClient = opts.cloudClient
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  /**
   * Analyze complexity, pick a model, execute, and stream back results.
   * If the chosen local model fails, automatically escalates to cloud.
   */
  async *routeAndExecute(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    context?: {
      conversationContext?: ConversationContext
      recentTools?: ToolHistoryEntry[]
      constraints?: RoutingConstraints
      systemPrompt?: string
    },
  ): AsyncGenerator<StreamEvent> {
    const userMessage = this.extractLastUserMessage(messages)
    const complexity = this.analyzer.analyze(
      userMessage,
      context?.conversationContext,
      context?.recentTools,
    )

    const decision = this.policy.route(complexity, context?.constraints)
    const start = Date.now()

    // Attempt the selected tier
    const isLocal = decision.tier === 'local_small' || decision.tier === 'local_medium'

    if (isLocal && this.localBridge) {
      try {
        const available = await this.localBridge.isAvailable()
        if (available) {
          yield* this.localBridge.query(messages, {
            maxTokens: context?.constraints?.maxLatency
              ? undefined
              : undefined,
            systemPrompt: context?.systemPrompt,
          })
          this.record(decision, decision.tier, Date.now() - start, false)
          return
        }
        // Local not available, fall through to escalation
      } catch (err) {
        if (!(err instanceof LocalModelError)) throw err
        // Fall through to cloud escalation
      }
    }

    // Cloud path (either selected or escalated from local failure)
    if (this.cloudClient) {
      const escalated = isLocal
      const actualTier: ModelTier = escalated
        ? decision.fallback ?? 'cloud_fast'
        : decision.tier

      yield* this.cloudClient(messages, {
        model: escalated ? undefined : decision.model,
        systemPrompt: context?.systemPrompt,
      })
      this.record(decision, actualTier, Date.now() - start, escalated)
      return
    }

    // Neither local nor cloud configured -- yield an error event
    yield {
      type: 'message_start',
      message: {
        id: `err-${Date.now()}`,
        model: 'none',
        role: 'assistant',
      },
    }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'Error: No model backend is configured. Please configure a local model or cloud API client.',
      },
    }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
    yield { type: 'message_stop' }
  }

  // -----------------------------------------------------------------------
  // Complexity analysis (exposed for callers that want the score without executing)
  // -----------------------------------------------------------------------

  analyzeComplexity(
    userMessage: string,
    conversationContext?: ConversationContext,
    recentTools?: ToolHistoryEntry[],
  ): TaskComplexity {
    return this.analyzer.analyze(userMessage, conversationContext, recentTools)
  }

  // -----------------------------------------------------------------------
  // Analytics
  // -----------------------------------------------------------------------

  getStats(): RouterStats {
    const stats: RouterStats = {
      localQueries: 0,
      cloudQueries: 0,
      avgLatency: 0,
      costSaved: 0,
      escalations: 0,
      tierCounts: {
        local_small: 0,
        local_medium: 0,
        cloud_fast: 0,
        cloud_standard: 0,
        cloud_thinking: 0,
      },
    }

    if (this.history.length === 0) return stats

    let totalLatency = 0

    for (const record of this.history) {
      const tier = record.actualTier
      stats.tierCounts[tier]++

      if (tier === 'local_small' || tier === 'local_medium') {
        stats.localQueries++
        // Estimate savings: difference between cloud_fast cost and 0 (local is free)
        stats.costSaved += record.decision.estimatedCost * 0.5 // conservative estimate
      } else {
        stats.cloudQueries++
      }

      totalLatency += record.latencyMs
      if (record.escalated) stats.escalations++
    }

    stats.avgLatency = Math.round(totalLatency / this.history.length)
    return stats
  }

  /**
   * Full routing history (most recent first).
   */
  getHistory(): readonly RoutingRecord[] {
    return this.history
  }

  /**
   * Clear all history and stats.
   */
  resetStats(): void {
    this.history = []
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private extractLastUserMessage(
    messages: Array<{ role: string; content: string }>,
  ): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        return messages[i]!.content
      }
    }
    return ''
  }

  private record(
    decision: RoutingDecision,
    actualTier: ModelTier,
    latencyMs: number,
    escalated: boolean,
  ): void {
    this.history.push({
      timestamp: Date.now(),
      decision,
      actualTier,
      latencyMs,
      escalated,
    })
    // Trim old entries
    if (this.history.length > ModelRouter.MAX_HISTORY) {
      this.history = this.history.slice(-ModelRouter.MAX_HISTORY)
    }
  }
}
