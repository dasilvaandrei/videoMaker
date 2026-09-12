// Shared song-title normalization for deduping near-identical entries
// that are really the same underlying song before they get treated as
// distinct ranking slots. Discovered from two real cases: Dua Lipa's
// Last.fm top tracks listed "Levitating" and "Levitating (feat. DaBaby)"
// as two separate entries (same song, same official video), and Calvin
// Harris's YouTube ranking separately listed "Satisfy (Official
// Visualiser)" and "Satisfy (Official Audio)" — same underlying song,
// two different uploads.
//
// Stripping bracketed content (feat./remix/official video/audio/
// visualiser/lyric video labels) and common hyphenated version suffixes
// collapses both cases to the same key, so only the more popular
// instance survives.
//
// Tradeoff: a genuinely different song whose real title happens to use
// parentheses (rare) could get over-merged with another song sharing the
// same base title — accepted as a much smaller risk than showing the
// same clip twice in a 5-song ranking.
export function normalizeSongTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[([][^)\]]*[)\]]/g, "")
    .replace(
      /\s*-\s*(remix|live|acoustic|radio edit|edit|sped up|slowed(?: down)?|extended|instrumental|vip(?: mix)?|mix|version)\b.*$/i,
      ""
    )
    .replace(/\b(feat\.?|ft\.?)\s+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Keeps the first occurrence of each normalized title, dropping the
// rest — callers should pass items already sorted by popularity so
// "first" means "most popular".
export function dedupeByNormalizedTitle<T>(items: T[], getTitle: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = normalizeSongTitleForDedup(getTitle(item));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
