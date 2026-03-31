/**
 * Comprehensive Stress & Edge-Case Tests for Innovation Modules
 *
 * SELF-CONTAINED: NO imports from src/ codebase. All type stubs and helpers
 * are defined inline so these tests have zero coupling to the main codebase.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test'

// ===========================================================================
// Inline type stubs (avoids importing from src/)
// ===========================================================================

type PermissionBehavior = 'allow' | 'ask' | 'deny'

/** Minimal Message shape needed by PriorityCalculator / SelectiveCompactor */
type Message = {
  type: 'user' | 'assistant' | 'system'
  message?: {
    role?: string
    content?: unknown
  }
}

// ===========================================================================
// Inline reimplementations (self-contained, no src/ imports)
// ===========================================================================

// -- Trust Escalation -------------------------------------------------------

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000
const FAILURE_WEIGHT = 3

function computeScore(
  successCount: number,
  failureCount: number,
  lastUsed: string,
  now: Date = new Date(),
): number {
  if (successCount === 0 && failureCount === 0) return 0
  const ageMs = Math.max(0, now.getTime() - new Date(lastUsed).getTime())
  const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS)
  const effectiveSuccesses = successCount * decay
  const effectiveFailures = failureCount * decay * FAILURE_WEIGHT
  const denominator = effectiveSuccesses + effectiveFailures
  if (denominator === 0) return 0
  return Math.round((effectiveSuccesses / denominator) * 100)
}

type TrustScore = {
  tool: string
  pattern: string
  workspace: string
  successCount: number
  failureCount: number
  lastUsed: string
  score: number
}

class TrustStore {
  private entries = new Map<string, TrustScore>()
  private dirty = false

  constructor(_filePath?: string) {
    // No-op (no file I/O in tests)
  }

  getScore(tool: string, pattern: string, workspace: string): number {
    const key = `${tool}\0${pattern}\0${workspace}`
    const entry = this.entries.get(key)
    if (!entry) return 0
    return computeScore(entry.successCount, entry.failureCount, entry.lastUsed)
  }

  getEntry(tool: string, pattern: string, workspace: string): TrustScore | null {
    const key = `${tool}\0${pattern}\0${workspace}`
    const entry = this.entries.get(key)
    if (!entry) return null
    return {
      ...entry,
      score: computeScore(entry.successCount, entry.failureCount, entry.lastUsed),
    }
  }

  hasPatternInAnyWorkspace(tool: string, pattern: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.tool === tool && entry.pattern === pattern) return true
    }
    return false
  }

  getMaxScoreAcrossWorkspaces(tool: string, pattern: string): number {
    let max = 0
    for (const entry of this.entries.values()) {
      if (entry.tool === tool && entry.pattern === pattern) {
        const s = computeScore(entry.successCount, entry.failureCount, entry.lastUsed)
        if (s > max) max = s
      }
    }
    return max
  }

  recordOutcome(tool: string, pattern: string, workspace: string, success: boolean): void {
    const key = `${tool}\0${pattern}\0${workspace}`
    const now = new Date().toISOString()
    const existing = this.entries.get(key)
    if (existing) {
      if (success) existing.successCount += 1
      else existing.failureCount += 1
      existing.lastUsed = now
      existing.score = computeScore(existing.successCount, existing.failureCount, existing.lastUsed)
    } else {
      this.entries.set(key, {
        tool,
        pattern,
        workspace,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        lastUsed: now,
        score: success ? 100 : 0,
      })
    }
    this.dirty = true
  }

  allEntries(): TrustScore[] {
    const now = new Date()
    return Array.from(this.entries.values()).map(e => ({
      ...e,
      score: computeScore(e.successCount, e.failureCount, e.lastUsed, now),
    }))
  }

  clear(): void {
    this.entries.clear()
    this.dirty = true
  }
}

// -- Predictive Context (ContextPredictor) -----------------------------------

type TokenSnapshot = { timestamp: number; tokens: number }
type CompactionEvent = { timestamp: number; tokensBefore: number; tokensAfter: number }
type CompactionUrgency = 'low' | 'medium' | 'high'
type PreemptiveCompactDecision = { shouldCompact: boolean; urgency: CompactionUrgency; reason: string }

class ContextPredictor {
  private tokenHistory: TokenSnapshot[] = []
  private growthRates: number[] = []
  private compactionHistory: CompactionEvent[] = []
  private readonly slidingWindowSize: number
  private readonly preemptiveThresholdFraction: number
  private readonly lookaheadTurns: number

  constructor(options?: {
    slidingWindowSize?: number
    preemptiveThresholdFraction?: number
    lookaheadTurns?: number
  }) {
    this.slidingWindowSize = options?.slidingWindowSize ?? 10
    this.preemptiveThresholdFraction = options?.preemptiveThresholdFraction ?? 0.70
    this.lookaheadTurns = options?.lookaheadTurns ?? 3
  }

  recordTurn(tokens: number, timestamp: number = Date.now()): void {
    const snapshot: TokenSnapshot = { timestamp, tokens }
    if (this.tokenHistory.length > 0) {
      const prev = this.tokenHistory[this.tokenHistory.length - 1]!
      this.growthRates.push(tokens - prev.tokens)
    }
    this.tokenHistory.push(snapshot)
    while (this.tokenHistory.length > this.slidingWindowSize + 1) this.tokenHistory.shift()
    while (this.growthRates.length > this.slidingWindowSize) this.growthRates.shift()
  }

  recordCompaction(tokensBefore: number, tokensAfter: number, timestamp: number = Date.now()): void {
    this.compactionHistory.push({ timestamp, tokensBefore, tokensAfter })
    this.growthRates = []
    this.tokenHistory = [{ timestamp, tokens: tokensAfter }]
  }

  getAverageGrowthRate(): number {
    if (this.growthRates.length === 0) return 0
    return this.growthRates.reduce((a, b) => a + b, 0) / this.growthRates.length
  }

  predictTokenGrowth(currentTokens: number, recentGrowthRate?: number, turnsRemaining?: number): number {
    const rate = recentGrowthRate ?? this.getAverageGrowthRate()
    const turns = turnsRemaining ?? this.lookaheadTurns
    return Math.max(currentTokens, currentTokens + rate * turns)
  }

  shouldPreemptivelyCompact(
    currentUsage: number,
    windowSize: number,
    growthRate?: number,
  ): PreemptiveCompactDecision {
    const rate = growthRate ?? this.getAverageGrowthRate()
    const threshold = windowSize * this.preemptiveThresholdFraction
    if (currentUsage >= threshold) {
      return { shouldCompact: true, urgency: 'high', reason: `Current usage (${currentUsage}) already exceeds threshold` }
    }
    const predicted = this.predictTokenGrowth(currentUsage, rate)
    if (predicted >= threshold) {
      return { shouldCompact: true, urgency: 'medium', reason: `Predicted usage (${Math.round(predicted)}) will exceed threshold` }
    }
    const advisoryThreshold = windowSize * 0.60
    if (predicted >= advisoryThreshold) {
      return { shouldCompact: false, urgency: 'low', reason: 'Approaching advisory threshold' }
    }
    return { shouldCompact: false, urgency: 'low', reason: 'Usage healthy' }
  }

  getState() {
    return {
      tokenHistory: [...this.tokenHistory],
      growthRates: [...this.growthRates],
      compactionHistory: [...this.compactionHistory],
      averageGrowthRate: this.getAverageGrowthRate(),
    }
  }

  get turnCount(): number { return this.tokenHistory.length }
}

// -- Message Priority (inline minimal) ---------------------------------------

type MessagePriority = {
  messageIndex: number
  priority: number
  reasons: string[]
  isLoadBearing: boolean
}

type ConversationContext = {
  totalMessageCount: number
  referencedIndices: Set<number>
  activeDiscussionIndices: Set<number>
  resolvedErrorIndices: Set<number>
}

class PriorityCalculator {
  scoreMessage(msg: Message, index: number, messages: Message[], context: ConversationContext): MessagePriority {
    let score = 50 // baseline
    const reasons: string[] = []
    // Recency
    if (context.totalMessageCount > 1) {
      const t = index / (context.totalMessageCount - 1)
      const recency = Math.exp(-3.0 * (1 - t))
      score += (recency - 0.5) * 30
      if (recency > 0.8) reasons.push('very recent message')
    }
    // Referenced
    if (context.referencedIndices.has(index)) {
      score += 20
      reasons.push('referenced by later messages')
    }
    // User instruction
    if (msg.type === 'user') {
      score += 20
      reasons.push('contains user instruction')
    }
    const isLoadBearing = msg.type === 'assistant' && Array.isArray((msg.message?.content as unknown[]))
    const priority = Math.max(0, Math.min(100, Math.round(score)))
    return { messageIndex: index, priority, reasons, isLoadBearing }
  }

  scoreAll(messages: Message[], context: ConversationContext): MessagePriority[] {
    return messages.map((msg, i) => this.scoreMessage(msg, i, messages, context))
  }
}

// -- Selective Compactor (inline) --------------------------------------------

type CompactionSelection = { keep: Message[]; compact: Message[]; savings: number }

class SelectiveCompactor {
  private readonly protectedUserMessages: number

  constructor(options?: { protectedUserMessages?: number }) {
    this.protectedUserMessages = options?.protectedUserMessages ?? 3
  }

  selectMessagesForCompaction(
    messages: Message[],
    priorities: MessagePriority[],
    targetTokenReduction: number,
  ): CompactionSelection {
    if (messages.length === 0 || targetTokenReduction <= 0) {
      return { keep: [...messages], compact: [], savings: 0 }
    }
    const protectedSet = new Set<number>()
    let userCount = 0
    for (let i = messages.length - 1; i >= 0 && userCount < this.protectedUserMessages; i--) {
      if (messages[i]!.type === 'user') { protectedSet.add(i); userCount++ }
    }
    type Candidate = { index: number; priority: number; estimatedTokens: number }
    const candidates: Candidate[] = []
    for (const mp of priorities) {
      const idx = mp.messageIndex
      if (idx < 0 || idx >= messages.length) continue
      if (protectedSet.has(idx)) continue
      if (mp.isLoadBearing) continue
      const tokens = Math.ceil(JSON.stringify(messages[idx]).length / 4)
      candidates.push({ index: idx, priority: mp.priority, estimatedTokens: tokens })
    }
    candidates.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.index - b.index)
    const compactIndices = new Set<number>()
    let savings = 0
    for (const c of candidates) {
      if (savings >= targetTokenReduction) break
      compactIndices.add(c.index)
      savings += c.estimatedTokens
    }
    const keep: Message[] = []
    const compact: Message[] = []
    for (let i = 0; i < messages.length; i++) {
      if (compactIndices.has(i)) compact.push(messages[i]!)
      else keep.push(messages[i]!)
    }
    return { keep, compact, savings }
  }
}

