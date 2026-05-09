// Tools the email-triage agent can call.
//
// Read tools run inline. Mutating tools (draft_reply, mark_for_attention,
// archive) write to cortex_actions(status='pending') so the human can approve
// in the UI before anything actually happens.

import type { AgentTool } from "@/lib/agent/loop";
import { supabase } from "@/lib/supabase/client";
import { draftEmailReply } from "@/lib/ai/email-drafter";
import {
  fetchAssembledMessageBySourceId,
  fetchInboxThreadSummaries,
  fetchRecentAssembledMessages,
  fetchThreadContextBySourceId,
} from "@/lib/email-state";
import { findLapsedPromises } from "@/lib/followups";
import {
  classifySender,
  TIER_TONE_GUIDANCE,
  type Tier,
} from "@/lib/agent/sender-tiers";

export const searchInboxTool: AgentTool = {
  name: "search_inbox",
  description:
    "List the latest received email from each active thread, optionally filtered to threads where the user still owes a reply. This is thread-aware: a thread only counts as unreplied if its latest received message is newer than the user's latest sent message in that thread. Default looks back 90 days.",
  input_schema: {
    type: "object",
    properties: {
      days_back: {
        type: "number",
        description: "How many days back to look. Default 90.",
      },
      unreplied_only: {
        type: "boolean",
        description:
          "If true, exclude threads where the user has already sent a reply. Default true.",
      },
      limit: {
        type: "number",
        description: "Max emails to return. Default 60.",
      },
    },
  },
  handler: async (input, ctx) => {
    const daysBack = (input.days_back as number) || 90;
    const unrepliedOnly = input.unreplied_only !== false;
    const limit = Math.min((input.limit as number) || 60, 200);

    return fetchInboxThreadSummaries(ctx.userId, {
      daysBack,
      unrepliedOnly,
      limit,
    });
  },
};

export const getEmailBodyTool: AgentTool = {
  name: "get_email_body",
  description:
    "Get the full body of a specific email by its source_id (Gmail message id), reassembled across stored chunks. Also returns recent thread context so you can see the back-and-forth before deciding or drafting.",
  input_schema: {
    type: "object",
    properties: {
      source_id: { type: "string" },
    },
    required: ["source_id"],
  },
  handler: async (input, ctx) => {
    const sourceId = input.source_id as string;
    const threadContext = await fetchThreadContextBySourceId(ctx.userId, sourceId);
    if (!threadContext) return { found: false };
    return {
      found: true,
      body: threadContext.message.content,
      metadata: threadContext.message.metadata,
      chunk_count: threadContext.message.chunk_count,
      threadId: threadContext.threadId,
      thread_context: threadContext.thread_context,
      recent_thread_messages: threadContext.messages.slice(-6).map((message) => ({
        source_id: message.source_id,
        content_type: message.content_type,
        from: (message.metadata.from as string) || "",
        to: (message.metadata.to as string) || "",
        subject: (message.metadata.subject as string) || "",
        date: message.source_created_at,
        excerpt: message.content.slice(0, 500),
      })),
    };
  },
};

export const getThreadContextTool: AgentTool = {
  name: "get_thread_context",
  description:
    "Get the latest email plus recent back-and-forth in its thread. Use this when you need the conversation context before drafting or when the user says 'read more'.",
  input_schema: getEmailBodyTool.input_schema,
  handler: getEmailBodyTool.handler,
};

export const getUserProfileTool: AgentTool = {
  name: "get_user_profile",
  description:
    "Get the user's stored profile — who they are, their tone, their relationships, their priorities. Read this once at the start so your decisions match how this user actually thinks.",
  input_schema: {
    type: "object",
    properties: {},
  },
  handler: async (_input, ctx) => {
    const { data } = await supabase
      .from("cortex_profiles")
      .select("profile_text, profile_structured")
      .eq("user_id", ctx.userId)
      .single();
    if (!data) {
      return { has_profile: false };
    }
    return {
      has_profile: true,
      profile_text: data.profile_text,
      structured: data.profile_structured,
    };
  },
};

export const listPastEmailsToRecipientTool: AgentTool = {
  name: "list_past_emails_to_recipient",
  description:
    "List up to 5 past emails the user previously SENT to a specific recipient. Use this before drafting a reply so you can match their actual voice and history with this person.",
  input_schema: {
    type: "object",
    properties: {
      recipient_email: { type: "string" },
    },
    required: ["recipient_email"],
  },
  handler: async (input, ctx) => {
    const recipient = (input.recipient_email as string).toLowerCase();
    const sentMessages = await fetchRecentAssembledMessages(ctx.userId, "email_sent", {
      daysBack: 365,
      maxHeads: 200,
    });
    const matches = sentMessages
      .filter((message) => {
        const to = ((message.metadata.to as string) || "").toLowerCase();
        return to.includes(recipient);
      })
      .slice(0, 5)
      .map((message) => ({
        date: message.source_created_at,
        excerpt: message.content.slice(0, 600),
      }));
    return { count: matches.length, examples: matches };
  },
};

