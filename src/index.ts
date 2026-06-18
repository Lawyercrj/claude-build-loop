import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "child_process";
import { readFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { dirname, resolve, join } from "path";
import { parse as parseYaml } from "yaml";
import { REVIEWER_PROMPT } from "./reviewer-prompt";
import {
  ApprovalChannel,
  TerminalApprovalChannel,
  TelegramApprovalChannel,
} from "./approval";
import { buildSafetyHooks, appendAuditLog, AUDIT_LOG_PATH, sendTelegramAlert } from "./safety";

// The repository the build loop drives. Set TARGET_REPO in .env.local to an
// absolute path to your own repo. The loop only ever writes to this repo —
// never to its own folder.
const TARGET_REPO = process.env.TARGET_REPO ?? "/absolute/path/to/your/target-repo";

// ---------------------------------------------------------------------------
// Plan file types
// ---------------------------------------------------------------------------

type ReviewLevel = "deep" | "light" | "none";

interface PlanStep {
  id: string;
  description: string;
  instruction: string;
  review: ReviewLevel;
}

interface Plan {
  name: string;
  branch: string;
  steps: PlanStep[];
  planDoc: string; // markdown body below the second ---
}

// ---------------------------------------------------------------------------
// Plan loader — reads a markdown file with YAML frontmatter
// ---------------------------------------------------------------------------

function loadPlan(filePath: string): Plan {
  const raw = readFileSync(resolve(filePath), "utf8");

  // Split on frontmatter markers. The file must start with ---.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error(
      `Plan file "${filePath}" does not have valid YAML frontmatter.\n` +
      `Expected the file to begin with --- and contain a closing --- on its own line.`
    );
  }

  const [, frontmatterRaw, planDoc] = match;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fm = parseYaml(frontmatterRaw) as any;

  if (typeof fm?.name !== "string" || !fm.name.trim()) {
    throw new Error(`Plan file "${filePath}": frontmatter must have a non-empty "name" string.`);
  }
  if (typeof fm?.branch !== "string" || !fm.branch.trim()) {
    throw new Error(`Plan file "${filePath}": frontmatter must have a non-empty "branch" string.`);
  }
  if (!Array.isArray(fm?.steps) || fm.steps.length === 0) {
    throw new Error(`Plan file "${filePath}": frontmatter must have a non-empty "steps" array.`);
  }

  const steps: PlanStep[] = fm.steps.map((s: unknown, i: number) => {
    const step = s as Record<string, unknown>;
    if (typeof step?.id !== "string" || !step.id.trim()) {
      throw new Error(`Plan file "${filePath}": step[${i}] must have a non-empty "id" string.`);
    }
    if (typeof step?.description !== "string" || !step.description.trim()) {
      throw new Error(`Plan file "${filePath}": step[${i}] must have a non-empty "description" string.`);
    }
    if (typeof step?.instruction !== "string" || !step.instruction.trim()) {
      throw new Error(`Plan file "${filePath}": step[${i}] must have a non-empty "instruction" string.`);
    }
    const rawReview = step.review;
    const review: ReviewLevel =
      rawReview === "light" || rawReview === "none" ? rawReview : "deep";
    return {
      id: step.id as string,
      description: step.description as string,
      instruction: (step.instruction as string).trim(),
      review,
    };
  });

  return { name: fm.name, branch: fm.branch, steps, planDoc: planDoc.trim() };
}

// ---------------------------------------------------------------------------
// Branch checkout — ensure the plan's branch is active on the target repo
// ---------------------------------------------------------------------------

