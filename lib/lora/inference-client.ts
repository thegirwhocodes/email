import { supabase } from "@/lib/supabase/client";

interface PersonalDraftResult {
  text: string;
  model: string;
  adapterVersion: number;
}

interface AdapterRow {
  id: string;
  base_model: string;
  adapter_version: number;
  adapter_file_path: string | null;
  inference_count: number | null;
}

export async function queryPersonalDraftModel(
  userId: string,
  userPrompt: string,
  systemPrompt: string
): Promise<PersonalDraftResult | null> {
  const { data: adapter, error } = await supabase
    .from("cortex_lora_adapters")
    .select("id, base_model, adapter_version, adapter_file_path, inference_count")
    .eq("user_id", userId)
    .eq("status", "deployed")
    .order("adapter_version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !adapter) return null;

  const row = adapter as AdapterRow;
  if (!row.adapter_file_path) return null;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const text =
    (await queryLorax(row, userId, messages)) ||
    (await queryRunPodInference(row, userId, messages));

  if (!text) return null;
  const cleanedText = sanitizePersonalDraftText(text);
  if (!cleanedText) return null;

  await supabase
    .from("cortex_lora_adapters")
    .update({
      last_inference_at: new Date().toISOString(),
      inference_count: (row.inference_count || 0) + 1,
    })
    .eq("id", row.id);

  return {
    text: cleanedText,
    model: row.base_model,
    adapterVersion: row.adapter_version,
  };
}

async function queryLorax(
  adapter: AdapterRow,
  userId: string,
  messages: Array<{ role: string; content: string }>
): Promise<string | null> {
  const loraxUrl = process.env.LORAX_API_URL;
  if (!loraxUrl) return null;

  try {
    const res = await fetch(buildChatCompletionsUrl(loraxUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LORAX_API_KEY && {
          Authorization: `Bearer ${process.env.LORAX_API_KEY}`,
        }),
      },
      body: JSON.stringify({
        model: adapter.base_model,
        messages,
        max_tokens: 1024,
        temperature: 0.55,
        adapter_id: `${userId}_v${adapter.adapter_version}`,
        adapter_source: adapter.adapter_file_path,
      }),
    });

    if (!res.ok) {
      console.error("LoRA draft inference failed:", await res.text());
      return null;
    }

    const data = await res.json();
    return extractOpenAiText(data);
  } catch (error) {
    console.error("LoRA draft query error:", error);
    return null;
  }
}

async function queryRunPodInference(
  adapter: AdapterRow,
  userId: string,
  messages: Array<{ role: string; content: string }>
): Promise<string | null> {
  const runpodApiKey = process.env.RUNPOD_API_KEY;
  const endpointId = process.env.RUNPOD_LORA_INFERENCE_ENDPOINT_ID;
  if (!runpodApiKey || !endpointId) return null;

  try {
    const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/runsync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runpodApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          task: "inference",
          base_model: adapter.base_model,
          messages,
          max_tokens: 1024,
          temperature: 0.55,
          adapter_id: `${userId}_v${adapter.adapter_version}`,
          adapter_source: adapter.adapter_file_path,
          s3_region: process.env.S3_REGION,
          s3_endpoint: process.env.S3_ENDPOINT,
        },
      }),
    });

    if (!res.ok) {
      console.error("RunPod LoRA draft inference failed:", await res.text());
      return null;
    }

    const data = await res.json();
    return extractRunPodText(data);
  } catch (error) {
    console.error("RunPod LoRA draft query error:", error);
    return null;
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1/chat/completions")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function extractOpenAiText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: unknown; text?: unknown };
  if (typeof first.text === "string") return first.text.trim();
  const message = first.message as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content.trim() : null;
}

function extractRunPodText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const root = value as { output?: unknown; status?: unknown; error?: unknown };
  if (root.status === "FAILED" || root.error) return null;

  const output = root.output as
    | { text?: unknown; output?: unknown; status?: unknown; error?: unknown }
    | undefined;
  if (!output || output.status === "FAILED" || output.error) return null;
  if (typeof output.text === "string") return output.text.trim();

  const nested = output.output as { text?: unknown } | undefined;
  return typeof nested?.text === "string" ? nested.text.trim() : null;
}

function sanitizePersonalDraftText(text: string): string | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/^\s*(assistant|model)\s*:\s*/i, "")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}
