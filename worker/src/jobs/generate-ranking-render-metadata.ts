// Once every ranking_item in a draft ranking has a downloaded song_clip,
// builds title/caption/hashtags (source-aware) and queues a
// ranking_videos row. No LLM call — like the old campaign pipeline's
// generate-render-metadata.ts, the cheapest option when the inputs
// (artist, source, song lineup) are already enough to build good-enough
// copy programmatically.

import { loadArtistRoster } from "../config/artists.js";
import { generateText } from "../lib/anthropic.js";
import { supabase } from "../lib/supabase.js";

// Title text stays clean of source jargon ("Last.fm" means nothing to a
// casual viewer) — the source is named in the caption instead. YouTube's
// "Views" label is plain-English enough to keep in the title. Title Case
// not all-caps is based on a real data point: pulling a working
// countdown-ranking channel's upload history via the Data API showed its
// highest-performing titles consistently follow "Ranking The Best X" in
// Title Case, never all-caps.
// "Top 5 Songs" for youtube (its view-count numbers are real, verifiable
// totals, safe to imply precision) vs. "Top 5 Most Popular Songs" for
// lastfm — Last.fm's playcount only reflects its own (much smaller)
// scrobbling user base, not real-world stream totals, so a specific
// number reads as misleadingly tiny for a genuine hit. "Most popular"
// makes a qualitative claim instead of an implied precise one.
const SOURCE_TITLE_WORDING: Record<string, string> = {
  lastfm: "Top 5 Most Popular Songs",
  youtube: "Top 5 Songs (YouTube Views)",
};

const SOURCE_CAPTION_LINE: Record<string, string> = {
  lastfm: "Ranked by overall popularity on Last.fm.",
  youtube: "Ranked by official YouTube view counts.",
};

const SOURCE_HASHTAGS: Record<string, string[]> = {
  lastfm: ["lastfm", "topsongs", "musicranking"],
  youtube: ["youtube", "mostviewed", "musicranking"],
  personal: ["top5", "musicranking", "debate"],
};

// Automated rankings (Last.fm playcount / YouTube view count) only ever
// see songs primarily credited to the artist — a feature/collab hit like
// a Bzrp Music Session gets credited to the producer, not the featured
// vocalist, so it silently never appears here even if it's the artist's
// biggest song. Surfaced on-screen and in the caption rather than left
// as a silent gap viewers would otherwise just call out in comments.
const FEATURE_DISCLAIMER = "Primary artist credit only";

// Generated once per artist (see getOrGenerateBio below) and cached in
// artists.bio, so this only ever runs as a last-resort fallback if the
// generation call itself fails.
const GENERIC_BIO = (artistName: string) =>
  `${artistName} is a recording artist featured in this ranking.`;

const BIO_SYSTEM_PROMPT = [
  "You write short, original artist biography paragraphs for a YouTube",
  "video caption, in the style of a music streaming service's 'about the",
  "artist' section. Exactly one paragraph, 3-4 sentences, starting with",
  'the literal phrase "{name} is..." — cover their genre, style, and what',
  "they're generally known for. If you aren't confident about specific",
  "biographical facts for this artist (nationality, career milestones,",
  "specific songs or albums), stay general about genre and style rather",
  "than inventing details — never fabricate a specific fact you aren't",
  "confident is true. Never quote or reproduce song lyrics or any other",
  "copyrighted text. Output only the bio paragraph, nothing else — no",
  "preamble, no quotation marks around it.",
].join(" ");

async function getOrGenerateBio(artistId: string, artistName: string, staticBio?: string): Promise<string> {
  // Hand-written entries in config/artists.json are a curated override —
  // higher-confidence than a generated guess, so they always win.
  if (staticBio) return staticBio;

  const { data: artistRow, error } = await supabase.from("artists").select("bio").eq("id", artistId).single();
  if (error) throw error;
  if (artistRow.bio) return artistRow.bio;

  try {
    const generated = (await generateText(BIO_SYSTEM_PROMPT, `Artist name: ${artistName}`, 300)).trim();
    if (!generated) throw new Error("empty response");

    const { error: saveError } = await supabase.from("artists").update({ bio: generated }).eq("id", artistId);
    if (saveError) throw saveError;

    console.log(`generated bio for ${artistName}`);
    return generated;
  } catch (err) {
    console.warn(`bio generation failed for ${artistName}, using generic fallback:`, err instanceof Error ? err.message : err);
    return GENERIC_BIO(artistName);
  }
}

