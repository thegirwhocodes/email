import { auth } from "@clerk/nextjs/server";
import { SignInButton } from "@clerk/nextjs";
import DigestClient from "./digest-client";

export default async function DigestPage() {
  const { userId } = await auth();

  if (!userId) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <h1 className="text-2xl font-semibold text-text">Daily Digest</h1>
        <div className="mt-8">
          <SignInButton mode="modal">
            <button className="px-6 py-3 rounded-full bg-text text-bg font-medium hover:bg-text-secondary transition-colors">
              Sign in
            </button>
          </SignInButton>
        </div>
      </main>
    );
  }

  return <DigestClient />;
}