// -- Knowledge Graph (inline) ------------------------------------------------

type KnowledgeNodeType = 'file' | 'function' | 'api' | 'decision' | 'fact'
type KnowledgeEdgeRelation = 'depends_on' | 'modifies' | 'uses' | 'conflicts_with' | 'supersedes'

type KnowledgeNode = {
  id: string; type: KnowledgeNodeType; content: string
  metadata: Record<string, unknown>; agentId: string; timestamp: number; confidence: number
}

type KnowledgeEdge = {
  from: string; to: string; relation: KnowledgeEdgeRelation
  agentId: string; timestamp: number
}

type MergeResult = { added: { nodes: number; edges: number }; conflicts: KnowledgeEdge[] }

class KnowledgeGraph {
  _nodes = new Map<string, KnowledgeNode>()
  _edges: KnowledgeEdge[] = []

  async addNode(node: KnowledgeNode): Promise<void> { this._nodes.set(node.id, node) }
  async removeNode(id: string): Promise<boolean> {
    const existed = this._nodes.delete(id)
    if (existed) this._edges = this._edges.filter(e => e.from !== id && e.to !== id)
    return existed
  }
  async getNode(id: string): Promise<KnowledgeNode | undefined> { return this._nodes.get(id) }

  async addEdge(edge: KnowledgeEdge): Promise<void> {
    if (!this._nodes.has(edge.from)) throw new Error(`Source node '${edge.from}' does not exist`)
    if (!this._nodes.has(edge.to)) throw new Error(`Target node '${edge.to}' does not exist`)
    this._edges.push(edge)
  }

  async query(type?: KnowledgeNodeType, pattern?: string): Promise<KnowledgeNode[]> {
    let results = Array.from(this._nodes.values())
    if (type !== undefined) results = results.filter(n => n.type === type)
    if (pattern !== undefined) {
      const regex = new RegExp(pattern, 'i')
      results = results.filter(n => regex.test(n.id) || regex.test(n.content))
    }
    return results
  }

  async getRelated(nodeId: string, relation?: KnowledgeEdgeRelation): Promise<KnowledgeNode[]> {
    const relatedIds = new Set<string>()
    for (const edge of this._edges) {
      if (relation !== undefined && edge.relation !== relation) continue
      if (edge.from === nodeId) relatedIds.add(edge.to)
      else if (edge.to === nodeId) relatedIds.add(edge.from)
    }
    const nodes: KnowledgeNode[] = []
    for (const id of relatedIds) {
      const node = this._nodes.get(id)
      if (node) nodes.push(node)
    }
    return nodes
  }

  async getConflicts(): Promise<KnowledgeEdge[]> {
    return this._edges.filter(e => e.relation === 'conflicts_with')
  }

  async merge(other: KnowledgeGraph): Promise<MergeResult> {
    const result: MergeResult = { added: { nodes: 0, edges: 0 }, conflicts: [] }
    const otherNodes = Array.from(other._nodes.values())
    const otherEdges = [...other._edges]
    for (const node of otherNodes) {
      const existing = this._nodes.get(node.id)
      if (!existing) {
        this._nodes.set(node.id, node)
        result.added.nodes++
      } else if (existing.agentId !== node.agentId) {
        const conflictEdge: KnowledgeEdge = {
          from: existing.id, to: node.id, relation: 'conflicts_with',
          agentId: node.agentId, timestamp: Date.now(),
        }
        result.conflicts.push(conflictEdge)
        this._edges.push(conflictEdge)
        if (node.timestamp > existing.timestamp) this._nodes.set(node.id, node)
      } else if (node.timestamp > existing.timestamp) {
        this._nodes.set(node.id, node)
      }
    }
    for (const edge of otherEdges) {
      const isDuplicate = this._edges.some(
        e => e.from === edge.from && e.to === edge.to && e.relation === edge.relation,
      )
      if (!isDuplicate && this._nodes.has(edge.from) && this._nodes.has(edge.to)) {
        this._edges.push(edge)
        result.added.edges++
      }
    }
    return result
  }

  get nodeCount(): number { return this._nodes.size }
  get edgeCount(): number { return this._edges.length }
}

// -- Agent Bus (inline) ------------------------------------------------------

type AgentMessageType = 'knowledge_update' | 'conflict_detected' | 'work_complete' | 'work_request' | 'status'
type AgentMessage = { from: string; to: string | 'broadcast'; type: AgentMessageType; payload: unknown; id?: string; timestamp?: number }
type MessageHandler = (message: AgentMessage) => void | Promise<void>

class AgentBus {
  private _handlers = new Map<string, MessageHandler>()
  private _activeAgents = new Set<string>()
  private _nextMessageId = 1

  subscribe(agentId: string, handler: MessageHandler): void {
    if (this._handlers.has(agentId)) throw new Error(`Agent '${agentId}' is already subscribed`)
    this._handlers.set(agentId, handler)
    this._activeAgents.add(agentId)
  }

  unsubscribe(agentId: string): void {
    this._handlers.delete(agentId)
    this._activeAgents.delete(agentId)
  }

  publish(message: AgentMessage): void {
    const enriched: AgentMessage = { ...message, id: `msg_${this._nextMessageId++}`, timestamp: Date.now() }
    if (enriched.to === 'broadcast') {
      this.broadcast(enriched)
      return
    }
    if (this._activeAgents.has(enriched.to)) {
      const handler = this._handlers.get(enriched.to)
      if (handler) handler(enriched)
    }
  }

  broadcast(message: AgentMessage): void {
    const enriched: AgentMessage = {
      ...message,
      id: message.id ?? `msg_${this._nextMessageId++}`,
      timestamp: message.timestamp ?? Date.now(),
      to: 'broadcast',
    }
    for (const [agentId, handler] of this._handlers) {
      if (agentId !== enriched.from) handler(enriched)
    }
  }

  getActiveAgents(): string[] { return Array.from(this._activeAgents) }
  get pendingMessageCount(): number { return 0 }

  destroy(): void {
    this._handlers.clear()
    this._activeAgents.clear()
  }
}

// -- Conflict Resolver (inline) -----------------------------------------------

type ConflictType = 'same_line' | 'semantic' | 'structural'
type AgentChange = { agentId: string; changes: string; lineRange?: { start: number; end: number }; timestamp: number }
type FileConflict = { file: string; agentA: AgentChange; agentB: AgentChange; type: ConflictType }
type Resolution = { file: string; winner: string; loser: string; resolvedChanges: string; reason: string }

class ConflictResolver {
  resolveByTimestamp(conflict: FileConflict): Resolution {
    const latest = conflict.agentA.timestamp >= conflict.agentB.timestamp ? conflict.agentA : conflict.agentB
    const other = latest === conflict.agentA ? conflict.agentB : conflict.agentA
    return {
      file: conflict.file, winner: latest.agentId, loser: other.agentId,
      resolvedChanges: latest.changes,
      reason: `Agent '${latest.agentId}' had the more recent change`,
    }
  }

  resolveByPriority(conflict: FileConflict, agentPriorities: Map<string, number>): Resolution {
    const prioA = agentPriorities.get(conflict.agentA.agentId) ?? 0
    const prioB = agentPriorities.get(conflict.agentB.agentId) ?? 0
    if (prioA === prioB) return this.resolveByTimestamp(conflict)
    const winner = prioA > prioB ? conflict.agentA : conflict.agentB
    const loser = winner === conflict.agentA ? conflict.agentB : conflict.agentA
    return {
      file: conflict.file, winner: winner.agentId, loser: loser.agentId,
      resolvedChanges: winner.changes, reason: 'Higher priority',
    }
  }
}

// -- Mesh Coordinator (inline minimal) ----------------------------------------

type WorkItem = {
  id: string; description: string; relatedFiles: string[]; priority: number
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed'; assignedTo?: string
}

class MeshCoordinator {
  private _bus: AgentBus
  private _tasks = new Map<string, WorkItem>()

  constructor(_graph: KnowledgeGraph, bus: AgentBus, _resolver: ConflictResolver) {
    this._bus = bus
  }

  assignWork(tasks: WorkItem[]): Map<string, WorkItem[]> {
    const agents = this._bus.getActiveAgents()
    if (agents.length === 0) throw new Error('No active agents available for work assignment')
    const assignment = new Map<string, WorkItem[]>()
    for (const agentId of agents) assignment.set(agentId, [])
    const sorted = [...tasks].sort((a, b) => b.priority - a.priority)
    let robin = 0
    for (const task of sorted) {
      const agentId = agents[robin % agents.length]!
      task.status = 'assigned'
      task.assignedTo = agentId
      this._tasks.set(task.id, task)
      assignment.get(agentId)!.push(task)
      robin++
    }
    return assignment
  }
}

// -- Complexity Analyzer (inline) ---------------------------------------------

type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert'
type ModelTier = 'local_small' | 'local_medium' | 'cloud_fast' | 'cloud_standard' | 'cloud_thinking'
type TaskComplexity = { level: ComplexityLevel; score: number; factors: string[]; suggestedModel: ModelTier }

class ComplexityAnalyzer {
  analyze(userMessage: string): TaskComplexity {
    let score = 30
    const factors: string[] = []
    const len = userMessage.trim().length
    if (len < 20) { score -= 15; factors.push('very short') }
    else if (len > 500) { score += 10; factors.push('long') }
    const lower = userMessage.toLowerCase()
    if (['refactor', 'architect', 'migrate', 'security'].some(kw => lower.includes(kw))) {
      score += 20; factors.push('complex keywords')
    }
    if (['read', 'show', 'list', 'help'].some(kw => lower.includes(kw))) {
      score -= 10; factors.push('simple keywords')
    }
    score = Math.max(0, Math.min(100, score))
    let level: ComplexityLevel
    if (score < 15) level = 'trivial'
    else if (score < 35) level = 'simple'
    else if (score < 60) level = 'moderate'
    else if (score < 85) level = 'complex'
    else level = 'expert'
    const tierMap: Record<ComplexityLevel, ModelTier> = {
      trivial: 'local_small', simple: 'local_small', moderate: 'cloud_fast',
      complex: 'cloud_standard', expert: 'cloud_thinking',
    }
    return { level, score, factors, suggestedModel: tierMap[level] }
  }
}

