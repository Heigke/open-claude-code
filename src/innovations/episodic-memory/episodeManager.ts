/**
 * Structured Episodic Memory - Episode Manager
 *
 * Tracks full episode lifecycles: start, decision recording, tool
 * usage, and finalisation with outcome summaries. Provides retrieval
 * of recent and semantically similar episodes via the embedding store.
 */

import { EmbeddingStore } from './embeddingStore.js'
import type { MemoryEntry, EmbeddingVector } from './embeddingStore.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Decision = {
  description: string
  reasoning: string
  timestamp: string
  confidence: number // 0-1
}

export type ToolUseRecord = {
  toolName: string
  input: string
  output: string
  success: boolean
  timestamp: string
}

export type Episode = {
  id: string
  sessionId: string
  startTime: string
  endTime: string | null
  summary: string
  decisions: Decision[]
  toolsUsed: string[]
  filesModified: string[]
  outcome: 'success' | 'failure' | 'partial' | 'abandoned' | null
  /** Detailed tool use records (not persisted to embedding store) */
  toolRecords: ToolUseRecord[]
}

// ---------------------------------------------------------------------------
// Episode Manager
// ---------------------------------------------------------------------------

export class EpisodeManager {
  private episodes = new Map<string, Episode>()
  /** Insertion-ordered list for stable recency queries */
  private orderedIds: string[] = []
  private readonly store: EmbeddingStore
  private nextId = 1

  constructor(store: EmbeddingStore) {
    this.store = store
  }

  /** Start a new episode and return it. */
  startEpisode(sessionId: string): Episode {
    const id = `ep-${Date.now()}-${this.nextId++}`
    const episode: Episode = {
      id,
      sessionId,
      startTime: new Date().toISOString(),
      endTime: null,
      summary: '',
      decisions: [],
      toolsUsed: [],
      filesModified: [],
      outcome: null,
      toolRecords: [],
    }
    this.episodes.set(id, episode)
    this.orderedIds.push(id)
    return episode
  }

  /** Record a decision within an episode. */
  recordDecision(episodeId: string, decision: Omit<Decision, 'timestamp'>): void {
    const ep = this.episodes.get(episodeId)
    if (!ep) return
    ep.decisions.push({
      ...decision,
      timestamp: new Date().toISOString(),
    })
  }

  /** Record a tool usage within an episode. */
  recordToolUse(
    episodeId: string,
    toolName: string,
    input: string,
    output: string,
    success: boolean,
  ): void {
    const ep = this.episodes.get(episodeId)
    if (!ep) return

    if (!ep.toolsUsed.includes(toolName)) {
      ep.toolsUsed.push(toolName)
    }

    ep.toolRecords.push({
      toolName,
      input,
      output,
      success,
      timestamp: new Date().toISOString(),
    })
  }

  /** Record that a file was modified during an episode. */
  recordFileModified(episodeId: string, filePath: string): void {
    const ep = this.episodes.get(episodeId)
    if (!ep) return
    if (!ep.filesModified.includes(filePath)) {
      ep.filesModified.push(filePath)
    }
  }

  /** Finalise an episode with an outcome and optional summary.
   *  Generates a summary if none is provided and stores it in the
   *  embedding store for future similarity search. */
  endEpisode(
    episodeId: string,
    outcome: Episode['outcome'],
    summary?: string,
  ): Episode | undefined {
    const ep = this.episodes.get(episodeId)
    if (!ep) return undefined

    ep.endTime = new Date().toISOString()
    ep.outcome = outcome
    ep.summary = summary ?? this.generateEpisodeSummary(ep)

    // Persist to embedding store
    const content = ep.summary
    this.store.rebuildVocabulary([content])
    const embedding = this.store.embed(content)

    const memoryEntry: MemoryEntry = {
      id: ep.id,
      content,
      type: 'episode',
      embedding,
      metadata: {
        source: `session:${ep.sessionId}`,
        timestamp: ep.startTime,
        project: '',
        tags: [...ep.toolsUsed, ...(ep.outcome ? [ep.outcome] : [])],
        accessCount: 0,
        lastAccessed: new Date().toISOString(),
      },
      importance: this.computeImportance(ep),
    }
    this.store.add(memoryEntry)

    return ep
  }

  /** Get an episode by ID. */
  getEpisode(id: string): Episode | undefined {
    return this.episodes.get(id)
  }

  /** Return the N most recent episodes, sorted newest-first (by insertion order). */
  getRecentEpisodes(limit = 10): Episode[] {
    const result: Episode[] = []
    for (let i = this.orderedIds.length - 1; i >= 0 && result.length < limit; i--) {
      const ep = this.episodes.get(this.orderedIds[i])
      if (ep) result.push(ep)
    }
    return result
  }

  /** Find episodes semantically similar to the given context string. */
  findSimilarEpisodes(context: string, topK = 3): Episode[] {
    this.store.rebuildVocabulary([context])
    const queryEmbed = this.store.embed(context)
    const scored = this.store.search(queryEmbed, topK, { type: 'episode' })
    return scored
      .map(s => this.episodes.get(s.entry.id))
      .filter((ep): ep is Episode => ep !== undefined)
  }

  /** Generate a template-based summary string for an episode (no API). */
  generateEpisodeSummary(episode: Episode): string {
    const parts: string[] = []

    const durationMs = episode.endTime
      ? new Date(episode.endTime).getTime() - new Date(episode.startTime).getTime()
      : 0
    const durationSec = Math.round(durationMs / 1000)

    parts.push(`Episode ${episode.id} (session ${episode.sessionId})`)

    if (durationSec > 0) {
      const mins = Math.floor(durationSec / 60)
      const secs = durationSec % 60
      parts.push(`Duration: ${mins}m ${secs}s`)
    }

    if (episode.outcome) {
      parts.push(`Outcome: ${episode.outcome}`)
    }

    if (episode.decisions.length > 0) {
      const decisionSummaries = episode.decisions.map(d => d.description).join('; ')
      parts.push(`Decisions: ${decisionSummaries}`)
    }

    if (episode.toolsUsed.length > 0) {
      parts.push(`Tools: ${episode.toolsUsed.join(', ')}`)
    }

    if (episode.filesModified.length > 0) {
      parts.push(`Files modified: ${episode.filesModified.join(', ')}`)
    }

    const successRate =
      episode.toolRecords.length > 0
        ? Math.round(
            (episode.toolRecords.filter(r => r.success).length / episode.toolRecords.length) * 100,
          )
        : null

    if (successRate !== null) {
      parts.push(`Tool success rate: ${successRate}%`)
    }

    return parts.join('. ')
  }

  /** Derive an importance score (0-1) for an episode. */
  private computeImportance(episode: Episode): number {
    let score = 0.3 // base

    // Outcomes
    if (episode.outcome === 'success') score += 0.2
    else if (episode.outcome === 'failure') score += 0.3 // failures are valuable to remember

    // Complexity signals
    if (episode.decisions.length > 2) score += 0.1
    if (episode.toolsUsed.length > 3) score += 0.1
    if (episode.filesModified.length > 3) score += 0.1

    // High-confidence decisions are more noteworthy
    const avgConfidence =
      episode.decisions.length > 0
        ? episode.decisions.reduce((s, d) => s + d.confidence, 0) / episode.decisions.length
        : 0
    score += avgConfidence * 0.1

    return Math.min(1, Math.max(0, score))
  }
}
