/**
 * Session Analyzer
 *
 * Examines a recorded session to produce metrics, detect bottlenecks,
 * compare recordings, and suggest optimisations.
 */

import type { SessionEvent, SessionRecording } from './sessionRecorder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  input: number
  output: number
  cached: number
}

export interface ToolStats {
  count: number
  avgDuration: number
  successRate: number
}

export interface CostBreakdown {
  total: number
  byTool: Record<string, number>
  byPhase: Record<string, number>
}

export interface EfficiencyScore {
  /** 0-100 overall score. */
  overall: number
  /** 0-100 tool reuse score. */
  toolReuse: number
  /** 0-100 error recovery score. */
  errorRecovery: number
  /** 0-100 token efficiency score. */
  tokenEfficiency: number
}

export interface Bottleneck {
  type: 'slow_tool' | 'repeated_failure' | 'large_context' | 'permission_delay'
  description: string
  impact: 'low' | 'medium' | 'high'
  suggestion: string
}

export interface ErrorPattern {
  toolName: string
  errorMessage: string
  occurrences: number
  firstSeen: number
  lastSeen: number
}

export interface SessionAnalysis {
  duration: number
  eventCount: number
  tokenUsage: TokenUsage
  toolBreakdown: Map<string, ToolStats>
  costBreakdown: CostBreakdown
  bottlenecks: Bottleneck[]
  errorPatterns: ErrorPattern[]
  efficiency: EfficiencyScore
}

export interface ComparisonReport {
  /** Which recording was faster (-1 = A, +1 = B, 0 = same). */
  fasterSession: -1 | 0 | 1
  durationDiff: number
  /** Which recording was cheaper. */
  cheaperSession: -1 | 0 | 1
  costDiff: number
  tokenDiff: { input: number; output: number; cached: number }
  toolDiffs: Record<string, { countDiff: number; durationDiff: number; successRateDiff: number }>
  /** Summary sentence. */
  summary: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toolCallEvents(events: SessionEvent[]) {
  return events.filter((e) => e.type === 'tool_call')
}

function toolResultEvents(events: SessionEvent[]) {
  return events.filter((e) => e.type === 'tool_result')
}

// ---------------------------------------------------------------------------
// SessionAnalyzer
// ---------------------------------------------------------------------------

export class SessionAnalyzer {
  /** Produce a full analysis of a session recording. */
  analyze(recording: SessionRecording): SessionAnalysis {
    const events = recording.events
    const duration =
      (recording.endTime ?? events[events.length - 1]?.timestamp ?? recording.startTime) -
      recording.startTime

    // Token usage
    const tokenUsage: TokenUsage = { input: 0, output: 0, cached: 0 }
    for (const e of events) {
      if (e.type === 'token_usage') {
        tokenUsage.input += e.data?.input ?? 0
        tokenUsage.output += e.data?.output ?? 0
        tokenUsage.cached += e.data?.cached ?? 0
      }
    }

    // Tool breakdown
    const toolBreakdown = this.buildToolBreakdown(events)

    // Cost breakdown
    const costBreakdown = this.buildCostBreakdown(events, recording)

    // Bottlenecks
    const bottlenecks = this.findBottlenecks(recording)

    // Error patterns
    const errorPatterns = this.findErrorPatterns(events)

    // Efficiency
    const efficiency = this.computeEfficiency(events, toolBreakdown, tokenUsage, duration)

    return {
      duration,
      eventCount: events.length,
      tokenUsage,
      toolBreakdown,
      costBreakdown,
      bottlenecks,
      errorPatterns,
      efficiency,
    }
  }

  // -----------------------------------------------------------------------
  // Bottleneck detection
  // -----------------------------------------------------------------------

