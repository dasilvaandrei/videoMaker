// Affiliate sponsor roster for the 2-5s split-screen ad segment (see
// remotion/RankingCountdown.tsx's SponsorSegment, inserted after song
// #4). Mirrors resolve-bg-loops.ts's pattern: a one-off job
// (resolve-sponsor-assets.ts) resolves assetStoragePath/voStoragePath
// and this file gets manually updated with the result — not a live DB
// table, since sponsors change rarely and by hand (new affiliate
// program approvals), same reasoning as config/artists.json.
//
// A sponsor is only ever selected (see generate-ranking-render-metadata.ts)
// once BOTH assetStoragePath and voStoragePath are set — a sponsor with
// no real creative asset yet is inert, not rendered with a placeholder.
export interface Sponsor {
  name: string;
  affiliateUrl: string;
  // Spoken during the segment. Product claims here are confirmed
  // against songbox.com directly (fetched 2026-09-12), not guessed.
  script: string;
  assetStoragePath: string | null;
  assetType: "video" | "image" | null;
  voStoragePath: string | null;
  voDurationSeconds: number | null;
}

export const SPONSORS: Sponsor[] = [
  {
    name: "SongBox",
    affiliateUrl: "https://songbox.com/?via=andrei",
    script: "SongBox lets you share unreleased music privately, or sell it straight to fans and keep 100% of the revenue — link's in my bio.",
    assetStoragePath: "sponsor-assets/songbox.jpg",
    assetType: "image",
    voStoragePath: "sponsor-vo/songbox.mp3",
    voDurationSeconds: 8.17,
  },
];

export function activeSponsors(): Sponsor[] {
  return SPONSORS.filter((s) => s.assetStoragePath && s.voStoragePath);
}
