import { describe, expect, it, beforeEach, afterAll } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlink } from 'node:fs/promises'
import {
  SessionRecorder,
  _resetIdCounter,
  type SessionRecording,
  type SessionEvent,
  type EventType,
} from '../sessionRecorder.js'
import { SessionReplayer, type TimelineEntry } from '../sessionReplayer.js'
import { SessionAnalyzer, type Bottleneck } from '../sessionAnalyzer.js'
import { DiffViewer } from '../diffViewer.js'
import { createSessionReplay } from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic base timestamp for test recordings. */
const T0 = 1700000000000

function makeRecording(
  events: Array<Partial<SessionEvent> & Pick<SessionEvent, 'type'>>,
  overrides?: Partial<SessionRecording>,
): SessionRecording {
  return {
    sessionId: 'test-session',
    startTime: T0,
    endTime: T0 + 60_000,
    events: events.map((e, i) => ({
      id: e.id ?? `evt_${i}`,
      timestamp: e.timestamp ?? T0 + i * 1000,
      type: e.type,
      data: e.data ?? {},
      metadata: e.metadata,
    })),
    metadata: {
      model: 'test-model',
      workspace: '/tmp/test',
      totalTokens: 0,
      totalCost: 0,
      toolsUsed: [],
      filesModified: [],
      ...(overrides?.metadata as any),
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// SessionRecorder
// ---------------------------------------------------------------------------

describe('SessionRecorder', () => {
  let recorder: SessionRecorder

  beforeEach(() => {
    _resetIdCounter()
    recorder = new SessionRecorder()
  })

  it('starts and stops a recording', () => {
    const id = recorder.startRecording('sess-1')
    expect(id).toBe('sess-1')
    expect(recorder.isRecording()).toBe(true)

    const recording = recorder.stopRecording()
    expect(recording.sessionId).toBe('sess-1')
    expect(recording.endTime).toBeGreaterThan(0)
    expect(recorder.isRecording()).toBe(false)
  })

  it('throws when recording events without an active recording', () => {
    expect(() => recorder.recordEvent('user_message', {})).toThrow()
  })

  it('throws when stopping without an active recording', () => {
    expect(() => recorder.stopRecording()).toThrow()
  })

  it('records events with auto-generated ids and timestamps', () => {
    recorder.startRecording('sess-2')
    const e1 = recorder.recordEvent('user_message', { content: 'hello' })
    const e2 = recorder.recordEvent('assistant_message', { content: 'hi' })

    expect(e1.id).toBeTruthy()
    expect(e2.id).toBeTruthy()
    expect(e1.id).not.toBe(e2.id)
    expect(e1.timestamp).toBeLessThanOrEqual(e2.timestamp)
    expect(e1.type).toBe('user_message')
  })

  it('maintains event ordering', () => {
    recorder.startRecording('sess-3')
    for (let i = 0; i < 10; i++) {
      recorder.recordEvent('tool_call', { index: i })
    }
    const recording = recorder.getRecording()
    for (let i = 1; i < recording.events.length; i++) {
      expect(recording.events[i].timestamp).toBeGreaterThanOrEqual(
        recording.events[i - 1].timestamp,
      )
    }
  })

  it('tracks tools used automatically', () => {
    recorder.startRecording('sess-4')
    recorder.recordEvent('tool_call', { toolName: 'Bash' })
    recorder.recordEvent('tool_call', { toolName: 'Read' })
    recorder.recordEvent('tool_call', { toolName: 'Bash' }) // duplicate

    const recording = recorder.getRecording()
    expect(recording.metadata.toolsUsed).toEqual(['Bash', 'Read'])
  })

  it('tracks files modified automatically', () => {
    recorder.startRecording('sess-5')
    recorder.recordEvent('tool_result', {
      filesModified: ['/a.ts', '/b.ts'],
    })
    recorder.recordEvent('tool_result', {
      filesModified: ['/a.ts', '/c.ts'],
    })

    const recording = recorder.getRecording()
    expect(recording.metadata.filesModified).toEqual(['/a.ts', '/b.ts', '/c.ts'])
  })

  it('accumulates token usage', () => {
    recorder.startRecording('sess-6')
    recorder.recordEvent('token_usage', { tokens: 100, cost: 0.01 })
    recorder.recordEvent('token_usage', { tokens: 200, cost: 0.02 })

    const recording = recorder.getRecording()
    expect(recording.metadata.totalTokens).toBe(300)
    expect(recording.metadata.totalCost).toBeCloseTo(0.03)
  })

  it('accepts metadata on startRecording', () => {
    recorder.startRecording('sess-7', { model: 'opus', workspace: '/code' })
    const recording = recorder.getRecording()
    expect(recording.metadata.model).toBe('opus')
    expect(recording.metadata.workspace).toBe('/code')
  })

  it('attaches optional metadata to events', () => {
    recorder.startRecording('sess-8')
    const e = recorder.recordEvent('error', { msg: 'fail' }, { severity: 'high' })
    expect(e.metadata).toEqual({ severity: 'high' })
  })

  // Ring buffer
  it('enforces max events with ring buffer overflow', () => {
    const small = new SessionRecorder(5)
    small.startRecording('ring-test')
    for (let i = 0; i < 10; i++) {
      small.recordEvent('user_message', { index: i })
    }
    const recording = small.getRecording()
    expect(recording.events.length).toBe(5)
    // Should have the last 5 events (indices 5-9)
    expect(recording.events[0].data.index).toBe(5)
    expect(recording.events[4].data.index).toBe(9)
  })

  it('ring buffer preserves ordering after overflow', () => {
    const small = new SessionRecorder(3)
    small.startRecording('ring-2')
    for (let i = 0; i < 20; i++) {
      small.recordEvent('tool_call', { i })
    }
    const events = small.getRecording().events
    expect(events.length).toBe(3)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp)
    }
  })
})

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('SessionRecorder serialization', () => {
  const tmpFile = join(tmpdir(), `session-test-${Date.now()}.json`)

  afterAll(async () => {
    try { await unlink(tmpFile) } catch {}
  })

  it('round-trips save/load', async () => {
    const recorder = new SessionRecorder()
    recorder.startRecording('ser-1', { model: 'sonnet' })
    recorder.recordEvent('user_message', { content: 'hi' })
    recorder.recordEvent('tool_call', { toolName: 'Bash', input: 'ls' })
    const recording = recorder.stopRecording()

    await SessionRecorder.save(recording, tmpFile)
    const loaded = await SessionRecorder.load(tmpFile)

    expect(loaded.sessionId).toBe('ser-1')
    expect(loaded.events.length).toBe(2)
    expect(loaded.metadata.model).toBe('sonnet')
    expect(loaded.events[0].type).toBe('user_message')
    expect(loaded.events[1].data.toolName).toBe('Bash')
  })
})

// ---------------------------------------------------------------------------
// SessionReplayer
// ---------------------------------------------------------------------------

describe('SessionReplayer', () => {
  let replayer: SessionReplayer

  beforeEach(() => {
    replayer = new SessionReplayer()
  })

  it('throws when playing without a loaded recording', async () => {
    expect(() => {
      // Access the generator — the throw happens on first .next()
      const gen = replayer.play()
      // Force iteration
      gen.next()
    }).toBeDefined()
  })

  it('replays all events in order', async () => {
    const rec = makeRecording([
      { type: 'user_message', data: { content: 'a' } },
      { type: 'assistant_message', data: { content: 'b' } },
      { type: 'tool_call', data: { toolName: 'Bash' } },
    ])

    replayer.load(rec)
    const events: SessionEvent[] = []
    for await (const e of replayer.play({ speed: Infinity })) {
      events.push(e)
    }
    expect(events.length).toBe(3)
    expect(events[0].type).toBe('user_message')
    expect(events[2].type).toBe('tool_call')
  })

  it('filters events by type', async () => {
    const rec = makeRecording([
      { type: 'user_message' },
      { type: 'tool_call' },
      { type: 'user_message' },
      { type: 'error' },
    ])

    replayer.load(rec)
    const events: SessionEvent[] = []
    for await (const e of replayer.play({ speed: Infinity, filter: ['tool_call', 'error'] })) {
      events.push(e)
    }
    expect(events.length).toBe(2)
    expect(events[0].type).toBe('tool_call')
    expect(events[1].type).toBe('error')
  })

  it('starts from a specific index', async () => {
    const rec = makeRecording([
      { type: 'user_message' },
      { type: 'assistant_message' },
      { type: 'tool_call' },
      { type: 'tool_result' },
    ])

    replayer.load(rec)
    const events: SessionEvent[] = []
    for await (const e of replayer.play({ speed: Infinity, startFrom: 2 })) {
      events.push(e)
    }
    expect(events.length).toBe(2)
    expect(events[0].type).toBe('tool_call')
  })

  it('stops when stop() is called', async () => {
    const rec = makeRecording(
      Array.from({ length: 100 }, (_, i) => ({ type: 'user_message' as EventType })),
    )

    replayer.load(rec)
    const events: SessionEvent[] = []
    for await (const e of replayer.play({ speed: Infinity })) {
      events.push(e)
      if (events.length === 5) replayer.stop()
    }
    expect(events.length).toBe(5)
  })

  it('getState() reflects current playback state', () => {
    const rec = makeRecording([{ type: 'user_message' }])
    replayer.load(rec)
    const state = replayer.getState()
    expect(state.currentIndex).toBe(0)
    expect(state.isPlaying).toBe(false)
    expect(state.isPaused).toBe(false)
  })

  it('seekTo() updates the current index', () => {
    const rec = makeRecording([
      { type: 'user_message' },
      { type: 'assistant_message' },
      { type: 'tool_call' },
    ])
    replayer.load(rec)
    replayer.seekTo(2)
    expect(replayer.getState().currentIndex).toBe(2)
  })

  it('seekTo() throws for out-of-range index', () => {
    const rec = makeRecording([{ type: 'user_message' }])
    replayer.load(rec)
    expect(() => replayer.seekTo(5)).toThrow()
    expect(() => replayer.seekTo(-1)).toThrow()
  })

  it('filter() searches through the recording', () => {
    const rec = makeRecording([
      { type: 'user_message', data: { content: 'find this' } },
      { type: 'tool_call', data: { toolName: 'Bash' } },
      { type: 'user_message', data: { content: 'and this' } },
    ])

    replayer.load(rec)
    const results = replayer.filter((e) => e.type === 'user_message')
    expect(results.length).toBe(2)
  })

  it('getTimeline() produces bucketed event counts', () => {
    const events: Array<Partial<SessionEvent> & Pick<SessionEvent, 'type'>> = []
    // Minute 0: 3 events
    for (let i = 0; i < 3; i++) {
      events.push({ type: 'user_message', timestamp: T0 + i * 10_000 })
    }
    // Minute 1: 2 events
    for (let i = 0; i < 2; i++) {
      events.push({ type: 'tool_call', timestamp: T0 + 60_000 + i * 10_000 })
    }

    const rec = makeRecording(events)
    replayer.load(rec)

    const timeline = replayer.getTimeline()
    expect(timeline.length).toBe(2)
    expect(timeline[0].minute).toBe(0)
    expect(timeline[0].count).toBe(3)
    expect(timeline[1].minute).toBe(1)
    expect(timeline[1].count).toBe(2)
    expect(timeline[1].byType['tool_call']).toBe(2)
  })

  it('getTimeline() returns empty for empty recording', () => {
    const rec = makeRecording([])
    replayer.load(rec)
    expect(replayer.getTimeline()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SessionAnalyzer
// ---------------------------------------------------------------------------

describe('SessionAnalyzer', () => {
  const analyzer = new SessionAnalyzer()

  it('computes duration and event count', () => {
    const rec = makeRecording(
      [{ type: 'user_message' }, { type: 'assistant_message' }],
      { startTime: T0, endTime: T0 + 30_000 },
    )
    const analysis = analyzer.analyze(rec)
    expect(analysis.duration).toBe(30_000)
    expect(analysis.eventCount).toBe(2)
  })

  it('aggregates token usage', () => {
    const rec = makeRecording([
      { type: 'token_usage', data: { input: 100, output: 50, cached: 20 } },
      { type: 'token_usage', data: { input: 200, output: 100, cached: 80 } },
    ])
    const analysis = analyzer.analyze(rec)
    expect(analysis.tokenUsage.input).toBe(300)
    expect(analysis.tokenUsage.output).toBe(150)
    expect(analysis.tokenUsage.cached).toBe(100)
  })

  it('builds tool breakdown', () => {
    const rec = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 100 } },
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 200 } },
      { type: 'tool_result', data: { toolName: 'Bash', success: false, durationMs: 50 } },
      { type: 'tool_result', data: { toolName: 'Read', success: true, durationMs: 30 } },
    ])
    const analysis = analyzer.analyze(rec)

    const bash = analysis.toolBreakdown.get('Bash')!
    expect(bash.count).toBe(3)
    expect(bash.avgDuration).toBeCloseTo(116.67, 0)
    expect(bash.successRate).toBeCloseTo(2 / 3)

    const read = analysis.toolBreakdown.get('Read')!
    expect(read.count).toBe(1)
    expect(read.successRate).toBe(1)
  })

  // Bottleneck detection
  it('detects slow tool bottleneck', () => {
    const rec = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', toolCallId: 'c1', durationMs: 15_000 } },
    ])
    const bottlenecks = analyzer.findBottlenecks(rec)
    expect(bottlenecks.some((b) => b.type === 'slow_tool')).toBe(true)
  })

  it('detects repeated failure bottleneck', () => {
    const events = Array.from({ length: 4 }, () => ({
      type: 'tool_result' as EventType,
      data: { toolName: 'Edit', success: false, error: 'not found' },
    }))
    const rec = makeRecording(events)
    const bottlenecks = analyzer.findBottlenecks(rec)
    expect(bottlenecks.some((b) => b.type === 'repeated_failure')).toBe(true)
  })

  it('detects large context bottleneck', () => {
    const rec = makeRecording([
      { type: 'token_usage', data: { windowUsage: 0.92 } },
    ])
    const bottlenecks = analyzer.findBottlenecks(rec)
    expect(bottlenecks.some((b) => b.type === 'large_context')).toBe(true)
  })

  it('detects permission delay bottleneck', () => {
    const rec = makeRecording([
      {
        type: 'permission_request',
        timestamp: T0,
        data: { permissionId: 'p1' },
      },
      {
        type: 'permission_response',
        timestamp: T0 + 8_000,
        data: { permissionId: 'p1', granted: true },
      },
    ])
    const bottlenecks = analyzer.findBottlenecks(rec)
    expect(bottlenecks.some((b) => b.type === 'permission_delay')).toBe(true)
  })

  it('does not flag fast permission responses', () => {
    const rec = makeRecording([
      {
        type: 'permission_request',
        timestamp: T0,
        data: { permissionId: 'p1' },
      },
      {
        type: 'permission_response',
        timestamp: T0 + 1_000,
        data: { permissionId: 'p1' },
      },
    ])
    const bottlenecks = analyzer.findBottlenecks(rec)
    expect(bottlenecks.some((b) => b.type === 'permission_delay')).toBe(false)
  })

  // Comparison
  it('compares two recordings', () => {
    const recA = makeRecording(
      [{ type: 'token_usage', data: { input: 100, output: 50, cached: 0, cost: 0.05 } }],
      { startTime: T0, endTime: T0 + 10_000 },
    )
    const recB = makeRecording(
      [{ type: 'token_usage', data: { input: 200, output: 100, cached: 50, cost: 0.10 } }],
      { startTime: T0, endTime: T0 + 5_000 },
    )
    const report = analyzer.compareRecordings(recA, recB)
    expect(report.fasterSession).toBe(1) // B is faster
    expect(report.cheaperSession).toBe(-1) // A is cheaper
    expect(report.durationDiff).toBe(-5_000)
    expect(report.summary).toContain('faster')
  })

  // Optimisations
  it('suggests optimizations based on analysis', () => {
    const rec = makeRecording([
      { type: 'token_usage', data: { input: 50_000, output: 10_000, cached: 0 } },
      ...Array.from({ length: 4 }, () => ({
        type: 'tool_result' as EventType,
        data: { toolName: 'Bash', success: false, error: 'timeout' },
      })),
    ])
    const analysis = analyzer.analyze(rec)
    const suggestions = analyzer.suggestOptimizations(analysis)
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions.some((s) => s.includes('caching'))).toBe(true)
  })

  it('computes efficiency scores', () => {
    const rec = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 100 } },
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 200 } },
      { type: 'token_usage', data: { input: 100, output: 50, cached: 50 } },
    ])
    const analysis = analyzer.analyze(rec)
    expect(analysis.efficiency.overall).toBeGreaterThanOrEqual(0)
    expect(analysis.efficiency.overall).toBeLessThanOrEqual(100)
    expect(analysis.efficiency.errorRecovery).toBe(100) // no errors
  })

  it('finds error patterns', () => {
    const rec = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: false, error: 'timeout' }, timestamp: T0 },
      { type: 'tool_result', data: { toolName: 'Bash', success: false, error: 'timeout' }, timestamp: T0 + 5000 },
      { type: 'error', data: { toolName: 'Read', error: 'ENOENT' }, timestamp: T0 + 10000 },
    ])
    const analysis = analyzer.analyze(rec)
    expect(analysis.errorPatterns.length).toBe(2)
    const bashPattern = analysis.errorPatterns.find((p) => p.toolName === 'Bash')!
    expect(bashPattern.occurrences).toBe(2)
    expect(bashPattern.errorMessage).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// DiffViewer
