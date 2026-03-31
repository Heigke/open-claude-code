/**
 * Cache Telemetry - Tracks prompt cache performance metrics over time.
 */

export interface CacheMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  tokensSaved: number;
  costSaved: number;
  avgPrefixLength: number;
  breakpointEfficiency: number;
}

export interface TimeSeriesBucket {
  timestamp: number;
  hitRate: number;
  tokensSaved: number;
}

export type CacheTrend = "improving" | "declining" | "stable";

interface RequestRecord {
  timestamp: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export class CacheTelemetry {
  private records: RequestRecord[] = [];
  private defaultPricePerInputToken = 0.000003; // $3/M tokens
  private defaultPricePerCacheToken = 0.0000003; // $0.30/M tokens (cache reads ~10x cheaper)

  /**
   * Record a single API request with its cache token breakdown.
   */
  recordRequest(
    inputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number
  ): void {
    this.records.push({
      timestamp: Date.now(),
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    });
  }

  /**
   * Get aggregate cache metrics.
   */
  getMetrics(): CacheMetrics {
    if (this.records.length === 0) {
      return {
        totalRequests: 0,
        cacheHits: 0,
        cacheMisses: 0,
        hitRate: 0,
        tokensSaved: 0,
        costSaved: 0,
        avgPrefixLength: 0,
        breakpointEfficiency: 0,
      };
    }

    let cacheHits = 0;
    let cacheMisses = 0;
    let totalTokensSaved = 0;
    let totalPrefixLength = 0;
    let totalCostSaved = 0;

    for (const r of this.records) {
      if (r.cacheReadTokens > 0) {
        cacheHits++;
      } else {
        cacheMisses++;
      }

      // Tokens saved = cache read tokens (these didn't need to be reprocessed)
      totalTokensSaved += r.cacheReadTokens;

      // Prefix length = cache read + cache creation tokens
      totalPrefixLength += r.cacheReadTokens + r.cacheCreationTokens;

      // Cost saved = what we would have paid at full input price minus cache read price
      const savedTokenCost =
        r.cacheReadTokens *
        (this.defaultPricePerInputToken - this.defaultPricePerCacheToken);
      totalCostSaved += savedTokenCost;
    }

    const totalRequests = this.records.length;
    const avgPrefixLength = totalPrefixLength / totalRequests;

    // Breakpoint efficiency: ratio of cache reads to total cached tokens
    const totalCacheTokens = this.records.reduce(
      (sum, r) => sum + r.cacheReadTokens + r.cacheCreationTokens,
      0
    );
    const totalCacheReads = this.records.reduce(
      (sum, r) => sum + r.cacheReadTokens,
      0
    );
    const breakpointEfficiency =
      totalCacheTokens > 0 ? totalCacheReads / totalCacheTokens : 0;

    return {
      totalRequests,
      cacheHits,
      cacheMisses,
      hitRate: totalRequests > 0 ? cacheHits / totalRequests : 0,
      tokensSaved: totalTokensSaved,
      costSaved: totalCostSaved,
      avgPrefixLength,
      breakpointEfficiency,
    };
  }

  /**
   * Get time series data bucketed by the given interval.
   */
  getTimeSeries(bucketMinutes: number = 5): TimeSeriesBucket[] {
    if (this.records.length === 0) return [];

    const bucketMs = bucketMinutes * 60 * 1000;
    const sorted = [...this.records].sort(
      (a, b) => a.timestamp - b.timestamp
    );
    const startTime = sorted[0].timestamp;

    const buckets = new Map<
      number,
      { hits: number; total: number; tokensSaved: number }
    >();

    for (const r of sorted) {
      const bucketKey =
        startTime + Math.floor((r.timestamp - startTime) / bucketMs) * bucketMs;

      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = { hits: 0, total: 0, tokensSaved: 0 };
        buckets.set(bucketKey, bucket);
      }

      bucket.total++;
      if (r.cacheReadTokens > 0) bucket.hits++;
      bucket.tokensSaved += r.cacheReadTokens;
    }

    const result: TimeSeriesBucket[] = [];
    for (const [timestamp, data] of buckets) {
      result.push({
        timestamp,
        hitRate: data.total > 0 ? data.hits / data.total : 0,
        tokensSaved: data.tokensSaved,
      });
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Determine the trend: compare recent hit rate (last 25% of requests) to overall.
   */
  getTrend(): CacheTrend {
    if (this.records.length < 4) return "stable";

    const metrics = this.getMetrics();
    const overallHitRate = metrics.hitRate;

    // Recent = last 25% of requests
    const recentCount = Math.max(1, Math.floor(this.records.length / 4));
    const recentRecords = this.records.slice(-recentCount);
    const recentHits = recentRecords.filter(
      (r) => r.cacheReadTokens > 0
    ).length;
    const recentHitRate = recentHits / recentCount;

    const diff = recentHitRate - overallHitRate;
    const threshold = 0.05; // 5% threshold

    if (diff > threshold) return "improving";
    if (diff < -threshold) return "declining";
    return "stable";
  }

  /**
   * Estimate cost savings at given token prices.
   */
  getCostSavingsEstimate(
    pricePerInputToken: number,
    pricePerCacheToken: number
  ): { saved: number; couldSave: number } {
    let saved = 0;
    let couldSave = 0;

    for (const r of this.records) {
      // Actual savings from cache reads
      const actualSaved =
        r.cacheReadTokens * (pricePerInputToken - pricePerCacheToken);
      saved += actualSaved;

      // Potential savings if all input tokens were cached
      const potentialSaved =
        r.inputTokens * (pricePerInputToken - pricePerCacheToken);
      couldSave += potentialSaved;
    }

    return { saved, couldSave };
  }

  /**
   * Reset all telemetry data.
   */
  reset(): void {
    this.records = [];
  }

  /**
   * Get the number of recorded requests (useful for testing).
   */
  get requestCount(): number {
    return this.records.length;
  }
}
