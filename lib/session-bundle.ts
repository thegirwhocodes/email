// Voice-email session bundle — everything the assistant needs to know about
// this user's inbox, pre-loaded once at session start.
//
// After this loads, every per-turn LLM call needs ZERO new database reads.
// The model gets the whole session in its system prompt and just decides
// what to say next. This is what makes the assistant feel instant.

import { supabase } from "@/lib/supabase/client";
import { loadAssistantContext } from "@/lib/assistant-memory";
import {
  fetchInboxThreadSummaries,
  fetchThreadContextBySourceId,
} from "@/lib/email-state";

export interface SessionEmail {
  source_id: string;
  thread_id: string | null;
  from: string;
  subject: string;
  date: string | null;
  tier: string;
  is_important: boolean;
  excerpt: string;
  full_body?: string;
  thread_excerpt?: string; // recent back-and-forth
}

export interface SessionBundle {
  user: { id: string; email: string; name: string | null };
  profile_text: string | null;
  open_followups: Array<{
    content: string;
    importance: number;
    due_date: string | null;
  }>;
  memory_facts: string[];
  queue: SessionEmail[]; // ordered by tier+priority
  generated_at: string;
}

const TIER_ORDER: Record<string, number> = {
  business: 0,
  family: 1,
  wesleyan: 2,
  vox_church: 3,
  vendor_outreach: 4,
  friend: 5,
  opportunity: 6,
  unknown: 7,
};

export async function buildSessionBundle(
  userId: string,
  options: { topN?: number; includeBodies?: number } = {}
): Promise<SessionBundle> {
  const topN = options.topN ?? 12;
  const includeBodies = options.includeBodies ?? 6;

  // Parallel: profile + memory + inbox in one round-trip
  const [{ data: profile }, { data: user }, assistantContext, queueResult] =
    await Promise.all([
      supabase
        .from("cortex_profiles")
        .select("profile_text")
        .eq("user_id", userId)
        .maybeSingle(),
      supabase
        .from("cortex_users")
        .select("id, email, name")
        .eq("id", userId)
        .single(),
      loadAssistantContext(userId, { memoryLimit: 12, loopLimit: 8 }),
      fetchInboxThreadSummaries(userId, {
        daysBack: 90,
        unrepliedOnly: true,
        limit: 60,
      }),
    ]);

  // Sort by tier, then importance flag, then recency
  const sorted = [...queueResult.emails].sort((a, b) => {
    const ta = TIER_ORDER[a.tier] ?? 7;
    const tb = TIER_ORDER[b.tier] ?? 7;
    if (ta !== tb) return ta - tb;
    if (a.isImportant !== b.isImportant) return a.isImportant ? -1 : 1;
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });

  const top = sorted.slice(0, topN);

  // For the highest-priority items, also fetch full bodies + thread context
  const withBodies = await Promise.all(
    top.map(async (e, i) => {
      const sessionEmail: SessionEmail = {
        source_id: e.id,
        thread_id: e.threadId || null,
        from: e.from,
        subject: e.subject,
        date: e.date,
        tier: e.tier,
        is_important: e.isImportant,
        excerpt: e.snippet,
      };
      if (i < includeBodies) {
        const ctx = await fetchThreadContextBySourceId(userId, e.id);
        if (ctx) {
          sessionEmail.full_body = ctx.message.content;
          if (ctx.thread_context) sessionEmail.thread_excerpt = ctx.thread_context;
        }
      }
      return sessionEmail;
    })
  );

  return {
    user: {
      id: user!.id,
      email: user!.email,
      name: user!.name ?? null,
    },
    profile_text: profile?.profile_text ?? null,
    open_followups: assistantContext.openLoops.map((loop) => ({
      content: loop.content,
      importance: loop.importance,
      due_date: loop.due_date,
    })),
    memory_facts: assistantContext.memoryFacts,
    queue: withBodies,
    generated_at: new Date().toISOString(),
  };
}

// Render the bundle into a single block of context for the LLM prompt.
export function renderBundleAsContext(bundle: SessionBundle): string {
  const parts: string[] = [];

  if (bundle.profile_text) {
    parts.push(`## WHO YOU'RE HELPING\n${bundle.profile_text}`);
  }

  if (bundle.memory_facts.length > 0) {
    parts.push(
      `## DURABLE MEMORY (facts you've learned across past sessions)\n${bundle.memory_facts
        .map((f) => `- ${f}`)
        .join("\n")}`
    );
  }

  if (bundle.open_followups.length > 0) {
    parts.push(
      `## OPEN FOLLOW-UPS FROM PRIOR SESSIONS\n${bundle.open_followups
        .map(
          (l) =>
            `- [importance ${l.importance}] ${l.content}${
              l.due_date ? ` (due ${l.due_date})` : ""
            }`
        )
        .join("\n")}`
    );
  }

  if (bundle.queue.length > 0) {
    parts.push(
      `## INBOX QUEUE (${bundle.queue.length} unreplied threads, sorted by priority)`
    );
    for (let i = 0; i < bundle.queue.length; i++) {
      const e = bundle.queue[i];
      let block = `\n[${i + 1}] id=${e.source_id} tier=${e.tier} ${
        e.is_important ? "(IMPORTANT)" : ""
      }`;
      block += `\n    from: ${e.from}`;
      block += `\n    subj: ${e.subject}`;
      if (e.date) block += `\n    date: ${e.date.slice(0, 10)}`;
      if (e.full_body) {
        block += `\n    body: <untrusted_content>${e.full_body.slice(0, 1500)}</untrusted_content>`;
        if (e.thread_excerpt) {
          block += `\n    thread: <untrusted_content>${e.thread_excerpt.slice(0, 1000)}</untrusted_content>`;
        }
      } else {
        block += `\n    excerpt: <untrusted_content>${e.excerpt.slice(0, 400)}</untrusted_content>`;
      }
      parts.push(block);
    }
  } else {
    parts.push("## INBOX QUEUE\n(empty — caught up or no recent unreplied threads)");
  }

  return parts.join("\n\n");
}
