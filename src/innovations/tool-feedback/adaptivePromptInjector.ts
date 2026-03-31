/**
 * Adaptive Prompt Injector
 *
 * Converts failure insights into concise prompt injections that guide
 * the model away from repeating the same mistakes. Manages injection
 * lifecycle (TTL, deduplication, max active count).
 */

import type { ExecutionTracker } from './executionTracker.js'
import type { FailureAnalyzer, FailureInsight } from './failureAnalyzer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InjectionPosition =
  | 'system_append'
  | 'before_tools'
  | 'after_failure'

export interface PromptInjection {
  /** The natural-language hint to include in the prompt. */
  content: string
  /** Higher priority injections appear first. */
  priority: number
  /** Where in the prompt this injection should be placed. */
  position: InjectionPosition
  /** Number of turns before this injection expires. */
  ttl: number
}

// ---------------------------------------------------------------------------
// Internal bookkeeping
// ---------------------------------------------------------------------------

interface ActiveInjection extends PromptInjection {
  /** Key for deduplication (derived from the insight). */
  key: string
  /** Remaining TTL (decremented each turn). */
  remainingTtl: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ACTIVE_INJECTIONS = 3
const DEFAULT_TTL = 4

// ---------------------------------------------------------------------------
// AdaptivePromptInjector
// ---------------------------------------------------------------------------

export class AdaptivePromptInjector {
  private tracker: ExecutionTracker
  private analyzer: FailureAnalyzer
  private active: ActiveInjection[] = []
  private lastEmittedKeys: Set<string> = new Set()

  constructor(tracker: ExecutionTracker, analyzer: FailureAnalyzer) {
    this.tracker = tracker
    this.analyzer = analyzer
  }

  /**
   * Produce the current set of prompt injections, sorted by priority
   * descending. Call this once per turn.
   */
  getInjections(): PromptInjection[] {
    // 1. Age-out expired injections.
    this.active = this.active
      .map((inj) => ({ ...inj, remainingTtl: inj.remainingTtl - 1 }))
      .filter((inj) => inj.remainingTtl > 0)

    // 2. Run the analyzer to discover new insights.
    const insights = this.analyzer.analyze(this.tracker)

    // 3. Convert each insight to an injection (if not already tracked).
    for (const insight of insights) {
      const key = injectionKey(insight)
      if (this.active.some((a) => a.key === key)) continue

      const injection = insightToInjection(insight)
      this.active.push({
        ...injection,
        key,
        remainingTtl: injection.ttl,
      })
    }

    // 4. Sort by priority descending, then cap at MAX_ACTIVE_INJECTIONS.
    this.active.sort((a, b) => b.priority - a.priority)
    this.active = this.active.slice(0, MAX_ACTIVE_INJECTIONS)

    // 5. Deduplicate: don't emit the exact same set of keys twice in a row.
    const currentKeys = new Set(this.active.map((a) => a.key))
    const results: PromptInjection[] = []
    for (const inj of this.active) {
      // Skip injections that were already emitted last turn AND whose
      // underlying pattern has not worsened (same key, same content).
      if (this.lastEmittedKeys.has(inj.key)) {
        // Still include it if it's the only option, but avoid pure
        // repetition when there's nothing new to say.
        // We include it anyway – the real protection is TTL expiry.
      }
      results.push({
        content: inj.content,
        priority: inj.priority,
        position: inj.position,
        ttl: inj.remainingTtl,
      })
    }

    this.lastEmittedKeys = currentKeys
    return results
  }

  /**
   * Number of currently active injections.
   */
  get activeCount(): number {
    return this.active.length
  }

  /**
   * Remove all active injections.
   */
  clear(): void {
    this.active = []
    this.lastEmittedKeys.clear()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function injectionKey(insight: FailureInsight): string {
  return `${insight.toolName}::${insight.pattern}::${insight.category}`
}

function insightToInjection(insight: FailureInsight): PromptInjection {
  const priority = confidenceToPriority(insight.confidence)
  const position = positionFor(insight)

  return {
    content: formatInsight(insight),
    priority,
    position,
    ttl: DEFAULT_TTL,
  }
}

function confidenceToPriority(confidence: FailureInsight['confidence']): number {
  switch (confidence) {
    case 'high':
      return 90
    case 'medium':
      return 60
    case 'low':
      return 30
  }
}

function positionFor(insight: FailureInsight): InjectionPosition {
  // State-mismatch insights are most useful right before tool calls.
  if (insight.category === 'state_mismatch') return 'before_tools'
  // Everything else goes at the end of the system prompt.
  return 'system_append'
}

function formatInsight(insight: FailureInsight): string {
  return `[Tool Feedback] ${insight.suggestion}`
}
