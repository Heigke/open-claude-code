/**
 * Failure Analyzer
 *
 * Examines execution telemetry to produce actionable insights about
 * recurring tool failures. Each built-in analyzer targets a specific
 * failure mode and suggests a concrete remediation.
 */

import type { ExecutionTracker, ToolExecution } from './executionTracker.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureCategory =
  | 'whitespace'
  | 'file_not_found'
  | 'permission'
  | 'syntax'
  | 'state_mismatch'
  | 'other'

export type Confidence = 'high' | 'medium' | 'low'

export interface FailureInsight {
  toolName: string
  pattern: string
  suggestion: string
  confidence: Confidence
  category: FailureCategory
}

/**
 * An individual analyzer function. Given the tracker it may return an
 * insight or null (no actionable finding).
 */
export type AnalyzerFn = (tracker: ExecutionTracker) => FailureInsight | null

// ---------------------------------------------------------------------------
// FailureAnalyzer
// ---------------------------------------------------------------------------

export class FailureAnalyzer {
  private analyzers: AnalyzerFn[] = []

  constructor() {
    // Register the built-in analyzers.
    this.analyzers.push(
      analyzeEditOldStringNotFound,
      analyzeEditAfterEditFailure,
      analyzeBashPermissionDenied,
      analyzeBashCommandNotFound,
      analyzeGrepNoResults,
      analyzeConsecutiveSameToolFailures,
    )
  }

  /**
   * Run every registered analyzer and collect non-null insights.
   */
  analyze(tracker: ExecutionTracker): FailureInsight[] {
    const insights: FailureInsight[] = []
    for (const fn of this.analyzers) {
      try {
        const insight = fn(tracker)
        if (insight) insights.push(insight)
      } catch {
        // Never let a single analyzer blow up the whole pipeline.
      }
    }
    return insights
  }

  /**
   * Add a custom analyzer at runtime.
   */
  registerAnalyzer(fn: AnalyzerFn): void {
    this.analyzers.push(fn)
  }
}

// ---------------------------------------------------------------------------
// Built-in analyzers
// ---------------------------------------------------------------------------

/**
 * FileEdit "old_string not found" – the most common edit failure.
 */
function analyzeEditOldStringNotFound(
  tracker: ExecutionTracker,
): FailureInsight | null {
  const recent = tracker.getRecentExecutions('FileEdit', 10)
  const matching = recent.filter(
    (e) =>
      !e.success &&
      (e.errorMessage?.includes('old_string') ||
        e.errorMessage?.includes('not found in') ||
        e.errorMessage?.includes('does not match') ||
        e.errorType === 'old_string_not_found'),
  )
  if (matching.length === 0) return null

  const consecutiveFailures = tracker.getConsecutiveFailures('FileEdit')

  return {
    toolName: 'FileEdit',
    pattern: 'old_string not found',
    suggestion:
      consecutiveFailures >= 3
        ? 'FileEdit has failed multiple times because the old_string was not found. The file content has likely changed or the string has whitespace/encoding differences. Re-read the file with FileRead before attempting another edit.'
        : 'The last FileEdit failed because old_string was not found. Double-check whitespace and encoding, or re-read the file first.',
    confidence: consecutiveFailures >= 3 ? 'high' : 'medium',
    category: 'whitespace',
  }
}

/**
 * Detect Edit immediately after a previous Edit failure without an
 * intervening Read – a common mistake.
 */