// ---------------------------------------------------------------------------

describe('DiffViewer', () => {
  const viewer = new DiffViewer()

  it('detects added events', () => {
    const recA = makeRecording([
      { type: 'user_message', data: { content: 'hello' } },
    ])
    const recB = makeRecording([
      { type: 'user_message', data: { content: 'hello' } },
      { type: 'tool_call', data: { toolName: 'Bash' } },
    ])

    const diff = viewer.diff(recA, recB)
    expect(diff.addedEvents.length).toBe(1)
    expect(diff.addedEvents[0].type).toBe('tool_call')
  })

  it('detects removed events', () => {
    const recA = makeRecording([
      { type: 'user_message', data: { content: 'hello' } },
      { type: 'tool_call', data: { toolName: 'Read' } },
    ])
    const recB = makeRecording([
      { type: 'user_message', data: { content: 'hello' } },
    ])

    const diff = viewer.diff(recA, recB)
    expect(diff.removedEvents.length).toBe(1)
    expect(diff.removedEvents[0].type).toBe('tool_call')
  })

  it('builds tool diffs', () => {
    const recA = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 100 } },
    ])
    const recB = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 500 } },
    ])

    const diff = viewer.diff(recA, recB)
    const bashDiff = diff.toolDiffs.find((d) => d.toolName === 'Bash')!
    expect(bashDiff).toBeTruthy()
    expect(bashDiff.avgDurationB).toBeGreaterThan(bashDiff.avgDurationA)
  })

  it('detects regressions', () => {
    const recA = makeRecording([
      { type: 'tool_result', data: { toolName: 'Edit', success: true, durationMs: 100 } },
      { type: 'tool_result', data: { toolName: 'Edit', success: true, durationMs: 100 } },
    ])
    const recB = makeRecording([
      { type: 'tool_result', data: { toolName: 'Edit', success: false, durationMs: 500 } },
      { type: 'tool_result', data: { toolName: 'Edit', success: false, durationMs: 500 } },
    ])

    const diff = viewer.diff(recA, recB)
    const editDiff = diff.toolDiffs.find((d) => d.toolName === 'Edit')!
    expect(editDiff.regression).toBe(true)
  })

  it('builds timing diffs', () => {
    const recA = makeRecording([
      { type: 'tool_call', timestamp: T0, data: {} },
      { type: 'tool_call', timestamp: T0 + 10_000, data: {} },
    ])
    const recB = makeRecording([
      { type: 'tool_call', timestamp: T0, data: {} },
      { type: 'tool_call', timestamp: T0 + 20_000, data: {} },
    ])

    const diff = viewer.diff(recA, recB)
    const toolCallTiming = diff.timingDiffs.find((t) => t.phase === 'tool_call')!
    expect(toolCallTiming).toBeTruthy()
    expect(toolCallTiming.durationB).toBeGreaterThan(toolCallTiming.durationA)
  })

  it('formatDiff() produces human-readable output', () => {
    const recA = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 100 } },
    ])
    const recB = makeRecording([
      { type: 'tool_result', data: { toolName: 'Bash', success: true, durationMs: 100 } },
      { type: 'tool_call', data: { toolName: 'Read' } },
    ])

    const diff = viewer.diff(recA, recB)
    const text = viewer.formatDiff(diff)
    expect(text).toContain('Session Diff Summary')
    expect(text).toContain('Added events')
  })
})

