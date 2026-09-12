// Entry point for the 6am Instagram-only scheduled workflow (see
// .github/workflows/instagram-publish.yml) — deliberately separate from
// run-daily-pipeline.ts's 3pm fetch/render/YouTube/TikTok run rather
// than a fourth platform bolted onto it, since Instagram publishes on
// its own schedule, not tied to when today's video gets rendered. Draws
// from whatever's already backlogged in ranking_videos (oldest
// approved+ready video not yet posted to Instagram) — same as every
// other publish job, no fetch/render step needed here.
//
// Same "fail loudly on zero" reasoning as run-daily-pipeline.ts's
// YouTube/TikTok checks — a day with nothing published on this platform
// should fail the GitHub Actions run, not silently succeed.

import { publishToInstagram } from "./publish-instagram.js";

async function main() {
  const publishedCount = await publishToInstagram({ limit: 1 });
  if (publishedCount === 0) {
    throw new Error("Instagram publish produced zero published videos — see logs above for why.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
