import { supabase } from "@/lib/supabase/client";

export const FOLLOWUP_LOOP_SOURCE = "voice-email-followup";
export const PROMISE_LOOP_SOURCE = "voice-email-promise";

type MemoryCategory =
  | "identity"
  | "preference"
  | "relationship"
  | "pattern"
  | "goal"
  | "task"
  | "event"
  | "correction"
  | "context"
  | "values";

type MemorySource =
  | "interaction"
  | "email_analysis"
  | "calendar_analysis"
  | "onboarding"
  | "profile_build"
  | "user_correction";

type MemoryPriority = "critical" | "high" | "medium" | "low" | "ephemeral";

interface MemoryRow {
  id: string;
  fact: string;
  category: MemoryCategory;
  priority: MemoryPriority;
  last_accessed_at: string | null;
  access_count: number | null;
}

interface OpenLoopRow {
  id: string;
  content: string;
  importance: number;
  due_date: string | null;
  source: string | null;
  source_id: string | null;
  is_completed: boolean;
}

export interface AssistantContextSnapshot {
  memoryFacts: string[];
  openLoops: Array<{
    id: string;
    content: string;
    importance: number;
    due_date: string | null;
    source: string | null;
    source_id: string | null;
  }>;
}

export async function loadAssistantContext(
  userId: string,
  opts: { memoryLimit?: number; loopLimit?: number } = {}
): Promise<AssistantContextSnapshot> {
  const { memoryLimit = 12, loopLimit = 8 } = opts;

  const [memoryRes, loopRes] = await Promise.all([
    supabase
      .from("cortex_memory")
      .select("id, fact, category, priority, last_accessed_at, access_count")
      .eq("user_id", userId)
      .in("category", ["relationship", "preference", "pattern", "task", "context"])
      .in("source", ["interaction", "email_analysis", "user_correction"])
      .limit(100),
    supabase
      .from("cortex_open_loops")
      .select("id, content, importance, due_date, source, source_id, is_completed")
      .eq("user_id", userId)
      .eq("is_completed", false)
      .in("source", [FOLLOWUP_LOOP_SOURCE, PROMISE_LOOP_SOURCE])
      .limit(50),
  ]);

  if (memoryRes.error) throw memoryRes.error;
  if (loopRes.error) throw loopRes.error;

  const memoryRows = ((memoryRes.data || []) as MemoryRow[]).sort(compareMemoryRows);
  const loopRows = ((loopRes.data || []) as OpenLoopRow[]).sort(compareLoopRows);

  return {
    memoryFacts: memoryRows.slice(0, memoryLimit).map((row) => row.fact),
    openLoops: loopRows.slice(0, loopLimit).map((row) => ({
      id: row.id,
      content: row.content,
      importance: row.importance,
      due_date: row.due_date,
      source: row.source,
      source_id: row.source_id,
    })),
  };
}

export async function rememberSkippedThread(input: {
  userId: string;
  from: string;
  subject: string;
}): Promise<void> {
  await upsertMemoryFact({
    userId: input.userId,
    fact: `Naomi skipped ${shortFrom(input.from)} about "${input.subject}".`,
    category: "task",
    source: "interaction",
    priority: "ephemeral",
    confidence: 1,
    expiresAt: daysFromNowIso(7),
  });
}

export async function rememberReplySent(input: {
  userId: string;
  from: string;
  subject: string;
}): Promise<void> {
  await upsertMemoryFact({
    userId: input.userId,
    fact: `Naomi replied to ${shortFrom(input.from)} about "${input.subject}".`,
    category: "relationship",
    source: "interaction",
    priority: "low",
    confidence: 1,
    expiresAt: daysFromNowIso(30),
  });
}

export async function rememberArchivedThread(input: {
  userId: string;
  from: string;
  subject: string;
}): Promise<void> {
  await upsertMemoryFact({
    userId: input.userId,
    fact: `Naomi archived ${shortFrom(input.from)} about "${input.subject}".`,
    category: "task",
    source: "interaction",
    priority: "ephemeral",
    confidence: 1,
    expiresAt: daysFromNowIso(14),
  });
}

export async function rememberWrapReason(input: {
  userId: string;
  reason: string;
}): Promise<void> {
  await upsertMemoryFact({
    userId: input.userId,
    fact: `Voice email session ended because ${input.reason}.`,
    category: "context",
    source: "interaction",
    priority: "ephemeral",
    confidence: 1,
    expiresAt: daysFromNowIso(3),
  });
}

export async function rememberFollowupCreated(input: {
  userId: string;
  fact: string;
  priority?: MemoryPriority;
}): Promise<void> {
  await upsertMemoryFact({
    userId: input.userId,
    fact: input.fact,
    category: "task",
    source: "email_analysis",
    priority: input.priority || "medium",
    confidence: 0.9,
    expiresAt: daysFromNowIso(21),
  });
}

