/**
 * Innovation #11: Observability & Metrics Layer
 *
 * Structured metrics collection, aggregation, and export for all innovation modules.
 * Provides counters, gauges, histograms, timers, health checks, alerts, and exporters.
 */

export { MetricsCollector } from "./metricsCollector";
export type { Metric, MetricUnit, AggregatedMetric, TimerHandle } from "./metricsCollector";

export { HealthChecker } from "./healthChecker";
export type { HealthStatus, HealthCheckFn } from "./healthChecker";

export { AlertManager } from "./alertManager";
export type { Alert, AlertRule } from "./alertManager";

export { JsonFileExporter, ConsoleExporter, PrometheusExporter } from "./exporters";
export type { MetricsExporter } from "./exporters";

import { MetricsCollector } from "./metricsCollector";
import { HealthChecker } from "./healthChecker";
import { AlertManager } from "./alertManager";
import { ConsoleExporter, JsonFileExporter, PrometheusExporter } from "./exporters";
import type { MetricsExporter } from "./exporters";

export interface ObservabilityStack {
  metrics: MetricsCollector;
  health: HealthChecker;
  alerts: AlertManager;
  exporters: MetricsExporter[];

  /** Evaluate alerts against current metrics and export pending data. */
  tick(): Promise<void>;
}

/**
 * Factory: create a fully wired observability stack with built-in checks and rules.
 */
export function createObservabilityStack(options?: {
  enableConsoleExporter?: boolean;
  enableJsonExporter?: boolean;
  enablePrometheusExporter?: boolean;
  jsonExportDir?: string;
}): ObservabilityStack {
  const metrics = new MetricsCollector();
  const health = new HealthChecker();
  const alerts = new AlertManager();

  health.registerBuiltinChecks();
  alerts.registerBuiltinRules();

  const exporters: MetricsExporter[] = [];

  if (options?.enableConsoleExporter) {
    exporters.push(new ConsoleExporter());
  }
  if (options?.enableJsonExporter !== false) {
    exporters.push(new JsonFileExporter(options?.jsonExportDir));
  }
  if (options?.enablePrometheusExporter) {
    exporters.push(new PrometheusExporter());
  }

  return {
    metrics,
    health,
    alerts,
    exporters,

    async tick(): Promise<void> {
      // Evaluate alert rules
      const allMetrics = metrics.getAllMetrics();
      alerts.evaluate(allMetrics);

      // Flush and export
      const pending = metrics.flush();
      if (pending.length > 0) {
        await Promise.all(exporters.map((e) => e.export(pending)));
      }
    },
  };
}
