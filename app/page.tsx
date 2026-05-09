import { auth } from "@clerk/nextjs/server";
import { SignInButton } from "@clerk/nextjs";
import { Orb } from "@/components/orb";
import VoiceEmailClient from "./voice-email-client";

export default async function HomePage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <main className="min-h-screen flex flex-col">
        <header className="flex items-center justify-between px-6 py-5">
          <span className="text-sm text-text tracking-[0.18em] uppercase font-medium">
            Voice<span className="text-text-muted"> · </span>Email
          </span>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-16 fade-in">
          <Orb mode="idle" size="large" />

          <h1 className="mt-14 text-4xl sm:text-5xl font-semibold tracking-tight text-text text-balance text-center max-w-xl leading-[1.05]">
            The smart, reliable
            <br />
            email friend you wish
            <br />
            <span className="text-text-secondary">you had.</span>
          </h1>

          <p className="mt-6 text-text-secondary text-base text-balance text-center max-w-md leading-relaxed">
            Reads your inbox. Tells you what matters. Drafts replies in your voice. Quietly handles the noise.
          </p>

          <div className="mt-10">
            <SignInButton mode="modal">
              <button className="btn-primary">
                Sign in to start
              </button>
            </SignInButton>
          </div>

          <div className="mt-16 flex items-center gap-6 text-xs text-text-muted">
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-success/60" />
              ElevenLabs voice
            </span>
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-accent/60" />
              Sonnet 4.6 agent
            </span>
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-text/40" />
              Approval before send
            </span>
          </div>
        </div>

        <footer className="px-6 py-5 text-center text-xs text-text-muted">
          part of cortex
        </footer>
      </main>
    );
  }

  return <VoiceEmailClient />;
}
