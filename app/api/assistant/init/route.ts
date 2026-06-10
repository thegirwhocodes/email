import { NextResponse } from "next/server";
import { getUserId } from "@/lib/auth/session";
import { buildSessionBundle } from "@/lib/session-bundle";

// Voice-email session init — fires once on session start. Pre-loads everything
// the assistant needs into a single bundle so per-turn calls are zero-DB.

export const maxDuration = 60;

export async function POST() {
  try {
    const userId = await getUserId();
    const bundle = await buildSessionBundle(userId, { topN: 12, includeBodies: 6 });
    return NextResponse.json(bundle);
  } catch (error) {
    console.error("session init error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Init failed" },
      { status: 500 }
    );
  }
}
