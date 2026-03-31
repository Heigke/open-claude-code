import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EmbeddingStore,
  cosineSimilarity,
  buildVocabulary,
  textToTfIdf,
  normalise,
} from '../embeddingStore.js'
import type { MemoryEntry } from '../embeddingStore.js'
import { EpisodeManager } from '../episodeManager.js'
import { CrossProjectTransfer } from '../crossProjectTransfer.js'
import { MemoryConsolidator } from '../memoryConsolidator.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpStorePath(): string {
  const dir = join(
    tmpdir(),
    `episodic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(dir, { recursive: true })
  return join(dir, 'episodic-memory.json')
}

function cleanUp(filePath: string): void {
  try {
    const dir = join(filePath, '..')
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

function makeEntry(
  id: string,
  content: string,
  store: EmbeddingStore,
  overrides?: Partial<MemoryEntry>,
): MemoryEntry {
  return {
    id,
    content,
    type: 'semantic',
    embedding: store.embed(content),
    metadata: {
      source: 'test',
      timestamp: new Date().toISOString(),
      project: 'test-project',
      tags: [],
      accessCount: 0,
      lastAccessed: new Date().toISOString(),
    },
    importance: 0.5,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// TF-IDF Embedding Generation & Cosine Similarity
// ---------------------------------------------------------------------------

describe('TF-IDF Embeddings', () => {
  test('buildVocabulary creates a map of unique terms', () => {
    const vocab = buildVocabulary(['hello world', 'world of code'])
    expect(vocab.size).toBe(4) // hello, world, of, code
    expect(vocab.has('hello')).toBe(true)
    expect(vocab.has('world')).toBe(true)
    expect(vocab.has('code')).toBe(true)
  })

  test('textToTfIdf produces a vector of vocabulary size', () => {
    const vocab = buildVocabulary(['the quick brown fox', 'the lazy dog'])
    const vec = textToTfIdf('quick brown fox', vocab)
    expect(vec.length).toBe(vocab.size)
  })

  test('textToTfIdf vectors are normalised (L2 norm ~1)', () => {
    const vocab = buildVocabulary(['typescript react testing', 'bun runtime fast'])
    const vec = textToTfIdf('typescript testing', vocab)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1.0, 4)
  })

  test('identical texts produce cosine similarity of 1', () => {
    const vocab = buildVocabulary(['machine learning algorithms'])
    const a = textToTfIdf('machine learning algorithms', vocab)
    const b = textToTfIdf('machine learning algorithms', vocab)
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 4)
  })

  test('similar texts produce higher similarity than dissimilar texts', () => {
    const vocab = buildVocabulary([
      'react component rendering',
      'react component testing',
      'database migration script',
    ])
    const a = textToTfIdf('react component rendering', vocab)
    const b = textToTfIdf('react component testing', vocab)
    const c = textToTfIdf('database migration script', vocab)

    const simAB = cosineSimilarity(a, b)
    const simAC = cosineSimilarity(a, c)
    expect(simAB).toBeGreaterThan(simAC)
  })

  test('empty text produces zero vector', () => {
    const vocab = buildVocabulary(['hello world'])
    const vec = textToTfIdf('', vocab)
    expect(vec.every(v => v === 0)).toBe(true)
  })

  test('normalise handles zero vector gracefully', () => {
    const vec = normalise([0, 0, 0])
    expect(vec).toEqual([0, 0, 0])
  })

  test('cosine similarity of orthogonal vectors is 0', () => {
    // Manually create two orthogonal normalised vectors
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 4)
  })
})

// ---------------------------------------------------------------------------
// EmbeddingStore CRUD & Search
// ---------------------------------------------------------------------------

describe('EmbeddingStore', () => {
  let storePath: string
  let store: EmbeddingStore

  beforeEach(() => {
    storePath = tmpStorePath()
    store = new EmbeddingStore(storePath, 100)
    store.rebuildVocabulary([
      'typescript react testing',
      'python machine learning',
      'database migration sql',
      'rust systems programming',
    ])
  })

  afterEach(() => {
    cleanUp(storePath)
  })

  test('add and get entries', () => {
    const entry = makeEntry('m1', 'typescript react testing', store)
    store.add(entry)
    const retrieved = store.get('m1')
    expect(retrieved).toBeDefined()
    expect(retrieved!.content).toBe('typescript react testing')
  })

  test('get increments access count', () => {
    const entry = makeEntry('m1', 'typescript react testing', store)
    store.add(entry)
    store.get('m1')
    store.get('m1')
    const retrieved = store.get('m1')
    expect(retrieved!.metadata.accessCount).toBe(3)
  })

  test('remove deletes entries', () => {
    store.add(makeEntry('m1', 'testing', store))
    expect(store.remove('m1')).toBe(true)
    expect(store.get('m1')).toBeUndefined()
    expect(store.remove('nonexistent')).toBe(false)
  })

  test('search returns entries sorted by similarity', () => {
    store.add(makeEntry('m1', 'typescript react testing', store))
    store.add(makeEntry('m2', 'python machine learning', store))
    store.add(makeEntry('m3', 'database migration sql', store))

    const query = store.embed('typescript react')
    const results = store.search(query, 3)

    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].entry.id).toBe('m1') // most similar
  })

  test('search respects filters', () => {
    store.add(makeEntry('m1', 'typescript react testing', store, { type: 'episode' }))
    store.add(makeEntry('m2', 'typescript react components', store, { type: 'semantic' }))

    const query = store.embed('typescript react')
    const results = store.search(query, 5, { type: 'episode' })

    expect(results.length).toBe(1)
    expect(results[0].entry.id).toBe('m1')
  })

  test('search filters by project', () => {
    const e1 = makeEntry('m1', 'typescript react', store)
    e1.metadata.project = 'proj-a'
    const e2 = makeEntry('m2', 'typescript react', store)
    e2.metadata.project = 'proj-b'
    store.add(e1)
    store.add(e2)

    const query = store.embed('typescript react')
    const results = store.search(query, 5, { project: 'proj-a' })
    expect(results.length).toBe(1)
    expect(results[0].entry.id).toBe('m1')
  })

  test('search filters by tags', () => {
    const e1 = makeEntry('m1', 'typescript react', store)
    e1.metadata.tags = ['frontend']
    const e2 = makeEntry('m2', 'typescript node', store)
    e2.metadata.tags = ['backend']
    store.add(e1)
    store.add(e2)

    const query = store.embed('typescript')
    const results = store.search(query, 5, { tags: ['frontend'] })
    expect(results.length).toBe(1)
    expect(results[0].entry.id).toBe('m1')
  })

  test('search filters by minimum importance', () => {
    store.add(makeEntry('m1', 'typescript react', store, { importance: 0.8 }))
    store.add(makeEntry('m2', 'typescript node', store, { importance: 0.2 }))

    const query = store.embed('typescript')
    const results = store.search(query, 5, { minImportance: 0.5 })
    expect(results.length).toBe(1)
    expect(results[0].entry.id).toBe('m1')
  })

  test('eviction removes lowest-priority entries when over capacity', () => {
    const smallStore = new EmbeddingStore(storePath, 3)
    smallStore.rebuildVocabulary(['a', 'b', 'c', 'd'])

    // Add 4 entries to a store with capacity 3
    smallStore.add(makeEntry('m1', 'a', smallStore, { importance: 0.9 }))
    smallStore.add(makeEntry('m2', 'b', smallStore, { importance: 0.1 }))
    smallStore.add(makeEntry('m3', 'c', smallStore, { importance: 0.8 }))
    smallStore.add(makeEntry('m4', 'd', smallStore, { importance: 0.7 }))

    expect(smallStore.size()).toBe(3)
    // m2 should have been evicted (lowest importance)
    expect(smallStore.has('m2')).toBe(false)
  })

  test('save and load round-trips correctly', () => {
    store.add(makeEntry('m1', 'typescript react testing', store))
    store.add(makeEntry('m2', 'python machine learning', store))
    store.save()

    const store2 = new EmbeddingStore(storePath, 100)
    store2.load()

    expect(store2.size()).toBe(2)
    expect(store2.get('m1')?.content).toBe('typescript react testing')
    expect(store2.get('m2')?.content).toBe('python machine learning')
  })

  test('load handles missing file gracefully', () => {
    const fresh = new EmbeddingStore('/tmp/nonexistent-path/store.json', 100)
    fresh.load() // should not throw
    expect(fresh.size()).toBe(0)
  })

  test('has returns correct boolean', () => {
    store.add(makeEntry('m1', 'test', store))
    expect(store.has('m1')).toBe(true)
    expect(store.has('m2')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Episode Lifecycle
// ---------------------------------------------------------------------------

describe('EpisodeManager', () => {
  let store: EmbeddingStore
  let manager: EpisodeManager

  beforeEach(() => {
    const path = tmpStorePath()
    store = new EmbeddingStore(path, 1000)
    store.rebuildVocabulary([
      'fixed bug in authentication',
      'refactored database layer',
      'added new api endpoint',
    ])
    manager = new EpisodeManager(store)
  })

  test('startEpisode creates a new episode', () => {
    const ep = manager.startEpisode('session-1')
    expect(ep.id).toBeTruthy()
    expect(ep.sessionId).toBe('session-1')
    expect(ep.startTime).toBeTruthy()
    expect(ep.endTime).toBeNull()
    expect(ep.outcome).toBeNull()
    expect(ep.decisions).toEqual([])
    expect(ep.toolsUsed).toEqual([])
  })

  test('recordDecision adds decisions with timestamps', () => {
    const ep = manager.startEpisode('session-1')
    manager.recordDecision(ep.id, {
      description: 'Use TDD approach',
      reasoning: 'Better test coverage',
      confidence: 0.9,
    })

    const updated = manager.getEpisode(ep.id)!
    expect(updated.decisions.length).toBe(1)
    expect(updated.decisions[0].description).toBe('Use TDD approach')
    expect(updated.decisions[0].timestamp).toBeTruthy()
  })

  test('recordToolUse tracks tool names and records', () => {
    const ep = manager.startEpisode('session-1')
    manager.recordToolUse(ep.id, 'Bash', 'ls', 'file1\nfile2', true)
    manager.recordToolUse(ep.id, 'Read', '/path/file.ts', 'content', true)
    manager.recordToolUse(ep.id, 'Bash', 'cat foo', 'bar', false)

    const updated = manager.getEpisode(ep.id)!
    expect(updated.toolsUsed).toEqual(['Bash', 'Read'])
    expect(updated.toolRecords.length).toBe(3)
    expect(updated.toolRecords[2].success).toBe(false)
  })

  test('recordFileModified tracks unique file paths', () => {
    const ep = manager.startEpisode('session-1')
    manager.recordFileModified(ep.id, '/src/index.ts')
    manager.recordFileModified(ep.id, '/src/utils.ts')
    manager.recordFileModified(ep.id, '/src/index.ts') // duplicate

    const updated = manager.getEpisode(ep.id)!
    expect(updated.filesModified).toEqual(['/src/index.ts', '/src/utils.ts'])
  })

  test('endEpisode finalises with outcome and summary', () => {
    const ep = manager.startEpisode('session-1')
    manager.recordDecision(ep.id, {
      description: 'Use TDD',
      reasoning: 'Coverage',
      confidence: 0.8,
    })
    manager.recordToolUse(ep.id, 'Bash', 'bun test', 'pass', true)

    const finished = manager.endEpisode(ep.id, 'success', 'Fixed auth bug')!
    expect(finished.outcome).toBe('success')
    expect(finished.summary).toBe('Fixed auth bug')
    expect(finished.endTime).toBeTruthy()

    // Should be stored in the embedding store
    expect(store.has(ep.id)).toBe(true)
  })

  test('endEpisode auto-generates summary when none provided', () => {
    const ep = manager.startEpisode('session-1')
    manager.recordDecision(ep.id, {
      description: 'Refactor DB',
      reasoning: 'Cleaner code',
      confidence: 0.7,
    })
    manager.recordToolUse(ep.id, 'Edit', 'edit file', 'done', true)

    const finished = manager.endEpisode(ep.id, 'success')!
    expect(finished.summary).toContain('session-1')
    expect(finished.summary).toContain('success')
    expect(finished.summary).toContain('Refactor DB')
  })

  test('getRecentEpisodes returns newest first', () => {
    const ep1 = manager.startEpisode('s1')
    const ep2 = manager.startEpisode('s2')
    const ep3 = manager.startEpisode('s3')

    const recent = manager.getRecentEpisodes(2)
    expect(recent.length).toBe(2)
    expect(recent[0].id).toBe(ep3.id)
    expect(recent[1].id).toBe(ep2.id)
  })

  test('generateEpisodeSummary produces a readable string', () => {
    const ep = manager.startEpisode('session-1')
    manager.recordDecision(ep.id, {
      description: 'Add caching',
      reasoning: 'Performance',
      confidence: 0.85,
    })
    manager.recordToolUse(ep.id, 'Bash', 'test', 'ok', true)
    manager.recordFileModified(ep.id, '/src/cache.ts')

    const episode = manager.getEpisode(ep.id)!
    episode.endTime = new Date().toISOString()
    episode.outcome = 'success'

    const summary = manager.generateEpisodeSummary(episode)
    expect(summary).toContain('Outcome: success')
    expect(summary).toContain('Decisions: Add caching')
    expect(summary).toContain('Tools: Bash')
    expect(summary).toContain('cache.ts')
  })

  test('findSimilarEpisodes retrieves semantically related episodes', () => {
    // Create and end several episodes so they land in the store
    const ep1 = manager.startEpisode('s1')
    manager.endEpisode(ep1.id, 'success', 'fixed bug in authentication system')

    const ep2 = manager.startEpisode('s2')
    manager.endEpisode(ep2.id, 'success', 'refactored database layer for performance')

    const ep3 = manager.startEpisode('s3')
    manager.endEpisode(ep3.id, 'success', 'added new api endpoint for users')

    const similar = manager.findSimilarEpisodes('authentication login bug', 2)
    // The auth-related episode should appear
    expect(similar.length).toBeGreaterThanOrEqual(1)
    // First result should be the auth episode since it's most similar
    if (similar.length > 0) {
      expect(similar[0].id).toBe(ep1.id)
    }
  })

  test('operations on nonexistent episode are no-ops', () => {
    manager.recordDecision('nonexistent', {
      description: 'test',
      reasoning: 'test',
      confidence: 0.5,
    })
    manager.recordToolUse('nonexistent', 'Bash', 'test', 'out', true)
    manager.recordFileModified('nonexistent', '/test')
    const result = manager.endEpisode('nonexistent', 'success')
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Cross-Project Transfer
// ---------------------------------------------------------------------------

describe('CrossProjectTransfer', () => {
  let transfer: CrossProjectTransfer

  beforeEach(() => {
    transfer = new CrossProjectTransfer()
  })

  test('recordPattern tracks patterns with project association', () => {
    transfer.recordPattern('proj-a', 'use-typescript-strict', 'tsconfig setup')
    const profile = transfer.getProfile('proj-a')!
    expect(profile.patterns.length).toBe(1)
    expect(profile.patterns[0].pattern).toBe('use-typescript-strict')
    expect(profile.patterns[0].projects).toContain('proj-a')
  })

  test('same pattern in multiple projects increases confidence', () => {
    transfer.recordPattern('proj-a', 'use-eslint', 'linting setup')
    transfer.recordPattern('proj-b', 'use-eslint', 'linting config')

    const profileA = transfer.getProfile('proj-a')!
    const pattern = profileA.patterns.find(p => p.pattern === 'use-eslint')!
    expect(pattern.projects).toEqual(['proj-a', 'proj-b'])
    expect(pattern.frequency).toBe(2)
    expect(pattern.confidence).toBeGreaterThan(0.3) // should have increased
  })

  test('getTransferablePatterns returns patterns from 2+ projects', () => {
    transfer.recordPattern('proj-a', 'use-eslint', 'linting')
    transfer.recordPattern('proj-b', 'use-eslint', 'linting')
    transfer.recordPattern('proj-a', 'unique-pattern', 'only in a')

    const transferable = transfer.getTransferablePatterns('proj-a', 'proj-c')
    expect(transferable.length).toBe(1)
    expect(transferable[0].pattern).toBe('use-eslint')
  })

  test('getTransferablePatterns excludes patterns already in target project', () => {
    transfer.recordPattern('proj-a', 'use-eslint', 'linting')
    transfer.recordPattern('proj-b', 'use-eslint', 'linting')

    // proj-b already has the pattern
    const transferable = transfer.getTransferablePatterns('proj-a', 'proj-b')
    expect(transferable.length).toBe(0)
  })

  test('recordPreference tracks preferences with dedup', () => {
    transfer.recordPreference('proj-a', 'indent', '2-spaces')
    transfer.recordPreference('proj-a', 'indent', '2-spaces') // duplicate same project
    transfer.recordPreference('proj-b', 'indent', '2-spaces')

    const profile = transfer.getProfile('proj-a')!
    expect(profile.preferences.length).toBe(1)
    expect(profile.preferences[0].frequency).toBe(3)
  })

  test('getUniversalPreferences returns preferences consistent across all projects', () => {
    transfer.recordPreference('proj-a', 'indent', '2-spaces')
    transfer.recordPreference('proj-b', 'indent', '2-spaces')
    transfer.recordPreference('proj-a', 'semicolons', 'no')
    // 'semicolons' only in proj-a, not universal

    const universal = transfer.getUniversalPreferences()
    expect(universal.length).toBe(1)
    expect(universal[0].key).toBe('indent')
  })

  test('getUniversalPreferences returns empty with fewer than 2 projects', () => {
    transfer.recordPreference('proj-a', 'indent', '2-spaces')
    expect(transfer.getUniversalPreferences()).toEqual([])
  })

  test('suggestForNewProject aggregates patterns and preferences', () => {
    // Patterns across multiple projects
    transfer.recordPattern('proj-a', 'use-eslint', 'linting')
    transfer.recordPattern('proj-b', 'use-eslint', 'linting')
    transfer.recordPattern('proj-c', 'use-eslint', 'linting')
    transfer.recordPattern('proj-a', 'use-prettier', 'formatting')
    transfer.recordPattern('proj-b', 'use-prettier', 'formatting')
    transfer.recordPattern('proj-a', 'unique-a', 'only here')

    // Preferences
    transfer.recordPreference('proj-a', 'indent', '2-spaces')
    transfer.recordPreference('proj-b', 'indent', '2-spaces')

    const suggestion = transfer.suggestForNewProject(['proj-a', 'proj-b', 'proj-c'])
    expect(suggestion.patterns.length).toBe(2) // eslint + prettier
    expect(suggestion.preferences.length).toBe(1) // indent
  })

  test('getProjectIds lists all known projects', () => {
    transfer.recordPattern('proj-a', 'p1', 'ctx')
    transfer.recordPattern('proj-b', 'p2', 'ctx')
    expect(transfer.getProjectIds().sort()).toEqual(['proj-a', 'proj-b'])
  })
})

// ---------------------------------------------------------------------------
// Memory Consolidation
// ---------------------------------------------------------------------------

describe('MemoryConsolidator', () => {
  let storePath: string
  let store: EmbeddingStore
  let consolidator: MemoryConsolidator

  beforeEach(() => {
    storePath = tmpStorePath()
    store = new EmbeddingStore(storePath, 1000)
  })

  afterEach(() => {
    cleanUp(storePath)
  })

  test('decay reduces importance of old memories', () => {
    consolidator = new MemoryConsolidator({ decayRate: 0.95, importanceFloor: 0.0 })
    store.rebuildVocabulary(['old memory content'])

    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 10) // 10 days ago

    const entry = makeEntry('m1', 'old memory content', store, { importance: 0.5 })
    entry.metadata.lastAccessed = oldDate.toISOString()
    entry.metadata.accessCount = 0
    store.add(entry)

    const result = consolidator.consolidate(store)
    expect(result.decayed).toBeGreaterThanOrEqual(1)

    const updated = store.get('m1')!
    // 0.5 * 0.95^10 ~ 0.299
    expect(updated.importance).toBeLessThan(0.5)
  })

  test('promote increases importance for frequently accessed memories', () => {
    consolidator = new MemoryConsolidator({ accessBoost: 0.01, importanceFloor: 0.0 })
    store.rebuildVocabulary(['popular content'])

    const entry = makeEntry('m1', 'popular content', store, { importance: 0.3 })
    entry.metadata.accessCount = 10
    store.add(entry)

    const result = consolidator.consolidate(store)
    expect(result.promoted).toBeGreaterThanOrEqual(1)

    const updated = store.get('m1')!
    // 0.3 + 10 * 0.01 = 0.4 (approximately, after decay)
    expect(updated.importance).toBeGreaterThan(0.3)
  })

  test('remove cleans up memories below importance threshold', () => {
    consolidator = new MemoryConsolidator({ importanceFloor: 0.1 })
    store.rebuildVocabulary(['low importance content', 'high importance content'])

    const oldDate = new Date()
    oldDate.setDate(oldDate.getDate() - 100) // very old

    const lowEntry = makeEntry('m1', 'low importance content', store, { importance: 0.01 })
    lowEntry.metadata.lastAccessed = oldDate.toISOString()
    lowEntry.metadata.accessCount = 0
    store.add(lowEntry)

    const highEntry = makeEntry('m2', 'high importance content', store, { importance: 0.9 })
    store.add(highEntry)

    const result = consolidator.consolidate(store)
    expect(result.removed).toBeGreaterThanOrEqual(1)
    expect(store.has('m1')).toBe(false)
    expect(store.has('m2')).toBe(true)
  })

  test('merge combines similar memories', () => {
    consolidator = new MemoryConsolidator({
      mergeSimilarity: 0.85,
      importanceFloor: 0.0,
    })

    // Use identical content to guarantee cosine sim = 1.0
    store.rebuildVocabulary(['typescript react component rendering'])

    const e1 = makeEntry('m1', 'typescript react component rendering', store, {
      type: 'semantic',
      importance: 0.5,
    })
    e1.metadata.tags = ['react']
    const e2 = makeEntry('m2', 'typescript react component rendering', store, {
      type: 'semantic',
      importance: 0.6,
    })
    e2.metadata.tags = ['typescript']

    store.add(e1)
    store.add(e2)

    const result = consolidator.consolidate(store)
    expect(result.merged).toBeGreaterThanOrEqual(1)
    expect(store.size()).toBe(1)

    // Surviving entry should have merged tags and boosted importance
    const surviving = store.getAllEntries()[0]
    expect(surviving.metadata.tags).toContain('react')
    expect(surviving.metadata.tags).toContain('typescript')
    expect(surviving.importance).toBeGreaterThanOrEqual(0.6)
  })

  test('merge does not combine entries of different types', () => {
    consolidator = new MemoryConsolidator({
      mergeSimilarity: 0.85,
      importanceFloor: 0.0,
    })
    store.rebuildVocabulary(['identical content here'])

    store.add(
      makeEntry('m1', 'identical content here', store, { type: 'episode', importance: 0.5 }),
    )
    store.add(
      makeEntry('m2', 'identical content here', store, { type: 'semantic', importance: 0.5 }),
    )

    const result = consolidator.consolidate(store)
    expect(result.merged).toBe(0)
    expect(store.size()).toBe(2)
  })

  test('consolidation result reports accurate totals', () => {
    consolidator = new MemoryConsolidator({ importanceFloor: 0.0 })
    store.rebuildVocabulary(['content a', 'content b', 'content c'])

    store.add(makeEntry('m1', 'content a', store))
    store.add(makeEntry('m2', 'content b', store))
    store.add(makeEntry('m3', 'content c', store))

    const result = consolidator.consolidate(store)
    expect(result.totalBefore).toBe(3)
    expect(result.totalAfter).toBe(store.size())
  })

  test('shouldConsolidate respects episode threshold', () => {
    consolidator = new MemoryConsolidator()

    // Initially should consolidate (never done before)
    expect(consolidator.shouldConsolidate(20, 24)).toBe(true)

    // After consolidation, should not
    store.rebuildVocabulary([])
    consolidator.consolidate(store)
    expect(consolidator.shouldConsolidate(20, 24)).toBe(false)

    // After enough episodes, should consolidate again
    for (let i = 0; i < 20; i++) {
      consolidator.recordEpisodeCompletion()
    }
    expect(consolidator.shouldConsolidate(20, 24)).toBe(true)
  })

  test('episode count resets after consolidation', () => {
    consolidator = new MemoryConsolidator()
    for (let i = 0; i < 5; i++) {
      consolidator.recordEpisodeCompletion()
    }
    expect(consolidator.getEpisodesSinceConsolidation()).toBe(5)

    store.rebuildVocabulary([])
    consolidator.consolidate(store)
    expect(consolidator.getEpisodesSinceConsolidation()).toBe(0)
  })
})