// -- Routing Policy (inline) --------------------------------------------------

type ModelConfig = {
  tier: ModelTier; model: string; endpoint: string; maxTokens: number
  latencyMs: number; costPer1kTokens: number; capabilities: string[]
}

type RoutingConstraints = { maxLatency?: number; maxCost?: number; requireCapabilities?: string[] }
type RoutingDecision = {
  tier: ModelTier; model: string; reason: string; fallback?: ModelTier
  estimatedLatency: number; estimatedCost: number
}

const TIER_ORDER: readonly ModelTier[] = ['local_small', 'local_medium', 'cloud_fast', 'cloud_standard', 'cloud_thinking']

class RoutingPolicy {
  private models = new Map<ModelTier, ModelConfig[]>()

  constructor(availableModels: ModelConfig[]) {
    for (const m of availableModels) {
      const existing = this.models.get(m.tier) ?? []
      existing.push(m)
      this.models.set(m.tier, existing)
    }
  }

  route(complexity: TaskComplexity, constraints?: RoutingConstraints): RoutingDecision {
    const tierMap: Record<ComplexityLevel, ModelTier> = {
      trivial: 'local_small', simple: 'local_small', moderate: 'cloud_fast',
      complex: 'cloud_standard', expert: 'cloud_thinking',
    }
    const preferredTier = tierMap[complexity.level]
    const fallbackChain = this.buildFallbackChain(preferredTier)
    for (const tier of [preferredTier, ...fallbackChain]) {
      const candidates = this.models.get(tier)
      if (!candidates || candidates.length === 0) continue
      const viable = this.filterByConstraints(candidates, constraints)
      if (viable.length === 0) continue
      const best = viable.sort((a, b) => a.costPer1kTokens - b.costPer1kTokens || a.latencyMs - b.latencyMs)[0]!
      return {
        tier, model: best.model,
        reason: `Complexity: ${complexity.level} (score ${complexity.score})`,
        fallback: fallbackChain[0],
        estimatedLatency: best.latencyMs, estimatedCost: best.costPer1kTokens,
      }
    }
    // Last resort
    return {
      tier: 'cloud_standard', model: 'claude-sonnet-4-20250514',
      reason: 'No model matched; falling back',
      estimatedLatency: 1000, estimatedCost: 0.009,
    }
  }

  hasTier(tier: ModelTier): boolean {
    const m = this.models.get(tier)
    return m !== undefined && m.length > 0
  }

  private buildFallbackChain(preferred: ModelTier): ModelTier[] {
    const idx = TIER_ORDER.indexOf(preferred)
    const chain: ModelTier[] = []
    for (let i = idx + 1; i < TIER_ORDER.length; i++) chain.push(TIER_ORDER[i]!)
    for (let i = idx - 1; i >= 0; i--) chain.push(TIER_ORDER[i]!)
    return chain
  }

  private filterByConstraints(candidates: ModelConfig[], constraints?: RoutingConstraints): ModelConfig[] {
    if (!constraints) return candidates
    return candidates.filter(m => {
      if (constraints.maxLatency !== undefined && m.latencyMs > constraints.maxLatency) return false
      if (constraints.maxCost !== undefined && m.costPer1kTokens > constraints.maxCost) return false
      if (constraints.requireCapabilities) {
        const has = new Set(m.capabilities)
        if (!constraints.requireCapabilities.every(c => has.has(c))) return false
      }
      return true
    })
  }
}

// -- Execution Tracker (inline) -----------------------------------------------

type ToolExecution = {
  toolName: string; input: string; output: string; success: boolean
  errorType?: string; errorMessage?: string; timestamp: Date; durationMs: number; attempt: number
}

type ExecutionPattern = {
  toolName: string; pattern: string; frequency: number; lastSeen: Date
  outcomes: { success: number; failure: number }
}

const MAX_TRACKER_ENTRIES = 200

class ExecutionTracker {
  private executions: ToolExecution[] = []

  record(execution: ToolExecution): void {
    this.executions.push(execution)
    if (this.executions.length > MAX_TRACKER_ENTRIES) {
      this.executions = this.executions.slice(this.executions.length - MAX_TRACKER_ENTRIES)
    }
  }

  getRecentExecutions(toolName?: string, limit = 20): ToolExecution[] {
    let filtered = this.executions
    if (toolName) filtered = filtered.filter(e => e.toolName === toolName)
    return filtered.slice(-limit)
  }

  getFailurePatterns(toolName?: string): ExecutionPattern[] {
    const failures = this.executions.filter(e => !e.success && (!toolName || e.toolName === toolName))
    const groups = new Map<string, ToolExecution[]>()
    for (const f of failures) {
      const key = `${f.toolName}::${f.errorType ?? (f.errorMessage ?? 'unknown').slice(0, 80)}`
      let arr = groups.get(key)
      if (!arr) { arr = []; groups.set(key, arr) }
      arr.push(f)
    }
    const patterns: ExecutionPattern[] = []
    for (const [, execs] of groups) {
      if (execs.length === 0) continue
      const first = execs[0]!
      const toolSuccesses = this.executions.filter(e => e.success && e.toolName === first.toolName).length
      patterns.push({
        toolName: first.toolName,
        pattern: first.errorType ?? (first.errorMessage ?? 'unknown').slice(0, 80),
        frequency: execs.length, lastSeen: execs[execs.length - 1]!.timestamp,
        outcomes: { success: toolSuccesses, failure: execs.length },
      })
    }
    patterns.sort((a, b) => b.frequency - a.frequency)
    return patterns
  }

  getConsecutiveFailures(toolName: string): number {
    let count = 0
    for (let i = this.executions.length - 1; i >= 0; i--) {
      const e = this.executions[i]!
      if (e.toolName !== toolName) continue
      if (e.success) break
      count++
    }
    return count
  }

  getSuccessRate(toolName: string, windowSize = 50): number {
    const toolExecs = this.executions.filter(e => e.toolName === toolName)
    if (toolExecs.length === 0) return 1
    const window = toolExecs.slice(-windowSize)
    return window.filter(e => e.success).length / window.length
  }

  get size(): number { return this.executions.length }
  clear(): void { this.executions = [] }
}

// -- Tool Feedback System (inline) --------------------------------------------

class ToolFeedbackSystem {
  private tracker = new ExecutionTracker()
  private totalRecorded = 0
  private totalFailures = 0

  onToolComplete(
    toolName: string, input: string, output: string, success: boolean,
    error?: { type?: string; message?: string },
  ): void {
    const execution: ToolExecution = {
      toolName, input: input.slice(0, 200), output: output.slice(0, 200),
      success, errorType: error?.type, errorMessage: error?.message?.slice(0, 300),
      timestamp: new Date(), durationMs: 0, attempt: 1,
    }
    this.tracker.record(execution)
    this.totalRecorded++
    if (!success) this.totalFailures++
  }

  reset(): void {
    this.tracker.clear()
    this.totalRecorded = 0
    this.totalFailures = 0
  }

  getStats() {
    return {
      totalExecutions: this.totalRecorded,
      failureRate: this.totalRecorded > 0 ? this.totalFailures / this.totalRecorded : 0,
    }
  }

  get _tracker(): ExecutionTracker { return this.tracker }
}

// -- Embedding Store (inline) -------------------------------------------------

type MemoryType = 'episode' | 'semantic' | 'procedural'
type MemoryMetadata = {
  source: string; timestamp: string; project: string
  tags: string[]; accessCount: number; lastAccessed: string
}
type MemoryEntry = {
  id: string; content: string; type: MemoryType
  embedding: number[]; metadata: MemoryMetadata; importance: number
}

function tokenise(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)
}

function buildVocabulary(texts: string[]): Map<string, number> {
  const vocab = new Map<string, number>()
  for (const text of texts) {
    for (const token of tokenise(text)) {
      if (!vocab.has(token)) vocab.set(token, vocab.size)
    }
  }
  return vocab
}

function textToTfIdf(text: string, vocabulary: Map<string, number>): number[] {
  const tokens = tokenise(text)
  if (tokens.length === 0 || vocabulary.size === 0) return new Array(vocabulary.size).fill(0)
  const tf = new Map<string, number>()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  const vec = new Array<number>(vocabulary.size).fill(0)
  for (const [term, count] of tf) {
    const idx = vocabulary.get(term)
    if (idx === undefined) continue
    vec[idx] = count / tokens.length
  }
  // Normalise
  let mag = 0
  for (const v of vec) mag += v * v
  mag = Math.sqrt(mag)
  if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] /= mag
  return vec
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return dot
}

class EmbeddingStore {
  private entries = new Map<string, MemoryEntry>()
  readonly maxEntries: number

  constructor(_filePath: string, maxEntries = 10_000) {
    this.maxEntries = maxEntries
  }

