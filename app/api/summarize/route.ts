import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { summarizeForVoice } from "@/lib/ai/summarize";

export async function POST(request: NextRequest) {
  try {
    await getUserId();
    const { from, subject, body } = await request.json();

    if (typeof body !== "string") {
      return NextResponse.json({ error: "Missing body" }, { status: 400 });
    }

    const summary = await summarizeForVoice(body, {
      from: from || "Unknown",
      subject: subject || "(no subject)",
    });

    return NextResponse.json({ summary });
  } catch (error) {
    console.error("Summarize error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
