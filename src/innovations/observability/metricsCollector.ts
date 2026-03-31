/**
 * Observability & Metrics Layer - Metrics Collector
 *
 * Structured metrics collection with counters, gauges, histograms, and timers.
 * Maintains a sliding window of data points per metric for aggregation.
 */

export type MetricUnit = "count" | "ms" | "bytes" | "tokens" | "percent" | "score";

export interface Metric {
  name: string;
  value: number;
  unit: MetricUnit;
  tags: Record<string, string>;
  timestamp: number;
}

export interface AggregatedMetric {
  name: string;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

export interface TimerHandle {
  stop: () => number;
}

const MAX_DATA_POINTS = 10_000;

interface MetricBuffer {
  values: number[];
  unit: MetricUnit;
  tags: Record<string, string>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const fraction = idx - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export class MetricsCollector {
  private buffers: Map<string, MetricBuffer> = new Map();
  private pending: Metric[] = [];

  private getOrCreateBuffer(name: string, unit: MetricUnit, tags: Record<string, string>): MetricBuffer {
    let buf = this.buffers.get(name);
    if (!buf) {
      buf = { values: [], unit, tags };
      this.buffers.set(name, buf);
    }
    return buf;
  }

  private record(name: string, value: number, unit: MetricUnit, tags: Record<string, string>): void {
    const buf = this.getOrCreateBuffer(name, unit, tags);
    buf.values.push(value);
    // Sliding window retention
    if (buf.values.length > MAX_DATA_POINTS) {
      buf.values = buf.values.slice(buf.values.length - MAX_DATA_POINTS);
    }
    // Merge tags (latest wins)
    Object.assign(buf.tags, tags);

    this.pending.push({
      name,
      value,
      unit,
      tags: { ...tags },
      timestamp: Date.now(),
    });
  }

  /**
   * Increment a counter by 1 (or by a given amount via multiple calls).
   */
  counter(name: string, tags: Record<string, string> = {}): void {
    this.record(name, 1, "count", tags);
  }

  /**
   * Set a gauge to an absolute value.
   */
  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    this.record(name, value, "score", tags);
  }

  /**
   * Record a value into a histogram (distribution).
   */
  histogram(name: string, value: number, tags: Record<string, string> = {}): void {
    this.record(name, value, "ms", tags);
  }

  /**
   * Start a timer. Call stop() on the returned handle to record the duration in ms.
   */
  timer(name: string, tags: Record<string, string> = {}): TimerHandle {
    const start = performance.now();
    return {
      stop: (): number => {
        const elapsed = performance.now() - start;
        this.record(name, elapsed, "ms", tags);
        return elapsed;
      },
    };
  }

  /**
   * Get aggregated statistics for a single metric.
   */
  getMetric(name: string): AggregatedMetric | undefined {
    const buf = this.buffers.get(name);
    if (!buf || buf.values.length === 0) return undefined;
    return this.aggregate(name, buf.values);
  }

  /**
   * Get aggregated statistics for all metrics.
   */
  getAllMetrics(): Map<string, AggregatedMetric> {
    const result = new Map<string, AggregatedMetric>();
    for (const [name, buf] of this.buffers) {
      if (buf.values.length > 0) {
        result.set(name, this.aggregate(name, buf.values));
      }
    }
    return result;
  }

  /**
   * Export all pending metrics and reset the pending queue.
   * Buffers are preserved for continued aggregation.
   */
  flush(): Metric[] {
    const out = [...this.pending];
    this.pending = [];
    return out;
  }

  /**
   * Completely reset all state.
   */
  reset(): void {
    this.buffers.clear();
    this.pending = [];
  }

  private aggregate(name: string, values: number[]): AggregatedMetric {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      name,
      sum,
      avg: sum / values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      count: values.length,
    };
  }
}
