// Single entry point for the cron, which now fires 8x/day (see
// daily-pipeline.yml). Each run:
//   1. Sync the personal-picks Google Form, then check for a submission
//      that's never been published yet — if one exists, that's this
//      run's video (personal picks take priority over the automated
//      rotation).
//   2. Otherwise, deterministically pick one (artist, source) pair from
//      the roster based on the current 3-hour period — see
//      rotationPeriodsSinceEpoch() below. One pair per period (not per
//      day) so each daily run renders a genuinely new video
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
import { cleanupPublishedStorage } from "./cleanup-published-storage.js";
import { supabase } from "../lib/supabase.js";

// 3 hours, matching daily-pipeline.yml's 8x/day cron spacing — one
// rotation step per scheduled run, not per calendar day. GitHub often
// starts scheduled runs hours late, so two runs can land in the same
// period; pickRotationPair() steps past a pair that already ran today.
const ROTATION_PERIOD_MS = 3 * 60 * 60 * 1000;

// Each YouTube upload costs 1,600 of the API's 10,000 daily quota units,
// so 6 is the most that fits alongside each run's other calls. The
// workflow is scheduled 8x/day because GitHub routinely skips scheduled
// runs; once this many have gone out in the last 24 hours, the remaining
// runs exit without doing anything.
const MAX_UPLOADS_PER_DAY = 6;

function rotationPeriodsSinceEpoch(): number {
  return Math.floor(Date.now() / ROTATION_PERIOD_MS);
}

async function countYoutubeUploadsLast24h(): Promise<number> {
  const { data: platform, error: platformError } = await supabase
    .from("platforms")
    .select("id")
    .eq("name", "youtube")
    .single();
  if (platformError) throw platformError;

  const { data: accounts, error: accountsError } = await supabase
    .from("platform_accounts")
    .select("id")
    .eq("platform_id", platform.id);
  if (accountsError) throw accountsError;
  const accountIds = (accounts ?? []).map((a) => a.id as string);
  if (accountIds.length === 0) return 0;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("posts")
    .select("id", { count: "exact", head: true })
    .in("platform_account_id", accountIds)
    .eq("status", "published")
    .gte("published_at", since);
  if (error) throw error;
  return count ?? 0;
}

async function rankingExistsToday(artistName: string, source: "lastfm" | "youtube"): Promise<boolean> {
  const { data: artist, error: artistError } = await supabase
    .from("artists")
    .select("id")
    .eq("name", artistName)
    .maybeSingle();
  if (artistError) throw artistError;
  if (!artist) return false;

  const { data: ranking, error } = await supabase
    .from("rankings")
    .select("id")
    .eq("artist_id", artist.id)
    .eq("source", source)
    .eq("period_label", new Date().toISOString().slice(0, 10))
    .maybeSingle();
  if (error) throw error;
  return ranking !== null;
}

// The rotation pair for this period, or the next one that hasn't already
// run today (when a delayed run and an on-time run share a period).
async function pickRotationPair<T extends { name: string }>(
  roster: T[]
): Promise<{ artistIndex: number; artist: T; source: "lastfm" | "youtube" }> {
  const base = rotationPeriodsSinceEpoch();
  for (let step = 0; ; step++) {
    const pairIndex = (base + step) % (roster.length * 2);
    const artistIndex = Math.floor(pairIndex / 2);
    const source = pairIndex % 2 === 1 ? "youtube" : "lastfm";
    const artist = roster[artistIndex];
    if (step >= 10 || !(await rankingExistsToday(artist.name, source))) {
      return { artistIndex, artist, source };
    }
    console.log(`${artist.name} (${source}) already ran today — trying the next pick`);
  }
}

