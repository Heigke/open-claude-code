/**
 * Feedback Dashboard
 *
 * Provides tool health monitoring, insight effectiveness tracking,
 * problematic tool identification, and session summaries on top of
 * the ExecutionTracker and FailureAnalyzer.
 */

import type { ExecutionTracker, ToolExecution } from './executionTracker.js'
import type { FailureAnalyzer } from './failureAnalyzer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolHealthEntry = {
  successRate: number
  avgDuration: number
  commonErrors: string[]
  totalExecutions: number
}

export type InsightEffectiveness = {
  insightsGenerated: number
  insightsThatHelped: number
  hitRate: number
}

export type ProblematicTool = {
  toolName: string
  failureRate: number
  totalExecutions: number
  recentFailures: number
  topError: string | null
}

// ---------------------------------------------------------------------------
// FeedbackDashboard
// ---------------------------------------------------------------------------

export class FeedbackDashboard {
  private tracker: ExecutionTracker
  private analyzer: FailureAnalyzer
  private insightEvents: Array<{
    timestamp: number
    toolName: string
    successAfter: boolean
  }> = []

  constructor(tracker: ExecutionTracker, analyzer: FailureAnalyzer) {
    this.tracker = tracker
    this.analyzer = analyzer
  }

  /**
   * Call this when an insight was generated and injected, along with
   * whether the subsequent tool use succeeded. Used for effectiveness tracking.
   */
  recordInsightOutcome(
    toolName: string,
    successAfter: boolean,
  ): void {
    this.insightEvents.push({
      timestamp: Date.now(),
      toolName,
      successAfter,
    })
  }

  // ---- Tool Health --------------------------------------------------------

  /**
   * Get health metrics for each tool that has been tracked.
   */
  getToolHealth(): Map<string, ToolHealthEntry> {
    const result = new Map<string, ToolHealthEntry>()
    const executions = this.tracker.getRecentExecutions(undefined, 200)

    // Group by tool name
    const groups = new Map<string, ToolExecution[]>()
    for (const exec of executions) {
      let arr = groups.get(exec.toolName)
      if (!arr) {
        arr = []
        groups.set(exec.toolName, arr)
      }
      arr.push(exec)
    }

    for (const [toolName, execs] of groups) {
      const totalExecutions = execs.length
      const successes = execs.filter((e) => e.success).length
      const successRate =
        Math.round((successes / totalExecutions) * 1000) / 1000

      const durationsWithValue = execs.filter((e) => e.durationMs > 0)
      const avgDuration =
        durationsWithValue.length > 0
          ? Math.round(
              durationsWithValue.reduce((s, e) => s + e.durationMs, 0) /
                durationsWithValue.length,
            )
          : 0

      // Collect common errors (deduplicated, top 5)
      const errorCounts = new Map<string, number>()
      for (const e of execs) {
        if (!e.success && e.errorMessage) {
          const key = e.errorType ?? e.errorMessage.slice(0, 80)
          errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1)
        }
      }
      const commonErrors = Array.from(errorCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([err]) => err)

      result.set(toolName, {
        successRate,
        avgDuration,
        commonErrors,
        totalExecutions,
      })
    }

    return result
  }

  // ---- Insight Effectiveness ----------------------------------------------

  /**
   * Get effectiveness metrics for generated insights.
   */
  getInsightEffectiveness(): InsightEffectiveness {
    const insights = this.analyzer.analyze(this.tracker)
    const insightsGenerated = insights.length + this.insightEvents.length

    const insightsThatHelped = this.insightEvents.filter(
      (e) => e.successAfter,
    ).length

    const hitRate =
      this.insightEvents.length > 0
        ? Math.round((insightsThatHelped / this.insightEvents.length) * 1000) /
          1000
        : 0

    return {
      insightsGenerated,
      insightsThatHelped,
      hitRate,
    }
  }

  // ---- Most Problematic Tools ---------------------------------------------

  /**
   * Get the tools with the highest failure rates, sorted by failure rate
   * descending. Requires at least 2 executions to be considered.
   */
  getMostProblematicTools(limit = 5): ProblematicTool[] {
    const health = this.getToolHealth()
    const executions = this.tracker.getRecentExecutions(undefined, 200)

    const tools: ProblematicTool[] = []

    for (const [toolName, entry] of health) {
      if (entry.totalExecutions < 2) continue

      const failureRate =
        Math.round((1 - entry.successRate) * 1000) / 1000

      // Count recent failures (last 20 executions of this tool)
      const toolExecs = executions.filter((e) => e.toolName === toolName)
      const recentSlice = toolExecs.slice(-20)
      const recentFailures = recentSlice.filter((e) => !e.success).length

      tools.push({
        toolName,
        failureRate,
        totalExecutions: entry.totalExecutions,
        recentFailures,
        topError: entry.commonErrors[0] ?? null,
      })
    }

    return tools
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, limit)
  }

  // ---- Session Summary ----------------------------------------------------

  /**
   * Generate a formatted string summary of the current session's
   * tool feedback metrics.
   */
  getSessionSummary(): string {
    const health = this.getToolHealth()
    const effectiveness = this.getInsightEffectiveness()
    const problematic = this.getMostProblematicTools(3)

    const lines: string[] = []

    lines.push('=== Tool Feedback Session Summary ===')
    lines.push('')

    // Overall stats
    let totalExecs = 0
    let totalFailures = 0
    for (const [, entry] of health) {
      totalExecs += entry.totalExecutions
      totalFailures += Math.round(
        entry.totalExecutions * (1 - entry.successRate),
      )
    }
    lines.push('-- Overview --')
    lines.push(`  Tools tracked:       ${health.size}`)
    lines.push(`  Total executions:    ${totalExecs}`)
    lines.push(
      `  Overall success rate: ${totalExecs > 0 ? Math.round(((totalExecs - totalFailures) / totalExecs) * 100) : 100}%`,
    )
    lines.push('')

    // Insight effectiveness
    lines.push('-- Insight Effectiveness --')
    lines.push(`  Insights generated:  ${effectiveness.insightsGenerated}`)
    lines.push(`  Insights that helped: ${effectiveness.insightsThatHelped}`)
    lines.push(
      `  Hit rate:            ${Math.round(effectiveness.hitRate * 100)}%`,
    )
    lines.push('')

    // Problematic tools
    lines.push('-- Most Problematic Tools --')
    if (problematic.length === 0) {
      lines.push('  (none - all tools healthy)')
    } else {
      for (const t of problematic) {
        lines.push(
          `  ${t.toolName.padEnd(15)} failure rate: ${Math.round(t.failureRate * 100)}%  (${t.totalExecutions} executions)` +
            (t.topError ? `  top error: ${t.topError.slice(0, 50)}` : ''),
        )
      }
    }
    lines.push('')

    // Per-tool health
    lines.push('-- Per-Tool Health --')
    for (const [toolName, entry] of health) {
      lines.push(
        `  ${toolName.padEnd(15)} success: ${Math.round(entry.successRate * 100)}%  avg duration: ${entry.avgDuration}ms  executions: ${entry.totalExecutions}`,
      )
    }

    return lines.join('\n')
  }
}
