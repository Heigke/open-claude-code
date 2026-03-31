import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TrustStore, computeScore } from '../trustStore.js'
import { TrustPolicy } from '../trustPolicy.js'
import { wrapPermissionCheck, createTrustEscalation } from '../trustIntegration.js'

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function tmpFilePath(): string {
  const dir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'trust-scores.json')
}

function cleanUp(filePath: string): void {
  try {
    const dir = join(filePath, '..')
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------

describe('computeScore', () => {
  test('returns 0 for no history', () => {
    expect(computeScore(0, 0, new Date().toISOString())).toBe(0)
  })

  test('returns 100 for all successes, no decay', () => {
    const now = new Date()
    expect(computeScore(10, 0, now.toISOString(), now)).toBe(100)
  })

  test('returns 0 for all failures, no decay', () => {
    const now = new Date()
    expect(computeScore(0, 5, now.toISOString(), now)).toBe(0)
  })

  test('applies failure weight of 3x', () => {
    // 10 successes, 10 failures (weighted as 30)
    // score = 10 / (10 + 30) * 100 = 25
    const now = new Date()
    expect(computeScore(10, 10, now.toISOString(), now)).toBe(25)
  })

  test('score with mixed results', () => {
    // 9 successes, 1 failure (weighted as 3)
    // score = 9 / (9 + 3) * 100 = 75
    const now = new Date()
    expect(computeScore(9, 1, now.toISOString(), now)).toBe(75)
  })

  test('applies time decay after 30 days', () => {
    const now = new Date()
    // 30 days ago -> decay factor 0.5
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    // With decay, both sides are multiplied equally, so the ratio is preserved
    // score = (10 * 0.5) / (10 * 0.5 + 0 * 0.5 * 3) * 100 = 100
    const scoreAllSuccess = computeScore(10, 0, thirtyDaysAgo.toISOString(), now)
    expect(scoreAllSuccess).toBe(100) // ratio unchanged

    // But the absolute magnitudes are halved - test by checking a mixed case
    // still gives the same ratio since decay applies uniformly
    const scoreMixed = computeScore(9, 1, thirtyDaysAgo.toISOString(), now)
    expect(scoreMixed).toBe(75) // ratio unchanged because decay is uniform
  })

  test('very old entries still produce valid scores', () => {
    const now = new Date()
    const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000)
    const score = computeScore(100, 1, yearAgo.toISOString(), now)
    // Should still be a valid number between 0-100
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(100)
  })
})

// ---------------------------------------------------------------------------
// TrustStore
// ---------------------------------------------------------------------------

describe('TrustStore', () => {
  let filePath: string
  let store: TrustStore

  beforeEach(() => {
    filePath = tmpFilePath()
    store = new TrustStore(filePath)
  })

  afterEach(() => {
    cleanUp(filePath)
  })

  test('getScore returns 0 for unknown entry', () => {
    expect(store.getScore('Bash', 'npm test', '/project')).toBe(0)
  })

  test('recordOutcome creates entry and updates score', () => {
    store.recordOutcome('Bash', 'npm test', '/project', true)
    expect(store.getScore('Bash', 'npm test', '/project')).toBe(100)

    store.recordOutcome('Bash', 'npm test', '/project', false)
    // 1 success, 1 failure (weighted 3): 1/(1+3) = 25
    expect(store.getScore('Bash', 'npm test', '/project')).toBe(25)
  })

  test('deduplicates by tool+pattern+workspace key', () => {
    store.recordOutcome('Bash', 'npm test', '/project', true)
    store.recordOutcome('Bash', 'npm test', '/project', true)
    store.recordOutcome('Bash', 'npm test', '/project', true)

    const entries = store.allEntries()
    const matching = entries.filter(
      e => e.tool === 'Bash' && e.pattern === 'npm test' && e.workspace === '/project',
    )
    expect(matching).toHaveLength(1)
    expect(matching[0]!.successCount).toBe(3)
  })

  test('different workspaces are separate entries', () => {
    store.recordOutcome('Bash', 'npm test', '/project-a', true)
    store.recordOutcome('Bash', 'npm test', '/project-b', false)

    expect(store.getScore('Bash', 'npm test', '/project-a')).toBe(100)
    expect(store.getScore('Bash', 'npm test', '/project-b')).toBe(0)
  })

  test('persistence: data survives reload', () => {
    store.recordOutcome('Bash', 'npm test', '/project', true)
    store.recordOutcome('Bash', 'npm test', '/project', true)
    store.recordOutcome('Bash', 'npm test', '/project', true)

    // Create a new store from the same file
    const store2 = new TrustStore(filePath)
    expect(store2.getScore('Bash', 'npm test', '/project')).toBe(100)

    const entry = store2.getEntry('Bash', 'npm test', '/project')
    expect(entry).not.toBeNull()
    expect(entry!.successCount).toBe(3)
    expect(entry!.failureCount).toBe(0)
  })

  test('handles corrupt file gracefully', () => {
    writeFileSync(filePath, '{ invalid json !!!', 'utf-8')
    const store2 = new TrustStore(filePath)
    expect(store2.getScore('Bash', 'npm test', '/project')).toBe(0)
  })

  test('handles missing file gracefully', () => {
    const missingPath = join(tmpdir(), 'nonexistent', 'trust-scores.json')
    const store2 = new TrustStore(missingPath)
    expect(store2.getScore('Bash', 'npm test', '/project')).toBe(0)
  })

  test('getEntry returns null for unknown entry', () => {
    expect(store.getEntry('Bash', 'unknown', '/project')).toBeNull()
  })

  test('getEntry returns copy with current score', () => {
    store.recordOutcome('Bash', 'npm test', '/project', true)
    const entry = store.getEntry('Bash', 'npm test', '/project')
    expect(entry).not.toBeNull()
    expect(entry!.score).toBe(100)
    expect(entry!.tool).toBe('Bash')
    expect(entry!.pattern).toBe('npm test')
  })

  test('hasPatternInAnyWorkspace', () => {
    expect(store.hasPatternInAnyWorkspace('Bash', 'npm test')).toBe(false)

    store.recordOutcome('Bash', 'npm test', '/project-a', true)
    expect(store.hasPatternInAnyWorkspace('Bash', 'npm test')).toBe(true)

    // Different tool - should not match
    expect(store.hasPatternInAnyWorkspace('Edit', 'npm test')).toBe(false)
  })

  test('getMaxScoreAcrossWorkspaces', () => {
    store.recordOutcome('Bash', 'npm test', '/project-a', true)
    store.recordOutcome('Bash', 'npm test', '/project-a', true)
    store.recordOutcome('Bash', 'npm test', '/project-b', false)

    const max = store.getMaxScoreAcrossWorkspaces('Bash', 'npm test')
    expect(max).toBe(100) // /project-a has 2 successes, 0 failures
  })

  test('clear removes all entries', () => {
    store.recordOutcome('Bash', 'npm test', '/project', true)
    store.clear()
    expect(store.allEntries()).toHaveLength(0)
    expect(store.getScore('Bash', 'npm test', '/project')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TrustPolicy
// ---------------------------------------------------------------------------

describe('TrustPolicy', () => {
  let filePath: string
  let store: TrustStore
  let policy: TrustPolicy

  beforeEach(() => {
    filePath = tmpFilePath()
    store = new TrustStore(filePath)
    policy = new TrustPolicy(store)
  })

  afterEach(() => {
    cleanUp(filePath)
  })

  test('untrusted pattern (score 0) -> ask', () => {
    const decision = policy.shouldAutoAllow('Bash', 'rm -rf /', '/project')
    expect(decision.behavior).toBe('ask')
    expect(decision.score).toBe(0)
    expect(decision.newContext).toBe(false)
  })

  test('low trust (25-50) -> ask with hint', () => {
    // Need score in 25-50 range: exactly at boundary
    // 1 success, 1 failure -> 1/(1+3) = 25
    store.recordOutcome('Bash', 'npm test', '/project', true)
    store.recordOutcome('Bash', 'npm test', '/project', false)

    const decision = policy.shouldAutoAllow('Bash', 'npm test', '/project')
    expect(decision.behavior).toBe('ask')
    expect(decision.score).toBe(25)
    expect(decision.reason).toContain('Trusted 1 time')
  })

  test('trusted (50-80) -> auto-allow with notification', () => {
    // 9 successes, 1 failure -> 9/(9+3) = 75
    for (let i = 0; i < 9; i++) {
      store.recordOutcome('Bash', 'npm test', '/project', true)
    }
    store.recordOutcome('Bash', 'npm test', '/project', false)

    const decision = policy.shouldAutoAllow('Bash', 'npm test', '/project')
    expect(decision.behavior).toBe('allow')
    expect(decision.score).toBe(75)
    expect(decision.reason).toContain('Auto-allowed')
  })

  test('highly trusted (80-100) -> silent auto-allow', () => {
    // Many successes, no failures -> 100
    for (let i = 0; i < 20; i++) {
      store.recordOutcome('Bash', 'npm test', '/project', true)
    }

    const decision = policy.shouldAutoAllow('Bash', 'npm test', '/project')
    expect(decision.behavior).toBe('allow')
    expect(decision.score).toBe(100)
    expect(decision.reason).toContain('Silent auto-allow')
  })

  test('anomaly detection: new context forces ask', () => {
    // Build high trust in workspace A
    for (let i = 0; i < 20; i++) {
      store.recordOutcome('Bash', 'npm test', '/project-a', true)
    }

    // Query in workspace B (no history there)
    const decision = policy.shouldAutoAllow('Bash', 'npm test', '/project-b')
    expect(decision.behavior).toBe('ask')
    expect(decision.newContext).toBe(true)
    expect(decision.reason).toContain('other workspaces')
  })

  test('no anomaly when global trust is low', () => {
    // Build low trust in workspace A (1 success, 1 failure -> score 25)
    store.recordOutcome('Bash', 'npm test', '/project-a', true)
    store.recordOutcome('Bash', 'npm test', '/project-a', false)

    // Query in workspace B - should NOT trigger new-context since global max < 50
    const decision = policy.shouldAutoAllow('Bash', 'npm test', '/project-b')
    expect(decision.newContext).toBe(false)
  })

  test('no anomaly when local history exists', () => {
    // Build high trust in both workspaces
    for (let i = 0; i < 20; i++) {
      store.recordOutcome('Bash', 'npm test', '/project-a', true)
    }
    store.recordOutcome('Bash', 'npm test', '/project-b', true)

    // Workspace B has local history now, so no new-context flag
    const decision = policy.shouldAutoAllow('Bash', 'npm test', '/project-b')
    expect(decision.newContext).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Trust Integration
// ---------------------------------------------------------------------------

describe('trustIntegration', () => {
  let filePath: string
  let store: TrustStore
  let policy: TrustPolicy

  beforeEach(() => {
    filePath = tmpFilePath()
    store = new TrustStore(filePath)
    policy = new TrustPolicy(store)
  })

  afterEach(() => {
    cleanUp(filePath)
  })

  test('wrapPermissionCheck: high trust bypasses original', async () => {
    // Build high trust
    for (let i = 0; i < 20; i++) {
      store.recordOutcome('Bash', 'npm test', '/project', true)
    }

    let originalCalled = false
    const originalCheck = () => {
      originalCalled = true
      return 'ask' as const
    }

    const wrapped = wrapPermissionCheck(originalCheck, store, policy)
    const result = await wrapped('Bash', 'npm test', '/project')

    expect(result.behavior).toBe('allow')
    expect(result.trustDecision).not.toBeNull()
    expect(result.trustDecision!.behavior).toBe('allow')
    expect(originalCalled).toBe(false)
  })

  test('wrapPermissionCheck: low trust falls through to original', async () => {
    let originalCalled = false
    const originalCheck = () => {
      originalCalled = true
      return 'deny' as const
    }

    const wrapped = wrapPermissionCheck(originalCheck, store, policy)
    const result = await wrapped('Bash', 'rm -rf /', '/project')

    expect(result.behavior).toBe('deny')
    expect(originalCalled).toBe(true)
  })

  test('wrapPermissionCheck: works with async original check', async () => {
    const originalCheck = async () => {
      return 'allow' as const
    }

    const wrapped = wrapPermissionCheck(originalCheck, store, policy)
    const result = await wrapped('Bash', 'npm test', '/project')

    expect(result.behavior).toBe('allow')
  })

  test('createTrustEscalation: factory returns working API', () => {
    const escalation = createTrustEscalation(store, policy)

    // Record some outcomes
    escalation.recordOutcome('Bash', 'npm test', '/project', true)
    escalation.recordOutcome('Bash', 'npm test', '/project', true)

    // Query trust
    const decision = escalation.query('Bash', 'npm test', '/project')
    expect(decision.score).toBe(100)
    expect(decision.behavior).toBe('allow')
  })

  test('createTrustEscalation: wrap works end-to-end', async () => {
    const escalation = createTrustEscalation(store, policy)

    // Build trust
    for (let i = 0; i < 20; i++) {
      escalation.recordOutcome('Bash', 'npm test', '/project', true)
    }

    const wrapped = escalation.wrap(() => 'ask')
    const result = await wrapped('Bash', 'npm test', '/project')
    expect(result.behavior).toBe('allow')
  })
})
