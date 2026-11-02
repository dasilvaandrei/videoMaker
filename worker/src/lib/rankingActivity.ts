// Shared "is this ranking still in flight?" logic for storage cleanup and
// clip re-download. Both have to agree exactly: cleanup deletes a song
// clip only when no in-flight ranking references it, and
// requeueEvictedClips re-downloads a deleted clip as soon as an in-flight
// ranking does. If they disagreed, a clip would get downloaded and deleted
// on alternating runs forever.
//
// "Posted" means published to YouTube — the only platform that earns ad
// revenue. TikTok gets the same video inside the same pipeline run before
// cleanup happens; Instagram is no longer part of the automated flow.

import { supabase } from "./supabase.js";

const PAGE_SIZE = 1000;
const IN_FILTER_CHUNK = 100;

// PostgREST caps every response at 1000 rows by default, silently. Any
// "give me all rows" query on a table that keeps growing (ranking_items
// gains 5 rows per video) has to page, or it starts quietly returning a
// truncated picture.
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

export async function getYoutubePublishedVideoIds(): Promise<Set<string>> {
  const { data: platform, error: platformError } = await supabase
    .from("platforms")
    .select("id")
    .eq("name", "youtube")
    .single();
  if (platformError) throw platformError;

  const { data: accounts, error: accountsError } = await supabase
    .from("platform_accounts")
    .select("id")
    .eq("platform_id", platform.id);
  if (accountsError) throw accountsError;
  const accountIds = (accounts ?? []).map((a) => a.id as string);
  if (accountIds.length === 0) return new Set();

  const posts = await fetchAllRows<{ ranking_video_id: string }>((from, to) =>
    supabase
      .from("posts")
      .select("ranking_video_id")
      .in("platform_account_id", accountIds)
      .eq("status", "published")
      .order("id")
      .range(from, to)
  );
  return new Set(posts.map((p) => p.ranking_video_id));
}

// A ranking is in flight (its clips are still needed) if it hasn't been
// rendered yet, is mid-render, or has a finished video that isn't on
// YouTube yet. A ranking whose videos are all published or all failed is
// done — failed renders are never retried, so their clips are dead weight.
export async function findActiveRankingIds(youtubePublished: Set<string>): Promise<Set<string>> {
  const rankings = await fetchAllRows<{ id: string }>((from, to) =>
    supabase.from("rankings").select("id").order("id").range(from, to)
  );
  const videos = await fetchAllRows<{ id: string; ranking_id: string; render_status: string }>((from, to) =>
    supabase.from("ranking_videos").select("id, ranking_id, render_status").order("id").range(from, to)
  );

  const videosByRanking = new Map<string, { id: string; render_status: string }[]>();
  for (const video of videos) {
    if (!videosByRanking.has(video.ranking_id)) videosByRanking.set(video.ranking_id, []);
    videosByRanking.get(video.ranking_id)!.push(video);
  }

  const active = new Set<string>();
  for (const { id } of rankings) {
    const rankingVideos = videosByRanking.get(id) ?? [];
    const inFlight =
      rankingVideos.length === 0 ||
      rankingVideos.some(
        (v) =>
          v.render_status === "queued" ||
          v.render_status === "rendering" ||
          (v.render_status === "ready" && !youtubePublished.has(v.id))
      );
    if (inFlight) active.add(id);
  }
  return active;
}

export async function getSongIdsForRankings(rankingIds: Set<string>): Promise<Set<string>> {
  const items = await fetchAllRows<{ ranking_id: string; song_id: string }>((from, to) =>
    supabase.from("ranking_items").select("ranking_id, song_id").order("id").range(from, to)
  );
  return new Set(items.filter((i) => rankingIds.has(i.ranking_id)).map((i) => i.song_id));
}

// Cleanup deletes a clip's file but leaves the row as status='downloaded'
// with storage_path=null (keeping its YouTube id + clip window). If a new
// ranking later uses the same song (songs are shared per artist+title, so
// e.g. a personal pick can reuse a song an automated ranking already
// used), flip it back to 'pending' so download-song-clips.ts fetches it
// again — otherwise the render would fail on a missing clip, and a stuck
// personal ranking gets re-picked every run, wedging the whole pipeline.
export async function requeueEvictedClips(): Promise<number> {
  const youtubePublished = await getYoutubePublishedVideoIds();
  const activeRankingIds = await findActiveRankingIds(youtubePublished);
  const neededSongIds = await getSongIdsForRankings(activeRankingIds);

  const evicted = await fetchAllRows<{ id: string; song_id: string }>((from, to) =>
    supabase
      .from("song_clips")
      .select("id, song_id")
      .eq("status", "downloaded")
      .is("storage_path", null)
      .order("id")
      .range(from, to)
  );
  const toRequeue = evicted.filter((c) => neededSongIds.has(c.song_id)).map((c) => c.id);

  for (let i = 0; i < toRequeue.length; i += IN_FILTER_CHUNK) {
    const chunk = toRequeue.slice(i, i + IN_FILTER_CHUNK);
    const { error } = await supabase
      .from("song_clips")
      .update({ status: "pending", download_attempts: 0 })
      .in("id", chunk);
    if (error) throw error;
  }
  if (toRequeue.length > 0) console.log(`re-queued ${toRequeue.length} previously-deleted clip(s) needed by a new ranking`);
  return toRequeue.length;
}
