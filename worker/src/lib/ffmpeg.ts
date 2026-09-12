import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Cuts the tail off an already-rendered video down to maxSeconds — used
// to derive a YouTube Shorts-safe (<60s) copy from the longer
// TikTok-length master without a second render pipeline (see
// render-ranking-videos.ts). Re-encodes rather than stream-copies: a
// stream copy can only cut cleanly on a keyframe boundary, which could
// land noticeably short/long of maxSeconds depending on the source's
// keyframe interval — re-encoding a clip this short is cheap enough that
// landing exactly on maxSeconds isn't worth that imprecision.
export async function trimToMaxDuration(inputPath: string, outputPath: string, maxSeconds: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-t",
    String(maxSeconds),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    outputPath,
  ]);
}

export async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ]);
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch (err) {
    console.warn(`ffprobe failed for ${filePath}:`, err);
    return null;
  }
}
