import type { Message } from '../../types/message.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessagePriority = {
  /** Index of the message in the conversation array */
  messageIndex: number
  /** Computed priority score 0 (lowest) to 100 (highest) */
  priority: number
  /** Human-readable reasons that contributed to the score */
  reasons: string[]
  /**
   * True if removing this message would break API-level tool_use / tool_result
   * pairing. Load-bearing messages must NEVER be compacted.
   */
  isLoadBearing: boolean
}

/**
 * Minimal view of the conversation that scoring needs — avoids coupling the
 * priority calculator to any single message-serialisation format.
 */
export type ConversationContext = {
  totalMessageCount: number
  /** Set of message indices referenced by later messages (back-references). */
  referencedIndices: Set<number>
  /**
   * Indices of messages whose content is still being actively discussed in
   * the most recent N turns (caller decides N, typically 5).
   */
  activeDiscussionIndices: Set<number>
  /** Indices of error messages that have been resolved (succeeded after). */
  resolvedErrorIndices: Set<number>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a message is a user message (real human input, not tool_result). */
function isRealUserMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return true
  // If every content block is a tool_result it's a synthetic user message
  return !content.every(
    (block: { type?: string }) => block.type === 'tool_result',
  )
}

/** Check if a message is a tool_result wrapper (user message with tool_result blocks). */
function isToolResultMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block: { type?: string }) => block.type === 'tool_result',
  )
}

/** Check if an assistant message contains tool_use blocks. */
function hasToolUseBlocks(msg: Message): boolean {
  if (msg.type !== 'assistant') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block: { type?: string }) => block.type === 'tool_use',
  )
}

/** Check if an assistant message contains thinking blocks. */
function hasThinkingBlocks(msg: Message): boolean {
  if (msg.type !== 'assistant') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block: { type?: string }) =>
      block.type === 'thinking' || block.type === 'redacted_thinking',
  )
}

/** Check if a message looks like an error (tool_result with is_error). */
function isErrorResult(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return content.some(
    (block: { type?: string; is_error?: boolean }) =>
      block.type === 'tool_result' && block.is_error === true,
  )
}

// ---------------------------------------------------------------------------
// PriorityCalculator
// ---------------------------------------------------------------------------

/**
 * Scores individual messages for their value to the ongoing conversation.
 *
 * The score is a composite of several weighted factors:
 *   - Recency (exponential decay)
 *   - Reference count (messages referenced later)
 *   - Tool result relevance (active discussions)
 *   - User instruction weight (explicit human requests)
 *   - Error state (recent errors high, resolved low)
 *   - Thinking block penalty
 *   - System message baseline
 *
 * Load-bearing detection is separate from scoring — a message can have a low
 * priority score but still be marked load-bearing if it is part of an
 * unresolved tool_use/tool_result pair.
 */
export class PriorityCalculator {
  // Weight factors (sum to ~1.0 for the main factors)
  private static readonly WEIGHT_RECENCY = 0.30
  private static readonly WEIGHT_REFERENCE = 0.20
  private static readonly WEIGHT_TOOL_RELEVANCE = 0.15
  private static readonly WEIGHT_USER_INSTRUCTION = 0.20
  private static readonly WEIGHT_ERROR_STATE = 0.10
  private static readonly WEIGHT_TYPE_MODIFIER = 0.05

  // Recency decay: at the oldest message the factor is e^{-DECAY_RATE} ≈ 0.05
  private static readonly DECAY_RATE = 3.0

