import { NextRequest, NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import { supabase } from "@/lib/supabase/client";
import { archiveMessage } from "@/lib/integrations/gmail-send";
import { getFreshGmailToken } from "@/lib/integrations/gmail-token";
import {
  completeFollowupLoopForSource,
  rememberArchivedThread,
} from "@/lib/assistant-memory";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const { messageId, from, subject } = await request.json();

    if (!messageId) {
      return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
    }

    const accessToken = await getFreshGmailToken(userId);
    await archiveMessage(accessToken, messageId);

    const { error: actionError } = await supabase.from("cortex_actions").insert({
      user_id: userId,
      action_type: "archive_email",
      status: "executed",
      action_data: {
        archived: messageId,
        source: "voice-email",
        from: from || null,
        subject: subject || null,
      },
      result: { ok: true },
      executed_at: new Date().toISOString(),
    });

    if (actionError) {
      console.error("Archive action audit error:", actionError);
    }

    try {
      await Promise.all([
        from && subject
          ? rememberArchivedThread({ userId, from, subject })
          : Promise.resolve(),
        completeFollowupLoopForSource(userId, messageId),
      ]);
    } catch (memoryError) {
      console.error("Archive memory persistence error:", memoryError);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Archive error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
