/**
 * Real-time Collaboration - Message Synchronizer
 *
 * Handles ordered message delivery, event broadcasting, conflict resolution,
 * and history replay for shared sessions.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { SharedMessage, Reaction } from './sessionBroker.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncEventType =
  | 'message_added'
  | 'message_edited'
  | 'participant_joined'
  | 'participant_left'
  | 'cursor_moved'
  | 'permission_request'
  | 'permission_response'
  | 'session_state_changed'

export type SyncEvent = {
  type: SyncEventType
  payload: unknown
  timestamp: Date
  authorId: string
  /** Monotonic sequence number assigned by the synchronizer */
  seq: number
}

export type SyncHandler = (event: SyncEvent) => void

// ---------------------------------------------------------------------------
// MessageSynchronizer
// ---------------------------------------------------------------------------

export class MessageSynchronizer {
  readonly sessionId: string

  private _emitter = new EventEmitter()
  private _subscribers = new Map<string, SyncHandler>()
  private _messages = new Map<string, SharedMessage>()
  private _history: SyncEvent[] = []
  private _seq = 0

  constructor(sessionId: string) {
    this.sessionId = sessionId
    // Allow many subscribers without warning
    this._emitter.setMaxListeners(100)
  }

  // -------------------------------------------------------------------------
  // Pub/Sub
  // -------------------------------------------------------------------------

  /**
   * Broadcast an event to all subscribers.
   * Assigns a monotonic sequence number and records in history.
   */
  broadcast(event: Omit<SyncEvent, 'seq'>): SyncEvent {
    const fullEvent: SyncEvent = {
      ...event,
      seq: ++this._seq,
    }

    this._history.push(fullEvent)
    this._emitter.emit('sync', fullEvent)
    return fullEvent
  }

  /**
   * Subscribe to sync events. Returns an unsubscribe function.
   */
  subscribe(userId: string, handler: SyncHandler): () => void {
    // Remove existing subscription for this user if any
    const existing = this._subscribers.get(userId)
    if (existing) {
      this._emitter.removeListener('sync', existing)
    }

    this._subscribers.set(userId, handler)
    this._emitter.on('sync', handler)

    return () => {
      this._emitter.removeListener('sync', handler)
      this._subscribers.delete(userId)
    }
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Add a message to the session and broadcast it.
   */
  addMessage(
    author: { userId: string; name: string } | 'assistant',
    content: string,
  ): SharedMessage {
    const message: SharedMessage = {
      id: randomUUID(),
      author,
      content,
      timestamp: new Date(),
      reactions: [],
    }

    this._messages.set(message.id, message)

    const authorId =
      author === 'assistant' ? '__assistant__' : author.userId

    this.broadcast({
      type: 'message_added',
      payload: message,
      timestamp: message.timestamp,
      authorId,
    })

    return message
  }

  /**
   * Edit a message. Returns true if the edit was applied.
   * Uses last-write-wins with sequence validation: the edit is applied
   * only if the message exists and the editor is the original author
   * or the assistant message is being edited by any participant.
   */
  editMessage(
    messageId: string,
    newContent: string,
    editorId: string,
  ): boolean {
    const message = this._messages.get(messageId)
    if (!message) return false

    // Only the original author can edit their own messages,
    // but any participant can edit assistant messages.
    if (message.author !== 'assistant') {
      if (message.author.userId !== editorId) return false
    }

    const oldContent = message.content
    message.content = newContent

    this.broadcast({
      type: 'message_edited',
      payload: {
        messageId,
        oldContent,
        newContent,
        editorId,
      },
      timestamp: new Date(),
      authorId: editorId,
    })

    return true
  }

  /**
   * Add a reaction to a message.
   */
  addReaction(messageId: string, emoji: string, userId: string): boolean {
    const message = this._messages.get(messageId)
    if (!message) return false

    // Don't allow duplicate reactions from the same user with the same emoji
    if (message.reactions.some((r) => r.userId === userId && r.emoji === emoji)) {
      return false
    }

    const reaction: Reaction = {
      emoji,
      userId,
      timestamp: new Date(),
    }

    message.reactions.push(reaction)
    return true
  }

  /**
   * Get a specific message by ID.
   */
  getMessage(messageId: string): SharedMessage | undefined {
    return this._messages.get(messageId)
  }

  /**
   * Get all messages in chronological order.
   */
  getMessages(): SharedMessage[] {
    return Array.from(this._messages.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    )
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * Retrieve event history, optionally filtered by a start time.
   */
  getHistory(since?: Date): SyncEvent[] {
    if (!since) return [...this._history]

    const sinceMs = since.getTime()
    return this._history.filter((e) => e.timestamp.getTime() >= sinceMs)
  }

  /**
   * Get the current sequence number.
   */
  getSequence(): number {
    return this._seq
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  destroy(): void {
    this._emitter.removeAllListeners()
    this._subscribers.clear()
    this._messages.clear()
    this._history = []
  }
}
