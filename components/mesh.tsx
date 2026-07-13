"use client";

import { useEffect, useRef } from "react";

// WebGL fragment-shader mesh — Apple Intelligence-style breathing field.
// Cool palette (deep purple → violet → cool white). State drives uniforms;
// optional `analyser` lets the mesh's amplitude track the playing TTS audio
// for real "lip-sync".

type Mode = "idle" | "speaking" | "listening" | "thinking" | "done";

const VERTEX_SHADER = /* glsl */ `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

// Domain-warped flow noise + state-driven color mix.
// State numeric encoding:
//   0 = idle
//   1 = listening
//   2 = thinking
//   3 = speaking
//   4 = done
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 v_uv;

  uniform float u_time;
  uniform float u_state;        // 0..4 (eased between current/target)
  uniform float u_amplitude;    // 0..1 — mic or TTS amplitude
  uniform vec2  u_resolution;

  // 2D simplex noise — Ashima/IQ-style. Compact.
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
              + i.x + vec3(0.0, i1.x, 1.0 ));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  // Cool palette swatches (linear-space-ish)
  const vec3 COL_VOID    = vec3(0.020, 0.020, 0.030);   // deepest backdrop
  const vec3 COL_DEEP    = vec3(0.090, 0.060, 0.180);   // indigo
  const vec3 COL_VIOLET  = vec3(0.420, 0.310, 0.780);   // violet body
  const vec3 COL_LILAC   = vec3(0.700, 0.620, 0.980);   // pale lilac highlight
  const vec3 COL_CREAM   = vec3(0.960, 0.940, 0.910);   // warm cream highlight (used sparingly when speaking)
  const vec3 COL_GREEN   = vec3(0.520, 0.910, 0.700);   // green-shift for done

  void main() {
    // Center-square UV around (0,0)
    vec2 uv = (v_uv - 0.5) * 2.0;
    float dist = length(uv);

    // Breathing scale by state intensity & amplitude
    float intensity =
        u_state < 0.5 ? 0.20                         // idle — calm
      : u_state < 1.5 ? 0.50 + u_amplitude * 0.40    // listening — responsive
      : u_state < 2.5 ? 0.45                         // thinking — internal motion
      : u_state < 3.5 ? 0.65 + u_amplitude * 0.45    // speaking — tracks TTS
      :                  0.18;                        // done — quietest

    float speed =
        u_state < 0.5 ? 0.10
      : u_state < 1.5 ? 0.45
      : u_state < 2.5 ? 0.55
      : u_state < 3.5 ? 0.50
      :                  0.06;

    // Domain-warp the UV with two layers of simplex noise
    float t = u_time * speed;
    vec2 q;
    q.x = snoise(uv * 1.4 + vec2(0.0, t));
    q.y = snoise(uv * 1.4 + vec2(5.2, t * 1.1));

    vec2 r;
    r.x = snoise(uv * 1.8 + 1.7 * q + vec2(1.7, 9.2 + 0.15 * t));
    r.y = snoise(uv * 1.8 + 1.7 * q + vec2(8.3, 2.8 + 0.126 * t));

    float n = snoise(uv * 1.3 + r);
    float field = n * 0.5 + 0.5;

    // Soft circular mask — the mesh lives mostly inside a ~unit disk
    float mask = smoothstep(1.05, 0.15, dist);

    // Color mix layered: void → deep → violet → lilac, with optional cream
    // highlight for "speaking" and a green tint for "done"
    vec3 col = mix(COL_VOID, COL_DEEP, smoothstep(0.0, 0.45, field));
    col = mix(col, COL_VIOLET, smoothstep(0.30, 0.75, field));
    col = mix(col, COL_LILAC, smoothstep(0.65, 0.95, field) * intensity);

    // Speaking: bring in cream highlight at the brightest peaks of the field
    float speakingMix = smoothstep(2.5, 3.5, u_state);
    col = mix(col, mix(col, COL_CREAM, smoothstep(0.78, 0.98, field) * 0.7),
              speakingMix);

    // Done: shift into a calm green
    float doneMix = smoothstep(3.5, 4.5, u_state);
    col = mix(col, mix(col * 0.7, COL_GREEN, 0.35), doneMix);

    // Specular-ish highlight from a fixed top-left "light" source
    vec2 light = vec2(-0.45, 0.40);
    float spec = pow(max(0.0, 1.0 - length(uv - light) * 1.6), 3.0);
    col += spec * 0.10 * intensity;

    // Inner soft glow that boosts when listening or speaking
    float glow = exp(-dist * 1.6) * (0.10 + intensity * 0.60);
    col += vec3(0.45, 0.36, 0.85) * glow * 0.20;

    // Outer shadow falloff
    col *= mask;

    // Slight gamma curve for warmth
    col = pow(col, vec3(0.92));

    gl_FragColor = vec4(col, mask);
  }
`;

