/**
 * Structured Episodic Memory - Embedding Store
 *
 * A vector-indexed memory store using TF-IDF embeddings and cosine
 * similarity for local-only semantic search. No external API calls.
 *
 * Persistence is handled via JSON serialisation to disk. The store
 * enforces a configurable max-entry cap with LRU eviction weighted
 * by importance and recency.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EmbeddingVector = number[]

export type MemoryType = 'episode' | 'semantic' | 'procedural'

export type MemoryMetadata = {
  source: string
  timestamp: string
  project: string
  tags: string[]
  accessCount: number
  lastAccessed: string
}

export type MemoryEntry = {
  id: string
  content: string
  type: MemoryType
  embedding: EmbeddingVector
  metadata: MemoryMetadata
  importance: number // 0-1
}

export type ScoredEntry = {
  entry: MemoryEntry
  score: number
}

export type SearchFilters = {
  type?: MemoryType
  project?: string
  tags?: string[]
  minImportance?: number
}

/** Serialised form stored on disk */
type StoreData = {
  version: 1
  entries: MemoryEntry[]
  vocabulary: Record<string, number>
}

// ---------------------------------------------------------------------------
// TF-IDF Embedding Generation (local, no API)
// ---------------------------------------------------------------------------

/** Tokenise text into lowercase alphanumeric terms */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
}

/** Build a vocabulary mapping from a corpus of texts. Each unique term
 *  gets a stable integer index. */
export function buildVocabulary(texts: string[]): Map<string, number> {
  const vocab = new Map<string, number>()
  for (const text of texts) {
    for (const token of tokenise(text)) {
      if (!vocab.has(token)) {
        vocab.set(token, vocab.size)
      }
    }
  }
  return vocab
}

/** Convert text to a TF-IDF vector using the given vocabulary.
 *  Returns a normalised vector so cosine similarity == dot product. */
export function textToTfIdf(
  text: string,
  vocabulary: Map<string, number>,
  documentFrequencies?: Map<string, number>,
  totalDocuments?: number,
): EmbeddingVector {
  const tokens = tokenise(text)
  if (tokens.length === 0 || vocabulary.size === 0) {
    return new Array(vocabulary.size).fill(0)
  }

  // Term frequencies
  const tf = new Map<string, number>()
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }

  // Build raw vector
  const vec = new Array<number>(vocabulary.size).fill(0)
  for (const [term, count] of tf) {
    const idx = vocabulary.get(term)
    if (idx === undefined) continue
    const termFreq = count / tokens.length
    let idf = 1
    if (documentFrequencies && totalDocuments && totalDocuments > 0) {
      const df = documentFrequencies.get(term) ?? 0
      idf = Math.log((totalDocuments + 1) / (df + 1)) + 1
    }
    vec[idx] = termFreq * idf
  }

  return normalise(vec)
}

/** L2-normalise a vector in place and return it. */
export function normalise(vec: number[]): number[] {
  let mag = 0
  for (const v of vec) mag += v * v
  mag = Math.sqrt(mag)
  if (mag === 0) return vec
  for (let i = 0; i < vec.length; i++) vec[i] /= mag
  return vec
}

/** Cosine similarity between two normalised vectors (== dot product). */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < len; i++) dot += a[i] * b[i]
  return dot
}

// ---------------------------------------------------------------------------
// EmbeddingStore
// ---------------------------------------------------------------------------

export class EmbeddingStore {
  private entries = new Map<string, MemoryEntry>()
  private vocabulary = new Map<string, number>()
  private documentFrequencies = new Map<string, number>()
  private readonly filePath: string
  readonly maxEntries: number

  constructor(filePath: string, maxEntries = 10_000) {
    this.filePath = filePath
    this.maxEntries = maxEntries
  }

  // -- Vocabulary management ------------------------------------------------

