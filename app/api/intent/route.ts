import { NextRequest, NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import { classifyIntent } from "@/lib/ai/intent";

export async function POST(request: NextRequest) {
  try {
    await getUserId();
    const { speech, stage } = await request.json();

    if (typeof speech !== "string" || speech.trim().length === 0) {
      return NextResponse.json({ intent: { kind: "unclear" } });
    }

    const intent = await classifyIntent(
      speech,
      stage === "after_draft" ? "after_draft" : "after_summary"
    );

    return NextResponse.json({ intent });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Intent error:", error);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