interface MeshProps {
  mode: Mode;
  /** Pass an AnalyserNode to drive amplitude from its current frequency data. */
  analyser?: AnalyserNode | null;
  /** Pixel size of the canvas (square). */
  size?: number;
  className?: string;
}

const STATE_INDEX: Record<Mode, number> = {
  idle: 0,
  listening: 1,
  thinking: 2,
  speaking: 3,
  done: 4,
};

export function Mesh({
  mode,
  analyser = null,
  size = 320,
  className = "",
}: MeshProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const gl = canvas.getContext("webgl", { premultipliedAlpha: true });
    if (!gl) return;

    function compile(type: number, src: string): WebGLShader | null {
      if (!gl) return null;
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error("Shader compile error:", gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
      }
      return s;
    }

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const positionLoc = gl.getAttribLocation(program, "a_position");
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime = gl.getUniformLocation(program, "u_time");
    const uState = gl.getUniformLocation(program, "u_state");
    const uAmp = gl.getUniformLocation(program, "u_amplitude");
    const uRes = gl.getUniformLocation(program, "u_resolution");

    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.viewport(0, 0, canvas.width, canvas.height);

    let raf = 0;
    const initialMode = (canvas.dataset.mode || "idle") as Mode;
    let currentState = STATE_INDEX[initialMode];
    let targetState = currentState;
    let smoothedAmp = 0;
    const start = performance.now();
    let analyserBuf: Uint8Array<ArrayBuffer> | null = analyser
      ? new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
      : null;

    function readAmp(): number {
      if (!analyser || !analyserBuf) return 0;
      analyser.getByteFrequencyData(analyserBuf);
      let sum = 0;
      // Voice-band emphasis: lower bins get more weight
      for (let i = 0; i < analyserBuf.length / 3; i++) {
        sum += analyserBuf[i];
      }
      const avg = sum / (analyserBuf.length / 3) / 255;
      return Math.min(1, Math.pow(avg, 0.7) * 1.4);
    }

    function frame() {
      if (!gl) return;
      // Ease state value smoothly (0.08 lerp per frame)
      currentState += (targetState - currentState) * 0.08;
      const rawAmp = readAmp();
      smoothedAmp += (rawAmp - smoothedAmp) * 0.18;

      gl.uniform1f(uTime, (performance.now() - start) * 0.001);
      gl.uniform1f(uState, currentState);
      gl.uniform1f(uAmp, smoothedAmp);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    }
    frame();

    // External signal: when mode changes via prop, retarget
    const observer = new MutationObserver(() => {
      const m = (canvas.dataset.mode || "idle") as Mode;
      targetState = STATE_INDEX[m] ?? 0;
    });
    observer.observe(canvas, { attributes: true, attributeFilter: ["data-mode"] });

    // If analyser is added later, refresh the buffer
    const refreshAnalyser = () => {
      analyserBuf = analyser
        ? new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
        : null;
    };
    refreshAnalyser();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [size, analyser]);

  // Mirror the prop into a data attribute so the running RAF picks up changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.dataset.mode = mode;
  }, [mode]);

  return (
    <div className={`mesh-stack ${className}`} style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        data-mode={mode}
        className="block"
        style={{ width: size, height: size }}
        aria-hidden
      />
    </div>
  );
}
