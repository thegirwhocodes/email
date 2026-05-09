import { auth, currentUser } from "@clerk/nextjs/server";
import { supabase } from "@/lib/supabase/client";

// Look up the cortex_users.id for the current Clerk session.
// Auto-creates the row if it doesn't exist (e.g. user signed up here first
// rather than in cortex-web). Same Clerk instance = same clerk_id = same row.
export async function getUserId(): Promise<string> {
  const { userId: clerkId } = await auth();
  if (!clerkId) throw new Error("Unauthorized");

  const { data: user } = await supabase
    .from("cortex_users")
    .select("id")
    .eq("clerk_id", clerkId)
    .single();

  if (user) return user.id;

  const clerkUser = await currentUser();
  const email =
    clerkUser?.emailAddresses?.[0]?.emailAddress || `${clerkId}@unknown.com`;
  const name =
    [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ") ||
    null;

  const { data: newUser, error } = await supabase
    .from("cortex_users")
    .upsert(
      {
        clerk_id: clerkId,
        email,
        name,
        avatar_url: clerkUser?.imageUrl || null,
      },
      { onConflict: "clerk_id" }
    )
    .select("id")
    .single();

  if (error || !newUser) throw new Error("Failed to create user");
  return newUser.id;
}
