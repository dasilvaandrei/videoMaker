// Once per day: pulls each roster artist's Last.fm top-5 tracks (by real
// scrobble playcount) and turns them into a rankings row + 5
// ranking_items. Replaces an earlier Spotify-backed version — Spotify's
// own top-tracks endpoint is deprecated and gated behind an approval
// process ("Extended Quota Mode") that a normal Development Mode app
// doesn't get.

import { loadArtistRoster } from "../config/artists.js";
import { getArtistTopTracks } from "../lib/lastfm.js";
import { dedupeByNormalizedTitle } from "../lib/songTitle.js";
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

    // Fetch a bigger pool than 5 — Last.fm often lists the same song
    // twice (e.g. "Levitating" and "Levitating (feat. DaBaby)"), so
    // there needs to be a 6th+ candidate to promote after deduping.
    //
    // Last.fm's response order is NOT strictly sorted by playcount (it's
    // some internal popularity score) — sorting explicitly here before
    // deduping matters twice over: it makes "the first occurrence of a
    // normalized title" actually mean "the higher-playcount one" instead
    // of whichever happened to come first in the API's own order, and it
    // makes the assigned rank (index + 1 below) actually match the
    // displayed playcount instead of occasionally showing a lower
    // playcount ranked above a higher one.
    const tracks = await getArtistTopTracks(artistConfig.name, 15);
    const sortedByPlaycount = [...tracks].sort((a, b) => b.playcount - a.playcount);
    const deduped = dedupeByNormalizedTitle(sortedByPlaycount, (t) => t.name);
    const top5 = deduped.slice(0, 5);
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
