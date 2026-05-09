import { supabase } from "@/lib/supabase/client";
import { classifySender, isNoise, type Tier } from "@/lib/agent/sender-tiers";

type EmailContentType = "email_received" | "email_sent";

interface CortexDocumentRow {
  source_id: string;
  content: string;
  metadata: Record<string, unknown>;
  source_created_at: string | null;
  chunk_index: number;
  content_type: EmailContentType;
}

export interface AssembledEmailMessage {
  source_id: string;
  content: string;
  metadata: Record<string, unknown>;
  source_created_at: string | null;
  chunk_count: number;
  content_type: EmailContentType;
  threadId: string | null;
}

export interface ThreadContext {
  source_id: string;
  threadId: string | null;
  message: AssembledEmailMessage;
  messages: AssembledEmailMessage[];
  thread_context: string | null;
}

export interface InboxThreadSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  threadId: string | null;
  date: string | null;
  labels: string[];
  isImportant: boolean;
  snippet: string;
  tier: Tier;
  tier_reasoning: string;
  latest_received_at: string | null;
  latest_sent_at: string | null;
  unreplied: boolean;
  thread_message_count: number;
}

const HEAD_PAGE_SIZE = 200;
const DEFAULT_MAX_HEADS = 2000;
const MAX_OVERLAP_CHARS = 400;
const MIN_OVERLAP_CHARS = 24;
const SOURCE_ID_BATCH_SIZE = 50;

export async function fetchInboxThreadSummaries(
  userId: string,
  opts: {
    daysBack?: number;
    unrepliedOnly?: boolean;
    limit?: number;
    maxHeads?: number;
  } = {}
): Promise<{
  count: number;
  emails: InboxThreadSummary[];
  scanned_received_heads: number;
  scanned_sent_heads: number;
}> {
  const {
    daysBack = 90,
    unrepliedOnly = true,
    limit = 60,
    maxHeads = DEFAULT_MAX_HEADS,
  } = opts;
  const sinceIso = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000
  ).toISOString();

  const [receivedHeads, sentHeads] = await Promise.all([
    fetchHeadRows(userId, "email_received", sinceIso, maxHeads),
    fetchHeadRows(userId, "email_sent", sinceIso, maxHeads),
  ]);

  const latestReceivedByThread = new Map<string, CortexDocumentRow>();
  const latestSentAtByThread = new Map<string, string>();
  const messageCountByThread = new Map<string, number>();

  for (const row of receivedHeads) {
    const key = getThreadKey(row.metadata, row.source_id);
    messageCountByThread.set(key, (messageCountByThread.get(key) || 0) + 1);
    const prev = latestReceivedByThread.get(key);
    if (!prev || compareIsoDates(row.source_created_at, prev.source_created_at) > 0) {
      latestReceivedByThread.set(key, row);
    }
  }

  for (const row of sentHeads) {
    const key = getThreadKey(row.metadata, row.source_id);
    if (!row.source_created_at) continue;
    const prev = latestSentAtByThread.get(key) || null;
    if (!prev || compareIsoDates(row.source_created_at, prev) > 0) {
      latestSentAtByThread.set(key, row.source_created_at);
    }
  }

  const summaries: InboxThreadSummary[] = [];

  for (const [key, row] of latestReceivedByThread.entries()) {
    const meta = row.metadata || {};
    const labels = ((meta.labels as string[]) || []).filter(Boolean);
    const from = (meta.from as string) || "Unknown";
    const subject = (meta.subject as string) || "(no subject)";

    if (isNoise({ from, subject, labels })) continue;

    const classified = classifySender({ from, subject, labels });
    const latestSentAt = latestSentAtByThread.get(key) || null;
    const unreplied =
      !latestSentAt || compareIsoDates(row.source_created_at, latestSentAt) > 0;

    if (unrepliedOnly && !unreplied) continue;

    summaries.push({
      id: row.source_id,
      from,
      to: (meta.to as string) || "",
      subject,
      threadId: (meta.threadId as string) || null,
      date: row.source_created_at,
      labels,
      isImportant: labels.includes("IMPORTANT"),
      snippet: row.content.slice(0, 400),
      tier: classified.tier,
      tier_reasoning: classified.reasoning,
      latest_received_at: row.source_created_at,
      latest_sent_at: latestSentAt,
      unreplied,
      thread_message_count: messageCountByThread.get(key) || 1,
    });
  }

  summaries.sort((a, b) =>
    compareIsoDates(b.latest_received_at, a.latest_received_at)
  );

  return {
    count: Math.min(summaries.length, limit),
    emails: summaries.slice(0, limit),
    scanned_received_heads: receivedHeads.length,
    scanned_sent_heads: sentHeads.length,
  };
}