  findBottlenecks(recording: SessionRecording): Bottleneck[] {
    const bottlenecks: Bottleneck[] = []
    const events = recording.events

    // Slow tool: any tool_call -> tool_result pair taking >10s
    const callTimestamps = new Map<string, number>()
    for (const e of events) {
      if (e.type === 'tool_call' && e.data?.toolName) {
        callTimestamps.set(e.data.toolName + ':' + e.id, e.timestamp)
      }
      if (e.type === 'tool_result' && e.data?.toolCallId) {
        // Try matching via duration
        if (e.data.durationMs && e.data.durationMs > 10_000) {
          bottlenecks.push({
            type: 'slow_tool',
            description: `Tool "${e.data.toolName ?? 'unknown'}" took ${(e.data.durationMs / 1000).toFixed(1)}s`,
            impact: e.data.durationMs > 30_000 ? 'high' : 'medium',
            suggestion: `Consider caching results or using a faster alternative for ${e.data.toolName ?? 'this tool'}.`,
          })
        }
      }
    }

    // Also check by direct durationMs on tool_call events
    for (const e of events) {
      if (e.type === 'tool_call' && e.data?.durationMs && e.data.durationMs > 10_000) {
        const alreadyReported = bottlenecks.some(
          (b) => b.type === 'slow_tool' && b.description.includes(e.data.toolName),
        )
        if (!alreadyReported) {
          bottlenecks.push({
            type: 'slow_tool',
            description: `Tool "${e.data.toolName}" took ${(e.data.durationMs / 1000).toFixed(1)}s`,
            impact: e.data.durationMs > 30_000 ? 'high' : 'medium',
            suggestion: `Consider caching results or using a faster alternative for ${e.data.toolName}.`,
          })
        }
      }
    }

    // Repeated failure: same tool failing 3+ times
    const failureCounts = new Map<string, number>()
    for (const e of events) {
      if (e.type === 'tool_result' && e.data?.success === false) {
        const name = e.data.toolName ?? 'unknown'
        failureCounts.set(name, (failureCounts.get(name) ?? 0) + 1)
      }
    }
    for (const [toolName, count] of failureCounts) {
      if (count >= 3) {
        bottlenecks.push({
          type: 'repeated_failure',
          description: `Tool "${toolName}" failed ${count} times`,
          impact: count >= 5 ? 'high' : 'medium',
          suggestion: `Review error patterns for ${toolName}. Consider adding better error handling or pre-validation.`,
        })
      }
    }

    // Large context: token_usage event showing >80% window usage
    for (const e of events) {
      if (e.type === 'token_usage' && e.data?.windowUsage && e.data.windowUsage > 0.8) {
        bottlenecks.push({
          type: 'large_context',
          description: `Context window at ${(e.data.windowUsage * 100).toFixed(0)}% capacity`,
          impact: e.data.windowUsage > 0.95 ? 'high' : 'medium',
          suggestion: 'Trigger compaction earlier or reduce the amount of data loaded into context.',
        })
      }
    }

    // Permission delay: >5s between request and response
    const pendingPermissions = new Map<string, number>()
    for (const e of events) {
      if (e.type === 'permission_request') {
        const key = e.data?.permissionId ?? e.id
        pendingPermissions.set(key, e.timestamp)
      }
      if (e.type === 'permission_response') {
        const key = e.data?.permissionId ?? e.data?.requestId ?? ''
        const requestTs = pendingPermissions.get(key)
        if (requestTs !== undefined) {
          const delay = e.timestamp - requestTs
          if (delay > 5_000) {
            bottlenecks.push({
              type: 'permission_delay',
              description: `Permission response took ${(delay / 1000).toFixed(1)}s`,
              impact: delay > 15_000 ? 'high' : delay > 10_000 ? 'medium' : 'low',
              suggestion: 'Consider pre-approving common permissions or using trust escalation.',
            })
          }
          pendingPermissions.delete(key)
        }
      }
    }

    return bottlenecks
  }

  // -----------------------------------------------------------------------
  // Comparison
  // -----------------------------------------------------------------------

