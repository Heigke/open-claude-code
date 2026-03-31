/**
 * Routing Analytics
 *
 * Records routing decisions and actual outcomes, then computes
 * accuracy metrics, cost savings, per-model performance, and
 * policy adjustment suggestions.
 */

import type { ModelTier, ComplexityLevel } from './complexityAnalyzer.js'
import type { RoutingDecision } from './routingPolicy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoutingOutcome = {
  decision: RoutingDecision
  actualLatency: number
  actualCost: number
  success: boolean
  timestamp: number
}

export type RoutingAccuracy = {
  /** Fraction of routings that were correct (0-1) */
  correctRouting: number
  /** Count of queries sent to cloud when local would have worked */
  overRouted: number
  /** Count of queries sent locally that failed and had to escalate */
  underRouted: number
}

export type CostSavings = {
  /** Estimated total USD saved by local routing */
  totalSaved: number
  /** Percentage of total cost that was saved */
  percentSaved: number
  /** Number of queries successfully handled locally */
  queriesRoutedLocally: number
}

export type ModelPerformance = {
  avgLatency: number
  successRate: number
  avgTokens: number
  totalQueries: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Estimated cost per query for cloud models (used when actual cost is 0) */
const DEFAULT_CLOUD_COST_PER_QUERY = 0.005

// ---------------------------------------------------------------------------
// RoutingAnalytics
// ---------------------------------------------------------------------------

export class RoutingAnalytics {
  private outcomes: RoutingOutcome[] = []
  private static readonly MAX_OUTCOMES = 1000

  // ---- Recording ----------------------------------------------------------

  /**
   * Record the outcome of a routing decision.
   */
  recordRouting(
    decision: RoutingDecision,
    actualLatency: number,
    actualCost: number,
    success: boolean,
  ): void {
    this.outcomes.push({
      decision,
      actualLatency,
      actualCost,
      success,
      timestamp: Date.now(),
    })

    // Trim old entries
    if (this.outcomes.length > RoutingAnalytics.MAX_OUTCOMES) {
      this.outcomes = this.outcomes.slice(
        this.outcomes.length - RoutingAnalytics.MAX_OUTCOMES,
      )
    }
  }

  // ---- Accuracy -----------------------------------------------------------

  /**
   * Compute routing accuracy metrics.
   *
   * - correctRouting: fraction of decisions where the tier was appropriate
   * - overRouted: sent to cloud when a local tier was suggested and it succeeded
   *   (meaning local probably would have worked)
   * - underRouted: sent to local tier but failed (had to escalate)
   */
  getAccuracy(): RoutingAccuracy {
    if (this.outcomes.length === 0) {
      return { correctRouting: 1, overRouted: 0, underRouted: 0 }
    }

    let correct = 0
    let overRouted = 0
    let underRouted = 0

    for (const o of this.outcomes) {
      const isLocal =
        o.decision.tier === 'local_small' || o.decision.tier === 'local_medium'
      const isCloud = !isLocal

      if (isLocal && !o.success) {
        // Sent to local but it failed -> under-routed
        underRouted++
      } else if (
        isCloud &&
        o.success &&
        o.actualLatency < 500 &&
        (o.decision.tier === 'cloud_fast' || o.decision.tier === 'cloud_standard')
      ) {
        // Sent to cloud, succeeded quickly -> might have worked locally
        // Heuristic: if latency was very low and it was a simple success,
        // it was likely over-routed
        overRouted++
      } else {
        correct++
      }
    }

    const total = this.outcomes.length
    return {
      correctRouting: Math.round((correct / total) * 1000) / 1000,
      overRouted,
      underRouted,
    }
  }

  // ---- Cost savings -------------------------------------------------------

  /**
   * Estimate cost savings from routing queries locally instead of to cloud.
   */
  getCostSavings(): CostSavings {
    if (this.outcomes.length === 0) {
      return { totalSaved: 0, percentSaved: 0, queriesRoutedLocally: 0 }
    }

    let localQueries = 0
    let totalActualCost = 0
    let totalHypotheticalCost = 0

    for (const o of this.outcomes) {
      const isLocal =
        o.decision.tier === 'local_small' || o.decision.tier === 'local_medium'

      totalActualCost += o.actualCost

      if (isLocal && o.success) {
        localQueries++
        // This query would have cost cloud_fast rates if not routed locally
        const cloudCost =
          o.decision.estimatedCost > 0
            ? o.decision.estimatedCost
            : DEFAULT_CLOUD_COST_PER_QUERY
        totalHypotheticalCost += cloudCost
      } else {
        totalHypotheticalCost += o.actualCost
      }
    }

    const totalSaved = Math.round((totalHypotheticalCost - totalActualCost) * 10000) / 10000
    const totalPossibleCost = totalHypotheticalCost || 1
    const percentSaved =
      Math.round((totalSaved / totalPossibleCost) * 1000) / 10

    return {
      totalSaved: Math.max(0, totalSaved),
      percentSaved: Math.max(0, percentSaved),
      queriesRoutedLocally: localQueries,
    }
  }

  // ---- Per-model performance ----------------------------------------------

  /**
   * Get performance metrics for a specific model.
   */
  getModelPerformance(model: string): ModelPerformance {
    const modelOutcomes = this.outcomes.filter(
      (o) => o.decision.model === model,
    )

    if (modelOutcomes.length === 0) {
      return {
        avgLatency: 0,
        successRate: 0,
        avgTokens: 0,
        totalQueries: 0,
      }
    }

    const totalQueries = modelOutcomes.length
    const avgLatency = Math.round(
      modelOutcomes.reduce((s, o) => s + o.actualLatency, 0) / totalQueries,
    )
    const successRate =
      Math.round(
        (modelOutcomes.filter((o) => o.success).length / totalQueries) * 1000,
      ) / 1000

    // Estimate tokens from cost (rough: cost / costPer1kTokens * 1000)
    let avgTokens = 0
    const withCost = modelOutcomes.filter((o) => o.actualCost > 0)
    if (withCost.length > 0) {
      const estimatedCostPerToken =
        withCost[0]!.decision.estimatedCost > 0
          ? withCost[0]!.decision.estimatedCost / 1000
          : 0.000009 // fallback
      const totalTokensEst = withCost.reduce(
        (s, o) => s + o.actualCost / estimatedCostPerToken,
        0,
      )
      avgTokens = Math.round(totalTokensEst / withCost.length)
    }

    return {
      avgLatency,
      successRate,
      avgTokens,
      totalQueries,
    }
  }

  // ---- Policy suggestions -------------------------------------------------

  /**
   * Suggest policy adjustments based on observed routing patterns.
   */
  suggestPolicyAdjustments(): string[] {
    const suggestions: string[] = []

    if (this.outcomes.length < 10) {
      return ['Insufficient data for policy suggestions (need 10+ routing records)']
    }

    const accuracy = this.getAccuracy()

    // High over-routing suggests local threshold could be raised
    const overRouteRate = accuracy.overRouted / this.outcomes.length
    if (overRouteRate > 0.2) {
      suggestions.push(
        `Increase local routing threshold - ${Math.round(overRouteRate * 100)}% of queries were over-routed to cloud when local likely would have worked`,
      )
    }

    // High under-routing suggests local model isn't capable enough
    const underRouteRate = accuracy.underRouted / this.outcomes.length
    if (underRouteRate > 0.15) {
      suggestions.push(
        `Reduce local routing scope - ${Math.round(underRouteRate * 100)}% of locally-routed queries failed and required escalation`,
      )
    }

    // Analyze per-complexity-level success rates
    const levelStats = this.getPerLevelStats()
    for (const [level, stats] of levelStats) {
      if (stats.total >= 5 && stats.successRate > 0.95) {
        const isLocal = stats.primaryTier === 'local_small' || stats.primaryTier === 'local_medium'
        if (!isLocal) {
          suggestions.push(
            `Consider routing '${level}' tasks locally - ${Math.round(stats.successRate * 100)}% success rate suggests they don't need cloud models`,
          )
        }
      }
      if (stats.total >= 5 && stats.successRate < 0.7) {
        const isLocal = stats.primaryTier === 'local_small' || stats.primaryTier === 'local_medium'
        if (isLocal) {
          suggestions.push(
            `Route '${level}' tasks to cloud - only ${Math.round(stats.successRate * 100)}% success rate with local models`,
          )
        }
      }
    }

    // Check if cloud_fast could replace cloud_standard for most tasks
    const fastOutcomes = this.outcomes.filter(
      (o) => o.decision.tier === 'cloud_fast',
    )
    const standardOutcomes = this.outcomes.filter(
      (o) => o.decision.tier === 'cloud_standard',
    )
    if (
      fastOutcomes.length >= 5 &&
      standardOutcomes.length >= 5
    ) {
      const fastSuccess =
        fastOutcomes.filter((o) => o.success).length / fastOutcomes.length
      const standardSuccess =
        standardOutcomes.filter((o) => o.success).length / standardOutcomes.length
      if (fastSuccess >= 0.9 && Math.abs(fastSuccess - standardSuccess) < 0.05) {
        suggestions.push(
          'cloud_fast has similar success rate to cloud_standard - consider using cloud_fast more to reduce cost',
        )
      }
    }

    if (suggestions.length === 0) {
      suggestions.push('Current routing policy appears well-tuned')
    }

    return suggestions
  }

  // ---- Helpers ------------------------------------------------------------

  private getPerLevelStats(): Map<
    string,
    { total: number; successRate: number; primaryTier: ModelTier }
  > {
    // Group by complexity level from the decision reason
    const levelMap = new Map<
      string,
      { total: number; successes: number; tiers: Map<ModelTier, number> }
    >()

    for (const o of this.outcomes) {
      // Extract complexity level from reason string (e.g., "Complexity: simple (score 25)")
      const match = o.decision.reason.match(/Complexity:\s*(\w+)/)
      const level = match?.[1] ?? 'unknown'

      let entry = levelMap.get(level)
      if (!entry) {
        entry = { total: 0, successes: 0, tiers: new Map() }
        levelMap.set(level, entry)
      }
      entry.total++
      if (o.success) entry.successes++
      entry.tiers.set(
        o.decision.tier,
        (entry.tiers.get(o.decision.tier) ?? 0) + 1,
      )
    }

    const result = new Map<
      string,
      { total: number; successRate: number; primaryTier: ModelTier }
    >()

    for (const [level, data] of levelMap) {
      // Find the most common tier
      let primaryTier: ModelTier = 'cloud_fast'
      let maxCount = 0
      for (const [tier, count] of data.tiers) {
        if (count > maxCount) {
          maxCount = count
          primaryTier = tier
        }
      }

      result.set(level, {
        total: data.total,
        successRate: data.total > 0 ? data.successes / data.total : 0,
        primaryTier,
      })
    }

    return result
  }

  // ---- Accessors ----------------------------------------------------------

  get totalOutcomes(): number {
    return this.outcomes.length
  }

  clear(): void {
    this.outcomes = []
  }
}
