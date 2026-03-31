/**
 * Tool Failure Feedback Loop
 *
 * Adaptive prompting based on tool execution telemetry. Records tool
 * outcomes, detects recurring failure patterns, and injects targeted
 * hints into the prompt to steer the model toward successful strategies.
 */

// Execution tracker
export { ExecutionTracker } from './executionTracker.js'
export type { ToolExecution, ExecutionPattern } from './executionTracker.js'

// Failure analyzer
export { FailureAnalyzer } from './failureAnalyzer.js'
export type {
  FailureInsight,
  FailureCategory,
  Confidence,
  AnalyzerFn,
} from './failureAnalyzer.js'

// Adaptive prompt injector
export { AdaptivePromptInjector } from './adaptivePromptInjector.js'
export type {
  PromptInjection,
  InjectionPosition,
} from './adaptivePromptInjector.js'

// Integration facade
export { ToolFeedbackSystem } from './feedbackIntegration.js'
export type { ToolFeedbackStats } from './feedbackIntegration.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { ToolFeedbackSystem } from './feedbackIntegration.js'

/**
 * Create a fully-wired ToolFeedbackSystem instance ready for use.
 */
export function createToolFeedbackSystem(): ToolFeedbackSystem {
  return new ToolFeedbackSystem()
}
