/**
 * Agent Mesh - Conflict Resolver
 *
 * Detects and resolves conflicts between agents that modify the same files.
 * Supports timestamp-based resolution, priority-based resolution, and
 * auto-merge suggestions for non-overlapping changes.
 */

import type {
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeNode,
} from './knowledgeGraph.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConflictType = 'same_line' | 'semantic' | 'structural'

export type AgentChange = {
  agentId: string
  /** Description or diff of the changes made */
  changes: string
  /** Line range affected, if applicable */
  lineRange?: { start: number; end: number }
  timestamp: number
}

export type FileConflict = {
  file: string
  agentA: AgentChange
  agentB: AgentChange
  type: ConflictType
}

export type Resolution = {
  file: string
  winner: string // agentId
  loser: string // agentId
  resolvedChanges: string
  reason: string
}

export type MergeSuggestion = {
  merged: string
  confidence: number
  manual_review_needed: boolean
  explanation: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rangesOverlap(
  a?: { start: number; end: number },
  b?: { start: number; end: number },
): boolean {
  if (!a || !b) return false
  return a.start <= b.end && b.start <= a.end
}

function classifyConflict(a: AgentChange, b: AgentChange): ConflictType {
  if (rangesOverlap(a.lineRange, b.lineRange)) {
    return 'same_line'
  }
  // If both changes touch the same file but in different regions,
  // treat as structural (could be semantic if we had deeper analysis)
  return 'structural'
}

// ---------------------------------------------------------------------------
// ConflictResolver
// ---------------------------------------------------------------------------

export class ConflictResolver {
  /**
   * Scan the knowledge graph for 'conflicts_with' edges between file-type
   * nodes and return structured FileConflict objects.
   */
  async detectConflicts(graph: KnowledgeGraph): Promise<FileConflict[]> {
    const conflictEdges = await graph.getConflicts()
    const conflicts: FileConflict[] = []

    for (const edge of conflictEdges) {
      const nodeA = await graph.getNode(edge.from)
      const nodeB = await graph.getNode(edge.to)

      if (!nodeA || !nodeB) continue
      // Only consider file-level conflicts for FileConflict
      if (nodeA.type !== 'file' && nodeB.type !== 'file') continue

      const agentA = buildAgentChange(nodeA, edge)
      const agentB = buildAgentChange(nodeB, edge)

      conflicts.push({
        file: nodeA.content || nodeB.content,
        agentA,
        agentB,
        type: classifyConflict(agentA, agentB),
      })
    }

    return conflicts
  }

  /**
   * Resolve a conflict by picking the most recent change.
   */
  resolveByTimestamp(conflict: FileConflict): Resolution {
    const latest =
      conflict.agentA.timestamp >= conflict.agentB.timestamp
        ? conflict.agentA
        : conflict.agentB
    const other =
      latest === conflict.agentA ? conflict.agentB : conflict.agentA

    return {
      file: conflict.file,
      winner: latest.agentId,
      loser: other.agentId,
      resolvedChanges: latest.changes,
      reason: `Agent '${latest.agentId}' had the more recent change (${new Date(latest.timestamp).toISOString()})`,
    }
  }

  /**
   * Resolve a conflict using explicit agent priorities.
   * Higher number = higher priority. Equal priority falls back to timestamp.
   */
  resolveByPriority(
    conflict: FileConflict,
    agentPriorities: Map<string, number>,
  ): Resolution {
    const prioA = agentPriorities.get(conflict.agentA.agentId) ?? 0
    const prioB = agentPriorities.get(conflict.agentB.agentId) ?? 0

    if (prioA === prioB) {
      return this.resolveByTimestamp(conflict)
    }

    const winner = prioA > prioB ? conflict.agentA : conflict.agentB
    const loser = winner === conflict.agentA ? conflict.agentB : conflict.agentA

    return {
      file: conflict.file,
      winner: winner.agentId,
      loser: loser.agentId,
      resolvedChanges: winner.changes,
      reason: `Agent '${winner.agentId}' has higher priority (${Math.max(prioA, prioB)} vs ${Math.min(prioA, prioB)})`,
    }
  }

  /**
   * Suggest an automatic merge for the conflict.
   *
   * - If the two agents' changes affect different line regions, produce a
   *   merged result with high confidence.
   * - If regions overlap, flag for manual review.
   */
  suggestMerge(conflict: FileConflict): MergeSuggestion {
    const { agentA, agentB } = conflict
    const overlapping = rangesOverlap(agentA.lineRange, agentB.lineRange)

    if (!overlapping && agentA.lineRange && agentB.lineRange) {
      // Changes are in different regions - safe to auto-merge
      // Order by line position so the merged output is sequential
      const [first, second] =
        agentA.lineRange.start < agentB.lineRange.start
          ? [agentA, agentB]
          : [agentB, agentA]

      return {
        merged: `${first.changes}\n${second.changes}`,
        confidence: 0.85,
        manual_review_needed: false,
        explanation: `Changes are in non-overlapping regions (lines ${first.lineRange!.start}-${first.lineRange!.end} and ${second.lineRange!.start}-${second.lineRange!.end}). Auto-merged sequentially.`,
      }
    }

    if (overlapping) {
      // Overlapping regions - cannot safely auto-merge
      return {
        merged: agentA.changes, // keep A as default, but flag review
        confidence: 0.2,
        manual_review_needed: true,
        explanation: `Changes overlap on lines ${agentA.lineRange!.start}-${agentA.lineRange!.end} and ${agentB.lineRange!.start}-${agentB.lineRange!.end}. Manual review required.`,
      }
    }

    // No line range info at all - cannot determine overlap
    return {
      merged: agentA.changes,
      confidence: 0.1,
      manual_review_needed: true,
      explanation:
        'Insufficient line-range information to determine merge safety. Manual review required.',
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildAgentChange(
  node: KnowledgeNode,
  edge: KnowledgeEdge,
): AgentChange {
  const lineRange = node.metadata?.lineRange as
    | { start: number; end: number }
    | undefined

  return {
    agentId: node.agentId,
    changes: node.content,
    lineRange,
    timestamp: node.timestamp ?? edge.timestamp,
  }
}
