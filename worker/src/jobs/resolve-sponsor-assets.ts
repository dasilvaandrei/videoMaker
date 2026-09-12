// One-off, run manually (not part of the daily cron): synthesizes a
// sponsor's spoken VO line and uploads one or more real creative assets
// to Storage — multiple --asset flags upload a set that
// SponsorSegment cycles through during the segment (see
// RankingCountdown.tsx), rather than holding on one static image the
// whole time. Mirrors resolve-bg-loops.ts's pattern — this doesn't
// write back into config/sponsors.ts itself; paste the printed
// paths/duration into that file's matching entry by hand afterward.
//
// Usage:
//   npm run resolve-sponsor-assets -- "SongBox"
//   npm run resolve-sponsor-assets -- "SongBox" --asset ~/Downloads/a.png --asset ~/Downloads/b.jpeg
//   npm run resolve-sponsor-assets -- "SongBox" --asset ~/Downloads/a.png --skip-vo

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

function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) throw new Error('Usage: resolve-sponsor-assets.ts "<sponsor name>" [--asset <local file path>]...');

  const sponsor = SPONSORS.find((s) => s.name === name);
  if (!sponsor) throw new Error(`No sponsor named ${JSON.stringify(name)} in config/sponsors.ts`);

  const localAssetPaths = collectFlagValues(rest, "--asset");
  const skipVo = rest.includes("--skip-vo");

  const dir = await mkdtemp(join(tmpdir(), "sponsor-assets-"));
  try {
    let voObjectPath = sponsor.voStoragePath;
    let durationSeconds = sponsor.voDurationSeconds;
    if (!skipVo) {
      console.log(`Synthesizing VO for ${sponsor.name}: ${JSON.stringify(sponsor.script)}`);
      const audioBuffer = await synthesizeSpeech(sponsor.script);
      const audioPath = join(dir, "vo.mp3");
      await writeFile(audioPath, audioBuffer);
      durationSeconds = await probeDurationSeconds(audioPath);
      if (!durationSeconds) throw new Error("could not determine sponsor VO duration");

      voObjectPath = `sponsor-vo/${slug(sponsor.name)}.mp3`;
      const { error: voUploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(voObjectPath, audioBuffer, { contentType: "audio/mpeg", upsert: true });
      if (voUploadError) throw voUploadError;

      console.log(`\nVO uploaded -> ${voObjectPath} (${durationSeconds.toFixed(2)}s)`);
    } else {
      console.log("--skip-vo passed — keeping existing voStoragePath/voDurationSeconds as-is.");
    }

    const assetObjectPaths: string[] = [];
    let assetType: "video" | "image" | null = null;
    for (const [index, localAssetPath] of localAssetPaths.entries()) {
      const ext = extname(localAssetPath).toLowerCase();
      const thisType: "video" | "image" | null = VIDEO_EXTENSIONS.has(ext)
        ? "video"
        : IMAGE_EXTENSIONS.has(ext)
          ? "image"
          : null;
      if (!thisType) {
        throw new Error(`Unrecognized asset extension ${ext} — expected one of ${[...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS].join(", ")}`);
      }
      if (assetType && thisType !== assetType) {
        throw new Error(`Mixed asset types (${assetType} and ${thisType}) aren't supported — a sponsor's assets must all be the same type`);
      }
      assetType = thisType;

      const assetBuffer = await readFile(localAssetPath);
      const objectPath = `sponsor-assets/${slug(sponsor.name)}-${index + 1}${ext}`;
      const { error: assetUploadError } = await supabase.storage
        .from(MEDIA_BUCKET)
        .upload(objectPath, assetBuffer, {
          contentType: thisType === "video" ? "video/mp4" : "image/jpeg",
          upsert: true,
        });
      if (assetUploadError) throw assetUploadError;
      assetObjectPaths.push(objectPath);
      console.log(`Asset uploaded -> ${objectPath} (${thisType})`);
    }
    if (localAssetPaths.length === 0) {
      console.log("\nNo --asset provided — asset fields left as-is. Re-run with --asset <path> once real creatives exist.");
    }

    console.log(`\nUpdate config/sponsors.ts's "${sponsor.name}" entry with:`);
    console.log(`  voStoragePath: "${voObjectPath}",`);
    console.log(`  voDurationSeconds: ${durationSeconds?.toFixed(2)},`);
    if (assetObjectPaths.length > 0) {
      console.log(`  assetStoragePaths: [${assetObjectPaths.map((p) => `"${p}"`).join(", ")}],`);
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
