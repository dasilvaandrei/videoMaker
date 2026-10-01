// Periodic self-heal: deletes the Storage objects (rendered videos,
// song clips) for content that's fully done its job, so the Supabase
// project doesn't keep accumulating storage until it trips a plan quota
// again (see the 2026-09-30 incident: exceed_storage_size_quota +
// exceed_egress_quota restricted the whole project, stopping every
// publish job at once).
//
// "Fully done" = every platform_account row in the DB has a published
// post for that ranking_video — dynamic over whatever platforms exist
// (YouTube/TikTok/Instagram today) rather than hardcoded, so a video
// only gets cleaned up once nothing could still need its file. This is
// deliberately conservative: a platform added later that never gets a
// published post for an old video just means that video is never
// cleaned up, not that something gets deleted too early.
//
// song_clips are shared across every ranking that happens to include
// that song (one download per song, not per ranking — see
// resolve-song-clips.ts) — a clip only gets deleted once every ranking
// referencing its song is itself fully done.
//
// Only clears the storage_path column after Storage actually confirms
// the delete, and only ever touches rows whose render_status/status are
// already in their terminal state ('ready' / 'downloaded') — nothing
// downstream re-reads storage_path for a video that's already published
// everywhere, so nulling it here is just defensive, not required for
// correctness.

import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const DELETE_BATCH_SIZE = 100;

interface RankingVideoRow {
  id: string;
  ranking_id: string;
  storage_path: string | null;
  render_status: string;
}

interface PostRow {
  ranking_video_id: string;
  platform_account_id: string;
  status: string;
}

interface RankingItemRow {
  ranking_id: string;
  song_id: string;
}

interface SongClipRow {
  id: string;
  song_id: string;
  storage_path: string | null;
}

async function deleteStoragePaths(paths: string[]): Promise<Set<string>> {
  const deleted = new Set<string>();
  for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
    const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).remove(batch);
    if (error) {
      console.error(`storage delete failed for batch starting at ${i}:`, error.message);
      continue;
    }
    for (const item of data ?? []) deleted.add(item.name);
  }
  return deleted;
}

export async function cleanupPublishedStorage() {
  const { data: platformAccounts, error: accountsError } = await supabase.from("platform_accounts").select("id");
  if (accountsError) throw accountsError;
  const allAccountIds = (platformAccounts ?? []).map((a) => a.id as string);
  if (allAccountIds.length === 0) {
    console.log("no platform_accounts rows — nothing to check publish-completeness against, skipping");
    return;
  }

  const { data: videos, error: videosError } = await supabase
    .from("ranking_videos")
    .select("id, ranking_id, storage_path, render_status")
    .returns<RankingVideoRow[]>();
  if (videosError) throw videosError;

  const { data: posts, error: postsError } = await supabase
    .from("posts")
    .select("ranking_video_id, platform_account_id, status")
    .returns<PostRow[]>();
  if (postsError) throw postsError;

  const publishedAccountsByVideo = new Map<string, Set<string>>();
  for (const post of posts ?? []) {
    if (post.status !== "published") continue;
    if (!publishedAccountsByVideo.has(post.ranking_video_id)) {
      publishedAccountsByVideo.set(post.ranking_video_id, new Set());
    }
    publishedAccountsByVideo.get(post.ranking_video_id)!.add(post.platform_account_id);
  }

  const fullyDoneVideoIds = new Set<string>();
  const videosByRanking = new Map<string, RankingVideoRow[]>();
  for (const video of videos ?? []) {
    if (!videosByRanking.has(video.ranking_id)) videosByRanking.set(video.ranking_id, []);
    videosByRanking.get(video.ranking_id)!.push(video);

    if (video.render_status !== "ready") continue;
    const publishedAccounts = publishedAccountsByVideo.get(video.id) ?? new Set();
    if (allAccountIds.every((id) => publishedAccounts.has(id))) {
      fullyDoneVideoIds.add(video.id);
    }
  }

  const fullyDoneRankingIds = new Set<string>();
  for (const [rankingId, rankingVideos] of videosByRanking) {
    if (rankingVideos.length === 0) continue;
    if (rankingVideos.every((v) => v.render_status === "ready" && fullyDoneVideoIds.has(v.id))) {
      fullyDoneRankingIds.add(rankingId);
    }
  }

  const renderPathsToDelete = (videos ?? [])
    .filter((v) => fullyDoneVideoIds.has(v.id) && v.storage_path)
    .map((v) => v.storage_path as string);

  const { data: rankingItems, error: itemsError } = await supabase
    .from("ranking_items")
    .select("ranking_id, song_id")
    .returns<RankingItemRow[]>();
  if (itemsError) throw itemsError;

  const rankingIdsBySong = new Map<string, Set<string>>();
  for (const item of rankingItems ?? []) {
    if (!rankingIdsBySong.has(item.song_id)) rankingIdsBySong.set(item.song_id, new Set());
    rankingIdsBySong.get(item.song_id)!.add(item.ranking_id);
  }

  const { data: songClips, error: clipsError } = await supabase
    .from("song_clips")
    .select("id, song_id, storage_path")
    .returns<SongClipRow[]>();
  if (clipsError) throw clipsError;

  const safeClips = (songClips ?? []).filter((clip) => {
    if (!clip.storage_path) return false;
    const referencingRankings = rankingIdsBySong.get(clip.song_id);
    if (!referencingRankings || referencingRankings.size === 0) return false;
    return [...referencingRankings].every((rid) => fullyDoneRankingIds.has(rid));
  });
  const clipPathsToDelete = safeClips.map((c) => c.storage_path as string);

  console.log(
    `${fullyDoneVideoIds.size} fully-published video(s), ${renderPathsToDelete.length} render file(s) and ${clipPathsToDelete.length} song-clip file(s) eligible for cleanup`
  );

  const deletedRenderPaths = await deleteStoragePaths(renderPathsToDelete);
  const deletedClipPaths = await deleteStoragePaths(clipPathsToDelete);

  const videosToNull = (videos ?? []).filter((v) => v.storage_path && deletedRenderPaths.has(v.storage_path));
  for (const video of videosToNull) {
    const { error } = await supabase.from("ranking_videos").update({ storage_path: null }).eq("id", video.id);
    if (error) throw error;
  }

  const clipsToNull = safeClips.filter((c) => c.storage_path && deletedClipPaths.has(c.storage_path));
  for (const clip of clipsToNull) {
    const { error } = await supabase.from("song_clips").update({ storage_path: null }).eq("id", clip.id);
    if (error) throw error;
  }

  console.log(`Deleted ${deletedRenderPaths.size} render file(s) and ${deletedClipPaths.size} song-clip file(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupPublishedStorage()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
