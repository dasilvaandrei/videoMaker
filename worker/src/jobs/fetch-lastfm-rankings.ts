// Once per day: pulls each roster artist's Last.fm top-5 tracks (by real
// scrobble playcount) and turns them into a rankings row + 5
// ranking_items. Replaces an earlier Spotify-backed version — Spotify's
// own top-tracks endpoint is deprecated and gated behind an approval
// process ("Extended Quota Mode") that a normal Development Mode app
// doesn't get.

import { loadArtistRoster } from "../config/artists.js";
import { getArtistTopTracks } from "../lib/lastfm.js";
import { supabase } from "../lib/supabase.js";

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

// `onlyArtistNames` scopes this to specific roster artists (used by
// run-daily-pipeline.ts, which only wants today's one pick — running the
// whole roster's worth of downloads/renders every day would be way more
// than the 1-video/day publish cadence needs). Omit it to process the
// whole roster, same as before.
export async function fetchLastfmRankings(onlyArtistNames?: string[]) {
  const roster = onlyArtistNames
    ? loadArtistRoster().filter((a) => onlyArtistNames.includes(a.name))
    : loadArtistRoster();
  const periodLabel = todayLabel();

  for (const artistConfig of roster) {
    const { data: artist, error: artistError } = await supabase
      .from("artists")
      .upsert({ name: artistConfig.name }, { onConflict: "name" })
      .select("id")
      .single();
    if (artistError) throw artistError;

    const tracks = await getArtistTopTracks(artistConfig.name);
    const top5 = tracks.slice(0, 5);
    if (top5.length < 5) {
      console.warn(`${artistConfig.name}: only ${top5.length} Last.fm top tracks returned, skipping`);
      continue;
    }

    const { data: ranking, error: rankingError } = await supabase
      .from("rankings")
      .upsert(
        { artist_id: artist.id, source: "lastfm", period_label: periodLabel },
        { onConflict: "artist_id,source,period_label" }
      )
      .select("id")
      .single();
    if (rankingError) throw rankingError;

    for (const [index, track] of top5.entries()) {
      const { data: song, error: songError } = await supabase
        .from("songs")
        .upsert(
          {
            artist_id: artist.id,
            title: track.name,
            duration_seconds: track.durationSeconds,
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
          metric_label: `${track.playcount.toLocaleString()} plays`,
          metric_value: track.playcount,
        },
        { onConflict: "ranking_id,rank" }
      );
      if (itemError) throw itemError;
    }

    console.log(`${artistConfig.name}: queued Last.fm ranking ${ranking.id} (${periodLabel})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchLastfmRankings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
