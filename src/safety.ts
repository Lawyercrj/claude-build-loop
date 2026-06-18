import { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// Where the loop writes its append-only audit log. Override with AUDIT_LOG_PATH;
// the default is resolved relative to where you run the loop (i.e. ./logs/audit.log).
export const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ?? "logs/audit.log";

// ---------------------------------------------------------------------------
// Audit log — append-only
// ---------------------------------------------------------------------------

export function appendAuditLog(line: string): void {
  mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
  appendFileSync(AUDIT_LOG_PATH, line + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Telegram alert — reads token/chatId from env; falls back to console
// ---------------------------------------------------------------------------

export async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn(`[SAFETY ALERT] ${message}`);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: message }),
    });
  } catch (err) {
    console.warn(`[SAFETY ALERT — Telegram send failed] ${message}`, err);
  }
}

// ---------------------------------------------------------------------------
// Helper — build a deny response
// ---------------------------------------------------------------------------

function deny(hookEventName: string, reason: string) {
  return {
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
}

// ---------------------------------------------------------------------------
// Deletion patterns — word-boundary safe, won't match "perform" etc.
// ---------------------------------------------------------------------------

const DELETION_PATTERNS: RegExp[] = [
  /\brm\s+/,               // rm, rm -rf, sudo rm …
  /\brmdir\b/,
  /\bunlink\b/,
  /\bgit\s+rm\b/,
  /\bfind\b.*\s-delete\b/, // find … -delete
];

// ---------------------------------------------------------------------------
// Destructive git patterns
// ---------------------------------------------------------------------------

const DESTRUCTIVE_GIT_PATTERNS: RegExp[] = [
  /\bgit\s+push\b.*\s(--force|-f)\b/, // force-push
  /\bgit\s+reset\s+--hard\b/,         // hard reset
  /\bgit\s+rebase\b/,                 // any rebase
];

// ---------------------------------------------------------------------------
// buildSafetyHooks — returns an options.hooks object for the executor query
// ---------------------------------------------------------------------------

export function buildSafetyHooks(targetRepo: string) {
  // (a) Block file deletion — the one unrecoverable action.
  const blockDeletion: HookCallback = async (input) => {
    const preInput = input as PreToolUseHookInput;
    const command = ((preInput.tool_input as Record<string, unknown>)?.command as string) ?? "";

    for (const pattern of DELETION_PATTERNS) {
      if (pattern.test(command)) {
        const reason = `File deletion is not allowed (matched: ${pattern}). Command: ${command.slice(0, 200)}`;
        const ts = new Date().toISOString();
        appendAuditLog(`${ts} [BLOCKED:deletion] ${command.slice(0, 500)}`);
        void sendTelegramAlert("⚠️ I stopped the contractor from deleting a file. The full command is in the audit log.");
        return deny(preInput.hook_event_name, reason);
      }
    }
    return {};
  };

  // (b) Block commits to main/master.
  const blockCommitToMain: HookCallback = async (input) => {
    const preInput = input as PreToolUseHookInput;
    const command = ((preInput.tool_input as Record<string, unknown>)?.command as string) ?? "";

    if (!/\bgit\s+commit\b/.test(command)) return {};

    let branch = "(unknown)";
    try {
      branch = execSync(
        `git -C "${targetRepo}" rev-parse --abbrev-ref HEAD`,
        { encoding: "utf8", timeout: 5000 }
      ).trim();
    } catch {
      const reason = "Cannot determine current branch — blocking commit to be safe.";
      const ts = new Date().toISOString();
      appendAuditLog(`${ts} [BLOCKED:unknown-branch] ${command.slice(0, 500)}`);
      void sendTelegramAlert("⚠️ I stopped a commit because I couldn't tell which branch we're on. The full command is in the audit log.");
      return deny(preInput.hook_event_name, reason);
    }

    if (branch === "main" || branch === "master") {
      const reason = `Commits to '${branch}' are not allowed.`;
      const ts = new Date().toISOString();
      appendAuditLog(`${ts} [BLOCKED:commit-to-${branch}] ${command.slice(0, 500)}`);
      void sendTelegramAlert("⚠️ I stopped the contractor from committing directly to your main branch. The full command is in the audit log.");
      return deny(preInput.hook_event_name, reason);
    }

    return {};
  };

  // (c) Block destructive git operations.
  const blockDestructiveGit: HookCallback = async (input) => {
    const preInput = input as PreToolUseHookInput;
    const command = ((preInput.tool_input as Record<string, unknown>)?.command as string) ?? "";

    for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
      if (pattern.test(command)) {
        const reason = `Destructive git operation is not allowed (matched: ${pattern}). Command: ${command.slice(0, 200)}`;
        const ts = new Date().toISOString();
        appendAuditLog(`${ts} [BLOCKED:destructive-git] ${command.slice(0, 500)}`);
        void sendTelegramAlert("⚠️ I stopped the contractor from doing a work-losing git operation (force-push or hard reset). The full command is in the audit log.");
        return deny(preInput.hook_event_name, reason);
      }
    }
    return {};
  };

  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [blockDeletion, blockCommitToMain, blockDestructiveGit],
      },
    ],
  };
}
