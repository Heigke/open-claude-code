/**
 * Context Health Monitor
 *
 * Tracks per-turn metrics (tokens, tool calls) and computes a health
 * score for the conversation context. Provides recommendations when
 * the context is approaching capacity limits or showing unhealthy
 * growth patterns.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnMetrics = {
  turnNumber: number
  inputTokens: number
  outputTokens: number
  toolCount: number
  timestamp: number
}

export type HealthScore = {
  /** Overall health 0 (critical) to 100 (healthy) */
  score: number
  /** Individual factor scores for transparency */
  factors: {
    growthRateStability: number
    compactionFrequency: number
    tokenEfficiency: number
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default context window size in tokens */
const DEFAULT_WINDOW_SIZE = 200_000

/** Alert at this fraction of capacity */
const WARN_THRESHOLD = 0.60
const CRITICAL_THRESHOLD = 0.75

// ---------------------------------------------------------------------------
// ContextHealthMonitor
// ---------------------------------------------------------------------------

export class ContextHealthMonitor {
  private turns: TurnMetrics[] = []
  private compactionTimestamps: number[] = []
  private windowSize: number

  constructor(windowSize = DEFAULT_WINDOW_SIZE) {
    this.windowSize = windowSize
  }

  // ---- Recording ----------------------------------------------------------

  /**
   * Record metrics for a completed turn.
   */
  trackTurnMetrics(
    turnNumber: number,
    inputTokens: number,
    outputTokens: number,
    toolCount: number,
  ): void {
    this.turns.push({
      turnNumber,
      inputTokens,
      outputTokens,
      toolCount,
      timestamp: Date.now(),
    })
  }

  /**
   * Record that a compaction event occurred.
   */
  recordCompaction(): void {
    this.compactionTimestamps.push(Date.now())
  }

  // ---- Health score -------------------------------------------------------

  /**
   * Compute an overall health score from 0 (critical) to 100 (healthy).
   *
   * Components:
   *  - Growth rate stability: lower variance in per-turn growth is healthier
   *  - Compaction frequency: frequent compactions indicate stress
   *  - Token efficiency: ratio of output tokens to total tokens (higher = better)
   */
  getHealthScore(): HealthScore {
    if (this.turns.length < 2) {
      return {
        score: 100,
        factors: {
          growthRateStability: 100,
          compactionFrequency: 100,
          tokenEfficiency: 100,
        },
      }
    }

    const growthRateStability = this.computeGrowthRateStability()
    const compactionFrequency = this.computeCompactionFrequencyScore()
    const tokenEfficiency = this.computeTokenEfficiency()

    // Weighted combination
    const score = Math.round(
      growthRateStability * 0.4 +
        compactionFrequency * 0.3 +
        tokenEfficiency * 0.3,
    )

    return {
      score: Math.max(0, Math.min(100, score)),
      factors: {
        growthRateStability: Math.round(growthRateStability),
        compactionFrequency: Math.round(compactionFrequency),
        tokenEfficiency: Math.round(tokenEfficiency),
      },
    }
  }

  // ---- Recommendations ----------------------------------------------------

  /**
   * Generate actionable recommendations based on current metrics.
   */
  getRecommendations(): string[] {
    const recommendations: string[] = []

    if (this.turns.length === 0) return recommendations

    const lastTurn = this.turns[this.turns.length - 1]!
    const currentTokens = lastTurn.inputTokens + lastTurn.outputTokens
    const capacityFraction = currentTokens / this.windowSize

    // Capacity warnings
    if (capacityFraction >= CRITICAL_THRESHOLD) {
      recommendations.push(
        `CRITICAL: At ${Math.round(capacityFraction * 100)}% capacity - compaction needed immediately`,
      )
    } else if (capacityFraction >= WARN_THRESHOLD) {
      const turnsUntilFull = this.estimateTurnsUntilCapacity(currentTokens)
      recommendations.push(
        `WARNING: At ${Math.round(capacityFraction * 100)}% capacity` +
          (turnsUntilFull !== null
            ? ` - estimated ${turnsUntilFull} turns until limit`
            : ''),
      )
    }

    // Growth rate analysis
    const growthRates = this.getGrowthRates()
    if (growthRates.length >= 3) {
      const recentRates = growthRates.slice(-3)
      const isIncreasing = recentRates.every(
        (r, i) => i === 0 || r > recentRates[i - 1]!,
      )
      if (isIncreasing) {
        recommendations.push(
          'Growth rate increasing - consider switching to selective compaction mode',
        )
      }
    }

    // Compaction frequency
    const recentCompactions = this.compactionTimestamps.filter(
      (t) => Date.now() - t < 10 * 60 * 1000, // last 10 minutes
    )
    if (recentCompactions.length >= 3) {
      recommendations.push(
        `Frequent compactions (${recentCompactions.length} in last 10 minutes) - context is under sustained pressure`,
      )
    }

    // Token efficiency
    const efficiency = this.computeTokenEfficiency()
    if (efficiency < 30) {
      recommendations.push(
        'Low token efficiency - consider reducing tool call verbosity or summarizing intermediate results',
      )
    }

    // Turns until capacity
    const turnsLeft = this.estimateTurnsUntilCapacity(currentTokens)
    if (turnsLeft !== null && turnsLeft <= 3 && capacityFraction < WARN_THRESHOLD) {
      recommendations.push(
        `Consider compacting - approximately ${turnsLeft} turns until limit at current growth rate`,
      )
    }

    return recommendations
  }

  // ---- Internal computations ----------------------------------------------

  private getGrowthRates(): number[] {
    const rates: number[] = []
    for (let i = 1; i < this.turns.length; i++) {
      const prev = this.turns[i - 1]!
      const curr = this.turns[i]!
      const prevTotal = prev.inputTokens + prev.outputTokens
      const currTotal = curr.inputTokens + curr.outputTokens
      rates.push(currTotal - prevTotal)
    }
    return rates
  }

  private computeGrowthRateStability(): number {
    const rates = this.getGrowthRates()
    if (rates.length < 2) return 100

    const mean = rates.reduce((s, r) => s + r, 0) / rates.length
    const variance =
      rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length
    const stdDev = Math.sqrt(variance)

    // Coefficient of variation (normalized by mean). Lower = more stable.
    // A CV of 0 means perfectly stable -> score 100.
    // A CV of 1 or more means very unstable -> score ~0.
    const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0
    return Math.max(0, Math.min(100, 100 - cv * 100))
  }

  private computeCompactionFrequencyScore(): number {
    if (this.compactionTimestamps.length === 0) return 100
    if (this.turns.length === 0) return 100

    // Ratio of compactions to turns. 0 compactions = 100, many = low.
    const ratio = this.compactionTimestamps.length / this.turns.length
    // 1 compaction per 10 turns is normal (score ~90).
    // 1 compaction per 2 turns is stressed (score ~50).
    // 1 compaction per turn is critical (score ~0).
    return Math.max(0, Math.min(100, 100 - ratio * 100))
  }

  private computeTokenEfficiency(): number {
    if (this.turns.length === 0) return 100

    let totalOutput = 0
    let totalTokens = 0
    for (const t of this.turns) {
      totalOutput += t.outputTokens
      totalTokens += t.inputTokens + t.outputTokens
    }

    if (totalTokens === 0) return 100

    // Output tokens as a fraction of total. Higher means more useful content
    // relative to context overhead. Scale to 0-100.
    // Typical healthy ratio is 20-40% output tokens.
    const ratio = totalOutput / totalTokens
    return Math.max(0, Math.min(100, ratio * 250)) // 40% ratio -> 100 score
  }

  private estimateTurnsUntilCapacity(
    currentTokens: number,
  ): number | null {
    const rates = this.getGrowthRates()
    if (rates.length === 0) return null

    const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length
    if (avgRate <= 0) return null

    const remaining = this.windowSize - currentTokens
    return Math.max(0, Math.ceil(remaining / avgRate))
  }
}