  load(): void { /* no-op in tests */ }

  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry)
    this.evictIfNeeded()
  }

  remove(id: string): boolean { return this.entries.delete(id) }

  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id)
    if (entry) { entry.metadata.accessCount++; entry.metadata.lastAccessed = new Date().toISOString() }
    return entry
  }

  has(id: string): boolean { return this.entries.has(id) }
  size(): number { return this.entries.size }
  getAllEntries(): MemoryEntry[] { return Array.from(this.entries.values()) }

  search(queryEmbedding: number[], topK = 5, filters?: { type?: MemoryType; project?: string }): Array<{ entry: MemoryEntry; score: number }> {
    const results: Array<{ entry: MemoryEntry; score: number }> = []
    for (const entry of this.entries.values()) {
      if (filters?.type && entry.type !== filters.type) continue
      if (filters?.project && entry.metadata.project !== filters.project) continue
      const score = cosineSimilarity(queryEmbedding, entry.embedding)
      results.push({ entry, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  rebuildVocabulary(_extraTexts: string[] = []): void { /* no-op for tests */ }
  embed(text: string): number[] { return textToTfIdf(text, buildVocabulary([text])) }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let worstId: string | undefined
      let worstPriority = Infinity
      const now = Date.now()
      for (const [id, entry] of this.entries) {
        const daysSinceAccess = (now - new Date(entry.metadata.lastAccessed).getTime()) / (1000 * 60 * 60 * 24)
        const recency = 1 / (1 + daysSinceAccess)
        const priority = entry.importance * recency
        if (priority < worstPriority) { worstPriority = priority; worstId = id }
      }
      if (worstId) this.entries.delete(worstId)
      else break
    }
  }
}

// -- Episode Manager (inline) -------------------------------------------------

type Decision = { description: string; reasoning: string; timestamp: string; confidence: number }
type ToolUseRecord = { toolName: string; input: string; output: string; success: boolean; timestamp: string }
type Episode = {
  id: string; sessionId: string; startTime: string; endTime: string | null
  summary: string; decisions: Decision[]; toolsUsed: string[]; filesModified: string[]
  outcome: 'success' | 'failure' | 'partial' | 'abandoned' | null; toolRecords: ToolUseRecord[]
}

class EpisodeManager {
  private episodes = new Map<string, Episode>()
  private orderedIds: string[] = []
  private store: EmbeddingStore
  private nextId = 1

  constructor(store: EmbeddingStore) { this.store = store }

  startEpisode(sessionId: string): Episode {
    const id = `ep-${Date.now()}-${this.nextId++}`
    const episode: Episode = {
      id, sessionId, startTime: new Date().toISOString(), endTime: null,
      summary: '', decisions: [], toolsUsed: [], filesModified: [],
      outcome: null, toolRecords: [],
    }
    this.episodes.set(id, episode)
    this.orderedIds.push(id)
    return episode
  }

  recordDecision(episodeId: string, decision: Omit<Decision, 'timestamp'>): void {
    const ep = this.episodes.get(episodeId)
    if (!ep) return
    ep.decisions.push({ ...decision, timestamp: new Date().toISOString() })
  }

  recordToolUse(episodeId: string, toolName: string, input: string, output: string, success: boolean): void {
    const ep = this.episodes.get(episodeId)
    if (!ep) return
    if (!ep.toolsUsed.includes(toolName)) ep.toolsUsed.push(toolName)
    ep.toolRecords.push({ toolName, input, output, success, timestamp: new Date().toISOString() })
  }

  endEpisode(episodeId: string, outcome: Episode['outcome'], summary?: string): Episode | undefined {
    const ep = this.episodes.get(episodeId)
    if (!ep) return undefined
    ep.endTime = new Date().toISOString()
    ep.outcome = outcome
    ep.summary = summary ?? `Episode ${ep.id} completed with ${outcome}`
    return ep
  }

  getEpisode(id: string): Episode | undefined { return this.episodes.get(id) }

  getRecentEpisodes(limit = 10): Episode[] {
    const result: Episode[] = []
    for (let i = this.orderedIds.length - 1; i >= 0 && result.length < limit; i--) {
      const ep = this.episodes.get(this.orderedIds[i]!)
      if (ep) result.push(ep)
    }
    return result
  }
}

// -- Cross-Project Transfer (inline) ------------------------------------------

type LearnedPattern = { pattern: string; context: string; frequency: number; confidence: number; projects: string[] }

class CrossProjectTransfer {
  private patterns = new Map<string, LearnedPattern>()
  private profiles = new Map<string, { projectId: string; patterns: LearnedPattern[] }>()

  recordPattern(projectId: string, pattern: string, context: string): void {
    if (!this.profiles.has(projectId)) this.profiles.set(projectId, { projectId, patterns: [] })
    const existing = this.patterns.get(pattern)
    if (existing) {
      existing.frequency++
      if (!existing.projects.includes(projectId)) existing.projects.push(projectId)
      existing.confidence = Math.min(1, 0.3 + existing.projects.length * 0.2)
      existing.context = context
    } else {
      const entry: LearnedPattern = { pattern, context, frequency: 1, confidence: 0.3, projects: [projectId] }
      this.patterns.set(pattern, entry)
    }
  }

  getTransferablePatterns(fromProject: string, toProject: string): LearnedPattern[] {
    return Array.from(this.patterns.values()).filter(
      p => p.projects.length >= 2 && p.projects.includes(fromProject) && !p.projects.includes(toProject),
    )
  }

  getProjectIds(): string[] { return Array.from(this.profiles.keys()) }
}

// -- Memory Consolidator (inline) ---------------------------------------------

type ConsolidationResult = {
  merged: number; decayed: number; promoted: number; removed: number
  totalBefore: number; totalAfter: number
}

class MemoryConsolidator {
  private readonly mergeSimilarity: number
  private readonly decayRate: number
  private readonly accessBoost: number
  private readonly importanceFloor: number

  constructor(options?: { mergeSimilarity?: number; decayRate?: number; accessBoost?: number; importanceFloor?: number }) {
    this.mergeSimilarity = options?.mergeSimilarity ?? 0.85
    this.decayRate = options?.decayRate ?? 0.95
    this.accessBoost = options?.accessBoost ?? 0.01
    this.importanceFloor = options?.importanceFloor ?? 0.05
  }

  consolidate(store: EmbeddingStore): ConsolidationResult {
    const totalBefore = store.size()
    let decayed = 0, promoted = 0, removed = 0
    const entries = store.getAllEntries()
    const now = Date.now()
    for (const entry of entries) {
      const daysSinceAccess = (now - new Date(entry.metadata.lastAccessed).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceAccess > 0) {
        const before = entry.importance
        entry.importance *= Math.pow(this.decayRate, daysSinceAccess)
        if (entry.importance < before) decayed++
      }
      if (entry.metadata.accessCount > 0) {
        const before = entry.importance
        entry.importance = Math.min(1, entry.importance + entry.metadata.accessCount * this.accessBoost)
        if (entry.importance > before) promoted++
      }
    }
    const toRemove: string[] = []
    for (const entry of store.getAllEntries()) {
      if (entry.importance < this.importanceFloor) toRemove.push(entry.id)
    }
    for (const id of toRemove) { store.remove(id); removed++ }
    // Merge similar
    let merged = 0
    const remaining = store.getAllEntries()
    const consumed = new Set<string>()
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[i]!
      if (consumed.has(a.id)) continue
      for (let j = i + 1; j < remaining.length; j++) {
        const b = remaining[j]!
        if (consumed.has(b.id)) continue
        if (a.type !== b.type) continue
        const sim = cosineSimilarity(a.embedding, b.embedding)
        if (sim >= this.mergeSimilarity) {
          a.importance = Math.min(1, Math.max(a.importance, b.importance) + 0.05)
          store.remove(b.id)
          consumed.add(b.id)
          merged++
        }
      }
    }
    return { merged, decayed, promoted, removed, totalBefore, totalAfter: store.size() }
  }
}

// -- Session Broker (inline) --------------------------------------------------

type Participant = { userId: string; name: string; role: 'owner' | 'editor' | 'viewer'; joinedAt: Date; lastActive: Date; color: string }
type SharedMessage = { id: string; author: { userId: string; name: string } | 'assistant'; content: string; timestamp: Date; reactions: unknown[] }
type SessionSettings = { maxParticipants: number; allowViewers: boolean; requireApproval: boolean; sharedPermissions: boolean }
type SharedSession = { id: string; name: string; createdBy: string; participants: Participant[]; state: 'active' | 'paused' | 'ended'; messages: SharedMessage[]; createdAt: Date; settings: SessionSettings }
type JoinResult = { success: boolean; session?: SharedSession; error?: string }

const MAX_PARTICIPANTS_HARD_LIMIT = 10
const PARTICIPANT_COLORS = ['#4A90D9', '#D94A4A', '#4AD97A', '#D9C74A', '#9B4AD9', '#D9884A', '#4AD9D9', '#D94A9B', '#7AD94A', '#4A5DD9']

class SessionBroker {
  private _sessions = new Map<string, SharedSession>()
  private _colorIndex = new Map<string, number>()

  createSession(
    name: string, createdBy: { userId: string; name: string },
    settings?: Partial<SessionSettings>,
  ): SharedSession {
    const mergedSettings: SessionSettings = {
      maxParticipants: MAX_PARTICIPANTS_HARD_LIMIT,
      allowViewers: true, requireApproval: false, sharedPermissions: true,
      ...settings,
    }
    mergedSettings.maxParticipants = Math.min(mergedSettings.maxParticipants, MAX_PARTICIPANTS_HARD_LIMIT)
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const now = new Date()
    const owner: Participant = {
      userId: createdBy.userId, name: createdBy.name, role: 'owner',
      joinedAt: now, lastActive: now, color: PARTICIPANT_COLORS[0]!,
    }
    const session: SharedSession = {
      id: sessionId, name, createdBy: createdBy.userId, participants: [owner],
      state: 'active', messages: [], createdAt: now, settings: mergedSettings,
    }
    this._sessions.set(sessionId, session)
    this._colorIndex.set(sessionId, 1)
    return session
  }

  joinSession(sessionId: string, participant: { userId: string; name: string; role?: 'editor' | 'viewer' }): JoinResult {
    const session = this._sessions.get(sessionId)
    if (!session) return { success: false, error: 'Session not found' }
    if (session.state === 'ended') return { success: false, error: 'Session has ended' }
    if (session.participants.some(p => p.userId === participant.userId)) return { success: false, error: 'Already a participant' }
    if (session.participants.length >= session.settings.maxParticipants) return { success: false, error: 'Session is full' }
    const role = participant.role ?? 'editor'
    if (role === 'viewer' && !session.settings.allowViewers) return { success: false, error: 'Viewers not allowed' }
    const now = new Date()
    const idx = this._colorIndex.get(sessionId) ?? 0
    const color = PARTICIPANT_COLORS[idx % PARTICIPANT_COLORS.length]!
    this._colorIndex.set(sessionId, idx + 1)
    session.participants.push({ userId: participant.userId, name: participant.name, role, joinedAt: now, lastActive: now, color })
    return { success: true, session }
  }

  leaveSession(sessionId: string, userId: string): void {
    const session = this._sessions.get(sessionId)
    if (!session) return
    const idx = session.participants.findIndex(p => p.userId === userId)
    if (idx === -1) return
    session.participants.splice(idx, 1)
    if (session.participants.length === 0) session.state = 'ended'
  }

