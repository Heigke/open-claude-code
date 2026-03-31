/**
 * Agent Mesh - Mesh Coordinator
 *
 * Orchestrates work distribution across agents in the mesh. Assigns tasks
 * with file-affinity awareness, rebalances load, and integrates results
 * into the shared knowledge graph with conflict checking.
 */

import type { AgentBus } from './agentBus.js'
import type { ConflictResolver, FileConflict } from './conflictResolver.js'
import type { KnowledgeGraph, KnowledgeNode } from './knowledgeGraph.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkItem = {
  id: string
  description: string
  /** Files this task is expected to touch */
  relatedFiles: string[]
  priority: number
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed'
  assignedTo?: string
}

export type AgentStatus = {
  agentId: string
  assignedTasks: number
  completedTasks: number
  /** Files this agent has previously touched */
  knownFiles: string[]
  idle: boolean
}

export type MeshStatus = {
  agents: AgentStatus[]
  conflicts: number
  completedTasks: number
  pendingTasks: number
}

export type WorkResults = {
  taskId: string
  nodes: KnowledgeNode[]
  success: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// MeshCoordinator
// ---------------------------------------------------------------------------

export class MeshCoordinator {
  private _graph: KnowledgeGraph
  private _bus: AgentBus
  private _resolver: ConflictResolver

  private _tasks = new Map<string, WorkItem>()
  private _agentTasks = new Map<string, Set<string>>() // agentId -> task ids
  private _agentFileHistory = new Map<string, Set<string>>() // agentId -> files
  private _completedCount = 0

  constructor(
    graph: KnowledgeGraph,
    bus: AgentBus,
    resolver: ConflictResolver,
  ) {
    this._graph = graph
    this._bus = bus
    this._resolver = resolver
  }

  // ---- Work assignment ----------------------------------------------------

  /**
   * Assign tasks to agents using round-robin with file-affinity preference.
   *
   * Tasks whose relatedFiles overlap with an agent's previously touched files
   * are preferentially assigned to that agent. Remaining tasks are distributed
   * round-robin.
   */
  assignWork(tasks: WorkItem[]): Map<string, WorkItem[]> {
    const agents = this._bus.getActiveAgents()
    if (agents.length === 0) {
      throw new Error('No active agents available for work assignment')
    }

    const assignment = new Map<string, WorkItem[]>()
    for (const agentId of agents) {
      assignment.set(agentId, [])
    }

    // Sort tasks by priority descending
    const sorted = [...tasks].sort((a, b) => b.priority - a.priority)
    const unassigned: WorkItem[] = []

    // First pass: affinity-based assignment
    for (const task of sorted) {
      const bestAgent = this._findAffinityAgent(task, agents)
      if (bestAgent) {
        this._assignTaskToAgent(task, bestAgent, assignment)
      } else {
        unassigned.push(task)
      }
    }

    // Second pass: round-robin for remaining tasks
    let robin = 0
    for (const task of unassigned) {
      // Pick the agent with the fewest currently assigned tasks
      const leastBusy = this._leastBusyAgent(agents, assignment)
      const agentId = leastBusy ?? agents[robin % agents.length]!
      this._assignTaskToAgent(task, agentId, assignment)
      robin++
    }

    // Notify agents about their assignments
    for (const [agentId, agentTasks] of assignment) {
      if (agentTasks.length > 0) {
        this._bus.publish({
          from: 'coordinator',
          to: agentId,
          type: 'work_request',
          payload: { tasks: agentTasks },
        })
      }
    }

    return assignment
  }

  /**
   * Rebalance work from overloaded agents to idle/underloaded ones.
   * Returns the reassignment map (agentId -> newly assigned tasks).
   */
  rebalance(): Map<string, WorkItem[]> {
    const agents = this._bus.getActiveAgents()
    const reassignment = new Map<string, WorkItem[]>()

    if (agents.length < 2) return reassignment

    // Calculate load per agent
    const loads = new Map<string, number>()
    for (const agentId of agents) {
      const tasks = this._agentTasks.get(agentId)
      const pendingCount = tasks
        ? [...tasks].filter((id) => {
            const t = this._tasks.get(id)
            return t && (t.status === 'assigned' || t.status === 'in_progress')
          }).length
        : 0
      loads.set(agentId, pendingCount)
    }

    const avgLoad =
      [...loads.values()].reduce((s, n) => s + n, 0) / agents.length

    // Find idle agents and overloaded agents
    const idle = agents.filter((a) => (loads.get(a) ?? 0) === 0)
    const overloaded = agents.filter((a) => (loads.get(a) ?? 0) > avgLoad + 1)

    if (idle.length === 0 || overloaded.length === 0) return reassignment

    for (const agentId of idle) {
      reassignment.set(agentId, [])
    }

    let idleIdx = 0
    for (const busyAgent of overloaded) {
      const taskIds = this._agentTasks.get(busyAgent)
      if (!taskIds) continue

      // Move tasks that are still in 'assigned' status (not yet started)
      for (const taskId of taskIds) {
        const task = this._tasks.get(taskId)
        if (!task || task.status !== 'assigned') continue
        if (idleIdx >= idle.length) break

        const targetAgent = idle[idleIdx % idle.length]!
        // Reassign
        task.assignedTo = targetAgent
        taskIds.delete(taskId)

        if (!this._agentTasks.has(targetAgent)) {
          this._agentTasks.set(targetAgent, new Set())
        }
        this._agentTasks.get(targetAgent)!.add(taskId)

        reassignment.get(targetAgent)!.push(task)
        idleIdx++
      }
    }

    // Notify reassigned agents
    for (const [agentId, tasks] of reassignment) {
      if (tasks.length > 0) {
        this._bus.publish({
          from: 'coordinator',
          to: agentId,
          type: 'work_request',
          payload: { tasks, reassigned: true },
        })
      }
    }

    return reassignment
  }

  // ---- Results handling ---------------------------------------------------

  /**
   * Process results from an agent completing work. Updates the graph and
   * checks for new conflicts.
   */
  async handleAgentComplete(
    agentId: string,
    results: WorkResults,
  ): Promise<FileConflict[]> {
    // Update task status
    const task = this._tasks.get(results.taskId)
    if (task) {
      task.status = results.success ? 'completed' : 'failed'
      if (results.success) {
        this._completedCount++
      }
    }

    // Record file history for affinity
    for (const node of results.nodes) {
      if (node.type === 'file') {
        if (!this._agentFileHistory.has(agentId)) {
          this._agentFileHistory.set(agentId, new Set())
        }
        this._agentFileHistory.get(agentId)!.add(node.content)
      }
    }

    // Add results to the knowledge graph
    for (const node of results.nodes) {
      await this._graph.addNode(node)
    }

    // Check for conflicts
    const conflicts = await this._resolver.detectConflicts(this._graph)

    if (conflicts.length > 0) {
      this._bus.broadcast({
        from: 'coordinator',
        to: 'broadcast',
        type: 'conflict_detected',
        payload: { conflicts, sourceAgent: agentId },
      })
    }

    // Announce completion
    this._bus.broadcast({
      from: 'coordinator',
      to: 'broadcast',
      type: 'work_complete',
      payload: {
        agentId,
        taskId: results.taskId,
        success: results.success,
      },
    })

    return conflicts
  }

  // ---- Status -------------------------------------------------------------

  async getStatus(): Promise<MeshStatus> {
    const agents = this._bus.getActiveAgents()
    const conflicts = await this._graph.getConflicts()

    const agentStatuses: AgentStatus[] = agents.map((agentId) => {
      const taskIds = this._agentTasks.get(agentId)
      const knownFiles = this._agentFileHistory.get(agentId)
      const assignedTasks = taskIds
        ? [...taskIds].filter((id) => {
            const t = this._tasks.get(id)
            return t && t.status !== 'completed' && t.status !== 'failed'
          }).length
        : 0
      const completedTasks = taskIds
        ? [...taskIds].filter((id) => {
            const t = this._tasks.get(id)
            return t?.status === 'completed'
          }).length
        : 0

      return {
        agentId,
        assignedTasks,
        completedTasks,
        knownFiles: knownFiles ? [...knownFiles] : [],
        idle: assignedTasks === 0,
      }
    })

    const pendingTasks = [...this._tasks.values()].filter(
      (t) => t.status === 'pending' || t.status === 'assigned',
    ).length

    return {
      agents: agentStatuses,
      conflicts: conflicts.length,
      completedTasks: this._completedCount,
      pendingTasks,
    }
  }

  // ---- Internals ----------------------------------------------------------

  private _findAffinityAgent(
    task: WorkItem,
    agents: string[],
  ): string | undefined {
    if (task.relatedFiles.length === 0) return undefined

    let bestAgent: string | undefined
    let bestOverlap = 0

    for (const agentId of agents) {
      const knownFiles = this._agentFileHistory.get(agentId)
      if (!knownFiles) continue

      const overlap = task.relatedFiles.filter((f) =>
        knownFiles.has(f),
      ).length
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        bestAgent = agentId
      }
    }

    return bestAgent
  }

  private _leastBusyAgent(
    agents: string[],
    assignment: Map<string, WorkItem[]>,
  ): string | undefined {
    let min = Infinity
    let result: string | undefined

    for (const agentId of agents) {
      const count = (assignment.get(agentId)?.length ?? 0) +
        (this._agentTasks.get(agentId)?.size ?? 0)
      if (count < min) {
        min = count
        result = agentId
      }
    }

    return result
  }

  private _assignTaskToAgent(
    task: WorkItem,
    agentId: string,
    assignment: Map<string, WorkItem[]>,
  ): void {
    task.status = 'assigned'
    task.assignedTo = agentId
    this._tasks.set(task.id, task)

    if (!this._agentTasks.has(agentId)) {
      this._agentTasks.set(agentId, new Set())
    }
    this._agentTasks.get(agentId)!.add(task.id)

    assignment.get(agentId)!.push(task)
  }
}
