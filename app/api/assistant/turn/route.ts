import { NextRequest, NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import { runAssistantTurn, type SessionState } from "@/lib/agent/assistant-agent";
import type Anthropic from "@anthropic-ai/sdk";

// One turn of the conversational email assistant.
//
// Body: { messages: [...full history], session_state: {...} }
// Returns: { speak_text, messages: [...new history], session_state, done }

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const userId = await getUserId();
    const body = await request.json();
    const messages = (body.messages || []) as Anthropic.Messages.MessageParam[];
    const sessionState = (body.session_state || {}) as SessionState;

    if (messages.length === 0) {
      return NextResponse.json(
        { error: "messages cannot be empty — pass at least the user's first turn" },
        { status: 400 }
      );
    }

    const result = await runAssistantTurn({
      userId,
      messages,
      isFirstTurn: messages.length === 1,
      sessionState,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Assistant turn error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Turn failed" },
      { status: 500 }
    );
  }
}
