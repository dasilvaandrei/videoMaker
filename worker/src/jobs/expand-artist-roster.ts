// One-off (run by hand, not part of the daily pipeline): pulls real,
// popularity-ranked artist names from Last.fm's genre-tag charts and
// merges them into artists.json. Deliberately data-driven rather than a
// hand-typed list — we can personally verify and hand-write a real bio
// for a few dozen major artists (see config/artists.json's existing
// entries), but not thousands across genres we don't have deep
// knowledge of. New entries get just a `name` (Last.fm looks artists up
// by name, no id needed) — no youtubeChannelId, since
// fetch-youtube-rankings.ts now resolves + caches one at runtime instead
// of requiring it pre-verified in config (see lib/youtube.ts's
// searchOfficialChannel).
//
// Exactly how many artists this lands on depends on how much real
// tagged data Last.fm actually has per genre — niche/regional tags run
// out of well-tagged artists well before 1000, so the total is however
// many genuine entries exist across this tag list, not a padded round
// number.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getTopArtistsByTag } from "../lib/lastfm.js";
import type { ArtistConfig } from "../config/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTISTS_JSON_PATH = path.join(__dirname, "../config/artists.json");

// The genres the user asked for, plus enough additional breadth to
// actually approach the requested scale across "all kinds of music."
// Genre-specific tags (rather than the broader umbrella tag) where one
// exists, so e.g. "funk carioca" doesn't pull James Brown-style American
// funk acts instead of Brazilian funk.
const GENRE_TAGS = [
  // Latin, as requested
  "salsa",
  "bachata",
  "reggaeton",
  "merengue",
  "funk carioca",
  "bossa nova",
  "cumbia",
  "latin pop",
  "vallenato",
  "musica mexicana",
  "corridos tumbados",
  "banda",
  "ranchera",
  // Explicitly requested
  "country",
  "pop",
  "rap",
  "edm",
  "afrobeats",
  // Broader coverage so "all kinds of music" isn't just the examples
  "rock",
  "hip hop",
  "r&b",
  "soul",
  "reggae",
  "k-pop",
  "indie",
  "metal",
  "jazz",
  "house",
  "techno",
  "drill",
  "dancehall",
  "soca",
  "amapiano",
  "trap",
  "disco",
  "funk",
  "gospel",
  "blues",
  "punk",
  "alternative",
];

const PAGES_PER_TAG = 10;
const RESULTS_PER_PAGE = 50;
const DELAY_MS = 150; // stay well under any reasonable rate limit

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function expandArtistRoster() {
  const existing = JSON.parse(readFileSync(ARTISTS_JSON_PATH, "utf-8")) as ArtistConfig[];
  const byNameLower = new Map(existing.map((a) => [a.name.toLowerCase(), a]));

  let newCount = 0;

  for (const tag of GENRE_TAGS) {
    let tagCount = 0;
    for (let page = 1; page <= PAGES_PER_TAG; page++) {
      let names: string[];
      try {
        names = await getTopArtistsByTag(tag, page, RESULTS_PER_PAGE);
      } catch (err) {
        console.warn(`tag "${tag}" page ${page} failed, stopping this tag:`, err instanceof Error ? err.message : err);
        break;
      }
      if (names.length === 0) break; // ran out of tagged data for this genre

      for (const name of names) {
        const key = name.toLowerCase();
        if (!byNameLower.has(key)) {
          byNameLower.set(key, { name, youtubeChannelId: null });
          newCount++;
          tagCount++;
        }
      }

      await sleep(DELAY_MS);
    }
    console.log(`${tag}: +${tagCount} new artist(s)`);
  }

  const merged = [...byNameLower.values()];
  writeFileSync(ARTISTS_JSON_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nRoster: ${existing.length} -> ${merged.length} artists (+${newCount} new)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  expandArtistRoster()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
