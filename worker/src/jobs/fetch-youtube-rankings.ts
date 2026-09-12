// Once per day: ranks each roster artist's official YouTube uploads by
// view count and turns the top 5 into a rankings row. Since the source
// *is* YouTube, each song's youtube_video_id is already known — no
// separate clip-resolution search needed for this source.
//
// Known limitation: this ranks *uploads*, not "songs" specifically — a
// channel's interview/live-stream/Shorts uploads can outrank an actual
// music video. The filter below is a coarse first pass; revisit if
// non-song content keeps showing up in generated rankings.

import { loadArtistRoster } from "../config/artists.js";
import { getChannelVideoIds, getVideosInfo, searchOfficialChannel } from "../lib/youtube.js";
import { dedupeByNormalizedTitle } from "../lib/songTitle.js";
import { supabase } from "../lib/supabase.js";

const EXCLUDED_TITLE_PATTERN = /\b(interview|reaction|live stream|livestream|shorts|behind the scenes)\b/i;
const MIN_DURATION_SECONDS = 60; // filters out YouTube Shorts

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

// See fetch-lastfm-rankings.ts's onlyArtistNames for why this exists.
export async function fetchYoutubeRankings(onlyArtistNames?: string[]) {
  const roster = loadArtistRoster().filter((a) => !onlyArtistNames || onlyArtistNames.includes(a.name));
  const periodLabel = todayLabel();

  for (const artistConfig of roster) {
    // Upsert with just the name — if a channel id was already resolved
    // (either hand-verified in config, or cached here on a previous run),
    // the select below reads it back from the existing row untouched.
    const { data: artist, error: artistError } = await supabase
      .from("artists")
      .upsert({ name: artistConfig.name }, { onConflict: "name" })
      .select("id, youtube_channel_id")
      .single();
    if (artistError) throw artistError;

    let channelId = artistConfig.youtubeChannelId || artist.youtube_channel_id;
    if (!channelId) {
      // Most of the roster (see jobs/expand-artist-roster.ts) has no
      // pre-verified channel — resolve it live and cache the result so
      // this search only ever runs once per artist, not once per day.
      channelId = await searchOfficialChannel(artistConfig.name);
      if (!channelId) {
        console.warn(`${artistConfig.name}: no YouTube channel found, skipping`);
        continue;
      }
      const { error: cacheError } = await supabase
        .from("artists")
        .update({ youtube_channel_id: channelId })
        .eq("id", artist.id);
      if (cacheError) throw cacheError;
    }

    const videoIds = await getChannelVideoIds(channelId, 50);
    const videos = await getVideosInfo(videoIds);
    const eligible = videos
      .filter((v) => v.durationSeconds >= MIN_DURATION_SECONDS && !EXCLUDED_TITLE_PATTERN.test(v.title))
      .sort((a, b) => b.viewCount - a.viewCount);
    // A channel often uploads the same song multiple times (official
    // video, visualiser, official audio) — dedupe by normalized title so
    // a ranking doesn't show the same song's clip twice under different
    // upload labels.
    const top5 = dedupeByNormalizedTitle(eligible, (v) => v.title).slice(0, 5);

    if (top5.length < 5) {
      console.warn(`${artistConfig.name}: only ${top5.length} eligible YouTube videos found, skipping`);
      continue;
    }

    const { data: ranking, error: rankingError } = await supabase
      .from("rankings")
      .upsert(
        { artist_id: artist.id, source: "youtube", period_label: periodLabel },
        { onConflict: "artist_id,source,period_label" }
      )
      .select("id")
      .single();
    if (rankingError) throw rankingError;

    for (const [index, video] of top5.entries()) {
      const { data: song, error: songError } = await supabase
        .from("songs")
        .upsert(
          {
            artist_id: artist.id,
            title: video.title,
            youtube_video_id: video.videoId,
            duration_seconds: video.durationSeconds,
          },
          { onConflict: "artist_id,title" }
        )
        .select("id")
        .single();
      if (songError) throw songError;

      const { error: itemError } = await supabase.from("ranking_items").upsert(
        {
          ranking_id: ranking.id,
          song_id: song.id,
          rank: index + 1,
          metric_label: `${video.viewCount.toLocaleString()} views`,
          metric_value: video.viewCount,
        },
        { onConflict: "ranking_id,rank" }
      );
      if (itemError) throw itemError;
    }

    console.log(`${artistConfig.name}: queued YouTube ranking ${ranking.id} (${periodLabel})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchYoutubeRankings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
