import * as readline from "readline";

// ---------------------------------------------------------------------------
// ApprovalChannel interface
// ---------------------------------------------------------------------------

export type ApprovalDecision =
  | { kind: "approve" }
  | { kind: "stop" }
  | { kind: "request_changes"; change: string };

export interface ApprovalContext {
  planName: string;
  stepNumber: number;   // 1-based
  totalSteps: number;
  stepId: string;
  stepDescription: string;
  cycleNumber: number;
  reviewLabel: string;
  executorCost: number;
  reviewerCost: number;
  cycleCost: number;
  sessionTotal: number;
}

export interface ApprovalChannel {
  requestApproval(recommendation: string, diff: string, ctx: ApprovalContext): Promise<ApprovalDecision>;
}

// ---------------------------------------------------------------------------
// TerminalApprovalChannel
// ---------------------------------------------------------------------------

function readLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export class TerminalApprovalChannel implements ApprovalChannel {
  async requestApproval(recommendation: string, _diff: string, ctx: ApprovalContext): Promise<ApprovalDecision> {
    console.log(`\n=== REVIEWER VERDICT | ${ctx.planName} | Step ${ctx.stepNumber}/${ctx.totalSteps}: ${ctx.stepDescription} (cycle ${ctx.cycleNumber}) ===\n`);
    console.log(recommendation);
    const answer = await readLine("\nApprove? [y / n / type a change request]: ");
    if (answer.toLowerCase() === "y") return { kind: "approve" };
    if (answer.toLowerCase() === "n") return { kind: "stop" };
    return { kind: "request_changes", change: answer };
  }
}

// ---------------------------------------------------------------------------
// TelegramApprovalChannel
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number };
    data: string;
    message?: { chat: { id: number } };
  };
  message?: {
    from?: { id: number };
    chat: { id: number };
    text?: string;
  };
}

interface TelegramSentMessage {
  message_id: number;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

// Throws with Telegram's error description if the HTTP status or ok flag indicates failure.
async function tgFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as TelegramResponse<T>;
  if (!res.ok || !body.ok) {
    throw new Error(
      `Telegram API error [${res.status}] ${body.description ?? "(no description)"} — URL: ${url.replace(/\/bot[^/]+\//, "/bot<token>/")}`
    );
  }
  return body.result;
}