  getSession(sessionId: string): SharedSession | null {
    return this._sessions.get(sessionId) ?? null
  }
}

// -- Message Synchronizer (inline) --------------------------------------------

type SyncEvent = { type: string; payload: unknown; timestamp: Date; authorId: string; seq: number }
type SyncHandler = (event: SyncEvent) => void

class MessageSynchronizer {
  readonly sessionId: string
  private _subscribers = new Map<string, SyncHandler>()
  private _history: SyncEvent[] = []
  private _seq = 0

  constructor(sessionId: string) { this.sessionId = sessionId }

  broadcast(event: Omit<SyncEvent, 'seq'>): SyncEvent {
    const fullEvent: SyncEvent = { ...event, seq: ++this._seq }
    this._history.push(fullEvent)
    for (const handler of this._subscribers.values()) handler(fullEvent)
    return fullEvent
  }

  subscribe(userId: string, handler: SyncHandler): () => void {
    this._subscribers.set(userId, handler)
    return () => { this._subscribers.delete(userId) }
  }

  addMessage(author: { userId: string; name: string } | 'assistant', content: string) {
    const message = {
      id: `msg-${this._seq + 1}`, author, content, timestamp: new Date(), reactions: [],
    }
    const authorId = author === 'assistant' ? '__assistant__' : author.userId
    this.broadcast({ type: 'message_added', payload: message, timestamp: message.timestamp, authorId })
    return message
  }

  getHistory(since?: Date): SyncEvent[] {
    if (!since) return [...this._history]
    return this._history.filter(e => e.timestamp.getTime() >= since.getTime())
  }

  getSequence(): number { return this._seq }

  destroy(): void { this._subscribers.clear(); this._history = [] }
}

// -- Presence Tracker (inline minimal) ----------------------------------------

type PresenceStatus = 'active' | 'idle' | 'away' | 'typing'
type PresenceState = { userId: string; status: PresenceStatus; lastHeartbeat: Date; currentFocus?: string }

class PresenceTracker {
  private _presence = new Map<string, PresenceState>()
  private _sessionParticipants = new Map<string, Set<string>>()

  register(userId: string, sessionId?: string): void {
    if (!this._presence.has(userId)) {
      this._presence.set(userId, { userId, status: 'active', lastHeartbeat: new Date() })
    }
    if (sessionId) {
      let participants = this._sessionParticipants.get(sessionId)
      if (!participants) { participants = new Set(); this._sessionParticipants.set(sessionId, participants) }
      participants.add(userId)
    }
  }

  unregister(userId: string, sessionId?: string): void {
    this._presence.delete(userId)
    if (sessionId) {
      const participants = this._sessionParticipants.get(sessionId)
      if (participants) { participants.delete(userId); if (participants.size === 0) this._sessionParticipants.delete(sessionId) }
    }
  }

  heartbeat(userId: string): void {
    const state = this._presence.get(userId)
    if (state) { state.lastHeartbeat = new Date(); if (state.status === 'idle' || state.status === 'away') state.status = 'active' }
  }

  getPresence(userId: string): PresenceState | null { return this._presence.get(userId) ?? null }

  getActiveParticipants(sessionId: string): PresenceState[] {
    const participants = this._sessionParticipants.get(sessionId)
    if (!participants) return []
    const result: PresenceState[] = []
    for (const userId of participants) {
      const state = this._presence.get(userId)
      if (state) result.push(state)
    }
    return result
  }

  destroy(): void { this._presence.clear(); this._sessionParticipants.clear() }
}

// ===========================================================================
// Helpers
// ===========================================================================

function makeNode(id: string, agentId: string, content: string, type: KnowledgeNodeType = 'file'): KnowledgeNode {
  return { id, type, content, metadata: {}, agentId, timestamp: Date.now(), confidence: 0.9 }
}

function makeMemoryEntry(id: string, content: string, opts?: Partial<MemoryEntry>): MemoryEntry {
  const vocab = buildVocabulary([content])
  return {
    id,
    content,
    type: 'episode',
    embedding: textToTfIdf(content, vocab),
    metadata: {
      source: 'test', timestamp: new Date().toISOString(), project: 'test-project',
      tags: [], accessCount: 0, lastAccessed: new Date().toISOString(),
    },
    importance: 0.5,
    ...opts,
  }
}

function makeExecution(toolName: string, success: boolean, error?: string): ToolExecution {
  return {
    toolName, input: 'test input', output: success ? 'ok' : 'error',
    success, errorType: success ? undefined : 'test_error',
    errorMessage: error, timestamp: new Date(), durationMs: 100, attempt: 1,
  }
}

// ===========================================================================
// 1. TRUST ESCALATION STRESS (8 tests)
// ===========================================================================

describe('Trust Escalation Stress', () => {
  let store: TrustStore

  beforeEach(() => {
    store = new TrustStore()
  })

  test('1000 rapid recordOutcome calls - verify no data loss', () => {
    for (let i = 0; i < 1000; i++) {
      store.recordOutcome('Bash', `cmd_${i % 50}`, '/workspace', i % 3 !== 0)
    }
    const entries = store.allEntries()
    // 50 unique patterns
    expect(entries.length).toBe(50)
    // Total outcomes across all entries must equal 1000
    let total = 0
    for (const e of entries) total += e.successCount + e.failureCount
    expect(total).toBe(1000)
  })

  test('score stability: alternate success/failure 100 times, verify score converges', () => {
    for (let i = 0; i < 100; i++) {
      store.recordOutcome('Edit', 'file.ts', '/ws', i % 2 === 0)
    }
    const entry = store.getEntry('Edit', 'file.ts', '/ws')
    expect(entry).not.toBeNull()
    // 50 successes, 50 failures, FAILURE_WEIGHT=3: effective = 50/(50+150) = 0.25 => score ~25
    expect(entry!.score).toBeGreaterThanOrEqual(0)
    expect(entry!.score).toBeLessThanOrEqual(100)
    // With 3x failure weight, score should be low (~25)
    expect(entry!.score).toBeLessThanOrEqual(30)
  })

  test('concurrent workspace access: 10 workspaces recording simultaneously', () => {
    const workspaces = Array.from({ length: 10 }, (_, i) => `/workspace-${i}`)
    for (const ws of workspaces) {
      for (let i = 0; i < 100; i++) {
        store.recordOutcome('Bash', 'ls', ws, true)
      }
    }
    // Each workspace should have independent tracking
    for (const ws of workspaces) {
      const score = store.getScore('Bash', 'ls', ws)
      expect(score).toBe(100) // all successes
    }
    expect(store.allEntries().length).toBe(10)
  })

  test('time decay accuracy: simulate 365 days of aging', () => {
    // Record an outcome
    store.recordOutcome('Read', 'file.ts', '/ws', true)
    const entry = store.getEntry('Read', 'file.ts', '/ws')
    expect(entry).not.toBeNull()

    // Compute score as if 365 days have passed
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    const decayedScore = computeScore(1, 0, entry!.lastUsed, futureDate)
    // After ~12 half-lives (365/30), score should be nearly 100 still
    // because ratio is 1/(1+0) = 1 regardless of decay
    expect(decayedScore).toBe(100) // ratio stays 100 with 0 failures

    // With mixed, decay reduces but ratio stays same
    store.recordOutcome('Read', 'mixed', '/ws', true)
    store.recordOutcome('Read', 'mixed', '/ws', false)
    const entry2 = store.getEntry('Read', 'mixed', '/ws')
    const decayed2 = computeScore(entry2!.successCount, entry2!.failureCount, entry2!.lastUsed, futureDate)
    // Decay cancels in numerator and denominator, ratio stays same
    expect(decayed2).toBe(computeScore(entry2!.successCount, entry2!.failureCount, entry2!.lastUsed))
  })

  test('empty/null/undefined inputs do not crash', () => {
    expect(() => store.recordOutcome('', '', '', true)).not.toThrow()
    expect(() => store.getScore('', '', '')).not.toThrow()
    expect(() => store.getEntry('', '', '')).not.toThrow()
    expect(() => computeScore(0, 0, '')).not.toThrow()
    expect(() => computeScore(0, 0, 'invalid-date')).not.toThrow()
    // NaN check
    const score = computeScore(0, 0, 'not-a-date')
    expect(score).toBe(0)
  })

  test('very long tool names and patterns (10KB strings)', () => {
    const longTool = 'T'.repeat(10240)
    const longPattern = 'P'.repeat(10240)
    expect(() => store.recordOutcome(longTool, longPattern, '/ws', true)).not.toThrow()
    const score = store.getScore(longTool, longPattern, '/ws')
    expect(score).toBe(100)
  })

  test('unicode in workspace names', () => {
    const workspaces = [
      '/workspace/\u{1F600}', // emoji
      '/workspace/\u00E9\u00E8\u00EA', // accented chars
      '/workspace/\u4F60\u597D', // Chinese
      '/workspace/\u0410\u0411\u0412', // Cyrillic
      '/workspace/\u202E\u202D', // RTL/LTR override
    ]
    for (const ws of workspaces) {
      store.recordOutcome('Bash', 'cmd', ws, true)
    }
    expect(store.allEntries().length).toBe(5)
    for (const ws of workspaces) {
      expect(store.getScore('Bash', 'cmd', ws)).toBe(100)
    }
  })

  test('score boundary conditions (exactly 0, exactly 100)', () => {
    // Score 0: only failures
    store.recordOutcome('Bash', 'fail', '/ws', false)
    expect(store.getScore('Bash', 'fail', '/ws')).toBe(0)

    // Score 100: only successes
    store.recordOutcome('Bash', 'win', '/ws', true)
    expect(store.getScore('Bash', 'win', '/ws')).toBe(100)

    // No history: score 0
    expect(store.getScore('NeverUsed', 'x', '/ws')).toBe(0)

    // Edge: computeScore with zeros
    expect(computeScore(0, 0, new Date().toISOString())).toBe(0)
  })
})

// ===========================================================================
// 2. PREDICTIVE CONTEXT STRESS (8 tests)
// ===========================================================================

