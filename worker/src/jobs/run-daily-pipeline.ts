// Single entry point for the daily cron. Each day:
//   1. Sync the personal-picks Google Form, then check for a submission
//      that's never been published yet — if one exists, that's today's
//      video (personal picks take priority over the automated rotation).
//   2. Otherwise, deterministically pick one (artist, source) pair from
//      the roster based on today's date.
// Either way, the result runs through the entire pipeline — resolve
// clips -> download -> render -> auto-approve -> publish — unattended,
// end to end.
//
// The automated rotation cycles through every (artist, source)
// combination before repeating, rather than fetching/rendering the whole
// roster every day — that would be the entire roster's worth of
// renders/downloads per day for a channel that only posts one video a
// day, almost all of it wasted.
//
// Auto-approve exists because the review-gate trigger normally requires
// a human review_decisions row before a post can be created — a
// deliberate choice here to run fully hands-off, not an oversight. If
// that ever needs to change, delete the autoApproveReadyVideos() call
// and let /review gate it like every other pipeline does.

import { loadArtistRoster } from "../config/artists.js";
import { fetchLastfmRankings } from "./fetch-lastfm-rankings.js";
import { fetchYoutubeRankings } from "./fetch-youtube-rankings.js";
import { syncPersonalRankings } from "./sync-personal-rankings.js";
import { resolveSongClips } from "./resolve-song-clips.js";
import { downloadSongClips } from "./download-song-clips.js";
import { generateIntroVo } from "./generate-intro-vo.js";
import { generateRankingRenderMetadata } from "./generate-ranking-render-metadata.js";
import { renderRankingVideos } from "./render-ranking-videos.js";
import { publishApprovedClips } from "./publish-post.js";
import { publishToTiktok } from "./publish-tiktok.js";
import { supabase } from "../lib/supabase.js";

function daysSinceEpoch(): number {
  return Math.floor(Date.now() / 86_400_000);
}

// "Not already used" = no ranking_video for this personal ranking has
// ever actually been published. Covers both a brand-new form submission
// (no ranking_video yet at all) and one that was rendered on a previous
// run but never made it to a published post for some reason (a failed
// publish attempt, an interrupted run, etc.) — either way it's fair game
// to pick up again rather than silently skipping it forever.
async function findUnusedPersonalRankingId(): Promise<string | null> {
  const { data: personalRankings, error } = await supabase
    .from("rankings")
    .select("id")
    .eq("source", "personal")
    .order("created_at", { ascending: true });
  if (error) throw error;

  for (const ranking of personalRankings ?? []) {
    const { data: videos, error: videosError } = await supabase
      .from("ranking_videos")
      .select("id")
      .eq("ranking_id", ranking.id);
    if (videosError) throw videosError;

    const videoIds = (videos ?? []).map((v) => v.id as string);
    if (videoIds.length === 0) return ranking.id as string; // never even rendered

    const { data: published, error: publishedError } = await supabase
      .from("posts")
      .select("id")
      .in("ranking_video_id", videoIds)
      .eq("status", "published");
    if (publishedError) throw publishedError;

    if ((published ?? []).length === 0) return ranking.id as string;
  }
  return null;
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
  // Personal picks take priority: sync whatever's in the form/sheet, then
  // see if any submission has never actually been published yet.
  await syncPersonalRankings();
  const unusedPersonalRankingId = await findUnusedPersonalRankingId();

  if (unusedPersonalRankingId) {
    console.log(`Today's pick: unused personal ranking ${unusedPersonalRankingId}`);
  } else {
    const roster = loadArtistRoster();
    if (roster.length === 0) throw new Error("artists.json is empty — add at least one artist");

    const pairIndex = daysSinceEpoch() % (roster.length * 2);
    const artistIndex = Math.floor(pairIndex / 2);
    const wantsYoutube = pairIndex % 2 === 1;
    const artist = roster[artistIndex];
    // Falls back to lastfm for an artist without a resolved YouTube
    // channel rather than skipping the day entirely — fetch-youtube-
    // rankings.ts will still try to resolve+cache one on its own turn.
    const source: "lastfm" | "youtube" = wantsYoutube ? "youtube" : "lastfm";

    console.log(`Today's pick: ${artist.name} (${source})`);

    if (source === "youtube") {
      await fetchYoutubeRankings([artist.name]);
    } else {
      await fetchLastfmRankings([artist.name]);
    }
  }

  await resolveSongClips();
  await downloadSongClips();
  await generateIntroVo();
  await generateRankingRenderMetadata();
  await renderRankingVideos();
  await autoApproveReadyVideos();
  const publishedCount = await publishApprovedClips({ limit: 1 });

  // TikTok tracks its own posted-state independently (posts.platform_account_id),
  // so this can post the SAME ranking_video that just went to YouTube
  // above — that's intentional cross-posting, not a duplicate-detection
  // gap. Caught separately from the YouTube call: TikTok's refresh_token
  // can rotate (see lib/tiktok.ts) with no automated way yet to persist
  // a rotated value back to the GitHub secret, so a stale-token failure
  // here is expected to happen eventually and shouldn't take down
  // today's otherwise-successful YouTube publish.
  let tiktokPublishedCount = 0;
  let tiktokError: unknown = null;
  try {
    tiktokPublishedCount = await publishToTiktok({ limit: 1 });
  } catch (err) {
    tiktokError = err;
    console.error("TikTok publish failed:", err instanceof Error ? err.message : err);
  }

  // A day that produces zero published videos on either platform means
  // something broke (a source API change, every clip download failing —
  // see the Calvin Harris / yt-dlp "Sign in to confirm you're not a bot"
  // incident this caught, or a rotated TikTok token) — throwing here
  // fails the GitHub Actions run, which triggers GitHub's own
  // run-failure email, instead of every step's own try/catch silently
  // swallowing the problem and this logging "complete" for a day that
  // actually published nothing on that platform.
  if (publishedCount === 0) {
    throw new Error("Daily pipeline produced zero published YouTube videos — see logs above for which step failed.");
  }
  if (tiktokPublishedCount === 0) {
    throw new Error(
      `Daily pipeline produced zero published TikTok videos${tiktokError ? `: ${tiktokError instanceof Error ? tiktokError.message : tiktokError}` : ""}`
    );
  }

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
