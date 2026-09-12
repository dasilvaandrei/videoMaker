// One-off, run manually (not part of the daily cron): synthesizes a
// sponsor's spoken VO line and, once a real creative asset exists
// locally, uploads it to Storage. Mirrors resolve-bg-loops.ts's
// pattern — this doesn't write back into config/sponsors.ts itself;
// paste the printed paths/duration into that file's matching entry by
// hand afterward. See that file's header for why sponsors are a
// hand-edited config, not a DB table.
//
// Usage:
//   npm run resolve-sponsor-assets -- "SongBox"
//   npm run resolve-sponsor-assets -- "SongBox" --asset ~/Downloads/songbox-promo.mp4

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { SPONSORS } from "../config/sponsors.js";
import { synthesizeSpeech } from "../lib/elevenlabs.js";
import { probeDurationSeconds } from "../lib/ffmpeg.js";
import { supabase } from "../lib/supabase.js";

const MEDIA_BUCKET = "media";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) throw new Error('Usage: resolve-sponsor-assets.ts "<sponsor name>" [--asset <local file path>]');

  const sponsor = SPONSORS.find((s) => s.name === name);
  if (!sponsor) throw new Error(`No sponsor named ${JSON.stringify(name)} in config/sponsors.ts`);

  const assetFlagIndex = rest.indexOf("--asset");
  const localAssetPath = assetFlagIndex >= 0 ? rest[assetFlagIndex + 1] : undefined;

  const dir = await mkdtemp(join(tmpdir(), "sponsor-assets-"));
  try {
    console.log(`Synthesizing VO for ${sponsor.name}: ${JSON.stringify(sponsor.script)}`);
    const audioBuffer = await synthesizeSpeech(sponsor.script);
    const audioPath = join(dir, "vo.mp3");
    await writeFile(audioPath, audioBuffer);
    const durationSeconds = await probeDurationSeconds(audioPath);
    if (!durationSeconds) throw new Error("could not determine sponsor VO duration");

    const voObjectPath = `sponsor-vo/${slug(sponsor.name)}.mp3`;
    const { error: voUploadError } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(voObjectPath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
    if (voUploadError) throw voUploadError;

    console.log(`\nVO uploaded -> ${voObjectPath} (${durationSeconds.toFixed(2)}s)`);

    let assetObjectPath: string | null = null;
    let assetType: "video" | "image" | null = null;
    if (localAssetPath) {
      const ext = extname(localAssetPath).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) assetType = "video";
      else if (IMAGE_EXTENSIONS.has(ext)) assetType = "image";
      else throw new Error(`Unrecognized asset extension ${ext} — expected one of ${[...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].join(", ")}`);

      const assetBuffer = await readFile(localAssetPath);
      assetObjectPath = `sponsor-assets/${slug(sponsor.name)}${ext}`;
      const { error: assetUploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(assetObjectPath, assetBuffer, {
          contentType: assetType === "video" ? "video/mp4" : "image/jpeg",
          upsert: true,
        });
      if (assetUploadError) throw assetUploadError;
      console.log(`Asset uploaded -> ${assetObjectPath} (${assetType})`);
    } else {
      console.log("\nNo --asset provided — asset fields left as-is. Re-run with --asset <path> once a real creative exists.");
    }

    console.log(`\nUpdate config/sponsors.ts's "${sponsor.name}" entry with:`);
    console.log(`  voStoragePath: "${voObjectPath}",`);
    console.log(`  voDurationSeconds: ${durationSeconds.toFixed(2)},`);
    if (assetObjectPath) {
      console.log(`  assetStoragePath: "${assetObjectPath}",`);
      console.log(`  assetType: "${assetType}",`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
