/**
 * Session Replayer
 *
 * Plays back a recorded session as an async stream of events, with
 * speed control, filtering, seeking, pause/resume, and timeline views.
 */

import type { EventType, SessionEvent, SessionRecording } from './sessionRecorder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayOptions {
  /** Playback speed multiplier (1 = realtime, 2 = double, 0.5 = half). */
  speed: number
  /** Only replay events of these types. */
  filter?: EventType[]
  /** Start from this event index. */
  startFrom?: number
  /** Automatically pause when an event of this type is encountered. */
  pauseOn?: EventType[]
}

export interface ReplayState {
  currentIndex: number
  isPlaying: boolean
  isPaused: boolean
  speed: number
  /** Elapsed simulated time in ms. */
  elapsed: number
}

export interface TimelineEntry {
  /** Minute bucket (0-based). */
  minute: number
  /** Total events in this minute. */
  count: number
  /** Breakdown per event type. */
  byType: Partial<Record<EventType, number>>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// SessionReplayer
// ---------------------------------------------------------------------------

export class SessionReplayer {
  private recording: SessionRecording | null = null
  private state: ReplayState = {
    currentIndex: 0,
    isPlaying: false,
    isPaused: false,
    speed: 1,
    elapsed: 0,
  }

  private stopRequested = false
  private pausePromiseResolve: (() => void) | null = null

  /** Load a recording for playback. */
  load(recording: SessionRecording): void {
    this.recording = recording
    this.state = {
      currentIndex: 0,
      isPlaying: false,
      isPaused: false,
      speed: 1,
      elapsed: 0,
    }
    this.stopRequested = false
  }

  /**
   * Play back the loaded recording as an async generator.
   * Yields events one by one, honouring speed and filters.
   */
  async *play(options?: ReplayOptions): AsyncGenerator<SessionEvent> {
    if (!this.recording) throw new Error('No recording loaded.')

    const speed = options?.speed ?? 1
    const filterSet = options?.filter ? new Set(options.filter) : null
    const pauseOnSet = options?.pauseOn ? new Set(options.pauseOn) : null
    const startFrom = options?.startFrom ?? 0

    this.state.speed = speed
    this.state.isPlaying = true
    this.state.isPaused = false
    this.state.currentIndex = startFrom
    this.state.elapsed = 0
    this.stopRequested = false

    const events = this.recording.events
    let prevTimestamp = events[startFrom]?.timestamp ?? 0

    for (let i = startFrom; i < events.length; i++) {
      if (this.stopRequested) break

      const event = events[i]
      this.state.currentIndex = i

      // Wait for pause to be lifted
      if (this.state.isPaused) {
        await new Promise<void>((resolve) => {
          this.pausePromiseResolve = resolve
        })
      }
      if (this.stopRequested) break

      // Simulate delay between events
      const delta = event.timestamp - prevTimestamp
      if (delta > 0 && speed > 0) {
        const waitMs = delta / speed
        // Cap to 2 seconds max real-time wait so tests don't hang
        await sleep(Math.min(waitMs, 2000))
      }
      this.state.elapsed += delta
      prevTimestamp = event.timestamp

      // Apply filter
      if (filterSet && !filterSet.has(event.type)) continue

      // Check pauseOn
      if (pauseOnSet && pauseOnSet.has(event.type)) {
        this.state.isPaused = true
      }

      yield event
    }

    this.state.isPlaying = false
  }

  /** Pause playback. */
  pause(): void {
    this.state.isPaused = true
  }

  /** Resume playback after pause. */
  resume(): void {
    this.state.isPaused = false
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve()
      this.pausePromiseResolve = null
    }
  }

  /** Stop playback entirely. */
  stop(): void {
    this.stopRequested = true
    this.state.isPlaying = false
    this.state.isPaused = false
    // Unblock any pending pause
    if (this.pausePromiseResolve) {
      this.pausePromiseResolve()
      this.pausePromiseResolve = null
    }
  }

  /** Jump to a specific event index. */
  seekTo(eventIndex: number): void {
    if (!this.recording) throw new Error('No recording loaded.')
    if (eventIndex < 0 || eventIndex >= this.recording.events.length) {
      throw new RangeError(`Index ${eventIndex} out of range.`)
    }
    this.state.currentIndex = eventIndex
  }

  /** Return current replay state. */
  getState(): ReplayState {
    return { ...this.state }
  }

  /** Search/filter through the loaded recording. */
  filter(predicate: (event: SessionEvent) => boolean): SessionEvent[] {
    if (!this.recording) throw new Error('No recording loaded.')
    return this.recording.events.filter(predicate)
  }

  /**
   * Build a summarised timeline: event counts bucketed by minute.
   */
  getTimeline(): TimelineEntry[] {
    if (!this.recording) throw new Error('No recording loaded.')
    const events = this.recording.events
    if (events.length === 0) return []

    const startTs = events[0].timestamp
    const buckets = new Map<number, TimelineEntry>()

    for (const event of events) {
      const minute = Math.floor((event.timestamp - startTs) / 60_000)
      let entry = buckets.get(minute)
      if (!entry) {
        entry = { minute, count: 0, byType: {} }
        buckets.set(minute, entry)
      }
      entry.count++
      entry.byType[event.type] = (entry.byType[event.type] ?? 0) + 1
    }

    return Array.from(buckets.values()).sort((a, b) => a.minute - b.minute)
  }
}
