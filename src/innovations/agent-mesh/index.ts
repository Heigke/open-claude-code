/**
 * Agent Mesh with Shared Knowledge Graph
 *
 * Multi-agent shared state, communication, and conflict resolution system.
 */

export { KnowledgeGraph } from './knowledgeGraph.js'
export type {
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeEdge,
  KnowledgeEdgeRelation,
  MergeResult,
} from './knowledgeGraph.js'

export { ConflictResolver } from './conflictResolver.js'
export type {
  FileConflict,
  ConflictType,
  AgentChange,
  Resolution,
  MergeSuggestion,
} from './conflictResolver.js'

export { AgentBus } from './agentBus.js'
export type {
  AgentMessage,
  AgentMessageType,
  MessageHandler,
} from './agentBus.js'

export { MeshCoordinator } from './meshCoordinator.js'
export type {
  WorkItem,
  AgentStatus,
  MeshStatus,
  WorkResults,
} from './meshCoordinator.js'

export { AgentPerformanceTracker } from './agentPerformance.js'
export type {
  TaskRecord,
  AgentStats,
  AgentRanking,
} from './agentPerformance.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { AgentBus } from './agentBus.js'
import { ConflictResolver } from './conflictResolver.js'
import { KnowledgeGraph } from './knowledgeGraph.js'
import { MeshCoordinator } from './meshCoordinator.js'

export type AgentMesh = {
  graph: KnowledgeGraph
  bus: AgentBus
  resolver: ConflictResolver
  coordinator: MeshCoordinator
  /** Clean up all resources */
  destroy: () => void
}

/**
 * Create a fully wired agent mesh with all components.
 * Optionally load a persisted knowledge graph from disk.
 */
export function createAgentMesh(persistPath?: string): AgentMesh {
  const graph = persistPath
    ? KnowledgeGraph.loadFromFile(persistPath)
    : new KnowledgeGraph()

  const bus = new AgentBus()
  const resolver = new ConflictResolver()
  const coordinator = new MeshCoordinator(graph, bus, resolver)

  return {
    graph,
    bus,
    resolver,
    coordinator,
    destroy() {
      bus.destroy()
      if (persistPath) {
        // Fire-and-forget save on destroy
        graph.saveToFile(persistPath).catch(() => {
          // Ignore save errors during shutdown
        })
      }
    },
  }
}
