# Cortex · voice email

Hands-free email triage. One email at a time. By voice.

→ Live: https://voice-email-app.vercel.app

## What it does

Connect Gmail. Tap the orb. Cortex reads you the top of your inbox one message at a time and you tell it what to do — archive, draft a reply, snooze, delete — all by voice. Drafts come back in your voice (per-user LoRA, see [`thegirwhocodes/spheres-app`](https://github.com/thegirwhocodes/spheres-app) for the Mac SwiftUI predecessor).

## How it works

```
Mic → Web Speech API → Claude Haiku intent classifier
  → agentic loop with tool calls (archive / draft / send / snooze)
  → Gmail API → TTS reply spoken back
```

Companion to the [Cortex dashboard](https://cortex-web-one.vercel.app). Both share Supabase + Clerk + Anthropic.

## Stack
Next.js 16 · Supabase · Clerk · Anthropic Claude · Web Speech API · Gmail OAuth

## Try it
Sign in with Gmail at [voice-email-app.vercel.app](https://voice-email-app.vercel.app) and tap the orb.
