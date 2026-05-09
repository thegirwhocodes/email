import { supabase } from "@/lib/supabase/client";
import { decrypt, encrypt } from "@/lib/encryption/tokens";
import { refreshAccessToken } from "@/lib/integrations/gmail-send";

// Centralizes the "give me a fresh Gmail access token for this user" flow so
// every route doesn't repeat the same decrypt + refresh dance. Picks the most
// recent active gmail integration; future: pick by inbox the email landed in.

export async function getFreshGmailToken(userId: string): Promise<string> {
  const { data: integration } = await supabase
    .from("cortex_integrations")
    .select(
      "id, access_token_encrypted, refresh_token_encrypted, token_expires_at"
    )
    .eq("user_id", userId)
    .eq("provider", "gmail")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!integration) {
    throw new Error("Gmail not connected. Connect it in cortex-web first.");
  }

  let accessToken = decrypt(integration.access_token_encrypted);

  const expiresAt = integration.token_expires_at
    ? new Date(integration.token_expires_at)
    : null;

  if (
    expiresAt &&
    expiresAt.getTime() - Date.now() < 60_000 &&
    integration.refresh_token_encrypted
  ) {
    const refreshToken = decrypt(integration.refresh_token_encrypted);
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.accessToken;

    await supabase
      .from("cortex_integrations")
      .update({
        access_token_encrypted: encrypt(refreshed.accessToken),
        token_expires_at: refreshed.expiresAt.toISOString(),
      })
      .eq("id", integration.id);
  }

  return accessToken;
}