export class TelegramApprovalChannel implements ApprovalChannel {
  private readonly baseUrl: string;
  private readonly chatId: number;
  private offset: number = 0;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.chatId = Number(chatId);
  }

  // Drain any updates that arrived before this call, advancing the offset.
  private async drainPendingUpdates(): Promise<void> {
    const updates = await tgFetch<TelegramUpdate[]>(
      `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=0`
    );
    if (updates.length > 0) {
      this.offset = updates[updates.length - 1].update_id + 1;
    }
  }

  // Long-poll for the next update from our chat.
  // Retries indefinitely on network drops and HTTP 5xx; fails fast on 401/403.
  private async pollNextUpdate(allowedTypes: ("callback_query" | "message")[]): Promise<TelegramUpdate> {
    let backoff = 2000;
    while (true) {
      try {
        const params = new URLSearchParams({
          offset: String(this.offset),
          timeout: "30",
          allowed_updates: JSON.stringify(allowedTypes),
        });
        const updates = await tgFetch<TelegramUpdate[]>(
          `${this.baseUrl}/getUpdates?${params}`
        );
        backoff = 2000; // reset on success
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const fromChat =
            update.callback_query?.message?.chat.id === this.chatId ||
            update.message?.chat.id === this.chatId;
          if (!fromChat) continue;
          return update;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Auth failures are unrecoverable — bad token or chat ID.
        if (/\[401\]|\[403\]/.test(msg)) {
          throw new Error(`Telegram auth failure — check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.\n${msg}`);
        }

        // Network drops, GOAWAY, 5xx, socket errors — log and retry.
        console.warn(`[Telegram] Connection dropped (${msg.slice(0, 120)}). Reconnecting in ${backoff / 1000}s…`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  private async sendMessage(text: string, extra?: object): Promise<{ message_id: number }> {
    return tgFetch<TelegramSentMessage>(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text, ...extra }),
    });
  }

  private async sendDiff(diff: string, caption: string): Promise<void> {
    if (!diff.trim()) {
      await this.sendMessage("(no diff — nothing changed in this step)");
      return;
    }
    const form = new FormData();
    form.append("chat_id", String(this.chatId));
    form.append(
      "document",
      new Blob([diff], { type: "text/plain" }),
      "step-diff.txt"
    );
    form.append("caption", caption);
    await tgFetch(`${this.baseUrl}/sendDocument`, { method: "POST", body: form });
  }

  private async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await tgFetch(`${this.baseUrl}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  }

  // Remove the inline keyboard from a verdict message once a tap is processed.
  // Failure is non-fatal — the message may be too old or already edited.
  private async clearInlineKeyboard(messageId: number): Promise<void> {
    try {
      await tgFetch(`${this.baseUrl}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }),
      });
    } catch (err) {
      console.warn(`[TelegramApprovalChannel] clearInlineKeyboard failed (non-fatal):`, err);
    }
  }

  async requestApproval(recommendation: string, diff: string, ctx: ApprovalContext): Promise<ApprovalDecision> {
    // 1. Drain stale updates so nothing old gets consumed as our answer.
    await this.drainPendingUpdates();

    // 2. Build the header and prepend it to the verdict message.
    const fmt = (n: number) => `$${n.toFixed(2)}`;
    const header = [
      `${ctx.reviewLabel} — step ${ctx.stepNumber}/${ctx.totalSteps}: ${ctx.stepDescription}  (cycle ${ctx.cycleNumber})`,
      `Cost — this cycle ${fmt(ctx.cycleCost)} (executor ${fmt(ctx.executorCost)} + reviewer ${fmt(ctx.reviewerCost)}) · session total ${fmt(ctx.sessionTotal)}`,
      "──────────────",
    ].join("\n");

    const verdictMessage = await this.sendMessage(`${header}\n${recommendation}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve",          callback_data: "approve" },
          { text: "✏️ Request changes",  callback_data: "request_changes" },
          { text: "🛑 Stop",             callback_data: "stop" },
        ]],
      },
    });

    // 3. Send the diff as a document with a contextual caption.
    const diffCaption = `Diff for step ${ctx.stepNumber}/${ctx.totalSteps}: ${ctx.stepDescription}`;
    await this.sendDiff(diff, diffCaption);

    // 4. Long-poll for a button tap. Include "message" so Telegram keeps queuing
    // text updates even while we're waiting for the button press — without it,
    // a reply typed immediately after tapping "Request changes" arrives while the
    // bot's allowed_updates subscription is still callback_query-only and is lost.
    while (true) {
      const update = await this.pollNextUpdate(["callback_query", "message"]);
      if (!update.callback_query) continue;

      await this.answerCallbackQuery(update.callback_query.id);

      // Disable the buttons immediately — stale taps on this verdict from a later
      // cycle would otherwise be consumed by a future drain or poll, requiring a
      // second tap on the next message.
      await this.clearInlineKeyboard(verdictMessage.message_id);

      const data = update.callback_query.data;

      if (data === "approve") return { kind: "approve" };
      if (data === "stop")    return { kind: "stop" };

      if (data === "request_changes") {
        // 5. Ask for the change text, then long-poll for a reply.
        await this.sendMessage("Reply with the change you want me to make.");
        while (true) {
          const replyUpdate = await this.pollNextUpdate(["message"]);
          if (replyUpdate.message?.text) {
            return { kind: "request_changes", change: replyUpdate.message.text };
          }
        }
      }
    }
  }
}
