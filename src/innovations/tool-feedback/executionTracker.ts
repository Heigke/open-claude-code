/**
 * Execution Tracker
 *
 * Records tool execution telemetry in a sliding window and detects
 * failure patterns that can be used for adaptive prompting.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolExecution {
  toolName: string
  /** Short summary of the input (not the full payload) */
  input: string
  /** Short summary of the output (not the full payload) */
  output: string
  success: boolean
  errorType?: string
  errorMessage?: string
  timestamp: Date
  durationMs: number
  /** 1-based attempt counter for retries of the same logical operation */
  attempt: number
}

export interface ExecutionPattern {
  toolName: string
  /** Human-readable description of the pattern (e.g. "old_string not found") */
  pattern: string
  /** How many times this pattern has been observed in the current window */
  frequency: number
  lastSeen: Date
  outcomes: {
    success: number
    failure: number
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 200

// ---------------------------------------------------------------------------
// ExecutionTracker
// ---------------------------------------------------------------------------

export class ExecutionTracker {
  private executions: ToolExecution[] = []

  // ---- Recording --------------------------------------------------------

  record(execution: ToolExecution): void {
    this.executions.push(execution)

    // Sliding window – drop oldest entries when we exceed the cap.
    if (this.executions.length > MAX_ENTRIES) {
      this.executions = this.executions.slice(this.executions.length - MAX_ENTRIES)
    }
  }

  // ---- Queries ----------------------------------------------------------

  /**
   * Return the most recent executions, optionally filtered by tool name.
   */
  getRecentExecutions(toolName?: string, limit = 20): ToolExecution[] {
    let filtered = this.executions
    if (toolName) {
      filtered = filtered.filter((e) => e.toolName === toolName)
    }
    return filtered.slice(-limit)
  }

  /**
   * Detect failure patterns by grouping failures on (toolName, errorType).
   */
  getFailurePatterns(toolName?: string): ExecutionPattern[] {
    const failures = this.executions.filter(
      (e) => !e.success && (!toolName || e.toolName === toolName),
    )

    // Group by toolName + errorType (or errorMessage prefix when errorType is absent)
    const groups = new Map<string, ToolExecution[]>()
    for (const f of failures) {
      const key = `${f.toolName}::${f.errorType ?? summariseError(f.errorMessage)}`
      let arr = groups.get(key)
      if (!arr) {
        arr = []
        groups.set(key, arr)
      }
      arr.push(f)
    }

    const patterns: ExecutionPattern[] = []
    for (const [, execs] of groups) {
      if (execs.length === 0) continue
      const first = execs[0]!

      // Count successes with the same tool to provide outcome context.
      const toolSuccesses = this.executions.filter(
        (e) => e.success && e.toolName === first.toolName,
      ).length

      patterns.push({
        toolName: first.toolName,
        pattern: first.errorType ?? summariseError(first.errorMessage) ?? 'unknown',
        frequency: execs.length,
        lastSeen: execs[execs.length - 1]!.timestamp,
        outcomes: {
          success: toolSuccesses,
          failure: execs.length,
        },
      })
    }

    // Sort by frequency descending so the most common patterns appear first.
    patterns.sort((a, b) => b.frequency - a.frequency)
    return patterns
  }

  /**
   * How many consecutive failures have occurred for the given tool
   * (counting backwards from the most recent execution).
   */
  getConsecutiveFailures(toolName: string): number {
    let count = 0
    for (let i = this.executions.length - 1; i >= 0; i--) {
      const e = this.executions[i]!
      if (e.toolName !== toolName) continue
      if (e.success) break
      count++
    }
    return count
  }

  /**
   * Success rate for the given tool over the last `windowSize` executions
   * of that tool. Returns a value between 0 and 1. Returns 1 if there are
   * no executions (avoid false alarms).
   */
  getSuccessRate(toolName: string, windowSize = 50): number {
    const toolExecs = this.executions.filter((e) => e.toolName === toolName)
    if (toolExecs.length === 0) return 1

    const window = toolExecs.slice(-windowSize)
    const successes = window.filter((e) => e.success).length
    return successes / window.length
  }

  /**
   * Total number of executions currently tracked.
   */
  get size(): number {
    return this.executions.length
  }

  /**
   * Remove all tracked executions.
   */
  clear(): void {
    this.executions = []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a short pattern string from an error message. Takes the first ~80
 * characters and normalises whitespace.
 */
function summariseError(msg?: string): string {
  if (!msg) return 'unknown'
  return msg.replace(/\s+/g, ' ').trim().slice(0, 80)
}
