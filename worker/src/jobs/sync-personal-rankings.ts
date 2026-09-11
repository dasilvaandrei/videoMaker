// Reads Google Form responses (one row per submission, one submission per
// ranking) and turns each row into a source='personal' ranking. Set up
// the form like this, linked to output into the existing
// PERSONAL_RANKINGS_SHEET_ID spreadsheet:
//
//   1. Artist Name           (short answer)
//   2. Batch / Video Label   (short answer — e.g. a date or "v1"; keeps
//                              a second ranking for the same artist from
//                              overwriting the first one)
//   3. Song #1 (Your favorite) (short answer)
//   4. Song #2                (short answer)
//   5. Song #3                (short answer)
//   6. Song #4                (short answer)
//   7. Song #5                (short answer)
//   8. Why this ranking?      (paragraph, optional)
//
// Linking the form to an existing spreadsheet creates a "Form Responses
// 1" tab with Google's auto-generated headers (Timestamp + the exact
// question text) — this job matches columns by keyword rather than exact
// position, so reordering/rewording questions slightly won't break it,
// but the "Song #N" numbering must stay intact for rank detection.

import { getSheetRows } from "../lib/googleSheets.js";
import { supabase } from "../lib/supabase.js";

const RESPONSES_RANGE = process.env.PERSONAL_RANKINGS_SHEET_RANGE ?? "Form Responses 1!A:Z";

interface ParsedResponse {
  artist: string;
  batch: string;
  songsByRank: Map<number, string>;
  note: string | null;
}

function parseResponses(rawRows: string[][]): ParsedResponse[] {
  const [header, ...rows] = rawRows;
  if (!header) return [];

  const normalized = header.map((h) => h.trim().toLowerCase());
  const artistIdx = normalized.findIndex((h) => h.includes("artist"));
  const batchIdx = normalized.findIndex((h) => h.includes("batch"));
  const noteIdx = normalized.findIndex((h) => h.includes("why") || h.includes("note"));

  // "song #1" / "song 1" / "song1" -> rank 1, etc.
  const songColumns: Array<{ index: number; rank: number }> = [];
  normalized.forEach((h, index) => {
    if (!h.startsWith("song")) return;
    const match = /(\d)/.exec(h);
    if (match) songColumns.push({ index, rank: Number(match[1]) });
  });

  if (artistIdx < 0 || batchIdx < 0 || songColumns.length === 0) {
    throw new Error(
      `form response header must include Artist, Batch, and Song #1..#5 columns; got ${JSON.stringify(header)}`
    );
  }

  return rows
    .filter((r) => r[artistIdx]?.trim())
    .map((r) => {
      const songsByRank = new Map<number, string>();
      for (const { index, rank } of songColumns) {
        const title = r[index]?.trim();
        if (title && rank >= 1 && rank <= 5) songsByRank.set(rank, title);
      }
      return {
        artist: r[artistIdx].trim(),
        batch: r[batchIdx]?.trim() || "default",
        songsByRank,
        note: noteIdx >= 0 ? r[noteIdx]?.trim() || null : null,
      };
    })
    .filter((r) => r.songsByRank.size === 5);
}

export async function syncPersonalRankings() {
  const spreadsheetId = process.env.PERSONAL_RANKINGS_SHEET_ID;
  if (!spreadsheetId) throw new Error("PERSONAL_RANKINGS_SHEET_ID must be set");

  const rawRows = await getSheetRows(spreadsheetId, RESPONSES_RANGE);
  const responses = parseResponses(rawRows);
  console.log(`${responses.length} of ${rawRows.length - 1} form response(s) have all 5 songs filled in`);

  for (const response of responses) {
    const { data: artist, error: artistError } = await supabase
      .from("artists")
      .upsert({ name: response.artist }, { onConflict: "name" })
      .select("id")
      .single();
    if (artistError) throw artistError;

    const { data: ranking, error: rankingError } = await supabase
      .from("rankings")
      .upsert(
        { artist_id: artist.id, source: "personal", period_label: response.batch, note: response.note },
        { onConflict: "artist_id,source,period_label" }
      )
      .select("id")
      .single();
    if (rankingError) throw rankingError;

    for (const [rank, songTitle] of response.songsByRank) {
      const { data: song, error: songError } = await supabase
        .from("songs")
        .upsert({ artist_id: artist.id, title: songTitle }, { onConflict: "artist_id,title" })
        .select("id")
        .single();
      if (songError) throw songError;

      const { error: itemError } = await supabase.from("ranking_items").upsert(
        { ranking_id: ranking.id, song_id: song.id, rank },
        { onConflict: "ranking_id,rank" }
      );
      if (itemError) throw itemError;
    }

    console.log(`${response.artist} (${response.batch}): synced personal ranking ${ranking.id}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncPersonalRankings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
