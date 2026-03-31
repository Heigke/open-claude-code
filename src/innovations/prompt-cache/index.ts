/**
 * Innovation #8: Smart Prompt Cache Optimizer
 *
 * Maximizes prompt cache hit rates by intelligently ordering
 * and structuring messages so that stable content appears first.
 */

export { CacheAnalyzer } from "./cacheAnalyzer.js";
export type {
  CacheableSegment,
  StabilityLevel,
  SegmentCategory,
  MessageLike,
} from "./cacheAnalyzer.js";

export { CacheStrategyOptimizer } from "./cacheStrategy.js";
export type {
  CacheStrategy,
  CacheBreakpoint,
  ReorderRule,
  OptimizedLayout,
} from "./cacheStrategy.js";

export { CacheTelemetry } from "./cacheTelemetry.js";
export type {
  CacheMetrics,
  TimeSeriesBucket,
  CacheTrend,
} from "./cacheTelemetry.js";

import { CacheAnalyzer, type MessageLike } from "./cacheAnalyzer.js";
import { CacheStrategyOptimizer } from "./cacheStrategy.js";
import { CacheTelemetry } from "./cacheTelemetry.js";

/**
 * Factory: creates a fully wired prompt cache optimizer.
 */
export function createPromptCacheOptimizer() {
  const analyzer = new CacheAnalyzer();
  const strategy = new CacheStrategyOptimizer();
  const telemetry = new CacheTelemetry();

  return {
    analyzer,
    strategy,
    telemetry,

    /**
     * Optimize a list of messages for maximum cache hit rate.
     */
    optimizeMessages(messages: MessageLike[]) {
      const allSegments = messages.flatMap((m) => analyzer.analyzeMessage(m));
      const layout = strategy.optimize(allSegments);
      return layout;
    },

    /**
     * Record a request's cache performance.
     */
    recordRequest(
      inputTokens: number,
      cacheReadTokens: number,
      cacheCreationTokens: number
    ) {
      telemetry.recordRequest(inputTokens, cacheReadTokens, cacheCreationTokens);
    },

    /**
     * Get current cache performance metrics.
     */
    getMetrics() {
      return telemetry.getMetrics();
    },

    /**
     * Get the trend of cache performance.
     */
    getTrend() {
      return telemetry.getTrend();
    },
  };
}
