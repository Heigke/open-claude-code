/**
 * Structured Episodic Memory - Memory Consolidator
 *
 * Performs periodic maintenance on the embedding store:
 *   - Merges semantically similar memories (cosine sim > 0.85)
 *   - Decays old memories based on time since last access
 *   - Promotes frequently accessed memories
 *   - Removes memories that drop below a minimum importance threshold
 */

import { EmbeddingStore, cosineSimilarity } from './embeddingStore.js'
import type { MemoryEntry } from './embeddingStore.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsolidationResult = {
  merged: number
  decayed: number
  promoted: number
  removed: number
  totalBefore: number
  totalAfter: number
}

export type ConsolidatorOptions = {
  /** Cosine similarity threshold above which two memories are merged */
  mergeSimilarity: number
  /** Daily decay multiplier applied to importance */
  decayRate: number
  /** Importance boost per access count */
  accessBoost: number
  /** Minimum importance; entries below this are removed */
  importanceFloor: number
}

const DEFAULT_OPTIONS: ConsolidatorOptions = {
  mergeSimilarity: 0.85,
  decayRate: 0.95,
  accessBoost: 0.01,
  importanceFloor: 0.05,
}

// ---------------------------------------------------------------------------
// Memory Consolidator
// ---------------------------------------------------------------------------

export class MemoryConsolidator {
  private readonly options: ConsolidatorOptions
  private episodesSinceConsolidation = 0
  private lastConsolidation: string | null = null

  constructor(options?: Partial<ConsolidatorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** Run a full consolidation pass on the store. */
  consolidate(store: EmbeddingStore): ConsolidationResult {
    const totalBefore = store.size()
    let merged = 0
    let decayed = 0
    let promoted = 0
    let removed = 0

    // 1. Decay & promote
    const entries = store.getAllEntries()
    const now = Date.now()

    for (const entry of entries) {
      const daysSinceAccess =
        (now - new Date(entry.metadata.lastAccessed).getTime()) / (1000 * 60 * 60 * 24)

      // Decay based on days since last access
      if (daysSinceAccess > 0) {
        const decayFactor = Math.pow(this.options.decayRate, daysSinceAccess)
        const before = entry.importance
        entry.importance *= decayFactor
        if (entry.importance < before) decayed++
      }

      // Promote frequently accessed
      if (entry.metadata.accessCount > 0) {
        const boost = entry.metadata.accessCount * this.options.accessBoost
        const before = entry.importance
        entry.importance = Math.min(1, entry.importance + boost)
        if (entry.importance > before) promoted++
      }
    }

    // 2. Remove below threshold
    const toRemove: string[] = []
    for (const entry of store.getAllEntries()) {
      if (entry.importance < this.options.importanceFloor) {
        toRemove.push(entry.id)
      }
    }
    for (const id of toRemove) {
      store.remove(id)
      removed++
    }

    // 3. Merge similar memories
    merged = this.mergeSimilar(store)

    this.episodesSinceConsolidation = 0
    this.lastConsolidation = new Date().toISOString()

    return {
      merged,
      decayed,
      promoted,
      removed,
      totalBefore,
      totalAfter: store.size(),
    }
  }

  /** Merge entries whose embeddings are above the similarity threshold.
   *  The merged entry keeps the higher importance and combined metadata. */
  private mergeSimilar(store: EmbeddingStore): number {
    let merged = 0
    const entries = store.getAllEntries()
    const consumed = new Set<string>()

    for (let i = 0; i < entries.length; i++) {
      const a = entries[i]
      if (consumed.has(a.id)) continue

      for (let j = i + 1; j < entries.length; j++) {
        const b = entries[j]
        if (consumed.has(b.id)) continue
        if (a.type !== b.type) continue // only merge same type

        const sim = cosineSimilarity(a.embedding, b.embedding)
        if (sim >= this.options.mergeSimilarity) {
          // Merge b into a
          this.mergeInto(a, b)
          store.remove(b.id)
          consumed.add(b.id)
          merged++
        }
      }
    }

    return merged
  }

  /** Merge entry `b` into entry `a`. */
  private mergeInto(a: MemoryEntry, b: MemoryEntry): void {
    // Keep higher importance, boosted slightly for being reinforced
    a.importance = Math.min(1, Math.max(a.importance, b.importance) + 0.05)

    // Combine content if they differ meaningfully
    if (a.content !== b.content) {
      a.content = `${a.content} | ${b.content}`
    }

    // Merge tags
    const tagSet = new Set([...a.metadata.tags, ...b.metadata.tags])
    a.metadata.tags = Array.from(tagSet)

    // Sum access counts
    a.metadata.accessCount += b.metadata.accessCount

    // Keep the more recent lastAccessed
    if (new Date(b.metadata.lastAccessed) > new Date(a.metadata.lastAccessed)) {
      a.metadata.lastAccessed = b.metadata.lastAccessed
    }
  }

  /** Track episode completions for scheduled consolidation. */
  recordEpisodeCompletion(): void {
    this.episodesSinceConsolidation++
  }

  /** Whether consolidation should run based on episode count or time. */
  shouldConsolidate(episodeThreshold = 20, hoursThreshold = 24): boolean {
    if (this.episodesSinceConsolidation >= episodeThreshold) return true

    if (this.lastConsolidation) {
      const hoursSince =
        (Date.now() - new Date(this.lastConsolidation).getTime()) / (1000 * 60 * 60)
      return hoursSince >= hoursThreshold
    }

    // Never consolidated before
    return true
  }

  getEpisodesSinceConsolidation(): number {
    return this.episodesSinceConsolidation
  }

  getLastConsolidation(): string | null {
    return this.lastConsolidation
  }
}
