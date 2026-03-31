/**
 * Observability & Metrics Layer - Alert Manager
 *
 * Evaluates alert rules against aggregated metrics, manages alert lifecycle,
 * supports acknowledgment and cooldown periods.
 */

import type { AggregatedMetric } from "./metricsCollector";

export interface Alert {
  id: string;
  severity: "info" | "warning" | "error" | "critical";
  source: string;
  message: string;
  timestamp: number;
  acknowledged: boolean;
  metadata?: Record<string, any>;
}

export interface AlertRule {
  name: string;
  condition: (metrics: Map<string, AggregatedMetric>) => boolean;
  severity: Alert["severity"];
  message: string;
  cooldownMs: number;
}

let alertIdCounter = 0;

function generateAlertId(): string {
  return `alert_${Date.now()}_${++alertIdCounter}`;
}

export class AlertManager {
  private rules: AlertRule[] = [];
  private activeAlerts: Map<string, Alert> = new Map();
  private alertHistory: Alert[] = [];
  private lastFired: Map<string, number> = new Map(); // rule name -> timestamp

  /**
   * Add an alert rule.
   */
  addRule(rule: AlertRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluate all rules against current metrics. Returns newly triggered alerts.
   */
  evaluate(metrics: Map<string, AggregatedMetric>): Alert[] {
    const newAlerts: Alert[] = [];
    const now = Date.now();

    for (const rule of this.rules) {
      // Check cooldown
      const lastFiredAt = this.lastFired.get(rule.name) ?? 0;
      if (now - lastFiredAt < rule.cooldownMs) continue;

      try {
        if (rule.condition(metrics)) {
          const alert: Alert = {
            id: generateAlertId(),
            severity: rule.severity,
            source: rule.name,
            message: rule.message,
            timestamp: now,
            acknowledged: false,
          };
          this.activeAlerts.set(alert.id, alert);
          this.alertHistory.push(alert);
          this.lastFired.set(rule.name, now);
          newAlerts.push(alert);
        }
      } catch {
        // Rule evaluation failed; skip silently
      }
    }

    return newAlerts;
  }

  /**
   * Get all currently active (unacknowledged) alerts.
   */
  getActiveAlerts(): Alert[] {
    return [...this.activeAlerts.values()].filter((a) => !a.acknowledged);
  }

  /**
   * Acknowledge an alert by ID (removes from active).
   */
  acknowledge(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) return false;
    alert.acknowledged = true;
    this.activeAlerts.delete(alertId);
    return true;
  }

  /**
   * Get recent alert history.
   */
  getAlertHistory(limit = 100): Alert[] {
    return this.alertHistory.slice(-limit);
  }

  /**
   * Register all built-in alert rules.
   */
  registerBuiltinRules(): void {
    // High failure rate: tool success rate < 50% over last 20 calls
    this.addRule({
      name: "high_failure_rate",
      condition: (metrics) => {
        const successRate = metrics.get("tool.success_rate");
        if (!successRate) return false;
        return successRate.avg < 50 && successRate.count >= 20;
      },
      severity: "error",
      message: "Tool success rate below 50% over recent calls",
      cooldownMs: 60_000,
    });

    // Context overflow imminent: predicted to exceed 90% within 2 turns
    this.addRule({
      name: "context_overflow_imminent",
      condition: (metrics) => {
        const usage = metrics.get("context.usage_percent");
        const growth = metrics.get("context.growth_rate");
        if (!usage || !growth) return false;
        const predicted = usage.avg + growth.avg * 2;
        return predicted > 90;
      },
      severity: "warning",
      message: "Context predicted to exceed 90% within 2 turns",
      cooldownMs: 30_000,
    });

    // Trust anomaly: score dropped >30 points in one session
    this.addRule({
      name: "trust_anomaly",
      condition: (metrics) => {
        const trust = metrics.get("trust.score");
        if (!trust || trust.count < 2) return false;
        return trust.max - trust.min > 30;
      },
      severity: "warning",
      message: "Trust score dropped more than 30 points in this session",
      cooldownMs: 120_000,
    });

    // Cost spike: session cost > 2x rolling average
    this.addRule({
      name: "cost_spike",
      condition: (metrics) => {
        const cost = metrics.get("session.cost");
        if (!cost || cost.count < 3) return false;
        // Latest value approximated by max; average is rolling
        return cost.max > cost.avg * 2;
      },
      severity: "warning",
      message: "Session cost exceeds 2x the rolling average",
      cooldownMs: 300_000,
    });

    // Agent stuck: no progress for > 60 seconds
    this.addRule({
      name: "agent_stuck",
      condition: (metrics) => {
        const lastAction = metrics.get("agent.last_action_age_ms");
        if (!lastAction) return false;
        return lastAction.max > 60_000;
      },
      severity: "error",
      message: "Agent appears stuck - no progress for over 60 seconds",
      cooldownMs: 60_000,
    });
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this.rules = [];
    this.activeAlerts.clear();
    this.alertHistory = [];
    this.lastFired.clear();
  }
}
