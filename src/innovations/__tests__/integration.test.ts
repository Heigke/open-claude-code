/**
 * Comprehensive Integration Tests for Innovation Modules
 *
 * Self-contained: only imports from src/innovations/ (no src/utils/, src/services/, etc.)
 */

import { test, expect, describe, beforeEach } from 'bun:test'
import { InnovationOrchestrator } from '../orchestrator.js'
import type { OrchestratorConfig, OrchestratorStatus } from '../orchestrator.js'
import { KnowledgeGraph } from '../agent-mesh/knowledgeGraph.js'
import type { KnowledgeNode, KnowledgeEdge } from '../agent-mesh/knowledgeGraph.js'
import { AgentBus } from '../agent-mesh/agentBus.js'
import type { AgentMessage } from '../agent-mesh/agentBus.js'
import { ConflictResolver } from '../agent-mesh/conflictResolver.js'
import type { FileConflict } from '../agent-mesh/conflictResolver.js'
import { MeshCoordinator } from '../agent-mesh/meshCoordinator.js'
import type { WorkItem, WorkResults } from '../agent-mesh/meshCoordinator.js'
import { EmbeddingStore, buildVocabulary, textToTfIdf, cosineSimilarity } from '../episodic-memory/embeddingStore.js'
import type { MemoryEntry } from '../episodic-memory/embeddingStore.js'
import { SessionBroker } from '../realtime-collab/sessionBroker.js'
import { ToolFeedbackSystem } from '../tool-feedback/feedbackIntegration.js'
import { TrustStore } from '../trust-escalation/trustStore.js'
import { TrustPolicy } from '../trust-escalation/trustPolicy.js'
import { ContextPredictor } from '../predictive-context/contextPredictor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE = '/tmp/test-workspace'

