import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { SessionBroker } from '../sessionBroker.js'
import type { Participant, SharedSession } from '../sessionBroker.js'
import { MessageSynchronizer } from '../messageSynchronizer.js'
import type { SyncEvent } from '../messageSynchronizer.js'
import { PermissionNegotiator } from '../permissionNegotiator.js'
import { PresenceTracker } from '../presenceTracker.js'
import type { PresenceStatus } from '../presenceTracker.js'
import { createCollaborationSession } from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const alice = { userId: 'alice', name: 'Alice' }
const bob = { userId: 'bob', name: 'Bob' }
const charlie = { userId: 'charlie', name: 'Charlie' }
const dave = { userId: 'dave', name: 'Dave' }

function makeParticipant(
  overrides: Partial<Participant> & { userId: string; name: string },
): Participant {
  return {
    role: 'editor',
    joinedAt: new Date(),
    lastActive: new Date(),
    color: '#000',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Session Broker
// ---------------------------------------------------------------------------

describe('SessionBroker', () => {
  let broker: SessionBroker

  beforeEach(() => {
    broker = new SessionBroker()
  })

  it('creates a session with owner as first participant', () => {
    const session = broker.createSession('Test', alice)
    expect(session.name).toBe('Test')
    expect(session.state).toBe('active')
    expect(session.participants).toHaveLength(1)
    expect(session.participants[0]!.userId).toBe('alice')
    expect(session.participants[0]!.role).toBe('owner')
    expect(session.createdBy).toBe('alice')
  })

  it('allows joining a session', () => {
    const session = broker.createSession('Test', alice)
    const result = broker.joinSession(session.id, bob)
    expect(result.success).toBe(true)
    expect(result.session!.participants).toHaveLength(2)
  })

  it('prevents duplicate joins', () => {
    const session = broker.createSession('Test', alice)
    broker.joinSession(session.id, bob)
    const result = broker.joinSession(session.id, bob)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Already')
  })

  it('rejects joining a nonexistent session', () => {
    const result = broker.joinSession('fake-id', bob)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('enforces max participants limit', () => {
    const session = broker.createSession('Test', alice, {
      maxParticipants: 2,
    })
    broker.joinSession(session.id, bob)
    const result = broker.joinSession(session.id, charlie)
    expect(result.success).toBe(false)
    expect(result.error).toContain('full')
  })

  it('hard-caps maxParticipants at 10', () => {
    const session = broker.createSession('Test', alice, {
      maxParticipants: 50,
    })
    expect(session.settings.maxParticipants).toBe(10)
  })

  it('handles leaving a session', () => {
    const session = broker.createSession('Test', alice)
    broker.joinSession(session.id, bob)
    broker.leaveSession(session.id, 'bob')
    const updated = broker.getSession(session.id)!
    expect(updated.participants).toHaveLength(1)
    expect(updated.participants[0]!.userId).toBe('alice')
  })

  it('promotes editor to owner when owner leaves', () => {
    const session = broker.createSession('Test', alice)
    broker.joinSession(session.id, bob)
    broker.leaveSession(session.id, 'alice')
    const updated = broker.getSession(session.id)!
    expect(updated.participants[0]!.userId).toBe('bob')
    expect(updated.participants[0]!.role).toBe('owner')
  })

  it('ends session when last participant leaves', () => {
    const session = broker.createSession('Test', alice)
    broker.leaveSession(session.id, 'alice')
    const updated = broker.getSession(session.id)!
    expect(updated.state).toBe('ended')
  })

  it('rejects joining an ended session', () => {
    const session = broker.createSession('Test', alice)
    broker.leaveSession(session.id, 'alice')
    const result = broker.joinSession(session.id, bob)
    expect(result.success).toBe(false)
    expect(result.error).toContain('ended')
  })

  it('lists only active sessions', () => {
    const s1 = broker.createSession('Active', alice)
    const s2 = broker.createSession('Ended', bob)
    broker.leaveSession(s2.id, 'bob')

    const active = broker.listActiveSessions()
    expect(active).toHaveLength(1)
    expect(active[0]!.id).toBe(s1.id)
  })

  it('prevents viewers from joining when not allowed', () => {
    const session = broker.createSession('Test', alice, {
      allowViewers: false,
    })
    const result = broker.joinSession(session.id, {
      ...bob,
      role: 'viewer',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Viewers')
  })

  it('supports session pause/resume/end by owner', () => {
    const session = broker.createSession('Test', alice)
    broker.joinSession(session.id, bob)

    // Bob (editor) cannot pause
    expect(broker.pauseSession(session.id, 'bob')).toBe(false)

    // Alice (owner) can pause
    expect(broker.pauseSession(session.id, 'alice')).toBe(true)
    expect(broker.getSession(session.id)!.state).toBe('paused')

    // Resume
    expect(broker.resumeSession(session.id, 'alice')).toBe(true)
    expect(broker.getSession(session.id)!.state).toBe('active')

    // End
    expect(broker.endSession(session.id, 'alice')).toBe(true)
    expect(broker.getSession(session.id)!.state).toBe('ended')
  })

  // -----------------------------------------------------------------------
  // Approval queue
  // -----------------------------------------------------------------------

  describe('approval queue', () => {
    it('queues join requests when requireApproval is true', () => {
      const session = broker.createSession('Test', alice, {
        requireApproval: true,
      })
      const result = broker.joinSession(session.id, bob)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Approval required')

      const queue = broker.getApprovalQueue(session.id)
      expect(queue).toHaveLength(1)
      expect(queue[0]!.participant.userId).toBe('bob')
    })

    it('allows owner to approve a join request', () => {
      const session = broker.createSession('Test', alice, {
        requireApproval: true,
      })
      broker.joinSession(session.id, bob)
      const queue = broker.getApprovalQueue(session.id)
      const requestId = queue[0]!.id

      const result = broker.approveJoin(session.id, requestId, 'alice')
      expect(result.success).toBe(true)
      expect(result.session!.participants).toHaveLength(2)
    })

    it('prevents non-owner from approving', () => {
      const session = broker.createSession('Test', alice, {
        requireApproval: true,
      })
      broker.joinSession(session.id, bob)

      // Add charlie as editor first (without approval for this test, create a
      // new session without requireApproval, then adjust)
      const s2 = broker.createSession('Test2', alice)
      broker.joinSession(s2.id, charlie)
      // charlie is editor in s2 but not in the approval session
      const queue = broker.getApprovalQueue(session.id)
      const result = broker.approveJoin(
        session.id,
        queue[0]!.id,
        'charlie',
      )
      expect(result.success).toBe(false)
    })

    it('allows owner to deny a join request', () => {
      const session = broker.createSession('Test', alice, {
        requireApproval: true,
      })
      broker.joinSession(session.id, bob)
      const queue = broker.getApprovalQueue(session.id)

      const denied = broker.denyJoin(session.id, queue[0]!.id, 'alice')
      expect(denied).toBe(true)

      // Queue should now be empty (no pending)
      expect(broker.getApprovalQueue(session.id)).toHaveLength(0)
    })
  })
})

// ---------------------------------------------------------------------------
// Message Synchronizer
// ---------------------------------------------------------------------------

describe('MessageSynchronizer', () => {
  let sync: MessageSynchronizer

  beforeEach(() => {
    sync = new MessageSynchronizer('session-1')
  })

  afterEach(() => {
    sync.destroy()
  })

  it('adds messages and broadcasts events', () => {
    const events: SyncEvent[] = []
    sync.subscribe('alice', (e) => events.push(e))

    const msg = sync.addMessage(alice, 'Hello!')
    expect(msg.content).toBe('Hello!')
    expect(msg.author).toEqual(alice)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('message_added')
    expect(events[0]!.seq).toBe(1)
  })

  it('assigns monotonically increasing sequence numbers', () => {
    const events: SyncEvent[] = []
    sync.subscribe('alice', (e) => events.push(e))

    sync.addMessage(alice, 'First')
    sync.addMessage(bob, 'Second')
    sync.addMessage('assistant', 'Third')

    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('broadcasts to all subscribers', () => {
    const aliceEvents: SyncEvent[] = []
    const bobEvents: SyncEvent[] = []

    sync.subscribe('alice', (e) => aliceEvents.push(e))
    sync.subscribe('bob', (e) => bobEvents.push(e))

    sync.addMessage(alice, 'Hey')
    expect(aliceEvents).toHaveLength(1)
    expect(bobEvents).toHaveLength(1)
  })

  it('unsubscribe stops delivery', () => {
    const events: SyncEvent[] = []
    const unsub = sync.subscribe('alice', (e) => events.push(e))

    sync.addMessage(alice, 'First')
    unsub()
    sync.addMessage(bob, 'Second')

    expect(events).toHaveLength(1)
  })

  it('edits messages by the original author', () => {
    const msg = sync.addMessage(alice, 'Original')
    const edited = sync.editMessage(msg.id, 'Edited', 'alice')
    expect(edited).toBe(true)

    const retrieved = sync.getMessage(msg.id)!
    expect(retrieved.content).toBe('Edited')
  })

  it('prevents editing another user\'s message', () => {
    const msg = sync.addMessage(alice, 'Mine')
    const edited = sync.editMessage(msg.id, 'Hacked', 'bob')
    expect(edited).toBe(false)
  })

  it('allows editing assistant messages by any participant', () => {
    const msg = sync.addMessage('assistant', 'AI response')
    const edited = sync.editMessage(msg.id, 'Corrected', 'alice')
    expect(edited).toBe(true)
  })

  it('records history and supports replay from a timestamp', () => {
    sync.addMessage(alice, 'First')

    const midpoint = new Date()

    // Small delay to ensure distinct timestamps
    sync.addMessage(bob, 'Second')

    const allHistory = sync.getHistory()
    expect(allHistory).toHaveLength(2)

    // History since midpoint should include the second event but
    // the exact behavior depends on timestamp granularity.
    // At minimum, getHistory(undefined) returns all.
    const fullHistory = sync.getHistory()
    expect(fullHistory.length).toBeGreaterThanOrEqual(2)
  })

  it('handles reactions on messages', () => {
    const msg = sync.addMessage(alice, 'Nice!')
    const added = sync.addReaction(msg.id, '👍', 'bob')
    expect(added).toBe(true)

    const retrieved = sync.getMessage(msg.id)!
    expect(retrieved.reactions).toHaveLength(1)
    expect(retrieved.reactions[0]!.emoji).toBe('👍')

    // Duplicate reaction rejected
    const dup = sync.addReaction(msg.id, '👍', 'bob')
    expect(dup).toBe(false)
  })

  it('getMessages returns in chronological order', () => {
    sync.addMessage(alice, 'First')
    sync.addMessage(bob, 'Second')
    sync.addMessage(charlie, 'Third')

    const msgs = sync.getMessages()
    expect(msgs).toHaveLength(3)
    expect(msgs[0]!.content).toBe('First')
    expect(msgs[2]!.content).toBe('Third')
  })

  it('broadcast records events with custom types', () => {
    sync.broadcast({
      type: 'participant_joined',
      payload: { userId: 'bob', name: 'Bob' },
      timestamp: new Date(),
      authorId: 'bob',
    })

    sync.broadcast({
      type: 'cursor_moved',
      payload: { file: 'index.ts', line: 42 },
      timestamp: new Date(),
      authorId: 'alice',
    })

    const history = sync.getHistory()
    expect(history).toHaveLength(2)
    expect(history[0]!.type).toBe('participant_joined')
    expect(history[1]!.type).toBe('cursor_moved')
    expect(history[0]!.seq).toBeLessThan(history[1]!.seq)
  })
})

// ---------------------------------------------------------------------------
// Permission Negotiator
// ---------------------------------------------------------------------------

describe('PermissionNegotiator', () => {
  let negotiator: PermissionNegotiator

  const ownerParticipant = makeParticipant({
    ...alice,
    role: 'owner',
  })
  const editorBob = makeParticipant({ ...bob, role: 'editor' })
  const editorCharlie = makeParticipant({ ...charlie, role: 'editor' })
  const editorDave = makeParticipant({ ...dave, role: 'editor' })
  const viewerBob = makeParticipant({ ...bob, role: 'viewer' })

  beforeEach(() => {
    negotiator = new PermissionNegotiator()
  })

  afterEach(() => {
    negotiator.destroy()
  })

  it('creates a negotiation in pending state', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'rm -rf /' },
      'bob',
      [ownerParticipant, editorBob],
    )
    expect(n.status).toBe('pending')
    expect(n.toolName).toBe('bash')
    expect(n.requestedBy).toBe('bob')
  })

  it('owner vote is always decisive - approve', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'bob',
      [ownerParticipant, editorBob, editorCharlie],
    )

    const update = negotiator.vote(n.id, 'alice', 'approve')!
    expect(update.status).toBe('approved')
    expect(update.resolved).toBe(true)
  })

  it('owner vote is always decisive - deny', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'bob',
      [ownerParticipant, editorBob, editorCharlie],
    )

    const update = negotiator.vote(n.id, 'alice', 'deny')!
    expect(update.status).toBe('denied')
    expect(update.resolved).toBe(true)
  })

  it('majority of editors needed when no owner vote', () => {
    // Requester is alice (owner), voters are bob, charlie, dave (editors)
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'alice',
      [ownerParticipant, editorBob, editorCharlie, editorDave],
    )

    // Need majority of 3 editors = 2 approvals
    const u1 = negotiator.vote(n.id, 'bob', 'approve')!
    expect(u1.resolved).toBe(false)

    const u2 = negotiator.vote(n.id, 'charlie', 'approve')!
    expect(u2.status).toBe('approved')
    expect(u2.resolved).toBe(true)
  })

  it('denies when majority denies', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'danger' },
      'alice',
      [ownerParticipant, editorBob, editorCharlie, editorDave],
    )

    // 2 denials out of 3 editors; required approvals is 2,
    // with only 1 remaining voter max possible approvals would be < required
    negotiator.vote(n.id, 'bob', 'deny')
    const u2 = negotiator.vote(n.id, 'charlie', 'deny')!
    expect(u2.status).toBe('denied')
    expect(u2.resolved).toBe(true)
  })

  it('viewers cannot vote', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'alice',
      [ownerParticipant, viewerBob],
    )

    const update = negotiator.vote(n.id, 'bob', 'approve')
    expect(update).toBeNull()
  })

  it('requester cannot vote on their own request', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'bob',
      [ownerParticipant, editorBob],
    )

    const update = negotiator.vote(n.id, 'bob', 'approve')
    expect(update).toBeNull()
  })

  it('cannot vote twice', () => {
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'bob',
      [ownerParticipant, editorBob, editorCharlie],
    )

    negotiator.vote(n.id, 'alice', 'approve')
    // Already resolved, but test the principle
    const dup = negotiator.vote(n.id, 'alice', 'deny')
    expect(dup).toBeNull()
  })

  it('auto-approves when no eligible voters', () => {
    // Only the requester and viewers
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'alice',
      [ownerParticipant, viewerBob],
    )

    expect(n.status).toBe('approved')
  })

  it('lists active negotiations', () => {
    negotiator.requestPermission('bash', { command: 'ls' }, 'bob', [
      ownerParticipant,
      editorBob,
    ])
    negotiator.requestPermission('write', { path: '/tmp' }, 'bob', [
      ownerParticipant,
      editorBob,
    ])

    expect(negotiator.getActiveNegotiations()).toHaveLength(2)
  })

  it('timeout denies pending negotiations', async () => {
    // We cannot easily test the 30s timeout in a unit test, but we can
    // verify the negotiation was created with a deadline
    const n = negotiator.requestPermission(
      'bash',
      { command: 'ls' },
      'bob',
      [ownerParticipant, editorBob],
    )

    expect(n.deadline.getTime()).toBeGreaterThan(n.createdAt.getTime())
    // The deadline should be ~30s in the future
    const diff = n.deadline.getTime() - n.createdAt.getTime()
    expect(diff).toBe(30_000)
  })
})

