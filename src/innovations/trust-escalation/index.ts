/**
 * Progressive Trust Escalation
 *
 * A behavioural permission scoring system that tracks tool execution
 * outcomes and progressively grants higher trust to patterns that
 * consistently succeed.
 */

// Core store
export { TrustStore, computeScore } from './trustStore.js'
export type { TrustScore } from './trustStore.js'

// Policy engine
export { TrustPolicy, TRUST_TIERS } from './trustPolicy.js'
export type { TrustDecision, TrustTier } from './trustPolicy.js'

// Integration layer
export {
  wrapPermissionCheck,
  recordToolOutcome,
  createTrustEscalation,
} from './trustIntegration.js'
export type {
  PermissionCheckFn,
  EnhancedPermissionResult,
  EnhancedPermissionCheckFn,
  TrustEscalation,
} from './trustIntegration.js'

// Dashboard
export { TrustDashboard } from './trustDashboard.js'
export type { TrustSummary, RecentActivity } from './trustDashboard.js'
