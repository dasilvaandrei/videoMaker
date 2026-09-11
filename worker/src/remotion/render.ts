// Programmatic Remotion render, invoked by jobs/render-ranking-videos.ts.
//
// Self-hosted CLI/renderMedia render on our own VPS is the deliberate
// cheap default — no Lambda while volume is low. Remotion's license is
// free to self-host below its company-license revenue threshold; recheck
// LICENSE.md before scaling render volume once the channel is actually
// generating revenue.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { RankingCountdownProps } from "./RankingCountdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPOSITION_IDS = {
  "9:16": "RankingCountdown-9x16",
  "1:1": "RankingCountdown-1x1",
  "16:9": "RankingCountdown-16x9",
} as const;

export type AspectRatio = keyof typeof COMPOSITION_IDS;

export type RenderProps = RankingCountdownProps;

// Bundling (webpack) is the slow part (~seconds) — do it once per worker
// process and reuse across every render in a batch.
let bundleLocationPromise: Promise<string> | null = null;

function getBundleLocation(): Promise<string> {
  if (!bundleLocationPromise) {
    bundleLocationPromise = bundle({
      entryPoint: path.join(__dirname, "index.ts"),
      // The rest of the worker uses TS NodeNext's "import './x.js' resolves
      // to x.tsx" convention (required for tsc/tsx, not understood by
      // Remotion's own webpack build) — teach webpack the same mapping
      // instead of special-casing import style inside src/remotion.
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          extensionAlias: {
            ".js": [".js", ".ts", ".tsx"],
          },
        },
      }),
    });
  }
  return bundleLocationPromise;
}

export async function renderRankingCountdown(
  aspectRatio: AspectRatio,
  props: RenderProps,
  outputPath: string
): Promise<void> {
  const serveUrl = await getBundleLocation();
  const compositionId = COMPOSITION_IDS[aspectRatio];

  // Every segment's videoSrc must be a real http(s) URL — Remotion's
  // server-side video decoder (the "compositor") only downloads over
  // HTTP(S), even for what looks like a local file (confirmed: neither a
  // bare absolute path nor a file:// URL works — "Can only download URLs
  // starting with http:// or https://"). jobs/render-ranking-videos.ts is
  // responsible for resolving each song_clip's storage_path into a
  // fetchable Supabase signed URL before calling this.
  const inputProps: Record<string, unknown> = { ...props };

  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    // Default h264 encode came in around 5.3 Mbps in testing — capping
    // bitrate keeps output size ~proportional to duration so a ~35s
    // 5-clip countdown stays comfortably under Supabase Storage's
    // per-file cap.
    videoBitrate: "4M",
    // Default (30s) isn't always enough headroom for the compositor to
    // fetch every segment's signed Supabase Storage URL through its
    // local proxy — hit this for real on a slower/first-touch render.
    // render-ranking-videos.ts retries on top of this, but a more
    // generous timeout means most transient slowness never needs a retry.
    timeoutInMilliseconds: 120_000,
  });
}
