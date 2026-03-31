/**
 * Cache Analyzer - Analyzes messages to identify cacheable segments
 * and their stability characteristics for optimal prompt cache layout.
 */

export type StabilityLevel = "static" | "semi_static" | "dynamic";

export type SegmentCategory =
  | "system_prompt"
  | "tool_definitions"
  | "conversation_history"
  | "context"
  | "memory";

export interface CacheableSegment {
  id: string;
  content: string;
  tokenEstimate: number;
  stability: StabilityLevel;
  category: SegmentCategory;
  lastModified: number;
}

/**
 * Stability priority order (higher = more stable, should come first).
 */
const STABILITY_RANK: Record<StabilityLevel, number> = {
  static: 3,
  semi_static: 2,
  dynamic: 1,
};

/**
 * Category priority order for sorting within the same stability level.
 * Lower number = should appear earlier in the prompt.
 */
const CATEGORY_PRIORITY: Record<SegmentCategory, number> = {
  system_prompt: 0,
  tool_definitions: 1,
  memory: 2,
  context: 3,
  conversation_history: 4,
};

/**
 * Rough token estimation: ~4 characters per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface MessageLike {
  role?: string;
  content?: string | unknown;
  type?: string;
  name?: string;
  [key: string]: unknown;
}

export class CacheAnalyzer {
  /**
   * Analyze a message (or message-like object) and break it into cacheable segments.
   */
  analyzeMessage(message: MessageLike): CacheableSegment[] {
    const segments: CacheableSegment[] = [];
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "");
    const now = Date.now();

    // Detect category from message shape
    const category = this.detectCategory(message);
    const stability = this.classifyStabilityForCategory(category);

    // For large messages, try to split into sub-segments
    const subSegments = this.splitContent(content, category);

    for (let i = 0; i < subSegments.length; i++) {
      const sub = subSegments[i];
      const subCategory = sub.category ?? category;
      segments.push({
        id: `${category}-${i}-${hashCode(sub.content)}`,
        content: sub.content,
        tokenEstimate: estimateTokens(sub.content),
        stability: this.classifyStabilityForCategory(subCategory),
        category: subCategory,
        lastModified: now,
      });
    }

    // If no sub-segments were created, emit the whole thing as one segment
    if (segments.length === 0 && content.length > 0) {
      segments.push({
        id: `${category}-0-${hashCode(content)}`,
        content,
        tokenEstimate: estimateTokens(content),
        stability,
        category,
        lastModified: now,
      });
    }

    return segments;
  }

  /**
   * Classify the stability of a segment based on its properties.
   */
  classifyStability(segment: CacheableSegment): StabilityLevel {
    return this.classifyStabilityForCategory(segment.category);
  }

  /**
   * Classify stability based on category.
   * - static: system prompt, tool definitions (never change within session)
   * - semi_static: memory, project context (change infrequently)
   * - dynamic: conversation history, tool results (change every turn)
   */
  classifyStabilityForCategory(category: SegmentCategory): StabilityLevel {
    switch (category) {
      case "system_prompt":
      case "tool_definitions":
        return "static";
      case "memory":
      case "context":
        return "semi_static";
      case "conversation_history":
        return "dynamic";
      default:
        return "dynamic";
    }
  }

  /**
   * Split segments into a cacheable prefix (stable) and dynamic tail.
   * Principle: put most stable content first to maximize cache-hit prefix length.
   *
   * Sort order: system_prompt > tool_definitions > memory > context > conversation_history
   * Within the same category, sort by stability (static > semi_static > dynamic).
   */
  getCacheablePrefix(segments: CacheableSegment[]): {
    prefix: CacheableSegment[];
    dynamic: CacheableSegment[];
  } {
    const sorted = [...segments].sort((a, b) => {
      // First sort by stability (descending - static first)
      const stabilityDiff = STABILITY_RANK[b.stability] - STABILITY_RANK[a.stability];
      if (stabilityDiff !== 0) return stabilityDiff;

      // Then by category priority (ascending)
      return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    });

    // Find the boundary where content transitions from stable to dynamic
    let boundaryIndex = sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].stability === "dynamic") {
        boundaryIndex = i;
        break;
      }
    }

    return {
      prefix: sorted.slice(0, boundaryIndex),
      dynamic: sorted.slice(boundaryIndex),
    };
  }

  /**
   * Estimate cache hit rate improvement from reordering.
   * Hit rate is approximated by (stable prefix token count / total token count).
   */
  estimateCacheHitRate(
    currentOrder: CacheableSegment[],
    optimizedOrder: CacheableSegment[]
  ): { currentRate: number; optimizedRate: number; improvement: number } {
    const currentRate = this.calculatePrefixHitRate(currentOrder);
    const optimizedRate = this.calculatePrefixHitRate(optimizedOrder);

    return {
      currentRate,
      optimizedRate,
      improvement: optimizedRate - currentRate,
    };
  }

  // --- Private helpers ---

  private calculatePrefixHitRate(segments: CacheableSegment[]): number {
    if (segments.length === 0) return 0;

    const totalTokens = segments.reduce((sum, s) => sum + s.tokenEstimate, 0);
    if (totalTokens === 0) return 0;

    // Walk from the start and count how many tokens are in the stable prefix
    // before the first dynamic segment appears.
    let stablePrefixTokens = 0;
    for (const seg of segments) {
      if (seg.stability === "dynamic") break;
      stablePrefixTokens += seg.tokenEstimate;
    }

    return stablePrefixTokens / totalTokens;
  }

  private detectCategory(message: MessageLike): SegmentCategory {
    const role = message.role ?? "";
    const type = message.type ?? "";
    const name = message.name ?? "";
    const content =
      typeof message.content === "string" ? message.content : "";

    if (role === "system" || type === "system") {
      // Check for tool definitions embedded in system messages
      if (
        content.includes("function") &&
        (content.includes("parameters") || content.includes("tool"))
      ) {
        return "tool_definitions";
      }
      return "system_prompt";
    }

    if (type === "tool" || type === "tool_definitions" || name === "tools") {
      return "tool_definitions";
    }

    if (type === "memory" || name === "memory" || role === "memory") {
      return "memory";
    }

    if (type === "context" || name === "context") {
      return "context";
    }

    // Assistant / user messages are conversation history
    if (role === "assistant" || role === "user") {
      return "conversation_history";
    }

    // Default to context for unknown shapes
    return "context";
  }

  private splitContent(
    content: string,
    parentCategory: SegmentCategory
  ): { content: string; category?: SegmentCategory }[] {
    // Only attempt splitting for large content blocks
    if (content.length < 500) {
      return [{ content }];
    }

    // For system prompts, try to separate tool definitions from the rest
    if (parentCategory === "system_prompt") {
      const toolDefMarkers = [
        "## Tools",
        "# Tools",
        "Available tools:",
        "<tools>",
        "functions:",
      ];
      for (const marker of toolDefMarkers) {
        const idx = content.indexOf(marker);
        if (idx > 0) {
          return [
            { content: content.slice(0, idx), category: "system_prompt" },
            {
              content: content.slice(idx),
              category: "tool_definitions",
            },
          ];
        }
      }
    }

    return [{ content }];
  }
}

function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}
