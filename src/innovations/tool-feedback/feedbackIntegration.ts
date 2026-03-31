/**
 * Feedback Integration
 *
 * Main entry point for the Tool Failure Feedback Loop. Wires together
 * the execution tracker, failure analyzer, and prompt injector into a
 * single facade that can be called from the tool-execution pipeline.
 */

import { AdaptivePromptInjector } from './adaptivePromptInjector.js'
import { ExecutionTracker, type ToolExecution } from './executionTracker.js'
import { FailureAnalyzer } from './failureAnalyzer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolFeedbackStats {
  totalExecutions: number
  failureRate: number
  insightsGenerated: number
  injectionsActive: number
}

// ---------------------------------------------------------------------------
// ToolFeedbackSystem
// ---------------------------------------------------------------------------

export class ToolFeedbackSystem {
  private tracker: ExecutionTracker
  private analyzer: FailureAnalyzer
  private injector: AdaptivePromptInjector
  private totalRecorded = 0
  private totalFailures = 0

  constructor() {
    this.tracker = new ExecutionTracker()
    this.analyzer = new FailureAnalyzer()
    this.injector = new AdaptivePromptInjector(this.tracker, this.analyzer)
  }

  // ---- Event hook -------------------------------------------------------

  /**
   * Call this after every tool execution to feed telemetry into the system.
   */
  onToolComplete(
    toolName: string,
    input: string,
    output: string,
    success: boolean,
    error?: { type?: string; message?: string },
  ): void {
    const execution: ToolExecution = {
      toolName,
      input: truncate(input, 200),
      output: truncate(output, 200),
      success,
      errorType: error?.type,
      errorMessage: error?.message ? truncate(error.message, 300) : undefined,
      timestamp: new Date(),
      durationMs: 0, // Duration must be measured externally if needed.
      attempt: this.computeAttempt(toolName, input),
    }
    this.tracker.record(execution)
    this.totalRecorded++
    if (!success) this.totalFailures++
  }

  // ---- Prompt integration -----------------------------------------------

  /**
   * Returns a string to append to the system prompt, or null if there is
   * nothing actionable to inject.
   */
  getSystemPromptAddendum(): string | null {
    const injections = this.injector.getInjections()
    const systemInjections = injections.filter(
      (i) => i.position === 'system_append',
    )
    if (systemInjections.length === 0) return null

    return systemInjections.map((i) => i.content).join('\n')
  }

  /**
   * Returns a hint to present before a specific tool invocation, or null.
   */
  getPreToolHint(toolName: string, _input: string): string | null {
    const injections = this.injector.getInjections()
    const beforeTool = injections.filter(
      (i) => i.position === 'before_tools',
    )
    // Only return hints relevant to the tool about to run.
    const relevant = beforeTool.filter((i) =>
      i.content.toLowerCase().includes(toolName.toLowerCase()),
    )
    if (relevant.length === 0) return null

    return relevant.map((i) => i.content).join('\n')
  }

  // ---- Lifecycle --------------------------------------------------------

  /**
   * Clear all tracked state and active injections.
   */
  reset(): void {
    this.tracker.clear()
    this.injector.clear()
    this.totalRecorded = 0
    this.totalFailures = 0
  }

  // ---- Stats ------------------------------------------------------------

  getStats(): ToolFeedbackStats {
    return {
      totalExecutions: this.totalRecorded,
      failureRate:
        this.totalRecorded > 0
          ? this.totalFailures / this.totalRecorded
          : 0,
      insightsGenerated: this.analyzer.analyze(this.tracker).length,
      injectionsActive: this.injector.activeCount,
    }
  }

  // ---- Internal access (for testing) ------------------------------------

  /** @internal */
  get _tracker(): ExecutionTracker {
    return this.tracker
  }

  /** @internal */
  get _analyzer(): FailureAnalyzer {
    return this.analyzer
  }

  /** @internal */
  get _injector(): AdaptivePromptInjector {
    return this.injector
  }

  // ---- Helpers ----------------------------------------------------------

  /**
   * Determine the attempt number by counting recent consecutive executions
   * of the same tool with similar input.
   */
  private computeAttempt(toolName: string, input: string): number {
    const recent = this.tracker.getRecentExecutions(toolName, 10)
    let attempt = 1
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i]!
      // Consider it a retry if the input overlaps significantly.
      if (inputsSimilar(e.input, truncate(input, 200))) {
        attempt++
      } else {
        break
      }
    }
    return attempt
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 3) + '...'
}

/**
 * Cheap similarity check: two inputs are "similar" if they share the
 * same first 60 characters (covers file path + operation).
 */
function inputsSimilar(a: string, b: string): boolean {
  const prefixLen = Math.min(60, a.length, b.length)
  return a.slice(0, prefixLen) === b.slice(0, prefixLen)
}
