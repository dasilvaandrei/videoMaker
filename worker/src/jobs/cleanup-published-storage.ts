// Deletes rendered videos and song clips from Storage once they've done
// their job, so the Supabase project never fills up again. Storage quota
// overruns restricted (2026-09-30, 2026-10-03) and then took down
// (2026-10-13) the whole project, which stopped every publish job.
//
// Runs at the end of every daily-pipeline run (right after that run's
// YouTube + TikTok uploads, so a video is deleted as soon as it's posted)
// and once a day on its own as a backstop (cleanup-storage.yml).
//
// Three passes:
//   1. Renders: once a video is published to YouTube, delete both of its
//      files — the master (storage_path) and the trimmed YouTube copy
//      (youtube_storage_path). An earlier version only deleted the master,
//      leaving roughly half of render storage behind.
//   2. Song clips: delete once no in-flight ranking needs the song (see
//      lib/rankingActivity.ts). The row stays status='downloaded' with
//      storage_path=null, and resolve-song-clips.ts re-queues it if a later
//      ranking reuses the song.
//   3. Orphans: anything under renders/ or song-clips/ that no DB row
//      points at (left behind by failed or interrupted renders). Skips
//      files newer than ORPHAN_MIN_AGE_HOURS, since a render that's
//      uploading right now hasn't written its path to the DB yet.

import { supabase } from "../lib/supabase.js";
import {
  fetchAllRows,
  findActiveRankingIds,
  getSongIdsForRankings,
  getYoutubePublishedVideoIds,
} from "../lib/rankingActivity.js";

const MEDIA_BUCKET = "media";
const DELETE_BATCH_SIZE = 100;
const LIST_PAGE_SIZE = 1000;
const ORPHAN_MIN_AGE_HOURS = 6;
const SWEPT_FOLDERS = ["renders", "song-clips"];

interface VideoRow {
  id: string;
  render_status: string;
  storage_path: string | null;
  youtube_storage_path: string | null;
}

interface ClipRow {
  id: string;
  song_id: string;
  storage_path: string | null;
}

async function deleteStoragePaths(paths: string[]): Promise<Set<string>> {
  const deleted = new Set<string>();
  for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
    const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).remove(batch);
    if (error) throw new Error(`storage delete failed: ${error.message}`);
    for (const item of data ?? []) deleted.add(item.name);
  }
  return deleted;
}

async function listFolder(folder: string): Promise<{ path: string; createdAt: string | null }[]> {
  const files: { path: string; createdAt: string | null }[] = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .list(folder, { limit: LIST_PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`storage list failed for ${folder}/: ${error.message}`);
    for (const item of data ?? []) {
      // Folders come back with a null id; only files have one.
      if (item.id) files.push({ path: `${folder}/${item.name}`, createdAt: item.created_at ?? null });
    }
    if (!data || data.length < LIST_PAGE_SIZE) return files;
  }
}

async function fetchVideos(): Promise<VideoRow[]> {
  return fetchAllRows<VideoRow>((from, to) =>
    supabase
      .from("ranking_videos")
      .select("id, render_status, storage_path, youtube_storage_path")
      .order("id")
      .range(from, to)
  );
}

async function fetchClipsWithFiles(): Promise<ClipRow[]> {
  return fetchAllRows<ClipRow>((from, to) =>
    supabase
      .from("song_clips")
      .select("id, song_id, storage_path")
      .not("storage_path", "is", null)
      .order("id")
      .range(from, to)
  );
}

export async function cleanupPublishedStorage() {
  const youtubePublished = await getYoutubePublishedVideoIds();

  // Pass 1: renders of videos that are already on YouTube.
  const videos = await fetchVideos();
  const postedVideos = videos.filter(
    (v) => youtubePublished.has(v.id) && (v.storage_path || v.youtube_storage_path)
  );
  const renderPaths = postedVideos.flatMap((v) => [v.storage_path, v.youtube_storage_path].filter((p): p is string => !!p));
  const deletedRenders = await deleteStoragePaths(renderPaths);
  for (const video of postedVideos) {
    const { error } = await supabase
      .from("ranking_videos")
      .update({ storage_path: null, youtube_storage_path: null })
      .eq("id", video.id);
    if (error) throw error;
  }

  // Pass 2: song clips no in-flight ranking needs.
  const activeRankingIds = await findActiveRankingIds(youtubePublished);
  const neededSongIds = await getSongIdsForRankings(activeRankingIds);
  const clips = await fetchClipsWithFiles();
  const unneededClips = clips.filter((c) => !neededSongIds.has(c.song_id));
  const deletedClips = await deleteStoragePaths(unneededClips.map((c) => c.storage_path as string));
  for (const clip of unneededClips) {
    const { error } = await supabase.from("song_clips").update({ storage_path: null }).eq("id", clip.id);
    if (error) throw error;
  }

  // Pass 3: files nothing points at anymore.
  const referenced = new Set<string>();
  for (const v of await fetchVideos()) {
    if (v.storage_path) referenced.add(v.storage_path);
    if (v.youtube_storage_path) referenced.add(v.youtube_storage_path);
  }
  for (const c of await fetchClipsWithFiles()) referenced.add(c.storage_path as string);

  const cutoff = Date.now() - ORPHAN_MIN_AGE_HOURS * 60 * 60 * 1000;
  const orphanPaths: string[] = [];
  for (const folder of SWEPT_FOLDERS) {
    for (const file of await listFolder(folder)) {
      if (referenced.has(file.path)) continue;
      if (!file.createdAt || new Date(file.createdAt).getTime() > cutoff) continue;
      orphanPaths.push(file.path);
    }
  }
  const deletedOrphans = await deleteStoragePaths(orphanPaths);

  console.log(
    `Storage cleanup: deleted ${deletedRenders.size} render file(s) from ${postedVideos.length} posted video(s), ` +
      `${deletedClips.size} song clip(s), ${deletedOrphans.size} orphaned file(s).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupPublishedStorage()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