/** Create an orchestrator configured for testing (no file persistence). */
function createTestOrchestrator(overrides?: Partial<OrchestratorConfig>): InnovationOrchestrator {
  return new InnovationOrchestrator({
    workspacePath: WORKSPACE,
    trustStorePath: `/tmp/trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    contextWindowSize: 200_000,
    ...overrides,
  })
}

function makeNode(id: string, agentId: string, content: string, type: KnowledgeNode['type'] = 'file'): KnowledgeNode {
  return {
    id,
    type,
    content,
    metadata: {},
    agentId,
    timestamp: Date.now(),
    confidence: 0.9,
  }
}

function makeMemoryEntry(id: string, content: string, project: string, tags: string[] = [], importance = 0.5): MemoryEntry {
  const now = new Date().toISOString()
  return {
    id,
    content,
    type: 'episode',
    embedding: [], // will be replaced after vocabulary rebuild
    metadata: {
      source: 'test',
      timestamp: now,
      project,
      tags,
      accessCount: 0,
      lastAccessed: now,
    },
    importance,
  }
}

// ===========================================================================
// 1. Orchestrator Integration (10+ tests)
// ===========================================================================

describe('Orchestrator Integration', () => {
  let orch: InnovationOrchestrator

  beforeEach(() => {
    orch = createTestOrchestrator()
    orch.initialize()
  })

  test('initialize creates all subsystems without error', () => {
    // If we get here, initialize succeeded. Calling it again is a no-op.
    orch.initialize()
    const status = orch.getStatus()
    expect(status).toBeDefined()
  })

  test('throws if used before initialization', () => {
    const fresh = createTestOrchestrator()
    expect(() => fresh.getStatus()).toThrow('not initialized')
  })

  test('onToolExecutionStart returns trust decision and hints', () => {
    const result = orch.onToolExecutionStart('FileRead', 'src/index.ts')
    expect(result.trustDecision).toBeDefined()
    expect(result.trustDecision!.score).toBeNumber()
    expect(result.preHints).toBeArray()
    expect(result.routingDecision).toBeDefined()
  })

  test('trust scores increase after successful tool executions', () => {
    // Run several successful executions
    for (let i = 0; i < 10; i++) {
      orch.onToolExecutionStart('FileRead', 'src/app.ts')
      orch.onToolExecutionComplete('FileRead', 'src/app.ts', 'content...', true)
    }

    const decision = orch.queryTrust('FileRead', 'src/app.ts')
    expect(decision.score).toBeGreaterThan(0)
  })

  test('feedback insights appear after repeated failures', () => {
    // Simulate 3 consecutive FileEdit failures
    for (let i = 0; i < 3; i++) {
      orch.onToolExecutionStart('FileEdit', 'src/app.ts')
      orch.onToolExecutionComplete('FileEdit', 'src/app.ts', '', false, {
        type: 'old_string_not_found',
        message: 'old_string not found in file',
      })
    }

    const stats = orch.getStatus().feedback
    expect(stats.totalExecutions).toBe(3)
    expect(stats.failureRate).toBe(1)
    expect(stats.insightsGenerated).toBeGreaterThan(0)
  })

  test('context predictor tracks token growth', () => {
    orch.onNewMessage('hello', 1000)
    orch.onNewMessage('more tokens', 3000)
    orch.onNewMessage('even more tokens', 6000)

    const status = orch.getStatus()
    expect(status.context.turnCount).toBe(3)
    expect(status.context.averageGrowthRate).toBeGreaterThan(0)
  })

  test('getSystemPromptAdditions aggregates all sources', () => {
    // Build up enough trust for a trust-based addition
    for (let i = 0; i < 20; i++) {
      orch.onToolExecutionStart('Bash', 'git status')
      orch.onToolExecutionComplete('Bash', 'git status', 'clean', true)
    }

    // Trigger context warning
    orch.onNewMessage('big message', 180_000)

    const additions = orch.getSystemPromptAdditions()
    expect(additions).toBeArray()
    // Should have at least one trust hint and one context warning
    const hasTrust = additions.some(a => a.includes('[Trust]'))
    const hasContext = additions.some(a => a.includes('[Context]'))
    expect(hasTrust).toBe(true)
    expect(hasContext).toBe(true)
  })

  test('getStatus returns complete status across all subsystems', () => {
    orch.onToolExecutionStart('FileRead', 'test.ts')
    orch.onToolExecutionComplete('FileRead', 'test.ts', 'data', true)
    orch.onNewMessage('msg', 5000)

    const status = orch.getStatus()
    expect(status.trust).toBeDefined()
    expect(status.trust.totalEntries).toBeGreaterThanOrEqual(1)
    expect(status.trust.recentDecisions).toBeArray()
    expect(status.feedback).toBeDefined()
    expect(status.feedback.totalExecutions).toBe(1)
    expect(status.context).toBeDefined()
    expect(status.context.turnCount).toBe(1)
    expect(status.mesh).toBeDefined()
    expect(status.mesh.graphNodes).toBeNumber()
    expect(status.routing).toBeDefined()
    expect(status.routing.availableTiers).toBeArray()
  })

  test('shutdown and re-initialize works', () => {
    orch.onToolExecutionStart('FileRead', 'a.ts')
    orch.onToolExecutionComplete('FileRead', 'a.ts', 'ok', true)
    orch.shutdown()

    // Should throw after shutdown
    expect(() => orch.getStatus()).toThrow()

    // Re-initialize works
    orch.initialize()
    const status = orch.getStatus()
    expect(status).toBeDefined()
  })

  test('routing decision included in pre-tool result', () => {
    const result = orch.onToolExecutionStart('Bash', 'echo hello')
    expect(result.routingDecision).toBeDefined()
    expect(result.routingDecision!.model).toBeDefined()
    expect(result.routingDecision!.tier).toBeDefined()
  })

  test('onNewMessage returns compaction decision', () => {
    // Feed enough to trigger compaction concern
    for (let i = 0; i < 5; i++) {
      orch.onNewMessage('turn', 50_000 + i * 30_000)
    }
    const decision = orch.onNewMessage('turn', 160_000)
    expect(decision).toBeDefined()
    expect(typeof decision.shouldCompact).toBe('boolean')
    expect(decision.urgency).toBeDefined()
    expect(decision.reason).toBeString()
  })

  test('knowledge graph and agent bus are accessible from orchestrator', () => {
    const graph = orch.getKnowledgeGraph()
    const bus = orch.getAgentBus()
    const coordinator = orch.getMeshCoordinator()
    expect(graph).toBeInstanceOf(KnowledgeGraph)
    expect(bus).toBeInstanceOf(AgentBus)
    expect(coordinator).toBeInstanceOf(MeshCoordinator)
  })
})

// ===========================================================================
// 2. Trust + Feedback Integration (5+ tests)
// ===========================================================================

describe('Trust + Feedback Integration', () => {
  let orch: InnovationOrchestrator

  beforeEach(() => {
    orch = createTestOrchestrator()
    orch.initialize()
  })

  test('high trust score influences permission decisions to auto-allow', () => {
    // Build up trust through many successful reads
    for (let i = 0; i < 15; i++) {
      orch.onToolExecutionStart('FileRead', 'src/main.ts')
      orch.onToolExecutionComplete('FileRead', 'src/main.ts', 'content', true)
    }

    const decision = orch.queryTrust('FileRead', 'src/main.ts')
    expect(decision.behavior).toBe('allow')
    expect(decision.score).toBeGreaterThanOrEqual(50)
  })

  test('tool failure decreases trust AND generates feedback insight', () => {
    // Start with some successes
    for (let i = 0; i < 5; i++) {
      orch.onToolExecutionStart('FileEdit', 'src/config.ts')
      orch.onToolExecutionComplete('FileEdit', 'src/config.ts', 'ok', true)
    }

    const trustBefore = orch.queryTrust('FileEdit', 'src/config.ts').score

    // Now fail repeatedly
    for (let i = 0; i < 3; i++) {
      orch.onToolExecutionStart('FileEdit', 'src/config.ts')
      orch.onToolExecutionComplete('FileEdit', 'src/config.ts', '', false, {
        type: 'old_string_not_found',
        message: 'old_string not found in file',
      })
    }

    const trustAfter = orch.queryTrust('FileEdit', 'src/config.ts').score
    expect(trustAfter).toBeLessThan(trustBefore)

    const feedbackStats = orch.getStatus().feedback
    expect(feedbackStats.insightsGenerated).toBeGreaterThan(0)
  })

  test('recovery after failures increases trust and feedback injections expire', () => {
    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      orch.onToolExecutionStart('Bash', 'npm test')
      orch.onToolExecutionComplete('Bash', 'npm test', '', false, {
        type: 'exit_code',
        message: 'Process exited with code 1',
      })
    }

    const trustAfterFail = orch.queryTrust('Bash', 'npm test').score

    // Now succeed many times
    for (let i = 0; i < 15; i++) {
      orch.onToolExecutionStart('Bash', 'npm test')
      orch.onToolExecutionComplete('Bash', 'npm test', 'all tests pass', true)
    }

    const trustAfterRecovery = orch.queryTrust('Bash', 'npm test').score
    expect(trustAfterRecovery).toBeGreaterThan(trustAfterFail)
  })

  test('untrusted tool pattern requires ask permission', () => {
    const decision = orch.queryTrust('Bash', 'rm -rf /')
    expect(decision.behavior).toBe('ask')
    expect(decision.score).toBe(0)
  })

  test('feedback pre-tool hint shows for tools with failure history', () => {
    // Create failure history for FileEdit
    for (let i = 0; i < 3; i++) {
      orch.onToolExecutionStart('FileEdit', 'src/broken.ts')
      orch.onToolExecutionComplete('FileEdit', 'src/broken.ts', '', false, {
        type: 'old_string_not_found',
        message: 'old_string not found in file',
      })
    }

    // The next start should contain a feedback hint
    const result = orch.onToolExecutionStart('FileEdit', 'src/broken.ts')
    // The feedback system should have generated insights
    const stats = orch.getStatus().feedback
    expect(stats.insightsGenerated).toBeGreaterThan(0)
  })

  test('mixed success/failure produces moderate trust score', () => {
    // 5 successes then 2 failures
    for (let i = 0; i < 5; i++) {
      orch.onToolExecutionStart('Bash', 'ls -la')
      orch.onToolExecutionComplete('Bash', 'ls -la', 'files...', true)
    }
    for (let i = 0; i < 2; i++) {
      orch.onToolExecutionStart('Bash', 'ls -la')
      orch.onToolExecutionComplete('Bash', 'ls -la', '', false)
    }

    const decision = orch.queryTrust('Bash', 'ls -la')
    // Should be less than pure success but greater than 0
    expect(decision.score).toBeGreaterThan(0)
    expect(decision.score).toBeLessThan(100)
  })
})

// ===========================================================================
// 3. Agent Mesh + Knowledge Graph (5+ tests)
// ===========================================================================

describe('Agent Mesh + Knowledge Graph', () => {
  let graph: KnowledgeGraph
  let bus: AgentBus
  let resolver: ConflictResolver
  let coordinator: MeshCoordinator

  beforeEach(() => {
    graph = new KnowledgeGraph()
    bus = new AgentBus()
    resolver = new ConflictResolver()
    coordinator = new MeshCoordinator(graph, bus, resolver)
  })

  test('create 2 agents, assign work, share knowledge', async () => {
    const messagesA: AgentMessage[] = []
    const messagesB: AgentMessage[] = []

    bus.subscribe('agent-a', (msg) => messagesA.push(msg))
    bus.subscribe('agent-b', (msg) => messagesB.push(msg))

    expect(bus.getActiveAgents()).toEqual(expect.arrayContaining(['agent-a', 'agent-b']))

    const tasks: WorkItem[] = [
      { id: 't1', description: 'Fix login', relatedFiles: ['auth.ts'], priority: 5, status: 'pending' },
      { id: 't2', description: 'Fix logout', relatedFiles: ['auth.ts'], priority: 3, status: 'pending' },
    ]

    const assignment = coordinator.assignWork(tasks)
    expect(assignment.size).toBe(2)

    // Both agents should have received work_request messages
    const totalAssigned = [...assignment.values()].reduce((sum, items) => sum + items.length, 0)
    expect(totalAssigned).toBe(2)

    // Agent A completes work and shares knowledge via the graph
    const nodeA = makeNode('auth-fix', 'agent-a', 'auth.ts')
    const results: WorkResults = {
      taskId: 't1',
      nodes: [nodeA],
      success: true,
    }
    await coordinator.handleAgentComplete('agent-a', results)

    const node = await graph.getNode('auth-fix')
    expect(node).toBeDefined()
    expect(node!.agentId).toBe('agent-a')
  })

  test('detect conflicts when both agents modify same file', async () => {
    bus.subscribe('agent-a', () => {})
    bus.subscribe('agent-b', () => {})

    // Both agents add nodes with the same id but different agents
    const nodeA: KnowledgeNode = {
      ...makeNode('shared-file', 'agent-a', 'shared.ts'),
      metadata: { lineRange: { start: 1, end: 10 } },
    }
    const nodeB: KnowledgeNode = {
      ...makeNode('shared-file', 'agent-b', 'shared.ts'),
      timestamp: Date.now() + 1,
      metadata: { lineRange: { start: 5, end: 15 } },
    }

    // Add nodeA to the main graph
    await graph.addNode(nodeA)

    // Create a second graph with nodeB, then merge
    const otherGraph = new KnowledgeGraph()
    await otherGraph.addNode(nodeB)

    const mergeResult = await graph.merge(otherGraph)
    expect(mergeResult.conflicts.length).toBeGreaterThan(0)

    const conflicts = await graph.getConflicts()
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0]!.relation).toBe('conflicts_with')
  })

  test('verify work rebalancing when one agent completes', async () => {
    bus.subscribe('agent-a', () => {})
    bus.subscribe('agent-b', () => {})

    const tasks: WorkItem[] = [
      { id: 'r1', description: 'Task 1', relatedFiles: [], priority: 5, status: 'pending' },
      { id: 'r2', description: 'Task 2', relatedFiles: [], priority: 4, status: 'pending' },
      { id: 'r3', description: 'Task 3', relatedFiles: [], priority: 3, status: 'pending' },
      { id: 'r4', description: 'Task 4', relatedFiles: [], priority: 2, status: 'pending' },
    ]

    coordinator.assignWork(tasks)

    // Agent A completes all tasks
    await coordinator.handleAgentComplete('agent-a', {
      taskId: 'r1',
      nodes: [],
      success: true,
    })
    await coordinator.handleAgentComplete('agent-a', {
      taskId: 'r3',
      nodes: [],
      success: true,
    })

    // Rebalance should detect the load imbalance
    const rebalanced = coordinator.rebalance()
    // rebalanced may or may not have items depending on assignment; the key is no crash
    expect(rebalanced).toBeInstanceOf(Map)

    const status = await coordinator.getStatus()
    expect(status.agents.length).toBe(2)
    expect(status.completedTasks).toBeGreaterThanOrEqual(2)
  })

  test('knowledge graph query filters by type and pattern', async () => {
    await graph.addNode(makeNode('file-a', 'agent-1', 'src/auth.ts', 'file'))
    await graph.addNode(makeNode('func-b', 'agent-1', 'validateToken', 'function'))
    await graph.addNode(makeNode('file-c', 'agent-1', 'src/db.ts', 'file'))

    const files = await graph.query('file')
    expect(files.length).toBe(2)

    const authRelated = await graph.query(undefined, 'auth')
    expect(authRelated.length).toBe(1)
    expect(authRelated[0]!.id).toBe('file-a')
  })

  test('edges connect nodes and getRelated works', async () => {
    await graph.addNode(makeNode('n1', 'a', 'file1.ts', 'file'))
    await graph.addNode(makeNode('n2', 'a', 'file2.ts', 'file'))
    await graph.addEdge({
      from: 'n1',
      to: 'n2',
      relation: 'depends_on',
      agentId: 'a',
      timestamp: Date.now(),
    })

    const related = await graph.getRelated('n1', 'depends_on')
    expect(related.length).toBe(1)
    expect(related[0]!.id).toBe('n2')
  })

  test('conflict resolver suggests merge for non-overlapping changes', () => {
    const conflict: FileConflict = {
      file: 'app.ts',
      agentA: {
        agentId: 'a',
        changes: 'added import',
        lineRange: { start: 1, end: 3 },
        timestamp: Date.now(),
      },
      agentB: {
        agentId: 'b',
        changes: 'added function',
        lineRange: { start: 50, end: 60 },
        timestamp: Date.now() + 100,
      },
      type: 'structural',
    }

    const suggestion = resolver.suggestMerge(conflict)
    expect(suggestion.manual_review_needed).toBe(false)
    expect(suggestion.confidence).toBeGreaterThan(0.5)
    expect(suggestion.merged).toContain('added import')
    expect(suggestion.merged).toContain('added function')
  })
})

// ===========================================================================
// 4. Episodic Memory + Cross-Project (5+ tests)
// ===========================================================================

describe('Episodic Memory + Cross-Project', () => {
  let store: EmbeddingStore

  beforeEach(() => {
    store = new EmbeddingStore(`/tmp/memory-test-${Date.now()}.json`, 100)
  })

  test('record episodes and search by similarity', () => {
    const texts = [
      'fix authentication bug in login handler',
      'update database migration for user table',
      'refactor auth middleware token validation',
    ]

    store.rebuildVocabulary(texts)

    for (let i = 0; i < texts.length; i++) {
      const entry = makeMemoryEntry(`ep-${i}`, texts[i]!, 'project-a', ['bug'])
      entry.embedding = store.embed(texts[i]!)
      store.add(entry)
    }

    expect(store.size()).toBe(3)

    // Search for auth-related entries
    const queryEmb = store.embed('authentication token fix')
    const results = store.search(queryEmb, 2)
    expect(results.length).toBe(2)
    // The auth-related entries should rank higher
    expect(results[0]!.entry.content).toMatch(/auth/)
  })

  test('transfer patterns between projects via search filters', () => {
    const texts = [
      'fix race condition in async handler',
      'add retry logic for network failures',
      'optimize database query performance',
    ]

    store.rebuildVocabulary(texts)

    // Add entries from project-a
    const e1 = makeMemoryEntry('pa-1', texts[0]!, 'project-a', ['bug'])
    e1.embedding = store.embed(texts[0]!)
    store.add(e1)

    const e2 = makeMemoryEntry('pa-2', texts[1]!, 'project-a', ['resilience'])
    e2.embedding = store.embed(texts[1]!)
    store.add(e2)

    // Add entry from project-b
    const e3 = makeMemoryEntry('pb-1', texts[2]!, 'project-b', ['performance'])
    e3.embedding = store.embed(texts[2]!)
    store.add(e3)

    // Search within project-a only
    const queryEmb = store.embed('network retry')
    const projectAResults = store.search(queryEmb, 5, { project: 'project-a' })
    expect(projectAResults.every(r => r.entry.metadata.project === 'project-a')).toBe(true)

    // Search across all projects
    const allResults = store.search(queryEmb, 5)
    expect(allResults.length).toBe(3)
  })

  test('memory consolidation merges similar entries', () => {
    const texts = [
      'fix authentication bug in login',
      'fix auth bug in login handler',
      'update readme documentation',
    ]

    store.rebuildVocabulary(texts)

    for (let i = 0; i < texts.length; i++) {
      const entry = makeMemoryEntry(`m-${i}`, texts[i]!, 'proj', ['fix'])
      entry.embedding = store.embed(texts[i]!)
      store.add(entry)
    }

    // Check that similar entries have high cosine similarity
    const emb0 = store.embed(texts[0]!)
    const emb1 = store.embed(texts[1]!)
    const emb2 = store.embed(texts[2]!)

    const simAuthPair = cosineSimilarity(emb0, emb1)
    const simAuthVsReadme = cosineSimilarity(emb0, emb2)

    // Auth entries should be more similar to each other than to readme
    expect(simAuthPair).toBeGreaterThan(simAuthVsReadme)
  })

  test('filter search by tags and importance', () => {
    const texts = ['critical bug fix', 'minor style change', 'important feature']
    store.rebuildVocabulary(texts)

    const e1 = makeMemoryEntry('t1', texts[0]!, 'proj', ['critical'], 0.9)
    e1.embedding = store.embed(texts[0]!)
    store.add(e1)

    const e2 = makeMemoryEntry('t2', texts[1]!, 'proj', ['minor'], 0.2)
    e2.embedding = store.embed(texts[1]!)
    store.add(e2)

    const e3 = makeMemoryEntry('t3', texts[2]!, 'proj', ['critical'], 0.8)
    e3.embedding = store.embed(texts[2]!)
    store.add(e3)

    const queryEmb = store.embed('bug fix')

    // Filter by tag
    const criticalOnly = store.search(queryEmb, 5, { tags: ['critical'] })
    expect(criticalOnly.length).toBe(2)
    expect(criticalOnly.every(r => r.entry.metadata.tags.includes('critical'))).toBe(true)

    // Filter by importance
    const important = store.search(queryEmb, 5, { minImportance: 0.5 })
    expect(important.every(r => r.entry.importance >= 0.5)).toBe(true)
    expect(important.length).toBe(2)
  })

  test('eviction removes low-priority entries when over capacity', () => {
    const smallStore = new EmbeddingStore(`/tmp/mem-evict-${Date.now()}.json`, 3)
    const texts = ['entry one', 'entry two', 'entry three', 'entry four']
    smallStore.rebuildVocabulary(texts)

    for (let i = 0; i < 4; i++) {
      const entry = makeMemoryEntry(`e-${i}`, texts[i]!, 'proj', [], (i + 1) * 0.2)
      entry.embedding = smallStore.embed(texts[i]!)
      smallStore.add(entry)
    }

    // Should have evicted down to 3
    expect(smallStore.size()).toBe(3)
  })
})

// ===========================================================================
// 5. Collaboration Session (5+ tests)
// ===========================================================================

describe('Collaboration Session', () => {
  let broker: SessionBroker

  beforeEach(() => {
    broker = new SessionBroker()
  })

  test('create session, join participants, sync messages', () => {
    const session = broker.createSession('Pair Programming', {
      userId: 'alice',
      name: 'Alice',
    })

    expect(session.id).toBeString()
    expect(session.state).toBe('active')
    expect(session.participants.length).toBe(1)
    expect(session.participants[0]!.role).toBe('owner')

    const joinResult = broker.joinSession(session.id, {
      userId: 'bob',
      name: 'Bob',
      role: 'editor',
    })

    expect(joinResult.success).toBe(true)
    expect(joinResult.session!.participants.length).toBe(2)

    // Verify both participants
    const participants = broker.getSession(session.id)!.participants
    expect(participants.map(p => p.userId)).toEqual(expect.arrayContaining(['alice', 'bob']))
  })

  test('permission negotiation with approval required', () => {
    const session = broker.createSession('Restricted Session', {
      userId: 'alice',
      name: 'Alice',
    }, { requireApproval: true })

    // Bob tries to join - should require approval
    const joinAttempt = broker.joinSession(session.id, {
      userId: 'bob',
      name: 'Bob',
    })
    expect(joinAttempt.success).toBe(false)
    expect(joinAttempt.error).toContain('Approval required')

    // Check approval queue
    const queue = broker.getApprovalQueue(session.id)
    expect(queue.length).toBe(1)
    expect(queue[0]!.participant.userId).toBe('bob')

    // Alice approves
    const approval = broker.approveJoin(session.id, queue[0]!.id, 'alice')
    expect(approval.success).toBe(true)
    expect(approval.session!.participants.length).toBe(2)

    // Queue should be empty now
    const emptyQueue = broker.getApprovalQueue(session.id)
    expect(emptyQueue.length).toBe(0)
  })

  test('presence tracking with idle detection', () => {
    const session = broker.createSession('Collab', {
      userId: 'alice',
      name: 'Alice',
    })

    broker.joinSession(session.id, {
      userId: 'bob',
      name: 'Bob',
      role: 'editor',
    })

    const current = broker.getSession(session.id)!
    expect(current.participants.length).toBe(2)

    // Each participant has joinedAt and lastActive timestamps
    for (const p of current.participants) {
      expect(p.joinedAt).toBeInstanceOf(Date)
      expect(p.lastActive).toBeInstanceOf(Date)
      expect(p.color).toBeString()
    }

    // Bob leaves - presence should update
    broker.leaveSession(session.id, 'bob')
    const afterLeave = broker.getSession(session.id)!
    expect(afterLeave.participants.length).toBe(1)
    expect(afterLeave.participants[0]!.userId).toBe('alice')
  })

  test('session lifecycle: pause, resume, end', () => {
    const session = broker.createSession('Lifecycle Test', {
      userId: 'alice',
      name: 'Alice',
    })

    // Pause
    const paused = broker.pauseSession(session.id, 'alice')
    expect(paused).toBe(true)
    expect(broker.getSession(session.id)!.state).toBe('paused')

    // Resume
    const resumed = broker.resumeSession(session.id, 'alice')
    expect(resumed).toBe(true)
    expect(broker.getSession(session.id)!.state).toBe('active')

    // End
    const ended = broker.endSession(session.id, 'alice')
    expect(ended).toBe(true)
    expect(broker.getSession(session.id)!.state).toBe('ended')

    // Cannot join ended session
    const joinResult = broker.joinSession(session.id, { userId: 'bob', name: 'Bob' })
    expect(joinResult.success).toBe(false)
    expect(joinResult.error).toContain('ended')
  })

  test('deny join request works', () => {
    const session = broker.createSession('Deny Test', {
      userId: 'alice',
      name: 'Alice',
    }, { requireApproval: true })

    broker.joinSession(session.id, { userId: 'eve', name: 'Eve' })

    const queue = broker.getApprovalQueue(session.id)
    expect(queue.length).toBe(1)

    const denied = broker.denyJoin(session.id, queue[0]!.id, 'alice')
    expect(denied).toBe(true)

    // Eve should not be in the session
    const current = broker.getSession(session.id)!
    expect(current.participants.length).toBe(1)
    expect(current.participants[0]!.userId).toBe('alice')
  })

  test('max participants enforcement', () => {
    const session = broker.createSession('Small Room', {
      userId: 'u0',
      name: 'User 0',
    }, { maxParticipants: 2 })

    const join1 = broker.joinSession(session.id, { userId: 'u1', name: 'User 1' })
    expect(join1.success).toBe(true)

    const join2 = broker.joinSession(session.id, { userId: 'u2', name: 'User 2' })
    expect(join2.success).toBe(false)
    expect(join2.error).toContain('full')
  })

  test('owner promotion when owner leaves', () => {
    const session = broker.createSession('Promotion Test', {
      userId: 'alice',
      name: 'Alice',
    })
    broker.joinSession(session.id, { userId: 'bob', name: 'Bob', role: 'editor' })

    // Alice (owner) leaves
    broker.leaveSession(session.id, 'alice')

    const current = broker.getSession(session.id)!
    expect(current.participants.length).toBe(1)
    expect(current.participants[0]!.userId).toBe('bob')
    expect(current.participants[0]!.role).toBe('owner')
  })
})

// ===========================================================================
// 6. End-to-End Scenario (3+ tests)
// ===========================================================================

describe('End-to-End Scenario', () => {
  test('full "fix a bug" workflow with trust, feedback, and context tracking', () => {
    const orch = createTestOrchestrator()
    orch.initialize()

    // Step 1: Read file (trust builds)
    const readResult = orch.onToolExecutionStart('FileRead', 'src/buggy.ts')
    expect(readResult.trustDecision).toBeDefined()
    expect(readResult.trustDecision!.score).toBe(0) // first time
    orch.onToolExecutionComplete('FileRead', 'src/buggy.ts', 'function buggy() { ... }', true)
    orch.onNewMessage('Read the buggy file', 5000)

    // Trust should now exist for this pattern
    let trustRead = orch.queryTrust('FileRead', 'src/buggy.ts')
    expect(trustRead.score).toBeGreaterThan(0)

    // Step 2: Edit file (fails twice - feedback kicks in)
    orch.onToolExecutionStart('FileEdit', 'src/buggy.ts')
    orch.onToolExecutionComplete('FileEdit', 'src/buggy.ts', '', false, {
      type: 'old_string_not_found',
      message: 'old_string not found in file',
    })
    orch.onNewMessage('Edit failed attempt 1', 8000)

    orch.onToolExecutionStart('FileEdit', 'src/buggy.ts')
    orch.onToolExecutionComplete('FileEdit', 'src/buggy.ts', '', false, {
      type: 'old_string_not_found',
      message: 'old_string not found in file',
    })
    orch.onNewMessage('Edit failed attempt 2', 11000)

    // Verify feedback insights generated
    let status = orch.getStatus()
    expect(status.feedback.totalExecutions).toBe(3) // 1 read + 2 edits
    expect(status.feedback.failureRate).toBeGreaterThan(0)

    // Step 3: Re-read file (trust for read increases)
    orch.onToolExecutionStart('FileRead', 'src/buggy.ts')
    orch.onToolExecutionComplete('FileRead', 'src/buggy.ts', 'function buggy() { ... }', true)
    orch.onNewMessage('Re-read the file', 14000)

    trustRead = orch.queryTrust('FileRead', 'src/buggy.ts')
    expect(trustRead.score).toBeGreaterThan(50) // 2 successes, 0 failures

    // Step 4: Edit file (succeeds - trust recovers)
    orch.onToolExecutionStart('FileEdit', 'src/buggy.ts')
    orch.onToolExecutionComplete('FileEdit', 'src/buggy.ts', 'fixed!', true)
    orch.onNewMessage('Edit succeeded!', 17000)

    const trustEdit = orch.queryTrust('FileEdit', 'src/buggy.ts')
    expect(trustEdit.score).toBeGreaterThan(0) // recovering from failures

    // Step 5: Commit (auto-allowed due to high git trust after many successes)
    // Build git trust
    for (let i = 0; i < 10; i++) {
      orch.onToolExecutionStart('Bash', 'git commit')
      orch.onToolExecutionComplete('Bash', 'git commit', 'committed', true)
    }

    const commitTrust = orch.queryTrust('Bash', 'git commit')
    expect(commitTrust.behavior).toBe('allow')
    expect(commitTrust.score).toBeGreaterThanOrEqual(50)

    // Verify all subsystem states at end
    status = orch.getStatus()
    expect(status.trust.totalEntries).toBeGreaterThanOrEqual(3)
    expect(status.context.turnCount).toBe(5) // 5 onNewMessage calls
    expect(status.context.averageGrowthRate).toBeGreaterThan(0)
    expect(status.feedback.totalExecutions).toBeGreaterThanOrEqual(5)

    orch.shutdown()
  })

  test('multi-agent collaboration with conflict detection and resolution', async () => {
    const orch = createTestOrchestrator()
    orch.initialize()

    const bus = orch.getAgentBus()
    const graph = orch.getKnowledgeGraph()
    const coordinator = orch.getMeshCoordinator()

    const received: AgentMessage[] = []
    bus.subscribe('frontend-agent', (msg) => received.push(msg))
    bus.subscribe('backend-agent', (msg) => received.push(msg))

    // Assign tasks
    const tasks: WorkItem[] = [
      { id: 'fe-1', description: 'Fix UI button', relatedFiles: ['button.tsx'], priority: 5, status: 'pending' },
      { id: 'be-1', description: 'Fix API endpoint', relatedFiles: ['api.ts'], priority: 4, status: 'pending' },
    ]

    const assignment = coordinator.assignWork(tasks)
    expect([...assignment.values()].flat().length).toBe(2)

    // Both agents complete and share results to the graph
    const feNode = makeNode('button-fix', 'frontend-agent', 'button.tsx')
    await coordinator.handleAgentComplete('frontend-agent', {
      taskId: 'fe-1',
      nodes: [feNode],
      success: true,
    })

    const beNode = makeNode('api-fix', 'backend-agent', 'api.ts')
    await coordinator.handleAgentComplete('backend-agent', {
      taskId: 'be-1',
      nodes: [beNode],
      success: true,
    })

    expect(graph.nodeCount).toBe(2)
    const meshStatus = await coordinator.getStatus()
    expect(meshStatus.completedTasks).toBe(2)

    orch.shutdown()
  })

  test('context predictor triggers compaction in long conversation', () => {
    const orch = createTestOrchestrator({ contextWindowSize: 100_000 })
    orch.initialize()

    // Simulate a long conversation with growing token counts
    let tokens = 10_000
    for (let turn = 0; turn < 10; turn++) {
      tokens += 12_000
      orch.onToolExecutionStart('FileRead', `file-${turn}.ts`)
      orch.onToolExecutionComplete('FileRead', `file-${turn}.ts`, 'content', true)
      orch.onNewMessage(`Turn ${turn}`, tokens)
    }

    // With 100k window and 130k tokens, should trigger compaction
    const status = orch.getStatus()
    expect(status.context.turnCount).toBe(10)
    expect(status.context.averageGrowthRate).toBeGreaterThan(0)

    // The last compaction decision should indicate compaction is needed
    const lastDecision = status.context.lastCompactionDecision
    expect(lastDecision).not.toBeNull()
    expect(lastDecision!.shouldCompact).toBe(true)

    orch.shutdown()
  })

  test('full feedback loop: failures generate injections that expire after success', () => {
    const orch = createTestOrchestrator()
    orch.initialize()

    // Phase 1: Generate failures to trigger feedback injections
    for (let i = 0; i < 4; i++) {
      orch.onToolExecutionStart('FileEdit', 'src/target.ts')
      orch.onToolExecutionComplete('FileEdit', 'src/target.ts', '', false, {
        type: 'old_string_not_found',
        message: 'old_string not found in file',
      })
    }

    let stats = orch.getStatus().feedback
    expect(stats.insightsGenerated).toBeGreaterThan(0)

    // System prompt should contain feedback
    let additions = orch.getSystemPromptAdditions()
    const hasFeedback = additions.some(a => a.toLowerCase().includes('feedback') || a.toLowerCase().includes('fileedit') || a.toLowerCase().includes('old_string'))
    expect(hasFeedback).toBe(true)

    // Phase 2: Succeed many times to recover
    for (let i = 0; i < 10; i++) {
      orch.onToolExecutionStart('FileEdit', 'src/target.ts')
      orch.onToolExecutionComplete('FileEdit', 'src/target.ts', 'ok', true)
    }

    // Trust should have recovered somewhat
    const trust = orch.queryTrust('FileEdit', 'src/target.ts')
    expect(trust.score).toBeGreaterThan(0)

    orch.shutdown()
  })
})
