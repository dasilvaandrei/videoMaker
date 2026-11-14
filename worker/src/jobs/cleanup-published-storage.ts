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
import { GAMEPLAY_LOOPS } from "../config/gameplayLoops.js";
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
const STORAGE_ALERT_MB = 800;

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

interface StoredFile {
  path: string;
  createdAt: string | null;
  bytes: number;
}

// Lists one level: files directly under `folder`, plus subfolder names
// (Storage returns those with a null id). "" lists the bucket root.
async function listLevel(folder: string): Promise<{ files: StoredFile[]; subfolders: string[] }> {
  const files: StoredFile[] = [];
  const subfolders: string[] = [];
  const prefix = folder ? `${folder}/` : "";
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .list(folder, { limit: LIST_PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`storage list failed for ${prefix || "bucket root"}: ${error.message}`);
    for (const item of data ?? []) {
      if (item.id) {
        files.push({
          path: `${prefix}${item.name}`,
          createdAt: item.created_at ?? null,
          bytes: Number((item.metadata as { size?: number } | null)?.size ?? 0),
        });
      } else {
        subfolders.push(`${prefix}${item.name}`);
      }
    }
    if (!data || data.length < LIST_PAGE_SIZE) return { files, subfolders };
  }
}

async function listFolder(folder: string): Promise<StoredFile[]> {
  return (await listLevel(folder)).files;
}

async function totalStorageBytes(folder = ""): Promise<number> {
  const { files, subfolders } = await listLevel(folder);
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  for (const sub of subfolders) total += await totalStorageBytes(sub);
  return total;
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

  // Pass 4: gameplay loops no longer in config/gameplayLoops.ts (retired or
  // replaced styles). Nothing else reads bg-loops/.
  const currentLoops = new Set(GAMEPLAY_LOOPS.map((l) => l.path));
  const retiredLoops = (await listFolder("bg-loops")).map((f) => f.path).filter((p) => !currentLoops.has(p));
  const deletedLoops = await deleteStoragePaths(retiredLoops);

  console.log(
    `Storage cleanup: deleted ${deletedRenders.size} render file(s) from ${postedVideos.length} posted video(s), ` +
      `${deletedClips.size} song clip(s), ${deletedOrphans.size} orphaned file(s), ${deletedLoops.size} retired gameplay loop(s).`
  );

  // Fail loudly (GitHub emails on a failed run) well before the free plan's
  // 1 GB storage limit — going over it is what locked the project in
  // Sept-Nov 2026. Everything above should keep this near ~200 MB.
  const totalMb = (await totalStorageBytes()) / 1048576;
  console.log(`Storage in use: ${totalMb.toFixed(1)} MB (alert at ${STORAGE_ALERT_MB} MB, free plan limit 1024 MB)`);
  if (totalMb > STORAGE_ALERT_MB) {
    throw new Error(
      `Storage is at ${totalMb.toFixed(0)} MB, past the ${STORAGE_ALERT_MB} MB alert line — close to the free plan's 1 GB limit. Check what's accumulating.`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupPublishedStorage()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