function analyzeEditAfterEditFailure(
  tracker: ExecutionTracker,
): FailureInsight | null {
  const recent = tracker.getRecentExecutions(undefined, 5)
  if (recent.length < 2) return null

  // Walk backwards looking for an Edit failure followed by another Edit
  // with no Read in between.
  for (let i = recent.length - 1; i >= 1; i--) {
    const curr = recent[i]!
    const prev = recent[i - 1]!
    if (
      curr.toolName === 'FileEdit' &&
      prev.toolName === 'FileEdit' &&
      !prev.success
    ) {
      // Check if there's a Read between them in the full history.
      const fullRecent = tracker.getRecentExecutions(undefined, 20)
      const prevIdx = fullRecent.indexOf(prev)
      const currIdx = fullRecent.indexOf(curr)
      const between = fullRecent.slice(prevIdx + 1, currIdx)
      const hasRead = between.some((e) => e.toolName === 'FileRead')
      if (!hasRead) {
        return {
          toolName: 'FileEdit',
          pattern: 'edit_after_edit_failure_without_read',
          suggestion:
            'You are retrying a FileEdit without re-reading the file first. Read the file to get the current content before attempting another edit.',
          confidence: 'high',
          category: 'state_mismatch',
        }
      }
    }
  }
  return null
}

/**
 * Bash "permission denied".
 */
function analyzeBashPermissionDenied(
  tracker: ExecutionTracker,
): FailureInsight | null {
  const recent = tracker.getRecentExecutions('Bash', 10)
  const matching = recent.filter(
    (e) =>
      !e.success &&
      (e.errorMessage?.toLowerCase().includes('permission denied') ||
        e.errorType === 'permission_denied'),
  )
  if (matching.length === 0) return null

  return {
    toolName: 'Bash',
    pattern: 'permission_denied',
    suggestion:
      'A Bash command failed with "permission denied". Check file permissions (ls -la) or consider whether the command needs elevated privileges.',
    confidence: 'medium',
    category: 'permission',
  }
}

/**
 * Bash "command not found".
 */
function analyzeBashCommandNotFound(
  tracker: ExecutionTracker,
): FailureInsight | null {
  const recent = tracker.getRecentExecutions('Bash', 10)
  const matching = recent.filter(
    (e) =>
      !e.success &&
      (e.errorMessage?.toLowerCase().includes('command not found') ||
        e.errorMessage?.toLowerCase().includes('not found') ||
        e.errorType === 'command_not_found'),
  )
  if (matching.length === 0) return null

  // Try to extract the command name from the error.
  const lastError = matching[matching.length - 1]!
  const cmdMatch = lastError.errorMessage?.match(/(\S+):\s*command not found/i)
  const cmdHint = cmdMatch ? ` ("${cmdMatch[1]}")` : ''

  return {
    toolName: 'Bash',
    pattern: 'command_not_found',
    suggestion: `A Bash command${cmdHint} was not found. Check that the binary is installed and on the PATH, or use an alternative command.`,
    confidence: 'medium',
    category: 'other',
  }
}

/**
 * Grep returning no results repeatedly.
 */
function analyzeGrepNoResults(
  tracker: ExecutionTracker,
): FailureInsight | null {
  const consecutive = tracker.getConsecutiveFailures('Grep')
  if (consecutive < 2) return null

  return {
    toolName: 'Grep',
    pattern: 'no_results',
    suggestion:
      'Grep has returned no results multiple times in a row. Consider using a broader pattern, removing file-type filters, or trying a different search strategy (e.g. Glob to find files first).',
    confidence: consecutive >= 3 ? 'high' : 'medium',
    category: 'other',
  }
}

/**
 * Generic: 3+ consecutive failures of the same tool, regardless of error type.
 */
function analyzeConsecutiveSameToolFailures(
  tracker: ExecutionTracker,
): FailureInsight | null {
  const recent = tracker.getRecentExecutions(undefined, 10)
  if (recent.length < 3) return null

  // Check the last 3 executions.
  const last3 = recent.slice(-3)
  const allSameTool =
    last3.every((e) => e.toolName === last3[0]!.toolName) &&
    last3.every((e) => !e.success)
  if (!allSameTool) return null

  const toolName = last3[0]!.toolName

  // Don't duplicate a more specific insight for FileEdit or Grep.
  if (toolName === 'FileEdit' || toolName === 'Grep') return null

  return {
    toolName,
    pattern: 'consecutive_failures',
    suggestion: `${toolName} has failed ${tracker.getConsecutiveFailures(toolName)} times in a row. Consider a fundamentally different approach rather than retrying the same operation.`,
    confidence: 'high',
    category: 'other',
  }
}
