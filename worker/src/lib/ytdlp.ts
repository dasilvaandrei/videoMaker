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

  // Datacenter IPs (every GitHub Actions runner included) get much
  // heavier bot-detection scoring from YouTube than a home connection —
  // this is what actually broke the real Calvin Harris run (all 5 clips
  // failed with "Sign in to confirm you're not a bot"), not anything
  // specific to that artist. Cookies from a real logged-in browser
  // session substantially reduce (not eliminate) that flagging.
  // YOUTUBE_COOKIES_PATH is optional — omit it for local dev, where the
  // home IP mostly doesn't need this.
  const cookiesPath = process.env.YOUTUBE_COOKIES_PATH;

  await execFileAsync(
    "yt-dlp",
    [
      "--no-playlist",
      ...(cookiesPath ? ["--cookies", cookiesPath] : []),
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
