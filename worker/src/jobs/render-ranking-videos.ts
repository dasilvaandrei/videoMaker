// Renders each queued ranking_video's 5-song countdown via
// RankingCountdown, uploads the result, marks it ready. Mirrors the old
// render-clips.ts's optimistic-lock and per-item try/catch pattern, just
// aggregating 5 song_clips into one output instead of rendering one clip
// per row.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRankingCountdown, type AspectRatio } from "../remotion/render.js";
import { FOLLOW_POPUP_SECONDS, sponsorDurationInSeconds } from "../remotion/RankingCountdown.js";
import { probeDurationSeconds, trimToMaxDuration } from "../lib/ffmpeg.js";
import { SPONSORS } from "../config/sponsors.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
// Every song_clips download is the same length (see
// resolve-song-clips.ts) regardless of rank, since one download is
// reused across every ranking a song appears in. This is what actually
// varies the on-screen length per ranking: rank 1 in *this* ranking gets
// the full downloaded clip; every other rank is capped down to the
// standard length, even if the underlying clip has more available.
//
// 9.5s (up from 7.5s) — kept in sync with resolve-song-clips.ts's
// CLIP_WINDOW_SECONDS bump; see that file's comment for why (TikTok's
// 61-65s sweet spot). This pushes the total past YouTube Shorts' <60s
// limit, which is what youtubeTrimSeconds below is for.
const STANDARD_DISPLAY_SECONDS = 9.5;
// YouTube Shorts requires under 60s — rather than a second render
// pipeline, the master render (TikTok-length) gets ffmpeg-trimmed down
// to this ceiling for the YouTube-specific copy when it runs over. 59s,
// not 59.9s, for encode/rounding margin under the hard 60s cutoff.
const YOUTUBE_MAX_SECONDS = 59;
// Synthesized once (a two-tone chime, not a licensed sound), uploaded to
// this fixed path — every render just signs a fresh URL for the same file.
const RANK_DING_PATH = "sfx/rank-ding.mp3";
// Small, fixed library of "satisfying" B-roll loops for the intro's
// split-screen bottom half — see jobs/resolve-bg-loops.ts for how these
// were sourced (CC-licensed, not the same Content ID risk tradeoff as
// the artist clips) and how to refresh this list.
const BG_LOOP_PATHS = [
  "bg-loops/kinetic-sand.mp4",
  "bg-loops/3d-render-loop.mp4",
  "bg-loops/satisfying-loop.mp4",
  "bg-loops/minecraft-parkour.mp4",
  "bg-loops/gta5-megaramp.mp4",
];

// No on-screen badge for Last.fm — "LAST.FM" reads as unfamiliar jargon
// to a casual viewer (the source is named in the caption instead).
// "MOST VIEWED" is plain English, so it stays on-screen for YouTube.
const SOURCE_BADGE: Record<string, string> = {
  lastfm: "",
  youtube: "MOST VIEWED",
  personal: "MY PICKS",
};

// Kept in sync with generate-ranking-render-metadata.ts's caption text —
// automated rankings only see songs primarily credited to the artist, so
// a feature/collab hit (credited to a producer/other artist) never
// appears even if it's their biggest song. See that file for the full
// rationale.
const FEATURE_DISCLAIMER = "Primary artist credit only";

interface QueuedVideo {
  id: string;
  ranking_id: string;
  aspect_ratio: AspectRatio;
  sponsor_name: string | null;
}

// Floor so a very long sponsor VO can't shrink rank 3 into an
// unwatchably brief flash — if that ever actually triggers, the
// sponsor's script is too long and should be rewritten shorter instead.
const MIN_RANK_3_SECONDS = 5;

interface ClipJoin {
  storage_path: string | null;
  start_seconds: number;
  end_seconds: number;
}

interface SongJoin {
  title: string;
  song_clips: ClipJoin | ClipJoin[] | null;
}

