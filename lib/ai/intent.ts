import { queryHaiku } from "@/lib/ai/claude";

// Classify what the user said in response to hearing an email summary.
// We need a discrete action so the UI knows what to do next.

export type Intent =
  | { kind: "reply"; direction: string }
  | { kind: "skip" }
  | { kind: "archive" }
  | { kind: "send" }
  | { kind: "redraft"; direction: string }
  | { kind: "repeat" }
  | { kind: "unclear" };

export async function classifyIntent(
  userSpeech: string,
  stage: "after_summary" | "after_draft"
): Promise<Intent> {
  const stageGuide =
    stage === "after_summary"
      ? "The user just heard a one-sentence summary of an email. They are deciding what to do."
      : "The user just heard a draft reply read aloud. They are deciding whether to send, fix it, or move on.";

  const system = [
    "You classify a user's spoken response into one of these intents:",
    '- reply: they want to respond. Capture their direction in "direction".',
    "- skip: move past this email without acting.",
    "- archive: get rid of this email.",
    "- send: send the current draft as-is.",
    '- redraft: keep the same email but rewrite the draft. Capture changes in "direction".',
    "- repeat: they want it read again.",
    "- unclear: nothing matched.",
    "",
    stageGuide,
    "",
    "Rules:",
    "- Only return intents that make sense for the stage. After a summary, 'send' is unusual unless they explicitly say 'just send a quick yes'.",
    "- For reply/redraft, populate 'direction' with the user's intent in their own words (not paraphrased).",
    "- Output STRICT JSON only, no prose, no markdown fences.",
    '- Schema: {"kind": "reply"|"skip"|"archive"|"send"|"redraft"|"repeat"|"unclear", "direction"?: string}',
  ].join("\n");

  const raw = await queryHaiku(system, userSpeech, 200);

  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      typeof parsed.kind === "string" &&
      [
        "reply",
        "skip",
        "archive",
        "send",
        "redraft",
        "repeat",
        "unclear",
      ].includes(parsed.kind)
    ) {
      if (parsed.kind === "reply" || parsed.kind === "redraft") {
        return {
          kind: parsed.kind,
          direction:
            typeof parsed.direction === "string" && parsed.direction.length > 0
              ? parsed.direction
              : userSpeech,
        };
      }
      return { kind: parsed.kind };
    }
  } catch {
    // fall through
  }

  return { kind: "unclear" };
}
