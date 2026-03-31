#!/usr/bin/env bun
/**
 * Innovation Modules Demo
 *
 * Demonstrates all innovation subsystems working together via the
 * InnovationOrchestrator. Run with: bun run src/innovations/demo.ts
 */

import { InnovationOrchestrator } from './orchestrator.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(title: string): void {
  const bar = '='.repeat(68)
  console.log(`\n${bar}`)
  console.log(`  ${title}`)
  console.log(bar)
}

function step(n: number, description: string): void {
  console.log(`\n--- Step ${n}: ${description} ---`)
}

function indent(text: string, prefix = '    '): void {
  for (const line of text.split('\n')) {
    console.log(`${prefix}${line}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  header('Open Claude Code - Innovation Modules Demo')
  console.log()
  console.log('  This demo shows all innovation subsystems working together')
  console.log('  through the InnovationOrchestrator integration layer.')

  // Create a temp directory for trust store so we don't pollute real data
  const tmpDir = mkdtempSync(join(tmpdir(), 'occ-demo-'))
  const trustStorePath = join(tmpDir, 'trust-scores.json')

  const orchestrator = new InnovationOrchestrator({
    workspacePath: '/home/user/my-project',
    trustStorePath,
    enableLocalModels: true,
    localModelEndpoint: 'http://localhost:11434',
    contextWindowSize: 200_000,
  })

  orchestrator.initialize()
  console.log('\n  Orchestrator initialized.')

  // -----------------------------------------------------------------------
  // Part 1: Trust Escalation - Build trust through successful reads
  // -----------------------------------------------------------------------
  header('Part 1: Progressive Trust Escalation')
  console.log()
  console.log('  Simulating 5 successful file reads to build up trust...')

  const readFiles = [
    'src/index.ts',
    'src/utils/helpers.ts',
    'src/config.ts',
    'src/types.ts',
    'src/main.ts',
  ]

  for (let i = 0; i < readFiles.length; i++) {
    step(i + 1, `Read ${readFiles[i]}`)

    const preTool = orchestrator.onToolExecutionStart('Read', readFiles[i]!)
    indent(`Trust decision: ${preTool.trustDecision?.reason ?? 'n/a'}`)
    indent(`Trust score: ${preTool.trustDecision?.score ?? 0}`)
    indent(`Pre-hints: ${preTool.preHints.length > 0 ? preTool.preHints.join('; ') : '(none)'}`)

    // Simulate successful read
    orchestrator.onToolExecutionComplete(
      'Read',
      readFiles[i]!,
      `// contents of ${readFiles[i]}...`,
      true,
    )

    // Check trust after recording
    const postDecision = orchestrator.queryTrust('Read', readFiles[i]!)
    indent(`After success -> score: ${postDecision.score}, behavior: ${postDecision.behavior}`)
  }

  // Check trust for a file we've read repeatedly
  step(6, 'Re-read src/index.ts (already trusted)')
  const reReadResult = orchestrator.onToolExecutionStart('Read', 'src/index.ts')
  indent(`Trust decision: ${reReadResult.trustDecision?.reason ?? 'n/a'}`)
  indent(`Behavior: ${reReadResult.trustDecision?.behavior}`)
  orchestrator.onToolExecutionComplete('Read', 'src/index.ts', '// ...', true)

  // -----------------------------------------------------------------------
  // Part 2: Tool Feedback - Detect failure patterns
  // -----------------------------------------------------------------------
  header('Part 2: Tool Failure Feedback Loop')
  console.log()
  console.log('  Simulating 3 failed file edits to trigger adaptive hints...')

  const editAttempts = [
    {
      input: 'Edit src/config.ts: replace "port: 3000" with "port: 8080"',
      error: { type: 'old_string_not_found', message: 'The string "port: 3000" was not found in the file' },
    },
    {
      input: 'Edit src/config.ts: replace "port:3000" with "port: 8080"',
      error: { type: 'old_string_not_found', message: 'The string "port:3000" was not found in the file' },
    },
    {
      input: 'Edit src/config.ts: replace "port = 3000" with "port = 8080"',
      error: { type: 'old_string_not_found', message: 'The string "port = 3000" was not found in the file' },
    },
  ]

  for (let i = 0; i < editAttempts.length; i++) {
    const attempt = editAttempts[i]!
    step(i + 1, `Failed Edit attempt #${i + 1}`)

    const preTool = orchestrator.onToolExecutionStart('Edit', attempt.input)
    indent(`Pre-hints: ${preTool.preHints.length > 0 ? preTool.preHints.join('; ') : '(none)'}`)

    orchestrator.onToolExecutionComplete(
      'Edit',
      attempt.input,
      'Error: old_string not found',
      false,
      attempt.error,
    )
    indent(`Recorded failure: ${attempt.error.message}`)
  }

  // Now check if the feedback system has picked up the pattern
  step(4, 'Check system prompt additions after failures')
  const additions = orchestrator.getSystemPromptAdditions()
  if (additions.length > 0) {
    console.log('  Feedback injections active:')
    for (const a of additions) {
      indent(a)
    }
  } else {
    console.log('  (No prompt injections yet - patterns may need more data)')
  }

  // Try one more edit - should get a pre-tool hint
  step(5, 'Attempt another Edit - checking for adaptive hints')
  const hintResult = orchestrator.onToolExecutionStart(
    'Edit',
    'Edit src/config.ts: replace "const port = 3000" with "const port = 8080"',
  )
  indent(`Pre-hints: ${hintResult.preHints.length > 0 ? hintResult.preHints.join('; ') : '(none)'}`)
  indent(`Routing: ${hintResult.routingDecision?.model ?? 'n/a'} (${hintResult.routingDecision?.reason ?? ''})`)

  // -----------------------------------------------------------------------
  // Part 3: Context Predictor - Token growth tracking
  // -----------------------------------------------------------------------
  header('Part 3: Predictive Context Management')
  console.log()
  console.log('  Simulating token growth across conversation turns...')

  const tokenGrowth = [
    { tokens: 15_000, msg: 'Initial prompt + first response' },
    { tokens: 28_000, msg: 'User asks to read several files' },
    { tokens: 45_000, msg: 'Large code review output' },
    { tokens: 72_000, msg: 'Multiple tool calls with outputs' },
    { tokens: 98_000, msg: 'Iterative editing with diffs' },
    { tokens: 125_000, msg: 'Deep debugging session' },
    { tokens: 138_000, msg: 'More tool output accumulation' },
    { tokens: 142_000, msg: 'Approaching threshold...' },
  ]

  for (let i = 0; i < tokenGrowth.length; i++) {
    const { tokens, msg } = tokenGrowth[i]!
    step(i + 1, msg)

    const decision = orchestrator.onNewMessage(msg, tokens)
    indent(`Tokens: ${tokens.toLocaleString()} / 200,000`)
    indent(`Urgency: ${decision.urgency}`)
    indent(`Should compact: ${decision.shouldCompact}`)
    indent(`Reason: ${decision.reason}`)
  }

  // -----------------------------------------------------------------------
  // Part 4: Agent Mesh - Shared knowledge
  // -----------------------------------------------------------------------
  header('Part 4: Agent Mesh with Shared Knowledge')
  console.log()
  console.log('  Two agents share knowledge about files in the project...')

  const graph = orchestrator.getKnowledgeGraph()
  const bus = orchestrator.getAgentBus()

  // Set up two agents
  const agent1Messages: string[] = []
  const agent2Messages: string[] = []

  bus.subscribe('agent-1', (msg) => {
    agent1Messages.push(
      `Received from ${msg.from}: ${msg.type} - ${JSON.stringify(msg.payload)}`,
    )
  })
  bus.subscribe('agent-2', (msg) => {
    agent2Messages.push(
      `Received from ${msg.from}: ${msg.type} - ${JSON.stringify(msg.payload)}`,
    )
  })

  step(1, 'Agent-1 discovers file structure')
  await graph.addNode({
    id: 'file:src/index.ts',
    type: 'file',
    content: 'Main entry point. Exports app initialization and CLI setup.',
    metadata: { path: 'src/index.ts', language: 'typescript', lines: 150 },
    agentId: 'agent-1',
    timestamp: Date.now(),
    confidence: 0.95,
  })
  await graph.addNode({
    id: 'file:src/config.ts',
    type: 'file',
    content: 'Configuration loader. Reads from .env and settings.json.',
    metadata: { path: 'src/config.ts', language: 'typescript', lines: 80 },
    agentId: 'agent-1',
    timestamp: Date.now(),
    confidence: 0.9,
  })
  await graph.addEdge({
    from: 'file:src/index.ts',
    to: 'file:src/config.ts',
    relation: 'depends_on',
    agentId: 'agent-1',
    timestamp: Date.now(),
  })
  indent(`Graph: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`)

  // Agent-1 broadcasts its discovery
  bus.publish({
    from: 'agent-1',
    to: 'broadcast',
    type: 'knowledge_update',
    payload: { nodes: ['file:src/index.ts', 'file:src/config.ts'], relation: 'depends_on' },
  })

  step(2, 'Agent-2 discovers an API endpoint')
  await graph.addNode({
    id: 'api:POST /users',
    type: 'api',
    content: 'User creation endpoint. Validates email, hashes password, creates DB record.',
    metadata: { method: 'POST', path: '/users', handler: 'src/routes/users.ts' },
    agentId: 'agent-2',
    timestamp: Date.now(),
    confidence: 0.85,
  })
  indent(`Graph: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`)

  bus.publish({
    from: 'agent-2',
    to: 'agent-1',
    type: 'knowledge_update',
    payload: { discovered: 'api:POST /users' },
  })

  // Wait a tick for message delivery
  await sleep(10)

  step(3, 'Check inter-agent messages')
  console.log('  Agent-1 inbox:')
  for (const m of agent1Messages) {
    indent(m)
  }
  console.log('  Agent-2 inbox:')
  for (const m of agent2Messages) {
    indent(m)
  }

  step(4, 'Query knowledge graph')
  const fileNodes = await graph.query('file')
  console.log(`  File nodes: ${fileNodes.length}`)
  for (const node of fileNodes) {
    indent(`${node.id}: ${node.content.slice(0, 60)}...`)
  }

  const related = await graph.getRelated('file:src/index.ts')
  console.log(`\n  Nodes related to file:src/index.ts:`)
  for (const node of related) {
    indent(`${node.id}`)
  }

  // -----------------------------------------------------------------------
  // Part 5: Trust Query - Should we auto-allow Bash(git commit)?
  // -----------------------------------------------------------------------
  header('Part 5: Trust Policy Query')
  console.log()
  console.log('  Question: "Should we auto-allow Bash(git commit)?"')

  step(1, 'Query trust for Bash + "git commit" (no history)')
  const gitCommitDecision = orchestrator.queryTrust('Bash', 'git commit')
  indent(`Score: ${gitCommitDecision.score}`)
  indent(`Behavior: ${gitCommitDecision.behavior}`)
  indent(`Reason: ${gitCommitDecision.reason}`)
  indent(`New context: ${gitCommitDecision.newContext}`)

  step(2, 'Simulate 8 successful git commits to build trust')
  for (let i = 0; i < 8; i++) {
    orchestrator.onToolExecutionComplete(
      'Bash',
      'git commit',
      `[main abc${i}def] Commit message ${i + 1}`,
      true,
    )
  }

  step(3, 'Query trust again after successful history')
  const gitCommitAfter = orchestrator.queryTrust('Bash', 'git commit')
  indent(`Score: ${gitCommitAfter.score}`)
  indent(`Behavior: ${gitCommitAfter.behavior}`)
  indent(`Reason: ${gitCommitAfter.reason}`)

  // -----------------------------------------------------------------------
  // Part 6: Model Routing
  // -----------------------------------------------------------------------
  header('Part 6: Model Routing Decisions')
  console.log()
  console.log('  Analyzing complexity for different inputs...')

  const routingExamples = [
    { input: 'ls', desc: 'Simple listing' },
    { input: 'Read the README.md file', desc: 'Read a file' },
    { input: 'Refactor the authentication module to use OAuth2 with PKCE flow, add rate limiting, and ensure backwards compatibility with existing JWT tokens', desc: 'Complex refactor' },
  ]

  for (let i = 0; i < routingExamples.length; i++) {
    const { input, desc } = routingExamples[i]!
    step(i + 1, desc)
    const result = orchestrator.onToolExecutionStart('Bash', input)
    indent(`Input: "${input.slice(0, 80)}"`)
    indent(`Routed to: ${result.routingDecision?.model ?? 'n/a'}`)
    indent(`Tier: ${result.routingDecision?.tier ?? 'n/a'}`)
    indent(`Reason: ${result.routingDecision?.reason ?? 'n/a'}`)
    indent(`Est. latency: ${result.routingDecision?.estimatedLatency ?? 0}ms`)
    indent(`Est. cost: $${result.routingDecision?.estimatedCost ?? 0}/1k tokens`)
  }

  // -----------------------------------------------------------------------
  // Final Status
  // -----------------------------------------------------------------------
  header('Final Status Snapshot')
  console.log()

  const status = orchestrator.getStatus()

  console.log('  Trust:')
  indent(`Total entries: ${status.trust.totalEntries}`)
  indent(`Recent decisions: ${status.trust.recentDecisions.length}`)

  console.log('\n  Feedback:')
  indent(`Total executions: ${status.feedback.totalExecutions}`)
  indent(`Failure rate: ${(status.feedback.failureRate * 100).toFixed(1)}%`)
  indent(`Insights generated: ${status.feedback.insightsGenerated}`)
  indent(`Active injections: ${status.feedback.injectionsActive}`)

  console.log('\n  Context:')
  indent(`Turns recorded: ${status.context.turnCount}`)
  indent(`Avg growth rate: ${Math.round(status.context.averageGrowthRate).toLocaleString()} tokens/turn`)
  if (status.context.lastCompactionDecision) {
    indent(`Last decision: ${status.context.lastCompactionDecision.urgency} (compact: ${status.context.lastCompactionDecision.shouldCompact})`)
  }

  console.log('\n  Agent Mesh:')
  indent(`Knowledge graph: ${status.mesh.graphNodes} nodes, ${status.mesh.graphEdges} edges`)
  indent(`Active agents: ${status.mesh.activeAgents.join(', ') || '(none)'}`)

  console.log('\n  Routing:')
  indent(`Available tiers: ${status.routing.availableTiers.join(', ')}`)
  if (status.routing.lastComplexity) {
    indent(`Last complexity: ${status.routing.lastComplexity.level} (score ${status.routing.lastComplexity.score})`)
  }
  if (status.routing.lastRoutingDecision) {
    indent(`Last route: ${status.routing.lastRoutingDecision.model}`)
  }

  // Shutdown
  orchestrator.shutdown()

  header('Demo Complete')
  console.log()
  console.log('  All innovation modules demonstrated successfully.')
  console.log(`  Temp data stored at: ${tmpDir}`)
  console.log()
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Demo failed:', err)
  process.exit(1)
})
