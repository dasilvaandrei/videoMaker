// One-off (run by hand, not part of the daily pipeline): rebuilds
// artists.json from Spotify monthly listeners — every artist at or above
// MIN_MONTHLY_LISTENERS, plus MUST_INCLUDE. Re-run every month or two so
// the roster follows who is popular now.
//
// Spotify's Web API doesn't expose monthly listeners (and, for new apps,
// not even popularity or follower counts), so the numbers come from
// kworb.net's daily table of the top ~10,000 artists by monthly listeners.
//
// This replaced a Last.fm-based roster (tag charts filtered on all-time
// Last.fm listeners). That count favours artists who were big on Last.fm
// in the 2000s: Blue Swede and Ol' Dirty Bastard made the cut while
// current names like Rusowsky (40M monthly listeners) didn't.
//
// Existing entries keep their youtubeChannelId and hand-written bio.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ArtistConfig } from "../config/artists.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTISTS_JSON_PATH = path.join(__dirname, "../config/artists.json");

const KWORB_PAGES = [
  "https://kworb.net/spotify/listeners.html",
  "https://kworb.net/spotify/listeners2.html",
  "https://kworb.net/spotify/listeners3.html",
  "https://kworb.net/spotify/listeners4.html",
];

const MIN_MONTHLY_LISTENERS = 5_000_000;

// Artists we want regardless of the cutoff (e.g. scene favourites just
// under it). Names as Last.fm spells them.
const MUST_INCLUDE = ["2hollis", "it's murph"];

// Non-artists that rank high on Spotify but can't make a ranking video:
// cast recordings, orchestras, record labels, kids' brands.
const EXCLUDED_NAME_PATTERN = /\b(cast|records|orchestra|symphony|philharmoni\w*)\b/i;
const EXCLUDED_NAMES = new Set(["disney", "pinkfong", "pineapple stormtv", "jipmusic global"]);

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchMonthlyListeners(): Promise<Map<string, number>> {
  const listeners = new Map<string, number>();
  const rowPattern = /<a href="artist\/[^"]+">([^<]+)<\/a><\/div><\/td><td>([\d,]+)<\/td>/g;
  for (const url of KWORB_PAGES) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const html = await res.text();
    let pageRows = 0;
    for (const [, name, count] of html.matchAll(rowPattern)) {
      listeners.set(decodeEntities(name), Number(count.replace(/,/g, "")));
      pageRows++;
    }
    // A layout change would otherwise silently shrink the roster.
    if (pageRows < 1000) throw new Error(`${url}: parsed only ${pageRows} rows — has kworb's table format changed?`);
  }
  return listeners;
}

export async function expandArtistRoster() {
  const existing = JSON.parse(readFileSync(ARTISTS_JSON_PATH, "utf-8")) as ArtistConfig[];
  const existingByName = new Map(existing.map((a) => [a.name.toLowerCase(), a]));

  const listeners = await fetchMonthlyListeners();
  const names = [...listeners.entries()]
    .filter(([name, count]) => count >= MIN_MONTHLY_LISTENERS && !EXCLUDED_NAMES.has(name.toLowerCase()) && !EXCLUDED_NAME_PATTERN.test(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  for (const name of MUST_INCLUDE) {
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }

  const roster: ArtistConfig[] = names.map(
    (name) => existingByName.get(name.toLowerCase()) ?? { name, youtubeChannelId: null }
  );
  writeFileSync(ARTISTS_JSON_PATH, JSON.stringify(roster, null, 2) + "\n");

  const kept = roster.filter((a) => existingByName.has(a.name.toLowerCase())).length;
  console.log(
    `Roster: ${existing.length} -> ${roster.length} artists ` +
      `(${kept} kept, ${roster.length - kept} new, ${existing.length - kept} dropped)`
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
