"use client";

import { useEffect, useRef, useState } from "react";

// Live waveform reading mic input. Active only when `listening` is true.
// We DO NOT keep a stream open between sessions — we open on listen, close on stop.

const BAR_COUNT = 14;

export function WaveVisualizer({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(BAR_COUNT).fill(0.15)
  );
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!active) {
      cleanup();
      setLevels(new Array(BAR_COUNT).fill(0.15));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const Ctx =
          (window as unknown as { AudioContext?: typeof AudioContext })
            .AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        sourceRef.current = source;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(buf);
          // Sample BAR_COUNT bins evenly across the lower spectrum (voice band)
          const next: number[] = [];
          const stride = Math.max(1, Math.floor(buf.length / 3 / BAR_COUNT));
          for (let i = 0; i < BAR_COUNT; i++) {
            let sum = 0;
            for (let k = 0; k < stride; k++) sum += buf[i * stride + k] || 0;
            const avg = sum / stride / 255;
            // Curve to make low signals more visible
            next.push(Math.max(0.15, Math.min(1, Math.pow(avg, 0.7) * 1.4)));
          }
          setLevels(next);
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // mic denied — still show idle wave bars
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function cleanup() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch {}
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch {}
      analyserRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  }

  return (
    <div
      ref={canvasRef}
      className={`wave-container ${active ? "active" : ""}`}
      aria-hidden
    >
      {levels.map((level, i) => (
        <div
          key={i}
          className="wave-bar"
          style={{ height: `${4 + level * 20}px` }}
        />
      ))}
    </div>
  );
}
