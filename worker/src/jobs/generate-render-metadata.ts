// Turns campaign-sourced clips into queued clip_renders rows. Unlike a
// generic pipeline that'd call an LLM here (plan §6), Backyard Breaks
// already comes with ClipHouse-authored hook/caption material per row
// (card name, why it was special, a suggested caption) via the tracker
// spreadsheet ingested in ingest-backyard-breaks.ts — reusing it is the
// cost-conscious default from plan §5 ("small/cheap model tier... where
// possible"; here the cheapest option is no model call at all). Swap in
// an LLM-generation step later if A/B data shows it's worth the $/clip.

import { supabase } from "../lib/supabase.js";

const CAMPAIGN_HASHTAGS = ["backyardbreaks", "cardbreak", "tradingcards", "sportscards", "whatnot"];

interface SourceVideoJoin {
  campaign_id: string | null;
  raw_metadata: Record<string, unknown> | null;
}

interface PendingClip {
  id: string;
  moment_type: string | null;
  virality_score: number | null;
  source_videos: SourceVideoJoin | SourceVideoJoin[] | null;
}

function buildHookText(momentType: string | null): string {
  const name = momentType?.trim() || "This card hit different";
  return name.length > 60 ? `${name.slice(0, 57)}...` : name;
}

function buildCaption(rawSuggested: unknown, whySpecial: unknown): string {
  if (typeof rawSuggested === "string" && rawSuggested.trim()) return rawSuggested.trim();
  if (typeof whySpecial === "string" && whySpecial.trim()) return whySpecial.trim();
  return "Wait for it...";
}

function sourceVideoOf(clip: PendingClip): SourceVideoJoin | null {
  return Array.isArray(clip.source_videos) ? clip.source_videos[0] ?? null : clip.source_videos;
}

export async function generateRenderMetadata() {
  const { data: existingRenders, error: existingError } = await supabase
    .from("clip_renders")
    .select("clip_id");
  if (existingError) throw existingError;
  const alreadyQueued = new Set((existingRenders ?? []).map((r) => r.clip_id as string));

  const { data: clips, error } = await supabase
    .from("clips")
    .select("id, moment_type, virality_score, source_videos!inner(campaign_id, raw_metadata)")
    .not("source_videos.campaign_id", "is", null)
    .returns<PendingClip[]>();
  if (error) throw error;

  const pending = (clips ?? []).filter((c) => !alreadyQueued.has(c.id));
  console.log(`${pending.length} of ${clips?.length ?? 0} campaign clips need render metadata`);

  for (const clip of pending) {
    const raw = sourceVideoOf(clip)?.raw_metadata ?? {};
    const hookText = buildHookText(clip.moment_type);
    const caption = buildCaption(raw.suggestedCaption, raw.whySpecial);

    const { error: insertError } = await supabase.from("clip_renders").insert({
      clip_id: clip.id,
      aspect_ratio: "9:16",
      style_variant: "hook-caption-v1",
      hook_text: hookText,
      caption,
      hashtags: CAMPAIGN_HASHTAGS,
      predicted_virality_score: clip.virality_score,
      render_status: "queued",
    });
    if (insertError) throw insertError;

    console.log(`queued render for clip ${clip.id}: "${hookText}"`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateRenderMetadata()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