  compareRecordings(a: SessionRecording, b: SessionRecording): ComparisonReport {
    const analysisA = this.analyze(a)
    const analysisB = this.analyze(b)

    const durationDiff = analysisB.duration - analysisA.duration
    const costDiff = analysisB.costBreakdown.total - analysisA.costBreakdown.total

    const fasterSession = durationDiff < 0 ? 1 : durationDiff > 0 ? -1 : 0
    const cheaperSession = costDiff < 0 ? 1 : costDiff > 0 ? -1 : 0

    // Tool diffs
    const allTools = new Set([
      ...analysisA.toolBreakdown.keys(),
      ...analysisB.toolBreakdown.keys(),
    ])
    const toolDiffs: ComparisonReport['toolDiffs'] = {}
    for (const tool of allTools) {
      const sa = analysisA.toolBreakdown.get(tool) ?? { count: 0, avgDuration: 0, successRate: 1 }
      const sb = analysisB.toolBreakdown.get(tool) ?? { count: 0, avgDuration: 0, successRate: 1 }
      toolDiffs[tool] = {
        countDiff: sb.count - sa.count,
        durationDiff: sb.avgDuration - sa.avgDuration,
        successRateDiff: sb.successRate - sa.successRate,
      }
    }

    const faster = fasterSession === -1 ? 'A' : fasterSession === 1 ? 'B' : 'Neither'
    const cheaper = cheaperSession === -1 ? 'A' : cheaperSession === 1 ? 'B' : 'Neither'
    const summary = `Session ${faster} was faster (${Math.abs(durationDiff)}ms diff). Session ${cheaper} was cheaper ($${Math.abs(costDiff).toFixed(4)} diff).`

    return {
      fasterSession: fasterSession as -1 | 0 | 1,
      durationDiff,
      cheaperSession: cheaperSession as -1 | 0 | 1,
      costDiff,
      tokenDiff: {
        input: analysisB.tokenUsage.input - analysisA.tokenUsage.input,
        output: analysisB.tokenUsage.output - analysisA.tokenUsage.output,
        cached: analysisB.tokenUsage.cached - analysisA.tokenUsage.cached,
      },
      toolDiffs,
      summary,
    }
  }

  // -----------------------------------------------------------------------
  // Optimisation suggestions
  // -----------------------------------------------------------------------

