/**
 * Trust Dashboard
 *
 * Provides reporting and analytics on top of the TrustStore.
 * Offers sorted rankings, recent activity views, summary statistics,
 * and a formatted text report.
 */

import { computeScore, type TrustScore, type TrustStore } from './trustStore.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustSummary = {
  totalEntries: number
  avgScore: number
  topWorkspace: string | null
  mostTrustedTool: string | null
  leastTrustedTool: string | null
}

export type RecentActivity = {
  tool: string
  pattern: string
  workspace: string
  lastUsed: string
  score: number
  successCount: number
  failureCount: number
}

// ---------------------------------------------------------------------------
// TrustDashboard
// ---------------------------------------------------------------------------

export class TrustDashboard {
  private store: TrustStore

  constructor(store: TrustStore) {
    this.store = store
  }

  /**
   * Return the top trusted tools sorted by current score descending.
   * Aggregates across all patterns/workspaces by taking the max score
   * per tool name, then sorts by that max score.
   */
  getTopTrustedTools(limit = 10): Array<{ tool: string; maxScore: number; totalUses: number }> {
    const entries = this.store.allEntries()
    if (entries.length === 0) return []

    // Aggregate per tool
    const toolMap = new Map<string, { maxScore: number; totalUses: number }>()

    for (const entry of entries) {
      const existing = toolMap.get(entry.tool)
      const uses = entry.successCount + entry.failureCount
      if (existing) {
        existing.maxScore = Math.max(existing.maxScore, entry.score)
        existing.totalUses += uses
      } else {
        toolMap.set(entry.tool, { maxScore: entry.score, totalUses: uses })
      }
    }

    return Array.from(toolMap.entries())
      .map(([tool, data]) => ({ tool, ...data }))
      .sort((a, b) => b.maxScore - a.maxScore)
      .slice(0, limit)
  }

  /**
   * Return recent trust activity within the given number of days,
   * sorted by lastUsed descending (most recent first).
   */
  getRecentActivity(days = 7): RecentActivity[] {
    const entries = this.store.allEntries()
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

    return entries
      .filter((e) => new Date(e.lastUsed).getTime() >= cutoff)
      .sort(
        (a, b) =>
          new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime(),
      )
      .map((e) => ({
        tool: e.tool,
        pattern: e.pattern,
        workspace: e.workspace,
        lastUsed: e.lastUsed,
        score: e.score,
        successCount: e.successCount,
        failureCount: e.failureCount,
      }))
  }

  /**
   * Compute aggregate summary statistics across all trust entries.
   */
  getTrustSummary(): TrustSummary {
    const entries = this.store.allEntries()

    if (entries.length === 0) {
      return {
        totalEntries: 0,
        avgScore: 0,
        topWorkspace: null,
        mostTrustedTool: null,
        leastTrustedTool: null,
      }
    }

    // Average score
    const avgScore =
      Math.round(
        (entries.reduce((sum, e) => sum + e.score, 0) / entries.length) * 10,
      ) / 10

    // Top workspace by total uses
    const workspaceUses = new Map<string, number>()
    for (const e of entries) {
      workspaceUses.set(
        e.workspace,
        (workspaceUses.get(e.workspace) ?? 0) +
          e.successCount +
          e.failureCount,
      )
    }
    let topWorkspace: string | null = null
    let topWorkspaceUses = 0
    for (const [ws, uses] of workspaceUses) {
      if (uses > topWorkspaceUses) {
        topWorkspaceUses = uses
        topWorkspace = ws
      }
    }

    // Most/least trusted tool (by max score per tool)
    const toolMaxScores = new Map<string, number>()
    for (const e of entries) {
      const prev = toolMaxScores.get(e.tool) ?? 0
      toolMaxScores.set(e.tool, Math.max(prev, e.score))
    }

    let mostTrustedTool: string | null = null
    let mostTrustedScore = -1
    let leastTrustedTool: string | null = null
    let leastTrustedScore = 101

    for (const [tool, score] of toolMaxScores) {
      if (score > mostTrustedScore) {
        mostTrustedScore = score
        mostTrustedTool = tool
      }
      if (score < leastTrustedScore) {
        leastTrustedScore = score
        leastTrustedTool = tool
      }
    }

    return {
      totalEntries: entries.length,
      avgScore,
      topWorkspace,
      mostTrustedTool,
      leastTrustedTool,
    }
  }

  /**
   * Export a human-readable report summarizing the trust state.
   */
  exportReport(): string {
    const summary = this.getTrustSummary()
    const topTools = this.getTopTrustedTools(5)
    const recent = this.getRecentActivity(7)

    const lines: string[] = []

    lines.push('=== Trust Escalation Report ===')
    lines.push('')
    lines.push('-- Summary --')
    lines.push(`  Total entries:       ${summary.totalEntries}`)
    lines.push(`  Average score:       ${summary.avgScore}`)
    lines.push(`  Top workspace:       ${summary.topWorkspace ?? '(none)'}`)
    lines.push(`  Most trusted tool:   ${summary.mostTrustedTool ?? '(none)'}`)
    lines.push(`  Least trusted tool:  ${summary.leastTrustedTool ?? '(none)'}`)
    lines.push('')

    lines.push('-- Top Trusted Tools --')
    if (topTools.length === 0) {
      lines.push('  (no data)')
    } else {
      for (const t of topTools) {
        lines.push(
          `  ${t.tool.padEnd(20)} score: ${String(t.maxScore).padStart(3)}  uses: ${t.totalUses}`,
        )
      }
    }
    lines.push('')

    lines.push('-- Recent Activity (7 days) --')
    if (recent.length === 0) {
      lines.push('  (no recent activity)')
    } else {
      const shown = recent.slice(0, 10)
      for (const r of shown) {
        lines.push(
          `  ${r.tool} | ${r.pattern.slice(0, 30).padEnd(30)} | score ${String(r.score).padStart(3)} | ${r.successCount}ok/${r.failureCount}fail | ${r.lastUsed}`,
        )
      }
      if (recent.length > 10) {
        lines.push(`  ... and ${recent.length - 10} more`)
      }
    }

    return lines.join('\n')
  }
}
