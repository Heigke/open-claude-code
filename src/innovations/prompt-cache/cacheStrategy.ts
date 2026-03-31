/**
 * Cache Strategy Optimizer - Determines optimal segment ordering
 * and cache breakpoints for maximum prompt cache hit rates.
 */

import type { CacheableSegment, SegmentCategory, StabilityLevel } from "./cacheAnalyzer.js";

export interface ReorderRule {
  name: string;
  description: string;
  apply(segments: CacheableSegment[]): CacheableSegment[];
}

export interface CacheBreakpoint {
  afterSegmentId: string;
  reason: string;
}

export interface CacheStrategy {
  name: string;
  reorderRules: ReorderRule[];
  breakpoints: CacheBreakpoint[];
}

export interface OptimizedLayout {
  segments: CacheableSegment[];
  breakpoints: CacheBreakpoint[];
  estimatedHitRate: number;
  reorderingApplied: string[];
}

/**
 * Canonical ordering: system_prompt > tool_definitions > memory > context > conversation_history
 */
const CATEGORY_ORDER: Record<SegmentCategory, number> = {
  system_prompt: 0,
  tool_definitions: 1,
  memory: 2,
  context: 3,
  conversation_history: 4,
};

const STABILITY_ORDER: Record<StabilityLevel, number> = {
  static: 0,
  semi_static: 1,
  dynamic: 2,
};

// ---- Built-in reorder rules ----

const stabilityFirstRule: ReorderRule = {
  name: "stability-first",
  description: "Sort segments by stability: static > semi_static > dynamic",
  apply(segments: CacheableSegment[]): CacheableSegment[] {
    return [...segments].sort(
      (a, b) => STABILITY_ORDER[a.stability] - STABILITY_ORDER[b.stability]
    );
  },
};

const categoryOrderRule: ReorderRule = {
  name: "category-order",
  description:
    "Within the same stability level, sort by canonical category order",
  apply(segments: CacheableSegment[]): CacheableSegment[] {
    return [...segments].sort((a, b) => {
      const stabDiff =
        STABILITY_ORDER[a.stability] - STABILITY_ORDER[b.stability];
      if (stabDiff !== 0) return stabDiff;
      return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    });
  },
};

const largeStaticFirstRule: ReorderRule = {
  name: "large-static-first",
  description:
    "Among static segments, put larger ones first for maximum prefix coverage",
  apply(segments: CacheableSegment[]): CacheableSegment[] {
    return [...segments].sort((a, b) => {
      const stabDiff =
        STABILITY_ORDER[a.stability] - STABILITY_ORDER[b.stability];
      if (stabDiff !== 0) return stabDiff;
      const catDiff = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (catDiff !== 0) return catDiff;
      // Within same category+stability, larger segments first
      return b.tokenEstimate - a.tokenEstimate;
    });
  },
};

export class CacheStrategyOptimizer {
  private rules: ReorderRule[];

  constructor(rules?: ReorderRule[]) {
    this.rules = rules ?? [
      stabilityFirstRule,
      categoryOrderRule,
      largeStaticFirstRule,
    ];
  }

  /**
   * Optimize segment layout for maximum cache hit rate.
   */
  optimize(segments: CacheableSegment[]): OptimizedLayout {
    if (segments.length === 0) {
      return {
        segments: [],
        breakpoints: [],
        estimatedHitRate: 0,
        reorderingApplied: [],
      };
    }

    // Apply the final (most comprehensive) rule that subsumes the others
    const finalRule = this.rules[this.rules.length - 1];
    const optimized = finalRule.apply(segments);
    const appliedRules = this.rules.map((r) => r.name);

    const breakpoints = this.detectBreakpoints(optimized);
    const hitRate = this.estimateHitRate(optimized);

    return {
      segments: optimized,
      breakpoints,
      estimatedHitRate: hitRate,
      reorderingApplied: appliedRules,
    };
  }

  /**
   * Detect natural cache breakpoints where content transitions
   * from one stability level to another.
   */
  detectBreakpoints(segments: CacheableSegment[]): CacheBreakpoint[] {
    const breakpoints: CacheBreakpoint[] = [];

    for (let i = 0; i < segments.length - 1; i++) {
      const current = segments[i];
      const next = segments[i + 1];

      // Breakpoint when stability changes
      if (current.stability !== next.stability) {
        breakpoints.push({
          afterSegmentId: current.id,
          reason: `Stability transition: ${current.stability} -> ${next.stability}`,
        });
        continue;
      }

      // Breakpoint when category changes within the same stability
      if (current.category !== next.category) {
        breakpoints.push({
          afterSegmentId: current.id,
          reason: `Category transition: ${current.category} -> ${next.category}`,
        });
      }
    }

    return breakpoints;
  }

  /**
   * Compare two layouts and determine which has a better cache hit rate.
   */
  compareLayouts(
    a: OptimizedLayout,
    b: OptimizedLayout
  ): { winner: "a" | "b"; reason: string; hitRateDiff: number } {
    const diff = a.estimatedHitRate - b.estimatedHitRate;
    const absDiff = Math.abs(diff);

    if (absDiff < 0.001) {
      // Tie-break on number of breakpoints (fewer is better)
      const bpDiff = a.breakpoints.length - b.breakpoints.length;
      if (bpDiff <= 0) {
        return {
          winner: "a",
          reason:
            absDiff < 0.001
              ? "Effectively equal hit rates; A has fewer or equal breakpoints"
              : "Higher hit rate",
          hitRateDiff: diff,
        };
      }
      return {
        winner: "b",
        reason: "Effectively equal hit rates; B has fewer breakpoints",
        hitRateDiff: diff,
      };
    }

    if (diff > 0) {
      return {
        winner: "a",
        reason: `Layout A has ${(diff * 100).toFixed(1)}% higher hit rate`,
        hitRateDiff: diff,
      };
    }

    return {
      winner: "b",
      reason: `Layout B has ${(-diff * 100).toFixed(1)}% higher hit rate`,
      hitRateDiff: diff,
    };
  }

  /**
   * Get the default strategy with all built-in rules.
   */
  getDefaultStrategy(): CacheStrategy {
    return {
      name: "default-optimal",
      reorderRules: this.rules,
      breakpoints: [],
    };
  }

  // --- Private helpers ---

  private estimateHitRate(segments: CacheableSegment[]): number {
    const totalTokens = segments.reduce((s, seg) => s + seg.tokenEstimate, 0);
    if (totalTokens === 0) return 0;

    let stablePrefixTokens = 0;
    for (const seg of segments) {
      if (seg.stability === "dynamic") break;
      stablePrefixTokens += seg.tokenEstimate;
    }

    return stablePrefixTokens / totalTokens;
  }
}
