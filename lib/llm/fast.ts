// Fast LLM provider failover for latency-sensitive voice turns.
//
// Priority order:
//   1. Cerebras llama-3.3-70b   — ~2100 tok/s, ~100ms TTFT, OpenAI-compatible
//   2. Groq llama-3.3-70b        — fast fallback, OpenAI-compatible
//   3. Anthropic Claude Haiku    — guaranteed reliability, Anthropic SDK
//
// Used for the conversational response layer where speed > tool-use depth.
// For the agentic tool-use loop, see lib/agent/loop.ts (still Anthropic-native).

import Anthropic from "@anthropic-ai/sdk";

export type FastMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export interface FastOptions {
  messages: FastMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Called for each text chunk as it streams in. */
  onChunk?: (chunk: string) => void;
  /** Called once with the provider that won. */
  onProvider?: (name: "cerebras" | "groq" | "anthropic") => void;
}

export interface FastResult {
  text: string;
  provider: "cerebras" | "groq" | "anthropic";
  ttftMs: number;
  totalMs: number;
}

const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = "llama-3.3-70b";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// OpenAI-compatible streaming helper for Cerebras + Groq.
async function streamOpenAICompat(
  url: string,
  apiKey: string,
  model: string,
  opts: FastOptions
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 600,
      temperature: opts.temperature ?? 0.6,
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`${url} ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE: lines starting with "data: ", separated by blank lines
    const parts = buf.split("\n");
    buf = parts.pop() || ""; // keep incomplete line for next iteration
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          full += delta;
          opts.onChunk?.(delta);
        }
      } catch {
        // ignore partial / malformed
      }
    }
  }
  return full;
}

async function callCerebras(opts: FastOptions): Promise<string> {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error("CEREBRAS_API_KEY missing");
  return streamOpenAICompat(CEREBRAS_URL, key, CEREBRAS_MODEL, opts);
}

async function callGroq(opts: FastOptions): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY missing");
  return streamOpenAICompat(GROQ_URL, key, GROQ_MODEL, opts);
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing");
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

async function callHaiku(opts: FastOptions): Promise<string> {
  const client = getAnthropic();
  const sysMsgs = opts.messages.filter((m) => m.role === "system");
  const otherMsgs = opts.messages.filter((m) => m.role !== "system");
  const system = sysMsgs.map((m) => m.content).join("\n\n");

  // Anthropic streaming
  let full = "";
  const stream = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: opts.maxTokens ?? 600,
    temperature: opts.temperature ?? 0.6,
    system,
    messages: otherMsgs.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
    stream: true,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      const delta = event.delta.text;
      full += delta;
      opts.onChunk?.(delta);
    }
  }
  return full;
}

export async function fastChat(opts: FastOptions): Promise<FastResult> {
  const start = Date.now();
  let firstChunkAt = 0;
  const wrapped: FastOptions = {
    ...opts,
    onChunk: (chunk) => {
      if (firstChunkAt === 0) firstChunkAt = Date.now();
      opts.onChunk?.(chunk);
    },
  };

  // Provider failover, fastest viable route first.
  const providers: Array<{
    name: "cerebras" | "groq" | "anthropic";
    fn: () => Promise<string>;
    available: boolean;
  }> = [
    {
      name: "cerebras",
      fn: () => callCerebras(wrapped),
      available: !!process.env.CEREBRAS_API_KEY,
    },
    {
      name: "groq",
      fn: () => callGroq(wrapped),
      available: !!process.env.GROQ_API_KEY,
    },
    {
      name: "anthropic",
      fn: () => callHaiku(wrapped),
      available: !!process.env.ANTHROPIC_API_KEY,
    },
  ];

  let lastError: unknown = null;
  for (const p of providers) {
    if (!p.available) continue;
    try {
      const text = await p.fn();
      opts.onProvider?.(p.name);
      return {
        text,
        provider: p.name,
        ttftMs: firstChunkAt ? firstChunkAt - start : 0,
        totalMs: Date.now() - start,
      };
    } catch (err) {
      console.warn(`[fastChat] ${p.name} failed:`, err);
      lastError = err;
      // Reset chunk timer if we already started streaming (shouldn't on failure)
      firstChunkAt = 0;
    }
  }

  throw new Error(
    `All fast LLM providers failed. Last: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}
