# Open Claude Code - Innovation Modules

## Overview

Seven interconnected innovation modules that enhance Claude Code's capabilities
beyond standard tool execution. Each module can operate independently, but
the **InnovationOrchestrator** ties them together into a cohesive system.

| # | Module | Purpose |
|---|--------|---------|
| 1 | Trust Escalation | Progressively auto-allow tools based on execution history |
| 2 | Predictive Context | Forecast token growth and trigger preemptive compaction |
| 3 | Agent Mesh | Multi-agent shared state, messaging, and conflict resolution |
| 4 | Model Router | Route tasks to local or cloud models by complexity |
| 5 | Tool Feedback | Detect failure patterns and inject adaptive hints |
| 6 | Episodic Memory | Vector-indexed memory store with TF-IDF embeddings |
| 7 | Real-time Collab | Session brokering for multi-user collaboration |

## Architecture

```
                          +------------------------+
                          | InnovationOrchestrator |
                          +------------------------+
                          |  initialize()          |
                          |  onToolExecutionStart()|
                          |  onToolExecutionComplete()
                          |  onNewMessage()        |
                          |  getSystemPromptAdditions()
                          |  getStatus()           |
                          |  shutdown()            |
                          +----------+-------------+
                                     |
              +----------+-----------+-----------+----------+
              |          |           |           |          |
        +-----+----+ +--+---+ +-----+-----+ +--+---+ +----+------+
        |  Trust   | |Context| |  Agent   | |Model | |  Tool    |
        |Escalation| |Predict| |  Mesh    | |Router| | Feedback |
        +-----+----+ +--+---+ +-----+-----+ +--+---+ +----+------+
              |          |           |           |          |
        +-----+--+ +----+-----+ +--+--+--+ +---+----+ +---+------+
        |TrustStore| |Predictor | |Graph| | |Analyzer| |Tracker  |
        |TrustPolicy |Compactor | |Bus  | | |Policy  | |Analyzer |
        +---------+ +----------+ |Coord| | |Bridge  | |Injector |
                                  +-----+ | +--------+ +---------+
                                           |
                                   +-------+--------+
                                   | Episodic Memory |
                                   | Real-time Collab|
                                   +----------------+
```

### Data Flow

1. **Before tool execution**: Orchestrator queries trust policy, retrieves
   feedback hints, and analyzes task complexity for routing.

2. **After tool execution**: Outcomes are recorded in the trust store and
   feedback tracker. The context predictor updates token counts.

3. **Per message**: Token growth is tracked. When predicted usage crosses
   70% of the context window, a preemptive compaction warning is issued.

4. **System prompt**: The orchestrator aggregates trust hints, feedback
   injections, and context warnings into system prompt additions.

## Running the Demo

```bash
bun run src/innovations/demo.ts
```

The demo simulates a conversation with tool calls covering all subsystems:
- Builds trust through 5 successful file reads
- Triggers feedback patterns with 3 failed edits
- Tracks token growth across 8 conversation turns
- Two agents share knowledge through the mesh
- Queries whether `Bash(git commit)` should be auto-allowed
- Shows model routing decisions for varying complexity levels

## API Reference

### InnovationOrchestrator

Central integration class. Wires all subsystems together.

```typescript
constructor(config: OrchestratorConfig)
initialize(): void
onToolExecutionStart(toolName, input): PreToolResult
onToolExecutionComplete(toolName, input, output, success, error?): void
onNewMessage(message, tokenCount): PreemptiveCompactDecision
getSystemPromptAdditions(): string[]
getStatus(): OrchestratorStatus
shutdown(): void
```

### TrustStore / TrustPolicy

Persistent score storage with time-decay. Policy maps scores to
allow/ask/deny behaviors with anomaly detection for new workspaces.

### ContextPredictor / SelectiveCompactor

Sliding-window growth rate tracker. Predicts whether token usage will
exceed thresholds within N turns. Compactor selects low-priority messages.

### KnowledgeGraph / AgentBus / MeshCoordinator

Shared knowledge graph with async locking. Event bus for inter-agent
messaging. Coordinator manages work distribution and conflict resolution.

### ComplexityAnalyzer / RoutingPolicy / ModelRouter

Heuristic complexity scoring (0-100). Policy maps scores to model tiers
with fallback chains. Router orchestrates local/cloud execution with
automatic escalation.

### ToolFeedbackSystem

Facade over ExecutionTracker, FailureAnalyzer, and AdaptivePromptInjector.
Records tool outcomes, detects failure patterns, and produces targeted
prompt injections with TTL-based lifecycle.

### EmbeddingStore

Local TF-IDF vector store with cosine similarity search. Supports
persistence, LRU eviction by importance/recency, and filtered queries.

### SessionBroker

Collaboration session lifecycle: create, join, leave, participant tracking,
and approval queues for restricted sessions.

## Module Locations

```
src/innovations/
  index.ts                  # Master re-export
  orchestrator.ts           # Integration layer
  demo.ts                   # Runnable demo
  trust-escalation/         # Module 1
  predictive-context/       # Module 2
  agent-mesh/               # Module 3
  model-router/             # Module 4
  tool-feedback/            # Module 5
  episodic-memory/          # Module 6
  realtime-collab/          # Module 7
```

## Future Work

- **Trust persistence sharing**: Sync trust scores across machines via
  cloud storage for teams using shared workspaces.
- **Feedback-to-trust bridge**: Repeated feedback patterns could
  automatically lower trust scores for specific tool/pattern combos.
- **Agent mesh persistence**: Auto-save knowledge graph to disk on
  agent disconnect, reload on reconnect.
- **Model router telemetry**: Collect latency/cost data from real
  executions to refine routing thresholds dynamically.
- **Episodic memory integration**: Feed tool execution summaries into
  episodic memory for cross-session recall.
- **Real-time collab + trust**: Shared sessions could inherit the
  union of participant trust profiles.
- **Context predictor + feedback**: Use feedback failure rates to
  adjust predicted growth (failed tools tend to retry, inflating tokens).
