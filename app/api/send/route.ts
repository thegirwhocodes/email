import { NextRequest, NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import { supabase } from "@/lib/supabase/client";
import { sendEmail } from "@/lib/integrations/gmail-send";
import { getFreshGmailToken } from "@/lib/integrations/gmail-token";
import {
  completeFollowupLoopForSource,
  completePromiseLoopsForThread,
  rememberReplySent,
} from "@/lib/assistant-memory";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const { to, subject, body, threadId, sourceId, from, originalSubject } =
      await request.json();

    if (!to || !subject || !body) {
      return NextResponse.json(
        { error: "Missing to/subject/body" },
        { status: 400 }
      );
    }

    const accessToken = await getFreshGmailToken(userId);
    const result = await sendEmail(accessToken, {
      to,
      subject,
      body,
      threadId,
    });

    const { error: actionError } = await supabase.from("cortex_actions").insert({
      user_id: userId,
      action_type: "send_email",
      status: "executed",
      action_data: {
        to,
        subject,
        source: "voice-email",
        source_id: sourceId || null,
        from: from || null,
        threadId: threadId || null,
      },
      result: { messageId: result.messageId },
      executed_at: new Date().toISOString(),
    });

    if (actionError) {
      console.error("Send action audit error:", actionError);
    }

    try {
      await Promise.all([
        rememberReplySent({
          userId,
          from: from || to,
          subject: originalSubject || subject,
        }),
        sourceId
          ? completeFollowupLoopForSource(userId, sourceId)
          : Promise.resolve(),
        completePromiseLoopsForThread(userId, {
          threadId: threadId || null,
          recipient: to,
        }),
      ]);
    } catch (memoryError) {
      console.error("Send memory persistence error:", memoryError);
    }

    return NextResponse.json({ success: true, messageId: result.messageId });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Send error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send" },
      { status: 500 }
    );
  }
}
