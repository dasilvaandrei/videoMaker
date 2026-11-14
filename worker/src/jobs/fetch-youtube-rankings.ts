// Ranks an artist's official YouTube videos by view count and turns the
// top 5 into a rankings row. "Official" means the artist's own channel
// plus their videos on known label channels (see the candidate step
// below). Since the source *is* YouTube, each song's youtube_video_id is
// already known — no separate clip-resolution search needed.
//
// Known limitation: this ranks *uploads*, not "songs" specifically — a
// channel's interview/live-stream/Shorts uploads can outrank an actual
// music video. The filter below is a coarse first pass; revisit if
// non-song content keeps showing up in generated rankings.

import { loadArtistRoster } from "../config/artists.js";
import {
  getChannelVideoIds,
  getVideosInfo,
  searchMostViewedVideos,
  searchOfficialChannel,
  titleCreditsArtist,
} from "../lib/youtube.js";
import { dedupeByNormalizedTitle } from "../lib/songTitle.js";
import { supabase } from "../lib/supabase.js";
import { OFFICIAL_LABEL_CHANNELS } from "../config/officialLabelChannels.js";

const LABEL_CHANNEL_IDS = new Set(OFFICIAL_LABEL_CHANNELS.map((c) => c.id));

const EXCLUDED_TITLE_PATTERN = /\b(interview|reaction|live stream|livestream|shorts|behind the scenes)\b/i;
const MIN_DURATION_SECONDS = 60; // filters out YouTube Shorts
// Full-album and full-concert uploads (e.g. Pink Floyd's "The Dark Side Of
// The Moon (50th Anniversary)", ~43 min) aren't songs. 25 minutes still
// lets genuinely long songs through (Pink Floyd's "Echoes" is ~23 min).
const MAX_DURATION_SECONDS = 25 * 60;
// Scans this many of the channel's most recent uploads. Was 50, then
// 1000 — still too few for prolific channels: @pinkfloyd has ~1,350
// uploads, and 9 of its 10 most-viewed videos were older than the newest
// 1000. Costs ~2 quota units per 50 uploads.
const MAX_UPLOADS_SCANNED = 5000;

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

// See fetch-lastfm-rankings.ts's onlyArtistNames for why this exists.
// Returns how many rankings were queued — 0 when an artist has no official
// channel or too few eligible videos, so the caller can fall back to
// Last.fm.
export async function fetchYoutubeRankings(onlyArtistNames?: string[]): Promise<number> {
  let queued = 0;
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
      if (channelId) {
        const { error: cacheError } = await supabase
          .from("artists")
          .update({ youtube_channel_id: channelId })
          .eq("id", artist.id);
        if (cacheError) throw cacheError;
      }
    }

    // Candidates: the artist's own uploads, plus their videos on official
    // label channels (config/officialLabelChannels.ts) — many artists'
    // biggest MVs live there, e.g. Jin's on HYBE LABELS. A label video must
    // be credited to the artist in its title (see titleCreditsArtist),
    // since labels upload many artists. Videos from any other channel (fan
    // re-uploads, lyric channels) are ignored. With no channel of their
    // own, label videos alone can still make a ranking.
    const candidateIds = new Set<string>(channelId ? await getChannelVideoIds(channelId, MAX_UPLOADS_SCANNED) : []);
    try {
      for (const hit of await searchMostViewedVideos(artistConfig.name)) {
        if (LABEL_CHANNEL_IDS.has(hit.channelId) && titleCreditsArtist(hit.title, artistConfig.name)) {
          candidateIds.add(hit.videoId);
        }
      }
    } catch (err) {
      // YouTube caps searches at 100/day per project, separately from the
      // unit quota. Rank from the artist's own channel rather than fail.
      console.warn(`${artistConfig.name}: label-channel search failed, using own channel only:`, err instanceof Error ? err.message : err);
    }
    if (candidateIds.size === 0) {
      console.warn(`${artistConfig.name}: no official channel or label videos found, skipping`);
      continue;
    }

    const videos = await getVideosInfo([...candidateIds]);
    const eligible = videos
      .filter(
        (v) =>
          v.durationSeconds >= MIN_DURATION_SECONDS &&
          v.durationSeconds <= MAX_DURATION_SECONDS &&
          !EXCLUDED_TITLE_PATTERN.test(v.title)
      )
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
    queued++;
  }
  return queued;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchYoutubeRankings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