// Mutating: enqueue a pre-drafted reply for human approval.
export const draftReplyTool: AgentTool = {
  name: "draft_reply",
  description:
    "Pre-draft a reply for a specific email and queue it for human approval. The user will review the draft and either send it, edit it, or skip. Use a one-line `reason_for_attention` to tell the user why this email needs them.",
  mutates: true,
  input_schema: {
    type: "object",
    properties: {
      source_id: {
        type: "string",
        description: "Gmail message id (from search_inbox).",
      },
      reason_for_attention: {
        type: "string",
        description:
          'One sentence on why this email matters and why now (e.g. "Prof Smith is waiting on the draft you said you\'d send Wednesday").',
      },
      direction: {
        type: "string",
        description:
          "Optional: brief instruction for what the reply should say. If omitted, the drafter will infer from the email content.",
      },
      priority: {
        type: "string",
        enum: ["high", "medium", "low"],
        description:
          "How urgent this is from the user's perspective. high = needs reply today.",
      },
    },
    required: ["source_id", "reason_for_attention", "priority"],
  },
  handler: async (input, ctx) => {
    const sourceId = input.source_id as string;
    const reason = input.reason_for_attention as string;
    const priority = input.priority as string;
    const direction = (input.direction as string) || undefined;

    const threadContext = await fetchThreadContextBySourceId(ctx.userId, sourceId);
    if (!threadContext) {
      return { ok: false, error: "Email not found" };
    }

    const meta = threadContext.message.metadata || {};
    const labels = (meta.labels as string[]) || [];
    const tier: Tier = classifySender({
      from: (meta.from as string) || "",
      subject: (meta.subject as string) || "",
      labels,
    }).tier;
    const tierGuidance = TIER_TONE_GUIDANCE[tier];

    const directionWithTone = direction
      ? `${direction}\n\nTONE GUIDANCE for this recipient (${tier}): ${tierGuidance}`
      : `TONE GUIDANCE for this recipient (${tier}): ${tierGuidance}`;

    const draftInput = threadContext.thread_context
      ? [
          "LATEST EMAIL TO REPLY TO:",
          threadContext.message.content,
          "",
          "RECENT THREAD CONTEXT:",
          threadContext.thread_context,
        ].join("\n")
      : threadContext.message.content;

    const draft = await draftEmailReply(ctx.userId, draftInput, {
      from: (meta.from as string) || "",
      subject: (meta.subject as string) || "",
      threadId: meta.threadId as string | undefined,
      intent: directionWithTone,
    });

    const { data: action, error } = await supabase
      .from("cortex_actions")
      .insert({
        user_id: ctx.userId,
        action_type: "send_email",
        status: "pending",
        action_data: {
          source: "voice-email-agent",
          source_id: sourceId,
          from: meta.from,
          subject: meta.subject,
          threadId: meta.threadId,
          draft,
          reason,
          priority,
          direction,
        },
      })
      .select("id")
      .single();

    if (error) return { ok: false, error: error.message };

    // Track on the scratchpad so the orchestrator can return a clean summary.
    const flagged = (ctx.scratch.flagged as unknown[]) || [];
    flagged.push({
      source_id: sourceId,
      from: meta.from,
      subject: meta.subject,
      threadId: meta.threadId,
      reason,
      priority,
      draft,
      tier,
      action_id: action?.id,
    });
    ctx.scratch.flagged = flagged;

    const drafted = (ctx.scratch.drafted as unknown[]) || [];
    drafted.push({
      source_id: sourceId,
      action_id: action?.id,
    });
    ctx.scratch.drafted = drafted;

    return { ok: true, action_id: action?.id, draft_preview: draft.slice(0, 200) };
  },
};

// Mutating: flag an email as needing the user's attention WITHOUT pre-drafting.
// For things like "you should look at this but I'm not sure what to say".
export const markForAttentionTool: AgentTool = {
  name: "mark_for_attention",
  description:
    "Flag an email as needing the user's attention without pre-drafting a reply. Use when the email needs a decision the user must make personally (e.g. accepting an invite, answering a question only they know).",
  mutates: true,
  input_schema: {
    type: "object",
    properties: {
      source_id: { type: "string" },
      reason_for_attention: { type: "string" },
      priority: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["source_id", "reason_for_attention", "priority"],
  },
  handler: async (input, ctx) => {
    const sourceId = input.source_id as string;
    const reason = input.reason_for_attention as string;
    const priority = input.priority as string;

    const message = await fetchAssembledMessageBySourceId(ctx.userId, sourceId);
    const meta = (message?.metadata as Record<string, unknown>) || {};
    const tier: Tier = classifySender({
      from: (meta.from as string) || "",
      subject: (meta.subject as string) || "",
      labels: (meta.labels as string[]) || [],
    }).tier;

    const flagged = (ctx.scratch.flagged as unknown[]) || [];
    flagged.push({
      source_id: sourceId,
      from: meta.from,
      subject: meta.subject,
      threadId: meta.threadId,
      reason,
      priority,
      draft: null,
      flag_only: true,
      tier,
    });
    ctx.scratch.flagged = flagged;

    return { ok: true };
  },
};

// Find promises Naomi made in past sent emails ("I'll send X by Y") that may
// have lapsed. Cross-references whether the recipient was followed up with
// after the promise was made. Surfaces ones that look stale.
export const findUnkeptPromisesTool: AgentTool = {
  name: "find_unkept_promises",
  description:
    'Scan the user\'s past sent emails for explicit promises ("I\'ll send X", "I\'ll get back to you", "by Wednesday", "next week") and find any that may have lapsed without follow-up. Use this to surface things she said she\'d do that fell through the cracks.',
  input_schema: {
    type: "object",
    properties: {
      days_back: {
        type: "number",
        description:
          "How far back to scan. Default 60 — promises older than that are often resolved through other channels.",
      },
    },
  },
  handler: async (input, ctx) => {
    const daysBack = (input.days_back as number) || 60;
    return findLapsedPromises(ctx.userId, daysBack);
  },
};

// All tools the triage agent uses, in registration order.
export const TRIAGE_TOOLS: AgentTool[] = [
  searchInboxTool,
  getEmailBodyTool,
  getThreadContextTool,
  getUserProfileTool,
  listPastEmailsToRecipientTool,
  findUnkeptPromisesTool,
  draftReplyTool,
  markForAttentionTool,
];