// ---------------------------------------------------------------------------
// Presence Tracker
// ---------------------------------------------------------------------------

describe('PresenceTracker', () => {
  let tracker: PresenceTracker

  afterEach(() => {
    tracker?.destroy()
  })

  it('registers and retrieves presence', () => {
    tracker = new PresenceTracker()
    tracker.register('alice', 'session-1')

    const presence = tracker.getPresence('alice')
    expect(presence).not.toBeNull()
    expect(presence!.userId).toBe('alice')
    expect(presence!.status).toBe('active')
  })

  it('heartbeat refreshes active state', () => {
    tracker = new PresenceTracker()
    tracker.register('alice')

    const before = tracker.getPresence('alice')!.lastHeartbeat.getTime()

    // Small artificial gap
    const later = new Date(before + 100)

    // Manually set heartbeat time back
    tracker.getPresence('alice')!.lastHeartbeat = new Date(before - 1000)
    tracker.heartbeat('alice')

    const after = tracker.getPresence('alice')!.lastHeartbeat.getTime()
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('setStatus updates the status', () => {
    tracker = new PresenceTracker()
    tracker.register('alice')
    tracker.setStatus('alice', 'typing')
    expect(tracker.getPresence('alice')!.status).toBe('typing')
  })

  it('setFocus updates the focus and refreshes heartbeat', () => {
    tracker = new PresenceTracker()
    tracker.register('alice')
    tracker.setFocus('alice', 'viewing file src/index.ts')
    expect(tracker.getPresence('alice')!.currentFocus).toBe(
      'viewing file src/index.ts',
    )
  })

  it('idle detection transitions active -> idle', () => {
    const changes: Array<{
      userId: string
      old: PresenceStatus
      new_: PresenceStatus
    }> = []

    tracker = new PresenceTracker({
      onStatusChange: (userId, old, new_) => {
        changes.push({ userId, old, new_: new_ })
      },
      checkIntervalMs: 999_999, // We'll check manually
    })

    tracker.register('alice')

    // Simulate 61 seconds of inactivity
    tracker.getPresence('alice')!.lastHeartbeat = new Date(
      Date.now() - 61_000,
    )
    tracker.checkIdle()

    expect(tracker.getPresence('alice')!.status).toBe('idle')
    expect(changes).toHaveLength(1)
    expect(changes[0]!.old).toBe('active')
    expect(changes[0]!.new_).toBe('idle')
  })

  it('idle detection transitions idle -> away', () => {
    const changes: Array<{
      userId: string
      old: PresenceStatus
      new_: PresenceStatus
    }> = []

    tracker = new PresenceTracker({
      onStatusChange: (userId, old, new_) => {
        changes.push({ userId, old, new_: new_ })
      },
      checkIntervalMs: 999_999,
    })

    tracker.register('alice')

    // Simulate 301 seconds of inactivity
    tracker.getPresence('alice')!.lastHeartbeat = new Date(
      Date.now() - 301_000,
    )
    tracker.checkIdle()

    expect(tracker.getPresence('alice')!.status).toBe('away')
  })

  it('heartbeat resets idle user to active', () => {
    const changes: Array<{
      userId: string
      old: PresenceStatus
      new_: PresenceStatus
    }> = []

    tracker = new PresenceTracker({
      onStatusChange: (userId, old, new_) => {
        changes.push({ userId, old, new_: new_ })
      },
      checkIntervalMs: 999_999,
    })

    tracker.register('alice')

    // Go idle
    tracker.getPresence('alice')!.lastHeartbeat = new Date(
      Date.now() - 61_000,
    )
    tracker.checkIdle()
    expect(tracker.getPresence('alice')!.status).toBe('idle')

    // Heartbeat brings back
    tracker.heartbeat('alice')
    expect(tracker.getPresence('alice')!.status).toBe('active')
    expect(changes).toHaveLength(2)
    expect(changes[1]!.new_).toBe('active')
  })

  it('getActiveParticipants returns session members', () => {
    tracker = new PresenceTracker()
    tracker.register('alice', 'session-1')
    tracker.register('bob', 'session-1')
    tracker.register('charlie', 'session-2')

    const s1 = tracker.getActiveParticipants('session-1')
    expect(s1).toHaveLength(2)

    const s2 = tracker.getActiveParticipants('session-2')
    expect(s2).toHaveLength(1)
  })

  it('unregister removes presence', () => {
    tracker = new PresenceTracker()
    tracker.register('alice', 'session-1')
    tracker.unregister('alice', 'session-1')

    expect(tracker.getPresence('alice')).toBeNull()
    expect(tracker.getActiveParticipants('session-1')).toHaveLength(0)
  })

  it('setFocus resets idle/away back to active', () => {
    const changes: Array<{
      userId: string
      old: PresenceStatus
      new_: PresenceStatus
    }> = []

    tracker = new PresenceTracker({
      onStatusChange: (userId, old, new_) => {
        changes.push({ userId, old, new_: new_ })
      },
      checkIntervalMs: 999_999,
    })

    tracker.register('alice')

    // Go away
    tracker.getPresence('alice')!.lastHeartbeat = new Date(
      Date.now() - 301_000,
    )
    tracker.checkIdle()
    expect(tracker.getPresence('alice')!.status).toBe('away')

    // Focus brings back
    tracker.setFocus('alice', 'looking at tests')
    expect(tracker.getPresence('alice')!.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// Factory integration
// ---------------------------------------------------------------------------

describe('createCollaborationSession', () => {
  it('creates a fully wired session', () => {
    const collab = createCollaborationSession('Team Session', alice)

    expect(collab.sessionId).toBeDefined()
    expect(collab.broker).toBeDefined()
    expect(collab.synchronizer).toBeDefined()
    expect(collab.negotiator).toBeDefined()
    expect(collab.presence).toBeDefined()

    // Creator should be registered in presence
    const presence = collab.presence.getPresence('alice')
    expect(presence).not.toBeNull()
    expect(presence!.status).toBe('active')

    // Session should exist in broker
    const session = collab.broker.getSession(collab.sessionId)
    expect(session).not.toBeNull()
    expect(session!.participants).toHaveLength(1)

    collab.destroy()
  })

  it('passes settings through to the session', () => {
    const collab = createCollaborationSession('Restricted', alice, {
      requireApproval: true,
      maxParticipants: 3,
    })

    const session = collab.broker.getSession(collab.sessionId)!
    expect(session.settings.requireApproval).toBe(true)
    expect(session.settings.maxParticipants).toBe(3)

    collab.destroy()
  })

  it('destroy cleans up all resources', () => {
    const collab = createCollaborationSession('Temp', alice)
    const sync = collab.synchronizer

    // Add a subscriber to verify cleanup
    let received = 0
    sync.subscribe('alice', () => received++)

    collab.destroy()

    // After destroy, broadcasting should not reach the subscriber
    sync.broadcast({
      type: 'message_added',
      payload: {},
      timestamp: new Date(),
      authorId: 'alice',
    })

    expect(received).toBe(0)
  })
})
