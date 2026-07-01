import { promises as dns } from "dns";

export type ReadinessStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  message: string;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  checks: ReadinessCheck[];
}

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "TOKEN_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
];

const PRODUCTION_RECOMMENDED_ENV = [
  "CRON_SECRET",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "RUNPOD_API_KEY",
  "RUNPOD_LORA_INFERENCE_ENDPOINT_ID",
];

export async function getReadinessReport(): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  for (const key of REQUIRED_ENV) {
    checks.push({
      name: `env:${key}`,
      status: process.env[key] ? "ok" : "fail",
      message: process.env[key] ? "configured" : "missing",
    });
  }

  for (const key of PRODUCTION_RECOMMENDED_ENV) {
    checks.push({
      name: `env:${key}`,
      status: process.env[key] ? "ok" : "warn",
      message: process.env[key] ? "configured" : "missing for production",
    });
  }

  checks.push(checkTokenKey());
  checks.push(checkSupabaseRefMatch());
  checks.push(checkLoraServingBackend());
  checks.push(await checkSupabaseDns());

  return {
    status: rollup(checks),
    checks,
  };
}

function checkLoraServingBackend(): ReadinessCheck {
  const hasLoraxUrl = Boolean(process.env.LORAX_API_URL);
  const hasLoraxKey = Boolean(process.env.LORAX_API_KEY);
  const hasRunPodInference = Boolean(process.env.RUNPOD_LORA_INFERENCE_ENDPOINT_ID);
  const hasRunPodKey = Boolean(process.env.RUNPOD_API_KEY);

  if (hasLoraxUrl && hasLoraxKey) {
    return {
      name: "lora-serving-backend",
      status: "ok",
      message: "LoRAX/vLLM configured",
    };
  }

  if (hasLoraxUrl && !hasLoraxKey) {
    return {
      name: "lora-serving-backend",
      status: "warn",
      message: "LORAX_API_URL is set, but LORAX_API_KEY is missing",
    };
  }

  if (hasRunPodInference && hasRunPodKey) {
    return {
      name: "lora-serving-backend",
      status: "ok",
      message: "RunPod LoRA inference configured",
    };
  }

  if (hasRunPodInference && !hasRunPodKey) {
    return {
      name: "lora-serving-backend",
      status: "warn",
      message:
        "RUNPOD_LORA_INFERENCE_ENDPOINT_ID is set, but RUNPOD_API_KEY is missing",
    };
  }

  return {
    name: "lora-serving-backend",
    status: "warn",
    message:
      "missing LoRAX/vLLM serving or RUNPOD_LORA_INFERENCE_ENDPOINT_ID",
  };
}

function checkTokenKey(): ReadinessCheck {
  const key = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!key) {
    return { name: "token-encryption-key", status: "fail", message: "missing" };
  }
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    return {
      name: "token-encryption-key",
      status: "fail",
      message: "must be 32 bytes encoded as 64 hex characters",
    };
  }
  return {
    name: "token-encryption-key",
    status: "ok",
    message: "valid length and encoding",
  };
}

function checkSupabaseRefMatch(): ReadinessCheck {
  const host = getSupabaseHost();
  const tokenRef = getSupabaseJwtRef(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

  if (!host || !tokenRef) {
    return {
      name: "supabase-ref-match",
      status: "fail",
      message: "missing or invalid Supabase URL/service key",
    };
  }

  const hostRef = host.split(".")[0];
  if (hostRef !== tokenRef) {
    return {
      name: "supabase-ref-match",
      status: "fail",
      message: "Supabase URL ref does not match service-role key ref",
    };
  }

  return {
    name: "supabase-ref-match",
    status: "ok",
    message: `ref ${hostRef}`,
  };
}

async function checkSupabaseDns(): Promise<ReadinessCheck> {
  const host = getSupabaseHost();
  if (!host) {
    return {
      name: "supabase-dns",
      status: "fail",
      message: "invalid NEXT_PUBLIC_SUPABASE_URL",
    };
  }

  try {
    await dns.lookup(host);
    return {
      name: "supabase-dns",
      status: "ok",
      message: `${host} resolves`,
    };
  } catch (error) {
    return {
      name: "supabase-dns",
      status: "fail",
      message: error instanceof Error ? error.message : "DNS lookup failed",
    };
  }
}

function getSupabaseHost(): string | null {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "").host;
  } catch {
    return null;
  }
}

function getSupabaseJwtRef(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(
      Buffer.from(
        payload.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8")
    );
    return typeof decoded.ref === "string" ? decoded.ref : null;
  } catch {
    return null;
  }
}

function rollup(checks: ReadinessCheck[]): ReadinessStatus {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "ok";
}
