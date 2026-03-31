/**
 * Tests for Hybrid Local/Cloud Model Routing
 *
 * Covers: complexity scoring heuristics, routing decisions, fallback chains,
 * and the factory wiring.
 */

import { describe, expect, it } from 'vitest'
import {
  ComplexityAnalyzer,
  type ConversationContext,
  type ModelTier,
  type ToolHistoryEntry,
} from '../complexityAnalyzer.js'
import {
  RoutingPolicy,
  type ModelConfig,
} from '../routingPolicy.js'
import { createModelRouter } from '../index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModels(...tiers: ModelTier[]): ModelConfig[] {
  const defaults: Record<ModelTier, Omit<ModelConfig, 'tier'>> = {
    local_small: {
      model: 'llama3:8b',
      endpoint: 'http://localhost:11434',
      maxTokens: 4096,
      latencyMs: 80,
      costPer1kTokens: 0,
      capabilities: ['code', 'chat'],
    },
    local_medium: {
      model: 'codellama:34b',
      endpoint: 'http://localhost:11434',
      maxTokens: 8192,
      latencyMs: 200,
      costPer1kTokens: 0,
      capabilities: ['code', 'chat', 'analysis'],
    },
    cloud_fast: {
      model: 'claude-haiku-3',
      endpoint: 'https://api.anthropic.com',
      maxTokens: 4096,
      latencyMs: 400,
      costPer1kTokens: 0.001,
      capabilities: ['code', 'chat', 'analysis'],
    },
    cloud_standard: {
      model: 'claude-sonnet-4-20250514',
      endpoint: 'https://api.anthropic.com',
      maxTokens: 8192,
      latencyMs: 800,
      costPer1kTokens: 0.009,
      capabilities: ['code', 'analysis', 'tool_use'],
    },
    cloud_thinking: {
      model: 'claude-opus-4-6-20260401',
      endpoint: 'https://api.anthropic.com',
      maxTokens: 16384,
      latencyMs: 3000,
      costPer1kTokens: 0.045,
      capabilities: ['code', 'analysis', 'tool_use', 'thinking'],
    },
  }
  return tiers.map((tier) => ({ tier, ...defaults[tier] }))
}

const allModels = makeModels(
  'local_small',
  'local_medium',
  'cloud_fast',
  'cloud_standard',
  'cloud_thinking',
)

// ---------------------------------------------------------------------------
// ComplexityAnalyzer
// ---------------------------------------------------------------------------

