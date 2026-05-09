import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { supabase } from "@/lib/supabase/client";
import { archiveMessage } from "@/lib/integrations/gmail-send";
import { getFreshGmailToken } from "@/lib/integrations/gmail-token";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const { messageId } = await request.json();

    if (!messageId) {
      return NextResponse.json({ error: "Missing messageId" }, { status: 400 });
    }

    const accessToken = await getFreshGmailToken(userId);
    await archiveMessage(accessToken, messageId);

    await supabase.from("cortex_actions").insert({
      user_id: userId,
      action_type: "send_email",
      status: "executed",
      action_data: { archived: messageId, source: "voice-email" },
      result: { ok: true },
      executed_at: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Archive error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
