"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// TTS hook with per-message fallback chain:
//   1. Try ElevenLabs via /api/tts
//   2. If fetch fails, response is non-OK, audio.play() rejects (autoplay
//      block), or anything else goes wrong → fall back to browser
//      SpeechSynthesis for THIS message and properly wait for it to finish.
//
// Browser autoplay policy: audio can only play after a user gesture. We use
// `prime()` to "unlock" audio playback on the first user tap so subsequent
// programmatic plays (which originate from a fetch callback, not a direct
// gesture) still work.

interface UseTtsOptions {
  /** Optional callback when TTS source is decided (for diagnostics). */
  onSource?: (source: "elevenlabs" | "browser" | "none", reason?: string) => void;
}

export function useTts(options: UseTtsOptions = {}) {
  const { onSource } = options;
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const browserVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const primedRef = useRef(false);
  const elevenLabsAvailableRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const preferred = ["Samantha", "Ava", "Allison", "Karen", "Moira", "Google US English"];
      for (const name of preferred) {
        const v = voices.find((vv) => vv.name.includes(name));
        if (v) {
          browserVoiceRef.current = v;
          return;
        }
      }
      browserVoiceRef.current =
        voices.find((v) => v.lang.startsWith("en")) || voices[0];
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
  }, []);

  // Call this in response to a user gesture (tap) to "unlock" audio playback.
  // Without this, programmatic Audio.play() after fetch() may be blocked.
  // Belt-and-suspenders: AudioContext.resume() + silent <audio> + warmed
  // SpeechSynthesis. All three are widely-known unlock patterns; using all
  // three covers Chrome/Safari/Firefox quirks.
  const prime = useCallback(() => {
    if (primedRef.current) return;
    primedRef.current = true;

    // 1. AudioContext unlock — most robust across modern browsers
    try {
      const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext })
          .AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        if (ctx.state === "suspended") void ctx.resume();
        // Play a 1-sample silent buffer to satisfy Safari
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      }
    } catch {
      /* ignore */
    }

    // 2. Silent <audio> element — additional unlock for HTMLAudioElement
    try {
      const silentMp3 =
        "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAABJbmZvAAAADwAAAAIAAAGwAGZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZv////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAYAAAAAAAAAAbDqJvtLAAAAAAAAAAAAAAAAAAAAAP/7UMQAAAjAhxFkmEABRpqj3MykAEgAYAAAJZARMTNRyG9PI9KAhBwIH3xACBwY4Pn8u/8H4P//5d5d/l4Pgg7//KBjg+H4Pn4PhAEAQBAMHwfB8H/y4Pg+CAYf/B8Hwf/wIBgYBg+EAxEFwhGITKYBARGKQRGRiBExGGRkY3UFKZmZmZkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkp";
      const a = new Audio(silentMp3);
      a.volume = 0;
      void a.play().catch(() => {
        /* ignore — best-effort unlock */
      });
    } catch {
      /* ignore */
    }

    // 3. SpeechSynthesis warmup — Safari requires a gesture-triggered
    //    utterance before later programmatic ones will speak
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        window.speechSynthesis.speak(u);
        // Cancel after a tick so it doesn't queue up
        setTimeout(() => {
          try {
            window.speechSynthesis.cancel();
          } catch {
            /* ignore */
          }
        }, 50);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const cancel = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = "";
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  const speakBrowser = useCallback((text: string): Promise<void> => {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        resolve();
        return;
      }
      window.speechSynthesis.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = "en-US";
      utt.rate = 1.0;
      utt.pitch = 1.0;
      utt.volume = 1.0;
      if (browserVoiceRef.current) utt.voice = browserVoiceRef.current;
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        setSpeaking(false);
        resolve();
      };
      utt.onstart = () => setSpeaking(true);
      utt.onend = finish;
      utt.onerror = finish;
      window.speechSynthesis.speak(utt);

      // Safety net — speechSynthesis sometimes never fires onend (Chrome bug
      // when utterances are long). Estimate duration: ~150 ms per word + a
      // 1s pad. If that's exceeded, force-resolve.
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const estMs = wordCount * 220 + 1500;
      setTimeout(finish, Math.min(estMs, 60_000));
    });
  }, []);

  const speakElevenLabs = useCallback(
    async (text: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          // 501 = not configured; any other = transient — fall back
          return { ok: false, reason: `tts api ${res.status}` };
        }
        const blob = await res.blob();
        if (blob.size === 0) {
          return { ok: false, reason: "tts api returned empty body" };
        }
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.preload = "auto";
        audioRef.current = audio;
        return new Promise<{ ok: true } | { ok: false; reason: string }>(
          (resolve) => {
            let resolved = false;
            const cleanup = () => {
              URL.revokeObjectURL(url);
              audioRef.current = null;
            };
            const done = (result: { ok: true } | { ok: false; reason: string }) => {
              if (resolved) return;
              resolved = true;
              setSpeaking(false);
              cleanup();
              resolve(result);
            };
            audio.onplay = () => setSpeaking(true);
            audio.onended = () => done({ ok: true });
            audio.onerror = () => done({ ok: false, reason: "audio element error" });
            audio.play().catch((err) => {
              done({
                ok: false,
                reason: `audio.play rejected: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              });
            });
            // Hard timeout — if the audio never plays/ends after 60s, bail
            setTimeout(() => done({ ok: false, reason: "tts timeout" }), 60_000);
          }
        );
      } catch (err) {
        return {
          ok: false,
          reason: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
    []
  );

  const speak = useCallback(
    async (text: string): Promise<void> => {
      cancel();
      const trimmed = text.trim();
      if (!trimmed) return;

      // If we already learned ElevenLabs isn't configured, skip straight to browser
      if (elevenLabsAvailableRef.current === false) {
        onSource?.("browser", "elevenlabs known unavailable");
        return speakBrowser(trimmed);
      }

      const elResult = await speakElevenLabs(trimmed);
      if (elResult.ok) {
        elevenLabsAvailableRef.current = true;
        onSource?.("elevenlabs");
        return;
      }
      // ElevenLabs failed — record reason and fall through to browser TTS
      console.warn("[tts] ElevenLabs failed:", elResult.reason, "— falling back to browser");
      if (elResult.reason.includes("501")) {
        elevenLabsAvailableRef.current = false;
      }
      onSource?.("browser", elResult.reason);
      return speakBrowser(trimmed);
    },
    [cancel, speakBrowser, speakElevenLabs, onSource]
  );

  return { speak, cancel, prime, speaking };
}
