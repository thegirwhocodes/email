import { NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import {
  fetchAssembledMessagesBySourceIds,
  fetchInboxThreadSummaries,
} from "@/lib/email-state";

// Returns the queue of emails needing a reply (same logic as cortex-web/email-agent/queue).
// Reads from cortex_documents — assumes Gmail was synced via cortex-web.

export async function GET() {
  try {
    const userId = await getUserId();
    const result = await fetchInboxThreadSummaries(userId, {
      daysBack: 90,
      unrepliedOnly: true,
      limit: 25,
    });

    const assembledBodies = await fetchAssembledMessagesBySourceIds(
      userId,
      result.emails.map((email) => email.id)
    );

    const queue = result.emails.map((email, index) => ({
      id: email.id,
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      body: assembledBodies[index]?.content || email.snippet,
      threadId: email.threadId || undefined,
      date: email.date,
      isImportant: email.isImportant,
      tier: email.tier,
      latestSentAt: email.latest_sent_at,
      unreplied: email.unreplied,
      threadMessageCount: email.thread_message_count,
    }));

    return NextResponse.json({
      queue,
      total: queue.length,
      scanned_received_heads: result.scanned_received_heads,
      scanned_sent_heads: result.scanned_sent_heads,
    });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Queue error:", error);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
