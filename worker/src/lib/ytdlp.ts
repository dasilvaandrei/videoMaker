// Wraps the yt-dlp binary (must be installed separately — see README) to
// pull only the seconds we need out of an official YouTube video, via
// --download-sections, instead of downloading the full multi-minute
// video just to trim it locally afterward.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function downloadYoutubeSection(
  youtubeVideoId: string,
  startSeconds: number,
  endSeconds: number,
  outputPath: string
): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${youtubeVideoId}`;

  await execFileAsync(
    "yt-dlp",
    [
      "--no-playlist",
      "--download-sections",
      `*${startSeconds}-${endSeconds}`,
      // Without this, the cut can only land on a keyframe boundary
      // (imprecise, and can spill a second or two either side) — this
      // re-encodes just the cut point so start/end land exactly where
      // requested.
      "--force-keyframes-at-cuts",
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]",
      "--merge-output-format",
      "mp4",
      "-o",
      outputPath,
      url,
    ],
    { maxBuffer: 1024 * 1024 * 64 }
  );
}
