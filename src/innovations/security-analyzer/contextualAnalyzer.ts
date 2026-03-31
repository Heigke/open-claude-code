/**
 * Security Sandbox Analyzer - Contextual Analyzer
 *
 * Adjusts risk assessments based on project context, recent commands,
 * working directory, and command chain analysis.
 */

import type { RiskAssessment, RiskFactor, RiskCategory } from "./commandRiskScorer.js";
import { CommandRiskScorer } from "./commandRiskScorer.js";

export interface CommandContext {
  cwd: string;
  recentCommands: string[];
  recentFiles: string[];
  projectType?: string;
  isGitRepo: boolean;
}

export interface ContextualRisk {
  original: RiskAssessment;
  adjusted: RiskAssessment;
  adjustments: ContextAdjustment[];
}

export interface ContextAdjustment {
  type: "lower" | "raise";
  amount: number;
  reason: string;
}

// Known safe domains for package downloads
const KNOWN_REGISTRIES = [
  "registry.npmjs.org",
  "npmjs.com",
  "pypi.org",
  "pypi.python.org",
  "crates.io",
  "rubygems.org",
  "pkg.go.dev",
  "maven.org",
  "repo1.maven.org",
  "github.com",
  "gitlab.com",
  "raw.githubusercontent.com",
];

// Safe removal targets (build/dependency directories)
const SAFE_REMOVAL_DIRS = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".turbo",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "coverage",
  ".nyc_output",
  "tmp",
  ".tmp",
  ".parcel-cache",
  ".vite",
];

export class ContextualAnalyzer {
  private scorer: CommandRiskScorer;

  constructor(scorer?: CommandRiskScorer) {
    this.scorer = scorer ?? new CommandRiskScorer();
  }

  /**
   * Analyze a command in the context of the working environment.
   */
  analyzeInContext(command: string, context: CommandContext): ContextualRisk {
    const original = this.scorer.assess(command);
    const adjustments: ContextAdjustment[] = [];

    // Gather all contextual adjustments
    this.checkSafeRemoval(command, context, adjustments);
    this.checkKnownRegistry(command, adjustments);
    this.checkRecentCommandContext(command, context, adjustments);
    this.checkOutOfProject(command, context, adjustments);
    this.checkUnusualForProjectType(command, context, adjustments);
    this.checkGitRepoSafety(command, context, adjustments);

    // Compute adjusted risk
    const delta = adjustments.reduce(
      (sum, a) => sum + (a.type === "lower" ? -a.amount : a.amount),
      0
    );

    const adjustedRisk = Math.max(0, Math.min(100, original.overallRisk + delta));

    const adjustedRecommendation =
      original.factors.some((f) => f.severity === "critical") && delta >= 0
        ? "block" as const
        : adjustedRisk >= 60
          ? "block" as const
          : adjustedRisk >= 25
            ? "warn" as const
            : "allow" as const;

    const adjusted: RiskAssessment = {
      ...original,
      overallRisk: adjustedRisk,
      recommendation: adjustedRecommendation,
      reasoning: this.buildAdjustedReasoning(original, adjustments, adjustedRisk, adjustedRecommendation),
    };

    return { original, adjusted, adjustments };
  }

