import { describe, test, expect, beforeEach } from "bun:test";
import { CacheAnalyzer, type CacheableSegment, type MessageLike } from "../cacheAnalyzer.js";
import { CacheStrategyOptimizer, type OptimizedLayout } from "../cacheStrategy.js";
import { CacheTelemetry } from "../cacheTelemetry.js";
import { createPromptCacheOptimizer } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSegment(
  overrides: Partial<CacheableSegment> & { id: string }
): CacheableSegment {
  return {
    content: "test content",
    tokenEstimate: 100,
    stability: "dynamic",
    category: "conversation_history",
    lastModified: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CacheAnalyzer
// ---------------------------------------------------------------------------

describe("CacheAnalyzer", () => {
  let analyzer: CacheAnalyzer;

  beforeEach(() => {
    analyzer = new CacheAnalyzer();
  });

  // --- Stability classification ---

  test("classifies system_prompt as static", () => {
    const seg = makeSegment({ id: "s1", category: "system_prompt" });
    expect(analyzer.classifyStability(seg)).toBe("static");
  });

  test("classifies tool_definitions as static", () => {
    const seg = makeSegment({ id: "s2", category: "tool_definitions" });
    expect(analyzer.classifyStability(seg)).toBe("static");
  });

  test("classifies memory as semi_static", () => {
    const seg = makeSegment({ id: "s3", category: "memory" });
    expect(analyzer.classifyStability(seg)).toBe("semi_static");
  });

  test("classifies context as semi_static", () => {
    const seg = makeSegment({ id: "s4", category: "context" });
    expect(analyzer.classifyStability(seg)).toBe("semi_static");
  });

  test("classifies conversation_history as dynamic", () => {
    const seg = makeSegment({ id: "s5", category: "conversation_history" });
    expect(analyzer.classifyStability(seg)).toBe("dynamic");
  });

  // --- analyzeMessage ---

  test("analyzeMessage extracts segment from system message", () => {
    const segments = analyzer.analyzeMessage({
      role: "system",
      content: "You are a helpful assistant.",
    });
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].category).toBe("system_prompt");
    expect(segments[0].stability).toBe("static");
  });

  test("analyzeMessage extracts segment from user message", () => {
    const segments = analyzer.analyzeMessage({
      role: "user",
      content: "Hello, how are you?",
    });
    expect(segments.length).toBe(1);
    expect(segments[0].category).toBe("conversation_history");
    expect(segments[0].stability).toBe("dynamic");
  });

  test("analyzeMessage extracts segment from assistant message", () => {
    const segments = analyzer.analyzeMessage({
      role: "assistant",
      content: "I am fine, thanks!",
    });
    expect(segments[0].category).toBe("conversation_history");
  });

  test("analyzeMessage handles tool type messages", () => {
    const segments = analyzer.analyzeMessage({
      type: "tool_definitions",
      content: '{"tools": []}',
    });
    expect(segments[0].category).toBe("tool_definitions");
    expect(segments[0].stability).toBe("static");
  });

  test("analyzeMessage handles memory messages", () => {
    const segments = analyzer.analyzeMessage({
      type: "memory",
      content: "User prefers TypeScript.",
    });
    expect(segments[0].category).toBe("memory");
    expect(segments[0].stability).toBe("semi_static");
  });

  test("analyzeMessage handles context messages", () => {
    const segments = analyzer.analyzeMessage({
      type: "context",
      content: "Current file: main.ts",
    });
    expect(segments[0].category).toBe("context");
  });

  test("analyzeMessage estimates tokens roughly correctly", () => {
    const content = "a".repeat(400); // ~100 tokens
    const segments = analyzer.analyzeMessage({
      role: "user",
      content,
    });
    expect(segments[0].tokenEstimate).toBe(100);
  });

  test("analyzeMessage splits large system prompts with tool markers", () => {
    // Content must be >500 chars to trigger splitting
    const preamble = "You are a helpful assistant. ".repeat(20);
    const content = preamble + "\n\n## Tools\n\nHere are the tools you can use...";
    const segments = analyzer.analyzeMessage({
      role: "system",
      content,
    });
    expect(segments.length).toBe(2);
    expect(segments[0].category).toBe("system_prompt");
    expect(segments[1].category).toBe("tool_definitions");
  });

  test("analyzeMessage generates unique ids", () => {
    const seg1 = analyzer.analyzeMessage({ role: "user", content: "hello" });
    const seg2 = analyzer.analyzeMessage({ role: "user", content: "world" });
    expect(seg1[0].id).not.toBe(seg2[0].id);
  });

  // --- getCacheablePrefix ---

  test("getCacheablePrefix puts static content first", () => {
    const segments = [
      makeSegment({ id: "conv", category: "conversation_history", stability: "dynamic" }),
      makeSegment({ id: "sys", category: "system_prompt", stability: "static" }),
      makeSegment({ id: "mem", category: "memory", stability: "semi_static" }),
    ];

    const { prefix, dynamic } = analyzer.getCacheablePrefix(segments);
    expect(prefix.length).toBe(2);
    expect(prefix[0].id).toBe("sys");
    expect(prefix[1].id).toBe("mem");
    expect(dynamic.length).toBe(1);
    expect(dynamic[0].id).toBe("conv");
  });

  test("getCacheablePrefix handles all-static segments", () => {
    const segments = [
      makeSegment({ id: "s1", stability: "static", category: "system_prompt" }),
      makeSegment({ id: "s2", stability: "static", category: "tool_definitions" }),
    ];
    const { prefix, dynamic } = analyzer.getCacheablePrefix(segments);
    expect(prefix.length).toBe(2);
    expect(dynamic.length).toBe(0);
  });

  test("getCacheablePrefix handles all-dynamic segments", () => {
    const segments = [
      makeSegment({ id: "d1", stability: "dynamic" }),
      makeSegment({ id: "d2", stability: "dynamic" }),
    ];
    const { prefix, dynamic } = analyzer.getCacheablePrefix(segments);
    expect(prefix.length).toBe(0);
    expect(dynamic.length).toBe(2);
  });

  // --- estimateCacheHitRate ---

  test("estimateCacheHitRate shows improvement when reordered", () => {
    const badOrder = [
      makeSegment({ id: "d1", stability: "dynamic", tokenEstimate: 500 }),
      makeSegment({ id: "s1", stability: "static", tokenEstimate: 500 }),
    ];
    const goodOrder = [
      makeSegment({ id: "s1", stability: "static", tokenEstimate: 500 }),
      makeSegment({ id: "d1", stability: "dynamic", tokenEstimate: 500 }),
    ];

    const result = analyzer.estimateCacheHitRate(badOrder, goodOrder);
    expect(result.currentRate).toBe(0); // dynamic first -> 0% prefix
    expect(result.optimizedRate).toBe(0.5); // static first -> 50% prefix
    expect(result.improvement).toBe(0.5);
  });

  test("estimateCacheHitRate returns 0 for empty segments", () => {
    const result = analyzer.estimateCacheHitRate([], []);
    expect(result.currentRate).toBe(0);
    expect(result.optimizedRate).toBe(0);
    expect(result.improvement).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CacheStrategyOptimizer
// ---------------------------------------------------------------------------

describe("CacheStrategyOptimizer", () => {
  let optimizer: CacheStrategyOptimizer;

  beforeEach(() => {
    optimizer = new CacheStrategyOptimizer();
  });

  test("optimize sorts segments by stability then category", () => {
    const segments = [
      makeSegment({ id: "conv", category: "conversation_history", stability: "dynamic", tokenEstimate: 100 }),
      makeSegment({ id: "ctx", category: "context", stability: "semi_static", tokenEstimate: 100 }),
      makeSegment({ id: "tools", category: "tool_definitions", stability: "static", tokenEstimate: 100 }),
      makeSegment({ id: "sys", category: "system_prompt", stability: "static", tokenEstimate: 200 }),
      makeSegment({ id: "mem", category: "memory", stability: "semi_static", tokenEstimate: 100 }),
    ];

    const layout = optimizer.optimize(segments);
    const ids = layout.segments.map((s) => s.id);

    // static first (system_prompt before tool_definitions, larger first within same cat)
    expect(ids.indexOf("sys")).toBeLessThan(ids.indexOf("tools"));
    // semi_static next
    expect(ids.indexOf("tools")).toBeLessThan(ids.indexOf("mem"));
    expect(ids.indexOf("mem")).toBeLessThan(ids.indexOf("ctx"));
    // dynamic last
    expect(ids.indexOf("ctx")).toBeLessThan(ids.indexOf("conv"));
  });

  test("optimize returns empty layout for empty input", () => {
    const layout = optimizer.optimize([]);
    expect(layout.segments.length).toBe(0);
    expect(layout.breakpoints.length).toBe(0);
    expect(layout.estimatedHitRate).toBe(0);
  });

  test("optimize records applied rules", () => {
    const layout = optimizer.optimize([
      makeSegment({ id: "s1", stability: "static", category: "system_prompt" }),
    ]);
    expect(layout.reorderingApplied.length).toBeGreaterThan(0);
    expect(layout.reorderingApplied).toContain("stability-first");
  });

  test("optimize calculates estimated hit rate", () => {
    const segments = [
      makeSegment({ id: "s1", stability: "static", tokenEstimate: 300 }),
      makeSegment({ id: "d1", stability: "dynamic", tokenEstimate: 100 }),
    ];
    const layout = optimizer.optimize(segments);
    expect(layout.estimatedHitRate).toBe(0.75); // 300 / 400
  });

  // --- detectBreakpoints ---

  test("detectBreakpoints finds stability transitions", () => {
    const segments = [
      makeSegment({ id: "s1", stability: "static", category: "system_prompt" }),
      makeSegment({ id: "s2", stability: "semi_static", category: "memory" }),
      makeSegment({ id: "d1", stability: "dynamic", category: "conversation_history" }),
    ];
    const breakpoints = optimizer.detectBreakpoints(segments);
    expect(breakpoints.length).toBe(2);
    expect(breakpoints[0].afterSegmentId).toBe("s1");
    expect(breakpoints[0].reason).toContain("static");
    expect(breakpoints[0].reason).toContain("semi_static");
  });

  test("detectBreakpoints finds category transitions within same stability", () => {
    const segments = [
      makeSegment({ id: "s1", stability: "static", category: "system_prompt" }),
      makeSegment({ id: "s2", stability: "static", category: "tool_definitions" }),
    ];
    const breakpoints = optimizer.detectBreakpoints(segments);
    expect(breakpoints.length).toBe(1);
    expect(breakpoints[0].afterSegmentId).toBe("s1");
    expect(breakpoints[0].reason).toContain("Category transition");
  });

  test("detectBreakpoints returns empty for uniform segments", () => {
    const segments = [
      makeSegment({ id: "d1", stability: "dynamic", category: "conversation_history" }),
      makeSegment({ id: "d2", stability: "dynamic", category: "conversation_history" }),
    ];
    const breakpoints = optimizer.detectBreakpoints(segments);
    expect(breakpoints.length).toBe(0);
  });

  test("detectBreakpoints returns empty for single segment", () => {
    const segments = [makeSegment({ id: "s1" })];
    expect(optimizer.detectBreakpoints(segments).length).toBe(0);
  });

  // --- compareLayouts ---

  test("compareLayouts picks higher hit rate", () => {
    const a: OptimizedLayout = {
      segments: [],
      breakpoints: [],
      estimatedHitRate: 0.8,
      reorderingApplied: [],
    };
    const b: OptimizedLayout = {
      segments: [],
      breakpoints: [],
      estimatedHitRate: 0.6,
      reorderingApplied: [],
    };
    const result = optimizer.compareLayouts(a, b);
    expect(result.winner).toBe("a");
    expect(result.hitRateDiff).toBeCloseTo(0.2);
  });

  test("compareLayouts picks b when it has higher hit rate", () => {
    const a: OptimizedLayout = {
      segments: [],
      breakpoints: [],
      estimatedHitRate: 0.3,
      reorderingApplied: [],
    };
    const b: OptimizedLayout = {
      segments: [],
      breakpoints: [],
      estimatedHitRate: 0.9,
      reorderingApplied: [],
    };
    const result = optimizer.compareLayouts(a, b);
    expect(result.winner).toBe("b");
  });

  test("compareLayouts handles tie by breakpoint count", () => {
    const a: OptimizedLayout = {
      segments: [],
      breakpoints: [{ afterSegmentId: "s1", reason: "x" }],
      estimatedHitRate: 0.5,
      reorderingApplied: [],
    };
    const b: OptimizedLayout = {
      segments: [],
      breakpoints: [
        { afterSegmentId: "s1", reason: "x" },
        { afterSegmentId: "s2", reason: "y" },
      ],
      estimatedHitRate: 0.5,
      reorderingApplied: [],
    };
    const result = optimizer.compareLayouts(a, b);
    expect(result.winner).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// CacheTelemetry
// ---------------------------------------------------------------------------

describe("CacheTelemetry", () => {
  let telemetry: CacheTelemetry;

  beforeEach(() => {
    telemetry = new CacheTelemetry();
  });

  test("getMetrics returns zeros when empty", () => {
    const m = telemetry.getMetrics();
    expect(m.totalRequests).toBe(0);
    expect(m.hitRate).toBe(0);
    expect(m.tokensSaved).toBe(0);
  });

  test("recordRequest increments request count", () => {
    telemetry.recordRequest(1000, 500, 200);
    telemetry.recordRequest(1000, 0, 0);
    expect(telemetry.requestCount).toBe(2);
  });

  test("getMetrics tracks cache hits and misses", () => {
    telemetry.recordRequest(1000, 500, 200); // hit
    telemetry.recordRequest(1000, 0, 300); // miss
    telemetry.recordRequest(1000, 800, 100); // hit

    const m = telemetry.getMetrics();
    expect(m.totalRequests).toBe(3);
    expect(m.cacheHits).toBe(2);
    expect(m.cacheMisses).toBe(1);
    expect(m.hitRate).toBeCloseTo(2 / 3);
  });

  test("getMetrics calculates tokens saved", () => {
    telemetry.recordRequest(1000, 500, 200);
    telemetry.recordRequest(1000, 300, 100);
    const m = telemetry.getMetrics();
    expect(m.tokensSaved).toBe(800);
  });

  test("getMetrics calculates average prefix length", () => {
    telemetry.recordRequest(1000, 500, 200); // prefix = 700
    telemetry.recordRequest(1000, 300, 100); // prefix = 400
    const m = telemetry.getMetrics();
    expect(m.avgPrefixLength).toBe(550); // (700+400)/2
  });

  test("getMetrics calculates breakpoint efficiency", () => {
    telemetry.recordRequest(1000, 800, 200); // reads / total = 800/1000
    const m = telemetry.getMetrics();
    expect(m.breakpointEfficiency).toBe(0.8);
  });

  test("getMetrics calculates cost saved", () => {
    telemetry.recordRequest(1000, 1000, 0);
    const m = telemetry.getMetrics();
    expect(m.costSaved).toBeGreaterThan(0);
  });

  // --- Time series ---

  test("getTimeSeries returns empty for no records", () => {
    expect(telemetry.getTimeSeries().length).toBe(0);
  });

  test("getTimeSeries buckets records correctly", () => {
    // All within the same 5-minute bucket
    telemetry.recordRequest(1000, 500, 200);
    telemetry.recordRequest(1000, 0, 0);
    telemetry.recordRequest(1000, 800, 100);

    const series = telemetry.getTimeSeries(5);
    expect(series.length).toBe(1);
    expect(series[0].hitRate).toBeCloseTo(2 / 3);
    expect(series[0].tokensSaved).toBe(1300);
  });

  // --- Trend ---

  test("getTrend returns stable for few records", () => {
    telemetry.recordRequest(100, 50, 20);
    expect(telemetry.getTrend()).toBe("stable");
  });

  test("getTrend detects improving trend", () => {
    // Early requests: all misses
    for (let i = 0; i < 12; i++) {
      telemetry.recordRequest(1000, 0, 500);
    }
    // Recent requests: all hits
    for (let i = 0; i < 4; i++) {
      telemetry.recordRequest(1000, 900, 100);
    }
    expect(telemetry.getTrend()).toBe("improving");
  });

  test("getTrend detects declining trend", () => {
    // Early requests: all hits
    for (let i = 0; i < 12; i++) {
      telemetry.recordRequest(1000, 900, 100);
    }
    // Recent requests: all misses
    for (let i = 0; i < 4; i++) {
      telemetry.recordRequest(1000, 0, 500);
    }
    expect(telemetry.getTrend()).toBe("declining");
  });

  // --- Cost savings ---

  test("getCostSavingsEstimate calculates correctly", () => {
    telemetry.recordRequest(1000, 500, 200);
    const priceInput = 0.000003;
    const priceCache = 0.0000003;

    const result = telemetry.getCostSavingsEstimate(priceInput, priceCache);
    expect(result.saved).toBeCloseTo(500 * (priceInput - priceCache));
    expect(result.couldSave).toBeCloseTo(1000 * (priceInput - priceCache));
    expect(result.couldSave).toBeGreaterThan(result.saved);
  });

  test("getCostSavingsEstimate returns zeros for no records", () => {
    const result = telemetry.getCostSavingsEstimate(0.000003, 0.0000003);
    expect(result.saved).toBe(0);
    expect(result.couldSave).toBe(0);
  });

  // --- Reset ---

  test("reset clears all data", () => {
    telemetry.recordRequest(1000, 500, 200);
    telemetry.recordRequest(1000, 800, 100);
    telemetry.reset();

    expect(telemetry.requestCount).toBe(0);
    const m = telemetry.getMetrics();
    expect(m.totalRequests).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Factory / Integration
// ---------------------------------------------------------------------------

describe("createPromptCacheOptimizer", () => {
  test("factory creates working optimizer", () => {
    const opt = createPromptCacheOptimizer();
    expect(opt.analyzer).toBeDefined();
    expect(opt.strategy).toBeDefined();
    expect(opt.telemetry).toBeDefined();
  });

  test("optimizeMessages processes message list", () => {
    const opt = createPromptCacheOptimizer();
    const messages: MessageLike[] = [
      { role: "user", content: "Hello" },
      { role: "system", content: "You are helpful." },
      { type: "memory", content: "User likes TS." },
    ];
    const layout = opt.optimizeMessages(messages);
    expect(layout.segments.length).toBeGreaterThanOrEqual(3);
    // System prompt should come first after optimization
    expect(layout.segments[0].category).toBe("system_prompt");
  });

  test("recordRequest and getMetrics work together", () => {
    const opt = createPromptCacheOptimizer();
    opt.recordRequest(1000, 500, 200);
    const m = opt.getMetrics();
    expect(m.totalRequests).toBe(1);
    expect(m.cacheHits).toBe(1);
  });

  test("getTrend works through factory", () => {
    const opt = createPromptCacheOptimizer();
    expect(opt.getTrend()).toBe("stable");
  });
});
