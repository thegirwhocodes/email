// Canonical Claude tool-use agent loop.
//
// Invariants:
//   - All tool outputs are wrapped in <untrusted_content> tags before being
//     re-injected into the conversation. Email bodies, web pages, anything from
//     the outside world is data, not instructions.
//   - Hard ceiling on iterations to prevent infinite loops.
//   - Prompt caching applied to system prompt + tool list (the stable prefix).
//   - Returns full audit trail: final answer + every tool call & its result.

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export interface AgentTool {
  name: string;
  description: string;
  // JSON Schema for the tool's input.
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  // The handler. Whatever it returns is JSON-stringified into the tool result.
  // Throw to signal an error (gets reported back to the model as is_error).
  handler: (input: Record<string, unknown>, ctx: AgentContext) => Promise<unknown>;
  // Tools that mutate the world should set this. The loop wrapper logs and
  // can refuse to call them depending on `mode`.
  mutates?: boolean;
}

export interface AgentContext {
  userId: string;
  // Free-form request-scoped state shared across tool handlers.
  scratch: Record<string, unknown>;
}

export interface AgentRun {
  // The final assistant message text (the model's answer once it stops calling tools).
  finalText: string;
  // Every tool invocation in order.
  toolLog: Array<{
    name: string;
    input: unknown;
    output: unknown;
    isError: boolean;
    durationMs: number;
  }>;
  iterations: number;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// Either pass `userMessage` (single-shot) or `messages` (multi-turn). The
// multi-turn form is for conversational agents — each turn appends the
// previous turn's full content (incl. tool_use/tool_result blocks) and runs
// runAgent again.
export type AgentRunOptions = AgentRunOptionsCommon &
  (
    | { userMessage: string; messages?: never }
    | {
        userMessage?: never;
        messages: Anthropic.Messages.MessageParam[];
      }
  );

interface AgentRunOptionsCommon {
  model: "haiku" | "sonnet";
  systemPrompt: string;
  tools: AgentTool[];
  ctx: AgentContext;
  maxIterations?: number;
  // "advise" = mutating tools become no-ops that record what they would have done.
  // "act"    = mutating tools run for real.
  mode?: "advise" | "act";
}

const MODEL_IDS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
} as const;

const DEFAULT_MAX_ITERATIONS = 12;

export interface AgentRunWithMessages extends AgentRun {
  // The full messages array after this run — includes tool calls/results and
  // the final assistant message. Pass this back in next turn for conversational
  // agents.
  messages: Anthropic.Messages.MessageParam[];
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunWithMessages> {
  const {
    model,
    systemPrompt,
    tools,
    ctx,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    mode = "act",
  } = opts;

  const client = getClient();

  const toolDefs = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  // Place cache_control on the system prompt so the prefix (system + tools) is
  // cache-readable on every turn after the first.
  const systemBlocks = [
    {
      type: "text" as const,
      text: systemPrompt,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  const messages: Anthropic.Messages.MessageParam[] =
    "messages" in opts && opts.messages
      ? [...opts.messages]
      : [{ role: "user", content: opts.userMessage as string }];

  const toolLog: AgentRun["toolLog"] = [];
  let iterations = 0;
  let stopReason: string | null = null;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let finalText = "";

  while (iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model: MODEL_IDS[model],
      max_tokens: 4096,
      system: systemBlocks,
      tools: toolDefs,
      messages,
    });

    stopReason = response.stop_reason;
    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    totalCacheRead += response.usage.cache_read_input_tokens || 0;
    totalCacheCreate += response.usage.cache_creation_input_tokens || 0;

    // If the model just spoke (no tool_use), we're done.
    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find((b) => b.type === "text");
      finalText = (textBlock as { type: "text"; text: string } | undefined)?.text ?? "";
      messages.push({ role: "assistant", content: response.content });
      break;
    }

    // Otherwise, run every tool_use block in parallel and feed results back.
    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        const tool = tools.find((t) => t.name === tu.name);
        if (!tool) {
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: `Tool '${tu.name}' not found.`,
            is_error: true,
          };
        }

        if (tool.mutates && mode === "advise") {
          const advisory = {
            advised: true,
            tool: tu.name,
            input: tu.input,
            note: "Mutating tool not executed in advise mode. Action was recorded for human approval.",
          };
          toolLog.push({
            name: tu.name,
            input: tu.input,
            output: advisory,
            isError: false,
            durationMs: 0,
          });
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: wrapUntrusted(JSON.stringify(advisory)),
            is_error: false,
          };
        }

        const start = Date.now();
        try {
          const out = await tool.handler(
            (tu.input as Record<string, unknown>) || {},
            ctx
          );
          const durationMs = Date.now() - start;
          toolLog.push({
            name: tu.name,
            input: tu.input,
            output: out,
            isError: false,
            durationMs,
          });
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: wrapUntrusted(
              typeof out === "string" ? out : JSON.stringify(out)
            ),
            is_error: false,
          };
        } catch (err) {
          const durationMs = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          toolLog.push({
            name: tu.name,
            input: tu.input,
            output: { error: message },
            isError: true,
            durationMs,
          });
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: wrapUntrusted(`Tool error: ${message}`),
            is_error: true,
          };
        }
      })
    );

    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  if (iterations >= maxIterations && stopReason === "tool_use") {
    finalText =
      "I hit my iteration ceiling before finishing. Falling back to whatever I gathered so far.";
  }

  return {
    finalText,
    toolLog,
    iterations,
    stopReason,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreationTokens: totalCacheCreate,
    messages,
  };
}

// All tool output gets wrapped — model should treat its contents as data, never
// as instructions. The system prompt must reinforce this.
function wrapUntrusted(content: string): string {
  return `<untrusted_content>\n${content}\n</untrusted_content>`;
}
