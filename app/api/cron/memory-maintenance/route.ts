import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function POST(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date().toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  const [{ count: expired }, { count: ephemeral }, { count: stale }] =
    await Promise.all([
      supabase
        .from("cortex_memory")
        .delete({ count: "exact" })
        .lt("expires_at", now)
        .not("expires_at", "is", null),
      supabase
        .from("cortex_memory")
        .delete({ count: "exact" })
        .eq("priority", "ephemeral")
        .lt("created_at", oneDayAgo),
      supabase
        .from("cortex_memory")
        .delete({ count: "exact" })
        .eq("priority", "low")
        .eq("access_count", 0)
        .lt("created_at", sevenDaysAgo),
    ]);

  return NextResponse.json({
    cleaned: {
      expired: expired || 0,
      ephemeral: ephemeral || 0,
      stale: stale || 0,
    },
  });
}

function isAuthorizedCron(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const authHeader = request.headers.get("authorization");
  return authHeader === `Bearer ${cronSecret}`;
}
