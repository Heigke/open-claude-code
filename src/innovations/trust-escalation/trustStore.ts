/**
 * Progressive Trust Escalation - Trust Score Storage & Calculation
 *
 * Maintains a persistent store of tool execution outcomes per
 * (tool, pattern, workspace) triple, and derives a trust score
 * that decays over time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustScore = {
  tool: string
  pattern: string
  workspace: string
  successCount: number
  failureCount: number
  /** ISO-8601 timestamp of last recorded outcome */
  lastUsed: string
  /** Computed score 0-100 */
  score: number
}

/** Serialised form stored on disk */
type TrustStoreData = {
  version: 1
  entries: TrustScore[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUST_SCORES_PATH = join(homedir(), '.claude', 'trust-scores.json')

/** After this many milliseconds the weight of historical outcomes is halved */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** Failures are penalised 3x relative to successes */
const FAILURE_WEIGHT = 3

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(tool: string, pattern: string, workspace: string): string {
  return `${tool}\0${pattern}\0${workspace}`
}

/**
 * Calculate the trust score from raw counts with time-decay applied.
 *
 * Formula:
 *   effective_successes = successCount * decay
 *   effective_failures  = failureCount * decay * FAILURE_WEIGHT
 *   score = (effective_successes / (effective_successes + effective_failures)) * 100
 *
 * Decay factor: 0.5 ^ (age_ms / HALF_LIFE_MS)
 */
export function computeScore(
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

// ---------------------------------------------------------------------------
// TrustStore
// ---------------------------------------------------------------------------

export class TrustStore {
  private entries: Map<string, TrustScore> = new Map()
  private filePath: string
  private dirty = false

  constructor(filePath: string = TRUST_SCORES_PATH) {
    this.filePath = filePath
    this.load()
  }

  // ---- Persistence --------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = readFileSync(this.filePath, 'utf-8')
      const data: TrustStoreData = JSON.parse(raw)
      if (data.version !== 1 || !Array.isArray(data.entries)) return
      for (const entry of data.entries) {
        const key = makeKey(entry.tool, entry.pattern, entry.workspace)
        this.entries.set(key, { ...entry })
      }
    } catch {
      // Corrupt or unreadable file - start fresh
      this.entries.clear()
    }
  }

  save(): void {
    if (!this.dirty) return
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const data: TrustStoreData = {
        version: 1,
        entries: Array.from(this.entries.values()),
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
      this.dirty = false
    } catch {
      // Swallow write errors - trust data is advisory, not critical
    }
  }

  // ---- Query --------------------------------------------------------------

  /**
   * Get the current trust score for a (tool, pattern, workspace) triple.
   * Returns 0 if no data exists.
   */
  getScore(tool: string, pattern: string, workspace: string): number {
    const key = makeKey(tool, pattern, workspace)
    const entry = this.entries.get(key)
    if (!entry) return 0
    return computeScore(
      entry.successCount,
      entry.failureCount,
      entry.lastUsed,
    )
  }

  /**
   * Get the full TrustScore entry, or null if none exists.
   */
  getEntry(
    tool: string,
    pattern: string,
    workspace: string,
  ): TrustScore | null {
    const key = makeKey(tool, pattern, workspace)
    const entry = this.entries.get(key)
    if (!entry) return null
    // Return a copy with an up-to-date score
    return {
      ...entry,
      score: computeScore(entry.successCount, entry.failureCount, entry.lastUsed),
    }
  }

  /**
   * Check whether a (tool, pattern) combo has been seen in ANY workspace.
   * Used for anomaly / new-context detection.
   */
  hasPatternInAnyWorkspace(tool: string, pattern: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.tool === tool && entry.pattern === pattern) {
        return true
      }
    }
    return false
  }

  /**
   * Get the highest trust score for a (tool, pattern) across all workspaces.
   * Returns 0 if the pattern has never been seen.
   */
  getMaxScoreAcrossWorkspaces(tool: string, pattern: string): number {
    let max = 0
    for (const entry of this.entries.values()) {
      if (entry.tool === tool && entry.pattern === pattern) {
        const score = computeScore(
          entry.successCount,
          entry.failureCount,
          entry.lastUsed,
        )
        if (score > max) max = score
      }
    }
    return max
  }

  // ---- Mutation ------------------------------------------------------------

  /**
   * Record the outcome of a tool execution.
   * Creates a new entry if one doesn't exist, otherwise updates in place.
   * Automatically persists to disk.
   */
  recordOutcome(
    tool: string,
    pattern: string,
    workspace: string,
    success: boolean,
  ): void {
    const key = makeKey(tool, pattern, workspace)
    const now = new Date().toISOString()
    const existing = this.entries.get(key)

    if (existing) {
      if (success) {
        existing.successCount += 1
      } else {
        existing.failureCount += 1
      }
      existing.lastUsed = now
      existing.score = computeScore(
        existing.successCount,
        existing.failureCount,
        existing.lastUsed,
      )
    } else {
      const entry: TrustScore = {
        tool,
        pattern,
        workspace,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        lastUsed: now,
        score: success ? 100 : 0,
      }
      this.entries.set(key, entry)
    }

    this.dirty = true
    this.save()
  }

  /**
   * Return all entries (copies with current scores). Useful for inspection.
   */
  allEntries(): TrustScore[] {
    const now = new Date()
    return Array.from(this.entries.values()).map(e => ({
      ...e,
      score: computeScore(e.successCount, e.failureCount, e.lastUsed, now),
    }))
  }

  /**
   * Remove all entries. Primarily useful for testing.
   */
  clear(): void {
    this.entries.clear()
    this.dirty = true
  }
}
