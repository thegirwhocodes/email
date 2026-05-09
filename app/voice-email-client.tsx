"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Mesh } from "@/components/mesh";
import { useVoice } from "@/components/use-voice";
import { useTts } from "@/components/use-tts";
import { CommandPalette } from "@/components/command-palette";

type Stage = "idle" | "thinking" | "speaking" | "listening" | "done" | "error";

interface CurrentItem {
  source_id: string;
  from: string;
  subject: string;
  tier: string;
  one_line_reason: string;
}

interface SessionState {
  current_item?: CurrentItem;
  done?: boolean;
  wrap_reason?: string;
  sent?: Array<{ source_id: string; messageId: string }>;
  archived?: Array<{ source_id: string }>;
  drafted?: Array<{ source_id: string }>;
}

type AnyMessages = unknown[];

const TIER_LABEL: Record<string, string> = {
  sabi_business: "Sabi",
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
  const [debug, setDebug] = useState(false);
  const [ttsSource, setTtsSource] = useState<string | null>(null);
  const tts = useTts({
    onSource: (source, reason) => {
      setTtsSource(reason ? `${source} (${reason})` : source);
    },
  });

  const [stage, setStage] = useState<Stage>("idle");
  const [statusText, setStatusText] = useState("Tap to begin.");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hasStarted, setHasStarted] = useState(false);

  const messagesRef = useRef<AnyMessages>([]);
  const sessionStateRef = useRef<SessionState>({});
  const [currentItem, setCurrentItem] = useState<CurrentItem | null>(null);
  const [doneReason, setDoneReason] = useState<string | null>(null);

  // ?debug=1 unlocks the TTS source line in the footer
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") === "1") setDebug(true);
  }, []);

  // Sync the body data attribute so the edge-of-viewport glow can animate
  useEffect(() => {
    if (typeof document === "undefined") return;
    const state = tts.speaking
      ? "speaking"
      : voice.listening
      ? "listening"
      : stage === "thinking"
      ? "thinking"
      : "idle";
    document.body.setAttribute("data-voice-state", state);
    return () => {
      document.body.removeAttribute("data-voice-state");
    };
  }, [tts.speaking, voice.listening, stage]);

  async function startSession() {
    setHasStarted(true);
    messagesRef.current = [{ role: "user", content: "begin" }];
    sessionStateRef.current = {};
    setCurrentItem(null);
    setDoneReason(null);
    setErrorText(null);
    await runOneTurn();
  }

  async function runOneTurn() {
    setStage("thinking");
    setStatusText("");
    try {
      const res = await fetch("/api/assistant/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messagesRef.current,
          session_state: sessionStateRef.current,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `turn failed (${res.status})`);
      }
      const data: {
        speak_text: string;
        messages: AnyMessages;
        session_state: SessionState;
        done: boolean;
      } = await res.json();

      messagesRef.current = data.messages;
      sessionStateRef.current = data.session_state;
      setCurrentItem(data.session_state.current_item || null);

      const text = data.speak_text || "Nothing to add.";
      setStatusText(text);

      setStage("speaking");
      await tts.speak(text);

      if (data.done) {
        setStage("done");
        setDoneReason(data.session_state.wrap_reason || null);
        setStatusText(data.session_state.wrap_reason || "Quiet now.");
        return;
      }

      await listenForUser();
    } catch (err) {
      console.error(err);
      setStage("error");
      setErrorText(err instanceof Error ? err.message : String(err));
      setStatusText("Lost the thread. Tap.");
    }
  }

  async function listenForUser() {
    setStage("listening");
    setStatusText("");
    try {
      const transcript = await voice.startListening();
      if (!transcript || !transcript.trim()) {
        setStage("speaking");
        await tts.speak("Say that again?");
        return await listenForUser();
      }
      messagesRef.current = [
        ...messagesRef.current,
        { role: "user", content: transcript },
      ];
      await runOneTurn();
    } catch (err) {
      console.error(err);
      setStage("error");
      setErrorText(err instanceof Error ? err.message : String(err));
      setStatusText("Mic dropped. Tap.");
    }
  }

  function handleOrbTap() {
    tts.prime();
    if (!voice.supported) {
      setStatusText("Voice needs Chrome on macOS.");
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
    if (stage === "done") {
      void startSession();
      return;
    }
    if (stage === "error") {
      void runOneTurn();
      return;
    }
    if (!hasStarted) {
      void startSession();
      return;
    }
  }

  const orbMode: "idle" | "speaking" | "listening" | "thinking" | "done" =
    tts.speaking
      ? "speaking"
      : voice.listening
      ? "listening"
      : stage === "thinking"
      ? "thinking"
      : stage === "done"
      ? "done"
      : "idle";

  let hint = "tap to begin.";
  if (hasStarted) {
    if (tts.speaking) hint = "tap to interrupt.";
    else if (voice.listening) hint = "tap to stop.";
    else if (stage === "thinking") hint = "";
    else if (stage === "done") hint = "tap for another pass.";
    else if (stage === "error") hint = "tap to retry.";
  }

  const sentCount = sessionStateRef.current.sent?.length ?? 0;
  const archivedCount = sessionStateRef.current.archived?.length ?? 0;

  // Two voices on one surface: assistant lines render in serif italic,
  // user transcript renders in sans, lower opacity.
  const showingPartial = !!voice.partial && voice.listening;

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
          <Link
            href="/digest"
            className="eyebrow text-text-muted hover:text-text transition-colors"
          >
            digest
          </Link>
        </div>
        <UserButton />
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-12">
        <button
          type="button"
          onClick={handleOrbTap}
          aria-label="Tap to interact"
          className="cursor-pointer focus:outline-none transition-transform active:scale-[0.96] fade-in"
          style={{ transitionTimingFunction: "var(--ease-decel)" }}
        >
          <Mesh mode={orbMode} analyser={tts.analyser} size={320} />
        </button>

        {currentItem && stage !== "done" && (
          <div className="mt-8 eyebrow fade-in">
            <span className="text-accent">
              {TIER_LABEL[currentItem.tier] || currentItem.tier}
            </span>
            <span className="divider-dot text-text-muted" />
            <span className="text-text-secondary normal-case tracking-normal">
              {cleanFrom(currentItem.from)}
            </span>
          </div>
        )}

        <div className="mt-10 max-w-2xl text-center min-h-[5rem] px-2">
          {stage === "speaking" || stage === "done" ? (
            <p className="text-display-serif text-text text-balance fade-in">
              {statusText}
            </p>
          ) : showingPartial ? (
            <p className="text-text-secondary text-lg italic text-balance fade-in opacity-80">
              {voice.partial}
            </p>
          ) : (
            <p className="text-text-muted text-lg text-balance">
              {statusText}
            </p>
          )}
          {errorText && debug && (
            <p className="mt-3 text-xs text-error font-mono">{errorText}</p>
          )}
        </div>

        {stage === "done" && (sentCount > 0 || archivedCount > 0) && (
          <div className="mt-10 flex items-center gap-6 eyebrow fade-in delay-200">
            {sentCount > 0 && (
              <span>
                <span className="text-text font-medium">{sentCount}</span> sent
              </span>
            )}
            {archivedCount > 0 && (
              <span>
                <span className="text-text font-medium">{archivedCount}</span>{" "}
                archived
              </span>
            )}
          </div>
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
        {debug && ttsSource && (
          <>
            <span className="divider-dot" />
            <span className="opacity-60 normal-case tracking-normal font-mono text-[10px]">
              {ttsSource}
            </span>
          </>
        )}
        {doneReason && stage === "done" && (
          <>
            <span className="divider-dot" />
            <Link href="/digest" className="hover:text-text transition-colors">
              digest →
            </Link>
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