interface RankingItemRow {
  rank: number;
  metric_label: string | null;
  note: string | null;
  songs: SongJoin | SongJoin[] | null;
}

interface RankingRow {
  source: string;
  intro_script: string | null;
  intro_on_screen_text: string | null;
  intro_vo_storage_path: string | null;
  intro_vo_duration_seconds: number | null;
  artists: { name: string; avatar_url: string | null } | { name: string; avatar_url: string | null }[] | null;
}

function oneOf<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

// The render pipeline now runs fully unattended (see run-daily-pipeline.ts)
// — nobody's watching to manually retry a one-off network hiccup fetching
// a signed Storage URL through Remotion's local proxy (hit this for real
// once already). One retry after a short pause covers that without
// masking a genuinely broken render (which will just fail again).
async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`attempt ${i + 1}/${attempts} failed, retrying:`, err instanceof Error ? err.message : err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  throw lastErr;
}

export async function renderRankingVideos() {
  const { data: videos, error } = await supabase
    .from("ranking_videos")
    .select("id, ranking_id, aspect_ratio, sponsor_name")
    .eq("render_status", "queued")
    .returns<QueuedVideo[]>();
  if (error) throw error;

  console.log(`${videos?.length ?? 0} ranking_videos queued`);

  for (const video of videos ?? []) {
    // Optimistic lock: only proceed if still queued (guards against a
    // second concurrent worker process picking up the same row).
    await supabase
      .from("ranking_videos")
      .update({ render_status: "rendering" })
      .eq("id", video.id)
      .eq("render_status", "queued");

    const dir = await mkdtemp(join(tmpdir(), "ranking-render-"));
    const outputPath = join(dir, "output.mp4");

    try {
      const { data: ranking, error: rankingError } = await supabase
        .from("rankings")
        .select(
          "source, intro_script, intro_on_screen_text, intro_vo_storage_path, intro_vo_duration_seconds, artists(name, avatar_url)"
        )
        .eq("id", video.ranking_id)
        .single<RankingRow>();
      if (rankingError) throw rankingError;

      let introVoSignedUrl: string | null = null;
      if (ranking.intro_vo_storage_path) {
        const { data: introSigned, error: introSignError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(ranking.intro_vo_storage_path, SIGNED_URL_TTL_SECONDS);
        if (introSignError) throw introSignError;
        introVoSignedUrl = introSigned.signedUrl;
      }

      const bgLoopPath = BG_LOOP_PATHS[Math.floor(Math.random() * BG_LOOP_PATHS.length)];
      const { data: bgLoopSigned, error: bgLoopSignError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(bgLoopPath, SIGNED_URL_TTL_SECONDS);
      if (bgLoopSignError) throw bgLoopSignError;

      // Sponsor segment (see config/sponsors.ts) — video.sponsor_name was
      // decided back in generate-ranking-render-metadata.ts (has to match
      // whatever the caption's disclosure/affiliate link already say), so
      // this just looks up and signs that sponsor's assets, it doesn't
      // pick one. A different, separately-random bg-loop pick than the
      // intro's, purely for visual variety between the two segments.
      const sponsor = video.sponsor_name ? SPONSORS.find((s) => s.name === video.sponsor_name) ?? null : null;
      let sponsorVoSignedUrl: string | null = null;
      let sponsorAssetSignedUrl: string | null = null;
      let sponsorBgLoopSignedUrl: string | null = null;
      let sponsorSeconds = 0;
      if (sponsor?.voStoragePath && sponsor.assetStoragePath) {
        const { data: voSigned, error: voSignError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(sponsor.voStoragePath, SIGNED_URL_TTL_SECONDS);
        if (voSignError) throw voSignError;
        sponsorVoSignedUrl = voSigned.signedUrl;

        const { data: assetSigned, error: assetSignError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(sponsor.assetStoragePath, SIGNED_URL_TTL_SECONDS);
        if (assetSignError) throw assetSignError;
        sponsorAssetSignedUrl = assetSigned.signedUrl;

        const sponsorBgLoopPath = BG_LOOP_PATHS[Math.floor(Math.random() * BG_LOOP_PATHS.length)];
        const { data: sponsorBgLoopSigned, error: sponsorBgLoopSignError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(sponsorBgLoopPath, SIGNED_URL_TTL_SECONDS);
        if (sponsorBgLoopSignError) throw sponsorBgLoopSignError;
        sponsorBgLoopSignedUrl = sponsorBgLoopSigned.signedUrl;

        sponsorSeconds = sponsorDurationInSeconds(sponsor.voDurationSeconds ?? 0);
      }

      const { data: items, error: itemsError } = await supabase
        .from("ranking_items")
        .select("rank, metric_label, note, songs(title, song_clips(storage_path, start_seconds, end_seconds))")
        .eq("ranking_id", video.ranking_id)
        .order("rank", { ascending: false }) // play 5 -> 1
        .returns<RankingItemRow[]>();
      if (itemsError) throw itemsError;
      if (!items || items.length < 5) {
        throw new Error(`ranking ${video.ranking_id} has ${items?.length ?? 0} items, need 5`);
      }

      const { data: sfxSigned, error: sfxSignError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(RANK_DING_PATH, SIGNED_URL_TTL_SECONDS);
      if (sfxSignError) throw sfxSignError;

      const segments = await Promise.all(
        items.map(async (item) => {
          const song = oneOf(item.songs);
          const clip = song ? oneOf(song.song_clips) : null;
          if (!clip?.storage_path) throw new Error(`rank ${item.rank} song has no downloaded clip`);

          const { data: signed, error: signError } = await supabase.storage
            .from(MEDIA_BUCKET)
            .createSignedUrl(clip.storage_path, SIGNED_URL_TTL_SECONDS);
          if (signError) throw signError;

          const fullClipDuration = clip.end_seconds - clip.start_seconds;
          // Rank 2 gets a bit more than the standard length too — that
          // extra stretch is what the follow-popup overlays on top of
          // (see RankingCountdown.tsx), so the popup has real audio
          // playing under it instead of cutting to silence.
          //
          // Rank 3 (the segment right after the sponsor spot) shrinks by
          // the sponsor segment's own length when one's included — this
          // is what keeps the total in TikTok's 61-65s target even with
          // the extra segment, rather than just letting the video run
          // longer. Floored at MIN_RANK_3_SECONDS so an unusually long
          // sponsor VO can't compress it into an unwatchable flash.
          const targetSeconds =
            item.rank === 1
              ? fullClipDuration
              : item.rank === 2
                ? STANDARD_DISPLAY_SECONDS + FOLLOW_POPUP_SECONDS
                : item.rank === 3 && sponsorSeconds > 0
                  ? Math.max(MIN_RANK_3_SECONDS, STANDARD_DISPLAY_SECONDS - sponsorSeconds)
                  : STANDARD_DISPLAY_SECONDS;
          const durationInSeconds = Math.min(fullClipDuration, targetSeconds);

          // Last.fm's playcount only reflects its own small scrobbling
          // user base, not real-world stream totals — showing the raw
          // number on-screen reads as absurdly low for a genuine hit.
          // YouTube's view count is a real, verifiable total, so it
          // stays. The number is still recorded in ranking_items for
          // reference; this only suppresses the on-screen display.
          const metricLabel = ranking.source === "lastfm" ? null : item.metric_label ?? item.note ?? null;

          return {
            videoSrc: signed.signedUrl,
            rank: item.rank,
            songTitle: song?.title ?? "",
            metricLabel,
            durationInSeconds,
          };
        })
      );

      const artist = oneOf(ranking.artists);
      const artistName = artist?.name ?? "";

      // artists.avatar_url is our own Storage path (see generate-intro-vo.ts
      // for why the raw YouTube CDN URL isn't hotlinked directly into the
      // render), so it needs signing like every other asset here.
      let introAvatarSignedUrl: string | null = null;
      if (artist?.avatar_url) {
        const { data: avatarSigned, error: avatarSignError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(artist.avatar_url, SIGNED_URL_TTL_SECONDS);
        if (avatarSignError) throw avatarSignError;
        introAvatarSignedUrl = avatarSigned.signedUrl;
      }

      await withRetry(() =>
        renderRankingCountdown(
          video.aspect_ratio,
          {
            artistName,
            sourceBadge: SOURCE_BADGE[ranking.source] ?? ranking.source.toUpperCase(),
            // null, not undefined — Remotion's inputProps get JSON-serialized
            // to reach the render process, and `undefined` fields are
            // dropped in that process, which makes the key look "missing"
            // rather than explicitly empty. Remotion then silently fills
            // missing keys back in from the Composition's defaultProps
            // (Root.tsx), which is exactly how a stale placeholder
            // disclaimer leaked onto a real personal-ranking video once
            // already. null survives JSON and reads as falsy in the
            // Header's {disclaimer && ...} check, so it actually suppresses.
            disclaimer: ranking.source === "personal" ? null : FEATURE_DISCLAIMER,
            sfxSrc: sfxSigned.signedUrl,
            introText: ranking.intro_on_screen_text,
            introVoSrc: introVoSignedUrl,
            introDurationInSeconds: ranking.intro_vo_duration_seconds,
            introAvatarUrl: introAvatarSignedUrl,
            introBgLoopSrc: bgLoopSigned.signedUrl,
            sponsorName: sponsorVoSignedUrl ? sponsor?.name ?? null : null,
            sponsorAffiliateUrl: sponsor?.affiliateUrl ?? null,
            sponsorVoSrc: sponsorVoSignedUrl,
            sponsorVoDurationSeconds: sponsor?.voDurationSeconds ?? null,
            sponsorAssetUrl: sponsorAssetSignedUrl,
            sponsorAssetType: sponsor?.assetType ?? null,
            sponsorBgLoopSrc: sponsorBgLoopSignedUrl,
            segments,
          },
          outputPath
        )
      );

      const objectPath = `renders/${video.id}.mp4`;
      const fileBuffer = await readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      // The master render targets TikTok's 61-65s sweet spot, which runs
      // over YouTube Shorts' <60s limit — rather than a second render
      // pipeline, ffmpeg-trim a YouTube-specific copy off the same
      // master when that happens. null (not a duplicate upload) when the
      // master already fits, which publish-post.ts's storage_path
      // fallback handles.
      let youtubeObjectPath: string | null = null;
      const masterDurationSeconds = await probeDurationSeconds(outputPath);
      if (masterDurationSeconds != null && masterDurationSeconds > YOUTUBE_MAX_SECONDS) {
        const trimmedPath = join(dir, "output-youtube.mp4");
        await trimToMaxDuration(outputPath, trimmedPath, YOUTUBE_MAX_SECONDS);
        youtubeObjectPath = `renders/${video.id}-youtube.mp4`;
        const trimmedBuffer = await readFile(trimmedPath);
        const { error: youtubeUploadError } = await supabase.storage
          .from(MEDIA_BUCKET)
          .upload(youtubeObjectPath, trimmedBuffer, { contentType: "video/mp4", upsert: true });
        if (youtubeUploadError) throw youtubeUploadError;
      }

      const { error: readyError } = await supabase
        .from("ranking_videos")
        .update({ storage_path: objectPath, youtube_storage_path: youtubeObjectPath, render_status: "ready" })
        .eq("id", video.id);
      if (readyError) throw readyError;

      console.log(`rendered ${video.id} -> ${objectPath}`);
    } catch (err) {
      // One bad render should never take down the rest of the batch.
      console.error(`render ${video.id} failed:`, err instanceof Error ? err.message : err);
      await supabase.from("ranking_videos").update({ render_status: "failed" }).eq("id", video.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderRankingVideos()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
