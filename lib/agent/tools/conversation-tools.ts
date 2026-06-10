// Tools that exist for the conversational personal-assistant variant of the
// agent. These tools manage session state — which email we're on, whether
// we're done, and acting on previously-drafted replies.

import type { AgentTool } from "@/lib/agent/loop";
import { supabase } from "@/lib/supabase/client";
import { sendEmail, archiveMessage } from "@/lib/integrations/gmail-send";
import { getFreshGmailToken } from "@/lib/integrations/gmail-token";
import {
  completeFollowupLoopForSource,
  completePromiseLoopsForThread,
  rememberArchivedThread,
  rememberReplySent,
  rememberSkippedThread,
  rememberWrapReason,
} from "@/lib/assistant-memory";

export const pickNextItemTool: AgentTool = {
  name: "pick_next_item",
  description:
    "Commit which email you're surfacing next, before you speak about it. The UI uses this to display context (who it's from, when, what tier). Call this every time you move on to a new email.",
  input_schema: {
    type: "object",
    properties: {
      source_id: {
        type: "string",
        description: "The Gmail message id you're now talking about.",
      },
      from: { type: "string", description: "Display name of the sender." },
      subject: { type: "string", description: "Subject line." },
      tier: {
        type: "string",
        description:
          "Sender tier (business, family, wesleyan, vox_church, vendor_outreach, friend, opportunity, unknown).",
      },
      one_line_reason: {
        type: "string",
        description:
          "One sentence on why this is what to surface now (e.g. 'Pelumi has been waiting 8 days for confirmation on pricing').",
      },
    },
    required: ["source_id", "from", "subject", "one_line_reason"],
  },
  handler: async (input, ctx) => {
    const previous = ctx.scratch.current_item as
      | { source_id?: string; from?: string; subject?: string }
      | undefined;
    const sentIds = new Set(
      (((ctx.scratch.sent as unknown[]) || []) as Array<{ source_id: string }>).map(
        (item) => item.source_id
      )
    );
    const archivedIds = new Set(
      (
        ((ctx.scratch.archived as unknown[]) || []) as Array<{ source_id: string }>
      ).map((item) => item.source_id)
    );

    if (
      previous?.source_id &&
      previous.source_id !== input.source_id &&
      !sentIds.has(previous.source_id) &&
      !archivedIds.has(previous.source_id) &&
      previous.from &&
      previous.subject
    ) {
      await rememberSkippedThread({
        userId: ctx.userId,
        from: previous.from,
        subject: previous.subject,
      });
    }

    ctx.scratch.current_item = {
      source_id: input.source_id,
      from: input.from,
      subject: input.subject,
      tier: input.tier || "unknown",
      one_line_reason: input.one_line_reason,
    };
    return { ok: true };
  },
};

export const wrapSessionTool: AgentTool = {
  name: "wrap_session",
  description:
    "Call this when there's nothing else worth her time today. The session ends after your next spoken line. Don't pad — if she's caught up on the important stuff, wrap. The opportunity tier and noise tier should not keep the session alive on their own.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Brief reason — e.g. 'caught up on business and family, only opportunity-spam remains'.",
      },
    },
    required: ["reason"],
  },
  handler: async (input, ctx) => {
    ctx.scratch.done = true;
    ctx.scratch.wrap_reason = input.reason;
    await rememberWrapReason({
      userId: ctx.userId,
      reason: String(input.reason || "the important inbox items were handled"),
    });
    return { ok: true };
  },
};

export const sendDraftedReplyTool: AgentTool = {
  name: "send_drafted_reply",
  description:
    "Send a reply you previously drafted (via draft_reply) for a specific email. Only use after the user has clearly said 'send' or equivalent. The draft must already exist in cortex_actions for this source_id.",
  mutates: true,
  input_schema: {
    type: "object",
    properties: {
      source_id: { type: "string", description: "The original email's Gmail message id." },
    },
    required: ["source_id"],
  },
  handler: async (input, ctx) => {
    const sourceId = input.source_id as string;

    // Find the most recent pending draft for this source_id
    const { data: actions } = await supabase
      .from("cortex_actions")
      .select("id, action_data")
      .eq("user_id", ctx.userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);

    const action = (actions || []).find((a) => {
      const d = a.action_data as Record<string, unknown>;
      return d?.source_id === sourceId && d?.draft;
    });

    if (!action) {
      return { ok: false, error: "No pending drafted reply found for that email." };
    }

    const data = action.action_data as Record<string, string>;
    const fromHeader = data.from || "";
    const toEmail = (fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader).trim();
    if (!toEmail) {
      return { ok: false, error: "Couldn't parse recipient from original email." };
    }

    const subject = data.subject?.startsWith("Re:")
      ? data.subject
      : `Re: ${data.subject || ""}`;

    try {
      const accessToken = await getFreshGmailToken(ctx.userId);
      const result = await sendEmail(accessToken, {
        to: toEmail,
        subject,
        body: data.draft,
        threadId: data.threadId,
      });

      await supabase
        .from("cortex_actions")
        .update({
          status: "executed",
          executed_at: new Date().toISOString(),
          result: { messageId: result.messageId },
        })
        .eq("id", action.id);

      // Track in session scratch
      const sent = (ctx.scratch.sent as unknown[]) || [];
      sent.push({ source_id: sourceId, action_id: action.id, messageId: result.messageId });
      ctx.scratch.sent = sent;

      await Promise.all([
        rememberReplySent({
          userId: ctx.userId,
          from: data.from || toEmail,
          subject: data.subject || "(no subject)",
        }),
        completeFollowupLoopForSource(ctx.userId, sourceId),
        completePromiseLoopsForThread(ctx.userId, {
          threadId: data.threadId || null,
          recipient: toEmail,
        }),
      ]);

      return { ok: true, sent_to: toEmail, messageId: result.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },
};

export const archiveCurrentTool: AgentTool = {
  name: "archive_email",
  description:
    "Archive a specific email (removes the INBOX label in Gmail). Use when the user says 'archive' or when an email is clearly not worth keeping in front of them.",
  mutates: true,
  input_schema: {
    type: "object",
    properties: {
      source_id: { type: "string" },
    },
    required: ["source_id"],
  },
  handler: async (input, ctx) => {
    const sourceId = input.source_id as string;
    try {
      const accessToken = await getFreshGmailToken(ctx.userId);
      await archiveMessage(accessToken, sourceId);

      const archived = (ctx.scratch.archived as unknown[]) || [];
      archived.push({ source_id: sourceId });
      ctx.scratch.archived = archived;

      const current = ctx.scratch.current_item as
        | { from?: string; subject?: string; source_id?: string }
        | undefined;
      if (current?.source_id === sourceId && current.from && current.subject) {
        await rememberArchivedThread({
          userId: ctx.userId,
          from: current.from,
          subject: current.subject,
        });
      }
      await completeFollowupLoopForSource(ctx.userId, sourceId);

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },
};
