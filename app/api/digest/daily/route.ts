import { NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";
import { supabase } from "@/lib/supabase/client";
import { classifySender, type Tier } from "@/lib/agent/sender-tiers";
import { queryHaiku } from "@/lib/ai/claude";
import { loadAssistantContext } from "@/lib/assistant-memory";

// /api/digest/daily — pulls the last 24h of inbox and rolls up the noise/
// opportunity tiers into one glanceable card. Business/family/wesleyan/vox_church
// items live in the voice-email triage UI; this endpoint is for the OPPORTUNITY
// tier specifically (fellowships, internships, scholarships, jobs) plus a
// summary line for the day.

export const maxDuration = 120;

interface InboxEmail {
  source_id: string;
  from: string;
  subject: string;
  date: string | null;
  tier: Tier;
  snippet: string;
}

interface CategorizedItem {
  category:
    | "fellowship"
    | "internship"
    | "grant"
    | "scholarship"
    | "job"
    | "shopping"
    | "newsletter"
    | "other";
  title: string;
  source: string;
  source_id: string;
  one_line: string;
}

export async function GET() {
  try {
    const userId = await getUserId();
    const assistantContext = await loadAssistantContext(userId, {
      memoryLimit: 0,
      loopLimit: 12,
    });

    const sinceIso = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();

    const { data: rows } = await supabase
      .from("cortex_documents")
      .select("source_id, content, metadata, source_created_at")
      .eq("user_id", userId)
      .eq("content_type", "email_received")
      .eq("chunk_index", 0)
      .gte("source_created_at", sinceIso)
      .order("source_created_at", { ascending: false })
      .limit(200);

    const emails: InboxEmail[] = (rows || []).map((r) => {
      const meta = (r.metadata as Record<string, unknown>) || {};
      const from = (meta.from as string) || "Unknown";
      const subject = (meta.subject as string) || "(no subject)";
      const labels = (meta.labels as string[]) || [];
      const cls = classifySender({ from, subject, labels });
      return {
        source_id: r.source_id,
        from,
        subject,
        date: r.source_created_at,
        tier: cls.tier,
        snippet: (r.content || "").slice(0, 300),
      };
    });

    // Buckets:
    //  - opportunities = the fellowship/intern/scholarship drumbeat
    //  - swept = noise that we'd auto-archive (just count it, don't surface)
    //  - signal = business / family / wesleyan / vox_church / vendor_outreach / friend
    const opportunities = emails.filter((e) => e.tier === "opportunity");
    const swept = emails.filter((e) => e.tier === "noise");
    const signal = emails.filter(
      (e) =>
        e.tier === "business" ||
        e.tier === "family" ||
        e.tier === "wesleyan" ||
        e.tier === "vox_church" ||
        e.tier === "vendor_outreach" ||
        e.tier === "friend"
    );

    // Have Haiku produce one-line summaries + categories for the opportunities
    let categorized: CategorizedItem[] = [];
    if (opportunities.length > 0) {
      const list = opportunities
        .slice(0, 30)
        .map(
          (e, i) =>
            `[${i}] from: ${e.from} | subject: ${e.subject}\nbody excerpt: ${e.snippet}`
        )
        .join("\n\n");

      const haikuOut = await queryHaiku(
        `You compress opportunity emails (fellowships, internships, scholarships, grants, jobs) into one-line cards. Output STRICT JSON array, one object per input, in the same order:
{"category": "fellowship"|"internship"|"grant"|"scholarship"|"job"|"shopping"|"newsletter"|"other", "title": "<≤50 char headline>", "one_line": "<≤80 char what-it-is + key-detail>"}
Rules: title is the actual program/role/opportunity name. one_line tells the user the WHAT and the relevant DETAIL (deadline / pay / location / who's offering). No filler.
Output only the JSON array, no markdown fences.`,
        list,
        2000
      );

      try {
        const cleaned = haikuOut
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        const parsed = JSON.parse(cleaned) as Array<{
          category: string;
          title: string;
          one_line: string;
        }>;
        categorized = parsed.map((p, i) => ({
          category: (p.category || "other") as CategorizedItem["category"],
          title: p.title?.slice(0, 80) || opportunities[i]?.subject || "",
          one_line: p.one_line?.slice(0, 120) || "",
          source: opportunities[i]?.from || "",
          source_id: opportunities[i]?.source_id || "",
        }));
      } catch {
        // Fall back to raw subjects if JSON parse fails
        categorized = opportunities.slice(0, 30).map((o) => ({
          category: "other",
          title: o.subject,
          one_line: o.snippet.slice(0, 80),
          source: o.from,
          source_id: o.source_id,
        }));
      }
    }

    // Group categorized
    const byCategory: Record<string, CategorizedItem[]> = {};
    for (const c of categorized) {
      if (!byCategory[c.category]) byCategory[c.category] = [];
      byCategory[c.category].push(c);
    }

    const counts = {
      total_received: emails.length,
      signal: signal.length,
      opportunities: opportunities.length,
      swept_noise: swept.length,
    };

    return NextResponse.json({
      window_start: sinceIso,
      counts,
      followups: assistantContext.openLoops,
      signal_preview: signal.slice(0, 15).map((e) => ({
        source_id: e.source_id,
        from: e.from,
        subject: e.subject,
        tier: e.tier,
      })),
      opportunities: byCategory,
      swept_senders: dedupeFroms(swept).slice(0, 20),
    });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("Daily digest error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Digest failed" },
      { status: 500 }
    );
  }
}

function dedupeFroms(emails: InboxEmail[]): Array<{ from: string; count: number }> {
  const m = new Map<string, number>();
  for (const e of emails) m.set(e.from, (m.get(e.from) || 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([from, count]) => ({ from, count }));
}
