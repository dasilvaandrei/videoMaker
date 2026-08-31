// Programmatic Remotion render, invoked by jobs/render-clips.ts.
//
// Self-hosted CLI/renderMedia render on our own VPS is the deliberate
// cheap default (plan §5) — no Lambda while volume is low. Remotion's
// license is free to self-host below its company-license revenue
// threshold; recheck LICENSE.md before scaling render volume once the
// campaign is actually generating revenue (plan §5 flags this
// explicitly, not something to assume stays true forever).

import { fileURLToPath } from "node:url";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { HighlightClipProps } from "./HighlightClip.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPOSITION_IDS = {
  "9:16": "HighlightClip-9x16",
  "1:1": "HighlightClip-1x1",
  "16:9": "HighlightClip-16x9",
} as const;

export type AspectRatio = keyof typeof COMPOSITION_IDS;

export type RenderProps = HighlightClipProps;

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

export async function renderHighlightClip(
  aspectRatio: AspectRatio,
  props: RenderProps,
  outputPath: string
): Promise<void> {
  const serveUrl = await getBundleLocation();
  const compositionId = COMPOSITION_IDS[aspectRatio];

  // props.videoSrc must be a real http(s) URL — Remotion's server-side
  // video decoder (the "compositor") only downloads over HTTP(S), even
  // for what looks like a local file (confirmed: neither a bare absolute
  // path nor a file:// URL works — "Can only download URLs starting with
  // http:// or https://"). jobs/render-clips.ts is responsible for
  // resolving storage_path into a fetchable URL (a Supabase signed URL,
  // or the Drive API's own media URL) before calling this.
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
    // Default h264 encode came in around 5.3 Mbps in testing — the
    // longest ingested clips (~69s) would blow past Supabase Storage's
    // per-file cap that already forced the drive: source-reference
    // scheme (see lib/drive.ts). Capping bitrate keeps output size
    // ~proportional to duration: 4 Mbps × 69s ≈ 34MB, safely under the
    // ~50MB ceiling even for the longest clip in hand.
    videoBitrate: "4M",
  });
}
