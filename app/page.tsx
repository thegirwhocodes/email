import { auth } from "@clerk/nextjs/server";
import { SignInButton } from "@clerk/nextjs";
import { Mesh } from "@/components/mesh";
import VoiceEmailClient from "./voice-email-client";

export default async function HomePage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <main className="min-h-screen flex flex-col">
        <header className="flex items-center justify-between px-8 py-6 fade-in">
          <span className="font-serif italic text-base text-text">
            voice email
          </span>
          <span className="eyebrow text-text-faint">cortex</span>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-16">
          <div className="fade-in delay-100">
            <Mesh mode="idle" size={320} />
          </div>

          <h1 className="mt-16 text-display-serif text-text-balance text-center max-w-xl fade-in delay-300">
            One email at a time.
            <br />
            <span className="text-text-secondary">By voice.</span>
          </h1>

          <div className="mt-12 fade-in delay-500">
            <SignInButton mode="modal">
              <button className="btn-primary">begin</button>
            </SignInButton>
          </div>
        </div>

        <footer className="px-8 py-6 text-center fade-in delay-500">
          <span className="eyebrow text-text-faint">part of cortex</span>
        </footer>
      </main>
    );
  }

  return <VoiceEmailClient />;
}
