import { queryHaiku } from "@/lib/ai/claude";

// Compress an email into a single calm sentence the app reads aloud.
// Not "247 unread" energy — "Prof Smith asked you to send the draft Wednesday".

export async function summarizeForVoice(
  emailContent: string,
  meta: { from: string; subject: string }
): Promise<string> {
  const system = [
    "You compress emails into a single short sentence to be read aloud to a busy person.",
    "Style:",
    "- Calm, plain English. No headers, no bullets, no markdown.",
    "- Lead with WHO it's from (just first name or short identifier) and WHAT they want.",
    '- Examples: "Prof Smith wants the updated draft by Wednesday." / "Mom is checking in about Sunday." / "The bank flagged a $47 charge."',
    "- Never include the literal word \"email\" — the listener already knows.",
    "- One sentence. Under 25 words.",
    "- Do not editorialize or add advice.",
  ].join("\n");

  const user = [
    `FROM: ${meta.from}`,
    `SUBJECT: ${meta.subject}`,
    "",
    emailContent.slice(0, 2000),
  ].join("\n");

  const out = await queryHaiku(system, user, 200);
  return out.replace(/^["']|["']$/g, "").trim();
}
