"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

interface CategorizedItem {
  category: string;
  title: string;
  source: string;
  source_id: string;
  one_line: string;
}

interface DigestData {
  counts: {
    total_received: number;
    signal: number;
    opportunities: number;
    swept_noise: number;
  };
  followups: Array<{
    id: string;
    content: string;
    importance: number;
    due_date: string | null;
    source: string | null;
    source_id: string | null;
  }>;
  signal_preview: Array<{
    source_id: string;
    from: string;
    subject: string;
    tier: string;
  }>;
  opportunities: Record<string, CategorizedItem[]>;
  swept_senders: Array<{ from: string; count: number }>;
}

const CATEGORY_LABELS: Record<string, string> = {
  fellowship: "Fellowships",
  internship: "Internships",
  grant: "Grants",
  scholarship: "Scholarships",
  job: "Jobs",
  shopping: "Shopping",
  newsletter: "Newsletters",
  other: "Other",
};

const CATEGORY_ORDER = [
  "fellowship",
  "grant",
  "scholarship",
  "internship",
  "job",
  "newsletter",
  "shopping",
  "other",
];

const TIER_LABELS: Record<string, string> = {
  sabi_business: "Sabi",
  family: "Family",
  wesleyan: "Wesleyan",
  vox_church: "Vox",
  vendor_outreach: "Vendor",
  friend: "Friend",
};

export default function DigestClient() {
  const [data, setData] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/digest/daily")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setError(d.error);
        } else {
          setData(d);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <div className="flex items-baseline gap-5">
          <Link
            href="/"
            className="text-sm text-text-muted tracking-[0.18em] uppercase font-medium hover:text-text transition-colors"
          >
            Voice<span className="opacity-60"> · </span>Email
          </Link>
          <span className="text-xs text-text tracking-[0.15em] uppercase font-medium">
            Digest
          </span>
        </div>
        <UserButton />
      </header>

      <div className="flex-1 max-w-3xl mx-auto w-full px-6 py-8 space-y-8">
        {loading && (
          <p className="text-text-muted">Reading the last 24 hours…</p>
        )}

        {error && (
          <div className="bg-bg-surface border border-error/30 rounded-xl p-6">
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {data && (
          <>
            {/* Summary card */}
            <section className="bg-bg-surface border border-border rounded-xl p-6">
              <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                Last 24 hours
              </h2>
              <div className="grid grid-cols-5 gap-4 text-center">
                <Stat n={data.counts.total_received} label="received" />
                <Stat n={data.counts.signal} label="signal" />
                <Stat n={data.followups.length} label="followups" />
                <Stat n={data.counts.opportunities} label="opportunities" />
                <Stat n={data.counts.swept_noise} label="swept" />
              </div>
            </section>

            {data.followups.length > 0 && (
              <section className="bg-bg-surface border border-border rounded-xl p-6">
                <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
                  Resurfaced follow-ups
                </h2>
                <ul className="space-y-3">
                  {data.followups.map((loop) => (
                    <li
                      key={loop.id}
                      className="flex items-start gap-3 pb-3 border-b border-border-subtle last:border-0 last:pb-0"
                    >
                      <span className="text-xs text-accent shrink-0 uppercase tracking-wider w-16">
                        P{loop.importance}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-text">{loop.content}</p>
                        {loop.due_date && (
                          <p className="text-xs text-text-muted">
                            Due {new Date(loop.due_date).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/"
                  className="mt-5 inline-block text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  → Triage these by voice
                </Link>
              </section>
            )}

            {/* Signal preview — short list of stuff that needs attention */}
            {data.signal_preview.length > 0 && (
              <section className="bg-bg-surface border border-border rounded-xl p-6">
                <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
                  What needs you
                </h2>
                <ul className="space-y-3">
                  {data.signal_preview.map((s) => (
                    <li
                      key={s.source_id}
                      className="flex items-start gap-3 pb-3 border-b border-border-subtle last:border-0 last:pb-0"
                    >
                      <span className="text-xs text-accent shrink-0 uppercase tracking-wider w-16">
                        {TIER_LABELS[s.tier] || s.tier}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-text truncate">
                          {s.subject}
                        </p>
                        <p className="text-xs text-text-secondary truncate">
                          {cleanFrom(s.from)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/"
                  className="mt-5 inline-block text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  → Triage these by voice
                </Link>
              </section>
            )}

            {/* Opportunities, grouped */}
            {Object.keys(data.opportunities).length > 0 && (
              <section className="bg-bg-surface border border-border rounded-xl p-6">
                <h2 className="text-sm font-medium text-text uppercase tracking-wider mb-4">
                  Opportunities ({data.counts.opportunities})
                </h2>
                <div className="space-y-6">
                  {CATEGORY_ORDER.filter(
                    (c) => data.opportunities[c]?.length > 0
                  ).map((cat) => (
                    <div key={cat}>
                      <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">
                        {CATEGORY_LABELS[cat]} ({data.opportunities[cat].length})
                      </h3>
                      <ul className="space-y-2">
                        {data.opportunities[cat].slice(0, 8).map((item) => (
                          <li
                            key={item.source_id}
                            className="text-sm text-text-secondary"
                          >
                            <span className="text-text">{item.title}</span>
                            {item.one_line && (
                              <span className="text-text-muted">
                                {" "}
                                — {item.one_line}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Swept noise */}
            {data.swept_senders.length > 0 && (
              <section className="bg-bg-surface border border-border-subtle rounded-xl p-6 opacity-60">
                <h2 className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                  Swept ({data.counts.swept_noise} total)
                </h2>
                <ul className="space-y-1">
                  {data.swept_senders.map((s) => (
                    <li
                      key={s.from}
                      className="text-xs text-text-muted flex justify-between"
                    >
                      <span className="truncate">{cleanFrom(s.from)}</span>
                      <span className="ml-3 shrink-0">{s.count}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <p className="text-2xl font-semibold text-text">{n}</p>
      <p className="text-xs text-text-muted uppercase tracking-wider">{label}</p>
    </div>
  );
}

function cleanFrom(from: string): string {
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, "");
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}