  /** Rebuild the vocabulary from all stored entries plus optional extra texts. */
  rebuildVocabulary(extraTexts: string[] = []): void {
    const allTexts = [...this.getAllEntries().map(e => e.content), ...extraTexts]
    this.vocabulary = buildVocabulary(allTexts)

    // Recompute document frequencies
    this.documentFrequencies.clear()
    for (const text of allTexts) {
      const seen = new Set(tokenise(text))
      for (const term of seen) {
        this.documentFrequencies.set(term, (this.documentFrequencies.get(term) ?? 0) + 1)
      }
    }
  }

  /** Generate an embedding for a piece of text using the current vocabulary. */
  embed(text: string): EmbeddingVector {
    return textToTfIdf(text, this.vocabulary, this.documentFrequencies, this.entries.size || 1)
  }

  getVocabulary(): Map<string, number> {
    return this.vocabulary
  }

  // -- CRUD -----------------------------------------------------------------

  add(entry: MemoryEntry): void {
    this.entries.set(entry.id, entry)
    this.evictIfNeeded()
  }

  remove(id: string): boolean {
    return this.entries.delete(id)
  }

  get(id: string): MemoryEntry | undefined {
    const entry = this.entries.get(id)
    if (entry) {
      entry.metadata.accessCount++
      entry.metadata.lastAccessed = new Date().toISOString()
    }
    return entry
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  size(): number {
    return this.entries.size
  }

  getAllEntries(): MemoryEntry[] {
    return Array.from(this.entries.values())
  }

  // -- Search ---------------------------------------------------------------

  search(queryEmbedding: EmbeddingVector, topK = 5, filters?: SearchFilters): ScoredEntry[] {
    const results: ScoredEntry[] = []

    for (const entry of this.entries.values()) {
      if (filters) {
        if (filters.type && entry.type !== filters.type) continue
        if (filters.project && entry.metadata.project !== filters.project) continue
        if (filters.minImportance !== undefined && entry.importance < filters.minImportance)
          continue
        if (filters.tags && filters.tags.length > 0) {
          const hasTag = filters.tags.some(t => entry.metadata.tags.includes(t))
          if (!hasTag) continue
        }
      }

      const score = cosineSimilarity(queryEmbedding, entry.embedding)
      results.push({ entry, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, topK)
  }

  // -- Eviction -------------------------------------------------------------

  /** Evict lowest-priority entries when over capacity.
   *  Priority = importance * recency (0-1 recency based on days since access). */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let worstId: string | undefined
      let worstPriority = Infinity

      const now = Date.now()
      for (const [id, entry] of this.entries) {
        const daysSinceAccess =
          (now - new Date(entry.metadata.lastAccessed).getTime()) / (1000 * 60 * 60 * 24)
        const recency = 1 / (1 + daysSinceAccess)
        const priority = entry.importance * recency
        if (priority < worstPriority) {
          worstPriority = priority
          worstId = id
        }
      }

      if (worstId) this.entries.delete(worstId)
      else break
    }
  }

  // -- Persistence ----------------------------------------------------------

  save(): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const vocabObj: Record<string, number> = {}
    for (const [k, v] of this.vocabulary) vocabObj[k] = v

    const data: StoreData = {
      version: 1,
      entries: Array.from(this.entries.values()),
      vocabulary: vocabObj,
    }
    writeFileSync(this.filePath, JSON.stringify(data), 'utf-8')
  }

  load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const data: StoreData = JSON.parse(raw)
      if (data.version !== 1) return

      this.entries.clear()
      for (const entry of data.entries) {
        this.entries.set(entry.id, entry)
      }

      this.vocabulary.clear()
      for (const [k, v] of Object.entries(data.vocabulary)) {
        this.vocabulary.set(k, v)
      }

      // Rebuild document frequencies from entries
      this.documentFrequencies.clear()
      for (const entry of data.entries) {
        const seen = new Set(tokenise(entry.content))
        for (const term of seen) {
          this.documentFrequencies.set(term, (this.documentFrequencies.get(term) ?? 0) + 1)
        }
      }
    } catch {
      // Corrupted file; start fresh
    }
  }
}
