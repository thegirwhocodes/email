"use client";

import { useEffect, useRef, useCallback, useState } from "react";

// Minimal Web Speech API wrapper. SpeechRecognition is Chrome/Edge/Safari only;
// SpeechSynthesis is universal. We feature-detect and surface a flag so the UI
// can degrade gracefully.

type RecognitionEvent = {
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
  resultIndex: number;
};

type RecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

interface VoiceState {
  supported: boolean;
  speaking: boolean;
  listening: boolean;
  partial: string;
  error: string | null;
}

interface VoiceApi extends VoiceState {
  speak: (text: string) => Promise<void>;
  cancelSpeech: () => void;
  startListening: () => Promise<string>;
  stopListening: () => void;
}

export function useVoice(): VoiceApi {
  const [state, setState] = useState<VoiceState>({
    supported: false,
    speaking: false,
    listening: false,
    partial: "",
    error: null,
  });

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const listenResolveRef = useRef<((transcript: string) => void) | null>(null);
  const listenRejectRef = useRef<((err: Error) => void) | null>(null);
  const finalTranscriptRef = useRef("");
  const preferredVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as {
      SpeechRecognition?: new () => RecognitionLike;
      webkitSpeechRecognition?: new () => RecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    const supported = !!Ctor && "speechSynthesis" in window;
    setState((s) => ({ ...s, supported }));

    if (supported && Ctor) {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (event) => {
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (finalText) finalTranscriptRef.current += finalText;
        setState((s) => ({
          ...s,
          partial: (finalTranscriptRef.current + interim).trim(),
        }));
      };
      rec.onend = () => {
        setState((s) => ({ ...s, listening: false }));
        const final = finalTranscriptRef.current.trim();
        finalTranscriptRef.current = "";
        if (listenResolveRef.current) {
          listenResolveRef.current(final);
          listenResolveRef.current = null;
          listenRejectRef.current = null;
        }
      };
      rec.onerror = (e) => {
        setState((s) => ({ ...s, listening: false, error: e.error }));
        if (listenRejectRef.current) {
          listenRejectRef.current(new Error(e.error));
          listenResolveRef.current = null;
          listenRejectRef.current = null;
        }
      };
      recognitionRef.current = rec;
    }

    if (supported && "speechSynthesis" in window) {
      const pickVoice = () => {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return;
        // Prefer Apple's high-quality on-device English voices, then any en-US
        const preferredNames = [
          "Samantha",
          "Ava",
          "Allison",
          "Susan",
          "Karen",
          "Moira",
          "Google US English",
        ];
        for (const name of preferredNames) {
          const v = voices.find((vv) => vv.name.includes(name));
          if (v) {
            preferredVoiceRef.current = v;
            return;
          }
        }
        preferredVoiceRef.current =
          voices.find((v) => v.lang.startsWith("en")) || voices[0];
      };
      pickVoice();
      window.speechSynthesis.onvoiceschanged = pickVoice;
    }
  }, []);

  const speak = useCallback((text: string): Promise<void> => {
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
      if (preferredVoiceRef.current) utt.voice = preferredVoiceRef.current;
      utt.onstart = () => setState((s) => ({ ...s, speaking: true }));
      utt.onend = () => {
        setState((s) => ({ ...s, speaking: false }));
        resolve();
      };
      utt.onerror = () => {
        setState((s) => ({ ...s, speaking: false }));
        resolve();
      };
      window.speechSynthesis.speak(utt);
    });
  }, []);

  const cancelSpeech = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setState((s) => ({ ...s, speaking: false }));
    }
  }, []);

  const startListening = useCallback((): Promise<string> => {
    return new Promise((resolve, reject) => {
      const rec = recognitionRef.current;
      if (!rec) {
        reject(new Error("SpeechRecognition not available"));
        return;
      }
      finalTranscriptRef.current = "";
      listenResolveRef.current = resolve;
      listenRejectRef.current = reject;
      try {
        setState((s) => ({ ...s, listening: true, partial: "", error: null }));
        rec.start();
      } catch (err) {
        listenResolveRef.current = null;
        listenRejectRef.current = null;
        setState((s) => ({ ...s, listening: false }));
        reject(err as Error);
      }
    });
  }, []);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  return {
    ...state,
    speak,
    cancelSpeech,
    startListening,
    stopListening,
  };
}
