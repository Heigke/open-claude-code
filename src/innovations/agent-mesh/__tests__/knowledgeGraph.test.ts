import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { KnowledgeGraph } from '../knowledgeGraph.js'
import type { KnowledgeNode, KnowledgeEdge } from '../knowledgeGraph.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id: 'node-1',
    type: 'file',
    content: 'src/index.ts',
    metadata: {},
    agentId: 'agent-a',
    timestamp: Date.now(),
    confidence: 0.9,
    ...overrides,
  }
}

function makeEdge(overrides: Partial<KnowledgeEdge> = {}): KnowledgeEdge {
  return {
    from: 'node-1',
    to: 'node-2',
    relation: 'depends_on',
    agentId: 'agent-a',
    timestamp: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KnowledgeGraph', () => {
  let graph: KnowledgeGraph

  beforeEach(() => {
    graph = new KnowledgeGraph()
  })

  // ---- Node CRUD --------------------------------------------------------

  describe('addNode / getNode / removeNode', () => {
    it('adds and retrieves a node', async () => {
      const node = makeNode()
      await graph.addNode(node)

      const retrieved = await graph.getNode('node-1')
      expect(retrieved).toEqual(node)
      expect(graph.nodeCount).toBe(1)
    })

    it('overwrites a node with the same id', async () => {
      await graph.addNode(makeNode({ content: 'v1' }))
      await graph.addNode(makeNode({ content: 'v2' }))

      const retrieved = await graph.getNode('node-1')
      expect(retrieved?.content).toBe('v2')
      expect(graph.nodeCount).toBe(1)
    })

    it('removes a node and its edges', async () => {
      await graph.addNode(makeNode({ id: 'node-1' }))
      await graph.addNode(makeNode({ id: 'node-2' }))
      await graph.addEdge(makeEdge({ from: 'node-1', to: 'node-2' }))

      expect(graph.edgeCount).toBe(1)

      const removed = await graph.removeNode('node-1')
      expect(removed).toBe(true)
      expect(graph.nodeCount).toBe(1)
      expect(graph.edgeCount).toBe(0)
    })

    it('returns false when removing a non-existent node', async () => {
      const removed = await graph.removeNode('ghost')
      expect(removed).toBe(false)
    })

    it('returns undefined for non-existent node', async () => {
      const node = await graph.getNode('nope')
      expect(node).toBeUndefined()
    })
  })

  // ---- Edges ------------------------------------------------------------

  describe('addEdge', () => {
    it('adds an edge between existing nodes', async () => {
      await graph.addNode(makeNode({ id: 'a' }))
      await graph.addNode(makeNode({ id: 'b' }))
      await graph.addEdge(makeEdge({ from: 'a', to: 'b' }))

      expect(graph.edgeCount).toBe(1)
    })

    it('throws when source node does not exist', async () => {
      await graph.addNode(makeNode({ id: 'b' }))

      await expect(
        graph.addEdge(makeEdge({ from: 'missing', to: 'b' })),
      ).rejects.toThrow('source node')
    })

    it('throws when target node does not exist', async () => {
      await graph.addNode(makeNode({ id: 'a' }))

      await expect(
        graph.addEdge(makeEdge({ from: 'a', to: 'missing' })),
      ).rejects.toThrow('target node')
    })
  })

  // ---- Query ------------------------------------------------------------

  describe('query', () => {
    beforeEach(async () => {
      await graph.addNode(makeNode({ id: 'f1', type: 'file', content: 'src/app.ts' }))
      await graph.addNode(makeNode({ id: 'f2', type: 'function', content: 'handleRequest' }))
      await graph.addNode(makeNode({ id: 'f3', type: 'api', content: '/api/users' }))
      await graph.addNode(makeNode({ id: 'f4', type: 'file', content: 'src/utils.ts' }))
    })

    it('returns all nodes when no filters', async () => {
      const results = await graph.query()
      expect(results).toHaveLength(4)
    })

    it('filters by type', async () => {
      const results = await graph.query('file')
      expect(results).toHaveLength(2)
      expect(results.every((n) => n.type === 'file')).toBe(true)
    })

    it('filters by pattern', async () => {
      const results = await graph.query(undefined, 'utils')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('f4')
    })

    it('filters by both type and pattern', async () => {
      const results = await graph.query('file', 'app')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('f1')
    })

    it('returns empty for no matches', async () => {
      const results = await graph.query('decision')
      expect(results).toHaveLength(0)
    })
  })

  // ---- getRelated -------------------------------------------------------

  describe('getRelated', () => {
    beforeEach(async () => {
      await graph.addNode(makeNode({ id: 'a' }))
      await graph.addNode(makeNode({ id: 'b' }))
      await graph.addNode(makeNode({ id: 'c' }))
      await graph.addEdge(makeEdge({ from: 'a', to: 'b', relation: 'depends_on' }))
      await graph.addEdge(makeEdge({ from: 'c', to: 'a', relation: 'modifies' }))
    })

    it('returns all related nodes without filter', async () => {
      const related = await graph.getRelated('a')
      expect(related).toHaveLength(2)
      const ids = related.map((n) => n.id).sort()
      expect(ids).toEqual(['b', 'c'])
    })

    it('filters by relation type', async () => {
      const related = await graph.getRelated('a', 'depends_on')
      expect(related).toHaveLength(1)
      expect(related[0]!.id).toBe('b')
    })

    it('returns empty for isolated node', async () => {
      await graph.addNode(makeNode({ id: 'isolated' }))
      const related = await graph.getRelated('isolated')
      expect(related).toHaveLength(0)
    })
  })

  // ---- Conflict detection -----------------------------------------------

  describe('getConflicts', () => {
    it('returns conflict edges', async () => {
      await graph.addNode(makeNode({ id: 'x' }))
      await graph.addNode(makeNode({ id: 'y' }))
      await graph.addEdge(
        makeEdge({ from: 'x', to: 'y', relation: 'conflicts_with' }),
      )
      await graph.addEdge(
        makeEdge({ from: 'x', to: 'y', relation: 'depends_on' }),
      )

      const conflicts = await graph.getConflicts()
      expect(conflicts).toHaveLength(1)
      expect(conflicts[0]!.relation).toBe('conflicts_with')
    })

    it('returns empty when no conflicts', async () => {
      await graph.addNode(makeNode({ id: 'a' }))
      await graph.addNode(makeNode({ id: 'b' }))
      await graph.addEdge(makeEdge({ from: 'a', to: 'b', relation: 'uses' }))

      const conflicts = await graph.getConflicts()
      expect(conflicts).toHaveLength(0)
    })
  })

  // ---- Merge ------------------------------------------------------------

  describe('merge', () => {
    it('adds new nodes from other graph', async () => {
      await graph.addNode(makeNode({ id: 'a', agentId: 'agent-a' }))

      const other = new KnowledgeGraph()
      await other.addNode(makeNode({ id: 'b', agentId: 'agent-b' }))

      const result = await graph.merge(other)
      expect(result.added.nodes).toBe(1)
      expect(result.conflicts).toHaveLength(0)
      expect(graph.nodeCount).toBe(2)
    })

    it('detects conflicts on same-id nodes from different agents', async () => {
      const now = Date.now()
      await graph.addNode(
        makeNode({ id: 'shared', agentId: 'agent-a', timestamp: now }),
      )

      const other = new KnowledgeGraph()
      await other.addNode(
        makeNode({ id: 'shared', agentId: 'agent-b', timestamp: now + 100 }),
      )

      const result = await graph.merge(other)
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.relation).toBe('conflicts_with')

      // Newer version wins
      const node = await graph.getNode('shared')
      expect(node?.agentId).toBe('agent-b')
    })

    it('keeps newer same-agent node without conflict', async () => {
      const now = Date.now()
      await graph.addNode(
        makeNode({ id: 'x', agentId: 'agent-a', timestamp: now, content: 'old' }),
      )

      const other = new KnowledgeGraph()
      await other.addNode(
        makeNode({ id: 'x', agentId: 'agent-a', timestamp: now + 50, content: 'new' }),
      )

      const result = await graph.merge(other)
      expect(result.conflicts).toHaveLength(0)

      const node = await graph.getNode('x')
      expect(node?.content).toBe('new')
    })

    it('merges edges from other graph', async () => {
      await graph.addNode(makeNode({ id: 'a' }))
      await graph.addNode(makeNode({ id: 'b' }))

      const other = new KnowledgeGraph()
      await other.addNode(makeNode({ id: 'a' }))
      await other.addNode(makeNode({ id: 'b' }))
      await other.addEdge(makeEdge({ from: 'a', to: 'b', relation: 'uses' }))

      const result = await graph.merge(other)
      expect(result.added.edges).toBe(1)
      expect(graph.edgeCount).toBe(1)
    })

    it('skips duplicate edges', async () => {
      await graph.addNode(makeNode({ id: 'a' }))
      await graph.addNode(makeNode({ id: 'b' }))
      await graph.addEdge(makeEdge({ from: 'a', to: 'b', relation: 'uses' }))

      const other = new KnowledgeGraph()
      await other.addNode(makeNode({ id: 'a' }))
      await other.addNode(makeNode({ id: 'b' }))
      await other.addEdge(makeEdge({ from: 'a', to: 'b', relation: 'uses' }))

      const result = await graph.merge(other)
      expect(result.added.edges).toBe(0)
      expect(graph.edgeCount).toBe(1)
    })
  })

  // ---- Serialization ----------------------------------------------------

  describe('serialize / deserialize', () => {
    it('round-trips through JSON', async () => {
      await graph.addNode(makeNode({ id: 'a' }))
      await graph.addNode(makeNode({ id: 'b' }))
      await graph.addEdge(makeEdge({ from: 'a', to: 'b' }))

      const json = await graph.serialize()
      const restored = KnowledgeGraph.deserialize(json)

      expect(restored.nodeCount).toBe(2)
      expect(restored.edgeCount).toBe(1)

      const nodeA = await restored.getNode('a')
      expect(nodeA?.id).toBe('a')
    })

    it('throws on unsupported version', () => {
      const bad = JSON.stringify({ version: 99, nodes: [], edges: [] })
      expect(() => KnowledgeGraph.deserialize(bad)).toThrow(
        'Unsupported knowledge graph version',
      )
    })
  })

  // ---- File persistence -------------------------------------------------

  describe('saveToFile / loadFromFile', () => {
    const testDir = join(tmpdir(), 'agent-mesh-test-' + process.pid)
    const testFile = join(testDir, 'graph.json')

    afterEach(() => {
      try {
        if (existsSync(testFile)) unlinkSync(testFile)
      } catch {
        // ignore cleanup errors
      }
    })

    it('saves and loads from disk', async () => {
      await graph.addNode(makeNode({ id: 'disk-node' }))
      await graph.saveToFile(testFile)

      expect(existsSync(testFile)).toBe(true)

      const loaded = KnowledgeGraph.loadFromFile(testFile)
      expect(loaded.nodeCount).toBe(1)
      const node = await loaded.getNode('disk-node')
      expect(node?.id).toBe('disk-node')
    })

    it('returns empty graph when file does not exist', () => {
      const loaded = KnowledgeGraph.loadFromFile('/tmp/nonexistent-graph-42.json')
      expect(loaded.nodeCount).toBe(0)
    })
  })

  // ---- Concurrent access ------------------------------------------------

  describe('concurrent access', () => {
    it('handles concurrent addNode calls safely', async () => {
      const promises: Promise<void>[] = []
      for (let i = 0; i < 100; i++) {
        promises.push(
          graph.addNode(
            makeNode({ id: `concurrent-${i}`, agentId: `agent-${i % 5}` }),
          ),
        )
      }

      await Promise.all(promises)
      expect(graph.nodeCount).toBe(100)
    })

    it('handles concurrent add and remove safely', async () => {
      // Pre-populate
      for (let i = 0; i < 20; i++) {
        await graph.addNode(makeNode({ id: `cr-${i}` }))
      }

      // Concurrently add new nodes and remove existing ones
      const ops: Promise<unknown>[] = []
      for (let i = 0; i < 20; i++) {
        ops.push(graph.addNode(makeNode({ id: `new-${i}` })))
        ops.push(graph.removeNode(`cr-${i}`))
      }

      await Promise.all(ops)

      // All original nodes removed, all new nodes added
      expect(graph.nodeCount).toBe(20)
      for (let i = 0; i < 20; i++) {
        expect(await graph.getNode(`cr-${i}`)).toBeUndefined()
        expect(await graph.getNode(`new-${i}`)).toBeDefined()
      }
    })

    it('handles concurrent queries during mutations', async () => {
      const ops: Promise<unknown>[] = []

      for (let i = 0; i < 50; i++) {
        ops.push(graph.addNode(makeNode({ id: `q-${i}`, type: 'file' })))
        ops.push(graph.query('file'))
      }

      // Should not throw or deadlock
      const results = await Promise.all(ops)
      expect(results.length).toBe(100)
    })
  })
})
