#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://voice-email-app.vercel.app";
const baseUrl = normalizeBaseUrl(
  process.env.VOICE_EMAIL_URL || process.env.SAGE_MAIL_URL || DEFAULT_BASE_URL
);

const protectedChecks = [
  { method: "GET", path: "/api/queue" },
  { method: "GET", path: "/api/digest/daily" },
  {
    method: "POST",
    path: "/api/send",
    body: { to: "smoke@example.com", subject: "smoke", body: "smoke" },
  },
  { method: "POST", path: "/api/archive", body: { messageId: "smoke-message-id" } },
  { method: "POST", path: "/api/draft", body: { body: "hello", subject: "smoke" } },
  { method: "POST", path: "/api/summarize", body: { body: "hello", subject: "smoke" } },
  { method: "POST", path: "/api/intent", body: { speech: "send it", stage: "after_draft" } },
  { method: "POST", path: "/api/tts", body: { text: "hello" } },
  { method: "POST", path: "/api/email/get", body: { source_id: "smoke-message-id" } },
  { method: "POST", path: "/api/assistant/init" },
  {
    method: "POST",
    path: "/api/assistant/turn",
    body: { messages: [{ role: "user", content: "begin" }] },
  },
  {
    method: "POST",
    path: "/api/assistant/stream",
    body: { bundle: {}, conversation: [], user_text: "begin" },
  },
  {
    method: "POST",
    path: "/api/assistant/session-action",
    body: { action: "wrap", reason: "smoke" },
  },
  { method: "POST", path: "/api/agent/triage" },
];

const checks = [
  rootCheck(),
  readinessCheck(),
  cronGate("GET", "/api/cron/followups"),
  cronGate("GET", "/api/cron/memory-maintenance"),
  ...protectedChecks.map((check) => protectedApiGate(check)),
];

const results = [];
for (const check of checks) {
  results.push(await runCheck(check));
}

const failed = results.filter((result) => result.status === "fail");
for (const result of results) {
  console.log(`${result.status} ${result.name} - ${result.message}`);
}

if (failed.length > 0) {
  console.error(
    `\nSage production smoke failed: ${results.length - failed.length} ok / ${failed.length} fail`
  );
  process.exit(1);
}

console.log(`\nSage production smoke passed: ${results.length} ok / 0 fail`);

function rootCheck() {
  return {
    name: "GET /",
    async run() {
      const res = await fetch(baseUrl, { redirect: "manual" });
      const contentType = res.headers.get("content-type") || "";
      const text = await res.text();
      const ok =
        res.status === 200 &&
        contentType.includes("text/html") &&
        text.includes("Sage Mail") &&
        text.includes("Sends nothing without your approval");

      return {
        status: ok ? "ok" : "fail",
        message: `HTTP ${res.status}; ${contentType || "unknown content"}`,
      };
    },
  };
}

function readinessCheck() {
  return {
    name: "GET /api/health/readiness",
    async run() {
      const res = await fetch(`${baseUrl}/api/health/readiness`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return {
          status: "fail",
          message: `HTTP ${res.status}; non-json readiness`,
        };
      }

      const body = await res.json();
      const status = body?.status || "unknown";
      if (status === "ok") {
        return { status: "ok", message: `HTTP ${res.status}; readiness ok` };
      }
      if (status === "warn") {
        return { status: "ok", message: `HTTP ${res.status}; readiness warn` };
      }
      return { status: "fail", message: `HTTP ${res.status}; readiness ${status}` };
    },
  };
}

function cronGate(method, path) {
  return {
    name: `${method} ${path}`,
    async run() {
      const res = await fetch(`${baseUrl}${path}`, { method });
      return {
        status: res.status === 401 ? "ok" : "fail",
        message: `HTTP ${res.status}; expected 401`,
      };
    },
  };
}

function protectedApiGate({ method, path, body }) {
  return {
    name: `${method} ${path}`,
    async run() {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        redirect: "manual",
      });
      const ok = res.status === 401 || res.status === 404;
      return {
        status: ok ? "ok" : "fail",
        message: `HTTP ${res.status}; expected 401 or Clerk/Vercel privacy 404`,
      };
    },
  };
}

async function runCheck(check) {
  try {
    const result = await check.run();
    return {
      name: check.name,
      status: result.status,
      message: result.message,
    };
  } catch (error) {
    return {
      name: check.name,
      status: "fail",
      message: error instanceof Error ? error.message : "check failed",
    };
  }
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
