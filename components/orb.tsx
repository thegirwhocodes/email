"use client";

type Mode = "idle" | "speaking" | "listening" | "thinking" | "done";

const sizes = {
  small: "w-32 h-32",
  medium: "w-44 h-44",
  large: "w-60 h-60",
};

export function Orb({
  mode,
  size = "large",
}: {
  mode: Mode;
  size?: keyof typeof sizes;
}) {
  return (
    <div
      className={`orb-stack ${sizes[size]} orb-state-${mode}`}
      aria-hidden
    >
      <div className="orb-glow" />
      <div className="orb-ring" />
      <div className={`orb-core absolute inset-0`} />
    </div>
  );
}
