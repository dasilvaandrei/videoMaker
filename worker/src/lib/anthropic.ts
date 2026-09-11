// Minimal Anthropic Messages API client — used for one-time-per-artist
// bio generation (see jobs/generate-ranking-render-metadata.ts). A raw
// fetch call is simpler than the full SDK for this one endpoint.

const API_BASE = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

export async function generateText(systemPrompt: string, userPrompt: string, maxTokens = 500): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY must be set");

  const res = await fetch(API_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Anthropic API request failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.content?.[0]?.text ?? "";
}
