/**
 * Hybrid Local/Cloud Model Routing - Routing Policy
 *
 * Maps complexity assessments to concrete model selections, applying
 * constraints (latency, cost, required capabilities) and providing
 * fallback chains when the preferred tier is unavailable.
 */

import type { ComplexityLevel, ModelTier, TaskComplexity } from './complexityAnalyzer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelConfig = {
  /** Which tier this model belongs to */
  tier: ModelTier
  /** Model identifier (e.g. "llama3:8b", "claude-sonnet-4-20250514") */
  model: string
  /** API endpoint URL */
  endpoint: string
  /** Maximum output tokens */
  maxTokens: number
  /** Typical latency for first token (ms) */
  latencyMs: number
  /** Estimated cost per 1k input+output tokens (USD) */
  costPer1kTokens: number
  /** Capabilities this model supports */
  capabilities: string[]
}

export type RoutingConstraints = {
  /** Maximum acceptable latency in ms */
  maxLatency?: number
  /** Maximum acceptable cost per 1k tokens */
  maxCost?: number
  /** Capabilities the model must support */
  requireCapabilities?: string[]
}

export type RoutingDecision = {
  /** Selected tier */
  tier: ModelTier
  /** Concrete model identifier */
  model: string
  /** Human-readable explanation */
  reason: string
  /** Next tier to try if this one fails */
  fallback?: ModelTier
  /** Estimated latency in ms */
  estimatedLatency: number
  /** Estimated cost per 1k tokens (USD) */
  estimatedCost: number
}

// ---------------------------------------------------------------------------
// Tier Escalation Order
// ---------------------------------------------------------------------------

/** Ordered from cheapest/fastest to most capable */
const TIER_ORDER: readonly ModelTier[] = [
  'local_small',
  'local_medium',
  'cloud_fast',
  'cloud_standard',
  'cloud_thinking',
] as const

