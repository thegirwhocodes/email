"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Orb } from "@/components/orb";
import { useVoice } from "@/components/use-voice";
import { useTts } from "@/components/use-tts";
import { WaveVisualizer } from "@/components/wave-visualizer";

type Stage =
  | "idle"
  | "thinking"
  | "speaking"
  | "listening"
  | "done"
  | "error";

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
  const [ttsSource, setTtsSource] = useState<string | null>(null);
  const tts = useTts({
    onSource: (source, reason) => {
      setTtsSource(reason ? `${source} (${reason})` : source);
    },
  });

  const [stage, setStage] = useState<Stage>("idle");
  const [statusText, setStatusText] = useState(
    "Tap to start your inbox catch-up."
  );
  const [errorText, setErrorText] = useState<string | null>(null);
  const [hasStarted, setHasStarted] = useState(false);

  const messagesRef = useRef<AnyMessages>([]);
  const sessionStateRef = useRef<SessionState>({});
  const [currentItem, setCurrentItem] = useState<CurrentItem | null>(null);
  const [doneReason, setDoneReason] = useState<string | null>(null);

  const stageRef = useRef<Stage>(stage);
  stageRef.current = stage;

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
    setStatusText("Thinking…");
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

      const text = data.speak_text || "I don't have anything else to add.";
      setStatusText(text);

      setStage("speaking");
      await tts.speak(text);

      if (data.done) {
        setStage("done");
        setDoneReason(data.session_state.wrap_reason || null);
        setStatusText(
          data.session_state.wrap_reason ||
            "You're caught up."
        );
        return;
      }

      await listenForUser();
    } catch (err) {
      console.error(err);
      setStage("error");
      setErrorText(err instanceof Error ? err.message : String(err));
      setStatusText("Something went wrong. Tap to try again.");
    }
  }

  async function listenForUser() {
    setStage("listening");
    setStatusText("Listening…");
    try {
      const transcript = await voice.startListening();
      if (!transcript || !transcript.trim()) {
        setStage("speaking");
        await tts.speak("I didn't catch that. Could you say it again?");
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
      setStatusText("Microphone trouble. Tap to retry.");
    }
  }

  function handleOrbTap() {
    tts.prime();
    if (!voice.supported) {
      setStatusText("Voice isn't supported here. Use Chrome on macOS.");
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

  let hint = "Tap to start";
  if (hasStarted) {
    if (tts.speaking) hint = "Tap to interrupt";
    else if (voice.listening) hint = "Tap to stop";
    else if (stage === "thinking") hint = "Working";
    else if (stage === "done") hint = "Tap to start over";
    else if (stage === "error") hint = "Tap to retry";
  }

  const sentCount = sessionStateRef.current.sent?.length ?? 0;
  const archivedCount = sessionStateRef.current.archived?.length ?? 0;

  return (
    <main className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <div className="flex items-baseline gap-5">
          <Link
            href="/"
            className="text-sm text-text tracking-[0.18em] uppercase font-medium hover:text-text-secondary transition-colors"
          >
            Voice<span className="text-text-muted"> · </span>Email
          </Link>
          <Link
            href="/digest"
            className="text-xs text-text-muted tracking-[0.15em] uppercase font-medium hover:text-text transition-colors"
          >
            Digest
          </Link>
        </div>
        <UserButton />
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-12">
        <button
          type="button"
          onClick={handleOrbTap}
          aria-label="Tap to interact"
          className="cursor-pointer focus:outline-none transition-transform active:scale-[0.97] fade-in"
        >
          <Orb mode={orbMode} />
        </button>

        <WaveVisualizer active={voice.listening} />

        {currentItem && stage !== "done" && (
          <div className="mt-7 flex items-center gap-3 fade-in">
            <span className="pill pill-accent">
              {TIER_LABEL[currentItem.tier] || currentItem.tier}
            </span>
            <span className="text-xs text-text-muted">
              {cleanFrom(currentItem.from)}
            </span>
          </div>
        )}

        <div className="mt-8 max-w-xl text-center min-h-[4.5rem] px-2 fade-in">
          <p className="text-text leading-[1.5] text-[19px] text-balance">
            {voice.partial && voice.listening ? voice.partial : statusText}
          </p>
          {errorText && (
            <p className="mt-3 text-xs text-error">{errorText}</p>
          )}
        </div>

        {stage === "done" && (sentCount > 0 || archivedCount > 0) && (
          <div className="mt-10 flex items-center gap-6 text-xs text-text-muted fade-in">
            {sentCount > 0 && (
              <span>
                <span className="text-text font-medium">{sentCount}</span> sent
              </span>
            )}
            {archivedCount > 0 && (
              <span>
                <span className="text-text font-medium">{archivedCount}</span> archived
              </span>
            )}
          </div>
        )}

        {!voice.supported && (
          <p className="mt-8 text-sm text-warning text-center max-w-sm">
            Voice isn&apos;t supported in this browser. Open in Chrome on macOS
            for the full experience.
          </p>
        )}
      </div>

      <footer className="px-6 py-5 flex items-center justify-center gap-2 text-xs text-text-muted">
        <span>{hint}</span>
        {ttsSource && (
          <>
            <span className="divider-dot" />
            <span className="opacity-50">{ttsSource}</span>
          </>
        )}
        {doneReason && stage === "done" && (
          <>
            <span className="divider-dot" />
            <Link
              href="/digest"
              className="hover:text-text transition-colors"
            >
              See the digest →
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
