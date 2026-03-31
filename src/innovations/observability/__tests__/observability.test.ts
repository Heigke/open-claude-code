import { describe, test, expect, beforeEach } from "bun:test";
import { MetricsCollector } from "../metricsCollector";
import type { AggregatedMetric } from "../metricsCollector";
import { HealthChecker } from "../healthChecker";
import type { HealthStatus } from "../healthChecker";
import { AlertManager } from "../alertManager";
import type { AlertRule } from "../alertManager";
import { ConsoleExporter, PrometheusExporter, JsonFileExporter } from "../exporters";
import { createObservabilityStack } from "../index";
import { existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── MetricsCollector: Counters ───

describe("MetricsCollector - Counters", () => {
  let collector: MetricsCollector;
  beforeEach(() => { collector = new MetricsCollector(); });

  test("counter increments by 1 each call", () => {
    collector.counter("requests");
    collector.counter("requests");
    collector.counter("requests");
    const m = collector.getMetric("requests")!;
    expect(m.count).toBe(3);
    expect(m.sum).toBe(3);
  });

  test("counter with tags", () => {
    collector.counter("api.calls", { method: "GET" });
    collector.counter("api.calls", { method: "POST" });
    const m = collector.getMetric("api.calls")!;
    expect(m.count).toBe(2);
  });

  test("getMetric returns undefined for unknown metric", () => {
    expect(collector.getMetric("nonexistent")).toBeUndefined();
  });
});

// ─── MetricsCollector: Gauges ───

describe("MetricsCollector - Gauges", () => {
  let collector: MetricsCollector;
  beforeEach(() => { collector = new MetricsCollector(); });

  test("gauge records absolute values", () => {
    collector.gauge("cpu.usage", 45);
    collector.gauge("cpu.usage", 78);
    collector.gauge("cpu.usage", 32);
    const m = collector.getMetric("cpu.usage")!;
    expect(m.min).toBe(32);
    expect(m.max).toBe(78);
    expect(m.count).toBe(3);
  });

  test("gauge average calculation", () => {
    collector.gauge("memory", 100);
    collector.gauge("memory", 200);
    const m = collector.getMetric("memory")!;
    expect(m.avg).toBe(150);
  });
});

// ─── MetricsCollector: Histograms & Percentiles ───

describe("MetricsCollector - Histograms", () => {
  let collector: MetricsCollector;
  beforeEach(() => { collector = new MetricsCollector(); });

  test("histogram records distribution values", () => {
    for (let i = 1; i <= 100; i++) {
      collector.histogram("latency", i);
    }
    const m = collector.getMetric("latency")!;
    expect(m.count).toBe(100);
    expect(m.min).toBe(1);
    expect(m.max).toBe(100);
  });

  test("p50 is approximately the median", () => {
    for (let i = 1; i <= 100; i++) {
      collector.histogram("latency", i);
    }
    const m = collector.getMetric("latency")!;
    expect(m.p50).toBeGreaterThanOrEqual(49);
    expect(m.p50).toBeLessThanOrEqual(51);
  });

  test("p95 calculation", () => {
    for (let i = 1; i <= 100; i++) {
      collector.histogram("latency", i);
    }
    const m = collector.getMetric("latency")!;
    expect(m.p95).toBeGreaterThanOrEqual(94);
    expect(m.p95).toBeLessThanOrEqual(96);
  });

  test("p99 calculation", () => {
    for (let i = 1; i <= 100; i++) {
      collector.histogram("latency", i);
    }
    const m = collector.getMetric("latency")!;
    expect(m.p99).toBeGreaterThanOrEqual(98);
    expect(m.p99).toBeLessThanOrEqual(100);
  });

  test("single-value histogram returns that value for all percentiles", () => {
    collector.histogram("single", 42);
    const m = collector.getMetric("single")!;
    expect(m.p50).toBe(42);
    expect(m.p95).toBe(42);
    expect(m.p99).toBe(42);
    expect(m.avg).toBe(42);
  });
});

// ─── MetricsCollector: Timer ───

describe("MetricsCollector - Timer", () => {
  let collector: MetricsCollector;
  beforeEach(() => { collector = new MetricsCollector(); });

  test("timer measures duration within tolerance", async () => {
    const handle = collector.timer("operation");
    await new Promise((r) => setTimeout(r, 100));
    const elapsed = handle.stop();
    expect(elapsed).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(200);
    const m = collector.getMetric("operation")!;
    expect(m.count).toBe(1);
    expect(m.avg).toBeGreaterThan(50);
  });

  test("timer with tags", async () => {
    const handle = collector.timer("db.query", { table: "users" });
    await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    const m = collector.getMetric("db.query")!;
    expect(m.count).toBe(1);
  });
});

// ─── MetricsCollector: Flush & Sliding Window ───

describe("MetricsCollector - Flush & Retention", () => {
  let collector: MetricsCollector;
  beforeEach(() => { collector = new MetricsCollector(); });

  test("flush returns pending metrics and clears queue", () => {
    collector.counter("a");
    collector.gauge("b", 5);
    const flushed = collector.flush();
    expect(flushed.length).toBe(2);
    expect(flushed[0].name).toBe("a");
    expect(flushed[1].name).toBe("b");
    // Second flush returns empty
    expect(collector.flush().length).toBe(0);
  });

  test("flush preserves aggregation buffers", () => {
    collector.counter("x");
    collector.counter("x");
    collector.flush();
    // Buffers still have data for aggregation
    const m = collector.getMetric("x")!;
    expect(m.count).toBe(2);
  });

  test("sliding window retains at most 10000 points", () => {
    for (let i = 0; i < 10_500; i++) {
      collector.histogram("big", i);
    }
    const m = collector.getMetric("big")!;
    expect(m.count).toBe(10_000);
    // Should have kept the latest values (500..10499)
    expect(m.min).toBe(500);
    expect(m.max).toBe(10_499);
  });
});

// ─── MetricsCollector: Multiple Metrics Isolation ───

describe("MetricsCollector - Isolation", () => {
  test("metrics are isolated from each other", () => {
    const collector = new MetricsCollector();
    collector.counter("alpha");
    collector.counter("alpha");
    collector.gauge("beta", 99);
    collector.histogram("gamma", 7);

    expect(collector.getMetric("alpha")!.count).toBe(2);
    expect(collector.getMetric("beta")!.avg).toBe(99);
    expect(collector.getMetric("gamma")!.avg).toBe(7);
  });

  test("getAllMetrics returns all tracked metrics", () => {
    const collector = new MetricsCollector();
    collector.counter("a");
    collector.gauge("b", 1);
    collector.histogram("c", 2);
    const all = collector.getAllMetrics();
    expect(all.size).toBe(3);
    expect(all.has("a")).toBe(true);
    expect(all.has("b")).toBe(true);
    expect(all.has("c")).toBe(true);
  });
});

// ─── HealthChecker ───

describe("HealthChecker", () => {
  let checker: HealthChecker;
  beforeEach(() => { checker = new HealthChecker(); });

  test("registers and runs a healthy check", async () => {
    checker.registerCheck("test", () => ({
      name: "test",
      status: "healthy",
      message: "all good",
      lastCheck: 0,
    }));
    const results = await checker.runAll();
    expect(results.get("test")!.status).toBe("healthy");
  });

  test("overall health returns worst status", async () => {
    checker.registerCheck("ok", () => ({
      name: "ok", status: "healthy", message: "", lastCheck: 0,
    }));
    checker.registerCheck("bad", () => ({
      name: "bad", status: "unhealthy", message: "broken", lastCheck: 0,
    }));
    await checker.runAll();
    expect(checker.getOverallHealth()).toBe("unhealthy");
  });

  test("degraded is between healthy and unhealthy", async () => {
    checker.registerCheck("ok", () => ({
      name: "ok", status: "healthy", message: "", lastCheck: 0,
    }));
    checker.registerCheck("warn", () => ({
      name: "warn", status: "degraded", message: "slow", lastCheck: 0,
    }));
    await checker.runAll();
    expect(checker.getOverallHealth()).toBe("degraded");
  });

  test("handles check that throws", async () => {
    checker.registerCheck("boom", () => { throw new Error("exploded"); });
    const results = await checker.runAll();
    expect(results.get("boom")!.status).toBe("unhealthy");
    expect(results.get("boom")!.message).toContain("exploded");
  });

  test("async checks are supported", async () => {
    checker.registerCheck("async", async () => ({
      name: "async", status: "healthy", message: "done", lastCheck: 0,
    }));
    const results = await checker.runAll();
    expect(results.get("async")!.status).toBe("healthy");
  });

  test("builtin checks all return healthy by default", async () => {
    checker.registerBuiltinChecks();
    const results = await checker.runAll();
    expect(results.size).toBe(6);
    for (const status of results.values()) {
      expect(status.status).toBe("healthy");
    }
  });

  test("overall health is healthy with no checks", () => {
    expect(checker.getOverallHealth()).toBe("healthy");
  });
});

// ─── AlertManager ───

describe("AlertManager", () => {
  let alertMgr: AlertManager;
  beforeEach(() => { alertMgr = new AlertManager(); });

  test("rule triggers alert when condition is true", () => {
    alertMgr.addRule({
      name: "test_rule",
      condition: () => true,
      severity: "warning",
      message: "something wrong",
      cooldownMs: 0,
    });
    const alerts = alertMgr.evaluate(new Map());
    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].source).toBe("test_rule");
  });

  test("rule does not trigger when condition is false", () => {
    alertMgr.addRule({
      name: "ok_rule",
      condition: () => false,
      severity: "info",
      message: "fine",
      cooldownMs: 0,
    });
    expect(alertMgr.evaluate(new Map()).length).toBe(0);
  });

  test("cooldown prevents rapid re-firing", () => {
    alertMgr.addRule({
      name: "cooldown_rule",
      condition: () => true,
      severity: "error",
      message: "err",
      cooldownMs: 60_000,
    });
    alertMgr.evaluate(new Map());
    // Second evaluation within cooldown should not fire
    const second = alertMgr.evaluate(new Map());
    expect(second.length).toBe(0);
  });

  test("acknowledge removes alert from active list", () => {
    alertMgr.addRule({
      name: "ack_rule",
      condition: () => true,
      severity: "critical",
      message: "crit",
      cooldownMs: 0,
    });
    const alerts = alertMgr.evaluate(new Map());
    expect(alertMgr.getActiveAlerts().length).toBe(1);
    alertMgr.acknowledge(alerts[0].id);
    expect(alertMgr.getActiveAlerts().length).toBe(0);
  });

  test("acknowledge returns false for unknown alert", () => {
    expect(alertMgr.acknowledge("nonexistent")).toBe(false);
  });

  test("alert history preserves acknowledged alerts", () => {
    alertMgr.addRule({
      name: "hist_rule",
      condition: () => true,
      severity: "info",
      message: "info",
      cooldownMs: 0,
    });
    const alerts = alertMgr.evaluate(new Map());
    alertMgr.acknowledge(alerts[0].id);
    const history = alertMgr.getAlertHistory();
    expect(history.length).toBe(1);
    expect(history[0].acknowledged).toBe(true);
  });

  test("alert history respects limit", () => {
    alertMgr.addRule({
      name: "many",
      condition: () => true,
      severity: "info",
      message: "m",
      cooldownMs: 0,
    });
    for (let i = 0; i < 10; i++) {
      alertMgr.evaluate(new Map());
    }
    expect(alertMgr.getAlertHistory(5).length).toBe(5);
  });

  test("builtin rules register without error", () => {
    alertMgr.registerBuiltinRules();
    // No metrics → no alerts should fire
    const alerts = alertMgr.evaluate(new Map());
    expect(alerts.length).toBe(0);
  });

  test("builtin high_failure_rate rule triggers on low success rate", () => {
    alertMgr.registerBuiltinRules();
    const metrics = new Map<string, AggregatedMetric>();
    metrics.set("tool.success_rate", {
      name: "tool.success_rate",
      sum: 800, avg: 40, min: 20, max: 60, p50: 40, p95: 55, p99: 58, count: 20,
    });
    const alerts = alertMgr.evaluate(metrics);
    const failureAlert = alerts.find((a) => a.source === "high_failure_rate");
    expect(failureAlert).toBeDefined();
    expect(failureAlert!.severity).toBe("error");
  });
});