  /**
   * Analyze risk of a command chain/sequence (e.g., piped commands or && chains).
   * Returns a combined risk score accounting for escalation patterns.
   */
  getCommandChainRisk(commands: string[]): number {
    if (commands.length === 0) return 0;
    if (commands.length === 1) return this.scorer.assess(commands[0]).overallRisk;

    const assessments = commands.map((cmd) => this.scorer.assess(cmd));
    const baseRisk = Math.max(...assessments.map((a) => a.overallRisk));

    let chainBonus = 0;

    // Detect escalation patterns

    // Pattern: download -> make executable -> execute
    const hasDownload = commands.some((c) => /\b(curl|wget)\b/.test(c));
    const hasChmod = commands.some((c) => /\bchmod\b.*\+x/.test(c));
    const hasExecute = commands.some((c) => /\.\//.test(c));

    if (hasDownload && hasChmod && hasExecute) {
      chainBonus += 30;
    } else if (hasDownload && hasChmod) {
      chainBonus += 15;
    } else if (hasDownload && hasExecute) {
      chainBonus += 20;
    }

    // Pattern: reconnaissance -> exfiltration
    const hasRecon = commands.some((c) =>
      /\b(cat|ls|find|whoami|uname|id)\b/.test(c)
    );
    const hasExfil = commands.some((c) =>
      /\b(curl|wget|nc)\b.*(-X\s*POST|--data|\|)/.test(c)
    );
    if (hasRecon && hasExfil) {
      chainBonus += 20;
    }

    // Pattern: privilege escalation chain
    const hasSudo = commands.some((c) => /\bsudo\b/.test(c));
    const hasChown = commands.some((c) => /\bchown\b/.test(c));
    const hasChmodDangerous = commands.some((c) => /\bchmod\b.*(777|\+s)/.test(c));
    if (hasSudo && (hasChown || hasChmodDangerous)) {
      chainBonus += 15;
    }

    // Pattern: env variable capture -> use
    const hasEnvCapture = commands.some((c) => /\b(env|printenv)\b/.test(c));
    const hasNetworkSend = commands.some((c) => /\b(curl|wget|nc)\b/.test(c));
    if (hasEnvCapture && hasNetworkSend) {
      chainBonus += 25;
    }

    // Multiple destructive operations compound
    const destructiveCount = assessments.filter((a) =>
      a.factors.some((f) => f.category === "file_destruction")
    ).length;
    if (destructiveCount > 1) {
      chainBonus += destructiveCount * 10;
    }

    return Math.min(100, baseRisk + chainBonus);
  }

  // ── Private helpers ──────────────────────────────────────────────

  private checkSafeRemoval(
    command: string,
    _context: CommandContext,
    adjustments: ContextAdjustment[]
  ): void {
    if (!/\brm\b/.test(command)) return;

    for (const dir of SAFE_REMOVAL_DIRS) {
      if (command.includes(dir)) {
        adjustments.push({
          type: "lower",
          amount: 15,
          reason: `Removing '${dir}' is standard project cleanup`,
        });
        return;
      }
    }
  }

  private checkKnownRegistry(
    command: string,
    adjustments: ContextAdjustment[]
  ): void {
    if (!/\b(curl|wget)\b/.test(command)) return;

    for (const registry of KNOWN_REGISTRIES) {
      if (command.includes(registry)) {
        adjustments.push({
          type: "lower",
          amount: 10,
          reason: `Request to known package registry: ${registry}`,
        });
        return;
      }
    }
  }

  private checkRecentCommandContext(
    command: string,
    context: CommandContext,
    adjustments: ContextAdjustment[]
  ): void {
    if (context.recentCommands.length === 0) return;

    // If command references variables/files from recent commands, slightly lower risk
    const recentOutputPattern = context.recentCommands.some(
      (recent) =>
        /\b(export|set)\b.*(\w+)=/.test(recent) &&
        command.includes("$")
    );

    if (recentOutputPattern) {
      adjustments.push({
        type: "lower",
        amount: 5,
        reason: "Command appears to use variables set by recent successful commands",
      });
    }
  }

  private checkOutOfProject(
    command: string,
    context: CommandContext,
    adjustments: ContextAdjustment[]
  ): void {
    // Check if command targets paths outside the project directory
    const absolutePathMatch = command.match(/\s(\/[^\s]+)/g);
    if (!absolutePathMatch) return;

    for (const pathRef of absolutePathMatch) {
      const path = pathRef.trim();
      if (
        path.startsWith("/etc/") ||
        path.startsWith("/usr/") ||
        path.startsWith("/var/") ||
        path.startsWith("/boot/") ||
        path.startsWith("/sys/") ||
        path.startsWith("/proc/")
      ) {
        adjustments.push({
          type: "raise",
          amount: 10,
          reason: `Command targets system path outside project: ${path}`,
        });
        return;
      }

      if (context.cwd && !path.startsWith(context.cwd) && path.startsWith("/")) {
        adjustments.push({
          type: "raise",
          amount: 5,
          reason: `Command targets path outside current project directory`,
        });
        return;
      }
    }
  }

  private checkUnusualForProjectType(
    command: string,
    context: CommandContext,
    adjustments: ContextAdjustment[]
  ): void {
    if (!context.projectType) return;

    const unusualCombinations: Record<string, RegExp[]> = {
      python: [/\bnpm\b/, /\bcargo\b/, /\bgradle\b/],
      node: [/\bpip3?\b/, /\bcargo\b/, /\bgradle\b/],
      rust: [/\bnpm\b/, /\bpip3?\b/, /\bgradle\b/],
      java: [/\bnpm\b/, /\bpip3?\b/, /\bcargo\b/],
    };

    const patterns = unusualCombinations[context.projectType.toLowerCase()];
    if (!patterns) return;

    for (const pattern of patterns) {
      if (pattern.test(command)) {
        adjustments.push({
          type: "raise",
          amount: 5,
          reason: `Unusual tool for ${context.projectType} project`,
        });
        return;
      }
    }
  }

  private checkGitRepoSafety(
    command: string,
    context: CommandContext,
    adjustments: ContextAdjustment[]
  ): void {
    if (!context.isGitRepo) return;

    // In a git repo, some destructive commands are less risky because you can recover
    if (/\brm\b/.test(command) && !/\brm\b.*-rf\s+\.git\b/.test(command)) {
      adjustments.push({
        type: "lower",
        amount: 5,
        reason: "File removal in git repo — changes can be recovered from version control",
      });
    }
  }

  private buildAdjustedReasoning(
    original: RiskAssessment,
    adjustments: ContextAdjustment[],
    adjustedRisk: number,
    recommendation: "allow" | "warn" | "block"
  ): string {
    if (adjustments.length === 0) return original.reasoning;

    const parts = [original.reasoning];
    parts.push(
      `Context adjustments applied (${adjustments.length}): ` +
        adjustments
          .map(
            (a) =>
              `${a.type === "lower" ? "-" : "+"}${a.amount} (${a.reason})`
          )
          .join("; ") +
        "."
    );
    parts.push(`Adjusted risk: ${adjustedRisk}/100, recommendation: ${recommendation}.`);

    return parts.join(" ");
  }
}
