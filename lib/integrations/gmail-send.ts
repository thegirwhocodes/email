// Send via Gmail API using an access token already stored (and just decrypted)
// from cortex_integrations. We reuse the OAuth flow done in cortex-web — this
// app never asks for Gmail permission of its own.

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface SendArgs {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}

export async function sendEmail(
  accessToken: string,
  args: SendArgs
): Promise<{ messageId: string }> {
  const headers = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    args.body,
  ].join("\r\n");

  const raw = Buffer.from(headers).toString("base64url");

  const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.threadId ? { raw, threadId: args.threadId } : { raw }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Gmail send failed: ${error}`);
  }

  const data = await res.json();
  return { messageId: data.id };
}

// Archive a message — Gmail "archive" = remove INBOX label.
export async function archiveMessage(
  accessToken: string,
  messageId: string
): Promise<void> {
  const res = await fetch(
    `${GMAIL_API}/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
    }
  );
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Gmail archive failed: ${error}`);
  }
}

// Refresh an expired access token using the stored refresh token.
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: Date;
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) throw new Error("Token refresh failed");
  const data = await res.json();
  return {
    accessToken: data.access_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}
