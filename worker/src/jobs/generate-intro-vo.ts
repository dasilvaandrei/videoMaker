// Once every ranking_item in a draft ranking has a downloaded song_clip
// (same readiness gate as generate-ranking-render-metadata.ts), writes a
// short spoken "hook" line for the very start of the video and
// synthesizes it via ElevenLabs. This is the only voiceover in the
// pipeline now — a single intro line, not per-song narration (that was
// tried and reverted earlier).
//
// Script text is picked from a small set of fixed templates (the user's
// own wording), not LLM-generated — only the artist name (and, for
// automated rankings, a plain metric descriptor) gets substituted in.
// Two of the four "personal picks" templates the user provided ("Overplayed
// vs. Masterpiece", "Mind-Reader Bet") were deliberately left out: both
// require confidently naming the artist's "most famous song", which is a
// specific factual claim we have no reliable source for across the
// ~15,000-artist auto-discovered roster (fine for a handful of
// mainstream acts, risky for the long tail). Likewise, "Stream Count
// Flex" (needs a real aggregate stream count) was left out of the
// automated set for the same reason Last.fm's raw playcount was already
// hidden on-screen (see generate-ranking-render-metadata.ts) — reading
// out an unreliable big number in the VO would reintroduce that same
// problem through audio instead of text.
//
// Every remaining template mentions the artist's name within its first
// few words, satisfying the "name in the first second" rule the user
// called out (the algorithm reads the audio to categorize the video).

import { synthesizeSpeech } from "../lib/elevenlabs.js";
import { probeDurationSeconds } from "../lib/ffmpeg.js";
import { supabase } from "../lib/supabase.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MEDIA_BUCKET = "media";

interface Template {
  script: (artist: string, metric: string) => string;
  onScreenText: (artist: string) => string;
}

const PERSONAL_TEMPLATES: Template[] = [
  {
    // "Fake Fan Trap"
    script: (artist) =>
      `Put a finger down if you know these ${artist} songs. If you make it to number one without putting a finger down, you're a fake fan who only listens to the radio. Let's go.`,
    onScreenText: () => "PUT A FINGER DOWN IF YOU KNOW THESE 👇",
  },
  {
    // "Cancel Me Bait"
    script: (artist) =>
      `I ranked ${artist}'s top 5 songs, and the number one spot is probably going to get my channel deleted. Tell me how badly I messed this up in the comments.`,
    onScreenText: () => "THIS RANKING MIGHT GET ME CANCELLED 💀",
  },
];

const DATA_TEMPLATES: Template[] = [
  {
    // "Numbers Don't Lie"
    script: (artist, metric) =>
      `Your favorite ${artist} song might not even be on this list. Ranked by ${metric}, here are their top 5 songs of all time.`,
    onScreenText: () => "THE NUMBERS DON'T LIE 📊",
  },
  {
    // "Stream Guessing Game"
    script: (artist, metric) =>
      `Can you guess ${artist}'s number one most popular song? Ranked by ${metric}, here is their top 5.`,
    onScreenText: () => "CAN YOU GUESS #1? 🤔",
  },
  {
    // "Radio Hit vs. Stream Monster"
    script: (artist, metric) =>
      `Think you know ${artist}'s most popular track? You might be surprised by what's actually number one. Here are their top 5 songs, ranked by ${metric}.`,
    onScreenText: () => "YOU'LL NEVER GUESS #1 😳",
  },
];

// Same plain-language framing already used in the caption (see
// generate-ranking-render-metadata.ts's SOURCE_CAPTION_LINE) — Last.fm's
// playcount only reflects its own small scrobbling base, so the VO
// claims "popularity", not a precise stream count.
const SOURCE_METRIC: Record<string, string> = {
  lastfm: "overall popularity",
  youtube: "official YouTube views",
};

// Deterministic pick per ranking (not random) so re-running this job is
// idempotent in spirit even though the DB write below also makes it
// safe to just re-check `intro_vo_storage_path is null`.
function pickTemplate(templates: Template[], rankingId: string): Template {
  let hash = 0;
  for (let i = 0; i < rankingId.length; i++) hash = (hash * 31 + rankingId.charCodeAt(i)) >>> 0;
  return templates[hash % templates.length];
}

interface DraftRanking {
  id: string;
  source: string;
  artists: { name: string } | { name: string }[] | null;
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

export async function generateIntroVo() {
  const { data: candidates, error } = await supabase
    .from("rankings")
    .select("id, source, artists(name)")
    .eq("status", "draft")
    .is("intro_vo_storage_path", null)
    .returns<DraftRanking[]>();
  if (error) throw error;

  for (const ranking of candidates ?? []) {
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

    const artistName = oneOf(ranking.artists)?.name ?? "";
    const template =
      ranking.source === "personal"
        ? pickTemplate(PERSONAL_TEMPLATES, ranking.id)
        : pickTemplate(DATA_TEMPLATES, ranking.id);
    const script = template.script(artistName, SOURCE_METRIC[ranking.source] ?? "overall popularity");
    const onScreenText = template.onScreenText(artistName);

    const dir = await mkdtemp(join(tmpdir(), "intro-vo-"));
    const audioPath = join(dir, "intro.mp3");

    try {
      const audioBuffer = await synthesizeSpeech(script);
      await writeFile(audioPath, audioBuffer);
      const durationSeconds = await probeDurationSeconds(audioPath);
      if (!durationSeconds) throw new Error("could not determine intro VO duration");

      const objectPath = `intro-vo/${ranking.id}.mp3`;
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from("rankings")
        .update({
          intro_script: script,
          intro_on_screen_text: onScreenText,
          intro_vo_storage_path: objectPath,
          intro_vo_duration_seconds: durationSeconds,
        })
        .eq("id", ranking.id);
      if (updateError) throw updateError;

      console.log(`${artistName}: generated intro VO for ranking ${ranking.id} (${durationSeconds.toFixed(2)}s)`);
    } catch (err) {
      // One failed synthesis shouldn't block the rest of the batch — the
      // ranking just stays without intro VO and generate-ranking-render-metadata's
      // gate holds it back from queuing a render until this succeeds on a
      // later run.
      console.error(`intro VO for ranking ${ranking.id} failed:`, err instanceof Error ? err.message : err);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateIntroVo()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
