// Single entry point for the cron, which now fires 4x/day (see
// daily-pipeline.yml). Each run:
//   1. Sync the personal-picks Google Form, then check for a submission
//      that's never been published yet — if one exists, that's this
//      run's video (personal picks take priority over the automated
//      rotation).
//   2. Otherwise, deterministically pick one (artist, source) pair from
//      the roster based on the current 6-hour period — see
//      rotationPeriodsSinceEpoch() below. One pair per period (not per
//      day) so each of the 4 daily runs renders a genuinely new video
//      instead of the 2nd-4th run of the day finding nothing new queued
//      and just draining the publish backlog (which would eventually
//      run dry and start failing the "zero published" check below).
// Either way, the result runs through the entire pipeline — resolve
// clips -> download -> render -> auto-approve -> publish — unattended,
// end to end.
//
// The automated rotation cycles through every (artist, source)
// combination before repeating, rather than fetching/rendering the whole
// roster every period — that would be the entire roster's worth of
// renders/downloads per period for a channel that only posts one video
// per period, almost all of it wasted. The roster (15k+ artists) is
// large enough that even at 4 picks/day this doesn't meaningfully
// shorten how often a given artist repeats.
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
import { publishToTiktokInbox } from "./publish-tiktok-inbox.js";
import { supabase } from "../lib/supabase.js";

// 6 hours, matching daily-pipeline.yml's 4x/day cron spacing — one
// rotation step per scheduled run, not per calendar day.
const ROTATION_PERIOD_MS = 6 * 60 * 60 * 1000;

function rotationPeriodsSinceEpoch(): number {
  return Math.floor(Date.now() / ROTATION_PERIOD_MS);
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

    const pairIndex = rotationPeriodsSinceEpoch() % (roster.length * 2);
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

  // Sends to the TikTok inbox as a draft rather than posting live —
  // Direct Post (video.publish) is currently hard-blocked for this
  // unaudited app (confirmed in production:
  // "unaudited_client_can_only_post_to_private_accounts", even when
  // explicitly requesting SELF_ONLY), so this is the reliable fallback
  // until TikTok's app review approves it. See publish-tiktok-inbox.ts's
  // header for the manual tap-to-post step this still requires.
  //
  // TikTok tracks its own posted-state independently (posts.platform_account_id),
  // so this can send the SAME ranking_video that just went to YouTube
  // above — that's intentional cross-posting, not a duplicate-detection
  // gap. Caught separately from the YouTube call: TikTok's refresh_token
  // can rotate (see lib/tiktok.ts) with no automated way yet to persist
  // a rotated value back to the GitHub secret, so a stale-token failure
  // here is expected to happen eventually and shouldn't take down
  // today's otherwise-successful YouTube publish.
  let tiktokSentCount = 0;
  let tiktokError: unknown = null;
  try {
    tiktokSentCount = await publishToTiktokInbox({ limit: 1 });
  } catch (err) {
    tiktokError = err;
    console.error("TikTok inbox send failed:", err instanceof Error ? err.message : err);
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
  if (tiktokSentCount === 0) {
    throw new Error(
      `Daily pipeline sent zero videos to the TikTok inbox${tiktokError ? `: ${tiktokError instanceof Error ? tiktokError.message : tiktokError}` : ""}`
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
