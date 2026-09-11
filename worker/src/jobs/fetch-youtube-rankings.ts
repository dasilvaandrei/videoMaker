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
import { getChannelVideoIds, getVideosInfo } from "../lib/youtube.js";
import { supabase } from "../lib/supabase.js";

const EXCLUDED_TITLE_PATTERN = /\b(interview|reaction|live stream|livestream|shorts|behind the scenes)\b/i;
const MIN_DURATION_SECONDS = 60; // filters out YouTube Shorts

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

// See fetch-lastfm-rankings.ts's onlyArtistNames for why this exists.
export async function fetchYoutubeRankings(onlyArtistNames?: string[]) {
  const roster = loadArtistRoster().filter(
    (a) => a.youtubeChannelId && (!onlyArtistNames || onlyArtistNames.includes(a.name))
  );
  const periodLabel = todayLabel();

  for (const artistConfig of roster) {
    const { data: artist, error: artistError } = await supabase
      .from("artists")
      .upsert(
        { name: artistConfig.name, youtube_channel_id: artistConfig.youtubeChannelId },
        { onConflict: "name" }
      )
      .select("id")
      .single();
    if (artistError) throw artistError;

    const videoIds = await getChannelVideoIds(artistConfig.youtubeChannelId!, 50);
    const videos = await getVideosInfo(videoIds);
    const top5 = videos
      .filter((v) => v.durationSeconds >= MIN_DURATION_SECONDS && !EXCLUDED_TITLE_PATTERN.test(v.title))
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 5);

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
