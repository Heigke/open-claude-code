/**
 * Agent Performance Tracker
 *
 * Records task completion metrics per agent and provides rankings,
 * statistics, and specialty detection. An agent is considered a
 * specialist in a task type if it has a >70% success rate with 5+
 * completions of that type.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskRecord = {
  agentId: string
  taskType: string
  durationMs: number
  success: boolean
  timestamp: number
}

export type AgentStats = {
  completedTasks: number
  avgDuration: number
  successRate: number
  specialties: string[]
}

export type AgentRanking = {
  agentId: string
  score: number
  completedTasks: number
  avgDuration: number
  successRate: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPECIALTY_MIN_COMPLETIONS = 5
const SPECIALTY_MIN_SUCCESS_RATE = 0.70

// ---------------------------------------------------------------------------
// AgentPerformanceTracker
// ---------------------------------------------------------------------------

export class AgentPerformanceTracker {
  private records: TaskRecord[] = []

  // ---- Recording ----------------------------------------------------------

  /**
   * Record a task completion event.
   */
  recordTaskCompletion(
    agentId: string,
    taskType: string,
    durationMs: number,
    success: boolean,
  ): void {
    this.records.push({
      agentId,
      taskType,
      durationMs,
      success,
      timestamp: Date.now(),
    })
  }

  // ---- Statistics ---------------------------------------------------------

  /**
   * Get aggregate statistics for a given agent.
   */
  getAgentStats(agentId: string): AgentStats {
    const agentRecords = this.records.filter((r) => r.agentId === agentId)

    if (agentRecords.length === 0) {
      return {
        completedTasks: 0,
        avgDuration: 0,
        successRate: 0,
        specialties: [],
      }
    }

    const completedTasks = agentRecords.length
    const avgDuration =
      Math.round(
        agentRecords.reduce((s, r) => s + r.durationMs, 0) / completedTasks,
      )
    const successRate =
      agentRecords.filter((r) => r.success).length / completedTasks

    const specialties = this.detectSpecialties(agentRecords)

    return {
      completedTasks,
      avgDuration,
      successRate: Math.round(successRate * 1000) / 1000,
      specialties,
    }
  }

  // ---- Rankings -----------------------------------------------------------

  /**
   * Rank all agents by efficiency. If a taskType is provided, rank only
   * by performance on that task type. Agents with no records for the
   * given task type are excluded.
   *
   * Score formula: successRate * 0.6 + speedScore * 0.4
   * Where speedScore inversely scales with avgDuration relative to the
   * slowest agent.
   */
  rankAgents(taskType?: string): AgentRanking[] {
    // Group records by agent, optionally filtering by task type
    const agentMap = new Map<string, TaskRecord[]>()

    for (const r of this.records) {
      if (taskType && r.taskType !== taskType) continue
      let arr = agentMap.get(r.agentId)
      if (!arr) {
        arr = []
        agentMap.set(r.agentId, arr)
      }
      arr.push(r)
    }

    if (agentMap.size === 0) return []

    // Compute per-agent stats
    const stats: Array<{
      agentId: string
      completedTasks: number
      avgDuration: number
      successRate: number
    }> = []

    for (const [agentId, records] of agentMap) {
      const completedTasks = records.length
      const avgDuration =
        Math.round(
          records.reduce((s, r) => s + r.durationMs, 0) / completedTasks,
        )
      const successRate =
        records.filter((r) => r.success).length / completedTasks
      stats.push({ agentId, completedTasks, avgDuration, successRate })
    }

    // Find the maximum duration for speed scoring
    const maxDuration = Math.max(...stats.map((s) => s.avgDuration), 1)

    // Compute composite score and sort
    const rankings: AgentRanking[] = stats.map((s) => {
      const speedScore =
        s.avgDuration > 0
          ? (1 - s.avgDuration / maxDuration) * 100
          : 100
      const score = Math.round(s.successRate * 60 + speedScore * 0.4)

      return {
        agentId: s.agentId,
        score,
        completedTasks: s.completedTasks,
        avgDuration: s.avgDuration,
        successRate: Math.round(s.successRate * 1000) / 1000,
      }
    })

    rankings.sort((a, b) => b.score - a.score)
    return rankings
  }

  // ---- Specialty detection ------------------------------------------------

  /**
   * Detect specialties from a set of task records for a single agent.
   * A task type is a specialty if the agent has completed 5+ tasks of
   * that type with >70% success rate.
   */
  private detectSpecialties(agentRecords: TaskRecord[]): string[] {
    const typeMap = new Map<
      string,
      { total: number; successes: number }
    >()

    for (const r of agentRecords) {
      const existing = typeMap.get(r.taskType)
      if (existing) {
        existing.total++
        if (r.success) existing.successes++
      } else {
        typeMap.set(r.taskType, {
          total: 1,
          successes: r.success ? 1 : 0,
        })
      }
    }

    const specialties: string[] = []
    for (const [taskType, counts] of typeMap) {
      if (
        counts.total >= SPECIALTY_MIN_COMPLETIONS &&
        counts.successes / counts.total >= SPECIALTY_MIN_SUCCESS_RATE
      ) {
        specialties.push(taskType)
      }
    }

    return specialties.sort()
  }

  // ---- Accessors ----------------------------------------------------------

  /**
   * Total number of recorded task completions.
   */
  get totalRecords(): number {
    return this.records.length
  }

  /**
   * Get all unique agent IDs that have recorded completions.
   */
  getKnownAgents(): string[] {
    return [...new Set(this.records.map((r) => r.agentId))].sort()
  }

  /**
   * Clear all recorded data.
   */
  clear(): void {
    this.records = []
  }
}
