/**
 * Progressive Trust Escalation - Integration Layer
 *
 * Provides a thin adapter that wraps an existing permission check function,
 * consulting the trust store/policy before falling back to the original
 * check, and recording outcomes after tool execution.
 */

import type { PermissionBehavior } from '../../types/permissions.js'
import type { TrustStore } from './trustStore.js'
import type { TrustPolicy, TrustDecision } from './trustPolicy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal shape of an existing permission check function.
 * Takes a tool name, the invocation pattern (e.g. the command string),
 * and the workspace path. Returns the permission behaviour to apply.
 */
export type PermissionCheckFn = (
  tool: string,
  pattern: string,
  workspace: string,
) => PermissionBehavior | Promise<PermissionBehavior>

/**
 * Enhanced permission check that includes trust metadata alongside
 * the final behaviour.
 */
export type EnhancedPermissionResult = {
  behavior: PermissionBehavior
  /** Trust-layer decision (null when the trust layer deferred to original) */
  trustDecision: TrustDecision | null
}

export type EnhancedPermissionCheckFn = (
  tool: string,
  pattern: string,
  workspace: string,
) => Promise<EnhancedPermissionResult>

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an existing permission check with trust-based escalation.
 *
 * Resolution order:
 * 1. If the trust policy says "allow", return allow immediately
 *    (the original check is *not* consulted - trust overrides).
 * 2. Otherwise, fall through to the original check.
 *
 * The returned function has the same (tool, pattern, workspace) signature.
 */
export function wrapPermissionCheck(
  originalCheck: PermissionCheckFn,
  trustStore: TrustStore,
  trustPolicy: TrustPolicy,
): EnhancedPermissionCheckFn {
  return async (
    tool: string,
    pattern: string,
    workspace: string,
  ): Promise<EnhancedPermissionResult> => {
    // Consult the trust policy first
    const trustDecision = trustPolicy.shouldAutoAllow(tool, pattern, workspace)

    if (trustDecision.behavior === 'allow') {
      return { behavior: 'allow', trustDecision }
    }

    // Trust layer says "ask" (or "deny") - fall through to original check
    const originalBehavior = await originalCheck(tool, pattern, workspace)

    return { behavior: originalBehavior, trustDecision }
  }
}

// ---------------------------------------------------------------------------
// Outcome Recording
// ---------------------------------------------------------------------------

/**
 * Record the outcome of a tool execution in the trust store.
 * Call this after a tool completes (or fails).
 *
 * @param trustStore  - The trust store instance
 * @param tool        - Tool name (e.g. "Bash")
 * @param pattern     - The invocation pattern (e.g. the command string)
 * @param workspace   - Workspace path
 * @param success     - Whether the execution succeeded
 */
export function recordToolOutcome(
  trustStore: TrustStore,
  tool: string,
  pattern: string,
  workspace: string,
  success: boolean,
): void {
  trustStore.recordOutcome(tool, pattern, workspace, success)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Convenience factory that creates a trust-enhanced permission system.
 * Returns everything needed to integrate with the existing permission flow.
 */
export function createTrustEscalation(
  trustStore: TrustStore,
  trustPolicy: TrustPolicy,
) {
  return {
    trustStore,
    trustPolicy,

    /**
     * Wrap any permission check function with trust-based escalation.
     */
    wrap(originalCheck: PermissionCheckFn): EnhancedPermissionCheckFn {
      return wrapPermissionCheck(originalCheck, trustStore, trustPolicy)
    },

    /**
     * Record a tool execution outcome.
     */
    recordOutcome(
      tool: string,
      pattern: string,
      workspace: string,
      success: boolean,
    ): void {
      recordToolOutcome(trustStore, tool, pattern, workspace, success)
    },

    /**
     * Query the trust decision without running the original check.
     */
    query(
      tool: string,
      pattern: string,
      workspace: string,
    ): TrustDecision {
      return trustPolicy.shouldAutoAllow(tool, pattern, workspace)
    },
  }
}

export type TrustEscalation = ReturnType<typeof createTrustEscalation>