  /**
   * Score a single message in the context of the full conversation.
   */
  scoreMessage(
    msg: Message,
    index: number,
    messages: Message[],
    context: ConversationContext,
  ): MessagePriority {
    const reasons: string[] = []
    let score = 0

    // --- Recency (exponential decay) ---
    const recency = this.computeRecency(index, context.totalMessageCount)
    score += recency * PriorityCalculator.WEIGHT_RECENCY * 100
    if (recency > 0.8) reasons.push('very recent message')
    else if (recency < 0.2) reasons.push('old message')

    // --- Reference count ---
    const refScore = context.referencedIndices.has(index) ? 1.0 : 0.0
    score += refScore * PriorityCalculator.WEIGHT_REFERENCE * 100
    if (refScore > 0) reasons.push('referenced by later messages')

    // --- Tool result relevance ---
    const toolScore = this.computeToolRelevance(index, msg, context)
    score += toolScore * PriorityCalculator.WEIGHT_TOOL_RELEVANCE * 100
    if (toolScore > 0.5) reasons.push('tool result still active in discussion')

    // --- User instruction weight ---
    const userScore = this.computeUserInstructionWeight(msg)
    score += userScore * PriorityCalculator.WEIGHT_USER_INSTRUCTION * 100
    if (userScore > 0) reasons.push('contains user instruction')

    // --- Error state ---
    const errorScore = this.computeErrorScore(index, msg, context)
    score += errorScore * PriorityCalculator.WEIGHT_ERROR_STATE * 100
    if (errorScore < 0) reasons.push('resolved error — low value')
    if (errorScore > 0.5) reasons.push('unresolved error — high value')

    // --- Type modifier (thinking penalty, system baseline) ---
    const typeModifier = this.computeTypeModifier(msg)
    score += typeModifier * PriorityCalculator.WEIGHT_TYPE_MODIFIER * 100
    if (typeModifier < 0) reasons.push('thinking/system block — deprioritised')

    // Clamp to [0, 100]
    const priority = Math.max(0, Math.min(100, Math.round(score)))

    // --- Load-bearing check ---
    const isLoadBearing = this.isLoadBearing(index, msg, messages)
    if (isLoadBearing) reasons.push('load-bearing: tool_use/tool_result pair')

    return { messageIndex: index, priority, reasons, isLoadBearing }
  }

  /**
   * Score all messages in a conversation.
   */
  scoreAll(
    messages: Message[],
    context: ConversationContext,
  ): MessagePriority[] {
    return messages.map((msg, i) => this.scoreMessage(msg, i, messages, context))
  }

  // -----------------------------------------------------------------------
  // Private scoring helpers
  // -----------------------------------------------------------------------

  private computeRecency(index: number, totalCount: number): number {
    if (totalCount <= 1) return 1.0
    // normalised position: 0 = oldest, 1 = newest
    const t = index / (totalCount - 1)
    // Exponential curve: e^{-rate * (1-t)}  →  newest ≈ 1, oldest ≈ e^{-rate}
    return Math.exp(-PriorityCalculator.DECAY_RATE * (1 - t))
  }

  private computeToolRelevance(
    index: number,
    msg: Message,
    context: ConversationContext,
  ): number {
    if (!isToolResultMessage(msg)) return 0
    return context.activeDiscussionIndices.has(index) ? 1.0 : 0.2
  }

  private computeUserInstructionWeight(msg: Message): number {
    if (isRealUserMessage(msg)) return 1.0
    return 0
  }

  private computeErrorScore(
    index: number,
    msg: Message,
    context: ConversationContext,
  ): number {
    if (!isErrorResult(msg)) return 0
    // Resolved errors are low-value; unresolved ones are high-value.
    return context.resolvedErrorIndices.has(index) ? -0.5 : 1.0
  }

  private computeTypeModifier(msg: Message): number {
    // Thinking blocks: can be regenerated, lowest type priority
    if (msg.type === 'assistant' && hasThinkingBlocks(msg)) return -1.0
    // System messages: generally low value unless referenced (handled above)
    if (msg.type === 'system') return -0.5
    return 0
  }

  /**
   * A message is "load-bearing" if removing it would break the tool_use →
   * tool_result contract required by the API.
   *
   * Specifically:
   *  - An assistant message with tool_use blocks whose corresponding
   *    tool_result has NOT yet appeared is load-bearing.
   *  - A user/tool_result message that resolves a tool_use from the
   *    immediately preceding assistant is load-bearing.
   */
  isLoadBearing(
    index: number,
    msg: Message,
    messages: Message[],
  ): boolean {
    // Case 1: assistant with tool_use — check if the next message resolves it
    if (hasToolUseBlocks(msg)) {
      // The tool_use itself is always paired with a result that follows it
      // (unless it's the very last message, in which case removing it is fine
      // but we're conservative — mark it load-bearing).
      const next = messages[index + 1]
      if (!next) return true
      if (isToolResultMessage(next)) return true
      // No immediate result → might be orphaned, still mark load-bearing
      return true
    }

    // Case 2: tool_result message — the preceding assistant with the
    // corresponding tool_use is load-bearing, and so is this result.
    if (isToolResultMessage(msg)) {
      const prev = messages[index - 1]
      if (prev && hasToolUseBlocks(prev)) return true
    }

    return false
  }
}

