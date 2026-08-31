// Polls clip_renders for queued rows, resolves the source clip's
// storage_path (Drive reference or Supabase Storage — see lib/drive.ts)
// into a real fetchable URL, renders it through the HighlightClip
// composition, and uploads the result back to Supabase Storage. Rendered
// outputs are short vertical clips (tens of MB), comfortably under the
// project's per-file storage cap that ruled out storing full source
// footage there.
//
// No local download of the source clip happens here: Remotion's
// server-side video decoder only ever fetches over HTTP(S) — it can't
// read an arbitrary local file path (confirmed the hard way — neither a
// bare path nor a file:// URL works). So instead of downloading bytes
// ourselves, we just hand it a URL it can fetch directly: a short-lived
// Supabase signed URL for Storage-backed clips, or the Drive API's own
// media URL (already query-param-authenticated, no signing needed) for
// drive:-scheme ones.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveFileMediaUrl, parseDriveStoragePath } from "../lib/drive.js";
import { renderHighlightClip, type AspectRatio } from "../remotion/render.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";
const SIGNED_URL_TTL_SECONDS = 60 * 30;

async function resolveSourceVideoUrl(storagePath: string): Promise<string> {
  const driveFileId = parseDriveStoragePath(storagePath);
  if (driveFileId) {
    return driveFileMediaUrl(driveFileId);
  }

  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

interface QueuedRender {
  id: string;
  aspect_ratio: AspectRatio;
  hook_text: string | null;
  caption: string | null;
  hashtags: string[] | null;
  clips: {
    start_seconds: number;
    end_seconds: number;
    source_videos: { storage_path: string } | { storage_path: string }[] | null;
  } | null;
}

function sourceVideoOf(render: QueuedRender) {
  const clip = render.clips;
  if (!clip) return null;
  return Array.isArray(clip.source_videos) ? clip.source_videos[0] ?? null : clip.source_videos;
}

export async function renderQueuedClips() {
  const { data: renders, error } = await supabase
    .from("clip_renders")
    .select(
      "id, aspect_ratio, hook_text, caption, hashtags, clips(start_seconds, end_seconds, source_videos(storage_path))"
    )
    .eq("render_status", "queued")
    .returns<QueuedRender[]>();
  if (error) throw error;

  console.log(`${renders?.length ?? 0} clip_renders queued`);

  for (const render of renders ?? []) {
    const clip = render.clips;
    const sourceVideo = sourceVideoOf(render);
    if (!clip || !sourceVideo) {
      console.warn(`skip render ${render.id}: missing clip or source video`);
      continue;
    }

    // Optimistic lock: only proceed if still queued (guards against a
    // second concurrent worker process picking up the same row).
    await supabase
      .from("clip_renders")
      .update({ render_status: "rendering" })
      .eq("id", render.id)
      .eq("render_status", "queued");

    const dir = await mkdtemp(join(tmpdir(), "render-"));
    const outputPath = join(dir, "output.mp4");

    try {
      const videoSrc = await resolveSourceVideoUrl(sourceVideo.storage_path);

      const durationInSeconds = clip.end_seconds - clip.start_seconds;
      await renderHighlightClip(
        render.aspect_ratio,
        {
          videoSrc,
          hookText: render.hook_text ?? "",
          caption: render.caption ?? "",
          hashtags: render.hashtags ?? [],
          durationInSeconds,
        },
        outputPath
      );

      const objectPath = `renders/${render.id}.mp4`;
      const fileBuffer = await readFile(outputPath);
      const { error: uploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, fileBuffer, { contentType: "video/mp4", upsert: true });
      if (uploadError) throw uploadError;

      const { error: readyError } = await supabase
        .from("clip_renders")
        .update({ storage_path: objectPath, render_status: "ready" })
        .eq("id", render.id);
      if (readyError) throw readyError;

      console.log(`rendered ${render.id} -> ${objectPath}`);
    } catch (err) {
      // One bad render (bad source file, a transient Drive error) should
      // never take down the rest of the batch.
      console.error(`render ${render.id} failed:`, err instanceof Error ? err.message : err);
      await supabase.from("clip_renders").update({ render_status: "failed" }).eq("id", render.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderQueuedClips()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
