"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { useVoice } from "@/components/use-voice";
import { useTts } from "@/components/use-tts";
import { CommandPalette } from "@/components/command-palette";

// Streaming voice-email client: per-email window UI, ambient voice, single LLM
// call per turn via /api/assistant/stream. Pre-loads everything on session init.

interface SessionEmail {
  source_id: string;
  thread_id: string | null;
  from: string;
  subject: string;
  date: string | null;
  tier: string;
  is_important: boolean;
  excerpt: string;
  full_body?: string;
  thread_excerpt?: string;
}

interface SessionBundle {
  user: { id: string; email: string; name: string | null };
  profile_text: string | null;
  open_followups: Array<{ content: string; importance: number; due_date: string | null }>;
  memory_facts: string[];
  queue: SessionEmail[];
  generated_at: string;
}

interface ParsedMeta {
  focus_id: string | null;
  action: "draft" | "send" | "skip" | "archive" | "wrap" | null;
  draft_direction: string | null;
  wrap_reason: string | null;
}

type ChatMsg = { role: "user" | "assistant"; content: string };

type Stage =
  | "idle"
  | "initializing"
  | "ready"
  | "thinking"
  | "speaking"
  | "listening"
  | "acting"
  | "done"
  | "error";

const TIER_LABEL: Record<string, string> = {
  business: "Founder",
  family: "Family",
  wesleyan: "Wesleyan",
  vox_church: "Vox",
  vendor_outreach: "Vendor",
  friend: "Friend",
  opportunity: "Opportunity",
  unknown: "—",
};