// ─── Exporters: Console ───

describe("ConsoleExporter", () => {
  test("formats metrics as table", async () => {
    const exporter = new ConsoleExporter();
    await exporter.export([
      { name: "req.count", value: 42, unit: "count", tags: { env: "prod" }, timestamp: 1000 },
    ]);
    const output = exporter.getOutput();
    expect(output.length).toBe(1);
    expect(output[0]).toContain("req.count");
    expect(output[0]).toContain("42.00");
    expect(output[0]).toContain("env=prod");
  });

  test("handles empty metrics", async () => {
    const exporter = new ConsoleExporter();
    await exporter.export([]);
    expect(exporter.getOutput().length).toBe(0);
  });
});

// ─── Exporters: Prometheus ───

describe("PrometheusExporter", () => {
  test("formats metrics in Prometheus exposition format", async () => {
    const exporter = new PrometheusExporter();
    await exporter.export([
      { name: "http.requests", value: 150, unit: "count", tags: { method: "GET", path: "/api" }, timestamp: 1234567890 },
    ]);
    const output = exporter.getOutput();
    expect(output).toContain("http_requests");
    expect(output).toContain('method="GET"');
    expect(output).toContain('path="/api"');
    expect(output).toContain("150");
    expect(output).toContain("1234567890");
  });

  test("sanitizes metric names (dots to underscores)", async () => {
    const exporter = new PrometheusExporter();
    await exporter.export([
      { name: "my.cool-metric", value: 1, unit: "count", tags: {}, timestamp: 100 },
    ]);
    const output = exporter.getOutput();
    expect(output).toContain("my_cool_metric");
    expect(output).not.toContain("my.cool-metric");
  });

  test("handles metrics without tags", async () => {
    const exporter = new PrometheusExporter();
    await exporter.export([
      { name: "simple", value: 99, unit: "count", tags: {}, timestamp: 500 },
    ]);
    const output = exporter.getOutput();
    expect(output).toMatch(/^simple 99 500\n$/);
  });

  test("handles empty export", async () => {
    const exporter = new PrometheusExporter();
    await exporter.export([]);
    expect(exporter.getOutput()).toBe("");
  });
});

