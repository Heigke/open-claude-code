/**
 * Diff Viewer
 *
 * Compares two session recordings and produces a structured diff
 * highlighting differences in events, tool usage patterns, and timing.
 */

import type { EventType, SessionEvent, SessionRecording } from './sessionRecorder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolDiff {
  toolName: string
  countA: number
  countB: number
  avgDurationA: number
  avgDurationB: number
  successRateA: number
  successRateB: number
  /** True if B is slower or less reliable than A. */
  regression: boolean
}

export interface TimingDiff {
  phase: string
  durationA: number
  durationB: number
  diff: number
  /** Percentage change (positive = slower in B). */
  percentChange: number
}

export interface SessionDiff {
  addedEvents: SessionEvent[]
  removedEvents: SessionEvent[]
  modifiedEvents: Array<{ a: SessionEvent; b: SessionEvent; changes: string[] }>
  toolDiffs: ToolDiff[]
  timingDiffs: TimingDiff[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolStats(events: SessionEvent[]) {
  const map = new Map<
    string,
    { count: number; durations: number[]; successes: number; total: number }
  >()

  for (const e of events) {
    if (e.type === 'tool_result') {
      const name = e.data?.toolName ?? 'unknown'
      let entry = map.get(name)
      if (!entry) {
        entry = { count: 0, durations: [], successes: 0, total: 0 }
        map.set(name, entry)
      }
      entry.total++
      entry.count++
      if (e.data?.success !== false) entry.successes++
      if (typeof e.data?.durationMs === 'number') entry.durations.push(e.data.durationMs)
    }
  }

  return map
}

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

function buildPhaseTimings(events: SessionEvent[]): Map<string, number> {
  const phases = new Map<string, { start: number; end: number }>()

  // Group events by type as pseudo-phases
  for (const e of events) {
    const phase = e.type
    let entry = phases.get(phase)
    if (!entry) {
      entry = { start: e.timestamp, end: e.timestamp }
      phases.set(phase, entry)
    }
    entry.end = Math.max(entry.end, e.timestamp)
  }

  const result = new Map<string, number>()
  for (const [phase, range] of phases) {
    result.set(phase, range.end - range.start)
  }
  return result
}

/** Create a signature string for matching events across recordings. */
function eventSignature(e: SessionEvent): string {
  return `${e.type}:${JSON.stringify(e.data?.toolName ?? e.data?.role ?? '')}:${JSON.stringify(e.data?.content ?? e.data?.input ?? '').slice(0, 100)}`
}

// ---------------------------------------------------------------------------
// DiffViewer
// ---------------------------------------------------------------------------

export class DiffViewer {
  /**
   * Produce a structured diff of two session recordings.
   */
  diff(recordingA: SessionRecording, recordingB: SessionRecording): SessionDiff {
    // Match events by signature
    const sigsA = new Map<string, SessionEvent[]>()
    for (const e of recordingA.events) {
      const sig = eventSignature(e)
      let list = sigsA.get(sig)
      if (!list) {
        list = []
        sigsA.set(sig, list)
      }
      list.push(e)
    }

    const sigsB = new Map<string, SessionEvent[]>()
    for (const e of recordingB.events) {
      const sig = eventSignature(e)
      let list = sigsB.get(sig)
      if (!list) {
        list = []
        sigsB.set(sig, list)
      }
      list.push(e)
    }

    const addedEvents: SessionEvent[] = []
    const removedEvents: SessionEvent[] = []
    const modifiedEvents: SessionDiff['modifiedEvents'] = []

    // Events in B but not A -> added
    for (const [sig, bList] of sigsB) {
      const aList = sigsA.get(sig)
      if (!aList || aList.length === 0) {
        addedEvents.push(...bList)
      } else {
        // Match pair-wise for modifications
        const count = Math.min(aList.length, bList.length)
        for (let i = 0; i < count; i++) {
          const changes = this.findChanges(aList[i], bList[i])
          if (changes.length > 0) {
            modifiedEvents.push({ a: aList[i], b: bList[i], changes })
          }
        }
        // Extra in B
        for (let i = count; i < bList.length; i++) {
          addedEvents.push(bList[i])
        }
      }
    }

    // Events in A but not B -> removed
    for (const [sig, aList] of sigsA) {
      const bList = sigsB.get(sig)
      if (!bList || bList.length === 0) {
        removedEvents.push(...aList)
      } else {
        for (let i = Math.min(aList.length, bList.length); i < aList.length; i++) {
          removedEvents.push(aList[i])
        }
      }
    }

    // Tool diffs
    const toolDiffs = this.buildToolDiffs(recordingA.events, recordingB.events)

    // Timing diffs
    const timingDiffs = this.buildTimingDiffs(recordingA.events, recordingB.events)

    return { addedEvents, removedEvents, modifiedEvents, toolDiffs, timingDiffs }
  }

  /**
   * Format a diff as a human-readable summary string.
   */
  formatDiff(diff: SessionDiff): string {
    const lines: string[] = []

    lines.push('=== Session Diff Summary ===')
    lines.push('')
    lines.push(`Added events:    ${diff.addedEvents.length}`)
    lines.push(`Removed events:  ${diff.removedEvents.length}`)
    lines.push(`Modified events: ${diff.modifiedEvents.length}`)
    lines.push('')

    if (diff.toolDiffs.length > 0) {
      lines.push('--- Tool Diffs ---')
      for (const td of diff.toolDiffs) {
        const arrow = td.regression ? ' [REGRESSION]' : ''
        lines.push(
          `  ${td.toolName}: count ${td.countA}->${td.countB}, ` +
            `avgDuration ${td.avgDurationA.toFixed(0)}ms->${td.avgDurationB.toFixed(0)}ms, ` +
            `successRate ${(td.successRateA * 100).toFixed(0)}%->${(td.successRateB * 100).toFixed(0)}%${arrow}`,
        )
      }
      lines.push('')
    }

    if (diff.timingDiffs.length > 0) {
      lines.push('--- Timing Diffs ---')
      for (const td of diff.timingDiffs) {
        const sign = td.diff > 0 ? '+' : ''
        lines.push(
          `  ${td.phase}: ${td.durationA}ms -> ${td.durationB}ms (${sign}${td.percentChange.toFixed(1)}%)`,
        )
      }
      lines.push('')
    }

    // Highlight regressions
    const regressions = diff.toolDiffs.filter((td) => td.regression)
    if (regressions.length > 0) {
      lines.push('--- Regressions ---')
      for (const r of regressions) {
        const reasons: string[] = []
        if (r.avgDurationB > r.avgDurationA) reasons.push('slower')
        if (r.successRateB < r.successRateA) reasons.push('less reliable')
        lines.push(`  ${r.toolName}: ${reasons.join(', ')}`)
      }
    }

    return lines.join('\n')
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private findChanges(a: SessionEvent, b: SessionEvent): string[] {
    const changes: string[] = []
    if (a.type !== b.type) changes.push(`type: ${a.type} -> ${b.type}`)
    if (Math.abs(a.timestamp - b.timestamp) > 1000) {
      changes.push(`timestamp shifted by ${b.timestamp - a.timestamp}ms`)
    }
    if (JSON.stringify(a.data) !== JSON.stringify(b.data)) {
      changes.push('data changed')
    }
    return changes
  }

  private buildToolDiffs(eventsA: SessionEvent[], eventsB: SessionEvent[]): ToolDiff[] {
    const statsA = buildToolStats(eventsA)
    const statsB = buildToolStats(eventsB)
    const allTools = new Set([...statsA.keys(), ...statsB.keys()])

    const diffs: ToolDiff[] = []
    for (const toolName of allTools) {
      const a = statsA.get(toolName)
      const b = statsB.get(toolName)

      const countA = a?.count ?? 0
      const countB = b?.count ?? 0
      const avgDurationA = a ? avg(a.durations) : 0
      const avgDurationB = b ? avg(b.durations) : 0
      const successRateA = a && a.total > 0 ? a.successes / a.total : 1
      const successRateB = b && b.total > 0 ? b.successes / b.total : 1

      const regression = avgDurationB > avgDurationA * 1.2 || successRateB < successRateA - 0.1

      diffs.push({
        toolName,
        countA,
        countB,
        avgDurationA,
        avgDurationB,
        successRateA,
        successRateB,
        regression,
      })
    }

    return diffs
  }

  private buildTimingDiffs(eventsA: SessionEvent[], eventsB: SessionEvent[]): TimingDiff[] {
    const phasesA = buildPhaseTimings(eventsA)
    const phasesB = buildPhaseTimings(eventsB)
    const allPhases = new Set([...phasesA.keys(), ...phasesB.keys()])

    const diffs: TimingDiff[] = []
    for (const phase of allPhases) {
      const durationA = phasesA.get(phase) ?? 0
      const durationB = phasesB.get(phase) ?? 0
      const diff = durationB - durationA
      const percentChange = durationA > 0 ? (diff / durationA) * 100 : durationB > 0 ? 100 : 0

      diffs.push({ phase, durationA, durationB, diff, percentChange })
    }

    return diffs
  }
}
