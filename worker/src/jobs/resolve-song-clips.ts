// For songs missing a youtube_video_id (Last.fm- or personal-sourced),
// finds the official video via YouTube search. For any song with a
// youtube_video_id but no song_clips row yet, computes a start/end
// window with a percentage-based heuristic (skip the intro and outro,
// take a window around where a chorus often lands) — crude but
// dependency-free. Swap in something smarter (chorus/heatmap detection)
// later if clip quality turns out to matter for retention.

import { searchOfficialVideo, getVideosInfo } from "../lib/youtube.js";
import { supabase } from "../lib/supabase.js";

// Always download the longer window (enough for the #1 reveal's extended
// display — see render-ranking-videos.ts's STANDARD_DISPLAY_SECONDS) and
// let the render step decide how much of it to actually show per
// ranking. A song's rank can differ across rankings it appears in (e.g.
// #1 on Last.fm but not on YouTube), and song_clips is shared/reused
// across all of them (one download per song, not per ranking) — so the
// "how long to display" decision has to live at render time, per
// ranking_item, not baked into the download itself.
//
// 11.5s (up from 9.5s) — TikTok's algorithm reportedly favors videos in
// the 61-65s range, so every song's on-screen display grew by 2s to
// land the total there (see STANDARD_DISPLAY_SECONDS). Only affects
// clips resolved from here on — existing cached song_clips keep their
// shorter downloaded window until whatever re-download flow reaches
// them (there isn't an automatic one).
const CLIP_WINDOW_SECONDS = 11.5;
const SKIP_INTRO_FRACTION = 0.3;
const SKIP_OUTRO_FRACTION = 0.15;

interface SongRow {
  id: string;
  title: string;
  youtube_video_id: string | null;
  artists: { name: string } | { name: string }[] | null;
}

function artistNameOf(song: SongRow): string {
  const a = song.artists;
  if (!a) return "";
  return Array.isArray(a) ? a[0]?.name ?? "" : a.name;
}

export async function resolveSongClips() {
  // Step 1: resolve any missing youtube_video_id via search.
  const { data: unresolvedSongs, error: unresolvedError } = await supabase
    .from("songs")
    .select("id, title, youtube_video_id, artists(name)")
    .is("youtube_video_id", null)
    .returns<SongRow[]>();
  if (unresolvedError) throw unresolvedError;

  for (const song of unresolvedSongs ?? []) {
    const query = `${artistNameOf(song)} ${song.title} official video`;
    const videoId = await searchOfficialVideo(query);
    if (!videoId) {
      console.warn(`no YouTube video found for "${query}"`);
      continue;
    }
    const { error } = await supabase.from("songs").update({ youtube_video_id: videoId }).eq("id", song.id);
    if (error) throw error;
    console.log(`resolved "${song.title}" -> ${videoId}`);
  }

  // Step 2: compute a clip window for any song with a video but no
  // song_clips row yet.
  const { data: allSongs, error: songsError } = await supabase
    .from("songs")
    .select("id, youtube_video_id")
    .not("youtube_video_id", "is", null);
  if (songsError) throw songsError;

  const { data: existingClips, error: clipsError } = await supabase.from("song_clips").select("song_id");
  if (clipsError) throw clipsError;
  const songsWithClips = new Set((existingClips ?? []).map((c) => c.song_id as string));

  const pending = (allSongs ?? []).filter((s) => !songsWithClips.has(s.id));
  console.log(`${pending.length} song(s) need a clip window`);

  // Batch duration lookups (videos.list allows 50 ids/call).
  const videoIds = [...new Set(pending.map((s) => s.youtube_video_id as string))];
  const videoInfos = await getVideosInfo(videoIds);
  const durationByVideoId = new Map(videoInfos.map((v) => [v.videoId, v.durationSeconds]));

  for (const song of pending) {
    const duration = durationByVideoId.get(song.youtube_video_id as string);
    if (!duration || duration <= 0) {
      console.warn(`no duration for song ${song.id} (video ${song.youtube_video_id}), skipping`);
      continue;
    }

    const start = Math.max(0, duration * SKIP_INTRO_FRACTION);
    const latestStart = duration * (1 - SKIP_OUTRO_FRACTION) - CLIP_WINDOW_SECONDS;
    const clampedStart = Math.min(start, Math.max(0, latestStart));
    const end = Math.min(duration, clampedStart + CLIP_WINDOW_SECONDS);

    const { error } = await supabase.from("song_clips").insert({
      song_id: song.id,
      youtube_video_id: song.youtube_video_id,
      start_seconds: clampedStart,
      end_seconds: end,
      selection_method: "percentage_heuristic",
      status: "pending",
    });
    if (error) throw error;
    console.log(`queued clip window for song ${song.id}: ${clampedStart.toFixed(1)}s-${end.toFixed(1)}s`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  resolveSongClips()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
