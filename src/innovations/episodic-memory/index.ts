/**
 * Structured Episodic Memory
 *
 * A vector-indexed memory system with TF-IDF embeddings, episode
 * lifecycle tracking, cross-project knowledge transfer, and
 * automatic memory consolidation.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'

// Core store
export { EmbeddingStore, cosineSimilarity, buildVocabulary, textToTfIdf, normalise } from './embeddingStore.js'
export type {
  EmbeddingVector,
  MemoryEntry,
  MemoryType,
  MemoryMetadata,
  ScoredEntry,
  SearchFilters,
} from './embeddingStore.js'

// Episode management
export { EpisodeManager } from './episodeManager.js'
export type { Episode, Decision, ToolUseRecord } from './episodeManager.js'

// Cross-project transfer
export { CrossProjectTransfer } from './crossProjectTransfer.js'
export type {
  ProjectProfile,
  LearnedPattern,
  UserPreference,
  TransferSuggestion,
} from './crossProjectTransfer.js'

// Consolidation
export { MemoryConsolidator } from './memoryConsolidator.js'
export type { ConsolidationResult, ConsolidatorOptions } from './memoryConsolidator.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type EpisodicMemory = {
  store: import('./embeddingStore.js').EmbeddingStore
  episodes: import('./episodeManager.js').EpisodeManager
  transfer: import('./crossProjectTransfer.js').CrossProjectTransfer
  consolidator: import('./memoryConsolidator.js').MemoryConsolidator
}

export function createEpisodicMemory(options?: {
  storagePath?: string
  maxEntries?: number
}): EpisodicMemory {
  const storagePath =
    options?.storagePath ?? join(homedir(), '.claude', 'episodic-memory.json')
  const maxEntries = options?.maxEntries ?? 10_000

  const store = new EmbeddingStore(storagePath, maxEntries)
  store.load()

  const episodes = new EpisodeManager(store)
  const transfer = new CrossProjectTransfer()
  const consolidator = new MemoryConsolidator()

  return { store, episodes, transfer, consolidator }
}
