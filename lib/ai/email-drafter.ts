import { supabase } from "@/lib/supabase/client";
import { queryHaiku } from "@/lib/ai/claude";

// Drafts an email reply in the user's voice using:
//  - their stored profile_text (cortex_profiles)
//  - up to 5 past emails they've sent to the same recipient (few-shot)
//
// No embeddings/RAG — voice flow needs to be fast, and recipient-specific past
// emails alone produce strong tone matching.

interface DraftCtx {
  from: string;
  subject: string;
  threadId?: string;
  // Optional user direction from voice ("agree, say I'll have it Wednesday")
  intent?: string;
}

export async function draftEmailReply(
  userId: string,
  emailContent: string,
  ctx: DraftCtx
): Promise<string> {
  const { data: profile } = await supabase
    .from("cortex_profiles")
    .select("profile_text")
    .eq("user_id", userId)
    .single();

  const senderEmail = extractEmail(ctx.from);

  const { data: pastSent } = await supabase
    .from("cortex_documents")
    .select("content, metadata")
    .eq("user_id", userId)
    .eq("content_type", "email_sent")
    .order("source_created_at", { ascending: false })
    .limit(50);

  const relevantPast = (pastSent || []).filter((doc) => {
    const to = (doc.metadata as Record<string, string>)?.to || "";
    return to.toLowerCase().includes(senderEmail.toLowerCase());
  });

  const systemPrompt = buildDraftingPrompt(profile?.profile_text, relevantPast);

  const userPrompt = [
    "Draft a reply to this email.",
    "The input may include both the latest email and recent thread context. Use the thread context to stay consistent, but reply to the latest message.",
    "",
    `FROM: ${ctx.from}`,
    `SUBJECT: ${ctx.subject}`,
    "",
    emailContent,
    "",
    ctx.intent
      ? `The user told you what to say (in their words): "${ctx.intent}". Honor that intent and draft the reply accordingly.`
      : "Draft what the user would naturally reply.",
    "",
    "Output ONLY the email body — no subject line, no metadata, no quoted reply, no signature unless they sign their emails. Match their voice exactly.",
  ].join("\n");

  return queryHaiku(systemPrompt, userPrompt, 1024);
}

function buildDraftingPrompt(
  profileText: string | undefined,
  pastEmails: Array<{ content: string }>
): string {
  let prompt =
    "You are drafting an email reply for a specific user. Write EXACTLY in their voice — their tone, their style, their mannerisms. Not generic, not formal unless they are formal. Match them precisely.";

  if (profileText) {
    prompt += `\n\n## WHO THIS USER IS\n${profileText}`;
  }

  if (pastEmails.length > 0) {
    prompt += `\n\n## EXAMPLES OF HOW THEY WRITE EMAILS (to this same recipient)\n`;
    for (const email of pastEmails.slice(0, 5)) {
      prompt += `---\n${email.content.slice(0, 800)}\n`;
    }
  }

  prompt +=
    '\n\nIMPORTANT: Match their exact tone. If they use "Hey" not "Dear". If they sign off "Best," not "Kind regards,". If they\'re casual, be casual. If they\'re brief, be brief. Do NOT add formality they don\'t use.';

  return prompt;
}

function extractEmail(fromHeader: string): string {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader;
}
