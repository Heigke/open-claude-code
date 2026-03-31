/**
 * Security Sandbox Analyzer - Security Report
 *
 * Aggregation, summarization, and formatting of risk assessments
 * for security auditing and trend analysis.
 */

import type { RiskAssessment, RiskFactor, RiskCategory } from "./commandRiskScorer.js";

export interface ReportSummary {
  total: number;
  blocked: number;
  warned: number;
  allowed: number;
  topRisks: RiskFactor[];
}

export class SecurityReport {
  private assessments: RiskAssessment[];

  constructor(assessments: RiskAssessment[]) {
    this.assessments = [...assessments];
  }

  /**
   * Get a summary of all assessments.
   */
  getSummary(): ReportSummary {
    const blocked = this.assessments.filter((a) => a.recommendation === "block").length;
    const warned = this.assessments.filter((a) => a.recommendation === "warn").length;
    const allowed = this.assessments.filter((a) => a.recommendation === "allow").length;

    // Collect all factors, deduplicate by description, sort by severity weight
    const severityOrder: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    const allFactors = this.assessments.flatMap((a) => a.factors);
    const seen = new Set<string>();
    const uniqueFactors: RiskFactor[] = [];
    for (const f of allFactors) {
      const key = `${f.category}:${f.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueFactors.push(f);
      }
    }

    uniqueFactors.sort(
      (a, b) => severityOrder[b.severity] - severityOrder[a.severity]
    );

    return {
      total: this.assessments.length,
      blocked,
      warned,
      allowed,
      topRisks: uniqueFactors.slice(0, 10),
    };
  }

  /**
   * Get all assessments with overallRisk >= 50 or recommendation "block".
   */
  getHighRiskCommands(): RiskAssessment[] {
    return this.assessments.filter(
      (a) => a.overallRisk >= 50 || a.recommendation === "block"
    );
  }

  /**
   * Get a breakdown of risk factor counts by category.
   */
  getCategoryBreakdown(): Map<RiskCategory, number> {
    const breakdown = new Map<RiskCategory, number>();

    for (const assessment of this.assessments) {
      for (const factor of assessment.factors) {
        breakdown.set(
          factor.category,
          (breakdown.get(factor.category) ?? 0) + 1
        );
      }
    }

    return breakdown;
  }

  /**
   * Format a human-readable security audit report.
   */
  formatReport(): string {
    const summary = this.getSummary();
    const breakdown = this.getCategoryBreakdown();
    const highRisk = this.getHighRiskCommands();

    const lines: string[] = [];

    lines.push("=".repeat(60));
    lines.push("  SECURITY SANDBOX ANALYSIS REPORT");
    lines.push("=".repeat(60));
    lines.push("");

    // Summary
    lines.push("SUMMARY");
    lines.push("-".repeat(40));
    lines.push(`  Total commands analyzed: ${summary.total}`);
    lines.push(`  Blocked:  ${summary.blocked}`);
    lines.push(`  Warned:   ${summary.warned}`);
    lines.push(`  Allowed:  ${summary.allowed}`);
    lines.push("");

    // Category breakdown
    if (breakdown.size > 0) {
      lines.push("RISK CATEGORY BREAKDOWN");
      lines.push("-".repeat(40));
      const sorted = [...breakdown.entries()].sort((a, b) => b[1] - a[1]);
      for (const [category, count] of sorted) {
        lines.push(`  ${category}: ${count} finding(s)`);
      }
      lines.push("");
    }

    // High risk commands
    if (highRisk.length > 0) {
      lines.push("HIGH RISK COMMANDS");
      lines.push("-".repeat(40));
      for (const assessment of highRisk) {
        lines.push(`  Command: ${assessment.command}`);
        lines.push(`  Risk Score: ${assessment.overallRisk}/100`);
        lines.push(`  Recommendation: ${assessment.recommendation.toUpperCase()}`);
        for (const factor of assessment.factors) {
          lines.push(
            `    [${factor.severity.toUpperCase()}] ${factor.category}: ${factor.description}`
          );
        }
        lines.push("");
      }
    }

    // Top risks
    if (summary.topRisks.length > 0) {
      lines.push("TOP RISK FACTORS");
      lines.push("-".repeat(40));
      for (let i = 0; i < Math.min(5, summary.topRisks.length); i++) {
        const risk = summary.topRisks[i];
        lines.push(
          `  ${i + 1}. [${risk.severity.toUpperCase()}] ${risk.category}: ${risk.description}`
        );
      }
      lines.push("");
    }

    lines.push("=".repeat(60));
    return lines.join("\n");
  }

  /**
   * Analyze trend over recent assessments.
   * Looks at the last `window` assessments and compares the
   * first half to the second half.
   */
  getTrend(window = 50): "improving" | "declining" | "stable" {
    const slice = this.assessments.slice(-window);
    if (slice.length < 4) return "stable";

    const mid = Math.floor(slice.length / 2);
    const firstHalf = slice.slice(0, mid);
    const secondHalf = slice.slice(mid);

    const avgFirst =
      firstHalf.reduce((sum, a) => sum + a.overallRisk, 0) / firstHalf.length;
    const avgSecond =
      secondHalf.reduce((sum, a) => sum + a.overallRisk, 0) / secondHalf.length;

    const diff = avgSecond - avgFirst;

    if (diff <= -5) return "improving";
    if (diff >= 5) return "declining";
    return "stable";
  }
}
