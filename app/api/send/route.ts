import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { supabase } from "@/lib/supabase/client";
import { sendEmail } from "@/lib/integrations/gmail-send";
import { getFreshGmailToken } from "@/lib/integrations/gmail-token";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const { to, subject, body, threadId } = await request.json();

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

    await supabase.from("cortex_actions").insert({
      user_id: userId,
      action_type: "send_email",
      status: "executed",
      action_data: { to, subject, source: "voice-email" },
      result: { messageId: result.messageId },
      executed_at: new Date().toISOString(),
    });

    return NextResponse.json({ success: true, messageId: result.messageId });
  } catch (error) {
    console.error("Send error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send" },
      { status: 500 }
    );
  }
}
