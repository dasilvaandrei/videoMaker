// Minimal ElevenLabs TTS client — used only for the single intro hook
// line per ranking video (see jobs/generate-intro-vo.ts). A raw fetch
// call is simpler than the SDK for this one endpoint.

const API_BASE = "https://api.elevenlabs.io/v1/text-to-speech";

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY must be set");
  if (!voiceId) throw new Error("ELEVENLABS_VOICE_ID must be set");

  const res = await fetch(`${API_BASE}/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      // speed 1.15 — noticeably snappier delivery so the hook gets to
      // the point faster, short of the 1.2 ceiling where it starts
      // sounding rushed/unnatural.
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true, speed: 1.15 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs API request failed: ${res.status} ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