/** Default complexity-to-tier mapping */
const DEFAULT_TIER_MAP: Record<ComplexityLevel, ModelTier> = {
  trivial: 'local_small',
  simple: 'local_small',
  moderate: 'cloud_fast',
  complex: 'cloud_standard',
  expert: 'cloud_thinking',
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export class RoutingPolicy {
  private models: Map<ModelTier, ModelConfig[]>
  private tierMap: Record<ComplexityLevel, ModelTier>

  constructor(
    availableModels: ModelConfig[],
    tierMap?: Partial<Record<ComplexityLevel, ModelTier>>,
  ) {
    this.models = new Map()
    for (const model of availableModels) {
      const existing = this.models.get(model.tier) ?? []
      existing.push(model)
      this.models.set(model.tier, existing)
    }
    this.tierMap = { ...DEFAULT_TIER_MAP, ...tierMap }
  }

  /**
   * Select a model for the given complexity, respecting optional constraints.
   */
  route(
    complexity: TaskComplexity,
    constraints?: RoutingConstraints,
  ): RoutingDecision {
    const preferredTier = this.tierMap[complexity.level]
    const fallbackChain = this.buildFallbackChain(preferredTier)

    for (const tier of [preferredTier, ...fallbackChain]) {
      const candidates = this.models.get(tier)
      if (!candidates || candidates.length === 0) continue

      const viable = this.filterByConstraints(candidates, constraints)
      if (viable.length === 0) continue

      // Pick the best candidate within the tier (lowest cost, then lowest latency)
      const best = this.pickBest(viable)
      const nextFallback = this.getNextFallback(tier, fallbackChain)

      return {
        tier,
        model: best.model,
        reason: this.buildReason(complexity, tier, preferredTier, constraints),
        fallback: nextFallback,
        estimatedLatency: best.latencyMs,
        estimatedCost: best.costPer1kTokens,
      }
    }

    // No model matched at all -- return the highest tier we have as last resort
    const lastResort = this.getLastResort()
    return {
      tier: lastResort.tier,
      model: lastResort.model,
      reason: `No model matched constraints; falling back to ${lastResort.model}`,
      fallback: undefined,
      estimatedLatency: lastResort.latencyMs,
      estimatedCost: lastResort.costPer1kTokens,
    }
  }

  /**
   * Get all available tiers.
   */
  getAvailableTiers(): ModelTier[] {
    return [...this.models.keys()]
  }

  /**
   * Check whether a specific tier has any models configured.
   */
  hasTier(tier: ModelTier): boolean {
    const models = this.models.get(tier)
    return models !== undefined && models.length > 0
  }

  /**
   * Get all models for a given tier.
   */
  getModelsForTier(tier: ModelTier): ModelConfig[] {
    return this.models.get(tier) ?? []
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Build the ordered fallback chain starting from the tier above the
   * preferred one (escalation) and then below (de-escalation if nothing
   * above works).
   */
  private buildFallbackChain(preferred: ModelTier): ModelTier[] {
    const idx = TIER_ORDER.indexOf(preferred)
    const chain: ModelTier[] = []

    // Escalate first (prefer more capable)
    for (let i = idx + 1; i < TIER_ORDER.length; i++) {
      chain.push(TIER_ORDER[i]!)
    }
    // Then de-escalate
    for (let i = idx - 1; i >= 0; i--) {
      chain.push(TIER_ORDER[i]!)
    }

    return chain
  }

  private filterByConstraints(
    candidates: ModelConfig[],
    constraints?: RoutingConstraints,
  ): ModelConfig[] {
    if (!constraints) return candidates

    return candidates.filter((m) => {
      if (
        constraints.maxLatency !== undefined &&
        m.latencyMs > constraints.maxLatency
      ) {
        return false
      }
      if (
        constraints.maxCost !== undefined &&
        m.costPer1kTokens > constraints.maxCost
      ) {
        return false
      }
      if (constraints.requireCapabilities) {
        const has = new Set(m.capabilities)
        if (!constraints.requireCapabilities.every((c) => has.has(c))) {
          return false
        }
      }
      return true
    })
  }

  private pickBest(candidates: ModelConfig[]): ModelConfig {
    // Sort by cost ascending, then latency ascending
    const sorted = [...candidates].sort((a, b) => {
      const costDiff = a.costPer1kTokens - b.costPer1kTokens
      if (costDiff !== 0) return costDiff
      return a.latencyMs - b.latencyMs
    })
    return sorted[0]!
  }

  private getNextFallback(
    currentTier: ModelTier,
    fallbackChain: ModelTier[],
  ): ModelTier | undefined {
    const idx = fallbackChain.indexOf(currentTier)
    if (idx === -1) {
      // current is the preferred tier; next fallback is first in chain
      return fallbackChain[0]
    }
    return fallbackChain[idx + 1]
  }

  private getLastResort(): ModelConfig {
    // Walk tiers from most capable down
    for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
      const models = this.models.get(TIER_ORDER[i]!)
      if (models && models.length > 0) return models[0]!
    }
    // Should never happen if at least one model is configured, but
    // provide a safe default so callers don't crash.
    return {
      tier: 'cloud_standard',
      model: 'claude-sonnet-4-20250514',
      endpoint: 'https://api.anthropic.com',
      maxTokens: 8192,
      latencyMs: 1000,
      costPer1kTokens: 0.009,
      capabilities: ['code', 'analysis'],
    }
  }

  private buildReason(
    complexity: TaskComplexity,
    selectedTier: ModelTier,
    preferredTier: ModelTier,
    constraints?: RoutingConstraints,
  ): string {
    const parts: string[] = [
      `Complexity: ${complexity.level} (score ${complexity.score})`,
    ]

    if (selectedTier !== preferredTier) {
      parts.push(
        `preferred ${preferredTier} unavailable, escalated to ${selectedTier}`,
      )
    }

    if (constraints) {
      if (constraints.maxLatency !== undefined) {
        parts.push(`latency cap ${constraints.maxLatency}ms`)
      }
      if (constraints.maxCost !== undefined) {
        parts.push(`cost cap $${constraints.maxCost}/1k tokens`)
      }
    }

    return parts.join('; ')
  }
}
