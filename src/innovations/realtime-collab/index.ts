/**
 * Real-time Collaboration
 *
 * Multi-user shared Claude sessions with presence tracking,
 * permission negotiation, and synchronized messaging.
 */

export { SessionBroker } from './sessionBroker.js'
export type {
  SharedSession,
  SessionSettings,
  SessionState,
  Participant,
  SharedMessage,
  Reaction,
  CursorPosition,
  JoinResult,
  ApprovalRequest,
} from './sessionBroker.js'

export { MessageSynchronizer } from './messageSynchronizer.js'
export type {
  SyncEvent,
  SyncEventType,
  SyncHandler,
} from './messageSynchronizer.js'

export { PermissionNegotiator } from './permissionNegotiator.js'
export type {
  PermissionVote,
  PermissionNegotiation,
  NegotiationStatus,
  NegotiationUpdate,
} from './permissionNegotiator.js'

export { PresenceTracker } from './presenceTracker.js'
export type {
  PresenceState,
  PresenceStatus,
  StatusChangeHandler,
} from './presenceTracker.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { SessionBroker } from './sessionBroker.js'
import { MessageSynchronizer } from './messageSynchronizer.js'
import { PermissionNegotiator } from './permissionNegotiator.js'
import { PresenceTracker } from './presenceTracker.js'

export type CollaborationSession = {
  broker: SessionBroker
  synchronizer: MessageSynchronizer
  negotiator: PermissionNegotiator
  presence: PresenceTracker
  sessionId: string
  /** Clean up all resources */
  destroy: () => void
}

/**
 * Create a fully wired collaboration session with all components.
 */
export function createCollaborationSession(
  name: string,
  createdBy: { userId: string; name: string },
  settings?: Partial<import('./sessionBroker.js').SessionSettings>,
): CollaborationSession {
  const broker = new SessionBroker()
  const session = broker.createSession(name, createdBy, settings)

  const synchronizer = new MessageSynchronizer(session.id)
  const negotiator = new PermissionNegotiator()
  const presence = new PresenceTracker()

  // Register the creator's presence
  presence.register(createdBy.userId, session.id)

  return {
    broker,
    synchronizer,
    negotiator,
    presence,
    sessionId: session.id,
    destroy() {
      synchronizer.destroy()
      negotiator.destroy()
      presence.destroy()
    },
  }
}
