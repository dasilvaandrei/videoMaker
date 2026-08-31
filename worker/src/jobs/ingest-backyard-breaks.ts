// Campaign-specific adapter for Backyard Breaks: unlike a raw long-form VOD
// (the generic ingest-campaign-source.ts path), this campaign delivers
// source content as a spreadsheet of already-curated, clip-worthy moments —
// one Drive video file per row, plus context ClipHouse already wrote (card
// value, why it matters, a suggested caption, a hype level). So this job
// creates both source_videos AND the clips row in one pass (start=0,
// end=probed duration, detection_method='manual') rather than leaving
// highlight detection to a separate stage — there's no real detection to
// do here, the campaign already did it.

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse/sync";
import { probeDurationSeconds } from "../lib/ffmpeg.js";
import {
  DriveQuotaExceededError,
  driveStoragePath,
  extractDriveFileId,
  fetchDriveFile,
  sheetCsvExportUrl,
} from "../lib/drive.js";
import { supabase } from "../lib/supabase.js";

const CAMPAIGN_TITLE = "Backyard Breaks [Clipping Campaign]";

const HYPE_SCORE: Record<string, number> = {
  LOW: 25,
  MEDIUM: 50,
  HIGH: 75,
  INSANE: 100,
};

function hypeToScore(hype: string): number | null {
  const upper = hype.toUpperCase();
  for (const [key, score] of Object.entries(HYPE_SCORE)) {
    if (upper.includes(key)) return score;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadToTempFile(fileId: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "videomaker-"));
  const path = join(dir, "clip.mp4");
  const res = await fetchDriveFile(fileId);
  if (!res.body) throw new Error(`no response body for ${fileId}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

interface TrackerRow {
  driveLink: string;
  cardName: string;
  cardValue: string;
  product: string;
  whySpecial: string;
  suggestedCaption: string;
  hypeLevel: string;
  notes: string;
}

// Header names are normalized (embedded newlines collapsed to spaces) —
// confirmed against the real sheet at build time. If ClipHouse edits the
// sheet's columns, this needs updating to match.
function parseTracker(csvText: string): TrackerRow[] {
  const rows: string[][] = parse(csvText, { relax_column_count: true });
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "Drive Link");
  if (headerIdx === -1) throw new Error("could not find 'Drive Link' header row in tracker CSV");

  const headers = rows[headerIdx].map((h) => h.replace(/\s+/g, " ").trim());
  const col = (row: string[], name: string) => row[headers.indexOf(name)]?.trim() ?? "";

  return rows
    .slice(headerIdx + 1)
    .filter((row) => row[0]?.trim())
    .map((row) => ({
      driveLink: col(row, "Drive Link"),
      cardName: col(row, "Card Name / Description"),
      cardValue: col(row, "Card Value (USD) ⭐"),
      product: col(row, "Product/Collection"),
      whySpecial: col(row, "Why It Was Special"),
      suggestedCaption: col(row, "Suggested Caption / On-Screen Text"),
      hypeLevel: col(row, "Hype Level"),
      notes: col(row, "Notes for Clippers"),
    }));
}

export async function ingestBackyardBreaks() {
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns")
    .select("id, partner_id, source_content_url, status")
    .eq("title", CAMPAIGN_TITLE)
    .single();
  if (campaignError) throw campaignError;
  if (campaign.status !== "joined" || !campaign.partner_id || !campaign.source_content_url) {
    throw new Error("Backyard Breaks campaign is not joined yet — run join-campaign first");
  }

  const csvText = await (await fetch(sheetCsvExportUrl(campaign.source_content_url))).text();
  const rows = parseTracker(csvText);
  console.log(`tracker has ${rows.length} rows`);

  for (const row of rows) {
    const fileId = extractDriveFileId(row.driveLink);
    if (!fileId) {
      console.warn(`skip row "${row.cardName}": not a Drive file link (${row.driveLink})`);
      continue;
    }

    // Check before downloading, not just before inserting — no point
    // re-downloading (and hitting Drive's rate limit) for rows already ingested.
    const { data: existing } = await supabase
      .from("source_videos")
      .select("id")
      .eq("external_ref", fileId)
      .maybeSingle();
    if (existing) {
      console.log(`already ingested: ${row.cardName}`);
      continue;
    }

    // A small gap between requests to stay well under the Drive API's own
    // per-key rate limit (separate from the per-file downloadQuotaExceeded
    // case, which no amount of pacing fixes — see lib/drive.ts).
    await sleep(500);

    try {
      // Downloaded only transiently to probe duration via ffprobe — not
      // persisted anywhere. We store a reference to the Drive file
      // (see lib/drive.ts) rather than a durable copy; the render step
      // re-fetches the actual bytes on demand when it needs them.
      const { path, cleanup } = await downloadToTempFile(fileId);
      try {
        const durationSeconds = await probeDurationSeconds(path);
        if (!durationSeconds) {
          console.warn(`skip "${row.cardName}": downloaded file is not a valid/probeable video`);
          continue;
        }

        const { data: sourceVideo, error: insertError } = await supabase
          .from("source_videos")
          .insert({
            partner_id: campaign.partner_id,
            campaign_id: campaign.id,
            storage_path: driveStoragePath(fileId),
            duration_seconds: durationSeconds,
            status: "processed",
            external_ref: fileId,
            raw_metadata: row,
          })
          .select("id")
          .single();
        if (insertError) {
          if (insertError.code === "23505") {
            console.log(`already ingested (race): ${row.cardName}`);
            continue;
          }
          throw insertError;
        }

        const { error: clipError } = await supabase.from("clips").insert({
          source_video_id: sourceVideo.id,
          start_seconds: 0,
          end_seconds: durationSeconds,
          detection_method: "manual",
          moment_type: row.cardName,
          transcript: [row.whySpecial, row.notes].filter(Boolean).join(" — ") || null,
          virality_score: hypeToScore(row.hypeLevel),
        });
        if (clipError) throw clipError;

        console.log(`ingested: ${row.cardName} (${durationSeconds}s, hype=${row.hypeLevel})`);
      } finally {
        await cleanup();
      }
    } catch (err) {
      // One bad row (quota, oversized, transient network error) should
      // never take down the rest of the batch.
      if (err instanceof DriveQuotaExceededError) {
        console.warn(`skip "${row.cardName}": Google's per-file download quota is exhausted — retry later`);
      } else {
        console.error(`skip "${row.cardName}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestBackyardBreaks()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
