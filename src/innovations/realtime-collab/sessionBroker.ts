/**
 * Real-time Collaboration - Session Broker
 *
 * Manages shared collaboration sessions: creation, join/leave lifecycle,
 * participant tracking, and approval queues for restricted sessions.
 */

import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CursorPosition = {
  file?: string
  line?: number
  column?: number
}

export type Participant = {
  userId: string
  name: string
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: Date
  lastActive: Date
  color: string
  cursor?: CursorPosition
}

export type Reaction = {
  emoji: string
  userId: string
  timestamp: Date
}

export type SharedMessage = {
  id: string
  author: { userId: string; name: string } | 'assistant'
  content: string
  timestamp: Date
  reactions: Reaction[]
}

export type SessionSettings = {
  maxParticipants: number
  allowViewers: boolean
  requireApproval: boolean
  sharedPermissions: boolean
}

export type SessionState = 'active' | 'paused' | 'ended'

export type SharedSession = {
  id: string
  name: string
  createdBy: string
  participants: Participant[]
  state: SessionState
  messages: SharedMessage[]
  createdAt: Date
  settings: SessionSettings
}

export type JoinResult = {
  success: boolean
  session?: SharedSession
  error?: string
}

export type ApprovalRequest = {
  id: string
  sessionId: string
  participant: Omit<Participant, 'joinedAt' | 'lastActive'>
  requestedAt: Date
  status: 'pending' | 'approved' | 'denied'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARTICIPANTS_HARD_LIMIT = 10

const PARTICIPANT_COLORS = [
  '#4A90D9',
  '#D94A4A',
  '#4AD97A',
  '#D9C74A',
  '#9B4AD9',
  '#D9884A',
  '#4AD9D9',
  '#D94A9B',
  '#7AD94A',
  '#4A5DD9',
]

const DEFAULT_SETTINGS: SessionSettings = {
  maxParticipants: MAX_PARTICIPANTS_HARD_LIMIT,
  allowViewers: true,
  requireApproval: false,
  sharedPermissions: true,
}

// ---------------------------------------------------------------------------
// SessionBroker
// ---------------------------------------------------------------------------

export class SessionBroker {
  private _sessions = new Map<string, SharedSession>()
  private _approvalQueue = new Map<string, ApprovalRequest[]>()
  private _colorIndex = new Map<string, number>()

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  createSession(
    name: string,
    createdBy: { userId: string; name: string },
    settings?: Partial<SessionSettings>,
  ): SharedSession {
    const mergedSettings: SessionSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
    }

    // Hard-cap maxParticipants
    mergedSettings.maxParticipants = Math.min(
      mergedSettings.maxParticipants,
      MAX_PARTICIPANTS_HARD_LIMIT,
    )

    const sessionId = randomUUID()
    const now = new Date()

    const owner: Participant = {
      userId: createdBy.userId,
      name: createdBy.name,
      role: 'owner',
      joinedAt: now,
      lastActive: now,
      color: PARTICIPANT_COLORS[0]!,
    }

    const session: SharedSession = {
      id: sessionId,
      name,
      createdBy: createdBy.userId,
      participants: [owner],
      state: 'active',
      messages: [],
      createdAt: now,
      settings: mergedSettings,
    }

    this._sessions.set(sessionId, session)
    this._approvalQueue.set(sessionId, [])
    this._colorIndex.set(sessionId, 1)

    return session
  }

  joinSession(
    sessionId: string,
    participant: { userId: string; name: string; role?: 'editor' | 'viewer' },
  ): JoinResult {
    const session = this._sessions.get(sessionId)
    if (!session) {
      return { success: false, error: 'Session not found' }
    }

    if (session.state === 'ended') {
      return { success: false, error: 'Session has ended' }
    }

    // Check if already a participant
    if (session.participants.some((p) => p.userId === participant.userId)) {
      return { success: false, error: 'Already a participant' }
    }

    const role = participant.role ?? 'editor'

    // Viewers check
    if (role === 'viewer' && !session.settings.allowViewers) {
      return { success: false, error: 'Viewers are not allowed in this session' }
    }

    // Max participants
    if (session.participants.length >= session.settings.maxParticipants) {
      return { success: false, error: 'Session is full' }
    }

    // Approval required?
    if (session.settings.requireApproval) {
      const request: ApprovalRequest = {
        id: randomUUID(),
        sessionId,
        participant: {
          userId: participant.userId,
          name: participant.name,
          role,
          color: this._nextColor(sessionId),
        },
        requestedAt: new Date(),
        status: 'pending',
      }

      const queue = this._approvalQueue.get(sessionId)!
      queue.push(request)

      return {
        success: false,
        error: `Approval required. Request ID: ${request.id}`,
      }
    }

    // Direct join
    const now = new Date()
    const newParticipant: Participant = {
      userId: participant.userId,
      name: participant.name,
      role,
      joinedAt: now,
      lastActive: now,
      color: this._nextColor(sessionId),
    }

    session.participants.push(newParticipant)
    return { success: true, session }
  }

  leaveSession(sessionId: string, userId: string): void {
    const session = this._sessions.get(sessionId)
    if (!session) return

    const idx = session.participants.findIndex((p) => p.userId === userId)
    if (idx === -1) return

    const leaving = session.participants[idx]!
    session.participants.splice(idx, 1)

    // If the owner leaves and there are remaining participants, promote the
    // earliest-joined editor (or viewer if no editors) to owner.
    if (leaving.role === 'owner' && session.participants.length > 0) {
      const editors = session.participants.filter((p) => p.role === 'editor')
      const promoted =
        editors.length > 0 ? editors[0]! : session.participants[0]!
      promoted.role = 'owner'
    }

    // End session if empty
    if (session.participants.length === 0) {
      session.state = 'ended'
    }
  }

  getSession(sessionId: string): SharedSession | null {
    return this._sessions.get(sessionId) ?? null
  }

  listActiveSessions(): SharedSession[] {
    const active: SharedSession[] = []
    for (const session of this._sessions.values()) {
      if (session.state !== 'ended') {
        active.push(session)
      }
    }
    return active
  }

  // -------------------------------------------------------------------------
  // Approval queue
  // -------------------------------------------------------------------------

  getApprovalQueue(sessionId: string): ApprovalRequest[] {
    return (this._approvalQueue.get(sessionId) ?? []).filter(
      (r) => r.status === 'pending',
    )
  }

  approveJoin(
    sessionId: string,
    requestId: string,
    approverId: string,
  ): JoinResult {
    const session = this._sessions.get(sessionId)
    if (!session) {
      return { success: false, error: 'Session not found' }
    }

    // Only the owner can approve
    const approver = session.participants.find(
      (p) => p.userId === approverId,
    )
    if (!approver || approver.role !== 'owner') {
      return { success: false, error: 'Only the owner can approve join requests' }
    }

    const queue = this._approvalQueue.get(sessionId) ?? []
    const request = queue.find(
      (r) => r.id === requestId && r.status === 'pending',
    )
    if (!request) {
      return { success: false, error: 'Approval request not found' }
    }

    if (session.participants.length >= session.settings.maxParticipants) {
      request.status = 'denied'
      return { success: false, error: 'Session is full' }
    }

    request.status = 'approved'

    const now = new Date()
    const newParticipant: Participant = {
      userId: request.participant.userId,
      name: request.participant.name,
      role: request.participant.role,
      joinedAt: now,
      lastActive: now,
      color: request.participant.color,
    }

    session.participants.push(newParticipant)
    return { success: true, session }
  }

  denyJoin(sessionId: string, requestId: string, denierId: string): boolean {
    const session = this._sessions.get(sessionId)
    if (!session) return false

    const denier = session.participants.find((p) => p.userId === denierId)
    if (!denier || denier.role !== 'owner') return false

    const queue = this._approvalQueue.get(sessionId) ?? []
    const request = queue.find(
      (r) => r.id === requestId && r.status === 'pending',
    )
    if (!request) return false

    request.status = 'denied'
    return true
  }

  // -------------------------------------------------------------------------
  // Session state
  // -------------------------------------------------------------------------

  pauseSession(sessionId: string, userId: string): boolean {
    const session = this._sessions.get(sessionId)
    if (!session || session.state !== 'active') return false

    const participant = session.participants.find(
      (p) => p.userId === userId,
    )
    if (!participant || participant.role !== 'owner') return false

    session.state = 'paused'
    return true
  }

  resumeSession(sessionId: string, userId: string): boolean {
    const session = this._sessions.get(sessionId)
    if (!session || session.state !== 'paused') return false

    const participant = session.participants.find(
      (p) => p.userId === userId,
    )
    if (!participant || participant.role !== 'owner') return false

    session.state = 'active'
    return true
  }

  endSession(sessionId: string, userId: string): boolean {
    const session = this._sessions.get(sessionId)
    if (!session || session.state === 'ended') return false

    const participant = session.participants.find(
      (p) => p.userId === userId,
    )
    if (!participant || participant.role !== 'owner') return false

    session.state = 'ended'
    return true
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _nextColor(sessionId: string): string {
    const idx = this._colorIndex.get(sessionId) ?? 0
    const color = PARTICIPANT_COLORS[idx % PARTICIPANT_COLORS.length]!
    this._colorIndex.set(sessionId, idx + 1)
    return color
  }
}
