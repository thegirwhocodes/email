// One-shot Gmail sync — pull everything since the newest email in DB.
// Mirrors what cortex-web/lib/integrations/gmail.ts + ingestion/pipeline.ts do.

import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const env = readFileSync("/Users/naomiivie/cortex/voice-email/.env.local", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function decrypt(encrypted) {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");
  const [ivHex, tagHex, ciphertext] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const u = await sb.from("cortex_users").select("id, email").limit(1).single();
const userId = u.data.id;
console.log("User:", u.data.email, userId);

// Get the gmail integration (RLS bypass via service role)
const { data: integration, error: intErr } = await sb
  .from("cortex_integrations")
  .select("id, access_token_encrypted, refresh_token_encrypted, token_expires_at, total_items_synced, last_sync_at")
  .eq("user_id", userId)
  .eq("provider", "gmail")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (intErr) { console.error("INT ERROR:", intErr); process.exit(1); }
if (!integration) { console.log("No gmail integration."); process.exit(0); }
console.log("Gmail integration last sync:", integration.last_sync_at);

// Refresh access token if needed
let accessToken = decrypt(integration.access_token_encrypted);
const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at) : null;
if (expiresAt && expiresAt.getTime() - Date.now() < 60_000 && integration.refresh_token_encrypted) {
  console.log("Refreshing access token...");
  const refreshToken = decrypt(integration.refresh_token_encrypted);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) {
    console.error("Refresh failed:", await r.text());
    console.error("\n>>> The refresh token has likely expired. You need to RECONNECT Gmail in cortex-web /integrations.");
    process.exit(1);
  }
  const d = await r.json();
  accessToken = d.access_token;
  console.log("Token refreshed.");
}

// Find newest email date in DB so we only fetch since then
const { data: newest } = await sb
  .from("cortex_documents")
  .select("source_created_at")
  .eq("user_id", userId)
  .eq("content_type", "email_received")
  .order("source_created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
const sinceTs = newest?.source_created_at
  ? Math.floor(new Date(newest.source_created_at).getTime() / 1000)
  : Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
console.log("Fetching messages since:", new Date(sinceTs * 1000).toISOString());

const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const auth = { Authorization: `Bearer ${accessToken}` };

let pageToken = undefined;
let totalIngested = 0;
let totalFetched = 0;

function extractBody(payload) {
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString("utf8");
  const parts = payload.parts || [];
  for (const p of parts) if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const p of parts) if (p.mimeType === "text/html" && p.body?.data) {
    const html = Buffer.from(p.body.data, "base64url").toString("utf8");
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  for (const p of parts) { const nested = extractBody(p); if (nested) return nested; }
  return "";
}

while (true) {
  const params = new URLSearchParams({ maxResults: "100", q: `after:${sinceTs}` });
  if (pageToken) params.set("pageToken", pageToken);
  const list = await fetch(`${GMAIL}/users/me/messages?${params}`, { headers: auth }).then(r => r.json());
  if (!list.messages?.length) break;
  totalFetched += list.messages.length;
  console.log(`Fetched ${list.messages.length} message ids (total: ${totalFetched})`);

  // Fetch details in batches of 10
  for (let i = 0; i < list.messages.length; i += 10) {
    const batch = list.messages.slice(i, i + 10);
    const details = await Promise.all(batch.map(m =>
      fetch(`${GMAIL}/users/me/messages/${m.id}?format=full`, { headers: auth }).then(r => r.ok ? r.json() : null)
    ));
    for (const msg of details) {
      if (!msg) continue;
      const headers = msg.payload?.headers || [];
      const getH = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || "";
      const from = getH("From"), to = getH("To"), subject = getH("Subject"), date = getH("Date");
      const body = extractBody(msg.payload);
      if (!body || body.length < 10) continue;
      const labels = msg.labelIds || [];
      const isSent = labels.includes("SENT");
      const content = `Subject: ${subject}\nFrom: ${from}\nTo: ${to}\n\n${body}`;
      const contentHash = createHash("sha256").update(content).digest("hex");

      // Upsert as chunk_index=0 (we skip the chunking pipeline — single chunk per email)
      const { error: insErr } = await sb.from("cortex_documents").upsert({
        user_id: userId,
        content,
        content_hash: contentHash,
        source: "gmail",
        content_type: isSent ? "email_sent" : "email_received",
        metadata: { from, to, subject, date, threadId: msg.threadId, labels, messageId: msg.id },
        source_id: msg.id,
        source_created_at: date ? new Date(date).toISOString() : null,
        chunk_index: 0,
      }, { onConflict: "user_id,content_hash" });
      if (!insErr) totalIngested++;
    }
  }
  pageToken = list.nextPageToken;
  if (!pageToken) break;
  if (totalIngested > 2000) { console.log("Hit safety cap of 2000 ingested, stopping."); break; }
}

console.log(`\nDone. Fetched ${totalFetched} ids, ingested/upserted ${totalIngested}.`);

// Update the integration row's last_sync_at
await sb.from("cortex_integrations").update({
  last_sync_at: new Date().toISOString(),
  total_items_synced: (integration.total_items_synced || 0) + totalIngested,
}).eq("id", integration.id);

// Show the new newest email
const { data: now } = await sb
  .from("cortex_documents")
  .select("source_created_at, metadata")
  .eq("user_id", userId)
  .eq("content_type", "email_received")
  .order("source_created_at", { ascending: false })
  .limit(3);
console.log("\nNewest received emails after sync:");
for (const r of now || []) {
  const m = r.metadata || {};
  console.log(`  ${r.source_created_at?.slice(0,10)}  ${(m.from || "").slice(0,50)}  |  ${(m.subject || "").slice(0,50)}`);
}