  suggestOptimizations(analysis: SessionAnalysis): string[] {
    const suggestions: string[] = []

    // From bottlenecks
    for (const b of analysis.bottlenecks) {
      suggestions.push(b.suggestion)
    }

    // Token efficiency
    if (analysis.tokenUsage.cached === 0 && analysis.tokenUsage.input > 10_000) {
      suggestions.push('Enable prompt caching to reduce redundant token usage.')
    }

    // Tool reuse
    if (analysis.efficiency.toolReuse < 50) {
      suggestions.push('Many tools are only called once. Consider batching related operations.')
    }

    // Error patterns
    for (const ep of analysis.errorPatterns) {
      if (ep.occurrences >= 3) {
        suggestions.push(
          `Tool "${ep.toolName}" fails repeatedly with "${ep.errorMessage}". Add pre-validation or a fallback.`,
        )
      }
    }

    // Duration-based
    if (analysis.duration > 300_000) {
      suggestions.push('Session exceeded 5 minutes. Consider splitting into subtasks for parallelism.')
    }

    // Overall efficiency
    if (analysis.efficiency.overall < 40) {
      suggestions.push(
        'Overall efficiency is low. Review tool selection strategy and consider preloading context.',
      )
    }

    // De-duplicate
    return [...new Set(suggestions)]
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildToolBreakdown(events: SessionEvent[]): Map<string, ToolStats> {
    const map = new Map<string, { durations: number[]; successes: number; total: number }>()

    for (const e of events) {
      if (e.type === 'tool_call' || e.type === 'tool_result') {
        const name = e.data?.toolName
        if (!name) continue
        let entry = map.get(name)
        if (!entry) {
          entry = { durations: [], successes: 0, total: 0 }
          map.set(name, entry)
        }
        if (e.type === 'tool_result') {
          entry.total++
          if (e.data?.success !== false) entry.successes++
          if (typeof e.data?.durationMs === 'number') entry.durations.push(e.data.durationMs)
        }
      }
    }

    const result = new Map<string, ToolStats>()
    for (const [name, entry] of map) {
      const avg =
        entry.durations.length > 0
          ? entry.durations.reduce((a, b) => a + b, 0) / entry.durations.length
          : 0
      result.set(name, {
        count: entry.total,
        avgDuration: avg,
        successRate: entry.total > 0 ? entry.successes / entry.total : 1,
      })
    }

    return result
  }

  private buildCostBreakdown(
    events: SessionEvent[],
    recording: SessionRecording,
  ): CostBreakdown {
    const byTool: Record<string, number> = {}
    const byPhase: Record<string, number> = {}
    let total = 0

    for (const e of events) {
      if (e.type === 'token_usage' && typeof e.data?.cost === 'number') {
        total += e.data.cost
        const tool = e.data.toolName ?? 'general'
        byTool[tool] = (byTool[tool] ?? 0) + e.data.cost
        const phase = e.data.phase ?? 'execution'
        byPhase[phase] = (byPhase[phase] ?? 0) + e.data.cost
      }
    }

    if (total === 0) {
      total = recording.metadata.totalCost
    }

    return { total, byTool, byPhase }
  }

  private findErrorPatterns(events: SessionEvent[]): ErrorPattern[] {
    const map = new Map<string, ErrorPattern>()

    for (const e of events) {
      if (e.type === 'error' || (e.type === 'tool_result' && e.data?.success === false)) {
        const toolName = e.data?.toolName ?? 'unknown'
        const errorMessage = e.data?.error ?? e.data?.message ?? 'unknown error'
        const key = `${toolName}:${errorMessage}`

        let pattern = map.get(key)
        if (!pattern) {
          pattern = {
            toolName,
            errorMessage,
            occurrences: 0,
            firstSeen: e.timestamp,
            lastSeen: e.timestamp,
          }
          map.set(key, pattern)
        }
        pattern.occurrences++
        pattern.lastSeen = e.timestamp
      }
    }

    return Array.from(map.values())
  }

  private computeEfficiency(
    events: SessionEvent[],
    toolBreakdown: Map<string, ToolStats>,
    tokenUsage: TokenUsage,
    duration: number,
  ): EfficiencyScore {
    // Tool reuse: higher if tools are called multiple times (batching)
    const toolCounts = Array.from(toolBreakdown.values()).map((s) => s.count)
    const avgCalls = toolCounts.length > 0
      ? toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length
      : 0
    const toolReuse = clamp(avgCalls * 20, 0, 100)

    // Error recovery: how many errors were followed by success
    let errors = 0
    let recoveries = 0
    const failedTools = new Set<string>()
    for (const e of events) {
      if (e.type === 'tool_result' && e.data?.success === false) {
        errors++
        failedTools.add(e.data?.toolName ?? '')
      }
      if (e.type === 'tool_result' && e.data?.success === true && failedTools.has(e.data?.toolName ?? '')) {
        recoveries++
        failedTools.delete(e.data.toolName)
      }
    }
    const errorRecovery = errors === 0 ? 100 : clamp((recoveries / errors) * 100, 0, 100)

    // Token efficiency: ratio of cached to total
    const totalTokens = tokenUsage.input + tokenUsage.output
    const tokenEfficiency = totalTokens > 0
      ? clamp((tokenUsage.cached / totalTokens) * 100 + 50, 0, 100)
      : 50

    const overall = Math.round((toolReuse + errorRecovery + tokenEfficiency) / 3)

    return {
      overall,
      toolReuse: Math.round(toolReuse),
      errorRecovery: Math.round(errorRecovery),
      tokenEfficiency: Math.round(tokenEfficiency),
    }
  }
}
