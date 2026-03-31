/**
 * Agent Mesh - Knowledge Graph
 *
 * A shared knowledge graph that multiple agents can read from and write to.
 * Supports node/edge CRUD, querying, conflict detection, merge, and
 * JSON serialization. Uses a simple async lock for concurrent access safety.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnowledgeNodeType =
  | 'file'
  | 'function'
  | 'api'
  | 'decision'
  | 'fact'

export type KnowledgeNode = {
  id: string
  type: KnowledgeNodeType
  content: string
  metadata: Record<string, unknown>
  agentId: string
  timestamp: number
  /** Confidence score 0-1 */
  confidence: number
}

export type KnowledgeEdgeRelation =
  | 'depends_on'
  | 'modifies'
  | 'uses'
  | 'conflicts_with'
  | 'supersedes'

export type KnowledgeEdge = {
  from: string
  to: string
  relation: KnowledgeEdgeRelation
  agentId: string
  timestamp: number
}

export type MergeResult = {
  added: { nodes: number; edges: number }
  conflicts: KnowledgeEdge[]
}

/** Serialized form stored on disk */
type KnowledgeGraphData = {
  version: 1
  nodes: KnowledgeNode[]
  edges: KnowledgeEdge[]
}

// ---------------------------------------------------------------------------
// Simple async lock
// ---------------------------------------------------------------------------

class AsyncLock {
  private _queue: Array<() => void> = []
  private _locked = false

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true
      return
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve)
    })
  }

  release(): void {
    if (this._queue.length > 0) {
      const next = this._queue.shift()!
      // Keep locked, hand off to next waiter
      next()
    } else {
      this._locked = false
    }
  }
}

// ---------------------------------------------------------------------------
// KnowledgeGraph
// ---------------------------------------------------------------------------

export class KnowledgeGraph {
  private _nodes: Map<string, KnowledgeNode> = new Map()
  private _edges: KnowledgeEdge[] = []
  private _lock = new AsyncLock()

  // ---- Nodes --------------------------------------------------------------

  async addNode(node: KnowledgeNode): Promise<void> {
    await this._lock.acquire()
    try {
      this._nodes.set(node.id, node)
    } finally {
      this._lock.release()
    }
  }

  async removeNode(id: string): Promise<boolean> {
    await this._lock.acquire()
    try {
      const existed = this._nodes.delete(id)
      if (existed) {
        // Remove edges referencing this node
        this._edges = this._edges.filter((e) => e.from !== id && e.to !== id)
      }
      return existed
    } finally {
      this._lock.release()
    }
  }

  async getNode(id: string): Promise<KnowledgeNode | undefined> {
    await this._lock.acquire()
    try {
      return this._nodes.get(id)
    } finally {
      this._lock.release()
    }
  }

  // ---- Edges --------------------------------------------------------------

  async addEdge(edge: KnowledgeEdge): Promise<void> {
    await this._lock.acquire()
    try {
      // Validate that both endpoints exist
      if (!this._nodes.has(edge.from)) {
        throw new Error(
          `Cannot add edge: source node '${edge.from}' does not exist`,
        )
      }
      if (!this._nodes.has(edge.to)) {
        throw new Error(
          `Cannot add edge: target node '${edge.to}' does not exist`,
        )
      }
      this._edges.push(edge)
    } finally {
      this._lock.release()
    }
  }

  // ---- Queries ------------------------------------------------------------

  async query(
    type?: KnowledgeNodeType,
    pattern?: string,
  ): Promise<KnowledgeNode[]> {
    await this._lock.acquire()
    try {
      let results = Array.from(this._nodes.values())

      if (type !== undefined) {
        results = results.filter((n) => n.type === type)
      }

      if (pattern !== undefined) {
        const regex = new RegExp(pattern, 'i')
        results = results.filter(
          (n) => regex.test(n.id) || regex.test(n.content),
        )
      }

      return results
    } finally {
      this._lock.release()
    }
  }

