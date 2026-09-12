// One-off, run manually (not part of the daily cron): downloads a small,
// fixed library of "satisfying" B-roll loops for the intro's split-screen
// bottom half (see RankingCountdown.tsx's IntroHook and the user's
// retention-hack brief — kinetic sand / 3D render loops keep the eye
// moving while the intro VO plays). render-ranking-videos.ts picks one at
// random per video from BG_LOOP_PATHS below.
//
// Deliberately restricted to videoLicense=creativeCommon in the search —
// unlike the artist music videos (an accepted Content ID risk tradeoff
// specific to sourcing an actual song's real official video, which has
// no license-free substitute), this is generic, unrelated filler
// footage, so there's no reason to accept that same risk when
// specifically-licensed alternatives exist.
//
// Re-run this (and update BG_LOOP_PATHS in render-ranking-videos.ts) any
// time the library should be refreshed — it's intentionally not dynamic
// per-video, the same way RANK_DING_PATH's sfx is a fixed, reused asset.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadYoutubeSection } from "../lib/ytdlp.js";
import { getVideosInfo } from "../lib/youtube.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
// Picked from a live creativeCommon-filtered search (see this file's
// header) — not guessed: kinetic sand (the user's own example), a 3D
// render loop (also the user's example), and a generic oddly-satisfying
// loop for variety.
const SOURCE_VIDEOS: { videoId: string; slug: string }[] = [
  { videoId: "lQU-PwVMKmU", slug: "kinetic-sand" },
  { videoId: "f1xDEcBLFNI", slug: "3d-render-loop" },
  { videoId: "2WxZpsR-rLU", slug: "satisfying-loop" },
];
// Long enough to cover virtually any intro VO length without running out
// mid-sequence (see introDurationInSeconds in RankingCountdown.tsx —
// real intro lines run a few seconds to a bit over ten).
const LOOP_LENGTH_SECONDS = 25;

export async function resolveBgLoops() {
  const infos = await getVideosInfo(SOURCE_VIDEOS.map((v) => v.videoId));
  const infoById = new Map(infos.map((i) => [i.videoId, i]));

  for (const source of SOURCE_VIDEOS) {
    const info = infoById.get(source.videoId);
    if (!info) {
      console.error(`${source.slug}: video ${source.videoId} not found, skipping`);
      continue;
    }

    // Skip past any title-card start, same percentage-heuristic spirit as
    // resolve-song-clips.ts.
    const start = Math.max(0, Math.floor(info.durationSeconds * 0.1));
    const end = Math.min(info.durationSeconds, start + LOOP_LENGTH_SECONDS);

    const dir = await mkdtemp(join(tmpdir(), "bg-loop-"));
    const outputPath = join(dir, "loop.mp4");

    try {
      await downloadYoutubeSection(source.videoId, start, end, outputPath);

      const objectPath = `bg-loops/${source.slug}.mp4`;
      const fileBuffer = await readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      console.log(`${source.slug}: uploaded -> ${objectPath} (${(end - start).toFixed(1)}s)`);
    } catch (err) {
      console.error(`${source.slug} failed:`, err instanceof Error ? err.message : err);
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
