/**
 * Security Sandbox Analyzer - Command Risk Scorer
 *
 * Static analysis of shell commands to detect security risks
 * beyond what tree-sitter parsing catches.
 */

export type RiskCategory =
  | "data_exfiltration"
  | "file_destruction"
  | "privilege_escalation"
  | "network_access"
  | "code_execution"
  | "environment_modification"
  | "supply_chain"
  | "information_disclosure";

export interface RiskFactor {
  category: RiskCategory;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence: string;
}

export interface RiskAssessment {
  command: string;
  overallRisk: number; // 0-100
  factors: RiskFactor[];
  recommendation: "allow" | "warn" | "block";
  reasoning: string;
}

export type DetectorFn = (command: string) => RiskFactor[];

const SEVERITY_WEIGHTS: Record<RiskFactor["severity"], number> = {
  low: 10,
  medium: 25,
  high: 50,
  critical: 80,
};

// ── Built-in detectors ────────────────────────────────────────────────

function detectDataExfiltration(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // curl/wget POST with file read pipes
  if (
    /\b(curl|wget)\b.*(-X\s*POST|--data|--upload-file|-d\s)/.test(command) &&
    /(<\s*\/|\bcat\b|\bread\b)/.test(command)
  ) {
    factors.push({
      category: "data_exfiltration",
      severity: "critical",
      description: "HTTP POST with local file content — potential data exfiltration",
      evidence: command,
    });
  }

  // Piping file content to curl/wget
  if (/\bcat\b.*\|\s*(curl|wget)\b/.test(command)) {
    factors.push({
      category: "data_exfiltration",
      severity: "critical",
      description: "Piping file content to HTTP client",
      evidence: command,
    });
  }

  // nc (netcat) sending data
  if (/\bnc\b.*(-e|-c|\|)/.test(command) || /\|\s*nc\b/.test(command)) {
    factors.push({
      category: "data_exfiltration",
      severity: "high",
      description: "Netcat used for data transfer — possible exfiltration",
      evidence: command,
    });
  }

  // base64 encoding chains (often used to obfuscate exfiltration)
  if (/\bbase64\b/.test(command) && /\b(curl|wget|nc)\b/.test(command)) {
    factors.push({
      category: "data_exfiltration",
      severity: "high",
      description: "Base64 encoding combined with network tool — obfuscated exfiltration pattern",
      evidence: command,
    });
  }

  // DNS exfiltration pattern
  if (/\b(dig|nslookup|host)\b.*\$\(/.test(command)) {
    factors.push({
      category: "data_exfiltration",
      severity: "high",
      description: "DNS query with command substitution — possible DNS exfiltration",
      evidence: command,
    });
  }

  return factors;
}

function detectFileDestruction(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // rm -rf with dangerous targets
  if (/\brm\b.*-[a-zA-Z]*r[a-zA-Z]*f|rm\b.*-[a-zA-Z]*f[a-zA-Z]*r/.test(command)) {
    const isRoot = /\brm\b.*\s+\/\s*$|\brm\b.*\s+\/[^a-zA-Z]/.test(command);
    const isWildcard = /\brm\b.*\s+\*/.test(command);
    const isHome = /\brm\b.*~|\brm\b.*\$HOME/.test(command);

    if (isRoot) {
      factors.push({
        category: "file_destruction",
        severity: "critical",
        description: "Recursive forced removal targeting root filesystem",
        evidence: command,
      });
    } else if (isHome) {
      factors.push({
        category: "file_destruction",
        severity: "critical",
        description: "Recursive forced removal targeting home directory",
        evidence: command,
      });
    } else if (isWildcard) {
      factors.push({
        category: "file_destruction",
        severity: "high",
        description: "Recursive forced removal with wildcard",
        evidence: command,
      });
    } else {
      factors.push({
        category: "file_destruction",
        severity: "medium",
        description: "Recursive forced file removal",
        evidence: command,
      });
    }
  }

  // find -delete
  if (/\bfind\b.*-delete/.test(command)) {
    factors.push({
      category: "file_destruction",
      severity: "high",
      description: "find with -delete flag — bulk file removal",
      evidence: command,
    });
  }

  // truncate
  if (/\btruncate\b/.test(command)) {
    factors.push({
      category: "file_destruction",
      severity: "medium",
      description: "File truncation — data loss risk",
      evidence: command,
    });
  }

  // dd writing to devices or overwriting files
  if (/\bdd\b.*of=/.test(command)) {
    const isDevice = /\bdd\b.*of=\/dev\//.test(command);
    factors.push({
      category: "file_destruction",
      severity: isDevice ? "critical" : "high",
      description: isDevice
        ? "dd writing to device — possible disk destruction"
        : "dd overwriting file — data loss risk",
      evidence: command,
    });
  }

  // shred
  if (/\bshred\b/.test(command)) {
    factors.push({
      category: "file_destruction",
      severity: "high",
      description: "Secure file shredding — irrecoverable data destruction",
      evidence: command,
    });
  }

  // mkfs
  if (/\bmkfs\b/.test(command)) {
    factors.push({
      category: "file_destruction",
      severity: "critical",
      description: "Filesystem creation — will destroy existing data on device",
      evidence: command,
    });
  }

  // > overwrite to important files
  if (/>\s*\/(etc|boot|usr|sys|proc)\//.test(command)) {
    factors.push({
      category: "file_destruction",
      severity: "critical",
      description: "Redirecting output to system-critical path",
      evidence: command,
    });
  }

  return factors;
}

function detectPrivilegeEscalation(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // sudo
  if (/\bsudo\b/.test(command)) {
    factors.push({
      category: "privilege_escalation",
      severity: "high",
      description: "Command executed with sudo — elevated privileges",
      evidence: command,
    });
  }

  // su
  if (/\bsu\b\s+(-|\w)/.test(command)) {
    factors.push({
      category: "privilege_escalation",
      severity: "high",
      description: "User switching via su",
      evidence: command,
    });
  }

  // chmod 777 or setuid
  if (/\bchmod\b.*777/.test(command)) {
    factors.push({
      category: "privilege_escalation",
      severity: "high",
      description: "Setting world-writable permissions (777)",
      evidence: command,
    });
  }

  if (/\bchmod\b.*\+s|\bchmod\b.*[2-7][0-7]{3}/.test(command)) {
    // setuid/setgid check (simplified)
    if (/\bchmod\b.*\+s|\bchmod\b.*[46][0-7]{3}/.test(command)) {
      factors.push({
        category: "privilege_escalation",
        severity: "critical",
        description: "Setting setuid/setgid bit — privilege escalation vector",
        evidence: command,
      });
    }
  }

  // chown
  if (/\bchown\b.*root/.test(command)) {
    factors.push({
      category: "privilege_escalation",
      severity: "high",
      description: "Changing file ownership to root",
      evidence: command,
    });
  }

  // visudo / editing sudoers
  if (/\bvisudo\b|sudoers/.test(command)) {
    factors.push({
      category: "privilege_escalation",
      severity: "critical",
      description: "Modifying sudoers configuration",
      evidence: command,
    });
  }

  return factors;
}

function detectNetworkAccess(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  const isLocalhost =
    /\b(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)\b/.test(command);

  // curl/wget to non-localhost
  if (/\b(curl|wget)\b/.test(command) && !isLocalhost) {
    factors.push({
      category: "network_access",
      severity: "medium",
      description: "HTTP request to external host",
      evidence: command,
    });
  }

  // ssh
  if (/\bssh\b/.test(command) && !/\bssh-keygen\b/.test(command)) {
    factors.push({
      category: "network_access",
      severity: "medium",
      description: "SSH connection to remote host",
      evidence: command,
    });
  }

  // scp
  if (/\bscp\b/.test(command)) {
    factors.push({
      category: "network_access",
      severity: "medium",
      description: "Secure copy to/from remote host",
      evidence: command,
    });
  }

  // rsync to remote
  if (/\brsync\b.*:/.test(command)) {
    factors.push({
      category: "network_access",
      severity: "medium",
      description: "Rsync to remote target",
      evidence: command,
    });
  }

  // opening sockets / listening
  if (/\bnc\b.*-l/.test(command) || /\bsocat\b/.test(command)) {
    factors.push({
      category: "network_access",
      severity: "high",
      description: "Opening network listener — possible reverse shell or data channel",
      evidence: command,
    });
  }

  return factors;
}

function detectCodeExecution(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // eval
  if (/\beval\b/.test(command)) {
    factors.push({
      category: "code_execution",
      severity: "high",
      description: "Shell eval — arbitrary code execution",
      evidence: command,
    });
  }

  // exec
  if (/\bexec\b/.test(command) && !/\bfind\b.*-exec/.test(command)) {
    factors.push({
      category: "code_execution",
      severity: "high",
      description: "exec replaces current process with arbitrary command",
      evidence: command,
    });
  }

  // source untrusted
  if (/\b(source|\.)\s+[<(|]/.test(command) || /\bsource\b.*http/.test(command)) {
    factors.push({
      category: "code_execution",
      severity: "critical",
      description: "Sourcing code from untrusted origin",
      evidence: command,
    });
  }

  // python -c / node -e with suspicious content
  if (/\bpython[23]?\s+-c\b/.test(command)) {
    const hasSuspicious =
      /\b(socket|subprocess|os\.system|exec|__import__)/.test(command);
    factors.push({
      category: "code_execution",
      severity: hasSuspicious ? "high" : "medium",
      description: `Inline Python execution${hasSuspicious ? " with suspicious modules" : ""}`,
      evidence: command,
    });
  }

  if (/\bnode\s+-e\b/.test(command)) {
    const hasSuspicious =
      /\b(child_process|exec|spawn|require\s*\(\s*['"]fs['"]\))/.test(command);
    factors.push({
      category: "code_execution",
      severity: hasSuspicious ? "high" : "medium",
      description: `Inline Node.js execution${hasSuspicious ? " with suspicious modules" : ""}`,
      evidence: command,
    });
  }

  // perl/ruby -e
  if (/\b(perl|ruby)\s+-e\b/.test(command)) {
    factors.push({
      category: "code_execution",
      severity: "medium",
      description: "Inline script execution",
      evidence: command,
    });
  }

  return factors;
}

function detectEnvironmentModification(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // export sensitive vars
  if (
    /\bexport\b.*(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AWS_|GCP_|AZURE_)/i.test(
      command
    )
  ) {
    factors.push({
      category: "environment_modification",
      severity: "high",
      description: "Exporting sensitive environment variable",
      evidence: command,
    });
  }

  // .bashrc/.profile writes
  if (
    />>?\s*~?\/?.*\.(bashrc|bash_profile|profile|zshrc|zprofile)/.test(command)
  ) {
    factors.push({
      category: "environment_modification",
      severity: "high",
      description: "Modifying shell profile — persistent environment change",
      evidence: command,
    });
  }

  // PATH manipulation
  if (/\bPATH\s*=/.test(command) || /\bexport\s+PATH\b/.test(command)) {
    factors.push({
      category: "environment_modification",
      severity: "medium",
      description: "PATH environment variable modification",
      evidence: command,
    });
  }

  // LD_PRELOAD (library injection)
  if (/\bLD_PRELOAD\b/.test(command)) {
    factors.push({
      category: "environment_modification",
      severity: "critical",
      description: "LD_PRELOAD manipulation — shared library injection",
      evidence: command,
    });
  }

  // crontab modification
  if (/\bcrontab\b/.test(command)) {
    factors.push({
      category: "environment_modification",
      severity: "high",
      description: "Crontab modification — persistent scheduled task",
      evidence: command,
    });
  }

  return factors;
}

function detectSupplyChain(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // curl | bash (or sh)
  if (/\b(curl|wget)\b.*\|\s*(bash|sh|zsh)\b/.test(command)) {
    factors.push({
      category: "supply_chain",
      severity: "critical",
      description: "Piping remote script directly to shell — classic supply chain attack vector",
      evidence: command,
    });
  }

  // npm install unknown (not from package.json context)
  if (/\bnpm\s+install\b/.test(command) && !/\bnpm\s+install\s*$/.test(command.trim())) {
    // installing specific packages (not just `npm install`)
    if (!/\b(--save-dev|-D|--dev)\b/.test(command)) {
      factors.push({
        category: "supply_chain",
        severity: "medium",
        description: "Installing npm package as production dependency",
        evidence: command,
      });
    } else {
      factors.push({
        category: "supply_chain",
        severity: "low",
        description: "Installing npm dev dependency",
        evidence: command,
      });
    }
  }

  // pip install
  if (/\bpip3?\s+install\b/.test(command)) {
    const hasUrl = /\bpip3?\s+install\b.*https?:/.test(command);
    const hasGit = /\bpip3?\s+install\b.*git\+/.test(command);
    factors.push({
      category: "supply_chain",
      severity: hasUrl || hasGit ? "high" : "medium",
      description: hasUrl || hasGit
        ? "Installing Python package from URL/git — unverified source"
        : "Installing Python package from PyPI",
      evidence: command,
    });
  }

  // gem install
  if (/\bgem\s+install\b/.test(command)) {
    factors.push({
      category: "supply_chain",
      severity: "medium",
      description: "Installing Ruby gem",
      evidence: command,
    });
  }

  // go install from non-standard source
  if (/\bgo\s+install\b/.test(command)) {
    factors.push({
      category: "supply_chain",
      severity: "medium",
      description: "Installing Go package",
      evidence: command,
    });
  }

  // cargo install
  if (/\bcargo\s+install\b/.test(command)) {
    factors.push({
      category: "supply_chain",
      severity: "low",
      description: "Installing Rust crate",
      evidence: command,
    });
  }

  return factors;
}

function detectInformationDisclosure(command: string): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // /etc/passwd, /etc/shadow
  if (/\bcat\b.*\/etc\/(passwd|shadow|group)/.test(command)) {
    factors.push({
      category: "information_disclosure",
      severity: "high",
      description: "Reading system user/password database",
      evidence: command,
    });
  }

  // env / printenv
  if (/\b(env|printenv)\b/.test(command) && !/\benv\b\s+\w+=/.test(command)) {
    factors.push({
      category: "information_disclosure",
      severity: "medium",
      description: "Dumping environment variables — may expose secrets",
      evidence: command,
    });
  }

  // AWS/GCP/Azure credential files
  if (
    /\bcat\b.*\.(aws|gcloud|azure)\/|\/\.aws\/credentials|\/\.config\/gcloud/.test(
      command
    )
  ) {
    factors.push({
      category: "information_disclosure",
      severity: "critical",
      description: "Reading cloud provider credential files",
      evidence: command,
    });
  }

  // SSH keys
  if (/\bcat\b.*\.ssh\/(id_|authorized_keys|known_hosts)/.test(command)) {
    factors.push({
      category: "information_disclosure",
      severity: "high",
      description: "Reading SSH key material",
      evidence: command,
    });
  }

  // .env files
  if (/\bcat\b.*\.env\b/.test(command)) {
    factors.push({
      category: "information_disclosure",
      severity: "high",
      description: "Reading .env file — likely contains secrets",
      evidence: command,
    });
  }

  // history
  if (/\b(history|cat\b.*\.bash_history|cat\b.*\.zsh_history)/.test(command)) {
    factors.push({
      category: "information_disclosure",
      severity: "medium",
      description: "Reading shell history — may contain secrets typed on command line",
      evidence: command,
    });
  }

  return factors;
}

// ── CommandRiskScorer ──────────────────────────────────────────────────

export class CommandRiskScorer {
  private detectors: Map<string, DetectorFn> = new Map();

  constructor() {
    this.detectors.set("data_exfiltration", detectDataExfiltration);
    this.detectors.set("file_destruction", detectFileDestruction);
    this.detectors.set("privilege_escalation", detectPrivilegeEscalation);
    this.detectors.set("network_access", detectNetworkAccess);
    this.detectors.set("code_execution", detectCodeExecution);
    this.detectors.set("environment_modification", detectEnvironmentModification);
    this.detectors.set("supply_chain", detectSupplyChain);
    this.detectors.set("information_disclosure", detectInformationDisclosure);
  }

  /**
   * Register a custom detector function.
   */
  registerDetector(name: string, detector: DetectorFn): void {
    this.detectors.set(name, detector);
  }

  /**
   * Remove a detector by name.
   */
  removeDetector(name: string): boolean {
    return this.detectors.delete(name);
  }

  /**
   * Assess the risk of a single command string.
   */
  assess(command: string): RiskAssessment {
    const trimmed = command.trim();
    if (!trimmed) {
      return {
        command,
        overallRisk: 0,
        factors: [],
        recommendation: "allow",
        reasoning: "Empty command",
      };
    }

    // Run all detectors
    const factors: RiskFactor[] = [];
    for (const detector of this.detectors.values()) {
      factors.push(...detector(trimmed));
    }

    // Compute overall risk (0-100)
    const overallRisk = this.computeOverallRisk(factors);

    // Determine recommendation
    const recommendation = this.computeRecommendation(overallRisk, factors);

    // Build reasoning
    const reasoning = this.buildReasoning(factors, overallRisk, recommendation);

    return {
      command,
      overallRisk,
      factors,
      recommendation,
      reasoning,
    };
  }

  private computeOverallRisk(factors: RiskFactor[]): number {
    if (factors.length === 0) return 0;

    // Sum weighted severity, but cap at 100
    let total = 0;
    for (const f of factors) {
      total += SEVERITY_WEIGHTS[f.severity];
    }

    // Bonus for multiple categories (compound risk)
    const uniqueCategories = new Set(factors.map((f) => f.category));
    if (uniqueCategories.size > 1) {
      total += (uniqueCategories.size - 1) * 5;
    }

    return Math.min(100, total);
  }

  private computeRecommendation(
    overallRisk: number,
    factors: RiskFactor[]
  ): "allow" | "warn" | "block" {
    // Any critical factor → block
    if (factors.some((f) => f.severity === "critical")) {
      return "block";
    }
    if (overallRisk >= 60) return "block";
    if (overallRisk >= 25) return "warn";
    return "allow";
  }

  private buildReasoning(
    factors: RiskFactor[],
    risk: number,
    rec: "allow" | "warn" | "block"
  ): string {
    if (factors.length === 0) {
      return "No security risks detected.";
    }

    const categories = [...new Set(factors.map((f) => f.category))];
    const maxSeverity = factors.reduce(
      (max, f) =>
        SEVERITY_WEIGHTS[f.severity] > SEVERITY_WEIGHTS[max]
          ? f.severity
          : max,
      factors[0].severity
    );

    const parts = [
      `Detected ${factors.length} risk factor(s) across ${categories.length} category/categories.`,
      `Highest severity: ${maxSeverity}.`,
      `Overall risk score: ${risk}/100.`,
      `Recommendation: ${rec}.`,
    ];

    if (rec === "block") {
      parts.push(
        "This command poses significant security risks and should not be executed without explicit user approval."
      );
    } else if (rec === "warn") {
      parts.push(
        "This command has moderate risk — user should verify intent before execution."
      );
    }

    return parts.join(" ");
  }
}
