// Last.fm API — free, instant API key, no OAuth, no approval process.
// Used in place of Spotify's own "Get Artist's Top Tracks" endpoint,
// which Spotify deprecated and locked behind an Extended Quota Mode
// approval that regular Development Mode apps don't get. Last.fm's
// playcount is real scrobble data, not an opaque 0-100 score, so if
// anything it's a more meaningful "most streamed" signal, just tracking
// Last.fm's own user base rather than Spotify's specifically.

const API_BASE = "https://ws.audioscrobbler.com/2.0/";

export interface LastfmTopTrack {
  name: string;
  playcount: number;
  durationSeconds: number | null;
}

// Real, ranked-by-popularity artist names for a genre tag — used to
// build the roster from actual Last.fm chart data rather than a
// hand-typed list (which doesn't scale past a few dozen artists we can
// personally verify, and risks naming artists we don't actually know
// well for niche genres).
export async function getTopArtistsByTag(tag: string, page: number, limit = 50): Promise<string[]> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY must be set");

  const url = new URL(API_BASE);
  url.search = new URLSearchParams({
    method: "tag.gettopartists",
    tag,
    api_key: apiKey,
    format: "json",
    limit: String(limit),
    page: String(page),
  }).toString();

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`Last.fm tag.getTopArtists failed for ${JSON.stringify(tag)} page ${page}: ${res.status} ${JSON.stringify(body)}`);
  }

  const artists = (body.topartists?.artist ?? []) as Array<{ name: string }>;
  return artists.map((a) => a.name);
}

export async function getArtistTopTracks(artistName: string, limit = 5): Promise<LastfmTopTrack[]> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) throw new Error("LASTFM_API_KEY must be set");

  const url = new URL(API_BASE);
  url.search = new URLSearchParams({
    method: "artist.gettoptracks",
    artist: artistName,
    api_key: apiKey,
    format: "json",
    limit: String(limit),
  }).toString();

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`Last.fm artist.getTopTracks failed for ${JSON.stringify(artistName)}: ${res.status} ${JSON.stringify(body)}`);
  }

  const tracks = (body.toptracks?.track ?? []) as Array<{
    name: string;
    playcount: string;
    duration: string;
  }>;

  return tracks.map((t) => ({
    name: t.name,
    playcount: Number(t.playcount) || 0,
    durationSeconds: Number(t.duration) > 0 ? Number(t.duration) : null,
  }));
}
