import { auth } from "@clerk/nextjs/server";
import { SignInButton } from "@clerk/nextjs";
import VoiceEmailClient from "./voice-email-client";

export default async function HomePage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <main className="min-h-screen flex flex-col">
        <header className="flex items-center justify-between px-8 py-6 fade-in">
          <span className="font-serif italic text-base text-text">
            Sage Mail
          </span>
          <span className="eyebrow text-text-faint">voice email agent</span>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-16">
          <h1 className="text-display-serif text-text text-balance text-center max-w-xl fade-in delay-200">
            One email at a time.
            <br />
            <span className="text-text-secondary">By voice.</span>
          </h1>

          <p className="mt-8 text-text-secondary text-base text-balance text-center max-w-md fade-in delay-300">
            Reads your inbox. Tells you what matters. Drafts replies in your voice. Sends nothing without your approval.
          </p>

          <div className="mt-12 fade-in delay-500">
            <SignInButton mode="modal">
              <button className="btn-primary">begin</button>
            </SignInButton>
          </div>
        </div>

        <footer className="px-8 py-6 text-center fade-in delay-500">
          <span className="eyebrow text-text-faint">built on cortex</span>
        </footer>
      </main>
    );
  }

  return <VoiceEmailClient />;
}
