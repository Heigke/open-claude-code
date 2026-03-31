/**
 * Progressive Trust Escalation - Trust Policy
 *
 * Maps trust scores to permission behaviours and performs
 * anomaly detection for new-context scenarios.
 */

import type { PermissionBehavior } from '../../types/permissions.js'
import type { TrustStore } from './trustStore.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustDecision = {
  /** The permission behaviour to apply */
  behavior: PermissionBehavior
  /** Human-readable explanation of the decision */
  reason: string
  /** The raw trust score that drove the decision */
  score: number
  /** True when pattern has high trust elsewhere but is new to this workspace */
  newContext: boolean
}

export type TrustTier = {
  min: number
  max: number
  behavior: PermissionBehavior
  label: string
}

// ---------------------------------------------------------------------------
// Tier Definitions
// ---------------------------------------------------------------------------

export const TRUST_TIERS: readonly TrustTier[] = [
  { min: 0, max: 25, behavior: 'ask', label: 'untrusted' },
  { min: 25, max: 50, behavior: 'ask', label: 'low-trust' },
  { min: 50, max: 80, behavior: 'allow', label: 'trusted' },
  { min: 80, max: 100, behavior: 'allow', label: 'highly-trusted' },
] as const

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export class TrustPolicy {
  private store: TrustStore

  constructor(store: TrustStore) {
    this.store = store
  }

  /**
   * Determine the permission behaviour for a given tool invocation
   * based on accumulated trust and anomaly heuristics.
   */
  shouldAutoAllow(
    tool: string,
    pattern: string,
    workspace: string,
  ): TrustDecision {
    const score = this.store.getScore(tool, pattern, workspace)
    const entry = this.store.getEntry(tool, pattern, workspace)

    // --- Anomaly detection: new-context flag ---
    // If this exact (tool, pattern, workspace) has no history, but the
    // same (tool, pattern) has high trust in another workspace, we still
    // require confirmation because the security context is different.
    const isNewContext = this.detectNewContext(tool, pattern, workspace)

    if (isNewContext) {
      const globalMax = this.store.getMaxScoreAcrossWorkspaces(tool, pattern)
      return {
        behavior: 'ask',
        reason:
          `Pattern "${pattern}" is trusted (score ${globalMax}) in other workspaces ` +
          `but has not been used in this workspace yet. Asking for confirmation.`,
        score,
        newContext: true,
      }
    }

    // --- Normal tier mapping ---
    const tier = this.getTier(score)

    if (tier.min >= 80) {
      // 80-100: silent auto-allow
      return {
        behavior: 'allow',
        reason: `Silent auto-allow: trust score ${score} (${tier.label})`,
        score,
        newContext: false,
      }
    }

    if (tier.min >= 50) {
      // 50-80: auto-allow with brief notification
      return {
        behavior: 'allow',
        reason: `Auto-allowed: trust score ${score} (${tier.label})`,
        score,
        newContext: false,
      }
    }

    if (tier.min >= 25) {
      // 25-50: ask but show trust hint
      const totalUses = entry
        ? entry.successCount + entry.failureCount
        : 0
      return {
        behavior: 'ask',
        reason:
          `Trust score ${score} (${tier.label}). ` +
          (totalUses > 0
            ? `Trusted ${entry!.successCount} time${entry!.successCount !== 1 ? 's' : ''}, ` +
              `failed ${entry!.failureCount} time${entry!.failureCount !== 1 ? 's' : ''}.`
            : 'No usage history.'),
        score,
        newContext: false,
      }
    }

    // 0-25: always ask, no hint
    return {
      behavior: 'ask',
      reason:
        score === 0
          ? 'No trust history for this pattern.'
          : `Low trust score ${score} (${tier.label}).`,
      score,
      newContext: false,
    }
  }

  // ---- Helpers ------------------------------------------------------------

  /**
   * Detect the "new context" anomaly: high trust elsewhere, zero history here.
   */
  private detectNewContext(
    tool: string,
    pattern: string,
    workspace: string,
  ): boolean {
    const localEntry = this.store.getEntry(tool, pattern, workspace)
    if (localEntry !== null) {
      // There IS local history - not a new context
      return false
    }

    // Check if the pattern is trusted in any other workspace
    const globalMax = this.store.getMaxScoreAcrossWorkspaces(tool, pattern)
    return globalMax >= 50
  }

  /**
   * Find the tier a score falls into.
   */
  private getTier(score: number): TrustTier {
    for (const tier of TRUST_TIERS) {
      if (score >= tier.min && score < tier.max) {
        return tier
      }
    }
    // Score of exactly 100 falls into the last tier
    return TRUST_TIERS[TRUST_TIERS.length - 1]!
  }
}
