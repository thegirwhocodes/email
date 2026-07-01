import { NextRequest, NextResponse } from "next/server";
import {
  closeLoopsNotInSet,
  FOLLOWUP_LOOP_SOURCE,
  PROMISE_LOOP_SOURCE,
  rememberFollowupCreated,
  upsertOpenLoop,
} from "@/lib/assistant-memory";
import { computeActiveFollowups } from "@/lib/followups";
import { supabase } from "@/lib/supabase/client";
import { isAuthorizedCron } from "@/lib/auth/cron";

export const maxDuration = 300;

async function runCron(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: integrations, error } = await supabase
    .from("cortex_integrations")
    .select("user_id")
    .eq("provider", "gmail")
    .eq("status", "active");

  if (error) {
    console.error("followups cron query error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const userIds = [...new Set((integrations || []).map((row) => row.user_id))];
  let processedUsers = 0;
  let created = 0;
  let updated = 0;
  let closed = 0;
  let errors = 0;

  for (const userId of userIds) {
    try {
      const { threadLoops, promiseLoops } = await computeActiveFollowups(userId);
      const allLoops = [...threadLoops, ...promiseLoops];
      const activeSourceIds = new Set(allLoops.map((loop) => loop.sourceId));

      for (const loop of allLoops) {
        const result = await upsertOpenLoop({
          userId,
          source: loop.source,
          sourceId: loop.sourceId,
          content: loop.content,
          importance: loop.importance,
          dueDate: loop.dueDate,
        });

        if (result === "created") {
          created++;
          await rememberFollowupCreated({
            userId,
            fact: loop.memoryFact,
            priority: loop.importance >= 5 ? "high" : "medium",
          });
        } else {
          updated++;
        }
      }

      closed += await closeLoopsNotInSet({
        userId,
        sources: [FOLLOWUP_LOOP_SOURCE, PROMISE_LOOP_SOURCE],
        activeSourceIds,
      });
      processedUsers++;
    } catch (userError) {
      console.error(`followups cron failed for user ${userId}:`, userError);
      errors++;
    }
  }

  return NextResponse.json({
    processedUsers,
    created,
    updated,
    closed,
    errors,
    totalUsers: userIds.length,
  });
}

export const GET = runCron;
export const POST = runCron;
