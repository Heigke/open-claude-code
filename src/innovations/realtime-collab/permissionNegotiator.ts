/**
 * Real-time Collaboration - Permission Negotiator
 *
 * Handles collaborative tool-permission voting. Participants vote to approve
 * or deny tool executions, with owner-decisive and majority-vote rules.
 */

import { randomUUID } from 'node:crypto'
import type { Participant } from './sessionBroker.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PermissionVote = {
  participantId: string
  vote: 'approve' | 'deny' | 'abstain'
  reason?: string
}

export type NegotiationStatus = 'pending' | 'approved' | 'denied' | 'timeout'

export type PermissionNegotiation = {
  id: string
  toolName: string
  toolInput: Record<string, unknown>
  requestedBy: string
  votes: PermissionVote[]
  status: NegotiationStatus
  requiredApprovals: number
  deadline: Date
  createdAt: Date
}

export type NegotiationUpdate = {
  negotiationId: string
  status: NegotiationStatus
  votes: PermissionVote[]
  resolved: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEGOTIATION_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// PermissionNegotiator
// ---------------------------------------------------------------------------

export class PermissionNegotiator {
  private _negotiations = new Map<string, PermissionNegotiation>()
  private _participants = new Map<string, Participant[]>()
  private _timers = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Request permission for a tool execution. Creates a negotiation and starts
   * the timeout countdown.
   */
  requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    requestedBy: string,
    participants: Participant[],
  ): PermissionNegotiation {
    const id = randomUUID()
    const now = new Date()

    // Editors who are not the requester can vote
    const eligibleVoters = participants.filter(
      (p) => p.role !== 'viewer' && p.userId !== requestedBy,
    )

    // Required approvals: owner alone, or majority of eligible editors
    const owners = eligibleVoters.filter((p) => p.role === 'owner')
    const editors = eligibleVoters.filter((p) => p.role === 'editor')

    // If there is an owner, only 1 approval needed (owner is decisive).
    // Otherwise, need majority of editors.
    const requiredApprovals =
      owners.length > 0 ? 1 : Math.ceil(editors.length / 2)

    const negotiation: PermissionNegotiation = {
      id,
      toolName,
      toolInput,
      requestedBy,
      votes: [],
      status: 'pending',
      requiredApprovals: Math.max(requiredApprovals, 1),
      deadline: new Date(now.getTime() + NEGOTIATION_TIMEOUT_MS),
      createdAt: now,
    }

    this._negotiations.set(id, negotiation)
    this._participants.set(id, participants)

    // Start timeout
    const timer = setTimeout(() => {
      this._resolveTimeout(id)
    }, NEGOTIATION_TIMEOUT_MS)

    this._timers.set(id, timer)

    // Auto-resolve if no eligible voters
    if (eligibleVoters.length === 0) {
      // If requester is the only participant or only with viewers, auto-approve
      negotiation.status = 'approved'
      this._clearTimer(id)
    }

    return negotiation
  }

  /**
   * Cast a vote on a negotiation.
   */
  vote(
    negotiationId: string,
    participantId: string,
    vote: 'approve' | 'deny' | 'abstain',
    reason?: string,
  ): NegotiationUpdate | null {
    const negotiation = this._negotiations.get(negotiationId)
    if (!negotiation || negotiation.status !== 'pending') return null

    const participants = this._participants.get(negotiationId) ?? []
    const participant = participants.find((p) => p.userId === participantId)

    // Viewers cannot vote
    if (!participant || participant.role === 'viewer') return null

    // Cannot vote on your own request
    if (participantId === negotiation.requestedBy) return null

    // Cannot vote twice
    if (negotiation.votes.some((v) => v.participantId === participantId)) {
      return null
    }

    const newVote: PermissionVote = { participantId, vote, reason }
    negotiation.votes.push(newVote)

    // Resolve based on rules
    this._evaluateNegotiation(negotiation, participants)

    return {
      negotiationId,
      status: negotiation.status,
      votes: [...negotiation.votes],
      resolved: negotiation.status !== 'pending',
    }
  }

  /**
   * Get all active (pending) negotiations.
   */
  getActiveNegotiations(): PermissionNegotiation[] {
    const active: PermissionNegotiation[] = []
    for (const n of this._negotiations.values()) {
      if (n.status === 'pending') active.push(n)
    }
    return active
  }

  /**
   * Get a negotiation by ID.
   */
  getNegotiation(id: string): PermissionNegotiation | null {
    return this._negotiations.get(id) ?? null
  }

  /**
   * Clean up all timers.
   */
  destroy(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer)
    }
    this._timers.clear()
    this._negotiations.clear()
    this._participants.clear()
  }

  // -------------------------------------------------------------------------
  // Internal resolution logic
  // -------------------------------------------------------------------------

  private _evaluateNegotiation(
    negotiation: PermissionNegotiation,
    participants: Participant[],
  ): void {
    // Rule 1: Owner vote is always decisive
    for (const v of negotiation.votes) {
      const p = participants.find((pp) => pp.userId === v.participantId)
      if (p?.role === 'owner' && v.vote !== 'abstain') {
        negotiation.status = v.vote === 'approve' ? 'approved' : 'denied'
        this._clearTimer(negotiation.id)
        return
      }
    }

    // Rule 2: Majority of editors (excluding abstentions)
    const editorVotes = negotiation.votes.filter((v) => {
      const p = participants.find((pp) => pp.userId === v.participantId)
      return p?.role === 'editor' && v.vote !== 'abstain'
    })

    const approvals = editorVotes.filter((v) => v.vote === 'approve').length
    const denials = editorVotes.filter((v) => v.vote === 'deny').length

    if (approvals >= negotiation.requiredApprovals) {
      negotiation.status = 'approved'
      this._clearTimer(negotiation.id)
      return
    }

    // Check if enough denials to make approval impossible
    const eligibleEditors = participants.filter(
      (p) =>
        p.role === 'editor' &&
        p.userId !== negotiation.requestedBy &&
        !negotiation.votes.some((v) => v.participantId === p.userId),
    )

    const maxPossibleApprovals = approvals + eligibleEditors.length
    if (maxPossibleApprovals < negotiation.requiredApprovals) {
      negotiation.status = 'denied'
      this._clearTimer(negotiation.id)
      return
    }

    // Also deny if all eligible voters have voted and not enough approvals
    if (denials > 0 && eligibleEditors.length === 0 && approvals < negotiation.requiredApprovals) {
      negotiation.status = 'denied'
      this._clearTimer(negotiation.id)
    }
  }

  private _resolveTimeout(id: string): void {
    const negotiation = this._negotiations.get(id)
    if (negotiation && negotiation.status === 'pending') {
      negotiation.status = 'timeout'
    }
    this._timers.delete(id)
  }

  private _clearTimer(id: string): void {
    const timer = this._timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this._timers.delete(id)
    }
  }
}
