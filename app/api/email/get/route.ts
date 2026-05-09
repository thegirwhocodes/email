import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { fetchThreadContextBySourceId } from "@/lib/email-state";

// Look up the body of a single email by its Gmail message id.
// Used by the voice client when an agent-flagged item needs an on-demand draft.
export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const { source_id } = await request.json();
    if (!source_id) {
      return NextResponse.json({ error: "Missing source_id" }, { status: 400 });
    }

    const threadContext = await fetchThreadContextBySourceId(userId, source_id);
    if (!threadContext) return NextResponse.json({ found: false });

    return NextResponse.json({
      found: true,
      body: threadContext.message.content,
      metadata: threadContext.message.metadata,
      chunkCount: threadContext.message.chunk_count,
      threadId: threadContext.threadId,
      threadContext: threadContext.thread_context,
      recentThreadMessages: threadContext.messages.slice(-6).map((message) => ({
        source_id: message.source_id,
        content_type: message.content_type,
        from: (message.metadata.from as string) || "",
        to: (message.metadata.to as string) || "",
        subject: (message.metadata.subject as string) || "",
        date: message.source_created_at,
        excerpt: message.content.slice(0, 500),
      })),
    });
  } catch (error) {
    console.error("email/get error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
