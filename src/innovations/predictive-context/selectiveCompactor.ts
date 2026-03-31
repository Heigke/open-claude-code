import type { Message } from '../../types/message.js'
import type { MessagePriority } from './messagePriority.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactionSelection = {
  /** Messages to keep in context (indices into original array). */
  keep: Message[]
  /** Messages selected for compaction/summarisation (indices into original). */
  compact: Message[]
  /** Estimated token savings from compacting the selected messages. */
  savings: number
}

// ---------------------------------------------------------------------------
// SelectiveCompactor
// ---------------------------------------------------------------------------

/**
 * Given a prioritised message list and a token-reduction target, selects the
 * lowest-priority messages for compaction while preserving:
 *
 *  1. The last 3 real user messages
 *  2. The last assistant message
 *  3. Any load-bearing message (tool_use/tool_result pairs)
 *
 * Preferred compaction targets (compacted first even if their priority isn't
 * the absolute lowest):
 *  - Old tool results
 *  - Resolved error discussions
 *  - Thinking blocks
 */
export class SelectiveCompactor {
  /** Minimum number of recent real-user messages to protect. */
  private readonly protectedUserMessages: number
  /** Whether to also protect the last assistant message. */
  private readonly protectLastAssistant: boolean

  constructor(options?: {
    protectedUserMessages?: number
    protectLastAssistant?: boolean
  }) {
    this.protectedUserMessages = options?.protectedUserMessages ?? 3
    this.protectLastAssistant = options?.protectLastAssistant ?? true
  }

  /**
   * Select which messages to compact to reach `targetTokenReduction`.
   *
   * Returns immediately if the target is already met (nothing to compact)
   * or if all eligible messages are exhausted before reaching the target.
   */
  selectMessagesForCompaction(
    messages: Message[],
    priorities: MessagePriority[],
    targetTokenReduction: number,
  ): CompactionSelection {
    if (messages.length === 0 || targetTokenReduction <= 0) {
      return { keep: [...messages], compact: [], savings: 0 }
    }

    // Build the set of indices that are unconditionally protected.
    const protectedIndices = this.buildProtectedSet(messages)

    // Build candidate list: not protected, not load-bearing.
    type Candidate = {
      index: number
      priority: number
      estimatedTokens: number
    }
    const candidates: Candidate[] = []

    for (const mp of priorities) {
      const idx = mp.messageIndex
      if (idx < 0 || idx >= messages.length) continue
      if (protectedIndices.has(idx)) continue
      if (mp.isLoadBearing) continue

      const msg = messages[idx]!
      const tokens = this.estimateMessageTokens(msg)
      candidates.push({ index: idx, priority: mp.priority, estimatedTokens: tokens })
    }

    // Sort candidates: lowest priority first (compact first).
    // Tie-break: older messages (lower index) first.
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.index - b.index
    })

    // Greedily select candidates until we hit the target.
    const compactIndices = new Set<number>()
    let savings = 0

    for (const candidate of candidates) {
      if (savings >= targetTokenReduction) break
      compactIndices.add(candidate.index)
      savings += candidate.estimatedTokens
    }

    // Partition messages into keep / compact.
    const keep: Message[] = []
    const compact: Message[] = []

    for (let i = 0; i < messages.length; i++) {
      if (compactIndices.has(i)) {
        compact.push(messages[i]!)
      } else {
        keep.push(messages[i]!)
      }
    }

    return { keep, compact, savings }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Determine indices that must never be compacted regardless of priority.
   */
  private buildProtectedSet(messages: Message[]): Set<number> {
    const protectedSet = new Set<number>()

    // Protect last N real user messages (walking backwards).
    let userCount = 0
    for (let i = messages.length - 1; i >= 0 && userCount < this.protectedUserMessages; i--) {
      const msg = messages[i]!
      if (this.isRealUserMessage(msg)) {
        protectedSet.add(i)
        userCount++
      }
    }

    // Protect the last assistant message.
    if (this.protectLastAssistant) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.type === 'assistant') {
          protectedSet.add(i)
          break
        }
      }
    }

    return protectedSet
  }

  /**
   * Rough token count for a single message. Uses the codebase's existing
   * roughTokenCountEstimation when available, with a fallback for test
   * environments.
   */
  private estimateMessageTokens(msg: Message): number {
    try {
      // Rough estimate from JSON serialisation (4 chars ≈ 1 token).
      return Math.ceil(JSON.stringify(msg).length / 4)
    } catch {
      return 100 // conservative floor for un-serialisable messages
    }
  }

  private isRealUserMessage(msg: Message): boolean {
    if (msg.type !== 'user') return false
    const content = msg.message?.content
    if (!Array.isArray(content)) return true
    return !content.every(
      (block: { type?: string }) => block.type === 'tool_result',
    )
  }
}
