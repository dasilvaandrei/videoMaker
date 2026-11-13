// GTA 5 gameplay shown on the bottom half of every ranking video, for the
// whole video. Shared by resolve-bg-loops.ts (which cuts and uploads
// these) and render-ranking-videos.ts (which picks one per video), so the
// two can't drift apart.
//
// Source: "GTA 5 Gameplay No Copyright 1 HOUR (Mega Ramp)" by OrbitalNCG —
// licensed Creative Commons on YouTube, and the channel labels it free to
// use. Real GTA 6 gameplay doesn't exist yet; Rockstar's trailers are
// copyrighted, so they aren't used here.
//
// Four windows from different points in the hour so consecutive videos
// don't show the same stretch of footage. Each is long enough to cover a
// whole ~60s video plus the intro without repeating; RankingCountdown
// still loops it if a video ever runs longer.

export const GAMEPLAY_SOURCE_VIDEO_ID = "74voi0vlxHE";
export const GAMEPLAY_LOOP_SECONDS = 75;

// The first path is the original 25s loop's filename, so it already exists
// in Storage before resolve-bg-loops.ts has been re-run to cut the new
// windows — render-ranking-videos.ts falls back to it if a newer one is
// missing.
export const GAMEPLAY_LOOPS: { path: string; startSeconds: number }[] = [
  { path: "bg-loops/gta5-megaramp.mp4", startSeconds: 360 },
  { path: "bg-loops/gta5-megaramp-2.mp4", startSeconds: 1200 },
  { path: "bg-loops/gta5-megaramp-3.mp4", startSeconds: 2100 },
  { path: "bg-loops/gta5-megaramp-4.mp4", startSeconds: 3000 },
];