function ensureBranch(repoPath: string, branch: string): void {
  const current = execSync(`git -C "${repoPath}" rev-parse --abbrev-ref HEAD`, {
    encoding: "utf8",
  }).trim();

  if (current === branch) return;

  // Verify the branch exists before attempting checkout.
  try {
    execSync(`git -C "${repoPath}" rev-parse --verify "${branch}"`, {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch {
    throw new Error(
      `Branch "${branch}" does not exist in ${repoPath}.\n` +
      `Create it first, then re-run:\n` +
      `  git -C "${repoPath}" checkout -b "${branch}" <base-branch>`
    );
  }

  execSync(`git -C "${repoPath}" checkout "${branch}"`, {
    encoding: "utf8",
    stdio: "pipe",
  });
  console.log(`Checked out existing branch: ${branch}`);
}

// ---------------------------------------------------------------------------
// Executor — runs one step; returns { text, cost }
// Safety hooks attached here only — reviewer gets none.
// ---------------------------------------------------------------------------

async function runStep(
  repoPath: string,
  instruction: string
): Promise<{ text: string; cost: number }> {
  const lines: string[] = [];
  let cost = 0;

  for await (const message of query({
    prompt: instruction,
    options: {
      cwd: repoPath,
      model: "claude-sonnet-4-6",
      allowedTools: ["Read", "Write", "Edit", "Bash"],
      permissionMode: "acceptEdits",
      maxTurns: 30,
      hooks: buildSafetyHooks(repoPath),
    },
  })) {
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            process.stdout.write(block.text);
            lines.push(block.text);
          }
        }
      }
    } else if (message.type === "result") {
      cost = message.total_cost_usd ?? 0;
      const summary = `\n[turns: ${message.num_turns}, cost: $${cost.toFixed(4)}]`;
      process.stdout.write(summary + "\n");
      lines.push(summary);
    }
  }

  return { text: lines.join(""), cost };
}

// ---------------------------------------------------------------------------
// Diff capture — commit-to-commit, no unrelated untracked noise
// ---------------------------------------------------------------------------

function captureStepDiff(repoPath: string, stepBase: string): string {
  return execSync(`git -C "${repoPath}" diff ${stepBase} HEAD`, {
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// Reviewer — read-only query; returns { text, cost }
// NO safety hooks — it's already restricted to read-only tools.
// ---------------------------------------------------------------------------

async function reviewStep(
  diffText: string,
  stepText: string,
  planDoc: string,
  model: string
): Promise<{ text: string; cost: number }> {
  const prompt = [
    "=== CURRENT STEP ===",
    stepText.trim(),
    "",
    "=== GIT DIFF FOR THIS STEP ===",
    diffText.trim() || "(empty diff — no changes detected)",
    "",
    "=== PLAN DOCS ===",
    planDoc.trim(),
  ].join("\n");

  const parts: string[] = [];
  let cost = 0;

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: REVIEWER_PROMPT,
      model: process.env.REVIEWER_MODEL ?? model,
      allowedTools: ["Read", "Glob", "Grep"],
      permissionMode: "dontAsk",
      maxTurns: 12,
    },
  })) {
    if (message.type === "assistant") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            parts.push(block.text);
          }
        }
      }
    } else if (message.type === "result") {
      cost = message.total_cost_usd ?? 0;
    }
  }

  return { text: parts.join("").trim(), cost };
}

// ---------------------------------------------------------------------------
// Shared scope rules — injected into every executor prompt (first-run + re-run)
// ---------------------------------------------------------------------------

function scopeRules(): string {
  return `Hard rules (non-negotiable):
- Do ONLY this step. If you notice anything else worth changing, report it in your final message and STOP — do NOT fix it.
- Inspect fully before concluding. A first-pass "this is broken" is often a misread — verify before acting.
- Stage only the files you change. Never run git add -A or git add .
- Never delete files.
- Commit with a descriptive message. Do not push.

End your response with a one-line confirmation of what you did, and an explicit note of anything you deliberately did NOT touch.`;
}

// ---------------------------------------------------------------------------
// Build the executor prompt for a fresh step run
// ---------------------------------------------------------------------------

function buildStepInstruction(step: PlanStep, branch: string): string {
  return `You are the executor in an automated build loop.

Target repository: ${TARGET_REPO}
Working branch: ${branch} — already checked out. Do NOT create or switch branches.

Your task — do ONLY this step, nothing else:
${step.instruction}

${scopeRules()}`.trim();
}

// ---------------------------------------------------------------------------
// Build a fresh re-run instruction when the operator requests a change
// ---------------------------------------------------------------------------

