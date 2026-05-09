import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { runTriageAgent } from "@/lib/agent/triage-agent";

// Run the email-triage agent. This is slow — Sonnet making multiple tool
// calls. Expect 10-40 seconds depending on inbox size.
export const maxDuration = 300;

export async function POST() {
  try {
    const userId = await getUserId();
    const result = await runTriageAgent(userId);

    return NextResponse.json({
      summary: result.summary,
      flagged: result.flagged,
      diagnostics: {
        iterations: result.run.iterations,
        toolCalls: result.run.toolLog.length,
        inputTokens: result.run.inputTokens,
        outputTokens: result.run.outputTokens,
        cacheReadTokens: result.run.cacheReadTokens,
        cacheCreationTokens: result.run.cacheCreationTokens,
        stopReason: result.run.stopReason,
      },
    });
  } catch (error) {
    console.error("Triage agent error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Triage failed" },
      { status: 500 }
    );
  }
}
