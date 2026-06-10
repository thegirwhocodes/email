import { fetchInboxThreadSummaries, fetchRecentAssembledMessages } from "@/lib/email-state";
import {
  FOLLOWUP_LOOP_SOURCE,
  PROMISE_LOOP_SOURCE,
  normalizeRecipient,
} from "@/lib/assistant-memory";

interface PromiseCandidate {
  sent_at: string;
  to: string;
  subject: string;
  excerpt: string;
  threadId: string | null;
}

export interface PromiseScanResult {
  total_candidates: number;
  lapsed: PromiseCandidate[];
}

export async function findLapsedPromises(
  userId: string,
  daysBack = 60
): Promise<PromiseScanResult> {
  const sent = await fetchRecentAssembledMessages(userId, "email_sent", {
    daysBack,
    maxHeads: 250,
  });

  if (sent.length === 0) {
    return { total_candidates: 0, lapsed: [] };
  }

  const PROMISE_PATTERNS = [
    /I[' ]?ll (?:send|get|share|forward|email|deliver|provide|finish)/i,
    /I will (?:send|get|share|forward|email|deliver|provide|finish)/i,
    /by (?:tomorrow|next week|monday|tuesday|wednesday|thursday|friday|the end of)/i,
    /(?:tomorrow|tonight|this weekend|next week|next monday|next tuesday|next wednesday)/i,
    /will get back to you/i,
    /let me (?:get back|come back|circle back)/i,
    /I[' ]?ll follow up/i,
  ];

  const candidates: PromiseCandidate[] = [];

  for (const message of sent) {
    const meta = message.metadata || {};
    const content = message.content || "";
    const userPart = content.split(/\n>+\s|On .{1,80} wrote:/)[0];
    for (const re of PROMISE_PATTERNS) {
      const match = userPart.match(re);
      if (match) {
        const start = Math.max(0, match.index! - 60);
        candidates.push({
          sent_at: message.source_created_at as string,
          to: (meta.to as string) || "",
          subject: (meta.subject as string) || "",
          excerpt: userPart.slice(start, match.index! + 200).trim(),
          threadId: (meta.threadId as string) || null,
        });
        break;
      }
    }
  }

  const lapsed = candidates.filter((candidate) => {
    const sentAfter = sent.filter((message) => {
      if (!message.source_created_at || message.source_created_at <= candidate.sent_at) {
        return false;
      }
      const meta = message.metadata || {};
      const sameThread =
        candidate.threadId && meta.threadId && meta.threadId === candidate.threadId;
      const sameRecipient =
        candidate.to &&
        ((meta.to as string) || "")
          .toLowerCase()
          .includes(candidate.to.toLowerCase().split(/[<>]/).slice(-2)[0] || "");
      return !!(sameThread || sameRecipient);
    });
    return sentAfter.length === 0;
  });

  return {
    total_candidates: candidates.length,
    lapsed: lapsed.slice(0, 10),
  };
}

export async function computeActiveFollowups(userId: string): Promise<{
  threadLoops: Array<{
    source: string;
    sourceId: string;
    content: string;
    importance: number;
    dueDate: string | null;
    memoryFact: string;
  }>;
  promiseLoops: Array<{
    source: string;
    sourceId: string;
    content: string;
    importance: number;
    dueDate: string | null;
    memoryFact: string;
  }>;
}> {
  const [threadSummaries, promiseResult] = await Promise.all([
    fetchInboxThreadSummaries(userId, {
      daysBack: 120,
      unrepliedOnly: true,
      limit: 40,
      maxHeads: 800,
    }),
    findLapsedPromises(userId, 90),
  ]);

  const threadLoops = threadSummaries.emails
    .filter(shouldCreateThreadFollowup)
    .map((email) => ({
      source: FOLLOWUP_LOOP_SOURCE,
      sourceId: email.id,
      content: `Reply to ${shortFrom(email.from)} about "${email.subject}".`,
      importance: threadImportance(email.tier, email.isImportant),
      dueDate: followupDueDateIso(email.date, email.tier, email.isImportant),
      memoryFact: `${shortFrom(email.from)} is still waiting for a reply about "${email.subject}".`,
    }));

  const promiseLoops = promiseResult.lapsed.map((promise) => ({
    source: PROMISE_LOOP_SOURCE,
    sourceId: promiseSourceId(promise),
    content: `Follow up on your promise to ${shortTo(promise.to)} about "${promise.subject}".`,
    importance: 5,
    dueDate: new Date().toISOString(),
    memoryFact: `Naomi still owes ${shortTo(promise.to)} a follow-up about "${promise.subject}".`,
  }));

  return { threadLoops, promiseLoops };
}

export function promiseSourceId(promise: PromiseCandidate): string {
  if (promise.threadId) return `promise:${promise.threadId}`;
  return `promise-to:${normalizeRecipient(promise.to)}`;
}

function shouldCreateThreadFollowup(email: {
  tier: string;
  isImportant: boolean;
  date: string | null;
}): boolean {
  if (email.tier === "opportunity" || email.tier === "noise") return false;

  const ageDays = ageInDays(email.date);
  if (email.isImportant) return ageDays >= 1;

  switch (email.tier) {
    case "business":
    case "family":
      return ageDays >= 1;
    case "wesleyan":
    case "vox_church":
    case "friend":
    case "vendor_outreach":
      return ageDays >= 2;
    default:
      return ageDays >= 3;
  }
}

function threadImportance(tier: string, isImportant: boolean): number {
  if (isImportant) return 5;
  switch (tier) {
    case "business":
      return 5;
    case "family":
      return 4;
    case "wesleyan":
    case "vox_church":
      return 4;
    case "vendor_outreach":
    case "friend":
      return 3;
    default:
      return 2;
  }
}

function followupDueDateIso(
  receivedAt: string | null,
  tier: string,
  isImportant: boolean
): string | null {
  if (!receivedAt) return new Date().toISOString();
  const base = new Date(receivedAt).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const offsetDays =
    isImportant || tier === "business" || tier === "family" ? 1 : 2;
  return new Date(base + offsetDays * oneDay).toISOString();
}

function ageInDays(value: string | null): number {
  if (!value) return 999;
  return Math.floor((Date.now() - new Date(value).getTime()) / (24 * 60 * 60 * 1000));
}

function shortFrom(from: string): string {
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, "");
  const emailMatch = from.match(/<([^>]+)>/);
  return emailMatch ? emailMatch[1] : from;
}

function shortTo(to: string): string {
  if (!to) return "them";
  const nameMatch = to.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, "");
  const emailMatch = to.match(/<([^>]+)>/);
  return emailMatch ? emailMatch[1] : to;
}
