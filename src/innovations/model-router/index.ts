/**
 * Hybrid Local/Cloud Model Routing
 *
 * Intelligent routing between local inference servers and cloud APIs
 * based on task complexity analysis. Routes trivial/simple tasks to
 * fast local models and complex/expert tasks to cloud models with
 * automatic fallback on failure.
 */

// Core analysis
export { ComplexityAnalyzer } from './complexityAnalyzer.js'
export type {
  ComplexityLevel,
  ComplexityThresholds,
  ConversationContext,
  ModelTier,
  TaskComplexity,
  ToolHistoryEntry,
} from './complexityAnalyzer.js'

// Routing policy
export { RoutingPolicy } from './routingPolicy.js'
export type {
  ModelConfig,
  RoutingConstraints,
  RoutingDecision,
} from './routingPolicy.js'

// Local model bridge
export { LocalModelBridge, LocalModelError } from './localModelBridge.js'
export type {
  LocalApiFormat,
  LocalModelConfig,
  StreamEvent,
} from './localModelBridge.js'

// Integration / orchestrator
export { ModelRouter } from './routerIntegration.js'
export type {
  CloudClientFn,
  RouterStats,
  RoutingRecord,
} from './routerIntegration.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { ComplexityAnalyzer, type ComplexityThresholds } from './complexityAnalyzer.js'
import { LocalModelBridge, type LocalModelConfig } from './localModelBridge.js'
import { RoutingPolicy, type ModelConfig } from './routingPolicy.js'
import { ModelRouter, type CloudClientFn } from './routerIntegration.js'

export type CreateModelRouterOptions = {
  /** Models available for routing */
  models: ModelConfig[]
  /** Optional local model server configuration */
  local?: LocalModelConfig
  /** Optional cloud streaming client */
  cloudClient?: CloudClientFn
  /** Override default complexity thresholds */
  thresholds?: Partial<ComplexityThresholds>
}

/**
 * One-call factory that wires up all components.
 *
 * @example
 * ```ts
 * const router = createModelRouter({
 *   models: [
 *     {
 *       tier: 'local_small',
 *       model: 'llama3:8b',
 *       endpoint: 'http://localhost:11434',
 *       maxTokens: 4096,
 *       latencyMs: 100,
 *       costPer1kTokens: 0,
 *       capabilities: ['code', 'chat'],
 *     },
 *     {
 *       tier: 'cloud_standard',
 *       model: 'claude-sonnet-4-20250514',
 *       endpoint: 'https://api.anthropic.com',
 *       maxTokens: 8192,
 *       latencyMs: 800,
 *       costPer1kTokens: 0.009,
 *       capabilities: ['code', 'analysis', 'tool_use'],
 *     },
 *   ],
 *   local: {
 *     endpoint: 'http://localhost:11434',
 *     model: 'llama3:8b',
 *     apiFormat: 'ollama',
 *   },
 * })
 *
 * for await (const event of router.routeAndExecute(messages)) {
 *   // handle streaming events
 * }
 * ```
 */
export function createModelRouter(opts: CreateModelRouterOptions): ModelRouter {
  const analyzer = new ComplexityAnalyzer(opts.thresholds)
  const policy = new RoutingPolicy(opts.models)
  const localBridge = opts.local ? new LocalModelBridge(opts.local) : undefined

  return new ModelRouter({
    analyzer,
    policy,
    localBridge,
    cloudClient: opts.cloudClient,
  })
}