// ---------------------------------------------------------------------------
// Context builder helper
// ---------------------------------------------------------------------------

/**
 * Build a ConversationContext by analysing the message array.
 *
 * This is a simple heuristic pass:
 *  - referencedIndices: any message whose tool_use id appears in a later
 *    tool_result is "referenced".
 *  - activeDiscussionIndices: tool results in the last `activeWindow` turns.
 *  - resolvedErrorIndices: error tool_results followed by a non-error result
 *    for the same tool name.
 */
export function buildConversationContext(
  messages: Message[],
  activeWindow = 5,
): ConversationContext {
  const referencedIndices = new Set<number>()
  const activeDiscussionIndices = new Set<number>()
  const resolvedErrorIndices = new Set<number>()

  // Map tool_use id → message index for back-reference tracking
  const toolUseIdToIndex = new Map<string, number>()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    // Track tool_use ids from assistant messages
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'tool_use' &&
          'id' in block
        ) {
          toolUseIdToIndex.set(block.id as string, i)
        }
      }
    }

    // Track tool_result references back to their tool_use
    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'tool_result' &&
          'tool_use_id' in block
        ) {
          const tuIndex = toolUseIdToIndex.get(block.tool_use_id as string)
          if (tuIndex !== undefined) {
            referencedIndices.add(tuIndex)
            referencedIndices.add(i)
          }
        }
      }
    }
  }

  // Active discussion: last `activeWindow` real user messages and their
  // surrounding tool results
  let userCount = 0
  for (let i = messages.length - 1; i >= 0 && userCount < activeWindow; i--) {
    const msg = messages[i]!
    if (isRealUserMessage(msg)) userCount++
    if (isToolResultMessage(msg) || isRealUserMessage(msg)) {
      activeDiscussionIndices.add(i)
    }
  }

  // Resolved errors: an error tool_result whose tool name later has a
  // non-error result
  const errorIndicesByTool = new Map<string, number[]>()
  const successToolNames = new Set<string>()

  // Forward pass to collect errors, reverse pass to collect successes
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type !== 'user' || !Array.isArray(msg.message?.content)) continue
    for (const block of msg.message.content) {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'tool_result' &&
        'tool_use_id' in block
      ) {
        const tuId = block.tool_use_id as string
        const isErr =
          'is_error' in block && (block as { is_error?: boolean }).is_error
        // Find tool name from the tool_use
        const tuIndex = toolUseIdToIndex.get(tuId)
        if (tuIndex === undefined) continue
        const tuMsg = messages[tuIndex]!
        if (tuMsg.type !== 'assistant' || !Array.isArray(tuMsg.message?.content))
          continue
        const tuBlock = tuMsg.message.content.find(
          (b: { type?: string; id?: string }) =>
            b.type === 'tool_use' && b.id === tuId,
        ) as { name?: string } | undefined
        const toolName = tuBlock?.name
        if (!toolName) continue

        if (isErr) {
          const arr = errorIndicesByTool.get(toolName) ?? []
          arr.push(i)
          errorIndicesByTool.set(toolName, arr)
        } else {
          successToolNames.add(toolName)
        }
      }
    }
  }

  for (const [toolName, indices] of errorIndicesByTool) {
    if (successToolNames.has(toolName)) {
      for (const idx of indices) {
        resolvedErrorIndices.add(idx)
      }
    }
  }

  return {
    totalMessageCount: messages.length,
    referencedIndices,
    activeDiscussionIndices,
    resolvedErrorIndices,
  }
}
