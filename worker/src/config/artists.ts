// Loads the tracked-artist roster from artists.json. Plain fs read rather
// than a JSON import — the project's tsconfig doesn't set
// resolveJsonModule, and NodeNext's import-attribute syntax for JSON
// (`with { type: "json" }`) is more ceremony than this small, rarely
// re-read config file is worth.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ArtistConfig {
  // Last.fm's artist.getTopTracks looks artists up by this exact name
  // string (no separate Last.fm ID needed).
  name: string;
  // Find via the channel's youtube.com/channel/<id> URL (resolve an
  // @handle to a channel id with the Data API's channels.list?forHandle=
  // if needed).
  youtubeChannelId: string | null;
  // One original sentence on genre/style — shown at the top of the
  // YouTube caption, "about the artist" style. Hand-written per artist
  // rather than pulled from Spotify/Wikipedia/etc. to avoid reproducing
  // someone else's bio text. Falls back to a generic line if unset.
  bio?: string;
}

export function loadArtistRoster(): ArtistConfig[] {
  const raw = readFileSync(path.join(__dirname, "artists.json"), "utf-8");
  return JSON.parse(raw) as ArtistConfig[];
}
