// ---------------------------------------------------------------------------
// ContextPredictor — forecasts token growth and triggers preemptive compaction
// ---------------------------------------------------------------------------

export type CompactionUrgency = 'low' | 'medium' | 'high'

export type PreemptiveCompactDecision = {
  shouldCompact: boolean
  urgency: CompactionUrgency
  reason: string
}

export type TokenSnapshot = {
  /** Timestamp (ms since epoch) when this snapshot was taken */
  timestamp: number
  /** Total token count at this point */
  tokens: number
}

export type CompactionEvent = {
  timestamp: number
  tokensBefore: number
  tokensAfter: number
}

/**
 * ContextPredictor monitors token usage over time and predicts when the
 * context window will exceed safe thresholds. Unlike the reactive 80%
 * trigger in autoCompact, this uses a sliding-window growth rate to
 * trigger preemptive compaction at 70% _predicted_ usage within 3 turns.
 *
 * The predictor is stateful: call `recordTurn()` after each assistant
 * turn and `recordCompaction()` after each compaction event.
 */
export class ContextPredictor {
  /** Rolling window of per-turn token snapshots (most recent at end). */
  private tokenHistory: TokenSnapshot[] = []

  /** Derived per-turn deltas (tokenHistory[i+1].tokens - tokenHistory[i].tokens). */
  private growthRates: number[] = []

  /** Log of compaction events for rate-of-compaction analysis. */
  private compactionHistory: CompactionEvent[] = []

  /** Maximum number of turns to keep in the sliding window. */
  private readonly slidingWindowSize: number

  /** Fraction of the context window at which we trigger preemptive compact. */
  private readonly preemptiveThresholdFraction: number

  /** How many turns ahead to project for the preemptive trigger. */
  private readonly lookaheadTurns: number

  constructor(options?: {
    slidingWindowSize?: number
    preemptiveThresholdFraction?: number
    lookaheadTurns?: number
  }) {
    this.slidingWindowSize = options?.slidingWindowSize ?? 10
    this.preemptiveThresholdFraction =
      options?.preemptiveThresholdFraction ?? 0.70
    this.lookaheadTurns = options?.lookaheadTurns ?? 3
  }

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  /**
   * Record token usage after a turn completes.
   */
  recordTurn(tokens: number, timestamp: number = Date.now()): void {
    const snapshot: TokenSnapshot = { timestamp, tokens }

    // Compute delta from previous snapshot
    if (this.tokenHistory.length > 0) {
      const prev = this.tokenHistory[this.tokenHistory.length - 1]!
      this.growthRates.push(tokens - prev.tokens)
    }

    this.tokenHistory.push(snapshot)

    // Trim to sliding window
    while (this.tokenHistory.length > this.slidingWindowSize + 1) {
      this.tokenHistory.shift()
    }
    while (this.growthRates.length > this.slidingWindowSize) {
      this.growthRates.shift()
    }
  }

  /**
   * Record that a compaction just happened.
   */
  recordCompaction(
    tokensBefore: number,
    tokensAfter: number,
    timestamp: number = Date.now(),
  ): void {
    this.compactionHistory.push({ timestamp, tokensBefore, tokensAfter })

    // After compaction the growth history is stale — the base has shifted.
    // Keep the last snapshot but reset growth rates so the predictor
    // doesn't over-estimate based on pre-compaction deltas.
    this.growthRates = []
    this.tokenHistory = [{ timestamp, tokens: tokensAfter }]
  }

  // -----------------------------------------------------------------------
  // Prediction
  // -----------------------------------------------------------------------

  /**
   * Compute the average per-turn token growth rate from the sliding window.
   * Returns 0 if insufficient data.
   */
  getAverageGrowthRate(): number {
    if (this.growthRates.length === 0) return 0
    const sum = this.growthRates.reduce((a, b) => a + b, 0)
    return sum / this.growthRates.length
  }

  /**
   * Predict the total token count after `turnsAhead` additional turns,
   * assuming the current average growth rate continues.
   *
   * If `turnsAhead` is not provided, defaults to `this.lookaheadTurns`.
   */
  predictTokenGrowth(
    currentTokens: number,
    recentGrowthRate?: number,
    turnsRemaining?: number,
  ): number {
    const rate = recentGrowthRate ?? this.getAverageGrowthRate()
    const turns = turnsRemaining ?? this.lookaheadTurns
    // Linear projection (growth rate is tokens-per-turn, not a multiplier)
    return Math.max(currentTokens, currentTokens + rate * turns)
  }

  /**
   * Decide whether to preemptively compact now.
   *
   * The decision is based on whether the _predicted_ token count (at
   * `lookaheadTurns` turns from now) will exceed `preemptiveThresholdFraction`
   * of the context window.
   *
   * Urgency mapping:
   *  - high:   current usage already above threshold
   *  - medium: predicted to exceed threshold within lookahead
   *  - low:    predicted to exceed 60% within lookahead (advisory)
   */
  shouldPreemptivelyCompact(
    currentUsage: number,
    windowSize: number,
    growthRate?: number,
  ): PreemptiveCompactDecision {
    const rate = growthRate ?? this.getAverageGrowthRate()
    const threshold = windowSize * this.preemptiveThresholdFraction

    // Already above threshold — compact immediately
    if (currentUsage >= threshold) {
      return {
        shouldCompact: true,
        urgency: 'high',
        reason: `Current usage (${currentUsage}) already exceeds ${Math.round(this.preemptiveThresholdFraction * 100)}% threshold (${Math.round(threshold)})`,
      }
    }

    // Predict forward
    const predicted = this.predictTokenGrowth(currentUsage, rate)

    if (predicted >= threshold) {
      return {
        shouldCompact: true,
        urgency: 'medium',
        reason: `Predicted usage (${Math.round(predicted)}) will exceed ${Math.round(this.preemptiveThresholdFraction * 100)}% threshold (${Math.round(threshold)}) within ${this.lookaheadTurns} turns at rate ${Math.round(rate)} tokens/turn`,
      }
    }

    // Advisory: approaching 60%
    const advisoryThreshold = windowSize * 0.60
    if (predicted >= advisoryThreshold) {
      return {
        shouldCompact: false,
        urgency: 'low',
        reason: `Approaching advisory threshold — predicted ${Math.round(predicted)} tokens within ${this.lookaheadTurns} turns (60% = ${Math.round(advisoryThreshold)})`,
      }
    }

    return {
      shouldCompact: false,
      urgency: 'low',
      reason: `Usage healthy — ${currentUsage} tokens, predicted ${Math.round(predicted)} within ${this.lookaheadTurns} turns`,
    }
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /** Get a copy of current state for debugging / logging. */
  getState(): {
    tokenHistory: readonly TokenSnapshot[]
    growthRates: readonly number[]
    compactionHistory: readonly CompactionEvent[]
    averageGrowthRate: number
  } {
    return {
      tokenHistory: [...this.tokenHistory],
      growthRates: [...this.growthRates],
      compactionHistory: [...this.compactionHistory],
      averageGrowthRate: this.getAverageGrowthRate(),
    }
  }

  /** Number of recorded turns in the sliding window. */
  get turnCount(): number {
    return this.tokenHistory.length
  }
}