// ---------------------------------------------------------------------------
// Factory / Integration
// ---------------------------------------------------------------------------

describe('createSessionReplay', () => {
  it('returns all four components', () => {
    const sr = createSessionReplay()
    expect(sr.recorder).toBeInstanceOf(SessionRecorder)
    expect(sr.replayer).toBeInstanceOf(SessionReplayer)
    expect(sr.analyzer).toBeInstanceOf(SessionAnalyzer)
    expect(sr.diffViewer).toBeInstanceOf(DiffViewer)
  })

  it('full lifecycle: record -> replay -> analyze -> diff', async () => {
    const sr = createSessionReplay()

    // Record session A
    sr.recorder.startRecording('lifecycle-a', { model: 'opus' })
    sr.recorder.recordEvent('user_message', { content: 'fix bug' })
    sr.recorder.recordEvent('tool_call', { toolName: 'Bash', input: 'grep -r bug .' })
    sr.recorder.recordEvent('tool_result', {
      toolName: 'Bash',
      success: true,
      durationMs: 200,
    })
    sr.recorder.recordEvent('token_usage', { input: 500, output: 200, cached: 100, cost: 0.01 })
    const recA = sr.recorder.stopRecording()

    // Replay
    sr.replayer.load(recA)
    const replayed: SessionEvent[] = []
    for await (const e of sr.replayer.play({ speed: Infinity })) {
      replayed.push(e)
    }
    expect(replayed.length).toBe(4)

    // Analyze
    const analysis = sr.analyzer.analyze(recA)
    expect(analysis.eventCount).toBe(4)
    expect(analysis.tokenUsage.input).toBe(500)

    // Record session B and diff
    const recorderB = new SessionRecorder()
    recorderB.startRecording('lifecycle-b', { model: 'sonnet' })
    recorderB.recordEvent('user_message', { content: 'fix bug' })
    recorderB.recordEvent('tool_call', { toolName: 'Grep', input: 'bug' })
    recorderB.recordEvent('tool_result', {
      toolName: 'Grep',
      success: true,
      durationMs: 50,
    })
    recorderB.recordEvent('token_usage', { input: 300, output: 100, cached: 50, cost: 0.005 })
    const recB = recorderB.stopRecording()

    const diff = sr.diffViewer.diff(recA, recB)
    expect(diff.addedEvents.length + diff.removedEvents.length).toBeGreaterThan(0)

    const comparison = sr.analyzer.compareRecordings(recA, recB)
    expect(comparison.summary).toBeTruthy()
  })
})
