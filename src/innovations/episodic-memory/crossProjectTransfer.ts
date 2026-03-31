/**
 * Structured Episodic Memory - Cross-Project Transfer
 *
 * Tracks patterns and user preferences across projects so that
 * knowledge gained in one project can be transferred to others.
 * Only patterns observed in 2+ projects are considered transferable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LearnedPattern = {
  pattern: string
  context: string
  frequency: number
  confidence: number // 0-1
  projects: string[]
}

export type UserPreference = {
  key: string
  value: string
  source: string
  frequency: number
}

export type ProjectProfile = {
  projectId: string
  patterns: LearnedPattern[]
  preferences: UserPreference[]
}

export type TransferSuggestion = {
  patterns: LearnedPattern[]
  preferences: UserPreference[]
}

// ---------------------------------------------------------------------------
// Cross-Project Transfer
// ---------------------------------------------------------------------------

export class CrossProjectTransfer {
  /** All known patterns, keyed by pattern string for dedup */
  private patterns = new Map<string, LearnedPattern>()
  /** All known preferences, keyed by `${key}::${value}` for dedup */
  private preferences = new Map<string, UserPreference>()
  /** Per-project profiles */
  private profiles = new Map<string, ProjectProfile>()

  // -- Recording ------------------------------------------------------------

  /** Record a pattern observed in a project.
   *  If the same pattern has been seen before the frequency is incremented
   *  and the project list is extended. */
  recordPattern(projectId: string, pattern: string, context: string): void {
    this.ensureProfile(projectId)

    const existing = this.patterns.get(pattern)
    if (existing) {
      existing.frequency++
      if (!existing.projects.includes(projectId)) {
        existing.projects.push(projectId)
      }
      // Confidence grows with more projects (capped at 1)
      existing.confidence = Math.min(1, 0.3 + existing.projects.length * 0.2)
      existing.context = context // keep latest context
    } else {
      const entry: LearnedPattern = {
        pattern,
        context,
        frequency: 1,
        confidence: 0.3,
        projects: [projectId],
      }
      this.patterns.set(pattern, entry)
    }

    // Update project profile
    const profile = this.profiles.get(projectId)!
    if (!profile.patterns.find(p => p.pattern === pattern)) {
      profile.patterns.push(this.patterns.get(pattern)!)
    }
  }

  /** Record a user preference observed in a project. */
  recordPreference(projectId: string, key: string, value: string): void {
    this.ensureProfile(projectId)

    const prefKey = `${key}::${value}`
    const existing = this.preferences.get(prefKey)
    if (existing) {
      existing.frequency++
      // Track which project contributed (via source update)
      if (!existing.source.includes(projectId)) {
        existing.source = `${existing.source},${projectId}`
      }
    } else {
      this.preferences.set(prefKey, {
        key,
        value,
        source: projectId,
        frequency: 1,
      })
    }

    // Update project profile
    const profile = this.profiles.get(projectId)!
    if (!profile.preferences.find(p => p.key === key && p.value === value)) {
      profile.preferences.push(this.preferences.get(prefKey)!)
    }
  }

  // -- Retrieval ------------------------------------------------------------

  /** Get patterns transferable from one project to another.
   *  A pattern is transferable if it has been observed in 2+ projects
   *  and at least one of those is the `fromProject`. */
  getTransferablePatterns(fromProject: string, toProject: string): LearnedPattern[] {
    return Array.from(this.patterns.values()).filter(
      p =>
        p.projects.length >= 2 &&
        p.projects.includes(fromProject) &&
        !p.projects.includes(toProject),
    )
  }

  /** Get preferences that are consistent across ALL known projects. */
  getUniversalPreferences(): UserPreference[] {
    const projectCount = this.profiles.size
    if (projectCount < 2) return []

    return Array.from(this.preferences.values()).filter(p => {
      const sources = p.source.split(',')
      return sources.length >= projectCount
    })
  }

  /** Suggest patterns and preferences for a brand-new project
   *  based on knowledge from existing projects. */
  suggestForNewProject(existingProjects: string[]): TransferSuggestion {
    // Patterns seen in 2+ of the given projects
    const patterns = Array.from(this.patterns.values())
      .filter(p => {
        const overlap = p.projects.filter(proj => existingProjects.includes(proj))
        return overlap.length >= 2
      })
      .sort((a, b) => b.confidence - a.confidence)

    // Preferences consistent across the given projects
    const preferences = Array.from(this.preferences.values())
      .filter(p => {
        const sources = p.source.split(',')
        const overlap = sources.filter(s => existingProjects.includes(s))
        return overlap.length >= 2
      })
      .sort((a, b) => b.frequency - a.frequency)

    return { patterns, preferences }
  }

  /** Get the profile for a project, or undefined. */
  getProfile(projectId: string): ProjectProfile | undefined {
    return this.profiles.get(projectId)
  }

  /** Get all known project IDs. */
  getProjectIds(): string[] {
    return Array.from(this.profiles.keys())
  }

  // -- Internals ------------------------------------------------------------

  private ensureProfile(projectId: string): void {
    if (!this.profiles.has(projectId)) {
      this.profiles.set(projectId, {
        projectId,
        patterns: [],
        preferences: [],
      })
    }
  }
}
