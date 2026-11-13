// One-off, run manually (not part of the daily cron): cuts the GTA 5
// gameplay windows listed in config/gameplayLoops.ts from their source
// video and uploads them to Storage, for the bottom half of every ranking
// video. Re-run after changing that list.
//
// Only Creative Commons footage — unlike the artist music videos (an
// accepted Content ID risk, since a song's real video has no license-free
// substitute), this is filler with free-to-use alternatives, so there's
// no reason to take the same risk.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadYoutubeSection } from "../lib/ytdlp.js";
import { supabase } from "../lib/supabase.js";
import { GAMEPLAY_LOOPS, GAMEPLAY_LOOP_SECONDS, GAMEPLAY_SOURCE_VIDEO_ID } from "../config/gameplayLoops.js";

const MEDIA_BUCKET = "media";

export async function resolveBgLoops() {
  for (const loop of GAMEPLAY_LOOPS) {
    const dir = await mkdtemp(join(tmpdir(), "bg-loop-"));
    const outputPath = join(dir, "loop.mp4");

    try {
      await downloadYoutubeSection(
        GAMEPLAY_SOURCE_VIDEO_ID,
        loop.startSeconds,
        loop.startSeconds + GAMEPLAY_LOOP_SECONDS,
        outputPath
      );

      const fileBuffer = await readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(loop.path, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      console.log(`uploaded ${loop.path} (${GAMEPLAY_LOOP_SECONDS}s from ${loop.startSeconds}s)`);
    } catch (err) {
      console.error(`${loop.path} failed:`, err instanceof Error ? err.message : err);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolveBgLoops()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