  /**
   * Return nodes related to the given node, optionally filtered by relation.
   */
  async getRelated(
    nodeId: string,
    relation?: KnowledgeEdgeRelation,
  ): Promise<KnowledgeNode[]> {
    await this._lock.acquire()
    try {
      const relatedIds = new Set<string>()

      for (const edge of this._edges) {
        if (relation !== undefined && edge.relation !== relation) continue

        if (edge.from === nodeId) {
          relatedIds.add(edge.to)
        } else if (edge.to === nodeId) {
          relatedIds.add(edge.from)
        }
      }

      const nodes: KnowledgeNode[] = []
      for (const id of relatedIds) {
        const node = this._nodes.get(id)
        if (node) nodes.push(node)
      }
      return nodes
    } finally {
      this._lock.release()
    }
  }

  /**
   * Return all edges with relation 'conflicts_with'.
   */
  async getConflicts(): Promise<KnowledgeEdge[]> {
    await this._lock.acquire()
    try {
      return this._edges.filter((e) => e.relation === 'conflicts_with')
    } finally {
      this._lock.release()
    }
  }

  // ---- Merge --------------------------------------------------------------

  /**
   * Merge another graph into this one. Nodes with the same id are kept
   * if this graph's version is newer (by timestamp); otherwise replaced.
   * New conflict edges are created when both graphs modify the same node
   * from different agents.
   */
  async merge(other: KnowledgeGraph): Promise<MergeResult> {
    await this._lock.acquire()
    try {
      const result: MergeResult = {
        added: { nodes: 0, edges: 0 },
        conflicts: [],
      }

      // Snapshot the other graph's internal state (bypass its lock since
      // we only read). This is safe because merge is the only cross-graph
      // operation and callers should not write to `other` concurrently.
      const otherNodes = Array.from(other._nodes.values())
      const otherEdges = [...other._edges]

      for (const node of otherNodes) {
        const existing = this._nodes.get(node.id)
        if (!existing) {
          this._nodes.set(node.id, node)
          result.added.nodes++
        } else if (existing.agentId !== node.agentId) {
          // Two different agents contributed a node with the same id
          const conflictEdge: KnowledgeEdge = {
            from: existing.id,
            to: node.id,
            relation: 'conflicts_with',
            agentId: node.agentId,
            timestamp: Date.now(),
          }
          result.conflicts.push(conflictEdge)
          this._edges.push(conflictEdge)

          // Keep the more recent version
          if (node.timestamp > existing.timestamp) {
            this._nodes.set(node.id, node)
          }
        } else if (node.timestamp > existing.timestamp) {
          // Same agent, newer version -> replace
          this._nodes.set(node.id, node)
        }
      }

      for (const edge of otherEdges) {
        // Avoid duplicate edges
        const isDuplicate = this._edges.some(
          (e) =>
            e.from === edge.from &&
            e.to === edge.to &&
            e.relation === edge.relation,
        )
        if (!isDuplicate) {
          // Only add if both endpoints exist in the merged graph
          if (this._nodes.has(edge.from) && this._nodes.has(edge.to)) {
            this._edges.push(edge)
            result.added.edges++
          }
        }
      }

      return result
    } finally {
      this._lock.release()
    }
  }

  // ---- Serialization ------------------------------------------------------

  async serialize(): Promise<string> {
    await this._lock.acquire()
    try {
      const data: KnowledgeGraphData = {
        version: 1,
        nodes: Array.from(this._nodes.values()),
        edges: this._edges,
      }
      return JSON.stringify(data, null, 2)
    } finally {
      this._lock.release()
    }
  }

  static deserialize(json: string): KnowledgeGraph {
    const data: KnowledgeGraphData = JSON.parse(json)
    if (data.version !== 1) {
      throw new Error(`Unsupported knowledge graph version: ${data.version}`)
    }
    const graph = new KnowledgeGraph()
    for (const node of data.nodes) {
      graph._nodes.set(node.id, node)
    }
    graph._edges = data.edges
    return graph
  }

  // ---- File persistence ---------------------------------------------------

  async saveToFile(path: string): Promise<void> {
    const json = await this.serialize()
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, json, 'utf-8')
  }

  static loadFromFile(path: string): KnowledgeGraph {
    if (!existsSync(path)) {
      return new KnowledgeGraph()
    }
    const json = readFileSync(path, 'utf-8')
    return KnowledgeGraph.deserialize(json)
  }

  // ---- Introspection (non-locking, for internal use) ----------------------

  get nodeCount(): number {
    return this._nodes.size
  }

  get edgeCount(): number {
    return this._edges.length
  }
}
