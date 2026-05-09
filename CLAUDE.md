# voice-email — Part of Cortex

## ⚠️ COMPACTION RULE (read this first)

**If context compacted mid-conversation: STOP. Read your ENTIRE session transcript from `.claude-sessions/` BEFORE doing anything else.** Find your session ID in the parent project's `.claude-sessions/INDEX.txt` (most recent entry), then read that ENTIRE `.txt` file — every line, start to finish, in chunks if needed. Do NOT just read the tail end. Do NOT assume you remember what happened earlier. Read the FULL file.

## This is a subfolder of Cortex

Memory, sessions, and research for this project live in the parent:
- **Memory:** `~/.claude/projects/-Users-naomiivie-cortex/memory/`
- **Sessions:** `/Users/naomiivie/cortex/.claude-sessions/`
- **Research:** `~/.claude/projects/-Users-naomiivie-cortex/agent-research/`

Follow the parent project's CLAUDE.md at `/Users/naomiivie/cortex/CLAUDE.md` for full context recovery instructions.

## What this app is

A standalone Next.js app — separate from `cortex-web` — that does Naomi's "voice email" vision: jet black, one email at a time, hands-free triage. The orb in the center reads a one-line summary of each email and you reply by voice.

- Runs on **port 3001** (`npm run dev`). cortex-web runs on 3000.
- Reuses cortex-web's Supabase rows, Clerk instance, Anthropic key, and Gmail OAuth tokens. **No new credentials.**
- Reads emails from `cortex_documents` (cortex-web's existing sync populates this).
- Sends via Gmail API using the access token in `cortex_integrations` for the same user.

## Stack decisions

- **STT/TTS:** Web Speech API (browser-native, free). Best on Chrome on macOS — picks up Apple's neural voices.
- **LLM:** Claude Haiku for summary, intent classification, drafting. Same Anthropic key as cortex-web.
- **Auth:** Clerk, same publishable + secret keys as cortex-web. Sign in once per app (cookies are per-port).
- **No DB schema changes** — strictly read/write existing cortex tables.

## Voice loop

1. Fetch queue from `/api/queue` (filters out PROMOTIONS/SOCIAL/FORUMS/UPDATES, drops already-replied threads)
2. Summarize one email via `/api/summarize` → speak it
3. User push-to-talks → `/api/intent` classifies into reply / skip / archive / repeat / send
4. If reply → `/api/draft` (uses past sent emails to that recipient + profile_text) → speak draft
5. User push-to-talks → `/api/intent` (after_draft stage) → send / redraft / skip / repeat
6. Send via `/api/send` (or archive via `/api/archive`)

## Don't touch cortex-web

Naomi explicitly said leave cortex-web alone. If voice-email needs something cortex-web has, copy/adapt the file rather than importing across project boundaries.
