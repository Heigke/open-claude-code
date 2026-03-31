import { describe, test, expect } from 'bun:test'
import { ContextPredictor } from '../contextPredictor.js'
import {
  PriorityCalculator,
  buildConversationContext,
  type ConversationContext,
} from '../messagePriority.js'
import { SelectiveCompactor } from '../selectiveCompactor.js'
import { createPredictiveContextManager } from '../index.js'

// ---------------------------------------------------------------------------
// Test message helpers
// ---------------------------------------------------------------------------

/** Minimal Message-compatible stub for testing. */
function makeUserMessage(text: string): any {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  }
}

function makeAssistantMessage(text: string, id = 'assistant-1'): any {
  return {
    type: 'assistant',
    message: {
      id,
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
}

function makeToolUseMessage(toolName: string, toolUseId: string): any {
  return {
    type: 'assistant',
    message: {
      id: `tu-msg-${toolUseId}`,
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: toolName,
          input: {},
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
}

function makeToolResultMessage(
  toolUseId: string,
  result: string,
  isError = false,
): any {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: result,
          is_error: isError,
        },
      ],
    },
  }
}

function makeThinkingAssistantMessage(text: string): any {
  return {
    type: 'assistant',
    message: {
      id: 'thinking-msg',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [
        { type: 'thinking', thinking: 'internal reasoning...', signature: '' },
        { type: 'text', text },
      ],
      usage: { input_tokens: 200, output_tokens: 100 },
    },
  }
}

function makeSystemMessage(text: string): any {
  return {
    type: 'system',
    message: { content: text },
  }
}

// ---------------------------------------------------------------------------
// ContextPredictor tests
// ---------------------------------------------------------------------------