export async function fetchThreadContextBySourceId(
  userId: string,
  sourceId: string,
  maxMessages = 6
): Promise<ThreadContext | null> {
  const message = await fetchAssembledMessageBySourceId(userId, sourceId);
  if (!message) return null;

  const threadId = message.threadId;
  let messages = [message];
  if (threadId) {
    messages = await fetchAssembledMessagesByThreadId(userId, threadId);
  }

  messages.sort((a, b) => compareIsoDates(a.source_created_at, b.source_created_at));

  return {
    source_id: sourceId,
    threadId,
    message,
    messages,
    thread_context: buildThreadContext(messages, maxMessages),
  };
}

export async function fetchAssembledMessageBySourceId(
  userId: string,
  sourceId: string
): Promise<AssembledEmailMessage | null> {
  const { data, error } = await supabase
    .from("cortex_documents")
    .select("source_id, content, metadata, source_created_at, chunk_index, content_type")
    .eq("user_id", userId)
    .eq("source_id", sourceId)
    .order("chunk_index", { ascending: true });

  if (error) throw error;
  const rows = (data || []) as CortexDocumentRow[];
  if (rows.length === 0) return null;
  return assembleMessage(rows);
}

export async function fetchRecentAssembledMessages(
  userId: string,
  contentType: EmailContentType,
  opts: {
    daysBack?: number;
    maxHeads?: number;
  } = {}
): Promise<AssembledEmailMessage[]> {
  const { daysBack = 90, maxHeads = 250 } = opts;
  const sinceIso = new Date(
    Date.now() - daysBack * 24 * 60 * 60 * 1000
  ).toISOString();
  const headRows = await fetchHeadRows(userId, contentType, sinceIso, maxHeads);
  const sourceIds = headRows.map((row) => row.source_id);
  const messages = await fetchAssembledMessagesBySourceIds(userId, sourceIds);

  return messages
    .sort((a, b) => compareIsoDates(b.source_created_at, a.source_created_at));
}

function assembleMessage(rows: CortexDocumentRow[]): AssembledEmailMessage {
  const sorted = [...rows].sort((a, b) => a.chunk_index - b.chunk_index);
  const base = sorted[0];
  let merged = sorted[0]?.content || "";

  for (const row of sorted.slice(1)) {
    merged = appendChunk(merged, row.content);
  }

  const metadata = base?.metadata || {};
  return {
    source_id: base.source_id,
    content: merged,
    metadata,
    source_created_at: base.source_created_at,
    chunk_count: sorted.length,
    content_type: base.content_type,
    threadId: (metadata.threadId as string) || null,
  };
}

async function fetchAssembledMessagesByThreadId(
  userId: string,
  threadId: string
): Promise<AssembledEmailMessage[]> {
  const { data, error } = await supabase
    .from("cortex_documents")
    .select("source_id, content, metadata, source_created_at, chunk_index, content_type")
    .eq("user_id", userId)
    .contains("metadata", { threadId })
    .order("source_created_at", { ascending: true })
    .order("chunk_index", { ascending: true });

  if (error) throw error;
  const rows = (data || []) as CortexDocumentRow[];
  if (rows.length === 0) return [];

  const grouped = new Map<string, CortexDocumentRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.source_id) || [];
    list.push(row);
    grouped.set(row.source_id, list);
  }

  return [...grouped.values()].map(assembleMessage);
}

