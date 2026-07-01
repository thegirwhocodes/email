import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];

function read(file) {
  return readFileSync(path.join(root, file), "utf8");
}

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
}

function assertFile(file) {
  record(`file:${file}`, existsSync(path.join(root, file)));
}

function assertIncludes(name, file, needle) {
  const content = read(file);
  record(name, content.includes(needle), `${file} should include ${needle}`);
}

function assertMatches(name, file, pattern) {
  const content = read(file);
  record(name, pattern.test(content), `${file} should match ${pattern}`);
}

function assertNotMatches(name, file, pattern) {
  const content = read(file);
  record(name, !pattern.test(content), `${file} should not match ${pattern}`);
}

for (const file of [
  "app/page.tsx",
  "app/voice-email-client.tsx",
  "app/api/assistant/stream/route.ts",
  "app/api/assistant/turn/route.ts",
  "app/api/send/route.ts",
  "app/api/archive/route.ts",
  "app/api/cron/followups/route.ts",
  "app/api/cron/memory-maintenance/route.ts",
  "app/api/health/readiness/route.ts",
  "lib/agent/loop.ts",
  "lib/agent/assistant-agent.ts",
  "lib/agent/tools/email-tools.ts",
  "lib/agent/tools/conversation-tools.ts",
  "lib/auth/session.ts",
  "lib/config/readiness.ts",
  "lib/lora/inference-client.ts",
  "lib/integrations/gmail-token.ts",
  "scripts/check-production-smoke.mjs",
  ".env.example",
  "README.md",
]) {
  assertFile(file);
}

assertIncludes(
  "landing promises review-first send",
  "app/page.tsx",
  "Sends nothing without your approval"
);
assertIncludes(
  "readme promises explicit approval",
  "README.md",
  "never sends without explicit approval"
);

assertIncludes(
  "auth helper has typed unauthorized error",
  "lib/auth/session.ts",
  "UnauthorizedError"
);
assertIncludes(
  "auth helper has shared unauthorized response",
  "lib/auth/session.ts",
  "unauthorizedResponse"
);
for (const file of [
  "app/api/send/route.ts",
  "app/api/archive/route.ts",
  "app/api/queue/route.ts",
  "app/api/draft/route.ts",
  "app/api/summarize/route.ts",
  "app/api/intent/route.ts",
  "app/api/tts/route.ts",
  "app/api/email/get/route.ts",
  "app/api/assistant/init/route.ts",
  "app/api/assistant/turn/route.ts",
  "app/api/assistant/session-action/route.ts",
  "app/api/assistant/stream/route.ts",
  "app/api/agent/triage/route.ts",
  "app/api/digest/daily/route.ts",
]) {
  assertIncludes(
    `protected route handles unauthorized: ${file}`,
    file,
    "isUnauthorizedError"
  );
}

assertIncludes(
  "production smoke checks protected send",
  "scripts/check-production-smoke.mjs",
  'path: "/api/send"'
);
assertIncludes(
  "production smoke rejects anonymous APIs",
  "scripts/check-production-smoke.mjs",
  "expected 401 or Clerk/Vercel privacy 404"
);

assertIncludes(
  "stream prompt requires explicit send approval",
  "app/api/assistant/stream/route.ts",
  'Never set action="send" unless'
);
assertIncludes(
  "stream prompt requires explicit archive approval",
  "app/api/assistant/stream/route.ts",
  'Never set action="archive" unless'
);
assertIncludes(
  "assistant prompt forbids judgment-based archive",
  "lib/agent/assistant-agent.ts",
  "Never archive based on your own judgment"
);

assertIncludes(
  "client refuses send before draft exists",
  "app/voice-email-client.tsx",
  "No draft to send"
);
assertIncludes(
  "client reads draft before listening for approval",
  "app/voice-email-client.tsx",
  "Here's what I'd say"
);
assertMatches(
  "client sends only through send action branch",
  "app/voice-email-client.tsx",
  /meta\.action === "send"[\s\S]*fetch\("\/api\/send"/
);

assertIncludes(
  "triage draft tool queues pending human approval",
  "lib/agent/tools/email-tools.ts",
  'status: "pending"'
);
assertIncludes(
  "conversation send tool requires prior pending draft",
  "lib/agent/tools/conversation-tools.ts",
  'No pending drafted reply found'
);
assertMatches(
  "conversation send tool fetches pending action",
  "lib/agent/tools/conversation-tools.ts",
  /\.eq\("status", "pending"\)[\s\S]*\.limit\(50\)/
);
assertIncludes(
  "conversation archive tool is explicit-only",
  "lib/agent/tools/conversation-tools.ts",
  "Only use after the user explicitly says to archive this email"
);
assertNotMatches(
  "archive tool cannot archive from agent judgment",
  "lib/agent/tools/conversation-tools.ts",
  /clearly not worth keeping/i
);

assertIncludes(
  "tool outputs wrapped as untrusted content",
  "lib/agent/loop.ts",
  "wrapUntrusted"
);
assertIncludes(
  "mutating tools support advise mode",
  "lib/agent/loop.ts",
  'mode === "advise"'
);

assertIncludes(
  "followups cron is protected",
  "app/api/cron/followups/route.ts",
  "isAuthorizedCron"
);
assertIncludes(
  "memory-maintenance cron is protected",
  "app/api/cron/memory-maintenance/route.ts",
  "isAuthorizedCron"
);
assertIncludes(
  "readiness route reports centralized readiness",
  "app/api/health/readiness/route.ts",
  "getReadinessReport"
);
assertIncludes(
  "readiness checks token encryption key",
  "lib/config/readiness.ts",
  "TOKEN_ENCRYPTION_KEY"
);
assertIncludes(
  "readiness checks RunPod inference path",
  "lib/config/readiness.ts",
  "RUNPOD_LORA_INFERENCE_ENDPOINT_ID"
);
assertIncludes(
  "LoRA client has RunPod fallback",
  "lib/lora/inference-client.ts",
  "queryRunPodInference"
);
assertIncludes(
  "LoRA client strips thinking tags",
  "lib/lora/inference-client.ts",
  "sanitizePersonalDraftText"
);
assertIncludes(
  "env example documents RunPod endpoint",
  ".env.example",
  "RUNPOD_LORA_INFERENCE_ENDPOINT_ID"
);
assertIncludes(
  "Gmail token refresh remains server-side",
  "lib/integrations/gmail-token.ts",
  "refreshAccessToken"
);

const failed = results.filter((result) => !result.passed);
for (const result of results) {
  const marker = result.passed ? "ok" : "fail";
  console.log(`${marker} ${result.name}`);
  if (!result.passed && result.detail) {
    console.log(`  ${result.detail}`);
  }
}

if (failed.length > 0) {
  console.error(
    `\nSage launch readiness failed: ${results.length - failed.length} ok / ${failed.length} fail`
  );
  process.exit(1);
}

console.log(`\nSage launch readiness passed: ${results.length} ok / 0 fail`);
