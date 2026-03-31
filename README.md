# Open Claude Code

> Community-driven innovation on top of the Claude Code architecture.

---

## What is this?

This project takes the [publicly exposed Claude Code source snapshot](https://x.com/Fried_rice/status/2038894956459290963) (leaked via npm source map on 2026-03-31) and uses it as a foundation for **open research, experimentation, and innovation** in agentic CLI tooling.

We are **not** claiming ownership of Anthropic's code. This is an educational and research fork focused on pushing the boundaries of what developer-facing AI agents can do.

---

## Innovation Roadmap

| # | Innovation | Status | Description |
|---|---|---|---|
| 1 | **Progressive Trust Escalation** | Planned | Behavioral permission scoring that learns per-workspace trust over time |
| 2 | **Predictive Context Management** | Planned | Proactive compaction with semantic priority ranking instead of reactive truncation |
| 3 | **Agent Mesh with Shared Knowledge** | Planned | Multi-agent shared knowledge graph, conflict resolution, dynamic rebalancing |
| 4 | **Hybrid Local/Cloud Model Routing** | Planned | Route simple tasks to local models, complex reasoning to cloud APIs |
| 5 | **Tool Failure Feedback Loop** | Planned | Adaptive prompting based on recent tool execution telemetry |
| 6 | **Structured Episodic Memory** | Planned | Vector-indexed memory with cross-project transfer learning |
| 7 | **Real-time Collaboration** | Planned | Multi-user shared Claude sessions |

See [ARCHITECTURE_REPORT.md](./ARCHITECTURE_REPORT.md) for the full technical deep-dive of the original codebase.

---

## Original Architecture

- **~1,900 files**, 512,000+ lines of TypeScript
- **Runtime**: Bun
- **Terminal UI**: React + Ink (Yoga flexbox)
- **CLI**: Commander.js
- **Validation**: Zod v4
- **Protocols**: MCP, LSP
- **API**: Anthropic SDK
- **Feature Flags**: GrowthBook (compile-time via `bun:bundle` + runtime)

### Key Subsystems

```
src/
  query.ts              # Main query loop (async generator, tool execution, compaction)
  QueryEngine.ts        # LLM orchestration engine
  Tool.ts               # Tool type system
  tools/                # 40+ tool implementations
  commands/             # 50+ slash commands
  components/           # 140+ Ink/React UI components
  bridge/               # IDE integration (VS Code, JetBrains)
  coordinator/          # Multi-agent orchestration
  services/mcp/         # Model Context Protocol
  plugins/              # Plugin architecture
  skills/               # Reusable workflow system
  memdir/               # Persistent memory
  hooks/                # Permission system + React hooks
  vim/                  # Full vim mode state machine
  voice/                # Voice input (STT)
  buddy/                # Companion sprite system
  remote/               # Remote CCR sessions
  server/               # Server mode
  tasks/                # 7 task types
  keybindings/          # Chord-based keybinding system
```

---

## Getting Involved

This is an open research project. We welcome:

- Architecture analysis and documentation
- Proof-of-concept implementations of roadmap items
- Security research and vulnerability analysis
- Performance profiling and optimization ideas
- Novel agent interaction patterns

---

## Disclaimer

- The original Claude Code source is the property of **Anthropic**.
- This repository is **not affiliated with, endorsed by, or maintained by Anthropic**.
- This project exists for **educational and research purposes**.
- The source was publicly accessible via a source map exposure in the npm distribution.

---

## License

The original source code is proprietary to Anthropic. Innovations and additions by this project's contributors are shared for educational and research purposes under fair use.
