import { NextRequest, NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import {
  rememberSkippedThread,
  rememberWrapReason,
} from "@/lib/assistant-memory";

type SessionAction = "skip" | "wrap";

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const body = await request.json();
    const action = body.action as SessionAction;

    if (action === "skip") {
      const item = body.item as
        | { source_id?: string; from?: string; subject?: string }
        | undefined;

      if (!item?.from || !item?.subject) {
        return NextResponse.json(
          { error: "Missing skipped item" },
          { status: 400 }
        );
      }

      await rememberSkippedThread({
        userId,
        from: item.from,
        subject: item.subject,
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "wrap") {
      await rememberWrapReason({
        userId,
        reason:
          typeof body.reason === "string" && body.reason.trim()
            ? body.reason.trim()
            : "the important inbox items were handled",
      });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Session action error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Action failed" },
      { status: 500 }
    );
  }
}