export default function VoiceEmailClient() {
  const voice = useVoice();
  const tts = useTts();

  const [stage, setStage] = useState<Stage>("idle");
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const [conversation, setConversation] = useState<ChatMsg[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("Tap to begin.");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [providerName, setProviderName] = useState<string | null>(null);
  const [hasStarted, setHasStarted] = useState(false);
  const [sessionDone, setSessionDone] = useState(false);
  const [doneReason, setDoneReason] = useState<string | null>(null);
  const [stats, setStats] = useState({ sent: 0, archived: 0, skipped: 0 });

  const conversationRef = useRef<ChatMsg[]>([]);
  conversationRef.current = conversation;
  const bundleRef = useRef<SessionBundle | null>(null);
  bundleRef.current = bundle;
  const focusRef = useRef<string | null>(null);
  focusRef.current = focusId;
  const draftRef = useRef<string | null>(null);
  draftRef.current = draftText;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "1") return;
    const timer = window.setTimeout(() => setDebug(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Edge-of-viewport voice indicator state
  useEffect(() => {
    if (typeof document === "undefined") return;
    const state = tts.speaking
      ? "speaking"
      : voice.listening
      ? "listening"
      : stage === "thinking" || stage === "acting"
      ? "thinking"
      : "idle";
    document.body.setAttribute("data-voice-state", state);
    return () => {
      document.body.removeAttribute("data-voice-state");
    };
  }, [tts.speaking, voice.listening, stage]);

  const focusEmail = bundle?.queue.find((e) => e.source_id === focusId) ?? null;

  // ============================================================
  // Session init
  // ============================================================
  async function startSession() {
    setHasStarted(true);
    setStage("initializing");
    setStatusLine("Reading your inbox…");
    setErrorMsg(null);
    setSessionDone(false);
    setStats({ sent: 0, archived: 0, skipped: 0 });
    setConversation([]);
    setFocusId(null);
    setDraftText(null);

    try {
      const res = await fetch("/api/assistant/init", { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `init failed (${res.status})`);
      }
      const b: SessionBundle = await res.json();
      setBundle(b);
      bundleRef.current = b;

      if (b.queue.length === 0) {
        setStage("done");
        setStatusLine("Quiet inbox. Nothing waiting.");
        await tts.speak("Quiet inbox. Nothing waiting.");
        setSessionDone(true);
        return;
      }

      setStage("ready");
      // Kick off the first turn — user implicitly says "begin"
      await runTurn("begin");
    } catch (err) {
      console.error(err);
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusLine("Lost the thread. Tap.");
    }
  }

  // ============================================================
  // Per-turn: stream from /api/assistant/stream, sentence-buffer to TTS
  // ============================================================
  async function runTurn(userText: string) {
    if (!bundleRef.current) {
      setStage("error");
      setErrorMsg("Session not initialized");
      return;
    }

    const focusAtTurnStart = focusRef.current;
    setStage("thinking");
    setStatusLine("");

    // Append user turn to history (unless it's the synthetic "begin")
    const newConversation =
      userText === "begin"
        ? conversationRef.current
        : [
            ...conversationRef.current,
            { role: "user" as const, content: userText },
          ];
    if (userText !== "begin") setConversation(newConversation);

    // Sentence buffer for chunked TTS
    let sayAccum = "";
    let lastSpokenIndex = 0;
    let pendingSpeak: Promise<void> = Promise.resolve();
    let metaReceived: ParsedMeta | null = null;

    function maybeFlushSentence(force = false) {
      const tail = sayAccum.slice(lastSpokenIndex);
      // Find a sentence boundary
      const boundary = force
        ? tail.length
        : (() => {
            const m = tail.match(/[\.!\?](\s|$)/);
            return m ? m.index! + 1 : -1;
          })();
      if (boundary < 0) return;
      const chunk = tail.slice(0, boundary).trim();
      lastSpokenIndex += boundary;
      if (chunk.length === 0) return;
      // Queue this sentence after any in-flight TTS
      pendingSpeak = pendingSpeak
        .then(() => {
          setStage("speaking");
          return tts.speak(chunk);
        })
        .catch(() => undefined);
    }

    try {
      const res = await fetch("/api/assistant/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bundle: bundleRef.current,
          conversation: newConversation,
          user_text: userText,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`stream failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "";
      let currentData = "";

      readLoop: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (line === "") {
            // Event terminator
            if (currentEvent && currentData) {
              try {
                const data = JSON.parse(currentData);
                if (currentEvent === "chunk") {
                  sayAccum += data.text;
                  setStatusLine(sayAccum);
                  maybeFlushSentence();
                } else if (currentEvent === "meta") {
                  metaReceived = data as ParsedMeta;
                  if (metaReceived.focus_id) {
                    if (typeof document !== "undefined" && (document as unknown as { startViewTransition?: (cb: () => void) => void }).startViewTransition) {
                      (document as unknown as { startViewTransition: (cb: () => void) => void }).startViewTransition(() => {
                        setFocusId(metaReceived!.focus_id);
                      });
                    } else {
                      setFocusId(metaReceived.focus_id);
                    }
                    focusRef.current = metaReceived.focus_id;
                  }
                } else if (currentEvent === "provider") {
                  setProviderName(data.name);
                } else if (currentEvent === "done") {
                  if (debug) {
                    console.log("[turn]", data);
                  }
                } else if (currentEvent === "error") {
                  throw new Error(data.message);
                }
              } catch (e) {
                console.warn("[stream] bad event payload", currentEvent, currentData, e);
              }
              currentEvent = "";
              currentData = "";
            }
            continue;
          }
          if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
          else if (line.startsWith("data: ")) currentData = line.slice(6).trim();
        }
      }

      // Flush any remaining text
      maybeFlushSentence(true);
      await pendingSpeak;

      // Append assistant turn to history
      const assistantMsg = sayAccum.trim() || "Nothing to add.";
      const afterAssistantConversation = [
        ...newConversation,
        { role: "assistant" as const, content: assistantMsg },
      ];
      conversationRef.current = afterAssistantConversation;
      setConversation(afterAssistantConversation);

      // Handle the action
      if (metaReceived) {
        await executeAction(metaReceived, focusAtTurnStart);
      } else {
        // No action → wait for user
        if (!sessionDone) {
          await listenForUser();
        }
      }
    } catch (err) {
      console.error(err);
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusLine("Lost the thread. Tap.");
    }
  }

  // ============================================================
  // Action execution — wires META to actual API endpoints
  // ============================================================
  async function executeAction(meta: ParsedMeta, focusAtTurnStart: string | null) {
    const currentFocusId = focusAtTurnStart || meta.focus_id || focusRef.current;
    const focus = bundleRef.current?.queue.find(
      (e) => e.source_id === currentFocusId
    );

    if (meta.action === "wrap") {
      void persistSessionAction({
        action: "wrap",
        reason: meta.wrap_reason || "the important inbox items were handled",
      });
      setStage("done");
      setSessionDone(true);
      setDoneReason(meta.wrap_reason);
      setStatusLine(meta.wrap_reason || "Quiet now.");
      return;
    }

    if (meta.action === "draft" && focus) {
      setStage("acting");
      setStatusLine("Drafting in your voice…");
      try {
        const res = await fetch("/api/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: focus.from,
            subject: focus.subject,
            body: focus.full_body || focus.excerpt,
            threadId: focus.thread_id,
            intent: meta.draft_direction,
          }),
        });
        const data = await res.json();
        const draft = (data.draft as string) || "";
        if (!draft) {
          await tts.speak("Couldn't draft that. Skipping.");
          await listenForUser();
          return;
        }
        setDraftText(draft);
        draftRef.current = draft;
        // Read the draft back
        await tts.speak(`Here's what I'd say. ${draft}`);
        await listenForUser();
      } catch {
        await tts.speak("Draft failed. Moving on.");
        await listenForUser();
      }
      return;
    }

    if (meta.action === "send" && focus) {
      const draft = draftRef.current;
      if (!draft) {
        await tts.speak("No draft to send. Want me to draft one?");
        await listenForUser();
        return;
      }
      setStage("acting");
      setStatusLine("Sending…");
      try {
        const fromEmail = extractEmail(focus.from);
        const subject = focus.subject.startsWith("Re:")
          ? focus.subject
          : `Re: ${focus.subject}`;
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: fromEmail,
            subject,
            body: draft,
            threadId: focus.thread_id,
            sourceId: focus.source_id,
            from: focus.from,
            originalSubject: focus.subject,
          }),
        });
        if (!res.ok) throw new Error("send failed");
        setStats((s) => ({ ...s, sent: s.sent + 1 }));
        setDraftText(null);
        draftRef.current = null;
        const remaining = removeFromQueue(focus.source_id);
        if (remaining.length > 0) {
          await runTurn("continue");
        } else {
          finishQuietly("That was the last important one.");
        }
      } catch {
        await tts.speak("Couldn't send. Moving on.");
        await listenForUser();
      }
      return;
    }

    if (meta.action === "archive" && focus) {
      setStage("acting");
      try {
        const res = await fetch("/api/archive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageId: focus.source_id,
            from: focus.from,
            subject: focus.subject,
          }),
        });
        if (!res.ok) throw new Error("archive failed");
        setStats((s) => ({ ...s, archived: s.archived + 1 }));
      } catch {
        await tts.speak("Couldn't archive that.");
        await listenForUser();
        return;
      }
      const remaining = removeFromQueue(focus.source_id);
      if (remaining.length > 0) {
        await runTurn("continue");
      } else {
        finishQuietly("That was the last important one.");
      }
      return;
    }

    if (meta.action === "skip") {
      const skipped = bundleRef.current?.queue.find(
        (e) => e.source_id === (focusAtTurnStart || focusRef.current)
      );
      if (skipped) {
        void persistSessionAction({
          action: "skip",
          item: {
            source_id: skipped.source_id,
            from: skipped.from,
            subject: skipped.subject,
          },
        });
        const remaining = removeFromQueue(skipped.source_id);
        if (remaining.length === 0 && !meta.focus_id) {
          finishQuietly("That was the last important one.");
          return;
        }
      }
      setStats((s) => ({ ...s, skipped: s.skipped + 1 }));
      await listenForUser();
      return;
    }

    // No action / null — just listen
    await listenForUser();
  }

  function removeFromQueue(sourceId: string): SessionEmail[] {
    if (!bundleRef.current) return [];
    const nextBundle: SessionBundle = {
      ...bundleRef.current,
      queue: bundleRef.current.queue.filter((e) => e.source_id !== sourceId),
    };
    bundleRef.current = nextBundle;
    setBundle(nextBundle);
    return nextBundle.queue;
  }

  function finishQuietly(reason: string) {
    void persistSessionAction({ action: "wrap", reason });
    setStage("done");
    setSessionDone(true);
    setDoneReason(reason);
    setStatusLine(reason);
  }

  async function persistSessionAction(payload: {
    action: "skip" | "wrap";
    reason?: string;
    item?: { source_id: string; from: string; subject: string };
  }) {
    try {
      await fetch("/api/assistant/session-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Memory persistence should never interrupt the live voice loop.
    }
  }

  // ============================================================
  // Listening
  // ============================================================
  async function listenForUser() {
    if (sessionDone) return;
    setStage("listening");
    setStatusLine("");
    try {
      const transcript = await voice.startListening();
      if (!transcript || !transcript.trim()) {
        setStage("speaking");
        await tts.speak("Say that again?");
        return await listenForUser();
      }
      await runTurn(transcript);
    } catch (err) {
      console.error(err);
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatusLine("Mic dropped. Tap.");
    }
  }

  // ============================================================
  // Tap handler
  // ============================================================
  function handlePrimaryTap() {
    tts.prime();
    if (!voice.supported) {
      setStatusLine("Voice needs Chrome on macOS.");
      return;
    }
    if (tts.speaking) {
      tts.cancel();
      setStage("listening");
      void listenForUser();
      return;
    }
    if (voice.listening) {
      voice.stopListening();
      return;
    }
    if (sessionDone || stage === "done") {
      void startSession();
      return;
    }
    if (stage === "error") {
      void startSession();
      return;
    }
    if (!hasStarted) {
      void startSession();
      return;
    }
  }

  let hint = "tap to begin.";
  if (hasStarted) {
    if (stage === "initializing") hint = "loading inbox…";
    else if (tts.speaking) hint = "tap to interrupt.";
    else if (voice.listening) hint = "tap to stop.";
    else if (stage === "thinking") hint = "thinking…";
    else if (stage === "acting") hint = "working…";
    else if (sessionDone || stage === "done") hint = "tap for another pass.";
    else if (stage === "error") hint = "tap to retry.";
  }

  return (
    <main className="min-h-screen flex flex-col">
      <CommandPalette onStartSession={() => void startSession()} />

      <header className="flex items-center justify-between px-8 py-6">
        <div className="flex items-baseline gap-6">
          <Link
            href="/"
            className="font-serif italic text-base text-text hover:text-text-secondary transition-colors"
          >
            voice email
          </Link>
        </div>
        <UserButton />
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-4 max-w-3xl mx-auto w-full">
        {!hasStarted && (
          <div className="text-center fade-in">
            <p className="text-display-serif text-text text-balance max-w-xl">
              The smart, reliable email friend you wish you had.
            </p>
            <button
              type="button"
              onClick={handlePrimaryTap}
              className="btn-primary mt-10"
            >
              begin
            </button>
          </div>
        )}

        {hasStarted && stage === "initializing" && (
          <div className="text-center fade-in">
            <p className="text-text-secondary text-lg">Reading your inbox…</p>
          </div>
        )}

        {hasStarted && focusEmail && !sessionDone && (
          <div
            key={focusEmail.source_id}
            className="w-full"
            style={{
              viewTransitionName: "current-email",
            }}
          >
            <button
              type="button"
              onClick={handlePrimaryTap}
              className="block w-full text-left cursor-pointer focus:outline-none fade-in"
            >
              <article className="rounded-2xl border border-border bg-bg-surface px-8 py-7 hover:border-border-strong transition-colors">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <span className="pill pill-accent">
                    {TIER_LABEL[focusEmail.tier] || focusEmail.tier}
                  </span>
                  {focusEmail.is_important && (
                    <span className="eyebrow text-warning">important</span>
                  )}
                  {focusEmail.date && (
                    <span className="eyebrow text-text-faint ml-auto">
                      {formatDate(focusEmail.date)}
                    </span>
                  )}
                </div>

                <h2 className="text-2xl font-medium text-text leading-snug tracking-tight mb-1.5">
                  {focusEmail.subject}
                </h2>
                <p className="text-sm text-text-secondary mb-5">
                  {cleanFrom(focusEmail.from)}
                </p>

                <p className="text-text-secondary text-[15px] leading-relaxed line-clamp-5 whitespace-pre-wrap">
                  {focusEmail.full_body
                    ? truncate(focusEmail.full_body, 600)
                    : focusEmail.excerpt}
                </p>
              </article>
            </button>

            {/* The agent's spoken line — assistant voice in serif italic */}
            <div className="mt-7 px-2 min-h-[5rem]">
              {(stage === "speaking" || statusLine) && (
                <p className="text-display-serif text-text text-balance fade-in">
                  {statusLine || "…"}
                </p>
              )}
              {voice.partial && voice.listening && (
                <p className="text-text-secondary text-lg italic text-balance fade-in opacity-80">
                  {voice.partial}
                </p>
              )}
              {draftText && stage !== "speaking" && (
                <p className="mt-4 text-text-muted text-sm whitespace-pre-wrap">
                  <span className="eyebrow">draft</span>
                  <br />
                  {draftText}
                </p>
              )}
            </div>

            {bundle && bundle.queue.length > 1 && (
              <div className="mt-8 flex items-center justify-center gap-1.5 opacity-60">
                {bundle.queue.slice(0, 12).map((e) => (
                  <span
                    key={e.source_id}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                      e.source_id === focusId ? "bg-accent" : "bg-text-muted"
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {sessionDone && (
          <div className="text-center fade-in">
            <p className="text-display-serif text-text text-balance">
              {doneReason || "Quiet now."}
            </p>
            {(stats.sent > 0 || stats.archived > 0 || stats.skipped > 0) && (
              <div className="mt-8 flex items-center gap-6 eyebrow text-text-muted justify-center">
                {stats.sent > 0 && (
                  <span>
                    <span className="text-text font-medium">{stats.sent}</span>{" "}
                    sent
                  </span>
                )}
                {stats.archived > 0 && (
                  <span>
                    <span className="text-text font-medium">
                      {stats.archived}
                    </span>{" "}
                    archived
                  </span>
                )}
                {stats.skipped > 0 && (
                  <span>
                    <span className="text-text font-medium">
                      {stats.skipped}
                    </span>{" "}
                    skipped
                  </span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handlePrimaryTap}
              className="btn-primary mt-10"
            >
              another pass
            </button>
          </div>
        )}

        {stage === "error" && errorMsg && debug && (
          <p className="mt-6 text-xs text-error font-mono">{errorMsg}</p>
        )}

        {!voice.supported && (
          <p className="mt-8 text-xs text-warning text-center max-w-sm">
            Open in Chrome on macOS for voice.
          </p>
        )}
      </div>

      <footer className="px-8 py-6 flex items-center justify-center gap-2 eyebrow text-text-faint">
        <span>{hint}</span>
        <span className="divider-dot" />
        <kbd className="font-mono text-[10px] tracking-normal normal-case px-1.5 py-0.5 rounded bg-bg-elevated border border-border-subtle">
          ⌘K
        </kbd>
        {debug && providerName && (
          <>
            <span className="divider-dot" />
            <span className="opacity-60 normal-case tracking-normal font-mono text-[10px]">
              {providerName}
            </span>
          </>
        )}
      </footer>
    </main>
  );
}

function cleanFrom(from: string): string {
  const nameMatch = from.match(/^([^<]+)</);
  if (nameMatch) return nameMatch[1].trim().replace(/^["']|["']$/g, "");
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return m ? m[1] : from;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + "…";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
