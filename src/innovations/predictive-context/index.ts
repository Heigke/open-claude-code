// ---------------------------------------------------------------------------
// Predictive Context Management — Innovation #2
//
// Proactive compaction with semantic priority ranking. Instead of reacting
// at 80% context window usage, this module predicts growth and triggers
// compaction at 70% *predicted* usage, selecting the lowest-value messages
// first based on a multi-factor priority score.
// ---------------------------------------------------------------------------

export {
  type MessagePriority,
  type ConversationContext,
  PriorityCalculator,
  buildConversationContext,
} from './messagePriority.js'

export {
  type CompactionUrgency,
  type PreemptiveCompactDecision,
  type TokenSnapshot,
  type CompactionEvent,
  ContextPredictor,
} from './contextPredictor.js'

export {
  type CompactionSelection,
  SelectiveCompactor,
} from './selectiveCompactor.js'

// ---------------------------------------------------------------------------
// Factory — convenience function to create a fully wired instance set
// ---------------------------------------------------------------------------

export type PredictiveContextManager = {
  predictor: import('./contextPredictor.js').ContextPredictor
  calculator: import('./messagePriority.js').PriorityCalculator
  compactor: import('./selectiveCompactor.js').SelectiveCompactor
}

/**
 * Create a complete predictive context management stack with sensible
 * defaults. Pass options to override the predictor's sliding window,
 * threshold, or lookahead.
 */
export function createPredictiveContextManager(options?: {
  slidingWindowSize?: number
  preemptiveThresholdFraction?: number
  lookaheadTurns?: number
  protectedUserMessages?: number
}): PredictiveContextManager {
  return {
    predictor: new ContextPredictor({
      slidingWindowSize: options?.slidingWindowSize,
      preemptiveThresholdFraction: options?.preemptiveThresholdFraction,
      lookaheadTurns: options?.lookaheadTurns,
    }),
    calculator: new PriorityCalculator(),
    compactor: new SelectiveCompactor({
      protectedUserMessages: options?.protectedUserMessages,
    }),
  }
}
