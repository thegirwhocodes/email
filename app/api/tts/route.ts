import { NextRequest, NextResponse } from "next/server";
import {
  getUserId,
  isUnauthorizedError,
  unauthorizedResponse,
} from "@/lib/auth/session";

// Streaming TTS endpoint. ElevenLabs if configured, otherwise 501 -> browser
// SpeechSynthesis fallback in the client.
//
// Required env (optional — without it the app still works with browser TTS):
//   ELEVENLABS_API_KEY
//   ELEVENLABS_VOICE_ID  (defaults to Rachel, a warm female voice)

export const maxDuration = 60;

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel — warm, conversational

export async function POST(request: NextRequest) {
  try {
    await getUserId();
    const { text } = await request.json();
    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "TTS not configured", fallback: "browser" },
        { status: 501 }
      );
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`;

    const elRes = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!elRes.ok || !elRes.body) {
      const errBody = await elRes.text().catch(() => "");
      console.error("ElevenLabs error:", elRes.status, errBody);
      return NextResponse.json(
        { error: `ElevenLabs failed: ${elRes.status}`, fallback: "browser" },
        { status: 502 }
      );
    }

    return new NextResponse(elRes.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isUnauthorizedError(error)) return unauthorizedResponse();
    console.error("TTS error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "TTS failed" },
      { status: 500 }
    );
  }
}
