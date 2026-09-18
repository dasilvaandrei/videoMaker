// Downloads the resolved clip window for each pending song_clips row via
// yt-dlp (only the needed seconds, not the full video — see
// lib/ytdlp.ts), uploads the trimmed result to Supabase Storage, marks it
// downloaded. Requires the yt-dlp binary on PATH (see README setup).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadYoutubeSection } from "../lib/ytdlp.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";

// A failure gets this many total attempts (across separate pipeline
// runs, hours apart — see daily-pipeline.yml's 6h cadence, which already
// gives a real gap for something transient like a bot-detection block or
// expired cookies to get fixed) before it's given up on for good. Below
// the ceiling it goes back to 'pending' instead of 'failed', so
// download-song-clips.ts's own query (status='pending') naturally picks
// it back up next run — no separate retry queue needed. See
// run-daily-pipeline.ts's hasUnrecoverableClipFailure for what happens
// once a clip is genuinely 'failed': that ranking gets skipped rather
// than wedging the whole pipeline the way an un-retried failure used to.
const MAX_DOWNLOAD_ATTEMPTS = 3;

export async function downloadSongClips() {
  const { data: pending, error } = await supabase
    .from("song_clips")
    .select("id, youtube_video_id, start_seconds, end_seconds, download_attempts")
    .eq("status", "pending");
  if (error) throw error;

  console.log(`${pending?.length ?? 0} song_clips pending download`);

  for (const clip of pending ?? []) {
    const dir = await mkdtemp(join(tmpdir(), "song-clip-"));
    const outputPath = join(dir, "clip.mp4");

    try {
      await downloadYoutubeSection(clip.youtube_video_id, clip.start_seconds, clip.end_seconds, outputPath);

      const objectPath = `song-clips/${clip.id}.mp4`;
      const fileBuffer = await readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from("song_clips")
        .update({ storage_path: objectPath, status: "downloaded" })
        .eq("id", clip.id);
      if (updateError) throw updateError;

      console.log(`downloaded song_clip ${clip.id} -> ${objectPath}`);
    } catch (err) {
      // One bad download (age-restricted/removed video, transient
      // network error) shouldn't take down the rest of the batch. Stays
      // retryable ('pending') until MAX_DOWNLOAD_ATTEMPTS is actually
      // hit, rather than giving up after the very first failure.
      const attempts = (clip.download_attempts ?? 0) + 1;
      const giveUp = attempts >= MAX_DOWNLOAD_ATTEMPTS;
      console.error(
        `song_clip ${clip.id} failed (attempt ${attempts}/${MAX_DOWNLOAD_ATTEMPTS}${giveUp ? ", giving up" : ", will retry"}):`,
        err instanceof Error ? err.message : err
      );
      await supabase
        .from("song_clips")
        .update({ status: giveUp ? "failed" : "pending", download_attempts: attempts })
        .eq("id", clip.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  downloadSongClips()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
