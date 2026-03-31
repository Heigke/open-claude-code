/**
 * Hybrid Local/Cloud Model Routing - Complexity Analyzer
 *
 * Analyzes user messages and conversation context to determine task
 * complexity, enabling intelligent routing between local and cloud models.
 * All heuristics run locally with zero API calls.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelTier =
  | 'local_small'
  | 'local_medium'
  | 'cloud_fast'
  | 'cloud_standard'
  | 'cloud_thinking'

export type ComplexityLevel =
  | 'trivial'
  | 'simple'
  | 'moderate'
  | 'complex'
  | 'expert'

export type TaskComplexity = {
  /** Categorical difficulty assessment */
  level: ComplexityLevel
  /** Numeric score from 0 (trivial) to 100 (expert) */
  score: number
  /** Human-readable reasons that contributed to the score */
  factors: string[]
  /** Recommended model tier for this complexity */
  suggestedModel: ModelTier
}

export type ConversationContext = {
  /** Number of turns so far in the conversation */
  turnCount: number
  /** Total number of messages (including assistant) */
  messageCount: number
  /** Whether the conversation has involved code editing */
  hasCodeEdits: boolean
  /** Accumulated topic areas (e.g. "testing", "refactoring") */
  topics: string[]
}

export type ToolHistoryEntry = {
  name: string
  timestamp: number
  success: boolean
}

export type ComplexityThresholds = {
  /** Score boundary: trivial < trivialMax */
  trivialMax: number
  /** Score boundary: simple < simpleMax */
  simpleMax: number
  /** Score boundary: moderate < moderateMax */
  moderateMax: number
  /** Score boundary: complex < complexMax, else expert */
  complexMax: number
}

// ---------------------------------------------------------------------------
// Keyword Dictionaries
// ---------------------------------------------------------------------------

const SIMPLE_KEYWORDS = [
  'read',
  'show',
  'list',
  'print',
  'display',
  'what is',
  'what are',
  'how many',
  'where is',
  'find',
  'search',
  'look up',
  'check',
  'status',
  'version',
  'help',
  'explain',
  'describe',
  'count',
  'ls',
  'cat',
  'grep',
] as const

const COMPLEX_KEYWORDS = [
  'refactor',
  'architect',
  'design',
  'redesign',
  'migrate',
  'rewrite',
  'overhaul',
  'optimize',
  'performance',
  'security',
  'authentication',
  'authorization',
  'database schema',
  'distributed',
  'concurrent',
  'parallel',
  'async',
  'microservice',
  'infrastructure',
  'deploy',
  'ci/cd',
  'pipeline',
  'monorepo',
  'cross-platform',
  'backwards compatible',
  'backward compatible',
] as const

const DIFFICULTY_MARKERS = [
  'tricky',
  'careful',
  'edge case',
  'corner case',
  'subtle',
  'nuance',
  'complex',
  'complicated',
  'difficult',
  'challenging',
  'advanced',
  'sophisticated',
  'non-trivial',
  'nontrivial',
  'intricate',
] as const

const SIMPLE_TOOL_NAMES = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Bash', // bash alone can be simple (ls, cat)
])