// artists.json is built genre-tag by genre-tag (see
// expand-artist-roster.ts) — every jazz artist landed in one contiguous
// block, then every house artist, etc. Indexing straight into that file
// order meant the rotation spent weeks grinding through one genre block
// before ever reaching the next (jazz alone was ~100 artists, i.e.
// ~50 days of nothing but jazz at 2 artists/day). A fixed-seed shuffle
// still visits every artist exactly once per full cycle before repeating
// (same fairness as before, same no-persisted-state determinism — same
// roster file always shuffles to the same order), it just stops the
// order from tracking genre-tag blocks.
function seededShuffle<T>(items: T[], seed: number): T[] {
  // mulberry32 — small, deterministic, good enough for "break up genre
  // clustering," not a security- or statistics-sensitive use.
  let state = seed;
  function next(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// A ranking whose song_clips include even one permanently 'failed' entry
// can never reach render_status='ready' — generate-intro-vo.ts and
// generate-ranking-render-metadata.ts both gate on *all* items being
// 'downloaded', and download-song-clips.ts only ever retries clips still
// in 'pending' (a 'failed' one is a dead end, not a queue). Discovered
// live: 2026-09-18, two personal rankings back-to-back (Paulo Londra,
// Sebastian Yatra) both had all 5 clips fail on the same run (likely a
// transient yt-dlp bot-detection block) and, since findUnusedPersonalRankingId
// always returns the oldest unused personal ranking first with no escape
// hatch, permanently wedged the entire pipeline — every run, of any
// cadence, kept re-picking the same stuck ranking and publishing zero
// videos. Filtering these out here just skips to the next personal
// ranking (or falls through to the automated rotation) instead.
async function hasUnrecoverableClipFailure(rankingId: string): Promise<boolean> {
  const { data: items, error } = await supabase
    .from("ranking_items")
    .select("songs(song_clips(status))")
    .eq("ranking_id", rankingId)
    .returns<{ songs: { song_clips: { status: string } | { status: string }[] | null } | null }[]>();
  if (error) throw error;

  return (items ?? []).some((item) => {
    const clip = item.songs
      ? Array.isArray(item.songs.song_clips)
        ? item.songs.song_clips[0]
        : item.songs.song_clips
      : null;
    return clip?.status === "failed";
  });
}

// "Not already used" = no ranking_video for this personal ranking has
// ever actually been published. Covers both a brand-new form submission
// (no ranking_video yet at all) and one that was rendered on a previous
// run but never made it to a published post for some reason (a failed
// publish attempt, an interrupted run, etc.) — either way it's fair game
// to pick up again rather than silently skipping it forever. Skips (does
// not return) a ranking that can never progress due to a permanently
// failed clip — see hasUnrecoverableClipFailure above.
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
    if (videoIds.length === 0) {
      if (await hasUnrecoverableClipFailure(ranking.id as string)) continue;
      return ranking.id as string; // never even rendered
    }

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
  // Only videos that still have a file — posted ones get their storage
  // cleared, so this stays a handful of rows instead of every video ever
  // rendered (which would eventually hit PostgREST's 1000-row cap).
  const { data: ready, error } = await supabase
    .from("ranking_videos")
    .select("id")
    .eq("render_status", "ready")
    .not("storage_path", "is", null);
  if (error) throw error;
  const readyIds = (ready ?? []).map((v) => v.id as string);
  if (readyIds.length === 0) return;

  const { data: decided, error: decidedError } = await supabase
    .from("review_decisions")
    .select("ranking_video_id")
    .in("ranking_video_id", readyIds);
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
  const uploadsToday = await countYoutubeUploadsLast24h();
  if (uploadsToday >= MAX_UPLOADS_PER_DAY) {
    console.log(`${uploadsToday} YouTube uploads in the last 24h (cap ${MAX_UPLOADS_PER_DAY}) — skipping this run.`);
    return;
  }

  // Personal picks take priority: sync whatever's in the form/sheet, then
  // see if any submission has never actually been published yet.
  await syncPersonalRankings();
  const unusedPersonalRankingId = await findUnusedPersonalRankingId();

  if (unusedPersonalRankingId) {
    console.log(`Today's pick: unused personal ranking ${unusedPersonalRankingId}`);
  } else {
    const roster = seededShuffle(loadArtistRoster(), 0x5eed);
    if (roster.length === 0) throw new Error("artists.json is empty — add at least one artist");

    const { artistIndex, artist, source } = await pickRotationPair(roster);

    console.log(`Today's pick: ${artist.name} (${source})`);

    if (source === "youtube") {
      const queued = await fetchYoutubeRankings([artist.name]);
      if (queued === 0) {
        // No official channel (common for older or underground artists) or
        // too few eligible videos. Falling back to this same artist's
        // Last.fm ranking would do nothing: its Last.fm turn ran in the
        // previous slot, almost always the same UTC day, so that ranking (and
        // its video) already exists. Use an artist half the roster away
        // instead — their own turns are far off, so no collision.
        const fallback = roster[(artistIndex + Math.floor(roster.length / 2)) % roster.length];
        console.log(`${artist.name}: no usable YouTube channel — falling back to ${fallback.name} (lastfm)`);
        await fetchLastfmRankings([fallback.name]);
      }
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

  // Delete what was just posted (and anything else already on YouTube) so
  // storage never builds back up to the quota — see
  // cleanup-published-storage.ts. Runs after both uploads since TikTok
  // reads the same file. Failure is reported below rather than thrown here
  // so it can't hide a publish failure.
  let cleanupError: unknown = null;
  try {
    await cleanupPublishedStorage();
  } catch (err) {
    cleanupError = err;
    console.error("Storage cleanup failed:", err instanceof Error ? err.message : err);
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
  if (cleanupError) {
    throw new Error(
      `Storage cleanup failed after publishing: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`
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
