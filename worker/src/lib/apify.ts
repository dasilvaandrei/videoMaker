const APIFY_TOKEN = process.env.APIFY_TOKEN;

// Runs an Apify actor synchronously and returns its dataset items.
// actorId must be in Apify's "username~actorName" form (not the
// slash-separated form used in apify.com URLs).
export async function runActorSync<T = Record<string, unknown>>(
  actorId: string,
  input: Record<string, unknown>
): Promise<T[]> {
  if (!APIFY_TOKEN) {
    throw new Error("APIFY_TOKEN must be set");
  }

  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new Error(`Apify actor run failed (${actorId}): ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as T[];
}