export async function fetchAssembledMessagesBySourceIds(
  userId: string,
  sourceIds: string[]
): Promise<AssembledEmailMessage[]> {
  if (sourceIds.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < sourceIds.length; i += SOURCE_ID_BATCH_SIZE) {
    batches.push(sourceIds.slice(i, i + SOURCE_ID_BATCH_SIZE));
  }

  const grouped = new Map<string, CortexDocumentRow[]>();

  for (const batch of batches) {
    const { data, error } = await supabase
      .from("cortex_documents")
      .select("source_id, content, metadata, source_created_at, chunk_index, content_type")
      .eq("user_id", userId)
      .in("source_id", batch)
      .order("source_created_at", { ascending: false })
      .order("chunk_index", { ascending: true });

    if (error) throw error;

    for (const row of (data || []) as CortexDocumentRow[]) {
      const list = grouped.get(row.source_id) || [];
      list.push(row);
      grouped.set(row.source_id, list);
    }
  }

  const messages = [...grouped.values()].map(assembleMessage);
  const order = new Map(sourceIds.map((sourceId, index) => [sourceId, index]));
  messages.sort(
    (a, b) =>
      (order.get(a.source_id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.source_id) ?? Number.MAX_SAFE_INTEGER)
  );
  return messages;
}

async function fetchHeadRows(
  userId: string,
  contentType: EmailContentType,
  sinceIso: string,
  maxRows: number
): Promise<CortexDocumentRow[]> {
  const rows: CortexDocumentRow[] = [];
  let offset = 0;

  while (rows.length < maxRows) {
    const upper = Math.min(offset + HEAD_PAGE_SIZE - 1, maxRows - 1);
    const { data, error } = await supabase
      .from("cortex_documents")
      .select("source_id, content, metadata, source_created_at, chunk_index, content_type")
      .eq("user_id", userId)
      .eq("content_type", contentType)
      .eq("chunk_index", 0)
      .gte("source_created_at", sinceIso)
      .order("source_created_at", { ascending: false })
      .range(offset, upper);

    if (error) throw error;

    const page = (data || []) as CortexDocumentRow[];
    rows.push(...page);
    if (page.length < HEAD_PAGE_SIZE) break;
    offset += HEAD_PAGE_SIZE;
  }

  return rows.slice(0, maxRows);
}

function buildThreadContext(
  messages: AssembledEmailMessage[],
  maxMessages: number
): string | null {
  if (messages.length <= 1) return null;

  const recent = messages.slice(-maxMessages);
  const parts = recent.map((message) => {
    const meta = message.metadata || {};
    const direction = message.content_type === "email_sent" ? "YOU SENT" : "THEY SENT";
    const header = [
      direction,
      message.source_created_at || "unknown time",
      (meta.subject as string) || "(no subject)",
    ].join(" | ");

    return `${header}\n${message.content.slice(0, 1800)}`;
  });

  return parts.join("\n\n---\n\n");
}

function appendChunk(existing: string, next: string): string {
  if (!existing) return next;
  if (!next) return existing;

  const maxOverlap = Math.min(MAX_OVERLAP_CHARS, existing.length, next.length);
  for (let size = maxOverlap; size >= MIN_OVERLAP_CHARS; size--) {
    if (existing.endsWith(next.slice(0, size))) {
      return existing + next.slice(size);
    }
  }

  return `${existing}\n${next}`;
}

function getThreadKey(metadata: Record<string, unknown>, sourceId: string): string {
  return (metadata.threadId as string) || sourceId;
}

function compareIsoDates(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}