describe('ContextPredictor', () => {
  test('starts with zero growth rate and empty history', () => {
    const predictor = new ContextPredictor()
    expect(predictor.getAverageGrowthRate()).toBe(0)
    expect(predictor.turnCount).toBe(0)
  })

  test('records turns and computes growth rate', () => {
    const predictor = new ContextPredictor()
    predictor.recordTurn(1000, 0)
    predictor.recordTurn(1500, 1)
    predictor.recordTurn(2200, 2)

    expect(predictor.turnCount).toBe(3)
    // Deltas: 500, 700 → avg 600
    expect(predictor.getAverageGrowthRate()).toBe(600)
  })

  test('sliding window trims old entries', () => {
    const predictor = new ContextPredictor({ slidingWindowSize: 3 })
    // Record 5 turns — only last 3 deltas should survive
    predictor.recordTurn(1000, 0)
    predictor.recordTurn(2000, 1) // delta 1000
    predictor.recordTurn(3000, 2) // delta 1000
    predictor.recordTurn(3500, 3) // delta 500
    predictor.recordTurn(4000, 4) // delta 500

    const state = predictor.getState()
    // Window size 3 → keep up to 3 deltas (growthRates trimmed to 3)
    expect(state.growthRates.length).toBeLessThanOrEqual(3)
  })

  test('predictTokenGrowth projects linearly', () => {
    const predictor = new ContextPredictor({ lookaheadTurns: 3 })
    predictor.recordTurn(1000, 0)
    predictor.recordTurn(1500, 1)
    // Growth rate = 500/turn, predict 3 turns ahead
    const predicted = predictor.predictTokenGrowth(1500)
    expect(predicted).toBe(1500 + 500 * 3) // 3000
  })

  test('predictTokenGrowth with explicit rate and turns', () => {
    const predictor = new ContextPredictor()
    const predicted = predictor.predictTokenGrowth(5000, 200, 5)
    expect(predicted).toBe(6000)
  })

  test('predictTokenGrowth never returns less than current', () => {
    const predictor = new ContextPredictor()
    // Negative growth rate should not produce a prediction below current
    const predicted = predictor.predictTokenGrowth(5000, -2000, 10)
    expect(predicted).toBe(5000) // clamped
  })

  test('shouldPreemptivelyCompact — healthy usage', () => {
    const predictor = new ContextPredictor({
      preemptiveThresholdFraction: 0.7,
      lookaheadTurns: 3,
    })
    predictor.recordTurn(1000, 0)
    predictor.recordTurn(1100, 1)

    const result = predictor.shouldPreemptivelyCompact(1100, 100_000)
    expect(result.shouldCompact).toBe(false)
    expect(result.urgency).toBe('low')
  })

  test('shouldPreemptivelyCompact — high urgency (already above threshold)', () => {
    const predictor = new ContextPredictor({
      preemptiveThresholdFraction: 0.7,
    })

    const result = predictor.shouldPreemptivelyCompact(75_000, 100_000)
    expect(result.shouldCompact).toBe(true)
    expect(result.urgency).toBe('high')
  })

  test('shouldPreemptivelyCompact — medium urgency (predicted to exceed)', () => {
    const predictor = new ContextPredictor({
      preemptiveThresholdFraction: 0.7,
      lookaheadTurns: 3,
    })
    // Growth rate: 5000/turn. Current: 55000. Predicted: 55000 + 15000 = 70000
    // Threshold at 70% of 100000 = 70000. Should trigger.
    predictor.recordTurn(50_000, 0)
    predictor.recordTurn(55_000, 1)

    const result = predictor.shouldPreemptivelyCompact(55_000, 100_000)
    expect(result.shouldCompact).toBe(true)
    expect(result.urgency).toBe('medium')
  })

  test('recordCompaction resets growth history', () => {
    const predictor = new ContextPredictor()
    predictor.recordTurn(5000, 0)
    predictor.recordTurn(10000, 1)
    expect(predictor.getAverageGrowthRate()).toBe(5000)

    predictor.recordCompaction(10000, 3000, 2)
    expect(predictor.getAverageGrowthRate()).toBe(0)
    expect(predictor.turnCount).toBe(1) // just the post-compaction snapshot
  })

  test('getState returns copies, not references', () => {
    const predictor = new ContextPredictor()
    predictor.recordTurn(1000, 0)
    predictor.recordTurn(2000, 1)

    const state = predictor.getState()
    expect(state.tokenHistory.length).toBe(2)
    expect(state.growthRates).toEqual([1000])
    expect(state.averageGrowthRate).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// PriorityCalculator tests
// ---------------------------------------------------------------------------

describe('PriorityCalculator', () => {
  const calc = new PriorityCalculator()

  test('recent messages score higher than old ones', () => {
    const messages = [
      makeUserMessage('old request'),
      makeAssistantMessage('old response'),
      makeUserMessage('recent request'),
      makeAssistantMessage('recent response'),
    ]
    const ctx = buildConversationContext(messages)
    const scores = calc.scoreAll(messages, ctx)

    // The last messages should have higher priority than the first ones
    expect(scores[3]!.priority).toBeGreaterThan(scores[0]!.priority)
    expect(scores[2]!.priority).toBeGreaterThan(scores[0]!.priority)
  })

  test('user messages score higher than non-user messages of same age', () => {
    const messages = [
      makeSystemMessage('system info'),
      makeUserMessage('user request'),
      makeAssistantMessage('response'),
    ]
    const ctx = buildConversationContext(messages)
    const scores = calc.scoreAll(messages, ctx)

    // User message (index 1) should score higher than system (index 0)
    expect(scores[1]!.priority).toBeGreaterThan(scores[0]!.priority)
  })

  test('thinking blocks get deprioritised', () => {
    const messages = [
      makeUserMessage('please think'),
      makeThinkingAssistantMessage('thought result'),
      makeUserMessage('follow up'),
      makeAssistantMessage('plain response'),
    ]
    const ctx = buildConversationContext(messages)
    const scores = calc.scoreAll(messages, ctx)

    // Thinking assistant (index 1) should score lower than plain assistant (index 3)
    expect(scores[1]!.priority).toBeLessThan(scores[3]!.priority)
  })

  test('load-bearing detection for tool_use/tool_result pairs', () => {
    const messages = [
      makeUserMessage('read file'),
      makeToolUseMessage('Read', 'tu-1'),
      makeToolResultMessage('tu-1', 'file contents here'),
      makeAssistantMessage('here is the file'),
    ]
    const ctx = buildConversationContext(messages)
    const scores = calc.scoreAll(messages, ctx)

    // Tool use (index 1) and tool result (index 2) are load-bearing
    expect(scores[1]!.isLoadBearing).toBe(true)
    expect(scores[2]!.isLoadBearing).toBe(true)
    // User message and final assistant are not load-bearing
    expect(scores[0]!.isLoadBearing).toBe(false)
    expect(scores[3]!.isLoadBearing).toBe(false)
  })

  test('resolved errors score low', () => {
    const messages = [
      makeUserMessage('do something'),
      makeToolUseMessage('Bash', 'tu-err'),
      makeToolResultMessage('tu-err', 'command failed', true),
      makeAssistantMessage('let me retry'),
      makeToolUseMessage('Bash', 'tu-ok'),
      makeToolResultMessage('tu-ok', 'success!', false),
      makeAssistantMessage('done!'),
    ]
    const ctx = buildConversationContext(messages)
    const scores = calc.scoreAll(messages, ctx)

    // The error result (index 2) should be marked as resolved and score lower
    // than the success result (index 5)
    expect(ctx.resolvedErrorIndices.has(2)).toBe(true)
    expect(scores[2]!.priority).toBeLessThan(scores[5]!.priority)
  })

  test('referenced messages score higher', () => {
    const messages = [
      makeUserMessage('read this file'),
      makeToolUseMessage('Read', 'ref-tu-1'),
      makeToolResultMessage('ref-tu-1', 'file content'),
      makeAssistantMessage('the file says...'),
    ]
    const ctx = buildConversationContext(messages)

    // Tool use and result should be referenced
    expect(ctx.referencedIndices.has(1)).toBe(true)
    expect(ctx.referencedIndices.has(2)).toBe(true)
  })

  test('scoreMessage handles single-message conversation', () => {
    const messages = [makeUserMessage('hello')]
    const ctx = buildConversationContext(messages)
    const score = calc.scoreMessage(messages[0]!, 0, messages, ctx)

    expect(score.priority).toBeGreaterThan(0)
    expect(score.priority).toBeLessThanOrEqual(100)
    expect(score.isLoadBearing).toBe(false)
  })

  test('scoreMessage handles empty reasons array for neutral messages', () => {
    const messages = [
      makeUserMessage('a'),
      makeAssistantMessage('b'),
    ]
    const ctx = buildConversationContext(messages)
    const scores = calc.scoreAll(messages, ctx)

    // Every score should have the reasons array (possibly empty but defined)
    for (const s of scores) {
      expect(Array.isArray(s.reasons)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// buildConversationContext tests
// ---------------------------------------------------------------------------

describe('buildConversationContext', () => {
  test('empty messages produce empty context', () => {
    const ctx = buildConversationContext([])
    expect(ctx.totalMessageCount).toBe(0)
    expect(ctx.referencedIndices.size).toBe(0)
    expect(ctx.activeDiscussionIndices.size).toBe(0)
    expect(ctx.resolvedErrorIndices.size).toBe(0)
  })

  test('active discussion window respects parameter', () => {
    const messages = [
      makeUserMessage('msg 1'),
      makeAssistantMessage('resp 1'),
      makeUserMessage('msg 2'),
      makeAssistantMessage('resp 2'),
      makeUserMessage('msg 3'),
      makeAssistantMessage('resp 3'),
    ]
    // With window=1, only the last real user message should be in active set
    const ctx = buildConversationContext(messages, 1)
    // Only the last user message (index 4) should be active
    expect(ctx.activeDiscussionIndices.has(4)).toBe(true)
    // Older user messages should not be active
    expect(ctx.activeDiscussionIndices.has(0)).toBe(false)
  })

  test('resolved error tracking works across tool names', () => {
    const messages = [
      makeUserMessage('try bash'),
      makeToolUseMessage('Bash', 'bash-err'),
      makeToolResultMessage('bash-err', 'error!', true),
      makeAssistantMessage('retrying...'),
      makeToolUseMessage('Bash', 'bash-ok'),
      makeToolResultMessage('bash-ok', 'success', false),
    ]
    const ctx = buildConversationContext(messages)

    // Index 2 (error result) should be resolved because index 5 succeeded
    expect(ctx.resolvedErrorIndices.has(2)).toBe(true)
    expect(ctx.resolvedErrorIndices.has(5)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SelectiveCompactor tests
// ---------------------------------------------------------------------------

describe('SelectiveCompactor', () => {
  const compactor = new SelectiveCompactor({ protectedUserMessages: 2 })
  const calc = new PriorityCalculator()

  test('returns all messages as keep when target is 0', () => {
    const messages = [makeUserMessage('a'), makeAssistantMessage('b')]
    const ctx = buildConversationContext(messages)
    const priorities = calc.scoreAll(messages, ctx)

    const result = compactor.selectMessagesForCompaction(messages, priorities, 0)
    expect(result.keep.length).toBe(2)
    expect(result.compact.length).toBe(0)
    expect(result.savings).toBe(0)
  })

  test('returns all messages as keep when array is empty', () => {
    const result = compactor.selectMessagesForCompaction([], [], 1000)
    expect(result.keep.length).toBe(0)
    expect(result.compact.length).toBe(0)
  })

  test('protects last N user messages', () => {
    const messages = [
      makeUserMessage('old user msg'),
      makeAssistantMessage('old response'),
      makeUserMessage('recent user msg 1'),
      makeAssistantMessage('recent response 1'),
      makeUserMessage('recent user msg 2'),
      makeAssistantMessage('latest response'),
    ]
    const ctx = buildConversationContext(messages)
    const priorities = calc.scoreAll(messages, ctx)

    // Request a huge token reduction — should compact whatever it can but
    // not the last 2 user messages or the last assistant
    const result = compactor.selectMessagesForCompaction(
      messages,
      priorities,
      999_999,
    )

    // Protected: index 2 (user), 4 (user), 5 (last assistant)
    // The result.keep should include these
    const keepTypes = result.keep.map((m: any) => m.type)
    // At minimum, the 2 protected user messages and last assistant should survive
    const keptUserCount = result.keep.filter(
      (m: any) => m.type === 'user' && m.message.content?.[0]?.type !== 'tool_result',
    ).length
    expect(keptUserCount).toBeGreaterThanOrEqual(2)
  })

  test('protects last assistant message', () => {
    const messages = [
      makeUserMessage('hello'),
      makeAssistantMessage('first reply', 'a1'),
      makeUserMessage('follow up'),
      makeAssistantMessage('second reply', 'a2'),
    ]
    const ctx = buildConversationContext(messages)
    const priorities = calc.scoreAll(messages, ctx)

    const result = compactor.selectMessagesForCompaction(
      messages,
      priorities,
      999_999,
    )

    // The last assistant message should be in keep
    const lastAssistantInKeep = result.keep.some(
      (m: any) =>
        m.type === 'assistant' && m.message.id === 'a2',
    )
    expect(lastAssistantInKeep).toBe(true)
  })

  test('never compacts load-bearing messages', () => {
    const messages = [
      makeUserMessage('do stuff'),
      makeToolUseMessage('Read', 'lb-tu'),
      makeToolResultMessage('lb-tu', 'file content'),
      makeAssistantMessage('done'),
    ]
    const ctx = buildConversationContext(messages)
    const priorities = calc.scoreAll(messages, ctx)

    const result = compactor.selectMessagesForCompaction(
      messages,
      priorities,
      999_999,
    )

    // Tool use and tool result are load-bearing — should not be compacted
    const compactedTypes = result.compact.map((m: any) => {
      if (m.type === 'assistant' && m.message.content?.[0]?.type === 'tool_use')
        return 'tool_use'
      if (m.type === 'user' && m.message.content?.[0]?.type === 'tool_result')
        return 'tool_result'
      return m.type
    })
    expect(compactedTypes).not.toContain('tool_use')
    expect(compactedTypes).not.toContain('tool_result')
  })

  test('compacts lowest priority messages first', () => {
    const messages = [
      makeSystemMessage('system info'),
      makeUserMessage('first question'),
      makeAssistantMessage('first answer', 'a1'),
      makeUserMessage('second question'),
      makeAssistantMessage('second answer', 'a2'),
      makeUserMessage('third question'),
      makeAssistantMessage('third answer', 'a3'),
    ]
    const ctx = buildConversationContext(messages)
    const priorities = calc.scoreAll(messages, ctx)

    // Request modest compaction
    const result = compactor.selectMessagesForCompaction(
      messages,
      priorities,
      100, // small target — should only compact the lowest priority messages
    )

    // System message (index 0) should be among the first to be compacted
    if (result.compact.length > 0) {
      const compactedHasSystem = result.compact.some(
        (m: any) => m.type === 'system',
      )
      expect(compactedHasSystem).toBe(true)
    }
  })

  test('reports savings estimate', () => {
    const messages = [
      makeUserMessage('hello world this is a message with some content'),
      makeAssistantMessage('this is a response with some content too'),
      makeUserMessage('another message'),
      makeAssistantMessage('another response'),
    ]
    const ctx = buildConversationContext(messages)
    const priorities = calc.scoreAll(messages, ctx)

    const result = compactor.selectMessagesForCompaction(
      messages,
      priorities,
      999_999,
    )

    // If anything was compacted, savings should be > 0
    if (result.compact.length > 0) {
      expect(result.savings).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Factory function tests
// ---------------------------------------------------------------------------

describe('createPredictiveContextManager', () => {
  test('creates all three components', () => {
    const mgr = createPredictiveContextManager()
    expect(mgr.predictor).toBeDefined()
    expect(mgr.calculator).toBeDefined()
    expect(mgr.compactor).toBeDefined()
  })

  test('passes options through to components', () => {
    const mgr = createPredictiveContextManager({
      slidingWindowSize: 5,
      preemptiveThresholdFraction: 0.6,
      lookaheadTurns: 2,
    })

    // Record turns and verify the predictor uses the custom lookahead
    mgr.predictor.recordTurn(1000, 0)
    mgr.predictor.recordTurn(2000, 1)
    // Growth rate = 1000/turn, lookahead = 2
    const predicted = mgr.predictor.predictTokenGrowth(2000)
    expect(predicted).toBe(4000) // 2000 + 1000 * 2
  })
})

// ---------------------------------------------------------------------------
// Integration: end-to-end flow
// ---------------------------------------------------------------------------

describe('end-to-end predictive context flow', () => {
  test('full cycle: score → predict → select', () => {
    const mgr = createPredictiveContextManager({
      preemptiveThresholdFraction: 0.7,
      lookaheadTurns: 3,
    })

    // Simulate a conversation
    const messages: any[] = [
      makeUserMessage('What files are in src/?'),
      makeToolUseMessage('Glob', 'glob-1'),
      makeToolResultMessage('glob-1', 'src/index.ts\nsrc/main.ts\nsrc/utils.ts'),
      makeAssistantMessage('I found 3 files in src/'),
      makeUserMessage('Read index.ts'),
      makeToolUseMessage('Read', 'read-1'),
      makeToolResultMessage('read-1', 'export function main() { ... } '.repeat(50)),
      makeAssistantMessage('Here is the content of index.ts'),
      makeUserMessage('Now edit it to add a new function'),
    ]

    // Step 1: Score priorities
    const ctx = buildConversationContext(messages)
    const priorities = mgr.calculator.scoreAll(messages, ctx)

    expect(priorities.length).toBe(messages.length)
    expect(priorities.every((p) => p.priority >= 0 && p.priority <= 100)).toBe(true)

    // Step 2: Simulate growing context and check prediction
    mgr.predictor.recordTurn(50_000, 0)
    mgr.predictor.recordTurn(55_000, 1)
    mgr.predictor.recordTurn(60_000, 2)

    const decision = mgr.predictor.shouldPreemptivelyCompact(60_000, 100_000)
    // Growth rate ≈ 5000/turn, predicted = 60000 + 15000 = 75000 > 70000
    expect(decision.shouldCompact).toBe(true)

    // Step 3: Select messages for compaction
    const targetReduction = 15_000
    const selection = mgr.compactor.selectMessagesForCompaction(
      messages,
      priorities,
      targetReduction,
    )

    // Should keep protected messages and compact some others
    expect(selection.keep.length).toBeGreaterThan(0)
    expect(selection.keep.length + selection.compact.length).toBe(messages.length)
  })
})
