# Claude Code Architecture Report

**Prepared for:** Engineering Team  
**Source:** Claude Code source snapshot (TypeScript, exposed via npm source map leak 2026-03-31)  
**Scale:** ~1,902 files, 512,000+ lines of TypeScript  
**Runtime:** Bun | **UI:** React + Ink (terminal) | **CLI:** Commander.js | **Validation:** Zod v4

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Startup Sequence](#2-startup-sequence)
3. [Query Engine & API Pipeline](#3-query-engine--api-pipeline)
4. [Tool System](#4-tool-system)
5. [Permission & Security System](#5-permission--security-system)
6. [Bridge System (IDE Integration)](#6-bridge-system-ide-integration)
7. [Coordinator & Multi-Agent System](#7-coordinator--multi-agent-system)
8. [MCP (Model Context Protocol)](#8-mcp-model-context-protocol)
9. [Plugin Architecture](#9-plugin-architecture)
10. [Skill System](#10-skill-system)
11. [Memory System](#11-memory-system)
12. [UI Layer](#12-ui-layer)
13. [State Management](#13-state-management)
14. [Command System](#14-command-system)
15. [Configuration & Settings](#15-configuration--settings)
16. [Service Layer](#16-service-layer)
17. [Subsystems](#17-subsystems)
18. [Cross-Cutting Patterns](#18-cross-cutting-patterns)
19. [File Reference Index](#19-file-reference-index)

---

## 1. System Overview

Claude Code is Anthropic's CLI for interacting with Claude from the terminal. It performs software engineering tasks: editing files, running commands, searching codebases, and coordinating multi-agent workflows.

### Tech Stack

| Category | Technology |
|---|---|
| Runtime | Bun |
| Language | TypeScript (strict) |
| Terminal UI | React + Ink (Yoga flexbox layout) |
| CLI Parsing | Commander.js (extra-typings) |
| Schema Validation | Zod v4 |
| Code Search | ripgrep |
| Protocols | MCP SDK, LSP |
| API | Anthropic SDK |
| Telemetry | OpenTelemetry + gRPC |
| Feature Flags | GrowthBook |
| Auth | OAuth 2.0, JWT, macOS Keychain |

### High-Level Architecture

```
CLI Entry (cli.tsx)
  -> Parallel Prefetch (MDM, Keychain, GrowthBook)
  -> Init (config, env vars, telemetry, trust dialog)
  -> Main (migrations, CLI parsing, bootstrap)
  -> REPL Launcher
       -> React/Ink Renderer
            -> <App> (FpsMetrics > Stats > AppState > REPL)
                 -> PromptInput (vim mode, typeahead, keybindings)
                 -> Messages (virtual list, grouped tool use)
                 -> Spinner (animation, teammate status)
                 -> StatusLine (model, tokens, rate limits)
                 -> Permission Dialogs
```

### Directory Map

```
src/
  main.tsx              # Entrypoint (Commander.js CLI + React/Ink renderer)
  commands.ts           # Command registry (~25K lines)
  tools.ts              # Tool registry
  Tool.ts               # Tool type definitions (~29K lines)
  QueryEngine.ts        # LLM query engine (~46K lines)
  query.ts              # Main query loop (async generator)
  context.ts            # System/user context collection
  cost-tracker.ts       # Token cost tracking

  commands/             # ~50 slash command implementations
  tools/                # ~40 agent tool implementations
  components/           # ~140 Ink UI components
  hooks/                # React hooks + permission system
  services/             # External service integrations
    api/                # Anthropic API client, retry logic
    mcp/                # Model Context Protocol
    oauth/              # OAuth 2.0 flow
    lsp/                # Language Server Protocol
    analytics/          # GrowthBook feature flags
    compact/            # Conversation compaction
    extractMemories/    # Automatic memory extraction
  bridge/               # IDE bridge (VS Code, JetBrains)
  coordinator/          # Multi-agent orchestration
  plugins/              # Plugin system
  skills/               # Skill system
  memdir/               # Persistent memory
  state/                # State management
  types/                # TypeScript type definitions
  utils/                # Utility functions (~100 files)
  schemas/              # Zod schemas
  migrations/           # Config migrations (11 migrations)
  entrypoints/          # Initialization logic
  screens/              # Full-screen UIs (REPL, Doctor, Resume)
  remote/               # Remote CCR sessions
  server/               # Server mode (direct connect)
  tasks/                # Task management (7 task types)
  keybindings/          # Keybinding system (chords, contexts)
  vim/                  # Vim mode (full state machine)
  voice/                # Voice input (hold-to-talk STT)
  buddy/                # Companion sprite (18 species, 5 rarities)
  ink/                  # Ink renderer wrapper + hooks
  native-ts/            # Pure-TS Yoga layout engine
  outputStyles/         # Custom output styles
  upstreamproxy/        # Container proxy relay
```

---

## 2. Startup Sequence

The startup is aggressively optimized with parallel prefetching and lazy loading.

### Phase 1: CLI Entry (`src/entrypoints/cli.tsx`)

- Set process environment (`COREPACK_ENABLE_AUTO_PIN=0`, heap sizing)
- **Fast-path detection**: `--version`, `--dump-system-prompt`, `--daemon-worker`, etc. exit before full module loading
- `--worktree --tmux` fast-path: exec before full CLI load

### Phase 2: Early Side Effects (`src/main.tsx`, lines 1-20)

Three side effects fire **before** the remaining ~135ms of module imports:

```typescript
profileCheckpoint('main_tsx_entry');    // Mark entry time
startMdmRawRead();                      // Fire MDM subprocesses (plutil/reg query)
startKeychainPrefetch();                // Prefetch OAuth + legacy API key from keychain
```

### Phase 3: Init Function (`src/entrypoints/init.ts`)

Sequence (memoized, runs once):

1. `enableConfigs()` - Validate `~/.claude.json`
2. `applySafeConfigEnvironmentVariables()` - Only trusted sources, before trust dialog
3. `applyExtraCACertsFromConfig()` - Must happen before first TLS handshake (Bun caches via BoringSSL)
4. `setupGracefulShutdown()` - Cleanup handlers
5. 1P Event Logging initialization (lazy import of OpenTelemetry)
6. `populateOAuthAccountInfoIfNeeded()` (async)
7. `initJetBrainsDetection()` (async)
8. `detectCurrentRepository()` (async)
9. Remote settings + policy limits (early promise)
10. `recordFirstStartTime()`
11. `configureGlobalMTLS()` - Mutual TLS for enterprise
12. `configureGlobalAgents()` - Proxy/mTLS HTTP agents
13. `preconnectAnthropicApi()` - Fire-and-forget TCP+TLS handshake (~100-200ms overlap)
14. Upstream proxy (CCR only, lazy import, fail-open)
15. LSP manager cleanup registration
16. Session teams cleanup registration
17. Scratchpad directory creation

### Phase 4: Main Setup (`src/main.tsx`)

1. Run 11 config migrations
2. Initialize GrowthBook (feature flags)
3. Parse CLI flags and options
4. Load bootstrap data from API
5. Trust dialog (if needed)
6. Initialize tool permissions context
7. Load plugins and skills
8. MCP server initialization
9. AppState store creation
10. Launch REPL

### Startup Profiling (`src/utils/startupProfiler.ts`)

- **Sampled logging**: 100% Anthropic users, 0.5% external users
- **Detailed profiling**: `CLAUDE_CODE_PROFILE_STARTUP=1` writes to `~/.claude/cache/profiling/`
- Checkpoints: `cli_entry` -> `main_tsx_imports_loaded` -> `init_function_start` -> `init_function_end` -> `main_after_run`

---

## 3. Query Engine & API Pipeline

### Main Loop (`src/query.ts`)

The core is an **async generator** yielding streaming events:

```typescript
async function* query(params): AsyncGenerator<Event, ReturnValue>
```

**Per-turn flow:**

```
queryLoop(params)
  |-- buildQueryConfig()           // Snapshot immutable env/statsig/session state
  |-- startRelevantMemoryPrefetch() // Fire-and-forget memory loading
  |-- buildSystemInitMessage()     // System capabilities message
  |
  |-- MAIN LOOP (while not completed):
  |    |-- Auto-compact if context > 80% window
  |    |-- Check token budget (continue/stop decision)
  |    |
  |    |-- API CALL PHASE:
  |    |    |-- queryModelWithStreaming()
  |    |    |-- Stream: message_start -> content_block_delta -> message_delta
  |    |    |-- Handle errors (image validation, max output tokens recovery)
  |    |
  |    |-- TOOL EXECUTION PHASE (if tool_use blocks):
  |    |    |-- partitionToolCalls()     // Split into concurrent/serial batches
  |    |    |-- runToolsConcurrently()   // Read-only tools (max concurrency: 10)
  |    |    |-- runToolsSerially()       // Write tools (state-modifying)
  |    |    |-- Collect tool_result -> user message -> loop
  |    |
  |    |-- STOP HOOK PHASE:
  |    |    |-- executeStopHooks()       // Memory extraction, prompt suggestion
  |    |
  |    |-- CONTINUATION DECISION:
  |         |-- Check stop_reason, token budget, max turns
  |
  |-- Return: 'completed' | 'aborted_tools' | 'hook_stopped' | 'max_turns'
```

**Streaming tool execution**: When `tengu_streaming_tool_execution2` feature flag is on, tools execute *as they arrive* from the stream (before full message completes).

### Retry Logic (`src/services/api/withRetry.ts`)

| Parameter | Value |
|---|---|
| Max retries | 10 |
| Base delay | 500ms, exponential to 32s cap |
| Jitter | 0-25% random |
| 429 (rate limit) | Honors `Retry-After` header |
| 529 (overload) | Max 3 retries foreground; non-foreground bails immediately |
| Fast mode fallback | Falls back to standard speed on 429/529 |
| Unattended sessions | Retries indefinitely with chunked sleep + keep-alive |

### Thinking Mode (`src/utils/thinking.ts`)

Three configurations:

| Mode | Behavior |
|---|---|
| `adaptive` | Model decides when to think (Claude 4.6+ only) |
| `enabled` + `budgetTokens` | Always think with token budget |
| `disabled` | No thinking blocks |

- Enabled by default; overridable via `MAX_THINKING_TOKENS` env var or `alwaysThinkingEnabled` setting
- Thinking blocks preserved across full tool-use trajectory

### Context Compaction (4 strategies)

| Strategy | Trigger | Behavior |
|---|---|---|
| **Auto-compact** | Context > 80% window | Summarize old messages, preserve last 50K output tokens |
| **Snip** | Feature-gated | Remove old messages entirely |
| **Microcompact** | Always | Inline dedup + advisory block removal, LRU-cached tool results |
| **Reactive** | Experimental | Aggressive context collapse |

**Compaction prompt** generates structured summaries with sections: Primary Request, Key Technical Concepts, Files & Code, Errors & Fixes, Problem Solving, All User Messages, Pending Tasks, Current Work, Optional Next Step.

**Post-compact restoration**: Up to 5 files (5K tokens each) and 5 skills (5K tokens each) restored after compaction.

**Circuit breaker**: Max 3 consecutive auto-compact failures before giving up (saves ~250K API calls/day globally).

### Cost Tracking (`src/cost-tracker.ts`)

- Per-message usage tracking: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- Session-level accumulation with per-model breakdowns
- Advisor tool costs tracked recursively
- Persisted to project config for session resume

---

## 4. Tool System

### Tool Interface (`src/Tool.ts`, lines 362-695)

Every tool is built with `buildTool(def)`:

```typescript
buildTool({
  name: string,
  inputSchema: ZodSchema,

  // Lifecycle (in order)
  validateInput(input, ctx) -> ValidationResult,     // Semantic checks (before permissions)
  checkPermissions(input, ctx) -> PermissionResult,   // Allow/Ask/Deny/Passthrough
  call(args, ctx, canUseTool, parent, onProgress),    // Execution

  // Classification
  isConcurrencySafe(input) -> boolean,   // Default: false (fail-closed)
  isReadOnly(input) -> boolean,          // Default: false (assume writes)
  isDestructive(input) -> boolean,

  // Security
  preparePermissionMatcher(input),       // Pattern matcher for hook rules
  toAutoClassifierInput(input),          // Compact repr for bash classifier

  // UI
  renderToolUseMessage(input),
  renderToolResultMessage(content),
  getActivityDescription(input),         // Spinner: "Reading foo.ts"
  userFacingName(input),
  getToolUseSummary(input),
})
```

### Tool Registry (`src/tools.ts`)

- `getAllBaseTools()` (lines 192-251): Exhaustive list with feature-gated conditionals
- `getTools(ctx)` (lines 271-327): Applies deny rules, SIMPLE mode filtering
- `assembleToolPool()` (lines 345-367): Merges built-in + MCP tools, deduplicates (built-ins win)

**SIMPLE mode** (`--bare`): Only BashTool, FileReadTool, FileEditTool.

### Tool Inventory

| Tool | Description | Concurrency |
|---|---|---|
| BashTool | Shell execution | Serial |
| FileReadTool | File reading (images, PDFs, notebooks) | Concurrent |
| FileWriteTool | File creation/overwrite | Serial |
| FileEditTool | Partial file modification | Serial |
| GlobTool | File pattern search | Concurrent |
| GrepTool | ripgrep content search | Concurrent |
| WebFetchTool | URL content fetching | Concurrent |
| WebSearchTool | Web search | Concurrent |
| AgentTool | Sub-agent spawning | Serial |
| SkillTool | Skill execution | Serial |
| MCPTool | MCP server tool invocation | Varies |
| LSPTool | Language Server Protocol | Concurrent |
| NotebookEditTool | Jupyter notebook editing | Serial |
| TaskCreateTool / TaskUpdateTool | Task management | Serial |
| SendMessageTool | Inter-agent messaging | Serial |
| TeamCreateTool / TeamDeleteTool | Team agent management | Serial |
| EnterPlanModeTool / ExitPlanModeTool | Plan mode toggle | Serial |
| EnterWorktreeTool / ExitWorktreeTool | Git worktree isolation | Serial |
| ToolSearchTool | Deferred tool discovery | Concurrent |
| CronCreateTool | Scheduled trigger creation | Serial |
| RemoteTriggerTool | Remote trigger | Serial |
| SleepTool | Proactive mode wait | N/A |
| SyntheticOutputTool | Structured output generation | Serial |

### AgentTool: Sub-agent Spawning (`src/tools/AgentTool/`)

Two spawn modes:

**1. Named subagent** (`subagent_type: 'explore'|'plan'|etc.`):
- Fresh agent with its own system prompt and tool set
- Inherits parent's permission context
- Creates new `AppState`, overrides `setAppState`

**2. Fork** (no `subagent_type`, feature-gated):
- Child gets parent's **exact conversation history**
- Byte-identical prompt prefix -> **prompt cache sharing** across forks
- Runs with `permissionMode: 'bubble'` (prompts shown to parent)
- Recursive forks blocked via `<fork-boilerplate-tag>` detection

---

## 5. Permission & Security System

### Permission Flow

```
validateInput()              <- Semantic checks (file exists? old_string found?)
       |
checkPermissions()           <- Returns Allow/Ask/Deny/Passthrough
       |
PermissionContext             <- Runs hooks, classifier, shows UI dialog
       |
call()                       <- Actual execution
```

### Permission Modes

| Mode | Behavior |
|---|---|
| `default` | Show prompts for uncertain operations |
| `plan` | Plan dialog, then auto-approve/deny based on plan |
| `auto` | Use AI classifier (gated by `TRANSCRIPT_CLASSIFIER` flag) |
| `bypassPermissions` | Skip all prompts |
| `acceptEdits` | Auto-approve file edits |
| `dontAsk` | Auto-deny (ask -> deny) |
| `bubble` | Subagents bubble prompts to parent |

### Permission Decision Types (`src/types/permissions.ts`)

```typescript
PermissionResult =
  | { behavior: 'allow', updatedInput?, userModified?, decisionReason? }
  | { behavior: 'ask', message, suggestions?, pendingClassifierCheck? }
  | { behavior: 'deny', message, decisionReason }
  | { behavior: 'passthrough', message, pendingClassifierCheck? }
```

**Decision reasons**: `rule` (matched allow/deny/ask rule), `mode` (permission mode default), `hook` (hook approved/denied), `classifier` (AI classifier), `safetyCheck` (pre-classifier check).

### Permission Rules

**Sources** (in priority order):
1. `policySettings` - Enterprise managed (highest)
2. `flagSettings` - CLI flags
3. `session` - Temporary session rule
4. `command` - Inline conversation rule
5. `userSettings` - `~/.claude/settings.json`
6. `projectSettings` - `.claude/settings.json`
7. `localSettings` - `.claude/settings.local.json`

**Rule matching** (`src/utils/permissions/shellRuleMatching.ts`):
- Exact: `Bash(npm install)`
- Prefix: `npm *` matches `npm install`, `npm run build`
- Wildcard: `git commit *` with `*` -> `.*` regex conversion
- Null-byte sentinels prevent regex injection

### Bash Security (`src/tools/BashTool/`)

**Two parsing strategies:**

1. **Tree-sitter AST** (`src/utils/bash/ast.ts`) - Modern, fail-closed:
   - Explicit allowlist of node types; anything unknown -> "too-complex" -> ask user
   - Returns `SimpleCommand[]` with resolved argv, env vars, redirects
   - Or `'too-complex'` for unknown shell constructs

2. **Legacy regex** (`src/tools/BashTool/bashSecurity.ts`) - Fallback:
   - Pattern-based detection of shell metacharacters, command substitution, dangerous variables
   - Git commit message parsing, heredoc validation, sed/ed command validation

**Compound command handling:**
- Splits on `&&`, `||`, `|`, `;`, `&`
- Prefix rules don't match compound commands (`cd *` won't match `cd /path && evil.py`)
- CD+Git cross-segment detection prevents fsmonitor bypass
- Continuation line handling: backslash-newline joins WITHOUT adding space

**Env var/wrapper stripping** (fixed-point iteration):
- Strips leading env vars: `FOO=bar command` -> matches `command:*`
- Strips safe wrappers: `timeout`, `time`, `nice`, `nohup`
- Strips output redirections: `python script.py > out` matches `python:*`

### Bash Classifier (Auto Mode)

- **YOLO Classifier** (`src/utils/permissions/yoloClassifier.ts`): Full transcript-based classification using Claude API
- **Bash Allow Classifier** (`src/utils/permissions/bashClassifier.ts`): Evaluates commands against user-defined prompt rules
- Runs **async**: Can auto-approve before user responds to permission dialog
- Returns `{ shouldBlock, reason, confidence: 'high'|'medium'|'low' }`

### Sandbox System (`src/tools/BashTool/shouldUseSandbox.ts`)

- User-configured excluded commands (convenience, **not a security boundary**)
- Dynamic GrowthBook exclusion list for Anthropic internal
- Fixed-point candidate generation: iteratively strips env vars and wrappers
- `dangerouslyDisableSandbox` still respects policy permission gates

### Permission Hooks (`src/hooks/toolPermission/`)

Three handlers:

1. **interactiveHandler.ts**: Shows React UI dialog, runs hooks + classifier in background
2. **swarmWorkerHandler.ts**: Headless subagent - bubbles to parent or auto-denies
3. **coordinatorHandler.ts**: Coordinates permissions across worker pool

Hook execution (`src/utils/hooks.ts`):
- `executePermissionRequestHooks()` - async generator
- Hooks can return `allow`, `deny`, `ask`, or `passthrough`
- `interrupt: true` on deny -> abort session via `abortController.abort()`

### Authentication

**OAuth 2.0** (`src/services/oauth/client.ts`):
- PKCE-based auth flow with `code_challenge_method: 'S256'`
- Token refresh with auto-store
- Profile info fetching and subscription detection

**Trusted Device** (`src/bridge/trustedDevice.ts`):
- Enrollment: POST `/auth/trusted_devices` (must be <10min after login)
- Storage: Secure keychain with 90-day rolling expiry
- Header: `X-Trusted-Device-Token` on bridge API calls

**JWT** (`src/bridge/jwtUtils.ts`):
- `createTokenRefreshScheduler()`: Proactive refresh 5min before expiry
- Max 3 consecutive refresh failures before giving up
- `decodeJwtExpiry()`: Parses exp claim (no signature verification - verification happens server-side)

---

## 6. Bridge System (IDE Integration)

### Architecture

Bidirectional communication layer connecting IDE extensions (VS Code, JetBrains) with the CLI.

Two variants:

| Variant | Transport | Discovery |
|---|---|---|
| v1 (Environment-based) | Environments API polling + WebSocket | `replBridge.ts` |
| v2 (Environment-less) | Direct OAuth -> worker JWT + SSE | `remoteBridgeCore.ts` |

### Session Lifecycle

```
1. IDE -> POST /v1/environments/bridge (register)
2. Bridge -> GET .../work/poll (10s timeout loop)
3. Server dispatches WorkResponse with encrypted WorkSecret
4. Bridge spawns child CLI process with SDK URL + access token
5. Child <-> session-ingress via WS/SSE
6. Permission flow: Child -> Bridge -> Server -> User -> Server -> Bridge -> Child
7. Activity tracking: Child JSON output -> Bridge extracts -> status display
8. Child exits -> Bridge acks work -> loop back to step 2
9. Bridge shuts down -> Deregister environment
```

### Spawn Modes

| Mode | Behavior |
|---|---|
| `single-session` | One session per cwd, bridge tears down when done |
| `worktree` | Persistent server, isolated git worktree per session |
| `same-dir` | Persistent server, sessions share cwd (can conflict) |

### Key Files

| File | Purpose |
|---|---|
| `bridgeMain.ts` | Orchestrates bridge lifecycle and shutdown |
| `replBridge.ts` (2406 lines) | Main work poll dispatch loop |
| `bridgeMessaging.ts` | Message routing + UUID deduplication |
| `sessionRunner.ts` | Child process spawning and activity tracking |
| `bridgeApi.ts` | API client with OAuth retry |
| `replBridgeTransport.ts` | Transport abstraction (v1 WS / v2 SSE+CCR) |
| `remoteBridgeCore.ts` | Environment-less bridge path |
| `types.ts` | WorkResponse, WorkSecret, BridgeConfig types |
| `workSecret.ts` | Base64url decoding, SDK URL construction |
| `jwtUtils.ts` | Token refresh scheduler |

### Transport Abstraction

Unified `ReplBridgeTransport` interface:
- **v1**: HybridTransport (WebSocket) for both reads and writes
- **v2**: SSETransport (reads with sequence numbers) + CCRClient (writes to `/worker/*`)

Message deduplication via `BoundedUUIDSet` ring buffer prevents echoes and SSE re-deliveries.

---

## 7. Coordinator & Multi-Agent System

### Coordinator Mode (`src/coordinator/coordinatorMode.ts`)

Enabled via `COORDINATOR_MODE` feature flag + `CLAUDE_CODE_COORDINATOR_MODE` env var.

The coordinator's **only tools** are:
- `AgentTool` - spawn new worker
- `SendMessageTool` - continue existing worker
- `TaskStopTool` - kill running worker
- `subscribe_pr_activity` / `unsubscribe_pr_activity` - GitHub events

Workers self-report via `<task-notification>` XML injected into coordinator's user messages. The coordinator **never** directly reads files or runs commands.

### Agent Swarm / Teammate System (`src/utils/swarm/`)

**Backend types:** `tmux`, `iterm2`, `in-process`

**Detection priority:**
1. Inside tmux -> use tmux
2. In iTerm2 with it2 CLI -> use iTerm2
3. Tmux available -> use tmux (external session)
4. Otherwise -> in-process (AsyncLocalStorage isolation)

**In-process teammates** (`src/utils/swarm/spawnInProcess.ts`):
- Same Node.js process, isolated via AsyncLocalStorage
- Deterministic `agentId` format
- AbortController-based cancellation

**Tmux teammates:**
- Separate processes with inherited CLI flags and env vars
- Team metadata persisted to `team.json`
- Pane management: create, hide, show, kill, rebalance

**Teammate context** (`src/utils/teammate.ts`):
- Priority: AsyncLocalStorage (in-process) > dynamicTeamContext (tmux)
- Functions: `getAgentId()`, `getAgentName()`, `isTeammate()`, `isTeamLead()`
- Idle wait pattern for shutdown coordination

---

## 8. MCP (Model Context Protocol)

### Transport Types

| Transport | Description |
|---|---|
| `stdio` | Local process via stdin/stdout |
| `sse` | HTTP Server-Sent Events |
| `http` | Streamable HTTP with custom transport |
| `ws` | WebSocket connection |
| `sdk` | Internal integration |
| `sse-ide` | IDE extension only |

### Client Management (`src/services/mcp/client.ts`, ~3300 lines)

- `ensureConnectedClient()`: Lazy-initialize/reuse MCP client
- `fetchToolsForClient()`: LRU-memoized tool fetch
- `fetchResourcesForClient()`: LRU-memoized resource fetch
- `fetchCommandsForClient()`: LRU-memoized prompt/skill fetch

**Tool timeout**: ~27.8 hours default (configurable via `MCP_TOOL_TIMEOUT`)  
**Description cap**: 2048 chars (handles OpenAPI servers dumping 15-60KB)  
**Auth cache**: TTL 15 minutes, serialized writes

### Configuration (`src/services/mcp/config.ts`)

**Config scopes**: `local`, `user`, `project`, `dynamic`, `enterprise`, `claudeai`, `managed`

**OAuth support**: PKCE-based with `clientId`, `authServerMetadataUrl`, XAA (Cross-App Access)

**Deduplication**:
- `getMcpServerSignature()`: Generates unique key per server
- `dedupPluginMcpServers()`: Manual wins over plugin; first plugin wins
- `dedupClaudeAiMcpServers()`: Connector dedup against enabled manual servers
- `unwrapCcrProxyUrl()`: Extracts original URL from CCR proxy for cross-proxy dedup

### Connection Management (`src/services/mcp/useManageMCPConnections.ts`)

- Max reconnect attempts: 5
- Backoff: 1s initial, 30s max
- Handles `ToolListChangedNotification`, `ResourceListChangedNotification`, `PromptListChangedNotification`
- Error deduplication by type+source+plugin

### Channel System (Feature-gated: `tengu_harbor`)

- MCP servers send `notifications/claude/channel` with content
- Wrapped in `<channel source="..." meta...>content</channel>` XML
- Permission replies: 5-letter challenge ID (25-char alphabet, ~9.8M space)
- Blocklist covers ~1,800 offensive substrings; FNV-1a hash retry on collision

### Internal Transports

- **InProcessTransport**: Linked pair for in-process MCP, async via `queueMicrotask()`
- **SdkControlTransport**: CLI<->SDK bridge wrapping MCP in control requests

---

## 9. Plugin Architecture

### Plugin System (`src/plugins/`)

**Plugin types:**
- **Built-in**: Ship with CLI, ID format `{name}@builtin`
- **Marketplace**: External, ID format `{name}@{marketplace}`

**LoadedPlugin structure**: manifest, path, source, enabled state, hooks config, MCP servers, LSP servers, commands, skills, agents, output styles

**Enablement**: User preference > plugin default > `true`

**Error types**: 14+ discriminated error types covering git auth, network, manifest parsing, MCP config, LSP config, hook loading, component loading

### Plugin Capabilities

Plugins can provide:
- Commands (slash commands)
- Skills (reusable workflows)
- Agents (agent definitions)
- Hooks (pre/post tool execution)
- MCP servers
- LSP servers
- Output styles

---

## 10. Skill System

### Loading Chain

```
Policy settings  -> <managed>/.claude/skills/
User settings    -> ~/.claude/skills/
Project settings -> .claude/skills/
Plugins          -> plugin-provided
Bundled          -> compiled into binary
```

### Skill Format

Skills are **markdown files with frontmatter**:

```yaml
---
displayName: "Review PR"
description: "Reviews a pull request"
allowedTools: ["Bash(gh:*)", "Read"]
model: "opus"
hooks: { ... }
argumentHint: "<PR number>"
---
<prompt content with $ARGUMENTS placeholder>
```

### Bundled Skills (`src/skills/bundledSkills.ts`)

- Registered via `registerBundledSkill(definition)`
- Support embedded files with lazy extraction
- Memoized prompt building
- Dead code eliminable via `feature()` guards

### Deduplication

Uses `realpath()` for filesystem-agnostic symlink resolution to detect duplicate skills.

---

## 11. Memory System

### Storage Layout

```
~/.claude/projects/<sanitized-git-root>/memory/
  MEMORY.md                  <- Index file (max 200 lines, always in context)
  user_role.md               <- Individual memories with frontmatter
  feedback_testing.md
  project_auth_rewrite.md
  logs/YYYY/MM/DD.md         <- Daily logs (assistant/dream mode)
```

### Memory Types

| Type | Purpose |
|---|---|
| `user` | Role, preferences, knowledge |
| `feedback` | Corrections and confirmed approaches |
| `project` | Codebase conventions, ongoing work |
| `reference` | Pointers to external systems |

### Memory File Format

```yaml
---
name: Memory Name
description: One-line description for relevance matching
type: user|feedback|project|reference
---
Content with optional **Why:** and **How to apply:** lines
```

### Relevance Selection (`src/memdir/findRelevantMemories.ts`)

Rather than keyword matching, a **Sonnet side-query** selects up to 5 most relevant memories:
1. Scan memory directory (readdir + frontmatter parse)
2. Sort by mtime (newest first), cap at 200 files
3. Send manifest + current query to Sonnet
4. Sonnet returns `selected_memories: string[]` (max 5)
5. Tool-exclusion logic prevents re-documenting actively-used tools

### Automatic Extraction (`src/services/extractMemories/`)

- Triggered at end of query loop (model's final response, no tool calls)
- Uses **fork pattern**: shares parent's prompt cache
- Mutual exclusivity per turn: main agent OR background extraction, not both
- Cursor tracking prevents re-processing old messages

### Security

- Rejects relative paths (`../`), root/near-root, drive roots, UNC paths
- NFC unicode normalization
- Null-byte protection
- Only trusted setting sources can override memory path

---

## 12. UI Layer

### Component Hierarchy

```
<FpsMetricsProvider>
  <StatsProvider>
    <AppStateProvider>
      <REPL>
        <Messages>
          <VirtualMessageList>              // Large conversation virtualization
            <Message>                       // Discriminated union renderer
              <UserTextMessage>
              <AssistantTextMessage>
              <AssistantThinkingMessage>
              <AssistantToolUseMessage>
              <GroupedToolUseContent>        // Collapsed tool groups
              <CollapsedReadSearchContent>
              <AdvisorMessage>
              <CompactBoundaryMessage>
        <Spinner>                           // 50ms animation, teammate tree
        <StatusLine>                        // Model, tokens, rate limits
        <PromptInput>                       // 1500+ lines
          <TextInput> / <VimTextInput>
          <PromptInputFooter>
          <Dialogs>                         // Model picker, search, history
```

All components compiled with **React Compiler** for automatic memoization.

### Key Components

**PromptInput** (`src/components/PromptInput/PromptInput.tsx`, 1500+ lines):
- Multi-mode: normal, bash, slash-command, vim
- Typeahead: command suggestions, channel completion, thinking triggers
- Keybindings: global + command-specific + chords
- Agent routing: swarm task input redirection
- History search, clipboard image paste, fast mode indicators

**Message** (`src/components/Message.tsx`):
- Discriminated union on `message.type`
- Sub-components: UserText, UserImage, UserToolResult, AssistantText, AssistantThinking, AssistantRedactedThinking, AssistantToolUse, Advisor, Attachment, CompactBoundary

**Spinner** (`src/components/Spinner.tsx`):
- 50ms animation frame rate
- `TeammateSpinnerTree` for swarm task visualization
- Respects `prefersReducedMotion` setting

### Ink Renderer (`src/ink/`)

Custom wrapper around Ink with:
- `useInput()`: Raw mode capture with `stopImmediatePropagation()`
- `useAnimationFrame(intervalMs)`: Clock-synced, pauses offscreen
- `RawAnsi.tsx`: Direct ANSI escape code rendering
- Pure-TS Yoga layout engine (`src/native-ts/yoga-layout/`, 2500+ lines)

---

## 13. State Management

### Store Pattern (`src/state/store.ts`, 35 lines)

```typescript
createStore<T>(initialState, onChange?) -> {
  getState: () -> T,
  setState: (updater: (prev) -> T) -> void,
  subscribe: (listener) -> unsubscribe
}
```

- `Object.is` check prevents no-op updates
- Single `onChange` callback for side-effect dispatch

### AppState (`src/state/AppStateStore.ts`)

Major state sections:

| Section | Contents |
|---|---|
| Settings | Model, permissions, output style |
| UI | Verbose, expanded view, footer selection, brief mode |
| Model | mainLoopModel, toolPermissionContext |
| Agent | Agent name, KAIROS mode, remote status |
| Bridge | Connection state, session ID, session URL |
| Tasks | `{ [taskId]: TaskState }` (mutable carve-out) |
| MCP | Server connections, tools, commands, resources |
| Plugins | Enabled/disabled plugins, errors, installation |
| Companion | Reaction state, pet interaction |

### State Change Handler (`src/state/onChangeAppState.ts`)

Centralized side-effect dispatcher:
- Permission mode sync (CCR/SDK notification)
- Model override persistence
- View expansion caching
- Settings change -> clear auth caches, re-apply env vars

### Selectors (`src/state/selectors.ts`)

Pure data-extraction functions:
- `getViewedTeammateTask()` - Returns in-process teammate task if viewing
- `getActiveAgentForInput()` - Routes input to: `'leader'` | `'viewed'` teammate | `'named_agent'`

---

## 14. Command System

### Command Types

```typescript
type Command = {
  type: 'prompt'      // AI-driven (sent to model with prompt)
       | 'local'      // Deterministic (no AI)
       | 'local-jsx'  // React component
  source: 'builtin' | 'plugin' | 'managed' | 'mcp' | 'bundled'
  allowedTools: string[]         // Regex patterns for tool permission scope
  progressMessage: string        // Spinner text
  getPromptForCommand(): ContentBlockParam[]
}
```

### Registration (`src/commands.ts`)

- ~110 core commands imported statically
- Feature-gated imports via `feature()` from `bun:bundle`:
  - `proactive`, `briefCommand`, `assistantCommand` (KAIROS)
  - `voiceCommand` (VOICE_MODE)
  - `forkCmd`, `buddy`, `peersCmd` (agent/swarm)
- Heavy modules wrapped in lazy shims (e.g., `usageReport` at 113KB)

### Notable Commands

**`/commit`** (`src/commands/commit.ts`):
- Tool allowlist: `Bash(git add:*)`, `Bash(git status:*)`, `Bash(git commit:*)`
- Injects live `git status` and `git diff HEAD` via shell execution
- Enforces: no `--amend` without explicit request, no `--no-verify`, no empty commits

**`/review`** (`src/commands/review.ts`):
- Local variant: Uses `gh pr list/view/diff`
- Ultrareview variant (CCR): Feature-gated remote review with overage dialogs

**`/compact`** (`src/commands/compact/index.ts`):
- Type: `local` (deterministic, no AI)
- Disableable via `DISABLE_COMPACT` env var

---

## 15. Configuration & Settings

### Configuration Hierarchy

| Priority | Source | Location |
|---|---|---|
| 1 (highest) | Policy | Remote API / MDM / managed-settings.json |
| 2 | CLI flags | `--settings` flag or SDK inline |
| 3 | Session | Temporary session rules |
| 4 | User | `~/.claude/settings.json` |
| 5 | Project | `.claude/settings.json` |
| 6 (lowest) | Local | `.claude/settings.local.json` |

### Settings Schema (`src/utils/settings/types.ts`, 1148 lines)

Validated with Zod. Key sections:

- **Permissions**: allow/deny/ask rule arrays, defaultMode, additionalDirectories
- **Hooks**: 4 hook types (command, prompt, http, agent) with timeout, statusMessage, once, async
- **MCP Servers**: Per-server config with transport, auth, OAuth
- **Environment**: Key-value string pairs
- **Model**: Model selection, effort, fast mode, thinking

### Environment Variable Application

**Two-phase approach:**

| Phase | Timing | Sources | Scope |
|---|---|---|---|
| Safe | Before trust dialog | User, flags, policy only | Allowlist (NODE_PATH, PATH, HOME, etc.) |
| Full | After trust accepted | All sources | All variables |

**Filters**: SSH tunnel vars, provider-managed vars, CCD spawn-env keys

### Migration System (`src/migrations/`, 11 files)

Pattern: Check if needed -> read old location -> write new location -> log event -> remove old

Current migrations include model upgrades (Sonnet 4.5->4.6, Opus->Opus-1M), config format changes, and feature flag resets.

`CURRENT_MIGRATION_VERSION = 11` stored in `globalConfig.migrationVersion`.

### Secure Storage

| Platform | Primary | Fallback |
|---|---|---|
| macOS | Keychain (security CLI) | Plain text |
| Linux | Plain text | - |
| Windows | Plain text | - |

Keychain prefetch fires at startup to avoid sequential ~65ms penalty.

---

## 16. Service Layer

### API Client (`src/services/api/client.ts`)

Supports multiple deployment options:
- Direct Anthropic API (`ANTHROPIC_API_KEY`)
- AWS Bedrock (SigV4 auth)
- Azure Foundry (Azure identity)
- Google Vertex AI (GCP credentials)

Default headers: `x-app: 'cli'`, `User-Agent`, `X-Claude-Code-Session-Id`, container/session IDs.

### Feature Flags (`src/services/analytics/growthbook.ts`)

- GrowthBook client with remote evaluation
- User attributes: id, sessionId, deviceID, platform, org, subscription, rateLimitTier
- Exposure logging dedup for hot path optimization
- Refresh listeners for long-lived config systems
- Catch-up registration for late subscribers

Notable flags: `PROACTIVE`, `KAIROS`, `BRIDGE_MODE`, `DAEMON`, `VOICE_MODE`, `AGENT_TRIGGERS`, `MONITOR_TOOL`, `COORDINATOR_MODE`, `BASH_CLASSIFIER`, `TRANSCRIPT_CLASSIFIER`, `TREE_SITTER_BASH_SHADOW`

### LSP Integration (`src/services/lsp/`)

- Singleton manager with extension-based server routing
- Server capabilities: diagnostics, hover, go-to-def, workspace/configuration
- File tracking: openFile, changeFile, saveFile, closeFile
- Process spawning with explicit spawn/error event handling
- Pending handler queues for pre-connection registration

### Token Estimation (`src/services/tokenEstimation.ts`)

- Multi-provider: Anthropic API, AWS Bedrock, Google Vertex
- Thinking block detection and budget constraints
- Tool search field stripping (removes 'caller', 'tool_reference')
- Lazy AWS SDK import (~279KB deferred)

---

## 17. Subsystems

### Vim Mode (`src/vim/`)

Complete state machine:

```
States: INSERT | NORMAL (idle | count | operator | operatorCount |
        operatorFind | operatorTextObj | find | g | operatorG | replace | indent)

Operators: d (delete), c (change), y (yank)
Motions: h, l, j, k, w, b, e, W, B, E, 0, ^, $
Text Objects: w, W (word), ", ', ` (quotes), (), [], {}, <> (brackets)
```

- `transition(state, input, ctx)`: Pure state machine dispatcher
- `resolveMotion(key, cursor, count)`: Pure position calculation
- Grapheme-aware text objects via `getGraphemeSegmenter()`
- Dot-repeat via `RecordedChange` persistent state
- MAX_VIM_COUNT = 10,000

### Voice Input (`src/voice/`)

- Hold-to-talk: record while key pressed, release to finalize
- STT via Anthropic `voice_stream` endpoint
- 20 languages supported (BCP-47 codes)
- Gated by GrowthBook `tengu_amber_quartz_disabled` + OAuth auth check

### Remote Sessions (`src/remote/`)

- `RemoteSessionManager`: WebSocket lifecycle management
- Reconnect: 2s delay, max 5 attempts, max 3 session-not-found retries
- Ping interval: 30s
- `sdkMessageAdapter`: SDK -> REPL message format conversion
- `remotePermissionBridge`: Synthetic permission dialogs for CCR requests

### Task System (`src/tasks/`)

7 task types (union type):
- `LocalShellTask`: Interactive prompt detection, stall watchdog (45s threshold)
- `LocalAgentTask`: Local subprocess agent
- `RemoteAgentTask`: Remote SDK agent
- `InProcessTeammateTask`: Teammate subagent
- `LocalWorkflowTask`: Workflow execution
- `MonitorMcpTask`: MCP server monitoring
- `DreamTask`: Memory consolidation (phases: starting, updating)

### Server Mode (`src/server/`)

- Direct-connect TCP server for persistent sessions
- Session states: starting -> running -> detached -> stopping -> stopped
- Persisted to `~/.claude/server-sessions.json`
- Multiple concurrent sessions with pooling

### Keybindings (`src/keybindings/`)

- 17 keybinding contexts (Global, Chat, Autocomplete, Confirmation, etc.)
- 100+ actions (`app:*`, `history:*`, `chat:*`, `voice:*`, etc.)
- Chord support: `ctrl+x ctrl+k` -> `chat:killAgents`
- Platform-specific defaults (alt+v on Windows, ctrl+v elsewhere)
- Reserved shortcuts: ctrl+c, ctrl+d cannot be rebound
- Custom bindings via `~/.claude/keybindings.json`

### Buddy Companion (`src/buddy/`)

Procedurally generated from user ID hash:
- 18 species (duck, dragon, octopus, robot, mushroom, etc.)
- 5 rarities: common (60%), uncommon (25%), rare (10%), epic (4%), legendary (1%)
- 6 eye types, 8 hat types, shiny variant
- 5 stats: DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK
- `mulberry32(seed)`: Seeded PRNG for deterministic generation
- Speech bubbles with 10s display, pet interaction with 2.5s heart animation

### Upstream Proxy (`src/upstreamproxy/`)

Container-side setup for CCR sessions:
- Reads session token from `/run/ccr/session_token`
- `prctl(PR_SET_DUMPABLE, 0)` via Bun FFI to block ptrace of heap
- Local CONNECT->WebSocket relay with Protobuf wire format
- Unlinks token file post-relay-confirmation
- Max chunk: 512KB, ping interval: 30s

### Output Styles (`src/outputStyles/`)

Custom markdown-based output styles from `.claude/output-styles/`:
- Frontmatter: name, description, keep-coding-instructions, force-for-plugin
- Memoized loading with cache clearing

---

## 18. Cross-Cutting Patterns

### Performance Optimization

| Pattern | Where | Benefit |
|---|---|---|
| Parallel prefetch | `main.tsx` lines 1-20 | MDM + keychain + GrowthBook fire before module evaluation |
| Dead code elimination | `feature('X')` guards | Bun strips entire subsystems at build time |
| Lazy module loading | `import()` for OpenTelemetry, gRPC, AWS SDK | Avoids ~400KB+ at startup |
| Prompt cache sharing | Fork subagents | Byte-identical prefix enables cache reuse |
| LRU-memoized MCP tools | `fetchToolsForClient()` | Avoids repeated tool discovery |
| Startup profiling | `startupProfiler.ts` | Phase timing with memory snapshots |

### Architecture Patterns

| Pattern | Where | Description |
|---|---|---|
| Async generators | query.ts, tools, bridge | Incremental yield-based streaming |
| Immutable config snapshots | `QueryConfig` | Consistent behavior across retries |
| Discriminated unions | Messages, Commands, Permissions, Tasks | Type-safe pattern matching |
| Feature flags (compile-time) | `feature()` from `bun:bundle` | Dead code elimination |
| Feature flags (runtime) | GrowthBook | Remote configuration |
| Pub-sub stores | `createStore()` | Simple state with `Object.is` diffing |
| AsyncLocalStorage isolation | In-process teammates | Context without globals |
| Memoize + explicit cache clear | context.ts, memdir, settings | One computation per session |
| Hook-based permission flow | PermissionContext | Extensible approval chain |
| Fail-closed security | Tree-sitter AST parsing | Unknown constructs -> ask user |

### Security Invariants

1. **Tree-sitter fail-closed**: Explicit node type allowlist; unknown -> "too-complex" -> ask user
2. **Compound command blocking**: Prefix rules don't match compound commands
3. **Null-byte sentinels**: Prevent regex injection in wildcard patterns
4. **Two-phase env vars**: Safe allowlist before trust dialog; full after
5. **Hook interrupt semantics**: `interrupt: true` on deny -> session abort
6. **Sandbox != excluded commands**: Exclusion is convenience; sandbox is the security boundary
7. **Trusted device enrollment**: Time-gated to <10min post-login
8. **prctl anti-ptrace**: Blocks same-UID process from reading heap (container security)

---

## 19. File Reference Index

### Core Engine

| File | Lines | Description |
|---|---|---|
| `src/main.tsx` | 4683 | CLI entrypoint, migrations, REPL launch |
| `src/query.ts` | 1600+ | Main query loop (async generator) |
| `src/QueryEngine.ts` | 46K+ | High-level orchestration, session persistence |
| `src/Tool.ts` | 29K+ | Tool type definitions and `buildTool()` |
| `src/tools.ts` | 367+ | Tool registry and filtering |
| `src/commands.ts` | 25K+ | Command registry |
| `src/context.ts` | 150+ | System/user context collection |
| `src/cost-tracker.ts` | 323+ | Token cost tracking |

### Services

| File | Lines | Description |
|---|---|---|
| `src/services/api/claude.ts` | 1027+ | Streaming API wrapper |
| `src/services/api/withRetry.ts` | 517 | Retry logic with exponential backoff |
| `src/services/api/client.ts` | 150+ | Multi-provider API client |
| `src/services/mcp/client.ts` | 3300+ | MCP client connection management |
| `src/services/mcp/config.ts` | 300+ | MCP server configuration |
| `src/services/compact/compact.ts` | 150+ | Conversation compaction |
| `src/services/compact/autoCompact.ts` | 150+ | Auto-compaction thresholds |
| `src/services/compact/prompt.ts` | 150+ | Compaction prompt templates |
| `src/services/lsp/manager.ts` | 150+ | LSP server management |
| `src/services/oauth/client.ts` | 500+ | OAuth 2.0 flow |
| `src/services/analytics/growthbook.ts` | 150+ | Feature flags |

### Security

| File | Lines | Description |
|---|---|---|
| `src/tools/BashTool/bashPermissions.ts` | 2621 | Bash permission checking |
| `src/tools/BashTool/bashSecurity.ts` | 2592 | Bash security classifier |
| `src/utils/bash/ast.ts` | 500+ | Tree-sitter AST parsing |
| `src/utils/permissions/shellRuleMatching.ts` | 154+ | Rule pattern matching |
| `src/utils/permissions/yoloClassifier.ts` | 200+ | Auto-mode classifier |
| `src/types/permissions.ts` | 324+ | Permission type system |
| `src/hooks/toolPermission/PermissionContext.ts` | 389 | Permission decision framework |

### Bridge & Coordinator

| File | Lines | Description |
|---|---|---|
| `src/bridge/replBridge.ts` | 2406 | Main bridge work dispatch |
| `src/bridge/bridgeApi.ts` | 300+ | Bridge API client |
| `src/bridge/sessionRunner.ts` | 400+ | Child process spawning |
| `src/bridge/remoteBridgeCore.ts` | 500+ | Environment-less bridge |
| `src/coordinator/coordinatorMode.ts` | 110 | Coordinator mode detection |
| `src/tools/AgentTool/runAgent.ts` | 1000+ | Agent spawning |
| `src/tools/AgentTool/forkSubagent.ts` | 150+ | Fork mechanism |

### State & Configuration

| File | Lines | Description |
|---|---|---|
| `src/state/store.ts` | 35 | Pub-sub store factory |
| `src/state/AppStateStore.ts` | 200+ | AppState type definition |
| `src/state/onChangeAppState.ts` | 172 | Centralized side-effect dispatch |
| `src/bootstrap/state.ts` | 257+ | Global session state |
| `src/utils/config.ts` | 1500+ | Configuration management |
| `src/utils/settings/settings.ts` | 600+ | Settings loading & merging |
| `src/utils/settings/types.ts` | 1148 | Zod schemas for settings |
| `src/entrypoints/init.ts` | 341 | Initialization sequence |
| `src/entrypoints/cli.tsx` | 299 | CLI bootstrap |

### UI

| File | Lines | Description |
|---|---|---|
| `src/components/App.tsx` | 56 | Provider nesting root |
| `src/components/Message.tsx` | 100+ | Message type renderer |
| `src/components/PromptInput/PromptInput.tsx` | 1500+ | Input component |
| `src/components/Spinner.tsx` | 150+ | Animation + teammate tree |
| `src/screens/REPL.tsx` | 722KB | Main conversation loop |

### Subsystems

| File | Lines | Description |
|---|---|---|
| `src/vim/transitions.ts` | 100+ | Vim state machine |
| `src/vim/types.ts` | 200 | Vim type definitions |
| `src/voice/voiceModeEnabled.ts` | 55 | Voice feature gate |
| `src/remote/RemoteSessionManager.ts` | 344 | Remote session lifecycle |
| `src/keybindings/defaultBindings.ts` | 100+ | Default keybinding map |
| `src/memdir/paths.ts` | 279 | Memory path resolution |
| `src/memdir/findRelevantMemories.ts` | 142 | Sonnet-based memory selection |
| `src/buddy/types.ts` | 149 | Companion type definitions |
| `src/upstreamproxy/upstreamproxy.ts` | 286 | Container proxy setup |
| `src/utils/swarm/spawnInProcess.ts` | 216 | In-process teammate spawning |

---

*This report was generated from static analysis of the Claude Code source snapshot. All line numbers and file paths reference the repository at `/home/ikaros/Documents/claude-code/`.*
