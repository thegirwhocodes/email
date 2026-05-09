"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";

// Cmd-K command palette. Linear pattern. Lightweight: no third-party deps,
// fuzzy match on label, keyboard nav, focus-trapped overlay.

interface Command {
  id: string;
  label: string;
  hint?: string;
  group: "session" | "navigate" | "account" | "debug";
  action: () => void | Promise<void>;
}

interface PaletteProps {
  /** Optional: triggered when the user picks "Start session" */
  onStartSession?: () => void;
}

export function CommandPalette({ onStartSession }: PaletteProps) {
  const router = useRouter();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Toggle on Cmd-K / Ctrl-K, close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isToggle = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isToggle) {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActive(0);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const commands: Command[] = useMemo(() => {
    const list: Command[] = [
      {
        id: "start",
        label: "Start session",
        hint: "begin",
        group: "session",
        action: () => {
          if (onStartSession) onStartSession();
          else router.push("/");
        },
      },
      {
        id: "digest",
        label: "Open daily digest",
        hint: "/digest",
        group: "navigate",
        action: () => router.push("/digest"),
      },
      {
        id: "home",
        label: "Back to inbox",
        hint: "/",
        group: "navigate",
        action: () => router.push("/"),
      },
      {
        id: "debug-on",
        label: "Show voice diagnostics",
        hint: "?debug=1",
        group: "debug",
        action: () => {
          const url = new URL(window.location.href);
          url.searchParams.set("debug", "1");
          window.location.href = url.toString();
        },
      },
      {
        id: "debug-off",
        label: "Hide voice diagnostics",
        hint: "remove ?debug",
        group: "debug",
        action: () => {
          const url = new URL(window.location.href);
          url.searchParams.delete("debug");
          window.location.href = url.toString();
        },
      },
      {
        id: "signout",
        label: "Sign out",
        hint: "log out of voice email",
        group: "account",
        action: () => {
          void signOut(() => router.push("/"));
        },
      },
    ];
    return list;
  }, [router, signOut, onStartSession]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint || ""}`.toLowerCase();
      // Simple subsequence fuzzy: every char in q appears in order in hay
      let i = 0;
      for (const ch of q) {
        const next = hay.indexOf(ch, i);
        if (next === -1) return false;
        i = next + 1;
      }
      return true;
    });
  }, [commands, query]);

  // Reset active when filter changes
  useEffect(() => {
    setActive(0);
  }, [filtered.length, query]);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[active];
      if (cmd) {
        setOpen(false);
        void cmd.action();
      }
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh] px-4"
      onClick={() => setOpen(false)}
    >
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-bg-deep/70 backdrop-blur-sm"
        style={{
          animation: "fade-in 200ms var(--ease-decel) both",
        }}
      />

      {/* Panel */}
      <div
        className="relative w-full max-w-[560px] rounded-2xl bg-bg-surface border border-border-strong shadow-2xl overflow-hidden"
        style={{
          animation: "slide-up 250ms var(--ease-decel) both",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onListKey}
      >
        {/* Search */}
        <div className="px-5 py-4 border-b border-border-subtle flex items-center gap-3">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-text-muted shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="what would you like to do?"
            className="flex-1 bg-transparent outline-none text-text placeholder-text-muted text-base"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="text-[10px] font-mono text-text-muted px-2 py-1 rounded bg-bg-elevated border border-border-subtle">
            esc
          </kbd>
        </div>

        {/* Results */}
        <ul className="max-h-[50vh] overflow-y-auto py-2">
          {filtered.length === 0 && (
            <li className="px-5 py-6 text-sm text-text-muted text-center">
              nothing matches that.
            </li>
          )}
          {filtered.map((cmd, i) => {
            const isActive = i === active;
            return (
              <li
                key={cmd.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  setOpen(false);
                  void cmd.action();
                }}
                className={`px-5 py-3 flex items-center justify-between gap-4 cursor-pointer transition-colors ${
                  isActive
                    ? "bg-bg-elevated text-text"
                    : "text-text-secondary"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`w-1 h-4 rounded-full transition-colors ${
                      isActive ? "bg-accent" : "bg-transparent"
                    }`}
                  />
                  <span className="text-[15px] truncate">{cmd.label}</span>
                </div>
                {cmd.hint && (
                  <span className="text-xs font-mono text-text-faint shrink-0 truncate max-w-[200px]">
                    {cmd.hint}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <div className="px-5 py-3 border-t border-border-subtle flex items-center justify-between text-[10px] text-text-faint">
          <span>↑↓ navigate · ↵ select · esc dismiss</span>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
}