export async function upsertOpenLoop(input: {
  userId: string;
  source: string;
  sourceId: string;
  content: string;
  importance: number;
  dueDate?: string | null;
}): Promise<"created" | "updated"> {
  const { data, error } = await supabase
    .from("cortex_open_loops")
    .select("id")
    .eq("user_id", input.userId)
    .eq("source", input.source)
    .eq("source_id", input.sourceId)
    .eq("is_completed", false)
    .limit(1);

  if (error) throw error;

  const existing = data?.[0];
  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("cortex_open_loops")
      .update({
        content: input.content,
        importance: input.importance,
        due_date: input.dueDate || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (updateError) throw updateError;
    return "updated";
  }

  const { error: insertError } = await supabase.from("cortex_open_loops").insert({
    user_id: input.userId,
    content: input.content,
    importance: input.importance,
    due_date: input.dueDate || null,
    is_completed: false,
    source: input.source,
    source_id: input.sourceId,
    sort_order: 0,
  });

  if (insertError) throw insertError;
  return "created";
}

export async function closeLoopsNotInSet(input: {
  userId: string;
  sources: string[];
  activeSourceIds: Set<string>;
}): Promise<number> {
  const { data, error } = await supabase
    .from("cortex_open_loops")
    .select("id, source_id")
    .eq("user_id", input.userId)
    .eq("is_completed", false)
    .in("source", input.sources);

  if (error) throw error;

  const toClose = (data || [])
    .filter((row) => row.source_id && !input.activeSourceIds.has(row.source_id))
    .map((row) => row.id);

  if (toClose.length === 0) return 0;

  const { error: updateError } = await supabase
    .from("cortex_open_loops")
    .update({
      is_completed: true,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in("id", toClose);

  if (updateError) throw updateError;
  return toClose.length;
}

export async function completeFollowupLoopForSource(
  userId: string,
  sourceId: string
): Promise<void> {
  await completeOpenLoopWhere(userId, {
    source: FOLLOWUP_LOOP_SOURCE,
    sourceId,
  });
}

export async function completePromiseLoopsForThread(
  userId: string,
  input: { threadId?: string | null; recipient?: string | null }
): Promise<void> {
  const { data, error } = await supabase
    .from("cortex_open_loops")
    .select("id, source_id")
    .eq("user_id", userId)
    .eq("is_completed", false)
    .eq("source", PROMISE_LOOP_SOURCE);

  if (error) throw error;

  const recipientKey = input.recipient ? normalizeRecipient(input.recipient) : null;
  const ids = (data || [])
    .filter((row) => {
      const sourceId = row.source_id || "";
      if (input.threadId && sourceId.startsWith(`promise:${input.threadId}`)) return true;
      if (recipientKey && sourceId.startsWith(`promise-to:${recipientKey}`)) return true;
      return false;
    })
    .map((row) => row.id);

  if (ids.length === 0) return;

  const { error: updateError } = await supabase
    .from("cortex_open_loops")
    .update({
      is_completed: true,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);

  if (updateError) throw updateError;
}

function compareMemoryRows(a: MemoryRow, b: MemoryRow): number {
  const priorityDiff = memoryPriorityRank(b.priority) - memoryPriorityRank(a.priority);
  if (priorityDiff !== 0) return priorityDiff;
  return compareIsoDesc(a.last_accessed_at, b.last_accessed_at);
}

function compareLoopRows(a: OpenLoopRow, b: OpenLoopRow): number {
  if (b.importance !== a.importance) return b.importance - a.importance;
  return compareIsoAsc(a.due_date, b.due_date);
}

function memoryPriorityRank(priority: MemoryPriority): number {
  const ranks: Record<MemoryPriority, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    ephemeral: 1,
  };
  return ranks[priority] || 0;
}

function compareIsoDesc(a: string | null, b: string | null): number {
  return isoTime(b) - isoTime(a);
}

function compareIsoAsc(a: string | null, b: string | null): number {
  return isoTime(a) - isoTime(b);
}

function isoTime(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER;
}

function daysFromNowIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function upsertMemoryFact(input: {
  userId: string;
  fact: string;
  category: MemoryCategory;
  source: MemorySource;
  priority: MemoryPriority;
  confidence: number;
  expiresAt?: string | null;
}): Promise<void> {
  const { data, error } = await supabase
    .from("cortex_memory")
    .select("id")
    .eq("user_id", input.userId)
    .eq("fact", input.fact)
    .eq("category", input.category)
    .eq("source", input.source)
    .limit(1);

  if (error) throw error;

  const existing = data?.[0];
  if (existing?.id) {
    const { error: updateError } = await supabase
      .from("cortex_memory")
      .update({
        priority: input.priority,
        confidence: input.confidence,
        expires_at: input.expiresAt || null,
        last_accessed_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (updateError) throw updateError;
    return;
  }

  const { error: insertError } = await supabase.from("cortex_memory").insert({
    user_id: input.userId,
    fact: input.fact,
    category: input.category,
    source: input.source,
    priority: input.priority,
    confidence: input.confidence,
    expires_at: input.expiresAt || null,
  });

  if (insertError) throw insertError;
}

async function completeOpenLoopWhere(
  userId: string,
  input: { source: string; sourceId: string }
): Promise<void> {
  const { error } = await supabase
    .from("cortex_open_loops")
    .update({
      is_completed: true,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("source", input.source)
    .eq("source_id", input.sourceId)
    .eq("is_completed", false);

  if (error) throw error;
}

function shortFrom(from: string): string {
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, "");
  const emailMatch = from.match(/<([^>]+)>/);
  return emailMatch ? emailMatch[1] : from;
}

export function normalizeRecipient(value: string): string {
  const emailMatch = value.match(/<([^>]+)>/);
  const email = (emailMatch ? emailMatch[1] : value).trim().toLowerCase();
  return email;
}
