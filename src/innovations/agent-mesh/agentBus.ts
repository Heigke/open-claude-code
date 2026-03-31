/**
 * Agent Mesh - Agent Bus
 *
 * Event-based message bus for inter-agent communication.
 * Supports publish/subscribe, broadcast, message queuing with retry,
 * and agent lifecycle callbacks.
 */

import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMessageType =
  | 'knowledge_update'
  | 'conflict_detected'
  | 'work_complete'
  | 'work_request'
  | 'status'

export type AgentMessage = {
  from: string
  to: string | 'broadcast'
  type: AgentMessageType
  payload: unknown
  /** Set internally by the bus */
  id?: string
  timestamp?: number
}

export type MessageHandler = (message: AgentMessage) => void | Promise<void>

type QueuedMessage = {
  message: AgentMessage
  attempts: number
  targetAgent: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DELIVERY_ATTEMPTS = 3
const RETRY_DELAY_MS = 200

// ---------------------------------------------------------------------------
// AgentBus
// ---------------------------------------------------------------------------

export class AgentBus {
  private _emitter = new EventEmitter()
  private _handlers = new Map<string, MessageHandler>()
  private _activeAgents = new Set<string>()
  private _messageQueue: QueuedMessage[] = []
  private _nextMessageId = 1
  private _retryTimers = new Set<ReturnType<typeof setTimeout>>()

  private _onAgentJoin?: (agentId: string) => void
  private _onAgentLeave?: (agentId: string) => void

  constructor() {
    // Increase default max listeners to avoid warnings in large meshes
    this._emitter.setMaxListeners(100)
  }

  // ---- Agent lifecycle ----------------------------------------------------

  /**
   * Subscribe an agent to receive messages.
   */
  subscribe(agentId: string, handler: MessageHandler): void {
    if (this._handlers.has(agentId)) {
      throw new Error(`Agent '${agentId}' is already subscribed`)
    }

    this._handlers.set(agentId, handler)
    this._activeAgents.add(agentId)

    // Listen on agent-specific channel
    this._emitter.on(`msg:${agentId}`, handler)
    // Listen on broadcast channel
    this._emitter.on('msg:broadcast', handler)

    this._onAgentJoin?.(agentId)

    // Drain any queued messages for this agent
    this._drainQueue(agentId)
  }

  /**
   * Unsubscribe an agent.
   */
  unsubscribe(agentId: string): void {
    const handler = this._handlers.get(agentId)
    if (handler) {
      this._emitter.off(`msg:${agentId}`, handler)
      this._emitter.off('msg:broadcast', handler)
      this._handlers.delete(agentId)
    }
    this._activeAgents.delete(agentId)
    this._onAgentLeave?.(agentId)
  }

  // ---- Messaging ----------------------------------------------------------

  /**
   * Publish a message to a specific agent or broadcast.
   */
  publish(message: AgentMessage): void {
    const enriched: AgentMessage = {
      ...message,
      id: `msg_${this._nextMessageId++}`,
      timestamp: Date.now(),
    }

    if (enriched.to === 'broadcast') {
      this.broadcast(enriched)
      return
    }

    if (this._activeAgents.has(enriched.to)) {
      this._deliver(enriched.to, enriched)
    } else {
      // Agent not online - queue for retry
      this._enqueue(enriched, enriched.to)
    }
  }

  /**
   * Broadcast a message to all active agents (except the sender).
   */
  broadcast(message: AgentMessage): void {
    const enriched: AgentMessage = {
      ...message,
      id: message.id ?? `msg_${this._nextMessageId++}`,
      timestamp: message.timestamp ?? Date.now(),
      to: 'broadcast',
    }

    // Emit on broadcast channel; handlers filter out self-delivery
    for (const agentId of this._activeAgents) {
      if (agentId !== enriched.from) {
        this._deliver(agentId, enriched)
      }
    }
  }

  // ---- Queries ------------------------------------------------------------

  getActiveAgents(): string[] {
    return Array.from(this._activeAgents)
  }

  get pendingMessageCount(): number {
    return this._messageQueue.length
  }

  // ---- Callbacks ----------------------------------------------------------

  set onAgentJoin(callback: (agentId: string) => void) {
    this._onAgentJoin = callback
  }

  set onAgentLeave(callback: (agentId: string) => void) {
    this._onAgentLeave = callback
  }

  // ---- Cleanup ------------------------------------------------------------

  destroy(): void {
    for (const timer of this._retryTimers) {
      clearTimeout(timer)
    }
    this._retryTimers.clear()
    this._emitter.removeAllListeners()
    this._handlers.clear()
    this._activeAgents.clear()
    this._messageQueue = []
  }

  // ---- Internals ----------------------------------------------------------

  private _deliver(agentId: string, message: AgentMessage): void {
    try {
      this._emitter.emit(`msg:${agentId}`, message)
    } catch {
      // Handler threw synchronously - queue for retry
      this._enqueue(message, agentId)
    }
  }

  private _enqueue(message: AgentMessage, targetAgent: string): void {
    const existing = this._messageQueue.find(
      (q) => q.message.id === message.id && q.targetAgent === targetAgent,
    )
    if (existing) {
      // Already queued
      return
    }

    this._messageQueue.push({
      message,
      attempts: 0,
      targetAgent,
    })

    this._scheduleRetry(targetAgent)
  }

  private _scheduleRetry(targetAgent: string): void {
    const timer = setTimeout(() => {
      this._retryTimers.delete(timer)
      this._drainQueue(targetAgent)
    }, RETRY_DELAY_MS)
    this._retryTimers.add(timer)
  }

  private _drainQueue(agentId: string): void {
    const remaining: QueuedMessage[] = []

    for (const queued of this._messageQueue) {
      if (queued.targetAgent !== agentId) {
        remaining.push(queued)
        continue
      }

      queued.attempts++

      if (!this._activeAgents.has(agentId)) {
        // Agent still offline
        if (queued.attempts < MAX_DELIVERY_ATTEMPTS) {
          remaining.push(queued)
          this._scheduleRetry(agentId)
        }
        // else: drop after max attempts
        continue
      }

      try {
        this._emitter.emit(`msg:${agentId}`, queued.message)
        // Delivered successfully
      } catch {
        if (queued.attempts < MAX_DELIVERY_ATTEMPTS) {
          remaining.push(queued)
          this._scheduleRetry(agentId)
        }
      }
    }

    this._messageQueue = remaining
  }
}