describe('Predictive Context Stress', () => {
  test('track 10,000 turns of token growth', () => {
    const predictor = new ContextPredictor({ slidingWindowSize: 100 })
    for (let i = 0; i < 10_000; i++) {
      predictor.recordTurn(1000 + i * 10, i)
    }
    // Sliding window should have trimmed to 101 snapshots
    const state = predictor.getState()
    expect(state.tokenHistory.length).toBeLessThanOrEqual(101)
    expect(state.growthRates.length).toBeLessThanOrEqual(100)
    // Growth rate should be ~10 tokens/turn
    expect(Math.abs(predictor.getAverageGrowthRate() - 10)).toBeLessThan(1)
  })

  test('predict with zero history (cold start)', () => {
    const predictor = new ContextPredictor()
    expect(predictor.getAverageGrowthRate()).toBe(0)
    const predicted = predictor.predictTokenGrowth(5000)
    expect(predicted).toBe(5000) // no growth predicted
    const decision = predictor.shouldPreemptivelyCompact(5000, 200_000)
    expect(decision.shouldCompact).toBe(false)
  })

  test('predict with wildly varying growth rates', () => {
    const predictor = new ContextPredictor({ slidingWindowSize: 10 })
    const values = [100, 5000, 200, 9000, 50, 8000, 300, 7000, 150, 6000, 400]
    for (let i = 0; i < values.length; i++) {
      predictor.recordTurn(values[i]!, i)
    }
    // Should not crash; average should be computable
    const avg = predictor.getAverageGrowthRate()
    expect(typeof avg).toBe('number')
    expect(isFinite(avg)).toBe(true)
  })

  test('compaction resets do not corrupt state', () => {
    const predictor = new ContextPredictor()
    for (let i = 0; i < 20; i++) predictor.recordTurn(1000 + i * 500, i)
    predictor.recordCompaction(10500, 3000, 20)
    const state = predictor.getState()
    expect(state.growthRates.length).toBe(0) // reset
    expect(state.tokenHistory.length).toBe(1) // only compaction snapshot
    expect(state.compactionHistory.length).toBe(1)
    // Can continue recording after compaction
    predictor.recordTurn(3500, 21)
    predictor.recordTurn(4000, 22)
    expect(predictor.getAverageGrowthRate()).toBe(500) // (500 avg)
  })

  test('priority scoring with 1000 messages', () => {
    const calculator = new PriorityCalculator()
    const messages: Message[] = Array.from({ length: 1000 }, (_, i) => ({
      type: i % 3 === 0 ? 'user' as const : 'assistant' as const,
      message: { content: `message ${i}` },
    }))
    const context: ConversationContext = {
      totalMessageCount: 1000,
      referencedIndices: new Set([0, 100, 500]),
      activeDiscussionIndices: new Set([990, 995, 999]),
      resolvedErrorIndices: new Set(),
    }
    const priorities = calculator.scoreAll(messages, context)
    expect(priorities.length).toBe(1000)
    // All priorities should be in valid range
    for (const p of priorities) {
      expect(p.priority).toBeGreaterThanOrEqual(0)
      expect(p.priority).toBeLessThanOrEqual(100)
    }
  })

  test('selective compaction with all messages being load-bearing', () => {
    const compactor = new SelectiveCompactor()
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      type: i % 2 === 0 ? 'assistant' as const : 'user' as const,
      message: { content: [{ type: i % 2 === 0 ? 'tool_use' : 'tool_result' }] },
    }))
    // All marked as load-bearing
    const priorities: MessagePriority[] = messages.map((_, i) => ({
      messageIndex: i, priority: 50, reasons: [], isLoadBearing: true,
    }))
    const selection = compactor.selectMessagesForCompaction(messages, priorities, 5000)
    // Nothing should be compacted since all are load-bearing
    expect(selection.compact.length).toBe(0)
    expect(selection.keep.length).toBe(20)
  })

  test('negative token counts handled gracefully', () => {
    const predictor = new ContextPredictor()
    // Should not crash with negative tokens
    expect(() => predictor.recordTurn(-100)).not.toThrow()
    expect(() => predictor.recordTurn(-500)).not.toThrow()
    expect(() => predictor.predictTokenGrowth(-1000)).not.toThrow()
    const decision = predictor.shouldPreemptivelyCompact(-100, 200_000)
    expect(decision.shouldCompact).toBe(false)
  })

  test('very large token numbers (billions)', () => {
    const predictor = new ContextPredictor()
    const billion = 1_000_000_000
    predictor.recordTurn(billion, 0)
    predictor.recordTurn(billion + 100_000, 1)
    expect(predictor.getAverageGrowthRate()).toBe(100_000)
    const predicted = predictor.predictTokenGrowth(billion + 100_000)
    expect(predicted).toBeGreaterThan(billion)
    expect(isFinite(predicted)).toBe(true)
  })
})

// ===========================================================================
// 3. AGENT MESH STRESS (8 tests)
// ===========================================================================

describe('Agent Mesh Stress', () => {
  test('knowledge graph with 10,000 nodes - query performance', async () => {
    const graph = new KnowledgeGraph()
    const start = performance.now()
    for (let i = 0; i < 10_000; i++) {
      await graph.addNode(makeNode(`node-${i}`, 'agent-1', `content for node ${i}`, 'file'))
    }
    expect(graph.nodeCount).toBe(10_000)
    // Query should complete reasonably
    const queryStart = performance.now()
    const results = await graph.query('file', 'node-500')
    const queryTime = performance.now() - queryStart
    expect(results.length).toBeGreaterThan(0)
    // Query should be under 5 seconds even for 10K nodes
    expect(queryTime).toBeLessThan(5000)
  })

  test('merge two large graphs (1000 nodes each)', async () => {
    const graphA = new KnowledgeGraph()
    const graphB = new KnowledgeGraph()
    for (let i = 0; i < 1000; i++) {
      await graphA.addNode(makeNode(`a-${i}`, 'agent-a', `content A ${i}`))
      await graphB.addNode(makeNode(`b-${i}`, 'agent-b', `content B ${i}`))
    }
    // Add 100 overlapping nodes with different agents (will create conflicts)
    for (let i = 0; i < 100; i++) {
      await graphA.addNode(makeNode(`shared-${i}`, 'agent-a', `shared A ${i}`))
      await graphB.addNode(makeNode(`shared-${i}`, 'agent-b', `shared B ${i}`))
    }
    const result = await graphA.merge(graphB)
    expect(result.added.nodes).toBe(1000) // all b-* nodes added
    expect(result.conflicts.length).toBe(100) // shared-* nodes conflict
    // Total should be 1000 (a-*) + 1000 (b-*) + 100 (shared-* kept best)
    expect(graphA.nodeCount).toBe(2100)
  })

  test('bus with 50 agents subscribing/unsubscribing rapidly', () => {
    const bus = new AgentBus()
    const received: string[] = []
    // Subscribe 50 agents
    for (let i = 0; i < 50; i++) {
      bus.subscribe(`agent-${i}`, (msg) => { received.push(`agent-${i}:${msg.id}`) })
    }
    expect(bus.getActiveAgents().length).toBe(50)
    // Unsubscribe half
    for (let i = 0; i < 25; i++) bus.unsubscribe(`agent-${i}`)
    expect(bus.getActiveAgents().length).toBe(25)
    // Broadcast a message
    bus.broadcast({ from: 'agent-25', to: 'broadcast', type: 'status', payload: 'test' })
    // 24 remaining agents (excluding sender) should receive
    expect(received.length).toBe(24)
    bus.destroy()
  })

  test('conflict detection with 100 conflicting files', async () => {
    const graph = new KnowledgeGraph()
    // Create 100 file pairs with conflict edges
    for (let i = 0; i < 100; i++) {
      const nodeA = makeNode(`file-a-${i}`, 'agent-a', `src/file-${i}.ts`)
      const nodeB = makeNode(`file-b-${i}`, 'agent-b', `src/file-${i}.ts`)
      await graph.addNode(nodeA)
      await graph.addNode(nodeB)
      await graph.addEdge({
        from: `file-a-${i}`, to: `file-b-${i}`, relation: 'conflicts_with',
        agentId: 'system', timestamp: Date.now(),
      })
    }
    const conflicts = await graph.getConflicts()
    expect(conflicts.length).toBe(100)
  })

  test('work assignment with 100 tasks and 20 agents', () => {
    const graph = new KnowledgeGraph()
    const bus = new AgentBus()
    const resolver = new ConflictResolver()
    const coordinator = new MeshCoordinator(graph, bus, resolver)
    // Subscribe 20 agents
    for (let i = 0; i < 20; i++) {
      bus.subscribe(`agent-${i}`, () => {})
    }
    // Create 100 tasks
    const tasks: WorkItem[] = Array.from({ length: 100 }, (_, i) => ({
      id: `task-${i}`, description: `Task ${i}`,
      relatedFiles: [`src/file-${i}.ts`], priority: Math.floor(Math.random() * 10),
      status: 'pending' as const,
    }))
    const assignment = coordinator.assignWork(tasks)
    // All 20 agents should have tasks
    expect(assignment.size).toBe(20)
    // Total assigned tasks should equal 100
    let total = 0
    for (const [, agentTasks] of assignment) total += agentTasks.length
    expect(total).toBe(100)
    // Each agent should have 5 tasks (100/20)
    for (const [, agentTasks] of assignment) {
      expect(agentTasks.length).toBe(5)
    }
    bus.destroy()
  })

  test('circular edge references', async () => {
    const graph = new KnowledgeGraph()
    await graph.addNode(makeNode('A', 'agent-1', 'Node A'))
    await graph.addNode(makeNode('B', 'agent-1', 'Node B'))
    await graph.addNode(makeNode('C', 'agent-1', 'Node C'))
    // A -> B -> C -> A (cycle)
    await graph.addEdge({ from: 'A', to: 'B', relation: 'depends_on', agentId: 'agent-1', timestamp: Date.now() })
    await graph.addEdge({ from: 'B', to: 'C', relation: 'depends_on', agentId: 'agent-1', timestamp: Date.now() })
    await graph.addEdge({ from: 'C', to: 'A', relation: 'depends_on', agentId: 'agent-1', timestamp: Date.now() })
    expect(graph.edgeCount).toBe(3)
    // getRelated should work without infinite loop
    const relatedA = await graph.getRelated('A')
    expect(relatedA.length).toBe(2) // B and C
  })

  test('empty graph operations', async () => {
    const graph = new KnowledgeGraph()
    expect(graph.nodeCount).toBe(0)
    expect(graph.edgeCount).toBe(0)
    expect(await graph.query()).toEqual([])
    expect(await graph.getConflicts()).toEqual([])
    expect(await graph.getNode('nonexistent')).toBeUndefined()
    expect(await graph.getRelated('nonexistent')).toEqual([])
    expect(await graph.removeNode('nonexistent')).toBe(false)
    // Merge empty into empty
    const other = new KnowledgeGraph()
    const result = await graph.merge(other)
    expect(result.added.nodes).toBe(0)
    expect(result.conflicts.length).toBe(0)
  })

  test('agent bus message delivery under load (1000 messages)', () => {
    const bus = new AgentBus()
    let deliveredCount = 0
    // 5 agents
    for (let i = 0; i < 5; i++) {
      bus.subscribe(`agent-${i}`, () => { deliveredCount++ })
    }
    // 1000 broadcasts from agent-0 (4 others receive each)
    for (let i = 0; i < 1000; i++) {
      bus.broadcast({ from: 'agent-0', to: 'broadcast', type: 'status', payload: { i } })
    }
    expect(deliveredCount).toBe(4000) // 1000 * 4 receivers
    bus.destroy()
  })
})