// Bottom-of-caption credit line, present on every video regardless of
// source — the actual copyright-relevant statement: none of the music,
// footage, or artwork is ours.
const COPYRIGHT_CREDIT_LINE =
  "All video clips, music, and artwork remain the property of their original artists, labels, and copyright holders.";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function buildTitle(artistName: string, source: string): string {
  if (source === "personal") {
    return `Ranking My Top 5 ${artistName} Songs 🔥 (Agree?)`;
  }
  return `Ranking ${artistName}'s ${SOURCE_TITLE_WORDING[source] ?? "Top 5 Songs"} 🔥`;
}

// Caption is now: about-the-artist blurb, then the ranking description,
// then (bottom) where the ranking data and the video/song content are
// credited from — the credit line is the actually copyright-relevant
// part, so it stays last where captions conventionally put fine print.
function buildCaption(artistName: string, bio: string, source: string, note: string | null): string {
  if (source === "personal") {
    const base = `My ranking of ${artistName}'s best songs — let me know if you'd flip any of these.`;
    const middle = note ? `${base}\n\n${note}` : base;
    return `${bio}\n\n${middle}\n\n${COPYRIGHT_CREDIT_LINE}`;
  }
  const sourceLine = SOURCE_CAPTION_LINE[source] ?? "";
  return `${bio}\n\n${artistName}'s top 5 songs right now, ranked 5 to 1.\n\n${sourceLine}\n${FEATURE_DISCLAIMER}\n\n${COPYRIGHT_CREDIT_LINE}`;
}

interface DraftRanking {
  id: string;
  source: string;
  note: string | null;
  artists: { id: string; name: string } | { id: string; name: string }[] | null;
}

interface RankingItemCheck {
  songs:
    | { song_clips: { status: string } | { status: string }[] | null }
    | { song_clips: { status: string } | { status: string }[] | null }[]
    | null;
}

function oneOf<T>(value: T | T[] | null): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

function artistNameOf(ranking: DraftRanking): string {
  return oneOf(ranking.artists)?.name ?? "";
}

function artistIdOf(ranking: DraftRanking): string {
  return oneOf(ranking.artists)?.id ?? "";
}

export async function generateRankingRenderMetadata() {
  const staticBioByName = new Map(loadArtistRoster().map((a) => [a.name, a.bio]));

  const { data: draftRankings, error } = await supabase
    .from("rankings")
    .select("id, source, note, artists(id, name)")
    .eq("status", "draft")
    .returns<DraftRanking[]>();
  if (error) throw error;

  for (const ranking of draftRankings ?? []) {
    const { data: items, error: itemsError } = await supabase
      .from("ranking_items")
      .select("songs(song_clips(status))")
      .eq("ranking_id", ranking.id)
      .returns<RankingItemCheck[]>();
    if (itemsError) throw itemsError;

    if ((items ?? []).length < 5) continue;

    const allDownloaded = (items ?? []).every((item) => {
      const song = oneOf(item.songs);
      const clip = song ? oneOf(song.song_clips) : null;
      return clip?.status === "downloaded";
    });
    if (!allDownloaded) continue;

    const artistName = artistNameOf(ranking);
    const bio = await getOrGenerateBio(artistIdOf(ranking), artistName, staticBioByName.get(artistName));
    const { data: video, error: insertError } = await supabase
      .from("ranking_videos")
      .insert({
        ranking_id: ranking.id,
        aspect_ratio: "9:16",
        title: buildTitle(artistName, ranking.source),
        caption: buildCaption(artistName, bio, ranking.source, ranking.note),
        hashtags: [...SOURCE_HASHTAGS[ranking.source], slug(artistName), "shorts"],
        render_status: "queued",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    // Flips the ranking out of the 'draft' query above, so re-running
    // this job never double-queues a ranking_video for the same ranking.
    const { error: rankingUpdateError } = await supabase
      .from("rankings")
      .update({ status: "ready" })
      .eq("id", ranking.id);
    if (rankingUpdateError) throw rankingUpdateError;

    console.log(`${artistName}: queued ranking_video ${video.id} (${ranking.source})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateRankingRenderMetadata()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