describe('ComplexityAnalyzer', () => {
  const analyzer = new ComplexityAnalyzer()

  describe('message length scoring', () => {
    it('rates very short messages as simpler', () => {
      const result = analyzer.analyze('ls')
      expect(result.score).toBeLessThan(30)
      expect(result.factors.some((f) => f.includes('very short'))).toBe(true)
    })

    it('rates long messages as more complex', () => {
      const longMsg =
        'I need to refactor the entire authentication system. ' +
        'Currently we use JWT tokens stored in localStorage but we need to migrate ' +
        'to httpOnly cookies with refresh token rotation. The system spans multiple ' +
        'services including the API gateway, user service, and session service. ' +
        'We also need backwards compatibility during the migration period. ' +
        'Please design the migration plan and implement the core changes. ' +
        'Here are the files involved: src/auth/jwt.ts, src/auth/session.ts, ' +
        'src/gateway/middleware.ts, src/services/user/auth.controller.ts, ' +
        'src/services/session/store.ts, and the shared types in packages/types/auth.ts.'
      const result = analyzer.analyze(longMsg)
      expect(result.score).toBeGreaterThan(50)
    })
  })

  describe('keyword scoring', () => {
    it('detects simple keywords and lowers score', () => {
      const result = analyzer.analyze('show me the contents of package.json')
      expect(result.factors.some((f) => f.includes('simple keywords'))).toBe(true)
      expect(result.level).toBe('simple')
    })

    it('detects complex keywords and raises score', () => {
      const result = analyzer.analyze(
        'refactor the authentication module to use a new design pattern',
      )
      expect(result.factors.some((f) => f.includes('complex keywords'))).toBe(true)
      expect(result.score).toBeGreaterThan(40)
    })

    it('detects difficulty markers', () => {
      const result = analyzer.analyze(
        'this is a tricky edge case with subtle behavior',
      )
      expect(result.factors.some((f) => f.includes('difficulty markers'))).toBe(
        true,
      )
    })
  })

  describe('code references', () => {
    it('increases score for many file references', () => {
      const msg =
        'Update src/auth/login.ts, src/auth/logout.ts, src/auth/refresh.ts, ' +
        'src/auth/middleware.ts, src/auth/types.ts, and src/auth/utils.ts'
      const result = analyzer.analyze(msg)
      expect(result.factors.some((f) => f.includes('file references'))).toBe(true)
    })

    it('increases score for code blocks', () => {
      const msg =
        'Here is the current code:\n```\nfunction foo() {}\n```\n' +
        'And here is what I want:\n```\nfunction bar() {}\n```'
      const result = analyzer.analyze(msg)
      expect(result.factors.some((f) => f.includes('code block'))).toBe(true)
    })

    it('increases score for multi-step requests', () => {
      const msg =
        '1. First, read the config file\n' +
        '2. Then update the database schema\n' +
        '3. Run the migrations\n' +
        '4. Update the API handlers'
      const result = analyzer.analyze(msg)
      expect(result.factors.some((f) => f.includes('multi-step'))).toBe(true)
    })
  })

  describe('question structure', () => {
    it('lowers score for terse commands', () => {
      const result = analyzer.analyze('git status')
      expect(result.factors.some((f) => f.includes('terse command'))).toBe(true)
    })

    it('lowers score for short questions', () => {
      const result = analyzer.analyze('what is the node version?')
      expect(result.factors.some((f) => f.includes('short question'))).toBe(true)
    })
  })

  describe('conversation context', () => {
    it('increases score for deep conversations', () => {
      const ctx: ConversationContext = {
        turnCount: 15,
        messageCount: 30,
        hasCodeEdits: true,
        topics: ['auth', 'database', 'testing', 'deployment'],
      }
      const result = analyzer.analyze('continue', ctx)
      expect(result.factors.some((f) => f.includes('deep conversation'))).toBe(
        true,
      )
      expect(result.factors.some((f) => f.includes('code edits'))).toBe(true)
      expect(result.factors.some((f) => f.includes('multi-topic'))).toBe(true)
    })
  })

  describe('tool history', () => {
    it('lowers score when recent tools are read-only', () => {
      const tools: ToolHistoryEntry[] = [
        { name: 'Read', timestamp: Date.now(), success: true },
        { name: 'Grep', timestamp: Date.now(), success: true },
        { name: 'Glob', timestamp: Date.now(), success: true },
      ]
      const result = analyzer.analyze('what does this function do?', undefined, tools)
      expect(result.factors.some((f) => f.includes('read-only'))).toBe(true)
    })

    it('raises score when tool failure rate is high', () => {
      const tools: ToolHistoryEntry[] = [
        { name: 'Bash', timestamp: Date.now(), success: false },
        { name: 'Edit', timestamp: Date.now(), success: false },
        { name: 'Bash', timestamp: Date.now(), success: true },
        { name: 'Edit', timestamp: Date.now(), success: false },
      ]
      const result = analyzer.analyze('try again', undefined, tools)
      expect(result.factors.some((f) => f.includes('failure rate'))).toBe(true)
    })
  })

  describe('model tier suggestion', () => {
    it('suggests local_small for trivial tasks', () => {
      const result = analyzer.analyze('hi')
      expect(result.suggestedModel).toBe('local_small')
    })

    it('suggests cloud_thinking for expert tasks', () => {
      const longComplex =
        'Design and architect a distributed microservice system with ' +
        'authentication, authorization, rate limiting, and backwards compatible ' +
        'API versioning. This is a tricky edge case involving concurrent ' +
        'database migrations across src/db/schema.ts, src/db/migrate.ts, ' +
        'src/api/v1/routes.ts, src/api/v2/routes.ts, src/auth/oauth.ts, ' +
        'and src/gateway/proxy.ts. Handle all the subtle race conditions.'
      const result = analyzer.analyze(longComplex)
      expect(['cloud_standard', 'cloud_thinking']).toContain(
        result.suggestedModel,
      )
      expect(result.score).toBeGreaterThan(60)
    })
  })

  describe('configurable thresholds', () => {
    it('uses custom thresholds', () => {
      const strict = new ComplexityAnalyzer({ trivialMax: 5, simpleMax: 10 })
      // A moderately short message that would be "simple" with defaults
      // but "moderate" with strict thresholds
      const result = strict.analyze('show me the README file')
      // With strict thresholds, more things become moderate+
      expect(result.level).not.toBe('trivial')
    })
  })

  describe('score clamping', () => {
    it('never returns a score below 0', () => {
      // Stack many negative signals
      const result = analyzer.analyze('ls')
      expect(result.score).toBeGreaterThanOrEqual(0)
    })

    it('never returns a score above 100', () => {
      // Stack many positive signals
      const extreme =
        'refactor architect design migrate rewrite overhaul optimize performance security ' +
        'authentication authorization database schema distributed concurrent parallel ' +
        'tricky careful edge case subtle nuance complex complicated difficult challenging ' +
        'src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts ' +
        '```code1```\n```code2```\n```code3```\n' +
        '1. step one\n2. step two\n3. step three\n4. step four'
      const ctx: ConversationContext = {
        turnCount: 20,
        messageCount: 40,
        hasCodeEdits: true,
        topics: ['a', 'b', 'c', 'd', 'e'],
      }
      const tools: ToolHistoryEntry[] = Array.from({ length: 5 }, () => ({
        name: 'Edit',
        timestamp: Date.now(),
        success: false,
      }))
      const result = analyzer.analyze(extreme, ctx, tools)
      expect(result.score).toBeLessThanOrEqual(100)
    })
  })
})

