/**
 * Session Replay & Debugging
 *
 * Record, replay, and analyse full agent sessions for debugging
 * and optimisation. Self-contained module with no external imports.
 */

// Session recorder
export { SessionRecorder, _resetIdCounter } from './sessionRecorder.js'
export type {
  EventType,
  SessionEvent,
  RecordingMetadata,
  SessionRecording,
} from './sessionRecorder.js'

// Session replayer
export { SessionReplayer } from './sessionReplayer.js'
export type {
  ReplayOptions,
  ReplayState,
  TimelineEntry,
} from './sessionReplayer.js'

// Session analyzer
export { SessionAnalyzer } from './sessionAnalyzer.js'
export type {
  TokenUsage,
  ToolStats,
  CostBreakdown,
  EfficiencyScore,
  Bottleneck,
  ErrorPattern,
  SessionAnalysis,
  ComparisonReport,
} from './sessionAnalyzer.js'

// Diff viewer
export { DiffViewer } from './diffViewer.js'
export type {
  ToolDiff,
  TimingDiff,
  SessionDiff,
} from './diffViewer.js'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

import { SessionRecorder } from './sessionRecorder.js'
import { SessionReplayer } from './sessionReplayer.js'
import { SessionAnalyzer } from './sessionAnalyzer.js'
import { DiffViewer } from './diffViewer.js'

export interface SessionReplay {
  recorder: SessionRecorder
  replayer: SessionReplayer
  analyzer: SessionAnalyzer
  diffViewer: DiffViewer
}

/**
 * Create a fully-wired Session Replay system ready for use.
 */
export function createSessionReplay(): SessionReplay {
  return {
    recorder: new SessionRecorder(),
    replayer: new SessionReplayer(),
    analyzer: new SessionAnalyzer(),
    diffViewer: new DiffViewer(),
  }
}
