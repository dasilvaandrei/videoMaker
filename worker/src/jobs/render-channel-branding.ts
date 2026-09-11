// One-off (run by hand, not part of the daily pipeline): renders the
// channel icon and banner to local PNG files for manual upload in
// YouTube Studio (Settings -> Branding). Not automated via the Data API
// since channel branding updates need a broader OAuth scope than the
// upload-only one already set up for publishing.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function renderOne(compositionId: string, outputPath: string) {
  const serveUrl = await bundle({
    entryPoint: path.join(__dirname, "../remotion/index.ts"),
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: { ".js": [".js", ".ts", ".tsx"] },
      },
    }),
  });

  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps: {} });
  await renderStill({ composition, serveUrl, output: outputPath, inputProps: {} });
  console.log(`rendered ${compositionId} -> ${outputPath}`);
}

export async function renderChannelBranding() {
  await renderOne("ChannelIcon", path.join(process.cwd(), "channel-icon.png"));
  await renderOne("ChannelBanner", path.join(process.cwd(), "channel-banner.png"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  renderChannelBranding()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
