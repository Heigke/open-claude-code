/**
 * Session Recorder
 *
 * Records full agent sessions as a sequence of typed events.
 * Supports serialization to/from JSON and enforces a max-events
 * limit via ring-buffer overflow.
 */

import { readFile, writeFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'permission_request'
  | 'permission_response'
  | 'compaction'
  | 'error'
  | 'state_change'
  | 'token_usage'

export interface SessionEvent {
  id: string
  timestamp: number
  type: EventType
  data: any
  metadata?: Record<string, any>
}

export interface RecordingMetadata {
  model: string
  workspace: string
  totalTokens: number
  totalCost: number
  toolsUsed: string[]
  filesModified: string[]
  [key: string]: any
}

export interface SessionRecording {
  sessionId: string
  startTime: number
  endTime?: number
  events: SessionEvent[]
  metadata: RecordingMetadata
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0

function generateEventId(): string {
  return `evt_${Date.now()}_${++_idCounter}`
}

/** Reset the ID counter (useful for tests). */
export function _resetIdCounter(): void {
  _idCounter = 0
}

// ---------------------------------------------------------------------------
// SessionRecorder
// ---------------------------------------------------------------------------

const MAX_EVENTS = 50_000

export class SessionRecorder {
  private recording: SessionRecording | null = null
  private maxEvents: number

  constructor(maxEvents: number = MAX_EVENTS) {
    this.maxEvents = maxEvents
  }

  /** Start a new recording. Returns the recording ID (= sessionId). */
  startRecording(
    sessionId: string,
    metadata?: Partial<RecordingMetadata>,
  ): string {
    this.recording = {
      sessionId,
      startTime: Date.now(),
      events: [],
      metadata: {
        model: '',
        workspace: '',
        totalTokens: 0,
        totalCost: 0,
        toolsUsed: [],
        filesModified: [],
        ...metadata,
      },
    }
    return sessionId
  }

  /** Append an event. Uses a ring buffer when max is exceeded. */
  recordEvent(
    type: EventType,
    data: any,
    metadata?: Record<string, any>,
  ): SessionEvent {
    if (!this.recording) {
      throw new Error('No active recording. Call startRecording() first.')
    }

    const event: SessionEvent = {
      id: generateEventId(),
      timestamp: Date.now(),
      type,
      data,
      metadata,
    }

    if (this.recording.events.length >= this.maxEvents) {
      // Ring buffer: drop the oldest event
      this.recording.events.shift()
    }

    this.recording.events.push(event)

    // Track tools and files
    if (type === 'tool_call' && data?.toolName) {
      const tools = this.recording.metadata.toolsUsed
      if (!tools.includes(data.toolName)) {
        tools.push(data.toolName)
      }
    }
    if (type === 'tool_result' && data?.filesModified) {
      const files = this.recording.metadata.filesModified
      for (const f of data.filesModified) {
        if (!files.includes(f)) {
          files.push(f)
        }
      }
    }
    if (type === 'token_usage') {
      this.recording.metadata.totalTokens += data?.tokens ?? 0
      this.recording.metadata.totalCost += data?.cost ?? 0
    }

    return event
  }

  /** Stop the current recording and return it. */
  stopRecording(): SessionRecording {
    if (!this.recording) {
      throw new Error('No active recording.')
    }
    this.recording.endTime = Date.now()
    const result = { ...this.recording }
    this.recording = null
    return result
  }

  /** Return the current recording (still active). */
  getRecording(): SessionRecording {
    if (!this.recording) {
      throw new Error('No active recording.')
    }
    return this.recording
  }

  /** Whether a recording is currently active. */
  isRecording(): boolean {
    return this.recording !== null
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /** Save a recording to a JSON file. */
  static async save(recording: SessionRecording, path: string): Promise<void> {
    await writeFile(path, JSON.stringify(recording, null, 2), 'utf-8')
  }

  /** Load a recording from a JSON file. */
  static async load(path: string): Promise<SessionRecording> {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as SessionRecording
  }
}