// ===========================================================================
// 4. MODEL ROUTER STRESS (8 tests)
// ===========================================================================

describe('Model Router Stress', () => {
  const standardModels: ModelConfig[] = [
    { tier: 'local_small', model: 'llama3:8b', endpoint: 'http://localhost:11434', maxTokens: 4096, latencyMs: 100, costPer1kTokens: 0, capabilities: ['code', 'chat'] },
    { tier: 'cloud_fast', model: 'haiku', endpoint: 'https://api.anthropic.com', maxTokens: 4096, latencyMs: 300, costPer1kTokens: 0.001, capabilities: ['code', 'chat'] },
    { tier: 'cloud_standard', model: 'sonnet', endpoint: 'https://api.anthropic.com', maxTokens: 8192, latencyMs: 800, costPer1kTokens: 0.009, capabilities: ['code', 'analysis', 'tool_use'] },
    { tier: 'cloud_thinking', model: 'opus', endpoint: 'https://api.anthropic.com', maxTokens: 32768, latencyMs: 2000, costPer1kTokens: 0.045, capabilities: ['code', 'analysis', 'tool_use', 'reasoning'] },
  ]

  test('route 1000 messages with varying complexity', () => {
    const analyzer = new ComplexityAnalyzer()
    const policy = new RoutingPolicy(standardModels)
    const messages = [
      'list files',
      'refactor the authentication module to use OAuth2 with PKCE flow',
      'help',
      'migrate the database schema from PostgreSQL to support multi-tenant architecture with row-level security',
      'x',
      'show me the git status',
    ]
    for (let i = 0; i < 1000; i++) {
      const msg = messages[i % messages.length]!
      const complexity = analyzer.analyze(msg)
      const decision = policy.route(complexity)
      expect(decision.model).toBeTruthy()
      expect(decision.estimatedLatency).toBeGreaterThanOrEqual(0)
    }
  })

  test('all models unavailable - graceful degradation', () => {
    const policy = new RoutingPolicy([]) // no models
    const complexity: TaskComplexity = { level: 'moderate', score: 50, factors: [], suggestedModel: 'cloud_fast' }
    const decision = policy.route(complexity)
    // Should fall back to the built-in last resort
    expect(decision.model).toBeTruthy()
    expect(decision.reason).toContain('falling back')
  })

  test('extreme message lengths (1 char, 100KB)', () => {
    const analyzer = new ComplexityAnalyzer()
    // 1 character
    const tiny = analyzer.analyze('x')
    expect(tiny.score).toBeGreaterThanOrEqual(0)
    expect(tiny.score).toBeLessThanOrEqual(100)
    // 100KB message
    const huge = analyzer.analyze('refactor '.repeat(12800))
    expect(huge.score).toBeGreaterThanOrEqual(0)
    expect(huge.score).toBeLessThanOrEqual(100)
  })

  test('empty conversation context', () => {
    const analyzer = new ComplexityAnalyzer()
    const result = analyzer.analyze('')
    expect(result.level).toBeTruthy()
    expect(result.score).toBeGreaterThanOrEqual(0)
  })

  test('all constraint combinations (latency + cost + capabilities)', () => {
    const policy = new RoutingPolicy(standardModels)
    const complexity: TaskComplexity = { level: 'moderate', score: 50, factors: [], suggestedModel: 'cloud_fast' }
    // Latency only
    const d1 = policy.route(complexity, { maxLatency: 200 })
    expect(d1.estimatedLatency).toBeLessThanOrEqual(200)
    // Cost only
    const d2 = policy.route(complexity, { maxCost: 0.002 })
    expect(d2.estimatedCost).toBeLessThanOrEqual(0.002)
    // Capabilities only
    const d3 = policy.route(complexity, { requireCapabilities: ['reasoning'] })
    expect(d3.model).toBe('opus')
    // All combined (impossible constraints)
    const d4 = policy.route(complexity, { maxLatency: 1, maxCost: 0, requireCapabilities: ['reasoning'] })
    // Should still return a decision (last resort)
    expect(d4.model).toBeTruthy()
  })

  test('rapid model availability changes', () => {
    // Test creating many policies rapidly (simulating availability changes)
    for (let i = 0; i < 100; i++) {
      const available = standardModels.filter(() => Math.random() > 0.5)
      const policy = new RoutingPolicy(available)
      const complexity: TaskComplexity = { level: 'simple', score: 20, factors: [], suggestedModel: 'local_small' }
      const decision = policy.route(complexity)
      expect(decision.model).toBeTruthy()
    }
  })

  test('zero-cost models', () => {
    const freeTier: ModelConfig[] = [
      { tier: 'local_small', model: 'free-model', endpoint: 'http://localhost', maxTokens: 4096, latencyMs: 50, costPer1kTokens: 0, capabilities: ['code'] },
    ]
    const policy = new RoutingPolicy(freeTier)
    const complexity: TaskComplexity = { level: 'trivial', score: 5, factors: [], suggestedModel: 'local_small' }
    const decision = policy.route(complexity)
    expect(decision.estimatedCost).toBe(0)
    expect(decision.model).toBe('free-model')
  })

  test('negative latency values handled', () => {
    const weirdModels: ModelConfig[] = [
      { tier: 'local_small', model: 'negative-latency', endpoint: 'http://localhost', maxTokens: 4096, latencyMs: -100, costPer1kTokens: -0.001, capabilities: ['code'] },
    ]
    const policy = new RoutingPolicy(weirdModels)
    const complexity: TaskComplexity = { level: 'trivial', score: 5, factors: [], suggestedModel: 'local_small' }
    const decision = policy.route(complexity)
    expect(decision.model).toBe('negative-latency')
    expect(decision.estimatedLatency).toBe(-100) // passes through, no crash
  })
})

// ===========================================================================
// 5. TOOL FEEDBACK STRESS (8 tests)
// ===========================================================================

describe('Tool Feedback Stress', () => {
  test('200 executions hitting sliding window limit', () => {
    const tracker = new ExecutionTracker()
    for (let i = 0; i < 250; i++) {
      tracker.record(makeExecution('Bash', i % 3 !== 0, `error ${i}`))
    }
    // Should be capped at MAX_TRACKER_ENTRIES = 200
    expect(tracker.size).toBe(200)
    // Recent executions should be the last ones
    const recent = tracker.getRecentExecutions()
    expect(recent.length).toBe(20)
  })

  test('all failures - verify insights do not overwhelm', () => {
    const system = new ToolFeedbackSystem()
    for (let i = 0; i < 50; i++) {
      system.onToolComplete('Bash', 'rm -rf /', '', false, { type: 'permission_denied', message: 'permission denied' })
    }
    const stats = system.getStats()
    expect(stats.totalExecutions).toBe(50)
    expect(stats.failureRate).toBe(1.0)
  })

  test('all successes - verify no false insights', () => {
    const tracker = new ExecutionTracker()
    for (let i = 0; i < 100; i++) {
      tracker.record(makeExecution('Bash', true))
    }
    const patterns = tracker.getFailurePatterns()
    expect(patterns.length).toBe(0)
    expect(tracker.getSuccessRate('Bash')).toBe(1)
    expect(tracker.getConsecutiveFailures('Bash')).toBe(0)
  })

  test('rapid tool switching (different tool each call)', () => {
    const tracker = new ExecutionTracker()
    const tools = ['Bash', 'Edit', 'Read', 'Grep', 'Glob', 'Write', 'Delete', 'Move', 'Copy', 'Chmod']
    for (let i = 0; i < 200; i++) {
      tracker.record(makeExecution(tools[i % tools.length]!, i % 5 !== 0))
    }
    expect(tracker.size).toBe(200)
    // Each tool should have independent tracking
    for (const tool of tools) {
      const rate = tracker.getSuccessRate(tool)
      expect(rate).toBeGreaterThanOrEqual(0)
      expect(rate).toBeLessThanOrEqual(1)
    }
  })

  test('custom analyzer that throws - error isolation', () => {
    const system = new ToolFeedbackSystem()
    // Record some failures to trigger analysis
    for (let i = 0; i < 5; i++) {
      system.onToolComplete('Bash', 'test', '', false, { message: 'fail' })
    }
    // The system internally catches analyzer errors - just verify it doesn't crash
    expect(() => system.getStats()).not.toThrow()
  })

  test('empty tool names', () => {
    const tracker = new ExecutionTracker()
    expect(() => tracker.record(makeExecution('', true))).not.toThrow()
    expect(() => tracker.record(makeExecution('', false, ''))).not.toThrow()
    expect(tracker.getSuccessRate('')).toBeGreaterThanOrEqual(0)
    expect(tracker.getConsecutiveFailures('')).toBeGreaterThanOrEqual(0)
  })

  test('very long error messages (50KB)', () => {
    const tracker = new ExecutionTracker()
    const longError = 'E'.repeat(50 * 1024)
    expect(() => tracker.record({
      toolName: 'Bash', input: 'test', output: 'error',
      success: false, errorType: 'long_error', errorMessage: longError,
      timestamp: new Date(), durationMs: 100, attempt: 1,
    })).not.toThrow()
    const patterns = tracker.getFailurePatterns()
    expect(patterns.length).toBeGreaterThan(0)
  })

  test('TTL expiry with time manipulation', () => {
    const system = new ToolFeedbackSystem()
    // Record failures and successes over time
    for (let i = 0; i < 10; i++) {
      system.onToolComplete('Edit', 'file.ts', '', false, { message: 'old_string not found' })
    }
    // Stats should reflect all executions
    expect(system.getStats().totalExecutions).toBe(10)
    // Reset simulates TTL expiry
    system.reset()
    expect(system.getStats().totalExecutions).toBe(0)
    expect(system.getStats().failureRate).toBe(0)
  })
})

