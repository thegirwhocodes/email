import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { draftEmailReply } from "@/lib/ai/email-drafter";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const { from, subject, body, threadId, intent } = await request.json();

    if (typeof body !== "string") {
      return NextResponse.json({ error: "Missing body" }, { status: 400 });
    }

    const draft = await draftEmailReply(userId, body, {
      from: from || "",
      subject: subject || "",
      threadId,
      intent: typeof intent === "string" ? intent : undefined,
    });

    return NextResponse.json({ draft });
  } catch (error) {
    console.error("Draft error:", error);
    return NextResponse.json({ error: "Failed to draft" }, { status: 500 });
  }
}
