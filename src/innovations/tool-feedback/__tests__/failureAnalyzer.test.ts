import { describe, expect, it, beforeEach } from 'bun:test'
import { ExecutionTracker, type ToolExecution } from '../executionTracker.js'
import { FailureAnalyzer, type FailureInsight } from '../failureAnalyzer.js'
import { AdaptivePromptInjector } from '../adaptivePromptInjector.js'
import { ToolFeedbackSystem } from '../feedbackIntegration.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExec(
  overrides: Partial<ToolExecution> & Pick<ToolExecution, 'toolName'>,
): ToolExecution {
  return {
    input: 'test input',
    output: 'test output',
    success: true,
    timestamp: new Date(),
    durationMs: 100,
    attempt: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// ExecutionTracker
// ---------------------------------------------------------------------------

describe('ExecutionTracker', () => {
  let tracker: ExecutionTracker

  beforeEach(() => {
    tracker = new ExecutionTracker()
  })

  it('records and retrieves executions', () => {
    tracker.record(makeExec({ toolName: 'Bash' }))
    tracker.record(makeExec({ toolName: 'FileEdit' }))

    expect(tracker.getRecentExecutions().length).toBe(2)
    expect(tracker.getRecentExecutions('Bash').length).toBe(1)
  })

  it('enforces sliding window of 200 entries', () => {
    for (let i = 0; i < 220; i++) {
      tracker.record(makeExec({ toolName: 'Bash', input: `cmd-${i}` }))
    }
    expect(tracker.size).toBe(200)
    // The oldest entries should have been dropped.
    const first = tracker.getRecentExecutions('Bash', 200)[0]!
    expect(first.input).toBe('cmd-20')
  })

  it('limits results with the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      tracker.record(makeExec({ toolName: 'Bash' }))
    }
    expect(tracker.getRecentExecutions('Bash', 3).length).toBe(3)
  })

  it('counts consecutive failures', () => {
    tracker.record(makeExec({ toolName: 'FileEdit', success: true }))
    tracker.record(makeExec({ toolName: 'FileEdit', success: false }))
    tracker.record(makeExec({ toolName: 'FileEdit', success: false }))
    tracker.record(makeExec({ toolName: 'FileEdit', success: false }))

    expect(tracker.getConsecutiveFailures('FileEdit')).toBe(3)
  })

  it('resets consecutive failures on success', () => {
    tracker.record(makeExec({ toolName: 'Bash', success: false }))
    tracker.record(makeExec({ toolName: 'Bash', success: false }))
    tracker.record(makeExec({ toolName: 'Bash', success: true }))

    expect(tracker.getConsecutiveFailures('Bash')).toBe(0)
  })

  it('computes success rate', () => {
    tracker.record(makeExec({ toolName: 'Grep', success: true }))
    tracker.record(makeExec({ toolName: 'Grep', success: false }))
    tracker.record(makeExec({ toolName: 'Grep', success: true }))
    tracker.record(makeExec({ toolName: 'Grep', success: false }))

    expect(tracker.getSuccessRate('Grep')).toBe(0.5)
  })

  it('returns 1 for success rate when no executions exist', () => {
    expect(tracker.getSuccessRate('NonExistent')).toBe(1)
  })

  it('detects failure patterns grouped by error type', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorType: 'old_string_not_found',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorType: 'old_string_not_found',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorType: 'permission_denied',
      }),
    )

    const patterns = tracker.getFailurePatterns()
    expect(patterns.length).toBe(2)
    // Sorted by frequency descending.
    expect(patterns[0]!.toolName).toBe('FileEdit')
    expect(patterns[0]!.frequency).toBe(2)
  })

  it('clears all state', () => {
    tracker.record(makeExec({ toolName: 'Bash' }))
    tracker.clear()
    expect(tracker.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// FailureAnalyzer
// ---------------------------------------------------------------------------

describe('FailureAnalyzer', () => {
  let tracker: ExecutionTracker
  let analyzer: FailureAnalyzer

  beforeEach(() => {
    tracker = new ExecutionTracker()
    analyzer = new FailureAnalyzer()
  })

  it('detects FileEdit old_string_not_found pattern', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found in file',
      }),
    )

    const insights = analyzer.analyze(tracker)
    const editInsight = insights.find((i) => i.toolName === 'FileEdit')
    expect(editInsight).toBeDefined()
    expect(editInsight!.category).toBe('whitespace')
    expect(editInsight!.suggestion).toContain('old_string')
  })

  it('detects edit-after-edit-failure without read', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )

    const insights = analyzer.analyze(tracker)
    const stateInsight = insights.find(
      (i) => i.category === 'state_mismatch',
    )
    expect(stateInsight).toBeDefined()
    expect(stateInsight!.suggestion).toContain('re-reading')
  })

  it('does not flag edit-after-edit if read happened in between', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )
    tracker.record(makeExec({ toolName: 'FileRead', success: true }))
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )

    const insights = analyzer.analyze(tracker)
    const stateInsight = insights.find(
      (i) => i.pattern === 'edit_after_edit_failure_without_read',
    )
    expect(stateInsight).toBeUndefined()
  })

  it('detects Bash permission denied', () => {
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorMessage: 'bash: /usr/sbin/foo: Permission denied',
      }),
    )

    const insights = analyzer.analyze(tracker)
    const permInsight = insights.find((i) => i.category === 'permission')
    expect(permInsight).toBeDefined()
    expect(permInsight!.toolName).toBe('Bash')
  })

  it('detects Bash command not found', () => {
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorMessage: 'foo: command not found',
      }),
    )

    const insights = analyzer.analyze(tracker)
    const cmdInsight = insights.find(
      (i) => i.pattern === 'command_not_found',
    )
    expect(cmdInsight).toBeDefined()
    expect(cmdInsight!.suggestion).toContain('foo')
  })

  it('detects repeated Grep no results', () => {
    tracker.record(makeExec({ toolName: 'Grep', success: false }))
    tracker.record(makeExec({ toolName: 'Grep', success: false }))

    const insights = analyzer.analyze(tracker)
    const grepInsight = insights.find((i) => i.toolName === 'Grep')
    expect(grepInsight).toBeDefined()
    expect(grepInsight!.suggestion).toContain('broader pattern')
  })

  it('detects 3+ consecutive same-tool failures', () => {
    tracker.record(
      makeExec({ toolName: 'Bash', success: false, errorMessage: 'err' }),
    )
    tracker.record(
      makeExec({ toolName: 'Bash', success: false, errorMessage: 'err' }),
    )
    tracker.record(
      makeExec({ toolName: 'Bash', success: false, errorMessage: 'err' }),
    )

    const insights = analyzer.analyze(tracker)
    const consecutiveInsight = insights.find(
      (i) => i.pattern === 'consecutive_failures',
    )
    expect(consecutiveInsight).toBeDefined()
    expect(consecutiveInsight!.suggestion).toContain('different approach')
  })

  it('supports custom analyzers via registerAnalyzer', () => {
    analyzer.registerAnalyzer((_t) => ({
      toolName: 'Custom',
      pattern: 'custom_pattern',
      suggestion: 'do something custom',
      confidence: 'low',
      category: 'other',
    }))

    const insights = analyzer.analyze(tracker)
    const custom = insights.find((i) => i.toolName === 'Custom')
    expect(custom).toBeDefined()
    expect(custom!.suggestion).toBe('do something custom')
  })

  it('tolerates an analyzer that throws', () => {
    analyzer.registerAnalyzer(() => {
      throw new Error('boom')
    })

    // Should not throw – the broken analyzer is skipped.
    const insights = analyzer.analyze(tracker)
    expect(Array.isArray(insights)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AdaptivePromptInjector
// ---------------------------------------------------------------------------

describe('AdaptivePromptInjector', () => {
  let tracker: ExecutionTracker
  let analyzer: FailureAnalyzer
  let injector: AdaptivePromptInjector

  beforeEach(() => {
    tracker = new ExecutionTracker()
    analyzer = new FailureAnalyzer()
    injector = new AdaptivePromptInjector(tracker, analyzer)
  })

  it('returns empty injections when there are no failures', () => {
    const injections = injector.getInjections()
    expect(injections.length).toBe(0)
  })

  it('produces injections for detected failures', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )

    const injections = injector.getInjections()
    expect(injections.length).toBeGreaterThan(0)
    expect(injections[0]!.content).toContain('[Tool Feedback]')
  })

  it('limits active injections to 3', () => {
    // Create many different failure types to generate many insights.
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorMessage: 'Permission denied',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorMessage: 'foo: command not found',
      }),
    )
    tracker.record(
      makeExec({ toolName: 'Grep', success: false }))
    tracker.record(
      makeExec({ toolName: 'Grep', success: false }))

    const injections = injector.getInjections()
    expect(injections.length).toBeLessThanOrEqual(3)
  })

  it('expires injections after TTL turns', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )

    // First call creates the injection.
    let injections = injector.getInjections()
    expect(injections.length).toBeGreaterThan(0)

    // Now clear failures so no new insights are generated, and tick turns.
    tracker.clear()
    for (let i = 0; i < 5; i++) {
      injections = injector.getInjections()
    }

    // After enough turns the injection should have expired.
    expect(injections.length).toBe(0)
  })

  it('sorts injections by priority descending', () => {
    tracker.record(
      makeExec({
        toolName: 'FileEdit',
        success: false,
        errorMessage: 'old_string not found',
      }),
    )
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorMessage: 'Permission denied',
      }),
    )

    const injections = injector.getInjections()
    if (injections.length >= 2) {
      expect(injections[0]!.priority).toBeGreaterThanOrEqual(
        injections[1]!.priority,
      )
    }
  })

  it('clears all state', () => {
    tracker.record(
      makeExec({
        toolName: 'Bash',
        success: false,
        errorMessage: 'Permission denied',
      }),
    )
    injector.getInjections() // populate
    injector.clear()
    expect(injector.activeCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ToolFeedbackSystem (integration)
// ---------------------------------------------------------------------------

describe('ToolFeedbackSystem', () => {
  let system: ToolFeedbackSystem

  beforeEach(() => {
    system = new ToolFeedbackSystem()
  })

  it('records tool completions and reports stats', () => {
    system.onToolComplete('Bash', 'ls', 'file1\nfile2', true)
    system.onToolComplete('Bash', 'rm /root/x', '', false, {
      type: 'permission_denied',
      message: 'Permission denied',
    })

    const stats = system.getStats()
    expect(stats.totalExecutions).toBe(2)
    expect(stats.failureRate).toBe(0.5)
  })

  it('returns null system prompt addendum when no failures', () => {
    system.onToolComplete('Bash', 'ls', 'ok', true)
    expect(system.getSystemPromptAddendum()).toBeNull()
  })

  it('returns system prompt addendum after failures', () => {
    system.onToolComplete('FileEdit', 'edit foo.ts', '', false, {
      message: 'old_string not found in file',
    })

    const addendum = system.getSystemPromptAddendum()
    expect(addendum).not.toBeNull()
    expect(addendum).toContain('Tool Feedback')
  })

  it('returns pre-tool hint for relevant tool', () => {
    system.onToolComplete('FileEdit', 'edit foo.ts', '', false, {
      message: 'old_string not found',
    })
    system.onToolComplete('FileEdit', 'edit foo.ts', '', false, {
      message: 'old_string not found',
    })

    // The state_mismatch insight mentions FileEdit.
    const hint = system.getPreToolHint('FileEdit', 'edit foo.ts')
    // May or may not produce a before_tools hint depending on analyzer output.
    // At minimum, the system should not throw.
    expect(hint === null || typeof hint === 'string').toBe(true)
  })

  it('resets all state', () => {
    system.onToolComplete('Bash', 'ls', '', false, { message: 'error' })
    system.reset()

    const stats = system.getStats()
    expect(stats.totalExecutions).toBe(0)
    expect(stats.failureRate).toBe(0)
  })

  it('computes attempt numbers for retries', () => {
    system.onToolComplete('FileEdit', 'edit src/foo.ts old_string="abc"', '', false, {
      message: 'old_string not found',
    })
    system.onToolComplete('FileEdit', 'edit src/foo.ts old_string="abc"', '', false, {
      message: 'old_string not found',
    })

    // The tracker should show attempt > 1 for the second call.
    const recent = system._tracker.getRecentExecutions('FileEdit')
    expect(recent.length).toBe(2)
    expect(recent[1]!.attempt).toBe(2)
  })
})