// ─── Exporters: JSON File ───

describe("JsonFileExporter", () => {
  const tmpDir = join(tmpdir(), `observability-test-${Date.now()}`);

  test("writes metrics to date-stamped JSON file", async () => {
    const exporter = new JsonFileExporter(tmpDir);
    await exporter.export([
      { name: "test.metric", value: 1, unit: "count", tags: { a: "b" }, timestamp: 999 },
    ]);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(tmpDir, `${dateStr}.json`);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.name).toBe("test.metric");
    expect(parsed.value).toBe(1);
    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ─── createObservabilityStack ───

describe("createObservabilityStack", () => {
  test("creates a complete stack with all components", () => {
    const stack = createObservabilityStack({
      enableJsonExporter: false,
      enableConsoleExporter: false,
    });
    expect(stack.metrics).toBeDefined();
    expect(stack.health).toBeDefined();
    expect(stack.alerts).toBeDefined();
    expect(typeof stack.tick).toBe("function");
  });

  test("tick evaluates alerts and flushes metrics", async () => {
    const stack = createObservabilityStack({
      enableJsonExporter: false,
      enableConsoleExporter: false,
    });
    stack.metrics.counter("test");
    stack.metrics.counter("test");
    await stack.tick();
    // After tick, flush should return empty (already flushed)
    expect(stack.metrics.flush().length).toBe(0);
  });
});