// ---------------------------------------------------------------------------
// Default Thresholds
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: ComplexityThresholds = {
  trivialMax: 15,
  simpleMax: 35,
  moderateMax: 60,
  complexMax: 85,
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export class ComplexityAnalyzer {
  private thresholds: ComplexityThresholds

  constructor(thresholds?: Partial<ComplexityThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  /**
   * Analyze a user message and optional context to produce a complexity
   * assessment. Pure heuristic -- no network calls.
   */
  analyze(
    userMessage: string,
    conversationContext?: ConversationContext,
    recentTools?: ToolHistoryEntry[],
  ): TaskComplexity {
    const factors: string[] = []
    let score = 30 // baseline: low-moderate

    // --- Message length ---
    score += this.scoreMessageLength(userMessage, factors)

    // --- Keyword analysis ---
    score += this.scoreKeywords(userMessage, factors)

    // --- Difficulty markers ---
    score += this.scoreDifficultyMarkers(userMessage, factors)

    // --- Code/file references ---
    score += this.scoreCodeReferences(userMessage, factors)

    // --- Question structure ---
    score += this.scoreQuestionStructure(userMessage, factors)

    // --- Conversation context ---
    if (conversationContext) {
      score += this.scoreConversationContext(conversationContext, factors)
    }

    // --- Tool history ---
    if (recentTools && recentTools.length > 0) {
      score += this.scoreToolHistory(recentTools, factors)
    }

    // Clamp to [0, 100]
    score = Math.max(0, Math.min(100, score))

    const level = this.scoreToLevel(score)
    const suggestedModel = this.levelToTier(level)

    return { level, score, factors, suggestedModel }
  }

  // -----------------------------------------------------------------------
  // Individual scoring functions
  // -----------------------------------------------------------------------

  private scoreMessageLength(message: string, factors: string[]): number {
    const len = message.trim().length
    if (len < 20) {
      factors.push('very short message (<20 chars)')
      return -15
    }
    if (len < 80) {
      factors.push('short message (<80 chars)')
      return -8
    }
    if (len > 500) {
      factors.push('long message (>500 chars)')
      return 10
    }
    if (len > 1500) {
      factors.push('very long message (>1500 chars)')
      return 20
    }
    return 0
  }

  private scoreKeywords(message: string, factors: string[]): number {
    const lower = message.toLowerCase()
    let delta = 0

    const simpleMatches = SIMPLE_KEYWORDS.filter((kw) => lower.includes(kw))
    if (simpleMatches.length > 0) {
      factors.push(`simple keywords: ${simpleMatches.slice(0, 3).join(', ')}`)
      delta -= Math.min(simpleMatches.length * 5, 15)
    }

    const complexMatches = COMPLEX_KEYWORDS.filter((kw) => lower.includes(kw))
    if (complexMatches.length > 0) {
      factors.push(
        `complex keywords: ${complexMatches.slice(0, 3).join(', ')}`,
      )
      delta += Math.min(complexMatches.length * 8, 25)
    }

    return delta
  }

  private scoreDifficultyMarkers(message: string, factors: string[]): number {
    const lower = message.toLowerCase()
    const matches = DIFFICULTY_MARKERS.filter((m) => lower.includes(m))
    if (matches.length > 0) {
      factors.push(`difficulty markers: ${matches.slice(0, 3).join(', ')}`)
      return Math.min(matches.length * 7, 20)
    }
    return 0
  }

  private scoreCodeReferences(message: string, factors: string[]): number {
    let delta = 0

    // File path references (e.g. src/foo/bar.ts, ./config.json)
    const fileRefs = message.match(
      /(?:\.\/|src\/|\/[\w-]+\/)[^\s,)]+\.\w{1,5}/g,
    )
    if (fileRefs) {
      const count = new Set(fileRefs).size
      if (count >= 5) {
        factors.push(`many file references (${count} files)`)
        delta += 20
      } else if (count >= 2) {
        factors.push(`multiple file references (${count} files)`)
        delta += 8
      }
    }

    // Code blocks (triple backtick)
    const codeBlocks = message.match(/```/g)
    if (codeBlocks && codeBlocks.length >= 2) {
      const blockCount = Math.floor(codeBlocks.length / 2)
      factors.push(`${blockCount} code block(s) in message`)
      delta += Math.min(blockCount * 5, 15)
    }

    // Multi-step instructions (numbered lists)
    const numberedSteps = message.match(/^\s*\d+[\.\)]\s/gm)
    if (numberedSteps && numberedSteps.length >= 3) {
      factors.push(`multi-step request (${numberedSteps.length} steps)`)
      delta += 10
    }

    return delta
  }

  private scoreQuestionStructure(message: string, factors: string[]): number {
    const trimmed = message.trim()

    // Single-word or very terse commands
    if (!trimmed.includes(' ') || trimmed.split(/\s+/).length <= 3) {
      factors.push('terse command (<=3 words)')
      return -10
    }

    // Questions ending with ? tend to be simpler lookups
    if (trimmed.endsWith('?') && trimmed.split(/\s+/).length <= 10) {
      factors.push('short question')
      return -5
    }

    return 0
  }

  private scoreConversationContext(
    ctx: ConversationContext,
    factors: string[],
  ): number {
    let delta = 0

    if (ctx.turnCount > 10) {
      factors.push(`deep conversation (${ctx.turnCount} turns)`)
      delta += 10
    } else if (ctx.turnCount > 5) {
      factors.push(`moderate conversation depth (${ctx.turnCount} turns)`)
      delta += 5
    }

    if (ctx.hasCodeEdits) {
      factors.push('conversation includes code edits')
      delta += 5
    }

    if (ctx.topics.length > 3) {
      factors.push(`multi-topic conversation (${ctx.topics.length} topics)`)
      delta += 5
    }

    return delta
  }

  private scoreToolHistory(
    tools: ToolHistoryEntry[],
    factors: string[],
  ): number {
    const recentCount = tools.length
    const allSimple = tools.every((t) => SIMPLE_TOOL_NAMES.has(t.name))
    const failureRate =
      recentCount > 0
        ? tools.filter((t) => !t.success).length / recentCount
        : 0

    let delta = 0

    if (allSimple && recentCount > 0) {
      factors.push('recent tools are all read-only')
      delta -= 8
    }

    if (failureRate > 0.5 && recentCount >= 3) {
      factors.push(
        `high tool failure rate (${Math.round(failureRate * 100)}%)`,
      )
      delta += 10
    }

    return delta
  }

  // -----------------------------------------------------------------------
  // Score mapping
  // -----------------------------------------------------------------------

  private scoreToLevel(score: number): ComplexityLevel {
    if (score < this.thresholds.trivialMax) return 'trivial'
    if (score < this.thresholds.simpleMax) return 'simple'
    if (score < this.thresholds.moderateMax) return 'moderate'
    if (score < this.thresholds.complexMax) return 'complex'
    return 'expert'
  }

  private levelToTier(level: ComplexityLevel): ModelTier {
    switch (level) {
      case 'trivial':
        return 'local_small'
      case 'simple':
        return 'local_small'
      case 'moderate':
        return 'cloud_fast'
      case 'complex':
        return 'cloud_standard'
      case 'expert':
        return 'cloud_thinking'
    }
  }
}