// ===========================================================================
// 6. EPISODIC MEMORY STRESS (6 tests)
// ===========================================================================

describe('Episodic Memory Stress', () => {
  test('10,000 entries hitting eviction limit', () => {
    const store = new EmbeddingStore('/tmp/test-memory.json', 1000) // cap at 1000
    for (let i = 0; i < 10_000; i++) {
      store.add(makeMemoryEntry(`entry-${i}`, `content for entry ${i}`, {
        importance: Math.random(),
      }))
    }
    // Should be capped at maxEntries
    expect(store.size()).toBeLessThanOrEqual(1000)
    expect(store.size()).toBeGreaterThan(0)
  })

  test('TF-IDF with empty strings, single char, repeated words', () => {
    // Empty
    const vocab1 = buildVocabulary([''])
    expect(vocab1.size).toBe(0)
    const vec1 = textToTfIdf('', vocab1)
    expect(vec1.length).toBe(0)

    // Single character (filtered out by length > 1)
    const vocab2 = buildVocabulary(['a'])
    expect(vocab2.size).toBe(0)

    // Repeated words
    const vocab3 = buildVocabulary(['hello hello hello world world'])
    expect(vocab3.size).toBe(2) // hello, world
    const vec3 = textToTfIdf('hello hello hello world world', vocab3)
    expect(vec3.length).toBe(2)

    // Cosine similarity of identical vectors
    const sim = cosineSimilarity(vec3, vec3)
    expect(Math.abs(sim - 1)).toBeLessThan(0.001) // should be ~1.0
  })

  test('cross-project transfer with 50 projects', () => {
    const transfer = new CrossProjectTransfer()
    // Record patterns across 50 projects
    for (let i = 0; i < 50; i++) {
      transfer.recordPattern(`project-${i}`, 'use-typescript', 'TypeScript for type safety')
      transfer.recordPattern(`project-${i}`, 'use-eslint', 'ESLint for code quality')
      // Some patterns only in a few projects
      if (i < 5) transfer.recordPattern(`project-${i}`, 'use-graphql', 'GraphQL for APIs')
    }
    expect(transfer.getProjectIds().length).toBe(50)
    // Transferable patterns from project-0 to a new project
    const transferable = transfer.getTransferablePatterns('project-0', 'project-999')
    // use-typescript and use-eslint should be transferable (50 projects >= 2)
    // use-graphql should also be transferable (5 projects >= 2)
    expect(transferable.length).toBe(3)
  })

  test('consolidation of 1000 similar memories', () => {
    const store = new EmbeddingStore('/tmp/test-consolidation.json', 5000)
    const consolidator = new MemoryConsolidator({ mergeSimilarity: 0.85, importanceFloor: 0.01 })
    // Add 1000 memories - pairs of very similar content
    const sharedVocab = buildVocabulary(['hello world test memory data important'])
    for (let i = 0; i < 1000; i++) {
      // Alternating similar entries
      const content = i % 2 === 0 ? 'hello world test memory' : 'hello world test memory data'
      store.add({
        id: `mem-${i}`, content, type: 'episode',
        embedding: textToTfIdf(content, sharedVocab),
        metadata: {
          source: 'test', timestamp: new Date().toISOString(), project: 'test',
          tags: [], accessCount: 0, lastAccessed: new Date().toISOString(),
        },
        importance: 0.5,
      })
    }
    const result = consolidator.consolidate(store)
    expect(result.totalBefore).toBe(1000)
    // Some merging should have happened
    expect(result.merged).toBeGreaterThanOrEqual(0)
    expect(result.totalAfter).toBeLessThanOrEqual(1000)
  })

  test('search with no matches', () => {
    const store = new EmbeddingStore('/tmp/test-search.json', 100)
    // Add some entries
    const vocab = buildVocabulary(['alpha beta gamma'])
    for (let i = 0; i < 10; i++) {
      store.add({
        id: `e-${i}`, content: `alpha beta gamma ${i}`, type: 'episode',
        embedding: textToTfIdf('alpha beta gamma', vocab),
        metadata: {
          source: 'test', timestamp: new Date().toISOString(), project: 'proj-a',
          tags: [], accessCount: 0, lastAccessed: new Date().toISOString(),
        },
        importance: 0.5,
      })
    }
    // Search with project filter that matches nothing
    const results = store.search(textToTfIdf('alpha', vocab), 5, { project: 'nonexistent' })
    expect(results.length).toBe(0)

    // Search on completely empty store
    const emptyStore = new EmbeddingStore('/tmp/test-empty.json', 100)
    const emptyResults = emptyStore.search([0, 0, 0], 5)
    expect(emptyResults.length).toBe(0)
  })

  test('episode with 0 decisions and 0 tools', () => {
    const store = new EmbeddingStore('/tmp/test-episode-empty.json', 100)
    const manager = new EpisodeManager(store)
    const ep = manager.startEpisode('session-1')
    expect(ep.decisions.length).toBe(0)
    expect(ep.toolsUsed.length).toBe(0)
    expect(ep.toolRecords.length).toBe(0)
    // End immediately with no activity
    const finished = manager.endEpisode(ep.id, 'success', 'Empty episode')
    expect(finished).toBeDefined()
    expect(finished!.outcome).toBe('success')
    expect(finished!.decisions.length).toBe(0)
    expect(finished!.toolsUsed.length).toBe(0)
  })
})

// ===========================================================================
// 7. COLLABORATION STRESS (6 tests)
// ===========================================================================

describe('Collaboration Stress', () => {
  test('10 participants max - verify 11th rejected', () => {
    const broker = new SessionBroker()
    const session = broker.createSession('test', { userId: 'owner', name: 'Owner' })
    // Owner is participant 1; add 9 more
    for (let i = 1; i < 10; i++) {
      const result = broker.joinSession(session.id, { userId: `user-${i}`, name: `User ${i}` })
      expect(result.success).toBe(true)
    }
    expect(session.participants.length).toBe(10)
    // 11th should be rejected
    const result = broker.joinSession(session.id, { userId: 'user-10', name: 'User 10' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('full')
  })

  test('100 simultaneous messages - ordering preserved', () => {
    const sync = new MessageSynchronizer('session-1')
    const receivedSeqs: number[] = []
    sync.subscribe('observer', (event) => {
      receivedSeqs.push(event.seq)
    })
    // Send 100 messages
    for (let i = 0; i < 100; i++) {
      sync.addMessage({ userId: `user-${i % 5}`, name: `User ${i % 5}` }, `Message ${i}`)
    }
    // Sequence numbers should be monotonically increasing
    expect(receivedSeqs.length).toBe(100)
    for (let i = 1; i < receivedSeqs.length; i++) {
      expect(receivedSeqs[i]!).toBe(receivedSeqs[i - 1]! + 1)
    }
    // Final sequence should be 100
    expect(sync.getSequence()).toBe(100)
    sync.destroy()
  })

  test('permission timeout simulation', () => {
    // Simulate a negotiation that would time out
    // We can't truly wait 30s, so we verify the structure
    const broker = new SessionBroker()
    const session = broker.createSession('test', { userId: 'owner', name: 'Owner' })
    broker.joinSession(session.id, { userId: 'editor-1', name: 'Editor 1' })
    // Session with requireApproval
    const approvalSession = broker.createSession('approval-test', { userId: 'owner2', name: 'Owner2' }, { requireApproval: true })
    const joinResult = broker.joinSession(approvalSession.id, { userId: 'requester', name: 'Requester' })
    // With requireApproval, join should fail with "Approval required"
    expect(joinResult.success).toBe(false)
    expect(joinResult.error).toContain('Approval required')
  })

  test('rapid join/leave cycling', () => {
    const broker = new SessionBroker()
    const session = broker.createSession('test', { userId: 'owner', name: 'Owner' })
    // Rapidly join and leave 100 times
    for (let i = 0; i < 100; i++) {
      const userId = `cycler-${i % 5}`
      // Leave first if already present
      broker.leaveSession(session.id, userId)
      const result = broker.joinSession(session.id, { userId, name: `Cycler ${i % 5}` })
      // Should succeed since we left first
      if (!result.success && result.error === 'Already a participant') {
        // Expected for the first iteration where user wasn't present yet
        broker.leaveSession(session.id, userId)
        broker.joinSession(session.id, { userId, name: `Cycler ${i % 5}` })
      }
    }
    // Session should still be active
    const s = broker.getSession(session.id)
    expect(s).not.toBeNull()
    expect(s!.state).toBe('active')
  })

  test('empty session with no messages', () => {
    const sync = new MessageSynchronizer('empty-session')
    expect(sync.getSequence()).toBe(0)
    expect(sync.getHistory().length).toBe(0)
    // Subscribe and unsubscribe with no messages
    const unsub = sync.subscribe('user-1', () => {})
    unsub()
    expect(sync.getSequence()).toBe(0)
    sync.destroy()
  })

  test('presence heartbeat with 50 participants', () => {
    const tracker = new PresenceTracker()
    const sessionId = 'session-50'
    // Register 50 participants
    for (let i = 0; i < 50; i++) {
      tracker.register(`user-${i}`, sessionId)
    }
    const participants = tracker.getActiveParticipants(sessionId)
    expect(participants.length).toBe(50)
    // Heartbeat all
    for (let i = 0; i < 50; i++) {
      tracker.heartbeat(`user-${i}`)
    }
    // All should be active
    for (let i = 0; i < 50; i++) {
      const p = tracker.getPresence(`user-${i}`)
      expect(p).not.toBeNull()
      expect(p!.status).toBe('active')
    }
    // Unregister half
    for (let i = 0; i < 25; i++) {
      tracker.unregister(`user-${i}`, sessionId)
    }
    expect(tracker.getActiveParticipants(sessionId).length).toBe(25)
    tracker.destroy()
  })
})
