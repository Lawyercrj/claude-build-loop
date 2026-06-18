# claude-build-loop

An automated build orchestrator powered by the [Claude Agent SDK]. It works
through a markdown **plan file** one step at a time: an **executor agent**
(Claude Sonnet) makes each change, a **reviewer agent** (Claude Opus) judges it
in plain English against the plan, and a human approves, requests changes, or
stops — from the terminal or from their phone via Telegram.

[Claude Agent SDK]: https://docs.anthropic.com/en/api/agent-sdk

> _An independent, community-built tool that uses the Claude Agent SDK. Not
> affiliated with, sponsored by, or endorsed by Anthropic._

## It drives a separate repo

This tool operates on a **target repository** that you point it at — it never
modifies its own folder. You set the target with the `TARGET_REPO` environment
variable; every change the loop makes lands in that repo, on a feature branch.

## Quickstart

**You'll need:** Node.js 18+, an Anthropic API key with available credit, and a
target repo you want the loop to work on (with a branch named
`chore/build-loop-smoke-test` already created in it for the included smoke test).

```bash
# 1. Clone and install
git clone https://github.com/Lawyercrj/claude-build-loop.git
cd claude-build-loop
npm install

# 2. Configure
cp .env.example .env.local
# then edit .env.local: set ANTHROPIC_API_KEY and TARGET_REPO

# 3. Run the smoke test (creates one test file in your target repo, with your approval)
npm run dev -- docs/plans/smoke-test.md
```

That's it — you'll see the reviewer's verdict and an approve / request-changes /
stop prompt. From here, write your own plan file in `docs/plans/` (see
[Plan files](#plan-files)).

## How it works

You describe a build as an ordered list of steps in a plan file. For each step
the loop:

1. **Records the base commit** once for that step — fixed even if the executor
   re-runs after a change request.
2. **Runs the executor** — an agent with Read/Write/Edit/Bash that makes the
   change and commits only the files it touched (never `git add -A`).
3. **Captures a clean diff** — `git diff <step-base> HEAD`, so unrelated
   untracked files never appear.
4. **Runs the reviewer** — a read-only agent with a custom system prompt that
   judges the diff against the plan and outputs a plain-English VERDICT.
5. **Prints a cost line** — executor + reviewer cost for the cycle and the
   running session total.
6. **Requests approval** via the active channel:
   - **Telegram**: sends the verdict with three inline buttons
     (✅ Approve / ✏️ Request changes / 🛑 Stop) plus the diff as a file.
   - **Terminal fallback**: prints the verdict and reads `y` / `n` / change
     text from stdin.
7. **Branches on the decision** — approve moves to the next step; stop ends the
   run; request-changes re-runs the executor with your feedback against the
   same fixed step base.
8. After all steps are approved it prints a completion summary naming the
   feature branch that's ready to merge.

## Plan files

Plan files live in `docs/plans/`. Each has a YAML frontmatter block (the
structured config) and a markdown body (the plain-English contract the reviewer
judges against).

```
---
name: my-build
branch: feat/my-feature-branch
steps:
  - id: step-1
    description: short human label shown in the terminal
    instruction: |
      Multi-line instruction sent verbatim to the executor agent.
      Tell it exactly what files to create or edit and how to commit them.
    review: deep        # deep (Opus) | light (Sonnet) | none — optional, defaults to deep
  - id: step-2
    description: another step
    instruction: |
      ...
---

# My Build — Plan Doc

Plain-English description of what this build is supposed to accomplish.
The reviewer reads this as the contract and checks every diff against it.
```

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Short identifier shown in logs and the completion message |
| `branch` | yes | Feature branch to work on in the target repo. Must already exist. |
| `steps` | yes | Ordered array of steps. Each needs `id`, `description`, `instruction`; `review` is optional. |

Pass the plan file's path as the first argument to `npm run dev`:

```
npm run dev -- docs/plans/smoke-test.md
```

The included `docs/plans/smoke-test.md` is a one-step plan that creates a single
test file — a safe way to confirm your setup works end to end. It expects a
branch named `chore/build-loop-smoke-test` to already exist in your target repo.

## Safety

The executor agent runs under `PreToolUse` hooks ([`src/safety.ts`](src/safety.ts))
that protect the target repo from unrecoverable actions. Each blocked command is
written to the audit log and an alert is sent. The hooks deny:

- **File deletion** — `rm`, `rmdir`, `unlink`, `git rm`, `find … -delete`
- **Commits to `main` or `master`**
- **Force-push** — `git push --force` / `-f`
- **Hard reset or rebase** — `git reset --hard`, `git rebase`

## Setup

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill it in:

```
ANTHROPIC_API_KEY=sk-ant-...      # required
TARGET_REPO=/path/to/your-repo    # required — the repo the loop drives
TELEGRAM_BOT_TOKEN=               # optional — leave blank for terminal approval
TELEGRAM_CHAT_ID=                 # optional — your personal chat ID
REVIEWER_MODEL=                   # optional — override the reviewer model
AUDIT_LOG_PATH=                   # optional — defaults to logs/audit.log
```

`.env.local` is git-ignored — it holds your secrets and should never be
committed. See `.env.example` for the full annotated list.

> **Models** are hardcoded in [`src/index.ts`](src/index.ts): Claude Sonnet runs
> the build steps, Claude Opus reviews them. Override the reviewer with
> `REVIEWER_MODEL`.

### Optional: Telegram approval

To approve from your phone instead of the terminal:

1. Message `@BotFather` → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message.
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find your `"id"`
   under `"from"` — that's your `TELEGRAM_CHAT_ID`.

The loop only acts on messages/taps from that exact chat ID. If either Telegram
variable is missing it falls back to terminal approval.

## Run

```bash
npm run dev -- docs/plans/smoke-test.md
```

Or after building:

```bash
npm run build
npm start -- docs/plans/smoke-test.md
```

## Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Main loop — plan loading, branch management, executor, reviewer, approval |
| `src/approval.ts` | `ApprovalChannel` interface, terminal + Telegram implementations |
| `src/reviewer-prompt.ts` | Reviewer system prompt (exported string) |
| `src/safety.ts` | PreToolUse safety hooks + audit log helpers |
| `.env.example` | Copyable template for `.env.local` |
| `docs/plans/smoke-test.md` | Starter plan — one-step smoke test |

## Contributing

Issues and pull requests are welcome.

- **Found a bug or have an idea?** Open an
  [issue](https://github.com/Lawyercrj/claude-build-loop/issues) — describe what
  you expected, what happened, and your Node version if it's a bug.
- **Want to send a change?** Open a pull request. Smaller, focused PRs are easier
  to review and land faster. For anything large, opening an issue first to discuss
  the direction saves everyone time.
- Please make sure `npm run build` passes before submitting.

This is a small, community-built tool — friendly contributions of any size are
appreciated.

## License

MIT — see the [LICENSE](LICENSE) file.
