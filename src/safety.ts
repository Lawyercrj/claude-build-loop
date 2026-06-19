import { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { appendFileSync, mkdirSync, realpathSync } from "fs";
import { dirname, resolve, isAbsolute, join, basename, sep } from "path";

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
// Deletion / truncation patterns — word-boundary safe, won't match "perform"
// or "format". Covers outright deletion plus in-place truncation/overwrite of
// existing files (truncate, dd).
//
// NOTE: plain shell redirection (`> file`, `>> file`) is deliberately NOT
// matched here. Catching it reliably needs a real shell parser (quoting,
// here-docs, `2>&1`, process substitution …); a naive regex produces too many
// false positives/negatives. See README "Safety" for this known limitation.
// ---------------------------------------------------------------------------

const DELETION_PATTERNS: RegExp[] = [
  /\brm\s+/,                // rm, rm -rf, sudo rm …
  /\brmdir\b/,
  /\bunlink\b/,
  /\bgit\s+rm\b/,
  /\bfind\b.*\s-delete\b/,  // find … -delete
  /\btruncate\b/,           // truncate -s 0 file
  /\bdd\b/,                 // dd if=… of=existing-file (clobbers contents)
];

// ---------------------------------------------------------------------------
// Destructive git patterns — operations that can silently discard committed or
// working-tree work.
// ---------------------------------------------------------------------------

const DESTRUCTIVE_GIT_PATTERNS: RegExp[] = [
  /\bgit\s+push\b.*\s(--force|-f)\b/, // force-push
  /\bgit\s+reset\s+--hard\b/,         // hard reset
  /\bgit\s+rebase\b/,                 // any rebase
  /\bgit\s+clean\b/,                  // git clean -fd — wipes untracked files
  /\bgit\s+stash\b/,                  // git stash — hides working-tree changes
  /\bgit\s+checkout\b/,               // branch switch OR `checkout -- <file>` discard
  /\bgit\s+switch\b/,                 // modern branch switch
  /\bgit\s+restore\b/,                // modern working-tree discard
];

// ---------------------------------------------------------------------------
// Pattern classifiers — exported so the safety rules can be unit-tested
// directly without spinning up a query. Each returns the matched RegExp (for
// the deny reason) or null when nothing matched.
// ---------------------------------------------------------------------------

export function matchDeletion(command: string): RegExp | null {
  return DELETION_PATTERNS.find((p) => p.test(command)) ?? null;
}

export function matchDestructiveGit(command: string): RegExp | null {
  return DESTRUCTIVE_GIT_PATTERNS.find((p) => p.test(command)) ?? null;
}

// ---------------------------------------------------------------------------
// Path containment — resolve symlinks for the longest existing prefix of a
// path, then append the not-yet-created tail. This defeats both `..` traversal
// (path.resolve normalises it) and symlink escape (realpathSync follows links).
// Files that don't exist yet (a fresh Write) still resolve correctly because we
// only realpath the existing ancestors.
// ---------------------------------------------------------------------------

function realResolve(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  // Walk up until we hit a path that exists, realpath it, then re-attach the
  // segments we peeled off.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p); // reached root; nothing existed
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * True when `candidate` (relative to `targetRepo`, or absolute) resolves to a
 * location inside `targetRepo`. Symlinks and `..` are resolved first.
 */
export function pathIsInsideRepo(targetRepo: string, candidate: string): boolean {
  if (!candidate) return false;
  const repoReal = realResolve(targetRepo);
  const abs = isAbsolute(candidate) ? candidate : resolve(targetRepo, candidate);
  const candReal = realResolve(abs);
  return candReal === repoReal || candReal.startsWith(repoReal + sep);
}

// ---------------------------------------------------------------------------
// buildSafetyHooks — returns an options.hooks object for the executor query
// ---------------------------------------------------------------------------

export function buildSafetyHooks(targetRepo: string) {
  // (a) Block file deletion / truncation — the unrecoverable actions.
  const blockDeletion: HookCallback = async (input) => {
    const preInput = input as PreToolUseHookInput;
    const command = ((preInput.tool_input as Record<string, unknown>)?.command as string) ?? "";

    const matched = matchDeletion(command);
    if (matched) {
      const reason = `File deletion/truncation is not allowed (matched: ${matched}). Command: ${command.slice(0, 200)}`;
      const ts = new Date().toISOString();
      appendAuditLog(`${ts} [BLOCKED:deletion] ${command.slice(0, 500)}`);
      void sendTelegramAlert("⚠️ I stopped the contractor from deleting or truncating a file. The full command is in the audit log.");
      return deny(preInput.hook_event_name, reason);
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

    const matched = matchDestructiveGit(command);
    if (matched) {
      const reason = `Destructive git operation is not allowed (matched: ${matched}). Command: ${command.slice(0, 200)}`;
      const ts = new Date().toISOString();
      appendAuditLog(`${ts} [BLOCKED:destructive-git] ${command.slice(0, 500)}`);
      void sendTelegramAlert("⚠️ I stopped the contractor from a work-losing git operation (e.g. force-push, hard reset, clean, stash, checkout/restore). The full command is in the audit log.");
      return deny(preInput.hook_event_name, reason);
    }
    return {};
  };

  // (d) Keep Write/Edit inside the target repo — no escaping via absolute
  //     paths, `..` traversal, or symlinks. The executor runs in acceptEdits
  //     mode, so without this an absolute path could clobber any file on disk.
  const blockPathEscape: HookCallback = async (input) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = (preInput.tool_input as Record<string, unknown>) ?? {};
    const filePath = (toolInput.file_path as string) ?? "";

    if (filePath && pathIsInsideRepo(targetRepo, filePath)) return {};

    const reason = filePath
      ? `Write/Edit outside the target repo is not allowed. Path: ${filePath.slice(0, 200)}`
      : "Write/Edit with no file_path is not allowed.";
    const ts = new Date().toISOString();
    appendAuditLog(`${ts} [BLOCKED:path-escape] ${filePath.slice(0, 500) || "(missing file_path)"}`);
    void sendTelegramAlert("⚠️ I stopped the contractor from writing to a file outside your project folder. The full path is in the audit log.");
    return deny(preInput.hook_event_name, reason);
  };

  return {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [blockDeletion, blockCommitToMain, blockDestructiveGit],
      },
      {
        matcher: "Write|Edit",
        hooks: [blockPathEscape],
      },
    ],
  };
}