function buildChangeInstruction(
  originalInstruction: string,
  branch: string,
  currentDiff: string,
  changeRequest: string
): string {
  return `You are the executor in an automated build loop.

Target repository: ${TARGET_REPO}
Working branch: ${branch} — already checked out. Do NOT create or switch branches.

This step was already partially completed and committed. Here is the current diff of what has been done so far:

--- CURRENT DIFF ---
${currentDiff.trim() || "(nothing committed yet)"}
--- END DIFF ---

The operator has requested this change:
  ${changeRequest}

Make ONLY the adjustments needed to satisfy that request.

For reference, the original step instruction was:
--- ORIGINAL INSTRUCTION ---
${originalInstruction}
--- END ORIGINAL INSTRUCTION ---

${scopeRules()}`.trim();
}

// ---------------------------------------------------------------------------
// Context loader — reads every *.md in ./context/ relative to the loop root
// ---------------------------------------------------------------------------

function loadContextDocs(): string {
  const contextDir = join(__dirname, "..", "context");
  if (!existsSync(contextDir)) return "";

  const files = readdirSync(contextDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) return "";

  return files
    .map((f) => {
      const content = readFileSync(join(contextDir, f), "utf8").trim();
      return `=== context/${f} ===\n${content}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  // Resolve the plan file path from the CLI argument
  const planPath = process.argv[2];
  if (!planPath) {
    throw new Error(
      "No plan file specified.\nUsage: npm run dev -- <planPath>\nExample: npm run dev -- plans/ap-build-1-approval-chain.md"
    );
  }

  // Ensure logs/ directory exists
  mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });

  // Load and validate the plan
  const plan = loadPlan(planPath);

  // Select approval channel
  const hasTelegram =
    !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;
  let channel: ApprovalChannel;
  if (hasTelegram) {
    channel = new TelegramApprovalChannel();
    console.log("Approval channel: Telegram");
  } else {
    channel = new TerminalApprovalChannel();
    console.log("Approval channel: terminal (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)");
  }

  // Ensure the plan's branch is checked out
  ensureBranch(TARGET_REPO, plan.branch);

  console.log(`\n=== Agent Build Loop ===`);
  console.log(`Plan:        ${plan.name}  (${planPath})`);
  console.log(`Branch:      ${plan.branch}`);
  console.log(`Steps:       ${plan.steps.length}`);
  console.log(`Target repo: ${TARGET_REPO}`);
  console.log(`Audit log:   ${AUDIT_LOG_PATH}\n`);

  // Build reviewer docs once — plan body + any reference files in context/
  const contextContents = loadContextDocs();
  const reviewerPlanDoc = contextContents
    ? `${plan.planDoc}\n\n=== REFERENCE DOCS (context/) ===\n\n${contextContents}`
    : plan.planDoc;

  let sessionTotal = 0;
  let stoppedAtStep: string | null = null;

  // ---------------------------------------------------------------------------
  // Outer loop — one iteration per plan step
  // ---------------------------------------------------------------------------
  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex++) {
    const step = plan.steps[stepIndex];
    const stepNumber = stepIndex + 1;
    console.log(`\n--- Step ${step.id}: ${step.description} ---\n`);

    // Record fresh base commit for THIS step — fixed across re-runs of it
    const stepBase = execSync(`git -C "${TARGET_REPO}" rev-parse HEAD`, {
      encoding: "utf8",
    }).trim();

    let stepInstruction = buildStepInstruction(step, plan.branch);
    let cycleNumber = 0;

    // Inner loop — re-runs until approve or stop
    while (true) {
      cycleNumber++;

      // --- Executor ---
      console.log(`--- Executor running (step ${step.id}, cycle ${cycleNumber}) ---\n`);
      let executorCost: number;
      try {
        ({ cost: executorCost } = await runStep(TARGET_REPO, stepInstruction));
      } catch (execErr) {
        const msg = execErr instanceof Error ? execErr.message : String(execErr);
        const alert = `⚠️ The executor couldn't finish step ${stepNumber} (${step.description}) — hit its turn limit or errored: ${msg}. Stopping so a half-finished step isn't reviewed as if it were done. Re-run when ready.`;
        console.error(`\n[Executor error] ${msg}\n`);
        await sendTelegramAlert(alert);
        stoppedAtStep = step.id;
        break;
      }

      // --- Diff capture ---
      const diff = captureStepDiff(TARGET_REPO, stepBase);
      console.log("\n--- Step diff (vs step base commit) ---\n");
      console.log(diff || "(empty)");

      // --- Reviewer ---
      const stepText = `${step.description}\n\n${step.instruction}`;
      let verdict: string;
      let reviewerCost: number;
      let reviewLabel: string;

      if (step.review === "none") {
        verdict = `ℹ️ No model review (light step) — diff below, eyeball it.`;
        reviewerCost = 0;
        reviewLabel = "ℹ️ No model review";
        console.log("\n--- Reviewer skipped (review: none) ---\n");
      } else {
        const reviewModel = step.review === "light" ? "claude-sonnet-4-6" : "claude-opus-4-8";
        const effectiveModel = process.env.REVIEWER_MODEL ?? reviewModel;
        const modelShortName = effectiveModel.includes("opus") ? "Opus" : "Sonnet";
        reviewLabel = `🔍 Reviewer (${modelShortName})`;
        console.log(`\n--- Reviewer running (${effectiveModel}) ---\n`);
        try {
          ({ text: verdict, cost: reviewerCost } = await reviewStep(diff, stepText, reviewerPlanDoc, reviewModel));
        } catch (reviewErr) {
          const msg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
          console.warn(`\n[Reviewer error — non-fatal] ${msg}\n`);
          verdict = `⚠️ The reviewer couldn't finish its verdict for this step (hit its turn limit or errored). Diff is below — review manually.`;
          reviewerCost = 0;
        }
      }

      // --- Cost line ---
      const cycleCost = executorCost + reviewerCost;
      sessionTotal += cycleCost;
      console.log(
        `\n[cycle cost: executor $${executorCost.toFixed(4)} + reviewer $${reviewerCost.toFixed(4)} = $${cycleCost.toFixed(4)} | session total $${sessionTotal.toFixed(4)}]`
      );

      // --- Approval gate ---
      const decision = await channel.requestApproval(verdict, diff, {
        planName: plan.name,
        stepNumber,
        totalSteps: plan.steps.length,
        stepId: step.id,
        stepDescription: step.description,
        cycleNumber,
        reviewLabel,
        executorCost,
        reviewerCost,
        cycleCost,
        sessionTotal,
      });

      // --- Audit log ---
      const decisionText =
        decision.kind === "approve"
          ? "APPROVED"
          : decision.kind === "stop"
          ? "STOPPED"
          : `CHANGE REQUESTED: ${decision.change}`;

      appendAuditLog(
        [
          `\n=== ${new Date().toISOString()} | plan: ${plan.name} | step: ${step.id} (${step.description}) | cycle ${cycleNumber} ===`,
          `DECISION: ${decisionText}`,
          `VERDICT:\n${verdict}`,
          `DIFF:\n${diff.trim() || "(empty)"}`,
          `===`,
        ].join("\n")
      );

      if (decision.kind === "approve") {
        console.log(`\nStep ${step.id} APPROVED.`);
        break; // move to next step
      }

      if (decision.kind === "stop") {
        console.log(`\nSTOPPED at step ${step.id} by the operator.`);
        stoppedAtStep = step.id;
        break;
      }

      // request_changes — rebuild fresh instruction, keep stepBase fixed
      console.log(`\nChange requested: "${decision.change}" — re-running executor.\n`);
      stepInstruction = buildChangeInstruction(
        step.instruction,
        plan.branch,
        diff,
        decision.change
      );
    }

    if (stoppedAtStep !== null) break;
  }

  if (stoppedAtStep !== null) {
    console.log(`\nBuild stopped at step ${stoppedAtStep}. Branch: ${plan.branch}`);
  } else {
    console.log(
      `\nBUILD COMPLETE: ${plan.name}. ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"} approved. Feature branch ${plan.branch} ready to merge.`
    );
  }
}

main().catch((err) => {
  console.error("Build loop failed:", err);
  process.exit(1);
});
