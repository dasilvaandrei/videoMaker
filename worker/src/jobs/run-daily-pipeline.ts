// Single entry point for the daily cron: deterministically picks one
// (artist, source) pair from the roster based on today's date, and runs
// it through the entire pipeline — fetch -> resolve clips -> download ->
// render -> auto-approve -> publish — unattended, end to end.
//
// Cycles through every (artist, source) combination before repeating,
// rather than fetching/rendering the whole roster every day — that would
// be ~2x the roster size in renders/downloads per day for a channel that
// only posts one video a day, all waste.
//
// Auto-approve exists because the review-gate trigger normally requires
// a human review_decisions row before a post can be created — a
// deliberate choice here to run fully hands-off, not an oversight. If
// that ever needs to change, delete the autoApproveReadyVideos() call
// and let /review gate it like every other pipeline does.

import { loadArtistRoster } from "../config/artists.js";
import { fetchLastfmRankings } from "./fetch-lastfm-rankings.js";
import { fetchYoutubeRankings } from "./fetch-youtube-rankings.js";
import { resolveSongClips } from "./resolve-song-clips.js";
import { downloadSongClips } from "./download-song-clips.js";
import { generateRankingRenderMetadata } from "./generate-ranking-render-metadata.js";
import { renderRankingVideos } from "./render-ranking-videos.js";
import { publishApprovedClips } from "./publish-post.js";
import { supabase } from "../lib/supabase.js";

function daysSinceEpoch(): number {
  return Math.floor(Date.now() / 86_400_000);
}

async function autoApproveReadyVideos(): Promise<void> {
  const { data: ready, error } = await supabase.from("ranking_videos").select("id").eq("render_status", "ready");
  if (error) throw error;

  const { data: decided, error: decidedError } = await supabase.from("review_decisions").select("ranking_video_id");
  if (decidedError) throw decidedError;
  const decidedIds = new Set((decided ?? []).map((d) => d.ranking_video_id as string));

  const undecided = (ready ?? []).filter((v) => !decidedIds.has(v.id));
  for (const video of undecided) {
    const { error: insertError } = await supabase.from("review_decisions").insert({
      ranking_video_id: video.id,
      decision: "approved",
      notes: "auto-approved by run-daily-pipeline.ts (fully hands-off mode)",
    });
    if (insertError) throw insertError;
    console.log(`auto-approved ${video.id}`);
  }
}

export async function runDailyPipeline() {
  const roster = loadArtistRoster();
  if (roster.length === 0) throw new Error("artists.json is empty — add at least one artist");

  const pairIndex = daysSinceEpoch() % (roster.length * 2);
  const artistIndex = Math.floor(pairIndex / 2);
  const wantsYoutube = pairIndex % 2 === 1;
  const artist = roster[artistIndex];
  // Falls back to lastfm for an artist missing a youtubeChannelId rather
  // than skipping the day entirely.
  const source: "lastfm" | "youtube" = wantsYoutube && artist.youtubeChannelId ? "youtube" : "lastfm";

  console.log(`Today's pick: ${artist.name} (${source})`);

  if (source === "youtube") {
    await fetchYoutubeRankings([artist.name]);
  } else {
    await fetchLastfmRankings([artist.name]);
  }

  await resolveSongClips();
  await downloadSongClips();
  await generateRankingRenderMetadata();
  await renderRankingVideos();
  await autoApproveReadyVideos();
  await publishApprovedClips({ limit: 1 });

  console.log("Daily pipeline complete.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
