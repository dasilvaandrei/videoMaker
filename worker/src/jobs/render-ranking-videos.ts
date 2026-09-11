// Renders each queued ranking_video's 5-song countdown via
// RankingCountdown, uploads the result, marks it ready. Mirrors the old
// render-clips.ts's optimistic-lock and per-item try/catch pattern, just
// aggregating 5 song_clips into one output instead of rendering one clip
// per row.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRankingCountdown, type AspectRatio } from "../remotion/render.js";
import { FOLLOW_POPUP_SECONDS } from "../remotion/RankingCountdown.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;
// Every song_clips download is the same length (see
// resolve-song-clips.ts) regardless of rank, since one download is
// reused across every ranking a song appears in. This is what actually
// varies the on-screen length per ranking: rank 1 in *this* ranking gets
// the full downloaded clip; every other rank is capped down to the
// standard length, even if the underlying clip has more available.
const STANDARD_DISPLAY_SECONDS = 7.5;
// Synthesized once (a two-tone chime, not a licensed sound), uploaded to
// this fixed path — every render just signs a fresh URL for the same file.
const RANK_DING_PATH = "sfx/rank-ding.mp3";

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
}

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
  artists: { name: string } | { name: string }[] | null;
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
    .select("id, ranking_id, aspect_ratio")
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
        .select("source, artists(name)")
        .eq("id", video.ranking_id)
        .single<RankingRow>();
      if (rankingError) throw rankingError;

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
          const targetSeconds =
            item.rank === 1
              ? fullClipDuration
              : item.rank === 2
                ? STANDARD_DISPLAY_SECONDS + FOLLOW_POPUP_SECONDS
                : STANDARD_DISPLAY_SECONDS;
          const durationInSeconds = Math.min(fullClipDuration, targetSeconds);

          return {
            videoSrc: signed.signedUrl,
            rank: item.rank,
            songTitle: song?.title ?? "",
            metricLabel: item.metric_label ?? item.note ?? null,
            durationInSeconds,
          };
        })
      );

      const artistName = oneOf(ranking.artists)?.name ?? "";

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

      const { error: readyError } = await supabase
        .from("ranking_videos")
        .update({ storage_path: objectPath, render_status: "ready" })
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
