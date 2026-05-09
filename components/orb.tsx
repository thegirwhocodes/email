"use client";

type Mode = "idle" | "speaking" | "listening" | "thinking" | "done";

const sizes = {
  small: "w-32 h-32",
  medium: "w-44 h-44",
  large: "w-60 h-60",
  xl: "w-72 h-72",
};

// Pass-1 placeholder: layered radial-gradients that morph by state.
// Pass-2 will replace this with a WebGL fragment shader that lip-syncs to TTS.
export function Orb({
  mode,
  size = "large",
}: {
  mode: Mode;
  size?: keyof typeof sizes;
}) {
  return (
    <div className={`mesh-stack ${sizes[size]}`} aria-hidden>
      <div className={`mesh-fallback absolute inset-0 ${mode}`} />
    </div>
  );
}
