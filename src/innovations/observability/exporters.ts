/**
 * Observability & Metrics Layer - Exporters
 *
 * Export metrics in various formats: JSON file, console table, Prometheus text.
 */

import { mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Metric } from "./metricsCollector";

export interface MetricsExporter {
  export(metrics: Metric[]): Promise<void>;
}

/**
 * Writes metrics as JSON to ~/.claude/metrics/YYYY-MM-DD.json
 */
export class JsonFileExporter implements MetricsExporter {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".claude", "metrics");
  }

  async export(metrics: Metric[]): Promise<void> {
    if (metrics.length === 0) return;

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.baseDir, `${dateStr}.json`);

    const lines = metrics.map((m) => JSON.stringify(m));
    appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}

/**
 * Formats metrics as a table and logs to console.
 */
export class ConsoleExporter implements MetricsExporter {
  private output: string[] = [];

  async export(metrics: Metric[]): Promise<void> {
    if (metrics.length === 0) return;

    const lines: string[] = [];
    const header = `${"Name".padEnd(40)} ${"Value".padStart(12)} ${"Unit".padEnd(8)} ${"Tags".padEnd(30)}`;
    const separator = "-".repeat(header.length);

    lines.push(separator);
    lines.push(header);
    lines.push(separator);

    for (const m of metrics) {
      const tagsStr = Object.entries(m.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(
        `${m.name.padEnd(40)} ${m.value.toFixed(2).padStart(12)} ${m.unit.padEnd(8)} ${tagsStr.padEnd(30)}`
      );
    }

    lines.push(separator);

    const output = lines.join("\n");
    this.output.push(output);
    console.log(output);
  }

  /**
   * Get captured output (for testing).
   */
  getOutput(): string[] {
    return this.output;
  }
}

/**
 * Formats metrics in Prometheus exposition format.
 * Each metric as: metric_name{tag1="val1"} value timestamp
 */
export class PrometheusExporter implements MetricsExporter {
  private lastOutput = "";

  async export(metrics: Metric[]): Promise<void> {
    if (metrics.length === 0) {
      this.lastOutput = "";
      return;
    }

    const lines: string[] = [];

    for (const m of metrics) {
      // Sanitize metric name for Prometheus (replace dots/dashes with underscores)
      const name = m.name.replace(/[^a-zA-Z0-9_:]/g, "_");

      // Build label string
      const labels = Object.entries(m.tags)
        .map(([k, v]) => `${k.replace(/[^a-zA-Z0-9_]/g, "_")}="${v.replace(/"/g, '\\"')}"`)
        .join(",");

      const labelStr = labels ? `{${labels}}` : "";
      const timestampMs = m.timestamp;

      lines.push(`${name}${labelStr} ${m.value} ${timestampMs}`);
    }

    this.lastOutput = lines.join("\n") + "\n";
  }

  /**
   * Get the last formatted output.
   */
  getOutput(): string {
    return this.lastOutput;
  }
}
