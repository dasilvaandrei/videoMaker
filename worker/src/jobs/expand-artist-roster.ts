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
import { getArtistListeners, getTopArtistsByTag } from "../lib/lastfm.js";
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

const PAGES_PER_TAG = 10; // 10 pages x 50/page = up to 500 candidates per tag, before the listener filter below
const RESULTS_PER_PAGE = 50;
const DELAY_MS = 150; // stay well under Last.fm's rate limit (proven safe below at 1 request in flight at a time)

// A tag chart's page 1 is genuinely famous artists, but by page 5-10 it's
// full of real, working, but non-famous acts (see the "Force MD's" /
// "Johnson, Hawkins, Tatum & Durr" type names that were showing up in
// generated rankings). Last.fm listener count is a direct, global
// popularity signal, so filtering on it (rather than just trusting a
// tag's internal rank) keeps the roster to artists most viewers would
// actually recognize regardless of which tag surfaced them.
const MIN_LISTENERS = 500_000;
// Once a tag's chart has produced this many artists in a row under the
// listener bar, stop paging further into that tag — chart order is
// popularity-descending, so a long miss streak means the remaining pages
// are increasingly unlikely to clear a *global* listener bar that page 1
// artists already struggled with. This is what keeps a full run from
// needing ~15,000 sequential Last.fm calls (which, at a safe single-
// request-at-a-time pace, would take well over an hour).
const EARLY_STOP_STREAK = 20;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function expandArtistRoster() {
  const existing = JSON.parse(readFileSync(ARTISTS_JSON_PATH, "utf-8")) as ArtistConfig[];
  // Hand-curated entries (real bio + pre-verified channel id) are kept
  // regardless of the listener filter below — they were personally
  // chosen, not tag-chart noise. Everything else gets re-derived from
  // the tag charts and re-checked against MIN_LISTENERS, which also
  // naturally drops any previously-added artist that no longer clears
  // the bar.
  const curated = existing.filter((a) => a.bio);
  const byNameLower = new Map<string, ArtistConfig>(curated.map((a) => [a.name.toLowerCase(), a]));
  const seenThisRun = new Set<string>(byNameLower.keys());

  // One request in flight at a time, each followed by a fixed delay —
  // this exact pacing (used below and in the tag.getTopArtists loop) got
  // through hundreds of calls earlier in this same job without issue.
  // A previous version of this function checked listener counts with 10
  // requests in flight at once and no delay between them; Last.fm started
  // silently rate-limiting partway through (error code 29), and because
  // that error was being treated the same as "artist not found" (0
  // listeners), it quietly dropped ~14,000 real candidates — including
  // huge, obviously-famous names — instead of failing loudly.
  for (const tag of GENRE_TAGS) {
    let tagKept = 0;
    let consecutiveMisses = 0;
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
        if (seenThisRun.has(key)) continue; // already curated, or already kept from an earlier tag
        seenThisRun.add(key);

        const listeners = await getArtistListeners(name);
        await sleep(DELAY_MS);

        if (listeners > MIN_LISTENERS) {
          byNameLower.set(key, { name, youtubeChannelId: null });
          tagKept++;
          consecutiveMisses = 0;
        } else {
          consecutiveMisses++;
          if (consecutiveMisses >= EARLY_STOP_STREAK) break;
        }
      }
      if (consecutiveMisses >= EARLY_STOP_STREAK) break;
    }
    console.log(`${tag}: +${tagKept} artist(s) cleared ${MIN_LISTENERS.toLocaleString()} listeners`);

    // Checkpoint after every tag so a crash or a sustained rate limit
    // loses at most one tag's worth of progress, not the whole run.
    writeFileSync(ARTISTS_JSON_PATH, JSON.stringify([...byNameLower.values()], null, 2) + "\n");
  }

  const merged = [...byNameLower.values()];
  console.log(
    `\nRoster: ${existing.length} -> ${merged.length} artists ` +
      `(${curated.length} curated + ${merged.length - curated.length} cleared ${MIN_LISTENERS.toLocaleString()} listeners)`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  expandArtistRoster()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
