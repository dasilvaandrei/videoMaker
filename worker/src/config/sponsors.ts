// Affiliate sponsor roster for the 2-5s split-screen ad segment (see
// remotion/RankingCountdown.tsx's SponsorSegment, inserted after song
// #4). Mirrors resolve-bg-loops.ts's pattern: a one-off job
// (resolve-sponsor-assets.ts) resolves assetStoragePaths/voStoragePath
// and this file gets manually updated with the result — not a live DB
// table, since sponsors change rarely and by hand (new affiliate
// program approvals), same reasoning as config/artists.json.
//
// A sponsor is only ever selected (see generate-ranking-render-metadata.ts)
// once it has at least one asset AND a VO — a sponsor with no real
// creative asset yet is inert, not rendered with a placeholder.
export interface Sponsor {
  name: string;
  affiliateUrl: string;
  // Spoken during the segment. Product claims here are confirmed
  // against songbox.com directly (fetched 2026-09-12), not guessed.
  script: string;
  // Multiple assets cycle during the segment (see SponsorSegment) rather
  // than holding on one static image the whole time — all must be the
  // same assetType (resolve-sponsor-assets.ts enforces this on upload).
  assetStoragePaths: string[];
  assetType: "video" | "image" | null;
  voStoragePath: string | null;
  voDurationSeconds: number | null;
}

export const SPONSORS: Sponsor[] = [
  {
    name: "SongBox",
    affiliateUrl: "https://songbox.com/?via=andrei",
    script: "SongBox — share unreleased music privately, or sell to fans and keep 100%. 7 day free trial, save up to $108 a year — link's in my bio.",
    assetStoragePaths: ["sponsor-assets/songbox-1.jpg", "sponsor-assets/songbox-2.png", "sponsor-assets/songbox-3.jpeg"],
    assetType: "image",
    voStoragePath: "sponsor-vo/songbox.mp3",
    voDurationSeconds: 11.33,
  },
];

export function activeSponsors(): Sponsor[] {
  return SPONSORS.filter((s) => s.assetStoragePaths.length > 0 && s.voStoragePath);
}
