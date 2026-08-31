import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { supabase } from "../lib/supabase.js";

const STORAGE_BUCKET = "media";

async function ensureBucket() {
  const { error } = await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
  if (error && !/already exists/i.test(error.message)) throw error;
}

// Downloads to a temp file first rather than buffering in memory — campaign
// source content is often a full podcast/stream VOD (potentially hours
// long), unlike the short clips the earlier Twitch approach handled.
async function downloadToTempFile(url: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "videomaker-"));
  const path = join(dir, "source.mp4");

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`source download failed: ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));

  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function ingestCampaignSources() {
  await ensureBucket();

  const { data: campaigns, error } = await supabase
    .from("campaigns")
    .select("id, partner_id, source_content_url")
    .eq("status", "joined")
    .not("source_content_url", "is", null);
  if (error) throw error;

  for (const campaign of campaigns ?? []) {
    if (!campaign.partner_id) {
      console.warn(`skip campaign ${campaign.id}: no partner_id (run join-campaign first)`);
      continue;
    }

    // One source_video per campaign for now — re-run manually if a campaign
    // later supplies additional footage.
    const { data: existing, error: existingError } = await supabase
      .from("source_videos")
      .select("id")
      .eq("campaign_id", campaign.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) continue;

    console.log(`downloading source for campaign ${campaign.id}`);
    // Assumes source_content_url is a direct, fetchable video file. Some
    // campaigns may deliver access via YouTube/Drive/etc instead — if a
    // download 404s or comes back as HTML, that campaign needs a small
    // platform-specific adapter here rather than this generic fetch.
    const { path, cleanup } = await downloadToTempFile(campaign.source_content_url!);
    try {
      const storagePath = `source/campaign/${campaign.id}.mp4`;
      const fileBuffer = await readFile(path);
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      const { error: insertError } = await supabase.from("source_videos").insert({
        partner_id: campaign.partner_id,
        campaign_id: campaign.id,
        storage_path: storagePath,
        status: "pending",
        raw_metadata: { campaign_id: campaign.id },
      });
      if (insertError) throw insertError;
    } finally {
      await cleanup();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestCampaignSources()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