// ---------------------------------------------------------------------------
// RoutingPolicy
// ---------------------------------------------------------------------------

describe('RoutingPolicy', () => {
  describe('basic routing', () => {
    it('routes trivial tasks to local_small', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route({
        level: 'trivial',
        score: 5,
        factors: [],
        suggestedModel: 'local_small',
      })
      expect(decision.tier).toBe('local_small')
      expect(decision.model).toBe('llama3:8b')
    })

    it('routes complex tasks to cloud_standard', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route({
        level: 'complex',
        score: 75,
        factors: [],
        suggestedModel: 'cloud_standard',
      })
      expect(decision.tier).toBe('cloud_standard')
    })

    it('routes expert tasks to cloud_thinking', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route({
        level: 'expert',
        score: 92,
        factors: [],
        suggestedModel: 'cloud_thinking',
      })
      expect(decision.tier).toBe('cloud_thinking')
    })
  })

  describe('fallback chain', () => {
    it('escalates to cloud when local is unavailable', () => {
      // Only cloud models available
      const cloudOnly = makeModels('cloud_fast', 'cloud_standard')
      const policy = new RoutingPolicy(cloudOnly)
      const decision = policy.route({
        level: 'trivial',
        score: 5,
        factors: [],
        suggestedModel: 'local_small',
      })
      // Should escalate since local_small is not available
      expect(decision.tier).toBe('cloud_fast')
      expect(decision.reason).toContain('escalated')
    })

    it('de-escalates when higher tiers are unavailable', () => {
      const limited = makeModels('local_small', 'cloud_fast')
      const policy = new RoutingPolicy(limited)
      const decision = policy.route({
        level: 'expert',
        score: 95,
        factors: [],
        suggestedModel: 'cloud_thinking',
      })
      // cloud_thinking and cloud_standard unavailable, should fall to cloud_fast
      expect(decision.tier).toBe('cloud_fast')
    })

    it('provides a fallback tier in the decision', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route({
        level: 'simple',
        score: 20,
        factors: [],
        suggestedModel: 'local_small',
      })
      expect(decision.fallback).toBeDefined()
    })
  })

  describe('constraint filtering', () => {
    it('respects maxLatency constraint', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route(
        {
          level: 'expert',
          score: 95,
          factors: [],
          suggestedModel: 'cloud_thinking',
        },
        { maxLatency: 1000 },
      )
      expect(decision.estimatedLatency).toBeLessThanOrEqual(1000)
    })

    it('respects maxCost constraint', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route(
        {
          level: 'expert',
          score: 95,
          factors: [],
          suggestedModel: 'cloud_thinking',
        },
        { maxCost: 0.01 },
      )
      expect(decision.estimatedCost).toBeLessThanOrEqual(0.01)
    })

    it('respects requireCapabilities constraint', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route(
        {
          level: 'trivial',
          score: 5,
          factors: [],
          suggestedModel: 'local_small',
        },
        { requireCapabilities: ['thinking'] },
      )
      // Only cloud_thinking has 'thinking' capability
      expect(decision.tier).toBe('cloud_thinking')
    })
  })

  describe('tier inspection', () => {
    it('reports available tiers', () => {
      const policy = new RoutingPolicy(makeModels('local_small', 'cloud_fast'))
      expect(policy.hasTier('local_small')).toBe(true)
      expect(policy.hasTier('cloud_fast')).toBe(true)
      expect(policy.hasTier('cloud_thinking')).toBe(false)
    })

    it('returns models for a tier', () => {
      const policy = new RoutingPolicy(allModels)
      const models = policy.getModelsForTier('cloud_standard')
      expect(models).toHaveLength(1)
      expect(models[0]!.model).toBe('claude-sonnet-4-20250514')
    })
  })

  describe('cost estimation', () => {
    it('returns zero cost for local models', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route({
        level: 'trivial',
        score: 5,
        factors: [],
        suggestedModel: 'local_small',
      })
      expect(decision.estimatedCost).toBe(0)
    })

    it('returns non-zero cost for cloud models', () => {
      const policy = new RoutingPolicy(allModels)
      const decision = policy.route({
        level: 'complex',
        score: 75,
        factors: [],
        suggestedModel: 'cloud_standard',
      })
      expect(decision.estimatedCost).toBeGreaterThan(0)
    })
  })
})

// ---------------------------------------------------------------------------
// createModelRouter factory
// ---------------------------------------------------------------------------

describe('createModelRouter', () => {
  it('creates a router with all components', () => {
    const router = createModelRouter({ models: allModels })
    expect(router).toBeDefined()
    expect(router.getStats().localQueries).toBe(0)
    expect(router.getStats().cloudQueries).toBe(0)
  })

  it('analyzes complexity without executing', () => {
    const router = createModelRouter({ models: allModels })
    const complexity = router.analyzeComplexity('what is 2+2?')
    expect(['trivial', 'simple']).toContain(complexity.level)
    expect(complexity.score).toBeLessThan(40)
  })

  it('accepts custom thresholds', () => {
    const router = createModelRouter({
      models: allModels,
      thresholds: { trivialMax: 50 },
    })
    const complexity = router.analyzeComplexity('read file.ts')
    // With a very generous trivialMax, short messages should be trivial
    expect(complexity.level).toBe('trivial')
  })

  it('resets stats', () => {
    const router = createModelRouter({ models: allModels })
    router.resetStats()
    const stats = router.getStats()
    expect(stats.localQueries).toBe(0)
    expect(stats.cloudQueries).toBe(0)
    expect(stats.escalations).toBe(0)
  })
})
