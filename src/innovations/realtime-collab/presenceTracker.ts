/**
 * Real-time Collaboration - Presence Tracker
 *
 * Tracks participant presence, heartbeats, idle detection, focus state,
 * and status transitions for a collaboration session.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresenceStatus = 'active' | 'idle' | 'away' | 'typing'

export type PresenceState = {
  userId: string
  status: PresenceStatus
  lastHeartbeat: Date
  currentFocus?: string
}

export type StatusChangeHandler = (
  userId: string,
  oldStatus: PresenceStatus,
  newStatus: PresenceStatus,
) => void

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDLE_THRESHOLD_MS = 60_000    // 60 seconds
const AWAY_THRESHOLD_MS = 300_000   // 5 minutes

// ---------------------------------------------------------------------------
// PresenceTracker
// ---------------------------------------------------------------------------

export class PresenceTracker {
  private _presence = new Map<string, PresenceState>()
  private _sessionParticipants = new Map<string, Set<string>>()
  private _statusChangeHandler?: StatusChangeHandler
  private _checkInterval: ReturnType<typeof setInterval> | null = null

  /**
   * Optionally provide a callback for status changes and a custom check
   * interval (defaults to 15 seconds).
   */
  constructor(opts?: {
    onStatusChange?: StatusChangeHandler
    checkIntervalMs?: number
  }) {
    this._statusChangeHandler = opts?.onStatusChange

    const intervalMs = opts?.checkIntervalMs ?? 15_000
    this._checkInterval = setInterval(() => {
      this._checkIdleStates()
    }, intervalMs)

    // Unref so it doesn't prevent process exit
    if (this._checkInterval && typeof this._checkInterval === 'object' && 'unref' in this._checkInterval) {
      ;(this._checkInterval as NodeJS.Timeout).unref()
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a user's presence (call on join).
   */
  register(userId: string, sessionId?: string): void {
    if (!this._presence.has(userId)) {
      this._presence.set(userId, {
        userId,
        status: 'active',
        lastHeartbeat: new Date(),
      })
    }

    if (sessionId) {
      let participants = this._sessionParticipants.get(sessionId)
      if (!participants) {
        participants = new Set()
        this._sessionParticipants.set(sessionId, participants)
      }
      participants.add(userId)
    }
  }

  /**
   * Remove a user's presence (call on leave).
   */
  unregister(userId: string, sessionId?: string): void {
    this._presence.delete(userId)

    if (sessionId) {
      const participants = this._sessionParticipants.get(sessionId)
      if (participants) {
        participants.delete(userId)
        if (participants.size === 0) {
          this._sessionParticipants.delete(sessionId)
        }
      }
    }
  }

  /**
   * Update heartbeat for a user. Resets them to 'active' if they were
   * idle or away.
   */
  heartbeat(userId: string): void {
    const state = this._presence.get(userId)
    if (!state) return

    const oldStatus = state.status
    state.lastHeartbeat = new Date()

    // Coming back from idle/away
    if (oldStatus === 'idle' || oldStatus === 'away') {
      state.status = 'active'
      this._emitStatusChange(userId, oldStatus, 'active')
    }
  }

  /**
   * Explicitly set a user's status.
   */
  setStatus(userId: string, status: PresenceStatus): void {
    const state = this._presence.get(userId)
    if (!state) return

    const old = state.status
    if (old === status) return

    state.status = status
    // Also update heartbeat so idle detection doesn't immediately override
    if (status === 'active' || status === 'typing') {
      state.lastHeartbeat = new Date()
    }

    this._emitStatusChange(userId, old, status)
  }

  /**
   * Set the current focus for a user (e.g. "viewing file X").
   */
  setFocus(userId: string, focus: string): void {
    const state = this._presence.get(userId)
    if (!state) return

    state.currentFocus = focus
    // Also refresh heartbeat
    state.lastHeartbeat = new Date()

    // If idle/away, bring back to active
    if (state.status === 'idle' || state.status === 'away') {
      const old = state.status
      state.status = 'active'
      this._emitStatusChange(userId, old, 'active')
    }
  }

  /**
   * Get presence state for a single user.
   */
  getPresence(userId: string): PresenceState | null {
    return this._presence.get(userId) ?? null
  }

  /**
   * Get all active participants for a session.
   */
  getActiveParticipants(sessionId: string): PresenceState[] {
    const participants = this._sessionParticipants.get(sessionId)
    if (!participants) return []

    const result: PresenceState[] = []
    for (const userId of participants) {
      const state = this._presence.get(userId)
      if (state) result.push(state)
    }
    return result
  }

  /**
   * Update the status change callback.
   */
  set onStatusChange(handler: StatusChangeHandler | undefined) {
    this._statusChangeHandler = handler
  }

  /**
   * Manually trigger idle checks (useful for testing without waiting for
   * the interval).
   */
  checkIdle(): void {
    this._checkIdleStates()
  }

  /**
   * Clean up the interval timer.
   */
  destroy(): void {
    if (this._checkInterval) {
      clearInterval(this._checkInterval)
      this._checkInterval = null
    }
    this._presence.clear()
    this._sessionParticipants.clear()
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _checkIdleStates(): void {
    const now = Date.now()

    for (const state of this._presence.values()) {
      const elapsed = now - state.lastHeartbeat.getTime()
      const oldStatus = state.status

      // Don't override explicit 'typing' status via idle check
      if (oldStatus === 'typing') continue

      if (elapsed >= AWAY_THRESHOLD_MS && oldStatus !== 'away') {
        state.status = 'away'
        this._emitStatusChange(state.userId, oldStatus, 'away')
      } else if (
        elapsed >= IDLE_THRESHOLD_MS &&
        elapsed < AWAY_THRESHOLD_MS &&
        oldStatus !== 'idle'
      ) {
        state.status = 'idle'
        this._emitStatusChange(state.userId, oldStatus, 'idle')
      }
    }
  }

  private _emitStatusChange(
    userId: string,
    oldStatus: PresenceStatus,
    newStatus: PresenceStatus,
  ): void {
    if (this._statusChangeHandler && oldStatus !== newStatus) {
      this._statusChangeHandler(userId, oldStatus, newStatus)
    }
  }
}
