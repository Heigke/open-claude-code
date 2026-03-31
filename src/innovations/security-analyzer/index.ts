/**
 * Innovation #10: Security Sandbox Analyzer
 *
 * Static analysis of commands before execution to detect risks
 * beyond what tree-sitter parsing catches.
 */

export {
  CommandRiskScorer,
  type RiskCategory,
  type RiskFactor,
  type RiskAssessment,
  type DetectorFn,
} from "./commandRiskScorer.js";

export {
  PatternDatabase,
  type DangerousPattern,
  type MatchResult,
} from "./patternDatabase.js";

export {
  ContextualAnalyzer,
  type CommandContext,
  type ContextualRisk,
  type ContextAdjustment,
} from "./contextualAnalyzer.js";

export {
  SecurityReport,
  type ReportSummary,
} from "./securityReport.js";

import { CommandRiskScorer } from "./commandRiskScorer.js";
import { PatternDatabase } from "./patternDatabase.js";
import { ContextualAnalyzer } from "./contextualAnalyzer.js";
import { SecurityReport } from "./securityReport.js";

/**
 * Factory function to create a fully-wired security analyzer instance.
 */
export function createSecurityAnalyzer() {
  const scorer = new CommandRiskScorer();
  const patterns = new PatternDatabase();
  const contextual = new ContextualAnalyzer(scorer);

  return {
    scorer,
    patterns,
    contextual,

    /**
     * Quick-assess a command with default settings.
     */
    assess(command: string) {
      return scorer.assess(command);
    },

    /**
     * Match a command against the pattern database.
     */
    matchPatterns(command: string) {
      return patterns.match(command);
    },

    /**
     * Assess with full contextual analysis.
     */
    assessInContext(
      command: string,
      context: {
        cwd: string;
        recentCommands?: string[];
        recentFiles?: string[];
        projectType?: string;
        isGitRepo?: boolean;
      }
    ) {
      return contextual.analyzeInContext(command, {
        cwd: context.cwd,
        recentCommands: context.recentCommands ?? [],
        recentFiles: context.recentFiles ?? [],
        projectType: context.projectType,
        isGitRepo: context.isGitRepo ?? false,
      });
    },

    /**
     * Assess a chain of commands.
     */
    assessChain(commands: string[]) {
      return contextual.getCommandChainRisk(commands);
    },

    /**
     * Build a report from multiple assessments.
     */
    createReport(commands: string[]) {
      const assessments = commands.map((cmd) => scorer.assess(cmd));
      return new SecurityReport(assessments);
    },
  };
}
